/**
 * A fila: quem chega sozinho espera, quem chega depois entra na sala de quem
 * esperava.
 *
 * O objeto inteiro guarda **um campo**, e ainda assim ele é a peça que justifica
 * usar Durable Objects em vez de qualquer outra coisa: cada Durable Object é uma
 * instância única e de execução serializada, então "há alguém esperando?" e
 * "então sou eu que pego" acontecem sem que dois pedidos simultâneos possam
 * responder sim aos dois. É exclusão mútua sem transação, sem trava e sem banco.
 *
 * Custa **dois requests por duelo** — um de cada capitão.
 */

import { generateCode } from './codes';

interface Waiting {
  code: string;
  since: number;
}

/**
 * Prazo de validade de uma vaga na fila.
 *
 * Uma sala anunciada e nunca ocupada precisa sair da fila, ou o próximo a chegar
 * seria mandado para uma sala vazia cujo dono já fechou o navegador — e ficaria
 * esperando ali dentro achando que está na fila. Sessenta segundos é mais que o
 * tempo de o cliente abrir a conexão e mandar o `hello`.
 */
const WAITING_TTL_MS = 60_000;

export class Matchmaker implements DurableObject {
  constructor(private readonly state: DurableObjectState) {}

  async fetch(): Promise<Response> {
    const waiting = await this.state.storage.get<Waiting>('waiting');
    const now = Date.now();

    // Havia alguém esperando, e a vaga ainda vale: manda os dois para a mesma
    // sala e limpa a fila no mesmo passo — ninguém mais pode reclamar esta vaga
    // porque este objeto atende um pedido de cada vez.
    if (waiting && now - waiting.since < WAITING_TTL_MS) {
      await this.state.storage.delete('waiting');
      return Response.json({ code: waiting.code, waited: true });
    }

    const code = generateCode();
    await this.state.storage.put('waiting', { code, since: now } satisfies Waiting);
    return Response.json({ code, waited: false });
  }
}
