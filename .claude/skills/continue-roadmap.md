# Continue Roadmap

Automated workflow to select issues, validate dependencies, and spawn parallel worktrees with dev servers.

## What it does

1. **Show available issues** — Browse Phase 3 issues with components and sizes
2. **Select issues** — Choose multiple non-dependent issues to work on
3. **Validate dependencies** — Verify selected issues can be worked on simultaneously
4. **Create worktrees** — Spawn isolated git worktrees in parallel
5. **Open terminals** — Launch terminal windows ready for `pnpm dev`
6. **Display URLs** — Show browser URLs for each worktree
7. **Ready to code** — All servers isolated and ready to run

## Invoke with

```
/continue-roadmap
```

## What happens

1. User selects 2-5 non-dependent issues (e.g., #77, #80, #81)
2. Script validates no blocking dependencies
3. Creates all worktrees in parallel (fast)
4. Opens terminal for each worktree
5. Shows next steps:
   - `pnpm dev` in each terminal
   - URLs for browser testing (5173, 5174, 5175, etc.)

## Example flow

```
🛣️  Continue Roadmap - Select Issues to Work On

📋 Available Issues in Phase 3:

┌─────┬──────────────────────────────────────┬────────┐
│ #   │ Issue                                │ Size   │
├─────┼──────────────────────────────────────┼────────┤
│  77 │ Survival: hunger, food, cooking      │ L      │
│  80 │ Parties: invites, shared XP          │ M      │
│  81 │ Quests v1: quests.json, objective... │ L      │
│  82 │ De-tower-defense rename refactor     │ M      │
└─────┴──────────────────────────────────────┴────────┘

Select issues (comma-separated): 77,80,81

✓ Selected: #77, #80, #81
✓ All dependencies satisfied - can work in parallel!
✅ Created 3/3 worktrees

📂 Opening terminals...
   ✓ Opening terminal for issue #77
   ✓ Opening terminal for issue #80
   ✓ Opening terminal for issue #81

🚀 Next Steps:

In each terminal window, run:
   pnpm dev

Then open browsers at:
   • Issue #77: http://localhost:5173
   • Issue #80: http://localhost:5174
   • Issue #81: http://localhost:5175
```

## Integration with Claude Code

After invoking, the workflow:
- Creates worktrees in `worktrees/issue-XX/`
- Each has isolated `.env.local` with unique ports
- Terminals open and await `pnpm dev` command
- All dev servers can run simultaneously
- Full git branch isolation per issue

## Key features

✅ Dependency validation (won't create blockers)
✅ Parallel worktree creation (fast setup)
✅ Automatic port assignment (5173+N, 2567+N)
✅ Terminal opening (ready to `pnpm dev`)
✅ Registry tracking (`.claude/worktrees.json`)
✅ Zero configuration (automatic `.env.local`)

## After setup

```bash
# In each terminal
cd worktrees/issue-77 && pnpm dev
cd worktrees/issue-80 && pnpm dev
cd worktrees/issue-81 && pnpm dev

# List all active worktrees
node scripts/worktree-manager.mjs list

# When done with an issue
node scripts/worktree-manager.mjs cleanup 77
```

## See also

- `scripts/continue-roadmap.mjs` — Main orchestration script
- `scripts/worktree-manager.mjs` — Worktree CLI
- `docs/local-worktrees.md` — Full documentation
