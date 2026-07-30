/**
 * The shape of the Sloop's hull, in numbers.
 *
 * This module is the **single source** of the ship's shape: the visual geometry
 * (`HullGeometry`), the buoyancy sampling points (`Buoyancy`), the cannonball
 * collision and the "where the player can step" test all read from here. If the
 * two descriptions diverged, the ship would float outside its own hull — it is
 * the same reason `WaveField` generates the waves' GLSL from the array the CPU
 * uses.
 *
 * **Local coordinate system:** `-Z` is the bow, `+X` is starboard, `+Y` is up,
 * and the origin sits on the **design waterline**, at mid-length. `-Z` forward is
 * not taste: it is the axis `Object3D.getWorldDirection` returns, so the ship's
 * heading comes for free, with no correction matrix.
 */

import * as THREE from 'three';
import { clamp, clamp01 } from '../core/MathUtils';

/** Overall hull length, in meters (from the stem to the transom). */
export const HULL_LENGTH = 16;
/** Maximum beam. */
export const HULL_BEAM = 5;
/** Half length — `t = 0` sits at `+HALF_LENGTH`, `t = 1` at `-HALF_LENGTH`. */
export const HALF_LENGTH = HULL_LENGTH / 2;

/** Height of the main deck above the waterline. */
export const DECK_Y = 1.3;
/** Height of the hold's floor. Gives ~1.8 m of headroom — cramped, as in the game. */
export const HOLD_FLOOR_Y = -0.55;
/** Thickness of the planking. Separates the bulwark's outer face from its inner one. */
export const HULL_THICKNESS = 0.13;
/**
 * Thickness of the deck and the quarterdeck.
 *
 * The deck is born as a single-surface sweep, meaning zero thickness. Except it
 * is not only a floor: it is the **hold's ceiling**, and a zero-thickness ceiling
 * disappears seen from below (the face looks up, the material is `FrontSide`, and
 * the result is seeing the sky through the deck). This number is what separates
 * the top face from the bottom one — and, as a bonus, it is what sets the hold's
 * real headroom, which the player cannot push their head through.
 */
export const DECK_THICKNESS = 0.09;

/** Height of the after quarterdeck, where the helm is. */
export const QUARTERDECK_Y = 1.74;
/**
 * How far, in `t`, the quarterdeck extends from the stern.
 *
 * 0.20 gives 3.2 m of quarterdeck, and the number came from measuring the
 * helmsman's station rather than choosing a proportion. At 0.17 there were 2.7 m
 * left to fit the wheel, the binnacle ahead of it and the man behind — and the
 * man was the one paying: he stood 35 cm from the stern bulwark, with the back of
 * his head against the taffrail. Half a meter more deck is the difference between
 * a station and a step.
 */
export const QUARTERDECK_T = 0.2;

/**
 * How far the bulwark closes inward above the deck.
 *
 * A real hull has its maximum beam at the waterline or a little above, and from
 * there up it "falls" back in. Without that tumblehome the section would keep
 * opening to the top and the ship would look like a basin.
 */
const TUMBLEHOME = 0.06;

/**
 * Notable positions along the hull, in `t` (0 = stern, 1 = bow).
 * They live here, and not in whoever builds each part, because mast, hatch and
 * cannons need to agree with each other — and with the hold below them.
 */
export const STATIONS = {
  // The wheel moved from 0.075 to 0.105 — 48 cm forward — and the reason is the
  // room behind whoever is steering. The helmsman stands 85 cm abaft the wheel,
  // and with the wheel nearly on the taffrail there was half a step between him
  // and the bulwark: you could steer, but you could not walk around the station
  // or back away from it. At 0.105, and with a longer quarterdeck, more than a
  // meter is left behind.
  helm: 0.105,
  quarterdeckEdge: QUARTERDECK_T,
  // Moved back almost to the quarterdeck for a reason of circulation, not of
  // aesthetics: with the hatch at 0.4 there was less than half a meter between
  // the edge of the hole and the gun carriage, and anyone coming down the side
  // was pushed by the gun into the opening and fell into the hold. At 0.31 there
  // is ~1 m of full deck between the two, which is the corridor the Sea of
  // Thieves Sloop has as well.
  hatch: 0.31,
  mast: 0.575,
  // The guns sit abaft the mast, and not hugging it. With the gun at 0.5 there
  // were 1.2 m between the mast and the carriage, and the corridor left on the
  // diagonal — passing inboard of the gun and outboard of the mast — was 33 cm:
  // you could get through, but grazing both, once a second. At 0.45 the gap
  // opens to nearly 1 m, which is the clear deck of the Sea of Thieves Sloop.
  cannon: 0.45,
  capstan: 0.75,
  stem: 1,
} as const;

/**
 * The rudder blade, in numbers — **single source**, same as the hull.
 *
 * `createRudder` builds the mesh from here and `Rudder` takes the area and the
 * center of pressure from here. The first version had the two separate and they
 * diverged badly: the physics said 1.5 m² while the drawn blade had 0.37 m²
 * submerged, four times less. The ship steered with a blade nobody could see.
 *
 * `bottomY` stops at −1.4 m on purpose: the keel goes down to −1.55 m amidships,
 * and a rudder that goes past the keel is a rudder that hits the bottom before
 * the hull does. It is the same rule a shipyard follows.
 */
export const RUDDER_BLADE = {
  /** Local Z of the stock — the axis the blade turns about, just abaft the transom. */
  postZ: HALF_LENGTH + 0.02,
  /** Gap between the stock and the blade's leading edge, so it turns without grazing. */
  leadingEdge: 0.05,
  /** Top of the blade, above the waterline: it is where the tiller goes in. */
  topY: 0.7,
  /** Bottom of the blade. Above the midship keel, see above. */
  bottomY: -1.4,
  /** Chord (fore-aft length) at the top and the bottom of the blade. */
  topChord: 0.62,
  bottomChord: 1.25,
  /**
   * How far the bottom of the blade advances forward relative to the top.
   *
   * It is the sternpost's rake. Without it the blade would drop straight down
   * abaft the transom, hanging in open water; with it the foot of the blade tucks
   * under the stern, which is how a full-keel sailing boat really is.
   */
  rake: 0.5,
  /** Maximum thickness of the profile. */
  thickness: 0.085,
} as const;

/**
 * Area and center of pressure of the blade's submerged part, at design draft.
 *
 * It integrates the same trapezoid the mesh draws, so the two have no way to
 * disagree. It runs once, when the `Rudder` is built.
 */
export function measureRudderBlade(): { area: number; centerY: number; centerZ: number } {
  const { topY, bottomY, topChord, bottomChord, postZ, leadingEdge, rake } = RUDDER_BLADE;
  const height = topY - bottomY;
  const steps = 128;
  let area = 0;
  let momentY = 0;
  let momentZ = 0;

  for (let i = 0; i < steps; i++) {
    // Only the submerged band: from `bottomY` up to the waterline.
    const y = bottomY + (0 - bottomY) * ((i + 0.5) / steps);
    const s = (y - bottomY) / height;
    const chord = topChord * s + bottomChord * (1 - s);
    const slice = chord * ((0 - bottomY) / steps);

    area += slice;
    momentY += y * slice;
    // Center of the chord, already shifted by the rake at that height.
    momentZ += (postZ + leadingEdge - rake * (1 - s) + chord * 0.5) * slice;
  }

  return { area, centerY: momentY / area, centerZ: momentZ / area };
}

/**
 * Area and center of the hull's silhouette **above** the waterline, from abeam.
 *
 * It is what the wind catches when it blows from the side: from the waterline to
 * the top of the bulwark, along the whole length. `SailSim` uses this to know
 * **where** to apply the wind's thrust on the topsides — and that "where" decides
 * whether the ship bears away or luffs up.
 *
 * The arithmetic is not decorative. The center of effort was pinned at the mast,
 * 2.11 m ahead of the center of mass, and with that lever arm the ship bore away
 * on its own at ~0.1°/s on either tack: permanent lee helm, which is exactly what
 * no designer accepts in a boat. The topsides measure 37.7 m² with the center at
 * z = −0.21 — almost amidships, because it is 16 m of length against the few
 * square meters of mast, and the sheer still rises at both ends. Composed with the
 * rig the center sits at −0.35 and the lever arm falls to 1.26 m.
 */
export function measureWindageProfile(): { area: number; centerY: number; centerZ: number } {
  const section: HullSection = { halfBeam: 0, keelY: 0, sheerY: 0, fullness: 1 };
  const steps = 256;
  const dz = HULL_LENGTH / steps;
  let area = 0;
  let momentY = 0;
  let momentZ = 0;

  for (let i = 0; i < steps; i++) {
    const t = (i + 0.5) / steps;
    sampleSection(t, section);
    // Only what is out of the water: from the waterline (y = 0) to the sheer.
    const freeboard = Math.max(section.sheerY, 0);
    const slice = freeboard * dz;

    area += slice;
    momentY += freeboard * 0.5 * slice;
    momentZ += tToZ(t) * slice;
  }

  return { area, centerY: momentY / area, centerZ: momentZ / area };
}

/**
 * Half width of the hold's hatch, in meters.
 *
 * A 1.16 m opening. It was 1.5 m, and 1.5 m is too wide: with 2.4 m of half-deck
 * amidships, the hole ate more than 60% of the usable width and what was left on
 * each side was a half-meter corridor between the coaming and the bulwark. Seen
 * standing on the deck, the Sloop read as a raft with a trapdoor in the middle.
 *
 * The number is not aesthetic: 1.16 m is the opening the stair needs (1 m of tread
 * width plus the clearance for the stringers), and that is the right criterion — a
 * ship's hatch is the size of whatever goes down through it.
 */
export const HATCH_HALF_WIDTH = 0.58;
/** Half length of the hatch, in `t`. Gives 1.92 m, the whole stair's run. */
export const HATCH_HALF_T = 0.06;

// -- the hold's stair --------------------------------------------------------
//
// It is not a rigging ladder: it is a **sloped flight**, the kind you walk down,
// like the one on the Sea of Thieves Sloop. That changes more than it seems —
// there is nothing to grab, no key to press and no "on the flight" state. The
// player walks into the hole, the foot finds the step and down they go. Climbing
// is the same thing in reverse, and the 26 cm riser passes comfortably under the
// half-meter `STEP_HEIGHT` the controller already uses for the quarterdeck.
//
// The whole geometry lives here because three consumers need to agree: the mesh
// that draws the steps, the floor the player walks on and the ceiling that does
// **not** exist above it.

/**
 * Half width of the flight, in meters.
 *
 * It is **exactly** the hatch's, and not a hand's breadth less. The difference
 * matters because the opening is a hole: any strip of the hatch the stair does not
 * cover is floor that vanishes, and anyone going down hugging one side would fall
 * 1.85 m beside the steps. Filling the whole opening leaves nowhere to fall.
 */
export const STAIR_HALF_WIDTH = HATCH_HALF_WIDTH;
/**
 * Z of the top of the flight — the after edge of the opening, with no gap at all.
 *
 * The 10 cm of setback that used to be here was a strip of nonexistent deck
 * between the coaming and the first step: the foot landed on nothing and the player
 * dropped into the hold instead of walking down the stair.
 */
export const STAIR_TOP_Z = tToZ(STATIONS.hatch - HATCH_HALF_T);
/**
 * Horizontal run of the flight, in meters.
 *
 * 1.55 m for 1.85 m of drop gives 50° — steep for a house stair and exactly what a
 * ship uses, where deck length is worth more than the comfort of the step. With
 * seven steps that comes to 26 cm of riser and 22 cm of tread.
 *
 * What this number really decides is whether the head hits: the whole flight has to
 * fit **inside** the projection of the opening, or whoever goes down puts their head
 * into the hold's ceiling halfway. 1.55 m against the opening's 1.92 m leaves 37 cm
 * to spare.
 */
export const STAIR_RUN = 1.55;
/** Z of the foot of the flight, on the hold's floor. */
export const STAIR_BOTTOM_Z = STAIR_TOP_Z - STAIR_RUN;
/** Steps in the flight. */
export const STAIR_STEPS = 7;

/** `true` when (x, z) falls inside the hatch opening. */
export function isOverHatch(x: number, z: number): boolean {
  return (
    Math.abs(x) <= HATCH_HALF_WIDTH &&
    Math.abs(zToT(z) - STATIONS.hatch) <= HATCH_HALF_T
  );
}

/**
 * Height of the step under (x, z), or `null` outside the flight.
 *
 * A step, and not a ramp: the tread is flat and the riser is vertical, which is what
 * makes going down feel like going down a stair instead of sliding down a slope.
 */
export function stairSurfaceY(x: number, z: number): number | null {
  if (Math.abs(x) > STAIR_HALF_WIDTH) return null;
  if (z > STAIR_TOP_Z || z < STAIR_BOTTOM_Z) return null;

  // 0 at the top, 1 at the foot.
  const k = (STAIR_TOP_Z - z) / STAIR_RUN;
  const step = Math.min(Math.floor(k * STAIR_STEPS), STAIR_STEPS - 1);
  return DECK_Y - ((DECK_Y - HOLD_FLOOR_Y) * (step + 1)) / STAIR_STEPS;
}

/**
 * Hull stations: the table of shapes that defines the whole ship.
 *
 * Each row is a cross section. `fullness` is the exponent of the section's curve:
 * below 1 it comes out full and rounded (the bilge amidships), above 1 it thins into
 * a V (the fine entry of the bow, which is what cuts the wave instead of slamming
 * into it).
 */
interface Station {
  /** Normalized longitudinal position: 0 at the stern, 1 at the bow. */
  t: number;
  /** Half breadth of the section, at the top of the bulwark. */
  halfBeam: number;
  /** Height of the keel at this section — the bottom's longitudinal rocker. */
  keelY: number;
  /** Height of the top of the bulwark. Rising at the ends is the classic sheer. */
  sheerY: number;
  fullness: number;
}

const STATION_TABLE: readonly Station[] = [
  { t: 0.0, halfBeam: 1.36, keelY: -0.56, sheerY: 2.58, fullness: 0.62 },
  { t: 0.08, halfBeam: 1.86, keelY: -0.96, sheerY: 2.43, fullness: 0.6 },
  { t: 0.2, halfBeam: 2.28, keelY: -1.31, sheerY: 2.26, fullness: 0.58 },
  { t: 0.35, halfBeam: 2.47, keelY: -1.5, sheerY: 2.16, fullness: 0.58 },
  { t: 0.48, halfBeam: 2.5, keelY: -1.55, sheerY: 2.14, fullness: 0.6 },
  { t: 0.6, halfBeam: 2.42, keelY: -1.54, sheerY: 2.18, fullness: 0.67 },
  { t: 0.72, halfBeam: 2.13, keelY: -1.45, sheerY: 2.31, fullness: 0.82 },
  { t: 0.83, halfBeam: 1.66, keelY: -1.26, sheerY: 2.52, fullness: 1.08 },
  { t: 0.92, halfBeam: 1.04, keelY: -0.99, sheerY: 2.76, fullness: 1.5 },
  { t: 0.97, halfBeam: 0.52, keelY: -0.73, sheerY: 2.93, fullness: 1.95 },
  { t: 1.0, halfBeam: 0.15, keelY: -0.44, sheerY: 3.04, fullness: 2.3 },
];

/**
 * Catmull-Rom over one channel of the table.
 *
 * Linear interpolation between stations would leave a corner at every section, and
 * on a hull that shows immediately: the specular highlight sweeps the curve and
 * gives away every joint. Catmull-Rom passes exactly through the control points (so
 * the table is still what you tune by hand) and gives continuous tangents as well.
 */
function catmullRom(p0: number, p1: number, p2: number, p3: number, s: number): number {
  const s2 = s * s;
  const s3 = s2 * s;
  return (
    0.5 *
    (2 * p1 + (p2 - p0) * s + (2 * p0 - 5 * p1 + 4 * p2 - p3) * s2 + (-p0 + 3 * p1 - 3 * p2 + p3) * s3)
  );
}

/** A cross section, already interpolated. */
export interface HullSection {
  halfBeam: number;
  keelY: number;
  sheerY: number;
  fullness: number;
}

const sectionScratch: HullSection = { halfBeam: 0, keelY: 0, sheerY: 0, fullness: 1 };

/**
 * Interpolates the table at `t`. Writes into `out` when it is passed — whoever calls
 * this inside the physics loop cannot allocate one object per point per frame.
 */
export function sampleSection(t: number, out: HullSection = sectionScratch): HullSection {
  const clamped = clamp01(t);

  // Linear search: there are eleven stations, and a binary one here would be more
  // code than the work it saves.
  let i = 0;
  while (i < STATION_TABLE.length - 2 && STATION_TABLE[i + 1]!.t < clamped) i++;

  const p1 = STATION_TABLE[i]!;
  const p2 = STATION_TABLE[i + 1]!;
  // At the ends the missing neighbor becomes the extreme itself: the curve finishes
  // with a smooth tangent instead of shooting off outside the hull.
  const p0 = STATION_TABLE[Math.max(i - 1, 0)]!;
  const p3 = STATION_TABLE[Math.min(i + 2, STATION_TABLE.length - 1)]!;

  const s = clamp01((clamped - p1.t) / (p2.t - p1.t));

  out.halfBeam = catmullRom(p0.halfBeam, p1.halfBeam, p2.halfBeam, p3.halfBeam, s);
  out.keelY = catmullRom(p0.keelY, p1.keelY, p2.keelY, p3.keelY, s);
  out.sheerY = catmullRom(p0.sheerY, p1.sheerY, p2.sheerY, p3.sheerY, s);
  out.fullness = catmullRom(p0.fullness, p1.fullness, p2.fullness, p3.fullness, s);
  return out;
}

/**
 * Half width of the hull at section `t`, at height parameter `v`.
 *
 * `v` runs through the section from 0 (keel) to 1 (top of the bulwark), and the
 * height is linear in `v` — that is what makes the inverse (`halfWidthAtHeight`) a
 * closed-form calculation instead of a search, which matters because buoyancy calls
 * it dozens of times per physics step.
 */
export function sectionHalfWidth(section: HullSection, v: number): number {
  const clamped = clamp01(v);
  const base = section.halfBeam * Math.pow(Math.sin(clamped * Math.PI * 0.5), section.fullness);

  // The tumblehome only acts above the deck, where the bulwark really falls in.
  const vDeck = sectionV(section, DECK_Y);
  if (clamped <= vDeck) return base;

  const above = clamp01((clamped - vDeck) / Math.max(1 - vDeck, 1e-4));
  return base * (1 - TUMBLEHOME * above * above);
}

/** The `v` parameter corresponding to an absolute height `y` in this section. */
export function sectionV(section: HullSection, y: number): number {
  return (y - section.keelY) / Math.max(section.sheerY - section.keelY, 1e-4);
}

/** Half width of the hull at `t` and height `y`. Zero below the keel. */
export function halfWidthAtHeight(t: number, y: number): number {
  const section = sampleSection(t, sectionScratch);
  if (y <= section.keelY || y >= section.sheerY) {
    return y >= section.sheerY ? sectionHalfWidth(section, 1) : 0;
  }
  return sectionHalfWidth(section, sectionV(section, y));
}

// -- the hull's surface in 3D ------------------------------------------------
//
// What follows is the same station table read as a **surface**, and not as a
// profile. It lives here, and not in whoever builds the mesh, because three
// different consumers need the same inner planking: the visual geometry, the hold's
// floor and the clip that erases the sea from inside the hull in the ocean shader.

const surfaceScratch: HullSection = { halfBeam: 0, keelY: 0, sheerY: 0, fullness: 1 };

/** A point on the hull's outer surface. `side` is +1 starboard, −1 port. */
export function hullSurfacePoint(
  t: number,
  v: number,
  side: number,
  out: THREE.Vector3,
): THREE.Vector3 {
  const section = sampleSection(t, surfaceScratch);
  return out.set(
    side * sectionHalfWidth(section, v),
    section.keelY + (section.sheerY - section.keelY) * v,
    tToZ(t),
  );
}

const tangentT = new THREE.Vector3();
const tangentV = new THREE.Vector3();
const surfaceA = new THREE.Vector3();
const surfaceB = new THREE.Vector3();

/**
 * The analytic outward normal, from the cross product of the two tangents.
 *
 * It comes from here and not from vertex differences because the inner surface has
 * to be offset **along the normal** (that is how you measure planking thickness),
 * and for that the normal has to exist before the mesh does.
 */
export function hullSurfaceNormal(
  t: number,
  v: number,
  side: number,
  out: THREE.Vector3,
): THREE.Vector3 {
  const e = 2e-3;
  hullSurfacePoint(Math.min(t + e, 1), v, side, surfaceA);
  hullSurfacePoint(Math.max(t - e, 0), v, side, surfaceB);
  tangentT.subVectors(surfaceA, surfaceB);

  hullSurfacePoint(t, Math.min(v + e, 1), side, surfaceA);
  hullSurfacePoint(t, Math.max(v - e, 0), side, surfaceB);
  tangentV.subVectors(surfaceA, surfaceB);

  // `dt × dv` points outward on starboard and inward on port — multiplying by
  // `side` fixes both at once.
  out.crossVectors(tangentT, tangentV).multiplyScalar(side);
  const length = out.length();
  return length > 1e-9 ? out.divideScalar(length) : out.set(side, 0, 0);
}

const insetNormal = new THREE.Vector3();

/**
 * A point on the **inner** surface (the planking), the hull's thickness inward along
 * the normal. Always on starboard — the hull is symmetric.
 */
export function innerSurfacePoint(t: number, v: number, out: THREE.Vector3): THREE.Vector3 {
  hullSurfacePoint(t, v, 1, out);
  hullSurfaceNormal(t, v, 1, insetNormal);
  return out.addScaledVector(insetNormal, -HULL_THICKNESS);
}

const innerScratch = new THREE.Vector3();

/**
 * Half width of the inner planking at station `t`, at height `y`. Zero when there is
 * no planking at that height (above the bulwark or below the bilge).
 *
 * Why bisection and not a closed form, as in `halfWidthAtHeight`: offsetting along
 * the normal **stops being** a horizontal offset as soon as the hull tilts. At the
 * bilge, 40° from vertical, the difference between the two calculations is 3 cm in X
 * and 8 cm in Y — exactly the gap that appeared between the hold's floor and the
 * planking, with the sea visible through it. The inner point's height is no longer
 * linear in `v`, so the inverse becomes a search.
 */
export function innerHalfWidthAt(t: number, y: number): number {
  if (y > innerSurfacePoint(t, 1, innerScratch).y) return 0;

  let low = 0;
  let high = 1;
  for (let i = 0; i < 20; i++) {
    const mid = (low + high) * 0.5;
    if (innerSurfacePoint(t, mid, innerScratch).y < y) low = mid;
    else high = mid;
  }

  return Math.max(innerSurfacePoint(t, (low + high) * 0.5, innerScratch).x, 0);
}

/** Converts `t` (0 stern, 1 bow) into local Z. */
export function tToZ(t: number): number {
  return HALF_LENGTH - t * HULL_LENGTH;
}

/** Inverse of `tToZ`, clamped to the hull. */
export function zToT(z: number): number {
  return clamp01((HALF_LENGTH - z) / HULL_LENGTH);
}

/**
 * Height of the floor the player walks on, at `t`.
 * The quarterdeck's step is deliberately abrupt: whoever builds the stair uses
 * exactly that discontinuity to know where to put it.
 */
export function walkableY(t: number): number {
  return t <= QUARTERDECK_T ? QUARTERDECK_Y : DECK_Y;
}

/**
 * The deck's camber: a few centimeters of crown in the middle so water runs off to
 * the edges. It is little, but it is what keeps the deck from reading as a flat
 * plate under raking light.
 */
export function deckCamber(x: number, halfWidth: number): number {
  const r = clamp(x / Math.max(halfWidth, 1e-3), -1, 1);
  return 0.085 * (1 - r * r);
}

/** Usable half width of the deck at `t` (with the planking already deducted). */
export function deckHalfWidth(t: number): number {
  return Math.max(halfWidthAtHeight(t, walkableY(t)) - HULL_THICKNESS, 0.05);
}

/**
 * How far the deck's **drawn edge** goes — which is not the usable half width.
 *
 * `deckHalfWidth` pulls back the planking's thickness **horizontally**, and it is
 * the right number for the physics: it is where the feet stop. Except the inner
 * planking is offset along the **normal**, and the two calculations diverge exactly
 * where the hull stops being vertical. Amidships the difference is 3 mm and nobody
 * sees it; at both ends, where the normal points almost entirely forward, the normal
 * offset barely moves X — and the deck came out up to 13 cm narrower than the
 * planking that was supposed to meet it.
 *
 * That was the gap running along the bow and stern corners, with the sea showing
 * through the joint between the deck and the planking. Drawing out to the planking
 * and letting the edge die inside the wood solves it by construction: the excess
 * vanishes inside a part that already exists, and there is no hairline joint to get
 * right.
 *
 * It only runs when the mesh is built, so `innerHalfWidthAt`'s bisection costs
 * nothing at game time.
 */
export function deckEdgeHalfWidth(t: number): number {
  const inner = innerHalfWidthAt(t, walkableY(t));
  // One hair more: a joint resting exactly on the line still flickers with the
  // z-fighting of depth buffer precision at 200 m away.
  return Math.max(deckHalfWidth(t), inner + 0.01);
}

/**
 * Height of the deck's underside — the hold's ceiling — at (x, t).
 *
 * It follows the quarterdeck's step and the sheer by the same path as the floor, so
 * the clearance between floor and ceiling is the same one the mesh draws.
 */
export function ceilingY(t: number, x: number): number {
  return walkableY(t) + deckCamber(x, deckHalfWidth(t)) - DECK_THICKNESS;
}

/**
 * Mass of the loaded ship, in kg.
 *
 * It comes out of the volume displaced at the design waterline: by Archimedes, a
 * ship in equilibrium displaces exactly its own mass in water. Computing instead of
 * guessing is what guarantees the Sloop is born floating at the drawn draft, without
 * anybody having to tweak a number until it stops sinking.
 */
export function computeDisplacement(): { mass: number; volume: number } {
  const steps = 96;
  let volume = 0;

  for (let i = 0; i < steps; i++) {
    const t = (i + 0.5) / steps;
    const section = sampleSection(t, sectionScratch);
    if (section.keelY >= 0) continue;

    // Area of the submerged section, by trapezoids in height.
    const slices = 24;
    const vTop = sectionV(section, 0);
    let area = 0;
    for (let j = 0; j < slices; j++) {
      const v = (vTop * (j + 0.5)) / slices;
      area += sectionHalfWidth(section, v) * 2;
    }
    area *= ((0 - section.keelY) / slices) * (vTop > 0 ? 1 : 0);

    volume += area * (HULL_LENGTH / steps);
  }

  // 1025 kg/m³ is the density of seawater; the hull displaces its own weight.
  return { mass: volume * 1025, volume };
}

/**
 * Buoyancy sampling points, spread over the hull.
 *
 * It is not a regular grid: the columns follow each station's real half width, so a
 * fine bow gets points close together and the wide bilge gets points spread apart.
 * It is what makes the capsizing moment come out right without needing hundreds of
 * samples.
 *
 * Each point's volume adds up to exactly the total displacement, so the ship floats
 * at the design draft by construction.
 */
export function buildBuoyancyPoints(
  lengthSamples = 8,
  widthSamples = 3,
): { x: number; y: number; z: number; volume: number }[] {
  const points: { x: number; y: number; z: number; volume: number }[] = [];
  let totalArea = 0;

  for (let i = 0; i < lengthSamples; i++) {
    const t = (i + 0.5) / lengthSamples;
    const section = sampleSection(t, sectionScratch);
    // The station's keel is the sample's floor; above the waterline there is
    // nothing to sample, and the integrator itself handles the emerged part.
    const bottom = Math.min(section.keelY, 0);
    const halfWidth = sectionHalfWidth(section, sectionV(section, bottom * 0.35));

    for (let j = 0; j < widthSamples; j++) {
      const u = (j + 0.5) / widthSamples;
      const x = (u * 2 - 1) * halfWidth;
      // Each point sits at the hull's height at that X, not at a fixed height:
      // that is what gives the correct lever arm for the heeling moment.
      const v = solveVForHalfWidth(section, Math.abs(x));
      const y = section.keelY + (section.sheerY - section.keelY) * v;

      const area = halfWidth * 2 * (1 / widthSamples);
      totalArea += area;
      points.push({ x, y: Math.min(y, 0.2), z: tToZ(t), volume: area });
    }
  }

  // Normalizes the volumes so they add up to the design displacement.
  const { volume } = computeDisplacement();
  for (const point of points) point.volume = (point.volume / totalArea) * volume;

  return points;
}

/**
 * Inverse of `sectionHalfWidth` by bisection.
 *
 * It only runs when the buoyancy points are built (once, at initialization), so
 * twenty bisection iterations are cheaper in code and in risk than inverting the
 * power by hand with the tumblehome in the middle.
 */
function solveVForHalfWidth(section: HullSection, halfWidth: number): number {
  let low = 0;
  let high = 1;
  for (let i = 0; i < 20; i++) {
    const mid = (low + high) * 0.5;
    if (sectionHalfWidth(section, mid) < halfWidth) low = mid;
    else high = mid;
  }
  return (low + high) * 0.5;
}
