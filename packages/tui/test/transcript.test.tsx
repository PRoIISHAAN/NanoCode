import type { AgentMessage } from "@nanocode/agent";
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
    } as AgentMessage;
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
    } as AgentMessage;
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
    } as AgentMessage;

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
    } as AgentMessage;

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
  it("renders without crashing and shows nothing but the streaming line when there are no messages yet", () => {
    const { lastFrame } = render(<Transcript messages={[]} />);
    expect(lastFrame()).toBe("");
  });

  it("renders every message when history is short", () => {
    const messages = [userMessage("hi there", 1), assistantTextMessage("42", 2)];
    const { lastFrame } = render(<Transcript messages={messages} />);
    const frame = lastFrame() ?? "";
    expect(frame).toContain("hi there");
    expect(frame).toContain("42");
  });

  it("shows every message, however long the conversation, with no hidden-count indicator at all -- the whole point of switching to <Static>", () => {
    const messages = Array.from({ length: 100 }, (_, i) => userMessage(`line ${i}`, i));
    const { lastFrame } = render(<Transcript messages={messages} />);
    const frame = lastFrame() ?? "";
    expect(frame).not.toMatch(/hidden/i);
    expect(frame).not.toMatch(/earlier/i);
    expect(frame).toContain("line 0"); // the very first message is still reachable
    expect(frame).toContain("line 99"); // as is the most recent one
  });

  it("renders in-progress streaming text separately from the settled message list", () => {
    const { lastFrame } = render(
      <Transcript messages={[userMessage("go", 1)]} streamingText="thinking out loud…" />,
    );
    expect(lastFrame()).toContain("thinking out loud…");
  });

  it("renders streamingText verbatim, with no truncation, however long it is", () => {
    // `Transcript` itself no longer bounds `streamingText`'s rendered height at all -- that was
    // tried once (a `boundStreamingPreview` helper, now deleted) and rejected: it only masked a
    // real, user-visible one-time "grows to the bounded cap, then stops" shift right at the start
    // of a response's text phase, still perceived as "still scrolling." The real fix lives in
    // app.tsx instead: the only real caller now only ever passes a short FIXED status string
    // ("thinking..."/"responding…"), never the message's own growing text, so nothing here needs
    // to truncate anything ever again. This just proves `Transcript` renders whatever string it's
    // given as-is, unmangled, whether short or long.
    const longResponse = [
      "Once upon a time in a small coastal town there lived a curious engineer who spent every evening tinkering with old radios and half broken clocks, always searching for the one missing gear.",
      "Every morning she would walk down to the harbor and watch the fishing boats leave before sunrise, thinking about the problem she had been chasing for weeks.",
    ].join("\n\n");

    const { lastFrame } = render(<Transcript messages={[]} streamingText={longResponse} />);
    const frame = lastFrame() ?? "";

    expect(frame).toContain("Once upon a time");
    expect(frame).toContain("curious engineer");
    expect(frame).toContain("fishing boats leave before sunrise");
  });

  it("never truncates non-tool-cell messages, regardless of toolOutputExpanded", () => {
    const messages = [userMessage("line one\nline two", 1)];
    const { lastFrame } = render(<Transcript messages={messages} />);
    expect(lastFrame()).toContain("line two");
  });

  it("collapsed tool cell shows only its one-line summary -- no output at all", () => {
    const messages = [toolResultMessage("line one\nline two\nline three", 1)];
    const { lastFrame } = render(<Transcript messages={messages} />);
    const frame = lastFrame() ?? "";
    expect(frame).toContain("ipython");
    expect(frame).toContain("ctrl+o to expand");
    expect(frame).not.toContain("line one");
    expect(frame).not.toContain("line two");
    expect(frame).not.toContain("line three");
  });

  it("expanded tool cell shows the full output, with ctrl+o to collapse", () => {
    const messages = [toolResultMessage("line one\nline two\nline three", 1)];
    const { lastFrame } = render(<Transcript messages={messages} toolOutputExpanded />);
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

    const collapsedFrame = render(<Transcript messages={[message]} />).lastFrame() ?? "";
    expect(collapsedFrame).not.toContain("secret reasoning");
    expect(collapsedFrame).toContain("final answer");

    const expandedFrame =
      render(<Transcript messages={[message]} thinkingExpanded />).lastFrame() ?? "";
    expect(expandedFrame).toContain("secret reasoning");
    expect(expandedFrame).toContain("final answer");
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
