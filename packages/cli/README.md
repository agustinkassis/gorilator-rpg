# 🦍 gorilator

One command to install, run, and supervise the **[Gorilator RPG](https://github.com/agustinkassis/gorilator-rpg)**
game server **natively** — no Docker. It clones the game, builds it from source, and registers it as a
boot-persistent OS service (systemd on Linux, launchd on macOS) that you control from anywhere with the
global `gorilator` command. An optional `gorilator setup` wires it to public Cloudflare subdomains.

> Prefer containers? The repo still ships **Docker Compose** and a one-click **Railway** template — see
> the project's `DEPLOY.md`. This CLI is the Docker-free path.

## Install

```bash
npx gorilator install
```

This will:

1. Check prerequisites (Node ≥ 20.6, `git`, `pnpm` — installing `pnpm@10.14.0` if missing).
2. Clone the game to `/opt/gorilator` (Linux) or `~/.gorilator/app` (macOS).
3. `pnpm install`, build the shared schema, build the client (to dial the server port), and build this CLI.
4. Generate `.env` (server + client ports, monitor credentials, a stable Nostr signing key).
5. Register and start a service that serves the game on **two ports** — the client page on its own web port
   and the server (WebSocket + monitor + API) on another — both reachable directly, no proxy needed.
6. Put `gorilator` on your `PATH` and print the client + server ports and the monitor credentials.

On a **bare box with no Node yet**, bootstrap everything (installs git + Node, then runs the above):

```bash
curl -fsSL https://raw.githubusercontent.com/agustinkassis/gorilator-rpg/main/cli/install.sh | sudo bash
```

## Go public — `gorilator setup`

```bash
gorilator setup
```

Prompts for a base domain and two subdomains (defaults `play.<domain>` + `api.<domain>`), then:

1. Installs & authorizes **cloudflared**, creates the `gorilator-rpg` tunnel, and routes DNS for both hosts.
2. Writes an ingress that routes `play.<domain>` → the client port and `api.<domain>` → the server port.
3. Bakes the server subdomain into the client bundle (`VITE_SERVER_URL=wss://api.<domain>`), **rebuilds the
   client**, and restarts the daemon — so the client and server work together over HTTPS/WSS.
4. Runs `cloudflared` as a boot service and prints your public URLs.

```
Direct:      http://host:8080   client page          ┐ one native process,
             ws://host:2567     server (WebSocket)    ┘ two listeners

Cloudflare ─▶ play.<domain> ─▶ localhost:8080   (client page)
           ─▶ api.<domain>  ─▶ localhost:2567   (server: WebSocket + monitor + API)
```

## Manage the daemon

```bash
gorilator status      # service state + health check + local & public URLs   (alias: info)
gorilator start       # start the service (prints the port it listens on)
gorilator stop        # stop the service
gorilator restart     # restart the service
gorilator logs        # stream server logs (Ctrl-C to detach)
gorilator update      # git pull, rebuild, restart (preserves your public client build)
gorilator tunnel <cmd># Cloudflare tunnel — login | status | restart
gorilator uninstall   # stop and remove the service (your files stay)
```

## Requirements

- **Node.js ≥ 20.6** (the runtime that runs `npx`/the daemon).
- **git** (to fetch the game source).
- **Linux** (systemd) or **macOS** (launchd). Linux uses a system service and may prompt for `sudo`;
  macOS uses a per-user LaunchAgent (no `sudo`).
- For `setup`: a **domain on Cloudflare** (free plan is fine). No DNS records to pre-create — `setup` makes them.

## Configuration

`gorilator install` accepts flags and environment overrides:

| Flag | Env | Default | Meaning |
|------|-----|---------|---------|
| `--repo <url>` | `GORILATOR_REPO` | `https://github.com/agustinkassis/gorilator-rpg.git` | Game source repository |
| `--ref <ref>` | `GORILATOR_REF` | `main` | Branch or tag to deploy |
| `--dir <path>` | `GORILATOR_DIR` | `/opt/gorilator` · `~/.gorilator/app` | Where the game is cloned |
| `--port <n>` | `GAME_SERVER_PORT` | `2567` | Server port (WebSocket + monitor + API) |
| `--client-port <n>` | `CLIENT_PORT` | `8080` | Dedicated port the client page is served on |
| `--yes` | `GORILATOR_YES=1` | — | Assume "yes" to prompts (non-interactive) |
| `--skip-service` | — | — | Install/build only; don't register the OS service |
| `--skip-tunnel` | — | — | Don't offer the Cloudflare setup after install |
| `--local-cli <pkg>` | `GORILATOR_LOCAL_CLI` | — | Install the global command from a local path/tarball (testing) |

`gorilator setup` reads `GORILATOR_DOMAIN`, `GORILATOR_CLIENT_HOST`, and `GORILATOR_SERVER_HOST` for
non-interactive runs.

## License

MIT
