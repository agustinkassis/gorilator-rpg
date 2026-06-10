---
name: add-plugin
description: Create a Gorilator plugin — new brains, item behaviors, tick systems, event listeners, client models/panels, or distributable content packs — without touching packages/*/src. Use for integrations, mods, and fork customization.
---

# Create a plugin

Full guide: `docs/plugins.md`. Worked example: `plugins/example-arena/`.

1. Scaffold from the template: copy `plugins/_template/` to `plugins/<name>/`. The manifest (`plugin.json`) declares `name`, `version`, `apiVersion` (semver range against `PLUGIN_API_VERSION` from `@rpg/shared`), optional `server`/`client` entries, `content` files, and `capabilities`.
2. **Data-only plugin** (safe, no code): omit `server`/`client`, ship `content/*.json` (same shapes as `packages/client/public/*.json`). The loader feeds them through the existing live-reload content pipeline.
3. **Server entry** (`src/server.ts`): `export default { setup(ctx) { ... } }` with `ctx`:
   - `registerBrain(id, fn)` — new AI behavior, usable from any manifest's `brain` field
   - `registerItem(id, { onUse })` — item-use behavior (potion-style)
   - `registerSystem(name, fn, { phase })` — a `(state, dt)` tick system (`pre|main|post`)
   - `on(event, handler)` — `player:spawn | entity:killed | item:pickup | wave:start | wave:end | structure:destroyed | realm:end`
   - `registerContentLoader(file, apply)` — live-reloading custom JSON
4. **Client entry** (`src/client.ts`): `setup(ctx)` with `registerItemModel(id, def)`, `registerFrameSystem(name, fn)`, `registerDevPanel(spec)`.
5. Build: `pnpm build:plugins` (esbuild; `@rpg/shared` stays external). Dev: plugins are discovered from `plugins/` at room create; restart the server to pick up code changes (content live-reloads).
6. Enable/disable without deleting: root `plugins.json` allowlist (`"enabled": false` short-circuits).
7. Test it: extend the plugin's own tests or assert via `pnpm bench` (plugin systems appear as `tag:plugin:<name>` in `/api/perf` + F3).

Trust model: server plugins run with full Node privileges — treat third-party code plugins like merging a PR. Untrusted community content belongs in the data tier (JSON / kind-30333 Nostr packs).
