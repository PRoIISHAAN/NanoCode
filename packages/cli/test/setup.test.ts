// tryResolveConfiguredModel's fallback logic had zero test coverage before this -- the exact path
// where a real user hit a real bug (onboarding re-triggering every run despite a working saved
// credential, because only the credential was persisted, never the provider/model choice itself).
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AuthContext } from "@nanocode/ai";
import { createModelsRegistry, FileCredentialStore, writeStoredModelSelection } from "@nanocode/ai";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runShellCommand, tryResolveConfiguredModel } from "../src/setup.ts";

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

  it("uses NANOCODE_PROVIDER/NANOCODE_MODEL when both are set and actually resolve", async () => {
    process.env.NANOCODE_PROVIDER = "anthropic";
    process.env.NANOCODE_MODEL = "claude-sonnet-5";
    // A stored selection for a DIFFERENT provider is also present -- working env vars still win.
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

  it("falls back to the stored selection when env vars are SET but don't resolve -- the real bug the user hit", async () => {
    // Regression for a second, subtler version of the same bug: the first fix only fell back to
    // the stored selection when env vars were *missing*. But this project's own "how to run it"
    // guidance told the user to `export NANOCODE_PROVIDER=...`/`export NANOCODE_MODEL=...` --
    // if those stayed exported in the same shell after the user later configured a *different*
    // provider through onboarding, the stale env vars would win every time (since both were
    // "set"), fail to resolve (no credential for THAT provider), and the old code gave up right
    // there instead of trying the perfectly good stored selection -- reproducing onboarding firing
    // on every single launch despite a working saved configuration.
    process.env.NANOCODE_PROVIDER = "anthropic"; // set, but no ANTHROPIC_API_KEY below
    process.env.NANOCODE_MODEL = "claude-sonnet-5";
    await writeStoredModelSelection(
      { provider: "openrouter", model: "anthropic/claude-3-haiku" },
      selectionFilePath,
    );
    const models = createModelsRegistry({
      authContext: fakeAuthContext({ OPENROUTER_API_KEY: "or-test" }), // only openrouter configured
    });
    const model = await tryResolveConfiguredModel(models, selectionFilePath);
    expect(model?.provider).toBe("openrouter");
    expect(model?.id).toBe("anthropic/claude-3-haiku");
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

describe("runShellCommand", () => {
  // No mocking here, matching this file's own established convention (see
  // `tryResolveConfiguredModel` above): runShellCommand spawns a REAL host shell process via
  // `execFile(process.env.SHELL ?? "/bin/sh", ["-c", command])` -- there's no kernel or subprocess
  // seam left to fake since the design change away from the old kernel-routed approach.

  it("returns real stdout with isError false for a successful command", async () => {
    const result = await runShellCommand("echo hello");
    expect(result).toEqual({ output: "hello\n", isError: false });
  });

  it("keeps isError false and still surfaces the command's captured output when it exits nonzero", async () => {
    // isError is reserved for the shell itself failing to run at all (e.g. /bin/sh missing) --
    // never for the command's own exit status, per runShellCommand's doc comment. Node still
    // attaches stdout/stderr to the rejection even on a nonzero exit, and those are what get
    // surfaced here.
    const result = await runShellCommand("echo failure-marker 1>&2; exit 1");
    expect(result.isError).toBe(false);
    expect(result.output).toContain("failure-marker");
  });

  it("runs the command in the CLI process's own process.cwd()", async () => {
    // Resolved through realpath on both sides so this doesn't flake on macOS, where
    // process.cwd() and a shell's own `pwd` can disagree about a path involving a symlinked
    // ancestor (e.g. /tmp -> /private/tmp) even when they're really the same directory.
    const expectedCwd = await realpath(process.cwd());
    const result = await runShellCommand("pwd");
    expect(result.isError).toBe(false);
    expect(await realpath(result.output.trim())).toBe(expectedCwd);
  });

  it("executes shell-special characters (quotes, &&, a pipe) since the command runs through a real shell via -c", async () => {
    const result = await runShellCommand(`echo "hello world" | tr 'a-z' 'A-Z' && echo done`);
    expect(result.isError).toBe(false);
    expect(result.output).toContain("HELLO WORLD");
    expect(result.output).toContain("done");
  });

  it("does not persist a `cd` from one call to a LATER, separate call -- each spawns its own independent process, with no shared state at all (not even with the model's own kernel-side Python)", async () => {
    const dir = await mkdtemp(join(tmpdir(), "nanocode-bang-cd-"));
    const canonicalDir = await realpath(dir); // already canonical, so `pwd` needs no further resolution
    try {
      // `cd`/`pwd` sharing ONE call's shell process DOES see the new directory...
      const combined = await runShellCommand(`cd ${canonicalDir} && pwd`);
      expect(combined.isError).toBe(false);
      expect(combined.output.trim()).toBe(canonicalDir);

      // ...but a following, SEPARATE call does not: it's a brand new host shell process with no
      // memory of the previous one's `cd` (there is no persistent process to share state with at
      // all under this design -- unlike the old kernel-routed approach, a bang command can no
      // longer see anything the model's own Python code does either).
      const later = await runShellCommand("pwd");
      expect(later.output.trim()).not.toBe(canonicalDir);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
