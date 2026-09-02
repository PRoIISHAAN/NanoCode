// Compares a baseline run's results against a candidate run's, case by case. Inspired by (not
// ported from) pi's HarnessComparisonReport/CorrectnessLiftSummary
// (pi/packages/evals/src/vitest-evals/summary.ts) -- borrows the shape (two named configs, one
// dataset, a pass-rate lift) but is far narrower: deterministic scoring needs none of pi's
// generic multi-metric/multi-repetition/multi-candidate grouping machinery. See
// decisions/0010-evals-harness.md.
import type { EvalCaseResult } from "./harness.ts";

export type CaseVerdict = "regressed" | "fixed" | "unchanged-pass" | "unchanged-fail";

export interface CaseComparison {
  caseId: string;
  verdict: CaseVerdict;
  baseline: EvalCaseResult;
  candidate: EvalCaseResult;
}

export interface ComparisonReport {
  baselineName: string;
  candidateName: string;
  totalCases: number;
  baselinePassRate: number;
  candidatePassRate: number;
  /** candidatePassRate - baselinePassRate. Positive means the candidate is better. */
  lift: number;
  cases: CaseComparison[];
}

function classify(baseline: EvalCaseResult, candidate: EvalCaseResult): CaseVerdict {
  if (baseline.passed && !candidate.passed) return "regressed";
  if (!baseline.passed && candidate.passed) return "fixed";
  return baseline.passed ? "unchanged-pass" : "unchanged-fail";
}

/** Both result arrays must cover the same case ids exactly once each (the caller runs the same
 * dataset against both configs) -- a mismatch means the two runs aren't comparable, so this
 * throws rather than silently reporting on whatever overlaps. */
export function compareResults(
  baselineResults: EvalCaseResult[],
  candidateResults: EvalCaseResult[],
): ComparisonReport {
  if (baselineResults.length === 0) {
    throw new Error("cannot compare an empty result set");
  }
  // Checking array lengths against the candidate map's size (its old shape) only ever caught a
  // duplicate id on the candidate side -- a duplicate on the baseline side, paired with a
  // same-size candidate set that merely covers *different* ids, would slip through: every
  // duplicated baseline id resolves to the same candidate entry (silently comparing it twice)
  // while the candidate's other id is silently never referenced at all. Comparing the two id
  // *sets* directly (not just their sizes) catches both a within-array duplicate and a
  // between-array mismatch.
  const baselineIds = new Set(baselineResults.map((result) => result.caseId));
  const candidateIds = new Set(candidateResults.map((result) => result.caseId));
  const hasNoDuplicates =
    baselineIds.size === baselineResults.length && candidateIds.size === candidateResults.length;
  const idsMatch =
    baselineIds.size === candidateIds.size && [...baselineIds].every((id) => candidateIds.has(id));
  if (!hasNoDuplicates || !idsMatch) {
    throw new Error(
      "baseline and candidate results must cover the same set of case ids exactly once each",
    );
  }
  const candidateByCaseId = new Map(candidateResults.map((result) => [result.caseId, result]));

  const cases: CaseComparison[] = baselineResults.map((baseline) => {
    const candidate = candidateByCaseId.get(baseline.caseId);
    if (!candidate) {
      throw new Error(`candidate results are missing case "${baseline.caseId}"`);
    }
    return { caseId: baseline.caseId, verdict: classify(baseline, candidate), baseline, candidate };
  });

  const totalCases = cases.length;
  const baselinePassRate = cases.filter((c) => c.baseline.passed).length / totalCases;
  const candidatePassRate = cases.filter((c) => c.candidate.passed).length / totalCases;

  return {
    baselineName: baselineResults[0].harness,
    candidateName: candidateResults[0].harness,
    totalCases,
    baselinePassRate,
    candidatePassRate,
    lift: Number((candidatePassRate - baselinePassRate).toPrecision(15)),
    cases,
  };
}

function formatPercent(value: number): string {
  return `${(value * 100).toFixed(1)}%`;
}

/**
 * A plain-text report that leads with regressions, not the aggregate pass rate -- PLAN.md's M7
 * success criterion is "report clearly surfaces regressions, not just aggregate pass rate," so a
 * regressed case is never left for the reader to find by scanning a table.
 */
export function formatComparisonReport(report: ComparisonReport): string {
  const lines: string[] = [];
  lines.push(
    `Baseline:  ${report.baselineName} — ${formatPercent(report.baselinePassRate)} pass rate`,
  );
  lines.push(
    `Candidate: ${report.candidateName} — ${formatPercent(report.candidatePassRate)} pass rate`,
  );
  lines.push(`Lift: ${report.lift >= 0 ? "+" : ""}${formatPercent(report.lift)}`);
  lines.push("");

  const regressed = report.cases.filter((c) => c.verdict === "regressed");
  const fixed = report.cases.filter((c) => c.verdict === "fixed");

  if (regressed.length > 0) {
    lines.push(`REGRESSIONS (${regressed.length}) — passed on baseline, failed on candidate:`);
    for (const comparison of regressed) {
      const failedChecks = comparison.candidate.checks.filter((c) => !c.passed);
      lines.push(`  - ${comparison.caseId}: ${failedChecks.map((c) => c.reason).join("; ")}`);
    }
    lines.push("");
  } else {
    lines.push("No regressions.");
    lines.push("");
  }

  if (fixed.length > 0) {
    lines.push(`FIXED (${fixed.length}) — failed on baseline, passed on candidate:`);
    for (const comparison of fixed) {
      lines.push(`  - ${comparison.caseId}`);
    }
    lines.push("");
  }

  const stillFailing = report.cases.filter((c) => c.verdict === "unchanged-fail");
  if (stillFailing.length > 0) {
    lines.push(
      `Still failing on both (${stillFailing.length}): ${stillFailing.map((c) => c.caseId).join(", ")}`,
    );
  }

  return lines.join("\n");
}
