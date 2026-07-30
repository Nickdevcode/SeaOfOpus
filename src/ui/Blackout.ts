/**
 * The cut to black that covers the rescue.
 *
 * It is the only moment in the game where the player's body changes place without
 * having walked there: calling for help in the water puts the sailor back on their own
 * ship's deck, which can be two hundred meters away. Without the cut, what you see is
 * the camera being torn out of the sea and planted on the deck in one frame — it reads
 * as a bug, not as a rescue.
 *
 * ## The shape of the curve, and why it is not symmetric
 *
 * **Black immediately, hold, and a slow return.** A fade out would be the pretty choice
 * and the wrong one: during it the teleport has already happened, so the player would
 * see the deck appearing *behind* the sea that is disappearing. The cut has to close
 * before the body moves, and the only way to guarantee that without coupling the UI to
 * the physics step is to close **fast**. Sixty milliseconds is four frames: too fast to
 * read as a transition, slow enough not to be a blink.
 *
 * The return is the opposite: it is the only part the player actually watches, and it
 * is where the impression of having been hauled aboard lives. Eight hundred
 * milliseconds with `smoothstep` is the time it takes to open your eyes.
 *
 * The hold in the middle is what gives the thing weight. Without it the rescue would be
 * instantaneous and free, and falling into the sea would stop costing — and falling
 * into the sea has to cost time, which is this duel's only currency.
 *
 * ## Why it is not CSS
 *
 * Because `base.css` honors `prefers-reduced-motion` by cutting **every** animation to
 * 0.01 ms, and this is not decorative movement: it is the cloth that hides the
 * teleport. Cut to zero, the player with that preference on would see exactly the
 * defect the cloth exists to cover. One opacity per frame, written only when it
 * changes, costs less than the `@keyframes` it replaces.
 */

import '../styles/blackout.css';

/** How long the black takes to close, in seconds. See the header. */
const FADE_IN = 0.06;
/** How long it stays full. */
const HOLD = 1.14;
/** And how long it takes to open. The three add up to 2 s. */
const FADE_OUT = 0.8;

const TOTAL = FADE_IN + HOLD + FADE_OUT;

const smoothstep = (t: number): number => t * t * (3 - 2 * t);

export class Blackout {
  private readonly root: HTMLDivElement;
  /** Seconds since the cut started. Negative when there is no cut at all. */
  private elapsed = -1;
  /** Last opacity written to the DOM. See `write`. */
  private written = 0;

  constructor(parent: HTMLElement) {
    this.root = document.createElement('div');
    this.root.className = 'blackout';
    this.root.hidden = true;
    // Purely visual: there is no text underneath and nothing to announce.
    this.root.setAttribute('aria-hidden', 'true');
    parent.appendChild(this.root);
  }

  /** `true` while the cut is up. */
  get active(): boolean {
    return this.elapsed >= 0;
  }

  /**
   * Starts a cut. Calling it again mid-cut restarts from zero — which is right: two
   * rescues in a row are two cuts, not one longer one.
   */
  play(): void {
    this.elapsed = 0;
    this.root.hidden = false;
    this.write(0);
  }

  /** Runs on the frame, with the real `dt`. */
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

  /** Clears the cut immediately. It is what going back to the menu needs. */
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
   * Writes the opacity, and only when it changes enough to show.
   *
   * A hundredth is less than three steps of the 256 levels the browser's compositor
   * works with — below that the `style` is rewritten to produce the same pixel. It is
   * the same care as `Prompts`, and for the same reason: touching the DOM is the
   * expensive part.
   */
  private write(value: number): void {
    if (Math.abs(value - this.written) < 0.01 && value !== 0 && value !== 1) return;
    this.written = value;
    this.root.style.opacity = value.toFixed(3);
  }
}
