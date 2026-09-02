// The golden dataset's on-disk shape (decisions/0010-evals-harness.md: a separate, version-
// controlled JSON file, not inline TypeScript like pi's `*.eval.ts` files). Each case is a single
// prompt plus a list of declarative checks -- declarative because JSON can't hold an executable
// judge function, which is itself a direct consequence of choosing the JSON-file format over pi's
// inline-code one.
import { readFile } from "node:fs/promises";

/** One deterministic assertion against a case's captured outcome (see checks.ts for evaluation). */
export type EvalCheck =
  | { type: "outputEquals"; value: string }
  | { type: "outputContains"; value: string }
  | { type: "fileExists"; path: string }
  | { type: "fileContains"; path: string; value: string }
  | { type: "noErrors" };

export interface EvalCase {
  id: string;
  prompt: string;
  checks: EvalCheck[];
}

export interface GoldenDataset {
  schemaVersion: 1;
  cases: EvalCase[];
}

/** Thrown for any malformed dataset file -- a bad golden dataset should fail loudly at load time,
 * not surface as a confusing per-case failure once the harness is already running. */
export class GoldenDatasetError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GoldenDatasetError";
  }
}

function assertIsCheck(value: unknown, context: string): asserts value is EvalCheck {
  if (typeof value !== "object" || value === null || !("type" in value)) {
    throw new GoldenDatasetError(`${context}: check must be an object with a "type"`);
  }
  const check = value as Record<string, unknown>;
  switch (check.type) {
    case "outputEquals":
    case "outputContains":
      if (typeof check.value !== "string") {
        throw new GoldenDatasetError(`${context}: "${check.type}" check requires a string "value"`);
      }
      return;
    case "fileExists":
      if (typeof check.path !== "string") {
        throw new GoldenDatasetError(`${context}: "fileExists" check requires a string "path"`);
      }
      return;
    case "fileContains":
      if (typeof check.path !== "string" || typeof check.value !== "string") {
        throw new GoldenDatasetError(
          `${context}: "fileContains" check requires a string "path" and "value"`,
        );
      }
      return;
    case "noErrors":
      return;
    default:
      throw new GoldenDatasetError(`${context}: unknown check type "${String(check.type)}"`);
  }
}

function assertIsCase(value: unknown, index: number): asserts value is EvalCase {
  if (typeof value !== "object" || value === null) {
    throw new GoldenDatasetError(`cases[${index}]: must be an object`);
  }
  const evalCase = value as Record<string, unknown>;
  if (typeof evalCase.id !== "string" || !evalCase.id.trim()) {
    throw new GoldenDatasetError(`cases[${index}]: "id" must be a non-empty string`);
  }
  if (typeof evalCase.prompt !== "string" || !evalCase.prompt.trim()) {
    throw new GoldenDatasetError(
      `cases[${index}] ("${evalCase.id}"): "prompt" must be a non-empty string`,
    );
  }
  if (!Array.isArray(evalCase.checks) || evalCase.checks.length === 0) {
    throw new GoldenDatasetError(
      `cases[${index}] ("${evalCase.id}"): "checks" must be a non-empty array`,
    );
  }
  evalCase.checks.forEach((check, checkIndex) => {
    assertIsCheck(check, `cases[${index}] ("${evalCase.id}").checks[${checkIndex}]`);
  });
}

/** Parses and validates a golden dataset's already-read JSON text. Exported separately from
 * `loadGoldenDataset` so tests can exercise validation without touching the filesystem. */
export function parseGoldenDataset(json: string): GoldenDataset {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch (error) {
    throw new GoldenDatasetError(
      `golden dataset is not valid JSON: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (typeof parsed !== "object" || parsed === null) {
    throw new GoldenDatasetError("golden dataset must be a JSON object");
  }
  const dataset = parsed as Record<string, unknown>;
  if (dataset.schemaVersion !== 1) {
    throw new GoldenDatasetError('golden dataset "schemaVersion" must be 1');
  }
  if (!Array.isArray(dataset.cases) || dataset.cases.length === 0) {
    throw new GoldenDatasetError('golden dataset "cases" must be a non-empty array');
  }
  dataset.cases.forEach((evalCase, index) => {
    assertIsCase(evalCase, index);
  });

  const ids = new Set<string>();
  for (const evalCase of dataset.cases as EvalCase[]) {
    if (ids.has(evalCase.id)) {
      throw new GoldenDatasetError(`duplicate case id "${evalCase.id}"`);
    }
    ids.add(evalCase.id);
  }

  return dataset as unknown as GoldenDataset;
}

export async function loadGoldenDataset(filePath: string): Promise<GoldenDataset> {
  const json = await readFile(filePath, "utf8");
  return parseGoldenDataset(json);
}
