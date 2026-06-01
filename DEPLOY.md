# 🦍 Deploying Gorilator

One command turns a fresh Linux server into a public, multiplayer Gorilator RPG —
Docker for the game, Cloudflare Tunnel for HTTPS + WebSockets, no open firewall ports.

```
Browser ── https ──▶ Cloudflare ──┬─▶ play.<domain>  ─▶ :80    client (nginx, static Babylon/Vite)
                                  └─▶ api.<domain>   ─▶ :2567  server (Colyseus, WebSocket + monitor)
```

---

## Prerequisites

- A **Linux server** (Debian/Ubuntu recommended) you can SSH into.
- A **domain managed by Cloudflare** (the nameservers point at Cloudflare). The
  free plan is fine. You do **not** need to pre-create any DNS records — the
  installer makes them.
- That's it. The installer adds Docker and cloudflared for you.

---

## Quick start (one command)

SSH into the server and run:

```bash
curl -fsSL https://raw.githubusercontent.com/agustinkassis/gorilator-rpg/main/cli/install.sh | sudo bash
```

The installer will, in order:

1. Install **git** (if missing) and clone the repo to `/opt/gorilator-rpg`.
2. Ask to install **Docker** (official `get.docker.com`) — *you confirm first*.
3. Ask to install **cloudflared** (architecture-matched `.deb`) — *you confirm first*.
4. Make `gorilator` runnable globally (`/usr/local/bin/gorilator`).
5. Ask for your **base domain** and suggest two subdomains:
   - `play.<domain>` → the game client (port 80)
   - `api.<domain>` → the game server (port 2567)
6. Open a **Cloudflare authorization** link (paste it into any browser, pick your
   domain), then auto-create the tunnel, the two DNS records, and the ingress.
7. Generate `.env` (incl. a random monitor password) and **build + start** the stack.
8. Install a **systemd service** so the game and the tunnel come back on reboot.

When it finishes it prints your live URLs and the monitor credentials.

> Already cloned it (or using a fork)? From inside the repo:
> ```bash
> pnpm run setup            # same as ./cli/gorilator install (self-elevates with sudo)
> # or point the bootstrap at your fork:
> GORILATOR_REPO=https://github.com/you/fork.git sudo -E bash cli/install.sh
> ```
> After install, `pnpm gorilator <cmd>` works too (e.g. `pnpm gorilator status`).

---

## Managing it — the `gorilator` CLI

```
gorilator status        Show running game servers + public URLs
gorilator start         Start the stack (docker compose up -d)
gorilator stop          Stop the stack (docker compose down)
gorilator restart       Recreate and restart the stack
gorilator logs [svc]    Tail logs — svc = server | client | tunnel (default: all)
gorilator monitor       Print the /colyseus monitor URL + credentials
gorilator update        git pull, rebuild, redeploy
gorilator tunnel <cmd>  Cloudflare tunnel — login | status | restart
gorilator uninstall     Stop & disable services (your files stay)
```

`gorilator status` is the **"show me the game servers"** view: container health,
tunnel state, and the public URLs.

---

## Running locally / without Cloudflare

The stack is plain Docker Compose, so you can run it on any machine:

```bash
cp .env.example .env          # optional; leave VITE_SERVER_URL empty for localhost
docker compose up -d --build
```

- Open <http://localhost> — the client loads and connects to `ws://localhost:2567`
  (the empty `VITE_SERVER_URL` fallback).
- `http://localhost:2567/` → the server health banner.
- With `MONITOR_USER`/`MONITOR_PASS` set in `.env`, the monitor at
  `http://localhost:2567/colyseus` requires those credentials; leave them empty
  to keep it open (local dev only).

---

## How it works

- **Client image** (`Dockerfile.client`): builds the Vite bundle and serves it
  with nginx. The server URL is baked in at build time via `VITE_SERVER_URL`
  (e.g. `wss://api.<domain>`) because the browser must reach the server on its
  own subdomain over 443 — not `:2567`.
- **Server image** (`Dockerfile.server`): the Colyseus server on port 2567
  (HTTP + WebSocket + the `/colyseus` monitor on the same port).
- **Cloudflare tunnel** runs natively on the host as a systemd service
  (`cloudflared`), forwarding `play.<domain>`→`localhost:80` and
  `api.<domain>`→`localhost:2567`. Config lives in `/etc/cloudflared/config.yml`.
- **Persistence**: `restart: unless-stopped` on the containers + the
  `gorilator.service` and `cloudflared` systemd units bring everything back
  after a reboot.

### Security notes

- The `/colyseus` monitor can inspect and **dispose live rooms**, so it is
  **password-protected** by default (HTTP Basic auth, random password in `.env`,
  shown by `gorilator monitor`). Change it by editing `MONITOR_PASS` in `.env`
  and running `gorilator restart`.
- `.env` contains that password and is world-readable on the host; keep the
  server to trusted admins, or `chmod 600 .env` and run `gorilator` with `sudo`.
- No game ports are exposed to the public internet directly — all traffic
  arrives through the Cloudflare tunnel.

---

## Troubleshooting

| Symptom | Fix |
|---|---|
| Client loads but can't connect | Check `VITE_SERVER_URL` in `.env` matches `wss://<server-subdomain>`, then `gorilator update` (rebuilds the client). |
| `502` from Cloudflare | Game not up yet: `gorilator status`, `gorilator logs server`. |
| Tunnel down | `sudo gorilator tunnel status` / `sudo gorilator tunnel restart`. |
| `docker` permission denied | You were added to the `docker` group during install — log out and back in (or use `sudo gorilator …`). |
| DNS not resolving | The tunnel created CNAMEs in Cloudflare; allow a minute and confirm the records exist in the dashboard. |

Update to the latest code anytime with `gorilator update`.
