/**
 * The bridge between the monitor's clock and the simulation's.
 *
 * `Input` speaks in frames; the simulation speaks in 60 Hz steps. The two almost never
 * coincide, and that is where two bugs live that do not show up on the machine of
 * whoever wrote the code:
 *
 * - **At 144 fps** there are 2.4 frames per step. A key edge that lands on a frame no
 *   step read simply **disappears** — the player presses jump and does not jump, once
 *   every so often. It disappears more for whoever has the better monitor.
 * - **At 20 fps** one frame covers three steps. Reading the edge directly on each step
 *   **repeats** the command: one tap on fire comes out as three shots.
 *
 * The solution is the same on both sides: the edges **accumulate** by OR while the
 * frames pass, and the first step that consumes them zeroes them. The gaze follows the
 * same rule by summing instead of OR — two frames' deltas inside the same step have to
 * become one rotation, and not the last of them.
 */

import { InputBit, createInputFrame, type InputFrame } from './InputFrame';
import type { Action, Input } from './Input';

/** Game action → bit. `InputBit`'s order is the network format; this table only reads it. */
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
  /** What has accumulated since the last consumed step. */
  private readonly pending: InputFrame = createInputFrame();
  /** What the current step receives. Reused — nothing here allocates per tick. */
  private readonly current: InputFrame = createInputFrame();

  /**
   * `false` while the player should command nothing (menu open, camera detached). It
   * goes on sampling zeros, rather than stopping sampling: a step with no input is
   * information, and online it has to be sent just the same.
   */
  private live = true;

  /**
   * The gaze that arrived after the last step and has not been consumed yet.
   *
   * It is the **residual** that keeps the camera at the monitor's rate while the head
   * only moves at 60 Hz. It lives here, and not in a copy inside the controller, so
   * there is a single source: with two accumulators, the day one of them was clamped
   * (`pitch` has a limit) and the other was not, the sum `angle + residual` would stop
   * being continuous and the view would jolt on every step. See
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
    // On freezing, whatever had accumulated dies with it. Without this, the
    // `interact` pressed on the frame the menu opened would be delivered to the next
    // step — and the player would come back to the deck with an action they gave to
    // the menu.
    this.pending.held = 0;
    this.pending.pressed = 0;
    this.pending.moveX = 0;
    this.pending.moveY = 0;
    this.pending.lookX = 0;
    this.pending.lookY = 0;
  }

  /** Runs once per frame, after `Input.beginFrame`. */
  sample(input: Input): void {
    if (!this.live) return;

    let held = 0;
    let pressedNow = 0;
    for (const [action, bit] of ACTION_BITS) {
      if (input.isDown(action)) held |= bit;
      if (input.wasPressed(action)) pressedNow |= bit;
    }

    // `held` and the axes are **state**: the last frame seen is what counts, because
    // it is what describes the instant the step is going to happen at.
    this.pending.held = held;
    const move = input.getMoveAxis();
    this.pending.moveX = move.x;
    this.pending.moveY = move.y;

    // Edges and gaze are **accumulation**: no frame can be lost between two steps.
    // See the header.
    this.pending.pressed |= pressedNow;
    this.pending.lookX += input.look.x;
    this.pending.lookY += input.look.y;
  }

  /**
   * This step's input frame. It zeroes what was consumed.
   *
   * The object returned is reused on every call: whoever needs to keep it (the
   * prediction history, the send queue) has to copy it with `copyInputFrame`.
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
