"""MCP (Model Context Protocol) client access, bound into the kernel's executed namespace.

nanocode's single-tool design (decisions-manifest.md's "Tool surface" row, M1) means MCP tools are
never exposed as separate agent-facing tool-call entries -- they're Python-callable from inside the
same persistent `ipython` REPL tool everything else already runs through. This matches prime-agent's
actual MCP integration pattern (the closer architectural analog, since prime-agent is also
single-tool/kernel-based, unlike pi, which has no MCP client at all) -- see
decisions/0009-mcp-client-support.md.

The real MCP client, connection management, and config loading all live on the TypeScript host
side (packages/agent/src/mcp/); this module is a thin host-request relay, the same pattern
rlm.py/task_state.py/recall.py already use. Python code here never talks to an MCP server directly.
"""

from __future__ import annotations

from typing import Any

from .rlm import _call_host


async def list_servers() -> list[str]:
    """Names of every configured MCP server (whether or not it has connected yet)."""
    response = await _call_host("mcp.list_servers")
    if not isinstance(response, list):
        raise RuntimeError("mcp.list_servers received an invalid response from the host")
    return response


async def list_tools(server: str) -> list[dict[str, Any]]:
    """Each tool as {"name": ..., "description": ..., "inputSchema": ...} (raw MCP JSON Schema,
    shown for reference -- nothing here validates arguments against it before calling)."""
    if not isinstance(server, str) or not server:
        raise TypeError("server must be a non-empty str")
    response = await _call_host("mcp.list_tools", {"server": server})
    if not isinstance(response, list):
        raise RuntimeError("mcp.list_tools received an invalid response from the host")
    return response


async def call_tool(server: str, tool: str, args: dict[str, Any] | None = None) -> Any:
    """Calls one MCP tool and returns its result: the server's structuredContent if it provided
    one, else its text content joined, else the raw content blocks. Raises RuntimeError if the
    server reports an error result, if the server fails to start, or if the call times out."""
    if not isinstance(server, str) or not server:
        raise TypeError("server must be a non-empty str")
    if not isinstance(tool, str) or not tool:
        raise TypeError("tool must be a non-empty str")
    return await _call_host("mcp.call_tool", {"server": server, "tool": tool, "args": args or {}})


class _ServerProxy:
    """Bound into the kernel namespace by server name (e.g. a configured server named "github"
    becomes a top-level `github` object) -- lets the model write `await github.search_issues(q="bug")`
    instead of `await mcp.call_tool("github", "search_issues", {"q": "bug"})`, matching prime-agent's
    ergonomic per-server binding. Every attribute access resolves to a `call_tool()` call under the
    hood; there's no separate connection or schema-discovery step of its own.
    """

    def __init__(self, server: str) -> None:
        self._server = server

    def __getattr__(self, tool: str) -> Any:
        if tool.startswith("_"):
            raise AttributeError(tool)

        async def _invoke(**kwargs: Any) -> Any:
            return await call_tool(self._server, tool, kwargs)

        return _invoke

    def __repr__(self) -> str:
        return (
            f"<mcp server {self._server!r} -- call any tool as an attribute, "
            f"e.g. await {self._server}.some_tool(...); await mcp.list_tools({self._server!r}) "
            "to see what's available>"
        )
