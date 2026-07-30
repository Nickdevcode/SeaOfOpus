/**
 * The mark a shot leaves on the side.
 *
 * The breach used to be a black nine-sided disc, and its problem was not being ugly — it
 * was not being **legible**. A flat disc in the middle of a dark side does not say where
 * the ball hit; it says something is missing there. What gives a real breach away, and
 * what Sea of Thieves gets right, is what is **around** it: the soot the ball scatters,
 * the plank's pale core laid bare when the weathered surface was torn off, and the
 * splinters left pointing outward. The hole is the smallest part of the mark.
 *
 * So this piece draws three rings instead of one disc:
 *
 * | zone | radius | what it is |
 * |---|---|---|
 * | hole | up to `HOLE_R` | the hold, seen from outside. Genuinely dark |
 * | splinter | up to `LIP_R` | the plank's core, pale, with grain and relief |
 * | soot | up to 1 | the blast's stain, fading into sound wood |
 *
 * **Three decisions worth the comment:**
 *
 * 1. **The silhouette is irregular, and the irregularity lives on both sides.** The same
 *    `breachWobble` function deforms the vertices in the vertex shader and decides where
 *    each color zone begins in the fragment shader. If the two drifted apart, the paint
 *    would slide out of the shape — which is exactly the defect that makes a decal look
 *    like a sticker.
 *
 * 2. **The hole has no geometric depth, it has parallax.** Sinking the mesh into the hull
 *    does not work: the side is opaque and the z-buffer would hide it. So the bottom is
 *    sampled with an offset proportional to the view direction, and the hole *slides*
 *    when the camera moves — which is the only depth cue the eye really uses at this
 *    distance.
 *
 * 3. **The splinters, those are geometry.** They rise `SPLINTER_RISE` **out of** the
 *    side, where there is no z-buffer to fight, and they are where the broken silhouette
 *    you catch at a glancing angle comes from — the thing no texture imitates.
 *
 * The material is a `MeshStandardMaterial` stitched by `onBeforeCompile`, and not a
 * `ShaderMaterial` from scratch, because that way the breach gets the same sun, the same
 * shadows, the same fog and the same tone mapping as the hull it is pinned to, for free.
 * A shader of its own would have to reimplement all of that just to keep the collage from
 * showing on a stormy day.
 */

import * as THREE from 'three';
import { NOISE_GLSL } from '../shaders/noise';

/**
 * The mark's colors, written in sRGB and handed to the shader in linear.
 *
 * The conversion is not a detail: `diffuseColor` lives in linear space, and the rest of
 * the ship's colors get there through the texture, which Three converts on its own. A
 * hand-written color skips that step — and writing `0.36` thinking it is the same `0.36`
 * as the side puts the wood **ten times** brighter than it. The symptom was a white crown
 * around the hole, looking like sea foam.
 *
 * The values come out of the palette `ShipMaterials` already uses: the side is `0.2` at
 * the base and the deck `0.56`. The exposed core has to land between the two — it is new
 * wood, but it is wood from inside a tarred plank, not deck planking sanded by the salt.
 */
const COLORS = {
  /** The plank's core, opened by the ball. The brightest part of the mark. */
  board: 0x7d5e3b,
  /** The hole's immediate rim: wood scorched by the ball going through. */
  char: 0x241a12,
  /** The cut through the side's thickness, seen edge-on from inside the hole. */
  wall: 0x15100b,
  /** The hold. It is not black out of elegance — it is black because no light gets in. */
  void: 0x050404,
  /**
   * The repair's plank, seen **through the hole**, from outside the hull.
   *
   * The patch is nailed on the inside (see `DamageView.PLANK_DEPTH`), so the hole in the
   * side is still there after it is closed — what changed is what you see at the bottom
   * of it. Brighter than the splintered core because it is wood that never caught sun or
   * tar.
   */
  patch: 0x8f7049,
  /** The stain of soot the blast leaves on the sound wood around it. */
  soot: 0x120d0a,
  /**
   * The plank's core seen **from inside**, where the ball came out.
   *
   * Brighter than `board` because this wood never saw tar or sun: the side is payed on
   * the outside, and what the exit face exposes is the raw oak from the middle of the
   * plank. It is that contrast — and not the hole — that gets the breach found in the
   * dark of the hold.
   *
   * The value has to be measured against the **inner planking**, and not against the
   * side. A first version came out at 0x9a7548, one shade above `board`, and the
   * difference evaporated: in the hold the core measured **darker** than the plank beside
   * it, and the open breach turned into a dirty smudge instead of torn-out wood. This
   * shade lands between the side's base (0.2 linear) and the deck's (0.56) — it is new
   * wood, but wood from the middle of a tarred plank, not deck planking sanded by the
   * salt.
   */
  rawBoard: 0xb28a5c,
  /**
   * The bottom of the hole seen from inside.
   *
   * It is **not** a window onto the sea. A gap showing ocean reads as a hole cut in
   * scenery: what is really there is soaked wood with water coming in, and the eye
   * recognizes that as a hole far faster than it would recognize a fist-sized piece of
   * horizon.
   */
  flood: 0x081413,
} as const;

/** `vec3(r, g, b)` in linear, ready to paste into the GLSL. */
function linearGlsl(hex: number): string {
  const color = new THREE.Color(hex).convertSRGBToLinear();
  return `vec3(${color.r.toFixed(5)}, ${color.g.toFixed(5)}, ${color.b.toFixed(5)})`;
}

/**
 * Radius of the real hole, as a fraction of the mark's radius.
 *
 * With the typical 45 cm radius it gives a 31 cm gap, which is the number
 * `ShipDamage.BREACH_AREA` was already using to compute the inflow — *"a 10 cm ball does
 * not open a 10 cm hole: it shatters the plank and carries off a piece some 30 cm
 * across"*. The drawn hole and the hole the water goes through become the same hole, and
 * it is the rest of the mark — over half a meter of soot — that answers the question of
 * where the ball hit.
 */
const HOLE_R = 0.34;
/** How far the splintered core reaches. Past this it is all soot. */
const LIP_R = 0.6;

/**
 * How far the splinters rise above the side, as a fraction of the radius.
 *
 * With the typical 45 cm radius it gives 4.5 cm of standing wood — the right order of
 * magnitude for a shattered 13 cm side, and enough for the silhouette to show against the
 * sky when you look along the hull.
 */
const SPLINTER_RISE = 0.1;

/**
 * Apparent depth of the hole, as a fraction of the radius.
 *
 * It is not a measurement of the hull: it is how far the bottom slides per unit of view
 * tilt. Half a radius is what makes the hole read as a hole without the slide giving the
 * sham away at a grazing angle.
 */
const HOLE_DEPTH = 0.5;

/** Segments around. 24 already gives a broken rim without counting wasted triangles. */
const SEGMENTS = 24;

/**
 * Radial profile of the mark, from the center outward.
 *
 * `edge` is how much that ring obeys the angular deformation — maximum at the hole's lip,
 * which is where the wood burst, and zero at both ends, so the center does not spin for
 * nothing and the outer rim closes round against the sound wood.
 *
 * `rise` is the splinter's height, as a fraction of `SPLINTER_RISE`.
 */
const RINGS: readonly { r: number; edge: number; rise: number }[] = [
  { r: 0.0, edge: 0.0, rise: 0.0 },
  { r: 0.2, edge: 0.3, rise: 0.0 },
  { r: HOLE_R, edge: 1.0, rise: 0.0 },
  { r: 0.46, edge: 0.9, rise: 1.0 },
  { r: LIP_R, edge: 0.7, rise: 0.45 },
  { r: 0.8, edge: 0.3, rise: 0.05 },
  { r: 1.0, edge: 0.0, rise: 0.0 },
];

/**
 * Angular deformation of the mark — the same one in the vertex and in the fragment.
 *
 * Harmonics instead of sampled noise: that way it is periodic in 2π **by construction**,
 * and the ring's seam closes without a join. A `snoise(θ)` would need a circular domain
 * so as not to step at θ = π.
 */
const WOBBLE_GLSL = /* glsl */ `
  float breachWobble(float ang, float seed) {
    return 0.42 * sin(3.0 * ang + seed * 6.2831)
         + 0.24 * sin(5.0 * ang - seed * 11.0 + 1.7)
         + 0.19 * sin(9.0 * ang + seed * 17.0 + 3.1)
         + 0.15 * sin(14.0 * ang - seed * 23.0 + 0.6);
  }
`;

/**
 * How much wider than tall the hole is.
 *
 * Wood does not open a round hole. It splits **along the grain**, and the side's grain
 * runs fore and aft — which is the mark's X. The same blow that tears 30 cm horizontally
 * tears some 20 vertically, and it is that difference that makes the damage read as wood
 * instead of plate.
 */
const FIBER_STRETCH = 1.35;

/**
 * What separates the face the ball goes **in** through from the face it comes **out** of.
 *
 * The same mark mirrored will not do, and that is the one thing that really matters in
 * this block. In a plank, the exit side splinters far more than the entry side: it is
 * *spall*, and on a ship of the line the shower of splinters it raised wounded more
 * people than the ball itself. On the entry the powder rules — soot, scorched rim,
 * compressed wood. On the exit the fiber rules — a big splinter, raw pale wood, almost no
 * burn.
 *
 * There is a second reason, one of legibility, and it pulls the same way. From outside,
 * the breach competes for attention with a whole hull under the sun. From inside, it is
 * the only thing happening in a dark hold, and it is what the player is looking for when
 * they come down with a plank in hand. The inner face may — and should — shout louder
 * than the outer one.
 */
interface BreachFace {
  /** Suffix of the program's cache key. Two faces, two shaders. */
  readonly id: string;
  /** Multiplies the splinters' height. The exit splinters more than the entry. */
  readonly riseScale: number;
  /**
   * The splinters' height with the breach patched, as a fraction of the open height.
   *
   * Nailing a plank up **flattens** whatever was standing — but the real number comes
   * from a space constraint: the plank rests a few centimeters from the mark (see
   * `DamageView.PLANK_DEPTH`), and a splinter that does not come down far enough goes
   * through the wood that was just nailed up.
   */
  readonly closedRise: number;
  /** How far the pale core advances over the soot. */
  readonly lipScale: number;
  /** Weight of the soot on the sound wood around it. */
  readonly sootWeight: number;
  /** Weight of the burn on the hole's immediate rim. */
  readonly charWeight: number;
  /** Color of the exposed core. */
  readonly boardColor: number;
  /** What you see at the bottom of the open hole. */
  readonly voidColor: number;
  /** Roughness of the hole's bottom. Soaked wood reflects; pitch does not. */
  readonly voidRoughness: number;
  /** How much light is left at the bottom of the open hole. */
  readonly voidOcclusion: number;
  /**
   * How much light is left on the exposed core.
   *
   * On the outside the core sits in a shallow pit and receives less sky than the surface
   * around it — the shadow is what gives the reading of depth under the open sun. On the
   * inside there is no sky at all: the hold's light is ambient and weak, and the same
   * shadow only puts out the one thing that gives the breach away in there.
   */
  readonly boardOcclusion: number;
}

/** The outer face: the ball going in. Powder, soot and compressed wood. */
const OUTER_FACE: BreachFace = {
  id: 'outer',
  riseScale: 1,
  closedRise: 0.32,
  lipScale: 1,
  sootWeight: 0.6,
  charWeight: 0.7,
  boardColor: COLORS.board,
  voidColor: COLORS.void,
  voidRoughness: 1,
  voidOcclusion: 0.05,
  boardOcclusion: 0.72,
};

/**
 * The inner face: the ball coming out. Torn raw oak and water coming in.
 *
 * The two height numbers are arithmetic, not taste:
 *
 * **`riseScale`** raises the splinter from 4.5 to 7.6 cm in a typical breach. Half again
 * as much as the entry face, which is the difference you want — but not much more: the
 * side is 13 cm, and a splinter anywhere near that stops reading as torn-out wood and
 * becomes a doughnut glued to the wall.
 *
 * **`closedRise`** is the more fragile of the two, and the number comes from the **worst
 * case**, not the typical one. With the breach patched, the inner mark lives in a 4 mm
 * gap between the planking and the plank's face (see `INNER_DECAL_DEPTH_CLOSED`, in
 * `DamageView`), and the splinter's height scales with the radius, because the instance
 * is scaled as a whole — and a breach can be widened to `MAX_BREACH_SCALE`, 2.2× the area
 * and 1.48× the radius. On the largest possible breach this fraction gives 2.2 mm, which
 * fits. Calibrating for the typical breach would leave the wood going through the plank
 * that was just nailed up, and only at the end of a long fight — the worst kind of
 * defect, because it shows up exactly when nobody is looking at the wall.
 *
 * Losing the splinter once the plank is up does not cost the reading, by the way. What
 * gives the closed scar away is the **pale core**, which is paint and not geometry, and
 * the plank is 22 cm wide against nearly 1 m of mark: what is left escapes around its
 * **sides**, not over the top.
 */
const INNER_FACE: BreachFace = {
  id: 'inner',
  riseScale: 1.5,
  closedRise: 0.02,
  lipScale: 1.25,
  // The powder burns on the outside. What reaches here is the leftover smoke that came
  // through the hole — almost all of it disappears, and it is precisely that
  // disappearance that lets the pale wood do the job of being seen.
  sootWeight: 0.12,
  charWeight: 0.15,
  boardColor: COLORS.rawBoard,
  voidColor: COLORS.flood,
  // Wet, not mirrored. The reflection is half of what makes the bottom read as water
  // coming in instead of black paint — but below ~0.4 the hole starts sending back a
  // white specular highlight when the sun comes through the hatch, and a glint in the
  // middle of the hole undoes the hole.
  voidRoughness: 0.5,
  voidOcclusion: 0.18,
  boardOcclusion: 1,
};

/**
 * Assembles the disc of rings with the attributes the shader reads.
 *
 * The mesh is born **flat** in Z: what raises the splinters is the vertex shader, because
 * each one's height depends on the angle *and* on the instance's draw, and baking that
 * into the geometry would give the same splinter on all twenty-four breaches.
 *
 * `aSlope` is the profile's radial slope, computed here by differencing neighboring
 * rings. It exists so the normal follows the splinter: without it the raised wood takes
 * the light as if it were flat, and the relief would only show in the silhouette.
 */
export function buildBreachGeometry(): THREE.BufferGeometry {
  const rings = RINGS.length;
  const count = rings * SEGMENTS;

  const positions = new Float32Array(count * 3);
  const normals = new Float32Array(count * 3);
  const edges = new Float32Array(count);
  const rises = new Float32Array(count);
  const slopes = new Float32Array(count);

  for (let i = 0; i < rings; i++) {
    const ring = RINGS[i]!;
    const previous = RINGS[i - 1] ?? ring;
    const next = RINGS[i + 1] ?? ring;

    // Central slope: it climbs from the inner ring to the outer one. The sign is what
    // tips the normal outward on the splinter's rise and back on its fall.
    const dr = next.r - previous.r;
    const slope = dr > 1e-6 ? ((next.rise - previous.rise) * SPLINTER_RISE) / dr : 0;

    for (let j = 0; j < SEGMENTS; j++) {
      const angle = (j / SEGMENTS) * Math.PI * 2;
      const index = i * SEGMENTS + j;

      positions[index * 3] = Math.cos(angle) * ring.r;
      positions[index * 3 + 1] = Math.sin(angle) * ring.r;
      positions[index * 3 + 2] = 0;

      // Rewritten in the vertex shader from `aSlope`; the value here only has to be
      // valid so Three does not complain about the missing attribute.
      normals[index * 3 + 2] = 1;

      edges[index] = ring.edge;
      rises[index] = ring.rise;
      slopes[index] = slope;
    }
  }

  const indices: number[] = [];
  for (let i = 0; i < rings - 1; i++) {
    for (let j = 0; j < SEGMENTS; j++) {
      const next = (j + 1) % SEGMENTS;
      const a = i * SEGMENTS + j;
      const b = i * SEGMENTS + next;
      const c = (i + 1) * SEGMENTS + j;
      const d = (i + 1) * SEGMENTS + next;
      indices.push(a, c, b, b, c, d);
    }
  }

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  geometry.setAttribute('normal', new THREE.BufferAttribute(normals, 3));
  geometry.setAttribute('aEdge', new THREE.BufferAttribute(edges, 1));
  geometry.setAttribute('aRise', new THREE.BufferAttribute(rises, 1));
  geometry.setAttribute('aSlope', new THREE.BufferAttribute(slopes, 1));
  geometry.setIndex(indices);
  // The disc lives inside radius 1 plus the splinter; the automatic sphere would get it
  // wrong because the mesh is born flat and only grows in the shader.
  geometry.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1.3);
  return geometry;
}

const VERTEX_HEAD = /* glsl */ `
  attribute float aEdge;
  attribute float aRise;
  attribute float aSlope;
  attribute float aSeed;
  attribute float aOpen;

  varying vec2 vBreachLocal;
  varying vec3 vBreachView;
  varying float vBreachSeed;
  varying float vBreachOpen;

  ${WOBBLE_GLSL}
`;

/**
 * Deforms the disc and measures the view direction in the mark's frame.
 *
 * The instance's basis is orthonormal (rotation and uniform scale only), so the transpose
 * serves as the inverse and the camera's direction comes out of three dot products — with
 * no matrix inversion in the vertex shader.
 */
const vertexBody = (face: BreachFace): string => /* glsl */ `
  float breachAngle = atan(position.y, position.x);
  float breachW = breachWobble(breachAngle, aSeed);

  // A patched breach loses the hole but keeps the scar: the plank is nailed over the
  // broken wood, not in its place. The splinters come down because nailing a plank up
  // **flattens** whatever was standing — and because, if they did not, they would go
  // through the wood that was just nailed up.
  transformed.xy *= 1.0 + aEdge * breachW * 0.2;
  float breachRise = mix(${face.closedRise.toFixed(4)}, 1.0, aOpen) * ${face.riseScale.toFixed(4)};
  transformed.z += aRise * ${SPLINTER_RISE.toFixed(4)} * breachRise * (0.55 + 0.45 * breachW);

  // The fragment receives the coordinate **before** the stretch: that way it goes on
  // reasoning in a circle, and the grain's flattening comes for free when the mesh is
  // laid onto the side.
  vBreachLocal = transformed.xy;
  transformed.x *= ${FIBER_STRETCH.toFixed(4)};

  // The slope follows the splinter's **real height**, and not just the profile baked
  // into the geometry: aSlope measures the ramp with the splinters standing, and a face
  // that raises them twice as high (or a scar that flattens them to a seventh) has a ramp
  // in the same proportion. Without this multiplication the inner wood would take the
  // outer wood's light, and the relief would only exist in the silhouette.
  float breachSlope = aSlope * breachRise;
  objectNormal = normalize(vec3(
    -breachSlope * cos(breachAngle),
    -breachSlope * sin(breachAngle),
    1.0
  ));
  #ifdef USE_TANGENT
    objectTangent = vec3(1.0, 0.0, 0.0);
  #endif

  #ifdef USE_INSTANCING
    mat4 breachMatrix = modelMatrix * instanceMatrix;
  #else
    mat4 breachMatrix = modelMatrix;
  #endif

  vec3 breachWorld = (breachMatrix * vec4(transformed, 1.0)).xyz;
  vec3 toCamera = cameraPosition - breachWorld;
  vBreachView = vec3(
    dot(toCamera, normalize(breachMatrix[0].xyz)),
    dot(toCamera, normalize(breachMatrix[1].xyz)),
    dot(toCamera, normalize(breachMatrix[2].xyz))
  );

  vBreachSeed = aSeed;
  vBreachOpen = aOpen;
`;

const FRAGMENT_HEAD = /* glsl */ `
  varying vec2 vBreachLocal;
  varying vec3 vBreachView;
  varying float vBreachSeed;
  varying float vBreachOpen;

  ${NOISE_GLSL}
  ${WOBBLE_GLSL}
`;

/**
 * Paints the three zones and returns, besides the color, the occlusion that puts out the
 * light inside the hole.
 *
 * The occlusion is kept separate from the color on purpose. Painting the bottom black is
 * not enough: with the sun abeam, `MeshStandardMaterial` would light the black up to gray
 * and the hole would turn into a pale smudge. Multiplying the **outgoing light** is what
 * keeps the inside dark at any hour of the day — which is what a hole does.
 */
const fragmentBody = (face: BreachFace): string => /* glsl */ `
  // The coordinate arrives here **before** the grain's stretch (see the vertex shader),
  // and that is why everything below goes on being circle arithmetic: the flattening is
  // applied on the geometry's output, not in the zones' computation.
  float breachR = length(vBreachLocal);
  float breachAngle = atan(vBreachLocal.y, vBreachLocal.x);
  float breachW = breachWobble(breachAngle, vBreachSeed);

  // The hole exists **closed or open**: the plank is nailed on the inside, so what the
  // patch changes is not the hole's existence in the side, it is what you see at the
  // bottom of it. Before, the hole simply vanished when it closed, and a hull that
  // stopped taking water with nothing happening to the wood was the least convincing part
  // of the whole thing.
  float holeR = ${HOLE_R.toFixed(4)} * (1.0 + 0.2 * breachW);
  // The pale core advances over the soot on the exit face: it is what carries the
  // breach's reading, and in the dark of the hold it needs more area. The ceiling is the
  // mesh's rim — a lipScale above ~1.35 would push the band past radius 1 and the core
  // would start being cut off by the end of the geometry instead of dying in the noise.
  float lipR = ${(LIP_R * face.lipScale).toFixed(4)} * (1.0 + 0.22 * breachW);

  // The bottom slides with the view: this is where the hole's depth comes from. With the
  // breach patched the bottom is right there, 13 cm away — the slide shrinks along.
  vec3 breachView = normalize(vBreachView);
  float slideDepth = ${HOLE_DEPTH.toFixed(4)} * mix(0.22, 1.0, vBreachOpen);
  vec2 slide = breachView.xy / max(breachView.z, 0.35) * slideDepth;
  float bottomR = length(vBreachLocal + slide);

  // The wood's grain. The mark's X axis follows the side's planking (see orientDecal, in
  // DamageView), so the grain runs in X: a low frequency on that axis and a high one on
  // the other is what makes a **line** instead of a speckle. A first version used 34
  // cycles on both axes and what came out was a coral pattern, which is the opposite of
  // wood grain.
  float grain = fbm(vec2(vBreachLocal.x * 1.6, vBreachLocal.y * 9.0) + vBreachSeed * 21.0, 2, 2.2, 0.5);
  // Fine cracks, in the same direction as the grain and tighter.
  float split = fbm(vec2(vBreachLocal.x * 3.0, vBreachLocal.y * 22.0) + vBreachSeed * 5.0, 2, 2.0, 0.5);
  float soot = fbm(vec2(vBreachLocal * 4.5) + vBreachSeed * 13.0, 4, 2.1, 0.5);

  vec3 boardColor = ${linearGlsl(face.boardColor)} * (0.72 + 0.46 * grain);
  // The cracks come in as shadow inside the core, not as a new color.
  boardColor *= 1.0 - 0.45 * smoothstep(0.25, 0.72, split);

  // The burn is a **crust** stuck to the hole, and not half the mark. It once covered
  // 55% of the core's band, and the result was a breach that disappeared into the side:
  // on a nearly black tarred hull, what gives the damage away is the pale wood — putting
  // it out is putting the breach out.
  float charred = 1.0 - smoothstep(holeR, holeR + (lipR - holeR) * 0.22, breachR);
  boardColor = mix(boardColor, ${linearGlsl(COLORS.char)}, charred * ${face.charWeight.toFixed(3)});

  // The hole's bottom: the hold, if it is open; the new plank nailed on the inside, if
  // it has been patched. The wall is the cut through the side's thickness in both cases,
  // and it only shows when you look at it edge-on.
  vec3 patchWood = ${linearGlsl(COLORS.patch)} * (0.82 + 0.3 * grain);
  vec3 floorColor = mix(patchWood, ${linearGlsl(face.voidColor)}, vBreachOpen);
  vec3 sideColor = mix(patchWood * 0.55, ${linearGlsl(COLORS.wall)}, vBreachOpen);
  vec3 holeColor = mix(floorColor, sideColor, smoothstep(holeR * 0.55, holeR, bottomR));

  // Splits. A ball does not only make a hole: it **splits** the planks, and the split
  // runs along the grain, crossing the damage's rim into the sound wood. It is the thing
  // that most separates "a ball hole in wood" from "a ball hole in anything else", and it
  // is straight — it does not follow the hole's outline.
  float fiber = abs(fract(vBreachLocal.y * 6.0 + vBreachSeed * 4.0) - 0.5);
  float crack = smoothstep(0.11, 0.01, fiber)
    * (1.0 - smoothstep(holeR * 0.7, 1.05, abs(vBreachLocal.x)))
    * (1.0 - smoothstep(holeR * 0.5, holeR * 1.8, abs(vBreachLocal.y)));

  float inHole = 1.0 - smoothstep(holeR - 0.03, holeR, breachR);
  // The core's rim is eaten by the noise: without this the lip closes a perfect ring,
  // and a perfect ring is a decal's signature.
  float inBoard = 1.0 - smoothstep(lipR - 0.05, lipR + 0.12, breachR + split * 0.08);

  vec3 breachColor = mix(boardColor, holeColor, inHole);
  // Soot: it darkens the sound wood instead of painting over it, and it darkens
  // **blotchy** — a solid stain around the hole reads as texture grime, not as burnt
  // powder.
  float sootMask = (1.0 - inBoard) * smoothstep(-0.25, 0.55, soot);
  breachColor = mix(breachColor, ${linearGlsl(COLORS.soot)}, sootMask * ${face.sootWeight.toFixed(3)});

  // The splits are void, and void takes no light: they darken over any zone they fall
  // on, including over the sound wood.
  breachColor = mix(breachColor, ${linearGlsl(COLORS.wall)}, crack * 0.8 * (1.0 - inHole));

  // The outer rim is not a circle: it dies out with the noise, or else the decal
  // announces its own radius.
  float fade = 1.0 - smoothstep(0.5, 1.05, breachR + soot * 0.26);
  float breachAlpha = max(max(inBoard, crack), fade * 0.8);

  diffuseColor.rgb = breachColor;
  diffuseColor.a *= breachAlpha;

  // The hole's bottom in the dark, and the soot eats part of the light that is left.
  // Patched, the bottom is wood 13 cm from the hole's mouth: it sits in the hole's own
  // shadow, not in the pitch of the hold.
  float breachOcclusion = mix(1.0, mix(0.42, ${face.voidOcclusion.toFixed(3)}, vBreachOpen), inHole);
  breachOcclusion *= mix(1.0, 0.55, sootMask);
  // The core sits in a shallow pit and receives less sky than the surface around it —
  // where there is sky. See boardOcclusion.
  breachOcclusion *= mix(1.0, ${face.boardOcclusion.toFixed(3)}, inBoard * (1.0 - inHole));
  breachOcclusion *= mix(1.0, 0.2, crack * (1.0 - inHole));
`;

export interface BreachMaterialOptions {
  /** Roughness of the exposed core. Broken wood reflects almost nothing. */
  roughness?: number;
}

/** Which of the side's two faces this mark draws. */
export type BreachSide = 'outer' | 'inner';

const FACES: Readonly<Record<BreachSide, BreachFace>> = {
  outer: OUTER_FACE,
  inner: INNER_FACE,
};

/**
 * The mark's material: a `MeshStandardMaterial` with the procedural paint injected.
 *
 * `polygonOffset` is still here for the same reason as before — the mark sits millimeters
 * from the side and without the nudge in the z-buffer the two surfaces fight. `depthWrite`
 * stays on, unlike what you do with an ordinary transparent decal: the splinters are real
 * geometry and have to occlude each other.
 */
export function createBreachMaterial(
  side: BreachSide = 'outer',
  options: BreachMaterialOptions = {},
): THREE.MeshStandardMaterial {
  const face = FACES[side];
  const material = new THREE.MeshStandardMaterial({
    color: 0xffffff,
    roughness: options.roughness ?? 0.94,
    metalness: 0,
    transparent: true,
    // The soot dies out in a gradient and the hole is opaque: without the alpha cutoff
    // the gradient would write depth and cut out whatever passes behind it.
    alphaTest: 0.02,
    side: THREE.DoubleSide,
    polygonOffset: true,
    polygonOffsetFactor: -4,
    polygonOffsetUnits: -4,
  });

  material.onBeforeCompile = (shader) => {
    shader.vertexShader = VERTEX_HEAD + shader.vertexShader;
    shader.vertexShader = shader.vertexShader.replace(
      '#include <begin_vertex>',
      `#include <begin_vertex>\n${vertexBody(face)}`,
    );
    // The normal is rewritten after `beginnormal_vertex`, which is where `objectNormal`
    // is born — before it the symbol does not even exist.
    shader.vertexShader = shader.vertexShader.replace(
      '#include <beginnormal_vertex>',
      `#include <beginnormal_vertex>\n  objectNormal = vec3(0.0, 0.0, 1.0);`,
    );

    shader.fragmentShader = FRAGMENT_HEAD + shader.fragmentShader;
    shader.fragmentShader = shader.fragmentShader.replace(
      '#include <color_fragment>',
      `#include <color_fragment>\n${fragmentBody(face)}`,
    );
    // `roughnessFactor` is only born in the roughness map's chunk, which comes
    // **after** the color one — touching it up there would not compile. Broken wood is
    // rougher than the tarred side: without this line the core picks up a plastic
    // specular sheen.
    //
    // The hole's bottom is the exception, and it is per face. On the outside it is the
    // pitch of the hold, which reflects nothing; on the inside it is soaked wood with the
    // sea coming in, and it is precisely the reflection that makes it read as wet instead
    // of painted black.
    shader.fragmentShader = shader.fragmentShader.replace(
      '#include <roughnessmap_fragment>',
      `#include <roughnessmap_fragment>
  roughnessFactor = mix(roughnessFactor, 1.0, charred * 0.6);
  roughnessFactor = mix(roughnessFactor, ${face.voidRoughness.toFixed(3)}, inHole);`,
    );
    // `breachOcclusion` is declared in the block above and is still in scope here:
    // Three's `#include`s are text pasted inside the same `main`.
    shader.fragmentShader = shader.fragmentShader.replace(
      '#include <opaque_fragment>',
      `outgoingLight *= breachOcclusion;\n#include <opaque_fragment>`,
    );
  };

  // Without this Three reuses a program compiled from another of the ship's
  // `MeshStandardMaterial`s and the injection never reaches the GPU. And the face's suffix
  // is not decoration: the two marks are the same `MeshStandardMaterial` with the same
  // configuration, so a single key would make the second one receive the shader compiled
  // for the first — the inner face would come out identical to the outer one, and the bug
  // would look like "it did not work" instead of "cache".
  material.customProgramCacheKey = () => `breach-decal-${face.id}`;
  return material;
}
