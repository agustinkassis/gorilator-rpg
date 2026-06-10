// Client side of the worked example: an item model for the arena horn (so it
// renders in the inventory/hotkey bar) and a tiny dev panel.
// Client entries are fully bundled — import only TYPES from @rpg/shared.
import type { ClientPlugin } from "@rpg/shared";

let frames = 0;

const plugin: ClientPlugin = {
  setup(ctx) {
    ctx.registerItemModel({ id: "arena_horn", name: "Arena Horn", icon: "📯", stack: 5 });

    ctx.registerFrameSystem("pulse", () => {
      frames += 1;
    });

    ctx.registerDevPanel({
      id: "arena",
      title: "Example Arena",
      mount(host) {
        const info = document.createElement("div");
        const update = () => {
          info.textContent = `plugin alive — ${frames} frames observed. Try: give yourself an arena_horn via Dev Mode, or set an entity's brain to "kamikaze".`;
        };
        update();
        const timer = window.setInterval(update, 1000);
        host.appendChild(info);
        return () => window.clearInterval(timer);
      },
    });

    ctx.log("arena client ready");
  },
};

export default plugin;
