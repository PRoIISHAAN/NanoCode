// M3: proves the Python-side builtins (packages/kernel/python/nanocode_kernel/task_state.py,
// recall.py) actually cross the real host_request wire into the TS handlers in
// packages/agent/src/session/{task-state,recall}.ts -- a real kernel subprocess, not a fake, since
// the interesting bugs here are in the wire crossing itself (kwarg marshalling, envelope
// unwrapping), the same reasoning packages/kernel/test/repl-kernel-manager.test.ts documents.
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ReplKernelManager } from "@nanocode/kernel";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SessionLog } from "../src/session/log.ts";
import { createRecallGetHandler, createRecallSearchHandler } from "../src/session/recall.ts";
import { createTaskStateHandler, TaskStateStore } from "../src/session/task-state.ts";

let dir: string;
let sessionLog: SessionLog;
let kernel: ReplKernelManager | undefined;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "nanocode-session-memory-"));
  sessionLog = await SessionLog.open(join(dir, "s.jsonl"), "session-1");
});

afterEach(async () => {
  await kernel?.shutdown();
  kernel = undefined;
  await rm(dir, { recursive: true, force: true });
});

describe("tiered-memory kernel builtins (M3, real kernel)", () => {
  it("await task_state.set(...) from Python reaches the host handler and updates the store", async () => {
    const store = new TaskStateStore();
    kernel = new ReplKernelManager({
      hostHandlers: { "task_state.set": createTaskStateHandler(store, sessionLog) },
    });

    const result = await kernel.execute(
      "await task_state.set(goal='ship M3', focus='memory', decision='use JSONL', next_action='write tests')",
    );
    expect(result.status).toBe("ok");
    expect(store.get()).toEqual({
      goal: "ship M3",
      focus: "memory",
      decisions: ["use JSONL"],
      nextAction: "write tests",
    });
  });

  it("await recall_search(...) / await recall(id) round-trip through a real kernel", async () => {
    await sessionLog.append({
      id: "arc-1",
      timestamp: 1,
      kind: "archived-tool-output",
      toolCallId: "call-1",
      toolName: "ipython",
      content: "the full archived output, line one\nline two",
      searchText: "the full archived output, line one\nline two",
    });

    kernel = new ReplKernelManager({
      hostHandlers: {
        "recall.search": createRecallSearchHandler(sessionLog),
        "recall.get": createRecallGetHandler(sessionLog),
      },
    });

    const searchResult = await kernel.execute("await recall_search('archived output')");
    expect(searchResult.status).toBe("ok");
    expect(searchResult.result).toContain("arc-1");

    const fetchResult = await kernel.execute("await recall('arc-1')");
    expect(fetchResult.status).toBe("ok");
    expect(fetchResult.result).toContain("line one");
  });

  it("recall(id) raises a Python RuntimeError for an unknown id, not a silent empty result", async () => {
    kernel = new ReplKernelManager({
      hostHandlers: { "recall.get": createRecallGetHandler(sessionLog) },
    });
    const result = await kernel.execute("await recall('missing-id')");
    expect(result.status).toBe("error");
    expect(result.error?.ename).toBe("RuntimeError");
  });
});
