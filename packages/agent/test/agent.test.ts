// End-to-end test of the M1 loop with a FAKE provider (no network, no API key) but a REAL Python
// kernel: proves the actual mechanism -- assistant requests a tool call, the ipython tool runs
// real Python through the real kernel, the tool result round-trips back into context, and a
// second (fake) assistant turn produces the final answer -- without needing live credentials.

import type {
  Api,
  AssistantMessage,
  AssistantMessageEvent,
  AssistantMessageEventStream,
  Context,
  Model,
} from "@nanocode/ai";
import { EventStream } from "@nanocode/ai";
import { ReplKernelManager } from "@nanocode/kernel";
import { Type } from "typebox";
import { afterEach, describe, expect, it } from "vitest";
import { Session } from "../src/agent.ts";
import { createIpythonTool } from "../src/tools/ipython.ts";
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

function extractFinalMessage(event: AssistantMessageEvent): AssistantMessage {
  if (event.type === "done") return event.message;
  if (event.type === "error") return event.error;
  throw new Error("Unexpected event type for final result");
}

/** Structurally identical to AssistantMessageEventStream -- see the comment in @nanocode/ai's
 * index.ts on why the real subclass isn't re-exported as a value. */
function createFakeAssistantMessageEventStream(): AssistantMessageEventStream {
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

describe("Session (M1 loop, fake provider + real kernel)", () => {
  let kernel: ReplKernelManager | undefined;

  afterEach(async () => {
    await kernel?.shutdown();
    kernel = undefined;
  });

  it("runs a tool call through the real Python kernel and produces a final answer", async () => {
    kernel = new ReplKernelManager();
    const ipythonTool = createIpythonTool(kernel);

    // Turn 1: "assistant" asks to run `17 * 23` via the ipython tool.
    // Turn 2: "assistant" reads the tool result (391) and answers in plain text.
    let call = 0;
    const streamFn: StreamFn = (_model: Model<Api>, _context: Context) => {
      call += 1;
      const stream = createFakeAssistantMessageEventStream();
      if (call === 1) {
        pushFinal(stream, {
          role: "assistant",
          content: [
            { type: "toolCall", id: "call-1", name: "ipython", arguments: { code: "17 * 23" } },
          ],
          api: FAKE_MODEL.api,
          provider: FAKE_MODEL.provider,
          model: FAKE_MODEL.id,
          usage: EMPTY_USAGE,
          stopReason: "toolUse",
          timestamp: Date.now(),
        });
      } else {
        pushFinal(stream, {
          role: "assistant",
          content: [{ type: "text", text: "The answer is 391." }],
          api: FAKE_MODEL.api,
          provider: FAKE_MODEL.provider,
          model: FAKE_MODEL.id,
          usage: EMPTY_USAGE,
          stopReason: "stop",
          timestamp: Date.now(),
        });
      }
      return stream;
    };

    const session = new Session({
      streamFn,
      initialState: {
        model: FAKE_MODEL,
        systemPrompt: "test",
        tools: [ipythonTool],
      },
    });

    await session.prompt("Compute 17 * 23 using python and tell me the answer.");

    expect(call).toBe(2);
    const messages = session.state.messages;
    const toolResult = messages.find((m) => m.role === "toolResult");
    expect(toolResult).toBeDefined();
    if (toolResult && toolResult.role === "toolResult") {
      expect(toolResult.content).toEqual([{ type: "text", text: "391" }]);
      expect(toolResult.isError).toBe(false);
    }
    const finalMessage = messages[messages.length - 1];
    expect(finalMessage.role).toBe("assistant");
    if (finalMessage.role === "assistant") {
      expect(finalMessage.stopReason).toBe("stop");
      expect(finalMessage.content).toEqual([{ type: "text", text: "The answer is 391." }]);
    }
  });

  // Regression test: runRequestedTools() used to build a synthetic "tool call never settled"
  // result message (isError: false) for every requested call, even ones the sequential batch
  // runner's abort check skipped entirely (never called resolve()/invokeAndFinalize() on them).
  // That produced a misleading toolResult claiming success for a call that never ran.
  it("produces no result message for a sequential tool call skipped by an abort mid-batch", async () => {
    let toolBWasCalled = false;
    let session!: Session;

    const toolA: AgentTool = {
      name: "tool-a",
      label: "A",
      description: "aborts the run partway through its own execution",
      parameters: Type.Object({}),
      execute: async () => {
        session.abort(); // fires the same AbortSignal runRequestedTools checks between calls
        return { content: [{ type: "text", text: "a-done" }], details: {} };
      },
    };
    const toolB: AgentTool = {
      name: "tool-b",
      label: "B",
      description: "must never actually run",
      parameters: Type.Object({}),
      execute: async () => {
        toolBWasCalled = true;
        return { content: [{ type: "text", text: "b-done" }], details: {} };
      },
    };

    const streamFn: StreamFn = () => {
      const stream = createFakeAssistantMessageEventStream();
      pushFinal(stream, {
        role: "assistant",
        content: [
          { type: "toolCall", id: "call-a", name: "tool-a", arguments: {} },
          { type: "toolCall", id: "call-b", name: "tool-b", arguments: {} },
        ],
        api: FAKE_MODEL.api,
        provider: FAKE_MODEL.provider,
        model: FAKE_MODEL.id,
        usage: EMPTY_USAGE,
        stopReason: "toolUse",
        timestamp: Date.now(),
      });
      return stream;
    };

    session = new Session({
      streamFn,
      toolExecution: "sequential",
      initialState: { model: FAKE_MODEL, systemPrompt: "test", tools: [toolA, toolB] },
    });

    await session.prompt("run both tools");

    expect(toolBWasCalled).toBe(false);
    const toolResults = session.state.messages.filter((m) => m.role === "toolResult");
    // Only tool-a produced a result (an aborted one, since the signal fired while its own
    // execute() call was still in flight from invokeAndFinalize()'s point of view); tool-b never
    // started, so it must not appear here at all -- not even as a synthetic placeholder.
    expect(toolResults).toHaveLength(1);
    expect(toolResults[0]).toMatchObject({ toolCallId: "call-a", isError: true });
  });
});
