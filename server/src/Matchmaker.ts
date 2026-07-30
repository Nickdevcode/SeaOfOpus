/**
 * The queue: whoever arrives alone waits, whoever arrives next joins the room of
 * the one who was waiting.
 *
 * The whole object holds **one field**, and even so it is the piece that justifies
 * using Durable Objects instead of anything else: each Durable Object is a single
 * instance with serialized execution, so "is anyone waiting?" and "then I'm the
 * one who takes it" happen without two simultaneous requests both getting a yes.
 * It is mutual exclusion with no transaction, no lock and no database.
 *
 * Costs **two requests per duel** — one from each captain.
 *
 * ## Two routes
 *
 * | route | who calls | what it does |
 * |---|---|---|
 * | `/claim` | the Worker, when someone queues | returns the waiting player's room, or opens one |
 * | `/release?code=` | the room, when it goes empty | takes that room out of the queue |
 *
 * The second exists because a slot nobody occupies has to leave the queue **the
 * instant its owner gives up**, and not when a deadline expires. See
 * `WAITING_TTL_MS`.
 */

import { generateCode } from './codes';

interface Waiting {
  code: string;
  since: number;
}

/**
 * Expiry for a slot in the queue.
 *
 * ⚠️ **Ten minutes, and it was sixty seconds once** — which broke the whole
 * queue in the most common case it sees: two friends arranging to play.
 *
 * The first one clicks "quick match", the object opens room `X` and stores him
 * as the one waiting. The second clicks a minute and a half later, when `X` has
 * already expired — and instead of joining `X`, he **opens room `Y`** and starts
 * waiting in it. The two sit in different rooms, forever, each watching the same
 * "searching for an opponent" screen. And there is nothing to bring them
 * together afterwards: the first to arrive is no longer in the queue, and the
 * last to arrive is in a new slot that only a third player would claim.
 *
 * Ten minutes is the same deadline the room uses to declare itself abandoned,
 * which makes both clocks tell the same story. And the deadline is no longer the
 * main defense against a dead slot: today it's `/release` that takes it out of
 * the queue as soon as it empties, and this here is only the safety net for the
 * case where the room dies without managing to say so.
 */
const WAITING_TTL_MS = 10 * 60 * 1000;

export class Matchmaker implements DurableObject {
  constructor(private readonly state: DurableObjectState) {}

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === '/release') {
      return this.release(url.searchParams.get('code'));
    }
    return this.claim();
  }

  /** Someone joined the queue. */
  private async claim(): Promise<Response> {
    const waiting = await this.state.storage.get<Waiting>('waiting');
    const now = Date.now();

    // Someone was waiting and the slot is still good: send both to the same room
    // and clear the queue in the same step — nobody else can claim this slot
    // because this object serves one request at a time.
    if (waiting && now - waiting.since < WAITING_TTL_MS) {
      await this.state.storage.delete('waiting');
      return Response.json({ code: waiting.code, waited: true });
    }

    const code = generateCode();
    await this.state.storage.put('waiting', { code, since: now } satisfies Waiting);
    return Response.json({ code, waited: false });
  }

  /**
   * A room reported that it went empty.
   *
   * The `code` is checked before deleting: between the player leaving and this
   * notice arriving, someone else may have joined the queue and taken the slot
   * with a new code. Deleting without looking would pull someone who had just
   * joined the queue right back out of it, and the symptom would be the very
   * defect this method exists to fix.
   */
  private async release(code: string | null): Promise<Response> {
    if (!code) return Response.json({ released: false });

    const waiting = await this.state.storage.get<Waiting>('waiting');
    if (waiting?.code === code) {
      await this.state.storage.delete('waiting');
      return Response.json({ released: true });
    }
    return Response.json({ released: false });
  }
}
