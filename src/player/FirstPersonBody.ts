/**
 * The body that twists: legs where you walk, torso where you look.
 *
 * Outside first person the whole body points in the movement's direction, and that is
 * right — with no strafing or backward clips, a body pinned to the gaze slides backward,
 * the *moonwalk*. Wearing the body, that cheap lie stops being invisible: walking
 * backward the player would see their own feet pointed at them, and their chest turned to
 * the wrong side of the screen.
 *
 * The way out is the usual one in a first-person game: **separate the two**. The legs
 * keep the movement's direction, which is the only one the animation knows how to walk;
 * the torso keeps the gaze, which is the only one the camera accepts. The difference
 * becomes hip twist, and what pays is the spine.
 *
 * ## What is done to the bones
 *
 * Everything below the `root` bone is rotated by the offset, and the offset is given back
 * distributed along the spine. The result is legs at `legYaw` and shoulders back at
 * `torsoYaw`, without touching arms, neck or head — they inherit the spine and arrive
 * correct for free.
 *
 * Distributing across `spine_01/02/03` instead of twisting a single bone is not
 * fussiness: it is the same decision `anim_gait.pose_spine` already made for the gait's
 * counter-twist, and for the same reason written over there — concentrating the twist in
 * one disc makes a crease in the coat instead of a leaning torso. The weights are the
 * same.
 *
 * **The conjugation is not decoration.** The `pelvis`'s local Y axis is not the
 * character's vertical: the rig animates `pelvis_roll` by 4.2° and `pelvis_pitch` by 3°,
 * and glTF's Z-up→Y-up conversion has already rotated the rest axes. Multiplying the
 * bone's quaternion by a raw yaw would twist around a tilted axis and the hip would end
 * up throwing side to side with the stride. Each rotation is carried into the bone's space
 * before being applied.
 *
 * ## Walking backward with no backward clip
 *
 * Past a certain offset, the legs flip half a turn and the stride is **read backward** —
 * the walk cycle run in reverse is a convincing backward walk, because the foot contacts
 * land at the same instants. What consumes `reversed` is `PlayerAvatar`, which inverts
 * the reading of the clip's `.time` without touching the phase: that is shared with the
 * camera's sway and with the tests.
 *
 * The flip has **hysteresis** out of arithmetic necessity, not out of taste: in a pure
 * strafe the offset is exactly 90°, and a single threshold there makes the legs flip 180°
 * every frame.
 */

import * as THREE from 'three';
import { DEG, clamp, damp, wrapAngle } from '../core/MathUtils';

/**
 * How far the hips may deviate from the shoulders, in radians.
 *
 * A real hip-shoulder separation sits at 15–25° while walking, and reaches some 45°
 * standing still. 65° is more than any anatomy delivers, and it is on purpose: when the
 * limit bites — pure strafe, partial reverse — the choice is between sliding the foot and
 * twisting the figure, and in first person you **do not see your own hips**, but you do
 * catch the foot skating at the bottom of the screen. The error falls on the side that
 * does not show.
 */
const LEG_OFFSET_LIMIT = 65 * DEG;

/**
 * How the counter-twist is shared along the spine, from the lumbar up.
 *
 * It has to add up to 1: that is what brings the shoulders back exactly onto the gaze.
 * The numbers are `anim_gait.pose_spine`'s.
 */
const SPINE_SHARES = [0.3, 0.35, 0.35] as const;

/** The legs' convergence to the target while walking, in 1/s. */
const LEG_CHASE_LAMBDA = 12;

/**
 * The legs' convergence to the gaze while standing still, in 1/s.
 *
 * Low on purpose: whoever turns their head standing still turns their body **afterward**,
 * and it is that laziness that makes the character look inhabited instead of glued to the
 * mouse.
 */
const LEG_IDLE_LAMBDA = 4;

/** Past this offset the body starts walking backward. */
const LEG_REVERSE_ENTER = 100 * DEG;
/** And only walks forward again below this one. The gap covers the stick's noise. */
const LEG_REVERSE_EXIT = 80 * DEG;

const _up = new THREE.Vector3(0, 1, 0);
const _rotation = new THREE.Quaternion();
const _delta = new THREE.Quaternion();
const _inverse = new THREE.Quaternion();
const _world = new THREE.Quaternion();
const _original = new THREE.Quaternion();

/**
 * Flips the legs' heading backward when the offset passes the limit.
 *
 * Kept outside the class because it is pure arithmetic and it is what carries the one
 * treacherous case (the 90° strafe oscillating between the two states) — that way it can
 * be measured with no skeleton at all. See `tests/locomotion.ts`.
 *
 * @param heading where the legs would go, in the ship's frame.
 * @param torsoYaw where the torso points.
 * @param reversed whether the body was already walking backward.
 */
export function foldLegHeading(
  heading: number,
  torsoYaw: number,
  reversed: boolean,
): { heading: number; reversed: boolean } {
  const deviation = Math.abs(wrapAngle(heading - torsoYaw));
  const next = reversed ? deviation > LEG_REVERSE_EXIT : deviation > LEG_REVERSE_ENTER;
  return { heading: next ? heading + Math.PI : heading, reversed: next };
}

export class FirstPersonBody {
  /** Where the legs point, in the ship's frame. */
  legYaw = 0;
  /** `true` when the stride has to be read backward. */
  reversed = false;
  /** The offset applied this frame, in radians. Already clamped. Diagnostic. */
  offset = 0;

  private rootBone: THREE.Bone | null = null;
  private pelvis: THREE.Bone | null = null;
  private readonly spine: THREE.Bone[] = [];
  /**
   * The rig's orientation inside the avatar, from the `root` bone's parent upward.
   *
   * Static — no clip animates the nodes above the skeleton —, so it is measured once. It
   * is what carries a rotation from the avatar's space into the space the `root` bone's
   * quaternion lives in.
   */
  private readonly rigQuaternion = new THREE.Quaternion();
  private ready = false;
  private started = false;

  /**
   * Resolves the bones. Returns `false` if any is missing.
   *
   * A missing bone is no reason to bring anything down: an old GLB cached by the browser
   * may not have the spine under these names, and in that case the body loses only the
   * twist — it goes on walking, jumping and climbing. It is the same policy `PlayerAvatar`
   * already applies to the jump clip and to the climb one.
   *
   * @param avatarRoot the avatar's node; the twist is defined in its space, after the
   *   body's heading has already been applied.
   */
  attach(skeleton: THREE.Skeleton, avatarRoot: THREE.Object3D): boolean {
    this.ready = false;
    this.spine.length = 0;

    const find = (name: string): THREE.Bone | undefined =>
      skeleton.bones.find((bone) => bone.name === name);

    const rootBone = find('root');
    const pelvis = find('pelvis');
    const spine = [find('spine_01'), find('spine_02'), find('spine_03')];
    if (!rootBone || !pelvis || spine.some((bone) => !bone)) return false;

    this.rootBone = rootBone;
    this.pelvis = pelvis;
    for (const bone of spine) this.spine.push(bone!);

    this.rigQuaternion.identity();
    // Bottom-up to collect, top-down to compose: the accumulated value is the product in
    // order from the highest ancestor down to the lowest.
    const chain: THREE.Object3D[] = [];
    for (let node = rootBone.parent; node && node !== avatarRoot; node = node.parent) {
      chain.push(node);
    }
    for (let i = chain.length - 1; i >= 0; i--) this.rigQuaternion.multiply(chain[i]!.quaternion);

    this.ready = true;
    return true;
  }

  /**
   * Chases the legs' heading.
   *
   * The stored state is the **heading**, in the ship's frame, and not the offset relative
   * to the shoulders. The difference shows in the air: there the target freezes, and with
   * a stored heading whoever swings the mouse mid-jump sees the legs stay where they were
   * — which is correct. With a stored offset, they would turn along with the camera,
   * which is exactly the defect the locomotion had already fixed on the ground.
   *
   * @param torsoYaw where the torso points, in the ship's frame.
   * @param target where the legs should go, or `null` to freeze.
   * @param moving whether the target came from movement (and not from the gaze of someone
   *   standing still).
   */
  update(dt: number, torsoYaw: number, target: number | null, moving: boolean): void {
    if (target === null) {
      // Frozen: the offset adjusts itself as the torso turns.
      this.offset = this.clampOffset(torsoYaw);
      return;
    }

    const folded = foldLegHeading(target, torsoYaw, this.reversed);
    this.reversed = folded.reversed;

    if (!this.started) {
      this.legYaw = folded.heading;
      this.started = true;
    } else {
      // By the shortest path, like the body's heading: without this, crossing ±π makes
      // the legs spin nearly a full turn in one frame.
      const lambda = moving ? LEG_CHASE_LAMBDA : LEG_IDLE_LAMBDA;
      const delta = wrapAngle(folded.heading - this.legYaw);
      this.legYaw = damp(this.legYaw, this.legYaw + delta, lambda, dt);
    }

    this.offset = this.clampOffset(torsoYaw);
  }

  /**
   * Pins the legs to a heading and switches the twist off.
   *
   * It is the ladder's case: hands and feet are on the rungs, and turning your head to
   * look at the deck below cannot twist the torso of someone hanging there. Writing the
   * heading instead of only zeroing the offset is what avoids the jerk on letting go —
   * the legs are already where the body left them, and the offset is born at zero.
   */
  hold(yaw: number): void {
    this.legYaw = yaw;
    this.started = true;
    this.reversed = false;
    this.offset = 0;
  }

  private clampOffset(torsoYaw: number): number {
    return clamp(wrapAngle(this.legYaw - torsoYaw), -LEG_OFFSET_LIMIT, LEG_OFFSET_LIMIT);
  }

  /**
   * Writes the twist into the bones. **After** `mixer.update(dt)`.
   *
   * It has to be every frame, and the order is not negotiable: the six clips animate the
   * 43 nodes with weights adding up to 1, so the mixer rewrites `root`, `pelvis` and the
   * whole spine on every pass. What is written here does not feed back into the mixer —
   * it keeps its own original pose inside —, so nothing accumulates.
   *
   * The spine's accumulator is collected **before** any write, and the `root` bone is the
   * last one touched, because it is what the accumulators use.
   */
  apply(): void {
    if (!this.ready || this.offset === 0) return;
    const rootBone = this.rootBone!;
    const pelvis = this.pelvis!;

    // The requested rotation, in the avatar's space.
    _rotation.setFromAxisAngle(_up, this.offset);

    // The pelvis's W: from the avatar down to it, with the quaternions still intact.
    _world.copy(this.rigQuaternion).multiply(rootBone.quaternion).multiply(pelvis.quaternion);

    for (let i = 0; i < this.spine.length; i++) {
      const bone = this.spine[i]!;
      _original.copy(bone.quaternion);

      // s ← W⁻¹ · R^(-share) · W · s, with W the accumulator down to the bone's
      // **parent**.
      _delta.setFromAxisAngle(_up, -SPINE_SHARES[i]! * this.offset);
      _inverse.copy(_world).invert();
      bone.quaternion.premultiply(_inverse.multiply(_delta).multiply(_world));

      _world.multiply(_original);
    }

    // r ← (A⁻¹ · R · A) · r, last: the accumulators above read the old value.
    _inverse.copy(this.rigQuaternion).invert();
    rootBone.quaternion.premultiply(_inverse.multiply(_rotation).multiply(this.rigQuaternion));
  }

  reset(): void {
    this.legYaw = 0;
    this.reversed = false;
    this.offset = 0;
    this.started = false;
  }
}
