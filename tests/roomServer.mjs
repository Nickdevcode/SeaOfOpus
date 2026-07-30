/**
 * Room server test — two real captains, no browser.
 *
 * It's the only test in the project that **doesn't** run in the browser, and
 * for a reason that isn't taste: what it exercises is the Worker, and the Worker
 * isn't in the game's bundle. It opens WebSockets against a live `wrangler dev`
 * and talks the same lobby `RoomClient` talks.
 *
 * ```sh
 * npm run dev:server          # in one terminal
 * npm run test:server         # in the other
 * ```
 *
 * ## Why it exists
 *
 * Because the room is the one part of the duel that **can't be tested by
 * playing**. A physics defect shows up on screen; a matchmaking defect shows up
 * as two people on different waiting screens, each one sure the problem is the
 * other one's internet. That is exactly what happened with quick match: the
 * queue handed out a slot that was no longer any good, whoever got it sat alone
 * outside the queue, and from the outside that reads as "it doesn't work" and
 * nothing else.
 *
 * The cases here are all regressions: each one really failed at some point, and
 * what gets proven is the **conversation**, not the room's internal state —
 * nothing here peeks at a Durable Object's `storage`.
 */

/** Where `wrangler dev` is listening. The port is fixed; see `wrangler.jsonc`. */
const BASE = process.env.ROOM_SERVER ?? 'ws://127.0.0.1:8930';

/**
 * The protocol version, written by hand on purpose.
 *
 * Importing `PROTOCOL_VERSION` would make the test agree with the code by
 * construction — including on the day the number goes up without the server
 * being published, which is the one day this check would have anything to
 * say.
 */
const PROTOCOL_VERSION = 7;

/** How long a message is waited for before it gets given up on. */
const TIMEOUT_MS = 8000;

function open(path) {
  const socket = new WebSocket(`${BASE}${path}`);
  socket.binaryType = 'arraybuffer';
  socket.inbox = [];
  socket.waiters = [];
  socket.closed = null;

  const wake = () => {
    for (const resolve of socket.waiters.splice(0)) resolve();
  };
  socket.addEventListener('message', (event) => {
    socket.inbox.push(
      typeof event.data === 'string'
        ? JSON.parse(event.data)
        : { t: 'binary', bytes: event.data.byteLength },
    );
    wake();
  });
  socket.addEventListener('close', (event) => {
    socket.closed = { code: event.code, reason: event.reason };
    wake();
  });
  socket.addEventListener('error', () => {
    socket.closed ??= { code: -1, reason: 'error' };
    wake();
  });
  return socket;
}

function opened(socket) {
  return new Promise((resolve, reject) => {
    if (socket.readyState === WebSocket.OPEN) return resolve();
    const timer = setTimeout(() => reject(new Error(`${socket.url} never opened`)), TIMEOUT_MS);
    socket.addEventListener('open', () => {
      clearTimeout(timer);
      resolve();
    });
    socket.addEventListener('close', () => {
      clearTimeout(timer);
      reject(new Error(`${socket.url} closed before opening: ${JSON.stringify(socket.closed)}`));
    });
  });
}

/**
 * Waits for a message of that kind and **takes** it out of the inbox.
 *
 * Taking it out matters: several messages arrive in a burst (`welcome` and
 * `peer` come out one behind the other when the second captain joins), and a
 * test that only looked at the last one would miss half of them.
 */
async function expect(socket, kind) {
  const deadline = Date.now() + TIMEOUT_MS;
  for (;;) {
    const index = socket.inbox.findIndex((message) => message.t === kind);
    if (index >= 0) return socket.inbox.splice(index, 1)[0];
    if (Date.now() > deadline) {
      throw new Error(
        `waited for "${kind}"; inbox was ${JSON.stringify(socket.inbox)}, socket ${JSON.stringify(socket.closed)}`,
      );
    }
    await new Promise((resolve) => {
      socket.waiters.push(resolve);
      setTimeout(resolve, 100);
    });
  }
}

/**
 * A room code that almost certainly nobody has opened.
 *
 * The alphabet is the same as `CODE_ALPHABET` — the server refuses anything
 * outside it before instantiating any room at all. A million combinations
 * against the few rooms that exist at any given instant makes "almost
 * certainly" good enough for a test.
 */
function unusedCode() {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let code = '';
  for (let i = 0; i < 4; i++) {
    code += alphabet[Math.floor(Math.random() * alphabet.length)];
  }
  return code;
}

const send = (socket, message) => socket.send(JSON.stringify(message));
const hello = (socket, nickname, intent, perfScore = 70) =>
  send(socket, { t: 'hello', v: PROTOCOL_VERSION, nickname, intent, perfScore });

/** Opens a room by code and puts both sides inside, ready to duel. */
async function pairByCode(perfA = 70, perfB = 70) {
  const host = open('/room/new');
  await opened(host);
  hello(host, 'Ana', 'create', perfA);
  const welcome = await expect(host, 'welcome');

  const guest = open(`/room/${welcome.code}`);
  await opened(guest);
  hello(guest, 'Beto', 'join', perfB);
  await expect(guest, 'welcome');

  const roleA = await expect(host, 'peer');
  const roleB = await expect(guest, 'peer');
  send(host, { t: 'ready' });
  send(guest, { t: 'ready' });
  await expect(host, 'start');
  await expect(guest, 'start');

  return { host, guest, code: welcome.code, roleA, roleB };
}

const cases = [];

/**
 * Leaves the queue empty before a case that depends on it being empty.
 *
 * ⚠️ **Mandatory against the published server, and the lack of it failed a test
 * that was right.** There the queue is global and has real people in it: if
 * somebody is waiting, the test's first socket is sent into **their** room and
 * paired with them, which is the server's correct behavior and the ruin of the
 * assertion. The symptom was a `peer` with the nickname `Sailor` — which is
 * exactly the signature of the defect the next case looks for, and there it was
 * only the default name of a captain who never typed one.
 *
 * The decoy settles both cases at once: if somebody was waiting, it takes them
 * and the slot empties; if nobody was, it becomes the slot's owner and hands it
 * back when it closes.
 */
async function drainQueue() {
  const bait = open('/queue');
  await opened(bait);
  hello(bait, 'Isca', 'queue');
  await expect(bait, 'welcome');
  bait.close(1000, 'left');
  // The room needs a moment to see the close and tell the queue.
  await new Promise((resolve) => setTimeout(resolve, 700));
}

async function test(nome, run) {
  const sockets = [];
  try {
    await run(sockets);
    cases.push({ nome, passou: true, erro: '' });
  } catch (error) {
    cases.push({ nome, passou: false, erro: String(error?.message ?? error) });
  } finally {
    for (const socket of sockets) {
      try {
        socket.close();
      } catch {
        // Already closed.
      }
    }
  }
}

await test('the queue pairs two captains', async (keep) => {
  await drainQueue();

  const first = open('/queue');
  keep.push(first);
  await opened(first);
  hello(first, 'Ana', 'queue', 90);
  const welcome = await expect(first, 'welcome');
  if (!welcome.code) throw new Error('welcome came without a room code');

  const second = open('/queue');
  keep.push(second);
  await opened(second);
  hello(second, 'Beto', 'queue', 40);
  await expect(second, 'welcome');

  const roleA = await expect(first, 'peer');
  const roleB = await expect(second, 'peer');
  if (roleA.role === roleB.role) throw new Error(`both got role "${roleA.role}"`);
  // Whoever opened the room has preference, and only loses command to a machine
  // that is visibly better. See `HOST_SWAP_MARGIN`.
  if (roleA.role !== 'host') throw new Error(`the stronger machine got "${roleA.role}"`);
  if (roleA.nickname !== 'Beto' || roleB.nickname !== 'Ana') {
    throw new Error('each side must see the other one’s name');
  }

  send(first, { t: 'ready' });
  send(second, { t: 'ready' });
  const startA = await expect(first, 'start');
  const startB = await expect(second, 'start');
  if (startA.seed !== startB.seed) throw new Error('the two sides got different seeds');
  if (startA.timeOfDay !== startB.timeOfDay) throw new Error('the two sides got different clocks');
});

await test('the queue does not pick who simulates before both have introduced themselves', async (keep) => {
  await drainQueue();

  // ⚠️ Both connections open **before** any `hello`, and that is what this case
  // has that the one above doesn't. It's what happens when two friends click
  // "find a captain" at the same instant: both sockets enter the room and only
  // then do both names arrive. It was the only sequence in which quick match
  // broke, and it broke half the time.
  const ana = open('/queue');
  keep.push(ana);
  await opened(ana);

  const beto = open('/queue');
  keep.push(beto);
  await opened(beto);

  // Only Ana has introduced herself. The room has two sockets and one name —
  // there is nothing to compare against, so there is nothing to decide.
  hello(ana, 'Ana', 'queue', 90);
  await expect(ana, 'welcome');
  await new Promise((resolve) => setTimeout(resolve, 400));
  const early = ana.inbox.find((message) => message.t === 'peer');
  if (early) {
    throw new Error(`paired against a captain who had not said hello: ${JSON.stringify(early)}`);
  }

  hello(beto, 'Beto', 'queue', 40);
  await expect(beto, 'welcome');
  const roleA = await expect(ana, 'peer');
  const roleB = await expect(beto, 'peer');

  // `Sailor` here is the exact signature of the defect: it was the factory name
  // of whoever hadn't spoken yet, and it was what the other side got as opponent.
  if (roleA.nickname !== 'Beto' || roleB.nickname !== 'Ana') {
    throw new Error(`each side must see the other one’s name; got ${roleA.nickname}/${roleB.nickname}`);
  }
  // And the tiebreak holds again: whoever arrived first keeps command, and the
  // other one's score is the real one instead of zero.
  if (roleA.role !== 'host') throw new Error(`the captain who arrived first got "${roleA.role}"`);
  if (roleB.role !== 'guest') throw new Error(`the second captain got "${roleB.role}"`);
});

await test('the queue does not seat anyone in a slot that is no longer any good', async (keep) => {
  await drainQueue();

  // Ana joins the queue and becomes the slot being held.
  const ana = open('/queue');
  keep.push(ana);
  await opened(ana);
  hello(ana, 'Ana', 'queue');
  const dead = await expect(ana, 'welcome');

  // Somebody joins her room **by code**, and the duel starts. The slot still
  // points there and now it is no good to anyone else.
  const zeca = open(`/room/${dead.code}`);
  keep.push(zeca);
  await opened(zeca);
  hello(zeca, 'Zeca', 'join');
  await expect(ana, 'peer');
  await expect(zeca, 'peer');
  send(ana, { t: 'ready' });
  send(zeca, { t: 'ready' });
  await expect(ana, 'start');

  // Beto joins the queue and gets that dead slot. He has to end up in a new
  // room, **and inside the queue** — before, he sat alone outside it, waiting
  // for an opponent who would never be sent there.
  const beto = open('/queue');
  keep.push(beto);
  await opened(beto);
  hello(beto, 'Beto', 'queue');
  const fresh = await expect(beto, 'welcome');
  if (fresh.code === dead.code) throw new Error('sent into the room that was already duelling');

  // The proof that he really is in the queue: the next one to join lands with him.
  const caio = open('/queue');
  keep.push(caio);
  await opened(caio);
  hello(caio, 'Caio', 'queue');
  await expect(caio, 'welcome');
  await expect(beto, 'peer');
  await expect(caio, 'peer');
});

await test('quem desiste da fila devolve a vaga', async (keep) => {
  await drainQueue();

  const ana = open('/queue');
  keep.push(ana);
  await opened(ana);
  hello(ana, 'Ana', 'queue');
  const abandoned = await expect(ana, 'welcome');
  ana.close(1000, 'left');
  // The room needs a moment to see the close and tell the queue.
  await new Promise((resolve) => setTimeout(resolve, 700));

  const beto = open('/queue');
  keep.push(beto);
  await opened(beto);
  hello(beto, 'Beto', 'queue');
  const fresh = await expect(beto, 'welcome');
  if (fresh.code === abandoned.code) throw new Error('sent into the room nobody is in');
});

await test('the room by code pairs and relays a frame', async (keep) => {
  const { host, guest } = await pairByCode();
  keep.push(host, guest);

  host.send(new Uint8Array([2, 0, 1, 2, 3, 4]).buffer);
  const relayed = await expect(guest, 'binary');
  if (relayed.bytes !== 6) throw new Error(`frame arrived with ${relayed.bytes} bytes, not 6`);
});

await test('a code nobody opened is refused with a reason', async (keep) => {
  // ⚠️ Drawn at random, and **not** a hardcoded `ZZZZ`. This test also runs
  // against the published server, where rooms are global and outlive the run: a
  // fixed code passes the first time and fails every time after, because the
  // first run created it. That is what happened — and what the test exposed
  // wasn't the server, it was itself.
  const lost = open(`/room/${unusedCode()}`);
  keep.push(lost);
  await opened(lost);
  hello(lost, 'Ana', 'join');
  const error = await expect(lost, 'error');
  if (!/no room/i.test(error.reason)) throw new Error(`unhelpful reason: ${error.reason}`);
});

await test('a different version of the game is refused at the door', async (keep) => {
  const stale = open('/room/new');
  keep.push(stale);
  await opened(stale);
  send(stale, { t: 'hello', v: 1, nickname: 'Ana', intent: 'create', perfScore: 50 });
  const error = await expect(stale, 'error');
  if (!/version/i.test(error.reason)) throw new Error(`unhelpful reason: ${error.reason}`);
});

await test('a third at the door does not take down the two players’ duel', async (keep) => {
  const { host, guest, code } = await pairByCode();
  keep.push(host, guest);

  const curious = open(`/room/${code}`);
  keep.push(curious);
  await opened(curious);
  hello(curious, 'Curioso', 'join');
  await expect(curious, 'error');

  // The duel is still standing, and nobody was sent home.
  host.send(new Uint8Array([2, 0, 0, 0]).buffer);
  await expect(guest, 'binary');
  if (host.closed || guest.closed) throw new Error('the duel dropped because of the third socket');
  if (host.inbox.some((message) => message.t === 'over')) {
    throw new Error('the room called the duel over because of the third socket');
  }
});

await test('o resultado do host encerra a sala dos dois lados', async (keep) => {
  const { host, guest, roleA } = await pairByCode(95, 30);
  keep.push(host, guest);

  const simulating = roleA.role === 'host' ? host : guest;
  send(simulating, { t: 'result', winner: 0 });

  const overHost = await expect(host, 'over');
  const overGuest = await expect(guest, 'over');
  if (overHost.reason !== 'sunk' || overGuest.reason !== 'sunk') {
    throw new Error('the duel ended for the wrong reason');
  }
  if (overHost.winner !== 0 || overGuest.winner !== 0) {
    throw new Error('the two sides were told different winners');
  }
});

await test('only the host may declare the end', async (keep) => {
  const { host, guest, roleA } = await pairByCode(95, 30);
  keep.push(host, guest);

  const watching = roleA.role === 'host' ? guest : host;
  send(watching, { t: 'result', winner: 1 });
  await new Promise((resolve) => setTimeout(resolve, 500));
  if (host.inbox.some((message) => message.t === 'over')) {
    throw new Error('a guest was able to announce its own victory');
  }
});

await test('whoever is left alone is told the other one left', async (keep) => {
  const { host, guest } = await pairByCode();
  keep.push(host);

  guest.close(1000, 'left');
  const over = await expect(host, 'over');
  if (over.reason !== 'left') throw new Error(`ended as "${over.reason}", not "left"`);
});

await test('whoever was paired and left alone before the start is told', async (keep) => {
  await drainQueue();

  const ana = open('/queue');
  keep.push(ana);
  await opened(ana);
  hello(ana, 'Ana', 'queue');
  const room = await expect(ana, 'welcome');

  const beto = open(`/room/${room.code}`);
  keep.push(beto);
  await opened(beto);
  hello(beto, 'Beto', 'join');
  await expect(ana, 'peer');
  await expect(beto, 'peer');

  // Beto gives up in the window between matchmaking and `start` — half a second
  // in which the two already know each other and the duel hasn't begun. With no
  // warning, Ana sat on the "opponent aboard" screen forever: the wait was over,
  // so there wasn't even a clock running to suggest something was wrong.
  beto.close(1000, 'left');
  const error = await expect(ana, 'error');
  if (!/left/i.test(error.reason)) throw new Error(`unhelpful reason: ${error.reason}`);

  // A moment for the room to hand the slot back to the queue before the next case.
  await new Promise((resolve) => setTimeout(resolve, 400));
});

console.table(cases);
const falhas = cases.filter((entry) => !entry.passou).length;
console.log(falhas === 0 ? `\n${cases.length} casos, todos passaram.` : `\n${falhas} de ${cases.length} falharam.`);
process.exit(falhas === 0 ? 0 : 1);
