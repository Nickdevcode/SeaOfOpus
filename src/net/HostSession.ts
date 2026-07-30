/**
 * The side that simulates.
 *
 * The host runs `Match.fixedUpdate` exactly as in the duel against the machine — the only
 * difference is where the second ship's input comes from: instead of `ShipAI`, it comes
 * from the queue the network feeds. No line of physics knows this, and that is on
 * purpose: one code path is one code path fewer to diverge.
 *
 * ## Why fifteen snapshots per second, and not sixty
 *
 * Because it changes nothing you can see and changes everything you pay. The hull is
 * interpolated over there, so more packets would give the same picture; and at 60 Hz the
 * same duel would cost four times as many requests on the free plan. Fifteen with
 * interpolation is the same smoothness for a quarter of the price.
 */

import { MessageType, QUANT } from '../../shared/protocol';
import type { Match } from '../game/Match';
import { createInputFrame, type InputFrame } from '../core/InputFrame';
import type { Ship } from '../ship/Ship';
import { InputBuffer } from './InputBuffer';
import { decodeInput, encodeSnapshot } from './snapshotCodec';
import type { RoomClient } from './RoomClient';

/** One snapshot every four steps: 15 Hz over a 60 Hz simulation. */
const SNAPSHOT_EVERY = 4;

/**
 * Snapshots between two resends of the damage list, even when it is unchanged. One per
 * second.
 *
 * It is the heartbeat that carries what the signature leaves out: the repair's progress,
 * which advances without changing anything structural. Once a second is generous enough
 * for the opponent's breach bar to shrink convincingly, and rare enough for the
 * correction on the bar of whoever is nailing the plank to go unnoticed — one nudge per
 * second against fifteen.
 *
 * It is also the signature's safety net: if two different lists ever give the same
 * integer, the error lasts a second instead of lasting the match.
 */
const RESEND_EVERY = 15;

export class HostSession {
  private readonly buffer = new InputBuffer();
  /** Frames unpacked from a batch. Reused — nothing allocates per packet. */
  private readonly incoming: InputFrame[] = Array.from({ length: 8 }, createInputFrame);

  /** Each hull's damage signature, to know whether the list changed. */
  private lastDamageKeys: [number, number] = [-1, -1];
  /** Snapshots since the damage list was last sent. See `RESEND_EVERY`. */
  private sinceDamageSent = 0;
  private sentOver = false;

  constructor(
    private readonly match: Match,
    private readonly client: RoomClient,
  ) {}

  /** Telemetry for the F3 panel. */
  get depth(): number {
    return this.buffer.depth;
  }

  get starves(): number {
    return this.buffer.starves;
  }

  reset(): void {
    this.buffer.reset();
    this.lastDamageKeys = [-1, -1];
    this.sinceDamageSent = 0;
    this.sentOver = false;
  }

  /** A batch of input arrived from the other side. */
  onFrame(frame: ArrayBuffer): void {
    const view = new DataView(frame);
    if (view.byteLength < 2 || view.getUint8(0) !== MessageType.Input) return;

    const count = decodeInput(frame, this.incoming);
    for (let i = 0; i < count; i++) this.buffer.push(this.incoming[i]!);
  }

  /** The enemy ship's input on this step. It is never missing — see `InputBuffer`. */
  enemyInput(tick: number): InputFrame {
    return this.buffer.consume(tick);
  }

  /**
   * A hull's damage signature, to know whether it changed since the last snapshot.
   *
   * ⚠️ **It used to be the breach count, and the count lies in three cases that happen
   * all the time:**
   *
   * - A shot on top of an open breach **widens** the hole without creating another one.
   *   The number does not change, and the other side goes on seeing — and computing the
   *   jet of — a breach of the old size.
   * - The repair's progress runs from zero to one without touching the number. Whoever
   *   looked at the opponent's hull never saw the plank being nailed up.
   * - A breach closing in the same interval another one opens leaves the number
   *   identical. The list on the other side froze with a phantom hole and without the
   *   real one, and stayed that way **until the count changed again**.
   *
   * The signature covers what **changes all at once**: which breaches exist, how much
   * each one is worth and which planks are nailed up. The repair's progress is left out
   * on purpose — it advances continuously, and putting it here would have the whole list
   * resent fifteen times a second while somebody works. Over there that would not only be
   * traffic: whoever is nailing the plank predicts their own progress, and being
   * corrected fifteen times a second by a value half a round trip old would give a
   * sawtooth bar in the hand of whoever is holding the button. What takes care of the
   * progress is `RESEND_EVERY`.
   *
   * Quantizing the same way the codec does is what keeps the list from being resent
   * because of a difference that would not fit on the wire anyway. The result is a 32-bit
   * integer mixed by multiplication; a collision costs one late snapshot, and not a wrong
   * state forever, because the field is resent on the next change and on the heartbeat.
   */
  private damageKey(ship: Ship): number {
    const { damage } = ship;
    let key = damage.breaches.length * 31 + damage.patches.length;
    for (const breach of damage.breaches) {
      key = (Math.imul(key, 16777619) ^ breach.id) >>> 0;
      key = (Math.imul(key, 16777619) ^ Math.round(breach.area * QUANT.breachArea)) >>> 0;
    }
    for (const patch of damage.patches) {
      key = (Math.imul(key, 16777619) ^ patch.id) >>> 0;
    }
    return key;
  }

  /**
   * After the step: it sends the world, if it is time.
   *
   * The list of breaches and planks only goes in when it **changed** — see `damageKey`.
   * It is a conditional field, not a delta: the frame still reads on its own.
   */
  afterStep(tick: number): void {
    // ⚠️ **Over is over, and the snapshot stops here.** `Match.tick` freezes when the
    // match leaves `fighting`, so the cadence arithmetic below starts giving the same
    // result forever. Without this line, a host that finished on a tick that was a
    // multiple of four sent sixty snapshots per second of a frozen world — each of them a
    // billed request on the room — until somebody closed the tab.
    if (this.sentOver) return;

    const over = this.match.state === 'won' || this.match.state === 'lost';

    // ⚠️ **And the end does not wait its turn.**
    //
    // This was the quietest defect in the networked duel, and it swallowed three out of
    // every four matches. The sinking lands on any step; the snapshot goes out every
    // four. If the hull went down on a tick that was not a multiple of four, this
    // function bailed out here — and since `Match.tick` stops advancing at the same
    // instant, it would bail out here **on every following step**, forever. The result
    // never went up through the lobby, and the lobby is what closes the room on both
    // sides: both players were left staring at a frozen sea, with no end screen, no error
    // and nothing to do but reload the page.
    if (!over && tick % SNAPSHOT_EVERY !== 0) return;

    const keys: [number, number] = [
      this.damageKey(this.match.playerShip),
      this.damageKey(this.match.enemyShip),
    ];
    const changed = keys[0] !== this.lastDamageKeys[0] || keys[1] !== this.lastDamageKeys[1];
    const heartbeat = ++this.sinceDamageSent >= RESEND_EVERY;
    const includeBreaches = changed || heartbeat;
    if (includeBreaches) {
      this.lastDamageKeys = keys;
      this.sinceDamageSent = 0;
    }

    this.client.sendFrame(
      encodeSnapshot(this.match, {
        bufferDepth: this.buffer.depth,
        // Zeroed on read: what goes on the wire is always "since the last snapshot",
        // which is the window the client knows how to interpret.
        starved: this.buffer.takeStarvedSinceReport(),
        ackTick: this.buffer.lastConsumedTick,
        includeBreaches,
        over,
        winner: this.match.state === 'won' ? 0 : 1,
      }),
    );

    // The event queue is emptied **here**, and only here: it exists precisely to
    // accumulate between one snapshot and the next. See `Match.netEvents`.
    this.match.netEvents.length = 0;

    // The result goes up once only, through the lobby: it is what closes the room on
    // both sides. The snapshot carries the same news in case the lobby message arrives
    // later — whoever sees it first closes.
    if (over && !this.sentOver) {
      this.sentOver = true;
      this.client.sendLobby({ t: 'result', winner: this.match.state === 'won' ? 0 : 1 });
    }
  }
}
