import { defineConfig, type Plugin, type ViteDevServer } from "vite";
import react from "@vitejs/plugin-react";
import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// Paths resolved relative to this config file (packages/landing), so they work
// regardless of the invoking cwd.
const rootDir = dirname(fileURLToPath(import.meta.url));
// The repo's CLI bootstrap installer.
const installShPath = resolve(rootDir, "../cli/install.sh");

/**
 * Publishes packages/cli/install.sh at the site root as /install.sh, so a fresh box can run
 *   curl -fsSL <site>/install.sh | sudo bash
 * packages/cli/install.sh stays the single source of truth: served live in dev and copied
 * into the build output (dist/install.sh) on `vite build` — no duplicate in public/.
 */
function installScript(): Plugin {
  return {
    name: "gorilator-install-script",
    configureServer(server: ViteDevServer) {
      server.middlewares.use("/install.sh", (_req, res) => {
        if (!existsSync(installShPath)) {
          res.statusCode = 404;
          res.end("install.sh not found");
          return;
        }
        res.setHeader("content-type", "text/x-shellscript; charset=utf-8");
        res.end(readFileSync(installShPath));
      });
    },
    generateBundle() {
      if (!existsSync(installShPath)) {
        this.error(`install.sh not found at ${installShPath}; cannot publish /install.sh`);
      }
      this.emitFile({ type: "asset", fileName: "install.sh", source: readFileSync(installShPath) });
    },
  };
}

export default defineConfig({
  plugins: [react(), installScript()],
  build: {
    rollupOptions: {
      // Multi-page: the landing (index.html) + the live stats dashboard (stats.html).
      input: {
        index: resolve(rootDir, "index.html"),
        stats: resolve(rootDir, "stats.html"),
      },
    },
  },
});
