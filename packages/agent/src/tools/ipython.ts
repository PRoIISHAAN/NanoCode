// The ipython/RLM tool: nanocode's sole tool for M1 (see decisions/0002-tool-surface.md). All
// file I/O, shell commands (via Python's own `subprocess`), and computation happen as Python code
// the model writes and this tool runs through the persistent kernel from @nanocode/kernel.
import type { ExecuteResult, ReplKernelManager } from "@nanocode/kernel";
import { Type } from "typebox";
import type { AgentTool } from "../types.ts";

const ipythonParameters = Type.Object({
  code: Type.String({
    description:
      "Python code to execute in a persistent kernel. Variables, imports, and function/class " +
      "definitions persist across calls within one session. Use this for reading/writing files, " +
      "running shell commands (via the subprocess module), and any computation.",
  }),
});

/**
 * Renders a kernel ExecuteResult the way a Jupyter/IPython cell would: captured stdout first (in
 * the order it was written), then the trailing expression's repr (if the cell ended in one), then
 * a traceback (if it errored). This is what the model actually reads back as the tool result --
 * getting the ordering and framing right here is what makes "read the output" work naturally.
 */
function formatIpythonResult(result: ExecuteResult): string {
  const parts: string[] = [];
  if (result.stdout) {
    parts.push(result.stdoutTruncated ? `${result.stdout}\n[stdout truncated]` : result.stdout);
  }
  if (result.stderr) {
    parts.push(result.stderrTruncated ? `${result.stderr}\n[stderr truncated]` : result.stderr);
  }
  if (result.status === "ok" && result.result !== undefined) {
    parts.push(result.result);
  }
  if (result.status === "error" && result.error) {
    if (result.error.traceback.length > 0) {
      parts.push(result.error.traceback.join(""));
    } else {
      parts.push(`${result.error.ename}: ${result.error.evalue}`);
    }
  }
  if (result.status === "aborted") {
    parts.push("[execution aborted]");
  }
  return parts.length > 0 ? parts.join("\n") : "[no output]";
}

/** Builds the ipython AgentTool bound to a specific (already-started-or-startable) kernel. */
export function createIpythonTool(
  kernel: ReplKernelManager,
): AgentTool<typeof ipythonParameters, ExecuteResult> {
  return {
    name: "ipython",
    label: "Python",
    description:
      "Execute Python code in a persistent, stateful kernel. State (variables, imports, " +
      "definitions) persists across calls within this session. There is no separate file-edit, " +
      "read, or shell tool: use this for all of it (open()/pathlib for files, the subprocess " +
      "module for shell commands).",
    parameters: ipythonParameters,
    execute: async (_toolCallId, params, signal) => {
      const result = await kernel.execute(params.code, { signal });
      return {
        content: [{ type: "text", text: formatIpythonResult(result) }],
        details: result,
      };
    },
  };
}
