// Dev-mode in-game editor API — the server-side counterpart to the Vite dev
// server's `/__*/` endpoints (packages/client/vite.config.ts). It is mounted ONLY
// when NODE_ENV=development (the `gorilator` dev server) so the in-game Dev Mode
// editor can persist to the content manifests (packages/client/public/*.json) on a
// single-port, built-client deployment — where Vite isn't running.
//
// SECURITY: this writes to the repo's content files, so on a public tunneled dev
// host every MUTATING (POST) route is gated behind NIP-98 admin auth (requireAdmin
// — the same gate as /api/admin/*). GET routes only read already-public JSON and
// stay open. Intentionally NOT ported from the Vite plugin: arbitrary file
// read/write (/__worktree/*), source mutation (/__gameplay/default rewrites
// shared/constants.ts), git operations, and community import — too dangerous to
// expose on a public origin. Keep the routes here in sync with vite.config.ts.
import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { relative, resolve } from "node:path";
import { type Request, type Response, Router, raw } from "express";
import { requireAdmin } from "../systems/nip98";

// --- public/ directory resolution (mirrors the systems' multi-candidate lookup;
//     the daemon runs from packages/server, so `../client/public` is the hit). ---
let cachedPublicDir: string | null = null;
function publicDir(): string {
  if (cachedPublicDir) return cachedPublicDir;
  const candidates = [
    resolve(process.cwd(), "packages/client/public"),
    resolve(process.cwd(), "../client/public"),
    resolve(process.cwd(), "client/public"),
  ];
  cachedPublicDir = candidates.find((p) => existsSync(p)) ?? candidates[0];
  return cachedPublicDir;
}
const pub = (rel: string): string => resolve(publicDir(), rel);
const modelsDir = (): string => pub("models");
const charDir = (): string => pub("models/characters");
const itemAssetsDir = (): string => pub("items");

// --- small helpers (Express idioms; req.body is JSON-parsed by the global
//     express.json() for content-type application/json) ---
const slug = (s: unknown): string =>
  String(s || "prop")
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "_")
    .replace(/^_+|_+$/g, "") || "prop";

function readArray<T>(path: string): T[] {
  if (!existsSync(path)) return [];
  try {
    const arr = JSON.parse(readFileSync(path, "utf8"));
    return Array.isArray(arr) ? (arr as T[]) : [];
  } catch {
    return [];
  }
}
function writeArray(path: string, arr: unknown[]): void {
  writeFileSync(path, JSON.stringify(arr, null, 2));
}
function readObject<T extends object>(path: string): T {
  if (!existsSync(path)) return {} as T;
  try {
    const o = JSON.parse(readFileSync(path, "utf8"));
    return o && typeof o === "object" ? (o as T) : ({} as T);
  } catch {
    return {} as T;
  }
}
function writeObject(path: string, obj: object): void {
  writeFileSync(path, JSON.stringify(obj, null, 2));
}
const body = (req: Request): Record<string, unknown> =>
  req.body && typeof req.body === "object" && !Buffer.isBuffer(req.body)
    ? (req.body as Record<string, unknown>)
    : {};

/** Classify a Meshy `.glb` as the base mesh or an animation clip (mirrors the
 *  `*_Animation_<Clip>_withSkin.glb` naming the importer relies on). */
function classifyGlb(file: string): { kind: "base" | "anim"; clip: string } {
  const m = file.match(/_Animation_(.+?)_withSkin/i) ?? file.match(/_Animation_(.+?)\.glb$/i);
  return m ? { kind: "anim", clip: m[1] } : { kind: "base", clip: "" };
}

function normalizeSpawner(raw: Record<string, unknown>): Record<string, unknown> | null {
  const id = String(raw.id || "");
  const ownerId = String(raw.ownerId || "");
  if (!id || !ownerId) return null;
  const behavior =
    raw.behavior && typeof raw.behavior === "object" ? (raw.behavior as Record<string, unknown>) : {};
  const modelId = raw.modelId ? String(raw.modelId) : (behavior.modelId as string | undefined);
  const label = raw.label ? String(raw.label) : (behavior.label as string | undefined);
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

const BRAINS = new Set(["idle", "passive_patrol", "war_seeker", "attacks_home"]);
function sanitizeFeature(raw: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (raw.hp !== undefined) out.hp = Math.max(0, Math.round(Number(raw.hp) || 0));
  if (raw.brain !== undefined && BRAINS.has(String(raw.brain))) out.brain = String(raw.brain);
  if (raw.stats && typeof raw.stats === "object") {
    const src = raw.stats as Record<string, unknown>;
    const stats: Record<string, number> = {};
    for (const k of ["maxHp", "attack", "armor", "critChance", "moveSpeed", "throwPower", "level", "xp"]) {
      if (src[k] !== undefined && Number.isFinite(Number(src[k]))) stats[k] = Math.max(0, Number(src[k]));
    }
    if (Object.keys(stats).length) out.stats = stats;
  }
  if (Array.isArray(raw.drops)) {
    out.drops = (raw.drops as Record<string, unknown>[]).slice(0, 40).map((d) => ({
      item: String(d.item || "log"),
      quantity: Math.max(0, Math.round(Number(d.quantity) || 0)),
      probability: Math.max(0, Math.min(1, Number(d.probability) || 0)),
      trigger: d.trigger === "damage" ? "damage" : "kill",
    }));
  }
  return out;
}

/** Sanitize a structure collision mask (a polygon of >=3 finite points), mirroring
 *  the Vite handler so mask edits from the editor persist. */
function sanitizeStructureMask(raw: unknown): { type: "polygon"; points: { x: number; z: number }[] } | undefined {
  const obj = raw as { type?: unknown; points?: unknown } | null;
  if (!obj || obj.type !== "polygon" || !Array.isArray(obj.points)) return undefined;
  const points = obj.points
    .slice(0, 64)
    .map((p) => {
      const pt = p as { x?: unknown; z?: unknown };
      const x = Number(pt.x);
      const z = Number(pt.z);
      return Number.isFinite(x) && Number.isFinite(z) ? { x, z } : null;
    })
    .filter((p): p is { x: number; z: number } => !!p);
  return points.length >= 3 ? { type: "polygon", points } : undefined;
}

/** Build the dev-editor router. Mount only in development, before the SPA
 *  fallback. POST (mutating) routes require NIP-98 admin auth; GET routes are open. */
export function createDevEditorRouter(): Router {
  const r = Router();
  // Raw body for binary uploads (.glb / .zip). The global express.json() ignores
  // non-JSON content-types, so the stream is still intact for this to read.
  const RAW = raw({ type: () => true, limit: "96mb" });
  const ok = (res: Response, obj: unknown = { ok: true }) => res.json(obj);
  const bad = (res: Response, code: number, msg: string) => res.status(code).type("text/plain").send(msg);

  // ---------- props ----------
  r.get("/__props/models", (_req, res) => {
    const dir = modelsDir();
    const files = existsSync(dir) ? readdirSync(dir).filter((f) => /\.glb$/i.test(f)) : [];
    ok(
      res,
      files.map((f) => ({ name: f.replace(/\.glb$/i, ""), model: `/models/${f}`, size: statSync(resolve(dir, f)).size })),
    );
  });
  r.post("/__props/add", requireAdmin, RAW, (req, res) => {
    let meta: Record<string, unknown>;
    try {
      meta = JSON.parse(String(req.query.meta ?? "{}"));
    } catch {
      return bad(res, 400, "bad meta");
    }
    const buf = req.body as Buffer;
    if (!Buffer.isBuffer(buf) || buf.length === 0) return bad(res, 400, "empty body");
    const id = `${slug(meta.name || "prop")}_${Date.now()}`;
    const dir = modelsDir();
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    writeFileSync(resolve(dir, `${id}.glb`), buf);
    const entry = propEntry(meta, `/models/${id}.glb`, id);
    const props = readArray<Record<string, unknown>>(pub("props.json"));
    props.push(entry);
    writeArray(pub("props.json"), props);
    ok(res, { ok: true, id, model: entry.model, name: entry.name });
  });
  r.post("/__props/place", requireAdmin, (req, res) => {
    const b = body(req);
    const model = String(b.model || "");
    if (!/^\/models\/[\w.-]+\.glb$/i.test(model)) return bad(res, 400, "bad model");
    const id = `${slug(b.name || model.split("/").pop())}_${Date.now()}`;
    const entry = propEntry(b, model, id);
    const props = readArray<Record<string, unknown>>(pub("props.json"));
    props.push(entry);
    writeArray(pub("props.json"), props);
    ok(res, { ok: true, id, model: entry.model, name: entry.name });
  });
  r.post("/__props/update", requireAdmin, (req, res) => {
    const patch = body(req);
    const key = String(patch.id ?? "");
    const props = readArray<Record<string, unknown>>(pub("props.json"));
    const e = props.find((p) => p.id === key || p.model === key);
    if (!e) return bad(res, 404, "no such prop");
    for (const f of ["name", "x", "z", "scale", "rotationY"]) {
      if (patch[f] !== undefined) e[f] = f === "name" ? String(patch[f]) : Number(patch[f]);
    }
    if (patch.collisionRadius !== undefined) {
      const cr = Number(patch.collisionRadius);
      if (cr > 0) e.collisionRadius = cr;
      else delete e.collisionRadius;
    }
    if (!e.id) e.id = key;
    writeArray(pub("props.json"), props);
    ok(res, { ok: true, id: e.id });
  });
  r.post("/__props/delete", requireAdmin, (req, res) => {
    const b = body(req);
    const key = String(b.id ?? "");
    const props = readArray<Record<string, unknown>>(pub("props.json"));
    const e = props.find((p) => p.id === key || p.model === key);
    if (!e) return bad(res, 404, "no such prop");
    const kept = props.filter((p) => p !== e);
    writeArray(pub("props.json"), kept);
    const model = String(e.model || "");
    if (b.deleteFile && model && !kept.some((p) => p.model === model)) {
      const file = resolve(modelsDir(), model.replace(/^\/models\//, ""));
      if (existsSync(file) && !relative(modelsDir(), file).startsWith("..")) {
        try {
          unlinkSync(file);
        } catch {
          /* leave the file if it can't be removed */
        }
      }
    }
    deleteSpawnersForOwners([key, String(e.id || ""), model]);
    ok(res);
  });

  // ---------- characters (defs + placements) ----------
  r.get("/__char/defs", (_req, res) => ok(res, readArray(pub("characters.json"))));
  r.get("/__char/placements", (_req, res) => ok(res, readArray(pub("npcs.json"))));
  r.post("/__char/import", requireAdmin, RAW, (req, res) => {
    const name = slug(req.query.name || "character");
    const buf = req.body as Buffer;
    if (!Buffer.isBuffer(buf) || buf.length === 0) return bad(res, 400, "empty body");
    const base = charDir();
    if (!existsSync(base)) mkdirSync(base, { recursive: true });
    const id = `${name}_${Date.now()}`;
    const outDir = resolve(base, id);
    mkdirSync(outDir, { recursive: true });
    const zipPath = resolve(base, `${id}.zip`);
    writeFileSync(zipPath, buf);
    try {
      execFileSync("unzip", ["-o", "-j", zipPath, "-d", outDir], { stdio: "ignore" });
    } catch {
      return bad(res, 500, "unzip failed (is `unzip` installed?)");
    } finally {
      try {
        unlinkSync(zipPath);
      } catch {
        /* leave the temp zip */
      }
    }
    const glbs = readdirSync(outDir).filter((f) => /\.glb$/i.test(f));
    if (!glbs.length) return bad(res, 400, "no .glb files in zip");
    const files = glbs.map((f) => {
      const c = classifyGlb(f);
      return { name: f, path: `/models/characters/${id}/${f}`, kind: c.kind, clip: c.clip, size: statSync(resolve(outDir, f)).size };
    });
    ok(res, { ok: true, id, dir: `/models/characters/${id}`, files });
  });
  r.post("/__char/save", requireAdmin, (req, res) => {
    const def = body(req);
    if (!def.id || !def.baseModel) return bad(res, 400, "missing id/baseModel");
    const defs = readArray<Record<string, unknown>>(pub("characters.json"));
    const i = defs.findIndex((d) => d.id === def.id);
    if (i >= 0) defs[i] = def;
    else defs.push(def);
    writeArray(pub("characters.json"), defs);
    ok(res, { ok: true, id: def.id });
  });
  r.post("/__char/def-delete", requireAdmin, (req, res) => {
    const b = body(req);
    const id = String(b.id || "");
    if (!id) return bad(res, 400, "missing id");
    const defs = readArray<Record<string, unknown>>(pub("characters.json"));
    writeArray(pub("characters.json"), defs.filter((d) => d.id !== id));
    if (b.deleteFiles) {
      const dir = resolve(charDir(), id);
      if (existsSync(dir) && !relative(charDir(), dir).startsWith("..")) rmSync(dir, { recursive: true, force: true });
    }
    ok(res);
  });
  r.post("/__char/place", requireAdmin, (req, res) => {
    const b = body(req);
    const defId = String(b.defId || "");
    if (!defId) return bad(res, 400, "missing defId");
    const id = `npc_${Date.now()}`;
    const placement: Record<string, unknown> = {
      id,
      defId,
      x: Number(b.x) || 0,
      z: Number(b.z) || 0,
      rotationY: Number(b.rotationY) || 0,
      scale: Math.max(0.05, Number(b.scale) || 1),
      ...(b.brain ? { brain: String(b.brain) } : {}),
      ...(b.stats && typeof b.stats === "object" ? { stats: b.stats } : {}),
    };
    const npcs = readArray<Record<string, unknown>>(pub("npcs.json"));
    npcs.push(placement);
    writeArray(pub("npcs.json"), npcs);
    ok(res, { ok: true, id });
  });
  r.post("/__char/placement-update", requireAdmin, (req, res) => {
    const patch = body(req);
    const npcs = readArray<Record<string, unknown>>(pub("npcs.json"));
    const p = npcs.find((n) => n.id === String(patch.id ?? ""));
    if (!p) return bad(res, 404, "no such placement");
    for (const f of ["x", "z", "rotationY", "scale"]) if (patch[f] !== undefined) p[f] = Number(patch[f]);
    if (patch.brain !== undefined) p.brain = String(patch.brain);
    if (patch.stats && typeof patch.stats === "object") p.stats = patch.stats;
    writeArray(pub("npcs.json"), npcs);
    ok(res);
  });
  r.post("/__char/placement-delete", requireAdmin, (req, res) => {
    const b = body(req);
    const npcs = readArray<Record<string, unknown>>(pub("npcs.json"));
    writeArray(pub("npcs.json"), npcs.filter((n) => n.id !== String(b.id ?? "")));
    ok(res);
  });

  // ---------- items ----------
  r.get("/__items/defs", (_req, res) => ok(res, readArray(pub("items.json"))));
  r.post("/__items/upload", requireAdmin, RAW, (req, res) => {
    const kind = req.query.kind === "model" ? "model" : "icon";
    const base = slug(req.query.name || "item");
    const rawExt = (String(req.query.filename || "").match(/\.[a-z0-9]+$/i)?.[0] || "").toLowerCase();
    const ext = kind === "model" ? ".glb" : [".png", ".jpg", ".jpeg", ".webp"].includes(rawExt) ? rawExt : ".png";
    const buf = req.body as Buffer;
    if (!Buffer.isBuffer(buf) || !buf.length) return bad(res, 400, "empty body");
    const dir = itemAssetsDir();
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    const file = `${base}_${kind}_${Date.now()}${ext}`;
    writeFileSync(resolve(dir, file), buf);
    ok(res, { ok: true, url: `/items/${file}` });
  });
  r.post("/__items/save", requireAdmin, (req, res) => {
    const raw = body(req);
    const id = slug(raw.id || raw.name || "item").slice(0, 48);
    if (!id) return bad(res, 400, "missing id");
    const entry: Record<string, unknown> = {
      id,
      name: String(raw.name || id).slice(0, 48),
      stack: Math.max(1, Math.min(999, Math.round(Number(raw.stack) || 99))),
      worldScale: Math.max(0.05, Math.min(20, Number(raw.worldScale) || 1.2)),
    };
    if (raw.description) entry.description = String(raw.description).slice(0, 500);
    if (raw.icon) entry.icon = String(raw.icon);
    if (raw.model) entry.model = String(raw.model);
    if (raw.community && typeof raw.community === "object") entry.community = raw.community;
    const items = readArray<Record<string, unknown>>(pub("items.json"));
    const i = items.findIndex((x) => x.id === id);
    if (i >= 0) items[i] = entry;
    else items.push(entry);
    writeArray(pub("items.json"), items);
    ok(res, { ok: true, item: entry });
  });
  r.post("/__items/delete", requireAdmin, (req, res) => {
    const id = String(body(req).id || "");
    const items = readArray<Record<string, unknown>>(pub("items.json"));
    writeArray(pub("items.json"), items.filter((x) => x.id !== id));
    ok(res);
  });

  // ---------- structures (library defs + destruction loot) ----------
  r.get("/__structures/defs", (_req, res) => ok(res, readArray(pub("structures-lib.json"))));
  r.get("/__structures/list", (_req, res) => ok(res, readObject(pub("structures.json"))));
  r.post("/__structures/upload", requireAdmin, RAW, (req, res) => {
    const base = slug(req.query.name || "structure");
    const buf = req.body as Buffer;
    if (!Buffer.isBuffer(buf) || !buf.length) return bad(res, 400, "empty body");
    const dir = modelsDir();
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    const file = `${base}_${Date.now()}.glb`;
    writeFileSync(resolve(dir, file), buf);
    ok(res, { ok: true, model: `/models/${file}` });
  });
  // One route handles BOTH the library-def save ({id, model}) and the per-kind
  // loot-table save ({kind, loot}) — the Vite plugin registers the same path twice
  // (the second is unreachable there); here we branch on the body shape.
  r.post("/__structures/save", requireAdmin, (req, res) => {
    const b = body(req);
    if (b.kind) {
      const kind = String(b.kind);
      const loot = Array.isArray(b.loot)
        ? (b.loot as Record<string, unknown>[]).slice(0, 20).map((e) => ({
            item: String(e.item || "log"),
            amount: Math.max(0, Math.round(Number(e.amount) || 0)),
            probability: Math.max(0, Math.min(1, Number(e.probability) || 0)),
          }))
        : [];
      const all = readObject<Record<string, Record<string, unknown>>>(pub("structures.json"));
      const next: Record<string, unknown> = { ...(all[kind] ?? {}), loot };
      if ("mask" in b) {
        const mask = sanitizeStructureMask(b.mask);
        if (mask) next.mask = mask;
        else delete next.mask; // mask cleared in the editor
      }
      all[kind] = next;
      writeObject(pub("structures.json"), all);
      return ok(res, { ok: true, kind, count: loot.length, mask: !!next.mask });
    }
    if (!b.id || !b.model) return bad(res, 400, "missing id/model");
    const defs = readArray<Record<string, unknown>>(pub("structures-lib.json"));
    const i = defs.findIndex((d) => d.id === b.id);
    if (i >= 0) defs[i] = b;
    else defs.push(b);
    writeArray(pub("structures-lib.json"), defs);
    ok(res, { ok: true, id: b.id });
  });
  r.post("/__structures/delete", requireAdmin, (req, res) => {
    const b = body(req);
    const id = String(b.id || "");
    const defs = readArray<Record<string, unknown>>(pub("structures-lib.json"));
    const gone = defs.find((d) => d.id === id);
    writeArray(pub("structures-lib.json"), defs.filter((d) => d.id !== id));
    const model = String(gone?.model || "");
    if (b.deleteFiles && model.startsWith("/models/")) {
      const f = resolve(modelsDir(), model.replace(/^\/models\//, ""));
      if (existsSync(f) && !relative(modelsDir(), f).startsWith("..")) {
        try {
          unlinkSync(f);
        } catch {
          /* leave the file */
        }
      }
    }
    ok(res);
  });

  // ---------- spawners ----------
  r.get("/__spawners/list", (_req, res) => ok(res, readSpawners()));
  r.post("/__spawners/save", requireAdmin, (req, res) => {
    const entry = normalizeSpawner(body(req));
    if (!entry) return bad(res, 400, "missing id or ownerId");
    const list = readSpawners();
    const i = list.findIndex((x) => x.id === entry.id);
    if (i >= 0) list[i] = entry;
    else list.push(entry);
    writeArray(pub("spawners.json"), list);
    ok(res, { ok: true, id: entry.id });
  });
  r.post("/__spawners/delete", requireAdmin, (req, res) => {
    const b = body(req);
    const id = String(b.id ?? "");
    const ownerId = String(b.ownerId ?? "");
    if (!id && !ownerId) return bad(res, 400, "missing id or ownerId");
    writeArray(pub("spawners.json"), readSpawners().filter((x) => x.id !== id && x.ownerId !== ownerId));
    ok(res);
  });

  // ---------- waves ----------
  r.get("/__waves/list", (_req, res) => ok(res, readArray(pub("waves.json"))));
  r.post("/__waves/save", requireAdmin, (req, res) => {
    const arr = req.body;
    if (!Array.isArray(arr)) return bad(res, 400, "expected an array of waves");
    writeArray(pub("waves.json"), arr as unknown[]);
    ok(res, { ok: true, count: arr.length });
  });

  // ---------- resource drop config ----------
  r.get("/__resources/list", (_req, res) => ok(res, readObject(pub("resources.json"))));
  r.post("/__resources/save", requireAdmin, (req, res) => {
    const b = body(req);
    const kind = String(b.kind || "");
    if (!kind) return bad(res, 400, "missing kind");
    const drops = readObject<Record<string, Record<string, unknown>>>(pub("resources.json"));
    drops[kind] = {
      item: String(b.item || "stone"),
      amount: Math.max(0, Number(b.amount) || 0),
      trigger: b.trigger === "kill" ? "kill" : "hit",
      hp: Math.max(1, Math.round(Number(b.hp) || (kind === "tree" ? 60 : 560))),
    };
    writeObject(pub("resources.json"), drops);
    ok(res, { ok: true, kind });
  });

  // ---------- entity features (HP / brain / stats / drops) ----------
  r.get("/__features/list", (_req, res) => ok(res, readFeatures()));
  r.post("/__features/save", requireAdmin, (req, res) => {
    const b = body(req);
    const scope = b.scope === "instance" ? "instances" : "defaults";
    const key = String(b.key || "");
    if (!key) return bad(res, 400, "missing key");
    const manifest = readFeatures();
    const bucket = { ...(manifest[scope] ?? {}) };
    bucket[key] = sanitizeFeature((b.config && typeof b.config === "object" ? b.config : b) as Record<string, unknown>);
    manifest[scope] = bucket;
    writeFeatures(manifest);
    ok(res, { ok: true, scope, key });
  });
  r.post("/__features/delete", requireAdmin, (req, res) => {
    const b = body(req);
    const scope = b.scope === "instance" ? "instances" : "defaults";
    const key = String(b.key || "");
    if (!key) return bad(res, 400, "missing key");
    const manifest = readFeatures();
    const bucket = { ...(manifest[scope] ?? {}) };
    delete bucket[key];
    manifest[scope] = bucket;
    writeFeatures(manifest);
    ok(res, { ok: true, scope, key });
  });

  // ---------- content pending (git badges) — best-effort, empty when unavailable ----------
  r.get("/__content/pending", (_req, res) => ok(res, { characters: [], structures: [], items: [] }));

  return r;
}

// --- file-scoped helpers that need the resolved public dir ---
type FeatureManifest = {
  defaults?: Record<string, unknown>;
  instances?: Record<string, unknown>;
} & Record<"defaults" | "instances", Record<string, unknown> | undefined>;

function readFeatures(): FeatureManifest {
  return readObject<FeatureManifest>(pub("entity-features.json"));
}
function writeFeatures(m: FeatureManifest): void {
  writeObject(pub("entity-features.json"), { defaults: m.defaults ?? {}, instances: m.instances ?? {} });
}
function readSpawners(): Record<string, unknown>[] {
  return readArray<Record<string, unknown>>(pub("spawners.json"))
    .map((s) => normalizeSpawner(s))
    .filter((s): s is Record<string, unknown> => Boolean(s));
}
function deleteSpawnersForOwners(ownerIds: string[]): void {
  const owners = new Set(ownerIds.filter(Boolean));
  if (!owners.size) return;
  writeArray(pub("spawners.json"), readSpawners().filter((s) => !owners.has(String(s.ownerId))));
}
function propEntry(meta: Record<string, unknown>, model: string, id: string): Record<string, unknown> {
  const entry: Record<string, unknown> = {
    id,
    name: String(meta.name ?? id),
    model,
    x: Number(meta.x) || 0,
    z: Number(meta.z) || 0,
    scale: Number(meta.scale) || 1,
    rotationY: Number(meta.rotationY) || 0,
  };
  const cr = Number(meta.collisionRadius);
  if (cr > 0) entry.collisionRadius = cr;
  return entry;
}
