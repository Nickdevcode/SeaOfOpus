/**
 * The world state in bytes, and back.
 *
 * ## What does **not** go in the snapshot
 *
 * The cannonballs. And it isn't about saving bytes: `stepBallistic` is a pure
 * function with no randomness at all, and the shot event already carries the exact
 * muzzle position and velocity. The client that receives that event spawns the
 * cannonball and integrates it at 60 Hz — the trajectory comes out **identical**
 * to the host's, and smoother than interpolating at 15 Hz a position that arrives
 * over the wire. Send the shot, not the flight.
 *
 * ## Quantization, not delta compression
 *
 * A quaternion fits in four `i16` with error in the fifth decimal — half a
 * millimeter of yaw on a fifteen-meter hull. That shrinks the snapshot tenfold and
 * is **stateless**: every frame reads on its own.
 *
 * Delta compression would shrink it further and cost dearly elsewhere: it would
 * require a history of acknowledged snapshots on the host, an acknowledgement from
 * the client, and a baseline common to both. A whole class of bug where the client
 * applies a difference against the wrong base and drifts away from the truth
 * without ever noticing.
 *
 * The one concession is the breach list, which goes in a **conditional field**: it
 * is only written when it changed. A conditional field is not a delta — still no
 * baseline, no history and no chain; it's just a field that sometimes isn't there.
 *
 * ## Nothing allocates per frame
 *
 * The buffer and the `DataView` are created once. At 15 snapshots per second, a
 * fresh `ArrayBuffer` for each one would be garbage for the collector to pick up
 * inside the render frame's 16 ms budget.
 */

import type * as THREE from 'three';
import { MessageType, QUANT, dequantize, quantize } from '../../shared/protocol';
import { wrapAngle } from '../core/MathUtils';
import type { InputFrame } from '../core/InputFrame';
import { INPUT_FRAME_BYTES, MAX_BREACHES } from '../../shared/protocol';
import type { Match } from '../game/Match';
import type { MatchEvent } from '../game/MatchEvents';
import type { Ship } from '../ship/Ship';

/** Cap for one frame. The same as the server's — see `MAX_FRAME_BYTES` there. */
const BUFFER_BYTES = 4096;

/** Bits of the snapshot's flag byte. */
const SNAPSHOT_FLAG = {
  /** The breach list comes along because it changed since the last one. */
  Breaches: 1 << 0,
  /** The match is over; `winner` is in the frame. */
  Over: 1 << 1,
} as const;

/** A cannon's state, on the wire. */
const CANNON_STATE = ['empty', 'loading', 'loaded'] as const;

/** The anchor's state, on the wire. */
const ANCHOR_STATE = ['stowed', 'dropping', 'set', 'raising'] as const;

/**
 * The weather states, on the wire.
 *
 * ⚠️ The order is the network format — append at the end, never reorder. It's the
 * same rule as `MessageType` and `InputBit`, and here it counts twice: reordering
 * would swap storm for clear sky between two versions of the game, and the symptom
 * would be an opponent sailing through a storm the other one can't see.
 */
const WEATHER_ID = ['clear', 'breeze', 'squall', 'storm'] as const;

/**
 * A sequential writer over a fixed buffer.
 *
 * `DataView` with **explicit** endianness on every call. `DataView` defaults to
 * big-endian, the machines this runs on default to little — letting the default
 * stand would give code that works because both sides get it wrong the same way,
 * and that breaks the day one of them stops getting it wrong.
 */
class Writer {
  offset = 0;
  constructor(private readonly view: DataView) {}

  u8(value: number): void {
    this.view.setUint8(this.offset, value);
    this.offset += 1;
  }
  i8(value: number): void {
    this.view.setInt8(this.offset, value);
    this.offset += 1;
  }
  u16(value: number): void {
    this.view.setUint16(this.offset, value, true);
    this.offset += 2;
  }
  i16(value: number): void {
    this.view.setInt16(this.offset, value, true);
    this.offset += 2;
  }
  u32(value: number): void {
    this.view.setUint32(this.offset, value, true);
    this.offset += 4;
  }
  f32(value: number): void {
    this.view.setFloat32(this.offset, value, true);
    this.offset += 4;
  }
  /** A world vector, at full precision: the sea is kilometers across. */
  vec3(v: THREE.Vector3): void {
    this.f32(v.x);
    this.f32(v.y);
    this.f32(v.z);
  }
  /** A vector local to the ship, quantized: the ship is fifteen meters long. */
  local(v: THREE.Vector3, scale: number): void {
    this.i16(quantize(v.x, scale));
    this.i16(quantize(v.y, scale));
    this.i16(quantize(v.z, scale));
  }
}

class Reader {
  offset = 0;
  constructor(private readonly view: DataView) {}

  u8(): number {
    const value = this.view.getUint8(this.offset);
    this.offset += 1;
    return value;
  }
  i8(): number {
    const value = this.view.getInt8(this.offset);
    this.offset += 1;
    return value;
  }
  u16(): number {
    const value = this.view.getUint16(this.offset, true);
    this.offset += 2;
    return value;
  }
  i16(): number {
    const value = this.view.getInt16(this.offset, true);
    this.offset += 2;
    return value;
  }
  u32(): number {
    const value = this.view.getUint32(this.offset, true);
    this.offset += 4;
    return value;
  }
  f32(): number {
    const value = this.view.getFloat32(this.offset, true);
    this.offset += 4;
    return value;
  }
  vec3(target: THREE.Vector3): THREE.Vector3 {
    target.set(this.f32(), this.f32(), this.f32());
    return target;
  }
  local(target: THREE.Vector3, scale: number): THREE.Vector3 {
    target.set(
      dequantize(this.i16(), scale),
      dequantize(this.i16(), scale),
      dequantize(this.i16(), scale),
    );
    return target;
  }
}

// -- input: guest → host ------------------------------------------------------

const inputBuffer = new ArrayBuffer(256);
const inputView = new DataView(inputBuffer);

/**
 * Packs a batch of input frames.
 *
 * Four go per message: the two newest plus two repeated from the previous send.
 * The repetition is what makes losing a packet cost nothing: the frame that was
 * lost arrives again in the next one, and the host still consumes it in time. It's
 * cheaper than acknowledging and resending.
 */
export function encodeInput(frames: readonly InputFrame[]): ArrayBuffer {
  const w = new Writer(inputView);
  w.u8(MessageType.Input);
  w.u8(frames.length);

  for (const frame of frames) {
    w.u32(frame.tick);
    w.u16(frame.held);
    w.u16(frame.pressed);
    // The walk axes are −1..1 and come from keys or from a stick: a signed byte
    // gives 1/127 of resolution, finer than the controller's dead zone.
    w.i8(Math.round(Math.max(-1, Math.min(1, frame.moveX)) * 127));
    w.i8(Math.round(Math.max(-1, Math.min(1, frame.moveY)) * 127));
    // The delta still goes, and it's what the **cannon's aim** consumes: it is
    // accumulate-and-clamp over the same increments on both sides.
    w.i16(quantize(frame.lookX, QUANT.angle));
    w.i16(quantize(frame.lookY, QUANT.angle));
    // And the **absolute** gaze goes along, four extra bytes, because a delta
    // doesn't survive a lost packet — see `PlayerController.applyLook` for what
    // breaks when it doesn't survive.
    //
    // The heading is normalized to −π..π before quantizing: it grows without bound
    // while the player keeps turning the same way, and the `i16` at this scale
    // saturates at ±3.27 rad. Without normalizing, half a dozen turns would clamp
    // the opponent's head into a corner for the rest of the match.
    w.i16(quantize(wrapAngle(frame.yaw), QUANT.angle));
    w.i16(quantize(frame.pitch, QUANT.angle));
  }

  return inputBuffer.slice(0, w.offset);
}

/**
 * Unpacks a batch of input into the objects passed in.
 *
 * The count is checked against the **buffer size** before any read, and that isn't
 * theoretical diligence: a truncated (or forged) frame would make `DataView` throw
 * in the middle of the loop, and that throw travels up through the socket's
 * `onmessage` — meaning one bad packet from one side would take down the other's
 * network handler. Returning zero frames is the right answer: `InputBuffer` already
 * knows what to do when no command arrives.
 */
export function decodeInput(buffer: ArrayBuffer, out: InputFrame[]): number {
  if (buffer.byteLength < 2) return 0;
  const r = new Reader(new DataView(buffer));
  r.u8();
  const count = r.u8();
  if (buffer.byteLength < 2 + count * INPUT_FRAME_BYTES) return 0;

  for (let i = 0; i < count && i < out.length; i++) {
    const frame = out[i]!;
    frame.tick = r.u32();
    frame.held = r.u16();
    frame.pressed = r.u16();
    frame.moveX = r.i8() / 127;
    frame.moveY = r.i8() / 127;
    frame.lookX = dequantize(r.i16(), QUANT.angle);
    frame.lookY = dequantize(r.i16(), QUANT.angle);
    frame.yaw = dequantize(r.i16(), QUANT.angle);
    frame.pitch = dequantize(r.i16(), QUANT.angle);
    // What comes off the wire rules the **head** angle; the delta still rules the
    // gun's aim. See `PlayerController.applyLook`.
    frame.absoluteView = true;
  }

  return Math.min(count, out.length);
}

// -- snapshot: host → guest ---------------------------------------------------

const snapshotBuffer = new ArrayBuffer(BUFFER_BYTES);
const snapshotView = new DataView(snapshotBuffer);

/** A snapshot's header, once read. */
export interface SnapshotHeader {
  tick: number;
  /** Input frames the host has queued. The guest adjusts its lead from this. */
  bufferDepth: number;
  /**
   * Steps with no command since the previous snapshot.
   *
   * It's the signal that tells the lead to go up, and it exists because the queue
   * depth does **not** tell apart the two cases that matter: it sits at zero both
   * when the command arrives too late and when it arrives exactly on time. Driving
   * the lead from the queue alone made it climb on top of the second case and never
   * come back down — 22 steps of delay on a connection that asked for 12.
   */
  starved: number;
  /** Last input tick the host consumed — measures the round trip for free. */
  ackTick: number;
  over: boolean;
  winner: 0 | 1;
}

export interface EncodeOptions {
  bufferDepth: number;
  starved: number;
  ackTick: number;
  /** `true` when the breach list changed since the last snapshot. */
  includeBreaches: boolean;
  over: boolean;
  winner: 0 | 1;
}

function writeShip(w: Writer, ship: Ship, includeBreaches: boolean): void {
  const { body } = ship;
  w.vec3(body.comPosition);
  w.i16(quantize(body.orientation.x, QUANT.quaternion));
  w.i16(quantize(body.orientation.y, QUANT.quaternion));
  w.i16(quantize(body.orientation.z, QUANT.quaternion));
  w.i16(quantize(body.orientation.w, QUANT.quaternion));
  w.i16(quantize(body.velocity.x, QUANT.velocity));
  w.i16(quantize(body.velocity.y, QUANT.velocity));
  w.i16(quantize(body.velocity.z, QUANT.velocity));
  w.i16(quantize(body.angularVelocity.x, QUANT.angular));
  w.i16(quantize(body.angularVelocity.y, QUANT.angular));
  w.i16(quantize(body.angularVelocity.z, QUANT.angular));

  w.i16(quantize(ship.rudder.wheelAngle, QUANT.angle));
  w.u16(Math.min(ship.cannonballs, 65535));
  w.u8(Math.min(ship.planks, 255));

  const anchorIndex = ANCHOR_STATE.indexOf(ship.anchor.state);
  w.u8(anchorIndex < 0 ? 0 : anchorIndex);
  w.u8(Math.round(Math.max(0, Math.min(1, ship.anchor.deploy)) * 255));

  for (const cannon of ship.cannons) {
    w.i16(quantize(cannon.traverse, QUANT.angle));
    w.i16(quantize(cannon.elevation, QUANT.angle));
    const stateIndex = CANNON_STATE.indexOf(cannon.state);
    w.u8(stateIndex < 0 ? 0 : stateIndex);
    w.u8(Math.round(Math.max(0, Math.min(1, cannon.loadProgress)) * 255));
    // Recoil is 0..~0.6 m; a byte over half a meter gives 2 mm of resolution, far
    // finer than the eye can tell on a barrel that travels in 0.15 s.
    w.u8(Math.round(Math.max(0, Math.min(1, cannon.recoil)) * 255));
  }

  const { damage } = ship;
  // The water in the hold goes as a fraction of capacity: the absolute number has
  // digits nobody cares about, and the fraction is exactly what the HUD draws.
  w.u16(Math.round(Math.max(0, Math.min(1, damage.floodFraction)) * 65535));
  w.u16(Math.round(Math.min(damage.sinkTime, 65) * 1000));

  if (!includeBreaches) return;

  // ⚠️ The cap is the **same** on both sides of the wire, and now it's a single
  // constant, imported from where the breaches live. While the writer sent however
  // many there were and the reader stopped at 32, a badly battered hull threw the
  // whole snapshot out of alignment from there on. See `MAX_BREACHES`.
  const breachCount = Math.min(damage.breaches.length, MAX_BREACHES);
  w.u8(breachCount);
  for (let i = 0; i < breachCount; i++) {
    const breach = damage.breaches[i]!;
    w.u8(breach.id & 0xff);
    w.local(breach.local, QUANT.breach);
    w.i8(Math.round(breach.normal.x * 127));
    w.i8(Math.round(breach.normal.y * 127));
    w.i8(Math.round(breach.normal.z * 127));
    // The scale lives in `QUANT` because it is **not obvious**: see the note there
    // for the cap that saturated and cut a widened breach nearly in half.
    w.u8(Math.round(Math.min(breach.area * QUANT.breachArea, 255)));
    w.u8(Math.round(Math.max(0, Math.min(1, breach.repair)) * 255));
  }

  // The nailed planks travel along, and that's what was missing for the opponent's
  // hull side to tell the right story: without them, a breach patched on the other
  // side simply **vanished** from the hull here, instead of becoming a scar with
  // wood over it. A ship at the end of a long fight is a patchwork quilt, and half
  // of that reading was being lost on the wire.
  //
  // Eleven bytes per plank, and only when the list changes: `repair` doesn't exist
  // here (a plank is either nailed or it isn't), so it's a breach minus one byte.
  const patchCount = Math.min(damage.patches.length, MAX_BREACHES);
  w.u8(patchCount);
  for (let i = 0; i < patchCount; i++) {
    const patch = damage.patches[i]!;
    w.u8(patch.id & 0xff);
    w.local(patch.local, QUANT.breach);
    w.i8(Math.round(patch.normal.x * 127));
    w.i8(Math.round(patch.normal.y * 127));
    w.i8(Math.round(patch.normal.z * 127));
    w.u8(Math.round(Math.min(patch.area * QUANT.breachArea, 255)));
  }
}

/**
 * Writes the whole world into a buffer and returns the slice used.
 *
 * The slice is a copy — `WebSocket.send` is asynchronous and the buffer is reused
 * on the next snapshot; sending the live memory would be sending bytes that have
 * already changed by the time they leave.
 */
export function encodeSnapshot(match: Match, options: EncodeOptions): ArrayBuffer {
  const w = new Writer(snapshotView);

  w.u8(MessageType.Snapshot);
  let flags = 0;
  if (options.includeBreaches) flags |= SNAPSHOT_FLAG.Breaches;
  if (options.over) flags |= SNAPSHOT_FLAG.Over;
  w.u8(flags);
  w.u32(match.tick);
  w.u8(Math.min(options.bufferDepth, 255));
  w.u8(Math.min(options.starved, 255));
  // Four bytes, not two: see the version 2 note in `PROTOCOL_VERSION`.
  w.u32(options.ackTick >>> 0);
  w.u8(options.winner);

  // Wind and sea state. Without this, each side's weather would run on its own
  // clock — and wind feeds the sail force, so it would be an advantage for one of
  // the two. See the note about weather mode in `DuelRoom.onReady`.
  const waves = match.environment.waveField;
  w.i16(quantize(waves.windDirection, QUANT.angle));
  w.u8(Math.round(Math.max(0, Math.min(1, waves.windStrength)) * 255));
  w.f32(waves.time);
  // ⚠️ **The background swell's heading, and it was missing.** The spectrum's two
  // long waves compose their direction from this angle (see
  // `WaveField.syncUniforms`), and they are precisely the ones that lift a 16 m
  // hull. It was born from each client's *local* wind — different on the two,
  // because each had spent a different amount of time on the title screen — and
  // after that it only moved on the side that simulates, because what moves it is
  // `followWind`. Result: two distinct seas from the very first frame, and a ship
  // that, to one of the two, floats off the wave. Two bytes settle the whole bill.
  w.i16(quantize(wrapAngle(waves.swellDirection), QUANT.angle));

  writeSky(w, match);

  for (const ship of match.ships) writeShip(w, ship, options.includeBreaches);

  for (const crewman of match.crew) {
    const c = crewman.controller;
    w.local(c.local, QUANT.local);
    // ⚠️ **Normalized, like on the input path — and for a long time it wasn't.**
    //
    // The two paths were born at different times and only one of them learned the
    // lesson: `encodeInput` has wrapped ever since the gaze started traveling
    // absolute (see the note there), and this one was left behind because the
    // question looked different — "my own deckhand's heading" sounds like a small
    // number, and for a player who only looks around it is.
    //
    // Except `PlayerController.yaw` is **never** normalized: it integrates the mouse
    // look, which grows without bound for anyone who keeps turning the same way, and
    // on top of that it **accumulates a whole turn per capstan turn**
    // (`followCapstan` adds the swept angle straight into the heading). At this
    // scale the `i16` saturates at ±3.2767 rad, that is at ±187.7°: weighing anchor
    // means passing that on the first turn. What the other side saw was the
    // opponent's head and body heading **stuck** against the stop while he went
    // round and round the capstan, and his body frozen sideways instead of
    // following the bar.
    //
    // The fix sits here, and not at the source, on purpose: normalizing `yaw`
    // inside the controller is safe (everything that consumes that angle already
    // works the short way round — `damp` with `wrapAngle`, `setFromEuler`,
    // `foldLegHeading`), but it would be a behavior change across five files to fix
    // a defect that exists in one. Here is where the number enters the range it
    // doesn't fit in, and here is where it's put back into it.
    w.i16(quantize(wrapAngle(c.yaw), QUANT.angle));
    w.i16(quantize(c.pitch, QUANT.angle));
    const station = c.station === 'deck' ? 0 : c.station === 'helm' ? 1 : 2;
    // Station, cannon and the five body states **fill the byte**: that's 2 + 1 + 5
    // bits of information, and a field per thing would cost six bytes per deckhand
    // in each of the fifteen snapshots per second. No flag is left over here — the
    // next one pays a byte.
    //
    // The plank in hand is the only one of them that does **not** come out of the
    // controller: what sees the breach and the held button in the same step is
    // `Interaction`. Without this bit the opponent patched breaches empty-handed —
    // see the protocol's version 6 note.
    //
    // The sea is the last one, and it's the only water state that travels: the
    // position already goes, and the rest is derived from it — including **which
    // boarding ladder** he's hanging on, because the two sit seven meters apart in
    // Z. See `PlayerController.boardingLadder`.
    w.u8(
      station |
        ((c.cannonIndex < 0 ? 0 : c.cannonIndex) << 2) |
        (c.grounded ? 1 << 3 : 0) |
        (c.onLadder ? 1 << 4 : 0) |
        (c.atCapstan ? 1 << 5 : 0) |
        (crewman.interaction.patching ? 1 << 6 : 0) |
        (c.inWater ? 1 << 7 : 0),
    );
  }

  // `netEvents`, and **not** `events`: the latter is drained once per frame by the
  // drawing, and the snapshot goes out every four steps. See the note in
  // `Match.netEvents` — it's the difference between the guest seeing every shot and
  // seeing one in four.
  writeEvents(w, match.netEvents);

  return snapshotBuffer.slice(0, w.offset);
}

/**
 * The sky and the weather: ten bytes that were missing.
 *
 * ## Why the snapshot carries this
 *
 * Because the client that doesn't simulate **runs neither the day clock nor the
 * weather state machine**, and can't. `Environment.fixedUpdate` lives inside
 * `Match.fixedUpdate`, which is the path of whoever simulates; the guest goes
 * through `fixedUpdateRemote`. The effect is that, the moment the duel starts, its
 * clock freezes at the hour it was at and its weather stops in the state it was
 * in — while on the other side the sun moves, the rain arrives and the storm
 * rolls in. Two players, two skies, and no warning that it works that way.
 *
 * Letting both sides **simulate** the weather in parallel would be the
 * alternative — the state machine is seeded and deterministic — but it depends on
 * summing `dt` in floating point for ten minutes and on neither side ever missing
 * a step, and the guest misses steps by construction (the engine drops the surplus
 * when the tab hitches). A divergence here isn't a pixel: it's the wind, and wind
 * is sail force.
 *
 * ## What goes, and what is derived
 *
 * The two states of the transition (`current` and `target`) go instead of the
 * label and the severity: with them, `label` and `severity` come out of the same
 * getters that already exist, and the HUD text doesn't need to cross the wire.
 */
function writeSky(w: Writer, match: Match): void {
  const { weather, dayNight } = match.environment;

  w.u16(Math.round(((dayNight.timeOfDay % 1) + 1) % 1 * QUANT.timeOfDay));

  const current = WEATHER_ID.indexOf(weather.current);
  const target = WEATHER_ID.indexOf(weather.target);
  w.u8(current < 0 ? 1 : current);
  w.u8(target < 0 ? 1 : target);
  w.u8(Math.round(Math.max(0, Math.min(1, weather.windBase)) * 255));
  w.u8(Math.round(Math.max(0, Math.min(1, weather.clouds)) * 255));
  w.u8(Math.round(Math.max(0, Math.min(1, weather.rain)) * 255));
  // Visibility in meters fits comfortably in a `u16`: the most open preset is
  // 4,200 m and the camera's `far` is 12,000.
  w.u16(Math.min(Math.round(weather.visibility), 65535));
  w.u8(Math.round(Math.max(0, Math.min(1, weather.flash)) * 255));
}

/**
 * The events from the interval since the last snapshot.
 *
 * It's what carries the boom, the splash, the splinter and the flash to the other
 * side. Without them the guest's duel would be mute and smokeless — and, worse, it
 * would have nowhere to get the cannonballs from, since they are born from the shot
 * event.
 */
function writeEvents(w: Writer, events: readonly MatchEvent[]): void {
  // The cap protects the buffer in an exceptional interval — four steps with two
  // full broadsides and a ramming in the middle. Thirty-two events are some 600
  // bytes in a frame that rarely passes 900, so the slack is still enormous; losing
  // the thirty-third boom of a moment like that isn't a loss anyone notices, and
  // blowing the buffer takes down the match.
  const count = Math.min(events.length, 32);
  w.u8(count);

  for (let i = 0; i < count; i++) {
    const event = events[i]!;
    switch (event.kind) {
      case 'shot':
        w.u8(1);
        w.u8(event.ship);
        w.vec3(event.position);
        w.i8(Math.round(event.direction.x * 127));
        w.i8(Math.round(event.direction.y * 127));
        w.i8(Math.round(event.direction.z * 127));
        break;
      case 'splash':
        w.u8(2);
        w.vec3(event.position);
        w.u8(Math.min(Math.round(event.speed), 255));
        break;
      case 'hull':
        w.u8(3);
        w.u8(event.ship | (event.flooded ? 1 << 1 : 0));
        w.vec3(event.position);
        w.i8(Math.round(event.normal.x * 127));
        w.i8(Math.round(event.normal.y * 127));
        w.i8(Math.round(event.normal.z * 127));
        w.u8(Math.min(Math.round(event.speed), 255));
        break;
      case 'mast':
        w.u8(4);
        w.u8(event.ship);
        w.vec3(event.position);
        w.u8(Math.min(Math.round(event.speed), 255));
        break;
      case 'collision':
        w.u8(5);
        w.vec3(event.position);
        w.u8(Math.min(Math.round(event.speed), 255));
        break;
    }
  }
}

export { SNAPSHOT_FLAG, CANNON_STATE, ANCHOR_STATE, WEATHER_ID, Reader, Writer };

/** Reads the header only, for callers that must decide before applying. */
export function peekSnapshotHeader(buffer: ArrayBuffer): SnapshotHeader | null {
  if (buffer.byteLength < 12) return null;
  const r = new Reader(new DataView(buffer));
  if (r.u8() !== MessageType.Snapshot) return null;
  const flags = r.u8();
  return {
    tick: r.u32(),
    bufferDepth: r.u8(),
    starved: r.u8(),
    ackTick: r.u32(),
    over: (flags & SNAPSHOT_FLAG.Over) !== 0,
    winner: (r.u8() === 1 ? 1 : 0) as 0 | 1,
  };
}
