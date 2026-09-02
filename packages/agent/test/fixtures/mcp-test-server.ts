// A tiny real MCP server, run as a stdio subprocess by the M6 tests -- exercises McpClientManager
// against a genuine MCP wire protocol implementation (the same SDK nanocode's own client uses),
// not a hand-rolled fake of the protocol.
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

const server = new McpServer({ name: "nanocode-test-server", version: "0.1.0" });

server.registerTool(
  "echo",
  { description: "returns whatever text it was given", inputSchema: { text: z.string() } },
  async ({ text }) => ({ content: [{ type: "text", text }] }),
);

server.registerTool(
  "add",
  {
    description: "adds two numbers, returning structured content",
    inputSchema: { a: z.number(), b: z.number() },
  },
  async ({ a, b }) => ({
    content: [{ type: "text", text: String(a + b) }],
    structuredContent: { sum: a + b },
  }),
);

server.registerTool("fail", { description: "always returns an MCP error result" }, async () => ({
  content: [{ type: "text", text: "deliberate failure" }],
  isError: true,
}));

await server.connect(new StdioServerTransport());
