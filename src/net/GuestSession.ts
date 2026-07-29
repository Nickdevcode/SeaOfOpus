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
import { copyInputFrame, createInputFrame, type InputFrame } from '../core/InputFrame';
import type { Match } from '../game/Match';
import type { Ship } from '../ship/Ship';
import { BALL_MASS, BALL_RADIUS, MUZZLE_SPEED } from '../ship/Cannon';
import { INPUT_BATCH } from '../../shared/protocol';
import { encodeInput } from './snapshotCodec';
import { advanceRenderClock, interpolationFactor } from './renderClock';
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

/** Faixa saudável da fila do host. Ver `adjustLead`. */
const DEPTH_MIN = 2;
const DEPTH_MAX = 4;

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

/** Constante de decaimento do desvio visual. ~0,2 s para sumir. */
const OFFSET_LAMBDA = 16;

const _position = new THREE.Vector3();
const _quaternion = new THREE.Quaternion();

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
   * O relógio de **desenho**, em passos fracionários.
   *
   * Anda sozinho, um por passo, e o instantâneo só o corrige — a mesma regra de
   * `localTick`, e pelo mesmo motivo: derivado de `hostTick`, ele ficaria parado
   * três passos e pularia quatro, que é exatamente o tranco que este arquivo
   * existe para não ter. É fracionário porque é dele que sai o fator de
   * interpolação entre os dois instantâneos. Ver `advanceRenderClock`.
   */
  private renderClock = 0;

  /** Quanto o corpo local corre à frente do host, em passos. */
  lead = 4;
  /** Profundidade da fila do host, vinda no instantâneo. Telemetria. */
  depth = 0;
  /** Erro de predição do último instantâneo, em metros. Telemetria. */
  predictionError = 0;

  /** Desvio visual que decai, para uma correção pequena não aparecer. */
  private readonly visualOffset = new THREE.Vector3();

  /** Histórico do corpo local, indexado por tick, para reconciliar. */
  private readonly history = new Map<number, THREE.Vector3>();
  private readonly historyPool: THREE.Vector3[] = [];

  /** Os últimos quadros enviados, para a redundância do lote. */
  private readonly outbox: InputFrame[] = Array.from({ length: INPUT_BATCH }, createInputFrame);
  private outboxCount = 0;

  private leadTimer = 0;
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

  get ready(): boolean {
    return this.hasTo;
  }

  reset(): void {
    this.hasFrom = false;
    this.hasTo = false;
    this.hostTick = 0;
    this.localTick = 0;
    this.renderClock = 0;
    this.lead = 4;
    this.visualOffset.set(0, 0, 0);
    this.releaseHistory(Number.POSITIVE_INFINITY);
    this.outboxCount = 0;
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
    this.stalled = false;

    // Primeiro instantâneo: o avanço nasce medido, e os dois relógios já nascem
    // alinhados a ele. Ver `estimateLead` e `advanceRenderClock`.
    if (this.localTick === 0) {
      this.lead = this.estimateLead();
      this.localTick = this.hostTick + this.lead;
      this.renderClock = this.hostTick - INTERP_DELAY;
    } else {
      this.syncClock();
    }

    this.reconcile();
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

    this.advanceRenderClock();
    this.applyWorld();
    this.rememberPrediction(frame.tick);
    this.queueOutgoing(frame);
    this.adjustLead();
  }

  /**
   * Anda o relógio de desenho um passo, perseguindo o instantâneo mais recente.
   *
   * O alvo é `hostTick − INTERP_DELAY`, que é onde a pose está pronta para ser
   * interpolada — um instantâneo atrás do mais novo, com o outro já em mão.
   */
  private advanceRenderClock(): void {
    this.renderClock = advanceRenderClock(this.renderClock, this.hostTick - INTERP_DELAY);
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

  /** Desvio visual do corpo, que o desenho soma à posição. */
  get offset(): THREE.Vector3 {
    return this.visualOffset;
  }

  /** Decai o desvio visual. Roda no quadro, com o `dt` real. */
  decayOffset(dt: number): void {
    const factor = Math.exp(-OFFSET_LAMBDA * dt);
    this.visualOffset.multiplyScalar(factor);
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
    waves.syncUniforms();

    this.applyCrew();
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

    // A **minha** roda não é escrita: ela já girou aqui, no mesmo passo em que o
    // comando saiu da minha mão. `Rudder.update` é integração pura de um comando
    // grampeado, então o host chega exatamente ao mesmo ângulo — e é isto que
    // tira a sensação de leme emperrado. O navio dele responde depois, o que não
    // é latência: é massa, e o jogador lê como massa.
    if (!mine) {
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
      // A peça que **eu** estou operando não é corrigida a cada instantâneo: a
      // mira é acumular-e-grampear dos mesmos deltas que o host aplica, então os
      // dois concordam sozinhos. Escrever por cima daria um cano que recua meio
      // grau quinze vezes por segundo enquanto se tenta mirar.
      const operatedByMe = mine && this.match.crew[0].controller.cannonIndex === i;
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
    if (to.breaches) this.applyBreaches(ship, to.breaches);
  }

  private applyBreaches(ship: Ship, incoming: WorldState['ships'][0]['breaches']): void {
    if (!incoming) return;
    const { breaches } = ship.damage;
    breaches.length = 0;
    for (const source of incoming) {
      breaches.push({
        id: source.id,
        local: source.local.clone(),
        normal: source.normal.clone(),
        area: source.area,
        repair: source.repair,
        inflow: 0,
      });
    }
  }

  /** O corpo do adversário é autoritativo; o meu, só nos campos que não prevejo. */
  private applyCrew(): void {
    // Índices invertidos como em `applyWorld`: local 1 é sempre o adversário, e
    // no fio ele é `this.remote`.
    const remote = this.match.crew[1].controller;
    const state = this.to.crew[this.remote]!;
    remote.local.copy(state.local);
    remote.yaw = state.yaw;
    remote.pitch = state.pitch;
    remote.station = state.station;
    remote.cannonIndex = state.cannonIndex;
    remote.grounded = state.grounded;
    remote.onLadder = state.onLadder;
    remote.atCapstan = state.atCapstan;

    // Do meu corpo, o posto vem sempre do host: assumir o timão depende de estado
    // do navio que este cliente não possui, e uma predição rejeitada arrancaria a
    // câmera do jogador. O custo some de graça dentro da transição de câmera que
    // já existe — ela dura 0,28 s, mais que qualquer ida e volta jogável.
    const mine = this.match.crew[0].controller;
    const mineState = this.to.crew[this.slot]!;
    mine.station = mineState.station;
    mine.cannonIndex = mineState.cannonIndex;
    mine.onLadder = mineState.onLadder;
    mine.atCapstan = mineState.atCapstan;
  }

  // -- predição -------------------------------------------------------------------

  private rememberPrediction(tick: number): void {
    const slot = this.historyPool.pop() ?? new THREE.Vector3();
    slot.copy(this.match.crew[0].controller.local);
    this.history.set(tick, slot);
    // Um segundo de histórico basta: o instantâneo que vai cobrar a predição
    // chega em menos de cem milissegundos.
    this.releaseHistory(tick - 60);
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

    const error = predicted.distanceTo(authoritative.local);
    this.predictionError = error;
    if (error < ERROR_IGNORE) return;

    const controller = this.match.crew[0].controller;

    if (error > ERROR_SNAP) {
      // Teleporte legítimo. Ir direto, e sem desvio: arrastar o desenho por um
      // metro e meio seria desenhar o jogador atravessando o convés.
      controller.local.copy(authoritative.local);
      this.visualOffset.set(0, 0, 0);
      this.releaseHistory(Number.POSITIVE_INFINITY);
      return;
    }

    // O desvio guarda a diferença **antes** de a posição ser corrigida, e o
    // desenho o soma de volta — o corpo pula para o lugar certo sem que se veja.
    this.visualOffset.add(_position.copy(controller.local).sub(authoritative.local));
    controller.local.copy(authoritative.local);
    this.releaseHistory(this.to.tick);
  }

  private releaseHistory(upTo: number): void {
    for (const [tick, vector] of this.history) {
      if (tick > upTo) continue;
      this.history.delete(tick);
      this.historyPool.push(vector);
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
    // Desliza a janela: o mais antigo cai fora.
    for (let i = this.outbox.length - 1; i > 0; i--) {
      copyInputFrame(this.outbox[i - 1]!, this.outbox[i]!);
    }
    copyInputFrame(frame, this.outbox[0]!);
    this.outboxCount = Math.min(this.outboxCount + 1, this.outbox.length);

    if (frame.tick % SEND_EVERY !== 0) return;
    this.client.sendFrame(encodeInput(this.outbox.slice(0, this.outboxCount)));
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
   * Ajusta o quanto o corpo corre à frente, pela fila do host.
   *
   * Fila vazia significa entrada chegando tarde: adiantar mais. Fila cheia
   * significa entrada chegando cedo demais e envelhecendo na espera, o que é
   * latência de comando pura: recuar. A assimetria é de propósito — a fila
   * **zerada** sobe dois de uma vez, porque ali já se está perdendo comando, e
   * perder comando é muito pior que jogar com trinta milissegundos a mais de
   * atraso. Para baixo, sempre de um em um.
   */
  private adjustLead(): void {
    this.leadTimer++;
    if (this.leadTimer < LEAD_ADJUST_EVERY) return;
    this.leadTimer = 0;

    if (this.depth === 0) this.lead = Math.min(this.lead + 2, LEAD_MAX);
    else if (this.depth < DEPTH_MIN) this.lead = Math.min(this.lead + 1, LEAD_MAX);
    else if (this.depth > DEPTH_MAX) this.lead = Math.max(this.lead - 1, LEAD_MIN);
  }
}
