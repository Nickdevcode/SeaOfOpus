/**
 * A forma do casco da Chalupa, em números.
 *
 * Este módulo é a **fonte única** do formato do navio: a geometria visual
 * (`HullGeometry`), os pontos de amostragem do empuxo (`Buoyancy`), a colisão
 * da bala de canhão e o teste de "onde o jogador pode pisar" leem todos daqui.
 * Se as duas descrições divergissem, o navio flutuaria fora do próprio casco —
 * é o mesmo motivo de `WaveField` gerar o GLSL das ondas a partir do array que
 * a CPU usa.
 *
 * **Sistema de coordenadas local:** `-Z` é a proa, `+X` é boreste, `+Y` é para
 * cima, e a origem fica na **linha d'água de projeto**, no meio do comprimento.
 * O `-Z` para frente não é gosto: é o eixo que `Object3D.getWorldDirection`
 * devolve, então o rumo do navio sai de graça, sem matriz de correção.
 */

import * as THREE from 'three';
import { clamp, clamp01 } from '../core/MathUtils';

/** Comprimento total do casco, em metros (da roda de proa ao painel de popa). */
export const HULL_LENGTH = 16;
/** Boca máxima. */
export const HULL_BEAM = 5;
/** Meio comprimento — `t = 0` fica em `+HALF_LENGTH`, `t = 1` em `-HALF_LENGTH`. */
export const HALF_LENGTH = HULL_LENGTH / 2;

/** Altura do convés principal acima da linha d'água. */
export const DECK_Y = 1.3;
/** Altura do piso do porão. Dá ~1,8 m de pé-direito — apertado, como no jogo. */
export const HOLD_FLOOR_Y = -0.55;
/** Espessura do costado. Separa a face externa da interna da amurada. */
export const HULL_THICKNESS = 0.13;
/**
 * Espessura do convés e do tombadilho.
 *
 * O convés nasce como uma varredura de superfície única, ou seja, espessura
 * zero. Só que ele não é só chão: é o **teto do porão**, e teto de espessura
 * zero desaparece quando visto por baixo (a face olha para cima, o material é
 * `FrontSide`, e o resultado é enxergar o céu através do convés). Este número é
 * o que separa a face de cima da de baixo — e, de quebra, é ele que define o pé
 * direito real do porão, que o jogador não pode atravessar com a cabeça.
 */
export const DECK_THICKNESS = 0.09;

/** Altura do tombadilho de popa, onde fica o timão. */
export const QUARTERDECK_Y = 1.74;
/**
 * Até onde, em `t`, o tombadilho se estende a partir da popa.
 *
 * 0,20 dá 3,2 m de tombadilho, e o número saiu de medir o posto do timoneiro em
 * vez de escolher uma proporção. Com 0,17 sobravam 2,7 m para acomodar a roda,
 * a bitácula à frente dela e o homem atrás — e o homem era quem pagava: ficava
 * a 35 cm da amurada de popa, com a nuca no coroamento. Meio metro a mais de
 * convés é a diferença entre um posto e um degrau.
 */
export const QUARTERDECK_T = 0.2;

/**
 * Quanto a amurada se fecha para dentro acima do convés.
 *
 * Casco de verdade tem a boca máxima na linha d'água ou pouco acima, e daí para
 * cima ele "tomba" de volta. Sem esse recolhimento a seção continuaria abrindo
 * até o topo e o navio pareceria uma bacia.
 */
const TUMBLEHOME = 0.06;

/**
 * Posições notáveis ao longo do casco, em `t` (0 = popa, 1 = proa).
 * Ficam aqui, e não em quem constrói cada peça, porque mastro, escotilha e
 * canhões precisam concordar entre si — e com o porão embaixo deles.
 */
export const STATIONS = {
  // A roda avançou de 0,075 para 0,105 — 48 cm para vante — e o motivo é o
  // espaço às costas de quem governa. O timoneiro fica 85 cm a ré da roda, e com
  // a roda quase no coroamento sobrava meio passo entre ele e a amurada: dava
  // para governar, mas não para andar em volta do posto nem para recuar dele. Em
  // 0,105, e com o tombadilho mais comprido, sobra mais de um metro atrás.
  helm: 0.105,
  quarterdeckEdge: QUARTERDECK_T,
  // Recuada até quase o tombadilho por um motivo de circulação, não de estética:
  // com a escotilha em 0,4 sobrava menos de meio metro entre a borda do buraco e
  // o reparo do canhão, e quem descia o costado era empurrado pelo canhão para
  // dentro do vão e caía no porão. Em 0,31 sobra ~1 m de convés inteiro entre os
  // dois, que é o corredor que a Chalupa do Sea of Thieves também tem.
  hatch: 0.31,
  mast: 0.575,
  // As peças ficam a ré do mastro, e não abraçadas nele. Com o canhão em 0,5
  // sobravam 1,2 m entre o mastro e o reparo, e o corredor que restava na
  // diagonal — passar por dentro do canhão e por fora do mastro — tinha 33 cm:
  // dava para atravessar, mas raspando nos dois, um passo por segundo. Em 0,45 o
  // vão abre para quase 1 m, que é o convés livre da Chalupa do Sea of Thieves.
  cannon: 0.45,
  capstan: 0.75,
  stem: 1,
} as const;

/**
 * A pá do leme, em números — **fonte única**, igual ao casco.
 *
 * `createRudder` constrói a malha a partir daqui e `Rudder` tira daqui a área e
 * o centro de pressão. A primeira versão tinha os dois separados e eles
 * divergiram feio: a física dizia 1,5 m² enquanto a pá desenhada tinha 0,37 m²
 * submersos, quatro vezes menos. O navio esterçava com uma pá que ninguém via.
 *
 * `bottomY` para em −1,4 m de propósito: a quilha desce a −1,55 m na meia-nau, e
 * leme que passa da quilha é leme que toca o fundo antes do casco. É a mesma
 * regra que um estaleiro segue.
 */
export const RUDDER_BLADE = {
  /** Z local da madre — o eixo em que a pá gira, logo atrás do painel de popa. */
  postZ: HALF_LENGTH + 0.02,
  /** Folga entre a madre e o bordo de ataque da pá, para ela girar sem raspar. */
  leadingEdge: 0.05,
  /** Topo da pá, acima da linha d'água: é onde entra a cana. */
  topY: 0.7,
  /** Fundo da pá. Acima da quilha da meia-nau, ver acima. */
  bottomY: -1.4,
  /** Corda (comprimento proa-popa) no topo e no fundo da pá. */
  topChord: 0.62,
  bottomChord: 1.25,
  /**
   * Quanto o fundo da pá avança para vante em relação ao topo.
   *
   * É o caimento do cadaste. Sem ele a pá desceria reta atrás do painel, pendurada
   * na água aberta; com ele o pé da pá se enfia debaixo da popa, que é como um
   * veleiro de quilha corrida realmente é.
   */
  rake: 0.5,
  /** Espessura máxima do perfil. */
  thickness: 0.085,
} as const;

/**
 * Área e centro de pressão da parte submersa da pá, no calado de projeto.
 *
 * Integra o mesmo trapézio que a malha desenha, então os dois não têm como
 * discordar. Roda uma vez, na construção do `Rudder`.
 */
export function measureRudderBlade(): { area: number; centerY: number; centerZ: number } {
  const { topY, bottomY, topChord, bottomChord, postZ, leadingEdge, rake } = RUDDER_BLADE;
  const height = topY - bottomY;
  const steps = 128;
  let area = 0;
  let momentY = 0;
  let momentZ = 0;

  for (let i = 0; i < steps; i++) {
    // Só a faixa submersa: de `bottomY` até a linha d'água.
    const y = bottomY + (0 - bottomY) * ((i + 0.5) / steps);
    const s = (y - bottomY) / height;
    const chord = topChord * s + bottomChord * (1 - s);
    const slice = chord * ((0 - bottomY) / steps);

    area += slice;
    momentY += y * slice;
    // Centro da corda, já deslocado pelo caimento naquela altura.
    momentZ += (postZ + leadingEdge - rake * (1 - s) + chord * 0.5) * slice;
  }

  return { area, centerY: momentY / area, centerZ: momentZ / area };
}

/**
 * Área e centro da silhueta do casco **acima** da linha d'água, de través.
 *
 * É o que o vento pega quando sopra pelo lado: da linha d'água até o topo da
 * amurada, ao longo de todo o comprimento. `SailSim` usa isto para saber **onde**
 * aplicar o empuxo do vento sobre as obras mortas — e esse "onde" decide se o
 * navio cai a sotavento ou orça.
 *
 * A conta não é decorativa. O centro de esforço estava lançado no mastro, 2,11 m
 * à frente do centro de massa, e com esse braço o navio arribava sozinho ~0,1°/s
 * em qualquer amura: leme de sota permanente, que é justamente o que nenhum
 * projetista aceita num barco. O costado mede 37,7 m² com centro em z = −0,21 —
 * quase a meia-nau, porque são 16 m de comprimento contra os poucos metros
 * quadrados de mastro, e a tosadura ainda sobe nas duas pontas. Compondo com a
 * mastreação o centro fica em −0,35 e o braço cai para 1,26 m.
 */
export function measureWindageProfile(): { area: number; centerY: number; centerZ: number } {
  const section: HullSection = { halfBeam: 0, keelY: 0, sheerY: 0, fullness: 1 };
  const steps = 256;
  const dz = HULL_LENGTH / steps;
  let area = 0;
  let momentY = 0;
  let momentZ = 0;

  for (let i = 0; i < steps; i++) {
    const t = (i + 0.5) / steps;
    sampleSection(t, section);
    // Só o que está fora d'água: da linha d'água (y = 0) até a borda.
    const freeboard = Math.max(section.sheerY, 0);
    const slice = freeboard * dz;

    area += slice;
    momentY += freeboard * 0.5 * slice;
    momentZ += tToZ(t) * slice;
  }

  return { area, centerY: momentY / area, centerZ: momentZ / area };
}

/**
 * Meia largura da escotilha do porão, em metros.
 *
 * 1,16 m de vão. Era 1,5 m, e 1,5 m é largo demais: com 2,4 m de meio-convés na
 * meia-nau, o buraco comia mais de 60% da largura útil e o que sobrava de cada
 * lado era um corredor de meio metro entre a braçola e a amurada. Visto de pé no
 * convés, a Chalupa lia como uma jangada com um alçapão no meio.
 *
 * O número não é estético: 1,16 m é o vão que a escada precisa (1 m de largura
 * de degrau mais a folga dos montantes), e é o critério certo — a escotilha de um
 * navio é do tamanho do que desce por ela.
 */
export const HATCH_HALF_WIDTH = 0.58;
/** Meio comprimento da escotilha, em `t`. Dá 1,92 m, o vão da escada inteira. */
export const HATCH_HALF_T = 0.06;

// -- a escada do porão -------------------------------------------------------
//
// Não é escada de mão: é uma **escada inclinada**, do tipo que se desce andando,
// como a da Chalupa do Sea of Thieves. Isso muda mais coisa do que parece — não
// há o que agarrar, não há tecla para apertar e não há estado de "no lance". O
// jogador anda para o buraco, o pé encontra o degrau e ele desce. Subir é a
// mesma coisa ao contrário, e o degrau de 26 cm passa folgado no `STEP_HEIGHT`
// de meio metro que o controlador já usa para o tombadilho.
//
// A geometria inteira mora aqui porque três consumidores precisam concordar: a
// malha que desenha os degraus, o chão que o jogador pisa e o teto que **não**
// existe em cima dela.

/**
 * Meia largura do lance, em metros.
 *
 * É **exatamente** a da escotilha, e não um palmo menor. A diferença importa
 * porque o vão é buraco: qualquer faixa do alçapão que a escada não cubra é chão
 * que some, e quem descesse encostado num dos lados cairia 1,85 m ao lado dos
 * degraus. Ocupando o vão inteiro não sobra por onde cair.
 */
export const STAIR_HALF_WIDTH = HATCH_HALF_WIDTH;
/**
 * Z do topo do lance — a borda de ré do vão, sem folga nenhuma.
 *
 * Os 10 cm de recuo que havia aqui eram uma tira de convés inexistente entre a
 * braçola e o primeiro degrau: o pé pisava no nada e o jogador despencava no
 * porão em vez de descer a escada.
 */
export const STAIR_TOP_Z = tToZ(STATIONS.hatch - HATCH_HALF_T);
/**
 * Avanço horizontal do lance, em metros.
 *
 * 1,55 m para 1,85 m de queda dá 50° — íngreme para uma escada de casa e
 * exatamente o que um navio usa, onde o comprimento do convés vale mais que o
 * conforto do degrau. Com sete degraus saem 26 cm de espelho e 22 cm de piso.
 *
 * O que este número realmente decide é se a cabeça bate: o lance inteiro precisa
 * caber **dentro** da projeção do vão, senão quem desce enfia a cabeça no teto do
 * porão no meio do caminho. 1,55 m contra os 1,92 m do vão deixa 37 cm de sobra.
 */
export const STAIR_RUN = 1.55;
/** Z do pé do lance, no piso do porão. */
export const STAIR_BOTTOM_Z = STAIR_TOP_Z - STAIR_RUN;
/** Degraus do lance. */
export const STAIR_STEPS = 7;

/** `true` quando (x, z) cai no vão da escotilha. */
export function isOverHatch(x: number, z: number): boolean {
  return (
    Math.abs(x) <= HATCH_HALF_WIDTH &&
    Math.abs(zToT(z) - STATIONS.hatch) <= HATCH_HALF_T
  );
}

/**
 * Altura do degrau sob (x, z), ou `null` fora do lance.
 *
 * Degrau, e não plano inclinado: o piso é chato e o espelho é vertical, que é o
 * que faz descer soar como descer uma escada em vez de escorregar por uma rampa.
 */
export function stairSurfaceY(x: number, z: number): number | null {
  if (Math.abs(x) > STAIR_HALF_WIDTH) return null;
  if (z > STAIR_TOP_Z || z < STAIR_BOTTOM_Z) return null;

  // 0 no topo, 1 no pé.
  const k = (STAIR_TOP_Z - z) / STAIR_RUN;
  const step = Math.min(Math.floor(k * STAIR_STEPS), STAIR_STEPS - 1);
  return DECK_Y - ((DECK_Y - HOLD_FLOOR_Y) * (step + 1)) / STAIR_STEPS;
}

/**
 * Estações do casco: a tabela de formas que define o navio inteiro.
 *
 * Cada linha é uma seção transversal. `fullness` é o expoente da curva da
 * seção: abaixo de 1 ela fica cheia e arredondada (o bojo do meio-navio), acima
 * de 1 ela afina em V (a entrada fina da proa, que é o que corta a onda em vez
 * de bater nela).
 */
interface Station {
  /** Posição longitudinal normalizada: 0 na popa, 1 na proa. */
  t: number;
  /** Meia boca da seção, no topo da amurada. */
  halfBeam: number;
  /** Altura da quilha nesta seção — o arqueamento longitudinal do fundo. */
  keelY: number;
  /** Altura do topo da amurada. Subir nas pontas é a tosadura clássica. */
  sheerY: number;
  fullness: number;
}

const STATION_TABLE: readonly Station[] = [
  { t: 0.0, halfBeam: 1.36, keelY: -0.56, sheerY: 2.58, fullness: 0.62 },
  { t: 0.08, halfBeam: 1.86, keelY: -0.96, sheerY: 2.43, fullness: 0.6 },
  { t: 0.2, halfBeam: 2.28, keelY: -1.31, sheerY: 2.26, fullness: 0.58 },
  { t: 0.35, halfBeam: 2.47, keelY: -1.5, sheerY: 2.16, fullness: 0.58 },
  { t: 0.48, halfBeam: 2.5, keelY: -1.55, sheerY: 2.14, fullness: 0.6 },
  { t: 0.6, halfBeam: 2.42, keelY: -1.54, sheerY: 2.18, fullness: 0.67 },
  { t: 0.72, halfBeam: 2.13, keelY: -1.45, sheerY: 2.31, fullness: 0.82 },
  { t: 0.83, halfBeam: 1.66, keelY: -1.26, sheerY: 2.52, fullness: 1.08 },
  { t: 0.92, halfBeam: 1.04, keelY: -0.99, sheerY: 2.76, fullness: 1.5 },
  { t: 0.97, halfBeam: 0.52, keelY: -0.73, sheerY: 2.93, fullness: 1.95 },
  { t: 1.0, halfBeam: 0.15, keelY: -0.44, sheerY: 3.04, fullness: 2.3 },
];

/**
 * Catmull-Rom em um canal da tabela.
 *
 * Interpolação linear entre estações deixaria uma quina em cada seção, e num
 * casco isso aparece na hora: a luz especular varre a curva e denuncia cada
 * junta. Catmull-Rom passa exatamente pelos pontos de controle (então a tabela
 * continua sendo o que se ajusta na mão) e ainda dá tangente contínua.
 */
function catmullRom(p0: number, p1: number, p2: number, p3: number, s: number): number {
  const s2 = s * s;
  const s3 = s2 * s;
  return (
    0.5 *
    (2 * p1 + (p2 - p0) * s + (2 * p0 - 5 * p1 + 4 * p2 - p3) * s2 + (-p0 + 3 * p1 - 3 * p2 + p3) * s3)
  );
}

/** Uma seção transversal já interpolada. */
export interface HullSection {
  halfBeam: number;
  keelY: number;
  sheerY: number;
  fullness: number;
}

const sectionScratch: HullSection = { halfBeam: 0, keelY: 0, sheerY: 0, fullness: 1 };

/**
 * Interpola a tabela em `t`. Escreve em `out` quando ele é passado — quem chama
 * isso dentro do laço da física não pode alocar um objeto por ponto por quadro.
 */
export function sampleSection(t: number, out: HullSection = sectionScratch): HullSection {
  const clamped = clamp01(t);

  // Busca linear: são onze estações, e um binário aqui seria mais código do que
  // trabalho economizado.
  let i = 0;
  while (i < STATION_TABLE.length - 2 && STATION_TABLE[i + 1]!.t < clamped) i++;

  const p1 = STATION_TABLE[i]!;
  const p2 = STATION_TABLE[i + 1]!;
  // Nas pontas o vizinho que falta vira o próprio extremo: a curva termina com
  // tangente suave em vez de disparar para fora do casco.
  const p0 = STATION_TABLE[Math.max(i - 1, 0)]!;
  const p3 = STATION_TABLE[Math.min(i + 2, STATION_TABLE.length - 1)]!;

  const s = clamp01((clamped - p1.t) / (p2.t - p1.t));

  out.halfBeam = catmullRom(p0.halfBeam, p1.halfBeam, p2.halfBeam, p3.halfBeam, s);
  out.keelY = catmullRom(p0.keelY, p1.keelY, p2.keelY, p3.keelY, s);
  out.sheerY = catmullRom(p0.sheerY, p1.sheerY, p2.sheerY, p3.sheerY, s);
  out.fullness = catmullRom(p0.fullness, p1.fullness, p2.fullness, p3.fullness, s);
  return out;
}

/**
 * Meia largura do casco na seção `t`, no parâmetro de altura `v`.
 *
 * `v` percorre a seção de 0 (quilha) a 1 (topo da amurada), e a altura é linear
 * em `v` — é isso que torna o inverso (`halfWidthAtHeight`) uma conta fechada em
 * vez de uma busca, o que importa porque a flutuabilidade chama isso dezenas de
 * vezes por passo de física.
 */
export function sectionHalfWidth(section: HullSection, v: number): number {
  const clamped = clamp01(v);
  const base = section.halfBeam * Math.pow(Math.sin(clamped * Math.PI * 0.5), section.fullness);

  // O recolhimento só age acima do convés, onde a amurada realmente tomba.
  const vDeck = sectionV(section, DECK_Y);
  if (clamped <= vDeck) return base;

  const above = clamp01((clamped - vDeck) / Math.max(1 - vDeck, 1e-4));
  return base * (1 - TUMBLEHOME * above * above);
}

/** Parâmetro `v` correspondente a uma altura absoluta `y` nesta seção. */
export function sectionV(section: HullSection, y: number): number {
  return (y - section.keelY) / Math.max(section.sheerY - section.keelY, 1e-4);
}

/** Meia largura do casco em `t` na altura `y`. Zero abaixo da quilha. */
export function halfWidthAtHeight(t: number, y: number): number {
  const section = sampleSection(t, sectionScratch);
  if (y <= section.keelY || y >= section.sheerY) {
    return y >= section.sheerY ? sectionHalfWidth(section, 1) : 0;
  }
  return sectionHalfWidth(section, sectionV(section, y));
}

// -- a superfície do casco em 3D ---------------------------------------------
//
// O que vem abaixo é a mesma tabela de estações lida como **superfície**, e não
// como perfil. Mora aqui, e não em quem constrói a malha, porque três consumidores
// diferentes precisam do mesmo forro interno: a geometria visual, o piso do porão
// e o recorte que apaga o mar de dentro do casco no shader do oceano.

const surfaceScratch: HullSection = { halfBeam: 0, keelY: 0, sheerY: 0, fullness: 1 };

/** Ponto da superfície externa do casco. `side` é +1 boreste, −1 bombordo. */
export function hullSurfacePoint(
  t: number,
  v: number,
  side: number,
  out: THREE.Vector3,
): THREE.Vector3 {
  const section = sampleSection(t, surfaceScratch);
  return out.set(
    side * sectionHalfWidth(section, v),
    section.keelY + (section.sheerY - section.keelY) * v,
    tToZ(t),
  );
}

const tangentT = new THREE.Vector3();
const tangentV = new THREE.Vector3();
const surfaceA = new THREE.Vector3();
const surfaceB = new THREE.Vector3();

/**
 * Normal externa analítica, do produto vetorial das duas tangentes.
 *
 * Sai daqui e não de diferença de vértices porque a superfície interna precisa
 * ser deslocada **ao longo da normal** (é assim que se mede espessura de
 * chapeamento), e para isso a normal tem que existir antes da malha.
 */
export function hullSurfaceNormal(
  t: number,
  v: number,
  side: number,
  out: THREE.Vector3,
): THREE.Vector3 {
  const e = 2e-3;
  hullSurfacePoint(Math.min(t + e, 1), v, side, surfaceA);
  hullSurfacePoint(Math.max(t - e, 0), v, side, surfaceB);
  tangentT.subVectors(surfaceA, surfaceB);

  hullSurfacePoint(t, Math.min(v + e, 1), side, surfaceA);
  hullSurfacePoint(t, Math.max(v - e, 0), side, surfaceB);
  tangentV.subVectors(surfaceA, surfaceB);

  // `dt × dv` aponta para fora em boreste e para dentro em bombordo — multiplicar
  // por `side` acerta os dois de uma vez.
  out.crossVectors(tangentT, tangentV).multiplyScalar(side);
  const length = out.length();
  return length > 1e-9 ? out.divideScalar(length) : out.set(side, 0, 0);
}

const insetNormal = new THREE.Vector3();

/**
 * Ponto da superfície **interna** (o forro), a espessura do costado para dentro
 * ao longo da normal. Sempre em boreste — o casco é simétrico.
 */
export function innerSurfacePoint(t: number, v: number, out: THREE.Vector3): THREE.Vector3 {
  hullSurfacePoint(t, v, 1, out);
  hullSurfaceNormal(t, v, 1, insetNormal);
  return out.addScaledVector(insetNormal, -HULL_THICKNESS);
}

const innerScratch = new THREE.Vector3();

/**
 * Meia largura do forro interno na estação `t`, na altura `y`. Zero quando não
 * há forro naquela altura (acima da amurada ou abaixo do bojo).
 *
 * Por que bisseção e não conta fechada, como em `halfWidthAtHeight`: deslocar
 * pela normal **deixa de ser** um deslocamento horizontal assim que o casco se
 * inclina. No bojo, a 40° da vertical, a diferença entre as duas contas é de 3 cm
 * em X e 8 cm em Y — exatamente a fresta que aparecia entre o piso do porão e o
 * forro, com o mar visível através dela. A altura do ponto interno não é mais
 * linear em `v`, então o inverso vira busca.
 */
export function innerHalfWidthAt(t: number, y: number): number {
  if (y > innerSurfacePoint(t, 1, innerScratch).y) return 0;

  let low = 0;
  let high = 1;
  for (let i = 0; i < 20; i++) {
    const mid = (low + high) * 0.5;
    if (innerSurfacePoint(t, mid, innerScratch).y < y) low = mid;
    else high = mid;
  }

  return Math.max(innerSurfacePoint(t, (low + high) * 0.5, innerScratch).x, 0);
}

/** Converte `t` (0 popa, 1 proa) em Z local. */
export function tToZ(t: number): number {
  return HALF_LENGTH - t * HULL_LENGTH;
}

/** Inverso de `tToZ`, grampeado no casco. */
export function zToT(z: number): number {
  return clamp01((HALF_LENGTH - z) / HULL_LENGTH);
}

/**
 * Altura do piso onde o jogador anda, em `t`.
 * O degrau do tombadilho é intencionalmente abrupto: quem constrói a escada usa
 * exatamente essa descontinuidade para saber onde colocá-la.
 */
export function walkableY(t: number): number {
  return t <= QUARTERDECK_T ? QUARTERDECK_Y : DECK_Y;
}

/**
 * Abaulamento do convés: alguns centímetros de corcova no meio para a água
 * escorrer para as bordas. É pouco, mas é o que impede o convés de ler como uma
 * placa plana debaixo da luz rasante.
 */
export function deckCamber(x: number, halfWidth: number): number {
  const r = clamp(x / Math.max(halfWidth, 1e-3), -1, 1);
  return 0.085 * (1 - r * r);
}

/** Meia largura útil do convés em `t` (já descontado o costado). */
export function deckHalfWidth(t: number): number {
  return Math.max(halfWidthAtHeight(t, walkableY(t)) - HULL_THICKNESS, 0.05);
}

/**
 * Até onde a **borda desenhada** do convés vai — que não é a meia largura útil.
 *
 * `deckHalfWidth` recua a espessura do costado **na horizontal**, e é o número
 * certo para a física: é onde os pés param. Só que o forro é deslocado ao longo
 * da **normal**, e as duas contas divergem exatamente onde o casco deixa de ser
 * vertical. No meio-navio a diferença é de 3 mm e ninguém vê; nas duas pontas,
 * onde a normal aponta quase toda para vante, o deslocamento normal quase não
 * mexe em X — e o convés ficava até 13 cm mais estreito que o forro que deveria
 * encostar nele.
 *
 * Era essa a fresta que corria pelas quinas de proa e de popa, com o mar
 * aparecendo através da junta entre o convés e o costado. Desenhar até o forro e
 * deixar a borda morrer dentro da madeira resolve por construção: o excesso some
 * dentro de uma peça que já existe, e não há junta no fio para acertar.
 *
 * Roda só na construção da malha, então a bisseção de `innerHalfWidthAt` não
 * custa nada em tempo de jogo.
 */
export function deckEdgeHalfWidth(t: number): number {
  const inner = innerHalfWidthAt(t, walkableY(t));
  // Um fio a mais: junta encostada exatamente no fio ainda pisca com o Z-fight
  // da precisão do depth buffer a 200 m de distância.
  return Math.max(deckHalfWidth(t), inner + 0.01);
}

/**
 * Altura da face de baixo do convés — o teto do porão — em (x, t).
 *
 * Acompanha o degrau do tombadilho e a tosadura pelo mesmo caminho que o piso,
 * então a folga entre o chão e o teto é a mesma que a malha desenha.
 */
export function ceilingY(t: number, x: number): number {
  return walkableY(t) + deckCamber(x, deckHalfWidth(t)) - DECK_THICKNESS;
}

/**
 * Massa do navio carregado, em kg.
 *
 * Sai do volume deslocado na linha d'água de projeto: por Arquimedes, um navio
 * em equilíbrio desloca exatamente a própria massa em água. Calcular em vez de
 * chutar é o que garante que a Chalupa nasça boiando no calado desenhado, sem
 * ninguém ter que ajustar um número até parar de afundar.
 */
export function computeDisplacement(): { mass: number; volume: number } {
  const steps = 96;
  let volume = 0;

  for (let i = 0; i < steps; i++) {
    const t = (i + 0.5) / steps;
    const section = sampleSection(t, sectionScratch);
    if (section.keelY >= 0) continue;

    // Área da seção submersa, por trapézios em altura.
    const slices = 24;
    const vTop = sectionV(section, 0);
    let area = 0;
    for (let j = 0; j < slices; j++) {
      const v = (vTop * (j + 0.5)) / slices;
      area += sectionHalfWidth(section, v) * 2;
    }
    area *= ((0 - section.keelY) / slices) * (vTop > 0 ? 1 : 0);

    volume += area * (HULL_LENGTH / steps);
  }

  // 1025 kg/m³ é a densidade da água do mar; o casco desloca o próprio peso.
  return { mass: volume * 1025, volume };
}

/**
 * Pontos de amostragem do empuxo, distribuídos pelo casco.
 *
 * Não é uma grade regular: as colunas seguem a meia largura real de cada
 * estação, então proa afinada ganha pontos juntos e o bojo largo ganha pontos
 * espalhados. É o que faz o momento de emborcamento sair certo sem precisar de
 * centenas de amostras.
 *
 * O volume de cada ponto soma exatamente o deslocamento total, então o navio
 * boia no calado de projeto por construção.
 */
export function buildBuoyancyPoints(
  lengthSamples = 8,
  widthSamples = 3,
): { x: number; y: number; z: number; volume: number }[] {
  const points: { x: number; y: number; z: number; volume: number }[] = [];
  let totalArea = 0;

  for (let i = 0; i < lengthSamples; i++) {
    const t = (i + 0.5) / lengthSamples;
    const section = sampleSection(t, sectionScratch);
    // A quilha da estação é o piso da amostra; acima da linha d'água não há o
    // que amostrar, e o próprio integrador cuida da parte emersa.
    const bottom = Math.min(section.keelY, 0);
    const halfWidth = sectionHalfWidth(section, sectionV(section, bottom * 0.35));

    for (let j = 0; j < widthSamples; j++) {
      const u = (j + 0.5) / widthSamples;
      const x = (u * 2 - 1) * halfWidth;
      // Cada ponto senta na altura do casco naquele X, não numa altura fixa:
      // é isso que dá o braço de alavanca correto para o momento de banda.
      const v = solveVForHalfWidth(section, Math.abs(x));
      const y = section.keelY + (section.sheerY - section.keelY) * v;

      const area = halfWidth * 2 * (1 / widthSamples);
      totalArea += area;
      points.push({ x, y: Math.min(y, 0.2), z: tToZ(t), volume: area });
    }
  }

  // Normaliza os volumes para somar o deslocamento de projeto.
  const { volume } = computeDisplacement();
  for (const point of points) point.volume = (point.volume / totalArea) * volume;

  return points;
}

/**
 * Inverso de `sectionHalfWidth` por bisseção.
 *
 * Só roda na construção dos pontos de empuxo (uma vez, na inicialização), então
 * vinte iterações de bisseção são mais baratas em código e em risco do que
 * inverter a potência à mão com o recolhimento no meio.
 */
function solveVForHalfWidth(section: HullSection, halfWidth: number): number {
  let low = 0;
  let high = 1;
  for (let i = 0; i < 20; i++) {
    const mid = (low + high) * 0.5;
    if (sectionHalfWidth(section, mid) < halfWidth) low = mid;
    else high = mid;
  }
  return (low + high) * 0.5;
}
