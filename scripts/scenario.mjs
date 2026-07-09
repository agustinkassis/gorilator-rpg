import { spawn } from "node:child_process";
import { existsSync, readFileSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const args = process.argv.slice(2);
const name = (args.find((arg) => !arg.startsWith("-")) || "").trim();

if (!name) {
  console.error("usage: pnpm scenario <name> [--skip-shared]");
  process.exit(1);
}

const safe = name
  .toLowerCase()
  .replace(/[^a-z0-9_-]+/g, "-")
  .replace(/^-+|-+$/g, "");

if (!safe) {
  console.error(`invalid scenario name: ${name}`);
  process.exit(1);
}

const stateFile = join(tmpdir(), `gorilator-scenario-${safe}-${process.pid}.json`);
try {
  if (existsSync(stateFile)) unlinkSync(stateFile);
} catch {
  /* best effort */
}

const child = spawn(process.execPath, [join(root, "scripts/dev.mjs"), ...args.filter((arg) => arg.startsWith("-"))], {
  cwd: root,
  env: {
    ...process.env,
    GORILATOR_TEST: "1",
    GORILATOR_SCENARIO: safe,
    GORILATOR_STATE_FILE: stateFile,
  },
  stdio: "inherit",
});

let printed = false;
const poll = setInterval(() => {
  if (printed || !existsSync(stateFile)) return;
  try {
    const state = JSON.parse(readFileSync(stateFile, "utf8"));
    if (!state?.clientPort) return;
    printed = true;
    const url = `http://localhost:${state.clientPort}/?scenario=${encodeURIComponent(safe)}&autojoin=HungerBot`;
    console.log(`[scenario] ${safe}: ${url}`);
  } catch {
    /* wait for a complete write */
  }
}, 250);

child.on("exit", (code, signal) => {
  clearInterval(poll);
  try {
    if (existsSync(stateFile)) unlinkSync(stateFile);
  } catch {
    /* best effort */
  }
  if (signal) process.kill(process.pid, signal);
  else process.exit(code ?? 0);
});
