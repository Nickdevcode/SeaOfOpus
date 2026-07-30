/**
 * Clipping the sea away inside the hull.
 *
 * The ocean is a single mesh covering the whole horizon; it does not know a ship exists,
 * and goes straight through it. From outside you do not notice — the side writes depth
 * first and covers everything. From inside the hold you do: the water's surface goes
 * through the planking at the waterline and the ship gets a lake in the middle of it,
 * with foam and a reflection of the sky.
 *
 * The solution is a `discard` in the sea's fragment when it falls inside the hull's
 * volume. What makes that cheap is the test's shape: in the ship's local coordinates,
 * "being inside" is `|x| < halfWidth(t, y)` — a function of two variables, which fits in
 * a small texture computed once on the CPU. The fragment pays one matrix multiply and one
 * sample per hull.
 *
 * **Why a texture and not a uniform array.** The natural attempt would be to send the
 * station table as `uniform vec4 uStations[11]` and interpolate in the shader. It does
 * not fly: under WebGL2 three still compiles `ShaderMaterial` as GLSL ES 1.00, and there
 * the index of a uniform array in the fragment shader has to be a
 * *constant-index-expression*. An index coming out of arithmetic on `t` is rejected by
 * ANGLE. The texture solves that and also swaps the Catmull-Rom for a bilinear read the
 * hardware does for free.
 *
 * **Why not three's `clippingPlanes`.** Clipping planes describe a single convex volume;
 * with two ships you would need the *union* of two volumes, which `clipIntersection` does
 * not express. And a box fitted to the hull would clip a visible rectangle of sea around
 * the ship.
 */

import * as THREE from 'three';
import { clamp01 } from '../core/MathUtils';
import { HALF_LENGTH, HULL_LENGTH, innerSurfacePoint } from '../ship/ShipDimensions';

/**
 * How many hulls the sea clips at the same time.
 *
 * The loop in the shader is unrolled by this number, so it is the fixed cost per water
 * fragment — and two is exactly what a 1v1 duel asks for. Raising it without need makes
 * the most expensive pixel in the scene more expensive.
 */
export const HULL_CLIP_MAX = 2;

/** Columns (along `t`) and rows (along `y`) of the profile. */
const PROFILE_WIDTH = 128;
const PROFILE_HEIGHT = 96;

/**
 * Height range covered by the profile, in the ship's local coordinates.
 *
 * It runs from the deepest keel (−1.55 m) to the top of the tallest bulwark (3.04 m, at
 * the bow), with a margin at each end. Outside that range the test does not even sample
 * the texture — it is the fast rejection that makes this clip's average cost nearly
 * nothing, since the overwhelming majority of sea pixels are far from the ship.
 */
const PROFILE_Y_MIN = -1.6;
const PROFILE_Y_MAX = 3.2;
const PROFILE_Y_RANGE = PROFILE_Y_MAX - PROFILE_Y_MIN;

/**
 * Meters represented by a value of 1.0 in the texture.
 *
 * The maximum inner half-width is 2.31 m (amidships, just below the rail), so 2.5 gives
 * some room and leaves the 8-bit quantization at ~1 cm.
 */
const PROFILE_SCALE = 2.5;

/**
 * How far the clip volume grows sideways, in meters.
 *
 * The error has to fall on the right side. Clipping too little leaves a few centimeters
 * of sea stuck to the planking, **visible from inside the hold** — which is precisely the
 * defect being fixed. Clipping too much pushes the water's edge into the wood, where
 * nobody sees it: the side is 13 cm thick (17 cm measured horizontally, at the bilge).
 * Five centimeters cover the texture's quantization and the interpolation between rows
 * with room to spare, and still stay well clear of the outer face.
 */
const CLIP_MARGIN = 0.05;

/** Samples of `v` per column when building the profile. */
const COLUMN_SAMPLES = 64;

/**
 * Builds the hull's inner profile into an R8 texture.
 *
 * It runs once, when the ocean is created. The construction is **per column**, and not
 * per texel, for a load-time reason: inverting the height in `v` requires bisection, and
 * one bisection per texel would give ~900 thousand section evaluations (close to 90 ms of
 * stutter). Sampling the inner surface bottom-up once per column and interpolating the
 * rows between the samples, they fall to ~40 thousand. The inner point's height grows
 * monotonically with `v` — the side is 13 cm against the section's ~3.7 m of height —, so
 * the linear march below is valid.
 */
export function buildHullProfileTexture(): THREE.DataTexture {
  const data = new Uint8Array(PROFILE_WIDTH * PROFILE_HEIGHT);
  const heights = new Float64Array(COLUMN_SAMPLES + 1);
  const widths = new Float64Array(COLUMN_SAMPLES + 1);
  const point = new THREE.Vector3();

  for (let column = 0; column < PROFILE_WIDTH; column++) {
    const t = (column + 0.5) / PROFILE_WIDTH;

    for (let i = 0; i <= COLUMN_SAMPLES; i++) {
      innerSurfacePoint(t, i / COLUMN_SAMPLES, point);
      heights[i] = point.y;
      // At the fine bow the thickness setback crosses the centerline and X comes out
      // negative: there is no interior space there at all, and zero is the right
      // answer.
      widths[i] = Math.max(point.x, 0);
    }

    let i = 0;
    for (let row = 0; row < PROFILE_HEIGHT; row++) {
      const y = PROFILE_Y_MIN + ((row + 0.5) / PROFILE_HEIGHT) * PROFILE_Y_RANGE;
      // Below the planking's bottom there is no space: it is the lower hold, solid wood
      // and framing. It stays at zero, and the sea goes on being there unseen.
      if (y < heights[0]!) continue;

      while (i < COLUMN_SAMPLES - 1 && heights[i + 1]! < y) i++;

      let halfWidth: number;
      if (y >= heights[COLUMN_SAMPLES]!) {
        // Above the rail the profile **holds** the last value instead of falling to
        // zero. Letting it fall would create a wedge of unclipped sea stuck to the top
        // of the bulwark, at the one height where the water does come in over the rail.
        // By holding, the volume ends on a clean edge at `PROFILE_Y_MAX`.
        halfWidth = widths[COLUMN_SAMPLES]!;
      } else {
        const span = heights[i + 1]! - heights[i]!;
        const s = span > 1e-6 ? (y - heights[i]!) / span : 0;
        halfWidth = widths[i]! + (widths[i + 1]! - widths[i]!) * s;
      }

      data[row * PROFILE_WIDTH + column] = Math.round(clamp01(halfWidth / PROFILE_SCALE) * 255);
    }
  }

  const texture = new THREE.DataTexture(
    data,
    PROFILE_WIDTH,
    PROFILE_HEIGHT,
    THREE.RedFormat,
    THREE.UnsignedByteType,
  );
  // Bilinear and no mipmap: the sampling happens inside conditional flow, and asking for
  // a level of detail there is undefined behavior in GLSL ES 1.00.
  texture.minFilter = THREE.LinearFilter;
  texture.magFilter = THREE.LinearFilter;
  texture.wrapS = THREE.ClampToEdgeWrapping;
  texture.wrapT = THREE.ClampToEdgeWrapping;
  texture.generateMipmaps = false;
  texture.needsUpdate = true;
  return texture;
}

let sharedProfile: THREE.DataTexture | null = null;

/**
 * The profile, built once and lent to whoever needs it.
 *
 * Two consumers read the same table for opposite reasons: the sea erases what falls
 * **inside** the hull, and the hold's water erases what falls **outside**. Building the
 * profile twice would be paying twice for identical bytes — and, worse, it would open the
 * chance of the two diverging.
 *
 * Nobody disposes of this texture: it lives as long as the page lives, costs 12 KB and is
 * recreated for free if it is ever needed again.
 */
export function getHullProfileTexture(): THREE.DataTexture {
  sharedProfile ??= buildHullProfileTexture();
  return sharedProfile;
}

/** The profile's constants, for whoever writes another shader on top of it. */
export const HULL_PROFILE = {
  yMin: PROFILE_Y_MIN,
  yMax: PROFILE_Y_MAX,
  yRange: PROFILE_Y_RANGE,
  scale: PROFILE_SCALE,
  margin: CLIP_MARGIN,
} as const;

/**
 * The matrix for unused hull slots.
 *
 * It throws the world ten thousand kilometers above the ship, well outside the profile's
 * box. It is what does away with a count uniform: the loop always runs `HULL_CLIP_MAX`
 * times, and the empty slots simply never land inside — no `break`, no `continue`, no
 * uniform-dependent branching.
 */
export const HULL_CLIP_ELSEWHERE = new THREE.Matrix4().makeTranslation(0, 1e7, 0);

/**
 * Declares the uniforms and the `insideHull(vec3)` function, in world space.
 *
 * The constants are interpolated in from TypeScript on purpose: the profile's box and its
 * scale have to be exactly the ones the texture was written with, and duplicating them by
 * hand in GLSL is the kind of divergence that only shows up as a centimeter of gap six
 * months later.
 */
export const HULL_CLIP_GLSL = /* glsl */ `
#define HULL_CLIP_MAX ${HULL_CLIP_MAX}

uniform mat4 uHullClipInverse[HULL_CLIP_MAX];
uniform sampler2D uHullProfile;

/** True when the point is inside some hull's planking. */
bool insideHull(vec3 worldPosition) {
  bool inside = false;

  for (int i = 0; i < HULL_CLIP_MAX; i++) {
    vec3 local = (uHullClipInverse[i] * vec4(worldPosition, 1.0)).xyz;

    vec2 uv = vec2(
      (${HALF_LENGTH.toFixed(4)} - local.z) / ${HULL_LENGTH.toFixed(4)},
      (local.y - (${PROFILE_Y_MIN.toFixed(4)})) / ${PROFILE_Y_RANGE.toFixed(4)}
    );
    bool within = all(greaterThan(uv, vec2(0.0))) && all(lessThan(uv, vec2(1.0)));

    // The margin only comes in where there is interior space: added on top of a zero
    // profile it would open a 10 cm gap of missing sea along the centerline, above the
    // bulwark and below the keel.
    float halfWidth = texture2D(uHullProfile, uv).r * ${PROFILE_SCALE.toFixed(4)};
    bool solid = within && halfWidth > 0.0 && abs(local.x) < halfWidth + ${CLIP_MARGIN.toFixed(4)};

    inside = inside || solid;
  }

  return inside;
}
`;
