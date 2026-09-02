// Runs one golden-dataset case against one model config. Each case gets its own throwaway
// Session + kernel, isolated in its own temp directory -- the same "spin up a fresh session, run
// one prompt to completion, read back the final text" shape packages/agent/src/recursion.ts's
// createRecursionHandler already uses for rlm.run(), reused here for the same reason: it's the
// proven way to run one isolated turn and extract its answer (see decisions/0010-evals-harness.md).
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createIpythonTool, Session } from "@nanocode/agent";
import type { Api, Model, MutableModels } from "@nanocode/ai";
import { ReplKernelManager } from "@nanocode/kernel";
import type { CaseOutcome, CheckResult } from "./checks.ts";
import { evaluateChecks } from "./checks.ts";
import type { EvalCase } from "./dataset.ts";

const EVAL_SYSTEM_PROMPT =
  "You are being evaluated. Your only tool is `ipython`, a persistent Python REPL: there is no " +
  "separate file-read, file-write, or shell tool. Use Python's own open()/pathlib for file I/O " +
  "and the subprocess module for shell commands. Respond with exactly what was asked, with no " +
  "extra commentary, once the task is complete.";

/** One model config to run the dataset against -- e.g. { name: "baseline", provider: "anthropic",
 * model: "claude-3-haiku" } vs. a "candidate" config naming a different model or provider. */
export interface HarnessConfig {
  name: string;
  provider: string;
  model: string;
}

export interface EvalCaseResult {
  caseId: string;
  harness: string;
  passed: boolean;
  checks: CheckResult[];
  output: string;
  durationMs: number;
}

function extractOutcome(session: Session, workdir: string): CaseOutcome {
  const lastMessage = session.state.messages.at(-1);
  if (lastMessage?.role !== "assistant") {
    return { output: "", error: "session did not produce a final assistant message", workdir };
  }
  if (lastMessage.stopReason === "error" || lastMessage.stopReason === "aborted") {
    return {
      output: "",
      error: lastMessage.errorMessage ?? `run ended with stopReason "${lastMessage.stopReason}"`,
      workdir,
    };
  }
  const output = lastMessage.content
    .filter((c): c is Extract<typeof c, { type: "text" }> => c.type === "text")
    .map((c) => c.text)
    .join("");
  return { output, error: undefined, workdir };
}

/**
 * Resolves `config`'s model and runs `evalCase.prompt` through a fresh Session in its own temp
 * directory, then scores the result against the case's checks. Never throws for an in-band model
 * failure (a caught error becomes a failed `noErrors` outcome instead) -- it only throws if the
 * model config itself doesn't resolve (decisions/0010-evals-harness.md's baseline/candidate
 * configs are a CLI-input mistake, not a per-case eval result).
 */
export async function runEvalCase(
  evalCase: EvalCase,
  config: HarnessConfig,
  models: MutableModels,
  resolveModel: (
    models: MutableModels,
    selection: { provider: string; model: string },
  ) => Promise<Model<Api>>,
): Promise<EvalCaseResult> {
  const model = await resolveModel(models, { provider: config.provider, model: config.model });
  const workdir = await mkdtemp(join(tmpdir(), "nanocode-eval-"));
  const startedAt = Date.now();
  const kernel = new ReplKernelManager({ cwd: workdir });
  try {
    const session = new Session({
      streamFn: models.streamSimple.bind(models),
      initialState: {
        model,
        systemPrompt: EVAL_SYSTEM_PROMPT,
        tools: [createIpythonTool(kernel)],
      },
    });
    await session.prompt(evalCase.prompt);
    const outcome = extractOutcome(session, workdir);
    const { passed, results } = await evaluateChecks(evalCase.checks, outcome);
    return {
      caseId: evalCase.id,
      harness: config.name,
      passed,
      checks: results,
      output: outcome.output,
      durationMs: Date.now() - startedAt,
    };
  } finally {
    await kernel.shutdown();
    await rm(workdir, { recursive: true, force: true });
  }
}
