/**
 * A porta de entrada do servidor de sala.
 *
 * Três rotas, todas terminando no mesmo lugar: um `WebSocket` ligado a um
 * `DuelRoom`. O que muda entre elas é **como se descobre o código da sala**.
 *
 * | rota | como |
 * |---|---|
 * | `GET /room/new` | sorteia um código na hora |
 * | `GET /room/:code` | usa o que o jogador digitou |
 * | `GET /queue` | pergunta ao `Matchmaker` se há alguém esperando |
 *
 * `idFromName(code)` é o que amarra o código à sala: o mesmo texto sempre leva ao
 * mesmo Durable Object, em qualquer ponto do mundo. Não há registro de salas para
 * manter, nem busca para fazer — o código **é** o endereço.
 */

import { isValidCode } from '../../shared/protocol';
import { generateCode } from './codes';
import { DuelRoom, type Env } from './DuelRoom';
import { Matchmaker } from './Matchmaker';

export { DuelRoom, Matchmaker };

/**
 * A origem que pediu tem permissão?
 *
 * Sem esta checagem, qualquer página da internet abre salas neste Worker — e a
 * cota de requests que se queima é a sua. Não é proteção contra um cliente
 * adulterado (o cabeçalho é falsificável fora do navegador); é a cerca que
 * impede um site aleatório de embutir o jogo e viver da sua conta.
 *
 * Sem cabeçalho `Origin` a conexão passa: é o caso de `wrangler dev` e de
 * ferramentas de linha de comando, e não é ninguém consumindo cota em escala.
 */
function originAllowed(request: Request, env: Env): boolean {
  const origin = request.headers.get('Origin');
  if (!origin) return true;
  const allowed = (env.ALLOWED_ORIGINS ?? '').split(',').map((entry) => entry.trim());
  return allowed.includes(origin);
}

/** Encaminha para a sala daquele código. */
function toRoom(request: Request, env: Env, code: string, extra: Record<string, string> = {}): Promise<Response> {
  const id = env.DUEL_ROOM.idFromName(code);
  const url = new URL(request.url);
  url.searchParams.set('code', code);
  for (const [key, value] of Object.entries(extra)) url.searchParams.set(key, value);
  return env.DUEL_ROOM.get(id).fetch(new Request(url, request));
}

/**
 * Recusa a conexão **dizendo por quê**.
 *
 * Um status HTTP não chega ao jogador, e é limitação do protocolo, não escolha:
 * quando o aperto de mão de um WebSocket falha, o navegador não entrega o
 * código nem o corpo da resposta ao JavaScript — o que chega é um `close` mudo.
 * O cliente então conta a única história que lhe resta, "a conexão caiu", para
 * causas completamente diferentes; e duas das três o jogador resolveria sozinho
 * em cinco segundos se soubesse qual era.
 *
 * Aceitar para poder falar, então. Aceitar **aqui**, e não dentro do Durable
 * Object, é o detalhe que evita o remédio pior que a doença: um socket aceito lá
 * dentro entraria em `getWebSockets()`, e o fechamento dele dispararia
 * `webSocketClose` — ou seja, um terceiro jogador batendo na porta de um duelo
 * em andamento faria a sala declarar a partida encerrada e mandar os dois para
 * casa. Deste lado o socket não existe para a sala.
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
 * Entra na fila, e **insiste** se a vaga que ela deu não servir.
 *
 * ⚠️ Este segundo pedido é a diferença entre a partida rápida funcionar e não
 * funcionar, e o defeito que ele conserta é invisível de fora. A fila entrega o
 * código de quem estava esperando e apaga a vaga no mesmo passo — a partir dali
 * aquele código não pertence mais a ninguém. Se a sala recusar (o outro capitão
 * caiu sem que o fechamento tivesse chegado, ou dois pedidos se cruzaram e ela
 * já está cheia), quem pediu fica com um código morto na mão: ele não entra
 * naquela sala, não é o dono da vaga e **não está mais na fila**. Senta e espera
 * um adversário que nunca vai ser mandado para lá.
 *
 * Pedindo de novo, a fila responde a coisa certa para essa situação: não há
 * mais ninguém esperando, então abre uma vaga nova e este jogador passa a ser o
 * dono dela. Ele volta a estar na fila, que é onde ele achava que estava.
 */
async function claimRoom(request: Request, env: Env): Promise<Response> {
  const matchmaker = env.MATCHMAKER.get(env.MATCHMAKER.idFromName('global'));

  for (let attempt = 0; attempt < 2; attempt++) {
    const response = await matchmaker.fetch('https://matchmaker/claim');
    const { code, waited } = (await response.json()) as { code: string; waited: boolean };
    // Quem **abriu** a vaga precisa que a sala saiba disso: é ela que vai avisar
    // a fila quando esvaziar. Ver `DuelRoom.releaseQueueSlot`.
    const room = await toRoom(request, env, code, waited ? {} : { queued: '1' });
    if (room.status < 400) return room;
    // Uma vaga que não serve não vale uma segunda tentativa se ela era nossa:
    // acabamos de abri-la, e uma sala recém-aberta que recusa é outro problema.
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
      // Duas tentativas porque o código é sorteado: um milhão de salas possíveis
      // torna a colisão rara, e "rara" não é "impossível". Cair num código
      // ocupado e recusar seria mandar o jogador tentar de novo para que o
      // programa sorteasse outro número — trabalho que o programa faz melhor.
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
      // Validado aqui, e não na sala: um código malformado não deve nem chegar a
      // instanciar um Durable Object — cada instanciação é um request pago.
      if (!isValidCode(code)) {
        return refuse('That is not a room code.');
      }
      // Esta rota é a de **entrar**, e a sala precisa saber disso para poder
      // recusar um código que ninguém abriu. Abrir sala é `/room/new`; a fila é
      // `/queue`. Ver `DuelRoom.fetch`.
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
