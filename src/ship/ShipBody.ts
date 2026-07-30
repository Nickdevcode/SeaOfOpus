/**
 * A 6-degree-of-freedom rigid body — the integrator that moves the ship.
 *
 * It is deliberately small: it accumulates force and torque during the step,
 * integrates once and zeroes. What decides *which* forces exist are `Buoyancy`,
 * `Rudder`, `SailSim` and `Anchor`; this module does not know what water or wind is.
 *
 * **Added mass.** A hull accelerating sideways drags a good mass of water along, and
 * ignoring that leaves the ship twitchy: it slides sideways and rides up the wave too
 * fast. Instead of assembling the full added-mass tensor (which couples heave with
 * pitch and is worth twice the code), the mass is anisotropic in the ship's frame — the
 * standard in boat simulation for games. Since buoyancy and gravity are divided by the
 * same number, the equilibrium does not change; only how quickly the ship responds on
 * each axis does.
 *
 * **Gyroscopic term.** ω × (Iω) was deliberately omitted. On a ship ω is on the order
 * of 0.3 rad/s and the term sits three orders of magnitude below the hydrodynamic
 * torques, but it is the first thing to blow up under explicit integration.
 */

import * as THREE from 'three';

export interface ShipBodyOptions {
  /** Mass at rest, in kg. It comes from the hull's displacement. */
  mass: number;
  /**
   * Center of mass, in local coordinates. It sits below the waterline: it is the
   * ballast that guarantees the ship rights itself instead of capsizing.
   */
  centerOfMass: THREE.Vector3;
  /**
   * Radii of gyration in meters, about X (pitch), Y (yaw) and Z (roll). They already
   * include the water's added inertia.
   */
  gyration: THREE.Vector3;
  /**
   * Added-mass multipliers per local axis: X sway, Y heave, Z surge. Surge is ~1.05
   * because the hull is fine in that direction; sway and heave push water sideways and
   * nearly double the effective mass.
   */
  addedMass: THREE.Vector3;
}

const _localForce = new THREE.Vector3();
const _accel = new THREE.Vector3();
const _arm = new THREE.Vector3();
const _torqueScratch = new THREE.Vector3();
const _spin = new THREE.Quaternion();
const _invRotation = new THREE.Quaternion();
const _localTorque = new THREE.Vector3();

export class ShipBody {
  readonly mass: number;
  /** Center of mass in local coordinates (constant). */
  readonly centerOfMass: THREE.Vector3;
  /** Principal moments of inertia, in kg·m², on the local X/Y/Z axes. */
  readonly inertia = new THREE.Vector3();
  readonly addedMass: THREE.Vector3;

  /**
   * Extra mass shipped, in kg — today only the hold's water (`ShipDamage`).
   *
   * It exists separately from `mass` because its weight already comes in as a *force*
   * applied at the water's centroid, which is what produces the heel. What is missing
   * is the inertia: without adding it here, a half-flooded ship would be lighter to
   * maneuver than a dry one, which is exactly the opposite of what should happen.
   */
  floodedMass = 0;

  /** Position **of the center of mass** in the world. It is what the integrator moves. */
  readonly comPosition = new THREE.Vector3();
  readonly orientation = new THREE.Quaternion();
  /** Velocity of the center of mass, in the world. */
  readonly velocity = new THREE.Vector3();
  /** Angular velocity in the world, in rad/s. */
  readonly angularVelocity = new THREE.Vector3();

  /** The previous step's pose, to interpolate the visuals between fixed steps. */
  readonly previousCom = new THREE.Vector3();
  readonly previousOrientation = new THREE.Quaternion();

  private readonly force = new THREE.Vector3();
  private readonly torque = new THREE.Vector3();

  constructor(options: ShipBodyOptions) {
    this.mass = options.mass;
    this.centerOfMass = options.centerOfMass.clone();
    this.addedMass = options.addedMass.clone();

    const { x, y, z } = options.gyration;
    this.inertia.set(this.mass * x * x, this.mass * y * y, this.mass * z * z);
  }

  /** Position of the ship's **local origin** (design waterline, amidships). */
  getOrigin(target: THREE.Vector3): THREE.Vector3 {
    return target.copy(this.centerOfMass).applyQuaternion(this.orientation).negate().add(this.comPosition);
  }

  /** Places the ship's local origin at a point in the world. */
  setOrigin(x: number, y: number, z: number): void {
    _arm.copy(this.centerOfMass).applyQuaternion(this.orientation);
    this.comPosition.set(x + _arm.x, y + _arm.y, z + _arm.z);
    this.previousCom.copy(this.comPosition);
  }

  /** Converts a local point into a world point. */
  localToWorld(local: THREE.Vector3, target: THREE.Vector3): THREE.Vector3 {
    return target.copy(local).sub(this.centerOfMass).applyQuaternion(this.orientation).add(this.comPosition);
  }

  /** Converts a world point into a local point. The inverse of `localToWorld`. */
  worldToLocal(world: THREE.Vector3, target: THREE.Vector3): THREE.Vector3 {
    _invRotation.copy(this.orientation).invert();
    return target.copy(world).sub(this.comPosition).applyQuaternion(_invRotation).add(this.centerOfMass);
  }

  /** Rotates a local direction into the world (without translating). */
  localDirToWorld(local: THREE.Vector3, target: THREE.Vector3): THREE.Vector3 {
    return target.copy(local).applyQuaternion(this.orientation);
  }

  /** Rotates a world direction into the ship's frame. */
  worldDirToLocal(world: THREE.Vector3, target: THREE.Vector3): THREE.Vector3 {
    _invRotation.copy(this.orientation).invert();
    return target.copy(world).applyQuaternion(_invRotation);
  }

  /**
   * Velocity of a point on the body, given the **arm to the center of mass** already in
   * the world frame: v + ω × r.
   */
  pointVelocity(worldArm: THREE.Vector3, target: THREE.Vector3): THREE.Vector3 {
    return target.crossVectors(this.angularVelocity, worldArm).add(this.velocity);
  }

  /** A world force applied at the center of mass — it generates no torque. */
  applyForce(force: THREE.Vector3): void {
    this.force.add(force);
  }

  /** A world force applied at a world point. It generates torque about the CM. */
  applyForceAtPoint(force: THREE.Vector3, worldPoint: THREE.Vector3): void {
    this.force.add(force);
    _arm.subVectors(worldPoint, this.comPosition);
    this.torque.add(_torqueScratch.crossVectors(_arm, force));
  }

  applyTorque(torque: THREE.Vector3): void {
    this.torque.add(torque);
  }

  integrate(dt: number): void {
    this.previousCom.copy(this.comPosition);
    this.previousOrientation.copy(this.orientation);

    // Linear: it divides in the ship's frame so the added mass applies per axis, and
    // only then goes back into the world.
    const mass = this.mass + this.floodedMass;
    this.worldDirToLocal(this.force, _localForce);
    _accel.set(
      _localForce.x / (mass * this.addedMass.x),
      _localForce.y / (mass * this.addedMass.y),
      _localForce.z / (mass * this.addedMass.z),
    );
    this.localDirToWorld(_accel, _accel);
    this.velocity.addScaledVector(_accel, dt);
    this.comPosition.addScaledVector(this.velocity, dt);

    // Angular: the same path, now with the inertia tensor (diagonal in local space).
    // The inertia follows the shipped mass for the same reason — water in the hold
    // costs to rotate too.
    const inertiaScale = mass / this.mass;
    this.worldDirToLocal(this.torque, _localTorque);
    _localTorque.set(
      _localTorque.x / (this.inertia.x * inertiaScale),
      _localTorque.y / (this.inertia.y * inertiaScale),
      _localTorque.z / (this.inertia.z * inertiaScale),
    );
    this.localDirToWorld(_localTorque, _localTorque);
    this.angularVelocity.addScaledVector(_localTorque, dt);

    // q̇ = ½ ω q. Normalizing every step is what keeps the integration error from
    // becoming a spurious scale in the ship's matrix.
    _spin.set(this.angularVelocity.x, this.angularVelocity.y, this.angularVelocity.z, 0);
    _spin.multiply(this.orientation);
    this.orientation.x += _spin.x * 0.5 * dt;
    this.orientation.y += _spin.y * 0.5 * dt;
    this.orientation.z += _spin.z * 0.5 * dt;
    this.orientation.w += _spin.w * 0.5 * dt;
    this.orientation.normalize();

    this.force.set(0, 0, 0);
    this.torque.set(0, 0, 0);
  }

  /**
   * Discards what has accumulated without integrating.
   *
   * It exists for the side that does **not** simulate. There the pose arrives ready
   * over the network and `integrate` never runs — but some subsystems go on running for
   * what they *draw* (the sail, which has to measure the wind to fill), and they push
   * force as they pass. Without this call, that accumulator would grow for the whole
   * match without ever being read: harmless today, and exactly the kind of number that
   * blows up to `Infinity` the day somebody decides to read it.
   */
  clearForces(): void {
    this.force.set(0, 0, 0);
    this.torque.set(0, 0, 0);
  }

  /** Pose interpolated between the previous step and the current one, for the render. */
  sampleOrigin(alpha: number, target: THREE.Vector3, targetRotation: THREE.Quaternion): void {
    targetRotation.copy(this.previousOrientation).slerp(this.orientation, alpha);
    _arm.copy(this.centerOfMass).applyQuaternion(targetRotation);
    target.copy(this.previousCom).lerp(this.comPosition, alpha).sub(_arm);
  }
}
