import { existsSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

// Feature Lab scenario runner (#66): `pnpm scenario <name>` boots the dev
// stack with scenarios/<name>.json layered in (docs/feature-lab.md). The
// server reads GORILATOR_SCENARIO; the printed ?scenario= link makes the
// client auto-join single-player with the Scenario tweaks panel pre-pinned.

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const scenariosDir = join(root, "scenarios");

function available() {
  if (!existsSync(scenariosDir)) return [];
  return readdirSync(scenariosDir)
    .filter((f) => f.endsWith(".json"))
    .map((f) => f.replace(/\.json$/, ""))
    .sort();
}

const name = (process.argv[2] ?? "").trim();
if (!name || !existsSync(join(scenariosDir, `${name}.json`))) {
  const list = available();
  console.error(name ? `[scenario] scenarios/${name}.json not found` : "[scenario] usage: pnpm scenario <name>");
  console.error(list.length ? `[scenario] available: ${list.join(", ")}` : "[scenario] no scenarios/ manifests yet");
  process.exit(1);
}

process.env.GORILATOR_SCENARIO = name;
const clientPort = process.env.CLIENT_PORT ?? "5173";
console.log(`[scenario] "${name}" selected (GORILATOR_SCENARIO=${name})`);
console.log(`[scenario] ready-to-play: http://localhost:${clientPort}/?scenario=${name}`);
console.log(`[scenario] (if the [dev] client line below shows another port, use that one)`);

await import("./dev.mjs");
