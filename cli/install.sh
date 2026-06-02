#!/usr/bin/env bash
#
# Gorilator one-line bootstrap for a fresh box: installs bootstrap prerequisites,
# fetches the source, and runs the native installer. No Node or Docker required.
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

need_privilege() {
  if [ "$(id -u)" -ne 0 ] && [ -z "$SUDO" ]; then
    echo "sudo is required to install system packages. Re-run as root or install sudo first." >&2
    exit 1
  fi
}

install_apt_prereqs() {
  need_privilege
  echo "==> Installing bootstrap prerequisites (ca-certificates, curl, git)…"
  $SUDO env DEBIAN_FRONTEND=noninteractive apt-get update -y
  $SUDO env DEBIAN_FRONTEND=noninteractive apt-get install -y ca-certificates curl git
}

ensure_bootstrap_prereqs() {
  local missing=0
  command -v git >/dev/null 2>&1 || missing=1
  command -v curl >/dev/null 2>&1 || missing=1
  [ -f /etc/ssl/certs/ca-certificates.crt ] || missing=1

  if [ "$missing" -eq 0 ]; then
    return
  fi

  if [ "$(uname -s)" = "Linux" ] && command -v apt-get >/dev/null 2>&1; then
    install_apt_prereqs
  fi

  command -v git >/dev/null 2>&1 || {
    echo "git is required but not installed. Install git and re-run." >&2
    exit 1
  }
  command -v curl >/dev/null 2>&1 || {
    echo "curl is required but not installed. Install curl and re-run." >&2
    exit 1
  }
}

# The bootstrap needs git/curl/CA certificates. The wrapped CLI then installs
# Node 20, pnpm, workspace dependencies, cloudflared, and the OS services.
ensure_bootstrap_prereqs

# Fetch the source into the install dir; the CLI reuses this very checkout
# (GORILATOR_DIR below) so there's a single copy on disk.
if [ -d "$INSTALL_DIR/.git" ]; then
  echo "==> Updating existing checkout…"
  $SUDO git -C "$INSTALL_DIR" fetch --depth 1 origin "$REF"
  $SUDO git -C "$INSTALL_DIR" checkout -f FETCH_HEAD
elif [ -e "$INSTALL_DIR" ] && [ -n "$(find "$INSTALL_DIR" -mindepth 1 -print -quit 2>/dev/null)" ]; then
  echo "$INSTALL_DIR already exists and is not an empty Gorilator checkout. Move it aside and re-run." >&2
  exit 1
elif [ -e "$INSTALL_DIR" ] && [ ! -d "$INSTALL_DIR" ]; then
  echo "$INSTALL_DIR already exists and is not a directory. Move it aside and re-run." >&2
  exit 1
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
export GORILATOR_REPO="$REPO"
export GORILATOR_REF="$REF"
export GORILATOR_DIR="$INSTALL_DIR"
echo "==> Launching the installer…"
if { true </dev/tty; } 2>/dev/null; then
  bash "$INSTALL_DIR/cli/gorilator" install </dev/tty
else
  bash "$INSTALL_DIR/cli/gorilator" install
fi
