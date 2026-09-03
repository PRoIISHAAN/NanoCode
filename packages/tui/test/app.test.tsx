// M5: proves App renders incrementally as an assistant message streams in (not just once at the
// end) and shows the settled message afterward -- against a REAL Session driven by a fake
// EventStream, the same pattern packages/agent's own tests use, rather than a hand-rolled fake
// event list that might not match what Session actually emits.
import type { AgentTool } from "@nanocode/agent";
import { Session } from "@nanocode/agent";
import type {
  Api,
  AssistantMessage,
  AssistantMessageEvent,
  AssistantMessageEventStream,
  Model,
} from "@nanocode/ai";
import { EventStream } from "@nanocode/ai";
import { render } from "ink-testing-library";
import { Type } from "typebox";
import { describe, expect, it, vi } from "vitest";
import {
  App,
  type ReadClipboardImage,
  type ReadClipboardText,
  type ReadDroppedFile,
  type RunShellCommand,
  type SpawnEditor,
} from "../src/app.tsx";
import type { ModelSetupController } from "../src/setup-screen.tsx";
import {
  SLASH_COMMANDS,
  type SlashCommandController,
  THINKING_LEVELS,
} from "../src/slash-commands.ts";

/** These tests all construct App with an already-real `session`, so App must render
 * `RunningSession` immediately and never touch `setup` at all -- every method here throws to
 * catch a regression where App ignored a defined session and rendered onboarding anyway. */
const NEVER_CALLED_SETUP: ModelSetupController = {
  listProviders: () => {
    throw new Error("setup.listProviders() should never be called when a session is provided");
  },
  listModels: () => {
    throw new Error("setup.listModels() should never be called when a session is provided");
  },
  login: () => {
    throw new Error("setup.login() should never be called when a session is provided");
  },
  finish: () => {
    throw new Error("setup.finish() should never be called when a session is provided");
  },
};

/** None of the existing tests in this file exercise a "!command" bash escape -- they only drive
 * normal chat prompts -- so `runShellCommand` should never actually be invoked by any of them.
 * Matches the `NEVER_CALLED_SETUP` pattern above. */
const NEVER_CALLED_RUN_SHELL_COMMAND: RunShellCommand = vi.fn(() => {
  throw new Error(
    "runShellCommand should never be called by a test that doesn't exercise bang commands",
  );
});

/** ADR 0014's ctrl+g -- same throwing-fake pattern as `NEVER_CALLED_RUN_SHELL_COMMAND` above, for
 * every existing test in this file that doesn't drive the external-editor keybinding. */
const NEVER_CALLED_SPAWN_EDITOR: SpawnEditor = vi.fn(() => {
  throw new Error("spawnEditor should never be called by a test that doesn't exercise ctrl+g");
});

/** ADR 0014's ctrl+v (image branch) -- same pattern as `NEVER_CALLED_SPAWN_EDITOR` above. */
const NEVER_CALLED_READ_CLIPBOARD_IMAGE: ReadClipboardImage = vi.fn(() => {
  throw new Error(
    "readClipboardImage should never be called by a test that doesn't exercise ctrl+v",
  );
});

/** ADR 0014's ctrl+v (text-fallback branch) -- same pattern as `NEVER_CALLED_SPAWN_EDITOR` above. */
const NEVER_CALLED_READ_CLIPBOARD_TEXT: ReadClipboardText = vi.fn(() => {
  throw new Error(
    "readClipboardText should never be called by a test that doesn't exercise ctrl+v",
  );
});

/** `readDroppedFile` (setup.ts) is called UNCONDITIONALLY on every normal-prompt Enter submission
 * (see `handleSubmit` in app.tsx) -- unlike the other three ADR 0014 host functions above, most
 * existing tests in this file DO reach it (any test that submits a plain chat prompt) even though
 * they have nothing to do with drop-file-to-attach. So this resolves `undefined` (a real, always-
 * falls-through-to-a-normal-prompt result) rather than throwing, and is the default for every
 * existing `<App .../>` render; only a test that specifically asserts drop-file behavior swaps in
 * its own fake instead. */
const DEFAULT_READ_DROPPED_FILE: ReadDroppedFile = async () => undefined;

/** Same pattern as `NEVER_CALLED_SETUP`/`NEVER_CALLED_RUN_SHELL_COMMAND` above -- threaded into
 * every existing `<App .../>` render in this file so a `PromptInput` dispatch path that reaches
 * into `SlashCommandController` without a test actually exercising it fails loudly instead of
 * silently (this is the exact gap an L4 VERIFY pass found: every render here used to omit
 * `slashCommands` entirely, so nothing protected `handleSlashCommand`'s dispatch logic at all).
 * Tests that DO exercise a "/command" build their own narrower fake instead (spying/stubbing only
 * the methods that specific command needs) and pass that in place of this one. */
const NEVER_CALLED_SLASH_COMMANDS: SlashCommandController = {
  listProviders: () => {
    throw new Error(
      "SlashCommandController.listProviders() should never be called by a test that doesn't exercise it",
    );
  },
  listModels: () => {
    throw new Error(
      "SlashCommandController.listModels() should never be called by a test that doesn't exercise it",
    );
  },
  login: () => {
    throw new Error(
      "SlashCommandController.login() should never be called by a test that doesn't exercise it",
    );
  },
  logout: () => {
    throw new Error(
      "SlashCommandController.logout() should never be called by a test that doesn't exercise it",
    );
  },
  switchModel: () => {
    throw new Error(
      "SlashCommandController.switchModel() should never be called by a test that doesn't exercise it",
    );
  },
  startNewSession: () => {
    throw new Error(
      "SlashCommandController.startNewSession() should never be called by a test that doesn't exercise it",
    );
  },
  listRecentSessions: () => {
    throw new Error(
      "SlashCommandController.listRecentSessions() should never be called by a test that doesn't exercise it",
    );
  },
  loadSessionMessages: () => {
    throw new Error(
      "SlashCommandController.loadSessionMessages() should never be called by a test that doesn't exercise it",
    );
  },
  copyToClipboard: () => {
    throw new Error(
      "SlashCommandController.copyToClipboard() should never be called by a test that doesn't exercise it",
    );
  },
  exportTranscript: () => {
    throw new Error(
      "SlashCommandController.exportTranscript() should never be called by a test that doesn't exercise it",
    );
  },
};

const FAKE_MODEL: Model<Api> = {
  id: "fake-model",
  name: "Fake Model",
  api: "anthropic-messages",
  provider: "fake-provider",
  baseUrl: "",
  reasoning: false,
  input: ["text"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 200_000,
  maxTokens: 8_000,
};

const USAGE: AssistantMessage["usage"] = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 0,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

function assistantMessage(overrides: Partial<AssistantMessage>): AssistantMessage {
  return {
    role: "assistant",
    content: [],
    api: FAKE_MODEL.api,
    provider: FAKE_MODEL.provider,
    model: FAKE_MODEL.id,
    usage: USAGE,
    stopReason: "stop",
    timestamp: Date.now(),
    ...overrides,
  };
}

function extractFinalMessage(event: AssistantMessageEvent): AssistantMessage {
  if (event.type === "done") return event.message;
  if (event.type === "error") return event.error;
  throw new Error("Unexpected event type for final result");
}

function fakeStream(): AssistantMessageEventStream {
  return new EventStream<AssistantMessageEvent, AssistantMessage>(
    (event) => event.type === "done" || event.type === "error",
    extractFinalMessage,
  );
}

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe("App", () => {
  it("shows a fixed 'thinking...'/'responding…' status while text streams in, never the growing partial text, then the settled final message", async () => {
    // Regression for the real root cause of a "still scrolling" bug report: an earlier version of
    // this test asserted the growing partial text ("Hel", then "Hello world") was directly visible
    // in lastFrame() while a response was still streaming. That's no longer how this works -- app.tsx's
    // `streamingStatusFor` now pushes a FIXED status string ("thinking..." with no real text yet,
    // "responding…" once there is some) into `streamingText` regardless of how much text has
    // actually streamed in, so the live indicator's rendered height never grows at all during a
    // turn (see app.tsx's own comment on `streamingStatusFor` and its one call site). The full,
    // real text is never lost -- it still settles into the transcript in full the moment the turn
    // ends (message_end), which this test also still proves below.
    const stream = fakeStream();
    const session = new Session({
      streamFn: () => stream,
      initialState: { model: FAKE_MODEL, systemPrompt: "test" },
    });

    const { lastFrame } = render(
      <App
        session={session}
        setup={NEVER_CALLED_SETUP}
        version="0.0.0-test"
        cwd="/test/cwd"
        runShellCommand={NEVER_CALLED_RUN_SHELL_COMMAND}
        slashCommands={NEVER_CALLED_SLASH_COMMANDS}
        spawnEditor={NEVER_CALLED_SPAWN_EDITOR}
        readClipboardImage={NEVER_CALLED_READ_CLIPBOARD_IMAGE}
        readClipboardText={NEVER_CALLED_READ_CLIPBOARD_TEXT}
        readDroppedFile={DEFAULT_READ_DROPPED_FILE}
      />,
    );

    // Drives the session directly rather than through ink-text-input's own keystroke simulation --
    // what this test actually needs to prove is App's event-subscription -> render pipeline, not
    // ink-text-input's (separately-tested, third-party) raw-mode keypress handling.
    void session.prompt("hello");
    await wait(10);

    stream.push({
      type: "start",
      partial: assistantMessage({ content: [] }),
    });
    // "start" only ever emits a "message_start" AgentEvent (see agent-loop.ts), which app.tsx's
    // switch statement doesn't act on at all -- streamingText only ever changes on a
    // "message_update" event, which the first text_delta below is what actually produces.

    stream.push({
      type: "text_delta",
      contentIndex: 0,
      delta: "Hel",
      partial: assistantMessage({ content: [{ type: "text", text: "Hel" }] }),
    });
    // Backpressure coalesces rapid deltas to ~30fps -- give the queue's timer time to flush.
    await wait(60);
    // Real text content has started arriving: the fixed "responding…" status shows, but NOT the
    // literal partial text itself (proving the live indicator no longer grows with the delta).
    expect(lastFrame()).toContain("responding…");
    expect(lastFrame()).not.toContain("Hel");

    stream.push({
      type: "text_delta",
      contentIndex: 0,
      delta: "lo world",
      partial: assistantMessage({ content: [{ type: "text", text: "Hello world" }] }),
    });
    await wait(60);
    // Still just the same fixed status -- more text streamed in, but the indicator's content (and
    // therefore its rendered height) hasn't changed at all.
    expect(lastFrame()).toContain("responding…");
    expect(lastFrame()).not.toContain("Hello world");

    stream.push({
      type: "done",
      reason: "stop",
      message: assistantMessage({
        content: [{ type: "text", text: "Hello world" }],
        stopReason: "stop",
      }),
    });
    await wait(20);

    // The complete, real text settles into the transcript in full once the turn ends -- unaffected
    // by any of the above.
    const frame = lastFrame() ?? "";
    expect(frame).toContain("Hello world");
    expect(frame).toContain("hello"); // the user's own "hello" message is in the settled transcript
  });

  it("actually submits via the real <TextInput> wiring given realistic per-keystroke input", async () => {
    // Regression: an L4 review flagged that every other test here drives session.prompt()
    // directly, leaving the real <TextInput onSubmit={handleSubmit}> wiring in app.tsx completely
    // untested -- a swapped or broken prop there would pass the whole suite and only surface live
    // (exactly what happened with the "React is not defined" bug this same milestone hit).
    // This drives real stdin, character by character with a small delay between writes -- matching
    // how a real terminal delivers keystrokes one at a time. A single combined
    // `stdin.write("hello\r")` call does NOT work: confirmed directly that ink's raw-mode parser
    // only registers the last keypress in a chunk containing a mix of regular characters and a
    // special key, which is why every other test in this file avoids relying on it.
    const stream = fakeStream();
    const session = new Session({
      streamFn: () => stream,
      initialState: { model: FAKE_MODEL, systemPrompt: "test" },
    });
    const { lastFrame, stdin } = render(
      <App
        session={session}
        setup={NEVER_CALLED_SETUP}
        version="0.0.0-test"
        cwd="/test/cwd"
        runShellCommand={NEVER_CALLED_RUN_SHELL_COMMAND}
        slashCommands={NEVER_CALLED_SLASH_COMMANDS}
        spawnEditor={NEVER_CALLED_SPAWN_EDITOR}
        readClipboardImage={NEVER_CALLED_READ_CLIPBOARD_IMAGE}
        readClipboardText={NEVER_CALLED_READ_CLIPBOARD_TEXT}
        readDroppedFile={DEFAULT_READ_DROPPED_FILE}
      />,
    );

    for (const ch of "hello") {
      stdin.write(ch);
      await wait(5);
    }
    stdin.write("\r");
    await wait(20);

    // Submission clears the input box and flips to the busy indicator -- proof onSubmit actually
    // fired (a stuck, un-submitted "hello" would still show "> hello" here instead).
    expect(lastFrame()).toContain("… ");
    expect(lastFrame()).not.toContain("> hello");

    stream.push({
      type: "start",
      partial: assistantMessage({ content: [] }),
    });
    stream.push({
      type: "done",
      reason: "stop",
      message: assistantMessage({
        content: [{ type: "text", text: "hi there" }],
        stopReason: "stop",
      }),
    });
    await wait(20);

    expect(lastFrame()).toContain("hi there");
  });

  it("does not resurrect stale streaming text after message_end settles it (backpressure race)", async () => {
    // Regression, found live (not by a static review): a message_update pushed into the
    // backpressure queue schedules a flush up to ~33ms later. Without disposing that queue when
    // message_end settles the message, the queued flush still fires afterward and resurrects the
    // stale streamingText value -- rendering the just-settled message a second time underneath
    // itself. Reproduces the exact race: push a text_delta (schedules the flush), then, before
    // that ~33ms window elapses, push the done event that settles it.
    const stream = fakeStream();
    const session = new Session({
      streamFn: () => stream,
      initialState: { model: FAKE_MODEL, systemPrompt: "test" },
    });
    const { lastFrame } = render(
      <App
        session={session}
        setup={NEVER_CALLED_SETUP}
        version="1.0.0"
        cwd="/test"
        runShellCommand={NEVER_CALLED_RUN_SHELL_COMMAND}
        slashCommands={NEVER_CALLED_SLASH_COMMANDS}
        spawnEditor={NEVER_CALLED_SPAWN_EDITOR}
        readClipboardImage={NEVER_CALLED_READ_CLIPBOARD_IMAGE}
        readClipboardText={NEVER_CALLED_READ_CLIPBOARD_TEXT}
        readDroppedFile={DEFAULT_READ_DROPPED_FILE}
      />,
    );

    void session.prompt("hello");
    await wait(10);

    stream.push({
      type: "text_delta",
      contentIndex: 0,
      delta: "Hello",
      partial: assistantMessage({ content: [{ type: "text", text: "Hello" }] }),
    });
    stream.push({
      type: "done",
      reason: "stop",
      message: assistantMessage({ content: [{ type: "text", text: "Hello" }], stopReason: "stop" }),
    });
    await wait(60); // well past the ~33ms coalescing window the stale flush would fire within

    const frame = lastFrame() ?? "";
    const occurrences = frame.split("Hello").length - 1;
    expect(occurrences).toBe(1); // settled once, never duplicated by a resurrected stale flush
  });

  it("renders Session's own synthetic failure message when a run fails internally", async () => {
    // Session's withRunLifecycle catches an internal failure (here: streamFn throwing) and
    // surfaces it as a normal synthetic assistant message rather than rejecting prompt() at all --
    // App must render that message like any other, not just avoid crashing.
    const session = new Session({
      streamFn: () => {
        throw new Error("boom");
      },
      initialState: { model: FAKE_MODEL, systemPrompt: "test" },
    });
    const { lastFrame } = render(
      <App
        session={session}
        setup={NEVER_CALLED_SETUP}
        version="0.0.0-test"
        cwd="/test/cwd"
        runShellCommand={NEVER_CALLED_RUN_SHELL_COMMAND}
        slashCommands={NEVER_CALLED_SLASH_COMMANDS}
        spawnEditor={NEVER_CALLED_SPAWN_EDITOR}
        readClipboardImage={NEVER_CALLED_READ_CLIPBOARD_IMAGE}
        readClipboardText={NEVER_CALLED_READ_CLIPBOARD_TEXT}
        readDroppedFile={DEFAULT_READ_DROPPED_FILE}
      />,
    );

    await session.prompt("hello");
    await wait(20);

    expect(lastFrame()).toContain("boom");
  });

  it("shows a startup banner and a status bar with real cwd/model/reasoning, updating on real usage", async () => {
    const stream = fakeStream();
    const session = new Session({
      streamFn: () => stream,
      initialState: { model: FAKE_MODEL, systemPrompt: "test", thinkingLevel: "high" },
    });
    const { lastFrame, stdin } = render(
      <App
        session={session}
        setup={NEVER_CALLED_SETUP}
        version="1.2.3"
        cwd="/home/me/project"
        runShellCommand={NEVER_CALLED_RUN_SHELL_COMMAND}
        slashCommands={NEVER_CALLED_SLASH_COMMANDS}
        spawnEditor={NEVER_CALLED_SPAWN_EDITOR}
        readClipboardImage={NEVER_CALLED_READ_CLIPBOARD_IMAGE}
        readClipboardText={NEVER_CALLED_READ_CLIPBOARD_TEXT}
        readDroppedFile={DEFAULT_READ_DROPPED_FILE}
      />,
    );

    let frame = lastFrame() ?? "";
    // The startup banner no longer prints a version line at all -- it renders a fixed ASCII-art
    // logo instead (see banner.tsx's `LOGO_LINES`). "▒" is the fill character that logo is built
    // from, and it appears nowhere else in the app (confirmed via a repo-wide grep), so its
    // presence here proves the banner rendered.
    expect(frame).toContain("▒");
    expect(frame).toContain("/home/me/project");
    expect(frame).toContain("fake-provider/fake-model");
    expect(frame).toContain("high"); // the configured reasoning level
    // The status bar itself has no busy/idle text anymore -- PromptInput's own placeholder is the
    // real signal for "not busy" (see the "working…" / "… " assertions below for the busy side).
    expect(frame).toContain("type a prompt (or !command, /command), enter to send");
    expect(frame).toContain("↑0 ↓0");
    expect(frame).toContain("0.0%/200k"); // FAKE_MODEL.contextWindow

    // Driven through the real <TextInput> submit path, not a direct session.prompt() call -- the
    // busy atom is only ever set by PromptInput's own onSubmit handler, never by a session event,
    // so a direct prompt() call (as an earlier version of this test used) would never turn it on.
    for (const ch of "hello") {
      stdin.write(ch);
      await wait(2);
    }
    stdin.write("\r");
    await wait(10);
    frame = lastFrame() ?? "";
    expect(frame).toContain("… "); // a turn is now in flight -- PromptInput's own busy indicator

    stream.push({
      type: "done",
      reason: "stop",
      message: assistantMessage({
        content: [{ type: "text", text: "hi" }],
        stopReason: "stop",
        usage: { ...USAGE, input: 2000, output: 50, cost: { ...USAGE.cost, total: 0.0042 } },
      }),
    });
    await wait(20);

    frame = lastFrame() ?? "";
    expect(frame).toContain("type a prompt (or !command, /command), enter to send"); // the turn settled
    // Proves the status bar is reading the real settled message list, not a stale/hardcoded value:
    // 2000 input, 50 output, 2000/200000 = 1.0% of the context window, and the real cost figure.
    expect(frame).toContain("↑2.0K ↓50");
    expect(frame).toContain("1.0%/200k");
    expect(frame).toContain("$0.0042");
  });

  it("frames the prompt box with a horizontal rule above and below, cwd+data below the second rule -- matching pi's layout, not the data-above-the-prompt layout", async () => {
    const session = new Session({
      streamFn: () => fakeStream(),
      initialState: { model: FAKE_MODEL, systemPrompt: "test" },
    });
    const { lastFrame } = render(
      <App
        session={session}
        setup={NEVER_CALLED_SETUP}
        version="1.0.0"
        cwd="/home/me/project"
        runShellCommand={NEVER_CALLED_RUN_SHELL_COMMAND}
        slashCommands={NEVER_CALLED_SLASH_COMMANDS}
        spawnEditor={NEVER_CALLED_SPAWN_EDITOR}
        readClipboardImage={NEVER_CALLED_READ_CLIPBOARD_IMAGE}
        readClipboardText={NEVER_CALLED_READ_CLIPBOARD_TEXT}
        readDroppedFile={DEFAULT_READ_DROPPED_FILE}
      />,
    );

    const lines = (lastFrame() ?? "").split("\n");
    const promptIndex = lines.findIndex((line) =>
      line.includes("type a prompt (or !command, /command), enter to send"),
    );
    expect(promptIndex).toBeGreaterThan(-1);

    const isRule = (line: string) => /^─+$/.test(line);
    expect(isRule(lines[promptIndex - 1])).toBe(true); // rule directly above the prompt box
    expect(isRule(lines[promptIndex + 1])).toBe(true); // rule directly below the prompt box

    // cwd + data come strictly AFTER the closing rule, never before the prompt box.
    const cwdIndex = lines.indexOf("/home/me/project");
    expect(cwdIndex).toBeGreaterThan(promptIndex + 1);
  });

  it("Ctrl+O only expands tool cells created after the toggle -- an already-settled cell stays frozen", async () => {
    // Drives a real toolCall -> real tool execution -> real toolResult message round-trip (the
    // same shape packages/agent/test/agent.test.ts's own fake-tool tests use), rather than
    // fabricating a toolResult message directly -- that would only prove the collapse renderer
    // works on hand-shaped data, not that it's wired to a genuinely produced message.
    //
    // Under <Static>, a tool cell's render is frozen the first time it settles -- ctrl+o can no
    // longer retroactively repaint it (see transcript.tsx's own header comment). So this test runs
    // TWO tool-call round trips: the first settles collapsed under the default toggle state and
    // must stay that way even after ctrl+o is pressed; the second is created AFTER the toggle and
    // must render expanded from the moment it appears, with no further toggle needed.
    const multiLineTool: AgentTool = {
      name: "multiline-tool",
      label: "Multiline",
      description: "returns a multi-line result",
      parameters: Type.Object({}),
      execute: async () => ({
        content: [{ type: "text", text: "line one\nline two\nline three" }],
        details: {},
      }),
    };

    // Each session.prompt() round-trips the ConversationDriver loop until stopReason "stop" --
    // one prompt() call always drives streamFn twice (a toolUse turn, then a stop turn), matching
    // this file's other multi-turn fake-stream tests (see `call` counters elsewhere in this file).
    // Odd calls emit the toolCall (a fresh id per round so each becomes its own transcript item),
    // even calls emit the final "done" text that settles the turn.
    let call = 0;
    const session = new Session({
      streamFn: () => {
        call += 1;
        const stream = fakeStream();
        if (call % 2 === 1) {
          stream.push({
            type: "done",
            reason: "toolUse",
            message: assistantMessage({
              content: [
                { type: "toolCall", id: `call-${call}`, name: "multiline-tool", arguments: {} },
              ],
              stopReason: "toolUse",
            }),
          });
        } else {
          stream.push({
            type: "done",
            reason: "stop",
            message: assistantMessage({
              content: [{ type: "text", text: "done" }],
              stopReason: "stop",
            }),
          });
        }
        return stream;
      },
      initialState: { model: FAKE_MODEL, systemPrompt: "test", tools: [multiLineTool] },
    });
    const { lastFrame, stdin } = render(
      <App
        session={session}
        setup={NEVER_CALLED_SETUP}
        version="1.0.0"
        cwd="/test"
        runShellCommand={NEVER_CALLED_RUN_SHELL_COMMAND}
        slashCommands={NEVER_CALLED_SLASH_COMMANDS}
        spawnEditor={NEVER_CALLED_SPAWN_EDITOR}
        readClipboardImage={NEVER_CALLED_READ_CLIPBOARD_IMAGE}
        readClipboardText={NEVER_CALLED_READ_CLIPBOARD_TEXT}
        readDroppedFile={DEFAULT_READ_DROPPED_FILE}
      />,
    );

    await session.prompt("run something");
    await wait(20);

    // First cell settles under the default toolOutputExpanded=false: no output lines at all, just
    // the one-line summary. This tool has no `code` (empty `arguments: {}`), so the summary is
    // marker + language + line counts + expand hint.
    let frame = lastFrame() ?? "";
    expect(frame).toContain("multiline-tool");
    expect(frame).toContain("ctrl+o to expand");
    expect(frame).not.toContain("line one");
    expect(frame).not.toContain("line two");
    expect(frame).not.toContain("line three");

    stdin.write("\x0F"); // Ctrl+O -- toggles the live toggle for FUTURE items only.
    await wait(10);

    await session.prompt("run something again");
    await wait(20);

    frame = lastFrame() ?? "";
    // Both cells' summary lines mention "multiline-tool" -- pick them out in transcript order so
    // each cell's own hint can be checked independently of the other.
    const toolLines = frame.split("\n").filter((line) => line.includes("multiline-tool"));
    expect(toolLines).toHaveLength(2);
    // The FIRST cell (already settled before the toggle) is unchanged: still collapsed. This is
    // the single most important assertion in this test -- it proves ctrl+o did not retroactively
    // repaint already-frozen Static output.
    expect(toolLines[0]).toContain("ctrl+o to expand");
    // The SECOND cell (created after the toggle) renders expanded from the moment it appears, with
    // no need to toggle again.
    expect(toolLines[1]).toContain("ctrl+o to collapse");
    // The full output appears exactly once -- only for the second, expanded cell.
    expect(frame.match(/line one/g)).toHaveLength(1);
    expect(frame).toContain("line two");
    expect(frame).toContain("line three");
    expect(frame).not.toContain("waiting for code");
  });

  it("Ctrl+O does not leak a literal 'o' into text being composed in the prompt box", async () => {
    // Regression, found live by L4 VERIFY: ink-text-input registers its own internal useInput
    // hook, and Ink has no event-consumption mechanism between two independent useInput
    // listeners -- RunningSession's ctrl+o toggle and ink-text-input's own handler both used to
    // fire for the same keypress, and ink-text-input only special-cased ctrl+c/arrows/tab, so
    // ctrl+o fell through to its default branch and inserted a literal "o" into whatever the user
    // was typing. Fixed by replacing <TextInput> with a hand-rolled input that owns ctrl-filtering
    // itself (see PromptInput in app.tsx).
    const session = new Session({
      streamFn: () => fakeStream(),
      initialState: { model: FAKE_MODEL, systemPrompt: "test" },
    });
    const { lastFrame, stdin } = render(
      <App
        session={session}
        setup={NEVER_CALLED_SETUP}
        version="1.0.0"
        cwd="/test"
        runShellCommand={NEVER_CALLED_RUN_SHELL_COMMAND}
        slashCommands={NEVER_CALLED_SLASH_COMMANDS}
        spawnEditor={NEVER_CALLED_SPAWN_EDITOR}
        readClipboardImage={NEVER_CALLED_READ_CLIPBOARD_IMAGE}
        readClipboardText={NEVER_CALLED_READ_CLIPBOARD_TEXT}
        readDroppedFile={DEFAULT_READ_DROPPED_FILE}
      />,
    );

    for (const ch of "hi") {
      stdin.write(ch);
      await wait(5);
    }
    expect(lastFrame()).toContain("hi");

    stdin.write("\x0F"); // Ctrl+O
    await wait(10);

    const frame = lastFrame() ?? "";
    expect(frame).toContain("hi"); // still exactly "hi" ...
    expect(frame).not.toContain("hio"); // ... never leaked an "o" onto the end
  });

  it("starts in onboarding with no session, then switches to a genuinely working RunningSession once setup.finish() resolves", async () => {
    // Regression for an L4 VERIFY test-coverage gap: every other test here starts with a real
    // session already provided, and setup-screen.test.tsx only ever tests SetupScreen in
    // isolation -- nothing previously proved App's own sessionAtom actually swaps SetupScreen out
    // for RunningSession once onboarding completes.
    const stream = fakeStream();
    const readySession = new Session({
      streamFn: () => stream,
      initialState: { model: FAKE_MODEL, systemPrompt: "test" },
    });
    const controller: ModelSetupController = {
      listProviders: async () => [
        { id: "anthropic", name: "Anthropic", hasCredential: true, supportsApiKeyLogin: true },
      ],
      listModels: () => [{ id: "claude-sonnet-5", name: "Claude Sonnet 5" }],
      login: vi.fn(),
      finish: vi.fn(async () => readySession),
    };

    const { lastFrame, stdin } = render(
      <App
        session={undefined}
        setup={controller}
        version="0.0.0-test"
        cwd="/test/cwd"
        runShellCommand={NEVER_CALLED_RUN_SHELL_COMMAND}
        slashCommands={NEVER_CALLED_SLASH_COMMANDS}
        spawnEditor={NEVER_CALLED_SPAWN_EDITOR}
        readClipboardImage={NEVER_CALLED_READ_CLIPBOARD_IMAGE}
        readClipboardText={NEVER_CALLED_READ_CLIPBOARD_TEXT}
        readDroppedFile={DEFAULT_READ_DROPPED_FILE}
      />,
    );
    await wait(30);
    expect(lastFrame()).toContain("How would you like to authenticate?");

    stdin.write("\r"); // pick the (already-highlighted) "API Key" auth method
    await wait(30);
    expect(lastFrame()).toContain("Anthropic"); // onboarding is showing, not the prompt box

    stdin.write("\r"); // pick the (only, already-highlighted) provider
    await wait(30);
    stdin.write("\r"); // pick the (only, already-highlighted) model -> calls setup.finish()
    await wait(30);

    // RunningSession is now mounted: the prompt box appears, proving the switch happened.
    expect(lastFrame()).toContain("type a prompt");

    // And it's the REAL session finish() resolved, not a stand-in: driving it produces real
    // rendered output through the exact same event-subscription pipeline the other tests exercise.
    void readySession.prompt("hello");
    await wait(10);
    stream.push({ type: "start", partial: assistantMessage({ content: [] }) });
    stream.push({
      type: "done",
      reason: "stop",
      message: assistantMessage({
        content: [{ type: "text", text: "hi there" }],
        stopReason: "stop",
      }),
    });
    await wait(20);
    expect(lastFrame()).toContain("hi there");
  });
});

describe("App -- '!command' bash escape", () => {
  // ADR 0014 swapped the "!"/"!!" semantics from this project's original ADR 0012 behavior: a
  // single "!" now matches pi's own real "!" (output goes into REAL session.state.messages, so the
  // model sees it on its next turn -- no session.prompt() call happens just because of this,
  // exactly like pi); "!!" keeps nanocode's original excluded-from-context, local-only behavior.
  it("'!!command' shows the command and its result as a LOCAL-only You/tool:shell exchange, never touching session.state.messages or calling session.prompt", async () => {
    const streamFn = vi.fn(() => fakeStream());
    const session = new Session({
      streamFn,
      initialState: { model: FAKE_MODEL, systemPrompt: "test" },
    });
    const runShellCommand: RunShellCommand = vi.fn(async (command: string) => ({
      output: `ran: ${command}`,
      isError: false,
    }));
    const { lastFrame, stdin } = render(
      <App
        session={session}
        setup={NEVER_CALLED_SETUP}
        version="1.0.0"
        cwd="/test"
        runShellCommand={runShellCommand}
        slashCommands={NEVER_CALLED_SLASH_COMMANDS}
        spawnEditor={NEVER_CALLED_SPAWN_EDITOR}
        readClipboardImage={NEVER_CALLED_READ_CLIPBOARD_IMAGE}
        readClipboardText={NEVER_CALLED_READ_CLIPBOARD_TEXT}
        readDroppedFile={DEFAULT_READ_DROPPED_FILE}
      />,
    );

    // Real per-keystroke stdin, not one combined write -- see the "actually submits via the real
    // <TextInput> wiring" test above for why a single write() call can't be trusted here.
    for (const ch of "!!echo hi") {
      stdin.write(ch);
      await wait(5);
    }
    stdin.write("\r");
    await wait(20);

    expect(runShellCommand).toHaveBeenCalledWith("echo hi");
    // session.prompt() is NEVER called for a "!!" bang command -- the fake streamFn would have
    // fired if it had been, and "!!"'s whole point is staying OUT of the model's own context, so
    // the real session's own message history stays completely empty.
    expect(streamFn).not.toHaveBeenCalled();
    expect(session.state.messages).toHaveLength(0);

    const frame = lastFrame() ?? "";
    // NOTE: buildBangCommandEntries (app.tsx) hardcodes a single "!" onto the displayed user
    // entry regardless of whether "!" or "!!" was actually typed -- the transcript can't visually
    // distinguish the two, only the routing (local-only vs real session.state.messages, asserted
    // above) actually differs. Asserting the real displayed text here rather than the literal
    // typed "!!echo hi", which never appears anywhere in the transcript.
    expect(frame).toContain("!echo hi");
    // The synthetic shell entry renders as a tool cell with "shell" as its language label and the
    // command itself as its code preview -- collapsed by default, so the result text ("ran: echo
    // hi") is NOT shown yet (only the cell's own describes-this-purpose test checks expansion).
    expect(frame).toContain("shell");
    expect(frame).toContain("echo hi");
    expect(frame).not.toContain("ran: echo hi");
  });

  it("a single '!command' pushes the {user, toolResult} pair into REAL session.state.messages (pi's own semantics), still never calling session.prompt/streamFn itself", async () => {
    const streamFn = vi.fn(() => fakeStream());
    const session = new Session({
      streamFn,
      initialState: { model: FAKE_MODEL, systemPrompt: "test" },
    });
    const runShellCommand: RunShellCommand = vi.fn(async (command: string) => ({
      output: `ran: ${command}`,
      isError: false,
    }));
    const { lastFrame, stdin } = render(
      <App
        session={session}
        setup={NEVER_CALLED_SETUP}
        version="1.0.0"
        cwd="/test"
        runShellCommand={runShellCommand}
        slashCommands={NEVER_CALLED_SLASH_COMMANDS}
        spawnEditor={NEVER_CALLED_SPAWN_EDITOR}
        readClipboardImage={NEVER_CALLED_READ_CLIPBOARD_IMAGE}
        readClipboardText={NEVER_CALLED_READ_CLIPBOARD_TEXT}
        readDroppedFile={DEFAULT_READ_DROPPED_FILE}
      />,
    );

    for (const ch of "!echo hi") {
      stdin.write(ch);
      await wait(5);
    }
    stdin.write("\r");
    await wait(20);

    expect(runShellCommand).toHaveBeenCalledWith("echo hi");
    // The model is never actually prompted just because of a single "!" -- only the NEXT real
    // turn would see this in context, matching pi's exact behavior (a synthetic exchange appended
    // to history, no session.prompt()/streamFn call of its own).
    expect(streamFn).not.toHaveBeenCalled();

    // Exactly the {user, toolResult} pair handleSubmit's buildBangCommandEntries builds -- pushed
    // into REAL session.state.messages this time, not the local-only atom "!!" uses.
    expect(session.state.messages).toHaveLength(2);
    const [userEntry, resultEntry] = session.state.messages as [
      { role: string; content: unknown },
      { role: string; toolName?: string; content: unknown; isError?: boolean },
    ];
    expect(userEntry.role).toBe("user");
    expect(userEntry.content).toEqual([{ type: "text", text: "!echo hi" }]);
    expect(resultEntry.role).toBe("toolResult");
    expect(resultEntry.toolName).toBe("shell");
    expect(resultEntry.content).toEqual([{ type: "text", text: "ran: echo hi" }]);
    expect(resultEntry.isError).toBe(false);

    const frame = lastFrame() ?? "";
    expect(frame).toContain("!echo hi");
    // Same tool-cell shape as the "!!" test above: "shell" language label + the command as its
    // code preview, collapsed by default so the result text isn't shown yet.
    expect(frame).toContain("shell");
    expect(frame).toContain("echo hi");
    expect(frame).not.toContain("ran: echo hi");
  });

  it("toggles busy while the shell command is in flight, then clears it once it resolves", async () => {
    const session = new Session({
      streamFn: () => fakeStream(),
      initialState: { model: FAKE_MODEL, systemPrompt: "test" },
    });
    let resolveRun: ((result: { output: string; isError: boolean }) => void) | undefined;
    const runShellCommand: RunShellCommand = vi.fn(
      () =>
        new Promise<{ output: string; isError: boolean }>((resolve) => {
          resolveRun = resolve;
        }),
    );
    const { lastFrame, stdin } = render(
      <App
        session={session}
        setup={NEVER_CALLED_SETUP}
        version="1.0.0"
        cwd="/test"
        runShellCommand={runShellCommand}
        slashCommands={NEVER_CALLED_SLASH_COMMANDS}
        spawnEditor={NEVER_CALLED_SPAWN_EDITOR}
        readClipboardImage={NEVER_CALLED_READ_CLIPBOARD_IMAGE}
        readClipboardText={NEVER_CALLED_READ_CLIPBOARD_TEXT}
        readDroppedFile={DEFAULT_READ_DROPPED_FILE}
      />,
    );

    for (const ch of "!sleep 1") {
      stdin.write(ch);
      await wait(5);
    }
    stdin.write("\r");
    await wait(20);

    let frame = lastFrame() ?? "";
    expect(frame).toContain("… "); // the prompt box's own busy indicator
    expect(frame).toContain("working…"); // box is empty while busy -- shows the busy placeholder

    resolveRun?.({ output: "done", isError: false });
    await wait(20);

    frame = lastFrame() ?? "";
    expect(frame).not.toContain("… ");
    expect(frame).toContain("type a prompt (or !command, /command), enter to send"); // idle again
  });

  it("a bare '!' with nothing after it is a no-op", async () => {
    const session = new Session({
      streamFn: () => fakeStream(),
      initialState: { model: FAKE_MODEL, systemPrompt: "test" },
    });
    const runShellCommand: RunShellCommand = vi.fn();
    const { lastFrame, stdin } = render(
      <App
        session={session}
        setup={NEVER_CALLED_SETUP}
        version="1.0.0"
        cwd="/test"
        runShellCommand={runShellCommand}
        slashCommands={NEVER_CALLED_SLASH_COMMANDS}
        spawnEditor={NEVER_CALLED_SPAWN_EDITOR}
        readClipboardImage={NEVER_CALLED_READ_CLIPBOARD_IMAGE}
        readClipboardText={NEVER_CALLED_READ_CLIPBOARD_TEXT}
        readDroppedFile={DEFAULT_READ_DROPPED_FILE}
      />,
    );

    stdin.write("!");
    await wait(5);
    stdin.write("\r");
    await wait(20);

    expect(runShellCommand).not.toHaveBeenCalled();
    const frame = lastFrame() ?? "";
    // The input box clears (handleSubmit's setInput("") runs before the empty-command check) and
    // falls back to its placeholder -- but nothing else happens: no busy state, no new transcript
    // entry, no session.prompt() call.
    expect(frame).toContain("type a prompt (or !command, /command), enter to send");
    expect(frame).not.toContain("busy");
    expect(session.state.messages).toHaveLength(0);
  });

  it("reports a rejected runShellCommand the same way a failed chat prompt is reported", async () => {
    const session = new Session({
      streamFn: () => fakeStream(),
      initialState: { model: FAKE_MODEL, systemPrompt: "test" },
    });
    const runShellCommand: RunShellCommand = vi.fn(async () => {
      throw new Error("kernel is not running");
    });
    const { lastFrame, stdin } = render(
      <App
        session={session}
        setup={NEVER_CALLED_SETUP}
        version="1.0.0"
        cwd="/test"
        runShellCommand={runShellCommand}
        slashCommands={NEVER_CALLED_SLASH_COMMANDS}
        spawnEditor={NEVER_CALLED_SPAWN_EDITOR}
        readClipboardImage={NEVER_CALLED_READ_CLIPBOARD_IMAGE}
        readClipboardText={NEVER_CALLED_READ_CLIPBOARD_TEXT}
        readDroppedFile={DEFAULT_READ_DROPPED_FILE}
      />,
    );

    for (const ch of "!echo hi") {
      stdin.write(ch);
      await wait(5);
    }
    stdin.write("\r");
    await wait(20);

    const frame = lastFrame() ?? "";
    expect(frame).toContain("kernel is not running");
    expect(frame).not.toContain("… "); // busy was cleared, same as a failed chat prompt
  });

  it("ctrl+o only affects bang-command tool cells created after the toggle, not ones already settled", async () => {
    // Same "already-frozen cells don't retroactively repaint" behavior proven for real tool calls
    // above, here for the synthetic toolResult entry a bang command produces (buildBangCommandEntries
    // in app.tsx) -- it goes through the same ToolCellItem/<Static> path. Runs TWO bang commands with
    // distinct command text so each becomes its own transcript item that can be told apart in the
    // rendered frame.
    const session = new Session({
      streamFn: () => fakeStream(),
      initialState: { model: FAKE_MODEL, systemPrompt: "test" },
    });
    const runShellCommand: RunShellCommand = vi.fn(async () => ({
      output: "line one\nline two\nline three",
      isError: false,
    }));
    const { lastFrame, stdin } = render(
      <App
        session={session}
        setup={NEVER_CALLED_SETUP}
        version="1.0.0"
        cwd="/test"
        runShellCommand={runShellCommand}
        slashCommands={NEVER_CALLED_SLASH_COMMANDS}
        spawnEditor={NEVER_CALLED_SPAWN_EDITOR}
        readClipboardImage={NEVER_CALLED_READ_CLIPBOARD_IMAGE}
        readClipboardText={NEVER_CALLED_READ_CLIPBOARD_TEXT}
        readDroppedFile={DEFAULT_READ_DROPPED_FILE}
      />,
    );

    for (const ch of "!cat file") {
      stdin.write(ch);
      await wait(5);
    }
    stdin.write("\r");
    await wait(20);

    // First cell settles under the default toolOutputExpanded=false: no output lines at all --
    // just the one-line summary (language "shell" + the command itself as the code preview).
    let frame = lastFrame() ?? "";
    expect(frame).toContain("shell");
    expect(frame).toContain("cat file");
    expect(frame).toContain("ctrl+o to expand");
    expect(frame).not.toContain("line one");
    expect(frame).not.toContain("line two");
    expect(frame).not.toContain("line three");

    stdin.write("\x0F"); // Ctrl+O -- toggles the live toggle for FUTURE items only.
    await wait(10);

    for (const ch of "!cat file2") {
      stdin.write(ch);
      await wait(5);
    }
    stdin.write("\r");
    await wait(20);

    frame = lastFrame() ?? "";
    const lines = frame.split("\n");
    // "cat file2" contains "cat file" as a substring, so the first cell's own line is picked out by
    // excluding any line that also mentions "cat file2".
    const firstCellLines = lines.filter(
      (line) => line.includes("cat file") && !line.includes("cat file2"),
    );
    const secondCellLines = lines.filter((line) => line.includes("cat file2"));
    expect(firstCellLines.length).toBeGreaterThan(0);
    expect(secondCellLines.length).toBeGreaterThan(0);
    // The FIRST cell (already settled before the toggle) is unchanged: still collapsed. This is
    // the key assertion -- it proves ctrl+o did not retroactively repaint already-frozen output.
    expect(firstCellLines.some((line) => line.includes("ctrl+o to expand"))).toBe(true);
    // The SECOND cell (created after the toggle) renders expanded from the moment it appears.
    expect(secondCellLines.some((line) => line.includes("ctrl+o to collapse"))).toBe(true);
    expect(frame).toContain("line one");
    expect(frame).toContain("line two");
    expect(frame).toContain("line three");
  });
});

/** Same idea as `NEVER_CALLED_SLASH_COMMANDS` above, but lets one specific test override only the
 * method(s) it means to exercise -- every other method still throws "should never be called",
 * matching command-overlay.test.tsx's own `fakeController` helper. */
function fakeSlashCommands(overrides: Partial<SlashCommandController>): SlashCommandController {
  return { ...NEVER_CALLED_SLASH_COMMANDS, ...overrides };
}

/** A second, distinct model -- used by the "/new" test to prove the swapped-in session is genuinely
 * new (different model identity), not just a re-render of the same one. */
const MODEL_TWO: Model<Api> = {
  ...FAKE_MODEL,
  id: "second-model",
  provider: "second-provider",
};

describe("App -- '/command' dispatch", () => {
  it("/help lists every command's usage and description", async () => {
    const session = new Session({
      streamFn: () => fakeStream(),
      initialState: { model: FAKE_MODEL, systemPrompt: "test" },
    });
    const { lastFrame, stdin } = render(
      <App
        session={session}
        setup={NEVER_CALLED_SETUP}
        version="1.0.0"
        cwd="/test"
        runShellCommand={NEVER_CALLED_RUN_SHELL_COMMAND}
        slashCommands={NEVER_CALLED_SLASH_COMMANDS}
        spawnEditor={NEVER_CALLED_SPAWN_EDITOR}
        readClipboardImage={NEVER_CALLED_READ_CLIPBOARD_IMAGE}
        readClipboardText={NEVER_CALLED_READ_CLIPBOARD_TEXT}
        readDroppedFile={DEFAULT_READ_DROPPED_FILE}
      />,
    );

    for (const ch of "/help") {
      stdin.write(ch);
      await wait(5);
    }
    stdin.write("\r");
    await wait(20);
    stdin.write("\x0F"); // Ctrl+O -- multi-line tool output starts collapsed to its first line
    await wait(10);

    const frame = lastFrame() ?? "";
    for (const command of SLASH_COMMANDS) {
      expect(frame).toContain(command.usage);
      expect(frame).toContain(command.description);
    }
  });

  it("/status shows model/reasoning/tokens/cost, calling no slashCommands method", async () => {
    const session = new Session({
      streamFn: () => fakeStream(),
      initialState: { model: FAKE_MODEL, systemPrompt: "test" },
    });
    const { lastFrame, stdin } = render(
      <App
        session={session}
        setup={NEVER_CALLED_SETUP}
        version="1.0.0"
        cwd="/test"
        runShellCommand={NEVER_CALLED_RUN_SHELL_COMMAND}
        slashCommands={NEVER_CALLED_SLASH_COMMANDS}
        spawnEditor={NEVER_CALLED_SPAWN_EDITOR}
        readClipboardImage={NEVER_CALLED_READ_CLIPBOARD_IMAGE}
        readClipboardText={NEVER_CALLED_READ_CLIPBOARD_TEXT}
        readDroppedFile={DEFAULT_READ_DROPPED_FILE}
      />,
    );

    for (const ch of "/status") {
      stdin.write(ch);
      await wait(5);
    }
    stdin.write("\r");
    await wait(20);
    stdin.write("\x0F"); // Ctrl+O -- multi-line tool output starts collapsed to its first line
    await wait(10);

    const frame = lastFrame() ?? "";
    expect(frame).toContain("model: fake-provider/fake-model");
    expect(frame).toContain("reasoning: off");
    expect(frame).toContain("tokens: ↑0 ↓0");
    expect(frame).toContain("context: 0/200000");
    expect(frame).toContain("cost: $0.0000");
  });

  it("/context shows a detailed context-window breakdown, calling no slashCommands method", async () => {
    const session = new Session({
      streamFn: () => fakeStream(),
      initialState: { model: FAKE_MODEL, systemPrompt: "test" },
    });
    const { lastFrame, stdin } = render(
      <App
        session={session}
        setup={NEVER_CALLED_SETUP}
        version="1.0.0"
        cwd="/test"
        runShellCommand={NEVER_CALLED_RUN_SHELL_COMMAND}
        slashCommands={NEVER_CALLED_SLASH_COMMANDS}
        spawnEditor={NEVER_CALLED_SPAWN_EDITOR}
        readClipboardImage={NEVER_CALLED_READ_CLIPBOARD_IMAGE}
        readClipboardText={NEVER_CALLED_READ_CLIPBOARD_TEXT}
        readDroppedFile={DEFAULT_READ_DROPPED_FILE}
      />,
    );

    for (const ch of "/context") {
      stdin.write(ch);
      await wait(5);
    }
    stdin.write("\r");
    await wait(20);
    stdin.write("\x0F"); // Ctrl+O -- multi-line tool output starts collapsed to its first line
    await wait(10);

    const frame = lastFrame() ?? "";
    expect(frame).toContain("context window: 0 / 200000 tokens (0.0%)");
    expect(frame).toContain("messages: 0");
    expect(frame).toContain("cumulative tokens: ↑0 ↓0");
    expect(frame).toContain("cumulative cost: $0.0000");
    expect(frame).toContain("model: fake-provider/fake-model");
  });

  it("/settings shows current configuration, calling no slashCommands method", async () => {
    const session = new Session({
      streamFn: () => fakeStream(),
      initialState: { model: FAKE_MODEL, systemPrompt: "test" },
    });
    const { lastFrame, stdin } = render(
      <App
        session={session}
        setup={NEVER_CALLED_SETUP}
        version="1.0.0"
        cwd="/settings/test/cwd"
        runShellCommand={NEVER_CALLED_RUN_SHELL_COMMAND}
        slashCommands={NEVER_CALLED_SLASH_COMMANDS}
        spawnEditor={NEVER_CALLED_SPAWN_EDITOR}
        readClipboardImage={NEVER_CALLED_READ_CLIPBOARD_IMAGE}
        readClipboardText={NEVER_CALLED_READ_CLIPBOARD_TEXT}
        readDroppedFile={DEFAULT_READ_DROPPED_FILE}
      />,
    );

    for (const ch of "/settings") {
      stdin.write(ch);
      await wait(5);
    }
    stdin.write("\r");
    await wait(20);
    stdin.write("\x0F"); // Ctrl+O -- multi-line tool output starts collapsed to its first line
    await wait(10);

    const frame = lastFrame() ?? "";
    expect(frame).toContain("cwd: /settings/test/cwd");
    expect(frame).toContain("provider/model: fake-provider/fake-model");
    expect(frame).toContain("reasoning effort: off");
    expect(frame).toContain("credentials: ~/.nanocode/credentials.json");
    expect(frame).toContain("model selection: ~/.nanocode/model-selection.json");
    expect(frame).toContain("trust: ~/.nanocode/trust.json");
  });

  it("/diff runs 'git diff' via runShellCommand and shows its output in the transcript", async () => {
    const runShellCommand: RunShellCommand = vi.fn(async (command: string) => ({
      output: `diff output for: ${command}`,
      isError: false,
    }));
    const session = new Session({
      streamFn: () => fakeStream(),
      initialState: { model: FAKE_MODEL, systemPrompt: "test" },
    });
    const { lastFrame, stdin } = render(
      <App
        session={session}
        setup={NEVER_CALLED_SETUP}
        version="1.0.0"
        cwd="/test"
        runShellCommand={runShellCommand}
        slashCommands={NEVER_CALLED_SLASH_COMMANDS}
        spawnEditor={NEVER_CALLED_SPAWN_EDITOR}
        readClipboardImage={NEVER_CALLED_READ_CLIPBOARD_IMAGE}
        readClipboardText={NEVER_CALLED_READ_CLIPBOARD_TEXT}
        readDroppedFile={DEFAULT_READ_DROPPED_FILE}
      />,
    );

    for (const ch of "/diff") {
      stdin.write(ch);
      await wait(5);
    }
    stdin.write("\r");
    await wait(20);

    expect(runShellCommand).toHaveBeenCalledWith("git diff");
    expect(lastFrame()).toContain("diff output for: git diff");
  });

  it("/copy calls slashCommands.copyToClipboard with the last assistant message's text", async () => {
    const stream = fakeStream();
    const session = new Session({
      streamFn: () => stream,
      initialState: { model: FAKE_MODEL, systemPrompt: "test" },
    });
    void session.prompt("hello");
    await wait(10);
    stream.push({
      type: "done",
      reason: "stop",
      message: assistantMessage({
        content: [{ type: "text", text: "Hello world" }],
        stopReason: "stop",
      }),
    });
    await wait(20);

    const copyToClipboard = vi.fn(async () => {});
    const slashCommands = fakeSlashCommands({ copyToClipboard });
    const { lastFrame, stdin } = render(
      <App
        session={session}
        setup={NEVER_CALLED_SETUP}
        version="1.0.0"
        cwd="/test"
        runShellCommand={NEVER_CALLED_RUN_SHELL_COMMAND}
        slashCommands={slashCommands}
        spawnEditor={NEVER_CALLED_SPAWN_EDITOR}
        readClipboardImage={NEVER_CALLED_READ_CLIPBOARD_IMAGE}
        readClipboardText={NEVER_CALLED_READ_CLIPBOARD_TEXT}
        readDroppedFile={DEFAULT_READ_DROPPED_FILE}
      />,
    );

    for (const ch of "/copy") {
      stdin.write(ch);
      await wait(5);
    }
    stdin.write("\r");
    await wait(20);

    expect(copyToClipboard).toHaveBeenCalledWith("Hello world");
    expect(lastFrame()).toContain("Copied last response to clipboard.");
  });

  it("/copy with no assistant message yet shows 'Nothing to copy yet.' without calling copyToClipboard", async () => {
    const copyToClipboard = vi.fn(async () => {});
    const slashCommands = fakeSlashCommands({ copyToClipboard });
    const session = new Session({
      streamFn: () => fakeStream(),
      initialState: { model: FAKE_MODEL, systemPrompt: "test" },
    });
    const { lastFrame, stdin } = render(
      <App
        session={session}
        setup={NEVER_CALLED_SETUP}
        version="1.0.0"
        cwd="/test"
        runShellCommand={NEVER_CALLED_RUN_SHELL_COMMAND}
        slashCommands={slashCommands}
        spawnEditor={NEVER_CALLED_SPAWN_EDITOR}
        readClipboardImage={NEVER_CALLED_READ_CLIPBOARD_IMAGE}
        readClipboardText={NEVER_CALLED_READ_CLIPBOARD_TEXT}
        readDroppedFile={DEFAULT_READ_DROPPED_FILE}
      />,
    );

    for (const ch of "/copy") {
      stdin.write(ch);
      await wait(5);
    }
    stdin.write("\r");
    await wait(20);

    expect(lastFrame()).toContain("Nothing to copy yet.");
    expect(copyToClipboard).not.toHaveBeenCalled();
  });

  it("/export exports as json by default and shows the returned path", async () => {
    const exportTranscript = vi.fn(async (_content: string, extension: string) => {
      return `/tmp/nanocode-export.${extension}`;
    });
    const slashCommands = fakeSlashCommands({ exportTranscript });
    const session = new Session({
      streamFn: () => fakeStream(),
      initialState: { model: FAKE_MODEL, systemPrompt: "test" },
    });
    const { lastFrame, stdin } = render(
      <App
        session={session}
        setup={NEVER_CALLED_SETUP}
        version="1.0.0"
        cwd="/test"
        runShellCommand={NEVER_CALLED_RUN_SHELL_COMMAND}
        slashCommands={slashCommands}
        spawnEditor={NEVER_CALLED_SPAWN_EDITOR}
        readClipboardImage={NEVER_CALLED_READ_CLIPBOARD_IMAGE}
        readClipboardText={NEVER_CALLED_READ_CLIPBOARD_TEXT}
        readDroppedFile={DEFAULT_READ_DROPPED_FILE}
      />,
    );

    for (const ch of "/export") {
      stdin.write(ch);
      await wait(5);
    }
    stdin.write("\r");
    await wait(20);

    expect(exportTranscript).toHaveBeenCalledWith(expect.any(String), "json");
    expect(lastFrame()).toContain("Exported to /tmp/nanocode-export.json");
  });

  it("/export md exports as markdown and shows the returned path", async () => {
    const exportTranscript = vi.fn(async (_content: string, extension: string) => {
      return `/tmp/nanocode-export.${extension}`;
    });
    const slashCommands = fakeSlashCommands({ exportTranscript });
    const session = new Session({
      streamFn: () => fakeStream(),
      initialState: { model: FAKE_MODEL, systemPrompt: "test" },
    });
    const { lastFrame, stdin } = render(
      <App
        session={session}
        setup={NEVER_CALLED_SETUP}
        version="1.0.0"
        cwd="/test"
        runShellCommand={NEVER_CALLED_RUN_SHELL_COMMAND}
        slashCommands={slashCommands}
        spawnEditor={NEVER_CALLED_SPAWN_EDITOR}
        readClipboardImage={NEVER_CALLED_READ_CLIPBOARD_IMAGE}
        readClipboardText={NEVER_CALLED_READ_CLIPBOARD_TEXT}
        readDroppedFile={DEFAULT_READ_DROPPED_FILE}
      />,
    );

    for (const ch of "/export md") {
      stdin.write(ch);
      await wait(5);
    }
    stdin.write("\r");
    await wait(20);

    expect(exportTranscript).toHaveBeenCalledWith(expect.any(String), "md");
    expect(lastFrame()).toContain("Exported to /tmp/nanocode-export.md");
  });

  it("/init calls session.prompt with a non-empty scanning prompt, using the normal busy lifecycle", async () => {
    const stream = fakeStream();
    const session = new Session({
      streamFn: () => stream,
      initialState: { model: FAKE_MODEL, systemPrompt: "test" },
    });
    const promptSpy = vi.spyOn(session, "prompt");
    const { lastFrame, stdin } = render(
      <App
        session={session}
        setup={NEVER_CALLED_SETUP}
        version="1.0.0"
        cwd="/test"
        runShellCommand={NEVER_CALLED_RUN_SHELL_COMMAND}
        slashCommands={NEVER_CALLED_SLASH_COMMANDS}
        spawnEditor={NEVER_CALLED_SPAWN_EDITOR}
        readClipboardImage={NEVER_CALLED_READ_CLIPBOARD_IMAGE}
        readClipboardText={NEVER_CALLED_READ_CLIPBOARD_TEXT}
        readDroppedFile={DEFAULT_READ_DROPPED_FILE}
      />,
    );

    for (const ch of "/init") {
      stdin.write(ch);
      await wait(5);
    }
    stdin.write("\r");
    await wait(20);

    expect(promptSpy).toHaveBeenCalledTimes(1);
    const [promptArg] = promptSpy.mock.calls[0] as [unknown];
    expect(typeof promptArg).toBe("string");
    expect(promptArg as string).toContain("AGENTS.md"); // /init's own hardcoded prompt text

    let frame = lastFrame() ?? "";
    expect(frame).toContain("… "); // busy indicator, same as a normal prompt submission
    expect(frame).toContain("working…"); // box is empty while busy -- shows the busy placeholder

    stream.push({
      type: "done",
      reason: "stop",
      message: assistantMessage({
        content: [{ type: "text", text: "scanned" }],
        stopReason: "stop",
      }),
    });
    await wait(20);

    frame = lastFrame() ?? "";
    expect(frame).not.toContain("… ");
    expect(frame).toContain("type a prompt (or !command, /command), enter to send"); // idle again
  });

  it("/new swaps in a brand-new session on success", async () => {
    const stream1 = fakeStream();
    const session1 = new Session({
      streamFn: () => stream1,
      initialState: { model: FAKE_MODEL, systemPrompt: "test" },
    });
    void session1.prompt("hello from session one");
    await wait(10);
    stream1.push({
      type: "done",
      reason: "stop",
      message: assistantMessage({
        content: [{ type: "text", text: "reply one" }],
        stopReason: "stop",
      }),
    });
    await wait(20);

    const session2 = new Session({
      streamFn: () => fakeStream(),
      initialState: { model: MODEL_TWO, systemPrompt: "test" },
    });
    const startNewSession = vi.fn(async () => session2);
    const slashCommands = fakeSlashCommands({ startNewSession });

    const { lastFrame, stdin } = render(
      <App
        session={session1}
        setup={NEVER_CALLED_SETUP}
        version="1.0.0"
        cwd="/test"
        runShellCommand={NEVER_CALLED_RUN_SHELL_COMMAND}
        slashCommands={slashCommands}
        spawnEditor={NEVER_CALLED_SPAWN_EDITOR}
        readClipboardImage={NEVER_CALLED_READ_CLIPBOARD_IMAGE}
        readClipboardText={NEVER_CALLED_READ_CLIPBOARD_TEXT}
        readDroppedFile={DEFAULT_READ_DROPPED_FILE}
      />,
    );

    let frame = lastFrame() ?? "";
    expect(frame).toContain("reply one");
    expect(frame).toContain("fake-provider/fake-model");

    for (const ch of "/new") {
      stdin.write(ch);
      await wait(5);
    }
    stdin.write("\r");
    await wait(30);

    expect(startNewSession).toHaveBeenCalledTimes(1);

    frame = lastFrame() ?? "";
    // The status line's model label now reflects session2, not session1 -- proof RunningSession
    // actually swapped to the NEW session identity, not just re-rendering the old one.
    expect(frame).toContain("second-provider/second-model");
    expect(frame).not.toContain("fake-provider/fake-model");
    expect(frame).not.toContain("reply one"); // session1's own message is gone from the transcript
  });

  it("/new shows the rejection's error message and calls nothing but startNewSession", async () => {
    const session = new Session({
      streamFn: () => fakeStream(),
      initialState: { model: FAKE_MODEL, systemPrompt: "test" },
    });
    const startNewSession = vi.fn(async () => {
      throw new Error("cannot start new session");
    });
    const slashCommands = fakeSlashCommands({ startNewSession });
    const { lastFrame, stdin } = render(
      <App
        session={session}
        setup={NEVER_CALLED_SETUP}
        version="1.0.0"
        cwd="/test"
        runShellCommand={NEVER_CALLED_RUN_SHELL_COMMAND}
        slashCommands={slashCommands}
        spawnEditor={NEVER_CALLED_SPAWN_EDITOR}
        readClipboardImage={NEVER_CALLED_READ_CLIPBOARD_IMAGE}
        readClipboardText={NEVER_CALLED_READ_CLIPBOARD_TEXT}
        readDroppedFile={DEFAULT_READ_DROPPED_FILE}
      />,
    );

    for (const ch of "/new") {
      stdin.write(ch);
      await wait(5);
    }
    stdin.write("\r");
    await wait(20);

    expect(startNewSession).toHaveBeenCalledTimes(1);
    expect(lastFrame()).toContain("cannot start new session");
  });

  it("/compact shows 'Compacted older conversation history.' when session.compact() resolves true", async () => {
    const session = new Session({
      streamFn: () => fakeStream(),
      initialState: { model: FAKE_MODEL, systemPrompt: "test" },
    });
    vi.spyOn(session, "compact").mockResolvedValue(true);
    const { lastFrame, stdin } = render(
      <App
        session={session}
        setup={NEVER_CALLED_SETUP}
        version="1.0.0"
        cwd="/test"
        runShellCommand={NEVER_CALLED_RUN_SHELL_COMMAND}
        slashCommands={NEVER_CALLED_SLASH_COMMANDS}
        spawnEditor={NEVER_CALLED_SPAWN_EDITOR}
        readClipboardImage={NEVER_CALLED_READ_CLIPBOARD_IMAGE}
        readClipboardText={NEVER_CALLED_READ_CLIPBOARD_TEXT}
        readDroppedFile={DEFAULT_READ_DROPPED_FILE}
      />,
    );

    for (const ch of "/compact") {
      stdin.write(ch);
      await wait(5);
    }
    stdin.write("\r");
    await wait(20);

    expect(lastFrame()).toContain("Compacted older conversation history.");
  });

  it("/compact shows 'Nothing to compact yet.' when session.compact() resolves false", async () => {
    const session = new Session({
      streamFn: () => fakeStream(),
      initialState: { model: FAKE_MODEL, systemPrompt: "test" },
    });
    vi.spyOn(session, "compact").mockResolvedValue(false);
    const { lastFrame, stdin } = render(
      <App
        session={session}
        setup={NEVER_CALLED_SETUP}
        version="1.0.0"
        cwd="/test"
        runShellCommand={NEVER_CALLED_RUN_SHELL_COMMAND}
        slashCommands={NEVER_CALLED_SLASH_COMMANDS}
        spawnEditor={NEVER_CALLED_SPAWN_EDITOR}
        readClipboardImage={NEVER_CALLED_READ_CLIPBOARD_IMAGE}
        readClipboardText={NEVER_CALLED_READ_CLIPBOARD_TEXT}
        readDroppedFile={DEFAULT_READ_DROPPED_FILE}
      />,
    );

    for (const ch of "/compact") {
      stdin.write(ch);
      await wait(5);
    }
    stdin.write("\r");
    await wait(20);

    expect(lastFrame()).toContain("Nothing to compact yet.");
  });

  it("/logout <provider> calls slashCommands.logout with the given provider", async () => {
    const logout = vi.fn(async () => {});
    const slashCommands = fakeSlashCommands({ logout });
    const session = new Session({
      streamFn: () => fakeStream(),
      initialState: { model: FAKE_MODEL, systemPrompt: "test" },
    });
    const { lastFrame, stdin } = render(
      <App
        session={session}
        setup={NEVER_CALLED_SETUP}
        version="1.0.0"
        cwd="/test"
        runShellCommand={NEVER_CALLED_RUN_SHELL_COMMAND}
        slashCommands={slashCommands}
        spawnEditor={NEVER_CALLED_SPAWN_EDITOR}
        readClipboardImage={NEVER_CALLED_READ_CLIPBOARD_IMAGE}
        readClipboardText={NEVER_CALLED_READ_CLIPBOARD_TEXT}
        readDroppedFile={DEFAULT_READ_DROPPED_FILE}
      />,
    );

    for (const ch of "/logout openrouter") {
      stdin.write(ch);
      await wait(5);
    }
    stdin.write("\r");
    await wait(20);

    expect(logout).toHaveBeenCalledWith("openrouter");
    expect(lastFrame()).toContain("Logged out of openrouter.");
  });

  it("/logout with no argument uses the current session's own model provider", async () => {
    const logout = vi.fn(async () => {});
    const slashCommands = fakeSlashCommands({ logout });
    const session = new Session({
      streamFn: () => fakeStream(),
      initialState: { model: FAKE_MODEL, systemPrompt: "test" }, // FAKE_MODEL.provider === "fake-provider"
    });
    const { lastFrame, stdin } = render(
      <App
        session={session}
        setup={NEVER_CALLED_SETUP}
        version="1.0.0"
        cwd="/test"
        runShellCommand={NEVER_CALLED_RUN_SHELL_COMMAND}
        slashCommands={slashCommands}
        spawnEditor={NEVER_CALLED_SPAWN_EDITOR}
        readClipboardImage={NEVER_CALLED_READ_CLIPBOARD_IMAGE}
        readClipboardText={NEVER_CALLED_READ_CLIPBOARD_TEXT}
        readDroppedFile={DEFAULT_READ_DROPPED_FILE}
      />,
    );

    for (const ch of "/logout") {
      stdin.write(ch);
      await wait(5);
    }
    stdin.write("\r");
    await wait(20);

    expect(logout).toHaveBeenCalledWith("fake-provider");
    expect(lastFrame()).toContain("Logged out of fake-provider.");
  });

  it("/effort xhigh mutates session.state.thinkingLevel directly, calling no slashCommands method", async () => {
    const session = new Session({
      streamFn: () => fakeStream(),
      initialState: { model: FAKE_MODEL, systemPrompt: "test", thinkingLevel: "low" },
    });
    const { stdin } = render(
      <App
        session={session}
        setup={NEVER_CALLED_SETUP}
        version="1.0.0"
        cwd="/test"
        runShellCommand={NEVER_CALLED_RUN_SHELL_COMMAND}
        slashCommands={NEVER_CALLED_SLASH_COMMANDS}
        spawnEditor={NEVER_CALLED_SPAWN_EDITOR}
        readClipboardImage={NEVER_CALLED_READ_CLIPBOARD_IMAGE}
        readClipboardText={NEVER_CALLED_READ_CLIPBOARD_TEXT}
        readDroppedFile={DEFAULT_READ_DROPPED_FILE}
      />,
    );

    for (const ch of "/effort xhigh") {
      stdin.write(ch);
      await wait(5);
    }
    stdin.write("\r");
    await wait(20);

    expect(session.state.thinkingLevel).toBe("xhigh");
  });

  it("/effort bogus opens the overlay seeded with 'bogus', shows the no-match message, and enter leaves thinkingLevel unchanged", async () => {
    const session = new Session({
      streamFn: () => fakeStream(),
      initialState: { model: FAKE_MODEL, systemPrompt: "test", thinkingLevel: "low" },
    });
    const { lastFrame, stdin } = render(
      <App
        session={session}
        setup={NEVER_CALLED_SETUP}
        version="1.0.0"
        cwd="/test"
        runShellCommand={NEVER_CALLED_RUN_SHELL_COMMAND}
        slashCommands={NEVER_CALLED_SLASH_COMMANDS}
        spawnEditor={NEVER_CALLED_SPAWN_EDITOR}
        readClipboardImage={NEVER_CALLED_READ_CLIPBOARD_IMAGE}
        readClipboardText={NEVER_CALLED_READ_CLIPBOARD_TEXT}
        readDroppedFile={DEFAULT_READ_DROPPED_FILE}
      />,
    );

    for (const ch of "/effort bogus") {
      stdin.write(ch);
      await wait(5);
    }
    stdin.write("\r");
    await wait(20);

    const frame = lastFrame() ?? "";
    expect(frame).toContain(
      "Reasoning effort for future turns (type to search, ↑↓ to pick, enter to confirm):",
    );
    expect(frame).toContain("> bogus"); // seeded from the typed arg
    expect(frame).toContain("No matching level -- backspace to try again, or esc to cancel.");
    expect(session.state.thinkingLevel).toBe("low");

    // Enter with zero matches is a no-op -- the overlay stays open, nothing applied.
    stdin.write("\r");
    await wait(20);
    expect(session.state.thinkingLevel).toBe("low");
    expect(lastFrame() ?? "").toContain(
      "No matching level -- backspace to try again, or esc to cancel.",
    );
  });

  it("typing '/effort' then a space opens the overlay unfiltered; typing 'hi' into IT narrows to 'high'; enter applies it", async () => {
    // Was "/effort hi opens the overlay pre-filtered to 'high'...", built entirely from a single
    // `for (const ch of "/effort hi")` typing loop plus one intermediate `\r` checkpoint before a
    // second, confirming `\r`. That structure no longer matches reality: PromptInput now
    // intercepts the SPACE typed immediately after the box reads exactly "/effort" (see app.tsx's
    // comment beginning "Pressing space right after typing out \"/effort\" in full") and dispatches
    // "/effort" with zero args right then -- opening the overlay, unfiltered, before "hi" is ever
    // typed. The remaining "h"/"i" from the old loop would now land in the just-opened overlay's
    // OWN live search box instead of ever reaching `handleSubmit` as a command-line argument, which
    // collapses the old two-`\r` structure: the first `\r` after typing is no longer an
    // intermediate checkpoint, it's the ONE confirming keystroke. This test drives that same
    // real sequence explicitly, one intercepted step at a time, keeping (and adding to) the
    // intermediate assertions the old test made.
    const session = new Session({
      streamFn: () => fakeStream(),
      initialState: { model: FAKE_MODEL, systemPrompt: "test", thinkingLevel: "low" },
    });
    const { lastFrame, stdin } = render(
      <App
        session={session}
        setup={NEVER_CALLED_SETUP}
        version="1.0.0"
        cwd="/test"
        runShellCommand={NEVER_CALLED_RUN_SHELL_COMMAND}
        slashCommands={NEVER_CALLED_SLASH_COMMANDS}
        spawnEditor={NEVER_CALLED_SPAWN_EDITOR}
        readClipboardImage={NEVER_CALLED_READ_CLIPBOARD_IMAGE}
        readClipboardText={NEVER_CALLED_READ_CLIPBOARD_TEXT}
        readDroppedFile={DEFAULT_READ_DROPPED_FILE}
      />,
    );

    for (const ch of "/effort") {
      stdin.write(ch);
      await wait(5);
    }
    // The box is now exactly "/effort" -- this space is intercepted rather than inserted, and
    // dispatches "/effort" with zero args immediately, same as pressing enter on the bare word.
    stdin.write(" ");
    await wait(20);

    let frame = lastFrame() ?? "";
    expect(frame).toContain(
      "Reasoning effort for future turns (type to search, ↑↓ to pick, enter to confirm):",
    );
    // Unfiltered: every one of THINKING_LEVELS is showing, since no argument text ever reached
    // handleSubmit this time (unlike the old command-line-seeded "/effort hi" path).
    for (const level of THINKING_LEVELS) {
      expect(frame).toContain(level);
    }
    expect(frame).toContain("(all levels)"); // CommandOverlay's own placeholder for an empty search
    expect(session.state.thinkingLevel).toBe("low"); // unchanged -- nothing confirmed yet

    // Now type "hi" -- these keystrokes land in the overlay's OWN live search box (PromptInput is
    // unmounted, per app.tsx's `isActive` gating), narrowing the same way the old command-line
    // seeding used to, just reached one step later.
    for (const ch of "hi") {
      stdin.write(ch);
      await wait(5);
    }

    frame = lastFrame() ?? "";
    expect(frame).toContain("→ high");
    for (const level of ["off", "minimal", "medium", "xhigh", "max"]) {
      expect(frame).not.toContain(level);
    }
    expect(session.state.thinkingLevel).toBe("low"); // still unchanged -- narrowing isn't confirming

    stdin.write("\r"); // confirm the highlighted (only) match
    await wait(20);

    expect(session.state.thinkingLevel).toBe("high");
  });

  it("pasting the whole '/effort hi' string at once (bypassing per-character typing, e.g. via clipboard paste) still seeds the overlay from the command-line arg directly, the original way", async () => {
    // The space-interception above only fires from PromptInput's own per-character useInput
    // handler -- it can never trigger for text that arrives already assembled, such as a
    // clipboard paste (see app.tsx's `pasteFromClipboard`, which calls `insertAtCursor` with the
    // whole clipboard string in one shot, never routing through the per-character handler at all).
    // That means handleSlashCommand's "effort" case still has a real, reachable caller with
    // `parsed.args.length > 0` and an invalid level attached in the SAME string -- this test keeps
    // that original code path (seeding `CommandOverlay`'s `arg` prop straight from a command-line
    // argument, see app.tsx's `case "effort":`) covered now that no character-by-character typing
    // test reaches it anymore.
    const session = new Session({
      streamFn: () => fakeStream(),
      initialState: { model: FAKE_MODEL, systemPrompt: "test", thinkingLevel: "low" },
    });
    const readClipboardImage: ReadClipboardImage = vi.fn(async () => undefined);
    const readClipboardText: ReadClipboardText = vi.fn(async () => "/effort hi");
    const { lastFrame, stdin } = renderApp(session, { readClipboardImage, readClipboardText });

    stdin.write("\x16"); // ctrl+v -- pastes "/effort hi" into the box in one shot
    await wait(20);
    stdin.write("\r"); // submits the whole "/effort hi" line at once
    await wait(20);

    const frame = lastFrame() ?? "";
    expect(frame).toContain(
      "Reasoning effort for future turns (type to search, ↑↓ to pick, enter to confirm):",
    );
    // Pre-filtered to "high" immediately -- seeded straight from the "hi" argument, no typing into
    // the overlay's own search box required, unlike the space-interception path above.
    expect(frame).toContain("→ high");
    for (const level of ["off", "minimal", "medium", "xhigh", "max"]) {
      expect(frame).not.toContain(level);
    }
    expect(session.state.thinkingLevel).toBe("low"); // unchanged until confirmed

    stdin.write("\r"); // confirm the highlighted (only) match
    await wait(20);

    expect(session.state.thinkingLevel).toBe("high");
  });

  it("/effort with no argument shows the overlay picker instead of mutating thinkingLevel or calling slashCommands", async () => {
    const session = new Session({
      streamFn: () => fakeStream(),
      initialState: { model: FAKE_MODEL, systemPrompt: "test", thinkingLevel: "low" },
    });
    const { lastFrame, stdin } = render(
      <App
        session={session}
        setup={NEVER_CALLED_SETUP}
        version="1.0.0"
        cwd="/test"
        runShellCommand={NEVER_CALLED_RUN_SHELL_COMMAND}
        slashCommands={NEVER_CALLED_SLASH_COMMANDS}
        spawnEditor={NEVER_CALLED_SPAWN_EDITOR}
        readClipboardImage={NEVER_CALLED_READ_CLIPBOARD_IMAGE}
        readClipboardText={NEVER_CALLED_READ_CLIPBOARD_TEXT}
        readDroppedFile={DEFAULT_READ_DROPPED_FILE}
      />,
    );

    for (const ch of "/effort") {
      stdin.write(ch);
      await wait(5);
    }
    stdin.write("\r");
    await wait(20);

    expect(lastFrame()).toContain(
      "Reasoning effort for future turns (type to search, ↑↓ to pick, enter to confirm):",
    ); // CommandOverlay's own text
    expect(session.state.thinkingLevel).toBe("low"); // unchanged -- the picker hasn't been used yet
  });

  it("selecting the single 'model' match from the narrowed '/mo' menu dispatches '/model' immediately (zero args), opening the overlay -- tying gap #1's dispatch coverage to gap #2's menu", async () => {
    // Change #1: Enter on an open menu now DISPATCHES the highlighted command immediately instead
    // of autocompleting its name into the box. "model" is the only command starting with "mo", so
    // the live menu narrows to exactly one match -- but it's still not a COMPLETE typed token
    // (deriveCommandMenu only closes the menu on an exact name match, see slash-commands.ts), so
    // the menu stays open and this Enter is exactly the "confirm an in-progress dropdown
    // selection" case the new dispatch-immediately branch targets. Dispatched with zero args,
    // "/model" opens its own overlay (same as typing the full word "/model" and pressing Enter,
    // covered just below) rather than switching directly -- there's no longer a way to land mid-box
    // with "/model " and keep typing provider/model args after a menu-driven Enter.
    const switchModel = vi.fn();
    const listProviders = vi.fn(async () => []);
    const slashCommands = fakeSlashCommands({ switchModel, listProviders });
    const session = new Session({
      streamFn: () => fakeStream(),
      initialState: { model: FAKE_MODEL, systemPrompt: "test" },
    });
    const { lastFrame, stdin } = render(
      <App
        session={session}
        setup={NEVER_CALLED_SETUP}
        version="1.0.0"
        cwd="/test"
        runShellCommand={NEVER_CALLED_RUN_SHELL_COMMAND}
        slashCommands={slashCommands}
        spawnEditor={NEVER_CALLED_SPAWN_EDITOR}
        readClipboardImage={NEVER_CALLED_READ_CLIPBOARD_IMAGE}
        readClipboardText={NEVER_CALLED_READ_CLIPBOARD_TEXT}
        readDroppedFile={DEFAULT_READ_DROPPED_FILE}
      />,
    );

    for (const ch of "/mo") {
      stdin.write(ch);
      await wait(5);
    }
    stdin.write("\r");
    await wait(30);

    // No providers configured -- CommandOverlay's own "model-none-configured" text, same as
    // typing the full "/model" word and pressing Enter.
    expect(lastFrame()).toContain("No providers configured yet");
    expect(listProviders).toHaveBeenCalledTimes(1);
    expect(switchModel).not.toHaveBeenCalled();
  });

  it("/model or /model <provider> alone (fewer than 2 args) opens the overlay instead of switching directly", async () => {
    const switchModel = vi.fn();
    const listProviders = vi.fn(async () => []);
    const slashCommands = fakeSlashCommands({ switchModel, listProviders });
    const session = new Session({
      streamFn: () => fakeStream(),
      initialState: { model: FAKE_MODEL, systemPrompt: "test" },
    });
    const { lastFrame, stdin } = render(
      <App
        session={session}
        setup={NEVER_CALLED_SETUP}
        version="1.0.0"
        cwd="/test"
        runShellCommand={NEVER_CALLED_RUN_SHELL_COMMAND}
        slashCommands={slashCommands}
        spawnEditor={NEVER_CALLED_SPAWN_EDITOR}
        readClipboardImage={NEVER_CALLED_READ_CLIPBOARD_IMAGE}
        readClipboardText={NEVER_CALLED_READ_CLIPBOARD_TEXT}
        readDroppedFile={DEFAULT_READ_DROPPED_FILE}
      />,
    );

    for (const ch of "/model") {
      stdin.write(ch);
      await wait(5);
    }
    stdin.write("\r");
    await wait(30);

    // No providers configured -- CommandOverlay's own "model-none-configured" text.
    expect(lastFrame()).toContain("No providers configured yet");
    expect(switchModel).not.toHaveBeenCalled();
  });

  it("/model <provider> with no model arg also opens the overlay instead of switching directly", async () => {
    const switchModel = vi.fn();
    const listProviders = vi.fn(async () => []);
    const slashCommands = fakeSlashCommands({ switchModel, listProviders });
    const session = new Session({
      streamFn: () => fakeStream(),
      initialState: { model: FAKE_MODEL, systemPrompt: "test" },
    });
    const { lastFrame, stdin } = render(
      <App
        session={session}
        setup={NEVER_CALLED_SETUP}
        version="1.0.0"
        cwd="/test"
        runShellCommand={NEVER_CALLED_RUN_SHELL_COMMAND}
        slashCommands={slashCommands}
        spawnEditor={NEVER_CALLED_SPAWN_EDITOR}
        readClipboardImage={NEVER_CALLED_READ_CLIPBOARD_IMAGE}
        readClipboardText={NEVER_CALLED_READ_CLIPBOARD_TEXT}
        readDroppedFile={DEFAULT_READ_DROPPED_FILE}
      />,
    );

    for (const ch of "/model anthropic") {
      stdin.write(ch);
      await wait(5);
    }
    stdin.write("\r");
    await wait(30);

    // "anthropic" isn't in the (empty) provider list -- CommandOverlay's own error text -- still
    // proof the overlay took over instead of switchModel being called with a partial argument.
    expect(lastFrame()).toContain('Unknown provider "anthropic"');
    expect(switchModel).not.toHaveBeenCalled();
  });

  it("/login and /login <provider> both show the overlay UI, never calling login directly from the prompt-submission path", async () => {
    const login = vi.fn(async () => {});
    const listProviders = vi.fn(async () => [
      { id: "anthropic", name: "Anthropic", hasCredential: false, supportsApiKeyLogin: true },
    ]);
    const slashCommands = fakeSlashCommands({ login, listProviders });
    const session = new Session({
      streamFn: () => fakeStream(),
      initialState: { model: FAKE_MODEL, systemPrompt: "test" },
    });
    const { lastFrame, stdin } = render(
      <App
        session={session}
        setup={NEVER_CALLED_SETUP}
        version="1.0.0"
        cwd="/test"
        runShellCommand={NEVER_CALLED_RUN_SHELL_COMMAND}
        slashCommands={slashCommands}
        spawnEditor={NEVER_CALLED_SPAWN_EDITOR}
        readClipboardImage={NEVER_CALLED_READ_CLIPBOARD_IMAGE}
        readClipboardText={NEVER_CALLED_READ_CLIPBOARD_TEXT}
        readDroppedFile={DEFAULT_READ_DROPPED_FILE}
      />,
    );

    for (const ch of "/login") {
      stdin.write(ch);
      await wait(5);
    }
    stdin.write("\r");
    await wait(30);

    expect(lastFrame()).toContain("Log in to which provider?"); // CommandOverlay's own picker text
    expect(login).not.toHaveBeenCalled();
  });

  it("/login <provider> pre-selects it and shows the API-key entry step, never calling login directly", async () => {
    const login = vi.fn(async () => {});
    const listProviders = vi.fn(async () => [
      { id: "anthropic", name: "Anthropic", hasCredential: false, supportsApiKeyLogin: true },
    ]);
    const slashCommands = fakeSlashCommands({ login, listProviders });
    const session = new Session({
      streamFn: () => fakeStream(),
      initialState: { model: FAKE_MODEL, systemPrompt: "test" },
    });
    const { lastFrame, stdin } = render(
      <App
        session={session}
        setup={NEVER_CALLED_SETUP}
        version="1.0.0"
        cwd="/test"
        runShellCommand={NEVER_CALLED_RUN_SHELL_COMMAND}
        slashCommands={slashCommands}
        spawnEditor={NEVER_CALLED_SPAWN_EDITOR}
        readClipboardImage={NEVER_CALLED_READ_CLIPBOARD_IMAGE}
        readClipboardText={NEVER_CALLED_READ_CLIPBOARD_TEXT}
        readDroppedFile={DEFAULT_READ_DROPPED_FILE}
      />,
    );

    for (const ch of "/login anthropic") {
      stdin.write(ch);
      await wait(5);
    }
    stdin.write("\r");
    await wait(30);

    expect(lastFrame()).toContain("Enter your Anthropic API key:"); // ApiKeyPrompt's own text
    expect(login).not.toHaveBeenCalled();
  });

  it("/resume shows the overlay UI, never calling any other slashCommands method directly", async () => {
    const listRecentSessions = vi.fn(async () => []);
    const slashCommands = fakeSlashCommands({ listRecentSessions });
    const session = new Session({
      streamFn: () => fakeStream(),
      initialState: { model: FAKE_MODEL, systemPrompt: "test" },
    });
    const { lastFrame, stdin } = render(
      <App
        session={session}
        setup={NEVER_CALLED_SETUP}
        version="1.0.0"
        cwd="/test"
        runShellCommand={NEVER_CALLED_RUN_SHELL_COMMAND}
        slashCommands={slashCommands}
        spawnEditor={NEVER_CALLED_SPAWN_EDITOR}
        readClipboardImage={NEVER_CALLED_READ_CLIPBOARD_IMAGE}
        readClipboardText={NEVER_CALLED_READ_CLIPBOARD_TEXT}
        readDroppedFile={DEFAULT_READ_DROPPED_FILE}
      />,
    );

    for (const ch of "/resume") {
      stdin.write(ch);
      await wait(5);
    }
    stdin.write("\r");
    await wait(30);

    expect(lastFrame()).toContain("No past sessions found."); // CommandOverlay's own empty-state text
    expect(listRecentSessions).toHaveBeenCalledTimes(1);
  });

  it("an unknown command like /bogus shows an error and calls nothing on slashCommands", async () => {
    const session = new Session({
      streamFn: () => fakeStream(),
      initialState: { model: FAKE_MODEL, systemPrompt: "test" },
    });
    const { lastFrame, stdin } = render(
      <App
        session={session}
        setup={NEVER_CALLED_SETUP}
        version="1.0.0"
        cwd="/test"
        runShellCommand={NEVER_CALLED_RUN_SHELL_COMMAND}
        slashCommands={NEVER_CALLED_SLASH_COMMANDS}
        spawnEditor={NEVER_CALLED_SPAWN_EDITOR}
        readClipboardImage={NEVER_CALLED_READ_CLIPBOARD_IMAGE}
        readClipboardText={NEVER_CALLED_READ_CLIPBOARD_TEXT}
        readDroppedFile={DEFAULT_READ_DROPPED_FILE}
      />,
    );

    for (const ch of "/bogus") {
      stdin.write(ch);
      await wait(5);
    }
    stdin.write("\r");
    await wait(20);

    expect(lastFrame()).toContain("Unknown command: /bogus. Try /help.");
  });
});

describe("App -- live '/' autocomplete menu", () => {
  it("typing '/' alone opens the menu, listing every command", async () => {
    const session = new Session({
      streamFn: () => fakeStream(),
      initialState: { model: FAKE_MODEL, systemPrompt: "test" },
    });
    const { lastFrame, stdin } = render(
      <App
        session={session}
        setup={NEVER_CALLED_SETUP}
        version="1.0.0"
        cwd="/test"
        runShellCommand={NEVER_CALLED_RUN_SHELL_COMMAND}
        slashCommands={NEVER_CALLED_SLASH_COMMANDS}
        spawnEditor={NEVER_CALLED_SPAWN_EDITOR}
        readClipboardImage={NEVER_CALLED_READ_CLIPBOARD_IMAGE}
        readClipboardText={NEVER_CALLED_READ_CLIPBOARD_TEXT}
        readDroppedFile={DEFAULT_READ_DROPPED_FILE}
      />,
    );

    stdin.write("/");
    await wait(20);

    const frame = lastFrame() ?? "";
    // The footer's "(highlighted/total)" count against the real command list length, rather than a
    // hardcoded number that would silently drift if a command is ever added or removed.
    expect(frame).toContain(`(1/${SLASH_COMMANDS.length})`);
    expect(frame).toContain("new"); // first command, highlighted by default
    expect(frame).toContain("Start a fresh session (new kernel, empty history).");
  });

  it("typing '/mo' narrows the menu down to the single 'model' match", async () => {
    const session = new Session({
      streamFn: () => fakeStream(),
      initialState: { model: FAKE_MODEL, systemPrompt: "test" },
    });
    const { lastFrame, stdin } = render(
      <App
        session={session}
        setup={NEVER_CALLED_SETUP}
        version="1.0.0"
        cwd="/test"
        runShellCommand={NEVER_CALLED_RUN_SHELL_COMMAND}
        slashCommands={NEVER_CALLED_SLASH_COMMANDS}
        spawnEditor={NEVER_CALLED_SPAWN_EDITOR}
        readClipboardImage={NEVER_CALLED_READ_CLIPBOARD_IMAGE}
        readClipboardText={NEVER_CALLED_READ_CLIPBOARD_TEXT}
        readDroppedFile={DEFAULT_READ_DROPPED_FILE}
      />,
    );

    for (const ch of "/mo") {
      stdin.write(ch);
      await wait(5);
    }
    await wait(10);

    const frame = lastFrame() ?? "";
    expect(frame).toContain("(1/1)");
    expect(frame).toContain("model");
    expect(frame).toContain("Switch model among already-configured providers");
    expect(frame).not.toContain("Start a fresh session"); // "new"'s own description, no longer shown
  });

  it("typing '/help' fully closes the menu once it exactly matches, while the input still shows it", async () => {
    const session = new Session({
      streamFn: () => fakeStream(),
      initialState: { model: FAKE_MODEL, systemPrompt: "test" },
    });
    const { lastFrame, stdin } = render(
      <App
        session={session}
        setup={NEVER_CALLED_SETUP}
        version="1.0.0"
        cwd="/test"
        runShellCommand={NEVER_CALLED_RUN_SHELL_COMMAND}
        slashCommands={NEVER_CALLED_SLASH_COMMANDS}
        spawnEditor={NEVER_CALLED_SPAWN_EDITOR}
        readClipboardImage={NEVER_CALLED_READ_CLIPBOARD_IMAGE}
        readClipboardText={NEVER_CALLED_READ_CLIPBOARD_TEXT}
        readDroppedFile={DEFAULT_READ_DROPPED_FILE}
      />,
    );

    stdin.write("/h");
    await wait(10);
    // Only "help" starts with "h" -- the menu is open with exactly that one match.
    let frame = lastFrame() ?? "";
    expect(frame).toContain("(1/1)");

    for (const ch of "elp") {
      stdin.write(ch);
      await wait(5);
    }
    await wait(10);

    frame = lastFrame() ?? "";
    expect(frame).not.toContain("(1/1)"); // menu closed -- "help" is now a complete command name
    expect(frame).toContain("/help"); // still sitting in the input box, unsubmitted
  });

  it("Escape while the menu is open clears the input back to empty, showing the placeholder again", async () => {
    const session = new Session({
      streamFn: () => fakeStream(),
      initialState: { model: FAKE_MODEL, systemPrompt: "test" },
    });
    const { lastFrame, stdin } = render(
      <App
        session={session}
        setup={NEVER_CALLED_SETUP}
        version="1.0.0"
        cwd="/test"
        runShellCommand={NEVER_CALLED_RUN_SHELL_COMMAND}
        slashCommands={NEVER_CALLED_SLASH_COMMANDS}
        spawnEditor={NEVER_CALLED_SPAWN_EDITOR}
        readClipboardImage={NEVER_CALLED_READ_CLIPBOARD_IMAGE}
        readClipboardText={NEVER_CALLED_READ_CLIPBOARD_TEXT}
        readDroppedFile={DEFAULT_READ_DROPPED_FILE}
      />,
    );

    for (const ch of "/mo") {
      stdin.write(ch);
      await wait(5);
    }
    await wait(10);
    expect(lastFrame()).toContain("/mo");

    stdin.write("\x1b"); // Escape
    // Ink holds a lone ESC byte in a 20ms debounce before flushing it as a standalone `key.escape`
    // (it could be the start of an arrow-key sequence) -- see command-overlay.test.tsx's own
    // "Escape" describe block for the same wait, sourced from ink's own App.js.
    await wait(40);

    expect(lastFrame()).toContain("type a prompt (or !command, /command), enter to send");
  });

  it("down-arrow moves the highlight, and Enter on the open menu immediately dispatches that entry (zero args)", async () => {
    // Change #1: Enter on an open "/" menu now DISPATCHES the highlighted command immediately
    // instead of just autocompleting its name into the box -- see app.tsx's `key.return` handler.
    // Down arrow moves off "new" (index 0, SLASH_COMMANDS' first entry) onto "resume" (index 1),
    // so this proves the real "/resume" dispatch happened: `listRecentSessions()` gets called and
    // the resume overlay opens, exactly like `/resume shows the overlay UI...` above (which types
    // the full word) but reached via the dropdown instead.
    const streamFn = vi.fn(() => fakeStream());
    const session = new Session({
      streamFn,
      initialState: { model: FAKE_MODEL, systemPrompt: "test" },
    });
    const listRecentSessions = vi.fn(async () => []);
    const slashCommands = fakeSlashCommands({ listRecentSessions });
    const { lastFrame, stdin } = render(
      <App
        session={session}
        setup={NEVER_CALLED_SETUP}
        version="1.0.0"
        cwd="/test"
        runShellCommand={NEVER_CALLED_RUN_SHELL_COMMAND}
        slashCommands={slashCommands}
        spawnEditor={NEVER_CALLED_SPAWN_EDITOR}
        readClipboardImage={NEVER_CALLED_READ_CLIPBOARD_IMAGE}
        readClipboardText={NEVER_CALLED_READ_CLIPBOARD_TEXT}
        readDroppedFile={DEFAULT_READ_DROPPED_FILE}
      />,
    );
    expect(session.state.messages).toHaveLength(0);

    stdin.write("/");
    await wait(10);

    stdin.write("\x1b[B"); // down arrow -- moves off "new" (index 0) onto "resume" (index 1)
    await wait(10);

    stdin.write("\r"); // Enter on the open menu dispatches "/resume" (zero args) immediately
    await wait(30);

    const frame = lastFrame() ?? "";
    expect(frame).toContain("No past sessions found."); // CommandOverlay's own empty-state text
    expect(listRecentSessions).toHaveBeenCalledTimes(1);
    expect(streamFn).not.toHaveBeenCalled(); // proof session.prompt was never reached
    expect(session.state.messages).toHaveLength(0); // unchanged before and after
  });

  it("a bare '/' followed by Enter immediately dispatches the top match ('/new', SLASH_COMMANDS' first entry)", async () => {
    // Change #1 again, at the bare-"/" edge case: an empty token after "/" matches EVERY command
    // (see matchCommands("")), so the menu is always open the instant the box contains just "/",
    // highlighted on index 0 by default. Previously this test asserted a bare "/" + Enter was a
    // total no-op (matching the OLD "just autocomplete, don't dispatch" behavior). Now that Enter
    // on an open menu always dispatches its highlighted match, this is no longer a no-op at all --
    // it immediately runs "/new" (zero args), which calls `startNewSession()` and swaps in the
    // fresh session, exactly like typing "/new" and pressing Enter would. Verified live against
    // the real source rather than assumed.
    const streamFn = vi.fn(() => fakeStream());
    const session = new Session({
      streamFn,
      initialState: { model: FAKE_MODEL, systemPrompt: "test" },
    });
    const freshSession = new Session({
      streamFn: () => fakeStream(),
      initialState: { model: MODEL_TWO, systemPrompt: "test" },
    });
    const startNewSession = vi.fn(async () => freshSession);
    const slashCommands = fakeSlashCommands({ startNewSession });
    const { lastFrame, stdin } = render(
      <App
        session={session}
        setup={NEVER_CALLED_SETUP}
        version="1.0.0"
        cwd="/test"
        runShellCommand={NEVER_CALLED_RUN_SHELL_COMMAND}
        slashCommands={slashCommands}
        spawnEditor={NEVER_CALLED_SPAWN_EDITOR}
        readClipboardImage={NEVER_CALLED_READ_CLIPBOARD_IMAGE}
        readClipboardText={NEVER_CALLED_READ_CLIPBOARD_TEXT}
        readDroppedFile={DEFAULT_READ_DROPPED_FILE}
      />,
    );

    stdin.write("/");
    await wait(10);
    stdin.write("\r");
    await wait(30);

    expect(startNewSession).toHaveBeenCalledTimes(1);
    const frame = lastFrame() ?? "";
    // The status line's model label now reflects freshSession, not the original -- proof the swap
    // to a genuinely NEW session happened, not merely that the box was cleared.
    expect(frame).toContain("second-provider/second-model");
    expect(frame).not.toContain("fake-provider/fake-model");
    expect(streamFn).not.toHaveBeenCalled(); // the ORIGINAL session's stream was never reached
  });
});

describe("App -- esc to interrupt", () => {
  it("Escape while a turn is in flight aborts it, flips the status line back to idle, and both the transcript and session.state.messages reflect the aborted turn", async () => {
    // fakeStream() never settles on its own (see its own comment above) -- nothing is ever pushed
    // into it here, so the turn stays busy until something (Escape) interrupts it.
    const stream = fakeStream();
    const session = new Session({
      streamFn: () => stream,
      initialState: { model: FAKE_MODEL, systemPrompt: "test" },
    });
    const { lastFrame, stdin } = render(
      <App
        session={session}
        setup={NEVER_CALLED_SETUP}
        version="1.0.0"
        cwd="/test"
        runShellCommand={NEVER_CALLED_RUN_SHELL_COMMAND}
        slashCommands={NEVER_CALLED_SLASH_COMMANDS}
        spawnEditor={NEVER_CALLED_SPAWN_EDITOR}
        readClipboardImage={NEVER_CALLED_READ_CLIPBOARD_IMAGE}
        readClipboardText={NEVER_CALLED_READ_CLIPBOARD_TEXT}
        readDroppedFile={DEFAULT_READ_DROPPED_FILE}
      />,
    );

    for (const ch of "hello") {
      stdin.write(ch);
      await wait(5);
    }
    stdin.write("\r");
    await wait(20);

    // The turn is genuinely in flight before we try to interrupt it.
    let frame = lastFrame() ?? "";
    expect(frame).toContain("… "); // PromptInput's own busy indicator

    stdin.write("\x1b"); // Escape
    // Same lone-ESC debounce (~20ms, ink holds it in case it's the start of an arrow-key escape
    // sequence) the existing "/" menu Escape test above already waits out.
    await wait(40);

    frame = lastFrame() ?? "";
    expect(frame).not.toContain("… "); // no longer busy -- the abort settled the turn
    // agent.ts's ABORTED_MESSAGE ("run was aborted") is the errorMessage on the synthetic aborted
    // assistant message; transcript.tsx's textOf renders any errorMessage as "[error: ...]".
    expect(frame).toContain("[error: run was aborted]");

    const abortedMessage = session.state.messages.find(
      (message) => (message as { stopReason?: string }).stopReason === "aborted",
    );
    expect(abortedMessage).toBeDefined();
    expect((abortedMessage as { errorMessage?: string } | undefined)?.errorMessage).toBe(
      "run was aborted",
    );
  });

  it("Escape does nothing when no turn is in flight -- session.abort() is never called", async () => {
    const session = new Session({
      streamFn: () => fakeStream(),
      initialState: { model: FAKE_MODEL, systemPrompt: "test" },
    });
    const abortSpy = vi.spyOn(session, "abort");
    const { stdin } = render(
      <App
        session={session}
        setup={NEVER_CALLED_SETUP}
        version="1.0.0"
        cwd="/test"
        runShellCommand={NEVER_CALLED_RUN_SHELL_COMMAND}
        slashCommands={NEVER_CALLED_SLASH_COMMANDS}
        spawnEditor={NEVER_CALLED_SPAWN_EDITOR}
        readClipboardImage={NEVER_CALLED_READ_CLIPBOARD_IMAGE}
        readClipboardText={NEVER_CALLED_READ_CLIPBOARD_TEXT}
        readDroppedFile={DEFAULT_READ_DROPPED_FILE}
      />,
    );

    stdin.write("\x1b"); // Escape, with nothing in flight and nothing typed
    await wait(40);

    expect(abortSpy).not.toHaveBeenCalled();
  });

  it("Escape interrupts an in-flight turn even while the '/' menu is open, instead of clearing the input", async () => {
    // Real, deliberate priority decision documented in app.tsx's useInput handler: interrupting a
    // running generation wins over the live "/" menu's own Escape-clears-input behavior when a
    // keypress could plausibly mean either (typing "/" while a previous turn is still streaming).
    const stream = fakeStream();
    const session = new Session({
      streamFn: () => stream,
      initialState: { model: FAKE_MODEL, systemPrompt: "test" },
    });
    const abortSpy = vi.spyOn(session, "abort");
    const { lastFrame, stdin } = render(
      <App
        session={session}
        setup={NEVER_CALLED_SETUP}
        version="1.0.0"
        cwd="/test"
        runShellCommand={NEVER_CALLED_RUN_SHELL_COMMAND}
        slashCommands={NEVER_CALLED_SLASH_COMMANDS}
        spawnEditor={NEVER_CALLED_SPAWN_EDITOR}
        readClipboardImage={NEVER_CALLED_READ_CLIPBOARD_IMAGE}
        readClipboardText={NEVER_CALLED_READ_CLIPBOARD_TEXT}
        readDroppedFile={DEFAULT_READ_DROPPED_FILE}
      />,
    );

    for (const ch of "hello") {
      stdin.write(ch);
      await wait(5);
    }
    stdin.write("\r");
    await wait(20);
    expect(lastFrame()).toContain("… "); // PromptInput's own busy indicator

    // Type "/" into the now-empty box while the turn is still in flight -- PromptInput's own
    // useInput handler doesn't gate ordinary character input on `busy`, so this opens the live
    // autocomplete menu (see the "live '/' autocomplete menu" describe block above for the same
    // "(highlighted/total)" footer convention) at the same time a turn is genuinely running.
    stdin.write("/");
    await wait(20);
    expect(lastFrame()).toContain(`(1/${SLASH_COMMANDS.length})`); // menu is open

    stdin.write("\x1b"); // Escape
    await wait(40);

    expect(abortSpy).toHaveBeenCalledTimes(1);
    // The menu's own Escape handling (clearing the input back to the empty-box placeholder) never
    // ran -- if it had, this placeholder text would be showing instead.
    expect(lastFrame()).not.toContain("type a prompt (or !command, /command), enter to send");
  });

  it("the box is usable again for a normal new prompt after an aborted turn completes", async () => {
    const stream1 = fakeStream();
    const session = new Session({
      streamFn: () => stream1,
      initialState: { model: FAKE_MODEL, systemPrompt: "test" },
    });
    const { lastFrame, stdin } = render(
      <App
        session={session}
        setup={NEVER_CALLED_SETUP}
        version="1.0.0"
        cwd="/test"
        runShellCommand={NEVER_CALLED_RUN_SHELL_COMMAND}
        slashCommands={NEVER_CALLED_SLASH_COMMANDS}
        spawnEditor={NEVER_CALLED_SPAWN_EDITOR}
        readClipboardImage={NEVER_CALLED_READ_CLIPBOARD_IMAGE}
        readClipboardText={NEVER_CALLED_READ_CLIPBOARD_TEXT}
        readDroppedFile={DEFAULT_READ_DROPPED_FILE}
      />,
    );

    for (const ch of "hello") {
      stdin.write(ch);
      await wait(5);
    }
    stdin.write("\r");
    await wait(20);
    expect(lastFrame()).toContain("… "); // PromptInput's own busy indicator

    stdin.write("\x1b"); // Escape -- aborts the first turn
    await wait(40);
    expect(lastFrame()).not.toContain("… "); // no longer busy -- the abort settled the turn

    // A fresh EventStream for the second turn -- reusing `stream1` here would reuse an
    // already-torn-down generator (its iterator was cancelled via `.return()` when the first turn
    // aborted mid-stream), so `session.streamFn` is swapped to a brand-new, fully completable
    // stream the same way the second turn would get one for real (a new streamFn call per turn).
    const stream2 = fakeStream();
    session.streamFn = () => stream2;

    for (const ch of "again") {
      stdin.write(ch);
      await wait(5);
    }
    stdin.write("\r");
    await wait(20);
    expect(lastFrame()).toContain("… "); // PromptInput's own busy indicator

    stream2.push({
      type: "start",
      partial: assistantMessage({ content: [] }),
    });
    stream2.push({
      type: "done",
      reason: "stop",
      message: assistantMessage({
        content: [{ type: "text", text: "hi again" }],
        stopReason: "stop",
      }),
    });
    await wait(20);

    const frame = lastFrame() ?? "";
    expect(frame).toContain("hi again");
    expect(frame).not.toContain("… "); // no longer busy -- the second turn settled
  });
});

/** Centralizes the ADR 0014 host-function defaults (the throwing `NEVER_CALLED_*` fakes, or the
 * inert `DEFAULT_READ_DROPPED_FILE`) for the large block of new keybinding coverage below -- every
 * call site still gets the exact same "throws unless a test overrides it" protection the rest of
 * this file already relies on, just without repeating all ten `<App .../>` props inline for every
 * single render. */
function renderApp(
  session: Session,
  overrides: Partial<{
    setup: ModelSetupController;
    version: string;
    cwd: string;
    runShellCommand: RunShellCommand;
    slashCommands: SlashCommandController;
    spawnEditor: SpawnEditor;
    readClipboardImage: ReadClipboardImage;
    readClipboardText: ReadClipboardText;
    readDroppedFile: ReadDroppedFile;
  }> = {},
) {
  return render(
    <App
      session={session}
      setup={overrides.setup ?? NEVER_CALLED_SETUP}
      version={overrides.version ?? "1.0.0"}
      cwd={overrides.cwd ?? "/test"}
      runShellCommand={overrides.runShellCommand ?? NEVER_CALLED_RUN_SHELL_COMMAND}
      slashCommands={overrides.slashCommands ?? NEVER_CALLED_SLASH_COMMANDS}
      spawnEditor={overrides.spawnEditor ?? NEVER_CALLED_SPAWN_EDITOR}
      readClipboardImage={overrides.readClipboardImage ?? NEVER_CALLED_READ_CLIPBOARD_IMAGE}
      readClipboardText={overrides.readClipboardText ?? NEVER_CALLED_READ_CLIPBOARD_TEXT}
      readDroppedFile={overrides.readDroppedFile ?? DEFAULT_READ_DROPPED_FILE}
    />,
  );
}

/** Once `useApp().exit()` actually runs, Ink's own `handleExit` disables raw mode and calls the
 * render's `onExit`, which for a real `render()` call unmounts the tree entirely -- confirmed
 * directly (a live `ink-testing-library` render, not just reading the code) that `lastFrame()`
 * afterward collapses to just a trailing newline, with no trace of the banner or prompt box left.
 * This used to check for the banner's own "nanocode v" text going missing, but the banner (see
 * `banner.tsx`) no longer prints any version text at all -- it now renders a fixed ASCII-art logo
 * instead, so that text is gone from every frame, live or exited, and can no longer distinguish
 * the two. Checking for the banner's own rounded-border corner ("╭", produced by its
 * `borderStyle="round"`) going missing is a stable replacement: `banner.tsx` is the ONLY place in
 * the entire app that sets `borderStyle` (confirmed via a repo-wide grep), so that corner can only
 * ever come from a still-mounted banner, and vanishes along with the rest of the tree on a real
 * exit -- confirmed directly against a live render. */
const hasExited = (frame: string | undefined) => !(frame ?? "").includes("╭");

describe("App -- cursor-based line editing", () => {
  it("typing inserts at the cursor position, not just appended to the end of the string", async () => {
    const session = new Session({
      streamFn: () => fakeStream(),
      initialState: { model: FAKE_MODEL, systemPrompt: "test" },
    });
    const { lastFrame, stdin } = renderApp(session);

    for (const ch of "hello") {
      stdin.write(ch);
      await wait(5);
    }
    // The cursor starts at the end (index 5); three lefts land it between "he" and "llo".
    for (let i = 0; i < 3; i += 1) {
      stdin.write("\x1b[D");
      await wait(5);
    }
    for (const ch of "XY") {
      stdin.write(ch);
      await wait(5);
    }
    await wait(10);
    expect(lastFrame()).toContain("heXYllo");
  });

  it("backspace deletes the character immediately before the cursor, not always the string's last character", async () => {
    const session = new Session({
      streamFn: () => fakeStream(),
      initialState: { model: FAKE_MODEL, systemPrompt: "test" },
    });
    const { lastFrame, stdin } = renderApp(session);

    for (const ch of "hello") {
      stdin.write(ch);
      await wait(5);
    }
    // Two lefts from the end (5) land the cursor at index 3, i.e. "hel|lo".
    stdin.write("\x1b[D");
    await wait(5);
    stdin.write("\x1b[D");
    await wait(5);
    stdin.write("\x7f"); // backspace -- confirmed directly against a real render (key.backspace)
    await wait(10);

    const frame = lastFrame() ?? "";
    expect(frame).toContain("helo"); // the SECOND "l" (index 2) was removed, not the trailing "o"
    expect(frame).not.toContain("hell");
  });

  it("left/right arrows move the cursor without changing the text itself", async () => {
    const session = new Session({
      streamFn: () => fakeStream(),
      initialState: { model: FAKE_MODEL, systemPrompt: "test" },
    });
    const { lastFrame, stdin } = renderApp(session);

    for (const ch of "abc") {
      stdin.write(ch);
      await wait(5);
    }
    expect(lastFrame()).toContain("abc");

    stdin.write("\x1b[D"); // left
    await wait(10);
    expect(lastFrame()).toContain("abc"); // text unchanged by a pure cursor move

    stdin.write("\x1b[C"); // right -- back to the end
    await wait(10);
    expect(lastFrame()).toContain("abc");

    // Proves the round trip genuinely returned the cursor to the end, not just that the text
    // looks the same: typing now APPENDS "Z" rather than inserting it mid-string.
    stdin.write("Z");
    await wait(10);
    expect(lastFrame()).toContain("abcZ");
  });

  it("ctrl+k deletes from the cursor to the end of the line, leaving everything before it untouched", async () => {
    const session = new Session({
      streamFn: () => fakeStream(),
      initialState: { model: FAKE_MODEL, systemPrompt: "test" },
    });
    const { lastFrame, stdin } = renderApp(session);

    for (const ch of "hello world") {
      stdin.write(ch);
      await wait(3);
    }
    // The cursor starts at 11 (the end); six lefts land it right after "hello" (index 5).
    for (let i = 0; i < 6; i += 1) {
      stdin.write("\x1b[D");
      await wait(3);
    }
    stdin.write("\x0b"); // ctrl+k
    await wait(10);

    const frame = lastFrame() ?? "";
    expect(frame).toContain("hello");
    expect(frame).not.toContain("world");
  });

  it("home/end jump the cursor to the start/end of the line", async () => {
    // Byte sequences confirmed directly against ink's own parse-keypress.js keyName map ("[H" ->
    // "home", "[F" -> "end") and against a real render, rather than assumed.
    const session = new Session({
      streamFn: () => fakeStream(),
      initialState: { model: FAKE_MODEL, systemPrompt: "test" },
    });
    const { lastFrame, stdin } = renderApp(session);

    for (const ch of "hello") {
      stdin.write(ch);
      await wait(5);
    }
    stdin.write("\x1b[H"); // Home
    await wait(10);
    stdin.write("X");
    await wait(10);
    expect(lastFrame()).toContain("Xhello");

    stdin.write("\x1b[F"); // End
    await wait(10);
    stdin.write("Y");
    await wait(10);
    expect(lastFrame()).toContain("XhelloY");
  });
});

// Regression coverage for a fix to the empty-prompt-box cursor: PromptInput used to only render the
// inverted-video cursor caret (`<Text inverse>`) when `input.length > 0`, so a fully empty box --
// the very first thing a user sees on launch, and the state the box returns to after every submit --
// fell into a separate branch showing ONLY the dim placeholder text with no cursor at all. The fix
// (see app.tsx's `PromptInput`, right after `const placeholder = ...`) unified both cases into one
// render path that always emits the `<Text inverse>` caret and appends the placeholder as a trailing
// sibling only when `input.length === 0`.
//
// Note on what these tests can and can't prove: `ink-testing-library`'s `lastFrame()` returns plain
// rendered text with ANSI styling already stripped -- confirmed directly (a throwaway render of
// `<Text inverse>` + `<Text dimColor>` here showed `lastFrame()` as `" placeholder"` with no `\x1b[`
// escape codes at all) -- and no existing test in this file (or any other `packages/tui/test/*`
// file) asserts on `inverse`/`dimColor`/`color` styling in any other way (no `react-test-renderer`,
// no element-tree introspection is used anywhere in this suite; `PromptInput` itself isn't exported
// from app.tsx for a test to render in isolation either). So these tests cannot verify that the
// caret space is actually rendered in reverse video -- only the file's author confirmed that live,
// against a real pty. What CAN be verified through `lastFrame()`, and is exercised below, is the
// structural behavior around it: the placeholder text's presence/absence and content track
// `input.length === 0` correctly across mount, edit-back-to-empty, and busy transitions.
describe("App -- empty prompt box placeholder (cursor-caret fix)", () => {
  it("shows the placeholder on initial mount, when the box is empty from the very start", async () => {
    const session = new Session({
      streamFn: () => fakeStream(),
      initialState: { model: FAKE_MODEL, systemPrompt: "test" },
    });
    const { lastFrame } = renderApp(session);

    expect(lastFrame()).toContain("type a prompt (or !command, /command), enter to send");
  });

  it("backspacing typed text back down to zero length brings the placeholder back", async () => {
    // Proves the empty-box render path is reachable any time the box becomes empty again, not just
    // on initial mount -- typing hides the placeholder, and deleting every character back to ""
    // must show it again rather than leaving the box looking permanently "used up".
    const session = new Session({
      streamFn: () => fakeStream(),
      initialState: { model: FAKE_MODEL, systemPrompt: "test" },
    });
    const { lastFrame, stdin } = renderApp(session);

    for (const ch of "hi") {
      stdin.write(ch);
      await wait(5);
    }
    expect(lastFrame()).not.toContain("type a prompt (or !command, /command), enter to send");

    stdin.write("\x7f"); // backspace
    await wait(5);
    stdin.write("\x7f"); // backspace -- back to empty
    await wait(10);

    expect(lastFrame()).toContain("type a prompt (or !command, /command), enter to send");
  });

  it("shows 'working…' instead of the normal placeholder when busy with an empty box", async () => {
    // Submitting clears the box back to empty AND flips busy on before the stream settles --
    // exactly the state a user is in immediately after pressing enter. The placeholder text itself
    // must switch to "working…", not just persist the normal idle copy.
    const stream = fakeStream();
    const session = new Session({
      streamFn: () => stream,
      initialState: { model: FAKE_MODEL, systemPrompt: "test" },
    });
    const { lastFrame, stdin } = renderApp(session);

    for (const ch of "hello") {
      stdin.write(ch);
      await wait(5);
    }
    stdin.write("\r");
    await wait(20);

    const frame = lastFrame() ?? "";
    expect(frame).toContain("working…");
    expect(frame).not.toContain("type a prompt (or !command, /command), enter to send");

    // Settle the turn so the stream doesn't leak into other tests/hang the process.
    stream.push({
      type: "done",
      reason: "stop",
      message: assistantMessage({ content: [{ type: "text", text: "hi" }], stopReason: "stop" }),
    });
    await wait(20);
  });
});

describe("App -- ctrl+c/ctrl+d exit scheme (pi's stateful scheme)", () => {
  it("ctrl+c with text in the box clears it back to the placeholder, without exiting", async () => {
    const session = new Session({
      streamFn: () => fakeStream(),
      initialState: { model: FAKE_MODEL, systemPrompt: "test" },
    });
    const { lastFrame, stdin } = renderApp(session);

    for (const ch of "hi") {
      stdin.write(ch);
      await wait(5);
    }
    expect(lastFrame()).toContain("hi");

    stdin.write("\x03"); // ctrl+c
    await wait(10);

    const frame = lastFrame() ?? "";
    expect(hasExited(frame)).toBe(false);
    expect(frame).not.toContain("> hi");
    expect(frame).toContain("type a prompt (or !command, /command), enter to send");
  });

  it("ctrl+c on an already-empty box arms the 'press again to exit' hint without exiting", async () => {
    const session = new Session({
      streamFn: () => fakeStream(),
      initialState: { model: FAKE_MODEL, systemPrompt: "test" },
    });
    const { lastFrame, stdin } = renderApp(session);

    stdin.write("\x03"); // ctrl+c, nothing typed
    await wait(10);

    const frame = lastFrame() ?? "";
    expect(hasExited(frame)).toBe(false);
    expect(frame).toContain("Press ctrl+c again to exit.");
  });

  it("ctrl+c twice in a row on an empty box exits", async () => {
    const session = new Session({
      streamFn: () => fakeStream(),
      initialState: { model: FAKE_MODEL, systemPrompt: "test" },
    });
    const { lastFrame, stdin } = renderApp(session);

    stdin.write("\x03");
    await wait(10);
    expect(lastFrame()).toContain("Press ctrl+c again to exit.");

    stdin.write("\x03"); // second press, still within the arm window
    await wait(10);

    expect(hasExited(lastFrame())).toBe(true);
  });

  it("typing after the ctrl+c hint means the NEXT ctrl+c clears the (now non-empty) box instead of exiting", async () => {
    // app.tsx's exitArmedRef is only ever consulted on an ALREADY-EMPTY box; once real text is
    // typed after the first ctrl+c, a second ctrl+c takes the "current.length > 0" branch
    // instead (clear the line, don't touch the armed flag's exit path) -- so from the outside,
    // typing anything before the second press reliably prevents the exit, regardless of the
    // 1500ms arm window still being open.
    const session = new Session({
      streamFn: () => fakeStream(),
      initialState: { model: FAKE_MODEL, systemPrompt: "test" },
    });
    const { lastFrame, stdin } = renderApp(session);

    stdin.write("\x03"); // arm
    await wait(10);
    expect(lastFrame()).toContain("Press ctrl+c again to exit.");

    stdin.write("x");
    await wait(10);

    stdin.write("\x03"); // would exit on a still-empty box; must NOT here
    await wait(10);

    const frame = lastFrame() ?? "";
    expect(hasExited(frame)).toBe(false);
    expect(frame).toContain("type a prompt (or !command, /command), enter to send"); // "x" is gone
  });

  it("ctrl+d on an empty box exits immediately, with no arming needed", async () => {
    const session = new Session({
      streamFn: () => fakeStream(),
      initialState: { model: FAKE_MODEL, systemPrompt: "test" },
    });
    const { lastFrame, stdin } = renderApp(session);

    stdin.write("\x04"); // ctrl+d
    await wait(10);

    expect(hasExited(lastFrame())).toBe(true);
  });

  it("ctrl+d with text in the box does nothing at all", async () => {
    const session = new Session({
      streamFn: () => fakeStream(),
      initialState: { model: FAKE_MODEL, systemPrompt: "test" },
    });
    const { lastFrame, stdin } = renderApp(session);

    for (const ch of "hi") {
      stdin.write(ch);
      await wait(5);
    }
    stdin.write("\x04"); // ctrl+d
    await wait(10);

    const frame = lastFrame() ?? "";
    expect(hasExited(frame)).toBe(false);
    expect(frame).toContain("hi"); // box is completely unchanged
  });
});

// ctrl+o used to also expand the startup banner into its full KEYBINDINGS list, in the same
// keystroke that expands a collapsed tool result (ADR 0014, matching pi's own ctrl+o). Once the
// banner settles into permanent scrollback the moment a session starts, it can no longer be
// retroactively expanded any more than a settled tool cell can, so that half of ctrl+o was dropped
// entirely -- every keybinding's own description now lives in "/help" instead (see
// slash-commands.test.ts). ctrl+o now ONLY toggles tool-output collapse/expand, and this file's
// "Ctrl+O only expands tool cells created after the toggle -- an already-settled cell stays frozen"
// test (above) already covers that in full -- including the case this test used to check (an
// already-settled cell staying collapsed) -- so rather than leave a near-duplicate here testing a
// strict subset of the same behavior under a now-inaccurate name, this describe block was removed
// entirely instead of renamed.

describe("App -- ctrl+t expands/collapses 'thinking' content blocks", () => {
  it("keeps an already-settled thinking block visible after ctrl+t; only hides new ones from then on", async () => {
    // ADR 0014's pi-parity follow-up flipped the default: thinking is now VISIBLE by default
    // (thinkingExpandedAtom starts at `true`, see app.tsx), and ctrl+t hides it entirely -- there
    // is no placeholder state at all, a hidden thinking block occupies zero rows. But a thinking
    // block already settled into <Static> is frozen the first time it renders (see transcript.tsx's
    // header comment) -- ctrl+t can no longer retroactively hide it, matching a real terminal's own
    // scrollback. So this drives TWO turns: the first settles visible before the toggle and must
    // STAY visible after ctrl+t; the second is created after the toggle and must be hidden from the
    // moment it appears.
    let call = 0;
    const session = new Session({
      streamFn: () => {
        call += 1;
        const stream = fakeStream();
        stream.push({
          type: "done",
          reason: "stop",
          message: assistantMessage({
            // pi-ai's real ThinkingContent field is `.thinking`, not `.text` -- the exact bug ADR
            // 0014 found and fixed in transcript.tsx's contentBlocksToText.
            content: [
              { type: "thinking", thinking: call === 1 ? "secret reasoning" : "second reasoning" },
              { type: "text", text: call === 1 ? "final answer" : "final answer two" },
            ],
            stopReason: "stop",
          }),
        });
        return stream;
      },
      initialState: { model: FAKE_MODEL, systemPrompt: "test" },
    });
    const { lastFrame, stdin } = renderApp(session);

    await session.prompt("hi");
    await wait(20);

    let frame = lastFrame() ?? "";
    expect(frame).toContain("secret reasoning"); // visible by default
    expect(frame).toContain("final answer");

    stdin.write("\x14"); // ctrl+t -- toggles the live toggle for FUTURE thinking blocks only.
    await wait(10);

    frame = lastFrame() ?? "";
    // The FIRST thinking block is already frozen into Static -- ctrl+t does not retroactively hide
    // it. This is the key assertion for this test now.
    expect(frame).toContain("secret reasoning");
    // ctrl+t still pushes a transient confirmation into the transcript, matching how shift+tab
    // confirms "Reasoning effort set to ..." on its own toggle (see app.tsx's ctrl+t handler).
    expect(frame).toContain("Thinking blocks: hidden.");

    await session.prompt("hi again");
    await wait(20);

    frame = lastFrame() ?? "";
    // The SECOND thinking block is created after the toggle -- hidden from the moment it appears.
    expect(frame).not.toContain("second reasoning");
    expect(frame).toContain("final answer two");
    // The first one is still visible, proving the toggle didn't retroactively change it either.
    expect(frame).toContain("secret reasoning");
  });
});

describe("App -- shift+tab cycles reasoning effort through THINKING_LEVELS, wrapping around", () => {
  // Change #2 (a revert): shift+tab is back to a silent, no-menu cycle straight to the next
  // THINKING_LEVELS value -- directly mutating `session.state.thinkingLevel` and bumping
  // `sessionVersionAtom` -- rather than opening the searchable effort-picker overlay. See app.tsx's
  // `key.tab && key.shift` block. The searchable overlay itself is untouched and still reachable
  // via "/effort", "/effort <anything>", or picking "effort" from the live "/" menu; it just isn't
  // what shift+tab does anymore. This block replaces the old "opens the effort picker overlay"
  // coverage with tests for the restored cycle-in-place behavior.
  const HEADING =
    "Reasoning effort for future turns (type to search, ↑↓ to pick, enter to confirm):";

  it("advances thinkingLevel to the next THINKING_LEVELS entry immediately, with no overlay shown", async () => {
    const startIndex = THINKING_LEVELS.indexOf("low");
    const nextLevel = THINKING_LEVELS[startIndex + 1];
    const session = new Session({
      streamFn: () => fakeStream(),
      initialState: { model: FAKE_MODEL, systemPrompt: "test", thinkingLevel: "low" },
    });
    const { lastFrame, stdin } = renderApp(session);

    stdin.write("\x1b[Z"); // shift+tab
    await wait(20);

    expect(session.state.thinkingLevel).toBe(nextLevel);
    const frame = lastFrame() ?? "";
    expect(frame).not.toContain(HEADING); // no searchable overlay -- silent, direct cycle
    expect(frame).toContain(`· ${nextLevel}`); // status line reflects the new level
  });

  it("repeated presses advance one level per press", async () => {
    const session = new Session({
      streamFn: () => fakeStream(),
      initialState: { model: FAKE_MODEL, systemPrompt: "test", thinkingLevel: "off" },
    });
    const { lastFrame, stdin } = renderApp(session);

    const startIndex = THINKING_LEVELS.indexOf("off");
    for (let i = 1; i <= 3; i++) {
      stdin.write("\x1b[Z"); // shift+tab
      await wait(20);
      const expected = THINKING_LEVELS[startIndex + i];
      expect(session.state.thinkingLevel).toBe(expected);
      expect(lastFrame() ?? "").toContain(`· ${expected}`);
    }
  });

  it("pressing shift+tab from the last level wraps back around to the first", async () => {
    const lastLevel = THINKING_LEVELS[THINKING_LEVELS.length - 1];
    const firstLevel = THINKING_LEVELS[0];
    const session = new Session({
      streamFn: () => fakeStream(),
      initialState: { model: FAKE_MODEL, systemPrompt: "test", thinkingLevel: lastLevel },
    });
    const { lastFrame, stdin } = renderApp(session);

    stdin.write("\x1b[Z"); // shift+tab
    await wait(20);

    expect(session.state.thinkingLevel).toBe(firstLevel); // wraps, per the `% THINKING_LEVELS.length` math
    expect(lastFrame() ?? "").toContain(`· ${firstLevel}`);
  });

  it("never opens the searchable effort-picker overlay, however many times it's pressed", async () => {
    const session = new Session({
      streamFn: () => fakeStream(),
      initialState: { model: FAKE_MODEL, systemPrompt: "test", thinkingLevel: "off" },
    });
    const { lastFrame, stdin } = renderApp(session);

    for (let i = 0; i < THINKING_LEVELS.length + 2; i++) {
      stdin.write("\x1b[Z"); // shift+tab
      await wait(15);
      expect(lastFrame() ?? "").not.toContain(HEADING);
    }
  });

  // Change #3: shift+tab is no longer silent about the transcript either -- alongside the
  // status-bar update, it now pushes a visible confirmation entry via the same `pushLocalEntry`
  // helper every other slash-command confirmation in this file uses (e.g. the direct-argument
  // "/effort <level>" path's identical `Reasoning effort set to ${level}.` call). Confirmed
  // directly against real pi (v0.84.4): its own shift+tab prints a plain "Thinking level: <level>"
  // line into the transcript, not just a status-bar update.
  it("pressing shift+tab once shows a transcript confirmation naming the new level", async () => {
    const startIndex = THINKING_LEVELS.indexOf("low");
    const nextLevel = THINKING_LEVELS[startIndex + 1];
    const session = new Session({
      streamFn: () => fakeStream(),
      initialState: { model: FAKE_MODEL, systemPrompt: "test", thinkingLevel: "low" },
    });
    const { lastFrame, stdin } = renderApp(session);

    stdin.write("\x1b[Z"); // shift+tab
    await wait(20);

    expect(lastFrame() ?? "").toContain(`Reasoning effort set to ${nextLevel}.`);
  });

  it("repeated presses each show a fresh confirmation for the current new level, not a stale one", async () => {
    const session = new Session({
      streamFn: () => fakeStream(),
      initialState: { model: FAKE_MODEL, systemPrompt: "test", thinkingLevel: "off" },
    });
    const { lastFrame, stdin } = renderApp(session);

    const startIndex = THINKING_LEVELS.indexOf("off");

    stdin.write("\x1b[Z"); // shift+tab -- 1st press
    await wait(20);
    const firstLevel = THINKING_LEVELS[startIndex + 1];
    expect(lastFrame() ?? "").toContain(`Reasoning effort set to ${firstLevel}.`);

    stdin.write("\x1b[Z"); // shift+tab -- 2nd press
    await wait(20);
    const secondLevel = THINKING_LEVELS[startIndex + 2];
    let frame = lastFrame() ?? "";
    // Confirmed directly (not assumed): with only two entries so far, the transcript doesn't
    // virtualize them away -- both confirmations are still visible, in order, rather than the
    // second replacing/deduping the first. The important thing this guards against is a stale
    // closure showing the SAME (first) level's text twice instead of advancing.
    expect(frame).toContain(`Reasoning effort set to ${firstLevel}.`);
    expect(frame).toContain(`Reasoning effort set to ${secondLevel}.`);
    expect(frame.indexOf(`Reasoning effort set to ${firstLevel}.`)).toBeLessThan(
      frame.indexOf(`Reasoning effort set to ${secondLevel}.`),
    );

    stdin.write("\x1b[Z"); // shift+tab -- 3rd press
    await wait(20);
    const thirdLevel = THINKING_LEVELS[startIndex + 3];
    frame = lastFrame() ?? "";
    // Whether or not the transcript has scrolled the earliest entry out of view by now, the
    // LATEST confirmation reflecting the CURRENT level is the one that must always be present --
    // the safest assertion once the transcript can grow indefinitely.
    expect(frame).toContain(`Reasoning effort set to ${thirdLevel}.`);
  });
});

describe("App -- ctrl+l opens the model picker overlay directly", () => {
  it("opens the exact same overlay '/model' (no args) does", async () => {
    const session = new Session({
      streamFn: () => fakeStream(),
      initialState: { model: FAKE_MODEL, systemPrompt: "test" },
    });
    const slashCommands = fakeSlashCommands({
      listProviders: vi.fn(async () => [
        { id: "anthropic", name: "Anthropic", hasCredential: true, supportsApiKeyLogin: true },
      ]),
    });
    const { lastFrame, stdin } = renderApp(session, { slashCommands });

    stdin.write("\x0c"); // ctrl+l
    await wait(20);

    expect(lastFrame()).toContain("Switch to which provider?"); // CommandOverlay's own picker text
  });
});

describe("App -- ctrl+p / shift+ctrl+p cycles models", () => {
  /** A flat, ordered list matching cycleModel's own `providers.flatMap(...)` construction: every
   * model of "fake-provider" (in listModels order) first, then every model of "other". */
  function makeCyclingSlashCommands(session: Session) {
    const switchModel = vi.fn(async (providerId: string, modelId: string) => {
      // Mutates the REAL session model, matching what the real switchModel (setup.ts) does --
      // required for repeated ctrl+p presses to actually advance rather than re-deriving the
      // same "current index" every time.
      session.state.model = { ...FAKE_MODEL, provider: providerId, id: modelId };
    });
    const listProviders = vi.fn(async () => [
      { id: "fake-provider", name: "Fake", hasCredential: true, supportsApiKeyLogin: true },
      { id: "other", name: "Other", hasCredential: true, supportsApiKeyLogin: true },
    ]);
    const listModels = vi.fn((providerId: string) =>
      providerId === "fake-provider"
        ? [
            { id: "fake-model", name: "Fake Model" },
            { id: "model-b", name: "Model B" },
          ]
        : [{ id: "other-model", name: "Other Model" }],
    );
    return {
      slashCommands: fakeSlashCommands({ switchModel, listProviders, listModels }),
      switchModel,
    };
  }

  it("cycles forward through every configured provider's models, wrapping at the end", async () => {
    const session = new Session({
      streamFn: () => fakeStream(),
      initialState: { model: FAKE_MODEL, systemPrompt: "test" },
    });
    const { slashCommands, switchModel } = makeCyclingSlashCommands(session);
    const { lastFrame, stdin } = renderApp(session, { slashCommands });

    // flat order: (fake-provider,fake-model) -> (fake-provider,model-b) -> (other,other-model) -> wraps
    stdin.write("\x10"); // ctrl+p
    await wait(20);
    expect(switchModel).toHaveBeenNthCalledWith(1, "fake-provider", "model-b");
    expect(lastFrame()).toContain("fake-provider/model-b");

    stdin.write("\x10");
    await wait(20);
    expect(switchModel).toHaveBeenNthCalledWith(2, "other", "other-model");
    expect(lastFrame()).toContain("other/other-model");

    stdin.write("\x10");
    await wait(20);
    expect(switchModel).toHaveBeenNthCalledWith(3, "fake-provider", "fake-model"); // wrapped
    expect(lastFrame()).toContain("fake-provider/fake-model");
  });

  it("shift+ctrl+p cycles BACKWARD -- verified via a Kitty-protocol byte sequence, since a plain terminal cannot send this chord distinctly (see note below)", async () => {
    // Real, documented terminal limitation (ADR 0014), not a bug: most terminals collapse
    // Ctrl+Shift+<letter> to the exact same byte as Ctrl+<letter> (0x10 for "p") -- there is no
    // way to send the shifted case with ctrl held without a newer protocol like Kitty's. Verified
    // directly that ink's own parse-keypress.js DOES distinguish shift+ctrl+p from plain ctrl+p
    // when the terminal sends the Kitty keyboard protocol's CSI-u form: "p" is codepoint 112,
    // and shift(1)+ctrl(4)+1(offset)=6 is the modifier field, giving "\x1b[112;6u". On any
    // terminal that does NOT speak this protocol (the common case), the exact same keystroke is
    // indistinguishable from plain ctrl+p and simply cycles forward again -- not tested here,
    // since asserting that would just be re-testing plain ctrl+p under a different name.
    const session = new Session({
      streamFn: () => fakeStream(),
      initialState: { model: FAKE_MODEL, systemPrompt: "test" },
    });
    const { slashCommands, switchModel } = makeCyclingSlashCommands(session);
    const { stdin } = renderApp(session, { slashCommands });

    // From index 0 (fake-provider/fake-model), cycling BACKWARD wraps straight to the last entry.
    stdin.write("\x1b[112;6u");
    await wait(20);
    expect(switchModel).toHaveBeenCalledWith("other", "other-model");
  });
});

describe("App -- ctrl+g hands the box's text to the external editor and replaces it with the result", () => {
  it("suspends the terminal, calls spawnEditor with the current text, and replaces the box with what it returns", async () => {
    const session = new Session({
      streamFn: () => fakeStream(),
      initialState: { model: FAKE_MODEL, systemPrompt: "test" },
    });
    const spawnEditor: SpawnEditor = vi.fn(async (initialText: string) => `EDITED[${initialText}]`);
    const { lastFrame, stdin } = renderApp(session, { spawnEditor });

    for (const ch of "orig") {
      stdin.write(ch);
      await wait(5);
    }
    stdin.write("\x07"); // ctrl+g
    await wait(30);

    expect(spawnEditor).toHaveBeenCalledWith("orig");
    expect(lastFrame()).toContain("EDITED[orig]");
  });
});

describe("App -- ctrl+v pastes from the clipboard, image first with a text fallback", () => {
  it("an available clipboard image attaches silently (a confirmation entry, no text inserted) rather than being typed into the box", async () => {
    const session = new Session({
      streamFn: () => fakeStream(),
      initialState: { model: FAKE_MODEL, systemPrompt: "test" },
    });
    const readClipboardImage: ReadClipboardImage = vi.fn(async () => ({
      base64: "abc123",
      mediaType: "image/png",
    }));
    const { lastFrame, stdin } = renderApp(session, { readClipboardImage });

    stdin.write("\x16"); // ctrl+v
    await wait(30);

    const frame = lastFrame() ?? "";
    expect(frame).toContain("Image attached -- will be sent with your next message.");
    expect(frame).toContain("type a prompt (or !command, /command), enter to send"); // box stayed empty
  });

  it("falls back to clipboard text, inserted at the cursor, when there's no image", async () => {
    const session = new Session({
      streamFn: () => fakeStream(),
      initialState: { model: FAKE_MODEL, systemPrompt: "test" },
    });
    const readClipboardImage: ReadClipboardImage = vi.fn(async () => undefined);
    const readClipboardText: ReadClipboardText = vi.fn(async () => "pasted!");
    const { lastFrame, stdin } = renderApp(session, { readClipboardImage, readClipboardText });

    for (const ch of "ab") {
      stdin.write(ch);
      await wait(5);
    }
    stdin.write("\x16"); // ctrl+v
    await wait(30);

    expect(readClipboardImage).toHaveBeenCalled();
    expect(lastFrame()).toContain("abpasted!"); // inserted at the cursor, which sat at the end
  });
});

describe("App -- drop-file-to-attach (no keybinding; triggered by submitting a real file path)", () => {
  it("a dropped text file's content is inlined into the prompt with a citation, not the literal path", async () => {
    const session = new Session({
      streamFn: () => fakeStream(),
      initialState: { model: FAKE_MODEL, systemPrompt: "test" },
    });
    const promptSpy = vi.spyOn(session, "prompt").mockResolvedValue(undefined);
    // readDroppedFile only ever recognizes a candidate starting with "/" or "~" (setup.ts) --
    // using a "~"-rooted path here purely for variety; handleSubmit checks readDroppedFile FIRST,
    // before any "/" slash-command dispatch, so a "/"-rooted path is exercised identically by the
    // dedicated describe block below (which also covers the reordering itself).
    const readDroppedFile: ReadDroppedFile = vi.fn(async (candidatePath: string) =>
      candidatePath === "~/file.txt"
        ? { kind: "text", content: "FILE CONTENT", path: "/home/x/file.txt" }
        : undefined,
    );
    const { stdin } = renderApp(session, { readDroppedFile });

    for (const ch of "~/file.txt") {
      stdin.write(ch);
      await wait(3);
    }
    stdin.write("\r");
    await wait(30);

    expect(readDroppedFile).toHaveBeenCalledWith("~/file.txt");
    // Exactly handleSubmit's own composed text/citation format: "<content>\n\n(attached from <path>)".
    expect(promptSpy).toHaveBeenCalledWith(
      "FILE CONTENT\n\n(attached from /home/x/file.txt)",
      undefined,
    );
  });

  it("a dropped image file is passed to session.prompt as an image, not inlined as text", async () => {
    const session = new Session({
      streamFn: () => fakeStream(),
      initialState: { model: FAKE_MODEL, systemPrompt: "test" },
    });
    const promptSpy = vi.spyOn(session, "prompt").mockResolvedValue(undefined);
    const readDroppedFile: ReadDroppedFile = vi.fn(async (candidatePath: string) =>
      candidatePath === "~/img.png"
        ? { kind: "image", base64: "abc123", mediaType: "image/png", path: "/home/x/img.png" }
        : undefined,
    );
    const { stdin } = renderApp(session, { readDroppedFile });

    for (const ch of "~/img.png") {
      stdin.write(ch);
      await wait(3);
    }
    stdin.write("\r");
    await wait(30);

    expect(readDroppedFile).toHaveBeenCalledWith("~/img.png");
    // handleSubmit's image branch: `text || "Attached file: ..."` -- since the typed text ITSELF
    // ("~/img.png") is non-empty, that's what's used as the prompt text, with the image attached
    // alongside it (not a synthetic "Attached file: ..." caption, which only applies when the box
    // was otherwise empty).
    expect(promptSpy).toHaveBeenCalledWith("~/img.png", [
      { type: "image", data: "abc123", mimeType: "image/png" },
    ]);
  });

  it("FIXED: an absolute '/'-rooted dropped-file path -- the overwhelmingly common case for a real terminal drag-and-drop -- now reaches readDroppedFile BEFORE handleSubmit's own '/' slash-command dispatch, instead of being swallowed by it", async () => {
    // handleSubmit now calls readDroppedFile FIRST (see app.tsx: the "!!" branch, then "!", then
    // readDroppedFile, then -- only once that resolves `undefined` -- the "/" slash-command
    // dispatch). Since readDroppedFile's own path validation (setup.ts) accepts paths starting
    // with "/" OR "~", and "/"-rooted ones are virtually always what a real terminal emulator
    // actually pastes for a dropped file (an absolute POSIX path), this reordering was the actual
    // fix for a real, previously-documented bug: a "/"-rooted dropped path used to be swallowed
    // whole as an "Unknown command" and never reached the filesystem check at all. It now behaves
    // identically to the "~"-rooted case covered by the two tests above.
    const session = new Session({
      streamFn: () => fakeStream(),
      initialState: { model: FAKE_MODEL, systemPrompt: "test" },
    });
    const promptSpy = vi.spyOn(session, "prompt").mockResolvedValue(undefined);
    const readDroppedFile: ReadDroppedFile = vi.fn(async (candidatePath: string) =>
      candidatePath === "/tmp/file.txt"
        ? { kind: "text", content: "hello from file", path: "/tmp/file.txt" }
        : undefined,
    );
    const { lastFrame, stdin } = renderApp(session, { readDroppedFile });

    for (const ch of "/tmp/file.txt") {
      stdin.write(ch);
      await wait(3);
    }
    stdin.write("\r");
    await wait(30);

    expect(readDroppedFile).toHaveBeenCalledWith("/tmp/file.txt");
    // Exactly handleSubmit's own composed text/citation format: "<content>\n\n(attached from <path>)".
    expect(promptSpy).toHaveBeenCalledWith(
      "hello from file\n\n(attached from /tmp/file.txt)",
      undefined,
    );
    expect(lastFrame()).not.toContain("Unknown command");
  });

  it("an absolute-path-shaped input that is NOT a real dropped file but IS a real slash command still dispatches normally, proving the readDroppedFile-first reordering didn't break ordinary '/' commands", async () => {
    // readDroppedFile resolves `undefined` for "/help" (it's not a real file on disk), so
    // handleSubmit must fall through past the file check to its normal "/" slash-command dispatch
    // exactly as before -- confirmed here against /help's own real output (slash-commands.ts),
    // the same way "App -- '/command' dispatch"'s own "/help" test does.
    const session = new Session({
      streamFn: () => fakeStream(),
      initialState: { model: FAKE_MODEL, systemPrompt: "test" },
    });
    const readDroppedFile: ReadDroppedFile = vi.fn(async () => undefined);
    const { lastFrame, stdin } = renderApp(session, { readDroppedFile });

    for (const ch of "/help") {
      stdin.write(ch);
      await wait(5);
    }
    stdin.write("\r");
    await wait(20);
    stdin.write("\x0F"); // Ctrl+O -- multi-line tool output starts collapsed to its first line
    await wait(10);

    expect(readDroppedFile).toHaveBeenCalledWith("/help");
    const frame = lastFrame() ?? "";
    expect(frame).not.toContain("Unknown command");
    for (const command of SLASH_COMMANDS) {
      expect(frame).toContain(command.usage);
      expect(frame).toContain(command.description);
    }
  });
});

describe("App -- ctrl+z suspends via SIGTSTP/SIGCONT without crashing or hanging", () => {
  it("resolves suspendTerminal and re-renders normally afterward, on a real (guarded) SIGTSTP round trip", async () => {
    if (process.platform === "win32") return; // app.tsx's own ctrl+z handler is a no-op there too

    // This test's own process is a REAL Node process -- sending it a real, unhandled SIGTSTP
    // would genuinely stop this test runner (confirmed directly: an unguarded SIGTSTP suspends
    // the process exactly like a real shell's ctrl+z would). Registering our OWN "SIGTSTP"
    // listener first changes Node's default disposition for that signal from "stop the process"
    // to "just run the registered listeners" (confirmed directly against a standalone Node
    // script) -- so this immediately answers app.tsx's own SIGTSTP with a SIGCONT of its own,
    // letting `suspendTerminal`'s promise resolve exactly as it would once a real shell's `fg`
    // sent the real SIGCONT, without ever actually stopping this process.
    const sigtstpGuard = () => process.kill(process.pid, "SIGCONT");
    process.once("SIGTSTP", sigtstpGuard);
    try {
      const session = new Session({
        streamFn: () => fakeStream(),
        initialState: { model: FAKE_MODEL, systemPrompt: "test" },
      });
      const { lastFrame, stdin } = renderApp(session);

      for (const ch of "hi") {
        stdin.write(ch);
        await wait(5);
      }
      stdin.write("\x1a"); // ctrl+z
      await wait(100);

      // Ink redraws in full once suspendTerminal's callback resolves -- the box's own text
      // survives the round trip untouched, proving the app is still alive and responsive.
      const frame = lastFrame() ?? "";
      expect(hasExited(frame)).toBe(false);
      expect(frame).toContain("hi");

      // The app still responds normally to further input afterward.
      stdin.write("!");
      await wait(10);
      expect(lastFrame()).toContain("hi!");
    } finally {
      process.removeListener("SIGTSTP", sigtstpGuard);
    }
  });
});

describe("App -- Claude-Code-style follow-up message queue (plain Enter while busy) / option+up recall", () => {
  it("option+enter inserts a newline instead of submitting or queuing", async () => {
    // Matches Claude Code: option+enter used to queue the box's text directly (see git history) --
    // that moved to plain Enter while busy (below), freeing this binding for multi-line composition
    // instead. Confirms the newline lands in the box as real multi-line content (app.tsx's own
    // render splits `input` on "\n" into one row per line -- see the `const lines = input.split("\n")`
    // comment there) rather than submitting or queuing anything.
    const session = new Session({
      streamFn: () => fakeStream(),
      initialState: { model: FAKE_MODEL, systemPrompt: "test" },
    });
    const promptSpy = vi.spyOn(session, "prompt");
    const followUpSpy = vi.spyOn(session, "followUp");
    const { lastFrame, stdin } = renderApp(session);

    for (const ch of "line one") {
      stdin.write(ch);
      await wait(3);
    }
    stdin.write("\x1b\r"); // option+enter -- inserts "\n", does not submit or queue
    await wait(20);

    let frame = lastFrame() ?? "";
    expect(frame).toContain("> line one"); // still sitting in the box, not submitted
    expect(promptSpy).not.toHaveBeenCalled();
    expect(followUpSpy).not.toHaveBeenCalled();

    for (const ch of "line two") {
      stdin.write(ch);
      await wait(3);
    }
    await wait(20);

    frame = lastFrame() ?? "";
    // First line keeps its "> " prompt marker; the continuation line gets the "  " (two-space)
    // indent instead -- app.tsx's own render: `index === 0 ? (busy ? "… " : "> ") : "  "`.
    expect(frame).toContain("> line one");
    expect(frame).toContain("  line two");
    expect(promptSpy).not.toHaveBeenCalled();
    expect(followUpSpy).not.toHaveBeenCalled();
  });

  it("plain Enter while busy queues the box's text via session.followUp instead of interrupting the in-flight turn", async () => {
    // fakeStream() never settles on its own (see its own comment above) -- the first turn stays
    // genuinely busy until this test explicitly pushes a "done" event, giving enough time to type a
    // follow-up and submit it with plain Enter while `busy` is still true.
    const stream = fakeStream();
    const session = new Session({
      streamFn: () => stream,
      initialState: { model: FAKE_MODEL, systemPrompt: "test" },
    });
    const promptSpy = vi.spyOn(session, "prompt");
    const followUpSpy = vi.spyOn(session, "followUp");
    const abortSpy = vi.spyOn(session, "abort");
    const { lastFrame, stdin } = renderApp(session);

    for (const ch of "hello") {
      stdin.write(ch);
      await wait(5);
    }
    stdin.write("\r");
    await wait(20);
    expect(lastFrame()).toContain("… "); // first turn genuinely in flight

    for (const ch of "queued text") {
      stdin.write(ch);
      await wait(3);
    }
    stdin.write("\r"); // plain Enter while busy -- queues instead of submitting or no-op'ing
    await wait(20);

    expect(followUpSpy).toHaveBeenCalledTimes(1);
    const [queuedMessage] = followUpSpy.mock.calls[0] as [{ content: unknown }];
    expect(queuedMessage.content).toEqual([{ type: "text", text: "queued text" }]);
    expect(promptSpy).toHaveBeenCalledTimes(1); // only the original "hello" turn -- no second prompt
    expect(abortSpy).not.toHaveBeenCalled(); // queuing must not interrupt the in-flight turn

    let frame = lastFrame() ?? "";
    expect(frame).toContain("working…"); // box cleared -- still busy, so the busy placeholder shows
    expect(frame).toContain("Queued as a follow-up message.");
    expect(frame).toContain("… "); // still busy -- the original turn is untouched

    // The original turn settles completely normally afterward -- queuing didn't leave it wedged.
    stream.push({ type: "start", partial: assistantMessage({ content: [] }) });
    stream.push({
      type: "done",
      reason: "stop",
      message: assistantMessage({ content: [{ type: "text", text: "hi" }], stopReason: "stop" }),
    });
    await wait(20);
    frame = lastFrame() ?? "";
    expect(frame).not.toContain("… ");
  });

  it("a '!' bang command typed while busy is a complete no-op -- not queued, not run, and the input isn't even cleared", async () => {
    // The other, explicitly unchanged half of handleSubmit's busy branch: slash/bang commands stay
    // blocked while busy, since queuing makes sense for "say this to the model next," not for
    // something with an immediate, non-deferrable effect. renderApp's default runShellCommand
    // throws if it's ever actually invoked, so this also proves the command never dispatches.
    const stream = fakeStream();
    const session = new Session({
      streamFn: () => stream,
      initialState: { model: FAKE_MODEL, systemPrompt: "test" },
    });
    const followUpSpy = vi.spyOn(session, "followUp");
    const { lastFrame, stdin } = renderApp(session);

    for (const ch of "hello") {
      stdin.write(ch);
      await wait(5);
    }
    stdin.write("\r");
    await wait(20);
    expect(lastFrame()).toContain("… "); // turn genuinely in flight

    for (const ch of "!ls") {
      stdin.write(ch);
      await wait(3);
    }
    stdin.write("\r");
    await wait(20);

    expect(followUpSpy).not.toHaveBeenCalled();
    expect(session.hasQueuedMessages()).toBe(false);
    const frame = lastFrame() ?? "";
    expect(frame).not.toContain("Queued as a follow-up message.");
    expect(frame).toContain("!ls"); // handleSubmit returned before ever clearing the box
  });

  it("a multi-line prompt composed with option+enter reaches session.prompt with the embedded newline intact", async () => {
    const session = new Session({
      streamFn: () => fakeStream(),
      initialState: { model: FAKE_MODEL, systemPrompt: "test" },
    });
    const promptSpy = vi.spyOn(session, "prompt");
    const { stdin } = renderApp(session);

    for (const ch of "line one") {
      stdin.write(ch);
      await wait(3);
    }
    stdin.write("\x1b\r"); // option+enter -- inserts a newline, does not submit
    await wait(20);
    for (const ch of "line two") {
      stdin.write(ch);
      await wait(3);
    }
    stdin.write("\r"); // plain Enter, not busy -- submits the whole multi-line text as one prompt
    await wait(20);

    expect(promptSpy).toHaveBeenCalledWith("line one\nline two", undefined);
  });

  it("option+up recalls every currently-queued message into the box for editing, clearing the queue", async () => {
    // fakeStream() never settles on its own -- keeps the first turn busy long enough to queue a
    // follow-up via plain Enter (the new mechanism), matching the "plain Enter while busy" test above.
    const stream = fakeStream();
    const session = new Session({
      streamFn: () => stream,
      initialState: { model: FAKE_MODEL, systemPrompt: "test" },
    });
    const removeQueuedMessagesSpy = vi.spyOn(session, "removeQueuedMessages");
    const { lastFrame, stdin } = renderApp(session);

    for (const ch of "hello") {
      stdin.write(ch);
      await wait(5);
    }
    stdin.write("\r");
    await wait(20);
    expect(lastFrame()).toContain("… "); // turn genuinely in flight before queuing

    for (const ch of "queued text") {
      stdin.write(ch);
      await wait(3);
    }
    stdin.write("\r"); // plain Enter while busy -- queues it
    await wait(20);
    expect(session.hasQueuedMessages()).toBe(true);

    stdin.write("\x1b\x1b[A"); // option+up
    await wait(20);

    expect(removeQueuedMessagesSpy).toHaveBeenCalledTimes(1);
    expect(session.hasQueuedMessages()).toBe(false); // removeQueuedMessages both reads AND clears
    expect(lastFrame()).toContain("queued text"); // put back in the box for editing
  });

  it("option+up with nothing queued is a no-op", async () => {
    const session = new Session({
      streamFn: () => fakeStream(),
      initialState: { model: FAKE_MODEL, systemPrompt: "test" },
    });
    const removeQueuedMessagesSpy = vi.spyOn(session, "removeQueuedMessages");
    const { lastFrame, stdin } = renderApp(session);

    stdin.write("\x1b\x1b[A"); // option+up, nothing ever queued
    await wait(20);

    expect(removeQueuedMessagesSpy).toHaveBeenCalledTimes(1); // called, but returns nothing to use
    expect(lastFrame()).toContain("type a prompt (or !command, /command), enter to send");
  });
});
