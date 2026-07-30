/**
 * Where the ball lands: a segment test against the hull and against the mast.
 *
 * **It does not use the mesh.** The visual hull has tens of thousands of triangles and a
 * BVH over it would cost more memory and more code than the real solution, which is
 * already there: the hull *is* a function. `ShipDimensions` can give the half width at
 * any (station, height), so "this point is inside the hull" is a comparison, and finding
 * where the segment entered is a bisection. It costs almost nothing and is exact to the
 * millimeter — and, what matters more, it is the **same** description that generated the
 * mesh, so the shot never hits the air beside a plank.
 *
 * The test runs in the ship's local coordinates. That solves for free the problem of the
 * target rolling on the waves: there is no intersection with a moving body to resolve,
 * the ship is always still in its own frame.
 *
 * The march is coarse (20 cm) because the hull is a **volume** 5 m in beam, and not a
 * thin shell: any shot that enters it stays inside for several steps. The only case that
 * escapes is the tangential graze along the bulwark, which should not count as a hit
 * anyway.
 */

import * as THREE from 'three';
import { clamp01 } from '../core/MathUtils';
import type { ShipBody } from '../ship/ShipBody';
import {
  DECK_Y,
  HALF_LENGTH,
  sampleSection,
  sectionHalfWidth,
  sectionV,
  hullSurfaceNormal,
  zToT,
  type HullSection,
} from '../ship/ShipDimensions';
import { MAST_BASE_Y, MAST_TOP_Y, MAST_Z, mastRadius } from '../ship/ShipParts';

/** Step of the march while looking for the entry, in meters. */
const MARCH_STEP = 0.2;
/** Bisection rounds after finding the step that entered (~0.8 mm). */
const REFINE_STEPS = 8;

/** The hull's maximum half breadth, for the quick rejection. */
const HULL_HALF_BEAM = 2.6;
/** Bottom of the keel, for the same rejection. The ceiling is the masthead. */
const HULL_BOTTOM = -1.7;

export type HitPart = 'hull' | 'mast';

export interface ShipHit {
  /** Where on the segment it landed, 0..1 — the projectile stops exactly here. */
  fraction: number;
  /** Point of impact, in the ship's local coordinates. */
  readonly local: THREE.Vector3;
  /** Outward normal of the surface there, also local. */
  readonly normal: THREE.Vector3;
  part: HitPart;
  /**
   * `true` when the breach ends up **below the deck**, where the water comes in.
   *
   * It is the line that separates a shot that sinks the ship from a shot that only tears
   * splinters off the bulwark — and it is the same rule as Sea of Thieves, where only
   * what gets into the hold floods.
   */
  floods: boolean;
}

const _localFrom = new THREE.Vector3();
const _localTo = new THREE.Vector3();
const _probe = new THREE.Vector3();
const _section: HullSection = { halfBeam: 0, keelY: 0, sheerY: 0, fullness: 1 };

/** True when the local point is inside the hull's volume. */
export function insideHull(local: THREE.Vector3): boolean {
  if (Math.abs(local.z) > HALF_LENGTH) return false;
  sampleSection(zToT(local.z), _section);
  if (local.y <= _section.keelY || local.y >= _section.sheerY) return false;
  return Math.abs(local.x) < sectionHalfWidth(_section, sectionV(_section, local.y));
}

/**
 * Tests a world segment against a ship.
 *
 * @param out filled only when it returns `true`; the caller owns it.
 * @returns `true` if the segment touches the ship.
 */
export function raycastShip(
  body: ShipBody,
  worldFrom: THREE.Vector3,
  worldTo: THREE.Vector3,
  out: ShipHit,
): boolean {
  body.worldToLocal(worldFrom, _localFrom);
  body.worldToLocal(worldTo, _localTo);

  // Quick rejection by the whole ship's bounding box (hull + mast).
  if (!segmentTouchesBox(_localFrom, _localTo)) return false;

  const hull = marchHull(out);
  const mast = marchMast(hull ? out.fraction : 1);

  // The mast overwrites only if it is closer — `marchMast` already received the hull's
  // fraction as a ceiling, so when it returns something it is because it won.
  if (mast >= 0) {
    out.fraction = mast;
    out.local.copy(_mastPoint);
    out.normal.copy(_mastNormal);
    out.part = 'mast';
    out.floods = false;
    return true;
  }

  return hull;
}

/**
 * A loose bounding box in local coordinates, tested by slabs.
 *
 * Loose on purpose: it exists to reject the 99% of balls that pass far away, not to be
 * tight. A tight box would cost more to build than it saves.
 */
function segmentTouchesBox(from: THREE.Vector3, to: THREE.Vector3): boolean {
  return (
    slabOverlap(from.x, to.x, -HULL_HALF_BEAM, HULL_HALF_BEAM) &&
    slabOverlap(from.y, to.y, HULL_BOTTOM, MAST_TOP_Y) &&
    slabOverlap(from.z, to.z, -HALF_LENGTH, HALF_LENGTH)
  );
}

function slabOverlap(a: number, b: number, min: number, max: number): boolean {
  return Math.min(a, b) <= max && Math.max(a, b) >= min;
}

/** Finds the entry into the hull by marching and then refining. */
function marchHull(out: ShipHit): boolean {
  const length = _probe.subVectors(_localTo, _localFrom).length();
  if (length < 1e-6) return false;

  const steps = Math.max(Math.ceil(length / MARCH_STEP), 1);

  for (let i = 1; i <= steps; i++) {
    const s = i / steps;
    _probe.lerpVectors(_localFrom, _localTo, s);
    if (!insideHull(_probe)) continue;

    // Found the step that entered; the surface is between it and the previous one.
    let low = (i - 1) / steps;
    let high = s;
    for (let k = 0; k < REFINE_STEPS; k++) {
      const mid = (low + high) * 0.5;
      _probe.lerpVectors(_localFrom, _localTo, mid);
      if (insideHull(_probe)) high = mid;
      else low = mid;
    }

    out.fraction = high;
    out.local.lerpVectors(_localFrom, _localTo, high);
    hullNormalAt(out.local, out.normal);
    out.part = 'hull';
    out.floods = out.local.y < DECK_Y;
    return true;
  }

  return false;
}

/**
 * Outward hull normal at the point of impact.
 *
 * `hullSurfaceNormal` wants (t, v, side), so the point is converted back into the
 * surface's parameters. It comes out slightly off when the impact is shallow on the
 * bulwark — `v` there goes past 1 and is clamped — and it makes no difference: the
 * normal only orients the breach decal and the splinters' direction.
 */
function hullNormalAt(local: THREE.Vector3, target: THREE.Vector3): THREE.Vector3 {
  const t = zToT(local.z);
  sampleSection(t, _section);
  const v = clamp01(sectionV(_section, local.y));
  return hullSurfaceNormal(t, v, local.x >= 0 ? 1 : -1, target);
}

const _mastFrom = new THREE.Vector2();
const _mastDir = new THREE.Vector2();
// The mast's result lives in scratch of its own: writing straight into `out` would
// ruin the hull hit already found when the mast's test fails.
const _mastPoint = new THREE.Vector3();
const _mastNormal = new THREE.Vector3();

/**
 * The segment against the mast, treated as a straight cylinder of mean radius.
 *
 * The mast is conical (24 cm at the base, 11 cm at the top), but solving a cone is a
 * quadratic with varying coefficients to gain 6 cm of precision on a part the ball
 * destroys either way. A cylinder of mean radius, with the radius read at the impact's
 * height for the final check.
 *
 * @param ceiling the fraction beyond which it does not matter — the hull already won.
 * @returns the impact's fraction, or −1 when it does not hit.
 */
function marchMast(ceiling: number): number {
  _mastFrom.set(_localFrom.x, _localFrom.z - MAST_Z);
  _mastDir.set(_localTo.x - _localFrom.x, _localTo.z - _localFrom.z);

  const a = _mastDir.lengthSq();
  if (a < 1e-9) return -1;

  const radius = mastRadius((MAST_BASE_Y + MAST_TOP_Y) * 0.5);
  const b = 2 * _mastFrom.dot(_mastDir);
  const c = _mastFrom.lengthSq() - radius * radius;

  const discriminant = b * b - 4 * a * c;
  if (discriminant < 0) return -1;

  const fraction = (-b - Math.sqrt(discriminant)) / (2 * a);
  if (fraction < 0 || fraction >= ceiling) return -1;

  _mastPoint.lerpVectors(_localFrom, _localTo, fraction);
  if (_mastPoint.y < MAST_BASE_Y || _mastPoint.y > MAST_TOP_Y) return -1;
  // Checks against the real radius at that height: near the top the mean cylinder is
  // too fat and would accept a shot that only grazed past.
  if (Math.hypot(_mastPoint.x, _mastPoint.z - MAST_Z) > mastRadius(_mastPoint.y) + 0.02) return -1;

  _mastNormal.set(_mastPoint.x, 0, _mastPoint.z - MAST_Z).normalize();
  return fraction;
}
