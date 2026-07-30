/**
 * The conversation with the room server, from the game's point of view.
 *
 * It is the piece the menu watches and the one the main loop queries. It brings together
 * three things that only make sense together: the lobby's state machine (which the menu
 * draws), the decision of who simulates (which comes from the room) and the matching game
 * session — `HostSession` or `GuestSession`.
 *
 * No socket, protocol or byte crosses the border from here to the menu: it receives an
 * `OnlineViewState` and nothing else.
 */

import type { JoinIntent, ServerMessage } from '../../shared/protocol';
import { MessageType } from '../../shared/protocol';
import type { WeatherMode } from '../core/Settings';
import type { InputFrame } from '../core/InputFrame';
import type { Match } from '../game/Match';
import { GuestSession } from './GuestSession';
import { HostSession } from './HostSession';
import { RoomClient, measurePerformance } from './RoomClient';
import type { OnlinePhase, OnlineViewState } from '../ui/OnlineMenu';

/** The "my window lost focus" frame. One byte, built once. */
const STALL_FRAME = new Uint8Array([MessageType.Stall]).buffer;

/** What the game has to know when the duel begins. */
export interface MatchConfig {
  seed: number;
  role: 'host' | 'guest';
  slot: 0 | 1;
  opponent: string;
  /**
   * The weather and the hour the duel opens with, dictated by the room.
   *
   * They had always come in the `start` message and were **thrown away here**:
   * `MatchConfig` did not carry them, and the game went on with the weather and the clock
   * each player had on the title screen — one starting at noon under a clear sky and the
   * other at dusk in the rain. Since the wind enters the sail's force, that was not only
   * strange to see: it was an advantage.
   */
  weather: WeatherMode;
  timeOfDay: number;
}

export class OnlineSession {
  private readonly state: OnlineViewState = {
    phase: 'idle',
    code: null,
    opponent: null,
    message: null,
    waitingSeconds: 0,
  };

  private client: RoomClient | null = null;
  private changeListener: ((state: OnlineViewState) => void) | null = null;
  private startListener: ((config: MatchConfig) => void) | null = null;
  private overListener: ((won: boolean, reason: string) => void) | null = null;

  /** The game session, when there is one. Only one of the two exists at a time. */
  host: HostSession | null = null;
  guest: GuestSession | null = null;

  private role: 'host' | 'guest' | null = null;
  /**
   * How this room was entered.
   *
   * Kept because it is what decides **which waiting screen** the player sees when the
   * server answers. Without it, the phase jumped from `connecting` straight to `hosting`
   * on all three paths: whoever clicked "find a captain" got the "your room is open, pass
   * the code along" screen, and so did whoever typed a code. Two wrong screens out of
   * three, and the right one showed up by accident.
   */
  private intent: JoinIntent | null = null;
  private announcedSecond = -1;
  /** Observed frame rate, for the performance rating. */
  private fps = 60;
  /** A fake bad network, reapplied on every new connection. */
  private lag = { latencyMs: 0, jitterMs: 0, lossPercent: 0 };

  constructor(
    private readonly serverUrl: string | undefined,
    private readonly match: Match,
  ) {
    // See `announceStall`. The listener belongs to the document and not to the game: it
    // has to fire precisely when the frame loop stops.
    document.addEventListener('visibilitychange', () => this.announceStall());
  }

  /**
   * Tells the other side when the simulating window loses focus.
   *
   * `requestAnimationFrame` is frozen in a background tab, and with it the physics, the
   * snapshots and everything else stop. From over there that is indistinguishable from a
   * network drop: the world simply stops. The `Stall` frame is the difference between
   * "the opponent minimized the game" and "the match broke" — and it is the last thing
   * this side manages to send, because the visibility event still runs when the loop
   * already does not.
   *
   * Only the host sends it: a guest losing focus interrupts no simulation at all.
   */
  private announceStall(): void {
    if (!this.host || !this.client) return;
    if (document.visibilityState !== 'hidden') return;
    this.client.sendFrame(STALL_FRAME);
  }

  get available(): boolean {
    return Boolean(this.serverUrl);
  }

  /** `true` when a networked duel is underway. */
  get playing(): boolean {
    return this.role !== null && this.state.phase === 'ready';
  }

  get opponentName(): string {
    return this.state.opponent ?? '';
  }

  /** Telemetry for the F3 panel. */
  get telemetry(): {
    rtt: number;
    jitter: number;
    depth: number;
    starves: number;
    error: number;
    lead: number;
    /** `true` when the host has said their window lost focus. */
    stalled: boolean;
  } | null {
    if (!this.client) return null;
    return {
      rtt: this.client.rtt,
      jitter: this.client.jitter,
      depth: this.host?.depth ?? this.guest?.depth ?? 0,
      starves: this.host?.starves ?? 0,
      error: this.guest?.predictionError ?? 0,
      lead: this.guest?.lead ?? 0,
      stalled: this.guest?.stalled ?? false,
    };
  }

  onChange(listener: (state: OnlineViewState) => void): void {
    this.changeListener = listener;
  }

  onStart(listener: (config: MatchConfig) => void): void {
    this.startListener = listener;
  }

  onOver(listener: (won: boolean, reason: string) => void): void {
    this.overListener = listener;
  }

  // -- menu actions ---------------------------------------------------------------

  queue(nickname: string): void {
    this.connect('queue', nickname);
  }

  create(nickname: string): void {
    this.connect('create', nickname);
  }

  join(nickname: string, code: string): void {
    this.connect('join', nickname, code);
  }

  /** Give up on whatever is underway. Idempotent — see `Menu.back`. */
  leave(): void {
    this.client?.disconnect();
    this.client = null;
    this.host = null;
    this.guest = null;
    this.role = null;
    this.intent = null;
    this.set({
      phase: 'idle',
      code: null,
      opponent: null,
      message: null,
      waitingSeconds: 0,
    });
  }

  /** Turns on the artificial latency on the current connection. See `RoomClient`. */
  setSimulatedLag(latencyMs: number, jitterMs = 0, lossPercent = 0): void {
    this.lag = { latencyMs, jitterMs, lossPercent };
    this.client?.setSimulatedLag(latencyMs, jitterMs, lossPercent);
  }

  /** Runs every frame. It advances the timer and measures the frame rate. */
  update(dt: number): void {
    if (dt > 0) this.fps += (1 / dt - this.fps) * 0.05;

    if (this.state.phase !== 'queued' && this.state.phase !== 'hosting') return;
    this.state.waitingSeconds += dt;

    // It only announces when the digit turns: repainting the menu 144 times a second to
    // change a number that changes once risks the d-pad's focus for nothing.
    const second = Math.floor(this.state.waitingSeconds);
    if (second === this.announcedSecond) return;
    this.announcedSecond = second;
    this.emit();
  }

  // -- simulation step -------------------------------------------------------------

  /**
   * The enemy ship's input, when it comes from the network.
   *
   * @returns `null` outside a hosted duel — there what drives is `ShipAI`.
   */
  enemyInput(tick: number): InputFrame | null {
    return this.host ? this.host.enemyInput(tick) : null;
  }

  /** After the host's step: it sends the world, if it is time. */
  afterHostStep(tick: number): void {
    this.host?.afterStep(tick);
  }

  private connect(intent: JoinIntent, nickname: string, code?: string): void {
    if (!this.serverUrl) return;
    this.leave();

    this.intent = intent;
    this.set({ phase: 'connecting', message: null, waitingSeconds: 0 });
    this.announcedSecond = -1;

    const client = new RoomClient(this.serverUrl, {
      onLobby: (message) => this.onLobby(message),
      onFrame: (frame) => this.onFrame(frame),
      onClosed: (reason) => this.onClosed(reason),
    });
    this.client = client;
    client.setSimulatedLag(this.lag.latencyMs, this.lag.jitterMs, this.lag.lossPercent);
    client.connect(intent, nickname, measurePerformance(this.fps), code);
  }

  private onLobby(message: ServerMessage): void {
    switch (message.t) {
      case 'welcome':
        // No role yet: it only exists once there is someone to compare against. See the
        // note in `ServerMessage.welcome`.
        //
        // The waiting screen comes out of **how you got in**, and not out of what the
        // phase was an instant ago — which was always `connecting`, and that is why it
        // always fell into the `hosting` branch. See `intent`.
        this.set({
          phase:
            this.intent === 'queue' ? 'queued' : this.intent === 'join' ? 'joining' : 'hosting',
          code: message.code,
        });
        return;

      case 'peer':
        this.role = message.role;
        this.set({ phase: 'ready', opponent: message.nickname });
        // A fresh latency measurement before starting: the duel gets going in less than
        // a second from here, and the guest's initial lead comes out of it.
        this.client?.measureLatency();
        // The assets are already in memory: the ship and the body are built at boot.
        this.client?.sendLobby({ t: 'ready' });
        return;

      case 'start': {
        if (!this.role || !this.client) return;
        // On the wire, index 0 is always the simulating side's.
        const slot: 0 | 1 = this.role === 'host' ? 0 : 1;
        this.host = this.role === 'host' ? new HostSession(this.match, this.client) : null;
        this.guest =
          this.role === 'guest' ? new GuestSession(this.match, this.client, slot) : null;
        this.startListener?.({
          seed: message.seed,
          role: this.role,
          slot,
          opponent: this.state.opponent ?? 'Rival',
          weather: message.weather,
          timeOfDay: message.timeOfDay,
        });
        return;
      }

      case 'over': {
        // The winner comes in the host's index; whoever is guest has to translate.
        const mine: 0 | 1 = this.role === 'host' ? 0 : 1;
        // An opponent who leaves is an opponent who lost, and this message only reaches
        // whoever **stayed** — the room does not send it to whoever left. Without the
        // clause, the winner came in as `null`, the comparison was false and whoever was
        // winning an abandoned duel got the defeat screen.
        const won = message.reason === 'left' ? true : message.winner === mine;
        this.overListener?.(won, message.reason);
        return;
      }

      case 'error':
        this.set({ phase: 'error', message: message.reason });
        return;

      default:
        return;
    }
  }

  /**
   * A binary frame arrived.
   *
   * The exception fence is mandatory, and not fussiness: this runs inside the socket's
   * `onmessage`, and whatever escapes from here goes up to the browser with nobody to
   * catch it. A single truncated frame — a different version, a cut packet — would take
   * down the whole match's network handler, and the symptom would be the world freezing
   * **with no error at all on screen**. Losing a frame is cheap: the next one comes in
   * 33 ms.
   */
  private onFrame(frame: ArrayBuffer): void {
    try {
      if (this.host) {
        this.host.onFrame(frame);
        return;
      }
      if (!this.guest) return;

      const view = new DataView(frame);
      if (view.byteLength >= 1 && view.getUint8(0) === MessageType.Stall) {
        this.guest.markStalled();
        return;
      }
      this.guest.onFrame(frame);
    } catch (error) {
      console.warn('[sea-of-opus] dropped a malformed network frame', error);
    }
  }

  private onClosed(reason: string): void {
    // A drop during the duel is the end of it: with no reconnection, the other side
    // would be left in a sea that stopped answering without knowing why.
    if (this.playing) {
      this.overListener?.(false, 'left');
      return;
    }
    this.set({ phase: 'error', message: reason });
  }

  private set(patch: Partial<OnlineViewState>): void {
    Object.assign(this.state, patch);
    this.emit();
  }

  private emit(): void {
    this.changeListener?.(this.state);
  }
}

/** An initial state, so the menu has something to draw before any connection. */
export type { OnlinePhase };
