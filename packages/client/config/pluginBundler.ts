import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { extname, join } from "node:path";
import type { Plugin, ViteDevServer } from "vite";

/**
 * pluginBundler — surfaces plugins/ to the game client without forking core.
 *
 * dev:   GET /plugins/manifest.json → enabled manifests + their client entry URLs
 *        GET /plugins/<name>/client.js → the plugin's built dist/client.js
 *        GET /plugins/<name>/assets/* → the plugin's assets dir
 * build: the same manifest + files are emitted into the client bundle, so a
 *        deployed realm serves them statically from the same origin.
 *
 * Plugins are built separately (`pnpm build:plugins` — esbuild, @rpg/shared
 * external on the server side, bundled for the client side); this plugin only
 * SERVES the built artefacts. Discovery mirrors the server loader: plugins/<dir>
 * with a plugin.json, minus realm.json's plugins.disabled.
 */

interface ManifestEntry {
  manifest: Record<string, unknown> & { name: string; client?: string };
  dir: string;
  clientUrl?: string;
}

const MIME: Record<string, string> = {
  ".js": "text/javascript",
  ".json": "application/json",
  ".glb": "model/gltf-binary",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".webp": "image/webp",
  ".svg": "image/svg+xml",
  ".mp3": "audio/mpeg",
  ".ogg": "audio/ogg",
};

function discover(rootDir: string): ManifestEntry[] {
  const pluginsDir = join(rootDir, "plugins");
  if (!existsSync(pluginsDir)) return [];

  let disabled = new Set<string>();
  try {
    const realmFile = join(rootDir, "realm.json");
    if (existsSync(realmFile)) {
      const realm = JSON.parse(readFileSync(realmFile, "utf8"));
      if (Array.isArray(realm?.plugins?.disabled)) disabled = new Set(realm.plugins.disabled.map(String));
    }
  } catch {
    /* unreadable realm.json → nothing disabled */
  }

  const entries: ManifestEntry[] = [];
  for (const name of readdirSync(pluginsDir)) {
    const dir = join(pluginsDir, name);
    const manifestFile = join(dir, "plugin.json");
    try {
      if (!statSync(dir).isDirectory() || !existsSync(manifestFile)) continue;
      const manifest = JSON.parse(readFileSync(manifestFile, "utf8"));
      if (!manifest?.name || manifest.name.startsWith("_")) continue;
      if (manifest.enabled === false || disabled.has(manifest.name)) continue;
      const built = manifest.client ? join(dir, String(manifest.client)) : null;
      entries.push({
        manifest,
        dir,
        clientUrl: built && existsSync(built) ? `/plugins/${manifest.name}/client.js` : undefined,
      });
    } catch {
      /* malformed manifest → skip, the server loader logs the warning */
    }
  }
  return entries;
}

export function pluginBundler(rootDir: string): Plugin {
  return {
    name: "gorilator-plugin-bundler",

    configureServer(server: ViteDevServer) {
      server.middlewares.use("/plugins", (req, res) => {
        const url = (req.url ?? "").split("?")[0];
        if (url === "/manifest.json") {
          const plugins = discover(rootDir).map(({ manifest, clientUrl }) => ({ manifest, clientUrl }));
          res.setHeader("content-type", "application/json");
          res.end(JSON.stringify({ plugins }));
          return;
        }
        // /<name>/client.js or /<name>/assets/<path>
        const match = url.match(/^\/([^/]+)\/(client\.js|assets\/.+)$/);
        if (match) {
          const entry = discover(rootDir).find((e) => e.manifest.name === match[1]);
          if (entry) {
            const file =
              match[2] === "client.js"
                ? join(entry.dir, String(entry.manifest.client))
                : join(entry.dir, match[2]);
            if (existsSync(file) && statSync(file).isFile()) {
              res.setHeader("content-type", MIME[extname(file)] ?? "application/octet-stream");
              res.end(readFileSync(file));
              return;
            }
          }
        }
        res.statusCode = 404;
        res.end("not found");
      });
    },

    generateBundle() {
      const entries = discover(rootDir);
      this.emitFile({
        type: "asset",
        fileName: "plugins/manifest.json",
        source: JSON.stringify({
          plugins: entries.map(({ manifest, clientUrl }) => ({ manifest, clientUrl })),
        }),
      });
      for (const entry of entries) {
        if (entry.clientUrl) {
          this.emitFile({
            type: "asset",
            fileName: `plugins/${entry.manifest.name}/client.js`,
            source: readFileSync(join(entry.dir, String(entry.manifest.client))),
          });
        }
        const assetsDir = join(entry.dir, "assets");
        if (existsSync(assetsDir)) {
          const walk = (dir: string, prefix: string) => {
            for (const f of readdirSync(dir)) {
              const full = join(dir, f);
              if (statSync(full).isDirectory()) walk(full, `${prefix}${f}/`);
              else
                this.emitFile({
                  type: "asset",
                  fileName: `plugins/${entry.manifest.name}/assets/${prefix}${f}`,
                  source: readFileSync(full),
                });
            }
          };
          walk(assetsDir, "");
        }
      }
    },
  };
}
