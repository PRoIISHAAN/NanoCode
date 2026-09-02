// tryResolveConfiguredModel's fallback logic had zero test coverage before this -- the exact path
// where a real user hit a real bug (onboarding re-triggering every run despite a working saved
// credential, because only the credential was persisted, never the provider/model choice itself).
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AuthContext } from "@nanocode/ai";
import { createModelsRegistry, FileCredentialStore, writeStoredModelSelection } from "@nanocode/ai";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { tryResolveConfiguredModel } from "../src/setup.ts";

const ORIGINAL_ENV = { ...process.env };

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

describe("tryResolveConfiguredModel", () => {
  let dir: string;
  let selectionFilePath: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "nanocode-setup-test-"));
    selectionFilePath = join(dir, "model-selection.json");
    delete process.env.NANOCODE_PROVIDER;
    delete process.env.NANOCODE_MODEL;
  });

  afterEach(async () => {
    process.env = { ...ORIGINAL_ENV };
    await rm(dir, { recursive: true, force: true });
  });

  it("resolves undefined (not throw) when neither env vars nor a stored selection exist", async () => {
    const models = createModelsRegistry({ authContext: fakeAuthContext({}) });
    await expect(tryResolveConfiguredModel(models, selectionFilePath)).resolves.toBeUndefined();
  });

  it("uses NANOCODE_PROVIDER/NANOCODE_MODEL when both are set, ignoring any stored selection", async () => {
    process.env.NANOCODE_PROVIDER = "anthropic";
    process.env.NANOCODE_MODEL = "claude-sonnet-5";
    // A stored selection for a DIFFERENT provider is also present -- env vars must still win.
    await writeStoredModelSelection(
      { provider: "openrouter", model: "anthropic/claude-3-haiku" },
      selectionFilePath,
    );
    const models = createModelsRegistry({
      authContext: fakeAuthContext({ ANTHROPIC_API_KEY: "sk-test", OPENROUTER_API_KEY: "or-test" }),
    });
    const model = await tryResolveConfiguredModel(models, selectionFilePath);
    expect(model?.provider).toBe("anthropic");
    expect(model?.id).toBe("claude-sonnet-5");
  });

  it("falls back to the stored selection when no env vars are set -- the real bug this fixes", async () => {
    // Regression: onboarding previously only persisted the API key (via saveApiKey), never the
    // provider/model CHOICE -- so a run with no env vars set had no way to know which
    // already-configured provider/model to use, and re-triggered onboarding every single time
    // even though a working credential already existed.
    await writeStoredModelSelection(
      { provider: "openrouter", model: "anthropic/claude-3-haiku" },
      selectionFilePath,
    );
    const models = createModelsRegistry({
      authContext: fakeAuthContext({ OPENROUTER_API_KEY: "or-test" }),
    });
    const model = await tryResolveConfiguredModel(models, selectionFilePath);
    expect(model?.provider).toBe("openrouter");
    expect(model?.id).toBe("anthropic/claude-3-haiku");
  });

  it("resolves undefined (not throw) when the stored selection's provider no longer has a credential", async () => {
    await writeStoredModelSelection(
      { provider: "openrouter", model: "anthropic/claude-3-haiku" },
      selectionFilePath,
    );
    // No OPENROUTER_API_KEY this time -- the stored selection is now stale/unusable.
    const models = createModelsRegistry({ authContext: fakeAuthContext({}) });
    await expect(tryResolveConfiguredModel(models, selectionFilePath)).resolves.toBeUndefined();
  });

  it("actually persists what onboarding chooses, via the real FileCredentialStore + stored selection together", async () => {
    // End-to-end proof of the fix: save a credential (as saveApiKey/onboarding would) AND the
    // selection (as tui.tsx's finish() now does), then confirm a fresh call with no env vars
    // resolves it -- exactly the "next launch" scenario the user hit.
    const credentialsFilePath = join(dir, "credentials.json");
    const credentials = new FileCredentialStore(credentialsFilePath);
    await credentials.modify("openrouter", async () => ({ type: "api_key", key: "or-test" }));
    await writeStoredModelSelection(
      { provider: "openrouter", model: "anthropic/claude-3-haiku" },
      selectionFilePath,
    );

    const models = createModelsRegistry({ credentials, authContext: fakeAuthContext({}) });
    const model = await tryResolveConfiguredModel(models, selectionFilePath);
    expect(model?.provider).toBe("openrouter");
    expect(model?.id).toBe("anthropic/claude-3-haiku");
  });
});
