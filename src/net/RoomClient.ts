/**
 * The socket: one connection to the room, and what goes through it.
 *
 * It knows nothing about ships or snapshots — it receives and delivers bytes. What
 * interprets them are `HostSession` and `GuestSession`.
 *
 * ## Simulated latency, and why it is mandatory
 *
 * Netcode written and tested only on `localhost` works on `localhost`. Zero milliseconds
 * of round trip hide **every** problem netcode exists to solve: the jitter buffer never
 * starves, the interpolation never has anything to interpolate, the prediction never
 * misses and the reconciliation never runs. The first real player finds all four at once.
 *
 * Hence `setSimulatedLag`, switched on in development and reachable from the console:
 *
 * ```js
 * __game.net.setSimulatedLag(150, 40, 2)   // 150 ms, 40 of jitter, 2% loss
 * ```
 *
 * It delays and drops **on the way out**, which is enough: a loss outbound produces
 * exactly the same gap as a loss inbound, from the point of view of whoever is waiting
 * for the packet.
 */

import {
  PROTOCOL_VERSION,
  type ClientMessage,
  type JoinIntent,
  type ServerMessage,
} from '../../shared/protocol';

/** How long to wait for the `welcome` before giving up on the room. */
const HANDSHAKE_TIMEOUT_MS = 8000;

/** Interval between round-trip measurements. */
const PING_INTERVAL_MS = 2000;

/** Weight of the new value in the RTT's average. Low so the reading does not jump. */
const RTT_SMOOTHING = 0.2;

export interface RoomClientHandlers {
  onLobby(message: ServerMessage): void;
  onFrame(frame: ArrayBuffer): void;
  onClosed(reason: string): void;
}

/** Artificial latency, to exercise the netcode outside `localhost`. */
interface SimulatedLag {
  /** Base round-trip delay, in milliseconds. */
  latencyMs: number;
  /** Random variation added to the delay, in milliseconds. */
  jitterMs: number;
  /** Fraction of messages dropped, 0..1. */
  loss: number;
}

export class RoomClient {
  private socket: WebSocket | null = null;
  private handshakeTimer: ReturnType<typeof setTimeout> | null = null;
  private pingTimer: ReturnType<typeof setInterval> | null = null;
  private pingSentAt = 0;

  /** Smoothed round trip, in milliseconds. Zero before the first measurement. */
  rtt = 0;
  /** Variation of the round trip, in milliseconds. */
  jitter = 0;

  /** Counters for the telemetry panel. */
  readonly stats = { sent: 0, received: 0, bytesSent: 0, bytesReceived: 0, dropped: 0 };

  private lag: SimulatedLag = { latencyMs: 0, jitterMs: 0, loss: 0 };

  constructor(
    private readonly serverUrl: string,
    private readonly handlers: RoomClientHandlers,
  ) {}

  get connected(): boolean {
    return this.socket?.readyState === WebSocket.OPEN;
  }

  /**
   * Opens the room.
   *
   * @param intent how you are getting in: queue, new room or code.
   * @param code required when `intent` is `join`.
   */
  connect(intent: JoinIntent, nickname: string, perfScore: number, code?: string): void {
    this.disconnect();

    const path =
      intent === 'queue' ? '/queue' : intent === 'create' ? '/room/new' : `/room/${code ?? ''}`;
    const socket = new WebSocket(`${this.serverUrl}${path}`);
    socket.binaryType = 'arraybuffer';
    this.socket = socket;

    // Whether the connection ever opened. It tells "the server does not exist" from "the
    // server exists and the connection dropped afterward" — two problems with different
    // solutions, and which without this tell the same story.
    let opened = false;

    socket.onopen = () => {
      opened = true;
      this.sendLobby({ t: 'hello', v: PROTOCOL_VERSION, nickname, intent, perfScore });
      // The first measurement goes out **now**, and not two seconds from now.
      //
      // With the `setInterval` on its own, the duel of whoever joined an already full
      // room started with `rtt` at zero — and the guest's initial lead comes out of the
      // `rtt` (see `GuestSession.estimateLead`). A lead computed over zero is no lead at
      // all: the first seconds of every duel were played with the command arriving late
      // at the host and being discarded.
      this.measureLatency();
      this.pingTimer = setInterval(() => this.measureLatency(), PING_INTERVAL_MS);
    };

    socket.onmessage = (event) => {
      this.stats.received++;
      if (typeof event.data === 'string') {
        this.stats.bytesReceived += event.data.length;
        this.onLobbyText(event.data);
        return;
      }
      this.stats.bytesReceived += event.data.byteLength;
      this.handlers.onFrame(event.data);
    };

    // `onerror` carries no reason by decision of the specification (revealing it would
    // leak information about the browsing user's network), so what explains is `onclose`.
    //
    // And when it closes **without ever having opened**, the reason is always the same:
    // there is nothing listening on the other end. Saying "the connection dropped" in
    // that case sends you looking for the problem in the wrong place — the address is the
    // information that solves it, and that is why it shows up in the message.
    socket.onclose = (event) => {
      const neverOpened = !opened;
      this.cleanup();
      this.handlers.onClosed(
        event.reason || (neverOpened ? this.unreachable() : 'The connection dropped.'),
      );
    };

    this.handshakeTimer = setTimeout(() => {
      if (this.socket === socket && socket.readyState !== WebSocket.OPEN) {
        this.disconnect();
        this.handlers.onClosed(this.unreachable());
      }
    }, HANDSHAKE_TIMEOUT_MS);
  }

  disconnect(): void {
    const socket = this.socket;
    this.cleanup();
    if (!socket) return;
    // Clear the handlers before closing: without this, the `onclose` of this deliberate
    // close would tell the interface about a drop that did not happen.
    socket.onopen = null;
    socket.onmessage = null;
    socket.onclose = null;
    socket.onerror = null;
    try {
      socket.close(1000, 'Left the room.');
    } catch {
      // Already closed.
    }
  }

  /**
   * Sends a lobby message.
   *
   * ⚠️ **It also goes through the simulated latency**, and the first version did not. The
   * reasoning back then was that the lobby "is not what the netcode has to survive" — and
   * it left out precisely the `ping`, which is how the client **measures** the network.
   * With the bench switched on, the duel ran with 150 ms of delay on the frames and an
   * `rtt` of zero on the gauge, so the lead was born computed for a network that did not
   * exist. The tool lied about the one number it was supposed to help test.
   *
   * The simulated loss does **not** apply here: the lobby is six messages per session and
   * none of them is resent, so dropping one exercises no netcode at all — it just wedges
   * the entry into the room.
   */
  sendLobby(message: ClientMessage): void {
    const socket = this.socket;
    if (socket?.readyState !== WebSocket.OPEN) return;
    const text = JSON.stringify(message);
    this.stats.sent++;
    this.stats.bytesSent += text.length;
    this.afterLag(() => socket.send(text));
  }

  /** Sends a simulation frame. It goes through the simulated latency in dev. */
  sendFrame(frame: ArrayBuffer): void {
    const socket = this.socket;
    if (socket?.readyState !== WebSocket.OPEN) return;

    this.stats.sent++;
    this.stats.bytesSent += frame.byteLength;

    if (this.lag.loss > 0 && Math.random() < this.lag.loss) {
      this.stats.dropped++;
      return;
    }

    this.afterLag(() => socket.send(frame));
  }

  /** Runs the send now, or after the simulated delay when there is one. */
  private afterLag(send: () => void): void {
    const delay = this.lag.latencyMs + Math.random() * this.lag.jitterMs;
    if (delay <= 0) {
      send();
      return;
    }
    setTimeout(() => {
      if (this.socket?.readyState === WebSocket.OPEN) send();
    }, delay);
  }

  /**
   * Turns on the artificial latency. See the header.
   *
   * @param latencyMs base delay.
   * @param jitterMs variation added on top.
   * @param lossPercent percentage of messages dropped.
   */
  setSimulatedLag(latencyMs: number, jitterMs = 0, lossPercent = 0): void {
    this.lag = {
      latencyMs: Math.max(0, latencyMs),
      jitterMs: Math.max(0, jitterMs),
      loss: Math.max(0, Math.min(1, lossPercent / 100)),
    };
  }

  /**
   * The "there is nobody at that address" message.
   *
   * It carries the address because the address **is** the diagnosis: whoever reads this
   * either forgot to bring the room server up, or is pointing at the wrong port, and in
   * both cases seeing the address that was tried settles it in seconds. Without it, what
   * is left is a "the connection dropped" that sends you looking for a problem on the
   * internet.
   */
  private unreachable(): string {
    return `No room server at ${this.serverUrl}. Is it running?`;
  }

  /**
   * Fires a round-trip measurement now.
   *
   * Public because there is one instant when the measurement is worth far more than at
   * the normal cadence: when the opponent joins the room. Less than a second later the
   * duel begins, and it is the freshest measurement that decides how much lead the guest
   * is born with.
   */
  measureLatency(): void {
    if (!this.connected) return;
    this.pingSentAt = performance.now();
    this.sendLobby({ t: 'ping' });
  }

  private onLobbyText(text: string): void {
    let message: ServerMessage;
    try {
      message = JSON.parse(text) as ServerMessage;
    } catch {
      return;
    }

    if (message.t === 'pong') {
      const sample = performance.now() - this.pingSentAt;
      // The jitter is measured **before** the RTT is updated: it is how far this sample
      // strayed from the average so far, and not how far it strayed from itself.
      const deviation = Math.abs(sample - this.rtt);
      this.jitter = this.rtt === 0 ? 0 : this.jitter + (deviation - this.jitter) * RTT_SMOOTHING;
      this.rtt = this.rtt === 0 ? sample : this.rtt + (sample - this.rtt) * RTT_SMOOTHING;
      return;
    }

    this.handlers.onLobby(message);
  }

  private cleanup(): void {
    if (this.handshakeTimer !== null) {
      clearTimeout(this.handshakeTimer);
      this.handshakeTimer = null;
    }
    if (this.pingTimer !== null) {
      clearInterval(this.pingTimer);
      this.pingTimer = null;
    }
    this.socket = null;
  }
}

/**
 * A 0-to-100 rating of what this machine can take.
 *
 * It serves for the server to choose **who simulates** — see `DuelRoom.pairIfReady`. The
 * arithmetic is coarse on purpose: measured frame rate and available cores, no synthetic
 * benchmark. What you want to tell apart is "old laptop" from "gaming machine", and for
 * that two cheap signals are enough.
 */
export function measurePerformance(fps: number): number {
  // 60 frames per second is the useful ceiling of the arithmetic: above that the
  // difference says nothing more about surviving simulating two hulls.
  const frameScore = Math.min(fps / 60, 1) * 70;
  const cores = Math.min(navigator.hardwareConcurrency || 2, 8);
  const coreScore = (cores / 8) * 30;
  return Math.round(frameScore + coreScore);
}
