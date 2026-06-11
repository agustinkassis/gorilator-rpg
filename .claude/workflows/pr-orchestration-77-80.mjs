/**
 * PR Orchestration Workflow
 * Creates and manages PRs linked to GitHub issues with auto-close on merge
 * Issues: #77, #80
 * Generated: 2026-06-11T18:51:42.638Z
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

const ISSUES = [
  {
    "number": 77,
    "title": "Survival: hunger, food, cooking & farming",
    "phase": "phase:3",
    "size": "size:L",
    "tier": "tier:core",
    "components": [
      "systems/hunger.ts",
      "items",
      "recipes",
      "resources",
      "player-save"
    ],
    "estimatedHours": 40,
    "branchName": "claude/issue-77-survival-hunger-food-cooking-farmin"
  },
  {
    "number": 80,
    "title": "Parties: invites, shared XP, party frames",
    "phase": "phase:3",
    "size": "size:M",
    "tier": "tier:core",
    "components": [
      "messaging",
      "party-map",
      "xp-sharing",
      "ui-frames"
    ],
    "estimatedHours": 20,
    "branchName": "claude/issue-80-parties-invites-shared-xp-party-fra"
  }
]

phase('Planning')
log(`Planning PR creation for ${ISSUES.length} issues...`)

const prPlan = await agent(
  'Create a PR strategy for these GitHub issues:\n\n' +
  ISSUES.map(i =>
    `#${i.number}: ${i.title}\n` +
    `- Branch: ${i.branchName}\n` +
    `- Components: ${i.components.join(', ')}`
  ).join('\n\n') +
  `\n\nFor each issue:\n` +
  `1. Should the PR be created immediately or after implementation starts?\n` +
  `2. What reviewers should be assigned?\n` +
  `3. Should PRs be kept as drafts until ready?\n` +
  `4. What integration tests should block merge?\n\n` +
  `Return: PR timing strategy, reviewer assignments, merge blocking requirements.`,
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

log(`PR timing: ${prPlan.timing}, Draft mode: ${prPlan.draftMode ? 'yes' : 'no'}`)
log(`Reviewers: ${prPlan.reviewers.join(', ')}`)

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
      prTemplate: `## Issue #${issue.number}: ${issue.title}\n\n` +
        `**Components affected:**\n` +
        issue.components.map(c => `- \`${c}\``).join('\n') +
        `\n\n**Definition of Done:**\n` +
        `- [ ] Scenario manifest created\n` +
        `- [ ] Bot self-test passes\n` +
        `- [ ] Knobs tweaked and balanced\n` +
        `- [ ] Verification ladder green\n` +
        `- [ ] Docs updated\n\n` +
        `Closes #${issue.number}`,
    }
  })
)

log(`Prepared ${branches.length} branches with PR templates`)

phase('PR Creation')
log('Creating linked pull requests...')

const prResults = await parallel(
  branches.map(branch => async () => {
    return agent(
      `Create a GitHub PR for issue #${branch.issue}: "${branch.title}"\n\n` +
      `Branch: ${branch.branch}\n` +
      `Components: ${branch.components.join(', ')}\n\n` +
      `PR Description Template:\n${branch.prTemplate}\n\n` +
      `Instructions:\n` +
      `1. Use \`gh pr create\` to create the PR\n` +
      `2. Include "Closes #${branch.issue}" in description (enables auto-close on merge)\n` +
      `3. Set as DRAFT if code isn't ready yet\n` +
      `4. Add labels from issue: ${prPlan.timing === 'draft' ? '🚧 work-in-progress' : '🔄 ready-for-review'}\n` +
      `5. Return: PR URL, PR number, creation status\n\n` +
      `Make sure the "Closes #${branch.issue}" line is in the description so GitHub auto-closes the issue when merged.`,
      {
        label: `create-pr:issue-${branch.issue}`,
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
log(`Created ${createdPRs.length} PRs. Each linked with "Closes #XXX" for auto-closure.`)

phase('Tracking')
log('Setting up PR-to-issue tracking and monitoring...')

const tracking = await agent(
  `Create a PR-to-issue tracking strategy for these PRs:\n\n` +
  prResults.filter(Boolean).map(r =>
    `PR #${r.pr.prNumber} (Issue #${r.issue}): ${r.title}\n` +
    `- URL: ${r.pr.prUrl}\n` +
    `- Auto-close: ${r.pr.closesIssueOnMerge ? 'enabled' : 'MISSING'}`
  ).join('\n\n') +
  `\n\nProvide:\n` +
  `1. Merge order (respecting dependencies)\n` +
  `2. Verification checklist before each merge\n` +
  `3. Post-merge validation steps\n` +
  `4. Dashboard query for tracking progress\n\n` +
  `Return: tracking plan with GitHub CLI commands to monitor all PRs.`,
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

log(`Merge order: #${tracking.mergeOrder.join(' → #')}`)
log(`Estimated completion: ${tracking.estimatedCompletionDays} days`)
log(`
To monitor all PRs, run:\n${tracking.monitoringCommands[0]}`)

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
