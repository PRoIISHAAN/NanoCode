#!/usr/bin/env bash
# Installs nanocode as a global `nanocode` command, launchable from any directory the same way
# `prime`/`claude` are -- just type `nanocode`.
#
#   curl -fsSL https://raw.githubusercontent.com/PRoIISHAAN/NanoCode/main/install.sh | bash
#
# Works two ways:
#   - Piped via curl (no existing clone): clones nanocode into a managed directory
#     (~/.nanocode/repo) and builds it there. Re-running the same command later `git pull`s that
#     clone to update instead of re-cloning.
#   - Run locally as `./install.sh` from inside an existing checkout of this repo: builds THAT
#     checkout in place, exactly like before -- no separate clone, `git pull` + re-running is how
#     you update.
#
# Either way, once built:
#   1. Prerequisites are checked (git if cloning, Node >=20, Python >=3.11, npm).
#   2. `npm install` runs if dependencies aren't already installed.
#   3. The `nanocode` binary is built (packages/cli/scripts/build.mjs bundles the cli/agent/ai/
#      kernel/tui packages' TypeScript SOURCE directly into one self-contained JS file --
#      packages/cli/dist/cli.js -- so the installed command starts fast and doesn't need `tsx`
#      transpiling six packages on every launch).
#   4. That file is symlinked onto your PATH as `nanocode` (default: ~/.local/bin), adding that
#      directory to your shell profile if it isn't on PATH already.
#
# Safe to re-run: every step is idempotent (an existing clone is updated via `git pull`, not
# re-cloned from scratch; an existing symlink is replaced, not duplicated; a PATH line is only
# appended to your shell profile if it isn't there already).
set -euo pipefail

REPO_URL="${NANOCODE_INSTALL_REPO_URL:-https://github.com/PRoIISHAAN/NanoCode.git}"
REPO_REF="${NANOCODE_INSTALL_REF:-}"
MANAGED_CLONE_DIR="${NANOCODE_INSTALL_DIR:-$HOME/.nanocode/repo}"
BIN_DIR="${NANOCODE_INSTALL_BIN_DIR:-$HOME/.local/bin}"
BIN_NAME="nanocode"

info()  { printf '\033[1;34m==>\033[0m %s\n' "$1"; }
warn()  { printf '\033[1;33mwarning:\033[0m %s\n' "$1" >&2; }
fail()  { printf '\033[1;31merror:\033[0m %s\n' "$1" >&2; exit 1; }

# --- 0. Figure out which checkout to build ------------------------------------------------------
#
# `${BASH_SOURCE[0]}` only resolves to a real file when this script is actually saved and run
# (`./install.sh`, or `bash install.sh`) -- when it's piped straight into bash (`curl ... | bash`),
# there is no file at all, so this check naturally falls through to the clone-and-build path below.
LOCAL_CANDIDATE="${BASH_SOURCE[0]:-}"
if [ -n "$LOCAL_CANDIDATE" ] && [ -f "$LOCAL_CANDIDATE" ]; then
  LOCAL_CANDIDATE="$(cd "$(dirname "$LOCAL_CANDIDATE")" && pwd)"
fi

is_nanocode_checkout() {
  [ -f "$1/package.json" ] && grep -q '"name": *"nanocode-monorepo"' "$1/package.json" 2>/dev/null
}

if [ -n "$LOCAL_CANDIDATE" ] && is_nanocode_checkout "$LOCAL_CANDIDATE"; then
  REPO_ROOT="$LOCAL_CANDIDATE"
  info "Building the existing checkout at $REPO_ROOT."
else
  command -v git >/dev/null 2>&1 || fail "git is required to install nanocode this way. Install git and re-run."
  if [ -d "$MANAGED_CLONE_DIR/.git" ]; then
    info "Updating existing nanocode checkout at $MANAGED_CLONE_DIR..."
    git -C "$MANAGED_CLONE_DIR" fetch --tags --quiet origin
    if [ -n "$REPO_REF" ]; then
      git -C "$MANAGED_CLONE_DIR" checkout --quiet "$REPO_REF"
    fi
    git -C "$MANAGED_CLONE_DIR" pull --ff-only --quiet
  else
    info "Cloning nanocode into $MANAGED_CLONE_DIR..."
    mkdir -p "$(dirname "$MANAGED_CLONE_DIR")"
    if [ -n "$REPO_REF" ]; then
      git clone --quiet --branch "$REPO_REF" "$REPO_URL" "$MANAGED_CLONE_DIR"
    else
      git clone --quiet "$REPO_URL" "$MANAGED_CLONE_DIR"
    fi
  fi
  REPO_ROOT="$MANAGED_CLONE_DIR"
fi

CLI_BUNDLE="$REPO_ROOT/packages/cli/dist/cli.js"

# --- 1. Prerequisites -------------------------------------------------------------------------

is_probably_wsl() {
  [ -r /proc/version ] && grep -qi "microsoft" /proc/version 2>/dev/null
}

if ! command -v node >/dev/null 2>&1; then
  if is_probably_wsl; then
    fail "Node.js was not found on PATH -- inside WSL, not your Windows PATH. Node installed via the Windows installer isn't visible here: WSL is a separate Linux environment. Install Node >= 20 INSIDE this WSL distro instead (e.g. \`sudo apt update && sudo apt install -y nodejs npm\`, or use nvm: https://github.com/nvm-sh/nvm), or run this script from Git Bash instead of a WSL/cmd bash.exe if you'd rather use your existing Windows Node install."
  fi
  fail "Node.js was not found on PATH. Install Node >= 20 first: https://nodejs.org"
fi
command -v npm  >/dev/null 2>&1 || fail "npm was not found on PATH (it normally ships with Node)."

NODE_MAJOR="$(node -e 'process.stdout.write(String(process.versions.node.split(".")[0]))')"
if [ "$NODE_MAJOR" -lt 20 ]; then
  fail "nanocode needs Node >= 20 (found $(node --version)). Install a newer Node and re-run this script."
fi

# Python is only needed to actually RUN nanocode (it spawns a python3 kernel process), not to
# install/build it -- checked here anyway so a misconfigured machine fails with a clear message
# now instead of a confusing one the first time you send a prompt.
PYTHON_BIN="${NANOCODE_KERNEL_PYTHON:-python3}"
if ! command -v "$PYTHON_BIN" >/dev/null 2>&1; then
  warn "$PYTHON_BIN was not found on PATH. nanocode needs Python >= 3.11 to actually run (set \$NANOCODE_KERNEL_PYTHON to override which interpreter it uses)."
else
  PYTHON_OK="$("$PYTHON_BIN" -c 'import sys; print(1 if sys.version_info >= (3, 11) else 0)' 2>/dev/null || echo 0)"
  if [ "$PYTHON_OK" != "1" ]; then
    warn "$($PYTHON_BIN --version 2>&1) was found, but nanocode needs Python >= 3.11."
  fi
fi

# --- 2. Dependencies ---------------------------------------------------------------------------

if [ ! -d "$REPO_ROOT/node_modules" ]; then
  info "Installing dependencies (npm install)..."
  (cd "$REPO_ROOT" && npm install)
else
  info "Dependencies already installed, skipping npm install (delete node_modules to force a reinstall)."
fi

# --- 3. Build ------------------------------------------------------------------------------------

info "Building the nanocode binary..."
(cd "$REPO_ROOT" && npm run build --workspace=@nanocode/cli)

[ -f "$CLI_BUNDLE" ] || fail "Build finished but $CLI_BUNDLE is missing -- check the build output above."
chmod +x "$CLI_BUNDLE"

# --- 4. Put it on PATH ---------------------------------------------------------------------------

mkdir -p "$BIN_DIR"
ln -sf "$CLI_BUNDLE" "$BIN_DIR/$BIN_NAME"
info "Linked $BIN_DIR/$BIN_NAME -> $CLI_BUNDLE"

path_has_bin_dir() {
  case ":$PATH:" in
    *":$BIN_DIR:"*) return 0 ;;
    *) return 1 ;;
  esac
}

detect_shell_profile() {
  case "${SHELL:-}" in
    */zsh)  printf '%s' "${ZDOTDIR:-$HOME}/.zshrc" ;;
    */bash) printf '%s' "$HOME/.bashrc" ;;
    *)
      if [ -f "$HOME/.zshrc" ]; then printf '%s' "$HOME/.zshrc"
      elif [ -f "$HOME/.bashrc" ]; then printf '%s' "$HOME/.bashrc"
      else printf '%s' "$HOME/.profile"
      fi
      ;;
  esac
}

if path_has_bin_dir; then
  info "$BIN_DIR is already on PATH."
else
  PROFILE="$(detect_shell_profile)"
  PATH_LINE="export PATH=\"$BIN_DIR:\$PATH\""
  if [ -f "$PROFILE" ] && grep -F "$BIN_DIR" "$PROFILE" >/dev/null 2>&1; then
    info "$PROFILE already references $BIN_DIR -- restart your shell (or source it) to pick it up."
  else
    mkdir -p "$(dirname "$PROFILE")"
    {
      printf '\n# Added by nanocode'"'"'s install.sh\n'
      printf '%s\n' "$PATH_LINE"
    } >>"$PROFILE"
    info "Added $BIN_DIR to PATH in $PROFILE."
  fi
fi

echo
echo "nanocode is installed."
if path_has_bin_dir; then
  echo "Run it now: nanocode"
else
  echo "Restart your shell (or run: source $(detect_shell_profile)) then run: nanocode"
fi
