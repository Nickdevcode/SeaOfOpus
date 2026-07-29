/**
 * A fila de entrada do host: absorve o jitter da rede sem deixar a simulação
 * parada.
 *
 * A rede não entrega quadros num ritmo constante — ela entrega em rajadas, com
 * buracos. A simulação, ao contrário, precisa de exatamente um quadro por passo,
 * sessenta vezes por segundo. Esta fila é o amortecedor entre as duas, e o
 * `depth` dela vai em todo instantâneo para que o guest ajuste o quanto se
 * adianta.
 *
 * ## A política de fome é onde mora o bug sutil
 *
 * Quando a fila esvazia — e ela vai esvaziar —, o host tem de simular alguma
 * coisa. Repetir o último quadro é o certo, mas **não inteiro**, e as três regras
 * são independentes:
 *
 * 1. **`pressed` zera.** Uma borda repetida é um comando dado duas vezes. Um
 *    engasgo de meio segundo viraria uma saraivada de tiros que o jogador não
 *    deu — e ele veria a munição sumir sem entender.
 * 2. **`look` zera.** O olhar é um delta, não um estado. Repeti-lo faz a cabeça
 *    do adversário girar sozinha, cada vez mais rápido quanto pior a rede.
 * 3. **`held` e os eixos repetem.** Segurar o W durante um engasgo tem de
 *    continuar andando. Zerar aqui daria um adversário que trava a cada
 *    oscilação de rede e depois volta a andar — o "elástico" clássico.
 */

import { clearInputFrame, copyInputFrame, createInputFrame, type InputFrame } from '../core/InputFrame';

/**
 * Quadros guardados.
 *
 * Sessenta são um segundo de rede. Mais que isso seria guardar entrada tão velha
 * que já não vale a pena aplicar: um comando de um segundo atrás executado agora
 * é pior que comando nenhum.
 */
const CAPACITY = 60;

export class InputBuffer {
  /** Quadros à espera, ordenados por tick. Vai em todo instantâneo. */
  depth = 0;
  /** Quantas vezes a fila esvaziou. Telemetria: um número alto é rede ruim. */
  starves = 0;
  /** Último tick consumido, para o guest medir a ida e volta. */
  lastConsumedTick = 0;

  private readonly frames = new Map<number, InputFrame>();
  private readonly pool: InputFrame[] = [];
  private readonly last: InputFrame = createInputFrame();
  private readonly out: InputFrame = createInputFrame();

  /**
   * Guarda um quadro recebido.
   *
   * Duplicatas são descartadas em silêncio — e são esperadas, porque o cliente
   * manda cada quadro mais de uma vez de propósito (ver `INPUT_BATCH`). O mesmo
   * vale para quadros de ticks que já passaram: chegaram tarde, e aplicá-los
   * seria voltar no tempo.
   */
  push(frame: InputFrame): void {
    if (frame.tick <= this.lastConsumedTick) return;
    if (this.frames.has(frame.tick)) return;
    if (this.frames.size >= CAPACITY) return;

    const stored = this.pool.pop() ?? createInputFrame();
    copyInputFrame(frame, stored);
    this.frames.set(frame.tick, stored);
    this.depth = this.frames.size;
  }

  /**
   * O quadro deste passo.
   *
   * @returns o quadro a aplicar. Nunca `null` — a simulação não pode pular um
   *   passo à espera da rede, então a fome é resolvida com repetição, e não com
   *   ausência. Ver o cabeçalho.
   */
  consume(tick: number): InputFrame {
    this.lastConsumedTick = tick;

    const stored = this.frames.get(tick);
    if (stored) {
      this.frames.delete(tick);
      copyInputFrame(stored, this.last);
      clearInputFrame(stored);
      this.pool.push(stored);
      this.dropStale(tick);
      this.depth = this.frames.size;

      copyInputFrame(this.last, this.out);
      this.out.tick = tick;
      return this.out;
    }

    this.starves++;
    this.dropStale(tick);
    this.depth = this.frames.size;

    // Fome: repete o que dá para repetir. Ver as três regras no cabeçalho.
    this.out.tick = tick;
    this.out.held = this.last.held;
    this.out.moveX = this.last.moveX;
    this.out.moveY = this.last.moveY;
    this.out.pressed = 0;
    this.out.lookX = 0;
    this.out.lookY = 0;
    return this.out;
  }

  reset(): void {
    for (const frame of this.frames.values()) {
      clearInputFrame(frame);
      this.pool.push(frame);
    }
    this.frames.clear();
    clearInputFrame(this.last);
    this.depth = 0;
    this.starves = 0;
    this.lastConsumedTick = 0;
  }

  /** Devolve ao pool o que ficou para trás. */
  private dropStale(tick: number): void {
    for (const [key, frame] of this.frames) {
      if (key > tick) continue;
      this.frames.delete(key);
      clearInputFrame(frame);
      this.pool.push(frame);
    }
  }
}
