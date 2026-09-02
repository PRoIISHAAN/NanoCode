// Proactive onboarding (decisions/0011-tui-onboarding.md): shown instead of the normal running
// session whenever App mounts without a Session yet. All state here is local via plain useState --
// nothing outside this component ever needs to read it, unlike the atom-backed state in app.tsx,
// so there's no reason to route it through an atom.
import type { ModelOption, ProviderOption, Session } from "@nanocode/agent";
import { Box, Text, useInput } from "ink";
import TextInput from "ink-text-input";
// biome-ignore lint/correctness/noUnusedImports: required by tsx's runtime JSX transform, not referenced directly in this file's own code
import React, { useState } from "react";
import { SelectList } from "./select-list.tsx";

/** packages/cli/src/tui.tsx implements this, closing over the real MutableModels/resolveModel it
 * builds -- packages/tui never sees those types, only this plain interface. */
export interface ModelSetupController {
  listProviders(): Promise<ProviderOption[]>;
  listModels(providerId: string): ModelOption[];
  login(providerId: string, apiKey: string): Promise<void>;
  /** Resolves the chosen model AND builds the full session runtime (kernel, telemetry, MCP) --
   * one step, so this component only ever hands App a fully-ready Session, never a partial one. */
  finish(providerId: string, modelId: string): Promise<Session>;
}

type SetupPhase =
  | { step: "choose-auth-method" }
  | { step: "oauth-unavailable" }
  | { step: "loading" }
  | { step: "choose-provider"; providers: ProviderOption[] }
  | { step: "enter-key"; provider: ProviderOption }
  | { step: "saving-key"; provider: ProviderOption }
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
  // API key first) -- OAuth is listed but not selectable yet (ADR 0004 declined it outright for
  // nanocode, no path back to reconsidering it here). listProviders() only runs once the user
  // actually picks "API Key," not eagerly on mount.
  const [phase, setPhase] = useState<SetupPhase>({ step: "choose-auth-method" });

  const loadProviders = () => {
    setPhase({ step: "loading" });
    setup.listProviders().then(
      (providers) => setPhase({ step: "choose-provider", providers }),
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
            { id: "oauth", label: "OAuth", sublabel: "not yet available" },
          ]}
          onSelect={(id) => {
            if (id === "oauth") {
              setPhase({ step: "oauth-unavailable" });
            } else {
              loadProviders();
            }
          }}
        />
      </Box>
    );
  }

  if (phase.step === "oauth-unavailable") {
    return (
      <OAuthUnavailableNotice onAcknowledge={() => setPhase({ step: "choose-auth-method" })} />
    );
  }

  if (phase.step === "loading") {
    return <Text color="gray">Loading providers…</Text>;
  }

  if (phase.step === "error") {
    return <Text color="red">Setup failed: {phase.message}</Text>;
  }

  if (phase.step === "choose-provider") {
    return (
      <Box flexDirection="column">
        <Text>No model configured yet -- choose a provider:</Text>
        <SelectList
          items={phase.providers.map((provider) => ({
            id: provider.id,
            label: provider.name,
            sublabel: provider.hasCredential
              ? "configured"
              : provider.supportsApiKeyLogin
                ? undefined
                : "ambient credentials only",
          }))}
          onSelect={(providerId) => {
            const provider = phase.providers.find((p) => p.id === providerId);
            if (!provider) return;
            if (provider.hasCredential || !provider.supportsApiKeyLogin) {
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

function OAuthUnavailableNotice({ onAcknowledge }: { onAcknowledge: () => void }) {
  useInput(() => {
    onAcknowledge();
  });
  return (
    <Box flexDirection="column">
      <Text color="yellow">
        OAuth isn't supported yet in nanocode -- API keys only
        (decisions/0004-auth-no-stealth-mode.md).
      </Text>
      <Text dimColor>Press any key to go back and choose API Key instead.</Text>
    </Box>
  );
}

function ApiKeyPrompt({
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
