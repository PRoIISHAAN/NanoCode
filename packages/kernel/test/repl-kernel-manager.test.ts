import { afterEach, describe, expect, it } from "vitest";
import { ReplKernelManager } from "../src/repl-kernel-manager.ts";

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
