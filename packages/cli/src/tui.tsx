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
  loginWithOAuth,
  type OAuthLoginHandlers,
  type Session,
  saveApiKey,
  TrustStore,
} from "@nanocode/agent";
import { resolveModel, writeStoredModelSelection } from "@nanocode/ai";
import {
  App,
  MOUSE_DISABLE_SEQUENCE,
  MOUSE_ENABLE_SEQUENCE,
  type ModelSetupController,
  type SlashCommandController,
  wrapStdinForMouse,
} from "@nanocode/tui";
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
  copyToClipboard,
  createModelsContext,
  editViaExternalEditor,
  exportTranscript,
  listRecentSessions,
  loadSessionMessages,
  type NanocodeSetup,
  openUrl,
  readClipboardImage,
  readClipboardText,
  readDroppedFile,
  runShellCommand,
  switchModel,
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

/** Tracks whether the alternate screen buffer is currently active, so `exitFullscreen` (called from
 * both the normal `finally` path in `main()` AND the `process.on("exit", ...)` safety net below)
 * never writes the leave-sequence twice, and `enterFullscreen` never enters twice either. A module-
 * level flag, not component state -- this has to survive and be reachable from a plain `process`
 * event handler, entirely outside Ink/React's own lifecycle. */
let fullscreenActive = false;

function enterFullscreen(): void {
  // No-op for piped/redirected output (matching every other TTY-gated behavior in this rendering
  // path, e.g. Ink's own `isFullscreen` detection) -- there is no "screen" to take over, and
  // writing raw terminal escape sequences into a non-TTY stream would just corrupt whatever is
  // reading it.
  if (!process.stdout.isTTY || fullscreenActive) return;
  // Mouse reporting enabled in the SAME write as the alt-screen entry (see mouse.ts's own comment
  // on why: a scroll wheel does nothing useful against the alt-screen's own, nonexistent scrollback,
  // so nanocode has to capture and act on wheel events itself instead, the same way vim/less/htop --
  // and, per the user's own explicit ask, Claude Code -- already do).
  process.stdout.write(`\x1b[?1049h${MOUSE_ENABLE_SEQUENCE}`);
  fullscreenActive = true;
}

function exitFullscreen(): void {
  if (!fullscreenActive) return;
  // Mouse reporting disabled BEFORE leaving the alt screen -- otherwise the user's real terminal
  // keeps intercepting scroll/clicks for mouse reporting after nanocode exits, breaking normal text
  // selection and scrollback in their shell.
  process.stdout.write(`${MOUSE_DISABLE_SEQUENCE}\x1b[?1049l`);
  fullscreenActive = false;
}

// Belt-and-suspenders safety net: `process.on("exit", ...)` handlers run synchronously even when
// the process is exiting because of an uncaught exception or an explicit `process.exit()` call
// that bypasses `main()`'s own `try`/`finally` below entirely -- without this, a crash while
// fullscreen was active would leave the user's real terminal stuck showing nanocode's last frame
// with no way back to their own shell except manually sending the escape sequence themselves.
// (A hard `SIGKILL` can still bypass even this, same as any other cleanup handler anywhere --
// nothing in Node can intercept that one, by design.)
process.on("exit", exitFullscreen);

async function main(): Promise<void> {
  // Trust gating is unchanged by onboarding: it still runs before anything else, as a plain
  // pre-Ink prompt, exactly as it did before this change -- onboarding only ever affects the
  // *model* configuration step, never the trust boundary.
  const trustStore = await TrustStore.open();
  await ensureTrust(trustStore, process.cwd());

  const { models, credentials } = createModelsContext();
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
    loginOAuth: (providerId, handlers: OAuthLoginHandlers) =>
      loginWithOAuth(models, providerId, handlers),
    openUrl,
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

  // Unlike `setup` above, every one of these DOES close over `runtime` -- "/model" mutates its
  // session in place, "/new" tears it down and replaces it entirely. `switchModel`/`startNewSession`
  // throw if called before any runtime exists, which can't actually happen: packages/tui only ever
  // renders the running-session tree (the only place these are invoked from) once `session` is set,
  // and `runtime` is always assigned before that -- either synchronously above, or inside
  // `setup.finish()`'s `.then()`, which resolves before `onReady()` fires.
  const slashCommands: SlashCommandController = {
    listProviders: () => listProviderOptions(models),
    listModels: (providerId) => listModelOptions(models, providerId),
    login: (providerId, apiKey) => saveApiKey(models, providerId, apiKey),
    loginOAuth: (providerId, handlers: OAuthLoginHandlers) =>
      loginWithOAuth(models, providerId, handlers),
    openUrl,
    logout: (providerId) => credentials.delete(providerId),
    switchModel: (providerId, modelId) => {
      if (!runtime) throw new Error("no active session");
      return switchModel(runtime.session, models, providerId, modelId);
    },
    startNewSession: async () => {
      if (!runtime) throw new Error("no active session");
      const model = runtime.session.state.model;
      await runtime.cleanup();
      runtime = await buildRuntimeForModel(model, models);
      // The runtime this replaces is already fully torn down and gone -- if it came from
      // onboarding, `pendingFinish` would otherwise still resolve to that stale object once
      // `main()`'s own `finally` block awaits it on exit, clobbering `runtime` right back to
      // the already-cleaned-up one and skipping the real (current) runtime's own cleanup.
      pendingFinish = undefined;
      return runtime.session;
    },
    listRecentSessions,
    loadSessionMessages,
    copyToClipboard,
    exportTranscript,
  };

  // Real alternate-screen-buffer fullscreen mode (matching Claude Code's own separate "fullscreen
  // renderer," confirmed as a genuinely distinct feature by inspecting its installed binary, not
  // something invented for nanocode) -- superseding an earlier, narrower fix here that only
  // cleared the visible screen before rendering. That fix addressed the SAME root problem this one
  // does more completely: Ink starts rendering from wherever the cursor already sits, which is
  // never actually the terminal's top-left in a real shell (the prompt line, the typed launch
  // command, etc. already used some rows) -- filling a full-height layout from there overflowed
  // the visible screen and scrolled the banner off the top. Entering the alternate screen buffer
  // (`\x1b[?1049h`, the same escape sequence vim/htop/less use) hands the WHOLE terminal a fresh,
  // separate, guaranteed-blank buffer to render into regardless of what was on the main buffer
  // beforehand, so there is no "how many rows were already used" question left to get wrong.
  // Leaving it (`\x1b[?1049l`) restores the user's original screen and scrollback completely
  // untouched, as if nanocode was never there. `enterFullscreen`/`exitFullscreen` are idempotent
  // and guarded by `fullscreenActive` so an unexpected double-call (e.g. the `finally` block below
  // AND the `process.on("exit", ...)` safety net both firing) never double-writes either sequence.
  enterFullscreen();

  // Passed straight through -- runShellCommand/editViaExternalEditor/readClipboard*/readDroppedFile
  // are all plain host functions with no `runtime`/session state of their own to close over (an
  // earlier version of runShellCommand routed bang commands through the kernel instead and needed
  // one; see setup.ts's own comment on why that changed).
  //
  // exitOnCtrlC: false -- app.tsx's RunningSession hand-rolls ctrl+c/ctrl+d itself (pi's own
  // stateful scheme: ctrl+c clears the prompt box, twice in a row exits; ctrl+d exits only when
  // already empty), so Ink's own default instant-exit-on-ctrl+c must be disabled here or it would
  // race app.tsx's handler and always win (Ink's own internal handling runs before any `useInput`
  // callback ever sees the keystroke).
  // Wrapping stdin to strip/act on mouse-wheel byte sequences only makes sense against a real TTY
  // (mouse.ts's own proxy calls `setRawMode`/`ref`/`unref`, which a piped/redirected stdin doesn't
  // have) -- a non-TTY stdin is passed through to Ink untouched, exactly like before this feature.
  const stdin = process.stdin.isTTY
    ? (wrapStdinForMouse(process.stdin) as unknown as NodeJS.ReadStream)
    : process.stdin;
  const { waitUntilExit } = render(
    <App
      session={initialSession}
      setup={setup}
      version={PACKAGE_VERSION}
      cwd={process.cwd()}
      runShellCommand={runShellCommand}
      slashCommands={slashCommands}
      spawnEditor={editViaExternalEditor}
      readClipboardImage={readClipboardImage}
      readClipboardText={readClipboardText}
      readDroppedFile={readDroppedFile}
    />,
    { exitOnCtrlC: false, stdin },
  );
  try {
    await waitUntilExit();
  } finally {
    // Leave the alternate screen FIRST, before any cleanup work below -- restores the user's real
    // terminal immediately on exit rather than leaving them staring at nanocode's last frame while
    // runtime teardown (which can take a moment, e.g. a Docker-sandboxed kernel shutting down)
    // still runs in the background.
    exitFullscreen();
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
