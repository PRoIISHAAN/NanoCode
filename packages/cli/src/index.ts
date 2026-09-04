#!/usr/bin/env node
// The ONE real entrypoint for the `nanocode` binary, in both dev (`tsx src/index.ts`) and the
// bundled global install (`scripts/build.mjs` -> packages/cli/dist/cli.js, symlinked onto PATH by
// install.sh) -- bare `nanocode` launches the interactive TUI (tui.tsx's `runTui`), matching how
// prime/Claude Code's own CLIs behave; `nanocode run "<prompt>"` stays the original headless,
// single-shot path that proved the core loop (M1), RLM recursion (M2), tiered memory (M3), and
// project trust/sandbox/telemetry (M4) all share the same setup path (setup.ts), per PLAN.md's M1
// demo command: `npm run cli -- run "compute 17*23 in python and print it"` -> `391`.
//
// tui.tsx exports `runTui` rather than running itself -- see its own header comment for why a
// bundle specifically rules out each file self-detecting whether it's "the" entrypoint.
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { ModelConfigurationError } from "@nanocode/ai";
import { createNanocodeSession } from "./setup.ts";
import { TrustDeniedError } from "./trust-prompt.ts";
import { runTui } from "./tui.tsx";

function printUsageAndExit(): never {
  console.error("Usage: nanocode             (launch the interactive TUI)");
  console.error('       nanocode run "<prompt>"   (run one prompt headlessly)');
  process.exit(1);
}

async function run(prompt: string): Promise<void> {
  const { session, cleanup } = await createNanocodeSession();

  try {
    await session.prompt(prompt);
  } finally {
    await cleanup();
  }

  const lastMessage = session.state.messages.at(-1);
  if (lastMessage?.role === "assistant") {
    const text = lastMessage.content
      .filter((c): c is Extract<typeof c, { type: "text" }> => c.type === "text")
      .map((c) => c.text)
      .join("");
    if (text) console.log(text);
    if (lastMessage.stopReason === "error" || lastMessage.stopReason === "aborted") {
      console.error(
        lastMessage.errorMessage ?? `Run ended with stopReason "${lastMessage.stopReason}"`,
      );
      process.exitCode = 1;
    }
  }
}

// Exported (rather than only self-invoked below) so a test can call this directly with a
// controlled process.argv and mocked runTui/createNanocodeSession, instead of exercising the real
// TUI/kernel/session stack end to end.
export async function main(): Promise<void> {
  const [command, ...rest] = process.argv.slice(2);
  if (command === undefined) {
    await runTui();
    return;
  }
  if (command !== "run" || rest.length === 0) {
    printUsageAndExit();
  }
  await run(rest.join(" "));
}

// Only self-invoke when this module is actually the process entrypoint (`tsx src/index.ts`, or
// the bundled `dist/cli.js` run as the `nanocode` binary) -- not when it's merely imported as a
// module, e.g. by a test importing `main` to call it directly with a controlled process.argv.
//
// `realpathSync` on BOTH sides, not a plain `pathToFileURL(process.argv[1]).href ===
// import.meta.url` comparison -- a real, live-caught bug: install.sh's whole point is running this
// file through a symlink (`~/.local/bin/nanocode` -> packages/cli/dist/cli.js), and
// `process.argv[1]` is exactly the (symlink) path the user invoked, unresolved, while
// `import.meta.url` reflects the file Node actually loaded after following it -- comparing them
// directly silently failed this check for every symlinked invocation, so `main()` never ran at
// all: no output, no error, exit code 0. Resolving both to their real, canonical filesystem path
// first makes the comparison correct regardless of how many symlinks either side goes through.
function isMainModule(): boolean {
  if (!process.argv[1]) return false;
  try {
    return realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (isMainModule()) {
  main().catch((error) => {
    if (error instanceof TrustDeniedError) {
      console.error(`Not trusted: ${error.dirPath}. Nothing was executed.`);
      process.exitCode = 1;
      return;
    }
    if (error instanceof ModelConfigurationError) {
      console.error(error.message);
      process.exitCode = 1;
      return;
    }
    console.error(error instanceof Error ? (error.stack ?? error.message) : String(error));
    process.exitCode = 1;
  });
}
