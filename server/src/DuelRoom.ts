/**
 * A room: two captains, and the pipe between them.
 *
 * ## What this room does **not** do
 *
 * It simulates nothing. It knows no ship, wave, cannonball or breach, and it does
 * not open a single one of the binary frames it passes from one side to the other.
 * The reason is the free plan's math: a Durable Object charges per **request**,
 * and a 60 Hz loop in here would not be a loop — it would be a chain of
 * `alarm()`, one request each, some 36,000 per match. Relaying, the same duel
 * costs ~685. The difference between three matches a day and a hundred and
 * forty-five.
 *
 * The one who simulates is one of the two players. Which of them is the only game
 * decision this file makes, and it comes out of `perfScore` — because the host's
 * machine carries the physics of both hulls, and a weak machine in command
 * stutters for both.
 *
 * ## Hibernation is not an optimization, it's what makes the math work
 *
 * `state.acceptWebSocket` instead of `ws.accept()`. With the hibernation API the
 * object leaves memory after ten seconds of receiving nothing and comes back on
 * the next message, without dropping the connections. Without it, a room waiting
 * for a second player would stay resident charging *duration* the whole time —
 * and waiting is precisely the state a room spends the most time in.
 *
 * The price is that **instance fields do not survive**. So everything that has to
 * last lives in two places: what belongs to the connection goes in the socket's
 * own `serializeAttachment`, and what belongs to the room goes in `storage`.
 */

import {
  PROTOCOL_VERSION,
  sanitizeNickname,
  type ClientMessage,
  type ServerMessage,
} from '../../shared/protocol';

/** What is kept for each connection. Survives hibernation on the socket itself. */
interface PeerData {
  nickname: string;
  perfScore: number;
  /** Set when the second one joins. `null` while alone in the room. */
  role: 'host' | 'guest' | null;
  ready: boolean;
  /**
   * When this captain's `hello` arrived, in milliseconds.
   *
   * It is the tie-breaker in `pairIfReady`, and it exists because the order of
   * `getWebSockets()` is **not** arrival order — the platform promises no order
   * at all. While the preference for whoever opened the room leaned on that
   * order, it was a lottery: a player with the top score opened the room and got
   * the guest role, which is exactly what the rule is supposed to prevent.
   */
  joinedAt: number;
}

/** What is kept for the room. Survives in `storage`. */
interface RoomData {
  code: string;
  phase: 'waiting' | 'playing' | 'over';
  seed: number;
  /**
   * `true` when this room was opened by someone joining the **queue**.
   *
   * Only those rooms hold a slot reserved in the `Matchmaker`, and only they need
   * to give it back when they empty out. A room opened by code was never in the
   * queue and has nothing to release.
   */
  queued?: boolean;
}

/**
 * Ceiling for a simulation frame, in bytes.
 *
 * The largest snapshot expected — two hulls, twenty-four breaches, a dozen
 * events — lands near 1 KB. Four is plenty of headroom for the format to grow and
 * still refuses anything that isn't a frame of this game.
 */
const MAX_FRAME_BYTES = 4096;

/**
 * Ceiling on messages per second, per connection.
 *
 * The client sends 30 of input or 15 of snapshot. 120 is four times the worst
 * legitimate case: high enough never to get in the way of a real duel, low enough
 * that a client gone mad can't burn through the day's quota in minutes.
 */
const MAX_MESSAGES_PER_SECOND = 120;

/** A room with a single captain dies after this. See `alarm`. */
const ABANDONED_MS = 10 * 60 * 1000;

/**
 * Minimum performance advantage needed to switch who simulates.
 *
 * Without a margin, two similar machines would swap roles because of measurement
 * noise — and whoever opened the room would lose command of it over a single
 * point of difference. Twenty points on a scale of a hundred is a difference you
 * can feel.
 */
const HOST_SWAP_MARGIN = 20;

export class DuelRoom implements DurableObject {
  /**
   * Message count for the one-second window, per socket.
   *
   * In memory, not in `storage`: one write per message would cost more than the
   * attack it prevents. Losing the count to a hibernation is harmless —
   * hibernating requires ten seconds of silence, which is the opposite of a
   * client flooding the room.
   */
  private readonly rates = new WeakMap<WebSocket, { since: number; count: number }>();

  /**
   * `env` comes in here because the room needs to **talk to the queue** when it
   * empties out. See `releaseQueueSlot`.
   */
  constructor(
    private readonly state: DurableObjectState,
    private readonly env: Env,
  ) {}

  async fetch(request: Request): Promise<Response> {
    if (request.headers.get('Upgrade') !== 'websocket') {
      return new Response('Expected a WebSocket upgrade.', { status: 426 });
    }

    const url = new URL(request.url);
    const code = url.searchParams.get('code');
    if (!code) return new Response('Missing room code.', { status: 400 });

    // ⚠️ **A code nobody opened is not an empty room: it's a mistake.**
    //
    // `idFromName` always resolves, so typing four wrong letters **created** the
    // room for those letters and sat the player down in it. He sat there watching
    // a timer, waiting for an opponent who doesn't exist and never will, with
    // nothing on screen to suggest he got a letter wrong. "Opening a room" has to
    // be told apart from "joining a room", and only the one joining can be
    // refused.
    //
    // The refusal leaves here as an HTTP status, and the one who translates it
    // for the player is the Worker — see `refuse` and `claimRoom` in `index.ts`.
    // Not every refusal is meant to be passed on: the queue's is meant to be
    // **worked around**.
    if (url.searchParams.get('join') === '1' && !(await this.state.storage.get('room'))) {
      return new Response('No such room.', { status: 404 });
    }

    const room = await this.room(code, url.searchParams.get('queued') === '1');

    // Two people per room, period. A third socket does not become a spectator by
    // accident: it would receive both sides' frames and nobody would know why.
    const existing = this.state.getWebSockets();
    if (existing.length >= 2) return new Response('Room is full.', { status: 409 });
    if (room.phase !== 'waiting') {
      return new Response('Duel already under way.', { status: 409 });
    }

    const pair = new WebSocketPair();
    const [client, server] = [pair[0], pair[1]];

    // Hibernation: see the header. `acceptWebSocket`, never `server.accept()`.
    this.state.acceptWebSocket(server);
    server.serializeAttachment({
      nickname: 'Sailor',
      perfScore: 0,
      role: null,
      ready: false,
      joinedAt: 0,
    } satisfies PeerData);

    // A clock to sweep the room away if it's abandoned with a single captain.
    await this.state.storage.setAlarm(Date.now() + ABANDONED_MS);

    return new Response(null, { status: 101, webSocket: client });
  }

  /**
   * A message from one of the two.
   *
   * Binary is **relayed without being read** — it's the hot path, and opening a
   * frame here would spend the invocation's CPU budget on something neither side
   * asked for. Text is lobby, and that one does get parsed.
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
   * Sweeps away the abandoned room.
   *
   * The clock is reset every time someone joins, so it only fires in a room that
   * spent ten minutes with a single captain — which is a room nobody will use
   * again, holding a code someone else might want.
   */
  async alarm(): Promise<void> {
    const sockets = this.state.getWebSockets();
    if (sockets.length >= 2) {
      await this.state.storage.setAlarm(Date.now() + ABANDONED_MS);
      return;
    }
    await this.releaseQueueSlot(await this.room());
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
    // A different version is refused at the door. Letting it in would give a
    // match where both sides read the same bytes with different meanings — and
    // the symptom of that is not an error, it's an opponent acting like a madman.
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
    // A score off the scale is a made-up score: a tampered client declaring
    // itself at a thousand points would win command of every room it joined.
    peer.perfScore = Number.isFinite(message.perfScore)
      ? Math.max(0, Math.min(100, message.perfScore))
      : 0;
    // Stamped once, on the `hello`. See `PeerData.joinedAt`.
    if (peer.joinedAt === 0) peer.joinedAt = Date.now();
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
   * Decides who simulates and introduces the two, once both are present.
   *
   * Choosing by performance is this room's only game rule, and it exists because
   * in a host-authoritative duel the host's machine dictates the experience of
   * **both**. Whoever opened the room gets preference — it only loses command to
   * a visibly better machine. See `HOST_SWAP_MARGIN`.
   */
  private async pairIfReady(): Promise<void> {
    const sockets = this.state.getWebSockets();
    if (sockets.length !== 2) return;

    const [one, other] = sockets as [WebSocket, WebSocket];
    const dataOne = this.peerData(one);
    const dataOther = this.peerData(other);
    if (dataOne.role !== null || dataOther.role !== null) return;

    // ⚠️ **Both have to have introduced themselves, and the absence of this line
    // broke quick match on one of every two attempts.**
    //
    // A socket enters `getWebSockets()` at the `acceptWebSocket` in `fetch`, long
    // before its `hello` arrives. When both captains click "search" at the same
    // instant — which is the most common case the queue sees, two friends
    // arranging to play — the four things interleave as *accept A, accept B, hello
    // from A, hello from B*, and this method ran on the third step: two sockets in
    // the room, two null roles, and the second captain still without a name or a
    // score.
    //
    // The damage was twofold and neither half showed up as an error. The
    // `joinedAt` tie-breaker read zero for whoever hadn't spoken, so **whoever
    // arrived first was treated as the second** and lost command of the room to a
    // machine scoring zero. And the real `hello`, on arrival, found the roles
    // already decided and fell into the exit above — that is, the second captain
    // **never received the `peer`**. He stayed on the search timer forever, while
    // the other sat at "opponent aboard" waiting for a `ready` that never came.
    // The tell that this was it: the opponent's name showed up as `Sailor`.
    //
    // Bailing out here is safe because this method is called by every `hello`: the
    // late one pairs the two with complete information from both sides.
    if (dataOne.joinedAt === 0 || dataOther.joinedAt === 0) return;

    // Whoever arrived first is `first`, and that is read from the `hello` stamp —
    // **not** from the order in which the platform hands back the sockets, which
    // is not ordered. See `PeerData.joinedAt`.
    const oneFirst = dataOne.joinedAt <= dataOther.joinedAt;
    const first = oneFirst ? one : other;
    const second = oneFirst ? other : one;
    const a = oneFirst ? dataOne : dataOther;
    const b = oneFirst ? dataOther : dataOne;

    const swap = b.perfScore > a.perfScore + HOST_SWAP_MARGIN;
    a.role = swap ? 'guest' : 'host';
    b.role = swap ? 'host' : 'guest';
    this.setPeerData(first, a);
    this.setPeerData(second, b);

    this.send(first, { t: 'peer', nickname: b.nickname, role: a.role });
    this.send(second, { t: 'peer', nickname: a.nickname, role: b.role });
  }

  /** Starts once both say they have loaded what they had to load. */
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

    // The world comes from here, not from each player's preferences. It's what
    // keeps a player on "storm" and one on "calm" from sailing different seas —
    // wind feeds into sail force, so that would be an advantage.
    const start: ServerMessage = {
      t: 'start',
      seed: room.seed,
      weather: 'dynamic',
      timeOfDay: 0.34,
    };
    for (const socket of sockets) this.send(socket, start);
  }

  private async onResult(ws: WebSocket, winner: 0 | 1): Promise<void> {
    // Only the host declares the end, because only the host simulates. Accepting
    // it from the other would give the loser the power to announce his own win.
    if (this.peerData(ws).role !== 'host') return;

    const room = await this.room();
    if (room.phase !== 'playing') return;
    room.phase = 'over';
    await this.state.storage.put('room', room);

    this.broadcast({ t: 'over', reason: 'sunk', winner });
  }

  private async onPeerGone(ws: WebSocket): Promise<void> {
    const room = await this.room();
    // Dropped mid-duel: the other one is left with no opponent and nobody to
    // simulate. With no reconnect in today's scope, the match ends — and saying so
    // right away beats leaving someone alone in a sea that stopped responding.
    if (room.phase === 'playing') {
      room.phase = 'over';
      await this.state.storage.put('room', room);
      this.broadcastExcept(ws, { t: 'over', reason: 'left', winner: null });
      return;
    }

    // Still waiting: whoever is left goes back to being the only one, and his role
    // goes back to undefined — otherwise the next person to join would be paired
    // against a role decided by a comparison that no longer holds.
    let remaining = 0;
    let dismissed = 0;
    for (const socket of this.state.getWebSockets()) {
      if (socket === ws) continue;
      remaining++;
      const peer = this.peerData(socket);
      // If he already had a role, he has **already seen** the "opponent aboard"
      // screen and sent his `ready`. Clearing the role in silence left him there
      // forever: no timer (the waiting phase was already over), no error and no
      // opponent, waiting for a `start` that needs two `ready`s and is never
      // coming. It's the short window between pairing and the start — half a
      // second — and whoever falls into it has no way of knowing he did.
      const wasPaired = peer.role !== null;
      peer.role = null;
      peer.ready = false;
      this.setPeerData(socket, peer);
      if (!wasPaired) continue;

      // The same text at both ends on purpose: the client paints the `error`
      // message and then, when the socket closes right after, paints the close
      // reason over it. Two different texts would have the second erase the first
      // with a worse explanation. See `refuse` in `index.ts`, which follows the
      // same rule.
      const reason = 'The other captain left before the duel started.';
      this.send(socket, { t: 'error', reason });
      this.close(socket, 1000, reason);
      dismissed++;
    }

    // The last one left — or was dismissed because of him. This room's slot is no
    // use to anybody now, and there is no waiting on the `webSocketClose` of
    // someone just sent away: the hibernation API makes no promise to call it for
    // a close that started here, and a dead slot in the queue costs ten minutes of
    // someone staring at a search screen that will never find anything.
    if (remaining === dismissed) await this.releaseQueueSlot(room);
  }

  // -- plumbing ------------------------------------------------------------------

  /** Sends the frame to the other side. The only hot thing in this file. */
  private relay(from: WebSocket, frame: ArrayBuffer): void {
    for (const socket of this.state.getWebSockets()) {
      if (socket === from) continue;
      try {
        socket.send(frame);
      } catch {
        // Socket dying mid-send: `webSocketClose` takes care of the rest.
      }
    }
  }

  private send(ws: WebSocket, message: ServerMessage): void {
    try {
      ws.send(JSON.stringify(message));
    } catch {
      // Ditto.
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
      // Already closed.
    }
  }

  private peerData(ws: WebSocket): PeerData {
    return (ws.deserializeAttachment() as PeerData | null) ?? {
      nickname: 'Sailor',
      perfScore: 0,
      role: null,
      ready: false,
      joinedAt: 0,
    };
  }

  private setPeerData(ws: WebSocket, data: PeerData): void {
    ws.serializeAttachment(data);
  }

  /**
   * The room's state, creating it the first time around.
   *
   * The seed is born here, on the server, and not in either of the two clients:
   * it's what makes the sea, the wind and the weather the same on both sides, and
   * a number that comes out of one of the players is a number that player picks.
   */
  private async room(code?: string, queued = false): Promise<RoomData> {
    const stored = await this.state.storage.get<RoomData>('room');
    if (stored) return stored;

    const created: RoomData = {
      code: code ?? '????',
      phase: 'waiting',
      seed: (crypto.getRandomValues(new Uint32Array(1))[0] ?? 1337) >>> 0,
      queued,
    };
    await this.state.storage.put('room', created);
    return created;
  }

  /**
   * Gives this room's slot back to the queue, once the room has nobody left.
   *
   * Without this, whoever joins the queue and gives up leaves behind a slot
   * pointing at an empty room — and the next person to join the queue is sent
   * there, sits down alone and waits for an opponent who already left. The slot's
   * expiry would cover that eventually; "eventually" is ten minutes of someone
   * staring at a search screen that will never find anything.
   */
  private async releaseQueueSlot(room: RoomData): Promise<void> {
    if (!room.queued) return;
    const matchmaker = this.env.MATCHMAKER.get(this.env.MATCHMAKER.idFromName('global'));
    try {
      await matchmaker.fetch(`https://matchmaker/release?code=${encodeURIComponent(room.code)}`);
    } catch {
      // A queue that never got the notice falls back on the expiry. One extra
      // slot for a few minutes is far better than a room torn down over it.
    }
  }

  /** Sliding one-second window. See `MAX_MESSAGES_PER_SECOND`. */
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

/** The bindings declared in `wrangler.jsonc`. */
export interface Env {
  DUEL_ROOM: DurableObjectNamespace;
  MATCHMAKER: DurableObjectNamespace;
  ALLOWED_ORIGINS: string;
}
