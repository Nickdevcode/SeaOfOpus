/**
 * The plank in the player's hands, while they nail the breach shut.
 *
 * **It is not a child of a bone.** The obvious path would be `handBone.add(plank)` with a
 * fixed offset, and it works — provided the offset is written in the same frame the bone
 * lives in after going through the glTF exporter's Z-up → Y-up conversion and Blender's
 * bone-axis convention. Those are two passes where a flipped sign produces no error at
 * all: it produces a plank floating beside the hand, and the only way to find out is by
 * looking.
 *
 * So the piece is assembled **from the two hands**, every frame:
 *
 * - the length axis is the line joining one wrist to the other;
 * - the roll around it comes out of the right hand's orientation;
 * - the center is the midpoint, displaced by whatever the clip measured.
 *
 * The `SOCKET_*` numbers were measured in Blender, with the `Carry` action playing,
 * projecting the plank's frame onto that same basis — and they move less than 3 mm across
 * the cycle, which is what proves the basis is rigid relative to the piece. If somebody
 * rebuilds the clip with a changed pose, just measure again: `anim_carry.socket()` spits
 * out these six numbers.
 *
 * The gain from doing it this way is that the plank **cannot** come off the hands. It is
 * not positioned near where the hands should be; it is positioned where the hands are.
 */

import * as THREE from 'three';
import { PLANK_LENGTH, PLANK_THICKNESS, PLANK_WIDTH, loadPlank } from '../ship/PlankAsset';

/**
 * Where the plank's center sits relative to the midpoint between the two wrists, in the
 * `(u, e2, e3)` basis described at the top. In meters.
 *
 * The third number is the one that carries the meaning: 13 cm **outboard** of the wrists'
 * line, which is half a plank's width plus the palm. The other two are measurement noise
 * and are here because copying them costs nothing and rounding them to zero would be
 * choosing a number instead of measuring one.
 */
const SOCKET_OFFSET = { along: 0.0013, up: 0.0025, out: -0.1313 } as const;

/** The plank's length axis in the same basis. Almost the axis between the wrists. */
const SOCKET_LENGTH = new THREE.Vector3(0.9956, -0.0207, -0.0918);
/** The width axis. It is what decides which way the wide face looks. */
const SOCKET_WIDTH = new THREE.Vector3(-0.0912, -0.4513, -0.8877);

/** The bone's direction at Blender's rest pose: bones point along local +Y. */
const BONE_AXIS = new THREE.Vector3(0, 1, 0);

const _left = new THREE.Vector3();
const _right = new THREE.Vector3();
const _mid = new THREE.Vector3();
const _u = new THREE.Vector3();
const _e2 = new THREE.Vector3();
const _e3 = new THREE.Vector3();
const _boneDir = new THREE.Vector3();
const _length = new THREE.Vector3();
const _width = new THREE.Vector3();
const _thickness = new THREE.Vector3();
const _center = new THREE.Vector3();
const _basis = new THREE.Matrix4();
const _inverseParent = new THREE.Matrix4();

export class CarriedPlank {
  private mesh: THREE.Mesh | null = null;
  private parent: THREE.Object3D | null = null;
  private handLeft: THREE.Bone | null = null;
  private handRight: THREE.Bone | null = null;
  private disposed = false;

  /**
   * Finds the two bones and hangs the plank off the avatar's node.
   *
   * Under the avatar, and not under the scene, for one reason only: it is what disappears
   * when the player takes the cannon and when the camera is inside the head. Hung off the
   * scene, the plank would go on being visible on its own, floating on the deck — and the
   * cost of following the parent is one matrix inversion per frame.
   *
   * @returns `false` when the bones are not in the GLB — and then the repair goes on
   *   working, with no wood in sight.
   */
  attach(skeleton: THREE.Skeleton, parent: THREE.Object3D): boolean {
    this.handLeft = findBone(skeleton, 'hand.L');
    this.handRight = findBone(skeleton, 'hand.R');
    if (!this.handLeft || !this.handRight) {
      console.warn('[plank] hand bones not found; the repair goes without a plank');
      return false;
    }

    void loadPlank().then((asset) => {
      if (!asset || this.disposed) return;
      const mesh = new THREE.Mesh(asset.geometry, asset.material);
      mesh.name = 'carried-plank';
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      // The matrix is written by hand every frame; letting Three recompose it from
      // position and quaternion would be decomposing what has just been composed.
      mesh.matrixAutoUpdate = false;
      // The piece lives glued to the hands, which the avatar already takes out of
      // culling by leaving the skeleton's rest box.
      mesh.frustumCulled = false;
      mesh.visible = false;
      parent.add(mesh);
      this.mesh = mesh;
      this.parent = parent;
    });

    return true;
  }

  /**
   * Puts the plank between the hands, or hides it.
   *
   * Call it **after** `mixer.update` and after any direct write to a bone: what is read
   * here are the wrists' world matrices, and they are only valid once the frame's pose has
   * finished being assembled.
   *
   * @param visible whether the player has the plank in hand this frame.
   */
  update(visible: boolean): void {
    const mesh = this.mesh;
    if (!mesh || !this.handLeft || !this.handRight) return;

    mesh.visible = visible;
    if (!visible) return;

    // Walk up the chain to the root without descending into the children: without this
    // what is read is the **previous** frame's pose, and the plank runs one frame behind
    // the hands — which is exactly where it would be noticed, in the gesture of raising
    // the piece.
    this.handLeft.updateWorldMatrix(true, false);
    this.handRight.updateWorldMatrix(true, false);

    _left.setFromMatrixPosition(this.handLeft.matrixWorld);
    _right.setFromMatrixPosition(this.handRight.matrixWorld);
    _mid.addVectors(_left, _right).multiplyScalar(0.5);

    _u.subVectors(_left, _right);
    if (_u.lengthSq() < 1e-8) return;
    _u.normalize();

    // The roll around the wrists' axis comes out of the right hand. Without a second
    // vector, the basis is left with one loose degree of freedom and the plank rolls
    // around the hands every frame.
    _boneDir.copy(BONE_AXIS).transformDirection(this.handRight.matrixWorld);
    _e2.copy(_boneDir).addScaledVector(_u, -_boneDir.dot(_u));
    if (_e2.lengthSq() < 1e-8) return;
    _e2.normalize();
    _e3.crossVectors(_u, _e2);

    _center
      .copy(_mid)
      .addScaledVector(_u, SOCKET_OFFSET.along)
      .addScaledVector(_e2, SOCKET_OFFSET.up)
      .addScaledVector(_e3, SOCKET_OFFSET.out);

    combine(_length, SOCKET_LENGTH);
    combine(_width, SOCKET_WIDTH);
    // The thickness closes the basis by the right-hand rule. The negative sign is what
    // matches the file: the plank comes out of Blender with the length in X, the
    // **thickness** in Y and the width in Z, and in that order the three form a
    // left-handed basis if the normal is taken straight from the cross product.
    _thickness.crossVectors(_length, _width).negate().normalize();
    _width.crossVectors(_thickness, _length).normalize();

    _basis.makeBasis(_length, _thickness, _width);
    _basis.setPosition(_center);

    // The basis was assembled in world coordinates, and the mesh is a child of the
    // avatar: undoing the parent's transform is what puts the two in the same frame.
    const parent = this.parent;
    if (parent) {
      parent.updateWorldMatrix(true, false);
      _inverseParent.copy(parent.matrixWorld).invert();
      _basis.premultiply(_inverseParent);
    }

    mesh.matrix.copy(_basis);
    mesh.updateMatrixWorld(true);
  }

  dispose(): void {
    this.disposed = true;
    this.handLeft = null;
    this.handRight = null;
    if (!this.mesh) return;
    // The geometry and the material belong to the `PlankAsset` module and go on serving
    // the planks nailed to both hulls: here only the instance is released.
    this.mesh.removeFromParent();
    this.mesh = null;
  }
}

/**
 * Finds a bone by its Blender name, with or without the dot.
 *
 * **`GLTFLoader` sanitizes the names.** The rig calls the sided bones `hand.L` and
 * `hand.R`, and that is how they come out of the exporter; Three's loader replaces the
 * dot with nothing and what arrives in the scene is `handL`. The reason is
 * `PropertyBinding`, which uses the dot as a path separator — a bone named `hand.L` would
 * be read as the `L` property of the `hand` object.
 *
 * This does not show up anywhere else in the project because the six bones
 * `FirstPersonBody` looks for (`root`, `pelvis`, `spine_0N`) are precisely the ones with
 * no side. The symptom here was a warning in the console and a repair with no wood, with
 * everything else working.
 *
 * Looking for both forms costs one scan and survives a loader swap in either direction.
 */
function findBone(skeleton: THREE.Skeleton, name: string): THREE.Bone | null {
  const plain = name.replace(/\./g, '');
  return skeleton.bones.find((bone) => bone.name === name || bone.name === plain) ?? null;
}

/** Rebuilds an axis measured in this frame's `(u, e2, e3)` basis. */
function combine(out: THREE.Vector3, coefficients: THREE.Vector3): void {
  out
    .copy(_u)
    .multiplyScalar(coefficients.x)
    .addScaledVector(_e2, coefficients.y)
    .addScaledVector(_e3, coefficients.z)
    .normalize();
}

/** The piece's measurements, re-exported for whoever draws the aim or the prompt. */
export const PLANK_SIZE = {
  length: PLANK_LENGTH,
  width: PLANK_WIDTH,
  thickness: PLANK_THICKNESS,
} as const;
