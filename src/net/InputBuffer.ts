/**
 * The host's input queue: it absorbs the network's jitter without leaving the simulation
 * stalled.
 *
 * The network does not deliver frames at a constant rate — it delivers them in bursts,
 * with gaps. The simulation, on the contrary, needs exactly one frame per step, sixty
 * times a second. This queue is the shock absorber between the two, and its `depth` goes
 * in every snapshot so the guest can tune how far ahead it runs.
 *
 * ## The starvation policy is where the subtle bug lives
 *
 * When the queue empties — and it will empty —, the host has to simulate something.
 * Repeating the last frame is right, but **not all of it**, and the three rules are
 * independent:
 *
 * 1. **`pressed` is zeroed.** A repeated edge is a command given twice. A half-second
 *    hiccup would become a volley of shots the player never fired — and they would watch
 *    the ammunition disappear without understanding why.
 * 2. **`look` is zeroed.** The gaze is a delta, not a state. Repeating it makes the
 *    opponent's head turn on its own, faster the worse the network gets.
 * 3. **`held` and the axes repeat.** Holding W through a hiccup has to keep walking.
 *    Zeroing here would give an opponent who freezes at every network wobble and then
 *    walks again — the classic "rubber band".
 */

import { clearInputFrame, copyInputFrame, createInputFrame, type InputFrame } from '../core/InputFrame';

/**
 * Frames kept.
 *
 * Sixty is one second of network. More than that would be keeping input so old it is no
 * longer worth applying: a command from a second ago executed now is worse than no
 * command at all.
 */
const CAPACITY = 60;

/**
 * The queue depth from which a frame from the future is accepted. See `claimAhead`.
 *
 * Eight frames is 133 ms of stored command — well above what a healthy connection's
 * jitter produces, and well below the twenty-one that gave the defect away. Between the
 * two there is plenty of room for the normal policy to go on being the normal one.
 */
const AHEAD_THRESHOLD = 8;

/**
 * The distance at which a missing tick counts as a **gap**, and not as a delay.
 *
 * Four frames. The difference between the two cases is what the queue already has:
 *
 * - If the requested frame did not arrive and **nothing** else did, it is on its way —
 *   waiting is right, and the starvation policy covers the step.
 * - If the requested frame did not arrive but the **next** one is already here, it is not
 *   coming: the network delivers in order, so whatever went ahead buried whatever was
 *   left behind. Repeating the previous command in that case is throwing away the right
 *   command, which is sitting one step away.
 *
 * The window is short on purpose. It covers the loss of the two copies the batch's
 * redundancy sends (see `INPUT_BATCH`) and not much more; a gap larger than that is a
 * clock jump, and what answers a jump is `AHEAD_THRESHOLD`.
 */
const AHEAD_WINDOW = 4;

export class InputBuffer {
  /** Frames waiting, ordered by tick. It goes in every snapshot. */
  depth = 0;
  /** How many times the queue emptied. Telemetry: a high number is a bad network. */
  starves = 0;
  /**
   * Starvations since the last snapshot sent.
   *
   * It goes on the wire, and it is not telemetry: it is the signal the client uses to
   * decide whether it has to run further ahead. Inferring that from the queue's depth —
   * which is what used to be done — does not work, because the queue sits at zero both
   * when the command arrives late and when it arrives exactly on time.
   */
  private starvedSinceReport = 0;
  /** The last tick consumed, so the guest can measure the round trip. */
  lastConsumedTick = 0;
  /**
   * The stamp of the frame that actually fed the last step, or `-1` if it was fed by
   * repetition.
   *
   * It is not the same as `lastConsumedTick`, and the difference is precisely what
   * `claimAhead` introduces: the requested step and the applied command may be from
   * neighboring ticks. It is the only measurement that answers "did the player's command
   * arrive?" — counting starvations answers a different question, and a command can be
   * lost without producing any starvation at all.
   */
  appliedTick = -1;

  private readonly frames = new Map<number, InputFrame>();
  private readonly pool: InputFrame[] = [];
  private readonly last: InputFrame = createInputFrame();
  private readonly out: InputFrame = createInputFrame();

  /**
   * Stores a received frame.
   *
   * Duplicates are discarded in silence — and they are expected, because the client sends
   * each frame more than once on purpose (see `INPUT_BATCH`). The same goes for frames
   * from ticks that have already passed: they arrived late, and applying them would be
   * going back in time.
   */
  push(frame: InputFrame): void {
    if (frame.tick <= this.lastConsumedTick) return;
    if (this.frames.has(frame.tick)) return;
    if (this.frames.size >= CAPACITY) return;

    const stored = this.pool.pop() ?? createInputFrame();
    copyInputFrame(frame, stored);
    this.frames.set(frame.tick, stored);
    this.depth = this.frames.size;
  }

  /**
   * This step's frame.
   *
   * @returns the frame to apply. Never `null` — the simulation cannot skip a step waiting
   *   for the network, so starvation is resolved with repetition, and not with absence.
   *   See the header.
   */
  consume(tick: number): InputFrame {
    this.lastConsumedTick = tick;

    const stored = this.frames.get(tick) ?? this.claimAhead(tick);
    if (stored) {
      this.appliedTick = stored.tick;
      this.frames.delete(stored.tick);
      copyInputFrame(stored, this.last);
      clearInputFrame(stored);
      this.pool.push(stored);
      this.dropStale(tick);
      this.depth = this.frames.size;

      copyInputFrame(this.last, this.out);
      this.out.tick = tick;
      return this.out;
    }

    this.appliedTick = -1;
    this.starves++;
    this.starvedSinceReport = Math.min(this.starvedSinceReport + 1, 255);
    this.dropStale(tick);
    this.depth = this.frames.size;

    // Starvation: repeat what can be repeated. See the three rules in the header.
    this.out.tick = tick;
    this.out.held = this.last.held;
    this.out.moveX = this.last.moveX;
    this.out.moveY = this.last.moveY;
    this.out.pressed = 0;
    this.out.lookX = 0;
    this.out.lookY = 0;
    // The absolute gaze **repeats**, and it is the opposite of the delta: repeating an
    // increment turns the head on its own, repeating a position leaves it still, which is
    // what "nothing changed" means. See `PlayerController.applyLook`.
    this.out.yaw = this.last.yaw;
    this.out.pitch = this.last.pitch;
    this.out.absoluteView = this.last.absoluteView;
    return this.out;
  }

  /**
   * The oldest frame in the queue, when **everything** in it is from the future.
   *
   * ⚠️ It exists because of a state that looks impossible and is not: the queue full and
   * the host starving at the same time. Measured in a real duel — 21 frames stored and
   * 1,340 starvations accumulated, with the player on the other side reporting that they
   * **could not control the boat**.
   *
   * The cause is a jump in the client's clock. When the simulating window freezes (a
   * background tab is enough) and comes back, the two clocks diverge enough for the
   * client to jump instead of drift — and the jump opens a **gap** in the numbering: the
   * skipped ticks were never sent, and never will be. The host, consuming them one by
   * one, finds a gap at every one, repeats the last known command and starts ignoring
   * everything the player does, while the queue fattens with frames from a future it
   * would take twenty seconds to reach.
   *
   * Accepting the oldest available closes the gap in one step: the command is from a
   * slightly different instant than the one requested — and it is the **right** command,
   * instead of an old command repeated.
   *
   * ## Two guards, and not one
   *
   * The previous version only accepted with the queue **fat**, which solved the clock
   * jump and let the common case through: the single-frame gap. On the shallow queue a
   * healthy duel works with — the aim is precisely to keep one or two units of slack —,
   * eight stored frames never happen, so losing both copies of the same command fell
   * straight into the starvation policy even with the next command already in hand. A
   * starvation like that is reported, and a starvation report pushes the lead up: the
   * remedy for a problem that did not exist became permanent latency.
   *
   * Today there are two: a **short** gap is always accepted (see `AHEAD_WINDOW`), and the
   * big jump still requires the fat queue.
   */
  private claimAhead(tick: number): InputFrame | null {
    let earliest: InputFrame | null = null;
    for (const frame of this.frames.values()) {
      if (frame.tick <= tick) continue;
      if (!earliest || frame.tick < earliest.tick) earliest = frame;
    }
    if (!earliest) return null;

    // Short gap: the right command is right there, and applying it one step early is
    // better than repeating the previous one. See `AHEAD_WINDOW`.
    if (earliest.tick - tick <= AHEAD_WINDOW) return earliest;

    // Big jump: only with the queue visibly fat, which is the sign that the client's
    // clock jumped. See the paragraph above.
    return this.frames.size >= AHEAD_THRESHOLD ? earliest : null;
  }

  /** Starvations since the last snapshot. Zeroed by whoever reports them. */
  takeStarvedSinceReport(): number {
    const value = this.starvedSinceReport;
    this.starvedSinceReport = 0;
    return value;
  }

  reset(): void {
    for (const frame of this.frames.values()) {
      clearInputFrame(frame);
      this.pool.push(frame);
    }
    this.frames.clear();
    clearInputFrame(this.last);
    this.depth = 0;
    this.starves = 0;
    this.starvedSinceReport = 0;
    this.lastConsumedTick = 0;
    this.appliedTick = -1;
  }

  /** Returns to the pool whatever was left behind. */
  private dropStale(tick: number): void {
    for (const [key, frame] of this.frames) {
      if (key > tick) continue;
      this.frames.delete(key);
      clearInputFrame(frame);
      this.pool.push(frame);
    }
  }
}
