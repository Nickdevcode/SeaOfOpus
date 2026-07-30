/**
 * Anchor and capstan.
 *
 * There is no seabed in this game — the combat happens in open water — so "anchoring"
 * here means **fixing a point in the world** and tying the bow to it with an elastic
 * rode. It is the same abstraction as Sea of Thieves, where the anchor bites anywhere,
 * and it is what makes the maneuver that matters possible.
 *
 * The behavior that justifies the whole implementation is the **anchor turn**: with
 * the rode taut pulling on the hawse, the ship stops turning about its own center and
 * starts turning about the bow. The radius collapses and the sloop turns almost on the
 * spot — the game's classic PvP maneuver. Note there is not a line of code for it: it
 * falls out of the lever arm between the hawse and the center of mass.
 *
 * ## The maneuver's two halves do not look alike, and that is on purpose
 *
 * **Dropping is a gesture.** You release the pawl, the rode runs out on its own and
 * the capstan spins free until the anchor hits the bottom. One tap, and the rest is
 * gravity working — whoever drops the anchor does nothing more.
 *
 * **Weighing is work.** There is no button that raises the anchor: you have to take
 * the capstan and **walk around it**, pushing the bars forward, turn after turn. The
 * capstan turns by however far the sailor walked, not one degree more, and stopping
 * walking is stopping hauling. That is why the anchor decides fights in Sea of
 * Thieves: dropping costs half a second and undoing it costs eleven.
 *
 * See `PlayerController.pushCapstan`, which is where walking becomes turns of the bar.
 */

import * as THREE from 'three';
import { TAU } from '../core/MathUtils';
import type { ShipBody } from './ShipBody';
import type { ShipModel } from './ShipBuilder';

export type AnchorState = 'stowed' | 'dropping' | 'set' | 'raising';

/** Depth the anchor bites at, below the design waterline. */
const SEABED_DEPTH = 11;
/**
 * Length of the rode.
 *
 * A little longer than the depth, and not much: the slack becomes the radius of free
 * drift before the rode goes taut (here ~2.3 m). Too much slack and the anchor becomes
 * a lazy brake instead of a pivot.
 */
const CHAIN_LENGTH = 11.7;

/** Stiffness of the rode, in N/m. */
const CHAIN_STIFFNESS = 165_000;
/**
 * Damping of the rode, in N·s/m.
 *
 * High enough for the ship to **stop**, and not to bounce. At 60,000 the sloop
 * stretched the rode, was thrown back and spent several seconds swinging around the
 * anchor — what you saw was a rubber boat. At 130,000 the system is slightly
 * underdamped: one snub is left, the bow falls toward the anchor and it settles. It is
 * what you see when a real boat anchors.
 */
const CHAIN_DAMPING = 130_000;
/** Tension ceiling. It only exists so a bad step does not become a catapult. */
const MAX_TENSION = 420_000;

/**
 * Drag of the anchor dragging along the bottom, in N·s/m.
 *
 * It acts while the anchor is on the bottom and the ship still has way on, **before**
 * the rode goes taut. Without it the ship runs the two meters of slack at full speed
 * and only finds out it has anchored when the chain snaps tight all at once — a dry
 * jolt that reads as a bug. With it, dropping the anchor while moving brakes the ship
 * progressively, which is what the fluke biting the bottom really does.
 */
const DRAG_COEFFICIENT = 9_000;

/** Fraction of the rode that runs out per second while dropping. */
const DROP_RATE = 1.6;

/**
 * How long the capstan holds on its own after the sailor stops walking.
 *
 * It is not zero, and it is not infinite, and both ends would be wrong. Zero would
 * punish a stumbled stride: one frame of hesitation mid-turn would throw the whole
 * anchor back to the bottom. Infinite — which was the previous behavior — turned
 * weighing the anchor into a task you do in installments, and takes away from anchoring
 * exactly what makes it tactical: **dropping is cheap and undoing it is expensive, and
 * expensive without interruption**. Nine tenths is the time to get around the bar and
 * take the next one — it went up along with the sailor's heavier stride, or the
 * crossing between two bars would itself count as having left the job.
 */
const CAPSTAN_GRACE = 0.9;
/**
 * Fraction of the rode that runs back out per second when the sailor lets go.
 *
 * Slower than `DROP_RATE`'s free fall on purpose: the pawl did not release, what gives
 * is the man. There is time to get back to the bar and resume — what is lost is the
 * work, not the match.
 *
 * It dropped from 0.85 when the turn got slower, and it is a matter of proportion: with
 * the job at eleven seconds, a rate that gave the whole rode back in a little over a
 * second turned any hesitation into starting from scratch. At 0.45 it is 2.2 s from top
 * to bottom — a punishment you feel, and still recoverable for whoever returns to the
 * bar.
 */
const RUNBACK_RATE = 0.45;
/**
 * Turns the capstan makes to haul in the whole rode.
 *
 * Three, and the number comes from the clock: the sailor walks at 1.75 m/s on a bar
 * radius of 1.05 m, which gives a little over a quarter turn per second — **eleven
 * seconds** to weigh the anchor alone, without stopping.
 *
 * It was two turns at 2.2 m/s, or six seconds, and six seconds is far too cheap for
 * what anchoring does: the anchor decides fights in Sea of Thieves precisely because
 * undoing it occupies a whole man for a length of time the opponent feels pass. Half a
 * second to drop against eleven to weigh is the asymmetry that gives the decision to
 * drop the anchor its weight.
 */
const CAPSTAN_TURNS = 3;
/** Turns per second of the capstan spinning free while the rode runs out. */
const FREEWHEEL_TURNS = 2.6;

const _hawseWorld = new THREE.Vector3();
const _chain = new THREE.Vector3();
const _direction = new THREE.Vector3();
const _arm = new THREE.Vector3();
const _pointVelocity = new THREE.Vector3();
const _force = new THREE.Vector3();
const _inverse = new THREE.Quaternion();
const _drag = new THREE.Vector3();

export class Anchor {
  state: AnchorState = 'stowed';
  /** 0 = home at the cathead, 1 = on the bottom. */
  deploy = 0;
  /** The rode's tension on the last step, in newtons. The HUD and the audio read it. */
  tension = 0;

  /** The fixed world point where the anchor bit. Only valid with `deploy > 0`. */
  readonly worldPoint = new THREE.Vector3();

  /** The anchor's stowed position on the ship — where it leaves from and returns to. */
  private readonly stowed = new THREE.Vector3();
  private readonly stowedRotation = new THREE.Euler();
  /** Hawse: where the rode passes through and where the tension is applied. */
  private readonly hawse = new THREE.Vector3();
  private capstanAngle = 0;
  /** Turns of the bar asked for on this step, as a fraction of a turn. */
  private heaveTurns = 0;
  /** Seconds since the last bar was pushed. See `CAPSTAN_GRACE`. */
  private idleTime = 0;

  constructor(model: ShipModel) {
    // The stowed pose is the one `ShipBuilder` drew. Reading from it, instead of
    // repeating the coordinates here, is what keeps the anchor from returning to a
    // place that is not the cathead the day the bow changes shape.
    this.stowed.copy(model.anchor.position);
    this.stowedRotation.copy(model.anchor.rotation);
    this.hawse.set(0, this.stowed.y - 0.25, this.stowed.z - 0.3);
  }

  /** `true` when the rode may already be applying force. */
  get isDeployed(): boolean {
    return this.deploy > 0.001;
  }

  /** How much of the rode has been hauled in, from 0 (on the bottom) to 1 (home). */
  get raised(): number {
    return 1 - this.deploy;
  }

  /** Drops the anchor. No effect if it is already out. */
  drop(body: ShipBody): void {
    if (this.state !== 'stowed') return;
    this.state = 'dropping';
    body.localToWorld(this.hawse, _hawseWorld);
    // It bites plumb below the hawse: it is where the anchor would fall, and it is
    // what makes the ship turn about its own bow instead of about some arbitrary
    // point.
    this.worldPoint.set(_hawseWorld.x, -SEABED_DEPTH, _hawseWorld.z);
  }

  /**
   * Pushes the capstan bars.
   *
   * @param turns fraction of a turn pushed on this step. It comes from how far the
   *   player **walked** around the capstan, not from a held button: it is the
   *   difference between weighing the anchor and asking for it to be weighed.
   */
  heave(turns: number): void {
    if (this.state === 'stowed' || this.state === 'dropping') return;
    this.state = 'raising';
    this.heaveTurns += Math.max(turns, 0);
    this.idleTime = 0;
  }

  fixedUpdate(dt: number, body: ShipBody): void {
    switch (this.state) {
      case 'dropping':
        this.deploy = Math.min(this.deploy + DROP_RATE * dt, 1);
        // The capstan spins free while the rode runs out: nobody is holding it, and
        // it is that loose spin that tells the player the anchor is falling.
        this.capstanAngle -= FREEWHEEL_TURNS * TAU * dt;
        if (this.deploy >= 1) this.state = 'set';
        break;

      case 'raising': {
        const recovered = this.heaveTurns / CAPSTAN_TURNS;
        this.deploy = Math.max(this.deploy - recovered, 0);
        this.capstanAngle += this.heaveTurns * TAU;
        if (this.deploy <= 0) this.state = 'stowed';

        // **Letting go of the bar is losing what you gained.**
        //
        // The progress used to freeze: you could weigh 30% of the anchor, let go, go
        // pump the hold, come back and carry on from where you stopped. That erases
        // anchoring's cost, which is the whole thing — in Sea of Thieves the anchor
        // decides fights precisely because weighing it occupies a man from start to
        // finish, and releasing the capstan sends the chain back to the bottom.
        //
        // The half-second grace is what separates "let go" from "stumbled a step".
        if (this.heaveTurns <= 0 && this.deploy > 0) {
          this.idleTime += dt;
          if (this.idleTime > CAPSTAN_GRACE) {
            this.deploy = Math.min(this.deploy + RUNBACK_RATE * dt, 1);
            // Turning backwards, which is the sign that the rode is running out.
            this.capstanAngle -= RUNBACK_RATE * TAU * dt * CAPSTAN_TURNS;
            if (this.deploy >= 1) this.state = 'set';
          }
        } else {
          this.idleTime = 0;
        }

        // Zeroed every step: whoever wants to keep hauling has to keep walking.
        // Without this the capstan would turn on its own to the end.
        this.heaveTurns = 0;
        break;
      }

      default:
        break;
    }

    this.applyTension(body);
  }

  private applyTension(body: ShipBody): void {
    this.tension = 0;
    if (!this.isDeployed) return;

    body.localToWorld(this.hawse, _hawseWorld);
    _arm.subVectors(_hawseWorld, body.comPosition);
    body.pointVelocity(_arm, _pointVelocity);

    // Friction of the anchor on the bottom. It applies even with the rode slack — it
    // is what makes dropping the anchor while moving brake the ship instead of doing
    // nothing until the chain snaps tight.
    _drag.copy(_pointVelocity).multiplyScalar(-DRAG_COEFFICIENT * this.deploy);
    _drag.y = 0;
    body.applyForceAtPoint(_drag, _hawseWorld);

    _chain.subVectors(this.worldPoint, _hawseWorld);
    const distance = _chain.length();
    if (distance <= CHAIN_LENGTH || distance < 1e-4) return;

    _direction.copy(_chain).divideScalar(distance);

    // Spring + damper along the rode. The `max` is what guarantees a chain pulls and
    // never pushes; the `deploy` factor is the anchor still falling (or already
    // leaving the bottom), which holds in proportion to how much it has bitten — and
    // that is why the ship starts moving again before the anchor is home.
    const stretch = distance - CHAIN_LENGTH;
    const closing = _pointVelocity.dot(_direction);
    const pull = (CHAIN_STIFFNESS * stretch - CHAIN_DAMPING * closing) * this.deploy;
    this.tension = Math.min(Math.max(pull, 0), MAX_TENSION);
    if (this.tension <= 0) return;

    _force.copy(_direction).multiplyScalar(this.tension);
    body.applyForceAtPoint(_force, _hawseWorld);
  }

  /** Puts the anchor and the capstan where the physics says they are. */
  syncModel(model: ShipModel, body: ShipBody): void {
    model.capstan.rotation.y = this.capstanAngle;

    if (!this.isDeployed) {
      model.anchor.position.copy(this.stowed);
      model.anchor.rotation.copy(this.stowedRotation);
      return;
    }

    // The anchor is still a child of the ship, but it is drawn at the world point
    // where it bit: converting into the local frame every frame costs one matrix and
    // avoids reparenting an object mid-game, which is a guaranteed source of disposal
    // bugs. The inverse rotation keeps it upright while the hull rolls around it.
    _inverse.copy(body.orientation).invert();
    model.anchor.position
      .subVectors(this.worldPoint, body.comPosition)
      .applyQuaternion(_inverse)
      .add(body.centerOfMass);

    // And from there it **climbs the rode**, in proportion to what has been hauled in.
    //
    // Without this line the anchor stayed stuck on the bottom until the last degree of
    // bar and only then appeared back at the cathead, from one frame to the next. The
    // player pushed the capstan for minutes on end without seeing anything happen —
    // and now that letting go of the bar sends the rode back to the bottom, watching
    // the anchor rise and fall is the only direct reading of what their work is
    // yielding. The interpolation is toward the stowed pose, and not toward the hawse,
    // so that reaching zero coincides exactly with the anchor back at the cathead, with
    // no jump on the state change.
    model.anchor.position.lerp(this.stowed, 1 - this.deploy);
    model.anchor.quaternion.copy(_inverse);
  }

  /** Hauls everything in at once, with no cranking — a match restart. */
  reset(): void {
    this.state = 'stowed';
    this.deploy = 0;
    this.tension = 0;
    this.heaveTurns = 0;
    this.idleTime = 0;
    this.capstanAngle = 0;
  }
}
