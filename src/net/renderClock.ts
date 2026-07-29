/**
 * O relógio de **desenho** do cliente que não simula, e o fator que sai dele.
 *
 * Módulo próprio, e não dois métodos privados de `GuestSession`, por uma razão
 * prática: assim como o relógio de predição, este é aritmética pura sobre
 * inteiros e frações, e é o tipo de coisa que se prova num teste em vez de se
 * conferir olhando a tela. `GuestSession` importa Three.js e o `Match` inteiro;
 * isto aqui não importa nada, e é o que permite `tests/netclock.ts` exercitá-lo
 * de verdade em vez de reescrever a lógica numa cópia que pode divergir.
 *
 * ## O problema que ele resolve
 *
 * O instantâneo chega a cada quatro passos; a tela desenha a cada um. Quem
 * desenha precisa, portanto, de um relógio **próprio**, que ande sozinho entre
 * dois pacotes e seja apenas corrigido por eles.
 *
 * ## E a armadilha que ele tem
 *
 * A primeira versão perseguia `hostTick − atraso` a cada passo, com correção
 * proporcional ao desvio. Parece a coisa certa e não é, porque **`hostTick` é um
 * degrau, não uma rampa**: ele fica parado quatro passos e sobe quatro de uma
 * vez. Perseguir um degrau com ganho proporcional dá exatamente o que a teoria
 * de controle promete — um dente de serra. Medido: o mundo avançava 1,00 tick no
 * passo seguinte ao pacote, depois 0,90, 0,81 e 0,75, e recomeçava. A velocidade
 * de tudo que se vê oscilando 25% a quinze hertz, o que o jogador sente como
 * **tremor ao andar**, e o que nenhuma média de quadro revela porque a média
 * está certa.
 *
 * A forma correta é a que esta versão usa: manter uma **estimativa do relógio do
 * host** que anda um por passo (uma rampa, como o original) e cuja *fase* é
 * corrigida a cada pacote. O relógio de desenho é derivado dela por subtração,
 * então ele herda a rampa e nunca a dinâmica da correção. É um laço de primeira
 * ordem, e é o mesmo desenho que um sincronizador de relógio usa.
 */

/**
 * Fração do desvio de fase absorvida a cada instantâneo.
 *
 * Um quinto é o compromisso: alto o bastante para acompanhar a deriva entre dois
 * cristais de quartzo (que é de partes por milhão, e portanto lenta) e baixo o
 * bastante para um único pacote atrasado não puxar a fase de forma visível — um
 * salto de meio passo entraria como um solavanco de oito milissegundos no tempo
 * do mundo.
 */
export const PHASE_GAIN = 0.2;

/** Desvio que deixa de ser deriva e vira outra coisa. Meio segundo. */
export const RENDER_SNAP = 30;

/**
 * Anda a estimativa do relógio do host um passo.
 *
 * Um por passo, exatamente — é isto que garante que a velocidade do mundo
 * desenhado seja constante entre dois pacotes. Toda a correção mora em
 * `correctHostEstimate`, que roda só quando há informação nova para corrigir.
 */
export function advanceHostEstimate(estimate: number): number {
  return estimate + 1;
}

/**
 * Corrige a fase da estimativa com o tick que acabou de chegar.
 *
 * @param estimate onde se achava que o host estava.
 * @param observed o tick que veio no instantâneo.
 */
export function correctHostEstimate(estimate: number, observed: number): number {
  const drift = observed - estimate;

  // Não é deriva: a aba dormiu, ou a rede sumiu por segundos. Acompanhar de um
  // em um levaria minutos, e o que se vê enquanto isso é um mundo em câmera
  // lenta que não termina nunca.
  if (Math.abs(drift) > RENDER_SNAP) return observed;

  return estimate + drift * PHASE_GAIN;
}

/**
 * Onde o desenho está entre dois instantâneos, de 0 a 1.
 *
 * O grampo nas duas pontas não é a mesma coisa em cada uma. Em zero, o pacote
 * novo chegou adiantado e o desenho ainda não alcançou o par; em um, o próximo
 * atrasou, e parar na última pose conhecida é o certo — extrapolar em rede ruim
 * é o que produz navio tremendo e depois corrigindo.
 */
export function interpolationFactor(clock: number, fromTick: number, toTick: number): number {
  const span = toTick - fromTick;
  if (span <= 0) return 1;
  return Math.max(0, Math.min(1, (clock - fromTick) / span));
}
