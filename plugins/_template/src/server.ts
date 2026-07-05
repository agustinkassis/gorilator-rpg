import type { ServerPlugin } from "@rpg/shared";

/** Minimal server plugin. See docs/plugins.md for every hook. */
const plugin: ServerPlugin = {
  setup(ctx) {
    ctx.log(`hello from ${ctx.manifest.name} (api ${ctx.apiVersion})`);

    // ctx.registerBrain("my_brain", (g, dt, state, world) => { ... });
    // ctx.registerItem("my_item", { onUse(player, slot, itemCtx) { ... } });
    // ctx.registerSystem("my_system", (state, dt) => { ... }, { phase: "main" });
    // ctx.on("entity:killed", (payload, state) => { ... });
    // ctx.registerContentLoader("./content/my-data.json", (data) => { ... });
    //
    // A pluggable game loop (API 1.1 — see plugins/la-crypta-defense):
    // ctx.registerEventModule({
    //   id: "my-event",
    //   onStart(evCtx) { evCtx.world.spawnStructure({ kind: "house", x: 0, z: 0 }); },
    //   onTick(evCtx, dt) { /* pacing; evCtx.endEvent({ result: "victory" }) when done */ },
    // });
  },
};

export default plugin;
