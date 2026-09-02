// Host_request handlers for the three MCP builtins Python calls into
// (packages/kernel/python/nanocode_kernel/mcp.py) -- the same
// registered-by-"type"-string pattern rlm.run/task_state.set/recall.search already use.
import type { HostRequestHandler } from "@nanocode/kernel";
import type { McpClientManager } from "./client-manager.ts";

export function createMcpListServersHandler(manager: McpClientManager): HostRequestHandler {
  return async () => manager.listServers();
}

export function createMcpListToolsHandler(manager: McpClientManager): HostRequestHandler {
  return async (data) => {
    if (typeof data.server !== "string" || data.server.length === 0) {
      throw new Error("mcp.list_tools requires a non-empty string server");
    }
    return manager.listTools(data.server);
  };
}

export function createMcpCallToolHandler(manager: McpClientManager): HostRequestHandler {
  return async (data) => {
    if (typeof data.server !== "string" || data.server.length === 0) {
      throw new Error("mcp.call_tool requires a non-empty string server");
    }
    if (typeof data.tool !== "string" || data.tool.length === 0) {
      throw new Error("mcp.call_tool requires a non-empty string tool");
    }
    const args =
      data.args && typeof data.args === "object" && !Array.isArray(data.args)
        ? (data.args as Record<string, unknown>)
        : {};
    return manager.callTool(data.server, data.tool, args);
  };
}
