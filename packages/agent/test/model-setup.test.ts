import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AuthContext, MutableModels, Provider } from "@nanocode/ai";
import { createModelsRegistry, FileCredentialStore } from "@nanocode/ai";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  listModelOptions,
  listProviderOptions,
  loginWithOAuth,
  type OAuthLoginHandlers,
  type OAuthPrompt,
  saveApiKey,
} from "../src/model-setup.ts";

function fakeAuthContext(env: Record<string, string>): AuthContext {
  return {
    async env(name) {
      return env[name];
    },
    async fileExists() {
      return false;
    },
  };
}

/** A minimal fake `Provider` with ONLY a real OAuth auth method (no `apiKey` at all) -- the shape
 * an OAuth-only pi-ai-bundled provider (e.g. its real "openai-codex") has. `getModels`/`stream`/
 * `streamSimple`/`oauth.login` are never actually invoked by `listProviderOptions` (it only ever
 * reads `provider.auth` and calls `models.checkAuth`), so they're throwing stubs -- same
 * "should-never-be-called" convention packages/tui's own tests use for methods a test doesn't
 * expect to be exercised. */
function fakeOAuthOnlyProvider(id: string, oauthName: string): Provider {
  const notImplemented = () => {
    throw new Error(`${id}: not implemented in this fake`);
  };
  return {
    id,
    name: id,
    auth: {
      oauth: {
        name: oauthName,
        login: notImplemented,
        refresh: notImplemented,
        toAuth: notImplemented,
      },
    },
    getModels: () => [],
    stream: notImplemented,
    streamSimple: notImplemented,
  } as unknown as Provider;
}

/** A minimal fake ambient-only `Provider`: `auth.apiKey` is present (so it's usable via
 * `resolve()` against ambient state) but has no `login`, matching how amazon-bedrock/google-vertex
 * are described elsewhere in this codebase (env var / cloud profile config, no interactive login
 * step). */
function fakeAmbientOnlyProvider(id: string): Provider {
  const notImplemented = () => {
    throw new Error(`${id}: not implemented in this fake`);
  };
  return {
    id,
    name: id,
    auth: {
      apiKey: {
        name: `${id} ambient credentials`,
        resolve: async () => undefined,
      },
    },
    getModels: () => [],
    stream: notImplemented,
    streamSimple: notImplemented,
  } as unknown as Provider;
}

/** A fake `MutableModels` whose only implemented member is `login` -- everything `loginWithOAuth`
 * itself touches. Matches this file's own `fakeOAuthOnlyProvider`/`fakeAmbientOnlyProvider` pattern
 * of building the smallest fake that satisfies what the code under test actually calls, rather than
 * standing up a real registry when the whole point is controlling `login()` directly. */
function fakeModelsWithLogin(login: MutableModels["login"]): MutableModels {
  return { login } as unknown as MutableModels;
}

describe("listProviderOptions", () => {
  it("reports hasCredential false for a provider with no env var and no stored credential", async () => {
    const models = createModelsRegistry({ authContext: fakeAuthContext({}) });
    const options = await listProviderOptions(models);
    const anthropic = options.find((p) => p.id === "anthropic");
    expect(anthropic).toBeDefined();
    expect(anthropic?.hasCredential).toBe(false);
    expect(anthropic?.supportsApiKeyLogin).toBe(true);
  });

  it("reports hasCredential true once the ambient env var is present", async () => {
    const models = createModelsRegistry({
      authContext: fakeAuthContext({ ANTHROPIC_API_KEY: "sk-test" }),
    });
    const options = await listProviderOptions(models);
    const anthropic = options.find((p) => p.id === "anthropic");
    expect(anthropic?.hasCredential).toBe(true);
  });

  it("includes every apiKey-or-oauth-capable provider the registry knows about, not just a hardcoded subset", async () => {
    const models = createModelsRegistry({ authContext: fakeAuthContext({}) });
    const options = await listProviderOptions(models);
    // Any provider with EITHER auth method is included now (see this function's own header
    // comment -- OAuth login is a real, supported path now, not excluded per ADR 0004 anymore).
    const expectedIds = models
      .getProviders()
      .filter((p) => p.auth.apiKey !== undefined || p.auth.oauth !== undefined)
      .map((p) => p.id);
    expect(options.map((p) => p.id).sort()).toEqual(expectedIds.sort());
  });

  it("includes an OAuth-only provider, since it now has a real login path", async () => {
    // An earlier version of this test (and of listProviderOptions itself) excluded any OAuth-only
    // provider entirely, since OAuth login wasn't implemented yet and there was no path nanocode
    // could ever use it through. That's now reversed: OAuth login is real, so an OAuth-only
    // provider belongs in the list, routable through the OAuth branch of onboarding/"/login".
    const models = createModelsRegistry({ authContext: fakeAuthContext({}) });
    models.setProvider(fakeOAuthOnlyProvider("fake-oauth-only", "Fake Provider (subscription)"));

    const options = await listProviderOptions(models);
    const option = options.find((p) => p.id === "fake-oauth-only");
    expect(option).toBeDefined();
    expect(option?.supportsOAuthLogin).toBe(true);
    expect(option?.supportsApiKeyLogin).toBe(false);
    expect(option?.oauthName).toBe("Fake Provider (subscription)");
  });

  it("reports supportsOAuthLogin false and no oauthName for an ambient-only provider with no oauth auth at all", async () => {
    const models = createModelsRegistry({ authContext: fakeAuthContext({}) });
    models.setProvider(fakeAmbientOnlyProvider("fake-ambient-only"));

    const options = await listProviderOptions(models);
    const option = options.find((p) => p.id === "fake-ambient-only");
    expect(option).toBeDefined();
    expect(option?.supportsApiKeyLogin).toBe(false);
    expect(option?.supportsOAuthLogin).toBe(false);
    expect(option?.oauthName).toBeUndefined();
  });

  it("reports supportsApiKeyLogin AND supportsOAuthLogin/oauthName true for a provider offering both", async () => {
    // "anthropic" is a real, built-in provider offering both an interactive api-key login and a
    // real OAuth login ("Anthropic (Claude Pro/Max)") -- no fake needed, this is real registry data.
    const models = createModelsRegistry({ authContext: fakeAuthContext({}) });
    const options = await listProviderOptions(models);
    const anthropic = options.find((p) => p.id === "anthropic");
    expect(anthropic).toBeDefined();
    expect(anthropic?.supportsApiKeyLogin).toBe(true);
    expect(anthropic?.supportsOAuthLogin).toBe(true);
    expect(anthropic?.oauthName).toBe("Anthropic (Claude Pro/Max)");
  });
});

describe("listModelOptions", () => {
  it("lists a known provider's models", () => {
    const models = createModelsRegistry({ authContext: fakeAuthContext({}) });
    const options = listModelOptions(models, "anthropic");
    expect(options.length).toBeGreaterThan(0);
    expect(options.every((m) => typeof m.id === "string" && typeof m.name === "string")).toBe(true);
  });

  it("returns an empty array for an unknown provider id rather than throwing", () => {
    const models = createModelsRegistry({ authContext: fakeAuthContext({}) });
    expect(listModelOptions(models, "not-a-real-provider")).toEqual([]);
  });
});

describe("saveApiKey", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "nanocode-model-setup-test-"));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("persists the key so the provider reports a credential afterward", async () => {
    const credentials = new FileCredentialStore(join(dir, "credentials.json"));
    const models = createModelsRegistry({ credentials, authContext: fakeAuthContext({}) });

    expect(
      (await listProviderOptions(models)).find((p) => p.id === "anthropic")?.hasCredential,
    ).toBe(false);

    await saveApiKey(models, "anthropic", "sk-entered-through-tui");

    expect(
      (await listProviderOptions(models)).find((p) => p.id === "anthropic")?.hasCredential,
    ).toBe(true);
    await expect(credentials.read("anthropic")).resolves.toEqual({
      type: "api_key",
      key: "sk-entered-through-tui",
    });
  });
});

describe("loginWithOAuth", () => {
  it('calls models.login with (providerId, "oauth", interaction), passing handlers.signal through', async () => {
    const login = vi.fn(async () => ({ type: "oauth" }) as never);
    const models = fakeModelsWithLogin(login);
    const signal = new AbortController().signal;
    const handlers: OAuthLoginHandlers = { signal, notify: vi.fn(), prompt: vi.fn() };

    await loginWithOAuth(models, "some-provider", handlers);

    expect(login).toHaveBeenCalledTimes(1);
    expect(login).toHaveBeenCalledWith(
      "some-provider",
      "oauth",
      expect.objectContaining({
        signal,
        notify: expect.any(Function),
        prompt: expect.any(Function),
      }),
    );
  });

  it("translates every real AuthEvent shape pi-ai's interaction.notify() can raise into its plain OAuthEvent mirror", async () => {
    const notify = vi.fn();
    const login = vi.fn(async (_providerId: string, _type: string, interaction) => {
      // Real pi-ai AuthEvent shapes (auth/types.d.ts) -- "info" carries an extra `links` field
      // loginWithOAuth's own translation deliberately drops (OAuthEvent's "info" has no `links`).
      interaction.notify({ type: "info", message: "signing in...", links: [{ url: "https://x" }] });
      interaction.notify({
        type: "auth_url",
        url: "https://example.com/authorize",
        instructions: "Open this to continue:",
      });
      interaction.notify({
        type: "device_code",
        userCode: "ABCD-1234",
        verificationUri: "https://example.com/verify",
        intervalSeconds: 5,
        expiresInSeconds: 600,
      });
      interaction.notify({ type: "progress", message: "still waiting..." });
      return { type: "oauth" } as never;
    });
    const models = fakeModelsWithLogin(login);

    await loginWithOAuth(models, "some-provider", { notify, prompt: vi.fn() });

    expect(notify).toHaveBeenNthCalledWith(1, { type: "info", message: "signing in..." });
    expect(notify).toHaveBeenNthCalledWith(2, {
      type: "auth_url",
      url: "https://example.com/authorize",
      instructions: "Open this to continue:",
    });
    expect(notify).toHaveBeenNthCalledWith(3, {
      type: "device_code",
      userCode: "ABCD-1234",
      verificationUri: "https://example.com/verify",
      intervalSeconds: 5,
      expiresInSeconds: 600,
    });
    expect(notify).toHaveBeenNthCalledWith(4, { type: "progress", message: "still waiting..." });
    expect(notify).toHaveBeenCalledTimes(4);
  });

  it("translates every real AuthPrompt shape into its plain OAuthPrompt mirror, passing each prompt's own signal through, and round-trips handlers.prompt()'s answer back to interaction.prompt()", async () => {
    const promptSignal = new AbortController().signal;
    const prompt = vi.fn(async (p: OAuthPrompt) => `answer-for-${p.type}`);
    const selectOptions = [
      { id: "a", label: "Option A" },
      { id: "b", label: "Option B", description: "the B one" },
    ] as const;

    const login = vi.fn(async (_providerId: string, _type: string, interaction) => {
      await expect(
        interaction.prompt({
          type: "text",
          message: "What's your name?",
          placeholder: "your name",
          signal: promptSignal,
        }),
      ).resolves.toBe("answer-for-text");
      await expect(
        interaction.prompt({
          type: "secret",
          message: "What's the secret?",
          placeholder: "shh",
          signal: promptSignal,
        }),
      ).resolves.toBe("answer-for-secret");
      await expect(
        interaction.prompt({
          type: "select",
          message: "Pick one",
          options: selectOptions,
          signal: promptSignal,
        }),
      ).resolves.toBe("answer-for-select");
      await expect(
        interaction.prompt({
          type: "manual_code",
          message: "Enter the code",
          placeholder: "XXXX-XXXX",
          signal: promptSignal,
        }),
      ).resolves.toBe("answer-for-manual_code");
      return { type: "oauth" } as never;
    });
    const models = fakeModelsWithLogin(login);

    await loginWithOAuth(models, "some-provider", { notify: vi.fn(), prompt });

    expect(prompt).toHaveBeenNthCalledWith(1, {
      type: "text",
      message: "What's your name?",
      placeholder: "your name",
      signal: promptSignal,
    });
    expect(prompt).toHaveBeenNthCalledWith(2, {
      type: "secret",
      message: "What's the secret?",
      placeholder: "shh",
      signal: promptSignal,
    });
    expect(prompt).toHaveBeenNthCalledWith(3, {
      type: "select",
      message: "Pick one",
      options: selectOptions,
      signal: promptSignal,
    });
    expect(prompt).toHaveBeenNthCalledWith(4, {
      type: "manual_code",
      message: "Enter the code",
      placeholder: "XXXX-XXXX",
      signal: promptSignal,
    });
    expect(prompt).toHaveBeenCalledTimes(4);
  });
});
