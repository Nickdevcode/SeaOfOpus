/**
 * A entrada de um jogador num passo de simulação, num formato que cabe no fio.
 *
 * É a **única** coisa que atravessa a rede do lado de quem joga: dezesseis bytes
 * por passo, sessenta vezes por segundo. Todo o resto do estado nasce de aplicar
 * estes campos à mesma simulação nos dois lados.
 *
 * ## Por que um struct, e não o `Input`
 *
 * `Input` responde "o que está acontecendo agora, neste quadro". A simulação
 * precisa de "o que aconteceu **neste tick**", que é outra pergunta: um quadro de
 * 144 Hz não chega a cobrir um tick, e um de 20 Hz cobre três. Quem faz a
 * tradução é `InputSampler`; o que sai dela é isto.
 *
 * ## A regra que não se quebra
 *
 * ⚠️ **A ordem dos bits é o formato de rede.** Reordenar `InputBit` troca pulo por
 * tiro entre duas versões do jogo que se encontrarem numa sala — e o sintoma não é
 * um erro, é um adversário que atira ao andar. Acrescentar no fim é seguro;
 * remover e reordenar, nunca.
 */

/**
 * As onze ações de jogo, uma por bit.
 *
 * Objeto congelado em vez de `const enum`: o `tsconfig` tem `isolatedModules`, e
 * `const enum` não sobrevive à compilação arquivo-a-arquivo que ele exige.
 *
 * Ficam de fora `freeCamera`, `controls`, `debug` e `pause` — são comandos da
 * casca, não do marujo. Nenhum deles muda um grama de física, e mandá-los pela
 * rede seria deixar o adversário abrir a tela de ajustes do outro.
 */
export const InputBit = {
  MoveForward: 1 << 0,
  MoveBack: 1 << 1,
  MoveLeft: 1 << 2,
  MoveRight: 1 << 3,
  Sprint: 1 << 4,
  Jump: 1 << 5,
  Interact: 1 << 6,
  Exit: 1 << 7,
  Reload: 1 << 8,
  Fire: 1 << 9,
  Aim: 1 << 10,
} as const;

export interface InputFrame {
  /** O passo a que esta entrada pertence. É o carimbo que a rede usa. */
  tick: number;
  /** Bitmask do que está segurado no instante da amostra. */
  held: number;
  /**
   * Bitmask das bordas **acumuladas** desde o tick anterior.
   *
   * Separado de `held` porque as duas perguntas se comportam diferente quando um
   * pacote se perde: segurar o W durante um engasgo tem de continuar andando,
   * mas repetir a borda de `fire` dispara o canhão duas vezes. Ver a política de
   * repetição em `InputBuffer`.
   */
  pressed: number;
  /** Eixo de caminhada já normalizado, -1..1. */
  moveX: number;
  moveY: number;
  /** Delta de olhar acumulado desde o tick anterior, em radianos. */
  lookX: number;
  lookY: number;
  /**
   * O olhar **absoluto** de quem mandou este quadro, em radianos.
   *
   * Só vale quando `absoluteView` é `true`, que é o caso dos quadros que vieram
   * pela rede. Ver `PlayerController.applyLook` para o defeito que isto conserta
   * — em resumo: delta de olhar não sobrevive a pacote perdido, e o que quebra
   * quando ele não sobrevive não é a cabeça do outro, é o foco de interação
   * dele.
   */
  yaw: number;
  pitch: number;
  /**
   * `true` quando `yaw`/`pitch` mandam e os deltas devem ser ignorados.
   *
   * Uma bandeira explícita, e não um valor sentinela em `yaw`: o quadro é
   * preenchido em dois lugares muito diferentes (o amostrador local e o
   * decodificador de rede), e "zero" é um ângulo perfeitamente válido.
   */
  absoluteView: boolean;
}

/** Um `InputFrame` zerado, para preencher pools sem alocar depois. */
export function createInputFrame(): InputFrame {
  return {
    tick: 0,
    held: 0,
    pressed: 0,
    moveX: 0,
    moveY: 0,
    lookX: 0,
    lookY: 0,
    yaw: 0,
    pitch: 0,
    absoluteView: false,
  };
}

export function copyInputFrame(source: InputFrame, target: InputFrame): void {
  target.tick = source.tick;
  target.held = source.held;
  target.pressed = source.pressed;
  target.moveX = source.moveX;
  target.moveY = source.moveY;
  target.lookX = source.lookX;
  target.lookY = source.lookY;
  target.yaw = source.yaw;
  target.pitch = source.pitch;
  target.absoluteView = source.absoluteView;
}

export function clearInputFrame(frame: InputFrame): void {
  frame.held = 0;
  frame.pressed = 0;
  frame.moveX = 0;
  frame.moveY = 0;
  frame.lookX = 0;
  frame.lookY = 0;
  // `yaw`, `pitch` e `absoluteView` **não** são zerados: um quadro limpo entra
  // no pool para ser reescrito por inteiro, e zerar o olhar aqui seria a mesma
  // classe de erro que a política de fome do `InputBuffer` evita — inventar uma
  // cabeça virada para a frente onde o que se sabe é "nada mudou".
}

/** A ação está segurada neste passo. */
export function held(frame: InputFrame, bit: number): boolean {
  return (frame.held & bit) !== 0;
}

/** A ação foi acionada em algum ponto entre o passo anterior e este. */
export function pressed(frame: InputFrame, bit: number): boolean {
  return (frame.pressed & bit) !== 0;
}
