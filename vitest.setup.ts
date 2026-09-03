// Global test setup (wired via vitest.config.ts's `test.setupFiles`), applying to every package's
// test suite -- not just packages/tui's -- because `cleanup()` is a no-op for any test file that
// never called ink-testing-library's `render()` in the first place, so there's no reason to scope
// this to Ink-based files specifically.
//
// Without this, none of packages/tui/test's Ink-component tests ever unmounted a `render()` call.
// ink-testing-library's `render()` isn't a lightweight fake -- it wraps Ink's own real `render()` (a
// live React reconciler plus Ink's own internal scheduling), so every un-cleaned-up instance stayed
// fully alive for the rest of that test FILE's run. Confirmed directly: packages/tui/test/
// setup-screen.test.tsx's "shows a provider already configured" test passed in isolation and next to
// either one of its two preceding tests alone, but failed once run after BOTH of them together (its
// real position in the file) -- and adding `unmount()` after each of those three tests in an isolated
// repro made the failure disappear across repeated runs. The mechanism: each additional live-but-
// abandoned Ink instance adds real event-loop/scheduling overhead in the same process, until a later
// test's own (sometimes genuinely synchronous, no-async-work-at-all) state transition no longer
// finishes flushing to `lastFrame()` within that test's `wait(...)` budget.
import { cleanup } from "ink-testing-library";
import { afterEach } from "vitest";

afterEach(() => {
  cleanup();
});
