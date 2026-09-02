#!/usr/bin/env node
// The interactive entrypoint (M5, onboarding added post-M7 per decisions/0011-tui-onboarding.md):
// `npm run tui`. Shares setup.ts with the headless `run` command in index.ts for the actual
// kernel/session/telemetry/MCP wiring, but -- unlike headless `run`, which still fails fast on
// missing model config -- this entrypoint never lets a missing model crash the process before Ink
// renders. It renders unconditionally, and hands `App` a `ModelSetupController` closing over
// `MutableModels`/`resolveModel` so packages/tui itself never has to import packages/kernel or
// packages/ai directly (decisions/0005-tui-stack.md's invariant) to drive onboarding.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  listModelOptions,
  listProviderOptions,
  type Session,
  saveApiKey,
  TrustStore,
} from "@nanocode/agent";
import { resolveModel, writeStoredModelSelection } from "@nanocode/ai";
import { App, type ModelSetupController } from "@nanocode/tui";
import { render } from "ink";
// Explicit React import: proven necessary by direct A/B testing (removing it reproduces
// "ReferenceError: React is not defined" here even though packages/cli already has its own
// tsconfig.json with jsx: "react-jsx" inherited from the root config, and even though the same
// omission does NOT reproduce the error for a minimal same-shape repro file or for
// packages/tui/src's own .tsx files once packages/tui got its own local tsconfig.json). The
// likely cause: tsx's underlying esbuild transform resolves JSX settings once for the whole
// dependency graph reachable from the entry file, not per file -- tui.tsx transitively imports a
// large, multi-package graph via setup.ts (agent/ai/kernel), unlike a minimal repro, and something
// in that resolution doesn't consistently land on the automatic runtime for the entry file itself.
// Kept as a directly-verified, working fix rather than a fully understood one.
// biome-ignore lint/correctness/noUnusedImports: required by tsx's runtime JSX transform, not referenced directly in this file's own code
import React from "react";
import {
  buildRuntimeForModel,
  createModelsContext,
  type NanocodeSetup,
  runShellCommand,
  tryResolveConfiguredModel,
} from "./setup.ts";
import { ensureTrust, TrustDeniedError } from "./trust-prompt.ts";

// Read directly from this package's own package.json rather than hardcoding a version string that
// would silently drift out of sync -- same fileURLToPath(new URL(...)) pattern
// repl-kernel-manager.ts uses to locate the Python kernel source, so it resolves correctly
// regardless of the caller's own process.cwd().
const PACKAGE_JSON_PATH = fileURLToPath(new URL("../package.json", import.meta.url));
const { version: PACKAGE_VERSION } = JSON.parse(readFileSync(PACKAGE_JSON_PATH, "utf8")) as {
  version: string;
};

async function main(): Promise<void> {
  // Trust gating is unchanged by onboarding: it still runs before anything else, as a plain
  // pre-Ink prompt, exactly as it did before this change -- onboarding only ever affects the
  // *model* configuration step, never the trust boundary.
  const trustStore = await TrustStore.open();
  await ensureTrust(trustStore, process.cwd());

  const { models } = createModelsContext();
  const initialModel = await tryResolveConfiguredModel(models);

  // Holds whichever runtime actually ends up running -- built immediately below if a model was
  // already configured, or later, once `finish()` resolves one through onboarding. `waitUntilExit`
  // resolving doesn't imply this is set: an unconfigured run can be closed with Ctrl+C mid-setup,
  // before any kernel ever started (`runtime` stays undefined the whole time), OR while `finish()`
  // is still in flight (the user picked a model and Ink already unmounted before
  // `buildRuntimeForModel` finished) -- an L4 VERIFY finding against an earlier version of this
  // function, which read `runtime` in the `finally` block without ever waiting for that in-flight
  // call, silently orphaning its kernel/session/telemetry with no `cleanup()` ever called.
  // `pendingFinish` lets the `finally` block below wait for that in-flight call to settle first, so
  // whatever it built (if anything) is still reachable to clean up.
  let runtime: NanocodeSetup | undefined;
  let pendingFinish: Promise<NanocodeSetup> | undefined;
  let initialSession: Session | undefined;
  if (initialModel) {
    runtime = await buildRuntimeForModel(initialModel, models);
    initialSession = runtime.session;
  }

  const setup: ModelSetupController = {
    listProviders: () => listProviderOptions(models),
    listModels: (providerId) => listModelOptions(models, providerId),
    login: (providerId, apiKey) => saveApiKey(models, providerId, apiKey),
    finish: (providerId, modelId) => {
      const finishing = (async () => {
        const model = await resolveModel(models, { provider: providerId, model: modelId });
        // Persists the CHOICE itself, not just the credential saveApiKey already persisted --
        // without this, a later run with no NANOCODE_PROVIDER/NANOCODE_MODEL env vars set had no
        // way to know which already-configured provider/model to use and re-triggered onboarding
        // from scratch every time (a real bug the user hit directly; see
        // tryResolveConfiguredModel's fallback to readStoredModelSelection in setup.ts).
        await writeStoredModelSelection({ provider: providerId, model: modelId });
        return buildRuntimeForModel(model, models);
      })();
      pendingFinish = finishing;
      return finishing.then((built) => {
        runtime = built;
        return built.session;
      });
    },
  };

  // Passed straight through -- runShellCommand spawns a real host shell process directly (like
  // pi's own "!"), independent of any session/kernel, so there's no `runtime` to close over here
  // at all (an earlier version of this function routed bang commands through the kernel instead
  // and needed one; see setup.ts's runShellCommand for why that changed).
  const { waitUntilExit } = render(
    <App
      session={initialSession}
      setup={setup}
      version={PACKAGE_VERSION}
      cwd={process.cwd()}
      runShellCommand={runShellCommand}
    />,
  );
  try {
    await waitUntilExit();
  } finally {
    if (pendingFinish) {
      // A rejected finish() (e.g. a bad model id) already means no runtime was ever built --
      // nothing to clean up, so swallow the rejection here rather than letting it mask whatever
      // waitUntilExit() itself resolved with.
      runtime = await pendingFinish.catch(() => undefined);
    }
    await runtime?.cleanup();
  }
}

main().catch((error) => {
  if (error instanceof TrustDeniedError) {
    console.error(`Not trusted: ${error.dirPath}. Nothing was executed.`);
    process.exitCode = 1;
    return;
  }
  console.error(error instanceof Error ? (error.stack ?? error.message) : String(error));
  process.exitCode = 1;
});
