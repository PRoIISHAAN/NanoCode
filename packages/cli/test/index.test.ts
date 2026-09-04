// index.ts's own dispatch (`main()`): bare `nanocode` (no arguments) launches the interactive TUI
// via tui.tsx's `runTui`, `nanocode run "<prompt>"` reaches the existing headless `run` path
// (setup.ts's createNanocodeSession), and anything else (a bare `run` with no prompt text, or an
// unrecognized first argument) hits printUsageAndExit(), which calls process.exit(1).
//
// `main` is exported (rather than only self-invoked at the bottom of index.ts) specifically so it
// can be called here directly with a controlled process.argv -- the bottom-level self-invocation
// is now guarded to only fire when this module is the actual process entrypoint (see index.ts's
// own comment), so importing it in a test does not also trigger a real, uncontrolled run.
//
// runTui does a lot for real (Ink rendering, trust prompting, kernel/session setup) and
// createNanocodeSession spins up a real kernel/session -- both are mocked here so this stays a fast
// unit test of the dispatch logic itself, not an end-to-end run of either path.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { NanocodeSetup } from "../src/setup.ts";

vi.mock("../src/tui.tsx", () => ({ runTui: vi.fn().mockResolvedValue(undefined) }));
vi.mock("../src/setup.ts", () => ({ createNanocodeSession: vi.fn() }));

const { runTui } = await import("../src/tui.tsx");
const { createNanocodeSession } = await import("../src/setup.ts");
const { main } = await import("../src/index.ts");

const ORIGINAL_ARGV = process.argv;

function setArgs(...args: string[]): void {
  process.argv = [ORIGINAL_ARGV[0] ?? "node", ORIGINAL_ARGV[1] ?? "index.ts", ...args];
}

function fakeSetup(): NanocodeSetup {
  return {
    session: {
      prompt: vi.fn().mockResolvedValue(undefined),
      state: { messages: [] },
    },
    cleanup: vi.fn().mockResolvedValue(undefined),
  } as unknown as NanocodeSetup;
}

beforeEach(() => {
  vi.mocked(runTui).mockClear();
  vi.mocked(createNanocodeSession).mockReset();
  vi.mocked(createNanocodeSession).mockResolvedValue(fakeSetup());
});

afterEach(() => {
  process.argv = ORIGINAL_ARGV;
});

describe("main() dispatch", () => {
  it("with no arguments, calls runTui() exactly once and never touches the headless session path", async () => {
    setArgs();
    await main();
    expect(runTui).toHaveBeenCalledOnce();
    expect(createNanocodeSession).not.toHaveBeenCalled();
  });

  it('with ["run", "<prompt>"], reaches the headless run path instead of runTui', async () => {
    const setup = fakeSetup();
    vi.mocked(createNanocodeSession).mockResolvedValue(setup);
    setArgs("run", "compute 17*23 in python");

    await main();

    expect(runTui).not.toHaveBeenCalled();
    expect(createNanocodeSession).toHaveBeenCalledOnce();
    expect(setup.session.prompt).toHaveBeenCalledWith("compute 17*23 in python");
    expect(setup.cleanup).toHaveBeenCalledOnce();
  });

  describe("usage/error path (process.exit(1) mocked so the test process itself doesn't exit)", () => {
    class ProcessExitCalled extends Error {
      constructor(public code: number | string | null | undefined) {
        super(`process.exit(${String(code)}) called`);
      }
    }

    let exitSpy: ReturnType<typeof vi.spyOn>;

    beforeEach(() => {
      exitSpy = vi.spyOn(process, "exit").mockImplementation((code) => {
        throw new ProcessExitCalled(code);
      });
    });

    afterEach(() => {
      exitSpy.mockRestore();
    });

    it('["run"] with no prompt text hits the usage/error path, not runTui', async () => {
      setArgs("run");
      await expect(main()).rejects.toThrow(ProcessExitCalled);
      expect(exitSpy).toHaveBeenCalledWith(1);
      expect(runTui).not.toHaveBeenCalled();
      expect(createNanocodeSession).not.toHaveBeenCalled();
    });

    it('an unrecognized first argument (e.g. "frobnicate") hits the usage/error path, not runTui', async () => {
      setArgs("frobnicate");
      await expect(main()).rejects.toThrow(ProcessExitCalled);
      expect(exitSpy).toHaveBeenCalledWith(1);
      expect(runTui).not.toHaveBeenCalled();
      expect(createNanocodeSession).not.toHaveBeenCalled();
    });
  });
});
