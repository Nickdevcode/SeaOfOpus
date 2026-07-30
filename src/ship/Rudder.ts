/**
 * Rudder and steering wheel.
 *
 * The Sea of Thieves wheel is not a car's steering wheel: it does not self-center, and
 * holding `A`/`D` (or the stick) turns it continuously to the stop. That is why the
 * input here is a **rate**, not a position — the angle is state, and whoever lets go
 * of the helm leaves the ship in whatever turn it was in. It is that inertia that
 * forces you to anticipate the turn, and it is what gives a big ship its weight.
 *
 * The force is real hydrodynamics, not a yaw torque applied by hand: a plate inclined
 * in a flow generates a normal force proportional to `u²`, and the torque is born from
 * the lever arm to the stern. Two consequences the game needs and that come for free:
 * **a stopped ship does not steer**, and **a ship going astern steers backwards**.
 */

import * as THREE from 'three';
import { WATER_DENSITY, clamp } from '../core/MathUtils';
import { measureRudderBlade } from './ShipDimensions';
import type { ShipBody } from './ShipBody';

/** Maximum rudder angle, in radians (35°) — the classic stop. */
export const MAX_RUDDER = 0.611;
/** Full travel of the wheel from stop to stop: half a turn each way. */
export const MAX_WHEEL = Math.PI;
/**
 * Angular speed of the wheel at full input, in rad/s.
 *
 * Exported because the bot helmsman commands a wheel *angle* and needs to know how
 * much of it fits in one step to convert that into the rate this class accepts.
 * Duplicating the number over there would let the two descriptions of the same wheel
 * diverge.
 */
export const WHEEL_RATE = 2.1;

/**
 * Normal force coefficient of a plate, in Hoerner's formulation. It holds well past
 * the stall, which is the regime a rudder at 35° actually works in.
 */
const RUDDER_CN = 1.9;

/**
 * Area and center of pressure of the blade, **measured from the geometry the model
 * draws** (`RUDDER_BLADE` in `ShipDimensions`) and not chosen here. They used to be
 * loose constants, and the two descriptions of the same blade diverged fourfold.
 */
const BLADE = measureRudderBlade();
const RUDDER_AREA = BLADE.area;
const RUDDER_CENTER = new THREE.Vector3(0, BLADE.centerY, BLADE.centerZ);

const _localVelocity = new THREE.Vector3();
const _worldPoint = new THREE.Vector3();
const _worldArm = new THREE.Vector3();
const _pointVelocity = new THREE.Vector3();
const _force = new THREE.Vector3();

export class Rudder {
  /** Wheel angle, in radians. Positive is starboard (the ship turns right). */
  wheelAngle = 0;
  /** Rudder angle, derived from the wheel. */
  rudderAngle = 0;

  /** Last side force generated, in newtons. Telemetry only. */
  lastSideForce = 0;

  /**
   * The two angles on the previous step, for the render to interpolate.
   *
   * The wheel is the part the helmsman has in his hands, and the only one on the ship
   * whose movement he measures by looking: a 60 Hz step here reads as "the wheel
   * jammed", and not as a frame rate. See `Cannon.beginStep`.
   */
  previousWheelAngle = 0;
  previousRudderAngle = 0;

  /** Saves this instant's pose as the previous one. See `Cannon.beginStep`. */
  beginStep(): void {
    this.previousWheelAngle = this.wheelAngle;
    this.previousRudderAngle = this.rudderAngle;
  }

  /**
   * @param input -1 (port) to +1 (starboard). It is a rate of turn, not a position.
   */
  update(input: number, dt: number): void {
    this.wheelAngle = clamp(this.wheelAngle + clamp(input, -1, 1) * WHEEL_RATE * dt, -MAX_WHEEL, MAX_WHEEL);
    this.rudderAngle = (this.wheelAngle / MAX_WHEEL) * MAX_RUDDER;
  }

  /**
   * Sets the wheel to a given angle, deriving the rudder.
   *
   * It exists for whoever receives the pose ready-made instead of integrating it — the
   * client that does not simulate. Writing `wheelAngle` directly would leave the rudder
   * at the previous step's value, and the drawn blade pointing one way while the ship
   * turns the other.
   */
  setWheel(angle: number): void {
    this.wheelAngle = clamp(angle, -MAX_WHEEL, MAX_WHEEL);
    this.rudderAngle = (this.wheelAngle / MAX_WHEEL) * MAX_RUDDER;
  }

  /** Centers the wheel at once — used when letting go of the helm in a transition. */
  center(): void {
    this.wheelAngle = 0;
    this.rudderAngle = 0;
    this.previousWheelAngle = 0;
    this.previousRudderAngle = 0;
  }

  /**
   * @param submersion the submerged fraction; a rudder out of the water makes no force.
   */
  apply(body: ShipBody, submersion: number): void {
    const wetted = Math.min(submersion, 1);
    if (wetted <= 0.05) {
      this.lastSideForce = 0;
      return;
    }

    body.localToWorld(RUDDER_CENTER, _worldPoint);
    _worldArm.subVectors(_worldPoint, body.comPosition);
    body.pointVelocity(_worldArm, _pointVelocity);
    body.worldDirToLocal(_pointVelocity, _localVelocity);

    // Flow over the blade. `-z` because the bow points at -Z, so moving ahead means
    // having negative z; `x` is the sway, and since the point is the stern it already
    // brings the yaw's ω×r along with it.
    const axial = -_localVelocity.z;
    const lateral = _localVelocity.x;
    const speed = Math.hypot(axial, lateral);
    if (speed < 1e-3) {
      this.lastSideForce = 0;
      return;
    }

    // **The angle of attack is not the rudder's angle.** It is the rudder's angle
    // minus the angle the water arrives at. Two consequences, and both of them are the
    // ship:
    //
    // - With the rudder amidships and the ship sliding sideways, the blade still makes
    //   force — and it is what brings the bow back. This is where course stability
    //   comes from; without this term the hull did not hold its bow and spiraled on its
    //   own.
    // - In a tight turn the sideslip eats the rudder's angle, so the rudder loses
    //   authority exactly when it is hard over. It is what keeps the yaw from growing
    //   without end.
    //
    // The sign **adds**, and it is easy to get wrong: water arriving from starboard
    // leaves the trailing edge to starboard of the flow line, which is the same thing
    // as putting the rudder to starboard. With the sign flipped the rudder pushed the
    // sideslip instead of closing it, and the ship spiraled with a permanent 30° of
    // crab.
    const inflow = Math.atan2(lateral, axial);
    const alpha = this.rudderAngle + inflow;

    const q = 0.5 * WATER_DENSITY * RUDDER_AREA * speed * speed * wetted;
    const normal = q * RUDDER_CN * Math.sin(alpha);

    // The force is born perpendicular to the **flow**, not to the keel: `travel` is
    // the direction the blade moves through the water and `side` is the normal to it,
    // positive to starboard.
    const travelX = lateral / speed;
    const travelZ = -axial / speed;
    const sideX = axial / speed;
    const sideZ = lateral / speed;

    // The classic plate decomposition: the normal force `N` opens into lift
    // perpendicular to the flow (`N·cos α`) and drag along it (`N·sin α`). Without the
    // cosine the rudder would steer the wrong way going astern, and without the drag
    // the ship would not lose speed in a tight turn.
    const lift = normal * Math.cos(alpha);
    const induced = Math.abs(normal * Math.sin(alpha));

    this.lastSideForce = -lift;

    _force.set(
      -lift * sideX - induced * travelX,
      0,
      -lift * sideZ - induced * travelZ,
    );
    body.localDirToWorld(_force, _force);
    body.applyForceAtPoint(_force, _worldPoint);
  }
}
