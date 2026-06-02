# 🦍 gorilator

One command to install, run, and supervise the **[Gorilator RPG](https://github.com/agustinkassis/gorilator-rpg)**
game server **natively** — no Docker. It clones the game, builds it from source, and registers it as a
boot-persistent OS service (systemd on Linux, launchd on macOS) that you control from anywhere with the
global `gorilator` command. An optional `gorilator setup` wires it to a public Cloudflare hostname.

> Prefer containers? The repo still ships **Docker Compose** and a one-click **Railway** template — see
> the project's `DEPLOY.md`. This CLI is the Docker-free path.

## Install

```bash
npx gorilator install
```

This will:

1. Check prerequisites (Node ≥ 20.6, `git`, `pnpm` — installing `pnpm@10.14.0` if missing).
2. Clone the game to `/opt/gorilator` (Linux) or `~/.gorilator/app` (macOS).
3. `pnpm install`, build the shared schema, build the same-origin client, and build this CLI.
4. Generate `.env` (server port, monitor credentials, a stable Nostr signing key).
5. Register and start a service whose main server port serves the client page, WebSocket, monitor, and API
   (plus an optional direct local client port for convenience).
6. Put `gorilator` on your `PATH` and print the local URLs and monitor credentials.

On a **bare box with no Node yet**, bootstrap everything (installs git + Node, then runs the above):

```bash
curl -fsSL https://raw.githubusercontent.com/agustinkassis/gorilator-rpg/main/cli/install.sh | sudo bash
```

## Go public — `gorilator setup`

```bash
gorilator setup
```

Prompts for a base domain and one game subdomain (default `game.<domain>`), then:

1. Installs & authorizes **cloudflared**, creates the `gorilator-rpg` tunnel, and routes DNS for that host.
2. Writes an ingress that routes `game.<domain>` → the server port.
3. Rebuilds the client same-origin (`VITE_SAME_ORIGIN=1`) and restarts the daemon — so the page, WebSocket,
   monitor, and API all share HTTPS/WSS on the same public origin. Setup also disables the optional
   dedicated local client port, leaving one local game port behind the tunnel.
4. Runs `cloudflared` as a boot service and prints your public URLs.

```
Direct:      http://host:2567   client + WebSocket    ┐ one native process
             http://host:8080   optional client page  ┘ only with --client-port 8080

Cloudflare ─▶ game.<domain> ─▶ localhost:2567
              client page + WebSocket + monitor + API
```

## Manage the daemon

```bash
gorilator status      # service state + health check + local & public URLs   (alias: info)
gorilator start       # start the service (prints the port it listens on)
gorilator stop        # stop the service
gorilator restart     # restart the service
gorilator logs        # stream server logs (Ctrl-C to detach)
gorilator update      # stop services, git pull, rebuild, start services
gorilator tunnel <cmd># Cloudflare tunnel — login | status | restart
gorilator uninstall   # stop and remove services, config, command, and installed files
```

`gorilator uninstall` removes the local Gorilator daemon, local tunnel service/config,
install record, global npm command, and installed app directory. Use
`--keep-files`, `--keep-command`, or `--keep-tunnel` to preserve those parts.

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
| `--client-port <n>` | `CLIENT_PORT` | — | Optional dedicated local port for the client page |
| `--yes` | `GORILATOR_YES=1` | — | Assume "yes" to prompts (non-interactive) |
| `--skip-service` | — | — | Install/build only; don't register the OS service |
| `--skip-tunnel` | — | — | Don't offer the Cloudflare setup after install |
| `--local-cli <pkg>` | `GORILATOR_LOCAL_CLI` | — | Install the global command from a local path/tarball (testing) |

`gorilator setup` reads `GORILATOR_DOMAIN` and `GORILATOR_HOST`/`GORILATOR_GAME_HOST` for non-interactive
runs. Legacy `GORILATOR_SERVER_HOST`/`GORILATOR_CLIENT_HOST` are accepted as fallbacks.

## License

MIT
