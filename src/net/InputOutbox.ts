/**
 * A janela de comandos que sai do cliente, e a regra de que ela **não tem
 * buracos**.
 *
 * Módulo próprio, e não um punhado de campos privados em `GuestSession`, pelo
 * mesmo motivo de `renderClock`: isto é aritmética sobre inteiros e bits, e é o
 * tipo de coisa que se prova num teste em vez de se conferir olhando a tela.
 * `GuestSession` importa Three.js e o `Match` inteiro; isto aqui não importa
 * nada além do formato do quadro.
 *
 * ## O contrato
 *
 * O host consome **um tick por passo**, em ordem, e descarta silenciosamente
 * qualquer quadro cujo tick ele já tenha passado (é assim que a redundância do
 * lote funciona — ver `INPUT_BATCH`). Isso dá duas obrigações a quem envia:
 *
 * 1. **Nenhum tick pode faltar.** Um tick que nunca foi enviado é um passo em
 *    que o host não acha comando: ele conta uma fome, repete o último comando
 *    conhecido e relata a fome ao cliente — que responde correndo mais à frente,
 *    o que provoca outra correção de relógio e outro buraco. É uma catraca, e
 *    girando ela chega ao teto de avanço com o jogador vendo o próprio marujo
 *    andar sem obedecer.
 * 2. **Nenhum tick pode aparecer duas vezes com conteúdos diferentes.** O
 *    segundo é descartado como duplicata, e com ele vai embora o comando daquele
 *    passo: um `F` no timão, um tiro, um pulo.
 *
 * As duas coisas acontecem pelo mesmo motivo, e não por causa da rede: o relógio
 * de predição do cliente é **corrigido** de um em um para acompanhar o do host
 * (ver `GuestSession.syncClock`), e uma correção para cima pula um carimbo,
 * enquanto uma para baixo repete o anterior. Sem esta classe, cada correção de
 * relógio custava um comando.
 *
 * ## O que a costura preserva
 *
 * O tick que a correção pulou vira uma **repetição** do anterior, seguindo a
 * mesma política de `InputBuffer`: o que é estado (teclas seguradas, eixos,
 * olhar absoluto) repete, o que é borda não. É a verdade sobre aquele instante —
 * nada mudou nele, porque ele não chegou a existir.
 *
 * O tick repetido é **fundido**: as bordas entram por OU, o estado vale o mais
 * recente e o olhar acumulado se soma. É exatamente o que `InputSampler` faz
 * quando dois quadros do monitor caem dentro do mesmo passo.
 */

import { INPUT_BATCH } from '../../shared/protocol';
import { copyInputFrame, createInputFrame, type InputFrame } from '../core/InputFrame';

/**
 * Lacuna máxima que vale a pena costurar, em passos.
 *
 * O que separa **deriva** de **salto**. A correção de relógio anda de um em um,
 * então qualquer buraco legítimo é de um passo; uma lacuna grande é o relógio
 * saltando (a aba dormiu, a rede sumiu por segundos), e preenchê-la seria mandar
 * segundos de comando fantasma. Salto é caso de `InputBuffer.claimAhead`, que
 * fecha o vão de uma vez do outro lado.
 */
const MAX_STITCH = INPUT_BATCH;

export class InputOutbox {
  /** Os últimos quadros, do mais novo para o mais velho. */
  private readonly frames: InputFrame[] = Array.from({ length: INPUT_BATCH }, createInputFrame);
  private count = 0;
  /** O tick mais novo que já entrou. `-1` antes do primeiro. */
  private newest = -1;
  /** Rascunho da repetição. Nada aqui aloca por passo. */
  private readonly filler = createInputFrame();

  /** O lote a mandar: os mais novos primeiro. Válido até o próximo `add`. */
  get batch(): readonly InputFrame[] {
    return this.frames.slice(0, this.count);
  }

  /** Quantos quadros o lote leva agora. */
  get size(): number {
    return this.count;
  }

  reset(): void {
    this.count = 0;
    this.newest = -1;
  }

  /**
   * Põe o comando deste passo na janela, costurando o que o relógio tiver feito.
   *
   * @param frame o quadro do passo. É copiado — quem chama pode reaproveitá-lo.
   */
  add(frame: InputFrame): void {
    if (this.newest >= 0 && frame.tick <= this.newest) {
      this.merge(frame);
      return;
    }

    this.stitch(frame.tick);
    this.push(frame);
    this.newest = frame.tick;
  }

  /** Empurra um quadro, jogando o mais antigo fora. */
  private push(frame: InputFrame): void {
    for (let i = this.frames.length - 1; i > 0; i--) {
      copyInputFrame(this.frames[i - 1]!, this.frames[i]!);
    }
    copyInputFrame(frame, this.frames[0]!);
    this.count = Math.min(this.count + 1, this.frames.length);
  }

  /** Preenche os ticks que a correção do relógio pulou. Ver o cabeçalho. */
  private stitch(tick: number): void {
    const first = this.newest + 1;
    if (this.newest < 0 || tick - first > MAX_STITCH) return;

    for (let missing = first; missing < tick; missing++) {
      copyInputFrame(this.frames[0]!, this.filler);
      this.filler.tick = missing;
      this.filler.pressed = 0;
      this.filler.lookX = 0;
      this.filler.lookY = 0;
      this.push(this.filler);
    }
  }

  /** Funde um comando num tick que já está na janela. Ver o cabeçalho. */
  private merge(frame: InputFrame): void {
    let slot: InputFrame | null = null;
    for (let i = 0; i < this.count; i++) {
      if (this.frames[i]!.tick === frame.tick) {
        slot = this.frames[i]!;
        break;
      }
    }

    // Saiu da janela: o relógio saltou para trás de verdade, e o que estava aqui
    // descreve um futuro que já não vale. Recomeçar é o certo.
    if (!slot) {
      this.count = 0;
      this.push(frame);
      this.newest = frame.tick;
      return;
    }

    slot.pressed |= frame.pressed;
    slot.held = frame.held;
    slot.moveX = frame.moveX;
    slot.moveY = frame.moveY;
    slot.lookX += frame.lookX;
    slot.lookY += frame.lookY;
    slot.yaw = frame.yaw;
    slot.pitch = frame.pitch;
    slot.absoluteView = frame.absoluteView;
  }
}
