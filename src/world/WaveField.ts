/**
 * Campo de ondas de Gerstner — a fonte única da verdade sobre o mar.
 *
 * ⚠️ Esta é a peça mais delicada do jogo. A altura da onda é consumida em dois
 * lugares que PRECISAM concordar:
 *   - GPU (vertex shader do oceano): define onde a água aparece.
 *   - CPU (flutuabilidade do navio): define onde o navio flutua.
 * Se divergirem, o navio afunda ou voa. Para garantir a paridade, os dois lados
 * leem exatamente o mesmo array de parâmetros (`uniformA`/`uniformB`) e usam a
 * mesma formulação — o GLSL abaixo é o espelho literal do TypeScript.
 *
 * Modelo: ondas de Gerstner (trochoidais). Diferente de um seno simples, elas
 * deslocam o vértice também na horizontal, o que afina as cristas e alarga os
 * vales — é o que dá o perfil de mar de verdade. A relação de dispersão usa
 * ω = √(g·k), de águas profundas, então ondas longas viajam mais rápido que as
 * curtas, como no mar real.
 */

import * as THREE from 'three';
import { GRAVITY, TAU, angleDelta, createRandom } from '../core/MathUtils';

export interface GerstnerWave {
  /**
   * Desvio da direção desta onda em relação ao vento, em radianos.
   *
   * Guardar o **desvio** em vez da direção absoluta é o que permite o mar
   * acompanhar o vento girando. Antes cada onda nascia com um vetor fixo,
   * calculado uma vez a partir do vento inicial; girar o vento depois disso não
   * mexia em nada, e o mar continuava vindo do mesmo lado para sempre. Agora a
   * direção é recomposta a cada `syncUniforms`, então o campo inteiro gira junto
   * — devagar, como o mar realmente faz quando o vento roda.
   */
  offset: number;
  /**
   * Quanto esta onda obedece ao vento de agora, 0..1.
   *
   * As vagas do vento (`1`) mudam de rumo com ele. A ondulação de fundo (`0,25`)
   * quase não muda: ela foi levantada por um vento que soprou horas atrás e a
   * centenas de quilômetros daqui, e continua correndo no rumo antigo. Essa
   * teimosia é o que produz **mar cruzado** — duas famílias de onda em ângulo,
   * que se somam e se cancelam em manchas. É a diferença entre um mar e uma
   * chapa ondulada.
   */
  follow: number;
  /** Direção de propagação, normalizada. Recomposta a cada sincronização. */
  direction: THREE.Vector2;
  /** Altura da crista ao nível médio, em metros. */
  amplitude: number;
  /** Distância entre cristas, em metros. */
  waveLength: number;
  /** 0..1 — quão afiada é a crista. A soma é limitada para não fazer laço. */
  steepness: number;
  /** Multiplicador artístico sobre a velocidade física de fase. */
  speed: number;
  /** Deslocamento de fase inicial, evita todas as ondas alinhadas na origem. */
  phase: number;
}

/** Máximo de ondas suportado pelo shader (define o tamanho do array uniform). */
export const MAX_WAVES = 6;

/** Iterações do ponto fixo ao inverter o deslocamento horizontal. */
const INVERSE_ITERATIONS = 4;

/** Multiplicador de amplitude com o vento no mínimo e no máximo. */
const MIN_AMPLITUDE_SCALE = 0.45;
const MAX_AMPLITUDE_SCALE = 1.85;

export class WaveField {
  readonly waves: GerstnerWave[] = [];

  /** Direção do vento em radianos (0 = +X). Alimenta a direção das ondas. */
  windDirection: number;
  /**
   * Rumo de onde veio a ondulação de fundo, em radianos.
   *
   * Diferente do vento porque a swell tem memória: ela foi levantada longe daqui
   * e continua no rumo antigo enquanto o vento local já mudou. É a defasagem
   * entre os dois que produz o mar cruzado.
   */
  swellDirection: number;
  /** Intensidade do vento, 0..1. Escala amplitude e velocidade. */
  windStrength: number;

  /** Buffers enviados ao shader: (dirX, dirZ, amplitude, waveLength). */
  readonly uniformA: THREE.Vector4[] = [];
  /** Buffers enviados ao shader: (steepness, omega, phase, 0). */
  readonly uniformB: THREE.Vector4[] = [];

  /** Tempo de simulação do mar, avançado por `update`. */
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
   * Gera o espectro de ondas.
   *
   * Duas swells dão o balanço grande que faz o navio jogar; as curtas dão a
   * textura da superfície. As direções se abrem em leque em torno do vento
   * (± ~50°), como num mar real parcialmente desenvolvido.
   *
   * ⚠️ **A escala aqui é uma decisão de jogo, não de oceanografia.** O que manda
   * é o tamanho da Chalupa: 16 m de comprimento. Swells de 60 m com 2 m de
   * amplitude — que é um mar de verdade com vento de 15 m/s — fazem o navio
   * parecer um brinquedo e o arremessam de um jeito que só atrapalha o combate.
   * O Sea of Thieves resolve o mesmo problema do mesmo jeito: mar curto, de
   * ~1,5 m de crista a cava, em que o casco atravessa uma ou duas ondas por vez.
   * Os números abaixo foram calibrados contra `getElevationSigma()` para isso.
   */
  generate(waveCount: number, seed: number): void {
    const random = createRandom(seed);
    const count = Math.min(waveCount, MAX_WAVES);

    this.waves.length = 0;

    for (let i = 0; i < count; i++) {
      const isSwell = i < 2;
      const t = count > 1 ? i / (count - 1) : 0;

      // A swell tem de ser maior que o navio para levantá-lo inteiro, mas não
      // tanto que ele suma dentro dela: 1,5 a 2,5 comprimentos de casco.
      const waveLength = isSwell
        ? 26 + random() * 16 // 26–42 m
        : 3.5 + t * 13 + random() * 4.5; // 3,5–21 m

      // O leque das vagas curtas abre bem mais que o das swells. A swell longa
      // chega de um rumo só, quase de frente de onda reta; o marulho de vento é
      // desorganizado por natureza. Um leque de ±26° em tudo, como havia antes,
      // dava um mar que parecia impresso num rolo.
      const spread = isSwell ? 1.1 : 1.5;
      const offset = (random() - 0.5) * spread;

      // Razão amplitude/comprimento bem abaixo do limite de quebra (1/20): é o
      // que faz o mar ler como "bom tempo" em vez de temporal.
      const steepnessRatio = isSwell ? 0.01 : 0.014;
      const amplitude = waveLength * steepnessRatio * (0.7 + random() * 0.6);

      this.waves.push({
        offset,
        // Ver `follow`: a swell arrasta o rumo antigo, a vaga curta obedece ao
        // vento de agora. As duas juntas é que dão mar cruzado.
        follow: isSwell ? 0.25 : 1,
        direction: new THREE.Vector2(1, 0),
        amplitude,
        waveLength,
        // Steepness mais alta compensa a amplitude menor: mantém a crista afiada
        // e o vale largo, que é o perfil que faz a água parecer água.
        steepness: isSwell ? 0.7 : 0.95,
        speed: 0.85 + random() * 0.3,
        phase: random() * TAU,
      });
    }

    // A referência de onde as swells vieram. Elas giram a um quarto da taxa do
    // vento a partir daqui, e é essa defasagem que abre o ângulo entre as duas
    // famílias de onda ao longo de uma partida.
    this.swellDirection = this.windDirection;

    this.normalizeSteepness();
    this.syncUniforms();
  }

  /**
   * Limita a soma de Q·k·A para que o deslocamento horizontal nunca dobre a
   * onda sobre si mesma (o "laço" de Gerstner, que vira artefato visual feio).
   */
  private normalizeSteepness(): void {
    let total = 0;
    for (const wave of this.waves) {
      const k = TAU / wave.waveLength;
      // Contra o **pior caso**, não contra a amplitude de repouso: a amplitude
      // enviada ao shader é multiplicada por até `MAX_AMPLITUDE_SCALE` quando o
      // vento vai ao talo, e normalizar pela amplitude nua deixaria a onda de
      // temporal laçando sobre si mesma. O sintoma é feio e inconfundível: a
      // crista se dobra para trás e a superfície vira uma casca com bolsões
      // dentro, com o mar aparecendo pelo avesso.
      total += wave.steepness * k * wave.amplitude * MAX_AMPLITUDE_SCALE;
    }
    if (total > 1) {
      const scale = 0.92 / total;
      for (const wave of this.waves) wave.steepness *= scale;
    }
  }

  /** Reempacota os parâmetros nos buffers lidos pelo shader. */
  syncUniforms(): void {
    for (let i = 0; i < MAX_WAVES; i++) {
      const wave = this.waves[i];
      if (!wave) {
        // Ondas não usadas ficam com amplitude 0: o shader soma zero.
        this.uniformA[i]!.set(1, 0, 0, 1);
        this.uniformB[i]!.set(0, 0, 0, 0);
        continue;
      }

      // A direção é **recomposta** a cada sincronização, misturando o rumo do
      // vento de agora com o rumo antigo da ondulação segundo o `follow` de
      // cada onda. É esta linha que faz o mar girar com o vento.
      const base = wave.follow * this.windDirection + (1 - wave.follow) * this.swellDirection;
      const angle = base + wave.offset;
      wave.direction.set(Math.cos(angle), Math.sin(angle));

      const k = TAU / wave.waveLength;
      // Dispersão de águas profundas: ondas longas correm mais.
      const omega = Math.sqrt(GRAVITY * k) * wave.speed;
      // A faixa vai de 0,45 (calmaria) a 1,85 (temporal), e não dos antigos 0,55
      // a 1,20. O teto de antes era o problema: com vento no talo o mar subia só
      // 20% acima do padrão, então "tempestade" e "brisa" davam ondas quase
      // iguais e a diferença ficava só na cor do céu. Quatro vezes de faixa é o
      // que separa um mar em que se navega de um em que se sobrevive.
      const amplitude =
        wave.amplitude *
        (MIN_AMPLITUDE_SCALE + this.windStrength * (MAX_AMPLITUDE_SCALE - MIN_AMPLITUDE_SCALE));

      this.uniformA[i]!.set(wave.direction.x, wave.direction.y, amplitude, wave.waveLength);
      this.uniformB[i]!.set(wave.steepness, omega, wave.phase, 0);
    }
  }

  /**
   * Gira o rumo do mar. A ondulação de fundo segue mais devagar que o vento — é
   * assim que o ângulo entre as duas famílias de onda se abre com o tempo.
   *
   * @param windDirection rumo do vento agora, em radianos.
   * @param dt passo, em segundos.
   */
  followWind(windDirection: number, dt: number): void {
    this.windDirection = windDirection;
    // A swell persegue o vento a um quarto da velocidade. Sem esta linha ela
    // ficaria travada no rumo do início da partida e, depois de meia hora, o mar
    // cruzado viraria mar oposto.
    const delta = angleDelta(this.swellDirection, windDirection);
    this.swellDirection += delta * Math.min(dt * 0.02, 1);
  }

  update(dt: number): void {
    this.time += dt;
  }

  /**
   * Deslocamento de Gerstner a partir de um ponto da grade.
   * Espelha exatamente `gerstnerDisplacement` do GLSL.
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
   * Altura da superfície na coluna vertical (worldX, worldZ).
   *
   * Como Gerstner move o vértice na horizontal, o ponto da grade que acaba
   * *acima* de (worldX, worldZ) não é (worldX, worldZ). Resolvemos por
   * iteração de ponto fixo: chuta a grade, mede o quanto ela se deslocou e
   * corrige. Converge em 3–4 passos porque o deslocamento é sempre menor que
   * o comprimento de onda.
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
   * Altura e normal da superfície. A normal sai das derivadas analíticas do
   * deslocamento — nada de diferença finita, que ficaria ruidosa.
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
      // Tangentes parciais ∂P/∂x e ∂P/∂z somadas onda a onda.
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

      // normal = bitangente × tangente (ordem que devolve +Y para mar calmo)
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

  /** Vetor do vento no plano XZ, escalado pela intensidade. */
  getWindVector(target: THREE.Vector2): THREE.Vector2 {
    return target.set(Math.cos(this.windDirection), Math.sin(this.windDirection)).multiplyScalar(this.windStrength);
  }

  /**
   * Altura máxima teórica da soma das ondas — o pior caso, quando todas as
   * cristas coincidem. Serve para dimensionar limites de segurança (câmera,
   * frustum de sombra), não para normalizar cor: na prática o mar quase nunca
   * chega perto disso.
   */
  getMaxAmplitude(): number {
    let total = 0;
    for (let i = 0; i < MAX_WAVES; i++) total += this.uniformA[i]!.z;
    return total;
  }

  /**
   * Desvio padrão da elevação (σ), a medida estatística que a oceanografia usa
   * para descrever um estado de mar: para uma soma de senoides independentes,
   * σ² = Σ A²/2, e a *altura significativa* é ≈ 4σ. É a escala certa para
   * decidir o que é "crista" — bem melhor que a soma das amplitudes.
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
 * Trecho GLSL espelhando `displace` e a derivação de normal acima.
 *
 * É injetado tanto no vertex shader do oceano quanto em qualquer efeito que
 * precise da superfície. Mantenha lado a lado com o TypeScript: qualquer
 * mudança aqui precisa da mesma mudança lá.
 *
 * > [!warning] A paridade é mantida à mão, e **não** há teste que a prove
 * > Este comentário prometia um `tests/wave-parity.ts` que nunca foi escrito, o
 * > que é pior que não prometer nada: quem mexe no shader lê a promessa e confia
 * > numa rede que não existe. Provar paridade de verdade exigiria executar este
 * > GLSL, ou seja, uma GPU e um contexto WebGL — e os testes deste projeto rodam
 * > sem nada disso. Enquanto isso não existir, a única defesa é a revisão lado a
 * > lado: `displace` (com `footprint = 0`) e `gerstnerDisplacement` têm de ser a
 * > mesma conta, termo a termo.
 */
export const WAVE_GLSL = /* glsl */ `
#define MAX_WAVES ${MAX_WAVES}
#define TAU 6.283185307179586

uniform vec4 uWaveA[MAX_WAVES]; // (dirX, dirZ, amplitude, waveLength)
uniform vec4 uWaveB[MAX_WAVES]; // (steepness, omega, phase, unused)
uniform float uWaveTime;

/**
 * Peso de uma onda dada a resolução disponível para amostrá-la.
 *
 * \`footprint\` é a distância, em metros de mundo, entre duas amostras vizinhas —
 * o espaçamento entre vértices no vertex shader, o tamanho do pixel projetado
 * no fragment shader. Nyquist exige pelo menos 2 amostras por período: abaixo
 * disso a onda não é reconstruída, ela vira ruído que ferve. Então a onda entra
 * gradualmente entre 2 e 4 amostras por período em vez de aparecer aliasada.
 *
 * Isso substitui um LOD por distância: o critério é a resolução real, então
 * mudar densidade de malha, FOV ou resolução de tela ajusta o corte sozinho.
 *
 * Com \`footprint = 0.0\` o peso é 1 para toda onda — é o caso que a CPU usa, e
 * é o que mantém a paridade com \`WaveField.displace\` exata.
 */
float waveFilterWeight(float waveLength, float footprint) {
  return smoothstep(2.0 * footprint, 4.0 * footprint + 1e-4, waveLength);
}

/**
 * Deslocamento de Gerstner filtrado para a resolução de amostragem.
 * Espelha \`WaveField.displace\` quando \`footprint\` é 0.
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

/** Espelho literal de \`WaveField.displace\`. */
vec3 gerstnerDisplacement(vec2 gridPos) {
  return gerstnerDisplacementFiltered(gridPos, 0.0);
}

/**
 * Normal analítica, jacobiano e a variância de inclinação descartada pelo filtro.
 *
 * - \`jacobian\` mede a compressão da superfície: perto de zero a onda está
 *   dobrando sobre si mesma, que é onde nasce a espuma de quebra.
 * - \`lostSlopeVariance\` é a variância de inclinação das ondas que o filtro
 *   removeu. Uma senoide de amplitude A e número de onda k tem variância de
 *   inclinação (kA)²/2; devolver esse número deixa o shader recuperar como
 *   rugosidade especular o relevo que a normal perdeu — sem isso, água distante
 *   viraria espelho liso e cintilaria a cada movimento da câmera.
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

/** Espelho literal de \`WaveField.sampleSurface\`. */
void gerstnerSurface(vec2 gridPos, out vec3 normal, out float jacobian) {
  float lost;
  gerstnerSurfaceFiltered(gridPos, 0.0, normal, jacobian, lost);
}
`;
