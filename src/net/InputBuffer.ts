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

/**
 * Fila a partir da qual se aceita um quadro do futuro. Ver `claimAhead`.
 *
 * Oito quadros são 133 ms de comando guardado — muito acima do que o jitter de
 * uma conexão saudável produz, e muito abaixo dos vinte e um que denunciaram o
 * defeito. Entre os dois há folga de sobra para a política normal continuar
 * sendo a normal.
 */
const AHEAD_THRESHOLD = 8;

export class InputBuffer {
  /** Quadros à espera, ordenados por tick. Vai em todo instantâneo. */
  depth = 0;
  /** Quantas vezes a fila esvaziou. Telemetria: um número alto é rede ruim. */
  starves = 0;
  /**
   * Fomes desde o último instantâneo enviado.
   *
   * Vai no fio, e não é telemetria: é o sinal com que o cliente decide se
   * precisa correr mais à frente. Inferir isso da profundidade da fila — que era
   * o que se fazia — não funciona, porque a fila fica em zero tanto quando o
   * comando chega tarde quanto quando ele chega na hora exata.
   */
  private starvedSinceReport = 0;
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

    const stored = this.frames.get(tick) ?? this.claimAhead(tick);
    if (stored) {
      this.frames.delete(stored.tick);
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
    this.starvedSinceReport = Math.min(this.starvedSinceReport + 1, 255);
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
    // O olhar absoluto **repete**, e é o oposto do delta: repetir um incremento
    // gira a cabeça sozinha, repetir uma posição a deixa parada, que é o que
    // "nada mudou" quer dizer. Ver `PlayerController.applyLook`.
    this.out.yaw = this.last.yaw;
    this.out.pitch = this.last.pitch;
    this.out.absoluteView = this.last.absoluteView;
    return this.out;
  }

  /**
   * O quadro mais antigo da fila, quando **tudo** que há nela é futuro.
   *
   * ⚠️ Existe por causa de um estado que parece impossível e não é: a fila cheia
   * e o host passando fome ao mesmo tempo. Medido num duelo real — 21 quadros
   * guardados e 1.340 fomes acumuladas, com o jogador do outro lado relatando
   * que **não conseguia controlar o barco**.
   *
   * A causa é um salto no relógio do cliente. Quando a janela de quem simula
   * congela (uma aba em segundo plano basta) e volta, os dois relógios divergem
   * o bastante para o cliente saltar em vez de derivar — e o salto abre um
   * **buraco** na numeração: os ticks pulados nunca foram enviados, e nunca
   * serão. O host, consumindo um por um, encontra buraco em todos eles, repete o
   * último comando conhecido e passa a ignorar tudo que o jogador faz, enquanto
   * a fila engorda com quadros de um futuro que ele levaria vinte segundos para
   * alcançar.
   *
   * Aceitar o mais antigo disponível fecha o buraco em um passo: o comando é de
   * um instante ligeiramente diferente do pedido — e é o comando **certo**, em
   * vez de um comando velho repetido. A guarda é a fila estar visivelmente
   * gorda, para que a política normal (esperar o quadro certo chegar) continue
   * valendo no jitter do dia a dia.
   */
  private claimAhead(tick: number): InputFrame | null {
    if (this.frames.size < AHEAD_THRESHOLD) return null;

    let earliest: InputFrame | null = null;
    for (const frame of this.frames.values()) {
      if (frame.tick <= tick) continue;
      if (!earliest || frame.tick < earliest.tick) earliest = frame;
    }
    return earliest;
  }

  /** Fomes desde o último instantâneo. Zerado por quem as reporta. */
  takeStarvedSinceReport(): number {
    const value = this.starvedSinceReport;
    this.starvedSinceReport = 0;
    return value;
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
    this.starvedSinceReport = 0;
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
