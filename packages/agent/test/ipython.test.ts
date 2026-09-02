import { ReplKernelManager } from "@nanocode/kernel";
import { afterEach, describe, expect, it } from "vitest";
import { createIpythonTool } from "../src/tools/ipython.ts";

describe("createIpythonTool", () => {
  let kernel: ReplKernelManager | undefined;

  afterEach(async () => {
    await kernel?.shutdown();
    kernel = undefined;
  });

  it("returns the trailing expression's repr as tool content", async () => {
    kernel = new ReplKernelManager();
    const tool = createIpythonTool(kernel);
    const result = await tool.execute("call-1", { code: "17 * 23" });
    expect(result.content).toEqual([{ type: "text", text: "391" }]);
    expect(result.details.status).toBe("ok");
  });

  it("puts captured stdout before the trailing expression's repr", async () => {
    kernel = new ReplKernelManager();
    const tool = createIpythonTool(kernel);
    const result = await tool.execute("call-1", { code: 'print("computing")\n1 + 1' });
    expect(result.content[0]).toEqual({ type: "text", text: "computing\n\n2" });
  });

  it("surfaces a Python traceback as the tool content on error", async () => {
    kernel = new ReplKernelManager();
    const tool = createIpythonTool(kernel);
    const result = await tool.execute("call-1", { code: "1 / 0" });
    expect(result.details.status).toBe("error");
    const text = (result.content[0] as { text: string }).text;
    expect(text).toContain("ZeroDivisionError");
  });

  it("persists namespace state across separate tool calls, like a real REPL", async () => {
    kernel = new ReplKernelManager();
    const tool = createIpythonTool(kernel);
    await tool.execute("call-1", { code: "greeting = 'hello'" });
    const result = await tool.execute("call-2", { code: "greeting + ' world'" });
    expect(result.content).toEqual([{ type: "text", text: "'hello world'" }]);
  });
});
