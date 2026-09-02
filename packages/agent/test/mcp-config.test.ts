import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadMcpConfig, resolveEnvRef, resolveEnvRefs } from "../src/mcp/config.ts";

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "nanocode-mcp-config-"));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("loadMcpConfig", () => {
  it("returns an empty config when the file doesn't exist -- MCP is opt-in", async () => {
    expect(await loadMcpConfig(join(dir, "does-not-exist.json"))).toEqual({});
  });

  it("parses a real config file", async () => {
    const path = join(dir, "mcp.json");
    const config = {
      github: { type: "stdio", command: "npx", args: ["-y", "github-mcp"] },
    };
    await writeFile(path, JSON.stringify(config), "utf8");
    expect(await loadMcpConfig(path)).toEqual(config);
  });

  it("throws a clear error for a non-object config file (e.g. a JSON array)", async () => {
    const path = join(dir, "mcp.json");
    await writeFile(path, "[]", "utf8");
    await expect(loadMcpConfig(path)).rejects.toThrow(/must contain a JSON object/);
  });
});

describe("resolveEnvRef / resolveEnvRefs", () => {
  it("resolves a reference to its current environment variable value", () => {
    expect(resolveEnvRef({ env: "MY_VAR" }, { MY_VAR: "secret-value" })).toBe("secret-value");
  });

  it("throws a clear error naming the missing variable", () => {
    expect(() => resolveEnvRef({ env: "MISSING_VAR" }, {})).toThrow(/MISSING_VAR/);
  });

  it("resolves a map of refs, and returns {} for undefined input", () => {
    expect(
      resolveEnvRefs({ TOKEN: { env: "A" }, SECRET: { env: "B" } }, { A: "1", B: "2" }),
    ).toEqual({ TOKEN: "1", SECRET: "2" });
    expect(resolveEnvRefs(undefined)).toEqual({});
  });
});
