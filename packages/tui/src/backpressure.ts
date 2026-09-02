// Backpressure-aware streaming updates: hermes-ink's own version throttles against its custom
// reconciler's frame-scheduling internals (markDirty/scheduleRenderFrom), which don't exist in
// upstream Ink (see decisions/0005-tui-stack.md -- nanocode depends on real `ink`, not the
// hermes-ink fork). The lever nanocode actually controls is how often IT calls into React state at
// all: a fast-streaming assistant message can produce many token deltas per second, and updating
// an atom -- and therefore re-rendering -- on every single one wastes work the terminal can't even
// display that fast. This coalesces bursts into a fixed-rate flush of only the LATEST value,
// dropping superseded intermediate ones rather than queueing and replaying every update.
export interface BackpressureQueue<T> {
  /** Records `value` as the latest pending update; schedules a flush if one isn't already pending. */
  push(value: T): void;
  /** Cancels any pending flush without running it. */
  dispose(): void;
}

const DEFAULT_INTERVAL_MS = 33; // ~30fps -- fast enough to feel live, slow enough to coalesce bursts

export function createBackpressureQueue<T>(
  onFlush: (value: T) => void,
  intervalMs = DEFAULT_INTERVAL_MS,
): BackpressureQueue<T> {
  let pending: T | undefined;
  let hasPending = false;
  let timer: ReturnType<typeof setTimeout> | undefined;

  function scheduleFlush(): void {
    if (timer) return; // a flush is already scheduled; it will pick up the latest pending value
    timer = setTimeout(() => {
      timer = undefined;
      if (!hasPending) return;
      const value = pending as T;
      hasPending = false;
      pending = undefined;
      onFlush(value);
    }, intervalMs);
  }

  return {
    push(value: T) {
      pending = value;
      hasPending = true;
      scheduleFlush();
    },
    dispose() {
      if (timer) clearTimeout(timer);
      timer = undefined;
      hasPending = false;
    },
  };
}
