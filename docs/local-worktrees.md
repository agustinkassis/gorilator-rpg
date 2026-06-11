# Local Worktrees: Isolated Dev Environments per Issue

Create isolated development environments for multiple issues running in parallel on your local machine. Each worktree has its own branch, ports, and dev servers.

## Architecture

```
Main Branch (main)
│
├─ Worktree #77 (isolated)
│  ├─ Branch: claude/issue-77
│  ├─ Client port: 5173
│  ├─ Server port: 2567
│  └─ Dev: pnpm dev (both client + server)
│
├─ Worktree #80 (isolated)
│  ├─ Branch: claude/issue-80
│  ├─ Client port: 5174
│  ├─ Server port: 2568
│  └─ Dev: pnpm dev (both client + server)
│
└─ Worktree #81 (isolated)
   ├─ Branch: claude/issue-81
   ├─ Client port: 5175
   ├─ Server port: 2569
   └─ Dev: pnpm dev (both client + server)

Each worktree is:
✓ Independent git branch
✓ Isolated filesystem (worktrees/issue-XX)
✓ Different ports (no conflicts)
✓ Own .env.local configuration
✓ Can run simultaneously on same machine
```

## Benefits vs Single Worktree

| Single Worktree | Local Worktrees |
|-----------------|-----------------|
| Work on 1 issue at a time | Work on 5 issues simultaneously |
| Switch branches = stop & restart servers | Each worktree runs independently |
| Context switching overhead | No context switching needed |
| Testing requires toggling | Test all branches in parallel |
| Hard to compare between issues | Easy side-by-side comparison |

## Quick Start

### 1. Create worktrees for your issues

```bash
# Create worktree for issue #77
node scripts/worktree-manager.mjs create 77

# Create worktree for issue #80
node scripts/worktree-manager.mjs create 80

# Create worktree for issue #81
node scripts/worktree-manager.mjs create 81
```

### 2. List all worktrees

```bash
node scripts/worktree-manager.mjs list
```

Output:
```
📋 Local Worktrees:

  ⚪ Issue #77: Survival: hunger, food, cooking & farming
     Branch: claude/issue-77
     Path: worktrees/issue-77
     Ports: client 5173, server 2567

  ⚪ Issue #80: Parties: invites, shared XP, party frames
     Branch: claude/issue-80
     Path: worktrees/issue-80
     Ports: client 5174, server 2568

  ⚪ Issue #81: Quests v1: quests.json...
     Branch: claude/issue-81
     Path: worktrees/issue-81
     Ports: client 5175, server 2569
```

### 3. Open terminal shells for all worktrees

```bash
node scripts/worktree-manager.mjs shells
```

This opens a terminal in each worktree directory.

### 4. In each terminal, start the dev server

```bash
# Terminal 1 (worktree #77)
cd worktrees/issue-77
pnpm dev
# → Client: http://localhost:5173
# → Server: http://localhost:2567
# → Monitor: http://localhost:2567/colyseus

# Terminal 2 (worktree #80)
cd worktrees/issue-80
pnpm dev
# → Client: http://localhost:5174
# → Server: http://localhost:2568
# → Monitor: http://localhost:2568/colyseus

# Terminal 3 (worktree #81)
cd worktrees/issue-81
pnpm dev
# → Client: http://localhost:5175
# → Server: http://localhost:2569
# → Monitor: http://localhost:2569/colyseus
```

### 5. Test all simultaneously

Open browsers for each port:
- Issue #77: http://localhost:5173
- Issue #80: http://localhost:5174
- Issue #81: http://localhost:5175

All servers run in parallel. Zero resource conflicts.

## Command Reference

### Create a worktree

```bash
node scripts/worktree-manager.mjs create <issue-number>
```

Creates:
- Git worktree at `worktrees/issue-<number>`
- New branch: `claude/issue-<number>`
- Isolated `.env.local` with unique ports
- Clones repo state from current branch

### List all worktrees

```bash
node scripts/worktree-manager.mjs list
```

Shows:
- All worktrees (created + running)
- Branches, paths, ports
- Process IDs if running
- Access URLs

### Mark worktree as running

```bash
node scripts/worktree-manager.mjs start <issue-number>
```

Updates registry status (for tracking).

### Stop a worktree

```bash
node scripts/worktree-manager.mjs stop <issue-number>
```

Marks as stopped (doesn't kill processes, just updates registry).

### Open shells for all worktrees

```bash
node scripts/worktree-manager.mjs shells
```

Opens a terminal for each worktree (macOS + Linux).

### Delete a worktree

```bash
node scripts/worktree-manager.mjs cleanup <issue-number>
```

Removes:
- Git worktree
- Worktree directory
- Registry entry

## Port Assignment

Ports are automatically assigned based on issue number order:

| Issue | Client Port | Server Port |
|-------|-------------|-------------|
| #77 (first) | 5173 | 2567 |
| #80 (second) | 5174 | 2568 |
| #81 (third) | 5175 | 2569 |
| #82 (fourth) | 5176 | 2570 |

No manual port configuration needed — automatic & conflict-free.

## Environment Configuration

Each worktree has its own `.env.local`:

```bash
# worktrees/issue-77/.env.local
VITE_CLIENT_PORT=5173
GAME_SERVER_PORT=2567
NODE_ENV=development
LOG_LEVEL=debug
WORKTREE_ID=issue-77
WORKTREE_PATH=worktrees/issue-77
```

The ports are read by the dev server and client, so everything just works.

## Workflow: Development Loop

1. **Create worktrees for all your issues**
   ```bash
   node scripts/worktree-manager.mjs create 77
   node scripts/worktree-manager.mjs create 80
   ```

2. **Open shells for each**
   ```bash
   node scripts/worktree-manager.mjs shells
   ```

3. **Start dev servers**
   ```bash
   # In terminal 1
   cd worktrees/issue-77 && pnpm dev

   # In terminal 2
   cd worktrees/issue-80 && pnpm dev
   ```

4. **Test in browser**
   - http://localhost:5173 (issue #77)
   - http://localhost:5174 (issue #80)

5. **Code & commit**
   - Each worktree has its own branch
   - Commits stay isolated
   - No merge conflicts between worktrees

6. **When done with an issue**
   ```bash
   node scripts/worktree-manager.mjs cleanup 77
   ```

## File Structure

```
gorilator-rpg/
├── worktrees/                    # All worktree directories
│   ├── issue-77/                 # Isolated worktree for #77
│   │   ├── packages/
│   │   ├── scripts/
│   │   ├── .env.local            # Auto-generated env
│   │   └── ... (full repo copy)
│   ├── issue-80/                 # Isolated worktree for #80
│   │   ├── .env.local
│   │   └── ... (full repo copy)
│   └── issue-81/
│
├── .claude/
│   └── worktrees.json            # Registry of all worktrees
│
└── scripts/
    └── worktree-manager.mjs      # Management CLI
```

## Registry: .claude/worktrees.json

Tracks all active worktrees:

```json
{
  "worktrees": [
    {
      "issueNumber": 77,
      "branchName": "claude/issue-77",
      "worktreePath": "worktrees/issue-77",
      "clientPort": 5173,
      "serverPort": 2567,
      "status": "created",
      "createdAt": "2026-06-11T...",
      "processes": {
        "client": null,
        "server": null
      }
    },
    {
      "issueNumber": 80,
      "branchName": "claude/issue-80",
      "worktreePath": "worktrees/issue-80",
      "clientPort": 5174,
      "serverPort": 2568,
      "status": "created",
      "createdAt": "2026-06-11T...",
      "processes": {
        "client": null,
        "server": null
      }
    }
  ]
}
```

## Troubleshooting

### "Port already in use"

If a port is in use by another process:
1. Find the process: `lsof -i :<port>`
2. Kill it: `kill -9 <PID>`
3. Or use a different worktree (ports auto-assign)

### "Worktree already exists"

Clean it up first:
```bash
node scripts/worktree-manager.mjs cleanup 77
node scripts/worktree-manager.mjs create 77
```

### "pnpm install fails in worktree"

The worktree shares the root `node_modules` via symlinks. If it fails:
```bash
cd worktrees/issue-77
rm -rf node_modules
cd ../..
pnpm install
```

### "Worktree out of sync with main"

Merge main into your worktree:
```bash
cd worktrees/issue-77
git pull origin main
# Resolve any conflicts
```

## Integration with Orchestration

Combine local worktrees with the automation pipeline:

```bash
# 1. Create worktrees for issues
node scripts/worktree-manager.mjs create 77
node scripts/worktree-manager.mjs create 80

# 2. Run dev servers in each
# (in separate terminals, each in their worktree directory)
cd worktrees/issue-77 && pnpm dev
cd worktrees/issue-80 && pnpm dev

# 3. In main directory, run orchestration
node scripts/multi-issue-orchestration.mjs 77 80
workflow --scriptPath ".claude/workflows/orchestrate-77-80.mjs"

# 4. Agents work on the code in each worktree
# 5. Create PRs
node scripts/pr-orchestration.mjs 77 80
workflow --scriptPath ".claude/workflows/pr-orchestration-77-80.mjs"

# 6. Cleanup when done
node scripts/worktree-manager.mjs cleanup 77
node scripts/worktree-manager.mjs cleanup 80
```

## Performance

Each worktree:
- 📦 **Disk:** ~500MB (full repo copy) × N worktrees
- 🧠 **RAM:** Minimal when idle (server + client dev process)
- ⚡ **CPU:** Only used during active development

For 3 worktrees with 3 servers running:
- RAM: ~2-3GB (laptop with 8GB: comfortable)
- Disk: ~1.5GB additional
- CPU: Scales with activity

## Advantages Over Cloud Worktrees

For local development:
- ✅ No network latency (localhost connections)
- ✅ No deployment wait (instant dev server)
- ✅ Full control over environment
- ✅ Works offline
- ✅ Zero cost
- ✅ Faster iteration loop

**Use local worktrees for active development. Scale to cloud only when:**
- Testing at scale (many concurrent servers)
- Sharing server with team
- Running CI/CD
- Deploying to production

## Next Steps

1. ✅ Create worktrees for your issues
2. ✅ Open shells and start dev servers
3. ✅ Test all branches simultaneously
4. ✅ Code and commit
5. ✅ Cleanup when done

See also:
- `scripts/worktree-manager.mjs` — Implementation
- `docs/orchestration.md` — Multi-issue orchestration
- `docs/pr-orchestration.md` — PR linking and closure
