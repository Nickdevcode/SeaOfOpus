/**
 * The room server's front door.
 *
 * Three routes, all ending in the same place: a `WebSocket` wired to a
 * `DuelRoom`. What changes between them is **how the room code is found**.
 *
 * | route | how |
 * |---|---|
 * | `GET /room/new` | draws a code on the spot |
 * | `GET /room/:code` | uses what the player typed |
 * | `GET /queue` | asks the `Matchmaker` whether anyone is waiting |
 *
 * `idFromName(code)` is what ties the code to the room: the same text always
 * leads to the same Durable Object, anywhere in the world. There is no room
 * registry to keep and no lookup to do — the code **is** the address.
 */

import { isValidCode } from '../../shared/protocol';
import { generateCode } from './codes';
import { DuelRoom, type Env } from './DuelRoom';
import { Matchmaker } from './Matchmaker';

export { DuelRoom, Matchmaker };

/**
 * Is the requesting origin allowed?
 *
 * Without this check, any page on the internet opens rooms on this Worker — and
 * the request quota it burns is yours. It is not protection against a tampered
 * client (the header is forgeable outside the browser); it's the fence that keeps
 * a random site from embedding the game and living off your account.
 *
 * With no `Origin` header the connection goes through: that's the case for
 * `wrangler dev` and command-line tools, and it isn't anyone eating quota at
 * scale.
 */
function originAllowed(request: Request, env: Env): boolean {
  const origin = request.headers.get('Origin');
  if (!origin) return true;
  const allowed = (env.ALLOWED_ORIGINS ?? '').split(',').map((entry) => entry.trim());
  return allowed.includes(origin);
}

/** Forwards to the room for that code. */
function toRoom(request: Request, env: Env, code: string, extra: Record<string, string> = {}): Promise<Response> {
  const id = env.DUEL_ROOM.idFromName(code);
  const url = new URL(request.url);
  url.searchParams.set('code', code);
  for (const [key, value] of Object.entries(extra)) url.searchParams.set(key, value);
  return env.DUEL_ROOM.get(id).fetch(new Request(url, request));
}

/**
 * Refuses the connection **and says why**.
 *
 * An HTTP status never reaches the player, and that is a protocol limitation, not
 * a choice: when a WebSocket handshake fails, the browser hands neither the
 * status code nor the response body to JavaScript — what arrives is a mute
 * `close`. The client then tells the only story left to it, "the connection
 * dropped", for completely different causes; and two of the three the player
 * would sort out himself in five seconds if he knew which one it was.
 *
 * So accept, in order to be able to speak. Accepting **here**, and not inside the
 * Durable Object, is the detail that avoids a cure worse than the disease: a
 * socket accepted in there would enter `getWebSockets()`, and closing it would
 * fire `webSocketClose` — that is, a third player knocking at the door of a duel
 * in progress would make the room declare the match over and send both players
 * home. On this side the socket does not exist as far as the room is concerned.
 */
function refuse(reason: string): Response {
  const pair = new WebSocketPair();
  const [client, server] = [pair[0], pair[1]];
  server.accept();
  server.send(JSON.stringify({ t: 'error', reason }));
  server.close(1000, reason);
  return new Response(null, { status: 101, webSocket: client });
}

/**
 * Joins the queue, and **insists** if the slot it handed back is no good.
 *
 * ⚠️ This second request is the difference between quick match working and not
 * working, and the defect it fixes is invisible from the outside. The queue hands
 * over the code of whoever was waiting and erases the slot in the same step —
 * from there on that code belongs to nobody. If the room refuses (the other
 * captain dropped without the close having arrived, or two requests crossed and
 * the room is already full), the requester is left holding a dead code: he does
 * not get into that room, he does not own the slot, and he is **no longer in the
 * queue**. He sits down and waits for an opponent who will never be sent there.
 *
 * Asking again, the queue answers the right thing for that situation: there is
 * nobody else waiting, so it opens a new slot and this player becomes its owner.
 * He is back in the queue, which is where he thought he was.
 */
async function claimRoom(request: Request, env: Env): Promise<Response> {
  const matchmaker = env.MATCHMAKER.get(env.MATCHMAKER.idFromName('global'));

  for (let attempt = 0; attempt < 2; attempt++) {
    const response = await matchmaker.fetch('https://matchmaker/claim');
    const { code, waited } = (await response.json()) as { code: string; waited: boolean };
    // Whoever **opened** the slot needs the room to know: the room is what warns
    // the queue when it empties out. See `DuelRoom.releaseQueueSlot`.
    const room = await toRoom(request, env, code, waited ? {} : { queued: '1' });
    if (room.status < 400) return room;
    // A slot that's no good isn't worth a second attempt if it was ours: it was
    // just opened here, and a freshly opened room that refuses is another problem.
    if (!waited) break;
  }

  return refuse('Could not find a duel right now. Try again in a moment.');
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === '/health') {
      return Response.json({ ok: true });
    }

    if (!originAllowed(request, env)) {
      return new Response('Origin not allowed.', { status: 403 });
    }

    if (url.pathname === '/room/new') {
      // Two attempts because the code is drawn at random: a million possible
      // rooms makes a collision rare, and "rare" is not "impossible". Landing on
      // a taken code and refusing would mean telling the player to try again so
      // the program could draw another number — work the program does better.
      for (let attempt = 0; attempt < 2; attempt++) {
        const room = await toRoom(request, env, generateCode());
        if (room.status < 400) return room;
      }
      return refuse('Could not open a room right now. Try again in a moment.');
    }

    if (url.pathname === '/queue') {
      return claimRoom(request, env);
    }

    const match = /^\/room\/([A-Za-z0-9]+)$/.exec(url.pathname);
    if (match) {
      const code = (match[1] ?? '').toUpperCase();
      // Validated here, not in the room: a malformed code shouldn't even get to
      // instantiate a Durable Object — each instantiation is a paid request.
      if (!isValidCode(code)) {
        return refuse('That is not a room code.');
      }
      // This route is the **join** one, and the room needs to know that so it can
      // refuse a code nobody opened. Opening a room is `/room/new`; the queue is
      // `/queue`. See `DuelRoom.fetch`.
      const room = await toRoom(request, env, code, { join: '1' });
      if (room.status === 404) {
        return refuse('No room with that code. Check the letters and try again.');
      }
      if (room.status >= 400) {
        return refuse('That room is full, or the duel has already started.');
      }
      return room;
    }

    return new Response('Not found.', { status: 404 });
  },
} satisfies ExportedHandler<Env>;
