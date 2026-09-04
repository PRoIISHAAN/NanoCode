// Everything in model-setup.test.ts's own "loginWithOAuth" describe block drives that bridge
// against a FAKE `models.login` -- it proves the translation layer (AuthEvent/AuthPrompt <->
// OAuthEvent/OAuthPrompt) is correct, but never actually calls into one of pi-ai's own real,
// bundled OAuth provider implementations (auth/oauth/*.js). This file closes that gap: it drives
// loginWithOAuth against the REAL registry (`createModelsRegistry`, same helper model-setup.test.ts
// uses) so each real provider's real `auth.oauth.login` runs for real, with only the network layer
// (global `fetch`) stubbed out -- no live requests. Verified directly against what's actually
// installed at node_modules/@earendil-works/pi-ai/dist/auth/oauth/*.js and dist/providers/*.js
// (both read in full before writing this file), not assumed from any spec.
//
// Every provider below is registered in pi-ai's own `builtinProviders()` (providers/all.js), which
// is exactly what `createModelsRegistry` (packages/ai/src/index.ts) constructs, so `provider.auth
// .oauth` here is pi-ai's real, unmodified implementation -- reached through its `lazyOAuth()`
// wrapper (auth/helpers.js), which dynamically imports the flow module on first `login()` call.
//
// Real OAuth-capable providers found in providers/all.js's `builtinProviders()`, and how each is
// covered here:
//   - anthropic        (auth/oauth/anthropic.js)        -- PKCE + local callback server, raced
//                                                           against a "manual_code" prompt answer.
//                                                           FULL round trip (see below for why this
//                                                           is safely deterministic, not flaky).
//   - openai-codex      (auth/oauth/openai-codex.js)     -- same PKCE-vs-manual_code shape, plus an
//                                                           upfront "browser vs device code" select
//                                                           prompt. FULL round trip.
//   - openrouter        (auth/oauth/openrouter.js)       -- same PKCE-vs-manual_code shape, on an
//                                                           ephemeral local port. FULL round trip.
//                                                           providers/openrouter-images.js's own
//                                                           `auth.oauth` reuses this exact same
//                                                           `loadOpenRouterOAuth` -- confirmed by
//                                                           reading that file -- but images
//                                                           providers live in a separate registry
//                                                           (`builtinImagesModels`, not
//                                                           `createModelsRegistry`'s
//                                                           `builtinModels`) that nanocode's
//                                                           ModelSetupController never surfaces, so
//                                                           there's no nanocode-reachable path to
//                                                           exercise it separately from this test.
//   - github-copilot    (auth/oauth/github-copilot.js)   -- RFC 8628 device-code flow, plus an
//                                                           upfront enterprise-domain text prompt.
//                                                           FULL round trip, including the post-
//                                                           login Copilot-token exchange and model
//                                                           catalog fetch the real flow performs.
//   - xai               (auth/oauth/xai.js)              -- RFC 8628 device-code flow, no prompts.
//                                                           FULL round trip.
//   - kimi-coding       (auth/oauth/kimi-coding.js)      -- RFC 8628 device-code flow, no prompts.
//                                                           FULL round trip.
//   - radius            (auth/oauth/radius.js)           -- offers BOTH a browser (local server)
//                                                           method and an RFC 8628 device-code
//                                                           method behind an upfront select prompt;
//                                                           this test answers "device-code" (the
//                                                           browser method has no manual-code
//                                                           fallback at all in the real code, so it
//                                                           can only be driven by actually hitting
//                                                           its local callback server over real
//                                                           loopback HTTP, which is more machinery
//                                                           than the device-code method needs for
//                                                           equally real coverage of the same
//                                                           module). FULL round trip.
//
// On "full round trip" for the three PKCE-local-server flows (anthropic, openai-codex, openrouter):
// each one starts a real Node `http` server on a real port and races it against a "manual_code"
// prompt answer -- but nothing in this test (or anywhere else) ever sends that server a real HTTP
// request, so the ONLY way its race can resolve is the manual_code prompt, which this test's fake
// `prompt()` answers synchronously. That makes which side "wins" deterministic, not timing-
// dependent -- there's no flakiness to trade away here.
import type { AuthContext, MutableModels } from "@nanocode/ai";
import { createModelsRegistry } from "@nanocode/ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import { loginWithOAuth, type OAuthEvent, type OAuthLoginHandlers } from "../src/model-setup.ts";

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

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

interface FetchRoute {
  match(url: string, method: string): boolean;
  respond(url: string, init: RequestInit | undefined): Response | Promise<Response>;
}

/** Routes every `fetch()` call the real OAuth flow code makes (see this file's own header comment
 * -- global `fetch` is the one thing stubbed out, everything else in the flow runs for real) to a
 * canned response by method+URL, recording every call so tests can assert the real endpoints were
 * actually hit rather than just trusting `notify`/`prompt` output. Throws on any unmatched request
 * -- a flow hitting a URL this file's own reading of the real source didn't account for should fail
 * loudly, not silently return an empty 200. */
function stubFetchRoutes(routes: FetchRoute[]): { url: string; method: string }[] {
  const calls: { url: string; method: string }[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      const url = typeof input === "string" ? input : input.toString();
      const method = (init?.method ?? "GET").toUpperCase();
      calls.push({ url, method });
      const route = routes.find((r) => r.match(url, method));
      if (!route) {
        throw new Error(`Unexpected fetch in this test: ${method} ${url}`);
      }
      return route.respond(url, init);
    }),
  );
  return calls;
}

function eventsOf<T extends OAuthEvent["type"]>(
  events: OAuthEvent[],
  type: T,
): Extract<OAuthEvent, { type: T }>[] {
  return events.filter((e): e is Extract<OAuthEvent, { type: T }> => e.type === type);
}

/** A JWT-shaped string whose payload decodes to `payload` -- openai-codex's real
 * `credentialsFromToken` decodes the access token's own JWT payload to extract `chatgpt_account_id`
 * (see auth/oauth/openai-codex.js's own `decodeJwt`/`getAccountId`), so a plain opaque string won't
 * do for that one provider. */
function fakeJwt(payload: Record<string, unknown>): string {
  const part = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64");
  return `${part({ alg: "none", typ: "JWT" })}.${part(payload)}.fake-signature`;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("anthropic OAuth (auth/oauth/anthropic.js)", () => {
  it("drives the real PKCE flow to completion via the manual_code fallback, hitting the real token endpoint", async () => {
    const models: MutableModels = createModelsRegistry({ authContext: fakeAuthContext({}) });
    let tokenRequestBody: Record<string, string> = {};
    const calls = stubFetchRoutes([
      {
        match: (url, method) =>
          method === "POST" && url === "https://platform.claude.com/v1/oauth/token",
        respond: async (_url, init) => {
          tokenRequestBody = JSON.parse(String(init?.body));
          return jsonResponse({
            access_token: "anthropic-access-token",
            refresh_token: "anthropic-refresh-token",
            expires_in: 3600,
          });
        },
      },
    ]);

    const events: OAuthEvent[] = [];
    const handlers: OAuthLoginHandlers = {
      notify: (event) => events.push(event),
      prompt: async (prompt) => {
        expect(prompt.type).toBe("manual_code");
        // A plain code (not a URL) -- the real `parseAuthorizationInput` treats this as the code
        // itself with no `state`, so the real flow falls back to its own PKCE verifier as `state`
        // (see auth/oauth/anthropic.js's own `loginAnthropic`) -- no need for this test to know that
        // verifier value up front.
        return "test-authorization-code";
      },
    };

    await loginWithOAuth(models, "anthropic", handlers);

    const [authUrlEvent] = eventsOf(events, "auth_url");
    expect(authUrlEvent).toBeDefined();
    const url = new URL(authUrlEvent?.url ?? "");
    expect(url.origin).toBe("https://claude.ai");
    expect(url.pathname).toBe("/oauth/authorize");
    // The real, decoded client_id (auth/oauth/anthropic.js's own base64-obscured `CLIENT_ID`).
    expect(url.searchParams.get("client_id")).toBe("9d1c250a-e61b-44d9-88ed-5944d1962f5e");
    expect(url.searchParams.get("redirect_uri")).toBe("http://localhost:53692/callback");
    expect(url.searchParams.get("response_type")).toBe("code");
    expect(url.searchParams.get("code_challenge_method")).toBe("S256");
    expect(url.searchParams.get("scope")).toContain("user:inference");
    expect(eventsOf(events, "progress").length).toBeGreaterThan(0);

    expect(tokenRequestBody.grant_type).toBe("authorization_code");
    expect(tokenRequestBody.client_id).toBe("9d1c250a-e61b-44d9-88ed-5944d1962f5e");
    expect(tokenRequestBody.code).toBe("test-authorization-code");
    // Cross-checks that the auth_url's own `state` and the token exchange's own `code_verifier` are
    // the SAME real, randomly generated PKCE verifier -- proving the two independent code paths
    // (auth-url construction and token exchange) are wired to the one real value, not two.
    expect(url.searchParams.get("state")).toBe(tokenRequestBody.code_verifier);
    expect(calls.some((c) => c.url === "https://platform.claude.com/v1/oauth/token")).toBe(true);

    await expect(models.checkAuth("anthropic")).resolves.toBeDefined();
  });
});

describe("openai-codex OAuth (auth/oauth/openai-codex.js)", () => {
  it("drives the real PKCE browser-method flow to completion via the manual_code fallback", async () => {
    const models: MutableModels = createModelsRegistry({ authContext: fakeAuthContext({}) });
    const accessToken = fakeJwt({
      "https://api.openai.com/auth": { chatgpt_account_id: "acct-test" },
    });
    let tokenRequestBody: Record<string, string> = {};
    stubFetchRoutes([
      {
        match: (url, method) => method === "POST" && url === "https://auth.openai.com/oauth/token",
        respond: async (_url, init) => {
          tokenRequestBody = Object.fromEntries(new URLSearchParams(String(init?.body)));
          return jsonResponse({
            access_token: accessToken,
            refresh_token: "codex-refresh-token",
            expires_in: 3600,
          });
        },
      },
    ]);

    const events: OAuthEvent[] = [];
    const handlers: OAuthLoginHandlers = {
      notify: (event) => events.push(event),
      prompt: async (prompt) => {
        if (prompt.type === "select") {
          // OPENAI_CODEX_BROWSER_LOGIN_METHOD -- see this file's own header comment on why the
          // browser method (not device-code) is the one exercised to completion here.
          return "browser";
        }
        expect(prompt.type).toBe("manual_code");
        return "test-authorization-code";
      },
    };

    await loginWithOAuth(models, "openai-codex", handlers);

    const [authUrlEvent] = eventsOf(events, "auth_url");
    expect(authUrlEvent).toBeDefined();
    const url = new URL(authUrlEvent?.url ?? "");
    expect(url.origin).toBe("https://auth.openai.com");
    expect(url.pathname).toBe("/oauth/authorize");
    expect(url.searchParams.get("client_id")).toBe("app_EMoamEEZ73f0CkXaXp7hrann");
    expect(url.searchParams.get("redirect_uri")).toBe("http://localhost:1455/auth/callback");
    expect(url.searchParams.get("code_challenge_method")).toBe("S256");

    expect(tokenRequestBody.grant_type).toBe("authorization_code");
    expect(tokenRequestBody.client_id).toBe("app_EMoamEEZ73f0CkXaXp7hrann");
    expect(tokenRequestBody.code).toBe("test-authorization-code");
    expect(tokenRequestBody.code_verifier?.length).toBeGreaterThan(0);

    await expect(models.checkAuth("openai-codex")).resolves.toBeDefined();
  });
});

describe("openrouter OAuth (auth/oauth/openrouter.js)", () => {
  it("drives the real PKCE flow to completion via the manual_code fallback, exchanging the code for a permanent API key", async () => {
    const models: MutableModels = createModelsRegistry({ authContext: fakeAuthContext({}) });
    let tokenRequestBody: Record<string, unknown> = {};
    stubFetchRoutes([
      {
        match: (url, method) =>
          method === "POST" && url === "https://openrouter.ai/api/v1/auth/keys",
        respond: async (_url, init) => {
          tokenRequestBody = JSON.parse(String(init?.body));
          // Unlike every other provider here, OpenRouter's real flow exchanges the code for a
          // permanent, user-controlled API key ("key"), not an expiring access/refresh pair (see
          // this module's own header comment) -- confirmed directly from auth/oauth/openrouter.js.
          return jsonResponse({ key: "sk-or-v1-test-key" });
        },
      },
    ]);

    const events: OAuthEvent[] = [];
    const handlers: OAuthLoginHandlers = {
      notify: (event) => events.push(event),
      prompt: async (prompt) => {
        expect(prompt.type).toBe("manual_code");
        return "test-authorization-code";
      },
    };

    await loginWithOAuth(models, "openrouter", handlers);

    const [authUrlEvent] = eventsOf(events, "auth_url");
    expect(authUrlEvent).toBeDefined();
    const url = new URL(authUrlEvent?.url ?? "");
    expect(url.origin).toBe("https://openrouter.ai");
    expect(url.pathname).toBe("/auth");
    expect(url.searchParams.get("code_challenge_method")).toBe("S256");
    // An ephemeral local port (unlike anthropic/openai-codex's fixed ones) -- just prove it's a real
    // loopback callback URL, not the exact port number.
    expect(url.searchParams.get("callback_url")).toMatch(
      /^http:\/\/127\.0\.0\.1:\d+\/oauth\/callback\//,
    );

    expect(tokenRequestBody.code).toBe("test-authorization-code");
    expect(tokenRequestBody.code_challenge_method).toBe("S256");
    expect(typeof tokenRequestBody.code_verifier).toBe("string");

    await expect(models.checkAuth("openrouter")).resolves.toBeDefined();
  });
});

describe("xai OAuth (auth/oauth/xai.js, RFC 8628 device-code flow)", () => {
  it("drives the real device-code flow to completion, hitting both the device and token endpoints", async () => {
    const models: MutableModels = createModelsRegistry({ authContext: fakeAuthContext({}) });
    let deviceRequestBody: URLSearchParams = new URLSearchParams();
    let tokenRequestBody: URLSearchParams = new URLSearchParams();
    stubFetchRoutes([
      {
        match: (url, method) => method === "POST" && url === "https://auth.x.ai/oauth2/device/code",
        respond: async (_url, init) => {
          deviceRequestBody = new URLSearchParams(String(init?.body));
          return jsonResponse({
            device_code: "xai-device-code",
            user_code: "ABCD-1234",
            verification_uri: "https://auth.x.ai/activate",
            verification_uri_complete: "https://auth.x.ai/activate?user_code=ABCD-1234",
            interval: 1,
            expires_in: 600,
          });
        },
      },
      {
        match: (url, method) => method === "POST" && url === "https://auth.x.ai/oauth2/token",
        respond: async (_url, init) => {
          tokenRequestBody = new URLSearchParams(String(init?.body));
          return jsonResponse({
            access_token: "xai-access-token",
            refresh_token: "xai-refresh-token",
            expires_in: 3600,
          });
        },
      },
    ]);

    const events: OAuthEvent[] = [];
    const handlers: OAuthLoginHandlers = {
      notify: (event) => events.push(event),
      prompt: async () => {
        throw new Error("xai's real device-code flow never prompts for anything");
      },
    };

    await loginWithOAuth(models, "xai", handlers);

    expect(deviceRequestBody.get("client_id")).toBe("b1a00492-073a-47ea-816f-4c329264a828");
    const [deviceEvent] = eventsOf(events, "device_code");
    expect(deviceEvent).toEqual({
      type: "device_code",
      userCode: "ABCD-1234",
      // The real flow prefers `verification_uri_complete` over the plain `verification_uri` when
      // present (auth/oauth/xai.js's own `loginXai`).
      verificationUri: "https://auth.x.ai/activate?user_code=ABCD-1234",
      intervalSeconds: 1,
      expiresInSeconds: 600,
    });

    expect(tokenRequestBody.get("grant_type")).toBe("urn:ietf:params:oauth:grant-type:device_code");
    expect(tokenRequestBody.get("device_code")).toBe("xai-device-code");

    await expect(models.checkAuth("xai")).resolves.toBeDefined();
  });
});

describe("kimi-coding OAuth (auth/oauth/kimi-coding.js, RFC 8628 device-code flow)", () => {
  it("drives the real device-code flow to completion, hitting both the device and token endpoints", async () => {
    const models: MutableModels = createModelsRegistry({ authContext: fakeAuthContext({}) });
    let deviceRequestBody: URLSearchParams = new URLSearchParams();
    let tokenRequestBody: URLSearchParams = new URLSearchParams();
    stubFetchRoutes([
      {
        match: (url, method) =>
          method === "POST" && url === "https://auth.kimi.com/api/oauth/device_authorization",
        respond: async (_url, init) => {
          deviceRequestBody = new URLSearchParams(String(init?.body));
          return jsonResponse({
            device_code: "kimi-device-code",
            user_code: "WXYZ-5678",
            verification_uri: "https://kimi.com/activate",
            verification_uri_complete: "https://kimi.com/activate?user_code=WXYZ-5678",
            interval: 1,
            expires_in: 900,
          });
        },
      },
      {
        match: (url, method) =>
          method === "POST" && url === "https://auth.kimi.com/api/oauth/token",
        respond: async (_url, init) => {
          tokenRequestBody = new URLSearchParams(String(init?.body));
          return jsonResponse({
            access_token: "kimi-access-token",
            refresh_token: "kimi-refresh-token",
            expires_in: 3600,
          });
        },
      },
    ]);

    const events: OAuthEvent[] = [];
    const handlers: OAuthLoginHandlers = {
      notify: (event) => events.push(event),
      prompt: async () => {
        throw new Error("kimi-coding's real device-code flow never prompts for anything");
      },
    };

    await loginWithOAuth(models, "kimi-coding", handlers);

    expect(deviceRequestBody.get("client_id")).toBe("17e5f671-d194-4dfb-9706-5516cb48c098");
    const [deviceEvent] = eventsOf(events, "device_code");
    expect(deviceEvent).toEqual({
      type: "device_code",
      userCode: "WXYZ-5678",
      verificationUri: "https://kimi.com/activate?user_code=WXYZ-5678",
      intervalSeconds: 1,
      expiresInSeconds: 900,
    });

    expect(tokenRequestBody.get("grant_type")).toBe("urn:ietf:params:oauth:grant-type:device_code");
    expect(tokenRequestBody.get("device_code")).toBe("kimi-device-code");

    await expect(models.checkAuth("kimi-coding")).resolves.toBeDefined();
  });
});

describe("github-copilot OAuth (auth/oauth/github-copilot.js, RFC 8628 device-code flow)", () => {
  it("drives the real device-code flow to completion, including the post-login Copilot-token exchange and model catalog fetch", async () => {
    const models: MutableModels = createModelsRegistry({ authContext: fakeAuthContext({}) });
    let deviceRequestBody: URLSearchParams = new URLSearchParams();
    let accessTokenRequestBody: URLSearchParams = new URLSearchParams();
    stubFetchRoutes([
      {
        match: (url, method) => method === "POST" && url === "https://github.com/login/device/code",
        respond: async (_url, init) => {
          deviceRequestBody = new URLSearchParams(String(init?.body));
          return jsonResponse({
            device_code: "gh-device-code",
            user_code: "GHUB-0001",
            verification_uri: "https://github.com/login/device",
            interval: 1,
            expires_in: 900,
          });
        },
      },
      {
        match: (url, method) =>
          method === "POST" && url === "https://github.com/login/oauth/access_token",
        respond: async (_url, init) => {
          accessTokenRequestBody = new URLSearchParams(String(init?.body));
          return jsonResponse({ access_token: "gh-oauth-access-token" });
        },
      },
      {
        match: (url, method) =>
          method === "GET" && url === "https://api.github.com/copilot_internal/v2/token",
        respond: () =>
          jsonResponse({
            token: "copilot-session-token",
            expires_at: Math.floor(Date.now() / 1000) + 1800,
          }),
      },
      {
        match: (url, method) =>
          method === "GET" && url === "https://api.individual.githubcopilot.com/models",
        respond: () =>
          jsonResponse({
            data: [
              {
                id: "gpt-4",
                capabilities: { supports: { tool_calls: true } },
                model_picker_enabled: true,
                policy: { state: "enabled" },
              },
            ],
          }),
      },
    ]);

    const events: OAuthEvent[] = [];
    const handlers: OAuthLoginHandlers = {
      notify: (event) => events.push(event),
      prompt: async (prompt) => {
        expect(prompt.type).toBe("text"); // "GitHub Enterprise URL/domain (blank for github.com)"
        return ""; // blank -- use github.com, not an enterprise domain.
      },
    };

    await loginWithOAuth(models, "github-copilot", handlers);

    expect(deviceRequestBody.get("client_id")).toBe("Iv1.b507a08c87ecfe98");
    expect(deviceRequestBody.get("scope")).toBe("read:user");
    const [deviceEvent] = eventsOf(events, "device_code");
    expect(deviceEvent).toEqual({
      type: "device_code",
      userCode: "GHUB-0001",
      verificationUri: "https://github.com/login/device",
      intervalSeconds: 1,
      expiresInSeconds: 900,
    });
    expect(accessTokenRequestBody.get("device_code")).toBe("gh-device-code");
    expect(accessTokenRequestBody.get("grant_type")).toBe(
      "urn:ietf:params:oauth:grant-type:device_code",
    );

    await expect(models.checkAuth("github-copilot")).resolves.toBeDefined();
  });
});

describe("radius OAuth (auth/oauth/radius.js)", () => {
  it("answering the upfront method choice with device-code drives the real RFC 8628 flow to completion", async () => {
    // Radius's real login offers BOTH a browser method (a local callback server with NO manual-code
    // fallback at all -- see this file's own header comment) and a device-code method behind an
    // upfront "select" prompt. This test answers "device-code" for full, deterministic round-trip
    // coverage of the same real module without needing to hit a real loopback server.
    const models: MutableModels = createModelsRegistry({ authContext: fakeAuthContext({}) });
    let deviceRequestBody: URLSearchParams = new URLSearchParams();
    let tokenRequestBody: URLSearchParams = new URLSearchParams();
    const calls = stubFetchRoutes([
      {
        match: (url, method) =>
          method === "POST" && url === "https://radius.pi.dev/v1/oauth/device",
        respond: async (_url, init) => {
          deviceRequestBody = new URLSearchParams(String(init?.body));
          return jsonResponse({
            device_code: "radius-device-code",
            user_code: "RAD1-2345",
            verification_uri: "https://radius.pi.dev/device",
            interval: 1,
            expires_in: 600,
          });
        },
      },
      {
        match: (url, method) => method === "POST" && url === "https://radius.pi.dev/v1/oauth/token",
        respond: async (_url, init) => {
          tokenRequestBody = new URLSearchParams(String(init?.body));
          return jsonResponse({
            access_token: "radius-access-token",
            refresh_token: "radius-refresh-token",
            expires_in: 3600,
          });
        },
      },
    ]);

    const events: OAuthEvent[] = [];
    const handlers: OAuthLoginHandlers = {
      notify: (event) => events.push(event),
      prompt: async (prompt) => {
        expect(prompt.type).toBe("select");
        if (prompt.type === "select") {
          const deviceCodeOption = prompt.options.find((o) => o.id === "device-code");
          expect(deviceCodeOption).toBeDefined();
          return "device-code";
        }
        throw new Error("unreachable");
      },
    };

    await loginWithOAuth(models, "radius", handlers);

    expect(deviceRequestBody.get("client_id")).toBe("pi-gateway");
    const [deviceEvent] = eventsOf(events, "device_code");
    expect(deviceEvent).toEqual({
      type: "device_code",
      userCode: "RAD1-2345",
      verificationUri: "https://radius.pi.dev/device",
      intervalSeconds: 1,
      expiresInSeconds: 600,
    });
    expect(tokenRequestBody.get("grant_type")).toBe("urn:ietf:params:oauth:grant-type:device_code");
    expect(tokenRequestBody.get("device_code")).toBe("radius-device-code");
    // The browser method's own discovery endpoint (/v1/oauth) must never have been hit -- proves the
    // device-code choice really did skip it, not just "also" reach the same result.
    expect(calls.some((c) => c.url === "https://radius.pi.dev/v1/oauth")).toBe(false);

    await expect(models.checkAuth("radius")).resolves.toBeDefined();
  });
});
