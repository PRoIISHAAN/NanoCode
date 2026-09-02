// SelectList's windowing had zero direct test coverage before this -- it was only ever exercised
// indirectly through setup-screen.test.tsx's small (1-2 item) fixtures, which never exceed the
// window size and so never proved the windowing logic itself does anything.
import { render } from "ink-testing-library";
import { describe, expect, it, vi } from "vitest";
import { type SelectItem, SelectList } from "../src/select-list.tsx";

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function items(count: number): SelectItem[] {
  return Array.from({ length: count }, (_, i) => ({ id: `item-${i}`, label: `Item ${i}` }));
}

describe("SelectList", () => {
  it("renders every item, with no window indicators, when the list fits within the window size", () => {
    const { lastFrame } = render(<SelectList items={items(5)} onSelect={() => {}} />);
    const frame = lastFrame() ?? "";
    for (let i = 0; i < 5; i++) expect(frame).toContain(`Item ${i}`);
    expect(frame).not.toContain("more above");
    expect(frame).not.toContain("more below");
  });

  it("windows a long list to a bounded number of rows, showing a 'more below' indicator", () => {
    const { lastFrame } = render(<SelectList items={items(50)} onSelect={() => {}} />);
    const frame = lastFrame() ?? "";
    const lines = frame.split("\n").filter((l) => l.length > 0);
    // Bounded regardless of the underlying list length -- this is the actual fix: an unwindowed
    // 50-item list would be taller than most real terminals, which is what triggered Ink's own
    // fullscreen clear-and-redraw behavior during onboarding (confirmed via ink's own source,
    // shouldClearTerminalForFrame) and made onboarding feel like it took over the whole terminal.
    expect(lines.length).toBeLessThan(15);
    expect(frame).toContain("Item 0"); // cursor starts at the top of the list
    expect(frame).toContain("more below");
    expect(frame).not.toContain("more above"); // nothing hidden above the very first item yet
    expect(frame).not.toContain("Item 49"); // far off-screen, not yet windowed into view
  });

  it("scrolls the window to keep the cursor visible as it moves down a long list", async () => {
    const { lastFrame, stdin } = render(<SelectList items={items(50)} onSelect={() => {}} />);
    for (let i = 0; i < 20; i++) {
      stdin.write("\x1b[B"); // down arrow
      await wait(2);
    }
    const frame = lastFrame() ?? "";
    expect(frame).toContain("Item 20"); // the cursor's current position must be visible
    expect(frame).toContain("more above");
    expect(frame).toContain("more below");
  });

  it("reaches and shows the last item, with a 'more above' indicator and no 'more below'", async () => {
    const { lastFrame, stdin } = render(<SelectList items={items(50)} onSelect={() => {}} />);
    for (let i = 0; i < 60; i++) {
      // more presses than items -- cursor clamps at the last item, never overshoots
      stdin.write("\x1b[B");
      await wait(1);
    }
    const frame = lastFrame() ?? "";
    expect(frame).toContain("Item 49");
    expect(frame).toContain("more above");
    expect(frame).not.toContain("more below");
  });

  it("still selects the correct item by id when the list is windowed and scrolled", async () => {
    const onSelect = vi.fn();
    const { stdin } = render(<SelectList items={items(50)} onSelect={onSelect} />);
    for (let i = 0; i < 25; i++) {
      stdin.write("\x1b[B");
      await wait(2);
    }
    stdin.write("\r");
    await wait(10);
    expect(onSelect).toHaveBeenCalledWith("item-25");
  });
});
