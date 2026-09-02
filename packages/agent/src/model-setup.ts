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
   * credentials outside nanocode (AWS profile, ADC file) and have no interactive login step. */
  supportsApiKeyLogin: boolean;
}

export interface ModelOption {
  id: string;
  name: string;
}

/**
 * Excludes any provider with no `auth.apiKey` at all -- an OAuth-only provider (e.g. pi-ai's
 * built-in `openai-codex`, `auth: { oauth: ... }`, no `apiKey` entry whatsoever) has no path
 * nanocode can ever use, since ADR 0004 declined OAuth entirely. Listing it as selectable would
 * dead-end the user after model choice with no way back except quitting the whole TUI -- an L4
 * VERIFY finding against an earlier version of this function, which conflated "ambient-only
 * (Bedrock/Vertex, still usable)" and "OAuth-only (never usable here)" under the same
 * `supportsApiKeyLogin: false` signal. Filtering here means the picker only ever shows providers
 * nanocode can genuinely configure, whether via interactive login or ambient credentials.
 */
export async function listProviderOptions(models: MutableModels): Promise<ProviderOption[]> {
  const providers = models.getProviders().filter((provider) => provider.auth.apiKey !== undefined);
  return Promise.all(
    providers.map(async (provider) => ({
      id: provider.id,
      name: provider.name,
      hasCredential: (await models.checkAuth(provider.id)) !== undefined,
      supportsApiKeyLogin: provider.auth.apiKey?.login !== undefined,
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
