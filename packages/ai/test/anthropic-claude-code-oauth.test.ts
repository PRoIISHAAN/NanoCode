import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AuthContext, Credential, Message, MutableModels, Tool } from "@nanocode/ai";
import { createModelsRegistry, FileCredentialStore } from "@nanocode/ai";
import { Type } from "typebox";
import { afterEach, describe, expect, it } from "vitest";

function fakeAuthContext(env: Record<string, string>): AuthContext {
  return {
    async env(name) {
      return env[name];
    },
    async fileExists() {
      return false;
    },
  };
}

const TEST_MODEL_ID = "claude-sonnet-5";
const TEST_TOOLS: Tool[] = [
  { name: "read", description: "Read a file", parameters: Type.Object({ path: Type.String() }) },
  { name: "todowrite", description: "Update todos", parameters: Type.Object({}) },
  { name: "find", description: "Project-local finder", parameters: Type.Object({}) },
];

interface CapturedRequest {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: unknown;
}

function headersToLowerRecord(headers: Headers): Record<string, string> {
  const record: Record<string, string> = {};
  headers.forEach((value, key) => {
    record[key.toLowerCase()] = value;
  });
  return record;
}

function userMessage(text: string): Message {
  return { role: "user", content: text, timestamp: 0 };
}

function getTestModel(models: MutableModels) {
  const model = models.getModel("anthropic", TEST_MODEL_ID);
  if (!model) throw new Error(`Missing test model: ${TEST_MODEL_ID}`);
  return model;
}

async function captureRequest(
  input: Parameters<typeof fetch>[0],
  init?: RequestInit,
): Promise<CapturedRequest> {
  const request = input instanceof Request ? input : new Request(input, init);
  const rawBody = init?.body ? String(init.body) : await request.clone().text();
  return {
    url: request.url,
    method: request.method,
    headers: headersToLowerRecord(request.headers),
    body: rawBody ? JSON.parse(rawBody) : undefined,
  };
}

function sseEvent(event: string, data: unknown): string {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

function textResponseSse(text = "done"): string {
  return [
    sseEvent("message_start", {
      type: "message_start",
      message: {
        id: "msg_test",
        type: "message",
        role: "assistant",
        content: [],
        model: TEST_MODEL_ID,
        stop_reason: null,
        stop_sequence: null,
        usage: { input_tokens: 1, output_tokens: 0 },
      },
    }),
    sseEvent("content_block_start", {
      type: "content_block_start",
      index: 0,
      content_block: { type: "text", text: "" },
    }),
    sseEvent("content_block_delta", {
      type: "content_block_delta",
      index: 0,
      delta: { type: "text_delta", text },
    }),
    sseEvent("content_block_stop", { type: "content_block_stop", index: 0 }),
    sseEvent("message_delta", {
      type: "message_delta",
      delta: { stop_reason: "end_turn", stop_sequence: null },
      usage: { output_tokens: 1 },
    }),
    sseEvent("message_stop", { type: "message_stop" }),
  ].join("");
}

function toolUseResponseSse(toolName: string): string {
  return [
    sseEvent("message_start", {
      type: "message_start",
      message: {
        id: "msg_tool",
        type: "message",
        role: "assistant",
        content: [],
        model: TEST_MODEL_ID,
        stop_reason: null,
        stop_sequence: null,
        usage: { input_tokens: 1, output_tokens: 0 },
      },
    }),
    sseEvent("content_block_start", {
      type: "content_block_start",
      index: 0,
      content_block: { type: "tool_use", id: "toolu_test", name: toolName, input: {} },
    }),
    sseEvent("content_block_delta", {
      type: "content_block_delta",
      index: 0,
      delta: { type: "input_json_delta", partial_json: "{}" },
    }),
    sseEvent("content_block_stop", { type: "content_block_stop", index: 0 }),
    sseEvent("message_delta", {
      type: "message_delta",
      delta: { stop_reason: "tool_use", stop_sequence: null },
      usage: { output_tokens: 1 },
    }),
    sseEvent("message_stop", { type: "message_stop" }),
  ].join("");
}

function capturingFetch(
  captured: CapturedRequest[],
  body: string,
): NonNullable<Parameters<MutableModels["streamSimple"]>[2]>["fetch"] {
  return async (input, init) => {
    captured.push(await captureRequest(input, init));
    return new Response(body, {
      status: 200,
      headers: {
        "content-type": "text/event-stream",
        "request-id": "req_test",
      },
    });
  };
}

async function createModelsWithCredential(credential: Credential): Promise<{
  models: MutableModels;
  cleanup: () => Promise<void>;
}> {
  const dir = await mkdtemp(join(tmpdir(), "nanocode-anthropic-oauth-"));
  const store = new FileCredentialStore(join(dir, "credentials.json"));
  await store.modify("anthropic", async () => credential);
  return {
    models: createModelsRegistry({ credentials: store, authContext: fakeAuthContext({}) }),
    cleanup: () => rm(dir, { recursive: true, force: true }),
  };
}

describe("Anthropic Claude Code OAuth request shaping", () => {
  const cleanups: Array<() => Promise<void>> = [];

  afterEach(async () => {
    while (cleanups.length > 0) {
      await cleanups.pop()?.();
    }
  });

  it("uses Claude Code identity, bearer auth, and Claude Code tool names for stored Anthropic OAuth tokens", async () => {
    const { models, cleanup } = await createModelsWithCredential({
      type: "oauth",
      access: "sk-ant-oat-test-access-token",
      refresh: "test-refresh-token",
      expires: Date.now() + 60 * 60 * 1000,
    });
    cleanups.push(cleanup);
    const model = getTestModel(models);
    const captured: CapturedRequest[] = [];

    const result = await models
      .streamSimple(
        model,
        {
          systemPrompt: "Nanocode system prompt.",
          messages: [userMessage("hello")],
          tools: TEST_TOOLS,
        },
        { fetch: capturingFetch(captured, toolUseResponseSse("TodoWrite")) },
      )
      .result();

    expect(captured).toHaveLength(1);
    expect(captured[0].url).toBe("https://api.anthropic.com/v1/messages");
    expect(captured[0].headers.authorization).toBe("Bearer sk-ant-oat-test-access-token");
    expect(captured[0].headers["x-api-key"]).toBeUndefined();
    expect(captured[0].headers["anthropic-beta"]).toContain("claude-code-20250219");
    expect(captured[0].headers["anthropic-beta"]).toContain("oauth-2025-04-20");
    expect(captured[0].headers["user-agent"]).toBe("claude-cli/2.1.75");
    expect(captured[0].headers["x-app"]).toBe("cli");

    const body = captured[0].body as {
      system: { type: "text"; text: string }[];
      tools: { name: string }[];
    };
    expect(body.system.map((block) => block.text)).toEqual([
      "You are Claude Code, Anthropic's official CLI for Claude.",
      "Nanocode system prompt.",
    ]);
    expect(body.tools.map((tool) => tool.name)).toEqual(["Read", "TodoWrite", "find"]);
    expect(result.content).toEqual([
      { type: "toolCall", id: "toolu_test", name: "todowrite", arguments: {} },
    ]);
  });

  it("does not add Claude Code identity for ordinary Anthropic API-key credentials", async () => {
    const { models, cleanup } = await createModelsWithCredential({
      type: "api_key",
      key: "sk-ant-api03-test-key",
    });
    cleanups.push(cleanup);
    const model = getTestModel(models);
    const captured: CapturedRequest[] = [];

    await models
      .streamSimple(
        model,
        {
          systemPrompt: "Nanocode system prompt.",
          messages: [userMessage("hello")],
          tools: TEST_TOOLS,
        },
        { fetch: capturingFetch(captured, textResponseSse()) },
      )
      .result();

    expect(captured).toHaveLength(1);
    expect(captured[0].headers.authorization).toBeUndefined();
    expect(captured[0].headers["x-api-key"]).toBe("sk-ant-api03-test-key");
    expect(captured[0].headers["anthropic-beta"] ?? "").not.toContain("claude-code-20250219");
    expect(captured[0].headers["anthropic-beta"] ?? "").not.toContain("oauth-2025-04-20");
    expect(captured[0].headers["user-agent"]).not.toBe("claude-cli/2.1.75");
    expect(captured[0].headers["x-app"]).toBeUndefined();

    const body = captured[0].body as {
      system: { type: "text"; text: string }[];
      tools: { name: string }[];
    };
    expect(body.system.map((block) => block.text)).toEqual(["Nanocode system prompt."]);
    expect(body.tools.map((tool) => tool.name)).toEqual(["read", "todowrite", "find"]);
  });

  it("uses Claude Code request shaping for ANTHROPIC_OAUTH_TOKEN but not ANTHROPIC_API_KEY", async () => {
    const oauthModels = createModelsRegistry({
      authContext: fakeAuthContext({ ANTHROPIC_OAUTH_TOKEN: "sk-ant-oat-env-token" }),
    });
    const model = getTestModel(oauthModels);
    const oauthCaptured: CapturedRequest[] = [];

    await oauthModels
      .streamSimple(
        model,
        { systemPrompt: "Nanocode system prompt.", messages: [userMessage("hello")] },
        { fetch: capturingFetch(oauthCaptured, textResponseSse()) },
      )
      .result();

    const apiKeyModels = createModelsRegistry({
      authContext: fakeAuthContext({ ANTHROPIC_API_KEY: "sk-ant-api03-env-key" }),
    });
    const apiKeyCaptured: CapturedRequest[] = [];

    await apiKeyModels
      .streamSimple(
        model,
        { systemPrompt: "Nanocode system prompt.", messages: [userMessage("hello")] },
        { fetch: capturingFetch(apiKeyCaptured, textResponseSse()) },
      )
      .result();

    expect(oauthCaptured[0].headers.authorization).toBe("Bearer sk-ant-oat-env-token");
    expect(oauthCaptured[0].headers["anthropic-beta"]).toContain("claude-code-20250219");
    expect(apiKeyCaptured[0].headers.authorization).toBeUndefined();
    expect(apiKeyCaptured[0].headers["x-api-key"]).toBe("sk-ant-api03-env-key");
    expect(apiKeyCaptured[0].headers["anthropic-beta"] ?? "").not.toContain("claude-code-20250219");
  });
});
