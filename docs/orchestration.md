# Multi-Issue Orchestration Pipeline

A repeatable, automated pipeline for parallel development across multiple GitHub issues with dependency tracking, worktree isolation, and PR management.

## Overview

This pipeline orchestrates work on multiple issues simultaneously by:

1. **Analyzing dependencies** between issues
2. **Planning implementations** per issue
3. **Spawning parallel agents** that develop in isolation
4. **Managing PRs** with respect to dependencies
5. **Tracking shared systems** and integration risks

## Architecture

```
┌─────────────────────────────────────────────────────────────┐
│ Multi-Issue Orchestration Pipeline                          │
├─────────────────────────────────────────────────────────────┤
│                                                             │
│  Phase 1: ANALYSIS                                          │
│  ├─ Parse GitHub issues                                    │
│  ├─ Map component dependencies                             │
│  ├─ Identify shared systems                                │
│  └─ Calculate work order                                   │
│                                                             │
│  Phase 2: PLANNING                                          │
│  ├─ Create implementation plans per issue                  │
│  ├─ Generate task checklists                               │
│  ├─ Estimate timelines                                     │
│  └─ Identify blockers                                      │
│                                                             │
│  Phase 3: DEVELOPMENT (PARALLEL)                           │
│  ├─ Agent 1: Work on Issue #77                             │
│  ├─ Agent 2: Work on Issue #80                             │
│  └─ Each in isolated worktree                              │
│                                                             │
│  Phase 4: INTEGRATION                                       │
│  ├─ Validate no conflicts                                  │
│  ├─ Create PR merge order                                  │
│  ├─ Generate integration tests                             │
│  └─ Plan rollout                                           │
│                                                             │
└─────────────────────────────────────────────────────────────┘
```

## Quick Start

### Generate and run the orchestration workflow:

```bash
# For issues #77 and #80
node scripts/multi-issue-orchestration.mjs 77 80

# This creates: .claude/workflows/orchestrate-77-80.mjs
# Then run with: workflow --scriptPath ".claude/workflows/orchestrate-77-80.mjs"
```

### Or run directly:

```bash
workflow --script "$(cat .claude/workflows/orchestrate-77-80.mjs)"
```

## Issue Registry

All issues are pre-registered with metadata. Add new issues to `scripts/multi-issue-orchestration.mjs`:

```javascript
const ISSUE_REGISTRY = {
  [number]: {
    title: 'Issue title',
    phase: 'phase:X',
    size: 'size:M',  // S, M, L
    tier: 'tier:core',
    components: ['path/to/component', 'another/component'],
    blockingOn: [],  // other issue numbers this blocks on
    blockedBy: [],   // other issue numbers blocking this
    estimatedHours: 20,
  }
}
```

## Dependency Tree Format

The dependency analysis produces a dependency tree in plain text:

```
Issue #77 (Survival: hunger, food, farming)
├─ no blocking dependencies
├─ affects: player-save, UI (HUD)
└─ shared systems: items, recipes

Issue #80 (Parties: invites, XP, frames)
├─ no blocking dependencies
├─ affects: messaging, party management
└─ shared systems: XP calculation
```

## Worktrees and Branches

Each issue gets its own branch and worktree:

```
Main branch: main
├─ Issue #77: claude/issue-77-survival-hunger-food-cooking-farming
├─ Issue #80: claude/issue-80-parties-invites-shared-xp-party-frames
└─ Dev servers run independently per worktree
```

## PR Management

The pipeline respects dependencies when sequencing PR merges:

```
Analysis → determine work order
  #77 → #80  (no dependencies)
  
OR

#77 ◄─┐
      ├─ merge → #80  (if #77 required by #80)
#80 ──┘
```

## Development Workflow

Each parallel agent:

1. Reads issue description and Definition of Done
2. Analyzes current codebase for affected components
3. Creates implementation plan with task checklist
4. Reports blockers and integration points
5. Prepares for implementation

## Integration Points

Shared systems that need testing after any merge:

- **Player Save Format** (Issue #77)
  - Hunger field added to PlayerSave v2
  - Tests: save/load round-trip

- **Messaging System** (Issue #80)
  - Party invite/accept messages
  - Tests: message routing, party creation

- **XP System** (Issues #77 and #80)
  - Individual and shared XP
  - Tests: XP gain, party XP sharing

## Definition of Done Checklist

All issues follow the same DoD (from `docs/feature-lab.md`):

- [ ] Scenario manifest created
- [ ] Bot self-test passes
- [ ] Knobs tweaked and balanced
- [ ] Verification ladder green
- [ ] Docs updated

## Monitoring Progress

Track all issues at once:

```bash
gh issue view 77 --json state,title,labels
gh issue view 80 --json state,title,labels
```

## Making It Repeatable

This pipeline is designed to be run multiple times:

1. **Update issue registry** as new issues are created
2. **Run with different issue sets**: `node scripts/multi-issue-orchestration.mjs 81 82 83`
3. **Reuse workflow templates** for similar feature phases
4. **Adapt to your needs** — modify the script to add custom phases

## Common Patterns

### Sequential Issues (with dependencies)

```
workflow --scriptPath ".claude/workflows/orchestrate-95-94-93.mjs"
# Issues are sequenced respecting blockingOn relationships
```

### Parallel Issues (no dependencies)

```
workflow --scriptPath ".claude/workflows/orchestrate-77-80.mjs"
# Issues are developed in full parallel
```

### Large Batch (5+ issues)

```
node scripts/multi-issue-orchestration.mjs 77 78 79 80 81
# Automatically scales agent pool
```

## Troubleshooting

### "Issue not in registry"
Add it to `ISSUE_REGISTRY` in `scripts/multi-issue-orchestration.mjs`

### "Dependency analysis missing issues"
Ensure all issue numbers in `ISSUE_REGISTRY` have `blockingOn` and `blockedBy` fields

### "PR merge conflicts"
The dependency analysis identifies these — resolve in order or split PRs

## Next Steps

1. ✅ Generate workflow for your selected issues
2. Review the dependency tree for correctness
3. Run the workflow to spawn parallel agents
4. Monitor progress via `/workflows`
5. Manage PRs as agents complete work
