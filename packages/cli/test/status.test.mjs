import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

const testDir = dirname(fileURLToPath(import.meta.url));
const cliRoot = join(testDir, "..");

test("project status prints package versions", () => {
  const root = makeTempProject();
  try {
    const output = execFileSync(process.execPath, [join(cliRoot, "dist", "index.js"), "status"], {
      cwd: root,
      encoding: "utf8",
    });

    assert.match(output, /Gorilator Status/);
    assert.match(output, /Package Versions/);
    assert.match(output, / {2}app\s+: v1\.0\.0/);
    assert.match(output, / {2}cli\s+: v9\.8\.7/);
    assert.match(output, / {2}server\s+: v3\.2\.1/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

function makeTempProject() {
  const root = join(tmpdir(), `gorilator-status-test-${process.pid}-${Date.now()}-${Math.random()}`);
  mkdirSync(join(root, "scripts"), { recursive: true });
  mkdirSync(join(root, "packages", "cli"), { recursive: true });
  mkdirSync(join(root, "packages", "client"), { recursive: true });
  mkdirSync(join(root, "packages", "server"), { recursive: true });
  mkdirSync(join(root, "packages", "shared"), { recursive: true });
  writeFileSync(join(root, "pnpm-workspace.yaml"), 'packages:\n  - "packages/*"\n');
  writeFileSync(
    join(root, "package.json"),
    '{"name":"rpg-online","version":"1.0.0","scripts":{"dev":"node scripts/dev.mjs"}}\n',
  );
  writeFileSync(
    join(root, "packages", "cli", "package.json"),
    '{"name":"gorilator","version":"9.8.7"}\n',
  );
  writeFileSync(
    join(root, "packages", "client", "package.json"),
    '{"name":"@rpg/client","version":"2.0.0"}\n',
  );
  writeFileSync(
    join(root, "packages", "server", "package.json"),
    '{"name":"@rpg/server","version":"3.2.1"}\n',
  );
  writeFileSync(
    join(root, "packages", "shared", "package.json"),
    '{"name":"@rpg/shared","version":"4.0.0"}\n',
  );
  return root;
}
