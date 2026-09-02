// nanocode's own on-disk implementation of pi-ai's CredentialStore interface. Without one,
// createModelsRegistry() defaults to pi-ai's own in-memory-only store -- which is exactly why an
// interactively-entered API key never survived past the current process before this. See
// decisions/0011-tui-onboarding.md.
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { Credential, CredentialInfo, CredentialStore } from "@earendil-works/pi-ai";

const DEFAULT_CREDENTIALS_FILE = join(homedir(), ".nanocode", "credentials.json");

async function readCredentialsFile(filePath: string): Promise<Record<string, Credential>> {
  try {
    const raw = await readFile(filePath, "utf8");
    const parsed = JSON.parse(raw) as unknown;
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as Record<string, Credential>;
    }
    return {};
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return {};
    throw error;
  }
}

async function writeCredentialsFile(
  filePath: string,
  all: Record<string, Credential>,
): Promise<void> {
  await mkdir(dirname(filePath), { recursive: true });
  // mode: 0o600 -- unlike trust.json/mcp.json, every entry here is a raw secret.
  await writeFile(filePath, `${JSON.stringify(all, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
}

/**
 * Always re-reads from disk rather than caching an in-memory copy -- this file is small, reads are
 * cheap, and a cache would risk serving a stale credential after an external edit or a concurrent
 * nanocode process's write. `modify()` re-reads immediately before merging (same "narrow the race,
 * don't eliminate it" tradeoff as TrustStore.setPersistent -- see decisions/0011-tui-onboarding.md
 * and decisions/0008-project-trust-sandbox-telemetry.md): no cross-process file lock, accepted for
 * a single-user local CLI.
 */
export class FileCredentialStore implements CredentialStore {
  constructor(private readonly filePath: string = DEFAULT_CREDENTIALS_FILE) {}

  async read(providerId: string): Promise<Credential | undefined> {
    const all = await readCredentialsFile(this.filePath);
    return all[providerId];
  }

  async list(): Promise<readonly CredentialInfo[]> {
    const all = await readCredentialsFile(this.filePath);
    return Object.entries(all).map(([providerId, credential]) => ({
      providerId,
      type: credential.type,
    }));
  }

  async modify(
    providerId: string,
    fn: (current: Credential | undefined) => Promise<Credential | undefined>,
  ): Promise<Credential | undefined> {
    const all = await readCredentialsFile(this.filePath);
    const current = all[providerId];
    const next = await fn(current);
    // undefined means "leave unchanged" per CredentialStore's contract -- nothing to write.
    if (next === undefined) return current;
    all[providerId] = next;
    await writeCredentialsFile(this.filePath, all);
    return next;
  }

  async delete(providerId: string): Promise<void> {
    const all = await readCredentialsFile(this.filePath);
    if (!(providerId in all)) return;
    delete all[providerId];
    await writeCredentialsFile(this.filePath, all);
  }
}
