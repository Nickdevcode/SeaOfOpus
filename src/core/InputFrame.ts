/**
 * One player's input for one simulation step, in a shape that fits on the wire.
 *
 * It is the **only** thing that crosses the network from the playing side: sixteen
 * bytes per step, sixty times a second. All the rest of the state is born from
 * applying these fields to the same simulation on both sides.
 *
 * ## Why a struct, and not `Input`
 *
 * `Input` answers "what is happening right now, this frame". The simulation needs
 * "what happened **on this tick**", which is a different question: a 144 Hz frame does
 * not even cover one tick, and a 20 Hz one covers three. What does the translation is
 * `InputSampler`; what comes out of it is this.
 *
 * ## The rule you do not break
 *
 * ⚠️ **The order of the bits is the network format.** Reordering `InputBit` swaps jump
 * for fire between two versions of the game that meet in a room — and the symptom is
 * not an error, it is an opponent who fires while walking. Appending at the end is
 * safe; removing and reordering, never.
 */

/**
 * The eleven game actions, one per bit.
 *
 * A frozen object instead of a `const enum`: the `tsconfig` has `isolatedModules`, and
 * `const enum` does not survive the file-by-file compilation it requires.
 *
 * `freeCamera`, `controls`, `debug` and `pause` are left out — they are the shell's
 * commands, not the sailor's. None of them changes a gram of physics, and sending them
 * over the network would let the opponent open the other one's settings screen.
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
  /** The step this input belongs to. It is the stamp the network uses. */
  tick: number;
  /** Bitmask of what is held at the instant of the sample. */
  held: number;
  /**
   * Bitmask of the edges **accumulated** since the previous tick.
   *
   * Separate from `held` because the two questions behave differently when a packet is
   * lost: holding W through a hitch has to keep walking, but repeating the `fire` edge
   * fires the cannon twice. See the repeat policy in `InputBuffer`.
   */
  pressed: number;
  /** Walking axis, already normalized, -1..1. */
  moveX: number;
  moveY: number;
  /** Look delta accumulated since the previous tick, in radians. */
  lookX: number;
  lookY: number;
  /**
   * The **absolute** gaze of whoever sent this frame, in radians.
   *
   * It is only valid when `absoluteView` is `true`, which is the case for frames that
   * came over the network. See `PlayerController.applyLook` for the defect this fixes —
   * in short: a gaze delta does not survive a lost packet, and what breaks when it does
   * not survive is not the other one's head, it is their interaction focus.
   */
  yaw: number;
  pitch: number;
  /**
   * `true` when `yaw`/`pitch` rule and the deltas should be ignored.
   *
   * An explicit flag, and not a sentinel value in `yaw`: the frame is filled in two
   * very different places (the local sampler and the network decoder), and "zero" is a
   * perfectly valid angle.
   */
  absoluteView: boolean;
}

/** A zeroed `InputFrame`, for filling pools without allocating later. */
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
  // `yaw`, `pitch` and `absoluteView` are **not** zeroed: a clean frame goes into the
  // pool to be rewritten in full, and zeroing the gaze here would be the same class of
  // error `InputBuffer`'s starvation policy avoids — inventing a head facing forward
  // where what is known is "nothing changed".
}

/** The action is held on this step. */
export function held(frame: InputFrame, bit: number): boolean {
  return (frame.held & bit) !== 0;
}

/** The action was triggered at some point between the previous step and this one. */
export function pressed(frame: InputFrame, bit: number): boolean {
  return (frame.pressed & bit) !== 0;
}
