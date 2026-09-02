// Project trust: nanocode's only tool is an unrestricted Python REPL, so -- unlike pi, which only
// gates loading untrusted project-local extension config and lets its safe-by-default read/write/
// edit tools run regardless -- nanocode must gate *any* code execution in a directory it hasn't
// been told to trust yet. See decisions-manifest.md's "Project trust prompt" row and
// decisions/0008-project-trust-sandbox-telemetry.md.
import { mkdir, readFile, realpath, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

export type TrustDecision = "trusted" | "untrusted";

const DEFAULT_TRUST_FILE = join(homedir(), ".nanocode", "trust.json");

/** Canonicalizes a directory path (resolves symlinks, makes it absolute) so the same real
 * directory always looks up to the same trust entry regardless of how it was reached. */
async function canonicalize(dirPath: string): Promise<string> {
  return realpath(dirPath);
}

async function readTrustFile(filePath: string): Promise<Record<string, TrustDecision>> {
  try {
    const raw = await readFile(filePath, "utf8");
    const parsed = JSON.parse(raw) as unknown;
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as Record<string, TrustDecision>;
    }
    return {};
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return {};
    throw error;
  }
}

/**
 * Holds trust decisions for directories nanocode has been run in. Exact-path keyed only -- no
 * parent-directory inheritance (pi's "trust parent folder" nuance was deliberately dropped for
 * nanocode's simpler 3-option prompt; see the design decision this file implements). A
 * "session only" decision never touches disk: it's held purely in `sessionOverrides` and is gone
 * once this `TrustStore` instance (one per process) goes away.
 */
export class TrustStore {
  private readonly sessionOverrides = new Map<string, TrustDecision>();

  private constructor(
    private readonly filePath: string,
    private persisted: Record<string, TrustDecision>,
  ) {}

  static async open(filePath: string = DEFAULT_TRUST_FILE): Promise<TrustStore> {
    return new TrustStore(filePath, await readTrustFile(filePath));
  }

  /** Undefined means "never decided" -- the caller must prompt. */
  async get(dirPath: string): Promise<TrustDecision | undefined> {
    const canonical = await canonicalize(dirPath);
    return this.sessionOverrides.get(canonical) ?? this.persisted[canonical];
  }

  /**
   * Persists the decision to disk -- it will apply to every future run in this directory.
   *
   * Re-reads the file from disk immediately before merging, rather than trusting the copy cached
   * at `open()` time, so two nanocode invocations trusting *different* directories concurrently
   * don't clobber each other with a stale snapshot from whenever each one started. This narrows
   * the race to the read-then-write gap within this one method rather than the whole process's
   * lifetime -- not a full fix (no file lock, unlike pi's `trust-manager.ts`, which uses
   * `proper-lockfile` for exactly this): two invocations racing to trust *different* directories
   * within that narrow window can still drop one write. Accepted as a known gap for a single-user
   * local CLI where concurrent invocations are rare, rather than adding a locking dependency for it.
   */
  async setPersistent(dirPath: string, decision: TrustDecision): Promise<void> {
    const canonical = await canonicalize(dirPath);
    const onDisk = await readTrustFile(this.filePath);
    this.persisted = { ...onDisk, [canonical]: decision };
    this.sessionOverrides.delete(canonical);
    await mkdir(dirname(this.filePath), { recursive: true });
    await writeFile(this.filePath, `${JSON.stringify(this.persisted, null, 2)}\n`, "utf8");
  }

  /** Holds the decision only for this process's lifetime -- never written to disk. */
  async setSessionOnly(dirPath: string, decision: TrustDecision): Promise<void> {
    const canonical = await canonicalize(dirPath);
    this.sessionOverrides.set(canonical, decision);
  }
}
