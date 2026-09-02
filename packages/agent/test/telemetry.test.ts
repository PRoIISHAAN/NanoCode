// M4: telemetry (packages/agent/src/telemetry.ts) driven by a real Session run against a fake
// provider (deterministic, no network) -- proves attachTelemetry's AgentEvent -> span mapping
// against the actual event sequence Session emits, not a hand-rolled fake event list.
import type {
  Api,
  AssistantMessage,
  AssistantMessageEvent,
  AssistantMessageEventStream,
  Model,
} from "@nanocode/ai";
import { EventStream } from "@nanocode/ai";
import { Type } from "typebox";
import { describe, expect, it } from "vitest";
import { Session } from "../src/agent.ts";
import {
  attachTelemetry,
  createExporterFromEnv,
  type TelemetryExporter,
} from "../src/telemetry.ts";
import type { AgentEvent, StreamFn } from "../src/types.ts";

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

const USAGE: AssistantMessage["usage"] = {
  input: 10,
  output: 5,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 15,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

function assistantMessage(overrides: Partial<AssistantMessage>): AssistantMessage {
  return {
    role: "assistant",
    content: [],
    api: FAKE_MODEL.api,
    provider: FAKE_MODEL.provider,
    model: FAKE_MODEL.id,
    usage: USAGE,
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

describe("attachTelemetry", () => {
  it("emits a session span, one turn span, and one model_request span with usage attributes for a single-turn run", async () => {
    const streamFn: StreamFn = () => {
      const stream = fakeStream();
      pushFinal(
        stream,
        assistantMessage({ content: [{ type: "text", text: "hi" }], stopReason: "stop" }),
      );
      return stream;
    };
    const session = new Session({
      streamFn,
      initialState: { model: FAKE_MODEL, systemPrompt: "test" },
    });
    const telemetry = attachTelemetry(session);

    await session.prompt("hello");

    const names = telemetry.spans.map((s) => s.name);
    expect(names).toEqual(
      expect.arrayContaining(["nanocode.session", "nanocode.turn", "nanocode.model_request"]),
    );

    const modelSpan = telemetry.spans.find((s) => s.name === "nanocode.model_request");
    expect(modelSpan?.status).toBe("ok");
    expect(modelSpan?.attributes.usage).toEqual(USAGE);
    expect(modelSpan?.attributes.model).toBe(FAKE_MODEL.id);

    const sessionSpan = telemetry.spans.find((s) => s.name === "nanocode.session");
    expect(sessionSpan?.status).toBe("ok");
    expect(sessionSpan).toBeDefined();
    if (sessionSpan) expect(sessionSpan.endedAt).toBeGreaterThanOrEqual(sessionSpan.startedAt);
  });

  it("emits a tool span keyed by toolCallId, marked error on a failed tool call", async () => {
    let call = 0;
    const streamFn: StreamFn = () => {
      call += 1;
      const stream = fakeStream();
      if (call === 1) {
        pushFinal(
          stream,
          assistantMessage({
            content: [{ type: "toolCall", id: "call-1", name: "boom", arguments: {} }],
            stopReason: "toolUse",
          }),
        );
      } else {
        pushFinal(
          stream,
          assistantMessage({ content: [{ type: "text", text: "done" }], stopReason: "stop" }),
        );
      }
      return stream;
    };
    const session = new Session({
      streamFn,
      initialState: {
        model: FAKE_MODEL,
        systemPrompt: "test",
        tools: [
          {
            name: "boom",
            label: "boom",
            description: "always throws",
            parameters: Type.Object({}),
            execute: async () => {
              throw new Error("kaboom");
            },
          },
        ],
      },
    });
    const telemetry = attachTelemetry(session);

    await session.prompt("run boom");

    const toolSpan = telemetry.spans.find((s) => s.name === "nanocode.tool");
    expect(toolSpan?.status).toBe("error");
    expect(toolSpan?.attributes.tool).toBe("boom");
  });

  it("flush() sends completed spans to the configured exporter and does nothing without one", async () => {
    const streamFn: StreamFn = () => {
      const stream = fakeStream();
      pushFinal(stream, assistantMessage({ content: [{ type: "text", text: "hi" }] }));
      return stream;
    };

    const exported: unknown[] = [];
    const exporter: TelemetryExporter = {
      export: async (spans) => {
        exported.push(...spans);
      },
    };

    const session = new Session({
      streamFn,
      initialState: { model: FAKE_MODEL, systemPrompt: "test" },
    });
    const telemetry = attachTelemetry(session, { exporter });
    await session.prompt("hello");
    await telemetry.flush();

    expect(exported.length).toBe(telemetry.spans.length);
    expect(exported.length).toBeGreaterThan(0);

    // No exporter configured: flush() must not throw and must be a genuine no-op.
    const withoutExporter = attachTelemetry(
      new Session({ streamFn, initialState: { model: FAKE_MODEL, systemPrompt: "test" } }),
    );
    await expect(withoutExporter.flush()).resolves.toBeUndefined();
  });

  it("detach() stops further span collection", async () => {
    let call = 0;
    const streamFn: StreamFn = () => {
      call += 1;
      const stream = fakeStream();
      pushFinal(stream, assistantMessage({ content: [{ type: "text", text: `turn ${call}` }] }));
      return stream;
    };
    const session = new Session({
      streamFn,
      initialState: { model: FAKE_MODEL, systemPrompt: "test" },
    });
    const telemetry = attachTelemetry(session);
    await session.prompt("first");
    const countAfterFirst = telemetry.spans.length;

    telemetry.detach();
    await session.prompt("second");

    expect(telemetry.spans.length).toBe(countAfterFirst);
  });

  it("still emits session/turn/model_request spans for a Session.continue()-driven run", async () => {
    // Regression: an L4 review found agent-loop.ts's continueRun (which Session.continue() uses,
    // a real reachable API for resuming after a retry) never emits agent_start or an initial
    // turn_start the way runPrompt does -- attachTelemetry's original turn_start-driven design
    // silently dropped every span for a continuation's first turn as a result. Deriving span
    // boundaries from the assistant's own message_start/message_end instead (see attachTelemetry's
    // doc comment) fixes this structurally, since that fires regardless of entry point.
    const streamFn: StreamFn = () => {
      const stream = fakeStream();
      pushFinal(
        stream,
        assistantMessage({ content: [{ type: "text", text: "resumed" }], stopReason: "stop" }),
      );
      return stream;
    };
    const session = new Session({
      streamFn,
      initialState: { model: FAKE_MODEL, systemPrompt: "test" },
    });
    // Seed continue()'s precondition directly (last message is "user", no assistant reply yet)
    // without going through prompt() first, which would already produce that reply itself.
    session.state.messages = [{ role: "user", content: "resume me", timestamp: Date.now() }];

    const telemetry = attachTelemetry(session);
    await session.continue();

    const names = telemetry.spans.map((s) => s.name);
    expect(names).toEqual(
      expect.arrayContaining(["nanocode.session", "nanocode.turn", "nanocode.model_request"]),
    );
  });

  it("closeAll safety net closes a span left open when its own end event never arrives", () => {
    // Regression: an L4 review found that an early abort (before a turn's own turn_end/message_end
    // fires) could leave a "nanocode.turn" span open in the tracker forever -- invisible to
    // `.spans` and never flushed. Exercised directly against a raw event sequence (bypassing the
    // real agent loop) since reliably reproducing that exact internal race is not deterministic.
    const listeners: Array<(event: AgentEvent) => void> = [];
    const fakeSession = {
      subscribe: (listener: (event: AgentEvent) => void) => {
        listeners.push(listener);
        return () => {};
      },
    };
    const telemetry = attachTelemetry(fakeSession);
    const emit = (event: AgentEvent) => {
      for (const listener of listeners) listener(event);
    };

    emit({
      type: "message_start",
      message: assistantMessage({ content: [], stopReason: "pending" }),
    });
    // No turn_end, no message_end for that message -- simulates an abort that skips straight to
    // agent_end, the way Session.reportRunFailure's synthetic failure path does.
    emit({ type: "agent_end", messages: [] });

    const turnSpan = telemetry.spans.find((s) => s.name === "nanocode.turn");
    const modelSpan = telemetry.spans.find((s) => s.name === "nanocode.model_request");
    expect(turnSpan).toBeDefined();
    expect(modelSpan).toBeDefined();
  });
});

describe("createExporterFromEnv", () => {
  it("returns undefined when NANOCODE_TELEMETRY_ENDPOINT is unset", () => {
    expect(createExporterFromEnv({})).toBeUndefined();
  });

  it("returns an exporter that POSTs to the configured endpoint when set", async () => {
    const calls: Array<{ url: string; body: string }> = [];
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (url: string, init?: RequestInit) => {
      calls.push({ url: String(url), body: String(init?.body) });
      return new Response(null, { status: 200 });
    }) as typeof fetch;

    try {
      const exporter = createExporterFromEnv({
        NANOCODE_TELEMETRY_ENDPOINT: "https://example.test/spans",
      });
      expect(exporter).toBeDefined();
      await exporter?.export([
        { name: "nanocode.session", startedAt: 1, endedAt: 2, attributes: {}, status: "ok" },
      ]);
      expect(calls).toHaveLength(1);
      expect(calls[0].url).toBe("https://example.test/spans");
      expect(JSON.parse(calls[0].body).spans[0].name).toBe("nanocode.session");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
