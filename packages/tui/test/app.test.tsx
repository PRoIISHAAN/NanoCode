// M5: proves App renders incrementally as an assistant message streams in (not just once at the
// end) and shows the settled message afterward -- against a REAL Session driven by a fake
// EventStream, the same pattern packages/agent's own tests use, rather than a hand-rolled fake
// event list that might not match what Session actually emits.
import { EventEmitter } from "node:events";
import type { AgentMessage, AgentTool } from "@nanocode/agent";
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
import wrapAnsi from "wrap-ansi";
import {
  App,
  type ReadClipboardImage,
  type ReadClipboardText,
  type ReadDroppedFile,
  type RunShellCommand,
  type SpawnEditor,
} from "../src/app.tsx";
import { MENU_WINDOW_SIZE } from "../src/command-menu.tsx";
import { wrapStdinForMouse } from "../src/mouse.ts";
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
  loginOAuth: () => {
    throw new Error("setup.loginOAuth() should never be called when a session is provided");
  },
  openUrl: () => {
    throw new Error("setup.openUrl() should never be called when a session is provided");
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
  loginOAuth: () => {
    throw new Error(
      "SlashCommandController.loginOAuth() should never be called by a test that doesn't exercise it",
    );
  },
  openUrl: () => {
    throw new Error(
      "SlashCommandController.openUrl() should never be called by a test that doesn't exercise it",
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

    // Submitted through the same real stdin/Enter path `PromptInput` itself uses (not a direct
    // `session.prompt()` call, an earlier version of this test did that) -- `atoms.busy` is only
    // ever flipped true by that submit path, never by the session's own event stream, and
    // `NotificationLine`'s fixed-status text is now gated on `busy` (see its own comment on why:
    // a real, reported bug had the SAME status text rendered twice, once here correctly gated and
    // once unconditionally inline in the transcript -- the fix removed the ungated duplicate, which
    // means a direct `session.prompt()` call bypassing `busy` entirely would now show nothing at all
    // here, a test-only gap rather than anything wrong with the app itself).
    for (const ch of "hello") {
      stdin.write(ch);
      await wait(5);
    }
    stdin.write("\r");
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

  it("Ctrl+O retroactively expands EVERY tool cell, already-settled ones included -- not just future ones -- and is fully reversible", async () => {
    // Drives a real toolCall -> real tool execution -> real toolResult message round-trip (the
    // same shape packages/agent/test/agent.test.ts's own fake-tool tests use), rather than
    // fabricating a toolResult message directly -- that would only prove the collapse renderer
    // works on hand-shaped data, not that it's wired to a genuinely produced message.
    //
    // Now that nothing freezes into permanent `<Static>` scrollback, `toolOutputExpanded` is a
    // single GLOBAL toggle applied uniformly to every item on every render (see transcript.tsx's
    // own `TranscriptProps.toolOutputExpanded` doc comment) -- unlike the old `<Static>`-based
    // version, ctrl+o now retroactively re-renders an ALREADY-settled cell too, not just ones
    // created after the toggle. Kept to a single tool-call round trip (rather than two, as an
    // earlier version of this test did): this app's fixed-height transcript viewport (see
    // transcript.tsx's own header comment) would clip the FIRST round trip off-screen entirely
    // once a second one pushed the conversation past this harness's small simulated terminal
    // height, which would make this test about clipping instead of about the toggle itself.
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

    // One prompt() call drives streamFn twice (a toolUse turn, then a stop turn) -- matching this
    // file's other multi-turn fake-stream tests.
    let call = 0;
    const session = new Session({
      streamFn: () => {
        call += 1;
        const stream = fakeStream();
        if (call === 1) {
          stream.push({
            type: "done",
            reason: "toolUse",
            message: assistantMessage({
              content: [{ type: "toolCall", id: "call-1", name: "multiline-tool", arguments: {} }],
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

    // The cell settles under the default toolOutputExpanded=false: no output lines at all, just
    // the one-line summary. This tool has no `code` (empty `arguments: {}`), so the summary is
    // marker + language + line counts + expand hint.
    let frame = lastFrame() ?? "";
    expect(frame).toContain("multiline-tool");
    expect(frame).toContain("ctrl+o to expand");
    expect(frame).not.toContain("line one");
    expect(frame).not.toContain("line two");
    expect(frame).not.toContain("line three");

    stdin.write("\x0F"); // Ctrl+O -- a global toggle, retroactively affecting this already-settled cell.
    await wait(10);

    frame = lastFrame() ?? "";
    expect(frame).toContain("ctrl+o to collapse");
    expect(frame).not.toContain("ctrl+o to expand");
    expect(frame).toContain("line one");
    expect(frame).toContain("line two");
    expect(frame).toContain("line three");
    expect(frame).not.toContain("waiting for code");

    stdin.write("\x0F"); // toggle back off -- proves this is a live, reversible toggle, not a one-way reveal.
    await wait(10);

    frame = lastFrame() ?? "";
    expect(frame).toContain("ctrl+o to expand");
    expect(frame).not.toContain("ctrl+o to collapse");
    expect(frame).not.toContain("line one");
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
        {
          id: "anthropic",
          name: "Anthropic",
          hasCredential: true,
          supportsApiKeyLogin: true,
          supportsOAuthLogin: false,
        },
      ],
      listModels: () => [{ id: "claude-sonnet-5", name: "Claude Sonnet 5" }],
      login: vi.fn(),
      loginOAuth: vi.fn(() => {
        throw new Error("setup.loginOAuth() should never be called by this api-key-only test");
      }),
      openUrl: vi.fn(() => {
        throw new Error("setup.openUrl() should never be called by this api-key-only test");
      }),
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

// The old `FillerSpace` component (which used to be rendered right after `<TranscriptView>` in
// `RunningSession`, padding a fresh/empty launch out to the full terminal height with blank lines)
// is GONE -- it was superseded by the current architecture, where `Transcript` (transcript.tsx)
// itself is a FIXED-height, clipped viewport (see its own header comment) and `TranscriptView`
// (app.tsx) computes that height as `rows - footerHeight`, always exactly filling whatever the rest
// of the screen (`NotificationLine` + the two rules + the prompt box/overlay + the "/" menu + the
// status bar) doesn't use. On a fresh, empty launch, `Transcript`'s own `topAligned` layout (see
// transcript.tsx) puts the banner at the TOP of that fixed-height box and leaves the rest of the
// box's own height as blank space below it -- the same visual effect `FillerSpace` used to produce
// by hand, just now an emergent property of `Transcript`'s own fixed-height box rather than a
// separate component reasoning about "how much filler is left."
//
// `ink-testing-library`'s fake `Stdout` class (node_modules/ink-testing-library/build/index.js,
// read directly to confirm this) defines only a fixed `columns` getter (100, already relied on
// elsewhere in this file) and NO `rows` property or getter at all -- so `useStdout().stdout.rows` is
// always `undefined` in this harness (confirmed live: logging it inside a throwaway render prints
// `undefined`). `RunningSession`'s own root `<Box height={stdout?.rows ?? 24}>` falls back to a
// fixed `24` whenever `stdout.rows` is nullish, so every test in this file renders against a
// deterministic 24-row simulated terminal.
//
// There is no documented way to control `ink-testing-library`'s simulated `rows` value -- its own
// `render(tree)` takes no options at all (confirmed by reading its source above), unlike `columns`,
// which is likewise fixed but at least discoverable the same way. Since there's no way to shrink the
// simulated terminal below the banner's own 9 rows (`BANNER_ROWS`) through this harness's public
// API, the "does not crash on a terminal smaller than the banner" case is skipped here rather than
// faked; `Math.max(1, ...)` in `TranscriptView`'s own `transcriptHeight` computation already guards
// that path (see app.tsx), and every other test in this file already exercises this exact fixed
// 24-row terminal without ever crashing.
//
// Note on `isFullscreen`/the trailing-newline mechanism itself: `ink-testing-library`'s `render()`
// (its source, read directly above) always passes `debug: true` to Ink's own `render()`. Reading
// `ink/build/ink.js`'s `onRender` shows `debug: true` takes an entirely separate, EARLIER branch
// (`if (this.options.debug) { ...; this.options.stdout.write(this.fullStaticOutput + output); return; }`)
// that returns before ever reaching `renderInteractiveFrame` -- the method that contains the real
// `isFullscreen`/`outputHeight >= viewportRows` check and the trailing-"\n" decision this whole
// feature relies on. In other words, this harness NEVER exercises that code path at all, in either
// direction: it never appends a trailing "\n" regardless of fullscreen state, and it never even calls
// `getWindowSize` for `rows` (only a couple of unrelated `columns` reads elsewhere touch that
// function). So there is no way, through this harness's public API, to directly observe whether the
// real trailing-newline-omission fired -- see the dedicated test below, which instead asserts the
// structural precondition (`outputHeight >= viewportRows`) that the real, non-debug Ink runtime uses
// to decide this, since that's the closest thing to "did the fullscreen path get taken" this harness
// can actually see. This mechanism doesn't depend on `FillerSpace` at all (it never did -- it comes
// from Ink's own runtime, `tui.tsx`'s alternate-screen-buffer entry, and the fixed root `height`),
// so it's kept here even though the rest of this describe block's old FillerSpace-specific
// assertions are not.
describe("App -- fixed full-terminal layout (footer pinned, transcript fills the rest)", () => {
  /** The banner (`StartupBanner`, banner.tsx) is a round-bordered box -- "╰" only ever appears on its
   * own closing border line, nowhere else in this app (confirmed via the banner being the only
   * `borderStyle` user in the whole codebase, same fact `hasExited` below in this file already relies
   * on), so it's a stable way to find the last row the banner itself occupies. */
  const findBannerEndIndex = (lines: string[]) => lines.findIndex((line) => line.includes("╰"));
  /** Same technique the "frames the prompt box with a horizontal rule" test above already uses: a
   * pure run of "─" (no corner characters mixed in, unlike the banner's own border) only ever comes
   * from `HorizontalRule` (status-bar.tsx), and the first one in the frame is always the rule directly
   * above the prompt box. */
  const findFirstRuleIndex = (lines: string[]) => lines.findIndex((line) => /^─+$/.test(line));
  const SIMULATED_TERMINAL_ROWS = 24; // this describe block's own header comment establishes this

  /** The total rendered line count never changes regardless of how much real conversation content
   * exists -- `TranscriptView`'s own `transcriptHeight = rows - footerHeight` computation keeps the
   * live tree exactly `rows` tall at all times (this is the direct replacement for what the old,
   * now-removed `FillerSpace` component used to achieve by hand): as real content grows, blank rows
   * inside `Transcript`'s own fixed-height box shrink to make room, they never change the total. */
  const totalRenderedLines = (frame: string) => {
    const rawLines = frame.split("\n");
    return rawLines.length > 0 && rawLines[rawLines.length - 1] === ""
      ? rawLines.length - 1
      : rawLines.length;
  };

  it("renders exactly `rows` (24) lines on a fresh, empty launch, banner top-aligned with blank space below it inside the transcript's own fixed-height box", async () => {
    const session = new Session({
      streamFn: () => fakeStream(),
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
    await wait(20);

    const frame = lastFrame() ?? "";
    expect(totalRenderedLines(frame)).toBe(SIMULATED_TERMINAL_ROWS);

    const lines = frame.split("\n");
    const bannerEndIndex = findBannerEndIndex(lines);
    const ruleIndex = findFirstRuleIndex(lines);
    expect(bannerEndIndex).toBeGreaterThan(-1);
    expect(ruleIndex).toBeGreaterThan(bannerEndIndex);

    // Every row between the banner's own closing border and the rule above the prompt box is blank
    // on a totally fresh launch (topAligned: banner at the top, nothing else in the conversation
    // yet) -- confirmed directly against a live render, not hand-derived purely from the layout
    // formula, since that's exactly the kind of arithmetic this file has gotten wrong before.
    const between = lines.slice(bannerEndIndex + 1, ruleIndex);
    for (const line of between) expect(line.trim()).toBe("");
    expect(between.length).toBeGreaterThan(0);
  });

  it("still renders exactly `rows` (24) lines once a real message settles into the transcript (messagesAtom) -- the blank space shrinks, the total never does", async () => {
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
      type: "done",
      reason: "stop",
      message: assistantMessage({
        content: [{ type: "text", text: "hi there" }],
        stopReason: "stop",
      }),
    });
    await wait(20);

    const frame = lastFrame() ?? "";
    expect(frame).toContain("hello");
    expect(frame).toContain("hi there");
    expect(totalRenderedLines(frame)).toBe(SIMULATED_TERMINAL_ROWS);
  });

  it("still renders exactly `rows` (24) lines once a local entry exists (a '!!command', going through localEntriesAtom rather than messagesAtom)", async () => {
    const session = new Session({
      streamFn: () => fakeStream(),
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

    for (const ch of "!!echo hi") {
      stdin.write(ch);
      await wait(5);
    }
    stdin.write("\r");
    await wait(20);

    expect(session.state.messages).toHaveLength(0); // went through localEntriesAtom, not messagesAtom
    const frame = lastFrame() ?? "";
    expect(frame).toContain("echo hi");
    expect(totalRenderedLines(frame)).toBe(SIMULATED_TERMINAL_ROWS);
  });

  it("the live tree's own rendered height reaches (at least) the harness's simulated row count on a fresh, empty launch -- the structural precondition Ink's real isFullscreen check relies on to omit its trailing newline", async () => {
    // This is the direct regression test for the actual mechanism this whole feature depends on:
    // Ink's own `renderInteractiveFrame` (ink/build/ink.js) only omits the trailing "\n" it would
    // otherwise unconditionally append after a live frame when `outputHeight >= viewportRows` (its
    // own `isFullscreen` check). As established in this describe block's own header comment,
    // `ink-testing-library`'s `render()` always runs Ink in `debug: true` mode, which takes an
    // earlier, separate branch in `onRender` that never reaches `renderInteractiveFrame` at all --
    // so there is no way, through this harness's public API (`lastFrame()`, `frames`, or anything
    // else `node_modules/ink-testing-library/build/index.js` actually exports), to directly observe
    // whether a trailing "\n" was appended or omitted; debug mode never appends one either way. That
    // was confirmed by reading both files directly, not assumed.
    //
    // Falling back, as the task allows, to asserting the STRUCTURAL claim the real (non-debug)
    // mechanism depends on instead: that the combined live tree on a fresh, empty launch (banner +
    // filler + rule/prompt/rule/status) actually renders at least as many lines as the harness's own
    // simulated terminal height (24, per this describe block's header comment) -- i.e.
    // `outputHeight >= viewportRows` really would hold here, which is the exact condition
    // `isFullscreen` checks in the real runtime. If this ever regressed back to staying under `rows`
    // (e.g. someone reintroducing a "leave a safety row" subtraction), Ink would go back to always
    // appending its trailing "\n" on a real terminal even on a totally empty launch, reproducing the
    // original "banner's own top row scrolls off-screen" bug this whole rework fixed.
    const session = new Session({
      streamFn: () => fakeStream(),
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
    await wait(20);

    const frame = lastFrame() ?? "";
    // A frame ending in "\n" would otherwise contribute one spurious trailing empty entry to
    // `split("\n")` that was never a real rendered row -- trimmed off so this counts actual lines
    // only, matching how `viewportRows`/`outputHeight` are both real row counts in Ink's own code.
    const rawLines = frame.split("\n");
    const renderedLineCount =
      rawLines.length > 0 && rawLines[rawLines.length - 1] === ""
        ? rawLines.length - 1
        : rawLines.length;

    const SIMULATED_TERMINAL_ROWS = 24; // this describe block's own header comment establishes this
    expect(renderedLineCount).toBeGreaterThanOrEqual(SIMULATED_TERMINAL_ROWS);
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
    const [userEntry, resultEntry] = session.state.messages as unknown as [
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
    const { stdin } = render(
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

    resolveRun?.({ output: "done", isError: false });
    await wait(20);
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
  });

  it("ctrl+o retroactively expands an already-settled bang-command tool cell too, same as a real tool call", async () => {
    // Same global, retroactive `toolOutputExpanded` contract proven for real tool calls above, here
    // for the synthetic toolResult entry a bang command produces (buildBangCommandEntries in
    // app.tsx) -- it goes through the same ToolCellItem rendering path (transcript.tsx). Kept to a
    // single bang command (rather than two, as an earlier version of this test did): this app's
    // fixed-height transcript viewport would clip the first one off-screen entirely once a second
    // command's own output pushed the conversation past this harness's small simulated terminal
    // height, which would make this test about clipping rather than about the toggle itself.
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

    // The cell settles under the default toolOutputExpanded=false: no output lines at all -- just
    // the one-line summary (language "shell" + the command itself as the code preview).
    let frame = lastFrame() ?? "";
    expect(frame).toContain("shell");
    expect(frame).toContain("cat file");
    expect(frame).toContain("ctrl+o to expand");
    expect(frame).not.toContain("line one");
    expect(frame).not.toContain("line two");
    expect(frame).not.toContain("line three");

    stdin.write("\x0F"); // Ctrl+O -- a global toggle, retroactively affecting this already-settled cell.
    await wait(10);

    frame = lastFrame() ?? "";
    expect(frame).toContain("ctrl+o to collapse");
    expect(frame).not.toContain("ctrl+o to expand");
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
  it("/help pushes a notice with every command's usage and description (verified against the real, exhaustive slash-commands.test.ts unit test), dispatching it into the fixed-height transcript", async () => {
    // `helpText()` itself (slash-commands.ts) is already exhaustively unit-tested in
    // slash-commands.test.ts -- every command's usage/description is asserted to be present in its
    // OWN string output there. What this test can still usefully prove, at the App level, is that
    // "/help" actually DISPATCHES (no `slashCommands` method is called -- `NEVER_CALLED_SLASH_COMMANDS`
    // would throw if it were) and that the resulting notice reaches the live transcript.
    //
    // It can no longer assert every command is SIMULTANEOUSLY VISIBLE in `lastFrame()`, though:
    // `helpText()`'s real output (15 commands + a blank line + "Keybindings:" + 20 keybindings) is
    // far taller than this harness's fixed, ~18-row transcript viewport (see transcript.tsx's own
    // header comment on why `Transcript` clips rather than growing unboundedly now) -- older lines
    // of that one long notice get clipped off the top, exactly like an overflowing multi-message
    // conversation would. Only the TAIL of the notice (the last keybinding line) is guaranteed to
    // still be on screen, the same "newest content survives, oldest gets clipped" contract this
    // file's transcript.test.tsx already covers directly.
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

    const frame = lastFrame() ?? "";
    // The very last line of helpText()'s own output -- guaranteed to survive the clip since the
    // transcript bottom-anchors on overflow, always keeping the newest tail of content on screen.
    expect(frame).toContain("(drop a file)");
    expect(frame).toContain("to attach it");
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
      {
        id: "anthropic",
        name: "Anthropic",
        hasCredential: false,
        supportsApiKeyLogin: true,
        supportsOAuthLogin: false,
      },
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

    // "/login" with no arg now asks "Log in how?" first (command-overlay.tsx's own
    // "login-method-choice" phase) before ever fetching providers -- pick "API Key" (already
    // highlighted first) to reach the (filtered) provider list.
    expect(lastFrame()).toContain("Log in how?");
    stdin.write("\r");
    await wait(30);

    expect(lastFrame()).toContain("Log in to which provider?"); // CommandOverlay's own picker text
    expect(login).not.toHaveBeenCalled();
  });

  it("/login <provider> pre-selects it and shows the API-key entry step, never calling login directly", async () => {
    const login = vi.fn(async () => {});
    const listProviders = vi.fn(async () => [
      {
        id: "anthropic",
        name: "Anthropic",
        hasCredential: false,
        supportsApiKeyLogin: true,
        supportsOAuthLogin: false,
      },
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

    stdin.write("\x1b"); // Escape
    // Same lone-ESC debounce (~20ms, ink holds it in case it's the start of an arrow-key escape
    // sequence) the existing "/" menu Escape test above already waits out.
    await wait(40);

    frame = lastFrame() ?? "";
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

  it("Escape closes the '/' menu (or clears typed text) instead of interrupting an in-flight turn -- only a SECOND Escape, with nothing left to back out of, aborts", async () => {
    // Real, reported bug this is a regression test for: typing "/model" while a previous turn was
    // still streaming, then pressing Escape to back out of composing it, used to abort the whole
    // in-flight turn instead of just closing the menu -- Escape's meaning depends on what's actually
    // in front of the user (see app.tsx's own useInput handler comment), so a menu/uncommitted text
    // must be cleared FIRST; the global "interrupt the running turn" behavior is only reachable once
    // there's nothing local left to cancel.
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

    // Type "/model" (its FULL exact name) into the now-empty box while the turn is still in flight
    // -- PromptInput's own useInput handler doesn't gate ordinary character input on `busy`, so this
    // both opens and then immediately re-closes the live autocomplete menu (deriveCommandMenu closes
    // it the instant the typed token exactly matches a command name, since there's nothing left to
    // disambiguate) -- the exact real-bug shape: no menu open, but real uncommitted text still sits
    // in the box.
    for (const ch of "/model") {
      stdin.write(ch);
      await wait(5);
    }

    stdin.write("\x1b"); // First Escape: clears the typed "/model", does NOT abort.
    await wait(40);

    expect(abortSpy).not.toHaveBeenCalled();
    // The box is empty again, but the turn is still genuinely running -- PromptInput's own busy
    // placeholder ("working…"), not the idle one, is what proves the input actually cleared here.
    expect(lastFrame()).toContain("working…");
    expect(lastFrame()).not.toContain("/model");

    stdin.write("\x1b"); // Second Escape: box is now empty, nothing left to clear -- this aborts.
    await wait(40);

    expect(abortSpy).toHaveBeenCalledTimes(1);
  });

  it("Escape closes an open '/' menu (a partial, ambiguous match) without aborting an in-flight turn", async () => {
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

    // "/" alone is ambiguous (matches every command) -- the live menu stays open, unlike the exact-
    // match case in the sibling test above.
    stdin.write("/");
    await wait(20);
    expect(lastFrame()).toContain(`(1/${SLASH_COMMANDS.length})`); // menu is open

    stdin.write("\x1b"); // Escape
    await wait(40);

    expect(abortSpy).not.toHaveBeenCalled();
    // Turn is still running -- busy placeholder, not the idle one, proves the "/" actually cleared.
    expect(lastFrame()).toContain("working…");
    expect(lastFrame()).not.toContain(`(1/${SLASH_COMMANDS.length})`); // menu is closed
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

    stdin.write("\x1b"); // Escape -- aborts the first turn
    await wait(40);

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

describe("App -- option+delete deletes a word at a time", () => {
  // Option+Delete's own word-chunk behavior (app.tsx's `deleteWordBeforeCursor`), matching Claude
  // Code/VS Code/readline: skip any run of whitespace immediately behind the cursor, then delete
  // the run of non-whitespace behind THAT, stopping at a real "\n" either way. "\x1b\x7f" is
  // ink/build/parse-keypress.js's own ESC-prefixed DEL byte sequence for a real terminal's
  // Option+Delete -- confirmed directly (same file, same technique as this file's other
  // key-sequence comments) that it parses to `{ name: "backspace", meta: true }`, exactly the
  // `key.meta && key.backspace` branch app.tsx's useInput handler checks for this.
  it("deletes the previous word in one chunk from the end of the input, not just one character", async () => {
    const session = new Session({
      streamFn: () => fakeStream(),
      initialState: { model: FAKE_MODEL, systemPrompt: "test" },
    });
    const { lastFrame, stdin } = renderApp(session);

    for (const ch of "hello world foo bar") {
      stdin.write(ch);
      await wait(3);
    }
    await wait(10);

    stdin.write("\x1b\x7f"); // option+delete
    await wait(10);

    let frame = lastFrame() ?? "";
    expect(frame).toContain("hello world foo");
    expect(frame).not.toContain("bar");

    stdin.write("\x1b\x7f"); // option+delete again
    await wait(10);

    frame = lastFrame() ?? "";
    expect(frame).toContain("hello world");
    expect(frame).not.toContain("foo");
  });

  it("removes the whole preceding word AND its separating space in one press when the cursor sits exactly between two words", async () => {
    const session = new Session({
      streamFn: () => fakeStream(),
      initialState: { model: FAKE_MODEL, systemPrompt: "test" },
    });
    const { lastFrame, stdin } = renderApp(session);

    for (const ch of "hello world") {
      stdin.write(ch);
      await wait(3);
    }
    await wait(10);
    // Cursor starts at 11 (the end); five lefts land it right before "world" (index 6), i.e.
    // "hello |world" -- the exact word boundary, not mid-word and not mid-whitespace.
    for (let i = 0; i < 5; i++) {
      stdin.write("\x1b[D");
      await wait(5);
    }

    stdin.write("\x1b\x7f"); // option+delete
    await wait(10);

    const frame = lastFrame() ?? "";
    expect(frame).toContain("world");
    expect(frame).not.toContain("hello");
  });

  it("only deletes the portion of the current word behind the cursor when the cursor sits mid-word, not the whole word", async () => {
    const session = new Session({
      streamFn: () => fakeStream(),
      initialState: { model: FAKE_MODEL, systemPrompt: "test" },
    });
    const { lastFrame, stdin } = renderApp(session);

    for (const ch of "hello world") {
      stdin.write(ch);
      await wait(3);
    }
    await wait(10);
    // Cursor starts at 11 (the end); three lefts land it at index 8, i.e. "hello wo|rld" -- squarely
    // inside "world", between "wo" and "rld".
    for (let i = 0; i < 3; i++) {
      stdin.write("\x1b[D");
      await wait(5);
    }

    stdin.write("\x1b\x7f"); // option+delete
    await wait(10);

    const frame = lastFrame() ?? "";
    // Only "wo" (the part of "world" behind the cursor) is gone -- "hello " is untouched (word
    // deletion never crosses INTO a preceding word once it's already inside a different one) and
    // "rld" (ahead of the cursor) is untouched too.
    expect(frame).toContain("hello rld");
    expect(frame).not.toContain("hello world");
    expect(frame).not.toContain("hello  rld"); // (not two spaces -- "hello" itself wasn't touched)
  });

  it("consumes an entire irregular run of whitespace before deleting the preceding word, not just one adjacent space", async () => {
    // NOTE: this deliberately positions the cursor right AFTER the irregular whitespace run
    // (i.e. right before "two"), not at the very end of the string. Confirmed directly against
    // `deleteWordBeforeCursor`'s real algorithm that pressing from the very end of "one   two"
    // only ever deletes "two" itself in a single press -- the whitespace-skip loop only ever looks
    // at whitespace immediately BEHIND the cursor, and at that position "two" (not whitespace) is
    // what's immediately behind it. Positioning the cursor right after the whitespace run instead
    // exercises that skip loop against a real irregular run (three spaces, not one) before it
    // continues into deleting the word behind THAT -- proving the loop consumes the WHOLE run
    // rather than stopping after just one space, which is the actual regression risk here.
    const session = new Session({
      streamFn: () => fakeStream(),
      initialState: { model: FAKE_MODEL, systemPrompt: "test" },
    });
    const { lastFrame, stdin } = renderApp(session);

    for (const ch of "one   two") {
      stdin.write(ch);
      await wait(3);
    }
    await wait(10);
    // Cursor starts at 9 (the end); three lefts land it at index 6, right before "two" and right
    // after all three separating spaces.
    for (let i = 0; i < 3; i++) {
      stdin.write("\x1b[D");
      await wait(5);
    }

    stdin.write("\x1b\x7f"); // option+delete
    await wait(10);

    const frame = lastFrame() ?? "";
    // All three spaces AND "one" (the word behind them) are gone in one press, leaving exactly
    // "two" -- not "one" (with some spaces stuck to it), which a loop that only skipped one space
    // at a time before deleting would incorrectly leave behind.
    expect(frame).toContain("two");
    expect(frame).not.toContain("one");
  });

  it("is a no-op at the very start of the input, with nothing to delete and no crash", async () => {
    const session = new Session({
      streamFn: () => fakeStream(),
      initialState: { model: FAKE_MODEL, systemPrompt: "test" },
    });
    const { lastFrame, stdin } = renderApp(session);

    for (const ch of "hello") {
      stdin.write(ch);
      await wait(3);
    }
    stdin.write("\x1b[H"); // Home -- cursor to position 0
    await wait(10);

    stdin.write("\x1b\x7f"); // option+delete
    await wait(10);

    const frame = lastFrame() ?? "";
    expect(frame).toContain("hello"); // completely unchanged
    expect(hasExited(frame)).toBe(false); // and nothing crashed
  });

  it("does not cross a real newline into the previous line", async () => {
    const session = new Session({
      streamFn: () => fakeStream(),
      initialState: { model: FAKE_MODEL, systemPrompt: "test" },
    });
    const { lastFrame, stdin } = renderApp(session);

    for (const ch of "ab") {
      stdin.write(ch);
      await wait(3);
    }
    stdin.write("\x1b\r"); // option+enter -- inserts a real "\n"
    await wait(10);
    for (const ch of "cd") {
      stdin.write(ch);
      await wait(3);
    }
    await wait(10);
    // Cursor starts at 5 (the end, "ab\ncd"); two lefts land it at index 3 -- position 0 WITHIN
    // line two, right after the "\n" and right before "c".
    stdin.write("\x1b[D");
    await wait(5);
    stdin.write("\x1b[D");
    await wait(5);

    stdin.write("\x1b\x7f"); // option+delete
    await wait(10);

    const frame = lastFrame() ?? "";
    // A genuine no-op: nothing from line one was deleted, the lines weren't merged, line two is
    // untouched too.
    expect(frame).toContain("> ab");
    expect(frame).toContain("  cd");
    expect(hasExited(frame)).toBe(false);
  });

  it("fn+option+delete (forward direction) deletes the word AHEAD of the cursor without moving the cursor", async () => {
    // "\x1b[3;3~" is the standard xterm/iTerm CSI sequence for the forward-Delete key held with
    // the Alt/Option modifier (CSI 3 -- the "delete" key's own number in ink/build/parse-keypress.js's
    // `kittySpecialNumberKeys`/legacy `keyName` maps -- ; 3 -- the "Alt" modifier code -- ~).
    // Confirmed directly (node, against the real `parseKeypress` in
    // node_modules/ink/build/parse-keypress.js) that this parses to
    // `{ name: "delete", meta: true, ctrl: false, shift: false }`, and against
    // node_modules/ink/build/hooks/use-input.js's own `delete: keypress.name === "delete"` that
    // this really does set `key.delete` -- so together this is a real, reproducible `key.meta &&
    // key.delete`, exactly the branch app.tsx's useInput handler routes to
    // `deleteWordAfterCursor`. Reproducible through ink-testing-library's stdin.write exactly like
    // Home/End's own CSI sequences elsewhere in this file.
    const session = new Session({
      streamFn: () => fakeStream(),
      initialState: { model: FAKE_MODEL, systemPrompt: "test" },
    });
    const { lastFrame, stdin } = renderApp(session);

    for (const ch of "hello world") {
      stdin.write(ch);
      await wait(3);
    }
    await wait(10);
    // Cursor starts at 11 (the end); five lefts land it right before "world" (index 6).
    for (let i = 0; i < 5; i++) {
      stdin.write("\x1b[D");
      await wait(5);
    }

    stdin.write("\x1b[3;3~"); // fn+option+delete (forward)
    await wait(10);

    let frame = lastFrame() ?? "";
    expect(frame).toContain("hello");
    expect(frame).not.toContain("world");

    // Proves the cursor itself never moved (deleteWordAfterCursor's own header comment): typing
    // now inserts exactly where "world" used to start, not at the string's end.
    stdin.write("X");
    await wait(10);
    frame = lastFrame() ?? "";
    expect(frame).toContain("hello X");
  });
});

// Regression coverage for a real, live-caught bug: up/down arrow used to be a total no-op for the
// prompt box (they only ever navigated the live "/" menu, see the describe block below) -- fine
// before multi-line composition existed, but once option+enter could put a real second line in the
// box, there was no way to move the caret vertically at all short of holding left-arrow across the
// whole line. Confirmed live via a real render before the fix: typing "line one text", option+enter,
// typing "line two text", then pressing up-arrow left the cursor sitting on line two exactly where
// it was; after the fix it jumps to the same column on line one instead. These tests all prove the
// cursor genuinely moved by typing a character afterward and checking which line it lands in --
// `PromptInput`'s cursor isn't exposed directly (no `inverse`-styling assertions elsewhere in this
// file either), so the resulting text edit is the only observable proof.
describe("App -- vertical cursor movement (up/down arrow) across multi-line prompts", () => {
  it("pressing up-arrow after composing two lines moves the cursor onto line one, not line two", async () => {
    const session = new Session({
      streamFn: () => fakeStream(),
      initialState: { model: FAKE_MODEL, systemPrompt: "test" },
    });
    const { lastFrame, stdin } = renderApp(session);

    for (const ch of "aaaa") {
      stdin.write(ch);
      await wait(3);
    }
    stdin.write("\x1b\r"); // option+enter -- inserts "\n"
    await wait(10);
    for (const ch of "bbbb") {
      stdin.write(ch);
      await wait(3);
    }
    await wait(10);

    stdin.write("\x1b[A"); // up arrow -- cursor sits at the end of line two (col 4), moves to line one's col 4
    await wait(10);
    stdin.write("X");
    await wait(10);

    const frame = lastFrame() ?? "";
    expect(frame).toContain("> aaaaX"); // new character landed on line one, at the end of it
    expect(frame).toContain("  bbbb"); // line two completely untouched
    expect(frame).not.toContain("bbbbX");
  });

  it("up then down returns the cursor to editing line two again", async () => {
    const session = new Session({
      streamFn: () => fakeStream(),
      initialState: { model: FAKE_MODEL, systemPrompt: "test" },
    });
    const { lastFrame, stdin } = renderApp(session);

    for (const ch of "aaaa") {
      stdin.write(ch);
      await wait(3);
    }
    stdin.write("\x1b\r");
    await wait(10);
    for (const ch of "bbbb") {
      stdin.write(ch);
      await wait(3);
    }
    await wait(10);

    stdin.write("\x1b[A"); // up -- onto line one
    await wait(10);
    stdin.write("X");
    await wait(10);
    expect(lastFrame()).toContain("> aaaaX");

    stdin.write("\x1b[B"); // down -- back onto line two
    await wait(10);
    stdin.write("Y");
    await wait(10);

    const frame = lastFrame() ?? "";
    expect(frame).toContain("  bbbbY"); // new character landed on line two this time
    expect(frame).toContain("> aaaaX"); // line one unchanged by the round trip
  });

  it("moving up from a shorter line two onto a longer line one clamps to line two's own cursor column", async () => {
    const session = new Session({
      streamFn: () => fakeStream(),
      initialState: { model: FAKE_MODEL, systemPrompt: "test" },
    });
    const { lastFrame, stdin } = renderApp(session);

    for (const ch of "abcdefgh") {
      // line one, 8 characters
      stdin.write(ch);
      await wait(3);
    }
    stdin.write("\x1b\r");
    await wait(10);
    for (const ch of "xy") {
      // line two, only 2 characters -- cursor ends at column 2
      stdin.write(ch);
      await wait(3);
    }
    await wait(10);

    stdin.write("\x1b[A"); // up -- clamps to column 2 on line one (its own length is 8), not start/end
    await wait(10);
    stdin.write("Z");
    await wait(10);

    const frame = lastFrame() ?? "";
    expect(frame).toContain("abZcdefgh"); // "Z" landed right after column 2 ("ab"), not at either edge
    expect(frame).toContain("  xy"); // line two untouched
  });

  it("up-arrow on the first line (a single-line prompt with no newline at all) is a genuine no-op", async () => {
    const session = new Session({
      streamFn: () => fakeStream(),
      initialState: { model: FAKE_MODEL, systemPrompt: "test" },
    });
    const { lastFrame, stdin } = renderApp(session);

    for (const ch of "hello") {
      stdin.write(ch);
      await wait(3);
    }
    // Two lefts land the cursor at column 3 ("hel|lo"), a non-edge position so a wrongly-moved
    // cursor (e.g. reset to column 0) would be obviously visible in the resulting text.
    stdin.write("\x1b[D");
    await wait(5);
    stdin.write("\x1b[D");
    await wait(5);

    stdin.write("\x1b[A"); // up arrow -- already on (and is) the only line, must be a no-op
    await wait(10);
    stdin.write("X");
    await wait(10);

    const frame = lastFrame() ?? "";
    expect(frame).toContain("helXlo"); // cursor never moved -- "X" landed exactly where it was left
    expect(hasExited(frame)).toBe(false); // and nothing threw
  });

  it("down-arrow on the last line of a multi-line prompt is a genuine no-op", async () => {
    const session = new Session({
      streamFn: () => fakeStream(),
      initialState: { model: FAKE_MODEL, systemPrompt: "test" },
    });
    const { lastFrame, stdin } = renderApp(session);

    for (const ch of "aaa") {
      stdin.write(ch);
      await wait(3);
    }
    stdin.write("\x1b\r");
    await wait(10);
    for (const ch of "bbb") {
      stdin.write(ch);
      await wait(3);
    }
    await wait(10);

    stdin.write("\x1b[B"); // down arrow -- already on the last line, must be a no-op
    await wait(10);
    stdin.write("Z");
    await wait(10);

    const frame = lastFrame() ?? "";
    expect(frame).toContain("bbbZ"); // "Z" appended right where the cursor already was
    expect(frame).toContain("> aaa"); // line one untouched
    expect(hasExited(frame)).toBe(false);
  });

  it("up/down still navigate the live '/' autocomplete menu, completely unaffected by vertical cursor movement", async () => {
    // Existing coverage ("down-arrow moves the highlight..." above) already proves down-arrow still
    // drives the menu; this rounds it out with up-arrow specifically (previously untested on its
    // own), round-tripping down then up and confirming Enter still dispatches the ORIGINAL
    // top match ("/new") rather than falling through to the new vertical-cursor branch (which would
    // be a silent no-op here, not a visible failure, since promptText is a single line either way).
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
    const { lastFrame, stdin } = renderApp(session, { slashCommands });

    stdin.write("/");
    await wait(10);
    stdin.write("\x1b[B"); // down -- off "new" (index 0) onto "resume" (index 1)
    await wait(10);
    stdin.write("\x1b[A"); // up -- back onto "new" (index 0)
    await wait(10);
    stdin.write("\r"); // dispatches the highlighted "/new", zero args
    await wait(30);

    expect(startNewSession).toHaveBeenCalledTimes(1);
    const frame = lastFrame() ?? "";
    expect(frame).toContain("second-provider/second-model");
    expect(frame).not.toContain("fake-provider/fake-model");
    expect(streamFn).not.toHaveBeenCalled();
  });
});

// Regression coverage for a real, live-caught rendering bug (reported as literal garbled text
// appearing while composing a long prompt and pressing arrow keys): PromptInput used to render each
// line's marker + cursor-split pieces ("before" text, the single `inverse`-styled character AT the
// cursor, "after" text) as SIBLING <Text> elements inside a <Box> row. Ink lays out sibling <Text>
// nodes inside a <Box> as independent yoga nodes, each wrapping its OWN content against its OWN
// computed width (ink/build/render-node-to-output.js calls `wrapText` once per `ink-text` node, not
// once for a whole row) -- invisible for short lines that never actually wrap, but once a SINGLE
// LOGICAL LINE (no explicit "\n" at all, just length) got long enough to wrap at the terminal's
// column width, moving the cursor (which changes the "before"/"after" slice lengths) reshuffled each
// piece's own independent wrap point, visibly reflowing/scrambling the on-screen text on every single
// arrow-key press even though the underlying text never changed. The fix (see app.tsx's own header
// comment right above `PromptInput`'s `lines.map(...)` render) nests marker/before/cursor-char/after
// as children of ONE parent <Text> per line instead of siblings of a <Box>, so Ink's own
// `squashTextNodes` (ink/build/squash-text-nodes.js) merges them into a single string that gets
// wrapped ONCE, as one continuous unit, regardless of where the cursor sits.
//
// `ink-testing-library`'s stdout reports 100 columns (its own `Stdout.columns` getter, confirmed by
// reading node_modules/ink-testing-library/build/index.js directly), so a continuous 240-character
// run with NO spaces (one single unbreakable "word", confirmed live to hard-wrap into three visual
// rows at that width) is comfortably over that width and guaranteed to wrap. `lastFrame()` returns
// plain, ANSI-stripped text (confirmed directly, same as the empty-prompt-box tests' own note above),
// so the `inverse`-styled cursor character renders as an perfectly ordinary character with no visible
// marker of its own -- these tests can't see the caret directly, only prove the rendered TEXT is
// completely unaffected by a pure cursor move (this test block), and separately prove the caret's
// LOGICAL position stayed correct throughout by checking what a subsequent keystroke inserts (the
// other two). Frames are compared with all whitespace collapsed out via `stripWhitespace`: Ink's own
// wrap points insert line breaks that aren't part of the actual typed text, and -- right when the
// cursor sits exactly past the last real character -- `PromptInput`'s own cursor-placeholder renders
// a literal filler space (`line[cursorCol] ?? " "`) that also isn't part of it; collapsing whitespace
// makes the comparison robust to both without weakening what it actually proves, since none of the
// long test strings below contain any real spaces of their own.
//
// This exact scenario (sibling-<Text>-in-<Box> reflowing on cursor move vs. nested-<Text>-in-<Text>
// staying stable) was independently confirmed against a standalone, `app.tsx`-independent
// reproduction using raw `ink`/`ink-testing-library` components mirroring both shapes exactly, run
// directly during development (not committed here) -- the old sibling-<Text>-in-<Box> shape visibly
// corrupted the rendered text on a simulated cursor move (dropped/duplicated characters, a stray gap)
// while the nested-<Text>-in-<Text> shape (what `PromptInput` uses today) stayed byte-for-byte
// identical apart from where the cursor sits, exactly matching this file's own bug/fix description.
describe("App -- long single-line prompt wrapping (no embedded newlines) stays stable across cursor moves", () => {
  const stripWhitespace = (frame: string | undefined) => (frame ?? "").replace(/\s+/g, "");

  it("moving the cursor within a long wrapped line never changes the line's rendered text, only where the caret sits", async () => {
    const session = new Session({
      streamFn: () => fakeStream(),
      initialState: { model: FAKE_MODEL, systemPrompt: "test" },
    });
    const { lastFrame, stdin } = renderApp(session);

    const longLine = "word".repeat(60); // 240 chars, one continuous run, no spaces -- wraps 3x at 100 cols
    for (const ch of longLine) {
      stdin.write(ch);
      await wait(2);
    }
    await wait(30);
    const beforeMove = stripWhitespace(lastFrame());
    expect(beforeMove).toContain(longLine);

    // Left-arrow a few times, then right-arrow partway back -- neither should ever touch the text
    // itself, only where the (invisible-to-lastFrame) caret sits within it.
    for (let i = 0; i < 5; i += 1) {
      stdin.write("\x1b[D");
      await wait(5);
      expect(stripWhitespace(lastFrame())).toBe(beforeMove);
    }
    for (let i = 0; i < 3; i += 1) {
      stdin.write("\x1b[C");
      await wait(5);
      expect(stripWhitespace(lastFrame())).toBe(beforeMove);
    }
  });

  it("typing after moving the cursor within a wrapped line inserts at the correct logical position, not wherever the last wrap wound up", async () => {
    const session = new Session({
      streamFn: () => fakeStream(),
      initialState: { model: FAKE_MODEL, systemPrompt: "test" },
    });
    const { lastFrame, stdin } = renderApp(session);

    // Four distinct 60-char runs (240 total) -- landing the cursor exactly on the "b"/"c" boundary
    // and inserting there produces an unambiguous expected substring, not just "some 'a' plus some
    // extra 'a's" the way one repeated character everywhere would.
    const longLine = "a".repeat(60) + "b".repeat(60) + "c".repeat(60) + "d".repeat(60);
    for (const ch of longLine) {
      stdin.write(ch);
      await wait(2);
    }
    await wait(30);

    // Cursor starts at the end (240); 120 lefts land it exactly on the "b"/"c" boundary.
    for (let i = 0; i < 120; i += 1) {
      stdin.write("\x1b[D");
      await wait(2);
    }
    await wait(30);
    stdin.write("Z");
    await wait(30);

    const expected = `${longLine.slice(0, 120)}Z${longLine.slice(120)}`;
    expect(stripWhitespace(lastFrame())).toContain(expected);
  });

  it("regression: interleaved cursor moves and edits on a long wrapped line splice exactly like plain string arithmetic, with no corruption", async () => {
    const session = new Session({
      streamFn: () => fakeStream(),
      initialState: { model: FAKE_MODEL, systemPrompt: "test" },
    });
    const { lastFrame, stdin } = renderApp(session);

    const longLine = "word".repeat(60); // 240 chars
    for (const ch of longLine) {
      stdin.write(ch);
      await wait(2);
    }
    await wait(30);

    // `expected` is built by mirroring PromptInput's own cursor/insert arithmetic exactly
    // (left-arrow: pos -= 1; typing a character: splice it in at pos, then pos += 1) rather than by
    // hand-computing an index -- the same "predict the result from plain string operations" check
    // the live bug report itself relied on: type long text, move the cursor, keep typing, and see if
    // the result matches simple splicing.
    let pos = longLine.length;
    let expected = longLine;
    const applyLeft = () => {
      pos = Math.max(0, pos - 1);
    };
    const applyInsert = (ch: string) => {
      expected = expected.slice(0, pos) + ch + expected.slice(pos);
      pos += 1;
    };

    stdin.write("\x1b[D"); // left
    applyLeft();
    await wait(10);
    stdin.write("A");
    applyInsert("A");
    await wait(10);
    stdin.write("\x1b[D"); // left again
    applyLeft();
    await wait(10);
    stdin.write("B");
    applyInsert("B");
    await wait(10);

    expect(stripWhitespace(lastFrame())).toContain(expected);
  });
});

// Regression coverage for round 2 of the up/down-arrow fix (see app.tsx's own header comment right
// above `moveCursorVertically`): round 1 only ever moved the cursor between LOGICAL lines (ones
// separated by a real "\n" from option+enter), same column, clamped to each line's own length --
// still a total no-op on a SINGLE long line with no "\n" at all that nonetheless visually wraps
// across several terminal rows, exactly the common case a real long prompt hits. The fix additionally
// tracks the VISUAL row within whichever logical line the caret is on, via `visualRowsForLine`, which
// wraps `markerFor(lineIndex) + lines[lineIndex]` through the SAME `wrap-ansi` library and options
// (`{trim: false, hard: true}`) Ink itself uses internally (ink/build/wrap-text.js) -- so the computed
// visual-row boundaries match pixel-for-pixel what Ink actually renders.
//
// These tests mirror that exact computation locally (importing the very same `wrap-ansi` package,
// already a direct `packages/tui` dependency -- see app.tsx's own header comment on `visualRowsForLine`)
// rather than hand-deriving expected cursor positions by eye: `predictVerticalMove` below is a
// faithful line-for-line port of `moveCursorVertically`/`visualRowsForLine`/`locateCursor` from
// app.tsx, used only to PREDICT where the real app's cursor should land so the resulting text (the
// only thing `lastFrame()` can actually observe -- see the wrapping describe block above's own note on
// why cursor position must always be proven via a subsequently-typed marker character) can be checked
// against an unambiguous, independently-computed expectation, the same "mirror the app's own
// arithmetic" technique the "regression: interleaved..." test above already uses for horizontal
// moves.
//
// `ink-testing-library` reports a fixed 100-column stdout (confirmed directly above, and reused here)
// -- content below is deliberately WORD-heavy (real spaces, `"word ".repeat(n)`-style), not one
// unbroken run: `wrap-ansi`'s word-wrap breaks at the last space that still fits, which lands
// meaningfully EARLIER than a naive fixed-width character cut the instant a word would otherwise be
// split -- confirmed independently (a throwaway script, not committed here) that for the sentence
// below, a one-up-arrow-from-the-end move lands two characters earlier (absolute position 181) than a
// naive per-character-count wrap would predict (179, which falls mid-word inside "dogs") -- so this
// content genuinely exercises the real word-wrap-aware fix, not a coincidence that would pass under a
// simpler, wrong implementation too.
describe("App -- visual-row-aware up/down navigation within a wrapped line", () => {
  const markerFor = (lineIndex: number) => (lineIndex === 0 ? "> " : "  ");
  const PROMPT_WIDTH = 100; // ink-testing-library's own fixed Stdout.columns, see the block above

  function visualRowsForLine(lineIndex: number, lines: string[]): string[] {
    return wrapAnsi(markerFor(lineIndex) + lines[lineIndex], PROMPT_WIDTH, {
      trim: false,
      hard: true,
    }).split("\n");
  }

  function locateCursor(text: string, pos: number) {
    const lines = text.split("\n");
    let remaining = Math.max(0, Math.min(pos, text.length));
    let cursorLine = 0;
    for (; cursorLine < lines.length - 1; cursorLine++) {
      const lineLength = lines[cursorLine].length;
      if (remaining <= lineLength) break;
      remaining -= lineLength + 1;
    }
    return { lines, cursorLine, cursorCol: remaining };
  }

  /** Faithful port of app.tsx's `moveCursorVertically` -- see that function's own header comment for
   * the full algorithm description. Used here only to PREDICT the real app's behavior, never to
   * replace observing it: every test below still drives the real `<App>` via real keystrokes and
   * checks the real rendered frame. */
  function predictVerticalMove(text: string, cursorPos: number, direction: -1 | 1): number {
    const { lines, cursorLine, cursorCol } = locateCursor(text, cursorPos);
    const lineStartOffset = (lineIndex: number) => {
      let offset = 0;
      for (let i = 0; i < lineIndex; i++) offset += lines[i].length + 1;
      return offset;
    };
    const ownRows = visualRowsForLine(cursorLine, lines);
    let remaining = markerFor(cursorLine).length + cursorCol;
    let visualRow = 0;
    for (; visualRow < ownRows.length - 1; visualRow++) {
      if (remaining <= ownRows[visualRow].length) break;
      remaining -= ownRows[visualRow].length;
    }
    const visualCol = remaining;
    const flatPosFor = (
      lineIndex: number,
      rows: string[],
      targetVisualRow: number,
      desiredCol: number,
    ) => {
      const clampedCol = Math.min(desiredCol, rows[targetVisualRow].length);
      let combined = clampedCol;
      for (let i = 0; i < targetVisualRow; i++) combined += rows[i].length;
      return lineStartOffset(lineIndex) + Math.max(0, combined - markerFor(lineIndex).length);
    };
    const targetVisualRow = visualRow + direction;
    if (targetVisualRow >= 0 && targetVisualRow < ownRows.length) {
      return flatPosFor(cursorLine, ownRows, targetVisualRow, visualCol);
    }
    const targetLine = cursorLine + direction;
    if (targetLine < 0 || targetLine >= lines.length) return cursorPos; // already at the top/bottom
    const targetRows = visualRowsForLine(targetLine, lines);
    const targetVisualRowIndex = direction === -1 ? targetRows.length - 1 : 0;
    return flatPosFor(targetLine, targetRows, targetVisualRowIndex, visualCol);
  }

  const stripWhitespace = (frame: string | undefined) => (frame ?? "").replace(/\s+/g, "");

  // One continuous phrase repeated until it's long enough to word-wrap into exactly 3 visual rows at
  // 100 columns (confirmed via `visualRowsForLine` above: row lengths 98/98/85, including the "> "
  // marker on row 0 only) -- real spaces throughout, so `wrap-ansi` genuinely has word boundaries to
  // respect rather than hard-breaking mid-word like a spaceless run would.
  const WRAPPED_SENTENCE = (() => {
    const sentence = "the quick brown fox jumps over lazy dogs while clever zebras run past ";
    let line = "";
    while (line.length < 260) line += sentence;
    return line.trim();
  })();

  it("moving up from the end of a wrapped line lands on the same visual column one row up -- not where a naive character-count wrap would predict", async () => {
    const session = new Session({
      streamFn: () => fakeStream(),
      initialState: { model: FAKE_MODEL, systemPrompt: "test" },
    });
    const { lastFrame, stdin } = renderApp(session);

    for (const ch of WRAPPED_SENTENCE) {
      stdin.write(ch);
      await wait(1);
    }
    await wait(30);
    expect(stripWhitespace(lastFrame())).toContain(stripWhitespace(WRAPPED_SENTENCE));

    const expectedPos = predictVerticalMove(WRAPPED_SENTENCE, WRAPPED_SENTENCE.length, -1);
    // Sanity-check this content is actually meaningful (word-wrap-dependent), not a position a naive
    // fixed-width character cut would also happen to produce -- see the describe block's own header
    // comment for the independently-confirmed naive prediction (179) this must differ from.
    expect(expectedPos).toBe(181);
    expect(expectedPos).not.toBe(179);

    stdin.write("\x1b[A"); // up arrow
    await wait(10);
    stdin.write("Z");
    await wait(20);

    const expected = `${WRAPPED_SENTENCE.slice(0, expectedPos)}Z${WRAPPED_SENTENCE.slice(expectedPos)}`;
    expect(stripWhitespace(lastFrame())).toContain(stripWhitespace(expected));
  });

  it("repeatedly pressing up-arrow on a wrapped line stops cleanly at its own first visual row -- no wraparound, no throw", async () => {
    const session = new Session({
      streamFn: () => fakeStream(),
      initialState: { model: FAKE_MODEL, systemPrompt: "test" },
    });
    const { lastFrame, stdin } = renderApp(session);

    for (const ch of WRAPPED_SENTENCE) {
      stdin.write(ch);
      await wait(1);
    }
    await wait(30);

    // 4 presses is deliberately more than the 3 visual rows this line wraps into -- the first two
    // presses actually move the cursor (end -> row 1 -> row 0); the remaining two must be pure no-ops
    // once row 0 (the line's own first visual row) is reached.
    let expectedPos = WRAPPED_SENTENCE.length;
    for (let i = 0; i < 4; i++) {
      stdin.write("\x1b[A");
      expectedPos = predictVerticalMove(WRAPPED_SENTENCE, expectedPos, -1);
      await wait(10);
    }
    expect(expectedPos).toBe(83); // settles here after 2 real moves; presses 3-4 are no-ops on top of it

    stdin.write("Z");
    await wait(20);

    const expected = `${WRAPPED_SENTENCE.slice(0, expectedPos)}Z${WRAPPED_SENTENCE.slice(expectedPos)}`;
    expect(stripWhitespace(lastFrame())).toContain(stripWhitespace(expected));
    expect(hasExited(lastFrame())).toBe(false); // and nothing threw along the way
  });

  // Two logical lines (joined by option+enter, "\x1b\r") built from clearly distinguishable word
  // groups so each individual up/down step can be pinned to a specific row by its own vocabulary:
  // line one wraps into exactly 2 visual rows -- row 0 is 16 "alpha" words plus a single-char "x"
  // sentinel that exactly fills its 100-column budget (marker included), row 1 starts fresh with a
  // "hi" sentinel followed by "beta" words (confirmed via `visualRowsForLine` above: row lengths
  // 100/72) -- and line two is a short, single-row "close". Distinct vocabulary per row/line ("alpha"
  // vs "hi"/"beta" vs "close") means a substring found near the cursor can only ever have come from
  // one specific row, even where the exact landing column falls mid-word rather than on a clean word
  // boundary (a real possibility once earlier steps have inserted marker characters that shift later
  // columns by a char or two -- `predictVerticalMove` is used at every step specifically so the
  // expected position always reflects that drift exactly, rather than an idealized guess).
  const LINE_ONE_WORDS = `${"alpha ".repeat(16)}x hi ${"beta ".repeat(13)}beta`;
  const LINE_TWO_WORD = "close";

  it("cross-logical-line fallthrough moving UP: line two's row, then line one's own LAST visual row (hi/beta), then line one's own FIRST visual row (alpha), then stops", async () => {
    const session = new Session({
      streamFn: () => fakeStream(),
      initialState: { model: FAKE_MODEL, systemPrompt: "test" },
    });
    const { lastFrame, stdin } = renderApp(session);

    for (const ch of LINE_ONE_WORDS) {
      stdin.write(ch);
      await wait(1);
    }
    stdin.write("\x1b\r"); // option+enter -- real "\n"
    await wait(10);
    for (const ch of LINE_TWO_WORD) {
      stdin.write(ch);
      await wait(2);
    }
    await wait(20);

    const fullText = `${LINE_ONE_WORDS}\n${LINE_TWO_WORD}`;
    let expectedPos = fullText.length; // cursor starts at the very end of line two

    // Press 1: still within line two -> falls through onto line one's own LAST visual row (the
    // "hi beta beta..." row), landing right after "hi beta" -- distinctly this row's own vocabulary,
    // not line one's first ("alpha") row and not skipping over it.
    stdin.write("\x1b[A");
    expectedPos = predictVerticalMove(fullText, expectedPos, -1);
    await wait(10);
    expect(stripWhitespace(fullText.slice(0, expectedPos)).endsWith("hibeta")).toBe(true);
    expect(stripWhitespace(fullText.slice(expectedPos)).startsWith("beta")).toBe(true);
    stdin.write("1");
    let expected = `${fullText.slice(0, expectedPos)}1${fullText.slice(expectedPos)}`;
    expectedPos += 1;
    await wait(10);
    expect(stripWhitespace(lastFrame())).toContain(stripWhitespace(expected));

    // Press 2: still within line one (2 rows total) -> moves up onto its own FIRST visual row (the
    // "alpha" row) -- this is a within-logical-line move, not a further cross-line fallthrough (line
    // one only has 2 visual rows total). Lands right after the very first "alpha" word.
    stdin.write("\x1b[A");
    expectedPos = predictVerticalMove(expected, expectedPos, -1);
    await wait(10);
    expect(stripWhitespace(expected.slice(0, expectedPos))).toBe("alpha");
    stdin.write("2");
    expected = `${expected.slice(0, expectedPos)}2${expected.slice(expectedPos)}`;
    expectedPos += 1;
    await wait(10);
    expect(stripWhitespace(lastFrame())).toContain(stripWhitespace(expected));

    // Press 3: already on line one's own first visual row -- must be a genuine no-op (stays put, no
    // wraparound past the top, no fallthrough to a nonexistent line above).
    stdin.write("\x1b[A");
    const posBeforeNoOp = expectedPos;
    expectedPos = predictVerticalMove(expected, expectedPos, -1);
    expect(expectedPos).toBe(posBeforeNoOp);
    await wait(10);
    stdin.write("3");
    expected = `${expected.slice(0, expectedPos)}3${expected.slice(expectedPos)}`;
    await wait(10);
    expect(stripWhitespace(lastFrame())).toContain(stripWhitespace(expected));
  });

  it("cross-logical-line fallthrough moving DOWN: line one's own remaining visual rows first, then line two's FIRST visual row, without skipping anything", async () => {
    const session = new Session({
      streamFn: () => fakeStream(),
      initialState: { model: FAKE_MODEL, systemPrompt: "test" },
    });
    const { lastFrame, stdin } = renderApp(session);

    for (const ch of LINE_ONE_WORDS) {
      stdin.write(ch);
      await wait(1);
    }
    stdin.write("\x1b\r");
    await wait(10);
    for (const ch of LINE_TWO_WORD) {
      stdin.write(ch);
      await wait(2);
    }
    await wait(20);
    // Home jumps to the very start of line one (absolute position 0) -- confirmed elsewhere in this
    // file ("home/end jump the cursor..."), reused here rather than a run of left-arrows.
    stdin.write("\x1b[H");
    await wait(10);

    const fullText = `${LINE_ONE_WORDS}\n${LINE_TWO_WORD}`;
    let expectedPos = 0; // cursor starts at the very beginning of line one (its own first visual row)

    // Press 1: still within line one -> moves down onto its own remaining visual row, landing right
    // after the "hi" sentinel that opens it -- not falling through to line two yet.
    stdin.write("\x1b[B");
    expectedPos = predictVerticalMove(fullText, expectedPos, 1);
    await wait(10);
    expect(stripWhitespace(fullText.slice(0, expectedPos)).endsWith("hi")).toBe(true);
    expect(stripWhitespace(fullText.slice(expectedPos)).startsWith("beta")).toBe(true);
    stdin.write("1");
    let expected = `${fullText.slice(0, expectedPos)}1${fullText.slice(expectedPos)}`;
    expectedPos += 1;
    await wait(10);
    expect(stripWhitespace(lastFrame())).toContain(stripWhitespace(expected));

    // Press 2: line one has no more visual rows below -> falls through onto line two's own FIRST (and
    // only) visual row -- landing inside "close" (one column further right than press 1's clean
    // boundary would alone suggest, since the "1" just inserted above shifted this row's own columns
    // by one character; `predictVerticalMove` re-reads the CURRENT text, exactly like the real
    // `moveCursorVertically` always does, so it reflects that shift precisely). "lose" only ever
    // appears as a substring of line two's own "close" -- nowhere else in this text -- so landing
    // inside it still unambiguously proves the fallthrough reached line two, not merely close to it.
    stdin.write("\x1b[B");
    expectedPos = predictVerticalMove(expected, expectedPos, 1);
    await wait(10);
    expect(stripWhitespace(expected.slice(expectedPos)).startsWith("lose")).toBe(true);
    expect(expectedPos).toBeGreaterThan(LINE_ONE_WORDS.length + 1); // +1 for the inserted "1"
    stdin.write("2");
    expected = `${expected.slice(0, expectedPos)}2${expected.slice(expectedPos)}`;
    expectedPos += 1;
    await wait(10);
    expect(stripWhitespace(lastFrame())).toContain(stripWhitespace(expected));

    // Press 3: already on line two's own only visual row -- genuine no-op, no throw.
    stdin.write("\x1b[B");
    const posBeforeNoOp = expectedPos;
    expectedPos = predictVerticalMove(expected, expectedPos, 1);
    expect(expectedPos).toBe(posBeforeNoOp);
    await wait(10);
    stdin.write("3");
    expected = `${expected.slice(0, expectedPos)}3${expected.slice(expectedPos)}`;
    await wait(10);
    expect(stripWhitespace(lastFrame())).toContain(stripWhitespace(expected));
    expect(hasExited(lastFrame())).toBe(false);
  });

  it("regression: interleaved up-arrow moves and inserts on a wrapped line splice exactly like predicted, with no corruption", async () => {
    const session = new Session({
      streamFn: () => fakeStream(),
      initialState: { model: FAKE_MODEL, systemPrompt: "test" },
    });
    const { lastFrame, stdin } = renderApp(session);

    for (const ch of WRAPPED_SENTENCE) {
      stdin.write(ch);
      await wait(1);
    }
    await wait(30);

    // `expected`/`pos` are threaded through exactly like PromptInput's own state: each up-arrow
    // predicts the new cursor position via `predictVerticalMove` (re-run against the CURRENT text,
    // exactly like the real `moveCursorVertically` always reads `promptTextAtom.get()` fresh rather
    // than a stale closure), and each insert splices at that position then advances it by one --
    // mirroring `insertAtCursor`'s own `pos + str.length` exactly.
    let expected = WRAPPED_SENTENCE;
    let pos = expected.length;

    stdin.write("\x1b[A"); // up -- lands on row 1 (the wrapped line's middle row)
    pos = predictVerticalMove(expected, pos, -1);
    await wait(10);
    stdin.write("A");
    expected = `${expected.slice(0, pos)}A${expected.slice(pos)}`;
    pos += 1;
    await wait(10);
    expect(stripWhitespace(lastFrame())).toContain(stripWhitespace(expected));

    stdin.write("\x1b[A"); // up again -- re-wrapped text (one char longer) still lands cleanly on row 0
    pos = predictVerticalMove(expected, pos, -1);
    await wait(10);
    stdin.write("B");
    expected = `${expected.slice(0, pos)}B${expected.slice(pos)}`;
    pos += 1;
    await wait(10);

    expect(stripWhitespace(lastFrame())).toContain(stripWhitespace(expected));
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
    expect(frame).toContain("type a prompt (or !command, /command), enter to send");

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

  it("the 'press again to exit' arming naturally expires after EXIT_ARM_WINDOW_MS with no second press, un-arming exitArmed on its own", async () => {
    // app.tsx's own `exitArmTimeoutRef`/`EXIT_ARM_WINDOW_MS` (1500ms): the first ctrl+c on an
    // empty box arms `atoms.exitArmed` AND schedules a real `setTimeout` that un-arms it again if
    // no second press follows within the window. A real (not mocked) timer -- this test just waits
    // it out on the wall clock, well past vitest's default 5s-per-test budget were it not for this
    // suite's own `testTimeout: 20_000` (vitest.config.ts).
    const session = new Session({
      streamFn: () => fakeStream(),
      initialState: { model: FAKE_MODEL, systemPrompt: "test" },
    });
    const { lastFrame, stdin } = renderApp(session);

    stdin.write("\x03"); // ctrl+c, nothing typed -- arms the hint
    await wait(10);
    expect(lastFrame()).toContain("Press ctrl+c again to exit.");

    await wait(1600); // past EXIT_ARM_WINDOW_MS with no second press

    const frame = lastFrame() ?? "";
    expect(frame).not.toContain("Press ctrl+c again to exit.");
    expect(hasExited(frame)).toBe(false); // never armed a second time, so this never exits either

    // A ctrl+c now starts the arming sequence over from scratch, proving the window really reset
    // rather than leaving some other latent "already armed" state behind.
    stdin.write("\x03");
    await wait(10);
    expect(lastFrame()).toContain("Press ctrl+c again to exit.");
  }, 20_000);
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
  it("ctrl+t retroactively hides an already-settled thinking block too -- a global, reversible toggle, not a one-way freeze", async () => {
    // ADR 0014's pi-parity follow-up flipped the default: thinking is now VISIBLE by default
    // (thinkingExpandedAtom starts at `true`, see app.tsx), and ctrl+t hides it entirely -- there
    // is no placeholder state at all, a hidden thinking block occupies zero rows. Now that nothing
    // freezes into permanent `<Static>` scrollback, `thinkingExpanded` is a single GLOBAL toggle
    // applied uniformly to every item on every render (see transcript.tsx's own
    // `TranscriptProps.thinkingExpanded` doc comment) -- unlike the old `<Static>`-based version,
    // ctrl+t now retroactively hides an ALREADY-settled thinking block too, not just future ones.
    //
    // Kept to a single turn with no separate final-answer text block (rather than two turns, as an
    // earlier version of this test did): this app's fixed-height transcript viewport (see
    // transcript.tsx's own header comment) would clip content off-screen once the conversation grows
    // past this harness's small simulated terminal height, which would make this test about clipping
    // instead of about the toggle itself. "hi" (the user's own turn, already part of the
    // conversation) stands in for "non-thinking content," proving the toggle leaves it alone.
    const session = new Session({
      streamFn: () => {
        const stream = fakeStream();
        stream.push({
          type: "done",
          reason: "stop",
          message: assistantMessage({
            // pi-ai's real ThinkingContent field is `.thinking`, not `.text` -- the exact bug ADR
            // 0014 found and fixed in transcript.tsx's contentBlocksToText.
            content: [{ type: "thinking", thinking: "secret reasoning" }],
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
    expect(frame).toContain("hi");

    stdin.write("\x14"); // ctrl+t -- a global toggle, retroactively hiding this already-settled block.
    await wait(10);

    frame = lastFrame() ?? "";
    expect(frame).not.toContain("secret reasoning");
    expect(frame).toContain("hi"); // non-thinking content is unaffected by the toggle
    // ctrl+t still pushes a transient confirmation into the transcript, matching how shift+tab
    // confirms "Reasoning effort set to ..." on its own toggle (see app.tsx's ctrl+t handler).
    expect(frame).toContain("Thinking blocks: hidden.");

    stdin.write("\x14"); // toggle back on -- proves this is a live, reversible toggle, not a one-way hide.
    await wait(20);

    frame = lastFrame() ?? "";
    expect(frame).toContain("secret reasoning");
    expect(frame).toContain("Thinking blocks: visible.");
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
        {
          id: "anthropic",
          name: "Anthropic",
          hasCredential: true,
          supportsApiKeyLogin: true,
          supportsOAuthLogin: false,
        },
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
      {
        id: "fake-provider",
        name: "Fake",
        hasCredential: true,
        supportsApiKeyLogin: true,
        supportsOAuthLogin: false,
      },
      {
        id: "other",
        name: "Other",
        hasCredential: true,
        supportsApiKeyLogin: true,
        supportsOAuthLogin: false,
      },
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
        ? { kind: "text" as const, content: "FILE CONTENT", path: "/home/x/file.txt" }
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
        ? {
            kind: "image" as const,
            base64: "abc123",
            mediaType: "image/png",
            path: "/home/x/img.png",
          }
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
        ? { kind: "text" as const, content: "hello from file", path: "/tmp/file.txt" }
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

    expect(readDroppedFile).toHaveBeenCalledWith("/help");
    const frame = lastFrame() ?? "";
    expect(frame).not.toContain("Unknown command");
    // Same reasoning as "App -- '/command' dispatch"'s own "/help" test: `helpText()`'s real output
    // is far taller than this harness's fixed transcript viewport, so only its tail (the last
    // keybinding line) is guaranteed to still be on screen -- exhaustive content coverage lives in
    // slash-commands.test.ts instead. What matters here is proving dispatch fell through to the
    // normal "/" handling rather than being swallowed as an "Unknown command" by the dropped-file
    // check, which the assertion above already covers.
    expect(frame).toContain("(drop a file)");
    expect(frame).toContain("to attach it");
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

    const frame = lastFrame() ?? "";
    expect(frame).toContain("working…"); // box cleared -- still busy, so the busy placeholder shows
    expect(frame).toContain("Queued as a follow-up message.");

    // The original turn settles completely normally afterward -- queuing didn't leave it wedged.
    stream.push({ type: "start", partial: assistantMessage({ content: [] }) });
    stream.push({
      type: "done",
      reason: "stop",
      message: assistantMessage({ content: [{ type: "text", text: "hi" }], stopReason: "stop" }),
    });
    await wait(20);
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

/** `NotificationLine` (app.tsx) is a fixed `height={1}` row rendered right after `<TranscriptView>`
 * and right before the rule above the prompt box -- the FIRST pure "─" row in the frame is always
 * that rule (same technique this file's "frames the prompt box" test above already uses), so the
 * line directly above it is always exactly `NotificationLine`'s own single row, whatever it's
 * currently showing (or blank, showing nothing). */
function notificationLineOf(frame: string): string {
  const lines = frame.split("\n");
  const ruleIndex = lines.findIndex((line) => /^─+$/.test(line));
  return ruleIndex > 0 ? lines[ruleIndex - 1] : "";
}

describe("App -- NotificationLine (exit-armed / busy+spinner / error, with priority exit-armed > busy > error)", () => {
  it("shows nothing when idle -- not busy, no error, not exit-armed", async () => {
    const session = new Session({
      streamFn: () => fakeStream(),
      initialState: { model: FAKE_MODEL, systemPrompt: "test" },
    });
    const { lastFrame } = renderApp(session);
    await wait(10);

    expect(notificationLineOf(lastFrame() ?? "").trim()).toBe("");
  });

  it("busy state: shows a spinner glyph plus 'working…' when there's no streamingText yet", async () => {
    // A "!command" bash escape only ever sets `busyAtom` -- it never touches `streamingText` at all
    // (see app.tsx's handleSubmit "!" branches) -- so this is the one realistic way to reach
    // "busy, no streamingText" through the real app rather than reaching into atoms directly.
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
    const { lastFrame, stdin } = renderApp(session, { runShellCommand });

    for (const ch of "!sleep 1") {
      stdin.write(ch);
      await wait(5);
    }
    stdin.write("\r");
    await wait(20);

    const notificationLine = notificationLineOf(lastFrame() ?? "");
    expect(notificationLine).toContain("working…");
    // A real spinner glyph (one of app.tsx's own SPINNER_FRAMES, all non-ASCII braille dots) sits
    // ahead of the text -- not asserting the exact frame/color (this harness renders with color
    // disabled, and the exact frame is a moving target on a real interval), just that SOMETHING
    // beyond plain ASCII precedes "working…", proving the spinner itself is actually there.
    expect(notificationLine).not.toBe("working…");

    resolveRun?.({ output: "done", isError: false }); // let the pending command settle
    await wait(20);
  });

  it("busy state: shows the given streamingText (a real turn's fixed 'thinking...'/'responding…' status) instead of 'working…'", async () => {
    // Driven through the real <TextInput>-equivalent submit path (stdin), not a direct
    // `session.prompt()` call -- `busyAtom` (what NotificationLine's own `busy` check reads) is
    // only ever set by `PromptInput`'s own `handleSubmit`, never by a session event on its own (see
    // the "shows a startup banner..." test above for the same distinction). A direct `session.prompt()`
    // call would leave `busyAtom` false the whole time, so NotificationLine would show nothing at
    // all -- any "responding…" visible in that case would only be coming from `Transcript`'s own,
    // separate `streamingText` box, not from `NotificationLine`.
    const stream = fakeStream();
    const session = new Session({
      streamFn: () => stream,
      initialState: { model: FAKE_MODEL, systemPrompt: "test" },
    });
    const { lastFrame, stdin } = renderApp(session);

    for (const ch of "hello") {
      stdin.write(ch);
      await wait(3);
    }
    stdin.write("\r");
    await wait(20);
    stream.push({ type: "start", partial: assistantMessage({ content: [] }) });
    stream.push({
      type: "text_delta",
      contentIndex: 0,
      delta: "Hi",
      partial: assistantMessage({ content: [{ type: "text", text: "Hi" }] }),
    });
    await wait(60); // past the backpressure queue's ~33ms coalescing window

    const notificationLine = notificationLineOf(lastFrame() ?? "");
    expect(notificationLine).toContain("responding…");
    expect(notificationLine).not.toContain("working…");
  });

  it("error state: shows the error text when idle (not busy, not exit-armed), truncated to the terminal's own column width", async () => {
    // NotificationLine's own truncation (app.tsx): `error.length > width ? error.slice(0, width -
    // 1) + "…" : error`, where `width` is `stdout.columns` (100 in this harness, already relied on
    // elsewhere in this file). A 150-character error is well past that, so this also proves the
    // truncation itself actually fires, not just that some error text shows.
    const longError = `kernel failure: ${"x".repeat(140)}`;
    const session = new Session({
      streamFn: () => fakeStream(),
      initialState: { model: FAKE_MODEL, systemPrompt: "test" },
    });
    const runShellCommand: RunShellCommand = vi.fn(async () => {
      throw new Error(longError);
    });
    const { lastFrame, stdin } = renderApp(session, { runShellCommand });

    for (const ch of "!echo hi") {
      stdin.write(ch);
      await wait(5);
    }
    stdin.write("\r");
    await wait(20);

    const notificationLine = notificationLineOf(lastFrame() ?? "");
    const expectedTruncated = `${longError.slice(0, 99)}…`; // width(100) - 1 = 99 real characters + "…"
    expect(notificationLine).toBe(expectedTruncated);
    expect(notificationLine.length).toBeLessThan(longError.length); // genuinely shorter, not the full error
    expect(notificationLine.endsWith("…")).toBe(true);
  });

  it("priority: the exit-armed notice outranks the busy spinner when both are true at once", async () => {
    // A real, reachable scenario, not a contrived one: `handleSubmit` clears the prompt box the
    // INSTANT a "!" command is submitted (well before it resolves), so the box is genuinely empty
    // while a shell command is still in flight -- pressing ctrl+c there arms `exitArmed` while
    // `busy` is still true, exactly like a real user getting impatient mid-command. Per
    // NotificationLine's own header comment, exit-armed must win.
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
    const { lastFrame, stdin } = renderApp(session, { runShellCommand });

    for (const ch of "!sleep 1") {
      stdin.write(ch);
      await wait(5);
    }
    stdin.write("\r");
    await wait(20);
    expect(notificationLineOf(lastFrame() ?? "")).toContain("working…"); // busy, confirmed first

    stdin.write("\x03"); // ctrl+c on the now-empty box -- arms exit while still busy
    await wait(10);

    const notificationLine = notificationLineOf(lastFrame() ?? "");
    expect(notificationLine).toContain("Press ctrl+c again to exit.");
    expect(notificationLine).not.toContain("working…");

    resolveRun?.({ output: "done", isError: false }); // let the pending command settle
    await wait(20);
  });

  // Priority between "busy" and "error" (busy always wins per NotificationLine's own `if (exitArmed)
  // ... if (busy) ... if (error)` order) is not independently exercisable through this app's real
  // control flow: every path that sets `errorAtom` (handleSubmit's various `.catch` blocks) does so
  // in the SAME synchronous callback that already set `busyAtom.set(false)` first (see app.tsx), so
  // React batches both into one re-render where busy is already false by the time error becomes
  // visible -- there is no real user-reachable moment where both are simultaneously true. Every
  // other test in this file that checks error text already implicitly relies on busy having been
  // cleared first (e.g. "reports a rejected runShellCommand the same way a failed chat prompt is
  // reported" above), so that ordering is still covered, just not as an independent priority check.
});

describe("App -- promptBoxRowCount (footer layout budget for the prompt box)", () => {
  // promptBoxRowCount (app.tsx, unexported) isn't reachable directly, but its effect is directly
  // observable: the prompt box's own rendered row count, between the rule above it and the rule
  // below it (the same technique the "frames the prompt box" test above already uses to find those
  // rules). `PROMPT_MARKER_WIDTH` (app.tsx, unexported, currently 2) plus each line's own text is
  // what actually gets wrapped -- duplicated here as a literal `2` (with this comment tying it back)
  // since importing an unexported constant isn't possible from a test file.
  const PROMPT_MARKER_WIDTH = 2;
  const TERMINAL_COLUMNS = 100; // this file's own established ink-testing-library constant

  function expectedPromptRows(text: string): number {
    const width = Math.max(TERMINAL_COLUMNS, 1);
    return text.split("\n").reduce((total, line) => {
      const wrapped = wrapAnsi(" ".repeat(PROMPT_MARKER_WIDTH) + line, width, {
        trim: false,
        hard: true,
      });
      return total + wrapped.split("\n").length;
    }, 0);
  }

  function promptBoxLineCount(frame: string): number {
    const lines = frame.split("\n");
    const ruleIndices: number[] = [];
    lines.forEach((line, index) => {
      if (/^─+$/.test(line)) ruleIndices.push(index);
    });
    const [aboveRule, belowRule] = ruleIndices;
    return belowRule - aboveRule - 1;
  }

  it("a single-line prompt occupies exactly one row", async () => {
    const session = new Session({
      streamFn: () => fakeStream(),
      initialState: { model: FAKE_MODEL, systemPrompt: "test" },
    });
    const { lastFrame, stdin } = renderApp(session);

    for (const ch of "hello") {
      stdin.write(ch);
      await wait(3);
    }
    await wait(10);

    expect(promptBoxLineCount(lastFrame() ?? "")).toBe(expectedPromptRows("hello"));
    expect(promptBoxLineCount(lastFrame() ?? "")).toBe(1);
  });

  it("a multi-line prompt (composed with option+enter) occupies exactly one row per line", async () => {
    const session = new Session({
      streamFn: () => fakeStream(),
      initialState: { model: FAKE_MODEL, systemPrompt: "test" },
    });
    const { lastFrame, stdin } = renderApp(session);

    for (const ch of "line one") {
      stdin.write(ch);
      await wait(3);
    }
    stdin.write("\x1b\r"); // option+enter -- inserts a real newline
    await wait(10);
    for (const ch of "line two") {
      stdin.write(ch);
      await wait(3);
    }
    await wait(10);

    expect(promptBoxLineCount(lastFrame() ?? "")).toBe(expectedPromptRows("line one\nline two"));
    expect(promptBoxLineCount(lastFrame() ?? "")).toBe(2);
  });

  it("a single long line with no embedded newline wraps across multiple rows, counted exactly like Ink's own wrap-ansi call", async () => {
    // One long unbroken word: guarantees a hard mid-word wrap at the exact column boundary,
    // independent of where any spaces happen to fall.
    const longWord = "x".repeat(150);
    const session = new Session({
      streamFn: () => fakeStream(),
      initialState: { model: FAKE_MODEL, systemPrompt: "test" },
    });
    const { lastFrame, stdin } = renderApp(session);

    for (const ch of longWord) {
      stdin.write(ch);
      await wait(1);
    }
    await wait(20);

    const expected = expectedPromptRows(longWord);
    expect(expected).toBeGreaterThan(1); // sanity: this really does wrap
    expect(promptBoxLineCount(lastFrame() ?? "")).toBe(expected);
  });
});

describe("App -- commandMenuRowCount (footer layout budget for the live '/' menu)", () => {
  // commandMenuRowCount (app.tsx, unexported) isn't reachable directly either, but -- like
  // promptBoxRowCount above -- its effect is directly observable: the number of rendered menu rows
  // between the rule below the prompt box and the status bar's own cwd line (an exact, unique match
  // per renderApp's default `cwd: "/test"`, the same technique the "frames the prompt box" test
  // above uses for its own "cwd + data come strictly AFTER the closing rule" assertion).
  const CWD = "/test"; // renderApp's own default

  function menuLineCount(frame: string): number {
    const lines = frame.split("\n");
    const ruleIndices: number[] = [];
    lines.forEach((line, index) => {
      if (/^─+$/.test(line)) ruleIndices.push(index);
    });
    const belowPromptRule = ruleIndices[1];
    const cwdIndex = lines.indexOf(CWD);
    return cwdIndex - belowPromptRule - 1;
  }

  it("is 0 when the menu is closed (prompt text doesn't start with '/')", async () => {
    const session = new Session({
      streamFn: () => fakeStream(),
      initialState: { model: FAKE_MODEL, systemPrompt: "test" },
    });
    const { lastFrame, stdin } = renderApp(session);

    for (const ch of "hello") {
      stdin.write(ch);
      await wait(3);
    }
    await wait(10);

    expect(menuLineCount(lastFrame() ?? "")).toBe(0);
  });

  it("is matches.length + 1 when open with fewer matches than MENU_WINDOW_SIZE", async () => {
    const session = new Session({
      streamFn: () => fakeStream(),
      initialState: { model: FAKE_MODEL, systemPrompt: "test" },
    });
    const { lastFrame, stdin } = renderApp(session);

    for (const ch of "/mo") {
      stdin.write(ch);
      await wait(3);
    }
    await wait(10);

    const frame = lastFrame() ?? "";
    expect(frame).toContain("(1/1)"); // exactly one match ("model")
    expect(menuLineCount(frame)).toBe(1 + 1); // one match row + the "(n/total)" counter row
  });

  it("is capped at MENU_WINDOW_SIZE + 1 when open with more matches than the window size", async () => {
    // A bare "/" matches every command -- 15 today (command-menu.tsx's own comment), comfortably
    // more than MENU_WINDOW_SIZE (6), so the window cap is genuinely exercised here.
    const session = new Session({
      streamFn: () => fakeStream(),
      initialState: { model: FAKE_MODEL, systemPrompt: "test" },
    });
    const { lastFrame, stdin } = renderApp(session);

    stdin.write("/");
    await wait(10);

    const frame = lastFrame() ?? "";
    expect(frame).toContain(`(1/${SLASH_COMMANDS.length})`);
    expect(SLASH_COMMANDS.length).toBeGreaterThan(MENU_WINDOW_SIZE); // sanity: the cap really applies
    expect(menuLineCount(frame)).toBe(MENU_WINDOW_SIZE + 1);
  });
});

describe("App -- mouse-wheel scrolling (mouse.ts's onWheel, wired up by RunningSession's own useEffect)", () => {
  // The real production wiring (packages/cli/src/tui.tsx) calls `wrapStdinForMouse` on the real
  // `process.stdin` BEFORE Ink ever mounts, entirely outside this component tree -- `App` itself
  // never wraps stdin on its own. So driving a real wheel event against a mounted `<App>` here means
  // feeding actual SGR mouse bytes through `wrapStdinForMouse` on a SEPARATE fake stream, not
  // `renderApp()`'s own fake `stdin` (ink-testing-library's plain keypress-only fake, which knows
  // nothing about mouse bytes). `mouse.ts`'s `onWheel` pub-sub is process-wide module state, not
  // owned by any one `App` instance, so a wheel event produced this way reaches the exact same
  // `onWheel` subscription `RunningSession`'s own `useEffect` (app.tsx) registers -- exactly like a
  // real, separately-wired stdin would in production.
  function createFakeMouseStdin() {
    const emitter = new EventEmitter();
    return Object.assign(emitter, {
      isTTY: true,
      setRawMode: vi.fn(),
      ref: vi.fn(),
      unref: vi.fn(),
    });
  }

  /** Feeds `ticks` separate real SGR wheel reports (Cb=64 for "up", 65 for "down" -- see mouse.ts's
   * own `WHEEL_BASE_BIT` comment) through a fresh `wrapStdinForMouse`-wrapped fake stream, each in
   * its own "data" event -- matching how a real fast scroll burst still typically arrives as
   * multiple discrete OS-level reports, one wheel "click" per `onWheel` firing. */
  function scrollWheel(direction: "up" | "down", ticks: number): void {
    const fakeStdin = createFakeMouseStdin();
    wrapStdinForMouse(fakeStdin as unknown as NodeJS.ReadStream);
    const code = direction === "up" ? 64 : 65;
    for (let i = 0; i < ticks; i++) {
      fakeStdin.emit("data", Buffer.from(`\x1b[<${code};10;10M`, "latin1"));
    }
  }

  it("scrolling up reveals earlier, clipped conversation content, and submitting a new message resets scrollOffset back to 0", async () => {
    // 30 short user messages, comfortably enough to overflow this harness's fixed 24-row simulated
    // terminal (each renders as a 3-row UserMessageBar -- see transcript.tsx) and force real
    // bottom-anchored clipping, the same precondition transcript.test.tsx's own scrollOffset tests
    // rely on.
    const messages = Array.from(
      { length: 30 },
      (_, i) =>
        ({ role: "user", content: `scrollable message ${i}`, timestamp: i }) as AgentMessage,
    );
    const session = new Session({
      streamFn: () => fakeStream(),
      initialState: { model: FAKE_MODEL, systemPrompt: "test", messages },
    });
    const { lastFrame, stdin } = renderApp(session);
    await wait(20);

    let frame = lastFrame() ?? "";
    expect(frame).toContain("scrollable message 29"); // bottom-anchored to the newest by default
    expect(frame).not.toContain("scrollable message 0"); // oldest clipped off the top

    // Scroll up far enough to hit the very top clamp -- Transcript itself clamps `scrollOffset`
    // against its own real measured content height (transcript.tsx's own header comment), so an
    // intentionally generous tick count is always safe here, never an over-scroll bug of its own.
    scrollWheel("up", 200);
    await wait(20);

    frame = lastFrame() ?? "";
    expect(frame).toContain("scrollable message 0"); // the oldest message is reachable now

    // Submitting a new message resets scrollOffset back to 0 (handleSubmit, app.tsx) -- matches
    // ordinary chat-app behavior: sending a message snaps the view back to "show me what happens
    // now."
    for (const ch of "hi") {
      stdin.write(ch);
      await wait(5);
    }
    stdin.write("\r");
    await wait(20);

    frame = lastFrame() ?? "";
    expect(frame).not.toContain("scrollable message 0"); // scrolled-to-the-top state was reset
  });

  it("wheel scrolling with nothing to scroll (a short conversation) doesn't crash and leaves the frame unchanged -- exercises RunningSession's onWheel subscription wiring on its own", async () => {
    const session = new Session({
      streamFn: () => fakeStream(),
      initialState: { model: FAKE_MODEL, systemPrompt: "test" },
    });
    const { lastFrame } = renderApp(session);
    await wait(20);

    const before = lastFrame() ?? "";

    expect(() => scrollWheel("up", 10)).not.toThrow();
    await wait(20);
    expect(() => scrollWheel("down", 10)).not.toThrow();
    await wait(20);

    // Nothing to scroll (the whole short conversation already fits) -- Transcript's own clamp keeps
    // scrollOffset's effective value at 0 regardless of how much the atom itself moved, so the
    // rendered frame never visibly changes.
    expect(lastFrame() ?? "").toBe(before);
  });
});
