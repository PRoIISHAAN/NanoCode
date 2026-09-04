# nanocode

**A terminal coding agent whose only tool is a persistent Python REPL — and whose REPL can spawn more agents.**

nanocode is a TypeScript/Node.js coding agent, built on top of [`@earendil-works/pi-ai`](https://www.npmjs.com/package/@earendil-works/pi-ai) for multi-provider LLM access. Instead of a flat toolbox of `read_file`/`write_file`/`bash`/`grep`-style tools, it gives the model exactly one tool: a long-lived, stateful CPython kernel it drives via `ipython`. Every file edit, shell command, and web request the agent makes is Python code it writes and runs itself, in a REPL that stays alive and keeps its variables across the whole conversation.

That kernel has one more trick: from inside it, the model can call `await rlm.run("do this sub-task")` and get back a fresh, fully independent child agent — its own kernel, its own conversation, its own token budget — that runs the sub-task to completion and returns a plain-text answer. This is the **Recursive Language Model (RLM)** pattern: instead of one context window doing everything, an agent can decompose a large task into depth-limited child agents, recursively, entirely from Python it wrote itself.

```
curl -fsSL https://raw.githubusercontent.com/PRoIISHAAN/NanoCode/main/install.sh | bash
nanocode
```

## Contents

- [Why a single Python-REPL tool](#why-a-single-python-repl-tool)
- [Architecture](#architecture)
- [Getting started](#getting-started)
- [Using the headless CLI](#using-the-headless-cli)
- [Configuration](#configuration)
- [Memory model](#memory-model)
- [MCP (Model Context Protocol)](#mcp-model-context-protocol)
- [Trust and sandboxing](#trust-and-sandboxing)
- [Known limitations](#known-limitations)

## Why a single Python-REPL tool

Most coding agents expose a curated set of tools — read a file, write a file, run a shell command, search text — and the model calls them one at a time, each call round-tripping through the host process. nanocode instead gives the model one persistent, general-purpose execution environment and lets it write whatever Python it needs to get the job done: `open()`/`pathlib` for file I/O, `subprocess` for shell commands, loops and helper functions it defines once and reuses for the rest of the session, `requests`/`httpx` for network access if installed.

The kernel is a real, stateful REPL — not a fresh subprocess per call — so a variable, an imported module, or an open file handle from three turns ago is still there. And because the "tool" is just Python, recursion falls out of it almost for free: `rlm.run(...)` is a normal `async` function call the model can put anywhere its own code would go, including inside a loop, a `try`/`except`, or a helper it defines itself.

## Architecture

nanocode is an npm workspaces monorepo. Each package has one job:

| Package | What it is |
|---|---|
| `packages/kernel` | The persistent Python REPL process manager: spawns `python3`, speaks newline-delimited JSON over stdio, exposes a generic `host_request`/`host_reply` bridge for Python to call back into the TypeScript host (this is what `rlm.run` and MCP tool calls both ride on), and supports snapshot/restore via `dill`. |
| `packages/ai` | A thin wrapper around `@earendil-works/pi-ai`'s provider/model registry, auth, and credential storage — the only package that talks to LLM providers directly. |
| `packages/agent` | The agent loop itself: `Session` (conversation state + streaming), the `ipython` tool, RLM recursion (`rlm.run`'s host-side handler), tiered memory (task state + recall), MCP client management, project trust, sandbox selection, and local telemetry. |
| `packages/tui` | The interactive terminal UI: an Ink/React app rendered into a real alternate-screen buffer, with a fine-grained (`atom()` + `useSyncExternalStore`) reactive state layer to stay responsive under high-frequency token streaming. |
| `packages/cli` | The `nanocode` binary: wires `agent`/`ai`/`kernel`/`tui` together behind one entrypoint with two modes — bare `nanocode` (interactive TUI) and `nanocode run "<prompt>"` (headless, one-shot). `scripts/build.mjs` bundles it (plus `agent`/`ai`/`kernel`/`tui`'s own source) into one self-contained `dist/cli.js` for the global install. |
| `packages/evals` | A golden-dataset regression harness: runs the same prompts against a baseline and a candidate model config in one invocation and prints a comparison report. |


## Getting started

**Prerequisites:** Node.js ≥ 20, Python ≥ 3.11 on your `PATH` as `python3` (override with `NANOCODE_KERNEL_PYTHON`), and an API key (or OAuth login) for at least one supported provider.

### Install it globally

```bash
curl -fsSL https://raw.githubusercontent.com/PRoIISHAAN/NanoCode/main/install.sh | bash
```

This clones nanocode into `~/.nanocode/repo` (or updates it in place if you already ran this before), builds it, and puts a `nanocode` command on your `PATH` — from then on, just type `nanocode` from any directory. Bare `nanocode` launches the interactive TUI; `nanocode run "<prompt>"` runs one prompt headlessly.

Already have a local clone? Run `./install.sh` from inside it instead — it builds and links that checkout directly, and `git pull` + re-running `./install.sh` is how you update.

### Or run it from source

```bash
git clone https://github.com/PRoIISHAAN/NanoCode.git
cd NanoCode
npm install
```

run one prompt headlessly and exit:

```bash
export NANOCODE_PROVIDER=anthropic
export NANOCODE_MODEL=claude-sonnet-5
npm run cli -- run "compute 17*23 in python and print it"
# 391
```

### Keybindings

| Keys | Action |
|---|---|
| `escape` | Interrupt the current turn |
| `ctrl+c` | Clear the prompt box |
| `ctrl+c` twice | Exit |
| `ctrl+d` (empty box) | Exit |
| `ctrl+z` | Suspend |
| `ctrl+k` | Delete to end of line |
| `shift+tab` | Cycle reasoning effort |
| `ctrl+p` / `ctrl+shift+p` | Cycle models |
| `ctrl+l` | Open the model picker |
| `ctrl+o` | Expand/collapse tool output |
| `ctrl+t` | Toggle thinking visibility |
| `ctrl+g` | Open your `$EDITOR` |
| `/` | Open command menu |
| `!<command>` | Run a shell command (its output joins the conversation) |
| `!!<command>` | Run a shell command without adding it to the conversation |
| `option+enter` | Insert a newline |
| `enter` while a turn is running | Queue a follow-up message |
| `option+up` | Recall all queued messages back into the box for editing |
| `ctrl+v` | Paste an image (falls back to text) |
| drop a file onto the terminal | Attach it |

### Slash commands

| Command | Description |
|---|---|
| `/new`, `/clear` | Start a fresh session (new kernel, empty history) |
| `/resume [id]` | Resume a past session's messages into this one |
| `/compact` | Compress older history to free up context |
| `/model [provider] [model]` | Switch model among already-configured providers, keeping history |
| `/login [provider]` | Add or replace a provider's API key or OAuth session |
| `/logout [provider]` | Remove a stored credential |
| `/effort [level]` | Change reasoning effort for future turns |
| `/status` | Show model, tokens, and cost so far |
| `/context` | Detailed context-window breakdown |
| `/diff` | Show `git diff` for the working directory |
| `/copy` | Copy the last assistant response to the clipboard |
| `/export [json\|md]` | Export the transcript to a file |
| `/init` | Ask the model to scan the repo and write project instructions |
| `/settings` | Show current configuration |
| `/help` | List every command and keybinding |

## Using the headless CLI

```bash
nanocode run "<prompt>"
```

Runs one prompt to completion, prints the final assistant text, and exits with a nonzero status if the run errored or was aborted. Uses the same setup path (provider resolution, project trust check, kernel/session construction) as the TUI, so anything you can configure for one applies to the other.

## Configuration

Everything is environment-variable driven — there's no config file to hand-edit for basic use.

| Variable | Purpose | Default |
|---|---|---|
| `NANOCODE_PROVIDER` | Provider id to use (`anthropic`, `openai`, `google`, ...) | none — must be set, or chosen via the TUI's onboarding flow |
| `NANOCODE_MODEL` | Model id within that provider | none |
| `NANOCODE_KERNEL_PYTHON` | Path to a Python ≥ 3.11 interpreter | `python3` |
| `NANOCODE_SANDBOX` | `plain` or `docker` | `plain` |
| `NANOCODE_SANDBOX_IMAGE` | Docker image used when `NANOCODE_SANDBOX=docker` | `nanocode-kernel:latest` |
| `NANOCODE_TRUST` | `always`, `once`, or `never` — skips the interactive trust prompt | none (prompts interactively) |
| `NANOCODE_MCP_SERVERS` | Overrides the default MCP config file location | none |
| `NANOCODE_TELEMETRY_ENDPOINT` | URL to POST telemetry span batches to | none (telemetry stays in-memory only) |

Provider credentials (API keys entered through `/login`, OAuth tokens) persist in `~/.nanocode/credentials.json`. MCP server definitions live in `~/.nanocode/mcp.json` (global, not per-project).

## Memory model

nanocode splits conversation context into four tiers instead of one flat message list:

1. **System prompt** — fixed, never touched by compaction.
2. **Task state** — a small scratchpad the model itself maintains (`task_state.set(...)` from inside the kernel) and that always gets re-injected in full, even after compaction. For goals and constraints that must never be forgotten.
3. **Recent context** — the last N turns, kept verbatim.
4. **Archived history** — everything older gets summarized out of the live context but stays searchable via `recall_search(query)` and retrievable in full via `recall(id)`, ARC-style.

This means a long-running session can compact away its oldest turns without losing the thread on what it's actually trying to accomplish.

## MCP (Model Context Protocol)

MCP servers (stdio or Streamable HTTP transport) are configured globally in `~/.nanocode/mcp.json` and bound directly into the kernel's Python namespace — there's no separate "MCP tool" call type. From inside the REPL:

```python
result = await mcp.call_tool("my-server", "some_tool", {"arg": "value"})
```

This mirrors how the rest of the kernel works: everything the model does is Python it writes, including reaching an MCP server.

## Trust and sandboxing

The first time nanocode runs in a directory, it asks whether to trust it — declining (or `NANOCODE_TRUST=never`) means no kernel is ever started and no code runs. This check exists on every invocation because nanocode's only tool is unrestricted code execution; there's no per-call permission system beyond it.

By default the kernel runs as a plain local subprocess with your own privileges (`NANOCODE_SANDBOX=plain`). Setting `NANOCODE_SANDBOX=docker` runs it inside a container instead, using `NANOCODE_SANDBOX_IMAGE` (build one from `packages/kernel/python` if you need one).

**Be aware:** there is no built-in fine-grained permission or risk classification for what the model's code is allowed to do beyond the trust prompt and the sandbox boundary — this is the standing top security consideration for this project, not a fully solved problem. Treat any directory you trust nanocode in the same way you'd treat handing someone a shell in it.

## Known limitations

- No fine-grained tool-permission system — every kernel action runs at your full privilege level (see [Trust and sandboxing](#trust-and-sandboxing)).
- Sessions are in-process only for now; there's no daemon/background-session-reattach mode (a design seam for one exists, but it isn't built).
- Episodic memory (learning across separate sessions, not just within one) is explicitly out of scope for the current memory architecture.
