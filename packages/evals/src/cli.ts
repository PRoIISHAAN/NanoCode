#!/usr/bin/env node
// `npm run evals` entrypoint: loads the golden dataset, runs every case against both a baseline
// and a candidate model config, and prints a regression report. Two model configs (not one) is
// the one way this entrypoint's flags differ from `cli`/`tui`'s single NANOCODE_PROVIDER/MODEL --
// see decisions/0010-evals-harness.md's "baseline vs. candidate, one invocation" design.
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createModelsRegistry, resolveModel } from "@nanocode/ai";
import { loadGoldenDataset } from "./dataset.ts";
import type { HarnessConfig } from "./harness.ts";
import { runEvalCase } from "./harness.ts";
import { compareResults, formatComparisonReport } from "./report.ts";

const DEFAULT_DATASET_PATH = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../golden/core.json",
);

function parseArgs(argv: string[]): {
  dataset: string;
  baseline: HarnessConfig;
  candidate: HarnessConfig;
} {
  const values = new Map<string, string>();
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (!arg.startsWith("--")) continue;
    const value = argv[i + 1];
    if (value === undefined || value.startsWith("--")) {
      throw new Error(`missing value for ${arg}`);
    }
    values.set(arg.slice(2), value);
    i += 1;
  }

  const require = (flag: string): string => {
    const value = values.get(flag);
    if (!value) {
      throw new Error(
        `missing required --${flag}. Usage: npm run evals -- ` +
          "--baseline-provider <p> --baseline-model <m> --candidate-provider <p> --candidate-model <m> " +
          "[--dataset <path>]",
      );
    }
    return value;
  };

  return {
    dataset: values.get("dataset") ?? DEFAULT_DATASET_PATH,
    baseline: {
      name: "baseline",
      provider: require("baseline-provider"),
      model: require("baseline-model"),
    },
    candidate: {
      name: "candidate",
      provider: require("candidate-provider"),
      model: require("candidate-model"),
    },
  };
}

async function main(): Promise<void> {
  const { dataset: datasetPath, baseline, candidate } = parseArgs(process.argv.slice(2));
  const dataset = await loadGoldenDataset(datasetPath);
  const models = createModelsRegistry();

  console.error(`[evals] dataset: ${datasetPath} (${dataset.cases.length} cases)`);
  console.error(`[evals] baseline:  ${baseline.provider}/${baseline.model}`);
  console.error(`[evals] candidate: ${candidate.provider}/${candidate.model}`);

  const baselineResults = [];
  const candidateResults = [];
  for (const evalCase of dataset.cases) {
    console.error(`[evals] running "${evalCase.id}"...`);
    baselineResults.push(await runEvalCase(evalCase, baseline, models, resolveModel));
    candidateResults.push(await runEvalCase(evalCase, candidate, models, resolveModel));
  }

  const report = compareResults(baselineResults, candidateResults);
  console.log(formatComparisonReport(report));

  if (report.cases.some((c) => c.verdict === "regressed")) {
    process.exitCode = 1;
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
