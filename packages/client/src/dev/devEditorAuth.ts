// On a deployed dev server (a single-port, built client — e.g. game.gorilator.io
// with GORILATOR_DEV=1), the in-game Dev Mode editor's persistence calls hit the
// game server's admin-gated `/__*/` routes (see packages/server/src/dev/editorApi).
// This installs a one-time fetch shim that signs those MUTATING, same-origin calls
// with a NIP-98 Authorization header (the logged-in admin's key), so the server
// accepts them. Reads/GETs are left untouched (open on the server).
//
// Local Vite dev does NOT use this — its `/__*/` endpoints are unauthenticated.
import { nip98AuthHeader } from "../net/nostr";

let installed = false;

/** Idempotently wrap window.fetch to attach a NIP-98 token to same-origin,
 *  mutating `/__*` requests. Signing failures (not logged in / no signer) fall
 *  through unsigned — the server then replies 401 and the editor surfaces it. */
export function installDevEditorAuth(): void {
  if (installed || typeof window === "undefined") return;
  installed = true;
  const orig = window.fetch.bind(window);
  window.fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    if (typeof input === "string") {
      try {
        const u = new URL(input, location.origin);
        const method = (init?.method ?? "GET").toUpperCase();
        if (
          u.origin === location.origin &&
          u.pathname.startsWith("/__") &&
          method !== "GET" &&
          method !== "HEAD"
        ) {
          const header = await nip98AuthHeader(u.href, method.toLowerCase());
          const headers = new Headers(init?.headers as HeadersInit | undefined);
          if (!headers.has("authorization")) headers.set("Authorization", header);
          return orig(input, { ...(init ?? {}), headers });
        }
      } catch {
        /* not logged in / signer unavailable — send unsigned; the server 401s */
      }
    }
    return orig(input, init);
  };
}
