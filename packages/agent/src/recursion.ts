// M2: the host-side half of RLM recursion. Python code running inside the kernel calls
// `await rlm.run(prompt)` (see packages/kernel/python/nanocode_kernel/rlm.py), which raises a
// "rlm.run" host_request; this module answers it by spawning a fresh, depth-limited child
// `Session` -- its own kernel process, its own conversation, its own provider stream -- running
// the given prompt to completion and returning its final text answer.
import type { Api, Model, MutableModels } from "@nanocode/ai";
import { type HostRequestHandler, ReplKernelManager } from "@nanocode/kernel";
import { Session } from "./agent.ts";
import { createIpythonTool } from "./tools/ipython.ts";

export const DEFAULT_MAX_RECURSION_DEPTH = 2;

export interface RecursionContext {
  models: MutableModels;
  model: Model<Api>;
  systemPrompt: string;
  /** How many `rlm.run` calls deep the session about to run this handler already is. Root = 0. */
  depth: number;
  maxDepth?: number;
}

/**
 * Builds the "rlm.run" host_request handler for one session at a given recursion depth.
 *
 * The depth check is the very first thing that runs, before anything else is touched -- no child
 * kernel, no child session, nothing -- so a rejected call never has a partially-constructed child
 * to clean up. See context-graph.json's `rlm_depth_enforced_pre_spawn` invariant.
 */
export function createRecursionHandler(context: RecursionContext): HostRequestHandler {
  const maxDepth = context.maxDepth ?? DEFAULT_MAX_RECURSION_DEPTH;

  return async (data) => {
    if (context.depth >= maxDepth) {
      throw new Error(
        `RLM recursion depth limit (${maxDepth}) reached; refusing to spawn another child agent`,
      );
    }
    const prompt = typeof data.prompt === "string" ? data.prompt : undefined;
    if (!prompt) {
      throw new Error("rlm.run requires a string prompt");
    }

    // Each recursion level gets its own kernel process: the parent's kernel is busy running the
    // very cell that's awaiting this call, so it has no spare capacity to also serve a child's
    // tool calls even if we wanted to share it.
    const childContext: RecursionContext = { ...context, depth: context.depth + 1 };
    const childKernel = new ReplKernelManager({
      hostHandlers: { "rlm.run": createRecursionHandler(childContext) },
    });
    const childSession = new Session({
      streamFn: context.models.streamSimple.bind(context.models),
      initialState: {
        model: context.model,
        systemPrompt: context.systemPrompt,
        tools: [createIpythonTool(childKernel)],
      },
    });

    try {
      await childSession.prompt(prompt);
    } finally {
      await childKernel.shutdown();
    }

    return { answer: extractFinalAnswer(childSession) };
  };
}

function extractFinalAnswer(session: Session): string {
  const lastMessage = session.state.messages.at(-1);
  if (lastMessage?.role !== "assistant") {
    throw new Error("child agent did not produce a final response");
  }
  if (lastMessage.stopReason === "error" || lastMessage.stopReason === "aborted") {
    throw new Error(
      lastMessage.errorMessage ??
        `child agent run ended with stopReason "${lastMessage.stopReason}"`,
    );
  }
  return lastMessage.content
    .filter((c): c is Extract<typeof c, { type: "text" }> => c.type === "text")
    .map((c) => c.text)
    .join("");
}
