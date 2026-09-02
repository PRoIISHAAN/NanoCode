// A minimal arrow-key list picker, built directly on Ink's own useInput rather than adding
// ink-select-input as a dependency -- the need is small enough that a few dozen lines of original
// code beat an unverified-against-this-project's-Ink/React-versions dependency (see
// decisions/0011-tui-onboarding.md).
//
// Windowed to at most WINDOW_SIZE visible rows regardless of how long `items` is (onboarding's
// real provider list has ~39 entries; some providers' model lists run into the hundreds). This
// isn't cosmetic: Ink itself clears and redraws the whole terminal (`shouldClearTerminalForFrame`
// in ink's own source) whenever a frame's rendered height reaches or exceeds the terminal's
// viewport -- confirmed by reading ink's source directly, not guessed. An unwindowed list that
// size made every onboarding screen taller than most real terminals, so Ink treated it as a
// "fullscreen" frame and wiped the screen on every transition -- which is what actually made
// onboarding feel like it "took over the whole terminal" instead of staying inside a contained
// TUI. Keeping the rendered height small and constant avoids ever triggering that path.
import { Box, Text, useInput } from "ink";
// biome-ignore lint/correctness/noUnusedImports: required by tsx's runtime JSX transform, not referenced directly in this file's own code
import React, { useState } from "react";

export interface SelectItem {
  id: string;
  label: string;
  sublabel?: string;
}

const WINDOW_SIZE = 10;

export function SelectList({
  items,
  onSelect,
}: {
  items: SelectItem[];
  onSelect: (id: string) => void;
}) {
  const [cursor, setCursor] = useState(0);

  useInput((_input, key) => {
    if (key.upArrow) {
      setCursor((current) => Math.max(0, current - 1));
    } else if (key.downArrow) {
      setCursor((current) => Math.min(items.length - 1, current + 1));
    } else if (key.return) {
      const item = items[cursor];
      if (item) onSelect(item.id);
    }
  });

  const windowSize = Math.min(WINDOW_SIZE, items.length);
  // Keep the cursor centered in the window where possible, clamped so the window never runs past
  // either end of the list.
  const centered = cursor - Math.floor(windowSize / 2);
  const start = Math.max(0, Math.min(centered, items.length - windowSize));
  const end = start + windowSize;
  const visible = items.slice(start, end);
  const hiddenAbove = start;
  const hiddenBelow = items.length - end;

  return (
    <Box flexDirection="column">
      {hiddenAbove > 0 && <Text dimColor>↑ {hiddenAbove} more above</Text>}
      {visible.map((item, offset) => {
        const index = start + offset;
        return (
          <Text key={item.id} color={index === cursor ? "green" : undefined}>
            {index === cursor ? "> " : "  "}
            {item.label}
            {item.sublabel ? ` (${item.sublabel})` : ""}
          </Text>
        );
      })}
      {hiddenBelow > 0 && <Text dimColor>↓ {hiddenBelow} more below</Text>}
    </Box>
  );
}
