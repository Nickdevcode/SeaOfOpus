/**
 * The unpacked world, in a form you can interpolate.
 *
 * It sits between the codec and the game for one reason only: **interpolating takes
 * two**. The client that does not simulate receives fifteen snapshots per second and
 * draws a hundred and forty-four frames; between one packet and the next it has to know
 * from where and to where. Applying straight into `Match` would give a ship that jumps
 * from pose to pose fifteen times a second.
 *
 * Everything here is preallocated and rewritten in place. See the allocation note in
 * `snapshotCodec`.
 */

import * as THREE from 'three';
import { QUANT, dequantize } from '../../shared/protocol';
import { MessageType } from '../../shared/protocol';
import type { MatchEvent, ShipSlot } from '../game/MatchEvents';
import {
  ANCHOR_STATE,
  CANNON_STATE,
  Reader,
  SNAPSHOT_FLAG,
  WEATHER_ID,
  type SnapshotHeader,
} from './snapshotCodec';

export interface BreachState {
  id: number;
  readonly local: THREE.Vector3;
  readonly normal: THREE.Vector3;
  area: number;
  repair: number;
}

/** A nailed plank, as it arrives from the simulating side. See `Patch`. */
export interface PatchState {
  id: number;
  readonly local: THREE.Vector3;
  readonly normal: THREE.Vector3;
  area: number;
}

export interface CannonState {
  traverse: number;
  elevation: number;
  state: (typeof CANNON_STATE)[number];
  loadProgress: number;
  recoil: number;
}

export interface ShipState {
  readonly position: THREE.Vector3;
  readonly orientation: THREE.Quaternion;
  readonly velocity: THREE.Vector3;
  readonly angularVelocity: THREE.Vector3;
  wheelAngle: number;
  cannonballs: number;
  planks: number;
  anchorState: (typeof ANCHOR_STATE)[number];
  anchorDeploy: number;
  readonly cannons: [CannonState, CannonState];
  floodFraction: number;
  sinkTime: number;
  /** `null` when the snapshot did not carry the list (it did not change). */
  breaches: BreachState[] | null;
  /** Same, and the two always come together: a plank is born from a breach closing. */
  patches: PatchState[] | null;
}

/**
 * The sailor's body as it arrives from the simulating side.
 *
 * It is what `PlayerController.applyRemoteStep` consumes so the opponent walks, runs,
 * jumps, climbs, steers and nails planks on this side — the fields here are exactly the
 * quantities the animation clocks need, and nothing beyond them.
 */
export interface CrewState {
  readonly local: THREE.Vector3;
  yaw: number;
  pitch: number;
  station: 'deck' | 'helm' | 'cannon';
  cannonIndex: number;
  grounded: boolean;
  onLadder: boolean;
  atCapstan: boolean;
  /** `true` when he has the plank in his hands. See `Interaction.patching`. */
  patching: boolean;
  /**
   * `true` when he is in the sea.
   *
   * The only water state that crosses the wire — the rest is derived from the position,
   * which already travels. See `PlayerController.inWater`.
   */
  inWater: boolean;
}

/** The sky and the weather, as they arrive from the simulating side. See `writeSky`. */
export interface SkyState {
  /** Fraction of the day, 0..1. */
  timeOfDay: number;
  /** The weather that is up, and what it is turning into. */
  current: (typeof WEATHER_ID)[number];
  target: (typeof WEATHER_ID)[number];
  /** Base wind, without the gust. The severity comes out of it. */
  baseWind: number;
  clouds: number;
  rain: number;
  /** Visibility range, in meters. */
  visibility: number;
  flash: number;
}

export interface WorldState {
  tick: number;
  bufferDepth: number;
  /** Steps with no command on the host since the previous snapshot. See the codec. */
  starved: number;
  /**
   * The last input tick the host consumed.
   *
   * It is not telemetry: it is the **receipt**. It is how the client knows whether the
   * command that made it take the helm on this side has already been seen on the other —
   * see `GuestSession.applyCrew`.
   */
  ackTick: number;
  over: boolean;
  winner: 0 | 1;
  windDirection: number;
  windStrength: number;
  waveTime: number;
  /** The background swell's heading. See the note in the codec — without it, two seas. */
  swellDirection: number;
  readonly sky: SkyState;
  readonly ships: [ShipState, ShipState];
  readonly crew: [CrewState, CrewState];
  /** This interval's events. Consumed once and cleared. */
  readonly events: MatchEvent[];
}

function createCannon(): CannonState {
  return { traverse: 0, elevation: 0.1, state: 'empty', loadProgress: 0, recoil: 0 };
}

function createShipState(): ShipState {
  return {
    position: new THREE.Vector3(),
    orientation: new THREE.Quaternion(),
    velocity: new THREE.Vector3(),
    angularVelocity: new THREE.Vector3(),
    wheelAngle: 0,
    cannonballs: 0,
    planks: 0,
    anchorState: 'stowed',
    anchorDeploy: 0,
    cannons: [createCannon(), createCannon()],
    floodFraction: 0,
    sinkTime: 0,
    breaches: null,
    patches: null,
  };
}

function createCrewState(): CrewState {
  return {
    local: new THREE.Vector3(),
    yaw: 0,
    pitch: 0,
    station: 'deck',
    cannonIndex: -1,
    grounded: true,
    onLadder: false,
    atCapstan: false,
    patching: false,
    inWater: false,
  };
}

function createSkyState(): SkyState {
  return {
    timeOfDay: 0.68,
    current: 'breeze',
    target: 'breeze',
    baseWind: 0.62,
    clouds: 0.46,
    rain: 0,
    visibility: 3200,
    flash: 0,
  };
}

export function createWorldState(): WorldState {
  return {
    tick: 0,
    bufferDepth: 0,
    starved: 0,
    ackTick: 0,
    over: false,
    winner: 0,
    windDirection: 0,
    windStrength: 0,
    waveTime: 0,
    swellDirection: 0,
    sky: createSkyState(),
    ships: [createShipState(), createShipState()],
    crew: [createCrewState(), createCrewState()],
    events: [],
  };
}

/** A pool of breaches and planks, so the read does not allocate per frame. */
const breachPool: BreachState[][] = [[], []];
const patchPool: PatchState[][] = [[], []];

function borrowBreach(slot: ShipSlot, index: number): BreachState {
  const pool = breachPool[slot]!;
  let entry = pool[index];
  if (!entry) {
    entry = { id: 0, local: new THREE.Vector3(), normal: new THREE.Vector3(), area: 0, repair: 0 };
    pool[index] = entry;
  }
  return entry;
}

function borrowPatch(slot: ShipSlot, index: number): PatchState {
  const pool = patchPool[slot]!;
  let entry = pool[index];
  if (!entry) {
    entry = { id: 0, local: new THREE.Vector3(), normal: new THREE.Vector3(), area: 0 };
    pool[index] = entry;
  }
  return entry;
}

function readShip(r: Reader, target: ShipState, slot: ShipSlot, withBreaches: boolean): void {
  r.vec3(target.position);
  target.orientation.set(
    dequantize(r.i16(), QUANT.quaternion),
    dequantize(r.i16(), QUANT.quaternion),
    dequantize(r.i16(), QUANT.quaternion),
    dequantize(r.i16(), QUANT.quaternion),
  );
  // Quantizing four independent components takes the quaternion off unit length by a few
  // ten-thousandths. Normalizing here is one square root per ship per snapshot, and it
  // keeps the error from entering a composition of rotations.
  target.orientation.normalize();

  target.velocity.set(
    dequantize(r.i16(), QUANT.velocity),
    dequantize(r.i16(), QUANT.velocity),
    dequantize(r.i16(), QUANT.velocity),
  );
  target.angularVelocity.set(
    dequantize(r.i16(), QUANT.angular),
    dequantize(r.i16(), QUANT.angular),
    dequantize(r.i16(), QUANT.angular),
  );

  target.wheelAngle = dequantize(r.i16(), QUANT.angle);
  target.cannonballs = r.u16();
  target.planks = r.u8();
  target.anchorState = ANCHOR_STATE[r.u8()] ?? 'stowed';
  target.anchorDeploy = r.u8() / 255;

  for (const cannon of target.cannons) {
    cannon.traverse = dequantize(r.i16(), QUANT.angle);
    cannon.elevation = dequantize(r.i16(), QUANT.angle);
    cannon.state = CANNON_STATE[r.u8()] ?? 'empty';
    cannon.loadProgress = r.u8() / 255;
    cannon.recoil = r.u8() / 255;
  }

  target.floodFraction = r.u16() / 65535;
  target.sinkTime = r.u16() / 1000;

  if (!withBreaches) {
    target.breaches = null;
    target.patches = null;
    return;
  }

  // ⚠️ No `Math.min` here: the writer already clamps at `MAX_BREACHES`, and clamping
  // again **on this side** was precisely the defect — the reader stopped before the
  // writer and all the rest of the snapshot came out shifted. One ceiling only, at the
  // source.
  const breachCount = r.u8();
  const breaches: BreachState[] = [];
  for (let i = 0; i < breachCount; i++) {
    const breach = borrowBreach(slot, i);
    breach.id = r.u8();
    r.local(breach.local, QUANT.breach);
    breach.normal.set(r.i8() / 127, r.i8() / 127, r.i8() / 127).normalize();
    breach.area = r.u8() / QUANT.breachArea;
    breach.repair = r.u8() / 255;
    breaches.push(breach);
  }
  target.breaches = breaches;

  const patchCount = r.u8();
  const patches: PatchState[] = [];
  for (let i = 0; i < patchCount; i++) {
    const patch = borrowPatch(slot, i);
    patch.id = r.u8();
    r.local(patch.local, QUANT.breach);
    patch.normal.set(r.i8() / 127, r.i8() / 127, r.i8() / 127).normalize();
    patch.area = r.u8() / QUANT.breachArea;
    patches.push(patch);
  }
  target.patches = patches;
}

/** The sky and the weather. See `writeSky`, on the other side. */
function readSky(r: Reader, sky: SkyState): void {
  sky.timeOfDay = r.u16() / QUANT.timeOfDay;
  sky.current = WEATHER_ID[r.u8()] ?? 'breeze';
  sky.target = WEATHER_ID[r.u8()] ?? 'breeze';
  sky.baseWind = r.u8() / 255;
  sky.clouds = r.u8() / 255;
  sky.rain = r.u8() / 255;
  sky.visibility = r.u16();
  sky.flash = r.u8() / 255;
}

function readEvents(r: Reader, out: MatchEvent[]): void {
  out.length = 0;
  const count = r.u8();

  for (let i = 0; i < count; i++) {
    const kind = r.u8();
    switch (kind) {
      case 1: {
        const ship = r.u8() as ShipSlot;
        const position = new THREE.Vector3();
        r.vec3(position);
        const direction = new THREE.Vector3(r.i8() / 127, r.i8() / 127, r.i8() / 127).normalize();
        out.push({ kind: 'shot', ship, position, direction });
        break;
      }
      case 2: {
        const position = new THREE.Vector3();
        r.vec3(position);
        out.push({ kind: 'splash', position, speed: r.u8() });
        break;
      }
      case 3: {
        const packed = r.u8();
        const position = new THREE.Vector3();
        r.vec3(position);
        const normal = new THREE.Vector3(r.i8() / 127, r.i8() / 127, r.i8() / 127).normalize();
        out.push({
          kind: 'hull',
          ship: (packed & 1) as ShipSlot,
          position,
          normal,
          speed: r.u8(),
          flooded: (packed & 2) !== 0,
        });
        break;
      }
      case 4: {
        const ship = r.u8() as ShipSlot;
        const position = new THREE.Vector3();
        r.vec3(position);
        out.push({ kind: 'mast', ship, position, speed: r.u8() });
        break;
      }
      case 5: {
        const position = new THREE.Vector3();
        r.vec3(position);
        out.push({ kind: 'collision', position, speed: r.u8() });
        break;
      }
      default:
        // Unknown type: it came from a version this client does not understand, and
        // there is no way to know how many bytes to skip. Stopping the read is the only
        // safe path — the rest of the frame is lost anyway.
        return;
    }
  }
}

/**
 * Reads a snapshot into a `WorldState`.
 *
 * The real body is `readSnapshot`; this is the shell that turns a truncated frame or one
 * from another version into `null` instead of into an exception. `DataView` throws when
 * reading past the end, and that exception would go up through the socket's `onmessage`:
 * a single bad packet would take down the whole game's network handler, and the symptom
 * would be the world freezing with no visible error at all.
 *
 * @returns the header, or `null` if the frame is not a valid snapshot.
 */
export function decodeSnapshot(buffer: ArrayBuffer, target: WorldState): SnapshotHeader | null {
  try {
    return readSnapshot(buffer, target);
  } catch {
    return null;
  }
}

function readSnapshot(buffer: ArrayBuffer, target: WorldState): SnapshotHeader | null {
  if (buffer.byteLength < 10) return null;
  const r = new Reader(new DataView(buffer));
  if (r.u8() !== MessageType.Snapshot) return null;

  const flags = r.u8();
  target.tick = r.u32();
  target.bufferDepth = r.u8();
  target.starved = r.u8();
  target.ackTick = r.u32();
  target.winner = (r.u8() === 1 ? 1 : 0) as 0 | 1;
  target.over = (flags & SNAPSHOT_FLAG.Over) !== 0;

  target.windDirection = dequantize(r.i16(), QUANT.angle);
  target.windStrength = r.u8() / 255;
  target.waveTime = r.f32();
  target.swellDirection = dequantize(r.i16(), QUANT.angle);

  readSky(r, target.sky);

  const withBreaches = (flags & SNAPSHOT_FLAG.Breaches) !== 0;
  readShip(r, target.ships[0], 0, withBreaches);
  readShip(r, target.ships[1], 1, withBreaches);

  for (let i = 0; i < 2; i++) {
    const crew = target.crew[i]!;
    r.local(crew.local, QUANT.local);
    crew.yaw = dequantize(r.i16(), QUANT.angle);
    crew.pitch = dequantize(r.i16(), QUANT.angle);
    const packed = r.u8();
    const station = packed & 0b11;
    crew.station = station === 1 ? 'helm' : station === 2 ? 'cannon' : 'deck';
    crew.cannonIndex = crew.station === 'cannon' ? (packed >> 2) & 1 : -1;
    crew.grounded = (packed & (1 << 3)) !== 0;
    crew.onLadder = (packed & (1 << 4)) !== 0;
    crew.atCapstan = (packed & (1 << 5)) !== 0;
    crew.patching = (packed & (1 << 6)) !== 0;
    // The byte's last bit. See the writer's note.
    crew.inWater = (packed & (1 << 7)) !== 0;
  }

  readEvents(r, target.events);

  return {
    tick: target.tick,
    bufferDepth: target.bufferDepth,
    starved: target.starved,
    ackTick: target.ackTick,
    over: target.over,
    winner: target.winner,
  };
}
