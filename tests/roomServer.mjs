/**
 * Teste do servidor de sala — dois capitães de verdade, sem navegador.
 *
 * É o único teste do projeto que **não** roda no navegador, e por um motivo que
 * não é gosto: o que ele exercita é o Worker, e o Worker não está no bundle do
 * jogo. Ele abre WebSockets contra um `wrangler dev` vivo e conversa o mesmo
 * lobby que `RoomClient` conversa.
 *
 * ```sh
 * npm run dev:server          # num terminal
 * npm run test:server         # no outro
 * ```
 *
 * ## Por que ele existe
 *
 * Porque a sala é a única parte do duelo que **não dá para testar jogando**. Um
 * defeito de física aparece na tela; um defeito de pareamento aparece como duas
 * pessoas em telas de espera diferentes, cada uma achando que o problema é a
 * internet da outra. Foi exatamente o que aconteceu com a partida rápida: a fila
 * entregava uma vaga que já não servia, quem a recebia sentava sozinho fora da
 * fila, e do lado de fora isso se lê como "não funciona" e mais nada.
 *
 * Os casos daqui são todos regressões: cada um falhou de verdade em algum
 * momento, e o que se prova é a **conversa**, não o estado interno da sala —
 * nada aqui espia o `storage` de um Durable Object.
 */

/** Onde o `wrangler dev` está escutando. A porta é fixa; ver `wrangler.jsonc`. */
const BASE = process.env.ROOM_SERVER ?? 'ws://127.0.0.1:8930';

/**
 * A versão do protocolo, escrita à mão de propósito.
 *
 * Importar `PROTOCOL_VERSION` faria o teste concordar com o código por
 * construção — inclusive no dia em que o número subir sem o servidor ser
 * publicado, que é o único dia em que esta verificação teria alguma coisa a
 * dizer.
 */
const PROTOCOL_VERSION = 5;

/** Quanto se espera por uma mensagem antes de desistir dela. */
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
 * Espera uma mensagem daquele tipo e a **tira** da caixa.
 *
 * Tirar importa: várias mensagens chegam em rajada (`welcome` e `peer` saem uma
 * atrás da outra quando o segundo capitão entra), e um teste que só olhasse a
 * última perderia metade delas.
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
 * Um código de sala que quase certamente ninguém abriu.
 *
 * O alfabeto é o mesmo de `CODE_ALPHABET` — o servidor recusa qualquer coisa
 * fora dele antes de instanciar sala nenhuma. Um milhão de combinações contra
 * as poucas salas que existem num instante qualquer faz "quase certamente" ser
 * bom o bastante para um teste.
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

/** Abre uma sala por código e põe os dois lá dentro, prontos para duelar. */
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
        // Já fechado.
      }
    }
  }
}

await test('a fila pareia dois capitães', async (keep) => {
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
  // Quem abriu a sala tem preferência, e só perde o comando para uma máquina
  // visivelmente melhor. Ver `HOST_SWAP_MARGIN`.
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

await test('a fila não senta ninguém numa vaga que já não serve', async (keep) => {
  // Ana entra na fila e vira a vaga guardada.
  const ana = open('/queue');
  keep.push(ana);
  await opened(ana);
  hello(ana, 'Ana', 'queue');
  const dead = await expect(ana, 'welcome');

  // Alguém entra na sala dela **por código**, e o duelo começa. A vaga continua
  // apontando para lá e agora ela não serve a mais ninguém.
  const zeca = open(`/room/${dead.code}`);
  keep.push(zeca);
  await opened(zeca);
  hello(zeca, 'Zeca', 'join');
  await expect(ana, 'peer');
  await expect(zeca, 'peer');
  send(ana, { t: 'ready' });
  send(zeca, { t: 'ready' });
  await expect(ana, 'start');

  // Beto entra na fila e recebe aquela vaga morta. Ele tem de acabar numa sala
  // nova, **e dentro da fila** — antes ele sentava sozinho, fora dela, esperando
  // um adversário que nunca seria mandado para lá.
  const beto = open('/queue');
  keep.push(beto);
  await opened(beto);
  hello(beto, 'Beto', 'queue');
  const fresh = await expect(beto, 'welcome');
  if (fresh.code === dead.code) throw new Error('sent into the room that was already duelling');

  // A prova de que ele está mesmo na fila: o próximo a entrar cai com ele.
  const caio = open('/queue');
  keep.push(caio);
  await opened(caio);
  hello(caio, 'Caio', 'queue');
  await expect(caio, 'welcome');
  await expect(beto, 'peer');
  await expect(caio, 'peer');
});

await test('quem desiste da fila devolve a vaga', async (keep) => {
  const ana = open('/queue');
  keep.push(ana);
  await opened(ana);
  hello(ana, 'Ana', 'queue');
  const abandoned = await expect(ana, 'welcome');
  ana.close(1000, 'left');
  // A sala precisa de um instante para ver o fechamento e avisar a fila.
  await new Promise((resolve) => setTimeout(resolve, 700));

  const beto = open('/queue');
  keep.push(beto);
  await opened(beto);
  hello(beto, 'Beto', 'queue');
  const fresh = await expect(beto, 'welcome');
  if (fresh.code === abandoned.code) throw new Error('sent into the room nobody is in');
});

await test('a sala por código pareia e retransmite quadro', async (keep) => {
  const { host, guest } = await pairByCode();
  keep.push(host, guest);

  host.send(new Uint8Array([2, 0, 1, 2, 3, 4]).buffer);
  const relayed = await expect(guest, 'binary');
  if (relayed.bytes !== 6) throw new Error(`frame arrived with ${relayed.bytes} bytes, not 6`);
});

await test('um código que ninguém abriu é recusado com motivo', async (keep) => {
  // ⚠️ Sorteado, e **não** um `ZZZZ` cravado. Este teste também roda contra o
  // servidor publicado, onde as salas são globais e sobrevivem à corrida: um
  // código fixo passa na primeira vez e reprova em todas as seguintes, porque a
  // primeira o criou. Foi o que aconteceu — e o que o teste denunciou não foi o
  // servidor, foi ele mesmo.
  const lost = open(`/room/${unusedCode()}`);
  keep.push(lost);
  await opened(lost);
  hello(lost, 'Ana', 'join');
  const error = await expect(lost, 'error');
  if (!/no room/i.test(error.reason)) throw new Error(`unhelpful reason: ${error.reason}`);
});

await test('uma versão diferente do jogo é recusada na porta', async (keep) => {
  const stale = open('/room/new');
  keep.push(stale);
  await opened(stale);
  send(stale, { t: 'hello', v: 1, nickname: 'Ana', intent: 'create', perfScore: 50 });
  const error = await expect(stale, 'error');
  if (!/version/i.test(error.reason)) throw new Error(`unhelpful reason: ${error.reason}`);
});

await test('um terceiro na porta não derruba o duelo dos dois', async (keep) => {
  const { host, guest, code } = await pairByCode();
  keep.push(host, guest);

  const curious = open(`/room/${code}`);
  keep.push(curious);
  await opened(curious);
  hello(curious, 'Curioso', 'join');
  await expect(curious, 'error');

  // O duelo continua de pé, e ninguém foi mandado para casa.
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

await test('só o host pode declarar o fim', async (keep) => {
  const { host, guest, roleA } = await pairByCode(95, 30);
  keep.push(host, guest);

  const watching = roleA.role === 'host' ? guest : host;
  send(watching, { t: 'result', winner: 1 });
  await new Promise((resolve) => setTimeout(resolve, 500));
  if (host.inbox.some((message) => message.t === 'over')) {
    throw new Error('a guest was able to announce its own victory');
  }
});

await test('quem fica sozinho é avisado de que o outro saiu', async (keep) => {
  const { host, guest } = await pairByCode();
  keep.push(host);

  guest.close(1000, 'left');
  const over = await expect(host, 'over');
  if (over.reason !== 'left') throw new Error(`ended as "${over.reason}", not "left"`);
});

console.table(cases);
const falhas = cases.filter((entry) => !entry.passou).length;
console.log(falhas === 0 ? `\n${cases.length} casos, todos passaram.` : `\n${falhas} de ${cases.length} falharam.`);
process.exit(falhas === 0 ? 0 : 1);
