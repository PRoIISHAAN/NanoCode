"""The `rlm` object bound into the kernel's executed namespace: `await rlm.run(prompt)` recurses.

This mechanism -- code running inside the kernel calling back out to the TypeScript host to spawn
a fresh, depth-limited child agent, and the kernel's generic host_request bridge that makes any such
callback possible -- is the same recursive-sub-agent idea prime-agent-runtime's `rlm` package
demonstrates. The result-retrieval shape here is intentionally different, though: nanocode's
`rlm.run()` blocks and returns the child's final answer text directly, rather than returning a
spawn handle immediately and requiring a separate poll for the result. Depth-limit rejection
happens entirely on the TypeScript side, before any child session is constructed -- see
context-graph.json's `rlm_depth_enforced_pre_spawn` invariant.
"""

from __future__ import annotations

from typing import Any


async def _call_host(request_type: str, payload: dict[str, Any] | None = None) -> Any:
    """Delegates to the kernel's generic host bridge and unwraps its {status, result|error} envelope."""
    if not isinstance(request_type, str) or not request_type:
        raise TypeError("request_type must be a non-empty str")
    if payload is not None and not isinstance(payload, dict):
        raise TypeError(f"payload must be a dict or None, got {type(payload).__name__}")
    from . import repl  # imported lazily: repl.py binds this module before this line ever runs

    envelope = await repl.host_request({**(payload or {}), "type": request_type})
    status = envelope.get("status")
    if status == "ok":
        return envelope.get("result")
    if status == "error":
        raise RuntimeError(str(envelope.get("error") or f"host request {request_type!r} failed"))
    raise RuntimeError(f"host request {request_type!r} returned an unrecognized status: {status!r}")


class RecursiveAgent:
    """Bound into executed code's namespace as the name `rlm`."""

    async def run(self, prompt: str, **kwargs: Any) -> str:
        """Spawns a depth-limited child agent and blocks for its final text answer.

        Raises RuntimeError if the host rejects the recursion (depth limit reached -- rejected
        before any child session is built) or if the child's own run failed.
        """
        if not isinstance(prompt, str):
            raise TypeError(f"prompt must be str, got {type(prompt).__name__}")
        response = await _call_host("rlm.run", {"prompt": prompt, "kwargs": kwargs})
        if not isinstance(response, dict) or not isinstance(response.get("answer"), str):
            raise RuntimeError("rlm.run received an invalid response from the host")
        return response["answer"]

    async def __call__(self, prompt: str, **kwargs: Any) -> str:
        return await self.run(prompt, **kwargs)


rlm = RecursiveAgent()
