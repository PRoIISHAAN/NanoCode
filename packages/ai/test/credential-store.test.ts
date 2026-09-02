import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AuthContext } from "@earendil-works/pi-ai";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { FileCredentialStore } from "../src/credential-store.ts";
import { createModelsRegistry, resolveModel } from "../src/index.ts";

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

describe("FileCredentialStore", () => {
  let dir: string;
  let filePath: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "nanocode-credentials-test-"));
    filePath = join(dir, "credentials.json");
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("read() resolves undefined when nothing was ever stored (no file on disk yet)", async () => {
    const store = new FileCredentialStore(filePath);
    await expect(store.read("anthropic")).resolves.toBeUndefined();
  });

  it("modify() persists a credential that a later read() sees, including across instances", async () => {
    const store = new FileCredentialStore(filePath);
    const saved = await store.modify("anthropic", async () => ({
      type: "api_key",
      key: "sk-test",
    }));
    expect(saved).toEqual({ type: "api_key", key: "sk-test" });

    // A fresh instance pointed at the same file must see it too -- proves this is real on-disk
    // persistence, not an in-memory cache this class happens to also satisfy the interface with.
    const reopened = new FileCredentialStore(filePath);
    await expect(reopened.read("anthropic")).resolves.toEqual({ type: "api_key", key: "sk-test" });
  });

  it("modify() returning undefined from fn leaves the existing entry unchanged", async () => {
    const store = new FileCredentialStore(filePath);
    await store.modify("anthropic", async () => ({ type: "api_key", key: "original" }));
    const result = await store.modify("anthropic", async () => undefined);
    expect(result).toEqual({ type: "api_key", key: "original" });
    await expect(store.read("anthropic")).resolves.toEqual({ type: "api_key", key: "original" });
  });

  it("modify() passes the current credential into fn (read-modify-write, not blind overwrite)", async () => {
    const store = new FileCredentialStore(filePath);
    await store.modify("anthropic", async () => ({ type: "api_key", key: "first" }));
    await store.modify("anthropic", async (current) => {
      expect(current).toEqual({ type: "api_key", key: "first" });
      return { type: "api_key", key: "second" };
    });
    await expect(store.read("anthropic")).resolves.toEqual({ type: "api_key", key: "second" });
  });

  it("list() returns metadata (id + type) without exposing the stored secret", async () => {
    const store = new FileCredentialStore(filePath);
    await store.modify("anthropic", async () => ({ type: "api_key", key: "sk-test" }));
    await store.modify("openrouter", async () => ({ type: "api_key", key: "or-test" }));
    const listed = await store.list();
    expect(listed).toEqual(
      expect.arrayContaining([
        { providerId: "anthropic", type: "api_key" },
        { providerId: "openrouter", type: "api_key" },
      ]),
    );
    // Every entry in the list result must be exactly {providerId, type} -- no leaked "key" field.
    for (const entry of listed) {
      expect(Object.keys(entry).sort()).toEqual(["providerId", "type"]);
    }
  });

  it("delete() removes an entry; other entries survive", async () => {
    const store = new FileCredentialStore(filePath);
    await store.modify("anthropic", async () => ({ type: "api_key", key: "sk-test" }));
    await store.modify("openrouter", async () => ({ type: "api_key", key: "or-test" }));
    await store.delete("anthropic");
    await expect(store.read("anthropic")).resolves.toBeUndefined();
    await expect(store.read("openrouter")).resolves.toEqual({ type: "api_key", key: "or-test" });
  });

  it("delete() on a provider with no stored credential is a harmless no-op", async () => {
    const store = new FileCredentialStore(filePath);
    await expect(store.delete("anthropic")).resolves.toBeUndefined();
  });

  it("writes the file with restrictive (0o600) permissions, since it holds raw secrets", async () => {
    const store = new FileCredentialStore(filePath);
    await store.modify("anthropic", async () => ({ type: "api_key", key: "sk-test" }));
    const stats = await stat(filePath);
    expect(stats.mode & 0o777).toBe(0o600);
  });

  it("a corrupted (non-JSON) file fails loudly rather than silently reporting no credentials", async () => {
    // Matches this codebase's established convention (trust.ts/mcp.json's loaders): only a
    // missing file (ENOENT) is treated as "nothing stored yet." Any other read/parse failure
    // propagates -- silently treating corruption as "no credentials" could mask a real problem
    // (a partial write, tampering) rather than surfacing it.
    const { mkdir, writeFile } = await import("node:fs/promises");
    await mkdir(dir, { recursive: true });
    await writeFile(filePath, "not json at all");
    const store = new FileCredentialStore(filePath);
    await expect(store.read("anthropic")).rejects.toThrow(SyntaxError);
  });

  it("bridges into pi-ai's own auth resolution: a stored key satisfies checkAuth/resolveModel", async () => {
    // This is the real integration point (decisions/0011-tui-onboarding.md): createModelsRegistry
    // must actually consult this store, not just accept it as a type-compatible option.
    const store = new FileCredentialStore(filePath);
    await store.modify("anthropic", async () => ({ type: "api_key", key: "sk-test" }));

    const models = createModelsRegistry({ credentials: store, authContext: fakeAuthContext({}) });
    const model = await resolveModel(models, { provider: "anthropic", model: "claude-sonnet-5" });
    expect(model.id).toBe("claude-sonnet-5");

    const raw = JSON.parse(await readFile(filePath, "utf8"));
    expect(raw.anthropic).toEqual({ type: "api_key", key: "sk-test" });
  });
});
