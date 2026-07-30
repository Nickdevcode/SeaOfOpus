/**
 * What you **see** of the damage: the breaches in the side and the water rising in the
 * hold.
 *
 * Two pieces, with opposite tricks that use the same table.
 *
 * **The hold's water** is a horizontal plane in the world — it has to be, or it would
 * heel along with the ship and give the sham away on the first wave. Since a plane is
 * infinite and the hold is not, the fragment converts its own position into the ship's
 * frame and discards itself when it falls outside the planking. It is exactly the clip
 * the ocean does in `hullClip`, **with the sign flipped**: there the sea disappears
 * inside the hull, here the water only exists inside the hull. Both read the same profile
 * texture, so they will never disagree about where the plank is.
 *
 * **The shot marks** are instances attached to the ship's model, oriented by the hull's
 * normal at that point and drawn by `BreachDecal`. They are not real decals (projection
 * onto the mesh): on a curved side, the difference between a mark resting on the surface
 * and a projected decal is millimeters, and the instance costs one matrix entry instead
 * of a whole render pass.
 *
 * **Every breach has two marks, and not one.** The side is 13 cm thick with planking on
 * both faces, so a ball that goes through it leaves a mark on the sea side *and* in the
 * hold. Drawing only the outer one was the strangest defect this file ever had: the
 * player went below to patch the breach and found an intact wall, and could nail the
 * plank up anyway because the repair's aim is by angle, not by radius. The hole worked
 * without existing.
 *
 * The two faces are not mirrors of each other. On the entry the powder rules (soot,
 * scorched rim); on the exit the fiber rules (big splinter, raw oak, the wet bottom of
 * the water coming in) — see `BreachFace`, in `BreachDecal`.
 *
 * The same mesh serves an open breach and a patched one — one attribute changes. A hull
 * that has taken a beating is a quilt of closed marks with one or another still gaping
 * open, and that reading only exists because both things are the same thing in different
 * states. It holds on both sides: from within, the plank is too narrow to cover the whole
 * breach, and what is left of the scar escapes around its edges.
 *
 * **The planks** are what gets nailed over the closed mark, one per repair. They arrive
 * through `PlankAsset`, which is asynchronous, so the pool is born empty and assembles
 * itself when the file lands — if it never lands, the breach still closes and the hull is
 * left with the scar and no wood.
 */

import * as THREE from 'three';
import { NOISE_GLSL } from '../shaders/noise';
import { HULL_PROFILE, getHullProfileTexture } from '../shaders/hullClip';
import { buildBreachGeometry, createBreachMaterial, type BreachSide } from './BreachDecal';
import { PLANK_TO_DECAL, PLANK_THICKNESS, loadPlank } from './PlankAsset';
import { DECK_Y, HALF_LENGTH, HULL_LENGTH, HULL_THICKNESS } from './ShipDimensions';
import type { Ship } from './Ship';

/**
 * Marks drawn at the same time per ship.
 *
 * It covers open **and** patched breaches in the same pool: `ShipDamage` caps each list
 * at 24, but the two added together would go past this in a long fight. When it
 * overflows, the open breaches go in first — they are the ones the player has to repair,
 * and a scar vanishing from the other side costs nothing.
 */
const MAX_SCARS = 32;

/**
 * Side of the water plane, in meters.
 *
 * It covers the hull (16 × 5 m) at any heading without having to turn along: the hull's
 * diagonal is 16.8 m, and the plane is square.
 */
const WATER_PLANE_SIZE = 18;

const WATER_VERTEX = /* glsl */ `
  varying vec3 vWorldPosition;

  void main() {
    vec4 world = modelMatrix * vec4(position, 1.0);
    vWorldPosition = world.xyz;
    gl_Position = projectionMatrix * viewMatrix * world;
  }
`;

const WATER_FRAGMENT = /* glsl */ `
  uniform mat4 uShipInverse;
  uniform sampler2D uHullProfile;
  uniform float uTime;
  uniform vec3 uShallowColor;
  uniform vec3 uDeepColor;

  varying vec3 vWorldPosition;

  ${NOISE_GLSL}

  void main() {
    vec3 local = (uShipInverse * vec4(vWorldPosition, 1.0)).xyz;

    vec2 uv = vec2(
      (${HALF_LENGTH.toFixed(4)} - local.z) / ${HULL_LENGTH.toFixed(4)},
      (local.y - (${HULL_PROFILE.yMin.toFixed(4)})) / ${HULL_PROFILE.yRange.toFixed(4)}
    );
    if (any(lessThan(uv, vec2(0.0))) || any(greaterThan(uv, vec2(1.0)))) discard;

    // The margin comes in **subtracting** here: the sea grows to cover the planking,
    // this water shrinks so it does not leak outside it. Same table, flipped sign.
    float halfWidth = texture2D(uHullProfile, uv).r * ${HULL_PROFILE.scale.toFixed(4)};
    if (halfWidth <= 0.0 || abs(local.x) > halfWidth - ${HULL_PROFILE.margin.toFixed(4)}) discard;

    // Past the deck, the ship is already sinking and what you see is the sea outside,
    // not the water inside — letting it draw here would only create a sheet of water
    // going through the quarterdeck.
    if (local.y > ${(DECK_Y + 0.1).toFixed(3)}) discard;

    // Lapping: two noise layers walking in different directions, in the **ship's**
    // frame, because the water rocks along with the hull.
    float ripple = fbm(vec3(local.xz * 1.7 + vec2(uTime * 0.35, -uTime * 0.22), uTime * 0.25), 3, 2.1, 0.55);
    float sheen = smoothstep(0.55, 0.95, ripple);

    // Dark bottom at the edges, where the sheet meets the planking and disappears into
    // the shadow.
    float edge = smoothstep(halfWidth, halfWidth * 0.45, abs(local.x));
    vec3 color = mix(uShallowColor, uDeepColor, edge * 0.8);
    color += sheen * 0.16;

    gl_FragColor = vec4(color, 0.82);
  }
`;

/**
 * How far the mark sits off the side, in meters.
 *
 * One centimeter. The material's `polygonOffset` already handles the z-fighting; this
 * exists because the side is **curved** and the mark is flat: without the clearance, a
 * 90 cm mark pinned on the corner of a bow would sink in at the edges.
 */
const DECAL_LIFT = 0.012;

/**
 * How much bigger the inner mark is than the outer one.
 *
 * The ball does not open a cylinder: it goes in through a hole and comes out through a
 * cone. The exit face is always the bigger of the two, and 12% is enough for the eye to
 * register the difference when comparing both sides of the same breach without it turning
 * into caricature.
 */
const INNER_SCAR_SCALE = 1.12;

/**
 * Where the inner mark sits, measured from the **outer** surface.
 *
 * The inner planking is `HULL_THICKNESS` further in (see `buildInnerShell`, in
 * `HullGeometry`), and the mark has to sit **beyond** it, on the hold's side — hence the
 * addition. Subtracting was the obvious mistake to write, and its symptom was
 * instructive: the mark ended up buried 1 cm inside the wood, and what you saw in the
 * hold was only the splinters tall enough to pierce the planking — a ring of wood
 * floating on the wall, with no middle and no base. An already closed scar, whose
 * splinters are low, disappeared entirely.
 *
 * There are **two** values because the repair's plank passes through here. With the
 * breach open there is nothing in front and the mark uses the same generous clearance as
 * the outer face. With it patched, the plank's face is 6 mm from the planking (see
 * `PLANK_DEPTH`) and the mark has to fit into that gap: 2 mm, counting on the material's
 * `polygonOffset` for the rest.
 */
const INNER_DECAL_DEPTH_OPEN = HULL_THICKNESS + DECAL_LIFT;
const INNER_DECAL_DEPTH_CLOSED = HULL_THICKNESS + 0.002;

/**
 * Where the plank's **center** sits, measured **into** the hull.
 *
 * The plank is nailed on the inside, and not on the outside, because that is where the
 * player is when nailing it: they go down into the hold, stand facing the planking and
 * hold the button. A plank on the outside would be a repair only the enemy sees —
 * whoever did the work would never see their own work.
 *
 * The arithmetic is the side's thickness (the breach's `local` lives on the **outer**
 * surface), plus half a plank, plus 6 mm of clearance so the new wood does not fight the
 * planking in the z-buffer.
 */
const PLANK_DEPTH = HULL_THICKNESS + PLANK_THICKNESS * 0.5 + 0.006;

/**
 * The plank's maximum roll around the normal, in radians.
 *
 * ±23°. A plank nailed up in a hurry never comes out straight, but it does not come out
 * upright either: whoever patches a breach lays the piece **across** the hole, loosely
 * following the side's planking, because that is how it bites sound wood on both sides.
 */
const PLANK_ROLL = 0.4;

/** The plank's slide relative to the breach's center, in meters. */
const PLANK_SLIDE = 0.07;

const _inverse = new THREE.Matrix4();
const _quaternion = new THREE.Quaternion();
const _roll = new THREE.Quaternion();
const _matrix = new THREE.Matrix4();
const _basis = new THREE.Matrix4();
const _scale = new THREE.Vector3();
const _position = new THREE.Vector3();
const _normal = new THREE.Vector3();
const _flipped = new THREE.Vector3();
const _tangent = new THREE.Vector3();
const _bitangent = new THREE.Vector3();
const UP = new THREE.Vector3(0, 1, 0);
const ALONG = new THREE.Vector3(0, 0, 1);
const HIDDEN = new THREE.Vector3(0, 0, 0);
const ORIGIN = new THREE.Vector3(0, 0, 0);
const UNIT = new THREE.Vector3(1, 1, 1);

/**
 * Drawn radius of a breach of `area` square meters.
 *
 * The 3.4 is what separates the hole the water comes in through from the **mark** the
 * ball leaves around it: the area is hydraulic, and the stain of soot and splintered wood
 * is much larger than it. See the zone split in `BreachDecal`.
 */
function scarRadius(area: number): number {
  return Math.sqrt(area / Math.PI) * 3.4;
}

/**
 * A stable draw from the breach's identifier.
 *
 * Stable is the requirement: the plank's pose is recomputed every frame, and a
 * `Math.random()` here would make the wood shake on the side. Since the breach's `id`
 * travels to the `Patch` that replaces it, the plank is also born in exactly the pose the
 * breach's drawing had been seeding all along.
 */
function hash01(seed: number): number {
  const value = Math.sin(seed * 127.1 + 311.7) * 43758.5453;
  return value - Math.floor(value);
}

/**
 * The mark pool for **one** of the side's faces.
 *
 * It exists because the breach goes through: the ball goes in from outside and comes out
 * inside, and the two faces are drawn by independent instances. Separate meshes instead
 * of a single pool with twice the instances because the two faces run different shaders —
 * the inner one splinters more, darkens less and wets the bottom of the hole — and an
 * `InstancedMesh` only carries one material.
 *
 * The cost is one more draw call per ship, which at this scale does not measure; what you
 * gain is that each face picks its own constants with no branching in the other's shader.
 */
class ScarPool {
  readonly mesh: THREE.InstancedMesh;
  /** Per-instance seed: it varies soot and fiber from one mark to the next. */
  private readonly seed: THREE.InstancedBufferAttribute;
  /** `1` open breach, `0` patched breach. Read by the mark's shader. */
  private readonly open: THREE.InstancedBufferAttribute;

  constructor(name: string, side: BreachSide) {
    const geometry = buildBreachGeometry();
    this.seed = new THREE.InstancedBufferAttribute(new Float32Array(MAX_SCARS), 1);
    this.open = new THREE.InstancedBufferAttribute(new Float32Array(MAX_SCARS), 1);
    geometry.setAttribute('aSeed', this.seed);
    geometry.setAttribute('aOpen', this.open);

    this.mesh = new THREE.InstancedMesh(geometry, createBreachMaterial(side), MAX_SCARS);
    this.mesh.name = name;
    this.mesh.frustumCulled = false;
    // The splinters rise off the side and would cast a cutout shadow on the hull
    // itself; what you would gain in relief you would lose in soft blotches.
    this.mesh.castShadow = false;
    this.mesh.receiveShadow = true;
    this.mesh.count = MAX_SCARS;
    hideAll(this.mesh, MAX_SCARS);
  }

  write(index: number, radius: number, open: number, id: number): void {
    _scale.setScalar(radius);
    this.mesh.setMatrixAt(index, _matrix.compose(_position, _quaternion, _scale));
    // The seed comes from the **breach's id**, and not from the instance's index: the
    // two faces of the same hole have to draw the same silhouette, or the broken rim
    // inside does not match the one outside and the hole stops being one hole, going
    // through, and turns into two marks glued back to back. It is also what keeps the
    // mark from changing face when a neighboring breach closes and everyone shifts one
    // position in the pool.
    this.seed.setX(index, hash01(id));
    this.open.setX(index, open);
  }

  /** Shrinks everything from there on to zero and uploads the three lists to the GPU. */
  flush(from: number): void {
    for (let i = from; i < MAX_SCARS; i++) {
      this.mesh.setMatrixAt(i, _matrix.compose(ORIGIN, _quaternion.identity(), HIDDEN));
    }
    this.mesh.instanceMatrix.needsUpdate = true;
    this.seed.needsUpdate = true;
    this.open.needsUpdate = true;
  }

  dispose(): void {
    this.mesh.geometry.dispose();
    (this.mesh.material as THREE.Material).dispose();
    this.mesh.removeFromParent();
    this.mesh.dispose();
  }
}

export class DamageView {
  private readonly water: THREE.Mesh;
  private readonly waterMaterial: THREE.ShaderMaterial;
  /** The mark seen from the sea: where the ball went in. */
  private readonly outerScars: ScarPool;
  /** The mark seen from the hold: where it came out, and where the player repairs. */
  private readonly innerScars: ScarPool;
  /** It only exists after the plank's glb arrives — and it may never arrive. */
  private planks: THREE.InstancedMesh | null = null;
  private disposed = false;
  private time = 0;

  constructor(
    private readonly ship: Ship,
    scene: THREE.Scene,
  ) {
    this.waterMaterial = new THREE.ShaderMaterial({
      uniforms: {
        uShipInverse: { value: new THREE.Matrix4() },
        uHullProfile: { value: getHullProfileTexture() },
        uTime: { value: 0 },
        uShallowColor: { value: new THREE.Color(0.05, 0.13, 0.14) },
        uDeepColor: { value: new THREE.Color(0.01, 0.04, 0.05) },
      },
      vertexShader: WATER_VERTEX,
      fragmentShader: WATER_FRAGMENT,
      transparent: true,
      // Front and back: whoever is in the hold with water up to their waist sees the
      // sheet from below, and it has to go on existing.
      side: THREE.DoubleSide,
      depthWrite: false,
    });

    this.water = new THREE.Mesh(
      new THREE.PlaneGeometry(WATER_PLANE_SIZE, WATER_PLANE_SIZE),
      this.waterMaterial,
    );
    this.water.rotation.x = -Math.PI / 2;
    this.water.name = `${ship.name}-hold-water`;
    this.water.frustumCulled = false;
    this.water.visible = false;
    this.water.renderOrder = 2;
    scene.add(this.water);

    this.outerScars = new ScarPool(`${ship.name}-breaches`, 'outer');
    this.innerScars = new ScarPool(`${ship.name}-breaches-inner`, 'inner');
    ship.model.root.add(this.outerScars.mesh, this.innerScars.mesh);

    void this.attachPlanks();
  }

  update(dt: number): void {
    this.time += dt;
    this.updateWater();
    this.updateScars();
  }

  dispose(): void {
    this.disposed = true;
    this.water.geometry.dispose();
    this.waterMaterial.dispose();
    this.water.removeFromParent();
    this.outerScars.dispose();
    this.innerScars.dispose();
    if (this.planks) {
      // The geometry and the material belong to the module, and the other ship still
      // uses them: here only the instance is released.
      this.planks.removeFromParent();
      this.planks.dispose();
      this.planks = null;
    }
  }

  /**
   * Assembles the plank pool when the file arrives.
   *
   * The `disposed` guard is not fussiness: a match abandoned before the 64 KB land would
   * hang the mesh on a ship that has already left the scene, and it would stay alive
   * through the parent's reference until the end of the process.
   */
  private async attachPlanks(): Promise<void> {
    const asset = await loadPlank();
    if (!asset || this.disposed) return;

    this.planks = new THREE.InstancedMesh(asset.geometry, asset.material, MAX_SCARS);
    this.planks.name = `${this.ship.name}-patches`;
    this.planks.frustumCulled = false;
    this.planks.castShadow = true;
    this.planks.receiveShadow = true;
    this.planks.count = MAX_SCARS;
    hideAll(this.planks, MAX_SCARS);
    this.ship.model.root.add(this.planks);
  }

  private updateWater(): void {
    const surface = this.ship.damage.getWorldSurfaceY(this.ship.body);
    if (!Number.isFinite(surface)) {
      this.water.visible = false;
      return;
    }

    // The plane follows the ship in X/Z but ignores its rotation: water is horizontal.
    const root = this.ship.model.root;
    this.water.visible = true;
    this.water.position.set(root.position.x, surface, root.position.z);
    this.water.updateMatrixWorld();

    // The model's matrix is the frame's **interpolated** pose, and not the last physics
    // step's: using the body's would make the sheet shake against the planking at high
    // frame rates. `updateWorldMatrix` walks up the chain without descending into the
    // children because `syncModel` only writes position and quaternion — `matrixWorld` is
    // still what the *previous* frame's render left, and reading it would put the sheet
    // one frame behind the planking.
    root.updateWorldMatrix(true, false);
    _inverse.copy(root.matrixWorld).invert();
    (this.waterMaterial.uniforms.uShipInverse!.value as THREE.Matrix4).copy(_inverse);
    this.waterMaterial.uniforms.uTime!.value = this.time;
  }

  /**
   * Writes the frame's marks: the open breaches first, then the planked scars.
   *
   * The open ones come first because they are the ones competing for the `MAX_SCARS`
   * ceiling — a breach the player has to find cannot disappear to make room for an old
   * patch.
   */
  private updateScars(): void {
    const { breaches, patches } = this.ship.damage;
    let index = 0;
    let plankIndex = 0;

    for (const breach of breaches) {
      if (index >= MAX_SCARS) break;
      // The hole shrinks a little as the plank goes up, but it does not close: what
      // closes the breach is the wood that arrives at the end, and the shrinking exists
      // only so the effort shows on the hull before that.
      const radius = scarRadius(breach.area) * (1 - breach.repair * 0.18);
      this.writeScar(index++, breach.local, breach.normal, radius, 1, breach.id);
    }

    for (const patch of patches) {
      if (index >= MAX_SCARS) break;
      const radius = scarRadius(patch.area);
      this.writeScar(index++, patch.local, patch.normal, radius, 0, patch.id);
      if (this.planks) this.writePlank(plankIndex++, patch.local, patch.normal, patch.id);
    }

    this.outerScars.flush(index);
    this.innerScars.flush(index);

    if (!this.planks) return;
    for (let i = plankIndex; i < MAX_SCARS; i++) {
      this.planks.setMatrixAt(i, _matrix.compose(ORIGIN, _quaternion.identity(), HIDDEN));
    }
    this.planks.instanceMatrix.needsUpdate = true;
  }

  /**
   * Writes the **two** faces of the same breach: the one the sea sees and the one the
   * hold sees.
   *
   * A ball that opens a breach goes through the side, and a side is 13 cm thick with
   * planking on both faces. Drawing only the outer face left the player staring at an
   * intact wall exactly where they have to nail the plank — and the repair's aim, which
   * is by angle and not by radius, let them fix it anyway. The breach worked without
   * existing.
   *
   * The inner face is born from the same `local` and the same `normal`, with the sign
   * flipped: `orientDecal` receives the inverted normal and returns a basis that still
   * has X along the planking and Y pointing up (the two inversions cancel in the cross
   * product), so the wood's grain goes on running the right way along the hull and the
   * mark does not come out upside down.
   */
  private writeScar(
    index: number,
    local: THREE.Vector3,
    normal: THREE.Vector3,
    radius: number,
    open: number,
    id: number,
  ): void {
    orientDecal(normal, _quaternion);
    _position.copy(normal).multiplyScalar(DECAL_LIFT).add(local);
    this.outerScars.write(index, radius, open, id);

    orientDecal(_flipped.copy(normal).negate(), _quaternion);
    const depth = open > 0.5 ? INNER_DECAL_DEPTH_OPEN : INNER_DECAL_DEPTH_CLOSED;
    _position.copy(normal).multiplyScalar(-depth).add(local);
    this.innerScars.write(index, radius * INNER_SCAR_SCALE, open, id);
  }

  /**
   * Lays the plank over the scar, across it and a little out of plumb.
   *
   * The draw comes from the breach's `id`, so no two planks are ever alike and none of
   * them moves between frames. It decides two things: the roll around the normal and the
   * slide in the side's plane — which together are what separates "a plank nailed up by
   * someone in a hurry" from "a centered sticker".
   */
  private writePlank(index: number, local: THREE.Vector3, normal: THREE.Vector3, id: number): void {
    if (!this.planks) return;

    // `orientDecal` leaves `_tangent` and `_bitangent` ready as a side effect, and they
    // are what define the plane the plank slides in.
    orientDecal(normal, _quaternion);

    const roll = (hash01(id) * 2 - 1) * PLANK_ROLL;
    // The roll is around the **decal's** Z, and the decal's Z is the hull's normal: the
    // plank turns in the side's plane, which is where it rests.
    _roll.setFromAxisAngle(ALONG, roll);
    _quaternion.multiply(_roll).multiply(PLANK_TO_DECAL);

    const slideX = (hash01(id * 3.7 + 11) * 2 - 1) * PLANK_SLIDE;
    const slideY = (hash01(id * 7.3 + 29) * 2 - 1) * PLANK_SLIDE;

    _position
      .copy(normal)
      .multiplyScalar(-PLANK_DEPTH)
      .add(local)
      .addScaledVector(_tangent, slideX)
      .addScaledVector(_bitangent, slideY);

    this.planks.setMatrixAt(index, _matrix.compose(_position, _quaternion, UNIT));
  }
}

/**
 * The mark's two axes that lie **on** the side.
 *
 * `tangent` runs along the planking (bow to stern) and `bitangent` climbs it. Aligning
 * the decal this way is not fussiness: the wood's grain and the splinters are drawn along
 * the mark's X, and wood splits along the plank. With any old orientation, the cracks
 * would come out crossing the planking — which is the one thing wood does not do.
 */
function decalAxes(normal: THREE.Vector3, tangent: THREE.Vector3, bitangent: THREE.Vector3): void {
  tangent.crossVectors(UP, normal);
  // A breach in the keel or at the bottom of the bilge: the normal points down and the
  // product with the vertical degenerates. There the planking runs fore and aft anyway,
  // so the ship's axis serves.
  if (tangent.lengthSq() < 1e-6) tangent.copy(ALONG);
  tangent.normalize();
  bitangent.crossVectors(normal, tangent);
}

/** The mark's orientation: X along the planking, Y climbing, Z on the hull's normal. */
function orientDecal(normal: THREE.Vector3, out: THREE.Quaternion): void {
  decalAxes(normal, _tangent, _bitangent);
  _basis.makeBasis(_tangent, _bitangent, _normal.copy(normal));
  out.setFromRotationMatrix(_basis);
}

/** Shrinks every instance to zero — that is how an instance "does not exist". */
function hideAll(mesh: THREE.InstancedMesh, count: number): void {
  for (let i = 0; i < count; i++) {
    mesh.setMatrixAt(i, _matrix.compose(ORIGIN, _quaternion.identity(), HIDDEN));
  }
  mesh.instanceMatrix.needsUpdate = true;
}
