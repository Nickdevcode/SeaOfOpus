/**
 * Math utilities used by the physics, the camera and the AI.
 *
 * Everything here is frame-rate independent: the smoothing functions take `dt` and use
 * exponential decay instead of `lerp(a, b, 0.1)`, which changes behavior as the FPS
 * varies.
 */

export const TAU = Math.PI * 2;
export const DEG = Math.PI / 180;
export const RAD = 180 / Math.PI;

/** Gravity in m/s². Used by the ballistics and by the buoyancy. */
export const GRAVITY = 9.81;

/** Seawater density in kg/m³. */
export const WATER_DENSITY = 1025;

/** Air density in kg/m³, used by the sail's force and the ball's drag. */
export const AIR_DENSITY = 1.225;

export function clamp(v: number, min: number, max: number): number {
  return v < min ? min : v > max ? max : v;
}

export function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

export function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

export function invLerp(a: number, b: number, v: number): number {
  return a === b ? 0 : (v - a) / (b - a);
}

export function remap(v: number, inMin: number, inMax: number, outMin: number, outMax: number): number {
  return lerp(outMin, outMax, clamp01(invLerp(inMin, inMax, v)));
}

export function smoothstep(edge0: number, edge1: number, x: number): number {
  const t = clamp01(invLerp(edge0, edge1, x));
  return t * t * (3 - 2 * t);
}

/**
 * Frame-rate independent exponential smoothing.
 * `lambda` is the decay rate: the higher it is, the faster it converges.
 * It is equivalent to a lerp that behaves the same at 30 or 144 FPS.
 */
export function damp(current: number, target: number, lambda: number, dt: number): number {
  return lerp(target, current, Math.exp(-lambda * dt));
}

/** Moves `current` toward `target` by at most `maxDelta`. */
export function moveTowards(current: number, target: number, maxDelta: number): number {
  const diff = target - current;
  if (Math.abs(diff) <= maxDelta) return target;
  return current + Math.sign(diff) * maxDelta;
}

/** Normalizes an angle in radians into the interval (-π, π]. */
export function wrapAngle(a: number): number {
  a = (a + Math.PI) % TAU;
  if (a < 0) a += TAU;
  return a - Math.PI;
}

/** Smallest angular difference between two angles, in the interval (-π, π]. */
export function angleDelta(from: number, to: number): number {
  return wrapAngle(to - from);
}

/**
 * Applies a radial dead zone to a pair of stick axes and recurves the response.
 * Radial (and not per axis) avoids the classic "square corner" that makes the aim
 * speed up on the diagonals.
 */
export function applyDeadzone(x: number, y: number, deadzone: number, exponent = 2): [number, number] {
  const mag = Math.hypot(x, y);
  if (mag < deadzone) return [0, 0];
  const normalized = clamp01((mag - deadzone) / (1 - deadzone));
  const curved = Math.pow(normalized, exponent);
  const scale = curved / mag;
  return [x * scale, y * scale];
}

/**
 * A discrete PID controller, used by the bot helmsman to hold a heading.
 * It keeps internal state, so each instance serves a single target.
 */
export class PID {
  private integral = 0;
  private previousError = 0;
  private initialized = false;

  constructor(
    public kp: number,
    public ki: number,
    public kd: number,
    /** Caps the integral term's accumulation to avoid windup. */
    public integralLimit = 1,
  ) {}

  update(error: number, dt: number): number {
    if (dt <= 0) return 0;

    this.integral = clamp(this.integral + error * dt, -this.integralLimit, this.integralLimit);

    // On the first call there is no valid derivative; using 0 avoids an initial
    // spike.
    const derivative = this.initialized ? (error - this.previousError) / dt : 0;
    this.previousError = error;
    this.initialized = true;

    return this.kp * error + this.ki * this.integral + this.kd * derivative;
  }

  reset(): void {
    this.integral = 0;
    this.previousError = 0;
    this.initialized = false;
  }
}

/**
 * Deterministic pseudo-random generator (mulberry32).
 * Used so that waves, decoration and the AI's aiming error are reproducible between
 * matches — essential for debugging physics.
 */
export function createRandom(seed: number): () => number {
  let a = seed >>> 0;
  return function random(): number {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** A sample from a standard normal via Box-Muller, for the AI's aiming error. */
export function gaussian(random: () => number): number {
  let u = 0;
  let v = 0;
  while (u === 0) u = random();
  while (v === 0) v = random();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(TAU * v);
}

/** Converts meters per second into knots (used in the HUD). */
export function msToKnots(ms: number): number {
  return ms * 1.943844;
}
