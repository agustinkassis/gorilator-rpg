import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

const testDir = dirname(fileURLToPath(import.meta.url));
const cliRoot = join(testDir, "..");

test("remote compares local package versions against the git remote", () => {
  const fixture = makeRemoteFixture();
  try {
    const output = execFileSync(
      process.execPath,
      [join(cliRoot, "dist", "index.js"), "remote", "--no-npm"],
      {
        cwd: fixture.local,
        encoding: "utf8",
      },
    );

    assert.match(output, /Gorilator Remote/);
    assert.match(output, /Git Comparison/);
    assert.match(output, /Package Comparison/);
    assert.match(output, / {2}app\s+: local v1\.0\.0 \/ remote v1\.1\.0\s+behind/);
    assert.match(output, / {2}cli\s+: local v1\.0\.0 \/ remote v1\.2\.0\s+behind/);
    assert.match(output, / {2}server\s+: local v1\.0\.0 \/ remote v1\.0\.0\s+current/);
    assert.doesNotMatch(output, /Published CLI/);
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

function makeRemoteFixture() {
  const root = join(tmpdir(), `gorilator-remote-test-${process.pid}-${Date.now()}-${Math.random()}`);
  const source = join(root, "source");
  const remote = join(root, "remote.git");
  const local = join(root, "local");

  mkdirSync(source, { recursive: true });
  writeProject(source, {
    app: "1.0.0",
    cli: "1.0.0",
    client: "1.0.0",
    server: "1.0.0",
    shared: "1.0.0",
    landing: "1.0.0",
  });
  git(source, ["init"]);
  git(source, ["checkout", "-b", "main"]);
  git(source, ["config", "user.email", "test@example.com"]);
  git(source, ["config", "user.name", "Gorilator Test"]);
  git(source, ["add", "."]);
  git(source, ["commit", "-m", "initial"]);
  execFileSync("git", ["clone", "--bare", source, remote], { stdio: "ignore" });
  execFileSync("git", ["clone", remote, local], { stdio: "ignore" });

  git(source, ["remote", "add", "origin", remote]);
  writeProject(source, {
    app: "1.1.0",
    cli: "1.2.0",
    client: "1.0.0",
    server: "1.0.0",
    shared: "1.0.0",
    landing: "1.0.0",
  });
  git(source, ["add", "."]);
  git(source, ["commit", "-m", "remote versions"]);
  git(source, ["push", "origin", "main"]);

  return { root, local };
}

function writeProject(root, versions) {
  mkdirSync(join(root, "scripts"), { recursive: true });
  mkdirSync(join(root, "packages", "cli"), { recursive: true });
  mkdirSync(join(root, "packages", "client"), { recursive: true });
  mkdirSync(join(root, "packages", "server"), { recursive: true });
  mkdirSync(join(root, "packages", "shared"), { recursive: true });
  mkdirSync(join(root, "packages", "landing"), { recursive: true });
  writeFileSync(join(root, "pnpm-workspace.yaml"), 'packages:\n  - "packages/*"\n');
  writeFileSync(
    join(root, "package.json"),
    JSON.stringify({
      name: "rpg-online",
      version: versions.app,
      scripts: { dev: "node scripts/dev.mjs" },
    }) + "\n",
  );
  writeFileSync(
    join(root, "packages", "cli", "package.json"),
    JSON.stringify({ name: "gorilator", version: versions.cli }) + "\n",
  );
  writeFileSync(
    join(root, "packages", "client", "package.json"),
    JSON.stringify({ name: "@rpg/client", version: versions.client }) + "\n",
  );
  writeFileSync(
    join(root, "packages", "server", "package.json"),
    JSON.stringify({ name: "@rpg/server", version: versions.server }) + "\n",
  );
  writeFileSync(
    join(root, "packages", "shared", "package.json"),
    JSON.stringify({ name: "@rpg/shared", version: versions.shared }) + "\n",
  );
  writeFileSync(
    join(root, "packages", "landing", "package.json"),
    JSON.stringify({ name: "@gorilator/landing", version: versions.landing }) + "\n",
  );
}

function git(cwd, args) {
  execFileSync("git", args, { cwd, stdio: "ignore" });
}
