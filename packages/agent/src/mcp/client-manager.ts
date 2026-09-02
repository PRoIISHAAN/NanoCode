// The real MCP client lives here, on the TypeScript host -- not inside the Python kernel. Python
// code never talks to an MCP server directly; every call crosses the existing host_request bridge
// (packages/kernel/python/nanocode_kernel/mcp.py -> host-handlers.ts -> this manager). See
// decisions/0009-mcp-client-support.md for why: avoids a second per-language MCP SDK dependency,
// and matches the pattern nanocode already uses for rlm.run()/task_state.set()/recall_search().
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import {
  getDefaultEnvironment,
  StdioClientTransport,
} from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { McpConfig, McpServerConfig } from "./config.ts";
import { resolveEnvRefs } from "./config.ts";

const DEFAULT_STARTUP_TIMEOUT_MS = 20_000;
const DEFAULT_CALL_TIMEOUT_MS = 60_000;

/** The subset of the SDK's `CallToolResult` this module actually reads -- kept as our own minimal
 * shape rather than the SDK's exact overload-resolved return type, which varies (a legacy
 * backward-compatibility variant without `content` is part of the same union) depending on which
 * `resultSchema` overload TypeScript happens to pick. */
interface ToolCallResult {
  content?: Array<{ type: string; text?: string }>;
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
}

export interface McpToolSummary {
  name: string;
  description?: string;
  inputSchema: unknown;
}

export class McpStartupError extends Error {
  constructor(
    public readonly server: string,
    reason: string,
  ) {
    super(`MCP server "${server}" failed to start: ${reason}`);
    this.name = "McpStartupError";
  }
}

export class McpToolCallError extends Error {
  constructor(
    public readonly server: string,
    public readonly tool: string,
    reason: string,
  ) {
    super(`MCP tool "${server}/${tool}" call failed: ${reason}`);
    this.name = "McpToolCallError";
  }
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function buildTransport(config: McpServerConfig) {
  if (config.type === "stdio") {
    return new StdioClientTransport({
      command: config.command,
      args: config.args,
      cwd: config.cwd,
      env: { ...getDefaultEnvironment(), ...resolveEnvRefs(config.env) },
    });
  }
  return new StreamableHTTPClientTransport(new URL(config.url), {
    requestInit: { headers: resolveEnvRefs(config.headers) },
  });
}

/**
 * Manages lazy, per-server MCP connections for one nanocode session. A connection is opened on
 * first use (`listTools`/`callTool`), not at construction -- consistent with the "MCP support is
 * opt-in, not an error to have unconfigured" stance in config.ts. There is no automatic
 * reconnection loop: a failed or crashed connection is simply dropped from the cache, so the next
 * call to that server opens a fresh one, rather than nanocode building its own retry/backoff logic.
 */
export class McpClientManager {
  private readonly connections = new Map<string, Promise<Client>>();

  constructor(private readonly config: McpConfig) {}

  listServers(): string[] {
    return Object.keys(this.config);
  }

  /** Returns the already-connected client for `server`, if one exists, without opening a new
   * connection -- a read-only peek at internal state for tests that need to verify a specific
   * connection (e.g. attaching an `onclose` listener before `closeAll()`), not part of the public
   * API surface `mcp.py`'s host_request handlers use. */
  getConnectedClient(server: string): Promise<Client> | undefined {
    return this.connections.get(server);
  }

  private getServerConfig(server: string): McpServerConfig {
    const config = this.config[server];
    if (!config) throw new Error(`no MCP server named "${server}" is configured`);
    return config;
  }

  private async connect(server: string, config: McpServerConfig): Promise<Client> {
    const client = new Client({ name: "nanocode", version: "0.1.0" });
    const transport = buildTransport(config);
    const startupTimeoutMs = config.startupTimeoutMs ?? DEFAULT_STARTUP_TIMEOUT_MS;
    try {
      await client.connect(transport, { timeout: startupTimeoutMs });
    } catch (error) {
      throw new McpStartupError(server, describeError(error));
    }
    return client;
  }

  private getConnection(server: string): Promise<Client> {
    const config = this.getServerConfig(server);
    let pending = this.connections.get(server);
    if (!pending) {
      pending = this.connect(server, config).catch((error: unknown) => {
        // Don't cache a failed connection attempt -- the next call should try again fresh rather
        // than permanently remembering a transient startup failure.
        this.connections.delete(server);
        throw error;
      });
      this.connections.set(server, pending);
    }
    return pending;
  }

  async listTools(server: string): Promise<McpToolSummary[]> {
    const client = await this.getConnection(server);
    const result = await client.listTools();
    return result.tools.map((tool) => ({
      name: tool.name,
      description: tool.description,
      inputSchema: tool.inputSchema,
    }));
  }

  /** Calls one MCP tool and returns its result: `structuredContent` when the server provided one,
   * else every `text` content block joined, else the raw content array for anything else (images,
   * embedded resources, ...). Throws `McpToolCallError` if the server reports `isError`. */
  async callTool(server: string, tool: string, args: Record<string, unknown>): Promise<unknown> {
    const config = this.getServerConfig(server);
    const client = await this.getConnection(server);
    const callTimeoutMs = config.callTimeoutMs ?? DEFAULT_CALL_TIMEOUT_MS;
    let result: ToolCallResult;
    try {
      result = (await client.callTool({ name: tool, arguments: args }, undefined, {
        timeout: callTimeoutMs,
      })) as ToolCallResult;
    } catch (error) {
      throw new McpToolCallError(server, tool, describeError(error));
    }

    if (result.isError) {
      throw new McpToolCallError(server, tool, summarizeErrorContent(result.content));
    }
    if (result.structuredContent !== undefined) return result.structuredContent;
    const textBlocks = (result.content ?? []).filter(
      (block): block is { type: "text"; text: string } => block.type === "text",
    );
    if (textBlocks.length > 0) return textBlocks.map((block) => block.text).join("");
    return result.content;
  }

  async closeAll(): Promise<void> {
    const pending = [...this.connections.values()];
    this.connections.clear();
    await Promise.allSettled(
      pending.map(async (clientPromise) => {
        const client = await clientPromise.catch(() => undefined);
        await client?.close();
      }),
    );
  }
}

function summarizeErrorContent(content: unknown): string {
  if (!Array.isArray(content)) return "unknown error";
  const text = content
    .filter((block): block is { type: "text"; text: string } => block?.type === "text")
    .map((block) => block.text)
    .join(" ");
  return text || "unknown error";
}
