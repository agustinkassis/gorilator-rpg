import { ArcRotateCamera, Camera, Scene, Vector3 } from "@babylonjs/core";

/** Half-height of the orthographic view, in world units. Smaller = more zoomed in.
 *  7.56 = 6.3 × 1.2, so gameplay is 20% farther out than before. */
const ORTHO_HALF_HEIGHT = 7.56;

/** Dev Mode can pull the camera back up to this many × the normal play zoom. */
export const MAX_DEV_ZOOM = 6;
let zoom = 1; // 1 = normal play zoom; grows toward MAX_DEV_ZOOM when zoomed out in Dev Mode

/** Current zoom-out factor (1 = normal). */
export function getCameraZoom(): number {
  return zoom;
}

/** Set the zoom-out factor (clamped to [1, MAX_DEV_ZOOM]) and apply it. */
export function setCameraZoom(camera: ArcRotateCamera, factor: number) {
  zoom = Math.max(1, Math.min(MAX_DEV_ZOOM, factor));
  applyOrthoSize(camera);
}

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
  const h = ORTHO_HALF_HEIGHT * zoom;
  camera.orthoTop = h;
  camera.orthoBottom = -h;
  camera.orthoLeft = -h * aspect;
  camera.orthoRight = h * aspect;
}
