/**
 * O mundo desempacotado, num formato que se pode interpolar.
 *
 * Fica entre o codec e o jogo por uma razão só: **interpolar exige dois**. O
 * cliente que não simula recebe quinze instantâneos por segundo e desenha a
 * cento e quarenta e quatro quadros; entre um pacote e o seguinte ele tem de
 * saber de onde e para onde. Aplicar direto no `Match` daria um navio que salta
 * de pose em pose quinze vezes por segundo.
 *
 * Tudo aqui é pré-alocado e reescrito no lugar. Ver a nota de alocação em
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

/** Uma tábua pregada, como ela chega do lado que simula. Ver `Patch`. */
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
  /** `null` quando o instantâneo não trouxe a lista (ela não mudou). */
  breaches: BreachState[] | null;
  /** Idem, e as duas vêm sempre juntas: uma tábua nasce de um rombo que fecha. */
  patches: PatchState[] | null;
}

export interface CrewState {
  readonly local: THREE.Vector3;
  yaw: number;
  pitch: number;
  station: 'deck' | 'helm' | 'cannon';
  cannonIndex: number;
  grounded: boolean;
  onLadder: boolean;
  atCapstan: boolean;
}

/** O céu e o tempo, como eles chegam do lado que simula. Ver `writeSky`. */
export interface SkyState {
  /** Fração do dia, 0..1. */
  timeOfDay: number;
  /** O tempo que está no ar, e para onde ele está virando. */
  current: (typeof WEATHER_ID)[number];
  target: (typeof WEATHER_ID)[number];
  /** Vento de base, sem a rajada. É dele que sai a severidade. */
  baseWind: number;
  clouds: number;
  rain: number;
  /** Alcance de visibilidade, em metros. */
  visibility: number;
  flash: number;
}

export interface WorldState {
  tick: number;
  bufferDepth: number;
  /** Passos sem comando no host desde o instantâneo anterior. Ver o codec. */
  starved: number;
  /**
   * Último tick de entrada que o host consumiu.
   *
   * Não é telemetria: é o **recibo**. É por ele que o cliente sabe se o comando
   * que o fez assumir o timão aqui já foi visto do outro lado — ver
   * `GuestSession.applyCrew`.
   */
  ackTick: number;
  over: boolean;
  winner: 0 | 1;
  windDirection: number;
  windStrength: number;
  waveTime: number;
  /** Rumo da ondulação de fundo. Ver a nota no codec — sem ele, dois mares. */
  swellDirection: number;
  readonly sky: SkyState;
  readonly ships: [ShipState, ShipState];
  readonly crew: [CrewState, CrewState];
  /** Eventos deste intervalo. Consumidos uma vez e limpos. */
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

/** Reserva de rombos e tábuas, para a leitura não alocar por quadro. */
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
  // Quantizar quatro componentes independentes tira o quaternion do comprimento
  // um por alguns décimos de milésimo. Normalizar aqui é uma raiz por navio por
  // instantâneo, e evita que o erro entre numa composição de rotações.
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

  // ⚠️ Sem `Math.min` aqui: o escritor já grampeia em `MAX_BREACHES`, e cortar
  // de novo **deste lado** era justamente o defeito — o leitor parava antes do
  // escritor e todo o resto do instantâneo saía do lugar. Um teto só, na fonte.
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

/** O céu e o tempo. Ver `writeSky`, do outro lado. */
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
        // Tipo desconhecido: veio de uma versão que este cliente não entende, e
        // não há como saber quantos bytes pular. Parar de ler é o único caminho
        // seguro — o resto do quadro está perdido de qualquer forma.
        return;
    }
  }
}

/**
 * Lê um instantâneo para dentro de um `WorldState`.
 *
 * O corpo real é `readSnapshot`; isto aqui é a casca que transforma um quadro
 * truncado ou de outra versão em `null` em vez de numa exceção. `DataView`
 * lança ao ler além do fim, e essa exceção subiria pelo `onmessage` do socket:
 * um único pacote ruim derrubaria o tratador de rede do jogo inteiro, e o
 * sintoma seria o mundo congelando sem nenhum erro visível.
 *
 * @returns o cabeçalho, ou `null` se o quadro não for um instantâneo válido.
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
