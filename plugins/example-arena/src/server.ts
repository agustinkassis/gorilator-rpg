import { AnimState, type Enemy, type ServerPlugin } from "@rpg/shared";

/**
 * example-arena — the worked example exercising every server plugin seam:
 *
 *  - registerBrain  "kamikaze": rushes the nearest player at high speed and
 *    detonates on contact (AoE damage), removing itself. Usable from any
 *    manifest `brain` field (entity-features, npcs, spawners, waves).
 *  - registerItem   "arena_horn": consuming it taunts the realm in chat and
 *    heals the blower a little (the crowd's favour).
 *  - registerSystem "killstreak": tracks kills per realm and announces every
 *    5th one (a pure (state, dt) system, visible as plugin:example-arena:… in
 *    /api/perf and the F3 overlay).
 *  - on("entity:killed" / "wave:start" / "wave:end"): the kill/wave feed.
 *  - content/waves.json: replaces wave 2 with a kamikaze pack (additive custom
 *    waves through the same live-reload pipeline as public/waves.json).
 */

const KAMIKAZE_SPEED = 7; // units/sec — faster than a goblin, slower than a sprinting player
const BLAST_RADIUS = 3;
const BLAST_DAMAGE = 12;
const HORN_HEAL = 10;

let kills = 0;
let announcedAt = 0;

const plugin: ServerPlugin = {
  setup(ctx) {
    ctx.registerBrain("kamikaze", (g: Enemy, dt, state, world) => {
      const near = world.nearestPlayer(g);
      if (!near) {
        g.state = AnimState.IDLE;
        return;
      }
      if (near.d <= 1.2) {
        // Detonate: hurt everyone in the blast (the host's death-edge pass turns
        // any resulting deaths into entity:killed events automatically).
        state.players.forEach((p) => {
          if (p.godMode) return;
          const d = Math.hypot(p.x - g.x, p.z - g.z);
          if (d <= BLAST_RADIUS) p.hp = Math.max(0, p.hp - BLAST_DAMAGE);
        });
        g.hp = 0;
        g.state = AnimState.DEAD;
        g.respawnTimer = 1; // corpse clears on the next AI sweep
        return;
      }
      world.stepToward(g, near.p.x, near.p.z, KAMIKAZE_SPEED, dt);
      g.state = AnimState.WALK;
    });

    ctx.registerItem("arena_horn", {
      onUse(player, _slot, item) {
        item.consume();
        item.heal(player, HORN_HEAL);
        item.broadcast("chat", {
          playerId: "",
          name: "📯 Arena",
          text: `${player.name || "A gladiator"} sounds the horn — the crowd roars!`,
        });
      },
    });

    ctx.registerSystem("killstreak", (state) => {
      if (kills >= announcedAt + 5) {
        announcedAt = kills;
        ctx.log(`the realm reaches ${kills} kills`);
      }
      void state;
    });

    ctx.on("entity:killed", (payload) => {
      kills += 1;
      ctx.log(`kill #${kills}: ${String(payload.victimKind)} ${String(payload.victimId)}`);
    });
    ctx.on("wave:start", (payload) => ctx.log(`wave ${String(payload.wave)} begins`));
    ctx.on("wave:end", (payload) => ctx.log(`wave ${String(payload.wave)} survived`));
    // API 1.1 lifecycle: hear the realm's event module come and go. (This
    // manifest still declares ^1.0.0 — living proof the 1.1 bump is additive.)
    ctx.on("event:start", (payload) => ctx.log(`event "${String(payload.eventId)}" started`));
    ctx.on("event:end", (payload) =>
      ctx.log(`event "${String(payload.eventId)}" ended (${String(payload.result)})`),
    );

    ctx.log("arena ready — kamikaze brain, arena_horn item, kill feed");
  },
};

export default plugin;
