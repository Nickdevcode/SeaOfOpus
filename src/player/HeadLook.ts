/**
 * The head that follows the gaze — the half of the body the wire already carried and
 * nobody could see.
 *
 * The opponent's horizontal heading was never a problem: standing still, the whole body
 * turns toward where they look (`PlayerAvatar.updateFacing`), and walking, the
 * direction of movement tells the same story. What was lost was the **vertical**. The
 * snapshot has carried `pitch` since the protocol's first version — it is what decides
 * the interaction focus on the other side — and the body ignored it: the pirate kept
 * his chin pinned to the horizon while his player was aiming at the crow's nest,
 * looking for a breach in the hold or looking at his own hands.
 *
 * ## Why two bones, and not one
 *
 * Concentrating 50° in a single bone gives a broken neck — the same reason
 * `FirstPersonBody` shares the twist across three vertebrae instead of twisting one
 * disc. Here there are two: the `neck` takes the larger share and the `head` completes
 * it, which is how a human neck bends.
 *
 * ## Why the rotation is conjugated
 *
 * Because the bone's X axis is **not** the character's lateral axis. The rig was built
 * in Blender in Z-up and the glTF conversion has already turned the rest axes; a raw
 * `bone.rotateX(θ)` would tilt the head about a crooked axis, and the result is a
 * pirate who looks up by bending his neck sideways. The rotation is defined in the
 * **avatar's** space — where +Z is the character's front, because that is where the
 * model looks — and taken into bone space by the parents' accumulated product, exactly
 * as the hip's twist already does.
 *
 * The two shares rotate about the same axis, so they commute: the `head`'s accumulated
 * product can be gathered after the `neck` has already been written, without the
 * conjugation changing value. It is the same property `FirstPersonBody` uses to walk
 * the spine in a single pass.
 *
 * ## Who uses it
 *
 * Only the body seen from **outside** — the opponent's, and the player's with the
 * camera detached. Wearing the body, what looks up is the camera, and the head is
 * clipped by `headClip` anyway; worse, there `FirstPersonBody`'s twist runs on the same
 * frame and the two rotations do **not** commute (one in Y, the other in X). Applying
 * both together would cost a correct composition to gain exactly nothing you can see.
 */

import * as THREE from 'three';
import { clamp } from '../core/MathUtils';

/**
 * How much of the vertical gaze each bone takes.
 *
 * They add up to less than 1 on purpose: a real neck does not deliver `PITCH_LIMIT`'s
 * 83°, and the rest of the movement, in a real player, comes from the eyes — which this
 * character does not move. At 0.85 in total, looking at the zenith leaves the chin
 * raised at the limit of the believable instead of folding the nape in half.
 */
const NECK_SHARE = 0.5;
const HEAD_SHARE = 0.35;

/** Ceiling of what the neck does, in radians (≈57°) each way. */
const LOOK_LIMIT = 1.0;

const _axis = new THREE.Vector3(1, 0, 0);
const _rotation = new THREE.Quaternion();
const _world = new THREE.Quaternion();
const _inverse = new THREE.Quaternion();

export class HeadLook {
  private neck: THREE.Bone | null = null;
  private head: THREE.Bone | null = null;
  /**
   * Each bone's ancestors up to the avatar's node, from lowest to highest.
   *
   * Built once: the **hierarchy** does not change during the skeleton's life, only the
   * quaternions inside it. Rebuilding the two lists every frame would mean allocating
   * two arrays per body sixty times a second, inside the render frame's 16 ms budget.
   */
  private readonly neckChain: THREE.Object3D[] = [];
  private readonly headChain: THREE.Object3D[] = [];
  private ready = false;

  /** Tilt written on the last frame, in radians. Diagnostics. */
  pitch = 0;

  /**
   * Resolves the two bones. Returns `false` if either is missing.
   *
   * A missing bone brings nothing down: an old GLB in the browser's cache loses only
   * the neck's gesture, and the body goes on walking, climbing and steering. It is the
   * same policy as the jump clip and the hip's twist.
   */
  attach(skeleton: THREE.Skeleton, avatarRoot: THREE.Object3D): boolean {
    this.ready = false;
    this.neck = skeleton.bones.find((bone) => bone.name === 'neck') ?? null;
    this.head = skeleton.bones.find((bone) => bone.name === 'head') ?? null;
    if (!this.neck || !this.head) return false;

    collectChain(this.neck, avatarRoot, this.neckChain);
    collectChain(this.head, avatarRoot, this.headChain);

    this.ready = true;
    return true;
  }

  /**
   * Tilts the head. **After** `mixer.update(dt)`, every frame.
   *
   * The mixer rewrites all 43 nodes on every pass, so what is written here feeds back
   * into nothing and nothing accumulates — the same guarantee as `FirstPersonBody`.
   *
   * @param pitch where the body's owner is looking, in radians. Positive is up, as in
   *   `PlayerController.pitch`.
   */
  apply(pitch: number): void {
    if (!this.ready) return;
    this.pitch = clamp(pitch, -LOOK_LIMIT, LOOK_LIMIT);
    if (this.pitch === 0) return;

    rotate(this.neck!, this.neckChain, NECK_SHARE * this.pitch);
    rotate(this.head!, this.headChain, HEAD_SHARE * this.pitch);
  }

  reset(): void {
    this.pitch = 0;
  }
}

/** A bone's ancestors up to the avatar's node, from lowest to highest. */
function collectChain(
  bone: THREE.Bone,
  avatarRoot: THREE.Object3D,
  out: THREE.Object3D[],
): void {
  out.length = 0;
  for (let node = bone.parent; node && node !== avatarRoot; node = node.parent) out.push(node);
}

/**
 * `q ← (W⁻¹ · R · W) · q`, with `W` the accumulated product from the avatar's space to
 * the bone's **parent**.
 *
 * The sign is negative because the character was modeled looking at −Y in Blender,
 * which becomes **+Z** after glTF's Y-up conversion: a positive rotation about X takes
 * +Z downward, and looking up is precisely the opposite.
 */
function rotate(bone: THREE.Bone, chain: readonly THREE.Object3D[], angle: number): void {
  _rotation.setFromAxisAngle(_axis, -angle);

  // From the highest ancestor to the lowest: that is the product's order.
  _world.identity();
  for (let i = chain.length - 1; i >= 0; i--) _world.multiply(chain[i]!.quaternion);

  _inverse.copy(_world).invert();
  bone.quaternion.premultiply(_inverse.multiply(_rotation).multiply(_world));
}
