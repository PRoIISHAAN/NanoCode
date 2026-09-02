import type { AuthContext } from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";
import {
  createModelsRegistry,
  ModelConfigurationError,
  readModelSelectionFromEnv,
  resolveModel,
} from "../src/index.ts";

// A fake AuthContext lets us control exactly which env vars "exist" from pi-ai's point of view,
// so these tests never depend on (or leak into) the real machine's actual API keys.
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

describe("readModelSelectionFromEnv", () => {
  it("throws when NANOCODE_PROVIDER is missing", () => {
    expect(() => readModelSelectionFromEnv({ NANOCODE_MODEL: "claude-sonnet-5" })).toThrow(
      ModelConfigurationError,
    );
  });

  it("throws when NANOCODE_MODEL is missing", () => {
    expect(() => readModelSelectionFromEnv({ NANOCODE_PROVIDER: "anthropic" })).toThrow(
      ModelConfigurationError,
    );
  });

  it("returns the selection when both are set", () => {
    expect(
      readModelSelectionFromEnv({
        NANOCODE_PROVIDER: "anthropic",
        NANOCODE_MODEL: "claude-sonnet-5",
      }),
    ).toEqual({ provider: "anthropic", model: "claude-sonnet-5" });
  });
});

describe("resolveModel", () => {
  it("rejects a provider id pi-ai doesn't know about", async () => {
    const models = createModelsRegistry({ authContext: fakeAuthContext({}) });
    await expect(
      resolveModel(models, { provider: "not-a-real-provider", model: "x" }),
    ).rejects.toThrow(/Unknown provider/);
  });

  it("rejects a known provider with no credentials configured", async () => {
    // Empty fake env: ANTHROPIC_API_KEY is deliberately absent, so pi-ai's own auth resolution
    // for the anthropic provider reports "unconfigured" via checkAuth() returning undefined.
    const models = createModelsRegistry({ authContext: fakeAuthContext({}) });
    await expect(
      resolveModel(models, { provider: "anthropic", model: "claude-sonnet-5" }),
    ).rejects.toThrow(/no credentials configured/);
  });

  it("rejects an unknown model id for a configured provider", async () => {
    const models = createModelsRegistry({
      authContext: fakeAuthContext({ ANTHROPIC_API_KEY: "test-key" }),
    });
    await expect(
      resolveModel(models, { provider: "anthropic", model: "not-a-real-model" }),
    ).rejects.toThrow(/Model "not-a-real-model" not found/);
  });

  it("resolves a real model for a configured provider", async () => {
    const models = createModelsRegistry({
      authContext: fakeAuthContext({ ANTHROPIC_API_KEY: "test-key" }),
    });
    const model = await resolveModel(models, { provider: "anthropic", model: "claude-sonnet-5" });
    expect(model.id).toBe("claude-sonnet-5");
    expect(model.provider).toBe("anthropic");
  });
});
