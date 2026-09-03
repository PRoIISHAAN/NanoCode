// "/command" dispatch for the running session -- distinct from onboarding's `ModelSetupController`
// (setup-screen.tsx), which only ever runs before a Session exists. `SlashCommandController` is
// implemented in packages/cli/src/tui.tsx, closing over the real MutableModels/Session/credential
// store, so packages/tui itself never imports @nanocode/ai or @nanocode/kernel directly
// (context-graph.json's tui_isolation invariant) -- the same convention `RunShellCommand` and
// `ModelSetupController` already follow.
import type { AgentMessage, ModelOption, ProviderOption, Session } from "@nanocode/agent";

export interface SessionSummary {
  id: string;
  title: string;
  messageCount: number;
  updatedAt: number;
}

export interface SlashCommandController {
  listProviders(): Promise<ProviderOption[]>;
  listModels(providerId: string): ModelOption[];
  login(providerId: string, apiKey: string): Promise<void>;
  logout(providerId: string): Promise<void>;
  /** Resolves `providerId`/`modelId` and reassigns it onto the running session's model in place,
   * preserving conversation history (see setup.ts's `switchModel`). */
  switchModel(providerId: string, modelId: string): Promise<void>;
  /** Tears down the current kernel/telemetry/MCP and builds a brand new runtime for the same
   * model -- "/new"'s real work. Returns the new session for `App` to swap in. */
  startNewSession(): Promise<Session>;
  listRecentSessions(): Promise<SessionSummary[]>;
  loadSessionMessages(id: string): Promise<AgentMessage[]>;
  copyToClipboard(text: string): Promise<void>;
  /** Writes `content` to a new file and returns the path written. */
  exportTranscript(content: string, extension: string): Promise<string>;
}

/** Reasoning-effort levels a user can pick via "/effort" -- kept as plain string literals rather
 * than importing pi-ai's `ThinkingLevel` type, matching how status-bar.tsx already reads
 * `session.state.thinkingLevel` as a plain value without importing @nanocode/ai. */
export const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;

export interface ParsedCommand {
  name: string;
  args: string[];
}

/** Splits "/model anthropic claude-sonnet-5" into {name: "model", args: ["anthropic",
 * "claude-sonnet-5"]}. Returns undefined for anything not starting with "/" (the caller should
 * already have checked that, this is just the shared parsing logic). */
export function parseSlashCommand(text: string): ParsedCommand | undefined {
  if (!text.startsWith("/")) return undefined;
  const parts = text
    .slice(1)
    .trim()
    .split(/\s+/)
    .filter((part) => part.length > 0);
  const [name, ...args] = parts;
  if (!name) return undefined;
  return { name: name.toLowerCase(), args };
}

export interface CommandInfo {
  names: string[];
  usage: string;
  description: string;
}

/** Every command's canonical name comes first in `names`; later entries are aliases. Used both to
 * dispatch (aliases resolve to the same handler) and to render "/help". */
export const SLASH_COMMANDS: CommandInfo[] = [
  {
    names: ["new", "clear"],
    usage: "/new",
    description: "Start a fresh session (new kernel, empty history).",
  },
  {
    names: ["resume"],
    usage: "/resume [id]",
    description: "Resume a past session's messages into this one.",
  },
  {
    names: ["compact"],
    usage: "/compact",
    description: "Compress older conversation history to free up context.",
  },
  {
    names: ["model"],
    usage: "/model [provider] [model]",
    description: "Switch model among already-configured providers, keeping history.",
  },
  {
    names: ["login"],
    usage: "/login [provider]",
    description: "Add or replace a provider's API key.",
  },
  {
    names: ["logout"],
    usage: "/logout [provider]",
    description: "Remove a stored API key (defaults to the current provider).",
  },
  {
    names: ["effort"],
    usage: "/effort [level]",
    description: "Change reasoning effort for future turns.",
  },
  { names: ["status"], usage: "/status", description: "Show model, tokens, and cost so far." },
  {
    names: ["context"],
    usage: "/context",
    description: "Show a detailed context-window breakdown.",
  },
  { names: ["help"], usage: "/help", description: "List available commands." },
  { names: ["diff"], usage: "/diff", description: "Show `git diff` for the working directory." },
  {
    names: ["copy"],
    usage: "/copy",
    description: "Copy the last assistant response to the clipboard.",
  },
  {
    names: ["export"],
    usage: "/export [json|md]",
    description: "Export the transcript to a file.",
  },
  {
    names: ["init"],
    usage: "/init",
    description: "Ask the model to scan the repo and write project instructions.",
  },
  { names: ["settings"], usage: "/settings", description: "Show current configuration." },
];

/** Every real nanocode keybinding, in the order "/help" lists them -- kept as data, not scraped
 * from rendered strings, so `packages/tui/test`'s coverage can check it directly. Deliberately does
 * NOT copy pi's own list verbatim: only bindings nanocode actually implements are listed (see
 * decisions/0014-header-menu-and-editing.md for the full one-by-one mapping from pi's menu to what
 * nanocode built and why). Used to live in banner.tsx as ctrl+o's expanded-header content -- moved
 * here once the banner became permanent, unretractable scrollback (decisions/0014's Static
 * follow-up): "/help" is a fresh notice printed on demand, so it's the right home for anything that
 * needs to be re-displayable, unlike the banner. */
export const KEYBINDINGS: Array<{ keys: string; description: string }> = [
  { keys: "escape", description: "to interrupt" },
  { keys: "ctrl+c", description: "to clear" },
  { keys: "ctrl+c twice", description: "to exit" },
  { keys: "ctrl+d", description: "to exit (empty)" },
  { keys: "ctrl+z", description: "to suspend" },
  { keys: "ctrl+k", description: "to delete to end" },
  { keys: "shift+tab", description: "to cycle thinking level" },
  { keys: "ctrl+p/shift+ctrl+p", description: "to cycle models" },
  { keys: "ctrl+l", description: "to select model" },
  { keys: "ctrl+o", description: "to expand tool output" },
  { keys: "ctrl+t", description: "to toggle thinking" },
  { keys: "ctrl+g", description: "for external editor" },
  { keys: "/", description: "for commands" },
  { keys: "!", description: "to run bash (with context)" },
  { keys: "!!", description: "to run bash (no context)" },
  { keys: "option+enter", description: "for a new line" },
  { keys: "enter (while busy)", description: "to queue a follow-up message" },
  { keys: "option+up", description: "to edit all queued messages" },
  { keys: "ctrl+v", description: "to paste image (with text fallback)" },
  { keys: "(drop a file)", description: "to attach it" },
];

export function helpText(): string {
  const commands = SLASH_COMMANDS.map((cmd) => `${cmd.usage.padEnd(24)}${cmd.description}`).join(
    "\n",
  );
  const keybindings = KEYBINDINGS.map(
    ({ keys, description }) => `${keys.padEnd(24)}${description}`,
  ).join("\n");
  return `${commands}\n\nKeybindings:\n${keybindings}`;
}

/** Resolves an alias to its canonical command name, or undefined if `name` matches nothing. */
export function resolveCommandName(name: string): string | undefined {
  const command = SLASH_COMMANDS.find((cmd) => cmd.names.includes(name));
  return command?.names[0];
}

/** Every command whose canonical name OR any alias starts with `token` (case-insensitive) --
 * `token` is normally just the first word typed after "/" so far, possibly empty (which matches
 * everything). This is the live "/" autocomplete menu's filter, distinct from `resolveCommandName`
 * (exact match only, used at dispatch time). */
export function matchCommands(token: string): CommandInfo[] {
  const needle = token.toLowerCase();
  return SLASH_COMMANDS.filter((cmd) => cmd.names.some((name) => name.startsWith(needle)));
}

export interface CommandMenuState {
  /** False once the typed token is already a complete, valid command name (its own alias
   * included) -- there's nothing left to autocomplete at that point, matching pi's own menu, which
   * disappears the moment the command name itself is fully typed rather than staying open while
   * the user goes on to type arguments. */
  open: boolean;
  matches: CommandInfo[];
  /** Clamped to a valid index into `matches` (0 if `matches` is empty) -- safe to index directly
   * even if the caller's own highlight state hasn't caught up yet to a filter change that just
   * shrank the match list. */
  highlightIndex: number;
  /** The raw text typed after "/" so far (lowercased) -- exposed only so a caller can key a "reset
   * the highlight to 0 when this changes" effect off something simpler than `matches` itself
   * (a fresh array every call). */
  token: string;
}

const CLOSED_MENU: CommandMenuState = { open: false, matches: [], highlightIndex: 0, token: "" };

/** Derives the live "/" autocomplete menu's state from the prompt box's current text and whatever
 * highlight index the caller has been tracking -- pure and stateless so `PromptInput` and
 * `CommandMenu` (app.tsx/command-menu.tsx) can each call it independently and always agree on what
 * should be showing, rather than one of them trusting a value computed by the other on a possibly
 * stale render. */
export function deriveCommandMenu(input: string, rawHighlightIndex: number): CommandMenuState {
  if (!input.startsWith("/")) return CLOSED_MENU;
  const token = (input.slice(1).match(/^\S*/)?.[0] ?? "").toLowerCase();
  if (resolveCommandName(token) !== undefined) return CLOSED_MENU;
  const matches = matchCommands(token);
  if (matches.length === 0) return CLOSED_MENU;
  const highlightIndex = Math.min(Math.max(rawHighlightIndex, 0), matches.length - 1);
  return { open: true, matches, highlightIndex, token };
}
