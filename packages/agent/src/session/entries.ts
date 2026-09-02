// The persisted session log's entry shapes -- one JSON object per line on disk (see log.ts). This
// is a flat, typed-entry array (closer to prime-agent's shape than pi's lane/record/fact tree),
// stripped of every entry kind (branch summaries, labels, multi-lane bookkeeping) that only make
// sense for a branching or concurrent session model, since nanocode's is neither -- see
// decisions/0007-tiered-memory-architecture.md.
import type { AgentMessage } from "../types.ts";

/** Every entry carries a stable id (used by `recall()` and by compaction's cut-point reference)
 * and a timestamp. IDs are short and sortable-by-creation-order, not globally unique UUIDs --
 * nothing here needs cross-session uniqueness, only uniqueness within one session's own log. */
export interface EntryBase {
  id: string;
  timestamp: number;
}

/** One conversation message (user / assistant / tool-result), verbatim. */
export interface MessageEntry extends EntryBase {
  kind: "message";
  message: AgentMessage;
}

/** Records that a compaction ran: the summary text produced, and the timestamp of the first
 * message still kept verbatim afterward. A timestamp rather than an entry id, because compaction
 * (session/compaction.ts) operates on the in-memory `AgentMessage[]` the agent loop carries --
 * which has no log entry ids attached -- not on this log directly; every message's own
 * `timestamp` field is the only stable handle compaction has on "where the cut fell". */
export interface CompactionEntry extends EntryBase {
  kind: "compaction";
  summary: string;
  firstKeptTimestamp: number;
}

/** A snapshot of working memory (tier 2: task state) at the moment `task_state.set(...)` was
 * called. The model updates this explicitly -- see decisions/0007. Each call appends a full
 * snapshot (not a diff): task state is small, so simplicity beats a patch format here. */
export interface TaskStateEntry extends EntryBase {
  kind: "task-state";
  state: TaskState;
}

export interface TaskState {
  goal?: string;
  focus?: string;
  decisions: string[];
  nextAction?: string;
}

/** Tier 4 (raw history / tool output): the full content of a tool result that compaction pruned
 * from the live context. `searchText` is what `recall_search()` matches against -- currently just
 * the content itself (see recall.ts), kept as its own field so a smarter search (e.g. also
 * indexing the originating tool call's arguments) has somewhere to grow into later without
 * changing the entry shape. */
export interface ArchivedToolOutputEntry extends EntryBase {
  kind: "archived-tool-output";
  toolCallId: string;
  toolName: string;
  content: string;
  searchText: string;
}

export type SessionEntry =
  | MessageEntry
  | CompactionEntry
  | TaskStateEntry
  | ArchivedToolOutputEntry;

/** Written once, as the log file's first line, before any entry. Not itself a `SessionEntry` --
 * it has no id (there's nothing to recall it by) and a distinct shape a reader checks for first. */
export interface SessionHeader {
  kind: "session-header";
  version: 1;
  sessionId: string;
  createdAt: number;
}

let idCounter = 0;

/** A short, creation-ordered id: monotonic per process, so ids sort the same way the entries they
 * name were written -- useful for "everything after entry X" range queries without a separate
 * sequence field. Not a UUID: nothing here needs cross-session global uniqueness. */
export function nextEntryId(): string {
  idCounter += 1;
  return `${Date.now().toString(36)}-${idCounter.toString(36)}`;
}
