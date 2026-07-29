/**
 * O casco da Chalupa, varrido a partir da tabela de estações.
 *
 * Nada aqui é modelado à mão: tudo sai de `ShipDimensions`, então mexer numa
 * linha da tabela muda ao mesmo tempo o desenho, a flutuabilidade e a colisão.
 * Era exatamente esse acoplamento que se queria — casco visual e casco físico
 * discordando é o bug mais caro de achar num jogo de barco.
 *
 * A saída vem separada por material, não por peça. Um `Mesh` por material dá
 * cinco chamadas de desenho para o navio inteiro; separar por peça daria
 * dezenas, e o navio inimigo dobraria a conta.
 */

import * as THREE from 'three';
import { GeometryBuilder, vertex, type Vertex } from './GeometryBuilder';
import {
  DECK_THICKNESS,
  DECK_Y,
  HALF_LENGTH,
  HATCH_HALF_T,
  HATCH_HALF_WIDTH,
  HOLD_FLOOR_Y,
  HULL_LENGTH,
  HULL_THICKNESS,
  QUARTERDECK_T,
  QUARTERDECK_Y,
  STATIONS,
  deckCamber,
  deckEdgeHalfWidth,
  deckHalfWidth,
  hullSurfaceNormal,
  hullSurfacePoint,
  innerHalfWidthAt,
  sampleSection,
  sectionHalfWidth,
  sectionV,
  tToZ,
  type HullSection,
} from './ShipDimensions';

/** Estações longitudinais da malha. 72 dá ~22 cm entre balizas — a curva fica lisa. */
const LENGTH_SEGMENTS = 72;
/** Divisões da quilha ao topo da amurada. */
const GIRTH_SEGMENTS = 22;

/** Comprimento de uma tábua do costado, em metros (um ladrilho da textura). */
const HULL_PLANK_TILE = 4;
/** Perímetro coberto por um ladrilho da textura do costado (10 tábuas de 28 cm). */
const HULL_GIRTH_TILE = 2.8;
/** Perímetro aproximado da meia-nau, da quilha à borda — só para escalar o UV. */
const MIDSHIP_GIRTH = 4.6;

/** Comprimento de uma tábua de convés e largura da faixa de 8 tábuas. */
const DECK_PLANK_TILE = 4.5;
const DECK_BAND_TILE = 1.76;

/** Alturas dos cintados: um logo abaixo do convés, outro no meio da amurada. */
const WALE_HEIGHTS = [1.02, 1.92];

/**
 * Faixa de `t` coberta pelo forro interno e pelo assoalho do porão.
 *
 * Os dois usam o mesmo intervalo de propósito: quando o piso parava antes do
 * forro sobravam buracos triangulares nas duas pontas do porão. Não vai até 0 e
 * 1 porque nos extremos a seção degenera num ponto e a normal fica indefinida.
 */
const SHELL_T_FROM = 0.006;
const SHELL_T_TO = 0.994;
/** Quanto o forro desce abaixo do assoalho, para a junta ficar coberta. */
const FLOOR_OVERLAP = 0.16;
/**
 * Quanto o teto do porão avança para fora do convés.
 *
 * O convés útil já é a meia largura *menos* a espessura do costado; o teto usa
 * a mesma fileira, então sem essa sobra a aresta dele ficaria pendurada no ar,
 * a um palmo do forro. Com ela, a borda morre enfiada na madeira do costado.
 */
const CEILING_OUTSET = 0.09;

const sectionScratchB: HullSection = { halfBeam: 0, keelY: 0, sheerY: 0, fullness: 1 };

const pointScratch = new THREE.Vector3();
const normalScratch = new THREE.Vector3();

/**
 * Ponto do casco deslocado `offset` metros ao longo da normal (negativo = para
 * dentro), já com o UV das tábuas.
 */
function hullVertex(t: number, v: number, side: number, offset: number): Vertex {
  hullSurfacePoint(t, v, side, pointScratch);
  if (offset !== 0) {
    hullSurfaceNormal(t, v, side, normalScratch);
    pointScratch.addScaledVector(normalScratch, offset);
  }
  return vertex(
    pointScratch.x,
    pointScratch.y,
    pointScratch.z,
    (t * HULL_LENGTH) / HULL_PLANK_TILE,
    (v * MIDSHIP_GIRTH) / HULL_GIRTH_TILE,
  );
}

export interface HullGeometrySet {
  /** Costado externo, painel de popa, quilha, roda de proa e cadaste. */
  hull: THREE.BufferGeometry;
  /** Forro interno da amurada e do porão, mais o piso e o teto do porão. */
  interior: THREE.BufferGeometry;
  /** Convés, tombadilho, degraus, capa da amurada, braçola e borda da escotilha. */
  deck: THREE.BufferGeometry;
  /** Cintados e a moldura do painel de popa. */
  trim: THREE.BufferGeometry;
}

/**
 * Constrói o casco inteiro. Roda uma vez por navio, na criação da partida.
 */
export function buildHullGeometry(): HullGeometrySet {
  const hull = new GeometryBuilder();
  const interior = new GeometryBuilder();
  const deck = new GeometryBuilder();
  const trim = new GeometryBuilder();

  buildShell(hull);
  buildTransom(hull, interior);
  buildInnerShell(interior);
  buildHoldFloor(interior);
  buildCapRail(deck);
  buildDeck(deck, interior);
  buildQuarterdeck(deck, interior);
  buildHatchCoaming(deck);
  buildHatchRim(deck);
  buildBackbone(hull);
  buildWales(trim);

  return {
    hull: hull.toGeometry(),
    interior: interior.toGeometry(),
    deck: deck.toGeometry(),
    trim: trim.toGeometry(),
  };
}

/**
 * O costado externo, uma metade de cada vez.
 *
 * Os dois lados não formam uma faixa fechada só: em `v = 0` as duas metades se
 * encontram em `x = 0`, e emitir uma faixa que passa por ali criaria uma fileira
 * inteira de triângulos de área zero. Separadas, a quilha vira só uma costura
 * entre duas superfícies — e o madeirame da quilha cobre a costura.
 */
function buildShell(builder: GeometryBuilder): void {
  for (const side of [1, -1]) {
    builder.addSurface(
      LENGTH_SEGMENTS,
      GIRTH_SEGMENTS,
      (s, v) => hullVertex(s, v, side, 0),
      side > 0,
    );
  }
}

/**
 * Painel de popa: a parede chata que fecha o casco atrás.
 *
 * Vem em duas folhas, uma virada para fora com a madeira escura do costado e
 * outra para dentro — a Chalupa tem a popa mais visível do jogo, e um painel de
 * face única mostraria o vazio por dentro toda vez que a câmera passasse pelo
 * timão.
 */
function buildTransom(outer: GeometryBuilder, inner: GeometryBuilder): void {
  const section = sampleSection(0, sectionScratchB);
  const height = section.sheerY - section.keelY;

  outer.addSurface(GIRTH_SEGMENTS, 16, (v, u) => {
    const halfWidth = sectionHalfWidth(section, v);
    const x = (u * 2 - 1) * halfWidth;
    return vertex(
      x,
      section.keelY + height * v,
      HALF_LENGTH,
      x / HULL_PLANK_TILE,
      (v * height) / HULL_GIRTH_TILE,
    );
  });

  // A face de dentro fica exatamente onde o forro lateral **começa**, e não a uma
  // espessura de costado do painel externo. Os dois números eram diferentes — o
  // forro nasce em `SHELL_T_FROM`, 9,6 cm à vante da popa, e o painel interno
  // ficava 3,4 cm atrás dele. A quina de popa do porão tinha um rasgo dessa
  // largura correndo de alto a baixo, com o mar aparecendo por ele.
  //
  // A largura sai de `innerHalfWidthAt`, a mesma função que descreve o forro,
  // pelo mesmo motivo: recuo horizontal e recuo ao longo da normal não são o
  // mesmo ponto, e no painel de popa — que é quase vertical mas tem o costado
  // fugindo para vante — a diferença chega a um palmo lá embaixo.
  const innerZ = tToZ(SHELL_T_FROM);
  // Objeto próprio: `sectionScratchB` é o rascunho compartilhado do módulo, e
  // guardar uma referência a ele aqui faria a próxima amostragem reescrever esta
  // seção por baixo.
  const innerSection: HullSection = { halfBeam: 0, keelY: 0, sheerY: 0, fullness: 1 };
  sampleSection(SHELL_T_FROM, innerSection);
  const innerHeight = innerSection.sheerY - innerSection.keelY;

  inner.addSurface(
    GIRTH_SEGMENTS,
    16,
    (v, u) => {
      const y = innerSection.keelY + innerHeight * v;
      const halfWidth = innerHalfWidthAt(SHELL_T_FROM, y);
      const x = (u * 2 - 1) * halfWidth;
      return vertex(x, y, innerZ, x / HULL_PLANK_TILE, (v * innerHeight) / HULL_GIRTH_TILE);
    },
    true,
  );
}

/**
 * Forro interno: a mesma superfície do costado, empurrada para dentro pela
 * espessura do chapeamento e com as normais viradas.
 *
 * Vai da altura do piso do porão até o topo da amurada numa tacada só, porque é
 * literalmente a mesma tábua — o convés é que corta esse forro em dois no meio,
 * separando o que se vê de pé no convés do que se vê descendo pela escotilha.
 */
function buildInnerShell(builder: GeometryBuilder): void {
  for (const side of [1, -1]) {
    builder.addSurface(
      LENGTH_SEGMENTS,
      GIRTH_SEGMENTS,
      (s, w) => {
        const t = SHELL_T_FROM + s * (SHELL_T_TO - SHELL_T_FROM);
        const section = sampleSection(t, sectionScratchB);
        // O piso do porão sobe acima da quilha no meio do navio e a alcança nas
        // pontas; abaixo dele não há forro para desenhar. Começar um palmo
        // *abaixo* dele é de propósito: o assoalho pousa por cima do forro, como
        // numa embarcação de verdade, e a junta some debaixo da tábua em vez de
        // depender de dois cálculos independentes baterem no milímetro.
        const vFloor = Math.max(sectionV(section, HOLD_FLOOR_Y - FLOOR_OVERLAP), 0);
        const v = vFloor + (1 - vFloor) * w;
        return hullVertex(t, v, side, -HULL_THICKNESS);
      },
      side < 0,
    );
  }
}

/**
 * Piso do porão: um assoalho plano, tão largo quanto o forro permitir.
 *
 * A borda sai de `innerHalfWidthAt`, a mesma função que descreve o forro, e não
 * de um recuo horizontal da meia largura externa. Não é preciosismo: no bojo o
 * costado corre a 40° da vertical, e ali "13 cm para dentro na horizontal" e
 * "13 cm ao longo da normal" são pontos diferentes — 3 cm em X, 8 cm em Y. A
 * versão antiga deixava exatamente essa fresta correndo pelos dois bordos, com o
 * mar aparecendo através dela.
 */
function buildHoldFloor(builder: GeometryBuilder): void {
  const rows = 48;

  let previousT = SHELL_T_FROM;
  for (let i = 1; i <= rows; i++) {
    const t = SHELL_T_FROM + (i / rows) * (SHELL_T_TO - SHELL_T_FROM);
    const hwA = innerHalfWidthAt(previousT, HOLD_FLOOR_Y);
    const hwB = innerHalfWidthAt(t, HOLD_FLOOR_Y);

    // Nas pontas o forro já se fechou abaixo do assoalho e não sobra piso; um
    // triângulo degenerado ali não faria mal, mas também não desenha nada.
    if (hwA > 1e-3 || hwB > 1e-3) {
      const columns = 6;
      const rowA: Vertex[] = [];
      const rowB: Vertex[] = [];
      for (let j = 0; j <= columns; j++) {
        const u = j / columns;
        const xa = (u * 2 - 1) * hwA;
        const xb = (u * 2 - 1) * hwB;
        rowA.push(
          vertex(xa, HOLD_FLOOR_Y, tToZ(previousT), tToZ(previousT) / DECK_PLANK_TILE, xa / DECK_BAND_TILE),
        );
        rowB.push(vertex(xb, HOLD_FLOOR_Y, tToZ(t), tToZ(t) / DECK_PLANK_TILE, xb / DECK_BAND_TILE));
      }
      builder.addStrip(rowA, rowB);
    }
    previousT = t;
  }
}

/**
 * Capa da amurada: a tira que fecha o topo, ligando a face externa à interna.
 *
 * É a peça que a câmera mais encosta o nariz — quem anda pelo convés passa o
 * tempo todo rente a ela — então ela ganha o carvalho claro do convés em vez do
 * alcatrão do costado, que é o que a Rare faz na Chalupa.
 */
function buildCapRail(builder: GeometryBuilder): void {
  // A capa **desce** um pouco pelas duas faces em vez de pousar em cima delas.
  //
  // A versão anterior era uma tira plana no topo exato da amurada, subida 12 mm
  // para não brigar em profundidade com o costado. Esses 12 mm eram uma fenda
  // aberta em toda a volta do navio, dos dois lados — e o convés é justamente
  // onde o jogador encosta o nariz na amurada. Descendo 2,5 cm por fora e por
  // dentro a peça abraça a quina, cobre a costura em vez de pairar sobre ela, e
  // ainda ganha a espessura que uma tábua de capa realmente tem.
  const drop = 0.025;

  for (const side of [1, -1]) {
    builder.addSurface(
      LENGTH_SEGMENTS,
      6,
      (s, w) => {
        const t = 0.004 + s * 0.992;
        // `w` atravessa a peça: 0 na saia externa, 0,5 no topo, 1 na saia interna.
        const across = Math.min(w, 1 - w) * 2;
        const point = hullVertex(t, 1, side, -w * HULL_THICKNESS);
        return vertex(
          point.x,
          // Sobe no meio e desce nas duas bordas: um perfil de tampo arredondado.
          point.y + 0.014 - drop * (1 - across),
          point.z,
          (t * HULL_LENGTH) / DECK_PLANK_TILE,
          (w * HULL_THICKNESS * side) / DECK_BAND_TILE,
        );
      },
      side > 0,
    );
  }

  // Painel de popa: sem esta tampa a amurada morre numa aresta de 13 cm de
  // madeira sem face, bem no enquadramento de quem está ao leme.
  const section = sampleSection(0, sectionScratchB);
  const top = section.sheerY;
  const outerHalf = sectionHalfWidth(section, 1);
  const innerHalf = Math.max(innerHalfWidthAt(SHELL_T_FROM, top - 0.02), outerHalf - HULL_THICKNESS);
  const zOuter = HALF_LENGTH;
  const zInner = tToZ(SHELL_T_FROM);

  const columns = 14;
  const outerRow: Vertex[] = [];
  const innerRow: Vertex[] = [];
  for (let i = 0; i <= columns; i++) {
    const u = (i / columns) * 2 - 1;
    outerRow.push(
      vertex(u * outerHalf, top - drop, zOuter, (u * outerHalf) / DECK_BAND_TILE, 0),
    );
    innerRow.push(
      vertex(u * innerHalf, top + 0.014, zInner, (u * innerHalf) / DECK_BAND_TILE, 0.4),
    );
  }
  builder.addStrip(outerRow, innerRow, true);
}

/**
 * Fileiras de estação do convés.
 *
 * As bordas da escotilha entram como estações explícitas para o recorte sair
 * retangular; sem isso o buraco nasceria com um serrilhado do tamanho do passo
 * da malha.
 */
function deckRows(from: number, to: number, count: number, extra: number[] = []): number[] {
  const rows: number[] = [];
  for (let i = 0; i <= count; i++) rows.push(from + ((to - from) * i) / count);
  for (const value of extra) {
    if (value > from && value < to) rows.push(value);
  }
  rows.sort((a, b) => a - b);
  return rows;
}

/** Extremos em X de um trecho de convés, cada um em função da meia largura da fileira. */
type Span = [(halfWidth: number) => number, (halfWidth: number) => number];

/**
 * Como emitir a faixa. Sem opções sai a face de cima, que é onde se anda; com
 * `CEILING` sai a mesma faixa virada para baixo, um pouco abaixo e um pouco mais
 * para fora — o teto do porão.
 */
interface BandOptions {
  /** Deslocamento vertical aplicado à faixa inteira. */
  offsetY?: number;
  /** Inverte a orientação das faces. */
  flip?: boolean;
  /** Alarga a fileira para fora (a borda da escotilha, que é fixa, não se mexe). */
  outset?: number;
}

const CEILING: BandOptions = { offsetY: -DECK_THICKNESS, flip: true, outset: CEILING_OUTSET };

function emitDeckBand(
  builder: GeometryBuilder,
  tA: number,
  tB: number,
  y: number,
  spans: Span[],
  options: BandOptions = {},
): void {
  const { offsetY = 0, flip = false, outset = 0 } = options;
  // A borda desenhada vai até o forro, e não até a meia largura útil — ver
  // `deckEdgeHalfWidth`. É o que fecha a fresta das quinas de proa e de popa.
  const hwA = deckEdgeHalfWidth(tA) + outset;
  const hwB = deckEdgeHalfWidth(tB) + outset;
  const zA = tToZ(tA);
  const zB = tToZ(tB);

  for (const [fromX, toX] of spans) {
    const x0a = fromX(hwA);
    const x1a = toX(hwA);
    const x0b = fromX(hwB);
    const x1b = toX(hwB);
    // Perto da proa o convés fica mais estreito que a escotilha; ali o trecho
    // lateral se inverte e a única coisa certa a fazer é não emitir nada.
    if (x1a - x0a < 0.02 || x1b - x0b < 0.02) continue;

    // O abaulamento é medido pela largura **útil**, e não pela desenhada: a
    // altura do chão tem de ser exatamente a que `deckCamber` devolve para a
    // física, senão o pé do jogador flutua um centímetro acima da tábua.
    const camberA = deckHalfWidth(tA);
    const camberB = deckHalfWidth(tB);

    const columns = Math.max(2, Math.round(Math.max(x1a - x0a, x1b - x0b) / 0.35));
    const rowA: Vertex[] = [];
    const rowB: Vertex[] = [];
    for (let j = 0; j <= columns; j++) {
      const u = j / columns;
      const xa = x0a + (x1a - x0a) * u;
      const xb = x0b + (x1b - x0b) * u;
      rowA.push(
        vertex(xa, y + offsetY + deckCamber(xa, camberA), zA, zA / DECK_PLANK_TILE, xa / DECK_BAND_TILE),
      );
      rowB.push(
        vertex(xb, y + offsetY + deckCamber(xb, camberB), zB, zB / DECK_PLANK_TILE, xb / DECK_BAND_TILE),
      );
    }
    builder.addStrip(rowA, rowB, flip);
  }
}

/**
 * Convés principal, da borda do tombadilho até a proa, com a escotilha vazada.
 *
 * Sai duas vezes: a face de cima no material do convés, a de baixo no do porão.
 * O convés é uma casca de espessura zero, e casca de espessura zero com material
 * `FrontSide` simplesmente **não existe** para quem olha de baixo — quem descia
 * ao porão via o céu e o cordame através do próprio convés em que acabara de
 * pisar. As duas faces vêm da mesma fileira de estações, então o teto acompanha
 * a tosadura e o abaulamento sem nenhuma chance de divergir.
 */
function buildDeck(builder: GeometryBuilder, ceiling: GeometryBuilder): void {
  const hatchFrom = STATIONS.hatch - HATCH_HALF_T;
  const hatchTo = STATIONS.hatch + HATCH_HALF_T;
  const rows = deckRows(QUARTERDECK_T, 0.995, 40, [hatchFrom, hatchTo]);

  const full: Span[] = [[(hw) => -hw, (hw) => hw]];
  const sides: Span[] = [
    [(hw) => -hw, () => -HATCH_HALF_WIDTH],
    [() => HATCH_HALF_WIDTH, (hw) => hw],
  ];

  for (let i = 0; i < rows.length - 1; i++) {
    const tA = rows[i]!;
    const tB = rows[i + 1]!;
    const middle = (tA + tB) * 0.5;
    const inHatch = middle > hatchFrom && middle < hatchTo;
    const spans = inHatch ? sides : full;
    emitDeckBand(builder, tA, tB, DECK_Y, spans);
    emitDeckBand(ceiling, tA, tB, DECK_Y, spans, CEILING);
  }
}

/**
 * Tombadilho de popa e o que sobe até ele.
 *
 * O degrau entre os dois conveses é o que faz o timão ficar acima da linha da
 * vela — sem ele o timoneiro navegaria olhando para o pano. As duas escadas
 * ficam junto às amuradas, deixando o meio livre para o mastro de mezena e para
 * quem corre da proa para a popa.
 */
function buildQuarterdeck(builder: GeometryBuilder, ceiling: GeometryBuilder): void {
  // Começa exatamente onde o forro interno de popa começa. Não é preciosismo de
  // meio centímetro: o piso parava em 0,004 e o painel de dentro em 0,006, e a
  // faixa entre os dois era um vão aberto para o mar bem debaixo do timoneiro.
  const rows = deckRows(SHELL_T_FROM, QUARTERDECK_T, 12);
  const full: Span[] = [[(hw) => -hw, (hw) => hw]];
  for (let i = 0; i < rows.length - 1; i++) {
    emitDeckBand(builder, rows[i]!, rows[i + 1]!, QUARTERDECK_Y, full);
    emitDeckBand(ceiling, rows[i]!, rows[i + 1]!, QUARTERDECK_Y, full, CEILING);
  }

  // A parede frontal do tombadilho, virada para a proa. Desce até *abaixo* do
  // teto do convés principal porque ela também fecha o degrau de 44 cm entre os
  // dois tetos — visto do porão, esse degrau era mais um rasgo para o céu.
  const hw = deckEdgeHalfWidth(QUARTERDECK_T);
  const camberHalf = deckHalfWidth(QUARTERDECK_T);
  const z = tToZ(QUARTERDECK_T);
  const columns = 12;
  const bottomY = DECK_Y - DECK_THICKNESS - 0.01;
  const bottom: Vertex[] = [];
  const top: Vertex[] = [];
  for (let j = 0; j <= columns; j++) {
    const x = (j / columns) * 2 * hw - hw;
    bottom.push(
      vertex(x, bottomY + deckCamber(x, camberHalf), z, x / DECK_BAND_TILE, bottomY / DECK_PLANK_TILE),
    );
    top.push(
      vertex(
        x,
        QUARTERDECK_Y + deckCamber(x, camberHalf),
        z,
        x / DECK_BAND_TILE,
        QUARTERDECK_Y / DECK_PLANK_TILE,
      ),
    );
  }
  builder.addStrip(bottom, top, true);

  // Duas escadas de dois degraus, uma por bordo. Cada degrau é um bloco maciço
  // que nasce no convés: assim o vão embaixo não fica aberto quando a câmera se
  // agacha, e o topo de cada bloco já é a superfície pisável.
  const steps = 2;
  const rise = (QUARTERDECK_Y - DECK_Y) / steps;
  const tread = 0.32;
  for (const side of [1, -1]) {
    const x = side * (camberHalf - 0.62);
    for (let step = 0; step < steps; step++) {
      const top = DECK_Y + rise * (step + 1);
      // O degrau mais alto encosta na parede; os de baixo avançam para a proa.
      const centerZ = z - tread * (steps - step - 0.5);
      builder.addBox(
        { x, y: (DECK_Y + top) * 0.5, z: centerZ },
        { x: 1.05, y: top - DECK_Y, z: tread },
        1 / DECK_BAND_TILE,
      );
    }
  }
}

/**
 * A espessura do convés vista de dentro do buraco da escotilha.
 *
 * A braçola cobre os 16 cm de cima; daqui para baixo é este colarinho que fecha
 * o corte entre a face de cima e a de baixo do convés. São quatro blocos
 * encaixados na própria espessura do convés, meio centímetro para fora do vão,
 * para não disputarem profundidade com a face interna da braçola.
 */
function buildHatchRim(builder: GeometryBuilder): void {
  const zFore = tToZ(STATIONS.hatch + HATCH_HALF_T);
  const zAft = tToZ(STATIONS.hatch - HATCH_HALF_T);
  const halfLength = (zAft - zFore) * 0.5;
  const centerZ = (zAft + zFore) * 0.5;
  const inner = HATCH_HALF_WIDTH + 0.005;
  const thickness = 0.06;
  // Entra na braçola por cima e passa do teto por baixo: as duas sobras somem
  // dentro de madeira que já existe, e nenhuma junta fica no fio.
  const top = DECK_Y + 0.1;
  const bottom = DECK_Y - DECK_THICKNESS - 0.02;
  const center = { y: (top + bottom) * 0.5 };
  const height = top - bottom;

  for (const side of [1, -1]) {
    builder.addBox(
      { x: side * (inner + thickness * 0.5), y: center.y, z: centerZ },
      { x: thickness, y: height, z: halfLength * 2 + thickness * 2 },
      1 / DECK_BAND_TILE,
    );
    builder.addBox(
      { x: 0, y: center.y, z: centerZ + side * (halfLength + thickness * 0.5 + 0.005) },
      { x: (inner + thickness) * 2, y: height, z: thickness },
      1 / DECK_BAND_TILE,
    );
  }
}

/**
 * Braçola da escotilha: o rebordo que impede a água do convés de cair no porão.
 * Além de real, ela esconde a espessura zero do corte no convés.
 *
 * **Aberta para a ré**, e isso não é economia de geometria: é por ali que a
 * escada sobe, e uma braçola fechada dos quatro lados seria um degrau de 16 cm
 * atravessado na boca do lance — exatamente onde o pé de quem sai do porão
 * aterrissa. Navio de verdade faz igual: o lado por onde se entra é recortado.
 */
function buildHatchCoaming(builder: GeometryBuilder): void {
  const zFore = tToZ(STATIONS.hatch + HATCH_HALF_T);
  const zAft = tToZ(STATIONS.hatch - HATCH_HALF_T);
  const halfLength = (zAft - zFore) * 0.5;
  const centerZ = (zAft + zFore) * 0.5;
  const height = 0.16;
  const thickness = 0.1;
  const y = DECK_Y + deckCamber(0, deckHalfWidth(STATIONS.hatch)) + height * 0.5 - 0.02;

  for (const side of [1, -1]) {
    builder.addBox(
      { x: side * (HATCH_HALF_WIDTH + thickness * 0.5), y, z: centerZ },
      { x: thickness, y: height, z: halfLength * 2 + thickness },
      1 / DECK_BAND_TILE,
    );
  }

  // Só o testeiro de vante, no lado oposto ao da escada.
  builder.addBox(
    { x: 0, y, z: zFore - thickness * 0.5 },
    { x: (HATCH_HALF_WIDTH + thickness) * 2, y: height, z: thickness },
    1 / DECK_BAND_TILE,
  );
}

/**
 * Quilha, roda de proa e cadaste — o esqueleto que aparece por fora.
 *
 * São varreduras de seção retangular seguindo a linha do fundo e a da proa. Além
 * de darem o perfil certo ao navio de longe, cobrem a costura onde as duas
 * metades do costado se encontram.
 */
function buildBackbone(builder: GeometryBuilder): void {
  const halfWidth = 0.13;
  const depth = 0.22;

  // Quilha: acompanha `keelY` de ponta a ponta.
  const profile: [number, number][] = [
    [-halfWidth, 0.04],
    [-halfWidth, -depth],
    [halfWidth, -depth],
    [halfWidth, 0.04],
  ];

  const ringAt = (t: number): Vertex[] => {
    const section = sampleSection(t, sectionScratchB);
    const z = tToZ(t);
    const row: Vertex[] = [];
    for (let i = 0; i <= profile.length; i++) {
      const [dx, dy] = profile[i % profile.length]!;
      row.push(
        vertex(dx, section.keelY + dy, z, (t * HULL_LENGTH) / HULL_PLANK_TILE, i * 0.12),
      );
    }
    return row;
  };

  const steps = 48;
  let previous = ringAt(0.015);
  for (let i = 1; i <= steps; i++) {
    const t = 0.015 + (i / steps) * 0.955;
    const row = ringAt(t);
    builder.addStrip(previous, row, true);
    previous = row;
  }

  // Roda de proa: sobe da quilha até a borda, seguindo o contorno frontal do
  // casco. É o que dá à Chalupa aquele perfil de proa reta e alta.
  const stemSteps = 20;
  const stemRing = (h: number): Vertex[] => {
    const section = sampleSection(0.985, sectionScratchB);
    const y = section.keelY + (section.sheerY - section.keelY) * h;
    // A proa avança conforme sobe: a roda se inclina para a frente.
    const z = tToZ(0.985) - 0.06 - h * 0.34;
    const row: Vertex[] = [];
    for (let i = 0; i <= profile.length; i++) {
      const [dx, dy] = profile[i % profile.length]!;
      row.push(vertex(dx, y + dy * 0.35, z + dy * 0.9, h * 3, i * 0.12));
    }
    return row;
  };
  previous = stemRing(0);
  for (let i = 1; i <= stemSteps; i++) {
    const row = stemRing(i / stemSteps);
    builder.addStrip(previous, row, true);
    previous = row;
  }

  // Cadaste: a peça vertical da popa, onde o leme vai pendurado.
  const sternSection = sampleSection(0.01, sectionScratchB);
  builder.addBox(
    {
      x: 0,
      y: (sternSection.keelY + DECK_Y) * 0.5,
      z: HALF_LENGTH - 0.04,
    },
    { x: 0.26, y: DECK_Y - sternSection.keelY, z: 0.22 },
    1 / HULL_GIRTH_TILE,
  );
}

/**
 * Cintados: as duas faixas horizontais que correm o costado.
 *
 * Num navio real são as tábuas mais grossas, que absorvem o encosto no cais. No
 * jogo elas fazem outro trabalho igualmente importante: quebram a superfície
 * lisa do costado e dão à silhueta a linha de tosadura que se lê de longe, que é
 * o que faz a Chalupa parecer a Chalupa mesmo a duzentos metros.
 */
function buildWales(builder: GeometryBuilder): void {
  const steps = 56;
  const height = 0.19;
  const stand = 0.055;

  for (const waleY of WALE_HEIGHTS) {
    for (const side of [1, -1]) {
      const ringAt = (t: number): Vertex[] => {
        const section = sampleSection(t, sectionScratchB);
        const vLow = sectionV(section, waleY - height * 0.5);
        const vHigh = sectionV(section, waleY + height * 0.5);
        const normal = hullSurfaceNormal(t, sectionV(section, waleY), side, normalScratch).clone();

        const low = hullSurfacePoint(t, vLow, side, new THREE.Vector3());
        const high = hullSurfacePoint(t, vHigh, side, new THREE.Vector3());
        const u = (t * HULL_LENGTH) / HULL_PLANK_TILE;

        const corners = [
          low.clone(),
          low.clone().addScaledVector(normal, stand),
          high.clone().addScaledVector(normal, stand),
          high.clone(),
        ];
        const row: Vertex[] = [];
        for (let i = 0; i <= corners.length; i++) {
          const p = corners[i % corners.length]!;
          row.push(vertex(p.x, p.y, p.z, u, i * 0.09));
        }
        return row;
      };

      let previous = ringAt(0.01);
      for (let i = 1; i <= steps; i++) {
        const t = 0.01 + (i / steps) * 0.965;
        const row = ringAt(t);
        builder.addStrip(previous, row, side > 0);
        previous = row;
      }
    }
  }
}
