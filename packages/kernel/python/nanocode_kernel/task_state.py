"""The `task_state` object bound into the kernel's executed namespace: `await task_state.set(...)`
records working memory explicitly (tier 2 of decisions/0007-tiered-memory-architecture.md) rather
than it being auto-extracted by a background LLM call -- validated against real production
practice (Claude Code's task-tracking tools, Codex CLI's `/plan`), both explicit/model-invoked.
Relays the call over the same generic host_request bridge `rlm.run()` uses; the host persists it
and re-surfaces it to the model on every subsequent turn regardless of compaction (see
session/compaction.ts's `prependTaskState`).
"""

from __future__ import annotations

from typing import Any

from .rlm import _call_host


class TaskState:
    """Bound into executed code's namespace as the name `task_state`."""

    async def set(
        self,
        *,
        goal: str | None = None,
        focus: str | None = None,
        decision: str | None = None,
        next_action: str | None = None,
    ) -> None:
        """Updates working memory. Only the fields you pass change; the rest keep their previous
        host-side value -- except `decision`, which *appends* to a running list of key decisions
        rather than replacing it, since decisions accumulate over a session instead of overwriting
        each other.
        """
        payload: dict[str, Any] = {}
        if goal is not None:
            payload["goal"] = goal
        if focus is not None:
            payload["focus"] = focus
        if decision is not None:
            payload["decision"] = decision
        if next_action is not None:
            payload["nextAction"] = next_action
        await _call_host("task_state.set", payload)


task_state = TaskState()
