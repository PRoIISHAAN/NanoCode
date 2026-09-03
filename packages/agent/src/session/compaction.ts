// Tiers 2-4 of decisions/0007-tiered-memory-architecture.md, implemented as one `transformContext`
// hook (see types.ts's `AgentLoopConfig.transformContext`): every turn, before the LLM sees the
// conversation, this (a) prepends the current task state (tier 2) verbatim, then (b) compacts
// tiers 3/4 if the estimated token count is over threshold. Tier 1 (the system prompt) is never
// touched here -- `transformContext` only ever receives and returns `messages`, never
// `AgentContext.systemPrompt`, which is the structural form of the invariant added to
// context-graph.json ("the system prompt must never appear in any compacted or archived range").
import type { Api, Model, MutableModels } from "@nanocode/ai";
import type { AgentMessage } from "../types.ts";
import type { TaskState } from "./entries.ts";
import { nextEntryId } from "./entries.ts";
import type { SessionLog } from "./log.ts";

export interface CompactionOptions {
  models: MutableModels;
  /** Read live on every call rather than captured once -- `Session.state.model` is a plain
   * writable field a caller can reassign mid-session (unlike `.tools`/`.messages`, which are
   * copy-on-write accessors), so a fixed snapshot here could silently desync the trigger
   * threshold and the summarization call's model from whatever the loop is actually using. */
  getModel: () => Model<Api>;
  sessionLog: SessionLog;
  /** Fraction of `model.contextWindow` at which compaction triggers. Default 0.7 -- deliberately
   * well below the 0.85-0.95 range production agents use for the LLM's *own* context, since our
   * char/4 token estimate (see `estimateTokens`) is coarse and we'd rather compact a bit early
   * than risk a request rejected as over the real window. */
  triggerFraction?: number;
  /** How many tokens' worth of the most recent messages to always keep verbatim (tier 3). */
  keepRecentTokens?: number;
  /** A `toolResult` message's content longer than this (chars) gets archived (tier 4) instead of
   * being summarized away, once it falls inside a compacted range. */
  archiveMinChars?: number;
  getTaskState: () => TaskState | undefined;
}

const DEFAULT_TRIGGER_FRACTION = 0.7;
const DEFAULT_KEEP_RECENT_TOKENS = 8_000;
const DEFAULT_ARCHIVE_MIN_CHARS = 2_000;

const SUMMARIZE_SYSTEM_PROMPT = `You are compacting an earlier portion of a coding agent's conversation so it can be dropped
from the live context without losing what still matters. Produce a concise structured Markdown
summary covering: the user's overall goal, what has been tried, what worked and what didn't,
important file paths / values / decisions, and anything the agent still needs to do. Some tool
output below has already been replaced with a short citation like "[archived tool output id=...,
call recall(id) to retrieve]" -- when a citation like that carries information the summary needs to
reference, keep the citation text so the id is still reachable, but do not invent its content.
Write only the summary, no preamble.`;

/** Rough token estimate (~4 chars/token, the common order-of-magnitude heuristic for English/code
 * text) used only to decide *whether* to compact, not to bill or report usage -- pi-ai's `Usage`
 * type carries the real provider-reported counts for that. Good enough for a threshold check. */
function estimateTextTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

function messageText(message: AgentMessage): string {
  if (typeof (message as { content?: unknown }).content === "string") {
    return (message as { content: string }).content;
  }
  const content = (message as { content?: unknown[] }).content;
  if (!Array.isArray(content)) return "";
  return content
    .map((block) =>
      block && typeof block === "object" && "text" in block
        ? String((block as { text: unknown }).text)
        : "",
    )
    .join("\n");
}

function estimateMessageTokens(message: AgentMessage): number {
  return estimateTextTokens(messageText(message));
}

/** Sums the estimate across `messages` only -- the system prompt is a separate, fixed tier
 * (tier 1) this function deliberately has no way to reach, since it's never passed one. */
function estimateTokens(messages: AgentMessage[]): number {
  return messages.reduce((sum, m) => sum + estimateMessageTokens(m), 0);
}

function isToolResultMessage(message: AgentMessage): message is AgentMessage & {
  role: "toolResult";
  toolCallId: string;
  toolName: string;
  content: unknown[];
} {
  return (message as { role?: string }).role === "toolResult";
}

/** A turn-boundary-safe cut point is any index whose message is NOT a `toolResult` -- i.e. a
 * "user" or "assistant" message. A single `session.prompt()` run can contain many internal
 * assistant/tool-result turns with only one leading "user" message (the model keeps calling
 * tools without anything re-prompting it), so a boundary can't require a fresh "user" message the
 * way a human back-and-forth chat would suggest; it only needs to never separate an assistant
 * message from its own tool results, which land immediately after it and nowhere else. */
function isSafeBoundary(message: AgentMessage): boolean {
  return !isToolResultMessage(message);
}

/** Finds the largest turn-boundary-safe index `j` such that `rest.slice(j)` still holds at least
 * `keepRecentTokens` worth of content -- i.e. walks back to the desired token budget, then walks
 * further back (never forward, which would shrink the kept tail below budget) to the nearest safe
 * boundary. Returns 0 if no safe cut exists yet (e.g. one huge recent turn); returns `rest.length`
 * itself (compact everything, keep nothing verbatim) for `keepRecentTokens <= 0`, since that budget
 * is satisfied before ever decrementing off the one-past-the-end starting position -- which is
 * always a safe boundary on its own (there's nothing after it to split a turn against), so the
 * second loop only needs to run once `idx` is a real in-bounds index. */
function pickCutIndex(rest: AgentMessage[], keepRecentTokens: number): number {
  let idx = rest.length;
  let accumulated = 0;
  while (idx > 0 && accumulated < keepRecentTokens) {
    idx -= 1;
    accumulated += estimateMessageTokens(rest[idx]);
  }
  while (idx > 0 && idx < rest.length && !isSafeBoundary(rest[idx])) {
    idx -= 1;
  }
  return idx;
}

/** Archives any oversized tool output found in `range` to tier 4 (the session log), then returns
 * a plain-text transcript of `range` with those spots replaced by short citations -- built for
 * the summarization call below, never returned to the live conversation. */
async function buildRedactedTranscript(
  range: AgentMessage[],
  sessionLog: SessionLog,
  archiveMinChars: number,
): Promise<string> {
  const lines: string[] = [];
  for (const message of range) {
    const role = (message as { role: string }).role;
    if (isToolResultMessage(message) && messageText(message).length > archiveMinChars) {
      const content = messageText(message);
      const id = nextEntryId();
      await sessionLog.append({
        id,
        timestamp: Date.now(),
        kind: "archived-tool-output",
        toolCallId: message.toolCallId,
        toolName: message.toolName,
        content,
        searchText: content,
      });
      lines.push(
        `[${role} ${message.toolName}]: [archived tool output id=${id}, ${content.length} chars -- call recall("${id}") to retrieve]`,
      );
      continue;
    }
    lines.push(`[${role}]: ${messageText(message)}`);
  }
  return lines.join("\n\n");
}

function summaryMessage(summaryText: string): AgentMessage {
  return {
    role: "user",
    timestamp: Date.now(),
    content: [
      {
        type: "text",
        text:
          "<compaction-summary>\nEarlier conversation was summarized automatically to conserve " +
          "context. Tool output cited by id below can be retrieved with recall(id).\n\n" +
          `${summaryText}\n</compaction-summary>`,
      },
    ],
  } as AgentMessage;
}

function taskStateMessage(state: TaskState): AgentMessage {
  const lines = [
    state.goal ? `Goal: ${state.goal}` : undefined,
    state.focus ? `Focus: ${state.focus}` : undefined,
    state.decisions.length > 0
      ? `Key decisions:\n${state.decisions.map((d) => `- ${d}`).join("\n")}`
      : undefined,
    state.nextAction ? `Next action: ${state.nextAction}` : undefined,
  ].filter((line): line is string => line !== undefined);

  return {
    role: "user",
    timestamp: Date.now(),
    content: [{ type: "text", text: `<task-state>\n${lines.join("\n")}\n</task-state>` }],
  } as AgentMessage;
}

/**
 * Builds a `transformContext` hook (see `AgentLoopConfig.transformContext`) that implements tiers
 * 2-4. Holds two pieces of state across calls -- how many of the *original* messages are already
 * folded into `cachedSummary`, and that summary's text -- so a session with many turns doesn't
 * re-run the summarization LLM call from scratch every single turn: once a range is compacted,
 * later calls only need to summarize the *new* excess past the last cut, folding the previous
 * summary in as plain context for that call (see the `alreadyCompacted` prefix below).
 */
export class CompactionEngine {
  private compactedThroughCount = 0;
  private cachedSummary: string | undefined;

  constructor(private readonly options: CompactionOptions) {}

  async transform(messages: AgentMessage[], signal?: AbortSignal): Promise<AgentMessage[]> {
    this.dropStaleCacheIfNeeded(messages);

    const rest = messages.slice(this.compactedThroughCount);
    const withState = this.prependTaskState(this.withCachedSummary(rest));

    const model = this.options.getModel();
    const triggerFraction = this.options.triggerFraction ?? DEFAULT_TRIGGER_FRACTION;
    const triggerTokens = Math.floor(model.contextWindow * triggerFraction);
    if (estimateTokens(withState) < triggerTokens) return withState;

    const compacted = await this.compactNow(rest, signal);
    if (!compacted) return withState; // nothing safe to compact yet; proceed over-threshold
    return this.prependTaskState([summaryMessage(compacted.summary), ...compacted.keepTail]);
  }

  /**
   * Forces a compaction pass right now, ignoring the token-threshold check `transform` normally
   * gates on -- the engine behind a user-invoked "/compact", distinct from the automatic per-turn
   * path above in one more important way: `transform`'s return value is only ever the ephemeral
   * payload sent to the model for one request (the caller, `Session`'s `transformContext` hook,
   * never writes it back into `state.messages`), whereas `Session.compact()` (agent.ts) DOES
   * assign this method's result back into `state.messages` -- so a manual "/compact" visibly and
   * permanently shrinks the session's own history, matching what other coding-agent CLIs' own
   * "/compact" commands do, rather than only affecting the next request's context size.
   *
   * Returns `undefined` (a no-op) if there's no safe cut point yet -- e.g. the entire history is
   * one still-recent turn -- so the caller can tell "nothing to compact" apart from "compacted".
   */
  async forceCompact(
    messages: AgentMessage[],
    signal?: AbortSignal,
  ): Promise<AgentMessage[] | undefined> {
    this.dropStaleCacheIfNeeded(messages);
    const rest = messages.slice(this.compactedThroughCount);
    const compacted = await this.compactNow(rest, signal);
    if (!compacted) return undefined;
    return this.prependTaskState([summaryMessage(compacted.summary), ...compacted.keepTail]);
  }

  private dropStaleCacheIfNeeded(messages: AgentMessage[]): void {
    if (messages.length < this.compactedThroughCount) {
      // The live history is shorter than what we last compacted through -- e.g. `session.reset()`
      // ran. Stale cache; drop it rather than reference messages that no longer exist.
      this.compactedThroughCount = 0;
      this.cachedSummary = undefined;
    }
  }

  private withCachedSummary(rest: AgentMessage[]): AgentMessage[] {
    return this.cachedSummary ? [summaryMessage(this.cachedSummary), ...rest] : rest;
  }

  /** The actual "summarize the front, keep the tail" work shared by `transform`'s over-threshold
   * path and `forceCompact`'s unconditional one. Returns `undefined` when `rest` has no
   * turn-boundary-safe cut point yet (see `pickCutIndex`). */
  private async compactNow(
    rest: AgentMessage[],
    signal?: AbortSignal,
  ): Promise<{ summary: string; keepTail: AgentMessage[] } | undefined> {
    const keepRecentTokens = this.options.keepRecentTokens ?? DEFAULT_KEEP_RECENT_TOKENS;
    const cutIndex = pickCutIndex(rest, keepRecentTokens);
    if (cutIndex <= 0) return undefined;

    const toCompact = rest.slice(0, cutIndex);
    const keepTail = rest.slice(cutIndex);

    const archiveMinChars = this.options.archiveMinChars ?? DEFAULT_ARCHIVE_MIN_CHARS;
    const transcriptParts: string[] = [];
    if (this.cachedSummary)
      transcriptParts.push(`Summary of even earlier conversation:\n${this.cachedSummary}`);
    transcriptParts.push(
      await buildRedactedTranscript(toCompact, this.options.sessionLog, archiveMinChars),
    );

    const model = this.options.getModel();
    const response = await this.options.models.completeSimple(
      model,
      {
        systemPrompt: SUMMARIZE_SYSTEM_PROMPT,
        messages: [{ role: "user", content: transcriptParts.join("\n\n"), timestamp: Date.now() }],
      },
      { signal },
    );
    const summaryText = response.content
      .filter((block): block is { type: "text"; text: string } => block.type === "text")
      .map((block) => block.text)
      .join("\n");

    this.compactedThroughCount = this.compactedThroughCount + toCompact.length;
    this.cachedSummary = summaryText;

    const firstKept = keepTail[0] ?? rest.at(-1);
    await this.options.sessionLog.append({
      id: nextEntryId(),
      timestamp: Date.now(),
      kind: "compaction",
      summary: summaryText,
      firstKeptTimestamp:
        (firstKept as { timestamp?: number } | undefined)?.timestamp ?? Date.now(),
    });

    return { summary: summaryText, keepTail };
  }

  private prependTaskState(messages: AgentMessage[]): AgentMessage[] {
    const state = this.options.getTaskState();
    return state ? [taskStateMessage(state), ...messages] : messages;
  }
}
