import { render } from "ink-testing-library";
import { describe, expect, it } from "vitest";
import { StartupBanner } from "../src/banner.tsx";

describe("StartupBanner", () => {
  it("shows nanocode's own name/version and its real keybindings, not pi's", () => {
    const { lastFrame } = render(<StartupBanner version="0.1.0" />);
    const frame = lastFrame() ?? "";
    expect(frame).toContain("nanocode v0.1.0");
    expect(frame).toContain("ctrl+o toggle tool output");
    // pi-specific hints that don't apply to nanocode's single-tool design must never appear here.
    expect(frame).not.toMatch(/\/ commands/);
    expect(frame).not.toMatch(/! bash/);
    expect(frame).not.toMatch(/ripgrep|fd not found/);
  });
});
