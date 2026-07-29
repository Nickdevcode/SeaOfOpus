/**
 * Renderer e composição de pós-processamento.
 *
 * Usa WebGL2 (não WebGPU): o ecossistema de pós-processamento é maduro e o
 * driver AMD é estável nesse caminho. Tone mapping ACES Filmic é o que dá o
 * contraste "filme" sem estourar o sol e o specular do mar.
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

export class Renderer {
  readonly webgl: THREE.WebGLRenderer;
  readonly canvas: HTMLCanvasElement;

  private composer: EffectComposer | null = null;
  private renderPass: RenderPass | null = null;
  private effectPass: EffectPass | null = null;
  private godRaysEffect: GodRaysEffect | null = null;
  private currentScene: THREE.Scene | null = null;
  private currentCamera: THREE.PerspectiveCamera | null = null;

  /** Alvo do god rays: a malha do sol. Precisa ser setado antes de compor. */
  private sunMesh: THREE.Mesh | null = null;

  constructor() {
    this.canvas = document.createElement('canvas');
    this.canvas.id = 'game-canvas';

    this.webgl = new THREE.WebGLRenderer({
      canvas: this.canvas,
      // O antialias do contexto é dispensado: o SMAA do composer cuida disso
      // e ligar os dois só desperdiça banda de memória.
      antialias: false,
      powerPreference: 'high-performance',
      stencil: false,
      depth: true,
    });

    this.webgl.outputColorSpace = THREE.SRGBColorSpace;
    // O tone mapping fica no composer (efeito ACES), então o renderer entrega
    // cor linear crua para o pós-processamento.
    this.webgl.toneMapping = THREE.NoToneMapping;
    this.webgl.shadowMap.enabled = true;
    // `PCFSoftShadowMap` está depreciado desde a r18x e o próprio three cai para
    // `PCFShadowMap` sozinho, cuspindo um aviso a cada carga. Pedir direto o que
    // ele vai usar de qualquer forma deixa o console limpo sem mudar um pixel.
    this.webgl.shadowMap.type = THREE.PCFShadowMap;
    this.webgl.setClearColor(0x000000, 1);

    this.applyQuality(settings.quality);
  }

  /**
   * Monta a cadeia de pós-processamento para uma cena/câmera.
   * Chamado ao entrar no menu e ao entrar na partida.
   */
  compose(scene: THREE.Scene, camera: THREE.PerspectiveCamera, sunMesh: THREE.Mesh | null): void {
    this.currentScene = scene;
    this.currentCamera = camera;
    this.sunMesh = sunMesh;

    this.disposeComposer();

    const quality = settings.quality;
    // HalfFloat evita banding no céu e no specular sem o custo de float cheio.
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
        samples: 48,
        clampMax: 1,
        kernelSize: KernelSize.SMALL,
      });
      effects.push(this.godRaysEffect);
    }

    if (quality.bloom) {
      effects.push(
        new BloomEffect({
          intensity: 0.75,
          // Só o que passa de 1.0 em linear floresce: sol, lanternas e o
          // clarão do canhão. O mar não vira sopa de luz.
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
    const pixelRatio = Math.min(window.devicePixelRatio, 2) * quality.renderScale;
    this.webgl.setPixelRatio(pixelRatio);

    // Bloom, god rays e SMAA são decididos na construção dos efeitos, então
    // trocar de preset em tempo real exige remontar a cadeia. Só vale a pena
    // se já existe uma cena composta — no construtor ainda não existe.
    if (this.currentScene && this.currentCamera) {
      this.compose(this.currentScene, this.currentCamera, this.sunMesh);
      return;
    }

    this.resize();
  }

  resize(): void {
    const width = window.innerWidth;
    const height = window.innerHeight;

    this.webgl.setSize(width, height, false);
    this.composer?.setSize(width, height);

    if (this.currentCamera) {
      this.currentCamera.aspect = width / height;
      this.currentCamera.updateProjectionMatrix();
    }
  }

  /** Informação de GPU para o overlay de debug. */
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
