// Local, exporter-free-by-default telemetry (pi's pattern, not prime-agent's default-on phone-home
// analytics) built on `Session`'s existing `AgentEvent` bus rather than new instrumentation
// scattered through agent-loop.ts -- see decisions/0008-project-trust-sandbox-telemetry.md.
import type { AgentEvent } from "./types.ts";

export interface TelemetrySpan {
  name: string;
  startedAt: number;
  endedAt: number;
  attributes: Record<string, unknown>;
  status: "ok" | "error";
}

/** A caller-supplied sink for completed spans. nanocode ships no first-party endpoint of its
 * own -- see `createExporterFromEnv`. */
export interface TelemetryExporter {
  export(spans: TelemetrySpan[]): Promise<void>;
}

interface OpenSpan {
  name: string;
  startedAt: number;
  attributes: Record<string, unknown>;
}

/** Tracks spans in memory only, keyed by a caller-chosen string (a `toolCallId`, a turn counter,
 * ...) so `start`/`end` calls for the same logical span can be correlated without a stack. */
class SpanTracker {
  private readonly open = new Map<string, OpenSpan>();
  private readonly completed: TelemetrySpan[] = [];

  has(key: string): boolean {
    return this.open.has(key);
  }

  start(key: string, name: string, attributes: Record<string, unknown> = {}): void {
    this.open.set(key, { name, startedAt: Date.now(), attributes });
  }

  end(key: string, attributes: Record<string, unknown> = {}, status: "ok" | "error" = "ok"): void {
    const span = this.open.get(key);
    if (!span) return; // no matching start -- e.g. a run that failed before its span opened
    this.open.delete(key);
    this.completed.push({
      name: span.name,
      startedAt: span.startedAt,
      endedAt: Date.now(),
      attributes: { ...span.attributes, ...attributes },
      status,
    });
  }

  /** Safety net for `agent_end`: closes any span still open (e.g. a turn whose own `turn_end`
   * never fired because the run aborted before reaching it -- see `attachTelemetry`'s `agent_end`
   * handler) so nothing lingers in `open` forever, invisible to `.spans` and never flushed. */
  closeAll(status: "ok" | "error"): void {
    for (const key of [...this.open.keys()]) this.end(key, {}, status);
  }

  get spans(): readonly TelemetrySpan[] {
    return this.completed;
  }
}

export interface AttachTelemetryOptions {
  exporter?: TelemetryExporter;
}

export interface TelemetryHandle {
  /** All spans completed so far, in completion order. */
  readonly spans: readonly TelemetrySpan[];
  /** Stops listening for further events. Does not flush -- call `flush()` first if needed. */
  detach(): void;
  /** Sends every completed span to the configured exporter, if any. A no-op with no exporter. */
  flush(): Promise<void>;
}

/** Maps a `StopReason` to a span status -- both an actual failure and an abort count as "error"
 * for tracing purposes (OTel-style status codes don't distinguish a third "aborted" outcome). */
function statusForStopReason(stopReason: string): "ok" | "error" {
  return stopReason === "error" || stopReason === "aborted" ? "error" : "ok";
}

/**
 * Subscribes to `session`'s `AgentEvent`s and turns them into spans: one root `nanocode.session`
 * span, one `nanocode.turn` span per turn, one `nanocode.tool` span per tool call (keyed by its
 * `toolCallId`, already a stable unique id from the event data), and one `nanocode.model_request`
 * span per assistant message.
 *
 * Deliberately driven by `message_start`/`message_end` for the assistant message, not by
 * `agent_start`/`turn_start`: `agent-loop.ts`'s `continueRun` (used by `Session.continue()`, a
 * real, reachable API for resuming after a retry) never emits `agent_start` or an initial
 * `turn_start` the way `runPrompt` does, which would otherwise silently drop every span for a
 * continuation's first turn. An assistant `message_start` fires exactly once per turn regardless
 * of which entry point started the run -- including the synthetic failure message
 * `Session.reportRunFailure` builds for a run that aborts before its first turn even begins -- so
 * it's the one reliable "a turn (and, if not already open, the session) has begun" signal.
 * `agent_end` is used as a safety net to force-close any span a turn's own end event might have
 * skipped (e.g. an immediate abort that never reaches `turn_end`), so nothing lingers open forever.
 */
export function attachTelemetry(
  session: { subscribe(listener: (event: AgentEvent) => void): () => void },
  options: AttachTelemetryOptions = {},
): TelemetryHandle {
  const tracker = new SpanTracker();
  let turnCounter = 0;
  let currentTurnKey: string | undefined;

  const unsubscribe = session.subscribe((event) => {
    switch (event.type) {
      case "message_start":
        if (event.message.role === "assistant") {
          if (!tracker.has("session")) tracker.start("session", "nanocode.session");
          turnCounter += 1;
          currentTurnKey = `turn:${turnCounter}`;
          tracker.start(currentTurnKey, "nanocode.turn");
          tracker.start(`model:${currentTurnKey}`, "nanocode.model_request");
        }
        return;
      case "turn_end":
        if (currentTurnKey) {
          tracker.end(currentTurnKey, { toolCallCount: event.toolResults.length });
        }
        return;
      case "message_end":
        if (event.message.role === "assistant" && currentTurnKey) {
          tracker.end(
            `model:${currentTurnKey}`,
            {
              model: event.message.model,
              provider: event.message.provider,
              stopReason: event.message.stopReason,
              usage: event.message.usage,
            },
            statusForStopReason(event.message.stopReason),
          );
        }
        return;
      case "tool_execution_start":
        tracker.start(`tool:${event.toolCallId}`, "nanocode.tool", { tool: event.toolName });
        return;
      case "tool_execution_end":
        tracker.end(
          `tool:${event.toolCallId}`,
          { tool: event.toolName },
          event.isError ? "error" : "ok",
        );
        return;
      case "agent_end":
        // Close "session" first, with its own attributes, before the safety net below closes
        // whatever's left -- closeAll() would otherwise beat it to "session" and drop messageCount.
        tracker.end("session", { messageCount: event.messages.length });
        tracker.closeAll("ok"); // any other span a normal end event missed (see doc comment above)
        return;
    }
  });

  return {
    get spans() {
      return tracker.spans;
    },
    detach: unsubscribe,
    flush: async () => {
      if (options.exporter) await options.exporter.export(tracker.spans.slice());
    },
  };
}

/** POSTs a JSON `{ spans }` batch to a fixed URL -- the generic pluggable exporter shape; nanocode
 * has no hosted backend of its own, so there is no concrete first-party endpoint to default to. */
export function createHttpExporter(endpointUrl: string): TelemetryExporter {
  return {
    async export(spans) {
      await fetch(endpointUrl, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ spans }),
      });
    },
  };
}

/** Reads `NANOCODE_TELEMETRY_ENDPOINT` -- undefined (no exporter, spans stay in-memory only) when
 * unset, matching "no telemetry leaves the machine unless explicitly configured". */
export function createExporterFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): TelemetryExporter | undefined {
  const url = env.NANOCODE_TELEMETRY_ENDPOINT;
  return url ? createHttpExporter(url) : undefined;
}
