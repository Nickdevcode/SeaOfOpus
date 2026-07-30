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
  zToT,
  type HullSection,
} from './ShipDimensions';
import { BOARDING_LADDERS, BOARDING_RUNG_RADIUS } from './BoardingLadder';

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

// -- o portaló ---------------------------------------------------------------
//
// O vão na amurada por onde se pula no mar, um por bordo, logo acima da escada
// de embarque. Ele não é uma peça: é um **buraco**, e por isso mora aqui e não
// em `ShipParts` — quem tem de deixar de existir é o costado, o forro e a capa.
//
// A faixa é a mesma nos dois bordos (a escada é simétrica), então o `t` sai uma
// vez só. `BoardingLadder` é a fonte: mudar a estação da escada lá move o vão
// aqui, e é isso que impede a escada de subir para uma amurada fechada.

const GANGWAY_SPEC = BOARDING_LADDERS[0]!;
/** Borda de ré do vão (menor `t`, maior Z) e borda de vante (maior `t`). */
const GANGWAY_T_FROM = zToT(GANGWAY_SPEC.z + GANGWAY_SPEC.gangwayHalfWidth);
const GANGWAY_T_TO = zToT(GANGWAY_SPEC.z - GANGWAY_SPEC.gangwayHalfWidth);

/**
 * Quanto o **forro** é cortado abaixo do costado, no vão.
 *
 * Os dois não podem ser cortados na mesma linha, e a razão é a de sempre neste
 * casco: o forro é deslocado ao longo da normal, não na horizontal. Na amurada
 * de popa a normal aponta ligeiramente para baixo (n·y = −0,07), então o ponto
 * do forro na mesma estação `v` do costado sai **9 mm mais alto** — cortar os
 * dois em `v` igual deixaria um friso de forro atravessado no meio do piso do
 * portaló, do lado de dentro. Dois centímetros de sobra põem o fio do forro em
 * y ≈ 1,729: abaixo do piso e dentro da espessura da soleira, que o cobre.
 */
const GANGWAY_LINER_DROP = 0.02;

/** Espessura da soleira do portaló. Cabe dentro de `DECK_THICKNESS` de propósito:
 *  a ponta de dentro dela morre embutida no próprio convés. */
const GANGWAY_SILL_THICKNESS = 0.05;

/** `true` quando a estação cai dentro do vão, nos dois bordos. */
function inGangway(t: number): boolean {
  return t > GANGWAY_T_FROM && t < GANGWAY_T_TO;
}

/** `v` em que o **costado** morre no vão: a linha do piso do tombadilho. */
function gangwaySillV(t: number): number {
  return sectionV(sampleSection(t, sectionScratchB), QUARTERDECK_Y);
}

/** `v` em que o **forro** morre no vão — ver `GANGWAY_LINER_DROP`. */
function gangwayLinerV(t: number): number {
  return sectionV(sampleSection(t, sectionScratchB), QUARTERDECK_Y - GANGWAY_LINER_DROP);
}

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
  buildGangways(deck);
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
  // Não é mais uma varredura só por causa do portaló: as bordas do vão entram
  // como estações explícitas (senão o corte nasceria serrilhado no passo da
  // malha) e as faixas de dentro dele param na linha do piso.
  const rows = deckRows(0, 1, LENGTH_SEGMENTS, [GANGWAY_T_FROM, GANGWAY_T_TO]);

  for (const side of [1, -1]) {
    for (let i = 0; i < rows.length - 1; i++) {
      const tA = rows[i]!;
      const tB = rows[i + 1]!;
      const cut = inGangway((tA + tB) * 0.5);
      builder.addStrip(girthRow(tA, side, cut), girthRow(tB, side, cut), side > 0);
    }
  }
}

/**
 * Uma fileira da quilha à borda, opcionalmente decepada na soleira do portaló.
 *
 * O corte é um **grampeamento** de `v`, e não uma fileira mais curta: assim os
 * vértices abaixo da soleira caem exatamente nos mesmos `v` da faixa vizinha
 * intacta, e as duas se encontram sem fresta. O que sobra acima do grampo são
 * quadriláteros de área zero, que o `GeometryBuilder` já descarta sozinho na hora
 * de somar as normais — é o preço, barato, de não ter duas amostragens diferentes
 * da mesma curva encostando uma na outra.
 */
function girthRow(t: number, side: number, cut: boolean): Vertex[] {
  const maxV = cut ? gangwaySillV(t) : 1;
  const row: Vertex[] = [];
  for (let j = 0; j <= GIRTH_SEGMENTS; j++) {
    row.push(hullVertex(t, Math.min(j / GIRTH_SEGMENTS, maxV), side, 0));
  }
  return row;
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
  const rows = deckRows(SHELL_T_FROM, SHELL_T_TO, LENGTH_SEGMENTS, [
    GANGWAY_T_FROM,
    GANGWAY_T_TO,
  ]);

  for (const side of [1, -1]) {
    for (let i = 0; i < rows.length - 1; i++) {
      const tA = rows[i]!;
      const tB = rows[i + 1]!;
      const cut = inGangway((tA + tB) * 0.5);
      builder.addStrip(innerRow(tA, side, cut), innerRow(tB, side, cut), side < 0);
    }
  }
}

/** Uma fileira do forro, com o mesmo grampeamento de `girthRow` no portaló. */
function innerRow(t: number, side: number, cut: boolean): Vertex[] {
  const section = sampleSection(t, sectionScratchB);
  // O piso do porão sobe acima da quilha no meio do navio e a alcança nas
  // pontas; abaixo dele não há forro para desenhar. Começar um palmo *abaixo*
  // dele é de propósito: o assoalho pousa por cima do forro, como numa
  // embarcação de verdade, e a junta some debaixo da tábua em vez de depender de
  // dois cálculos independentes baterem no milímetro.
  const vFloor = Math.max(sectionV(section, HOLD_FLOOR_Y - FLOOR_OVERLAP), 0);
  const maxV = cut ? gangwayLinerV(t) : 1;

  const row: Vertex[] = [];
  for (let j = 0; j <= GIRTH_SEGMENTS; j++) {
    const v = vFloor + (1 - vFloor) * (j / GIRTH_SEGMENTS);
    row.push(hullVertex(t, Math.min(v, maxV), side, -HULL_THICKNESS));
  }
  return row;
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
/**
 * A capa **desce** um pouco pelas duas faces em vez de pousar em cima delas.
 *
 * A versão anterior era uma tira plana no topo exato da amurada, subida 12 mm
 * para não brigar em profundidade com o costado. Esses 12 mm eram uma fenda
 * aberta em toda a volta do navio, dos dois lados — e o convés é justamente onde
 * o jogador encosta o nariz na amurada. Descendo 2,5 cm por fora e por dentro a
 * peça abraça a quina, cobre a costura em vez de pairar sobre ela, e ainda ganha
 * a espessura que uma tábua de capa realmente tem.
 */
const CAP_RAIL_DROP = 0.025;

/**
 * Um ponto da capa da amurada. `w` atravessa a peça: 0 na saia externa, 0,5 no
 * topo, 1 na saia interna.
 *
 * Está numa função própria porque o batente do portaló precisa terminar
 * **exatamente** neste perfil. A capa é interrompida no vão, e o corte da
 * amurada aparece por baixo dela: se o batente parasse na linha reta do topo do
 * costado, sobraria 1,4 cm de fresta sob a coroa da capa no meio da peça e 1,1 cm
 * de aba sobrando na quina de fora. Lendo o mesmo perfil, as duas peças se
 * encontram no fio por construção.
 */
function capRailVertex(t: number, w: number, side: number): Vertex {
  const across = Math.min(w, 1 - w) * 2;
  const point = hullVertex(t, 1, side, -w * HULL_THICKNESS);
  return vertex(
    point.x,
    // Sobe no meio e desce nas duas bordas: um perfil de tampo arredondado.
    point.y + 0.014 - CAP_RAIL_DROP * (1 - across),
    point.z,
    (t * HULL_LENGTH) / DECK_PLANK_TILE,
    (w * HULL_THICKNESS * side) / DECK_BAND_TILE,
  );
}

/** Divisões da capa na travessia. O batente do portaló usa as mesmas. */
const CAP_RAIL_SEGMENTS = 6;

function capRailRow(t: number, side: number): Vertex[] {
  const row: Vertex[] = [];
  for (let j = 0; j <= CAP_RAIL_SEGMENTS; j++) row.push(capRailVertex(t, j / CAP_RAIL_SEGMENTS, side));
  return row;
}

function buildCapRail(builder: GeometryBuilder): void {
  // Interrompida no portaló: é a capa que faz a amurada ser um muro, e deixá-la
  // passar por cima do vão daria uma janela em vez de uma saída.
  const rows = deckRows(0.004, 0.996, LENGTH_SEGMENTS, [GANGWAY_T_FROM, GANGWAY_T_TO]);

  for (const side of [1, -1]) {
    for (let i = 0; i < rows.length - 1; i++) {
      const tA = rows[i]!;
      const tB = rows[i + 1]!;
      if (inGangway((tA + tB) * 0.5)) continue;
      builder.addStrip(capRailRow(tA, side), capRailRow(tB, side), side > 0);
    }
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
      vertex(u * outerHalf, top - CAP_RAIL_DROP, zOuter, (u * outerHalf) / DECK_BAND_TILE, 0),
    );
    innerRow.push(
      vertex(u * innerHalf, top + 0.014, zInner, (u * innerHalf) / DECK_BAND_TILE, 0.4),
    );
  }
  builder.addStrip(outerRow, innerRow, true);
}

/**
 * Os dois portalós: os batentes que fecham o corte da amurada e a soleira.
 *
 * **Aqui é onde a lição da gávea e a do convés se pagam.** O costado, o forro e
 * a capa são superfícies de face única: recortá-los deixa a amurada com 13 cm de
 * espessura escancarados, e madeira de face única não existe vista de lado —
 * pelo vão apareceria o mar através da própria parede. As duas faces do corte
 * precisam ser desenhadas, e é o que os batentes são: uma tira ligando o costado
 * ao forro em cada borda do vão, do fio da soleira ao perfil da capa.
 *
 * A soleira é uma peça só de propósito, e vai do convés até o pé da escada de
 * embarque. Seriam naturalmente duas — a que tampa a espessura da amurada e a
 * plataforma que atravessa os 18 cm entre o costado e a escada —, mas duas peças
 * de piso na mesma altura encostadas no fio piscam uma contra a outra em
 * profundidade. Uma tábua só não tem junta, e ainda é a coisa certa a bordo: o
 * portaló de um navio tem uma plataforma, senão o primeiro passo de quem embarca
 * é no vazio.
 */
function buildGangways(builder: GeometryBuilder): void {
  for (const spec of BOARDING_LADDERS) {
    const { side } = spec;

    for (const isFore of [false, true]) {
      const t = isFore ? GANGWAY_T_TO : GANGWAY_T_FROM;
      // O batente nasce na linha do **forro**, e não na do costado: ele é a mais
      // baixa das duas (ver `GANGWAY_LINER_DROP`), e começar na outra deixaria
      // 2 cm de forro sem batente na quina de dentro. A sobra some sob a soleira.
      const vLow = gangwayLinerV(t);
      builder.addSurface(
        1,
        CAP_RAIL_SEGMENTS,
        (w, k) =>
          k >= 1
            ? capRailVertex(t, w, side)
            : hullVertex(t, vLow + (1 - vLow) * k, side, -w * HULL_THICKNESS),
        // A face olha para dentro do vão: para vante na borda de ré e vice-versa.
        isFore ? side < 0 : side > 0,
      );
    }

    // Soleira. Mais comprida que o vão nas duas pontas para as faces de topo
    // morrerem dentro da amurada em vez de encostarem no plano dos batentes; o
    // que sobra para fora do costado é a lateral da plataforma, que é peça vista.
    const xIn = Math.min(deckEdgeHalfWidth(GANGWAY_T_FROM), deckEdgeHalfWidth(GANGWAY_T_TO)) - 0.05;
    // Para no fio de dentro da barra de topo da escada: a barra sobra 2,6 cm
    // acima da tábua e vira o focinho do degrau, que é o que se vê num portaló.
    const xOut = spec.topX - BOARDING_RUNG_RADIUS;
    builder.addBox(
      {
        x: side * (xIn + xOut) * 0.5,
        y: QUARTERDECK_Y - GANGWAY_SILL_THICKNESS * 0.5,
        z: spec.z,
      },
      {
        x: xOut - xIn,
        y: GANGWAY_SILL_THICKNESS,
        z: (spec.gangwayHalfWidth + 0.02) * 2,
      },
      1 / DECK_BAND_TILE,
    );
  }
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
/**
 * Os dois cintados se interrompem no vão do portaló, e não é enfeite: é o que
 * deixa a escada de embarque existir.
 *
 * O de baixo (y = 1,02) avança 5,5 cm da madeira e passa **por trás** do plano
 * dos degraus — na estação do montante de vante ele chega a 1,84 m contra os
 * 1,85 m do montante, ou seja, um centímetro de folga para uma peça de 4 cm de
 * raio. Aumentar o recuo da escada custaria os 5,5 cm inteiros em distância do
 * costado (ver `BOARDING_LADDER_CLEARANCE`); interromper o cintado custa uma
 * falha de 84 cm que um portaló de verdade tem de qualquer forma. É o mesmo
 * recurso da braçola da escotilha, aberta a ré para a escada do porão subir.
 *
 * O de cima (y = 1,92) cai dentro do vão pelo mesmo motivo geométrico e por um
 * mais óbvio: com o costado recortado ali, ele ficaria atravessado no meio da
 * porta, pendurado em nada.
 *
 * As pontas do corte são **tampadas**. O cintado é uma varredura de seção
 * fechada, ou seja, um tubo: cortá-lo sem tampa deixaria dois furos por onde se
 * vê o avesso da peça — a mesma armadilha da face única, agora numa peça sólida.
 */
function buildWales(builder: GeometryBuilder): void {
  const steps = 56;
  const height = 0.19;
  const stand = 0.055;
  const rows = deckRows(0.01, 0.975, steps, [GANGWAY_T_FROM, GANGWAY_T_TO]);

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

      for (let i = 0; i < rows.length - 1; i++) {
        const tA = rows[i]!;
        const tB = rows[i + 1]!;
        if (inGangway((tA + tB) * 0.5)) continue;
        builder.addStrip(ringAt(tA), ringAt(tB), side > 0);
      }

      // As tampas das duas pontas do corte. A ordem direta dos quatro cantos dá
      // a normal para +Z a boreste e para −Z a bombordo (o percurso do perfil se
      // espelha junto com o casco), e cada ponta tem de olhar para fora do
      // pedaço que sobrou — daí a comparação entre o bordo e qual das pontas é.
      for (const isFore of [false, true]) {
        const corners = ringAt(isFore ? GANGWAY_T_TO : GANGWAY_T_FROM);
        const [a, b, c, d] = corners as [Vertex, Vertex, Vertex, Vertex];
        if (isFore === (side > 0)) builder.addQuad(a, b, c, d);
        else builder.addQuad(d, c, b, a);
      }
    }
  }
}
