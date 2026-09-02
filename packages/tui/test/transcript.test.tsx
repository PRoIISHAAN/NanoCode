import type { AgentMessage } from "@nanocode/agent";
import { render } from "ink-testing-library";
import { describe, expect, it } from "vitest";
import {
  labelFor,
  selectVisibleWindow,
  summarizeToolResult,
  Transcript,
  textOf,
} from "../src/transcript.tsx";

function userMessage(text: string, timestamp: number): AgentMessage {
  return { role: "user", content: text, timestamp } as AgentMessage;
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
    expect(labelFor(userMessage("hi", 1))).toBe("You");
    expect(labelFor(toolResultMessage("ok", 1))).toBe("tool:ipython");
  });
});

describe("selectVisibleWindow", () => {
  it("keeps every message when they all fit within the budget", () => {
    const messages = [userMessage("a", 1), userMessage("b", 2)];
    const { visible, hiddenCount } = selectVisibleWindow(messages, 100, 80);
    expect(visible).toEqual(messages);
    expect(hiddenCount).toBe(0);
  });

  it("hides the oldest messages once history exceeds the visible window", () => {
    const messages = Array.from({ length: 50 }, (_, i) => userMessage(`message ${i}`, i));
    const { visible, hiddenCount } = selectVisibleWindow(messages, 10, 80);
    expect(hiddenCount).toBeGreaterThan(0);
    expect(visible.length).toBeLessThan(messages.length);
    // The tail is kept, not an arbitrary slice -- the most recent message is always visible.
    expect(visible.at(-1)).toBe(messages.at(-1));
  });

  it("always keeps at least the single most recent message, even if it alone exceeds the budget", () => {
    const messages = [userMessage("short", 1), userMessage("x".repeat(500), 2)];
    const { visible } = selectVisibleWindow(messages, 1, 80);
    expect(visible).toHaveLength(1);
    expect(visible[0]).toBe(messages[1]);
  });

  it("returns an empty window (no hidden count, no crash) for an empty message list", () => {
    expect(selectVisibleWindow([], 24, 80)).toEqual({ visible: [], hiddenCount: 0 });
  });

  it("does not loop forever or throw for a zero/negative row budget", () => {
    const messages = [userMessage("a", 1), userMessage("b", 2)];
    expect(() => selectVisibleWindow(messages, 0, 80)).not.toThrow();
    expect(() => selectVisibleWindow(messages, -5, 80)).not.toThrow();
    // Still keeps at least the most recent message, per the "always keep one" guarantee above.
    expect(selectVisibleWindow(messages, 0, 80).visible).toEqual([messages[1]]);
  });

  it("costs a collapsed tool result at its collapsed size, not its full uncollapsed size", () => {
    // Regression, found by L4 VERIFY: an earlier version always costed textOf(message) -- the
    // FULL, uncollapsed text -- even when toolOutputExpanded was false and the message was
    // actually being rendered collapsed. That mismatch meant the virtualization window hid far
    // more history than the collapsed view actually needed, and toggling ctrl+o never changed
    // which messages were in the window at all.
    // estimateLines is a char-count/width heuristic, not a newline count -- each line is padded to
    // a full 80-column width so the full text's estimated cost actually approximates its real
    // 50-line height (a short-lines version would estimate far fewer rows than 50, undermining the
    // scenario this test needs: a message whose collapsed and expanded costs genuinely differ).
    const longToolResults = Array.from({ length: 20 }, (_, i) =>
      toolResultMessage(
        Array.from({ length: 50 }, (_, line) => `line ${line}`.padEnd(80, ".")).join("\n"),
        i,
      ),
    );
    const collapsed = selectVisibleWindow(longToolResults, 24, 80, false);
    const expanded = selectVisibleWindow(longToolResults, 24, 80, true);
    // Collapsed, each message costs ~2 rows (label + one collapsed line) -- far more than 4 fit in
    // a 24-row budget. Expanded, each costs ~51 rows -- at most 1 fits (matching the "always keep
    // at least the most recent" guarantee).
    expect(collapsed.visible.length).toBeGreaterThan(4);
    expect(expanded.visible.length).toBeLessThanOrEqual(1);
  });
});

describe("Transcript (rendered)", () => {
  it("renders without crashing and shows nothing but the streaming line when there are no messages yet", () => {
    const { lastFrame } = render(<Transcript messages={[]} />);
    expect(lastFrame()).toBe("");
  });

  it("renders every message when history is short", () => {
    const messages = [userMessage("hi there", 1), toolResultMessage("42", 2)];
    const { lastFrame } = render(<Transcript messages={messages} />);
    const frame = lastFrame() ?? "";
    expect(frame).toContain("hi there");
    expect(frame).toContain("42");
  });

  it("virtualizes: shows a hidden-count indicator and only the tail once history is long", () => {
    const messages = Array.from({ length: 100 }, (_, i) => userMessage(`line ${i}`, i));
    const { lastFrame } = render(<Transcript messages={messages} />);
    const frame = lastFrame() ?? "";
    expect(frame).toMatch(/earlier messages? hidden/);
    expect(frame).toContain("line 99"); // the most recent message is always shown
    expect(frame).not.toContain("line 0"); // the oldest is virtualized away
  });

  it("renders in-progress streaming text separately from the settled message list", () => {
    const { lastFrame } = render(
      <Transcript messages={[userMessage("go", 1)]} streamingText="thinking out loud…" />,
    );
    expect(lastFrame()).toContain("thinking out loud…");
  });

  it("collapses a multi-line tool result to its first line by default", () => {
    const messages = [toolResultMessage("line one\nline two\nline three", 1)];
    const { lastFrame } = render(<Transcript messages={messages} />);
    const frame = lastFrame() ?? "";
    expect(frame).toContain("line one");
    expect(frame).toContain("+2 more lines");
    expect(frame).not.toContain("line two");
  });

  it("shows a tool result in full when toolOutputExpanded is true", () => {
    const messages = [toolResultMessage("line one\nline two\nline three", 1)];
    const { lastFrame } = render(<Transcript messages={messages} toolOutputExpanded />);
    const frame = lastFrame() ?? "";
    expect(frame).toContain("line one");
    expect(frame).toContain("line two");
    expect(frame).toContain("line three");
    expect(frame).not.toContain("more lines");
  });

  it("never collapses non-toolResult messages, regardless of toolOutputExpanded", () => {
    const messages = [userMessage("line one\nline two", 1)];
    const { lastFrame } = render(<Transcript messages={messages} />);
    expect(lastFrame()).toContain("line two");
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
