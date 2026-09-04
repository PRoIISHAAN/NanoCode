// The live "/" autocomplete dropdown -- opens the moment the prompt box's text starts with "/",
// narrows as you keep typing, navigable with up/down arrows, matching pi's own slash-command menu.
// Purely presentational: no `useInput` of its own. Two independent `useInput` hooks racing to react
// to the same up/down/Enter keystrokes is exactly the bug class decisions/0012 already found and
// fixed once (ctrl+o vs ink-text-input) -- `PromptInput`'s own hand-rolled input in app.tsx is the
// single place that owns the keyboard and decides what up/down/Enter do, this component only renders
// whatever state it's handed.
import { Box, Text, useStdout } from "ink";
// biome-ignore lint/correctness/noUnusedImports: required by tsx's runtime JSX transform, not referenced directly in this file's own code
import React from "react";
import type { CommandInfo } from "./slash-commands.ts";

/** Capped well below a typical terminal's height, same reasoning as select-list.tsx's own
 * WINDOW_SIZE: an unbounded list (nanocode has 15 commands today) risks a frame tall enough that
 * ink's `shouldClearTerminalForFrame` treats it as a fullscreen frame and wipes the whole terminal
 * on every keystroke -- the exact bug that windowing was already added once to avoid. */
export const MENU_WINDOW_SIZE = 6;
const MARKER_WIDTH = 2; // "→ " or "  "
const NAME_COLUMN_WIDTH = 14;
const GAP_WIDTH = 1; // the single space between the name column and the description

/** Clips `text` to `maxWidth` columns, replacing the tail with "…" if it doesn't fit -- Ink's own
 * `wrap="truncate-end"` needs a Text/Box whose width is explicitly constrained to do this on its
 * own (a plain `<Box flexDirection="column">` sizes to its content instead, so it never actually
 * clips anything, no matter what `wrap` is set to -- confirmed directly: without this function, a
 * long description at a narrow terminal width just overflowed onto a second, unindented line, the
 * exact bug the user reported). Doing it here, in plain string math against `useStdout()`'s real
 * `columns` (the same source `status-bar.tsx`'s `HorizontalRule` already reads), keeps every menu
 * row to exactly one line regardless of terminal width. */
export function truncate(text: string, maxWidth: number): string {
  if (maxWidth <= 0) return "";
  if (text.length <= maxWidth) return text;
  if (maxWidth === 1) return "…";
  return `${text.slice(0, maxWidth - 1)}…`;
}

export function CommandMenu({
  matches,
  highlightIndex,
}: {
  matches: CommandInfo[];
  highlightIndex: number;
}) {
  const { stdout } = useStdout();
  const terminalWidth = stdout?.columns ?? 80;
  const descriptionWidth = Math.max(
    0,
    terminalWidth - MARKER_WIDTH - NAME_COLUMN_WIDTH - GAP_WIDTH,
  );

  if (matches.length === 0) return null;

  const windowSize = Math.min(MENU_WINDOW_SIZE, matches.length);
  const centered = highlightIndex - Math.floor(windowSize / 2);
  const start = Math.max(0, Math.min(centered, matches.length - windowSize));
  const visible = matches.slice(start, start + windowSize);

  return (
    <Box flexDirection="column">
      {visible.map((command, offset) => {
        const index = start + offset;
        const name = command.names[0];
        return (
          <Text key={name} color={index === highlightIndex ? "green" : undefined}>
            {index === highlightIndex ? "→ " : "  "}
            {name.padEnd(NAME_COLUMN_WIDTH)} {truncate(command.description, descriptionWidth)}
          </Text>
        );
      })}
      <Text dimColor>
        ({highlightIndex + 1}/{matches.length})
      </Text>
    </Box>
  );
}
