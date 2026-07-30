/**
 * The reflection environment (IBL): the sky and the sea become the ship's indirect light.
 *
 * **Why this has to exist.** The scene already had a `HemisphereLight` standing in for
 * ambient light, and it handles the diffuse: without it the side's shadow would be a
 * black hole. Except that hemisphere light does **not** enter the specular — no analytic
 * light does. For a metallic material that is fatal, because `metalness ≈ 0.9` zeroes the
 * diffuse by definition: metal only has reflection. The result in the game was exactly
 * what the theory predicted and plainly visible on screen: the brass and the cast iron
 * only existed where the sun's specular lobe hit, and there they blew out; outside it,
 * they were black silhouettes. The binnacle's lid, lying open to the sky right in the
 * middle of the screen of whoever is at the helm, read as a gold bar. It was not the
 * color or the roughness: it was that there was no sky at all to reflect.
 *
 * **What it does.** It recomposes a small equirectangular map — sky on top, water below —
 * and puts it through `PMREMGenerator`, which returns the roughness-prefiltered cube
 * `MeshStandardMaterial` knows how to consume. One texture, every material on the ship,
 * diffuse and specular at once.
 *
 * **Why compose instead of using the LUT directly.** The sky's LUT covers the whole
 * sphere, but below the horizon it is the raymarch crossing the planet: a cream band with
 * no physical meaning. It is the same reason the sea's shader mirrors the reflected ray
 * upward instead of clamping it. Feeding the IBL with that would paint the underside of
 * every object aboard sand-colored. Half of what a ship sees is water, and it is water
 * that has to go in there.
 *
 * **Cost.** The source is 256×128 and the cube, 128. The PMREM only runs when `Sky` has
 * actually recomputed the LUT (it already has its own sun-movement threshold) and at most
 * a few times a second. It is a fraction of a millisecond, amortized.
 */

import * as THREE from 'three';
import { EQUIRECT_GLSL } from '../shaders/atmosphere';
import { OCEAN_DEEP_COLOR, OCEAN_SHALLOW_COLOR } from './Ocean';

/** Resolution of the equirectangular map that feeds the PMREM. */
const SOURCE_WIDTH = 256;
const SOURCE_HEIGHT = 128;

/**
 * Minimum interval between two builds, in seconds.
 *
 * `Sky` already holds the LUT by the sun's angle, but on a 12-minute day that threshold
 * fires several times a second — cheap for a quad, expensive for a mip chain. The sky's
 * light changes slowly even at sunset; a third of a second of delay is not perceptible
 * anywhere.
 */
const MIN_INTERVAL = 0.33;

const COMPOSITE_FRAGMENT = /* glsl */ `
precision highp float;

${EQUIRECT_GLSL}

uniform sampler2D uSkyLut;
uniform vec3 uDeepColor;
uniform vec3 uShallowColor;

varying vec2 vUv;

void main() {
  // The LUT uses exactly this mapping, so the UV serves both with no conversion: it is
  // the same atlas, only with the lower half rewritten.
  vec3 direction = equirectToDirection(vUv);
  vec3 sky = texture2D(uSkyLut, vUv).rgb;

  // The same ambient light the sea's shader uses for the water's body, read from the
  // LUT's own zenith. That way the IBL darkens on its own at nightfall, with no parallel
  // curve to keep in sync.
  vec3 zenith = texture2D(uSkyLut, vec2(0.5, 0.02)).rgb;
  vec3 body = mix(uDeepColor, uShallowColor, 0.35) * zenith * 2.1;

  // At a grazing angle the sea is almost only reflected sky (Fresnel near 1); straight
  // down, it is the water's body. The transition at ~20° below the horizon approximates
  // that turn well enough for a texture the PMREM is still going to blur.
  vec3 horizon = texture2D(uSkyLut, vec2(vUv.x, 0.498)).rgb;
  vec3 sea = mix(horizon * 0.6, body, smoothstep(0.0, -0.35, direction.y));

  // A narrow blending band at the horizon: without it there is a hard line the PMREM
  // turns into a ring visible in the low-roughness mips.
  float below = smoothstep(0.035, -0.02, direction.y);
  gl_FragColor = vec4(mix(sky, sea, below), 1.0);
}
`;

export class SkyEnvironment {
  /** The prefiltered cube, ready to become `scene.environment`. */
  get texture(): THREE.Texture | null {
    return this.envTarget?.texture ?? null;
  }

  private readonly pmrem: THREE.PMREMGenerator;
  private readonly sourceTarget: THREE.WebGLRenderTarget;
  private readonly sourceScene = new THREE.Scene();
  private readonly sourceCamera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
  private readonly sourceMaterial: THREE.ShaderMaterial;
  private readonly sourceQuad: THREE.Mesh;

  private envTarget: THREE.WebGLRenderTarget | null = null;
  private lastGeneration = -1;
  private sinceLastBuild = MIN_INTERVAL;

  constructor(renderer: THREE.WebGLRenderer) {
    this.pmrem = new THREE.PMREMGenerator(renderer);
    // Compiling now avoids the compilation stutter on the game's first frame.
    this.pmrem.compileEquirectangularShader();

    this.sourceTarget = new THREE.WebGLRenderTarget(SOURCE_WIDTH, SOURCE_HEIGHT, {
      // The sky has a high dynamic range and the PMREM is only useful if it survives:
      // at 8 bits the sun's highlight saturates and the reflection loses what matters.
      type: THREE.HalfFloatType,
      format: THREE.RGBAFormat,
      depthBuffer: false,
      stencilBuffer: false,
    });
    this.sourceTarget.texture.mapping = THREE.EquirectangularReflectionMapping;
    this.sourceTarget.texture.minFilter = THREE.LinearFilter;
    this.sourceTarget.texture.magFilter = THREE.LinearFilter;
    // The seam at φ = ±π falls in the middle of the texture when wrapping: without
    // repetition in X the PMREM reads the mirrored edge and draws a vertical join in the
    // cube.
    this.sourceTarget.texture.wrapS = THREE.RepeatWrapping;
    this.sourceTarget.texture.wrapT = THREE.ClampToEdgeWrapping;

    this.sourceMaterial = new THREE.ShaderMaterial({
      vertexShader: /* glsl */ `
        varying vec2 vUv;
        void main() {
          vUv = uv;
          gl_Position = vec4(position.xy, 0.0, 1.0);
        }
      `,
      fragmentShader: COMPOSITE_FRAGMENT,
      depthTest: false,
      depthWrite: false,
      uniforms: {
        uSkyLut: { value: null },
        uDeepColor: { value: OCEAN_DEEP_COLOR.clone() },
        uShallowColor: { value: OCEAN_SHALLOW_COLOR.clone() },
      },
    });

    this.sourceQuad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), this.sourceMaterial);
    this.sourceQuad.frustumCulled = false;
    this.sourceScene.add(this.sourceQuad);
  }

  /**
   * Rebuilds the environment if the sky changed and the minimum interval has passed.
   *
   * `generation` is `Sky`'s LUT render counter: while it does not move, there is nothing
   * new to prefilter. It returns `true` when it rebuilt, which is when the caller has to
   * reassign `scene.environment`.
   */
  update(renderer: THREE.WebGLRenderer, skyLut: THREE.Texture, generation: number, dt: number): boolean {
    this.sinceLastBuild += dt;
    if (generation === this.lastGeneration) return false;
    if (this.sinceLastBuild < MIN_INTERVAL && this.envTarget) return false;

    this.lastGeneration = generation;
    this.sinceLastBuild = 0;

    this.sourceMaterial.uniforms.uSkyLut!.value = skyLut;

    const previousTarget = renderer.getRenderTarget();
    renderer.setRenderTarget(this.sourceTarget);
    renderer.render(this.sourceScene, this.sourceCamera);
    renderer.setRenderTarget(previousTarget);

    // Passing the previous target makes the generator reuse it instead of allocating a
    // new mip chain every few frames.
    this.envTarget = this.pmrem.fromEquirectangular(this.sourceTarget.texture, this.envTarget ?? undefined);
    return true;
  }

  dispose(): void {
    this.envTarget?.dispose();
    this.sourceTarget.dispose();
    this.sourceMaterial.dispose();
    this.sourceQuad.geometry.dispose();
    this.pmrem.dispose();
  }
}
