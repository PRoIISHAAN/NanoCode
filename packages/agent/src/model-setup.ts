// Bridges packages/tui's onboarding UI to @nanocode/ai's real provider/auth API, without the TUI
// ever importing @nanocode/ai itself (context-graph.json's tui_isolation invariant). Every type
// exported from this file is plain data or a closure-typed function -- no pi-ai type (Provider,
// Model, MutableModels) crosses into packages/tui. See decisions/0011-tui-onboarding.md.
import type { MutableModels } from "@nanocode/ai";

export interface ProviderOption {
  id: string;
  name: string;
  /** Whether a credential is already stored/ambient for this provider -- if true, the setup flow
   * can skip straight to model selection. */
  hasCredential: boolean;
  /** False for ambient-only providers (e.g. amazon-bedrock, google-vertex), which configure
   * credentials outside nanocode (AWS profile, ADC file) and have no interactive login step --
   * neither the API Key nor the OAuth setup screen lists a provider with this false and
   * `supportsOAuthLogin` also false, since there would be nothing to actually do on either one. Such
   * a provider is still returned by `listProviderOptions` (so "/login &lt;its-exact-id&gt;" and
   * "/model" -- once it has ambient credentials -- can still reach it), just never offered when
   * browsing either method's picker. */
  supportsApiKeyLogin: boolean;
  /** Whether this provider has a real, provider-sanctioned OAuth login (pi-ai's own bundled
   * implementation -- a subscription sign-in like "Claude Pro/Max" or "GitHub Copilot", or a
   * device-code/PKCE flow another provider exposes for third-party CLIs). Implemented "for the
   * providers that allow it," per the user's own framing -- this is standard, provider-sanctioned
   * OAuth, not credential-stealing/impersonation of an official first-party client, which nanocode
   * has never done and was never asked to build. */
  supportsOAuthLogin: boolean;
  /** The OAuth method's own display name (e.g. "Anthropic (Claude Pro/Max)"), when
   * `supportsOAuthLogin` is true -- distinct from `name` (the provider's own name), since a
   * provider's OAuth login is often a specific subscription product, not just "the provider." */
  oauthName?: string;
}

export interface ModelOption {
  id: string;
  name: string;
}

/**
 * Excludes a provider with NEITHER `auth.apiKey` NOR `auth.oauth` -- there would be no path
 * nanocode could ever use for it at all. (An earlier version of nanocode excluded any OAuth-only
 * provider entirely, since OAuth login wasn't implemented yet; now that it is, a provider needs
 * only one of the two auth methods to be listed.) Still guards against the real bug an L4 VERIFY
 * finding caught in that earlier version: conflating "ambient-only (Bedrock/Vertex, still usable
 * via `apiKey.resolve()` against env/profile state)" and "no usable auth at all" under the same
 * `supportsApiKeyLogin: false` signal would dead-end the user after model choice with no way back
 * except quitting the whole TUI -- filtering here means the picker only ever shows providers
 * nanocode can genuinely configure, one way or another.
 */
export async function listProviderOptions(models: MutableModels): Promise<ProviderOption[]> {
  const providers = models
    .getProviders()
    .filter((provider) => provider.auth.apiKey !== undefined || provider.auth.oauth !== undefined);
  return Promise.all(
    providers.map(async (provider) => ({
      id: provider.id,
      name: provider.name,
      hasCredential: (await models.checkAuth(provider.id)) !== undefined,
      supportsApiKeyLogin: provider.auth.apiKey?.login !== undefined,
      supportsOAuthLogin: provider.auth.oauth !== undefined,
      oauthName: provider.auth.oauth?.name,
    })),
  );
}

export function listModelOptions(models: MutableModels, providerId: string): ModelOption[] {
  const provider = models.getProvider(providerId);
  if (!provider) return [];
  return provider.getModels().map((model) => ({ id: model.id, name: model.name }));
}

/**
 * Drives pi-ai's real login orchestration (`Models.login` -> the provider's own `ApiKeyAuth.login`
 * -> `CredentialStore.modify`) with a key the TUI already collected via its own text input --
 * `prompt()` here just returns it immediately instead of pi-ai prompting interactively itself.
 * pi-ai still owns persistence, exactly as it would for a real `/login` dialog.
 */
export async function saveApiKey(
  models: MutableModels,
  providerId: string,
  apiKey: string,
): Promise<void> {
  await models.login(providerId, "api_key", {
    prompt: async () => apiKey,
    notify: () => {},
  });
}

/** A question an OAuth login flow needs answered before it can continue -- plain-data mirror of
 * pi-ai's own `AuthPrompt` (see `loginWithOAuth`'s own comment on why this file never re-exports
 * pi-ai's real type directly). `signal`, when it fires, means the flow no longer needs this
 * specific answer (e.g. Anthropic's own OAuth races a local callback-server redirect against this
 * same "paste the code manually" prompt -- whichever settles first cancels the other) -- the UI
 * should dismiss/disable whatever input it showed for this prompt, without treating it as an error. */
export type OAuthPrompt = {
  signal?: AbortSignal;
} & (
  | { type: "text"; message: string; placeholder?: string }
  | { type: "secret"; message: string; placeholder?: string }
  | {
      type: "select";
      message: string;
      options: readonly { id: string; label: string; description?: string }[];
    }
  | { type: "manual_code"; message: string; placeholder?: string }
);

/** Something an OAuth login flow wants to tell the user, with nothing to answer -- plain-data
 * mirror of pi-ai's own `AuthEvent`. `auth_url`/`device_code` are the two real shapes a provider's
 * flow uses to hand back "go here to finish signing in" (a browser redirect vs. a short code typed
 * into a device-pairing page); `info`/`progress` are plain status lines. */
export type OAuthEvent =
  | { type: "info"; message: string }
  | { type: "auth_url"; url: string; instructions?: string }
  | {
      type: "device_code";
      userCode: string;
      verificationUri: string;
      intervalSeconds?: number;
      expiresInSeconds?: number;
    }
  | { type: "progress"; message: string };

/** The UI-side half of an OAuth login: shown every event the flow raises, and asked to answer
 * every prompt it needs. `signal` aborts the WHOLE flow (the user cancelled) -- distinct from an
 * individual `OAuthPrompt.signal`, which only cancels that one still-pending question. */
export interface OAuthLoginHandlers {
  signal?: AbortSignal;
  notify(event: OAuthEvent): void;
  prompt(prompt: OAuthPrompt): Promise<string>;
}

/**
 * Drives pi-ai's real OAuth login orchestration (`Models.login(providerId, "oauth", ...)` -> the
 * provider's own `OAuthAuth.login`, e.g. running a local PKCE callback server for Anthropic or
 * polling a device-code endpoint for GitHub Copilot -> `CredentialStore.modify`) for whichever
 * provider `id` names, translating pi-ai's own `AuthPrompt`/`AuthEvent` into this file's plain-data
 * mirrors (`OAuthPrompt`/`OAuthEvent`) along the way -- packages/tui itself never imports pi-ai's
 * real types, only these, matching how `ProviderOption`/`ModelOption` already keep pi-ai's own
 * `Provider`/`Model` out of the TUI entirely (context-graph.json's tui_isolation invariant). One
 * generic bridge covers every OAuth-capable provider: nothing here is provider-specific, the same
 * way pi-ai's own `AuthInteraction` contract is deliberately provider-agnostic.
 */
export async function loginWithOAuth(
  models: MutableModels,
  providerId: string,
  handlers: OAuthLoginHandlers,
): Promise<void> {
  await models.login(providerId, "oauth", {
    signal: handlers.signal,
    notify: (event) => {
      switch (event.type) {
        case "info":
          handlers.notify({ type: "info", message: event.message });
          return;
        case "auth_url":
          handlers.notify({ type: "auth_url", url: event.url, instructions: event.instructions });
          return;
        case "device_code":
          handlers.notify({
            type: "device_code",
            userCode: event.userCode,
            verificationUri: event.verificationUri,
            intervalSeconds: event.intervalSeconds,
            expiresInSeconds: event.expiresInSeconds,
          });
          return;
        case "progress":
          handlers.notify({ type: "progress", message: event.message });
      }
    },
    prompt: (prompt) => {
      switch (prompt.type) {
        case "text":
          return handlers.prompt({
            type: "text",
            message: prompt.message,
            placeholder: prompt.placeholder,
            signal: prompt.signal,
          });
        case "secret":
          return handlers.prompt({
            type: "secret",
            message: prompt.message,
            placeholder: prompt.placeholder,
            signal: prompt.signal,
          });
        case "select":
          return handlers.prompt({
            type: "select",
            message: prompt.message,
            options: prompt.options,
            signal: prompt.signal,
          });
        case "manual_code":
          return handlers.prompt({
            type: "manual_code",
            message: prompt.message,
            placeholder: prompt.placeholder,
            signal: prompt.signal,
          });
      }
    },
  });
}
