/**
 * The sky: atmospheric LUT + dome + sun, moon, stars and clouds.
 *
 * Atmospheric scattering is far too expensive to run per screen pixel, so it is evaluated
 * into a 256×128 equirectangular LUT and only when the sun has moved enough to matter.
 * The sky dome and the ocean's reflection sample that same LUT — that is what makes the
 * sea reflect exactly the sky above it, sunset included.
 *
 * The clouds are projected onto a high plane with animated fBm, with no raymarch. It is
 * the same choice Rare made in Sea of Thieves: a cheap cloud, with an art-directed
 * silhouette, instead of a physically correct and slow volume.
 */

import * as THREE from 'three';
import { ATMOSPHERE_GLSL, EQUIRECT_GLSL } from '../shaders/atmosphere';
import { NOISE_GLSL } from '../shaders/noise';

// 0.35° per texel vertically. It looks like overkill for a smooth gradient, but the sea
// samples the LUT at grazing angles, where the color changes fast: with 128 rows the
// linear interpolation drew Mach bands visible on the waves.
const LUT_WIDTH = 1024;
const LUT_HEIGHT = 512;
/** Minimum angle (radians) the sun has to travel before the LUT is recomputed. */
const LUT_UPDATE_THRESHOLD = 0.004;

/** The dome's radius. It stays inside the camera's far plane. */
const DOME_RADIUS = 9000;

/**
 * Intensity of the full moon in the LUT, on the same scale as the sun (which goes to 22).
 * Calibrated by eye: see `update` for why it is not the physical value.
 */
const MOON_INTENSITY = 0.26;

export class Sky {
  readonly dome: THREE.Mesh;
  /** A small mesh in the sun's direction — the god rays effect's target. */
  readonly sunMesh: THREE.Mesh;

  /** The sky's equirectangular texture, consumed by the ocean's shader. */
  get lutTexture(): THREE.Texture {
    return this.lutTarget.texture;
  }

  /**
   * How many times the LUT has been redrawn.
   *
   * The texture is always the same instance, so nothing around it can tell the content
   * changed. Whoever has expensive work to redo from it — `SkyEnvironment` and its mip
   * chain — compares this number against what it saw last time instead of redoing
   * everything every frame just in case.
   */
  lutGeneration = 0;

  private lutTarget: THREE.WebGLRenderTarget;
  private lutScene = new THREE.Scene();
  private lutCamera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
  private lutMaterial: THREE.ShaderMaterial;
  private domeMaterial: THREE.ShaderMaterial;
  private sunMaterial: THREE.MeshBasicMaterial;

  private lastLutSunDirection = new THREE.Vector3(0, -1, 0);
  private lutDirty = true;

  constructor() {
    this.lutTarget = new THREE.WebGLRenderTarget(LUT_WIDTH, LUT_HEIGHT, {
      // HalfFloat: the sky has a high dynamic range (sun vs. zenith) and 8 bits would
      // produce coarse banding in the sunset's gradient.
      type: THREE.HalfFloatType,
      format: THREE.RGBAFormat,
      minFilter: THREE.LinearFilter,
      magFilter: THREE.LinearFilter,
      depthBuffer: false,
      stencilBuffer: false,
    });
    this.lutTarget.texture.wrapS = THREE.RepeatWrapping;
    this.lutTarget.texture.colorSpace = THREE.NoColorSpace;

    this.lutMaterial = new THREE.ShaderMaterial({
      uniforms: {
        uSunDirection: { value: new THREE.Vector3(0, 1, 0) },
        uSunIntensity: { value: 22 },
        uMoonDirection: { value: new THREE.Vector3(0, -1, 0) },
        uMoonIntensity: { value: 0 },
        uNightFactor: { value: 0 },
      },
      vertexShader: /* glsl */ `
        varying vec2 vUv;
        void main() {
          vUv = uv;
          gl_Position = vec4(position.xy, 0.0, 1.0);
        }
      `,
      fragmentShader: /* glsl */ `
        precision highp float;
        varying vec2 vUv;
        uniform vec3 uSunDirection;
        uniform float uSunIntensity;
        uniform vec3 uMoonDirection;
        uniform float uMoonIntensity;
        uniform float uNightFactor;

        ${EQUIRECT_GLSL}
        ${ATMOSPHERE_GLSL}

        void main() {
          vec3 dir = equirectToDirection(vUv);
          vec3 color = nightGlow(dir) * uNightFactor;

          // The moon lights the sky by the same physics as the sun — it is reflected
          // sunlight crossing the same air. Running the scattering twice would double
          // the LUT's cost if the two sources coexisted, but they barely overlap:
          // outside the half hour of twilight, one of the two intensities is exactly
          // zero. And since the test is on a uniform, the GPU decides the branch once
          // for the whole texture, with no divergence.
          if (uSunIntensity > 0.0) {
            color += atmosphere(dir, uSunDirection, uSunIntensity);
          }
          if (uMoonIntensity > 0.0) {
            color += atmosphere(dir, uMoonDirection, uMoonIntensity);
          }

          gl_FragColor = vec4(color, 1.0);
        }
      `,
      depthTest: false,
      depthWrite: false,
    });

    const quad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), this.lutMaterial);
    quad.frustumCulled = false;
    this.lutScene.add(quad);

    this.domeMaterial = this.createDomeMaterial();
    this.dome = new THREE.Mesh(new THREE.SphereGeometry(DOME_RADIUS, 64, 32), this.domeMaterial);
    this.dome.frustumCulled = false;
    // The dome draws last among the opaques, without writing depth: the Z test already
    // discards every pixel covered by the sea or the ship. That matters a lot here,
    // because the sky's fragment is expensive (fBm clouds and stars) and drawing it first
    // would mean paying for the whole screen and then covering half of it.
    this.dome.renderOrder = 1000;
    this.dome.matrixAutoUpdate = false;

    this.sunMaterial = new THREE.MeshBasicMaterial({
      fog: false,
      transparent: true,
      depthWrite: false,
      // Additive, and not replacement: the Mie halo around the sun is HDR (tens of times
      // white), so an LDR-colored disc drawn over it becomes a dark hole in the middle of
      // the sun after tone mapping. By adding, the disc can only brighten what is already
      // there. The color comes from `update`, in radiance well above 1 — it is what feeds
      // the bloom.
      blending: THREE.AdditiveBlending,
    });
    this.sunMesh = new THREE.Mesh(new THREE.SphereGeometry(90, 16, 12), this.sunMaterial);
    this.sunMesh.frustumCulled = false;
    this.sunMesh.renderOrder = 1001;
  }

  private createDomeMaterial(): THREE.ShaderMaterial {
    return new THREE.ShaderMaterial({
      side: THREE.BackSide,
      depthWrite: false,
      fog: false,
      uniforms: {
        uSkyLut: { value: this.lutTarget.texture },
        uSunDirection: { value: new THREE.Vector3(0, 1, 0) },
        uMoonDirection: { value: new THREE.Vector3(0, -1, 0) },
        uMoonPhase: { value: 0.35 },
        uTime: { value: 0 },
        uNightFactor: { value: 0 },
        uCloudCoverage: { value: 0.42 },
        uCloudSunColor: { value: new THREE.Color(1, 0.94, 0.82) },
        uCloudShadowColor: { value: new THREE.Color(0.32, 0.36, 0.46) },
        uWindDirection: { value: new THREE.Vector2(1, 0) },
      },
      vertexShader: /* glsl */ `
        varying vec3 vDirection;
        void main() {
          vDirection = normalize(position);
          // The projection uses only the camera's rotation: the dome follows the player
          // without ever being reached.
          vec4 mvPosition = modelViewMatrix * vec4(position, 1.0);
          gl_Position = projectionMatrix * mvPosition;
        }
      `,
      fragmentShader: /* glsl */ `
        precision highp float;

        varying vec3 vDirection;

        uniform sampler2D uSkyLut;
        uniform vec3 uSunDirection;
        uniform vec3 uMoonDirection;
        uniform float uMoonPhase;
        uniform float uTime;
        uniform float uNightFactor;
        uniform float uCloudCoverage;
        uniform vec3 uCloudSunColor;
        uniform vec3 uCloudShadowColor;
        uniform vec2 uWindDirection;

        ${EQUIRECT_GLSL}
        ${NOISE_GLSL}

        /**
         * A procedural star field: it splits the sphere into cells and draws one star
         * per cell. No geometry, no texture, and the density follows the resolution
         * automatically.
         *
         * What separates "a starry sky" from "television static" is not the count, it is
         * the **magnitude distribution**. In the real sky each step of brightness has
         * about three times more stars than the step above it: a few dominate the scene
         * and the overwhelming majority is nearly invisible. Drawing brightness
         * uniformly — which is the easy mistake here — produces thousands of identical
         * dots, and the eye reads noise.
         */
        vec3 starField(vec3 dir) {
          // Atmospheric extinction: at a grazing angle, the star's light crosses tens
          // of times more air. Near the horizon only the brightest survive.
          float extinction = smoothstep(-0.01, 0.3, dir.y);
          if (extinction <= 0.0) return vec3(0.0);

          vec3 color = vec3(0.0);

          for (int layer = 0; layer < 3; layer++) {
            float scale = 60.0 + float(layer) * 95.0;
            vec3 cell = floor(dir * scale);
            float rnd = hash21(cell.xy + cell.z * 37.0);

            // The density falls with the scale because the cell count grows with its
            // square — without this the fine layer would drown the others.
            float density = 0.006 - float(layer) * 0.0015;
            if (rnd > density) continue;

            // The draw remapped to [0,1] and put through the power law that makes the
            // magnitude distribution.
            float magnitude = pow(rnd / density, 6.0);

            // A bright star takes up more pixels: it is the eye itself (and here the
            // bloom) spreading the light, not a larger disc in the sky.
            float radius = 0.0011 + magnitude * 0.0020;
            vec3 center = (cell + 0.5) / scale;
            float dist = length(normalize(center) - dir);
            float brightness = smoothstep(radius, 0.0, dist);
            if (brightness <= 0.0) continue;

            // Twinkle: it is air turbulence, so it disappears at the zenith and
            // dominates at grazing angles — exactly where the extinction is already
            // eating the brightness.
            float flicker = 0.5 + 0.5 * sin(uTime * (1.4 + rnd * 400.0) + rnd * 900.0);
            float twinkle = mix(flicker, 1.0, extinction);

            // Color temperature ranging from bluish to orange.
            vec3 tint = mix(vec3(0.75, 0.83, 1.0), vec3(1.0, 0.86, 0.7), hash11(rnd * 91.0));
            color += tint * brightness * twinkle * extinction * (0.25 + magnitude * 5.5);
          }
          return color;
        }

        /** The moon's disc, with a phase terminator and noise craters. */
        vec3 moonDisc(vec3 dir) {
          float cosAngle = dot(dir, uMoonDirection);
          if (cosAngle < 0.9993) return vec3(0.0);

          float disc = smoothstep(0.99955, 0.99975, cosAngle);

          // A local basis to map the disc's surface.
          vec3 right = normalize(cross(vec3(0.0, 1.0, 0.0), uMoonDirection));
          vec3 up = cross(uMoonDirection, right);
          vec2 local = vec2(dot(dir, right), dot(dir, up)) * 900.0;

          float craters = fbm(vec3(local * 2.4, 0.0), 4, 2.1, 0.55) * 0.5 + 0.5;
          float surface = mix(0.72, 1.0, craters);

          // The terminator: the phase cuts the disc with a soft edge.
          float terminator = smoothstep(-0.25, 0.25, local.x / 900.0 * 4.0 - (uMoonPhase * 2.0 - 1.0) * 2.2);

          return vec3(0.92, 0.94, 1.0) * disc * surface * terminator * 2.4;
        }

        /**
         * Layered clouds: the ray is projected onto a high plane and sampled with fBm.
         * Two layers at different speeds give parallax without volume.
         */
        vec4 clouds(vec3 dir) {
          if (dir.y < 0.015) return vec4(0.0);

          float planeHeight = 1800.0;
          vec2 uv = dir.xz / max(dir.y, 0.015) * (planeHeight / 4000.0);
          vec2 drift = uWindDirection * uTime * 0.012;

          float base = ridgedFbm(vec3(uv * 0.55 + drift, uTime * 0.008), 5, 2.15, 0.52);
          float detail = fbm(vec3(uv * 1.9 + drift * 1.7, uTime * 0.02), 4, 2.3, 0.5);

          float density = base * 0.78 + detail * 0.22;
          // The coverage pushes the threshold: 0 = clear sky, 1 = overcast.
          //
          // The floor came down from 0.32 to 0.10 because 0.32 never closed the sky: in
          // a storm there were still rips of blue between the clouds, and a storm with
          // open sky in the middle is not a storm. And the transition tightens along
          // with it (from 0.22 to 0.08 of width) — a storm cloud has a hard edge,
          // unlike a summer afternoon's cotton.
          float threshold = mix(0.72, 0.10, uCloudCoverage);
          float edge = mix(0.22, 0.08, uCloudCoverage);
          float alpha = smoothstep(threshold, threshold + edge, density);

          // It fades out at the horizon so as not to reveal the projected plane's
          // edge.
          alpha *= smoothstep(0.02, 0.2, dir.y);

          // Cheap lighting: the noise's own gradient approximates the normal.
          float lit = smoothstep(0.35, 0.85, detail * 0.5 + 0.5);
          float sunAlign = max(dot(dir, uSunDirection), 0.0);
          vec3 color = mix(uCloudShadowColor, uCloudSunColor, lit);
          // A lit rim when the cloud is in front of the sun.
          color += uCloudSunColor * pow(sunAlign, 8.0) * (1.0 - alpha) * 0.9;

          return vec4(color, alpha);
        }

        void main() {
          vec3 dir = normalize(vDirection);

          // The LUT is sampled with the direction **mirrored** upward when the ray
          // points below the horizon.
          //
          // Below the horizon line the atmospheric integral goes to zero and the LUT
          // returns black. That did not show while the fog was thin, but the sea ends
          // at 8 km and the geometric horizon is at nearly 11: between the two there is
          // a band where the dome is visible, and it painted itself black, stitching a
          // dark stripe between the water and the sky in a storm.
          //
          // Mirroring is the right approximation: what exists just below the horizon is
          // sea reflecting the sky just above it, so the color is practically the same.
          // The error is imperceptible and the seam disappears.
          vec3 lutDir = vec3(dir.x, abs(dir.y) * 0.35 + 0.002, dir.z);
          vec3 sky = texture2D(uSkyLut, directionToEquirect(normalize(lutDir))).rgb;
          if (dir.y > 0.0) {
            sky = texture2D(uSkyLut, directionToEquirect(dir)).rgb;
          }

          // Stars and moon sit behind the atmosphere: they only add where the sky is
          // already dark, so daylight puts them out naturally.
          sky += starField(dir) * uNightFactor;
          sky += moonDisc(dir) * mix(0.35, 1.0, uNightFactor);

          // The sun's halo: it complements the geometric disc with the diffuse glow.
          float sunAlign = max(dot(dir, uSunDirection), 0.0);
          sky += vec3(1.0, 0.88, 0.68) * pow(sunAlign, 900.0) * 14.0;
          sky += vec3(1.0, 0.7, 0.42) * pow(sunAlign, 42.0) * 0.25;

          vec4 cloud = clouds(dir);
          sky = mix(sky, cloud.rgb, cloud.a);

          gl_FragColor = vec4(sky, 1.0);
        }
      `,
    });
  }

  /**
   * Updates the sky's state.
   * `nightFactor` runs from 0 (full daylight) to 1 (full night).
   */
  update(
    sunDirection: THREE.Vector3,
    moonDirection: THREE.Vector3,
    sunIntensity: number,
    nightFactor: number,
    time: number,
    windDirection: THREE.Vector2,
  ): void {
    this.domeMaterial.uniforms.uSunDirection!.value.copy(sunDirection);
    this.domeMaterial.uniforms.uMoonDirection!.value.copy(moonDirection);
    this.domeMaterial.uniforms.uNightFactor!.value = nightFactor;
    this.domeMaterial.uniforms.uTime!.value = time;
    this.domeMaterial.uniforms.uWindDirection!.value.copy(windDirection);

    // The LUT is only recomputed when the sun has moved enough to change the color
    // perceptibly — it saves ~30 LUT renders per second.
    if (sunDirection.distanceToSquared(this.lastLutSunDirection) > LUT_UPDATE_THRESHOLD * LUT_UPDATE_THRESHOLD) {
      this.lutDirty = true;
    }

    this.lutMaterial.uniforms.uSunDirection!.value.copy(sunDirection);
    this.lutMaterial.uniforms.uSunIntensity!.value = sunIntensity;
    this.lutMaterial.uniforms.uMoonDirection!.value.copy(moonDirection);
    this.lutMaterial.uniforms.uNightFactor!.value = nightFactor;

    // The moon is the sun again, four hundred thousand times weaker. That exact number
    // would leave the night invisible: the human eye adapts to the dark and the screen
    // does not, so every game exaggerates the moon. MOON_INTENSITY is the dose that keeps
    // the sea legible without turning night into a blue afternoon.
    this.lutMaterial.uniforms.uMoonIntensity!.value =
      MOON_INTENSITY *
      nightFactor *
      THREE.MathUtils.smoothstep(moonDirection.y, -0.06, 0.18);

    // The sun's disc follows the direction, always far enough away not to collide with
    // anything in the scene.
    this.sunMesh.position.copy(sunDirection).multiplyScalar(DOME_RADIUS * 0.85);

    // The disc's radiance lives in the color, not in the opacity: with additive blending
    // the two would do exactly the same thing, and a single knob is easier to calibrate.
    // It has to sit above the Mie halo the LUT already draws around the sun, or else the
    // eye reads "pale smudge" instead of "sun".
    //
    // It falls near the horizon because grazing extinction is real — it is the same
    // reason you can look at the sunset and not at noon — and it dies first in the blue,
    // which leaves the disc orange in the late afternoon with no color table on hand.
    const horizonFade = THREE.MathUtils.smoothstep(sunDirection.y, 0, 0.2);
    const radiance = THREE.MathUtils.lerp(2.4, 26, horizonFade);
    this.sunMaterial.color.setRGB(
      radiance,
      radiance * THREE.MathUtils.lerp(0.5, 0.97, horizonFade),
      radiance * THREE.MathUtils.lerp(0.2, 0.92, horizonFade),
      // Explicitly linear: these are radiance values, not a palette color, and passing
      // them as sRGB would apply the transfer curve on top.
      THREE.LinearSRGBColorSpace,
    );

    // The opacity only takes care of the fade-out below the horizon line.
    this.sunMaterial.opacity = THREE.MathUtils.clamp(sunDirection.y * 40 + 1, 0, 1);
    this.sunMesh.visible = this.sunMaterial.opacity > 0.01;
  }

  /** Repositions the dome and the sun around the observer. */
  follow(cameraPosition: THREE.Vector3): void {
    this.dome.position.copy(cameraPosition);
    this.dome.updateMatrix();
    this.dome.updateMatrixWorld(true);
    this.sunMesh.position.add(cameraPosition);
  }

  /** Renders the LUT if needed. It has to run before the main render. */
  renderLut(renderer: THREE.WebGLRenderer): void {
    if (!this.lutDirty) return;
    this.lutDirty = false;
    this.lutGeneration++;
    this.lastLutSunDirection.copy(this.lutMaterial.uniforms.uSunDirection!.value as THREE.Vector3);

    const previousTarget = renderer.getRenderTarget();
    renderer.setRenderTarget(this.lutTarget);
    renderer.render(this.lutScene, this.lutCamera);
    renderer.setRenderTarget(previousTarget);
  }

  setCloudCoverage(coverage: number): void {
    this.domeMaterial.uniforms.uCloudCoverage!.value = THREE.MathUtils.clamp(coverage, 0, 1);
  }

  setMoonPhase(phase: number): void {
    this.domeMaterial.uniforms.uMoonPhase!.value = phase;
  }

  setCloudColors(sunColor: THREE.Color, shadowColor: THREE.Color): void {
    (this.domeMaterial.uniforms.uCloudSunColor!.value as THREE.Color).copy(sunColor);
    (this.domeMaterial.uniforms.uCloudShadowColor!.value as THREE.Color).copy(shadowColor);
  }

  dispose(): void {
    this.lutTarget.dispose();
    this.lutMaterial.dispose();
    this.domeMaterial.dispose();
    this.sunMaterial.dispose();
    this.dome.geometry.dispose();
    this.sunMesh.geometry.dispose();
  }
}
