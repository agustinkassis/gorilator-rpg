import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

const testDir = dirname(fileURLToPath(import.meta.url));
const cliRoot = join(testDir, "..");
const cliPackage = JSON.parse(readFileSync(join(cliRoot, "package.json"), "utf8"));

test("prints the CLI package version", () => {
  const output = execFileSync(process.execPath, [join(cliRoot, "dist", "index.js"), "--version"], {
    encoding: "utf8",
  });

  assert.equal(output.trim(), `gorilator ${cliPackage.version}`);
});
