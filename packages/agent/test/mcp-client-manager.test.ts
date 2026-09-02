// M6: McpClientManager against a real MCP server (test/fixtures/mcp-test-server.ts), spawned as a
// genuine stdio subprocess speaking the real MCP wire protocol -- not a hand-rolled fake of it.
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { McpClientManager, McpStartupError, McpToolCallError } from "../src/mcp/client-manager.ts";
import type { McpConfig } from "../src/mcp/config.ts";
import { type HttpMcpServerHandle, startHttpMcpServer } from "./fixtures/http-mcp-server.ts";

const FIXTURE_PATH = fileURLToPath(new URL("./fixtures/mcp-test-server.ts", import.meta.url));

function testConfig(): McpConfig {
  return {
    test: {
      type: "stdio",
      command: process.execPath,
      args: ["--import", "tsx/esm", FIXTURE_PATH],
    },
  };
}

let manager: McpClientManager | undefined;

afterEach(async () => {
  await manager?.closeAll();
  manager = undefined;
});

describe("McpClientManager", () => {
  it("lists configured server names without connecting to anything", () => {
    manager = new McpClientManager(testConfig());
    expect(manager.listServers()).toEqual(["test"]);
  });

  it("lists tools from a real connected server", async () => {
    manager = new McpClientManager(testConfig());
    const tools = await manager.listTools("test");
    expect(tools.map((t) => t.name).sort()).toEqual(["add", "echo", "fail"]);
    const echo = tools.find((t) => t.name === "echo");
    expect(echo?.description).toContain("returns whatever text");
    expect(echo?.inputSchema).toBeDefined();
  });

  it("calls a tool and returns its joined text content when there's no structuredContent", async () => {
    manager = new McpClientManager(testConfig());
    const result = await manager.callTool("test", "echo", { text: "hello" });
    expect(result).toBe("hello");
  });

  it("prefers structuredContent over text content when the tool provides one", async () => {
    manager = new McpClientManager(testConfig());
    const result = await manager.callTool("test", "add", { a: 2, b: 3 });
    expect(result).toEqual({ sum: 5 });
  });

  it("throws McpToolCallError when the server reports an error result", async () => {
    manager = new McpClientManager(testConfig());
    await expect(manager.callTool("test", "fail", {})).rejects.toBeInstanceOf(McpToolCallError);
    await expect(manager.callTool("test", "fail", {})).rejects.toThrow(/deliberate failure/);
  });

  it("throws McpStartupError for a server whose command cannot be spawned", async () => {
    manager = new McpClientManager({
      bad: { type: "stdio", command: "/nonexistent/binary/xyz", startupTimeoutMs: 3_000 },
    });
    await expect(manager.listTools("bad")).rejects.toBeInstanceOf(McpStartupError);
  });

  it("reuses one lazily-opened connection across multiple calls to the same server", async () => {
    manager = new McpClientManager(testConfig());
    expect(await manager.callTool("test", "echo", { text: "a" })).toBe("a");
    expect(await manager.callTool("test", "echo", { text: "b" })).toBe("b");
  });

  it("throws a clear error for a server name that isn't configured at all", async () => {
    manager = new McpClientManager(testConfig());
    await expect(manager.listTools("nope")).rejects.toThrow(/no MCP server named "nope"/);
  });

  it("closeAll() lets a fresh manager reconnect cleanly afterward", async () => {
    manager = new McpClientManager(testConfig());
    await manager.callTool("test", "echo", { text: "first" });
    await manager.closeAll();

    const second = new McpClientManager(testConfig());
    try {
      expect(await second.callTool("test", "echo", { text: "second" })).toBe("second");
    } finally {
      await second.closeAll();
    }
  });

  it("closeAll() actually tears down a live connection, not just clears the cache", async () => {
    // Regression: an L4 review noted the original version of this test only proved a SECOND,
    // independent manager could connect -- which would pass even if closeAll() were a no-op.
    // This attaches the real MCP Client's own onclose hook before calling closeAll() and asserts
    // it actually fires, proving the underlying connection (and its subprocess) was torn down.
    manager = new McpClientManager(testConfig());
    await manager.callTool("test", "echo", { text: "first" });

    const client = await manager.getConnectedClient("test");
    expect(client).toBeDefined();
    let closed = false;
    if (client) client.onclose = () => (closed = true);

    await manager.closeAll();
    expect(closed).toBe(true);
  });

  it("throws McpStartupError when config references an environment variable that isn't set", async () => {
    // The missing-env-var failure path (config.ts's resolveEnvRef) reaching an actual connection
    // attempt, not just the unit-level resolveEnvRef test in mcp-config.test.ts.
    manager = new McpClientManager({
      test: {
        type: "stdio",
        command: process.execPath,
        args: ["--import", "tsx/esm", FIXTURE_PATH],
        env: { SOME_TOKEN: { env: "NANOCODE_TEST_DOES_NOT_EXIST_XYZ" } },
      },
    });
    await expect(manager.listTools("test")).rejects.toThrow(/NANOCODE_TEST_DOES_NOT_EXIST_XYZ/);
  });

  describe("streamableHttp transport (real local HTTP server)", () => {
    let httpServer: HttpMcpServerHandle;

    afterEach(async () => {
      await httpServer?.close();
    });

    it("connects over HTTP and calls a real tool", async () => {
      httpServer = await startHttpMcpServer();
      manager = new McpClientManager({ test: { type: "streamableHttp", url: httpServer.url } });
      expect(await manager.callTool("test", "echo", { text: "over http" })).toBe("over http");
    });

    it("resolves header env-var references for the HTTP transport", async () => {
      httpServer = await startHttpMcpServer();
      manager = new McpClientManager({
        test: {
          type: "streamableHttp",
          url: httpServer.url,
          headers: { Authorization: { env: "NANOCODE_TEST_HTTP_TOKEN" } },
        },
      });
      process.env.NANOCODE_TEST_HTTP_TOKEN = "Bearer test-token";
      try {
        // The fixture server doesn't check the header -- this just proves resolveEnvRefs is
        // actually wired into the HTTP transport's request headers without throwing.
        expect(await manager.callTool("test", "echo", { text: "authed" })).toBe("authed");
      } finally {
        delete process.env.NANOCODE_TEST_HTTP_TOKEN;
      }
    });
  });
});
