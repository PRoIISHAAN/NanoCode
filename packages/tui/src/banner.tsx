// A startup banner, rendered as a normal (non-Static) part of the always-reconciled live tree.
//
// This used to be wrapped in Ink's <Static>, on the theory that a print-once banner should become
// part of the terminal's own scrollback rather than an Ink-managed live region, mirroring how pi's
// own banner behaves. In practice this caused a real, user-visible bug: onboarding's live region
// changes size dramatically between phases (a one-line "Loading providers..." to a 39-item
// provider list, to a model list of hundreds), and Ink has to reconcile that against the frozen
// <Static> region above it -- confirmed directly via a real pseudo-terminal trace, which showed
// Ink emitting a full screen-and-scrollback clear (`\x1b[2J\x1b[3J\x1b[H`) at exactly that
// transition. That full clear is what made onboarding feel like it "took over the whole terminal"
// instead of staying inside a contained TUI. A plain, always-live banner element doesn't trigger
// this: Ink's normal reconciliation redraws content in place via cursor movement, not a full clear,
// regardless of how much the rest of the tree grows or shrinks between renders.
//
// Deliberately does NOT copy pi's literal banner content: fd/ripgrep auto-download messages and a
// "/ commands" hint both describe pi features nanocode doesn't have (nanocode's only tool is the
// persistent Python REPL; there are no slash commands). "! bash" IS a real nanocode feature
// (packages/cli/src/setup.ts's runShellCommand, wired through app.tsx's PromptInput), and behaves
// exactly like pi's own "!": a real host shell process, independent of the model's own Python
// kernel entirely -- pi has no kernel to route through either, so this matches it directly rather
// than inventing a kernel-routed version pi itself doesn't have.
import { Box, Text } from "ink";
// biome-ignore lint/correctness/noUnusedImports: required by tsx's runtime JSX transform, not referenced directly in this file's own code
import React from "react";

export function StartupBanner({ version }: { version: string }) {
  return (
    <Box flexDirection="column" borderStyle="round" paddingX={1}>
      <Text bold>nanocode v{version}</Text>
      <Text dimColor>ctrl+c exit · enter submit · ! bash · ctrl+o toggle tool output</Text>
    </Box>
  );
}
