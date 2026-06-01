import {
  Engine,
  Scene,
  Color3,
  Color4,
  Vector3,
  HemisphericLight,
  DirectionalLight,
  ShadowGenerator,
  AnimationPropertiesOverride,
  Mesh,
  ArcRotateCamera,
} from "@babylonjs/core";
import { createIsoCamera } from "./camera";
import { createEnvironment } from "./environment";

export interface SceneBundle {
  scene: Scene;
  camera: ArcRotateCamera;
  ground: Mesh;
  shadow: ShadowGenerator;
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
  // Fixed-size shadow frustum; the Game re-centres it on the player every frame so
  // shadows stay crisp on the big map instead of being stretched over the whole world.
  sun.autoUpdateExtends = false;
  sun.orthoLeft = -40;
  sun.orthoRight = 40;
  sun.orthoTop = 40;
  sun.orthoBottom = -40;
  sun.shadowMinZ = 80;
  sun.shadowMaxZ = 180;
  sun.position = new Vector3(51, 102, 61);

  const shadow = new ShadowGenerator(2048, sun);
  // Percentage-closer filtering casts a crisp, object-shaped silhouette on the
  // floor (the old blur-exponential map with a 20px kernel smeared every shadow
  // into a shapeless blob). PCF only softens the silhouette's edge, so each
  // shadow keeps the outline of the object that cast it.
  shadow.usePercentageCloserFiltering = true;
  shadow.filteringQuality = ShadowGenerator.QUALITY_HIGH;
  shadow.bias = 0.0009; // prevent self-shadow acne on flat faces
  shadow.normalBias = 0.02; // ...and on faces angled away from the sun
  shadow.darkness = 0.18; // strong enough that every object's shadow reads on the grass

  const { ground, shadowCasters } = createEnvironment(scene);
  for (const m of shadowCasters) shadow.addShadowCaster(m);

  return { scene, camera, ground, shadow };
}
