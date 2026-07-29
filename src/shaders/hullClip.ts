/**
 * Recorte do mar por dentro do casco.
 *
 * O oceano é uma malha única que cobre o horizonte inteiro; ele não sabe que
 * existe um navio, e passa reto por dentro dele. De fora não se nota — o costado
 * escreve profundidade antes e tapa tudo. De dentro do porão, sim: a superfície
 * da água atravessa o forro na altura da linha d'água e o navio ganha um lago no
 * meio, com espuma e reflexo do céu.
 *
 * A solução é `discard` no fragmento do mar quando ele cai dentro do volume do
 * casco. O que torna isso barato é o formato do teste: em coordenadas locais do
 * navio, "estar dentro" é `|x| < meiaLargura(t, y)` — uma função de duas
 * variáveis, que cabe numa textura pequena calculada uma vez na CPU. O fragmento
 * paga uma multiplicação de matriz e uma amostragem por casco.
 *
 * **Por que textura e não uniform array.** A tentativa natural seria mandar a
 * tabela de estações como `uniform vec4 uStations[11]` e interpolar no shader.
 * Não passa: sob WebGL2 o three ainda compila `ShaderMaterial` como GLSL ES
 * 1.00, e ali o índice de um array de uniforms no fragment shader precisa ser
 * *constant-index-expression*. Índice vindo de conta com `t` é rejeitado pelo
 * ANGLE. A textura resolve isso e ainda troca o Catmull-Rom por uma leitura
 * bilinear que o hardware faz de graça.
 *
 * **Por que não `clippingPlanes` do three.** Planos de recorte descrevem um
 * volume convexo só; com dois navios seria preciso a *união* de dois volumes,
 * que `clipIntersection` não expressa. E uma caixa ajustada ao casco recortaria
 * um retângulo visível de mar em volta do navio.
 */

import * as THREE from 'three';
import { clamp01 } from '../core/MathUtils';
import { HALF_LENGTH, HULL_LENGTH, innerSurfacePoint } from '../ship/ShipDimensions';

/**
 * Quantos cascos o mar recorta ao mesmo tempo.
 *
 * O laço no shader é desenrolado por este número, então ele é o custo fixo por
 * fragmento de água — e dois é exatamente o que o duelo 1v1 pede. Subir isso sem
 * necessidade encarece o pixel mais caro da cena.
 */
export const HULL_CLIP_MAX = 2;

/** Colunas (ao longo de `t`) e linhas (ao longo de `y`) do perfil. */
const PROFILE_WIDTH = 128;
const PROFILE_HEIGHT = 96;

/**
 * Faixa de altura coberta pelo perfil, em coordenadas locais do navio.
 *
 * Vai da quilha mais funda (−1,55 m) ao topo da amurada mais alta (3,04 m, na
 * proa), com uma folga em cada ponta. Fora dessa faixa o teste nem amostra a
 * textura — é o descarte rápido que faz o custo médio deste recorte ser quase
 * nada, já que a esmagadora maioria dos pixels de mar está longe do navio.
 */
const PROFILE_Y_MIN = -1.6;
const PROFILE_Y_MAX = 3.2;
const PROFILE_Y_RANGE = PROFILE_Y_MAX - PROFILE_Y_MIN;

/**
 * Metros representados por um valor 1,0 na textura.
 *
 * A meia largura interna máxima é 2,31 m (meia-nau, logo abaixo da borda), então
 * 2,5 dá folga e deixa a quantização de 8 bits em ~1 cm.
 */
const PROFILE_SCALE = 2.5;

/**
 * Quanto o volume de recorte cresce para os lados, em metros.
 *
 * O erro tem que cair para o lado certo. Recortar de menos deixa uma tira de mar
 * de poucos centímetros colada no forro, **visível de dentro do porão** — que é
 * justamente o defeito que se está consertando. Recortar de mais empurra a borda
 * da água para dentro da madeira, onde ninguém vê: o costado tem 13 cm de
 * espessura (17 cm medidos na horizontal, no bojo). Cinco centímetros cobrem com
 * folga a quantização da textura e a interpolação entre linhas, e ainda ficam
 * bem longe da face externa.
 */
const CLIP_MARGIN = 0.05;

/** Amostras de `v` por coluna ao levantar o perfil. */
const COLUMN_SAMPLES = 64;

/**
 * Levanta o perfil interno do casco numa textura R8.
 *
 * Roda uma vez, na criação do oceano. A construção é **por coluna**, e não por
 * texel, por um motivo de tempo de carga: inverter a altura em `v` exige
 * bisseção, e uma bisseção por texel daria ~900 mil avaliações de seção (perto
 * de 90 ms de engasgo). Amostrando a superfície interna de baixo para cima uma
 * vez por coluna e interpolando as linhas entre as amostras, caem para ~40 mil.
 * A altura do ponto interno cresce monotonicamente com `v` — o costado tem 13 cm
 * contra os ~3,7 m de altura da seção —, então a marcha linear abaixo é válida.
 */
export function buildHullProfileTexture(): THREE.DataTexture {
  const data = new Uint8Array(PROFILE_WIDTH * PROFILE_HEIGHT);
  const heights = new Float64Array(COLUMN_SAMPLES + 1);
  const widths = new Float64Array(COLUMN_SAMPLES + 1);
  const point = new THREE.Vector3();

  for (let column = 0; column < PROFILE_WIDTH; column++) {
    const t = (column + 0.5) / PROFILE_WIDTH;

    for (let i = 0; i <= COLUMN_SAMPLES; i++) {
      innerSurfacePoint(t, i / COLUMN_SAMPLES, point);
      heights[i] = point.y;
      // Na proa afilada o recuo da espessura passa da linha de centro e o X sai
      // negativo: ali não há vão interno nenhum, e zero é a resposta certa.
      widths[i] = Math.max(point.x, 0);
    }

    let i = 0;
    for (let row = 0; row < PROFILE_HEIGHT; row++) {
      const y = PROFILE_Y_MIN + ((row + 0.5) / PROFILE_HEIGHT) * PROFILE_Y_RANGE;
      // Abaixo do fundo do forro não há vão: é o porão de baixo, madeira maciça
      // e cavername. Fica em zero, e o mar continua ali sem ninguém ver.
      if (y < heights[0]!) continue;

      while (i < COLUMN_SAMPLES - 1 && heights[i + 1]! < y) i++;

      let halfWidth: number;
      if (y >= heights[COLUMN_SAMPLES]!) {
        // Acima da borda o perfil **segura** o último valor em vez de cair a
        // zero. Deixar cair criaria uma cunha de mar não recortado colada no topo
        // da amurada, na única altura em que a água chega a entrar pela borda.
        // Segurando, o volume termina numa aresta limpa em `PROFILE_Y_MAX`.
        halfWidth = widths[COLUMN_SAMPLES]!;
      } else {
        const span = heights[i + 1]! - heights[i]!;
        const s = span > 1e-6 ? (y - heights[i]!) / span : 0;
        halfWidth = widths[i]! + (widths[i + 1]! - widths[i]!) * s;
      }

      data[row * PROFILE_WIDTH + column] = Math.round(clamp01(halfWidth / PROFILE_SCALE) * 255);
    }
  }

  const texture = new THREE.DataTexture(
    data,
    PROFILE_WIDTH,
    PROFILE_HEIGHT,
    THREE.RedFormat,
    THREE.UnsignedByteType,
  );
  // Bilinear e sem mipmap: a amostragem acontece dentro de fluxo condicional, e
  // pedir nível de detalhe ali é comportamento indefinido em GLSL ES 1.00.
  texture.minFilter = THREE.LinearFilter;
  texture.magFilter = THREE.LinearFilter;
  texture.wrapS = THREE.ClampToEdgeWrapping;
  texture.wrapT = THREE.ClampToEdgeWrapping;
  texture.generateMipmaps = false;
  texture.needsUpdate = true;
  return texture;
}

let sharedProfile: THREE.DataTexture | null = null;

/**
 * O perfil, construído uma vez e emprestado a quem precisar.
 *
 * Dois consumidores leem a mesma tabela por motivos opostos: o mar apaga o que
 * cai **dentro** do casco, e a água do porão apaga o que cai **fora**. Levantar
 * o perfil duas vezes seria pagar duas vezes por bytes idênticos — e, pior,
 * abriria a chance de os dois divergirem.
 *
 * Ninguém descarta esta textura: ela vive enquanto a página viver, custa 12 KB e
 * é recriada de graça se um dia fizer falta.
 */
export function getHullProfileTexture(): THREE.DataTexture {
  sharedProfile ??= buildHullProfileTexture();
  return sharedProfile;
}

/** Constantes do perfil, para quem escrever outro shader sobre ele. */
export const HULL_PROFILE = {
  yMin: PROFILE_Y_MIN,
  yMax: PROFILE_Y_MAX,
  yRange: PROFILE_Y_RANGE,
  scale: PROFILE_SCALE,
  margin: CLIP_MARGIN,
} as const;

/**
 * Matriz para os espaços de casco não usados.
 *
 * Joga o mundo dez mil quilômetros acima do navio, bem para fora da caixa do
 * perfil. É o que dispensa um uniform de contagem: o laço roda sempre com
 * `HULL_CLIP_MAX` voltas, e as vagas vazias simplesmente nunca dão dentro —
 * sem `break`, sem `continue`, sem ramificação dependente de uniform.
 */
export const HULL_CLIP_ELSEWHERE = new THREE.Matrix4().makeTranslation(0, 1e7, 0);

/**
 * Declara os uniforms e a função `insideHull(vec3)`, em espaço de mundo.
 *
 * As constantes entram interpoladas do TypeScript de propósito: a caixa do
 * perfil e a escala têm que ser exatamente as mesmas com que a textura foi
 * escrita, e duplicá-las à mão no GLSL é o tipo de divergência que só aparece
 * como um centímetro de fresta seis meses depois.
 */
export const HULL_CLIP_GLSL = /* glsl */ `
#define HULL_CLIP_MAX ${HULL_CLIP_MAX}

uniform mat4 uHullClipInverse[HULL_CLIP_MAX];
uniform sampler2D uHullProfile;

/** Verdadeiro quando o ponto está dentro do forro de algum casco. */
bool insideHull(vec3 worldPosition) {
  bool inside = false;

  for (int i = 0; i < HULL_CLIP_MAX; i++) {
    vec3 local = (uHullClipInverse[i] * vec4(worldPosition, 1.0)).xyz;

    vec2 uv = vec2(
      (${HALF_LENGTH.toFixed(4)} - local.z) / ${HULL_LENGTH.toFixed(4)},
      (local.y - (${PROFILE_Y_MIN.toFixed(4)})) / ${PROFILE_Y_RANGE.toFixed(4)}
    );
    bool within = all(greaterThan(uv, vec2(0.0))) && all(lessThan(uv, vec2(1.0)));

    // A margem só entra onde existe vão: somada em cima de um perfil zero ela
    // abriria uma fresta de 10 cm de mar faltando ao longo da linha de centro,
    // acima da amurada e abaixo da quilha.
    float halfWidth = texture2D(uHullProfile, uv).r * ${PROFILE_SCALE.toFixed(4)};
    bool solid = within && halfWidth > 0.0 && abs(local.x) < halfWidth + ${CLIP_MARGIN.toFixed(4)};

    inside = inside || solid;
  }

  return inside;
}
`;
