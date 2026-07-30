/**
 * The **render** clock of the client that does not simulate, and the factor that
 * comes out of it.
 *
 * A module of its own, and not two private methods of `GuestSession`, for a practical
 * reason: like the prediction clock, this is pure arithmetic over integers and
 * fractions, and it is the kind of thing you prove in a test instead of checking by
 * looking at the screen. `GuestSession` imports Three.js and the whole `Match`; this
 * imports nothing, and that is what lets `tests/netclock.ts` exercise it for real
 * instead of rewriting the logic in a copy that can diverge.
 *
 * ## The problem it solves
 *
 * The snapshot arrives every four steps; the screen draws every one. Whoever draws
 * therefore needs a clock of **its own**, one that runs by itself between two packets
 * and is only corrected by them.
 *
 * ## And the trap it has
 *
 * The first version chased `hostTick − delay` on every step, with a correction
 * proportional to the deviation. It looks like the right thing and it is not, because
 * **`hostTick` is a step, not a ramp**: it stays still for four steps and rises four
 * at once. Chasing a step with proportional gain gives exactly what control theory
 * promises — a sawtooth. Measured: the world advanced 1.00 tick on the step after the
 * packet, then 0.90, 0.81 and 0.75, and started over. The speed of everything you see
 * oscillating 25% at fifteen hertz, which the player feels as **shaking while
 * walking**, and which no frame average reveals because the average is right.
 *
 * The correct shape is the one this version uses: keep an **estimate of the host's
 * clock** that advances one per step (a ramp, like the original) and whose *phase* is
 * corrected on every packet. The render clock is derived from it by subtraction, so it
 * inherits the ramp and never the correction's dynamics. It is a first-order loop, and
 * it is the same design a clock synchronizer uses.
 */

/**
 * Fraction of the phase deviation absorbed on every snapshot.
 *
 * A fifth is the compromise: high enough to follow the drift between two quartz
 * crystals (which is parts per million, and therefore slow) and low enough that a
 * single late packet does not pull the phase visibly — a half-step jump would come in
 * as an eight-millisecond jolt in the world's time.
 */
export const PHASE_GAIN = 0.2;

/** Deviation that stops being drift and becomes something else. Half a second. */
export const RENDER_SNAP = 30;

/**
 * Advances the estimate of the host's clock by one step.
 *
 * One per step, exactly — that is what guarantees the drawn world's speed is constant
 * between two packets. All of the correction lives in `correctHostEstimate`, which
 * only runs when there is new information to correct with.
 */
export function advanceHostEstimate(estimate: number): number {
  return estimate + 1;
}

/**
 * Corrects the estimate's phase with the tick that has just arrived.
 *
 * @param estimate where the host was thought to be.
 * @param observed the tick that came in the snapshot.
 */
export function correctHostEstimate(estimate: number, observed: number): number {
  const drift = observed - estimate;

  // This is not drift: the tab slept, or the network vanished for seconds. Catching
  // up one at a time would take minutes, and what you see meanwhile is a world in
  // slow motion that never ends.
  if (Math.abs(drift) > RENDER_SNAP) return observed;

  return estimate + drift * PHASE_GAIN;
}

/**
 * Where the render sits between two snapshots, from 0 to 1.
 *
 * The clamp at the two ends is not the same thing at each. At zero, the new packet
 * arrived early and the render has not caught up with the pair yet; at one, the next
 * one is late, and stopping at the last known pose is right — extrapolating on a bad
 * connection is what produces a ship that shakes and then corrects.
 */
export function interpolationFactor(clock: number, fromTick: number, toTick: number): number {
  const span = toTick - fromTick;
  if (span <= 0) return 1;
  return Math.max(0, Math.min(1, (clock - fromTick) / span));
}
