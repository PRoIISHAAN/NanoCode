// Host side of the `recall_search(query)` / `recall(id)` builtins
// (packages/kernel/python/nanocode_kernel/recall.py). Tier 4 (raw history) of
// decisions/0007-tiered-memory-architecture.md: both just read from the session log's in-memory
// archive index built by `SessionLog.searchArchivedToolOutput`/`findById` -- no new storage here.
import type { HostRequestHandler } from "@nanocode/kernel";
import type { SessionLog } from "./log.ts";

export function createRecallSearchHandler(sessionLog: SessionLog): HostRequestHandler {
  return async (data) => {
    if (typeof data.query !== "string" || data.query.length === 0) {
      throw new Error("recall.search requires a non-empty string query");
    }
    return sessionLog.searchArchivedToolOutput(data.query);
  };
}

export function createRecallGetHandler(sessionLog: SessionLog): HostRequestHandler {
  return async (data) => {
    if (typeof data.id !== "string" || data.id.length === 0) {
      throw new Error("recall.get requires a non-empty string id");
    }
    const entry = sessionLog.findById(data.id);
    if (entry?.kind !== "archived-tool-output") {
      throw new Error(`no archived tool output found with id "${data.id}"`);
    }
    return { content: entry.content };
  };
}
