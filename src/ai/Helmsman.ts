/**
 * The bot helmsman: holds a commanded heading by turning the same wheel the player
 * does.
 *
 * **The problem is not trivial, and it is worth saying why.** The Sloop's wheel is not
 * a steering wheel: `Rudder`'s input is a *rate of turn*, and the angle is state that
 * stays where it was left (see `Rudder.ts`). Wiring a controller straight from the
 * heading error into the wheel's input creates two integrators in series — the wheel
 * integrates the command and the hull integrates the yaw. A second-order system with
 * pure gain oscillates *always*, and the ship would go weaving all over its heading.
 *
 * The way out is the one real autopilots use, and it is a cascaded loop:
 *
 * 1. **Outside**, a PD over the heading error decides a **wheel angle** — not a rate.
 *    It is the "half a turn to port" a human helmsman hears and executes.
 * 2. **Inside**, the wheel is taken to that angle as fast as the stop allows. One
 *    calculation, with no gain to tune.
 *
 * With the wheel becoming a commanded position, the only integrator left is the hull,
 * and a PD stabilizes that without drama.
 *
 * **Why not `MathUtils`'s `PID` class.** It differentiates the error numerically, and
 * the heading's derivative is precisely the quantity the rigid body *already measures*:
 * `angularVelocity.y`. Differentiating a signal you have exactly is trading precision
 * for noise for free. The integral term stays out too: the only permanent offset is the
 * ~0.08°/s of lee helm `SailSim` documents, and the proportional term holds it under 1°
 * of heading error. Less code, and no risk of windup leaving the wheel stuck against
 * the stop.
 *
 * ## The sign, which is where you go wrong
 *
 * `heading` is rotation about **+Y**, and rotating in +Y takes the bow (−Z) toward −X,
 * which is **port**. So an increasing heading is yawing to the left, and a positive
 * wheel command (starboard, by `Rudder`) makes the heading **decrease**. Every sign in
 * here comes from that, and flipping one of them makes the ship run from its heading
 * instead of seeking it — turning faster and faster, because the feedback becomes
 * positive.
 */

import { WHEEL_RATE, MAX_WHEEL } from '../ship/Rudder';
import { angleDelta, clamp } from '../core/MathUtils';
import type { Ship } from '../ship/Ship';

/**
 * Proportional gain: radians of wheel per radian of heading error.
 *
 * 8 puts the wheel against the stop (π) at 22° of error. Above that the ship is
 * already doing everything the rudder gives, so a higher gain would not turn any
 * faster — it would only delay the exit from the turn.
 */
const HELM_KP = 8;

/**
 * Derivative gain: radians of wheel per rad/s of yaw.
 *
 * It is the turn's brake. In a hard turn the Sloop rotates at ~0.13 rad/s, which here
 * is worth 1.4 rad of opposite wheel — enough for it to reach the heading and stop,
 * instead of overshooting and coming back. At 6 the ship skids some 8° past the
 * heading on every large correction; at 20 it gets lazy and never closes a tight turn
 * in combat time.
 */
const HELM_KD = 11;

/**
 * Heading error below which the helmsman considers the ship "on course".
 *
 * 4°. It serves the captain, not the control loop: it is what decides whether you can
 * already open fire or are still closing the maneuver.
 */
const ON_COURSE = 0.07;

export class Helmsman {
  /** Commanded heading, in radians, in the same measure as `Ship.heading`. */
  course = 0;

  /** Last step's heading error, in radians. Telemetry and tactical decisions. */
  error = 0;

  /** The wheel angle the helmsman is asking for. Telemetry only. */
  commandedWheel = 0;

  /** `true` when the bow is practically on the requested heading. */
  get onCourse(): boolean {
    return Math.abs(this.error) < ON_COURSE;
  }

  /** The same heading command, given as a direction to follow. */
  setCourse(heading: number): void {
    this.course = heading;
  }

  /**
   * One step of steering. It writes `ship.controls.wheel` and nothing else.
   *
   * @param gain skill multiplier: the deckhand corrects softly, the legend sharply.
   */
  update(dt: number, ship: Ship, gain = 1): void {
    this.error = angleDelta(ship.heading, this.course);

    // Yaw measured on the world axis. Strictly, the *heading* rate is the projection
    // of ω onto the local yaw axis, and not plain `y`; with the ship heeled 10° the
    // difference is 1.5%, well below what the derivative gain sets out to solve.
    const yawRate = ship.body.angularVelocity.y;

    // Outer loop: PD → desired wheel angle. The negative sign on the error is the
    // convention documented at the top (positive wheel lowers the heading).
    const desired = clamp((-HELM_KP * this.error + HELM_KD * yawRate) * gain, -MAX_WHEEL, MAX_WHEEL);
    this.commandedWheel = desired;

    // Inner loop: takes the wheel there as fast as the stop can bear. Without the
    // `dt` in the denominator the command would depend on the step rate, and a small
    // `dt` would make the wheel drag.
    const room = WHEEL_RATE * dt;
    ship.controls.wheel =
      room > 1e-9 ? clamp((desired - ship.rudder.wheelAngle) / room, -1, 1) : 0;
  }

  /** Lets go of the helm: wheel still, with no attempt to correct anything. */
  release(ship: Ship): void {
    ship.controls.wheel = 0;
    this.error = 0;
    this.commandedWheel = 0;
  }
}
