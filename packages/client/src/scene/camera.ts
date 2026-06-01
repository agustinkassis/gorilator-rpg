import { ArcRotateCamera, Camera, Scene, Vector3 } from "@babylonjs/core";

/** Half-height of the orthographic view, in world units. Smaller = more zoomed in. */
const ORTHO_HALF_HEIGHT = 8.5;

/**
 * A locked isometric camera: orthographic projection at the classic true-iso
 * angle (45° around Y, ~35.26° elevation → atan(1/√2) from horizontal). It does
 * not accept user rotation; the game pans it by moving `camera.target`.
 */
export function createIsoCamera(scene: Scene): ArcRotateCamera {
  const camera = new ArcRotateCamera(
    "iso",
    -Math.PI / 4, // alpha: 45° around Y
    Math.atan(Math.SQRT2), // beta from +Y (~54.7°) => ~35.26° above the horizon
    60, // radius (ortho zoom is driven by ortho* below, not this)
    Vector3.Zero(),
    scene,
  );
  camera.mode = Camera.ORTHOGRAPHIC_CAMERA;
  camera.minZ = 0.1;
  camera.maxZ = 1000;
  applyOrthoSize(camera);
  return camera;
}

/** Recompute orthographic frustum from the current aspect ratio (call on resize). */
export function applyOrthoSize(camera: ArcRotateCamera) {
  const engine = camera.getEngine();
  const aspect = engine.getRenderWidth() / engine.getRenderHeight();
  camera.orthoTop = ORTHO_HALF_HEIGHT;
  camera.orthoBottom = -ORTHO_HALF_HEIGHT;
  camera.orthoLeft = -ORTHO_HALF_HEIGHT * aspect;
  camera.orthoRight = ORTHO_HALF_HEIGHT * aspect;
}
