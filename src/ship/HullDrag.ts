/**
 * The hull's resistance in the water.
 *
 * Three terms, each with a job:
 *
 * - **Surge** (local Z axis): a single force, at the center of buoyancy. It is what sets
 *   the ship's top speed, since at steady state the sail's thrust equals this drag.
 * - **Sway** (local X axis): distributed over several stations along the keel, and this
 *   is where the trick is. A hull that yaws has, at each station, a different lateral
 *   velocity (ω × r), so the sum of the lateral drags generates **yaw damping** on its
 *   own. Without it we would have to invent a rotation coefficient, and the turning
 *   radius would stop responding to speed.
 * - **Skin friction**: linear, small, and it exists so the ship stops instead of gliding
 *   forever once the quadratic drag is already negligible.
 *
 * Everything scales with the submerged fraction: a half-sunk ship drags more, a ship
 * leaping out of the swell drags less.
 */

import * as THREE from 'three';
import { WATER_DENSITY } from '../core/MathUtils';
import { HULL_LENGTH, sampleSection, tToZ, type HullSection } from './ShipDimensions';
import type { ShipBody } from './ShipBody';

/**
 * Surge drag coefficient, over the midship section's area (3.7 m²).
 *
 * High for a hull (a fine hull sits near 0.1), and on purpose: it carries the
 * wave-making resistance along with it, which on a 16 m displacement hull takes off near
 * hull speed. It is **this** term that has to set the top speed, and at 0.38 it sets it
 * at ~5 m/s (9.7 knots) with the sail full — checked on the physics bench, not
 * estimated.
 */
const SURGE_CD = 0.38;
/** Submerged midship section area, in m². Measured from the hull itself. */
const MIDSHIP_AREA = 3.7;

/** Lateral drag, over the sway plane. A hull side-on is a plate. */
const SWAY_CD = 1.15;

/** Stations where the lateral drag is applied. Odd so one lands amidships. */
const LATERAL_STATIONS = 9;

/**
 * Linear viscous friction, in 1/s over the mass.
 *
 * ⚠️ This number is deceptive. Being **linear**, it is not a small term that only shows
 * up at the end: it is `0.012 × 36,905 = 443 N·s/m`, and it competes with the quadratic
 * across the whole range. The first calibration used 0.22 and the result was 20 kN of
 * drag at 2.5 m/s — 82% of the ship's entire resistance, which locked the Sloop at 4.8
 * knots and turned the `SURGE_CD` above into decoration.
 *
 * Its job is one thing only: giving a finite time constant (~83 s) for the ship to reach
 * zero instead of gliding forever once the quadratic no longer holds anything. Any value
 * that makes it weigh at cruising speed is wrong.
 */
const SKIN_FRICTION = 0.012;

/**
 * Residual angular damping, in 1/s.
 *
 * It exists for the **roll** (X and Z), which the underwater body barely damps because
 * it is nearly circular at the bilge. The yaw term (Y) is small on purpose: the lateral
 * stations above already damp yaw for real, and the old value (0.35) added another
 * 15 kN·m to that sum — half of all the resistance to turning came from an invented
 * number, not from the water.
 */
const ROLL_DAMPING = new THREE.Vector3(0.9, 0.08, 1.4);

/**
 * Fraction of the theoretical Munk moment applied to the hull.
 *
 * **What it is.** An elongated body in a fluid carries more added mass sideways than
 * bow-on (here, 1.9 against 1.06). When it advances with sideslip, the fluid's momentum
 * stops being parallel to the velocity, and the difference becomes a couple that **opens
 * the sideslip even further**. It is the `(m₂₂ − m₁₁)·u·v` term of Kirchhoff's
 * equations, and it is in every serious maneuvering model (MMG, Abkowitz) precisely
 * because without it the ship becomes a rail.
 *
 * That is what was missing here, and how much shows by measuring with it switched off:
 * the 360° turn drops from **98 s and 113 m of diameter** to **63 s and 70 m**. Without
 * the Munk moment the rudder opens the turn, the hull resists and nothing pushes the yaw
 * along.
 *
 * **Why 0.25 and not the theoretical value.** The 1.0 comes from potential flow, with no
 * separation; on a real hull the detached wake eats a good part of it. The useful
 * ceiling here is harsher than the literature's, and it comes from the bench: with the
 * ship at 5 m/s and the sideslip imposed, you measure on one side the Munk moment plus
 * the lateral stations (both of which open the sideslip) and on the other the rudder
 * amidships (which closes it, see `Rudder`).
 *
 * ```
 * sideslip   rudder    stations   Munk (at 0.25)   maximum factor
 *      5°   −22,689      +2,206         +16,822             0.30
 *     10°   −45,206      +8,755         +33,134             0.27
 *     20°   −89,038     +33,965         +62,271             0.22
 * ```
 *
 * The limit **falls** with the angle because the hull grows faster than the rudder, and
 * that is not a defect: it is the loss of directional stability at large sideslip, which
 * is exactly what makes a ship "dig into" the turn instead of sliding out of it. At 0.25
 * the ship holds its heading up to about 13° of sideslip and delivers a 360° turn in
 * 63 s with 70 m of diameter; sailing free the sideslip sits at 0.3°, slack to spare.
 *
 * ⚠️ These numbers hold for the rudder with the right sign. The first version of this
 * table was taken with `alpha = rudderAngle − inflow`, and in it the rudder *added* to
 * the instability instead of restoring — the ship sailed with 25 to 30° of permanent
 * crab and the turn took 143 s. If anybody ever touches `Rudder`, remeasure this before
 * touching here.
 */
const MUNK_FACTOR = 0.25;

const _localVelocity = new THREE.Vector3();
const _worldPoint = new THREE.Vector3();
const _worldArm = new THREE.Vector3();
const _pointVelocity = new THREE.Vector3();
const _localPointVelocity = new THREE.Vector3();
const _force = new THREE.Vector3();
const _local = new THREE.Vector3();
const _torque = new THREE.Vector3();

export class HullDrag {
  /** Local Z of each lateral drag station. */
  private readonly stationZ: number[] = [];
  /** Submerged lateral area assigned to each station, in m². */
  private readonly stationArea: number[] = [];
  /** Mean depth of application: half the local draft. */
  private readonly stationY: number[] = [];

  constructor() {
    const section: HullSection = { halfBeam: 0, keelY: 0, sheerY: 0, fullness: 1 };
    const dz = HULL_LENGTH / LATERAL_STATIONS;

    for (let i = 0; i < LATERAL_STATIONS; i++) {
      const t = (i + 0.5) / LATERAL_STATIONS;
      sampleSection(t, section);
      const draft = Math.max(-section.keelY, 0);
      this.stationZ.push(tToZ(t));
      this.stationArea.push(draft * dz);
      // Half the draft is a rectangular plate's center of pressure; using the
      // waterline instead would give zero lever arm and the ship would not heel when
      // skidding through a turn.
      this.stationY.push(-draft * 0.5);
    }
  }

  /**
   * @param submersion fraction of the design volume submerged (from `Buoyancy`).
   */
  apply(body: ShipBody, submersion: number): void {
    const wetted = Math.min(submersion, 1.4);
    if (wetted <= 0.01) return;

    // --- surge, at the center of buoyancy ------------------------------------
    body.worldDirToLocal(body.velocity, _localVelocity);
    const surge = _localVelocity.z;
    const surgeDrag = -0.5 * WATER_DENSITY * SURGE_CD * MIDSHIP_AREA * wetted * Math.abs(surge) * surge;

    _force.set(0, 0, surgeDrag);
    body.localDirToWorld(_force, _force);
    body.applyForce(_force);

    // --- linear friction ------------------------------------------------------
    _force.copy(body.velocity).multiplyScalar(-SKIN_FRICTION * body.mass * wetted);
    body.applyForce(_force);

    // --- sway, station by station --------------------------------------------
    for (let i = 0; i < this.stationZ.length; i++) {
      _local.set(0, this.stationY[i]!, this.stationZ[i]!);
      body.localToWorld(_local, _worldPoint);
      _worldArm.subVectors(_worldPoint, body.comPosition);
      body.pointVelocity(_worldArm, _pointVelocity);
      body.worldDirToLocal(_pointVelocity, _localPointVelocity);

      const lateral = _localPointVelocity.x;
      const drag = -0.5 * WATER_DENSITY * SWAY_CD * this.stationArea[i]! * wetted * Math.abs(lateral) * lateral;

      _force.set(drag, 0, 0);
      body.localDirToWorld(_force, _force);
      body.applyForceAtPoint(_force, _worldPoint);
    }

    // --- Munk moment ----------------------------------------------------------
    // Signs: `u` is surge (the bow is -Z, so moving ahead means having negative z) and
    // `v` is sway to starboard. Yawing to port is +Y here, and the Munk couple pushes
    // the bow **out of** the sideslip — hence the negative sign.
    const munk =
      -MUNK_FACTOR *
      body.mass *
      (body.addedMass.x - body.addedMass.z) *
      _localVelocity.z *
      _localVelocity.x *
      wetted;

    _torque.set(0, munk, 0);
    body.localDirToWorld(_torque, _torque);
    body.applyTorque(_torque);

    // --- residual angular damping --------------------------------------------
    body.worldDirToLocal(body.angularVelocity, _torque);
    _torque.set(
      -_torque.x * ROLL_DAMPING.x * body.inertia.x * wetted,
      -_torque.y * ROLL_DAMPING.y * body.inertia.y * wetted,
      -_torque.z * ROLL_DAMPING.z * body.inertia.z * wetted,
    );
    body.localDirToWorld(_torque, _torque);
    body.applyTorque(_torque);
  }
}
