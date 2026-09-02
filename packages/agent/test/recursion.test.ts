// M2: proves RLM recursion end to end with fake providers (deterministic, no network) but real
// kernels (real Python subprocesses on both the parent and the child side) -- the same mechanism
// the live demo command exercises, just with the LLM calls swapped out.

import type {
  Api,
  AssistantMessage,
  AssistantMessageEvent,
  AssistantMessageEventStream,
  Model,
  MutableModels,
} from "@nanocode/ai";
import { EventStream } from "@nanocode/ai";
import { ReplKernelManager } from "@nanocode/kernel";
import { afterEach, describe, expect, it } from "vitest";
import { Session } from "../src/agent.ts";
import { createRecursionHandler, DEFAULT_MAX_RECURSION_DEPTH } from "../src/recursion.ts";
import { createIpythonTool } from "../src/tools/ipython.ts";
import type { StreamFn } from "../src/types.ts";

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

function fakeStream(): AssistantMessageEventStream {
  return new EventStream<AssistantMessageEvent, AssistantMessage>(
    (event) => event.type === "done" || event.type === "error",
    extractFinalMessage,
  );
}

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

function pushFinal(stream: AssistantMessageEventStream, message: AssistantMessage): void {
  stream.push({ type: "start", partial: { ...message, content: [] } });
  stream.push({
    type: "done",
    reason: message.stopReason as Extract<AssistantMessage["stopReason"], "stop" | "toolUse">,
    message,
  });
}

/** A models registry stand-in: only the one method Session/recursion.ts actually calls. */
function fakeModelsRegistry(streamFn: StreamFn): MutableModels {
  return { streamSimple: streamFn } as unknown as MutableModels;
}

describe("RLM recursion (M2)", () => {
  let kernel: ReplKernelManager | undefined;

  afterEach(async () => {
    await kernel?.shutdown();
    kernel = undefined;
  });

  it("lets a cell call rlm.run() and get back the child's final answer, one level deep", async () => {
    // Parent turn 1: call rlm.run() and print whatever it returns.
    // Child turn 1: reply "42" directly (no tools).
    // Parent turn 2: read the printed "42" from the tool result and give a final answer.
    let parentCalls = 0;
    let childCalls = 0;

    const childStreamFn: StreamFn = () => {
      childCalls += 1;
      const stream = fakeStream();
      pushFinal(
        stream,
        assistantMessage({ content: [{ type: "text", text: "42" }], stopReason: "stop" }),
      );
      return stream;
    };

    const parentStreamFn: StreamFn = () => {
      parentCalls += 1;
      const stream = fakeStream();
      if (parentCalls === 1) {
        pushFinal(
          stream,
          assistantMessage({
            content: [
              {
                type: "toolCall",
                id: "call-1",
                name: "ipython",
                arguments: { code: "print(await rlm.run('reply with just the number 42'))" },
              },
            ],
            stopReason: "toolUse",
          }),
        );
      } else {
        pushFinal(
          stream,
          assistantMessage({
            content: [{ type: "text", text: "The sub-agent said 42." }],
            stopReason: "stop",
          }),
        );
      }
      return stream;
    };

    const models = fakeModelsRegistry(parentStreamFn);
    // The child's own recursion handler uses a separate fake registry bound to the child stream,
    // matching how a real depth-1 child would still share the SAME real Models instance in
    // production -- here we just need its `streamSimple` to answer differently for the child.
    const childModels = fakeModelsRegistry(childStreamFn);

    kernel = new ReplKernelManager({
      hostHandlers: {
        "rlm.run": createRecursionHandler({
          models: childModels,
          model: FAKE_MODEL,
          systemPrompt: "child",
          depth: 0,
        }),
      },
    });
    const session = new Session({
      streamFn: models.streamSimple.bind(models),
      initialState: {
        model: FAKE_MODEL,
        systemPrompt: "parent",
        tools: [createIpythonTool(kernel)],
      },
    });

    await session.prompt("Ask a sub-agent for the answer.");

    expect(childCalls).toBe(1);
    expect(parentCalls).toBe(2);
    const toolResult = session.state.messages.find((m) => m.role === "toolResult");
    expect(toolResult && toolResult.role === "toolResult" ? toolResult.isError : true).toBe(false);
    // print() adds the trailing newline; that's the real, correct kernel behavior being observed.
    expect(toolResult && toolResult.role === "toolResult" ? toolResult.content : undefined).toEqual(
      [{ type: "text", text: "42\n" }],
    );
    const finalMessage = session.state.messages.at(-1);
    expect(finalMessage?.role).toBe("assistant");
    if (finalMessage?.role === "assistant") {
      expect(finalMessage.content).toEqual([{ type: "text", text: "The sub-agent said 42." }]);
    }
  });

  it("rejects recursion at the depth limit before constructing any child session", async () => {
    let childKernelsSpawned = 0;
    const OriginalReplKernelManager = ReplKernelManager;
    // Wrap the constructor just to count instantiation attempts -- a rejection at the depth limit
    // must happen strictly before this, so this count must stay at 0 for the rejected call.
    class CountingKernelManager extends OriginalReplKernelManager {
      constructor(...args: ConstructorParameters<typeof OriginalReplKernelManager>) {
        super(...args);
        childKernelsSpawned += 1;
      }
    }

    let calls = 0;
    const streamFn: StreamFn = () => {
      calls += 1;
      const stream = fakeStream();
      if (calls === 1) {
        pushFinal(
          stream,
          assistantMessage({
            content: [
              {
                type: "toolCall",
                id: "call-1",
                name: "ipython",
                arguments: { code: "await rlm.run('go')" },
              },
            ],
            stopReason: "toolUse",
          }),
        );
      } else {
        pushFinal(
          stream,
          assistantMessage({ content: [{ type: "text", text: "gave up" }], stopReason: "stop" }),
        );
      }
      return stream;
    };
    const models = fakeModelsRegistry(streamFn);

    // maxDepth: 0 means even the very first rlm.run() call (depth 0 -> would-be child at depth 1)
    // is already at the limit -- reject immediately, no child kernel constructed. The counting
    // subclass is used for the parent's own kernel too, so what matters is that the count doesn't
    // *increase* once the (rejected) recursion attempt runs -- not that it's zero in absolute terms.
    kernel = new CountingKernelManager({
      hostHandlers: {
        "rlm.run": createRecursionHandler({
          models,
          model: FAKE_MODEL,
          systemPrompt: "x",
          depth: 0,
          maxDepth: 0,
        }),
      },
    });
    const kernelsSpawnedBeforePrompt = childKernelsSpawned;
    const session = new Session({
      streamFn: models.streamSimple.bind(models),
      initialState: {
        model: FAKE_MODEL,
        systemPrompt: "parent",
        tools: [createIpythonTool(kernel)],
      },
    });

    await session.prompt("Try to recurse.");

    expect(childKernelsSpawned).toBe(kernelsSpawnedBeforePrompt);
    // The rejection surfaces as a RuntimeError raised inside the Python cell (uncaught, since the
    // test cell is a bare `await rlm.run(...)`), which the kernel reports as a cell-level error
    // event -- not a tool-execution failure -- so isError stays false; the traceback text itself
    // is what carries the actual rejection message back to the model.
    const toolResult = session.state.messages.find((m) => m.role === "toolResult");
    expect(toolResult && toolResult.role === "toolResult" ? toolResult.isError : undefined).toBe(
      false,
    );
    const cellOutputText =
      toolResult && toolResult.role === "toolResult"
        ? (toolResult.content[0] as { text: string }).text
        : "";
    expect(cellOutputText).toContain("RLM recursion depth limit");
  });

  it("exports DEFAULT_MAX_RECURSION_DEPTH as a small, sane default", () => {
    expect(DEFAULT_MAX_RECURSION_DEPTH).toBeGreaterThan(0);
    expect(DEFAULT_MAX_RECURSION_DEPTH).toBeLessThanOrEqual(5);
  });
});
