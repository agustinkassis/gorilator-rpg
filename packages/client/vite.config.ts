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
    },
  };
}

// @rpg/shared is consumed as its compiled output (packages/shared/dist), resolved
// via the workspace symlink + its package.json "exports". That keeps the Colyseus
// schema decorators compiled correctly by tsc, independent of esbuild's handling.
export default defineConfig({
  plugins: [modelImporter()],
  server: {
    port: 5173,
  },
});
