// Pure logic, no Ink -- packages/tui/src/slash-commands.ts's own parsing/alias-resolution/help-text
// generation, tested in isolation from any rendering concern (that's command-overlay.test.tsx's and
// app.test.tsx's job).
import { describe, expect, it } from "vitest";
import {
  deriveCommandMenu,
  helpText,
  KEYBINDINGS,
  matchCommands,
  parseSlashCommand,
  resolveCommandName,
  SLASH_COMMANDS,
  THINKING_LEVELS,
} from "../src/slash-commands.ts";

describe("parseSlashCommand", () => {
  it("returns undefined for an empty string", () => {
    expect(parseSlashCommand("")).toBeUndefined();
  });

  it("returns undefined for text not starting with '/'", () => {
    expect(parseSlashCommand("hello world")).toBeUndefined();
    expect(parseSlashCommand("!echo hi")).toBeUndefined();
  });

  it("returns undefined for a bare '/' with nothing after it", () => {
    expect(parseSlashCommand("/")).toBeUndefined();
  });

  it("returns undefined for '/' followed by only whitespace", () => {
    expect(parseSlashCommand("/   ")).toBeUndefined();
  });

  it("lowercases the command name -- '/HELP' resolves the same as '/help'", () => {
    expect(parseSlashCommand("/HELP")).toEqual({ name: "help", args: [] });
    expect(parseSlashCommand("/HeLp")).toEqual({ name: "help", args: [] });
  });

  it("splits a command with arguments on whitespace, preserving argument case", () => {
    expect(parseSlashCommand("/model anthropic claude-sonnet-5")).toEqual({
      name: "model",
      args: ["anthropic", "claude-sonnet-5"],
    });
  });

  it("collapses extra/irregular whitespace between arguments", () => {
    expect(parseSlashCommand("/model   anthropic    claude-sonnet-5")).toEqual({
      name: "model",
      args: ["anthropic", "claude-sonnet-5"],
    });
  });

  it("trims trailing whitespace after the last argument", () => {
    expect(parseSlashCommand("/effort high   ")).toEqual({ name: "effort", args: ["high"] });
  });

  it("parses a command with no arguments", () => {
    expect(parseSlashCommand("/status")).toEqual({ name: "status", args: [] });
  });

  it("leaves an unknown command name alone (parsing doesn't validate against SLASH_COMMANDS)", () => {
    expect(parseSlashCommand("/bogus")).toEqual({ name: "bogus", args: [] });
  });
});

describe("resolveCommandName", () => {
  it("resolves 'new' and 'clear' to the same canonical name", () => {
    expect(resolveCommandName("new")).toBe("new");
    expect(resolveCommandName("clear")).toBe("new");
  });

  it("resolves a name with no aliases to itself", () => {
    expect(resolveCommandName("status")).toBe("status");
    expect(resolveCommandName("help")).toBe("help");
  });

  it("returns undefined for a name matching no command or alias", () => {
    expect(resolveCommandName("bogus")).toBeUndefined();
    expect(resolveCommandName("")).toBeUndefined();
  });

  it("every command's canonical name is names[0], and resolves to itself", () => {
    for (const command of SLASH_COMMANDS) {
      expect(resolveCommandName(command.names[0])).toBe(command.names[0]);
    }
  });

  it("every alias (names[1:]) resolves back to its own command's canonical name", () => {
    for (const command of SLASH_COMMANDS) {
      for (const alias of command.names.slice(1)) {
        expect(resolveCommandName(alias)).toBe(command.names[0]);
      }
    }
  });
});

describe("helpText", () => {
  it("mentions every command's usage string", () => {
    const text = helpText();
    for (const command of SLASH_COMMANDS) {
      expect(text).toContain(command.usage);
    }
  });

  it("mentions every command's description", () => {
    const text = helpText();
    for (const command of SLASH_COMMANDS) {
      expect(text).toContain(command.description);
    }
  });

  // ctrl+o used to expand the startup banner into a full keybinding list (ADR 0014); now that the
  // banner settles into permanent scrollback the moment a session starts, it can no longer be
  // retroactively expanded, so every keybinding's own description moved into "/help" instead
  // (KEYBINDINGS, defined alongside SLASH_COMMANDS in slash-commands.ts). helpText() now emits the
  // commands list, then a blank line, then a "Keybindings:" header, then one line per KEYBINDINGS
  // entry -- not just one line per command.
  it("emits one line per command, then a blank line, a 'Keybindings:' header, and one line per keybinding", () => {
    const lines = helpText().split("\n");
    expect(lines).toHaveLength(SLASH_COMMANDS.length + 2 + KEYBINDINGS.length);
    SLASH_COMMANDS.forEach((command, index) => {
      expect(lines[index]).toContain(command.usage);
      expect(lines[index]).toContain(command.description);
    });
    expect(lines[SLASH_COMMANDS.length]).toBe("");
    expect(lines[SLASH_COMMANDS.length + 1]).toBe("Keybindings:");
    KEYBINDINGS.forEach((binding, index) => {
      const line = lines[SLASH_COMMANDS.length + 2 + index];
      expect(line).toContain(binding.keys);
      expect(line).toContain(binding.description);
    });
  });

  // New, real behavior the user explicitly asked for ("/help should include the control commands
  // too") -- direct coverage beyond the structural line-count check above.
  it("mentions a real keybinding's own keys and description", () => {
    const text = helpText();
    expect(text).toContain("ctrl+o");
    expect(text).toContain("to expand tool output");
  });
});

describe("THINKING_LEVELS", () => {
  it("is the expected fixed set of 7 reasoning-effort levels", () => {
    expect(THINKING_LEVELS).toEqual(["off", "minimal", "low", "medium", "high", "xhigh", "max"]);
  });
});

describe("matchCommands", () => {
  it("returns every command whose canonical name starts with the token", () => {
    const matches = matchCommands("mo");
    expect(matches.map((cmd) => cmd.names[0])).toEqual(["model"]);
  });

  it("also matches on an alias, not just the canonical name", () => {
    // "clear" is an alias of "new" -- matchCommands has to check every name, not just names[0].
    const matches = matchCommands("cle");
    expect(matches.map((cmd) => cmd.names[0])).toEqual(["new"]);
  });

  it("is case-insensitive", () => {
    expect(matchCommands("MO").map((cmd) => cmd.names[0])).toEqual(["model"]);
    expect(matchCommands("Mo").map((cmd) => cmd.names[0])).toEqual(["model"]);
  });

  it("an empty token matches every command", () => {
    expect(matchCommands("")).toHaveLength(SLASH_COMMANDS.length);
  });

  it("returns an empty array when nothing matches", () => {
    expect(matchCommands("zzz")).toEqual([]);
  });

  it("matches every command starting with a shared prefix -- 'co' matches both compact and context", () => {
    const matches = matchCommands("co").map((cmd) => cmd.names[0]);
    expect(matches).toContain("compact");
    expect(matches).toContain("context");
  });
});

describe("deriveCommandMenu", () => {
  it("is closed when the input doesn't start with '/'", () => {
    expect(deriveCommandMenu("hello", 0)).toEqual({
      open: false,
      matches: [],
      highlightIndex: 0,
      token: "",
    });
  });

  it("is closed for an empty string", () => {
    expect(deriveCommandMenu("", 0).open).toBe(false);
  });

  it("is closed once the typed token is already a complete, valid command name", () => {
    expect(deriveCommandMenu("/model", 0).open).toBe(false);
  });

  it("is closed for a complete alias too, not just a canonical name", () => {
    expect(deriveCommandMenu("/clear", 0).open).toBe(false);
  });

  it("stays closed even once there's more text after a complete command name", () => {
    expect(deriveCommandMenu("/model anthropic", 0).open).toBe(false);
  });

  it("is open with a single match for a partial, unambiguous token", () => {
    const state = deriveCommandMenu("/mod", 0);
    expect(state.open).toBe(true);
    expect(state.matches.map((cmd) => cmd.names[0])).toEqual(["model"]);
    expect(state.token).toBe("mod");
  });

  it("is open listing every command for a bare '/'", () => {
    const state = deriveCommandMenu("/", 0);
    expect(state.open).toBe(true);
    expect(state.matches).toHaveLength(SLASH_COMMANDS.length);
    expect(state.token).toBe("");
  });

  it("is closed when no command matches the typed token at all", () => {
    expect(deriveCommandMenu("/zzz", 0)).toEqual({
      open: false,
      matches: [],
      highlightIndex: 0,
      token: "",
    });
  });

  it("clamps a highlight index below zero up to zero", () => {
    expect(deriveCommandMenu("/", -5).highlightIndex).toBe(0);
  });

  it("clamps a highlight index past the end of the match list down to the last match", () => {
    const state = deriveCommandMenu("/co", 99);
    // "compact", "context", and "copy" all start with "co" -- exactly 3 matches.
    expect(state.matches).toHaveLength(3);
    expect(state.highlightIndex).toBe(2);
  });

  it("lowercases the token the same way parseSlashCommand/matchCommands do", () => {
    expect(deriveCommandMenu("/MOD", 0).token).toBe("mod");
  });
});
