import { defineConfig, type Plugin, type ViteDevServer } from "vite";
import { writeFileSync, readFileSync, existsSync, mkdirSync } from "fs";
import { resolve } from "path";

/**
 * Dev-only endpoint for the in-game model importer. POST the raw .glb as the body
 * with `?meta=<json>` describing it; this writes the model into public/models and
 * appends an entry to public/props.json (which both the client renders and the
 * server reads for collision). That's what "add it to the codebase" means here.
 */
function modelImporter(): Plugin {
  return {
    name: "rpg-model-importer",
    configureServer(server: ViteDevServer) {
      server.middlewares.use("/__props/add", (req, res) => {
        if (req.method !== "POST") {
          res.statusCode = 405;
          res.end("POST only");
          return;
        }
        const root = server.config.root; // packages/client
        const url = new URL(req.url || "", "http://localhost");
        let meta: Record<string, unknown>;
        try {
          meta = JSON.parse(url.searchParams.get("meta") || "{}");
        } catch {
          res.statusCode = 400;
          res.end("bad meta");
          return;
        }
        const chunks: Buffer[] = [];
        req.on("data", (c: Buffer) => chunks.push(c));
        req.on("end", () => {
          try {
            const buf = Buffer.concat(chunks);
            if (buf.length === 0) {
              res.statusCode = 400;
              res.end("empty body");
              return;
            }
            const base =
              String(meta.name || "prop")
                .toLowerCase()
                .replace(/[^a-z0-9_-]+/g, "_")
                .replace(/^_+|_+$/g, "") || "prop";
            const modelsDir = resolve(root, "public/models");
            if (!existsSync(modelsDir)) mkdirSync(modelsDir, { recursive: true });
            const file = `${base}_${Date.now()}.glb`;
            writeFileSync(resolve(modelsDir, file), buf);

            const propsPath = resolve(root, "public/props.json");
            const props = existsSync(propsPath)
              ? JSON.parse(readFileSync(propsPath, "utf8"))
              : [];
            const entry: Record<string, unknown> = {
              name: meta.name ?? base,
              model: `/models/${file}`,
              x: Number(meta.x) || 0,
              z: Number(meta.z) || 0,
              scale: Number(meta.scale) || 1,
              rotationY: Number(meta.rotationY) || 0,
            };
            const cr = Number(meta.collisionRadius);
            if (cr > 0) entry.collisionRadius = cr; // concrete → blocks movement
            props.push(entry);
            writeFileSync(propsPath, JSON.stringify(props, null, 2));

            res.setHeader("content-type", "application/json");
            res.end(JSON.stringify({ ok: true, model: entry.model, name: entry.name }));
          } catch (e) {
            res.statusCode = 500;
            res.end(String(e));
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
  plugins: [modelImporter()],
  server: {
    port: 5173,
  },
});
