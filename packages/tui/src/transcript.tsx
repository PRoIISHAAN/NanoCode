// Virtualized transcript: hermes-ink's ScrollBox is a genuinely different animal from what's built
// here -- it's an imperatively-scrollable viewport (scrollTo/scrollBy/sticky-bottom tracking) built
// on hermes-ink's own forked reconciler and hand-ported Yoga engine (reading yogaNode.getComputedTop()
// directly), none of which exists in upstream Ink. What nanocode's transcript actually needs is
// simpler: a session transcript that only ever grows and should stay pinned to the bottom, not a
// general-purpose scrollable pane -- so virtualization here means "estimate how many terminal rows
// the tail of the conversation needs and render only that many messages," an independently designed
// (and much smaller) mechanism for a narrower problem. See decisions/0005-tui-stack.md.
import type { AgentMessage } from "@nanocode/agent";
import { Box, Text, useStdout } from "ink";
// See app.tsx's comment on why this file needs an explicit React import despite the automatic
// JSX runtime being configured and packages/tui having its own local tsconfig.json.
// biome-ignore lint/correctness/noUnusedImports: required by tsx's runtime JSX transform, not referenced directly in this file's own code
import React from "react";

/** A message's content can be a plain string (UserMessage) or a content-block array (every role);
 * this renders it down to the plain text a terminal transcript actually shows -- tool calls get a
 * short bracketed label instead of their raw JSON arguments, images get a placeholder.
 *
 * A run that fails internally (Session's `buildFailureMessage`, see agent.ts) produces an
 * assistant message with deliberately *empty* content -- the actual error text lives in that
 * message's separate `errorMessage` field, the same field the headless CLI reads for its own
 * `console.error` -- so that's appended here too, or the transcript would silently show nothing
 * for a failed run. */
export function textOf(message: AgentMessage): string {
  const content = (message as { content: unknown }).content;
  const contentText =
    typeof content === "string"
      ? content
      : Array.isArray(content)
        ? contentBlocksToText(content as ContentBlock[])
        : "";

  const errorMessage = (message as { errorMessage?: string }).errorMessage;
  if (!errorMessage) return contentText;
  return contentText ? `${contentText}\n[error: ${errorMessage}]` : `[error: ${errorMessage}]`;
}

interface ContentBlock {
  type: string;
  text?: string;
  name?: string;
}

function contentBlocksToText(content: ContentBlock[]): string {
  return content
    .map((block) => {
      if (block.type === "text" || block.type === "thinking") return block.text ?? "";
      if (block.type === "toolCall") return `[call ${block.name}]`;
      if (block.type === "image") return "[image]";
      return "";
    })
    .join("");
}

/** Collapses a multi-line tool result down to its first line plus a count of how many more there
 * are -- a single-line result is already compact enough that collapsing it would save nothing, so
 * it's shown in full either way. Ctrl+O (wired in app.tsx) toggles between this and the full text. */
export function summarizeToolResult(text: string): string {
  const lines = text.split("\n");
  if (lines.length <= 1) return text;
  const [first, ...rest] = lines;
  return `${first}\n… (+${rest.length} more line${rest.length === 1 ? "" : "s"} — ctrl+o to expand)`;
}

/** The text a message actually renders as -- shared by `selectVisibleWindow`'s row-cost estimate
 * and `Transcript`'s own render, so the two can never disagree about how big a message is. An L4
 * VERIFY finding against an earlier version: `selectVisibleWindow` always costed the FULL,
 * uncollapsed `textOf(message)` even when a `toolResult` was actually being rendered collapsed,
 * so the virtualization window hid far more history than the collapsed view actually needed. */
function displayTextFor(message: AgentMessage, toolOutputExpanded: boolean): string {
  const fullText = textOf(message);
  const role = (message as { role: string }).role;
  return role === "toolResult" && !toolOutputExpanded ? summarizeToolResult(fullText) : fullText;
}

export function labelFor(message: AgentMessage): string {
  const role = (message as { role: string }).role;
  if (role === "user") return "You";
  if (role === "assistant") return "nanocode";
  if (role === "toolResult") return `tool:${(message as { toolName?: string }).toolName ?? "?"}`;
  return role;
}

/** How many terminal rows rendering `text` at `width` columns is estimated to take -- a plain
 * char-count/width division, not a real terminal-width-aware wrap (no attempt at grapheme
 * clustering or ANSI-escape-aware measurement); good enough for a virtualization *budget*, which
 * only needs to be roughly right, not exact -- rendering one message too many or few costs nothing
 * beyond a slightly early/late cutoff. */
function estimateLines(text: string, width: number): number {
  if (text.length === 0) return 1;
  return Math.max(1, Math.ceil(text.length / Math.max(1, width)));
}

export interface VisibleWindow {
  visible: AgentMessage[];
  hiddenCount: number;
}

/** Walks backward from the end of `messages`, accumulating estimated row cost (one label row plus
 * the message's own estimated wrapped-text rows) until `rowBudget` would be exceeded, then stops --
 * always keeping at least the single most recent message even if it alone exceeds the budget, so a
 * very long final message is never fully hidden. */
export function selectVisibleWindow(
  messages: readonly AgentMessage[],
  rowBudget: number,
  width: number,
  toolOutputExpanded = false,
): VisibleWindow {
  const visible: AgentMessage[] = [];
  let used = 0;
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const cost = estimateLines(displayTextFor(messages[i], toolOutputExpanded), width) + 1;
    if (used + cost > rowBudget && visible.length > 0) break;
    visible.unshift(messages[i]);
    used += cost;
  }
  return { visible, hiddenCount: messages.length - visible.length };
}

export interface TranscriptProps {
  messages: readonly AgentMessage[];
  /** Partial assistant text still streaming in, rendered below the window without counting toward
   * `messages`'s own virtualization budget (it's always the newest thing on screen). */
  streamingText?: string;
  /** Rows reserved for chrome above/below the transcript (status line, input box, ...). */
  reservedRows?: number;
  /** Ctrl+O toggles this (app.tsx). False (the default) collapses multi-line tool-result messages
   * to their first line -- true shows every tool result in full. Only ever affects `toolResult`
   * messages; user/assistant text is always shown in full regardless. */
  toolOutputExpanded?: boolean;
}

export function Transcript({
  messages,
  streamingText,
  reservedRows = 4,
  toolOutputExpanded = false,
}: TranscriptProps) {
  const { stdout } = useStdout();
  const rows = stdout?.rows ?? 24;
  const width = stdout?.columns ?? 80;
  const budget = Math.max(3, rows - reservedRows);

  const { visible, hiddenCount } = selectVisibleWindow(messages, budget, width, toolOutputExpanded);

  return (
    <Box flexDirection="column">
      {hiddenCount > 0 && (
        <Text dimColor>
          … {hiddenCount} earlier message{hiddenCount === 1 ? "" : "s"} hidden …
        </Text>
      )}
      {visible.map((message, index) => {
        const role = (message as { role: string }).role;
        const displayText = displayTextFor(message, toolOutputExpanded);
        return (
          <Box
            // biome-ignore lint/suspicious/noArrayIndexKey: AgentMessage carries no stable unique id; the index is only a tiebreaker for the rare case of two messages sharing a role+timestamp, not the primary key -- this list only grows/truncates from one end, it never reorders
            key={`${role}-${(message as { timestamp: number }).timestamp}-${index}`}
            flexDirection="column"
            marginBottom={1}
          >
            <Text bold>{labelFor(message)}</Text>
            <Text>{displayText}</Text>
          </Box>
        );
      })}
      {streamingText !== undefined && (
        <Box flexDirection="column">
          <Text bold>nanocode</Text>
          <Text>{streamingText}</Text>
        </Box>
      )}
    </Box>
  );
}
