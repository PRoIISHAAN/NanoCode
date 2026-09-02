// A real local streamableHttp MCP server for testing McpClientManager's HTTP transport --
// nanocode's client never spawns a process for this transport (it just connects to a URL), so
// unlike the stdio fixture, this runs in-process as a plain Node http.Server rather than a
// subprocess.
import { randomUUID } from "node:crypto";
import { createServer, type Server } from "node:http";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";

export interface HttpMcpServerHandle {
  url: string;
  close(): Promise<void>;
}

function buildMcpServer(): McpServer {
  const server = new McpServer({ name: "nanocode-http-test-server", version: "0.1.0" });
  server.registerTool(
    "echo",
    { description: "returns whatever text it was given", inputSchema: { text: z.string() } },
    async ({ text }) => ({ content: [{ type: "text", text }] }),
  );
  return server;
}

/** Starts a streamableHttp MCP server on an ephemeral local port and returns its URL.
 *
 * Uses stateful mode (a real session-id generator) rather than the SDK's "stateless" option
 * (`sessionIdGenerator: undefined`): direct testing found stateless mode's handling of the
 * `notifications/initialized` message that `Client.connect()` sends immediately after
 * `initialize` returns a 500 from the server's own transport, before the connection is ever
 * usable -- a real limitation in that SDK code path, not anything in nanocode's client. Stateful
 * mode connects and calls tools correctly, so that's what this fixture (and therefore
 * McpClientManager's real end-to-end test coverage of the streamableHttp transport) uses. */
export async function startHttpMcpServer(): Promise<HttpMcpServerHandle> {
  const mcpServer = buildMcpServer();
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: () => randomUUID() });
  await mcpServer.connect(transport);

  const httpServer: Server = createServer((req, res) => {
    void transport.handleRequest(req, res);
  });

  const url = await new Promise<string>((resolve) => {
    httpServer.listen(0, "127.0.0.1", () => {
      const address = httpServer.address();
      if (address === null || typeof address === "string") {
        throw new Error("expected an AddressInfo from an ephemeral TCP listener");
      }
      resolve(`http://127.0.0.1:${address.port}/mcp`);
    });
  });

  return {
    url,
    close: async () => {
      await transport.close();
      await new Promise<void>((resolve, reject) => {
        httpServer.close((error) => (error ? reject(error) : resolve()));
      });
    },
  };
}
