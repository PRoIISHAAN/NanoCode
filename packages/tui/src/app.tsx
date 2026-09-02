// Root TUI component. Holds a direct `Session` reference (the user's explicit choice over
// introducing an AgentConnection seam at this milestone -- see the M5 design round) and subscribes
// to its AgentEvent stream directly, the same event bus packages/cli's headless mode also consumes.
// Ctrl+C to quit is handled by Ink itself by default (`exitOnCtrlC`, on unless the render() caller
// opts out) -- nothing extra is wired up here for it.
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
import { Box, Text, useInput } from "ink";
// Explicit React import: proven necessary by direct A/B testing against the real `npm run tui`
// entrypoint (removing it reproduces "ReferenceError: React is not defined" here, even with
// packages/tui's own local tsconfig.json in place) -- see tui.tsx's longer comment on the likely
// cause (tsx/esbuild's JSX-transform config resolution for the whole reachable dependency graph,
// not cleanly per file, once the graph is as large as this app's real one).
// biome-ignore lint/correctness/noUnusedImports: required by tsx's runtime JSX transform, not referenced directly in this file's own code
import React, { useEffect, useMemo, useState } from "react";
import { type Atom, atom, useAtom } from "./atom.ts";
import { createBackpressureQueue } from "./backpressure.ts";
import { StartupBanner } from "./banner.tsx";
import { type ModelSetupController, SetupScreen } from "./setup-screen.tsx";
import { HorizontalRule, StatusBar } from "./status-bar.tsx";
import { Transcript, textOf } from "./transcript.tsx";

export type { ModelSetupController } from "./setup-screen.tsx";

/** Runs a "!command" bash escape -- packages/cli/src/setup.ts implements this by spawning a real
 * host shell process directly (like pi's own "!"; pi has no persistent kernel to route through at
 * all), passed in as a plain function so packages/tui never has to import @nanocode/kernel or
 * @nanocode/ai directly (context-graph.json's tui_isolation invariant). */
export type RunShellCommand = (command: string) => Promise<{ output: string; isError: boolean }>;

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
}

interface SessionAtoms {
  messages: Atom<AgentMessage[]>;
  /** "!command" entries -- a synthetic user message plus a synthetic toolResult, appended here
   * rather than sent to the model at all. Kept separate from `messages` (not pushed into
   * `session.state.messages`) rather than merged permanently into session history: a bash escape
   * is a local terminal convenience, the same as pi's own "!" (or IPython's, which this project's
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
}

function createSessionAtoms(session: Session): SessionAtoms {
  return {
    messages: atom(session.state.messages.slice()),
    localEntries: atom<AgentMessage[]>([]),
    streamingText: atom<string | undefined>(undefined),
    busy: atom(false),
    error: atom<string | undefined>(undefined),
    toolOutputExpanded: atom(false),
  };
}

export function App({ session: initialSession, setup, version, cwd, runShellCommand }: AppProps) {
  // Starts undefined on an unconfigured launch; SetupScreen's onReady sets it once setup.finish()
  // hands back a fully-built Session. `useMemo` with an empty dependency array (not a lazy
  // useState initializer) is deliberate here too: App itself is only ever mounted once per process
  // (tui.tsx renders it exactly once), so there is no "identity changed" case to react to -- this
  // atom just needs to exist for the lifetime of the component.
  // biome-ignore lint/correctness/useExhaustiveDependencies: intentionally created once, see above
  const sessionAtom = useMemo(() => atom<Session | undefined>(initialSession), []);
  const session = useAtom(sessionAtom);

  return (
    <Box flexDirection="column">
      <StartupBanner version={version} />
      {session ? (
        <RunningSession session={session} cwd={cwd} runShellCommand={runShellCommand} />
      ) : (
        <SetupScreen setup={setup} onReady={(ready) => sessionAtom.set(ready)} />
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

function RunningSession({
  session,
  cwd,
  runShellCommand,
}: {
  session: Session;
  cwd: string;
  runShellCommand: RunShellCommand;
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
          if (event.message.role === "assistant") streamQueue.push(textOf(event.message));
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

  useInput((input, key) => {
    if (key.ctrl && input === "o") {
      atoms.toolOutputExpanded.set(!atoms.toolOutputExpanded.get());
    }
  });

  return (
    <Box flexDirection="column">
      <TranscriptView
        messagesAtom={atoms.messages}
        localEntriesAtom={atoms.localEntries}
        streamingTextAtom={atoms.streamingText}
        toolOutputExpandedAtom={atoms.toolOutputExpanded}
      />
      <ErrorLine errorAtom={atoms.error} />
      <HorizontalRule />
      <PromptInput
        session={session}
        busyAtom={atoms.busy}
        errorAtom={atoms.error}
        localEntriesAtom={atoms.localEntries}
        runShellCommand={runShellCommand}
      />
      <HorizontalRule />
      <StatusLine session={session} cwd={cwd} messagesAtom={atoms.messages} busyAtom={atoms.busy} />
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
}: {
  messagesAtom: Atom<AgentMessage[]>;
  localEntriesAtom: Atom<AgentMessage[]>;
  streamingTextAtom: Atom<string | undefined>;
  toolOutputExpandedAtom: Atom<boolean>;
}) {
  const messages = useAtom(messagesAtom);
  const localEntries = useAtom(localEntriesAtom);
  const streamingText = useAtom(streamingTextAtom);
  const toolOutputExpanded = useAtom(toolOutputExpandedAtom);
  // Merged purely for display, by when each thing actually happened -- real conversation messages
  // and "!command" entries are never combined into one array anywhere else (session.state.messages
  // never sees the local ones at all, see SessionAtoms.localEntries's own comment).
  const merged = useMemo(
    () => [...messages, ...localEntries].sort((a, b) => messageTimestamp(a) - messageTimestamp(b)),
    [messages, localEntries],
  );
  return (
    <Transcript
      messages={merged}
      streamingText={streamingText}
      toolOutputExpanded={toolOutputExpanded}
    />
  );
}

function StatusLine({
  session,
  cwd,
  messagesAtom,
  busyAtom,
}: {
  session: Session;
  cwd: string;
  messagesAtom: Atom<AgentMessage[]>;
  busyAtom: Atom<boolean>;
}) {
  const messages = useAtom(messagesAtom);
  const busy = useAtom(busyAtom);
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
      busy={busy}
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

/** Builds the synthetic {user, toolResult} pair a "!command" produces for display -- shaped
 * exactly like a real toolCall round-trip (role "toolResult", a toolName) so Transcript's existing
 * rendering, including summarizeToolResult's ctrl+o collapse/expand, applies to bash output for
 * free, with zero new UI code. */
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
    isError: result.isError,
    timestamp: Date.now(),
  } as AgentMessage;
  return [userEntry, resultEntry];
}

function PromptInput({
  session,
  busyAtom,
  errorAtom,
  localEntriesAtom,
  runShellCommand,
}: {
  session: Session;
  busyAtom: Atom<boolean>;
  errorAtom: Atom<string | undefined>;
  localEntriesAtom: Atom<AgentMessage[]>;
  runShellCommand: RunShellCommand;
}) {
  const busy = useAtom(busyAtom);
  // Typed-but-not-yet-submitted text is local to this component on purpose: nothing else in the
  // tree needs it, so there's no reason to route it through a shared atom.
  const [input, setInput] = useState("");

  const handleSubmit = (value: string) => {
    const text = value.trim();
    if (!text || busy) return;
    setInput("");

    // A leading "!" runs the rest of the line as a real host shell command
    // (packages/cli/src/setup.ts's runShellCommand) -- never reaching the model at all, matching
    // pi's own "!" bash escape exactly (pi has no persistent kernel to route through either).
    if (text.startsWith("!")) {
      const command = text.slice(1).trim();
      if (!command) return;
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

    busyAtom.set(true);
    errorAtom.set(undefined);
    session.prompt(text).catch((err: unknown) => {
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
  useInput((char, key) => {
    if (key.ctrl || key.meta) return; // never insert a modifier-combo's raw character as text
    if (key.return) {
      handleSubmit(input);
      return;
    }
    if (key.backspace || key.delete) {
      setInput((current) => current.slice(0, -1));
      return;
    }
    if (
      key.upArrow ||
      key.downArrow ||
      key.leftArrow ||
      key.rightArrow ||
      key.pageUp ||
      key.pageDown ||
      key.home ||
      key.end ||
      key.tab ||
      key.escape
    ) {
      return; // no cursor navigation or history yet -- just don't insert these as literal text
    }
    setInput((current) => current + char);
  });

  return (
    <Box>
      <Text color={busy ? "gray" : "green"}>{busy ? "… " : "> "}</Text>
      <Text dimColor={input.length === 0}>
        {input.length > 0
          ? input
          : busy
            ? "working…"
            : "type a prompt (or !command), enter to send"}
      </Text>
    </Box>
  );
}
