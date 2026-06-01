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

// Deep base green used for the grassy field that covers the whole map.
const GRASS_PALETTES: GrassPalette[] = [
  {
    base: "#3f6b34",
    patches: ["#42702f", "#3a6330", "#4a7a39", "#375d2b", "#4f8348", "#5b6b34", "#6b6238"],
    blade: (g) => `rgb(${Math.floor(g * 0.45)},${g + 25},${Math.floor(g * 0.4)})`,
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

/** Builds the grassy ground plane + crate props. (Boulders + trees are
 *  server-driven entities rendered by Game; the central house loads separately.) */
export function createEnvironment(scene: Scene): Environment {
  const span = WORLD_SIZE * 2;

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
