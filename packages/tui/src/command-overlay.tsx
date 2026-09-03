// The picker/text-entry UI for slash commands that need more than a one-line argument: "/model"
// and "/login" with no (or a partial) argument, "/effort" with no argument, and "/resume" with no
// argument. Mirrors setup-screen.tsx's own phase-state-machine pattern (SelectList for every
// choice, one phase per step) since this is the same kind of flow, just running mid-session
// instead of before a Session exists -- PromptInput is disabled (via useInput's `isActive` option)
// for as long as this is mounted, exactly like SetupScreen owns the keyboard during onboarding.
import type { AgentMessage, ModelOption, ProviderOption } from "@nanocode/agent";
import { Box, Text, useInput } from "ink";
// biome-ignore lint/correctness/noUnusedImports: required by tsx's runtime JSX transform, not referenced directly in this file's own code
import React, { useEffect, useState } from "react";
import { SelectList } from "./select-list.tsx";
import { ApiKeyPrompt } from "./setup-screen.tsx";
import {
  type SessionSummary,
  type SlashCommandController,
  THINKING_LEVELS,
} from "./slash-commands.ts";

export type CommandOverlayKind = "login" | "model" | "effort" | "resume";

export type OverlayResult =
  | { kind: "message"; text: string }
  | { kind: "effort"; level: string }
  | { kind: "resume"; messages: AgentMessage[]; summary: SessionSummary };

interface Phase {
  step:
    | "loading"
    | "error"
    | "login-provider"
    | "login-key"
    | "login-ambient"
    | "model-provider"
    | "model-none-configured"
    | "model-model"
    | "effort"
    | "resume-pick"
    | "resume-empty";
  message?: string;
  providers?: ProviderOption[];
  provider?: ProviderOption;
  models?: ModelOption[];
  sessions?: SessionSummary[];
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function CommandOverlay({
  kind,
  arg,
  controller,
  onDone,
  onCancel,
}: {
  kind: CommandOverlayKind;
  /** The first word after "/login"/"/model"/"/effort", if any -- e.g. "/login anthropic"
   * pre-selects the provider and skips straight to the key-entry step; "/effort hi" seeds the
   * effort picker's own search text with "hi" instead of starting it empty. */
  arg: string | undefined;
  controller: SlashCommandController;
  onDone: (result: OverlayResult) => void;
  onCancel: () => void;
}) {
  const [phase, setPhase] = useState<Phase>({ step: "loading" });
  // Effort-picker-only state: what's been typed to search THINKING_LEVELS, and which of the
  // currently-filtered matches is highlighted. `arg` seeds this two different ways depending on
  // what it actually is: a real, COMPLETE level (shift+tab passes the session's current level)
  // means "show every option, just start with this one highlighted" -- filtering down to a single
  // entry would hide the very alternatives the user opened the menu to browse. Anything else (an
  // invalid/partial typed value, from "/effort hi") means "start the search already narrowed to
  // what was typed" instead. Harmless to keep around outside the "effort" phase -- nothing reads
  // it unless `phase.step === "effort"`.
  const seededLevelIndex = arg
    ? THINKING_LEVELS.indexOf(arg as (typeof THINKING_LEVELS)[number])
    : -1;
  const [effortFilter, setEffortFilter] = useState(seededLevelIndex === -1 ? (arg ?? "") : "");
  const [effortHighlight, setEffortHighlight] = useState(Math.max(seededLevelIndex, 0));
  const effortMatches = THINKING_LEVELS.filter((level) =>
    level.startsWith(effortFilter.toLowerCase()),
  );
  const safeEffortHighlight = Math.min(
    Math.max(effortHighlight, 0),
    Math.max(effortMatches.length - 1, 0),
  );

  // Intentionally runs once per mount (a fresh CommandOverlay is mounted per "/command"
  // invocation, see app.tsx) -- `kind`/`arg`/`controller` never change under one instance.
  // biome-ignore lint/correctness/useExhaustiveDependencies: see above
  useEffect(() => {
    let cancelled = false;
    (async () => {
      if (kind === "effort") {
        setPhase({ step: "effort" });
        return;
      }
      if (kind === "resume") {
        const sessions = await controller.listRecentSessions();
        if (cancelled) return;
        setPhase(
          sessions.length === 0 ? { step: "resume-empty" } : { step: "resume-pick", sessions },
        );
        return;
      }
      // "login" and "model" both start from the provider list, but "/model" -- like pi's own --
      // only ever offers to switch AMONG providers already configured (a real credential, or
      // ambient ones like Bedrock/Vertex that resolve one automatically): adding a NEW provider is
      // "/login"'s job, not "/model"'s. Filtering here means the picker only ever shows choices
      // that will actually work, instead of listing everything and then erroring after the fact.
      const providers = await controller.listProviders();
      if (cancelled) return;

      if (kind === "login") {
        const preselected = arg ? providers.find((p) => p.id === arg) : undefined;
        if (arg && !preselected) {
          setPhase({ step: "error", message: `Unknown provider "${arg}".` });
          return;
        }
        if (preselected) {
          setPhase(
            preselected.supportsApiKeyLogin
              ? { step: "login-key", provider: preselected }
              : { step: "login-ambient", provider: preselected },
          );
        } else {
          setPhase({ step: "login-provider", providers });
        }
        return;
      }

      // kind === "model"
      const configured = providers.filter((p) => p.hasCredential);
      const preselected = arg ? configured.find((p) => p.id === arg) : undefined;
      if (arg && !preselected) {
        const exists = providers.some((p) => p.id === arg);
        setPhase({
          step: "error",
          message: exists
            ? `"${arg}" isn't configured yet -- run /login ${arg} first.`
            : `Unknown provider "${arg}".`,
        });
        return;
      }
      if (preselected) {
        setPhase({
          step: "model-model",
          provider: preselected,
          models: controller.listModels(preselected.id),
        });
      } else if (configured.length === 0) {
        setPhase({ step: "model-none-configured" });
      } else {
        setPhase({ step: "model-provider", providers: configured });
      }
    })().catch((error: unknown) => {
      if (!cancelled) setPhase({ step: "error", message: describeError(error) });
    });
    return () => {
      cancelled = true;
    };
  }, []);

  useInput((input, key) => {
    if (key.escape) {
      onCancel();
      return;
    }
    // The effort picker owns its own keystrokes here rather than rendering a plain <SelectList>
    // (which owns its own up/down/enter via its own useInput) -- typing-to-search needs raw
    // character input, and two independent useInput hooks both reacting to keystrokes in the same
    // mounted tree is exactly the bug class decisions/0012 already found and fixed once (ctrl+o vs
    // ink-text-input). Gated on the current phase so every OTHER step's own <SelectList> keeps
    // working exactly as before -- this only ever fires for "effort".
    if (phase.step !== "effort") return;
    if (key.ctrl || key.meta || key.tab) return; // never insert a modifier-combo's char as a filter
    if (key.upArrow) {
      setEffortHighlight((current) => Math.max(0, current - 1));
      return;
    }
    if (key.downArrow) {
      setEffortHighlight((current) => Math.min(effortMatches.length - 1, current + 1));
      return;
    }
    if (key.return) {
      // Only a currently-highlighted MATCH can ever be chosen -- if nothing matches what's been
      // typed, this is a no-op (the menu stays open) rather than applying an invalid value or
      // guessing at one; the caller's own current thinkingLevel is untouched either way, so "the
      // previous value stays" simply falls out of never calling onDone at all here.
      const chosen = effortMatches[safeEffortHighlight];
      if (chosen) onDone({ kind: "effort", level: chosen });
      return;
    }
    if (key.backspace || key.delete) {
      setEffortFilter((current) => current.slice(0, -1));
      setEffortHighlight(0);
      return;
    }
    if (key.leftArrow || key.rightArrow || key.pageUp || key.pageDown || key.home || key.end) {
      return; // no cursor navigation in the search text yet -- just don't insert these as filter chars
    }
    if (input) {
      setEffortFilter((current) => current + input.toLowerCase());
      setEffortHighlight(0);
    }
  });

  if (phase.step === "loading") return <Text color="gray">Loading…</Text>;
  if (phase.step === "error") return <Text color="red">{phase.message}</Text>;
  if (phase.step === "resume-empty") return <Text color="gray">No past sessions found.</Text>;
  if (phase.step === "model-none-configured") {
    return <Text color="gray">No providers configured yet -- run /login to add one first.</Text>;
  }

  if (phase.step === "login-ambient") {
    return (
      <Text color="yellow">
        "{phase.provider?.name}" uses ambient credentials (env var / cloud profile), not an
        interactive API key -- nothing to log in with here.
      </Text>
    );
  }

  if (phase.step === "login-provider") {
    return (
      <Box flexDirection="column">
        <Text>Log in to which provider?</Text>
        <SelectList
          items={(phase.providers ?? []).map((p) => ({
            id: p.id,
            label: p.name,
            sublabel: p.hasCredential ? "configured" : undefined,
          }))}
          onSelect={(id) => {
            const provider = (phase.providers ?? []).find((p) => p.id === id);
            if (!provider) return;
            setPhase(
              provider.supportsApiKeyLogin
                ? { step: "login-key", provider }
                : { step: "login-ambient", provider },
            );
          }}
        />
      </Box>
    );
  }

  if (phase.step === "login-key" && phase.provider) {
    const provider = phase.provider;
    return (
      <ApiKeyPrompt
        providerName={provider.name}
        onSubmit={async (apiKey) => {
          setPhase({ step: "loading" });
          try {
            await controller.login(provider.id, apiKey);
            onDone({ kind: "message", text: `Logged in to ${provider.name}.` });
          } catch (error) {
            setPhase({ step: "error", message: describeError(error) });
          }
        }}
      />
    );
  }

  if (phase.step === "model-provider") {
    // Already filtered to configured providers only (see the effect above) -- every entry here is
    // guaranteed selectable, unlike "/login"'s picker which lists everything.
    return (
      <Box flexDirection="column">
        <Text>Switch to which provider?</Text>
        <SelectList
          items={(phase.providers ?? []).map((p) => ({ id: p.id, label: p.name }))}
          onSelect={(id) => {
            const provider = (phase.providers ?? []).find((p) => p.id === id);
            if (!provider) return;
            setPhase({
              step: "model-model",
              provider,
              models: controller.listModels(provider.id),
            });
          }}
        />
      </Box>
    );
  }

  if (phase.step === "model-model" && phase.provider) {
    const provider = phase.provider;
    const models = phase.models ?? [];
    if (models.length === 0) {
      return <Text color="red">Provider "{provider.id}" has no available models.</Text>;
    }
    return (
      <Box flexDirection="column">
        <Text>Choose a model for {provider.name}:</Text>
        <SelectList
          items={models.map((m) => ({ id: m.id, label: m.name }))}
          onSelect={async (modelId) => {
            setPhase({ step: "loading" });
            try {
              await controller.switchModel(provider.id, modelId);
              onDone({ kind: "message", text: `Switched to ${provider.id}/${modelId}.` });
            } catch (error) {
              setPhase({ step: "error", message: describeError(error) });
            }
          }}
        />
      </Box>
    );
  }

  if (phase.step === "effort") {
    return (
      <Box flexDirection="column">
        <Text>
          Reasoning effort for future turns (type to search, ↑↓ to pick, enter to confirm):
        </Text>
        <Text>
          {"> "}
          {effortFilter.length > 0 ? effortFilter : <Text dimColor>(all levels)</Text>}
        </Text>
        {effortMatches.length === 0 ? (
          <Text color="red">No matching level -- backspace to try again, or esc to cancel.</Text>
        ) : (
          effortMatches.map((level, index) => (
            <Text key={level} color={index === safeEffortHighlight ? "green" : undefined}>
              {index === safeEffortHighlight ? "→ " : "  "}
              {level}
            </Text>
          ))
        )}
      </Box>
    );
  }

  if (phase.step === "resume-pick") {
    const sessions = phase.sessions ?? [];
    return (
      <Box flexDirection="column">
        <Text>Resume which session? (only its messages come back -- kernel state doesn't)</Text>
        <SelectList
          items={sessions.map((s) => ({
            id: s.id,
            label: s.title,
            sublabel: `${s.messageCount} messages`,
          }))}
          onSelect={async (id) => {
            const summary = sessions.find((s) => s.id === id);
            if (!summary) return;
            setPhase({ step: "loading" });
            try {
              const messages = await controller.loadSessionMessages(id);
              onDone({ kind: "resume", messages, summary });
            } catch (error) {
              setPhase({ step: "error", message: describeError(error) });
            }
          }}
        />
      </Box>
    );
  }

  return null;
}
