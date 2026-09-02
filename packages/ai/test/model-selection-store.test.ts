import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  readStoredModelSelection,
  writeStoredModelSelection,
} from "../src/model-selection-store.ts";

describe("model-selection-store", () => {
  let dir: string;
  let filePath: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "nanocode-model-selection-test-"));
    filePath = join(dir, "model-selection.json");
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("resolves undefined when nothing was ever stored (no file on disk yet)", async () => {
    await expect(readStoredModelSelection(filePath)).resolves.toBeUndefined();
  });

  it("persists a selection that a later read sees, including across separate calls", async () => {
    await writeStoredModelSelection(
      { provider: "openrouter", model: "anthropic/claude-3-haiku" },
      filePath,
    );
    await expect(readStoredModelSelection(filePath)).resolves.toEqual({
      provider: "openrouter",
      model: "anthropic/claude-3-haiku",
    });
  });

  it("overwrites a previously stored selection with the newest one", async () => {
    await writeStoredModelSelection({ provider: "anthropic", model: "claude-sonnet-5" }, filePath);
    await writeStoredModelSelection(
      { provider: "openrouter", model: "anthropic/claude-3-haiku" },
      filePath,
    );
    await expect(readStoredModelSelection(filePath)).resolves.toEqual({
      provider: "openrouter",
      model: "anthropic/claude-3-haiku",
    });
  });

  it("throws (rather than silently ignoring) a file that exists but isn't a valid selection", async () => {
    await mkdir(dir, { recursive: true });
    await writeFile(filePath, JSON.stringify({ provider: "openrouter" })); // missing "model"
    await expect(readStoredModelSelection(filePath)).rejects.toThrow(/valid/);
  });

  it("throws on corrupted (non-JSON) content rather than treating it as unconfigured", async () => {
    await mkdir(dir, { recursive: true });
    await writeFile(filePath, "not json at all");
    await expect(readStoredModelSelection(filePath)).rejects.toThrow();
  });
});
