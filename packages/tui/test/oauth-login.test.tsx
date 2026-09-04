// <OAuthLoginFlow> (packages/tui/src/oauth-login.tsx): the shared interactive OAuth login UI used
// by both onboarding's "oauth-login" phase (setup-screen.tsx) and mid-session "/login"'s
// "login-oauth" phase (command-overlay.tsx). Driven here in isolation against a fake `startLogin`
// that hands back the real `OAuthLoginHandlers` object it was called with -- letting each test call
// `handlers.notify()`/`handlers.prompt()` directly, exactly like a real provider's OAuth
// implementation would, rather than needing a real MutableModels/pi-ai login flow. Matches
// setup-screen.test.tsx's own `wait()`/per-keystroke-stdin conventions.
import type { OAuthLoginHandlers } from "@nanocode/agent";
import { render } from "ink-testing-library";
import { describe, expect, it, vi } from "vitest";
import { OAuthLoginFlow } from "../src/oauth-login.tsx";

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Captures the real `OAuthLoginHandlers` object `<OAuthLoginFlow>` builds and hands to
 * `startLogin` -- tests drive the flow by calling `handlers.notify()`/`handlers.prompt()` on it
 * directly, and can inspect `handlers.signal` after Escape. Never resolves/rejects on its own
 * (`neverSettles: false` lets a test opt into a controllable startLogin promise instead, for the
 * onSuccess/onError tests, which need to settle it themselves). */
function captureStartLogin(): {
  startLogin: (handlers: OAuthLoginHandlers) => Promise<void>;
  handlers: () => OAuthLoginHandlers | undefined;
} {
  let captured: OAuthLoginHandlers | undefined;
  const startLogin = vi.fn((handlers: OAuthLoginHandlers) => {
    captured = handlers;
    return new Promise<void>(() => {}); // never resolves -- these tests don't exercise onSuccess/onError
  });
  return { startLogin, handlers: () => captured };
}

function renderFlow(overrides: {
  startLogin: (handlers: OAuthLoginHandlers) => Promise<void>;
  openUrl?: (url: string) => Promise<void>;
  onSuccess?: () => void;
  onCancel?: () => void;
  onError?: (message: string) => void;
}) {
  return render(
    <OAuthLoginFlow
      providerName="Anthropic (Claude Pro/Max)"
      startLogin={overrides.startLogin}
      openUrl={overrides.openUrl ?? vi.fn(async () => {})}
      onSuccess={overrides.onSuccess ?? vi.fn()}
      onCancel={overrides.onCancel ?? vi.fn()}
      onError={overrides.onError ?? vi.fn()}
    />,
  );
}

describe("OAuthLoginFlow", () => {
  it("renders 'Signing in to X…' immediately, calls startLogin exactly once, and shows nothing else until told to", async () => {
    const { startLogin, handlers } = captureStartLogin();
    const { lastFrame } = renderFlow({ startLogin });
    await wait(10);

    expect(lastFrame()).toContain("Signing in to Anthropic (Claude Pro/Max)…");
    expect(lastFrame()).toContain("esc to cancel");
    expect(startLogin).toHaveBeenCalledTimes(1);
    expect(handlers()).toBeDefined();
  });

  it("shows each real OAuthEvent shape's own formatted text via notify(), and opens the URL for an auth_url event", async () => {
    const { startLogin, handlers } = captureStartLogin();
    const openUrl = vi.fn(async () => {});
    const { lastFrame } = renderFlow({ startLogin, openUrl });
    await wait(10);

    handlers()?.notify({ type: "info", message: "starting login..." });
    await wait(10);
    expect(lastFrame()).toContain("starting login...");

    handlers()?.notify({
      type: "auth_url",
      url: "https://example.com/authorize",
      instructions: "Open this link:",
    });
    await wait(10);
    // formatOAuthEvent's real "auth_url" text (oauth-login.tsx): `${instructions} ${url}`.
    expect(lastFrame()).toContain("Open this link: https://example.com/authorize");
    expect(openUrl).toHaveBeenCalledWith("https://example.com/authorize");

    handlers()?.notify({
      type: "device_code",
      userCode: "ABCD-1234",
      verificationUri: "https://example.com/verify",
      intervalSeconds: 5,
      expiresInSeconds: 600,
    });
    await wait(10);
    // formatOAuthEvent's real "device_code" text: `Go to ${verificationUri} and enter code: ${userCode}`.
    expect(lastFrame()).toContain("Go to https://example.com/verify and enter code: ABCD-1234");

    handlers()?.notify({ type: "progress", message: "still waiting..." });
    await wait(10);
    expect(lastFrame()).toContain("still waiting...");

    // Every notify() call appends to the log rather than replacing it -- all four still visible.
    const frame = lastFrame() ?? "";
    expect(frame).toContain("starting login...");
    expect(frame).toContain("Open this link: https://example.com/authorize");
    expect(frame).toContain("Go to https://example.com/verify and enter code: ABCD-1234");
    expect(frame).toContain("still waiting...");
  });

  it("an auth_url event with no instructions falls back to the default 'Open this URL to continue:' text", async () => {
    const { startLogin, handlers } = captureStartLogin();
    const { lastFrame } = renderFlow({ startLogin });
    await wait(10);

    handlers()?.notify({ type: "auth_url", url: "https://example.com/authorize" });
    await wait(10);

    expect(lastFrame()).toContain("Open this URL to continue: https://example.com/authorize");
  });

  it("a 'text' prompt renders a TextInput and resolves the pending promise with the exact typed value", async () => {
    const { startLogin, handlers } = captureStartLogin();
    const { lastFrame, stdin } = renderFlow({ startLogin });
    await wait(10);

    let resolvedValue: string | undefined;
    handlers()
      ?.prompt({ type: "text", message: "What's your email?", placeholder: "you@example.com" })
      .then((value) => {
        resolvedValue = value;
      });
    await wait(10);
    expect(lastFrame()).toContain("What's your email?");

    for (const ch of "me@example.com") {
      stdin.write(ch);
      await wait(2);
    }
    stdin.write("\r");
    await wait(10);

    expect(resolvedValue).toBe("me@example.com");
  });

  it("a 'secret' prompt renders a masked TextInput and resolves the pending promise with the exact typed value", async () => {
    const { startLogin, handlers } = captureStartLogin();
    const { lastFrame, stdin } = renderFlow({ startLogin });
    await wait(10);

    let resolvedValue: string | undefined;
    handlers()
      ?.prompt({ type: "secret", message: "Paste your client secret" })
      .then((value) => {
        resolvedValue = value;
      });
    await wait(10);
    expect(lastFrame()).toContain("Paste your client secret");

    for (const ch of "shh-secret") {
      stdin.write(ch);
      await wait(2);
    }
    stdin.write("\r");
    await wait(10);

    expect(resolvedValue).toBe("shh-secret");
    // Masked as it's typed -- the raw secret text itself never appears in the rendered frame.
    expect(lastFrame()).not.toContain("shh-secret");
  });

  it("a 'select' prompt renders a SelectList and resolves the pending promise with the chosen option's id", async () => {
    const { startLogin, handlers } = captureStartLogin();
    const { lastFrame, stdin } = renderFlow({ startLogin });
    await wait(10);

    let resolvedValue: string | undefined;
    handlers()
      ?.prompt({
        type: "select",
        message: "Which account?",
        options: [
          { id: "work", label: "Work" },
          { id: "personal", label: "Personal", description: "personal account" },
        ],
      })
      .then((value) => {
        resolvedValue = value;
      });
    await wait(10);
    expect(lastFrame()).toContain("Which account?");
    expect(lastFrame()).toContain("Work");
    expect(lastFrame()).toContain("Personal");

    stdin.write("\x1b[B"); // down arrow -- move off "Work" onto "Personal"
    await wait(10);
    stdin.write("\r");
    await wait(10);

    expect(resolvedValue).toBe("personal");
  });

  it("a prompt's own signal firing removes its pending input UI, without settling the flow itself", async () => {
    const { startLogin, handlers } = captureStartLogin();
    const onSuccess = vi.fn();
    const onError = vi.fn();
    const { lastFrame } = renderFlow({ startLogin, onSuccess, onError });
    await wait(10);

    const promptAbort = new AbortController();
    handlers()?.prompt({
      type: "manual_code",
      message: "Paste the code shown in your browser",
      signal: promptAbort.signal,
    });
    await wait(10);
    expect(lastFrame()).toContain("Paste the code shown in your browser");

    promptAbort.abort();
    await wait(10);

    // The pending prompt's own input UI is gone -- back to the plain "esc to cancel" footer -- but
    // this only cancels THAT ONE prompt, not the whole login flow (onSuccess/onError, which only
    // startLogin's own returned promise settling can trigger, are untouched).
    expect(lastFrame()).not.toContain("Paste the code shown in your browser");
    expect(lastFrame()).toContain("esc to cancel");
    expect(onSuccess).not.toHaveBeenCalled();
    expect(onError).not.toHaveBeenCalled();
  });

  it("pressing Escape aborts the flow's own AbortSignal and calls onCancel", async () => {
    const { startLogin, handlers } = captureStartLogin();
    const onCancel = vi.fn();
    const { stdin } = renderFlow({ startLogin, onCancel });
    await wait(10);

    stdin.write("\x1b");
    // Ink treats a lone ESC byte as a possibly-incomplete escape sequence and holds it in a 20ms
    // debounce before flushing it as a standalone `key.escape` -- see command-overlay.test.tsx's own
    // identical comment on this exact wait.
    await wait(40);

    expect(onCancel).toHaveBeenCalledTimes(1);
    expect(handlers()?.signal?.aborted).toBe(true);
  });

  it("calls onSuccess once startLogin's own returned promise resolves", async () => {
    const onSuccess = vi.fn();
    let resolveLogin: () => void = () => {};
    const startLogin = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          resolveLogin = resolve;
        }),
    );
    renderFlow({ startLogin, onSuccess });
    await wait(10);

    resolveLogin();
    await wait(10);

    expect(onSuccess).toHaveBeenCalledTimes(1);
  });

  it("calls onError with the error's message when startLogin's own returned promise rejects for a real failure", async () => {
    const onError = vi.fn();
    let rejectLogin: (error: Error) => void = () => {};
    const startLogin = vi.fn(
      () =>
        new Promise<void>((_resolve, reject) => {
          rejectLogin = reject;
        }),
    );
    renderFlow({ startLogin, onError });
    await wait(10);

    rejectLogin(new Error("network unreachable"));
    await wait(10);

    expect(onError).toHaveBeenCalledWith("network unreachable");
  });
});
