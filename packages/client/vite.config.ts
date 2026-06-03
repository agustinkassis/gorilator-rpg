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
  brain?: BrainId;
  stats?: CharacterStatsConfig;
}

const charsPathFor = (root: string) => resolve(root, "public/characters.json");
const npcsPathFor = (root: string) => resolve(root, "public/npcs.json");
const spawnersPathFor = (root: string) => resolve(root, "public/spawners.json");
const resourcesPathFor = (root: string) => resolve(root, "public/resources.json");
const structuresPathFor = (root: string) => resolve(root, "public/structures.json");
const entityFeaturesPathFor = (root: string) => resolve(root, "public/entity-features.json");
const itemsPathFor = (root: string) => resolve(root, "public/items.json");
const itemAssetsDirFor = (root: string) => resolve(root, "public/items");

// Per-structure-kind loot table: a list of {item, amount, probability} rolled
// independently when the structure is destroyed. Read live by the server.
interface LootEntry {
  item: string;
  amount: number;
  probability: number; // 0..1
}

interface StructureMask {
  type: "polygon";
  points: { x: number; z: number }[];
}

interface StructureCfg {
  loot?: LootEntry[];
  mask?: StructureMask;
}

function sanitizeStructureMask(raw: unknown): StructureMask | undefined {
  const obj = raw as { type?: unknown; points?: unknown } | null;
  if (!obj || obj.type !== "polygon" || !Array.isArray(obj.points)) return undefined;
  const points = obj.points
    .slice(0, 64)
    .map((p) => {
      const point = p as { x?: unknown; z?: unknown };
      const x = Number(point.x);
      const z = Number(point.z);
      return Number.isFinite(x) && Number.isFinite(z) ? { x, z } : null;
    })
    .filter((p): p is { x: number; z: number } => !!p);
  return points.length >= 3 ? { type: "polygon", points } : undefined;
}

interface ItemDef {
  id: string;
  name: string;
  icon?: string;
  model?: string;
  stack?: number;
  worldScale?: number;
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
  brain?: BrainId;
  modelId?: string;
  label?: string;
  stats?: CharacterStatsConfig;
}
interface Spawner {
  id: string; // unique spawn rule id
  ownerId: string; // selected structure/object id; the spawn point is derived from it
  type?: string; // goblin | dummy | npc | tree | ...
  modelId?: string;
  label?: string;
  intervalMs: number;
  cap: number; // max live goblins from this spawner
  behavior?: SpawnerBehavior;
}

type BrainId = "idle" | "passive_patrol" | "war_seeker" | "attacks_home";
interface CharacterStatsConfig {
  maxHp?: number;
  attack?: number;
  armor?: number;
  critChance?: number;
  moveSpeed?: number;
  throwPower?: number;
  level?: number;
  xp?: number;
}
interface FeatureDrop {
  item: string;
  quantity: number;
  probability: number;
  trigger: "kill" | "damage";
}

function normalizeSpawnerEntry(raw: Record<string, unknown>): Spawner | null {
  const id = String(raw.id || "");
  const ownerId = String(raw.ownerId || "");
  if (!id || !ownerId) return null;
  const behavior = raw.behavior && typeof raw.behavior === "object"
    ? raw.behavior as SpawnerBehavior
    : {};
  const modelId = raw.modelId ? String(raw.modelId) : behavior.modelId;
  const label = raw.label ? String(raw.label) : behavior.label;
  return {
    id,
    ownerId,
    type: String(raw.type || (modelId ? "npc" : "goblin")),
    ...(modelId ? { modelId } : {}),
    ...(label ? { label } : {}),
    intervalMs: Math.max(200, Number(raw.intervalMs) || 4000),
    cap: Math.max(0, Math.min(50, Number(raw.cap) || 3)),
    behavior,
  };
}

function readSpawners(root: string): Spawner[] {
  return readJsonArray<Record<string, unknown>>(spawnersPathFor(root))
    .map((s) => normalizeSpawnerEntry(s))
    .filter((s): s is Spawner => Boolean(s));
}

function deleteSpawnersForOwners(root: string, ownerIds: string[]): void {
  const owners = new Set(ownerIds.filter(Boolean));
  if (!owners.size) return;
  const list = readSpawners(root);
  writeJsonArray(spawnersPathFor(root), list.filter((s) => !owners.has(s.ownerId)));
}
interface EntityFeatureConfig {
  hp?: number;
  brain?: BrainId;
  stats?: CharacterStatsConfig;
  drops?: FeatureDrop[];
}
interface EntityFeatureManifest {
  defaults?: Record<string, EntityFeatureConfig>;
  instances?: Record<string, EntityFeatureConfig>;
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
            deleteSpawnersForOwners(root, [key, e.id, e.model]);
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
              ...(b.brain ? { brain: String(b.brain) } : {}),
              ...(b.stats && typeof b.stats === "object" ? { stats: b.stats } : {}),
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

      // ======== Item-definition endpoints (dev-authored inventory items) ========
      server.middlewares.use("/__items/defs", (req, res) => {
        if (req.method !== "GET") return fail(res, 405, "GET only");
        sendJson(res, readJsonArray<ItemDef>(itemsPathFor(root)));
      });
      server.middlewares.use("/__items/upload", (req, res) => {
        if (req.method !== "POST") return fail(res, 405, "POST only");
        const url = new URL(req.url || "", "http://localhost");
        const kind = url.searchParams.get("kind") === "model" ? "model" : "icon";
        const base = slug(url.searchParams.get("name") || "item");
        const rawFile = url.searchParams.get("filename") || "";
        const rawExt = (rawFile.match(/\.[a-z0-9]+$/i)?.[0] || "").toLowerCase();
        const ext =
          kind === "model"
            ? ".glb"
            : [".png", ".jpg", ".jpeg", ".webp"].includes(rawExt)
              ? rawExt
              : ".png";
        void collectBody(req).then((buf) => {
          try {
            if (!buf.length) return fail(res, 400, "empty body");
            const dir = itemAssetsDirFor(root);
            if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
            const file = `${base}_${kind}_${Date.now()}${ext}`;
            writeFileSync(resolve(dir, file), buf);
            sendJson(res, { ok: true, url: `/items/${file}` });
          } catch (e) {
            fail(res, 500, String(e));
          }
        });
      });
      server.middlewares.use("/__items/save", (req, res) => {
        if (req.method !== "POST") return fail(res, 405, "POST only");
        void collectBody(req).then((buf) => {
          try {
            const raw = JSON.parse(buf.toString("utf8") || "{}") as ItemDef;
            const id = slug(raw.id || raw.name || "item").slice(0, 48);
            if (!id) return fail(res, 400, "missing id");
            const entry: ItemDef = {
              id,
              name: String(raw.name || id).slice(0, 48),
              stack: Math.max(1, Math.min(999, Math.round(Number(raw.stack) || 99))),
              worldScale: Math.max(0.05, Math.min(20, Number(raw.worldScale) || 1.2)),
            };
            if (raw.icon) entry.icon = String(raw.icon);
            if (raw.model) entry.model = String(raw.model);
            const items = readJsonArray<ItemDef>(itemsPathFor(root));
            const i = items.findIndex((x) => x.id === id);
            if (i >= 0) items[i] = entry;
            else items.push(entry);
            writeJsonArray(itemsPathFor(root), items);
            sendJson(res, { ok: true, item: entry });
          } catch (e) {
            fail(res, 500, String(e));
          }
        });
      });
      server.middlewares.use("/__items/delete", (req, res) => {
        if (req.method !== "POST") return fail(res, 405, "POST only");
        void collectBody(req).then((buf) => {
          try {
            const b = JSON.parse(buf.toString("utf8") || "{}");
            const id = String(b.id || "");
            const items = readJsonArray<ItemDef>(itemsPathFor(root));
            writeJsonArray(itemsPathFor(root), items.filter((x) => x.id !== id));
            sendJson(res, { ok: true });
          } catch (e) {
            fail(res, 500, String(e));
          }
        });
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
            if (patch.brain !== undefined) (p as Record<string, unknown>).brain = String(patch.brain);
            if (patch.stats && typeof patch.stats === "object") (p as Record<string, unknown>).stats = patch.stats;
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

      // ======== Generic entity feature config (HP / drops / brain / stats) ========
      const readFeatures = (): EntityFeatureManifest => {
        const p = entityFeaturesPathFor(root);
        if (!existsSync(p)) return { defaults: {}, instances: {} };
        try {
          const o = JSON.parse(readFileSync(p, "utf8"));
          return o && typeof o === "object" ? o : { defaults: {}, instances: {} };
        } catch {
          return { defaults: {}, instances: {} };
        }
      };
      const writeFeatures = (m: EntityFeatureManifest) => {
        writeFileSync(entityFeaturesPathFor(root), JSON.stringify({
          defaults: m.defaults ?? {},
          instances: m.instances ?? {},
        }, null, 2));
      };
      const sanitizeFeature = (raw: Record<string, unknown>): EntityFeatureConfig => {
        const out: EntityFeatureConfig = {};
        if (raw.hp !== undefined) out.hp = Math.max(0, Math.round(Number(raw.hp) || 0));
        if (raw.brain !== undefined) {
          const b = String(raw.brain);
          if (["idle", "passive_patrol", "war_seeker", "attacks_home"].includes(b)) out.brain = b as BrainId;
        }
        if (raw.stats && typeof raw.stats === "object") {
          const src = raw.stats as Record<string, unknown>;
          const stats: CharacterStatsConfig = {};
          for (const k of ["maxHp", "attack", "armor", "critChance", "moveSpeed", "throwPower", "level", "xp"] as const) {
            if (src[k] !== undefined && Number.isFinite(Number(src[k]))) stats[k] = Math.max(0, Number(src[k]));
          }
          if (Object.keys(stats).length) out.stats = stats;
        }
        if (Array.isArray(raw.drops)) {
          out.drops = raw.drops.slice(0, 40).map((d: Record<string, unknown>) => ({
            item: String(d.item || "log"),
            quantity: Math.max(0, Math.round(Number(d.quantity) || 0)),
            probability: Math.max(0, Math.min(1, Number(d.probability) || 0)),
            trigger: d.trigger === "damage" ? "damage" : "kill",
          }));
        }
        return out;
      };
      server.middlewares.use("/__features/list", (req, res) => {
        if (req.method !== "GET") return fail(res, 405, "GET only");
        sendJson(res, readFeatures());
      });
      server.middlewares.use("/__features/save", (req, res) => {
        if (req.method !== "POST") return fail(res, 405, "POST only");
        void collectBody(req).then((buf) => {
          try {
            const b = JSON.parse(buf.toString("utf8") || "{}") as Record<string, unknown>;
            const scope = b.scope === "instance" ? "instances" : "defaults";
            const key = String(b.key || "");
            if (!key) return fail(res, 400, "missing key");
            const manifest = readFeatures();
            const bucket = scope === "instances"
              ? { ...(manifest.instances ?? {}) }
              : { ...(manifest.defaults ?? {}) };
            const next = sanitizeFeature((b.config && typeof b.config === "object" ? b.config : b) as Record<string, unknown>);
            bucket[key] = next;
            if (scope === "instances") manifest.instances = bucket;
            else manifest.defaults = bucket;
            writeFeatures(manifest);
            sendJson(res, { ok: true, scope, key });
          } catch (e) {
            fail(res, 500, String(e));
          }
        });
      });

      // ======== Spawner endpoints (objects that spawn goblins) ========
      server.middlewares.use("/__spawners/list", (req, res) => {
        if (req.method !== "GET") return fail(res, 405, "GET only");
        sendJson(res, readSpawners(root));
      });
      server.middlewares.use("/__spawners/save", (req, res) => {
        if (req.method !== "POST") return fail(res, 405, "POST only");
        void collectBody(req).then((buf) => {
          try {
            const raw = JSON.parse(buf.toString("utf8") || "{}") as Record<string, unknown>;
            const entry = normalizeSpawnerEntry(raw);
            if (!entry) return fail(res, 400, "missing id or ownerId");
            const list = readSpawners(root);
            const i = list.findIndex((x) => x.id === entry.id);
            if (i >= 0) list[i] = entry;
            else list.push(entry);
            writeJsonArray(spawnersPathFor(root), list);
            sendJson(res, { ok: true, id: entry.id });
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
            const id = String(b.id ?? "");
            const ownerId = String(b.ownerId ?? "");
            if (!id && !ownerId) return fail(res, 400, "missing id or ownerId");
            const list = readSpawners(root);
            writeJsonArray(
              spawnersPathFor(root),
              list.filter((x) => x.id !== id && x.ownerId !== ownerId),
            );
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
      const readStructures = (): Record<string, StructureCfg> => {
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
            const next: StructureCfg = { ...(all[kind] ?? {}), loot };
            if ("mask" in b) {
              const mask = sanitizeStructureMask(b.mask);
              if (mask) next.mask = mask;
              else delete next.mask;
            }
            all[kind] = next;
            writeFileSync(structuresPathFor(root), JSON.stringify(all, null, 2));
            sendJson(res, { ok: true, kind, count: loot.length, mask: !!next.mask });
          } catch (e) {
            fail(res, 500, String(e));
          }
        });
      });
    },
  };
}

/**
 * Dev-only endpoints for the in-game performance overlay (F3). They persist client
 * perf artefacts to the repo-root `perf-logs/` directory (gitignored), the same
 * place the server writes its JSONL — so one folder holds every artefact the
 * analyzer reads. See docs/performance.md.
 *   POST /__perf/save?name=<file>&kind=log|benchmark   raw body → perf-logs/<file>
 *   GET  /__perf/list                                  → list saved artefacts
 */
function perfLogs(): Plugin {
  // Vite's root is packages/client; the shared perf-logs dir lives at the repo root.
  const perfDirFor = (root: string) => resolve(root, "../../perf-logs");
  // Keep a client-supplied filename inside perf-logs: strip any path, allow only a
  // safe charset, and force a .jsonl/.json extension.
  const safeName = (raw: string, kind: string) => {
    const base = (raw.split(/[\\/]/).pop() || "").replace(/[^a-zA-Z0-9._-]/g, "_");
    const fallback = `${kind === "benchmark" ? "bench" : "perf-log"}-${Date.now()}`;
    const name = base || fallback;
    return /\.(jsonl|json)$/i.test(name) ? name : `${name}.${kind === "benchmark" ? "json" : "jsonl"}`;
  };
  return {
    name: "rpg-perf-logs",
    configureServer(server: ViteDevServer) {
      const dir = perfDirFor(server.config.root);
      server.middlewares.use("/__perf/save", (req, res) => {
        if (req.method !== "POST") return fail(res, 405, "POST only");
        const url = new URL(req.url || "", "http://localhost");
        const name = safeName(url.searchParams.get("name") || "", url.searchParams.get("kind") || "log");
        void collectBody(req).then((buf) => {
          try {
            if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
            writeFileSync(resolve(dir, name), buf);
            sendJson(res, { ok: true, name, bytes: buf.length });
          } catch (e) {
            fail(res, 500, String(e));
          }
        });
      });
      server.middlewares.use("/__perf/list", (req, res) => {
        if (req.method !== "GET") return fail(res, 405, "GET only");
        try {
          const files = existsSync(dir)
            ? readdirSync(dir)
                .filter((f) => /\.(jsonl|json)$/i.test(f))
                .map((f) => ({ name: f, size: statSync(resolve(dir, f)).size }))
            : [];
          sendJson(res, files);
        } catch (e) {
          fail(res, 500, String(e));
        }
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
  plugins: [modelImporter(), perfLogs()],
  server: {
    port: Number(process.env.CLIENT_PORT) || 5173,
    strictPort: true,
  },
});
