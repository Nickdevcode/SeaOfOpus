/**
 * O mar: malha radial centrada na câmera + material completo da água.
 *
 * **A malha.** Anéis concêntricos com raios em progressão geométrica. Essa é a
 * distribuição que faz todo triângulo ocupar aproximadamente o mesmo tamanho
 * na tela: perto da proa eles têm centímetros, a 3 km têm dezenas de metros, e
 * o horizonte inteiro é coberto com ~120 mil triângulos em vez dos milhões que
 * uma grade uniforme exigiria. A malha inteira é transladada para o XZ da
 * câmera a cada frame; como o deslocamento é calculado a partir da coordenada
 * de mundo, o padrão de ondas fica travado no mundo e não escorrega junto.
 *
 * **A superfície.** O deslocamento vem do `WaveField` (mesma função que a
 * flutuabilidade usa na CPU), mas a normal e o jacobiano são recalculados **por
 * pixel**, não interpolados dos vértices. Custa uns 200 ALU por fragmento e
 * paga com juros: a onda tem relevo correto até onde a malha já é grossa.
 *
 * **A cor.** Nada de cubemap pré-cozido — o reflexo lê a mesma LUT atmosférica
 * que o céu desenha. É por isso que o mar acompanha o poente de verdade, e é
 * também o que faz o horizonte fechar sem costura: a névoa de distância mistura
 * o pixel do mar com a cor do céu naquela exata direção.
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
 * Paleta do Sea of Thieves: azul-petróleo no fundo, esmeralda na crista.
 *
 * Exportadas porque o `SkyEnvironment` precisa pintar a metade de baixo do
 * ambiente de reflexo com a mesma água que o mar desenha — se as duas cores
 * divergirem, o metal do convés vai refletir um oceano de outra cor.
 */
export const OCEAN_DEEP_COLOR = new THREE.Color(0.012, 0.062, 0.098);
export const OCEAN_SHALLOW_COLOR = new THREE.Color(0.045, 0.2, 0.215);

/** Onde a malha começa. Abaixo disso há um leque central, escondido pelo casco. */
const INNER_RADIUS = 1.5;
/** Alcance da água. Fica dentro do domo do céu (9000). */
const OUTER_RADIUS = 8000;

interface RadialMesh {
  geometry: THREE.BufferGeometry;
  /**
   * Espaçamento entre vértices dividido pelo raio — constante em toda a malha,
   * por construção. O vertex shader multiplica pelo raio local para saber, em
   * metros, o quanto ele consegue resolver ali, e filtra as ondas por isso.
   */
  spacingFactor: number;
}

/**
 * Constrói a malha radial em coordenadas locais (XZ, y = 0).
 *
 * Layout: vértice 0 no centro, depois `rings + 1` círculos de `segments`
 * vértices. Os anéis crescem por um fator constante — daí o tamanho aparente
 * uniforme dos triângulos.
 */
function buildRadialGeometry(rings: number, segments: number): RadialMesh {
  const ringCount = rings + 1;
  const vertexCount = 1 + ringCount * segments;

  const positions = new Float32Array(vertexCount * 3);
  const growth = Math.pow(OUTER_RADIUS / INNER_RADIUS, 1 / rings);

  let offset = 3; // o vértice central já é (0, 0, 0)
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
  // Passa de 65 535 vértices com folga, então índice de 32 bits é obrigatório.
  const indices = new Uint32Array(triangleCount * 3);
  let index = 0;

  // Leque central.
  for (let segment = 0; segment < segments; segment++) {
    const next = (segment + 1) % segments;
    indices[index++] = 0;
    indices[index++] = 1 + next;
    indices[index++] = 1 + segment;
  }

  // Faixas entre anéis consecutivos.
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
  // A malha segue a câmera e sempre a envolve: culling por frustum não faz
  // sentido, e a bounding sphere só existe para o three não tentar calculá-la.
  geometry.boundingSphere = new THREE.Sphere(new THREE.Vector3(), OUTER_RADIUS * 1.05);

  // O maior dos dois passos manda no que a malha consegue representar: o radial
  // (`raio × (growth − 1)`) ou o angular (`raio × 2π/segments`).
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
  // A posição da grade (antes do deslocamento) é o que alimenta Gerstner —
  // é ela, e não a posição final, que precisa bater com a CPU.
  vec3 base = (modelMatrix * vec4(position, 1.0)).xyz;
  vGridPosition = base.xz;

  // O raio é local de propósito: a malha acompanha a câmera, então o raio na
  // geometria *é* a distância horizontal até ela, e o espaçamento entre
  // vértices ali é proporcional a ele.
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
// (centroX, centroZ, tamanho, intensidade) — a esteira do casco entra por aqui.
uniform vec4 uWakeArea;

varying vec3 vWorldPosition;
varying vec2 vGridPosition;
varying float vVertexSpacing;
varying float vViewDistance;

/**
 * Rugosidade da água mesmo onde toda a onda é geometria explícita. Não é zero
 * porque nenhuma superfície real é espelho perfeito — e um α pequeno demais faz
 * o realce do sol virar um ponto de um pixel que pisca a cada frame.
 */
const float BASE_ALPHA = 0.05;

/** Distribuição de microfacetas GGX, onde alpha é a rugosidade ao quadrado. */
float ggxDistribution(float nDotH, float alpha) {
  float a2 = alpha * alpha;
  float d = nDotH * nDotH * (a2 - 1.0) + 1.0;
  return a2 / max(PI * d * d, 1e-7);
}

/**
 * Visibilidade de Smith correlacionada em altura (Heitz 2014), já com o
 * denominador \`1/(4·nDotV·nDotL)\` do Cook-Torrance dobrado dentro.
 *
 * Devolvê-la junta, e não como G separado, evita a razão \`G/(4·nDotV)\` que
 * explode quando o raio de visão fica rasante: a forma correlacionada é finita
 * por construção, então o realce não precisa de nenhum \`min\` para não estourar.
 */
float smithVisibility(float nDotV, float nDotL, float alpha) {
  float a2 = alpha * alpha;
  float lambdaV = nDotL * sqrt(nDotV * nDotV * (1.0 - a2) + a2);
  float lambdaL = nDotV * sqrt(nDotL * nDotL * (1.0 - a2) + a2);
  return 0.5 / max(lambdaV + lambdaL, 1e-5);
}

/**
 * Sombreamento das ondas grandes umas sobre as outras, em ângulo rasante.
 *
 * O termo de Smith acima só enxerga microfacetas dentro de um plano médio
 * horizontal — para ele o mar distante é um espelho perfeitamente plano, e um
 * espelho visto de raspão devolve luz à vontade. O mar de verdade não faz isso:
 * a partir de uns poucos graus acima do horizonte, a onda da frente esconde a
 * de trás, e a fração de superfície que ainda alcança o olho cai rápido.
 *
 * Sem isso o especular do sol (e principalmente o da lua, contra um céu escuro)
 * pinta uma faixa clara uniforme colada no horizonte, em todos os azimutes — o
 * artefato clássico de BRDF de água sem shadowing. É a mesma função Λ de Smith,
 * agora aplicada à distribuição de inclinação das ondas em vez das microfacetas.
 */
float waveShadowing(float nDotV, float alpha) {
  // σ da inclinação a partir de α: para GGX/Beckmann, α = σ·√2.
  float sigma2 = alpha * alpha * 0.5;
  float cos2 = max(nDotV * nDotV, 1e-6);
  float tan2 = (1.0 - cos2) / cos2;
  return 1.0 / (1.0 + 0.5 * (sqrt(1.0 + sigma2 * tan2) - 1.0));
}

/** Fresnel de Schlick com o F0 da água (índice de refração 1.33). */
float waterFresnel(float cosTheta) {
  return 0.02 + 0.98 * pow(1.0 - clamp(cosTheta, 0.0, 1.0), 5.0);
}

/** Passo da diferença finita, em espaço de ruído, usado por rippleOctave. */
const float RIPPLE_DELTA = 0.35;

/**
 * Uma oitava de marulho: inclinação por diferença finita, com corte próprio.
 *
 * O corte é o mesmo critério de Nyquist das ondas de Gerstner — o inverso da
 * escala é o período em metros — e o que a oitava deixa de representar volta
 * como variância de inclinação, para virar rugosidade especular em vez de
 * simplesmente sumir.
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
 * Marulho que a malha nunca vai resolver — das ondinhas de poucos metros até
 * as rugas de centímetros que o vento levanta em cima da onda.
 *
 * As três oitavas cobrem justamente a faixa entre a onda de Gerstner mais
 * curta (~15 m) e o pixel: sem elas a água fica lisa como plástico de perto,
 * que é onde mais se olha para ela.
 */
vec2 rippleSlope(vec2 gridPos, float footprint, out float lostVariance) {
  vec2 drift = uWindDirection * uTime;
  lostVariance = 0.0;

  vec2 slope = rippleOctave(gridPos, drift * 0.30, 0.12, 0.075, footprint, lostVariance);
  slope += rippleOctave(gridPos, drift * 0.45, 0.42, 0.105, footprint, lostVariance);
  slope += rippleOctave(gridPos, drift * -0.60, 1.35, 0.075, footprint, lostVariance);
  return slope;
}

/** Espuma de esteira, lida do render target que o casco desenha. */
float sampleWake(vec2 gridPos) {
  if (uWakeArea.w <= 0.0) return 0.0;

  vec2 uv = (gridPos - uWakeArea.xy) / uWakeArea.z + 0.5;
  if (any(lessThan(uv, vec2(0.0))) || any(greaterThan(uv, vec2(1.0)))) return 0.0;

  return texture2D(uWakeMap, uv).r * uWakeArea.w;
}

void main() {
  // Resolução de amostragem em metros: o pior caso entre o passo da malha e o
  // tamanho do pixel projetado no plano da água. É ele que decide quais ondas
  // ainda podem ser reconstruídas aqui — abaixo de Nyquist elas só fervem.
  //
  // Em ângulo rasante o pixel vira um retângulo comprido, e usar o lado maior
  // apagaria a superfície inteira do meio da tela para cima. Vale o mesmo
  // raciocínio da filtragem anisotrópica de textura: filtra-se pelo lado curto,
  // com uma razão máxima de 8:1 para o lado longo não escapar sem filtro nenhum.
  vec2 gradX = dFdx(vGridPosition);
  vec2 gradY = dFdy(vGridPosition);
  float shortAxis = min(length(gradX), length(gradY));
  float longAxis = max(length(gradX), length(gradY));
  float screenFootprint = max(shortAxis, longAxis * 0.125);
  float footprint = max(vVertexSpacing, screenFootprint);

  // Dentro do casco não há mar — sem isto a superfície atravessa o forro e o
  // porão amanhece com um lago dentro, espuma e reflexo do céu inclusos.
  //
  // O descarte vem **depois** das derivadas de propósito. \`discard\` encerra a
  // invocação, e derivada é calculada por quadrado de 2×2 pixels: descartar
  // antes deixaria o \`dFdx\` dos vizinhos sobrevivendo com valor indefinido, e o
  // sintoma seria uma orla de um ou dois pixels fervendo colada no costado —
  // exatamente onde mais se olha.
  if (insideHull(vWorldPosition)) discard;

  vec3 waveNormal;
  float jacobian;
  float lostSlopeVariance;
  gerstnerSurfaceFiltered(vGridPosition, footprint, waveNormal, jacobian, lostSlopeVariance);

  // O marulho é perturbação de normal por pixel, não geometria: quem limita
  // ele é só o tamanho do pixel, nunca o passo da malha. Cada oitava tem seu
  // próprio corte lá dentro e devolve aqui o que perdeu, para o realce do sol
  // engordar na mesma medida em vez de colapsar num ponto.
  float rippleLostVariance;
  vec2 slope = rippleSlope(vGridPosition, screenFootprint, rippleLostVariance);
  vec3 normal = normalize(waveNormal + vec3(-slope.x, 0.0, -slope.y));
  lostSlopeVariance += rippleLostVariance;

  vec3 viewVector = cameraPosition - vWorldPosition;
  vec3 V = normalize(viewVector);
  // Olhando de baixo d'água a normal aponta para longe: virar evita o preto.
  if (dot(normal, V) < 0.0) normal = -normal;

  // Luz ambiente = o próprio zênite da LUT. À noite ela apaga sozinha, sem
  // nenhuma curva pintada à mão.
  vec3 zenith = texture2D(uSkyLut, vec2(0.5, 0.02)).rgb;
  vec3 ambient = zenith * 2.1 + uMoonColor * (0.035 * uNightFactor);

  // --- corpo da água ------------------------------------------------------
  // Normalizado por 2σ: σ é o desvio padrão da elevação, então 2σ é a altura
  // que só as cristas de verdade alcançam (~5% da superfície).
  float crest = clamp(vWorldPosition.y / max(uWaveSigma * 2.0, 0.001), -1.5, 1.5);
  vec3 body = mix(uDeepColor, uShallowColor, clamp(crest * 0.5 + 0.5, 0.0, 1.0));
  body *= ambient;

  float nDotL = max(dot(normal, uSunDirection), 0.0);
  body += uDeepColor * uSunColor * uSunPower * nDotL * 0.06;

  // --- reflexo do céu -----------------------------------------------------
  vec3 reflection = reflect(-V, normal);

  // Nos flancos que descem para longe o raio refletido aponta para baixo do
  // horizonte: ali a água reflete a própria água, não o céu. Grampear o raio
  // no horizonte concentraria todos esses pixels na faixa creme da LUT e
  // desenharia bandas cor de areia ao longo das cristas. Espelhar de volta
  // para cima e misturar com o corpo da água aproxima a inter-reflexão com
  // uma leitura só de textura.
  float belowHorizon = smoothstep(0.0, -0.09, reflection.y);
  vec3 skyDirection = normalize(vec3(reflection.x, abs(reflection.y), reflection.z));
  vec3 skyColor = texture2D(uSkyLut, directionToEquirect(skyDirection)).rgb;
  skyColor = mix(skyColor, body * 0.75, belowHorizon);

  float nDotV = max(dot(normal, V), 1e-3);
  float fresnel = waterFresnel(nDotV);

  vec3 color = mix(body, skyColor, fresnel);

  // --- espalhamento subsuperficial ---------------------------------------
  // O verde translúcido que aparece quando a crista fica entre você e o sol.
  // Usa a normal da onda, sem o marulho: o que acende aqui é a luz atravessando
  // a lâmina fina de água da crista, uma propriedade da onda grande. Com a
  // normal marulhada o efeito virava pontinhos verdes espalhados por toda a
  // superfície, em vez do brilho na crista.
  vec3 scatterDirection = normalize(uSunDirection + waveNormal * 0.65);
  float scatter = pow(clamp(dot(V, -scatterDirection) * 0.5 + 0.5, 0.0, 1.0), 5.0);
  float scatterMask = clamp(crest, 0.0, 1.0) * clamp(1.0 - waveNormal.y, 0.0, 1.0) * 2.2;
  color += uSubsurfaceColor * uSunColor * uSunPower * scatter * scatterMask * 0.55;

  // --- brilho especular (Cook-Torrance) -----------------------------------
  // O α cresce com a variância de inclinação que o filtro descartou: é assim
  // que o realce pontual de perto vira o caminho largo e cintilante do sol lá
  // no fundo, em vez de um espelho liso que estroboscopia com a câmera.
  float alpha = clamp(sqrt(BASE_ALPHA * BASE_ALPHA + 2.0 * lostSlopeVariance), 0.02, 0.9);

  // Quanto do mar ainda escapa da onda da frente. Vale para os dois astros, e é
  // o que impede a faixa clara colada no horizonte sem apagar o caminho de luz.
  float shadowing = waveShadowing(nDotV, alpha);

  vec3 halfSun = normalize(uSunDirection + V);
  float sunSpecular = ggxDistribution(max(dot(normal, halfSun), 0.0), alpha)
                    * smithVisibility(nDotV, nDotL, alpha) * nDotL;
  color += uSunColor * uSunPower * sunSpecular * waterFresnel(dot(V, halfSun)) * shadowing;

  // O caminho da lua é o mesmo cálculo com a fonte trocada. O α um pouco maior
  // alarga a esteira prateada: o disco lunar é meio grau de céu, e a fonte
  // pontual sozinha devolveria uma linha fina demais para ler como reflexo.
  float moonFacing = max(dot(normal, uMoonDirection), 0.0);
  vec3 halfMoon = normalize(uMoonDirection + V);
  float moonAlpha = min(alpha * 1.5, 0.9);
  float moonSpecular = ggxDistribution(max(dot(normal, halfMoon), 0.0), moonAlpha)
                     * smithVisibility(nDotV, moonFacing, moonAlpha) * moonFacing;
  color += uMoonColor * moonSpecular * waterFresnel(dot(V, halfMoon))
         * waveShadowing(nDotV, moonAlpha) * uNightFactor * 0.5;

  // --- espuma -------------------------------------------------------------
  // O jacobiano mede o quanto a superfície se comprimiu; perto de zero a onda
  // está dobrando sobre si mesma, que é exatamente onde a espuma nasce. Os
  // limiares são calibrados na distribuição real do campo de ondas: com o vento
  // padrão o jacobiano fica quase todo entre 0.5 e 1.3, então só a cauda de
  // baixo — as cristas mesmo — chega a espumar.
  float breaking = smoothstep(uFoamThreshold, uFoamThreshold - 0.3, jacobian);
  float crestFoam = smoothstep(0.75, 1.15, crest) * 0.45;
  float grain = fbm(vec3(vGridPosition * 0.42, uTime * 0.22), 3, 2.25, 0.55) * 0.5 + 0.5;

  // O grão só modula espuma existente; onde a base é zero ele não inventa nada.
  float foam = max(breaking, crestFoam) * (0.45 + grain * 0.75);
  foam = clamp(foam + sampleWake(vGridPosition) * (0.55 + grain * 0.45), 0.0, 1.0);

  vec3 foamLit = uFoamColor * (ambient * 0.85 + uSunColor * uSunPower * nDotL * 0.16);
  color = mix(color, foamLit, foam);

  // --- névoa de distância -------------------------------------------------
  // Misturar com o céu *naquela direção* (e não com uma cor fixa) é o que faz
  // mar e horizonte se encontrarem sem linha visível.
  //
  // A direção é grampeada **acima** do horizonte antes de amostrar. Do olho para
  // um ponto do mar a três quilômetros o raio aponta para baixo, e abaixo do
  // horizonte a integral atmosférica da LUT vale zero — a névoa distante
  // misturava para preto e desenhava uma tarja escura de ponta a ponta da tela,
  // logo abaixo da linha do horizonte. Quanto mais fechada a névoa, mais larga
  // a tarja, e é por isso que ela só apareceu com a tempestade.
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
  /** Emprestado de `hullClip`; compartilhado com a água do porão. */
  private readonly hullProfile: THREE.DataTexture;
  /** Cascos que apagam o mar por dentro. No duelo são dois: o seu e o do bot. */
  private readonly hullClips: THREE.Object3D[] = [];
  private rings: number;
  private segments: number;

  constructor(waveField: WaveField, quality: QualitySettings) {
    this.waveField = waveField;
    this.rings = quality.oceanRings;
    this.segments = quality.oceanSegments;

    const mesh = buildRadialGeometry(this.rings, this.segments);

    // Textura 1×1 preta: mantém o sampler válido enquanto a esteira do casco
    // ainda não existe (WebGL não aceita sampler sem textura associada).
    this.emptyWake = new THREE.DataTexture(new Uint8Array([0, 0, 0, 255]), 1, 1);
    this.emptyWake.needsUpdate = true;

    this.hullProfile = getHullProfileTexture();

    this.material = new THREE.ShaderMaterial({
      vertexShader: VERTEX_SHADER,
      fragmentShader: FRAGMENT_SHADER,
      // Frente e verso: o jogador pode acabar debaixo d'água ao afundar.
      side: THREE.DoubleSide,
      fog: false,
      uniforms: {
        // Os Vector4 são os mesmos objetos que o WaveField mutaciona, então
        // mudar o vento na CPU chega ao shader sem nenhum passo intermediário.
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

        // Paleta do Sea of Thieves: azul-petróleo no fundo, esmeralda na crista.
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
    // Depois do navio (0) e antes do céu (1000). O casco fica sempre na frente,
    // então deixá-lo escrever profundidade primeiro poupa uma boa fatia do
    // fragment caro da água.
    this.mesh.renderOrder = 1;
  }

  /** Liga o reflexo à LUT do céu. Chamar uma vez, depois de criar o `Sky`. */
  setSkyLut(texture: THREE.Texture): void {
    this.material.uniforms.uSkyLut!.value = texture;
  }

  /**
   * Registra um casco para o mar ser apagado por dentro dele.
   *
   * `object` é a raiz do modelo do navio: o recorte lê a matriz de mundo dela a
   * cada frame, então basta registrar uma vez e o volume acompanha a pose.
   */
  addHullClip(object: THREE.Object3D): void {
    if (this.hullClips.length >= HULL_CLIP_MAX) {
      // Estourar isso em silêncio daria o defeito mais confuso possível: o
      // terceiro navio ficaria com um lago dentro do porão e mais nada errado.
      throw new Error(`Ocean: o recorte de casco comporta ${HULL_CLIP_MAX} navios.`);
    }
    this.hullClips.push(object);
  }

  /** Esquece todos os cascos — usado ao encerrar a partida. */
  clearHullClips(): void {
    this.hullClips.length = 0;
  }

  /**
   * Atualiza as matrizes mundo→navio do recorte.
   *
   * Força `updateWorldMatrix` em vez de confiar na que o render escreve: o
   * `Ship.syncModel` só escreve posição e quaternion, e a propagação para
   * `matrixWorld` acontece no início do render, *depois* daqui. Sem forçar, o
   * volume de recorte andaria um quadro atrasado — a 10 nós isso é meio metro de
   * fresta piscando na linha d'água.
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
   * Recentra a malha na câmera e avança o tempo das ondas.
   * O `WaveField.update` fica de fora de propósito: quem manda no relógio do
   * mar é a física, que roda em passo fixo.
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
   * Densidade da névoa de distância, vinda do tempo.
   *
   * Precisa acompanhar a névoa da cena: o mar e o navio desaparecem no horizonte
   * pela mesma fórmula, e se as duas densidades divergirem o casco some antes ou
   * depois da água que o cerca — uma silhueta escura flutuando sobre nada.
   */
  setFogDensity(density: number): void {
    this.material.uniforms.uFogDensity!.value = density;
  }

  /** Estado de iluminação, vindo do `DayNightCycle`. */
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
   * Conecta o render target da esteira.
   * `size` é a aresta em metros da área de mundo coberta pela textura.
   */
  setWake(texture: THREE.Texture, center: THREE.Vector3, size: number, strength: number): void {
    this.material.uniforms.uWakeMap!.value = texture;
    (this.material.uniforms.uWakeArea!.value as THREE.Vector4).set(center.x, center.z, size, strength);
  }

  /** Reconstrói a malha quando o preset gráfico muda. */
  applyQuality(quality: QualitySettings): void {
    if (quality.oceanRings === this.rings && quality.oceanSegments === this.segments) return;

    this.rings = quality.oceanRings;
    this.segments = quality.oceanSegments;

    const rebuilt = buildRadialGeometry(this.rings, this.segments);
    this.mesh.geometry.dispose();
    this.mesh.geometry = rebuilt.geometry;
    // A malha nova tem outro espaçamento, e o filtro de onda depende dele.
    this.material.uniforms.uSpacingFactor!.value = rebuilt.spacingFactor;
  }

  /** Triângulos na malha atual — usado pelo overlay de telemetria. */
  getTriangleCount(): number {
    return this.segments + this.rings * this.segments * 2;
  }

  dispose(): void {
    this.mesh.geometry.dispose();
    this.material.dispose();
    this.emptyWake.dispose();
  }
}
