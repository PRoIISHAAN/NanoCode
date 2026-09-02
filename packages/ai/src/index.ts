// @nanocode/ai — thin wrapper around @earendil-works/pi-ai.
//
// pi-ai does not export a single default provider or model: `builtinModels()` (from its
// "providers/all" subpath, not its top-level export) returns a `MutableModels` collection with
// every built-in provider (anthropic, openai, google, ...) already registered, each with its own
// auth resolution (env vars, OAuth, ambient credentials). Nothing is "selected" until a caller
// picks a provider + model id and pi-ai confirms that provider's auth is actually configured.
// That's exactly the seam our decision "no default model provider — must configure" hangs off:
// we never hardcode a provider/model here, we just validate whatever the caller asked for.

import type { Api, CreateModelsOptions, Model, MutableModels } from "@earendil-works/pi-ai";
import { builtinModels } from "@earendil-works/pi-ai/providers/all";

// Re-export the pi-ai types AND the few runtime values (EventStream, validateToolArguments) that
// the rest of nanocode needs, so every other package imports them from "@nanocode/ai" instead of
// reaching into "@earendil-works/pi-ai" directly. If we ever need to patch or narrow one of these,
// this is the one place to do it.
// AssistantMessageEventStream is deliberately NOT re-exported as a value here: pi-ai's own
// top-level index re-exports it via two different paths (a type-only re-export from types.ts,
// and a value re-export from utils/event-stream.ts's wildcard export), and re-exporting that
// single name a third time from this file resolves to the type-only declaration, not the class --
// "cannot be used as a value because it was exported using 'export type'". The plain generic
// `EventStream` base class (exported below) has no such ambiguity and is what callers that need
// to construct a fake/test event stream should use instead (see packages/agent/test/agent.test.ts).
export type {
  Api,
  AssistantMessage,
  AssistantMessageEvent,
  AssistantMessageEventStream,
  AuthContext,
  Context,
  Credential,
  CredentialInfo,
  CredentialStore,
  ImageContent,
  Message,
  Model,
  MutableModels,
  Provider,
  SimpleStreamOptions,
  TextContent,
  ThinkingBudgets,
  Tool,
  ToolCall,
  ToolResultMessage,
  Transport,
} from "@earendil-works/pi-ai";
export {
  createAssistantMessageDiagnostic,
  EventStream,
  validateToolArguments,
} from "@earendil-works/pi-ai";
export { FileCredentialStore } from "./credential-store.ts";
export {
  readStoredModelSelection,
  type StoredModelSelection,
  writeStoredModelSelection,
} from "./model-selection-store.ts";

/** Which provider + model the caller wants to use, before we've confirmed either exists or is configured. */
export interface ModelSelection {
  provider: string;
  model: string;
}

/**
 * Thrown whenever we can't get from a `ModelSelection` to a usable `Model` — either nothing was
 * configured, the provider name isn't one pi-ai knows about, the model id isn't in that
 * provider's catalog, or the provider has no credentials. Every failure path is a distinct,
 * readable message rather than a generic "not found", since this is the first thing a new
 * nanocode user hits if they haven't set anything up yet.
 */
export class ModelConfigurationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ModelConfigurationError";
  }
}

/**
 * Builds the full pi-ai provider registry. Call this once per process — it's cheap (no network
 * calls happen until something actually streams a request or explicitly calls `refresh()`), but
 * there's no reason to build it twice.
 */
export function createModelsRegistry(options?: CreateModelsOptions): MutableModels {
  return builtinModels(options);
}

/**
 * Reads which provider/model to use from the environment. We deliberately do not fall back to a
 * default here — `NANOCODE_PROVIDER`/`NANOCODE_MODEL` must both be set, or we throw immediately
 * with a message telling the caller what to set, rather than silently picking a model (and a
 * provider bill) the user didn't choose.
 */
export function readModelSelectionFromEnv(env: NodeJS.ProcessEnv = process.env): ModelSelection {
  const provider = env.NANOCODE_PROVIDER;
  const model = env.NANOCODE_MODEL;
  if (!provider || !model) {
    throw new ModelConfigurationError(
      "No model configured. Set NANOCODE_PROVIDER and NANOCODE_MODEL (e.g. " +
        "NANOCODE_PROVIDER=anthropic NANOCODE_MODEL=claude-sonnet-5) and make sure that " +
        "provider's credentials are set (e.g. ANTHROPIC_API_KEY).",
    );
  }
  return { provider, model };
}

/**
 * Turns a `ModelSelection` into a real, usable `Model<Api>` — or throws a `ModelConfigurationError`
 * explaining exactly what's wrong. This is the one function the agent loop calls before it can do
 * anything else, and it's the enforcement point for "no default, must configure": every failure
 * mode below is a caller mistake we want to surface immediately, not a runtime crash three layers
 * deeper when a request actually goes out.
 */
export async function resolveModel(
  models: MutableModels,
  selection: ModelSelection,
): Promise<Model<Api>> {
  // `getProviders()` is the full built-in registry regardless of auth state, so this check
  // catches a typo'd provider name ("anthopic") before we even ask about credentials.
  const knownProviderIds = models.getProviders().map((p) => p.id);
  if (!knownProviderIds.includes(selection.provider)) {
    throw new ModelConfigurationError(
      `Unknown provider "${selection.provider}". Known providers: ${knownProviderIds.sort().join(", ")}.`,
    );
  }

  // `checkAuth` resolves undefined when the provider has no credentials configured at all (no
  // env var, no OAuth login, no ambient credential file) — it does not throw for "unconfigured",
  // only for a broken/expired credential that IS present. That's the "must configure" gate.
  const auth = await models.checkAuth(selection.provider);
  if (!auth) {
    throw new ModelConfigurationError(
      `Provider "${selection.provider}" has no credentials configured. Set its API key ` +
        "(or complete its OAuth login) before running nanocode.",
    );
  }

  // getModel() is a synchronous lookup against the provider's last-known model list — for the
  // static (non-dynamic) providers pi-ai ships built-in catalogs for, this list is already
  // populated without needing to call refresh() first.
  const model = models.getModel(selection.provider, selection.model);
  if (!model) {
    const knownModelIds = models.getModels(selection.provider).map((m) => m.id);
    throw new ModelConfigurationError(
      `Model "${selection.model}" not found for provider "${selection.provider}". ` +
        `Known models for this provider: ${knownModelIds.sort().join(", ") || "(none)"}.`,
    );
  }

  return model;
}
