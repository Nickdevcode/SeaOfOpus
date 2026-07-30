/**
 * Everything that sits **on top of** the hull: mast, rigging, helm, capstan,
 * cannons, stairs, anchor and lanterns.
 *
 * The split between static part and moving part is not organizational, it's about
 * performance. Whatever never moves goes into a `GeometryBuilder` shared per
 * material and becomes a single mesh — the whole ship at rest costs a little over
 * half a dozen draw calls. Whatever turns (helm, capstan, cannons, rudder,
 * anchor) needs its own transform and gets a `Group` each; there are few of them,
 * and each one is the interface to an entire game system.
 */

import * as THREE from 'three';
import { GeometryBuilder, vertex, type Vertex } from './GeometryBuilder';
import { withAoUv, type ShipMaterials } from './ShipMaterials';
import {
  DECK_Y,
  HALF_LENGTH,
  HOLD_FLOOR_Y,
  HULL_THICKNESS,
  QUARTERDECK_T,
  QUARTERDECK_Y,
  RUDDER_BLADE,
  STAIR_BOTTOM_Z,
  STAIR_HALF_WIDTH,
  STAIR_STEPS,
  STAIR_TOP_Z,
  STATIONS,
  ceilingY,
  deckCamber,
  deckHalfWidth,
  halfWidthAtHeight,
  hullSurfaceNormal,
  hullSurfacePoint,
  sampleSection,
  sectionV,
  tToZ,
  zToT,
  type HullSection,
} from './ShipDimensions';
import {
  BOARDING_LADDERS,
  BOARDING_RUNG_RADIUS,
  BOARDING_STILE_RADIUS,
  boardingLadderX,
  type BoardingLadderSpec,
} from './BoardingLadder';

/** Materials the parts use. Each one becomes, at most, one mesh. */
export type PartMaterial =
  | 'hull'
  | 'interior'
  | 'deck'
  | 'trim'
  | 'spar'
  | 'rope'
  | 'iron'
  | 'brass'
  | 'glass'
  | 'flame';

export type PartBuilders = Record<PartMaterial, GeometryBuilder>;

const PART_MATERIALS: readonly PartMaterial[] = [
  'hull',
  'interior',
  'deck',
  'trim',
  'spar',
  'rope',
  'iron',
  'brass',
  'glass',
  'flame',
];

export function createPartBuilders(): PartBuilders {
  const builders = {} as PartBuilders;
  for (const key of PART_MATERIALS) builders[key] = new GeometryBuilder();
  return builders;
}

/** Geometry already closed, per material. */
export type PartGeometries = Partial<Record<PartMaterial, THREE.BufferGeometry>>;

/**
 * Closes the accumulators into geometry.
 *
 * Exists separately from `emitMeshes` because the same geometry serves both ships
 * in the match — all that changes from one to the other is the `Object3D` matrix.
 * An empty accumulator does not become geometry: three accepts a zero-vertex
 * `BufferGeometry` without a word and only gives it away later, when it computes
 * the bounding sphere.
 */
export function toPartGeometries(builders: Partial<PartBuilders>): PartGeometries {
  const geometries: PartGeometries = {};
  for (const key of PART_MATERIALS) {
    const builder = builders[key];
    if (builder && builder.vertexCount > 0) geometries[key] = builder.toGeometry();
  }
  return geometries;
}

/** Creates one mesh per geometry and hangs it all off `parent`. */
export function meshesFromParts(
  geometries: PartGeometries,
  materials: ShipMaterials,
  parent: THREE.Object3D,
): THREE.Mesh[] {
  const meshes: THREE.Mesh[] = [];
  for (const key of PART_MATERIALS) {
    const geometry = geometries[key];
    if (!geometry) continue;

    const mesh = new THREE.Mesh(geometry, materials[key]);
    // Glass and flame stay out of the shadow map: one is transparent and the
    // other is the light source itself — shadowing either one would only produce
    // a dark smudge around the lantern.
    const casts = key !== 'glass' && key !== 'flame';
    mesh.castShadow = casts;
    mesh.receiveShadow = casts;
    mesh.name = `ship-${key}`;
    parent.add(mesh);
    meshes.push(mesh);
  }
  return meshes;
}

/** Shortcut for the moving parts, whose geometry is not shared. */
export function emitMeshes(
  builders: Partial<PartBuilders>,
  materials: ShipMaterials,
  parent: THREE.Object3D,
): THREE.Mesh[] {
  return meshesFromParts(toPartGeometries(builders), materials, parent);
}

// ---------------------------------------------------------------------------
// Measurements of the sail rig and of the command station
// ---------------------------------------------------------------------------

/** Mast Z, in the ship's local frame. */
export const MAST_Z = tToZ(STATIONS.mast);
/** The mast starts in the hold, on the keelson — like on a real ship. */
export const MAST_BASE_Y = HOLD_FLOOR_Y;
export const MAST_TOP_Y = 12.2;
/** Upper yard, which carries the sail. */
const YARD_Y = 9.0;
const YARD_HALF = 3.75;
/** Lower boom, which stretches the foot of the sail. */
const BOOM_Y = 3.55;
const BOOM_HALF = 3.6;
const CROW_NEST_Y = 10.25;

/**
 * Height of the helm axle and radius of the rim.
 *
 * The radius dropped from 0.62 to 0.55 because of the **eye line**, not scale.
 * The helmsman stands 85 cm aft of the wheel with his eye at 3.48 m; with the rim
 * at 0.62 and spoke handles sticking 26 cm out of it, the top handle ended at
 * 3.50 m — two centimeters above the eye and dead center on screen. The player
 * steered with a piece of wood covering exactly the point the bow is aimed at. At
 * 0.55, and with shorter handles, the top of the wheel drops to 3.34 m and the
 * view opens above it; 1.1 m of diameter is still a sloop's wheel, not a
 * galleon's.
 */
export const WHEEL_Y = 2.62;
const WHEEL_RADIUS = 0.55;
/** Distance from the centerline to the posts that hold the wheel's axle. */
const WHEEL_POST_X = 0.95;

/**
 * Corners of the sail, in the ship's local frame.
 *
 * Exported because `SailSim` pins the edges of the cloth exactly here: if the two
 * descriptions diverged, the sail would start out loose from its own yard.
 */
export const SAIL_FRAME = {
  topY: YARD_Y - 0.14,
  bottomY: BOOM_Y + 0.14,
  halfWidth: 3.5,
  z: MAST_Z,
  columns: 12,
  rows: 10,
} as const;

/**
 * Mast radius at an absolute height — the rigging needs to know where to land,
 * and impact detection needs to know where the cannonball stops.
 */
export function mastRadius(y: number): number {
  const h = (y - MAST_BASE_Y) / (MAST_TOP_Y - MAST_BASE_Y);
  return 0.24 - 0.13 * Math.min(Math.max(h, 0), 1);
}

/** Height of the quarterdeck floor on the centerline, where the helmsman stands. */
function quarterdeckCenterY(t: number): number {
  return QUARTERDECK_Y + deckCamber(0, deckHalfWidth(t));
}

// ---------------------------------------------------------------------------
// Static parts
// ---------------------------------------------------------------------------

/** One of the ship's lanterns: where it is and whether it goes out by day. */
export interface LanternSpot {
  position: THREE.Vector3;
  /**
   * `true` para a lanterna que fica acesa o dia inteiro.
   *
   * Só a do porão. Lá embaixo não há hora do dia: a única luz que entra é a que
   * desce pelo vão da escotilha, e ela não chega às quinas onde os rombos
   * abrem. Sem esta lanterna, tapar um buraco ao meio-dia era um trabalho feito
   * no escuro — o jogador via um retângulo preto e um esguicho branco dentro.
   */
  alwaysOn: boolean;
}

export interface StaticPartsResult {
  /** Onde pendurar as luzes pontuais das lanternas, em coordenadas do navio. */
  lanterns: LanternSpot[];
}

export function buildStaticParts(b: PartBuilders): StaticPartsResult {
  buildMast(b);
  buildYards(b);
  buildCrowsNest(b);
  buildRigging(b);
  buildBowsprit(b);
  buildStaircase(b);
  buildMastLadder(b);
  buildBoardingLadders(b);
  buildHelmFrame(b);
  buildSternCanopy(b);
  buildBarrels(b);
  buildCleats(b);
  buildCathead(b);
  buildBilgePump(b);
  return { lanterns: buildLanterns(b) };
}

/** Mastro: um tronco cônico do porão ao topo, com as cintas de ferro. */
function buildMast(b: PartBuilders): void {
  b.spar.addLathe(
    { x: 0, y: MAST_BASE_Y, z: MAST_Z },
    MAST_TOP_Y - MAST_BASE_Y,
    (h) => 0.24 - 0.13 * h,
    { radialSegments: 14, heightSegments: 10, capTop: true, uvScale: 0.9 },
  );

  // Cintas: reforçam as emendas do mastro e quebram o cilindro liso.
  for (const y of [1.55, 4.2, 6.8, YARD_Y + 0.35, 11.1]) {
    b.iron.addLathe({ x: 0, y: y - 0.05, z: MAST_Z }, 0.1, () => mastRadius(y) + 0.025, {
      radialSegments: 14,
      heightSegments: 1,
      uvScale: 2,
    });
  }
}

/** Verga e retranca, os dois paus horizontais que esticam a vela. */
function buildYards(b: PartBuilders): void {
  const spar = (y: number, half: number, thickness: number): void => {
    const start = b.spar.vertexCount;
    b.spar.addLathe(
      { x: 0, y: 0, z: 0 },
      half * 2,
      (h) => thickness * (1 - 0.55 * Math.abs(h * 2 - 1)),
      { radialSegments: 10, heightSegments: 12, capBottom: true, capTop: true, uvScale: 1.4 },
    );
    // Torneada em pé e deitada depois: o torno só sabe girar em torno de +Y.
    b.spar.transformFrom(
      start,
      new THREE.Matrix4().makeRotationZ(Math.PI * 0.5).setPosition(half, y, MAST_Z),
    );
  };

  spar(YARD_Y, YARD_HALF, 0.115);
  spar(BOOM_Y, BOOM_HALF, 0.095);

  // Ferragens onde a verga abraça o mastro.
  for (const y of [YARD_Y, BOOM_Y]) {
    b.iron.addLathe({ x: 0, y: y - 0.11, z: MAST_Z }, 0.22, () => mastRadius(y) + 0.045, {
      radialSegments: 12,
      heightSegments: 1,
      uvScale: 2,
    });
  }

  // Ostagas: os cabos que seguram as pontas da verga no topo do mastro.
  const mastHead = new THREE.Vector3(0, 11.3, MAST_Z);
  for (const side of [1, -1]) {
    b.rope.addTube(mastHead, new THREE.Vector3(side * YARD_HALF * 0.92, YARD_Y, MAST_Z), 0.022);
  }
}

/**
 * Cesto da gávea: um anel de tábuas em volta do mastro, com parede e escoras.
 *
 * **Tudo aqui tem duas faces, e é essa a diferença que importa.** A versão
 * anterior era feita de superfícies de espessura zero — piso, parede, aro —, e
 * superfície de espessura zero com material `FrontSide` simplesmente não existe
 * para quem olha do outro lado. Do convés, olhando para cima, a gávea inteira
 * desaparecia: não havia fundo, não havia parede, e o que sobrava eram as seis
 * escoras diagonais boiando em volta do mastro. É o mesmo defeito que o convés
 * teve (ver `DECK_THICKNESS`) e a mesma cura: dar espessura à peça, com face de
 * cima e face de baixo saindo da mesma varredura.
 */
function buildCrowsNest(b: PartBuilders): void {
  // 1,05 m de raio, e não os 0,92 de antes. A diferença é o que separa um cesto
  // decorativo de um cesto em que se cabe: descontados os 13 cm de mastro no
  // meio e os 30 cm de raio do jogador, 0,92 deixava um anel de treze
  // centímetros para ficar de pé — estreito a ponto de o empurrão do mastro e o
  // limite da parede brigarem e o jogador vibrar entre os dois.
  const radius = 1.05;
  const holeRadius = mastRadius(CROW_NEST_Y) + 0.03;
  /** Espessura do estrado. A mesma do convés, pelo mesmo motivo. */
  const floorThickness = 0.09;
  const wallHeight = 0.52;
  const wallThickness = 0.05;
  const segments = 24;

  /** O anel do piso numa altura, virado para cima ou para baixo. */
  const floorFace = (y: number, up: boolean): void => {
    b.deck.addSurface(
      segments,
      2,
      (s, w) => {
        const angle = s * Math.PI * 2;
        const r = holeRadius + (radius - holeRadius) * w;
        const x = Math.cos(angle) * r;
        const z = Math.sin(angle) * r;
        return vertex(x, y, MAST_Z + z, x, z);
      },
      up,
    );
  };

  /**
   * Uma casca cilíndrica entre duas alturas.
   *
   * `outward` escolhe para que lado ela olha, e é o parâmetro que faz a mesma
   * função servir à borda de fora do cesto e ao furo do mastro no meio dele.
   * A ordem dos laços imita a de `addLathe` — anel de baixo, anel de cima, com
   * o índice correndo pelo ângulo —, então `flip = true` é o lado de fora.
   */
  const skin = (
    builder: GeometryBuilder,
    r: (h: number) => number,
    yBottom: number,
    yTop: number,
    outward: boolean,
  ): void => {
    builder.addSurface(
      1,
      segments,
      (s, t) => {
        const angle = t * Math.PI * 2;
        const radiusAt = r(s);
        return vertex(
          Math.cos(angle) * radiusAt,
          yBottom + (yTop - yBottom) * s,
          MAST_Z + Math.sin(angle) * radiusAt,
          angle * radiusAt,
          s * (yTop - yBottom),
        );
      },
      outward,
    );
  };

  const floorBottom = CROW_NEST_Y - floorThickness;
  floorFace(CROW_NEST_Y, true);
  floorFace(floorBottom, false);
  skin(b.deck, () => radius, floorBottom, CROW_NEST_Y, true);
  skin(b.deck, () => holeRadius, floorBottom, CROW_NEST_Y, false);

  // Parede do cesto, ligeiramente aberta para fora, **com um portaló**.
  //
  // O vão fica no setor por onde a escada do mastro chega. Sem ele o cesto era
  // um balde fechado de 52 cm de parede: dava para subir a escada inteira e não
  // dava para entrar, porque meio metro é mais alto do que o passo automático do
  // controlador. Navio de verdade tem exatamente esse recorte, pelo mesmo motivo.
  //
  // A abertura vai de 60° a 120° no plano local; a escada está em +Z, que é 90°.
  const gapFrom = Math.PI / 3;
  const gapTo = (Math.PI * 2) / 3;
  for (let i = 0; i < segments; i++) {
    const a0 = (i / segments) * Math.PI * 2;
    const a1 = ((i + 1) / segments) * Math.PI * 2;
    const middle = (a0 + a1) * 0.5;
    if (middle > gapFrom && middle < gapTo) continue;

    // A parede tem lado de dentro e lado de fora, e o topo fecha os dois. Sem o
    // lado de dentro, quem está **no** cesto olha através da própria parede.
    const wallAt = (angle: number, h: number, offset: number): Vertex => {
      const r = radius + h * 0.08 + offset;
      return vertex(
        Math.cos(angle) * r,
        CROW_NEST_Y + h * wallHeight,
        MAST_Z + Math.sin(angle) * r,
        angle * radius * 1.2,
        h * wallHeight * 1.2,
      );
    };

    b.deck.addQuad(
      wallAt(a0, 0, 0),
      wallAt(a1, 0, 0),
      wallAt(a1, 1, 0),
      wallAt(a0, 1, 0),
    );
    b.deck.addQuad(
      wallAt(a1, 0, -wallThickness),
      wallAt(a0, 0, -wallThickness),
      wallAt(a0, 1, -wallThickness),
      wallAt(a1, 1, -wallThickness),
    );
    // Capa: a fita de topo que costura as duas faces.
    b.deck.addQuad(
      wallAt(a0, 1, -wallThickness),
      wallAt(a0, 1, 0),
      wallAt(a1, 1, 0),
      wallAt(a1, 1, -wallThickness),
    );
  }

  // Cinta de ferro no topo da parede, seguindo o mesmo recorte. Vai por fora e
  // por dentro, como a própria parede, senão ela some do mesmo jeito.
  for (let i = 0; i < segments; i++) {
    const a0 = (i / segments) * Math.PI * 2;
    const a1 = ((i + 1) / segments) * Math.PI * 2;
    const middle = (a0 + a1) * 0.5;
    if (middle > gapFrom && middle < gapTo) continue;

    const ringAt = (angle: number, h: number, offset: number): Vertex => {
      const r = radius + 0.09 + offset;
      return vertex(
        Math.cos(angle) * r,
        CROW_NEST_Y + wallHeight - 0.1 + h * 0.09,
        MAST_Z + Math.sin(angle) * r,
        angle * 2.5,
        h,
      );
    };
    b.iron.addQuad(ringAt(a0, 0, 0), ringAt(a1, 0, 0), ringAt(a1, 1, 0), ringAt(a0, 1, 0));
    b.iron.addQuad(ringAt(a1, 0, -0.03), ringAt(a0, 0, -0.03), ringAt(a0, 1, -0.03), ringAt(a1, 1, -0.03));
  }

  // Escoras diagonais: sem elas o cesto parece colado no mastro.
  for (let i = 0; i < 6; i++) {
    const angle = (i / 6) * Math.PI * 2;
    b.spar.addTube(
      new THREE.Vector3(0, CROW_NEST_Y - 0.85, MAST_Z),
      new THREE.Vector3(
        Math.cos(angle) * radius * 0.95,
        floorBottom,
        MAST_Z + Math.sin(angle) * radius * 0.95,
      ),
      0.045,
      0.035,
      6,
    );
  }
}

/**
 * Enxárcias, estais, ostagas e adriças.
 *
 * As enxárcias não são decoração: são o par de escadas de corda pelas quais se
 * sobe até a gávea, e por isso os enfrechates precisam existir de verdade e ficar
 * no espaçamento de um passo.
 */
function buildRigging(b: PartBuilders): void {
  const anchorY = 8.55;

  for (const side of [1, -1]) {
    // **Atrás da vela**, e é isso que os três números decidem.
    //
    // Os pés estavam em −1,35 a +0,85 do mastro, ou seja, dois deles à vante
    // dele. Como a lona embarriga justamente para vante, na meia altura os
    // cabos passavam **na frente** do pano e a vela aparecia rasgada por três
    // cordas de cada bordo — o efeito de "cordame bugado" que se via de longe.
    // Com os pés a ré, a enxárcia fica sempre por trás da barriga: em y = 5 m
    // ela cai em z = −1,49 contra os −1,69 da lona, e nunca a cruza.
    //
    // O limite de quanto se pode recuar é o canhão, em z = 0,8: com o pé mais a
    // ré em −0,2 sobram 80 cm entre o cabo e o setor que a boca do cano varre.
    const offsets = [-0.5, 0.25, 1.0];
    const feet = offsets.map((dz) => {
      const z = MAST_Z + dz;
      // O pé morre na **mesa das enxárcias**, que é a face de dentro da amurada
      // logo abaixo da capa. Estava cravado em y = 2,0 — meio metro acima do
      // convés e um palmo abaixo do topo da amurada, ou seja, no ar, com o cabo
      // terminando no vazio entre o costado e o nada. Lido da tosadura real, o
      // pé acompanha a amurada subindo para a proa, como num navio.
      const y = sheerAt(z) - 0.16;
      return new THREE.Vector3(side * (halfWidthAtHeight(zToT(z), y) - 0.07), y, z);
    });
    const head = new THREE.Vector3(side * 0.16, anchorY, MAST_Z);

    for (let i = 0; i < feet.length; i++) {
      const top = head.clone();
      top.y -= Math.abs(offsets[i]!) * 0.25;
      b.rope.addTube(top, feet[i]!, 0.032, 0.038, 6);
    }

    // Enfrechates entre a enxárcia de vante e a de ré. Param antes do topo:
    // lá em cima os cabos já convergiram e o degrau não teria largura.
    const rungs = 10;
    for (let i = 0; i < rungs; i++) {
      const k = 0.04 + (i / (rungs - 1)) * 0.8;
      b.rope.addTube(
        feet[0]!.clone().lerp(head, k),
        feet[2]!.clone().lerp(head, k),
        0.018,
        0.018,
        5,
      );
    }
  }

  // Estai de proa: segura o mastro contra o tombo para ré, morrendo no gurupés.
  const head = new THREE.Vector3(0, 11.0, MAST_Z);
  b.rope.addTube(head, new THREE.Vector3(0, 3.05, tToZ(0.975) - 2.6), 0.034, 0.03, 6);

  // Brandais de popa: **dois**, um por bordo, presos à borda do tombadilho.
  //
  // Um cabo só na linha de centro era mais simples e estava errado por dois
  // motivos. O náutico: um brandal no eixo não segura o mastro contra a guinada,
  // que é justamente o esforço que as enxárcias não cobrem — por isso navio
  // nenhum usa um. E o de jogo: o pé dele caía em (0, 2.62, 7.65), que é ao
  // mesmo tempo a altura do cubo do timão e o ponto exato onde o timoneiro
  // fica. Ao assumir o leme, o cabo saía do rosto do jogador e riscava a tela de
  // alto a baixo, passando pelo meio da roda. Abertos para os bordos os dois
  // cabos fazem o trabalho de verdade e ainda emolduram a vista em vez de cortá-la.
  //
  // São também os cabos mais finos do cordame — 4 cm contra os 7 cm das
  // enxárcias — porque são os únicos que o jogador vê a dois metros do olho. Na
  // bitola das enxárcias eles liam como duas barras atravessadas na tela; a
  // espessura aqui é escolhida pela distância de onde se olha, não pelo esforço.
  for (const side of [1, -1]) {
    const z = HALF_LENGTH - 0.55;
    const y = sheerAt(z) - 0.14;
    b.rope.addTube(
      new THREE.Vector3(side * 0.12, head.y - 0.15, MAST_Z),
      new THREE.Vector3(side * (halfWidthAtHeight(zToT(z), y) - 0.09), y, z),
      0.022,
      0.019,
      6,
    );
  }

  // Adriças da verga, descendo até as malaguetas da amurada. O ponto de baixo
  // sai da **mesma** função que desenha as malaguetas: antes era um X fixo de
  // 2,0 m e o cabo morria 30 cm ao lado do cunho, no ar.
  for (const side of [1, -1]) {
    const cleat = cleatPoint(side as 1 | -1, CLEAT_Z[0]!);
    b.rope.addTube(
      new THREE.Vector3(side * YARD_HALF * 0.96, YARD_Y - 0.05, MAST_Z),
      new THREE.Vector3(cleat.x, cleat.y + 0.06, cleat.z),
      0.02,
      0.02,
      5,
    );
  }
}

/** Altura do topo da amurada num Z local — a linha de tosadura. */
function sheerAt(z: number): number {
  return sampleSection(zToT(z), sheerScratch).sheerY;
}

const sheerScratch: HullSection = { halfBeam: 0, keelY: 0, sheerY: 0, fullness: 1 };

/** Gurupés: o pau que avança sobre a proa e ancora o estai. */
function buildBowsprit(b: PartBuilders): void {
  const root = new THREE.Vector3(0, 2.35, tToZ(0.975));
  const tip = new THREE.Vector3(0, 3.15, tToZ(0.975) - 3.1);
  b.spar.addTube(root, tip, 0.14, 0.07, 12, 1.2);
  b.iron.addTube(root.clone().lerp(tip, 0.34), root.clone().lerp(tip, 0.42), 0.11, 0.105, 12, 2.5);
}

/**
 * A escada do porão — um **lance inclinado**, não uma escada de mão.
 *
 * É a diferença que muda a sensação do navio inteiro. Escada de mão obriga a
 * parar, apertar uma tecla, entrar num modo em que só se sobe e descer; lance
 * inclinado é chão, e chão se anda. O jogador vai andando para o buraco e desce.
 * É o que a Chalupa do Sea of Thieves tem, e é por isso que descer ao porão lá
 * não interrompe o que se estava fazendo.
 *
 * A forma dos degraus sai de `stairSurfaceY`, a mesma função que o
 * `PlayerController` usa como chão. Não há como o pé pisar onde a tábua não está.
 */
function buildStaircase(b: PartBuilders): void {
  const run = STAIR_TOP_Z - STAIR_BOTTOM_Z;
  const tread = run / STAIR_STEPS;
  const rise = (DECK_Y - HOLD_FLOOR_Y) / STAIR_STEPS;
  // A tábua é um dedo mais estreita que o vão: o degrau precisa ocupá-lo inteiro
  // para não sobrar chão faltando, mas encostar no fio da braçola põe as duas
  // faces na mesma profundidade e elas piscam uma contra a outra.
  const half = STAIR_HALF_WIDTH - 0.015;

  for (let i = 0; i < STAIR_STEPS; i++) {
    const top = DECK_Y - rise * (i + 1);
    const centerZ = STAIR_TOP_Z - tread * (i + 0.5);

    // Piso do degrau: uma tábua grossa, ligeiramente saliente sobre o espelho.
    b.deck.addBox(
      { x: 0, y: top - 0.025, z: centerZ - 0.015 },
      { x: half * 2, y: 0.05, z: tread + 0.03 },
      1.6,
    );
    // Espelho: fecha o vão sob o degrau, senão o porão aparece por baixo dele.
    b.interior.addBox(
      { x: 0, y: top - rise * 0.5 - 0.02, z: centerZ - tread * 0.5 + 0.02 },
      { x: half * 2, y: rise, z: 0.04 },
      2,
    );
  }

  // Longarinas: as duas vigas em que os degraus se encaixam. Ficam **fora** do
  // vão, embutidas na espessura da braçola, para não roubarem largura de
  // passagem — a escada ocupa o alçapão inteiro justamente para não sobrar
  // buraco pelos lados.
  for (const side of [1, -1]) {
    const x = side * (STAIR_HALF_WIDTH + 0.05);
    b.interior.addTube(
      new THREE.Vector3(x, DECK_Y - 0.04, STAIR_TOP_Z + 0.02),
      new THREE.Vector3(x, HOLD_FLOOR_Y - 0.02, STAIR_BOTTOM_Z - 0.06),
      0.08,
      0.08,
      6,
      1.4,
    );
  }
}

/**
 * A escada do mastro, do convés à gávea.
 *
 * Aqui a escada de mão é a peça certa, e pelo motivo oposto ao do porão: são
 * nove metros na vertical, encostados num tronco. Não existe lance inclinado que
 * caiba nisso, e nenhum navio tentou — sobe-se de mão, agarrando degrau a degrau.
 *
 * Fica a ré do mastro para não brigar com a vela nem com as enxárcias, que
 * convergem para o topo pela frente. É a única forma de chegar ao cesto, e sem
 * ela a gávea era um cenário: existia na tela e não existia no jogo.
 */
export const MAST_LADDER = {
  /** Z local dos montantes, um palmo à ré do mastro. */
  z: MAST_Z + 0.34,
  /** Meia largura entre os montantes. */
  halfWidth: 0.24,
  bottomY: DECK_Y,
  /**
   * Espaçamento de fato entre os enfrechates, em metros.
   *
   * **Não são 30 cm.** O arredondamento é do *número de vãos*, não do
   * espaçamento: 9,10 m de escada dão 30 vãos e sobram 30,33 cm entre barras.
   * A diferença parece irrelevante e não é — o clipe de escalada
   * (`anim_climb.py`) sobe exatamente dois enfrechates por ciclo, e é isso que
   * faz a mão do personagem cair em cima da barra que está desenhada aqui.
   * Mexer nesta escada sem regerar o clipe descasa os dois.
   */
  rungSpacing: (CROW_NEST_Y + 0.15 - DECK_Y)
    / Math.round((CROW_NEST_Y + 0.15 - DECK_Y) / 0.3),
  /** Termina acima do piso do cesto: sobe-se até poder pisar dentro. */
  topY: CROW_NEST_Y + 0.15,
} as const;

/** A plataforma da gávea, para quem precisa saber onde se pode ficar de pé. */
export const CROW_NEST = {
  y: CROW_NEST_Y,
  z: MAST_Z,
  /** Raio útil do piso, já descontada a parede. */
  radius: 0.98,
  /** Raio do mastro nesta altura — o que se contorna lá em cima. */
  mastRadius: mastRadius(CROW_NEST_Y),
} as const;

function buildMastLadder(b: PartBuilders): void {
  const { z, halfWidth, bottomY, topY } = MAST_LADDER;

  for (const side of [1, -1]) {
    b.spar.addTube(
      new THREE.Vector3(side * halfWidth, bottomY - 0.1, z),
      new THREE.Vector3(side * halfWidth, topY, z),
      0.042,
      0.034,
      7,
      1.5,
    );
  }

  const rungs = Math.round((topY - bottomY) / MAST_LADDER.rungSpacing);
  for (let i = 0; i <= rungs; i++) {
    const y = bottomY + MAST_LADDER.rungSpacing * i;
    b.spar.addTube(
      new THREE.Vector3(-halfWidth, y, z),
      new THREE.Vector3(halfWidth, y, z),
      0.026,
      0.026,
      6,
      2,
    );
    // Braçadeira ligando a escada ao mastro a cada três degraus.
    if (i % 3 === 0) {
      b.iron.addTube(
        new THREE.Vector3(0, y, MAST_Z + mastRadius(y)),
        new THREE.Vector3(0, y, z),
        0.016,
        0.016,
        5,
      );
    }
  }
}

/**
 * As escadas de embarque: uma por bordo, na popa, ao lado do timão.
 *
 * É a peça que devolve o jogador ao navio depois de ele cair no mar, e ela só
 * serve para isso — descer é pular pelo portaló, o vão na amurada que
 * `HullGeometry.buildGangways` abre logo acima daqui. Todas as medidas saem de
 * `BoardingLadder`, que é a fonte única: a mesma folha que a malha lê é a que o
 * `PlayerController` usa para saber onde a mão agarra.
 *
 * Duas coisas nesta função não são como na escada do mastro, e as duas vêm do
 * fato de a escada estar pendurada num casco curvo em vez de num tronco reto:
 *
 * 1. **Os montantes são tornos deitados, não `addTube`.** `addTube` não fecha as
 *    pontas, e aqui as duas aparecem: a de cima morre no fio da soleira do
 *    portaló e a de baixo fica debaixo d'água, exatamente onde o nadador chega.
 *    Um tubo aberto vira um buraco por onde se vê o interior da peça.
 * 2. **As ferragens saem de `hullSurfacePoint`/`hullSurfaceNormal`**, e não de um
 *    recuo horizontal da meia boca — é o mesmo motivo de `buildWales` e da nota
 *    de `deckEdgeHalfWidth`: no bojo o costado corre inclinado, e "13 cm para
 *    dentro na horizontal" e "13 cm ao longo da normal" são pontos diferentes.
 *    Com a conta horizontal o pé da braçadeira nasceria fora da madeira.
 */
function buildBoardingLadders(b: PartBuilders): void {
  for (const spec of BOARDING_LADDERS) buildBoardingLadder(b, spec);
}

/**
 * Quanto o montante desce abaixo da última barra.
 *
 * Não é folga de desenho: é o que impede a barra mais baixa — a que o nadador
 * agarra às cegas, com a onda passando por cima — de ficar na própria ponta do
 * montante, onde uma mão que erra dez centímetros não encontra nada.
 */
const BOARDING_STILE_FOOT = 0.14;

/** Alturas das braçadeiras que prendem a escada ao costado. Escolhidas pelo que
 *  elas **não** podem tocar: o cintado de baixo ocupa de 0,925 a 1,115, e a
 *  soleira do portaló de 1,69 a 1,74. */
const BOARDING_BRACKET_HEIGHTS: readonly number[] = [0.65, 1.55];

function buildBoardingLadder(b: PartBuilders, spec: BoardingLadderSpec): void {
  const { side, z, halfWidth, topY, bottomY, rungSpacing, rungCount, tilt } = spec;
  const stileZ = [z - halfWidth, z + halfWidth];

  // Montantes. O torno gira em +Y, então a peça nasce em pé e um `transformFrom`
  // a deita no ângulo da escada — o mesmo caminho da verga em `buildYards`.
  // O topo para no fio de cima da última barra, e não no piso: rente ao piso a
  // tampa do montante disputaria profundidade com a soleira, e o que se veria
  // seria um disco de madeira piscando no chão do portaló.
  const footY = bottomY - BOARDING_STILE_FOOT;
  const headY = topY + BOARDING_RUNG_RADIUS;
  const length = (headY - footY) / Math.cos(tilt);
  for (const z0 of stileZ) {
    const start = b.spar.vertexCount;
    b.spar.addLathe({ x: 0, y: 0, z: 0 }, length, () => BOARDING_STILE_RADIUS, {
      radialSegments: 8,
      heightSegments: 2,
      capBottom: true,
      capTop: true,
      uvScale: 1.5,
    });
    b.spar.transformFrom(
      start,
      new THREE.Matrix4()
        // O tombo é para fora do navio nos dois bordos, e `side` é o que troca o
        // sinal: sem ele a escada de bombordo se enfiaria no casco ao subir.
        .makeRotationZ(-side * tilt)
        .setPosition(side * boardingLadderX(spec, footY), footY, z0),
    );
  }

  // Barras. Ficam num plano de X constante para cada altura, então cada uma é um
  // bastão horizontal correndo de um montante ao outro; as pontas morrem no eixo
  // dos montantes, enterradas na madeira deles.
  for (let i = 0; i <= rungCount; i++) {
    const y = bottomY + rungSpacing * i;
    const x = side * boardingLadderX(spec, y);
    b.spar.addTube(
      new THREE.Vector3(x, y, stileZ[0]!),
      new THREE.Vector3(x, y, stileZ[1]!),
      BOARDING_RUNG_RADIUS,
      BOARDING_RUNG_RADIUS,
      6,
      2,
    );
  }

  // Braçadeiras: o ferro que amarra cada montante ao costado. O pé entra 3 cm
  // pela normal adentro, de propósito — a ponta do tubo é aberta, e enterrada no
  // chapeamento ela some em vez de virar um furo na peça.
  const section: HullSection = { halfBeam: 0, keelY: 0, sheerY: 0, fullness: 1 };
  const anchor = new THREE.Vector3();
  const normal = new THREE.Vector3();
  for (const y of BOARDING_BRACKET_HEIGHTS) {
    for (const z0 of stileZ) {
      const t = zToT(z0);
      const v = sectionV(sampleSection(t, section), y);
      hullSurfacePoint(t, v, side, anchor);
      hullSurfaceNormal(t, v, side, normal);
      b.iron.addTube(
        anchor.clone().addScaledVector(normal, -0.03),
        new THREE.Vector3(side * boardingLadderX(spec, y), y, z0),
        0.018,
        0.015,
        6,
        3,
      );
    }
  }
}

/**
 * O posto do leme: o cavalete que segura a roda e a bitácula à frente dela.
 *
 * **A roda precisa se apoiar em alguma coisa, e antes ela não se apoiava.** Os
 * dois montantes ficam a 95 cm do eixo e o aro tem 62 cm de raio: entre a
 * madeira e a peça sobravam 33 cm de ar, atravessados por um mancal fino que,
 * de frente — que é de onde o timoneiro olha —, desaparece atrás do próprio
 * cubo. O que se via era uma roda de leme pairando sobre o tombadilho.
 *
 * O que resolve isso não é engrossar o mancal: é a coluna central. Num navio o
 * eixo do leme sai de um **tambor** — o cilindro em que o cabo do leme enrola —
 * e esse tambor é sustentado por uma peça que nasce no convés. Com ela no lugar,
 * a roda passa a estar montada em vez de flutuando, e o cavalete inteiro (duas
 * colunas, travessa embaixo e tambor no meio) lê como uma peça só.
 */
function buildHelmFrame(b: PartBuilders): void {
  const z = tToZ(STATIONS.helm);
  const deckY = quarterdeckCenterY(STATIONS.helm);
  const postTop = WHEEL_Y + 0.26;

  for (const side of [1, -1]) {
    // Coluna com pé alargado: a base é o que dá assentamento à vista, e é o que
    // um poste realmente tem para não sair rachando o convés no primeiro mar.
    b.spar.addBox(
      { x: side * WHEEL_POST_X, y: (deckY + postTop) * 0.5, z },
      { x: 0.17, y: postTop - deckY, z: 0.21 },
      1.2,
    );
    b.spar.addBox(
      { x: side * WHEEL_POST_X, y: deckY + 0.07, z },
      { x: 0.3, y: 0.14, z: 0.34 },
      1.4,
    );
    // Nada de chapa de latão no topo do poste: os dois postes ficam na periferia
    // do quadro de quem governa, e duas placas amarelas ali roubam o olho da
    // única peça de latão que precisa ser vista — o punho da marca, em
    // `createWheel`. Metal a bordo é caro e é usado onde faz falta.
    //
    // Mancal ligando o montante ao eixo. **De ferro, e curto.**
    //
    // Em latão eram duas barras amarelas de 76 cm atravessando a roda inteira na
    // altura do cubo, e de dentro do posto elas cortavam a peça ao meio — dois
    // riscos de metal onde deveria haver madeira e ar. Mancal é peça de esforço,
    // não de ornamento: ferro é o material honesto, e ele some no meio da roda
    // em vez de disputar com ela.
    b.iron.addTube(
      new THREE.Vector3(side * (WHEEL_POST_X - 0.06), WHEEL_Y, z),
      new THREE.Vector3(side * 0.3, WHEEL_Y, z),
      0.055,
      0.045,
      10,
      3,
    );
  }

  // Travessa entre as colunas, na altura do peito: fecha o cavalete e é onde o
  // tambor se apoia.
  b.spar.addBox(
    { x: 0, y: WHEEL_Y - 0.52, z },
    { x: WHEEL_POST_X * 2 + 0.17, y: 0.14, z: 0.16 },
    1.4,
  );

  // Coluna central e tambor do leme, sob o eixo da roda.
  b.spar.addBox({ x: 0, y: (deckY + WHEEL_Y - 0.3) * 0.5, z }, { x: 0.26, y: WHEEL_Y - 0.3 - deckY, z: 0.26 }, 1.6);
  const drumStart = b.spar.vertexCount;
  b.spar.addLathe({ x: 0, y: 0, z: 0 }, 0.44, (h) => 0.19 + 0.03 * Math.sin(h * Math.PI), {
    radialSegments: 14,
    heightSegments: 4,
    capBottom: true,
    capTop: true,
    uvScale: 2,
  });
  // O torno gira em +Y e o tambor é deitado no eixo do leme, que corre de bordo
  // a bordo.
  b.spar.transformFrom(
    drumStart,
    new THREE.Matrix4().makeRotationZ(Math.PI * 0.5).setPosition(0.22, WHEEL_Y, z),
  );
  // Cabo do leme saindo do tambor para baixo, por onde a força realmente passa.
  for (const side of [1, -1]) {
    b.rope.addTube(
      new THREE.Vector3(side * 0.16, WHEEL_Y - 0.2, z + 0.02),
      new THREE.Vector3(side * 0.1, deckY + 0.02, z + 0.16),
      0.02,
      0.02,
      6,
    );
  }

  buildBinnacle(b, z - 1.05, deckY);
}

/**
 * Bitácula: a caixa da agulha, logo à frente do timoneiro.
 *
 * A versão anterior era uma caixa de madeira com uma **chapa de latão chapada**
 * fazendo as vezes de tampo — 50 × 42 cm de amarelo liso a um metro do olho de
 * quem governa, sem forma nem função aparente. Em primeira pessoa ela lia como
 * um retângulo de tinta grudado no convés, e era a primeira coisa que puxava o
 * olhar no posto inteiro.
 *
 * Uma bitácula de verdade não é uma caixa com tampa: é um armário baixo com um
 * **tambuchо de vidro** por onde se lê a agulha, telhadinho de duas águas para a
 * chuva não entrar e cantoneiras de latão nas quinas. O latão continua lá — é o
 * metal que não desmagnetiza a agulha, e por isso ele existe nesta peça —, mas
 * como filete e cantoneira, que é a quantidade certa de brilho para dizer
 * "instrumento" sem virar mancha.
 */
function buildBinnacle(b: PartBuilders, z: number, deckY: number): void {
  const bodyHeight = 0.74;
  const bodyTop = deckY + bodyHeight;

  b.spar.addBox({ x: 0, y: deckY + bodyHeight * 0.5, z }, { x: 0.44, y: bodyHeight, z: 0.36 }, 1.6);
  // Cantoneiras nas quatro quinas — de ferro, que é o que protege quina de
  // armário a bordo. Em latão eram quatro barras amarelas de 74 cm emoldurando
  // a peça inteira, e a bitácula lia como um cofre dourado no meio do
  // tombadilho. O latão fica reservado ao topo, onde ele tem função.
  for (const sx of [1, -1]) {
    for (const sz of [1, -1]) {
      b.iron.addBox(
        { x: sx * 0.215, y: deckY + bodyHeight * 0.5, z: z + sz * 0.175 },
        { x: 0.028, y: bodyHeight, z: 0.028 },
        3,
      );
    }
  }
  // Filete na cintura, que é onde a porta do armário abre.
  b.iron.addBox({ x: 0, y: deckY + 0.3, z }, { x: 0.46, y: 0.025, z: 0.38 }, 3);

  // Tambucho da agulha: o armário fecha com uma cinta de latão, a janelinha por
  // onde se lê o rumo abre **para a popa** — que é o lado de onde o timoneiro
  // olha — e um chapéu de madeira cobre tudo.
  b.brass.addBox({ x: 0, y: bodyTop + 0.02, z }, { x: 0.4, y: 0.045, z: 0.33 }, 3);
  b.spar.addBox({ x: 0, y: bodyTop + 0.16, z }, { x: 0.34, y: 0.24, z: 0.28 }, 2);
  b.glass.addBox({ x: 0, y: bodyTop + 0.17, z: z + 0.145 }, { x: 0.19, y: 0.15, z: 0.02 }, 2);
  b.brass.addBox({ x: 0, y: bodyTop + 0.17, z: z + 0.15 }, { x: 0.23, y: 0.19, z: 0.012 }, 3);

  // Chapéu: um cone de oito lados, e não duas águas de quads soltos.
  //
  // A versão de duas águas era feita de quatro quadriláteros avulsos, e faltava
  // o essencial: as duas empenas laterais. O que aparecia no tombadilho era uma
  // aba de madeira inclinada saindo do nada, sem lado nem embaixo. Um sólido de
  // revolução fecha sozinho, tem normal certa em toda volta e ainda lê como
  // peça torneada, que é o que uma bitácula tem em cima.
  b.spar.addLathe({ x: 0, y: bodyTop + 0.28, z }, 0.13, (h) => 0.25 * (1 - h * 0.92) + 0.01, {
    radialSegments: 8,
    heightSegments: 3,
    capBottom: true,
    capTop: true,
    uvScale: 2.4,
  });
}

/**
 * Medidas do toldo de popa, num lugar só porque três consumidores as leem: a
 * malha, os obstáculos que o jogador contorna e quem for pendurar algo nele.
 */
const CANOPY = {
  aftZ: HALF_LENGTH - 0.75,
  foreZ: tToZ(QUARTERDECK_T) + 0.2,
  postTop: 4.02,
  ridgeY: 4.45,
  /** Meia largura útil do toldo numa estação, recuada da amurada. */
  halfAt: (z: number): number => deckHalfWidth(zToT(z)) - 0.34,
} as const;

/**
 * As quatro colunas do toldo, para o controlador do jogador saber contorná-las.
 *
 * Sem isto o marujo atravessava madeira de 13 cm no meio do próprio posto — e
 * atravessar uma peça do navio é o tipo de coisa que só precisa acontecer uma
 * vez para o convés inteiro deixar de parecer sólido. O raio é o da coluna mais
 * um dedo, e não mais: entre ela e a amurada sobram 34 cm, e engordar o
 * obstáculo fecharia essa passagem.
 */
export const CANOPY_BLOCKERS: readonly { x: number; z: number; radius: number }[] = [1, -1]
  .flatMap((side) =>
    [CANOPY.aftZ, CANOPY.foreZ].map((z) => ({
      x: side * CANOPY.halfAt(z),
      z,
      radius: 0.1,
    })),
  );

/**
 * O toldo do tombadilho: quatro colunas e um telhado de duas águas sobre o
 * posto do leme.
 *
 * É a peça que mais aproxima a silhueta da Chalupa do Sea of Thieves, e não por
 * capricho de referência: uma popa descoberta lê como balsa. O toldo dá à popa
 * a massa que o olho procura para chamar aquilo de navio, emoldura o timoneiro
 * (que passa a estar **dentro** de alguma coisa, e não em pé numa tábua alta) e
 * fecha a silhueta contra o horizonte, que é como o inimigo enxerga este navio
 * a duzentos metros.
 *
 * **Todas as alturas aqui saem do olho do jogador, não de proporção.** O convés
 * do tombadilho está a 1,82 m da linha d'água, o olho a 3,48 m, e um pulo leva a
 * cabeça a 4,03 m. Um teto pendurado na altura "bonita" de dois metros de
 * pé-direito cortaria a cabeça do jogador toda vez que ele saltasse, e nada
 * denuncia mais rápido um cenário do que atravessar o próprio navio. A cumeeira
 * fica em 4,45 m: 42 cm acima do pulo, folga suficiente para o balanço do mar
 * não fechar a diferença.
 */
function buildSternCanopy(b: PartBuilders): void {
  const { aftZ, foreZ, postTop, ridgeY, halfAt } = CANOPY;
  const deckY = quarterdeckCenterY(STATIONS.helm);

  for (const side of [1, -1]) {
    for (const z of [aftZ, foreZ]) {
      const x = side * halfAt(z);
      b.spar.addBox(
        { x, y: (deckY + postTop) * 0.5, z },
        { x: 0.13, y: postTop - deckY, z: 0.13 },
        1.4,
      );
      // Mão-francesa: a diagonal que impede o pórtico de balançar. Sem ela o
      // toldo lê como quatro palitos com uma tampa em cima.
      b.spar.addTube(
        new THREE.Vector3(x, postTop - 0.5, z),
        new THREE.Vector3(x - side * 0.42, postTop - 0.06, z),
        0.045,
        0.04,
        6,
        2,
      );
    }

    // Viga longitudinal ligando as duas colunas do bordo.
    const x = side * halfAt((aftZ + foreZ) * 0.5);
    b.spar.addBox(
      { x, y: postTop + 0.06, z: (aftZ + foreZ) * 0.5 },
      { x: 0.15, y: 0.14, z: aftZ - foreZ + 0.3 },
      1.3,
    );
  }

  // Cumeeira, na linha de centro.
  b.spar.addBox(
    { x: 0, y: ridgeY, z: (aftZ + foreZ) * 0.5 },
    { x: 0.12, y: 0.13, z: aftZ - foreZ + 0.34 },
    1.3,
  );

  // As duas águas do telhado. Cada uma é uma placa **com espessura**, torneada
  // reta e inclinada depois: `transformFrom` é o que evita montar um prisma
  // vértice a vértice e ainda garante que as seis faces existam — telhado de
  // espessura zero é o mesmo defeito da gávea, visto por baixo.
  const eavesHalf = halfAt((aftZ + foreZ) * 0.5) + 0.28;
  const rise = ridgeY - postTop - 0.06;
  const slope = Math.hypot(eavesHalf, rise);
  const length = aftZ - foreZ + 0.5;
  for (const side of [1, -1]) {
    const start = b.deck.vertexCount;
    b.deck.addBox({ x: 0, y: 0, z: 0 }, { x: slope, y: 0.07, z: length }, 1.6);
    b.deck.transformFrom(
      start,
      new THREE.Matrix4()
        .makeRotationZ(side * Math.atan2(rise, eavesHalf))
        .setPosition(
          side * eavesHalf * 0.5,
          (ridgeY + postTop + 0.06) * 0.5,
          (aftZ + foreZ) * 0.5,
        ),
    );
  }
}

/** Raio máximo de um barril de convés, na barriga. */
const BARREL_RADIUS = 0.37;
/** Altura de um barril. */
const BARREL_HEIGHT = 0.86;

/**
 * Onde os barris ficam, em (bordo, z).
 *
 * O X **não** é escolhido: sai da meia largura real do convés naquele Z, menos
 * o raio do barril. As posições antigas eram números fixos (±1,87, −1,70) e é
 * assim que barril entra na parede: em z = −2,6 o convés tem 2,26 m de meia
 * largura, então um barril de 37 cm de raio centrado em 1,70 sobra 0,19 m para
 * dentro do costado — que é exatamente o que se via, meio barril enterrado na
 * amurada. Deixando a conta com a curva do casco, eles encostam na madeira em
 * qualquer estação e nunca a atravessam.
 */
const BARREL_PLACES: readonly (readonly [1 | -1, number])[] = [
  [1, -0.6],
  [-1, -0.6],
  [-1, -2.6],
];

/** Barris de convés — os de bala de canhão e o de mantimento. */
function buildBarrels(b: PartBuilders): void {
  for (const [side, z] of BARREL_PLACES) {
    const x = barrelX(side, z);
    const y = DECK_Y + deckCamber(x, deckHalfWidth(zToT(z)));
    // Aduelas: a barriga no meio é o que distingue um barril de um tambor.
    const bulge = (h: number): number =>
      BARREL_RADIUS - 0.07 + 0.07 * Math.sin(h * Math.PI);
    b.spar.addLathe({ x, y, z }, BARREL_HEIGHT, bulge, {
      radialSegments: 14,
      heightSegments: 6,
      capTop: true,
      uvScale: 1.6,
    });
    for (const h of [0.12, 0.5, 0.88]) {
      b.iron.addLathe({ x, y: y + h * BARREL_HEIGHT - 0.035, z }, 0.07, () => bulge(h) + 0.012, {
        radialSegments: 14,
        heightSegments: 1,
        uvScale: 2.5,
      });
    }
  }
}

/**
 * X de um barril: encostado na amurada daquele bordo, sem entrar nela.
 *
 * A folga de 6 cm existe porque a amurada tomba para dentro conforme sobe (o
 * recolhimento em `ShipDimensions`), e o barril tem 86 cm de altura — o topo
 * dele encontra um costado mais estreito que o pé.
 */
function barrelX(side: 1 | -1, z: number): number {
  const t = zToT(z);
  // Mede na altura do topo do barril, que é onde o costado é mais estreito.
  const half = halfWidthAtHeight(t, DECK_Y + BARREL_HEIGHT) - HULL_THICKNESS;
  return side * Math.max(half - BARREL_RADIUS - 0.06, 0.5);
}

/** Onde os barris estão, para o controlador saber contorná-los. */
export const BARREL_BLOCKERS: readonly { x: number; z: number; radius: number }[] =
  BARREL_PLACES.map(([side, z]) => ({
    x: barrelX(side, z),
    z,
    radius: BARREL_RADIUS,
  }));

/**
 * Bomba de porão: onde se tira a água que entrou pelos rombos.
 *
 * Fica a boreste, entre a escotilha e o mastro — perto o bastante da escada para
 * quem desce achar sem procurar, e fora do vão da escotilha, que é por onde a luz
 * do convés desce. A altura da alavanca é a que a mão alcança de pé no porão.
 */
export const BILGE_PUMP = new THREE.Vector3(1.05, HOLD_FLOOR_Y, 1.15);
/** Altura do cabo da alavanca, o ponto de foco da interação. */
export const BILGE_PUMP_HANDLE_Y = HOLD_FLOOR_Y + 1.02;

function buildBilgePump(b: PartBuilders): void {
  const { x, z } = BILGE_PUMP;
  const floor = HOLD_FLOOR_Y;

  // Caixa do poço, assentada no piso: é ela que veda a boca do tubo de sucção.
  b.spar.addBox({ x, y: floor + 0.14, z }, { x: 0.52, y: 0.28, z: 0.46 }, 2.2);

  // Corpo: um tronco quadrado, com as cintas de ferro que apertam as aduelas.
  const trunkHeight = 0.96;
  b.spar.addBox(
    { x, y: floor + 0.28 + trunkHeight * 0.5, z },
    { x: 0.24, y: trunkHeight, z: 0.24 },
    3,
  );
  for (const h of [0.2, 0.72]) {
    b.iron.addBox({ x, y: floor + 0.28 + trunkHeight * h, z }, { x: 0.27, y: 0.05, z: 0.27 }, 4);
  }

  // Cabeça de ferro e o munhão em que a alavanca bascula.
  const headY = floor + 0.28 + trunkHeight;
  b.iron.addBox({ x, y: headY + 0.05, z }, { x: 0.3, y: 0.12, z: 0.26 }, 4);
  b.iron.addTube(
    new THREE.Vector3(x, headY + 0.05, z - 0.16),
    new THREE.Vector3(x, headY + 0.05, z + 0.16),
    0.028,
    0.028,
    8,
  );

  // Alavanca: sai do munhão para dentro do navio e cai um pouco, na posição de
  // repouso. Quem bombeia empurra para baixo, e é esse curso que a animação
  // percorreria — por ora ela fica parada onde a mão a encontra.
  b.iron.addTube(
    new THREE.Vector3(x, headY + 0.05, z + 0.1),
    new THREE.Vector3(x - 0.52, BILGE_PUMP_HANDLE_Y - 0.06, z + 0.1),
    0.026,
    0.022,
    8,
  );
  b.spar.addLathe(
    { x: x - 0.62, y: BILGE_PUMP_HANDLE_Y - 0.09, z: z + 0.1 },
    0.22,
    () => 0.045,
    { radialSegments: 10, heightSegments: 1, capBottom: true, capTop: true, uvScale: 3 },
  );

  // Bica de latão: despeja a água na direção do costado, por onde ela sai pelos
  // embornais. É a única peça brilhante aqui embaixo, e serve de marcador visual
  // no escuro do porão.
  b.brass.addTube(
    new THREE.Vector3(x, floor + 0.5, z),
    new THREE.Vector3(x + 0.34, floor + 0.36, z),
    0.055,
    0.045,
    10,
  );
}

/** Onde ficam as malaguetas, em Z local. */
const CLEAT_Z: readonly number[] = [MAST_Z + 1.6, MAST_Z - 1.2];

/**
 * Posição de um cunho: colado na face de dentro da amurada, um palmo abaixo da
 * capa. Existe como função porque as adriças precisam morrer exatamente aqui.
 */
function cleatPoint(side: 1 | -1, z: number): THREE.Vector3 {
  const y = sheerAt(z) - 0.22;
  return new THREE.Vector3(side * (halfWidthAtHeight(zToT(z), y) - 0.11), y, z);
}

/** Malaguetas: os cunhos onde os cabos morrem, junto à amurada. */
function buildCleats(b: PartBuilders): void {
  for (const side of [1, -1]) {
    for (const z of CLEAT_Z) {
      const point = cleatPoint(side as 1 | -1, z);
      b.spar.addBox(point, { x: 0.1, y: 0.1, z: 0.42 }, 3);
    }
  }
}

/**
 * Lanternas de popa e de mastro.
 *
 * São o que dá escala e leitura ao navio depois do pôr do sol: a chama tem cor
 * acima de 1 de propósito, então o bloom do compositor a transforma num halo, e
 * o `ShipBuilder` pendura uma luz pontual em cada posição devolvida aqui.
 */
function buildLanterns(b: PartBuilders): LanternSpot[] {
  // Farol de popa: pousado **em cima do coroamento**, a peça mais alta da popa.
  //
  // É onde ela estaria num navio, e é onde ela finalmente tem no que se apoiar:
  // a versão anterior pendurava a gaiola em y = 2,78 no eixo central, com um
  // toco de ferro de 28 cm descendo para o nada — a capa da amurada de popa está
  // em 2,58, e sobravam 6 cm de ar entre o pé do suporte e a madeira. Agora o
  // pedestal nasce na própria capa e a chama fica logo acima dela, exatamente na
  // silhueta que se vê da popa de uma Chalupa contra o poente.
  const sternSection = halfWidthAtHeight(0.004, 3.4);
  const sternTop = 2.58;
  const sternZ = HALF_LENGTH - 0.16;

  // Farol de proa: **pendurado no gurupés**, que é a única estrutura que existe
  // lá na frente.
  //
  // A primeira tentativa punha a gaiola sobre a roda de proa, em z = −8,02 — e
  // a roda de proa acaba em −8,0. A lanterha ficava fora do casco, boiando no
  // ar à frente do navio, presa em nada. Aqui ela pende de um gancho no pau, que
  // é onde um navio de verdade a leva: à frente de tudo, iluminando a água que a
  // proa vai cortar, e sem tapar a vista de ninguém a bordo.
  //
  // O Y sai da própria reta do gurupés naquele Z, e não de um número escolhido:
  // o pau sobe 80 cm ao longo de 3,1 m, e é essa conta que garante que o gancho
  // encoste na madeira mesmo se o gurupés mudar de inclinação.
  const bowZ = tToZ(0.975) - 0.95;
  const bowspritY = 2.35 + (0.95 / 3.1) * 0.8;
  const bowY = bowspritY - 0.52;

  // Lanterna de porão: pendurada num vau, a meia-nau, entre o pé da escada e a
  // bomba. É a única que não apaga — ver `LanternSpot.alwaysOn`.
  const holdY = ceilingY(zToT(0.6), 0) - 0.34;
  const holdZ = 0.6;

  const spots = [
    new THREE.Vector3(0, sternTop + 0.62, sternZ),
    new THREE.Vector3(0, bowY, bowZ),
    new THREE.Vector3(0.55, holdY, holdZ),
  ];

  // --- os apoios, antes das gaiolas ---

  // Pedestal do farol de popa: um coto torneado sobre o coroamento.
  b.spar.addLathe({ x: 0, y: sternTop - 0.04, z: sternZ }, 0.34, (h) => 0.1 - 0.03 * h, {
    radialSegments: 12,
    heightSegments: 3,
    capTop: true,
    uvScale: 2,
  });
  b.iron.addTube(
    new THREE.Vector3(0, sternTop + 0.28, sternZ),
    new THREE.Vector3(0, spots[0]!.y - 0.19, sternZ),
    0.026,
    0.026,
    8,
  );
  // Duas escoras abrindo para os bordos, que é o que impede o pedestal de ler
  // como um poste espetado no meio do painel.
  for (const side of [1, -1]) {
    b.spar.addTube(
      new THREE.Vector3(side * Math.min(sternSection * 0.55, 0.62), sternTop - 0.02, sternZ - 0.08),
      new THREE.Vector3(0, sternTop + 0.26, sternZ),
      0.05,
      0.035,
      6,
      2,
    );
  }

  // Gancho do farol de proa: uma alça de ferro em volta do gurupés e a haste
  // que desce dela até a argola da gaiola.
  b.iron.addTorusZ({ x: 0, y: bowspritY, z: bowZ }, 0.12, 0.018, 12, 6, 3);
  b.iron.addTube(
    new THREE.Vector3(0, bowspritY - 0.1, bowZ),
    new THREE.Vector3(0, spots[1]!.y + 0.44, bowZ),
    0.02,
    0.02,
    6,
  );

  // Gancho da lanterna do porão, saindo do teto.
  b.iron.addTube(
    new THREE.Vector3(0.55, ceilingY(zToT(holdZ), 0.55), holdZ),
    new THREE.Vector3(0.55, spots[2]!.y + 0.44, holdZ),
    0.018,
    0.018,
    6,
  );

  for (const spot of spots) {
    const half = 0.13;
    // Quatro montantes, uma base e um chapéu: a gaiola clássica.
    for (const sx of [1, -1]) {
      for (const sz of [1, -1]) {
        b.iron.addBox(
          { x: spot.x + sx * half, y: spot.y, z: spot.z + sz * half },
          { x: 0.026, y: 0.34, z: 0.026 },
          4,
        );
      }
    }
    b.iron.addBox({ x: spot.x, y: spot.y - 0.19, z: spot.z }, { x: 0.32, y: 0.05, z: 0.32 }, 3);
    b.iron.addLathe({ x: spot.x, y: spot.y + 0.17, z: spot.z }, 0.16, (h) => 0.19 * (1 - h * 0.85), {
      radialSegments: 10,
      heightSegments: 3,
      uvScale: 3,
    });
    b.iron.addTube(
      new THREE.Vector3(spot.x, spot.y + 0.33, spot.z),
      new THREE.Vector3(spot.x, spot.y + 0.46, spot.z),
      0.016,
      0.016,
      6,
    );

    b.glass.addBox({ x: spot.x, y: spot.y, z: spot.z }, { x: 0.24, y: 0.31, z: 0.24 }, 2);
    // Chama: uma gota, não uma esfera — a ponta afinada é o que a lê como fogo.
    b.flame.addLathe(
      { x: spot.x, y: spot.y - 0.11, z: spot.z },
      0.17,
      (h) => 0.05 * Math.sin(Math.pow(h, 0.6) * Math.PI) + 0.008,
      { radialSegments: 8, heightSegments: 6 },
    );
  }

  // A do porão é a última da lista, e é a única que não obedece ao relógio.
  return spots.map((position, index) => ({ position, alwaysOn: index === 2 }));
}

// ---------------------------------------------------------------------------
// Peças móveis
// ---------------------------------------------------------------------------

/**
 * O timão.
 *
 * Gira no próprio eixo Z porque a roda fica em pé, virada para a popa. Quem a
 * gira é `Rudder`, e o ângulo visível é o ângulo do leme multiplicado pelo número
 * de voltas de batente a batente — na Chalupa, pouco mais de uma volta inteira.
 */
export function createWheel(materials: ShipMaterials): THREE.Group {
  const b = createPartBuilders();
  const spokes = 8;

  b.spar.addTorusZ({ x: 0, y: 0, z: 0 }, WHEEL_RADIUS, 0.055, 30, 8, 1.5);

  for (let i = 0; i < spokes; i++) {
    // O punho zero nasce **no topo**, e é dele que sai a marca do leme a meio.
    const angle = (i / spokes) * Math.PI * 2 + Math.PI * 0.5;
    const marked = i === 0;
    const direction = new THREE.Vector3(Math.cos(angle), Math.sin(angle), 0);
    b.spar.addTube(
      new THREE.Vector3(0, 0, 0),
      direction.clone().multiplyScalar(WHEEL_RADIUS + 0.12),
      0.05,
      0.032,
      7,
      2,
    );

    // Punho na ponta de cada raio: é por eles que se puxa a roda.
    //
    // **Um deles é de latão, e ele é a única leitura de "leme a meio" que existe
    // a bordo.** Sem essa marca não há como saber, olhando a roda, se ela está
    // no centro ou uma volta fora dele: os oito punhos são iguais, a roda dá
    // pouco mais de uma volta de batente a batente, e o navio responde devagar
    // demais para o desvio aparecer antes de já ter guinado. O jogador ficava
    // com o método do tentativa e erro — virar, esperar, corrigir —, que é
    // exatamente o que a marca do Sea of Thieves elimina.
    //
    // A conta que faz isso valer está em `syncModel`: a roda gira
    // `-wheelAngle`, então o punho que nasce em 90° só volta ao topo quando
    // `wheelAngle` é zero, e zero é o leme no meio. Punho em pé, navio reto.
    // A marca é a **cor**, e só ela. A primeira versão dava ao punho marcado um
    // diâmetro maior e uma cabeça arredondada na ponta, e a soma das três coisas
    // produziu um cogumelo de latão de 13 cm parado no meio da tela de quem
    // governa. Um punho igual aos outros, em outro material, já se lê de
    // relance — que é tudo o que uma marca de leme a meio precisa fazer.
    const handle = marked ? b.brass : b.spar;
    handle.addTube(
      direction.clone().multiplyScalar(WHEEL_RADIUS + 0.03),
      direction.clone().multiplyScalar(WHEEL_RADIUS + 0.19),
      0.052,
      0.043,
      8,
      3,
    );
  }

  b.brass.addTube(new THREE.Vector3(0, 0, -0.11), new THREE.Vector3(0, 0, 0.11), 0.135, 0.135, 14, 3);

  const group = new THREE.Group();
  group.name = 'helm-wheel';
  group.position.set(0, WHEEL_Y, tToZ(STATIONS.helm));
  emitMeshes(b, materials, group);
  return group;
}

/** Cabrestante, que recolhe a âncora. Gira em torno de +Y. */
export function createCapstan(materials: ShipMaterials): THREE.Group {
  const b = createPartBuilders();
  const height = 1.02;

  b.spar.addLathe(
    { x: 0, y: 0, z: 0 },
    height,
    (h) => 0.34 - 0.1 * Math.sin(h * Math.PI) + 0.04 * h,
    { radialSegments: 16, heightSegments: 8, capTop: true, uvScale: 1.6 },
  );

  // Malaguetas verticais: as saliências onde o cabo agarra.
  for (let i = 0; i < 6; i++) {
    const angle = (i / 6) * Math.PI * 2;
    b.spar.addBox(
      { x: Math.cos(angle) * 0.26, y: height * 0.45, z: Math.sin(angle) * 0.26 },
      { x: 0.07, y: height * 0.62, z: 0.07 },
      2,
    );
  }

  b.iron.addLathe({ x: 0, y: height - 0.12, z: 0 }, 0.09, () => 0.4, {
    radialSegments: 16,
    heightSegments: 1,
    uvScale: 2.5,
  });

  // Varas de empurrar, encaixadas no topo.
  for (let i = 0; i < 4; i++) {
    const angle = (i / 4) * Math.PI * 2 + Math.PI * 0.25;
    b.spar.addTube(
      new THREE.Vector3(Math.cos(angle) * 0.2, height - 0.2, Math.sin(angle) * 0.2),
      new THREE.Vector3(Math.cos(angle) * 1.15, height - 0.38, Math.sin(angle) * 1.15),
      0.055,
      0.04,
      8,
      1.5,
    );
  }

  const group = new THREE.Group();
  group.name = 'capstan';
  group.position.set(
    0,
    DECK_Y + deckCamber(0, deckHalfWidth(STATIONS.capstan)),
    tToZ(STATIONS.capstan),
  );
  emitMeshes(b, materials, group);
  return group;
}

export interface CannonAssembly {
  /** Raiz: posição no convés e a orientação fixa do bordo. */
  root: THREE.Group;
  /** Gira em Y — a travessia, dentro do batente da carreta. */
  traverse: THREE.Group;
  /** Gira em X — a elevação do cano. */
  elevation: THREE.Group;
  /** Boca do cano: de onde a bala nasce e por onde sai a fumaça. */
  muzzle: THREE.Object3D;
}

/** Comprimento do cano, da culatra à boca. */
export const BARREL_LENGTH = 1.9;
/** Quanto do cano fica atrás dos munhões, que são o eixo de elevação. */
export const BREECH_OFFSET = 0.55;
/** Altura do eixo do cano acima do convés — o bastante para passar da amurada. */
export const BARREL_AXIS_Y = 1.12;
/** Raio da alma. É também o raio da bala que `Cannonball` dispara. */
export const BORE_RADIUS = 0.052;

/**
 * Perfil do cano, da culatra (h = 0) à boca (h = 1).
 *
 * Os degraus não são enfeite: canhão de ferro fundido é mais grosso onde a
 * pressão é maior, e as duas cinturas de reforço marcam onde a espessura muda.
 * Codificá-las no perfil sai mais barato que modelar anéis à parte — e o mesmo
 * vale para a boca, que mergulha para dentro nos últimos 4% e por isso lê como
 * furo em vez de tampa.
 */
function barrelProfile(h: number): number {
  if (h > 0.96) {
    const k = (h - 0.96) / 0.04;
    return barrelProfile(0.96) * (1 - k) + BORE_RADIUS * k;
  }
  const taper = 0.135 - 0.048 * Math.pow(h, 0.75);
  const breech = h < 0.04 ? -0.02 * (1 - h / 0.04) : 0;
  const band = (center: number, width: number, size: number): number =>
    Math.max(0, size * (1 - Math.abs(h - center) / width));
  const swell = h > 0.86 ? 0.022 * Math.sin(((h - 0.86) / 0.1) * Math.PI) : 0;
  return taper + breech + band(0.22, 0.05, 0.018) + band(0.58, 0.045, 0.014) + swell;
}

export function createCannon(materials: ShipMaterials, side: 1 | -1): CannonAssembly {
  // ---- Carreta: acompanha a travessia, mas não a elevação ----
  const carriage = createPartBuilders();
  const wheelRadius = 0.16;

  carriage.spar.addBox({ x: 0, y: 0.44, z: 0 }, { x: 0.72, y: 0.18, z: 1.2 }, 1.2);
  // Cunha de pontaria, sob a culatra.
  carriage.spar.addBox({ x: 0, y: 0.64, z: 0.42 }, { x: 0.3, y: 0.24, z: 0.34 }, 2);

  for (const sx of [1, -1]) {
    // **A ilharga é escalonada, e não um bloco.**
    //
    // O reparo naval tem esse perfil por necessidade: a peça é alta à frente,
    // onde sustenta os munhões, e vai baixando para a culatra, onde precisa
    // sobrar espaço para a cunha e para a mão de quem aponta. Modelada como uma
    // caixa única de 72 cm de altura, a carreta virava um caixote preto de onde
    // saía um cano — a leitura que a captura do convés dava, e a que menos
    // parece artilharia. Três degraus custam duas caixas a mais por bordo e
    // devolvem a silhueta que se reconhece de longe.
    carriage.spar.addBox({ x: sx * 0.26, y: 0.8, z: -0.26 }, { x: 0.11, y: 0.72, z: 0.5 }, 1.2);
    carriage.spar.addBox({ x: sx * 0.26, y: 0.68, z: 0.1 }, { x: 0.11, y: 0.48, z: 0.28 }, 1.2);
    carriage.spar.addBox({ x: sx * 0.26, y: 0.6, z: 0.38 }, { x: 0.11, y: 0.32, z: 0.32 }, 1.2);
    // Cinta de ferro na ilharga, onde a madeira é aparafusada ao eixo.
    carriage.iron.addBox({ x: sx * 0.265, y: 0.56, z: -0.36 }, { x: 0.125, y: 0.07, z: 0.28 }, 3);
    for (const sz of [1, -1]) {
      const start = carriage.iron.vertexCount;
      carriage.iron.addLathe({ x: 0, y: -0.045, z: 0 }, 0.09, () => wheelRadius, {
        radialSegments: 12,
        heightSegments: 1,
        capBottom: true,
        capTop: true,
        uvScale: 2,
      });
      // O torno gira em +Y; a roda precisa do eixo em X.
      carriage.iron.transformFrom(
        start,
        new THREE.Matrix4()
          .makeRotationZ(Math.PI * 0.5)
          .setPosition(sx * 0.37, wheelRadius, sz * 0.4),
      );
    }
  }

  // ---- Cano: gira em elevação em torno dos munhões ----
  const barrel = createPartBuilders();

  // Cano e botão da culatra saem do torno em pé; um transform só deita os dois,
  // e capturar o contador antes é o que evita depender de quantos vértices cada
  // peça gerou.
  // O UV é em metros, então `uvScale` decide de que tamanho o defeito de
  // fundição aparece na peça. Em 1,4 o ladrilho cobria 71 cm de cano e a
  // camada grossa do mapa de metal virava mancha de 9 cm: no zoom de mira, a
  // meio metro do olho, o cano lia como pedra-pomes em vez de ferro fundido.
  // Em 3 o ladrilho cai para 33 cm e o mesmo defeito fica na casa dos 4 cm,
  // que é a escala real da areia de fundição.
  const barrelStart = barrel.iron.vertexCount;
  barrel.iron.addLathe({ x: 0, y: 0, z: 0 }, BARREL_LENGTH, barrelProfile, {
    radialSegments: 18,
    heightSegments: 25,
    capBottom: true,
    capTop: true,
    uvScale: 3,
  });
  barrel.iron.addLathe(
    { x: 0, y: -0.17, z: 0 },
    0.18,
    (h) => 0.085 * Math.sin(Math.max(h, 0.08) * Math.PI) + 0.026,
    { radialSegments: 12, heightSegments: 6, capBottom: true },
  );
  barrel.iron.transformFrom(
    barrelStart,
    new THREE.Matrix4().makeRotationX(-Math.PI * 0.5).setPosition(0, 0, BREECH_OFFSET),
  );

  // Munhões: já nascem no eixo X, então ficam de fora da rotação acima.
  for (const sx of [1, -1]) {
    barrel.iron.addTube(
      new THREE.Vector3(sx * 0.1, 0, 0),
      new THREE.Vector3(sx * 0.25, 0, 0),
      0.072,
      0.068,
      10,
      3,
    );
  }
  // Ouvido: o furo de escorva, por onde a mecha acende a carga.
  //
  // A bucha é de latão de propósito (o bronze resiste melhor à erosão do fogo
  // que o ferro fundido), mas ela é a única peça amarela do cano e fica a menos
  // de um metro do olho no modo canhão — a versão anterior, de 6 cm de diâmetro
  // e 4,4 cm de saliência sobre um cano de raio 12,6 cm, lia como uma lasca
  // verde cravada na peça. Bucha de ouvido real mal passa dos 4 cm e é quase
  // rasante; com 12 lados ela também para de facetar nessa distância.
  barrel.brass.addTube(
    new THREE.Vector3(0, 0.1, 0.34),
    new THREE.Vector3(0, 0.142, 0.34),
    0.021,
    0.016,
    12,
    3,
  );

  // ---- Montagem ----
  const root = new THREE.Group();
  const traverse = new THREE.Group();
  const elevation = new THREE.Group();
  const muzzle = new THREE.Object3D();

  const halfWidth = deckHalfWidth(STATIONS.cannon);
  const x = side * (halfWidth - 0.5);
  root.name = side > 0 ? 'cannon-starboard' : 'cannon-port';
  root.position.set(x, DECK_Y + deckCamber(x, halfWidth) - 0.02, tToZ(STATIONS.cannon));
  // O -Z local aponta para o bordo correspondente: é a pose de repouso da peça,
  // e é o que faz a travessia em Y e a elevação em X significarem o esperado.
  root.rotation.y = side > 0 ? -Math.PI * 0.5 : Math.PI * 0.5;

  traverse.name = 'traverse';
  elevation.name = 'elevation';
  elevation.position.set(0, BARREL_AXIS_Y, 0);
  muzzle.name = 'muzzle';
  muzzle.position.set(0, 0, BREECH_OFFSET - BARREL_LENGTH);

  emitMeshes(carriage, materials, traverse);
  emitMeshes(barrel, materials, elevation);

  elevation.add(muzzle);
  traverse.add(elevation);
  root.add(traverse);
  return { root, traverse, elevation, muzzle };
}

/**
 * Leme: uma pá com perfil de fólio, atrás do cadaste. Gira em Y na própria madre.
 *
 * A pá é mais larga embaixo porque é lá que a água corre mais limpa, longe da
 * esteira do casco — e é essa área submersa que `Rudder` converte em torque.
 * A espessura vai a zero nas duas bordas, então os dois lados se encontram
 * sozinhos e não sobra costura para fechar.
 */
export function createRudder(materials: ShipMaterials): THREE.Group {
  const b = createPartBuilders();
  const { topY, bottomY, topChord, bottomChord, leadingEdge, rake, thickness: maxThickness } =
    RUDDER_BLADE;

  const heightSegments = 8;
  const chordSegments = 8;

  const face = (s: number, w: number, side: number): Vertex => {
    const y = bottomY + (topY - bottomY) * s;
    const chord = topChord * s + bottomChord * (1 - s);
    // O caimento leva o pé da pá para vante, debaixo da popa.
    const z = leadingEdge - rake * (1 - s) + w * chord;
    const thickness = maxThickness * Math.sin(Math.pow(w, 0.6) * Math.PI);
    return vertex(side * thickness, y, z, z * 0.7, y * 0.7);
  };

  // Um bordo de cada vez, como no casco: boreste precisa da orientação virada.
  for (const side of [1, -1]) {
    b.hull.addSurface(heightSegments, chordSegments, (s, w) => face(s, w, side), side > 0);
  }

  // Tampas de fundo e de topo, costurando os dois bordos.
  for (const s of [0, 1]) {
    const starboard: Vertex[] = [];
    const port: Vertex[] = [];
    for (let i = 0; i <= chordSegments; i++) {
      const w = i / chordSegments;
      starboard.push(face(s, w, 1));
      port.push(face(s, w, -1));
    }
    b.hull.addStrip(starboard, port, s === 1);
  }

  // Machos e fêmeas: as ferragens que prendem o leme ao cadaste. São três porque
  // a pá agora é alta, e duas deixariam o bordo de ataque visivelmente solto.
  for (const s of [0.12, 0.5, 0.88]) {
    const y = bottomY + (topY - bottomY) * s;
    const z = leadingEdge - rake * (1 - s) + 0.02;
    b.iron.addTube(
      new THREE.Vector3(-0.13, y, z),
      new THREE.Vector3(0.13, y, z),
      0.06,
      0.06,
      10,
      3,
    );
  }

  const group = new THREE.Group();
  group.name = 'rudder';
  group.position.set(0, 0, RUDDER_BLADE.postZ);
  emitMeshes(b, materials, group);
  return group;
}

/**
 * Âncora, pendurada no bordo de boreste da proa.
 *
 * Fica em grupo próprio porque `Anchor` a desce e a sobe — e porque, com ela no
 * fundo, é ela que fica parada enquanto o navio gira em volta.
 */
export function createAnchor(materials: ShipMaterials): THREE.Group {
  const b = createPartBuilders();

  // Haste, cepo e arganéu. A peça é construída no plano XY — braços abertos em
  // X — e o **grupo** é que a vira para o plano do costado. Ver a pose abaixo.
  b.iron.addTube(new THREE.Vector3(0, 0.95, 0), new THREE.Vector3(0, -0.5, 0), 0.055, 0.07, 10, 2);
  b.iron.addTube(
    new THREE.Vector3(-0.52, 0.78, 0),
    new THREE.Vector3(0.52, 0.78, 0),
    0.045,
    0.035,
    8,
    2,
  );
  b.iron.addTorusZ({ x: 0, y: 1.03, z: 0 }, 0.11, 0.028, 14, 6, 3);

  for (const side of [1, -1]) {
    b.iron.addTube(
      new THREE.Vector3(0, -0.48, 0),
      new THREE.Vector3(side * 0.5, -0.16, 0),
      0.065,
      0.035,
      8,
      2,
    );
    // Unha: a pá que morde o fundo.
    b.iron.addBox({ x: side * 0.57, y: -0.08, z: 0 }, { x: 0.26, y: 0.22, z: 0.055 }, 3);
  }

  const group = new THREE.Group();
  group.name = 'anchor';
  group.position.copy(ANCHOR_STOWED);
  // Um quarto de volta em Y: sem isso os braços apontam para dentro e para fora
  // do navio, e o de dentro atravessa o costado — a âncora nascia com metade
  // dela enfiada na proa. Virada, os braços correm ao longo do casco e a peça
  // fica deitada contra o costado, que é como uma âncora viaja.
  group.rotation.set(0, Math.PI * 0.5, -0.1);
  emitMeshes(b, materials, group);
  return group;
}

/**
 * Onde a âncora fica quando está a bordo — pendurada no turco, do lado de fora
 * do costado de boreste da proa.
 *
 * O X é medido do casco na altura em que ela pende, mais a folga da própria
 * peça: com a haste no eixo do grupo, a metade de dentro da âncora ocupa 12 cm,
 * e é essa distância que a mantém rente ao costado sem penetrá-lo.
 */
export const ANCHOR_STOWED = new THREE.Vector3(
  halfWidthAtHeight(0.9, 1.7) + 0.14,
  1.7,
  tToZ(0.9),
);

/**
 * Turco: a viga que avança da amurada e segura a âncora fora do costado.
 *
 * Existe por necessidade estrutural do modelo, não por enfeite: a âncora
 * pendurava do nada, e um ferro de 250 kg pendurado no ar a um palmo do casco é
 * exatamente o tipo de coisa que o olho registra como errada antes de saber por
 * quê.
 */
function buildCathead(b: PartBuilders): void {
  const z = ANCHOR_STOWED.z;
  const t = zToT(z);
  const railY = sheerAt(z) - 0.1;
  const inboard = halfWidthAtHeight(t, railY) - 0.35;

  b.spar.addBox(
    { x: (inboard + ANCHOR_STOWED.x) * 0.5, y: railY, z },
    { x: ANCHOR_STOWED.x - inboard + 0.3, y: 0.19, z: 0.22 },
    2,
  );
  // Escora diagonal, do costado à ponta do turco.
  b.spar.addTube(
    new THREE.Vector3(inboard, railY - 0.62, z),
    new THREE.Vector3(ANCHOR_STOWED.x, railY - 0.06, z),
    0.055,
    0.045,
    6,
    2,
  );
  // Gato de suspensão na ponta, de onde a âncora pende.
  b.iron.addTube(
    new THREE.Vector3(ANCHOR_STOWED.x, railY - 0.06, z),
    new THREE.Vector3(ANCHOR_STOWED.x, ANCHOR_STOWED.y + 0.95, z),
    0.022,
    0.022,
    7,
  );
}

/**
 * Bandeira do tope: a flâmula que corre no topo do mastro.
 *
 * Vale a geometria por um motivo de jogo, não de enfeite. A duzentos metros a
 * Chalupa é uma silhueta escura com um retângulo claro no meio, e as duas do
 * duelo são idênticas — a bandeira é a segunda coisa que se distingue depois da
 * cor do pano, e é a que se vê contra o céu mesmo quando a vela está de perfil.
 *
 * Usa o material da vela (e portanto o tingido de cada navio, ver `tintSail`),
 * então a bandeira do inimigo nasce carmim junto com o pano dele, de graça.
 */
export const ENSIGN_FRAME = {
  columns: 10,
  rows: 4,
  /** Comprimento do pano, da adriça à ponta. */
  length: 1.9,
  /** Altura junto à haste. */
  height: 0.62,
  /** Quanto a ponta afina — galhardete, não retângulo. */
  taper: 0.32,
  /** Altura do meio do pano. */
  y: MAST_TOP_Y - 0.35,
  z: MAST_Z + 0.06,
} as const;

/** Índice do nó `(i, j)` na grade da bandeira. `EnsignSim` usa o mesmo cálculo. */
export function ensignVertexIndex(i: number, j: number): number {
  return j * (ENSIGN_FRAME.columns + 1) + i;
}

/** Posição de repouso do nó `(i, j)`: o pano estendido reto para a popa. */
export function ensignRestPoint(i: number, j: number, target: THREE.Vector3): THREE.Vector3 {
  const { columns, rows, length, height, taper, y, z } = ENSIGN_FRAME;
  const u = i / columns;
  const v = j / rows;
  return target.set(0, y + (v - 0.5) * height * (1 - u * taper), z + u * length);
}

export function createEnsign(): THREE.BufferGeometry {
  const { columns, rows } = ENSIGN_FRAME;
  const positions = new Float32Array((columns + 1) * (rows + 1) * 3);
  const uvs = new Float32Array((columns + 1) * (rows + 1) * 2);
  const indices: number[] = [];
  const point = new THREE.Vector3();

  for (let j = 0; j <= rows; j++) {
    for (let i = 0; i <= columns; i++) {
      const index = ensignVertexIndex(i, j);
      // Nasce reta e sem ondulação nenhuma. A onda **é** a simulação agora
      // (`EnsignSim`): a versão anterior assava um seno na geometria e a
      // bandeira ficava com exatamente a mesma prega para sempre, em qualquer
      // vento, apontando para a popa mesmo com o vento vindo de lá.
      ensignRestPoint(i, j, point);
      positions[index * 3] = point.x;
      positions[index * 3 + 1] = point.y;
      positions[index * 3 + 2] = point.z;
      uvs[index * 2] = i / columns;
      uvs[index * 2 + 1] = j / rows;

      if (i < columns && j < rows) {
        const a = index;
        const b = index + 1;
        const c = index + columns + 2;
        const d = index + columns + 1;
        indices.push(a, b, c, a, c, d);
      }
    }
  }

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  geometry.setAttribute('uv', new THREE.BufferAttribute(uvs, 2));
  geometry.setIndex(indices);
  geometry.computeVertexNormals();
  return withAoUv(geometry);
}

// ---------------------------------------------------------------------------
// Vela
// ---------------------------------------------------------------------------

/** Índice do vértice `(i, j)` na grade da vela. `SailSim` usa o mesmo cálculo. */
export function sailVertexIndex(i: number, j: number): number {
  return j * (SAIL_FRAME.columns + 1) + i;
}

/**
 * Folga mínima entre a lona e o mastro, em Z, para uma dada altura e distância
 * do eixo.
 *
 * **É isto que fazia a vela parecer estar do lado errado.** O pano nasce no plano
 * do mastro, e a barriga vale zero nas quatro bordas — que são exatamente as
 * relingas presas à verga e à retranca. O resultado é que a metade superior e a
 * inferior do pano, no meio do vão, nasciam *dentro* do tronco: o mastro cortava
 * a lona ao meio e o que se via era meia vela de cada lado do pau, como se ela
 * estivesse enfiada ao contrário.
 *
 * A conta é a de sempre para tangenciar um cilindro: a que distância em Z é
 * preciso estar, a uma distância `x` do eixo, para ficar fora de um raio `r`.
 * Fora do raio devolve zero, e aí a barriga do vento manda sozinha.
 */
export function mastClearance(x: number, y: number): number {
  const radius = mastRadius(y) + 0.07;
  const distance = Math.abs(x);
  return distance >= radius ? 0 : Math.sqrt(radius * radius - distance * distance);
}

/** Posição de repouso do nó `(i, j)`, já com a barriga inicial. */
export function sailRestPoint(i: number, j: number, target: THREE.Vector3): THREE.Vector3 {
  const { columns, rows, halfWidth, topY, bottomY, z } = SAIL_FRAME;
  const u = i / columns;
  const v = j / rows;
  // Barriga: máxima no centro, zero nas bordas presas à verga e à retranca.
  const belly = Math.sin(u * Math.PI) * Math.sin(v * Math.PI) * 0.85;
  const x = (u * 2 - 1) * halfWidth;
  const y = topY + (bottomY - topY) * v - belly * 0.12;
  return target.set(x, y, z - Math.max(belly, mastClearance(x, y)));
}

/**
 * Grade da vela, pronta para `SailSim` mexer.
 *
 * Esta é a única peça do navio que **não** passa pelo `GeometryBuilder`: ele dá
 * quatro vértices próprios a cada quad, o que é exatamente o que se quer num
 * casco (quinas duras de graça) e exatamente o que não se quer num pano. Aqui os
 * vértices são compartilhados numa grade indexada `(columns+1) × (rows+1)`, por
 * dois motivos: o sombreamento sai suave em vez de facetado quad a quad, e o
 * simulador tem uma partícula por vértice em vez de quatro cópias do mesmo nó
 * para manter em sincronia.
 *
 * Já nasce com a barriga que o vento dá, então o navio parece certo mesmo antes
 * da física entrar.
 */
export function createSailGeometry(): THREE.BufferGeometry {
  const { columns, rows } = SAIL_FRAME;
  const vertexCount = (columns + 1) * (rows + 1);

  const positions = new Float32Array(vertexCount * 3);
  const uvs = new Float32Array(vertexCount * 2);
  const indices = new Uint16Array(columns * rows * 6);
  const point = new THREE.Vector3();

  for (let j = 0; j <= rows; j++) {
    for (let i = 0; i <= columns; i++) {
      const index = sailVertexIndex(i, j);
      sailRestPoint(i, j, point);
      positions[index * 3] = point.x;
      positions[index * 3 + 1] = point.y;
      positions[index * 3 + 2] = point.z;
      uvs[index * 2] = i / columns;
      uvs[index * 2 + 1] = j / rows;
    }
  }

  // Ordem escolhida para a normal sair apontando para a proa, o mesmo lado para
  // onde a barriga infla. (O pano é `DoubleSide` de qualquer forma, mas a normal
  // certa é o que faz o sol atravessá-lo pelo lado certo.)
  let cursor = 0;
  for (let j = 0; j < rows; j++) {
    for (let i = 0; i < columns; i++) {
      const a = sailVertexIndex(i, j);
      const b = sailVertexIndex(i + 1, j);
      const c = sailVertexIndex(i + 1, j + 1);
      const d = sailVertexIndex(i, j + 1);
      indices[cursor++] = a;
      indices[cursor++] = b;
      indices[cursor++] = c;
      indices[cursor++] = a;
      indices[cursor++] = c;
      indices[cursor++] = d;
    }
  }

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  geometry.setAttribute('uv', new THREE.BufferAttribute(uvs, 2));
  geometry.setIndex(new THREE.BufferAttribute(indices, 1));
  geometry.computeVertexNormals();
  return withAoUv(geometry);
}
