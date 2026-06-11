#!/usr/bin/env node
/**
 * Continue Roadmap
 *
 * Automated workflow to:
 * 1. Select issues to work on
 * 2. Validate no blocking dependencies
 * 3. Create worktrees in parallel
 * 4. Start dev servers
 * 5. Open terminals
 * 6. Ready for parallel development
 *
 * Usage:
 *   node scripts/continue-roadmap.mjs
 *   (Or invoke via skill: /continue-roadmap)
 */

import fs from 'fs'
import path from 'path'
import { execSync, spawn } from 'child_process'
import readline from 'readline'

// Issue registry with dependencies
const ISSUE_REGISTRY = {
  77: {
    title: 'Survival: hunger, food, cooking & farming',
    phase: 'phase:3',
    size: 'size:L',
    components: ['systems/hunger.ts', 'items', 'recipes', 'resources', 'player-save'],
    blockingOn: [],
    blockedBy: [],
  },
  80: {
    title: 'Parties: invites, shared XP, party frames',
    phase: 'phase:3',
    size: 'size:M',
    components: ['messaging', 'party-map', 'xp-sharing', 'ui-frames'],
    blockingOn: [],
    blockedBy: [],
  },
  81: {
    title: 'Quests v1: quests.json, objective engine, quest log, Dev Mode editor',
    phase: 'phase:3',
    size: 'size:L',
    components: ['quests.json', 'objective-engine', 'quest-log', 'dev-mode'],
    blockingOn: [],
    blockedBy: [],
  },
  82: {
    title: 'De-tower-defense rename refactor',
    phase: 'phase:3',
    size: 'size:M',
    components: ['tower-defense', 'systems'],
    blockingOn: [],
    blockedBy: [],
  },
  79: {
    title: 'Trinity combat: threat/aggro tables + elite archetypes',
    phase: 'phase:3',
    size: 'size:M',
    components: ['combat', 'threat-system', 'aggro'],
    blockingOn: [],
    blockedBy: [],
  },
  78: {
    title: 'Abilities & spells: data-first abilities.json + mana + action bar',
    phase: 'phase:3',
    size: 'size:L',
    components: ['abilities.json', 'mana-system', 'action-bar'],
    blockingOn: [],
    blockedBy: [],
  },
}

const REGISTRY_FILE = '.claude/worktrees.json'
const PARALLEL_LIMIT = 4 // Max worktrees to create in parallel

function loadRegistry() {
  if (fs.existsSync(REGISTRY_FILE)) {
    return JSON.parse(fs.readFileSync(REGISTRY_FILE, 'utf8'))
  }
  return { worktrees: [] }
}

function saveRegistry(registry) {
  fs.writeFileSync(REGISTRY_FILE, JSON.stringify(registry, null, 2))
}

function validateDependencies(selectedIssues) {
  const issues = selectedIssues.map(num => parseInt(num))
  const blockers = []

  for (const issue of issues) {
    const issueData = ISSUE_REGISTRY[issue]
    if (!issueData) continue

    // Check if any blocking issue is NOT in the selection
    for (const blocking of issueData.blockingOn) {
      if (!issues.includes(blocking)) {
        blockers.push({
          issue,
          blockedBy: blocking,
          title: ISSUE_REGISTRY[blocking]?.title || `Issue #${blocking}`,
        })
      }
    }
  }

  return {
    valid: blockers.length === 0,
    blockers,
  }
}

function printIssueTable() {
  console.log('\n📋 Available Issues in Phase 3:\n')
  console.log('┌─────┬────────────────────────────────────────────┬────────┐')
  console.log('│ #   │ Issue                                      │ Size   │')
  console.log('├─────┼────────────────────────────────────────────┼────────┤')

  Object.entries(ISSUE_REGISTRY)
    .sort((a, b) => parseInt(a[0]) - parseInt(b[0]))
    .forEach(([num, issue]) => {
      const title = issue.title.substring(0, 40).padEnd(40)
      const size = issue.size.replace('size:', '')
      console.log(`│ ${String(num).padStart(3)} │ ${title} │ ${size.padEnd(6)} │`)
    })

  console.log('└─────┴────────────────────────────────────────────┴────────┘')
}

async function interactiveSelection() {
  printIssueTable()

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  })

  return new Promise(resolve => {
    rl.question(
      '\n🎯 Select issues to work on (comma-separated, e.g., 77,80,81): ',
      answer => {
        rl.close()

        const selected = answer
          .split(',')
          .map(s => s.trim())
          .filter(s => s && /^\d+$/.test(s))
          .map(Number)
          .filter((v, i, a) => a.indexOf(v) === i) // Remove duplicates
          .filter(num => ISSUE_REGISTRY[num]) // Validate exists

        resolve(selected)
      }
    )
  })
}

async function createWorktreesParallel(issues) {
  console.log(`\n⚙️  Creating ${issues.length} worktrees in parallel...`)

  const promises = issues.map(
    issueNum =>
      new Promise((resolve, reject) => {
        try {
          const branchName = `claude/issue-${issueNum}`
          const worktreePath = `worktrees/issue-${issueNum}`

          console.log(`   ⏳ Creating worktree for issue #${issueNum}...`)

          // Create worktree directory if needed
          if (!fs.existsSync('worktrees')) {
            fs.mkdirSync('worktrees', { recursive: true })
          }

          // Check if worktree already exists
          if (fs.existsSync(worktreePath)) {
            console.log(`   ℹ️  Worktree already exists for #${issueNum}`)
            resolve({ issueNum, success: true, existed: true })
            return
          }

          // Create worktree
          execSync(`git worktree add -b ${branchName} ${worktreePath}`, {
            stdio: 'pipe',
          })

          // Generate .env.local
          const portOffset = Object.keys(ISSUE_REGISTRY)
            .sort((a, b) => parseInt(a) - parseInt(b))
            .findIndex(i => parseInt(i) === issueNum)

          const clientPort = 5173 + portOffset
          const serverPort = 2567 + portOffset

          const envContent = `# Auto-generated for issue #${issueNum}
VITE_CLIENT_PORT=${clientPort}
GAME_SERVER_PORT=${serverPort}
NODE_ENV=development
LOG_LEVEL=debug
NOSTR_NSEC=
MONITOR_USER=
MONITOR_PASS=
WORKTREE_ID=issue-${issueNum}
WORKTREE_PATH=${worktreePath}
`

          fs.writeFileSync(path.join(worktreePath, '.env.local'), envContent)

          console.log(`   ✓ Issue #${issueNum} (port ${clientPort}/${serverPort})`)
          resolve({ issueNum, success: true, clientPort, serverPort })
        } catch (e) {
          console.error(`   ❌ Issue #${issueNum}: ${e.message}`)
          reject(e)
        }
      })
  )

  const results = await Promise.allSettled(promises)
  return results.map((r, i) => ({
    issueNum: issues[i],
    ...(r.status === 'fulfilled' ? r.value : { success: false, error: r.reason?.message }),
  }))
}

function updateRegistry(worktreeResults) {
  const registry = loadRegistry()

  worktreeResults.forEach(result => {
    if (!result.success) return

    const existing = registry.worktrees.findIndex(w => w.issueNumber === result.issueNum)
    const portOffset = Object.keys(ISSUE_REGISTRY)
      .sort((a, b) => parseInt(a) - parseInt(b))
      .findIndex(i => parseInt(i) === result.issueNum)

    const entry = {
      issueNumber: result.issueNum,
      branchName: `claude/issue-${result.issueNum}`,
      worktreePath: `worktrees/issue-${result.issueNum}`,
      clientPort: result.clientPort || 5173 + portOffset,
      serverPort: result.serverPort || 2567 + portOffset,
      status: 'created',
      createdAt: new Date().toISOString(),
      processes: { client: null, server: null },
    }

    if (existing >= 0) {
      registry.worktrees[existing] = entry
    } else {
      registry.worktrees.push(entry)
    }
  })

  saveRegistry(registry)
}

function openTerminals(worktreeResults) {
  console.log(`\n📂 Opening terminals for ${worktreeResults.length} worktrees...\n`)

  const successful = worktreeResults.filter(r => r.success)

  successful.forEach(result => {
    const worktreePath = `worktrees/issue-${result.issueNum}`
    const absPath = path.resolve(worktreePath)

    // Try to open terminal (macOS)
    try {
      execSync(`open -a Terminal "${absPath}"`, { stdio: 'pipe' })
      console.log(`   ✓ Opening terminal for issue #${result.issueNum}`)
    } catch (e) {
      console.log(
        `   ℹ️  Manually navigate to: cd ${worktreePath} && pnpm dev`
      )
    }
  })

  console.log()
}

function printNextSteps(worktreeResults) {
  const successful = worktreeResults.filter(r => r.success)

  console.log('\n🚀 Next Steps:\n')
  console.log('In each terminal window, run:\n')
  console.log('   pnpm dev\n')
  console.log('Then open browsers at:\n')

  successful.forEach(result => {
    console.log(`   • Issue #${result.issueNum}: http://localhost:${result.clientPort}`)
  })

  console.log(`\n✨ All worktrees running in parallel! Start coding.\n`)
  console.log('To list all worktrees:')
  console.log('   node scripts/worktree-manager.mjs list\n')
}

async function main() {
  try {
    console.log('\n🛣️  Continue Roadmap - Select Issues to Work On\n')
    console.log('=' .repeat(50))

    // Get selections
    const selected = await interactiveSelection()

    if (!selected.length) {
      console.log('❌ No issues selected')
      process.exit(1)
    }

    console.log(`\n✓ Selected: #${selected.join(', #')}`)

    // Validate dependencies
    console.log('\n🔍 Validating dependencies...')
    const depValidation = validateDependencies(selected)

    if (!depValidation.valid) {
      console.log('\n⚠️  Dependency conflicts detected:')
      depValidation.blockers.forEach(b => {
        console.log(`   Issue #${b.issue} requires #${b.blockedBy} (${b.title})`)
      })
      console.log('\n❌ Cannot proceed. Please select issues that don\'t have unmet dependencies.')
      process.exit(1)
    }

    console.log('✓ All dependencies satisfied - can work in parallel!')

    // Create worktrees
    const worktreeResults = await createWorktreesParallel(selected)

    const successCount = worktreeResults.filter(r => r.success).length
    console.log(`\n✅ Created ${successCount}/${selected.length} worktrees`)

    // Update registry
    updateRegistry(worktreeResults)

    // Open terminals
    openTerminals(worktreeResults)

    // Print next steps
    printNextSteps(worktreeResults)
  } catch (err) {
    console.error('\n❌ Error:', err.message)
    process.exit(1)
  }
}

main()
