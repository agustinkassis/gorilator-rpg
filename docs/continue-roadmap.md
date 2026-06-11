# Continue Roadmap: Automated Parallel Development Setup

One-command workflow to select issues, validate dependencies, and spawn multiple isolated worktrees for parallel development.

## Quick Start

In Claude Code or Codex, run:

```
/continue-roadmap
```

This launches an interactive wizard that:

1. **Shows all available issues** with components, sizes, and estimated hours
2. **Asks you to select 2-5 issues** to work on simultaneously
3. **Validates no blocking dependencies** exist between selections
4. **Creates worktrees in parallel** with isolated environments
5. **Opens terminals** in each worktree directory
6. **Shows browser URLs** for testing each worktree
7. **Ready to code** — just run `pnpm dev` in each terminal

## Flow Diagram

```
User invokes: /continue-roadmap
       ↓
┌──────────────────────────────┐
│ Phase 1: Selection           │
│ - Show available issues      │
│ - User selects 2-5 issues    │
└──────────────────────────────┘
       ↓
┌──────────────────────────────┐
│ Phase 2: Validation          │
│ - Check dependencies         │
│ - Validate can work parallel │
│ - Identify shared systems    │
└──────────────────────────────┘
       ↓
┌──────────────────────────────┐
│ Phase 3: Setup               │
│ - Create git worktrees       │
│ - Generate .env.local        │
│ - Assign ports automatically │
└──────────────────────────────┘
       ↓
┌──────────────────────────────┐
│ Phase 4: Launch              │
│ - Open terminals             │
│ - Show URLs & next steps     │
│ - Ready to develop           │
└──────────────────────────────┘
       ↓
Ready for parallel dev!
Each issue: pnpm dev
Each browser: http://localhost:517X
```

## Example Walkthrough

### Step 1: Invoke the skill

```bash
# In Claude Code
/continue-roadmap
```

### Step 2: See available issues

```
📋 Available Issues in Phase 3:

┌─────┬────────────────────────────────────┬────────┬───────┐
│ #   │ Issue                              │ Size   │ Hrs   │
├─────┼────────────────────────────────────┼────────┼───────┤
│  77 │ Survival: hunger, food, cooking    │ L      │  40   │
│  78 │ Abilities & spells: data-first     │ L      │  45   │
│  79 │ Trinity combat: threat/aggro       │ M      │  25   │
│  80 │ Parties: invites, shared XP        │ M      │  20   │
│  81 │ Quests v1: quests.json, objective  │ L      │  50   │
│  82 │ De-tower-defense rename refactor   │ M      │  20   │
└─────┴────────────────────────────────────┴────────┴───────┘
```

### Step 3: Select issues

```
Select issues to work on (comma-separated): 77,80,81
```

### Step 4: Validation

```
✓ Selected: #77, #80, #81 (110 hours estimated)

🔍 Validating dependencies...
✓ All dependencies satisfied - can work in parallel!

Shared systems:
  • Player Save Format (affects #77)
  • XP System (affects #77, #80)
  • Messaging (affects #80)

Integration plan:
  - #80 (Parties) can start immediately
  - #77 (Survival) player save changes must coordinate with #80 XP sharing
  - #81 (Quests) is independent
```

### Step 5: Setup

```
⚙️  Creating 3 worktrees in parallel...
   ✓ Issue #77 (port 5173/2567)
   ✓ Issue #80 (port 5174/2568)
   ✓ Issue #81 (port 5175/2569)

✅ Created 3/3 worktrees
```

### Step 6: Launch

```
📂 Opening terminals...
   ✓ Opening terminal for issue #77
   ✓ Opening terminal for issue #80
   ✓ Opening terminal for issue #81

🚀 Next Steps:

In each terminal window, run:
   pnpm dev

Then open browsers at:
   • Issue #77 (Survival): http://localhost:5173
   • Issue #80 (Parties):  http://localhost:5174
   • Issue #81 (Quests):   http://localhost:5175

✨ All worktrees running in parallel! Start coding.
```

## How It Works

### 1. Automatic Dependency Checking

The system:
- ✅ Checks if any selected issue blocks another
- ✅ Checks if any selected issue is blocked by an unselected issue
- ✅ Identifies shared systems that need coordination
- ✅ Prevents setup if dependencies would cause conflicts

Example:
```
Selected: #77, #80, #81

Issue #77 blocks: (none)
Issue #80 blocks: (none)  
Issue #81 blocks: (none)

✓ All can be worked on simultaneously
```

### 2. Parallel Worktree Creation

Creates all worktrees at once (not sequentially):
```
Issue #77 → worktrees/issue-77 (claude/issue-77)
Issue #80 → worktrees/issue-80 (claude/issue-80)
Issue #81 → worktrees/issue-81 (claude/issue-81)

All created in ~5-10 seconds total
```

### 3. Automatic Port Assignment

Each worktree gets unique ports based on issue number order:

| Issue | Client | Server |
|-------|--------|--------|
| #77 (1st) | 5173 | 2567 |
| #80 (2nd) | 5174 | 2568 |
| #81 (3rd) | 5175 | 2569 |

No manual port configuration needed.

### 4. Isolated Environments

Each worktree has its own:
- **Git branch** (claude/issue-XX)
- **Filesystem** (worktrees/issue-XX)
- **.env.local** with unique ports
- **node_modules** (linked via git worktree)
- **pnpm dev processes** (independent)

### 5. Terminal Auto-Launch

On macOS, automatically opens Terminal for each worktree.

On Linux/Windows, shows instructions for manual terminal opening.

## Commands Available

### Continue Roadmap (Interactive)
```bash
node scripts/continue-roadmap.mjs
# Or: /continue-roadmap (Claude Code skill)
```

Starts the full interactive wizard.

### List Active Worktrees
```bash
node scripts/worktree-manager.mjs list
```

Shows all active worktrees, ports, status, URLs.

### Manual Worktree Creation
```bash
node scripts/worktree-manager.mjs create 77
node scripts/worktree-manager.mjs create 80
```

Create individual worktrees without the wizard.

### Cleanup
```bash
node scripts/worktree-manager.mjs cleanup 77
```

Delete a worktree when done.

## Integration with Claude Code

### When you invoke `/continue-roadmap`:

1. Claude Code detects the skill invocation
2. Runs `scripts/continue-roadmap.mjs` interactively
3. User selects issues via terminal prompt
4. Script validates dependencies
5. Creates all worktrees in parallel
6. Opens terminals for each
7. Shows URLs and next steps
8. All worktrees ready for development

### Then in each terminal:

```bash
cd worktrees/issue-77
pnpm dev
# Client starts on 5173
# Server starts on 2567
```

### In your browser:

Open multiple tabs, one per issue:
- http://localhost:5173 (Issue #77)
- http://localhost:5174 (Issue #80)
- http://localhost:5175 (Issue #81)

All servers running in parallel, no conflicts.

## Dependency Validation Examples

### Valid Selection (Can Work in Parallel)
```
Selected: #77, #80, #81
✓ No blocking dependencies
✓ Shared systems identified
✓ Integration plan created
→ Proceed with setup
```

### Invalid Selection (Blocked by Unselected)
```
Selected: #77, #80
⚠️  Issue #80 requires #95 (Trading: server-authoritative swap)
❌ Cannot proceed without #95

Suggestions:
  • Add #95 to selection
  • Select only #77
```

### Shared Systems Coordination
```
Selected: #77, #80, #81
Shared systems identified:
  • Player Save Format (#77 adds hunger)
  • XP System (#77 affects, #80 shares)
  
Integration plan:
  1. #77 (Survival) and #80 (Parties) must coordinate player save + XP
  2. #81 (Quests) can proceed independently
  3. Test all three together before merge
```

## File Structure Created

```
.
├── worktrees/
│   ├── issue-77/                    # Worktree for #77
│   │   ├── packages/
│   │   ├── scripts/
│   │   ├── .env.local               # Auto-generated
│   │   │   VITE_CLIENT_PORT=5173
│   │   │   GAME_SERVER_PORT=2567
│   │   └── ...
│   ├── issue-80/                    # Worktree for #80
│   │   └── .env.local
│   │       VITE_CLIENT_PORT=5174
│   │       GAME_SERVER_PORT=2568
│   └── issue-81/
│       └── .env.local
│           VITE_CLIENT_PORT=5175
│           GAME_SERVER_PORT=2569
│
└── .claude/
    ├── worktrees.json               # Registry
    └── skills/
        └── continue-roadmap.md      # Skill definition
```

## Registry: .claude/worktrees.json

Tracks all created worktrees:

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
    ...
  ]
}
```

## Troubleshooting

### "Port already in use"

If a port is occupied:
1. Find the process: `lsof -i :<port>`
2. Kill it: `kill -9 <PID>`
3. Or select a different set of issues

### "Worktree already exists"

Clean up first:
```bash
node scripts/worktree-manager.mjs cleanup 77
node scripts/continue-roadmap.mjs
```

### "Dependency validation failed"

Selected issues have a blocking relationship:
- Read the error message
- Either add the blocking issue to selection
- Or choose a different set

### "Terminals didn't open (Linux/Windows)"

Use the printed instructions:
```bash
cd worktrees/issue-77 && pnpm dev
cd worktrees/issue-80 && pnpm dev
```

## Workflow with Multi-Issue Orchestration

Complete flow:

```
1. /continue-roadmap
   → Create worktrees
   → Open terminals
   → Start pnpm dev

2. node scripts/multi-issue-orchestration.mjs 77 80 81
   → Analyze issues in parallel
   → Get blockers, plans, merge order

3. node scripts/pr-orchestration.mjs 77 80 81
   → Create PRs with auto-close links
   → Get merge sequencing

4. Code development (in each worktree)
   → Commit to branches
   → Test in browsers

5. Create PRs and merge
   → Issues auto-close on merge
```

## Performance

For 3 worktrees with dev servers:
- **Setup time:** ~10 seconds (parallel creation)
- **RAM usage:** ~2-3GB (3 servers + 3 browsers)
- **Disk usage:** ~1.5GB additional (full repo × 3)
- **CPU:** Scales with active development

## Next Steps After Setup

1. ✅ Run `/continue-roadmap`
2. ✅ Select your issues
3. ✅ Validation passes
4. ✅ Worktrees created
5. ✅ Terminals open
6. **→ Run `pnpm dev` in each terminal**
7. **→ Test in browsers (5173, 5174, 5175)**
8. **→ Start coding in parallel**

## See Also

- `scripts/continue-roadmap.mjs` — Main script
- `scripts/worktree-manager.mjs` — Worktree CLI
- `docs/local-worktrees.md` — Detailed worktree docs
- `docs/orchestration.md` — Multi-issue orchestration
- `.claude/skills/continue-roadmap.md` — Skill definition
