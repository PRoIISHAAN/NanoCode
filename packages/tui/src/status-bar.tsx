// The status data block (cwd + tokens/context/cost/model/reasoning/busy), rendered below the
// prompt box, framed by HorizontalRule above and below the prompt itself (app.tsx's RunningSession
// composes the actual order) -- matching pi's own layout (rule, prompt, rule, cwd, stats), not the
// data-block-above-the-prompt layout this component used to have on its own. Shows real session
// data -- not pi's own undocumented "0.0%/0 (auto) unknown" format, which this project has no way
// to verify the exact meaning of and would just be guessing at reproducing.
import { Box, Text, useStdout } from "ink";
// biome-ignore lint/correctness/noUnusedImports: required by tsx's runtime JSX transform, not referenced directly in this file's own code
import React from "react";

/** A full-width horizontal divider -- used above and below the prompt box, matching pi's layout. */
export function HorizontalRule() {
  const { stdout } = useStdout();
  const width = stdout?.columns ?? 80;
  return <Text dimColor>{"─".repeat(width)}</Text>;
}

export interface StatusBarProps {
  cwd: string;
  /** "<provider>/<model id>", e.g. "openrouter/anthropic/claude-3-haiku". */
  modelLabel: string;
  /** The session's thinking/reasoning level, e.g. "off", "low", "high". */
  reasoningLevel: string;
  busy: boolean;
  /** Cumulative input ("sent") tokens across every assistant message so far this session. */
  totalInputTokens: number;
  /** Cumulative output ("received") tokens across every assistant message so far this session. */
  totalOutputTokens: number;
  /** The most recent assistant message's own input-token count -- an approximation of how much of
   * the context window the *next* request will actually carry (post-compaction, if any ran). */
  contextTokens: number;
  contextWindow: number;
  totalCostUsd: number;
}

function formatPercent(numerator: number, denominator: number): string {
  if (denominator <= 0) return "0.0";
  return ((numerator / denominator) * 100).toFixed(1);
}

/** Compact "200k"-style formatting for the context-window figure -- below 1000 shown as-is,
 * otherwise divided by 1000 with at most one decimal place, dropping a trailing ".0"
 * (200000 -> "200k", 131072 -> "131.1k", 8000 -> "8k"). */
function formatCompactWindow(value: number): string {
  if (value < 1000) return String(value);
  const thousands = Math.round((value / 1000) * 10) / 10;
  return `${Number.isInteger(thousands) ? thousands.toFixed(0) : thousands.toFixed(1)}k`;
}

/** Compact "1.2K"-style formatting for sent/received token counts -- below 1000 shown as-is,
 * otherwise divided by 1000 and always shown to exactly one decimal place (1000 -> "1.0K",
 * 1234 -> "1.2K", 12000 -> "12.0K"), per the user's own explicit example -- unlike the
 * context-window figure above, a whole-thousand count still keeps the ".0" rather than dropping it. */
function formatCompactTokens(value: number): string {
  if (value < 1000) return String(value);
  return `${(value / 1000).toFixed(1)}K`;
}

export function StatusBar({
  cwd,
  modelLabel,
  reasoningLevel,
  busy,
  totalInputTokens,
  totalOutputTokens,
  contextTokens,
  contextWindow,
  totalCostUsd,
}: StatusBarProps) {
  const dataLine =
    `↑${formatCompactTokens(totalInputTokens)} ↓${formatCompactTokens(totalOutputTokens)} · ` +
    `${formatPercent(contextTokens, contextWindow)}%/${formatCompactWindow(contextWindow)} · ` +
    `$${totalCostUsd.toFixed(4)} · ${modelLabel} · ${reasoningLevel} · ${busy ? "busy" : "idle"}`;

  return (
    <Box flexDirection="column">
      <Text dimColor>{cwd}</Text>
      <Text dimColor>{dataLine}</Text>
    </Box>
  );
}
