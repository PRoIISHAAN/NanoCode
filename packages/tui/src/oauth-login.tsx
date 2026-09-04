// A generic, provider-agnostic interactive OAuth login flow, shared by onboarding (setup-screen.tsx)
// and mid-session "/login" (command-overlay.tsx) -- neither one needs its own copy, since nothing
// here is provider-specific: pi-ai's own `AuthInteraction` contract (see
// @nanocode/agent's model-setup.ts, which bridges it into this file's plain `OAuthEvent`/
// `OAuthPrompt` types) is deliberately the same shape for every OAuth-capable provider, whether it's
// a browser-redirect/PKCE flow (Anthropic) or a device-code flow (GitHub Copilot and others) --
// this component just shows whatever it's told to show, in order, and answers whatever it's asked.
//
// Owns exactly one `useInput` of its own, for Escape-to-cancel only -- never character input, list
// navigation, or anything a nested widget (`SelectList`, `TextInput`) already owns itself. Multiple
// independent `useInput` hooks all receive every keystroke with no consumption between them (the
// ctrl+o/ink-text-input bug class this project has hit before); that's only a real problem when two
// handlers disagree about the SAME keystroke's meaning. Escape-to-abort and a nested widget's own
// character/navigation handling never overlap, so this is safe -- the same reasoning already lets
// command-overlay.tsx's own outer Escape handler coexist with ApiKeyPrompt's nested <TextInput>.
import type { OAuthEvent, OAuthLoginHandlers, OAuthPrompt } from "@nanocode/agent";
import { Box, Text, useInput } from "ink";
import TextInput from "ink-text-input";
// biome-ignore lint/correctness/noUnusedImports: required by tsx's runtime JSX transform, not referenced directly in this file's own code
import React, { useEffect, useRef, useState } from "react";
import { SelectList } from "./select-list.tsx";

function formatOAuthEvent(event: OAuthEvent): string {
  switch (event.type) {
    case "info":
      return event.message;
    case "auth_url":
      return `${event.instructions ?? "Open this URL to continue:"} ${event.url}`;
    case "device_code":
      return `Go to ${event.verificationUri} and enter code: ${event.userCode}`;
    case "progress":
      return event.message;
  }
}

interface PendingPrompt {
  id: number;
  prompt: OAuthPrompt;
  resolve: (value: string) => void;
  reject: (error: Error) => void;
}

export function OAuthLoginFlow({
  providerName,
  startLogin,
  openUrl,
  onSuccess,
  onCancel,
  onError,
}: {
  providerName: string;
  /** Kicks off the real login exactly once, wired to whichever `handlers` this component builds --
   * e.g. `(handlers) => setup.loginOAuth(provider.id, handlers)`. */
  startLogin: (handlers: OAuthLoginHandlers) => Promise<void>;
  openUrl: (url: string) => Promise<void>;
  onSuccess: () => void;
  /** Called on Escape -- what "cancel" means is entirely up to the caller (onboarding navigates
   * back a step; "/login" just closes the overlay, which its own outer Escape handler already does
   * on its own, so it can pass a no-op here). This component never assumes either. */
  onCancel: () => void;
  onError: (message: string) => void;
}) {
  const [log, setLog] = useState<Array<{ key: number; text: string }>>([]);
  const [pending, setPending] = useState<PendingPrompt | undefined>();
  const abortControllerRef = useRef<AbortController | undefined>(undefined);
  if (!abortControllerRef.current) abortControllerRef.current = new AbortController();
  const nextIdRef = useRef(0);

  // Intentionally runs once per mount -- a fresh OAuthLoginFlow instance is mounted per login
  // attempt, `startLogin`/`openUrl`/the callback props never change under one instance.
  // biome-ignore lint/correctness/useExhaustiveDependencies: see above
  useEffect(() => {
    let cancelled = false;
    const controller = abortControllerRef.current as AbortController;

    startLogin({
      signal: controller.signal,
      notify: (event) => {
        if (cancelled) return;
        if (event.type === "auth_url") void openUrl(event.url);
        const key = nextIdRef.current++;
        setLog((current) => [...current, { key, text: formatOAuthEvent(event) }]);
      },
      prompt: (prompt) =>
        new Promise<string>((resolve, reject) => {
          if (cancelled) {
            reject(new Error("Login cancelled."));
            return;
          }
          const id = nextIdRef.current++;
          // Clears the pending prompt from the UI immediately once it's answered -- resolving the
          // raw promise (what a submitted <TextInput>/<SelectList> actually calls) has no effect
          // on React state by itself. Missing this was a real, live-caught bug: a submitted prompt
          // stayed rendered (looking like it was still waiting for input) underneath whatever the
          // flow showed next, until the WHOLE component eventually unmounted.
          const clearIfCurrent = () =>
            setPending((current) => (current?.id === id ? undefined : current));
          prompt.signal?.addEventListener("abort", clearIfCurrent, { once: true });
          setPending({
            id,
            prompt,
            resolve: (value) => {
              clearIfCurrent();
              resolve(value);
            },
            reject: (error) => {
              clearIfCurrent();
              reject(error);
            },
          });
        }),
    }).then(
      () => {
        if (!cancelled) onSuccess();
      },
      (error: unknown) => {
        if (cancelled || controller.signal.aborted) return;
        onError(error instanceof Error ? error.message : String(error));
      },
    );

    return () => {
      cancelled = true;
    };
  }, []);

  useInput((_input, key) => {
    if (!key.escape) return;
    abortControllerRef.current?.abort();
    pending?.reject(new Error("Login cancelled."));
    onCancel();
  });

  return (
    <Box flexDirection="column">
      <Text>Signing in to {providerName}…</Text>
      {log.map((line) => (
        <Text key={line.key} dimColor>
          {line.text}
        </Text>
      ))}
      {pending ? (
        <OAuthPromptView key={pending.id} prompt={pending.prompt} onSubmit={pending.resolve} />
      ) : (
        <Text dimColor>esc to cancel</Text>
      )}
    </Box>
  );
}

function OAuthPromptView({
  prompt,
  onSubmit,
}: {
  prompt: OAuthPrompt;
  onSubmit: (value: string) => void;
}) {
  const [value, setValue] = useState("");

  if (prompt.type === "select") {
    return (
      <Box flexDirection="column">
        <Text>{prompt.message}</Text>
        <SelectList
          items={prompt.options.map((option) => ({
            id: option.id,
            label: option.label,
            sublabel: option.description,
          }))}
          onSelect={onSubmit}
        />
      </Box>
    );
  }

  return (
    <Box flexDirection="column">
      <Text>{prompt.message}</Text>
      <TextInput
        value={value}
        onChange={setValue}
        onSubmit={onSubmit}
        placeholder={prompt.placeholder}
        mask={prompt.type === "secret" ? "*" : undefined}
      />
    </Box>
  );
}
