#!/usr/bin/env node
// Generate a per-worktree .claude/launch.json with deterministic, collision-free
// ports derived from the worktree's path. Run once per worktree (or any time):
//
//   node scripts/wt-launch.mjs            # configure the current worktree
//   node scripts/wt-launch.mjs <dir> ...  # configure specific worktree dirs
//   node scripts/wt-launch.mjs --all      # configure every git worktree
//
// launch.json is per-worktree state (each worktree has its own .claude/), so
// each worktree gets its own ports with no git noise. Two worktrees never share
// ports because the port block is hashed from the absolute worktree path.
//
// portsFor/configFor/write are exported for scripts/wt.mjs (one-command
// worktree creation) and scripts/setup.mjs.

import { createHash } from "node:crypto";
import { execSync } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

// 300 ten-port blocks: 4100..7090. landing=base, client=base+1, server=base+2.
const PORT_FLOOR = 4100;
const BLOCKS = 300;
const BLOCK_SIZE = 10;

// Default dev admin (public key — safe to commit). Every generated launch.json
// starts the game server with this in ADMIN_NPUBS so the Esc-menu Admin controls
// and /api/admin/* work out of the box in any worktree. Local dev only — deployed
// servers get ADMIN_NPUBS from their install .env (gorilator setup).
const DEV_ADMIN_NPUBS = "npub19tv378w29hx4ljy7wgydreg9nu96czrs6clu8wkzr3af8z86rr7sujx4xe";

export function portsFor(dir) {
  const h = parseInt(createHash("sha1").update(dir).digest("hex").slice(0, 8), 16);
  const base = PORT_FLOOR + (h % BLOCKS) * BLOCK_SIZE;
  return { landing: base, client: base + 1, server: base + 2 };
}

export function configFor(dir) {
  const { landing, client, server } = portsFor(dir);
  return {
    dir,
    ports: { landing, client, server },
    json: {
      version: "0.0.1",
      configurations: [
        {
          name: "landing",
          runtimeExecutable: "sh",
          runtimeArgs: [
            "-c",
            `pnpm --filter @gorilator/landing exec vite --host 0.0.0.0 --port ${landing} --strictPort`,
          ],
          port: landing,
        },
        {
          name: "game",
          runtimeExecutable: "sh",
          runtimeArgs: [
            "-c",
            `CLIENT_PORT=${client} GAME_SERVER_PORT=${server} ADMIN_NPUBS=\${ADMIN_NPUBS:-${DEV_ADMIN_NPUBS}} pnpm dev`,
          ],
          port: client,
        },
      ],
    },
  };
}

export function write(dir) {
  const { ports, json } = configFor(dir);
  const claudeDir = join(dir, ".claude");
  if (!existsSync(claudeDir)) mkdirSync(claudeDir, { recursive: true });
  writeFileSync(join(claudeDir, "launch.json"), JSON.stringify(json, null, 2) + "\n");
  console.log(
    `✓ ${dir}\n    landing :${ports.landing}   game/client :${ports.client}   server :${ports.server}`,
  );
  return ports;
}

export function gitWorktrees() {
  return execSync("git worktree list --porcelain", { encoding: "utf8" })
    .split("\n")
    .filter((l) => l.startsWith("worktree "))
    .map((l) => l.slice("worktree ".length).trim())
    .filter(Boolean);
}

const invokedDirectly =
  process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;

if (invokedDirectly) {
  const args = process.argv.slice(2);
  let targets;
  if (args.includes("--all")) targets = gitWorktrees();
  else if (args.length) targets = args;
  else targets = [execSync("git rev-parse --show-toplevel", { encoding: "utf8" }).trim()];

  for (const dir of targets) write(dir);
}
