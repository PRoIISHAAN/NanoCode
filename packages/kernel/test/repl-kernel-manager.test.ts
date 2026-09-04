import { existsSync } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ReplKernelManager, resolveKernelPackageRoot } from "../src/repl-kernel-manager.ts";

const MODULE_SPECIFIER = "../src/repl-kernel-manager.ts";

// These spawn the real Python kernel subprocess -- no mocking. That's deliberate: the interesting
// bugs in a kernel bridge (fd handling, JSON-lines framing, process lifecycle) don't show up
// against a fake, and the vitest.config.ts root timeout is already raised to accommodate a real
// subprocess spawn.
describe("ReplKernelManager", () => {
  let manager: ReplKernelManager | undefined;

  afterEach(async () => {
    await manager?.shutdown();
    manager = undefined;
  });

  it("starts, executes a cell, and returns its result", async () => {
    manager = new ReplKernelManager();
    const result = await manager.execute("17 * 23");
    expect(result.status).toBe("ok");
    expect(result.result).toBe("391");
    expect(result.stdout).toBe("");
  });

  it("captures stdout separately from the trailing expression result", async () => {
    manager = new ReplKernelManager();
    const result = await manager.execute('print("hello")\n1 + 1');
    expect(result.status).toBe("ok");
    expect(result.stdout).toBe("hello\n");
    expect(result.result).toBe("2");
  });

  it("persists namespace state across separate execute() calls", async () => {
    manager = new ReplKernelManager();
    await manager.execute("x = 40");
    const result = await manager.execute("x + 2");
    expect(result.status).toBe("ok");
    expect(result.result).toBe("42");
  });

  it("reports a Python exception as an error result, not a rejected promise", async () => {
    manager = new ReplKernelManager();
    const result = await manager.execute("1 / 0");
    expect(result.status).toBe("error");
    expect(result.error?.ename).toBe("ZeroDivisionError");
  });

  it("supports top-level await", async () => {
    manager = new ReplKernelManager();
    const result = await manager.execute("import asyncio\nawait asyncio.sleep(0)\n'done'");
    expect(result.status).toBe("ok");
    expect(result.result).toBe("'done'");
  });

  it("serializes concurrent execute() calls instead of racing them", async () => {
    manager = new ReplKernelManager();
    const [a, b] = await Promise.all([
      manager.execute("import time\ntime.sleep(0.05)\ncounter = 1\ncounter"),
      manager.execute("counter = counter + 1\ncounter"),
    ]);
    expect(a.status).toBe("ok");
    expect(b.status).toBe("ok");
    // If these had run out of order or concurrently, the second read of `counter` could see an
    // undefined name instead of 2.
    expect(b.result).toBe("2");
  });

  it("interrupts a running cell with a KeyboardInterrupt, and the kernel keeps serving after", async () => {
    manager = new ReplKernelManager();
    const runningCell = manager.execute("import time\nwhile True:\n    time.sleep(0.01)");
    // Give the cell a moment to actually be the in-flight execution before targeting it.
    await new Promise((resolve) => setTimeout(resolve, 100));
    await manager.interrupt();
    const interrupted = await runningCell;
    expect(interrupted.status).toBe("error");
    expect(interrupted.error?.ename).toBe("KeyboardInterrupt");

    // The kernel must still be usable afterward -- an interrupt must not leave it wedged.
    const followUp = await manager.execute("1 + 1");
    expect(followUp.status).toBe("ok");
    expect(followUp.result).toBe("2");
  });

  it("interrupts a synchronous (non-await-suspended) busy loop too", async () => {
    manager = new ReplKernelManager();
    // No `await` anywhere in this cell: it occupies the event loop's single thread directly,
    // exercising the "signal lands mid-step of the cell's own task" path rather than the
    // "loop idle at an await" path the previous test exercises.
    const runningCell = manager.execute("x = 0\nwhile True:\n    x += 1");
    await new Promise((resolve) => setTimeout(resolve, 100));
    await manager.interrupt();
    const interrupted = await runningCell;
    expect(interrupted.status).toBe("error");
    expect(interrupted.error?.ename).toBe("KeyboardInterrupt");

    const followUp = await manager.execute("1 + 1");
    expect(followUp.status).toBe("ok");
    expect(followUp.result).toBe("2");
  });

  it("shuts down cleanly and rejects further execute() calls", async () => {
    manager = new ReplKernelManager();
    await manager.execute("1");
    await manager.shutdown();
    await expect(manager.execute("1")).rejects.toThrow();
  });
});

// resolveKernelPackageRoot: computes PYTHONPATH's root by trying the dev-mode relative offset
// (`../python` from this file's own location) first, falling back to a bundled-mode offset
// (`../../kernel/python`, needed once scripts/build.mjs started bundling this file's code into
// packages/cli/dist/cli.js -- two directories further from packages/kernel/python than the
// unbundled source file is) and throwing if neither exists on disk.
//
// KERNEL_PACKAGE_ROOT is computed once at module load time (a top-level `const`), so exercising
// different existsSync() outcomes against it means getting a genuinely fresh module evaluation per
// case -- vi.resetModules() plus a dynamic import() per test, with node:fs mocked (via vi.doMock,
// not the hoisted vi.mock) BEFORE each fresh import. The plain, real-filesystem case doesn't need
// any of that: it calls the already-statically-imported function directly, with no mocking active.
describe("resolveKernelPackageRoot", () => {
  afterEach(() => {
    vi.doUnmock("node:fs");
    vi.resetModules();
  });

  it("resolves to the real, existing packages/kernel/python directory in the normal, unmocked dev layout", () => {
    const root = resolveKernelPackageRoot();
    expect(existsSync(root)).toBe(true);
    expect(path.basename(root)).toBe("python");
    // Confirm it's genuinely the kernel's python package root, not just some directory that
    // happens to exist.
    expect(existsSync(path.join(root, "nanocode_kernel"))).toBe(true);
  });

  it("falls back to the bundled-mode candidate when the dev-relative candidate doesn't exist", async () => {
    const existsSyncMock = vi.fn<(candidate: string) => boolean>();
    // First existsSync() call the module makes (computing its top-level KERNEL_PACKAGE_ROOT
    // constant) is the dev candidate -- report it missing. Second call is the bundled candidate --
    // report it present. Only two calls happen in total: the module evaluates
    // resolveKernelPackageRoot() exactly once, at import time, to compute KERNEL_PACKAGE_ROOT.
    existsSyncMock.mockReturnValueOnce(false).mockReturnValueOnce(true);
    vi.doMock("node:fs", () => ({ existsSync: existsSyncMock }));
    vi.resetModules();

    const fresh = await import(MODULE_SPECIFIER);

    expect(existsSyncMock).toHaveBeenCalledTimes(2);
    // KERNEL_PACKAGE_ROOT ends up as exactly the second (bundled) candidate it checked, not the
    // first -- proving the fallback actually happened rather than the dev candidate being used
    // unconditionally.
    expect(fresh.KERNEL_PACKAGE_ROOT).toBe(existsSyncMock.mock.calls[1]?.[0]);
  });

  it("throws a clear error (rather than returning a bad path) when neither candidate exists", async () => {
    vi.doMock("node:fs", () => ({ existsSync: vi.fn().mockReturnValue(false) }));
    vi.resetModules();

    // KERNEL_PACKAGE_ROOT is computed at the top of the module, so a fresh import itself rejects.
    await expect(import(MODULE_SPECIFIER)).rejects.toThrow(
      /Could not locate the kernel's python package/,
    );
  });
});
