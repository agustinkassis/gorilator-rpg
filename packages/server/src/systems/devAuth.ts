// Authorization for the dev_* room-message family (the in-game Dev Mode editor:
// pause/speed time, spawn/move/delete/retune entities, grant items, god mode,
// kick players, reset the realm). These mutate authoritative state for the
// whole room, so on a real server they are admin-only.
//
// Policy — FAIL CLOSED:
//   • Open to every client only when the server is *explicitly* a dev or test
//     server: NODE_ENV=development (`pnpm dev`, CLI developer mode), NODE_ENV=test
//     (vitest), or GORILATOR_TEST=1 (e2e/bench deterministic rooms).
//   • Everywhere else — NODE_ENV=production (Docker/Railway) AND the unset
//     default of a `gorilator` CLI install — dev_* requires a Nostr-verified
//     admin (ADMIN_NPUBS, same allowlist as the /api/admin/* endpoints).
//
// The self-affecting commands (dev_god, dev_give_item, dev_set_slot) get the
// SAME rule as the world-affecting ones: an immortal player or conjured items
// still corrupt the shared realm (waves, fights, drops) and persist into the
// player's server-signed save, so "it only touches me" doesn't hold.
import { isAdmin } from "./admins";

/** The slice of Player that dev authorization looks at. `pubkey` is only
 *  trusted when `nostrVerified` (the server checked the login signature). */
export interface DevSenderIdentity {
  nostrVerified: boolean;
  pubkey: string;
}

/** True when this server process accepts dev_* messages from EVERY client —
 *  i.e. it is explicitly a development or test server, never by default. */
export function devCommandsOpen(env: NodeJS.ProcessEnv = process.env): boolean {
  return (
    env.NODE_ENV === "development" ||
    env.NODE_ENV === "test" ||
    env.GORILATOR_TEST === "1"
  );
}

/** Authorize one dev_* message: open server, or a Nostr-verified admin.
 *  `env`/`adminCheck` are injectable for tests; production callers use the
 *  defaults (process.env + the ADMIN_NPUBS allowlist). */
export function canUseDevCommands(
  sender: DevSenderIdentity | undefined,
  env: NodeJS.ProcessEnv = process.env,
  adminCheck: (pubkey: string) => boolean = isAdmin,
): boolean {
  if (devCommandsOpen(env)) return true;
  return !!sender && sender.nostrVerified && adminCheck(sender.pubkey);
}
