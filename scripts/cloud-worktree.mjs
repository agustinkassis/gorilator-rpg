#!/usr/bin/env node
/**
 * Cloud Worktree Manager
 *
 * Spawn cloud servers (Railway/Docker) per branch while running client locally.
 * Enables testing against multiple cloud servers without local resource constraints.
 *
 * Usage:
 *   node scripts/cloud-worktree.mjs spawn [issue-number] [cloud-provider]
 *   node scripts/cloud-worktree.mjs list
 *   node scripts/cloud-worktree.mjs connect [server-id]
 *   node scripts/cloud-worktree.mjs teardown [server-id]
 *   node scripts/cloud-worktree.mjs dev [server-id]  # Run local client against cloud server
 *
 * Examples:
 *   node scripts/cloud-worktree.mjs spawn 77 railway
 *   node scripts/cloud-worktree.mjs spawn 80 docker
 *   node scripts/cloud-worktree.mjs list
 *   node scripts/cloud-worktree.mjs dev server-77-railway
 *   node scripts/cloud-worktree.mjs teardown server-77-railway
 */

import fs from 'fs'
import path from 'path'
import { execSync } from 'child_process'

const CLOUD_REGISTRY_FILE = '.claude/cloud-worktrees.json'

// Ensure registry directory exists
const registryDir = path.dirname(CLOUD_REGISTRY_FILE)
if (!fs.existsSync(registryDir)) {
  fs.mkdirSync(registryDir, { recursive: true })
}

// Initialize or load registry
function loadRegistry() {
  if (fs.existsSync(CLOUD_REGISTRY_FILE)) {
    return JSON.parse(fs.readFileSync(CLOUD_REGISTRY_FILE, 'utf8'))
  }
  return { servers: [] }
}

function saveRegistry(registry) {
  fs.writeFileSync(CLOUD_REGISTRY_FILE, JSON.stringify(registry, null, 2))
}

function generateBranchName(issueNumber) {
  return `claude/issue-${issueNumber}-cloud-worktree`
}

function generateServerId(issueNumber, provider) {
  return `server-${issueNumber}-${provider}`
}

// Railway deployment template
function generateRailwayConfig(issueNumber, branchName) {
  return {
    name: `gorilator-issue-${issueNumber}`,
    services: [
      {
        name: 'server',
        dockerfilePath: 'Dockerfile.server',
        buildCommand: 'pnpm install && pnpm --filter @rpg/shared build && pnpm --filter @rpg/client build && pnpm --filter @rpg/server build',
        startCommand: 'GAME_SERVER_PORT=2567 node --import tsx packages/server/src/index.ts',
        environment: {
          GAME_SERVER_PORT: '2567',
          NODE_ENV: 'production',
          BRANCH: branchName,
        },
      },
    ],
  }
}

// Docker Compose template for cloud (without port binding, relies on networking)
function generateDockerComposeCloud(issueNumber, branchName) {
  return `version: '3.8'

services:
  game:
    build:
      context: .
      dockerfile: Dockerfile.server
    container_name: gorilator-issue-${issueNumber}
    environment:
      GAME_SERVER_PORT: 2567
      NODE_ENV: production
      BRANCH: ${branchName}
      NOSTR_NSEC: \${NOSTR_NSEC:-}
    restart: unless-stopped
    healthcheck:
      test: ["CMD", "node", "-e", "fetch('http://127.0.0.1:2567/healthz').then(r=>r.text()).then(t=>process.exit(t.trim()==='ok'?0:1)).catch(()=>process.exit(1))"]
      interval: 30s
      timeout: 5s
      retries: 3
      start_period: 20s
    networks:
      - gorilator

networks:
  gorilator:
    driver: bridge
`
}

// Local client dev config
function generateClientDevConfig(serverUrl) {
  return `/**
 * Auto-generated cloud worktree config
 * Points local client to cloud server
 * Generated: ${new Date().toISOString()}
 */

// Override NetworkClient to use cloud server
window.__GAME_SERVER_URL__ = "${serverUrl}"
window.__CLOUD_WORKTREE_MODE__ = true

console.log('🌩️  Cloud worktree mode enabled')
console.log('📡 Server URL:', window.__GAME_SERVER_URL__)
`
}

// Commands
async function spawn(issueNumber, provider = 'railway') {
  console.log(`\n🚀 Spawning cloud server for issue #${issueNumber} on ${provider}...`)

  const branchName = generateBranchName(issueNumber)
  const serverId = generateServerId(issueNumber, provider)

  // Create local branch
  try {
    execSync(`git checkout -b ${branchName}`, { stdio: 'inherit' })
  } catch (e) {
    console.log(`ℹ️  Branch ${branchName} already exists`)
  }

  const registry = loadRegistry()

  if (provider === 'railway') {
    console.log(`
✓ To deploy to Railway:
  1. Push this branch: git push origin ${branchName}
  2. Railway dashboard → New Project → Deploy from repo
  3. Select this repo and branch ${branchName}
  4. Railway reads railway.json and deploys automatically
  5. Get public URL from Railway → run: node scripts/cloud-worktree.mjs connect ${serverId}
    `)

    const railwayConfig = generateRailwayConfig(issueNumber, branchName)
    fs.writeFileSync('railway-issue.json', JSON.stringify(railwayConfig, null, 2))
    console.log(`✓ Created railway-issue.json`)
  } else if (provider === 'docker') {
    const dockerCompose = generateDockerComposeCloud(issueNumber, branchName)
    const composeFile = `.docker/docker-compose.issue-${issueNumber}.yml`
    const composeDir = path.dirname(composeFile)
    if (!fs.existsSync(composeDir)) {
      fs.mkdirSync(composeDir, { recursive: true })
    }
    fs.writeFileSync(composeFile, dockerCompose)
    console.log(`✓ Created ${composeFile}`)
    console.log(`
To start the Docker container:
  docker compose -f ${composeFile} up -d

To stop:
  docker compose -f ${composeFile} down
    `)
  }

  // Save to registry
  registry.servers.push({
    serverId,
    issueNumber,
    provider,
    branchName,
    status: 'pending',
    createdAt: new Date().toISOString(),
    serverUrl: null,
  })
  saveRegistry(registry)

  console.log(`\n✓ Registered cloud worktree: ${serverId}`)
  console.log(`  Branch: ${branchName}`)
  console.log(`  Status: pending (waiting for deployment)`)
}

function list() {
  const registry = loadRegistry()
  console.log('\n📋 Cloud Worktrees:\n')

  if (!registry.servers.length) {
    console.log('  (none)')
    return
  }

  registry.servers.forEach(server => {
    const status =
      server.status === 'running' ? '✅' : server.status === 'pending' ? '⏳' : '❌'
    console.log(`  ${status} ${server.serverId}`)
    console.log(`     Issue: #${server.issueNumber}`)
    console.log(`     Provider: ${server.provider}`)
    console.log(`     Branch: ${server.branchName}`)
    if (server.serverUrl) {
      console.log(`     URL: ${server.serverUrl}`)
    }
    console.log()
  })
}

function connect(serverId, serverUrl) {
  const registry = loadRegistry()
  const server = registry.servers.find(s => s.serverId === serverId)

  if (!server) {
    console.error(`❌ Server not found: ${serverId}`)
    process.exit(1)
  }

  server.serverUrl = serverUrl
  server.status = 'running'
  saveRegistry(registry)

  console.log(`\n✓ Connected to cloud server: ${serverUrl}`)
  console.log(`  Use: node scripts/cloud-worktree.mjs dev ${serverId}`)
}

async function dev(serverId) {
  const registry = loadRegistry()
  const server = registry.servers.find(s => s.serverId === serverId)

  if (!server) {
    console.error(`❌ Server not found: ${serverId}`)
    process.exit(1)
  }

  if (!server.serverUrl) {
    console.error(`❌ Server URL not set. Run: node scripts/cloud-worktree.mjs connect ${serverId} <url>`)
    process.exit(1)
  }

  console.log(`
🎮 Starting local client dev server
📡 Server: ${server.serverUrl}
`)

  // Generate client config to connect to cloud server
  const clientConfig = generateClientDevConfig(server.serverUrl)
  const configFile = 'packages/client/src/cloud-worktree-config.ts'
  fs.writeFileSync(configFile, clientConfig)

  // Start dev server for client only
  console.log(`✓ Generated cloud config at ${configFile}`)
  console.log(`\nStarting dev server (client only, server running in cloud)...\n`)

  try {
    execSync('pnpm --filter @rpg/client dev', { stdio: 'inherit' })
  } catch (e) {
    // User interrupted or dev server error
  }
}

async function teardown(serverId) {
  const registry = loadRegistry()
  const index = registry.servers.findIndex(s => s.serverId === serverId)

  if (index === -1) {
    console.error(`❌ Server not found: ${serverId}`)
    process.exit(1)
  }

  const server = registry.servers[index]

  console.log(`\n🗑️  Tearing down cloud server: ${serverId}`)
  console.log(`   Issue: #${server.issueNumber}`)
  console.log(`   Provider: ${server.provider}`)

  if (server.provider === 'railway') {
    console.log(`
ℹ️  To delete from Railway:
  1. Railway dashboard → select service → Settings → Danger Zone → Delete

  Or via Railway CLI:
  railway down
    `)
  } else if (server.provider === 'docker') {
    const composeFile = `.docker/docker-compose.issue-${server.issueNumber}.yml`
    try {
      execSync(`docker compose -f ${composeFile} down`, { stdio: 'inherit' })
      console.log(`✓ Stopped Docker container`)
    } catch (e) {
      console.log(`⚠️  Could not stop container: ${e.message}`)
    }
  }

  // Remove from registry
  registry.servers.splice(index, 1)
  saveRegistry(registry)

  console.log(`✓ Removed from registry`)
}

// CLI
const command = process.argv[2]
const arg1 = process.argv[3]
const arg2 = process.argv[4]

async function main() {
  try {
    if (!command) {
      console.log(`
Cloud Worktree Manager — spawn cloud servers, run client locally

Usage:
  node scripts/cloud-worktree.mjs spawn <issue> [provider]    Spawn cloud server
  node scripts/cloud-worktree.mjs list                         List all servers
  node scripts/cloud-worktree.mjs connect <id> <url>           Register server URL
  node scripts/cloud-worktree.mjs dev <id>                     Run local client
  node scripts/cloud-worktree.mjs teardown <id>                Destroy cloud server

Providers: railway (default), docker

Examples:
  node scripts/cloud-worktree.mjs spawn 77 railway
  node scripts/cloud-worktree.mjs spawn 80 docker
  node scripts/cloud-worktree.mjs list
  node scripts/cloud-worktree.mjs connect server-77-railway https://myserver.up.railway.app
  node scripts/cloud-worktree.mjs dev server-77-railway
      `)
      process.exit(0)
    }

    switch (command) {
      case 'spawn':
        if (!arg1) {
          console.error('❌ Missing issue number')
          process.exit(1)
        }
        await spawn(parseInt(arg1), arg2 || 'railway')
        break

      case 'list':
        list()
        break

      case 'connect':
        if (!arg1 || !arg2) {
          console.error('❌ Missing server ID or URL')
          process.exit(1)
        }
        connect(arg1, arg2)
        break

      case 'dev':
        if (!arg1) {
          console.error('❌ Missing server ID')
          process.exit(1)
        }
        await dev(arg1)
        break

      case 'teardown':
        if (!arg1) {
          console.error('❌ Missing server ID')
          process.exit(1)
        }
        await teardown(arg1)
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
