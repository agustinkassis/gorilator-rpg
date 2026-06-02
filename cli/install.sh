#!/usr/bin/env bash
#
# Gorilator one-line bootstrap for a fresh box — installs prerequisites, fetches
# the source, and runs the native installer. No Node, no Docker required up front.
#
#   curl -fsSL https://raw.githubusercontent.com/agustinkassis/gorilator-rpg/main/cli/install.sh | sudo bash
#
# Override the source/target with env vars:
#   GORILATOR_REPO=https://github.com/you/fork.git GORILATOR_REF=main \
#   GORILATOR_DIR=/opt/gorilator sudo -E bash install.sh
#
set -euo pipefail

REPO="${GORILATOR_REPO:-https://github.com/agustinkassis/gorilator-rpg.git}"
REF="${GORILATOR_REF:-main}"
default_dir() { [ "$(uname -s)" = "Darwin" ] && echo "$HOME/.gorilator/app" || echo "/opt/gorilator"; }
INSTALL_DIR="${GORILATOR_DIR:-$(default_dir)}"

SUDO=""
[ "$(id -u)" -ne 0 ] && command -v sudo >/dev/null 2>&1 && SUDO="sudo"

echo "🦍 Gorilator bootstrap"
echo "   repo: $REPO ($REF)"
echo "   dir:  $INSTALL_DIR"

# git is the only prerequisite the bootstrap itself needs (the CLI installs the
# rest: Node, pnpm, dependencies). Node is ensured by cli/gorilator.
if ! command -v git >/dev/null 2>&1; then
  echo "==> Installing git…"
  if command -v apt-get >/dev/null 2>&1; then
    $SUDO apt-get update -y && $SUDO apt-get install -y git
  else
    echo "git is required but not installed, and no apt-get was found. Install git and re-run." >&2
    exit 1
  fi
fi

# Fetch the source into the install dir; the CLI reuses this very checkout
# (GORILATOR_DIR below) so there's a single copy on disk.
if [ -d "$INSTALL_DIR/.git" ]; then
  echo "==> Updating existing checkout…"
  $SUDO git -C "$INSTALL_DIR" fetch --depth 1 origin "$REF" \
    && $SUDO git -C "$INSTALL_DIR" checkout -f FETCH_HEAD || true
else
  echo "==> Cloning…"
  $SUDO mkdir -p "$(dirname "$INSTALL_DIR")"
  $SUDO git clone --depth 1 --branch "$REF" "$REPO" "$INSTALL_DIR"
fi

# When we cloned as root via sudo, hand the tree to the invoking user so the
# daemon's later unprivileged build steps can write to it.
if [ -n "${SUDO_USER:-}" ]; then
  $SUDO chown -R "$SUDO_USER" "$INSTALL_DIR" 2>/dev/null || true
fi
$SUDO chmod +x "$INSTALL_DIR/cli/gorilator" "$INSTALL_DIR/cli/install.sh" 2>/dev/null || true

# Use this checkout as the install dir (no second clone), then hand off to the
# native installer. Reconnect stdin to the terminal so prompts work under
# `curl | bash`.
export GORILATOR_DIR="$INSTALL_DIR"
echo "==> Launching the installer…"
if { true </dev/tty; } 2>/dev/null; then
  bash "$INSTALL_DIR/cli/gorilator" install </dev/tty
else
  bash "$INSTALL_DIR/cli/gorilator" install
fi
