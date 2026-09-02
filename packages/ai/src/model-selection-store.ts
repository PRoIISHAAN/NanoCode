// Persists the provider+model the user picked through the TUI's onboarding flow
// (decisions/0011-tui-onboarding.md's saveApiKey persists the *credential*; this persists the
// *selection* itself) -- without this, a later run with no NANOCODE_PROVIDER/NANOCODE_MODEL env
// vars set had no way to know which already-configured provider/model to use, and re-triggered
// onboarding from scratch every single time even though a working credential already existed.
// Sibling to credential-store.ts's FileCredentialStore in shape and location: same
// homedir()-based ~/.nanocode/*.json convention, same ENOENT-is-"nothing yet" read semantics.
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

export interface StoredModelSelection {
  provider: string;
  model: string;
}

const DEFAULT_MODEL_SELECTION_FILE = join(homedir(), ".nanocode", "model-selection.json");

/** Resolves undefined if nothing has ever been saved. Throws (rather than silently ignoring) if
 * the file exists but isn't a valid {provider, model} object -- matching this project's standing
 * convention (trust.json/mcp.json/credentials.json) of failing loudly on real corruption instead
 * of masking it as "unconfigured." */
export async function readStoredModelSelection(
  filePath: string = DEFAULT_MODEL_SELECTION_FILE,
): Promise<StoredModelSelection | undefined> {
  let raw: string;
  try {
    raw = await readFile(filePath, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
  const parsed = JSON.parse(raw) as unknown;
  const record = parsed as Record<string, unknown>;
  if (
    parsed &&
    typeof parsed === "object" &&
    typeof record.provider === "string" &&
    typeof record.model === "string"
  ) {
    return { provider: record.provider, model: record.model };
  }
  throw new Error(`${filePath} does not contain a valid {provider, model} selection`);
}

export async function writeStoredModelSelection(
  selection: StoredModelSelection,
  filePath: string = DEFAULT_MODEL_SELECTION_FILE,
): Promise<void> {
  await mkdir(dirname(filePath), { recursive: true });
  await writeFile(filePath, `${JSON.stringify(selection, null, 2)}\n`, "utf8");
}
