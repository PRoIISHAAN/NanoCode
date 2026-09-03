// A startup banner, rendered as a normal (non-Static) part of the always-reconciled live tree
// during onboarding (no session yet) -- app.tsx's own `SettledBanner` wraps this in Ink's
// `<Static>` instead once a session exists, so it prints once, permanently, at the very top of the
// real terminal scrollback, ahead of the (also-`<Static>`) transcript. Two different components use
// this the two different ways deliberately: mixing `<Static>` with onboarding's OWN live region --
// which changes size dramatically between phases, a one-line "Loading providers..." to a 39-item
// provider list, to a model list of hundreds -- was a real, confirmed bug (Ink emitting a full
// screen-and-scrollback clear, `\x1b[2J\x1b[3J\x1b[H`, right at that transition, which is what made
// onboarding feel like it "took over the whole terminal"), so onboarding keeps this plain and live.
// A running session's own live region (rules/prompt/status) doesn't have that problem -- it's small
// and roughly constant-sized -- so nothing stops the banner from settling into real scrollback there
// too, which is exactly what fixed a real, reported bug of its own: mixing a live banner with an
// otherwise-`<Static>` transcript made Ink redraw the ENTIRE live region (banner included) as one
// contiguous block trailing behind the newest static content on every new message, so the banner
// visibly "sank" to just above the prompt instead of staying pinned at the actual top.
//
// No longer a two-tier compact/expanded hint: ctrl+o used to also expand this into the full
// keybinding list (matching pi's own ctrl+o, which does both at once), but a banner that's
// permanently frozen into real scrollback the moment a session starts can't be retroactively
// expanded any more than a settled tool cell can -- the same rule this project already applies to
// ctrl+o/ctrl+t and the transcript (decisions/0014-header-menu-and-editing.md's Static follow-up).
// Every keybinding's own description now lives in `/help` instead (slash-commands.ts's
// `KEYBINDINGS`), which isn't subject to that freezing at all since it's a fresh notice printed on
// demand, not something toggled in place.
import { Box, Text } from "ink";
// biome-ignore lint/correctness/noUnusedImports: required by tsx's runtime JSX transform, not referenced directly in this file's own code
import React from "react";

// A JS string array, not literal JSX text: JSX collapses a text child's internal newlines/repeated
// whitespace down to single spaces, which would destroy this art's exact alignment. Rendering each
// line as its own <Text> from this array (an interpolated *expression*, not literal JSX text)
// sidesteps that entirely -- each line's spacing reaches the terminal byte-for-byte.
const LOGO_LINES = [
  "▒▒▒╗   ▒▒╗ ▒▒▒▒▒╗ ▒▒▒╗   ▒▒╗ ▒▒▒▒▒▒╗  ▒▒▒▒▒▒╗ ▒▒▒▒▒▒╗ ▒▒▒▒▒▒╗ ▒▒▒▒▒▒▒╗",
  "▒▒▒▒╗  ▒▒║▒▒╔══▒▒╗▒▒▒▒╗  ▒▒║▒▒╔═══▒▒╗▒▒╔════╝▒▒╔═══▒▒╗▒▒╔══▒▒╗▒▒╔════╝",
  "▒▒╔▒▒╗ ▒▒║▒▒▒▒▒▒▒║▒▒╔▒▒╗ ▒▒║▒▒║   ▒▒║▒▒║     ▒▒║   ▒▒║▒▒║  ▒▒║▒▒▒▒▒╗  ",
  "▒▒║╚▒▒╗▒▒║▒▒╔══▒▒║▒▒║╚▒▒╗▒▒║▒▒║   ▒▒║▒▒║     ▒▒║   ▒▒║▒▒║  ▒▒║▒▒╔══╝  ",
  "▒▒║ ╚▒▒▒▒║▒▒║  ▒▒║▒▒║ ╚▒▒▒▒║╚▒▒▒▒▒▒╔╝╚▒▒▒▒▒▒╗╚▒▒▒▒▒▒╔╝▒▒▒▒▒▒╔╝▒▒▒▒▒▒▒╗",
  "╚═╝  ╚═══╝╚═╝  ╚═╝╚═╝  ╚═══╝ ╚═════╝  ╚═════╝ ╚═════╝ ╚═════╝ ╚══════╝",
];

export const COMPACT_HINT =
  "escape interrupt · ctrl+c/ctrl+d clear/exit · / commands · ! bash · /help for keybindings";

export function StartupBanner(_: { version: string }) {
  return (
    <Box flexDirection="column" borderStyle="round" paddingX={1}>
      <Box flexDirection="column">
        {LOGO_LINES.map((line, index) => (
          // biome-ignore lint/suspicious/noArrayIndexKey: LOGO_LINES is a fixed, never-reordered constant -- index is a perfectly stable key here.
          <Text key={index} bold>
            {line}
          </Text>
        ))}
      </Box>
      <Text dimColor>{COMPACT_HINT}</Text>
    </Box>
  );
}
