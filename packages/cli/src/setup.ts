// Shared setup for both nanocode entrypoints (headless `run` in index.ts, interactive `tui.tsx`):
// resolve trust, resolve the model, construct the kernel/session/telemetry/MCP wiring. Kept here
// rather than duplicated in both, and deliberately outside packages/tui -- the TUI package itself
// must never import packages/kernel or packages/ai directly (decisions/0005-tui-stack.md's
// invariant), so the entrypoint that touches those lives in packages/cli, handing the TUI only an
// already-constructed `Session`.
import { randomUUID } from "node:crypto";
import {
  attachTelemetry,
  createExporterFromEnv,
  createIpythonTool,
  createMcpCallToolHandler,
  createMcpListServersHandler,
  createMcpListToolsHandler,
  createRecallGetHandler,
  createRecallSearchHandler,
  createRecursionHandler,
  createTaskStateHandler,
  DEFAULT_MAX_RECURSION_DEPTH,
  loadMcpConfig,
  McpClientManager,
  Session,
  SessionLog,
  TaskStateStore,
  type TelemetryHandle,
  TrustStore,
} from "@nanocode/agent";
import {
  type Api,
  createModelsRegistry,
  FileCredentialStore,
  type Model,
  ModelConfigurationError,
  type MutableModels,
  readModelSelectionFromEnv,
  readStoredModelSelection,
  resolveModel,
} from "@nanocode/ai";
import { ReplKernelManager } from "@nanocode/kernel";
import { ensureTrust } from "./trust-prompt.ts";

/** MCP tools are never separate AgentTool entries (decisions/0009-mcp-client-support.md) -- the
 * system prompt just needs to tell the model the two Python-level ways to reach them, and name
 * whichever per-server proxies are actually bound this run. */
function buildSystemPrompt(mcpServers: string[]): string {
  const base =
    "You are nanocode, a coding agent. Your only tool is `ipython`, a persistent Python REPL: " +
    "there is no separate file-read, file-write, or shell tool. Use Python's own open()/pathlib for " +
    "file I/O and the subprocess module for shell commands. State persists across calls within this " +
    "session. Inside that REPL, `await rlm.run(prompt)` recursively spawns a fresh sub-agent (its " +
    "own kernel, its own conversation) to work on `prompt` and blocks until it returns its final " +
    "text answer; recursion is depth-limited and a call beyond the limit raises an error. Two more " +
    "builtins manage long-running context: call `await task_state.set(goal=..., focus=..., " +
    "decision=..., next_action=...)` whenever the goal, current focus, a key decision, or the next " +
    "step changes -- it survives context compaction, so keep it current. Older tool output gets " +
    "archived automatically as the conversation grows; if you need something no longer visible, " +
    "use `await recall_search(query)` to find it and `await recall(id)` to fetch it in full.";
  if (mcpServers.length === 0) return base;
  const proxyExamples = mcpServers.map((name) => `\`await ${name}.<tool>(...)\``).join(", ");
  return (
    `${base} MCP tools are also available from Python, not as separate tools: ` +
    'await mcp.list_tools("<server>") lists what a configured server offers, and ' +
    'await mcp.call_tool("<server>", "<tool>", {...}) calls one. Configured servers are also ' +
    `bound directly by name for convenience -- ${proxyExamples}.`
  );
}

export interface NanocodeSetup {
  session: Session;
  kernel: ReplKernelManager;
  telemetry: TelemetryHandle;
  mcpManager: McpClientManager;
  /** Flushes telemetry, closes MCP connections, and shuts down the kernel. Call once, when the
   * run/interactive session ends. */
  cleanup(): Promise<void>;
}

/**
 * Constructs the provider registry, wired to nanocode's own on-disk credential store
 * (~/.nanocode/credentials.json, decisions/0011-tui-onboarding.md) instead of pi-ai's default
 * in-memory-only one -- so a key entered through the TUI's onboarding flow survives past the
 * current process. No side effects beyond that (no network, no model resolution).
 */
export function createModelsContext(): { models: MutableModels } {
  const credentials = new FileCredentialStore();
  const models = createModelsRegistry({ credentials });
  return { models };
}

/**
 * Attempts to resolve a model to start the TUI with, without ever prompting: `NANOCODE_PROVIDER`/
 * `NANOCODE_MODEL` env vars win when both are set (an explicit per-invocation override); otherwise
 * falls back to the provider+model last chosen through onboarding
 * (`ModelSetupController.finish()` persists it via `writeStoredModelSelection`). Without this
 * fallback, a run with no env vars set had no way to know which already-configured provider/model
 * to use and re-triggered onboarding from scratch every time, even with a working credential
 * already saved -- a real bug the user hit directly, not a hypothetical.
 *
 * Unlike `resolveModel` itself, this never throws for "nothing configured yet" or "provider has no
 * credential" -- both are now a normal, expected TUI-startup state (the caller shows onboarding
 * instead of crashing), not a fatal error. Any other kind of failure still propagates.
 *
 * `storedSelectionFilePath` overrides where the fallback reads from -- omitted in real usage
 * (defaults to `~/.nanocode/model-selection.json`), passed explicitly only by tests so they never
 * touch the real file.
 */
export async function tryResolveConfiguredModel(
  models: MutableModels,
  storedSelectionFilePath?: string,
): Promise<Model<Api> | undefined> {
  let selection: { provider: string; model: string } | undefined;
  try {
    selection = readModelSelectionFromEnv();
  } catch (error) {
    if (!(error instanceof ModelConfigurationError)) throw error;
    selection = await readStoredModelSelection(storedSelectionFilePath);
  }
  if (!selection) return undefined;

  try {
    return await resolveModel(models, selection);
  } catch (error) {
    if (error instanceof ModelConfigurationError) return undefined;
    throw error;
  }
}

/**
 * Everything a nanocode entrypoint needs before it can talk to the model: gates on directory trust
 * (throws `TrustDeniedError` on decline -- the caller must not proceed past that), resolves the
 * configured model (throws `ModelConfigurationError` if nothing's configured), and constructs the
 * kernel/session/telemetry/MCP wiring shared by both `run` and the interactive TUI. Used as-is by
 * the headless `run` command, which still fails fast on missing config exactly like before this
 * change -- matching pi/prime's own headless behavior (see decisions/0011-tui-onboarding.md).
 * `tui.tsx` composes `createModelsContext`/`tryResolveConfiguredModel`/`buildRuntimeForModel`
 * itself instead, so an unconfigured launch can show onboarding rather than exit.
 */
export async function createNanocodeSession(): Promise<NanocodeSetup> {
  // M4: gate before anything else -- nanocode's only tool is an unrestricted Python REPL, so an
  // unseen directory must be explicitly trusted before any credential is even resolved, let alone
  // a kernel started.
  const trustStore = await TrustStore.open();
  await ensureTrust(trustStore, process.cwd());

  const { models } = createModelsContext();
  const model = await resolveModel(models, readModelSelectionFromEnv());
  return buildRuntimeForModel(model, models);
}

/**
 * The rest of `createNanocodeSession`'s work once a `Model` is already in hand: builds the
 * session log, MCP manager, kernel, `Session`, and telemetry. Trust must already be resolved by
 * the caller before this runs -- this function never touches the trust store itself.
 */
export async function buildRuntimeForModel(
  model: Model<Api>,
  models: MutableModels,
): Promise<NanocodeSetup> {
  // M3: one JSONL log per run under .nanocode/sessions/ (see .gitignore) -- crash-safe, append-only
  // (packages/agent/src/session/log.ts) -- plus the in-memory task-state box the `task_state.set`
  // builtin writes to and the compaction engine reads from every turn.
  const sessionId = randomUUID();
  const sessionLog = await SessionLog.open(`.nanocode/sessions/${sessionId}.jsonl`, sessionId);
  const taskStateStore = new TaskStateStore();

  // M6: global-only config (~/.nanocode/mcp.json, never project-local -- see
  // decisions/0009-mcp-client-support.md). Server names are passed to the kernel subprocess via an
  // env var so it can bind a per-server Python proxy for each one at startup.
  const mcpConfig = await loadMcpConfig();
  const mcpManager = new McpClientManager(mcpConfig);
  const mcpServerNames = mcpManager.listServers();
  const systemPrompt = buildSystemPrompt(mcpServerNames);

  const kernel = new ReplKernelManager({
    env: mcpServerNames.length > 0 ? { NANOCODE_MCP_SERVERS: mcpServerNames.join(",") } : undefined,
    hostHandlers: {
      "rlm.run": createRecursionHandler({
        models,
        model,
        systemPrompt,
        depth: 0,
        maxDepth: DEFAULT_MAX_RECURSION_DEPTH,
      }),
      "task_state.set": createTaskStateHandler(taskStateStore, sessionLog),
      "recall.search": createRecallSearchHandler(sessionLog),
      "recall.get": createRecallGetHandler(sessionLog),
      "mcp.list_servers": createMcpListServersHandler(mcpManager),
      "mcp.list_tools": createMcpListToolsHandler(mcpManager),
      "mcp.call_tool": createMcpCallToolHandler(mcpManager),
    },
  });
  const session = new Session({
    // Bind Models.streamSimple so the loop calls back into the SAME registry that already
    // validated this provider is configured -- no separate apiKey plumbing needed (see
    // packages/agent/src/types.ts's comment on why the old getApiKey/apiKey hooks don't exist).
    streamFn: models.streamSimple.bind(models),
    initialState: {
      model,
      systemPrompt,
      tools: [createIpythonTool(kernel)],
    },
    memory: {
      sessionLog,
      models,
      getTaskState: () => taskStateStore.get(),
    },
  });

  // M4: local, in-memory-only telemetry (a Session.subscribe() listener, no new instrumentation
  // in agent-loop.ts) -- flushed to an exporter only if NANOCODE_TELEMETRY_ENDPOINT is set; a
  // no-op otherwise, so nothing leaves the machine by default.
  const telemetry = attachTelemetry(session, { exporter: createExporterFromEnv() });

  return {
    session,
    kernel,
    telemetry,
    mcpManager,
    cleanup: async () => {
      await telemetry.flush();
      await mcpManager.closeAll();
      await kernel.shutdown();
    },
  };
}
