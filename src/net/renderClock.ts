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
 * dois pacotes e seja apenas corrigido por eles. Derivá-lo do tick do host —
 * que é o que se fazia — dá uma pose que fica parada quatro passos e salta no
 * quinto: o mundo inteiro do cliente andando a quinze quadros por segundo,
 * independentemente de a que taxa ele desenhe.
 */

/**
 * Fração do desvio corrigida por passo.
 *
 * Baixa de propósito: a correção tem de ser um empurrãozinho contínuo, não um
 * puxão. A um décimo, um desvio de meio segundo se fecha em pouco mais de um
 * segundo sem que nada na tela denuncie que houve correção.
 */
export const RENDER_CATCHUP = 0.1;

/**
 * Teto da correção por passo, em passos.
 *
 * É o quanto o tempo do mundo pode dilatar: no pior caso ele anda a 75% ou a
 * 125% da velocidade normal enquanto alcança o alvo. E o piso importa tanto
 * quanto o teto — com −0,25 sobre um passo inteiro, o relógio **nunca anda para
 * trás**, o que garante que nenhuma correção jamais desenhe o navio recuando.
 */
export const RENDER_RATE_LIMIT = 0.25;

/** Desvio que deixa de ser deriva e vira outra coisa. Meio segundo. */
export const RENDER_SNAP = 30;

/**
 * Anda o relógio de desenho um passo em direção ao alvo.
 *
 * @param clock onde o desenho está, em passos fracionários.
 * @param target onde ele deveria estar: `hostTick − atraso de interpolação`.
 * @returns a posição nova do relógio.
 */
export function advanceRenderClock(clock: number, target: number): number {
  const drift = target - clock;

  // Não é deriva: a aba dormiu, ou a rede sumiu por segundos. Acompanhar de um
  // em um levaria minutos, e o que se vê enquanto isso é um mundo em câmera
  // lenta que não termina nunca.
  if (Math.abs(drift) > RENDER_SNAP) return target;

  const correction = Math.max(
    -RENDER_RATE_LIMIT,
    Math.min(drift * RENDER_CATCHUP, RENDER_RATE_LIMIT),
  );
  return clock + 1 + correction;
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
