// A minimal arrow-key list picker, built directly on Ink's own useInput rather than adding
// ink-select-input as a dependency -- the need is small enough that a few dozen lines of original
// code beat an unverified-against-this-project's-Ink/React-versions dependency (see
// decisions/0011-tui-onboarding.md).
import { Box, Text, useInput } from "ink";
// biome-ignore lint/correctness/noUnusedImports: required by tsx's runtime JSX transform, not referenced directly in this file's own code
import React, { useState } from "react";

export interface SelectItem {
  id: string;
  label: string;
  sublabel?: string;
}

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

  return (
    <Box flexDirection="column">
      {items.map((item, index) => (
        <Text key={item.id} color={index === cursor ? "green" : undefined}>
          {index === cursor ? "> " : "  "}
          {item.label}
          {item.sublabel ? ` (${item.sublabel})` : ""}
        </Text>
      ))}
    </Box>
  );
}
