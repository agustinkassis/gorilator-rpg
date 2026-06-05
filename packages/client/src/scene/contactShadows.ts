import {
  AbstractMesh,
  Color3,
  Constants,
  DirectionalLight,
  Material,
  Mesh,
  RenderTargetTexture,
  Scene,
  ShadowGenerator,
  StandardMaterial,
  TransformNode,
  Vector3,
  VertexBuffer,
  VertexData,
} from "@babylonjs/core";

export type ContactShadowShape = "character" | "pickup" | "structure";

export interface ContactShadowOptions {
  name?: string;
  shape?: ContactShadowShape;
  x?: number;
  z?: number;
  width?: number;
  depth?: number;
  opacity?: number;
  height?: number;
  affectCharacters?: boolean;
}

export interface ProjectedContactShadowOptions extends ContactShadowOptions {
  root: TransformNode;
  casters: AbstractMesh[];
  castStaticShadow?: boolean;
  receiveShadows?: boolean;
}

const SHADOW_Y = 0.02;
const SHADOW_SEGMENTS = 56;
const GROUND_SHADOW_OFFSET = 0.32;
const MIN_PROJECTED_POINTS = 8;
const INNER_SHADOW_ALPHA = 0.9;
const MID_SHADOW_ALPHA = 0.36;
const OUTER_SHADOW_ALPHA = 0;
const SHADOW_FADE_INSET = 0.16;
const SHADOW_FADE_OUTSET = 0.46;
const STRUCTURE_SHADOW_OPACITY = 0.44;
const SHADE_SAMPLE_DIRECTIONS = [
  { x: 1, z: 0 },
  { x: -1, z: 0 },
  { x: 0, z: 1 },
  { x: 0, z: -1 },
  { x: 0.7071, z: 0.7071 },
  { x: -0.7071, z: 0.7071 },
  { x: 0.7071, z: -0.7071 },
  { x: -0.7071, z: -0.7071 },
] as const;

function clamp01(v: number): number {
  return Math.max(0, Math.min(1, v));
}

interface ShadowPoint {
  x: number;
  z: number;
}

interface ShadowRings {
  mid: ShadowPoint[];
  outer: ShadowPoint[];
}

interface ShadowBounds {
  minX: number;
  maxX: number;
  minZ: number;
  maxZ: number;
}

interface CachedShadowRings extends ShadowRings {
  bounds: ShadowBounds;
}

function shapePoint(shape: ContactShadowShape, angle: number, radius: number): { x: number; z: number } {
  const c = Math.cos(angle);
  const s = Math.sin(angle);
  if (shape !== "structure") return { x: c * radius * 0.5, z: s * radius * 0.5 };

  // A superellipse makes structure shadows feel broader and less perfectly circular
  // while staying one cheap projected mesh.
  const power = 0.62;
  return {
    x: Math.sign(c) * Math.pow(Math.abs(c), power) * radius * 0.5,
    z: Math.sign(s) * Math.pow(Math.abs(s), power) * radius * 0.5,
  };
}

function ringPoint(center: ShadowPoint, edge: ShadowPoint, offset: number): ShadowPoint {
  const dx = edge.x - center.x;
  const dz = edge.z - center.z;
  const len = Math.hypot(dx, dz);
  if (len < 1e-4) return edge;
  const dist = Math.max(0.02, len + offset);
  return {
    x: center.x + (dx / len) * dist,
    z: center.z + (dz / len) * dist,
  };
}

function pointInPolygon(point: ShadowPoint, polygon: ShadowPoint[]): boolean {
  let inside = false;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const pi = polygon[i];
    const pj = polygon[j];
    const intersects =
      pi.z > point.z !== pj.z > point.z &&
      point.x < ((pj.x - pi.x) * (point.z - pi.z)) / (pj.z - pi.z + 1e-8) + pi.x;
    if (intersects) inside = !inside;
  }
  return inside;
}

function distanceToSegment(point: ShadowPoint, a: ShadowPoint, b: ShadowPoint): number {
  const dx = b.x - a.x;
  const dz = b.z - a.z;
  const lenSq = dx * dx + dz * dz;
  if (lenSq < 1e-8) return Math.hypot(point.x - a.x, point.z - a.z);
  const t = clamp01(((point.x - a.x) * dx + (point.z - a.z) * dz) / lenSq);
  return Math.hypot(point.x - (a.x + dx * t), point.z - (a.z + dz * t));
}

function distanceToPolygon(point: ShadowPoint, polygon: ShadowPoint[]): number {
  let best = Number.POSITIVE_INFINITY;
  for (let i = 0; i < polygon.length; i++) {
    best = Math.min(best, distanceToSegment(point, polygon[i], polygon[(i + 1) % polygon.length]));
  }
  return best;
}

function readShadowRings(mesh: Mesh): ShadowRings | null {
  const positions = mesh.getVerticesData(VertexBuffer.PositionKind);
  if (!positions) return null;
  const vertices = positions.length / 3;
  const segments = Math.floor((vertices - 1) / 3);
  if (segments < 3) return null;
  const mid: ShadowPoint[] = [];
  const outer: ShadowPoint[] = [];
  for (let i = 0; i < segments; i++) {
    const midIndex = (1 + i * 3 + 1) * 3;
    const outerIndex = (1 + i * 3 + 2) * 3;
    mid.push({ x: positions[midIndex], z: positions[midIndex + 2] });
    outer.push({ x: positions[outerIndex], z: positions[outerIndex + 2] });
  }
  return { mid, outer };
}

function createShadowMesh(
  scene: Scene,
  name: string,
  shape: ContactShadowShape,
  width = 1,
  depth = 1,
): Mesh {
  const mesh = new Mesh(name, scene);
  const positions: number[] = [0, 0, 0];
  const normals: number[] = [0, 1, 0];
  const colors: number[] = [0, 0, 0, INNER_SHADOW_ALPHA];
  const indices: number[] = [];
  const center = { x: 0, z: 0 };

  for (let i = 0; i < SHADOW_SEGMENTS; i++) {
    const angle = (i / SHADOW_SEGMENTS) * Math.PI * 2;
    const p = shapePoint(shape, angle, 1);
    const mid = { x: p.x * width, z: p.z * depth };
    const inner = ringPoint(center, mid, -SHADOW_FADE_INSET);
    const outer = ringPoint(center, mid, SHADOW_FADE_OUTSET);
    positions.push(inner.x, 0, inner.z, mid.x, 0, mid.z, outer.x, 0, outer.z);
    normals.push(0, 1, 0, 0, 1, 0, 0, 1, 0);
    colors.push(0, 0, 0, INNER_SHADOW_ALPHA, 0, 0, 0, MID_SHADOW_ALPHA, 0, 0, 0, OUTER_SHADOW_ALPHA);
  }

  for (let i = 0; i < SHADOW_SEGMENTS; i++) {
    const base = 1 + i * 3;
    const next = 1 + ((i + 1) % SHADOW_SEGMENTS) * 3;
    const inner = base;
    const mid = base + 1;
    const outer = base + 2;
    const nextInner = next;
    const nextMid = next + 1;
    const nextOuter = next + 2;

    indices.push(0, inner, nextInner);
    indices.push(inner, mid, nextMid, inner, nextMid, nextInner);
    indices.push(mid, outer, nextOuter, mid, nextOuter, nextMid);
  }

  const data = new VertexData();
  data.positions = positions;
  data.normals = normals;
  data.colors = colors;
  data.hasVertexAlpha = true;
  data.indices = indices;
  data.applyToMesh(mesh, true);
  mesh.useVertexColors = true;
  mesh.hasVertexAlpha = true;
  return mesh;
}

function cross(o: ShadowPoint, a: ShadowPoint, b: ShadowPoint): number {
  return (a.x - o.x) * (b.z - o.z) - (a.z - o.z) * (b.x - o.x);
}

function convexHull(points: ShadowPoint[]): ShadowPoint[] {
  const sorted = [...points]
    .filter((p) => Number.isFinite(p.x) && Number.isFinite(p.z))
    .sort((a, b) => a.x - b.x || a.z - b.z);
  const unique: ShadowPoint[] = [];
  for (const p of sorted) {
    const prev = unique[unique.length - 1];
    if (!prev || Math.abs(prev.x - p.x) > 0.015 || Math.abs(prev.z - p.z) > 0.015) {
      unique.push(p);
    }
  }
  if (unique.length <= 3) return unique;

  const lower: ShadowPoint[] = [];
  for (const p of unique) {
    while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], p) <= 0) {
      lower.pop();
    }
    lower.push(p);
  }

  const upper: ShadowPoint[] = [];
  for (let i = unique.length - 1; i >= 0; i--) {
    const p = unique[i];
    while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], p) <= 0) {
      upper.pop();
    }
    upper.push(p);
  }

  lower.pop();
  upper.pop();
  return lower.concat(upper);
}

function createProjectedShadowMesh(
  scene: Scene,
  name: string,
  root: TransformNode,
  casters: AbstractMesh[],
  sunDirection: Vector3,
): Mesh | null {
  root.computeWorldMatrix(true);
  const rootPos = root.getAbsolutePosition();
  const dir = sunDirection.clone().normalize();
  if (Math.abs(dir.y) < 1e-4) dir.y = -1;
  const points: ShadowPoint[] = [];
  const world = Vector3.Zero();

  for (const caster of casters) {
    if (!caster.isEnabled(true) || caster.getTotalVertices() === 0) continue;
    const positions = caster.getVerticesData(VertexBuffer.PositionKind);
    if (!positions) continue;
    const matrix = caster.computeWorldMatrix(true);
    for (let i = 0; i < positions.length; i += 3) {
      Vector3.TransformCoordinatesFromFloatsToRef(positions[i], positions[i + 1], positions[i + 2], matrix, world);
      const t = (SHADOW_Y - world.y) / dir.y;
      points.push({
        x: world.x + dir.x * t - rootPos.x,
        z: world.z + dir.z * t - rootPos.z,
      });
    }
  }

  const hull = convexHull(points);
  if (hull.length < MIN_PROJECTED_POINTS) return null;

  const center = hull.reduce(
    (acc, p) => {
      acc.x += p.x;
      acc.z += p.z;
      return acc;
    },
    { x: 0, z: 0 },
  );
  center.x /= hull.length;
  center.z /= hull.length;

  const positions: number[] = [center.x, 0, center.z];
  const normals: number[] = [0, 1, 0];
  const colors: number[] = [0, 0, 0, INNER_SHADOW_ALPHA];
  const indices: number[] = [];
  for (const p of hull) {
    const inner = ringPoint(center, p, -SHADOW_FADE_INSET);
    const outer = ringPoint(center, p, SHADOW_FADE_OUTSET);
    positions.push(
      inner.x,
      0,
      inner.z,
      p.x,
      0,
      p.z,
      outer.x,
      0,
      outer.z,
    );
    normals.push(0, 1, 0, 0, 1, 0, 0, 1, 0);
    colors.push(0, 0, 0, INNER_SHADOW_ALPHA, 0, 0, 0, MID_SHADOW_ALPHA, 0, 0, 0, OUTER_SHADOW_ALPHA);
  }
  for (let i = 0; i < hull.length; i++) {
    const base = 1 + i * 3;
    const next = 1 + ((i + 1) % hull.length) * 3;
    const inner = base;
    const mid = base + 1;
    const outer = base + 2;
    const nextInner = next;
    const nextMid = next + 1;
    const nextOuter = next + 2;

    indices.push(0, inner, nextInner);
    indices.push(inner, mid, nextMid, inner, nextMid, nextInner);
    indices.push(mid, outer, nextOuter, mid, nextOuter, nextMid);
  }

  const mesh = new Mesh(name, scene);
  const data = new VertexData();
  data.positions = positions;
  data.normals = normals;
  data.colors = colors;
  data.hasVertexAlpha = true;
  data.indices = indices;
  data.applyToMesh(mesh, true);
  mesh.useVertexColors = true;
  mesh.hasVertexAlpha = true;
  return mesh;
}

export class ContactShadowHandle {
  private baseX = 0;
  private baseZ = 0;
  private width = 1;
  private depth = 1;
  private opacity = 0.34;
  private height = 0;
  private localEnabled = true;
  private disposed = false;
  private readonly rings: ShadowRings | null;
  private worldRings: CachedShadowRings | null = null;
  private geometryDirty = true;

  constructor(
    private system: ContactShadowSystem,
    readonly mesh: Mesh,
    opts: Required<Pick<ContactShadowOptions, "x" | "z" | "width" | "depth" | "opacity" | "height">>,
    private projected = false,
    private bakedSize = false,
    private onDispose?: () => void,
    private fixedOpacity?: number,
  ) {
    this.rings = readShadowRings(mesh);
    this.baseX = opts.x;
    this.baseZ = opts.z;
    this.width = opts.width;
    this.depth = opts.depth;
    this.opacity = opts.opacity;
    this.height = opts.height;
    this.apply();
  }

  setPosition(x: number, z: number, height = this.height) {
    if (
      Math.abs(x - this.baseX) < 1e-4 &&
      Math.abs(z - this.baseZ) < 1e-4 &&
      Math.abs(height - this.height) < 1e-4
    ) {
      return;
    }
    this.baseX = x;
    this.baseZ = z;
    this.height = height;
    this.apply();
  }

  setHeight(height: number) {
    if (Math.abs(height - this.height) < 1e-4) return;
    this.height = height;
    this.apply();
  }

  setSize(width: number, depth: number) {
    const nextWidth = Math.max(0.05, width);
    const nextDepth = Math.max(0.05, depth);
    if (Math.abs(nextWidth - this.width) < 1e-4 && Math.abs(nextDepth - this.depth) < 1e-4) return;
    this.width = nextWidth;
    this.depth = nextDepth;
    this.apply();
  }

  setOpacity(opacity: number) {
    const next = this.fixedOpacity ?? clamp01(opacity);
    if (Math.abs(next - this.opacity) < 1e-4) return;
    this.opacity = next;
    this.apply();
  }

  setEnabled(on: boolean) {
    if (on === this.localEnabled) return;
    this.localEnabled = on;
    this.apply();
  }

  refresh() {
    this.apply();
  }

  sampleShadeFootprint(x: number, z: number, radius: number): number {
    if (
      this.disposed ||
      !this.system.isEnabled() ||
      !this.localEnabled ||
      !this.mesh.isEnabled(false) ||
      this.mesh.visibility <= 0.01
    ) {
      return 0;
    }

    const cached = this.ensureWorldRings();
    if (!cached) return 0;
    const b = cached.bounds;
    if (x + radius < b.minX || x - radius > b.maxX || z + radius < b.minZ || z - radius > b.maxZ) return 0;

    let shade = this.sampleWorldPoint(x, z, cached);
    if (radius > 0.01) {
      for (const dir of SHADE_SAMPLE_DIRECTIONS) {
        shade = Math.max(shade, this.sampleWorldPoint(x + dir.x * radius, z + dir.z * radius, cached));
      }
    }
    return shade;
  }

  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    this.onDispose?.();
    this.system.unregister(this);
    this.mesh.dispose();
  }

  private apply() {
    if (this.disposed) return;
    // Projected silhouettes already encode object height in their baked 2D shape.
    // Height-based fading is only for airborne contact shadows, such as throws.
    const lift = this.projected ? 0 : Math.max(0, this.height);
    const airborne = clamp01(lift / 3);
    const offset = this.system.offsetForHeight(lift, !this.projected);
    const stretch = this.projected ? 1 + airborne * 0.18 : 1 + airborne * 0.55;
    const soften = 1 + airborne * 0.22;
    this.mesh.position.set(this.baseX + offset.x, SHADOW_Y, this.baseZ + offset.z);
    this.mesh.scaling.set(
      this.bakedSize ? soften : this.width * soften,
      1,
      this.bakedSize ? stretch : this.depth * stretch,
    );
    this.mesh.visibility = this.opacity * (1 - airborne * 0.68);
    this.mesh.setEnabled(this.system.isEnabled() && this.localEnabled && this.mesh.visibility > 0.01);
    this.geometryDirty = true;
  }

  private ensureWorldRings(): CachedShadowRings | null {
    if (!this.rings) return null;
    if (!this.geometryDirty && this.worldRings) return this.worldRings;

    const matrix = this.mesh.computeWorldMatrix(true).m;
    const transform = (ring: ShadowPoint[]): ShadowPoint[] =>
      ring.map((p) => ({
        x: p.x * matrix[0] + p.z * matrix[8] + matrix[12],
        z: p.x * matrix[2] + p.z * matrix[10] + matrix[14],
      }));
    const mid = transform(this.rings.mid);
    const outer = transform(this.rings.outer);
    const bounds = outer.reduce<ShadowBounds>(
      (acc, p) => ({
        minX: Math.min(acc.minX, p.x),
        maxX: Math.max(acc.maxX, p.x),
        minZ: Math.min(acc.minZ, p.z),
        maxZ: Math.max(acc.maxZ, p.z),
      }),
      { minX: Infinity, maxX: -Infinity, minZ: Infinity, maxZ: -Infinity },
    );
    this.worldRings = { mid, outer, bounds };
    this.geometryDirty = false;
    return this.worldRings;
  }

  private sampleWorldPoint(x: number, z: number, rings: CachedShadowRings): number {
    const point = { x, z };
    if (!pointInPolygon(point, rings.outer)) return 0;
    if (pointInPolygon(point, rings.mid)) return this.mesh.visibility;

    const midDist = distanceToPolygon(point, rings.mid);
    const outerDist = distanceToPolygon(point, rings.outer);
    const fade = outerDist / Math.max(1e-4, midDist + outerDist);
    return this.mesh.visibility * clamp01(fade);
  }
}

export class ContactShadowSystem {
  private readonly material: StandardMaterial;
  private readonly staticShadow: ShadowGenerator;
  private readonly handles = new Set<ContactShadowHandle>();
  private readonly shadingHandles = new Set<ContactShadowHandle>();
  private readonly staticCasters = new Set<AbstractMesh>();
  private readonly sunDir: Vector3;
  private readonly sunXZ: Vector3;
  private readonly sunYaw: number;
  private enabled = true;

  constructor(
    private scene: Scene,
    private sun: DirectionalLight,
  ) {
    this.sunDir = sun.direction.clone().normalize();
    this.sun.shadowOrthoScale = Math.max(this.sun.shadowOrthoScale, 0.55);
    this.material = new StandardMaterial("contactShadowMaterial", scene);
    this.material.diffuseColor = Color3.Black();
    this.material.emissiveColor = Color3.Black();
    this.material.specularColor = Color3.Black();
    this.material.alpha = 0.88;
    this.material.disableLighting = true;
    this.material.backFaceCulling = false;
    this.material.transparencyMode = Material.MATERIAL_ALPHABLEND;
    this.material.disableDepthWrite = true;
    this.material.depthFunction = Constants.LEQUAL;

    this.staticShadow = new ShadowGenerator(1024, sun);
    this.staticShadow.useBlurExponentialShadowMap = true;
    this.staticShadow.filteringQuality = ShadowGenerator.QUALITY_LOW;
    this.staticShadow.blurKernel = 32;
    this.staticShadow.bias = 0.003;
    this.staticShadow.normalBias = 0.035;
    this.staticShadow.setDarkness(0.52);
    const shadowMap = this.staticShadow.getShadowMap();
    if (shadowMap) shadowMap.refreshRate = RenderTargetTexture.REFRESHRATE_RENDER_ONCE;

    const flat = new Vector3(sun.direction.x, 0, sun.direction.z);
    if (flat.lengthSquared() < 1e-6) flat.set(1, 0, 0);
    this.sunXZ = flat.normalize();
    this.sunYaw = Math.atan2(this.sunXZ.x, this.sunXZ.z);
  }

  add(opts: ContactShadowOptions = {}): ContactShadowHandle {
    const shape = opts.shape ?? "character";
    const width = opts.width ?? 1.4;
    const depth = opts.depth ?? 1.8;
    const opacity = shape === "structure" ? STRUCTURE_SHADOW_OPACITY : opts.opacity ?? 0.34;
    const mesh = createShadowMesh(this.scene, opts.name ?? `contactShadow_${shape}`, shape, width, depth);
    mesh.material = this.material;
    mesh.isPickable = false;
    mesh.rotation.y = this.sunYaw;
    mesh.alwaysSelectAsActiveMesh = false;
    mesh.renderingGroupId = 0;
    mesh.alphaIndex = -100;

    const handle = new ContactShadowHandle(this, mesh, {
      x: opts.x ?? 0,
      z: opts.z ?? 0,
      width,
      depth,
      opacity,
      height: opts.height ?? 0,
    }, false, true, undefined, shape === "structure" ? STRUCTURE_SHADOW_OPACITY : undefined);
    this.handles.add(handle);
    if (opts.affectCharacters ?? shape === "structure") this.shadingHandles.add(handle);
    return handle;
  }

  addProjected(opts: ProjectedContactShadowOptions): ContactShadowHandle {
    const shape = opts.shape ?? "structure";
    const opacity = shape === "structure" ? STRUCTURE_SHADOW_OPACITY : opts.opacity ?? 0.34;
    if (opts.receiveShadows !== false) this.prepareReceivers(opts.casters);
    const mesh =
      createProjectedShadowMesh(
        this.scene,
        opts.name ?? `projectedContactShadow_${shape}`,
        opts.root,
        opts.casters,
        this.sunDir,
      ) ?? createShadowMesh(
        this.scene,
        opts.name ?? `contactShadow_${shape}`,
        shape,
        opts.width ?? 1,
        opts.depth ?? 1,
      );
    mesh.material = this.material;
    mesh.isPickable = false;
    mesh.rotation.y = 0;
    mesh.alwaysSelectAsActiveMesh = false;
    mesh.renderingGroupId = 0;
    mesh.alphaIndex = -100;
    const staticCasters = opts.castStaticShadow ? this.registerStaticCasters(opts.casters) : [];

    const handle = new ContactShadowHandle(
      this,
      mesh,
      {
        x: opts.x ?? opts.root.position.x,
        z: opts.z ?? opts.root.position.z,
        width: opts.width ?? 1,
        depth: opts.depth ?? 1,
        opacity,
        height: opts.height ?? 0,
      },
      true,
      true,
      staticCasters.length > 0 ? () => this.removeStaticCasters(staticCasters) : undefined,
      shape === "structure" ? STRUCTURE_SHADOW_OPACITY : undefined,
    );
    this.handles.add(handle);
    if (opts.affectCharacters ?? shape === "structure") this.shadingHandles.add(handle);
    return handle;
  }

  addWorldObject(opts: ProjectedContactShadowOptions): ContactShadowHandle {
    // One-stop setup for concrete/static models: pre-project their mesh silhouette
    // for the ground contact shadow, make their materials receive shadows, and add
    // them to the render-once static caster map.
    return this.addProjected({
      shape: "structure",
      opacity: 0.42,
      ...opts,
      castStaticShadow: opts.castStaticShadow ?? true,
      receiveShadows: opts.receiveShadows ?? true,
    });
  }

  setEnabled(on: boolean) {
    this.enabled = on;
    this.sun.shadowEnabled = on;
    for (const h of this.handles) h.refresh();
    if (on) this.refreshStaticShadows();
  }

  isEnabled(): boolean {
    return this.enabled;
  }

  offsetForHeight(height: number, includeGroundOffset = true): { x: number; z: number } {
    const d = (includeGroundOffset ? GROUND_SHADOW_OFFSET : 0) + Math.min(0.85, Math.max(0, height) * 0.2);
    return { x: this.sunXZ.x * d, z: this.sunXZ.z * d };
  }

  unregister(handle: ContactShadowHandle) {
    this.handles.delete(handle);
    this.shadingHandles.delete(handle);
  }

  sampleStaticShade(x: number, z: number, radius = 0): number {
    if (!this.enabled || this.shadingHandles.size === 0) return 0;
    let shade = 0;
    for (const handle of this.shadingHandles) {
      const next = handle.sampleShadeFootprint(x, z, radius);
      shade = 1 - (1 - shade) * (1 - next);
      if (shade > 0.5) break;
    }
    return Math.min(0.34, shade * 0.82);
  }

  addReceivers(meshes: AbstractMesh[]): void {
    this.prepareReceivers(meshes, true);
  }

  private prepareReceivers(meshes: AbstractMesh[], forceMaterialRefresh = false): void {
    for (const mesh of meshes) {
      if (forceMaterialRefresh && mesh.receiveShadows) mesh.receiveShadows = false;
      mesh.receiveShadows = true;
    }
  }

  private registerStaticCasters(meshes: AbstractMesh[]): AbstractMesh[] {
    const added: AbstractMesh[] = [];
    for (const mesh of meshes) {
      if (this.staticCasters.has(mesh) || mesh.getTotalVertices() === 0) continue;
      this.staticCasters.add(mesh);
      this.staticShadow.addShadowCaster(mesh);
      added.push(mesh);
    }
    if (added.length > 0) this.refreshStaticShadows();
    return added;
  }

  addStaticCaster(mesh: AbstractMesh): void {
    this.registerStaticCasters([mesh]);
  }

  addStaticCasters(meshes: AbstractMesh[]): void {
    this.registerStaticCasters(meshes);
  }

  removeStaticCaster(mesh: AbstractMesh): void {
    if (!this.staticCasters.delete(mesh)) return;
    this.staticShadow.removeShadowCaster(mesh);
    this.refreshStaticShadows();
  }

  removeStaticCasters(meshes: AbstractMesh[]): void {
    let changed = false;
    for (const mesh of meshes) {
      if (!this.staticCasters.delete(mesh)) continue;
      this.staticShadow.removeShadowCaster(mesh);
      changed = true;
    }
    if (changed) this.refreshStaticShadows();
  }

  refreshStaticShadows(): void {
    this.staticShadow.getShadowMap()?.resetRefreshCounter();
  }
}
