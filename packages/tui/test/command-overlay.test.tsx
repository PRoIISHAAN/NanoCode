// CommandOverlay (packages/tui/src/command-overlay.tsx): the "/model"/"/login"/"/effort"/"/resume"
// picker UI, driven against a fake SlashCommandController the same way setup-screen.test.tsx drives
// SetupScreen against a fake ModelSetupController -- that file is this one's template, including
// its `wait()`/per-keystroke-stdin conventions.
import type { AgentMessage, ModelOption, ProviderOption } from "@nanocode/agent";
import { render } from "ink-testing-library";
import { describe, expect, it, vi } from "vitest";
import { CommandOverlay, type OverlayResult } from "../src/command-overlay.tsx";
import type { SessionSummary, SlashCommandController } from "../src/slash-commands.ts";

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Every method stubbed to throw by default -- individual tests override only what they need,
 * matching setup-screen.test.tsx's own "fail loudly if an unexpected method is called" convention
 * via vi.fn() throwing implementations for methods a given test never expects to be invoked. */
function fakeController(overrides: Partial<SlashCommandController> = {}): SlashCommandController {
  const unimplemented = (name: string) => () => {
    throw new Error(`SlashCommandController.${name}() should not have been called in this test`);
  };
  return {
    listProviders: overrides.listProviders ?? (unimplemented("listProviders") as never),
    listModels: overrides.listModels ?? (unimplemented("listModels") as never),
    login: overrides.login ?? (unimplemented("login") as never),
    loginOAuth: overrides.loginOAuth ?? (unimplemented("loginOAuth") as never),
    openUrl: overrides.openUrl ?? (unimplemented("openUrl") as never),
    logout: overrides.logout ?? (unimplemented("logout") as never),
    switchModel: overrides.switchModel ?? (unimplemented("switchModel") as never),
    startNewSession: overrides.startNewSession ?? (unimplemented("startNewSession") as never),
    listRecentSessions:
      overrides.listRecentSessions ?? (unimplemented("listRecentSessions") as never),
    loadSessionMessages:
      overrides.loadSessionMessages ?? (unimplemented("loadSessionMessages") as never),
    copyToClipboard: overrides.copyToClipboard ?? (unimplemented("copyToClipboard") as never),
    exportTranscript: overrides.exportTranscript ?? (unimplemented("exportTranscript") as never),
  };
}

const ANTHROPIC: ProviderOption = {
  id: "anthropic",
  name: "Anthropic",
  hasCredential: true,
  supportsApiKeyLogin: true,
  supportsOAuthLogin: false,
};
const BEDROCK: ProviderOption = {
  id: "amazon-bedrock",
  name: "Amazon Bedrock",
  hasCredential: false,
  supportsApiKeyLogin: false,
  supportsOAuthLogin: false,
};
const UNCONFIGURED_OPENROUTER: ProviderOption = {
  id: "openrouter",
  name: "OpenRouter",
  hasCredential: false,
  supportsApiKeyLogin: true,
  supportsOAuthLogin: false,
};
/** Offers BOTH interactive methods -- loginPhaseFor's own "login-method" branch (asking which one
 * first) only ever fires for a provider shaped like this. */
const ANTHROPIC_WITH_OAUTH: ProviderOption = {
  ...ANTHROPIC,
  supportsOAuthLogin: true,
  oauthName: "Anthropic (Claude Pro/Max)",
};
/** OAuth-only, matching pi-ai's real "github-copilot"/"openai-codex" shape: no api-key path at all,
 * so loginPhaseFor skips "login-method" and goes straight to "login-oauth". */
const OAUTH_ONLY: ProviderOption = {
  id: "github-copilot",
  name: "GitHub Copilot",
  hasCredential: false,
  supportsApiKeyLogin: false,
  supportsOAuthLogin: true,
  oauthName: "GitHub Copilot",
};

describe("CommandOverlay -- kind='effort'", () => {
  const HEADING =
    "Reasoning effort for future turns (type to search, ↑↓ to pick, enter to confirm):";

  it("opens showing all THINKING_LEVELS with the top one highlighted", async () => {
    const { lastFrame } = render(
      <CommandOverlay
        kind="effort"
        arg={undefined}
        controller={fakeController()}
        onDone={() => {}}
        onCancel={() => {}}
      />,
    );
    await wait(20);

    const frame = lastFrame() ?? "";
    expect(frame).toContain(HEADING);
    for (const level of ["off", "minimal", "low", "medium", "high", "xhigh", "max"]) {
      expect(frame).toContain(level);
    }
    expect(frame).toContain("→ off");
  });

  it("arrow-key navigation with no typing still picks the second item on down+enter", async () => {
    const onDone = vi.fn();
    const { stdin } = render(
      <CommandOverlay
        kind="effort"
        arg={undefined}
        controller={fakeController()}
        onDone={onDone}
        onCancel={() => {}}
      />,
    );
    await wait(20);

    stdin.write("\x1b[B"); // down arrow -- move onto "minimal"
    await wait(10);
    stdin.write("\r");
    await wait(10);

    expect(onDone).toHaveBeenCalledWith({ kind: "effort", level: "minimal" });
  });

  it("typing narrows the list by prefix match, and enter applies the highlighted match", async () => {
    const onDone = vi.fn();
    const { lastFrame, stdin } = render(
      <CommandOverlay
        kind="effort"
        arg={undefined}
        controller={fakeController()}
        onDone={onDone}
        onCancel={() => {}}
      />,
    );
    await wait(20);

    stdin.write("h");
    await wait(10);
    stdin.write("i");
    await wait(10);

    const frame = lastFrame() ?? "";
    expect(frame).toContain("high");
    for (const level of ["off", "minimal", "low", "medium", "xhigh", "max"]) {
      expect(frame).not.toContain(level);
    }

    stdin.write("\r");
    await wait(10);

    expect(onDone).toHaveBeenCalledWith({ kind: "effort", level: "high" });
  });

  it("typing something matching nothing shows the no-match message and enter is a no-op", async () => {
    const onDone = vi.fn();
    const { lastFrame, stdin } = render(
      <CommandOverlay
        kind="effort"
        arg={undefined}
        controller={fakeController()}
        onDone={onDone}
        onCancel={() => {}}
      />,
    );
    await wait(20);

    stdin.write("z");
    await wait(10);
    stdin.write("z");
    await wait(10);

    const frame = lastFrame() ?? "";
    expect(frame).toContain("No matching level -- backspace to try again, or esc to cancel.");

    stdin.write("\r");
    await wait(10);

    expect(onDone).not.toHaveBeenCalled();
  });

  it("seeds the initial filter from the arg prop", async () => {
    const { lastFrame } = render(
      <CommandOverlay
        kind="effort"
        arg="lo"
        controller={fakeController()}
        onDone={() => {}}
        onCancel={() => {}}
      />,
    );
    await wait(20);

    const frame = lastFrame() ?? "";
    expect(frame).toContain("low");
    for (const level of ["off", "minimal", "medium", "high", "xhigh", "max"]) {
      expect(frame).not.toContain(level);
    }
  });
});

describe("CommandOverlay -- kind='login', no arg", () => {
  // "/login" with no arg now asks "Log in how?" FIRST, before ever fetching providers -- a
  // two-step flow mirroring setup-screen.tsx's own onboarding shape (see loadLoginProviders' own
  // header comment in command-overlay.tsx). These two tests replace an earlier single-list version
  // of this describe block that assumed the old flat-list behavior.

  it('shows "Log in how?" before fetching any providers, then API Key leads to the (filtered) provider list, then key entry, then login() + onDone', async () => {
    const login = vi.fn(async () => {});
    const onDone = vi.fn();
    const listProviders = vi.fn(async () => [ANTHROPIC]);
    const { lastFrame, stdin } = render(
      <CommandOverlay
        kind="login"
        arg={undefined}
        controller={fakeController({ listProviders, login })}
        onDone={onDone}
        onCancel={() => {}}
      />,
    );
    await wait(20);

    expect(lastFrame()).toContain("Log in how?");
    expect(lastFrame()).toContain("API Key");
    expect(lastFrame()).toContain("OAuth");
    expect(listProviders).not.toHaveBeenCalled();

    stdin.write("\r"); // "API Key" is already highlighted first
    await wait(20);

    expect(lastFrame()).toContain("Log in to which provider?");
    expect(lastFrame()).toContain("Anthropic");

    stdin.write("\r"); // select the only (already-highlighted) provider
    await wait(10);
    expect(lastFrame()).toContain("Enter your Anthropic API key");

    for (const ch of "sk-test-key") {
      stdin.write(ch);
      await wait(2);
    }
    stdin.write("\r");
    await wait(10);

    expect(login).toHaveBeenCalledWith("anthropic", "sk-test-key");
    expect(onDone).toHaveBeenCalledWith({ kind: "message", text: "Logged in to Anthropic." });
  });

  it('choosing "OAuth" leads to a provider list labeled by oauthName, then OAuthLoginFlow renders and loginOAuth() is called', async () => {
    const loginOAuth = vi.fn(() => new Promise<void>(() => {})); // never resolves -- only the
    // phase transition/render is asserted here, not a full round-trip (oauth-login.test.tsx covers
    // OAuthLoginFlow's own behavior in isolation).
    const { lastFrame, stdin } = render(
      <CommandOverlay
        kind="login"
        arg={undefined}
        controller={fakeController({
          listProviders: async () => [ANTHROPIC_WITH_OAUTH],
          loginOAuth,
          openUrl: vi.fn(async () => {}),
        })}
        onDone={() => {}}
        onCancel={() => {}}
      />,
    );
    await wait(20);

    stdin.write("\x1b[B"); // move off "API Key" onto "OAuth"
    await wait(10);
    stdin.write("\r"); // select OAuth
    await wait(20);

    expect(lastFrame()).toContain("Sign in with which provider?");
    // Labeled with the OAuth method's own name, matching setup-screen.tsx's own convention.
    expect(lastFrame()).toContain("Anthropic (Claude Pro/Max)");

    stdin.write("\r"); // select the only (already-highlighted) provider
    await wait(10);

    expect(lastFrame()).toContain("Signing in to Anthropic (Claude Pro/Max)…");
    expect(loginOAuth).toHaveBeenCalledWith(
      "anthropic",
      expect.objectContaining({ notify: expect.any(Function), prompt: expect.any(Function) }),
    );
  });

  it("an ambient-only provider (no login support of either kind) is absent from both the API Key and the OAuth browse lists", async () => {
    // Replaces a since-invalidated test ("selecting a provider that does NOT support API-key login
    // shows the ambient-credentials message instead of key entry"): its premise is now false for the
    // no-arg BROWSE path -- BEDROCK is filtered out before it ever reaches either list (see
    // loadLoginProviders' own header comment). The original ambient-dead-end assertion still holds,
    // just moved to the WITH-ARG describe block below, since naming a provider directly still routes
    // through loginPhaseFor's own "login-ambient" branch.
    const listProviders = vi.fn(async () => [ANTHROPIC, BEDROCK]);

    const apiKeyRender = render(
      <CommandOverlay
        kind="login"
        arg={undefined}
        controller={fakeController({ listProviders })}
        onDone={() => {}}
        onCancel={() => {}}
      />,
    );
    await wait(20);
    apiKeyRender.stdin.write("\r"); // "API Key"
    await wait(20);
    expect(apiKeyRender.lastFrame()).toContain("Anthropic");
    expect(apiKeyRender.lastFrame()).not.toContain("Amazon Bedrock");

    const oauthRender = render(
      <CommandOverlay
        kind="login"
        arg={undefined}
        controller={fakeController({ listProviders: async () => [ANTHROPIC_WITH_OAUTH, BEDROCK] })}
        onDone={() => {}}
        onCancel={() => {}}
      />,
    );
    await wait(20);
    oauthRender.stdin.write("\x1b[B"); // move onto "OAuth"
    await wait(10);
    oauthRender.stdin.write("\r");
    await wait(20);
    expect(oauthRender.lastFrame()).toContain("Anthropic (Claude Pro/Max)");
    expect(oauthRender.lastFrame()).not.toContain("Amazon Bedrock");
  });
});

describe("CommandOverlay -- kind='login', with arg", () => {
  it("a KNOWN provider id skips the provider picker and goes straight to key entry", async () => {
    const { lastFrame } = render(
      <CommandOverlay
        kind="login"
        arg="anthropic"
        controller={fakeController({ listProviders: async () => [ANTHROPIC] })}
        onDone={() => {}}
        onCancel={() => {}}
      />,
    );
    await wait(20);

    const frame = lastFrame() ?? "";
    expect(frame).not.toContain("Log in to which provider?");
    expect(frame).toContain("Enter your Anthropic API key");
  });

  it("a KNOWN provider id with no API-key login skips straight to the ambient-credentials message", async () => {
    const { lastFrame } = render(
      <CommandOverlay
        kind="login"
        arg="amazon-bedrock"
        controller={fakeController({ listProviders: async () => [BEDROCK] })}
        onDone={() => {}}
        onCancel={() => {}}
      />,
    );
    await wait(20);

    const frame = lastFrame() ?? "";
    expect(frame).not.toContain("Log in to which provider?");
    expect(frame).toContain("ambient credentials");
  });

  it("an UNKNOWN provider id shows an error phase", async () => {
    const { lastFrame } = render(
      <CommandOverlay
        kind="login"
        arg="not-a-real-provider"
        controller={fakeController({ listProviders: async () => [ANTHROPIC] })}
        onDone={() => {}}
        onCancel={() => {}}
      />,
    );
    await wait(20);

    expect(lastFrame()).toContain('Unknown provider "not-a-real-provider".');
  });
});

describe("CommandOverlay -- kind='login', OAuth (loginPhaseFor)", () => {
  it("a provider supporting BOTH methods asks which one first, then API Key leads to the same key-entry step as before", async () => {
    const login = vi.fn(async () => {});
    const onDone = vi.fn();
    const { lastFrame, stdin } = render(
      <CommandOverlay
        kind="login"
        arg="anthropic"
        controller={fakeController({ listProviders: async () => [ANTHROPIC_WITH_OAUTH], login })}
        onDone={onDone}
        onCancel={() => {}}
      />,
    );
    await wait(20);

    expect(lastFrame()).toContain("Log in to Anthropic how?");
    expect(lastFrame()).toContain("API Key");
    // The OAuth option is labeled with the provider's own oauthName, not a generic "OAuth".
    expect(lastFrame()).toContain("Anthropic (Claude Pro/Max)");

    stdin.write("\r"); // "API Key" is already highlighted first
    await wait(10);
    expect(lastFrame()).toContain("Enter your Anthropic API key");

    for (const ch of "sk-test-key") {
      stdin.write(ch);
      await wait(2);
    }
    stdin.write("\r");
    await wait(10);

    expect(login).toHaveBeenCalledWith("anthropic", "sk-test-key");
    expect(onDone).toHaveBeenCalledWith({ kind: "message", text: "Logged in to Anthropic." });
  });

  it("a provider supporting BOTH methods: choosing the OAuth option starts the real OAuth flow instead of key entry", async () => {
    const loginOAuth = vi.fn(() => new Promise<void>(() => {})); // never resolves -- only the
    // phase transition/render is asserted here, not a full round-trip (oauth-login.test.tsx covers
    // OAuthLoginFlow's own behavior in isolation).
    const { lastFrame, stdin } = render(
      <CommandOverlay
        kind="login"
        arg="anthropic"
        controller={fakeController({
          listProviders: async () => [ANTHROPIC_WITH_OAUTH],
          loginOAuth,
          openUrl: vi.fn(async () => {}),
        })}
        onDone={() => {}}
        onCancel={() => {}}
      />,
    );
    await wait(20);

    stdin.write("\x1b[B"); // move off "API Key" onto the OAuth option
    await wait(10);
    stdin.write("\r");
    await wait(10);

    // OAuthLoginFlow's own real render output (oauth-login.tsx) -- keyed off oauthName, same as
    // the method-choice label above.
    expect(lastFrame()).toContain("Signing in to Anthropic (Claude Pro/Max)…");
    expect(lastFrame()).not.toContain("Enter your Anthropic API key");
    expect(loginOAuth).toHaveBeenCalledWith(
      "anthropic",
      expect.objectContaining({ notify: expect.any(Function), prompt: expect.any(Function) }),
    );
  });

  it("an OAuth-only provider (no api-key auth at all) skips the method choice entirely and starts OAuth directly", async () => {
    const loginOAuth = vi.fn(() => new Promise<void>(() => {}));
    const { lastFrame } = render(
      <CommandOverlay
        kind="login"
        arg="github-copilot"
        controller={fakeController({
          listProviders: async () => [OAUTH_ONLY],
          loginOAuth,
          openUrl: vi.fn(async () => {}),
        })}
        onDone={() => {}}
        onCancel={() => {}}
      />,
    );
    await wait(20);

    const frame = lastFrame() ?? "";
    expect(frame).not.toContain("how?");
    expect(frame).toContain("Signing in to GitHub Copilot…");
    expect(loginOAuth).toHaveBeenCalledWith("github-copilot", expect.anything());
  });

  it("a real OAuth login succeeding calls onDone with the same 'Logged in to X.' message as an API-key login", async () => {
    let resolveLogin: () => void = () => {};
    const loginOAuth = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          resolveLogin = resolve;
        }),
    );
    const onDone = vi.fn();
    render(
      <CommandOverlay
        kind="login"
        arg="github-copilot"
        controller={fakeController({
          listProviders: async () => [OAUTH_ONLY],
          loginOAuth,
          openUrl: vi.fn(async () => {}),
        })}
        onDone={onDone}
        onCancel={() => {}}
      />,
    );
    await wait(20);

    resolveLogin();
    await wait(10);

    expect(onDone).toHaveBeenCalledWith({ kind: "message", text: "Logged in to GitHub Copilot." });
  });

  it("Escape while an OAuth login is in progress cancels via the overlay's own onCancel, not loginOAuth's promise", async () => {
    const onCancel = vi.fn();
    const { stdin } = render(
      <CommandOverlay
        kind="login"
        arg="github-copilot"
        controller={fakeController({
          listProviders: async () => [OAUTH_ONLY],
          loginOAuth: () => new Promise<void>(() => {}),
          openUrl: vi.fn(async () => {}),
        })}
        onDone={() => {}}
        onCancel={onCancel}
      />,
    );
    await wait(20);

    stdin.write("\x1b");
    // Ink treats a lone ESC byte as a possibly-incomplete escape sequence and holds it in a 20ms
    // debounce before flushing it as a standalone `key.escape`.
    await wait(40);

    expect(onCancel).toHaveBeenCalledTimes(1);
  });
});

describe("CommandOverlay -- kind='model', no arg", () => {
  const CLAUDE: ModelOption = { id: "claude-sonnet-5", name: "Claude Sonnet 5" };

  it("provider picker -> model picker -> selecting a model calls switchModel() then onDone", async () => {
    const switchModel = vi.fn(async () => {});
    const onDone = vi.fn();
    const { lastFrame, stdin } = render(
      <CommandOverlay
        kind="model"
        arg={undefined}
        controller={fakeController({
          listProviders: async () => [ANTHROPIC],
          listModels: () => [CLAUDE],
          switchModel,
        })}
        onDone={onDone}
        onCancel={() => {}}
      />,
    );
    await wait(20);

    expect(lastFrame()).toContain("Switch to which provider?");
    stdin.write("\r"); // select the only provider
    await wait(10);

    expect(lastFrame()).toContain("Choose a model for Anthropic:");
    expect(lastFrame()).toContain("Claude Sonnet 5");
    stdin.write("\r"); // select the only model
    await wait(10);

    expect(switchModel).toHaveBeenCalledWith("anthropic", "claude-sonnet-5");
    expect(onDone).toHaveBeenCalledWith({
      kind: "message",
      text: "Switched to anthropic/claude-sonnet-5.",
    });
  });

  it("only lists CONFIGURED providers in the picker -- an unconfigured one never appears as a choice", async () => {
    const { lastFrame } = render(
      <CommandOverlay
        kind="model"
        arg={undefined}
        controller={fakeController({
          listProviders: async () => [ANTHROPIC, UNCONFIGURED_OPENROUTER],
          listModels: () => [CLAUDE],
        })}
        onDone={() => {}}
        onCancel={() => {}}
      />,
    );
    await wait(20);

    const frame = lastFrame() ?? "";
    expect(frame).toContain("Anthropic");
    expect(frame).not.toContain("OpenRouter");
  });

  it("with NO configured providers at all, shows an empty-state message instead of a picker, pointing at /login", async () => {
    const switchModel = vi.fn(async () => {});
    const { lastFrame } = render(
      <CommandOverlay
        kind="model"
        arg={undefined}
        controller={fakeController({
          listProviders: async () => [UNCONFIGURED_OPENROUTER],
          switchModel,
        })}
        onDone={() => {}}
        onCancel={() => {}}
      />,
    );
    await wait(20);

    const frame = lastFrame() ?? "";
    expect(frame).toContain("No providers configured yet");
    expect(frame).toContain("/login");
    expect(frame).not.toContain("Switch to which provider?");
    expect(switchModel).not.toHaveBeenCalled();
  });

  it("an explicit '/model <unconfigured provider>' argument shows an error telling the user to /login first, without calling switchModel", async () => {
    const switchModel = vi.fn(async () => {});
    const { lastFrame } = render(
      <CommandOverlay
        kind="model"
        arg="openrouter"
        controller={fakeController({
          listProviders: async () => [UNCONFIGURED_OPENROUTER],
          switchModel,
        })}
        onDone={() => {}}
        onCancel={() => {}}
      />,
    );
    await wait(20);

    const frame = lastFrame() ?? "";
    expect(frame).toContain("isn't configured yet");
    expect(frame).toContain("/login openrouter");
    expect(switchModel).not.toHaveBeenCalled();
  });
});

describe("CommandOverlay -- kind='resume'", () => {
  const SESSION_A: SessionSummary = {
    id: "a",
    title: "fix the login bug",
    messageCount: 4,
    updatedAt: 2,
  };
  const SESSION_B: SessionSummary = {
    id: "b",
    title: "add dark mode",
    messageCount: 12,
    updatedAt: 1,
  };
  const MESSAGES: AgentMessage[] = [{ role: "user", content: "hi", timestamp: 1 } as AgentMessage];

  it("shows a picker with titles/message counts; selecting one calls loadSessionMessages() then onDone", async () => {
    const loadSessionMessages = vi.fn(async () => MESSAGES);
    const onDone = vi.fn();
    const { lastFrame, stdin } = render(
      <CommandOverlay
        kind="resume"
        arg={undefined}
        controller={fakeController({
          listRecentSessions: async () => [SESSION_A, SESSION_B],
          loadSessionMessages,
        })}
        onDone={onDone}
        onCancel={() => {}}
      />,
    );
    await wait(20);

    const frame = lastFrame() ?? "";
    expect(frame).toContain("fix the login bug");
    expect(frame).toContain("4 messages");
    expect(frame).toContain("add dark mode");
    expect(frame).toContain("12 messages");

    stdin.write("\r"); // select the first (already-highlighted) session
    await wait(10);

    expect(loadSessionMessages).toHaveBeenCalledWith("a");
    expect(onDone).toHaveBeenCalledWith({ kind: "resume", messages: MESSAGES, summary: SESSION_A });
  });

  it("shows a 'no past sessions' message instead of a picker when there are none", async () => {
    const { lastFrame } = render(
      <CommandOverlay
        kind="resume"
        arg={undefined}
        controller={fakeController({ listRecentSessions: async () => [] })}
        onDone={() => {}}
        onCancel={() => {}}
      />,
    );
    await wait(20);

    const frame = lastFrame() ?? "";
    expect(frame).toContain("No past sessions found.");
    expect(frame).not.toContain("Resume which session?");
  });
});

describe("CommandOverlay -- Escape", () => {
  it("calls onCancel() from the effort picker", async () => {
    const onCancel = vi.fn();
    const { stdin } = render(
      <CommandOverlay
        kind="effort"
        arg={undefined}
        controller={fakeController()}
        onDone={() => {}}
        onCancel={onCancel}
      />,
    );
    await wait(20);
    stdin.write("\x1b");
    // Ink treats a lone ESC byte as a possibly-incomplete escape sequence (it could be the start
    // of an arrow key, e.g. "\x1b[A") and holds it in a 20ms debounce
    // (`pendingInputFlushDelayMilliseconds` in ink's own App.js) before flushing it as a standalone
    // `key.escape` -- waiting less than that here would make this test flaky/always-failing.
    await wait(40);
    expect(onCancel).toHaveBeenCalled();
  });

  it("calls onCancel() while still on a loaded provider picker", async () => {
    const onCancel = vi.fn();
    const { lastFrame, stdin } = render(
      <CommandOverlay
        kind="model"
        arg={undefined}
        controller={fakeController({
          listProviders: async () => [ANTHROPIC],
          listModels: () => [],
        })}
        onDone={() => {}}
        onCancel={onCancel}
      />,
    );
    await wait(20);
    expect(lastFrame()).toContain("Switch to which provider?");

    stdin.write("\x1b");
    await wait(40); // see the ESC-debounce comment in the test above
    expect(onCancel).toHaveBeenCalled();
  });
});

// Sanity: OverlayResult's "message" variant is what login/model success paths above actually
// exercise -- this just pins the type stays importable/usable from a consuming test file.
const _typeCheck: OverlayResult = { kind: "message", text: "ok" };
void _typeCheck;
