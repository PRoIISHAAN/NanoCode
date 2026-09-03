import { render } from "ink-testing-library";
import { describe, expect, it } from "vitest";
import { COMPACT_HINT, StartupBanner } from "../src/banner.tsx";

// StartupBanner no longer has a two-tier compact/expanded display: once a session exists it settles
// into real, permanent terminal scrollback (see banner.tsx's own header comment), and a value frozen
// into scrollback can't be retroactively expanded any more than a settled tool cell can. So ctrl+o no
// longer touches this component at all -- it always renders the same ASCII-art logo plus the one-line
// `COMPACT_HINT`, and takes no `expanded` prop (TypeScript would error if one were passed). Every
// individual keybinding's own description moved to "/help" instead (slash-commands.ts's
// `KEYBINDINGS`), which is covered by slash-commands.test.ts, not here.
//
// StartupBanner no longer prints any version text at all -- it renders a fixed ASCII-art logo
// (banner.tsx's own `LOGO_LINES`) instead, though the `version` prop is still required by its type,
// so it's still passed below even though nothing checks its value. `LOGO_LINES` itself isn't
// exported, so rather than hardcode a duplicate copy of that multi-line art here (fragile against any
// future tweak to it), this checks for "▒", the fill character the logo is built from and which
// appears nowhere else in the app (confirmed via a repo-wide grep) -- its presence is a reliable,
// drift-proof proxy for "the logo rendered".
describe("StartupBanner", () => {
  it("always shows the ASCII-art logo and the compact hint, with no expandable keybinding list", () => {
    const { lastFrame } = render(<StartupBanner version="0.1.0" />);
    const frame = lastFrame() ?? "";
    expect(frame).toContain("▒"); // the ASCII-art logo rendered
    expect(frame).toContain(COMPACT_HINT);
    // Nothing keybinding-list-specific leaks in -- these strings would only appear if a full
    // KEYBINDINGS list were somehow still being rendered here (it now lives in "/help" instead).
    expect(frame).not.toContain("ctrl+z");
    expect(frame).not.toContain("to suspend");
  });
});
