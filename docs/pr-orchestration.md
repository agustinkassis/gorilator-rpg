# PR Orchestration: Issue-to-PR Linking & Auto-Close

Automated workflow for creating pull requests linked to GitHub issues with automatic closure on merge.

## Overview

Each issue gets a dedicated PR that:
- ✅ Links to the issue via `Closes #XXX` in description
- ✅ Auto-closes when merged to target branch
- ✅ Tracks dependencies and merge order
- ✅ Validates Definition of Done before merge
- ✅ Provides monitoring and status dashboard

## How It Works

### PR Linking Mechanism

GitHub automatically closes linked issues when a PR is merged. The magic is the `Closes #XXX` keyword in the PR description:

```markdown
## Issue #77: Survival: hunger, food, cooking & farming

**Components affected:**
- `systems/hunger.ts`
- `items`
- `recipes`

**Definition of Done:**
- [ ] Scenario manifest created
- [ ] Bot self-test passes
- [ ] Verification ladder green
- [ ] Docs updated

Closes #77  ← This closes the issue when merged
```

### Workflow Phases

```
┌─────────────────────────────────────────────────────┐
│ Phase 1: Planning                                   │
│ - Analyze issue dependencies                        │
│ - Decide: draft vs ready-for-review                 │
│ - Assign reviewers                                  │
│ - Plan merge order                                  │
└─────────────────────────────────────────────────────┘
                         ↓
┌─────────────────────────────────────────────────────┐
│ Phase 2: Branch Setup                               │
│ - Create branches per issue                         │
│ - Prepare PR templates                              │
│ - Set up tracking                                   │
└─────────────────────────────────────────────────────┘
                         ↓
┌─────────────────────────────────────────────────────┐
│ Phase 3: PR Creation                                │
│ - Create PRs with "Closes #XXX"                     │
│ - Add labels and assignees                          │
│ - Optional: start as draft                          │
└─────────────────────────────────────────────────────┘
                         ↓
┌─────────────────────────────────────────────────────┐
│ Phase 4: Tracking & Monitoring                      │
│ - Monitor PR status                                 │
│ - Track issue closure                               │
│ - Plan merge order                                  │
│ - Validation checklists                             │
└─────────────────────────────────────────────────────┘
```

## Quick Start

### Generate PR orchestration workflow:

```bash
# For issues #77 and #80
node scripts/pr-orchestration.mjs 77 80

# This creates: .claude/workflows/pr-orchestration-77-80.mjs
```

### Run the workflow:

```bash
workflow --scriptPath ".claude/workflows/pr-orchestration-77-80.mjs"
```

The workflow will:
1. Plan PR strategy (timing, reviewers, blocking tests)
2. Create branches and PR templates
3. Create PRs in GitHub with proper linking
4. Plan merge order and validation steps

## PR Description Template

Every PR auto-generated includes:

```markdown
## Issue #XXX: [Title]

**Components affected:**
- `component/path`
- `another/component`

**Estimated effort:** X hours

**Definition of Done:**
- [ ] Scenario manifest created
- [ ] Bot self-test passes
- [ ] Knobs tweaked and balanced
- [ ] Verification ladder green
- [ ] Docs updated

**Integration points:** See linked issue

Closes #XXX
```

The `Closes #XXX` line is **required** — without it, the issue won't auto-close on merge.

## Monitoring PR Status

### View all open PRs:

```bash
gh pr list --state open --json number,title,state,labels
```

### View PRs linked to an issue:

```bash
gh issue view 77 --json number,title,closingPullRequests
```

### Track PR and issue together:

```bash
gh pr view [number] --json title,body,state
# Check the "Closes #XXX" in the body to see linked issue
```

## Merge Validation Checklist

Before merging each PR:

- [ ] All CI checks pass (code review, tests, version check)
- [ ] Definition of Done validated (from PR description)
- [ ] No merge conflicts with target branch
- [ ] Integration points tested (shared systems)
- [ ] Docs updated and reviewed

## After Merge: Automatic Closure

When the PR is merged:

1. ✅ GitHub automatically closes the linked issue
2. ✅ Issue moves to "Closed" state
3. ✅ PR appears in issue's "Linked pull requests" section
4. ✅ Commits appear in issue timeline

No manual issue closure needed — it's automatic.

## Merge Sequencing

Issues without dependencies can merge in parallel:

```
#77 (Survival)  ─→ Ready to merge first
                     ↓
#80 (Parties)   ─→ Can merge in parallel

Both PRs can merge without affecting each other
```

Issues with dependencies must merge in order:

```
#81 (Quests)    ─→ Must merge first (blocks #82)
                     ↓
#82 (Rename)    ─→ Depends on #81, merge after
```

## Integration Test Strategy

After each PR merges, run:

```bash
# Full integration test suite
pnpm test:integration

# Dev server verification
pnpm dev  # Ensure game starts
```

Critical integration tests per issue:

- **#77 (Survival):** Player save format, hunger system, food items
- **#80 (Parties):** Messaging, party creation, XP sharing
- **#81 (Quests):** Quest manifest, objectives, quest log UI
- **#82 (Rename):** Tower defense refactor, system consistency

## PR Status Dashboard

View all PRs and their linked issues:

```bash
# All open PRs with their status
gh pr list --state open \
  --json number,title,state,labels,url \
  --template '{{range .}}#{{.number}}: {{.title}} [{{.state}}]{{"\n"}}{{end}}'

# Track which issues are "done" (PR merged)
gh issue list --state closed --limit 10 \
  --json number,title,state,closedAt
```

## Troubleshooting

### "Issue didn't close when PR merged"

Check the PR description has `Closes #XXX`:

```bash
gh pr view [number] --json body | grep -i "closes #"
```

If missing, edit the PR description to add it.

### "PR isn't linked to issue"

GitHub requires exact format: `Closes #XXX` in the PR body (not title).

Valid formats:
- `Closes #77`
- `Fixes #77`
- `Resolves #77`
- `Closes: #77`

### "Multiple issues in one PR"

You can close multiple issues in a single PR:

```markdown
Closes #77
Closes #80
Closes #81
```

All three issues will close when the PR merges.

## Advanced: Custom Merge Conditions

Block merge until certain conditions:

```bash
# Require specific branch protection rule
# (via GitHub repo settings → Branch protection rules)
```

Set in GitHub UI:
- Require status checks to pass
- Require code review approval
- Dismiss stale PR reviews
- Require branches to be up to date

## Best Practices

1. **Create PR early** — start as draft when issue is ready
2. **Update status in PR body** — keep DoD checklist current
3. **Link related PRs** — mention other PR numbers in description
4. **Merge in dependency order** — respect blockingOn relationships
5. **Validate integration** — run tests after each merge
6. **Close one issue per PR** — avoid multi-issue PRs unless essential

## Next Steps

1. Run the PR orchestration workflow
2. Review generated PR templates
3. Start development on each issue
4. Mark Definition of Done items as complete
5. When ready, request review
6. Merge and watch issues auto-close

---

**See also:**
- `docs/orchestration.md` — Multi-issue parallel development
- `AGENTS.md` — Agent workflow and versioning
- GitHub PR docs: https://docs.github.com/en/github/collaborating-with-pull-requests
