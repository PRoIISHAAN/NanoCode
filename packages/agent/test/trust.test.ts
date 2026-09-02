// M4: project trust decisions (packages/agent/src/trust.ts). Real temp-file I/O -- the thing under
// test is the on-disk persistence format and the trusted/session-only/untrusted state machine.
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { TrustStore } from "../src/trust.ts";

let dir: string;
let projectDir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "nanocode-trust-"));
  projectDir = await mkdtemp(join(tmpdir(), "nanocode-trust-project-"));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
  await rm(projectDir, { recursive: true, force: true });
});

describe("TrustStore", () => {
  it("returns undefined (never decided) for a directory it has no record of", async () => {
    const store = await TrustStore.open(join(dir, "trust.json"));
    expect(await store.get(projectDir)).toBeUndefined();
  });

  it("setPersistent writes a decision to disk that survives reopening", async () => {
    const filePath = join(dir, "trust.json");
    const store = await TrustStore.open(filePath);
    await store.setPersistent(projectDir, "trusted");

    expect(await store.get(projectDir)).toBe("trusted");
    const reopened = await TrustStore.open(filePath);
    expect(await reopened.get(projectDir)).toBe("trusted");

    const onDisk = JSON.parse(await readFile(filePath, "utf8"));
    const keys = Object.keys(onDisk);
    expect(keys).toHaveLength(1);
    expect(onDisk[keys[0]]).toBe("trusted");
  });

  it("setSessionOnly never touches disk and is gone once a fresh TrustStore is opened", async () => {
    const filePath = join(dir, "trust.json");
    const store = await TrustStore.open(filePath);
    await store.setSessionOnly(projectDir, "trusted");

    expect(await store.get(projectDir)).toBe("trusted");

    const reopened = await TrustStore.open(filePath);
    expect(await reopened.get(projectDir)).toBeUndefined();
  });

  it("a session-only decision is overridden by a later persistent decision in the same store", async () => {
    const store = await TrustStore.open(join(dir, "trust.json"));
    await store.setSessionOnly(projectDir, "untrusted");
    await store.setPersistent(projectDir, "trusted");
    expect(await store.get(projectDir)).toBe("trusted");
  });

  it("does not inherit trust from a parent directory (exact-path keyed only)", async () => {
    const filePath = join(dir, "trust.json");
    const store = await TrustStore.open(filePath);
    await store.setPersistent(dir, "trusted"); // trust the parent tmp dir, not projectDir itself
    expect(await store.get(projectDir)).toBeUndefined();
  });
});
