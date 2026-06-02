# 🦍 Deploying Gorilator

The default path is **native, no Docker**: the `gorilator` CLI clones the game, installs Node/pnpm/deps,
builds it, and runs it as a boot-persistent OS service (systemd/launchd). One native process serves the
game client, WebSocket, monitor, and API on the main server port; it can also expose an optional direct
local client port for convenience. An optional `gorilator setup` then exposes the main server port through
a Cloudflare Tunnel on your own game subdomain.

```
Direct:      http://host:2567   client + WebSocket   ┐  one native process
             http://host:8080   optional client page ┘  only with --client-port 8080

Cloudflare ─▶ game.<domain> ─▶ localhost:2567
              client page + WebSocket + monitor + API
```

For Cloudflare, the client bundle is built same-origin, so `https://game.<domain>` serves the page and the
browser dials `wss://game.<domain>` for multiplayer.

> Prefer containers? A Docker Compose stack + a one-click Railway template still ship in this repo — see
> [Alternative: Docker / Railway](#alternative-docker--railway) at the end.

---

## Prerequisites

- A **Linux server** (Debian/Ubuntu recommended) or a **macOS** machine.
- For public hosting: a **domain managed by Cloudflare** (free plan is fine). You do **not** pre-create any
  DNS records — `gorilator setup` makes them.
- Nothing else. The installer adds Node, pnpm, and (for `setup`) cloudflared for you. On a fresh
  Debian/Ubuntu box, the public bootstrap also installs `ca-certificates`, `curl`, and `git`.

---

## Quick start

**If you already have Node ≥ 20.6:**

```bash
npx gorilator install
```

**On a bare box (no Node yet) — one public bash file installs OS prerequisites + Node, then everything:**

```bash
curl -fsSL https://raw.githubusercontent.com/agustinkassis/gorilator-rpg/main/cli/install.sh | sudo bash
```

That public bootstrap fetches this repo and launches `./cli/gorilator install`, which runs the same native
CLI as `npx gorilator install`. The installer, in order:

1. Ensures **ca-certificates**, **curl**, **git**, **Node ≥ 20.6**, and **pnpm@10.14.0**
   (installing what's missing on supported systems).
2. Clones the game to `/opt/gorilator` (Linux) or `~/.gorilator/app` (macOS).
3. `pnpm install`, builds the shared schema, builds the client, and builds the CLI.
4. Generates `.env` — the server port, a random monitor password, **and** the server's Nostr key
   (`NOSTR_NSEC`, which signs players' progress saves).
5. Registers a **systemd**/**launchd** service, starts it, and waits for `/healthz`.
6. Prints the local URLs and the monitor credentials.

> Already have the repo checked out (or using a fork)? Everything also runs through the bundled wrapper,
> which executes the very same Node CLI:
> ```bash
> ./cli/gorilator install        # same as `npx gorilator install`
> GORILATOR_REPO=https://github.com/you/fork.git ./cli/gorilator install
> ```

---

## Go public — `gorilator setup`

```bash
gorilator setup
```

It opens an arrow-key menu with categories for server settings, server NSEC, Cloudflare, and
Colyseus/environment settings. Choosing Cloudflare install/update prompts for a base domain + one game
subdomain (default `game.<domain>`), then:

1. Installs & authorizes **cloudflared**, creates the `gorilator-rpg` tunnel, and routes DNS for that host.
2. Writes `/etc/cloudflared/config.yml` (macOS: `~/.cloudflared/config.yml`) with an ingress that routes
   `game.<domain>` → the server port.
3. Rebuilds the client same-origin (`VITE_SAME_ORIGIN=1`) and restarts the daemon — so the page,
   WebSocket/API, and monitor all share one HTTPS/WSS origin. Setup also disables the optional dedicated
   local client port, leaving one local game port behind the tunnel.
4. Runs `cloudflared` as a boot service and prints your public URLs + monitor credentials.

Re-run it anytime to change ports, update the server NSEC, change domains, remove local Cloudflare
settings, or edit supported environment values. For non-interactive Cloudflare automation set
`GORILATOR_DOMAIN` and optionally `GORILATOR_HOST`/`GORILATOR_GAME_HOST`.

---

## Managing it — the `gorilator` CLI

```
gorilator status        Service state + health + local & public URLs   (alias: info)
gorilator start         Start the daemon (prints the port it listens on)
gorilator stop          Stop the daemon
gorilator restart       Restart the daemon
gorilator logs          Stream server logs (Ctrl-C to detach)
gorilator update        stop services, git pull, rebuild, start services
gorilator setup         Interactive setup: server ports, NSEC, Cloudflare, env settings
gorilator tunnel <cmd>  Cloudflare tunnel — login | status | restart
gorilator uninstall     Stop & remove services, config, command, and installed files
```

The three entry points run **identical code** — `npx gorilator <cmd>`, the global `gorilator <cmd>`, and the
repo's `./cli/gorilator <cmd>` (which only adds: ensure Node, then exec the same Node CLI).

`gorilator uninstall` removes local machine state created by install/setup: the Gorilator daemon, local
cloudflared service/config, install record, global npm command, and installed app directory. Add
`--keep-files`, `--keep-command`, or `--keep-tunnel` when you want to preserve one of those pieces. It does
not delete account-level Cloudflare tunnel/DNS resources; remove those in Cloudflare if you no longer need them.

---

## Running locally / without Cloudflare

`gorilator install` already gives you a working, directly-reachable deploy:

- **Local game**: <http://localhost:2567> — client page + WebSocket + `/healthz` (`ok`) + the `/colyseus`
  monitor (gated by the `admin` user + the password in `.env`, shown by `gorilator status`).
- **Optional client page**: pass `--client-port 8080` if you also want <http://localhost:8080>.

Change ports with `--port` / `--client-port` (or `GAME_SERVER_PORT` / `CLIENT_PORT`). `gorilator status`
prints the active local URLs.

---

## How it works

- **One process, one public port**: `gorilator serve` runs the Colyseus server from TS via `tsx`. The server
  port answers the client page, WebSocket, `/colyseus`, `/api/*`, and `/healthz`. A separate client listener is
  only created for explicit legacy `--client-port` deploys.
- **The service** (`gorilator.service` / `com.gorilator.daemon`) runs `gorilator serve` as your user and
  restarts on failure. Its `ExecStart` points at the in-repo CLI build (`<appDir>/packages/cli/dist`), so the
  daemon is self-contained and always matches the checkout.
- **Cloudflare tunnel** runs as a boot service (`cloudflared`), forwarding `game.*` → the server port. No
  game ports are exposed to the internet directly.
- **Persistence**: the OS service + the `cloudflared` service bring everything back after a reboot.

### Security notes

- The `/colyseus` monitor can inspect and **dispose live rooms**, so it is **password-protected** by default
  (HTTP Basic auth, random password in `.env`). Change `MONITOR_PASS` and run `gorilator restart`.
- `.env` holds that password **and `NOSTR_NSEC`** (the key the server signs player saves with). It is created
  `chmod 600`. Keep `NOSTR_NSEC` stable across redeploys — changing it orphans every saved player.

---

## Alternative: Docker / Railway

The container path still ships in this repo for those who want it:

```bash
cp .env.example .env          # leave VITE_* empty for Docker Compose
docker compose up -d --build
```

- `Dockerfile.server` builds the same single-service image used by Docker Compose and Railway: built client,
  WebSocket/API, and monitor on one port.
- `docker-compose.yml` runs that image locally on `GAME_SERVER_PORT` (default `2567`).
- `railway.json` points Railway at the same Dockerfile and lets Railway inject `$PORT`.
- See `RAILWAY.md` for the Railway walkthrough.

The native CLI above is the recommended, Docker-free default; the container path uses the same one-port
production shape.
