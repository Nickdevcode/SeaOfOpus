/**
 * A esteira — o rastro de espuma que o casco deixa na água.
 *
 * É um mapa de densidade de espuma desenhado num render target quadrado que
 * acompanha o navio, e que o shader do oceano lê em `sampleWake`. A cada quadro
 * acontecem dois passes:
 *
 * 1. **Desvanecimento** — o alvo anterior é copiado para o novo com um
 *    deslocamento de UV que compensa o quanto o centro andou, multiplicado pelo
 *    decaimento e com uma difusão leve. É isso que faz a espuma *ficar na água*
 *    em vez de andar junto com o navio: o conteúdo é reprojetado no mundo.
 * 2. **Carimbo** — cada casco desenha um quadrilátero por cima, aditivo, com a
 *    forma da espuma que ele está produzindo *agora*. Quadros sucessivos ao
 *    longo da trajetória é que constroem o rastro; ninguém desenha o rastro
 *    inteiro de uma vez.
 *
 * **Por que ping-pong e não um alvo só.** Ler e escrever a mesma textura no
 * mesmo passe é comportamento indefinido em WebGL; a única saída barata é ter
 * dois alvos e alternar.
 *
 * **Por que o centro é encaixado na grade de texels.** Se ele andasse livre, o
 * deslocamento de UV cairia no meio de um texel e a amostragem bilinear borraria
 * o mapa inteiro a cada quadro — em dez segundos a espuma vira névoa. Encaixado,
 * o deslocamento é sempre um número inteiro de texels e a cópia é exata.
 */

import * as THREE from 'three';
import type { QualitySettings } from '../core/Settings';
import { NOISE_GLSL } from '../shaders/noise';
import { HULL_BEAM, HULL_LENGTH } from '../ship/ShipDimensions';
import type { Ship } from '../ship/Ship';

/**
 * Aresta da área coberta, em metros.
 *
 * O duelo acontece entre 40 e 120 m; 256 m cobrem a manobra inteira com folga e
 * ainda dão 0,5 m por texel na resolução média. Aumentar isso desperdiça texels
 * em água vazia — a esteira só existe onde alguém passou.
 */
const WAKE_SIZE = 256;

/**
 * Meia-vida útil da espuma, em segundos.
 *
 * O rastro visível de uma chalupa a 8 nós tem uns 60 m; a 4 m/s isso dá ~15 s de
 * vida. O decaimento é exponencial, então a cauda some antes disso — na prática
 * o rastro fica em torno de 50 m, que é o que se vê no jogo.
 */
const FOAM_LIFETIME = 14;

/** Quanto o quadrilátero de carimbo é maior que o casco, em cada eixo. */
const STAMP_BEAM = 2.4;
const STAMP_LENGTH = 1.2;

/** Meias dimensões do casco em unidades normalizadas do carimbo. */
const HULL_HALF = 1 / STAMP_BEAM;
const HULL_END = 1 / STAMP_LENGTH;

/**
 * Velocidade em que a esteira já está no talo, em m/s.
 *
 * ~5,7 nós. Acima disso a espuma não fica mais densa, só mais longa — que é o
 * que a integração ao longo do tempo faz sozinha.
 */
const FULL_WAKE_SPEED = 2.9;

/** Densidade acrescentada por segundo de navegação a toda velocidade. */
const EMISSION_RATE = 2.6;

const FADE_VERTEX = /* glsl */ `
  varying vec2 vUv;

  void main() {
    vUv = uv;
    gl_Position = vec4(position.xy, 0.0, 1.0);
  }
`;

const FADE_FRAGMENT = /* glsl */ `
  uniform sampler2D uPrevious;
  uniform vec2 uOffset;
  uniform vec2 uTexel;
  uniform float uDecay;

  varying vec2 vUv;

  void main() {
    vec2 uv = vUv + uOffset;

    // Fora do mapa anterior não havia espuma nenhuma: é água que acabou de
    // entrar na área. Sem este teste o ClampToEdge esticaria a borda para
    // dentro e o navio pareceria arrastar uma mancha atrás de si.
    if (any(lessThan(uv, vec2(0.0))) || any(greaterThan(uv, vec2(1.0)))) {
      gl_FragColor = vec4(0.0);
      return;
    }

    float center = texture2D(uPrevious, uv).r;
    float neighbours =
      texture2D(uPrevious, uv + vec2(uTexel.x, 0.0)).r +
      texture2D(uPrevious, uv - vec2(uTexel.x, 0.0)).r +
      texture2D(uPrevious, uv + vec2(0.0, uTexel.y)).r +
      texture2D(uPrevious, uv - vec2(0.0, uTexel.y)).r;

    // Difusão leve: espuma se espalha enquanto morre. Pesada demais e o rastro
    // vira um borrão; de menos e as bordas do carimbo ficam duras.
    float value = mix(center, neighbours * 0.25, 0.2) * uDecay;

    gl_FragColor = vec4(value, 0.0, 0.0, 1.0);
  }
`;

const STAMP_VERTEX = /* glsl */ `
  varying vec2 vUv;
  varying vec2 vWorld;

  void main() {
    vUv = uv;
    vec4 world = modelMatrix * vec4(position, 1.0);
    vWorld = world.xz;
    gl_Position = projectionMatrix * viewMatrix * world;
  }
`;

const STAMP_FRAGMENT = /* glsl */ `
  uniform float uAmount;
  uniform float uTime;

  varying vec2 vUv;
  varying vec2 vWorld;

  ${NOISE_GLSL}

  void main() {
    // p.x é o través, p.y corre da popa (−1) para a proa (+1). O carimbo é
    // maior que o casco, então "along" reescala p.y para que ±1 caiam
    // exatamente no talhamar e no painel de popa.
    vec2 p = vUv * 2.0 - 1.0;
    float across = abs(p.x);
    float along = clamp(p.y / ${HULL_END.toFixed(5)}, -1.0, 1.0);

    // Meia largura do casco na altura da linha d'água: afila até um ponto na
    // proa e afina de leve na popa, que na chalupa é um painel estreito.
    float bow = max(along, 0.0);
    float stern = max(-along, 0.0);
    float halfWidth = ${HULL_HALF.toFixed(5)} *
      (1.0 - pow(bow, 2.6)) *
      (1.0 - 0.18 * pow(stern, 3.0));

    // A faixa de espuma nasce onde o costado empurra a água para o lado: nas
    // duas bordas do casco, não embaixo dele.
    float edge = abs(across - halfWidth);
    float side = 1.0 - smoothstep(0.0, 0.16, edge);
    // Na proa a onda ainda está se formando; a espuma abre pouco atrás dela.
    side *= smoothstep(1.0, 0.72, along);

    // Popa: água revolvida pelo leme e pelo vazio que o casco deixa. Mais larga
    // e mais suja que as faixas laterais.
    float churn = smoothstep(-0.42, -1.0, p.y) *
      (1.0 - smoothstep(halfWidth * 0.9, halfWidth * 1.45, across));

    // O ruído é ancorado no **mundo**, não no casco: preso ao casco, o grão
    // andaria junto e o rastro sairia listrado.
    float grain = fbm(vec3(vWorld * 0.6, uTime * 0.15), 3, 2.0, 0.5);

    float density = max(side, churn * 0.9) * (0.5 + 0.75 * grain);

    gl_FragColor = vec4(density * uAmount, 0.0, 0.0, 1.0);
  }
`;

/** Alvo de espuma: R8 é tudo que o oceano lê, e custa um quarto de um RGBA. */
function createTarget(resolution: number): THREE.WebGLRenderTarget {
  const target = new THREE.WebGLRenderTarget(resolution, resolution, {
    format: THREE.RedFormat,
    type: THREE.UnsignedByteType,
    minFilter: THREE.LinearFilter,
    magFilter: THREE.LinearFilter,
    wrapS: THREE.ClampToEdgeWrapping,
    wrapT: THREE.ClampToEdgeWrapping,
    depthBuffer: false,
    stencilBuffer: false,
    generateMipmaps: false,
  });
  target.texture.name = 'wake-foam';
  return target;
}

const _shipPosition = new THREE.Vector3();

export class WakeFoam {
  /** Centro da área coberta, em metros de mundo. Só x e z importam. */
  readonly center = new THREE.Vector3();
  readonly size = WAKE_SIZE;

  private front: THREE.WebGLRenderTarget;
  private back: THREE.WebGLRenderTarget;
  private resolution: number;
  private texelSize: number;

  private readonly fadeScene = new THREE.Scene();
  private readonly fadeCamera = new THREE.Camera();
  private readonly fadeMaterial: THREE.ShaderMaterial;

  private readonly stampScene = new THREE.Scene();
  private readonly stampCamera: THREE.OrthographicCamera;
  private readonly stampGeometry: THREE.BufferGeometry;
  private readonly stamps: THREE.Mesh[] = [];

  private time = 0;
  /** Falso até o primeiro passe: antes disso o alvo tem lixo de alocação. */
  private primed = false;

  constructor(quality: QualitySettings) {
    this.resolution = quality.wakeResolution;
    this.texelSize = WAKE_SIZE / this.resolution;
    this.front = createTarget(this.resolution);
    this.back = createTarget(this.resolution);

    this.fadeMaterial = new THREE.ShaderMaterial({
      uniforms: {
        uPrevious: { value: null },
        uOffset: { value: new THREE.Vector2() },
        uTexel: { value: new THREE.Vector2(1 / this.resolution, 1 / this.resolution) },
        uDecay: { value: 1 },
      },
      vertexShader: FADE_VERTEX,
      fragmentShader: FADE_FRAGMENT,
      depthTest: false,
      depthWrite: false,
    });

    // Triângulo de tela cheia: um a menos que o quad, e sem a costura diagonal
    // onde os dois triângulos se encontram.
    const fullscreen = new THREE.BufferGeometry();
    fullscreen.setAttribute(
      'position',
      new THREE.BufferAttribute(new Float32Array([-1, -1, 0, 3, -1, 0, -1, 3, 0]), 3),
    );
    fullscreen.setAttribute('uv', new THREE.BufferAttribute(new Float32Array([0, 0, 2, 0, 0, 2]), 2));
    const fadeMesh = new THREE.Mesh(fullscreen, this.fadeMaterial);
    fadeMesh.frustumCulled = false;
    this.fadeScene.add(fadeMesh);

    // Câmera olhando para baixo, com **top e bottom trocados**. A inversão do
    // eixo Y da projeção é o que faz `uv.y` crescer com o Z do mundo, que é a
    // convenção que `Ocean.sampleWake` espera. Sem ela a esteira sairia
    // espelhada e apareceria do lado errado do casco.
    const half = WAKE_SIZE / 2;
    this.stampCamera = new THREE.OrthographicCamera(-half, half, -half, half, 0.1, 400);
    this.stampCamera.rotation.x = -Math.PI / 2;

    // Quadrilátero no plano XZ, com v = 1 na proa (−Z local, como no navio).
    this.stampGeometry = new THREE.PlaneGeometry(1, 1).rotateX(-Math.PI / 2);
  }

  /** A textura que o oceano amostra. */
  get texture(): THREE.Texture {
    return this.front.texture;
  }

  /**
   * Avança a esteira um quadro.
   *
   * Tem que rodar na fase de render (mexe em render targets) e depois de
   * `syncModel`, para carimbar na pose que vai aparecer na tela.
   */
  update(renderer: THREE.WebGLRenderer, dt: number, ships: readonly Ship[]): void {
    if (dt <= 0) return;
    this.time += dt;

    const previousCenter = this.center.clone();
    this.recenter(ships);

    const offset = this.fadeMaterial.uniforms.uOffset!.value as THREE.Vector2;
    offset.set(
      (this.center.x - previousCenter.x) / WAKE_SIZE,
      (this.center.z - previousCenter.z) / WAKE_SIZE,
    );
    // Decaimento exponencial exato: independe da taxa de quadros.
    this.fadeMaterial.uniforms.uDecay!.value = this.primed ? Math.exp(-dt / FOAM_LIFETIME) : 0;
    this.fadeMaterial.uniforms.uPrevious!.value = this.front.texture;

    this.syncStamps(dt, ships);

    const previousTarget = renderer.getRenderTarget();
    const previousAutoClear = renderer.autoClear;

    renderer.setRenderTarget(this.back);
    renderer.autoClear = false;
    renderer.render(this.fadeScene, this.fadeCamera);

    if (this.stampScene.children.length > 0) {
      this.stampCamera.position.set(this.center.x, 100, this.center.z);
      this.stampCamera.updateMatrixWorld();
      renderer.render(this.stampScene, this.stampCamera);
    }

    renderer.autoClear = previousAutoClear;
    renderer.setRenderTarget(previousTarget);

    const swap = this.front;
    this.front = this.back;
    this.back = swap;
    this.primed = true;
  }

  /** Apaga tudo — usado ao reiniciar a partida. */
  reset(): void {
    this.primed = false;
    this.center.set(0, 0, 0);
  }

  applyQuality(quality: QualitySettings): void {
    if (quality.wakeResolution === this.resolution) return;
    this.resolution = quality.wakeResolution;
    this.texelSize = WAKE_SIZE / this.resolution;
    this.front.setSize(this.resolution, this.resolution);
    this.back.setSize(this.resolution, this.resolution);
    (this.fadeMaterial.uniforms.uTexel!.value as THREE.Vector2).set(
      1 / this.resolution,
      1 / this.resolution,
    );
    this.primed = false;
  }

  dispose(): void {
    this.front.dispose();
    this.back.dispose();
    this.fadeMaterial.dispose();
    (this.fadeScene.children[0] as THREE.Mesh).geometry.dispose();
    this.stampGeometry.dispose();
    for (const stamp of this.stamps) (stamp.material as THREE.Material).dispose();
    this.stampScene.clear();
  }

  /**
   * Reposiciona a área sobre o primeiro navio, encaixada na grade de texels.
   *
   * O primeiro da lista é o do jogador. Centrar no meio dos dois seria mais
   * "justo", mas faria a área saltar quando um deles afundasse.
   */
  private recenter(ships: readonly Ship[]): void {
    const lead = ships[0];
    if (!lead) return;
    const position = lead.model.root.position;
    this.center.set(
      Math.round(position.x / this.texelSize) * this.texelSize,
      0,
      Math.round(position.z / this.texelSize) * this.texelSize,
    );
  }

  /** Põe um carimbo por navio que esteja produzindo espuma neste instante. */
  private syncStamps(dt: number, ships: readonly Ship[]): void {
    this.stampScene.clear();

    for (let i = 0; i < ships.length; i++) {
      const ship = ships[i]!;
      if (ship.damage.isSunk) continue;

      // Velocidade sobre a água na direção que importa: um navio parado de
      // través na corrente não abre esteira, um navio a ré abre.
      const speed = Math.abs(ship.surge);
      const strength = Math.min(speed / FULL_WAKE_SPEED, 1);
      if (strength < 0.02) continue;

      const stamp = this.getStamp(i);
      _shipPosition.copy(ship.model.root.position);
      stamp.position.set(_shipPosition.x, 0, _shipPosition.z);
      stamp.rotation.y = ship.heading;
      stamp.scale.set(HULL_BEAM * STAMP_BEAM, 1, HULL_LENGTH * STAMP_LENGTH);

      const uniforms = (stamp.material as THREE.ShaderMaterial).uniforms;
      // Emissão por *tempo*, não por quadro: a 30 ou a 144 fps o rastro tem a
      // mesma densidade.
      uniforms.uAmount!.value = strength * EMISSION_RATE * dt;
      uniforms.uTime!.value = this.time;

      this.stampScene.add(stamp);
    }
  }

  /** Carimbos são criados sob demanda e reaproveitados — um por navio. */
  private getStamp(index: number): THREE.Mesh {
    let stamp = this.stamps[index];
    if (stamp) return stamp;

    const material = new THREE.ShaderMaterial({
      uniforms: {
        uAmount: { value: 0 },
        uTime: { value: 0 },
      },
      vertexShader: STAMP_VERTEX,
      fragmentShader: STAMP_FRAGMENT,
      transparent: true,
      // Aditivo: cada quadro soma um pouco de espuma no que já estava lá.
      blending: THREE.AdditiveBlending,
      depthTest: false,
      depthWrite: false,
      // A projeção tem Y invertido, o que troca o sentido de enrolamento dos
      // triângulos; desenhar os dois lados evita depender disso.
      side: THREE.DoubleSide,
    });

    stamp = new THREE.Mesh(this.stampGeometry, material);
    stamp.frustumCulled = false;
    this.stamps[index] = stamp;
    return stamp;
  }
}
