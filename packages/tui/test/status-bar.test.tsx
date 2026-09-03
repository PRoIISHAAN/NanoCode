import { render } from "ink-testing-library";
import { describe, expect, it } from "vitest";
import { StatusBar } from "../src/status-bar.tsx";

const BASE_PROPS = {
  cwd: "/home/me/project",
  modelLabel: "openrouter/anthropic/claude-3-haiku",
  reasoningLevel: "off",
  totalInputTokens: 1234,
  totalOutputTokens: 567,
  contextTokens: 2000,
  contextWindow: 200_000,
  totalCostUsd: 0.1234,
};

describe("StatusBar", () => {
  // StatusBar itself no longer draws the horizontal rules -- app.tsx's RunningSession frames the
  // *prompt box* with HorizontalRule (matching pi's layout: rule, prompt, rule, cwd, stats), and
  // StatusBar is just the cwd + data block that goes below the second rule. That framing is
  // covered at the App level (packages/tui/test/app.test.tsx), not here.
  it("shows cwd alone on its own line, with every other data point on the line below it", () => {
    const { lastFrame } = render(<StatusBar {...BASE_PROPS} />);
    const lines = (lastFrame() ?? "").split("\n");
    expect(lines[0]).toBe("/home/me/project");
    const dataBlock = lines.slice(1).join(" ");
    expect(dataBlock).toContain("↑1.2K"); // 1234 -> compact "1.2K"
    expect(dataBlock).toContain("↓567"); // below 1000 -- no "K" suffix
    expect(dataBlock).toContain("1.0%/200k"); // 2000 / 200000 = 1.0%, 200000 -> "200k"
    expect(dataBlock).toContain("$0.1234");
    expect(dataBlock).toContain("openrouter/anthropic/claude-3-haiku");
    expect(dataBlock).toContain("off");
  });

  it("shows 0.0% (not NaN/Infinity) when contextWindow is 0", () => {
    const { lastFrame } = render(
      <StatusBar {...BASE_PROPS} contextTokens={0} contextWindow={0} totalCostUsd={0} />,
    );
    const frame = lastFrame() ?? "";
    expect(frame).toContain("0.0%/0");
    expect(frame).not.toContain("NaN");
    expect(frame).not.toContain("Infinity");
  });

  it("compacts the context window with a 'k' suffix, rounding to one decimal when not a whole thousand", () => {
    const { lastFrame } = render(<StatusBar {...BASE_PROPS} contextWindow={131_072} />);
    const frame = lastFrame() ?? "";
    expect(frame).toContain("/131.1k");
  });

  it("shows a sub-1000 context window as a plain number, no 'k' suffix", () => {
    const { lastFrame } = render(
      <StatusBar {...BASE_PROPS} contextTokens={0} contextWindow={512} />,
    );
    const frame = lastFrame() ?? "";
    expect(frame).toContain("/512");
    expect(frame).not.toContain("/512k");
  });

  it("compacts sent/received token counts above 999 with an uppercase 'K', leaves smaller counts plain", () => {
    const { lastFrame } = render(
      <StatusBar {...BASE_PROPS} totalInputTokens={1000} totalOutputTokens={999} />,
    );
    const frame = lastFrame() ?? "";
    expect(frame).toContain("↑1.0K"); // whole-thousand token counts still keep the ".0"
    expect(frame).toContain("↓999");
  });

  it("always shows exactly one decimal place for a K-suffixed token count, even a whole thousand", () => {
    const { lastFrame } = render(
      <StatusBar {...BASE_PROPS} totalInputTokens={1234} totalOutputTokens={12_000} />,
    );
    const frame = lastFrame() ?? "";
    expect(frame).toContain("↑1.2K");
    expect(frame).toContain("↓12.0K"); // NOT "12K" -- tokens always keep the decimal place
  });
});
