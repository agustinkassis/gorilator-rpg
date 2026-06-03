import assert from "node:assert/strict";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  findGorilatorProjectRoot,
  isCanonicalGorilatorRemote,
  normalizeRepoUrl,
} from "../dist/lib/context.js";

test("normalizes canonical Gorilator remote URLs", () => {
  assert.equal(
    normalizeRepoUrl("https://github.com/agustinkassis/gorilator-rpg.git"),
    "github.com/agustinkassis/gorilator-rpg",
  );
  assert.equal(
    normalizeRepoUrl("git@github.com:agustinkassis/gorilator-rpg.git"),
    "github.com/agustinkassis/gorilator-rpg",
  );
  assert.equal(
    normalizeRepoUrl("ssh://git@github.com/agustinkassis/gorilator-rpg.git"),
    "github.com/agustinkassis/gorilator-rpg",
  );
  assert.equal(isCanonicalGorilatorRemote("git+https://github.com/agustinkassis/gorilator-rpg.git"), true);
  assert.equal(isCanonicalGorilatorRemote("https://github.com/example/gorilator-rpg.git"), false);
});

test("detects offline fork fixtures by repo markers", () => {
  const root = makeTempProject();
  try {
    const nested = join(root, "packages", "client", "src");
    mkdirSync(nested, { recursive: true });
    assert.equal(findGorilatorProjectRoot(nested), root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

function makeTempProject() {
  const root = mkdtemp();
  mkdirSync(join(root, "scripts"), { recursive: true });
  mkdirSync(join(root, "packages", "cli"), { recursive: true });
  mkdirSync(join(root, "packages", "client"), { recursive: true });
  mkdirSync(join(root, "packages", "server"), { recursive: true });
  writeFileSync(join(root, "pnpm-workspace.yaml"), 'packages:\n  - "packages/*"\n');
  writeFileSync(join(root, "package.json"), '{"scripts":{"dev":"node scripts/dev.mjs"}}\n');
  writeFileSync(join(root, "packages", "cli", "package.json"), '{"name":"gorilator"}\n');
  writeFileSync(join(root, "packages", "client", "package.json"), '{"name":"@rpg/client"}\n');
  writeFileSync(join(root, "packages", "server", "package.json"), '{"name":"@rpg/server"}\n');
  return root;
}

function mkdtemp() {
  const root = join(tmpdir(), `gorilator-cli-test-${process.pid}-${Date.now()}-${Math.random()}`);
  mkdirSync(root, { recursive: true });
  return root;
}
