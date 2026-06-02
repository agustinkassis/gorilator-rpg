import { defineConfig, type Plugin, type ViteDevServer } from "vite";
import type { IncomingMessage, ServerResponse } from "http";
import {
  writeFileSync,
  readFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  unlinkSync,
  statSync,
} from "fs";
import { resolve } from "path";
import { execFileSync } from "child_process";

/** The app version shown in-game (the tiny footer tag), read from this package's
 *  package.json. Vite runs with the package dir as cwd, so a cwd-relative read is
 *  reliable; fall back to 0.0.0 if it can't be read. */
function appVersion(): string {
  try {
    const pkg = JSON.parse(readFileSync(resolve("package.json"), "utf8")) as { version?: string };
    return pkg.version ?? "0.0.0";
  } catch {
    return "0.0.0";
  }
}

interface PropEntry {
  id: string;
  name: string;
  model: string;
  x: number;
  z: number;
  scale: number;
  rotationY: number;
  collisionRadius?: number;
}

const propsPathFor = (root: string) => resolve(root, "public/props.json");
const modelsDirFor = (root: string) => resolve(root, "public/models");

function readProps(root: string): PropEntry[] {
  const p = propsPathFor(root);
  if (!existsSync(p)) return [];
  try {
    const arr = JSON.parse(readFileSync(p, "utf8"));
    return Array.isArray(arr) ? arr : [];
  } catch {
    return [];
  }
}

function writeProps(root: string, props: PropEntry[]) {
  writeFileSync(propsPathFor(root), JSON.stringify(props, null, 2));
}

/** A url/name-safe slug for a prop's filename + id stem. */
const slug = (s: string) =>
  String(s || "prop")
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "_")
    .replace(/^_+|_+$/g, "") || "prop";

function collectBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((res, rej) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => res(Buffer.concat(chunks)));
    req.on("error", rej);
  });
}

const sendJson = (res: ServerResponse, obj: unknown) => {
  res.setHeader("content-type", "application/json");
  res.end(JSON.stringify(obj));
};
const fail = (res: ServerResponse, code: number, msg: string) => {
  res.statusCode = code;
  res.end(msg);
};

/** Build a manifest entry from a meta object + a (already-written) model url. */
function entryFromMeta(meta: Record<string, unknown>, model: string, id: string): PropEntry {
  const entry: PropEntry = {
    id,
    name: String(meta.name ?? id),
    model,
    x: Number(meta.x) || 0,
    z: Number(meta.z) || 0,
    scale: Number(meta.scale) || 1,
    rotationY: Number(meta.rotationY) || 0,
  };
  const cr = Number(meta.collisionRadius);
  if (cr > 0) entry.collisionRadius = cr; // concrete → blocks movement
  return entry;
}

// ---- Custom characters (imported Meshy zips) ----
// A CharacterDef is the reusable template (base mesh + per-action animation glbs +
// orientation/scale + placeholder stats); npcs.json holds placements of a def.
type CharAction = "IDLE" | "WALK" | "ATTACK" | "THROW" | "HIT" | "DEAD";
interface CharAnim {
  file: string; // url under /models
  speed?: number;
  yawFix?: number; // radians, per-clip facing correction
}
interface CharacterDef {
  id: string;
  name: string;
  category?: string;
  baseModel: string; // url under /models
  anims: Partial<Record<CharAction, CharAnim>>;
  yaw: number; // base orientation (radians)
  scale: number;
  stats?: Record<string, number>; // default placeholders (Phase 2 drives them)
}
interface Placement {
  id: string;
  defId: string;
  x: number;
  z: number;
  rotationY: number;
}

const charsPathFor = (root: string) => resolve(root, "public/characters.json");
const npcsPathFor = (root: string) => resolve(root, "public/npcs.json");
const spawnersPathFor = (root: string) => resolve(root, "public/spawners.json");
const resourcesPathFor = (root: string) => resolve(root, "public/resources.json");
const structuresPathFor = (root: string) => resolve(root, "public/structures.json");

// Per-structure-kind loot table: a list of {item, amount, probability} rolled
// independently when the structure is destroyed. Read live by the server.
interface LootEntry {
  item: string;
  amount: number;
  probability: number; // 0..1
}

// Per-resource-kind drop config: which item a tree/rock yields, how many, on hit
// (progressive) or kill (full), and the resource's total HP (drives the drop rate:
// hp/amount damage per item). Read live by the server.
interface DropCfg {
  item: string;
  amount: number;
  trigger: "hit" | "kill";
  hp: number;
}

// A spawner makes an object spawn goblins on a timer. `behavior` overrides the
// global goblin constants for the goblins this spawner produces (0/undef = default).
interface SpawnerBehavior {
  hp?: number;
  attack?: number;
  aggroRadius?: number;
  chaseSpeed?: number;
  attackCooldownMs?: number;
  houseDamage?: number;
}
interface Spawner {
  id: string; // the selected object's id
  x: number;
  z: number;
  intervalMs: number;
  cap: number; // max live goblins from this spawner
  behavior?: SpawnerBehavior;
}
const charDirFor = (root: string) => resolve(root, "public/models/characters");

function readJsonArray<T>(path: string): T[] {
  if (!existsSync(path)) return [];
  try {
    const arr = JSON.parse(readFileSync(path, "utf8"));
    return Array.isArray(arr) ? arr : [];
  } catch {
    return [];
  }
}
const writeJsonArray = (path: string, arr: unknown[]) =>
  writeFileSync(path, JSON.stringify(arr, null, 2));

/** Classify an unzipped glb: the base mesh vs a single-animation file, deriving a
 *  clip label from the Meshy naming "..._Animation_<Clip>_withSkin.glb". */
function classifyGlb(file: string): { kind: "base" | "anim"; clip: string } {
  if (/character_output/i.test(file)) return { kind: "base", clip: "base" };
  const m = file.match(/_Animation_(.+?)_withSkin\.glb$/i);
  if (m) return { kind: "anim", clip: m[1] };
  return { kind: "anim", clip: file.replace(/\.glb$/i, "") };
}

/**
 * Dev-only endpoints for the in-game model importer / Dev Mode world editor. They
 * read & write public/props.json (which the client renders and the server reads
 * for collision) plus the public/models folder:
 *   POST /__props/add     raw .glb body + ?meta=<json>  → write model + append entry
 *   POST /__props/place   json {model, ...meta}         → append entry for an existing model
 *   POST /__props/update  json {id, ...fields}          → patch an entry in place
 *   POST /__props/delete  json {id, deleteFile?}        → drop an entry (+ maybe its file)
 *   GET  /__props/models                                → list every available .glb
 */
function modelImporter(): Plugin {
  return {
    name: "rpg-model-importer",
    configureServer(server: ViteDevServer) {
      const root = server.config.root; // packages/client

      // ---- add: upload a new .glb and place it ----
      server.middlewares.use("/__props/add", (req, res) => {
        if (req.method !== "POST") return fail(res, 405, "POST only");
        const url = new URL(req.url || "", "http://localhost");
        let meta: Record<string, unknown>;
        try {
          meta = JSON.parse(url.searchParams.get("meta") || "{}");
        } catch {
          return fail(res, 400, "bad meta");
        }
        void collectBody(req).then((buf) => {
          try {
            if (buf.length === 0) return fail(res, 400, "empty body");
            const base = slug(String(meta.name || "prop"));
            const dir = modelsDirFor(root);
            if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
            const id = `${base}_${Date.now()}`;
            const file = `${id}.glb`;
            writeFileSync(resolve(dir, file), buf);

            const props = readProps(root);
            const entry = entryFromMeta(meta, `/models/${file}`, id);
            props.push(entry);
            writeProps(root, props);
            sendJson(res, { ok: true, id: entry.id, model: entry.model, name: entry.name });
          } catch (e) {
            fail(res, 500, String(e));
          }
        });
      });

      // ---- place: append an entry for a model that already exists on disk ----
      server.middlewares.use("/__props/place", (req, res) => {
        if (req.method !== "POST") return fail(res, 405, "POST only");
        void collectBody(req).then((buf) => {
          try {
            const meta = JSON.parse(buf.toString("utf8") || "{}");
            const model = String(meta.model || "");
            if (!/^\/models\/[\w.\-]+\.glb$/i.test(model)) return fail(res, 400, "bad model");
            const id = `${slug(String(meta.name || model.split("/").pop()))}_${Date.now()}`;
            const props = readProps(root);
            const entry = entryFromMeta(meta, model, id);
            props.push(entry);
            writeProps(root, props);
            sendJson(res, { ok: true, id: entry.id, model: entry.model, name: entry.name });
          } catch (e) {
            fail(res, 500, String(e));
          }
        });
      });

      // ---- update: patch fields of an existing entry (by id, or model url) ----
      server.middlewares.use("/__props/update", (req, res) => {
        if (req.method !== "POST") return fail(res, 405, "POST only");
        void collectBody(req).then((buf) => {
          try {
            const patch = JSON.parse(buf.toString("utf8") || "{}");
            const key = String(patch.id ?? "");
            const props = readProps(root);
            const e = props.find((p) => p.id === key || p.model === key);
            if (!e) return fail(res, 404, "no such prop");
            const rec = e as unknown as Record<string, unknown>;
            for (const f of ["name", "x", "z", "scale", "rotationY"] as const) {
              if (patch[f] !== undefined) rec[f] = f === "name" ? String(patch[f]) : Number(patch[f]);
            }
            if (patch.collisionRadius !== undefined) {
              const cr = Number(patch.collisionRadius);
              if (cr > 0) e.collisionRadius = cr;
              else delete e.collisionRadius; // concrete toggled off
            }
            if (!e.id) e.id = key; // backfill id on legacy entries
            writeProps(root, props);
            sendJson(res, { ok: true, id: e.id });
          } catch (e) {
            fail(res, 500, String(e));
          }
        });
      });

      // ---- delete: drop an entry, optionally unlinking its now-unused model ----
      server.middlewares.use("/__props/delete", (req, res) => {
        if (req.method !== "POST") return fail(res, 405, "POST only");
        void collectBody(req).then((buf) => {
          try {
            const body = JSON.parse(buf.toString("utf8") || "{}");
            const key = String(body.id ?? "");
            const props = readProps(root);
            const e = props.find((p) => p.id === key || p.model === key);
            if (!e) return fail(res, 404, "no such prop");
            const kept = props.filter((p) => p !== e);
            writeProps(root, kept);
            // only delete the file if nothing else references it (and it's an uploaded model)
            if (body.deleteFile && e.model && !kept.some((p) => p.model === e.model)) {
              const file = resolve(modelsDirFor(root), e.model.replace(/^\/models\//, ""));
              if (existsSync(file)) {
                try {
                  unlinkSync(file);
                } catch {
                  /* leave the file if it can't be removed */
                }
              }
            }
            sendJson(res, { ok: true });
          } catch (e) {
            fail(res, 500, String(e));
          }
        });
      });

      // ---- models: list every .glb available to place from the library ----
      server.middlewares.use("/__props/models", (req, res) => {
        if (req.method !== "GET") return fail(res, 405, "GET only");
        try {
          const dir = modelsDirFor(root);
          const files = existsSync(dir) ? readdirSync(dir).filter((f) => /\.glb$/i.test(f)) : [];
          const models = files.map((f) => ({
            name: f.replace(/\.glb$/i, ""),
            model: `/models/${f}`,
            size: statSync(resolve(dir, f)).size,
          }));
          sendJson(res, models);
        } catch (e) {
          fail(res, 500, String(e));
        }
      });

      // ======== Custom-character endpoints (imported Meshy zips) ========

      // import: upload a character .zip → unzip (flattened) into
      // public/models/characters/<id>/ and return the classified .glb list.
      server.middlewares.use("/__char/import", (req, res) => {
        if (req.method !== "POST") return fail(res, 405, "POST only");
        const url = new URL(req.url || "", "http://localhost");
        const name = slug(url.searchParams.get("name") || "character");
        void collectBody(req).then((buf) => {
          try {
            if (buf.length === 0) return fail(res, 400, "empty body");
            const baseDir = charDirFor(root);
            if (!existsSync(baseDir)) mkdirSync(baseDir, { recursive: true });
            const id = `${name}_${Date.now()}`;
            const outDir = resolve(baseDir, id);
            mkdirSync(outDir, { recursive: true });
            const zipPath = resolve(baseDir, `${id}.zip`);
            writeFileSync(zipPath, buf);
            try {
              execFileSync("unzip", ["-o", "-j", zipPath, "-d", outDir], { stdio: "ignore" });
            } finally {
              try {
                unlinkSync(zipPath);
              } catch {
                /* leave the temp zip if it can't be removed */
              }
            }
            const glbs = readdirSync(outDir).filter((f) => /\.glb$/i.test(f));
            if (!glbs.length) return fail(res, 400, "no .glb files in zip");
            const files = glbs.map((f) => {
              const c = classifyGlb(f);
              return {
                name: f,
                path: `/models/characters/${id}/${f}`,
                kind: c.kind,
                clip: c.clip,
                size: statSync(resolve(outDir, f)).size,
              };
            });
            sendJson(res, { ok: true, id, dir: `/models/characters/${id}`, files });
          } catch (e) {
            fail(res, 500, String(e));
          }
        });
      });

      // save: upsert a CharacterDef (the reusable template) into characters.json
      server.middlewares.use("/__char/save", (req, res) => {
        if (req.method !== "POST") return fail(res, 405, "POST only");
        void collectBody(req).then((buf) => {
          try {
            const def = JSON.parse(buf.toString("utf8") || "{}") as CharacterDef;
            if (!def.id || !def.baseModel) return fail(res, 400, "missing id/baseModel");
            const defs = readJsonArray<CharacterDef>(charsPathFor(root));
            const i = defs.findIndex((d) => d.id === def.id);
            if (i >= 0) defs[i] = def;
            else defs.push(def);
            writeJsonArray(charsPathFor(root), defs);
            sendJson(res, { ok: true, id: def.id });
          } catch (e) {
            fail(res, 500, String(e));
          }
        });
      });

      // defs: list saved character templates (the library)
      server.middlewares.use("/__char/defs", (req, res) => {
        if (req.method !== "GET") return fail(res, 405, "GET only");
        sendJson(res, readJsonArray<CharacterDef>(charsPathFor(root)));
      });

      // place: append a placement (instance) of a def into npcs.json
      server.middlewares.use("/__char/place", (req, res) => {
        if (req.method !== "POST") return fail(res, 405, "POST only");
        void collectBody(req).then((buf) => {
          try {
            const b = JSON.parse(buf.toString("utf8") || "{}");
            const defId = String(b.defId || "");
            if (!defId) return fail(res, 400, "missing defId");
            const id = `npc_${Date.now()}`;
            const placement: Placement = {
              id,
              defId,
              x: Number(b.x) || 0,
              z: Number(b.z) || 0,
              rotationY: Number(b.rotationY) || 0,
            };
            const npcs = readJsonArray<Placement>(npcsPathFor(root));
            npcs.push(placement);
            writeJsonArray(npcsPathFor(root), npcs);
            sendJson(res, { ok: true, id });
          } catch (e) {
            fail(res, 500, String(e));
          }
        });
      });

      // placements: list placed character instances
      server.middlewares.use("/__char/placements", (req, res) => {
        if (req.method !== "GET") return fail(res, 405, "GET only");
        sendJson(res, readJsonArray<Placement>(npcsPathFor(root)));
      });

      // placement-update: patch x/z/rotationY of a placement
      server.middlewares.use("/__char/placement-update", (req, res) => {
        if (req.method !== "POST") return fail(res, 405, "POST only");
        void collectBody(req).then((buf) => {
          try {
            const patch = JSON.parse(buf.toString("utf8") || "{}");
            const npcs = readJsonArray<Placement>(npcsPathFor(root));
            const p = npcs.find((n) => n.id === String(patch.id ?? ""));
            if (!p) return fail(res, 404, "no such placement");
            for (const f of ["x", "z", "rotationY"] as const)
              if (patch[f] !== undefined) p[f] = Number(patch[f]);
            writeJsonArray(npcsPathFor(root), npcs);
            sendJson(res, { ok: true });
          } catch (e) {
            fail(res, 500, String(e));
          }
        });
      });

      // placement-delete: remove a placement
      server.middlewares.use("/__char/placement-delete", (req, res) => {
        if (req.method !== "POST") return fail(res, 405, "POST only");
        void collectBody(req).then((buf) => {
          try {
            const b = JSON.parse(buf.toString("utf8") || "{}");
            const npcs = readJsonArray<Placement>(npcsPathFor(root));
            const kept = npcs.filter((n) => n.id !== String(b.id ?? ""));
            writeJsonArray(npcsPathFor(root), kept);
            sendJson(res, { ok: true });
          } catch (e) {
            fail(res, 500, String(e));
          }
        });
      });

      // ======== Spawner endpoints (objects that spawn goblins) ========
      server.middlewares.use("/__spawners/list", (req, res) => {
        if (req.method !== "GET") return fail(res, 405, "GET only");
        sendJson(res, readJsonArray<Spawner>(spawnersPathFor(root)));
      });
      server.middlewares.use("/__spawners/save", (req, res) => {
        if (req.method !== "POST") return fail(res, 405, "POST only");
        void collectBody(req).then((buf) => {
          try {
            const s = JSON.parse(buf.toString("utf8") || "{}") as Spawner;
            if (!s.id) return fail(res, 400, "missing id");
            const list = readJsonArray<Spawner>(spawnersPathFor(root));
            const entry: Spawner = {
              id: s.id,
              x: Number(s.x) || 0,
              z: Number(s.z) || 0,
              intervalMs: Math.max(200, Number(s.intervalMs) || 4000),
              cap: Math.max(0, Math.min(50, Number(s.cap) || 3)),
              behavior: s.behavior || {},
            };
            const i = list.findIndex((x) => x.id === s.id);
            if (i >= 0) list[i] = entry;
            else list.push(entry);
            writeJsonArray(spawnersPathFor(root), list);
            sendJson(res, { ok: true, id: s.id });
          } catch (e) {
            fail(res, 500, String(e));
          }
        });
      });
      server.middlewares.use("/__spawners/delete", (req, res) => {
        if (req.method !== "POST") return fail(res, 405, "POST only");
        void collectBody(req).then((buf) => {
          try {
            const b = JSON.parse(buf.toString("utf8") || "{}");
            const list = readJsonArray<Spawner>(spawnersPathFor(root));
            writeJsonArray(spawnersPathFor(root), list.filter((x) => x.id !== String(b.id ?? "")));
            sendJson(res, { ok: true });
          } catch (e) {
            fail(res, 500, String(e));
          }
        });
      });

      // ======== Resource drop config (per-kind tree/rock loot) ========
      const readDrops = (): Record<string, DropCfg> => {
        const p = resourcesPathFor(root);
        if (!existsSync(p)) return {};
        try {
          const o = JSON.parse(readFileSync(p, "utf8"));
          return o && typeof o === "object" ? o : {};
        } catch {
          return {};
        }
      };
      server.middlewares.use("/__resources/list", (req, res) => {
        if (req.method !== "GET") return fail(res, 405, "GET only");
        sendJson(res, readDrops());
      });
      server.middlewares.use("/__resources/save", (req, res) => {
        if (req.method !== "POST") return fail(res, 405, "POST only");
        void collectBody(req).then((buf) => {
          try {
            const b = JSON.parse(buf.toString("utf8") || "{}");
            const kind = String(b.kind || "");
            if (!kind) return fail(res, 400, "missing kind");
            const drops = readDrops();
            drops[kind] = {
              item: String(b.item || "stone"),
              amount: Math.max(0, Number(b.amount) || 0),
              trigger: b.trigger === "kill" ? "kill" : "hit",
              hp: Math.max(1, Math.round(Number(b.hp) || (kind === "tree" ? 60 : 560))),
            };
            writeFileSync(resourcesPathFor(root), JSON.stringify(drops, null, 2));
            sendJson(res, { ok: true, kind });
          } catch (e) {
            fail(res, 500, String(e));
          }
        });
      });

      // ======== Structure loot tables (items dropped when a structure is destroyed) ========
      const readStructures = (): Record<string, { loot: LootEntry[] }> => {
        const p = structuresPathFor(root);
        if (!existsSync(p)) return {};
        try {
          const o = JSON.parse(readFileSync(p, "utf8"));
          return o && typeof o === "object" ? o : {};
        } catch {
          return {};
        }
      };
      server.middlewares.use("/__structures/list", (req, res) => {
        if (req.method !== "GET") return fail(res, 405, "GET only");
        sendJson(res, readStructures());
      });
      server.middlewares.use("/__structures/save", (req, res) => {
        if (req.method !== "POST") return fail(res, 405, "POST only");
        void collectBody(req).then((buf) => {
          try {
            const b = JSON.parse(buf.toString("utf8") || "{}");
            const kind = String(b.kind || "");
            if (!kind) return fail(res, 400, "missing kind");
            const loot: LootEntry[] = Array.isArray(b.loot)
              ? b.loot.slice(0, 20).map((e: Record<string, unknown>) => ({
                  item: String(e.item || "log"),
                  amount: Math.max(0, Math.round(Number(e.amount) || 0)),
                  probability: Math.max(0, Math.min(1, Number(e.probability) || 0)),
                }))
              : [];
            const all = readStructures();
            all[kind] = { loot };
            writeFileSync(structuresPathFor(root), JSON.stringify(all, null, 2));
            sendJson(res, { ok: true, kind, count: loot.length });
          } catch (e) {
            fail(res, 500, String(e));
          }
        });
      });
    },
  };
}

// @rpg/shared is consumed as its compiled output (packages/shared/dist), resolved
// via the workspace symlink + its package.json "exports". That keeps the Colyseus
// schema decorators compiled correctly by tsc, independent of esbuild's handling.
export default defineConfig({
  // Inject the package version as a global constant for the footer version tag.
  define: { __APP_VERSION__: JSON.stringify(appVersion()) },
  plugins: [modelImporter()],
  server: {
    port: Number(process.env.CLIENT_PORT) || 5173,
    strictPort: true,
  },
});
