/**
 * The bot gunner: one gun, one target, and the decision of when to let the shot go.
 *
 * It uses **the same solver the ballistics test validates** — no vacuum parabola and no
 * "hits with X% chance". The path is a real gunner's:
 *
 * 1. Where the target will be when the ball gets there (`solveIntercept`).
 * 2. Which elevation and which azimuth take the ball to that point, **with drag**.
 * 3. Which traverse and which elevation *of the carriage* point the bore in that
 *    direction now, with the ship in the attitude it is in (`Cannon.solveAim`).
 * 4. Turning the gun there, at the rate two arms on a handspike can manage.
 * 5. Waiting. And it is step 5 that makes the combat feel like combat.
 *
 * ## One man, two hands, one job at a time
 *
 * **The measurement that motivated this section:** the Legend captain's interval between
 * shots was 1.533 s, and the *minimum* was exactly equal to the *median* — 1.533 s as
 * well. A gunner who never, in eighty shots, loses a tenth of a second is not a gunner:
 * he is a metronome. And that is what it felt like playing against him.
 *
 * The error was not a badly chosen number, it was an omission: the only cost in a firing
 * cycle was the time to ram the ball home, and it ran **in parallel** with the aiming and
 * with the recoil. The server loaded, laid and aimed all at once, with two arms he does
 * not have. Three things became serialized, which is how they happen on a shipboard gun
 * served by one man:
 *
 * - **The carriage runs back to its stop** before the gun accepts the charge. That lives
 *   in `Cannon.beginLoad` because it belongs to the gun, not to whoever serves it, and so
 *   it applies equally to the player.
 * - **He takes time to drop the handspike and fetch the next ball** (`servingTime`). It
 *   is the exact analogue of the player having to notice the shot and press reload.
 * - **He does not aim while ramming.** This is the one that changes the duel: when the
 *   service is over, the target has moved, and the gun — which traverses at 29°/s — has
 *   to find it again. A player maneuvering during the enemy's reload started costing *the
 *   enemy* dearly, which is what makes maneuvering worth it.
 *
 * The rhythm that comes out of this is irregular by construction, and it is the rhythm
 * the text above always promised: the enemy waits for the wave, and now it really waits.
 *
 * ## Why it waits, and what that produces for free
 *
 * Step 3's conversion is redone **on every physics step**, with the hull's attitude at
 * that instant. While the ship pitches and rolls, the angles that hit the target wander;
 * the gun, fixed to the deck, cannot follow. The shot only goes off when the two coincide
 * within `fireTolerance`.
 *
 * The emergent result is exactly what naval gunnery did: **you shoot at the top of the
 * roll**, when the enemy's side opens up. Nobody wrote that rule here — it falls out of
 * the geometry. And it is what gives the duel its rhythm: the enemy does not spit fire
 * continuously, it waits for the wave, and the player learns to read that beat.
 *
 * ## Where the human error comes in
 *
 * The bias is added **to the gun's angles**, after the ballistics, and it is drawn **once
 * per charge** — not per frame. Both choices matter:
 *
 * - On the angles, because it is the gunner's hand that misses, not the ball's physics.
 *   Error in the physics would give impossible trajectories; error in the aim gives a
 *   perfect shot delivered to the wrong place, which is what happens.
 * - Once per charge, because an error drawn per frame would become jitter: the gun would
 *   never converge and the firing condition would trigger by luck. Fixed per shot, the
 *   gunner *believes* in his aim, lays with confidence and misses with conviction — and
 *   two shots in a row miss to the same side, the way people miss.
 */

import * as THREE from 'three';
import { clamp, gaussian } from '../core/MathUtils';
import { dragFactor, solveIntercept } from '../combat/Ballistics';
import { BALL_MASS, BALL_RADIUS, MUZZLE_SPEED, type AimAngles } from '../ship/Cannon';
import type { Ship } from '../ship/Ship';
import type { DifficultyPreset } from './Difficulty';

/** The ball's drag factor. Constant — mass and radius do not change in flight. */
const DRAG_K = dragFactor(BALL_MASS, BALL_RADIUS);

/**
 * The gun's laying speed, in rad/s (~29°/s).
 *
 * It is not skill, it is iron: a half-ton carriage is levered around with a handspike,
 * and sweeping the whole arc (52°) takes close to two seconds. **The same for all three
 * captains**, on purpose — it is what guarantees a target crossing close aboard escapes
 * even the Legend's traverse, and that closing too far is tactics and not suicide.
 */
const AIM_RATE = 0.5;

/**
 * Fraction of the captain's reaction time the server spends dropping the handspike,
 * fetching the ball from the ready locker at the gun's foot and bringing it to the
 * muzzle.
 *
 * It comes from `reaction` instead of being a number of its own because it is the same
 * skill measured from another angle: whoever is slow to notice the situation has turned
 * is also slow to notice the gun has emptied. It gives 0.60 s to the Deckhand, 0.28 s to
 * the Corsair and 0.11 s to the Legend — the same range in which a player notices the
 * bang and gets a finger to the reload key.
 *
 * Half, and not the full value: reacting to a tactical plan is a decision, and reacting
 * to an empty gun is a reflex. Charging the same for both would leave the Deckhand with
 * 1.2 s of pause before *starting* to load, which on screen reads as a freeze and not as
 * a slow sailor.
 */
const SERVING_REACTION = 0.5;

/**
 * Half the extent the fire is spread over along the target, in meters.
 *
 * **This number used to be a crutch, and is not one anymore.** It was born to compensate
 * for a defect in the damage model: with breach merging at 90 cm and a fixed per-hole
 * inflow ceiling, concentrated fire was worth a fraction of swept fire, and a perfect
 * gunner who always aimed at the same point did **ten times less damage** than a mediocre
 * one whose errors spread the salvo. The AI got the sweeping doctrine and started playing
 * on the good side of that curve; the player, who had no way to know the curve existed,
 * stayed on the bad side.
 *
 * The defect was fixed where it lived — see `MERGE_DISTANCE` and `MAX_JET_SPEED` in
 * `ShipDamage`. Today one hit is worth one hit, wherever it lands, and this number
 * stopped being an advantage and became what it should always have been: **naval gunnery
 * doctrine, and nothing more.** You sweep the enemy's side because a hull holed in five
 * places sinks faster than one holed in a single place, and because the gun crew does not
 * know in advance which plank is going to give.
 *
 * ±3 m on a 16 m hull, and no longer ±5: without the wide merging to compensate, too wide
 * a spread only throws shot into the water half a ship's length away.
 */
const FIRE_SPREAD = 3;

/** What the gunner is trying to hit. */
export interface GunneryTarget {
  /** Center of the aim point, in the world. */
  readonly point: THREE.Vector3;
  /** The target's velocity, in the world. */
  readonly velocity: THREE.Vector3;
  /**
   * Direction of the target's bow, in the world. It is the axis the fire is spread
   * along — sweeping the side only makes sense along its length.
   */
  readonly forward: THREE.Vector3;
}

const _muzzle = new THREE.Vector3();
const _aim = new THREE.Vector3();
const _relative = new THREE.Vector3();
const _desiredWorld = new THREE.Vector3();
const _desiredLocal = new THREE.Vector3();

export class Gunner {
  /** Distance from the muzzle to the target on the last step, in meters. */
  range = Infinity;
  /** `true` when the gun can point at the target within its stops. */
  bearing = false;
  /** Shots this gun has fired in the match. Telemetry. */
  shots = 0;

  private readonly angles: AimAngles = { traverse: 0, elevation: 0, bears: false };
  /** The current charge's bias, in radians. See the human-error note at the top. */
  private biasTraverse = 0;
  private biasElevation = 0;
  /** Where along the target's length this charge will land, in meters. See `FIRE_SPREAD`. */
  private spread = 0;
  /**
   * Seconds the server has already spent fetching the next charge.
   *
   * It zeroes on leaving the gun: whoever leaves the station mid-gesture drops the ball
   * where it was, and whoever comes back starts over. Keeping the progress would give the
   * enemy a free head start on the reload every time it crossed the deck.
   */
  private serving = 0;

  constructor(
    private readonly ship: Ship,
    /** Index in `ship.cannons`. */
    private readonly index: number,
    private readonly preset: DifficultyPreset,
    private readonly random: () => number,
  ) {}

  /**
   * One step of gunnery.
   *
   * @param manned `false` when the sailor is at another post. An unmanned gun does not
   *   load, does not lay and does not fire — it stays where it was left, and that is why
   *   `Crew`'s crew allocation has tactical consequences.
   */
  fixedUpdate(dt: number, target: GunneryTarget | null, manned: boolean): void {
    const cannon = this.ship.cannons[this.index];
    if (!cannon) return;

    if (!manned || !target) {
      this.bearing = false;
      this.serving = 0;
      return;
    }

    // Serving the empty gun: first the time to drop the handspike and bring the ball,
    // then the load command. `Cannon` still waits for the carriage to settle before
    // letting the rammer in — see `beginLoad`. The next charge's bias is drawn here: one
    // shot, one error.
    if (cannon.state === 'empty') {
      this.serving += dt;
      if (
        this.serving >= this.preset.reaction * SERVING_REACTION &&
        this.ship.loadCannon(this.index)
      ) {
        this.serving = 0;
        this.biasTraverse = gaussian(this.random) * this.preset.aimSigma;
        this.biasElevation = gaussian(this.random) * this.preset.aimSigma;
        // Uniform, and not gaussian: sweeping the side means choosing a new point on
        // purpose, and a normal would concentrate the shots amidships — precisely what
        // this spread exists to avoid.
        this.spread = (this.random() * 2 - 1) * FIRE_SPREAD;
      }
    } else {
      this.serving = 0;
    }

    // This charge's aim point: the target's center shifted along its own bow.
    _aim.copy(target.point).addScaledVector(target.forward, this.spread);

    cannon.getMuzzleLocal(_muzzle);
    this.ship.body.localToWorld(_muzzle, _muzzle);
    this.range = _muzzle.distanceTo(_aim);

    // **Relative** velocity, as `solveIntercept` asks: the ball is already born with
    // the firing ship's velocity added in, so what is left to lead is how far the target
    // moves relative to us. `leadFraction` is how much of that reasoning the captain
    // manages — below 1, he shoots behind.
    _relative
      .subVectors(target.velocity, this.ship.body.velocity)
      .multiplyScalar(this.preset.leadFraction);

    const solution = solveIntercept(
      _muzzle,
      _aim,
      _relative,
      MUZZLE_SPEED,
      DRAG_K,
      this.preset.leadIterations,
    );

    if (!solution) {
      // Out of range even at maximum elevation: nothing to point at.
      this.bearing = false;
      return;
    }

    // Rebuilds the world direction from the solution's two angles. `solveIntercept`'s
    // azimuth is `atan2(x, z)`, so its horizontal is `(sin, cos)` — a different
    // convention from `heading`'s, and swapping the two here mirrors the shot to the
    // other side.
    const cosElevation = Math.cos(solution.elevation);
    _desiredWorld.set(
      Math.sin(solution.azimuth) * cosElevation,
      Math.sin(solution.elevation),
      Math.cos(solution.azimuth) * cosElevation,
    );

    // And here the hull's attitude enters the arithmetic, for free.
    this.ship.body.worldDirToLocal(_desiredWorld, _desiredLocal);
    cannon.solveAim(_desiredLocal, this.angles);
    this.bearing = this.angles.bears;

    const wantTraverse = this.angles.traverse + this.biasTraverse;
    const wantElevation = this.angles.elevation + this.biasElevation;

    // **The gun is only laid by somebody with free hands.** While the carriage runs
    // back and the ball is rammed home, the server follows the target with his eye and
    // not with the handspike; the gun stays where the previous shot left it. This is
    // where the enemy's irregular rhythm comes from — and this is where the reward for
    // maneuvering during its reload comes from. See the note at the top.
    if (!cannon.isLoaded) return;

    // Turns the gun at the iron's pace. `aim` already clamps at the stops, so asking
    // beyond them rests the carriage against the limit instead of raising an error —
    // which is what a real gun does when the target leaves the arc.
    const step = AIM_RATE * dt;
    cannon.aim(
      clamp(wantTraverse - cannon.traverse, -step, step),
      clamp(wantElevation - cannon.elevation, -step, step),
    );

    // Fire discipline: shot is finite, and a long shot is a ball in the sea. It is the
    // only place `engageRange` acts, and it is what makes the Deckhand let the player
    // close while the Legend is already firing.
    if (this.range > this.preset.engageRange) return;
    if (!this.angles.bears) return;

    const tolerance = this.preset.fireTolerance;
    if (Math.abs(cannon.traverse - wantTraverse) > tolerance) return;
    if (Math.abs(cannon.elevation - wantElevation) > tolerance) return;

    cannon.triggerPull();
    this.shots++;
  }

  /** Zeroes the telemetry for a fresh match. */
  reset(): void {
    this.range = Infinity;
    this.bearing = false;
    this.shots = 0;
    this.biasTraverse = 0;
    this.biasElevation = 0;
    this.serving = 0;
  }
}
