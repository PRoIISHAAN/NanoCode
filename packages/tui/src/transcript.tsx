// Every settled message is ALWAYS visible, exactly like Claude Code's own terminal UI: scroll the
// real terminal (or search its scrollback) to see anything earlier, rather than an app-level
// "hidden count" the user has no way to reach. This used to be virtualized (only the tail of the
// conversation that fit an estimated row budget was ever rendered, with a "N earlier entries hidden"
// banner and no way to reach them) -- a real, reported UX problem: there was genuinely no way back to
// hidden history. It's built on Ink's own `<Static>` (see `Transcript` below): every settled item
// prints ONCE, permanently, directly to the real terminal stream, becoming real scrollback immune to
// Ink's live-frame redraw/clear entirely -- not a home-grown virtualization scheme at all anymore.
// hermes-ink's ScrollBox (an imperatively-scrollable viewport built on hermes-ink's own forked
// reconciler and hand-ported Yoga engine) was considered and rejected for the same reason it always
// has been: none of that exists in upstream Ink, and Static already solves the actual problem
// (unbounded history without re-render cost or Ink's own large-frame full-clear behavior -- see
// select-list.tsx's own comment on `shouldClearTerminalForFrame`) with a primitive Ink ships. See
// decisions/0005-tui-stack.md and decisions/0014-header-menu-and-editing.md's Static follow-up.
//
// Rendering shape (decisions/0014-header-menu-and-editing.md's pi-parity follow-up): a real assistant
// turn can contain thinking, one or more tool calls, and final text all in one AgentMessage's content
// array, and a tool call's own result is a SEPARATE AgentMessage (a sibling ToolResultMessage,
// correlated only by toolCallId) -- neither fact matches "one message == one visual row." So this file
// first flattens the raw message list into a `TranscriptItem[]` (one item per thing that actually gets
// its own visual treatment: a user turn, a thinking block, one tool call paired with its eventual
// result, or one span of final assistant text), pairing each toolCall content block with its
// ToolResultMessage sibling by id along the way. `Transcript` then feeds that flattened list straight
// into `<Static>`, unfiltered and unbudgeted.
//
// Two consequences of `<Static>` freezing each item's rendered output the FIRST time it's ever part
// of the "new" tail slice, permanently, worth knowing before touching this file:
// 1. `ctrl+o`/`ctrl+t` only affect items that haven't been frozen into real scrollback yet -- exactly
//    matching a real terminal (you can't retroactively repaint history that already scrolled past).
//    Toggling either one only changes how NEW items render from that point on.
// 2. A toolCall content block is only ever turned into an item once its ToolResultMessage sibling has
//    actually arrived (see `buildTranscriptItems` below) -- never while `isPending` in the old sense.
//    Freezing a "still running" cell into Static would make it stay "still running" forever even
//    after the real result lands one render later, since Static would never revisit that slot to
//    update it. The still-executing window is covered by the existing coarse `streamingText`
//    "[running <tool>…]" status line instead (app.tsx's `tool_execution_start` handler), not by a
//    tool cell. One accepted, narrow gap from this: a tool call interrupted mid-execution (whose
//    ToolResultMessage never arrives at all) never gets a cell of its own -- the interrupt is still
//    communicated (an error line / the next turn's own content), just not as a frozen "it was running
//    this" cell, which would otherwise be equally possible to freeze BEFORE or AFTER the real result
//    with no way to tell which from inside a pure per-render item builder.
import type { AgentMessage } from "@nanocode/agent";
import { Box, Static, Text, useStdout } from "ink";
import type { ReactNode } from "react";
// See app.tsx's comment on why this file needs an explicit REAL (not `import type`) React import
// despite the automatic JSX runtime being configured and packages/tui having its own local
// tsconfig.json -- tsx's own runtime JSX transform needs a real value binding to exist, not just a
// type; kept as a separate, explicit value import from the `ReactNode` type import below so an
// autofixer narrowing "only used as a type" can't quietly turn this one into `import type` too
// (confirmed live: it did exactly that once, silently, before this comment existed).
// biome-ignore lint/correctness/noUnusedImports: required by tsx's runtime JSX transform, not referenced directly in this file's own code
import React from "react";

/** A message's content can be a plain string (UserMessage) or a content-block array (every role);
 * this renders it down to the plain text a terminal transcript actually shows -- tool calls get a
 * short bracketed label instead of their raw JSON arguments, images get a placeholder. Used for the
 * non-live-transcript text needs that just want a flat string (streaming-text accumulation, "/copy",
 * "/export", queued-message editing) -- the LIVE transcript itself (`Transcript` below) never calls
 * this; it reads content blocks itself so a tool call's code and a thinking block's real text can
 * get their own distinct visual treatment instead of being flattened into one string.
 *
 * A run that fails internally (Session's `buildFailureMessage`, see agent.ts) produces an
 * assistant message with deliberately *empty* content -- the actual error text lives in that
 * message's separate `errorMessage` field, the same field the headless CLI reads for its own
 * `console.error` -- so that's appended here too, or the transcript would silently show nothing
 * for a failed run.
 *
 * `thinkingExpanded` governs only `"thinking"` content blocks -- collapsed to a one-line placeholder
 * by default. Defaults to `false` for every call site here (none of them want a full reasoning trace
 * dumped into a copy/export/streaming-preview string); the live transcript's own thinking visibility
 * is handled separately, in `buildTranscriptItems` below. */
export function textOf(message: AgentMessage, thinkingExpanded = false): string {
  const content = (message as { content: unknown }).content;
  const contentText =
    typeof content === "string"
      ? content
      : Array.isArray(content)
        ? contentBlocksToText(content as ContentBlock[], thinkingExpanded)
        : "";

  const errorMessage = (message as { errorMessage?: string }).errorMessage;
  if (!errorMessage) return contentText;
  return contentText ? `${contentText}\n[error: ${errorMessage}]` : `[error: ${errorMessage}]`;
}

interface ContentBlock {
  type: string;
  text?: string;
  /** pi-ai's real field name for a "thinking" block's own text -- NOT `.text` (an earlier version
   * of this function read `.text` for thinking blocks too, which pi-ai's actual `ThinkingBlock`
   * shape never populates, so every thinking block silently rendered as empty text; found and
   * fixed while wiring up ctrl+t, since expanding thinking is meaningless if there's never
   * anything there to expand). */
  thinking?: string;
  /** A toolCall block's tool name (`ipython` today, see decisions/0002-tool-surface.md) and its
   * arguments (`{ code: string }` for ipython) -- read structurally, not imported from
   * @nanocode/ai/@nanocode/agent's own ToolCall type, matching this file's existing style of
   * duck-typing fields off AgentMessage. */
  name?: string;
  id?: string;
  arguments?: Record<string, unknown>;
}

const THINKING_PLACEHOLDER = "thinking...";

function contentBlocksToText(content: ContentBlock[], thinkingExpanded: boolean): string {
  return content
    .map((block) => {
      if (block.type === "text") return block.text ?? "";
      if (block.type === "thinking") {
        if (!block.thinking) return "";
        // Trailing newline: without it, a thinking block runs directly into whatever text block
        // follows it with no separator (this function joins every block with "") -- harmless when
        // thinking was invisible (the old, buggy `.text` read), but a real problem now that both
        // the placeholder and the expanded text are visible content of their own.
        return `${thinkingExpanded ? block.thinking : THINKING_PLACEHOLDER}\n`;
      }
      if (block.type === "toolCall") return `[call ${block.name}]`;
      if (block.type === "image") return "[image]";
      return "";
    })
    .join("");
}

/** Collapses a multi-line tool result down to its first line plus a count of how many more there
 * are. Kept as a small, still-tested pure utility for any plain-text summary that wants it; the
 * live transcript's own tool cells (below) use a different collapse shape (a one-line summary with
 * NO output at all when collapsed, matching prime-agent-runtime's ipython-cell convention, not a
 * partial-lines preview), so nothing in this file calls this anymore. */
export function summarizeToolResult(text: string): string {
  const lines = text.split("\n");
  if (lines.length <= 1) return text;
  const [first, ...rest] = lines;
  return `${first}\n… (+${rest.length} more line${rest.length === 1 ? "" : "s"} — ctrl+o to expand)`;
}

export function labelFor(message: AgentMessage): string {
  const role = (message as { role: string }).role;
  if (role === "user") return "You";
  if (role === "assistant") return "nanocode";
  if (role === "toolResult") return `tool:${(message as { toolName?: string }).toolName ?? "?"}`;
  return role;
}

// ---------------------------------------------------------------------------------------------
// Flattening: AgentMessage[] -> TranscriptItem[]
// ---------------------------------------------------------------------------------------------

export interface UserItem {
  kind: "user";
  key: string;
  text: string;
}

/** `hidden` (not an outright omission from the item list) is what keeps `<Static>`'s item COUNT for
 * a given prefix of `messages` independent of the live `thinkingExpanded` toggle -- toggling ctrl+t
 * must never change how many items exist for messages that already happened, or `<Static>`'s
 * "already-rendered index" bookkeeping (which only tracks array length, not content) would
 * desync. Rendering a hidden one (`TranscriptItemView` below) returns nothing at all. */
export interface ThinkingItem {
  kind: "thinking";
  key: string;
  text: string;
  hidden: boolean;
}

/** A span of final-answer assistant text, or a standalone system notice (a "/command" confirmation,
 * an unknown-command error, ...) -- both render the same way (plain text, markdown-aware list
 * coloring), so they share one item shape; `isError` only ever applies to notices. */
export interface TextItem {
  kind: "assistantText" | "notice";
  key: string;
  text: string;
  isError?: boolean;
}

/** One tool call paired with its eventual result -- covers both a real `ipython` call (code comes
 * from the toolCall block's own `arguments.code`) and a synthetic "!command"/"!!command" shell entry
 * (code comes from `details.code`, stashed there by app.tsx's `buildBangCommandEntries` since a
 * synthetic entry has no real toolCall block to read arguments off of). Always resolved by
 * construction -- see this file's header comment on why a still-executing call never becomes one of
 * these at all, rather than a `ToolCellItem` with some now-removed "pending" flag. */
export interface ToolCellItem {
  kind: "toolCell";
  key: string;
  language: string;
  code: string;
  output: string;
  isError: boolean;
  durationMs?: number;
  errorName?: string;
}

export type TranscriptItem = UserItem | ThinkingItem | TextItem | ToolCellItem;

function buildToolCellItem(
  key: string,
  callMessage: AgentMessage,
  block: ContentBlock,
  result: AgentMessage,
): ToolCellItem {
  const name = block.name ?? "tool";
  const language = name === "ipython" ? "python" : name;
  const code = typeof block.arguments?.code === "string" ? (block.arguments.code as string) : "";
  const isError = Boolean((result as { isError?: boolean }).isError);
  const callTimestamp = (callMessage as { timestamp: number }).timestamp;
  const resultTimestamp = (result as { timestamp: number }).timestamp;
  const errorName = (result as { details?: { error?: { ename?: string } } }).details?.error?.ename;
  return {
    kind: "toolCell",
    key,
    language,
    code,
    output: textOf(result),
    isError,
    durationMs: Math.max(0, resultTimestamp - callTimestamp),
    errorName,
  };
}

/** A `toolResult` message with no matching toolCall block -- either a synthetic "!command"/"!!command"
 * shell entry or a "/command" confirmation (app.tsx's `buildBangCommandEntries`/
 * `buildCommandResultEntries`), neither of which round-trips through the model as a real tool call. A
 * "command" entry is just an informational notice (no code, nothing to expand); a "shell" entry gets
 * the same tool-cell treatment as a real ipython call, with its command text read from `details.code`. */
function buildStandaloneToolItem(message: AgentMessage, messageIndex: number): TranscriptItem {
  const toolName = (message as { toolName?: string }).toolName ?? "tool";
  const timestamp = (message as { timestamp: number }).timestamp;
  const key = `tool-${timestamp}-${messageIndex}`;
  const isError = Boolean((message as { isError?: boolean }).isError);
  if (toolName === "command") {
    return { kind: "notice", key, text: textOf(message), isError };
  }
  const code = (message as { details?: { code?: string } }).details?.code ?? "";
  return {
    kind: "toolCell",
    key,
    language: toolName,
    code,
    output: textOf(message),
    isError,
    durationMs: undefined,
    errorName: undefined,
  };
}

/** Walks `messages` once, indexing every `toolResult` by its `toolCallId` first so each assistant
 * message's toolCall blocks can look their result up in O(1), then emits one `TranscriptItem` per
 * thing that gets its own visual row: a user turn, a thinking block (always emitted, `hidden` per the
 * live `thinkingExpanded` toggle -- see `ThinkingItem`'s own comment on why it's never omitted
 * outright), a tool call+result pair (only once resolved -- see this file's header comment), or a
 * span of final text. A `toolResult` already consumed by a toolCall pairing is skipped when the walk
 * reaches it; one that never matched a toolCall (a resumed session missing an assistant message from
 * before it was saved, or a synthetic shell/command entry) still renders on its own via
 * `buildStandaloneToolItem`, so real output is never silently dropped. */
export function buildTranscriptItems(
  messages: readonly AgentMessage[],
  thinkingExpanded: boolean,
): TranscriptItem[] {
  const resultByCallId = new Map<string, AgentMessage>();
  for (const message of messages) {
    if ((message as { role: string }).role === "toolResult") {
      const id = (message as { toolCallId?: string }).toolCallId;
      if (id) resultByCallId.set(id, message);
    }
  }
  const consumedResultIds = new Set<string>();
  const items: TranscriptItem[] = [];

  messages.forEach((message, messageIndex) => {
    const role = (message as { role: string }).role;
    const timestamp = (message as { timestamp: number }).timestamp;

    if (role === "user") {
      items.push({ kind: "user", key: `user-${timestamp}-${messageIndex}`, text: textOf(message) });
      return;
    }

    if (role === "assistant") {
      const content = (message as { content: unknown }).content;
      const blocks = Array.isArray(content) ? (content as ContentBlock[]) : [];
      blocks.forEach((block, blockIndex) => {
        const key = `assistant-${timestamp}-${messageIndex}-${blockIndex}`;
        if (block.type === "thinking") {
          if (block.thinking) {
            items.push({ kind: "thinking", key, text: block.thinking, hidden: !thinkingExpanded });
          }
          return;
        }
        if (block.type === "toolCall") {
          const result = block.id ? resultByCallId.get(block.id) : undefined;
          // Still executing (or, rarely, interrupted before its result ever arrived) -- not yet an
          // item at all. See this file's header comment for why.
          if (!result || !block.id) return;
          consumedResultIds.add(block.id);
          items.push(buildToolCellItem(key, message, block, result));
          return;
        }
        if (block.type === "text") {
          if (block.text) items.push({ kind: "assistantText", key, text: block.text });
          return;
        }
        if (block.type === "image") {
          items.push({ kind: "assistantText", key, text: "[image]" });
        }
      });
      const errorMessage = (message as { errorMessage?: string }).errorMessage;
      if (errorMessage) {
        items.push({
          kind: "notice",
          key: `assistant-error-${timestamp}-${messageIndex}`,
          text: `[error: ${errorMessage}]`,
          isError: true,
        });
      }
      return;
    }

    if (role === "toolResult") {
      const callId = (message as { toolCallId?: string }).toolCallId;
      if (callId && consumedResultIds.has(callId)) return;
      items.push(buildStandaloneToolItem(message, messageIndex));
    }
  });

  return items;
}

// ---------------------------------------------------------------------------------------------
// Rendering helpers
// ---------------------------------------------------------------------------------------------

/** Greedy word wrap at `width` columns -- a plain character-count measure, not grapheme-cluster or
 * ANSI-aware (this file's text is always plain by the time it reaches here). Used by the
 * user-message bar to know how many rows to pad/color -- there's no row-budget estimation left to
 * keep in sync with it now that every item is always rendered (see this file's header comment). */
function wrapPlainText(text: string, width: number): string[] {
  const safeWidth = Math.max(1, width);
  const result: string[] = [];
  for (const rawLine of text.split("\n")) {
    let line = rawLine;
    if (line.length === 0) {
      result.push("");
      continue;
    }
    while (line.length > safeWidth) {
      let breakAt = line.lastIndexOf(" ", safeWidth);
      if (breakAt <= 0) breakAt = safeWidth;
      result.push(line.slice(0, breakAt));
      line = line.slice(breakAt).replace(/^ +/, "");
    }
    result.push(line);
  }
  return result.length > 0 ? result : [""];
}

function padToWidth(line: string, width: number): string {
  return line.length >= width ? line.slice(0, width) : line + " ".repeat(width - line.length);
}

/** A pi-style full-width background bar for a user turn -- no role label at all (pi shows nothing
 * but the text itself), padded with one blank bar-colored row above and below, every row padded to
 * the full terminal width so the background reaches both edges. Own color choice (pi's own exact
 * colors were never a requirement, only the shape was), a muted dark bar rather than pi's captured
 * hex so it reads as an inset box against any terminal theme. */
function UserMessageBar({ text, width }: { text: string; width: number }) {
  const lines = wrapPlainText(text, Math.max(1, width - 1)).map((line) => ` ${line}`);
  const blank = " ".repeat(width);
  return (
    <Box flexDirection="column">
      <Text backgroundColor="blackBright">{blank}</Text>
      {lines.map((line, index) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: this row list is rebuilt fresh from `text` on every render, never reordered or spliced -- index is a stable, sufficient key here.
        <Text key={index} backgroundColor="blackBright" color="white">
          {padToWidth(line, width)}
        </Text>
      ))}
      <Text backgroundColor="blackBright">{blank}</Text>
    </Box>
  );
}

/** Matches pi's own thinking-block treatment: italic, dim, no label, no box. Only ever invoked for a
 * visible (`!hidden`) `ThinkingItem` -- `Transcript`'s `<Static>` children callback renders a hidden
 * one as nothing at all, without calling this. */
function ThinkingBlock({ text }: { text: string }) {
  return (
    <Text color="gray" italic>
      {text}
    </Text>
  );
}

/** Plain text, no label -- matches pi's own final-answer treatment. Markdown-aware only for list
 * markers (ordered `1.`/unordered `-`/`*`): the marker itself is colored, the rest of the line stays
 * default -- own design choice, not a port of pi's own markdown handling (colors were never asked to
 * match). Also used for standalone notices ("/command" confirmations, unknown-command errors), with
 * `isError` tinting the whole line red instead. */
function AssistantText({ text, isError }: { text: string; isError?: boolean }) {
  const lines = text.split("\n");
  return (
    <Box flexDirection="column">
      {lines.map((line, index) => {
        const match = line.match(/^(\s*)(\d+\.|[-*])(\s+)/);
        if (match && !isError) {
          const [whole, indent, marker, spacing] = match;
          const rest = line.slice(whole.length);
          return (
            // biome-ignore lint/suspicious/noArrayIndexKey: this row list is rebuilt fresh from `text` on every render, never reordered or spliced -- index is a stable, sufficient key here.
            <Text key={index}>
              {indent}
              <Text color="cyan">{marker}</Text>
              {spacing}
              {rest || " "}
            </Text>
          );
        }
        return (
          // biome-ignore lint/suspicious/noArrayIndexKey: this row list is rebuilt fresh from `text` on every render, never reordered or spliced -- index is a stable, sufficient key here.
          <Text key={index} color={isError ? "red" : undefined}>
            {line || " "}
          </Text>
        );
      })}
    </Box>
  );
}

function formatDuration(ms: number | undefined): string | undefined {
  if (ms === undefined) return undefined;
  return ms < 1000 ? `${Math.round(ms)}ms` : `${(ms / 1000).toFixed(1)}s`;
}

/** The first non-blank line of `code`, truncated -- a cheap stand-in for a real syntax-aware preview
 * (nanocode has no code highlighter available in the TUI layer); " …" marks that more code follows. */
function firstMeaningfulLine(code: string): string | undefined {
  const trimmedLines = code
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  if (trimmedLines.length === 0) return undefined;
  const MAX = 60;
  const first = trimmedLines[0];
  const truncated = first.length > MAX ? `${first.slice(0, MAX - 1)}…` : first;
  return trimmedLines.length > 1 ? `${truncated} …` : truncated;
}

function lineCountsLabel(code: string, output: string | undefined): string | undefined {
  const inputLines = code.split("\n").filter((line) => line.trim().length > 0).length;
  const outputLines = output ? output.split("\n").filter((line) => line.length > 0).length : 0;
  const segments: string[] = [];
  if (inputLines > 0) segments.push(`↑${inputLines}`);
  if (outputLines > 0) segments.push(`↓${outputLines}`);
  return segments.length > 0 ? `${segments.join(" ")} lines` : undefined;
}

function expandHint(expanded: boolean): string {
  return expanded ? "ctrl+o to collapse" : "ctrl+o to expand";
}

interface CellSegment {
  text: string;
  color?: string;
  dimColor?: boolean;
}

/** Structurally inspired by prime-agent-runtime's ipython-cell.ts (its own single-python-tool
 * transcript component, the closest real reference for "how to display one code-execution call and
 * its result" -- pi's own tool-call rendering is shell-command-shaped and doesn't fit nanocode's one
 * `ipython` tool). Not a port: own colors, own marker glyphs, own layout code, and no syntax
 * highlighting (nanocode has no highlighter available at this layer). Collapsed (the default) shows
 * one summary line and nothing else; ctrl+o expands to the full code (a `› `/`  ` gutter, matching
 * output indent) followed by the result. */
function ToolCellView({ item, expanded }: { item: ToolCellItem; expanded: boolean }) {
  const marker: CellSegment = item.isError
    ? { text: "✗", color: "red" }
    : { text: "✓", color: "green" };

  const segments: CellSegment[] = [marker, { text: item.language, dimColor: true }];
  const preview = firstMeaningfulLine(item.code);
  if (preview) segments.push({ text: preview });
  const counts = lineCountsLabel(item.code, item.output);
  if (counts) segments.push({ text: counts, dimColor: true });
  const duration = formatDuration(item.durationMs);
  if (duration) segments.push({ text: duration, dimColor: true });
  if (item.errorName) segments.push({ text: item.errorName, color: "red" });
  segments.push({ text: expandHint(expanded), dimColor: true });

  const summaryLine = (
    <Text>
      {segments.flatMap((segment, index) => [
        index > 0 ? (
          // biome-ignore lint/suspicious/noArrayIndexKey: `segments` is rebuilt fresh from `item` on every render, never reordered or spliced -- index is a stable, sufficient key here.
          <Text key={`sep-${index}`} dimColor>
            {" · "}
          </Text>
        ) : null,
        // biome-ignore lint/suspicious/noArrayIndexKey: `segments` is rebuilt fresh from `item` on every render, never reordered or spliced -- index is a stable, sufficient key here.
        <Text key={`seg-${index}`} color={segment.color} dimColor={segment.dimColor}>
          {segment.text}
        </Text>,
      ])}
    </Text>
  );

  if (!expanded) return summaryLine;

  const codeLines = item.code.length > 0 ? item.code.split("\n") : [];
  // A tool with no `code` argument at all (any tool other than ipython, today only hypothetical/
  // future ones) genuinely has no code to show -- skip straight to its output instead of printing a
  // misleading "waiting for code" (a real state this file no longer has any item for at all; see its
  // header comment).
  return (
    <Box flexDirection="column">
      {summaryLine}
      {codeLines.length > 0 && (
        <>
          <Text> </Text>
          {codeLines.map((line, index) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: `codeLines` is rebuilt fresh from `item.code` on every render, never reordered or spliced -- index is a stable, sufficient key here.
            <Text key={index}>
              <Text dimColor>{index === 0 ? "› " : "  "}</Text>
              {line || " "}
            </Text>
          ))}
        </>
      )}
      {item.output.length > 0 ? (
        <>
          <Text> </Text>
          {item.output.split("\n").map((line, index) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: this row list is rebuilt fresh from `item.output` on every render, never reordered or spliced -- index is a stable, sufficient key here.
            <Text key={index} color={item.isError ? "red" : undefined} dimColor={!item.isError}>
              {`  ${line || " "}`}
            </Text>
          ))}
        </>
      ) : (
        <Text dimColor> no output</Text>
      )}
    </Box>
  );
}

function TranscriptItemView({
  item,
  width,
  toolOutputExpanded,
}: {
  item: TranscriptItem;
  width: number;
  toolOutputExpanded: boolean;
}) {
  if (item.kind === "user") return <UserMessageBar text={item.text} width={width} />;
  if (item.kind === "thinking") return <ThinkingBlock text={item.text} />;
  if (item.kind === "toolCell") return <ToolCellView item={item} expanded={toolOutputExpanded} />;
  return <AssistantText text={item.text} isError={item.isError} />;
}

export interface TranscriptProps {
  messages: readonly AgentMessage[];
  /** A FIXED status string ("thinking...", "responding…", "[running <tool>…]") for the one
   * still-in-flight assistant message -- the one thing in this component that's still live/redrawn
   * every frame rather than settled into `<Static>` (it isn't in `messages` yet at all). app.tsx
   * (the only real caller) deliberately never hands this the message's own growing text anymore: an
   * earlier version did, then tried bounding its rendered height here, but that still left a real,
   * user-visible one-time "grows to the bounded cap, then stops" shift right as a response started
   * -- still scrolling by the time a human actually sees it. A fixed string's height never changes
   * at all, for the entire turn. Renders as plain unstyled text, matching the no-label final-answer
   * treatment below. */
  streamingText?: string;
  /** Ctrl+O toggles this (app.tsx). False (the default) collapses every NOT-YET-SETTLED tool cell to
   * its one-line summary -- true expands new ones to their full code and output. A single global
   * toggle, not a per-cell one -- and, because of `<Static>`, it only ever affects items that haven't
   * been permanently rendered yet; see this file's header comment. */
  toolOutputExpanded?: boolean;
  /** Ctrl+T toggles this (app.tsx). False (the default) hides new thinking blocks entirely -- true
   * shows new ones in full. Binary, matching pi's own thinking toggle, and -- like
   * `toolOutputExpanded` -- only affects items not yet settled into `<Static>`. */
  thinkingExpanded?: boolean;
  /** Extra content to settle into this component's OWN `<Static>`, ahead of every message, exactly
   * once, permanently (app.tsx's startup banner, once a session exists). NOT a second `<Static>` of
   * its own: confirmed directly (a tiny isolated repro) that Ink does not support more than one
   * `<Static>` per render tree at all -- a second, independent sibling `<Static>` silently produces
   * NO output whatsoever, not a layout/ordering issue. Whatever else ever needs to become permanent
   * scrollback above the transcript has to share this one instead of using its own. */
  leadingStatic?: ReactNode;
}

/** One real `TranscriptItem` slot, or the one `leadingStatic` slot (if provided) -- both settle
 * through the SAME `<Static>` (see `TranscriptProps.leadingStatic`'s own comment on why there can
 * only be one). Kept internal to this file; `leadingStatic`'s caller never needs to know slots exist. */
type StaticSlot = { kind: "leadingStatic" } | TranscriptItem;

/** Every settled item renders through `<Static>` -- printed once, permanently, directly to the real
 * terminal (this file's header comment covers why, and the two behavioral consequences of freezing a
 * render this way). `key` is required on `<Static>`'s children per its own contract; a hidden
 * thinking item still occupies a slot in `items` (so `<Static>`'s length-based bookkeeping of "how
 * much have I already rendered" stays correct across a ctrl+t toggle) but renders as nothing at all,
 * so it needs no key of its own. */
export function Transcript({
  messages,
  streamingText,
  toolOutputExpanded = false,
  thinkingExpanded = false,
  leadingStatic,
}: TranscriptProps) {
  const { stdout } = useStdout();
  const width = stdout?.columns ?? 80;

  const items = buildTranscriptItems(messages, thinkingExpanded);
  // `leadingStatic`'s own presence (not its content) decides whether slot 0 exists at all -- as
  // long as the caller keeps passing SOMETHING once it starts passing anything, this slot's index
  // stays 0 forever, which is all `<Static>`'s own length-based bookkeeping needs to stay correct.
  const slots: StaticSlot[] =
    leadingStatic !== undefined ? [{ kind: "leadingStatic" }, ...items] : items;

  return (
    <Box flexDirection="column">
      <Static items={slots}>
        {(slot) => {
          if (slot.kind === "leadingStatic") return <Box key="leading-static">{leadingStatic}</Box>;
          if (slot.kind === "thinking" && slot.hidden) return null;
          return (
            <Box key={slot.key} flexDirection="column" marginBottom={slot.kind === "user" ? 0 : 1}>
              <TranscriptItemView
                item={slot}
                width={width}
                toolOutputExpanded={toolOutputExpanded}
              />
            </Box>
          );
        }}
      </Static>
      {streamingText !== undefined && <Text>{streamingText}</Text>}
    </Box>
  );
}
