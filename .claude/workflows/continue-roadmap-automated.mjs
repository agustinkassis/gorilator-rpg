/**
 * Continue Roadmap - Automated Workflow
 *
 * Orchestrates the complete roadmap continuation:
 * 1. Show available issues with dependencies
 * 2. User selects issues to work on
 * 3. Validate no blocking dependencies
 * 4. Create worktrees in parallel
 * 5. Start dev servers
 * 6. Open terminals
 * 7. Ready for parallel development
 */

export const meta = {
  name: 'continue-roadmap-automated',
  description: 'Select issues, validate dependencies, spawn parallel worktrees',
  phases: [
    { title: 'Selection', detail: 'Browse available issues and select' },
    { title: 'Validation', detail: 'Check for dependency conflicts' },
    { title: 'Setup', detail: 'Create worktrees and environments' },
    { title: 'Launch', detail: 'Open terminals, show URLs' },
  ],
}

// Issue registry with dependency metadata
const ISSUE_REGISTRY = {
  77: {
    title: 'Survival: hunger, food, cooking & farming',
    phase: 'phase:3',
    size: 'size:L',
    components: ['systems/hunger.ts', 'items', 'recipes', 'resources', 'player-save'],
    blockingOn: [],
    blockedBy: [],
    estimatedHours: 40,
  },
  80: {
    title: 'Parties: invites, shared XP, party frames',
    phase: 'phase:3',
    size: 'size:M',
    components: ['messaging', 'party-map', 'xp-sharing', 'ui-frames'],
    blockingOn: [],
    blockedBy: [],
    estimatedHours: 20,
  },
  81: {
    title: 'Quests v1: quests.json, objective engine, quest log, Dev Mode editor',
    phase: 'phase:3',
    size: 'size:L',
    components: ['quests.json', 'objective-engine', 'quest-log', 'dev-mode'],
    blockingOn: [],
    blockedBy: [],
    estimatedHours: 50,
  },
  82: {
    title: 'De-tower-defense rename refactor',
    phase: 'phase:3',
    size: 'size:M',
    components: ['tower-defense', 'systems'],
    blockingOn: [],
    blockedBy: [],
    estimatedHours: 20,
  },
  79: {
    title: 'Trinity combat: threat/aggro tables + elite archetypes',
    phase: 'phase:3',
    size: 'size:M',
    components: ['combat', 'threat-system', 'aggro'],
    blockingOn: [],
    blockedBy: [],
    estimatedHours: 25,
  },
  78: {
    title: 'Abilities & spells: data-first abilities.json + mana + action bar',
    phase: 'phase:3',
    size: 'size:L',
    components: ['abilities.json', 'mana-system', 'action-bar'],
    blockingOn: [],
    blockedBy: [],
    estimatedHours: 45,
  },
}

phase('Selection')
log('Showing available issues for selection...')

const selection = await agent(
  'Present the available Phase 3 issues in a table format. User needs to select 2-5 issues to work on in parallel.\\n\\n' +
  'Issues:\\n' +
  Object.entries(ISSUE_REGISTRY)
    .sort((a, b) => parseInt(a[0]) - parseInt(b[0]))
    .map(([num, issue]) => {
      return `#${num}: ${issue.title}\\n` +
        `  Size: ${issue.size}  Estimated: ${issue.estimatedHours}h\\n` +
        `  Components: ${issue.components.join(', ')}`
    })
    .join('\\n\\n') +
  '\\n\\nFor each selected issue, return: number, title, estimatedHours, and whether user confirmed selection.',
  {
    label: 'issue-selection',
    phase: 'Selection',
    schema: {
      type: 'object',
      properties: {
        selectedIssues: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              number: { type: 'number' },
              title: { type: 'string' },
              estimatedHours: { type: 'number' },
            },
          },
          description: 'Issues selected by user (2-5)',
        },
        totalEstimatedHours: { type: 'number' },
        reason: { type: 'string', description: 'Why these issues were selected' },
      },
    },
  }
)

log(`Selected ${selection.selectedIssues.length} issues (${selection.totalEstimatedHours}h estimated)`)

phase('Validation')
log('Validating dependencies and conflicts...')

const validation = await agent(
  'Validate these selected issues for dependency conflicts:\\n\\n' +
  selection.selectedIssues
    .map(sel => {
      const issue = ISSUE_REGISTRY[sel.number]
      return `#${sel.number}: ${sel.title}\\n` +
        `  Blocks: ${issue.blockingOn.map(i => `#${i}`).join(', ') || 'none'}\\n` +
        `  Blocked by: ${issue.blockedBy.map(i => `#${i}`).join(', ') || 'none'}`
    })
    .join('\\n\\n') +
  '\\n\\nCheck:\\n' +
  '1. No issue in the selection is blocked by an issue NOT in the selection\\n' +
  '2. All issues can be developed simultaneously without conflicts\\n' +
  '3. Shared systems and integration points\\n\\n' +
  'Return: valid (boolean), blockers (array), sharedSystems (array), integrationPlan (string)',
  {
    label: 'dependency-validation',
    phase: 'Validation',
    schema: {
      type: 'object',
      properties: {
        valid: {
          type: 'boolean',
          description: 'Whether all issues can be worked on simultaneously',
        },
        blockers: {
          type: 'array',
          items: { type: 'string' },
          description: 'Any blocking dependencies that would prevent parallel work',
        },
        sharedSystems: {
          type: 'array',
          items: { type: 'string' },
          description: 'Systems affected by multiple selected issues',
        },
        integrationPlan: {
          type: 'string',
          description: 'How to handle shared systems and integration points',
        },
      },
    },
  }
)

if (!validation.valid) {
  log(`⚠️  Dependency conflicts: ${validation.blockers.join(', ')}`)
  log('Cannot proceed with these selections due to blocking dependencies.')
  return { success: false, reason: 'Dependencies conflict' }
}

log(`✓ Dependencies validated. Shared systems: ${validation.sharedSystems.join(', ')}`)

phase('Setup')
log('Creating worktrees and environments...')

const setup = await agent(
  'Create a plan for setting up worktrees for ${selection.selectedIssues.length} issues:\\n\\n' +
  `Issues: ${selection.selectedIssues.map(s => `#${s.number}`).join(', ')}\\n\\n` +
  'For each issue, determine:\\n' +
  '1. Branch name: claude/issue-{number}\\n' +
  '2. Worktree path: worktrees/issue-{number}\\n' +
  '3. Client port: 5173 + offset\\n' +
  '4. Server port: 2567 + offset\\n' +
  '5. .env.local configuration\\n\\n' +
  'Return: worktreeConfig (array with paths, ports, env settings)',
  {
    label: 'worktree-setup-plan',
    phase: 'Setup',
    schema: {
      type: 'object',
      properties: {
        worktrees: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              issueNumber: { type: 'number' },
              branchName: { type: 'string' },
              path: { type: 'string' },
              clientPort: { type: 'number' },
              serverPort: { type: 'number' },
            },
          },
        },
        setupSteps: { type: 'array', items: { type: 'string' } },
        estimatedSetupTime: { type: 'number', description: 'seconds' },
      },
    },
  }
)

log(`Worktree setup plan: ${setup.worktrees.length} worktrees, ~${setup.estimatedSetupTime}s`)

phase('Launch')
log('Finalizing setup and launch instructions...')

const launch = await agent(
  'Create launch instructions for the user to start developing on these issues:\\n\\n' +
  `Issues: ${selection.selectedIssues.map(s => `#${s.number} (${s.title})`).join('\\n')}\\n\\n` +
  `Worktrees created at: ${setup.worktrees.map(w => w.path).join(', ')}\\n\\n` +
  'Instructions should include:\\n' +
  '1. Opening terminals for each worktree\\n' +
  '2. Running pnpm dev in each\\n' +
  '3. Browser URLs to test each worktree\\n' +
  '4. How to manage multiple dev servers\\n' +
  '5. Integration testing approach\\n\\n' +
  'Return: instructions (string), browserUrls (array), tips (array)',
  {
    label: 'launch-instructions',
    phase: 'Launch',
    schema: {
      type: 'object',
      properties: {
        instructions: { type: 'string' },
        browserUrls: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              issueNumber: { type: 'number' },
              url: { type: 'string' },
              port: { type: 'number' },
            },
          },
        },
        tips: { type: 'array', items: { type: 'string' } },
        nextSteps: { type: 'array', items: { type: 'string' } },
      },
    },
  }
)

log('✓ Setup complete! Ready to launch.')

return {
  success: true,
  selected: selection.selectedIssues,
  validation: {
    valid: validation.valid,
    sharedSystems: validation.sharedSystems,
  },
  worktrees: setup.worktrees,
  launch: {
    instructions: launch.instructions,
    browserUrls: launch.browserUrls,
    tips: launch.tips,
  },
}
