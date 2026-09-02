import { render } from "ink-testing-library";
import { describe, expect, it } from "vitest";
import { StatusBar } from "../src/status-bar.tsx";

const BASE_PROPS = {
  cwd: "/home/me/project",
  modelLabel: "openrouter/anthropic/claude-3-haiku",
  reasoningLevel: "off",
  busy: false,
  totalInputTokens: 1234,
  totalOutputTokens: 567,
  contextTokens: 2000,
  contextWindow: 200_000,
  totalCostUsd: 0.1234,
};

describe("StatusBar", () => {
  it("frames the panel with a horizontal bar above and below, cwd alone on the line right after the top one", () => {
    const { lastFrame } = render(<StatusBar {...BASE_PROPS} />);
    const lines = (lastFrame() ?? "").split("\n");
    // At least two full-width horizontal rules, and the cwd sits alone (no other data) on the
    // line immediately following the first one -- exactly the "cwd in the upper line" layout.
    const ruleLines = lines.filter((line) => /^─+$/.test(line));
    expect(ruleLines.length).toBeGreaterThanOrEqual(2);
    const firstRuleIndex = lines.indexOf(ruleLines[0]);
    expect(lines[firstRuleIndex + 1]).toBe("/home/me/project");
  });

  it("puts every other data point together in the block below cwd, not mixed into the cwd line itself", () => {
    const { lastFrame } = render(<StatusBar {...BASE_PROPS} />);
    const lines = (lastFrame() ?? "").split("\n");
    const cwdIndex = lines.indexOf("/home/me/project");
    const closingRuleIndex = lines.findIndex((line, i) => i > cwdIndex && /^─+$/.test(line));
    // Everything between cwd and the closing rule is the data block -- joined back together since
    // Ink wraps a long Text onto multiple physical lines at typical terminal widths (this data
    // line, combining tokens/context/cost/model/reasoning/busy, is long enough to do exactly
    // that); the wrap itself is normal Ink behavior, not something this test should be brittle
    // against the exact line count of.
    const dataBlock = lines.slice(cwdIndex + 1, closingRuleIndex).join(" ");
    expect(dataBlock).toContain("↑1,234");
    expect(dataBlock).toContain("↓567");
    expect(dataBlock).toContain("1.0% of 200,000 ctx"); // 2000 / 200000 = 1.0%
    expect(dataBlock).toContain("$0.1234");
    expect(dataBlock).toContain("openrouter/anthropic/claude-3-haiku");
    expect(dataBlock).toContain("off");
    expect(dataBlock).toContain("idle");
  });

  it("shows busy instead of idle while a turn is running", () => {
    const { lastFrame } = render(<StatusBar {...BASE_PROPS} busy={true} />);
    expect(lastFrame()).toContain("busy");
    expect(lastFrame()).not.toContain("idle");
  });

  it("shows 0.0% (not NaN/Infinity) when contextWindow is 0", () => {
    const { lastFrame } = render(
      <StatusBar {...BASE_PROPS} contextTokens={0} contextWindow={0} totalCostUsd={0} />,
    );
    const frame = lastFrame() ?? "";
    expect(frame).toContain("0.0% of 0 ctx");
    expect(frame).not.toContain("NaN");
    expect(frame).not.toContain("Infinity");
  });
});
