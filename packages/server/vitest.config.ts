import { defineConfig } from "vitest/config";

// Server tests import @rpg/shared from its COMPILED dist (workspace symlink +
// package exports) — the Colyseus schema decorators only compile via tsc, never
// through Vitest's esbuild transform. `turbo run test` orders ^build first.
export default defineConfig({
  test: {
    environment: "node",
    include: ["src/**/*.test.ts"],
  },
});
