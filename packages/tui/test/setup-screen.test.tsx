// Onboarding (decisions/0011-tui-onboarding.md): drives SetupScreen against a fake
// ModelSetupController (no real MutableModels/kernel involved -- that bridge is tested for real in
// packages/agent/test/model-setup.test.ts and packages/ai/test/credential-store.test.ts) to prove
// the UI's own state machine -- auth-method choice, provider choice, conditional key entry, model
// choice, onReady -- wires together correctly.
import type { ProviderOption, Session } from "@nanocode/agent";
import { render } from "ink-testing-library";
import { describe, expect, it, vi } from "vitest";
import { type ModelSetupController, SetupScreen } from "../src/setup-screen.tsx";

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const FAKE_SESSION = {} as Session; // opaque to SetupScreen -- it only ever passes this through.

/** Every real flow starts on the auth-method choice; this drives past it by selecting the
 * already-highlighted "API Key" option (index 0), matching what every test below needs to do
 * before it can reach the provider/model flow it's actually testing. */
async function chooseApiKeyAuth(stdin: { write: (data: string) => void }): Promise<void> {
  await wait(30);
  stdin.write("\r");
  await wait(30);
}

describe("SetupScreen", () => {
  it("starts on the auth-method choice, describing OAuth as signing in with a provider account", async () => {
    const controller: ModelSetupController = {
      listProviders: vi.fn(),
      listModels: () => [],
      login: vi.fn(),
      loginOAuth: vi.fn(),
      openUrl: vi.fn(),
      finish: vi.fn(),
    };
    const { lastFrame } = render(<SetupScreen setup={controller} onReady={() => {}} />);
    await wait(30);

    expect(lastFrame()).toContain("How would you like to authenticate?");
    expect(lastFrame()).toContain("API Key");
    // OAuth is a real, selectable option now -- no more "not yet available" dead end -- described
    // by its own sublabel (setup-screen.tsx's own choose-auth-method SelectList items).
    expect(lastFrame()).toContain("OAuth");
    expect(lastFrame()).toContain("sign in with a provider account");
    // listProviders() must not run until the user actually picks an auth method.
    expect(controller.listProviders).not.toHaveBeenCalled();
  });

  it("selecting OAuth shows a provider picker filtered to OAuth-capable providers only", async () => {
    const oauthProvider: ProviderOption = {
      id: "anthropic",
      name: "Anthropic",
      hasCredential: false,
      supportsApiKeyLogin: true,
      supportsOAuthLogin: true,
      oauthName: "Anthropic (Claude Pro/Max)",
    };
    const apiKeyOnlyProvider: ProviderOption = {
      id: "amazon-bedrock",
      name: "Amazon Bedrock",
      hasCredential: false,
      supportsApiKeyLogin: false,
      supportsOAuthLogin: false,
    };
    const controller: ModelSetupController = {
      listProviders: async () => [oauthProvider, apiKeyOnlyProvider],
      listModels: () => [],
      login: vi.fn(),
      loginOAuth: vi.fn(),
      openUrl: vi.fn(),
      finish: vi.fn(),
    };
    const { lastFrame, stdin } = render(<SetupScreen setup={controller} onReady={() => {}} />);
    await wait(30);

    stdin.write("\x1b[B"); // down arrow -- move off "API Key" onto "OAuth"
    await wait(30);
    stdin.write("\r"); // select OAuth
    await wait(30);

    expect(lastFrame()).toContain("Sign in with which provider?");
    // OAuth's own picker shows the OAuth method's own name (oauthName), not the provider's plain
    // name (setup-screen.tsx's own choose-provider label logic).
    expect(lastFrame()).toContain("Anthropic (Claude Pro/Max)");
    // Only OAuth-capable providers appear -- amazon-bedrock has no OAuth login at all.
    expect(lastFrame()).not.toContain("Amazon Bedrock");
  });

  it("selecting a provider from the OAuth picker reaches the oauth-login phase and starts the real login flow", async () => {
    const oauthProvider: ProviderOption = {
      id: "anthropic",
      name: "Anthropic",
      hasCredential: false,
      supportsApiKeyLogin: true,
      supportsOAuthLogin: true,
      oauthName: "Anthropic (Claude Pro/Max)",
    };
    const loginOAuth = vi.fn(() => new Promise<void>(() => {})); // never resolves -- only the
    // initial phase transition/render is asserted here, not a full login round-trip (see
    // oauth-login.test.tsx for OAuthLoginFlow's own full behavior).
    const controller: ModelSetupController = {
      listProviders: async () => [oauthProvider],
      listModels: () => [],
      login: vi.fn(),
      loginOAuth,
      openUrl: vi.fn(async () => {}),
      finish: vi.fn(),
    };
    const { lastFrame, stdin } = render(<SetupScreen setup={controller} onReady={() => {}} />);
    await wait(30);

    stdin.write("\x1b[B"); // move onto "OAuth"
    await wait(30);
    stdin.write("\r"); // select OAuth auth method
    await wait(30);
    stdin.write("\r"); // select the (only, already-highlighted) provider
    await wait(30);

    // OAuthLoginFlow's own real render output (oauth-login.tsx) -- the OAuth method's own name,
    // not the provider's plain name.
    expect(lastFrame()).toContain("Signing in to Anthropic (Claude Pro/Max)…");
    expect(loginOAuth).toHaveBeenCalledWith(
      "anthropic",
      expect.objectContaining({ notify: expect.any(Function), prompt: expect.any(Function) }),
    );
  });

  it("a successful OAuth login for an OAuth-only provider proceeds to choose-model", async () => {
    // An OAuth-only provider (no api-key auth at all) still reaches model choice through the OAuth
    // branch -- proves the OAuth path is a genuine, complete alternative to API-key setup, not a
    // dead end, for a provider that has no api-key path whatsoever.
    const oauthOnlyProvider: ProviderOption = {
      id: "openai-codex",
      name: "OpenAI Codex",
      hasCredential: false,
      supportsApiKeyLogin: false,
      supportsOAuthLogin: true,
      oauthName: "OpenAI (ChatGPT Plus/Pro)",
    };
    const controller: ModelSetupController = {
      listProviders: async () => [oauthOnlyProvider],
      listModels: (providerId) =>
        providerId === "openai-codex" ? [{ id: "gpt-5-codex", name: "GPT-5 Codex" }] : [],
      login: vi.fn(),
      loginOAuth: vi.fn(async () => {}),
      openUrl: vi.fn(async () => {}),
      finish: vi.fn(async () => FAKE_SESSION),
    };
    const { lastFrame, stdin } = render(<SetupScreen setup={controller} onReady={() => {}} />);
    await wait(30);

    stdin.write("\x1b[B"); // move onto "OAuth"
    await wait(30);
    stdin.write("\r"); // select OAuth auth method
    await wait(30);
    stdin.write("\r"); // select the (only, already-highlighted) provider -> starts loginOAuth()
    await wait(30);

    expect(controller.loginOAuth).toHaveBeenCalledWith("openai-codex", expect.anything());
    expect(lastFrame()).toContain("GPT-5 Codex");
  });

  it("shows a provider already configured skipping straight to model choice", async () => {
    const controller: ModelSetupController = {
      listProviders: async () => [
        {
          id: "anthropic",
          name: "Anthropic",
          hasCredential: true,
          supportsApiKeyLogin: true,
          supportsOAuthLogin: false,
        },
      ],
      listModels: () => [{ id: "claude-sonnet-5", name: "Claude Sonnet 5" }],
      login: vi.fn(),
      loginOAuth: vi.fn(),
      openUrl: vi.fn(),
      finish: vi.fn(async () => FAKE_SESSION),
    };

    const { lastFrame, stdin } = render(<SetupScreen setup={controller} onReady={() => {}} />);
    await chooseApiKeyAuth(stdin);
    expect(lastFrame()).toContain("Anthropic");
    expect(lastFrame()).toContain("configured");

    stdin.write("\r"); // select the (only, already-highlighted) provider
    // 30ms was already a bump from an earlier flake at 10ms (see this test's git history) -- still
    // intermittently too tight now that the full suite has grown substantially larger, under
    // sequential fileParallelism (vitest.config.ts): a synchronous phase transition in
    // setup-screen.tsx has no real async work to wait on, so this is purely event-loop scheduling
    // contention from everything else running, not a genuine race in the component itself.
    await wait(60);

    expect(lastFrame()).toContain("Claude Sonnet 5");
    expect(controller.login).not.toHaveBeenCalled();
  });

  it("prompts for an API key for a provider with no stored credential, then proceeds", async () => {
    const controller: ModelSetupController = {
      listProviders: async () => [
        {
          id: "anthropic",
          name: "Anthropic",
          hasCredential: false,
          supportsApiKeyLogin: true,
          supportsOAuthLogin: false,
        },
      ],
      listModels: () => [{ id: "claude-sonnet-5", name: "Claude Sonnet 5" }],
      login: vi.fn(async () => {}),
      loginOAuth: vi.fn(),
      openUrl: vi.fn(),
      finish: vi.fn(async () => FAKE_SESSION),
    };

    const { lastFrame, stdin } = render(<SetupScreen setup={controller} onReady={() => {}} />);
    await chooseApiKeyAuth(stdin);
    stdin.write("\r"); // select the only provider
    await wait(10);
    expect(lastFrame()).toContain("Enter your Anthropic API key");

    for (const ch of "sk-test-key") {
      stdin.write(ch);
      await wait(2);
    }
    stdin.write("\r");
    await wait(10);

    expect(controller.login).toHaveBeenCalledWith("anthropic", "sk-test-key");
    expect(lastFrame()).toContain("Claude Sonnet 5");
  });

  it("does not call login() twice if Enter is pressed again before the first login() resolves", async () => {
    // Regression for an L4 VERIFY finding: the API-key step previously stayed on <TextInput> for
    // its entire `await setup.login(...)`, unlike every SelectList-driven step (which unmounts on
    // selection) -- a second Enter landing in that window could fire onSubmit a second time.
    let resolveLogin: () => void = () => {};
    const loginStarted = new Promise<void>((resolve) => {
      resolveLogin = resolve;
    });
    let loginCallCount = 0;
    const controller: ModelSetupController = {
      listProviders: async () => [
        {
          id: "anthropic",
          name: "Anthropic",
          hasCredential: false,
          supportsApiKeyLogin: true,
          supportsOAuthLogin: false,
        },
      ],
      listModels: () => [{ id: "claude-sonnet-5", name: "Claude Sonnet 5" }],
      login: vi.fn(async () => {
        loginCallCount += 1;
        resolveLogin();
        await new Promise((resolve) => setTimeout(resolve, 30)); // held open past the 2nd Enter
      }),
      loginOAuth: vi.fn(),
      openUrl: vi.fn(),
      finish: vi.fn(async () => FAKE_SESSION),
    };

    const { lastFrame, stdin } = render(<SetupScreen setup={controller} onReady={() => {}} />);
    await chooseApiKeyAuth(stdin);
    stdin.write("\r"); // select the only provider
    await wait(10);
    for (const ch of "sk-test-key") {
      stdin.write(ch);
      await wait(2);
    }
    stdin.write("\r"); // submit once
    await loginStarted; // the first login() call has definitely started
    stdin.write("\r"); // a second, spurious Enter while it's still in flight
    await wait(60); // long enough for the held-open login() call to fully resolve

    expect(loginCallCount).toBe(1);
    expect(lastFrame()).toContain("Claude Sonnet 5");
  });

  it("an ambient-only provider (no login support of either kind) is absent from both the API Key and the OAuth provider lists", async () => {
    // Replaces a since-invalidated test ("skips API key entry for an ambient-only provider with no
    // login support"): that test simulated selecting an ambient-only provider FROM the choose-
    // provider list, but loadProviders' own filter (supportsApiKeyLogin/supportsOAuthLogin, see its
    // header comment) now excludes such a provider before it ever reaches either list -- there's no
    // "ambient credentials only" sublabel or onSelect branch left in the source to exercise. Onboarding
    // has no path to configure an ambient-only provider from a fresh install anymore; that's a
    // deliberate, confirmed product tradeoff, not a bug this test should work around.
    const ambientOnly: ProviderOption = {
      id: "amazon-bedrock",
      name: "Amazon Bedrock",
      hasCredential: false,
      supportsApiKeyLogin: false,
      supportsOAuthLogin: false,
    };
    const anthropic: ProviderOption = {
      id: "anthropic",
      name: "Anthropic",
      hasCredential: false,
      supportsApiKeyLogin: true,
      supportsOAuthLogin: true,
      oauthName: "Anthropic (Claude Pro/Max)",
    };
    const controller: ModelSetupController = {
      listProviders: async () => [ambientOnly, anthropic],
      listModels: () => [],
      login: vi.fn(),
      loginOAuth: vi.fn(),
      openUrl: vi.fn(),
      finish: vi.fn(),
    };

    // "API Key" list.
    const apiKeyRender = render(<SetupScreen setup={controller} onReady={() => {}} />);
    await chooseApiKeyAuth(apiKeyRender.stdin);
    expect(apiKeyRender.lastFrame()).toContain("Anthropic");
    expect(apiKeyRender.lastFrame()).not.toContain("Amazon Bedrock");

    // "OAuth" list.
    const oauthRender = render(<SetupScreen setup={controller} onReady={() => {}} />);
    await wait(30);
    oauthRender.stdin.write("\x1b[B"); // move off "API Key" onto "OAuth"
    await wait(30);
    oauthRender.stdin.write("\r"); // select OAuth
    await wait(30);
    expect(oauthRender.lastFrame()).toContain("Anthropic (Claude Pro/Max)");
    expect(oauthRender.lastFrame()).not.toContain("Amazon Bedrock");
  });

  it("calls onReady with the session finish() resolves, once a model is chosen", async () => {
    const controller: ModelSetupController = {
      listProviders: async () => [
        {
          id: "anthropic",
          name: "Anthropic",
          hasCredential: true,
          supportsApiKeyLogin: true,
          supportsOAuthLogin: false,
        },
      ],
      listModels: () => [{ id: "claude-sonnet-5", name: "Claude Sonnet 5" }],
      login: vi.fn(),
      loginOAuth: vi.fn(),
      openUrl: vi.fn(),
      finish: vi.fn(async () => FAKE_SESSION),
    };
    const onReady = vi.fn();

    const { stdin } = render(<SetupScreen setup={controller} onReady={onReady} />);
    await chooseApiKeyAuth(stdin);
    stdin.write("\r"); // provider
    await wait(10);
    stdin.write("\r"); // model
    await wait(10);

    expect(controller.finish).toHaveBeenCalledWith("anthropic", "claude-sonnet-5");
    expect(onReady).toHaveBeenCalledWith(FAKE_SESSION);
  });

  it("shows an error instead of crashing when listProviders() rejects", async () => {
    const controller: ModelSetupController = {
      listProviders: async () => {
        throw new Error("network unreachable");
      },
      listModels: () => [],
      login: vi.fn(),
      loginOAuth: vi.fn(),
      openUrl: vi.fn(),
      finish: vi.fn(),
    };

    const { lastFrame, stdin } = render(<SetupScreen setup={controller} onReady={() => {}} />);
    await chooseApiKeyAuth(stdin);

    expect(lastFrame()).toContain("Setup failed");
    expect(lastFrame()).toContain("network unreachable");
  });

  it("shows an error instead of crashing when finish() rejects (e.g. a bad model id)", async () => {
    const controller: ModelSetupController = {
      listProviders: async () => [
        {
          id: "anthropic",
          name: "Anthropic",
          hasCredential: true,
          supportsApiKeyLogin: true,
          supportsOAuthLogin: false,
        },
      ],
      listModels: () => [{ id: "claude-sonnet-5", name: "Claude Sonnet 5" }],
      login: vi.fn(),
      loginOAuth: vi.fn(),
      openUrl: vi.fn(),
      finish: vi.fn(async () => {
        throw new Error("model resolution failed");
      }),
    };

    const { lastFrame, stdin } = render(<SetupScreen setup={controller} onReady={() => {}} />);
    await chooseApiKeyAuth(stdin);
    stdin.write("\r");
    await wait(10);
    stdin.write("\r");
    await wait(10);

    expect(lastFrame()).toContain("Setup failed");
    expect(lastFrame()).toContain("model resolution failed");
  });
});
