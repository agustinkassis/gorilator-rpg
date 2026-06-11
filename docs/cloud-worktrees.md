# Cloud Worktrees: Server in Cloud, Client Locally

Spawn game servers in the cloud (Railway, Docker) while running the client locally. Test multiple server branches in parallel without consuming local resources.

## Architecture

```
┌────────────────────────────────────────────────────────────┐
│ Your Machine                                               │
│                                                            │
│  ┌──────────────────────────────────────────────────────┐ │
│  │ Local Dev Environment                                │ │
│  │                                                      │ │
│  │  Browser + Client (pnpm dev)                        │ │
│  │  ↓                                                  │ │
│  │  Connects to: https://cloud-server-issue-77.url    │ │
│  │                                                      │ │
│  │  No server process, no Node overhead                │ │
│  └──────────────────────────────────────────────────────┘ │
│           ↓ HTTPS/WSS                                      │
└────────────────────────────────────────────────────────────┘
           ↓ HTTPS/WSS
┌────────────────────────────────────────────────────────────┐
│ Cloud (Railway / Docker / VPS)                             │
│                                                            │
│  ┌──────────────────────────────────────────────────────┐ │
│  │ Server 1: Issue #77                                 │ │
│  │ Branch: claude/issue-77-cloud-worktree              │ │
│  │ URL: cloud-77.railway.app                           │ │
│  │ Status: Running                                     │ │
│  └──────────────────────────────────────────────────────┘ │
│                                                            │
│  ┌──────────────────────────────────────────────────────┐ │
│  │ Server 2: Issue #80                                 │ │
│  │ Branch: claude/issue-80-cloud-worktree              │ │
│  │ URL: cloud-80.railway.app                           │ │
│  │ Status: Running                                     │ │
│  └──────────────────────────────────────────────────────┘ │
│                                                            │
│  Multiple servers running in parallel                      │
│  Low local resource usage                                  │
└────────────────────────────────────────────────────────────┘
```

## Benefits

| Local Dev | Cloud Worktrees |
|-----------|-----------------|
| Develop 1 server at a time | Test multiple servers in parallel |
| Consumes local CPU/RAM/disk | Offload to cloud provider |
| Can't test scaling | Easy to spawn 5+ servers |
| Dev server crashes affect work | Crash doesn't block local work |
| Limited by laptop resources | Scale to cloud limits |

## Quick Start

### 1. Spawn a cloud server for an issue

```bash
# Railway (recommended — one-click deploy)
node scripts/cloud-worktree.mjs spawn 77 railway

# Docker (self-hosted VPS/machine)
node scripts/cloud-worktree.mjs spawn 80 docker
```

### 2. Deploy server (depends on provider)

**Railway:**
```
1. git push origin claude/issue-77-cloud-worktree
2. Railway dashboard → New Project → Deploy from GitHub
3. Select your fork + branch
4. Wait for build (1-2 min)
5. Get public URL from Railway
```

**Docker:**
```
docker compose -f .docker/docker-compose.issue-77.yml up -d
# Server starts on your machine's network
```

### 3. Register the server URL

```bash
node scripts/cloud-worktree.mjs connect server-77-railway https://cloud-77.railway.app
# or
node scripts/cloud-worktree.mjs connect server-77-docker http://192.168.1.100:2567
```

### 4. Run client locally against cloud server

```bash
node scripts/cloud-worktree.mjs dev server-77-railway
# Starts: pnpm dev (client only)
# Connects to: https://cloud-77.railway.app
```

### 5. Test in browser

```
http://localhost:5173  ← Client (local)
```

The browser will connect to the cloud server for multiplayer, saves, and game logic.

## Command Reference

### Spawn a cloud server

```bash
# Railway (auto-deploy, just push branch)
node scripts/cloud-worktree.mjs spawn <issue-number> railway

# Docker (run on any machine with Docker)
node scripts/cloud-worktree.mjs spawn <issue-number> docker

# Examples:
node scripts/cloud-worktree.mjs spawn 77 railway  # Issue #77 on Railway
node scripts/cloud-worktree.mjs spawn 80 docker   # Issue #80 on Docker
```

### List all cloud servers

```bash
node scripts/cloud-worktree.mjs list

# Output:
#   ✅ server-77-railway
#      Issue: #77
#      Provider: railway
#      Branch: claude/issue-77-cloud-worktree
#      URL: https://cloud-77.railway.app
#
#   ⏳ server-80-docker (pending — waiting for URL)
#      Issue: #80
#      Provider: docker
#      Branch: claude/issue-80-cloud-worktree
```

### Connect a server URL

After deploying, register the public URL:

```bash
node scripts/cloud-worktree.mjs connect server-77-railway https://cloud-77.railway.app
```

Workflow:
1. Spawn server → creates branch
2. Deploy to cloud → get public URL
3. Connect → register URL locally
4. Dev → run client against cloud server

### Run local client against cloud server

```bash
node scripts/cloud-worktree.mjs dev server-77-railway
```

This:
1. ✅ Generates client config pointing to cloud server
2. ✅ Starts local dev server (client only)
3. ✅ Opens http://localhost:5173
4. ✅ Client connects to cloud server

### Tear down a cloud server

```bash
node scripts/cloud-worktree.mjs teardown server-77-railway
```

Removes from local registry and shows cleanup steps:
- **Railway:** Instructions to delete via dashboard
- **Docker:** Runs `docker compose down` automatically

## Workflow: Parallel Testing

Test multiple issue branches simultaneously:

```bash
# Terminal 1: Spawn and deploy server for #77
node scripts/cloud-worktree.mjs spawn 77 railway
# → Push branch, deploy on Railway, get URL
node scripts/cloud-worktree.mjs connect server-77-railway https://cloud-77.railway.app
node scripts/cloud-worktree.mjs dev server-77-railway
# Browser: http://localhost:5173 (connected to cloud #77)

# Terminal 2: Spawn and deploy server for #80 (same time!)
node scripts/cloud-worktree.mjs spawn 80 railway
# → Push branch, deploy on Railway, get URL
node scripts/cloud-worktree.mjs connect server-80-railway https://cloud-80.railway.app
# (in separate browser tab/window)
node scripts/cloud-worktree.mjs dev server-80-railway
# Browser: http://localhost:5174 (connected to cloud #80)
```

Both servers run in parallel on Railway. Your laptop only runs 2 browser instances.

## Railway Deployment (Recommended)

### One-time setup

```bash
# 1. Install Railway CLI
npm install -g @railway/cli

# 2. Login to Railway
railway login

# 3. Create a project
railway init
```

### Deploy a branch

```bash
# 1. Create cloud server for issue #77
node scripts/cloud-worktree.mjs spawn 77 railway

# 2. Push the branch
git push origin claude/issue-77-cloud-worktree

# 3. In Railway dashboard:
#    - New Project → Deploy from GitHub
#    - Select your fork
#    - Select branch: claude/issue-77-cloud-worktree
#    - Railway auto-detects Dockerfile.server and deploys

# 4. Get public URL
#    - Click the service → Settings → Networking → Generated Domain
#    - Copy the URL (e.g., cloud-77.railway.app)

# 5. Register locally
node scripts/cloud-worktree.mjs connect server-77-railway https://cloud-77.railway.app

# 6. Run local client
node scripts/cloud-worktree.mjs dev server-77-railway
```

### Cleanup

In Railway dashboard → Service → Settings → Danger Zone → Delete Service

Or: `railway down`

## Docker Deployment (Self-Hosted)

### Start a cloud server on Docker

```bash
# 1. Create server
node scripts/cloud-worktree.mjs spawn 77 docker
# → Creates: .docker/docker-compose.issue-77.yml

# 2. Start container
docker compose -f .docker/docker-compose.issue-77.yml up -d

# 3. Wait for health check (20s)
docker compose -f .docker/docker-compose.issue-77.yml logs game

# 4. Get container IP
docker inspect -f '{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}' gorilator-issue-77
# Output: 172.20.0.2

# 5. Register server
node scripts/cloud-worktree.mjs connect server-77-docker http://172.20.0.2:2567

# 6. Run local client
node scripts/cloud-worktree.mjs dev server-77-docker
```

### Stop a container

```bash
docker compose -f .docker/docker-compose.issue-77.yml down
```

Or:
```bash
node scripts/cloud-worktree.mjs teardown server-77-docker
```

## Client Configuration

When you run `dev server-id`, the script:

1. Generates `packages/client/src/cloud-worktree-config.ts`
2. Sets `window.__GAME_SERVER_URL__` to cloud server
3. Starts `pnpm dev` (client only)

In your client code, use:

```typescript
// NetworkClient.ts
const serverUrl = window.__GAME_SERVER_URL__ || 'ws://localhost:2567'
```

The build already supports same-origin (`VITE_SAME_ORIGIN=1` in Docker), so it works both locally and in cloud.

## Monitoring

### Check server status

```bash
node scripts/cloud-worktree.mjs list

# Check Railway deployment
railway logs -p <service-id>

# Check Docker container
docker logs gorilator-issue-77
docker stats gorilator-issue-77
```

### Test connectivity

```bash
# Check if server is running
curl https://cloud-77.railway.app/healthz

# Check Colyseus monitor
open https://cloud-77.railway.app/colyseus
```

## Cost Considerations

### Railway (Recommended for dev)

- **Free tier:** 500 hours/month of compute (share across all services)
- **Pricing:** ~$5/month per active service beyond free tier
- **Multiple servers:** Cost effective for testing, pause when done

### Docker (VPS/Self-Hosted)

- **Cost:** Depends on your VPS provider
- **Upside:** Full control, no vendor lock-in
- **Downside:** You manage infrastructure

## Integration with Orchestration Pipeline

Combine cloud worktrees with the multi-issue orchestration:

```bash
# 1. Generate orchestration workflow
node scripts/multi-issue-orchestration.mjs 77 80

# 2. Spawn cloud servers for each issue
node scripts/cloud-worktree.mjs spawn 77 railway
node scripts/cloud-worktree.mjs spawn 80 railway

# 3. Deploy to Railway (push branches)
git push origin claude/issue-77-cloud-worktree
git push origin claude/issue-80-cloud-worktree

# 4. Register servers (after Railway deploy completes)
node scripts/cloud-worktree.mjs connect server-77-railway https://cloud-77.railway.app
node scripts/cloud-worktree.mjs connect server-80-railway https://cloud-80.railway.app

# 5. Run local client against either server
node scripts/cloud-worktree.mjs dev server-77-railway  # Terminal 1
node scripts/cloud-worktree.mjs dev server-80-railway  # Terminal 2 (different port)
```

Now you have:
- 2 cloud servers (#77, #80) running in parallel
- Local browser(s) testing against either server
- No local resource constraints
- Easy cleanup when done

## Troubleshooting

### "Server not found in registry"

The server might not be registered yet:
```bash
node scripts/cloud-worktree.mjs list  # Check registered servers
node scripts/cloud-worktree.mjs connect <id> <url>  # Register it
```

### "Client can't connect to cloud server"

Check:
1. Server is running: `curl https://cloud-77.railway.app/healthz`
2. URL is correct: `node scripts/cloud-worktree.mjs list`
3. Browser console for CORS/network errors
4. Firewall might be blocking WebSocket connections

### "Railway deploy failed"

Check Railway logs:
```bash
railway logs -p <service-id>
```

Common issues:
- Build failed: check Dockerfile and pnpm-lock.yaml
- Health check failed: server didn't start on port 2567
- Out of disk: delete old deployments

### "Docker container won't start"

```bash
docker logs gorilator-issue-77
docker compose -f .docker/docker-compose.issue-77.yml up -d --no-cache
```

## Next Steps

1. ✅ Create cloud servers for your issues
2. ✅ Deploy to Railway (or Docker)
3. ✅ Run local client against cloud servers
4. ✅ Test multiple branches in parallel
5. ✅ Tear down when done

See also:
- `scripts/cloud-worktree.mjs` — CLI implementation
- `docs/orchestration.md` — Multi-issue parallel development
- `RAILWAY.md` — One-click Railway deployment
