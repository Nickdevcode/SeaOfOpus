/**
 * O socket: uma conexão com a sala, e o que passa por ela.
 *
 * Não sabe nada de navio nem de instantâneo — recebe e entrega bytes. Quem os
 * interpreta são `HostSession` e `GuestSession`.
 *
 * ## Latência simulada, e por que ela é obrigatória
 *
 * Netcode escrito e testado só em `localhost` funciona em `localhost`. Zero
 * milissegundos de ida e volta escondem **todos** os problemas que o netcode
 * existe para resolver: o buffer de jitter nunca passa fome, a interpolação nunca
 * tem o que interpolar, a predição nunca erra e a reconciliação nunca roda. O
 * primeiro jogador de verdade encontra os quatro de uma vez.
 *
 * Daí `setSimulatedLag`, ligada em desenvolvimento e acessível pela bancada:
 *
 * ```js
 * __game.net.setSimulatedLag(150, 40, 2)   // 150 ms, 40 de jitter, 2% de perda
 * ```
 *
 * Ela atrasa e descarta **na saída**, o que é o suficiente: uma perda de ida
 * produz exatamente o mesmo buraco que uma perda de volta, do ponto de vista de
 * quem espera o pacote.
 */

import {
  PROTOCOL_VERSION,
  type ClientMessage,
  type JoinIntent,
  type ServerMessage,
} from '../../shared/protocol';

/** Quanto tempo esperar pelo `welcome` antes de desistir da sala. */
const HANDSHAKE_TIMEOUT_MS = 8000;

/** Intervalo entre medições de ida e volta. */
const PING_INTERVAL_MS = 2000;

/** Peso do valor novo na média do RTT. Baixo para a medida não pular. */
const RTT_SMOOTHING = 0.2;

export interface RoomClientHandlers {
  onLobby(message: ServerMessage): void;
  onFrame(frame: ArrayBuffer): void;
  onClosed(reason: string): void;
}

/** Latência artificial, para exercitar o netcode fora de `localhost`. */
interface SimulatedLag {
  /** Atraso base de ida e volta, em milissegundos. */
  latencyMs: number;
  /** Variação aleatória somada ao atraso, em milissegundos. */
  jitterMs: number;
  /** Fração de mensagens descartadas, 0..1. */
  loss: number;
}

export class RoomClient {
  private socket: WebSocket | null = null;
  private handshakeTimer: ReturnType<typeof setTimeout> | null = null;
  private pingTimer: ReturnType<typeof setInterval> | null = null;
  private pingSentAt = 0;

  /** Ida e volta suavizada, em milissegundos. Zero antes da primeira medida. */
  rtt = 0;
  /** Variação da ida e volta, em milissegundos. */
  jitter = 0;

  /** Contadores para o painel de telemetria. */
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
   * Abre a sala.
   *
   * @param intent como se está entrando: fila, sala nova ou código.
   * @param code obrigatório quando `intent` é `join`.
   */
  connect(intent: JoinIntent, nickname: string, perfScore: number, code?: string): void {
    this.disconnect();

    const path =
      intent === 'queue' ? '/queue' : intent === 'create' ? '/room/new' : `/room/${code ?? ''}`;
    const socket = new WebSocket(`${this.serverUrl}${path}`);
    socket.binaryType = 'arraybuffer';
    this.socket = socket;

    // Se a conexão chegou a abrir. Distingue "o servidor não existe" de "o
    // servidor existe e a conexão caiu depois" — dois problemas com soluções
    // diferentes, e que sem isto contam a mesma história.
    let opened = false;

    socket.onopen = () => {
      opened = true;
      this.sendLobby({ t: 'hello', v: PROTOCOL_VERSION, nickname, intent, perfScore });
      // A primeira medida sai **agora**, e não daqui a dois segundos.
      //
      // Com o `setInterval` sozinho, o duelo de quem entrava numa sala já cheia
      // começava com `rtt` em zero — e é do `rtt` que sai o avanço inicial do
      // guest (ver `GuestSession.estimateLead`). Avanço calculado sobre zero é
      // avanço nenhum: os primeiros segundos de todo duelo eram jogados com o
      // comando chegando atrasado ao host e sendo descartado.
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

    // `onerror` não traz motivo por decisão da especificação (revelá-lo vazaria
    // informação sobre a rede de quem navega), então quem explica é o `onclose`.
    //
    // E quando ele fecha **sem nunca ter aberto**, o motivo é sempre o mesmo: não
    // há nada escutando do outro lado. Dizer "a conexão caiu" nesse caso manda
    // procurar o problema no lugar errado — o endereço é a informação que
    // resolve, e é por isso que ele aparece na mensagem.
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
    // Zera os handlers antes de fechar: sem isso, o `onclose` deste fechamento
    // deliberado avisaria a interface de uma queda que não houve.
    socket.onopen = null;
    socket.onmessage = null;
    socket.onclose = null;
    socket.onerror = null;
    try {
      socket.close(1000, 'Left the room.');
    } catch {
      // Já fechado.
    }
  }

  /**
   * Manda uma mensagem de lobby.
   *
   * ⚠️ **Também passa pela latência simulada**, e a primeira versão não passava.
   * O raciocínio de então era que o lobby "não é o que o netcode tem de
   * aguentar" — e ele deixava de fora justamente o `ping`, que é como o cliente
   * **mede** a rede. Com a bancada ligada, o duelo rodava com 150 ms de atraso
   * nos quadros e um `rtt` de zero no medidor, então o avanço nascia calculado
   * para uma rede que não existia. A ferramenta mentia sobre o único número que
   * ela deveria ajudar a testar.
   *
   * A perda simulada **não** se aplica aqui: o lobby são seis mensagens por
   * sessão e nenhuma delas tem reenvio, então descartar uma não exercita
   * netcode nenhum — só trava a entrada na sala.
   */
  sendLobby(message: ClientMessage): void {
    const socket = this.socket;
    if (socket?.readyState !== WebSocket.OPEN) return;
    const text = JSON.stringify(message);
    this.stats.sent++;
    this.stats.bytesSent += text.length;
    this.afterLag(() => socket.send(text));
  }

  /** Manda um quadro de simulação. Passa pela latência simulada em dev. */
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

  /** Roda o envio agora, ou depois do atraso simulado quando há um. */
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
   * Liga a latência artificial. Ver o cabeçalho.
   *
   * @param latencyMs atraso base.
   * @param jitterMs variação somada por cima.
   * @param lossPercent porcentagem de mensagens descartadas.
   */
  setSimulatedLag(latencyMs: number, jitterMs = 0, lossPercent = 0): void {
    this.lag = {
      latencyMs: Math.max(0, latencyMs),
      jitterMs: Math.max(0, jitterMs),
      loss: Math.max(0, Math.min(1, lossPercent / 100)),
    };
  }

  /**
   * A mensagem de "não tem ninguém nesse endereço".
   *
   * Traz o endereço porque ele **é** o diagnóstico: quem lê isto ou esqueceu de
   * subir o servidor de sala, ou está apontando para a porta errada, e nos dois
   * casos ver o endereço tentado resolve em segundos. Sem ele, resta um "a
   * conexão caiu" que manda procurar problema na internet.
   */
  private unreachable(): string {
    return `No room server at ${this.serverUrl}. Is it running?`;
  }

  /**
   * Dispara uma medida de ida e volta agora.
   *
   * Pública porque há um instante em que a medida vale muito mais do que na
   * cadência normal: quando o adversário entra na sala. Dali a menos de um
   * segundo o duelo começa, e é a medida mais fresca que decide com quanto
   * avanço o guest nasce.
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
      // O jitter é medido **antes** de o RTT ser atualizado: ele é o quanto esta
      // amostra se afastou da média até agora, e não o quanto se afastou de si.
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
 * Uma nota de 0 a 100 do que esta máquina aguenta.
 *
 * Serve para o servidor escolher **quem simula** — ver `DuelRoom.pairIfReady`. A
 * conta é grosseira de propósito: taxa de quadros medida e núcleos disponíveis,
 * nada de benchmark sintético. O que se quer distinguir é "notebook velho" de
 * "máquina de jogo", e para isso dois sinais baratos bastam.
 */
export function measurePerformance(fps: number): number {
  // 60 quadros por segundo é o teto útil da conta: acima disso a diferença já
  // não diz nada sobre aguentar simular dois cascos.
  const frameScore = Math.min(fps / 60, 1) * 70;
  const cores = Math.min(navigator.hardwareConcurrency || 2, 8);
  const coreScore = (cores / 8) * 30;
  return Math.round(frameScore + coreScore);
}
