/**
 * Loop principal do jogo.
 *
 * Física roda em passo fixo de 60 Hz com acumulador; render roda livre. Passo
 * fixo não é preciosismo: empuxo e molas Verlet ficam instáveis se o `dt`
 * varia, e o navio começa a tremer ou explodir quando o FPS oscila.
 *
 * O acumulador tem teto ("spiral of death guard"): se a aba ficou em segundo
 * plano por 10 s, o jogo não tenta simular 600 passos de uma vez.
 */

export const FIXED_TIMESTEP = 1 / 60;
/** Máximo de tempo simulado por frame, em segundos. */
const MAX_FRAME_TIME = 0.25;
/** Teto de sub-passos por frame para não travar a thread. */
const MAX_SUBSTEPS = 5;

export interface EngineCallbacks {
  /**
   * Amostragem de entrada, **antes** de qualquer passo fixo.
   *
   * A ordem é o ponto. Enquanto a leitura do teclado acontecia dentro de
   * `update`, ela rodava *depois* dos passos fixos do mesmo quadro — e com o
   * jogador simulado no passo fixo, cada tecla valeria só no quadro seguinte.
   * Um quadro inteiro de latência, de graça, e ele não some com ajuste nenhum
   * do outro lado. Aqui, o passo fixo lê a entrada que acabou de chegar.
   */
  beginFrame?(dt: number): void;
  /** Simulação determinística. Recebe sempre exatamente FIXED_TIMESTEP. */
  fixedUpdate(dt: number, tick: number): void;
  /** Lógica visual e de entrada. Recebe o dt real do frame. */
  update(dt: number, alpha: number): void;
  /** Desenho. */
  render(dt: number): void;
}

export class Engine {
  /** Tempo total de simulação decorrido, em segundos. */
  elapsed = 0;
  /**
   * Passos fixos desde `start()`. Monotônico e inteiro.
   *
   * Existe ao lado de `elapsed` porque os dois respondem perguntas diferentes, e
   * a de rede só o inteiro responde: `elapsed` é uma soma de `1/60` em ponto
   * flutuante, que **deriva** — dez minutos de jogo somam 36.000 arredondamentos.
   * Um contador inteiro é o mesmo número nas duas pontas de um duelo para
   * sempre, e é o que carimba entrada, instantâneo e evento.
   */
  tick = 0;
  running = false;

  /** Média móvel do frametime em ms, para o overlay de debug. */
  frameTimeMs = 0;
  fps = 0;

  private accumulator = 0;
  private lastTime = 0;
  private frameHandle = 0;
  private callbacks: EngineCallbacks | null = null;

  start(callbacks: EngineCallbacks): void {
    if (this.running) this.stop();

    this.callbacks = callbacks;
    this.running = true;
    this.lastTime = performance.now();
    this.accumulator = 0;
    this.frameHandle = requestAnimationFrame(this.advance);
  }

  stop(): void {
    this.running = false;
    cancelAnimationFrame(this.frameHandle);
  }

  /** Um quadro do navegador. O nome não é `tick` porque `tick` agora é o contador. */
  private advance = (now: number): void => {
    if (!this.running || !this.callbacks) return;
    this.frameHandle = requestAnimationFrame(this.advance);

    let frameTime = (now - this.lastTime) / 1000;
    this.lastTime = now;

    // Média móvel exponencial: número estável no HUD sem tremer a cada frame.
    this.frameTimeMs += ((frameTime * 1000) - this.frameTimeMs) * 0.1;
    this.fps = this.frameTimeMs > 0 ? 1000 / this.frameTimeMs : 0;

    // Aba em segundo plano ou stutter grande: descartar o excedente em vez de
    // tentar recuperar, que só piora o engasgo.
    if (frameTime > MAX_FRAME_TIME) frameTime = MAX_FRAME_TIME;

    this.accumulator += frameTime;

    // Antes do acumulador, e não dentro de `update`. Ver `EngineCallbacks`.
    this.callbacks.beginFrame?.(frameTime);

    let steps = 0;
    while (this.accumulator >= FIXED_TIMESTEP && steps < MAX_SUBSTEPS) {
      this.callbacks.fixedUpdate(FIXED_TIMESTEP, this.tick);
      this.tick++;
      this.elapsed += FIXED_TIMESTEP;
      this.accumulator -= FIXED_TIMESTEP;
      steps++;
    }

    // Se estourou o teto de sub-passos, zerar o resto evita acumular dívida.
    if (steps >= MAX_SUBSTEPS) this.accumulator = 0;

    // Fração do passo fixo já consumida: usada para interpolar a pose visual
    // do navio e evitar tremor quando o FPS não é múltiplo de 60.
    const alpha = this.accumulator / FIXED_TIMESTEP;

    this.callbacks.update(frameTime, alpha);
    this.callbacks.render(frameTime);
  };
}
