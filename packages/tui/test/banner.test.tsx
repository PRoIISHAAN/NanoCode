import { render } from "ink-testing-library";
import { describe, expect, it } from "vitest";
import { StartupBanner } from "../src/banner.tsx";

describe("StartupBanner", () => {
  it("shows nanocode's own name/version and its real keybindings, not pi's", () => {
    const { lastFrame } = render(<StartupBanner version="0.1.0" />);
    const frame = lastFrame() ?? "";
    expect(frame).toContain("nanocode v0.1.0");
    expect(frame).toContain("ctrl+o toggle tool output");
    // "! bash" IS a real nanocode feature (the bash-escape convenience) -- unlike the pi-specific
    // hints below, which describe pi features nanocode doesn't have and must never appear here.
    expect(frame).toMatch(/! bash/);
    expect(frame).not.toMatch(/\/ commands/);
    expect(frame).not.toMatch(/ripgrep|fd not found/);
  });
});
