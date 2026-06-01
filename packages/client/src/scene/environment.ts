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

// Ground decals (terrain patches) render in this group — drawn AFTER the ground +
// props (group 0), with depth-writing off, so overlapping patches layer in a stable
// paint order instead of z-fighting. createEnvironment() must also tell this group
// NOT to auto-clear the depth buffer (Babylon clears it per group by default), so
// the patches still depth-test against the objects and stay UNDER them on the floor.
const PATCH_GROUP = 1;

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

// Two distinct grass looks: #0 the deep base green, #1 a lighter/yellower grass.
// Mixing both across the map breaks up the flat uniform field.
const GRASS_PALETTES: GrassPalette[] = [
  {
    base: "#3f6b34",
    patches: ["#42702f", "#3a6330", "#4a7a39", "#375d2b", "#4f8348", "#5b6b34", "#6b6238"],
    blade: (g) => `rgb(${Math.floor(g * 0.45)},${g + 25},${Math.floor(g * 0.4)})`,
  },
  {
    base: "#5c7d3c",
    patches: ["#65893f", "#54743a", "#719447", "#4d6c35", "#7c9d52", "#848d4c", "#8d8044"],
    blade: (g) => `rgb(${Math.floor(g * 0.55)},${g + 35},${Math.floor(g * 0.32)})`,
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

/** A grainy sand texture for the desert patches. */
function makeSandTexture(scene: Scene): DynamicTexture {
  const size = 512;
  const tex = new DynamicTexture("sand", size, scene, false);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const ctx = tex.getContext() as any;

  ctx.fillStyle = "#cdba86";
  ctx.fillRect(0, 0, size, size);

  // soft tonal drifts
  const tones = ["#d6c590", "#c2ad78", "#dacb9b", "#bba76f", "#cbb884"];
  for (let i = 0; i < 60; i++) {
    ctx.globalAlpha = 0.4;
    ctx.fillStyle = tones[i % tones.length];
    ctx.beginPath();
    ctx.arc(Math.random() * size, Math.random() * size, 18 + Math.random() * 60, 0, Math.PI * 2);
    ctx.fill();
  }

  // fine grain speckle
  ctx.globalAlpha = 0.5;
  for (let i = 0; i < 4500; i++) {
    ctx.fillStyle = Math.random() < 0.5 ? "#a9966a" : "#e7dcb6";
    ctx.fillRect(Math.random() * size, Math.random() * size, 1, 1);
  }
  ctx.globalAlpha = 1;

  tex.update();
  tex.wrapU = Texture.WRAP_ADDRESSMODE;
  tex.wrapV = Texture.WRAP_ADDRESSMODE;
  return tex;
}

/** Scatter flat textured discs (a terrain "patchwork" layer) across the map. */
function scatterPatches(
  scene: Scene,
  name: string,
  mat: StandardMaterial,
  count: number,
  range: number,
  rMin: number,
  rMax: number,
  y: number,
) {
  const base = MeshBuilder.CreateCylinder(name, { height: 0.06, diameter: 2, tessellation: 20 }, scene);
  base.material = mat;
  base.receiveShadows = true;
  base.isVisible = false;
  base.isPickable = false;
  // Ground decals: render them in their own group (after the ground, before the
  // props) with depth-writing off, so overlapping patches layer in a stable paint
  // order instead of z-fighting (the "flashy" flicker where they overlap).
  base.renderingGroupId = PATCH_GROUP;
  mat.disableDepthWrite = true;
  for (let i = 0; i < count; i++) {
    const x = (Math.random() * 2 - 1) * range;
    const z = (Math.random() * 2 - 1) * range;
    const inst = base.createInstance(name + "_" + i);
    inst.isPickable = false;
    const r = rMin + Math.random() * (rMax - rMin);
    inst.scaling.set(r, 1, r);
    inst.rotation.y = Math.random() * Math.PI * 2;
    inst.position.set(x, y, z);
  }
}

/** Scatter `count` instances of `base` across the map (base itself stays hidden). */
function scatter(
  base: Mesh,
  count: number,
  range: number,
  opts: { y: number; sMin: number; sMax: number; flatten?: number; clear?: number },
) {
  base.isVisible = false;
  base.isPickable = false;
  const clear = opts.clear ?? 6;
  for (let i = 0; i < count; i++) {
    let x = 0,
      z = 0,
      tries = 0;
    do {
      x = (Math.random() * 2 - 1) * range;
      z = (Math.random() * 2 - 1) * range;
      tries++;
    } while (Math.hypot(x, z) < clear && tries < 10);
    const inst = base.createInstance(base.name + "_" + i);
    inst.isPickable = false;
    const s = opts.sMin + Math.random() * (opts.sMax - opts.sMin);
    inst.scaling.set(s, s * (opts.flatten ?? 1), s);
    inst.rotation.y = Math.random() * Math.PI * 2;
    inst.position.set(x, opts.y, z);
  }
}

/** Builds the ground plane, terrain patches, scattered decorations + crate props. */
export function createEnvironment(scene: Scene): Environment {
  const span = WORLD_SIZE * 2;

  // Keep the depth buffer from group 0 when the patch group (PATCH_GROUP) renders —
  // otherwise Babylon clears it per-group and the patches, having nothing to
  // depth-test against, paint on top of every object instead of lying on the floor.
  scene.setRenderingAutoClearDepthStencil(PATCH_GROUP, false);

  const ground = MeshBuilder.CreateGround(
    "ground",
    { width: span, height: span, subdivisions: 1 },
    scene,
  );
  const groundMat = new StandardMaterial("groundMat", scene);
  const grass = makeGrassTexture(scene, 0); // base grass covers the whole map
  grass.uScale = WORLD_SIZE * 0.7;
  grass.vScale = WORLD_SIZE * 0.7;
  groundMat.diffuseTexture = grass;
  groundMat.specularColor = new Color3(0.02, 0.04, 0.02);
  ground.material = groundMat;
  ground.receiveShadows = true;

  const shadowCasters: Mesh[] = [];
  const patchRange = WORLD_SIZE - 6;
  const decoRange = WORLD_SIZE - 4;

  // ---- terrain patches (dirt / dark grass / moss) as thin flat discs ----
  // (sand is its own textured layer below)
  const patchDefs: Array<[string, Color3, number]> = [
    ["patchDirt", new Color3(0.42, 0.31, 0.19), 22],
    ["patchDark", new Color3(0.22, 0.36, 0.2), 24],
    ["patchMoss", new Color3(0.3, 0.46, 0.24), 18],
  ];
  for (const [name, color, count] of patchDefs) {
    const base = MeshBuilder.CreateCylinder(name, { height: 0.05, diameter: 2, tessellation: 18 }, scene);
    const mat = flat(scene, name + "Mat", color);
    mat.specularColor = new Color3(0, 0, 0);
    mat.disableDepthWrite = true; // see PATCH_GROUP — stop overlapping patches z-fighting
    base.material = mat;
    base.receiveShadows = true;
    base.renderingGroupId = PATCH_GROUP;
    base.isVisible = false;
    base.isPickable = false;
    for (let i = 0; i < count; i++) {
      const x = (Math.random() * 2 - 1) * patchRange;
      const z = (Math.random() * 2 - 1) * patchRange;
      const inst = base.createInstance(name + "_" + i);
      inst.isPickable = false;
      const r = 2 + Math.random() * 4.5;
      inst.scaling.set(r, 1, r);
      inst.rotation.y = Math.random() * Math.PI * 2;
      inst.position.set(x, 0.03, z);
    }
  }

  // ---- two-tone grass: big organic patches of a SECOND grass texture scattered
  //      over the base grass, so the field reads as a random mix of two greens ----
  const grass2 = makeGrassTexture(scene, 1);
  grass2.uScale = 4;
  grass2.vScale = 4;
  const grass2Mat = new StandardMaterial("grass2Mat", scene);
  grass2Mat.diffuseTexture = grass2;
  grass2Mat.specularColor = new Color3(0.02, 0.04, 0.02);
  scatterPatches(scene, "grassPatch", grass2Mat, 40, patchRange, 5, 13, 0.02);

  // ---- sand: prominent grainy desert patches replacing grass in some parts ----
  const sand = makeSandTexture(scene);
  sand.uScale = 3;
  sand.vScale = 3;
  const sandMat = new StandardMaterial("sandMat", scene);
  sandMat.diffuseTexture = sand;
  sandMat.specularColor = new Color3(0, 0, 0);
  scatterPatches(scene, "sandPatch", sandMat, 22, patchRange, 3, 9, 0.04);

  // ---- scattered decorations (instanced for performance) ----
  const pebble = MeshBuilder.CreateIcoSphere("pebble", { radius: 1, subdivisions: 1, flat: true }, scene);
  pebble.material = flat(scene, "pebbleMat", new Color3(0.5, 0.5, 0.54));
  scatter(pebble, 70, decoRange, { y: 0.12, sMin: 0.18, sMax: 0.5, flatten: 0.6 });

  const bush = MeshBuilder.CreateIcoSphere("bush", { radius: 1, subdivisions: 2, flat: true }, scene);
  bush.material = flat(scene, "bushMat", new Color3(0.17, 0.4, 0.18));
  scatter(bush, 40, decoRange, { y: 0.5, sMin: 0.6, sMax: 1.4, flatten: 0.75 });

  const flowerColors: Array<[string, Color3]> = [
    ["flowerRed", new Color3(0.85, 0.2, 0.25)],
    ["flowerYellow", new Color3(0.95, 0.85, 0.2)],
    ["flowerWhite", new Color3(0.92, 0.92, 0.95)],
    ["flowerBlue", new Color3(0.4, 0.5, 0.92)],
  ];
  for (const [name, color] of flowerColors) {
    const f = MeshBuilder.CreateSphere(name, { diameter: 1, segments: 5 }, scene);
    const m = flat(scene, name + "Mat", color);
    m.emissiveColor = color.scale(0.25);
    f.material = m;
    scatter(f, 22, decoRange, { y: 0.18, sMin: 0.16, sMax: 0.3 });
  }

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
    arm.position.set(0, 0.06, 0); // just above the ground/patches, below characters
    arm.isPickable = false;
    arm.receiveShadows = true;
  }

  // Boulders + trees are server-driven entities (rendered by Game), not here.
  return { ground, shadowCasters };
}
