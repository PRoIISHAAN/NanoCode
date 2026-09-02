// M3: the host_request handlers for `task_state.set` / `recall.search` / `recall.get`
// (packages/agent/src/session/task-state.ts, recall.ts). Tested directly against their
// `(data: Record<string, unknown>) => Promise<unknown>` shape -- the same shape
// `ReplKernelManager` calls them with -- rather than through a real kernel, since the actual
// Python<->host wire crossing is covered separately by session-memory.test.ts's live-kernel test.
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SessionLog } from "../src/session/log.ts";
import { createRecallGetHandler, createRecallSearchHandler } from "../src/session/recall.ts";
import { createTaskStateHandler, TaskStateStore } from "../src/session/task-state.ts";

let dir: string;
let sessionLog: SessionLog;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "nanocode-task-state-recall-"));
  sessionLog = await SessionLog.open(join(dir, "s.jsonl"), "session-1");
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("task_state.set handler", () => {
  it("sets fields on first call and persists a task-state entry", async () => {
    const store = new TaskStateStore();
    const handler = createTaskStateHandler(store, sessionLog);

    await handler({ goal: "ship M3", focus: "compaction" });

    expect(store.get()).toEqual({ goal: "ship M3", focus: "compaction", decisions: [] });
    const entries = sessionLog.all.filter((e) => e.kind === "task-state");
    expect(entries).toHaveLength(1);
  });

  it("leaves omitted fields unchanged and appends (not replaces) decisions", async () => {
    const store = new TaskStateStore();
    const handler = createTaskStateHandler(store, sessionLog);

    await handler({ goal: "ship M3", decision: "use JSONL" });
    await handler({ focus: "task state", decision: "keep task state model-driven" });

    expect(store.get()).toEqual({
      goal: "ship M3",
      focus: "task state",
      decisions: ["use JSONL", "keep task state model-driven"],
    });
  });
});

describe("recall.search / recall.get handlers", () => {
  it("finds archived tool output by keyword and fetches it in full by id", async () => {
    await sessionLog.append({
      id: "arc-1",
      timestamp: 1,
      kind: "archived-tool-output",
      toolCallId: "call-1",
      toolName: "ipython",
      content: "full traceback: ZeroDivisionError",
      searchText: "full traceback: ZeroDivisionError",
    });

    const searchHandler = createRecallSearchHandler(sessionLog);
    const results = (await searchHandler({ query: "zerodivision" })) as Array<{ id: string }>;
    expect(results).toHaveLength(1);
    expect(results[0].id).toBe("arc-1");

    const getHandler = createRecallGetHandler(sessionLog);
    const fetched = (await getHandler({ id: "arc-1" })) as { content: string };
    expect(fetched.content).toBe("full traceback: ZeroDivisionError");
  });

  it("recall.get rejects an unknown id rather than returning empty content", async () => {
    const getHandler = createRecallGetHandler(sessionLog);
    await expect(getHandler({ id: "does-not-exist" })).rejects.toThrow(/no archived tool output/);
  });

  it("recall.search rejects a missing query", async () => {
    const searchHandler = createRecallSearchHandler(sessionLog);
    await expect(searchHandler({})).rejects.toThrow(/non-empty string query/);
  });
});
