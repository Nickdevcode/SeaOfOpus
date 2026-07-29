/**
 * A conversa com o servidor de sala, do ponto de vista do jogo.
 *
 * É a peça que o menu observa e a que o laço principal consulta. Ela junta três
 * coisas que só fazem sentido juntas: a máquina de estados do lobby (que o menu
 * desenha), a decisão de quem simula (que vem da sala) e a sessão de jogo
 * correspondente — `HostSession` ou `GuestSession`.
 *
 * Nada de socket, protocolo ou byte atravessa a fronteira daqui para o menu: ele
 * recebe um `OnlineViewState` e nada mais.
 */

import type { ServerMessage } from '../../shared/protocol';
import { MessageType } from '../../shared/protocol';
import type { InputFrame } from '../core/InputFrame';
import type { Match } from '../game/Match';
import { GuestSession } from './GuestSession';
import { HostSession } from './HostSession';
import { RoomClient, measurePerformance } from './RoomClient';
import type { OnlinePhase, OnlineViewState } from '../ui/OnlineMenu';

/** O quadro de "minha janela saiu de foco". Um byte, montado uma vez. */
const STALL_FRAME = new Uint8Array([MessageType.Stall]).buffer;

/** O que o jogo precisa saber quando o duelo começa. */
export interface MatchConfig {
  seed: number;
  role: 'host' | 'guest';
  slot: 0 | 1;
  opponent: string;
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

  /** A sessão de jogo, quando há uma. Só uma das duas existe por vez. */
  host: HostSession | null = null;
  guest: GuestSession | null = null;

  private role: 'host' | 'guest' | null = null;
  private announcedSecond = -1;
  /** Taxa de quadros observada, para a nota de desempenho. */
  private fps = 60;
  /** Rede ruim de mentira, reaplicada a cada conexão nova. */
  private lag = { latencyMs: 0, jitterMs: 0, lossPercent: 0 };

  constructor(
    private readonly serverUrl: string | undefined,
    private readonly match: Match,
  ) {
    // Ver `announceStall`. O ouvinte é do documento e não do jogo: ele precisa
    // disparar justamente quando o laço de quadros para.
    document.addEventListener('visibilitychange', () => this.announceStall());
  }

  /**
   * Avisa o outro lado quando a janela de quem simula sai de foco.
   *
   * `requestAnimationFrame` é congelado numa aba em segundo plano, e com ele
   * param a física, os instantâneos e tudo o mais. Do lado de lá isso é
   * indistinguível de uma queda de rede: o mundo simplesmente para. O quadro de
   * `Stall` é a diferença entre "o adversário minimizou o jogo" e "a partida
   * quebrou" — e é a última coisa que este lado consegue mandar, porque o evento
   * de visibilidade ainda roda quando o laço já não roda.
   *
   * Só o host manda: o guest que sai de foco não interrompe simulação nenhuma.
   */
  private announceStall(): void {
    if (!this.host || !this.client) return;
    if (document.visibilityState !== 'hidden') return;
    this.client.sendFrame(STALL_FRAME);
  }

  get available(): boolean {
    return Boolean(this.serverUrl);
  }

  /** `true` quando um duelo em rede está em curso. */
  get playing(): boolean {
    return this.role !== null && this.state.phase === 'ready';
  }

  get opponentName(): string {
    return this.state.opponent ?? '';
  }

  /** Telemetria para o painel do F3. */
  get telemetry(): {
    rtt: number;
    jitter: number;
    depth: number;
    starves: number;
    error: number;
    lead: number;
    /** `true` quando o host avisou que a janela dele saiu de foco. */
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

  // -- ações do menu --------------------------------------------------------------

  queue(nickname: string): void {
    this.connect('queue', nickname);
  }

  create(nickname: string): void {
    this.connect('create', nickname);
  }

  join(nickname: string, code: string): void {
    this.connect('join', nickname, code);
  }

  /** Desistir do que estiver em curso. Idempotente — ver `Menu.back`. */
  leave(): void {
    this.client?.disconnect();
    this.client = null;
    this.host = null;
    this.guest = null;
    this.role = null;
    this.set({
      phase: 'idle',
      code: null,
      opponent: null,
      message: null,
      waitingSeconds: 0,
    });
  }

  /** Liga a latência artificial na conexão em curso. Ver `RoomClient`. */
  setSimulatedLag(latencyMs: number, jitterMs = 0, lossPercent = 0): void {
    this.lag = { latencyMs, jitterMs, lossPercent };
    this.client?.setSimulatedLag(latencyMs, jitterMs, lossPercent);
  }

  /** Roda todo quadro. Avança o cronômetro e mede a taxa de quadros. */
  update(dt: number): void {
    if (dt > 0) this.fps += (1 / dt - this.fps) * 0.05;

    if (this.state.phase !== 'queued' && this.state.phase !== 'hosting') return;
    this.state.waitingSeconds += dt;

    // Só avisa quando o dígito vira: repintar o menu 144 vezes por segundo para
    // mudar um número que muda uma vez arrisca o foco do d-pad por nada.
    const second = Math.floor(this.state.waitingSeconds);
    if (second === this.announcedSecond) return;
    this.announcedSecond = second;
    this.emit();
  }

  // -- passo de simulação ----------------------------------------------------------

  /**
   * A entrada do navio inimigo, quando ela vem da rede.
   *
   * @returns `null` fora de um duelo hospedado — aí quem pilota é o `ShipAI`.
   */
  enemyInput(tick: number): InputFrame | null {
    return this.host ? this.host.enemyInput(tick) : null;
  }

  /** Depois do passo do host: manda o mundo, se for a vez. */
  afterHostStep(tick: number): void {
    this.host?.afterStep(tick);
  }

  private connect(intent: 'queue' | 'create' | 'join', nickname: string, code?: string): void {
    if (!this.serverUrl) return;
    this.leave();

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
        // Sem papel ainda: ele só existe quando houver com quem comparar. Ver a
        // nota em `ServerMessage.welcome`.
        this.set({
          phase: this.state.phase === 'joining' ? 'joining' : 'hosting',
          code: message.code,
        });
        return;

      case 'peer':
        this.role = message.role;
        this.set({ phase: 'ready', opponent: message.nickname });
        // Uma medida de latência fresca antes de começar: o duelo arranca daqui
        // a menos de um segundo, e é dela que sai o avanço inicial do guest.
        this.client?.measureLatency();
        // Assets já estão em memória: o navio e o corpo são construídos no boot.
        this.client?.sendLobby({ t: 'ready' });
        return;

      case 'start': {
        if (!this.role || !this.client) return;
        // No fio, o índice 0 é sempre o de quem simula.
        const slot: 0 | 1 = this.role === 'host' ? 0 : 1;
        this.host = this.role === 'host' ? new HostSession(this.match, this.client) : null;
        this.guest =
          this.role === 'guest' ? new GuestSession(this.match, this.client, slot) : null;
        this.startListener?.({
          seed: message.seed,
          role: this.role,
          slot,
          opponent: this.state.opponent ?? 'Rival',
        });
        return;
      }

      case 'over': {
        // O vencedor vem no índice do host; quem é guest tem de traduzir.
        const mine: 0 | 1 = this.role === 'host' ? 0 : 1;
        const won = message.winner === mine;
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

  private onFrame(frame: ArrayBuffer): void {
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
  }

  private onClosed(reason: string): void {
    // Queda durante o duelo é o fim dele: sem reconexão, o outro lado ficaria
    // num mar que parou de responder sem saber por quê.
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

/** Um estado inicial, para o menu ter o que desenhar antes de qualquer conexão. */
export type { OnlinePhase };
