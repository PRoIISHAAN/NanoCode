/**
 * The core think -> act -> observe loop: stream one assistant turn, run whatever tool calls it
 * asked for, feed the results back in, and repeat until the model stops (or a hook says to).
 * Works entirely in terms of `AgentMessage`; only `convertToLlm` at the request boundary produces
 * the `Message[]` shape the provider actually understands.
 *
 * `agent-loop.ts` solves (a driver plus a set of optional
 * hooks for steering/follow-up/continuation, sequential-vs-parallel tool execution, abort
 * propagation at every await point) -- independently implemented below, including a materially
 * different decomposition for tool execution: instead of three free functions (prepare / execute /
 * finalize) threaded through two near-duplicate sequential and parallel batch runners, one call's
 * whole lifecycle lives on a single `ToolCallRun` object with a two-phase `resolve()` /
 * `invokeAndFinalize()` API, and the sequential and parallel batch runners share that one object
 * instead of each re-implementing the prepare/execute/finalize sequence. The unused
 * `EventStream`-returning wrapper API from the reference (`agentLoop`/`agentLoopContinue`) isn't
 * ported at all -- nothing in nanocode consumes a raw event stream; `Session` (in agent.ts) drives
 * everything here through plain callback-style emit functions.
 */

import type {
  AssistantMessage,
  AssistantMessageEvent,
  Context,
  ToolResultMessage,
} from "@nanocode/ai";
import { validateToolArguments } from "@nanocode/ai";
import type {
  AgentContext,
  AgentEvent,
  AgentLoopConfig,
  AgentMessage,
  AgentTool,
  AgentToolCall,
  AgentToolResult,
  StreamFn,
} from "./types.ts";

export type EmitAgentEvent = (event: AgentEvent) => Promise<void> | void;

const ABORTED_MESSAGE = "run was aborted";
const ZERO_USAGE: AssistantMessage["usage"] = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 0,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

function abortError(): Error {
  return new Error(ABORTED_MESSAGE);
}

function wasAbortError(error: unknown): boolean {
  return (
    error instanceof Error && (error.message === ABORTED_MESSAGE || error.name === "AbortError")
  );
}

/** Throws immediately if `signal` has already fired -- a thin wrapper so call sites read as
 * intent ("bail out here if aborted") rather than a raw platform-API call. */
function checkAborted(signal: AbortSignal | undefined): void {
  signal?.throwIfAborted();
}

/** Wraps `operation` so it settles the instant `signal` fires, whichever comes first. */
function withAbort<T>(
  operation: Promise<T>,
  signal: AbortSignal | undefined,
  onAbort?: () => void,
): Promise<T> {
  if (!signal) return operation;
  if (signal.aborted) {
    onAbort?.();
    void operation.catch(() => undefined);
    return Promise.reject(abortError());
  }
  return new Promise<T>((resolve, reject) => {
    let done = false;
    const onFire = () => {
      if (done) return;
      done = true;
      signal.removeEventListener("abort", onFire);
      onAbort?.();
      reject(abortError());
    };
    signal.addEventListener("abort", onFire, { once: true });
    operation.then(
      (value) => {
        if (done) return;
        done = true;
        signal.removeEventListener("abort", onFire);
        resolve(value);
      },
      (error: unknown) => {
        if (done) return;
        done = true;
        signal.removeEventListener("abort", onFire);
        reject(error);
      },
    );
  });
}

function resolveWithAbort<T>(
  value: T | Promise<T>,
  signal: AbortSignal | undefined,
  onAbort?: () => void,
): Promise<T> {
  return withAbort(Promise.resolve(value), signal, onAbort);
}

type PolledStep<T> = { ran: true; value: T } | { ran: false };

/** Runs a post-turn hook (a stop-check or a steering/follow-up/continuation poll) and turns an
 * abort-caused rejection into a clean "didn't run" result instead of propagating it as a failure. */
async function pollStep<T>(
  operation: Promise<T>,
  signal: AbortSignal | undefined,
): Promise<PolledStep<T>> {
  try {
    return { ran: true, value: await operation };
  } catch (error) {
    if (signal?.aborted && wasAbortError(error)) return { ran: false };
    throw error;
  }
}

async function pollMessages(
  poll: (() => AgentMessage[] | Promise<AgentMessage[]>) | undefined,
  signal: AbortSignal | undefined,
): Promise<AgentMessage[]> {
  if (!poll || signal?.aborted) return [];
  return (await resolveWithAbort(poll(), signal)) || [];
}

function cloneAssistantContent(content: AssistantMessage["content"]): AssistantMessage["content"] {
  return content.map((part) =>
    part.type === "toolCall" ? { ...part, arguments: { ...part.arguments } } : { ...part },
  );
}

function buildAbortedMessage(
  config: AgentLoopConfig,
  partial: AssistantMessage | null,
): AssistantMessage {
  return {
    role: "assistant",
    content: partial ? cloneAssistantContent(partial.content) : [{ type: "text", text: "" }],
    api: partial?.api ?? config.model.api,
    provider: partial?.provider ?? config.model.provider,
    model: partial?.model ?? config.model.id,
    usage: partial
      ? { ...partial.usage, cost: { ...partial.usage.cost } }
      : { ...ZERO_USAGE, cost: { ...ZERO_USAGE.cost } },
    stopReason: "aborted",
    errorMessage: ABORTED_MESSAGE,
    timestamp: Date.now(),
  };
}

/** Starts a brand-new run: appends `prompts`, then drives turns until the run stops. */
export async function runPrompt(
  prompts: AgentMessage[],
  context: AgentContext,
  config: AgentLoopConfig,
  emit: EmitAgentEvent,
  signal?: AbortSignal,
  streamFn?: StreamFn,
): Promise<AgentMessage[]> {
  const produced: AgentMessage[] = [...prompts];
  const live: AgentContext = { ...context, messages: [...context.messages, ...prompts] };

  await emit({ type: "agent_start" });
  await emit({ type: "turn_start" });
  for (const prompt of prompts) {
    await emit({ type: "message_start", message: prompt });
    await emit({ type: "message_end", message: prompt });
  }

  await new ConversationDriver(live, produced, config, signal, emit, streamFn).run();
  return produced;
}

/**
 * Resumes a run from the context as-is (the last message must already be a user or tool-result
 * message that hasn't had an assistant reply yet -- used for retries).
 */
export async function continueRun(
  context: AgentContext,
  config: AgentLoopConfig,
  emit: EmitAgentEvent,
  signal?: AbortSignal,
  streamFn?: StreamFn,
): Promise<AgentMessage[]> {
  if (context.messages.length === 0) throw new Error("cannot continue: no messages in context");
  if (context.messages[context.messages.length - 1].role === "assistant") {
    throw new Error("cannot continue from message role: assistant");
  }
  const produced: AgentMessage[] = [];
  await new ConversationDriver({ ...context }, produced, config, signal, emit, streamFn).run();
  return produced;
}

type TurnRecord = Parameters<NonNullable<AgentLoopConfig["getContinuationMessages"]>>[0];

type TurnStep = { outcome: "finished" } | { outcome: "continuing"; mayHaveMoreToolCalls: boolean };

/**
 * Owns one run's turn-by-turn progression: request a turn, run its tool calls, then ask the
 * steering / follow-up / continuation hooks (in that priority order) whether another turn should
 * follow. Instantiated fresh per run by `runPrompt`/`continueRun` above.
 */
class ConversationDriver {
  private startedFirstTurn = false;
  private lastTurn?: TurnRecord;
  private queued: AgentMessage[] = [];

  constructor(
    private readonly context: AgentContext,
    private readonly produced: AgentMessage[],
    private readonly config: AgentLoopConfig,
    private readonly signal: AbortSignal | undefined,
    private readonly emit: EmitAgentEvent,
    private readonly streamFn: StreamFn | undefined,
  ) {}

  private shouldHaltBeforeNextTurn(): boolean {
    return this.startedFirstTurn && (this.config.shouldStopBeforeTurn?.() ?? false);
  }

  private async finish(): Promise<void> {
    await this.emit({ type: "agent_end", messages: this.produced });
  }

  async run(): Promise<void> {
    this.queued = await pollMessages(this.config.getSteeringMessages, this.signal);

    while (true) {
      checkAborted(this.signal);
      if ((await this.runTurnGroup()) === "finished") return;

      if (this.shouldHaltBeforeNextTurn()) break;
      const nextBatch = await this.pollBetweenTurnGroups();
      if (nextBatch === "aborted") return this.finish();
      if (nextBatch.length === 0) break;
      this.queued = nextBatch;
    }

    await this.finish();
  }

  /**
   * Runs turns back to back for as long as there's an unresolved tool call or a queued message
   * batch to fold in. Returns "finished" once `agent_end` has already been emitted (the caller
   * must not do anything further), or "exhausted" once this group naturally runs out of work --
   * at which point the caller decides whether to poll for a new one.
   */
  private async runTurnGroup(): Promise<"finished" | "exhausted"> {
    let mayHaveMoreToolCalls = true;
    while (mayHaveMoreToolCalls || this.queued.length > 0) {
      checkAborted(this.signal);
      const step = await this.runOneTurn();
      if (step.outcome === "finished") return "finished";
      mayHaveMoreToolCalls = step.mayHaveMoreToolCalls;
    }
    return "exhausted";
  }

  /** One full turn: request a response, run its tool calls, then check every reason the run
   * could end here (an error/aborted turn, an abort after tools ran, a `shouldStopAfterTurn` hook,
   * an aborted steering poll, or an empty steering poll combined with `shouldStopBeforeTurn`). */
  private async runOneTurn(): Promise<TurnStep> {
    if (this.startedFirstTurn) {
      await this.emit({ type: "turn_start" });
    } else {
      this.startedFirstTurn = true;
    }
    await this.flushQueuedMessages();

    const assistantMessage = await this.requestTurn();
    this.produced.push(assistantMessage);

    if (assistantMessage.stopReason === "error" || assistantMessage.stopReason === "aborted") {
      await this.emit({ type: "turn_end", message: assistantMessage, toolResults: [] });
      return this.concludeRun();
    }

    const { toolResults, everyCallRequestedStop } = await this.runRequestedTools(assistantMessage);
    const mayHaveMoreToolCalls = toolResults.length > 0 && !everyCallRequestedStop;
    for (const result of toolResults) {
      this.context.messages.push(result);
      this.produced.push(result);
    }

    await this.emit({ type: "turn_end", message: assistantMessage, toolResults });
    if (this.signal?.aborted) return this.concludeRun();

    this.lastTurn = {
      message: assistantMessage,
      toolResults,
      context: this.context,
      newMessages: this.produced,
    };
    if (await this.turnRequestsStop()) return this.concludeRun();

    const steeringStep = await pollStep(
      pollMessages(this.config.getSteeringMessages, this.signal),
      this.signal,
    );
    if (!steeringStep.ran) return this.concludeRun();
    this.queued = steeringStep.value;
    if (this.queued.length === 0 && this.shouldHaltBeforeNextTurn()) return this.concludeRun();

    return { outcome: "continuing", mayHaveMoreToolCalls };
  }

  /** Emits `agent_end` and produces the "finished" signal `runOneTurn`'s five stop points share. */
  private async concludeRun(): Promise<{ outcome: "finished" }> {
    await this.finish();
    return { outcome: "finished" };
  }

  private async flushQueuedMessages(): Promise<void> {
    for (const message of this.queued) {
      await this.emit({ type: "message_start", message });
      await this.emit({ type: "message_end", message });
      this.context.messages.push(message);
      this.produced.push(message);
    }
    this.queued = [];
  }

  /** True when a `shouldStopAfterTurn` hook (or an abort while awaiting it) ends the run here. */
  private async turnRequestsStop(): Promise<boolean> {
    const step = await pollStep(
      resolveWithAbort(
        this.config.shouldStopAfterTurn?.(this.lastTurn as TurnRecord) ?? false,
        this.signal,
      ),
      this.signal,
    );
    if (!step.ran) return true; // aborted mid-hook: treat as "stop", finish() runs at the call site
    return step.value || this.shouldHaltBeforeNextTurn();
  }

  /** Follow-up messages take priority over continuation messages; empty from both means stop. */
  private async pollBetweenTurnGroups(): Promise<AgentMessage[] | "aborted"> {
    const followUp = await pollStep(
      pollMessages(this.config.getFollowUpMessages, this.signal),
      this.signal,
    );
    if (!followUp.ran) return "aborted";
    if (followUp.value.length > 0) return followUp.value;

    if (this.shouldHaltBeforeNextTurn()) return [];
    if (!this.lastTurn) return [];
    const continuation = await pollStep(
      resolveWithAbort(
        this.config.getContinuationMessages?.(this.lastTurn, this.signal) ?? [],
        this.signal,
      ),
      this.signal,
    );
    if (!continuation.ran) return "aborted";
    return continuation.value;
  }

  /** Streams one assistant response, emitting message_start/update/end as it goes. */
  private async requestTurn(): Promise<AssistantMessage> {
    let partial: AssistantMessage | null = null;
    let partialIsLive = false;
    const context = this.context;
    const signal = this.signal;
    const emit = this.emit;
    const config = this.config;

    const settleAborted = async () => {
      const finalMessage = buildAbortedMessage(config, partial);
      if (partialIsLive) context.messages[context.messages.length - 1] = finalMessage;
      else {
        context.messages.push(finalMessage);
        await emit({ type: "message_start", message: { ...finalMessage } });
      }
      await emit({ type: "message_end", message: finalMessage });
      return finalMessage;
    };

    try {
      checkAborted(signal);
      let messages = context.messages;
      if (config.transformContext)
        messages = await resolveWithAbort(config.transformContext(messages, signal), signal);
      const llmMessages = await resolveWithAbort(config.convertToLlm(messages), signal);

      if (!this.streamFn)
        throw new Error("streamFn is required (bind a Models instance's streamSimple to it)");
      const llmContext: Context = {
        systemPrompt: config.getSystemPrompt?.() ?? context.systemPrompt,
        messages: llmMessages,
        tools: context.tools,
      };
      const response = await resolveWithAbort(
        this.streamFn(config.model, llmContext, { ...config, signal }),
        signal,
      );
      const iterator = response[Symbol.asyncIterator]();
      const stopIterating = () => void Promise.resolve(iterator.return?.()).catch(() => undefined);

      const commitFinal = async (finalMessage: AssistantMessage) => {
        if (partialIsLive) context.messages[context.messages.length - 1] = finalMessage;
        else {
          context.messages.push(finalMessage);
          await emit({ type: "message_start", message: { ...finalMessage } });
        }
        await emit({ type: "message_end", message: finalMessage });
      };

      while (true) {
        const next = await withAbort<IteratorResult<AssistantMessageEvent>>(
          iterator.next(),
          signal,
          stopIterating,
        );
        if (next.done) break;
        const event = next.value;

        if (event.type === "start") {
          partial = event.partial;
          context.messages.push(partial);
          partialIsLive = true;
          await emit({ type: "message_start", message: { ...partial } });
          continue;
        }
        if (event.type === "done" || event.type === "error") {
          let finalMessage = event.type === "done" ? event.message : event.error;
          try {
            finalMessage = await resolveWithAbort(response.result(), signal);
          } catch (error) {
            if (!signal?.aborted || !wasAbortError(error)) throw error;
          }
          await commitFinal(finalMessage);
          return finalMessage;
        }
        if (partial) {
          partial = event.partial;
          context.messages[context.messages.length - 1] = partial;
          await emit({
            type: "message_update",
            assistantMessageEvent: event,
            message: { ...partial },
          });
        }
      }

      const finalMessage = await resolveWithAbort(response.result(), signal);
      await commitFinal(finalMessage);
      return finalMessage;
    } catch (error) {
      if (signal?.aborted && wasAbortError(error)) return settleAborted();
      throw error;
    }
  }

  private async runRequestedTools(
    assistantMessage: AssistantMessage,
  ): Promise<{ toolResults: ToolResultMessage[]; everyCallRequestedStop: boolean }> {
    const calls = assistantMessage.content.filter((c) => c.type === "toolCall");
    if (calls.length === 0) return { toolResults: [], everyCallRequestedStop: false };

    const runs = calls.map(
      (call) => new ToolCallRun(call, assistantMessage, this.context, this.config, this.signal),
    );
    const forceSequential =
      this.config.toolExecution === "sequential" ||
      calls.some(
        (call) =>
          this.context.tools?.find((t) => t.name === call.name)?.executionMode === "sequential",
      );

    if (forceSequential) {
      for (const call of runs) {
        if (this.signal?.aborted) break;
        await this.emitStart(call);
        if (await call.resolve()) await call.invokeAndFinalize(this.emit);
        await this.emitEnd(call);
        if (this.signal?.aborted) break;
      }
    } else {
      const needInvocation: ToolCallRun[] = [];
      for (const call of runs) {
        await this.emitStart(call);
        if (await call.resolve()) needInvocation.push(call);
        else await this.emitEnd(call); // settled immediately by resolve(): not found / blocked / prepare threw
      }
      await Promise.all(
        needInvocation.map(async (call) => {
          await call.invokeAndFinalize(this.emit);
          await this.emitEnd(call);
        }),
      );
    }

    // Sequential mode's abort check above can `break` before every call was ever started (its
    // `resolve()`/`invokeAndFinalize()` never ran, so `call.result` is still undefined) -- those
    // must not get a synthesized "never settled" result message; the original had no result for
    // them either, since it built messages incrementally inside the same loop that could break.
    const settled = runs.filter((call) => call.result !== undefined);
    const toolResults: ToolResultMessage[] = [];
    for (const call of settled) {
      const message = call.toResultMessage();
      await this.emit({ type: "message_start", message });
      await this.emit({ type: "message_end", message });
      toolResults.push(message);
    }
    return {
      toolResults,
      everyCallRequestedStop:
        settled.length > 0 && settled.every((call) => call.result?.terminate === true),
    };
  }

  private emitStart(call: ToolCallRun): Promise<void> | void {
    return this.emit({
      type: "tool_execution_start",
      toolCallId: call.toolCall.id,
      toolName: call.toolCall.name,
      args: call.toolCall.arguments,
    });
  }

  private emitEnd(call: ToolCallRun): Promise<void> | void {
    return this.emit({
      type: "tool_execution_end",
      toolCallId: call.toolCall.id,
      toolName: call.toolCall.name,
      result: call.result,
      isError: call.isError,
    });
  }
}

function errorResult(message: string): AgentToolResult<any> {
  return { content: [{ type: "text", text: message }], details: {} };
}

/**
 * One tool call's full lifecycle, in two phases:
 * - `resolve()` finds the tool, validates arguments, and runs `beforeToolCall`. If the tool is
 *   missing, arguments are invalid, or the hook blocks it, the call is fully settled right here
 *   and `resolve()` returns false -- the caller must not call `invokeAndFinalize()`.
 * - `invokeAndFinalize()` (only when `resolve()` returned true) actually runs the tool, streams
 *   its partial-result updates as events, and then runs `afterToolCall`.
 *
 * Splitting the lifecycle this way (rather than three free functions returning a chain of
 * discriminated-union outcomes) is what lets both the sequential and parallel batch runners share
 * one code path: sequential awaits each call's two phases back to back; parallel resolves every
 * call first (so ordering/preflight stays deterministic) and only fans the invoke phase out
 * concurrently.
 */
class ToolCallRun {
  result?: AgentToolResult<any>;
  isError = false;
  private tool?: AgentTool<any>;
  private validatedArgs?: unknown;

  constructor(
    readonly toolCall: AgentToolCall,
    private readonly assistantMessage: AssistantMessage,
    private readonly context: AgentContext,
    private readonly config: AgentLoopConfig,
    private readonly signal: AbortSignal | undefined,
  ) {}

  async resolve(): Promise<boolean> {
    const tool = this.context.tools?.find((t) => t.name === this.toolCall.name);
    if (!tool) return this.settleNow(`Tool ${this.toolCall.name} not found`);

    try {
      const shimmed = tool.prepareArguments
        ? tool.prepareArguments(this.toolCall.arguments)
        : this.toolCall.arguments;
      const args = validateToolArguments(
        tool,
        shimmed === this.toolCall.arguments
          ? this.toolCall
          : { ...this.toolCall, arguments: shimmed as Record<string, any> },
      );
      if (this.config.beforeToolCall) {
        const gate = await resolveWithAbort(
          this.config.beforeToolCall(
            {
              assistantMessage: this.assistantMessage,
              toolCall: this.toolCall,
              args,
              context: this.context,
            },
            this.signal,
          ),
          this.signal,
        );
        if (gate?.block) return this.settleNow(gate.reason || "Tool execution was blocked");
      }
      this.tool = tool;
      this.validatedArgs = args;
      return true;
    } catch (error) {
      return this.settleNow(error instanceof Error ? error.message : String(error));
    }
  }

  async invokeAndFinalize(emit: EmitAgentEvent): Promise<void> {
    const tool = this.tool;
    if (!tool) throw new Error("invokeAndFinalize() called before a successful resolve()");
    const args = this.validatedArgs;

    const pendingUpdateEmits: Promise<void>[] = [];
    let acceptingUpdates = true;
    let result: AgentToolResult<any>;
    let isError: boolean;
    try {
      checkAborted(this.signal);
      result = await withAbort(
        tool.execute(this.toolCall.id, args as never, this.signal, (partial) => {
          if (!acceptingUpdates || this.signal?.aborted) return;
          pendingUpdateEmits.push(
            Promise.resolve(
              emit({
                type: "tool_execution_update",
                toolCallId: this.toolCall.id,
                toolName: this.toolCall.name,
                args: this.toolCall.arguments,
                partialResult: partial,
              }),
            ),
          );
        }),
        this.signal,
      );
      isError = false;
      acceptingUpdates = false;
      await withAbort(
        Promise.all(pendingUpdateEmits).then(() => undefined),
        this.signal,
      );
    } catch (error) {
      acceptingUpdates = false;
      await withAbort(
        Promise.all(pendingUpdateEmits).then(() => undefined),
        this.signal,
      ).catch(() => undefined);
      result = errorResult(
        this.signal?.aborted
          ? "Tool execution aborted"
          : error instanceof Error
            ? error.message
            : String(error),
      );
      isError = true;
    }

    if (this.config.afterToolCall) {
      try {
        const override = await resolveWithAbort(
          this.config.afterToolCall(
            {
              assistantMessage: this.assistantMessage,
              toolCall: this.toolCall,
              args,
              result,
              isError,
              context: this.context,
            },
            this.signal,
          ),
          this.signal,
        );
        if (override) {
          result = {
            content: override.content ?? result.content,
            details: override.details ?? result.details,
            terminate: override.terminate ?? result.terminate,
          };
          isError = override.isError ?? isError;
        }
      } catch (error) {
        result = errorResult(error instanceof Error ? error.message : String(error));
        isError = true;
      }
    }

    this.result = result;
    this.isError = isError;
  }

  toResultMessage(): ToolResultMessage {
    const result = this.result ?? errorResult("tool call never settled");
    return {
      role: "toolResult",
      toolCallId: this.toolCall.id,
      toolName: this.toolCall.name,
      content: result.content,
      details: result.details,
      isError: this.isError,
      timestamp: Date.now(),
    };
  }

  private settleNow(message: string): false {
    this.result = errorResult(message);
    this.isError = true;
    return false;
  }
}
