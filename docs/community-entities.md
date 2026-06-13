# Community entities (Nostr kind 30333 + Blossom)

**Community entities** are player-published game content — a custom **character**,
**structure**, or **item** authored in Dev Mode — shared over Nostr so anyone can
discover and import them. They turn the Dev-Mode **Library** into a small content
platform with two halves: **Local** (on this machine) and **Community** (everyone's).

Unlike player saves and server discovery (which the **server** signs with `NOSTR_NSEC`),
a community entity is signed by the **author's own key** (NIP-07 / the `?mocknostr=`
dev signer). Anyone can publish; re-publishing replaces the same addressable event.

A `.glb` model is far too large for a Nostr event, so the assets are uploaded to
**Blossom** (content-addressed blob storage) and the event references their absolute
URLs + sha-256 hashes.

---

## Lifecycle

```
CREATE (Local)     Dev Mode → Library → ＋ Add → wizard (details → model → stats)
                   → writes a def to public/{characters,structures-lib,items}.json
                   → shows in the Local library as "pending" (uncommitted in git)

PUBLISH            Library card → 📡 Publish → upload each asset to Blossom (signed
                   kind-24242 auth) → sign + broadcast a kind-30333 event with the
                   author's key → the def is stamped with community provenance

BROWSE             Library → Community tab → subscribe kind-30333 → cards carry the
                   owner's kind-0 avatar

IMPORT             Community card → ＋ Add → server downloads the Blossom assets
                   locally → adds a def with community.imported = true → Local, pending

COMMIT             pending entities are committed with normal git; once in HEAD the
                   "pending" badge clears. Pending entities can also be Removed.

SHOWCASE           external profile app /profile.html?npub=… lists a creator's published entities
```

"Pending" is **git-tracked state**: `GET /__content/pending` reports the ids whose def
differs from `git show HEAD:` (or whose asset files are untracked/modified). It is *not*
an app flag — committing the JSON + model files to git is what makes an entity permanent.

---

## The event

| | |
| --- | --- |
| `kind` | `30333` (`GORILATOR_ENTITY_KIND`) — parameterized-replaceable (NIP-01 addressable) |
| `pubkey` (author) | the **creator's** pubkey |
| `created_at` | publish time |
| `d` tag | `gorilator-entity-v1:<entityId>` (`entityDTag`) — one latest version per entity, per author |
| `t` tag | `gorilator-entity` (`GORILATOR_ENTITY_T`) |
| `entity-type` tag | `character` \| `structure` \| `item` |
| `name` tag | display name |
| `image` tag | Blossom URL of the preview thumbnail |
| `x` tags | sha-256 of every referenced blob (Blossom content addresses) |
| `content` | a `CommunityEntity` JSON (below) |

> **Tag indexing:** Nostr relays only index **single-letter** tag filters, so discovery
> uses `#t` (and `authors`) — `entity-type` is filtered **client-side**, not via a
> (non-indexable) `#entity-type` relay filter.

### `content` — the `CommunityEntity` schema

Defined in `@rpg/shared` (`packages/shared/src/types.ts`). Exactly one of
`character` / `structure` / `item` is set, matching `type`. Every asset path is an
**absolute Blossom URL**.

```ts
interface CommunityEntityAsset { url: string; sha256: string; size: number; mime: string; }

interface CommunityEntity {
  v: 1;
  type: "character" | "structure" | "item";
  id: string;                  // stable id (also the d-tag suffix)
  name: string;
  description: string;
  preview?: CommunityEntityAsset;            // thumbnail image (WebP)
  character?: {
    baseModel: CommunityEntityAsset;
    anims: Record<string, { asset: CommunityEntityAsset; speed?: number; yawFix?: number }>;
    yaw: number; scale: number;
  };
  structure?: { model: CommunityEntityAsset; scale: number; collisionRadius?: number; hp?: number };
  item?: { icon?: CommunityEntityAsset; model?: CommunityEntityAsset; stack: number; worldScale: number };
  stats?: {                    // CharacterStatsConfig — chars/structures
    maxHp?: number; attack?: number; armor?: number; critChance?: number;
    moveSpeed?: number; throwPower?: number; level?: number; xp?: number;
  };
  ts: number;                  // publish time (epoch ms)
}
```

### Example (item)

```json
{
  "kind": 30333,
  "pubkey": "3345fd27e6ba…",
  "tags": [
    ["d", "gorilator-entity-v1:emerald_charm"],
    ["t", "gorilator-entity"],
    ["entity-type", "item"],
    ["name", "Emerald Charm"],
    ["image", "https://blossom.primal.net/961b7e03…png"],
    ["x", "961b7e03…"]
  ],
  "content": "{\"v\":1,\"type\":\"item\",\"id\":\"emerald_charm\",\"name\":\"Emerald Charm\",\"description\":\"A lucky charm.\",\"preview\":{\"url\":\"https://blossom.primal.net/961b7e03…png\",\"sha256\":\"961b7e03…\",\"size\":36,\"mime\":\"image/png\"},\"item\":{\"icon\":{\"url\":\"https://blossom.primal.net/961b7e03…png\",\"sha256\":\"961b7e03…\",\"size\":36,\"mime\":\"image/png\"},\"stack\":99,\"worldScale\":1.2},\"ts\":1780896329598}"
}
```

---

## Blossom asset hosting (BUD-01)

Each asset is uploaded with a signed **kind-24242** authorization event:

- `tags`: `["t","upload"]`, `["x",<sha256>]`, `["expiration",<now+300>]`
- sent as `Authorization: Nostr <base64(event)>` on a `PUT <server>/upload`

The server stores the blob content-addressed and returns `{ url, sha256, size, type }`.
Because the address **is** the hash, any Blossom server can serve or mirror the blob —
so we publish to one (`blossom.primal.net`, then `blossom.band` as fallback) and store
the absolute URL. On **import**, assets are fetched and the sha-256 is re-verified.

Client code: `packages/client/src/net/blossom.ts` (upload/download),
`packages/client/src/dev/communityPublish.ts` (orchestration).

---

## Caching

The Library caches its entity lists at two layers so it opens instantly and never
shows an empty/loading grid on a warm cache:

- **Client — localStorage, stale-while-revalidate** (`packages/client/src/dev/libraryCache.ts`).
  On open/tab-switch the Library paints the cached lists (local **and** community)
  immediately, then **always revalidates** in the background and repaints + re-caches
  (guarded by the render epoch so a stale fetch never clobbers a newer view). Survives
  a page refresh.
- **Server — `@rpg/cache`** (`packages/cache/`). A standalone service that keeps a warm
  relay subscription to kind-30333, dedupes by address (author + `d`), and serves the
  parsed list at `GET /community-entities` (CORS-open) + `GET /healthz`. The client hits
  it first (set `VITE_COMMUNITY_CACHE_URL`) for a fast cold load and **falls back to the
  relays** if it's unset/unreachable. Env: `PORT` (default 4903), `RELAYS` (comma-sep).
- **Server — dev endpoints.** The Vite dev endpoints memoize their content JSON in memory
  (invalidated by file mtime / on write), so the local defs lists aren't re-read from disk
  on every poll.

Run the cache server with `pnpm --filter @rpg/cache dev` (or `build` + `start`), then point
the client at it via `VITE_COMMUNITY_CACHE_URL=http://localhost:4903`.

---

## Where it lives in the code

| Concern | Location |
| --- | --- |
| Protocol constants + types | `packages/shared/src/constants.ts`, `…/types.ts` |
| Creator wizard | `packages/client/src/dev/EntityCreator.ts` |
| Library (Local/Community, pending, publish/import) | `packages/client/src/dev/LibraryExplorer.ts` |
| Blossom client | `packages/client/src/net/blossom.ts` |
| Publish orchestration | `packages/client/src/dev/communityPublish.ts` |
| Community browse | `packages/client/src/dev/communityBrowse.ts` |
| Client cache (localStorage SWR) | `packages/client/src/dev/libraryCache.ts` |
| Server cache (warm relay sub + HTTP) | `packages/cache/` (`@rpg/cache`) |
| Dev endpoints (`/__content/pending`, `/__char/def-delete`, `/__content/import-remote`, `/__structures/*`) | `packages/client/vite.config.ts` |
| Creator profile page | External profile/landing app; the game links to it with `VITE_LANDING_URL` |

> All local authoring + git + file writes go through **dev-only Vite middleware**, so the
> Local library + creator only work under `pnpm dev`. Publishing/browsing (Nostr + Blossom)
> are browser-direct and work anywhere a signer is present.
