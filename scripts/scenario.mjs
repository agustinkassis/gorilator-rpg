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
console.log(`[scenario] "${name}" selected (GORILATOR_SCENARIO=${name}) — booting the dev stack…`);

const dev = await import("./dev.mjs");
const clientPort = dev.clientPort ?? Number(process.env.CLIENT_PORT ?? 5173);
const serverPort = dev.serverPort ?? Number(process.env.GAME_SERVER_PORT ?? 2567);
const autoJoin = name === "hunger" ? "HungerBot" : "dev";
const link = `http://localhost:${clientPort}/?scenario=${encodeURIComponent(name)}&autojoin=${encodeURIComponent(autoJoin)}`;

// Print the ready-to-play link LAST — only once the stack actually answers —
// so it sits at the bottom of the boot noise, handy to click.
const up = async (url) => {
  try {
    return (await fetch(url)).ok;
  } catch {
    return false;
  }
};
const deadline = Date.now() + 120_000;
const printLink = () => {
  const line = "─".repeat(Math.min(64, link.length + 21));
  console.log(`\n[scenario] ${line}`);
  console.log(`[scenario] ▶ ready to play:  ${link}`);
  console.log(`[scenario] ${line}`);
};
while (Date.now() < deadline) {
  if ((await up(`http://localhost:${serverPort}/healthz`)) && (await up(`http://localhost:${clientPort}/`))) {
    // a short quiet gap so the banner lands after the startup burst
    setTimeout(printLink, 1200);
    break;
  }
  await new Promise((r) => setTimeout(r, 300));
}
if (Date.now() >= deadline) console.warn(`[scenario] stack not up after 120s — once it is, play at ${link}`);
