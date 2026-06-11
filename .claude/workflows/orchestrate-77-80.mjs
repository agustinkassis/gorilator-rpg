/**
 * Generated Multi-Issue Workflow
 * Issues: #77, #80
 * Generated: 2026-06-11T18:44:37.626Z
 */

export const meta = {
  name: 'multi-issue-orchestration',
  description: 'Parallel agents for issues #77, #80 with dependency tracking',
  phases: [
    { title: 'Analysis', detail: 'Map dependencies and blockers' },
    { title: 'Planning', detail: 'Create implementation plan per issue' },
    { title: 'Development', detail: 'Spawn parallel development agents' },
    { title: 'Integration', detail: 'Validate and manage PRs' },
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
    "blockingOn": [],
    "blockedBy": [],
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
    "blockingOn": [],
    "blockedBy": [],
    "estimatedHours": 20,
    "branchName": "claude/issue-80-parties-invites-shared-xp-party-fra"
  }
]

phase('Analysis')
log(`Analyzing dependencies for ${ISSUES.length} issues...`)

const analysis = await agent(
  'Analyze these GitHub issues for dependencies and integration points:\n\n' +
  ISSUES.map(i => `#${i.number}: ${i.title}\nComponents: ${i.components.join(', ')}`).join('\n\n') +
  '\n\nReturn: dependency tree, work order, shared systems, and integration risks.',
  {
    label: 'dependency-analysis',
    schema: {
      type: 'object',
      properties: {
        dependencyTree: { type: 'string' },
        workOrder: { type: 'array', items: { type: 'number' } },
        sharedSystems: { type: 'array', items: { type: 'string' } },
        integrationRisks: { type: 'array', items: { type: 'string' } },
      }
    }
  }
)

log(`Recommended work order: #${analysis.workOrder.join(' → #')}`)
log(`Shared systems: ${analysis.sharedSystems.join(', ')}`)

phase('Planning')
log('Creating implementation plans per issue...')

const plans = await parallel(
  ISSUES.map(issue => () => agent(
    `Create a detailed implementation plan for issue #${issue.number}: "${issue.title}"\n\n` +
    `Components: ${issue.components.join(', ')}\n` +
    `Estimated effort: ${issue.estimatedHours} hours\n\n` +
    `Include: checklist of tasks, estimated timeline, dependencies, and Definition of Done validation.`,
    {
      label: `plan:issue-${issue.number}`,
      phase: 'Planning',
      schema: {
        type: 'object',
        properties: {
          issue: { type: 'number' },
          tasks: { type: 'array', items: { type: 'string' } },
          daysEstimate: { type: 'number' },
          blockingOn: { type: 'array', items: { type: 'number' } },
          integrationPoints: { type: 'array', items: { type: 'string' } },
        }
      }
    }
  ).then(p => ({ ...issue, plan: p }))
)
)

log(`Planning complete: ${plans.filter(Boolean).length} plans generated`)

phase('Development')
log('Spawning parallel development agents...')

const devResults = await parallel(
  plans.filter(Boolean).map(p => () => agent(
    `You are assigned to issue #${p.number}: "${p.title}"\n` +
    `Branch: ${p.branchName}\n\n` +
    `Implementation Plan:\n` +
    p.plan.tasks.map((t, i) => `${i + 1}. ${t}`).join('\n') +
    `\n\nStart by: analyzing the current codebase, identifying affected files, and reporting back with the first 3 concrete implementation steps.`,
    {
      label: `dev:issue-${p.number}`,
      phase: 'Development',
      schema: {
        type: 'object',
        properties: {
          issue: { type: 'number' },
          filesToCreate: { type: 'array', items: { type: 'string' } },
          filesToModify: { type: 'array', items: { type: 'string' } },
          nextSteps: { type: 'array', items: { type: 'string' }, maxItems: 3 },
          blockers: { type: 'array', items: { type: 'string' } },
        }
      }
    }
  ).then(r => ({ issue: p.number, ...r }))
  )
)

log(`Development reports: ${devResults.filter(Boolean).length} agents completed analysis`)

phase('Integration')
log('Creating PR sequencing and integration plan...')

const integration = await agent(
  `Based on these development reports, create a PR strategy:\n\n` +
  devResults.filter(Boolean).map(r =>
    `Issue #${r.issue}:\n` +
    `- Files to create: ${r.filesToCreate?.join(', ') || 'none'}\n` +
    `- Files to modify: ${r.filesToModify?.length || 0}\n` +
    `- Blockers: ${r.blockers?.join(', ') || 'none'}`
  ).join('\n\n') +
  `\n\nProvide: PR merge order, parallelizable issues, integration tests, and timeline.`,
  {
    label: 'integration-strategy',
    schema: {
      type: 'object',
      properties: {
        prMergeOrder: { type: 'array', items: { type: 'number' } },
        parallelIssues: { type: 'array', items: { type: 'number' } },
        integrationTests: { type: 'array', items: { type: 'string' } },
        totalDaysEstimate: { type: 'number' },
        risks: { type: 'array', items: { type: 'string' } },
      }
    }
  }
)

log(`Integration plan: Merge #${integration.prMergeOrder.join(' → #')}`)
log(`Estimated completion: ${integration.totalDaysEstimate} days`)

return {
  analysis,
  plans: plans.filter(Boolean),
  development: devResults.filter(Boolean),
  integration,
}
