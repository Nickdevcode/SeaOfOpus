/**
 * Rombos, alagamento e afundamento.
 *
 * O modelo é o do Sea of Thieves lido pelo lado da física de verdade, e o que o
 * torna interessante é que **nada aqui é uma barra de vida**. Um tiro abre um
 * furo numa posição do casco; a água entra por ele na vazão que a diferença de
 * pressão manda; o peso dessa água faz o navio calar mais fundo; calando mais
 * fundo, mais furos ficam submersos e a vazão cresce. O navio afunda quando
 * ninguém segura essa realimentação — não quando um contador chega a zero.
 *
 * **Superfície livre.** A água do porão é tratada como um volume com o topo
 * *horizontal no mundo*, e não como um peso morto no centro do navio. Ao adernar,
 * ela escorre para o bordo baixo e o peso vai junto, o que aderna mais. É o
 * efeito de superfície livre, o mesmo que emborca navio de verdade com o porão
 * pela metade, e ele cai de graça de tratar a água como volume em vez de número.
 *
 * A conta usa a mesma estrutura de colunas de `Buoyancy`, só que virada para
 * dentro: ali as colunas medem quanto casco está debaixo d'água, aqui medem
 * quanta água está dentro do casco. Ambas leem a mesma tabela de estações.
 *
 * **Escapou de propósito:** balde. Tirar água com balde exige item na mão, e o
 * escopo desta entrega não tem inventário — a bomba de porão faz o mesmo trabalho
 * com `F` segurado, que é o verbo que o resto do navio já usa.
 */

import * as THREE from 'three';
import { GRAVITY, WATER_DENSITY, clamp, clamp01 } from '../core/MathUtils';
import type { ShipBody } from './ShipBody';
import {
  DECK_Y,
  HOLD_FLOOR_Y,
  HULL_LENGTH,
  ceilingY,
  innerHalfWidthAt,
  tToZ,
} from './ShipDimensions';
import type { ShipHit } from '../combat/HitDetection';
import type { WaveField } from '../world/WaveField';

/** Estações do porão ao longo do comprimento. */
const LENGTH_SAMPLES = 8;
/** Faixas ao longo da boca: bombordo, centro, boreste. */
const WIDTH_SAMPLES = 3;
/** Níveis da tabela de volume por coluna. */
const LEVELS = 24;
/** Sub-passos da quadratura ao montar a tabela. */
const QUADRATURE = 6;

/**
 * Área efetiva de um rombo de bala, em m².
 *
 * Uma bala de 10 cm não abre um furo de 10 cm: ela estilhaça a tábua e leva
 * embora um pedaço de uns 30 cm de vão. O número é o do vão, não o da bala, e é
 * ele que decide o ritmo do jogo — dele sai a vazão de entrada de água.
 */
const BREACH_AREA = 0.055;

/**
 * Coeficiente de descarga de um furo de borda viva.
 *
 * A água que entra por um buraco irregular não usa a área toda: a veia contrai.
 * 0,62 é o valor clássico para orifício em parede fina, e é o que transforma
 * "área do furo" em vazão real.
 */
const DISCHARGE_COEFFICIENT = 0.62;

/**
 * Velocidade máxima da veia que entra por um rombo, em m/s.
 *
 * Torricelli não sabe que existe um casco: com o navio já afundando, a coluna
 * d'água sobre o furo passa de dois metros e a veia chegaria a 6 m/s, o que faz o
 * último segundo do naufrágio virar um degrau. Este teto é o pedaço de física que
 * falta — a resistência do próprio caminho da água pelo cavername — resumido num
 * número, e 3,81 m/s é a veia de uma coluna de 74 cm: acima disso, quem manda na
 * vazão é o caminho, não a pressão.
 *
 * O valor **não** é escolhido: é o teto antigo (130 L/s) convertido, ou seja
 * `0,13 / (DISCHARGE_COEFFICIENT × BREACH_AREA)`. Assim um rombo recém-aberto
 * entrega exatamente a mesma água de antes e nada do balanço já medido se mexe —
 * o que muda é só o que acontece quando ele **cresce**. Errar essa conversão
 * (esquecer o coeficiente de descarga, por exemplo) derruba a vazão de todos os
 * rombos submersos em 38% de uma vez, e o sintoma é um duelo que fica um minuto
 * mais longo sem nenhuma razão aparente.
 *
 * **Era um teto de vazão (0,13 m³/s por rombo) e virou um teto de velocidade, e a
 * diferença decide o jogo.** Fixo por rombo, ele dizia que um buraco do dobro do
 * tamanho bebe o mesmo que um buraco pequeno — ou seja, que alargar um rombo não
 * vale nada e só abrir buracos novos conta. A telemetria mostrou o preço disso:
 * oito acertos concentrados num palmo do costado punham 10% de água no porão,
 * enquanto os mesmos oito varridos ao longo do casco **afundavam o navio**. Quem
 * mirava melhor causava dez vezes menos dano.
 *
 * A resistência do cavername é por *área de passagem*, não por buraco: dois furos
 * lado a lado são dois caminhos, e um furo do dobro do tamanho também. Multiplicado
 * pela área, o teto passou a dizer isso — e alargar um rombo vale exatamente o que
 * a área dele diz.
 */
const MAX_JET_SPEED = 3.81;

/** Segundos de `F` segurado para pregar uma tábua sobre o rombo. */
const REPAIR_TIME = 2.4;

/**
 * Vazão da bomba de porão, em m³/s.
 *
 * **Este número estava errado por uma ordem de grandeza.** Eram 90 L/s — bomba
 * de mão honesta, e completamente fora de escala para um porão de 81 m³: dava
 * 0,11 ponto percentual por segundo, ou seja, o contador do HUD só mudava a
 * cada nove segundos de botão segurado e a lâmina baixava 1,8 mm por segundo.
 * O jogador segurava, olhava, e concluía — com razão — que a bomba não fazia
 * nada. O bug não era de código: era de aritmética.
 *
 * 750 L/s é quase um ponto percentual por segundo, o que dá meio minuto para
 * secar um porão a 30% e cento e poucos segundos para esvaziar tudo. Continua
 * sendo trabalho, e continua sendo perder tapar depois de bombear: um rombo novo
 * bem submerso entrega até 130 L/s (ver `MAX_JET_SPEED`), então **seis furos
 * abertos ainda enchem mais rápido do que a bomba tira** — e um rombo alargado
 * conta como vários. O que ela dá é o que sempre deveria ter dado: a chance de
 * recuperar um navio já tapado antes que o combate acabe.
 */
const PUMP_RATE = 0.75;

/**
 * Distância em que uma bala nova é absorvida por um rombo já existente.
 *
 * Sem isto, duas balas na mesma tábua abrem dois furos sobrepostos e o casco
 * ganha o dobro da vazão numa área que fisicamente só cabe um rombo.
 *
 * **Deixou de ser um número escolhido e passou a sair do próprio rombo.** Estava
 * cravado em 90 cm — três vezes e meia o vão que um tiro abre —, e era isso que
 * fazia oito acertos bem agrupados renderem menos de dois rombos: o costado de 16 m
 * comportava só onze posições distintas, e a mira de um jogador que corrige a
 * pontaria cabe inteira dentro de uma delas. A precisão virava punição.
 *
 * O vão de `BREACH_AREA` é um círculo de 26 cm. Dois tiros abrem o mesmo buraco
 * quando os vãos se tocam, e o fator 1,6 é a folga da madeira trincada entre eles —
 * o que sobra de tábua entre dois furos a meio metro um do outro não segura água.
 * Amarrado à área, o dia em que o vão de um rombo mudar traz a fusão junto.
 */
export const MERGE_DISTANCE = 2 * Math.sqrt(BREACH_AREA / Math.PI) * 1.6;

/**
 * Distância em que um tiro arranca uma tábua já pregada.
 *
 * Maior que `MERGE_DISTANCE` porque a tábua é uma peça de 1,15 m atravessada
 * sobre o furo: uma bala que bate a um metro do centro do rombo ainda pega
 * madeira. Menor que o meio comprimento dela porque acertar a ponta que sobra
 * não deveria abrir o casco de novo.
 */
const PATCH_DISTANCE = 1.1;

/**
 * Tábuas pregadas que o casco guarda ao mesmo tempo.
 *
 * O mesmo teto do desenho dos rombos, e pelo mesmo motivo. Estourá-lo aposenta
 * a tábua mais antiga — que, numa partida em que já se pregaram vinte e quatro,
 * está num pedaço de casco que ninguém está olhando.
 */
const MAX_PATCHES = 24;

/**
 * Quanto um rombo pode crescer ao absorver outros tiros.
 *
 * Subiu de 2,2 quando o teto de vazão passou a escalar com a área
 * (`MAX_JET_SPEED`): enquanto alargar não valia nada, o número dava no mesmo;
 * valendo, ele vira o limite de quantos acertos no mesmo palmo ainda contam. Em
 * 3,2 são quatro tiros absorvidos antes de saturar (cada um soma 0,6 da área base)
 * — daí em diante o que a bala arranca é cavername, e casco sem caverna não é mais
 * um rombo, é outra avaria, que este arquivo não modela.
 */
const MAX_BREACH_SCALE = 3.2;

/**
 * Fração do porão cheia que conta como perdido.
 *
 * Não é 1: com o porão em 92% a água já está passando por cima do vau e o navio
 * não volta mais. Esperar o último por cento só atrasaria o fim da partida.
 */
const FATAL_FLOOD = 0.92;

/** Segundos entre "está afundando" e "afundou", para o naufrágio ser visto. */
const SINK_DURATION = 7;

/**
 * Água embarcada **acima do porão** no fim do naufrágio, em kg.
 *
 * Sem este termo o navio não afunda, e vale a conta: o casco desloca ~37 t na
 * linha d'água de projeto e algo perto de 74 t completamente submerso. Com o porão
 * cheio (~28 t de água) o total chega a 65 t — ainda **menos** que o empuxo
 * disponível. O navio ficaria flutuando com a borda na água para sempre, e
 * `sinkTime` contaria sete segundos sem nada acontecer na tela.
 *
 * O que falta na física não é um empurrão inventado: é que a 92% de porão o
 * trincaniz já está na água e o mar passa **por cima do convés**, pela escotilha e
 * pelas portinholas. Daí em diante enche o casco inteiro, não só o porão — e é
 * isso que este número representa. 45 t levam o conjunto a ~110 t contra 74 t de
 * empuxo, e o navio vai ao fundo com convicção.
 *
 * O peso entra no **centro de massa**, e não no centróide da água do porão. Não é
 * preguiça: 45 t no braço de 2 m que o centróide alcança dariam 900 kN·m contra os
 * ~323 kN·m/rad de momento de endireitamento, ou seja, emborcaria o navio em
 * menos de um segundo. Um naufrágio real às vezes emborca mesmo, mas aqui o
 * resultado na tela seria um casco capotando como brinquedo. No centro de massa, a
 * banda continua vindo do efeito de superfície livre do porão, que já é o
 * mecanismo certo — só mais fundo a cada segundo.
 */
const SWAMP_MASS = 45000;

/**
 * Vazão que entra por um rombo, em m³/s.
 *
 * Pura, e exportada, porque é **a** conta do modelo de avaria: é ela que decide se
 * um casco furado em cinco lugares afunda ou aguenta, e é a única coisa aqui dentro
 * que dá para provar num teste sem montar um navio. Ver `tests/damage.ts`.
 *
 * A propriedade que ela precisa ter, e que já faltou: **ser linear na área.** Um
 * rombo do dobro do tamanho bebe o dobro, inclusive depois de a veia saturar — é
 * isso que faz dois acertos no mesmo palmo de costado valerem dois acertos.
 *
 * @param area área efetiva de entrada, em m².
 * @param depth coluna d'água sobre o rombo, em metros. Zero ou menos não bebe.
 */
export function breachInflow(area: number, depth: number): number {
  if (depth <= 0) return 0;
  // Torricelli, até onde o caminho pelo cavername deixa. Ver `MAX_JET_SPEED`.
  const speed = Math.min(Math.sqrt(2 * GRAVITY * depth), MAX_JET_SPEED);
  return DISCHARGE_COEFFICIENT * area * speed;
}

export interface Breach {
  /** Centro do rombo, em coordenadas locais do navio. */
  readonly local: THREE.Vector3;
  /** Normal externa do casco ali — orienta a tábua e o esguicho. */
  readonly normal: THREE.Vector3;
  /** Área efetiva de entrada de água, em m². */
  area: number;
  /** 0..1 do reparo em andamento. Chega a 1 e o rombo some da lista. */
  repair: number;
  /** Vazão de entrada agora, em m³/s. O visual do esguicho lê daqui. */
  inflow: number;
  /** Identificador estável, para o visual casar com o rombo entre frames. */
  readonly id: number;
}

/**
 * Uma tábua pregada sobre um rombo que já foi fechado.
 *
 * Ela **não** faz física nenhuma: um rombo tapado sai de `breaches` e deixa de
 * entrar água, e é isso que resolve o alagamento. Isto aqui existe para o casco
 * ter memória do estrago — a tábua fica pregada onde estava o buraco, e uma
 * bala nova no mesmo lugar a arranca e reabre o rombo do tamanho que ele tinha.
 *
 * É a mesma leitura do Sea of Thieves: um navio no fim de um combate longo é
 * uma colcha de retalhos, e a colcha conta a história melhor que qualquer
 * contador de vida.
 */
export interface Patch {
  /** Centro do rombo tapado, em coordenadas locais do navio. */
  readonly local: THREE.Vector3;
  /** Normal externa do casco ali — a tábua se deita contra ela. */
  readonly normal: THREE.Vector3;
  /**
   * Área do rombo que esta tábua fechou, em m².
   *
   * Guardada porque é ela que volta quando a tábua é arrancada: quem tapou um
   * rombo alargado por três balas não recomeça de um furo pequeno.
   */
  readonly area: number;
  /** Identificador estável, e a semente do sorteio da pose da tábua. */
  readonly id: number;
}

interface HoldColumn {
  /** X local do eixo da coluna. */
  x: number;
  z: number;
  yFloor: number;
  yCeiling: number;
  /** Volume d'água (m³) com a superfície em cada nível. */
  volume: Float32Array;
  centroidX: Float32Array;
  centroidY: Float32Array;
}

const _worldPoint = new THREE.Vector3();
const _centroid = new THREE.Vector3();
const _force = new THREE.Vector3();
const WORLD_UP = new THREE.Vector3(0, 1, 0);

export class ShipDamage {
  readonly breaches: Breach[] = [];
  /** Tábuas pregadas, da mais antiga para a mais nova. Ver `Patch`. */
  readonly patches: Patch[] = [];

  /** Água no porão, em m³. */
  floodVolume = 0;
  /** Capacidade total do porão, em m³. Medida da geometria, não escolhida. */
  readonly holdVolume: number;

  /**
   * Offset do plano d'água interno no referencial local: os pontos da superfície
   * satisfazem `p · localUp = waterPlane`. Guardado porque o visual da água do
   * porão desenha exatamente este plano.
   */
  waterPlane = -Infinity;

  /** Segundos desde que o naufrágio começou; `0` enquanto o navio está vivo. */
  sinkTime = 0;

  /** Ligado por quem estiver na bomba neste passo. Zera todo passo. */
  pumping = false;

  /** Água acima do convés durante o naufrágio, em kg. Ver `SWAMP_MASS`. */
  private swampMass = 0;

  /**
   * Próximo identificador de rombo **deste casco**.
   *
   * Era um contador de módulo, partilhado pelos dois navios da partida — e com um
   * contador só, os ids que cada casco recebe passam a depender da ordem em que
   * os dois foram atingidos. Isso quebra duas coisas de uma vez: a decalcomania
   * do estrago sorteia a aparência a partir do id (`DamageView.hash01`), então um
   * mesmo tiro desenhava um buraco diferente conforme o que tivesse acontecido do
   * outro lado; e, em rede, dois clientes que recebam os eventos em ordens
   * ligeiramente diferentes divergem para sempre. Por instância, o id de um rombo
   * é função só do próprio navio.
   */
  private nextBreachId = 1;

  private readonly columns: HoldColumn[] = [];
  /**
   * Vertical do mundo no referencial do navio, do último passo. É por instância
   * (e não rascunho de módulo) porque os dois navios da partida alternam passos e
   * o visual lê isto fora do `fixedUpdate`.
   */
  private readonly localUp = new THREE.Vector3(0, 1, 0);

  constructor() {
    const dz = HULL_LENGTH / LENGTH_SAMPLES;
    let total = 0;

    for (let i = 0; i < LENGTH_SAMPLES; i++) {
      const t = (i + 0.5) / LENGTH_SAMPLES;
      const z = tToZ(t);

      for (let j = 0; j < WIDTH_SAMPLES; j++) {
        const xFraction = ((j + 0.5) / WIDTH_SAMPLES) * 2 - 1;

        // O eixo da coluna acompanha o forro na altura média do porão — é onde a
        // água passa a maior parte do tempo, e é o X que o plano d'água usa.
        const midHeight = (HOLD_FLOOR_Y + DECK_Y) * 0.5;
        const x = innerHalfWidthAt(t, midHeight) * xFraction;
        const yCeiling = ceilingY(t, x);
        const span = yCeiling - HOLD_FLOOR_Y;
        if (span <= 0) continue;

        const volume = new Float32Array(LEVELS + 1);
        const centroidX = new Float32Array(LEVELS + 1);
        const centroidY = new Float32Array(LEVELS + 1);

        let accumulated = 0;
        let momentX = 0;
        let momentY = 0;

        for (let level = 1; level <= LEVELS; level++) {
          const yLow = HOLD_FLOOR_Y + (span * (level - 1)) / LEVELS;
          const dy = span / LEVELS / QUADRATURE;

          for (let q = 0; q < QUADRATURE; q++) {
            const y = yLow + dy * (q + 0.5);
            const halfWidth = innerHalfWidthAt(t, y);
            const cellVolume = ((halfWidth * 2) / WIDTH_SAMPLES) * dy * dz;
            accumulated += cellVolume;
            momentX += halfWidth * xFraction * cellVolume;
            momentY += y * cellVolume;
          }

          volume[level] = accumulated;
          centroidX[level] = accumulated > 0 ? momentX / accumulated : x;
          centroidY[level] = accumulated > 0 ? momentY / accumulated : HOLD_FLOOR_Y;
        }

        centroidX[0] = x;
        centroidY[0] = HOLD_FLOOR_Y;

        this.columns.push({ x, z, yFloor: HOLD_FLOOR_Y, yCeiling, volume, centroidX, centroidY });
        total += accumulated;
      }
    }

    this.holdVolume = total;
  }

  /** Fração do porão alagada, 0..1 — o que o HUD desenha. */
  get floodFraction(): number {
    return clamp01(this.floodVolume / this.holdVolume);
  }

  /** `true` do instante em que o navio passa do ponto de retorno. */
  get isSinking(): boolean {
    return this.sinkTime > 0;
  }

  /** `true` quando o naufrágio terminou e o navio saiu da partida. */
  get isSunk(): boolean {
    return this.sinkTime >= SINK_DURATION;
  }

  /**
   * Registra um impacto. Só o que entra abaixo do convés vira rombo — tiro na
   * amurada arranca lasca e nada mais, como no jogo.
   *
   * @returns o rombo afetado, novo ou alargado, ou `null` se o tiro não alaga.
   */
  registerHit(hit: ShipHit): Breach | null {
    if (!hit.floods || hit.part !== 'hull') return null;

    const existing = this.findNear(hit.local);
    if (existing) {
      // Tiro em cima de rombo aberto: alarga em vez de duplicar.
      existing.area = Math.min(existing.area + BREACH_AREA * 0.6, BREACH_AREA * MAX_BREACH_SCALE);
      existing.repair = 0;
      return existing;
    }

    // Tiro em cima de tábua pregada: arranca a tábua e devolve o rombo que ela
    // fechava. O reparo era um remendo, e um remendo é a parte fraca do casco —
    // é por isso que ele volta do tamanho que tinha, e não do tamanho de um
    // furo novo.
    const patch = this.findPatchNear(hit.local);
    if (patch) this.patches.splice(this.patches.indexOf(patch), 1);

    const breach: Breach = {
      local: hit.local.clone(),
      normal: hit.normal.clone(),
      area: patch ? patch.area : BREACH_AREA,
      repair: 0,
      inflow: 0,
      id: this.nextBreachId++,
    };
    this.breaches.push(breach);
    return breach;
  }

  /** O rombo mais próximo de um ponto local dentro do alcance de reparo. */
  findNear(local: THREE.Vector3, radius = MERGE_DISTANCE): Breach | null {
    let best: Breach | null = null;
    let bestDistance = radius;

    for (const breach of this.breaches) {
      const distance = breach.local.distanceTo(local);
      if (distance < bestDistance) {
        bestDistance = distance;
        best = breach;
      }
    }
    return best;
  }

  /** A tábua pregada mais próxima de um ponto local, ou `null`. */
  findPatchNear(local: THREE.Vector3, radius = PATCH_DISTANCE): Patch | null {
    let best: Patch | null = null;
    let bestDistance = radius;

    for (const patch of this.patches) {
      const distance = patch.local.distanceTo(local);
      if (distance < bestDistance) {
        bestDistance = distance;
        best = patch;
      }
    }
    return best;
  }

  /**
   * Prega tábua num rombo. Chamar a cada frame enquanto o `F` estiver segurado.
   *
   * **Idempotente por construção.** Um rombo que já saiu da lista não aceita
   * mais trabalho, e o progresso nunca passa de 1. As duas coisas faltavam, e o
   * que se via na tela era a consequência exata: o rombo fechava, quem estava
   * segurando o botão continuava alimentando o mesmo objeto — que ainda existia,
   * porque a peça interativa segurava a referência — e o prompt subia a 200%,
   * 300%, sem teto e sem nada acontecer no casco.
   *
   * @returns `true` **só** no frame em que o rombo fecha, e nunca depois. É esse
   *   contrato que permite a quem chama largar o alvo na hora certa.
   */
  repair(breach: Breach, dt: number): boolean {
    const index = this.breaches.indexOf(breach);
    if (index < 0) return false;

    breach.repair = clamp01(breach.repair + dt / REPAIR_TIME);
    if (breach.repair < 1) return false;

    this.breaches.splice(index, 1);

    // A tábua herda o `id` do rombo, e não um contador próprio: é ele que
    // semeia o sorteio da pose no desenho, então a tábua fica no mesmo lugar
    // quadro após quadro em vez de tremer.
    this.patches.push({
      local: breach.local.clone(),
      normal: breach.normal.clone(),
      area: breach.area,
      id: breach.id,
    });
    if (this.patches.length > MAX_PATCHES) this.patches.shift();

    return true;
  }

  /**
   * Um passo de alagamento.
   *
   * A ordem é: entra água pelos rombos, sai água pela bomba, o volume vira um
   * plano d'água, e o plano vira peso aplicado no centróide.
   */
  fixedUpdate(dt: number, body: ShipBody, waves: WaveField): void {
    body.worldDirToLocal(WORLD_UP, this.localUp);
    // Zerado aqui e reescrito só se houver água: senão o porão esgotado
    // continuaria pesando o valor do passo anterior para sempre.
    body.floodedMass = 0;

    let inflow = 0;
    for (const breach of this.breaches) {
      body.localToWorld(breach.local, _worldPoint);
      const depth = waves.sampleHeight(_worldPoint.x, _worldPoint.z) - _worldPoint.y;

      // Rombo fora d'água não bebe nada — é por isso que adernar para o bordo são
      // é manobra, e não estética. `breachInflow` cobre esse caso.
      breach.inflow = breachInflow(breach.area, depth);
      inflow += breach.inflow;
    }

    if (this.pumping) inflow -= PUMP_RATE;
    this.pumping = false;

    this.floodVolume = clamp(this.floodVolume + inflow * dt, 0, this.holdVolume);

    if (this.floodVolume <= 1e-4) {
      this.waterPlane = -Infinity;
      this.updateSinking(dt, body);
      return;
    }

    this.waterPlane = this.solvePlane(this.floodVolume, this.localUp);
    const volume = this.sampleAtPlane(this.waterPlane, this.localUp, _centroid);
    if (volume <= 1e-6) {
      this.updateSinking(dt, body);
      return;
    }

    // O peso da água é vertical no mundo e cai no centróide do volume — que fica
    // do lado para onde o navio já está adernando. É esse braço que faz o efeito
    // de superfície livre existir.
    body.localToWorld(_centroid, _worldPoint);
    _force.set(0, -WATER_DENSITY * GRAVITY * volume, 0);
    body.applyForceAtPoint(_force, _worldPoint);

    // A água também vai junto na aceleração: sem isto o navio alagado ficaria
    // *mais* ágil, porque ganharia peso sem ganhar massa.
    body.floodedMass = WATER_DENSITY * volume;

    this.updateSinking(dt, body);
  }

  /** Zera tudo — usado no respawn e ao montar uma partida nova. */
  reset(): void {
    this.breaches.length = 0;
    this.patches.length = 0;
    this.floodVolume = 0;
    this.waterPlane = -Infinity;
    this.sinkTime = 0;
    this.pumping = false;
    this.swampMass = 0;
  }

  /**
   * Altura da água do porão no eixo central, em coordenadas locais.
   * O visual da lâmina d'água usa isto para se posicionar. `-Infinity` quando
   * não há água.
   */
  getWaterHeightAtCenter(): number {
    if (!Number.isFinite(this.waterPlane)) return -Infinity;
    return this.waterPlane / Math.max(this.localUp.y, 0.2);
  }

  /**
   * Altura no mundo da superfície da água do porão, ou `-Infinity` se o porão
   * está seco.
   *
   * Sai da definição do plano: os pontos da superfície satisfazem `p·up = H`, e
   * a altura de um ponto local no mundo é `(p − com)·up + comPosition.y`. Juntar
   * as duas elimina `p` e sobra uma conta de três termos.
   */
  getWorldSurfaceY(body: ShipBody): number {
    if (!Number.isFinite(this.waterPlane)) return -Infinity;
    return this.waterPlane - body.centerOfMass.dot(this.localUp) + body.comPosition.y;
  }

  /**
   * Avança o naufrágio e, se ele já começou, embarca a água que passa por cima do
   * convés — o termo que de fato leva o navio ao fundo (ver `SWAMP_MASS`).
   */
  private updateSinking(dt: number, body: ShipBody): void {
    if (this.sinkTime <= 0) {
      if (this.floodFraction >= FATAL_FLOOD) this.sinkTime = 1e-4;
      return;
    }

    this.sinkTime = Math.min(this.sinkTime + dt, SINK_DURATION);

    // Cresce com o quadrado do tempo: o convés entra na água devagar e, quando a
    // borda passa, a vazão dispara. É a mesma realimentação do resto do arquivo —
    // quanto mais fundo, mais rápido — e é o que faz o último segundo do naufrágio
    // ser o rápido, em vez de o navio descer numa rampa constante.
    const progress = clamp01(this.sinkTime / SINK_DURATION);
    this.swampMass = SWAMP_MASS * progress * progress;

    _force.set(0, -this.swampMass * GRAVITY, 0);
    body.applyForce(_force);
    // Somada à inércia também: um casco cheio de água não só afunda, ele fica
    // pesado de mexer. É o que tira a resposta do leme nos últimos segundos.
    body.floodedMass += this.swampMass;
  }

  /**
   * Acha o plano d'água que contém exatamente `target` de volume.
   *
   * Bisseção porque a relação entre nível e volume não tem inversa fechada — a
   * seção do porão muda com a altura *e* com a inclinação do navio. Vinte voltas
   * sobre uma faixa de 7 m dão precisão de micrômetros, e cada volta custa uma
   * varredura das 24 colunas.
   */
  private solvePlane(target: number, up: THREE.Vector3): number {
    let low = -4;
    let high = 4;

    for (let i = 0; i < 20; i++) {
      const mid = (low + high) * 0.5;
      if (this.sampleAtPlane(mid, up, null) < target) low = mid;
      else high = mid;
    }

    return (low + high) * 0.5;
  }

  /**
   * Volume d'água abaixo do plano `p · up = offset`, e o centróide dele.
   *
   * Cada coluna cruza o plano numa altura própria: `y = (offset − x·upX − z·upZ)
   * / upY`. É essa dependência de `x` que põe mais água no bordo baixo quando o
   * navio aderna.
   */
  private sampleAtPlane(offset: number, up: THREE.Vector3, centroid: THREE.Vector3 | null): number {
    // Emborcado, `upY` tende a zero e a divisão explode. O piso mantém a conta
    // finita; a essa altura o navio já está perdido de qualquer forma.
    const upY = Math.max(up.y, 0.2);

    let total = 0;
    let momentX = 0;
    let momentY = 0;
    let momentZ = 0;

    for (const column of this.columns) {
      const crossing = (offset - column.x * up.x - column.z * up.z) / upY;
      const span = column.yCeiling - column.yFloor;
      if (crossing <= column.yFloor) continue;

      const position = clamp(((crossing - column.yFloor) / span) * LEVELS, 0, LEVELS);
      const index = Math.min(Math.floor(position), LEVELS - 1);
      const fraction = clamp01(position - index);

      const a = column.volume[index]!;
      const volume = a + (column.volume[index + 1]! - a) * fraction;
      if (volume <= 0) continue;

      total += volume;
      if (!centroid) continue;

      const cx = column.centroidX[index]!;
      const cy = column.centroidY[index]!;
      momentX += (cx + (column.centroidX[index + 1]! - cx) * fraction) * volume;
      momentY += (cy + (column.centroidY[index + 1]! - cy) * fraction) * volume;
      momentZ += column.z * volume;
    }

    if (centroid) {
      if (total > 1e-6) centroid.set(momentX / total, momentY / total, momentZ / total);
      else centroid.set(0, HOLD_FLOOR_Y, 0);
    }

    return total;
  }
}
