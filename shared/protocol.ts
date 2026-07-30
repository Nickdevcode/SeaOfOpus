/**
 * The contract between the game and the room server.
 *
 * This file is imported by **both sides** — by the client, which runs in the browser
 * with the whole DOM at its disposal, and by the Worker, which runs in a runtime with
 * no DOM at all. Hence the one rule it has:
 *
 * ⚠️ **No DOM, no Workers, no Three.js.** Only types and pure functions over numbers
 * and `ArrayBuffer`. A `WebSocket` mentioned here would break one of the two sides'
 * compilation, because the two runtimes declare that name with different shapes.
 *
 * ## Two languages on the same wire
 *
 * The lobby speaks **JSON**; the match speaks **binary**. The separation comes for
 * free on receipt — `typeof event.data === 'string'` already says which is which —
 * and each is in the right format for what it does:
 *
 * - The lobby is six messages per session, with text inside (nicknames), and what we
 *   want from them is to be able to read them in the browser's inspector when
 *   something goes wrong.
 * - The match is 45 messages a second, and there JSON costs dearly twice: on the wire
 *   (`0.7071067811865476` is eighteen characters for a number that fits in two bytes)
 *   and on the CPU, because `JSON.parse` of a few kilobytes fifteen times a second
 *   builds a fresh object graph inside the render frame.
 *
 * ## Version
 *
 * `PROTOCOL_VERSION` goes up whenever the binary format changes. The server refuses
 * the connection of anyone arriving with a different one — it is what keeps two
 * versions of the game from meeting in a room and spending the whole match reading
 * each other's bytes backwards, which is a silent and horrible failure to diagnose.
 */

/**
 * Goes up on every format change. See the header.
 *
 * **2** — the snapshot started carrying the day's clock and the weather's state
 * (without them, each side sailed under its own sky and its own rain), and `ackTick`
 * went from 16 to 32 bits. The 16-bit one wrapped around after eighteen minutes of
 * duel, and it is no longer only telemetry: it is what tells the client when the
 * station prediction was confirmed. An `ack` that goes back to zero mid-match would
 * lock the player out of the helm until the end of it.
 *
 * **3** — the snapshot started saying how many steps the host went **without a
 * command** since the previous one. The client used to decide that by looking at the
 * queue's depth, and the two cases it needed to distinguish look the same there: an
 * empty queue is both "the command arrived late" and "the command arrived exactly on
 * time". The lead climbed on the second and never came back down.
 *
 * **4** — three fields the world was missing, and all three produced the same
 * complaint ("it is not synchronized") by different routes:
 *
 * - **The background swell's heading** (`swellDirection`). It was born from each
 *   client's *local* wind — which was different, because each had spent a different
 *   amount of time on the title screen — and after that it only advanced on the
 *   simulating side. The spectrum's two long waves are the ones that lift the hull, so
 *   the two players saw the same ship floating on different seas from the first frame.
 * - **The nailed planks.** A patched breach vanished from the opponent's planking
 *   instead of becoming a scar with wood over it.
 * - **The operated gun's aim**, which is now corrected by the snapshot as the wheel
 *   already was: accumulating deltas on both sides only agrees while no command is
 *   lost.
 *
 * **5** — the **breach area**'s scale went from 2550 to 1400 (see
 * `QUANT.breachArea`). The previous one saturated at 0.1 m² and the model produces up
 * to 0.176: 43% of the useful range did not fit on the wire, and a well-widened breach
 * arrived on the other side at a little over half its real size. Found by the snapshot
 * test the first time it ran.
 *
 * **6** — the sailor started saying whether they have the **plank in hand**. It is one
 * bit in the body's state byte, which already had two to spare, and it closes the last
 * gesture missing for the opponent to have a human body: without it, whoever was
 * patching a breach showed up on the other side standing still, empty-handed, while
 * the wood appeared nailed to the hull on its own. What knows this is `Interaction` —
 * only it sees the hole and the held button on the same step — and the other side has
 * no way to deduce it.
 *
 * **7** — the sailor started saying whether they are **at sea**. It is the last free
 * bit of the body's state byte (number 7, which now closes the byte), and it is the
 * only water state that has to travel: the *position* already goes, and the rest is
 * derived from it — including **which of the two boarding ladders** the opponent is
 * hanging from, because the two sit seven meters apart in Z and `insideGangway` is
 * the same question the gangway already asks. Without this bit, whoever fell into the
 * water showed up on the other side *walking across the sea* in the deck pose, and the
 * boarding ladder had no way to light the right hand.
 *
 * In this same version the **head's heading in the snapshot started being
 * normalized** before quantizing, as the input frame's already was. It is not a format
 * change — the bytes are the same — but the version goes up along with it because it
 * fixes what those bytes *mean* at the edge of the range. See the note in
 * `encodeSnapshot`.
 */
export const PROTOCOL_VERSION = 7;

/** Digits in a room code. */
export const CODE_LENGTH = 4;

/**
 * The room code's alphabet: 32 characters with no ambiguous pair.
 *
 * No `I`, `O`, `0` or `1` — the four that get confused when somebody reads a code out
 * loud or copies it from a screen onto paper. Duplicated in the client (`OnlineMenu`)
 * on purpose: the client needs it to draw the digits, and this module cannot import
 * anything from there.
 */
export const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

/** Maximum length of a nickname, in characters. Clamped on both sides. */
export const NICKNAME_MAX_LENGTH = 16;

// -- lobby, in JSON -----------------------------------------------------------

/** What the client wants from the room on entering. */
export type JoinIntent = 'queue' | 'create' | 'join';

/** Client → room. */
export type ClientMessage =
  | {
      t: 'hello';
      v: number;
      nickname: string;
      intent: JoinIntent;
      /**
       * How much this machine can take, from 0 to 100.
       *
       * It is used to choose **who simulates**. In a host-authoritative duel, the host
       * carries both hulls' physics, so a weak machine in command stutters for both
       * players. Measured on the client from the frame rate in the menu and the cores
       * available — see `measurePerformance`.
       */
      perfScore: number;
    }
  /** Assets loaded; ready to start once the other one is too. */
  | { t: 'ready' }
  /** The host declares the end. Only it knows, because only it simulates. */
  | { t: 'result'; winner: 0 | 1 }
  /** A sign of life while waiting, so the server can clean up an abandoned room. */
  | { t: 'ping' };

/** Room → client. */
export type ServerMessage =
  /**
   * You are in. Here is the code to pass along.
   *
   * **No role**, and that is on purpose: who simulates is decided by comparing the two
   * machines, and at the instant the first captain enters there is nobody to compare
   * with. Giving a provisional role here would force correcting it later, and a client
   * that has already prepared to host and is demoted is exactly the kind of transition
   * not worth having.
   */
  | { t: 'welcome'; v: number; code: string; self: string }
  /**
   * The second captain has arrived, and now we can say who simulates.
   *
   * Both receive this message, each with their **own** role in `role` and the other's
   * nickname in `nickname`.
   */
  | { t: 'peer'; nickname: string; role: 'host' | 'guest' }
  /** All arranged: here is the world, begin. */
  | {
      t: 'start';
      /** Seed for the sea, the weather and everything that draws. */
      seed: number;
      /** The room's weather mode. Overrides both sides' local preference. */
      weather: 'dynamic' | 'clear' | 'breeze' | 'squall' | 'storm';
      /** Fraction of the day the duel starts at. */
      timeOfDay: number;
    }
  /** It is over, and why. */
  | {
      t: 'over';
      reason: 'sunk' | 'left' | 'timeout' | 'error';
      /** Index of the winner from the host's point of view, or `null`. */
      winner: 0 | 1 | null;
    }
  /** Something went wrong before starting. */
  | { t: 'error'; reason: string }
  | { t: 'pong' };

// -- match, in binary ---------------------------------------------------------

/**
 * The first byte of every binary frame.
 *
 * ⚠️ The values are the network format: append at the end, never reorder.
 */
export const MessageType = {
  /** Guest → host: a batch of `InputFrame`s. */
  Input: 1,
  /** Host → guest: the world's state. */
  Snapshot: 2,
  /** Host → guest: "my window is in the background, hold on". */
  Stall: 3,
} as const;

/**
 * How many `InputFrame`s fit in one input message.
 *
 * Four, of which two are new and two are repeats from the previous send. The
 * redundancy is what makes a lost packet invisible: the lost frame arrives again in
 * the next one, within the window in which the host still consumes it. It costs 32
 * bytes per message, on an upstream budget of ~2 KB/s — cheap enough that it is not
 * worth devising an acknowledgement and retransmission scheme.
 */
export const INPUT_BATCH = 4;

/**
 * Breaches (and nailed planks) the format carries per hull.
 *
 * It lives here, and not next to the damage model, because **it is the wire that rules
 * this number**. The list travels behind a one-byte count, and the reader on the other
 * side has to stop exactly where the writer stopped: while the two sides each had a
 * ceiling of their own — the writer sent however many there were, the reader stopped at
 * 32 — a badly battered hull misaligned the whole snapshot from there on, and the guest
 * started reading the sailor, the opponent and the events on top of bytes that belonged
 * to something else.
 *
 * One ceiling, one definition, and `ShipDamage` imports it from here so it never opens
 * more breaches than can be counted. See `MAX_BREACHES` there for what happens to a
 * shot that arrives with the list full.
 */
export const MAX_BREACHES = 24;

/**
 * Bytes of an `InputFrame` on the wire.
 *
 * Eighteen since version 2: the four that came in are the **absolute** gaze, which
 * started traveling alongside the delta. See `PlayerController.applyLook` — in short, a
 * gaze delta does not survive a lost packet, and what breaks when it does not survive is
 * the other player's interaction focus.
 */
export const INPUT_FRAME_BYTES = 18;

/**
 * Quantization scales.
 *
 * Every quantity becomes an integer through the scale that preserves the precision
 * **the eye or the physics** demand, and not one bit more. A unit quaternion in `i16`
 * errs in the fifth decimal, which on a fifteen-meter hull is half a millimeter of yaw;
 * a velocity in hundredths of m/s is finer than the resolution with which the sea
 * pushes the ship.
 */
export const QUANT = {
  /** Quaternion components, −1..1. */
  quaternion: 32767,
  /** Linear velocity, m/s. */
  velocity: 256,
  /** Angular velocity, rad/s. */
  angular: 2048,
  /** Angles in radians (wheel, traverse, elevation, head heading). */
  angle: 10000,
  /** Local positions aboard, m. */
  local: 256,
  /** Breach positions on the hull, m. */
  breach: 512,
  /**
   * A breach's effective area, m². One byte.
   *
   * ⚠️ **It was 2550, and 2550 saturates below what the game produces.** A breach is
   * born at 0.055 m² and grows to 3.2 times that by absorbing other shots
   * (`MAX_BREACH_SCALE`), meaning up to 0.176 m². With the byte's ceiling at
   * 255/2550 = 0.1 m², **43% of the useful range did not fit on the wire**: a
   * well-widened breach arrived on the other side at a little over half the size it
   * had. The side that does not simulate drew a smaller hole than the real one and,
   * worse, computed the jet from that area — 236 L/s instead of 416.
   *
   * 1400 puts the ceiling at 0.182 m², a finger above the maximum the model allows,
   * and it still gives 0.7 cm² of resolution — twenty times finer than the step the
   * area grows by.
   */
  breachArea: 1400,
  /**
   * Fraction of the day, 0..1.
   *
   * Over a twelve-minute day, one step of this scale is a hundredth of a game second —
   * meaning the sun never jumps a pixel because of the quantization. Is that too much
   * for two bytes? No: the alternative was a four-byte `f32`, and what it would gain is
   * precision in decimal places the HUD's clock does not even show.
   */
  timeOfDay: 65535,
} as const;

/** Packs a float into an `i16` range, clamping at the ends. */
export function quantize(value: number, scale: number): number {
  const scaled = Math.round(value * scale);
  return scaled < -32768 ? -32768 : scaled > 32767 ? 32767 : scaled;
}

/** Unpacks what `quantize` produced. */
export function dequantize(value: number, scale: number): number {
  return value / scale;
}

/** A valid room code: four digits from the alphabet, uppercase. */
export function isValidCode(code: string): boolean {
  if (code.length !== CODE_LENGTH) return false;
  for (const character of code) {
    if (!CODE_ALPHABET.includes(character)) return false;
  }
  return true;
}

/**
 * Makes a nickname presentable, or returns a default.
 *
 * It runs on **both sides**, and that is on purpose: the client sanitizes so the player
 * sees the name they are going in with, and the server sanitizes because network input
 * is never to be trusted — the client sending the `hello` may not be ours.
 */
export function sanitizeNickname(value: unknown): string {
  if (typeof value !== 'string') return 'Sailor';
  const cleaned = value
    // C0/C1 controls, zero width, bidirectional marks and isolates, and the BOM.
    .replace(/[\u0000-\u001F\u007F-\u009F\u200B-\u200F\u2028-\u202E\u2066-\u2069\uFEFF]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  return cleaned.length > 0 ? cleaned.slice(0, NICKNAME_MAX_LENGTH) : 'Sailor';
}
