# 🦍 Deploying Gorilator

The default path is **native, no Docker**: the `gorilator` CLI clones the game, installs Node/pnpm/deps,
builds it, and runs it as a boot-persistent OS service (systemd/launchd). One process serves the client
page **and** the multiplayer WebSocket on a single port. An optional `gorilator setup` exposes it through
a Cloudflare Tunnel on your own subdomains.

```
Browser ── https ──▶ Cloudflare ──┬─▶ play.<domain> ─┐
                                  └─▶ api.<domain>  ─┴─▶ localhost:<port>   one native process:
                                                                            client page + WebSocket + monitor
```

> Prefer containers? A Docker Compose stack + a one-click Railway template still ship in this repo — see
> [Alternative: Docker / Railway](#alternative-docker--railway) at the end.

---

## Prerequisites

- A **Linux server** (Debian/Ubuntu recommended) or a **macOS** machine.
- For public hosting: a **domain managed by Cloudflare** (free plan is fine). You do **not** pre-create any
  DNS records — `gorilator setup` makes them.
- Nothing else. The installer adds Node, pnpm, and (for `setup`) cloudflared for you.

---

## Quick start

**If you already have Node ≥ 20.6:**

```bash
npx gorilator install
```

**On a bare box (no Node yet) — one line installs git + Node, then everything:**

```bash
curl -fsSL https://raw.githubusercontent.com/agustinkassis/gorilator-rpg/main/cli/install.sh | sudo bash
```

The installer, in order:

1. Ensures **Node ≥ 20.6**, **git**, and **pnpm@10.14.0** (installing what's missing).
2. Clones the game to `/opt/gorilator` (Linux) or `~/.gorilator/app` (macOS).
3. `pnpm install`, builds the shared schema, builds the client (same-origin), and builds the CLI.
4. Generates `.env` — a random monitor password **and** the server's Nostr key (`NOSTR_NSEC`, which signs
   players' progress saves).
5. Registers a **systemd**/**launchd** service, starts it, and waits for `/healthz`.
6. Prints the local URL + port and the monitor credentials.

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

It prompts for a base domain + two subdomains (defaults `play.<domain>` and `api.<domain>`), then:

1. Installs & authorizes **cloudflared**, creates the `gorilator-rpg` tunnel, and routes DNS for both hosts.
2. Writes `/etc/cloudflared/config.yml` (macOS: `~/.cloudflared/config.yml`) with an ingress that points
   **both** subdomains at the one local game port.
3. Bakes the server subdomain into the client (`VITE_SERVER_URL=wss://api.<domain>`), **rebuilds the
   client**, and restarts the daemon — so the client dials the server over WSS.
4. Runs `cloudflared` as a boot service and prints your public URLs + monitor credentials.

Re-run it anytime to change domains. For non-interactive automation set `GORILATOR_DOMAIN` (or
`GORILATOR_CLIENT_HOST` + `GORILATOR_SERVER_HOST`).

---

## Managing it — the `gorilator` CLI

```
gorilator status        Service state + health + local & public URLs   (alias: info)
gorilator start         Start the daemon (prints the port it listens on)
gorilator stop          Stop the daemon
gorilator restart       Restart the daemon
gorilator logs          Stream server logs (Ctrl-C to detach)
gorilator update        git pull, rebuild, restart (keeps your public client build)
gorilator setup         Configure the Cloudflare tunnel + subdomains
gorilator tunnel <cmd>  Cloudflare tunnel — login | status | restart
gorilator uninstall     Stop & remove the service (your files stay)
```

The three entry points run **identical code** — `npx gorilator <cmd>`, the global `gorilator <cmd>`, and the
repo's `./cli/gorilator <cmd>` (which only adds: ensure Node, then exec the same Node CLI).

---

## Running locally / without Cloudflare

`gorilator install` already gives you a working local server:

- Open <http://localhost:2567> — the client loads and connects to the WebSocket on the same origin.
- `http://localhost:2567/healthz` → `ok`.
- The monitor at `http://localhost:2567/colyseus` requires the `admin` user + the password in `.env`
  (shown by `gorilator status`).

Change the port with `--port` (or `GAME_SERVER_PORT`). `gorilator status` always prints the active port.

---

## How it works

- **One process, one port**: `gorilator serve` runs the Colyseus server from TS via `tsx`, with
  `CLIENT_DIST` pointed at the built client — so the same port answers the game page, the WebSocket, the
  `/colyseus` monitor, and `/healthz`.
- **The service** (`gorilator.service` / `com.gorilator.daemon`) runs `gorilator serve` as your user and
  restarts on failure. Its `ExecStart` points at the in-repo CLI build (`<appDir>/packages/cli/dist`), so the
  daemon is self-contained and always matches the checkout.
- **Cloudflare tunnel** runs as a boot service (`cloudflared`), forwarding both subdomains to the local port.
  No game ports are exposed to the internet directly.
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
cp .env.example .env          # leave VITE_SERVER_URL empty for localhost
docker compose up -d --build
```

- `Dockerfile.client` (nginx-served Vite bundle), `Dockerfile.server` (Colyseus), `docker-compose.yml`,
  and `nginx.conf` define the two-container stack.
- `Dockerfile.railway` + `railway.json` are the one-click Railway template (single service, same-origin).
- See `RAILWAY.md` for the Railway walkthrough.

The native CLI above is the recommended, Docker-free default; the container files are unmaintained relative
to it but remain functional.
