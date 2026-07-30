/**
 * O corte para o preto que cobre o resgate.
 *
 * É o único momento do jogo em que o corpo do jogador troca de lugar sem ele ter
 * andado até lá: pedir socorro na água põe o marujo de volta no convés do próprio
 * navio, que pode estar a duzentos metros. Sem o corte, o que se vê é a câmera
 * sendo arrancada do mar e plantada no convés num quadro — a leitura é de bug, não
 * de resgate.
 *
 * ## A forma da curva, e por que ela não é simétrica
 *
 * **Preto imediato, espera, e volta lenta.** Um esmaecimento de saída seria a
 * escolha bonita e a errada: durante ele o teleporte já aconteceu, então o jogador
 * veria o convés surgindo *por trás* do mar que está desaparecendo. O corte tem de
 * fechar antes de o corpo se mexer, e a única forma de garantir isso sem acoplar a
 * interface ao passo de física é fechar **rápido**. Sessenta milissegundos são
 * quatro quadros: rápido demais para se ler como transição, lento o bastante para
 * não ser um piscar.
 *
 * A volta é o oposto: ela é a única parte que o jogador de fato assiste, e é onde
 * mora a impressão de ter sido puxado para bordo. Oitocentos milissegundos com
 * `smoothstep` é o tempo de abrir os olhos.
 *
 * A espera no meio é o que dá peso à coisa. Sem ela o resgate seria instantâneo e
 * gratuito, e cair no mar deixaria de custar — e cair no mar tem de custar tempo,
 * que é a única moeda deste duelo.
 *
 * ## Por que não é CSS
 *
 * Porque `base.css` honra `prefers-reduced-motion` reduzindo **toda** animação a
 * 0,01 ms, e isto não é movimento decorativo: é o pano que esconde o teleporte.
 * Cortado a zero, o jogador com essa preferência ligada veria exatamente o defeito
 * que o pano existe para cobrir. Uma opacidade por quadro, escrita só quando ela
 * muda, custa menos que a `@keyframes` que ela substitui.
 */

import '../styles/blackout.css';

/** Quanto o preto leva para fechar, em segundos. Ver o cabeçalho. */
const FADE_IN = 0.06;
/** Quanto ele fica cheio. */
const HOLD = 1.14;
/** E quanto leva para abrir. Os três somam 2 s. */
const FADE_OUT = 0.8;

const TOTAL = FADE_IN + HOLD + FADE_OUT;

const smoothstep = (t: number): number => t * t * (3 - 2 * t);

export class Blackout {
  private readonly root: HTMLDivElement;
  /** Segundos desde o começo do corte. Negativo quando não há corte nenhum. */
  private elapsed = -1;
  /** Última opacidade escrita no DOM. Ver `write`. */
  private written = 0;

  constructor(parent: HTMLElement) {
    this.root = document.createElement('div');
    this.root.className = 'blackout';
    this.root.hidden = true;
    // Puramente visual: não há texto por baixo e não há nada a anunciar.
    this.root.setAttribute('aria-hidden', 'true');
    parent.appendChild(this.root);
  }

  /** `true` enquanto o corte está no ar. */
  get active(): boolean {
    return this.elapsed >= 0;
  }

  /**
   * Começa um corte. Chamar de novo no meio de um recomeça do zero — o que é o
   * certo: dois resgates seguidos são dois cortes, não um mais longo.
   */
  play(): void {
    this.elapsed = 0;
    this.root.hidden = false;
    this.write(0);
  }

  /** Roda no quadro, com o `dt` real. */
  update(dt: number): void {
    if (this.elapsed < 0) return;

    this.elapsed += dt;
    if (this.elapsed >= TOTAL) {
      this.elapsed = -1;
      this.write(0);
      this.root.hidden = true;
      return;
    }

    this.write(this.opacityAt(this.elapsed));
  }

  /** Apaga o corte na hora. É o que a volta ao menu precisa. */
  clear(): void {
    if (this.elapsed < 0) return;
    this.elapsed = -1;
    this.write(0);
    this.root.hidden = true;
  }

  dispose(): void {
    this.root.remove();
  }

  private opacityAt(t: number): number {
    if (t < FADE_IN) return smoothstep(t / FADE_IN);
    if (t < FADE_IN + HOLD) return 1;
    return 1 - smoothstep((t - FADE_IN - HOLD) / FADE_OUT);
  }

  /**
   * Escreve a opacidade, e só quando ela muda o bastante para aparecer.
   *
   * Um centésimo é menos de três degraus dos 256 níveis com que a composição do
   * navegador trabalha — abaixo disso o `style` é reescrito para produzir o mesmo
   * pixel. É o mesmo cuidado de `Prompts`, e pelo mesmo motivo: tocar no DOM é a
   * parte cara.
   */
  private write(value: number): void {
    if (Math.abs(value - this.written) < 0.01 && value !== 0 && value !== 1) return;
    this.written = value;
    this.root.style.opacity = value.toFixed(3);
  }
}
