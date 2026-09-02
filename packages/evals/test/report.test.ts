import { describe, expect, it } from "vitest";
import type { EvalCaseResult } from "../src/harness.ts";
import { compareResults, formatComparisonReport } from "../src/report.ts";

function result(overrides: Partial<EvalCaseResult>): EvalCaseResult {
  return {
    caseId: "a",
    harness: "baseline",
    passed: true,
    checks: [],
    output: "",
    durationMs: 1,
    ...overrides,
  };
}

describe("compareResults", () => {
  it("classifies a regression: baseline passed, candidate failed", () => {
    const report = compareResults(
      [result({ caseId: "a", harness: "baseline", passed: true })],
      [
        result({
          caseId: "a",
          harness: "candidate",
          passed: false,
          checks: [{ check: { type: "noErrors" }, passed: false, reason: "boom" }],
        }),
      ],
    );
    expect(report.cases[0].verdict).toBe("regressed");
    expect(report.lift).toBeLessThan(0);
  });

  it("classifies a fix: baseline failed, candidate passed", () => {
    const report = compareResults(
      [result({ caseId: "a", passed: false })],
      [result({ caseId: "a", harness: "candidate", passed: true })],
    );
    expect(report.cases[0].verdict).toBe("fixed");
    expect(report.lift).toBeGreaterThan(0);
  });

  it("computes pass rates and a zero lift when nothing changed", () => {
    const report = compareResults(
      [result({ caseId: "a", passed: true }), result({ caseId: "b", passed: false })],
      [
        result({ caseId: "a", harness: "candidate", passed: true }),
        result({ caseId: "b", harness: "candidate", passed: false }),
      ],
    );
    expect(report.baselinePassRate).toBe(0.5);
    expect(report.candidatePassRate).toBe(0.5);
    expect(report.lift).toBe(0);
    expect(report.cases.map((c) => c.verdict)).toEqual(["unchanged-pass", "unchanged-fail"]);
  });

  it("throws when the candidate results are missing a baseline case id", () => {
    expect(() =>
      compareResults([result({ caseId: "a" }), result({ caseId: "b" })], [result({ caseId: "a" })]),
    ).toThrow(/same set of case ids/);
  });

  it("throws on a duplicated baseline id paired with a same-size but different-id candidate set", () => {
    // Regression case for the L4 finding: a naive size-only check (candidate map size vs. both
    // array lengths) lets this through -- both arrays have length 2, and the candidate side has
    // no duplicates -- even though baseline never covers "b" at all and candidate never covers
    // "a" twice. Without a true set-equality check this would silently compare "a" against
    // itself twice and drop "b" from the report entirely, instead of throwing.
    expect(() =>
      compareResults(
        [result({ caseId: "a" }), result({ caseId: "a" })],
        [
          result({ caseId: "a", harness: "candidate" }),
          result({ caseId: "b", harness: "candidate" }),
        ],
      ),
    ).toThrow(/same set of case ids/);
  });

  it("throws on an empty result set", () => {
    expect(() => compareResults([], [])).toThrow(/empty/);
  });
});

describe("formatComparisonReport", () => {
  it("leads with regressions, not just the aggregate pass rate", () => {
    const report = compareResults(
      [result({ caseId: "a", passed: true })],
      [
        result({
          caseId: "a",
          harness: "candidate",
          passed: false,
          checks: [{ check: { type: "noErrors" }, passed: false, reason: "boom" }],
        }),
      ],
    );
    const text = formatComparisonReport(report);
    expect(text).toMatch(/REGRESSIONS \(1\)/);
    expect(text).toMatch(/boom/);
  });

  it("says there are no regressions when there are none", () => {
    const report = compareResults(
      [result({ caseId: "a", passed: true })],
      [result({ caseId: "a", harness: "candidate", passed: true })],
    );
    expect(formatComparisonReport(report)).toMatch(/No regressions\./);
  });
});
