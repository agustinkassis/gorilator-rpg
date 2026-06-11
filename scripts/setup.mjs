#!/usr/bin/env node
// One-command clone-to-running setup:  pnpm bootstrap   (then: pnpm dev)
//
// 1. verifies Node >= 20 (matches package.json engines)
// 2. pnpm install --frozen-lockfile
// 3. copies .env.example -> .env when .env is missing
// 4. writes this worktree's deterministic dev ports (.claude/launch.json)
// 5. warms the @rpg/shared build (+ Turbo cache) so the first `pnpm dev` is instant

import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { write } from "./wt-launch.mjs";

const root = dirname(dirname(fileURLToPath(import.meta.url)));

const major = Number(process.versions.node.split(".")[0]);
if (major < 20) {
  console.error(`[setup] Node ${process.versions.node} found — this repo needs Node >= 20`);
  process.exit(1);
}

function run(cmd, args) {
  const res = spawnSync(cmd, args, { cwd: root, stdio: "inherit" });
  if (res.status !== 0) process.exit(res.status ?? 1);
}

console.log("[setup] installing dependencies");
run("pnpm", ["install", "--frozen-lockfile"]);

const envFile = join(root, ".env");
if (!existsSync(envFile) && existsSync(join(root, ".env.example"))) {
  copyFileSync(join(root, ".env.example"), envFile);
  console.log("[setup] created .env from .env.example (edit it for Nostr/admin settings)");
}

console.log("[setup] assigning per-worktree dev ports");
const ports = write(root);

console.log("[setup] warming the @rpg/shared build cache");
run("pnpm", ["exec", "turbo", "run", "build", "--filter=@rpg/shared"]);

console.log("\n✓ setup complete");
console.log(`    landing :${ports.landing}   game/client :${ports.client}   server :${ports.server}`);
console.log("\n  pnpm dev        # game (client + server + shared watcher)");
console.log("  pnpm landing    # marketing site + live dashboard");
