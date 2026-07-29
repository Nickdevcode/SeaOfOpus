/**
 * A ponte entre o relógio do monitor e o relógio da simulação.
 *
 * `Input` fala em quadros; a simulação fala em passos de 60 Hz. Os dois quase
 * nunca coincidem, e é aí que moram dois bugs que não aparecem na máquina de quem
 * escreveu o código:
 *
 * - **A 144 fps** há 2,4 quadros por passo. Uma borda de tecla que caia num quadro
 *   que nenhum passo leu simplesmente **some** — o jogador aperta pular e não
 *   pula, uma vez a cada tantas. Some mais em quem tem o monitor melhor.
 * - **A 20 fps** um quadro cobre três passos. Ler a borda direto em cada passo
 *   **repete** o comando: um toque em disparar sai como três tiros.
 *
 * A solução é a mesma dos dois lados: as bordas se **acumulam** por OR enquanto os
 * quadros passam, e o primeiro passo que as consome as zera. O olhar segue a mesma
 * regra somando em vez de OR — os deltas de dois quadros dentro do mesmo passo têm
 * de virar um giro só, e não o último deles.
 */

import { InputBit, createInputFrame, type InputFrame } from './InputFrame';
import type { Action, Input } from './Input';

/** Ação de jogo → bit. A ordem de `InputBit` é o formato de rede; esta tabela só a lê. */
const ACTION_BITS: ReadonlyArray<readonly [Action, number]> = [
  ['moveForward', InputBit.MoveForward],
  ['moveBack', InputBit.MoveBack],
  ['moveLeft', InputBit.MoveLeft],
  ['moveRight', InputBit.MoveRight],
  ['sprint', InputBit.Sprint],
  ['jump', InputBit.Jump],
  ['interact', InputBit.Interact],
  ['exit', InputBit.Exit],
  ['reload', InputBit.Reload],
  ['fire', InputBit.Fire],
  ['aim', InputBit.Aim],
];

export class InputSampler {
  /** O que se acumulou desde o último passo consumido. */
  private readonly pending: InputFrame = createInputFrame();
  /** O que o passo atual recebe. Reaproveitado — nada aqui aloca por tick. */
  private readonly current: InputFrame = createInputFrame();

  /**
   * `false` enquanto o jogador não deve comandar nada (menu aberto, câmera
   * solta). Continua amostrando zeros, e não parando de amostrar: um passo sem
   * entrada é uma informação, e no online ele precisa ser enviado igual.
   */
  private live = true;

  /**
   * O olhar que chegou depois do último passo e ainda não foi consumido.
   *
   * É o **resíduo** que mantém a câmera na taxa do monitor enquanto a cabeça só
   * anda a 60 Hz. Fica aqui, e não numa cópia dentro do controlador, para haver
   * uma fonte só: com dois acumuladores, o dia em que um deles fosse grampeado
   * (o `pitch` tem limite) e o outro não, a soma `ângulo + resíduo` deixaria de
   * ser contínua e a vista daria um tranco a cada passo. Ver
   * `PlayerController.syncView`.
   */
  get pendingLookX(): number {
    return this.pending.lookX;
  }

  get pendingLookY(): number {
    return this.pending.lookY;
  }

  setLive(live: boolean): void {
    if (this.live === live) return;
    this.live = live;
    // Ao congelar, o que estava acumulado morre junto. Sem isto, o `interact`
    // apertado no quadro em que o menu abriu seria entregue ao passo seguinte —
    // e o jogador voltaria ao convés com uma ação que ele deu ao menu.
    this.pending.held = 0;
    this.pending.pressed = 0;
    this.pending.moveX = 0;
    this.pending.moveY = 0;
    this.pending.lookX = 0;
    this.pending.lookY = 0;
  }

  /** Roda uma vez por quadro, depois de `Input.beginFrame`. */
  sample(input: Input): void {
    if (!this.live) return;

    let held = 0;
    let pressedNow = 0;
    for (const [action, bit] of ACTION_BITS) {
      if (input.isDown(action)) held |= bit;
      if (input.wasPressed(action)) pressedNow |= bit;
    }

    // `held` e os eixos são **estado**: vale o último quadro visto, porque é o
    // que descreve o instante em que o passo vai acontecer.
    this.pending.held = held;
    const move = input.getMoveAxis();
    this.pending.moveX = move.x;
    this.pending.moveY = move.y;

    // Bordas e olhar são **acúmulo**: nenhum quadro pode ser perdido entre dois
    // passos. Ver o cabeçalho.
    this.pending.pressed |= pressedNow;
    this.pending.lookX += input.look.x;
    this.pending.lookY += input.look.y;
  }

  /**
   * O quadro de entrada deste passo. Zera o que foi consumido.
   *
   * O objeto devolvido é reaproveitado a cada chamada: quem precisar guardá-lo
   * (o histórico de predição, a fila de envio) tem de copiar com
   * `copyInputFrame`.
   */
  consume(tick: number): InputFrame {
    const frame = this.current;
    frame.tick = tick;
    frame.held = this.pending.held;
    frame.pressed = this.pending.pressed;
    frame.moveX = this.pending.moveX;
    frame.moveY = this.pending.moveY;
    frame.lookX = this.pending.lookX;
    frame.lookY = this.pending.lookY;

    this.pending.pressed = 0;
    this.pending.lookX = 0;
    this.pending.lookY = 0;

    return frame;
  }
}
