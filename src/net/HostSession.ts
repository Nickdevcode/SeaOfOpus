/**
 * O lado que simula.
 *
 * O host roda `Match.fixedUpdate` exatamente como no duelo contra a máquina — a
 * única diferença é de onde vem a entrada do segundo navio: em vez do `ShipAI`,
 * ela vem da fila alimentada pela rede. Nenhuma linha de física sabe disso, e é
 * de propósito: um caminho de código só é um caminho só para divergir.
 *
 * ## Por que quinze instantâneos por segundo, e não sessenta
 *
 * Porque não muda nada que se veja e muda tudo que se paga. O casco é interpolado
 * do lado de lá, então mais pacotes dariam a mesma imagem; e a 60 Hz o mesmo
 * duelo custaria quatro vezes mais requests no plano gratuito. Quinze com
 * interpolação é a mesma suavidade por um quarto do preço.
 */

import { MessageType, QUANT } from '../../shared/protocol';
import type { Match } from '../game/Match';
import { createInputFrame, type InputFrame } from '../core/InputFrame';
import type { Ship } from '../ship/Ship';
import { InputBuffer } from './InputBuffer';
import { decodeInput, encodeSnapshot } from './snapshotCodec';
import type { RoomClient } from './RoomClient';

/** Um instantâneo a cada quatro passos: 15 Hz sobre uma simulação de 60. */
const SNAPSHOT_EVERY = 4;

/**
 * Instantâneos entre dois reenvios da lista de estrago, mesmo parada. Um por
 * segundo.
 *
 * O batimento que carrega o que a assinatura deixa de fora: o progresso do
 * reparo, que anda sem mudar nada estrutural. Uma vez por segundo é folgado
 * para a barra do rombo do adversário encolher de forma convincente, e raro o
 * bastante para a correção na barra de quem está pregando a tábua passar
 * despercebida — uma nudge por segundo contra quinze.
 *
 * É também a rede de segurança da assinatura: se duas listas diferentes um dia
 * derem o mesmo inteiro, o erro dura um segundo em vez de durar a partida.
 */
const RESEND_EVERY = 15;

export class HostSession {
  private readonly buffer = new InputBuffer();
  /** Quadros desempacotados de um lote. Reaproveitados — nada aloca por pacote. */
  private readonly incoming: InputFrame[] = Array.from({ length: 8 }, createInputFrame);

  /** Assinatura do estrago de cada casco, para saber se a lista mudou. */
  private lastDamageKeys: [number, number] = [-1, -1];
  /** Instantâneos desde o último envio da lista de estrago. Ver `RESEND_EVERY`. */
  private sinceDamageSent = 0;
  private sentOver = false;

  constructor(
    private readonly match: Match,
    private readonly client: RoomClient,
  ) {}

  /** Telemetria para o painel do F3. */
  get depth(): number {
    return this.buffer.depth;
  }

  get starves(): number {
    return this.buffer.starves;
  }

  reset(): void {
    this.buffer.reset();
    this.lastDamageKeys = [-1, -1];
    this.sinceDamageSent = 0;
    this.sentOver = false;
  }

  /** Um lote de entrada chegou do outro lado. */
  onFrame(frame: ArrayBuffer): void {
    const view = new DataView(frame);
    if (view.byteLength < 2 || view.getUint8(0) !== MessageType.Input) return;

    const count = decodeInput(frame, this.incoming);
    for (let i = 0; i < count; i++) this.buffer.push(this.incoming[i]!);
  }

  /** A entrada do navio inimigo neste passo. Nunca falta — ver `InputBuffer`. */
  enemyInput(tick: number): InputFrame {
    return this.buffer.consume(tick);
  }

  /**
   * A assinatura do estrago de um casco, para saber se ele mudou desde o
   * último instantâneo.
   *
   * ⚠️ **Era a contagem de rombos, e a contagem mente em três casos que
   * acontecem o tempo todo:**
   *
   * - Um tiro em cima de um rombo aberto **alarga** o buraco sem criar outro. O
   *   número não muda, e o outro lado continua vendo — e calculando o esguicho
   *   de — um rombo do tamanho antigo.
   * - O progresso do reparo anda de zero a um sem mexer no número. Quem olhava o
   *   casco do adversário nunca via a tábua sendo pregada.
   * - Um rombo fechar no mesmo intervalo em que outro abre deixa o número
   *   idêntico. A lista do outro lado congelava com um buraco fantasma e sem o
   *   buraco de verdade, e ficava assim **até a contagem mudar de novo**.
   *
   * A assinatura cobre o que **muda de uma vez**: quais rombos existem, quanto
   * cada um vale e quais tábuas estão pregadas. O progresso do reparo fica de
   * fora de propósito — ele anda continuamente, e pô-lo aqui faria a lista
   * inteira ser reenviada quinze vezes por segundo enquanto alguém trabalha. Do
   * lado de lá isso não seria só tráfego: quem está pregando a tábua prevê o
   * próprio progresso, e ser corrigido quinze vezes por segundo por um valor de
   * meia ida e volta atrás daria uma barra em dente de serra na mão de quem
   * está segurando o botão. Quem cuida do progresso é `RESEND_EVERY`.
   *
   * Quantizar igual ao codec é o que impede a lista de ser reenviada por causa
   * de uma diferença que não caberia no fio de qualquer forma. O resultado é um
   * inteiro de 32 bits misturado por multiplicação; uma colisão custa um
   * instantâneo atrasado, e não um estado errado para sempre, porque o campo é
   * reenviado na mudança seguinte e no batimento.
   */
  private damageKey(ship: Ship): number {
    const { damage } = ship;
    let key = damage.breaches.length * 31 + damage.patches.length;
    for (const breach of damage.breaches) {
      key = (Math.imul(key, 16777619) ^ breach.id) >>> 0;
      key = (Math.imul(key, 16777619) ^ Math.round(breach.area * QUANT.breachArea)) >>> 0;
    }
    for (const patch of damage.patches) {
      key = (Math.imul(key, 16777619) ^ patch.id) >>> 0;
    }
    return key;
  }

  /**
   * Depois do passo: manda o mundo, se for a vez.
   *
   * A lista de rombos e tábuas só entra quando **mudou** — ver `damageKey`. É um
   * campo condicional, não uma diferença: o quadro continua se lendo sozinho.
   */
  afterStep(tick: number): void {
    // ⚠️ **Acabou é acabou, e o instantâneo para aqui.** `Match.tick` congela
    // quando a partida sai de `fighting`, então a conta de cadência abaixo passa
    // a dar o mesmo resultado para sempre. Sem esta linha, o host que terminasse
    // num tick múltiplo de quatro mandava sessenta instantâneos por segundo de
    // um mundo parado — cada um deles um request pago na sala — até alguém
    // fechar a aba.
    if (this.sentOver) return;

    const over = this.match.state === 'won' || this.match.state === 'lost';

    // ⚠️ **E o fim não espera a vez.**
    //
    // Este era o defeito mais silencioso do duelo em rede, e ele engolia três de
    // cada quatro partidas. O naufrágio cai num passo qualquer; o instantâneo
    // sai de quatro em quatro. Se o casco fosse ao fundo num tick que não fosse
    // múltiplo de quatro, esta função saía aqui — e como `Match.tick` para de
    // andar no mesmo instante, ela ia sair aqui **em todos os passos
    // seguintes**, para sempre. O resultado nunca subia pelo lobby, e o lobby é
    // quem encerra a sala dos dois lados: os dois jogadores ficavam olhando um
    // mar congelado, sem tela de fim, sem erro e sem nada a fazer além de
    // recarregar a página.
    if (!over && tick % SNAPSHOT_EVERY !== 0) return;

    const keys: [number, number] = [
      this.damageKey(this.match.playerShip),
      this.damageKey(this.match.enemyShip),
    ];
    const changed = keys[0] !== this.lastDamageKeys[0] || keys[1] !== this.lastDamageKeys[1];
    const heartbeat = ++this.sinceDamageSent >= RESEND_EVERY;
    const includeBreaches = changed || heartbeat;
    if (includeBreaches) {
      this.lastDamageKeys = keys;
      this.sinceDamageSent = 0;
    }

    this.client.sendFrame(
      encodeSnapshot(this.match, {
        bufferDepth: this.buffer.depth,
        // Zerado ao ser lido: o que vai no fio é sempre "desde o último
        // instantâneo", que é a janela que o cliente sabe interpretar.
        starved: this.buffer.takeStarvedSinceReport(),
        ackTick: this.buffer.lastConsumedTick,
        includeBreaches,
        over,
        winner: this.match.state === 'won' ? 0 : 1,
      }),
    );

    // A fila de eventos é esvaziada **aqui**, e só aqui: ela existe justamente
    // para acumular entre um instantâneo e o próximo. Ver `Match.netEvents`.
    this.match.netEvents.length = 0;

    // O resultado sobe uma vez só, pelo lobby: é ele que encerra a sala dos dois
    // lados. O instantâneo carrega a mesma notícia para o caso de a mensagem de
    // lobby chegar depois — quem vê primeiro encerra.
    if (over && !this.sentOver) {
      this.sentOver = true;
      this.client.sendLobby({ t: 'result', winner: this.match.state === 'won' ? 0 : 1 });
    }
  }
}
