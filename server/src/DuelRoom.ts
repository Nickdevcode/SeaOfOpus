/**
 * Uma sala: dois capitães, e o cano entre eles.
 *
 * ## O que esta sala **não** faz
 *
 * Ela não simula nada. Não conhece navio, onda, bala nem rombo, e não abre um só
 * dos quadros binários que passa de um lado ao outro. A razão é a conta do plano
 * gratuito: um Durable Object cobra por **request**, e um laço de 60 Hz aqui
 * dentro não seria um laço — seria uma cadeia de `alarm()`, um request cada, uns
 * 36.000 por partida. Retransmitindo, o mesmo duelo custa ~685. A diferença entre
 * três partidas por dia e cento e quarenta e cinco.
 *
 * Quem simula é um dos dois jogadores. Qual deles é a única decisão de jogo que
 * este arquivo toma, e ela sai de `perfScore` — porque a máquina do host carrega
 * a física dos dois cascos, e uma máquina fraca no comando engasga os dois.
 *
 * ## Hibernação não é otimização, é o que torna a conta viável
 *
 * `state.acceptWebSocket` em vez de `ws.accept()`. Com a API de hibernação, o
 * objeto sai da memória quando fica dez segundos sem receber nada e volta na
 * mensagem seguinte, sem derrubar as conexões. Sem ela, uma sala esperando um
 * segundo jogador ficaria residente cobrando *duration* o tempo todo — e uma sala
 * esperando é justamente o estado em que uma sala passa mais tempo.
 *
 * O preço é que **campos de instância não sobrevivem**. Por isso tudo que precisa
 * durar mora em dois lugares: o que é da conexão vai no `serializeAttachment` do
 * próprio socket, e o que é da sala vai no `storage`.
 */

import {
  PROTOCOL_VERSION,
  sanitizeNickname,
  type ClientMessage,
  type ServerMessage,
} from '../../shared/protocol';

/** O que se guarda de cada conexão. Sobrevive à hibernação no próprio socket. */
interface PeerData {
  nickname: string;
  perfScore: number;
  /** Definido quando o segundo entra. `null` enquanto se está sozinho. */
  role: 'host' | 'guest' | null;
  ready: boolean;
}

/** O que se guarda da sala. Sobrevive no `storage`. */
interface RoomData {
  code: string;
  phase: 'waiting' | 'playing' | 'over';
  seed: number;
}

/**
 * Teto de um quadro de simulação, em bytes.
 *
 * O maior instantâneo previsto — dois cascos, vinte e quatro rombos, uma dúzia de
 * eventos — fica perto de 1 KB. Quatro é folga de sobra para o formato crescer e
 * ainda assim recusa qualquer coisa que não seja um quadro deste jogo.
 */
const MAX_FRAME_BYTES = 4096;

/**
 * Teto de mensagens por segundo, por conexão.
 *
 * O cliente manda 30 de entrada ou 15 de instantâneo. 120 é quatro vezes o pior
 * caso legítimo: alto o bastante para nunca atrapalhar um duelo de verdade, baixo
 * o bastante para um cliente enlouquecido não torrar a cota do dia em minutos.
 */
const MAX_MESSAGES_PER_SECOND = 120;

/** Uma sala com um só capitão morre depois disto. Ver `alarm`. */
const ABANDONED_MS = 10 * 60 * 1000;

/**
 * Vantagem mínima de desempenho para trocar quem simula.
 *
 * Sem uma margem, duas máquinas parecidas trocariam de papel por causa de ruído
 * de medição — e quem abriu a sala perderia o comando dela por um ponto de
 * diferença. Vinte pontos numa escala de cem é uma diferença que se sente.
 */
const HOST_SWAP_MARGIN = 20;

export class DuelRoom implements DurableObject {
  /**
   * Contagem de mensagens da janela de um segundo, por socket.
   *
   * Em memória, e não no `storage`: uma escrita por mensagem custaria mais que o
   * ataque que ela evita. Perder a contagem numa hibernação é inofensivo —
   * hibernar exige dez segundos de silêncio, que é o oposto de um cliente
   * inundando a sala.
   */
  private readonly rates = new WeakMap<WebSocket, { since: number; count: number }>();

  constructor(private readonly state: DurableObjectState) {}

  async fetch(request: Request): Promise<Response> {
    if (request.headers.get('Upgrade') !== 'websocket') {
      return new Response('Expected a WebSocket upgrade.', { status: 426 });
    }

    const url = new URL(request.url);
    const code = url.searchParams.get('code');
    if (!code) return new Response('Missing room code.', { status: 400 });

    const room = await this.room(code);

    // Duas pessoas por sala, e ponto. Um terceiro socket não vira espectador
    // por acidente: ele receberia os quadros dos dois e ninguém saberia por quê.
    const existing = this.state.getWebSockets();
    if (existing.length >= 2) {
      return new Response('Room is full.', { status: 409 });
    }
    if (room.phase !== 'waiting') {
      return new Response('Duel already under way.', { status: 409 });
    }

    const pair = new WebSocketPair();
    const [client, server] = [pair[0], pair[1]];

    // Hibernação: ver o cabeçalho. `acceptWebSocket`, nunca `server.accept()`.
    this.state.acceptWebSocket(server);
    server.serializeAttachment({
      nickname: 'Sailor',
      perfScore: 0,
      role: null,
      ready: false,
    } satisfies PeerData);

    // Um relógio para varrer a sala se ela for abandonada com um só capitão.
    await this.state.storage.setAlarm(Date.now() + ABANDONED_MS);

    return new Response(null, { status: 101, webSocket: client });
  }

  /**
   * Uma mensagem de um dos dois.
   *
   * Binário é **retransmitido sem ser lido** — é o caminho quente, e abrir um
   * quadro aqui gastaria o orçamento de CPU da invocação em algo que nenhum dos
   * dois lados pediu. Texto é lobby, e esse sim é interpretado.
   */
  async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): Promise<void> {
    if (!this.withinRate(ws)) {
      this.close(ws, 1008, 'Too many messages.');
      return;
    }

    if (typeof message !== 'string') {
      if (message.byteLength > MAX_FRAME_BYTES) {
        this.close(ws, 1009, 'Frame too large.');
        return;
      }
      this.relay(ws, message);
      return;
    }

    let parsed: ClientMessage;
    try {
      parsed = JSON.parse(message) as ClientMessage;
    } catch {
      this.close(ws, 1003, 'Malformed message.');
      return;
    }

    await this.handleLobby(ws, parsed);
  }

  async webSocketClose(ws: WebSocket): Promise<void> {
    await this.onPeerGone(ws);
  }

  async webSocketError(ws: WebSocket): Promise<void> {
    await this.onPeerGone(ws);
  }

  /**
   * Varre a sala abandonada.
   *
   * O relógio é reposto a cada vez que alguém entra, então ele só dispara numa
   * sala que passou dez minutos com um capitão só — que é uma sala que ninguém
   * vai usar mais, ocupando um código que outra pessoa poderia querer.
   */
  async alarm(): Promise<void> {
    const sockets = this.state.getWebSockets();
    if (sockets.length >= 2) {
      await this.state.storage.setAlarm(Date.now() + ABANDONED_MS);
      return;
    }
    for (const ws of sockets) this.close(ws, 1000, 'Room expired.');
    await this.state.storage.deleteAll();
  }

  // -- lobby --------------------------------------------------------------------

  private async handleLobby(ws: WebSocket, message: ClientMessage): Promise<void> {
    switch (message.t) {
      case 'hello':
        await this.onHello(ws, message);
        return;
      case 'ready':
        await this.onReady(ws);
        return;
      case 'result':
        await this.onResult(ws, message.winner);
        return;
      case 'ping':
        this.send(ws, { t: 'pong' });
        return;
    }
  }

  private async onHello(
    ws: WebSocket,
    message: Extract<ClientMessage, { t: 'hello' }>,
  ): Promise<void> {
    // Versão diferente é recusada na porta. Deixar entrar daria uma partida em
    // que os dois lados leem os mesmos bytes com significados diferentes — e o
    // sintoma disso não é um erro, é um adversário que se comporta como louco.
    if (message.v !== PROTOCOL_VERSION) {
      this.send(ws, {
        t: 'error',
        reason: 'This game version cannot duel that one. Reload the page.',
      });
      this.close(ws, 1002, 'Protocol mismatch.');
      return;
    }

    const room = await this.room();
    const peer = this.peerData(ws);
    peer.nickname = sanitizeNickname(message.nickname);
    // Nota fora de escala é nota inventada: um cliente adulterado que se declare
    // com mil pontos ganharia o comando de toda sala em que entrasse.
    peer.perfScore = Number.isFinite(message.perfScore)
      ? Math.max(0, Math.min(100, message.perfScore))
      : 0;
    this.setPeerData(ws, peer);

    this.send(ws, {
      t: 'welcome',
      v: PROTOCOL_VERSION,
      code: room.code,
      self: peer.nickname,
    });

    await this.pairIfReady();
  }

  /**
   * Decide quem simula e apresenta os dois, quando os dois estão presentes.
   *
   * A escolha por desempenho é a única regra de jogo desta sala, e ela existe
   * porque num duelo host-autoritativo a máquina de quem hospeda dita a
   * experiência dos **dois**. Quem abriu a sala tem preferência — só perde o
   * comando para uma máquina visivelmente melhor. Ver `HOST_SWAP_MARGIN`.
   */
  private async pairIfReady(): Promise<void> {
    const sockets = this.state.getWebSockets();
    if (sockets.length !== 2) return;

    const [first, second] = sockets as [WebSocket, WebSocket];
    const a = this.peerData(first);
    const b = this.peerData(second);
    if (a.role !== null || b.role !== null) return;

    const swap = b.perfScore > a.perfScore + HOST_SWAP_MARGIN;
    a.role = swap ? 'guest' : 'host';
    b.role = swap ? 'host' : 'guest';
    this.setPeerData(first, a);
    this.setPeerData(second, b);

    this.send(first, { t: 'peer', nickname: b.nickname, role: a.role });
    this.send(second, { t: 'peer', nickname: a.nickname, role: b.role });
  }

  /** Começa quando os dois disserem que carregaram o que tinham de carregar. */
  private async onReady(ws: WebSocket): Promise<void> {
    const peer = this.peerData(ws);
    peer.ready = true;
    this.setPeerData(ws, peer);

    const sockets = this.state.getWebSockets();
    if (sockets.length !== 2) return;
    if (!sockets.every((socket) => this.peerData(socket).ready)) return;

    const room = await this.room();
    if (room.phase !== 'waiting') return;
    room.phase = 'playing';
    await this.state.storage.put('room', room);

    // O mundo sai daqui, e não das preferências de cada um. É o que impede um
    // jogador em "tempestade" e outro em "calmaria" de navegarem mares
    // diferentes — o vento entra na força da vela, então isso seria vantagem.
    const start: ServerMessage = {
      t: 'start',
      seed: room.seed,
      weather: 'dynamic',
      timeOfDay: 0.34,
    };
    for (const socket of sockets) this.send(socket, start);
  }

  private async onResult(ws: WebSocket, winner: 0 | 1): Promise<void> {
    // Só o host declara o fim, porque só ele simula. Aceitar do outro daria a
    // quem perdeu o poder de anunciar a própria vitória.
    if (this.peerData(ws).role !== 'host') return;

    const room = await this.room();
    if (room.phase !== 'playing') return;
    room.phase = 'over';
    await this.state.storage.put('room', room);

    this.broadcast({ t: 'over', reason: 'sunk', winner });
  }

  private async onPeerGone(ws: WebSocket): Promise<void> {
    const room = await this.room();
    // Caiu no meio do duelo: o outro fica sem adversário e sem quem simule.
    // Sem reconexão no escopo de hoje, a partida acaba — e dizer isso na hora é
    // melhor que deixar alguém sozinho num mar que parou de responder.
    if (room.phase === 'playing') {
      room.phase = 'over';
      await this.state.storage.put('room', room);
      this.broadcastExcept(ws, { t: 'over', reason: 'left', winner: null });
      return;
    }

    // Ainda esperando: quem sobrou volta a ser o único, e o papel dele volta a
    // ser indefinido — senão a próxima pessoa a entrar seria pareada contra um
    // papel decidido numa comparação que já não vale.
    for (const socket of this.state.getWebSockets()) {
      if (socket === ws) continue;
      const peer = this.peerData(socket);
      peer.role = null;
      peer.ready = false;
      this.setPeerData(socket, peer);
    }
  }

  // -- encanamento ---------------------------------------------------------------

  /** Manda o quadro para o outro lado. É a única coisa quente deste arquivo. */
  private relay(from: WebSocket, frame: ArrayBuffer): void {
    for (const socket of this.state.getWebSockets()) {
      if (socket === from) continue;
      try {
        socket.send(frame);
      } catch {
        // Socket morrendo no meio do envio: `webSocketClose` cuida do resto.
      }
    }
  }

  private send(ws: WebSocket, message: ServerMessage): void {
    try {
      ws.send(JSON.stringify(message));
    } catch {
      // Idem.
    }
  }

  private broadcast(message: ServerMessage): void {
    for (const socket of this.state.getWebSockets()) this.send(socket, message);
  }

  private broadcastExcept(exclude: WebSocket, message: ServerMessage): void {
    for (const socket of this.state.getWebSockets()) {
      if (socket !== exclude) this.send(socket, message);
    }
  }

  private close(ws: WebSocket, code: number, reason: string): void {
    try {
      ws.close(code, reason);
    } catch {
      // Já fechado.
    }
  }

  private peerData(ws: WebSocket): PeerData {
    return (ws.deserializeAttachment() as PeerData | null) ?? {
      nickname: 'Sailor',
      perfScore: 0,
      role: null,
      ready: false,
    };
  }

  private setPeerData(ws: WebSocket, data: PeerData): void {
    ws.serializeAttachment(data);
  }

  /**
   * O estado da sala, criando-o na primeira vez.
   *
   * A semente nasce aqui, no servidor, e não em nenhum dos dois clientes: é ela
   * que faz o mar, o vento e o clima serem os mesmos dos dois lados, e um número
   * que sai de um dos jogadores é um número que aquele jogador escolhe.
   */
  private async room(code?: string): Promise<RoomData> {
    const stored = await this.state.storage.get<RoomData>('room');
    if (stored) return stored;

    const created: RoomData = {
      code: code ?? '????',
      phase: 'waiting',
      seed: (crypto.getRandomValues(new Uint32Array(1))[0] ?? 1337) >>> 0,
    };
    await this.state.storage.put('room', created);
    return created;
  }

  /** Janela deslizante de um segundo. Ver `MAX_MESSAGES_PER_SECOND`. */
  private withinRate(ws: WebSocket): boolean {
    const now = Date.now();
    const entry = this.rates.get(ws);
    if (!entry || now - entry.since >= 1000) {
      this.rates.set(ws, { since: now, count: 1 });
      return true;
    }
    entry.count++;
    return entry.count <= MAX_MESSAGES_PER_SECOND;
  }
}

/** As ligações declaradas em `wrangler.jsonc`. */
export interface Env {
  DUEL_ROOM: DurableObjectNamespace;
  MATCHMAKER: DurableObjectNamespace;
  ALLOWED_ORIGINS: string;
}
