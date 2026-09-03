// switchModel (packages/cli/src/setup.ts): resolves a provider/model, reassigns it onto
// session.state.model in place (preserving session.state.messages -- switchModel deliberately
// never rebuilds the runtime, see setup.ts's own comment on why), and persists the choice via
// @nanocode/ai's writeStoredModelSelection. Takes an explicit `storedSelectionFilePath` (mirroring
// tryResolveConfiguredModel's own parameter of the same name/purpose) so this test -- like every
// other test in this repo that touches persisted `~/.nanocode/*` state -- never reads or writes the
// real developer machine's files. No mocking needed: every function used here is the real one.
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentMessage, Session } from "@nanocode/agent";
import { type AuthContext, createModelsRegistry, ModelConfigurationError } from "@nanocode/ai";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { switchModel } from "../src/setup.ts";

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

describe("switchModel", () => {
  let tempDir: string;
  let selectionFilePath: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "nanocode-switch-model-"));
    selectionFilePath = join(tempDir, "model-selection.json");
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  it("resolves the model, assigns it onto session.state.model in place, preserves messages, and persists the selection to the given file", async () => {
    const models = createModelsRegistry({
      authContext: fakeAuthContext({ ANTHROPIC_API_KEY: "sk-test" }),
    });
    const originalMessages: AgentMessage[] = [
      { role: "user", content: "hi", timestamp: 1 } as AgentMessage,
    ];
    const fakeSession = {
      state: { model: { provider: "old-provider", id: "old-model" }, messages: originalMessages },
    } as unknown as Session;

    await switchModel(fakeSession, models, "anthropic", "claude-sonnet-5", selectionFilePath);

    const model = fakeSession.state.model as { provider: string; id: string };
    expect(model.provider).toBe("anthropic");
    expect(model.id).toBe("claude-sonnet-5");
    // Messages are untouched -- switchModel deliberately never rebuilds the runtime.
    expect(fakeSession.state.messages).toBe(originalMessages);

    const written = JSON.parse(await readFile(selectionFilePath, "utf8"));
    expect(written).toEqual({ provider: "anthropic", model: "claude-sonnet-5" });
  });

  it("throws ModelConfigurationError for an unresolvable provider/model, leaves session.state.model untouched, and never writes the selection file", async () => {
    const models = createModelsRegistry({ authContext: fakeAuthContext({}) });
    const originalModel = { provider: "old-provider", id: "old-model" };
    const fakeSession = {
      state: { model: originalModel, messages: [] },
    } as unknown as Session;

    await expect(
      switchModel(
        fakeSession,
        models,
        "not-a-real-provider",
        "not-a-real-model",
        selectionFilePath,
      ),
    ).rejects.toThrow(ModelConfigurationError);
    expect(fakeSession.state.model).toBe(originalModel);
    await expect(readFile(selectionFilePath, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
  });
});
