// Client entries are fully bundled (no bare imports resolve in the browser) —
// import only TYPES from @rpg/shared here.
import type { ClientPlugin } from "@rpg/shared";

const plugin: ClientPlugin = {
  setup(ctx) {
    ctx.log(`hello from ${ctx.manifest.name}`);

    // ctx.registerItemModel({ id: "my_item", name: "My Item", icon: "✨" });
    // ctx.registerFrameSystem("my_fx", (dt) => { ... });
    // ctx.registerDevPanel({ id: "my_panel", title: "My Panel", mount(host) { ... } });
  },
};

export default plugin;
