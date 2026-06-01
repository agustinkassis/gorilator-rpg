import { readFileSync, existsSync, watchFile } from "fs";
import { resolve } from "path";
import { setPropObstacles } from "./pathfinding";

/** The importer writes the manifest into the client's public dir (so the browser
 *  can fetch it too). Resolve it from the repo root or one level up. */
const CANDIDATES = [
  resolve(process.cwd(), "packages/client/public/props.json"),
  resolve(process.cwd(), "../client/public/props.json"),
  resolve(process.cwd(), "client/public/props.json"),
];

interface PropDef {
  name: string;
  x: number;
  z: number;
  collisionRadius?: number; // present + > 0 ⇒ concrete (blocks movement / bananas)
}

function manifestPath(): string | null {
  return CANDIDATES.find((p) => existsSync(p)) ?? null;
}

function applyFrom(path: string): void {
  try {
    const props: PropDef[] = JSON.parse(readFileSync(path, "utf8"));
    const circles = props
      .filter((p) => typeof p.collisionRadius === "number" && p.collisionRadius > 0)
      .map((p) => ({ x: p.x, z: p.z, radius: p.collisionRadius as number }));
    setPropObstacles(circles);
    console.log(`[props] ${props.length} prop(s), ${circles.length} concrete (collision) from props.json`);
  } catch (e) {
    console.warn("[props] failed to read props.json", e);
  }
}

/** Load concrete-prop collisions from props.json and keep watching it, so props
 *  added by the in-game importer start blocking movement without a server restart. */
export function loadPropObstacles(): void {
  const path = manifestPath();
  if (!path) return; // no manifest yet — nothing imported
  applyFrom(path);
  // Poll the file (works across editors/dev-servers) and re-apply on change.
  watchFile(path, { interval: 1500 }, () => applyFrom(path));
}
