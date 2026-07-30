/**
 * Ballistics: the physics of a cannonball in the air, and its inverse.
 *
 * Two things live here, and they live together on purpose:
 *
 * - **The integration step** the projectile uses in flight.
 * - **The aiming solver** — given where the target is and where it is going, which
 *   elevation and which bearing hit.
 *
 * The solver has no closed form: with quadratic drag the trajectory stops being a
 * parabola and the inverse does not exist analytically. So it **simulates** with the
 * same step function the real projectile uses, and finds the angle by bisection. It is
 * more expensive than a pencil-and-paper calculation, and it is the only way for the
 * predicted shot and the fired shot to agree — if the AI used the vacuum parabola, it
 * would miss by meters precisely on the long shots, which is where the difference
 * between the three difficulties has to show.
 *
 * The scale of the problem: at 95 m/s the ball loses ~5.4 m/s² to drag alone early in
 * the flight, against gravity's 9.81. It is not a detail you can ignore.
 */

import * as THREE from 'three';
import { AIR_DENSITY, GRAVITY, clamp } from '../core/MathUtils';

/** Drag coefficient of a smooth sphere in the subsonic regime. */
export const SPHERE_DRAG = 0.47;

/** Step of the solver's internal simulation, in seconds. */
const SOLVER_STEP = 1 / 120;
/** Ceiling on the time of flight the solver considers, in seconds. */
const SOLVER_MAX_TIME = 14;

/** Lowest elevation the solver tries, in radians. */
const SOLVER_MIN_ELEVATION = -0.35;
/**
 * And the highest (44°).
 *
 * It sits just below the maximum-range angle on purpose: that is where the height at a
 * given distance stops growing with the elevation, and the bisection needs monotonicity
 * to hold. Whoever wants the high arc should raise the limit — but naval combat is flat
 * fire, not mortar fire.
 */
const SOLVER_MAX_ELEVATION = 0.77;

/**
 * A projectile's drag factor: `k = ½·ρ·Cd·A / m`.
 *
 * Kept ready because the deceleration is `k·|v|·v` and that calculation runs per
 * sub-step, per ball. It depends only on mass and radius, which do not change in
 * flight.
 */
export function dragFactor(mass: number, radius: number): number {
  return (0.5 * AIR_DENSITY * SPHERE_DRAG * Math.PI * radius * radius) / mass;
}

const _accel = new THREE.Vector3();

/**
 * One step of flight, semi-implicit: accelerate first, move afterwards.
 *
 * Semi-implicit (and not plain Euler) because with drag the explicit method's error
 * always accumulates in the same direction — the ball slows a little less than it
 * should on every step, and at 60 Hz that becomes meters of extra range.
 */
export function stepBallistic(
  position: THREE.Vector3,
  velocity: THREE.Vector3,
  dragK: number,
  dt: number,
): void {
  const speed = velocity.length();
  _accel.copy(velocity).multiplyScalar(-dragK * speed);
  _accel.y -= GRAVITY;

  velocity.addScaledVector(_accel, dt);
  position.addScaledVector(velocity, dt);
}

export interface FlightResult {
  /** Height relative to the starting point when the range was crossed. */
  height: number;
  /** Time of flight up to there, in seconds. */
  time: number;
  /** `false` when the ball never reached the requested range. */
  reached: boolean;
}

const _flightPos = new THREE.Vector3();
const _flightVel = new THREE.Vector3();
const _previousPos = new THREE.Vector3();

/**
 * Flies a shot in the vertical plane and returns the height at which it crosses
 * `range`.
 *
 * It works in two dimensions (X is the ground range, Y the height) because the problem
 * *is* two-dimensional: the wind does not deflect the ball in this game, so the shot's
 * plane contains the origin, the target and gravity.
 */
export function flyToRange(
  range: number,
  elevation: number,
  speed: number,
  dragK: number,
): FlightResult {
  _flightPos.set(0, 0, 0);
  _flightVel.set(Math.cos(elevation) * speed, Math.sin(elevation) * speed, 0);

  const steps = Math.ceil(SOLVER_MAX_TIME / SOLVER_STEP);
  for (let i = 0; i < steps; i++) {
    _previousPos.copy(_flightPos);
    stepBallistic(_flightPos, _flightVel, dragK, SOLVER_STEP);

    if (_flightPos.x >= range) {
      // It interpolates inside the step it crossed on: without this the result gains
      // a step of up to 80 cm (one flight step), and the bisection ends up hunting for
      // an angle the discretization hid.
      const span = _flightPos.x - _previousPos.x;
      const s = span > 1e-9 ? (range - _previousPos.x) / span : 0;
      return {
        height: _previousPos.y + (_flightPos.y - _previousPos.y) * s,
        time: (i + s) * SOLVER_STEP,
        reached: true,
      };
    }

    // It is already coming down and passed well below the target: it will not get
    // there.
    if (_flightVel.x <= 0.01) break;
  }

  return { height: _flightPos.y, time: SOLVER_MAX_TIME, reached: false };
}

export interface AimSolution {
  /** Elevation of the barrel above the horizontal, in radians. */
  elevation: number;
  /** Time of flight to the target, in seconds. */
  time: number;
}

/**
 * The elevation that makes the ball pass through (`range`, `height`) relative to the
 * muzzle.
 *
 * Bisection over the low arc. The height at a given range grows with the elevation up
 * to the maximum-range angle, and `SOLVER_MAX_ELEVATION` sits below it — inside that
 * band the function is monotonic and the bisection is exact.
 *
 * @returns `null` when even at maximum elevation the ball does not get there.
 */
export function solveElevation(
  range: number,
  height: number,
  speed: number,
  dragK: number,
): AimSolution | null {
  if (range <= 0.01) return null;

  const highest = flyToRange(range, SOLVER_MAX_ELEVATION, speed, dragK);
  if (!highest.reached || highest.height < height) return null;

  let low = SOLVER_MIN_ELEVATION;
  let high = SOLVER_MAX_ELEVATION;
  let result = highest;

  // Twenty rounds take the 1.12 rad band down to ~1 µrad: far beyond what the
  // carriage's traverse can point, and still cheap (one 2D simulation per round,
  // ~2 thousand steps in the worst case).
  for (let i = 0; i < 20; i++) {
    const mid = (low + high) * 0.5;
    result = flyToRange(range, mid, speed, dragK);
    if (result.reached && result.height >= height) high = mid;
    else low = mid;
  }

  return { elevation: high, time: result.time };
}

const _toTarget = new THREE.Vector3();
const _predicted = new THREE.Vector3();

export interface InterceptSolution extends AimSolution {
  /** Azimuth of the shot, in radians, measured as `atan2(x, z)` in the world. */
  azimuth: number;
  /** The world point where the ball and the target meet. */
  readonly aimPoint: THREE.Vector3;
}

/**
 * Where to point to hit a target that is moving.
 *
 * The problem is implicit — the time of flight depends on where the target will be, and
 * where it will be depends on the time of flight — so it is solved by fixed-point
 * iteration. Three rounds are enough: the target does at most about 6 m/s and the third
 * round's correction is already down to centimeters.
 *
 * The muzzle velocity inherited from the firing ship does **not** come in here. The
 * caller subtracts its own velocity from the target's beforehand if it wants that
 * correction — as it stands, `targetVelocity` is the *relative* velocity that matters.
 */
export function solveIntercept(
  muzzle: THREE.Vector3,
  targetPosition: THREE.Vector3,
  targetVelocity: THREE.Vector3,
  speed: number,
  dragK: number,
  iterations = 3,
): InterceptSolution | null {
  _predicted.copy(targetPosition);
  let solution: AimSolution | null = null;

  for (let i = 0; i < iterations; i++) {
    _toTarget.subVectors(_predicted, muzzle);
    const range = Math.hypot(_toTarget.x, _toTarget.z);

    solution = solveElevation(range, _toTarget.y, speed, dragK);
    if (!solution) return null;

    _predicted.copy(targetPosition).addScaledVector(targetVelocity, solution.time);
  }

  if (!solution) return null;

  _toTarget.subVectors(_predicted, muzzle);
  return {
    elevation: solution.elevation,
    time: solution.time,
    azimuth: Math.atan2(_toTarget.x, _toTarget.z),
    aimPoint: _predicted.clone(),
  };
}

/**
 * Theoretical maximum range, in meters — how far a shot leaving the waterline at the
 * best angle flies. It lets the AI discard targets that are too far without simulating.
 */
export function maxRange(speed: number, dragK: number): number {
  let best = 0;
  for (let i = 0; i <= 12; i++) {
    const elevation = clamp((i / 12) * SOLVER_MAX_ELEVATION, 0, SOLVER_MAX_ELEVATION);
    _flightPos.set(0, 0, 0);
    _flightVel.set(Math.cos(elevation) * speed, Math.sin(elevation) * speed, 0);

    const steps = Math.ceil(SOLVER_MAX_TIME / SOLVER_STEP);
    for (let s = 0; s < steps; s++) {
      _previousPos.copy(_flightPos);
      stepBallistic(_flightPos, _flightVel, dragK, SOLVER_STEP);
      if (_flightPos.y <= 0) {
        const drop = _previousPos.y - _flightPos.y;
        const f = drop > 1e-9 ? _previousPos.y / drop : 0;
        best = Math.max(best, _previousPos.x + (_flightPos.x - _previousPos.x) * f);
        break;
      }
    }
  }
  return best;
}
