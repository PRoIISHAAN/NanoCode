// Evaluates one declarative EvalCheck against a case's captured outcome. Kept separate from
// harness.ts so the (pure, synchronous-except-for-file-reads) scoring logic can be unit-tested
// without ever starting a kernel or calling a model.
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { EvalCheck } from "./dataset.ts";

/** What a harness run captured for one case -- everything a check might need to look at. */
export interface CaseOutcome {
  /** The final assistant message's concatenated text content. */
  output: string;
  /** Set when the session errored or aborted instead of producing a final answer. */
  error: string | undefined;
  /** The kernel's isolated temp working directory, for file-based checks. */
  workdir: string;
}

/** One check's result: whether it passed, and (only when it failed) why, for the report. */
export interface CheckResult {
  check: EvalCheck;
  passed: boolean;
  reason?: string;
}

async function evaluateOne(check: EvalCheck, outcome: CaseOutcome): Promise<CheckResult> {
  switch (check.type) {
    case "outputEquals": {
      const passed = outcome.output.trim() === check.value;
      return passed
        ? { check, passed }
        : {
            check,
            passed,
            reason: `expected output "${check.value}", got "${outcome.output.trim()}"`,
          };
    }
    case "outputContains": {
      const passed = outcome.output.includes(check.value);
      return passed
        ? { check, passed }
        : { check, passed, reason: `expected output to contain "${check.value}"` };
    }
    case "fileExists": {
      try {
        await readFile(join(outcome.workdir, check.path));
        return { check, passed: true };
      } catch {
        return { check, passed: false, reason: `expected file "${check.path}" to exist` };
      }
    }
    case "fileContains": {
      let contents: string;
      try {
        contents = await readFile(join(outcome.workdir, check.path), "utf8");
      } catch {
        return { check, passed: false, reason: `expected file "${check.path}" to exist` };
      }
      const passed = contents.includes(check.value);
      return passed
        ? { check, passed }
        : { check, passed, reason: `expected file "${check.path}" to contain "${check.value}"` };
    }
    case "noErrors": {
      return outcome.error === undefined
        ? { check, passed: true }
        : { check, passed: false, reason: `session errored: ${outcome.error}` };
    }
  }
}

/** Runs every check for a case against its captured outcome. A case passes only if every check
 * passes -- matching the report's binary pass/fail scoring (decisions/0010-evals-harness.md: no
 * partial-credit judge model, so there is nothing to average). */
export async function evaluateChecks(
  checks: EvalCheck[],
  outcome: CaseOutcome,
): Promise<{ passed: boolean; results: CheckResult[] }> {
  const results = await Promise.all(checks.map((check) => evaluateOne(check, outcome)));
  return { passed: results.every((result) => result.passed), results };
}
