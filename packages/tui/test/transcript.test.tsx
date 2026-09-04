import type { AgentMessage } from "@nanocode/agent";
import { Text } from "ink";
import { render } from "ink-testing-library";
import { describe, expect, it } from "vitest";
import {
  buildTranscriptItems,
  labelFor,
  summarizeToolResult,
  type ToolCellItem,
  Transcript,
  textOf,
} from "../src/transcript.tsx";

function userMessage(text: string, timestamp: number): AgentMessage {
  return { role: "user", content: text, timestamp } as AgentMessage;
}

function assistantTextMessage(text: string, timestamp: number): AgentMessage {
  return { role: "assistant", content: [{ type: "text", text }], timestamp } as AgentMessage;
}

function toolResultMessage(text: string, timestamp: number): AgentMessage {
  return {
    role: "toolResult",
    toolCallId: `call-${timestamp}`,
    toolName: "ipython",
    content: [{ type: "text", text }],
    isError: false,
    timestamp,
  } as AgentMessage;
}

describe("textOf / labelFor", () => {
  it("extracts plain string content (UserMessage)", () => {
    expect(textOf(userMessage("hello", 1))).toBe("hello");
  });

  it("extracts text blocks and labels a toolCall block", () => {
    const message = {
      role: "assistant",
      content: [
        { type: "text", text: "running: " },
        { type: "toolCall", id: "c1", name: "ipython", arguments: {} },
      ],
      timestamp: 1,
    } as AgentMessage;
    expect(textOf(message)).toBe("running: [call ipython]");
  });

  it("surfaces errorMessage for a failed run, whose content is deliberately empty", () => {
    // Regression: Session's buildFailureMessage (agent.ts) produces an assistant message with
    // content: [{type:"text", text:""}] and the actual error text in a separate `errorMessage`
    // field -- the same field the headless CLI reads via console.error. Without this, the TUI
    // silently rendered nothing at all for a run that failed internally.
    const message = {
      role: "assistant",
      content: [{ type: "text", text: "" }],
      errorMessage: "boom",
      timestamp: 1,
    } as AgentMessage;
    expect(textOf(message)).toBe("[error: boom]");
  });

  it("appends errorMessage after any partial content that did stream before the failure", () => {
    const message = {
      role: "assistant",
      content: [{ type: "text", text: "partial output" }],
      errorMessage: "connection reset",
      timestamp: 1,
    } as AgentMessage;
    expect(textOf(message)).toBe("partial output\n[error: connection reset]");
  });

  it("labels each role distinctly", () => {
    // labelFor's own behavior is unchanged by the transcript redesign -- the live transcript just
    // stopped calling it (no more role labels rendered), but the function itself still does this.
    expect(labelFor(userMessage("hi", 1))).toBe("You");
    expect(labelFor(toolResultMessage("ok", 1))).toBe("tool:ipython");
  });
});

// ---------------------------------------------------------------------------------------------
// buildTranscriptItems -- the AgentMessage[] -> TranscriptItem[] flattening/pairing logic.
// ---------------------------------------------------------------------------------------------

describe("buildTranscriptItems", () => {
  it("turns a plain user message into a UserItem", () => {
    const items = buildTranscriptItems([userMessage("hello", 1)], false);
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ kind: "user", text: "hello" });
  });

  it("pairs an assistant toolCall block with its sibling toolResult message into one ToolCellItem", () => {
    const callMessage = {
      role: "assistant",
      content: [
        { type: "toolCall", id: "call-1", name: "ipython", arguments: { code: "print(1)" } },
      ],
      timestamp: 1000,
      // A single-toolCall-block content array's `type` widens to `string`, which no longer
      // "sufficiently overlaps" AssistantMessage's own discriminated union -- `as unknown` first is
      // TS's own suggested fix for a literal fixture that intentionally omits every other real
      // AssistantMessage field (api/provider/model/usage/stopReason) this test never reads.
    } as unknown as AgentMessage;
    const resultMessage = {
      role: "toolResult",
      toolCallId: "call-1",
      toolName: "ipython",
      content: [{ type: "text", text: "1" }],
      isError: false,
      timestamp: 1500,
    } as AgentMessage;

    const items = buildTranscriptItems([callMessage, resultMessage], false);
    expect(items).toHaveLength(1); // one combined cell, not two separate items
    const item = items[0] as ToolCellItem;
    expect(item.kind).toBe("toolCell");
    expect(item.language).toBe("python"); // "ipython" maps to the "python" language label
    expect(item.code).toBe("print(1)"); // from the toolCall block's arguments.code
    expect(item.output).toBe("1"); // from the toolResult's content -- always a required string now
    expect(item.isError).toBe(false);
    expect(item.durationMs).toBe(500); // resultTimestamp - callTimestamp
  });

  it("does not also emit a matched toolResult as its own separate top-level item", () => {
    const callMessage = {
      role: "assistant",
      content: [{ type: "toolCall", id: "call-3", name: "ipython", arguments: { code: "1" } }],
      timestamp: 1,
    } as unknown as AgentMessage;
    const resultMessage = {
      role: "toolResult",
      toolCallId: "call-3",
      toolName: "ipython",
      content: [{ type: "text", text: "ok" }],
      isError: false,
      timestamp: 2,
    } as AgentMessage;

    const items = buildTranscriptItems(
      [userMessage("before", 0), callMessage, resultMessage],
      false,
    );
    expect(items.filter((item) => item.kind === "toolCell")).toHaveLength(1);
    expect(items).toHaveLength(2); // the user item + the one combined tool cell, no third item
  });

  it("omits a toolCall entirely until its matching toolResult arrives", () => {
    // A still-executing (or, rarely, interrupted-before-its-result-arrived) toolCall block never
    // becomes an item at all -- not a "pending" ToolCellItem (that concept is gone entirely, see
    // transcript.tsx's own header comment on why: freezing a "still running" cell into <Static>
    // would make it stay "still running" forever, since Static never revisits an already-printed
    // slot to update it once the real result lands).
    const callMessage = {
      role: "assistant",
      content: [
        { type: "toolCall", id: "call-2", name: "ipython", arguments: { code: "print(2)" } },
      ],
      timestamp: 1000,
    } as unknown as AgentMessage;

    const items = buildTranscriptItems([callMessage], false);
    expect(items).toEqual([]);
    expect(items.some((item) => item.kind === "toolCell")).toBe(false);
  });

  it("turns a standalone 'command' toolResult (no matching toolCall) into a notice TextItem, not a tool cell", () => {
    // Matches app.tsx's buildCommandResultEntries -- a "/command" confirmation round-trips as a
    // toolResult with toolName "command" but no real toolCall behind it.
    const message = {
      role: "toolResult",
      toolCallId: "command-1",
      toolName: "command",
      content: [{ type: "text", text: "model: fake-provider/fake-model" }],
      isError: false,
      timestamp: 1,
    } as AgentMessage;

    const items = buildTranscriptItems([message], false);
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      kind: "notice",
      text: "model: fake-provider/fake-model",
    });
  });

  it("turns a standalone 'shell' toolResult (no matching toolCall) into a ToolCellItem, code read from details.code", () => {
    // Matches app.tsx's buildBangCommandEntries -- a "!command"/"!!command" bash escape stashes
    // its command text on `details.code` since there's no real toolCall block to read
    // `arguments.code` off of.
    const message = {
      role: "toolResult",
      toolCallId: "shell-1",
      toolName: "shell",
      content: [{ type: "text", text: "ran: echo hi" }],
      details: { code: "echo hi" },
      isError: false,
      timestamp: 1,
    } as AgentMessage;

    const items = buildTranscriptItems([message], false);
    expect(items).toHaveLength(1);
    const item = items[0] as ToolCellItem;
    expect(item.kind).toBe("toolCell");
    expect(item.language).toBe("shell");
    expect(item.code).toBe("echo hi");
    expect(item.output).toBe("ran: echo hi");
  });

  it("always includes a 'thinking' content block as a ThinkingItem, hidden per the live thinkingExpanded toggle", () => {
    // The item is ALWAYS pushed (never omitted based on thinkingExpanded) so <Static>'s length-based
    // bookkeeping of "how much has already been permanently rendered" stays correct regardless of
    // when ctrl+t gets toggled -- only its `hidden` field varies. See transcript.tsx's own comment
    // on ThinkingItem for why omitting it conditionally would corrupt that bookkeeping.
    const message = {
      role: "assistant",
      content: [{ type: "thinking", thinking: "secret reasoning" }],
      timestamp: 1,
    } as AgentMessage;

    const visible = buildTranscriptItems([message], true);
    expect(visible).toHaveLength(1);
    expect(visible[0]).toMatchObject({ kind: "thinking", text: "secret reasoning", hidden: false });

    const hidden = buildTranscriptItems([message], false);
    expect(hidden).toHaveLength(1);
    expect(hidden[0]).toMatchObject({ kind: "thinking", text: "secret reasoning", hidden: true });
  });

  it("turns a 'text' content block on an assistant message into an assistantText TextItem", () => {
    const message = assistantTextMessage("final answer", 1);
    const items = buildTranscriptItems([message], false);
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ kind: "assistantText", text: "final answer" });
  });

  it("turns an assistant message's own errorMessage field into an isError notice TextItem", () => {
    const message = {
      role: "assistant",
      content: [],
      errorMessage: "boom",
      timestamp: 1,
    } as unknown as AgentMessage;

    const items = buildTranscriptItems([message], false);
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      kind: "notice",
      isError: true,
      text: "[error: boom]",
    });
  });
});

describe("Transcript (rendered)", () => {
  // No more `<Static>`: `Transcript` is now a FIXED-height (`height` -- a required prop), clipped
  // viewport (`overflow="hidden"`), matching a real chat window inside the alternate screen buffer
  // this app now runs in (see transcript.tsx's own header comment for the full "why"). Whether a
  // conversation TOP-ALIGNS (blank space left below it, like a chat window that hasn't scrolled)
  // or BOTTOM-ANCHORS (oldest content clipped off the top, newest always kept) depends purely on
  // whether `estimateItemRows`' rough total fits within `height` -- there is no "N earlier entries"
  // indicator of any kind in either mode.

  it("renders a blank fixed-height viewport (no crash) when there are no messages, no streamingText, and no leadingContent", () => {
    const { lastFrame } = render(<Transcript messages={[]} height={5} />);
    expect((lastFrame() ?? "").trim()).toBe("");
  });

  it("renders every message when the conversation comfortably fits within height", () => {
    const messages = [userMessage("hi there", 1), assistantTextMessage("42", 2)];
    const { lastFrame } = render(<Transcript messages={messages} height={20} />);
    const frame = lastFrame() ?? "";
    expect(frame).toContain("hi there");
    expect(frame).toContain("42");
  });

  it("top-aligns a short conversation that fits within height, leaving real blank rows below it instead of bottom-anchoring", () => {
    // Regression for a real, live-caught bug (see transcript.tsx's own `Transcript` comment): a
    // `flex-end`-only version of this component bottom-anchored EVERY conversation, even one with
    // nothing to clip at all -- which visually shoved a short conversation all the way to the
    // bottom of the viewport instead of leaving it at the top, the way a chat window that hasn't
    // filled its own history yet always does.
    const { lastFrame } = render(
      <Transcript messages={[userMessage("only message", 1)]} height={10} />,
    );
    const lines = (lastFrame() ?? "").split("\n");
    const contentIndex = lines.findIndex((line) => line.includes("only message"));
    expect(contentIndex).toBeGreaterThanOrEqual(0);
    // Top-aligned: the message sits near the top, with genuine blank rows still left below it
    // inside the fixed-height box, including the box's own last row.
    expect(contentIndex).toBeLessThan(lines.length - 1);
    expect(lines[lines.length - 1]?.trim() ?? "").toBe("");
  });

  it("bottom-anchors and clips the OLDEST messages off the top once the conversation overflows height, always keeping the newest -- no hidden-count indicator of any kind", () => {
    const messages = Array.from({ length: 10 }, (_, i) =>
      userMessage(i === 0 ? "first" : i === 9 ? "tenth" : `middle ${i}`, i),
    );
    const { lastFrame } = render(<Transcript messages={messages} height={6} />);
    const frame = lastFrame() ?? "";
    expect(frame).not.toMatch(/hidden/i);
    expect(frame).not.toMatch(/earlier/i);
    expect(frame).toContain("tenth"); // the newest message is always reachable
    expect(frame).not.toContain("first"); // the oldest is clipped off the top, not squeezed in
  });

  it("shows leadingContent when there's room, but clips it off first -- before any newer real message -- once the conversation overflows", () => {
    const banner = <Text>BANNER-CONTENT</Text>;

    const fitsFrame =
      render(
        <Transcript
          messages={[userMessage("hello", 1)]}
          leadingContent={banner}
          leadingContentRows={3}
          height={20}
        />,
      ).lastFrame() ?? "";
    expect(fitsFrame).toContain("BANNER-CONTENT");
    expect(fitsFrame).toContain("hello");

    const manyMessages = Array.from({ length: 10 }, (_, i) => userMessage(`msg ${i}`, i));
    const overflowFrame =
      render(
        <Transcript
          messages={manyMessages}
          leadingContent={banner}
          leadingContentRows={3}
          height={6}
        />,
      ).lastFrame() ?? "";
    expect(overflowFrame).not.toContain("BANNER-CONTENT"); // the oldest content, clipped first
    expect(overflowFrame).toContain("msg 9"); // the newest message is still reachable
  });

  it("renders in-progress streaming text separately from the settled message list", () => {
    const { lastFrame } = render(
      <Transcript
        messages={[userMessage("go", 1)]}
        streamingText="thinking out loud…"
        height={20}
      />,
    );
    expect(lastFrame()).toContain("thinking out loud…");
  });

  it("renders streamingText verbatim, with no truncation, however long it is, given enough height", () => {
    // `Transcript` itself no longer bounds `streamingText`'s rendered height at all -- that was
    // tried once (a `boundStreamingPreview` helper, now deleted) and rejected: it only masked a
    // real, user-visible one-time "grows to the bounded cap, then stops" shift right at the start
    // of a response's text phase, still perceived as "still scrolling." The real fix lives in
    // app.tsx instead: the only real caller now only ever passes a short FIXED status string
    // ("thinking..."/"responding…"), never the message's own growing text, so nothing here needs
    // to truncate anything ever again. This just proves `Transcript` renders whatever string it's
    // given as-is, unmangled, whether short or long -- given a `height` tall enough to fit it (an
    // overflowing `height` would legitimately clip it, per this describe block's other tests).
    const longResponse = [
      "Once upon a time in a small coastal town there lived a curious engineer who spent every evening tinkering with old radios and half broken clocks, always searching for the one missing gear.",
      "Every morning she would walk down to the harbor and watch the fishing boats leave before sunrise, thinking about the problem she had been chasing for weeks.",
    ].join("\n\n");

    const { lastFrame } = render(
      <Transcript messages={[]} streamingText={longResponse} height={20} />,
    );
    const frame = lastFrame() ?? "";

    expect(frame).toContain("Once upon a time");
    expect(frame).toContain("curious engineer");
    expect(frame).toContain("fishing boats leave before sunrise");
  });

  it("never truncates non-tool-cell messages, regardless of toolOutputExpanded, given enough height", () => {
    const messages = [userMessage("line one\nline two", 1)];
    const { lastFrame } = render(<Transcript messages={messages} height={20} />);
    expect(lastFrame()).toContain("line two");
  });

  it("collapsed tool cell shows only its one-line summary -- no output at all", () => {
    const messages = [toolResultMessage("line one\nline two\nline three", 1)];
    const { lastFrame } = render(<Transcript messages={messages} height={20} />);
    const frame = lastFrame() ?? "";
    expect(frame).toContain("ipython");
    expect(frame).toContain("ctrl+o to expand");
    expect(frame).not.toContain("line one");
    expect(frame).not.toContain("line two");
    expect(frame).not.toContain("line three");
  });

  it("expanded tool cell shows the full output, with ctrl+o to collapse", () => {
    const messages = [toolResultMessage("line one\nline two\nline three", 1)];
    const { lastFrame } = render(<Transcript messages={messages} toolOutputExpanded height={20} />);
    const frame = lastFrame() ?? "";
    expect(frame).toContain("line one");
    expect(frame).toContain("line two");
    expect(frame).toContain("line three");
    expect(frame).toContain("ctrl+o to collapse");
    expect(frame).not.toContain("ctrl+o to expand");
  });

  it("hides a thinking block entirely by default, shows it in full when thinkingExpanded is true", () => {
    const message = {
      role: "assistant",
      content: [
        { type: "thinking", thinking: "secret reasoning" },
        { type: "text", text: "final answer" },
      ],
      timestamp: 1,
    } as AgentMessage;

    const collapsedFrame =
      render(<Transcript messages={[message]} height={20} />).lastFrame() ?? "";
    expect(collapsedFrame).not.toContain("secret reasoning");
    expect(collapsedFrame).toContain("final answer");

    const expandedFrame =
      render(<Transcript messages={[message]} thinkingExpanded height={20} />).lastFrame() ?? "";
    expect(expandedFrame).toContain("secret reasoning");
    expect(expandedFrame).toContain("final answer");
  });
});

describe("Transcript scrollOffset", () => {
  // `scrollOffset` (transcript.tsx's own header comment on `Transcript` covers the full mechanism):
  // rows scrolled UP from the newest content, clamped by `Transcript` itself against its own REAL
  // `measureElement`-reported content height (never the rough `estimateItemRows` seed) -- so every
  // test below builds enough messages to force a real overflow, and relies on `render()` having
  // already flushed the `useLayoutEffect` measurement pass by the time `lastFrame()` is read (this
  // file's own pre-existing "bottom-anchors and clips" test above already depends on exactly that
  // same synchronous-measurement behavior with no extra `await`/rerender needed, confirmed by it
  // already passing).

  it("scrollOffset={0} (and the default, omitted) behave identically -- bottom-anchored to the newest content when overflowing", () => {
    const messages = Array.from({ length: 10 }, (_, i) => userMessage(`msg ${i}`, i));

    const defaultFrame = render(<Transcript messages={messages} height={6} />).lastFrame() ?? "";
    const explicitZeroFrame =
      render(<Transcript messages={messages} height={6} scrollOffset={0} />).lastFrame() ?? "";

    expect(defaultFrame).toBe(explicitZeroFrame);
    expect(defaultFrame).toContain("msg 9"); // newest still reachable
    expect(defaultFrame).not.toContain("msg 0"); // oldest still clipped off the top
  });

  it("a scrollOffset large enough to reveal an earlier, otherwise-clipped item shows it without losing the clamp", () => {
    const messages = Array.from({ length: 10 }, (_, i) => userMessage(`msg ${i}`, i));

    const bottomFrame = render(<Transcript messages={messages} height={6} />).lastFrame() ?? "";
    expect(bottomFrame).not.toContain("msg 0");

    // Each user message is 3 rows tall (UserMessageBar's own blank-text-blank shape) with no
    // marginBottom -- scrolling up by 15 rows (five messages' worth) comfortably reveals a message
    // from the middle of the conversation that the bottom-anchored view above couldn't show at all.
    const scrolledFrame =
      render(<Transcript messages={messages} height={6} scrollOffset={15} />).lastFrame() ?? "";
    expect(scrolledFrame).toContain("msg 4");
  });

  it("an extremely large scrollOffset clamps cleanly at the very top -- the first item (and leadingContent) visible, nothing crashes or duplicates", () => {
    const banner = <Text>BANNER-CONTENT</Text>;
    const messages = Array.from({ length: 10 }, (_, i) => userMessage(`msg ${i}`, i));

    const { lastFrame } = render(
      <Transcript
        messages={messages}
        leadingContent={banner}
        leadingContentRows={3}
        height={6}
        scrollOffset={99999}
      />,
    );
    const frame = lastFrame() ?? "";

    expect(frame).toContain("BANNER-CONTENT");
    expect(frame).toContain("msg 0");
    // No duplication: each message's own distinguishing text appears exactly once in the frame.
    expect(frame.split("msg 0").length - 1).toBe(1);
    expect(frame.split("BANNER-CONTENT").length - 1).toBe(1);
  });

  it("a nonzero scrollOffset has no visible effect when content fits entirely within height -- nothing to scroll, still top-aligned", () => {
    const messages = [userMessage("only message", 1)];

    const unscrolledFrame =
      render(<Transcript messages={messages} height={10} />).lastFrame() ?? "";
    const scrolledFrame =
      render(<Transcript messages={messages} height={10} scrollOffset={50} />).lastFrame() ?? "";

    expect(scrolledFrame).toBe(unscrolledFrame);
    const lines = scrolledFrame.split("\n");
    const contentIndex = lines.findIndex((line) => line.includes("only message"));
    expect(contentIndex).toBeGreaterThanOrEqual(0);
    expect(contentIndex).toBeLessThan(lines.length - 1); // still top-aligned, blank rows still below
  });
});

describe("summarizeToolResult", () => {
  it("returns a single-line result unchanged -- nothing to collapse", () => {
    expect(summarizeToolResult("391")).toBe("391");
  });

  it("collapses a multi-line result to its first line plus a remaining-line count", () => {
    expect(summarizeToolResult("a\nb\nc")).toBe("a\n… (+2 more lines — ctrl+o to expand)");
  });

  it("uses singular phrasing for exactly one remaining line", () => {
    expect(summarizeToolResult("a\nb")).toBe("a\n… (+1 more line — ctrl+o to expand)");
  });
});
