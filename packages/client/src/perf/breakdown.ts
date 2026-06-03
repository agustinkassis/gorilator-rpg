import { Scene, AbstractMesh } from "@babylonjs/core";
import type {
  ClientPerfSample,
  ResourceItem,
  RenderCategory,
  RenderProfile,
} from "@rpg/shared";
import type { GameDebugStats } from "../ui/debugStats";

/**
 * Build the live resource breakdown lists for the F3 overlay's expand panel and the
 * FPS-dip capture: **render** (scene-render load per game-element kind), **elements**
 * (renderables + biggest meshes), and **entities** (game-object counts). The
 * {@link PerfTracker} adds **reasons** (its span tags, incl. the scene.render
 * sub-phases). Lists are heaviest-first.
 *
 * The mesh scan is the only O(n) part (n = scene meshes); callers throttle it.
 */
export function buildResourceBreakdown(
  scene: Scene,
  gs: GameDebugStats,
  latest: ClientPerfSample | null,
): { render: ResourceItem[]; elements: ResourceItem[]; entities: ResourceItem[] } {
  // ---- render: scene-render load attributed to each game-element kind ----
  const render: ResourceItem[] = renderLoadByCategory(scene).map((c) => ({
    label: c.kind,
    value: c.triangles,
    unit: "tris",
    note: `${c.meshes} mesh · ${c.draws} draws`,
  }));

  // ---- elements: aggregate renderables + the heaviest individual meshes ----
  const elements: ResourceItem[] = [];
  if (latest) {
    elements.push({ label: "draw calls", value: latest.drawCalls, unit: "draws" });
    elements.push({ label: "triangles", value: latest.triangles, unit: "tris" });
    elements.push({
      label: "active meshes",
      value: latest.activeMeshes,
      unit: "drawn",
      note: `${latest.activeMeshes} of ${scene.meshes.length} total`,
    });
  }
  const activeParticles = scene.activeParticlesPerfCounter?.current ?? 0;
  if (scene.particleSystems.length) {
    elements.push({
      label: "particle systems",
      value: scene.particleSystems.length,
      unit: "fx",
      note: `${compact(activeParticles)} particles live`,
    });
  }
  for (const m of topMeshes(scene, 6)) {
    elements.push({ label: m.name, value: m.tris, unit: "tris", note: `${compact(m.verts)} verts` });
  }

  // ---- entities: game-object categories, biggest first ----
  const drops = gs.logs + gs.stones + gs.bananas + gs.potions + gs.items;
  const entities: ResourceItem[] = [
    { label: "characters", value: gs.entities, unit: "", note: `${gs.players} players` },
    { label: "trees", value: gs.trees, unit: "" },
    { label: "rocks", value: gs.rocks, unit: "" },
    {
      label: "drops",
      value: drops,
      unit: "",
      note: `${gs.logs} log · ${gs.stones} stone · ${gs.bananas} banana · ${gs.potions} potion · ${gs.items} custom`,
    },
    { label: "houses", value: gs.houses, unit: "" },
    { label: "thrown FX", value: gs.thrown, unit: "fx" },
    { label: "particle FX", value: gs.particleFx, unit: "fx" },
    { label: "collect FX", value: gs.collecting, unit: "fx" },
    { label: "lightning FX", value: gs.lightnings, unit: "fx" },
  ]
    .filter((e) => e.value > 0)
    .sort((a, b) => b.value - a.value);

  return { render, elements, entities };
}

/**
 * Group the ACTIVE (rendered-this-frame) meshes by their game `metadata.kind` and
 * sum the triangles + sub-mesh batches per kind. This is the heart of "what element
 * is generating the lag": render cost tracks triangles + draw batches, so the kind
 * topping this list is the one taxing the GPU/driver. Meshes with no kind fall under
 * "scene" (ground, imported props without metadata, FX). Sorted heaviest-first.
 */
export function renderLoadByCategory(scene: Scene): RenderCategory[] {
  const byKind = new Map<string, RenderCategory>();
  // SmartArray.data is over-allocated — iterate to .length, not the backing array,
  // or stale meshes from earlier frames get counted.
  const active = scene.getActiveMeshes();
  for (let i = 0; i < active.length; i++) {
    const m = active.data[i];
    if (!m || m.isDisposed()) continue;
    const idx = m.getTotalIndices();
    const tris = idx > 0 ? Math.round(idx / 3) : m.getTotalVertices();
    const kind = kindOf(m);
    let cat = byKind.get(kind);
    if (!cat) byKind.set(kind, (cat = { kind, meshes: 0, draws: 0, triangles: 0 }));
    cat.meshes += 1;
    cat.draws += Math.max(1, m.subMeshes?.length ?? 1);
    cat.triangles += tris;
  }
  return [...byKind.values()].sort((a, b) => b.triangles - a.triangles);
}

/**
 * Build the deep render profile: engine sub-phase timings (passed in from the probe)
 * + scene totals + the per-kind render load + the heaviest meshes. The "save the
 * details for later" artefact behind the overlay's Profile button.
 */
export function buildRenderProfile(
  scene: Scene,
  phases: Record<string, number>,
  latest: ClientPerfSample | null,
  meta: Record<string, unknown>,
): RenderProfile {
  return {
    t: Date.now(),
    fps: latest?.fps ?? 0,
    frameMs: latest?.frameMs ?? null,
    gpuMs: latest?.gpuMs ?? null,
    phases,
    totals: {
      drawCalls: latest?.drawCalls ?? 0,
      activeMeshes: scene.getActiveMeshes().length,
      totalMeshes: scene.meshes.length,
      triangles: latest?.triangles ?? Math.round(scene.getActiveIndices() / 3),
      particleSystems: scene.particleSystems.length,
      activeParticles: scene.activeParticlesPerfCounter?.current ?? 0,
      materials: scene.materials.length,
      textures: scene.textures.length,
    },
    byCategory: renderLoadByCategory(scene),
    topMeshes: topMeshes(scene, 16).map((m) => ({
      name: m.name,
      triangles: m.tris,
      vertices: m.verts,
    })),
    meta,
  };
}

// ---- helpers ----

interface MeshWeight {
  name: string;
  tris: number;
  verts: number;
}

/** The k enabled meshes with the most geometry, named by their game `kind`. */
function topMeshes(scene: Scene, k: number): MeshWeight[] {
  const out: MeshWeight[] = [];
  for (const m of scene.meshes) {
    if (!m.isEnabled() || m.isDisposed()) continue;
    const verts = m.getTotalVertices();
    const idx = m.getTotalIndices();
    if (verts === 0 && idx === 0) continue;
    const kind = kindOf(m);
    const name = `${kind !== "scene" ? kind + ":" : ""}${m.name || m.id}`.slice(0, 22);
    out.push({ name, tris: idx > 0 ? Math.round(idx / 3) : verts, verts });
  }
  out.sort((a, b) => b.tris - a.tris);
  return out.slice(0, k);
}

/** A mesh's game-element kind: its own metadata, or the nearest ancestor's (glTF
 *  imports nest real geometry under a `__root__`, so the kind lives on the parent). */
function kindOf(mesh: AbstractMesh): string {
  let node: { metadata?: unknown; parent?: unknown } | null = mesh;
  for (let i = 0; node && i < 6; i++) {
    const k = (node.metadata as { kind?: string } | null)?.kind;
    if (k) return k;
    node = node.parent as typeof node;
  }
  return "scene";
}

function compact(v: number): string {
  if (v >= 1e6) return `${(v / 1e6).toFixed(1)}m`;
  if (v >= 1e3) return `${(v / 1e3).toFixed(1)}k`;
  return String(Math.round(v));
}
