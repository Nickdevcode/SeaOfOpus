/**
 * The camera: converts the player's pose (local, on the ship) into a world pose.
 *
 * The detail that decides whether the game looks solid or cheap is in one line: the
 * rig reads `ship.model.root`, and **not** `ship.body`. The body holds the pose from
 * the last physics step, at 60 Hz; the model holds the pose interpolated by the
 * frame's `alpha`. Composing the camera with the body while the deck is drawn with the
 * model makes the whole ship shake in front of the player's eyes on 144 Hz screens — a
 * jitter of millimeters that no smoothing removes.
 *
 * The station change (deck → helm → cannon) is interpolated **in local coordinates**,
 * not in the world: during the transition the ship goes on rolling with the wave, and
 * what we want is the head walking across the deck, not the camera coming loose from
 * it.
 */

import * as THREE from 'three';
import { damp } from '../core/MathUtils';
import type { Ship } from '../ship/Ship';
import type { PlayerController } from './PlayerController';

export type CameraMode = 'player' | 'cinematic' | 'detached';

/**
 * Duration of the transition when taking or leaving a station, in seconds.
 *
 * Exported because the player's body has to travel the same path in the same time: in
 * first person, a camera and a body that reach the helm at different instants read as
 * the character walking off on their own toward the player. See `PlayerAvatar`.
 */
export const STATION_BLEND = 0.28;
/** Convergence of the field of view, in 1/s. */
const FOV_LAMBDA = 9;

/** The menu's orbit: radius, height and angular speed. */
const CINEMATIC_RADIUS = 26;
const CINEMATIC_HEIGHT = 7.5;
const CINEMATIC_SPEED = 0.055;
const CINEMATIC_LOOK_Y = 5.5;

const _position = new THREE.Vector3();
const _quaternion = new THREE.Quaternion();
const _target = new THREE.Vector3();

export class CameraRig {
  mode: CameraMode = 'player';

  private readonly blendPosition = new THREE.Vector3();
  private readonly blendQuaternion = new THREE.Quaternion();
  /** 1 = transition finished. It starts ready so the first frame does not jump. */
  private blend = 1;
  private lastStationChange = -1;

  private cinematicAngle = 0.6;

  constructor(readonly camera: THREE.PerspectiveCamera) {}

  /** Puts the camera back at the player's eyes. */
  attachPlayer(): void {
    this.mode = 'player';
    this.blend = 1;
    this.lastStationChange = -1;
  }

  /** A cinematic orbit around the ship — the menu's backdrop. */
  cinematic(): void {
    this.mode = 'cinematic';
  }

  /** Releases the camera: whoever wants to position it writes to it directly (the dev bench). */
  detach(): void {
    this.mode = 'detached';
  }

  update(dt: number, player: PlayerController, ship: Ship): void {
    if (this.mode === 'detached') return;
    if (this.mode === 'cinematic') {
      this.updateCinematic(dt, ship);
      return;
    }

    this.updateStationBlend(dt, player);

    // The ship's visual pose, interpolated. `localToWorld` already updates the
    // model's world matrix, so there is no frame of delay here.
    ship.model.root.localToWorld(_position.copy(this.blendPosition));
    _quaternion.copy(ship.model.root.quaternion).multiply(this.blendQuaternion);

    this.camera.position.copy(_position);
    this.camera.quaternion.copy(_quaternion);

    this.updateFov(dt, player.fov);
  }

  private updateStationBlend(dt: number, player: PlayerController): void {
    if (player.stationChangeCount !== this.lastStationChange) {
      // The first time (spawn) has nowhere to come from: it starts already in place.
      this.blend = this.lastStationChange < 0 ? 1 : 0;
      this.lastStationChange = player.stationChangeCount;
      if (this.blend === 1) {
        this.blendPosition.copy(player.eyeLocal);
        this.blendQuaternion.copy(player.eyeQuaternion);
        return;
      }
    }

    if (this.blend >= 1) {
      this.blendPosition.copy(player.eyeLocal);
      this.blendQuaternion.copy(player.eyeQuaternion);
      return;
    }

    this.blend = Math.min(this.blend + dt / STATION_BLEND, 1);
    // Ease in and out: pure linear gives away the movement's start and end, and a
    // camera that "switches on and off" reads as a cut, not as a step.
    const s = this.blend * this.blend * (3 - 2 * this.blend);
    this.blendPosition.lerp(player.eyeLocal, s);
    this.blendQuaternion.slerp(player.eyeQuaternion, s);
  }

  private updateCinematic(dt: number, ship: Ship): void {
    this.cinematicAngle += dt * CINEMATIC_SPEED;

    const origin = ship.model.root.position;
    this.camera.position.set(
      origin.x + Math.sin(this.cinematicAngle) * CINEMATIC_RADIUS,
      origin.y + CINEMATIC_HEIGHT,
      origin.z + Math.cos(this.cinematicAngle) * CINEMATIC_RADIUS,
    );
    _target.set(origin.x, origin.y + CINEMATIC_LOOK_Y, origin.z);
    this.camera.lookAt(_target);

    this.updateFov(dt, 48);
  }

  private updateFov(dt: number, target: number): void {
    const next = damp(this.camera.fov, target, FOV_LAMBDA, dt);
    // Recomposing the projection matrix costs; below a tenth of a degree nobody sees
    // the difference, so it is only redone during the aiming zoom.
    if (Math.abs(next - this.camera.fov) < 0.01) return;
    this.camera.fov = next;
    this.camera.updateProjectionMatrix();
  }
}
