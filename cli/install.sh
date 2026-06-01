#!/usr/bin/env bash
#
# Gorilator bootstrap — clone the repo and run the installer.
#
#   curl -fsSL https://raw.githubusercontent.com/agustinkassis/gorilator-rpg/main/cli/install.sh | sudo bash
#
# Override the source/target with env vars:
#   GORILATOR_REPO=https://github.com/you/fork.git GORILATOR_DIR=/opt/gorilator-rpg sudo -E bash install.sh
#
set -euo pipefail

REPO="${GORILATOR_REPO:-https://github.com/agustinkassis/gorilator-rpg.git}"
INSTALL_DIR="${GORILATOR_DIR:-/opt/gorilator-rpg}"
SUDO=""
[ "$(id -u)" -ne 0 ] && SUDO="sudo"

echo "🦍 Gorilator bootstrap"
echo "   repo: $REPO"
echo "   dir:  $INSTALL_DIR"

# git is the only prerequisite the installer itself needs.
if ! command -v git >/dev/null 2>&1; then
  echo "==> Installing git…"
  $SUDO apt-get update -y && $SUDO apt-get install -y git
fi

if [ -d "$INSTALL_DIR/.git" ]; then
  echo "==> Updating existing checkout…"
  $SUDO git -C "$INSTALL_DIR" pull --ff-only || true
else
  echo "==> Cloning…"
  $SUDO mkdir -p "$(dirname "$INSTALL_DIR")"
  $SUDO git clone "$REPO" "$INSTALL_DIR"
fi

$SUDO chmod +x "$INSTALL_DIR/cli/gorilator" "$INSTALL_DIR/cli/install.sh" 2>/dev/null || true

echo "==> Launching the installer…"
# Reconnect stdin to the terminal so prompts work even when this script was
# piped from curl.
if [ -e /dev/tty ]; then
  "$INSTALL_DIR/cli/gorilator" install </dev/tty
else
  "$INSTALL_DIR/cli/gorilator" install
fi
