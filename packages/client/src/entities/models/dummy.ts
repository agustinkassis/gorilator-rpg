import {
  type Scene,
  TransformNode,
  type Mesh,
  MeshBuilder,
  StandardMaterial,
  Color3,
  type AbstractMesh,
} from "@babylonjs/core";
import { AnimState } from "@rpg/shared";
import { type SpawnedCharacter, HIT_FLASH } from "../types";

/**
 * A classic straw training dummy: a wooden post + crossbar, a burlap sack body
 * and head, and a painted target on the chest. Sways idly, wobbles when hit, and
 * topples over on "death" (it respawns shortly after).
 */
export function buildDummy(scene: Scene): SpawnedCharacter {
  const mats: StandardMaterial[] = [];
  const mat = (name: string, color: Color3) => {
    const m = new StandardMaterial(name, scene);
    m.diffuseColor = color;
    m.specularColor = new Color3(0.05, 0.05, 0.05);
    mats.push(m);
    return m;
  };

  const wood = mat("dWood", new Color3(0.4, 0.26, 0.13));
  const burlap = mat("dBurlap", new Color3(0.78, 0.66, 0.36));
  const rope = mat("dRope", new Color3(0.45, 0.37, 0.2));
  const red = mat("dRed", new Color3(0.7, 0.18, 0.15));
  const white = mat("dWhite", new Color3(0.9, 0.86, 0.78));

  const meshes: AbstractMesh[] = [];
  const add = (m: Mesh, material: StandardMaterial) => {
    m.material = material;
    meshes.push(m);
    return m;
  };

  const root = new TransformNode("dummy", scene);

  // pivot at the base so it topples from the ground
  const body = new TransformNode("dummyBody", scene);
  body.parent = root;

  const post = add(MeshBuilder.CreateCylinder("post", { height: 1.5, diameterTop: 0.16, diameterBottom: 0.22 }, scene), wood);
  post.parent = body;
  post.position.y = 0.75;

  const crossbar = add(MeshBuilder.CreateBox("crossbar", { width: 1.4, height: 0.16, depth: 0.16 }, scene), wood);
  crossbar.parent = body;
  crossbar.position.y = 1.15;

  // burlap torso (a stuffed sack)
  const torso = add(MeshBuilder.CreateCapsule("dTorso", { height: 1.0, radius: 0.4 }, scene), burlap);
  torso.parent = body;
  torso.position.y = 1.05;
  torso.scaling.z = 0.85;

  // rope ties
  for (const y of [0.78, 1.35]) {
    const tie = add(MeshBuilder.CreateTorus("tie", { diameter: 0.78, thickness: 0.06, tessellation: 12 }, scene), rope);
    tie.parent = body;
    tie.position.y = y;
    tie.scaling.z = 0.85;
    tie.rotation.x = Math.PI / 2;
  }

  // head
  const head = add(MeshBuilder.CreateSphere("dHead", { diameter: 0.5, segments: 8 }, scene), burlap);
  head.parent = body;
  head.position.y = 1.78;
  const knot = add(MeshBuilder.CreateSphere("knot", { diameter: 0.18, segments: 6 }, scene), rope);
  knot.parent = body;
  knot.position.y = 2.02;

  // painted target on the chest
  const ringColors = [red, white, red];
  ringColors.forEach((m, i) => {
    const d = 0.5 - i * 0.16;
    const disc = add(MeshBuilder.CreateCylinder("ring", { height: 0.04, diameter: d, tessellation: 20 }, scene), m);
    disc.parent = body;
    disc.position.set(0, 1.1, 0.36 + i * 0.012);
    disc.rotation.x = Math.PI / 2;
  });

  const pose = (state: AnimState, t: number) => {
    body.rotation.set(0, 0, 0);
    root.position.y = 0;
    root.rotation.x = 0;
    root.rotation.z = 0;

    switch (state) {
      case AnimState.HIT: {
        const d = Math.max(0, 1 - t / 0.35);
        body.rotation.x = Math.sin(t * 38) * 0.18 * d; // wobble on the post
        break;
      }
      case AnimState.DEAD: {
        const k = Math.min(1, t / 0.5);
        root.rotation.z = (Math.PI / 2) * k; // topple over
        break;
      }
      default: {
        body.rotation.z = Math.sin(t * 1.3) * 0.03; // idle sway
      }
    }
  };

  return {
    root,
    meshes,
    groups: {},
    hasAnims: false,
    pose,
    flashHit: (on, color = HIT_FLASH) => {
      for (const m of meshes) {
        m.renderOverlay = on;
        m.overlayColor = color;
        m.overlayAlpha = 0.5;
      }
    },
    dispose: () => {
      root.dispose();
      for (const m of mats) m.dispose();
    },
  };
}
