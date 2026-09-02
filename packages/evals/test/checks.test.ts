import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { CaseOutcome } from "../src/checks.ts";
import { evaluateChecks } from "../src/checks.ts";

describe("evaluateChecks", () => {
  let workdir: string;

  beforeEach(async () => {
    workdir = await mkdtemp(join(tmpdir(), "nanocode-eval-checks-test-"));
  });

  afterEach(async () => {
    await rm(workdir, { recursive: true, force: true });
  });

  function outcome(overrides: Partial<CaseOutcome> = {}): CaseOutcome {
    return { output: "Paris", error: undefined, workdir, ...overrides };
  }

  it("passes when every check passes", async () => {
    const { passed, results } = await evaluateChecks(
      [{ type: "outputEquals", value: "Paris" }, { type: "noErrors" }],
      outcome(),
    );
    expect(passed).toBe(true);
    expect(results.every((r) => r.passed)).toBe(true);
  });

  it("fails the whole case if any single check fails", async () => {
    const { passed, results } = await evaluateChecks(
      [
        { type: "outputEquals", value: "Paris" },
        { type: "outputContains", value: "London" },
      ],
      outcome(),
    );
    expect(passed).toBe(false);
    expect(results[1].passed).toBe(false);
    expect(results[1].reason).toMatch(/London/);
  });

  it("outputEquals trims trailing whitespace before comparing", async () => {
    const { passed } = await evaluateChecks(
      [{ type: "outputEquals", value: "Paris" }],
      outcome({ output: "Paris\n" }),
    );
    expect(passed).toBe(true);
  });

  it("noErrors fails when the outcome carries an error", async () => {
    const { passed, results } = await evaluateChecks(
      [{ type: "noErrors" }],
      outcome({ error: "boom" }),
    );
    expect(passed).toBe(false);
    expect(results[0].reason).toMatch(/boom/);
  });

  it("fileExists passes only when the file is actually present in workdir", async () => {
    const missing = await evaluateChecks([{ type: "fileExists", path: "hello.txt" }], outcome());
    expect(missing.passed).toBe(false);

    await writeFile(join(workdir, "hello.txt"), "hello world");
    const present = await evaluateChecks([{ type: "fileExists", path: "hello.txt" }], outcome());
    expect(present.passed).toBe(true);
  });

  it("fileContains fails if the file exists but lacks the expected substring", async () => {
    await writeFile(join(workdir, "hello.txt"), "goodbye world");
    const { passed, results } = await evaluateChecks(
      [{ type: "fileContains", path: "hello.txt", value: "hello world" }],
      outcome(),
    );
    expect(passed).toBe(false);
    expect(results[0].reason).toMatch(/hello world/);
  });

  it("fileContains fails (not throws) if the file doesn't exist at all", async () => {
    const { passed, results } = await evaluateChecks(
      [{ type: "fileContains", path: "missing.txt", value: "x" }],
      outcome(),
    );
    expect(passed).toBe(false);
    expect(results[0].reason).toMatch(/exist/);
  });
});
