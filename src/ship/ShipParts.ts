/**
 * Everything that sits **on top of** the hull: mast, rigging, helm, capstan,
 * cannons, stairs, anchor and lanterns.
 *
 * The split between static part and moving part is not organizational, it's about
 * performance. Whatever never moves goes into a `GeometryBuilder` shared per
 * material and becomes a single mesh — the whole ship at rest costs a little over
 * half a dozen draw calls. Whatever turns (helm, capstan, cannons, rudder,
 * anchor) needs its own transform and gets a `Group` each; there are few of them,
 * and each one is the interface to an entire game system.
 */

import * as THREE from 'three';
import { GeometryBuilder, vertex, type Vertex } from './GeometryBuilder';
import { withAoUv, type ShipMaterials } from './ShipMaterials';
import {
  DECK_Y,
  HALF_LENGTH,
  HOLD_FLOOR_Y,
  HULL_THICKNESS,
  QUARTERDECK_T,
  QUARTERDECK_Y,
  RUDDER_BLADE,
  STAIR_BOTTOM_Z,
  STAIR_HALF_WIDTH,
  STAIR_STEPS,
  STAIR_TOP_Z,
  STATIONS,
  ceilingY,
  deckCamber,
  deckHalfWidth,
  halfWidthAtHeight,
  hullSurfaceNormal,
  hullSurfacePoint,
  sampleSection,
  sectionV,
  tToZ,
  zToT,
  type HullSection,
} from './ShipDimensions';
import {
  BOARDING_LADDERS,
  BOARDING_RUNG_RADIUS,
  BOARDING_STILE_RADIUS,
  boardingLadderX,
  type BoardingLadderSpec,
} from './BoardingLadder';

/** Materials the parts use. Each one becomes, at most, one mesh. */
export type PartMaterial =
  | 'hull'
  | 'interior'
  | 'deck'
  | 'trim'
  | 'spar'
  | 'rope'
  | 'iron'
  | 'brass'
  | 'glass'
  | 'flame';

export type PartBuilders = Record<PartMaterial, GeometryBuilder>;

const PART_MATERIALS: readonly PartMaterial[] = [
  'hull',
  'interior',
  'deck',
  'trim',
  'spar',
  'rope',
  'iron',
  'brass',
  'glass',
  'flame',
];

export function createPartBuilders(): PartBuilders {
  const builders = {} as PartBuilders;
  for (const key of PART_MATERIALS) builders[key] = new GeometryBuilder();
  return builders;
}

/** Geometry already closed, per material. */
export type PartGeometries = Partial<Record<PartMaterial, THREE.BufferGeometry>>;

/**
 * Closes the accumulators into geometry.
 *
 * Exists separately from `emitMeshes` because the same geometry serves both ships
 * in the match — all that changes from one to the other is the `Object3D` matrix.
 * An empty accumulator does not become geometry: three accepts a zero-vertex
 * `BufferGeometry` without a word and only gives it away later, when it computes
 * the bounding sphere.
 */
export function toPartGeometries(builders: Partial<PartBuilders>): PartGeometries {
  const geometries: PartGeometries = {};
  for (const key of PART_MATERIALS) {
    const builder = builders[key];
    if (builder && builder.vertexCount > 0) geometries[key] = builder.toGeometry();
  }
  return geometries;
}

/** Creates one mesh per geometry and hangs it all off `parent`. */
export function meshesFromParts(
  geometries: PartGeometries,
  materials: ShipMaterials,
  parent: THREE.Object3D,
): THREE.Mesh[] {
  const meshes: THREE.Mesh[] = [];
  for (const key of PART_MATERIALS) {
    const geometry = geometries[key];
    if (!geometry) continue;

    const mesh = new THREE.Mesh(geometry, materials[key]);
    // Glass and flame stay out of the shadow map: one is transparent and the
    // other is the light source itself — shadowing either one would only produce
    // a dark smudge around the lantern.
    const casts = key !== 'glass' && key !== 'flame';
    mesh.castShadow = casts;
    mesh.receiveShadow = casts;
    mesh.name = `ship-${key}`;
    parent.add(mesh);
    meshes.push(mesh);
  }
  return meshes;
}

/** Shortcut for the moving parts, whose geometry is not shared. */
export function emitMeshes(
  builders: Partial<PartBuilders>,
  materials: ShipMaterials,
  parent: THREE.Object3D,
): THREE.Mesh[] {
  return meshesFromParts(toPartGeometries(builders), materials, parent);
}

// ---------------------------------------------------------------------------
// Measurements of the sail rig and of the command station
// ---------------------------------------------------------------------------

/** Mast Z, in the ship's local frame. */
export const MAST_Z = tToZ(STATIONS.mast);
/** The mast starts in the hold, on the keelson — like on a real ship. */
export const MAST_BASE_Y = HOLD_FLOOR_Y;
export const MAST_TOP_Y = 12.2;
/** Upper yard, which carries the sail. */
const YARD_Y = 9.0;
const YARD_HALF = 3.75;
/** Lower boom, which stretches the foot of the sail. */
const BOOM_Y = 3.55;
const BOOM_HALF = 3.6;
const CROW_NEST_Y = 10.25;

/**
 * Height of the helm axle and radius of the rim.
 *
 * The radius dropped from 0.62 to 0.55 because of the **eye line**, not scale.
 * The helmsman stands 85 cm aft of the wheel with his eye at 3.48 m; with the rim
 * at 0.62 and spoke handles sticking 26 cm out of it, the top handle ended at
 * 3.50 m — two centimeters above the eye and dead center on screen. The player
 * steered with a piece of wood covering exactly the point the bow is aimed at. At
 * 0.55, and with shorter handles, the top of the wheel drops to 3.34 m and the
 * view opens above it; 1.1 m of diameter is still a sloop's wheel, not a
 * galleon's.
 */
export const WHEEL_Y = 2.62;
const WHEEL_RADIUS = 0.55;
/** Distance from the centerline to the posts that hold the wheel's axle. */
const WHEEL_POST_X = 0.95;

/**
 * Corners of the sail, in the ship's local frame.
 *
 * Exported because `SailSim` pins the edges of the cloth exactly here: if the two
 * descriptions diverged, the sail would start out loose from its own yard.
 */
export const SAIL_FRAME = {
  topY: YARD_Y - 0.14,
  bottomY: BOOM_Y + 0.14,
  halfWidth: 3.5,
  z: MAST_Z,
  columns: 12,
  rows: 10,
} as const;

/**
 * Mast radius at an absolute height — the rigging needs to know where to land,
 * and impact detection needs to know where the cannonball stops.
 */
export function mastRadius(y: number): number {
  const h = (y - MAST_BASE_Y) / (MAST_TOP_Y - MAST_BASE_Y);
  return 0.24 - 0.13 * Math.min(Math.max(h, 0), 1);
}

/** Height of the quarterdeck floor on the centerline, where the helmsman stands. */
function quarterdeckCenterY(t: number): number {
  return QUARTERDECK_Y + deckCamber(0, deckHalfWidth(t));
}

// ---------------------------------------------------------------------------
// Static parts
// ---------------------------------------------------------------------------

/** One of the ship's lanterns: where it is and whether it goes out by day. */
export interface LanternSpot {
  position: THREE.Vector3;
  /**
   * `true` for the lantern that stays lit all day.
   *
   * Only the hold's. Down there is no time of day: the only light that gets in is what
   * comes down the hatchway, and it does not reach the corners where the breaches open.
   * Without this lantern, patching a hole at noon was work done in the dark — the player
   * saw a black rectangle with a white jet inside it.
   */
  alwaysOn: boolean;
}

export interface StaticPartsResult {
  /** Where to hang the lanterns' point lights, in the ship's coordinates. */
  lanterns: LanternSpot[];
}

export function buildStaticParts(b: PartBuilders): StaticPartsResult {
  buildMast(b);
  buildYards(b);
  buildCrowsNest(b);
  buildRigging(b);
  buildBowsprit(b);
  buildStaircase(b);
  buildMastLadder(b);
  buildBoardingLadders(b);
  buildHelmFrame(b);
  buildSternCanopy(b);
  buildBarrels(b);
  buildCleats(b);
  buildCathead(b);
  buildBilgePump(b);
  return { lanterns: buildLanterns(b) };
}

/** The mast: a tapered trunk from the hold to the top, with its iron bands. */
function buildMast(b: PartBuilders): void {
  b.spar.addLathe(
    { x: 0, y: MAST_BASE_Y, z: MAST_Z },
    MAST_TOP_Y - MAST_BASE_Y,
    (h) => 0.24 - 0.13 * h,
    { radialSegments: 14, heightSegments: 10, capTop: true, uvScale: 0.9 },
  );

  // Bands: they reinforce the mast's joints and break up the smooth cylinder.
  for (const y of [1.55, 4.2, 6.8, YARD_Y + 0.35, 11.1]) {
    b.iron.addLathe({ x: 0, y: y - 0.05, z: MAST_Z }, 0.1, () => mastRadius(y) + 0.025, {
      radialSegments: 14,
      heightSegments: 1,
      uvScale: 2,
    });
  }
}

/** Yard and boom, the two horizontal spars that stretch the sail. */
function buildYards(b: PartBuilders): void {
  const spar = (y: number, half: number, thickness: number): void => {
    const start = b.spar.vertexCount;
    b.spar.addLathe(
      { x: 0, y: 0, z: 0 },
      half * 2,
      (h) => thickness * (1 - 0.55 * Math.abs(h * 2 - 1)),
      { radialSegments: 10, heightSegments: 12, capBottom: true, capTop: true, uvScale: 1.4 },
    );
    // Turned upright and laid down afterward: the lathe only knows how to spin around
    // +Y.
    b.spar.transformFrom(
      start,
      new THREE.Matrix4().makeRotationZ(Math.PI * 0.5).setPosition(half, y, MAST_Z),
    );
  };

  spar(YARD_Y, YARD_HALF, 0.115);
  spar(BOOM_Y, BOOM_HALF, 0.095);

  // Ironwork where the yard hugs the mast.
  for (const y of [YARD_Y, BOOM_Y]) {
    b.iron.addLathe({ x: 0, y: y - 0.11, z: MAST_Z }, 0.22, () => mastRadius(y) + 0.045, {
      radialSegments: 12,
      heightSegments: 1,
      uvScale: 2,
    });
  }

  // Lifts: the lines that hold the yard's ends up at the masthead.
  const mastHead = new THREE.Vector3(0, 11.3, MAST_Z);
  for (const side of [1, -1]) {
    b.rope.addTube(mastHead, new THREE.Vector3(side * YARD_HALF * 0.92, YARD_Y, MAST_Z), 0.022);
  }
}

/**
 * The crow's nest: a ring of planks around the mast, with a wall and braces.
 *
 * **Everything here has two faces, and that is the difference that matters.** The
 * previous version was made of zero-thickness surfaces — floor, wall, rim —, and a
 * zero-thickness surface with a `FrontSide` material simply does not exist for whoever
 * looks at it from the other side. From the deck, looking up, the whole nest disappeared:
 * there was no bottom, there was no wall, and what was left were the six diagonal braces
 * floating around the mast. It is the same defect the deck had (see `DECK_THICKNESS`) and
 * the same cure: give the piece thickness, with a top face and a bottom face coming out
 * of the same sweep.
 */
function buildCrowsNest(b: PartBuilders): void {
  // 1.05 m of radius, and not the 0.92 of before. The difference is what separates a
  // decorative nest from one you fit inside: with the 13 cm of mast in the middle and the
  // player's 30 cm radius taken out, 0.92 left a thirteen-centimeter ring to stand on —
  // narrow enough that the mast's push and the wall's limit fought each other and the
  // player vibrated between the two.
  const radius = 1.05;
  const holeRadius = mastRadius(CROW_NEST_Y) + 0.03;
  /** Thickness of the platform. The same as the deck's, for the same reason. */
  const floorThickness = 0.09;
  const wallHeight = 0.52;
  const wallThickness = 0.05;
  const segments = 24;

  /** The floor's ring at a height, facing up or down. */
  const floorFace = (y: number, up: boolean): void => {
    b.deck.addSurface(
      segments,
      2,
      (s, w) => {
        const angle = s * Math.PI * 2;
        const r = holeRadius + (radius - holeRadius) * w;
        const x = Math.cos(angle) * r;
        const z = Math.sin(angle) * r;
        return vertex(x, y, MAST_Z + z, x, z);
      },
      up,
    );
  };

  /**
   * A cylindrical shell between two heights.
   *
   * `outward` chooses which way it faces, and it is the parameter that makes the same
   * function serve the nest's outer edge and the mast's hole in the middle of it. The
   * loops' order mimics `addLathe`'s — bottom ring, top ring, with the index running
   * through the angle —, so `flip = true` is the outside.
   */
  const skin = (
    builder: GeometryBuilder,
    r: (h: number) => number,
    yBottom: number,
    yTop: number,
    outward: boolean,
  ): void => {
    builder.addSurface(
      1,
      segments,
      (s, t) => {
        const angle = t * Math.PI * 2;
        const radiusAt = r(s);
        return vertex(
          Math.cos(angle) * radiusAt,
          yBottom + (yTop - yBottom) * s,
          MAST_Z + Math.sin(angle) * radiusAt,
          angle * radiusAt,
          s * (yTop - yBottom),
        );
      },
      outward,
    );
  };

  const floorBottom = CROW_NEST_Y - floorThickness;
  floorFace(CROW_NEST_Y, true);
  floorFace(floorBottom, false);
  skin(b.deck, () => radius, floorBottom, CROW_NEST_Y, true);
  skin(b.deck, () => holeRadius, floorBottom, CROW_NEST_Y, false);

  // The nest's wall, flaring slightly outward, **with a gangway**.
  //
  // The gap sits in the sector the mast ladder arrives through. Without it the nest was a
  // closed bucket with 52 cm of wall: you could climb the whole ladder and could not get
  // in, because half a meter is higher than the controller's automatic step. A real ship
  // has exactly this cutout, for exactly this reason.
  //
  // The opening runs from 60° to 120° in the local plane; the ladder is at +Z, which is
  // 90°.
  const gapFrom = Math.PI / 3;
  const gapTo = (Math.PI * 2) / 3;
  for (let i = 0; i < segments; i++) {
    const a0 = (i / segments) * Math.PI * 2;
    const a1 = ((i + 1) / segments) * Math.PI * 2;
    const middle = (a0 + a1) * 0.5;
    if (middle > gapFrom && middle < gapTo) continue;

    // The wall has an inner side and an outer side, and the top closes both. Without the
    // inner side, whoever is **in** the nest looks through their own wall.
    const wallAt = (angle: number, h: number, offset: number): Vertex => {
      const r = radius + h * 0.08 + offset;
      return vertex(
        Math.cos(angle) * r,
        CROW_NEST_Y + h * wallHeight,
        MAST_Z + Math.sin(angle) * r,
        angle * radius * 1.2,
        h * wallHeight * 1.2,
      );
    };

    b.deck.addQuad(
      wallAt(a0, 0, 0),
      wallAt(a1, 0, 0),
      wallAt(a1, 1, 0),
      wallAt(a0, 1, 0),
    );
    b.deck.addQuad(
      wallAt(a1, 0, -wallThickness),
      wallAt(a0, 0, -wallThickness),
      wallAt(a0, 1, -wallThickness),
      wallAt(a1, 1, -wallThickness),
    );
    // Cap: the top strip that stitches the two faces together.
    b.deck.addQuad(
      wallAt(a0, 1, -wallThickness),
      wallAt(a0, 1, 0),
      wallAt(a1, 1, 0),
      wallAt(a1, 1, -wallThickness),
    );
  }

  // An iron band at the top of the wall, following the same cutout. It goes outside and
  // inside, like the wall itself, or else it disappears the same way.
  for (let i = 0; i < segments; i++) {
    const a0 = (i / segments) * Math.PI * 2;
    const a1 = ((i + 1) / segments) * Math.PI * 2;
    const middle = (a0 + a1) * 0.5;
    if (middle > gapFrom && middle < gapTo) continue;

    const ringAt = (angle: number, h: number, offset: number): Vertex => {
      const r = radius + 0.09 + offset;
      return vertex(
        Math.cos(angle) * r,
        CROW_NEST_Y + wallHeight - 0.1 + h * 0.09,
        MAST_Z + Math.sin(angle) * r,
        angle * 2.5,
        h,
      );
    };
    b.iron.addQuad(ringAt(a0, 0, 0), ringAt(a1, 0, 0), ringAt(a1, 1, 0), ringAt(a0, 1, 0));
    b.iron.addQuad(ringAt(a1, 0, -0.03), ringAt(a0, 0, -0.03), ringAt(a0, 1, -0.03), ringAt(a1, 1, -0.03));
  }

  // Diagonal braces: without them the nest looks glued to the mast.
  for (let i = 0; i < 6; i++) {
    const angle = (i / 6) * Math.PI * 2;
    b.spar.addTube(
      new THREE.Vector3(0, CROW_NEST_Y - 0.85, MAST_Z),
      new THREE.Vector3(
        Math.cos(angle) * radius * 0.95,
        floorBottom,
        MAST_Z + Math.sin(angle) * radius * 0.95,
      ),
      0.045,
      0.035,
      6,
    );
  }
}

/**
 * Shrouds, stays, lifts and halyards.
 *
 * The shrouds are not decoration: they are the pair of rope ladders you climb to the
 * crow's nest, and that is why the ratlines have to really exist and sit a step apart.
 */
function buildRigging(b: PartBuilders): void {
  const anchorY = 8.55;

  for (const side of [1, -1]) {
    // **Behind the sail**, and that is what the three numbers decide.
    //
    // The feet used to be at −1.35 to +0.85 from the mast, that is, two of them forward
    // of it. Since the canvas bellies forward, at mid-height the lines passed **in front
    // of** the cloth and the sail showed up torn by three ropes on each side — the
    // "buggy rigging" effect you saw from a distance. With the feet aft, the shroud is
    // always behind the belly: at y = 5 m it falls at z = −1.49 against the canvas's
    // −1.69, and never crosses it.
    //
    // The limit on how far aft you can go is the cannon, at z = 0.8: with the aftmost
    // foot at −0.2 there are 80 cm left between the line and the sector the barrel's
    // muzzle sweeps.
    const offsets = [-0.5, 0.25, 1.0];
    const feet = offsets.map((dz) => {
      const z = MAST_Z + dz;
      // The foot dies on the **channel**, which is the bulwark's inner face just below
      // the cap. It used to be pinned at y = 2.0 — half a meter above the deck and a hand
      // below the bulwark's top, that is, in the air, with the line ending in the void
      // between the side and nothing. Read off the real sheer, the foot follows the
      // bulwark rising toward the bow, like on a ship.
      const y = sheerAt(z) - 0.16;
      return new THREE.Vector3(side * (halfWidthAtHeight(zToT(z), y) - 0.07), y, z);
    });
    const head = new THREE.Vector3(side * 0.16, anchorY, MAST_Z);

    for (let i = 0; i < feet.length; i++) {
      const top = head.clone();
      top.y -= Math.abs(offsets[i]!) * 0.25;
      b.rope.addTube(top, feet[i]!, 0.032, 0.038, 6);
    }

    // Ratlines between the forward shroud and the after one. They stop short of the top:
    // up there the lines have already converged and the rung would have no width.
    const rungs = 10;
    for (let i = 0; i < rungs; i++) {
      const k = 0.04 + (i / (rungs - 1)) * 0.8;
      b.rope.addTube(
        feet[0]!.clone().lerp(head, k),
        feet[2]!.clone().lerp(head, k),
        0.018,
        0.018,
        5,
      );
    }
  }

  // Forestay: it holds the mast against falling aft, dying on the bowsprit.
  const head = new THREE.Vector3(0, 11.0, MAST_Z);
  b.rope.addTube(head, new THREE.Vector3(0, 3.05, tToZ(0.975) - 2.6), 0.034, 0.03, 6);

  // Backstays: **two**, one per side, made fast to the quarterdeck's edge.
  //
  // A single line on the centerline was simpler and was wrong for two reasons. The
  // nautical one: a backstay on the axis does not hold the mast against yaw, which is
  // precisely the load the shrouds do not cover — which is why no ship uses one. And the
  // game one: its foot landed at (0, 2.62, 7.65), which is at once the height of the
  // helm's hub and the exact spot the helmsman stands on. On taking the wheel, the line
  // came out of the player's face and streaked across the screen top to bottom, passing
  // through the middle of the wheel. Splayed out to the sides the two lines do the real
  // work and frame the view instead of cutting it.
  //
  // They are also the thinnest lines in the rigging — 4 cm against the shrouds' 7 cm —
  // because they are the only ones the player sees two meters from the eye. At the
  // shrouds' gauge they read as two bars laid across the screen; the thickness here is
  // chosen by the distance you look from, not by the load.
  for (const side of [1, -1]) {
    const z = HALF_LENGTH - 0.55;
    const y = sheerAt(z) - 0.14;
    b.rope.addTube(
      new THREE.Vector3(side * 0.12, head.y - 0.15, MAST_Z),
      new THREE.Vector3(side * (halfWidthAtHeight(zToT(z), y) - 0.09), y, z),
      0.022,
      0.019,
      6,
    );
  }

  // The yard's halyards, coming down to the bulwark's belaying cleats. The lower point
  // comes out of the **same** function that draws the cleats: it used to be a fixed X of
  // 2.0 m and the line died 30 cm beside the cleat, in the air.
  for (const side of [1, -1]) {
    const cleat = cleatPoint(side as 1 | -1, CLEAT_Z[0]!);
    b.rope.addTube(
      new THREE.Vector3(side * YARD_HALF * 0.96, YARD_Y - 0.05, MAST_Z),
      new THREE.Vector3(cleat.x, cleat.y + 0.06, cleat.z),
      0.02,
      0.02,
      5,
    );
  }
}

/** Height of the bulwark's top at a local Z — the sheer line. */
function sheerAt(z: number): number {
  return sampleSection(zToT(z), sheerScratch).sheerY;
}

const sheerScratch: HullSection = { halfBeam: 0, keelY: 0, sheerY: 0, fullness: 1 };

/** The bowsprit: the spar that reaches out over the bow and anchors the forestay. */
function buildBowsprit(b: PartBuilders): void {
  const root = new THREE.Vector3(0, 2.35, tToZ(0.975));
  const tip = new THREE.Vector3(0, 3.15, tToZ(0.975) - 3.1);
  b.spar.addTube(root, tip, 0.14, 0.07, 12, 1.2);
  b.iron.addTube(root.clone().lerp(tip, 0.34), root.clone().lerp(tip, 0.42), 0.11, 0.105, 12, 2.5);
}

/**
 * The hold's stairs — an **inclined flight**, not a ladder.
 *
 * It is the difference that changes how the whole ship feels. A ladder forces you to
 * stop, press a key, enter a mode where all you do is climb and descend; an inclined
 * flight is floor, and floor is walked. The player walks into the hole and goes down. It
 * is what Sea of Thieves' sloop has, and it is why going down into the hold there does
 * not interrupt whatever you were doing.
 *
 * The steps' shape comes out of `stairSurfaceY`, the same function `PlayerController`
 * uses as floor. There is no way for a foot to land where the board is not.
 */
function buildStaircase(b: PartBuilders): void {
  const run = STAIR_TOP_Z - STAIR_BOTTOM_Z;
  const tread = run / STAIR_STEPS;
  const rise = (DECK_Y - HOLD_FLOOR_Y) / STAIR_STEPS;
  // The board is a finger narrower than the opening: the step has to fill it entirely so
  // no floor is left missing, but touching the coaming's edge puts both faces at the same
  // depth and they flicker against each other.
  const half = STAIR_HALF_WIDTH - 0.015;

  for (let i = 0; i < STAIR_STEPS; i++) {
    const top = DECK_Y - rise * (i + 1);
    const centerZ = STAIR_TOP_Z - tread * (i + 0.5);

    // The step's tread: a thick board, slightly proud of the riser.
    b.deck.addBox(
      { x: 0, y: top - 0.025, z: centerZ - 0.015 },
      { x: half * 2, y: 0.05, z: tread + 0.03 },
      1.6,
    );
    // The riser: it closes the gap under the step, or else the hold shows through it.
    b.interior.addBox(
      { x: 0, y: top - rise * 0.5 - 0.02, z: centerZ - tread * 0.5 + 0.02 },
      { x: half * 2, y: rise, z: 0.04 },
      2,
    );
  }

  // Stringers: the two beams the steps are let into. They sit **outside** the opening,
  // buried in the coaming's thickness, so they do not steal passage width — the stairs
  // fill the whole hatchway precisely so no hole is left along the sides.
  for (const side of [1, -1]) {
    const x = side * (STAIR_HALF_WIDTH + 0.05);
    b.interior.addTube(
      new THREE.Vector3(x, DECK_Y - 0.04, STAIR_TOP_Z + 0.02),
      new THREE.Vector3(x, HOLD_FLOOR_Y - 0.02, STAIR_BOTTOM_Z - 0.06),
      0.08,
      0.08,
      6,
      1.4,
    );
  }
}

/**
 * The mast ladder, from the deck to the crow's nest.
 *
 * Here the ladder is the right piece, and for the opposite reason to the hold's: it is
 * nine meters straight up, against a trunk. There is no inclined flight that fits that,
 * and no ship ever tried — you go up hand over hand, grabbing rung by rung.
 *
 * It sits abaft the mast so it does not fight the sail or the shrouds, which converge on
 * the top from forward. It is the only way to reach the nest, and without it the crow's
 * nest was scenery: it existed on screen and did not exist in the game.
 */
export const MAST_LADDER = {
  /** Local Z of the stiles, a hand abaft the mast. */
  z: MAST_Z + 0.34,
  /** Half the width between the stiles. */
  halfWidth: 0.24,
  bottomY: DECK_Y,
  /**
   * The actual spacing between the rungs, in meters.
   *
   * **It is not 30 cm.** The rounding is of the *number of gaps*, not of the spacing:
   * 9.10 m of ladder give 30 gaps and leave 30.33 cm between bars. The difference looks
   * irrelevant and is not — the climbing clip (`anim_climb.py`) goes up exactly two rungs
   * per cycle, and that is what makes the character's hand land on the bar that is drawn
   * here. Touching this ladder without regenerating the clip pulls the two apart.
   */
  rungSpacing: (CROW_NEST_Y + 0.15 - DECK_Y)
    / Math.round((CROW_NEST_Y + 0.15 - DECK_Y) / 0.3),
  /** It ends above the nest's floor: you climb until you can step inside. */
  topY: CROW_NEST_Y + 0.15,
} as const;

/** The crow's nest platform, for whoever has to know where you can stand. */
export const CROW_NEST = {
  y: CROW_NEST_Y,
  z: MAST_Z,
  /** Usable radius of the floor, with the wall already taken out. */
  radius: 0.98,
  /** The mast's radius at this height — what you walk around up there. */
  mastRadius: mastRadius(CROW_NEST_Y),
} as const;

function buildMastLadder(b: PartBuilders): void {
  const { z, halfWidth, bottomY, topY } = MAST_LADDER;

  for (const side of [1, -1]) {
    b.spar.addTube(
      new THREE.Vector3(side * halfWidth, bottomY - 0.1, z),
      new THREE.Vector3(side * halfWidth, topY, z),
      0.042,
      0.034,
      7,
      1.5,
    );
  }

  const rungs = Math.round((topY - bottomY) / MAST_LADDER.rungSpacing);
  for (let i = 0; i <= rungs; i++) {
    const y = bottomY + MAST_LADDER.rungSpacing * i;
    b.spar.addTube(
      new THREE.Vector3(-halfWidth, y, z),
      new THREE.Vector3(halfWidth, y, z),
      0.026,
      0.026,
      6,
      2,
    );
    // A bracket tying the ladder to the mast every three rungs.
    if (i % 3 === 0) {
      b.iron.addTube(
        new THREE.Vector3(0, y, MAST_Z + mastRadius(y)),
        new THREE.Vector3(0, y, z),
        0.016,
        0.016,
        5,
      );
    }
  }
}

/**
 * The boarding ladders: one per side, aft, beside the helm.
 *
 * It is the piece that gives the player the ship back after they fall into the sea, and
 * it only serves that — going down is jumping through the gangway, the gap in the bulwark
 * `HullGeometry.buildGangways` opens right above here. Every measurement comes out of
 * `BoardingLadder`, which is the single source: the same sheet the mesh reads is the one
 * `PlayerController` uses to know where the hand grabs.
 *
 * Two things in this function are not like the mast ladder, and both come from the fact
 * that this ladder hangs on a curved hull instead of on a straight trunk:
 *
 * 1. **The stiles are laid-down lathes, not `addTube`.** `addTube` does not close the
 *    ends, and here both show: the upper one dies on the edge of the gangway's sill and
 *    the lower one is underwater, exactly where the swimmer arrives. An open tube becomes
 *    a hole you see the inside of the piece through.
 * 2. **The ironwork comes out of `hullSurfacePoint`/`hullSurfaceNormal`**, and not out of
 *    a horizontal setback from the half-beam — it is the same reason as `buildWales` and
 *    the note in `deckEdgeHalfWidth`: at the bilge the side runs at an angle, and "13 cm
 *    inboard horizontally" and "13 cm along the normal" are different points. With the
 *    horizontal arithmetic the bracket's foot would be born outside the wood.
 */
function buildBoardingLadders(b: PartBuilders): void {
  for (const spec of BOARDING_LADDERS) buildBoardingLadder(b, spec);
}

/**
 * How far the stile runs below the last rung.
 *
 * It is not drafting slack: it is what keeps the lowest rung — the one the swimmer grabs
 * blind, with the wave washing over — from sitting on the stile's very tip, where a hand
 * that misses by ten centimeters finds nothing.
 */
const BOARDING_STILE_FOOT = 0.14;

/** Heights of the brackets that fasten the ladder to the side. Chosen by what they
 *  **cannot** touch: the lower wale runs from 0.925 to 1.115, and the gangway's sill from
 *  1.69 to 1.74. */
const BOARDING_BRACKET_HEIGHTS: readonly number[] = [0.65, 1.55];

function buildBoardingLadder(b: PartBuilders, spec: BoardingLadderSpec): void {
  const { side, z, halfWidth, topY, bottomY, rungSpacing, rungCount, tilt } = spec;
  const stileZ = [z - halfWidth, z + halfWidth];

  // Stiles. The lathe spins around +Y, so the piece is born upright and a
  // `transformFrom` lays it over at the ladder's angle — the same path as the yard in
  // `buildYards`. The top stops at the upper edge of the last rung, and not at the floor:
  // flush with the floor the stile's cap would fight the sill for depth, and what you
  // would see would be a wooden disc flickering on the gangway's deck.
  const footY = bottomY - BOARDING_STILE_FOOT;
  const headY = topY + BOARDING_RUNG_RADIUS;
  const length = (headY - footY) / Math.cos(tilt);
  for (const z0 of stileZ) {
    const start = b.spar.vertexCount;
    b.spar.addLathe({ x: 0, y: 0, z: 0 }, length, () => BOARDING_STILE_RADIUS, {
      radialSegments: 8,
      heightSegments: 2,
      capBottom: true,
      capTop: true,
      uvScale: 1.5,
    });
    b.spar.transformFrom(
      start,
      new THREE.Matrix4()
        // The tilt is outboard on both sides, and `side` is what flips the sign:
        // without it the port ladder would drive into the hull as it climbed.
        .makeRotationZ(-side * tilt)
        .setPosition(side * boardingLadderX(spec, footY), footY, z0),
    );
  }

  // Rungs. They sit on a plane of constant X for each height, so each one is a
  // horizontal bar running from one stile to the other; the ends die on the stiles' axis,
  // buried in their wood.
  for (let i = 0; i <= rungCount; i++) {
    const y = bottomY + rungSpacing * i;
    const x = side * boardingLadderX(spec, y);
    b.spar.addTube(
      new THREE.Vector3(x, y, stileZ[0]!),
      new THREE.Vector3(x, y, stileZ[1]!),
      BOARDING_RUNG_RADIUS,
      BOARDING_RUNG_RADIUS,
      6,
      2,
    );
  }

  // Brackets: the iron that lashes each stile to the side. The foot goes 3 cm in along
  // the normal on purpose — the tube's end is open, and buried in the planking it
  // disappears instead of turning into a hole in the piece.
  const section: HullSection = { halfBeam: 0, keelY: 0, sheerY: 0, fullness: 1 };
  const anchor = new THREE.Vector3();
  const normal = new THREE.Vector3();
  for (const y of BOARDING_BRACKET_HEIGHTS) {
    for (const z0 of stileZ) {
      const t = zToT(z0);
      const v = sectionV(sampleSection(t, section), y);
      hullSurfacePoint(t, v, side, anchor);
      hullSurfaceNormal(t, v, side, normal);
      b.iron.addTube(
        anchor.clone().addScaledVector(normal, -0.03),
        new THREE.Vector3(side * boardingLadderX(spec, y), y, z0),
        0.018,
        0.015,
        6,
        3,
      );
    }
  }
}

/**
 * The helm station: the frame that carries the wheel, and the binnacle in front of it.
 *
 * **The wheel has to rest on something, and before it did not.** The two posts sit 95 cm
 * from the axle and the rim has a 62 cm radius: between the wood and the piece there were
 * 33 cm of air, crossed by a thin bearing that, seen head-on — which is where the
 * helmsman looks from —, disappears behind the hub itself. What you saw was a ship's
 * wheel hovering over the quarterdeck.
 *
 * What fixes that is not a thicker bearing: it is the central column. On a ship the
 * wheel's axle comes out of a **drum** — the cylinder the tiller rope winds onto — and
 * that drum is carried by a piece rising from the deck. With it in place, the wheel is
 * mounted instead of floating, and the whole frame (two columns, a crossbar below and a
 * drum in the middle) reads as a single piece.
 */
function buildHelmFrame(b: PartBuilders): void {
  const z = tToZ(STATIONS.helm);
  const deckY = quarterdeckCenterY(STATIONS.helm);
  const postTop = WHEEL_Y + 0.26;

  for (const side of [1, -1]) {
    // A column with a widened foot: the base is what makes it look seated, and it is
    // what a post really has so it does not split the deck open in the first heavy sea.
    b.spar.addBox(
      { x: side * WHEEL_POST_X, y: (deckY + postTop) * 0.5, z },
      { x: 0.17, y: postTop - deckY, z: 0.21 },
      1.2,
    );
    b.spar.addBox(
      { x: side * WHEEL_POST_X, y: deckY + 0.07, z },
      { x: 0.3, y: 0.14, z: 0.34 },
      1.4,
    );
    // No brass plate on top of the post: the two posts sit at the edge of the frame of
    // whoever is steering, and two yellow plates there steal the eye from the one piece
    // of brass that has to be seen — the marked handle, in `createWheel`. Metal aboard is
    // expensive and is used where it is needed.
    //
    // The bearing joining the post to the axle. **Iron, and short.**
    //
    // In brass it was two 76 cm yellow bars crossing the whole wheel at the hub's height,
    // and from inside the post they cut the piece in half — two metal strokes where there
    // should be wood and air. A bearing is a working piece, not an ornament: iron is the
    // honest material, and it disappears into the middle of the wheel instead of
    // competing with it.
    b.iron.addTube(
      new THREE.Vector3(side * (WHEEL_POST_X - 0.06), WHEEL_Y, z),
      new THREE.Vector3(side * 0.3, WHEEL_Y, z),
      0.055,
      0.045,
      10,
      3,
    );
  }

  // The crossbar between the columns, at chest height: it closes the frame and it is
  // what the drum rests on.
  b.spar.addBox(
    { x: 0, y: WHEEL_Y - 0.52, z },
    { x: WHEEL_POST_X * 2 + 0.17, y: 0.14, z: 0.16 },
    1.4,
  );

  // The central column and the tiller drum, under the wheel's axle.
  b.spar.addBox({ x: 0, y: (deckY + WHEEL_Y - 0.3) * 0.5, z }, { x: 0.26, y: WHEEL_Y - 0.3 - deckY, z: 0.26 }, 1.6);
  const drumStart = b.spar.vertexCount;
  b.spar.addLathe({ x: 0, y: 0, z: 0 }, 0.44, (h) => 0.19 + 0.03 * Math.sin(h * Math.PI), {
    radialSegments: 14,
    heightSegments: 4,
    capBottom: true,
    capTop: true,
    uvScale: 2,
  });
  // The lathe spins around +Y and the drum is laid on the tiller's axis, which runs
  // athwartships.
  b.spar.transformFrom(
    drumStart,
    new THREE.Matrix4().makeRotationZ(Math.PI * 0.5).setPosition(0.22, WHEEL_Y, z),
  );
  // The tiller rope coming down off the drum, which is where the force actually goes.
  for (const side of [1, -1]) {
    b.rope.addTube(
      new THREE.Vector3(side * 0.16, WHEEL_Y - 0.2, z + 0.02),
      new THREE.Vector3(side * 0.1, deckY + 0.02, z + 0.16),
      0.02,
      0.02,
      6,
    );
  }

  buildBinnacle(b, z - 1.05, deckY);
}

/**
 * The binnacle: the compass's box, right in front of the helmsman.
 *
 * The previous version was a wooden box with a **flat brass plate** standing in for a
 * lid — 50 × 42 cm of plain yellow a meter from the eye of whoever is steering, with no
 * apparent shape or function. In first person it read as a rectangle of paint glued to
 * the deck, and it was the first thing that pulled the eye in the whole station.
 *
 * A real binnacle is not a box with a lid: it is a low cabinet with a **glass hood** you
 * read the compass through, a little gable roof to keep the rain out and brass corner
 * pieces on the edges. The brass is still there — it is the metal that does not
 * demagnetize the compass, and that is why it exists on this piece —, but as beading and
 * corner pieces, which is the right amount of shine to say "instrument" without turning
 * into a smear.
 */
function buildBinnacle(b: PartBuilders, z: number, deckY: number): void {
  const bodyHeight = 0.74;
  const bodyTop = deckY + bodyHeight;

  b.spar.addBox({ x: 0, y: deckY + bodyHeight * 0.5, z }, { x: 0.44, y: bodyHeight, z: 0.36 }, 1.6);
  // Corner pieces on the four edges — iron, which is what protects a cabinet's edge
  // aboard. In brass it was four 74 cm yellow bars framing the whole piece, and the
  // binnacle read as a gilded safe in the middle of the quarterdeck. The brass is saved
  // for the top, where it has a function.
  for (const sx of [1, -1]) {
    for (const sz of [1, -1]) {
      b.iron.addBox(
        { x: sx * 0.215, y: deckY + bodyHeight * 0.5, z: z + sz * 0.175 },
        { x: 0.028, y: bodyHeight, z: 0.028 },
        3,
      );
    }
  }
  // Beading at the waist, which is where the cabinet's door opens.
  b.iron.addBox({ x: 0, y: deckY + 0.3, z }, { x: 0.46, y: 0.025, z: 0.38 }, 3);

  // The compass hood: the cabinet closes with a brass band, the little window you read
  // the heading through opens **aft** — which is the side the helmsman looks from — and a
  // wooden hat covers it all.
  b.brass.addBox({ x: 0, y: bodyTop + 0.02, z }, { x: 0.4, y: 0.045, z: 0.33 }, 3);
  b.spar.addBox({ x: 0, y: bodyTop + 0.16, z }, { x: 0.34, y: 0.24, z: 0.28 }, 2);
  b.glass.addBox({ x: 0, y: bodyTop + 0.17, z: z + 0.145 }, { x: 0.19, y: 0.15, z: 0.02 }, 2);
  b.brass.addBox({ x: 0, y: bodyTop + 0.17, z: z + 0.15 }, { x: 0.23, y: 0.19, z: 0.012 }, 3);

  // The hat: an eight-sided cone, and not a gable of loose quads.
  //
  // The gable version was made of four unattached quadrilaterals, and it was missing the
  // essential part: the two side ends. What showed up on the quarterdeck was a slanted
  // wooden flap coming out of nothing, with no side and no underside. A solid of
  // revolution closes on its own, has the right normal all the way around and reads as a
  // turned piece, which is what a binnacle has on top.
  b.spar.addLathe({ x: 0, y: bodyTop + 0.28, z }, 0.13, (h) => 0.25 * (1 - h * 0.92) + 0.01, {
    radialSegments: 8,
    heightSegments: 3,
    capBottom: true,
    capTop: true,
    uvScale: 2.4,
  });
}

/**
 * The stern canopy's measurements, in one place because three consumers read them: the
 * mesh, the obstacles the player walks around, and whoever hangs something off it.
 */
const CANOPY = {
  aftZ: HALF_LENGTH - 0.75,
  foreZ: tToZ(QUARTERDECK_T) + 0.2,
  postTop: 4.02,
  ridgeY: 4.45,
  /** The canopy's usable half-width at a station, set in from the bulwark. */
  halfAt: (z: number): number => deckHalfWidth(zToT(z)) - 0.34,
} as const;

/**
 * The canopy's four columns, so the player's controller knows to walk around them.
 *
 * Without this the sailor walked through 13 cm of wood in the middle of his own station —
 * and walking through a piece of the ship is the kind of thing that only has to happen
 * once for the whole deck to stop feeling solid. The radius is the column's plus a
 * finger, and no more: between it and the bulwark there are 34 cm, and fattening the
 * obstacle would close that passage.
 */
export const CANOPY_BLOCKERS: readonly { x: number; z: number; radius: number }[] = [1, -1]
  .flatMap((side) =>
    [CANOPY.aftZ, CANOPY.foreZ].map((z) => ({
      x: side * CANOPY.halfAt(z),
      z,
      radius: 0.1,
    })),
  );

/**
 * The quarterdeck's canopy: four columns and a gabled roof over the helm station.
 *
 * It is the piece that brings the silhouette closest to Sea of Thieves' sloop, and not
 * out of a whim for the reference: an uncovered stern reads as a raft. The canopy gives
 * the stern the mass the eye looks for before calling that thing a ship, frames the
 * helmsman (who is now **inside** something, and not standing on a high board) and closes
 * the silhouette against the horizon, which is how the enemy sees this ship at two
 * hundred meters.
 *
 * **Every height here comes out of the player's eye, not out of proportion.** The
 * quarterdeck is 1.82 m above the waterline, the eye is at 3.48 m, and a jump takes the
 * head to 4.03 m. A roof hung at the "pretty" height of two meters of headroom would cut
 * the player's head off every time they jumped, and nothing gives scenery away faster
 * than walking through your own ship. The ridge sits at 4.45 m: 42 cm above the jump,
 * enough clearance that the sea's roll does not close the gap.
 */
function buildSternCanopy(b: PartBuilders): void {
  const { aftZ, foreZ, postTop, ridgeY, halfAt } = CANOPY;
  const deckY = quarterdeckCenterY(STATIONS.helm);

  for (const side of [1, -1]) {
    for (const z of [aftZ, foreZ]) {
      const x = side * halfAt(z);
      b.spar.addBox(
        { x, y: (deckY + postTop) * 0.5, z },
        { x: 0.13, y: postTop - deckY, z: 0.13 },
        1.4,
      );
      // A knee brace: the diagonal that keeps the frame from swaying. Without it the
      // canopy reads as four toothpicks with a lid on top.
      b.spar.addTube(
        new THREE.Vector3(x, postTop - 0.5, z),
        new THREE.Vector3(x - side * 0.42, postTop - 0.06, z),
        0.045,
        0.04,
        6,
        2,
      );
    }

    // The longitudinal beam joining that side's two columns.
    const x = side * halfAt((aftZ + foreZ) * 0.5);
    b.spar.addBox(
      { x, y: postTop + 0.06, z: (aftZ + foreZ) * 0.5 },
      { x: 0.15, y: 0.14, z: aftZ - foreZ + 0.3 },
      1.3,
    );
  }

  // The ridge, on the centerline.
  b.spar.addBox(
    { x: 0, y: ridgeY, z: (aftZ + foreZ) * 0.5 },
    { x: 0.12, y: 0.13, z: aftZ - foreZ + 0.34 },
    1.3,
  );

  // The roof's two slopes. Each is a slab **with thickness**, turned out straight and
  // tilted afterward: `transformFrom` is what avoids assembling a prism vertex by vertex
  // and still guarantees all six faces exist — a zero-thickness roof is the crow's nest's
  // defect all over again, seen from below.
  const eavesHalf = halfAt((aftZ + foreZ) * 0.5) + 0.28;
  const rise = ridgeY - postTop - 0.06;
  const slope = Math.hypot(eavesHalf, rise);
  const length = aftZ - foreZ + 0.5;
  for (const side of [1, -1]) {
    const start = b.deck.vertexCount;
    b.deck.addBox({ x: 0, y: 0, z: 0 }, { x: slope, y: 0.07, z: length }, 1.6);
    b.deck.transformFrom(
      start,
      new THREE.Matrix4()
        .makeRotationZ(side * Math.atan2(rise, eavesHalf))
        .setPosition(
          side * eavesHalf * 0.5,
          (ridgeY + postTop + 0.06) * 0.5,
          (aftZ + foreZ) * 0.5,
        ),
    );
  }
}

/** Maximum radius of a deck barrel, at its belly. */
const BARREL_RADIUS = 0.37;
/** Height of a barrel. */
const BARREL_HEIGHT = 0.86;

/**
 * Where the barrels sit, as (side, z).
 *
 * The X is **not** chosen: it comes out of the deck's real half-width at that Z, minus
 * the barrel's radius. The old positions were fixed numbers (±1.87, −1.70) and that is
 * how a barrel gets into the wall: at z = −2.6 the deck has 2.26 m of half-width, so a
 * 37 cm-radius barrel centered at 1.70 sticks 0.19 m into the side — which is exactly
 * what you saw, half a barrel buried in the bulwark. Leaving the arithmetic to the hull's
 * curve, they touch the wood at any station and never go through it.
 */
const BARREL_PLACES: readonly (readonly [1 | -1, number])[] = [
  [1, -0.6],
  [-1, -0.6],
  [-1, -2.6],
];

/** Deck barrels — the shot barrels and the provisions one. */
function buildBarrels(b: PartBuilders): void {
  for (const [side, z] of BARREL_PLACES) {
    const x = barrelX(side, z);
    const y = DECK_Y + deckCamber(x, deckHalfWidth(zToT(z)));
    // Staves: the belly in the middle is what tells a barrel from a drum.
    const bulge = (h: number): number =>
      BARREL_RADIUS - 0.07 + 0.07 * Math.sin(h * Math.PI);
    b.spar.addLathe({ x, y, z }, BARREL_HEIGHT, bulge, {
      radialSegments: 14,
      heightSegments: 6,
      capTop: true,
      uvScale: 1.6,
    });
    for (const h of [0.12, 0.5, 0.88]) {
      b.iron.addLathe({ x, y: y + h * BARREL_HEIGHT - 0.035, z }, 0.07, () => bulge(h) + 0.012, {
        radialSegments: 14,
        heightSegments: 1,
        uvScale: 2.5,
      });
    }
  }
}

/**
 * A barrel's X: up against that side's bulwark, without going into it.
 *
 * The 6 cm of clearance exists because the bulwark falls inboard as it rises (the tumble
 * home in `ShipDimensions`), and the barrel is 86 cm tall — its top meets a narrower side
 * than its foot does.
 */
function barrelX(side: 1 | -1, z: number): number {
  const t = zToT(z);
  // Measure at the barrel's top, which is where the side is narrowest.
  const half = halfWidthAtHeight(t, DECK_Y + BARREL_HEIGHT) - HULL_THICKNESS;
  return side * Math.max(half - BARREL_RADIUS - 0.06, 0.5);
}

/** Where the barrels are, so the controller knows to walk around them. */
export const BARREL_BLOCKERS: readonly { x: number; z: number; radius: number }[] =
  BARREL_PLACES.map(([side, z]) => ({
    x: barrelX(side, z),
    z,
    radius: BARREL_RADIUS,
  }));

/**
 * The bilge pump: where the water that came in through the breaches is got out.
 *
 * It sits to starboard, between the hatch and the mast — close enough to the stairs that
 * whoever comes down finds it without looking, and clear of the hatchway, which is where
 * the deck's light comes down. The brake's height is what the hand reaches standing in
 * the hold.
 */
export const BILGE_PUMP = new THREE.Vector3(1.05, HOLD_FLOOR_Y, 1.15);
/** Height of the brake's handle, the interaction's focus point. */
export const BILGE_PUMP_HANDLE_Y = HOLD_FLOOR_Y + 1.02;

function buildBilgePump(b: PartBuilders): void {
  const { x, z } = BILGE_PUMP;
  const floor = HOLD_FLOOR_Y;

  // The well's box, seated on the floor: it is what seals the suction pipe's mouth.
  b.spar.addBox({ x, y: floor + 0.14, z }, { x: 0.52, y: 0.28, z: 0.46 }, 2.2);

  // Body: a square trunk, with the iron bands that clamp the staves.
  const trunkHeight = 0.96;
  b.spar.addBox(
    { x, y: floor + 0.28 + trunkHeight * 0.5, z },
    { x: 0.24, y: trunkHeight, z: 0.24 },
    3,
  );
  for (const h of [0.2, 0.72]) {
    b.iron.addBox({ x, y: floor + 0.28 + trunkHeight * h, z }, { x: 0.27, y: 0.05, z: 0.27 }, 4);
  }

  // The iron head and the trunnion the brake pivots on.
  const headY = floor + 0.28 + trunkHeight;
  b.iron.addBox({ x, y: headY + 0.05, z }, { x: 0.3, y: 0.12, z: 0.26 }, 4);
  b.iron.addTube(
    new THREE.Vector3(x, headY + 0.05, z - 0.16),
    new THREE.Vector3(x, headY + 0.05, z + 0.16),
    0.028,
    0.028,
    8,
  );

  // The brake: it comes off the trunnion inboard and drops a little, at rest. Whoever
  // pumps pushes it down, and that is the stroke the animation would travel — for now it
  // stays still where the hand finds it.
  b.iron.addTube(
    new THREE.Vector3(x, headY + 0.05, z + 0.1),
    new THREE.Vector3(x - 0.52, BILGE_PUMP_HANDLE_Y - 0.06, z + 0.1),
    0.026,
    0.022,
    8,
  );
  b.spar.addLathe(
    { x: x - 0.62, y: BILGE_PUMP_HANDLE_Y - 0.09, z: z + 0.1 },
    0.22,
    () => 0.045,
    { radialSegments: 10, heightSegments: 1, capBottom: true, capTop: true, uvScale: 3 },
  );

  // Brass spout: it pours the water toward the side, where it goes out through the
  // scuppers. It is the only shiny piece down here, and it serves as a visual marker in
  // the dark of the hold.
  b.brass.addTube(
    new THREE.Vector3(x, floor + 0.5, z),
    new THREE.Vector3(x + 0.34, floor + 0.36, z),
    0.055,
    0.045,
    10,
  );
}

/** Where the belaying cleats are, in local Z. */
const CLEAT_Z: readonly number[] = [MAST_Z + 1.6, MAST_Z - 1.2];

/**
 * A cleat's position: against the bulwark's inner face, a hand below the cap. It exists
 * as a function because the halyards have to die exactly here.
 */
function cleatPoint(side: 1 | -1, z: number): THREE.Vector3 {
  const y = sheerAt(z) - 0.22;
  return new THREE.Vector3(side * (halfWidthAtHeight(zToT(z), y) - 0.11), y, z);
}

/** Belaying cleats: where the lines die, against the bulwark. */
function buildCleats(b: PartBuilders): void {
  for (const side of [1, -1]) {
    for (const z of CLEAT_Z) {
      const point = cleatPoint(side as 1 | -1, z);
      b.spar.addBox(point, { x: 0.1, y: 0.1, z: 0.42 }, 3);
    }
  }
}

/**
 * Stern and mast lanterns.
 *
 * They are what gives the ship scale and legibility after sundown: the flame's color is
 * above 1 on purpose, so the compositor's bloom turns it into a halo, and `ShipBuilder`
 * hangs a point light at each position returned here.
 */
function buildLanterns(b: PartBuilders): LanternSpot[] {
  // The stern lantern: set **on top of the taffrail**, the highest piece of the stern.
  //
  // It is where it would be on a ship, and it is where it finally has something to rest
  // on: the previous version hung the cage at y = 2.78 on the centerline, with a 28 cm
  // stub of iron running down into nothing — the stern bulwark's cap is at 2.58, and
  // there were 6 cm of air between the bracket's foot and the wood. Now the pedestal
  // rises out of the cap itself and the flame sits just above it, exactly in the
  // silhouette you see of a sloop's stern against the sunset.
  const sternSection = halfWidthAtHeight(0.004, 3.4);
  const sternTop = 2.58;
  const sternZ = HALF_LENGTH - 0.16;

  // The bow lantern: **hung from the bowsprit**, which is the only structure that exists
  // up there.
  //
  // The first attempt put the cage over the stem, at z = −8.02 — and the stem ends at
  // −8.0. The lantern sat outside the hull, floating in the air ahead of the ship,
  // fastened to nothing. Here it hangs from a hook on the spar, which is where a real
  // ship carries it: ahead of everything, lighting the water the bow is about to cut, and
  // blocking nobody's view aboard.
  //
  // The Y comes out of the bowsprit's own line at that Z, and not out of a chosen number:
  // the spar rises 80 cm over 3.1 m, and it is that arithmetic that guarantees the hook
  // touches the wood even if the bowsprit changes its angle.
  const bowZ = tToZ(0.975) - 0.95;
  const bowspritY = 2.35 + (0.95 / 3.1) * 0.8;
  const bowY = bowspritY - 0.52;

  // The hold lantern: hung from a beam, amidships, between the foot of the stairs and
  // the pump. It is the only one that never goes out — see `LanternSpot.alwaysOn`.
  const holdY = ceilingY(zToT(0.6), 0) - 0.34;
  const holdZ = 0.6;

  const spots = [
    new THREE.Vector3(0, sternTop + 0.62, sternZ),
    new THREE.Vector3(0, bowY, bowZ),
    new THREE.Vector3(0.55, holdY, holdZ),
  ];

  // --- the mounts, before the cages ---

  // The stern lantern's pedestal: a turned stub on the taffrail.
  b.spar.addLathe({ x: 0, y: sternTop - 0.04, z: sternZ }, 0.34, (h) => 0.1 - 0.03 * h, {
    radialSegments: 12,
    heightSegments: 3,
    capTop: true,
    uvScale: 2,
  });
  b.iron.addTube(
    new THREE.Vector3(0, sternTop + 0.28, sternZ),
    new THREE.Vector3(0, spots[0]!.y - 0.19, sternZ),
    0.026,
    0.026,
    8,
  );
  // Two braces splaying out to the sides, which is what keeps the pedestal from reading
  // as a post stuck into the middle of the transom.
  for (const side of [1, -1]) {
    b.spar.addTube(
      new THREE.Vector3(side * Math.min(sternSection * 0.55, 0.62), sternTop - 0.02, sternZ - 0.08),
      new THREE.Vector3(0, sternTop + 0.26, sternZ),
      0.05,
      0.035,
      6,
      2,
    );
  }

  // The bow lantern's hook: an iron strap around the bowsprit and the rod running down
  // from it to the cage's ring.
  b.iron.addTorusZ({ x: 0, y: bowspritY, z: bowZ }, 0.12, 0.018, 12, 6, 3);
  b.iron.addTube(
    new THREE.Vector3(0, bowspritY - 0.1, bowZ),
    new THREE.Vector3(0, spots[1]!.y + 0.44, bowZ),
    0.02,
    0.02,
    6,
  );

  // The hold lantern's hook, coming out of the ceiling.
  b.iron.addTube(
    new THREE.Vector3(0.55, ceilingY(zToT(holdZ), 0.55), holdZ),
    new THREE.Vector3(0.55, spots[2]!.y + 0.44, holdZ),
    0.018,
    0.018,
    6,
  );

  for (const spot of spots) {
    const half = 0.13;
    // Four uprights, a base and a hat: the classic cage.
    for (const sx of [1, -1]) {
      for (const sz of [1, -1]) {
        b.iron.addBox(
          { x: spot.x + sx * half, y: spot.y, z: spot.z + sz * half },
          { x: 0.026, y: 0.34, z: 0.026 },
          4,
        );
      }
    }
    b.iron.addBox({ x: spot.x, y: spot.y - 0.19, z: spot.z }, { x: 0.32, y: 0.05, z: 0.32 }, 3);
    b.iron.addLathe({ x: spot.x, y: spot.y + 0.17, z: spot.z }, 0.16, (h) => 0.19 * (1 - h * 0.85), {
      radialSegments: 10,
      heightSegments: 3,
      uvScale: 3,
    });
    b.iron.addTube(
      new THREE.Vector3(spot.x, spot.y + 0.33, spot.z),
      new THREE.Vector3(spot.x, spot.y + 0.46, spot.z),
      0.016,
      0.016,
      6,
    );

    b.glass.addBox({ x: spot.x, y: spot.y, z: spot.z }, { x: 0.24, y: 0.31, z: 0.24 }, 2);
    // The flame: a teardrop, not a sphere — the tapered tip is what reads it as fire.
    b.flame.addLathe(
      { x: spot.x, y: spot.y - 0.11, z: spot.z },
      0.17,
      (h) => 0.05 * Math.sin(Math.pow(h, 0.6) * Math.PI) + 0.008,
      { radialSegments: 8, heightSegments: 6 },
    );
  }

  // The hold's is the last on the list, and it is the only one that ignores the clock.
  return spots.map((position, index) => ({ position, alwaysOn: index === 2 }));
}

// ---------------------------------------------------------------------------
// Moving parts
// ---------------------------------------------------------------------------

/**
 * The helm.
 *
 * It turns on its own Z axis because the wheel stands upright, facing aft. What turns it
 * is `Rudder`, and the visible angle is the rudder's angle times the number of turns from
 * stop to stop — on a sloop, a little over one full turn.
 */
export function createWheel(materials: ShipMaterials): THREE.Group {
  const b = createPartBuilders();
  const spokes = 8;

  b.spar.addTorusZ({ x: 0, y: 0, z: 0 }, WHEEL_RADIUS, 0.055, 30, 8, 1.5);

  for (let i = 0; i < spokes; i++) {
    // Handle zero is born **at the top**, and it is where the amidships mark comes
    // from.
    const angle = (i / spokes) * Math.PI * 2 + Math.PI * 0.5;
    const marked = i === 0;
    const direction = new THREE.Vector3(Math.cos(angle), Math.sin(angle), 0);
    b.spar.addTube(
      new THREE.Vector3(0, 0, 0),
      direction.clone().multiplyScalar(WHEEL_RADIUS + 0.12),
      0.05,
      0.032,
      7,
      2,
    );

    // A handle at the end of each spoke: they are what you pull the wheel by.
    //
    // **One of them is brass, and it is the only reading of "rudder amidships" that
    // exists aboard.** Without that mark there is no way to know, looking at the wheel,
    // whether it is centered or one turn off: the eight handles are identical, the wheel
    // gives a little over one turn from stop to stop, and the ship answers too slowly for
    // the offset to show before it has already swung. The player was left with trial and
    // error — turn, wait, correct —, which is exactly what Sea of Thieves' mark does away
    // with.
    //
    // The arithmetic that makes it work is in `syncModel`: the wheel turns `-wheelAngle`,
    // so the handle born at 90° only comes back to the top when `wheelAngle` is zero, and
    // zero is the rudder amidships. Handle upright, ship straight.
    //
    // The mark is the **color**, and only that. The first version gave the marked handle
    // a larger diameter and a rounded head at the tip, and the three things together
    // produced a 13 cm brass mushroom parked in the middle of the screen of whoever is
    // steering. A handle like all the others, in another material, already reads at a
    // glance — which is all a rudder-amidships mark has to do.
    const handle = marked ? b.brass : b.spar;
    handle.addTube(
      direction.clone().multiplyScalar(WHEEL_RADIUS + 0.03),
      direction.clone().multiplyScalar(WHEEL_RADIUS + 0.19),
      0.052,
      0.043,
      8,
      3,
    );
  }

  b.brass.addTube(new THREE.Vector3(0, 0, -0.11), new THREE.Vector3(0, 0, 0.11), 0.135, 0.135, 14, 3);

  const group = new THREE.Group();
  group.name = 'helm-wheel';
  group.position.set(0, WHEEL_Y, tToZ(STATIONS.helm));
  emitMeshes(b, materials, group);
  return group;
}

/** The capstan, which weighs the anchor. It turns around +Y. */
export function createCapstan(materials: ShipMaterials): THREE.Group {
  const b = createPartBuilders();
  const height = 1.02;

  b.spar.addLathe(
    { x: 0, y: 0, z: 0 },
    height,
    (h) => 0.34 - 0.1 * Math.sin(h * Math.PI) + 0.04 * h,
    { radialSegments: 16, heightSegments: 8, capTop: true, uvScale: 1.6 },
  );

  // Vertical whelps: the ribs the cable bites on.
  for (let i = 0; i < 6; i++) {
    const angle = (i / 6) * Math.PI * 2;
    b.spar.addBox(
      { x: Math.cos(angle) * 0.26, y: height * 0.45, z: Math.sin(angle) * 0.26 },
      { x: 0.07, y: height * 0.62, z: 0.07 },
      2,
    );
  }

  b.iron.addLathe({ x: 0, y: height - 0.12, z: 0 }, 0.09, () => 0.4, {
    radialSegments: 16,
    heightSegments: 1,
    uvScale: 2.5,
  });

  // Push bars, shipped into the top.
  for (let i = 0; i < 4; i++) {
    const angle = (i / 4) * Math.PI * 2 + Math.PI * 0.25;
    b.spar.addTube(
      new THREE.Vector3(Math.cos(angle) * 0.2, height - 0.2, Math.sin(angle) * 0.2),
      new THREE.Vector3(Math.cos(angle) * 1.15, height - 0.38, Math.sin(angle) * 1.15),
      0.055,
      0.04,
      8,
      1.5,
    );
  }

  const group = new THREE.Group();
  group.name = 'capstan';
  group.position.set(
    0,
    DECK_Y + deckCamber(0, deckHalfWidth(STATIONS.capstan)),
    tToZ(STATIONS.capstan),
  );
  emitMeshes(b, materials, group);
  return group;
}

export interface CannonAssembly {
  /** The root: position on the deck and the side's fixed orientation. */
  root: THREE.Group;
  /** Turns in Y — the traverse, within the carriage's stop. */
  traverse: THREE.Group;
  /** Turns in X — the barrel's elevation. */
  elevation: THREE.Group;
  /** The muzzle: where the ball is born and where the smoke comes out. */
  muzzle: THREE.Object3D;
}

/** Length of the barrel, from breech to muzzle. */
export const BARREL_LENGTH = 1.9;
/** How much of the barrel sits behind the trunnions, which are the elevation axis. */
export const BREECH_OFFSET = 0.55;
/** Height of the barrel's axis above the deck — enough to clear the bulwark. */
export const BARREL_AXIS_Y = 1.12;
/** Radius of the bore. It is also the radius of the ball `Cannonball` fires. */
export const BORE_RADIUS = 0.052;

/**
 * The barrel's profile, from breech (h = 0) to muzzle (h = 1).
 *
 * The steps are not decoration: a cast-iron gun is thicker where the pressure is higher,
 * and the two reinforcing rings mark where the thickness changes. Encoding them in the
 * profile is cheaper than modeling separate rings — and the same goes for the muzzle,
 * which dives inward over the last 4% and therefore reads as a hole instead of a cap.
 */
function barrelProfile(h: number): number {
  if (h > 0.96) {
    const k = (h - 0.96) / 0.04;
    return barrelProfile(0.96) * (1 - k) + BORE_RADIUS * k;
  }
  const taper = 0.135 - 0.048 * Math.pow(h, 0.75);
  const breech = h < 0.04 ? -0.02 * (1 - h / 0.04) : 0;
  const band = (center: number, width: number, size: number): number =>
    Math.max(0, size * (1 - Math.abs(h - center) / width));
  const swell = h > 0.86 ? 0.022 * Math.sin(((h - 0.86) / 0.1) * Math.PI) : 0;
  return taper + breech + band(0.22, 0.05, 0.018) + band(0.58, 0.045, 0.014) + swell;
}

export function createCannon(materials: ShipMaterials, side: 1 | -1): CannonAssembly {
  // ---- Carriage: it follows the traverse, but not the elevation ----
  const carriage = createPartBuilders();
  const wheelRadius = 0.16;

  carriage.spar.addBox({ x: 0, y: 0.44, z: 0 }, { x: 0.72, y: 0.18, z: 1.2 }, 1.2);
  // The quoin, under the breech.
  carriage.spar.addBox({ x: 0, y: 0.64, z: 0.42 }, { x: 0.3, y: 0.24, z: 0.34 }, 2);

  for (const sx of [1, -1]) {
    // **The bracket is stepped, and not a block.**
    //
    // A naval carriage has this profile out of necessity: the piece is tall forward,
    // where it carries the trunnions, and steps down toward the breech, where there has
    // to be room for the quoin and for the hand of whoever is laying the gun. Modeled as
    // a single 72 cm-tall box, the carriage turned into a black crate with a barrel
    // coming out of it — the reading the deck's screenshot gave, and the one that looks
    // least like artillery. Three steps cost two extra boxes per side and give back the
    // silhouette you recognize from a distance.
    carriage.spar.addBox({ x: sx * 0.26, y: 0.8, z: -0.26 }, { x: 0.11, y: 0.72, z: 0.5 }, 1.2);
    carriage.spar.addBox({ x: sx * 0.26, y: 0.68, z: 0.1 }, { x: 0.11, y: 0.48, z: 0.28 }, 1.2);
    carriage.spar.addBox({ x: sx * 0.26, y: 0.6, z: 0.38 }, { x: 0.11, y: 0.32, z: 0.32 }, 1.2);
    // An iron strap on the bracket, where the wood is bolted to the axletree.
    carriage.iron.addBox({ x: sx * 0.265, y: 0.56, z: -0.36 }, { x: 0.125, y: 0.07, z: 0.28 }, 3);
    for (const sz of [1, -1]) {
      const start = carriage.iron.vertexCount;
      carriage.iron.addLathe({ x: 0, y: -0.045, z: 0 }, 0.09, () => wheelRadius, {
        radialSegments: 12,
        heightSegments: 1,
        capBottom: true,
        capTop: true,
        uvScale: 2,
      });
      // The lathe spins around +Y; the truck needs its axis in X.
      carriage.iron.transformFrom(
        start,
        new THREE.Matrix4()
          .makeRotationZ(Math.PI * 0.5)
          .setPosition(sx * 0.37, wheelRadius, sz * 0.4),
      );
    }
  }

  // ---- Barrel: it turns in elevation around the trunnions ----
  const barrel = createPartBuilders();

  // The barrel and the cascabel come off the lathe upright; a single transform lays them
  // both down, and capturing the counter beforehand is what avoids depending on how many
  // vertices each piece generated.
  //
  // The UV is in meters, so `uvScale` decides how big the casting flaw shows up on the
  // piece. At 1.4 the tile covered 71 cm of barrel and the metal map's coarse layer
  // became a 9 cm blotch: at aiming zoom, half a meter from the eye, the barrel read as
  // pumice instead of cast iron. At 3 the tile drops to 33 cm and the same flaw lands
  // around 4 cm, which is the real scale of foundry sand.
  const barrelStart = barrel.iron.vertexCount;
  barrel.iron.addLathe({ x: 0, y: 0, z: 0 }, BARREL_LENGTH, barrelProfile, {
    radialSegments: 18,
    heightSegments: 25,
    capBottom: true,
    capTop: true,
    uvScale: 3,
  });
  barrel.iron.addLathe(
    { x: 0, y: -0.17, z: 0 },
    0.18,
    (h) => 0.085 * Math.sin(Math.max(h, 0.08) * Math.PI) + 0.026,
    { radialSegments: 12, heightSegments: 6, capBottom: true },
  );
  barrel.iron.transformFrom(
    barrelStart,
    new THREE.Matrix4().makeRotationX(-Math.PI * 0.5).setPosition(0, 0, BREECH_OFFSET),
  );

  // Trunnions: they are already born on the X axis, so they stay out of the rotation
  // above.
  for (const sx of [1, -1]) {
    barrel.iron.addTube(
      new THREE.Vector3(sx * 0.1, 0, 0),
      new THREE.Vector3(sx * 0.25, 0, 0),
      0.072,
      0.068,
      10,
      3,
    );
  }
  // The vent: the priming hole the match lights the charge through.
  //
  // The bushing is brass on purpose (bronze resists the fire's erosion better than cast
  // iron), but it is the barrel's only yellow piece and it sits less than a meter from the
  // eye in cannon mode — the previous version, 6 cm across and standing 4.4 cm proud of a
  // barrel of 12.6 cm radius, read as a green chip driven into the piece. A real vent
  // bushing barely passes 4 cm and is nearly flush; with 12 sides it also stops faceting
  // at that distance.
  barrel.brass.addTube(
    new THREE.Vector3(0, 0.1, 0.34),
    new THREE.Vector3(0, 0.142, 0.34),
    0.021,
    0.016,
    12,
    3,
  );

  // ---- Assembly ----
  const root = new THREE.Group();
  const traverse = new THREE.Group();
  const elevation = new THREE.Group();
  const muzzle = new THREE.Object3D();

  const halfWidth = deckHalfWidth(STATIONS.cannon);
  const x = side * (halfWidth - 0.5);
  root.name = side > 0 ? 'cannon-starboard' : 'cannon-port';
  root.position.set(x, DECK_Y + deckCamber(x, halfWidth) - 0.02, tToZ(STATIONS.cannon));
  // The local -Z points to the matching side: it is the piece's rest pose, and it is what
  // makes the traverse in Y and the elevation in X mean what you expect.
  root.rotation.y = side > 0 ? -Math.PI * 0.5 : Math.PI * 0.5;

  traverse.name = 'traverse';
  elevation.name = 'elevation';
  elevation.position.set(0, BARREL_AXIS_Y, 0);
  muzzle.name = 'muzzle';
  muzzle.position.set(0, 0, BREECH_OFFSET - BARREL_LENGTH);

  emitMeshes(carriage, materials, traverse);
  emitMeshes(barrel, materials, elevation);

  elevation.add(muzzle);
  traverse.add(elevation);
  root.add(traverse);
  return { root, traverse, elevation, muzzle };
}

/**
 * The rudder: a blade with a foil section, abaft the sternpost. It turns in Y on its own
 * stock.
 *
 * The blade is wider at the bottom because that is where the water runs cleanest, away
 * from the hull's wake — and it is that submerged area `Rudder` converts into torque. The
 * thickness goes to zero at both edges, so the two sides meet on their own and no seam is
 * left to close.
 */
export function createRudder(materials: ShipMaterials): THREE.Group {
  const b = createPartBuilders();
  const { topY, bottomY, topChord, bottomChord, leadingEdge, rake, thickness: maxThickness } =
    RUDDER_BLADE;

  const heightSegments = 8;
  const chordSegments = 8;

  const face = (s: number, w: number, side: number): Vertex => {
    const y = bottomY + (topY - bottomY) * s;
    const chord = topChord * s + bottomChord * (1 - s);
    // The rake carries the blade's foot forward, under the stern.
    const z = leadingEdge - rake * (1 - s) + w * chord;
    const thickness = maxThickness * Math.sin(Math.pow(w, 0.6) * Math.PI);
    return vertex(side * thickness, y, z, z * 0.7, y * 0.7);
  };

  // One side at a time, like on the hull: starboard needs the orientation flipped.
  for (const side of [1, -1]) {
    b.hull.addSurface(heightSegments, chordSegments, (s, w) => face(s, w, side), side > 0);
  }

  // Bottom and top caps, stitching the two sides together.
  for (const s of [0, 1]) {
    const starboard: Vertex[] = [];
    const port: Vertex[] = [];
    for (let i = 0; i <= chordSegments; i++) {
      const w = i / chordSegments;
      starboard.push(face(s, w, 1));
      port.push(face(s, w, -1));
    }
    b.hull.addStrip(starboard, port, s === 1);
  }

  // Pintles and gudgeons: the ironwork that hangs the rudder on the sternpost. There are
  // three because the blade is tall now, and two would leave the leading edge visibly
  // loose.
  for (const s of [0.12, 0.5, 0.88]) {
    const y = bottomY + (topY - bottomY) * s;
    const z = leadingEdge - rake * (1 - s) + 0.02;
    b.iron.addTube(
      new THREE.Vector3(-0.13, y, z),
      new THREE.Vector3(0.13, y, z),
      0.06,
      0.06,
      10,
      3,
    );
  }

  const group = new THREE.Group();
  group.name = 'rudder';
  group.position.set(0, 0, RUDDER_BLADE.postZ);
  emitMeshes(b, materials, group);
  return group;
}

/**
 * The anchor, hung on the starboard bow.
 *
 * It lives in its own group because `Anchor` lowers and raises it — and because, with it
 * on the bottom, it is the thing that stays put while the ship swings around it.
 */
export function createAnchor(materials: ShipMaterials): THREE.Group {
  const b = createPartBuilders();

  // Shank, stock and ring. The piece is built in the XY plane — arms splayed in X — and
  // it is the **group** that turns it into the side's plane. See the pose below.
  b.iron.addTube(new THREE.Vector3(0, 0.95, 0), new THREE.Vector3(0, -0.5, 0), 0.055, 0.07, 10, 2);
  b.iron.addTube(
    new THREE.Vector3(-0.52, 0.78, 0),
    new THREE.Vector3(0.52, 0.78, 0),
    0.045,
    0.035,
    8,
    2,
  );
  b.iron.addTorusZ({ x: 0, y: 1.03, z: 0 }, 0.11, 0.028, 14, 6, 3);

  for (const side of [1, -1]) {
    b.iron.addTube(
      new THREE.Vector3(0, -0.48, 0),
      new THREE.Vector3(side * 0.5, -0.16, 0),
      0.065,
      0.035,
      8,
      2,
    );
    // Fluke: the blade that bites the bottom.
    b.iron.addBox({ x: side * 0.57, y: -0.08, z: 0 }, { x: 0.26, y: 0.22, z: 0.055 }, 3);
  }

  const group = new THREE.Group();
  group.name = 'anchor';
  group.position.copy(ANCHOR_STOWED);
  // A quarter turn in Y: without it the arms point inboard and outboard, and the inboard
  // one goes through the side — the anchor was born with half of it driven into the bow.
  // Turned, the arms run along the hull and the piece lies flat against the side, which is
  // how an anchor travels.
  group.rotation.set(0, Math.PI * 0.5, -0.1);
  emitMeshes(b, materials, group);
  return group;
}

/**
 * Where the anchor sits when it is aboard — hung from the cathead, outboard of the
 * starboard bow.
 *
 * The X is measured off the hull at the height it hangs at, plus the piece's own
 * clearance: with the shank on the group's axis, the anchor's inboard half takes up
 * 12 cm, and it is that distance that keeps it close against the side without going into
 * it.
 */
export const ANCHOR_STOWED = new THREE.Vector3(
  halfWidthAtHeight(0.9, 1.7) + 0.14,
  1.7,
  tToZ(0.9),
);

/**
 * The cathead: the beam that reaches out from the bulwark and holds the anchor clear of
 * the side.
 *
 * It exists out of the model's structural necessity, not as decoration: the anchor hung
 * from nothing, and 250 kg of iron hanging in the air a hand from the hull is exactly the
 * kind of thing the eye registers as wrong before knowing why.
 */
function buildCathead(b: PartBuilders): void {
  const z = ANCHOR_STOWED.z;
  const t = zToT(z);
  const railY = sheerAt(z) - 0.1;
  const inboard = halfWidthAtHeight(t, railY) - 0.35;

  b.spar.addBox(
    { x: (inboard + ANCHOR_STOWED.x) * 0.5, y: railY, z },
    { x: ANCHOR_STOWED.x - inboard + 0.3, y: 0.19, z: 0.22 },
    2,
  );
  // A diagonal brace, from the side to the cathead's tip.
  b.spar.addTube(
    new THREE.Vector3(inboard, railY - 0.62, z),
    new THREE.Vector3(ANCHOR_STOWED.x, railY - 0.06, z),
    0.055,
    0.045,
    6,
    2,
  );
  // The lifting hook at the tip, which the anchor hangs from.
  b.iron.addTube(
    new THREE.Vector3(ANCHOR_STOWED.x, railY - 0.06, z),
    new THREE.Vector3(ANCHOR_STOWED.x, ANCHOR_STOWED.y + 0.95, z),
    0.022,
    0.022,
    7,
  );
}

/**
 * The masthead ensign: the pennant that flies at the top of the mast.
 *
 * The geometry is worth it for a gameplay reason, not for decoration. At two hundred
 * meters the sloop is a dark silhouette with a pale rectangle in the middle, and the
 * duel's two are identical — the ensign is the second thing you tell apart after the
 * canvas's color, and it is the one you see against the sky even when the sail is
 * edge-on.
 *
 * It uses the sail's material (and therefore each ship's tint, see `tintSail`), so the
 * enemy's ensign is born crimson along with their canvas, for free.
 */
export const ENSIGN_FRAME = {
  columns: 10,
  rows: 4,
  /** Length of the cloth, from the halyard to the tip. */
  length: 1.9,
  /** Height at the staff. */
  height: 0.62,
  /** How much the tip tapers — a pennant, not a rectangle. */
  taper: 0.32,
  /** Height of the cloth's middle. */
  y: MAST_TOP_Y - 0.35,
  z: MAST_Z + 0.06,
} as const;

/** Index of node `(i, j)` in the ensign's grid. `EnsignSim` uses the same arithmetic. */
export function ensignVertexIndex(i: number, j: number): number {
  return j * (ENSIGN_FRAME.columns + 1) + i;
}

/** Rest position of node `(i, j)`: the cloth stretched straight aft. */
export function ensignRestPoint(i: number, j: number, target: THREE.Vector3): THREE.Vector3 {
  const { columns, rows, length, height, taper, y, z } = ENSIGN_FRAME;
  const u = i / columns;
  const v = j / rows;
  return target.set(0, y + (v - 0.5) * height * (1 - u * taper), z + u * length);
}

export function createEnsign(): THREE.BufferGeometry {
  const { columns, rows } = ENSIGN_FRAME;
  const positions = new Float32Array((columns + 1) * (rows + 1) * 3);
  const uvs = new Float32Array((columns + 1) * (rows + 1) * 2);
  const indices: number[] = [];
  const point = new THREE.Vector3();

  for (let j = 0; j <= rows; j++) {
    for (let i = 0; i <= columns; i++) {
      const index = ensignVertexIndex(i, j);
      // It is born straight and with no ripple at all. The ripple **is** the simulation
      // now (`EnsignSim`): the previous version baked a sine into the geometry and the
      // ensign kept exactly the same fold forever, in any wind, pointing aft even with
      // the wind coming from there.
      ensignRestPoint(i, j, point);
      positions[index * 3] = point.x;
      positions[index * 3 + 1] = point.y;
      positions[index * 3 + 2] = point.z;
      uvs[index * 2] = i / columns;
      uvs[index * 2 + 1] = j / rows;

      if (i < columns && j < rows) {
        const a = index;
        const b = index + 1;
        const c = index + columns + 2;
        const d = index + columns + 1;
        indices.push(a, b, c, a, c, d);
      }
    }
  }

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  geometry.setAttribute('uv', new THREE.BufferAttribute(uvs, 2));
  geometry.setIndex(indices);
  geometry.computeVertexNormals();
  return withAoUv(geometry);
}

// ---------------------------------------------------------------------------
// Sail
// ---------------------------------------------------------------------------

/** Index of vertex `(i, j)` in the sail's grid. `SailSim` uses the same arithmetic. */
export function sailVertexIndex(i: number, j: number): number {
  return j * (SAIL_FRAME.columns + 1) + i;
}

/**
 * Minimum clearance between the canvas and the mast, in Z, for a given height and
 * distance from the axis.
 *
 * **This is what made the sail look like it was on the wrong side.** The cloth is born in
 * the mast's plane, and the belly is zero along the four edges — which are exactly the
 * boltropes made fast to the yard and the boom. The result is that the cloth's upper and
 * lower halves, mid-span, were born *inside* the trunk: the mast cut the canvas in half
 * and what you saw was half a sail on each side of the spar, as if it had been shipped
 * backwards.
 *
 * The arithmetic is the usual one for clearing a cylinder: how far away in Z you have to
 * be, at a distance `x` from the axis, to stay outside a radius `r`. Outside the radius it
 * returns zero, and from there the wind's belly rules on its own.
 */
export function mastClearance(x: number, y: number): number {
  const radius = mastRadius(y) + 0.07;
  const distance = Math.abs(x);
  return distance >= radius ? 0 : Math.sqrt(radius * radius - distance * distance);
}

/** Rest position of node `(i, j)`, with the initial belly already in it. */
export function sailRestPoint(i: number, j: number, target: THREE.Vector3): THREE.Vector3 {
  const { columns, rows, halfWidth, topY, bottomY, z } = SAIL_FRAME;
  const u = i / columns;
  const v = j / rows;
  // Belly: maximum at the center, zero at the edges made fast to the yard and boom.
  const belly = Math.sin(u * Math.PI) * Math.sin(v * Math.PI) * 0.85;
  const x = (u * 2 - 1) * halfWidth;
  const y = topY + (bottomY - topY) * v - belly * 0.12;
  return target.set(x, y, z - Math.max(belly, mastClearance(x, y)));
}

/**
 * The sail's grid, ready for `SailSim` to move.
 *
 * This is the only piece of the ship that does **not** go through `GeometryBuilder`: it
 * gives every quad four vertices of its own, which is exactly what you want on a hull
 * (hard edges for free) and exactly what you do not want on cloth. Here the vertices are
 * shared in an indexed `(columns+1) × (rows+1)` grid, for two reasons: the shading comes
 * out smooth instead of faceted quad by quad, and the simulator has one particle per
 * vertex instead of four copies of the same node to keep in sync.
 *
 * It is born with the belly the wind gives it, so the ship looks right even before the
 * physics comes in.
 */
export function createSailGeometry(): THREE.BufferGeometry {
  const { columns, rows } = SAIL_FRAME;
  const vertexCount = (columns + 1) * (rows + 1);

  const positions = new Float32Array(vertexCount * 3);
  const uvs = new Float32Array(vertexCount * 2);
  const indices = new Uint16Array(columns * rows * 6);
  const point = new THREE.Vector3();

  for (let j = 0; j <= rows; j++) {
    for (let i = 0; i <= columns; i++) {
      const index = sailVertexIndex(i, j);
      sailRestPoint(i, j, point);
      positions[index * 3] = point.x;
      positions[index * 3 + 1] = point.y;
      positions[index * 3 + 2] = point.z;
      uvs[index * 2] = i / columns;
      uvs[index * 2 + 1] = j / rows;
    }
  }

  // The order is chosen so the normal comes out pointing forward, the same side the
  // belly inflates toward. (The cloth is `DoubleSide` anyway, but the right normal is what
  // makes the sun pass through it from the right side.)
  let cursor = 0;
  for (let j = 0; j < rows; j++) {
    for (let i = 0; i < columns; i++) {
      const a = sailVertexIndex(i, j);
      const b = sailVertexIndex(i + 1, j);
      const c = sailVertexIndex(i + 1, j + 1);
      const d = sailVertexIndex(i, j + 1);
      indices[cursor++] = a;
      indices[cursor++] = b;
      indices[cursor++] = c;
      indices[cursor++] = a;
      indices[cursor++] = c;
      indices[cursor++] = d;
    }
  }

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  geometry.setAttribute('uv', new THREE.BufferAttribute(uvs, 2));
  geometry.setIndex(new THREE.BufferAttribute(indices, 1));
  geometry.computeVertexNormals();
  return withAoUv(geometry);
}
