// CommandMenu (packages/tui/src/command-menu.tsx): the live "/" autocomplete dropdown's purely
// presentational rendering -- windowing/highlighting/footer only, no keyboard handling of its own
// (that's app.test.tsx's job, since PromptInput in app.tsx is the thing that actually owns the
// keyboard). select-list.test.tsx is the closest existing template for testing a windowed list
// component, since it also has to prove windowing math against a long list, not just render once.
import { render } from "ink-testing-library";
import { describe, expect, it } from "vitest";
import { CommandMenu, truncate } from "../src/command-menu.tsx";
import type { CommandInfo } from "../src/slash-commands.ts";

// A note on why the truncation tests below are split into two very different styles:
// `ink-testing-library`'s `render()` cannot simulate a narrower terminal. Its fake `Stdout` class
// hardcodes `get columns() { return 100; }` unconditionally -- there is no option to `render()`
// that changes it, and `command-menu.tsx` reads width via `useStdout().stdout?.columns`, so every
// `<CommandMenu>` rendered through this library sees exactly 100 columns, no matter what. That
// means we can't prove truncation-at-a-narrow-terminal by shrinking the simulated terminal; the
// only lever available is the description text's own length, tested against the fixed 100-column
// width. So:
//   - The `describe("truncate", ...)` block below exhaustively tests every boundary of the
//     `truncate` helper as a plain pure function, with no rendering and no fake terminal at all.
//   - The integration tests inside `describe("CommandMenu", ...)` instead use a description
//     string deliberately longer than the usable width at the fixed 100 columns to prove the
//     component really does call `truncate` with the real computed `descriptionWidth` during a
//     render, not just that the helper works in isolation.

function matches(count: number): CommandInfo[] {
  return Array.from({ length: count }, (_, i) => ({
    names: [`cmd${i}`],
    usage: `/cmd${i}`,
    description: `Description ${i}`,
  }));
}

/** Extracts the exact command name shown on each visible row -- NOT a plain `frame.includes(...)`
 * substring check, which would false-positive: "cmd1" is itself a substring of "cmd10"..."cmd14",
 * so a naive `toContain("cmd1")` can't tell a 1-item window from a 6-item one once double-digit
 * names are in play. */
function visibleNames(frame: string): string[] {
  return frame
    .split("\n")
    .map((line) => line.slice(2).trim().split(/\s+/)[0])
    .filter((token): token is string => !!token && /^cmd\d+$/.test(token));
}

describe("CommandMenu", () => {
  it("renders nothing when there are no matches", () => {
    const { lastFrame } = render(<CommandMenu matches={[]} highlightIndex={0} />);
    expect(lastFrame()).toBe("");
  });

  it("renders every entry, with no more than 6 visible, when the list fits within the window", () => {
    const { lastFrame } = render(<CommandMenu matches={matches(4)} highlightIndex={0} />);
    const frame = lastFrame() ?? "";
    expect(visibleNames(frame)).toEqual(["cmd0", "cmd1", "cmd2", "cmd3"]);
    for (let i = 0; i < 4; i++) expect(frame).toContain(`Description ${i}`);
    expect(frame).toContain("(1/4)");
  });

  it("marks only the highlighted entry with the '→ ' marker", () => {
    const { lastFrame } = render(<CommandMenu matches={matches(3)} highlightIndex={1} />);
    const lines = (lastFrame() ?? "").split("\n");
    const highlighted = lines.filter((line) => line.startsWith("→ "));
    expect(highlighted).toHaveLength(1);
    expect(highlighted[0]).toContain("cmd1");
    // The other two visible entries use the "  " (non-highlighted) prefix instead.
    expect(lines.some((line) => line.startsWith("  cmd0"))).toBe(true);
    expect(lines.some((line) => line.startsWith("  cmd2"))).toBe(true);
  });

  it("shows the correct '(highlighted/total)' footer at the start, middle, and end of a long list", () => {
    const list = matches(15);
    expect(render(<CommandMenu matches={list} highlightIndex={0} />).lastFrame()).toContain(
      "(1/15)",
    );
    expect(render(<CommandMenu matches={list} highlightIndex={7} />).lastFrame()).toContain(
      "(8/15)",
    );
    expect(render(<CommandMenu matches={list} highlightIndex={14} />).lastFrame()).toContain(
      "(15/15)",
    );
  });

  it("never shows more than 6 entries even with 15 matches", () => {
    const { lastFrame } = render(<CommandMenu matches={matches(15)} highlightIndex={7} />);
    expect(visibleNames(lastFrame() ?? "")).toHaveLength(6);
  });

  it("windows a long list centered on the highlight near the top of the list", () => {
    const { lastFrame } = render(<CommandMenu matches={matches(15)} highlightIndex={0} />);
    // Clamped so the window never runs past the start of the list -- entries 0..5 visible.
    expect(visibleNames(lastFrame() ?? "")).toEqual([
      "cmd0",
      "cmd1",
      "cmd2",
      "cmd3",
      "cmd4",
      "cmd5",
    ]);
  });

  it("windows a long list centered on the highlight in the middle of the list", () => {
    const { lastFrame } = render(<CommandMenu matches={matches(15)} highlightIndex={7} />);
    // Centered window of size 6 around index 7: floor(6/2) = 3, so start = 7 - 3 = 4 -> [4..9].
    expect(visibleNames(lastFrame() ?? "")).toEqual([
      "cmd4",
      "cmd5",
      "cmd6",
      "cmd7",
      "cmd8",
      "cmd9",
    ]);
  });

  it("windows a long list clamped at the end of the list, never running past the last entry", () => {
    const { lastFrame } = render(<CommandMenu matches={matches(15)} highlightIndex={14} />);
    // Clamped so the window never runs past the end of the list -- entries 9..14 visible.
    expect(visibleNames(lastFrame() ?? "")).toEqual([
      "cmd9",
      "cmd10",
      "cmd11",
      "cmd12",
      "cmd13",
      "cmd14",
    ]);
  });

  it("shows the exact footer for a 1-entry list too", () => {
    const { lastFrame } = render(<CommandMenu matches={matches(1)} highlightIndex={0} />);
    const frame = lastFrame() ?? "";
    expect(visibleNames(frame)).toEqual(["cmd0"]);
    expect(frame).toContain("(1/1)");
  });

  // ink-testing-library's fake terminal is fixed at 100 columns (see the file-level comment above),
  // so the usable description width for these two tests is exactly:
  //   100 (fixed fake terminal columns) - 2 (MARKER_WIDTH) - 14 (NAME_COLUMN_WIDTH) - 1 (GAP_WIDTH) = 83
  // A row's rendered text is `{marker}{name.padEnd(14)} {description}`, so the description portion
  // of a line starts at character index 2 + 14 + 1 = 17.
  const DESCRIPTION_COLUMN_START = 17;
  const USABLE_DESCRIPTION_WIDTH = 83;

  it("truncates a description that is longer than the real usable width computed during render", () => {
    // Length (100) only needs to exceed 83; the exact content doesn't matter, only that truncate()
    // is provably being invoked with the real computed descriptionWidth, not skipped entirely.
    const longDescription = "abcdefghij".repeat(10);
    expect(longDescription.length).toBeGreaterThan(USABLE_DESCRIPTION_WIDTH);

    const list: CommandInfo[] = [
      { names: ["longcmd"], usage: "/longcmd", description: longDescription },
    ];
    const { lastFrame } = render(<CommandMenu matches={list} highlightIndex={0} />);
    const frame = lastFrame() ?? "";
    const line = frame.split("\n").find((l) => l.includes("longcmd"));
    expect(line).toBeDefined();

    const renderedDescription = (line ?? "").slice(DESCRIPTION_COLUMN_START);
    expect(renderedDescription).toBe(truncate(longDescription, USABLE_DESCRIPTION_WIDTH));
    expect(renderedDescription).toHaveLength(USABLE_DESCRIPTION_WIDTH);
    expect(renderedDescription.endsWith("…")).toBe(true);
  });

  it("does not truncate a description well under the real usable width computed during render", () => {
    const shortDescription = "A short description well under the limit";
    expect(shortDescription.length).toBeLessThan(USABLE_DESCRIPTION_WIDTH);

    const list: CommandInfo[] = [
      { names: ["shortcmd"], usage: "/shortcmd", description: shortDescription },
    ];
    const { lastFrame } = render(<CommandMenu matches={list} highlightIndex={0} />);
    const frame = lastFrame() ?? "";
    const line = frame.split("\n").find((l) => l.includes("shortcmd"));
    expect(line).toBeDefined();

    const renderedDescription = (line ?? "").slice(DESCRIPTION_COLUMN_START);
    expect(renderedDescription).toBe(shortDescription);
    expect(renderedDescription.endsWith("…")).toBe(false);
  });
});

describe("truncate", () => {
  it("returns text unchanged when it is shorter than maxWidth", () => {
    expect(truncate("short", 20)).toBe("short");
  });

  it("returns text unchanged when its length is exactly equal to maxWidth", () => {
    expect(truncate("exact", 5)).toBe("exact");
  });

  it("clips text longer than maxWidth to exactly maxWidth characters, with the tail replaced by an ellipsis", () => {
    const text = "this text is definitely longer than ten characters";
    const result = truncate(text, 10);
    expect(result).toHaveLength(10);
    expect(result.endsWith("…")).toBe(true);
    // The remaining maxWidth - 1 characters must be an exact prefix of the original text.
    expect(result.slice(0, 9)).toBe(text.slice(0, 9));
  });

  it("returns an empty string when maxWidth is 0", () => {
    expect(truncate("anything", 0)).toBe("");
  });

  it("returns exactly the ellipsis alone when maxWidth is 1, even for very long text", () => {
    expect(truncate("a".repeat(200), 1)).toBe("…");
  });

  it("returns text unchanged, with no padding added, when maxWidth exceeds the text's own length", () => {
    const text = "short";
    const result = truncate(text, 1000);
    expect(result).toBe(text);
    expect(result.length).toBe(text.length);
  });

  it("clips to the first character plus an ellipsis when maxWidth is 2 (sanity check of the ellipsis-reserves-one-char logic)", () => {
    const result = truncate("hello world", 2);
    expect(result).toBe("h…");
    expect(result).toHaveLength(2);
  });
});
