/**
 * The sail: the cloth that moves and the force that drives the ship.
 *
 * Two separate problems, solved separately on purpose.
 *
 * **The cloth** is a Verlet fabric on a 13 × 11 grid, running in the ship's frame
 * (the mesh is a child of the hull, so the positions are already in that system).
 * Not feeling the ship's acceleration is the right call here: a hoisted, full sail
 * doesn't flap because the hull rode up a swell, it flaps because the wind changed.
 *
 * **The force** is analytical, not the sum of the pressure over the fabric's
 * quads. Summing from the fabric sounds purer, but in practice the thrust would
 * start oscillating at the solver's frequency and the ship's top speed would
 * depend on the mesh resolution — the player would feel the ship "shuddering"
 * with no visible cause. Here the cloth is the visual read on the wind and the
 * force is the model; both read exactly the same wind vector, so they never
 * disagree about what is happening.
 *
 * ## How the speed curve was calibrated
 *
 * The Sloop is the **slowest** downwind and on the beam, and the **least slow**
 * bow to the wind — which is why running upwind is the manual for a chased sloop
 * ([Sea of Thieves forums and guides](https://www.sportskeeda.com/mmo/sea-thieves-ship-speeds-explained)).
 * Downwind is still her fastest heading; what she does better than brigantine and
 * galleon is *lose little* against the wind.
 *
 * With the default wind (15.1 m/s) and `HullDrag`'s drag, equilibrium gives:
 * **downwind 5.3 m/s (10.2 knots) · beam 4.9 · bow 3.4 (65% of top speed)**.
 */

import * as THREE from 'three';
import { AIR_DENSITY, clamp01 } from '../core/MathUtils';
import { measureWindageProfile } from './ShipDimensions';
import { SAIL_FRAME, mastClearance, sailRestPoint, sailVertexIndex } from './ShipParts';
import type { ShipBody } from './ShipBody';
import type { WaveField } from '../world/WaveField';

// --- wind --------------------------------------------------------------------

/** Wind speed with `windStrength = 0`, in m/s. */
const WIND_BASE_SPEED = 6;
/** How much `windStrength = 1` adds, in m/s. */
const WIND_SPEED_RANGE = 14;

/**
 * True wind in world space, in m/s, from the sea state.
 *
 * `WaveField` stores the wind as a direction plus a strength from 0 to 1, which
 * is what the wave spectrum needs. Whatever makes force needs meters per second,
 * and the conversion lives here so that it exists in exactly one place.
 */
export function getTrueWind(waves: WaveField, target: THREE.Vector3): THREE.Vector3 {
  const speed = WIND_BASE_SPEED + clamp01(waves.windStrength) * WIND_SPEED_RANGE;
  return target
    .set(Math.cos(waves.windDirection), 0, Math.sin(waves.windDirection))
    .multiplyScalar(speed);
}

/**
 * Heading that puts the wind dead astern — the Sloop's fastest.
 *
 * `windDirection` is the angle the wind blows **toward**, with the vector
 * `(cos wd, 0, sin wd)`. Wind astern is the bow pointing the same way as the
 * wind; since the bow is local −Z, the heading that satisfies it is
 * `atan2(−cos, −sin)`.
 *
 * It lives here and not in the AI because it is knowledge about the wind — and
 * because the test bench in `main.ts` needs exactly the same number. Two copies
 * of that math is one copy too many.
 */
export function downwindHeading(waves: WaveField): number {
  return Math.atan2(-Math.cos(waves.windDirection), -Math.sin(waves.windDirection));
}

/**
 * Sail efficiency on a heading, without simulating anything.
 *
 * Same curve as `applyThrust`, rewritten as a function of heading: the alignment
 * between bow and wind is the cosine of the deviation from the downwind heading.
 * It serves the bot helmsman choosing between two courses that suit the tactic,
 * and the HUD drawing the wind rose.
 *
 * Uses the **true** wind, not the apparent: the apparent-wind correction depends
 * on the speed the ship does not have yet on the heading being evaluated, and
 * including it would mean solving the whole equilibrium to answer "is this tack
 * any good?".
 *
 * @returns from `MIN_EFFICIENCY` (wind on the bow) to 1 (wind astern).
 */
export function efficiencyAtHeading(heading: number, waves: WaveField): number {
  const alignment = Math.cos(heading - downwindHeading(waves));
  return MIN_EFFICIENCY + (1 - MIN_EFFICIENCY) * (1 + alignment) * 0.5;
}

// --- propulsion --------------------------------------------------------------

/**
 * Effective rig area, in m².
 *
 * Far larger than the ~36 m² of canvas actually drawn, and openly so: Sea of
 * Thieves styles the sloop's sail small, yet moves a 37-tonne hull at more than
 * 10 knots, which that cloth would not do in any wind. Between faking the area
 * and faking the drag coefficient, faking the area is the lesser evil — 124 m²
 * is what a 16 m cutter really carries, so all the rest of the math stays real
 * physics on top of a plausible number.
 */
const RIG_AREA = 124;
/** Drag of a full square sail. A porous, curved plate lands near 1.6. */
const SAIL_CD = 1.62;

/**
 * How much of the ship's own speed the sail feels as wind subtracted.
 *
 * With pure apparent wind (1.0) the sail would be a brake: downwind the thrust
 * would fall along with the speed and the ship would bog down at ~4.4 m/s, with
 * only 12% difference between sailing downwind and into the wind — far too flat
 * to give the player any read on heading. The partial value stands in for what a
 * pure drag model cannot produce: a square sail also generates lift, and it is
 * lift that makes a square-rigged vessel sail well above what drag alone would
 * explain.
 */
const APPARENT_RELIEF = 0.45;

/**
 * Minimum efficiency, with the wind in your face.
 *
 * Not zero because the wind never sits exactly on the bow and because the sloop
 * has to keep steering close-hauled — this number is what sets the 65% upwind
 * speed that characterizes the boat.
 */
const MIN_EFFICIENCY = 0.25;

/** Center of effort of the sail, in local coordinates. */
const SAIL_CENTER = new THREE.Vector3(0, (SAIL_FRAME.topY + SAIL_FRAME.bottomY) * 0.5, SAIL_FRAME.z);

/**
 * Area and drag of everything that is not sail: topsides, mast, rigging and the
 * tangential component of the cloth itself.
 *
 * It exists because the sail is fixed and its force is purely longitudinal —
 * without this term the wind would give **no** heel and no leeway at all, and the
 * ship would move as if it were on rails. It is small on purpose: its job is to
 * heel and to drift, not to propel.
 *
 * 7 m² is what is left of frontal area above water on a 5 m beam hull with 1.5 m
 * of freeboard, plus mast and rigging. Measured: yields ~830 N at 15 m/s, a tenth
 * of the sail's thrust — the right proportion for a correction term. It was once
 * 26 m², and then the ship made 3 knots under furled sail, which is absurd.
 */
const WINDAGE_AREA = 7;
const WINDAGE_CD = 0.85;

/**
 * Side area of mast, yard and rigging, in m². It only serves as a weight in the
 * average that decides the center of effort below — the magnitude of the force
 * comes from `WINDAGE_AREA`.
 *
 * A 12.7 m mast tapering from 0.48 to 0.22 m in diameter gives ~4.4 m²; yard,
 * ratlines and stays add the other ~2.
 */
const RIG_SIDE_AREA = 6.4;
/**
 * Height of the center of that area. The mast is thicker at the foot, so its
 * centroid sits below the middle of the 12.7 m; the yard at 9 m pulls it back up.
 */
const RIG_CENTER_Y = 6.6;

/**
 * Center of the wind's effort on everything that sits above water.
 *
 * **The `z` here is what matters**, and it is the only number in the wind force
 * that generates yaw: the longitudinal share, applied on the centerline, only
 * gives pitch. It used to be pinned to the mast, and the mast sits 2.1 m forward
 * of the center of mass — arm enough for the ship to bear away on its own at
 * ~0.1°/s on either tack, with the rudder amidships. Permanent lee helm is a
 * design defect, not a characteristic.
 *
 * The right answer is the weighted average of two silhouettes: the hull side,
 * measured from the same hull everything else reads (37.7 m², center at
 * z = −0.21), and the spars, narrow and much further forward (6.4 m² at
 * z = −1.2). The hull side wins on area, the resulting center lands at −0.35 —
 * practically amidships, which is where it belongs — and the arm to the center of
 * mass drops from 2.11 to 1.26 m.
 *
 * Is there lee helm left over? Some, ~0.08°/s. And there should be: the cloth is
 * fixed and square, the mast is forward, and a boat left to itself in those
 * conditions **does bear away** until it falls off with the wind astern. Zeroing
 * that would mean inventing a number; what can be done honestly is to put the
 * force where the area is, and that is what is here.
 */
const WINDAGE_CENTER = (() => {
  const hull = measureWindageProfile();
  const total = hull.area + RIG_SIDE_AREA;
  return new THREE.Vector3(
    0,
    (hull.centerY * hull.area + RIG_CENTER_Y * RIG_SIDE_AREA) / total,
    (hull.centerZ * hull.area + SAIL_FRAME.z * RIG_SIDE_AREA) / total,
  );
})();

// --- cloth -------------------------------------------------------------------

/** Vertical slack of the cloth. What makes the canvas belly instead of stretch. */
const VERTICAL_SLACK = 1.055;
/** Diagonal slack. Smaller than the vertical, so the cloth resists shearing. */
const SHEAR_SLACK = 1.02;
/** Relaxation iterations per step. Three already makes the grid look rigid. */
const RELAX_ITERATIONS = 3;
/** Energy lost per step. Without it the cloth becomes permanent jelly. */
const CLOTH_DAMPING = 0.985;
/** Canvas acceleration per unit of dynamic wind pressure. */
const CLOTH_WIND = 0.085;
/** Gravity the cloth feels. Less than real: canvas is light and air holds it. */
const CLOTH_GRAVITY = 3.4;
/** Flutter amplitude when the sail is flying loose. */
const FLUTTER_GAIN = 0.55;

interface ClothConstraint {
  a: number;
  b: number;
  rest: number;
}

const _trueWind = new THREE.Vector3();
const _relativeWind = new THREE.Vector3();
const _localWind = new THREE.Vector3();
const _force = new THREE.Vector3();
const _worldPoint = new THREE.Vector3();
const _rest = new THREE.Vector3();

export class SailSim {
  /** 0 = furled, 1 = full sail. No input yet; the force already respects it. */
  trim = 1;

  /** Longitudinal thrust from the last step, in newtons. Telemetry and HUD. */
  thrust = 0;
  /** Heading efficiency relative to the wind, 0.25 to 1. Feeds the wind HUD. */
  efficiency = 0;
  /** Apparent wind in the ship's frame. The AI reads it to pick a heading. */
  readonly localWind = new THREE.Vector3();

  private readonly geometry: THREE.BufferGeometry | null;
  private readonly positions: Float32Array | null = null;
  private readonly previous: Float32Array | null = null;
  private readonly pinned: Uint8Array | null = null;
  private readonly constraints: ClothConstraint[] = [];
  private clothTime = 0;

  /**
   * @param mesh sail mesh, or `null` for a ship with no visible cloth (the far
   *   sea, where the fabric would not be seen and is not worth the cost).
   */
  constructor(mesh: THREE.Mesh | null) {
    this.geometry = mesh?.geometry ?? null;
    if (!this.geometry) return;

    const attribute = this.geometry.getAttribute('position') as THREE.BufferAttribute;
    this.positions = attribute.array as Float32Array;
    this.previous = new Float32Array(this.positions);

    const { columns, rows } = SAIL_FRAME;
    this.pinned = new Uint8Array((columns + 1) * (rows + 1));
    for (let i = 0; i <= columns; i++) {
      // Head on the yard and foot on the boom: the two bolt ropes lashed to spars.
      this.pinned[sailVertexIndex(i, 0)] = 1;
      this.pinned[sailVertexIndex(i, rows)] = 1;
    }

    // The leeches (the side edges) are left loose on purpose: that is where the
    // flutter shows, and it is what separates a live sail from a stretched poster.
    const dx = (SAIL_FRAME.halfWidth * 2) / columns;
    const dy = (SAIL_FRAME.topY - SAIL_FRAME.bottomY) / rows;
    const diagonal = Math.hypot(dx, dy * VERTICAL_SLACK);

    for (let j = 0; j <= rows; j++) {
      for (let i = 0; i <= columns; i++) {
        const index = sailVertexIndex(i, j);
        if (i < columns) this.constraints.push({ a: index, b: sailVertexIndex(i + 1, j), rest: dx });
        if (j < rows) {
          this.constraints.push({ a: index, b: sailVertexIndex(i, j + 1), rest: dy * VERTICAL_SLACK });
        }
        if (i < columns && j < rows) {
          this.constraints.push({ a: index, b: sailVertexIndex(i + 1, j + 1), rest: diagonal * SHEAR_SLACK });
          this.constraints.push({
            a: sailVertexIndex(i + 1, j),
            b: sailVertexIndex(i, j + 1),
            rest: diagonal * SHEAR_SLACK,
          });
        }
      }
    }

  }

  /**
   * Fixed step of the sail: applies the forces to the body and shakes the cloth.
   *
   * @param waves source of the true wind.
   */
  update(dt: number, body: ShipBody, waves: WaveField): void {
    getTrueWind(waves, _trueWind);

    // Partial apparent wind: see `APPARENT_RELIEF`.
    _relativeWind.copy(_trueWind).addScaledVector(body.velocity, -APPARENT_RELIEF);
    body.worldDirToLocal(_relativeWind, _localWind);
    this.localWind.copy(_localWind);

    this.applyThrust(body);
    this.applyWindage(body);
    this.stepCloth(dt);
  }

  /** Sail thrust: longitudinal force at the center of effort. */
  private applyThrust(body: ShipBody): void {
    const windSpeed = _localWind.length();
    if (windSpeed < 0.01 || this.trim <= 0) {
      this.thrust = 0;
      this.efficiency = 0;
      return;
    }

    // The sail is fixed and square across, so its normal is the ship's bow-stern
    // axis: local -Z is the bow. `alignment` is the cosine between heading and wind.
    const alignment = -_localWind.z / windSpeed;
    this.efficiency = MIN_EFFICIENCY + (1 - MIN_EFFICIENCY) * (1 + alignment) * 0.5;

    const dynamicPressure = 0.5 * AIR_DENSITY * windSpeed * windSpeed;
    this.thrust = dynamicPressure * RIG_AREA * SAIL_CD * this.efficiency * this.trim;

    _force.set(0, 0, -this.thrust);
    body.localDirToWorld(_force, _force);
    body.localToWorld(SAIL_CENTER, _worldPoint);
    body.applyForceAtPoint(_force, _worldPoint);
  }

  /** Wind drag on topsides and spars: heel and leeway. */
  private applyWindage(body: ShipBody): void {
    const speed = _localWind.length();
    if (speed < 0.01) return;

    // On the *relative* wind, in world space: this share pushes the ship to
    // leeward, not toward the bow.
    _force
      .copy(_relativeWind)
      .multiplyScalar(0.5 * AIR_DENSITY * WINDAGE_CD * WINDAGE_AREA * speed);
    body.localToWorld(WINDAGE_CENTER, _worldPoint);
    body.applyForceAtPoint(_force, _worldPoint);
  }

  /** One Verlet step on the fabric. */
  private stepCloth(dt: number): void {
    const positions = this.positions;
    const previous = this.previous;
    const pinned = this.pinned;
    if (!positions || !previous || !pinned || !this.geometry) return;

    this.clothTime += dt;

    // Pressure on the cloth: **the same efficiency that makes the force**.
    //
    // This is where the defect lived that read as "the sail is on the wrong
    // side". The pressure came out of raw `-localWind.z`, that is, out of the
    // sign of the wind — and with the wind on the bow that sign flips: the canvas
    // was pushed aft, flattened against the mast and the ship had no sail at all,
    // a thin skin wrapped around the trunk. Except this game's physics does
    // **not** stop with the wind on the bow: efficiency has a floor at
    // `MIN_EFFICIENCY` and the sloop keeps 65% of its speed, which is the
    // characteristic that defines the boat. The two descriptions disagreed, and
    // the one the player sees is the wrong one.
    //
    // Reading the same `efficiency` the propulsion reads, the cloth always bellies
    // forward and the belly becomes the **gauge** of the heading: full downwind,
    // medium on the beam, shallow on the bow. No sign to flip, and never again
    // half a sail on each side of the spar.
    const windSpeed = Math.max(_localWind.length(), 0.001);
    const drive = windSpeed * this.efficiency * this.trim;
    const pressure = CLOTH_WIND * drive * drive;

    // A full sail is stiff and quiet; a badly trimmed sail flaps. `luff` runs from
    // 0 (wind astern) to 1 (wind in your face), and the flutter comes out of the
    // **total** dynamic pressure — not out of the share that pushes — because a
    // sail taken aback shakes with the wind's full force, precisely because it is
    // not working.
    const alignment = -_localWind.z / windSpeed;
    const luff = clamp01((1 - alignment) * 0.5);
    const flutter = FLUTTER_GAIN * luff * CLOTH_WIND * windSpeed * windSpeed;
    const dt2 = dt * dt;

    for (let index = 0; index < pinned.length; index++) {
      if (pinned[index]) continue;
      const o = index * 3;

      const x = positions[o]!;
      const y = positions[o + 1]!;
      const z = positions[o + 2]!;

      const turbulence =
        flutter *
        Math.sin(x * 2.3 + this.clothTime * 7.1) *
        Math.sin(y * 1.7 - this.clothTime * 5.3);

      positions[o] = x + (x - previous[o]!) * CLOTH_DAMPING;
      positions[o + 1] = y + (y - previous[o + 1]!) * CLOTH_DAMPING - CLOTH_GRAVITY * dt2;
      positions[o + 2] = z + (z - previous[o + 2]!) * CLOTH_DAMPING - (pressure + turbulence) * dt2;

      previous[o] = x;
      previous[o + 1] = y;
      previous[o + 2] = z;
    }

    for (let iteration = 0; iteration < RELAX_ITERATIONS; iteration++) {
      for (const constraint of this.constraints) {
        const a = constraint.a * 3;
        const b = constraint.b * 3;

        const dx = positions[b]! - positions[a]!;
        const dy = positions[b + 1]! - positions[a + 1]!;
        const dz = positions[b + 2]! - positions[a + 2]!;
        const length = Math.hypot(dx, dy, dz);
        if (length < 1e-6) continue;

        // Only shortens, never stretches: canvas is not elastic. Letting the
        // constraint push when the cloth is slack is what would create that
        // plastic ripple that gives away badly simulated fabric.
        if (length <= constraint.rest) continue;

        const correction = (length - constraint.rest) / length / 2;
        const cx = dx * correction;
        const cy = dy * correction;
        const cz = dz * correction;

        if (!pinned[constraint.a]) {
          positions[a] += cx;
          positions[a + 1] += cy;
          positions[a + 2] += cz;
        }
        if (!pinned[constraint.b]) {
          positions[b] -= cx;
          positions[b + 1] -= cy;
          positions[b + 2] -= cz;
        }
      }
    }

    this.keepOffMast();

    this.geometry.getAttribute('position').needsUpdate = true;
    this.geometry.computeVertexNormals();
    this.geometry.getAttribute('normal').needsUpdate = true;
  }

  /**
   * Pushes the canvas clear of the mast, **always forward**.
   *
   * Without this the cloth goes through the trunk: the four edges are made fast in the
   * mast's plane and the middle is born inside it, and the mast does not exist for the
   * Verlet solver. What you saw was half a sail on each side of the spar, which is
   * precisely the reading of "the sail is on the wrong side".
   *
   * The side is now chosen, and not inherited. The previous version sent each node to
   * whichever side it was already on, which preserved — and petrified — any piece of
   * cloth that had escaped aft on a bad frame: the canvas ended up split by the trunk,
   * half on each side, never recomposing. Since the pressure now always inflates in
   * favor of the thrust (see `stepCloth`), the sail has a right side, and that is the one
   * the mast pushes toward.
   *
   * It runs **after** the relaxation, and not before: a non-penetration constraint
   * applied in the middle of the iterations is undone by the next one, and the cloth goes
   * back to flickering through the mast on alternate frames.
   */
  private keepOffMast(): void {
    const positions = this.positions;
    const pinned = this.pinned;
    if (!positions || !pinned) return;

    for (let index = 0; index < pinned.length; index++) {
      if (pinned[index]) continue;
      const o = index * 3;

      const clearance = mastClearance(positions[o]!, positions[o + 1]!);
      if (clearance <= 0) continue;

      const front = SAIL_FRAME.z - clearance;
      if (positions[o + 2]! > front) positions[o + 2] = front;
    }
  }

  /** Returns the cloth to its rest shape — used when restarting a match. */
  reset(): void {
    const positions = this.positions;
    const previous = this.previous;
    if (!positions || !previous || !this.geometry) return;

    const { columns, rows } = SAIL_FRAME;
    for (let j = 0; j <= rows; j++) {
      for (let i = 0; i <= columns; i++) {
        const o = sailVertexIndex(i, j) * 3;
        sailRestPoint(i, j, _rest);
        positions[o] = _rest.x;
        positions[o + 1] = _rest.y;
        positions[o + 2] = _rest.z;
      }
    }
    previous.set(positions);
    this.geometry.getAttribute('position').needsUpdate = true;
    this.geometry.computeVertexNormals();
  }
}
