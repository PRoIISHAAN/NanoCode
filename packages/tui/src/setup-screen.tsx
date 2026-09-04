// Proactive onboarding (decisions/0011-tui-onboarding.md): shown instead of the normal running
// session whenever App mounts without a Session yet. All state here is local via plain useState --
// nothing outside this component ever needs to read it, unlike the atom-backed state in app.tsx,
// so there's no reason to route it through an atom.
import type { ModelOption, OAuthLoginHandlers, ProviderOption, Session } from "@nanocode/agent";
import { Box, Text } from "ink";
import TextInput from "ink-text-input";
// biome-ignore lint/correctness/noUnusedImports: required by tsx's runtime JSX transform, not referenced directly in this file's own code
import React, { useState } from "react";
import { OAuthLoginFlow } from "./oauth-login.tsx";
import { SelectList } from "./select-list.tsx";

/** packages/cli/src/tui.tsx implements this, closing over the real MutableModels/resolveModel it
 * builds -- packages/tui never sees those types, only this plain interface. */
export interface ModelSetupController {
  listProviders(): Promise<ProviderOption[]>;
  listModels(providerId: string): ModelOption[];
  login(providerId: string, apiKey: string): Promise<void>;
  /** Drives a real, provider-sanctioned OAuth login (see ProviderOption.supportsOAuthLogin's own
   * comment) -- `handlers` is this component's own bridge between pi-ai's generic prompt/notify
   * interaction protocol and whatever UI is actually showing it (see oauth-login.tsx). */
  loginOAuth(providerId: string, handlers: OAuthLoginHandlers): Promise<void>;
  /** Best-effort opens a URL in the user's default browser -- an "auth_url" OAuth event's own real
   * work. Never rejects: the same URL is always ALSO shown as plain text, so a failure here (no
   * browser available, e.g. over SSH) never blocks the login flow, only loses the convenience. */
  openUrl(url: string): Promise<void>;
  /** Resolves the chosen model AND builds the full session runtime (kernel, telemetry, MCP) --
   * one step, so this component only ever hands App a fully-ready Session, never a partial one. */
  finish(providerId: string, modelId: string): Promise<Session>;
}

type SetupPhase =
  | { step: "choose-auth-method" }
  | { step: "loading" }
  | { step: "choose-provider"; authMethod: "api-key" | "oauth"; providers: ProviderOption[] }
  | { step: "enter-key"; provider: ProviderOption }
  | { step: "saving-key"; provider: ProviderOption }
  | { step: "oauth-login"; provider: ProviderOption }
  | { step: "choose-model"; provider: ProviderOption; models: ModelOption[] }
  | { step: "starting" }
  | { step: "error"; message: string };

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function SetupScreen({
  setup,
  onReady,
}: {
  setup: ModelSetupController;
  onReady: (session: Session) => void;
}) {
  // Starts on the auth-method choice, matching pi's own /login flow (which also asks OAuth vs.
  // API key first). OAuth now offers every provider with a real, provider-sanctioned OAuth login
  // (pi-ai's own bundled implementations -- e.g. Anthropic's Claude Pro/Max, GitHub Copilot) --
  // listProviders() only runs once an auth method is actually picked, not eagerly on mount.
  const [phase, setPhase] = useState<SetupPhase>({ step: "choose-auth-method" });

  const loadProviders = (authMethod: "api-key" | "oauth") => {
    setPhase({ step: "loading" });
    setup.listProviders().then(
      (providers) => {
        // Filtered to providers that actually support the CHOSEN method -- never `hasApiKeyAuth`
        // alone, which also includes ambient-only providers (Bedrock/Vertex: env var / cloud
        // profile resolution, nothing interactive to log in with). Onboarding asks "API Key" or
        // "OAuth" specifically, so only providers offering one of those two real login paths belong
        // in either list; an ambient-only provider has no path through this screen right now.
        const filtered = providers.filter((provider) =>
          authMethod === "oauth" ? provider.supportsOAuthLogin : provider.supportsApiKeyLogin,
        );
        setPhase({ step: "choose-provider", authMethod, providers: filtered });
      },
      (error: unknown) => setPhase({ step: "error", message: describeError(error) }),
    );
  };

  if (phase.step === "choose-auth-method") {
    return (
      <Box flexDirection="column">
        <Text>How would you like to authenticate?</Text>
        <SelectList
          items={[
            { id: "api-key", label: "API Key" },
            { id: "oauth", label: "OAuth", sublabel: "sign in with a provider account" },
          ]}
          onSelect={(id) => loadProviders(id === "oauth" ? "oauth" : "api-key")}
        />
      </Box>
    );
  }

  if (phase.step === "loading") {
    return <Text color="gray">Loading providers…</Text>;
  }

  if (phase.step === "error") {
    return <Text color="red">Setup failed: {phase.message}</Text>;
  }

  if (phase.step === "choose-provider") {
    const { authMethod, providers } = phase;
    return (
      <Box flexDirection="column">
        <Text>
          {authMethod === "oauth"
            ? "Sign in with which provider?"
            : "No model configured yet -- choose a provider:"}
        </Text>
        <SelectList
          items={providers.map((provider) => ({
            id: provider.id,
            label: authMethod === "oauth" ? (provider.oauthName ?? provider.name) : provider.name,
            sublabel: provider.hasCredential ? "configured" : undefined,
          }))}
          onSelect={(providerId) => {
            const provider = providers.find((p) => p.id === providerId);
            if (!provider) return;
            if (authMethod === "oauth") {
              setPhase({ step: "oauth-login", provider });
            } else if (provider.hasCredential) {
              // Already has a working API key (env var or previously saved) -- no need to ask for
              // it again, straight to model choice, matching the OAuth branch's own "already
              // signed in" shortcut one line up.
              setPhase({
                step: "choose-model",
                provider,
                models: setup.listModels(provider.id),
              });
            } else {
              setPhase({ step: "enter-key", provider });
            }
          }}
        />
      </Box>
    );
  }

  if (phase.step === "oauth-login") {
    const provider = phase.provider;
    return (
      <OAuthLoginFlow
        providerName={provider.oauthName ?? provider.name}
        startLogin={(handlers) => setup.loginOAuth(provider.id, handlers)}
        openUrl={setup.openUrl}
        onSuccess={() =>
          setPhase({ step: "choose-model", provider, models: setup.listModels(provider.id) })
        }
        onCancel={() => loadProviders("oauth")}
        onError={(message) => setPhase({ step: "error", message })}
      />
    );
  }

  if (phase.step === "enter-key") {
    const provider = phase.provider;
    return (
      <ApiKeyPrompt
        providerName={provider.name}
        onSubmit={async (apiKey) => {
          // Transition out of "enter-key" synchronously, before the `await` -- unmounts
          // <ApiKeyPrompt> (and its <TextInput>) immediately, the same guard every other
          // SelectList-driven step already has via SelectList unmounting on selection. Without
          // this, a second Enter press landing before `setup.login()` resolves could fire
          // `onSubmit` a second time concurrently (an L4 VERIFY finding -- ink-text-input's
          // onSubmit has no built-in re-entrancy guard of its own).
          setPhase({ step: "saving-key", provider });
          try {
            await setup.login(provider.id, apiKey);
            setPhase({ step: "choose-model", provider, models: setup.listModels(provider.id) });
          } catch (error) {
            setPhase({ step: "error", message: describeError(error) });
          }
        }}
      />
    );
  }

  if (phase.step === "saving-key") {
    return <Text color="gray">Saving API key…</Text>;
  }

  if (phase.step === "choose-model") {
    if (phase.models.length === 0) {
      return <Text color="red">Provider "{phase.provider.id}" has no available models.</Text>;
    }
    return (
      <Box flexDirection="column">
        <Text>Choose a model for {phase.provider.name}:</Text>
        <SelectList
          items={phase.models.map((model) => ({ id: model.id, label: model.name }))}
          onSelect={async (modelId) => {
            setPhase({ step: "starting" });
            try {
              const session = await setup.finish(phase.provider.id, modelId);
              onReady(session);
            } catch (error) {
              setPhase({ step: "error", message: describeError(error) });
            }
          }}
        />
      </Box>
    );
  }

  // phase.step === "starting"
  return <Text color="gray">Starting session…</Text>;
}

/** Exported for command-overlay.tsx's "/login" flow, which needs the exact same masked text-entry
 * step mid-session -- no reason to duplicate it. */
export function ApiKeyPrompt({
  providerName,
  onSubmit,
}: {
  providerName: string;
  onSubmit: (apiKey: string) => void;
}) {
  const [value, setValue] = useState("");
  return (
    <Box flexDirection="column">
      <Text>Enter your {providerName} API key:</Text>
      <TextInput value={value} onChange={setValue} onSubmit={onSubmit} mask="*" />
    </Box>
  );
}
