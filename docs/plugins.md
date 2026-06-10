# Plugins — extend Gorilator without touching the core

Gorilator has a **two-tier** extensibility model:

| Tier | What | Trust | Ships as |
| --- | --- | --- | --- |
| **Data** | entities, NPCs, waves, items, drops, props — pure JSON | safe from any author (parsed, never executed) | content manifests, plugin `content/`, or Nostr kind-30333 "realm packs" |
| **Code** | AI brains, item behaviors, tick systems, event listeners, client models/panels | full Node privileges — trust the author like merging a PR | `plugins/<name>/` or npm `gorilator-plugin-*` |

Everything compiles against the frozen **plugin API** exported from
`@rpg/shared` (`packages/shared/src/plugin/types.ts`), versioned independently
as `PLUGIN_API_VERSION` (currently `1.0.0`): additive hooks bump minor, breaking
changes bump major, and the host refuses plugins targeting another major.

The worked example — **`plugins/example-arena/`** — exercises every seam in
~100 lines and has an integration test
(`packages/server/src/systems/plugins/plugins.test.ts`).

## Quick start

```bash
cp -r plugins/_template plugins/my-plugin
# edit plugins/my-plugin/plugin.json (name, apiVersion, entries)
# write src/server.ts and/or src/client.ts
pnpm build:plugins          # esbuild → dist/server.js + dist/client.js
pnpm dev                    # the server logs: [plugins] my-plugin@x.y.z loaded
```

Plugin dev loop: `pnpm build:plugins --watch` rebuilds on change; restart the
server to re-run `setup()` (content JSON live-reloads without a restart).

## CLI

The npm `gorilator` CLI manages all of this without hand-editing files
(`gorilator help plugin` for details):

```bash
gorilator plugin list            # discovered plugins (plugins/ + npm) with enabled state
gorilator plugin disable <name>  # add to realm.json plugins.disabled
gorilator plugin enable <name>   # remove from realm.json plugins.disabled
gorilator plugin add <path>      # copy a local plugin dir into plugins/ (--link symlinks)
gorilator plugin add <npub>      # trust a realm-pack author → REALM_PACK_AUTHORS in .env
```

## plugin.json

```json
{
  "name": "my-plugin",
  "version": "0.1.0",
  "apiVersion": "^1.0.0",
  "description": "What it does",
  "author": "npub1… or a name",
  "server": "./dist/server.js",
  "client": "./dist/client.js",
  "content": ["./content/waves.json"],
  "assets": "./assets",
  "capabilities": ["brain", "item", "system", "event"],
  "enabled": true
}
```

Every field except `name`/`version`/`apiVersion` is optional. A manifest with
only `content` is a **data plugin** — no code ever runs. Disable any plugin
without deleting it via `realm.json`:

```json
{ "plugins": { "disabled": ["my-plugin"] } }
```

## Server hooks (`src/server.ts`)

```ts
import type { ServerPlugin } from "@rpg/shared";

const plugin: ServerPlugin = {
  setup(ctx) {
    // A new AI brain — its id becomes valid in EVERY manifest `brain` field
    // (entity-features.json, npcs.json, spawners.json, waves.json):
    ctx.registerBrain("kamikaze", (g, dt, state, world) => {
      const near = world.nearestPlayer(g);
      if (near) world.stepToward(g, near.p.x, near.p.z, 7, dt);
    });

    // Item-use behavior (potion-style). Registering a builtin id overrides it.
    ctx.registerItem("arena_horn", {
      onUse(player, slot, item) {
        item.consume();
        item.heal(player, 10);
        item.broadcast("chat", { name: "📯", text: "the crowd roars!" });
      },
    });

    // A tick system — pure (state, dt), runs in the 20Hz loop inside a perf
    // span (shows as plugin:my-plugin:<name> in /api/perf + the F3 overlay):
    ctx.registerSystem("my_system", (state, dt) => { /* … */ }, { phase: "main" });

    // Lifecycle events, fired at the existing emit sites:
    // player:spawn · entity:killed · item:pickup · wave:start · wave:end ·
    // structure:destroyed · realm:end
    ctx.on("entity:killed", (payload, state) => { /* kill feed, webhooks, … */ });

    // Your own live-reloading JSON (same watchFile pipeline as the builtins):
    ctx.registerContentLoader("./content/my-data.json", (data) => { /* … */ });
  },
};
export default plugin;
```

Rules for brains/systems: stay **pure over `(state, dt)`** — steer entities, set
timers; the host's combat systems own damage resolution and the death-edge pass
turns any `hp <= 0` you cause into `entity:killed` events automatically. A
throwing plugin (system, brain, or event handler) is logged and skipped — it
cannot take down the tick.

`@rpg/shared` stays **external** in the server bundle, so your plugin and the
host share one schema identity. New *synced* fields still require a core schema
change (`@type` + shared rebuild) — keep plugin state module-local or reuse the
existing synced fields (`brain`, `modelId`, `displayName` already sync).

## Client hooks (`src/client.ts`)

```ts
import type { ClientPlugin } from "@rpg/shared"; // TYPES ONLY — client bundles are self-contained

const plugin: ClientPlugin = {
  setup(ctx) {
    ctx.registerItemModel({ id: "arena_horn", name: "Arena Horn", icon: "📯" });
    ctx.registerFrameSystem("fx", (dt) => { /* per-frame, perf-spanned */ });
    ctx.registerDevPanel({ id: "p", title: "My Panel", mount(host) { /* … */ } });
  },
};
export default plugin;
```

Client entries are fully bundled (a browser can't resolve bare imports), served
at `/plugins/<name>/client.js` by the Vite `pluginBundler` in dev and emitted
into the client build for deploys. Assets in `assets/` are served at
`/plugins/<name>/assets/*`. Dev panels appear under the 🔌 button (dev builds).

## Data plugins & Nostr realm packs

Content files in `content/` use the same shapes as `packages/client/public/*.json`
(see `.claude/context/content-manifests.md`). Currently routed additively:
**waves** (`content/waves.json` merges with the authored waves; dev-authored
numbers win). More content types route through `registerContentLoader` today and
will gain first-class additive merging as needed.

Over the wire: a pack author publishes a **kind-30333** event whose content is
`{"type": "waves", "data": [ … ]}`. A server operator opts in with:

```bash
REALM_PACK_AUTHORS=npub1…,npub1…       # trusted authors (npub or hex)
REALM_PACK_RELAYS=wss://relay.damus.io # optional relay override
```

Packs are cached in `.gorilator-packs/` and fed through the same live-reload
pipeline. Data packs are **pure JSON — validated, never executed** — which is
why they're the right tier for untrusted community content (the same trust
model as the kind-30333 community entities in `docs/community-entities` spec).

## Publishing

- **In-repo / fork**: keep the plugin in `plugins/` — that's the fork-safe zone
  (`node scripts/check-fork.mjs` verifies you never touched `packages/*/src`).
- **npm**: publish as `gorilator-plugin-<name>` with `dist/` + `plugin.json`;
  installed packages are discovered by that name prefix in `node_modules`.
- Version your plugin with SemVer; pin `apiVersion` to `"^1.0.0"`. When
  `PLUGIN_API_VERSION` bumps major, update and re-test.

## realm.json (per-realm / per-fork config)

```json
{
  "name": "my-realm",
  "plugins": { "disabled": ["example-arena"] },
  "tuning": { "waveSizeBase": 8, "playerMaxHp": 150 }
}
```

`tuning` accepts every live Gameplay-Options knob (`DevTuningKey` — wave pacing,
player/enemy stats, damage divisor…), seeding it at room create. Absent file =
stock behavior.
