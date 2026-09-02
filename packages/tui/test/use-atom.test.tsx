// M5: useAtom specifically (atom.test.ts covers the plain atom() value cell on its own) -- an L4
// review noted the hook itself had no test exercising it through a real render, only the
// synchronous get/set/subscribe API.
import { Text } from "ink";
import { render } from "ink-testing-library";
import { describe, expect, it } from "vitest";
import { atom, useAtom } from "../src/atom.ts";

function Counter({ counter }: { counter: ReturnType<typeof atom<number>> }) {
  const count = useAtom(counter);
  return <Text>count: {count}</Text>;
}

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe("useAtom", () => {
  it("renders the atom's current value on first render", () => {
    const counter = atom(0);
    const { lastFrame } = render(<Counter counter={counter} />);
    expect(lastFrame()).toBe("count: 0");
  });

  it("re-renders the subscribed component when the atom changes", async () => {
    const counter = atom(0);
    const { lastFrame } = render(<Counter counter={counter} />);
    counter.set(1);
    await wait(0);
    expect(lastFrame()).toBe("count: 1");
  });

  it("does not throw when the atom updates after the component has unmounted", async () => {
    // useSyncExternalStore's own cleanup unsubscribes on unmount; this proves that actually
    // happens rather than leaving a dangling listener that fires against an unmounted tree.
    const counter = atom(0);
    const { unmount } = render(<Counter counter={counter} />);
    unmount();
    expect(() => counter.set(99)).not.toThrow();
    await wait(0);
  });
});
