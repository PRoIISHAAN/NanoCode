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
import { App, type RunShellCommand } from "../src/app.tsx";
import type { ModelSetupController } from "../src/setup-screen.tsx";

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
  it("renders text deltas as they stream in, then the settled final message", async () => {
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
    stream.push({
      type: "text_delta",
      contentIndex: 0,
      delta: "Hel",
      partial: assistantMessage({ content: [{ type: "text", text: "Hel" }] }),
    });
    // Backpressure coalesces rapid deltas to ~30fps -- give the queue's timer time to flush.
    await wait(60);
    expect(lastFrame()).toContain("Hel");

    stream.push({
      type: "text_delta",
      contentIndex: 0,
      delta: "lo world",
      partial: assistantMessage({ content: [{ type: "text", text: "Hello world" }] }),
    });
    await wait(60);
    expect(lastFrame()).toContain("Hello world");

    stream.push({
      type: "done",
      reason: "stop",
      message: assistantMessage({
        content: [{ type: "text", text: "Hello world" }],
        stopReason: "stop",
      }),
    });
    await wait(20);

    const frame = lastFrame() ?? "";
    expect(frame).toContain("Hello world");
    expect(frame).toContain("You"); // the user's own "hello" message is in the settled transcript
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
      />,
    );

    let frame = lastFrame() ?? "";
    expect(frame).toContain("nanocode v1.2.3");
    expect(frame).toContain("/home/me/project");
    expect(frame).toContain("fake-provider/fake-model");
    expect(frame).toContain("high"); // the configured reasoning level
    expect(frame).toContain("idle");
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
    expect(frame).toContain("busy"); // a turn is now in flight

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
    expect(frame).toContain("idle"); // the turn settled
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
      />,
    );

    const lines = (lastFrame() ?? "").split("\n");
    const promptIndex = lines.findIndex((line) =>
      line.includes("type a prompt (or !command), enter to send"),
    );
    expect(promptIndex).toBeGreaterThan(-1);

    const isRule = (line: string) => /^─+$/.test(line);
    expect(isRule(lines[promptIndex - 1])).toBe(true); // rule directly above the prompt box
    expect(isRule(lines[promptIndex + 1])).toBe(true); // rule directly below the prompt box

    // cwd + data come strictly AFTER the closing rule, never before the prompt box.
    const cwdIndex = lines.indexOf("/home/me/project");
    expect(cwdIndex).toBeGreaterThan(promptIndex + 1);
  });

  it("Ctrl+O toggles collapsed/expanded tool output in the real running transcript", async () => {
    // Drives a real toolCall -> real tool execution -> real toolResult message round-trip (the
    // same shape packages/agent/test/agent.test.ts's own fake-tool tests use), rather than
    // fabricating a toolResult message directly -- that would only prove the collapse renderer
    // works on hand-shaped data, not that it's wired to a genuinely produced message.
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
      />,
    );

    await session.prompt("run something");
    await wait(20);

    let frame = lastFrame() ?? "";
    expect(frame).toContain("line one");
    expect(frame).toContain("more lines");
    expect(frame).not.toContain("line two");

    stdin.write("\x0F"); // Ctrl+O
    await wait(10);

    frame = lastFrame() ?? "";
    expect(frame).toContain("line two");
    expect(frame).toContain("line three");
    expect(frame).not.toContain("more lines");

    stdin.write("\x0F"); // Ctrl+O again -- toggles back
    await wait(10);
    frame = lastFrame() ?? "";
    expect(frame).toContain("more lines");
    expect(frame).not.toContain("line two");
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
  it("shows the command and its result as a synthetic You/tool:shell exchange, and never calls session.prompt", async () => {
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
      />,
    );

    // Real per-keystroke stdin, not one combined write -- see the "actually submits via the real
    // <TextInput> wiring" test above for why a single write() call can't be trusted here.
    for (const ch of "!echo hi") {
      stdin.write(ch);
      await wait(5);
    }
    stdin.write("\r");
    await wait(20);

    expect(runShellCommand).toHaveBeenCalledWith("echo hi");
    // (b) session.prompt() is NEVER called for a bang command -- the fake streamFn would have
    // fired if it had been, and the real session's own message history stays completely empty.
    expect(streamFn).not.toHaveBeenCalled();
    expect(session.state.messages).toHaveLength(0);

    const frame = lastFrame() ?? "";
    expect(frame).toContain("You");
    expect(frame).toContain("!echo hi");
    expect(frame).toContain("tool:shell");
    expect(frame).toContain("ran: echo hi");
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
    expect(frame).toContain("busy"); // the status bar's busy indicator

    resolveRun?.({ output: "done", isError: false });
    await wait(20);

    frame = lastFrame() ?? "";
    expect(frame).not.toContain("… ");
    expect(frame).toContain("idle");
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
    expect(frame).toContain("type a prompt (or !command), enter to send");
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

  it("the synthetic toolResult entry from a bang command participates in the same ctrl+o collapse/expand as a real tool result", async () => {
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
      />,
    );

    for (const ch of "!cat file") {
      stdin.write(ch);
      await wait(5);
    }
    stdin.write("\r");
    await wait(20);

    let frame = lastFrame() ?? "";
    expect(frame).toContain("line one");
    expect(frame).toContain("more lines");
    expect(frame).not.toContain("line two");

    stdin.write("\x0F"); // Ctrl+O
    await wait(10);

    frame = lastFrame() ?? "";
    expect(frame).toContain("line two");
    expect(frame).toContain("line three");
    expect(frame).not.toContain("more lines");

    stdin.write("\x0F"); // Ctrl+O again -- toggles back
    await wait(10);
    frame = lastFrame() ?? "";
    expect(frame).toContain("more lines");
    expect(frame).not.toContain("line two");
  });
});
