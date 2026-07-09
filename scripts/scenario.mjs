import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const [name, ...rest] = process.argv.slice(2);

if (!name || !/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(name)) {
  console.error("Usage: pnpm scenario <name> [-- dev args]");
  process.exit(1);
}

const scenarioPath = join(root, "scenarios", `${name}.json`);
if (!existsSync(scenarioPath)) {
  console.error(`Scenario not found: scenarios/${name}.json`);
  process.exit(1);
}

const child = spawn(process.execPath, [join(root, "scripts/dev.mjs"), ...rest], {
  cwd: root,
  env: { ...process.env, GORILATOR_SCENARIO: name },
  stdio: "inherit",
});

child.on("exit", (code, signal) => {
  if (signal) process.kill(process.pid, signal);
  process.exit(code ?? 0);
});
