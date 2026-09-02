// End-to-end test of runEvalCase with a FAKE provider (no network) but a REAL Python kernel and a
// real temp directory -- same proven shape as packages/agent/test/agent.test.ts: prove the actual
// mechanism (isolated workdir, real ipython tool execution, checks read the real filesystem)
// without needing live credentials.
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
import { describe, expect, it } from "vitest";
import type { EvalCase } from "../src/dataset.ts";
import { runEvalCase } from "../src/harness.ts";

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

function createFakeStream(): AssistantMessageEventStream {
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

/** Fakes resolveModel so no real provider/credential lookup happens -- the harness only needs
 * *a* Model object, not a genuinely configured one, for this test. */
async function fakeResolveModel(): Promise<Model<Api>> {
  return FAKE_MODEL;
}

/** A minimal fake MutableModels whose only used member is `streamSimple`. */
function createFakeModels(
  streamFn: (model: Model<Api>, context: Context) => AssistantMessageEventStream,
): MutableModels {
  return { streamSimple: streamFn } as unknown as MutableModels;
}

describe("runEvalCase (fake provider, real kernel)", () => {
  it("passes a text-answer case when the fake model answers correctly", async () => {
    const evalCase: EvalCase = {
      id: "capital-of-france",
      prompt: "What's the capital of France?",
      checks: [{ type: "outputEquals", value: "Paris" }, { type: "noErrors" }],
    };
    const models = createFakeModels(() => {
      const stream = createFakeStream();
      pushFinal(stream, {
        role: "assistant",
        content: [{ type: "text", text: "Paris" }],
        stopReason: "stop",
        api: FAKE_MODEL.api,
        provider: FAKE_MODEL.provider,
        model: FAKE_MODEL.id,
        usage: EMPTY_USAGE,
        timestamp: Date.now(),
      });
      return stream;
    });

    const result = await runEvalCase(
      evalCase,
      { name: "baseline", provider: "fake-provider", model: "fake-model" },
      models,
      fakeResolveModel,
    );

    expect(result.passed).toBe(true);
    expect(result.output).toBe("Paris");
  });

  it("fails and reports a reason when the fake model answers incorrectly", async () => {
    const evalCase: EvalCase = {
      id: "capital-of-france",
      prompt: "What's the capital of France?",
      checks: [{ type: "outputEquals", value: "Paris" }],
    };
    const models = createFakeModels(() => {
      const stream = createFakeStream();
      pushFinal(stream, {
        role: "assistant",
        content: [{ type: "text", text: "London" }],
        stopReason: "stop",
        api: FAKE_MODEL.api,
        provider: FAKE_MODEL.provider,
        model: FAKE_MODEL.id,
        usage: EMPTY_USAGE,
        timestamp: Date.now(),
      });
      return stream;
    });

    const result = await runEvalCase(
      evalCase,
      { name: "baseline", provider: "fake-provider", model: "fake-model" },
      models,
      fakeResolveModel,
    );

    expect(result.passed).toBe(false);
    expect(result.checks[0].reason).toMatch(/London/);
  });

  it("runs real Python through the real kernel and checks the real filesystem, then cleans up", async () => {
    const evalCase: EvalCase = {
      id: "write-file",
      prompt: "write hello.txt",
      checks: [
        { type: "fileExists", path: "hello.txt" },
        { type: "fileContains", path: "hello.txt", value: "hi" },
      ],
    };
    let call = 0;
    const models = createFakeModels(() => {
      call += 1;
      const stream = createFakeStream();
      if (call === 1) {
        pushFinal(stream, {
          role: "assistant",
          content: [
            {
              type: "toolCall",
              id: "call-1",
              name: "ipython",
              arguments: { code: "open('hello.txt', 'w').write('hi')" },
            },
          ],
          stopReason: "toolUse",
          api: FAKE_MODEL.api,
          provider: FAKE_MODEL.provider,
          model: FAKE_MODEL.id,
          usage: EMPTY_USAGE,
          timestamp: Date.now(),
        });
      } else {
        pushFinal(stream, {
          role: "assistant",
          content: [{ type: "text", text: "done" }],
          stopReason: "stop",
          api: FAKE_MODEL.api,
          provider: FAKE_MODEL.provider,
          model: FAKE_MODEL.id,
          usage: EMPTY_USAGE,
          timestamp: Date.now(),
        });
      }
      return stream;
    });

    const result = await runEvalCase(
      evalCase,
      { name: "baseline", provider: "fake-provider", model: "fake-model" },
      models,
      fakeResolveModel,
    );

    expect(result.passed).toBe(true);
    // runEvalCase's finally block runs kernel.shutdown() then rm(workdir, {recursive: true}) --
    // a throw in either would supersede this resolved `result`, so reaching this line at all
    // already proves both cleanup steps completed without error.
  });
});
