// M3: unit tests for the compaction engine (packages/agent/src/session/compaction.ts) in
// isolation from the full agent loop -- a fake `completeSimple` and a real (tmp-file) SessionLog
// are enough to exercise the trigger, the turn-safe cut point, tool-output archiving, and the
// always-on task-state banner deterministically, without needing a real provider or kernel.
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  Api,
  AssistantMessage,
  Context,
  Model,
  MutableModels,
  SimpleStreamOptions,
} from "@nanocode/ai";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CompactionEngine } from "../src/session/compaction.ts";
import { SessionLog } from "../src/session/log.ts";
import type { AgentMessage } from "../src/types.ts";

const FAKE_MODEL: Model<Api> = {
  id: "fake-model",
  name: "Fake Model",
  api: "anthropic-messages",
  provider: "fake-provider",
  baseUrl: "",
  reasoning: false,
  input: ["text"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 1000,
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

function assistantText(text: string): AgentMessage {
  return {
    role: "assistant",
    content: [{ type: "text", text }],
    api: FAKE_MODEL.api,
    provider: FAKE_MODEL.provider,
    model: FAKE_MODEL.id,
    usage: EMPTY_USAGE,
    stopReason: "stop",
    timestamp: Date.now(),
  } as AgentMessage;
}

function userText(text: string, timestamp = Date.now()): AgentMessage {
  return { role: "user", content: text, timestamp } as AgentMessage;
}

function toolResult(content: string, toolCallId = "call-1", toolName = "ipython"): AgentMessage {
  return {
    role: "toolResult",
    toolCallId,
    toolName,
    content: [{ type: "text", text: content }],
    isError: false,
    timestamp: Date.now(),
  } as AgentMessage;
}

/** A `completeSimple` stand-in that records the transcript it was asked to summarize and always
 * returns a canned summary -- enough for `MutableModels` since compaction only ever calls this
 * one method on it. */
function fakeModelsWithCanned(summary: string): {
  models: MutableModels;
  lastRequest: () => Context | undefined;
} {
  let lastRequest: Context | undefined;
  const models = {
    completeSimple: async (
      _model: Model<Api>,
      context: Context,
      _options?: SimpleStreamOptions,
    ) => {
      lastRequest = context;
      return assistantText(summary) as unknown as AssistantMessage;
    },
  } as unknown as MutableModels;
  return { models, lastRequest: () => lastRequest };
}

/** Like `fakeModelsWithCanned`, but returns one summary per call (in order) and records every
 * request's transcript, not just the last -- for tests that need to inspect what a *second*
 * compaction pass was actually asked to summarize. */
function fakeModelsWithQueue(summaries: string[]): {
  models: MutableModels;
  callCount: () => number;
  requestAt: (i: number) => Context;
} {
  const requests: Context[] = [];
  const models = {
    completeSimple: async (
      _model: Model<Api>,
      context: Context,
      _options?: SimpleStreamOptions,
    ) => {
      requests.push(context);
      const summary = summaries[requests.length - 1] ?? summaries.at(-1) ?? "";
      return assistantText(summary) as unknown as AssistantMessage;
    },
  } as unknown as MutableModels;
  return { models, callCount: () => requests.length, requestAt: (i) => requests[i] };
}

let dir: string;
let sessionLog: SessionLog;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "nanocode-compaction-"));
  sessionLog = await SessionLog.open(join(dir, "s.jsonl"), "session-1");
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("CompactionEngine", () => {
  it("passes messages through unchanged when under the trigger threshold", async () => {
    const { models } = fakeModelsWithCanned("unused");
    const engine = new CompactionEngine({
      models,
      getModel: () => FAKE_MODEL,
      sessionLog,
      getTaskState: () => undefined,
    });
    const messages = [userText("hi"), assistantText("hello")];
    const result = await engine.transform(messages);
    expect(result).toEqual(messages);
    expect(sessionLog.all).toHaveLength(0);
  });

  it("compacts over threshold: archives large tool output and keeps the recent turn verbatim", async () => {
    const { models, lastRequest } = fakeModelsWithCanned("The user is debugging a ValueError.");
    const engine = new CompactionEngine({
      models,
      getModel: () => FAKE_MODEL, // contextWindow 1000
      sessionLog,
      triggerFraction: 0.5, // trigger at ~500 estimated tokens
      keepRecentTokens: 6, // just over the last exchange's own token count, so both its messages are kept
      archiveMinChars: 1000,
      getTaskState: () => undefined,
    });

    const bigOutput = "x".repeat(3000); // ~750 estimated tokens on its own -- over threshold
    const messages: AgentMessage[] = [
      userText("please debug this", 1),
      assistantText("ok, running code"),
      toolResult(bigOutput),
      userText("thanks, what's next?", 4),
      assistantText("here is the plan"),
    ];

    const result = await engine.transform(messages);

    // Kept verbatim: the last user/assistant exchange, after the turn-safe cut landed right before
    // it -- plus one synthetic summary message in front.
    expect(result).toHaveLength(3);
    expect(result[1]).toEqual(messages[3]);
    expect(result[2]).toEqual(messages[4]);
    const summaryText = (result[0] as { content: { text: string }[] }).content[0].text;
    expect(summaryText).toContain("<compaction-summary>");
    expect(summaryText).toContain("The user is debugging a ValueError.");

    // The oversized tool output was archived, not fed raw into the summarization call.
    const archived = sessionLog.all.filter((e) => e.kind === "archived-tool-output");
    expect(archived).toHaveLength(1);
    if (archived[0].kind === "archived-tool-output") {
      expect(archived[0].content).toBe(bigOutput);
    }
    const sentMessages = lastRequest()?.messages ?? [];
    const transcriptSent = String((sentMessages[0] as { content: string }).content);
    expect(transcriptSent).not.toContain(bigOutput);
    expect(transcriptSent).toMatch(/archived tool output id=/);

    // And the compaction itself was recorded.
    const compactionEntries = sessionLog.all.filter((e) => e.kind === "compaction");
    expect(compactionEntries).toHaveLength(1);
  });

  it("finds a safe cut point even with only one user message and many assistant/tool-result turns", async () => {
    // A live demo exposed this: a single session.prompt() run can hold many internal
    // assistant/tool-result turns (the model keeps calling tools without anything re-prompting
    // it) with only one "user" message at the very start. Requiring a "user" message as the
    // boundary meant the walk-back always landed at index 0 and compaction silently never fired
    // in exactly this (very common) shape. A safe boundary must be any non-toolResult message.
    const { models } = fakeModelsWithCanned("summary");
    const engine = new CompactionEngine({
      models,
      getModel: () => FAKE_MODEL,
      sessionLog,
      triggerFraction: 0.5,
      keepRecentTokens: 1,
      archiveMinChars: 1000,
      getTaskState: () => undefined,
    });

    const bigOutput = "x".repeat(3000);
    const messages: AgentMessage[] = [
      userText("go", 1),
      assistantText("running step 1"),
      toolResult(bigOutput, "call-1"),
      assistantText("running step 2"),
      toolResult("small output", "call-2"),
    ];

    const result = await engine.transform(messages);

    expect(sessionLog.all.filter((e) => e.kind === "archived-tool-output")).toHaveLength(1);
    expect(result.at(-1)).toEqual(messages.at(-1));
  });

  it("keepRecentTokens <= 0 compacts everything without an out-of-bounds crash", async () => {
    // Regression: pickCutIndex's first walk-back loop never decrements idx off `rest.length` when
    // the budget is already satisfied at 0 (0 < 0 is false), so a naive boundary search would then
    // read `rest[rest.length]` (undefined) and throw. `rest.length` itself is always a safe
    // boundary (nothing follows it to split), so this should just compact the entire range.
    const { models } = fakeModelsWithCanned("everything summarized");
    const engine = new CompactionEngine({
      models,
      getModel: () => FAKE_MODEL,
      sessionLog,
      triggerFraction: 0.5,
      keepRecentTokens: 0,
      getTaskState: () => undefined,
    });
    const messages = [userText("go", 1), assistantText("x".repeat(3000))];

    const result = await engine.transform(messages);

    expect(result).toHaveLength(1); // just the summary message -- nothing kept verbatim
    const text = (result[0] as { content: { text: string }[] }).content[0].text;
    expect(text).toContain("everything summarized");
  });

  it("reuses the cached summary across a second compaction instead of re-summarizing old content", async () => {
    const { models, callCount, requestAt } = fakeModelsWithQueue(["Summary1", "Summary2"]);
    const engine = new CompactionEngine({
      models,
      getModel: () => FAKE_MODEL,
      sessionLog,
      triggerFraction: 0.5, // ~500 estimated tokens on a 1000-token contextWindow
      keepRecentTokens: 1,
      getTaskState: () => undefined,
    });

    const firstBatch: AgentMessage[] = [
      userText("go", 1),
      assistantText("a".repeat(2000)), // ~500 tokens, enough alone to cross the threshold
      assistantText("done1"),
    ];
    const firstResult = await engine.transform(firstBatch);
    expect(callCount()).toBe(1);
    expect(firstResult.at(-1)).toEqual(firstBatch.at(-1));

    const secondBatch: AgentMessage[] = [
      ...firstBatch,
      assistantText("b".repeat(2000)),
      assistantText("done2"),
    ];
    const secondResult = await engine.transform(secondBatch);
    expect(callCount()).toBe(2);

    const secondTranscript = String((requestAt(1).messages[0] as { content: string }).content);
    expect(secondTranscript).toContain("Summary of even earlier conversation:");
    expect(secondTranscript).toContain("Summary1");
    // The original 2000 'a' characters were already folded into Summary1 and must not be
    // re-sent raw on the second pass -- only Summary1's own (short) text represents them now.
    expect(secondTranscript).not.toContain("a".repeat(2000));
    expect(secondResult.at(-1)).toEqual(secondBatch.at(-1));

    // A third call with no new messages should find everything already compacted and not call
    // the summarizer again -- proof `compactedThroughCount` actually advanced past the second cut.
    // Compared by role/content only, not full object equality: the synthetic summary message
    // carries a fresh `Date.now()` timestamp on every call, so a full-object compare would be
    // flaky against millisecond timing rather than testing the thing this asserts.
    const thirdResult = await engine.transform(secondBatch);
    expect(callCount()).toBe(2);
    expect(thirdResult.map((m) => (m as { role: string }).role)).toEqual(
      secondResult.map((m) => (m as { role: string }).role),
    );
    expect(thirdResult.at(-1)).toEqual(secondResult.at(-1));
  });

  it("drops a stale compaction cache when the live history is shorter than what was compacted (e.g. session.reset())", async () => {
    const { models, callCount } = fakeModelsWithQueue(["Summary1"]);
    const engine = new CompactionEngine({
      models,
      getModel: () => FAKE_MODEL,
      sessionLog,
      triggerFraction: 0.5,
      keepRecentTokens: 1,
      getTaskState: () => undefined,
    });

    const longBatch: AgentMessage[] = [
      userText("go", 1),
      assistantText("a".repeat(2000)),
      assistantText("done1"),
    ];
    await engine.transform(longBatch);
    expect(callCount()).toBe(1);

    // Simulate session.reset(): a fresh, much shorter conversation.
    const resetBatch: AgentMessage[] = [userText("hello again")];
    const result = await engine.transform(resetBatch);

    expect(callCount()).toBe(1); // nowhere near threshold on its own; no new summarization call
    expect(result).toEqual(resetBatch); // no stale cached summary prepended
  });

  describe("forceCompact", () => {
    it("compacts unconditionally when there IS a safe cut point, appending a compaction log entry same as the automatic path", async () => {
      const { models } = fakeModelsWithCanned("The user is debugging a ValueError.");
      const engine = new CompactionEngine({
        models,
        getModel: () => FAKE_MODEL, // contextWindow 1000, but forceCompact ignores the trigger
        sessionLog,
        keepRecentTokens: 1,
        getTaskState: () => undefined,
      });

      // Nowhere near the automatic transform() token threshold -- a handful of short messages --
      // but there IS a safe turn-boundary cut point (the leading "go"/first exchange), which is
      // all forceCompact requires.
      const messages: AgentMessage[] = [
        userText("go", 1),
        assistantText("step one"),
        userText("thanks, what's next?", 3),
        assistantText("here is the plan"),
      ];

      const result = await engine.forceCompact(messages);

      expect(result).toBeDefined();
      const compacted = result as AgentMessage[];
      // Kept verbatim: at least the final message, after the summary.
      expect(compacted.at(-1)).toEqual(messages.at(-1));
      const summaryText = (compacted[0] as { content: { text: string }[] }).content[0].text;
      expect(summaryText).toContain("<compaction-summary>");
      expect(summaryText).toContain("The user is debugging a ValueError.");

      const compactionEntries = sessionLog.all.filter((e) => e.kind === "compaction");
      expect(compactionEntries).toHaveLength(1);
    });

    it("returns undefined (no-op, no log entry) when there's no safe cut point yet -- a single huge recent turn", async () => {
      const { models } = fakeModelsWithCanned("unused");
      const engine = new CompactionEngine({
        models,
        getModel: () => FAKE_MODEL,
        sessionLog,
        keepRecentTokens: 8_000, // default-sized budget -- everything here counts as "recent"
        getTaskState: () => undefined,
      });

      // One single turn: no safe boundary exists before it (index 0 is the only candidate, and
      // pickCutIndex treats "nothing before this" as "nothing to compact").
      const messages: AgentMessage[] = [userText("go", 1), assistantText("a".repeat(2000))];

      const result = await engine.forceCompact(messages);

      expect(result).toBeUndefined();
      expect(sessionLog.all.filter((e) => e.kind === "compaction")).toHaveLength(0);
    });

    it("still compacts a short conversation nowhere near the token threshold -- unlike transform(), which would just return it unchanged", async () => {
      const { models } = fakeModelsWithCanned("Short summary.");
      const engineForTransform = new CompactionEngine({
        models,
        getModel: () => FAKE_MODEL, // contextWindow 1000; triggerFraction defaults to 0.7 (~700 tokens)
        sessionLog,
        keepRecentTokens: 1,
        getTaskState: () => undefined,
      });

      const messages: AgentMessage[] = [
        userText("go", 1),
        assistantText("step one"),
        userText("thanks, what's next?", 3),
        assistantText("here is the plan"),
      ];

      // transform() on this same short conversation is a pure passthrough: far under threshold.
      const transformResult = await engineForTransform.transform(messages);
      expect(transformResult).toEqual(messages);
      expect(sessionLog.all.filter((e) => e.kind === "compaction")).toHaveLength(0);

      // A fresh engine (forceCompact was never preceded by transform() triggering) still compacts
      // it right away, proving forceCompact doesn't depend on transform() having run first.
      const engineForForce = new CompactionEngine({
        models,
        getModel: () => FAKE_MODEL,
        sessionLog,
        keepRecentTokens: 1,
        getTaskState: () => undefined,
      });
      const forced = await engineForForce.forceCompact(messages);
      expect(forced).toBeDefined();
      expect(sessionLog.all.filter((e) => e.kind === "compaction")).toHaveLength(1);
    });
  });

  it("prepends the current task state on every call, independent of compaction triggering", async () => {
    const { models } = fakeModelsWithCanned("unused");
    let goal = "first goal";
    const engine = new CompactionEngine({
      models,
      getModel: () => FAKE_MODEL,
      sessionLog,
      getTaskState: () => ({ goal, decisions: [] }),
    });

    const result1 = await engine.transform([userText("hi")]);
    expect((result1[0] as { content: { text: string }[] }).content[0].text).toContain("first goal");

    goal = "updated goal";
    const result2 = await engine.transform([userText("hi")]);
    expect((result2[0] as { content: { text: string }[] }).content[0].text).toContain(
      "updated goal",
    );
  });
});
