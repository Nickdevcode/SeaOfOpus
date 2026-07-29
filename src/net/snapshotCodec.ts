/**
 * O estado do mundo em bytes, e de volta.
 *
 * ## O que **não** vai no instantâneo
 *
 * As balas. E não é economia: `stepBallistic` é uma função pura, sem sorteio
 * nenhum, e o evento de tiro já carrega a posição e a velocidade exatas da boca.
 * O cliente que recebe esse evento gera a bala e a integra a 60 Hz — a trajetória
 * sai **idêntica** à do host, e mais suave do que interpolar a 15 Hz uma posição
 * que chega pelo fio. Manda-se o disparo, não o voo.
 *
 * ## Quantização, não compressão delta
 *
 * Um quaternion cabe em quatro `i16` com erro no quinto decimal — meio milímetro
 * de guinada num casco de quinze metros. Isso encolhe o instantâneo em dez vezes
 * e **não tem estado**: cada quadro se lê sozinho.
 *
 * Compressão delta encolheria mais e custaria caro em outro lugar: exigiria
 * histórico de instantâneos confirmados no host, confirmação do cliente e uma
 * baseline comum aos dois. Toda uma classe de bug em que o cliente aplica uma
 * diferença contra a base errada e se afasta da verdade sem nunca perceber.
 *
 * A única concessão é a lista de rombos, que vai num **campo condicional**: só é
 * escrita quando mudou. Campo condicional não é delta — continua sem baseline,
 * sem histórico e sem cadeia; é só um campo que às vezes não está lá.
 *
 * ## Nada aloca por quadro
 *
 * O buffer e a `DataView` são criados uma vez. A 15 instantâneos por segundo, um
 * `ArrayBuffer` novo a cada um seria lixo para o coletor recolher dentro do
 * orçamento de 16 ms do quadro de render.
 */

import type * as THREE from 'three';
import { MessageType, QUANT, dequantize, quantize } from '../../shared/protocol';
import type { InputFrame } from '../core/InputFrame';
import type { Match } from '../game/Match';
import type { MatchEvent } from '../game/MatchEvents';
import type { Ship } from '../ship/Ship';

/** Teto de um quadro. O mesmo do servidor — ver `MAX_FRAME_BYTES` lá. */
const BUFFER_BYTES = 4096;

/** Bits do byte de sinalizadores do instantâneo. */
const SNAPSHOT_FLAG = {
  /** A lista de rombos vem junto porque mudou desde o último. */
  Breaches: 1 << 0,
  /** A partida acabou; `winner` está no quadro. */
  Over: 1 << 1,
} as const;

/** Estado de um canhão, no fio. */
const CANNON_STATE = ['empty', 'loading', 'loaded'] as const;

/** Estado da âncora, no fio. */
const ANCHOR_STATE = ['stowed', 'dropping', 'set', 'raising'] as const;

/**
 * Um escritor sequencial sobre um buffer fixo.
 *
 * `DataView` com endianness **explícita** em toda chamada. O padrão de
 * `DataView` é big-endian, o das máquinas em que isto roda é little — deixar o
 * padrão valer daria um código que funciona porque os dois lados erram igual, e
 * que quebra no dia em que um deles parar de errar.
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
  /** Um vetor de mundo, em precisão cheia: o mar tem quilômetros. */
  vec3(v: THREE.Vector3): void {
    this.f32(v.x);
    this.f32(v.y);
    this.f32(v.z);
  }
  /** Um vetor local a bordo, quantizado: o navio tem quinze metros. */
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

// -- entrada: guest → host ----------------------------------------------------

const inputBuffer = new ArrayBuffer(256);
const inputView = new DataView(inputBuffer);

/**
 * Empacota um lote de quadros de entrada.
 *
 * Vão quatro por mensagem, sendo os dois mais novos e dois repetidos do envio
 * anterior. A repetição é o que faz a perda de um pacote não custar nada: o
 * quadro que se perdeu chega de novo no seguinte, e o host ainda o consome
 * dentro do prazo. É mais barato que confirmar e reenviar.
 */
export function encodeInput(frames: readonly InputFrame[]): ArrayBuffer {
  const w = new Writer(inputView);
  w.u8(MessageType.Input);
  w.u8(frames.length);

  for (const frame of frames) {
    w.u32(frame.tick);
    w.u16(frame.held);
    w.u16(frame.pressed);
    // Os eixos de caminhada são −1..1 e vêm de teclas ou de analógico: um byte
    // com sinal dá 1/127 de resolução, mais fina que a zona morta do controle.
    w.i8(Math.round(Math.max(-1, Math.min(1, frame.moveX)) * 127));
    w.i8(Math.round(Math.max(-1, Math.min(1, frame.moveY)) * 127));
    w.i16(quantize(frame.lookX, QUANT.angle));
    w.i16(quantize(frame.lookY, QUANT.angle));
  }

  return inputBuffer.slice(0, w.offset);
}

/** Desempacota um lote de entrada para dentro dos objetos passados. */
export function decodeInput(buffer: ArrayBuffer, out: InputFrame[]): number {
  const r = new Reader(new DataView(buffer));
  r.u8();
  const count = r.u8();

  for (let i = 0; i < count && i < out.length; i++) {
    const frame = out[i]!;
    frame.tick = r.u32();
    frame.held = r.u16();
    frame.pressed = r.u16();
    frame.moveX = r.i8() / 127;
    frame.moveY = r.i8() / 127;
    frame.lookX = dequantize(r.i16(), QUANT.angle);
    frame.lookY = dequantize(r.i16(), QUANT.angle);
  }

  return Math.min(count, out.length);
}

// -- instantâneo: host → guest ------------------------------------------------

const snapshotBuffer = new ArrayBuffer(BUFFER_BYTES);
const snapshotView = new DataView(snapshotBuffer);

/** O cabeçalho de um instantâneo, depois de lido. */
export interface SnapshotHeader {
  tick: number;
  /** Quadros de entrada que o host tem em fila. O guest ajusta o avanço por isto. */
  bufferDepth: number;
  /** Último tick de entrada que o host consumiu — mede a ida e volta de graça. */
  ackTick: number;
  over: boolean;
  winner: 0 | 1;
}

export interface EncodeOptions {
  bufferDepth: number;
  ackTick: number;
  /** `true` quando a lista de rombos mudou desde o último instantâneo. */
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
    // O recuo é 0..~0,6 m; um byte sobre meio metro dá 2 mm de resolução, o que
    // é bem mais fino que o olho distingue num tubo que anda em 0,15 s.
    w.u8(Math.round(Math.max(0, Math.min(1, cannon.recoil)) * 255));
  }

  const { damage } = ship;
  // A água do porão vai como fração da capacidade: o número absoluto tem casas
  // que não interessam, e a fração é justamente o que o HUD desenha.
  w.u16(Math.round(Math.max(0, Math.min(1, damage.floodFraction)) * 65535));
  w.u16(Math.round(Math.min(damage.sinkTime, 65) * 1000));

  if (!includeBreaches) return;
  w.u8(Math.min(damage.breaches.length, 255));
  for (const breach of damage.breaches) {
    w.u8(breach.id & 0xff);
    w.local(breach.local, QUANT.breach);
    w.i8(Math.round(breach.normal.x * 127));
    w.i8(Math.round(breach.normal.y * 127));
    w.i8(Math.round(breach.normal.z * 127));
    // A área de um rombo vive na casa dos centésimos de m²; ×2550 põe a faixa
    // útil inteira num byte.
    w.u8(Math.round(Math.min(breach.area * 2550, 255)));
    w.u8(Math.round(Math.max(0, Math.min(1, breach.repair)) * 255));
  }
}

/**
 * Escreve o mundo inteiro num buffer e devolve a fatia usada.
 *
 * A fatia é uma cópia — `WebSocket.send` é assíncrono e o buffer é reaproveitado
 * no instantâneo seguinte; mandar a memória viva seria mandar bytes que já
 * mudaram quando saírem.
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
  w.u16(options.ackTick & 0xffff);
  w.u8(options.winner);

  // Vento e força do mar. Sem isto, o clima de cada lado correria no relógio
  // dele — e o vento entra na força da vela, então seria vantagem para um dos
  // dois. Ver a nota sobre o modo de tempo em `DuelRoom.onReady`.
  const waves = match.environment.waveField;
  w.i16(quantize(waves.windDirection, QUANT.angle));
  w.u8(Math.round(Math.max(0, Math.min(1, waves.windStrength)) * 255));
  w.f32(waves.time);

  for (const ship of match.ships) writeShip(w, ship, options.includeBreaches);

  for (const crewman of match.crew) {
    const c = crewman.controller;
    w.local(c.local, QUANT.local);
    w.i16(quantize(c.yaw, QUANT.angle));
    w.i16(quantize(c.pitch, QUANT.angle));
    const station = c.station === 'deck' ? 0 : c.station === 'helm' ? 1 : 2;
    // Estação, canhão e os três estados de corpo cabem num byte: são 2 + 1 + 3
    // bits de informação, e um campo por coisa custaria quatro bytes por marujo
    // em cada um dos quinze instantâneos por segundo.
    w.u8(
      station |
        ((c.cannonIndex < 0 ? 0 : c.cannonIndex) << 2) |
        (c.grounded ? 1 << 3 : 0) |
        (c.onLadder ? 1 << 4 : 0) |
        (c.atCapstan ? 1 << 5 : 0),
    );
  }

  writeEvents(w, match.events);

  return snapshotBuffer.slice(0, w.offset);
}

/**
 * Os eventos do intervalo desde o último instantâneo.
 *
 * É o que carrega estrondo, respingo, lasca e clarão para o outro lado. Sem eles
 * o duelo do guest seria mudo e sem fumaça — e, pior, ele não teria de onde tirar
 * as balas, que nascem do evento de tiro.
 */
function writeEvents(w: Writer, events: readonly MatchEvent[]): void {
  // O teto protege o buffer num passo excepcional (dois bordos cheios num tique
  // com abalroamento). Perder o vigésimo estrondo de um instante desses não é
  // perda que alguém note; estourar o buffer derruba a partida.
  const count = Math.min(events.length, 24);
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

export { SNAPSHOT_FLAG, CANNON_STATE, ANCHOR_STATE, Reader, Writer };

/** Lê só o cabeçalho, para quem precisa decidir antes de aplicar. */
export function peekSnapshotHeader(buffer: ArrayBuffer): SnapshotHeader | null {
  if (buffer.byteLength < 10) return null;
  const r = new Reader(new DataView(buffer));
  if (r.u8() !== MessageType.Snapshot) return null;
  const flags = r.u8();
  return {
    tick: r.u32(),
    bufferDepth: r.u8(),
    ackTick: r.u16(),
    over: (flags & SNAPSHOT_FLAG.Over) !== 0,
    winner: (r.u8() === 1 ? 1 : 0) as 0 | 1,
  };
}
