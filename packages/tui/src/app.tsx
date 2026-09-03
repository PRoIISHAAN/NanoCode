// Root TUI component. Holds a direct `Session` reference (the user's explicit choice over
// introducing an AgentConnection seam at this milestone -- see the M5 design round) and subscribes
// to its AgentEvent stream directly, the same event bus packages/cli's headless mode also consumes.
// Ctrl+C/ctrl+d are hand-rolled here (RunningSession's own `useInput`), matching pi's own stateful
// exit semantics (ctrl+c clears the prompt box, twice in a row exits; ctrl+d exits only when it's
// already empty) -- `tui.tsx` passes `exitOnCtrlC: false` to Ink's `render()` so Ink's own default
// instant-exit-on-ctrl+c never fires first and races this.
//
// State lives in atoms (atom.ts), not a pile of useState in this one component: `App` itself reads
// no atom values and therefore never re-renders after mount (its `session` prop never changes in
// current usage), and each piece of UI that DOES need live state is its own small component calling
// `useAtom` on only the one atom it cares about. A keystroke in the prompt box only re-renders
// `PromptInput`; a streaming token delta only re-renders `TranscriptView` -- not the whole tree, per
// decisions/0005-tui-stack.md's fine-grained-atoms requirement (an earlier version of this file used
// one flat `useState` per field at the root, which technically used atoms.ts but never actually
// wired them in, so every keystroke re-rendered everything including the virtualized transcript --
// caught by an L4 review before this milestone shipped).
import type { AgentEvent, AgentMessage, Session } from "@nanocode/agent";
import { Box, Text, useApp, useInput } from "ink";
// Explicit React import: proven necessary by direct A/B testing against the real `npm run tui`
// entrypoint (removing it reproduces "ReferenceError: React is not defined" here, even with
// packages/tui's own local tsconfig.json in place) -- see tui.tsx's longer comment on the likely
// cause (tsx/esbuild's JSX-transform config resolution for the whole reachable dependency graph,
// not cleanly per file, once the graph is as large as this app's real one).
// biome-ignore lint/correctness/noUnusedImports: required by tsx's runtime JSX transform, not referenced directly in this file's own code
import React, { useEffect, useMemo, useRef, useState } from "react";
import { type Atom, atom, useAtom } from "./atom.ts";
import { createBackpressureQueue } from "./backpressure.ts";
import { StartupBanner } from "./banner.tsx";
import { CommandMenu } from "./command-menu.tsx";
import { CommandOverlay, type CommandOverlayKind, type OverlayResult } from "./command-overlay.tsx";
import { type ModelSetupController, SetupScreen } from "./setup-screen.tsx";
import {
  deriveCommandMenu,
  helpText,
  parseSlashCommand,
  resolveCommandName,
  type SlashCommandController,
  THINKING_LEVELS,
} from "./slash-commands.ts";
import { HorizontalRule, StatusBar } from "./status-bar.tsx";
import { Transcript, textOf } from "./transcript.tsx";

export type { ModelSetupController } from "./setup-screen.tsx";
export type { SessionSummary, SlashCommandController } from "./slash-commands.ts";

/** Runs a "!command" bash escape -- packages/cli/src/setup.ts implements this by spawning a real
 * host shell process directly (like pi's own "!"; pi has no persistent kernel to route through at
 * all), passed in as a plain function so packages/tui never has to import @nanocode/kernel or
 * @nanocode/ai directly (context-graph.json's tui_isolation invariant). */
export type RunShellCommand = (command: string) => Promise<{ output: string; isError: boolean }>;

/** Ctrl+g's bridge -- packages/cli/src/setup.ts's `editViaExternalEditor` spawns `$VISUAL`/
 * `$EDITOR` against a temp file seeded with `initialText` and resolves with whatever text is left
 * once it exits. The caller (`PromptInput`) wraps the call in Ink's own `useApp().suspendTerminal()`
 * so the editor gets a terminal that isn't fighting Ink's raw-mode stdin for the same keystrokes --
 * this plain function has no terminal-mode concerns of its own. */
export type SpawnEditor = (initialText: string) => Promise<string>;

/** Ctrl+v's bridge -- packages/cli/src/setup.ts's `readClipboardImage`/`readClipboardText`. Both
 * resolve `undefined` (never throw) for "nothing there," which the caller falls back through:
 * image first, then plain text, matching pi's own "paste image (with text fallback)". */
export type ReadClipboardImage = () => Promise<{ base64: string; mediaType: string } | undefined>;
export type ReadClipboardText = () => Promise<string | undefined>;

/** "drop a file to attach" -- packages/cli/src/setup.ts's `readDroppedFile`. Resolves `undefined`
 * (never throws) for "not a real existing file," which the caller (`PromptInput`) treats exactly
 * like any other normal prompt text. */
export type ReadDroppedFile = (
  candidatePath: string,
) => Promise<
  | { kind: "image"; base64: string; mediaType: string; path: string }
  | { kind: "text"; content: string; path: string }
  | undefined
>;

export interface AppProps {
  /** Undefined on an unconfigured launch (decisions/0011-tui-onboarding.md) -- App shows
   * `SetupScreen` instead of the running session tree until `setup.finish()` resolves one. */
  session: Session | undefined;
  setup: ModelSetupController;
  /** nanocode's own package version, for the startup banner. */
  version: string;
  /** The process's working directory, for the status bar -- passed in rather than read via
   * `process.cwd()` here so this component stays trivially testable with an arbitrary value. */
  cwd: string;
  runShellCommand: RunShellCommand;
  slashCommands: SlashCommandController;
  spawnEditor: SpawnEditor;
  readClipboardImage: ReadClipboardImage;
  readClipboardText: ReadClipboardText;
  readDroppedFile: ReadDroppedFile;
}

/** What "/model", "/login", "/effort" (no argument), or "/resume" opens -- the argument, if any,
 * came from the typed command line (e.g. "/login anthropic" -> `arg: "anthropic"`) and lets
 * `CommandOverlay` skip its first picker step. */
interface OverlayState {
  kind: CommandOverlayKind;
  arg?: string;
}

interface SessionAtoms {
  messages: Atom<AgentMessage[]>;
  /** "!command" and "/command" entries -- a synthetic user message plus a synthetic toolResult,
   * appended here rather than sent to the model at all. Kept separate from `messages` (not pushed
   * into `session.state.messages`) rather than merged permanently into session history: both are
   * local terminal conveniences, the same as pi's own "!" (or IPython's, which this project's
   * kernel already inherits the persistent-REPL feel from) -- not something the model said or
   * needs in its own context. `TranscriptView` merges this with `messages` by timestamp purely for
   * display. */
  localEntries: Atom<AgentMessage[]>;
  streamingText: Atom<string | undefined>;
  busy: Atom<boolean>;
  error: Atom<string | undefined>;
  /** Ctrl+O toggles this -- false (the default) collapses multi-line tool-result messages in the
   * transcript to their first line. */
  toolOutputExpanded: Atom<boolean>;
  /** Ctrl+T toggles this -- false (the default) collapses each "thinking" content block in the
   * transcript to a one-line placeholder. */
  thinkingExpanded: Atom<boolean>;
  /** Which "/command" picker overlay (if any) currently owns the keyboard instead of PromptInput. */
  overlay: Atom<OverlayState | undefined>;
  /** Bumped after "/model" or "/effort" mutates `session.state.model`/`.thinkingLevel` directly --
   * those are plain fields (see session/compaction.ts's own comment on why), so nothing else
   * naturally re-renders StatusLine when they change; this atom exists purely to trigger that
   * re-render, its own numeric value is never read for anything else. */
  sessionVersion: Atom<number>;
  /** Seeded from a process-wide counter (never a fixed `0`, see `createSessionAtoms`) and bumped
   * only by "/resume" (session.state.messages wholesale-replaced with a DIFFERENT past conversation's
   * history, not appended to) -- used as `<Transcript>`'s React `key` so it fully remounts instead of
   * continuing to grow the same `<Static>` instance. `<Static>` (transcript.tsx) only ever tracks how
   * many items it has already permanently printed, by count, not by content -- swapping in an
   * unrelated history under the same instance would make it treat that new conversation's own
   * earlier messages as "already printed" (since some prefix of the new array happens to be as long
   * as what was already frozen) and silently never print them at all. A fresh `<Transcript>` instance
   * starts `<Static>`'s count back at zero, so the newly resumed (or newly started -- see "/new",
   * which builds a whole new `SessionAtoms` bag with a freshly seeded generation of its own) history
   * reprints from the top -- exactly like actually switching files in a real terminal tool. */
  historyGeneration: Atom<number>;
  /** The prompt box's own typed-but-not-yet-submitted text -- promoted from a plain `PromptInput`-
   * local `useState` (which is otherwise the right default for text nothing else needs) specifically
   * so `CommandMenu`, a sibling rendered by `RunningSession` rather than a child of `PromptInput`
   * itself (to land it in the same on-screen position pi's own "/" menu occupies -- below the
   * prompt box's closing rule, not inside it), can read it live to decide what to show. */
  promptText: Atom<string>;
  /** Which entry in the live "/" autocomplete menu is highlighted -- see `deriveCommandMenu`
   * (slash-commands.ts), which clamps this to a valid index given the current `promptText` and
   * `matchCommands` result, so this can go briefly stale (e.g. right after a keystroke shrinks the
   * match list) without ever causing an out-of-bounds read. */
  commandMenuHighlight: Atom<number>;
}

// A single counter shared across every `createSessionAtoms` call in the process, not per-call --
// `historyGeneration` must be globally unique across DIFFERENT sessions too (not just across
// "/resume" bumps within one), or switching sessions (e.g. "/new") wouldn't reliably change
// <Transcript>'s React `key`: seeding every session's own atom at a fixed `0` meant a brand-new
// session's freshly-created `historyGeneration` (also `0`) matched the very session being replaced,
// so <Transcript> never remounted and the OLD session's already-frozen `<Static>` content (real
// terminal writes, not app state) kept showing under the new one -- caught by the "/new swaps in a
// brand-new session" test, which asserts the old session's own messages are gone from the frame.
let nextHistoryGeneration = 0;

function createSessionAtoms(session: Session): SessionAtoms {
  return {
    messages: atom(session.state.messages.slice()),
    localEntries: atom<AgentMessage[]>([]),
    streamingText: atom<string | undefined>(undefined),
    busy: atom(false),
    error: atom<string | undefined>(undefined),
    toolOutputExpanded: atom(false),
    // Visible by default, matching pi's own thinking toggle -- ctrl+t hides it, not the other way
    // around (decisions/0014-header-menu-and-editing.md's pi-parity follow-up).
    thinkingExpanded: atom(true),
    overlay: atom<OverlayState | undefined>(undefined),
    sessionVersion: atom(0),
    historyGeneration: atom(++nextHistoryGeneration),
    promptText: atom(""),
    commandMenuHighlight: atom(0),
  };
}

export function App({
  session: initialSession,
  setup,
  version,
  cwd,
  runShellCommand,
  slashCommands,
  spawnEditor,
  readClipboardImage,
  readClipboardText,
  readDroppedFile,
}: AppProps) {
  // Starts undefined on an unconfigured launch; SetupScreen's onReady sets it once setup.finish()
  // hands back a fully-built Session. `useMemo` with an empty dependency array (not a lazy
  // useState initializer) is deliberate here too: App itself is only ever mounted once per process
  // (tui.tsx renders it exactly once), so there is no "identity changed" case to react to -- this
  // atom just needs to exist for the lifetime of the component. It's also how "/new" swaps in a
  // brand new Session mid-run, via the same `replaceSession` setter RunningSession is handed below.
  // biome-ignore lint/correctness/useExhaustiveDependencies: intentionally created once, see above
  const sessionAtom = useMemo(() => atom<Session | undefined>(initialSession), []);
  const session = useAtom(sessionAtom);

  return (
    <Box flexDirection="column">
      {session ? (
        <RunningSession
          session={session}
          version={version}
          cwd={cwd}
          runShellCommand={runShellCommand}
          slashCommands={slashCommands}
          replaceSession={(next) => sessionAtom.set(next)}
          spawnEditor={spawnEditor}
          readClipboardImage={readClipboardImage}
          readClipboardText={readClipboardText}
          readDroppedFile={readDroppedFile}
        />
      ) : (
        <>
          <StartupBanner version={version} />
          <SetupScreen setup={setup} onReady={(ready) => sessionAtom.set(ready)} />
        </>
      )}
    </Box>
  );
}

interface UsageSummary {
  totalInputTokens: number;
  totalOutputTokens: number;
  /** The most recent assistant message's own input-token count, not a running sum -- an
   * approximation of how much of the context window the *next* request will actually carry
   * (post-compaction, if any already ran), for the status bar's "% of context window" figure. */
  contextTokens: number;
  totalCostUsd: number;
}

/** Sums every assistant message's usage so far -- the status bar's running token/cost totals. */
function sumUsage(messages: readonly AgentMessage[]): UsageSummary {
  let totalInputTokens = 0;
  let totalOutputTokens = 0;
  let contextTokens = 0;
  let totalCostUsd = 0;
  for (const message of messages) {
    if ((message as { role: string }).role !== "assistant") continue;
    const usage = (
      message as { usage?: { input?: number; output?: number; cost?: { total?: number } } }
    ).usage;
    totalInputTokens += usage?.input ?? 0;
    totalOutputTokens += usage?.output ?? 0;
    contextTokens = usage?.input ?? contextTokens; // last assistant message wins, not a sum
    totalCostUsd += usage?.cost?.total ?? 0;
  }
  return { totalInputTokens, totalOutputTokens, contextTokens, totalCostUsd };
}

/** "thinking..." until the in-flight assistant message has produced any real text, "responding…"
 * once it has -- a FIXED string either way (see this function's one call site, in the
 * "message_update" handler, for why growing text was tried here before and rejected). Duck-typed
 * off the message's own content array, matching this file's usual style for reading AgentMessage
 * fields without importing @nanocode/ai's own content-block types (context-graph.json's
 * tui_isolation invariant). */
function streamingStatusFor(message: AgentMessage): string {
  const content = (message as { content: unknown }).content;
  const hasText =
    Array.isArray(content) &&
    content.some(
      (block) => (block as { type?: string }).type === "text" && (block as { text?: string }).text,
    );
  return hasText ? "responding…" : "thinking...";
}

function RunningSession({
  session,
  version,
  cwd,
  runShellCommand,
  slashCommands,
  replaceSession,
  spawnEditor,
  readClipboardImage,
  readClipboardText,
  readDroppedFile,
}: {
  session: Session;
  version: string;
  cwd: string;
  runShellCommand: RunShellCommand;
  slashCommands: SlashCommandController;
  replaceSession: (session: Session) => void;
  spawnEditor: SpawnEditor;
  readClipboardImage: ReadClipboardImage;
  readClipboardText: ReadClipboardText;
  readDroppedFile: ReadDroppedFile;
}) {
  // Recreated only when `session` identity changes, via useMemo's dependency array -- not a lazy
  // useState initializer, which React only ever runs once on mount regardless of later prop
  // changes. Fixes a latent bug an L4 review found: if this component were ever reused across
  // sessions, a lazy-useState version would keep showing the OLD session's stale messages/state
  // forever -- relevant here specifically because a session now really can change identity, from
  // undefined to a real Session, once setup completes.
  const atoms = useMemo(() => createSessionAtoms(session), [session]);

  useEffect(() => {
    // Rapid message_update deltas during streaming are coalesced to ~30fps -- see backpressure.ts
    // -- rather than triggering a React state update (and Ink re-render) on every single token.
    const streamQueue = createBackpressureQueue<string>((text) => atoms.streamingText.set(text));

    const unsubscribe = session.subscribe((event: AgentEvent) => {
      switch (event.type) {
        case "message_update":
          // A FIXED status string, not the message's own growing text -- pushing the real, ever-
          // longer partial text here (an earlier version did, then tried bounding its rendered
          // height in transcript.tsx) still left a real, user-visible one-time "grows to the
          // bounded cap, then stops" shift right as a response starts, which is still scrolling by
          // the time a human actually sees it. A fixed string's height never changes at all, for
          // the entire turn, matching how the tool_execution_start branch below already behaves.
          // The real, complete text is never hidden for long: it settles into the transcript in
          // full the moment the turn ends (message_end), unaffected by this.
          if (event.message.role === "assistant")
            streamQueue.push(streamingStatusFor(event.message));
          return;
        case "message_end":
          atoms.messages.set(session.state.messages.slice());
          if (event.message.role === "assistant") {
            // Cancel any flush the backpressure queue still has pending before overwriting its
            // target directly -- an L4-caught-live bug: without this, a message_update pushed
            // just before this message_end can still flush ~33ms later (backpressure.ts's
            // coalescing window), resurrecting stale streaming text for a message that has
            // already settled into `messages`, and rendering it a second time underneath the
            // real one.
            streamQueue.dispose();
            atoms.streamingText.set(undefined);
          }
          return;
        case "tool_execution_start":
          streamQueue.dispose(); // same reasoning as message_end above
          atoms.streamingText.set(`[running ${event.toolName}…]`);
          return;
        case "agent_end":
          streamQueue.dispose(); // same reasoning as message_end above
          atoms.busy.set(false);
          atoms.streamingText.set(undefined);
          return;
        default:
          return;
      }
    });

    return () => {
      streamQueue.dispose();
      unsubscribe();
    };
  }, [session, atoms]);

  // `useApp()` is Ink's own context (from the real `render()` call in tui.tsx, which always wraps
  // whatever tree it's given in Ink's internal `<App>`) -- available here regardless of how deep
  // RunningSession sits under that root, no prop threading needed for it specifically.
  const { exit, suspendTerminal } = useApp();
  // Tracks whether the last ctrl+c (on an already-empty prompt box) is still within the
  // "press again to exit" window -- a plain ref, not an atom: nothing else in the tree ever reads
  // this value, only this one `useInput` closure across repeated calls.
  const exitArmedRef = useRef(false);
  const exitArmTimeoutRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const EXIT_ARM_WINDOW_MS = 1500;

  useInput((input, key) => {
    if (key.ctrl && input === "o") {
      // Used to also toggle a live-expanding header (matching pi's own ctrl+o, which expands both
      // at once) -- dropped once the banner became permanent, unretractable scrollback (see
      // banner.tsx's own header comment): a frozen banner can't be retroactively expanded, so ctrl+o
      // now only ever affects tool output. Every keybinding now lives in "/help" instead.
      atoms.toolOutputExpanded.set(!atoms.toolOutputExpanded.get());
      return;
    }
    if (key.ctrl && input === "t") {
      const next = !atoms.thinkingExpanded.get();
      atoms.thinkingExpanded.set(next);
      // pi shows its own transient "Thinking blocks: hidden"/"visible" line on this same toggle
      // (captured live, see decisions/0014-header-menu-and-editing.md's pi-parity follow-up) --
      // matched here in substance, with a trailing period for consistency with this file's other
      // confirmation messages (shift+tab's "Reasoning effort set to ..." etc.).
      pushLocalEntry(undefined, `Thinking blocks: ${next ? "visible" : "hidden"}.`);
      return;
    }
    if (key.ctrl && input === "z") {
      // No SIGTSTP on Windows -- there's no equivalent "suspend to shell" gesture there, so this
      // is silently a no-op rather than a confusing crash.
      if (process.platform === "win32") return;
      // `suspendTerminal` (Ink 7's own API) releases Ink's raw-mode stdin for the duration of the
      // callback and forces a full redraw once it resolves -- the same mechanism ctrl+g's external
      // editor uses below, just with "stop the whole process and wait for the shell's `fg`" as the
      // callback instead of "run a child process." Actually suspending via SIGTSTP happens INSIDE
      // the callback so Ink has already relinquished the terminal before the process stops.
      void suspendTerminal(
        () =>
          new Promise<void>((resolve) => {
            process.once("SIGCONT", () => resolve());
            process.kill(process.pid, "SIGTSTP");
          }),
      );
      return;
    }
    if (key.ctrl && (input === "c" || input === "d")) {
      const isCtrlD = input === "d";
      const current = atoms.promptText.get();
      if (current.length > 0) {
        // Ctrl+d only ever acts when the box is already empty (matching pi); with real text
        // typed, it's simply not handled here at all.
        if (isCtrlD) return;
        // Ctrl+c with real text typed: clear the line, same as most shells' own ctrl+c -- doesn't
        // arm the double-press-to-exit state, since the user is clearly still composing something.
        atoms.promptText.set("");
        atoms.commandMenuHighlight.set(0);
        atoms.error.set(undefined);
        exitArmedRef.current = false;
        return;
      }
      // The box is already empty: ctrl+d always exits; ctrl+c exits only on the SECOND press
      // within EXIT_ARM_WINDOW_MS of the first (matching pi's own scheme).
      if (isCtrlD || exitArmedRef.current) {
        exit();
        return;
      }
      exitArmedRef.current = true;
      atoms.error.set("Press ctrl+c again to exit.");
      clearTimeout(exitArmTimeoutRef.current);
      exitArmTimeoutRef.current = setTimeout(() => {
        exitArmedRef.current = false;
        // Only clear the hint if it's still showing -- something else may have set a real error
        // in the meantime, which this must not clobber.
        if (atoms.error.get() === "Press ctrl+c again to exit.") atoms.error.set(undefined);
      }, EXIT_ARM_WINDOW_MS);
    }
  });

  const overlay = useAtom(atoms.overlay);

  const pushLocalEntry = (rawCommandText: string | undefined, text: string, isError = false) => {
    atoms.localEntries.set([
      ...atoms.localEntries.get(),
      ...buildCommandResultEntries(rawCommandText, text, isError),
    ]);
  };

  const handleOverlayDone = (result: OverlayResult) => {
    atoms.overlay.set(undefined);
    if (result.kind === "message") {
      pushLocalEntry(undefined, result.text);
      return;
    }
    if (result.kind === "effort") {
      session.state.thinkingLevel = result.level as Session["state"]["thinkingLevel"];
      atoms.sessionVersion.set(atoms.sessionVersion.get() + 1);
      pushLocalEntry(undefined, `Reasoning effort set to ${result.level}.`);
      return;
    }
    // result.kind === "resume"
    session.state.messages = result.messages;
    atoms.messages.set(session.state.messages.slice());
    // Forces <Transcript> to remount (see historyGeneration's own comment) -- this is a DIFFERENT
    // conversation's history replacing the current one, not new messages appended to it.
    atoms.historyGeneration.set(atoms.historyGeneration.get() + 1);
    pushLocalEntry(
      undefined,
      `Resumed "${result.summary.title}" (${result.summary.messageCount} messages). Note: ` +
        "the Python kernel's own in-process state is NOT restored, only the conversation.",
    );
  };

  return (
    <Box flexDirection="column">
      <TranscriptView
        messagesAtom={atoms.messages}
        localEntriesAtom={atoms.localEntries}
        streamingTextAtom={atoms.streamingText}
        toolOutputExpandedAtom={atoms.toolOutputExpanded}
        thinkingExpandedAtom={atoms.thinkingExpanded}
        historyGenerationAtom={atoms.historyGeneration}
        version={version}
      />
      <ErrorLine errorAtom={atoms.error} />
      <HorizontalRule />
      {overlay ? (
        <CommandOverlay
          kind={overlay.kind}
          arg={overlay.arg}
          controller={slashCommands}
          onDone={handleOverlayDone}
          onCancel={() => atoms.overlay.set(undefined)}
        />
      ) : (
        <PromptInput
          session={session}
          cwd={cwd}
          busyAtom={atoms.busy}
          errorAtom={atoms.error}
          localEntriesAtom={atoms.localEntries}
          messagesAtom={atoms.messages}
          overlayAtom={atoms.overlay}
          sessionVersionAtom={atoms.sessionVersion}
          promptTextAtom={atoms.promptText}
          commandMenuHighlightAtom={atoms.commandMenuHighlight}
          runShellCommand={runShellCommand}
          slashCommands={slashCommands}
          replaceSession={replaceSession}
          spawnEditor={spawnEditor}
          readClipboardImage={readClipboardImage}
          readClipboardText={readClipboardText}
          readDroppedFile={readDroppedFile}
        />
      )}
      <HorizontalRule />
      {/* Below the prompt box's closing rule, same on-screen position as pi's own "/" menu -- a
       * dedicated leaf component (not inline here) specifically so re-rendering it on every single
       * keystroke -- unavoidable, since it has to track live-typed text -- never cascades into
       * RunningSession's own re-render and, with it, TranscriptView/ErrorLine/StatusLine, the same
       * fine-grained-atoms reasoning this file's header comment already states. No `overlay` gate
       * needed: `PromptInput` always clears `promptTextAtom` before ever opening an overlay (see
       * handleSubmit), so this naturally renders nothing while one is up. */}
      <CommandMenuView
        promptTextAtom={atoms.promptText}
        commandMenuHighlightAtom={atoms.commandMenuHighlight}
      />
      <StatusLine
        session={session}
        cwd={cwd}
        messagesAtom={atoms.messages}
        sessionVersionAtom={atoms.sessionVersion}
      />
    </Box>
  );
}

function messageTimestamp(message: AgentMessage): number {
  return (message as { timestamp?: number }).timestamp ?? 0;
}

function TranscriptView({
  messagesAtom,
  localEntriesAtom,
  streamingTextAtom,
  toolOutputExpandedAtom,
  thinkingExpandedAtom,
  historyGenerationAtom,
  version,
}: {
  messagesAtom: Atom<AgentMessage[]>;
  localEntriesAtom: Atom<AgentMessage[]>;
  streamingTextAtom: Atom<string | undefined>;
  toolOutputExpandedAtom: Atom<boolean>;
  thinkingExpandedAtom: Atom<boolean>;
  historyGenerationAtom: Atom<number>;
  version: string;
}) {
  const messages = useAtom(messagesAtom);
  const localEntries = useAtom(localEntriesAtom);
  const streamingText = useAtom(streamingTextAtom);
  const toolOutputExpanded = useAtom(toolOutputExpandedAtom);
  const thinkingExpanded = useAtom(thinkingExpandedAtom);
  const historyGeneration = useAtom(historyGenerationAtom);
  // Merged purely for display, by when each thing actually happened -- real conversation messages
  // and "!command" entries are never combined into one array anywhere else (session.state.messages
  // never sees the local ones at all, see SessionAtoms.localEntries's own comment).
  const merged = useMemo(
    () => [...messages, ...localEntries].sort((a, b) => messageTimestamp(a) - messageTimestamp(b)),
    [messages, localEntries],
  );
  return (
    <Transcript
      // Forces a full remount on "/resume" -- see SessionAtoms.historyGeneration's own comment on
      // why <Transcript>'s internal <Static> can't just keep growing across a wholesale history
      // swap.
      key={historyGeneration}
      messages={merged}
      streamingText={streamingText}
      toolOutputExpanded={toolOutputExpanded}
      thinkingExpanded={thinkingExpanded}
      // Settles into the SAME <Static> as every message, ahead of all of them -- see
      // TranscriptProps.leadingStatic's own comment on why the banner can't have its own separate
      // <Static> instead.
      leadingStatic={<StartupBanner version={version} />}
    />
  );
}

function StatusLine({
  session,
  cwd,
  messagesAtom,
  sessionVersionAtom,
}: {
  session: Session;
  cwd: string;
  messagesAtom: Atom<AgentMessage[]>;
  sessionVersionAtom: Atom<number>;
}) {
  const messages = useAtom(messagesAtom);
  // Read purely to subscribe -- "/model"/"/effort" mutate `session.state` directly (see
  // SessionAtoms.sessionVersion's own comment), and this is the only thing that makes that
  // mutation actually show up here without a real message/event to re-render off of.
  useAtom(sessionVersionAtom);
  const { totalInputTokens, totalOutputTokens, contextTokens, totalCostUsd } = sumUsage(messages);
  // `session.state.model`/`.thinkingLevel` are read as plain values here, not imported as types --
  // packages/tui never imports @nanocode/ai (context-graph.json's tui_isolation invariant), it
  // just reads fields off an object whose type already flows in through Session (from
  // @nanocode/agent).
  const model = session.state.model as { provider?: string; id?: string; contextWindow?: number };
  const modelLabel = `${model.provider ?? "?"}/${model.id ?? "?"}`;
  return (
    <StatusBar
      cwd={cwd}
      modelLabel={modelLabel}
      reasoningLevel={session.state.thinkingLevel}
      totalInputTokens={totalInputTokens}
      totalOutputTokens={totalOutputTokens}
      contextTokens={contextTokens}
      contextWindow={model.contextWindow ?? 0}
      totalCostUsd={totalCostUsd}
    />
  );
}

function ErrorLine({ errorAtom }: { errorAtom: Atom<string | undefined> }) {
  const error = useAtom(errorAtom);
  if (!error) return null;
  return <Text color="red">{error}</Text>;
}

/** Builds the synthetic {user, toolResult} pair a "!command" produces for display -- shaped like a
 * real toolCall round-trip (role "toolResult", a toolName) but with no real toolCall block behind
 * it, so transcript.tsx's `buildStandaloneToolItem` renders it as its own tool cell directly; `code`
 * on `details` is where it reads the command text back from (a synthetic entry has no toolCall
 * block to read `arguments.code` off of the way a real ipython call does). */
function buildBangCommandEntries(
  command: string,
  result: { output: string; isError: boolean },
): [AgentMessage, AgentMessage] {
  const userEntry = {
    role: "user",
    content: [{ type: "text", text: `!${command}` }],
    timestamp: Date.now(),
  } as AgentMessage;
  const resultEntry = {
    role: "toolResult",
    toolCallId: `shell-${Date.now()}`,
    toolName: "shell",
    content: [{ type: "text", text: result.output }],
    details: { code: command },
    isError: result.isError,
    timestamp: Date.now(),
  } as AgentMessage;
  return [userEntry, resultEntry];
}

/** Builds the synthetic {user, toolResult} pair a "/command" produces for display -- same shape
 * and same reasoning as `buildBangCommandEntries` above. `rawCommandText` is omitted (only the
 * result entry is returned) when the command already showed its own interactive UI
 * (`CommandOverlay`), so the transcript doesn't redundantly echo an input line nobody typed as one
 * literal string. */
function buildCommandResultEntries(
  rawCommandText: string | undefined,
  text: string,
  isError = false,
): AgentMessage[] {
  const resultEntry = {
    role: "toolResult",
    toolCallId: `command-${Date.now()}`,
    toolName: "command",
    content: [{ type: "text", text }],
    isError,
    timestamp: Date.now(),
  } as AgentMessage;
  if (!rawCommandText) return [resultEntry];
  const userEntry = {
    role: "user",
    content: [{ type: "text", text: rawCommandText }],
    timestamp: Date.now(),
  } as AgentMessage;
  return [userEntry, resultEntry];
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function modelFields(session: Session): { provider?: string; id?: string; contextWindow?: number } {
  return session.state.model as { provider?: string; id?: string; contextWindow?: number };
}

function buildStatusText(session: Session, messages: readonly AgentMessage[]): string {
  const { totalInputTokens, totalOutputTokens, contextTokens, totalCostUsd } = sumUsage(messages);
  const model = modelFields(session);
  return [
    `model: ${model.provider ?? "?"}/${model.id ?? "?"}`,
    `reasoning: ${session.state.thinkingLevel}`,
    `tokens: ↑${totalInputTokens} ↓${totalOutputTokens}`,
    `context: ${contextTokens}/${model.contextWindow ?? 0}`,
    `cost: $${totalCostUsd.toFixed(4)}`,
  ].join("\n");
}

function buildContextText(session: Session, messages: readonly AgentMessage[]): string {
  const { contextTokens, totalCostUsd, totalInputTokens, totalOutputTokens } = sumUsage(messages);
  const model = modelFields(session);
  const window = model.contextWindow ?? 0;
  const percent = window > 0 ? ((contextTokens / window) * 100).toFixed(1) : "0.0";
  return [
    `context window: ${contextTokens} / ${window} tokens (${percent}%)`,
    `messages: ${messages.length}`,
    `cumulative tokens: ↑${totalInputTokens} ↓${totalOutputTokens}`,
    `cumulative cost: $${totalCostUsd.toFixed(4)}`,
    `model: ${model.provider ?? "?"}/${model.id ?? "?"}`,
  ].join("\n");
}

function buildSettingsText(session: Session, cwd: string): string {
  const model = modelFields(session);
  return [
    `cwd: ${cwd}`,
    `provider/model: ${model.provider ?? "?"}/${model.id ?? "?"}`,
    `reasoning effort: ${session.state.thinkingLevel}`,
    "credentials: ~/.nanocode/credentials.json",
    "model selection: ~/.nanocode/model-selection.json",
    "trust: ~/.nanocode/trust.json",
  ].join("\n");
}

function transcriptToMarkdown(messages: readonly AgentMessage[]): string {
  return messages
    .map((message) => `### ${(message as { role: string }).role}\n\n${textOf(message)}`)
    .join("\n\n");
}

/** "/init"'s actual prompt text -- deliberately just a normal `session.prompt()` call under the
 * hood (matching Claude Code's/Codex's own "/init", which are themselves hardcoded prompts, not a
 * separate code path), so the model uses its one real tool (the Python REPL) to look around the
 * repo itself rather than nanocode trying to pre-gather context for it. */
const INIT_PROMPT =
  "Scan this repository (structure, key config files, existing conventions) and write a concise " +
  "AGENTS.md in the project root: what this project is, how to build/test/run it, and any " +
  "conventions a coding agent should follow here. If AGENTS.md already exists, update it instead " +
  "of overwriting anything still accurate.";

/** Subscribes to `promptTextAtom`/`commandMenuHighlightAtom` and renders `CommandMenu` -- kept as
 * its own leaf component (see the call site's comment in RunningSession) so the fact that this
 * re-renders on literally every keystroke stays contained to just this small piece of the tree. */
function CommandMenuView({
  promptTextAtom,
  commandMenuHighlightAtom,
}: {
  promptTextAtom: Atom<string>;
  commandMenuHighlightAtom: Atom<number>;
}) {
  const promptText = useAtom(promptTextAtom);
  const commandMenuHighlight = useAtom(commandMenuHighlightAtom);
  const commandMenu = deriveCommandMenu(promptText, commandMenuHighlight);
  if (!commandMenu.open) return null;
  return <CommandMenu matches={commandMenu.matches} highlightIndex={commandMenu.highlightIndex} />;
}

function PromptInput({
  session,
  cwd,
  busyAtom,
  errorAtom,
  localEntriesAtom,
  messagesAtom,
  overlayAtom,
  sessionVersionAtom,
  promptTextAtom,
  commandMenuHighlightAtom,
  runShellCommand,
  slashCommands,
  replaceSession,
  spawnEditor,
  readClipboardImage,
  readClipboardText,
  readDroppedFile,
}: {
  session: Session;
  cwd: string;
  busyAtom: Atom<boolean>;
  errorAtom: Atom<string | undefined>;
  localEntriesAtom: Atom<AgentMessage[]>;
  messagesAtom: Atom<AgentMessage[]>;
  overlayAtom: Atom<OverlayState | undefined>;
  sessionVersionAtom: Atom<number>;
  promptTextAtom: Atom<string>;
  commandMenuHighlightAtom: Atom<number>;
  runShellCommand: RunShellCommand;
  slashCommands: SlashCommandController;
  replaceSession: (session: Session) => void;
  spawnEditor: SpawnEditor;
  readClipboardImage: ReadClipboardImage;
  readClipboardText: ReadClipboardText;
  readDroppedFile: ReadDroppedFile;
}) {
  const busy = useAtom(busyAtom);
  const { suspendTerminal } = useApp();
  // Promoted to a shared atom (rather than a plain local useState, otherwise this project's
  // default for text nothing else needs) specifically so CommandMenu -- a sibling `RunningSession`
  // renders below the prompt box's closing rule, not a child of this component -- can read it live,
  // AND so RunningSession's own ctrl+c handler can clear it directly (see app.tsx's other
  // `useInput`) without needing this component to be involved at all.
  const input = useAtom(promptTextAtom);
  // Cursor position, index into `input` -- local `useState`, not an atom: nothing outside this
  // component ever needs to know or move it (CommandMenu only needs the text, not the caret).
  // `replaceInput` moves the cursor to the new text's end (right for every current caller: a full
  // submit-clear, the "/" menu's autocomplete-fill, an external-editor round-trip, a queued-message
  // recall); `insertAtCursor`/`deleteBeforeCursor`/`deleteToEnd` edit AT the caret rather than
  // always at the string's end, the actual cursor-support feature ctrl+k depends on.
  const [cursorPos, setCursorPos] = useState(0);
  const clampCursor = (pos: number, text: string) => Math.max(0, Math.min(pos, text.length));
  const replaceInput = (next: string) => {
    promptTextAtom.set(next);
    setCursorPos(next.length);
  };
  const insertAtCursor = (str: string) => {
    const current = promptTextAtom.get();
    const pos = clampCursor(cursorPos, current);
    const next = current.slice(0, pos) + str + current.slice(pos);
    promptTextAtom.set(next);
    setCursorPos(pos + str.length);
  };
  const deleteBeforeCursor = () => {
    const current = promptTextAtom.get();
    const pos = clampCursor(cursorPos, current);
    if (pos === 0) return;
    promptTextAtom.set(current.slice(0, pos - 1) + current.slice(pos));
    setCursorPos(pos - 1);
  };
  const deleteToEnd = () => {
    const current = promptTextAtom.get();
    const pos = clampCursor(cursorPos, current);
    promptTextAtom.set(current.slice(0, pos));
  };
  const moveCursor = (delta: number) => setCursorPos((pos) => clampCursor(pos + delta, input));
  // A prior `replaceInput`/RunningSession-side clear can shrink `input` out from under a cursor
  // that was further right -- clamp on every render rather than trusting callers to remember to.
  const safeCursorPos = clampCursor(cursorPos, input);

  const commandMenuHighlight = useAtom(commandMenuHighlightAtom);
  const commandMenu = deriveCommandMenu(input, commandMenuHighlight);
  // Images attached via ctrl+v, waiting for the next real submit to actually go out with -- a
  // plain ref (not an atom or useState): nothing renders off this directly today (a future version
  // could show "1 image attached" near the prompt), it only needs to survive across keystrokes
  // until handleSubmit reads and clears it.
  const pendingImagesRef = useRef<Array<{ type: "image"; data: string; mimeType: string }>>([]);

  // Re-highlight the top match whenever the typed command token changes (narrowing OR widening the
  // filtered list) -- `deriveCommandMenu` already clamps a stale highlight to stay in bounds, but a
  // clamp alone would leave the LAST match highlighted after a keystroke that shrinks the list from
  // underneath a highlight near the bottom, which reads as "jumped to the bottom" rather than the
  // "always start from the top match" a live-narrowing filter should feel like. `commandMenuHighlightAtom`
  // is a stable atom identity for this component's whole lifetime (see createSessionAtoms), so only the
  // token itself needs to be a dependency here.
  // biome-ignore lint/correctness/useExhaustiveDependencies: see above
  useEffect(() => {
    commandMenuHighlightAtom.set(0);
  }, [commandMenu.token]);

  const pushLocalEntry = (rawCommandText: string | undefined, text: string, isError = false) => {
    localEntriesAtom.set([
      ...localEntriesAtom.get(),
      ...buildCommandResultEntries(rawCommandText, text, isError),
    ]);
  };

  const handleSlashCommand = async (parsed: { name: string; args: string[] }) => {
    const raw = `/${parsed.name}${parsed.args.length ? ` ${parsed.args.join(" ")}` : ""}`;
    const canonical = resolveCommandName(parsed.name);
    if (!canonical) {
      pushLocalEntry(raw, `Unknown command: /${parsed.name}. Try /help.`, true);
      return;
    }

    // These four need more than a one-line argument -- hand off to CommandOverlay's picker/text
    // UI instead of handling them inline here.
    if (canonical === "login") {
      overlayAtom.set({ kind: "login", arg: parsed.args[0] });
      return;
    }
    if (canonical === "resume") {
      overlayAtom.set({ kind: "resume" });
      return;
    }
    if (canonical === "model" && parsed.args.length < 2) {
      overlayAtom.set({ kind: "model", arg: parsed.args[0] });
      return;
    }
    if (canonical === "effort" && parsed.args.length === 0) {
      overlayAtom.set({ kind: "effort" });
      return;
    }

    switch (canonical) {
      case "help":
        pushLocalEntry(raw, helpText());
        return;
      case "status":
        pushLocalEntry(raw, buildStatusText(session, messagesAtom.get()));
        return;
      case "context":
        pushLocalEntry(raw, buildContextText(session, messagesAtom.get()));
        return;
      case "settings":
        pushLocalEntry(raw, buildSettingsText(session, cwd));
        return;
      case "diff": {
        busyAtom.set(true);
        try {
          const result = await runShellCommand("git diff");
          pushLocalEntry(raw, result.output, result.isError);
        } finally {
          busyAtom.set(false);
        }
        return;
      }
      case "copy": {
        const lastAssistant = [...messagesAtom.get()]
          .reverse()
          .find((message) => (message as { role: string }).role === "assistant");
        if (!lastAssistant) {
          pushLocalEntry(raw, "Nothing to copy yet.", true);
          return;
        }
        try {
          await slashCommands.copyToClipboard(textOf(lastAssistant));
          pushLocalEntry(raw, "Copied last response to clipboard.");
        } catch (error) {
          pushLocalEntry(raw, describeError(error), true);
        }
        return;
      }
      case "export": {
        const format = parsed.args[0] === "md" ? "md" : "json";
        const messages = messagesAtom.get();
        const content =
          format === "json" ? JSON.stringify(messages, null, 2) : transcriptToMarkdown(messages);
        try {
          const path = await slashCommands.exportTranscript(content, format);
          pushLocalEntry(raw, `Exported to ${path}`);
        } catch (error) {
          pushLocalEntry(raw, describeError(error), true);
        }
        return;
      }
      case "init":
        busyAtom.set(true);
        errorAtom.set(undefined);
        session.prompt(INIT_PROMPT).catch((error: unknown) => {
          busyAtom.set(false);
          errorAtom.set(describeError(error));
        });
        return;
      case "new": {
        busyAtom.set(true);
        try {
          const fresh = await slashCommands.startNewSession();
          replaceSession(fresh);
        } catch (error) {
          busyAtom.set(false);
          errorAtom.set(describeError(error));
        }
        return;
      }
      case "compact": {
        busyAtom.set(true);
        try {
          const compacted = await session.compact();
          messagesAtom.set(session.state.messages.slice());
          pushLocalEntry(
            raw,
            compacted ? "Compacted older conversation history." : "Nothing to compact yet.",
          );
        } catch (error) {
          pushLocalEntry(raw, describeError(error), true);
        } finally {
          busyAtom.set(false);
        }
        return;
      }
      case "logout": {
        const providerId = parsed.args[0] ?? modelFields(session).provider;
        if (!providerId) {
          pushLocalEntry(raw, "No provider to log out of.", true);
          return;
        }
        try {
          await slashCommands.logout(providerId);
          pushLocalEntry(raw, `Logged out of ${providerId}.`);
        } catch (error) {
          pushLocalEntry(raw, describeError(error), true);
        }
        return;
      }
      case "effort": {
        const level = parsed.args[0] as (typeof THINKING_LEVELS)[number];
        if (!THINKING_LEVELS.includes(level)) {
          // Not a hard error: opens the same searchable picker "/effort" with no args does,
          // seeded with what was actually typed -- so mistyping "hi" for "high" lands you one
          // keystroke from the right answer instead of forcing a full retype. The current
          // thinkingLevel is untouched either way unless a real match is confirmed there.
          overlayAtom.set({ kind: "effort", arg: parsed.args[0] });
          return;
        }
        session.state.thinkingLevel = level;
        sessionVersionAtom.set(sessionVersionAtom.get() + 1);
        pushLocalEntry(raw, `Reasoning effort set to ${level}.`);
        return;
      }
      case "model": {
        const [providerId, modelId] = parsed.args;
        busyAtom.set(true);
        try {
          await slashCommands.switchModel(providerId, modelId);
          sessionVersionAtom.set(sessionVersionAtom.get() + 1);
          pushLocalEntry(raw, `Switched to ${providerId}/${modelId}.`);
        } catch (error) {
          pushLocalEntry(raw, describeError(error), true);
        } finally {
          busyAtom.set(false);
        }
        return;
      }
      default:
        return;
    }
  };

  const handleSubmit = (value: string) => {
    const text = value.trim();
    const images = pendingImagesRef.current;
    if (!text && images.length === 0) return;
    // Matches Claude Code: typing while a turn is in flight and pressing Enter queues the message
    // instead of being silently ignored -- Session.followUp() (packages/agent/src/agent.ts) is
    // already wired into the agent loop's own polling (agent-loop.ts's getFollowUpMessages hook),
    // so this is picked up automatically once the current turn finishes, no separate "send" action
    // needed. Slash/bang commands stay blocked while busy, unchanged: queuing makes sense for "say
    // this to the model next," not for something with an immediate, non-deferrable effect (a state
    // change, a local shell command, ...).
    if (busy) {
      if (text.startsWith("/") || text.startsWith("!")) return;
      replaceInput("");
      pendingImagesRef.current = [];
      session.followUp({
        role: "user",
        content: images.length > 0 ? [{ type: "text", text }, ...images] : [{ type: "text", text }],
        timestamp: Date.now(),
      } as AgentMessage);
      pushLocalEntry(undefined, "Queued as a follow-up message.");
      return;
    }
    replaceInput("");

    // A leading "!!" (checked first -- "!" is a strict prefix of it) runs the rest of the line as
    // a real host shell command whose output is a purely LOCAL terminal convenience, never sent to
    // the model at all -- this project's own original "!" behavior, kept under "!!" once "!" itself
    // was changed to match pi's real semantics below.
    if (text.startsWith("!!")) {
      const command = text.slice(2).trim();
      if (!command) return;
      pendingImagesRef.current = [];
      busyAtom.set(true);
      errorAtom.set(undefined);
      runShellCommand(command)
        .then((result) => {
          localEntriesAtom.set([
            ...localEntriesAtom.get(),
            ...buildBangCommandEntries(command, result),
          ]);
          busyAtom.set(false);
        })
        .catch((err: unknown) => {
          busyAtom.set(false);
          errorAtom.set(err instanceof Error ? err.message : String(err));
        });
      return;
    }

    // A single leading "!" ALSO runs the rest of the line as a real host shell command
    // (packages/cli/src/setup.ts's runShellCommand), but -- matching pi's real "!" semantics,
    // which include the output in the model's own context -- pushes the result into REAL session
    // history (session.state.messages) rather than the local-only `localEntriesAtom` "!!" uses.
    // The model never gets prompted itself just because of this (no session.prompt() call here),
    // exactly like pi: the output simply becomes part of what the model sees on its NEXT turn.
    if (text.startsWith("!")) {
      const command = text.slice(1).trim();
      if (!command) return;
      pendingImagesRef.current = [];
      busyAtom.set(true);
      errorAtom.set(undefined);
      runShellCommand(command)
        .then((result) => {
          session.state.messages = [
            ...session.state.messages,
            ...buildBangCommandEntries(command, result),
          ];
          messagesAtom.set(session.state.messages.slice());
          busyAtom.set(false);
        })
        .catch((err: unknown) => {
          busyAtom.set(false);
          errorAtom.set(err instanceof Error ? err.message : String(err));
        });
      return;
    }

    pendingImagesRef.current = [];
    errorAtom.set(undefined);
    // "Drop a file to attach" is checked BEFORE the "/" dispatch below, not after -- a terminal
    // drag-and-drop almost always pastes the dropped file's own ABSOLUTE path (see
    // readDroppedFile's own comment), which starts with "/" the same as every slash command does.
    // Checking "/" first was a real, live bug (found and fixed while wiring this up): every
    // genuinely dropped file was swallowed as an "Unknown command" and never reached the
    // filesystem check at all, since a dropped path essentially always looks like a slash command
    // syntactically. `readDroppedFile` itself only ever resolves for text that IS a real, existing
    // file, so a normal "/command" or plain-text prompt that merely happens to start with "/" or
    // "~" falls straight through to the branches below, completely unaffected -- this reordering
    // costs those an extra `stat()` call, not a behavior change.
    readDroppedFile(text)
      .then((dropped) => {
        if (dropped) {
          busyAtom.set(true);
          const prompt =
            dropped.kind === "image"
              ? session.prompt(text || `Attached file: ${dropped.path}`, [
                  ...images,
                  { type: "image", data: dropped.base64, mimeType: dropped.mediaType },
                ])
              : session.prompt(
                  `${dropped.content}\n\n(attached from ${dropped.path})`,
                  images.length > 0 ? images : undefined,
                );
          return prompt.catch((err: unknown) => {
            busyAtom.set(false);
            errorAtom.set(err instanceof Error ? err.message : String(err));
          });
        }

        // A leading "/" dispatches a slash command instead of prompting the model -- see
        // slash-commands.ts for the full list. `parsed` is undefined only for a bare "/" (or "/"
        // followed by only whitespace) -- in practice this branch no longer sees one via a real
        // keypress: an empty token matches every command, so the live "/" menu (see the `useInput`
        // handler below) is always open for a bare "/", and its own Enter handling completes the
        // highlighted match into the box instead of ever calling `handleSubmit` at all. Kept as a
        // defensive fallback (e.g. if `handleSubmit` is ever called some other way) rather than
        // removed, so a bare "/" can never fall through to `session.prompt("/")` and waste a real
        // model call on a stray keystroke.
        if (text.startsWith("/")) {
          const parsed = parseSlashCommand(text);
          if (!parsed) return;
          return handleSlashCommand(parsed).catch((error: unknown) => {
            busyAtom.set(false);
            errorAtom.set(describeError(error));
          });
        }

        busyAtom.set(true);
        return session
          .prompt(text, images.length > 0 ? images : undefined)
          .catch((err: unknown) => {
            busyAtom.set(false);
            errorAtom.set(err instanceof Error ? err.message : String(err));
          });
      })
      .catch((err: unknown) => {
        busyAtom.set(false);
        errorAtom.set(err instanceof Error ? err.message : String(err));
      });
  };

  // A hand-rolled input instead of ink-text-input's <TextInput>: ink-text-input registers its own
  // useInput hook internally, and Ink has no event-consumption mechanism between two independent
  // useInput listeners -- RunningSession's ctrl+o toggle (above) and ink-text-input's own handler
  // both fire for the same keypress, and ink-text-input only special-cases ctrl+c/arrows/tab, so
  // ctrl+o fell through to its default branch and inserted a literal "o" into the box on every
  // single toggle (an L4 VERIFY finding, confirmed live: typing "hi" then ctrl+o left "hio" in the
  // box). Owning the keystroke handling here, in the one place that already knows about
  // ctrl-combos, closes that gap for ctrl+o and any future ctrl-shortcut uniformly, not just "o".
  /** Ctrl+p/shift+ctrl+p's real work: builds the flat, ordered list of every model belonging to a
   * CONFIGURED provider (same "configured only" restriction "/model" itself uses -- see
   * decisions/0013), finds the current model's position in it, and switches to the next/previous
   * one, wrapping around at either end. A provider or model list that changed since the last cycle
   * (a new provider just logged into, say) is refetched fresh on every call rather than cached --
   * cycling is an infrequent, deliberate action, not a hot path worth optimizing.
   *
   * Distinguishing ctrl+p from ctrl+shift+p is a REAL terminal limitation, not a bug here: most
   * terminals collapse Ctrl+Shift+<letter> to the exact same byte as Ctrl+<letter> (there's no way
   * to send the shifted case with ctrl held without a newer protocol like Kitty's), so "cycle
   * backward" only actually works on terminals that support and enable that protocol -- everywhere
   * else, shift+ctrl+p is indistinguishable from ctrl+p and cycles forward the same way.
   */
  const cycleModel = async (direction: 1 | -1) => {
    const providers = (await slashCommands.listProviders()).filter((p) => p.hasCredential);
    const flat = providers.flatMap((p) =>
      slashCommands.listModels(p.id).map((m) => ({ providerId: p.id, modelId: m.id })),
    );
    if (flat.length === 0) return;
    const current = modelFields(session);
    const currentIndex = flat.findIndex(
      (entry) => entry.providerId === current.provider && entry.modelId === current.id,
    );
    const nextIndex =
      currentIndex === -1 ? 0 : (currentIndex + direction + flat.length) % flat.length;
    const target = flat[nextIndex];
    busyAtom.set(true);
    try {
      await slashCommands.switchModel(target.providerId, target.modelId);
      sessionVersionAtom.set(sessionVersionAtom.get() + 1);
    } catch (error) {
      errorAtom.set(describeError(error));
    } finally {
      busyAtom.set(false);
    }
  };

  /** Ctrl+g's real work: hands the terminal to `$VISUAL`/`$EDITOR` via Ink's own
   * `suspendTerminal()` (releases Ink's raw-mode stdin for the duration, forces a full redraw once
   * it resolves) wrapping `spawnEditor` (packages/cli/src/setup.ts, the actual child-process spawn
   * -- a plain host function with no terminal-mode concerns of its own, see its own comment). */
  const editInExternalEditor = async () => {
    let edited: string | undefined;
    try {
      await suspendTerminal(async () => {
        edited = await spawnEditor(promptTextAtom.get());
      });
    } catch (error) {
      errorAtom.set(describeError(error));
      return;
    }
    if (edited !== undefined) replaceInput(edited);
  };

  /** Ctrl+v's real work: image first, plain text as the fallback -- matching pi's own "paste image
   * (with text fallback)" exactly. An attached image doesn't go out until the next real submit
   * (`pendingImagesRef`, read and cleared by `handleSubmit`); pasted text is inserted at the
   * cursor immediately, the same as typing it. */
  const pasteFromClipboard = async () => {
    const image = await readClipboardImage();
    if (image) {
      pendingImagesRef.current = [
        ...pendingImagesRef.current,
        { type: "image", data: image.base64, mimeType: image.mediaType },
      ];
      pushLocalEntry(undefined, "Image attached -- will be sent with your next message.");
      return;
    }
    const text = await readClipboardText();
    if (text) insertAtCursor(text);
  };

  useInput((char, key) => {
    // Escape interrupts an in-flight turn, matching pi's own Escape-to-interrupt -- checked first,
    // ahead of the menu's own Escape-clears-input behavior below, since interrupting a running
    // generation is the more urgent of the two if a user somehow triggers both at once (typing "/"
    // while a previous turn is still streaming). `session.abort()` (packages/agent/src/agent.ts)
    // aborts the in-flight run's AbortSignal; the loop's own `withRunLifecycle` catches that and
    // still emits a normal `agent_end` (with a synthetic `stopReason: "aborted"` message appended
    // to history) -- RunningSession's existing `agent_end` handler already resets `busy` to false
    // for that, so no extra plumbing is needed here beyond just calling `abort()`.
    if (key.escape && busy) {
      session.abort();
      return;
    }

    // Option+enter inserts a literal newline, matching Claude Code -- queuing itself moved to
    // plain Enter while busy (see handleSubmit below), freeing this binding up for the one thing
    // multi-line composition genuinely needed and had no way to do at all before (paste was the
    // only way a newline ever reached the box).
    if (key.meta && key.return) {
      insertAtCursor("\n");
      return;
    }
    // Option+up pulls every currently-queued message (steering AND follow-up) back into the box
    // for editing -- `removeQueuedMessages(() => true)` (agent.ts) both reads and clears them in
    // one call, so re-queuing (another Enter while busy) after editing doesn't double them up.
    if (key.meta && key.upArrow) {
      const queued = session.removeQueuedMessages(() => true);
      if (queued.length === 0) return;
      replaceInput(queued.map((message) => textOf(message)).join("\n\n"));
      return;
    }
    if (key.ctrl && char === "g") {
      void editInExternalEditor();
      return;
    }
    if (key.ctrl && char === "v") {
      void pasteFromClipboard();
      return;
    }
    if (key.ctrl && char === "k") {
      deleteToEnd();
      return;
    }
    if (key.ctrl && char === "l") {
      overlayAtom.set({ kind: "model" });
      return;
    }
    if (key.ctrl && char === "p") {
      void cycleModel(key.shift ? -1 : 1);
      return;
    }
    if (key.tab && key.shift) {
      // A quick cycle straight to the next level -- deliberately NOT the searchable "/effort"
      // picker (a real, distinct, explicit user request: shift+tab stays a fast no-menu toggle
      // matching pi's own "shift+tab to cycle thinking level"; the menu is reached via "/effort"
      // or selecting it from the "/" command menu). It's NOT silent, though: confirmed directly
      // against real pi (v0.84.4) that its own shift+tab prints a plain "Thinking level: <level>"
      // line, not just a status-bar update -- nanocode's first version of this only updated the
      // status bar's own small corner text, which is exactly the kind of easy-to-miss, no-visible-
      // feedback change that read as "nothing happened" (the same underlying complaint that first
      // got misdiagnosed as "the menu isn't opening"). Matching pi's real confirmation line here
      // instead of inventing a menu neither pi nor this project's own explicit instructions call
      // for.
      const currentIndex = THINKING_LEVELS.indexOf(
        session.state.thinkingLevel as (typeof THINKING_LEVELS)[number],
      );
      const nextLevel =
        THINKING_LEVELS[(currentIndex === -1 ? 0 : currentIndex + 1) % THINKING_LEVELS.length];
      session.state.thinkingLevel = nextLevel;
      sessionVersionAtom.set(sessionVersionAtom.get() + 1);
      pushLocalEntry(undefined, `Reasoning effort set to ${nextLevel}.`);
      return;
    }

    if (key.ctrl || key.meta) return; // never insert a modifier-combo's raw character as text

    // Up/down navigate the live "/" autocomplete menu (matching pi's own) when it's open; when
    // it's not, they move the cursor instead (see below).
    if ((key.upArrow || key.downArrow) && commandMenu.open) {
      const delta = key.upArrow ? -1 : 1;
      const next = Math.min(
        Math.max(commandMenu.highlightIndex + delta, 0),
        commandMenu.matches.length - 1,
      );
      commandMenuHighlightAtom.set(next);
      return;
    }

    if (key.return) {
      // Enter on an open menu immediately DISPATCHES the highlighted command (zero args) rather
      // than just autocompleting its name into the box and waiting for a second Enter -- every
      // nanocode command already works with no arguments (an optional-args commands like "/model"
      // or "/effort" just open their own picker overlay when given none), so there's nothing an
      // extra confirmation step would gain here; it only cost an extra keypress and, worse, looked
      // like selecting an entry did nothing at all (a real user-reported confusion: choosing
      // "/effort" from this menu used to just leave "/effort " sitting in the box). Manually
      // TYPING a full command plus arguments (e.g. "/model anthropic claude-sonnet-5") is
      // completely unaffected: `deriveCommandMenu` already closes this menu the instant the typed
      // token exactly matches a command name, so by the time a hand-typed command's own Enter
      // press happens, `commandMenu.open` is already false and this branch never runs at all.
      if (commandMenu.open) {
        const chosen = commandMenu.matches[commandMenu.highlightIndex];
        if (chosen) {
          handleSubmit(`/${chosen.names[0]}`);
          return;
        }
      }
      handleSubmit(input);
      return;
    }
    if (key.backspace || key.delete) {
      deleteBeforeCursor();
      return;
    }
    if (key.escape && commandMenu.open) {
      replaceInput(""); // backs out of composing a slash command, same as pi's own menu
      return;
    }
    if (key.leftArrow) {
      moveCursor(-1);
      return;
    }
    if (key.rightArrow) {
      moveCursor(1);
      return;
    }
    if (key.home) {
      setCursorPos(0);
      return;
    }
    if (key.end) {
      setCursorPos(input.length);
      return;
    }
    if (key.upArrow || key.downArrow || key.pageUp || key.pageDown || key.tab || key.escape) {
      return; // no message history yet -- just don't insert these as literal text
    }
    // Pressing space right after typing out "/effort" in full (nothing after it yet, cursor at
    // the end) opens its picker immediately -- the same real, user-requested behavior as pressing
    // Enter there, just one keystroke earlier. Scoped to "/effort" specifically, not every command:
    // unlike commands whose zero-arg overlay IS the only way to supply an argument (e.g. "/model"
    // picks provider/model interactively either way), "/effort" also has a fast plain-text path
    // ("/effort high" + Enter, no overlay at all) that types a level name right after that same
    // space -- firing on space for every command would destroy that path the instant a user typed
    // the command name and pressed space to start on the argument. "/effort"'s own picker already
    // supports typing to search (see command-overlay.tsx), so continuing to type a level name
    // after the overlay opens reaches the identical outcome either way.
    if (char === " " && safeCursorPos === input.length && input.toLowerCase() === "/effort") {
      handleSubmit(input);
      return;
    }
    insertAtCursor(char);
  });

  // A hand-rolled caret: `inverse` on the single character AT the cursor (or a blank space when
  // the cursor sits past the last character, including on a completely empty box) -- Ink has no
  // built-in text-cursor widget, and the real terminal cursor is hidden while Ink owns the screen
  // (it repaints whole frames rather than moving a real cursor around), so this is the only way to
  // show one at all. An earlier version only rendered this branch when `input.length > 0`, which
  // meant an EMPTY box -- the state a user actually stares at most, right when the TUI starts --
  // showed no cursor whatsoever, just the dim placeholder text with no indication of where typing
  // would begin; a real, reported gap, not just a cosmetic nicety.
  const placeholder =
    input.length === 0
      ? busy
        ? "working…"
        : "type a prompt (or !command, /command), enter to send"
      : undefined;
  // Multi-line-aware: option+enter (above) can put real "\n"s into `input` now, so the box has to
  // render each line as its own row rather than one flat row of three Text siblings -- that old
  // layout put the "before"/cursor/"after" slices side by side regardless of embedded newlines,
  // which Ink's row-flex layout does not stack the way a real multi-line text area would. Only the
  // FIRST line gets the "> "/"… " prompt marker; continuation lines indent under it instead of
  // repeating it, the same gutter convention transcript.tsx's tool cells already use for code.
  const lines = input.split("\n");
  let remaining = safeCursorPos;
  let cursorLine = 0;
  for (; cursorLine < lines.length - 1; cursorLine++) {
    const lineLength = lines[cursorLine].length;
    if (remaining <= lineLength) break;
    remaining -= lineLength + 1; // +1 for the "\n" this line's own length doesn't count
  }
  const cursorCol = remaining;
  return (
    <Box flexDirection="column">
      {lines.map((line, index) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: `lines` is rebuilt fresh from `input` on every render, never reordered or spliced -- index is a stable, sufficient key here.
        <Box key={index}>
          <Text color={busy ? "gray" : "green"}>{index === 0 ? (busy ? "… " : "> ") : "  "}</Text>
          {index === cursorLine ? (
            <>
              <Text>{line.slice(0, cursorCol)}</Text>
              <Text inverse>{line[cursorCol] ?? " "}</Text>
              <Text>{line.slice(cursorCol + 1)}</Text>
            </>
          ) : (
            <Text>{line || " "}</Text>
          )}
          {index === lines.length - 1 && placeholder !== undefined && (
            <Text dimColor>{placeholder}</Text>
          )}
        </Box>
      ))}
    </Box>
  );
}
