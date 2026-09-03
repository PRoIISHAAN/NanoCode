// Onboarding (decisions/0011-tui-onboarding.md): drives SetupScreen against a fake
// ModelSetupController (no real MutableModels/kernel involved -- that bridge is tested for real in
// packages/agent/test/model-setup.test.ts and packages/ai/test/credential-store.test.ts) to prove
// the UI's own state machine -- auth-method choice, provider choice, conditional key entry, model
// choice, onReady -- wires together correctly.
import type { Session } from "@nanocode/agent";
import { render } from "ink-testing-library";
import { describe, expect, it, vi } from "vitest";
import { type ModelSetupController, SetupScreen } from "../src/setup-screen.tsx";

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const FAKE_SESSION = {} as Session; // opaque to SetupScreen -- it only ever passes this through.

/** Every real flow starts on the auth-method choice; this drives past it by selecting the
 * already-highlighted "API Key" option (index 0), matching what every test below needs to do
 * before it can reach the provider/model flow it's actually testing. */
async function chooseApiKeyAuth(stdin: { write: (data: string) => void }): Promise<void> {
  await wait(30);
  stdin.write("\r");
  await wait(30);
}

describe("SetupScreen", () => {
  it("starts on the auth-method choice, listing OAuth as not yet available", async () => {
    const controller: ModelSetupController = {
      listProviders: vi.fn(),
      listModels: () => [],
      login: vi.fn(),
      finish: vi.fn(),
    };
    const { lastFrame } = render(<SetupScreen setup={controller} onReady={() => {}} />);
    await wait(30);

    expect(lastFrame()).toContain("How would you like to authenticate?");
    expect(lastFrame()).toContain("API Key");
    expect(lastFrame()).toContain("OAuth");
    expect(lastFrame()).toContain("not yet available");
    // listProviders() must not run until the user actually picks "API Key".
    expect(controller.listProviders).not.toHaveBeenCalled();
  });

  it("shows a notice and returns to the auth-method choice when OAuth is selected", async () => {
    const controller: ModelSetupController = {
      listProviders: vi.fn(),
      listModels: () => [],
      login: vi.fn(),
      finish: vi.fn(),
    };
    const { lastFrame, stdin } = render(<SetupScreen setup={controller} onReady={() => {}} />);
    await wait(30);

    stdin.write("\x1b[B"); // down arrow -- move off "API Key" onto "OAuth"
    await wait(30);
    stdin.write("\r"); // select OAuth
    await wait(30);

    expect(lastFrame()).toContain("OAuth isn't supported yet");
    expect(controller.listProviders).not.toHaveBeenCalled();

    stdin.write("x"); // any key acknowledges the notice
    await wait(30);

    expect(lastFrame()).toContain("How would you like to authenticate?");
  });

  it("shows a provider already configured skipping straight to model choice", async () => {
    const controller: ModelSetupController = {
      listProviders: async () => [
        { id: "anthropic", name: "Anthropic", hasCredential: true, supportsApiKeyLogin: true },
      ],
      listModels: () => [{ id: "claude-sonnet-5", name: "Claude Sonnet 5" }],
      login: vi.fn(),
      finish: vi.fn(async () => FAKE_SESSION),
    };

    const { lastFrame, stdin } = render(<SetupScreen setup={controller} onReady={() => {}} />);
    await chooseApiKeyAuth(stdin);
    expect(lastFrame()).toContain("Anthropic");
    expect(lastFrame()).toContain("configured");

    stdin.write("\r"); // select the (only, already-highlighted) provider
    // 30ms was already a bump from an earlier flake at 10ms (see this test's git history) -- still
    // intermittently too tight now that the full suite has grown substantially larger, under
    // sequential fileParallelism (vitest.config.ts): a synchronous phase transition in
    // setup-screen.tsx has no real async work to wait on, so this is purely event-loop scheduling
    // contention from everything else running, not a genuine race in the component itself.
    await wait(60);

    expect(lastFrame()).toContain("Claude Sonnet 5");
    expect(controller.login).not.toHaveBeenCalled();
  });

  it("prompts for an API key for a provider with no stored credential, then proceeds", async () => {
    const controller: ModelSetupController = {
      listProviders: async () => [
        { id: "anthropic", name: "Anthropic", hasCredential: false, supportsApiKeyLogin: true },
      ],
      listModels: () => [{ id: "claude-sonnet-5", name: "Claude Sonnet 5" }],
      login: vi.fn(async () => {}),
      finish: vi.fn(async () => FAKE_SESSION),
    };

    const { lastFrame, stdin } = render(<SetupScreen setup={controller} onReady={() => {}} />);
    await chooseApiKeyAuth(stdin);
    stdin.write("\r"); // select the only provider
    await wait(10);
    expect(lastFrame()).toContain("Enter your Anthropic API key");

    for (const ch of "sk-test-key") {
      stdin.write(ch);
      await wait(2);
    }
    stdin.write("\r");
    await wait(10);

    expect(controller.login).toHaveBeenCalledWith("anthropic", "sk-test-key");
    expect(lastFrame()).toContain("Claude Sonnet 5");
  });

  it("does not call login() twice if Enter is pressed again before the first login() resolves", async () => {
    // Regression for an L4 VERIFY finding: the API-key step previously stayed on <TextInput> for
    // its entire `await setup.login(...)`, unlike every SelectList-driven step (which unmounts on
    // selection) -- a second Enter landing in that window could fire onSubmit a second time.
    let resolveLogin: () => void = () => {};
    const loginStarted = new Promise<void>((resolve) => {
      resolveLogin = resolve;
    });
    let loginCallCount = 0;
    const controller: ModelSetupController = {
      listProviders: async () => [
        { id: "anthropic", name: "Anthropic", hasCredential: false, supportsApiKeyLogin: true },
      ],
      listModels: () => [{ id: "claude-sonnet-5", name: "Claude Sonnet 5" }],
      login: vi.fn(async () => {
        loginCallCount += 1;
        resolveLogin();
        await new Promise((resolve) => setTimeout(resolve, 30)); // held open past the 2nd Enter
      }),
      finish: vi.fn(async () => FAKE_SESSION),
    };

    const { lastFrame, stdin } = render(<SetupScreen setup={controller} onReady={() => {}} />);
    await chooseApiKeyAuth(stdin);
    stdin.write("\r"); // select the only provider
    await wait(10);
    for (const ch of "sk-test-key") {
      stdin.write(ch);
      await wait(2);
    }
    stdin.write("\r"); // submit once
    await loginStarted; // the first login() call has definitely started
    stdin.write("\r"); // a second, spurious Enter while it's still in flight
    await wait(60); // long enough for the held-open login() call to fully resolve

    expect(loginCallCount).toBe(1);
    expect(lastFrame()).toContain("Claude Sonnet 5");
  });

  it("skips API key entry for an ambient-only provider with no login support", async () => {
    const controller: ModelSetupController = {
      listProviders: async () => [
        {
          id: "amazon-bedrock",
          name: "Amazon Bedrock",
          hasCredential: false,
          supportsApiKeyLogin: false,
        },
      ],
      listModels: () => [{ id: "some-model", name: "Some Model" }],
      login: vi.fn(),
      finish: vi.fn(async () => FAKE_SESSION),
    };

    const { lastFrame, stdin } = render(<SetupScreen setup={controller} onReady={() => {}} />);
    await chooseApiKeyAuth(stdin);
    expect(lastFrame()).toContain("ambient credentials only");

    stdin.write("\r");
    await wait(10);

    expect(lastFrame()).toContain("Some Model");
    expect(controller.login).not.toHaveBeenCalled();
  });

  it("calls onReady with the session finish() resolves, once a model is chosen", async () => {
    const controller: ModelSetupController = {
      listProviders: async () => [
        { id: "anthropic", name: "Anthropic", hasCredential: true, supportsApiKeyLogin: true },
      ],
      listModels: () => [{ id: "claude-sonnet-5", name: "Claude Sonnet 5" }],
      login: vi.fn(),
      finish: vi.fn(async () => FAKE_SESSION),
    };
    const onReady = vi.fn();

    const { stdin } = render(<SetupScreen setup={controller} onReady={onReady} />);
    await chooseApiKeyAuth(stdin);
    stdin.write("\r"); // provider
    await wait(10);
    stdin.write("\r"); // model
    await wait(10);

    expect(controller.finish).toHaveBeenCalledWith("anthropic", "claude-sonnet-5");
    expect(onReady).toHaveBeenCalledWith(FAKE_SESSION);
  });

  it("shows an error instead of crashing when listProviders() rejects", async () => {
    const controller: ModelSetupController = {
      listProviders: async () => {
        throw new Error("network unreachable");
      },
      listModels: () => [],
      login: vi.fn(),
      finish: vi.fn(),
    };

    const { lastFrame, stdin } = render(<SetupScreen setup={controller} onReady={() => {}} />);
    await chooseApiKeyAuth(stdin);

    expect(lastFrame()).toContain("Setup failed");
    expect(lastFrame()).toContain("network unreachable");
  });

  it("shows an error instead of crashing when finish() rejects (e.g. a bad model id)", async () => {
    const controller: ModelSetupController = {
      listProviders: async () => [
        { id: "anthropic", name: "Anthropic", hasCredential: true, supportsApiKeyLogin: true },
      ],
      listModels: () => [{ id: "claude-sonnet-5", name: "Claude Sonnet 5" }],
      login: vi.fn(),
      finish: vi.fn(async () => {
        throw new Error("model resolution failed");
      }),
    };

    const { lastFrame, stdin } = render(<SetupScreen setup={controller} onReady={() => {}} />);
    await chooseApiKeyAuth(stdin);
    stdin.write("\r");
    await wait(10);
    stdin.write("\r");
    await wait(10);

    expect(lastFrame()).toContain("Setup failed");
    expect(lastFrame()).toContain("model resolution failed");
  });
});
