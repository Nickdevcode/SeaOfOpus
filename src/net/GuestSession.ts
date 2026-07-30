/**
 * O lado que não simula.
 *
 * O guest **não integra casco nenhum**: nem empuxo, nem vela, nem leme, nem
 * contato. Ele recebe a pose pronta, interpola entre dois instantâneos e desenha.
 * O que ele simula localmente é só o próprio corpo no convés — e é isso que faz
 * este modelo funcionar sem rollback.
 *
 * ## Por que dá para prever o corpo sem prever o navio
 *
 * Porque `PlayerController` vive em **coordenadas locais do navio**. O convés é
 * um chão parado: andar nele não depende de onda, de vela nem de rumo. O casco é
 * só um referencial que chega pela rede, e o corpo anda por cima dele sem saber
 * de nada. É a decisão de arquitetura que este arquivo inteiro aproveita, e ela
 * foi tomada muito antes de existir rede — por causa da câmera.
 *
 * ## Três relógios
 *
 * - **O do host** (`hostTick`), que chega nos instantâneos. É a verdade.
 * - **O de desenho**, `hostTick − INTERP_DELAY`. Fica para trás de propósito:
 *   é o atraso que dá dois instantâneos entre os quais interpolar. Sem ele, o
 *   cliente estaria sempre extrapolando, e extrapolação em rede ruim é o que
 *   produz navio tremendo e depois corrigindo.
 * - **O de predição**, `hostTick + lead`. É onde o corpo local corre, à frente,
 *   para que a entrada chegue ao host no instante em que ele precisa dela.
 *
 * O terceiro é o único ajustável, e ele se ajusta sozinho por `bufferDepth`.
 */

import * as THREE from 'three';
import { FIXED_TIMESTEP } from '../core/Engine';
import { wrapAngle } from '../core/MathUtils';
import type { InputFrame } from '../core/InputFrame';
import type { Match } from '../game/Match';
import type { PlayerStation } from '../player/PlayerController';
import type { Ship } from '../ship/Ship';
import { BALL_MASS, BALL_RADIUS, MUZZLE_SPEED } from '../ship/Cannon';
import { breachInflow } from '../ship/ShipDamage';
import { encodeInput } from './snapshotCodec';
import { InputOutbox } from './InputOutbox';
import { advanceHostEstimate, correctHostEstimate, interpolationFactor } from './renderClock';
import { createWorldState, decodeSnapshot, type WorldState } from './WorldState';
import type { RoomClient } from './RoomClient';

/**
 * Passos entre instantâneos. É o `SNAPSHOT_EVERY` de `HostSession`, visto daqui.
 *
 * Duplicado de propósito: quem simula decide a taxa e quem desenha precisa
 * saber dela para se atrasar exatamente o necessário. Se um dia a taxa mudar,
 * mudam os dois.
 */
const SNAPSHOT_INTERVAL = 4;

/**
 * Atraso de desenho, em passos.
 *
 * ⚠️ **Um intervalo exato, e não mais.** Era seis — uma vez e meia o intervalo,
 * pensando em folga para o jitter —, e o resultado era o oposto do pretendido:
 * com dois instantâneos em mão, o mais antigo está `SNAPSHOT_INTERVAL` passos
 * atrás do mais novo, então um alvo seis passos atrás cai **antes do primeiro
 * dos dois**. O fator de interpolação vivia grampeado em zero, a pose ficava
 * congelada no instantâneo anterior e só saltava quando chegava o seguinte. Ou
 * seja: o mundo inteiro do guest — o casco dele, o convés sob os pés dele e a
 * câmera junto — andava a quinze quadros por segundo, aos trancos, num jogo que
 * desenhava a cento e quarenta e quatro.
 *
 * Com um intervalo exato, o relógio de desenho entra em `from` no instante em
 * que o par é montado e chega a `to` bem quando o próximo par chega. A folga de
 * jitter não vem mais de atrasar o desenho: vem do grampo em 1, que **congela**
 * na última pose conhecida enquanto o pacote atrasado não chega, em vez de
 * extrapolar. Congelar por vinte milissegundos não se vê; extrapolar, sim.
 */
const INTERP_DELAY = SNAPSHOT_INTERVAL;

// A aritmética do relógio de desenho mora em `renderClock`, onde ela pode ser
// provada sem arrastar Three.js e o `Match` para dentro de um teste.

/** Um lote de entrada a cada dois passos: 30 mensagens por segundo. */
const SEND_EVERY = 2;

/**
 * Fundo de fila que se quer manter no host, em quadros.
 *
 * Um quadro é o amortecedor mínimo: com ele, um pacote que atrase até um passo
 * inteiro ainda encontra o que consumir. Dois seriam mais seguros e custariam
 * 17 ms de latência de comando a mais o tempo todo — e a segurança que eles
 * comprariam já é comprada de graça pela redundância do lote, que reenvia cada
 * quadro duas vezes. Ver `adjustLead`.
 */
const DEPTH_TARGET = 1;

/**
 * Limites do avanço, em passos.
 *
 * O piso não é zero porque um avanço nulo significa carimbar o comando com o
 * tick que o host já consumiu — ele nasceria descartado. O teto existe porque
 * avanço é latência de comando: vinte e quatro passos são 400 ms entre a mão e o
 * convés, e daí em diante o problema já não é de sincronia, é de conexão.
 */
const LEAD_MIN = 3;
const LEAD_MAX = 24;

/** Fração do desvio do leme corrigida por instantâneo. Ver `applyShipParts`. */
const WHEEL_CATCHUP = 0.08;

/** Fração do desvio da mira corrigida por instantâneo. Ver `correctOperatedAim`. */
const AIM_CATCHUP = 0.12;

/**
 * Intervalo entre ajustes do avanço, em passos. Meio segundo.
 *
 * Era de dois segundos, e servia enquanto o avanço tinha de **descobrir** a
 * latência subindo de um em um. Agora ele nasce medido (ver `estimateLead`) e
 * este ajuste só persegue deriva, então pode ser mais frequente sem ficar
 * inquieto — cada mudança de avanço é um pulinho no relógio de quem joga.
 */
const LEAD_ADJUST_EVERY = 30;

/**
 * Folga do relógio local antes de corrigir, em passos.
 *
 * Dois passos são 33 ms. Abaixo disso a "divergência" é só o instantâneo ter sido
 * escrito entre dois passos daqui, e corrigir seria caçar o próprio rabo.
 */
const CLOCK_TOLERANCE = 2;

/** Divergência que deixa de ser deriva e vira outra coisa. Meio segundo. */
const CLOCK_SNAP = 30;

/**
 * Erro de predição do corpo, em metros, e o que fazer com cada faixa.
 *
 * Abaixo do primeiro é ruído de ponto flutuante e desalinho de um passo — corrigir
 * seria tremer à toa. Entre os dois, o erro é real mas pequeno: o corpo assume a
 * posição do host e o **desenho** absorve a diferença em dois décimos de segundo,
 * de modo que ninguém vê o salto. Acima do segundo não é erro, é teleporte
 * legítimo (assumiu um posto, agarrou a escada, renasceu), e aí o certo é ir
 * direto.
 */
const ERROR_IGNORE = 0.08;
const ERROR_SNAP = 1.5;

const _position = new THREE.Vector3();
const _quaternion = new THREE.Quaternion();
/** A pose autoritativa do corpo trazida para mundo. Ver `authoritativePosition`. */
const _authority = new THREE.Vector3();

/**
 * Uma predição guardada: **a grandeza que o corpo possuía** naquele passo.
 *
 * ⚠️ Não é sempre a mesma grandeza, e essa é a razão de a classe existir. No convés
 * o corpo possui a posição **local** — ele anda sobre um chão parado e o casco não
 * entra na conta. Na água ele possui a de **mundo**, e o `local` é derivado dela
 * pela pose do casco. Guardar sempre o `local` faria a reconciliação comparar, no
 * caso da água, duas contas feitas com poses de casco diferentes — ver
 * `GuestSession.reconcile`.
 */
interface PredictedStep {
  readonly position: THREE.Vector3;
  /** `true` quando `position` é de mundo. */
  inWater: boolean;
}

export class GuestSession {
  /**
   * Os dois instantâneos entre os quais se desenha.
   *
   * Não são `readonly` porque eles trocam de papel a cada chegada: o "para onde"
   * vira o "de onde", por troca de referência. Copiar o mundo campo a campo
   * quinze vezes por segundo seria trabalho por nada.
   */
  private from = createWorldState();
  private to = createWorldState();
  /**
   * O terceiro, onde todo instantâneo é lido antes de valer.
   *
   * Existe porque a decisão de aceitar um instantâneo depende do que vem dentro
   * dele: o tick só se conhece depois de decodificar. Decodificando direto sobre
   * o `from` — que era o que se fazia —, um pacote que chegasse fora de ordem
   * destruía a base da interpolação **antes** de ser recusado, e o navio passava
   * a ser desenhado entre uma pose velha e a atual. Um terceiro buffer custa
   * alguns quilobytes uma vez na vida e fecha a porta inteira.
   */
  private spare = createWorldState();
  private hasFrom = false;
  private hasTo = false;

  /** O relógio do host, como o guest o conhece. Só muda quando chega instantâneo. */
  hostTick = 0;

  /**
   * O relógio local, que anda **um por passo**.
   *
   * ⚠️ Isto não pode ser `hostTick + lead` calculado na hora, e o motivo é o bug
   * mais caro que este arquivo já teve: `hostTick` só avança quando chega um
   * instantâneo, e instantâneo chega a cada quatro passos. Derivado dele, o
   * carimbo do comando ficava parado três passos e pulava quatro — e como o host
   * descarta comando repetido (a redundância do lote depende disso), **três de
   * cada quatro comandos eram jogados fora**. O sintoma era `starves` na casa dos
   * milhares com a conexão perfeita.
   *
   * Aqui ele anda sozinho e o instantâneo só o **corrige**, um passo de cada vez.
   * Ver `syncClock`.
   */
  private localTick = 0;

  /**
   * Onde se acha que o relógio do host está **agora**, em passos fracionários.
   *
   * Anda sozinho, um por passo, e o instantâneo corrige só a fase dela. O
   * relógio de desenho é esta estimativa menos o atraso de interpolação — e é
   * por ser derivado de uma rampa que ele anda liso. Ver `renderClock.ts`, que
   * conta a versão anterior e por que ela tremia.
   */
  private hostEstimate = 0;

  /** `true` depois que o primeiro instantâneo alinhou os dois relógios. */
  private clockStarted = false;

  /** Quanto o corpo local corre à frente do host, em passos. */
  lead = 4;
  /** Profundidade da fila do host, vinda no instantâneo. Telemetria. */
  depth = 0;
  /** Erro de predição do último instantâneo, em metros. Telemetria. */
  predictionError = 0;

  /**
   * O desvio visual **não mora mais aqui**, e a mudança é um conserto.
   *
   * Ele era um vetor privado desta classe, com um getter público documentado como
   * "o desvio visual do corpo, que o desenho soma à posição" — e ninguém, em
   * nenhum arquivo do projeto, lia aquele getter. A faixa do meio da reconciliação
   * ficava sem suavização nenhuma. Agora ele é `PlayerController.viewOffset`, que
   * é onde a pose do quadro é montada e onde ele de fato chega à tela; ver a nota
   * completa lá.
   */
  private get viewOffset(): THREE.Vector3 {
    return this.match.crew[0].controller.viewOffset;
  }

  /** Histórico do corpo previsto, indexado por tick, para reconciliar. */
  private readonly history = new Map<number, PredictedStep>();
  private readonly historyPool: PredictedStep[] = [];

  /**
   * A janela de comandos que sai daqui, com a costura que a mantém sem buracos.
   *
   * Ver `InputOutbox` — em resumo, cada correção do relógio de predição pula ou
   * repete um carimbo, e o host descarta as duas coisas. Sem a costura, cada
   * correção custava um comando do jogador.
   */
  private readonly outbox = new InputOutbox();

  private leadTimer = 0;
  /**
   * A fila mais vazia que o host relatou desde o último ajuste do avanço.
   *
   * É o **mínimo**, e não o último valor, porque é o mínimo que diz se sobra
   * folga: uma fila que oscila entre zero e quatro não tem gordura nenhuma para
   * cortar, ainda que o instantâneo em que se olhou mostrasse quatro.
   */
  private minDepthSinceAdjust = Number.POSITIVE_INFINITY;
  /** Passos que o host passou sem comando desde o último ajuste do avanço. */
  private starvedSinceAdjust = 0;

  /**
   * A pose do adversário neste instante, montada uma vez e reescrita por passo.
   *
   * Um objeto só, e não um `CrewState` novo por quadro: isto roda sessenta vezes
   * por segundo dentro do orçamento do quadro de render. Ver a nota de alocação
   * em `snapshotCodec`.
   */
  private readonly remotePose = {
    local: new THREE.Vector3(),
    yaw: 0,
    pitch: 0,
    station: 'deck' as PlayerStation,
    cannonIndex: -1,
    grounded: true,
    onLadder: false,
    atCapstan: false,
    patching: false,
    inWater: false,
  };

  /** Passo em que o posto mudou por predição local, à espera do recibo do host. */
  private stationPredictedAt = -1;
  private lastStation: 'deck' | 'helm' | 'cannon' = 'deck';
  private lastCannonIndex = -1;
  private lastOnLadder = false;
  private lastAtCapstan = false;
  private lastInWater = false;

  /** `true` quando o host avisou que a janela dele saiu de foco. */
  stalled = false;

  constructor(
    private readonly match: Match,
    private readonly client: RoomClient,
    /** Qual dos dois cascos é o meu. Decidido pela sala. */
    private readonly slot: 0 | 1,
  ) {}

  /** O índice do adversário **no fio**. Ver a nota de inversão em `applyWorld`. */
  private get remote(): 0 | 1 {
    return this.slot === 0 ? 1 : 0;
  }

  /** A peça que o jogador local está servindo, ou `-1`. */
  private get operatedCannon(): number {
    const mine = this.match.crew[0].controller;
    return mine.station === 'cannon' ? mine.cannonIndex : -1;
  }

  get ready(): boolean {
    return this.hasTo;
  }

  reset(): void {
    this.hasFrom = false;
    this.hasTo = false;
    this.hostTick = 0;
    this.localTick = 0;
    this.hostEstimate = 0;
    this.clockStarted = false;
    this.minDepthSinceAdjust = Number.POSITIVE_INFINITY;
    this.starvedSinceAdjust = 0;
    this.stationPredictedAt = -1;
    this.lead = 4;
    this.viewOffset.set(0, 0, 0);
    this.releaseHistory(Number.POSITIVE_INFINITY);
    this.outbox.reset();
    this.stalled = false;
  }

  /** Um instantâneo chegou. */
  onFrame(frame: ArrayBuffer): void {
    // Lido no reserva, sempre. Ver a nota em `spare`.
    const header = decodeSnapshot(frame, this.spare);
    if (!header) return;

    // Fora de ordem ou repetido: a rede entregou um pacote velho depois de um
    // novo. Aplicá-lo faria o mundo andar para trás.
    if (this.hasTo && header.tick <= this.to.tick) return;

    // Rodízio de três, por troca de referência: copiar o mundo campo a campo
    // quinze vezes por segundo seria trabalho por nada. O que sai de circulação
    // é o `from` antigo — ou o `to` antigo, enquanto ainda não há um par.
    const freed = this.hasTo ? this.from : this.to;
    if (this.hasTo) {
      this.from = this.to;
      this.hasFrom = true;
    }
    this.to = this.spare;
    this.spare = freed;

    this.hasTo = true;
    this.hostTick = this.to.tick;
    this.depth = this.to.bufferDepth;
    if (this.depth < this.minDepthSinceAdjust) this.minDepthSinceAdjust = this.depth;
    if (this.to.starved > 0) this.starvedSinceAdjust += this.to.starved;
    this.stalled = false;

    // Primeiro instantâneo: o avanço nasce medido, e os dois relógios já nascem
    // alinhados a ele. Ver `estimateLead` e `advanceRenderClock`.
    //
    // ⚠️ A guarda é uma bandeira, e **não** `localTick === 0`, que era o que
    // havia aqui e nunca era verdade: `predictionTick` incrementa o relógio a
    // cada passo desde que a partida começa, e o primeiro instantâneo chega
    // dezenas de passos depois. O ramo de baixo é que rodava sempre, e o efeito
    // era o avanço nascer no valor de fábrica e ter de **descobrir** a latência
    // subindo de um em um — que é exatamente o trabalho que `estimateLead`
    // existe para não ser preciso fazer.
    if (!this.clockStarted) {
      this.clockStarted = true;
      this.lead = this.estimateLead();
      this.localTick = this.hostTick + this.lead;
      this.hostEstimate = this.hostTick;
    } else {
      this.syncClock();
      // A fase da estimativa é corrigida **aqui**, e só aqui: é o único momento
      // em que há informação nova sobre onde o host está.
      this.hostEstimate = correctHostEstimate(this.hostEstimate, this.hostTick);
    }

    this.reconcile();
    this.correctOperatedAim();
    // Os eventos do host viram os eventos deste passo: fumaça, estrondo, lasca e
    // as balas nascem daqui. Ver `MatchEvents` — um caminho, dois papéis.
    //
    // O campo `ship` também se inverte, como tudo que vem do fio: sem isso, o
    // estrondo do meu próprio canhão sairia com o volume de longe e a lasca do
    // meu casco iria parar no dele.
    for (const event of this.to.events) {
      if ('ship' in event) event.ship = event.ship === this.slot ? 0 : 1;
      if (event.kind === 'shot') this.spawnGhostBall(event.position, event.direction);
      this.match.events.push(event);
    }
    this.to.events.length = 0;
  }

  /**
   * Reaproxima a mira da peça que **eu** sirvo do ângulo que o host tem dela.
   *
   * ⚠️ **Sem isto, a mira do canhão é a única coisa do jogo que diverge para
   * sempre.** Ela é acumular-e-grampear dos mesmos deltas dos dois lados, o que
   * concorda perfeitamente enquanto nenhum comando se perde — e comando se
   * perde. Bastava um, e daí em diante o cano que eu vejo apontado para o casco
   * dele não é o cano de onde a bala sai: eu miro, aperto, a bala nasce do outro
   * lado com outro ângulo e passa longe. É a leitura mais frustrante que um
   * duelo pode dar, porque nada na tela sugere que o problema não foi a mira.
   *
   * É o mesmo remédio da roda do timão (ver `WHEEL_CATCHUP`) e roda no mesmo
   * ritmo em que a informação nova chega: **uma vez por instantâneo**, e não uma
   * vez por passo. Aqui a diferença importa mais que na roda, porque este ângulo
   * está debaixo da mão de quem está mirando agora — puxá-lo sessenta vezes por
   * segundo seria arrastar a peça contra o próprio jogador.
   *
   * O ganho é pequeno de propósito: o valor que chega descreve meia ida e volta
   * atrás. A doze por cento por instantâneo, um erro fecha em cerca de meio
   * segundo e é imperceptível com o cano em movimento.
   */
  private correctOperatedAim(): void {
    const index = this.operatedCannon;
    if (index < 0) return;
    const cannon = this.match.ships[0]!.cannons[index];
    const target = this.to.ships[this.slot]!.cannons[index];
    if (!cannon || !target) return;

    cannon.traverse += (target.traverse - cannon.traverse) * AIM_CATCHUP;
    cannon.elevation += (target.elevation - cannon.elevation) * AIM_CATCHUP;
  }

  /**
   * Põe no ar a bala de um tiro que o host anunciou.
   *
   * A velocidade é reconstruída como `direção × velocidade de boca`, e não vem no
   * fio. A aproximação é boa porque a boca é duas ordens de grandeza mais rápida
   * que o navio: uma chalupa a 5 m/s contra 95 m/s de pólvora dá menos de 3% de
   * erro de módulo, e a direção — que é o que decide onde a bala **parece** cair
   * — vem exata. Mandar o vetor cheio custaria seis bytes por tiro para corrigir
   * o que ninguém enxerga.
   */
  private spawnGhostBall(position: THREE.Vector3, direction: THREE.Vector3): void {
    _position.copy(direction).multiplyScalar(MUZZLE_SPEED);
    this.match.cannonballs.spawnGhost(position, _position, BALL_MASS, BALL_RADIUS);
  }

  /** O host avisou que a janela dele está em segundo plano. */
  markStalled(): void {
    this.stalled = true;
  }

  /**
   * O passo do guest.
   *
   * @param frame a entrada local deste passo, já carimbada com o tick de predição.
   */
  fixedUpdate(frame: InputFrame): void {
    if (!this.hasTo) return;

    // Antes de `applyWorld`, que é quem escreve a autoridade por cima. Ver
    // `trackStationPrediction`.
    this.trackStationPrediction(frame.tick);
    // Um por passo, sempre. Toda a correção mora na chegada do instantâneo — é
    // o que mantém a velocidade do mundo constante entre dois pacotes.
    this.hostEstimate = advanceHostEstimate(this.hostEstimate);
    this.applyWorld();
    this.rememberStation();
    this.rememberPrediction(frame.tick);
    this.queueOutgoing(frame);
    this.adjustLead();
  }

  /**
   * O instante que está sendo desenhado, em passos fracionários.
   *
   * Um instantâneo atrás da estimativa do host: é onde a pose já tem os dois
   * pontos entre os quais interpolar.
   */
  private get renderClock(): number {
    return this.hostEstimate - INTERP_DELAY;
  }

  /**
   * O passo em que o corpo local corre, e com que o comando é carimbado.
   *
   * Avança **aqui**, uma vez por chamada, porque é chamado uma vez por passo. Ver
   * `localTick` para o porquê de ele não ser derivado do relógio do host.
   */
  predictionTick(): number {
    return ++this.localTick;
  }

  /**
   * Alinha o relógio local ao do host, sem solavanco.
   *
   * O alvo é `hostTick + lead`: comando carimbado aí chega lá pouco antes de ser
   * preciso. Divergência pequena é corrigida **um passo por instantâneo** — o
   * jogador sente como o mundo indo um triz mais devagar ou mais rápido, que é
   * imperceptível. Divergência grande não é deriva, é outra coisa (a aba dormiu,
   * a rede sumiu por segundos), e aí saltar é o certo: acompanhar de um em um
   * levaria minutos.
   */
  private syncClock(): void {
    const target = this.hostTick + this.lead;
    const drift = target - this.localTick;
    if (drift === 0) return;
    if (Math.abs(drift) > CLOCK_SNAP) {
      this.localTick = target;
      return;
    }
    if (Math.abs(drift) > CLOCK_TOLERANCE) this.localTick += Math.sign(drift);
  }

  /**
   * Decai o desvio visual. Roda no quadro, com o `dt` real.
   *
   * O getter `offset` que existia ao lado disto **foi removido**: era a ponta solta
   * de uma peça que nunca foi ligada, e mantê-lo publicaria de novo um vetor que
   * ninguém lê. Quem soma o desvio à pose agora é `PlayerController.syncView`.
   */
  decayOffset(dt: number): void {
    this.match.crew[0].controller.decayViewOffset(dt);
  }

  // -- aplicação -----------------------------------------------------------------

  /**
   * Escreve no `Match` a pose do instante de desenho.
   *
   * O truque que faz `syncModel(alpha)` continuar funcionando sem uma linha de
   * mudança: a cada passo, a pose de agora vira a "anterior" e a interpolada vira
   * a "atual". `ShipBody` já sabe interpolar entre as duas — ele faz isso desde
   * antes de existir rede, para a tela de 144 Hz não ver a simulação de 60.
   */
  private applyWorld(): void {
    // Sem par ainda: só há uma pose, e ela é a de agora.
    const t = this.hasFrom
      ? interpolationFactor(this.renderClock, this.from.tick, this.to.tick)
      : 1;

    for (let local = 0; local < 2; local++) {
      // ⚠️ **Os índices se invertem aqui, e é a linha mais importante do arquivo.**
      //
      // No fio, o índice 0 é sempre o navio de quem simula. Localmente, o índice
      // 0 é sempre "o meu" — é o que faz a câmera, o HUD, o corpo e o áudio
      // funcionarem sem saber que existe rede. Traduzir na entrada mantém os dois
      // mundos coerentes e deixa o resto do jogo em paz; não traduzir daria um
      // guest olhando pelos olhos do adversário, e levaria horas para descobrir
      // por quê.
      const net = local === 0 ? this.slot : this.remote;
      const ship = this.match.ships[local]!;
      const to = this.to.ships[net]!;
      const from = this.hasFrom ? this.from.ships[net]! : to;

      const { body } = ship;
      body.previousCom.copy(body.comPosition);
      body.previousOrientation.copy(body.orientation);

      body.comPosition.lerpVectors(from.position, to.position, t);
      _quaternion.copy(from.orientation).slerp(to.orientation, t);
      body.orientation.copy(_quaternion);
      body.velocity.lerpVectors(from.velocity, to.velocity, t);
      body.angularVelocity.lerpVectors(from.angularVelocity, to.angularVelocity, t);

      this.applyShipParts(ship, from, to, t, local === 0);
    }

    // O mar é escrito, não avançado: somar `dt` sessenta vezes por segundo por
    // dez minutos afastaria o relógio do mar dos dois lados por acúmulo de ponto
    // flutuante, e o casco flutuaria numa onda que o outro não vê.
    const waves = this.match.environment.waveField;
    waves.time = this.from.waveTime + (this.to.waveTime - this.from.waveTime) * t;
    waves.windDirection = this.to.windDirection;
    waves.windStrength = this.to.windStrength;
    // ⚠️ **E o rumo da ondulação de fundo junto**, que é o que faltava e o que
    // fazia os dois jogadores navegarem mares diferentes. Quem o move é
    // `WaveField.followWind`, e `followWind` mora no passo de quem simula: deste
    // lado ele ficava congelado no valor de fábrica enquanto do outro girava
    // 2% por segundo em direção ao vento. As duas ondas longas do espectro
    // compõem a direção com ele — e são elas que levantam o casco.
    waves.swellDirection = this.to.swellDirection;
    waves.syncUniforms();

    this.applySky();
    this.applyCrew(t);
  }

  /**
   * O céu e o tempo, escritos como chegaram.
   *
   * **Sem interpolar**, e é uma escolha, não um esquecimento: entre dois
   * instantâneos passam 67 ms, e nesse tempo o sol de um dia de doze minutos
   * anda três centésimos de grau. Interpolar isso custaria tratar a virada da
   * meia-noite (0,99 → 0,01, que interpolado dá um dia inteiro ao contrário em
   * um passo) para ganhar exatamente nada que se veja.
   */
  private applySky(): void {
    const sky = this.to.sky;
    const environment = this.match.environment;

    environment.dayNight.timeOfDay = sky.timeOfDay;
    environment.weather.applyRemote({
      current: sky.current,
      target: sky.target,
      baseWind: sky.baseWind,
      clouds: sky.clouds,
      rain: sky.rain,
      visibility: sky.visibility,
      flash: sky.flash,
      // Vento e rumo viajam como propriedade do mar, porque é o mar que os
      // consome; o tempo os recebe de volta só para o HUD ter o que mostrar.
      wind: this.to.windStrength,
      direction: this.to.windDirection,
    });
    environment.fixedUpdateRemote();
  }

  private applyShipParts(
    ship: Ship,
    from: WorldState['ships'][0],
    to: WorldState['ships'][0],
    t: number,
    mine: boolean,
  ): void {
    ship.rudder.previousWheelAngle = ship.rudder.wheelAngle;
    ship.rudder.previousRudderAngle = ship.rudder.rudderAngle;

    if (mine) {
      // A **minha** roda gira aqui, no mesmo passo em que o comando sai da minha
      // mão — quem a integra é `Ship.fixedUpdateRemote`, e sem essa chamada ela
      // não girava de jeito nenhum. É isto que tira a sensação de leme
      // emperrado: o navio responder depois não é latência, é massa, e o jogador
      // lê como massa.
      //
      // Mas ela **também** é puxada de leve para o ângulo do host, e o motivo é
      // o mesmo que obrigou o olhar a viajar absoluto: os dois lados chegam ao
      // ângulo somando incrementos, e um comando que se perca deixa os dois
      // ângulos diferentes **para sempre**, sem nada que os reaproxime. Aqui a
      // deriva custa menos que no olhar — a roda bate no batente e volta ao meio
      // várias vezes por combate, e cada uma dessas ressincroniza sozinha —, mas
      // "menos" não é "nada" num duelo de dez minutos.
      //
      // O ganho é deliberadamente pequeno. O valor que chega descreve o passado
      // de meia ida e volta atrás; puxar forte para ele seria arrastar a roda
      // contra a mão de quem está girando agora. A oito por cento por
      // instantâneo, um erro fecha em cerca de um segundo de roda parada e é
      // imperceptível com a roda em movimento.
      ship.rudder.setWheel(
        ship.rudder.wheelAngle + (to.wheelAngle - ship.rudder.wheelAngle) * WHEEL_CATCHUP,
      );
    } else {
      ship.rudder.setWheel(from.wheelAngle + (to.wheelAngle - from.wheelAngle) * t);
    }

    ship.cannonballs = to.cannonballs;
    ship.planks = to.planks;
    ship.anchor.state = to.anchorState;
    ship.anchor.deploy = to.anchorDeploy;

    for (let i = 0; i < ship.cannons.length; i++) {
      const cannon = ship.cannons[i]!;
      const target = to.cannons[i]!;
      const previous = from.cannons[i]!;
      cannon.beginStep();
      // A peça que **eu** estou operando não é escrita por cima a cada passo: a
      // mira responde ao meu mouse agora, e um cano que salta meio grau quinze
      // vezes por segundo é impossível de apontar. Quem a reaproxima da verdade
      // é `correctOperatedAim`, uma vez por instantâneo e de leve.
      const operatedByMe = mine && this.operatedCannon === i;
      if (!operatedByMe) {
        cannon.traverse = previous.traverse + (target.traverse - previous.traverse) * t;
        cannon.elevation = previous.elevation + (target.elevation - previous.elevation) * t;
      }
      cannon.state = target.state;
      cannon.loadProgress = target.loadProgress;
      cannon.recoil = previous.recoil + (target.recoil - previous.recoil) * t;
    }

    // Dano é sempre autoritativo: não há nada que o cliente possa prever sobre
    // uma bala que o outro atirou.
    ship.damage.floodVolume = to.floodFraction * ship.damage.holdVolume;
    ship.damage.sinkTime = to.sinkTime;
    if (to.breaches) this.applyBreaches(ship, to.breaches, to.patches);
    // Mesmo quando a lista não mudou, o esguicho muda: a onda andou e o casco
    // adernou. Ver `refreshBreachInflow`.
    else if (ship.damage.breaches.length > 0) this.refreshBreachInflow(ship);

    // ⚠️ **E a lâmina d'água é resolvida aqui, todo passo.**
    //
    // O volume chega pronto na linha de cima e sempre chegou — o HUD subia, o
    // casco calava mais fundo, tudo certo. O que faltava era converter esse
    // volume no **plano** que o desenho lê, e quem fazia essa conversão era
    // `ShipDamage.fixedUpdate`, que é o caminho de quem simula. Deste lado o
    // plano ficava em `-Infinity` para sempre, e `DamageView` esconde a água
    // quando ele não é finito: o jogador descia ao porão com o casco furado e
    // encontrava assoalho seco. "Abri rombo e não entra água" é exatamente isto.
    //
    // Todo passo, e não só quando a lista muda, porque o plano depende da
    // adernada — e a adernada muda sessenta vezes por segundo.
    ship.damage.solveWaterPlane(ship.body);
  }

  private applyBreaches(
    ship: Ship,
    incoming: NonNullable<WorldState['ships'][0]['breaches']>,
    patches: WorldState['ships'][0]['patches'],
  ): void {
    const { breaches } = ship.damage;
    breaches.length = 0;
    for (const source of incoming) {
      breaches.push({
        id: source.id,
        local: source.local.clone(),
        normal: source.normal.clone(),
        area: source.area,
        repair: source.repair,
        // A vazão **não** vem no fio, e não precisa vir: ela é uma função da
        // pose do casco e do mar, e o guest tem os dois. Calcular aqui custa uma
        // raiz por rombo e é o que faz o esguicho existir do lado de cá — antes
        // este campo entrava zerado e o porão do guest ficava seco de água
        // visível enquanto enchia de verdade, o que fazia o rombo parecer
        // decorativo justamente para quem precisava correr para tapá-lo.
        inflow: 0,
      });
    }
    this.refreshBreachInflow(ship);

    // As tábuas vêm no mesmo campo condicional, e são o que faltava para o
    // costado do adversário contar a história certa: sem elas, o rombo que ele
    // acabou de tapar **sumia** do casco em vez de virar cicatriz com madeira
    // por cima. Reescrever a lista inteira é seguro porque ela é autoritativa
    // dos dois lados — inclusive a minha, que eu previ localmente e que o host
    // acabou de confirmar.
    if (!patches) return;
    const list = ship.damage.patches;
    list.length = 0;
    for (const source of patches) {
      list.push({
        id: source.id,
        local: source.local.clone(),
        normal: source.normal.clone(),
        area: source.area,
      });
    }
  }

  /**
   * Recalcula o esguicho de cada rombo com a pose e o mar deste instante.
   *
   * Roda a cada passo, e não só quando a lista muda: a vazão depende de onde a
   * onda está agora e de quanto o casco está adernado, e os dois mudam sessenta
   * vezes por segundo enquanto a lista de rombos passa minutos igual.
   */
  private refreshBreachInflow(ship: Ship): void {
    const waves = this.match.environment.waveField;
    const sigma = waves.getElevationSigma();
    for (const breach of ship.damage.breaches) {
      ship.body.localToWorld(breach.local, _position);
      const depth = waves.sampleHeight(_position.x, _position.z) - _position.y;
      breach.inflow = breachInflow(breach.area, depth, sigma);
    }
  }

  /**
   * O corpo do adversário é autoritativo; o meu, só nos campos que não prevejo.
   *
   * ## Por que o corpo dele é interpolado como o casco
   *
   * Porque ele é **visto**, e desde que existe avatar do adversário isso deixou
   * de ser detalhe. Escrever a pose do último instantâneo direto no controlador
   * — que era o que se fazia, e bastava enquanto ninguém o desenhava — dá um
   * marujo que anda a quinze quadros por segundo em cima de um convés que anda a
   * cento e quarenta e quatro: o corpo aos trancos, e a cada tranco um pé
   * patinando na madeira.
   *
   * O `t` é o **mesmo** do casco, e essa é a parte que não pode divergir: o
   * corpo anda em coordenadas do navio, então corpo e convés precisam ser
   * desenhados no mesmo instante ou o marujo desliza sobre o próprio piso.
   *
   * O que **não** se interpola são os campos discretos — posto, peça, escada,
   * cabrestante, tábua. Eles valem do `from` até o `to` chegar, e é o `from` que
   * descreve o instante que está sendo desenhado. Interpolar um posto não
   * significa nada; adiantá-lo faria o corpo assumir o timão antes de chegar
   * nele.
   *
   * @param t onde o relógio de desenho está entre os dois instantâneos.
   */
  private applyCrew(t: number): void {
    // Índices invertidos como em `applyWorld`: local 1 é sempre o adversário, e
    // no fio ele é `this.remote`.
    const remote = this.match.crew[1].controller;
    const to = this.to.crew[this.remote]!;
    const state = this.hasFrom ? this.from.crew[this.remote]! : to;
    const pose = this.remotePose;

    // Assumir o leme ou montar a peça **teleporta** os pés metros de distância.
    // Interpolar essa reta daria um pirata deslizando pelo convés em pose de
    // parado; cravá-lo no posto de origem até a troca valer devolve o salto para
    // quem sabe suavizá-lo — `PlayerAvatar.updateStation`, que leva o corpo até
    // a estação na mesma curva de 0,28 s da câmera.
    const switching = state.station !== to.station || state.cannonIndex !== to.cannonIndex;
    if (switching) {
      pose.local.copy(state.local);
      pose.yaw = state.yaw;
      pose.pitch = state.pitch;
    } else {
      pose.local.lerpVectors(state.local, to.local, t);
      // Pelo caminho curto: sem isto, cruzar ±π faz a cabeça dele dar quase uma
      // volta inteira entre dois instantâneos.
      pose.yaw = state.yaw + wrapAngle(to.yaw - state.yaw) * t;
      pose.pitch = state.pitch + (to.pitch - state.pitch) * t;
    }

    pose.station = state.station;
    pose.cannonIndex = state.cannonIndex;
    pose.grounded = state.grounded;
    pose.onLadder = state.onLadder;
    pose.atCapstan = state.atCapstan;
    pose.patching = state.patching;
    // A água entra na lista dos discretos, e é o certo: interpolar "está no mar"
    // não significa nada, e adiantá-lo poria o adversário nadando pelo convés no
    // último passo antes de ele de fato pular.
    pose.inWater = state.inWater;

    // O passo do corpo dele: é aqui que a pose vira passada, pulo, escalada,
    // mãos na roda e tábua na mão. Ver `PlayerController.applyRemoteStep`.
    remote.applyRemoteStep(FIXED_TIMESTEP, pose, this.match.ships[1]!);

    // ⚠️ **O posto só é escrito quando o host já viu o comando que o mudou.**
    //
    // Escrever sempre — que era o que se fazia — parte de uma premissa razoável
    // e errada: a de que o cliente não prevê o posto. Ele prevê, e sempre
    // previu, porque `Crewman.fixedUpdate` é o **mesmo** código dos dois lados e
    // `Interaction.press` chama `takeHelm()` aqui também. O que havia era uma
    // predição sem reconciliação: o jogador assumia o timão neste instante e o
    // instantâneo seguinte, que descreve um passado anterior ao aperto, o
    // devolvia ao convés. Com a ida e volta que este projeto tem, isso são cinco
    // ou seis instantâneos desfazendo o comando antes de o host confirmá-lo — e
    // o jogador vê a câmera pular entre o convés e a roda, com os controles
    // trocando de significado a cada salto. Era o "os controles se invertem".
    //
    // `ackTick` é o recibo: enquanto o último comando que o host consumiu for
    // anterior ao que causou a mudança daqui, o estado que chega ainda **não
    // pode** falar sobre ela, e o certo é deixar a predição em pé. Quando o
    // recibo passa, a autoridade volta a valer inteira — e se o host tiver
    // recusado, a correção acontece aí, uma vez só, em vez de piscar.
    const settled = this.stationPredictedAt < 0 || this.to.ackTick >= this.stationPredictedAt;
    if (!settled) return;
    this.stationPredictedAt = -1;

    const mine = this.match.crew[0].controller;
    const mineState = this.to.crew[this.slot]!;
    mine.station = mineState.station;
    mine.cannonIndex = mineState.cannonIndex;
    mine.onLadder = mineState.onLadder;
    mine.atCapstan = mineState.atCapstan;
    // A água entra pelo mesmo recibo que os outros — cair no mar é previsto aqui, e
    // o instantâneo que descreve o passado anterior ao salto ainda diz "no convés".
    // Por um método, e não por atribuição: entrar na água é trocar o corpo de
    // referencial, e quem sabe fazer isso é o controlador. Ver
    // `applyAuthoritativeWater`.
    mine.applyAuthoritativeWater(mineState.inWater, this.match.ships[0]!);
  }

  /**
   * Anota que o posto mudou **aqui**, e em que passo.
   *
   * Roda antes de `applyWorld`, e a ordem é o que torna a leitura possível: o
   * passo do marujo local já aconteceu (`Match.fixedUpdateRemote` roda antes
   * desta sessão), e a autoridade ainda não foi escrita por cima. Uma diferença
   * em relação ao que ficou do passo anterior só pode ter vindo daqui.
   */
  private trackStationPrediction(tick: number): void {
    const mine = this.match.crew[0].controller;
    const changed =
      mine.station !== this.lastStation ||
      mine.cannonIndex !== this.lastCannonIndex ||
      mine.onLadder !== this.lastOnLadder ||
      mine.atCapstan !== this.lastAtCapstan ||
      // Cair no mar e sair dele são previstos aqui como qualquer troca de posto, e
      // pelo mesmo motivo entram na conta do recibo: sem isto, o instantâneo que
      // descreve o passado anterior ao salto devolveria o jogador ao convés meia
      // dúzia de vezes antes de o host confirmar que ele pulou.
      mine.inWater !== this.lastInWater;

    if (changed) this.stationPredictedAt = tick;

    this.rememberStation();
  }

  /** Depois de `applyCrew`: a autoridade também conta como "o que ficou". */
  private rememberStation(): void {
    const mine = this.match.crew[0].controller;
    this.lastStation = mine.station;
    this.lastCannonIndex = mine.cannonIndex;
    this.lastOnLadder = mine.onLadder;
    this.lastAtCapstan = mine.atCapstan;
    this.lastInWater = mine.inWater;
  }

  // -- predição -------------------------------------------------------------------

  private rememberPrediction(tick: number): void {
    const controller = this.match.crew[0].controller;
    const slot = this.historyPool.pop() ?? { position: new THREE.Vector3(), inWater: false };
    // A grandeza que a predição **possui** neste passo, e não uma escolhida: no
    // convés é o local, na água é o mundo. Ver `PredictedStep`.
    slot.inWater = controller.inWater;
    slot.position.copy(controller.inWater ? controller.worldFeet : controller.local);
    this.history.set(tick, slot);
    // Um segundo de histórico basta: o instantâneo que vai cobrar a predição
    // chega em menos de cem milissegundos.
    this.releaseHistory(tick - 60);
  }

  /**
   * A posição do host **em mundo**, reconstruída com a pose do casco do mesmo
   * instantâneo.
   *
   * ⚠️ **A pose tem de ser a do instantâneo, e não a de `ship.body`.** `applyWorld`
   * escreve em `ship.body` a pose **interpolada**, que fica `INTERP_DELAY` passos
   * atrás do relógio de desenho — e o relógio de desenho já está `lead` passos
   * atrás do tick que está sendo cobrado. Usar aquela pose aqui reintroduziria
   * exatamente o viés que este método existe para tirar. A pose que veio no pacote,
   * essa sim, é a que o host tinha no tick `to.tick` — a mesma com que ele derivou
   * o `local` que está sendo comparado.
   *
   * A conta é `ShipBody.localToWorld` letra por letra. `centerOfMass` não viaja no
   * fio e não precisa: ele é uma constante do casco, calculada igual dos dois lados.
   */
  private authoritativePosition(local: THREE.Vector3, ship: Ship): THREE.Vector3 {
    const state = this.to.ships[this.slot]!;
    return _authority
      .copy(local)
      .sub(ship.body.centerOfMass)
      .applyQuaternion(state.orientation)
      .add(state.position);
  }

  /**
   * Confere a predição do corpo contra a verdade do host.
   *
   * **Não ressimula.** Com o corpo em coordenadas locais, o erro que sobra é o de
   * um passo de caminhada — centímetros. Corrigir a posição e deixar o desenho
   * alcançar em dois décimos é indistinguível de não ter errado, e custa uma
   * subtração em vez de um histórico de estados inteiros para reexecutar.
   */
  private reconcile(): void {
    const authoritative = this.to.crew[this.slot]!;
    const predicted = this.history.get(this.to.tick);
    if (!predicted) return;

    const controller = this.match.crew[0].controller;

    // ⚠️ **Os três têm de concordar sobre o referencial, senão não há o que
    // comparar.** A predição guardou local ou mundo conforme o corpo estivesse no
    // convés ou no mar; a autoridade descreve o mesmo passo do ponto de vista do
    // host; e o corpo de agora é quem vai receber a correção. Quando eles divergem
    // é porque alguém entrou ou saiu da água entre o passo cobrado e este — e aí a
    // troca já é um teleporte legítimo que o recibo do posto cobre, em `applyCrew`.
    // Medir a distância entre uma posição de mar e uma de convés daria um número
    // grande e sem sentido, e o ramo de `ERROR_SNAP` o obedeceria.
    if (predicted.inWater !== authoritative.inWater) return;
    if (predicted.inWater !== controller.inWater) return;

    const ship = this.match.ships[0]!;
    // ⚠️ **A comparação é feita no referencial que a predição possui.**
    //
    // Comparar sempre em coordenadas locais parecia natural e escondia um viés
    // sistemático que só a água revela. No convés não há viés nenhum: o `local` de
    // quem anda não lê a pose do casco para nada, então os dois lados chegam ao
    // mesmo número por caminhos independentes. Na água, não — o `local` do nadador
    // **é** a posição de mundo convertida pela pose do casco, e as duas poses são
    // diferentes: o host usa a real, o guest usa a interpolada da rede, atrasada de
    // `lead + INTERP_DELAY` passos (150 a 300 ms, conforme a conexão). Duas
    // posições de mundo *idênticas* viram `local` diferentes, e a reconciliação
    // enxergava um erro que não existe no mundo.
    //
    // Medido: só a translação do casco a 2,6 m/s dá 0,39 m a 150 ms e 0,78 m a
    // 300 ms — cinco a dez vezes `ERROR_IGNORE`, do primeiro quadro na água e sem
    // depender da distância. Com o navio guinando o termo cresce com o **raio**, e
    // é justamente o cenário do recurso: ficar para trás enquanto o navio navega. A
    // 0,4 rad/s o viés cruza `ERROR_SNAP` em 11 a 24 m, ou seja em 4 a 9 segundos
    // de deriva — dentro da janela em que o resgate ainda nem abriu.
    //
    // A saída é comparar onde os dois lados fazem a mesma conta com os mesmos
    // dados: em **mundo**, reconstruindo a posição do host com a pose do casco que
    // veio no mesmo pacote. Ver `authoritativePosition`.
    const target = predicted.inWater
      ? this.authoritativePosition(authoritative.local, ship)
      : authoritative.local;

    const error = predicted.position.distanceTo(target);
    this.predictionError = error;
    if (error < ERROR_IGNORE) return;

    if (error > ERROR_SNAP) {
      // Teleporte legítimo. Ir direto, e sem desvio: arrastar o desenho por um
      // metro e meio seria desenhar o jogador atravessando o convés.
      controller.applyAuthoritative(target, predicted.inWater, ship);
      this.viewOffset.set(0, 0, 0);
      this.releaseHistory(Number.POSITIVE_INFINITY);
      return;
    }

    // O desvio guarda a diferença **antes** de a posição ser corrigida, e o
    // desenho o soma de volta — o corpo vai para o lugar certo sem que se veja.
    //
    // ⚠️ **Em coordenadas do navio, sempre.** A comparação acontece no referencial
    // que a predição possui, e na água esse referencial é o mundo — mas quem soma
    // este vetor é `syncView`, que monta uma pose local. Somar um deslocamento de
    // mundo ali entortaria a correção pelo rumo do casco, e o erro seria máximo
    // justamente de través, que é a pose mais comum de um navio em combate.
    _position.copy(predicted.position).sub(target);
    if (predicted.inWater) ship.body.worldDirToLocal(_position, _position);
    controller.absorbViewOffset(_position);
    controller.applyAuthoritative(target, predicted.inWater, ship);
    this.releaseHistory(this.to.tick);
  }

  private releaseHistory(upTo: number): void {
    for (const [tick, step] of this.history) {
      if (tick > upTo) continue;
      this.history.delete(tick);
      this.historyPool.push(step);
    }
  }

  // -- envio ------------------------------------------------------------------------

  /**
   * Enfileira o quadro e manda um lote a cada dois passos.
   *
   * O lote leva os quatro últimos quadros, dos quais dois são repetição. É o que
   * torna a perda de um pacote invisível sem confirmação nem reenvio — ver
   * `INPUT_BATCH`.
   */
  private queueOutgoing(frame: InputFrame): void {
    // O olhar que este passo produziu, medido **depois** de o marujo já ter
    // andado — `Match.fixedUpdateRemote` roda antes desta sessão. É o ângulo
    // exato com que a interação foi decidida aqui, e é o que o host tem de usar
    // para decidir igual. Ver `PlayerController.applyLook`.
    const view = this.match.crew[0].controller;
    frame.yaw = view.yaw;
    frame.pitch = view.pitch;

    this.outbox.add(frame);

    if (frame.tick % SEND_EVERY !== 0) return;
    this.client.sendFrame(encodeInput(this.outbox.batch));
  }

  /**
   * Ajusta o quanto o corpo corre à frente, pela fila do host.
   *
   * Fila vazia significa entrada chegando tarde: adiantar mais. Fila cheia
   * significa entrada chegando cedo demais e envelhecendo na espera, o que é
   * latência de comando pura: recuar. Um passo de cada vez, a cada dois segundos
   * — mais rápido que isso e o ajuste vira o problema, porque cada mudança de
   * avanço é um pulinho no relógio de quem joga.
   */
  /**
   * O avanço inicial, a partir do tempo de ida e volta já medido.
   *
   * ## A conta é a ida e volta **inteira**, e não a metade
   *
   * Era metade, com o raciocínio de que "só o caminho de ida interessa", e a
   * conta está errada por um fator de dois. O relógio contra o qual o guest se
   * carimba é `hostTick`, e `hostTick` é o número que veio **dentro** de um
   * instantâneo: quando ele chega aqui, o host já andou meia volta além dele. O
   * comando carimbado agora ainda vai levar a outra meia volta para chegar lá.
   * Somadas, é a volta inteira que separa o `hostTick` que se conhece do
   * instante em que o comando será consumido.
   *
   * Com metade, o comando chegava sistematicamente atrasado e era **descartado**
   * — `InputBuffer.push` recusa tick que já passou. O host então repetia o
   * último quadro conhecido: os `pressed` sumiam (interagir, atirar e pular
   * simplesmente não aconteciam), o `held` continuava valendo e a posição
   * autoritativa se afastava da prevista até estourar `ERROR_SNAP`. O que o
   * jogador via era um marujo que anda mas não obedece, e que a cada segundo é
   * puxado de volta para onde estava.
   *
   * O jitter entra somado porque ele é assimétrico no que importa: o pacote que
   * chega adiantado só engorda a fila, o que chega atrasado é perdido. E a folga
   * de quatro passos cobre a granularidade do instantâneo — ele sai a cada
   * quatro passos, então o `hostTick` que se lê pode já ter até um intervalo
   * inteiro de idade além da rede.
   */
  private estimateLead(): number {
    const stepMs = FIXED_TIMESTEP * 1000;
    const ticks = Math.ceil((this.client.rtt + this.client.jitter) / stepMs);
    return Math.max(LEAD_MIN, Math.min(ticks + SNAPSHOT_INTERVAL, LEAD_MAX));
  }

  /**
   * Ajusta o quanto o corpo corre à frente, pelo **fundo** da fila do host.
   *
   * ## Por que o mínimo, e não a última leitura
   *
   * Porque avanço é latência de comando pura — cada passo a mais é um passo que
   * o comando espera na fila antes de valer — e a única folga que se pode cortar
   * com segurança é a que existiu o tempo **todo** desde o último ajuste. Uma
   * fila que oscila entre zero e quatro tem média dois e gordura nenhuma: cortar
   * ali é escolher passar fome no próximo vale.
   *
   * ## O defeito que isto substitui
   *
   * A versão anterior olhava a última leitura, subia com fila abaixo de dois e
   * só descia com fila acima de quatro. Entre os dois havia uma faixa morta, e
   * qualquer engasgo que empurrasse o avanço para cima ficava lá: subir era
   * fácil, descer exigia uma fila gorda que o próprio avanço alto impedia de
   * acontecer. Era uma catraca, e ela girava sempre no mesmo sentido — o
   * jogador que relatou isto estava com avanço 22 (366 ms de atraso em toda
   * ação que depende do host) numa conexão de 127 ms, que pede 12.
   */
  private adjustLead(): void {
    this.leadTimer++;
    if (this.leadTimer < LEAD_ADJUST_EVERY) return;
    this.leadTimer = 0;

    const floor = this.minDepthSinceAdjust;
    const starved = this.starvedSinceAdjust;
    this.minDepthSinceAdjust = Number.POSITIVE_INFINITY;
    this.starvedSinceAdjust = 0;
    // Nenhum instantâneo na janela: não há o que medir, e chutar seria pior.
    if (!Number.isFinite(floor)) return;

    // Subir é resposta a **fome de verdade**, relatada pelo host, e não a uma
    // fila vazia. Os dois pareciam a mesma coisa e não são: a fila fica em zero
    // também quando o comando chega exatamente na hora, que é o alvo. Guiar por
    // ela fazia o avanço subir justamente quando ele estava certo, e nunca mais
    // descer.
    //
    // O tamanho do passo de subida acompanha o tamanho da fome. Era dois
    // sempre, e dois é a resposta certa para uma rede que engasgou de verdade —
    // não para o único passo perdido que um pacote atrasado produz. Como avanço
    // é latência de comando pura, subir dois por causa de um custa 33 ms de
    // atraso permanente em toda ação que dependa do host, e o ajuste seguinte só
    // devolve um deles.
    if (starved >= 4) this.lead = Math.min(this.lead + 2, LEAD_MAX);
    else if (starved > 0) this.lead = Math.min(this.lead + 1, LEAD_MAX);
    else if (floor > DEPTH_TARGET) this.lead = Math.max(this.lead - 1, LEAD_MIN);
  }
}
