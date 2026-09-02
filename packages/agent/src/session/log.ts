// Crash-safe, append-only JSONL session log. One JSON object per line: a `SessionHeader` first,
// then a `SessionEntry` per line after. See decisions/0007-tiered-memory-architecture.md for why
// this shape (flat typed-entry array, prime-agent-like) and this crash-safety policy (pi-like:
// distinguish a torn last line from real mid-file corruption) were chosen over the alternatives.
import { appendFile, mkdir, readFile, truncate } from "node:fs/promises";
import { dirname } from "node:path";
import type { ArchivedToolOutputEntry, SessionEntry, SessionHeader } from "./entries.ts";

export class SessionLogCorruptionError extends Error {
  constructor(
    public readonly filePath: string,
    public readonly lineNumber: number,
    cause: unknown,
  ) {
    super(`session log ${filePath} is corrupt at line ${lineNumber}`, { cause });
    this.name = "SessionLogCorruptionError";
  }
}

export class SessionLog {
  private constructor(
    private readonly filePath: string,
    private readonly header: SessionHeader,
    private entries: SessionEntry[],
  ) {}

  /** Opens (creating if absent) the log at `filePath`. On an existing file, replays every line: a
   * JSON parse failure on the very last line is treated as a torn write from a crash mid-append
   * and repaired by truncating the file to drop it; a parse failure on any earlier line is real
   * corruption and throws rather than silently discarding history. */
  static async open(filePath: string, sessionId: string): Promise<SessionLog> {
    await mkdir(dirname(filePath), { recursive: true });

    let raw: string;
    try {
      raw = await readFile(filePath, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        const header: SessionHeader = {
          kind: "session-header",
          version: 1,
          sessionId,
          createdAt: Date.now(),
        };
        await appendFile(filePath, `${JSON.stringify(header)}\n`, "utf8");
        return new SessionLog(filePath, header, []);
      }
      throw error;
    }

    const lines = raw.length === 0 ? [] : raw.split("\n").filter((line) => line.length > 0);
    if (lines.length === 0) {
      throw new SessionLogCorruptionError(
        filePath,
        0,
        new Error("log file exists but has no header line"),
      );
    }

    let header: SessionHeader;
    try {
      header = JSON.parse(lines[0]) as SessionHeader;
    } catch (error) {
      if (lines.length === 1) {
        // Torn tail on the very first write this file ever received -- a crash immediately after
        // `open()` created it, before any entry existed yet. Recoverable exactly like any other
        // torn last line: since nothing else was ever written, start over with a fresh header.
        const freshHeader: SessionHeader = {
          kind: "session-header",
          version: 1,
          sessionId,
          createdAt: Date.now(),
        };
        await truncate(filePath, 0);
        await appendFile(filePath, `${JSON.stringify(freshHeader)}\n`, "utf8");
        return new SessionLog(filePath, freshHeader, []);
      }
      throw new SessionLogCorruptionError(filePath, 1, error);
    }

    const entries: SessionEntry[] = [];
    for (let i = 1; i < lines.length; i += 1) {
      try {
        entries.push(JSON.parse(lines[i]) as SessionEntry);
      } catch (error) {
        const isLastLine = i === lines.length - 1;
        if (!isLastLine) {
          throw new SessionLogCorruptionError(filePath, i + 1, error);
        }
        // Torn tail: the process almost certainly crashed mid-write of this last line. Drop it
        // from memory and truncate the on-disk file to match, so the next append starts clean.
        const goodBytes = Buffer.byteLength(`${lines.slice(0, i).join("\n")}\n`, "utf8");
        await truncate(filePath, goodBytes);
      }
    }

    return new SessionLog(filePath, header, entries);
  }

  get sessionId(): string {
    return this.header.sessionId;
  }

  get all(): readonly SessionEntry[] {
    return this.entries;
  }

  /** Pure incremental append -- one `write` syscall's worth of new bytes, never a rewrite of
   * existing content. Chosen over periodic full-file rewrites because a long coding session's
   * archived tool output can grow large; see decisions/0007. */
  async append(entry: SessionEntry): Promise<void> {
    await appendFile(this.filePath, `${JSON.stringify(entry)}\n`, "utf8");
    this.entries.push(entry);
  }

  findById(id: string): SessionEntry | undefined {
    return this.entries.find((entry) => entry.id === id);
  }

  /** Tier-4 recall: case-insensitive substring match over archived tool output, per the user's
   * explicit choice of keyword/id search over embedding-based retrieval (decisions/0007). Returns
   * short previews, not full content -- `recall(id)` fetches the rest. */
  searchArchivedToolOutput(
    query: string,
    limit = 10,
  ): Array<{ id: string; toolName: string; preview: string }> {
    const needle = query.toLowerCase();
    const results: Array<{ id: string; toolName: string; preview: string }> = [];
    for (const entry of this.entries) {
      if (entry.kind !== "archived-tool-output") continue;
      if (!entry.searchText.toLowerCase().includes(needle)) continue;
      results.push({ id: entry.id, toolName: entry.toolName, preview: previewOf(entry) });
      if (results.length >= limit) break;
    }
    return results;
  }
}

function previewOf(entry: ArchivedToolOutputEntry, maxLength = 200): string {
  const trimmed = entry.content.trim();
  return trimmed.length <= maxLength ? trimmed : `${trimmed.slice(0, maxLength)}…`;
}
