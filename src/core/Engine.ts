/**
 * The game's main loop.
 *
 * Physics runs on a fixed 60 Hz step with an accumulator; rendering runs free. The
 * fixed step is not fussiness: buoyancy and Verlet springs go unstable if `dt` varies,
 * and the ship starts shaking or exploding when the FPS oscillates.
 *
 * The accumulator has a ceiling (the "spiral of death guard"): if the tab spent 10 s
 * in the background, the game does not try to simulate 600 steps at once.
 */

export const FIXED_TIMESTEP = 1 / 60;
/** Maximum simulated time per frame, in seconds. */
const MAX_FRAME_TIME = 0.25;
/** Ceiling of sub-steps per frame, so the thread does not lock up. */
const MAX_SUBSTEPS = 5;

export interface EngineCallbacks {
  /**
   * Input sampling, **before** any fixed step.
   *
   * The order is the point. While the keyboard was read inside `update`, it ran
   * *after* the same frame's fixed steps — and with the player simulated on the fixed
   * step, every key would only apply on the next frame. A whole frame of latency, for
   * free, and it does not go away with any tuning on the other side. Here, the fixed
   * step reads the input that has just arrived.
   */
  beginFrame?(dt: number): void;
  /** Deterministic simulation. It always receives exactly FIXED_TIMESTEP. */
  fixedUpdate(dt: number, tick: number): void;
  /** Visual and input logic. It receives the frame's real dt. */
  update(dt: number, alpha: number): void;
  /** Drawing. */
  render(dt: number): void;
}

export class Engine {
  /** Total simulated time elapsed, in seconds. */
  elapsed = 0;
  /**
   * Fixed steps since `start()`. Monotonic and integer.
   *
   * It exists alongside `elapsed` because the two answer different questions, and only
   * the integer answers the network's: `elapsed` is a sum of `1/60` in floating point,
   * which **drifts** — ten minutes of play add up 36,000 roundings. An integer counter
   * is the same number at both ends of a duel forever, and it is what stamps input,
   * snapshot and event.
   */
  tick = 0;
  running = false;

  /** Moving average of the frame time in ms, for the debug overlay. */
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

  /** One browser frame. The name is not `tick` because `tick` is now the counter. */
  private advance = (now: number): void => {
    if (!this.running || !this.callbacks) return;
    this.frameHandle = requestAnimationFrame(this.advance);

    let frameTime = (now - this.lastTime) / 1000;
    this.lastTime = now;

    // Exponential moving average: a stable number in the HUD without flickering every
    // frame.
    this.frameTimeMs += ((frameTime * 1000) - this.frameTimeMs) * 0.1;
    this.fps = this.frameTimeMs > 0 ? 1000 / this.frameTimeMs : 0;

    // Tab in the background or a big stutter: discard the excess instead of trying to
    // catch up, which only makes the hitch worse.
    if (frameTime > MAX_FRAME_TIME) frameTime = MAX_FRAME_TIME;

    this.accumulator += frameTime;

    // Before the accumulator, and not inside `update`. See `EngineCallbacks`.
    this.callbacks.beginFrame?.(frameTime);

    let steps = 0;
    while (this.accumulator >= FIXED_TIMESTEP && steps < MAX_SUBSTEPS) {
      this.callbacks.fixedUpdate(FIXED_TIMESTEP, this.tick);
      this.tick++;
      this.elapsed += FIXED_TIMESTEP;
      this.accumulator -= FIXED_TIMESTEP;
      steps++;
    }

    // If the sub-step ceiling was hit, zeroing the remainder avoids accumulating debt.
    if (steps >= MAX_SUBSTEPS) this.accumulator = 0;

    // Fraction of the fixed step already consumed: used to interpolate the ship's
    // visual pose and avoid jitter when the FPS is not a multiple of 60.
    const alpha = this.accumulator / FIXED_TIMESTEP;

    this.callbacks.update(frameTime, alpha);
    this.callbacks.render(frameTime);
  };
}
