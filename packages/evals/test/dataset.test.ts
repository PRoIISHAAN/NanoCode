import { describe, expect, it } from "vitest";
import { GoldenDatasetError, parseGoldenDataset } from "../src/dataset.ts";

const VALID = JSON.stringify({
  schemaVersion: 1,
  cases: [{ id: "a", prompt: "say hi", checks: [{ type: "noErrors" }] }],
});

describe("parseGoldenDataset", () => {
  it("parses a valid dataset", () => {
    const dataset = parseGoldenDataset(VALID);
    expect(dataset.cases).toHaveLength(1);
    expect(dataset.cases[0].id).toBe("a");
  });

  it("rejects invalid JSON", () => {
    expect(() => parseGoldenDataset("{not json")).toThrow(GoldenDatasetError);
  });

  it("rejects the wrong schemaVersion", () => {
    expect(() => parseGoldenDataset(JSON.stringify({ schemaVersion: 2, cases: [] }))).toThrow(
      /schemaVersion/,
    );
  });

  it("rejects an empty cases array", () => {
    expect(() => parseGoldenDataset(JSON.stringify({ schemaVersion: 1, cases: [] }))).toThrow(
      /non-empty array/,
    );
  });

  it("rejects a case with no checks", () => {
    const json = JSON.stringify({
      schemaVersion: 1,
      cases: [{ id: "a", prompt: "hi", checks: [] }],
    });
    expect(() => parseGoldenDataset(json)).toThrow(/checks/);
  });

  it("rejects a check missing its required field", () => {
    const json = JSON.stringify({
      schemaVersion: 1,
      cases: [{ id: "a", prompt: "hi", checks: [{ type: "outputEquals" }] }],
    });
    expect(() => parseGoldenDataset(json)).toThrow(/"value"/);
  });

  it("rejects an unknown check type", () => {
    const json = JSON.stringify({
      schemaVersion: 1,
      cases: [{ id: "a", prompt: "hi", checks: [{ type: "somethingElse" }] }],
    });
    expect(() => parseGoldenDataset(json)).toThrow(/unknown check type/);
  });

  it("rejects duplicate case ids", () => {
    const json = JSON.stringify({
      schemaVersion: 1,
      cases: [
        { id: "a", prompt: "hi", checks: [{ type: "noErrors" }] },
        { id: "a", prompt: "bye", checks: [{ type: "noErrors" }] },
      ],
    });
    expect(() => parseGoldenDataset(json)).toThrow(/duplicate case id/);
  });
});
