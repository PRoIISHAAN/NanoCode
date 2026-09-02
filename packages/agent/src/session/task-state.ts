// Host side of the `task_state.set(...)` builtin (packages/kernel/python/nanocode_kernel/task_state.py).
// Tier 2 (working memory) of decisions/0007-tiered-memory-architecture.md: a small structured
// object the model updates explicitly, held in memory for the compaction engine to re-inject every
// turn (see compaction.ts's `prependTaskState`) and persisted to the session log for durability.
import type { HostRequestHandler } from "@nanocode/kernel";
import { nextEntryId, type TaskState } from "./entries.ts";
import type { SessionLog } from "./log.ts";

/** Holds the session's current task state in memory. A thin mutable box rather than exposing
 * `Session`'s own private fields directly: `Session` reads it (to feed the compaction engine) and
 * the host_request handler below writes it, and neither needs to know about the other's shape. */
export class TaskStateStore {
  private current: TaskState | undefined;

  get(): TaskState | undefined {
    return this.current;
  }

  set(next: TaskState): void {
    this.current = next;
  }
}

/** Builds the "task_state.set" host_request handler. Only the fields present in `data` change;
 * `decision` is additive (appended to the running list) rather than a replacement, matching the
 * Python-side docstring's contract. */
export function createTaskStateHandler(
  store: TaskStateStore,
  sessionLog: SessionLog,
): HostRequestHandler {
  return async (data) => {
    const previous = store.get() ?? { decisions: [] };
    const next: TaskState = {
      goal: typeof data.goal === "string" ? data.goal : previous.goal,
      focus: typeof data.focus === "string" ? data.focus : previous.focus,
      decisions:
        typeof data.decision === "string"
          ? [...previous.decisions, data.decision]
          : previous.decisions,
      nextAction: typeof data.nextAction === "string" ? data.nextAction : previous.nextAction,
    };
    store.set(next);
    await sessionLog.append({
      id: nextEntryId(),
      timestamp: Date.now(),
      kind: "task-state",
      state: next,
    });
    return { ok: true };
  };
}
