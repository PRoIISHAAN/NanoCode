import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AuthContext } from "@nanocode/ai";
import { createModelsRegistry, FileCredentialStore } from "@nanocode/ai";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { listModelOptions, listProviderOptions, saveApiKey } from "../src/model-setup.ts";

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

  it("includes every apiKey-capable provider the registry knows about, not just a hardcoded subset", async () => {
    const models = createModelsRegistry({ authContext: fakeAuthContext({}) });
    const options = await listProviderOptions(models);
    const apiKeyProviderIds = models
      .getProviders()
      .filter((p) => p.auth.apiKey !== undefined)
      .map((p) => p.id);
    expect(options.map((p) => p.id).sort()).toEqual(apiKeyProviderIds.sort());
  });

  it("excludes an OAuth-only provider entirely -- nanocode has no path to ever use it (ADR 0004)", async () => {
    // Regression for an L4 VERIFY finding: an earlier version listed every provider and let the
    // user "select" an OAuth-only one (e.g. pi-ai's built-in openai-codex, auth: {oauth}, no
    // apiKey at all), which dead-ended after model choice with no way back except quitting.
    const models = createModelsRegistry({ authContext: fakeAuthContext({}) });
    const codexProvider = models.getProvider("openai-codex");
    expect(codexProvider).toBeDefined(); // sanity: it really exists in the real registry
    expect(codexProvider?.auth.apiKey).toBeUndefined(); // sanity: it really has no apiKey auth

    const options = await listProviderOptions(models);
    expect(options.find((p) => p.id === "openai-codex")).toBeUndefined();
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
