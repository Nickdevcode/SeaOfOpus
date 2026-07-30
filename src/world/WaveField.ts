/**
 * Gerstner wave field — the single source of truth about the sea.
 *
 * ⚠️ This is the most delicate piece of the game. Wave height is consumed in two
 * places that MUST agree:
 *   - GPU (ocean vertex shader): defines where the water appears.
 *   - CPU (ship buoyancy): defines where the ship floats.
 * If they diverge, the ship sinks or flies. To guarantee parity, both sides read
 * exactly the same parameter array (`uniformA`/`uniformB`) and use the same
 * formulation — the GLSL below is the literal mirror of the TypeScript.
 *
 * Model: Gerstner (trochoidal) waves. Unlike a plain sine, they displace the
 * vertex horizontally as well, which sharpens the crests and widens the troughs
 * — that is what gives the profile of a real sea. The dispersion relation uses
 * ω = √(g·k), deep water, so long waves travel faster than short ones, just like
 * the real sea.
 */

import * as THREE from 'three';
import { GRAVITY, TAU, angleDelta, createRandom } from '../core/MathUtils';

export interface GerstnerWave {
  /**
   * This wave's direction offset from the wind, in radians.
   *
   * Storing the **offset** instead of the absolute direction is what lets the sea
   * follow the wind as it turns. Each wave used to be born with a fixed vector,
   * computed once from the initial wind; turning the wind after that changed
   * nothing, and the sea kept coming from the same side forever. Now the
   * direction is recomposed on every `syncUniforms`, so the whole field turns
   * with it — slowly, the way the sea really does when the wind shifts.
   */
  offset: number;
  /**
   * How much this wave obeys the wind right now, 0..1.
   *
   * Wind waves (`1`) change heading with it. The background swell (`0.25`) barely
   * changes: it was raised by a wind that blew hours ago and hundreds of
   * kilometers from here, and it keeps running on the old heading. That
   * stubbornness is what produces a **cross sea** — two wave families at an
   * angle, adding up and canceling out in patches. It is the difference between a
   * sea and corrugated sheet metal.
   */
  follow: number;
  /** Propagation direction, normalized. Recomposed on every sync. */
  direction: THREE.Vector2;
  /** Crest height above mean level, in meters. */
  amplitude: number;
  /** Distance between crests, in meters. */
  waveLength: number;
  /** 0..1 — how sharp the crest is. The sum is capped so it never loops. */
  steepness: number;
  /** Artistic multiplier on top of the physical phase speed. */
  speed: number;
  /** Initial phase offset, keeps every wave from lining up at the origin. */
  phase: number;
}

/** Maximum number of waves the shader supports (sets the uniform array size). */
export const MAX_WAVES = 6;

/** Fixed-point iterations used to invert the horizontal displacement. */
const INVERSE_ITERATIONS = 4;

/** Amplitude multiplier at minimum and at maximum wind. */
const MIN_AMPLITUDE_SCALE = 0.45;
const MAX_AMPLITUDE_SCALE = 1.85;

export class WaveField {
  readonly waves: GerstnerWave[] = [];

  /** Wind direction in radians (0 = +X). Feeds the wave directions. */
  windDirection: number;
  /**
   * Heading the background swell came from, in radians.
   *
   * Different from the wind because the swell has memory: it was raised far from
   * here and keeps to the old heading while the local wind has already changed.
   * The lag between the two is what produces the cross sea.
   */
  swellDirection: number;
  /** Wind strength, 0..1. Scales amplitude and speed. */
  windStrength: number;

  /** Buffers sent to the shader: (dirX, dirZ, amplitude, waveLength). */
  readonly uniformA: THREE.Vector4[] = [];
  /** Buffers sent to the shader: (steepness, omega, phase, 0). */
  readonly uniformB: THREE.Vector4[] = [];

  /** Sea simulation time, advanced by `update`. */
  time = 0;

  constructor(waveCount = MAX_WAVES, seed = 1337, windDirection = 0.7, windStrength = 0.65) {
    this.windDirection = windDirection;
    this.swellDirection = windDirection;
    this.windStrength = windStrength;

    for (let i = 0; i < MAX_WAVES; i++) {
      this.uniformA.push(new THREE.Vector4());
      this.uniformB.push(new THREE.Vector4());
    }

    this.generate(waveCount, seed);
  }

  /**
   * Generates the wave spectrum.
   *
   * Two swells give the big motion that rolls the ship; the short ones give the
   * surface texture. The directions fan out around the wind (± ~50°), like a real
   * partially developed sea.
   *
   * ⚠️ **The scale here is a game decision, not an oceanography one.** What rules
   * is the size of the Sloop: 16 m long. Swells of 60 m with 2 m of amplitude —
   * which is a real sea under a 15 m/s wind — make the ship look like a toy and
   * throw it around in a way that only gets in the way of combat. Sea of Thieves
   * solves the same problem the same way: a short sea, ~1.5 m crest to trough,
   * where the hull crosses one or two waves at a time. The numbers below were
   * calibrated against `getElevationSigma()` for exactly that.
   */
  generate(waveCount: number, seed: number): void {
    const random = createRandom(seed);
    const count = Math.min(waveCount, MAX_WAVES);

    this.waves.length = 0;

    for (let i = 0; i < count; i++) {
      const isSwell = i < 2;
      const t = count > 1 ? i / (count - 1) : 0;

      // The swell has to be longer than the ship to lift it whole, but not so
      // long that the ship vanishes inside it: 1.5 to 2.5 hull lengths.
      const waveLength = isSwell
        ? 26 + random() * 16 // 26–42 m
        : 3.5 + t * 13 + random() * 4.5; // 3.5–21 m

      // The fan of the short wind waves opens far wider than the swells'. The long
      // swell arrives from a single heading, with an almost straight wave front;
      // wind chop is disorganized by nature. A ±26° fan on everything, the way it
      // used to be, gave a sea that looked printed off a roller.
      const spread = isSwell ? 1.1 : 1.5;
      const offset = (random() - 0.5) * spread;

      // Amplitude/length ratio well below the breaking limit (1/20): that's what
      // makes the sea read as "fair weather" instead of storm.
      const steepnessRatio = isSwell ? 0.01 : 0.014;
      const amplitude = waveLength * steepnessRatio * (0.7 + random() * 0.6);

      this.waves.push({
        offset,
        // See `follow`: the swell drags the old heading, the short wave obeys the
        // wind of the moment. The two together are what give a cross sea.
        follow: isSwell ? 0.25 : 1,
        direction: new THREE.Vector2(1, 0),
        amplitude,
        waveLength,
        // Higher steepness offsets the smaller amplitude: it keeps the crest sharp
        // and the trough wide, the profile that makes water look like water.
        steepness: isSwell ? 0.7 : 0.95,
        speed: 0.85 + random() * 0.3,
        phase: random() * TAU,
      });
    }

    // The reference for where the swells came from. From here on they turn at a
    // quarter of the wind's rate, and it's that lag that opens the angle between
    // the two wave families over the course of a match.
    this.swellDirection = this.windDirection;

    this.normalizeSteepness();
    this.syncUniforms();
  }

  /**
   * Caps the sum of Q·k·A so the horizontal displacement never folds the wave
   * over itself (the Gerstner "loop", which turns into an ugly visual artifact).
   */
  private normalizeSteepness(): void {
    let total = 0;
    for (const wave of this.waves) {
      const k = TAU / wave.waveLength;
      // Against the **worst case**, not against the resting amplitude: the
      // amplitude sent to the shader is multiplied by up to `MAX_AMPLITUDE_SCALE`
      // when the wind goes full blast, and normalizing by the bare amplitude
      // would leave the storm wave looping over itself. The symptom is ugly and
      // unmistakable: the crest folds backwards and the surface turns into a
      // shell with pockets inside it, the sea showing through inside out.
      total += wave.steepness * k * wave.amplitude * MAX_AMPLITUDE_SCALE;
    }
    if (total > 1) {
      const scale = 0.92 / total;
      for (const wave of this.waves) wave.steepness *= scale;
    }
  }

  /** Repacks the parameters into the buffers the shader reads. */
  syncUniforms(): void {
    for (let i = 0; i < MAX_WAVES; i++) {
      const wave = this.waves[i];
      if (!wave) {
        // Unused waves are left at amplitude 0: the shader adds zero.
        this.uniformA[i]!.set(1, 0, 0, 1);
        this.uniformB[i]!.set(0, 0, 0, 0);
        continue;
      }

      // The direction is **recomposed** on every sync, mixing the current wind
      // heading with the swell's old heading according to each wave's `follow`.
      // This is the line that makes the sea turn with the wind.
      const base = wave.follow * this.windDirection + (1 - wave.follow) * this.swellDirection;
      const angle = base + wave.offset;
      wave.direction.set(Math.cos(angle), Math.sin(angle));

      const k = TAU / wave.waveLength;
      // Deep-water dispersion: long waves run faster.
      const omega = Math.sqrt(GRAVITY * k) * wave.speed;
      // The range runs from 0.45 (dead calm) to 1.85 (storm), not the old 0.55 to
      // 1.20. The old ceiling was the problem: with the wind at full blast the sea
      // rose only 20% above standard, so "storm" and "breeze" gave nearly identical
      // waves and the difference came down to the color of the sky. Four times the
      // range is what separates a sea you sail from a sea you survive.
      const amplitude =
        wave.amplitude *
        (MIN_AMPLITUDE_SCALE + this.windStrength * (MAX_AMPLITUDE_SCALE - MIN_AMPLITUDE_SCALE));

      this.uniformA[i]!.set(wave.direction.x, wave.direction.y, amplitude, wave.waveLength);
      this.uniformB[i]!.set(wave.steepness, omega, wave.phase, 0);
    }
  }

  /**
   * Turns the sea's heading. The background swell follows more slowly than the
   * wind — that's how the angle between the two wave families opens over time.
   *
   * @param windDirection the wind's heading right now, in radians.
   * @param dt step, in seconds.
   */
  followWind(windDirection: number, dt: number): void {
    this.windDirection = windDirection;
    // The swell chases the wind at a quarter of the speed. Without this line it
    // would stay locked on the heading from the start of the match and, half an
    // hour in, the cross sea would become an opposing sea.
    const delta = angleDelta(this.swellDirection, windDirection);
    this.swellDirection += delta * Math.min(dt * 0.02, 1);
  }

  update(dt: number): void {
    this.time += dt;
  }

  /**
   * Gerstner displacement from a grid point.
   * Mirrors the GLSL `gerstnerDisplacement` exactly.
   */
  displace(gridX: number, gridZ: number, target: THREE.Vector3): THREE.Vector3 {
    target.set(0, 0, 0);

    for (let i = 0; i < MAX_WAVES; i++) {
      const a = this.uniformA[i]!;
      const b = this.uniformB[i]!;
      const amplitude = a.z;
      if (amplitude <= 0) continue;

      const k = TAU / a.w;
      const phase = k * (a.x * gridX + a.y * gridZ) - b.y * this.time + b.z;
      const cos = Math.cos(phase);
      const sin = Math.sin(phase);
      const qa = b.x * amplitude;

      target.x += qa * a.x * cos;
      target.z += qa * a.y * cos;
      target.y += amplitude * sin;
    }

    return target;
  }

  /**
   * Surface height on the vertical column (worldX, worldZ).
   *
   * Because Gerstner moves the vertex horizontally, the grid point that ends up
   * *above* (worldX, worldZ) is not (worldX, worldZ). A fixed-point iteration
   * solves it: guess the grid point, measure how far it displaced and correct.
   * It converges in 3–4 steps because the displacement is always smaller than
   * the wavelength.
   */
  sampleHeight(worldX: number, worldZ: number): number {
    let gridX = worldX;
    let gridZ = worldZ;

    for (let iteration = 0; iteration < INVERSE_ITERATIONS; iteration++) {
      this.displace(gridX, gridZ, scratchDisplacement);
      const errorX = worldX - (gridX + scratchDisplacement.x);
      const errorZ = worldZ - (gridZ + scratchDisplacement.z);
      gridX += errorX;
      gridZ += errorZ;
    }

    return this.displace(gridX, gridZ, scratchDisplacement).y;
  }

  /**
   * Surface height and normal. The normal comes from the analytic derivatives of
   * the displacement — no finite differences, which would come out noisy.
   */
  sampleSurface(worldX: number, worldZ: number, outNormal?: THREE.Vector3): number {
    let gridX = worldX;
    let gridZ = worldZ;

    for (let iteration = 0; iteration < INVERSE_ITERATIONS; iteration++) {
      this.displace(gridX, gridZ, scratchDisplacement);
      gridX += worldX - (gridX + scratchDisplacement.x);
      gridZ += worldZ - (gridZ + scratchDisplacement.z);
    }

    const height = this.displace(gridX, gridZ, scratchDisplacement).y;

    if (outNormal) {
      // Partial tangents ∂P/∂x and ∂P/∂z summed wave by wave.
      let tangentX = 1;
      let tangentY = 0;
      let tangentZ = 0;
      let bitangentX = 0;
      let bitangentY = 0;
      let bitangentZ = 1;

      for (let i = 0; i < MAX_WAVES; i++) {
        const a = this.uniformA[i]!;
        const b = this.uniformB[i]!;
        const amplitude = a.z;
        if (amplitude <= 0) continue;

        const k = TAU / a.w;
        const phase = k * (a.x * gridX + a.y * gridZ) - b.y * this.time + b.z;
        const cos = Math.cos(phase);
        const sin = Math.sin(phase);
        const qa = b.x * amplitude;

        tangentX += -qa * a.x * a.x * k * sin;
        tangentY += amplitude * a.x * k * cos;
        tangentZ += -qa * a.x * a.y * k * sin;

        bitangentX += -qa * a.x * a.y * k * sin;
        bitangentY += amplitude * a.y * k * cos;
        bitangentZ += -qa * a.y * a.y * k * sin;
      }

      // normal = bitangent × tangent (the order that returns +Y for a calm sea)
      outNormal
        .set(
          bitangentY * tangentZ - bitangentZ * tangentY,
          bitangentZ * tangentX - bitangentX * tangentZ,
          bitangentX * tangentY - bitangentY * tangentX,
        )
        .normalize();

      if (outNormal.y < 0) outNormal.negate();
    }

    return height;
  }

  /** Wind vector in the XZ plane, scaled by strength. */
  getWindVector(target: THREE.Vector2): THREE.Vector2 {
    return target.set(Math.cos(this.windDirection), Math.sin(this.windDirection)).multiplyScalar(this.windStrength);
  }

  /**
   * Theoretical maximum height of the wave sum — the worst case, when every
   * crest coincides. Use it to size safety margins (camera, shadow frustum), not
   * to normalize color: in practice the sea almost never gets anywhere near it.
   */
  getMaxAmplitude(): number {
    let total = 0;
    for (let i = 0; i < MAX_WAVES; i++) total += this.uniformA[i]!.z;
    return total;
  }

  /**
   * Standard deviation of the elevation (σ), the statistical measure oceanography
   * uses to describe a sea state: for a sum of independent sinusoids,
   * σ² = Σ A²/2, and the *significant height* is ≈ 4σ. It's the right scale for
   * deciding what counts as a "crest" — far better than the sum of amplitudes.
   */
  getElevationSigma(): number {
    let variance = 0;
    for (let i = 0; i < MAX_WAVES; i++) {
      const amplitude = this.uniformA[i]!.z;
      variance += (amplitude * amplitude) / 2;
    }
    return Math.sqrt(variance);
  }
}

const scratchDisplacement = new THREE.Vector3();

/**
 * GLSL snippet mirroring `displace` and the normal derivation above.
 *
 * It's injected into the ocean vertex shader and into any effect that needs the
 * surface. Keep it side by side with the TypeScript: any change here needs the
 * same change there.
 *
 * > [!warning] Parity is maintained by hand, and there is **no** test proving it
 * > This comment used to promise a `tests/wave-parity.ts` that was never written,
 * > which is worse than promising nothing: whoever touches the shader reads the
 * > promise and trusts a safety net that doesn't exist. Proving parity for real
 * > would take running this GLSL, meaning a GPU and a WebGL context — and this
 * > project's tests run without any of that. Until that exists, the only defense
 * > is side-by-side review: `displace` (with `footprint = 0`) and
 * > `gerstnerDisplacement` have to be the same arithmetic, term for term.
 */
export const WAVE_GLSL = /* glsl */ `
#define MAX_WAVES ${MAX_WAVES}
#define TAU 6.283185307179586

uniform vec4 uWaveA[MAX_WAVES]; // (dirX, dirZ, amplitude, waveLength)
uniform vec4 uWaveB[MAX_WAVES]; // (steepness, omega, phase, unused)
uniform float uWaveTime;

/**
 * Weight of a wave given the resolution available to sample it.
 *
 * \`footprint\` is the distance, in world meters, between two neighboring samples
 * — the vertex spacing in the vertex shader, the projected pixel size in the
 * fragment shader. Nyquist demands at least 2 samples per period: below that the
 * wave isn't reconstructed, it turns into boiling noise. So the wave fades in
 * gradually between 2 and 4 samples per period instead of showing up aliased.
 *
 * This replaces a distance-based LOD: the criterion is the actual resolution, so
 * changing mesh density, FOV or screen resolution adjusts the cutoff on its own.
 *
 * With \`footprint = 0.0\` the weight is 1 for every wave — that's the case the CPU
 * uses, and it's what keeps parity with \`WaveField.displace\` exact.
 */
float waveFilterWeight(float waveLength, float footprint) {
  return smoothstep(2.0 * footprint, 4.0 * footprint + 1e-4, waveLength);
}

/**
 * Gerstner displacement filtered for the sampling resolution.
 * Mirrors \`WaveField.displace\` when \`footprint\` is 0.
 */
vec3 gerstnerDisplacementFiltered(vec2 gridPos, float footprint) {
  vec3 displacement = vec3(0.0);

  for (int i = 0; i < MAX_WAVES; i++) {
    vec4 a = uWaveA[i];
    vec4 b = uWaveB[i];
    float amplitude = a.z * waveFilterWeight(a.w, footprint);
    if (amplitude <= 0.0) continue;

    float k = TAU / a.w;
    float phase = k * dot(a.xy, gridPos) - b.y * uWaveTime + b.z;
    float c = cos(phase);
    float s = sin(phase);
    float qa = b.x * amplitude;

    displacement.x += qa * a.x * c;
    displacement.z += qa * a.y * c;
    displacement.y += amplitude * s;
  }

  return displacement;
}

/** Literal mirror of \`WaveField.displace\`. */
vec3 gerstnerDisplacement(vec2 gridPos) {
  return gerstnerDisplacementFiltered(gridPos, 0.0);
}

/**
 * Analytic normal, jacobian and the slope variance the filter threw away.
 *
 * - \`jacobian\` measures the compression of the surface: near zero the wave is
 *   folding over itself, which is where breaking foam is born.
 * - \`lostSlopeVariance\` is the slope variance of the waves the filter removed. A
 *   sinusoid of amplitude A and wave number k has slope variance (kA)²/2;
 *   returning that number lets the shader recover, as specular roughness, the
 *   relief the normal lost — without it, distant water would turn into a smooth
 *   mirror and sparkle with every camera movement.
 */
void gerstnerSurfaceFiltered(
  vec2 gridPos,
  float footprint,
  out vec3 normal,
  out float jacobian,
  out float lostSlopeVariance
) {
  vec3 tangent = vec3(1.0, 0.0, 0.0);
  vec3 bitangent = vec3(0.0, 0.0, 1.0);
  float jxx = 1.0;
  float jzz = 1.0;
  float jxz = 0.0;
  lostSlopeVariance = 0.0;

  for (int i = 0; i < MAX_WAVES; i++) {
    vec4 a = uWaveA[i];
    vec4 b = uWaveB[i];
    if (a.z <= 0.0) continue;

    float k = TAU / a.w;
    float weight = waveFilterWeight(a.w, footprint);
    float amplitude = a.z * weight;

    float lostSlope = k * a.z * (1.0 - weight);
    lostSlopeVariance += lostSlope * lostSlope * 0.5;

    if (amplitude <= 0.0) continue;

    float phase = k * dot(a.xy, gridPos) - b.y * uWaveTime + b.z;
    float c = cos(phase);
    float s = sin(phase);
    float qa = b.x * amplitude;

    tangent.x += -qa * a.x * a.x * k * s;
    tangent.y += amplitude * a.x * k * c;
    tangent.z += -qa * a.x * a.y * k * s;

    bitangent.x += -qa * a.x * a.y * k * s;
    bitangent.y += amplitude * a.y * k * c;
    bitangent.z += -qa * a.y * a.y * k * s;

    jxx += -qa * a.x * a.x * k * s;
    jzz += -qa * a.y * a.y * k * s;
    jxz += -qa * a.x * a.y * k * s;
  }

  normal = normalize(cross(bitangent, tangent));
  if (normal.y < 0.0) normal = -normal;

  jacobian = jxx * jzz - jxz * jxz;
}

/** Literal mirror of \`WaveField.sampleSurface\`. */
void gerstnerSurface(vec2 gridPos, out vec3 normal, out float jacobian) {
  float lost;
  gerstnerSurfaceFiltered(gridPos, 0.0, normal, jacobian, lost);
}
`;
