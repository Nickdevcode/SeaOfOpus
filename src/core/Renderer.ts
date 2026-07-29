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

/**
 * Teto de pixels desenhados por quadro, antes do `renderScale` do preset.
 *
 * 2560×1440 ≈ 3,7 milhões. Ver `pixelRatioFor` para o porquê de existir um teto.
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
    this.webgl.setPixelRatio(this.pixelRatioFor(quality));

    // Bloom, god rays e SMAA são decididos na construção dos efeitos, então
    // trocar de preset em tempo real exige remontar a cadeia. Só vale a pena
    // se já existe uma cena composta — no construtor ainda não existe.
    if (this.currentScene && this.currentCamera) {
      this.compose(this.currentScene, this.currentCamera, this.sunMesh);
      return;
    }

    this.resize();
  }

  /**
   * Quantos pixels reais desenhar por pixel de CSS.
   *
   * ## Por que há um orçamento, e não só o `devicePixelRatio`
   *
   * Porque o custo de tudo que este renderizador faz — oceano, sombras, bloom,
   * god rays, SMAA — é proporcional ao **número de pixels**, e esse número
   * cresce com o quadrado da razão. Uma tela de notebook 1440×900 com razão 2
   * são 5,2 milhões de pixels por quadro; a mesma cena num monitor 1080p de
   * mesa são 2,1 milhões. A máquina do notebook é a mais fraca das duas e estava
   * recebendo duas vezes e meia o trabalho, e o jogador não tinha como saber:
   * o menu de qualidade não fala de resolução, fala de sombra e reflexo.
   *
   * O teto é o de uma tela 1440p. Acima dele a razão é reduzida até caber, o que
   * na prática só acontece em telas HiDPI e 4K — exatamente onde a densidade
   * sobrando é a que menos se enxerga. Abaixo, nada muda.
   *
   * `renderScale` continua entrando por cima: ele é a escolha do preset, este
   * teto é o limite físico. O preset Baixo num 4K quer os dois.
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

    // A razão é reavaliada aqui porque ela depende do tamanho da janela: quem
    // arrasta o jogo de um monitor 4K para um 1080p (ou só redimensiona a aba)
    // muda o orçamento, e sem isto continuaria com a razão do tamanho anterior.
    this.webgl.setPixelRatio(this.pixelRatioFor(settings.quality));
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
