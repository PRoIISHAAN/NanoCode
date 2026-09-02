// M4: the Docker sandbox mode's spawn-command shape (packages/kernel/src/repl-kernel-manager.ts's
// buildSpawnCommand). The "plain" tests need no subprocess at all; the "docker" tests only assert
// the exact args array, not that Docker is installed -- a real end-to-end run against a built
// image is a separate, availability-gated integration test (see docker-sandbox.integration.test.ts).
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import { buildSpawnCommand } from "../src/repl-kernel-manager.ts";

const ORIGINAL_ENV = { ...process.env };

afterEach(() => {
  process.env = { ...ORIGINAL_ENV };
});

describe("buildSpawnCommand", () => {
  it("plain mode (default): spawns the interpreter directly with PYTHONPATH and the owner-pid env var", () => {
    delete process.env.NANOCODE_SANDBOX;
    const { command, args, env } = buildSpawnCommand({});
    expect(command).toBe("python3");
    expect(args).toEqual(["-m", "nanocode_kernel.repl"]);
    expect(env.PYTHONPATH).toContain("kernel/python");
    expect(env.NANOCODE_KERNEL_OWNER_PID).toBe(String(process.pid));
  });

  it("plain mode: respects an explicit python interpreter path", () => {
    const { command } = buildSpawnCommand({ python: "/usr/bin/python3.12" });
    expect(command).toBe("/usr/bin/python3.12");
  });

  it("plain mode: falls back to $NANOCODE_KERNEL_PYTHON when no explicit interpreter is given", () => {
    process.env.NANOCODE_KERNEL_PYTHON = "/opt/python/bin/python3";
    const { command } = buildSpawnCommand({});
    expect(command).toBe("/opt/python/bin/python3");
  });

  it("docker mode: runs `docker run` with the kernel source and cwd bind-mounted, network open by default", () => {
    const { command, args } = buildSpawnCommand({ sandbox: "docker", cwd: "/home/me/project" });
    expect(command).toBe("docker");
    expect(args).toEqual([
      "run",
      "-i",
      "--rm",
      "-v",
      expect.stringContaining(":/nanocode_kernel_src:ro"),
      "-v",
      "/home/me/project:/workspace",
      "-w",
      "/workspace",
      "-e",
      "PYTHONPATH=/nanocode_kernel_src",
      "nanocode-kernel:latest",
      "python3",
      "-m",
      "nanocode_kernel.repl",
    ]);
    // No --network=none or similar restriction anywhere in the args -- open by default.
    expect(args.join(" ")).not.toContain("--network");
  });

  it("docker mode: respects an explicit dockerImage and $NANOCODE_SANDBOX_IMAGE", () => {
    const explicit = buildSpawnCommand({ sandbox: "docker", dockerImage: "my-image:v2" });
    expect(explicit.args).toContain("my-image:v2");

    process.env.NANOCODE_SANDBOX_IMAGE = "from-env:latest";
    const fromEnv = buildSpawnCommand({ sandbox: "docker" });
    expect(fromEnv.args).toContain("from-env:latest");
  });

  it("reads sandbox mode from $NANOCODE_SANDBOX when not passed explicitly", () => {
    process.env.NANOCODE_SANDBOX = "docker";
    const { command } = buildSpawnCommand({});
    expect(command).toBe("docker");
  });

  it("an explicit sandbox option overrides $NANOCODE_SANDBOX", () => {
    process.env.NANOCODE_SANDBOX = "docker";
    const { command } = buildSpawnCommand({ sandbox: "plain" });
    expect(command).toBe("python3");
  });
});

const execFileAsync = promisify(execFile);

async function dockerIsAvailable(): Promise<boolean> {
  try {
    await execFileAsync("docker", ["--version"]);
    return true;
  } catch {
    return false;
  }
}

async function imageExists(image: string): Promise<boolean> {
  try {
    await execFileAsync("docker", ["image", "inspect", image]);
    return true;
  } catch {
    return false;
  }
}

describe.runIf(await dockerIsAvailable())(
  "Docker sandbox (real docker, availability-gated)",
  () => {
    it("runs a cell inside the sandboxed kernel when the image is built", async (ctx) => {
      const image = process.env.NANOCODE_SANDBOX_IMAGE ?? "nanocode-kernel:latest";
      if (!(await imageExists(image))) {
        ctx.skip(); // documented one-time step: `docker build -t nanocode-kernel:latest packages/kernel/docker`
        return;
      }
      const { ReplKernelManager } = await import("../src/repl-kernel-manager.ts");
      const manager = new ReplKernelManager({ sandbox: "docker" });
      try {
        const result = await manager.execute("17 * 23");
        expect(result.status).toBe("ok");
        expect(result.result).toBe("391");
      } finally {
        await manager.shutdown();
      }
    });
  },
);
