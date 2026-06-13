#!/usr/bin/env node
// One-command parallel-worktree DX:
//
//   pnpm wt <name>        create .claude/worktrees/<name> on branch claude/<name>,
//                         assign deterministic ports, install deps — ready to `pnpm dev`
//   pnpm wt rm <name>     remove the worktree (keeps the branch)
//   pnpm wt list          list active worktrees with their ports
//
// Ports come from scripts/wt-launch.mjs (SHA1(path) → 10-port block), so two
// worktrees never collide and parallel agents can each run their own stack.
// A manifest of active worktrees + ports is kept at .claude/worktrees-manifest.json
// in the MAIN tree so agents can discover their peers.

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { gitWorktrees, portsFor, write } from "./wt-launch.mjs";

function sh(cmd, args, opts = {}) {
  return execFileSync(cmd, args, { encoding: "utf8", stdio: "pipe", ...opts }).trim();
}

function mainRoot() {
  // The first worktree in `git worktree list` is the main tree.
  return gitWorktrees()[0];
}

function writeManifest(root) {
  const entries = gitWorktrees().map((dir) => ({
    dir,
    branch: (() => {
      try {
        return sh("git", ["rev-parse", "--abbrev-ref", "HEAD"], { cwd: dir });
      } catch {
        return null;
      }
    })(),
    ports: portsFor(dir),
  }));
  const claudeDir = join(root, ".claude");
  if (!existsSync(claudeDir)) mkdirSync(claudeDir, { recursive: true });
  const file = join(claudeDir, "worktrees-manifest.json");
  writeFileSync(file, `${JSON.stringify({ updatedAt: new Date().toISOString(), worktrees: entries }, null, 2)}\n`);
  return file;
}

function usage() {
  console.log("usage: pnpm wt <name> | pnpm wt rm <name> | pnpm wt list");
  process.exit(1);
}

const args = process.argv.slice(2);
if (!args.length) usage();

const root = mainRoot();

if (args[0] === "list") {
  for (const dir of gitWorktrees()) {
    const p = portsFor(dir);
    console.log(`${dir}\n    game/client :${p.client}   server :${p.server}`);
  }
  process.exit(0);
}

if (args[0] === "rm") {
  const name = args[1];
  if (!name) usage();
  const dir = join(root, ".claude", "worktrees", name);
  if (!existsSync(dir)) {
    console.error(`no worktree at ${dir}`);
    process.exit(1);
  }
  sh("git", ["worktree", "remove", "--force", dir], { cwd: root });
  rmSync(dir, { recursive: true, force: true });
  writeManifest(root);
  console.log(`✓ removed worktree ${name} (branch claude/${name} kept; delete with: git branch -D claude/${name})`);
  process.exit(0);
}

const name = args[0];
if (!/^[a-z0-9][a-z0-9-_]*$/i.test(name)) {
  console.error(`invalid worktree name "${name}" (use letters, digits, - or _)`);
  process.exit(1);
}

const dir = join(root, ".claude", "worktrees", name);
const branch = `claude/${name}`;
if (existsSync(dir)) {
  console.error(`worktree already exists at ${dir}`);
  process.exit(1);
}

// Create the worktree on a new branch (or reuse the branch if it exists).
const branchExists = (() => {
  try {
    sh("git", ["rev-parse", "--verify", branch], { cwd: root });
    return true;
  } catch {
    return false;
  }
})();
console.log(`[wt] creating worktree ${dir} on branch ${branch}${branchExists ? " (existing)" : ""}`);
sh(
  "git",
  branchExists ? ["worktree", "add", dir, branch] : ["worktree", "add", "-b", branch, dir],
  { cwd: root },
);

// Deterministic per-worktree ports → .claude/launch.json inside the new tree.
const ports = write(resolve(dir));

// Install dependencies so the tree is immediately runnable.
console.log("[wt] installing dependencies (pnpm install --frozen-lockfile)");
execFileSync("pnpm", ["install", "--frozen-lockfile"], { cwd: dir, stdio: "inherit" });

const manifest = writeManifest(root);

console.log(`\n✓ worktree ready: ${dir}`);
console.log(`    branch  ${branch}`);
console.log(`    game/client :${ports.client}   server :${ports.server}`);
console.log(`    manifest ${manifest}`);
console.log(`\n  cd ${dir} && pnpm dev`);
