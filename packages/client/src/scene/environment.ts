import {
  Scene,
  Mesh,
  MeshBuilder,
  StandardMaterial,
  Color3,
  DynamicTexture,
  Texture,
} from "@babylonjs/core";
import { WORLD_SIZE, CRATES } from "@rpg/shared";

export interface Environment {
  ground: Mesh;
  shadowCasters: Mesh[];
}

function flat(scene: Scene, name: string, color: Color3): StandardMaterial {
  const m = new StandardMaterial(name, scene);
  m.diffuseColor = color;
  m.specularColor = new Color3(0.02, 0.02, 0.02); // low-poly look = matte
  return m;
}

interface GrassPalette {
  base: string;
  patches: string[];
  blade: (g: number) => string;
}

// Three grass "looks" — same family of greens so the field reads as one meadow,
// but distinct enough (medium / lighter-warm / cooler-dark) that, scattered across
// the tile grid, the ground never looks like the same patch repeating.
const GRASS_PALETTES: GrassPalette[] = [
  {
    // 0 — medium green
    base: "#3f6b34",
    patches: ["#42702f", "#3a6330", "#4a7a39", "#375d2b", "#4f8348", "#456f33"],
    blade: (g) => `rgb(${Math.floor(g * 0.45)},${g + 25},${Math.floor(g * 0.4)})`,
  },
  {
    // 1 — lighter, warmer green
    base: "#4a7438",
    patches: ["#54803f", "#46703a", "#5c8a44", "#436b34", "#638f4a", "#4f7a3a"],
    blade: (g) => `rgb(${Math.floor(g * 0.5)},${g + 32},${Math.floor(g * 0.34)})`,
  },
  {
    // 2 — cooler, darker green
    base: "#37602f",
    patches: ["#3a6630", "#335a2c", "#41703a", "#2f5328", "#487a40", "#395f33"],
    blade: (g) => `rgb(${Math.floor(g * 0.38)},${g + 20},${Math.floor(g * 0.46)})`,
  },
];

/** Paint a tileable grassy texture onto a canvas (no external asset needed). */
function makeGrassTexture(scene: Scene, variant = 0): DynamicTexture {
  const size = 1024;
  const P = GRASS_PALETTES[variant] ?? GRASS_PALETTES[0];
  const tex = new DynamicTexture("grass" + variant, size, scene, false);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const ctx = tex.getContext() as any;

  ctx.fillStyle = P.base;
  ctx.fillRect(0, 0, size, size);

  // soft colour patches for large-scale variation (grass + a few earthy tones)
  for (let i = 0; i < 240; i++) {
    ctx.globalAlpha = 0.3;
    ctx.fillStyle = P.patches[i % P.patches.length];
    ctx.beginPath();
    ctx.arc(Math.random() * size, Math.random() * size, 26 + Math.random() * 90, 0, Math.PI * 2);
    ctx.fill();
  }

  // little grass blades
  ctx.globalAlpha = 0.85;
  for (let i = 0; i < 6000; i++) {
    const x = Math.random() * size;
    const y = Math.random() * size;
    const len = 3 + Math.random() * 7;
    const lean = (Math.random() - 0.5) * 3;
    const g = 90 + Math.floor(Math.random() * 80);
    ctx.strokeStyle = P.blade(g);
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(x, y);
    ctx.lineTo(x + lean, y - len);
    ctx.stroke();
  }
  ctx.globalAlpha = 1;

  tex.update();
  tex.wrapU = Texture.WRAP_ADDRESSMODE;
  tex.wrapV = Texture.WRAP_ADDRESSMODE;
  return tex;
}

const GRASS_TILE = 24; // world units per grass tile

/**
 * Carpet the whole map with grass built from the 3 texture variations. The ground
 * is a grid of tiles, each tile randomly one of the three textures with a random
 * 90° rotation — 12 combinations, so adjacent tiles almost never match and the
 * field has no visible tiling/repetition. Tiles are instances (one base mesh per
 * variation) and non-pickable, so clicks still fall through to the `ground` plane.
 */
function scatterGrass(scene: Scene): void {
  const bases = [0, 1, 2].map((v) => {
    const tex = makeGrassTexture(scene, v);
    tex.uScale = 1; // one whole texture per tile (no tiny in-tile repeat)
    tex.vScale = 1;
    const mat = new StandardMaterial("grassMat" + v, scene);
    mat.diffuseTexture = tex;
    mat.specularColor = new Color3(0.02, 0.04, 0.02);
    const base = MeshBuilder.CreateGround(
      "grassTile" + v,
      { width: GRASS_TILE, height: GRASS_TILE },
      scene,
    );
    base.material = mat;
    base.receiveShadows = true;
    base.isVisible = false; // only its instances are drawn
    base.isPickable = false;
    return base;
  });

  const n = Math.ceil((WORLD_SIZE * 2) / GRASS_TILE) + 1; // +1 so the grid overhangs the edges
  const start = -((n * GRASS_TILE) / 2) + GRASS_TILE / 2; // centre the grid on the map
  for (let i = 0; i < n; i++) {
    for (let j = 0; j < n; j++) {
      const v = Math.floor(Math.random() * 3);
      const inst = bases[v].createInstance(`grass_${i}_${j}`);
      inst.position.set(start + i * GRASS_TILE, 0.012, start + j * GRASS_TILE);
      inst.rotation.y = Math.floor(Math.random() * 4) * (Math.PI / 2); // 0/90/180/270°
      inst.isPickable = false;
    }
  }
}

/** Builds the grassy ground plane + crate props. (Boulders + trees are
 *  server-driven entities rendered by Game; the central house loads separately.) */
export function createEnvironment(scene: Scene): Environment {
  const span = WORLD_SIZE * 2;

  // A single full-map plane is the click/pick + collision-ray surface (ClickToMove,
  // Dev Mode); the visible grass is laid on top as a randomised 3-variation tile
  // grid so it never repeats. The base stays grass-green in case it ever peeks through.
  const ground = MeshBuilder.CreateGround(
    "ground",
    { width: span, height: span, subdivisions: 1 },
    scene,
  );
  ground.material = flat(scene, "groundBaseMat", new Color3(0.21, 0.36, 0.19));
  ground.receiveShadows = true;

  scatterGrass(scene); // carpet the map with the 3-variation grass grid

  const shadowCasters: Mesh[] = [];

  // ---- crate stacks (block movement; cast + receive shadows) ----
  const crateMat = flat(scene, "crateMat", new Color3(0.5, 0.36, 0.2));
  CRATES.forEach((c, i) => {
    const box = MeshBuilder.CreateBox("crate", { size: 1.2 }, scene);
    box.position.set(c.x, i % 3 === 2 ? 1.7 : 0.6, c.z); // every 3rd crate sits on top
    box.rotation.y = c.rotY;
    box.material = crateMat;
    box.receiveShadows = true;
    shadowCasters.push(box);
  });

  // ---- center cross: a glowing "+" marker at the map origin (0,0) ----
  const crossMat = flat(scene, "centerCrossMat", new Color3(0.97, 0.9, 0.45));
  crossMat.emissiveColor = new Color3(0.7, 0.62, 0.2); // glow so it reads from the iso camera
  crossMat.specularColor = new Color3(0, 0, 0);
  const armX = MeshBuilder.CreateBox("centerCrossX", { width: 11, height: 0.1, depth: 1.1 }, scene);
  const armZ = MeshBuilder.CreateBox("centerCrossZ", { width: 1.1, height: 0.1, depth: 11 }, scene);
  for (const arm of [armX, armZ]) {
    arm.material = crossMat;
    arm.position.set(0, 0.06, 0); // just above the ground, below characters
    arm.isPickable = false;
    arm.receiveShadows = true;
  }

  return { ground, shadowCasters };
}
