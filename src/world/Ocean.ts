/**
 * The sea: a radial mesh centered on the camera + the water's full material.
 *
 * **The mesh.** Concentric rings with radii in geometric progression. That is the
 * distribution that makes every triangle take up roughly the same size on screen: near
 * the bow they are centimeters across, at 3 km they are tens of meters, and the whole
 * horizon is covered with ~120 thousand triangles instead of the millions a uniform grid
 * would need. The whole mesh is translated to the camera's XZ every frame; since the
 * displacement is computed from the world coordinate, the wave pattern stays locked to
 * the world and does not slide along.
 *
 * **The surface.** The displacement comes from `WaveField` (the same function the
 * buoyancy uses on the CPU), but the normal and the Jacobian are recomputed **per
 * pixel**, not interpolated from the vertices. It costs some 200 ALU per fragment and
 * pays back with interest: the wave has correct relief out to where the mesh is already
 * coarse.
 *
 * **The color.** No pre-baked cubemap — the reflection reads the same atmospheric LUT the
 * sky draws. That is why the sea really follows the sunset, and it is also what makes the
 * horizon close without a seam: the distance fog mixes the sea's pixel with the sky's
 * color in that exact direction.
 */

import * as THREE from 'three';
import { EQUIRECT_GLSL } from '../shaders/atmosphere';
import {
  HULL_CLIP_ELSEWHERE,
  HULL_CLIP_GLSL,
  HULL_CLIP_MAX,
  getHullProfileTexture,
} from '../shaders/hullClip';
import { NOISE_GLSL } from '../shaders/noise';
import type { QualitySettings } from '../core/Settings';
import { WAVE_GLSL, type WaveField } from './WaveField';

/**
 * Sea of Thieves' palette: petrol blue in the trough, emerald on the crest.
 *
 * Exported because `SkyEnvironment` has to paint the reflection environment's lower half
 * with the same water the sea draws — if the two colors diverge, the deck's metal will
 * reflect an ocean of another color.
 */
export const OCEAN_DEEP_COLOR = new THREE.Color(0.012, 0.062, 0.098);
export const OCEAN_SHALLOW_COLOR = new THREE.Color(0.045, 0.2, 0.215);

/** Where the mesh begins. Below it there is a central fan, hidden by the hull. */
const INNER_RADIUS = 1.5;
/** The water's reach. It stays inside the sky dome (9000). */
const OUTER_RADIUS = 8000;

interface RadialMesh {
  geometry: THREE.BufferGeometry;
  /**
   * Spacing between vertices divided by the radius — constant across the whole mesh, by
   * construction. The vertex shader multiplies it by the local radius to know, in meters,
   * how much it can resolve there, and filters the waves by that.
   */
  spacingFactor: number;
}

/**
 * Builds the radial mesh in local coordinates (XZ, y = 0).
 *
 * Layout: vertex 0 at the center, then `rings + 1` circles of `segments` vertices. The
 * rings grow by a constant factor — hence the triangles' uniform apparent size.
 */
function buildRadialGeometry(rings: number, segments: number): RadialMesh {
  const ringCount = rings + 1;
  const vertexCount = 1 + ringCount * segments;

  const positions = new Float32Array(vertexCount * 3);
  const growth = Math.pow(OUTER_RADIUS / INNER_RADIUS, 1 / rings);

  let offset = 3; // the central vertex is already (0, 0, 0)
  for (let ring = 0; ring < ringCount; ring++) {
    const radius = INNER_RADIUS * Math.pow(growth, ring);
    for (let segment = 0; segment < segments; segment++) {
      const angle = (segment / segments) * Math.PI * 2;
      positions[offset++] = Math.cos(angle) * radius;
      positions[offset++] = 0;
      positions[offset++] = Math.sin(angle) * radius;
    }
  }

  const triangleCount = segments + rings * segments * 2;
  // It goes well past 65,535 vertices, so a 32-bit index is mandatory.
  const indices = new Uint32Array(triangleCount * 3);
  let index = 0;

  // The central fan.
  for (let segment = 0; segment < segments; segment++) {
    const next = (segment + 1) % segments;
    indices[index++] = 0;
    indices[index++] = 1 + next;
    indices[index++] = 1 + segment;
  }

  // Bands between consecutive rings.
  for (let ring = 0; ring < rings; ring++) {
    const inner = 1 + ring * segments;
    const outer = 1 + (ring + 1) * segments;
    for (let segment = 0; segment < segments; segment++) {
      const next = (segment + 1) % segments;

      indices[index++] = inner + segment;
      indices[index++] = inner + next;
      indices[index++] = outer + segment;

      indices[index++] = inner + next;
      indices[index++] = outer + next;
      indices[index++] = outer + segment;
    }
  }

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  geometry.setIndex(new THREE.BufferAttribute(indices, 1));
  // The mesh follows the camera and always surrounds it: frustum culling makes no sense,
  // and the bounding sphere only exists so three does not try to compute it.
  geometry.boundingSphere = new THREE.Sphere(new THREE.Vector3(), OUTER_RADIUS * 1.05);

  // The larger of the two steps rules what the mesh can represent: the radial one
  // (`radius × (growth − 1)`) or the angular one (`radius × 2π/segments`).
  const spacingFactor = Math.max(growth - 1, (Math.PI * 2) / segments);

  return { geometry, spacingFactor };
}

const VERTEX_SHADER = /* glsl */ `
precision highp float;

${WAVE_GLSL}

uniform float uSpacingFactor;

varying vec3 vWorldPosition;
varying vec2 vGridPosition;
varying float vVertexSpacing;
varying float vViewDistance;

void main() {
  // The grid position (before the displacement) is what feeds Gerstner — it is that, and
  // not the final position, that has to match the CPU.
  vec3 base = (modelMatrix * vec4(position, 1.0)).xyz;
  vGridPosition = base.xz;

  // The radius is local on purpose: the mesh follows the camera, so the radius in the
  // geometry *is* the horizontal distance to it, and the spacing between vertices there
  // is proportional to it.
  vVertexSpacing = length(position.xz) * uSpacingFactor;

  vec3 displaced = base + gerstnerDisplacementFiltered(base.xz, vVertexSpacing);
  vWorldPosition = displaced;

  vec4 viewPosition = viewMatrix * vec4(displaced, 1.0);
  vViewDistance = -viewPosition.z;
  gl_Position = projectionMatrix * viewPosition;
}
`;

const FRAGMENT_SHADER = /* glsl */ `
precision highp float;

${WAVE_GLSL}
${EQUIRECT_GLSL}
${NOISE_GLSL}
${HULL_CLIP_GLSL}

uniform sampler2D uSkyLut;
uniform vec3 uSunDirection;
uniform vec3 uSunColor;
uniform float uSunPower;
uniform vec3 uMoonDirection;
uniform vec3 uMoonColor;
uniform float uNightFactor;
uniform vec2 uWindDirection;
uniform float uTime;

uniform vec3 uDeepColor;
uniform vec3 uShallowColor;
uniform vec3 uSubsurfaceColor;
uniform vec3 uFoamColor;
uniform float uFoamThreshold;
uniform float uWaveSigma;
uniform float uFogDensity;

uniform sampler2D uWakeMap;
// (centerX, centerZ, size, strength) — the hull's wake comes in through here.
uniform vec4 uWakeArea;

varying vec3 vWorldPosition;
varying vec2 vGridPosition;
varying float vVertexSpacing;
varying float vViewDistance;

/**
 * The water's roughness even where every wave is explicit geometry. It is not zero
 * because no real surface is a perfect mirror — and too small an α turns the sun's
 * highlight into a one-pixel dot that flickers every frame.
 */
const float BASE_ALPHA = 0.05;

/** GGX microfacet distribution, where alpha is the roughness squared. */
float ggxDistribution(float nDotH, float alpha) {
  float a2 = alpha * alpha;
  float d = nDotH * nDotH * (a2 - 1.0) + 1.0;
  return a2 / max(PI * d * d, 1e-7);
}

/**
 * Height-correlated Smith visibility (Heitz 2014), with Cook-Torrance's
 * \`1/(4·nDotV·nDotL)\` denominator already folded in.
 *
 * Returning it together, and not as a separate G, avoids the ratio \`G/(4·nDotV)\` that
 * blows up when the view ray gets grazing: the correlated form is finite by construction,
 * so the highlight needs no \`min\` at all to keep from overflowing.
 */
float smithVisibility(float nDotV, float nDotL, float alpha) {
  float a2 = alpha * alpha;
  float lambdaV = nDotL * sqrt(nDotV * nDotV * (1.0 - a2) + a2);
  float lambdaL = nDotV * sqrt(nDotL * nDotL * (1.0 - a2) + a2);
  return 0.5 / max(lambdaV + lambdaL, 1e-5);
}

/**
 * The big waves shadowing each other, at grazing angles.
 *
 * The Smith term above only sees microfacets within a horizontal mean plane — to it the
 * distant sea is a perfectly flat mirror, and a mirror seen edge-on gives back light
 * without limit. The real sea does not do that: from a few degrees above the horizon on,
 * the wave in front hides the one behind, and the fraction of surface that still reaches
 * the eye falls fast.
 *
 * Without this the sun's specular (and above all the moon's, against a dark sky) paints a
 * uniform pale band stuck to the horizon, at every azimuth — the classic artifact of a
 * water BRDF with no shadowing. It is the same Smith Λ function, now applied to the
 * waves' slope distribution instead of to the microfacets.
 */
float waveShadowing(float nDotV, float alpha) {
  // The slope's σ from α: for GGX/Beckmann, α = σ·√2.
  float sigma2 = alpha * alpha * 0.5;
  float cos2 = max(nDotV * nDotV, 1e-6);
  float tan2 = (1.0 - cos2) / cos2;
  return 1.0 / (1.0 + 0.5 * (sqrt(1.0 + sigma2 * tan2) - 1.0));
}

/** Schlick's Fresnel with water's F0 (index of refraction 1.33). */
float waterFresnel(float cosTheta) {
  return 0.02 + 0.98 * pow(1.0 - clamp(cosTheta, 0.0, 1.0), 5.0);
}

/** Finite-difference step, in noise space, used by rippleOctave. */
const float RIPPLE_DELTA = 0.35;

/**
 * One octave of ripple: slope by finite difference, with its own cutoff.
 *
 * The cutoff is the same Nyquist criterion as the Gerstner waves' — the inverse of the
 * scale is the period in meters — and whatever the octave stops representing comes back
 * as slope variance, to become specular roughness instead of simply disappearing.
 */
vec2 rippleOctave(
  vec2 gridPos,
  vec2 drift,
  float scale,
  float amplitude,
  float footprint,
  inout float lostVariance
) {
  float weight = waveFilterWeight(1.0 / scale, footprint);
  float lost = amplitude * (1.0 - weight);
  lostVariance += lost * lost * 0.5;
  if (weight < 0.002) return vec2(0.0);

  vec2 p = gridPos * scale + drift;
  float center = snoise(p);
  return vec2(
    snoise(p + vec2(RIPPLE_DELTA, 0.0)) - center,
    snoise(p + vec2(0.0, RIPPLE_DELTA)) - center
  ) * (amplitude * weight);
}

/**
 * Ripple the mesh will never resolve — from the few-meter wavelets to the
 * centimeter-scale wrinkles the wind raises on top of the wave.
 *
 * The three octaves cover exactly the band between the shortest Gerstner wave (~15 m) and
 * the pixel: without them the water is as smooth as plastic up close, which is where you
 * look at it most.
 */
vec2 rippleSlope(vec2 gridPos, float footprint, out float lostVariance) {
  vec2 drift = uWindDirection * uTime;
  lostVariance = 0.0;

  vec2 slope = rippleOctave(gridPos, drift * 0.30, 0.12, 0.075, footprint, lostVariance);
  slope += rippleOctave(gridPos, drift * 0.45, 0.42, 0.105, footprint, lostVariance);
  slope += rippleOctave(gridPos, drift * -0.60, 1.35, 0.075, footprint, lostVariance);
  return slope;
}

/** Wake foam, read from the render target the hull draws into. */
float sampleWake(vec2 gridPos) {
  if (uWakeArea.w <= 0.0) return 0.0;

  vec2 uv = (gridPos - uWakeArea.xy) / uWakeArea.z + 0.5;
  if (any(lessThan(uv, vec2(0.0))) || any(greaterThan(uv, vec2(1.0)))) return 0.0;

  return texture2D(uWakeMap, uv).r * uWakeArea.w;
}

void main() {
  // Sampling resolution in meters: the worst case between the mesh's step and the size
  // of the pixel projected onto the water's plane. It is what decides which waves can
  // still be reconstructed here — below Nyquist they only boil.
  //
  // At a grazing angle the pixel becomes a long rectangle, and using the longer side
  // would erase the whole surface from the middle of the screen up. The same reasoning as
  // anisotropic texture filtering applies: you filter by the short side, with a maximum
  // 8:1 ratio so the long side does not escape with no filter at all.
  vec2 gradX = dFdx(vGridPosition);
  vec2 gradY = dFdy(vGridPosition);
  float shortAxis = min(length(gradX), length(gradY));
  float longAxis = max(length(gradX), length(gradY));
  float screenFootprint = max(shortAxis, longAxis * 0.125);
  float footprint = max(vVertexSpacing, screenFootprint);

  // Inside the hull there is no sea — without this the surface goes through the planking
  // and the hold wakes up with a lake in it, foam and sky reflection included.
  //
  // The discard comes **after** the derivatives on purpose. \`discard\` ends the
  // invocation, and a derivative is computed per 2×2 pixel quad: discarding earlier would
  // leave the neighbors' \`dFdx\` surviving with an undefined value, and the symptom would
  // be a one- or two-pixel fringe boiling against the side — exactly where you look
  // most.
  if (insideHull(vWorldPosition)) discard;

  vec3 waveNormal;
  float jacobian;
  float lostSlopeVariance;
  gerstnerSurfaceFiltered(vGridPosition, footprint, waveNormal, jacobian, lostSlopeVariance);

  // The ripple is a per-pixel normal perturbation, not geometry: what limits it is only
  // the pixel's size, never the mesh's step. Each octave has its own cutoff inside and
  // returns here what it lost, so the sun's highlight widens by the same amount instead
  // of collapsing into a dot.
  float rippleLostVariance;
  vec2 slope = rippleSlope(vGridPosition, screenFootprint, rippleLostVariance);
  vec3 normal = normalize(waveNormal + vec3(-slope.x, 0.0, -slope.y));
  lostSlopeVariance += rippleLostVariance;

  vec3 viewVector = cameraPosition - vWorldPosition;
  vec3 V = normalize(viewVector);
  // Looking from underwater the normal points away: flipping it avoids the black.
  if (dot(normal, V) < 0.0) normal = -normal;

  // Ambient light = the LUT's own zenith. At night it goes out on its own, with no
  // hand-painted curve.
  vec3 zenith = texture2D(uSkyLut, vec2(0.5, 0.02)).rgb;
  vec3 ambient = zenith * 2.1 + uMoonColor * (0.035 * uNightFactor);

  // --- the water's body ---------------------------------------------------
  // Normalized by 2σ: σ is the elevation's standard deviation, so 2σ is the height only
  // the real crests reach (~5% of the surface).
  float crest = clamp(vWorldPosition.y / max(uWaveSigma * 2.0, 0.001), -1.5, 1.5);
  vec3 body = mix(uDeepColor, uShallowColor, clamp(crest * 0.5 + 0.5, 0.0, 1.0));
  body *= ambient;

  float nDotL = max(dot(normal, uSunDirection), 0.0);
  body += uDeepColor * uSunColor * uSunPower * nDotL * 0.06;

  // --- sky reflection -----------------------------------------------------
  vec3 reflection = reflect(-V, normal);

  // On the flanks falling away the reflected ray points below the horizon: there the
  // water reflects water, not sky. Clamping the ray at the horizon would pile all those
  // pixels into the LUT's cream band and draw sand-colored stripes along the crests.
  // Mirroring it back up and mixing it with the water's body approximates the
  // interreflection with a single texture read.
  float belowHorizon = smoothstep(0.0, -0.09, reflection.y);
  vec3 skyDirection = normalize(vec3(reflection.x, abs(reflection.y), reflection.z));
  vec3 skyColor = texture2D(uSkyLut, directionToEquirect(skyDirection)).rgb;
  skyColor = mix(skyColor, body * 0.75, belowHorizon);

  float nDotV = max(dot(normal, V), 1e-3);
  float fresnel = waterFresnel(nDotV);

  vec3 color = mix(body, skyColor, fresnel);

  // --- subsurface scattering ----------------------------------------------
  // The translucent green that shows up when the crest is between you and the sun. It
  // uses the wave's normal, without the ripple: what lights up here is the light crossing
  // the crest's thin sheet of water, a property of the big wave. With the rippled normal
  // the effect became little green dots spread all over the surface, instead of the glow
  // on the crest.
  vec3 scatterDirection = normalize(uSunDirection + waveNormal * 0.65);
  float scatter = pow(clamp(dot(V, -scatterDirection) * 0.5 + 0.5, 0.0, 1.0), 5.0);
  float scatterMask = clamp(crest, 0.0, 1.0) * clamp(1.0 - waveNormal.y, 0.0, 1.0) * 2.2;
  color += uSubsurfaceColor * uSunColor * uSunPower * scatter * scatterMask * 0.55;

  // --- specular highlight (Cook-Torrance) ---------------------------------
  // α grows with the slope variance the filter discarded: that is how the pinpoint
  // highlight up close becomes the wide, glittering path of the sun far off, instead of a
  // smooth mirror that strobes with the camera.
  float alpha = clamp(sqrt(BASE_ALPHA * BASE_ALPHA + 2.0 * lostSlopeVariance), 0.02, 0.9);

  // How much of the sea still escapes the wave in front. It holds for both bodies, and
  // it is what keeps the pale band off the horizon without putting out the light path.
  float shadowing = waveShadowing(nDotV, alpha);

  vec3 halfSun = normalize(uSunDirection + V);
  float sunSpecular = ggxDistribution(max(dot(normal, halfSun), 0.0), alpha)
                    * smithVisibility(nDotV, nDotL, alpha) * nDotL;
  color += uSunColor * uSunPower * sunSpecular * waterFresnel(dot(V, halfSun)) * shadowing;

  // The moon's path is the same computation with the source swapped. The slightly larger
  // α widens the silver trail: the lunar disc is half a degree of sky, and the point
  // source alone would give back a line too thin to read as a reflection.
  float moonFacing = max(dot(normal, uMoonDirection), 0.0);
  vec3 halfMoon = normalize(uMoonDirection + V);
  float moonAlpha = min(alpha * 1.5, 0.9);
  float moonSpecular = ggxDistribution(max(dot(normal, halfMoon), 0.0), moonAlpha)
                     * smithVisibility(nDotV, moonFacing, moonAlpha) * moonFacing;
  color += uMoonColor * moonSpecular * waterFresnel(dot(V, halfMoon))
         * waveShadowing(nDotV, moonAlpha) * uNightFactor * 0.5;

  // --- foam ---------------------------------------------------------------
  // The Jacobian measures how much the surface has compressed; near zero the wave is
  // folding over itself, which is exactly where foam is born. The thresholds are
  // calibrated on the wave field's real distribution: with the default wind the Jacobian
  // sits almost entirely between 0.5 and 1.3, so only the lower tail — the crests
  // themselves — gets as far as foaming.
  float breaking = smoothstep(uFoamThreshold, uFoamThreshold - 0.3, jacobian);
  float crestFoam = smoothstep(0.75, 1.15, crest) * 0.45;
  float grain = fbm(vec3(vGridPosition * 0.42, uTime * 0.22), 3, 2.25, 0.55) * 0.5 + 0.5;

  // The grain only modulates existing foam; where the base is zero it invents nothing.
  float foam = max(breaking, crestFoam) * (0.45 + grain * 0.75);
  foam = clamp(foam + sampleWake(vGridPosition) * (0.55 + grain * 0.45), 0.0, 1.0);

  vec3 foamLit = uFoamColor * (ambient * 0.85 + uSunColor * uSunPower * nDotL * 0.16);
  color = mix(color, foamLit, foam);

  // --- distance fog -------------------------------------------------------
  // Mixing with the sky *in that direction* (and not with a fixed color) is what makes
  // sea and horizon meet with no visible line.
  //
  // The direction is clamped **above** the horizon before sampling. From the eye to a
  // point of sea three kilometers away the ray points down, and below the horizon the
  // LUT's atmospheric integral is zero — the distant fog mixed toward black and drew a
  // dark stripe from one side of the screen to the other, just below the horizon line.
  // The thicker the fog, the wider the stripe, and that is why it only showed up with the
  // storm.
  vec3 horizonDirection = normalize(-viewVector);
  horizonDirection.y = max(horizonDirection.y, 0.004);
  vec3 horizonColor = texture2D(uSkyLut, directionToEquirect(normalize(horizonDirection))).rgb;
  float fog = 1.0 - exp(-pow(vViewDistance * uFogDensity, 2.0));
  color = mix(color, horizonColor, fog);

  gl_FragColor = vec4(color, 1.0);
}
`;

export class Ocean {
  readonly mesh: THREE.Mesh;

  private readonly waveField: WaveField;
  private readonly material: THREE.ShaderMaterial;
  private readonly emptyWake: THREE.DataTexture;
  /** Borrowed from `hullClip`; shared with the hold's water. */
  private readonly hullProfile: THREE.DataTexture;
  /** Hulls that erase the sea inside them. In the duel there are two: yours and the bot's. */
  private readonly hullClips: THREE.Object3D[] = [];
  private rings: number;
  private segments: number;

  constructor(waveField: WaveField, quality: QualitySettings) {
    this.waveField = waveField;
    this.rings = quality.oceanRings;
    this.segments = quality.oceanSegments;

    const mesh = buildRadialGeometry(this.rings, this.segments);

    // A 1×1 black texture: it keeps the sampler valid while the hull's wake does not
    // exist yet (WebGL does not accept a sampler with no texture bound).
    this.emptyWake = new THREE.DataTexture(new Uint8Array([0, 0, 0, 255]), 1, 1);
    this.emptyWake.needsUpdate = true;

    this.hullProfile = getHullProfileTexture();

    this.material = new THREE.ShaderMaterial({
      vertexShader: VERTEX_SHADER,
      fragmentShader: FRAGMENT_SHADER,
      // Front and back: the player can end up underwater when sinking.
      side: THREE.DoubleSide,
      fog: false,
      uniforms: {
        // The Vector4s are the same objects WaveField mutates, so changing the wind on
        // the CPU reaches the shader with no intermediate step at all.
        uWaveA: { value: waveField.uniformA },
        uWaveB: { value: waveField.uniformB },
        uWaveTime: { value: 0 },

        uSpacingFactor: { value: mesh.spacingFactor },

        uSkyLut: { value: null },
        uSunDirection: { value: new THREE.Vector3(0, 1, 0) },
        uSunColor: { value: new THREE.Color(1, 0.96, 0.9) },
        uSunPower: { value: 3.4 },
        uMoonDirection: { value: new THREE.Vector3(0, -1, 0) },
        uMoonColor: { value: new THREE.Color(0.72, 0.79, 0.95) },
        uNightFactor: { value: 0 },
        uWindDirection: { value: new THREE.Vector2(1, 0) },
        uTime: { value: 0 },

        // Sea of Thieves' palette: petrol blue in the trough, emerald on the crest.
        uDeepColor: { value: OCEAN_DEEP_COLOR.clone() },
        uShallowColor: { value: OCEAN_SHALLOW_COLOR.clone() },
        uSubsurfaceColor: { value: new THREE.Color(0.09, 0.52, 0.42) },
        uFoamColor: { value: new THREE.Color(0.86, 0.94, 0.96) },
        uFoamThreshold: { value: 0.72 },
        uWaveSigma: { value: Math.max(waveField.getElevationSigma(), 0.001) },
        uFogDensity: { value: 1 / 3200 },

        uWakeMap: { value: this.emptyWake },
        uWakeArea: { value: new THREE.Vector4(0, 0, 256, 0) },

        uHullProfile: { value: this.hullProfile },
        uHullClipInverse: {
          value: Array.from({ length: HULL_CLIP_MAX }, () => HULL_CLIP_ELSEWHERE.clone()),
        },
      },
    });

    this.mesh = new THREE.Mesh(mesh.geometry, this.material);
    this.mesh.frustumCulled = false;
    this.mesh.matrixAutoUpdate = false;
    this.mesh.receiveShadow = false;
    // After the ship (0) and before the sky (1000). The hull is always in front, so
    // letting it write depth first saves a good slice of the water's expensive
    // fragment.
    this.mesh.renderOrder = 1;
  }

  /** Hooks the reflection up to the sky's LUT. Call it once, after creating the `Sky`. */
  setSkyLut(texture: THREE.Texture): void {
    this.material.uniforms.uSkyLut!.value = texture;
  }

  /**
   * Registers a hull so the sea is erased inside it.
   *
   * `object` is the ship model's root: the clip reads its world matrix every frame, so
   * registering once is enough and the volume follows the pose.
   */
  addHullClip(object: THREE.Object3D): void {
    if (this.hullClips.length >= HULL_CLIP_MAX) {
      // Overflowing this in silence would give the most confusing defect possible: the
      // third ship would have a lake in its hold and nothing else wrong.
      throw new Error(`Ocean: the hull clip holds ${HULL_CLIP_MAX} ships.`);
    }
    this.hullClips.push(object);
  }

  /** Forgets every hull — used when tearing the match down. */
  clearHullClips(): void {
    this.hullClips.length = 0;
  }

  /**
   * Updates the clip's world→ship matrices.
   *
   * It forces `updateWorldMatrix` instead of trusting the one the render writes:
   * `Ship.syncModel` only writes position and quaternion, and the propagation into
   * `matrixWorld` happens at the start of the render, *after* here. Without forcing it,
   * the clip volume would run one frame late — at 10 knots that is half a meter of gap
   * flickering at the waterline.
   */
  private syncHullClips(): void {
    const matrices = this.material.uniforms.uHullClipInverse!.value as THREE.Matrix4[];

    for (let i = 0; i < HULL_CLIP_MAX; i++) {
      const object = this.hullClips[i];
      if (!object) {
        matrices[i]!.copy(HULL_CLIP_ELSEWHERE);
        continue;
      }

      object.updateWorldMatrix(true, false);
      matrices[i]!.copy(object.matrixWorld).invert();
    }
  }

  /**
   * Recenters the mesh on the camera and advances the waves' time.
   * `WaveField.update` is left out on purpose: what rules the sea's clock is the physics,
   * which runs on a fixed step.
   */
  update(cameraPosition: THREE.Vector3, elapsed: number): void {
    this.mesh.position.set(cameraPosition.x, 0, cameraPosition.z);
    this.mesh.updateMatrix();
    this.mesh.updateMatrixWorld(true);

    this.material.uniforms.uWaveTime!.value = this.waveField.time;
    this.material.uniforms.uTime!.value = elapsed;
    this.material.uniforms.uWaveSigma!.value = Math.max(this.waveField.getElevationSigma(), 0.001);

    const wind = this.material.uniforms.uWindDirection!.value as THREE.Vector2;
    wind.set(Math.cos(this.waveField.windDirection), Math.sin(this.waveField.windDirection));

    this.syncHullClips();
  }

  /**
   * The distance fog's density, coming from the weather.
   *
   * It has to follow the scene's fog: the sea and the ship disappear into the horizon by
   * the same formula, and if the two densities diverge the hull vanishes before or after
   * the water around it — a dark silhouette floating over nothing.
   */
  setFogDensity(density: number): void {
    this.material.uniforms.uFogDensity!.value = density;
  }

  /** Lighting state, coming from `DayNightCycle`. */
  setLighting(
    sunDirection: THREE.Vector3,
    sunColor: THREE.Color,
    sunPower: number,
    moonDirection: THREE.Vector3,
    nightFactor: number,
  ): void {
    const uniforms = this.material.uniforms;
    (uniforms.uSunDirection!.value as THREE.Vector3).copy(sunDirection);
    (uniforms.uSunColor!.value as THREE.Color).copy(sunColor);
    uniforms.uSunPower!.value = sunPower;
    (uniforms.uMoonDirection!.value as THREE.Vector3).copy(moonDirection);
    uniforms.uNightFactor!.value = nightFactor;
  }

  /**
   * Connects the wake's render target.
   * `size` is the edge, in meters, of the world area the texture covers.
   */
  setWake(texture: THREE.Texture, center: THREE.Vector3, size: number, strength: number): void {
    this.material.uniforms.uWakeMap!.value = texture;
    (this.material.uniforms.uWakeArea!.value as THREE.Vector4).set(center.x, center.z, size, strength);
  }

  /** Rebuilds the mesh when the graphics preset changes. */
  applyQuality(quality: QualitySettings): void {
    if (quality.oceanRings === this.rings && quality.oceanSegments === this.segments) return;

    this.rings = quality.oceanRings;
    this.segments = quality.oceanSegments;

    const rebuilt = buildRadialGeometry(this.rings, this.segments);
    this.mesh.geometry.dispose();
    this.mesh.geometry = rebuilt.geometry;
    // The new mesh has a different spacing, and the wave filter depends on it.
    this.material.uniforms.uSpacingFactor!.value = rebuilt.spacingFactor;
  }

  /** Triangles in the current mesh — used by the telemetry overlay. */
  getTriangleCount(): number {
    return this.segments + this.rings * this.segments * 2;
  }

  dispose(): void {
    this.mesh.geometry.dispose();
    this.material.dispose();
    this.emptyWake.dispose();
  }
}
