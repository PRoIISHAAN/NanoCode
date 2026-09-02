// TypeScript client for the persistent Python kernel: spawns `python -m nanocode_kernel.repl`,
// writes newline-delimited JSON requests to its stdin, and parses newline-delimited JSON events
// off its stdout.
//
// Scope note: a production kernel client like this could also do protocol self-repair (replacing
// a kernel whose stream emitted a corrupt frame), debounced auto-snapshotting, an orphan-process
// journal, and busy/interrupt escalation when a new call arrives mid-execution -- prime-agent's
// equivalent client does all of that. None of it is built here yet: this class covers what's
// actually needed so far -- start the kernel, run one cell at a time to completion, dispatch
// host_request callbacks to registered handlers (the rlm.run recursion bridge), and shut down
// cleanly. The rest has a natural home in a later milestone (protocol repair and snapshotting
// fit naturally alongside M3's session persistence work).
import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

// `python -m nanocode_kernel.repl` needs `nanocode_kernel` importable. Since it isn't pip-installed
// anywhere, PYTHONPATH is pointed at the directory containing the package -- resolved from this
// file's own location so it works no matter what the caller's process cwd is.
const KERNEL_PACKAGE_ROOT = path.resolve(fileURLToPath(new URL("../python", import.meta.url)));

const SUPPORTED_PROTOCOL_VERSION = 3;
const HANDSHAKE_TIMEOUT_MS = 30_000;
const DEFAULT_OUTPUT_CHAR_LIMIT = 200_000;

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function makeDeferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (error: Error) => void;
} {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/**
 * Answers one `host_request` type (e.g. "rlm.run") raised by executed Python via
 * `nanocode_kernel.rlm`'s host bridge. Return the raw success value -- it's wrapped into
 * `{status: "ok", result}` automatically -- or throw, which becomes `{status: "error", error}`.
 */
export type HostRequestHandler = (data: Record<string, unknown>) => Promise<unknown>;

/** "plain" runs the interpreter directly on the host (the default); "docker" runs it inside a
 * container instead -- see `buildSpawnCommand` and decisions/0008-project-trust-sandbox-telemetry.md. */
export type SandboxMode = "plain" | "docker";

export interface KernelManagerOptions {
  /** Path to a Python 3.11+ interpreter. Defaults to $NANOCODE_KERNEL_PYTHON, then "python3".
   * Ignored when `sandbox` is "docker" -- the container's own `python3` is used instead. */
  python?: string;
  cwd?: string;
  env?: Record<string, string>;
  /** Keyed by host_request "type". A request for an unregistered type replies with an error. */
  hostHandlers?: Record<string, HostRequestHandler>;
  /** Defaults to $NANOCODE_SANDBOX, then "plain". */
  sandbox?: SandboxMode;
  /** Docker image to run the kernel inside when `sandbox` is "docker". Defaults to
   * $NANOCODE_SANDBOX_IMAGE, then "nanocode-kernel:latest" -- build it from
   * packages/kernel/docker/Dockerfile first. */
  dockerImage?: string;
}

export interface KernelSpawnCommand {
  command: string;
  args: string[];
  env: NodeJS.ProcessEnv;
}

/**
 * Builds the command/args/env to spawn for one kernel process. A standalone pure function (not a
 * class method) so the two sandbox modes' exact spawn shape can be asserted directly in tests
 * without starting a subprocess.
 *
 * "docker" mode bind-mounts the kernel package's own Python source read-only rather than baking it
 * into the image, so the sandbox image only ever needs Python 3.11+ and `dill` -- it never needs
 * rebuilding when kernel source changes. Known limitation: the Python-side owner watchdog
 * (`NANOCODE_KERNEL_OWNER_PID`, checked via `os.getppid()`) can't see across the container's PID
 * namespace boundary, so it's a no-op in this mode; cleanup instead relies on Node's own
 * child-process teardown reaching the `docker run` process on every normal shutdown path.
 */
export function buildSpawnCommand(options: KernelManagerOptions): KernelSpawnCommand {
  const sandbox =
    options.sandbox ?? (process.env.NANOCODE_SANDBOX as SandboxMode | undefined) ?? "plain";
  const baseEnv = { ...process.env, ...options.env };

  if (sandbox === "docker") {
    const image =
      options.dockerImage ?? process.env.NANOCODE_SANDBOX_IMAGE ?? "nanocode-kernel:latest";
    const cwd = options.cwd ?? process.cwd();
    return {
      command: "docker",
      args: [
        "run",
        "-i",
        "--rm",
        "-v",
        `${KERNEL_PACKAGE_ROOT}:/nanocode_kernel_src:ro`,
        "-v",
        `${cwd}:/workspace`,
        "-w",
        "/workspace",
        "-e",
        "PYTHONPATH=/nanocode_kernel_src",
        image,
        "python3",
        "-m",
        "nanocode_kernel.repl",
      ],
      env: baseEnv,
    };
  }

  const interpreter = options.python ?? process.env.NANOCODE_KERNEL_PYTHON ?? "python3";
  return {
    command: interpreter,
    args: ["-m", "nanocode_kernel.repl"],
    env: {
      ...baseEnv,
      PYTHONPATH: [KERNEL_PACKAGE_ROOT, options.env?.PYTHONPATH, process.env.PYTHONPATH]
        .filter((part): part is string => Boolean(part))
        .join(path.delimiter),
      // Read by the kernel's owner watchdog: if this Node process dies without a clean shutdown,
      // the kernel notices its owner is gone and exits itself rather than running ownerless
      // forever.
      NANOCODE_KERNEL_OWNER_PID: String(process.pid),
    },
  };
}

export interface KernelStartOptions {
  signal?: AbortSignal;
}

export interface ExecuteOptions {
  signal?: AbortSignal;
  maxOutputChars?: number;
}

export interface ExecuteError {
  ename: string;
  evalue: string;
  traceback: string[];
}

export interface ExecuteResult {
  status: "ok" | "error" | "aborted";
  stdout: string;
  stderr: string;
  stdoutTruncated: boolean;
  stderrTruncated: boolean;
  /** repr() of the cell's trailing expression, when it had one and its value wasn't None. */
  result?: string;
  error?: ExecuteError;
  durationMs: number;
}

type KernelPhase = "idle" | "starting" | "running" | "stopped";

/** Bookkeeping for the one `execute` request currently in flight, keyed by its request id. */
interface PendingExecution {
  requestId: string;
  charLimit: number;
  startedAt: number;
  stdout: string;
  stderr: string;
  stdoutTruncated: boolean;
  stderrTruncated: boolean;
  result?: string;
  error?: ExecuteError;
  status: ExecuteResult["status"];
  settle: (result: ExecuteResult) => void;
  fail: (error: Error) => void;
}

export class ReplKernelManager {
  private readonly options: KernelManagerOptions;
  private child?: ChildProcessWithoutNullStreams;
  private handshake?: ReturnType<typeof makeDeferred<number>>;
  private stderrLog = "";
  private phase: KernelPhase = "idle";
  /** Serializes execute() calls -- the kernel itself only ever runs one request at a time. */
  private executionChain: Promise<unknown> = Promise.resolve();
  private pending?: PendingExecution;
  /**
   * Memoizes the in-flight spawn so concurrent callers (e.g. two execute() calls racing on a
   * cold kernel) all await the same startup instead of each attempting their own spawn -- a
   * second caller would otherwise observe phase "starting" and reject outright. Cleared once the
   * spawn settles, so a start() issued after a later shutdown begins a genuinely fresh spawn.
   */
  private spawning?: Promise<void>;

  constructor(options: KernelManagerOptions = {}) {
    this.options = options;
  }

  private logDiagnostic(message: string): void {
    this.stderrLog += `[kernel] ${message.endsWith("\n") ? message : `${message}\n`}`;
  }

  /** Spawns the subprocess and waits for its `ready` handshake. A no-op once already running. */
  async start(startOptions: KernelStartOptions = {}): Promise<void> {
    if (startOptions.signal?.aborted) {
      throw new Error("kernel start aborted before it began");
    }
    if (this.phase === "running") return;
    if (!this.spawning) {
      if (this.phase !== "idle") {
        throw new Error(`cannot start kernel from phase "${this.phase}"`);
      }
      const attempt = this.spawnAndAwaitHandshake().finally(() => {
        if (this.spawning === attempt) this.spawning = undefined;
      });
      this.spawning = attempt;
    }
    return this.spawning;
  }

  private async spawnAndAwaitHandshake(): Promise<void> {
    this.phase = "starting";

    const { command, args, env } = buildSpawnCommand(this.options);
    const child = spawn(command, args, {
      cwd: this.options.cwd,
      env,
      stdio: ["pipe", "pipe", "pipe"],
    });
    this.child = child;
    this.handshake = makeDeferred<number>();
    this.attachChildListeners(child);

    try {
      const protocolVersion = await this.awaitHandshake(child);
      if (protocolVersion !== SUPPORTED_PROTOCOL_VERSION) {
        throw new Error(
          `kernel speaks protocol ${protocolVersion}, expected ${SUPPORTED_PROTOCOL_VERSION} -- ` +
            "the Python kernel package and this TypeScript client have drifted out of sync",
        );
      }
    } catch (error) {
      this.releaseChild();
      this.phase = "idle";
      throw error;
    }

    this.phase = "running";
  }

  /** Buffers stdout into lines, parses each as JSON, and routes it to onProtocolEvent. */
  private attachChildListeners(child: ChildProcessWithoutNullStreams): void {
    let carry = "";
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      carry += chunk;
      let breakAt = carry.indexOf("\n");
      while (breakAt !== -1) {
        const line = carry.slice(0, breakAt);
        carry = carry.slice(breakAt + 1);
        breakAt = carry.indexOf("\n");
        if (!line.trim()) continue;
        let parsed: unknown;
        try {
          parsed = JSON.parse(line);
        } catch {
          this.logDiagnostic(`unparseable protocol line: ${line.slice(0, 200)}`);
          continue;
        }
        if (!isPlainObject(parsed)) {
          this.logDiagnostic(`non-object protocol line: ${line.slice(0, 200)}`);
          continue;
        }
        this.onProtocolEvent(parsed);
      }
    });

    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => {
      this.stderrLog += chunk;
    });

    child.on("error", (err) => {
      if (this.child !== child) return;
      this.logDiagnostic(`spawn error: ${err.message}`);
      this.phase = "stopped";
      this.handshake?.reject(err);
      this.failPending(err);
    });

    child.on("exit", (code, signal) => {
      if (this.child !== child) return;
      if (this.phase !== "stopped") {
        const err = new Error(`kernel exited unexpectedly: code=${code} signal=${signal}`);
        this.logDiagnostic(err.message);
        this.handshake?.reject(err);
        this.failPending(err);
      }
      this.phase = "stopped";
    });
  }

  private async awaitHandshake(child: ChildProcessWithoutNullStreams): Promise<number> {
    const handshake = this.handshake;
    if (!handshake) throw new Error("handshake state is missing");
    let timer: ReturnType<typeof globalThis.setTimeout> | undefined;
    let onExit: (() => void) | undefined;
    try {
      return await new Promise<number>((resolve, reject) => {
        handshake.promise.then(resolve, reject);
        onExit = () => {
          reject(
            new Error(
              `kernel exited before handshake. stderr:\n${this.stderrLog.slice(-1024) || "(empty)"}`,
            ),
          );
        };
        child.once("exit", onExit);
        timer = globalThis.setTimeout(() => {
          reject(
            new Error(
              `kernel did not complete its handshake within ${HANDSHAKE_TIMEOUT_MS}ms. stderr tail:\n${
                this.stderrLog.slice(-1024) || "(empty)"
              }`,
            ),
          );
        }, HANDSHAKE_TIMEOUT_MS);
        timer.unref?.();
      });
    } finally {
      if (timer) globalThis.clearTimeout(timer);
      if (onExit) child.removeListener("exit", onExit);
    }
  }

  private sendRequest(request: Record<string, unknown>): Promise<void> {
    const stdin = this.child?.stdin;
    if (!stdin || stdin.destroyed) {
      return Promise.reject(new Error("kernel stdin is not connected"));
    }
    return new Promise<void>((resolve, reject) => {
      stdin.write(`${JSON.stringify(request)}\n`, (error) => {
        if (error) reject(error);
        else resolve();
      });
    });
  }

  private onProtocolEvent(event: Record<string, unknown>): void {
    const kind = event.event;
    if (kind === "ready") {
      this.handshake?.resolve(typeof event.protocol === "number" ? event.protocol : -1);
      return;
    }

    if (kind === "host_request") {
      // The cell that raised this is awaiting exactly this id, so a reply must go out even if
      // dispatch itself fails below -- an unanswered host_request hangs that cell (and,
      // transitively, whatever tool call is awaiting it) forever.
      const requestId = typeof event.id === "string" ? event.id : undefined;
      if (requestId) this.dispatchHostRequest(requestId, event.data);
      return;
    }

    const eventId = typeof event.id === "string" ? event.id : undefined;
    const current = this.pending;
    if (!current || eventId !== current.requestId) {
      // Unattributed output with no matching in-flight execution: a background task from a
      // *previous* cell is still writing after that cell's `done` was already sent. There's
      // nowhere to route this yet, so it's dropped (with a diagnostic) rather than silently
      // discarded -- a later milestone that needs it (live tool-output streaming to a TUI) has an
      // explicit signal to build on.
      if (kind === "error" && eventId === undefined) {
        this.logDiagnostic(`protocol-level error: ${String(event.evalue ?? "")}`);
      }
      return;
    }

    switch (kind) {
      case "stdout":
      case "stderr": {
        const text = typeof event.text === "string" ? event.text : "";
        const field = kind === "stdout" ? "stdout" : "stderr";
        const truncatedField = kind === "stdout" ? "stdoutTruncated" : "stderrTruncated";
        if (current[field].length < current.charLimit) {
          current[field] += text;
          if (current[field].length > current.charLimit) {
            current[field] = current[field].slice(0, current.charLimit);
            current[truncatedField] = true;
          }
        }
        break;
      }
      case "result":
        if (typeof event.text === "string") current.result = event.text;
        break;
      case "error":
        current.error = {
          ename: typeof event.ename === "string" ? event.ename : "Error",
          evalue: typeof event.evalue === "string" ? event.evalue : "",
          traceback: Array.isArray(event.traceback)
            ? event.traceback.filter((t): t is string => typeof t === "string")
            : [],
        };
        current.status = "error";
        break;
      case "done":
        this.settlePending(current);
        break;
    }
  }

  /** Runs the registered handler for one host_request and always sends back a reply. */
  private dispatchHostRequest(requestId: string, data: unknown): void {
    void this.invokeHostHandler(data)
      .then((result) =>
        this.sendRequest({ type: "host_reply", id: requestId, data: { status: "ok", result } }),
      )
      .catch((error) =>
        this.sendRequest({
          type: "host_reply",
          id: requestId,
          data: { status: "error", error: describeError(error) },
        }),
      )
      .catch((sendError) => {
        // The reply itself couldn't be sent (e.g. stdin already closed) -- nothing more to do;
        // the awaiting cell hangs until the session is torn down. Logged so it's at least
        // visible rather than silently swallowed.
        this.logDiagnostic(
          `could not deliver host_reply for ${requestId}: ${describeError(sendError)}`,
        );
      });
  }

  private async invokeHostHandler(data: unknown): Promise<unknown> {
    if (!isPlainObject(data) || typeof data.type !== "string" || data.type.length === 0) {
      throw new Error("host request payload must be an object with a non-empty string type");
    }
    const handler = this.options.hostHandlers?.[data.type];
    if (!handler) {
      throw new Error(`host request type "${data.type}" has no registered handler in this session`);
    }
    return handler(data);
  }

  private settlePending(execution: PendingExecution): void {
    this.pending = undefined;
    execution.settle({
      status: execution.status,
      stdout: execution.stdout,
      stderr: execution.stderr,
      stdoutTruncated: execution.stdoutTruncated,
      stderrTruncated: execution.stderrTruncated,
      result: execution.result,
      error: execution.error,
      durationMs: Date.now() - execution.startedAt,
    });
  }

  private failPending(error: Error): void {
    const execution = this.pending;
    if (!execution) return;
    this.pending = undefined;
    execution.fail(error);
  }

  /** Runs one cell to completion. Overlapping calls queue: a later one waits for the earlier `done`. */
  async execute(code: string, opts: ExecuteOptions = {}): Promise<ExecuteResult> {
    if (opts.signal?.aborted) {
      return {
        status: "aborted",
        stdout: "",
        stderr: "",
        stdoutTruncated: false,
        stderrTruncated: false,
        durationMs: 0,
      };
    }
    await this.start({ signal: opts.signal });

    const previousTurn = this.executionChain;
    let releaseNextTurn: () => void = () => {};
    this.executionChain = new Promise<void>((resolve) => {
      releaseNextTurn = resolve;
    });
    await previousTurn;
    try {
      return await this.sendExecuteAndAwaitDone(code, opts);
    } finally {
      releaseNextTurn();
    }
  }

  private async sendExecuteAndAwaitDone(
    code: string,
    opts: ExecuteOptions,
  ): Promise<ExecuteResult> {
    if (this.phase !== "running") {
      throw new Error(`cannot execute: kernel is "${this.phase}"`);
    }
    const requestId = crypto.randomUUID();
    const deferred = makeDeferred<ExecuteResult>();
    this.pending = {
      requestId,
      charLimit: opts.maxOutputChars ?? DEFAULT_OUTPUT_CHAR_LIMIT,
      startedAt: Date.now(),
      stdout: "",
      stderr: "",
      stdoutTruncated: false,
      stderrTruncated: false,
      status: "ok",
      settle: deferred.resolve,
      fail: deferred.reject,
    };
    await this.sendRequest({ type: "execute", id: requestId, code });
    return deferred.promise;
  }

  /**
   * Requests that the kernel interrupt a running (or about-to-run) cell. With no id, targets
   * whichever execute() is currently in flight; the kernel never replies to this request type, so
   * the effect shows up as the targeted execute()'s own result (status "error", ename
   * "KeyboardInterrupt") rather than through this method's return value.
   */
  interrupt(requestId?: string): Promise<void> {
    return this.sendRequest(
      requestId ? { type: "interrupt", id: requestId } : { type: "interrupt" },
    );
  }

  /** Requests a graceful shutdown; force-kills the process if it doesn't exit within the grace period. */
  async shutdown(gracePeriodMs = 5_000): Promise<void> {
    const child = this.child;
    if (!child || this.phase === "stopped") {
      this.phase = "stopped";
      return;
    }
    this.phase = "stopped";
    const exited = new Promise<void>((resolve) => child.once("exit", () => resolve()));
    try {
      await this.sendRequest({ type: "shutdown", id: crypto.randomUUID() });
    } catch {
      // stdin is already gone -- fall through to the force-kill path below.
    }
    const timedOut = new Promise<"timed-out">((resolve) => {
      const timer = globalThis.setTimeout(() => resolve("timed-out"), gracePeriodMs);
      timer.unref?.();
    });
    const outcome = await Promise.race([exited.then(() => "exited" as const), timedOut]);
    if (outcome === "timed-out") {
      child.kill("SIGKILL");
      await exited;
    }
    this.releaseChild();
  }

  private releaseChild(): void {
    const child = this.child;
    this.child = undefined;
    this.handshake = undefined;
    this.failPending(new Error("kernel has been shut down"));
    if (child) {
      child.stdin?.destroy();
      child.stdout?.destroy();
      child.stderr?.destroy();
      try {
        child.kill("SIGKILL");
      } catch {
        // Already exited.
      }
    }
  }

  get diagnostics(): string {
    return this.stderrLog;
  }
}
