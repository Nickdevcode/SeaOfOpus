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

import { MessageType } from '../../shared/protocol';
import type { Match } from '../game/Match';
import { createInputFrame, type InputFrame } from '../core/InputFrame';
import { InputBuffer } from './InputBuffer';
import { decodeInput, encodeSnapshot } from './snapshotCodec';
import type { RoomClient } from './RoomClient';

/** Um instantâneo a cada quatro passos: 15 Hz sobre uma simulação de 60. */
const SNAPSHOT_EVERY = 4;

export class HostSession {
  private readonly buffer = new InputBuffer();
  /** Quadros desempacotados de um lote. Reaproveitados — nada aloca por pacote. */
  private readonly incoming: InputFrame[] = Array.from({ length: 8 }, createInputFrame);

  /** Contagem de rombos do último instantâneo, para saber se a lista mudou. */
  private lastBreachCounts: [number, number] = [-1, -1];
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
    this.lastBreachCounts = [-1, -1];
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
   * Depois do passo: manda o mundo, se for a vez.
   *
   * A lista de rombos só entra quando **mudou**, e a comparação é por contagem —
   * um rombo só nasce, some ou é tapado, e qualquer dos três muda o número. É um
   * campo condicional, não uma diferença: o quadro continua se lendo sozinho.
   */
  afterStep(tick: number): void {
    if (tick % SNAPSHOT_EVERY !== 0) return;

    const counts: [number, number] = [
      this.match.playerShip.damage.breaches.length,
      this.match.enemyShip.damage.breaches.length,
    ];
    const includeBreaches =
      counts[0] !== this.lastBreachCounts[0] || counts[1] !== this.lastBreachCounts[1];
    if (includeBreaches) this.lastBreachCounts = counts;

    const over = this.match.state === 'won' || this.match.state === 'lost';

    this.client.sendFrame(
      encodeSnapshot(this.match, {
        bufferDepth: this.buffer.depth,
        ackTick: this.buffer.lastConsumedTick,
        includeBreaches,
        over,
        winner: this.match.state === 'won' ? 0 : 1,
      }),
    );

    // O resultado sobe uma vez só, pelo lobby: é ele que encerra a sala dos dois
    // lados. O instantâneo carrega a mesma notícia para o caso de a mensagem de
    // lobby chegar depois — quem vê primeiro encerra.
    if (over && !this.sentOver) {
      this.sentOver = true;
      this.client.sendLobby({ t: 'result', winner: this.match.state === 'won' ? 0 : 1 });
    }
  }
}
