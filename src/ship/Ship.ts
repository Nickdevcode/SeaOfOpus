/**
 * The complete Sloop: the 3D model, the rigid body and every subsystem.
 *
 * This class does no physics at all — it **composes**. Each subsystem knows how to
 * apply one family of forces to the body and nothing else, and all that is defined here
 * is the order they speak in. Whoever wants an enemy ship instantiates another `Ship`;
 * whoever wants to change the sail model swaps `SailSim` without touching the rest.
 *
 * The separation between `fixedUpdate` and `syncModel` is the one that matters: the
 * physics runs at a fixed 60 Hz and the render runs at the monitor's rate, so `Engine`'s
 * `alpha` interpolates between the previous step and the current one. Without it the
 * ship visibly shakes on 144 Hz screens, and no amount of camera smoothing hides that.
 */

import * as THREE from 'three';
import { GRAVITY, msToKnots } from '../core/MathUtils';
import { Anchor } from './Anchor';
import { Buoyancy } from './Buoyancy';
import { Cannon, type FireSolution } from './Cannon';
import { EnsignSim } from './EnsignSim';
import { HullDrag } from './HullDrag';
import { MAX_WHEEL, Rudder } from './Rudder';
import { SailSim } from './SailSim';
import { ShipBody } from './ShipBody';
import { ShipDamage, type Breach } from './ShipDamage';
import { createShip, type ShipAssets, type ShipModel, type ShipOptions } from './ShipBuilder';
import type { WaveField } from '../world/WaveField';

/**
 * Center of mass, in local coordinates. **Both values are measured, not chosen** — see
 * the `__game` bench in `main.ts`.
 *
 * The `z` matches this hull's center of buoyancy (+0.91 m, measured from the torque the
 * buoyancy produces with the ship upright). It is what a builder really does when
 * distributing the ballast: marrying the center of gravity to the center of buoyancy so
 * the ship floats without falling by the head or by the stern.
 *
 * The `y` is the height, and it is what decides whether the ship is stiff or tender.
 * With the center of mass at the waterline this hull gives GM ≈ 0.54 m, far too tender
 * — it would roll with a 5.3 s period, slow and sickening. Lowering the ballast to
 * −0.55 m takes the GM up to ~0.89 m and the period down to ~4.2 s, which is the short,
 * lively roll of a 16 m boat.
 */
const CENTER_OF_MASS = new THREE.Vector3(0, -0.55, 0.91);

/**
 * Cannonballs the magazine carries at the start of the match.
 *
 * **160, and the number exists in order never to be reached in an honest duel.** This
 * is this field's third tuning, and the first two missed for the same reason: they
 * treated the magazine as a balancing knob. It is not one. A duel has to be decided by
 * who maneuvers and aims better — if it ends because one of the two ran out of shot,
 * what the match measured was the magazine's bookkeeping, and not the fight.
 *
 * At 40, the Legend captain spent everything on a stationary target and left it at 59%
 * of hold. At 80, it sank that target — but with the gun's service coming to cost 2.4 s
 * per shot (see `Cannon.beginLoad` and `Gunner`), 80 became too few again: the telemetry
 * shows the magazine emptying at 240 s with the target at 74%. The limit was deciding
 * the match again, and in the worst way — by the clock.
 *
 * 160 gives the Legend close to seven minutes of uninterrupted fire, and a duel is not
 * uninterrupted: it spends much of it closing distance, repairing or breaking contact.
 * For the player, who fires at a far more relaxed rhythm, it gives a quarter of an hour.
 *
 * **The ceiling still exists, and it still has a job.** Wild shooting at 150 m costs
 * shot, and the magazine is the only thing that charges for it. What it stopped being is
 * what ends the fight — which is also what we want for the online duel, where two human
 * players consume ammunition far more slowly than a bot.
 */
export const MAGAZINE_SIZE = 160;

/**
 * Planks the magazine carries at the start of the match.
 *
 * **48, and the number comes from the magazine on the other side.** It is the same idea
 * as the cannonballs — a finite resource that makes wild shooting and wild repairing
 * cost something — except the arithmetic for how many has to be done against what the
 * enemy can open, and not copied from there.
 *
 * The enemy's 160 balls buy about 40 breaches (not every ball hits, and the ones that
 * strike above the waterline do not flood). A fresh shot on top of a plank **tears the
 * plank off** and gives the breach back, so some parts of the hull are paid for twice.
 * Forty-eight covers the normal case's breaches and still leaves room for a dozen torn
 * patches — enough never to lose a duel to bookkeeping, and few enough that patching a
 * bulwark breach that does not flood stops being free.
 *
 * The same value as the cannonballs was considered and does not work: with 160 planks
 * the magazine never empties, the counter never bites, and the only thing the feature
 * delivers is a number on screen. A limit that does not limit is worse than no limit,
 * because it costs the player's attention without charging them anything.
 */
export const PLANK_LOCKER_SIZE = 48;

/**
 * Radii of gyration, in meters.
 *
 * Pitch and yaw use 0.26 of the length and roll 0.39 of the beam — naval architecture's
 * rules of thumb. The small roll radius is what makes the sloop roll fast and short on
 * the waves instead of swaying like a big ship.
 */
const GYRATION = new THREE.Vector3(4.16, 4.16, 1.95);

/**
 * Added mass per local axis.
 *
 * Sway and heave push a wall of water ahead of them and nearly double the effective
 * mass; surge barely reaches 5% because the hull is fine in exactly that direction. See
 * the long explanation in `ShipBody`.
 */
const ADDED_MASS = new THREE.Vector3(1.9, 2.0, 1.06);

/** What flies the ship. The player and the AI fill in the same structure. */
export interface ShipControls {
  /** Rate of turn of the wheel: -1 hard to port, +1 hard to starboard. */
  wheel: number;
  /**
   * Turns of the bar pushed on the capstan this step, as a fraction of a turn.
   *
   * A number, and not a flag, because weighing the anchor stopped being a held button:
   * whoever hauls **walks** around the capstan, and what arrives here is how far they
   * walked. See `Anchor.heave`.
   */
  capstanTurns: number;
  /** `true` while somebody is on the bilge pump's handle. */
  pumping: boolean;
}

const _origin = new THREE.Vector3();
const _rotation = new THREE.Quaternion();
const _localVelocity = new THREE.Vector3();
const _euler = new THREE.Euler();
const UP = new THREE.Vector3(0, 1, 0);

export class Ship {
  /** The ship's name. It is the same `owner` its shots carry. */
  readonly name: string;
  readonly model: ShipModel;
  readonly body: ShipBody;
  readonly buoyancy: Buoyancy;
  readonly hullDrag: HullDrag;
  readonly rudder: Rudder;
  readonly sail: SailSim;
  /** The masthead ensign. It applies no force — it is a wind reading for whoever looks. */
  readonly ensign: EnsignSim;
  readonly anchor: Anchor;
  readonly damage: ShipDamage;
  /** `[0]` starboard, `[1]` port — the same order as the model. */
  readonly cannons: readonly Cannon[];

  readonly controls: ShipControls = { wheel: 0, capstanTurns: 0, pumping: false };

  /**
   * Cannonballs in the magazine. Loading a cannon consumes one.
   *
   * It does not resupply: what the ship carries is for the whole match, and it is what
   * keeps the two sides from settling the duel by volume of fire. With the ~2.4 s a
   * gun's full service costs, it is enough for over six minutes of uninterrupted fire —
   * enough slack never to be what decides, and enough of a ceiling for wild shooting to
   * cost. See `MAGAZINE_SIZE`.
   */
  cannonballs = MAGAZINE_SIZE;

  /**
   * Planks in the magazine. Closing a breach consumes one.
   *
   * Like the cannonballs, it does not resupply: what the ship carries is what it has
   * for the whole match. It is what gives weight to the choice of **which** breach to
   * patch when the hull is holed in five places and three of them are above the
   * waterline.
   */
  planks = PLANK_LOCKER_SIZE;

  /**
   * Shots fired this step, waiting for somebody to turn them into projectiles.
   * Whoever consumes them empties the queue — the ship keeps no history.
   */
  readonly pendingShots: FireSolution[] = [];

  /** Fraction of the design volume submerged. 1 is the drawn draft. */
  submersion = 1;

  /** Weight, constant. Kept ready so it is not recomputed 60 times a second. */
  private readonly weight = new THREE.Vector3();

  constructor(assets: ShipAssets, name = 'ship', options: ShipOptions = {}) {
    this.name = name;
    this.model = createShip(assets, name, options);

    this.buoyancy = new Buoyancy();
    this.body = new ShipBody({
      // The mass comes from the same table that generates the buoyancy — see
      // `getDesignMass`.
      mass: this.buoyancy.getDesignMass(),
      centerOfMass: CENTER_OF_MASS,
      gyration: GYRATION,
      addedMass: ADDED_MASS,
    });

    this.hullDrag = new HullDrag();
    this.rudder = new Rudder();
    this.sail = new SailSim(this.model.sail);
    this.ensign = new EnsignSim(this.model.ensign);
    this.anchor = new Anchor(this.model);
    this.damage = new ShipDamage();
    this.cannons = this.model.cannons.map((assembly) => new Cannon(assembly, name));

    this.weight.set(0, -this.body.mass * GRAVITY, 0);
  }

  /**
   * Orders a ball rammed home in this cannon. Returns `false` if the magazine is empty
   * or the gun already has a charge — the caller uses that for the audio feedback.
   */
  loadCannon(index: number): boolean {
    const cannon = this.cannons[index];
    if (!cannon || this.cannonballs <= 0) return false;
    if (!cannon.beginLoad()) return false;
    this.cannonballs--;
    return true;
  }

  /** `true` while there is still a plank in the magazine to nail. */
  get hasPlanks(): boolean {
    return this.planks > 0;
  }

  /**
   * Nails a plank over a breach for `dt` seconds. Returns `true` **on the frame the
   * breach closes**, which is when the plank leaves the magazine.
   *
   * The consumption happens at the end, and not at the start, for two reasons. The fair
   * one: whoever releases the button mid-work does not lose the piece, and the partial
   * progress `ShipDamage` keeps still counts for the next attempt. The practical one:
   * the repair is interrupted constantly — by the wave, by the incoming shot, by the
   * pump that needs somebody — and charging up front would turn every interruption into
   * a fine.
   *
   * It lives here, and not in `ShipDamage`, because the magazine belongs to the ship and
   * not to the damage: `ShipDamage` answers for breaches, flooding and inflow, and has
   * no business knowing about logistics. It is the same design as `loadCannon` — the
   * subsystem does the work, the ship decides whether there is material for it.
   */
  patchBreach(breach: Breach, dt: number): boolean {
    if (!this.hasPlanks) return false;
    if (!this.damage.repair(breach, dt)) return false;
    this.planks--;
    return true;
  }

  /** Speed over the ground, in knots. */
  get knots(): number {
    return msToKnots(this.body.velocity.length());
  }

  /** Surge in the ship's frame, in m/s. Negative is going astern. */
  get surge(): number {
    this.body.worldDirToLocal(this.body.velocity, _localVelocity);
    return -_localVelocity.z;
  }

  /** Heading in radians, 0 = world -Z. It is where the bow points. */
  get heading(): number {
    _euler.setFromQuaternion(this.body.orientation, 'YXZ');
    return _euler.y;
  }

  /** Position of the wheel, -1 to +1. The HUD draws from this. */
  get wheelPosition(): number {
    return this.rudder.wheelAngle / MAX_WHEEL;
  }

  /**
   * Puts the ship in the water. `heading` in radians, measured as `Ship.heading`.
   *
   * The height comes from the wave at that point, and not from `y = 0`: being born at
   * the right draft but inside a trough would make the ship bounce on the first step.
   */
  spawn(x: number, z: number, heading: number, waves: WaveField): void {
    this.body.velocity.set(0, 0, 0);
    this.body.angularVelocity.set(0, 0, 0);
    this.body.orientation.setFromAxisAngle(UP, heading);
    this.body.previousOrientation.copy(this.body.orientation);
    this.body.setOrigin(x, waves.sampleHeight(x, z), z);

    this.rudder.center();
    this.anchor.reset();
    this.sail.reset();
    this.ensign.reset();
    this.damage.reset();
    this.body.floodedMass = 0;
    this.submersion = 1;
    this.cannonballs = MAGAZINE_SIZE;
    this.planks = PLANK_LOCKER_SIZE;
    for (const cannon of this.cannons) cannon.reset();
    this.pendingShots.length = 0;
    this.controls.wheel = 0;
    this.controls.capstanTurns = 0;
    this.controls.pumping = false;

    this.syncModel(1);
  }

  /**
   * One physics step. The order is deliberate: the commands first, then the forces
   * (which only accumulate), and the integration last — that way everything acting on
   * this step sees exactly the same state, with no subsystem picking up the velocity the
   * previous one has just changed.
   */
  /**
   * Saves the moving parts' pose before anybody touches them on this step.
   *
   * It runs at the top of `Match.fixedUpdate`, **before** the sailors, because it is the
   * sailor (or the machine's gunner) who aims and who turns the wheel — leaving the
   * capture to `fixedUpdate` would give a "previous" pose that has already changed. See
   * `Cannon.beginStep`.
   */
  beginStep(): void {
    this.rudder.beginStep();
    for (const cannon of this.cannons) cannon.beginStep();
  }

  /**
   * The ship's step on the side that does **not** simulate.
   *
   * ⚠️ **Without this, the wheel does not turn — and that was the most insistent
   * complaint from the first networked duel: "I cannot control the boat".** The
   * command's path has three stages, and only two ran on the client: the sailor takes
   * the station (runs), the sailor writes `controls.wheel` (runs), and **somebody has to
   * integrate that command into a wheel angle** — which is the first line of
   * `fixedUpdate`, and `fixedUpdate` is the simulating side's path. The command was
   * written and erased on the next step without ever becoming movement.
   *
   * The effect was worse than "the wheel does not move": the ship **did turn**, because
   * the host received the command and turned the rudder over there. But on this side the
   * wheel stood still, the sailor's hands stood still (their pose is indexed by the
   * wheel's angle) and the panel said `wheel 0%`. Every bit of immediate feedback that
   * exists for the player to believe they are in command was switched off, and the only
   * signal left was the hull starting to yaw seconds later — which is exactly what reads
   * as "it did not respond".
   *
   * What runs here is only what the client **predicts** or **animates**: the rudder, the
   * capstan, the sail and the ensign. No buoyancy, drag, contact or flooding — those
   * things arrive ready in the snapshot, and simulating them here would open a second
   * truth about the same hull.
   */
  fixedUpdateRemote(dt: number, waves: WaveField): void {
    // Pure integration of a clamped command: the host reaches the same angle with the
    // same input, and that is what makes the rudder's prediction correct instead of
    // optimistic.
    this.rudder.update(this.controls.wheel, dt);
    if (this.controls.capstanTurns > 0) this.anchor.heave(this.controls.capstanTurns);

    // Canvas: the sail and the ensign read the pose and the wind the network wrote.
    // The sail pushes the hull as it passes, and that force goes nowhere here — see
    // `ShipBody.clearForces`.
    this.sail.update(dt, this.body, waves);
    this.ensign.update(dt, this.sail.localWind);
    this.body.clearForces();
  }

  fixedUpdate(dt: number, waves: WaveField): void {
    this.rudder.update(this.controls.wheel, dt);
    if (this.controls.capstanTurns > 0) this.anchor.heave(this.controls.capstanTurns);

    // Gravity first, so the buoyancy has something to work against.
    this.body.applyForce(this.weight);

    const report = this.buoyancy.apply(this.body, waves);
    this.submersion = report.submersion;

    this.hullDrag.apply(this.body, this.submersion);
    this.rudder.apply(this.body, this.submersion);
    this.sail.update(dt, this.body, waves);
    // After the sail, and reading the wind it has just measured: the ensign applies no
    // force at all, but it has to tell the same story about the wind.
    this.ensign.update(dt, this.sail.localWind);
    this.anchor.fixedUpdate(dt, this.body);
    // The command is per *frame* and the flooding runs per *step*: passing it on here
    // is what guarantees the pump takes out the same amount of water at 30 or 144 fps.
    this.damage.pumping = this.controls.pumping;
    this.damage.fixedUpdate(dt, this.body, waves);

    // The cannons come in before the integration because the recoil is force like any
    // other: whoever fires on this step pushes the hull on this step.
    for (const cannon of this.cannons) {
      const shot = cannon.fixedUpdate(dt, this.body);
      if (shot) this.pendingShots.push(shot);
    }

    this.body.integrate(dt);
  }

  /** Writes the interpolated pose and the moving parts' into the 3D model. */
  syncModel(alpha: number): void {
    this.body.sampleOrigin(alpha, _origin, _rotation);
    this.model.root.position.copy(_origin);
    this.model.root.quaternion.copy(_rotation);

    // The wheel turns about its own Z; the negative sign is what makes "turning right"
    // clockwise from the point of view of whoever is at the helm.
    const { previousWheelAngle, wheelAngle, previousRudderAngle, rudderAngle } = this.rudder;
    this.model.wheel.rotation.z =
      -(previousWheelAngle + (wheelAngle - previousWheelAngle) * alpha);
    // The blade follows the rudder directly: a trailing edge to starboard deflects
    // water to starboard, pushes the stern to port and the bow goes to starboard. It
    // was negative here, which drew the blade pointing to the opposite side of the turn
    // — wrong to the eye of somebody who knows how to look, and invisible to everyone
    // else.
    this.model.rudder.rotation.y =
      previousRudderAngle + (rudderAngle - previousRudderAngle) * alpha;

    for (const cannon of this.cannons) cannon.syncModel(alpha);
    this.anchor.syncModel(this.model, this.body);
  }

  dispose(): void {
    this.model.dispose();
  }
}
