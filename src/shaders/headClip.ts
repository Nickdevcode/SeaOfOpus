/**
 * Making the head disappear without making the shadow disappear.
 *
 * In first person the player's eye sits at 1.66 m and the character's skull runs from
 * 1.545 m to 1.76 m — with the tricorn up to 1.94 m. The camera is born **inside** the
 * mesh, and the pirate's material is `DoubleSide`, so the head's interior renders:
 * without a clip, first person is a screenful of scalp seen from within. That is why the
 * body used to be hidden entirely.
 *
 * The clip is a `discard` in the fragment, decided by the vertex's **skinning weight** on
 * the head bones. A weight is a continuous field, so the cut falls on a smooth curve
 * along the neck instead of on a plane, and the threshold moves that curve without
 * recompiling anything — which is what allows calibrating this with your eye on the
 * screen.
 *
 * **Why not `head.scale = 0`.** It is the classic trick and here it does not serve. The
 * neck's and collar's vertices have **mixed** weights (`PART_Neck` splits between `neck`,
 * `head` and `spine_03`; `PART_Coat_Collar` between four bones). Shrinking the bone does
 * not erase them: it **drags** each one toward `head`'s origin by whatever fraction of
 * weight it has, and what is left is a crumpled funnel 20 cm from the eye, forever. And
 * it would not even be cheaper — the six clips record SCALE for all 43 nodes, so the
 * scale would have to be rewritten every frame after the mixer.
 *
 * **Why not `clippingPlanes`.** A clipping plane is infinite. A plane at neck height,
 * with `clipShadows = false`, would give "invisible with a full shadow" for free — and it
 * would amputate the **hands on the ladder**, which in `ClimbUp` rise well above the
 * neck. That is: it would kill precisely what first person came to show.
 *
 * **Why `onBeforeCompile`, which is not used anywhere else here.** The house pattern is a
 * `ShaderMaterial` written from scratch (`hullClip.ts`, `Ocean`, `Sky`) because there the
 * shader **is** the work — they are authored effects. Here it is the opposite: the
 * requirement is to preserve exactly the PBR `GLTFLoader` assembled (normal map, packed
 * ORM, skinning through a bone texture) and add one line. Rewriting `meshphysical` would
 * be taking on the maintenance of some 800 lines of three's GLSL in order to add a
 * `discard`.
 *
 * **The side effect is the best part of the feature.** `WebGLShadowMap.getDepthMaterial`
 * copies from the source material only a closed list of fields — `visible`, `side`,
 * `alphaMap`, `alphaTest`, `clipShadows`, `displacementMap` and the like — and
 * `onBeforeCompile` is **not** on it. The shadow map draws the whole pirate, hat
 * included, while the color pass discards the head. The player gets their own shadow on
 * the deck, which in first person never existed (an invisible object does not even enter
 * the shadow map's `renderObject`). If one day the shadow should be headless too, the
 * hook is `mesh.customDepthMaterial`, which takes priority — that is not the case today.
 */

import * as THREE from 'three';

/**
 * The threshold that switches the clip off.
 *
 * Larger than any possible summed weight (a vertex's weights add up to 1, and the neck's
 * share comes in with a factor of at most 1), so nothing is discarded without swapping
 * programs or recompiling a shader. It is what third person uses when the camera comes
 * loose with `C`.
 */
export const HEAD_CLIP_OFF = 2;

/**
 * The weight above which the fragment disappears, in [0, 1].
 *
 * A half means "more than half of this vertex belongs to the head", which geometrically
 * falls in the middle of the neck — `head` begins at 1.545 m and `neck` at 1.425 m. The
 * tricorn, the eyes, the nose, the ears, the mouth, the moustache and the hair are 100%
 * on `head` and disappear at any threshold below 1.
 */
export const HEAD_CLIP_THRESHOLD = 0.5;

/**
 * How much the `neck` bone's weight counts toward the cut, in [0, 1].
 *
 * At zero only the head disappears and a stump of neck is left pointing at the camera.
 * Raising it, the cut descends toward the coat's collar. It stays at zero by default
 * because the stump is out of the field of view at the overwhelming majority of angles,
 * and cutting too deep opens the coat from the inside when you look down.
 */
export const HEAD_CLIP_NECK_SHARE = 0;

/** The control for a clip already installed in a material. */
export interface HeadClipHandle {
  /** The threshold in force. `HEAD_CLIP_OFF` means switched off. */
  readonly threshold: number;
  /** The neck share in force. */
  readonly neckShare: number;
  setThreshold(value: number): void;
  setNeckShare(value: number): void;
}

/** Declarations common to both stages. */
const DECLARATIONS = /* glsl */ `
varying float vHeadClipWeight;
`;

/**
 * Sums the vertex's weight on the head bones.
 *
 * With no branching and no indexing a vector with a variable index: `step` returns 1
 * exactly at the bone being looked for (the indices are integers, so the difference is 0
 * or at least 1) and the `dot` sums the four influences at once. A negative index — the
 * bone that does not exist in an old GLB — never matches anything, and the term falls to
 * zero on its own.
 */
const VERTEX_BODY = /* glsl */ `
#ifdef USE_SKINNING
  vHeadClipWeight = dot(step(abs(skinIndex - vec4(uHeadClipHead)), vec4(0.5)), skinWeight)
    + dot(step(abs(skinIndex - vec4(uHeadClipNeck)), vec4(0.5)), skinWeight) * uHeadClipNeckShare;
#else
  vHeadClipWeight = 0.0;
#endif
`;

/**
 * Installs the clip in one of the character's materials.
 *
 * It does not clone **here**, and it does not need to: the GLB is loaded once and serves
 * both bodies aboard, but what already hands out a private material per avatar is
 * `CharacterAsset.instantiateCharacter`. The order matters and it is that one — without
 * the clone over there, switching the clip on to see through your own eyes would behead
 * the opponent in the same frame, because both pirates would share the threshold uniform.
 *
 * The compiled program, that one is shared for free:
 * `Material.customProgramCacheKey` returns `onBeforeCompile`'s **source text**, identical
 * for every closure created from this same expression. One program, N sets of uniforms.
 *
 * @param headIndex index of the `head` bone in `skeleton.bones`, or -1.
 * @param neckIndex index of the `neck` bone in `skeleton.bones`, or -1.
 */
export function installHeadClip(
  material: THREE.Material,
  headIndex: number,
  neckIndex: number,
): HeadClipHandle {
  // It starts switched off: what switches it on is the avatar, on the first frame it
  // knows whether the camera is in the character's eyes.
  const uniforms = {
    uHeadClipHead: { value: headIndex },
    uHeadClipNeck: { value: neckIndex },
    uHeadClipNeckShare: { value: HEAD_CLIP_NECK_SHARE },
    uHeadClipThreshold: { value: HEAD_CLIP_OFF },
  };

  material.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, uniforms);

    shader.vertexShader = shader.vertexShader
      .replace(
        '#include <common>',
        `#include <common>
uniform float uHeadClipHead;
uniform float uHeadClipNeck;
uniform float uHeadClipNeckShare;
${DECLARATIONS}`,
      )
      // After `begin_vertex` only because it is an anchor that exists in any material;
      // the computation does not depend on anything that comes before.
      .replace('#include <begin_vertex>', `#include <begin_vertex>\n${VERTEX_BODY}`);

    shader.fragmentShader = shader.fragmentShader
      .replace(
        '#include <common>',
        `#include <common>
uniform float uHeadClipThreshold;
${DECLARATIONS}`,
      )
      // Before everything else: the discarded fragment pays for no normal map, no ORM
      // sampling and no lighting.
      .replace(
        '#include <clipping_planes_fragment>',
        `if (vHeadClipWeight > uHeadClipThreshold) discard;
#include <clipping_planes_fragment>`,
      );
  };
  material.needsUpdate = true;

  return {
    get threshold(): number {
      return uniforms.uHeadClipThreshold.value;
    },
    get neckShare(): number {
      return uniforms.uHeadClipNeckShare.value;
    },
    setThreshold(value: number): void {
      uniforms.uHeadClipThreshold.value = value;
    },
    setNeckShare(value: number): void {
      uniforms.uHeadClipNeckShare.value = value;
    },
  };
}
