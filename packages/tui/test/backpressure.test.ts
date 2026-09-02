import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createBackpressureQueue } from "../src/backpressure.ts";

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("createBackpressureQueue", () => {
  it("coalesces a burst of pushes into a single flush of the latest value", () => {
    const onFlush = vi.fn();
    const queue = createBackpressureQueue<number>(onFlush, 33);

    queue.push(1);
    queue.push(2);
    queue.push(3);
    expect(onFlush).not.toHaveBeenCalled(); // nothing flushed yet -- still within the interval

    vi.advanceTimersByTime(33);
    expect(onFlush).toHaveBeenCalledTimes(1);
    expect(onFlush).toHaveBeenCalledWith(3); // only the latest value, not 1 and 2 as well
  });

  it("schedules a new flush for pushes after the previous flush completed", () => {
    const onFlush = vi.fn();
    const queue = createBackpressureQueue<number>(onFlush, 33);

    queue.push(1);
    vi.advanceTimersByTime(33);
    expect(onFlush).toHaveBeenCalledTimes(1);

    queue.push(2);
    vi.advanceTimersByTime(33);
    expect(onFlush).toHaveBeenCalledTimes(2);
    expect(onFlush).toHaveBeenLastCalledWith(2);
  });

  it("dispose() cancels a pending flush", () => {
    const onFlush = vi.fn();
    const queue = createBackpressureQueue<number>(onFlush, 33);

    queue.push(1);
    queue.dispose();
    vi.advanceTimersByTime(100);

    expect(onFlush).not.toHaveBeenCalled();
  });
});
