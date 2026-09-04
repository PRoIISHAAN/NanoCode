// Runs inside a real alternate-screen-buffer fullscreen mode now (packages/cli/src/tui.tsx enters
// it before Ink ever renders a frame), matching Claude Code's own separate "fullscreen renderer"
// mode -- the user's own explicit ask, after nanocode's earlier inline-scrollback approach (every
// settled message printed once, permanently, via Ink's `<Static>`, becoming real terminal scrollback)
// couldn't give a footer that stays pinned to the terminal's bottom edge once real conversation
// content existed; it could only ever trail immediately behind whatever was last printed. The
// alternate screen buffer has NO scrollback of its own at all, which is exactly why `<Static>` no
// longer has any purpose here: `Transcript` (below) is instead a FIXED-height, clipped viewport
// (`overflow="hidden"`, bottom-aligned children) that always shows however much of the tail of the
// conversation fits in whatever height app.tsx's `TranscriptView` computes for it (terminal height
// minus the notification line, prompt box, and status bar) -- auto-scrolling to the newest content
// the same way a real chat window does, with older content clipped off the top rather than hidden
// behind an app-level "N earlier entries" count. hermes-ink's ScrollBox (an imperatively-scrollable
// viewport built on hermes-ink's own forked reconciler and hand-ported Yoga engine) was considered
// and rejected for the same reason it always has been: none of that exists in upstream Ink, and this
// file's own clipping technique (see `Transcript`'s own comment) achieves the same real result with
// primitives Ink already ships.
//
// Rendering shape (decisions/0014-header-menu-and-editing.md's pi-parity follow-up): a real assistant
// turn can contain thinking, one or more tool calls, and final text all in one AgentMessage's content
// array, and a tool call's own result is a SEPARATE AgentMessage (a sibling ToolResultMessage,
// correlated only by toolCallId) -- neither fact matches "one message == one visual row." So this file
// first flattens the raw message list into a `TranscriptItem[]` (one item per thing that actually gets
// its own visual treatment: a user turn, a thinking block, one tool call paired with its eventual
// result, or one span of final assistant text), pairing each toolCall content block with its
// ToolResultMessage sibling by id along the way.
//
// A toolCall content block is only ever turned into an item once its ToolResultMessage sibling has
// actually arrived (see `buildTranscriptItems` below) -- never while still executing. The
// still-executing window is covered by app.tsx's `NotificationLine` (a fixed status line + spinner,
// not part of this file at all) instead of a tool cell of its own. One accepted, narrow gap from
// this: a tool call interrupted mid-execution (whose ToolResultMessage never arrives at all) never
// gets a cell of its own -- the interrupt is still communicated (an error line / the next turn's own
// content), just not as its own "it was running this" cell.
import type { AgentMessage } from "@nanocode/agent";
import { Box, type DOMElement, measureElement, Text, useStdout } from "ink";
import type { ReactNode } from "react";
// See app.tsx's comment on why this file needs an explicit REAL (not `import type`) React import
// despite the automatic JSX runtime being configured and packages/tui having its own local
// tsconfig.json -- tsx's own runtime JSX transform needs a real value binding to exist, not just a
// type; kept as a separate, explicit value import from the `ReactNode` type import below so an
// autofixer narrowing "only used as a type" can't quietly turn this one into `import type` too
// (confirmed live: it did exactly that once, silently, before this comment existed).
// biome-ignore lint/correctness/noUnusedImports: required by tsx's runtime JSX transform, not referenced directly in this file's own code
import React, { useLayoutEffect, useMemo, useRef, useState } from "react";

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
   * still-in-flight assistant message -- it isn't in `messages` yet at all. app.tsx's own
   * `NotificationLine` is what actually displays this now (alongside a spinner) -- kept as a prop
   * here too only for the rare moment a caller wants it inline with the transcript itself; the real
   * nanocode app no longer passes it in.
   * deliberately never the message's own growing text: an earlier version did, then tried bounding
   * its rendered height here, but that still left a real, user-visible one-time "grows to the
   * bounded cap, then stops" shift right as a response started -- still scrolling by the time a
   * human actually sees it. A fixed string's height never changes at all, for the entire turn. */
  streamingText?: string;
  /** Ctrl+O toggles this (app.tsx). False (the default) collapses every tool cell to its one-line
   * summary -- true expands them to their full code and output. A single global toggle, applying
   * uniformly to every item on every render now that nothing freezes into permanent scrollback
   * (see this file's header comment) -- unlike the old `<Static>`-based version, toggling this now
   * retroactively affects OLDER tool cells too, not just ones settled after the toggle. */
  toolOutputExpanded?: boolean;
  /** Ctrl+T toggles this (app.tsx). False (the default) hides thinking blocks entirely -- true shows
   * them in full. Binary, matching pi's own thinking toggle -- like `toolOutputExpanded`, applies
   * uniformly to every item now, old and new alike. */
  thinkingExpanded?: boolean;
  /** Extra content shown ahead of every real message -- app.tsx's startup banner. Just the first
   * child of the scrollable viewport now (this file's header comment covers why there's no more
   * `<Static>` to settle it into): visible when scrolled to the very top of the conversation, like
   * any chat app's own opening message, not a separately-pinned header taking up its own space
   * forever. */
  leadingContent?: ReactNode;
  /** `leadingContent`'s own approximate row count (app.tsx passes `BANNER_ROWS` for the real
   * startup banner) -- this component can't measure an arbitrary `ReactNode`'s rendered height
   * itself, and needs SOME number for it to decide top-alignment vs. bottom-anchoring below.
   * Defaults to 0 (assumed to take no space) if `leadingContent` is set but this isn't -- an
   * intentionally forgiving default, not a hard requirement, since the consequence of this being
   * wrong is only ever a one-render-late alignment flip (see this component's own header comment),
   * never a crash or an actually-wrong clip. */
  leadingContentRows?: number;
  /** How many terminal rows this transcript gets -- app.tsx's `TranscriptView` computes this from
   * the real terminal height minus everything else on screen (the notification line, the prompt
   * box, the status bar, ...), so the transcript is always exactly what's left, never more. */
  height: number;
  /** Rows scrolled UP from the very bottom (the newest content) -- `0` (the default) means pinned to
   * the bottom, exactly like before this prop existed. Driven by app.tsx's `mouse.ts`-backed wheel
   * handling; see this component's own header comment for how a value here actually moves the
   * visible window, and why arbitrarily large values are always safe to pass (this component clamps
   * against its own real, measured content height itself). */
  scrollOffset?: number;
}

/** Rough, deliberately approximate row-count estimate for one item -- used ONLY as this component's
 * very first-render SEED for `contentHeight` (see `Transcript` below), before its own
 * `measureElement` pass has had a chance to run even once. Never used to compute an actual clip
 * point or scroll position -- Yoga's own real layout (via `measureElement`) does that precisely,
 * regardless of how far off this estimate is, and self-corrects within the same commit -- so a plain
 * character-count wrap (this file's own `wrapPlainText`) is precise enough; no need for
 * `wrap-ansi`'s real word-wrap here. */
function estimateItemRows(
  item: TranscriptItem,
  width: number,
  toolOutputExpanded: boolean,
): number {
  if (item.kind === "user") {
    // Matches UserMessageBar's own shape: one blank bar-colored row above and below the text.
    return wrapPlainText(item.text, Math.max(1, width - 1)).length + 2;
  }
  if (item.kind === "thinking") {
    return item.hidden ? 0 : wrapPlainText(item.text, width).length;
  }
  if (item.kind === "toolCell") {
    if (!toolOutputExpanded) return 1; // the collapsed one-line summary
    const codeRows = item.code.length > 0 ? item.code.split("\n").length + 1 : 0;
    const outputRows = item.output.length > 0 ? item.output.split("\n").length + 1 : 1;
    return 1 + codeRows + outputRows;
  }
  // "assistantText" / "notice"
  return wrapPlainText(item.text, width).length;
}

/** The scrollable chat viewport: a FIXED-height `<Box>` (`overflow="hidden"`) containing one
 * naturally-sized (no explicit `height`) inner column `<Box>` holding every real item, shifted up or
 * down via `marginTop` on that inner box -- the same technique any CSS-flexbox scrollable region
 * uses without a native "scroll" primitive (confirmed via an isolated repro before wiring this in:
 * an inner box taller than its `overflow: hidden` parent, given a negative `marginTop`, reveals
 * exactly the window that margin implies -- clean, precise, and small enough deltas naturally support
 * arbitrary scroll positions, not just "all the way top" or "all the way bottom").
 *
 * `contentHeight` (the inner box's real height) starts from `estimateItemRows`' rough total -- an
 * intentionally-approximate SEED, since nothing has actually been measured yet on the very first
 * render -- and is corrected to the real, exact value by `measureElement` inside a `useLayoutEffect`
 * (ink's own recommended pattern for this: measurement only works post-layout, and `useLayoutEffect`
 * lands the correction in the SAME commit, before anything is actually written to the terminal, the
 * same technique `command-overlay.tsx`'s own height-reporting already uses). This replaced an
 * earlier, ESTIMATE-only version that only ever picked between two fixed alignments (top-aligned
 * when short, bottom-anchored-at-the-newest when overflowing) -- correct for those two cases, but
 * with no way to represent anything IN BETWEEN, which is exactly what real, precise scrolling needs.
 *
 * `maxScroll = max(0, contentHeight - height)` is how far "up" there is to go at all; `scrollOffset`
 * is clamped into `[0, maxScroll]` here (the only place that knows the real content height, so the
 * only place that CAN clamp accurately) before being turned into `marginTop = -(maxScroll -
 * clampedOffset)`. At `scrollOffset = 0` this reduces to the old bottom-anchored case exactly
 * (`marginTop = -maxScroll`, revealing the tail); once `contentHeight <= height` (nothing to scroll),
 * `maxScroll` is `0` and `marginTop` is always `0` regardless of `scrollOffset` -- the old
 * top-aligned case, also exactly reproduced.
 *
 * There is still no OS/terminal-level scrollback reachable here, since the alternate screen buffer
 * this all runs inside of has none of its own (see this file's header comment) -- but a user's own
 * wheel scroll (app.tsx's `onWheel` subscription, fed by `mouse.ts`'s SGR mouse-report parsing) now
 * moves within the SAME `scrollOffset` this component reads, so older content really is reachable
 * again on demand, not just by resizing the terminal taller or clearing the conversation.
 *
 * Every real item still gets its own `flexShrink={0}` (below) for the same reason as before: without
 * it, Yoga shrinks every child to share whatever space is available instead of clipping cleanly by
 * position, which for text content produces nonsensical, sampled-looking output. A hidden thinking
 * item renders as nothing at all (its own `key` still required by React, even though it contributes
 * no visible row or margin -- `estimateItemRows`'s own seed-total skips it for the same reason). */
export function Transcript({
  messages,
  streamingText,
  toolOutputExpanded = false,
  thinkingExpanded = false,
  leadingContent,
  leadingContentRows = 0,
  height,
  scrollOffset = 0,
}: TranscriptProps) {
  const { stdout } = useStdout();
  const width = stdout?.columns ?? 80;

  // Memoized on `[messages, thinkingExpanded]` alone (NOT `toolOutputExpanded`, which only affects
  // how an already-built `ToolCellItem` is RENDERED, not which items exist at all) -- `TranscriptView`
  // now re-renders this component on every keystroke (to keep `height` current, see its own
  // comment), so recomputing this flattening pass every time regardless of whether `messages` itself
  // changed would be real, avoidable, and potentially expensive-at-scale wasted work.
  const items = useMemo(
    () => buildTranscriptItems(messages, thinkingExpanded),
    [messages, thinkingExpanded],
  );

  const estimatedContentRows = useMemo(() => {
    let total = leadingContent !== undefined ? leadingContentRows : 0;
    for (const item of items) {
      if (item.kind === "thinking" && item.hidden) continue;
      total += estimateItemRows(item, width, toolOutputExpanded);
      if (item.kind !== "user") total += 1; // matches the real `marginBottom={1}` below
    }
    if (streamingText !== undefined) total += 1;
    return total;
  }, [items, leadingContent, leadingContentRows, width, toolOutputExpanded, streamingText]);

  const [contentHeight, setContentHeight] = useState(estimatedContentRows);
  const contentRef = useRef<DOMElement>(null);
  useLayoutEffect(() => {
    if (!contentRef.current) return;
    const { height: measured } = measureElement(contentRef.current);
    if (measured > 0) setContentHeight(measured);
  });

  const maxScroll = Math.max(0, contentHeight - height);
  const clampedOffset = Math.min(Math.max(scrollOffset, 0), maxScroll);
  const marginTop = -(maxScroll - clampedOffset);

  return (
    <Box height={height} overflow="hidden" flexDirection="column">
      <Box ref={contentRef} flexShrink={0} flexDirection="column" marginTop={marginTop}>
        {leadingContent !== undefined && <Box flexShrink={0}>{leadingContent}</Box>}
        {items.map((item) => {
          if (item.kind === "thinking" && item.hidden) return null;
          return (
            <Box
              key={item.key}
              flexShrink={0}
              flexDirection="column"
              marginBottom={item.kind === "user" ? 0 : 1}
            >
              <TranscriptItemView
                item={item}
                width={width}
                toolOutputExpanded={toolOutputExpanded}
              />
            </Box>
          );
        })}
        {streamingText !== undefined && (
          <Box flexShrink={0}>
            <Text>{streamingText}</Text>
          </Box>
        )}
      </Box>
    </Box>
  );
}
