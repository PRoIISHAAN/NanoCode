/**
 * `Session` wraps the functional loop in agent-loop.ts with mutable state (message history,
 * streaming status, pending tool calls) and an event-subscription API, so a caller can hold one
 * long-lived object, call `prompt()`/`continue()` on it, and read `session.state` at any time.
 *
 * Solves the same problem prime-agent's `Agent` class solves (something has to own the mutable
 * state agent-loop.ts's pure functions don't carry between calls, and something has to turn
 * `steer()`/`followUp()` calls into the poll hooks agent-loop.ts expects) -- independently
 * implemented with two structural differences worth calling out: the ~15 loop-configuration
 * hooks (beforeToolCall, afterToolCall, shouldStopAfterTurn, ...) live in one private `hooks`
 * object built once at construction rather than as separately-declared, individually mutable
 * public fields; and the steering/follow-up queues are two small polymorphic classes
 * (`DrainAllQueue`/`DrainOneQueue`) selected by mode, rather than one class with an `if (mode ===
 * "all")` branch inside `drain()`.
 */
import {
  type AssistantMessage,
  createAssistantMessageDiagnostic,
  type ImageContent,
  type Message,
  type Model,
  type MutableModels,
  type SimpleStreamOptions,
  type TextContent,
  type ThinkingBudgets,
  type Transport,
} from "@nanocode/ai";
import { continueRun, runPrompt } from "./agent-loop.ts";
import { CompactionEngine } from "./session/compaction.ts";
import { nextEntryId, type TaskState } from "./session/entries.ts";
import type { SessionLog } from "./session/log.ts";
import type {
  AfterToolCallContext,
  AfterToolCallResult,
  AgentContext,
  AgentEvent,
  AgentLoopConfig,
  AgentMessage,
  AgentState,
  AgentTool,
  BeforeToolCallContext,
  BeforeToolCallResult,
  GetContinuationMessagesContext,
  ShouldStopAfterTurnContext,
  StreamFn,
  ToolExecutionMode,
} from "./types.ts";

function defaultConvertToLlm(messages: AgentMessage[]): Message[] {
  return messages.filter(
    (m) => m.role === "user" || m.role === "assistant" || m.role === "toolResult",
  );
}

const ZERO_USAGE = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 0,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

const PLACEHOLDER_MODEL = {
  id: "unknown",
  name: "unknown",
  api: "unknown",
  provider: "unknown",
  baseUrl: "",
  reasoning: false,
  input: [],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 0,
  maxTokens: 0,
} satisfies Model<any>;

type QueueDrainMode = "all" | "one-at-a-time";

interface SessionHooks {
  convertToLlm: (messages: AgentMessage[]) => Message[] | Promise<Message[]>;
  transformContext?: (messages: AgentMessage[], signal?: AbortSignal) => Promise<AgentMessage[]>;
  onPayload?: SimpleStreamOptions["onPayload"];
  onResponse?: SimpleStreamOptions["onResponse"];
  beforeToolCall?: (
    context: BeforeToolCallContext,
    signal?: AbortSignal,
  ) => Promise<BeforeToolCallResult | undefined>;
  afterToolCall?: (
    context: AfterToolCallContext,
    signal?: AbortSignal,
  ) => Promise<AfterToolCallResult | undefined>;
  shouldStopAfterTurn?: (context: ShouldStopAfterTurnContext) => boolean | Promise<boolean>;
  shouldStopBeforeTurn?: () => boolean;
  getContinuationMessages?: (
    context: GetContinuationMessagesContext,
    signal?: AbortSignal,
  ) => Promise<AgentMessage[]>;
}

/** When a `CompactionEngine` is active, its compaction/task-state transform runs first, feeding
 * its output into any caller-supplied `transformContext` -- rather than the two being mutually
 * exclusive -- so a caller can still layer its own context transform on top of tiered memory. */
function composeTransformContext(
  options: SessionOptions,
  compactionEngine: CompactionEngine | undefined,
): SessionHooks["transformContext"] {
  if (!compactionEngine) return options.transformContext;
  return async (messages, signal) => {
    const afterCompaction = await compactionEngine.transform(messages, signal);
    return options.transformContext
      ? options.transformContext(afterCompaction, signal)
      : afterCompaction;
  };
}

function buildHooks(options: SessionOptions, compactionEngine?: CompactionEngine): SessionHooks {
  return {
    convertToLlm: options.convertToLlm ?? defaultConvertToLlm,
    transformContext: composeTransformContext(options, compactionEngine),
    onPayload: options.onPayload,
    onResponse: options.onResponse,
    beforeToolCall: options.beforeToolCall,
    afterToolCall: options.afterToolCall,
    shouldStopAfterTurn: options.shouldStopAfterTurn,
    shouldStopBeforeTurn: options.shouldStopBeforeTurn,
    getContinuationMessages: options.getContinuationMessages,
  };
}

/** Backing store for `Session.state`: the read-only `AgentState` view is these same fields. */
type MutableState = Omit<
  AgentState,
  "isStreaming" | "streamingMessage" | "pendingToolCalls" | "errorMessage"
> & {
  isStreaming: boolean;
  streamingMessage?: AgentMessage;
  pendingToolCalls: Set<string>;
  errorMessage?: string;
};

function makeMutableState(
  initial?: Partial<
    Omit<AgentState, "pendingToolCalls" | "isStreaming" | "streamingMessage" | "errorMessage">
  >,
): MutableState {
  let tools = initial?.tools?.slice() ?? [];
  let messages = initial?.messages?.slice() ?? [];
  return {
    systemPrompt: initial?.systemPrompt ?? "",
    model: initial?.model ?? PLACEHOLDER_MODEL,
    thinkingLevel: initial?.thinkingLevel ?? "off",
    get tools() {
      return tools;
    },
    set tools(next: AgentTool<any>[]) {
      tools = next.slice();
    },
    get messages() {
      return messages;
    },
    set messages(next: AgentMessage[]) {
      messages = next.slice();
    },
    isStreaming: false,
    streamingMessage: undefined,
    pendingToolCalls: new Set<string>(),
    errorMessage: undefined,
  };
}

/**
 * M3's tiered memory architecture (decisions/0007-tiered-memory-architecture.md), opt-in via
 * `SessionOptions.memory`. When present, `Session`:
 * - persists every completed message to `sessionLog` (tier 4's durability substrate),
 * - re-injects the latest task state (tier 2) into context every turn via `getTaskState`, and
 * - compacts tiers 3/4 automatically at a token threshold, via a `CompactionEngine` built from
 *   `models`/`compaction` and wired in as (part of) `transformContext`.
 * `getTaskState` and `sessionLog`'s host_request handlers are constructed by the caller (see
 * packages/cli/src/index.ts) and shared with the kernel, since both the Python-side builtins and
 * this session need to read/write the same underlying store.
 */
export interface SessionMemoryOptions {
  sessionLog: SessionLog;
  models: MutableModels;
  getTaskState: () => TaskState | undefined;
  compaction?: {
    triggerFraction?: number;
    keepRecentTokens?: number;
    archiveMinChars?: number;
  };
}

export interface SessionOptions {
  initialState?: Partial<
    Omit<AgentState, "pendingToolCalls" | "isStreaming" | "streamingMessage" | "errorMessage">
  >;
  memory?: SessionMemoryOptions;
  /** Bind a Models instance's `streamSimple` method to this (see @nanocode/ai). Required. */
  streamFn: StreamFn;
  convertToLlm?: (messages: AgentMessage[]) => Message[] | Promise<Message[]>;
  transformContext?: (messages: AgentMessage[], signal?: AbortSignal) => Promise<AgentMessage[]>;
  onPayload?: SimpleStreamOptions["onPayload"];
  onResponse?: SimpleStreamOptions["onResponse"];
  beforeToolCall?: (
    context: BeforeToolCallContext,
    signal?: AbortSignal,
  ) => Promise<BeforeToolCallResult | undefined>;
  afterToolCall?: (
    context: AfterToolCallContext,
    signal?: AbortSignal,
  ) => Promise<AfterToolCallResult | undefined>;
  shouldStopAfterTurn?: (context: ShouldStopAfterTurnContext) => boolean | Promise<boolean>;
  shouldStopBeforeTurn?: () => boolean;
  getContinuationMessages?: (
    context: GetContinuationMessagesContext,
    signal?: AbortSignal,
  ) => Promise<AgentMessage[]>;
  steeringMode?: QueueDrainMode;
  followUpMode?: QueueDrainMode;
  sessionId?: string;
  thinkingBudgets?: ThinkingBudgets;
  transport?: Transport;
  maxRetryDelayMs?: number;
  toolExecution?: ToolExecutionMode;
}

/** A FIFO of message batches. Subclasses decide whether `drain()` takes everything or one batch. */
abstract class MessageQueue {
  protected batches: AgentMessage[][] = [];

  enqueue(message: AgentMessage | AgentMessage[]): void {
    const batch = Array.isArray(message) ? message.slice() : [message];
    if (batch.length > 0) this.batches.push(batch);
  }

  hasQueued(): boolean {
    return this.batches.length > 0;
  }

  clear(): void {
    this.batches = [];
  }

  removeMatching(predicate: (message: AgentMessage) => boolean): AgentMessage[] {
    const removed: AgentMessage[] = [];
    const kept: AgentMessage[][] = [];
    for (const batch of this.batches) {
      if (batch.some(predicate)) removed.push(...batch);
      else kept.push(batch);
    }
    this.batches = kept;
    return removed;
  }

  /** Used when switching drain mode at runtime, to carry over whatever's already queued. */
  adopt(batches: AgentMessage[][]): void {
    this.batches = batches;
  }

  /** The inverse of `adopt()`: hands over every queued batch (structure intact) and empties out. */
  releaseBatches(): AgentMessage[][] {
    const batches = this.batches;
    this.batches = [];
    return batches;
  }

  abstract drain(): AgentMessage[];
}

class DrainAllQueue extends MessageQueue {
  drain(): AgentMessage[] {
    const all = this.batches.flat();
    this.batches = [];
    return all;
  }
}

class DrainOneQueue extends MessageQueue {
  drain(): AgentMessage[] {
    const [first, ...rest] = this.batches;
    if (!first) return [];
    this.batches = rest;
    return first;
  }
}

function newQueue(mode: QueueDrainMode): MessageQueue {
  return mode === "all" ? new DrainAllQueue() : new DrainOneQueue();
}

/**
 * Everything one `prompt()`/`continue()` invocation needs to track while it's in flight: an abort
 * controller, and a promise that settles once the run (including its `agent_end` listeners) is
 * fully done. Wrapping this in a class rather than a plain `{done, finish, controller}` record
 * built inline avoids re-deriving the "resolver captured from a Promise executor" pattern at each
 * call site.
 */
class ActiveRun {
  readonly controller = new AbortController();
  readonly done: Promise<void>;
  private settleDone!: () => void;

  constructor() {
    this.done = new Promise((resolve) => {
      this.settleDone = resolve;
    });
  }

  get signal(): AbortSignal {
    return this.controller.signal;
  }

  finish(): void {
    this.settleDone();
  }
}

export type SessionResumeErrorCode = "busy" | "nothing-to-resume";

/** Thrown by `Session.continue()` when there's no valid precondition to resume from. */
export class SessionResumeError extends Error {
  constructor(
    readonly code: SessionResumeErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "SessionResumeError";
  }
}

export class Session {
  private mutableState: MutableState;
  private readonly hooks: SessionHooks;
  private readonly listeners = new Set<
    (event: AgentEvent, signal: AbortSignal) => Promise<void> | void
  >();
  private steeringQueue: MessageQueue;
  private followUpQueue: MessageQueue;
  private activeRun?: ActiveRun;
  private readonly sessionLog?: SessionLog;
  private readonly compactionEngine?: CompactionEngine;

  public streamFn: StreamFn;
  public toolExecution: ToolExecutionMode;
  public transport: Transport;
  public sessionId?: string;
  public thinkingBudgets?: ThinkingBudgets;
  public maxRetryDelayMs?: number;

  constructor(options: SessionOptions) {
    // Conversation state and behavior hooks first...
    this.mutableState = makeMutableState(options.initialState);
    const compactionEngine = options.memory
      ? new CompactionEngine({
          models: options.memory.models,
          getModel: () => this.mutableState.model,
          sessionLog: options.memory.sessionLog,
          getTaskState: options.memory.getTaskState,
          ...options.memory.compaction,
        })
      : undefined;
    this.sessionLog = options.memory?.sessionLog;
    this.compactionEngine = compactionEngine;
    this.hooks = buildHooks(options, compactionEngine);
    this.steeringQueue = newQueue(options.steeringMode ?? "one-at-a-time");
    this.followUpQueue = newQueue(options.followUpMode ?? "one-at-a-time");
    // ...then the provider/runtime knobs a caller can still reach in and adjust after construction.
    this.streamFn = options.streamFn;
    this.toolExecution = options.toolExecution ?? "parallel";
    this.transport = options.transport ?? "auto";
    this.sessionId = options.sessionId;
    this.thinkingBudgets = options.thinkingBudgets;
    this.maxRetryDelayMs = options.maxRetryDelayMs;
  }

  /** Awaited in subscription order; also receives the current run's abort signal. */
  subscribe(
    listener: (event: AgentEvent, signal: AbortSignal) => Promise<void> | void,
  ): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** Assigning `.tools`/`.messages` on this copies the array you assigned. */
  get state(): AgentState {
    return this.mutableState;
  }

  set steeringMode(mode: QueueDrainMode) {
    this.steeringQueue = this.swapQueueMode(this.steeringQueue, mode);
  }

  set followUpMode(mode: QueueDrainMode) {
    this.followUpQueue = this.swapQueueMode(this.followUpQueue, mode);
  }

  private swapQueueMode(current: MessageQueue, mode: QueueDrainMode): MessageQueue {
    const isAlreadyThatMode =
      mode === "all" ? current instanceof DrainAllQueue : current instanceof DrainOneQueue;
    if (isAlreadyThatMode) return current;
    const next = newQueue(mode);
    next.adopt(current.releaseBatches());
    return next;
  }

  /** Queues a message batch to inject once the current turn's tool calls finish. */
  steer(message: AgentMessage | AgentMessage[]): void {
    this.steeringQueue.enqueue(message);
  }

  /** Queues a message batch to run only once the session would otherwise stop. */
  followUp(message: AgentMessage | AgentMessage[]): void {
    this.followUpQueue.enqueue(message);
  }

  clearSteeringQueue(): void {
    this.steeringQueue.clear();
  }

  clearFollowUpQueue(): void {
    this.followUpQueue.clear();
  }

  clearAllQueues(): void {
    this.clearSteeringQueue();
    this.clearFollowUpQueue();
  }

  removeQueuedMessages(predicate: (message: AgentMessage) => boolean): AgentMessage[] {
    return [
      ...this.steeringQueue.removeMatching(predicate),
      ...this.followUpQueue.removeMatching(predicate),
    ];
  }

  hasQueuedMessages(): boolean {
    return this.steeringQueue.hasQueued() || this.followUpQueue.hasQueued();
  }

  get signal(): AbortSignal | undefined {
    return this.activeRun?.signal;
  }

  abort(): void {
    this.activeRun?.controller.abort();
  }

  /** Resolves once the current run and all awaited `agent_end` listeners have finished. */
  waitForIdle(): Promise<void> {
    return this.activeRun?.done ?? Promise.resolve();
  }

  reset(): void {
    this.mutableState.messages = [];
    this.mutableState.isStreaming = false;
    this.mutableState.streamingMessage = undefined;
    this.mutableState.pendingToolCalls = new Set<string>();
    this.mutableState.errorMessage = undefined;
    this.clearFollowUpQueue();
    this.clearSteeringQueue();
  }

  /**
   * Forces tiered-memory compaction right now (see `CompactionEngine.forceCompact`), mutating
   * `state.messages` to the compacted result -- unlike the automatic per-turn compaction wired
   * into `transformContext`, which only ever shrinks the ephemeral payload sent to the model for
   * one request and never touches this array. Returns `false` (a no-op) if this session has no
   * `memory` configured, or if there's no safe cut point yet (e.g. the whole history is still one
   * recent, uncompactable turn).
   */
  async compact(): Promise<boolean> {
    if (!this.compactionEngine) return false;
    const compacted = await this.compactionEngine.forceCompact(this.mutableState.messages);
    if (!compacted) return false;
    this.mutableState.messages = compacted;
    return true;
  }

  async prompt(message: AgentMessage | AgentMessage[]): Promise<void>;
  async prompt(input: string, images?: ImageContent[]): Promise<void>;
  async prompt(
    input: string | AgentMessage | AgentMessage[],
    images?: ImageContent[],
  ): Promise<void> {
    if (this.activeRun) {
      throw new Error(
        "session is already processing a prompt -- use steer()/followUp() or wait for completion",
      );
    }
    await this.executeRun({ kind: "prompt", messages: this.toMessages(input, images) });
  }

  /** The last message must already convert to a user or tool-result message. */
  async continue(): Promise<void> {
    if (this.activeRun) {
      throw new SessionResumeError(
        "busy",
        "session is already processing -- wait for completion before continuing",
      );
    }

    const runQueuedInstead = (): Promise<void> | undefined => {
      const steering = this.steeringQueue.drain();
      if (steering.length > 0) {
        return this.executeRun({
          kind: "prompt",
          messages: steering,
          skipInitialSteeringPoll: true,
        });
      }
      const followUps = this.followUpQueue.drain();
      if (followUps.length > 0) return this.executeRun({ kind: "prompt", messages: followUps });
      return undefined;
    };

    const lastMessage = this.mutableState.messages.at(-1);
    if (
      !lastMessage ||
      lastMessage.role === "assistant" ||
      (lastMessage.role as string) === "custom"
    ) {
      const queued = runQueuedInstead();
      if (queued) return queued;
      if (!lastMessage)
        throw new SessionResumeError("nothing-to-resume", "no messages to continue from");
      if (lastMessage.role === "assistant")
        throw new SessionResumeError(
          "nothing-to-resume",
          "cannot continue from message role: assistant",
        );
    }

    await this.executeRun({ kind: "continuation" });
  }

  private toMessages(
    input: string | AgentMessage | AgentMessage[],
    images?: ImageContent[],
  ): AgentMessage[] {
    if (Array.isArray(input)) return input;
    if (typeof input !== "string") return [input];
    const content: Array<TextContent | ImageContent> = [{ type: "text", text: input }];
    if (images && images.length > 0) content.push(...images);
    return [{ role: "user", content, timestamp: Date.now() }];
  }

  /**
   * The one entry point both `prompt()` and `continue()` funnel through, discriminated by `kind`
   * rather than living as two separately-declared methods that each wrap `withRunLifecycle` the
   * same way -- the only real difference between them is which agent-loop entry function runs.
   */
  private async executeRun(
    request:
      | { kind: "prompt"; messages: AgentMessage[]; skipInitialSteeringPoll?: boolean }
      | { kind: "continuation" },
  ): Promise<void> {
    await this.withRunLifecycle(async (signal) => {
      const emit = (event: AgentEvent) => this.reduceEvent(event);
      if (request.kind === "prompt") {
        const config = this.buildLoopConfig({
          skipInitialSteeringPoll: request.skipInitialSteeringPoll,
        });
        await runPrompt(
          request.messages,
          this.snapshotContext(),
          config,
          emit,
          signal,
          this.streamFn,
        );
      } else {
        await continueRun(
          this.snapshotContext(),
          this.buildLoopConfig(),
          emit,
          signal,
          this.streamFn,
        );
      }
    });
  }

  private snapshotContext(): AgentContext {
    return {
      systemPrompt: this.mutableState.systemPrompt,
      messages: this.mutableState.messages.slice(),
      tools: this.mutableState.tools.slice(),
    };
  }

  /** Builds one turn's worth of loop config. Grouped by concern rather than any fixed field
   * order: request shaping, then the message pipeline, then tool-call hooks, then the three
   * message-queue polls (steering/follow-up/continuation), in the priority order the loop itself
   * checks them. */
  private buildLoopConfig(options: { skipInitialSteeringPoll?: boolean } = {}): AgentLoopConfig {
    const hooks = this.hooks;

    const requestShape = {
      model: this.mutableState.model,
      // pi-ai's SimpleStreamOptions.reasoning is a ThinkingLevel *without* "off" (a separate
      // ModelThinkingLevel adds it) -- "off" means "don't request reasoning," which this field
      // expresses by being absent, not by carrying the literal string "off".
      reasoning:
        this.mutableState.thinkingLevel === "off" ? undefined : this.mutableState.thinkingLevel,
      transport: this.transport,
      sessionId: this.sessionId,
      thinkingBudgets: this.thinkingBudgets,
      maxRetryDelayMs: this.maxRetryDelayMs,
      onPayload: hooks.onPayload,
      onResponse: hooks.onResponse,
    };

    const messagePipeline = {
      convertToLlm: hooks.convertToLlm,
      transformContext: hooks.transformContext,
      getSystemPrompt: () => this.mutableState.systemPrompt,
    };

    const toolHooks = {
      toolExecution: this.toolExecution,
      beforeToolCall: hooks.beforeToolCall,
      afterToolCall: hooks.afterToolCall,
    };

    const stopHooks = {
      shouldStopAfterTurn: async (context: ShouldStopAfterTurnContext) =>
        hooks.shouldStopAfterTurn?.(context) ?? false,
      shouldStopBeforeTurn: () => hooks.shouldStopBeforeTurn?.() ?? false,
    };

    let steeringPollArmed = options.skipInitialSteeringPoll !== true;
    const queuePolls = {
      getSteeringMessages: async () => {
        if (!steeringPollArmed) {
          steeringPollArmed = true;
          return [];
        }
        return this.steeringQueue.drain();
      },
      getFollowUpMessages: async () => this.followUpQueue.drain(),
      getContinuationMessages: async (
        context: GetContinuationMessagesContext,
        signal?: AbortSignal,
      ) => hooks.getContinuationMessages?.(context, signal) ?? [],
    };

    return { ...requestShape, ...messagePipeline, ...toolHooks, ...stopHooks, ...queuePolls };
  }

  private async withRunLifecycle(executor: (signal: AbortSignal) => Promise<void>): Promise<void> {
    if (this.activeRun) throw new Error("session is already processing");

    const run = new ActiveRun();
    this.activeRun = run;
    this.mutableState.isStreaming = true;
    this.mutableState.streamingMessage = undefined;
    this.mutableState.errorMessage = undefined;

    try {
      await executor(run.signal);
    } catch (error) {
      await this.reportRunFailure(error, run.signal.aborted);
    } finally {
      this.endRun();
    }
  }

  /** Composes a synthetic failure message from three independent parts -- what a fixed empty
   * turn always looks like, which model/provider it's attributed to, and what actually went
   * wrong -- rather than one flat object literal. */
  private buildFailureMessage(error: unknown, aborted: boolean): AssistantMessage {
    const emptyTurn = {
      role: "assistant" as const,
      content: [{ type: "text" as const, text: "" }],
      timestamp: Date.now(),
    };
    const attribution = {
      api: this.mutableState.model.api,
      provider: this.mutableState.model.provider,
      model: this.mutableState.model.id,
      usage: ZERO_USAGE,
    };
    const failure = {
      stopReason: aborted ? ("aborted" as const) : ("error" as const),
      errorMessage: error instanceof Error ? error.message : String(error),
      diagnostics: aborted
        ? undefined
        : [
            createAssistantMessageDiagnostic("session_lifecycle_failure", error, {
              source: "with_run_lifecycle",
            }),
          ],
    };
    return { ...emptyTurn, ...attribution, ...failure };
  }

  private async reportRunFailure(error: unknown, aborted: boolean): Promise<void> {
    const failureMessage = this.buildFailureMessage(error, aborted);
    this.mutableState.errorMessage = failureMessage.errorMessage;
    const lifecycleEvents: AgentEvent[] = [
      { type: "message_start", message: failureMessage },
      { type: "message_end", message: failureMessage },
      { type: "agent_end", messages: [failureMessage] },
    ];
    for (const lifecycleEvent of lifecycleEvents) {
      await this.reduceEvent(lifecycleEvent).catch(() => undefined);
    }
  }

  private endRun(): void {
    this.mutableState.isStreaming = false;
    this.mutableState.streamingMessage = undefined;
    this.mutableState.pendingToolCalls = new Set<string>();
    this.activeRun?.finish();
    this.activeRun = undefined;
  }

  /** Folds one loop event into mutable state, persists completed messages (tiered memory,
   * decisions/0007), then awaits every subscriber in order. */
  private async reduceEvent(event: AgentEvent): Promise<void> {
    this.applyToState(event);
    if (event.type === "message_end" && this.sessionLog) {
      await this.sessionLog.append({
        id: nextEntryId(),
        timestamp: Date.now(),
        kind: "message",
        message: event.message,
      });
    }
    const signal = this.activeRun?.signal;
    if (!signal) throw new Error("event reducer invoked outside an active run");
    for (const listener of this.listeners) {
      await listener(event, signal);
    }
  }

  /** Dispatches by what actually changes (the streamed message, the transcript, the pending-call
   * set, or the last error) rather than by the event's own case label -- `message_start` and
   * `message_update` both just replace the streaming message, and both tool-execution events
   * share one set-mutation helper instead of each rebuilding a `Set` independently. */
  private applyToState(event: AgentEvent): void {
    switch (event.type) {
      case "message_start":
      case "message_update":
        this.mutableState.streamingMessage = event.message;
        return;
      case "message_end":
        this.mutableState.streamingMessage = undefined;
        this.mutableState.messages.push(event.message);
        return;
      case "tool_execution_start":
        this.markToolCall(event.toolCallId, "pending");
        return;
      case "tool_execution_end":
        this.markToolCall(event.toolCallId, "settled");
        return;
      case "turn_end":
        if (event.message.role === "assistant" && event.message.errorMessage) {
          this.mutableState.errorMessage = event.message.errorMessage;
        }
        return;
      case "agent_end":
        this.mutableState.streamingMessage = undefined;
        return;
    }
  }

  private markToolCall(toolCallId: string, as: "pending" | "settled"): void {
    const next = new Set(this.mutableState.pendingToolCalls);
    if (as === "pending") next.add(toolCallId);
    else next.delete(toolCallId);
    this.mutableState.pendingToolCalls = next;
  }
}
