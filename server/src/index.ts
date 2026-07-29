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
function toRoom(request: Request, env: Env, code: string): Promise<Response> {
  const id = env.DUEL_ROOM.idFromName(code);
  const url = new URL(request.url);
  url.searchParams.set('code', code);
  return env.DUEL_ROOM.get(id).fetch(new Request(url, request));
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
      return toRoom(request, env, generateCode());
    }

    if (url.pathname === '/queue') {
      // Uma subrequisição interna ao objeto único da fila. Ver `Matchmaker`.
      const matchmaker = env.MATCHMAKER.get(env.MATCHMAKER.idFromName('global'));
      const response = await matchmaker.fetch('https://matchmaker/claim');
      const { code } = (await response.json()) as { code: string };
      return toRoom(request, env, code);
    }

    const match = /^\/room\/([A-Za-z0-9]+)$/.exec(url.pathname);
    if (match) {
      const code = (match[1] ?? '').toUpperCase();
      // Validado aqui, e não na sala: um código malformado não deve nem chegar a
      // instanciar um Durable Object — cada instanciação é um request pago.
      if (!isValidCode(code)) {
        return new Response('That is not a room code.', { status: 400 });
      }
      return toRoom(request, env, code);
    }

    return new Response('Not found.', { status: 404 });
  },
} satisfies ExportedHandler<Env>;
