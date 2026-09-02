#!/usr/bin/env node
// nanocode's headless, single-shot "run one prompt" CLI. Proves the core loop (M1), RLM recursion
// (M2), tiered memory (M3), project trust/sandbox/telemetry (M4), and the interactive TUI (M5, see
// tui.tsx) all share the same setup path (setup.ts), per PLAN.md's M1 demo command:
// `npm run cli -- run "compute 17*23 in python and print it"` -> `391`.
import { ModelConfigurationError } from "@nanocode/ai";
import { createNanocodeSession } from "./setup.ts";
import { TrustDeniedError } from "./trust-prompt.ts";

function printUsageAndExit(): never {
  console.error('Usage: nanocode run "<prompt>"');
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

async function main(): Promise<void> {
  const [command, ...rest] = process.argv.slice(2);
  if (command !== "run" || rest.length === 0) {
    printUsageAndExit();
  }
  await run(rest.join(" "));
}

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
