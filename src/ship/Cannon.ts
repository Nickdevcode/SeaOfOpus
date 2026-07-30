/**
 * A broadside gun: laying, loading, firing and recoil.
 *
 * The piece knows how to aim and spit a ball, and nothing beyond that. What decides
 * *when* is the player (`PlayerController`) or the bot gunner, and what turns the shot
 * into a projectile is the combat module — this file only hands over the finished firing
 * solution: where the ball leaves from, where it goes and how fast.
 *
 * Three decisions worth explaining:
 *
 * - **The ball inherits the ship's velocity.** It is born with the velocity of the point
 *   of the hull the muzzle is at (translation plus ω × r), as it happens for real. That is
 *   what makes firing a broadside with the ship at 8 knots require a real correction,
 *   instead of the ship being firm ground in disguise.
 * - **The shot happens on the fixed step, not on the frame.** `triggerPull()` only raises
 *   the flag; `fixedUpdate` is what fires. Recoil is an impulse, and an impulse applied
 *   over a render `dt` varies with the FPS — the same shot would push the ship harder at
 *   30 fps than at 144.
 * - **The recoil is applied on the bore's axis.** Not at the center of mass: the muzzle
 *   sits 2.5 m above the waterline and 2 m off the axis, so the shot heels and yaws the
 *   ship a little. It is small (about 10 mm/s), but it is free and it has the right sign.
 * - **The recoil is part of the piece's clock, and not only of its drawing.** The
 *   carriage runs 38 cm inboard and comes back on the breechings; while it is running,
 *   nobody is ramming any ball home. See `beginLoad`.
 */

import * as THREE from 'three';
import { clamp, wrapAngle } from '../core/MathUtils';
import type { ShipBody } from './ShipBody';
import {
  BARREL_AXIS_Y,
  BARREL_LENGTH,
  BORE_RADIUS,
  BREECH_OFFSET,
  type CannonAssembly,
} from './ShipParts';

/**
 * The ball's radius, in meters.
 *
 * Smaller than the bore on purpose: the clearance between ball and barrel ("windage", in
 * artillery jargon) was around 4% and it is what let you load without a lathe. The mass
 * comes out of this, and out of the mass come the recoil and the ballistics' drag.
 */
export const BALL_RADIUS = BORE_RADIUS * 0.96;
/** Density of cast iron, in kg/m³. */
const IRON_DENSITY = 7200;
/** The ball's mass, in kg. Computed, not chosen: ~3.7 kg, a "half-pounder". */
export const BALL_MASS = (4 / 3) * Math.PI * BALL_RADIUS ** 3 * IRON_DENSITY;

/**
 * Muzzle velocity, in m/s.
 *
 * A real cannon spits at 300–400 m/s, and with that the shot would be a pure straight
 * line inside combat range — nothing would be left of the target leading that is the core
 * of the naval duel in Sea of Thieves. At 95 m/s a 100 m shot takes a little over 1 s and
 * drops some 5 m on the way: it forces you to elevate and to lead the target, which is
 * exactly the game's behavior.
 */
export const MUZZLE_SPEED = 95;

/**
 * The carriage's traverse stop, in radians (±26°).
 *
 * Exported because it is what defines the AI's tactical problem: with the barrel held
 * within 26° of the beam, keeping the target under fire is the **helmsman's** job, not the
 * gunner's. A bot that could swing the piece 180° would do away with maneuvering, and the
 * maneuvering is the game.
 */
export const TRAVERSE_LIMIT = 0.45;
/** Minimum elevation: the muzzle drops a little below the horizontal. */
export const ELEVATION_MIN = -0.09;
/** Maximum elevation (~33°), where the breech meets the deck. */
export const ELEVATION_MAX = 0.58;

/** Time to ram the ball home, in seconds. It only runs with the carriage seated. */
const LOAD_TIME = 1.5;

/** How far the carriage runs inboard on the shot, in meters. */
const RECOIL_TRAVEL = 0.38;
/**
 * The speed at which the carriage returns to the stop, in m/s.
 *
 * With the 38 cm of travel, it gives **0.69 s** between the shot and the piece being fit
 * to take the next charge — and that number stopped being decorative. See `beginLoad`.
 */
const RECOIL_RETURN = 0.55;

export type CannonState = 'empty' | 'loading' | 'loaded';

/** Everything the combat module needs in order to create the projectile. */
export interface FireSolution {
  /** The muzzle's position in the world, at the instant of the shot. */
  readonly position: THREE.Vector3;
  /** Initial velocity in the world, with the ship's already added in. */
  readonly velocity: THREE.Vector3;
  readonly mass: number;
  readonly radius: number;
  /** Who fired — the damage has to know so it does not count friendly fire. */
  readonly owner: string;
}

/** The piece's pair of angles, with the verdict on whether it reaches that direction. */
export interface AimAngles {
  traverse: number;
  elevation: number;
  /** `true` when both angles fall inside the carriage's stops. */
  bears: boolean;
}

const _quat = new THREE.Quaternion();
const _barrel = new THREE.Quaternion();
const _euler = new THREE.Euler(0, 0, 0, 'YXZ');
const _arm = new THREE.Vector3();
const _carry = new THREE.Vector3();
const _force = new THREE.Vector3();
const _pivot = new THREE.Vector3();
const UP = new THREE.Vector3(0, 1, 0);

export class Cannon {
  /** +1 starboard, -1 port. */
  readonly side: 1 | -1;

  /** Traverse within the carriage's stop, in radians. */
  traverse = 0;
  /** The barrel's elevation, in radians. Positive is muzzle up. */
  elevation = 0.1;

  state: CannonState = 'empty';
  /** 0..1 while loading. The HUD draws the bar from this. */
  loadProgress = 0;

  /** The carriage's current displacement from the recoil, in meters. */
  recoil = 0;

  /**
   * The three angles at the previous step, so the drawing can interpolate between steps.
   *
   * The piece is laid and recoils on the fixed step, but it is drawn at the monitor's
   * rate. Without this memory, the barrel moved in 60 Hz steps on a 144 Hz screen — the
   * recoil was the most visible one, because it is the fastest movement on the whole
   * ship. Same technique, and same reason, as `ShipBody.previousCom`.
   */
  previousTraverse = 0;
  previousElevation = 0.1;
  previousRecoil = 0;

  /** The trigger asked for this frame, consumed by the next fixed step. */
  private triggered = false;

  /**
   * The side's fixed orientation, read off the model: ∓90°, the barrel athwartships.
   *
   * Public because `solveAim` measures the traverse from it, and the AI has to be able to
   * ask which way the piece is looking without duplicating that constant.
   */
  readonly sideYaw: number;

  constructor(
    readonly assembly: CannonAssembly,
    /** Name of the owning ship, carried through to the firing solution. */
    readonly owner: string,
  ) {
    this.sideYaw = assembly.root.rotation.y;
    this.side = assembly.root.position.x >= 0 ? 1 : -1;
  }

  get isLoaded(): boolean {
    return this.state === 'loaded';
  }

  /** Lays the gun. The deltas come in radians, from the mouse or the stick. */
  aim(deltaTraverse: number, deltaElevation: number): void {
    this.traverse = clamp(this.traverse + deltaTraverse, -TRAVERSE_LIMIT, TRAVERSE_LIMIT);
    this.elevation = clamp(this.elevation + deltaElevation, ELEVATION_MIN, ELEVATION_MAX);
  }

  /**
   * Starts serving the piece. Returns `false` if there was already a charge in it or it
   * is already loading.
   *
   * **The command is accepted at once, but the work only begins with the carriage
   * seated.** After the shot the piece is 38 cm inboard, running back on the breechings,
   * and you do not put a rammer into half a ton of moving iron — whoever serves the piece
   * waits for it to stop at the stop. It is 0.69 s the model was already computing and
   * nobody was charging for: until now the recoil was a decoration that ran in parallel
   * with the loading, and the firing cycle cost exactly `LOAD_TIME` and nothing else.
   *
   * The command is queued instead of refused, and that part matters to whoever is
   * playing: hitting reload in the roar of your own shot is the natural gesture, and
   * returning `false` there would force the player to press twice for no reason they
   * could see on screen. The ball leaves the magazine at the instant of the command
   * (`Ship.loadCannon`) — it is already in the server's hand.
   *
   * It holds for both sides of the duel, and that is settled: `Cannon` does not know who
   * operates it. An exception for the player's ship in here would be exactly the kind of
   * cheat the rest of the project takes the trouble to avoid.
   */
  beginLoad(): boolean {
    if (this.state !== 'empty') return false;
    this.state = 'loading';
    this.loadProgress = 0;
    return true;
  }

  /** Asks for fire. The shot goes off on the next fixed step, if there is a charge. */
  triggerPull(): void {
    this.triggered = true;
  }

  /**
   * @returns the firing solution when the cannon fires on this step.
   */
  /**
   * Stores this instant's pose as the "previous" one for the step about to begin.
   *
   * It has to run **before** whoever lays the gun, and that is why it does not live in
   * `fixedUpdate`: the sailor (or the machine's gunner) calls `aim` before the ship
   * integrates, so by the time `fixedUpdate` arrived the pose would already have changed
   * and the "previous" would come out equal to the current one — interpolation of nothing
   * with nothing, and the barrel back to the 60 Hz steps it exists to remove.
   */
  beginStep(): void {
    this.previousTraverse = this.traverse;
    this.previousElevation = this.elevation;
    this.previousRecoil = this.recoil;
  }

  fixedUpdate(dt: number, body: ShipBody): FireSolution | null {
    // The carriage comes back to the stop on the breechings, not instantly — and it
    // comes **before** the loading because it is what releases it. See `beginLoad`.
    if (this.recoil > 0) this.recoil = Math.max(this.recoil - RECOIL_RETURN * dt, 0);

    if (this.state === 'loading' && this.recoil <= 0) {
      this.loadProgress += dt / LOAD_TIME;
      if (this.loadProgress >= 1) {
        this.loadProgress = 1;
        this.state = 'loaded';
      }
    }

    if (!this.triggered) return null;
    this.triggered = false;
    if (this.state !== 'loaded') return null;

    return this.discharge(dt, body);
  }

  /**
   * The barrel's orientation in the ship's local coordinates.
   *
   * @param alpha fraction of the step already elapsed, for the drawing pose. Omitted, it
   *   returns the **simulation's** pose — which is what the ballistics and the gunner
   *   have to see: aiming against an interpolated pose would solve the shot half a step
   *   behind where the piece actually is.
   */
  getBarrelQuaternion(target: THREE.Quaternion, alpha?: number): THREE.Quaternion {
    const elevation =
      alpha === undefined
        ? this.elevation
        : this.previousElevation + (this.elevation - this.previousElevation) * alpha;
    const traverse =
      alpha === undefined
        ? this.traverse
        : this.previousTraverse + (this.traverse - this.previousTraverse) * alpha;
    _euler.set(elevation, this.sideYaw + traverse, 0);
    return target.setFromEuler(_euler);
  }

  /** The direction the muzzle points, in the ship's local coordinates. */
  getAimLocal(target: THREE.Vector3): THREE.Vector3 {
    this.getBarrelQuaternion(_barrel);
    return target.set(0, 0, -1).applyQuaternion(_barrel);
  }

  /**
   * **The inverse of `getAimLocal`:** what traverse and elevation point the bore in this
   * direction. It is the bridge between the ballistics, which solves in the world, and
   * the carriage, which only understands two angles fixed to the hull.
   *
   * The arithmetic comes out of taking apart the same composition `getBarrelQuaternion`
   * puts together. With the 'YXZ' order and no roll, the muzzle's direction is
   *
   * ```
   * d = ( −cos e · sin a ,  sin e ,  −cos e · cos a )      a = sideYaw + traverse
   * ```
   *
   * from which `e = asin(d.y)` and `a = atan2(−d.x, −d.z)`. There is no ambiguity to
   * resolve because the elevation lives in (−90°, 90°): a mortar's high arc simply does
   * not exist on this piece.
   *
   * **Why the direction comes in the ship's coordinates.** The hull is working in the
   * sea. Converting the world solution into local *at the instant of the shot*, the
   * ship's attitude enters the arithmetic for free — and that is what makes the bot
   * gunner wait for the roll to bring the barrel onto the target instead of firing into
   * the middle of the sea. The aim does not correct for the roll: it waits for it.
   *
   * @param localDirection the desired direction, in the ship's coordinates. It does not
   *   have to be normalized.
   */
  solveAim(localDirection: THREE.Vector3, out: AimAngles): AimAngles {
    const length = localDirection.length();
    if (length < 1e-9) {
      out.traverse = this.traverse;
      out.elevation = this.elevation;
      out.bears = false;
      return out;
    }

    out.elevation = Math.asin(clamp(localDirection.y / length, -1, 1));
    // `wrapAngle` because `sideYaw` is ±π/2 and the azimuth comes in (−π, π]: without
    // normalizing, the port piece would see traverses up around 270°.
    out.traverse = wrapAngle(Math.atan2(-localDirection.x, -localDirection.z) - this.sideYaw);
    out.bears =
      Math.abs(out.traverse) <= TRAVERSE_LIMIT &&
      out.elevation >= ELEVATION_MIN &&
      out.elevation <= ELEVATION_MAX;

    return out;
  }

  /**
   * The trunnions' center — the point the barrel elevates around, and where the recoil
   * pushes. In the ship's local coordinates.
   */
  getPivotLocal(target: THREE.Vector3): THREE.Vector3 {
    const root = this.assembly.root;
    // The carriage runs back along its own line of fire. `sideYaw` stays out of it
    // because the result is rotated by it right below.
    const back = this.recoil;
    _quat.setFromAxisAngle(UP, this.sideYaw);
    target
      .set(Math.sin(this.traverse) * back, BARREL_AXIS_Y, Math.cos(this.traverse) * back)
      .applyQuaternion(_quat)
      .add(root.position);
    return target;
  }

  /** The muzzle's position, in the ship's local coordinates. */
  getMuzzleLocal(target: THREE.Vector3): THREE.Vector3 {
    this.getBarrelQuaternion(_barrel);
    this.getPivotLocal(_pivot);
    return target
      .set(0, 0, BREECH_OFFSET - BARREL_LENGTH)
      .applyQuaternion(_barrel)
      .add(_pivot);
  }

  /** Writes traverse, elevation and recoil into the 3D model, in the frame's pose. */
  syncModel(alpha = 1): void {
    const t = this.previousTraverse + (this.traverse - this.previousTraverse) * alpha;
    const e = this.previousElevation + (this.elevation - this.previousElevation) * alpha;
    const r = this.previousRecoil + (this.recoil - this.previousRecoil) * alpha;

    const { traverse, elevation } = this.assembly;
    traverse.rotation.y = t;
    traverse.position.set(Math.sin(t) * r, 0, Math.cos(t) * r);
    elevation.rotation.x = e;
  }

  reset(): void {
    this.state = 'empty';
    this.loadProgress = 0;
    this.recoil = 0;
    this.traverse = 0;
    this.elevation = 0.1;
    this.triggered = false;
    // The previous pose goes with it: without this, a new match's first frame
    // interpolates from where the piece was when the last one ended.
    this.previousTraverse = 0;
    this.previousElevation = 0.1;
    this.previousRecoil = 0;
  }

  private discharge(dt: number, body: ShipBody): FireSolution {
    const position = new THREE.Vector3();
    const direction = new THREE.Vector3();

    this.getMuzzleLocal(position);
    this.getAimLocal(direction);
    body.localToWorld(position, position);
    body.localDirToWorld(direction, direction);

    // The velocity of the muzzle's own point: the hull's translation plus the
    // rotation.
    _arm.subVectors(position, body.comPosition);
    body.pointVelocity(_arm, _carry);
    const velocity = direction.clone().multiplyScalar(MUZZLE_SPEED).add(_carry);

    // The impulse is converted into a force because the integrator works with forces; on
    // a fixed step the two are the same thing.
    this.getPivotLocal(_pivot);
    body.localToWorld(_pivot, _pivot);
    _force.copy(direction).multiplyScalar((-BALL_MASS * MUZZLE_SPEED) / dt);
    body.applyForceAtPoint(_force, _pivot);

    this.recoil = RECOIL_TRAVEL;
    this.state = 'empty';
    this.loadProgress = 0;

    return { position, velocity, mass: BALL_MASS, radius: BALL_RADIUS, owner: this.owner };
  }
}
