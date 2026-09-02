// A one-time startup banner, printed once and never redrawn -- Ink's <Static> is the right
// primitive for this (unlike the transcript/status bar below it, which redraw in place every
// frame): the banner becomes part of the terminal's own scrollback, exactly like pi's own startup
// banner does, rather than being an Ink-managed live region.
//
// Deliberately does NOT copy pi's literal banner content: fd/ripgrep auto-download messages, a
// "/ commands" hint, and a "! bash" hint all describe pi features nanocode doesn't have (nanocode's
// only tool is the persistent Python REPL; shell commands run via Python's own subprocess module
// inside it, not a UI-level "!" prefix). This lists nanocode's own real keybindings instead.
import { Box, Static, Text } from "ink";
// biome-ignore lint/correctness/noUnusedImports: required by tsx's runtime JSX transform, not referenced directly in this file's own code
import React from "react";

export function StartupBanner({ version }: { version: string }) {
  return (
    <Static items={["banner"]}>
      {(key) => (
        <Box key={key} flexDirection="column" borderStyle="round" paddingX={1}>
          <Text bold>nanocode v{version}</Text>
          <Text dimColor>ctrl+c exit · enter submit · ctrl+o toggle tool output</Text>
        </Box>
      )}
    </Static>
  );
}
