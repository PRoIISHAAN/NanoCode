import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Run every *.test.ts(x) under any package's test/ or src/ tree -- .tsx for packages/tui's
    // Ink-component tests (M5).
    include: ["packages/*/{src,test}/**/*.test.ts?(x)"],
    // Unmounts every ink-testing-library render() after each test -- see vitest.setup.ts's own
    // header comment for why this is necessary and how it was confirmed. Applied globally (not just
    // to packages/tui) since it's a no-op for any test that never rendered anything through Ink.
    setupFiles: ["./vitest.setup.ts"],
    // Kernel tests spawn a real Python subprocess (see packages/kernel/test) — give those
    // more headroom than Vitest's 5s default so a slow first-time venv bootstrap doesn't
    // flake the suite.
    testTimeout: 20_000,
    // The suite now has 25+ call sites across several packages that spawn real subprocesses
    // (Python kernels, Docker, child processes for CLI/trust tests) -- running test FILES in
    // parallel (Vitest's default) lets many of these compete for CPU scheduling at once, which
    // was observed directly to make the kernel's SIGINT-interrupt test's timing-sensitive signal
    // delivery unreliable (reproduced 3 times: multi-minute hangs to a 20s timeout under full
    // parallel runs, 100% reliable in isolation, and reliably fixed by this setting in a
    // controlled A/B comparison). Running test files sequentially costs little here -- most of the
    // suite is fast in-process unit tests -- and trades a small amount of wall-clock time for a
    // suite that doesn't intermittently hang for minutes.
    fileParallelism: false,
  },
});
