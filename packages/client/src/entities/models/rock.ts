import {
  Scene,
  TransformNode,
  MeshBuilder,
  StandardMaterial,
  Color3,
  AbstractMesh,
} from "@babylonjs/core";

export interface RockModel {
  root: TransformNode;
  meshes: AbstractMesh[];
  setAlive: (alive: boolean) => void;
  shake: () => void;
  update: (dt: number) => void;
  dispose: () => void;
}

interface RockMats {
  rock: StandardMaterial;
  rubble: StandardMaterial;
}

const matCache = new WeakMap<Scene, RockMats>();
function getMats(scene: Scene): RockMats {
  let m = matCache.get(scene);
  if (!m) {
    const mk = (name: string, c: Color3) => {
      const mat = new StandardMaterial(name, scene);
      mat.diffuseColor = c;
      mat.specularColor = new Color3(0.04, 0.04, 0.05);
      return mat;
    };
    m = {
      rock: mk("rockMat", new Color3(0.46, 0.46, 0.5)),
      rubble: mk("rubbleMat", new Color3(0.38, 0.38, 0.42)),
    };
    matCache.set(scene, m);
  }
  return m;
}

/** A mineable boulder (low-poly rock) that can switch to a rubble pile. */
export function buildRock(scene: Scene, radius: number): RockModel {
  const mats = getMats(scene);
  const root = new TransformNode("rock", scene);
  const meshes: AbstractMesh[] = [];

  // ---- alive rock ----
  const aliveG = new TransformNode("rockAlive", scene);
  aliveG.parent = root;
  const rock = MeshBuilder.CreateIcoSphere(
    "rockMesh",
    { radius, subdivisions: 1, flat: true },
    scene,
  );
  rock.position.y = radius * 0.55;
  rock.scaling.set(1, 0.8, 1.05);
  rock.rotation.y = radius * 1.7;
  rock.material = mats.rock;
  rock.receiveShadows = true;
  rock.parent = aliveG;
  meshes.push(rock);

  // ---- rubble (after mining) ----
  const rubbleG = new TransformNode("rockRubble", scene);
  rubbleG.parent = root;
  const rubbleMeshes: AbstractMesh[] = [];
  const chunks = 4;
  for (let i = 0; i < chunks; i++) {
    const r = radius * (0.3 + (i % 2) * 0.12);
    const chunk = MeshBuilder.CreateIcoSphere(
      "rubble",
      { radius: r, subdivisions: 1, flat: true },
      scene,
    );
    const a = (i / chunks) * Math.PI * 2;
    chunk.position.set(Math.cos(a) * radius * 0.45, r * 0.4, Math.sin(a) * radius * 0.45);
    chunk.scaling.set(1, 0.55, 1);
    chunk.rotation.y = a;
    chunk.material = mats.rubble;
    chunk.receiveShadows = true;
    chunk.parent = rubbleG;
    meshes.push(chunk);
    rubbleMeshes.push(chunk);
  }
  rubbleG.setEnabled(false);

  const DEAD_HOLD = 10; // seconds the rubble lingers before fading
  const DEAD_FADE = 0.7;
  let shakeT = 0;
  let phase: "alive" | "dead" | "hidden" = "alive";
  let deadT = 0;

  return {
    root,
    meshes,
    setAlive: (alive) => {
      if (alive) {
        aliveG.setEnabled(true);
        rubbleG.setEnabled(false);
        for (const m of rubbleMeshes) m.visibility = 1;
        phase = "alive";
      } else {
        aliveG.setEnabled(false);
        if (phase === "alive") {
          // just mined: show rubble, then it'll hold 10s and fade out
          rubbleG.setEnabled(true);
          for (const m of rubbleMeshes) m.visibility = 1;
          phase = "dead";
          deadT = 0;
        }
      }
    },
    shake: () => {
      shakeT = 0.22;
    },
    update: (dt) => {
      if (shakeT > 0) {
        shakeT -= dt;
        const k = Math.max(0, shakeT / 0.22);
        aliveG.position.x = Math.sin(shakeT * 70) * 0.06 * k;
      } else if (aliveG.position.x !== 0) {
        aliveG.position.x = 0;
      }
      if (phase === "dead") {
        deadT += dt;
        if (deadT > DEAD_HOLD) {
          const k = Math.min(1, (deadT - DEAD_HOLD) / DEAD_FADE);
          for (const m of rubbleMeshes) m.visibility = 1 - k;
          if (k >= 1) {
            rubbleG.setEnabled(false);
            phase = "hidden"; // stays gone until the server respawns the rock
          }
        }
      }
    },
    dispose: () => {
      root.dispose();
    },
  };
}
