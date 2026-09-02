"""A persistent CPython kernel that executes code cells over newline-delimited JSON on stdio.

Entry point: ``python -m nanocode_kernel.repl``. Cells run with top-level await in one shared
``__main__`` namespace on a single asyncio event loop, so state (variables, imports, background
tasks) survives between calls -- that's what makes this a REPL rather than a script runner.

Design note: this module solves the same set of hard problems prime-agent-runtime's `rlm/repl.py`
solves (a persistent namespace needs a way to capture output *and* attribute it to the right call;
"stop the currently running cell" needs real signal delivery, not just closing a pipe; a crashed
snapshot must never leave a half-written file) -- studying that implementation is what surfaced
these problems and their solutions in the first place. The code here is an independent
implementation of those same solutions, organized around one `Kernel` object holding all runtime
state instead of a collection of module-level globals, with its own naming and structure
throughout.
"""

from __future__ import annotations

import ast
import asyncio
import codecs
import contextvars
import ctypes
import inspect
import io
import json
import linecache
import os
import platform
import signal
import sys
import tempfile
import threading
import time
import traceback
import types
import uuid
from collections.abc import Awaitable, Callable
from typing import Any

from .bash import kill_live_handles

PROTOCOL_VERSION = 3

DEFAULT_SNAPSHOT_MAX_BYTES = 256 * 1024 * 1024
DEFAULT_SNAPSHOT_MAX_VARIABLE_BYTES = 16 * 1024 * 1024

# Names the bootstrap re-creates every start; a snapshot must never try to persist or restore them.
RESERVED_NAMES = {
    "rlm",
    "mcp",
    "bash",
    "task_state",
    "recall_search",
    "recall",
    "asyncio",
    "In",
    "Out",
    "get_ipython",
    "exit",
    "quit",
    "open",
}
# Names IPython itself injects that could appear in an old snapshot payload; never restore these.
IPYTHON_ARTIFACT_NAMES = {"In", "Out", "get_ipython"}

_THIS_FILE = __file__


def _visible_frames(stack: traceback.StackSummary) -> traceback.StackSummary | None:
    """Trims a traceback to start at the first `<cell-N>` frame and drop this module's own frames.

    Returns None when there's no cell frame at all (e.g. a SyntaxError caught before any cell
    frame exists) -- callers fall back to an exception-only rendering in that case.
    """
    start = next((i for i, f in enumerate(stack) if f.filename.startswith("<cell-")), None)
    if start is None:
        return None
    return traceback.StackSummary.from_list([f for f in stack[start:] if f.filename != _THIS_FILE])


def _describe(exc: BaseException) -> str:
    try:
        return str(exc)
    except BaseException:  # noqa: BLE001 - a broken __str__ on the user's own exception must not crash the kernel
        return "<exception str() failed>"


def _error_frame(cell_id: str, exc: BaseException) -> dict[str, Any]:
    formatted = traceback.TracebackException.from_exception(exc)
    visible = _visible_frames(formatted.stack)
    if visible is None:
        lines = traceback.format_exception_only(type(exc), exc)
    else:
        formatted.stack = visible
        lines = list(formatted.format())
    return {
        "event": "error",
        "id": cell_id,
        "ename": type(exc).__name__,
        "evalue": _describe(exc),
        "traceback": lines,
    }


def _cancelled_frame(cell_id: str, exc: BaseException) -> dict[str, Any]:
    """Renders a cancelled (interrupted, await-suspended) cell as a KeyboardInterrupt frame."""
    visible = _visible_frames(traceback.extract_tb(exc.__traceback__))
    lines: list[str] = []
    if visible:
        lines = ["Traceback (most recent call last):\n", *visible.format()]
    lines.append("KeyboardInterrupt\n")
    return {"event": "error", "id": cell_id, "ename": "KeyboardInterrupt", "evalue": "", "traceback": lines}


def _compile_source(source: str, filename: str) -> tuple[list[types.CodeType], bool]:
    """Compiles a cell body; a trailing bare expression compiles separately in eval mode so its
    value can be captured as the cell's "result" without the user needing to call print()."""
    linecache.cache[filename] = (len(source), None, source.splitlines(keepends=True), filename)
    tree = ast.parse(source, filename)
    trailing_expr: ast.Expression | None = None
    if tree.body and isinstance(tree.body[-1], ast.Expr):
        trailing_expr = ast.Expression(tree.body.pop().value)
    flags = ast.PyCF_ALLOW_TOP_LEVEL_AWAIT
    compiled: list[types.CodeType] = []
    if tree.body:
        compiled.append(compile(tree, filename, "exec", flags=flags, dont_inherit=True))
    if trailing_expr is not None:
        compiled.append(compile(trailing_expr, filename, "eval", flags=flags, dont_inherit=True))
    return compiled, trailing_expr is not None


async def _run_compiled(units: list[types.CodeType], namespace: dict[str, Any]) -> Any:
    value: Any = None
    for unit in units:
        value = eval(unit, namespace)  # noqa: S307 - running the model's own cell is the kernel's job
        if unit.co_flags & inspect.CO_COROUTINE:
            value = await value
    return value


class _PipeRelay:
    """Reads one fd (fed by a redirected stdout/stderr) and forwards its bytes as stream events.

    Output that lands here has no provable source cell -- it's whatever wrote directly to the raw
    file descriptor (a C extension, a subprocess, `os.write`) rather than through `sys.stdout`.
    Every event this relay emits therefore carries `id: null`.
    """

    def __init__(self, read_fd: int, mirror_of_fd: int, stream_name: str, send: Callable[[dict[str, Any]], None]) -> None:
        self._read_fd = read_fd
        # A private duplicate of the write end: a cell that closes or reassigns fd 1/2 can't
        # intercept the marker bytes `drain()` writes below.
        self._marker_fd = os.dup(mirror_of_fd)
        self._stream_name = stream_name
        self._send = send
        self._decoder = codecs.getincrementaldecoder("utf-8")("replace")
        self._lock = threading.Lock()
        self._awaited_marker: tuple[bytes, threading.Event] | None = None
        self._carry = b""
        self._thread = threading.Thread(target=self._pump, daemon=True)
        self._thread.start()

    def drain(self) -> None:
        """Blocks until every byte written to the fd so far has been relayed as an event.

        Writes a random marker into the fd and waits for the reader thread to see it come back
        out, which can only happen after everything written before it has already been read.
        """
        marker = b"\xff<drain:" + uuid.uuid4().hex.encode() + b">\xff"
        seen = threading.Event()
        with self._lock:
            self._awaited_marker = (marker, seen)
        try:
            os.write(self._marker_fd, marker)
            while not seen.wait(0.1):
                if not self._thread.is_alive():  # the read side is gone; stop waiting
                    return
        except OSError:
            return
        finally:
            with self._lock:
                self._awaited_marker = None

    def _pump(self) -> None:
        while True:
            try:
                chunk = os.read(self._read_fd, 65536)
            except OSError:
                return
            if not chunk:
                return
            self._consume(chunk)

    def _consume(self, chunk: bytes) -> None:
        data = self._carry + chunk
        self._carry = b""
        with self._lock:
            awaited = self._awaited_marker
        if awaited is None:
            self._emit(data)
            return
        marker, seen = awaited
        while True:
            index = data.find(marker)
            if index == -1:
                break
            self._emit(data[:index])
            self._flush_decoder()
            seen.set()
            data = data[index + len(marker) :]
        # A marker could straddle two reads; hold back a tail that might be its start.
        keep = 0
        for length in range(min(len(data), len(marker) - 1), 0, -1):
            if data.endswith(marker[:length]):
                keep = length
                break
        if keep:
            self._carry = data[len(data) - keep :]
            data = data[: len(data) - keep]
        self._emit(data)

    def _emit(self, data: bytes) -> None:
        if not data:
            return
        text = self._decoder.decode(data)
        if text:
            self._send({"event": self._stream_name, "id": None, "text": text})

    def _flush_decoder(self) -> None:
        text = self._decoder.decode(b"", final=True)
        self._decoder = codecs.getincrementaldecoder("utf-8")("replace")
        if text:
            self._send({"event": self._stream_name, "id": None, "text": text})


class _AttributedBinaryIO(io.RawIOBase):
    """`.buffer` of an `_AttributedTextIO`: byte writes have no provable cell, so they fall through
    to the raw fd (and are relayed, unattributed, by a `_PipeRelay`)."""

    def __init__(self, fallback_fd: int) -> None:
        self._fallback_fd = fallback_fd

    def write(self, data: Any) -> int:
        view = memoryview(data).cast("B")  # rejects int like a real buffer would, unlike bytes()
        total = len(view)
        while view:
            view = view[os.write(self._fallback_fd, view) :]
        return total

    def flush(self) -> None:
        pass

    def fileno(self) -> int:
        return self._fallback_fd

    def writable(self) -> bool:
        return True


class _AttributedTextIO(io.TextIOBase):
    """Replaces sys.stdout/sys.stderr so text writes are tagged with the writing cell's id.

    Text written through here (i.e. anything going through a normal `print()`) is attributed via
    `active_cell.get()` and sent directly as a protocol event -- it never touches the redirected
    fd pipe. `.buffer`/`.fileno()` still expose that pipe, so subprocesses, C extensions, and
    `sys.stdout.buffer.write()` keep working (unattributed, through `_PipeRelay`).
    """

    def __init__(self, stream_name: str, active_cell: contextvars.ContextVar[str | None], fallback_fd: int, send: Callable[[dict[str, Any]], None]) -> None:
        self._stream_name = stream_name
        self._active_cell = active_cell
        self._fallback_fd = fallback_fd
        self._buffer = _AttributedBinaryIO(fallback_fd)
        self._send = send

    def write(self, text: str) -> int:
        if not isinstance(text, str):
            raise TypeError(f"write() argument must be str, not {type(text).__name__}")
        if text:
            self._send({"event": self._stream_name, "id": self._active_cell.get(), "text": text})
        return len(text)

    def flush(self) -> None:
        pass

    def fileno(self) -> int:
        return self._fallback_fd

    def writable(self) -> bool:
        return True

    @property
    def buffer(self) -> _AttributedBinaryIO:
        return self._buffer

    @property
    def encoding(self) -> str:
        return "utf-8"

    @property
    def errors(self) -> str:
        return "replace"


class _OversizedSnapshot(Exception):
    pass


class _BoundedByteSink:
    """A write target that raises `_OversizedSnapshot` instead of growing past `limit` bytes."""

    def __init__(self, limit: int) -> None:
        self._buffer = io.BytesIO()
        self._limit = limit

    def write(self, chunk: bytes) -> int:
        if self._buffer.tell() + len(chunk) > self._limit:
            raise _OversizedSnapshot()
        return self._buffer.write(chunk)

    def getvalue(self) -> bytes:
        return self._buffer.getvalue()


class _InterruptCoordinator:
    """Everything needed to answer one question under concurrent access from three different
    threads of control (a POSIX signal handler, the stdin reader thread, and the event loop's own
    task): "should this particular request be interrupted right now, and if so, how?"

    Stopping the currently running cell is hard in a single-threaded asyncio program: you can't
    just raise into another thread's stack. The approach: `deliver()` sends a real SIGINT to the
    main thread (where cells actually execute); `handle_sigint()` -- the signal handler itself,
    which necessarily runs on the main thread, possibly mid-step of whatever task the signal
    happened to catch -- works out from asyncio's own bookkeeping whether that's actually the
    request meant to be interrupted, and either raises directly (that task's own step was hit) or
    cancels its task object (the loop was idle at an await, or a different task was mid-step).

    A registered request can be interrupted during two separate windows: while its task is
    actively running (tracked by `begin()`/`hand_off_to_finishing()`), and briefly afterward while
    its post-run synchronous work (a trailing-expression repr, draining output) still executes on
    the main thread -- `deliver()` and `handle_sigint()` both understand that second window.
    """

    def __init__(self, owner: "Kernel") -> None:
        self._owner = owner
        self._lock = threading.Lock()
        self._current_task: asyncio.Task[Any] | None = None
        self._current_request_id: str | None = None
        self._current_was_interrupted = False
        self._winding_down_id: str | None = None
        self._target_id: str | None = None
        self._handoff_pending = False
        self._inflight: set[str] = set()
        self._queued_ids: set[str] = set()
        self._queued_untargeted = False

    # -- registering/releasing a request's interrupt-targetability window --

    def register(self, request_id: str) -> bool:
        """Marks a request as interruptable. Returns False if it was already registered (caller
        should treat that as a duplicate request id and refuse it)."""
        with self._lock:
            if request_id in self._inflight:
                return False
            self._inflight.add(request_id)
            return True

    def release(self, request_id: str) -> None:
        """Drops all bookkeeping for a request that's fully done -- whether it ran to completion
        or never got that far (e.g. failed during compilation, before `begin()` was ever called)."""
        with self._lock:
            self._release_locked(request_id)

    def _release_locked(self, request_id: str) -> None:
        if self._winding_down_id == request_id:
            self._winding_down_id = None
            self._handoff_pending = False
        if self._target_id == request_id:
            self._target_id = None
        self._inflight.discard(request_id)
        self._queued_ids.discard(request_id)
        if not self._inflight:
            self._queued_untargeted = False

    def consume_own_queued_interrupt(self, request_id: str) -> bool:
        """For a request that's being released without ever having called `begin()`: it may still
        own a queued interrupt, which must be consumed here so it doesn't leak onto the next
        request that reuses an untargeted queue slot."""
        with self._lock:
            if request_id not in self._inflight:
                return False
            return self._take_queued_locked(request_id)

    def _take_queued_locked(self, request_id: str) -> bool:
        hit = self._queued_untargeted or request_id in self._queued_ids
        self._queued_untargeted = False
        self._queued_ids.discard(request_id)
        return hit

    # -- the active-task window --

    def begin(self, request_id: str, task: "asyncio.Task[Any]") -> None:
        """Marks `task` as the one currently running for `request_id`; cancels it immediately if
        an untargeted or matching interrupt was already queued before this call."""
        with self._lock:
            self._current_task = task
            self._current_request_id = request_id
            self._current_was_interrupted = False
            if self._take_queued_locked(request_id):
                self._current_was_interrupted = True
                task.cancel()

    def was_interrupted(self) -> bool:
        return self._current_was_interrupted

    def hand_off_to_finishing(self, request_id: str) -> None:
        """The task itself is done, but its request still has synchronous post-run work ahead
        (repr, output drain) during which an interrupt should still land."""
        with self._lock:
            self._winding_down_id = request_id
            self._current_task = None
            self._current_request_id = None

    def take_handoff_interrupt(self) -> bool:
        """Consumes an interrupt that arrived in the narrow gap between the task finishing and
        `hand_off_to_finishing()` actually running."""
        with self._lock:
            pending = self._handoff_pending
            self._handoff_pending = False
            return pending

    # -- delivery (runs on the reader thread) --

    def deliver(self, target_id: str | None) -> None:
        """No target id means "whatever's running now, or the next request if none is"; a target
        id means exactly that request. Silently dropped for a request already finished or unseen.
        """
        with self._lock:
            active_task = self._current_task
            if self._current_request_id is not None and (target_id is None or target_id == self._current_request_id):
                self._target_id = self._current_request_id
            elif self._winding_down_id is not None and (target_id is None or target_id == self._winding_down_id):
                self._target_id = self._winding_down_id
            elif target_id is not None:
                if target_id in self._inflight:
                    self._queued_ids.add(target_id)
                return
            elif self._inflight:
                self._queued_untargeted = True
                return
            else:
                return
        self._signal_main_thread(active_task)

    def _signal_main_thread(self, task_when_targeted: "asyncio.Task[Any] | None") -> None:
        loop = self._owner.loop
        if hasattr(signal, "pthread_kill"):
            signal.pthread_kill(threading.main_thread().ident, signal.SIGINT)
            if loop is not None:
                loop.call_soon_threadsafe(lambda: None)  # wake the selector promptly
            return
        # Windows has no signal.pthread_kill: cancelling from the loop still interrupts an
        # await-suspended task, though not one blocked in synchronous code.
        if loop is None:
            return

        def cancel_if_still_targeted() -> None:
            if self._current_task is task_when_targeted and self._current_task is not None and not self._current_task.done():
                self._current_was_interrupted = True
                self._current_task.cancel()

        loop.call_soon_threadsafe(cancel_if_still_targeted)

    # -- the signal handler itself --

    def handle_sigint(self, _signum: int, _frame: types.FrameType | None) -> None:
        # No lock (the main thread may already hold it): re-checking the request id against the
        # target means a signal delayed past that request's completion can't land on whatever
        # request happens to be current next.
        if self._current_task is None or self._current_task.done() or self._current_request_id != self._target_id:
            self._handle_sigint_for_inactive_task()
            return
        self._current_was_interrupted = True
        running = asyncio.current_task(self._owner.loop) if self._owner.loop is not None else None
        if running is self._current_task:
            raise KeyboardInterrupt  # the signal landed mid-step of the targeted task itself
        # Loop idle at an await, or a different task mid-step: cancelling here is safe (same thread).
        self._current_task.cancel()
        if running is not None and running is not self._owner.serve_task:
            # A background task blocked in sync code holds the only thread, which would stop the
            # cancellation from ever taking effect: raise into it too so it unwinds (dying with
            # this KeyboardInterrupt) and frees the loop to process the cancel.
            running.add_done_callback(lambda t: None if t.cancelled() else t.exception())
            raise KeyboardInterrupt

    def _handle_sigint_for_inactive_task(self) -> None:
        if self._target_id is not None and self._target_id == self._current_request_id:
            # Handoff window: the task finished but hand_off_to_finishing() hasn't run yet, so the
            # main thread might be inside loop internals where raising would kill the serve loop
            # outright. Record it; take_handoff_interrupt() picks it up once safe.
            self._handoff_pending = True
            return
        if self._target_id is not None and self._target_id == self._winding_down_id:
            raise KeyboardInterrupt  # post-run work is plain synchronous code: safe to raise into


class Kernel:
    """Owns every piece of mutable runtime state for one kernel process."""

    def __init__(self) -> None:
        self._protocol_fd = -1
        self._write_lock = threading.Lock()
        self.loop: asyncio.AbstractEventLoop | None = None
        self.serve_task: asyncio.Task[Any] | None = None

        # Attribution rides Python's contextvars: a task created inside a cell copies the
        # context at creation time, so it keeps writing under that cell's id even after the cell
        # itself returns. A freshly started OS thread gets a blank context (id: None).
        self.active_cell: contextvars.ContextVar[str | None] = contextvars.ContextVar("active_cell", default=None)
        self._interrupts = _InterruptCoordinator(self)
        self._cell_counter = 0

        self._pending_host_calls: dict[str, "asyncio.Future[dict[str, Any]]"] = {}
        self._host_closed = False

        self._stdout_relay: _PipeRelay | None = None
        self._stderr_relay: _PipeRelay | None = None

    # ── wire protocol ────────────────────────────────────────────────────────────────────────

    def send(self, event: dict[str, Any]) -> None:
        """Writes one JSON line; the lock makes the write atomic so frames never interleave."""
        payload = (json.dumps(event, separators=(",", ":")) + "\n").encode()
        with self._write_lock:
            view = memoryview(payload)
            try:
                while view:
                    view = view[os.write(self._protocol_fd, view) :]
            except OSError:
                pass

    def is_serving(self) -> bool:
        """True once this process is actually speaking the protocol (not merely imported)."""
        return self._protocol_fd >= 0

    def emit_display(self, data: dict[str, Any]) -> None:
        """Ships a `display` event: one dict of MIME type -> JSON-serializable payload."""
        if not isinstance(data, dict) or not data or not all(isinstance(k, str) for k in data):
            raise TypeError("emit_display() requires a non-empty dict keyed by MIME type strings")
        # A throwaway strict-mode dump catches NaN/Infinity now, before send() re-serializes with
        # the default (permissive) encoder -- letting either through would tear the wire framing.
        json.dumps(data, allow_nan=False)
        self.send({"event": "display", "id": self.active_cell.get(), "data": data})

    async def call_host(self, data: dict[str, Any]) -> dict[str, Any]:
        """Sends one `host_request` event and awaits the matching `host_reply`'s raw data dict."""
        if self.loop is None:
            raise RuntimeError("kernel is not serving")
        if self._host_closed:
            raise RuntimeError("host connection is closed; call_host cannot be answered")
        request_id = uuid.uuid4().hex
        future: asyncio.Future[dict[str, Any]] = self.loop.create_future()
        self._pending_host_calls[request_id] = future
        try:
            self.send({"event": "host_request", "id": request_id, "data": data})
            return await future
        finally:
            self._pending_host_calls.pop(request_id, None)

    def _abandon_pending_host_calls(self) -> None:
        """Runs on teardown: no host_reply can arrive after this, so every waiting cell unblocks."""
        self._host_closed = True
        for future in self._pending_host_calls.values():
            if not future.done():
                future.set_exception(RuntimeError("host connection closed; call_host cannot be answered"))

    def _resolve_host_reply(self, request_id: str, data: dict[str, Any]) -> None:
        """Runs on the reader thread; a reply for an unknown or already-settled id is dropped."""
        assert self.loop is not None

        def deliver() -> None:
            future = self._pending_host_calls.get(request_id)
            if future is not None and not future.done():
                future.set_result(data)

        self.loop.call_soon_threadsafe(deliver)

    # ── cell execution ───────────────────────────────────────────────────────────────────────

    async def _supervise(self, task: asyncio.Task[Any], request_id: str) -> tuple[str, Any, dict[str, Any] | None]:
        """Awaits a request's task, returning (status, value, error-frame-or-None)."""
        self._interrupts.begin(request_id, task)
        try:
            value = await task
            return "ok", value, None
        except asyncio.CancelledError as exc:
            if self._interrupts.was_interrupted():
                return "error", None, _cancelled_frame(request_id, exc)
            return "error", None, _error_frame(request_id, exc)
        except BaseException as exc:  # noqa: BLE001 - every cell failure becomes an error event, never a crash
            return "error", None, _error_frame(request_id, exc)
        finally:
            # The id stays inflight and interrupt-targetable through the post-run repr/drain
            # below; deliver() checks the coordinator's winding-down id for exactly that window.
            self._interrupts.hand_off_to_finishing(request_id)

    async def _execute_cell(self, request: dict[str, Any], namespace: dict[str, Any]) -> None:
        cell_id = request["id"]
        self._cell_counter += 1
        filename = f"<cell-{self._cell_counter}>"
        token = self.active_cell.set(cell_id)
        try:
            units, has_trailing_expr = _compile_source(request["code"], filename)
            assert self.loop is not None
            task = self.loop.create_task(_run_compiled(units, namespace))
            status, value, error = await self._supervise(task, cell_id)
            result_text: str | None = None
            try:
                if self._interrupts.take_handoff_interrupt() and status == "ok":
                    status, error = "error", _error_frame(cell_id, KeyboardInterrupt())
                if status == "ok" and has_trailing_expr and value is not None:
                    try:
                        namespace["_"] = value
                        result_text = repr(value)
                    except BaseException as exc:  # noqa: BLE001 - a broken __repr__ is the cell's own error
                        status, error = "error", _error_frame(cell_id, exc)
                self._drain_output()
            finally:
                # Closing the interrupt window before sending means a handler-raised
                # KeyboardInterrupt can never tear a frame mid-send().
                self._interrupts.release(cell_id)
            if result_text is not None:
                self.send({"event": "result", "id": cell_id, "text": result_text})
            if error is not None:
                self.send(error)
            self.send({"event": "done", "id": cell_id, "status": status})
        finally:
            self.active_cell.reset(token)

    def _drain_output(self) -> None:
        for stream in (sys.stdout, sys.stderr):
            try:
                stream.flush()
            except (OSError, ValueError, AttributeError):
                # A cell may have closed or rebound stdout/stderr; the other stream must still
                # get its chance to flush.
                pass
        assert self._stdout_relay is not None and self._stderr_relay is not None
        self._stdout_relay.drain()
        self._stderr_relay.drain()

    # ── namespace snapshot / restore ─────────────────────────────────────────────────────────

    def _snapshot(
        self,
        namespace: dict[str, Any],
        payload_path: str,
        manifest_path: str,
        max_bytes: int,
        max_variable_bytes: int,
        prune_oversized: bool,
        committed: list[dict[str, Any]] | None = None,
    ) -> dict[str, Any]:
        import datetime

        try:
            import dill
        except Exception as err:  # noqa: BLE001 - dill is host-provisioned, not a hard dependency
            return {"error": f"dill unavailable: {err}"}
        dill.settings["recurse"] = True

        pickled: dict[str, bytes] = {}
        skipped: list[dict[str, str]] = []
        oversized: list[str] = []
        total = 0
        missing = object()
        for name in list(namespace.keys()):
            if name.startswith("_") or name in RESERVED_NAMES:
                continue
            value = namespace.get(name, missing)
            if value is missing:
                skipped.append({"name": name, "reason": "deleted during snapshot"})
                continue
            remaining = max_bytes - total
            cap = max_variable_bytes if prune_oversized else min(max_variable_bytes, remaining)
            sink = _BoundedByteSink(cap)
            try:
                dill.dump(value, sink)
                blob = sink.getvalue()
            except _OversizedSnapshot:
                if not prune_oversized and remaining < max_variable_bytes:
                    skipped.append({"name": name, "reason": "exceeds aggregate snapshot size cap"})
                else:
                    skipped.append({"name": name, "reason": "exceeds per-variable snapshot size cap"})
                    oversized.append(name)
                continue
            except Exception as err:  # noqa: BLE001 - one unpicklable name must not abort the whole snapshot
                skipped.append({"name": name, "reason": f"{type(err).__name__}: {_describe(err)[:200]}"})
                continue
            if total + len(blob) > max_bytes:
                skipped.append({"name": name, "reason": "exceeds aggregate snapshot size cap"})
                continue
            pickled[name] = blob
            total += len(blob)

        os.makedirs(os.path.dirname(payload_path) or ".", exist_ok=True)
        temp_paths: list[str] = []

        def stage_temp(target: str, mode: str):
            fd, name = tempfile.mkstemp(
                dir=os.path.dirname(target) or ".", prefix=os.path.basename(target) + ".", suffix=".tmp"
            )
            temp_paths.append(name)
            try:
                return os.fdopen(fd, mode), name
            except BaseException:
                os.close(fd)
                raise

        def discard_temps() -> None:
            for stale in temp_paths:
                try:
                    os.remove(stale)
                except OSError:
                    pass

        stage = "write"
        installed_handler = False
        previous_handler = None
        try:
            try:

                def serialize(candidate: dict[str, bytes]) -> bytes | None:
                    sink = _BoundedByteSink(max_bytes)
                    try:
                        dill.dump(candidate, sink)
                    except _OversizedSnapshot:
                        return None
                    return sink.getvalue()

                serialized = serialize(pickled)
                if serialized is None:
                    items = list(pickled.items())
                    serialized = serialize({})
                    if serialized is None:
                        return {"error": "write failed: snapshot exceeds aggregate snapshot size cap"}
                    # Binary search the largest prefix whose pickle still fits; prefix size is
                    # monotonic since each step only adds one more string key + bytes value.
                    low, high = 0, len(items) - 1
                    while low < high:
                        mid = (low + high + 1) // 2
                        candidate = serialize(dict(items[:mid]))
                        if candidate is None:
                            high = mid - 1
                        else:
                            low = mid
                            serialized = candidate
                    for name, _ in items[low:]:
                        skipped.append({"name": name, "reason": "exceeds aggregate snapshot size cap"})
                    pickled = dict(items[:low])

                fh, tmp_payload = stage_temp(payload_path, "wb")
                with fh:
                    fh.write(serialized)
                bytes_written = len(serialized)
                saved_names = sorted(pickled.keys())
                pruned = sorted(name for name in oversized if name in namespace) if prune_oversized else []
                manifest = {
                    "version": 1,
                    "savedNames": saved_names,
                    "skipped": skipped,
                    "pruned": pruned,
                    "bytes": bytes_written,
                    "pythonVersion": sys.version.split()[0],
                    "timestamp": datetime.datetime.now(datetime.timezone.utc).isoformat(),
                }
                stage = "manifest write"
                fh, tmp_manifest = stage_temp(manifest_path, "w")
                with fh:
                    json.dump(manifest, fh)
            except BaseException as err:  # noqa: BLE001 - Exception becomes an error dict; anything else propagates
                if not isinstance(err, Exception):
                    raise
                return {"error": f"{stage} failed: {err}"}

            # A SIGINT anywhere between the first rename and the temp cleanup could desync the
            # payload, manifest, and pruned namespace: park it until everything below is done.
            previous_handler = signal.signal(signal.SIGINT, lambda *_: None)
            installed_handler = True
            try:
                os.replace(tmp_payload, payload_path)
            except OSError as err:
                return {"error": f"write failed: {err}"}
            try:
                os.replace(tmp_manifest, manifest_path)
            except OSError as err:
                return {"error": f"manifest write failed: {err}"}
            for name in pruned:
                namespace.pop(name, None)
            result = {"saved": saved_names, "skipped": skipped, "pruned": pruned, "bytes": bytes_written}
            if committed is not None:
                committed.append(result)
        finally:
            try:
                discard_temps()
            finally:
                if installed_handler:
                    signal.signal(signal.SIGINT, previous_handler)
        return result

    def _restore(self, namespace: dict[str, Any], payload_path: str, committed: list[dict[str, Any]] | None = None) -> dict[str, Any]:
        if not os.path.exists(payload_path):
            return {"restored": [], "failed": [], "reason": "snapshot not found"}
        try:
            import dill
        except Exception as err:  # noqa: BLE001
            return {"error": f"dill unavailable: {err}"}
        try:
            with open(payload_path, "rb") as fh:
                payload = dill.load(fh)
        except Exception as err:  # noqa: BLE001 - a corrupt payload yields an empty restore, not a crash
            return {"error": f"load failed: {_describe(err)}"}
        if not isinstance(payload, dict):
            return {"error": "corrupt snapshot: not a dict"}

        staged: dict[str, Any] = {}
        failed: list[dict[str, str]] = []
        for name, blob in payload.items():
            if name in IPYTHON_ARTIFACT_NAMES:
                continue
            try:
                staged[name] = dill.loads(blob)
            except Exception as err:  # noqa: BLE001 - revive every other name regardless of one failure
                failed.append({"name": name, "reason": f"{type(err).__name__}: {_describe(err)[:200]}"})
        result = {"restored": sorted(staged), "failed": failed}
        previous_handler = signal.signal(signal.SIGINT, lambda *_: None)
        try:
            for name, value in staged.items():
                namespace[name] = value
            if committed is not None:
                committed.append(result)
        finally:
            signal.signal(signal.SIGINT, previous_handler)
        return result

    async def _handle_snapshot_or_restore(self, request: dict[str, Any], namespace: dict[str, Any]) -> None:
        request_id = request["id"]
        committed: list[dict[str, Any]] = []

        async def run() -> dict[str, Any]:
            if request["type"] == "snapshot":
                prune = request.get("prune_oversized", False)
                if not isinstance(prune, bool):
                    return {"error": "prune_oversized must be a boolean"}
                for field in ("max_bytes", "max_variable_bytes"):
                    if field in request and (
                        isinstance(request[field], bool) or not isinstance(request[field], int) or request[field] < 0
                    ):
                        return {"error": f"{field} must be a non-negative integer"}
                if os.path.realpath(request["path"]) == os.path.realpath(request["manifest_path"]):
                    return {"error": "path and manifest_path must differ"}
                return self._snapshot(
                    namespace,
                    request["path"],
                    request["manifest_path"],
                    request.get("max_bytes", DEFAULT_SNAPSHOT_MAX_BYTES),
                    request.get("max_variable_bytes", DEFAULT_SNAPSHOT_MAX_VARIABLE_BYTES),
                    prune,
                    committed,
                )
            return self._restore(namespace, request["path"], committed)

        assert self.loop is not None
        task = self.loop.create_task(run())
        outcome: tuple[str, Any, dict[str, Any] | None] | None = None
        try:
            outcome = await self._supervise(task, request_id)
            self._interrupts.release(request_id)  # no post-run work follows: close the window now
        except KeyboardInterrupt:
            self._interrupts.release(request_id)
            if outcome is None:
                try:
                    outcome = ("ok", task.result(), None)
                except asyncio.CancelledError as exc:
                    frame = _cancelled_frame(request_id, exc) if self._interrupts.was_interrupted() else _error_frame(request_id, exc)
                    outcome = ("error", None, frame)
                except BaseException as exc:  # noqa: BLE001
                    outcome = ("error", None, _error_frame(request_id, exc))
        status, result, error = outcome
        if committed and self._interrupts.was_interrupted() and error is not None and error.get("ename") == "KeyboardInterrupt":
            # A protocol-level interrupt that landed after the commit shouldn't misreport success
            # as failure; a genuine user KeyboardInterrupt (never reaching commit) still does.
            status, result, error = "ok", committed[0], None
        if status != "ok":
            reason = (
                "interrupted"
                if error and error.get("ename") == "KeyboardInterrupt"
                else (f"{error.get('ename')}: {error.get('evalue')}" if error else "failed")
            )
            self.send({"event": "done", "id": request_id, "status": "error", "reason": reason})
            return
        if "error" in result:
            self.send({"event": "done", "id": request_id, "status": "error", "reason": result["error"]})
            return
        self.send({"event": "done", "id": request_id, "status": "ok", **result})

    def _list_names(self, namespace: dict[str, Any]) -> list[str]:
        return sorted(name for name in namespace if isinstance(name, str) and not name.startswith("_") and name not in RESERVED_NAMES)

    async def _handle_list_names(self, request: dict[str, Any], namespace: dict[str, Any]) -> None:
        self.send({"event": "done", "id": request["id"], "status": "ok", "names": self._list_names(namespace)})

    # ── request dispatch ─────────────────────────────────────────────────────────────────────

    async def _dispatch(
        self,
        handler: Callable[[dict[str, Any], dict[str, Any]], Awaitable[None]],
        request: dict[str, Any],
        namespace: dict[str, Any],
    ) -> None:
        """One misbehaving request (e.g. a compiler RecursionError) fails alone, never the loop."""
        try:
            await handler(request, namespace)
        except BaseException as exc:  # noqa: BLE001 - any per-request failure becomes error+done
            request_id = request["id"]
            # Only a request that never reached _supervise() (e.g. a compile failure) can still own
            # a queued interrupt here -- one that did reach it already consumed its own via begin().
            self._interrupts.consume_own_queued_interrupt(request_id)
            self._interrupts.release(request_id)
            self.send(_error_frame(request_id, exc))
            self.send({"event": "done", "id": request_id, "status": "error"})

    async def _serve(self, queue: "asyncio.Queue[dict[str, Any]]", namespace: dict[str, Any]) -> None:
        while True:
            request = await queue.get()
            # A cell (or a restored old handler) may have rebound SIGINT; reclaim it before every
            # request so a mid-cell rebind only ever affects that one cell.
            signal.signal(signal.SIGINT, self._interrupts.handle_sigint)
            kind = request.get("type")
            if kind == "shutdown":
                request_id = request.get("id")
                # No MCP cleanup needed here: nanocode_kernel.mcp never owns a real connection --
                # per decisions/0009-mcp-client-support.md, those live entirely on the TS host's
                # McpClientManager (closed via mcpManager.closeAll() in packages/cli/src/setup.ts),
                # which this process's exit already tears down along with everything else.
                kill_live_handles()
                if isinstance(request_id, str):
                    self.send({"event": "done", "id": request_id, "status": "ok"})
                return
            if kind == "execute":
                await self._dispatch(self._execute_cell, request, namespace)
            elif kind in ("snapshot", "restore"):
                await self._dispatch(self._handle_snapshot_or_restore, request, namespace)
            elif kind == "list_names":
                await self._dispatch(self._handle_list_names, request, namespace)

    # ── request-line parsing ─────────────────────────────────────────────────────────────────

    def _report_protocol_error(self, message: str) -> None:
        self.send({"event": "error", "id": None, "ename": "ProtocolError", "evalue": message, "traceback": []})

    def _parse_request_line(self, raw: bytes, queue: "asyncio.Queue[dict[str, Any]]") -> None:
        assert self.loop is not None
        required_fields = {
            "execute": ("id", "code"),
            "snapshot": ("id", "path", "manifest_path"),
            "restore": ("id", "path"),
            "list_names": ("id",),
            "shutdown": (),
        }
        request = json.loads(raw)
        if not isinstance(request, dict):
            raise ValueError("request is not a JSON object")
        kind = request.get("type")
        if kind == "interrupt":
            if "id" in request and not isinstance(request["id"], str):
                self._report_protocol_error("interrupt request id must be a string")
                return
            self._interrupts.deliver(request.get("id"))
            return
        if kind == "host_reply":
            # Bypasses the FIFO queue: the awaiting cell IS the in-flight execute, so queueing the
            # reply behind it would deadlock.
            request_id = request.get("id")
            data = request.get("data")
            if isinstance(request_id, str) and isinstance(data, dict):
                self._resolve_host_reply(request_id, data)
            else:
                self._report_protocol_error("host_reply request needs string id and dict data")
            return
        if not isinstance(kind, str) or kind not in required_fields:
            self._report_protocol_error(f"unknown request type: {kind!r}")
            return
        missing = [f for f in required_fields[kind] if not isinstance(request.get(f), str)]
        if missing:
            self._report_protocol_error(f"{kind} request needs string fields: {', '.join(missing)}")
            return
        if kind in ("execute", "snapshot", "restore") and not self._interrupts.register(request["id"]):
            self._report_protocol_error(f"duplicate in-flight request id: {request['id']!r}")
            return
        if kind == "shutdown":
            # No reply follows shutdown, so a cell awaiting call_host() must fail now, or _serve()
            # would never get to consume this request.
            self.loop.call_soon_threadsafe(self._abandon_pending_host_calls)
        self.loop.call_soon_threadsafe(queue.put_nowait, request)

    def _read_requests(self, stdin_fd: int, queue: "asyncio.Queue[dict[str, Any]]") -> None:
        assert self.loop is not None
        with os.fdopen(stdin_fd, "rb") as stream:
            for raw in stream:
                raw = raw.strip()
                if not raw:
                    continue
                try:
                    # Wraps the whole line: hostile input (pathological nesting, unhashable field
                    # types) must never kill this thread.
                    self._parse_request_line(raw, queue)
                except BaseException as err:  # noqa: BLE001
                    self._report_protocol_error(f"{type(err).__name__}: {_describe(err)}")
        self.loop.call_soon_threadsafe(self._abandon_pending_host_calls)
        self.loop.call_soon_threadsafe(queue.put_nowait, {"type": "shutdown"})

    # ── process lifecycle ────────────────────────────────────────────────────────────────────

    def _setup_streams(self) -> int:
        """Reserves the original stdout fd for the protocol, then redirects fds 1/2 into pipes."""
        self._protocol_fd = os.dup(1)
        os.set_inheritable(self._protocol_fd, False)
        out_read, out_write = os.pipe()
        err_read, err_write = os.pipe()
        os.dup2(out_write, 1)
        os.dup2(err_write, 2)
        os.close(out_write)
        os.close(err_write)
        sys.stdout = _AttributedTextIO("stdout", self.active_cell, os.dup(1), self.send)
        sys.stderr = _AttributedTextIO("stderr", self.active_cell, os.dup(2), self.send)
        stdin_fd = os.dup(0)
        devnull = os.open(os.devnull, os.O_RDONLY)
        os.dup2(devnull, 0)
        os.close(devnull)
        sys.stdin = open(os.devnull, "r")  # user input() sees EOF rather than protocol frames
        self._stdout_relay = _PipeRelay(out_read, 1, "stdout", self.send)
        self._stderr_relay = _PipeRelay(err_read, 2, "stderr", self.send)
        return stdin_fd

    def run(self) -> None:
        stdin_fd = self._setup_streams()
        _start_owner_watchdog()

        # Alias the running module so `from nanocode_kernel.repl import emit_kernel` inside a
        # cell binds this live instance's module, not a fresh import.
        sys.modules.setdefault("nanocode_kernel.repl", sys.modules[__name__])
        # A real __main__ module makes dill pickle user functions/classes by value, not by reference.
        user_module = types.ModuleType("__main__")
        user_module.__dict__["__builtins__"] = __builtins__
        sys.modules["__main__"] = user_module
        # M2: bind `rlm` so cells can `await rlm.run(prompt)` to recurse. Imported lazily -- rlm.py
        # imports this module lazily too (inside call_host()), so whichever loads first can finish
        # without the other yet existing.
        from . import rlm as rlm_module

        user_module.__dict__["rlm"] = rlm_module.rlm

        # M3: bind the tiered-memory builtins -- `task_state.set(...)` (working memory) and
        # `recall_search`/`recall` (raw-history retrieval). Same lazy-import reasoning as `rlm`.
        from . import recall as recall_module
        from . import task_state as task_state_module

        user_module.__dict__["task_state"] = task_state_module.task_state
        user_module.__dict__["recall_search"] = recall_module.recall_search
        user_module.__dict__["recall"] = recall_module.recall

        # M6: bind `mcp` (list_servers/list_tools/call_tool) plus one dynamically-bound proxy per
        # configured server, named directly (e.g. a server named "github" becomes a top-level
        # `github` object) so cells can write `await github.search_issues(...)` instead of the
        # generic `await mcp.call_tool("github", "search_issues", ...)`. The server name list can't
        # be known statically -- it comes from the host's ~/.nanocode/mcp.json -- so it's passed
        # via an env var at spawn time, the same mechanism NANOCODE_KERNEL_OWNER_PID already uses.
        from . import mcp as mcp_module

        user_module.__dict__["mcp"] = mcp_module
        mcp_servers = [s for s in os.environ.get("NANOCODE_MCP_SERVERS", "").split(",") if s]
        for server_name in mcp_servers:
            user_module.__dict__[server_name] = mcp_module._ServerProxy(server_name)
        RESERVED_NAMES.update(mcp_servers)

        self.loop = asyncio.new_event_loop()
        asyncio.set_event_loop(self.loop)
        queue: asyncio.Queue[dict[str, Any]] = asyncio.Queue()
        signal.signal(signal.SIGINT, self._interrupts.handle_sigint)
        threading.Thread(target=self._read_requests, args=(stdin_fd, queue), daemon=True).start()

        self.send({"event": "ready", "protocol": PROTOCOL_VERSION, "python": platform.python_version()})

        self.serve_task = self.loop.create_task(self._serve(queue, user_module.__dict__))
        # A KeyboardInterrupt escaping a cell or background task unwinds run_until_complete; it's
        # already recorded in our own bookkeeping by the time that happens, so just keep serving.
        while not self.serve_task.done():
            try:
                self.loop.run_until_complete(self.serve_task)
            except KeyboardInterrupt:
                continue
        self.loop.close()


def _resolve_owner_pid() -> int:
    raw = os.environ.get("NANOCODE_KERNEL_OWNER_PID", "")
    try:
        owner = int(raw)
    except ValueError:
        owner = 0
    return owner if owner > 0 else os.getppid()


def _owner_still_alive_posix(owner: int, initial_ppid: int) -> bool:
    # Being reparented (ppid changed) is the race-free signal when the owner is our own parent;
    # the kill-0 probe covers the case where the owner is a different, env-designated process.
    if initial_ppid == owner and os.getppid() != initial_ppid:
        return False
    try:
        os.kill(owner, 0)
    except ProcessLookupError:
        return False
    except OSError:
        pass  # e.g. EPERM: the process exists but we can't probe it -- treat as alive
    return True


def _block_until_owner_exits_windows(owner: int) -> None:
    # os.kill(pid, 0) on Windows actually terminates the target process, so waiting on a
    # SYNCHRONIZE handle is the only correct liveness probe there.
    from ctypes import wintypes

    SYNCHRONIZE = 0x00100000
    INFINITE = 0xFFFFFFFF
    kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)
    kernel32.OpenProcess.argtypes = [wintypes.DWORD, wintypes.BOOL, wintypes.DWORD]
    kernel32.OpenProcess.restype = wintypes.HANDLE
    kernel32.WaitForSingleObject.argtypes = [wintypes.HANDLE, wintypes.DWORD]
    kernel32.WaitForSingleObject.restype = wintypes.DWORD
    kernel32.CloseHandle.argtypes = [wintypes.HANDLE]
    kernel32.CloseHandle.restype = wintypes.BOOL
    handle = kernel32.OpenProcess(SYNCHRONIZE, False, owner)
    if not handle:
        return  # already gone, or unprobeable -- exit rather than run ownerless
    try:
        kernel32.WaitForSingleObject(handle, INFINITE)
    finally:
        kernel32.CloseHandle(handle)


def _watch_owner_and_exit_if_orphaned(owner: int, initial_ppid: int) -> None:
    if os.name == "nt":
        _block_until_owner_exits_windows(owner)
    else:
        while _owner_still_alive_posix(owner, initial_ppid):
            time.sleep(1.0)
    # Deliberately independent of the event loop: a synchronous cell monopolizes the only thread
    # the loop runs on, so the queued EOF-triggered shutdown could never run. Hard-exit instead.
    try:
        kill_live_handles()
    except BaseException:  # noqa: BLE001
        pass
    os._exit(1)


def _start_owner_watchdog() -> None:
    threading.Thread(
        target=_watch_owner_and_exit_if_orphaned,
        args=(_resolve_owner_pid(), os.getppid()),
        daemon=True,
    ).start()


_kernel: Kernel | None = None


def emit(data: dict[str, Any]) -> None:
    """Public API for executed code: `from nanocode_kernel.repl import emit`."""
    if _kernel is None:
        raise RuntimeError("kernel is not serving")
    _kernel.emit_display(data)


async def host_request(data: dict[str, Any]) -> dict[str, Any]:
    """Public API for executed code (used by rlm.py's call_host wrapper)."""
    if _kernel is None:
        raise RuntimeError("kernel is not serving")
    return await _kernel.call_host(data)


def is_active() -> bool:
    return _kernel is not None and _kernel.is_serving()


def main() -> None:
    global _kernel
    _kernel = Kernel()
    _kernel.run()


if __name__ == "__main__":
    main()
