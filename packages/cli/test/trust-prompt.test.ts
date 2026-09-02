// M4: the CLI-layer trust prompt (packages/cli/src/trust-prompt.ts). The most important case here
// is the one an L4 review caught by actually reproducing it: readline's question() never resolves
// or rejects on stdin EOF, so prompting against non-interactive stdin (piped input, `< /dev/null`,
// most CI runners) would hang the whole CLI forever with no error. Both a fast unit test (via the
// injectable `isInteractive` param) and a real end-to-end process spawn (against the actual
// default `process.stdin.isTTY` check, not the injected override) cover this.
import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TrustStore } from "@nanocode/agent";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ensureTrust, TrustDeniedError } from "../src/trust-prompt.ts";

let dir: string;
let projectDir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "nanocode-trust-prompt-"));
  projectDir = await mkdtemp(join(tmpdir(), "nanocode-trust-prompt-project-"));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
  await rm(projectDir, { recursive: true, force: true });
});

describe("ensureTrust", () => {
  it("returns immediately for an already-trusted directory, without consulting env or stdin", async () => {
    const store = await TrustStore.open(join(dir, "trust.json"));
    await store.setPersistent(projectDir, "trusted");
    await expect(
      ensureTrust(store, projectDir, {}, () => {
        throw new Error("must not check interactivity for an already-trusted directory");
      }),
    ).resolves.toBeUndefined();
  });

  it("throws immediately for an already-untrusted directory, without consulting env or stdin", async () => {
    const store = await TrustStore.open(join(dir, "trust.json"));
    await store.setPersistent(projectDir, "untrusted");
    await expect(
      ensureTrust(store, projectDir, {}, () => {
        throw new Error("must not check interactivity for an already-decided directory");
      }),
    ).rejects.toBeInstanceOf(TrustDeniedError);
  });

  it("NANOCODE_TRUST=always trusts persistently without prompting", async () => {
    const store = await TrustStore.open(join(dir, "trust.json"));
    await ensureTrust(store, projectDir, { NANOCODE_TRUST: "always" }, () => {
      throw new Error("must not prompt when an override is set");
    });
    expect(await store.get(projectDir)).toBe("trusted");

    const reopened = await TrustStore.open(join(dir, "trust.json"));
    expect(await reopened.get(projectDir)).toBe("trusted"); // persisted, survives reopening
  });

  it("NANOCODE_TRUST=once trusts session-only without prompting", async () => {
    const store = await TrustStore.open(join(dir, "trust.json"));
    await ensureTrust(store, projectDir, { NANOCODE_TRUST: "once" }, () => {
      throw new Error("must not prompt when an override is set");
    });
    expect(await store.get(projectDir)).toBe("trusted");

    const reopened = await TrustStore.open(join(dir, "trust.json"));
    expect(await reopened.get(projectDir)).toBeUndefined(); // never written to disk
  });

  it("NANOCODE_TRUST=never denies without prompting", async () => {
    const store = await TrustStore.open(join(dir, "trust.json"));
    await expect(
      ensureTrust(store, projectDir, { NANOCODE_TRUST: "never" }, () => {
        throw new Error("must not prompt when an override is set");
      }),
    ).rejects.toBeInstanceOf(TrustDeniedError);
  });

  it("fails fast (does not hang) on non-interactive stdin with no override set", async () => {
    const store = await TrustStore.open(join(dir, "trust.json"));
    await expect(ensureTrust(store, projectDir, {}, () => false)).rejects.toThrow(
      /not interactive/,
    );
  });

  it("an invalid NANOCODE_TRUST value is ignored, falling through to the interactivity check", async () => {
    const store = await TrustStore.open(join(dir, "trust.json"));
    await expect(
      ensureTrust(store, projectDir, { NANOCODE_TRUST: "sure, why not" }, () => false),
    ).rejects.toThrow(/not interactive/);
  });
});

describe("ensureTrust against real process.stdin (end-to-end, no injection)", () => {
  it("a real CLI-shaped process with stdin closed (</dev/null) fails fast instead of hanging", async () => {
    const script = `
      import { TrustStore } from "@nanocode/agent";
      import { ensureTrust } from "${new URL("../src/trust-prompt.ts", import.meta.url).pathname}";
      const store = await TrustStore.open(${JSON.stringify(join(dir, "trust.json"))});
      try {
        await ensureTrust(store, ${JSON.stringify(projectDir)});
        console.log("UNEXPECTED_SUCCESS");
      } catch (error) {
        console.log("DENIED:" + error.message);
      }
    `;
    const child = spawn(
      process.execPath,
      ["--import", "tsx/esm", "--input-type=module", "-e", script],
      {
        stdio: ["ignore", "pipe", "pipe"], // "ignore" gives the child a closed/EOF stdin, like </dev/null
      },
    );

    const output = await new Promise<string>((resolve, reject) => {
      let out = "";
      const timer = setTimeout(() => {
        child.kill("SIGKILL");
        reject(new Error("process did not exit within 8s -- ensureTrust likely hung on stdin EOF"));
      }, 8_000);
      child.stdout.on("data", (chunk) => {
        out += chunk;
      });
      child.stderr.on("data", (chunk) => {
        out += chunk;
      });
      child.on("exit", () => {
        clearTimeout(timer);
        resolve(out);
      });
    });

    expect(output).toContain("DENIED:");
    expect(output).toContain("not interactive");
  }, 10_000);
});
