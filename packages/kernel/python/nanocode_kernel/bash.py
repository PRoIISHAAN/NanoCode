"""M1 stub.

prime-agent's real `rlm/bash.py` (890 lines) tracks every child process group spawned by a `bash()`
helper bound into the kernel namespace, journals them to disk so a crashed kernel's orphans can be
reaped, and kills every live group on shutdown (fd-based completion fencing, a bounded output
buffer, Windows job-object fallback via `_winjob.py`). None of that is in scope for M1: the ipython
tool doesn't bind a `bash()` helper into the namespace yet (model code that wants to run a shell
command uses Python's own `subprocess` module directly, unmanaged), so there are no tracked handles
for this module to kill.

`repl.py` still imports `kill_live_handles` from here unconditionally (it's called on every
`shutdown` request, whether or not anything used it), so this stub exists to satisfy that import
with a correct no-op rather than skip the call with a conditional. A real, process-group-tracked
`bash()` helper is a reasonable candidate for a future milestone if raw `subprocess` calls turn out
to be insufficient (see the "subprocess_timeout_and_abort" invariant in context-graph.json) --
tracked as a known gap in checkpoints/M1.md, not silently dropped.
"""

from __future__ import annotations


def kill_live_handles() -> None:
    """No-op in M1: no bash() helper exists yet, so there is nothing tracked to kill."""
    return None
