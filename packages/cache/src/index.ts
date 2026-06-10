import WebSocket from "ws";
import express from "express";
import cors from "cors";
import { SimplePool, useWebSocketImplementation } from "nostr-tools/pool";
import { GORILATOR_ENTITY_KIND, GORILATOR_ENTITY_T, type CommunityEntity } from "@rpg/shared";

/**
 * @rpg/cache — a tiny server-side cache for community entities (Nostr kind-30333).
 *
 * It keeps a warm relay subscription, dedupes addressable events (one latest per
 * author + `d`), and serves the parsed list over HTTP so clients get an instant,
 * cold-load-friendly result instead of each browser waiting on the relays. The
 * game client hits this first (VITE_COMMUNITY_CACHE_URL) and falls back to relays.
 *
 * Env: PORT (default 4903), RELAYS (comma-separated; defaults to the public set).
 */

// Node has no global WebSocket that nostr-tools' pool needs — inject `ws`.
useWebSocketImplementation(WebSocket);

const PORT = Number(process.env.PORT || 4903);
const RELAYS = (process.env.RELAYS || "wss://relay.damus.io,wss://nos.lol,wss://relay.nostr.band,wss://relay.primal.net")
  .split(",")
  .map((r) => r.trim())
  .filter(Boolean);

interface CommunityCard {
  id: string;
  author: string;
  createdAt: number;
  entity: CommunityEntity;
}

// Keyed by `${author}:${dTag}` — one latest version per addressable entity.
const cache = new Map<string, CommunityCard>();

function ingest(ev: { pubkey: string; created_at: number; tags: string[][]; content: string }): void {
  const d = ev.tags.find((t) => t[0] === "d")?.[1] || "";
  const key = `${ev.pubkey}:${d}`;
  const prev = cache.get(key);
  if (prev && prev.createdAt >= ev.created_at) return;
  let entity: CommunityEntity;
  try {
    entity = JSON.parse(ev.content) as CommunityEntity;
  } catch {
    return;
  }
  if (!entity || typeof entity !== "object" || !entity.type) return;
  cache.set(key, { id: entity.id || d, author: ev.pubkey, createdAt: ev.created_at, entity });
}

function startSubscription(): void {
  const pool = new SimplePool();
  console.log(`[cache] subscribing to kind ${GORILATOR_ENTITY_KIND} (#t=${GORILATOR_ENTITY_T}) on ${RELAYS.length} relays`);
  // Long-lived: stays open so the cache stays warm. nostr-tools' SimplePool
  // re-dials dropped relays under the hood.
  pool.subscribeMany(RELAYS, { kinds: [GORILATOR_ENTITY_KIND], "#t": [GORILATOR_ENTITY_T] }, {
    onevent: (ev) => ingest(ev),
    oneose: () => console.log(`[cache] initial sync done — ${cache.size} entities cached`),
  });
}

function startServer(): void {
  const app = express();
  app.use(cors()); // CORS-open: the game client (any origin) fetches this
  app.get("/healthz", (_req, res) => res.send("ok"));
  app.get("/community-entities", (_req, res) => {
    const cards = [...cache.values()].sort((a, b) => b.createdAt - a.createdAt);
    res.json(cards);
  });
  app.listen(PORT, () => {
    console.log(`[cache] community-entity cache listening on http://localhost:${PORT}`);
    console.log(`[cache]   GET /community-entities · GET /healthz`);
  });
}

startSubscription();
startServer();
