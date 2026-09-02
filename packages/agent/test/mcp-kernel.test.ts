// M6: proves the Python-side builtins (packages/kernel/python/nanocode_kernel/mcp.py) actually
// cross the real host_request wire into the TS handlers, through a real kernel subprocess AND a
// real MCP test server -- the same "real kernel" reasoning session-memory.test.ts documents for
// task_state/recall, extended here to cover the per-server proxy binding too (NANOCODE_MCP_SERVERS).
import { fileURLToPath } from "node:url";
import { ReplKernelManager } from "@nanocode/kernel";
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
let kernel: ReplKernelManager | undefined;

afterEach(async () => {
  await kernel?.shutdown();
  kernel = undefined;
  await manager?.closeAll();
  manager = undefined;
});

describe("mcp kernel builtins (M6, real kernel + real MCP server)", () => {
  it("await mcp.list_servers()/list_tools()/call_tool() round-trip through a real kernel", async () => {
    manager = new McpClientManager(testConfig());
    kernel = new ReplKernelManager({
      hostHandlers: {
        "mcp.list_servers": createMcpListServersHandler(manager),
        "mcp.list_tools": createMcpListToolsHandler(manager),
        "mcp.call_tool": createMcpCallToolHandler(manager),
      },
    });

    const servers = await kernel.execute("await mcp.list_servers()");
    expect(servers.status).toBe("ok");
    expect(servers.result).toContain("test");

    const tools = await kernel.execute(
      "_tools = await mcp.list_tools('test')\nsorted(t['name'] for t in _tools)",
    );
    expect(tools.status).toBe("ok");
    expect(tools.result).toContain("echo");

    const called = await kernel.execute(
      "await mcp.call_tool('test', 'echo', {'text': 'hello from python'})",
    );
    expect(called.status).toBe("ok");
    expect(called.result).toContain("hello from python");
  });

  it("await mcp.call_tool() raises a Python RuntimeError when the server reports isError", async () => {
    manager = new McpClientManager(testConfig());
    kernel = new ReplKernelManager({
      hostHandlers: { "mcp.call_tool": createMcpCallToolHandler(manager) },
    });

    const result = await kernel.execute("await mcp.call_tool('test', 'fail', {})");
    expect(result.status).toBe("error");
    expect(result.error?.ename).toBe("RuntimeError");
  });

  it("a per-server proxy is bound by name and forwards attribute calls to call_tool()", async () => {
    manager = new McpClientManager(testConfig());
    kernel = new ReplKernelManager({
      env: { NANOCODE_MCP_SERVERS: "test" },
      hostHandlers: { "mcp.call_tool": createMcpCallToolHandler(manager) },
    });

    const result = await kernel.execute("await test.echo(text='via proxy')");
    expect(result.status).toBe("ok");
    expect(result.result).toContain("via proxy");
  });

  it("an unconfigured server name is not bound as a top-level proxy", async () => {
    manager = new McpClientManager(testConfig());
    kernel = new ReplKernelManager({
      env: { NANOCODE_MCP_SERVERS: "test" },
      hostHandlers: { "mcp.call_tool": createMcpCallToolHandler(manager) },
    });

    const result = await kernel.execute("nope");
    expect(result.status).toBe("error");
    expect(result.error?.ename).toBe("NameError");
  });
});
