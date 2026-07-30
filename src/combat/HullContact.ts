/**
 * When the two hulls touch: ramming.
 *
 * It exists because the alternative is worse than it looks. Without contact, the ships
 * **go through each other** — and it is not only ugly: the one consequence of getting
 * close, which is risk, disappears. The whole duel would be settled at ten meters, where
 * no carriage can point, and the player would discover that sticking to the enemy is the
 * game's optimal strategy.
 *
 * **It does not use a mesh, for the same reason `HitDetection` does not.** The hull is a
 * function (`ShipDimensions`), so "this point is inside the other ship" is already an
 * exact and cheap comparison. The test here is the simplest one that solves it: rings of
 * points along each ship's planking, tested against the other's volume.
 *
 * **Why a spring-damper and not an impulse.** Resolving a collision by impulse requires
 * the exact instant of contact and redoing the step; with two 37 t bodies floating in
 * water that is already pushing them, the gain is nothing. An elastic penalty
 * proportional to the penetration, with viscous friction, gives the game what it needs:
 * the hulls refuse to occupy the same place, grind against each other and push apart
 * turning. Applied **at the contact point**, it generates the torque on its own —
 * touching bow-on makes the ship pivot, and that is what you expect.
 *
 * ## Two passes, and why not one
 *
 * A penalty contact's force is `k × penetration`, and it has to apply **per contact**,
 * not per probe: how many probes fall inside the other hull is a sampling detail, and
 * the wood does not push ten times harder because the grid got finer there.
 *
 * ⚠️ The previous version applied the force the moment it found it and divided by
 * `SAMPLES_PER_SIDE` — ten, the number of probes on **one side**, not the number of
 * probes that actually touched. A glancing or bow-on encounter puts one or two probes
 * inside the other hull, and in those the ship received one tenth of the projected
 * force. It was exactly the case where you really did hit, and what you saw was a bow
 * entering the other's planking as if it were mist.
 *
 * So everything is gathered first (`gather`) and applied afterwards (`apply`), dividing
 * by the real count. The result is `k × mean penetration`, which is what a contact
 * spring should deliver, and it stopped depending on how many points happened to fall
 * inside.
 *
 * The **direction** belongs to the pair too, and not to the probe: see `chooseExit`, and
 * the perfect cancellation the point-by-point choice produced in a bow-on encounter.
 *
 * What this file promises is written down as a test in `tests/contact.ts` — the four
 * encounters that exist, plus the equal and opposite reaction.
 *
 * ## Where this runs, and why before and not after
 *
 * `Ship.fixedUpdate` integrates at the end of itself, so there is no window between
 * "sum the forces" and "integrate". The solution is to call this step **before** the
 * ships: the forces stay accumulated in `ShipBody` (which only zeroes on `integrate`)
 * and enter the step that is starting. The cost is that the penetration measured is the
 * previous step's — 1.6 cm of lag at 1 m/s of approach, three orders of magnitude below
 * the precision a contact force needs. Trading that for surgery on `Ship` to expose a
 * separate `integrate` would be paying dearly for nothing.
 */

import * as THREE from 'three';
import {
  HALF_LENGTH,
  HULL_BEAM,
  HULL_LENGTH,
  halfWidthAtHeight,
  zToT,
} from '../ship/ShipDimensions';
import { insideHull } from './HitDetection';
import type { Ship } from '../ship/Ship';

/**
 * Probes per side and per height, spread along the planking.
 *
 * The spacing comes out at 1.5 m on a 16 m hull, well under the other ship's 5 m beam:
 * there is no angle of encounter where the two cross without some probe falling inside.
 */
const SAMPLES_PER_SIDE = 10;

/**
 * Heights of the probe rings, in local coordinates.
 *
 * ⚠️ **There used to be one, at the design waterline**, and a flat ring only meets the
 * other hull while the two are roughly in the same plane. Two ships meeting are rolling:
 * one rides the crest while the other drops into the trough, and each heels its own way.
 * At those instants — which are most of them in a half-meter sea — one's waterline ring
 * passed **below** the other's bilge or **above** its bulwark, and the contact simply did
 * not exist: the hulls crossed and went back to repelling each other on the next wave.
 *
 * Three heights cover the whole side from bilge to bulwark: `-0.7` is the hull's belly
 * (where contact happens when one is heeled away), `0.1` is the design waterline (where
 * it happens with both of them quiet) and `0.9` is the dry topsides, just under the
 * covering board (where it happens when one heels *into* the other). It costs 120 probes
 * per step instead of 40, and one probe is a frame conversion plus a section comparison.
 */
const PROBE_HEIGHTS = [-0.7, 0.1, 0.9] as const;

/**
 * Contact stiffness, in newtons per meter of penetration.
 *
 * 6 MN/m. The number comes from the encounter's energy, and not from taste: two 37 t
 * hulls (70 t of effective mass with the water they drag sideways, ~35 t of reduced mass
 * for the pair) closing at 3 m/s carry 157 kJ, and a spring of this stiffness stops them
 * at 23 cm of penetration — the hull *deforms* what the wood would deform, and no more
 * than that. At half the speed it is 12 cm; at a 6 m/s collision, half a meter, and then
 * the separation is as violent as it should be.
 *
 * **It was 1.4 MN/m**, and with `apply`'s wrong division (see the header) a bow contact
 * delivered an effective 140 kN/m — 2% of what is here. Half a meter of bow inside the
 * planking gave back 70 kN against 37 t, meaning 1.9 m/s² to undo an approach of several
 * meters per second. It was not enough.
 *
 * Stability has slack to spare: with 35 t of reduced mass and a 1/60 s step, `ω·dt` sits
 * at 0.2 against the explicit integrator's limit of 2. It could go up tenfold still; what
 * holds the number here is the realism of the crushing, not the arithmetic.
 */
const STIFFNESS = 6e6;

/**
 * Contact damping, in N·s/m.
 *
 * Without it the collision is perfectly elastic and the ships bounce off each other like
 * billiard balls, going back and forth several times. With it the encounter is what you
 * expect from wood against wood: a thud, a creak, and the two separate.
 *
 * 4.5×10⁵ is half the pair's critical damping (`2√(k·m)` gives 9.2×10⁵). Half critical
 * leaves a single short rebound — which is what you see and hear when one hull strikes
 * another — instead of the dead return full damping would give.
 */
const DAMPING = 4.5e5;

/**
 * Tangential friction, as a fraction of the normal force.
 *
 * It is what makes one hull *grind* against the other instead of sliding on ice, and
 * what transfers yaw in a glancing ram.
 */
const FRICTION = 0.35;

/**
 * Maximum penetration that still becomes spring force, in meters.
 *
 * It is not a physics limit, it is a safety net. A host hitch, a dropped frame or a
 * repositioning can hand this step two hulls already overlapping by two meters; without
 * the clamp, the spring would give back 12 MN and the sloop would leave there at 3 m/s
 * all at once, which on screen reads as a catapult and not as a collision. With the
 * clamp, it is pushed out with conviction and over several steps, which is how a hull
 * grounded on another really comes off.
 */
const MAX_PUSH_DEPTH = 1;

// --- resolution --------------------------------------------------------------

/** What the contact step found, for the audio, the damage and the HUD to read. */
export interface ContactReport {
  /** Points in contact on this step. Zero is "they are not touching". */
  contacts: number;
  /** Largest penetration found, in meters. */
  depth: number;
  /**
   * Highest closing speed among the points in contact, in m/s.
   *
   * It is what separates a graze from an impact — the audio and the ramming damage read
   * from here. It is the **highest** and not the deepest contact's, and the difference
   * shows up exactly at the instant that matters: on an impact's first step every point's
   * penetration is still millimetric, and what is already enormous is the speed they are
   * closing at.
   */
  closingSpeed: number;
  /** World point of the strongest contact, for the sound and the breach. */
  readonly point: THREE.Vector3;
}

export function createContactReport(): ContactReport {
  return { contacts: 0, depth: 0, closingSpeed: 0, point: new THREE.Vector3() };
}

/**
 * A probe that fell inside the other hull, already measured.
 *
 * It exists because the force can only be computed after knowing **how many** contacts
 * there are — see the header. It keeps what the second pass needs and nothing more.
 */
interface Penetration {
  /** `true` when the probe belongs to the first hull and the volume to the second. */
  fromA: boolean;
  /** World point where the force will be applied to both bodies. */
  readonly point: THREE.Vector3;
  /** Exit normal, in the world. The same for the whole pair — see `chooseExit`. */
  readonly normal: THREE.Vector3;
  /** Relative velocity of the two material points meeting there. */
  readonly relative: THREE.Vector3;
  depth: number;
  /** Component of the relative velocity against the normal. Negative is separating. */
  approach: number;
}

/**
 * The notebook of penetrating probes, built once.
 *
 * Two passes (each hull probing the other) × two sides × probes × heights. Allocated at
 * module load because this runs sixty times a second: 120 objects with three vectors each
 * per step would be garbage for the collector to sweep inside the frame's budget.
 */
const PENETRATIONS: Penetration[] = Array.from(
  { length: 4 * SAMPLES_PER_SIDE * PROBE_HEIGHTS.length },
  () => ({
    fromA: true,
    point: new THREE.Vector3(),
    normal: new THREE.Vector3(),
    relative: new THREE.Vector3(),
    depth: 0,
    approach: 0,
  }),
);

const _originA = new THREE.Vector3();
const _originB = new THREE.Vector3();
const _probeLocal = new THREE.Vector3();
const _probeWorld = new THREE.Vector3();
const _solidLocal = new THREE.Vector3();
const _arm = new THREE.Vector3();
const _velocityProbe = new THREE.Vector3();
const _velocitySolid = new THREE.Vector3();
const _tangent = new THREE.Vector3();
const _force = new THREE.Vector3();
const LOCAL_OUT = new THREE.Vector3();
const _solidOrigin = new THREE.Vector3();
const _probeOrigin = new THREE.Vector3();
const _bearing = new THREE.Vector3();
const _exitNormal = new THREE.Vector3();

/** The exit chosen for the pair in progress. See `chooseExit`. */
let _lateralExit = true;
let _exitSign = 1;

/**
 * Resolves the contact between two hulls. Call it **before** their `fixedUpdate`s — see
 * the note at the top of the file.
 */
export function resolveHullContact(a: Ship, b: Ship, out: ContactReport): ContactReport {
  out.contacts = 0;
  out.depth = 0;
  out.closingSpeed = 0;

  // Distance rejection: two 16 m hulls do not touch with their origins more than a
  // whole length apart.
  a.body.getOrigin(_originA);
  b.body.getOrigin(_originB);
  const reach = HALF_LENGTH * 2 + 1;
  if (_originA.distanceToSquared(_originB) > reach * reach) return out;

  // Both directions go into the **same** count: it is one contact, seen from two
  // sides. Normalizing each direction on its own would give double force in an
  // encounter where the two rings reach each other.
  let count = gather(a, b, true, 0);
  count = gather(b, a, false, count);
  if (count === 0) return out;

  apply(a, b, count, out);
  return out;
}

/**
 * Notes down `probe`'s probes that fell inside `solid`'s volume.
 *
 * @param start where to carry on writing in the notebook.
 * @returns the notebook's new end.
 */
function gather(probe: Ship, solid: Ship, fromA: boolean, start: number): number {
  let count = start;
  chooseExit(probe, solid);

  for (const height of PROBE_HEIGHTS) {
    for (const side of [-1, 1]) {
      for (let i = 0; i < SAMPLES_PER_SIDE; i++) {
        // ⚠️ **End to end, and it used to be only the central 94% sampled at the
        // middle of each band.** With ten samples at the middle of each band, the
        // foremost probe fell 1.23 m short of the stem — and a bow only found the
        // other hull after going **two and a half meters** into it, which is the
        // moment the probe finally reaches a section of the other ship fuller than its
        // own. It was exactly the "one boat goes inside the other" complaint, and it
        // was not about the force: it was about there being nothing to measure.
        //
        // Sampling the ends, the foremost probe sits 8 cm from the cutwater and bow
        // contact starts at about 16 cm of overlap. Reaching the exact tip is safe
        // because of the half-breadth rejection just below.
        const t = SAMPLES_PER_SIDE > 1 ? i / (SAMPLES_PER_SIDE - 1) : 0.5;
        const z = (t * 2 - 1) * HALF_LENGTH * 0.99;
        const half = halfWidthAtHeight(zToT(z), height);
        // That height has no planking at this station: near the ends the keel rises,
        // and the lower ring passes outside the hull. Probing from there would measure
        // the penetration of a point that is not part of the ship.
        if (half <= 1e-3) continue;

        _probeLocal.set(side * half, height, z);
        probe.body.localToWorld(_probeLocal, _probeWorld);
        solid.body.worldToLocal(_probeWorld, _solidLocal);
        if (!insideHull(_solidLocal)) continue;

        // Notebook full: only in a whole-side encounter, and there the missing probes
        // describe the same contact as the 120 already noted.
        if (count >= PENETRATIONS.length) return count;
        if (measure(probe, solid, fromA, PENETRATIONS[count]!)) count++;
      }
    }
  }

  return count;
}

/**
 * Chooses which way `solid`'s hull will expel `probe`'s, **once for the pair**, and not
 * once per probe.
 *
 * ## Why the decision belongs to the pair
 *
 * A penalty contact's exit is toward the nearest face, and the first version chose it
 * point by point: each probe compared the distance to the side with the distance to the
 * end and went by the smaller. It is right for an isolated point, and it is catastrophic
 * for a hull.
 *
 * ⚠️ **Two bows head-on canceled the entire force.** The stem is symmetric, so the port
 * and starboard probes enter the other hull mirrored: one ends up closer to its port
 * side, the other to its starboard, and the two push in opposite directions with the
 * same magnitude. It sums to zero — measured: eight contacts, 36 cm of penetration and
 * **0.0 m/s² of push**. The two sloops went through each other with the contact step
 * running and finding contact.
 *
 * The exit is not point geometry, it is pair geometry: **the hull pushes away from where
 * the other one is coming from**. The relative bearing of the two centers says that, it
 * is the same for every probe (so nothing cancels) and it changes slowly (so nothing
 * oscillates). Compared in coordinates normalized by the hull's dimensions, it separates
 * the three encounters that exist:
 *
 * | the other one is | the exit is | and it is right because |
 * |---|---|---|
 * | abeam | through the side | it is the side being crushed |
 * | ahead or astern | through the end | it is the cutwater or the transom |
 * | on the quarter, mixed | through the side | it is what the beam's bulwark resolves |
 *
 * The sign comes from the bearing too, and not from the point: a probe that has passed
 * the middle of the other hull has to leave by the side it **entered** through, and not
 * by the one nearest it now.
 *
 * Neither exit is vertical, on purpose: including the bilge's vertical component would
 * turn a side contact into an upward push, and what you would see is one ship climbing
 * the other.
 */
function chooseExit(probe: Ship, solid: Ship): void {
  solid.body.getOrigin(_solidOrigin);
  probe.body.getOrigin(_probeOrigin);
  _bearing.subVectors(_probeOrigin, _solidOrigin);
  solid.body.worldDirToLocal(_bearing, _bearing);

  // Normalized by the dimensions: 3 m abeam on a hull with a 5 m beam is far more "off
  // to the side" than 3 m ahead on a hull 16 m long.
  _lateralExit = Math.abs(_bearing.x) / HULL_BEAM >= Math.abs(_bearing.z) / HULL_LENGTH;
  _exitSign = (_lateralExit ? _bearing.x : _bearing.z) >= 0 ? 1 : -1;

  LOCAL_OUT.set(_lateralExit ? _exitSign : 0, 0, _lateralExit ? 0 : _exitSign);
  solid.body.localDirToWorld(LOCAL_OUT, _exitNormal);
}

/**
 * Measures the probe already placed in `_probeWorld` / `_solidLocal`, along the exit
 * `chooseExit` decided for this pair.
 *
 * The depth is how far you still have to travel in that direction to leave the hull:
 * `half breadth − s·x` through the side, `half length − s·z` through the end. Written
 * with the sign instead of the absolute value, it stays correct for a probe that has
 * already passed the middle of the other hull — there the exit is long, and it really is
 * long.
 *
 * @returns `false` when the arithmetic yields no penetration (a numerical edge case).
 */
function measure(probe: Ship, solid: Ship, fromA: boolean, into: Penetration): boolean {
  const depth = _lateralExit
    ? halfWidthAtHeight(zToT(_solidLocal.z), _solidLocal.y) - _exitSign * _solidLocal.x
    : HALF_LENGTH - _exitSign * _solidLocal.z;
  if (depth <= 0) return false;

  into.depth = depth;
  into.normal.copy(_exitNormal);

  _arm.subVectors(_probeWorld, probe.body.comPosition);
  probe.body.pointVelocity(_arm, _velocityProbe);
  _arm.subVectors(_probeWorld, solid.body.comPosition);
  solid.body.pointVelocity(_arm, _velocitySolid);
  into.relative.subVectors(_velocityProbe, _velocitySolid);

  into.approach = -into.relative.dot(into.normal);
  into.point.copy(_probeWorld);
  into.fromA = fromA;
  return true;
}

/** Applies the noted probes, divided by the real count. See the header. */
function apply(a: Ship, b: Ship, count: number, out: ContactReport): void {
  // The strongest contact rules the report. `-Infinity` guarantees the first one always
  // writes the point, even in a creak where nobody is closing.
  let hardest = Number.NEGATIVE_INFINITY;

  for (let i = 0; i < count; i++) {
    const contact = PENETRATIONS[i]!;
    const probe = contact.fromA ? a : b;
    const solid = contact.fromA ? b : a;

    // A spring on the penetration, plus a damper on the approach. The damper only acts
    // while the two are pressing together: holding them once they are already separating
    // would be wood that sticks, and the contact would become a magnet.
    let magnitude = STIFFNESS * Math.min(contact.depth, MAX_PUSH_DEPTH);
    if (contact.approach > 0) magnitude += DAMPING * contact.approach;
    magnitude /= count;
    if (magnitude <= 0) continue;

    _force.copy(contact.normal).multiplyScalar(magnitude);

    // Coulomb friction: it opposes the tangential slip, limited by the normal.
    _tangent
      .copy(contact.relative)
      .addScaledVector(contact.normal, -contact.relative.dot(contact.normal));
    const slide = _tangent.length();
    if (slide > 1e-3) {
      _tangent.multiplyScalar(
        -Math.min(FRICTION * magnitude, (DAMPING / count) * slide) / slide,
      );
      _force.add(_tangent);
    }

    probe.body.applyForceAtPoint(_force, contact.point);
    // The third law: the solid takes the reciprocal, at the same point.
    solid.body.applyForceAtPoint(_force.negate(), contact.point);

    out.contacts++;
    if (contact.depth > out.depth) out.depth = contact.depth;
    if (contact.approach > hardest) {
      hardest = contact.approach;
      out.closingSpeed = Math.max(contact.approach, 0);
      out.point.copy(contact.point);
    }
  }
}
