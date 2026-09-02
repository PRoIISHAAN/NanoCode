// M3: proves `Session`'s own wiring of `SessionMemoryOptions` (agent.ts) -- not just the pieces
// in isolation. The L4 review of M3 found zero tests constructed a `Session` with `memory` at all,
// meaning `composeTransformContext`, the `CompactionEngine` built in the constructor, and the
// message-persistence line in `reduceEvent` had no coverage of the actual seam connecting them to
// the rest of the loop. This file closes that gap with a fake provider (deterministic, no
// network) and a fake tool (no real kernel needed -- the real Python<->host wiring is already
// covered by session-memory.test.ts).
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  Api,
  AssistantMessage,
  AssistantMessageEvent,
  AssistantMessageEventStream,
  Context,
  Model,
  MutableModels,
} from "@nanocode/ai";
import { EventStream } from "@nanocode/ai";
import { Type } from "typebox";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Session } from "../src/agent.ts";
import { SessionLog } from "../src/session/log.ts";
import type { AgentTool, StreamFn } from "../src/types.ts";

const FAKE_MODEL: Model<Api> = {
  id: "fake-model",
  name: "Fake Model",
  api: "anthropic-messages",
  provider: "fake-provider",
  baseUrl: "",
  reasoning: false,
  input: ["text"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 200_000,
  maxTokens: 8_000,
};

const EMPTY_USAGE: AssistantMessage["usage"] = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 0,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

function assistantMessage(overrides: Partial<AssistantMessage>): AssistantMessage {
  return {
    role: "assistant",
    content: [],
    api: FAKE_MODEL.api,
    provider: FAKE_MODEL.provider,
    model: FAKE_MODEL.id,
    usage: EMPTY_USAGE,
    stopReason: "stop",
    timestamp: Date.now(),
    ...overrides,
  };
}

function extractFinalMessage(event: AssistantMessageEvent): AssistantMessage {
  if (event.type === "done") return event.message;
  if (event.type === "error") return event.error;
  throw new Error("Unexpected event type for final result");
}

function fakeStream(): AssistantMessageEventStream {
  return new EventStream<AssistantMessageEvent, AssistantMessage>(
    (event) => event.type === "done" || event.type === "error",
    extractFinalMessage,
  );
}

function pushFinal(stream: AssistantMessageEventStream, message: AssistantMessage): void {
  stream.push({ type: "start", partial: { ...message, content: [] } });
  stream.push({
    type: "done",
    reason: message.stopReason as Extract<AssistantMessage["stopReason"], "stop" | "toolUse">,
    message,
  });
}

const bigTool: AgentTool = {
  name: "big",
  label: "big",
  description: "returns a large text result",
  parameters: Type.Object({}),
  execute: async () => ({
    content: [{ type: "text", text: "z".repeat(3000) }],
    details: undefined,
  }),
};

const smallTool: AgentTool = {
  name: "small",
  label: "small",
  description: "returns a small text result",
  parameters: Type.Object({}),
  execute: async () => ({
    content: [{ type: "text", text: "ok" }],
    details: undefined,
  }),
};

let dir: string;
let sessionLog: SessionLog;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "nanocode-session-integration-"));
  sessionLog = await SessionLog.open(join(dir, "s.jsonl"), "session-1");
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("Session with SessionMemoryOptions (M3 wiring)", () => {
  it("persists every completed message to the session log as it happens", async () => {
    const streamFn: StreamFn = () => {
      const stream = fakeStream();
      pushFinal(
        stream,
        assistantMessage({ content: [{ type: "text", text: "hello" }], stopReason: "stop" }),
      );
      return stream;
    };
    const models = { completeSimple: async () => assistantMessage({}) } as unknown as MutableModels;

    const session = new Session({
      streamFn,
      initialState: { model: FAKE_MODEL, systemPrompt: "test" },
      memory: { sessionLog, models, getTaskState: () => undefined },
    });

    await session.prompt("hi");

    const persistedMessages = sessionLog.all.filter((e) => e.kind === "message");
    expect(persistedMessages).toHaveLength(session.state.messages.length);
    expect(persistedMessages.map((e) => (e.kind === "message" ? e.message : undefined))).toEqual(
      session.state.messages,
    );
  });

  it("routes context through the compaction engine before it reaches the provider, without touching the durable in-memory history", async () => {
    // Three turns: the big tool result is only compactable once it's no longer the *freshest*
    // turn -- the recent-tail selection always keeps the most recent complete turn verbatim (the
    // model needs to see what it just did), so a second, smaller turn has to happen first to push
    // the big one out of the "recent" window before compaction can touch it.
    let call = 0;
    let capturedThirdTurnContext: Context | undefined;
    const streamFn: StreamFn = (_model, context) => {
      call += 1;
      const stream = fakeStream();
      if (call === 1) {
        pushFinal(
          stream,
          assistantMessage({
            content: [{ type: "toolCall", id: "call-1", name: "big", arguments: {} }],
            stopReason: "toolUse",
          }),
        );
      } else if (call === 2) {
        pushFinal(
          stream,
          assistantMessage({
            content: [{ type: "toolCall", id: "call-2", name: "small", arguments: {} }],
            stopReason: "toolUse",
          }),
        );
      } else {
        capturedThirdTurnContext = context;
        pushFinal(
          stream,
          assistantMessage({ content: [{ type: "text", text: "done" }], stopReason: "stop" }),
        );
      }
      return stream;
    };
    const models = {
      completeSimple: async () =>
        assistantMessage({ content: [{ type: "text", text: "SUMMARY" }] }),
    } as unknown as MutableModels;

    const session = new Session({
      streamFn,
      initialState: { model: FAKE_MODEL, systemPrompt: "test", tools: [bigTool, smallTool] },
      memory: {
        sessionLog,
        models,
        getTaskState: () => undefined,
        compaction: { triggerFraction: 0.0001, keepRecentTokens: 1, archiveMinChars: 100 },
      },
    });

    await session.prompt("run the big tool, then the small one");

    expect(capturedThirdTurnContext).toBeDefined();
    const sentTexts = (capturedThirdTurnContext?.messages ?? [])
      .map((m) =>
        typeof m.content === "string"
          ? m.content
          : m.content.map((c) => ("text" in c ? c.text : "")).join(""),
      )
      .join("\n");
    expect(sentTexts).toContain("<compaction-summary>");
    expect(sentTexts).toContain("SUMMARY");
    expect(sentTexts).not.toContain("z".repeat(3000)); // the raw tool output was compacted away

    // But the durable, full-fidelity history Session keeps (and already persisted to the log)
    // still has the original, uncompacted tool result -- compaction only shapes what's SENT.
    const toolResult = session.state.messages.find((m) => m.role === "toolResult");
    expect(toolResult && toolResult.role === "toolResult" ? toolResult.content : undefined).toEqual(
      [{ type: "text", text: "z".repeat(3000) }],
    );

    // Exact compaction-pass counting is compaction.test.ts's job; this test only needs to prove
    // the wiring fired at all. With this deliberately tiny trigger threshold, compaction can (and
    // here does) also fire once harmlessly on turn 2 before the big output is old enough to
    // archive -- that's expected, not a bug in the wiring being tested here.
    expect(sessionLog.all.filter((e) => e.kind === "archived-tool-output")).toHaveLength(1);
    expect(sessionLog.all.filter((e) => e.kind === "compaction").length).toBeGreaterThanOrEqual(1);
  });
});
