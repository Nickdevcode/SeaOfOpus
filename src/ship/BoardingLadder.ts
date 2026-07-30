/**
 * A escada de embarque: como se volta a bordo depois de cair no mar.
 *
 * Uma por bordo, na popa, ao lado do timão. Ela existe para **subir da água**, e
 * só para isso: descer é pular pelo portaló. Por isso ela nasce submersa e morre
 * no piso do tombadilho, sem parte nenhuma acima da amurada.
 *
 * Este módulo é a **fonte única** das medidas, no mesmo espírito de
 * `RUDDER_BLADE` e `MAST_LADDER`: a malha (`ShipParts.buildBoardingLadders`), o
 * alcance da interação e o passo de escalada do `PlayerController` leem daqui.
 * Ficou em arquivo próprio porque três coisas dependem dele — geometria, física
 * do jogador e o clipe do Blender — e nenhuma das três é dona das outras.
 *
 * ## As três amarras que ditam cada número
 *
 * 1. **O clipe manda no espaçamento.** `ClimbUp` sobe `CLIMB_CLIP.rise` por
 *    ciclo cobrindo *dois* enfrechates, então a única grade em que a mão cai na
 *    barra desenhada é a de `CLIMB_CLIP.rise / 2`. A escada do mastro chegou
 *    nesse número por arredondamento (tinha altura fixa a vencer); aqui a
 *    profundidade é livre, então usa-se o espaçamento **exato** e a base cai
 *    onde cair.
 * 2. **O casco manda na inclinação.** O bojo recolhe quase um metro entre o
 *    tombadilho e a linha d'água, então uma escada a prumo penduraria a base
 *    1,3 m fora do costado. Ela é inclinada — e como o clipe é de escada
 *    vertical, o corpo se inclina o mesmo ângulo (`tilt`), que é o que mantém a
 *    pegada casada: relativo ao corpo, a barra de cima volta a ficar
 *    exatamente acima.
 * 3. **A onda manda na profundidade.** A barra mais baixa tem de estar debaixo
 *    d'água mesmo na cava de uma onda grande, senão o nadador chega na escada e
 *    não tem onde pegar.
 */

import {
  QUARTERDECK_Y,
  halfWidthAtHeight,
  tToZ,
  zToT,
} from './ShipDimensions';
import { CLIMB_CLIP } from '../player/Locomotion';

/**
 * Estação da escada, em `t`.
 *
 * `STATIONS.helm` é 0,105 e a roda fica em z = +6,32: a escada sobe **no plano
 * do timão**, então quem volta a bordo já chega ao posto. O vão é livre nos dois
 * bordos: as colunas do toldo estão em z = +7,25 e +5,00 (`CANOPY_BLOCKERS`), os
 * degraus do tombadilho ficam a t ≈ 0,20 e os brandais de popa em z = +7,45.
 */
export const BOARDING_LADDER_T = 0.106;

/** Meia largura entre montantes. A mesma da escada do mastro, e pelo mesmo
 *  motivo: `anim_climb.RUNG_HALF_WIDTH` está gravado no clipe. */
export const BOARDING_LADDER_HALF_WIDTH = 0.24;

/**
 * Espaçamento entre barras: metade da subida de um ciclo do clipe.
 *
 * Não arredondar aqui é o que diferencia esta escada da do mastro — ver a nota
 * 1 no topo do arquivo.
 */
export const BOARDING_RUNG_SPACING = CLIMB_CLIP.rise / 2;

/** Quantos vãos a escada tem. Oito põe a barra de baixo a 69 cm da superfície
 *  de repouso do mar, fundo o bastante para a cava de uma onda grande não
 *  deixar o nadador sem pegada. */
export const BOARDING_RUNG_COUNT = 8;

/**
 * Quanto a escada recua na horizontal do topo até a base.
 *
 * É o número mais disputado da peça, e sai de um aperto entre duas coisas:
 * seguir o casco pediria 1,0 m de recuo (26° de prumo), e o clipe de escalada
 * pede o mínimo possível — o corpo se inclina o mesmo ângulo que a escada, e
 * uma escada muito deitada põe o personagem pendurado em vez de em pé. 0,61 m dá
 * **14,11°**, e é ele que decide onde a curva do bojo mais se aproxima da reta:
 * em y ≈ 1,33, que é onde a folga de `BOARDING_LADDER_CLEARANCE` é medida.
 */
export const BOARDING_LADDER_RUN = 0.61;

/** Raio do montante. A malha (`ShipParts`) desenha com ele, e a folga ao casco
 *  é resolvida a partir dele — é a madeira mais grossa da peça. */
export const BOARDING_STILE_RADIUS = 0.04;
/** Raio da barra. Igual ao enfrechate da escada do mastro. */
export const BOARDING_RUNG_RADIUS = 0.026;

/**
 * Folga mínima que a madeira da escada guarda do costado, em qualquer altura e
 * em **qualquer** das estações que ela ocupa.
 *
 * Quatro centímetros é pouco de propósito: é o bastante para o costado e a
 * escada nunca se interpenetrarem (nem com o casco desenhado em cordas de 18 cm,
 * que caem para dentro da curva analítica), e pouco o suficiente para não
 * empurrar a peça para fora do navio. Ver `BOARDING_LADDER_CLEARANCE`.
 */
export const BOARDING_LADDER_HULL_GAP = 0.04;

/**
 * Folga entre o plano dos degraus e o costado, medida no topo. **Calculada.**
 *
 * Era 8 cm, escolhido a mão, e 8 cm estava errado por um motivo que só aparece
 * quando se mede a escada como um objeto de 48 cm de largura em vez de um perfil:
 * **a folga não se mede na estação da escada, e sim na mais larga que ela toca.**
 * A popa afina 26 cm por metro de comprimento nessa faixa, então entre os dois
 * montantes (z = 6,06 e z = 6,54) o costado muda 12,6 cm de meia boca. Com 8 cm
 * o montante de vante ficava **5,7 cm dentro do casco** em y = 1,33 — e com ele
 * a ponta de vante de três barras. O perfil no plano dos degraus dava os 4,5 cm
 * anunciados; a peça inteira atravessava o costado.
 *
 * Por isso o número deixou de ser escolhido: `solveClearance` varre a largura da
 * escada e devolve o menor recuo que mantém `BOARDING_LADDER_HULL_GAP` em toda
 * ela. Hoje dá **17,7 cm**, que põe a barra de topo 18 cm fora do costado — daí a
 * soleira do portaló (`HullGeometry.buildGangways`) avançar até a barra de topo,
 * senão seria um vão de 18 cm entre o último degrau e o convés. O preço do plano reto
 * numa popa que recolhe um metro nessa faixa está na base: ela fica 79 cm fora do
 * costado, que é o que qualquer escada de popa de barco pequeno faz de verdade —
 * e o que deixa o nadador alcançá-la em água aberta em vez de debaixo do bojo.
 *
 * ⚠️ A conta ignora os cintados de propósito, e isso é uma **amarra com
 * `HullGeometry`**: `WALE_HEIGHTS` põe um em y = 1,02 avançando 5,5 cm da
 * madeira, e ele passa por dentro do vão da escada. Contá-lo empurraria a escada
 * outros 5,5 cm para fora do navio; a saída é a mesma que a braçola da escotilha
 * usa para deixar a escada do porão subir — **o cintado se interrompe no vão** —
 * e é `buildWales` que cumpre a parte dele. Tirar aquela interrupção sem mexer
 * aqui põe o montante dentro do cintado.
 */
export const BOARDING_LADDER_CLEARANCE = solveClearance();

/**
 * Distância do corpo ao plano dos degraus, medida na perpendicular.
 *
 * **Não é um número desta peça**, e por isso não é escrito aqui: quem dita é o
 * casaco do pirata, não a barra, e o mesmo afastamento vale para a escada do
 * mastro. Ele mora com o clipe que o gravou (`CLIMB_CLIP.standoff`) porque é de lá
 * que ele saiu — e enquanto a escada e o `PlayerController` tinham cada um a sua
 * cópia de 0,29, uma divergência entre as duas não reprovaria teste nenhum.
 */
export const BOARDING_LADDER_STANDOFF = CLIMB_CLIP.standoff;

/**
 * Meia largura do portaló — a abertura na amurada por onde se cai no mar.
 *
 * A escada não serve para descer, então a saída é esta: um vão no falcaseio, do
 * piso ao topo da amurada, largo o bastante para o jogador passar (o cilindro
 * dele tem 30 cm de raio) e estreito o bastante para não virar a maneira normal
 * de cair — quem passa por ali fez força para isso.
 */
export const BOARDING_GANGWAY_HALF_WIDTH = 0.42;

/** Uma escada de embarque, em números absolutos e no referencial do navio. */
export interface BoardingLadderSpec {
  /** +1 boreste, −1 bombordo. */
  readonly side: 1 | -1;
  /** Z local do plano dos degraus. */
  readonly z: number;
  /** Meia largura entre montantes. */
  readonly halfWidth: number;
  /** Altura da barra de topo, que coincide com o piso de saída. */
  readonly topY: number;
  /** Altura da barra mais baixa, submersa em água calma. */
  readonly bottomY: number;
  /** Espaçamento vertical entre barras. */
  readonly rungSpacing: number;
  /** Número de vãos (barras = vãos + 1). */
  readonly rungCount: number;
  /** `|x|` do plano dos degraus na barra de topo. */
  readonly topX: number;
  /** `|x|` do plano dos degraus na barra de baixo. */
  readonly bottomX: number;
  /** Inclinação do plano dos degraus em relação ao prumo, em radianos. */
  readonly tilt: number;
  /** Distância do corpo ao plano dos degraus, na perpendicular. */
  readonly standoff: number;
  /** Piso em que se termina a subida — o tombadilho. */
  readonly exitY: number;
  /** Meia largura do portaló, em Z. */
  readonly gangwayHalfWidth: number;
}

function makeSpec(side: 1 | -1): BoardingLadderSpec {
  const z = tToZ(BOARDING_LADDER_T);
  const topY = QUARTERDECK_Y;
  const bottomY = topY - BOARDING_RUNG_COUNT * BOARDING_RUNG_SPACING;
  const topX = halfWidthAtHeight(BOARDING_LADDER_T, topY) + BOARDING_LADDER_CLEARANCE;
  const bottomX = topX - BOARDING_LADDER_RUN;
  return {
    side,
    z,
    halfWidth: BOARDING_LADDER_HALF_WIDTH,
    topY,
    bottomY,
    rungSpacing: BOARDING_RUNG_SPACING,
    rungCount: BOARDING_RUNG_COUNT,
    topX,
    bottomX,
    tilt: Math.atan2(BOARDING_LADDER_RUN, topY - bottomY),
    standoff: BOARDING_LADDER_STANDOFF,
    exitY: QUARTERDECK_Y,
    gangwayHalfWidth: BOARDING_GANGWAY_HALF_WIDTH,
  };
}

/** As duas escadas: boreste primeiro, para casar com a ordem dos canhões. */
export const BOARDING_LADDERS: readonly BoardingLadderSpec[] = [
  makeSpec(1),
  makeSpec(-1),
];

/**
 * `|x|` do plano dos degraus na altura *y*, extrapolando fora da faixa.
 *
 * Extrapolar em vez de grampear é de propósito: o passo de escalada consulta
 * alturas ligeiramente fora das pontas (o corpo alcança a barra de topo vindo de
 * baixo dela) e um grampeamento poria um degrau em falso ali.
 */
export function boardingLadderX(spec: BoardingLadderSpec, y: number): number {
  const k = (spec.topY - y) / (spec.topY - spec.bottomY);
  return spec.topX - k * (spec.topX - spec.bottomX);
}

/**
 * Ponto do plano dos degraus na altura *y*, em coordenadas locais do navio.
 * Escreve em *out* para não alocar no passo de física.
 */
export function boardingLadderPoint(
  spec: BoardingLadderSpec,
  y: number,
  out: { x: number; y: number; z: number },
): { x: number; y: number; z: number } {
  out.x = spec.side * boardingLadderX(spec, y);
  out.y = y;
  out.z = spec.z;
  return out;
}

/**
 * Onde o corpo fica, em `|x|`, quando agarrado à escada na altura *y*.
 *
 * O afastamento é medido na **perpendicular** ao plano dos degraus, não na
 * horizontal: numa escada inclinada 14° as duas contas divergem 3 cm, e 3 cm é
 * a diferença entre a palma envolver a barra e passar ao lado dela.
 */
export function boardingLadderStandX(spec: BoardingLadderSpec, y: number): number {
  return boardingLadderX(spec, y) + spec.standoff * Math.cos(spec.tilt);
}

/** A escada do bordo em que *x* está. */
export function boardingLadderForSide(x: number): BoardingLadderSpec {
  return x >= 0 ? BOARDING_LADDERS[0]! : BOARDING_LADDERS[1]!;
}

/** Verdade quando *z* cai dentro do vão do portaló. */
export function insideGangway(z: number): boolean {
  const spec = BOARDING_LADDERS[0]!;
  return Math.abs(z - spec.z) <= spec.gangwayHalfWidth;
}

/** `t` da estação da escada, para quem precisa consultar o casco ali. */
export function boardingLadderT(): number {
  return zToT(BOARDING_LADDERS[0]!.z);
}

/**
 * O menor recuo que mantém a escada inteira a `BOARDING_LADDER_HULL_GAP` do
 * costado — ver `BOARDING_LADDER_CLEARANCE`.
 *
 * Varredura, e não bisseção: a restrição é uma desigualdade linear no recuo
 * (`x` do plano é o recuo menos uma parcela que só depende da altura), então o
 * mínimo viável é o **máximo** do que cada ponto exige, e isso se lê direto sem
 * iterar. Nove estações ao longo da largura, com o raio do montante nas duas
 * pontas e o da barra no meio: as pontas é que mandam, mas amostrar o meio custa
 * nada e cobre uma tabela de balizas futura em que o costado deixe de ser monótono
 * na largura da escada.
 *
 * Roda uma vez, no carregamento do módulo. As alturas param na barra de baixo
 * porque abaixo dela o costado só recolhe — o pedaço de montante que sobra
 * embaixo nunca é o pior caso.
 */
function solveClearance(): number {
  const topY = QUARTERDECK_Y;
  const bottomY = topY - BOARDING_RUNG_COUNT * BOARDING_RUNG_SPACING;
  const reference = halfWidthAtHeight(BOARDING_LADDER_T, topY);
  const stations = 8;
  const heights = 240;
  let needed = 0;

  for (let i = 0; i <= stations; i++) {
    const u = i / stations;
    const t = zToT(tToZ(BOARDING_LADDER_T) + (u * 2 - 1) * BOARDING_LADDER_HALF_WIDTH);
    const radius = i === 0 || i === stations ? BOARDING_STILE_RADIUS : BOARDING_RUNG_RADIUS;

    for (let j = 0; j <= heights; j++) {
      const y = bottomY + ((topY - bottomY) * j) / heights;
      // O plano dos degraus naquela altura é `recuo + reference - k * run`; o que
      // o casco exige ali é `casco + folga + raio`. Isolar o recuo dá isto.
      const k = (topY - y) / (topY - bottomY);
      const demand =
        halfWidthAtHeight(t, y) + BOARDING_LADDER_HULL_GAP + radius - reference + k * BOARDING_LADDER_RUN;
      if (demand > needed) needed = demand;
    }
  }

  return needed;
}
