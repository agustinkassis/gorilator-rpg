#!/usr/bin/env node
/**
 * PR Orchestration Script
 *
 * Creates and manages pull requests linked to GitHub issues with automatic closure on merge.
 * Each issue gets a dedicated PR with "Closes #XXX" in the description.
 *
 * Usage:
 *   node scripts/pr-orchestration.mjs [issue-numbers...]
 *   node scripts/pr-orchestration.mjs 77 80
 */

import { execSync } from 'child_process'
import fs from 'fs'
import path from 'path'

// Issue registry with PR metadata
const ISSUE_REGISTRY = {
  77: {
    title: 'Survival: hunger, food, cooking & farming',
    phase: 'phase:3',
    size: 'size:L',
    tier: 'tier:core',
    components: ['systems/hunger.ts', 'items', 'recipes', 'resources', 'player-save'],
    estimatedHours: 40,
  },
  80: {
    title: 'Parties: invites, shared XP, party frames',
    phase: 'phase:3',
    size: 'size:M',
    tier: 'tier:core',
    components: ['messaging', 'party-map', 'xp-sharing', 'ui-frames'],
    estimatedHours: 20,
  },
  81: {
    title: 'Quests v1: quests.json, objective engine, quest log, Dev Mode editor',
    phase: 'phase:3',
    size: 'size:L',
    tier: 'tier:core',
    components: ['quests.json', 'objective-engine', 'quest-log', 'dev-mode'],
    estimatedHours: 50,
  },
  82: {
    title: 'De-tower-defense rename refactor (dedicated PRs)',
    phase: 'phase:3',
    size: 'size:M',
    tier: 'tier:core',
    components: ['tower-defense', 'systems'],
    estimatedHours: 20,
  },
}

function generateBranchName(issueNumber, title) {
  const slug = title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 35)
  return `claude/issue-${issueNumber}-${slug}`
}

function generatePRDescription(issueNumber, title, components, estimatedHours) {
  return `## Issue #${issueNumber}: ${title}

**Components affected:**
${components.map(c => `- \`${c}\``).join('\n')}

**Estimated effort:** ${estimatedHours} hours

**Definition of Done:**
- [ ] Scenario manifest created
- [ ] Bot self-test passes
- [ ] Knobs tweaked and balanced
- [ ] Verification ladder green
- [ ] Docs updated

**Integration points:** See linked issue for shared system dependencies

Closes #${issueNumber}`
}

function generateWorkflowScript(issues) {
  const issueList = issues
    .map(num => {
      const issue = ISSUE_REGISTRY[num]
      if (!issue) return null
      return {
        number: num,
        ...issue,
        branchName: generateBranchName(num, issue.title),
      }
    })
    .filter(Boolean)

  return `/**
 * PR Orchestration Workflow
 * Creates and manages PRs linked to GitHub issues with auto-close on merge
 * Issues: #${issues.join(', #')}
 * Generated: ${new Date().toISOString()}
 */

export const meta = {
  name: 'pr-orchestration-workflow',
  description: 'Create and manage PRs linked to issues with auto-close on merge',
  phases: [
    { title: 'Planning', detail: 'Analyze issues and plan PRs' },
    { title: 'Branch Setup', detail: 'Create branches and PR templates' },
    { title: 'PR Creation', detail: 'Create linked PRs in GitHub' },
    { title: 'Tracking', detail: 'Monitor PRs and issue closure' },
  ],
}

const ISSUES = ${JSON.stringify(issueList, null, 2)}

phase('Planning')
log(\`Planning PR creation for \${ISSUES.length} issues...\`)

const prPlan = await agent(
  'Create a PR strategy for these GitHub issues:\\n\\n' +
  ISSUES.map(i =>
    \`#\${i.number}: \${i.title}\\n\` +
    \`- Branch: \${i.branchName}\\n\` +
    \`- Components: \${i.components.join(', ')}\`
  ).join('\\n\\n') +
  \`\\n\\nFor each issue:\\n\` +
  \`1. Should the PR be created immediately or after implementation starts?\\n\` +
  \`2. What reviewers should be assigned?\\n\` +
  \`3. Should PRs be kept as drafts until ready?\\n\` +
  \`4. What integration tests should block merge?\\n\\n\` +
  \`Return: PR timing strategy, reviewer assignments, merge blocking requirements.\`,
  {
    label: 'pr-strategy',
    schema: {
      type: 'object',
      properties: {
        timing: {
          type: 'string',
          enum: ['immediate', 'after-analysis', 'after-implementation'],
          description: 'When to create PRs'
        },
        draftMode: {
          type: 'boolean',
          description: 'Start PRs as draft'
        },
        reviewers: {
          type: 'array',
          items: { type: 'string' },
          description: 'GitHub usernames for reviewers'
        },
        blockingTests: {
          type: 'array',
          items: { type: 'string' },
          description: 'CI checks that must pass before merge'
        },
        prTemplate: {
          type: 'string',
          description: 'Template for PR description'
        }
      }
    }
  }
)

log(\`PR timing: \${prPlan.timing}, Draft mode: \${prPlan.draftMode ? 'yes' : 'no'}\`)
log(\`Reviewers: \${prPlan.reviewers.join(', ')}\`)

phase('Branch Setup')
log('Setting up branches and tracking...')

const branches = await parallel(
  ISSUES.map(issue => async () => {
    return {
      issue: issue.number,
      title: issue.title,
      branch: issue.branchName,
      components: issue.components,
      estimatedHours: issue.estimatedHours,
      prTemplate: \`## Issue #\${issue.number}: \${issue.title}\\n\\n\` +
        \`**Components affected:**\\n\` +
        issue.components.map(c => \`- \\\`\${c}\\\`\`).join('\\n') +
        \`\\n\\n**Definition of Done:**\\n\` +
        \`- [ ] Scenario manifest created\\n\` +
        \`- [ ] Bot self-test passes\\n\` +
        \`- [ ] Knobs tweaked and balanced\\n\` +
        \`- [ ] Verification ladder green\\n\` +
        \`- [ ] Docs updated\\n\\n\` +
        \`Closes #\${issue.number}\`,
    }
  })
)

log(\`Prepared \${branches.length} branches with PR templates\`)

phase('PR Creation')
log('Creating linked pull requests...')

const prResults = await parallel(
  branches.map(branch => async () => {
    return agent(
      \`Create a GitHub PR for issue #\${branch.issue}: "\${branch.title}"\\n\\n\` +
      \`Branch: \${branch.branch}\\n\` +
      \`Components: \${branch.components.join(', ')}\\n\\n\` +
      \`PR Description Template:\\n\${branch.prTemplate}\\n\\n\` +
      \`Instructions:\\n\` +
      \`1. Use \\\`gh pr create\\\` to create the PR\\n\` +
      \`2. Include "Closes #\${branch.issue}" in description (enables auto-close on merge)\\n\` +
      \`3. Set as DRAFT if code isn't ready yet\\n\` +
      \`4. Add labels from issue: \${prPlan.timing === 'draft' ? '🚧 work-in-progress' : '🔄 ready-for-review'}\\n\` +
      \`5. Return: PR URL, PR number, creation status\\n\\n\` +
      \`Make sure the "Closes #\${branch.issue}" line is in the description so GitHub auto-closes the issue when merged.\`,
      {
        label: \`create-pr:issue-\${branch.issue}\`,
        phase: 'PR Creation',
        schema: {
          type: 'object',
          properties: {
            issue: { type: 'number' },
            prNumber: { type: 'number' },
            prUrl: { type: 'string' },
            branch: { type: 'string' },
            status: { type: 'string', enum: ['created', 'already-exists', 'error'] },
            closesIssueOnMerge: { type: 'boolean' },
          }
        }
      }
    ).then(r => ({ ...branch, pr: r }))
  })
)

const createdPRs = prResults.filter(r => r?.pr?.status === 'created')
log(\`Created \${createdPRs.length} PRs. Each linked with "Closes #XXX" for auto-closure.\`)

phase('Tracking')
log('Setting up PR-to-issue tracking and monitoring...')

const tracking = await agent(
  \`Create a PR-to-issue tracking strategy for these PRs:\\n\\n\` +
  prResults.filter(Boolean).map(r =>
    \`PR #\${r.pr.prNumber} (Issue #\${r.issue}): \${r.title}\\n\` +
    \`- URL: \${r.pr.prUrl}\\n\` +
    \`- Auto-close: \${r.pr.closesIssueOnMerge ? 'enabled' : 'MISSING'}\`
  ).join('\\n\\n') +
  \`\\n\\nProvide:\\n\` +
  \`1. Merge order (respecting dependencies)\\n\` +
  \`2. Verification checklist before each merge\\n\` +
  \`3. Post-merge validation steps\\n\` +
  \`4. Dashboard query for tracking progress\\n\\n\` +
  \`Return: tracking plan with GitHub CLI commands to monitor all PRs.\`,
  {
    label: 'pr-tracking-strategy',
    schema: {
      type: 'object',
      properties: {
        mergeOrder: {
          type: 'array',
          items: { type: 'number' },
          description: 'Order to merge PRs'
        },
        preCheckList: {
          type: 'array',
          items: { type: 'string' },
          description: 'Things to verify before merging each PR'
        },
        postMergeValidation: {
          type: 'array',
          items: { type: 'string' },
          description: 'Tests/checks to run after each merge'
        },
        monitoringCommands: {
          type: 'array',
          items: { type: 'string' },
          description: 'GitHub CLI commands to monitor PRs'
        },
        estimatedCompletionDays: { type: 'number' },
      }
    }
  }
)

log(\`Merge order: #\${tracking.mergeOrder.join(' → #')}\`)
log(\`Estimated completion: \${tracking.estimatedCompletionDays} days\`)
log(\`\nTo monitor all PRs, run:\\n\${tracking.monitoringCommands[0]}\`)

return {
  prPlan,
  branches: branches.filter(Boolean),
  createdPRs: prResults.filter(Boolean),
  tracking,
  summary: {
    totalIssues: ISSUES.length,
    prsCreated: createdPRs.length,
    allLinked: prResults.every(r => r?.pr?.closesIssueOnMerge),
    mergeOrder: tracking.mergeOrder,
  },
}
`
}

// Main
const issueNumbers = process.argv.slice(2).map(Number)
if (!issueNumbers.length) {
  console.log('Usage: node scripts/pr-orchestration.mjs [issue-numbers...]')
  console.log('Example: node scripts/pr-orchestration.mjs 77 80')
  console.log('\nAvailable issues:')
  Object.entries(ISSUE_REGISTRY).forEach(([num, issue]) => {
    console.log(`  #${num}: ${issue.title}`)
  })
  process.exit(1)
}

const workflowScript = generateWorkflowScript(issueNumbers)
const workflowDir = '.claude/workflows'
const outputPath = path.join(workflowDir, `pr-orchestration-${issueNumbers.join('-')}.mjs`)

// Ensure directory exists
if (!fs.existsSync(workflowDir)) {
  fs.mkdirSync(workflowDir, { recursive: true })
}

fs.writeFileSync(outputPath, workflowScript)

console.log(`✓ Generated PR orchestration workflow: ${outputPath}`)
console.log(`✓ Run with: workflow --scriptPath "${outputPath}"`)
console.log(`\nThis workflow will:`)
console.log(`  1. Plan PR strategy and timing`)
console.log(`  2. Prepare branches and PR templates`)
console.log(`  3. Create PRs linked to issues with "Closes #XXX"`)
console.log(`  4. Track PRs and plan merge order`)
console.log(`\nWhen each PR is merged, its linked issue will automatically close.`)
