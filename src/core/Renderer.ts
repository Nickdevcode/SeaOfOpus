/**
 * Renderer and post-processing composition.
 *
 * It uses WebGL2 (not WebGPU): the post-processing ecosystem is mature and the AMD driver
 * is stable on that path. ACES Filmic tone mapping is what gives the "film" contrast
 * without blowing out the sun and the sea's specular.
 */

import * as THREE from 'three';
import {
  BloomEffect,
  EffectComposer,
  EffectPass,
  GodRaysEffect,
  KernelSize,
  RenderPass,
  SMAAEffect,
  SMAAPreset,
  ToneMappingEffect,
  ToneMappingMode,
  VignetteEffect,
} from 'postprocessing';

import { settings, type QualitySettings } from './Settings';

/**
 * Ceiling on pixels drawn per frame, before the preset's `renderScale`.
 *
 * 2560×1440 ≈ 3.7 million. See `pixelRatioFor` for why a ceiling exists at all.
 */
const MAX_DRAWN_PIXELS = 2560 * 1440;

export class Renderer {
  readonly webgl: THREE.WebGLRenderer;
  readonly canvas: HTMLCanvasElement;

  private composer: EffectComposer | null = null;
  private renderPass: RenderPass | null = null;
  private effectPass: EffectPass | null = null;
  private godRaysEffect: GodRaysEffect | null = null;
  private currentScene: THREE.Scene | null = null;
  private currentCamera: THREE.PerspectiveCamera | null = null;

  /** The god rays' target: the sun's mesh. It has to be set before composing. */
  private sunMesh: THREE.Mesh | null = null;

  constructor() {
    this.canvas = document.createElement('canvas');
    this.canvas.id = 'game-canvas';

    this.webgl = new THREE.WebGLRenderer({
      canvas: this.canvas,
      // The context's antialias is skipped: the composer's SMAA takes care of that, and
      // switching both on only wastes memory bandwidth.
      antialias: false,
      powerPreference: 'high-performance',
      stencil: false,
      depth: true,
    });

    this.webgl.outputColorSpace = THREE.SRGBColorSpace;
    // The tone mapping lives in the composer (ACES effect), so the renderer hands raw
    // linear color to the post-processing.
    this.webgl.toneMapping = THREE.NoToneMapping;
    this.webgl.shadowMap.enabled = true;
    // `PCFSoftShadowMap` has been deprecated since r18x and three itself falls back to
    // `PCFShadowMap` on its own, spitting a warning on every load. Asking directly for
    // what it is going to use anyway keeps the console clean without changing a pixel.
    this.webgl.shadowMap.type = THREE.PCFShadowMap;
    this.webgl.setClearColor(0x000000, 1);

    this.applyQuality(settings.quality);
  }

  /**
   * Builds the post-processing chain for a scene/camera.
   * Called on entering the menu and on entering the match.
   */
  compose(scene: THREE.Scene, camera: THREE.PerspectiveCamera, sunMesh: THREE.Mesh | null): void {
    this.currentScene = scene;
    this.currentCamera = camera;
    this.sunMesh = sunMesh;

    this.disposeComposer();

    const quality = settings.quality;
    // HalfFloat avoids banding in the sky and in the specular without full float's
    // cost.
    this.composer = new EffectComposer(this.webgl, {
      frameBufferType: THREE.HalfFloatType,
      multisampling: 0,
    });

    this.renderPass = new RenderPass(scene, camera);
    this.composer.addPass(this.renderPass);

    const effects: Array<BloomEffect | GodRaysEffect | SMAAEffect | ToneMappingEffect | VignetteEffect> = [];

    if (quality.godRays && sunMesh) {
      this.godRaysEffect = new GodRaysEffect(camera, sunMesh, {
        density: 0.92,
        decay: 0.93,
        weight: 0.4,
        exposure: 0.55,
        samples: quality.godRaySamples,
        clampMax: 1,
        kernelSize: KernelSize.SMALL,
      });
      effects.push(this.godRaysEffect);
    }

    if (quality.bloom) {
      effects.push(
        new BloomEffect({
          intensity: 0.75,
          // Only what goes past 1.0 in linear blooms: sun, lanterns and the cannon's
          // flash. The sea does not become soup of light.
          luminanceThreshold: 0.92,
          luminanceSmoothing: 0.25,
          mipmapBlur: true,
          radius: 0.62,
        }),
      );
    }

    effects.push(
      new ToneMappingEffect({
        mode: ToneMappingMode.ACES_FILMIC,
      }),
    );

    effects.push(
      new VignetteEffect({
        offset: 0.32,
        darkness: 0.42,
      }),
    );

    if (quality.smaa) {
      effects.push(new SMAAEffect({ preset: SMAAPreset.HIGH }));
    }

    this.effectPass = new EffectPass(camera, ...effects);
    this.composer.addPass(this.effectPass);

    this.resize();
  }

  render(dt: number): void {
    if (this.composer) {
      this.composer.render(dt);
    } else if (this.currentScene && this.currentCamera) {
      this.webgl.render(this.currentScene, this.currentCamera);
    }
  }

  applyQuality(quality: QualitySettings): void {
    this.webgl.shadowMap.enabled = quality.shadowMapSize > 0;
    this.webgl.setPixelRatio(this.pixelRatioFor(quality));

    // Bloom, god rays and SMAA are decided when the effects are built, so changing
    // preset at run time requires rebuilding the chain. It is only worth it if a composed
    // scene already exists — in the constructor it does not yet.
    if (this.currentScene && this.currentCamera) {
      this.compose(this.currentScene, this.currentCamera, this.sunMesh);
      return;
    }

    this.resize();
  }

  /**
   * How many real pixels to draw per CSS pixel.
   *
   * ## Why there is a budget, and not just `devicePixelRatio`
   *
   * Because the cost of everything this renderer does — ocean, shadows, bloom, god rays,
   * SMAA — is proportional to the **number of pixels**, and that number grows with the
   * square of the ratio. A 1440×900 laptop screen at ratio 2 is 5.2 million pixels per
   * frame; the same scene on a desktop 1080p monitor is 2.1 million. The laptop is the
   * weaker of the two machines and was receiving two and a half times the work, and the
   * player had no way to know: the quality menu does not talk about resolution, it talks
   * about shadows and reflections.
   *
   * The ceiling is that of a 1440p screen. Above it the ratio is reduced until it fits,
   * which in practice only happens on HiDPI and 4K screens — exactly where the spare
   * density is the least visible. Below it, nothing changes.
   *
   * `renderScale` still comes in on top: it is the preset's choice, this ceiling is the
   * physical limit. The Low preset on a 4K wants both.
   */
  private pixelRatioFor(quality: QualitySettings): number {
    const width = window.innerWidth;
    const height = window.innerHeight;
    const requested = Math.min(window.devicePixelRatio || 1, 2) * quality.renderScale;

    const cssPixels = Math.max(width * height, 1);
    const budgeted = Math.sqrt(MAX_DRAWN_PIXELS / cssPixels);
    return Math.max(0.5, Math.min(requested, budgeted));
  }

  resize(): void {
    const width = window.innerWidth;
    const height = window.innerHeight;

    // The ratio is re-evaluated here because it depends on the window's size: whoever
    // drags the game from a 4K monitor to a 1080p one (or just resizes the tab) changes
    // the budget, and without this it would keep the previous size's ratio.
    this.webgl.setPixelRatio(this.pixelRatioFor(settings.quality));
    this.webgl.setSize(width, height, false);
    this.composer?.setSize(width, height);

    if (this.currentCamera) {
      this.currentCamera.aspect = width / height;
      this.currentCamera.updateProjectionMatrix();
    }
  }

  /** GPU information for the debug overlay. */
  getGpuInfo(): string {
    const gl = this.webgl.getContext();
    const ext = gl.getExtension('WEBGL_debug_renderer_info');
    if (!ext) return 'unknown GPU';
    return String(gl.getParameter(ext.UNMASKED_RENDERER_WEBGL));
  }

  private disposeComposer(): void {
    this.godRaysEffect?.dispose();
    this.effectPass?.dispose();
    this.renderPass?.dispose();
    this.composer?.dispose();

    this.godRaysEffect = null;
    this.effectPass = null;
    this.renderPass = null;
    this.composer = null;
  }

  dispose(): void {
    this.disposeComposer();
    this.webgl.dispose();
  }
}
