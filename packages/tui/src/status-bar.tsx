// A framed status panel between the transcript and the prompt box: a horizontal rule, the cwd on
// its own line, a data line with everything else, then a closing horizontal rule. Shows real
// session data -- not pi's own undocumented "0.0%/0 (auto) unknown" format, which this project has
// no way to verify the exact meaning of and would just be guessing at reproducing.
import { Box, Text, useStdout } from "ink";
// biome-ignore lint/correctness/noUnusedImports: required by tsx's runtime JSX transform, not referenced directly in this file's own code
import React from "react";

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

// Explicit "en-US" rather than the host's default locale: `toLocaleString()` with no locale
// argument uses `Intl`'s runtime default, which varies by machine (e.g. an "en-IN" default groups
// digits as 2,00,000, not 200,000) -- a status bar should render identically everywhere, not
// change shape depending on who's running it. Caught by this file's own tests failing in an
// environment whose default locale isn't "en-US".
function formatCount(value: number): string {
  return value.toLocaleString("en-US");
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
  const { stdout } = useStdout();
  const width = stdout?.columns ?? 80;
  const rule = "─".repeat(width);
  const dataLine =
    `↑${formatCount(totalInputTokens)} ↓${formatCount(totalOutputTokens)} tokens · ` +
    `${formatPercent(contextTokens, contextWindow)}% of ${formatCount(contextWindow)} ctx · ` +
    `$${totalCostUsd.toFixed(4)} · ${modelLabel} · ${reasoningLevel} · ${busy ? "busy" : "idle"}`;

  return (
    <Box flexDirection="column">
      <Text dimColor>{rule}</Text>
      <Text dimColor>{cwd}</Text>
      <Text dimColor>{dataLine}</Text>
      <Text dimColor>{rule}</Text>
    </Box>
  );
}
