import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const [scenario, ...args] = process.argv.slice(2);

if (!scenario || !/^[a-z0-9_-]+$/i.test(scenario)) {
  console.error("Usage: pnpm scenario <name> [-- dev args]");
  process.exit(1);
}

const file = join(root, "scenarios", `${scenario}.json`);
if (!existsSync(file)) {
  console.error(`[scenario] scenarios/${scenario}.json does not exist`);
  process.exit(1);
}

const child = spawn("pnpm", ["dev", ...args], {
  cwd: root,
  env: { ...process.env, GORILATOR_SCENARIO: scenario },
  stdio: "inherit",
});

child.on("exit", (code, signal) => {
  if (signal) process.kill(process.pid, signal);
  process.exit(code ?? 0);
});
