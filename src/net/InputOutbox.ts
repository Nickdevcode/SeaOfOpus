/**
 * The window of commands leaving the client, and the rule that it **has no holes**.
 *
 * A module of its own, and not a handful of private fields in `GuestSession`, for the
 * same reason as `renderClock`: this is arithmetic over integers and bits, and it is
 * the kind of thing you prove in a test instead of checking by looking at the screen.
 * `GuestSession` imports Three.js and the whole `Match`; this imports nothing beyond
 * the frame's shape.
 *
 * ## The contract
 *
 * The host consumes **one tick per step**, in order, and silently discards any frame
 * whose tick it has already passed (that is how the batch's redundancy works — see
 * `INPUT_BATCH`). That gives the sender two obligations:
 *
 * 1. **No tick may be missing.** A tick that was never sent is a step where the host
 *    finds no command: it counts a starvation, repeats the last known command and
 *    reports the starvation to the client — which responds by running further ahead,
 *    which provokes another clock correction and another hole. It is a ratchet, and by
 *    turning it reaches the lead ceiling with the player watching their own sailor walk
 *    without obeying.
 * 2. **No tick may appear twice with different contents.** The second is discarded as a
 *    duplicate, and with it goes that step's command: an `F` at the helm, a shot, a
 *    jump.
 *
 * Both things happen for the same reason, and not because of the network: the client's
 * prediction clock is **corrected** one step at a time to follow the host's (see
 * `GuestSession.syncClock`), and a correction upward skips a stamp, while one downward
 * repeats the previous one. Without this class, every clock correction cost a command.
 *
 * ## What the stitching preserves
 *
 * The tick the correction skipped becomes a **repeat** of the previous one, following
 * `InputBuffer`'s policy: what is state (held keys, axes, absolute gaze) repeats, what
 * is an edge does not. It is the truth about that instant — nothing changed in it,
 * because it never came to exist.
 *
 * The repeated tick is **merged**: the edges come in by OR, the state takes the most
 * recent and the accumulated gaze is summed. It is exactly what `InputSampler` does
 * when two monitor frames land inside the same step.
 */

import { INPUT_BATCH } from '../../shared/protocol';
import { copyInputFrame, createInputFrame, type InputFrame } from '../core/InputFrame';

/**
 * Largest gap worth stitching, in steps.
 *
 * What separates **drift** from **a jump**. The clock correction moves one at a time,
 * so any legitimate hole is one step wide; a large gap is the clock jumping (the tab
 * slept, the network vanished for seconds), and filling it would mean sending seconds
 * of phantom command. A jump is `InputBuffer.claimAhead`'s case, which closes the gap
 * in one go on the other side.
 */
const MAX_STITCH = INPUT_BATCH;

export class InputOutbox {
  /** The most recent frames, newest first. */
  private readonly frames: InputFrame[] = Array.from({ length: INPUT_BATCH }, createInputFrame);
  private count = 0;
  /** The newest tick that has gone in. `-1` before the first. */
  private newest = -1;
  /** Scratch for the repeat. Nothing here allocates per step. */
  private readonly filler = createInputFrame();

  /** The batch to send: newest first. Valid until the next `add`. */
  get batch(): readonly InputFrame[] {
    return this.frames.slice(0, this.count);
  }

  /** How many frames the batch carries right now. */
  get size(): number {
    return this.count;
  }

  reset(): void {
    this.count = 0;
    this.newest = -1;
  }

  /**
   * Puts this step's command into the window, stitching whatever the clock has done.
   *
   * @param frame the step's frame. It is copied — the caller can reuse it.
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

  /** Pushes a frame in, throwing the oldest one out. */
  private push(frame: InputFrame): void {
    for (let i = this.frames.length - 1; i > 0; i--) {
      copyInputFrame(this.frames[i - 1]!, this.frames[i]!);
    }
    copyInputFrame(frame, this.frames[0]!);
    this.count = Math.min(this.count + 1, this.frames.length);
  }

  /** Fills in the ticks the clock correction skipped. See the header. */
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

  /** Merges a command into a tick already in the window. See the header. */
  private merge(frame: InputFrame): void {
    let slot: InputFrame | null = null;
    for (let i = 0; i < this.count; i++) {
      if (this.frames[i]!.tick === frame.tick) {
        slot = this.frames[i]!;
        break;
      }
    }

    // Out of the window: the clock really did jump backwards, and what was here
    // describes a future that no longer applies. Starting over is right.
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
