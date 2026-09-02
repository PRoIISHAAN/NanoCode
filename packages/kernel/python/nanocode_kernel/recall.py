"""`recall_search(query)` / `recall(id)` -- tier 4 (raw history) retrieval, bound into the kernel's
executed namespace as plain functions rather than methods on an object, since each takes one
positional argument and reads naturally as `await recall_search("traceback")` / `await recall(id)`.
Keyword/id search only, no embeddings -- an explicit user choice; see
decisions/0007-tiered-memory-architecture.md.
"""

from __future__ import annotations

from typing import Any

from .rlm import _call_host


async def recall_search(query: str) -> list[dict[str, Any]]:
    """Case-insensitive substring search over archived tool output. Returns a list of
    `{id, toolName, preview}` dicts -- fetch an entry's full content with `recall(id)`.
    """
    if not isinstance(query, str) or not query:
        raise TypeError("query must be a non-empty str")
    response = await _call_host("recall.search", {"query": query})
    if not isinstance(response, list):
        raise RuntimeError("recall_search received an invalid response from the host")
    return response


async def recall(entry_id: str) -> str:
    """Fetches one archived tool output's full content by an id `recall_search` returned."""
    if not isinstance(entry_id, str) or not entry_id:
        raise TypeError("entry_id must be a non-empty str")
    response = await _call_host("recall.get", {"id": entry_id})
    if not isinstance(response, dict) or not isinstance(response.get("content"), str):
        raise RuntimeError(f"recall({entry_id!r}) found no archived entry with that id")
    return response["content"]
