// M3: crash safety and durability for the session log (packages/agent/src/session/log.ts). Uses a
// real temp directory and real file I/O -- the thing under test IS the file format and the
// torn-tail-vs-corruption distinction, so faking the filesystem would test nothing real.
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SessionLog, SessionLogCorruptionError } from "../src/session/log.ts";

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "nanocode-session-log-"));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("SessionLog", () => {
  it("creates a new log with just a header when the file doesn't exist", async () => {
    const path = join(dir, "s.jsonl");
    const log = await SessionLog.open(path, "session-1");
    expect(log.sessionId).toBe("session-1");
    expect(log.all).toEqual([]);
    const raw = await readFile(path, "utf8");
    expect(raw.trim().split("\n")).toHaveLength(1);
  });

  it("appends entries and reloads them identically after reopening", async () => {
    const path = join(dir, "s.jsonl");
    const first = await SessionLog.open(path, "session-1");
    await first.append({
      id: "e1",
      timestamp: 1,
      kind: "message",
      message: { role: "user", content: "hi", timestamp: 1 },
    });
    await first.append({
      id: "e2",
      timestamp: 2,
      kind: "task-state",
      state: { goal: "ship M3", decisions: [] },
    });

    const reopened = await SessionLog.open(path, "session-1");
    expect(reopened.all).toEqual(first.all);
    expect(reopened.all).toHaveLength(2);
    expect(reopened.findById("e2")).toEqual({
      id: "e2",
      timestamp: 2,
      kind: "task-state",
      state: { goal: "ship M3", decisions: [] },
    });
  });

  it("repairs a torn header line (crash on the very first write) by starting a fresh log", async () => {
    // Regression: the original torn-tail repair only covered lines after the header, so a crash
    // mid-write of the header itself -- the earliest possible crash point, before any entry ever
    // existed -- hit the header-parse branch and hard-failed instead of being repaired like every
    // other torn last line.
    const path = join(dir, "s.jsonl");
    const { appendFile } = await import("node:fs/promises");
    await appendFile(path, '{"kind":"session-hea');

    const log = await SessionLog.open(path, "session-1");
    expect(log.all).toEqual([]);
    expect(log.sessionId).toBe("session-1");

    await log.append({
      id: "e1",
      timestamp: 1,
      kind: "message",
      message: { role: "user", content: "hi", timestamp: 1 },
    });
    const reopened = await SessionLog.open(path, "session-1");
    expect(reopened.all.map((e) => e.id)).toEqual(["e1"]);
  });

  it("repairs a torn last line (crash mid-write) by truncating it, keeping earlier entries intact", async () => {
    const path = join(dir, "s.jsonl");
    const log = await SessionLog.open(path, "session-1");
    await log.append({
      id: "e1",
      timestamp: 1,
      kind: "message",
      message: { role: "user", content: "hi", timestamp: 1 },
    });
    // Simulate a crash mid-write of a second entry: append a truncated, unparseable JSON fragment
    // with no trailing newline, exactly what a process death mid-`appendFile` would leave behind.
    const { appendFile } = await import("node:fs/promises");
    await appendFile(path, '{"id":"e2","timestamp":2,"kind":"mess');

    const reopened = await SessionLog.open(path, "session-1");
    expect(reopened.all).toHaveLength(1);
    expect(reopened.all[0]).toMatchObject({ id: "e1" });

    // The file itself was truncated to drop the torn line, not just skipped in memory -- a
    // subsequent append must produce a clean, valid file.
    await reopened.append({
      id: "e3",
      timestamp: 3,
      kind: "message",
      message: { role: "user", content: "again", timestamp: 3 },
    });
    const rereopened = await SessionLog.open(path, "session-1");
    expect(rereopened.all.map((e) => e.id)).toEqual(["e1", "e3"]);
  });

  it("hard-fails when a non-last line is corrupt, rather than silently dropping history", async () => {
    const path = join(dir, "s.jsonl");
    const log = await SessionLog.open(path, "session-1");
    await log.append({
      id: "e1",
      timestamp: 1,
      kind: "message",
      message: { role: "user", content: "hi", timestamp: 1 },
    });
    await log.append({
      id: "e2",
      timestamp: 2,
      kind: "message",
      message: { role: "user", content: "second", timestamp: 2 },
    });

    // Corrupt the middle line (the first entry line, not the last) in place.
    const raw = await readFile(path, "utf8");
    const lines = raw.split("\n");
    lines[1] = "{not json";
    const { writeFile } = await import("node:fs/promises");
    await writeFile(path, lines.join("\n"), "utf8");

    await expect(SessionLog.open(path, "session-1")).rejects.toBeInstanceOf(
      SessionLogCorruptionError,
    );
  });

  it("searchArchivedToolOutput matches case-insensitively and recall(id) fetches full content", async () => {
    const path = join(dir, "s.jsonl");
    const log = await SessionLog.open(path, "session-1");
    await log.append({
      id: "arc-1",
      timestamp: 1,
      kind: "archived-tool-output",
      toolCallId: "call-1",
      toolName: "ipython",
      content: "Traceback (most recent call last):\nValueError: boom",
      searchText: "Traceback (most recent call last):\nValueError: boom",
    });

    const results = log.searchArchivedToolOutput("valueerror");
    expect(results).toEqual([{ id: "arc-1", toolName: "ipython", preview: expect.any(String) }]);

    const entry = log.findById("arc-1");
    expect(entry?.kind).toBe("archived-tool-output");
    if (entry?.kind === "archived-tool-output") {
      expect(entry.content).toContain("ValueError: boom");
    }
  });
});
