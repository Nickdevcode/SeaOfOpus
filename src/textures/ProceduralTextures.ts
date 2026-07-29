/**
 * Texturas geradas em código: madeira, lona, cordame e ferro.
 *
 * Nada é baixado. Cada material sai de um canvas 2D desenhado na
 * inicialização, o que resolve três coisas de uma vez: zero peso no bundle,
 * zero licença de terceiros e ladrilho perfeito por construção (todo desenho
 * aqui envolve nas bordas de propósito).
 *
 * Cada material devolve três mapas no formato que o PBR do three espera:
 * - `map`     — cor base, em sRGB;
 * - `normalMap` — relevo, derivado de um mapa de altura por Sobel;
 * - `ormMap`  — oclusão em R, rugosidade em G, metalicidade em B (a convenção
 *   do glTF). Empacotar os três numa textura só corta duas amostragens por
 *   pixel, e o three lê exatamente esses canais quando o mesmo objeto é
 *   atribuído a `aoMap`, `roughnessMap` e `metalnessMap`.
 */

import * as THREE from 'three';
import { clamp01, createRandom, lerp, smoothstep } from '../core/MathUtils';

/** Resolução padrão. 512 é o ponto em que a fibra da madeira ainda se lê. */
const DEFAULT_SIZE = 512;

export interface MaterialMaps {
  map: THREE.CanvasTexture;
  normalMap: THREE.CanvasTexture;
  ormMap: THREE.CanvasTexture;
}

// --- ruído -------------------------------------------------------------------

/**
 * Ruído de valor **periódico**.
 *
 * O `period` é o que garante o ladrilho: as células da grade dão a volta em vez
 * de continuar para o infinito, então o pixel da borda direita amostra a mesma
 * célula do pixel da borda esquerda. Sem isso toda textura repetida mostraria
 * uma costura vertical no casco.
 */
function createNoise(seed: number) {
  const random = createRandom(seed);
  const SIZE = 256;
  const values = new Float32Array(SIZE * SIZE);
  for (let i = 0; i < values.length; i++) values[i] = random();

  const at = (x: number, y: number, period: number): number => {
    const px = ((x % period) + period) % period;
    const py = ((y % period) + period) % period;
    return values[(py % SIZE) * SIZE + (px % SIZE)]!;
  };

  return function noise(x: number, y: number, period: number): number {
    const xi = Math.floor(x);
    const yi = Math.floor(y);
    const xf = x - xi;
    const yf = y - yi;

    // Curva de suavização de Perlin: derivada nula nas células, sem quadriculado.
    const u = xf * xf * xf * (xf * (xf * 6 - 15) + 10);
    const v = yf * yf * yf * (yf * (yf * 6 - 15) + 10);

    const a = at(xi, yi, period);
    const b = at(xi + 1, yi, period);
    const c = at(xi, yi + 1, period);
    const d = at(xi + 1, yi + 1, period);

    return lerp(lerp(a, b, u), lerp(c, d, u), v);
  };
}

/** Soma de oitavas do ruído periódico, mantendo a periodicidade. */
function fbm(
  noise: (x: number, y: number, period: number) => number,
  x: number,
  y: number,
  basePeriod: number,
  octaves: number,
  gain = 0.5,
): number {
  let sum = 0;
  let amplitude = 1;
  let total = 0;
  let frequency = 1;

  for (let i = 0; i < octaves; i++) {
    sum += noise(x * frequency, y * frequency, basePeriod * frequency) * amplitude;
    total += amplitude;
    amplitude *= gain;
    frequency *= 2;
  }
  return sum / total;
}

// --- infraestrutura de canvas ------------------------------------------------

function createContext(size: number): CanvasRenderingContext2D {
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('Canvas 2D indisponível — as texturas do navio dependem dele.');
  return ctx;
}

function toTexture(
  ctx: CanvasRenderingContext2D,
  colorSpace: THREE.ColorSpace,
  repeat: THREE.Vector2,
): THREE.CanvasTexture {
  const texture = new THREE.CanvasTexture(ctx.canvas);
  texture.colorSpace = colorSpace;
  texture.wrapS = THREE.RepeatWrapping;
  texture.wrapT = THREE.RepeatWrapping;
  texture.repeat.copy(repeat);
  // 8x é o teto da maioria das GPUs; o driver corta sozinho se pedir demais, e
  // sem isso o convés visto de raspão vira uma poça cinza.
  texture.anisotropy = 8;
  texture.needsUpdate = true;
  return texture;
}

/**
 * Converte altura em normal por diferença central (Sobel simplificado).
 *
 * Gerar o normal a partir da mesma altura que desenhou a cor é o que mantém
 * junta de tábua, prego e nó exatamente no mesmo lugar nos dois mapas — se cada
 * um fosse desenhado por conta, o relevo apareceria deslocado da cor e a
 * madeira pareceria decalque.
 */
function heightToNormal(height: Float32Array, size: number, strength: number): CanvasRenderingContext2D {
  const ctx = createContext(size);
  const image = ctx.createImageData(size, size);
  const data = image.data;

  const sample = (x: number, y: number): number => height[(((y % size) + size) % size) * size + (((x % size) + size) % size)]!;

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const dx = (sample(x + 1, y) - sample(x - 1, y)) * strength;
      const dy = (sample(x, y + 1) - sample(x, y - 1)) * strength;

      // A normal de um campo de altura é (-∂h/∂x, -∂h/∂y, 1), normalizada.
      const length = Math.hypot(dx, dy, 1);
      const index = (y * size + x) * 4;
      data[index] = ((-dx / length) * 0.5 + 0.5) * 255;
      data[index + 1] = ((-dy / length) * 0.5 + 0.5) * 255;
      data[index + 2] = (1 / length) * 0.5 * 255 + 127.5;
      data[index + 3] = 255;
    }
  }

  ctx.putImageData(image, 0, 0);
  return ctx;
}

/** Monta o ORM a partir de três campos escalares já em 0..1. */
function packOrm(
  size: number,
  occlusion: Float32Array,
  roughness: Float32Array,
  metalness: number | Float32Array,
): CanvasRenderingContext2D {
  const ctx = createContext(size);
  const image = ctx.createImageData(size, size);
  const data = image.data;

  for (let i = 0; i < size * size; i++) {
    data[i * 4] = clamp01(occlusion[i]!) * 255;
    data[i * 4 + 1] = clamp01(roughness[i]!) * 255;
    data[i * 4 + 2] = clamp01(typeof metalness === 'number' ? metalness : metalness[i]!) * 255;
    data[i * 4 + 3] = 255;
  }

  ctx.putImageData(image, 0, 0);
  return ctx;
}

// --- madeira -----------------------------------------------------------------

export interface WoodOptions {
  /** Cor média da tábua, em 0..1 linear-ish (é escrita direto no canvas sRGB). */
  base: [number, number, number];
  /** Cor do veio escuro. */
  grain: [number, number, number];
  /** Quantas tábuas cabem na altura da textura. */
  planks: number;
  /** Proporção largura/altura da tábua, para o comprimento aparente. */
  plankAspect: number;
  /** 0 = envernizada, 1 = castigada pelo sal. */
  wear: number;
  /** Desenha cabeças de prego nas pontas das tábuas. */
  nails: boolean;
  seed: number;
  size?: number;
  repeat?: [number, number];
}

/**
 * Tábuas de madeira: veio, juntas calafetadas, nós e desgaste.
 *
 * O veio é ruído **anisotrópico** — muito esticado no comprimento da tábua —
 * porque é assim que a fibra da árvore corta a peça. Só isso já separa "madeira"
 * de "mármore marrom", que é o que sai de um fbm isotrópico qualquer.
 */
export function createWoodMaps(options: WoodOptions): MaterialMaps {
  const size = options.size ?? DEFAULT_SIZE;
  const noise = createNoise(options.seed);
  const random = createRandom(options.seed ^ 0x9e37);

  const ctx = createContext(size);
  const image = ctx.createImageData(size, size);
  const data = image.data;

  const height = new Float32Array(size * size);
  const occlusion = new Float32Array(size * size);
  const roughness = new Float32Array(size * size);

  const plankRows = options.planks;
  const plankHeight = size / plankRows;

  // Tom e deslocamento próprios de cada tábua: madeira serrada nunca sai de uma
  // peça só, e fileiras idênticas denunciam a textura na hora.
  const plankTone: number[] = [];
  const plankShift: number[] = [];
  const plankSplit: number[] = [];
  for (let i = 0; i < plankRows; i++) {
    plankTone.push(0.82 + random() * 0.36);
    plankShift.push(random() * 100);
    // Onde a tábua "termina" e começa a próxima, no eixo longo.
    plankSplit.push(random());
  }

  // Nós da madeira, espalhados sem cair em cima das juntas.
  const knots: { x: number; y: number; r: number }[] = [];
  const knotCount = Math.round(plankRows * 0.8);
  for (let i = 0; i < knotCount; i++) {
    const row = Math.floor(random() * plankRows);
    knots.push({
      x: random() * size,
      y: (row + 0.3 + random() * 0.4) * plankHeight,
      r: 6 + random() * 10,
    });
  }

  for (let y = 0; y < size; y++) {
    const row = Math.floor(y / plankHeight) % plankRows;
    const withinPlank = (y % plankHeight) / plankHeight;

    for (let x = 0; x < size; x++) {
      const index = y * size + x;

      // --- veio: ruído esticado ao longo da tábua ---------------------------
      const grainX = (x / size) * 3 * options.plankAspect + plankShift[row]!;
      const grainY = (y / size) * plankRows * 5;
      const warp = fbm(noise, grainX * 0.6, grainY * 0.25, 24, 3) - 0.5;

      // As linhas de crescimento: uma onda apertada, empenada pelo próprio ruído.
      //
      // A amplitude do empeno é a diferença entre madeira e mármore. `|sin(π·g)|`
      // tem período 1 em `grainY`, então deslocar por `warp * 3.2` movia cada
      // ponto em até **1,6 anéis** — mais que o espaçamento entre eles. Anéis
      // vizinhos se cruzavam e o veio virava um redemoinho de pedra polida, bem
      // visível no timão e no mastro, que são as peças de anel mais espaçado
      // (`planks: 1`) e onde o efeito era mais grosseiro.
      //
      // Em ±0,27 de anel o veio ondula como madeira serrada de verdade: as
      // linhas seguem o comprimento da peça e só abrem em catedral perto dos nós,
      // que é justamente o que o termo `knot` já faz mais abaixo.
      const rings = Math.abs(Math.sin((grainY + warp * 0.55) * Math.PI));
      let grain = Math.pow(rings, 0.6);
      // O borrão de ruído por cima quebra a regularidade do seno. Em 0,35 ele
      // comia metade do veio e devolvia manchas; em 0,22 só tira o ar de listra.
      grain = lerp(grain, fbm(noise, grainX * 4, grainY * 1.2, 48, 3), 0.22);

      // --- junta entre tábuas ----------------------------------------------
      // A junta é escura e afundada; a borda logo ao lado é mais clara, porque é
      // a quina que o pé e a corda lixam primeiro.
      const edge = Math.min(withinPlank, 1 - withinPlank);
      const gap = 1 - smoothstep(0.0, 0.035, edge);
      const chamfer = smoothstep(0.035, 0.11, edge);

      // --- topo da tábua (a junta transversal) ------------------------------
      const along = (x / size + plankSplit[row]!) % 1;
      const buttEdge = Math.min(along, 1 - along);
      const butt = 1 - smoothstep(0.0, 0.006, buttEdge);

      // --- nós ---------------------------------------------------------------
      let knot = 0;
      for (const k of knots) {
        // Distância envolvendo em X, para o nó não ser cortado pela borda.
        let dx = Math.abs(x - k.x);
        if (dx > size * 0.5) dx = size - dx;
        const d = Math.hypot(dx, y - k.y);
        if (d < k.r * 2.4) {
          const ripple = Math.pow(clamp01(1 - d / (k.r * 2.4)), 1.6);
          knot = Math.max(knot, ripple * (0.55 + 0.45 * Math.sin(d * 1.5)));
        }
      }

      // --- desgaste e sujeira -------------------------------------------------
      const weather = fbm(noise, (x / size) * 5, (y / size) * 5, 40, 4);
      const wearMask = clamp01((weather - 0.42) * 2.2) * options.wear;

      // --- composição da cor --------------------------------------------------
      let mix = clamp01(grain * 0.75 + knot * 0.8);
      mix = clamp01(mix * plankTone[row]!);

      let r = lerp(options.base[0], options.grain[0], mix);
      let g = lerp(options.base[1], options.grain[1], mix);
      let b = lerp(options.base[2], options.grain[2], mix);

      // Desgaste esbranquiça e dessatura — é sal e sol, não sujeira.
      const grey = (r + g + b) / 3;
      r = lerp(r, lerp(grey, 0.72, 0.45), wearMask);
      g = lerp(g, lerp(grey, 0.72, 0.45), wearMask);
      b = lerp(b, lerp(grey, 0.7, 0.45), wearMask);

      // A quina lixada volta mais clara que o miolo da tábua.
      const brighten = (1 - chamfer) * 0.12 * (1 - gap);
      r += brighten;
      g += brighten;
      b += brighten;

      const darkness = Math.max(gap, butt);
      r *= 1 - darkness * 0.82;
      g *= 1 - darkness * 0.84;
      b *= 1 - darkness * 0.85;

      const pixel = index * 4;
      data[pixel] = clamp01(r) * 255;
      data[pixel + 1] = clamp01(g) * 255;
      data[pixel + 2] = clamp01(b) * 255;
      data[pixel + 3] = 255;

      // O veio quase não entra na altura: é detalhe fino demais, e relevo fino
      // vira cintilação especular assim que a peça se afasta da câmera. Quem
      // carrega o relevo aqui são as juntas, o chanfro e os pregos, que têm
      // milímetros de verdade. O veio se expressa na cor e na rugosidade.
      height[index] = 1 - darkness * 0.9 - knot * 0.12 + grain * 0.025 - (1 - chamfer) * 0.08;
      occlusion[index] = 1 - darkness * 0.75;
      // Madeira gasta é fosca; o veio duro brilha um pouco mais que o mole.
      //
      // A base subiu de 0,62 para 0,72 quando o mapa de ambiente entrou em cena:
      // com um céu inteiro para refletir, 0,62 dava ao carvalho alcatroado um
      // lustro de verniz novo — o timão parecia envernizado, não um cabo de
      // madeira que passa o dia na maresia. Carvalho intemperizado real fica
      // entre 0,75 e 0,95.
      roughness[index] = clamp01(0.72 + wearMask * 0.22 - grain * 0.06 + darkness * 0.12);
    }
  }

  ctx.putImageData(image, 0, 0);

  // Pregos: desenhados por cima da cor já pronta, e marcados na altura, para o
  // relevo do normal acompanhar a cabeça redonda.
  if (options.nails) {
    for (let row = 0; row < plankRows; row++) {
      for (let n = 0; n < 2; n++) {
        const cx = ((plankSplit[row]! + n * 0.5 + 0.03) % 1) * size;
        const cy = (row + 0.5) * plankHeight;
        const r = 2.6;

        ctx.beginPath();
        ctx.fillStyle = 'rgba(38, 32, 27, 0.9)';
        ctx.arc(cx, cy, r, 0, Math.PI * 2);
        ctx.fill();
        ctx.beginPath();
        ctx.fillStyle = 'rgba(120, 108, 92, 0.55)';
        ctx.arc(cx - 0.7, cy - 0.7, r * 0.55, 0, Math.PI * 2);
        ctx.fill();

        for (let dy = -4; dy <= 4; dy++) {
          for (let dx = -4; dx <= 4; dx++) {
            const d = Math.hypot(dx, dy);
            if (d > r + 1) continue;
            const px = (Math.round(cx) + dx + size) % size;
            const py = (Math.round(cy) + dy + size) % size;
            height[py * size + px] = 1.18 - d * 0.05;
          }
        }
      }
    }
  }

  const repeat = new THREE.Vector2(options.repeat?.[0] ?? 1, options.repeat?.[1] ?? 1);

  return {
    map: toTexture(ctx, THREE.SRGBColorSpace, repeat),
    normalMap: toTexture(heightToNormal(height, size, 24), THREE.NoColorSpace, repeat),
    ormMap: toTexture(packOrm(size, occlusion, roughness, 0), THREE.NoColorSpace, repeat),
  };
}

// --- lona da vela ------------------------------------------------------------

/**
 * Lona de vela: painéis costurados, faixas de rizo, trama e manchas de maré.
 *
 * O UV da vela vai de 0 a 1 nas duas direções, então **um pixel desta textura
 * cobre mais de um centímetro de pano**. Isso decide tudo o que vem abaixo: a
 * trama do tecido é fina demais para caber aqui, e desenhá-la fio a fio só
 * produz moiré (foi exatamente o que aconteceu — a vela virou tela de
 * mosquiteiro). Então a trama entra como microrrelevo de baixa amplitude, quase
 * invisível de perto e inofensiva de longe, e quem carrega a leitura de "pano"
 * são as costuras dos painéis, as faixas de rizo e as ondulações largas.
 */
export function createSailMaps(seed = 77, size = DEFAULT_SIZE): MaterialMaps {
  const noise = createNoise(seed);
  const ctx = createContext(size);
  const image = ctx.createImageData(size, size);
  const data = image.data;

  const height = new Float32Array(size * size);
  const occlusion = new Float32Array(size * size);
  const roughness = new Float32Array(size * size);

  /** Painéis verticais de lona. Nove numa vela de 7 m dá ~78 cm cada. */
  const panels = 9;
  /**
   * Altura de cada faixa de rizo, onde a vela é enrolada e amarrada. O
   * espaçamento é irregular de propósito: com as três igualmente distribuídas,
   * cruzadas com as costuras verticais, o pano lia como grade de janela.
   */
  const reefBands = [0.33, 0.61, 0.84];
  /**
   * Ciclos de trama na textura inteira.
   *
   * A trama entra na cor e na rugosidade, e **nunca no mapa de normais**. A
   * inclinação de um relevo cresce com a frequência, não com a amplitude: 34
   * ciclos em 512 px dão uma normal que vira de pixel para pixel, e nenhum mip
   * consegue tirar média disso. Na tela virava um quadriculado de pontos brancos
   * varrendo a vela conforme o navio jogava — specular aliasing de manual.
   * Detalhe abaixo do pixel é rugosidade, não geometria.
   */
  const threads = 34;

  /**
   * Tom de cada painel. Vela de verdade é costurada de tiras que saíram de
   * rolos diferentes, e nenhuma tem exatamente a mesma cor — é essa variação,
   * mais que a linha da costura, que faz a lona ler como costurada.
   */
  const panelTone = Array.from({ length: panels }, (_, i) => (noise(i, 3.5, panels) - 0.5) * 0.07);

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const index = y * size + x;
      const u = x / size;
      const v = y / size;

      // Trama: dois fios cruzados, um por cima do outro alternadamente.
      const warp = Math.sin(u * Math.PI * 2 * threads);
      const weft = Math.sin(v * Math.PI * 2 * threads);
      const weave = (warp * 0.5 + weft * 0.5) * 0.5 + 0.5;

      // Costura entre painéis: uma faixa estreita, mais grossa e mais escura.
      const panelIndex = Math.floor(u * panels) % panels;
      const panelPos = (u * panels) % 1;
      const seam = 1 - smoothstep(0.004, 0.03, Math.min(panelPos, 1 - panelPos));

      // Faixa de rizo: mesma ideia na horizontal, porém mais larga e mais suave.
      let band = 0;
      for (const position of reefBands) {
        band = Math.max(band, 1 - smoothstep(0.008, 0.036, Math.abs(v - position)));
      }

      // Manchas de maré e mofo, concentradas embaixo — a vela molha pela barra.
      const stain = fbm(noise, u * 4, v * 4, 32, 4);
      const wet = clamp01((stain - 0.45) * 2) * smoothstep(0.35, 1, v);

      // Tensão do tecido: ondulação larga que o normal transforma em relevo.
      // É ela que faz a lona parecer esticada em vez de impressa.
      const slack = fbm(noise, u * 3, v * 3, 24, 4);

      const base = 0.9 + panelTone[panelIndex]! - wet * 0.26 - (slack - 0.5) * 0.12;
      // Creme, não branco: lona crua puxa para o amarelo, e sob o céu azul do
      // meio-dia um branco neutro leria como cinza-azulado.
      const tint = [base, base * 0.945, base * 0.82];

      const shade = 1 - seam * 0.16 - band * 0.07 - (1 - weave) * 0.025;
      const pixel = index * 4;
      data[pixel] = clamp01(tint[0]! * shade) * 255;
      data[pixel + 1] = clamp01(tint[1]! * shade) * 255;
      data[pixel + 2] = clamp01(tint[2]! * shade) * 255;
      data[pixel + 3] = 255;

      height[index] = slack * 0.9 + band * 0.3 - seam * 0.55;
      occlusion[index] = 1 - seam * 0.3 - wet * 0.12;
      // O fio que não virou relevo vira rugosidade: é o mesmo detalhe, cobrado
      // no canal onde ele não alia.
      roughness[index] = clamp01(0.88 + wet * 0.08 - band * 0.06 + (1 - weave) * 0.03);
    }
  }

  ctx.putImageData(image, 0, 0);

  return {
    map: toTexture(ctx, THREE.SRGBColorSpace, new THREE.Vector2(1, 1)),
    normalMap: toTexture(heightToNormal(height, size, 7), THREE.NoColorSpace, new THREE.Vector2(1, 1)),
    ormMap: toTexture(packOrm(size, occlusion, roughness, 0), THREE.NoColorSpace, new THREE.Vector2(1, 1)),
  };
}

// --- cordame -----------------------------------------------------------------

/**
 * Corda: três pernas torcidas.
 *
 * A hélice sai de um único `fract` no eixo do comprimento somado ao ângulo em
 * volta — desenhar a torção em vez de ruidar a cor é o que faz uma corda de 2 cm
 * ainda parecer corda quando o jogador encosta o rosto nela.
 */
export function createRopeMaps(seed = 91, size = 256): MaterialMaps {
  const noise = createNoise(seed);
  const ctx = createContext(size);
  const image = ctx.createImageData(size, size);
  const data = image.data;

  const height = new Float32Array(size * size);
  const occlusion = new Float32Array(size * size);
  const roughness = new Float32Array(size * size);

  /** Voltas da hélice ao longo da textura. */
  const twists = 8;
  const strands = 3;

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const index = y * size + x;
      const u = x / size; // volta da corda
      const v = y / size; // comprimento

      const phase = (u * strands + v * twists) % 1;
      // Perfil da perna: cheia no meio, fundo no vale entre duas.
      const strand = Math.pow(Math.sin(phase * Math.PI), 0.55);

      const fibre = fbm(noise, u * 30, v * 8, 64, 3);
      const shade = 0.42 + strand * 0.5 + (fibre - 0.5) * 0.18;

      const pixel = index * 4;
      data[pixel] = clamp01(shade * 0.78) * 255;
      data[pixel + 1] = clamp01(shade * 0.66) * 255;
      data[pixel + 2] = clamp01(shade * 0.47) * 255;
      data[pixel + 3] = 255;

      height[index] = strand + (fibre - 0.5) * 0.25;
      occlusion[index] = 0.45 + strand * 0.55;
      roughness[index] = clamp01(0.9 - strand * 0.08);
    }
  }

  ctx.putImageData(image, 0, 0);

  return {
    map: toTexture(ctx, THREE.SRGBColorSpace, new THREE.Vector2(1, 1)),
    normalMap: toTexture(heightToNormal(height, size, 14), THREE.NoColorSpace, new THREE.Vector2(1, 1)),
    ormMap: toTexture(packOrm(size, occlusion, roughness, 0), THREE.NoColorSpace, new THREE.Vector2(1, 1)),
  };
}

// --- metal -------------------------------------------------------------------

export interface MetalOptions {
  base: [number, number, number];
  /** 0 = polido, 1 = corroído até o osso. */
  corrosion: number;
  metalness: number;
  /**
   * Rugosidade da superfície ainda limpa, antes da ferrugem entrar. Faz muita
   * diferença: ferro fundido de canhão é areia bruta (≈0.6) e devolve um brilho
   * largo e mole, enquanto o mesmo material em 0.3 lê como obsidiana polida.
   */
  roughness?: number;
  /**
   * Cor do óxido. O padrão é a ferrugem vermelho-terrosa do ferro.
   *
   * Latão não enferruja: ele forma **zinabre**, o verde-azulado de estátua
   * velha. Pintar o latão com ferrugem de ferro dá uma peça cor de lama que não
   * lê como liga de cobre nenhuma.
   */
  corrosionColor?: [number, number, number];
  seed: number;
  size?: number;
}

/**
 * Ferro forjado e latão: martelado, com corrosão nas reentrâncias.
 *
 * A ferrugem não é só uma cor por cima — ela também sobe a rugosidade e
 * **derruba a metalicidade** naquele ponto, porque óxido de ferro é dielétrico.
 * É o detalhe que faz a peça enferrujada parar de espelhar como metal.
 */
export function createMetalMaps(options: MetalOptions): MaterialMaps {
  const size = options.size ?? 256;
  const noise = createNoise(options.seed);
  const ctx = createContext(size);
  const image = ctx.createImageData(size, size);
  const data = image.data;

  const height = new Float32Array(size * size);
  const occlusion = new Float32Array(size * size);
  const roughness = new Float32Array(size * size);
  const metalness = new Float32Array(size * size);

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const index = y * size + x;
      const u = x / size;
      const v = y / size;

      // Marcas de martelo: células largas e suaves.
      const hammer = fbm(noise, u * 8, v * 8, 32, 2);
      // Picotes da corrosão: alta frequência, com corte para virar cratera.
      const pit = fbm(noise, u * 26, v * 26, 96, 3);
      const rust = clamp01((pit - 0.52) * 3) * options.corrosion;

      const shade = 0.78 + (hammer - 0.5) * 0.35;
      const rustColor = options.corrosionColor ?? [0.36, 0.17, 0.07];

      const pixel = index * 4;
      data[pixel] = clamp01(lerp(options.base[0] * shade, rustColor[0]!, rust)) * 255;
      data[pixel + 1] = clamp01(lerp(options.base[1] * shade, rustColor[1]!, rust)) * 255;
      data[pixel + 2] = clamp01(lerp(options.base[2] * shade, rustColor[2]!, rust)) * 255;
      data[pixel + 3] = 255;

      height[index] = hammer * 0.6 - rust * 0.5;
      occlusion[index] = 1 - rust * 0.35;
      roughness[index] = clamp01((options.roughness ?? 0.32) + rust * 0.35 + (hammer - 0.5) * 0.15);
      metalness[index] = options.metalness * (1 - rust * 0.85);
    }
  }

  ctx.putImageData(image, 0, 0);

  return {
    map: toTexture(ctx, THREE.SRGBColorSpace, new THREE.Vector2(1, 1)),
    normalMap: toTexture(heightToNormal(height, size, 12), THREE.NoColorSpace, new THREE.Vector2(1, 1)),
    ormMap: toTexture(packOrm(size, occlusion, roughness, metalness), THREE.NoColorSpace, new THREE.Vector2(1, 1)),
  };
}

// --- partículas ---------------------------------------------------------------

/**
 * Sprite de baforada: fumaça, respingo e espuma saem todos daqui.
 *
 * Diferente do resto do arquivo, **não** é um mapa PBR e **não** ladrilha — é um
 * sprite solto, então o ruído usado é aperiódico de propósito. O alfa carrega a
 * silhueta e o RGB carrega uma sombra interna já pronta, o que dá volume à
 * baforada sem nenhuma conta de iluminação: o material das partículas é
 * `ShaderMaterial` puro, sem luz.
 *
 * A silhueta é o disco deformado por fbm, e não um disco liso — é a diferença
 * entre "nuvem de pólvora" e "bola de algodão desfocada".
 */
export function createPuffTexture(seed = 13, size = 128): THREE.CanvasTexture {
  const noise = createNoise(seed);
  const ctx = createContext(size);
  const image = ctx.createImageData(size, size);
  const data = image.data;

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const u = (x + 0.5) / size - 0.5;
      const v = (y + 0.5) / size - 0.5;
      const radius = Math.hypot(u, v) * 2;

      const turbulence = fbm(noise, (u + 0.5) * 5, (v + 0.5) * 5, 64, 4);
      // O ruído entra deformando o *raio*, não multiplicando o alfa: assim a
      // borda fica recortada, em vez de a baforada inteira ficar salpicada.
      const shape = 1 - smoothstep(0.35, 1, radius + (turbulence - 0.5) * 0.55);

      // Sombra interna com o topo mais claro, como fumaça iluminada de cima.
      const shade = 0.55 + turbulence * 0.3 + (0.5 - v) * 0.3;

      const index = (y * size + x) * 4;
      data[index] = clamp01(shade) * 255;
      data[index + 1] = clamp01(shade) * 255;
      data[index + 2] = clamp01(shade) * 255;
      data[index + 3] = clamp01(shape) * 255;
    }
  }

  ctx.putImageData(image, 0, 0);

  const texture = new THREE.CanvasTexture(ctx.canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  // Borda transparente e sem repetição: `ClampToEdge` evita a costura que o
  // filtro bilinear criaria ao amostrar de um lado para o outro do sprite.
  texture.wrapS = THREE.ClampToEdgeWrapping;
  texture.wrapT = THREE.ClampToEdgeWrapping;
  texture.needsUpdate = true;
  return texture;
}

/** Libera as três texturas de um conjunto. */
export function disposeMaps(maps: MaterialMaps): void {
  maps.map.dispose();
  maps.normalMap.dispose();
  maps.ormMap.dispose();
}
