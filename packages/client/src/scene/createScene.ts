import {
  Engine,
  Scene,
  Color3,
  Color4,
  Vector3,
  HemisphericLight,
  DirectionalLight,
  AnimationPropertiesOverride,
  Mesh,
  ArcRotateCamera,
} from "@babylonjs/core";
import { createIsoCamera } from "./camera";
import { createEnvironment } from "./environment";
import { ContactShadowSystem } from "./contactShadows";

export interface SceneBundle {
  scene: Scene;
  camera: ArcRotateCamera;
  ground: Mesh;
  shadows: ContactShadowSystem;
}

export function createScene(engine: Engine): SceneBundle {
  const scene = new Scene(engine);
  scene.clearColor = new Color4(0.05, 0.06, 0.09, 1);
  scene.ambientColor = new Color3(0.3, 0.3, 0.36);

  // Global animation blending so state changes (idle->walk->attack) cross-fade.
  scene.animationPropertiesOverride = new AnimationPropertiesOverride();
  scene.animationPropertiesOverride.enableBlending = true;
  scene.animationPropertiesOverride.blendingSpeed = 0.08;
  scene.animationPropertiesOverride.loopMode = 1;

  const camera = createIsoCamera(scene);

  const hemi = new HemisphericLight("hemi", new Vector3(0, 1, 0), scene);
  // Kept fairly low so it doesn't flood the shadows with fill light and wash out
  // their shape — the directional "sun" does most of the lighting.
  hemi.intensity = 0.4;
  hemi.groundColor = new Color3(0.2, 0.2, 0.26);

  const sun = new DirectionalLight("sun", new Vector3(-1, -2, -1.2), scene);
  sun.intensity = 1.5;
  sun.position = new Vector3(51, 102, 61);
  sun.autoUpdateExtends = true;
  sun.autoCalcShadowZBounds = true;

  const shadows = new ContactShadowSystem(scene, sun);
  const { ground } = createEnvironment(scene);

  return { scene, camera, ground, shadows };
}
