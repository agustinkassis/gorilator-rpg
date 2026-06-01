# 🚂 Deploy Gorilator on Railway (one click)

[![Deploy on Railway](https://railway.com/button.svg)](https://railway.com/new/template/REPLACE_WITH_TEMPLATE_ID)

> Replace `REPLACE_WITH_TEMPLATE_ID` above once you publish the template (steps below).
> Until then, use the **Deploy from repo** path — it's just as zero-config.

Gorilator runs on Railway as **one service**: a single container serves the game
client **and** the Colyseus WebSocket on the same domain. There are **no variables
to set** — the client talks to its own origin, and the server listens on Railway's
`$PORT`. Deploy → wait for the build → open the URL → play.

---

## Deploy from the repo (works right now, no template needed)

1. Railway dashboard → **New Project** → **Deploy from GitHub repo** → pick
   `agustinkassis/gorilator-rpg`.
2. Railway reads [`railway.json`](railway.json), builds [`Dockerfile.railway`](Dockerfile.railway),
   and starts the service. (First build pulls `node` once and takes a few minutes.)
3. Service → **Settings → Networking → Generate Domain**. Open it — the game is live.

That's it. No env vars, no second service, no config.

---

## Publish it as a one-click template (so the button works for everyone)

Do this once, from a working deployment:

1. Deploy from the repo (above) so you have a running service.
2. Project page → **⋯ menu → Publish as Template** (or
   <https://railway.com/templates/create>) → confirm the service + Dockerfile.
3. Railway gives you a URL like `https://railway.com/new/template/AbC123`. Copy the
   `AbC123` id into the button at the top of this file (and your README), commit, push.
4. Anyone clicking the button now gets the whole thing deployed in one click.

See Railway's [Create a Template](https://docs.railway.com/templates/create) and
[Publish & Share](https://docs.railway.com/guides/publish-and-share) docs.

---

## How it works

- **One image** ([`Dockerfile.railway`](Dockerfile.railway)): builds `@rpg/shared` (tsc),
  builds the client with `VITE_SAME_ORIGIN=1`, and runs the Colyseus server via `tsx`.
- **Same origin**: with `VITE_SAME_ORIGIN`, the client dials `wss://<the page's host>`
  ([`NetworkClient.ts`](packages/client/src/net/NetworkClient.ts)), which is the same
  Railway service — so there's nothing to configure.
- **Static serving**: the server serves the built client from `CLIENT_DIST`
  ([`server/src/index.ts`](packages/server/src/index.ts)) with an SPA fallback, and
  exposes `/healthz` for Railway's health check.
- **Port**: Railway injects `$PORT`; the image maps it to the server's
  `GAME_SERVER_PORT` at start — no code change, no effect on local dev.

## Options

- **Lock the live monitor**: the room inspector at `/<your-domain>/colyseus` is open
  by default. To require a password, add `MONITOR_USER` and `MONITOR_PASS` variables
  to the service and redeploy.
- **Custom domain**: Service → Settings → Networking → Custom Domain. No rebuild
  needed — same-origin means the client follows whatever domain it's served from.

Prefer to self-host with Docker + Cloudflare instead? See [DEPLOY.md](DEPLOY.md).
