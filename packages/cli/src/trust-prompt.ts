// The CLI-layer half of project trust: @nanocode/agent's TrustStore is UI-agnostic (just a
// decision store); this module is where the actual terminal interaction lives, since a TUI (M5)
// will need a different (non-readline) prompt implementation against the same TrustStore.
import { createInterface } from "node:readline/promises";
import type { TrustStore } from "@nanocode/agent";

/** Thrown when a directory is (or becomes) untrusted. The caller must not start a kernel or run
 * any code when this is thrown -- see decisions/0008-project-trust-sandbox-telemetry.md. */
export class TrustDeniedError extends Error {
  constructor(
    public readonly dirPath: string,
    reason?: string,
  ) {
    super(
      reason
        ? `nanocode is not trusted to run in ${dirPath}: ${reason}`
        : `nanocode is not trusted to run in ${dirPath}`,
    );
    this.name = "TrustDeniedError";
  }
}

const VALID_OVERRIDES = new Set(["always", "once", "never"]);

/**
 * Resolves whether `dirPath` is trusted, prompting interactively over stdin/stdout if it's never
 * been decided. Throws `TrustDeniedError` -- never returns a boolean -- so a caller can't
 * accidentally continue past a declined directory by forgetting to check a return value.
 *
 * `NANOCODE_TRUST=always|once|never` resolves the decision without prompting -- checked before the
 * interactive path, and required for any non-interactive invocation: `readline`'s `question()`
 * never resolves or rejects on stdin EOF (piped input, `< /dev/null`, most CI runners), so prompting
 * against a non-TTY stdin would hang forever with no way out. Rather than let that happen, a
 * closed/non-interactive stdin without an override set fails fast with a clear, actionable error.
 */
export async function ensureTrust(
  store: TrustStore,
  dirPath: string,
  env: NodeJS.ProcessEnv = process.env,
  isInteractive: () => boolean = () => Boolean(process.stdin.isTTY),
): Promise<void> {
  const existing = await store.get(dirPath);
  if (existing === "trusted") return;
  if (existing === "untrusted") throw new TrustDeniedError(dirPath);

  const override = env.NANOCODE_TRUST;
  if (override && VALID_OVERRIDES.has(override)) {
    if (override === "always") return store.setPersistent(dirPath, "trusted");
    if (override === "once") return store.setSessionOnly(dirPath, "trusted");
    await store.setSessionOnly(dirPath, "untrusted");
    throw new TrustDeniedError(dirPath, "NANOCODE_TRUST=never");
  }

  if (!isInteractive()) {
    throw new TrustDeniedError(
      dirPath,
      "stdin is not interactive and no NANOCODE_TRUST override is set -- run interactively once " +
        "to decide, or set NANOCODE_TRUST=always|once|never",
    );
  }

  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    console.log(`nanocode has not been run in ${dirPath} before.`);
    console.log(
      "Its only tool is an unrestricted Python REPL -- code it writes runs with your full " +
        "user permissions in this directory.",
    );
    for (;;) {
      const raw = await rl.question(
        "Trust this directory? [a]lways / [o]nce (this session only) / [n]o: ",
      );
      const answer = raw.trim().toLowerCase();
      if (answer === "a" || answer === "always") {
        await store.setPersistent(dirPath, "trusted");
        return;
      }
      if (answer === "o" || answer === "once") {
        await store.setSessionOnly(dirPath, "trusted");
        return;
      }
      if (answer === "n" || answer === "no") {
        await store.setSessionOnly(dirPath, "untrusted");
        throw new TrustDeniedError(dirPath);
      }
      console.log('Please answer "a", "o", or "n".');
    }
  } finally {
    rl.close();
  }
}
