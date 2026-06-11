#!/usr/bin/env node
/**
 * Local Worktree Manager
 *
 * Create and manage isolated git worktrees for parallel issue development.
 * Each worktree has its own environment, ports, and dev servers.
 *
 * Usage:
 *   node scripts/worktree-manager.mjs create <issue-number>
 *   node scripts/worktree-manager.mjs list
 *   node scripts/worktree-manager.mjs start <issue-number>
 *   node scripts/worktree-manager.mjs stop <issue-number>
 *   node scripts/worktree-manager.mjs shells
 *   node scripts/worktree-manager.mjs cleanup <issue-number>
 *
 * Examples:
 *   node scripts/worktree-manager.mjs create 77
 *   node scripts/worktree-manager.mjs start 77
 *   node scripts/worktree-manager.mjs list
 */

import fs from 'fs'
import path from 'path'
import { execSync, spawn } from 'child_process'
import os from 'os'

const WORKTREES_DIR = 'worktrees'
const REGISTRY_FILE = '.claude/worktrees.json'
const BASE_CLIENT_PORT = 5173
const BASE_SERVER_PORT = 2567

// Ensure registry dir
const registryDir = path.dirname(REGISTRY_FILE)
if (!fs.existsSync(registryDir)) {
  fs.mkdirSync(registryDir, { recursive: true })
}

// Issue registry
const ISSUE_REGISTRY = {
  77: {
    title: 'Survival: hunger, food, cooking & farming',
    phase: 'phase:3',
    size: 'size:L',
    components: ['systems/hunger.ts', 'items', 'recipes', 'resources', 'player-save'],
  },
  80: {
    title: 'Parties: invites, shared XP, party frames',
    phase: 'phase:3',
    size: 'size:M',
    components: ['messaging', 'party-map', 'xp-sharing', 'ui-frames'],
  },
  81: {
    title: 'Quests v1: quests.json, objective engine, quest log, Dev Mode editor',
    phase: 'phase:3',
    size: 'size:L',
    components: ['quests.json', 'objective-engine', 'quest-log', 'dev-mode'],
  },
  82: {
    title: 'De-tower-defense rename refactor',
    phase: 'phase:3',
    size: 'size:M',
    components: ['tower-defense', 'systems'],
  },
}

function loadRegistry() {
  if (fs.existsSync(REGISTRY_FILE)) {
    return JSON.parse(fs.readFileSync(REGISTRY_FILE, 'utf8'))
  }
  return { worktrees: [] }
}

function saveRegistry(registry) {
  fs.writeFileSync(REGISTRY_FILE, JSON.stringify(registry, null, 2))
}

function generateBranchName(issueNumber) {
  return `claude/issue-${issueNumber}`
}

function getWorktreePath(issueNumber) {
  return path.join(WORKTREES_DIR, `issue-${issueNumber}`)
}

function getPortOffset(issueNumber) {
  // Map issue numbers to port offsets (77->0, 80->1, 81->2, etc.)
  const issues = Object.keys(ISSUE_REGISTRY).sort((a, b) => parseInt(a) - parseInt(b))
  const index = issues.findIndex(i => parseInt(i) === issueNumber)
  return index >= 0 ? index : 0
}

function getClientPort(issueNumber) {
  return BASE_CLIENT_PORT + getPortOffset(issueNumber)
}

function getServerPort(issueNumber) {
  return BASE_SERVER_PORT + getPortOffset(issueNumber)
}

function generateEnvFile(issueNumber, worktreePath) {
  const clientPort = getClientPort(issueNumber)
  const serverPort = getServerPort(issueNumber)

  return `# Auto-generated environment for issue #${issueNumber}
# Isolated dev environment

# Ports for this worktree
VITE_CLIENT_PORT=${clientPort}
GAME_SERVER_PORT=${serverPort}

# Game config
NODE_ENV=development
LOG_LEVEL=debug

# Nostr (generate new ephemeral key per worktree)
NOSTR_NSEC=

# Colyseus monitor
MONITOR_USER=
MONITOR_PASS=

# Workdir identifier
WORKTREE_ID=issue-${issueNumber}
WORKTREE_PATH=${worktreePath}
`
}

function create(issueNumber) {
  const issue = ISSUE_REGISTRY[issueNumber]
  if (!issue) {
    console.error(`❌ Issue #${issueNumber} not found in registry`)
    process.exit(1)
  }

  const branchName = generateBranchName(issueNumber)
  const worktreePath = getWorktreePath(issueNumber)
  const clientPort = getClientPort(issueNumber)
  const serverPort = getServerPort(issueNumber)

  console.log(`\n📁 Creating worktree for issue #${issueNumber}...`)
  console.log(`   Title: ${issue.title}`)
  console.log(`   Branch: ${branchName}`)
  console.log(`   Path: ${worktreePath}`)
  console.log(`   Ports: Client ${clientPort}, Server ${serverPort}`)

  // Create worktree directory if not exists
  if (!fs.existsSync(WORKTREES_DIR)) {
    fs.mkdirSync(WORKTREES_DIR, { recursive: true })
  }

  // Create git worktree
  try {
    const cmd = `git worktree add -b ${branchName} ${worktreePath}`
    console.log(`\n   Running: ${cmd}`)
    execSync(cmd, { stdio: 'inherit' })
  } catch (e) {
    console.error(`\n❌ Failed to create worktree: ${e.message}`)
    process.exit(1)
  }

  // Create .env file in worktree
  const envPath = path.join(worktreePath, '.env.local')
  const envContent = generateEnvFile(issueNumber, worktreePath)
  fs.writeFileSync(envPath, envContent)
  console.log(`\n✓ Created .env.local in worktree`)
  console.log(`  Client port: ${clientPort}`)
  console.log(`  Server port: ${serverPort}`)

  // Update registry
  const registry = loadRegistry()
  registry.worktrees.push({
    issueNumber,
    branchName,
    worktreePath,
    clientPort,
    serverPort,
    status: 'created',
    createdAt: new Date().toISOString(),
    processes: {
      client: null,
      server: null,
    },
  })
  saveRegistry(registry)

  console.log(`\n✓ Worktree created successfully`)
  console.log(`\n📋 Next steps:`)
  console.log(`   1. cd ${worktreePath}`)
  console.log(`   2. pnpm install (if needed)`)
  console.log(`   3. node ../scripts/worktree-manager.mjs start ${issueNumber}`)
}

function list() {
  const registry = loadRegistry()
  console.log('\n📋 Local Worktrees:\n')

  if (!registry.worktrees.length) {
    console.log('  (none created yet)\n')
    return
  }

  registry.worktrees.forEach(wt => {
    const statusEmoji = wt.status === 'running' ? '🟢' : wt.status === 'created' ? '⚪' : '⚫'
    const issue = ISSUE_REGISTRY[wt.issueNumber]

    console.log(`  ${statusEmoji} Issue #${wt.issueNumber}: ${issue.title}`)
    console.log(`     Branch: ${wt.branchName}`)
    console.log(`     Path: ${wt.worktreePath}`)
    console.log(`     Ports: client ${wt.clientPort}, server ${wt.serverPort}`)

    if (wt.status === 'running') {
      console.log(`     Client PID: ${wt.processes.client || 'N/A'}`)
      console.log(`     Server PID: ${wt.processes.server || 'N/A'}`)
      console.log(`     URLs:`)
      console.log(`       • Client: http://localhost:${wt.clientPort}`)
      console.log(`       • Server: http://localhost:${wt.serverPort}`)
      console.log(`       • Monitor: http://localhost:${wt.serverPort}/colyseus`)
    }

    console.log()
  })
}

function start(issueNumber) {
  const registry = loadRegistry()
  const wt = registry.worktrees.find(w => w.issueNumber === issueNumber)

  if (!wt) {
    console.error(`❌ Worktree for issue #${issueNumber} not found`)
    console.error(`   Create it first: node scripts/worktree-manager.mjs create ${issueNumber}`)
    process.exit(1)
  }

  if (wt.status === 'running') {
    console.log(`ℹ️  Worktree for issue #${issueNumber} is already running`)
    console.log(`   Client: http://localhost:${wt.clientPort}`)
    console.log(`   Server: http://localhost:${wt.serverPort}`)
    return
  }

  const worktreePath = wt.worktreePath

  console.log(`\n🚀 Starting worktree for issue #${issueNumber}...`)
  console.log(`   Path: ${worktreePath}`)
  console.log(`   Client port: ${wt.clientPort}`)
  console.log(`   Server port: ${wt.serverPort}`)

  // Check if worktree path exists
  if (!fs.existsSync(worktreePath)) {
    console.error(`❌ Worktree path not found: ${worktreePath}`)
    process.exit(1)
  }

  // Check if node_modules exists (install deps if needed)
  if (!fs.existsSync(path.join(worktreePath, 'node_modules'))) {
    console.log(`\n⏳ Dependencies not installed, running pnpm install...`)
    try {
      execSync('pnpm install', {
        cwd: worktreePath,
        stdio: 'inherit',
      })
    } catch (e) {
      console.error(`❌ pnpm install failed`)
      process.exit(1)
    }
  }

  // Start dev script (will start both client and server)
  console.log(`\n⏳ Starting dev servers...`)
  console.log(`   Run this in the worktree directory:`)
  console.log(`   cd ${worktreePath} && pnpm dev\n`)

  // Update registry
  wt.status = 'running'
  saveRegistry(registry)

  console.log(`📡 Dev servers starting in background (use 'pnpm dev' in the worktree)`)
  console.log(`\n🌐 Access your worktree:`)
  console.log(`   Client:  http://localhost:${wt.clientPort}`)
  console.log(`   Server:  http://localhost:${wt.serverPort}`)
  console.log(`   Monitor: http://localhost:${wt.serverPort}/colyseus`)
  console.log(`\n📂 Worktree directory: ${worktreePath}`)
}

function stop(issueNumber) {
  const registry = loadRegistry()
  const wt = registry.worktrees.find(w => w.issueNumber === issueNumber)

  if (!wt) {
    console.error(`❌ Worktree for issue #${issueNumber} not found`)
    process.exit(1)
  }

  console.log(`\n⏹️  Stopping worktree for issue #${issueNumber}...`)

  // Try to kill processes
  if (wt.processes.client) {
    try {
      process.kill(wt.processes.client)
      console.log(`✓ Killed client process (PID ${wt.processes.client})`)
    } catch (e) {
      console.log(`ℹ️  Could not kill client process`)
    }
  }

  if (wt.processes.server) {
    try {
      process.kill(wt.processes.server)
      console.log(`✓ Killed server process (PID ${wt.processes.server})`)
    } catch (e) {
      console.log(`ℹ️  Could not kill server process`)
    }
  }

  wt.status = 'created'
  wt.processes = { client: null, server: null }
  saveRegistry(registry)

  console.log(`✓ Worktree stopped`)
}

function shells() {
  const registry = loadRegistry()
  const runningWorktrees = registry.worktrees.filter(w => w.status === 'running' || w.status === 'created')

  if (!runningWorktrees.length) {
    console.log('\n⚠️  No worktrees to open\n')
    return
  }

  console.log('\n🖥️  Opening shells for all worktrees...\n')

  runningWorktrees.forEach(wt => {
    const cmd = `open -a Terminal "${wt.worktreePath}"`
    console.log(`   Opening: ${wt.worktreePath}`)
    try {
      execSync(cmd)
    } catch (e) {
      // Fallback for non-macOS
      console.log(`   (on Linux/Windows, open manually: cd ${wt.worktreePath})`)
    }
  })

  console.log(`\n💡 In each shell, run: pnpm dev\n`)
}

function cleanup(issueNumber) {
  const registry = loadRegistry()
  const wtIndex = registry.worktrees.findIndex(w => w.issueNumber === issueNumber)

  if (wtIndex === -1) {
    console.error(`❌ Worktree for issue #${issueNumber} not found`)
    process.exit(1)
  }

  const wt = registry.worktrees[wtIndex]

  console.log(`\n🗑️  Cleaning up worktree for issue #${issueNumber}...`)

  // Stop processes if running
  if (wt.status === 'running') {
    try {
      execSync(`git worktree remove --force ${wt.worktreePath}`)
      console.log(`✓ Removed git worktree`)
    } catch (e) {
      console.error(`❌ Failed to remove worktree: ${e.message}`)
      process.exit(1)
    }
  } else {
    try {
      execSync(`git worktree remove ${wt.worktreePath}`)
      console.log(`✓ Removed git worktree`)
    } catch (e) {
      console.error(`❌ Failed to remove worktree: ${e.message}`)
      process.exit(1)
    }
  }

  // Remove from registry
  registry.worktrees.splice(wtIndex, 1)
  saveRegistry(registry)

  console.log(`✓ Cleaned up worktree for issue #${issueNumber}`)
}

// CLI
const command = process.argv[2]
const arg = process.argv[3]

async function main() {
  try {
    if (!command) {
      console.log(`
🖇️  Local Worktree Manager — Isolated dev environments per issue

Usage:
  node scripts/worktree-manager.mjs create <issue>      Create worktree
  node scripts/worktree-manager.mjs list                List all worktrees
  node scripts/worktree-manager.mjs start <issue>       Mark as running
  node scripts/worktree-manager.mjs stop <issue>        Mark as stopped
  node scripts/worktree-manager.mjs shells              Open shells for all
  node scripts/worktree-manager.mjs cleanup <issue>     Delete worktree

Examples:
  node scripts/worktree-manager.mjs create 77
  node scripts/worktree-manager.mjs list
  node scripts/worktree-manager.mjs start 77
  node scripts/worktree-manager.mjs shells

Available issues:
`)
      Object.entries(ISSUE_REGISTRY).forEach(([num, issue]) => {
        console.log(`  #${num}: ${issue.title}`)
      })
      console.log()
      process.exit(0)
    }

    switch (command) {
      case 'create':
        if (!arg) {
          console.error('❌ Missing issue number')
          process.exit(1)
        }
        create(parseInt(arg))
        break

      case 'list':
        list()
        break

      case 'start':
        if (!arg) {
          console.error('❌ Missing issue number')
          process.exit(1)
        }
        start(parseInt(arg))
        break

      case 'stop':
        if (!arg) {
          console.error('❌ Missing issue number')
          process.exit(1)
        }
        stop(parseInt(arg))
        break

      case 'shells':
        shells()
        break

      case 'cleanup':
        if (!arg) {
          console.error('❌ Missing issue number')
          process.exit(1)
        }
        cleanup(parseInt(arg))
        break

      default:
        console.error(`❌ Unknown command: ${command}`)
        process.exit(1)
    }
  } catch (err) {
    console.error('Error:', err.message)
    process.exit(1)
  }
}

main()
