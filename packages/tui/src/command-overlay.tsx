// The picker/text-entry UI for slash commands that need more than a one-line argument: "/model"
// and "/login" with no (or a partial) argument, "/effort" with no argument, and "/resume" with no
// argument. Mirrors setup-screen.tsx's own phase-state-machine pattern (SelectList for every
// choice, one phase per step) since this is the same kind of flow, just running mid-session
// instead of before a Session exists -- PromptInput is disabled (via useInput's `isActive` option)
// for as long as this is mounted, exactly like SetupScreen owns the keyboard during onboarding.
import type { AgentMessage, ModelOption, ProviderOption } from "@nanocode/agent";
import { Box, type DOMElement, measureElement, Text, useInput } from "ink";
// biome-ignore lint/correctness/noUnusedImports: required by tsx's runtime JSX transform, not referenced directly in this file's own code
import React, { useEffect, useLayoutEffect, useRef, useState } from "react";
import { OAuthLoginFlow } from "./oauth-login.tsx";
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
    | "login-method-choice"
    | "login-provider"
    | "login-method"
    | "login-key"
    | "login-oauth"
    | "login-ambient"
    | "model-provider"
    | "model-none-configured"
    | "model-model"
    | "effort"
    | "resume-pick"
    | "resume-empty";
  message?: string;
  /** Which method "login-provider"'s own list was filtered to -- set only for that step, by
   * `loadLoginProviders` below. */
  authMethod?: "api-key" | "oauth";
  providers?: ProviderOption[];
  provider?: ProviderOption;
  models?: ModelOption[];
  sessions?: SessionSummary[];
}

/** Used ONLY by "/login &lt;exact-provider-id&gt;" (the arg-preselect path), which names a provider
 * directly and so never goes through "login-method-choice"'s own upfront ask. A provider supporting
 * BOTH interactive methods still asks which one first ("login-method"); one supporting only a
 * single method (or neither, "login-ambient") skips straight past that choice. The no-arg browse
 * path (`loadLoginProviders` below) never needs this: it asks the method FIRST, then only ever
 * lists providers that already support it -- there's nothing left to disambiguate once a provider
 * is selected from an already-filtered list. */
function loginPhaseFor(provider: ProviderOption): Phase {
  if (provider.supportsApiKeyLogin && provider.supportsOAuthLogin) {
    return { step: "login-method", provider };
  }
  if (provider.supportsOAuthLogin) return { step: "login-oauth", provider };
  if (provider.supportsApiKeyLogin) return { step: "login-key", provider };
  return { step: "login-ambient", provider };
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
  onHeightChange,
}: {
  kind: CommandOverlayKind;
  /** The first word after "/login"/"/model"/"/effort", if any -- e.g. "/login anthropic"
   * pre-selects the provider and skips straight to the key-entry step; "/effort hi" seeds the
   * effort picker's own search text with "hi" instead of starting it empty. */
  arg: string | undefined;
  controller: SlashCommandController;
  onDone: (result: OverlayResult) => void;
  onCancel: () => void;
  /** Reports this component's own REAL rendered height (via ink's `measureElement`) every time it
   * changes -- app.tsx's `TranscriptView` uses this instead of guessing, since which `Phase` is
   * showing and how many items its `SelectList` has (and whether that list is scrolled, adding its
   * own "N more above/below" rows) both swing the real height anywhere from one line to over a
   * dozen. See this component's own `overlayRef`/`useLayoutEffect` below for how it's measured. */
  onHeightChange?: (height: number) => void;
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

  // Measures the actual rendered content (see the wrapping `<Box ref={overlayRef}>` at the very
  // bottom of this component) and reports it upward via `onHeightChange` -- `useLayoutEffect`
  // rather than `useEffect` so the correction lands in the SAME commit as whatever phase/list
  // change caused it, before anything is actually written to the terminal, matching ink's own
  // `measureElement` doc note that it only returns real numbers from post-render code. No
  // dependency array: re-measures after every render, since content can change here in ways this
  // component doesn't otherwise track as a single dependency (a `SelectList`'s own scroll-window
  // shifting its "N more above/below" rows without any prop of THIS component changing).
  const overlayRef = useRef<DOMElement>(null);
  useLayoutEffect(() => {
    if (!overlayRef.current) return;
    const { height } = measureElement(overlayRef.current);
    if (height > 0) onHeightChange?.(height);
  });

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
      // "/login" with no arg asks which method first (see loadLoginProviders below) rather than
      // fetching providers eagerly -- the method choice needs no provider data at all. "/login
      // <exact-id>" already knows which provider it wants, so it still fetches immediately to
      // resolve `arg` and decide (via loginPhaseFor) whether that ONE provider even needs asking.
      if (kind === "login" && !arg) {
        setPhase({ step: "login-method-choice" });
        return;
      }
      if (kind === "login") {
        const providers = await controller.listProviders();
        if (cancelled) return;
        const preselected = providers.find((p) => p.id === arg);
        if (!preselected) {
          setPhase({ step: "error", message: `Unknown provider "${arg}".` });
          return;
        }
        setPhase(loginPhaseFor(preselected));
        return;
      }

      // kind === "model" -- like pi's own, only ever offers to switch AMONG providers already
      // configured (a real credential, or ambient ones like Bedrock/Vertex that resolve one
      // automatically): adding a NEW provider is "/login"'s job, not "/model"'s. Filtering here
      // means the picker only ever shows choices that will actually work, instead of listing
      // everything and then erroring after the fact.
      const providers = await controller.listProviders();
      if (cancelled) return;
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

  // "/login"'s own no-arg browse path: called once the user picks a method on "login-method-choice"
  // -- mirrors setup-screen.tsx's own `loadProviders`. Filters to providers that actually support
  // the CHOSEN method (`supportsApiKeyLogin`/`supportsOAuthLogin`), never `hasApiKeyAuth` alone --
  // an ambient-only provider (Bedrock/Vertex: apiKey auth present, but nothing interactive to log
  // in with) has no business appearing under either "API Key" or "OAuth" here. Naming a provider
  // like that directly via "/login <its-id>" still works (loginPhaseFor's own "login-ambient"
  // branch, above) -- only browsing loses it.
  const loadLoginProviders = (authMethod: "api-key" | "oauth") => {
    setPhase({ step: "loading" });
    controller.listProviders().then(
      (providers) => {
        const filtered = providers.filter((provider) =>
          authMethod === "oauth" ? provider.supportsOAuthLogin : provider.supportsApiKeyLogin,
        );
        setPhase({ step: "login-provider", authMethod, providers: filtered });
      },
      (error: unknown) => setPhase({ step: "error", message: describeError(error) }),
    );
  };

  useInput((input, key) => {
    if (key.escape) {
      // "login-oauth" owns Escape itself -- OAuthLoginFlow's own useInput already aborts its
      // in-flight login AND calls this same onCancel, so handling it here too would invoke
      // onCancel twice for a single keypress (harmless with the current `atoms.overlay.set(
      // undefined)` caller, but still a real double-fire this phase should own exclusively,
      // matching the effort picker's own phase-gating below).
      if (phase.step === "login-oauth") return;
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

  // Wrapped in an IIFE (rather than converting every branch below to a `content = ...` assignment)
  // purely so the existing early-return-per-phase shape doesn't have to change at all -- its result
  // gets wrapped in the measured `<Box ref={overlayRef}>` below instead of being returned directly.
  const content = (() => {
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

    if (phase.step === "login-method-choice") {
      return (
        <Box flexDirection="column">
          <Text>Log in how?</Text>
          <SelectList
            items={[
              { id: "api-key", label: "API Key" },
              { id: "oauth", label: "OAuth", sublabel: "sign in with a provider account" },
            ]}
            onSelect={(id) => loadLoginProviders(id === "oauth" ? "oauth" : "api-key")}
          />
        </Box>
      );
    }

    if (phase.step === "login-provider") {
      const authMethod = phase.authMethod ?? "api-key";
      const providers = phase.providers ?? [];
      return (
        <Box flexDirection="column">
          <Text>
            {authMethod === "oauth" ? "Sign in with which provider?" : "Log in to which provider?"}
          </Text>
          <SelectList
            items={providers.map((p) => ({
              id: p.id,
              label: authMethod === "oauth" ? (p.oauthName ?? p.name) : p.name,
              sublabel: p.hasCredential ? "configured" : undefined,
            }))}
            onSelect={(id) => {
              const provider = providers.find((p) => p.id === id);
              if (!provider) return;
              setPhase(
                authMethod === "oauth"
                  ? { step: "login-oauth", provider }
                  : { step: "login-key", provider },
              );
            }}
          />
        </Box>
      );
    }

    if (phase.step === "login-method" && phase.provider) {
      const provider = phase.provider;
      return (
        <Box flexDirection="column">
          <Text>Log in to {provider.name} how?</Text>
          <SelectList
            items={[
              { id: "api-key", label: "API Key" },
              { id: "oauth", label: provider.oauthName ?? "OAuth" },
            ]}
            onSelect={(id) =>
              setPhase(
                id === "oauth"
                  ? { step: "login-oauth", provider }
                  : { step: "login-key", provider },
              )
            }
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

    if (phase.step === "login-oauth" && phase.provider) {
      const provider = phase.provider;
      return (
        <OAuthLoginFlow
          providerName={provider.oauthName ?? provider.name}
          startLogin={(handlers) => controller.loginOAuth(provider.id, handlers)}
          openUrl={controller.openUrl}
          onSuccess={() => onDone({ kind: "message", text: `Logged in to ${provider.name}.` })}
          onCancel={onCancel}
          onError={(message) => setPhase({ step: "error", message })}
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
  })();

  return (
    <Box ref={overlayRef} flexDirection="column">
      {content}
    </Box>
  );
}
