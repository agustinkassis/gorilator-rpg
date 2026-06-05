#!/usr/bin/env bash
#
# Gorilator one-line bootstrap for a fresh Linux/macOS box — installs
# prerequisites, fetches the source, and runs the native installer. No Node, no
# Docker required up front.
#
#   curl -fsSL https://raw.githubusercontent.com/agustinkassis/gorilator-rpg/main/packages/cli/install.sh | sudo bash
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
TARGET_USER="${SUDO_USER:-$(id -un)}"

die() {
  echo "Error: $*" >&2
  exit 1
}

run_privileged() {
  if [ "$(id -u)" -eq 0 ]; then
    "$@"
  elif [ -n "$SUDO" ]; then
    $SUDO "$@"
  else
    die "Need root privileges to run: $*. Re-run with sudo or as root."
  fi
}

install_packages() {
  if command -v apt-get >/dev/null 2>&1; then
    run_privileged apt-get update -y
    run_privileged env DEBIAN_FRONTEND=noninteractive apt-get install -y "$@"
  elif command -v dnf >/dev/null 2>&1; then
    run_privileged dnf install -y "$@"
  elif command -v yum >/dev/null 2>&1; then
    run_privileged yum install -y "$@"
  elif command -v zypper >/dev/null 2>&1; then
    run_privileged zypper --non-interactive install "$@"
  elif command -v apk >/dev/null 2>&1; then
    run_privileged apk add --no-cache "$@"
  elif command -v pacman >/dev/null 2>&1; then
    run_privileged pacman -Sy --noconfirm --needed "$@"
  elif [ "$(uname -s)" = "Darwin" ] && command -v brew >/dev/null 2>&1; then
    brew install "$@"
  else
    die "No supported package manager found. Install these manually and re-run: $*"
  fi
}

ensure_command() {
  _cmd="$1"
  shift
  if command -v "$_cmd" >/dev/null 2>&1; then
    return 0
  fi
  echo "==> Installing $_cmd…"
  install_packages "$@"
  command -v "$_cmd" >/dev/null 2>&1 || die "$_cmd was not found after installation."
}

echo "🦍 Gorilator bootstrap"
echo "   repo: $REPO ($REF)"
echo "   dir:  $INSTALL_DIR"

# The bootstrap needs git to fetch the repo, and curl/CA certs because the
# wrapper may need to install Node from an upstream setup script.
ensure_command git git
ensure_command curl curl ca-certificates

# Fetch the source into the install dir; the CLI reuses this very checkout
# (GORILATOR_DIR below) so there's a single copy on disk.
if [ -d "$INSTALL_DIR/.git" ]; then
  echo "==> Updating existing checkout…"
  if [ -w "$INSTALL_DIR/.git" ]; then
    git -C "$INSTALL_DIR" fetch --depth 1 origin "$REF"
    git -C "$INSTALL_DIR" checkout -f FETCH_HEAD
  else
    run_privileged git -C "$INSTALL_DIR" fetch --depth 1 origin "$REF"
    run_privileged git -C "$INSTALL_DIR" checkout -f FETCH_HEAD
  fi
elif [ -e "$INSTALL_DIR" ] && [ ! -d "$INSTALL_DIR" ]; then
  echo "$INSTALL_DIR already exists and is not a directory. Move it aside and re-run." >&2
  exit 1
elif [ -e "$INSTALL_DIR" ] && [ -n "$(find "$INSTALL_DIR" -mindepth 1 -print -quit 2>/dev/null)" ]; then
  echo "$INSTALL_DIR already exists and is not an empty Gorilator checkout. Move it aside and re-run." >&2
  exit 1
else
  echo "==> Cloning…"
  if mkdir -p "$(dirname "$INSTALL_DIR")" 2>/dev/null; then
    git clone --depth 1 --branch "$REF" "$REPO" "$INSTALL_DIR"
  else
    run_privileged mkdir -p "$(dirname "$INSTALL_DIR")"
    run_privileged git clone --depth 1 --branch "$REF" "$REPO" "$INSTALL_DIR"
  fi
fi

# When we cloned with elevated privileges, hand the tree to the target user so
# the daemon's later unprivileged build steps can write to it.
if [ "$TARGET_USER" != "root" ]; then
  chown -R "$TARGET_USER" "$INSTALL_DIR" 2>/dev/null || run_privileged chown -R "$TARGET_USER" "$INSTALL_DIR" 2>/dev/null || true
fi
chmod +x "$INSTALL_DIR/packages/cli/gorilator" "$INSTALL_DIR/packages/cli/install.sh" 2>/dev/null \
  || run_privileged chmod +x "$INSTALL_DIR/packages/cli/gorilator" "$INSTALL_DIR/packages/cli/install.sh" 2>/dev/null \
  || true

# Use this checkout as the install dir (no second clone), then hand off to the
# native installer. Reconnect stdin to the terminal so prompts work under
# `curl | bash`.
export GORILATOR_REPO="$REPO"
export GORILATOR_REF="$REF"
export GORILATOR_DIR="$INSTALL_DIR"
echo "==> Launching the installer…"
if { true </dev/tty; } 2>/dev/null; then
  bash "$INSTALL_DIR/packages/cli/gorilator" install </dev/tty
else
  bash "$INSTALL_DIR/packages/cli/gorilator" install
fi
