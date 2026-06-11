import { SimplePool } from "nostr-tools/pool";
import {
  GORILATOR_ENTITY_KIND,
  GORILATOR_ENTITY_T,
  entityDTag,
  type CommunityEntity,
  type CommunityEntityAsset,
  type CommunityProvenance,
  type CharacterStatsConfig,
} from "@rpg/shared";
import { uploadBlob } from "../net/blossom";
import { renderModelThumb } from "./LibraryExplorer";
import type { CharacterDef } from "../entities/characterDef";

/**
 * Publish a Local library entity to the community: upload its assets to Blossom,
 * then sign + broadcast a kind-30333 (GORILATOR_ENTITY_KIND) addressable event with
 * the author's own key. Re-publishing replaces the same `d` address (one latest
 * version per entity). See docs/community-entities.md.
 */

/** Relays community entities are published to (mirrors docs/nostr.md). */
const RELAYS = ["wss://relay.damus.io", "wss://nos.lol", "wss://relay.nostr.band", "wss://relay.primal.net"];

export type PublishProgress = (msg: string) => void;

export interface PublishStructureDef {
  id: string;
  name: string;
  description?: string;
  model: string;
  scale: number;
  collisionRadius?: number;
  hp?: number;
  stats?: CharacterStatsConfig;
}

export interface PublishItemDef {
  id: string;
  name: string;
  description?: string;
  icon?: string;
  model?: string;
  stack?: number;
  worldScale?: number;
}

function raceTimeout<T>(p: Promise<T>, ms: number): Promise<T | null> {
  return Promise.race([p, new Promise<null>((r) => setTimeout(() => r(null), ms))]);
}

async function fetchBytes(url: string): Promise<ArrayBuffer> {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`fetch ${url} → ${r.status}`);
  return r.arrayBuffer();
}

function mimeFor(url: string): string {
  const ext = (url.match(/\.[a-z0-9]+(?:$|\?)/i)?.[0] || "").toLowerCase().replace(/\?$/, "");
  if (ext === ".glb") return "model/gltf-binary";
  if (ext === ".png") return "image/png";
  if (ext === ".jpg" || ext === ".jpeg") return "image/jpeg";
  if (ext === ".webp") return "image/webp";
  return "application/octet-stream";
}

async function uploadLocal(url: string, onProgress: PublishProgress, label: string): Promise<CommunityEntityAsset> {
  onProgress(`uploading ${label}…`);
  return uploadBlob(await fetchBytes(url), mimeFor(url));
}

/** Render + upload a model thumbnail as the entity's preview image (best-effort). */
async function uploadModelPreview(model: string, onProgress: PublishProgress): Promise<CommunityEntityAsset | undefined> {
  try {
    onProgress("rendering preview…");
    const blob = await renderModelThumb(model);
    if (!blob) return undefined;
    onProgress("uploading preview…");
    return uploadBlob(await blob.arrayBuffer(), blob.type || "image/webp");
  } catch {
    return undefined; // a missing preview is non-fatal
  }
}

function collectAssets(e: CommunityEntity): CommunityEntityAsset[] {
  const out: CommunityEntityAsset[] = [];
  if (e.preview) out.push(e.preview);
  if (e.character) {
    out.push(e.character.baseModel);
    for (const a of Object.values(e.character.anims)) if (a?.asset) out.push(a.asset);
  }
  if (e.structure) out.push(e.structure.model);
  if (e.item) {
    if (e.item.icon) out.push(e.item.icon);
    if (e.item.model) out.push(e.item.model);
  }
  return out;
}

/** Sign the entity event with the user's key and broadcast it to the relays. */
async function signAndPublish(entity: CommunityEntity, onProgress: PublishProgress): Promise<CommunityProvenance> {
  const signer = window.nostr;
  if (!signer) throw new Error("Connect Nostr to publish (no signer).");
  const pubkey = await signer.getPublicKey();
  const d = entityDTag(entity.id);
  const tags: string[][] = [
    ["d", d],
    ["t", GORILATOR_ENTITY_T],
    ["entity-type", entity.type],
    ["name", entity.name],
  ];
  if (entity.preview?.url) tags.push(["image", entity.preview.url]);
  for (const a of collectAssets(entity)) tags.push(["x", a.sha256]);

  const event = await signer.signEvent({
    kind: GORILATOR_ENTITY_KIND,
    created_at: Math.floor(Date.now() / 1000),
    tags,
    content: JSON.stringify(entity),
  });
  onProgress("publishing to relays…");
  const pool = new SimplePool();
  try {
    await raceTimeout(Promise.allSettled(pool.publish(RELAYS, event)), 6000);
  } finally {
    pool.close(RELAYS);
  }
  return { pubkey, d, ts: entity.ts };
}

export async function publishCharacter(def: CharacterDef, onProgress: PublishProgress): Promise<CommunityProvenance> {
  const baseModel = await uploadLocal(def.baseModel, onProgress, "base model");
  const animsOut: Record<string, { asset: CommunityEntityAsset; speed?: number; yawFix?: number }> = {};
  for (const [action, a] of Object.entries(def.anims)) {
    if (!a?.file) continue;
    animsOut[action] = {
      asset: await uploadLocal(a.file, onProgress, `${action.toLowerCase()} clip`),
      speed: a.speed,
      yawFix: a.yawFix,
    };
  }
  const preview = await uploadModelPreview(def.baseModel, onProgress);
  const entity: CommunityEntity = {
    v: 1,
    type: "character",
    id: def.id,
    name: def.name,
    description: def.description || "",
    preview,
    character: { baseModel, anims: animsOut, yaw: def.yaw || 0, scale: def.scale || 1 },
    stats: def.stats,
    ts: Date.now(),
  };
  return signAndPublish(entity, onProgress);
}

export async function publishStructure(def: PublishStructureDef, onProgress: PublishProgress): Promise<CommunityProvenance> {
  const model = await uploadLocal(def.model, onProgress, "model");
  const preview = await uploadModelPreview(def.model, onProgress);
  const entity: CommunityEntity = {
    v: 1,
    type: "structure",
    id: def.id,
    name: def.name,
    description: def.description || "",
    preview,
    structure: { model, scale: def.scale || 1, collisionRadius: def.collisionRadius, hp: def.hp },
    stats: def.stats,
    ts: Date.now(),
  };
  return signAndPublish(entity, onProgress);
}

export async function publishItem(def: PublishItemDef, onProgress: PublishProgress): Promise<CommunityProvenance> {
  const icon = def.icon ? await uploadLocal(def.icon, onProgress, "icon") : undefined;
  const model = def.model ? await uploadLocal(def.model, onProgress, "model") : undefined;
  const entity: CommunityEntity = {
    v: 1,
    type: "item",
    id: def.id,
    name: def.name,
    description: def.description || "",
    preview: icon, // the icon doubles as the card preview
    item: { icon, model, stack: def.stack ?? 99, worldScale: def.worldScale ?? 1.2 },
    ts: Date.now(),
  };
  return signAndPublish(entity, onProgress);
}
