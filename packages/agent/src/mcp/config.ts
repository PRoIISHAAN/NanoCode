// MCP server configuration: global-only (~/.nanocode/mcp.json), never project-local -- a stdio MCP
// server is an arbitrary subprocess, so a malicious or compromised repository must not be able to
// get nanocode to launch one (or redirect a trusted server's traffic) just by adding a settings
// file to the repo. See decisions/0009-mcp-client-support.md.
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

/** A secret is always a reference to an environment variable name, never a literal value, so a
 * shared config file can never itself contain a credential. */
export interface McpEnvRef {
  env: string;
}

export interface McpStdioServerConfig {
  type: "stdio";
  command: string;
  args?: string[];
  cwd?: string;
  env?: Record<string, McpEnvRef>;
  /** Milliseconds to wait for the server to finish starting before giving up. */
  startupTimeoutMs?: number;
  /** Milliseconds to wait for any single tool call to complete before giving up. */
  callTimeoutMs?: number;
}

export interface McpHttpServerConfig {
  type: "streamableHttp";
  url: string;
  headers?: Record<string, McpEnvRef>;
  startupTimeoutMs?: number;
  callTimeoutMs?: number;
}

export type McpServerConfig = McpStdioServerConfig | McpHttpServerConfig;

export type McpConfig = Record<string, McpServerConfig>;

const DEFAULT_CONFIG_PATH = join(homedir(), ".nanocode", "mcp.json");

/** Resolves an `McpEnvRef` to its actual current value, or throws with a clear message naming the
 * missing variable -- fails fast at connection time rather than silently sending "undefined". */
export function resolveEnvRef(ref: McpEnvRef, env: NodeJS.ProcessEnv = process.env): string {
  const value = env[ref.env];
  if (value === undefined) {
    throw new Error(`MCP config references environment variable "${ref.env}", which is not set`);
  }
  return value;
}

export function resolveEnvRefs(
  refs: Record<string, McpEnvRef> | undefined,
  env: NodeJS.ProcessEnv = process.env,
): Record<string, string> {
  if (!refs) return {};
  const resolved: Record<string, string> = {};
  for (const [key, ref] of Object.entries(refs)) resolved[key] = resolveEnvRef(ref, env);
  return resolved;
}

/** Loads `~/.nanocode/mcp.json`. Returns an empty config (no configured servers) if the file
 * doesn't exist -- MCP support is opt-in, not an error to have unconfigured. */
export async function loadMcpConfig(filePath: string = DEFAULT_CONFIG_PATH): Promise<McpConfig> {
  try {
    const raw = await readFile(filePath, "utf8");
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error(`${filePath} must contain a JSON object mapping server names to configs`);
    }
    return parsed as McpConfig;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return {};
    throw error;
  }
}
