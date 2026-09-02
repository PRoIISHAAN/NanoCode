// M6: the host_request handlers Python's mcp.py calls into, tested directly against their
// (data: Record<string, unknown>) => Promise<unknown> shape -- the same pattern
// task-state-recall.test.ts uses -- backed by the real fixture MCP server.
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { McpClientManager } from "../src/mcp/client-manager.ts";
import type { McpConfig } from "../src/mcp/config.ts";
import {
  createMcpCallToolHandler,
  createMcpListServersHandler,
  createMcpListToolsHandler,
} from "../src/mcp/host-handlers.ts";

const FIXTURE_PATH = fileURLToPath(new URL("./fixtures/mcp-test-server.ts", import.meta.url));

function testConfig(): McpConfig {
  return {
    test: { type: "stdio", command: process.execPath, args: ["--import", "tsx/esm", FIXTURE_PATH] },
  };
}

let manager: McpClientManager | undefined;

afterEach(async () => {
  await manager?.closeAll();
  manager = undefined;
});

describe("createMcpListServersHandler", () => {
  it("returns every configured server name", async () => {
    manager = new McpClientManager(testConfig());
    const handler = createMcpListServersHandler(manager);
    expect(await handler({})).toEqual(["test"]);
  });
});

describe("createMcpListToolsHandler", () => {
  it("returns the real server's tool list", async () => {
    manager = new McpClientManager(testConfig());
    const handler = createMcpListToolsHandler(manager);
    const tools = (await handler({ server: "test" })) as Array<{ name: string }>;
    expect(tools.map((t) => t.name).sort()).toEqual(["add", "echo", "fail"]);
  });

  it("rejects a missing server field", async () => {
    manager = new McpClientManager(testConfig());
    const handler = createMcpListToolsHandler(manager);
    await expect(handler({})).rejects.toThrow(/non-empty string server/);
  });
});

describe("createMcpCallToolHandler", () => {
  it("calls a real tool and returns its result", async () => {
    manager = new McpClientManager(testConfig());
    const handler = createMcpCallToolHandler(manager);
    expect(await handler({ server: "test", tool: "echo", args: { text: "hi" } })).toBe("hi");
  });

  it("defaults args to {} when omitted", async () => {
    manager = new McpClientManager(testConfig());
    const handler = createMcpCallToolHandler(manager);
    // "fail" takes no arguments -- proves an omitted `args` doesn't break the call.
    await expect(handler({ server: "test", tool: "fail" })).rejects.toThrow(/deliberate failure/);
  });

  it("rejects a missing tool field", async () => {
    manager = new McpClientManager(testConfig());
    const handler = createMcpCallToolHandler(manager);
    await expect(handler({ server: "test" })).rejects.toThrow(/non-empty string tool/);
  });
});
