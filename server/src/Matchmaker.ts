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
 *
 * ## Duas rotas
 *
 * | rota | quem chama | o que faz |
 * |---|---|---|
 * | `/claim` | o Worker, quando alguém entra na fila | devolve a sala de quem esperava, ou abre uma |
 * | `/release?code=` | a sala, quando fica vazia | tira aquela sala da fila |
 *
 * A segunda existe porque uma vaga que ninguém ocupa precisa sair da fila **no
 * instante em que o dono dela desiste**, e não quando um prazo vence. Ver
 * `WAITING_TTL_MS`.
 */

import { generateCode } from './codes';

interface Waiting {
  code: string;
  since: number;
}

/**
 * Prazo de validade de uma vaga na fila.
 *
 * ⚠️ **Dez minutos, e já foram sessenta segundos** — o que quebrava a fila
 * inteira no caso mais comum que ela tem: dois amigos combinando de jogar.
 *
 * O primeiro clica em "partida rápida", o objeto abre a sala `X` e o guarda como
 * quem espera. O segundo clica um minuto e meio depois, quando `X` já venceu — e
 * em vez de entrar em `X`, ele **abre a sala `Y`** e passa a esperar nela. Os
 * dois ficam sentados em salas diferentes, para sempre, cada um vendo a mesma
 * tela de "procurando adversário". E não há nada que os junte depois: quem
 * chegou primeiro não está mais na fila, e quem chegou por último está numa vaga
 * nova que só o terceiro jogador reclamaria.
 *
 * Dez minutos é o mesmo prazo com que a sala se declara abandonada, o que faz os
 * dois relógios contarem a mesma história. E o prazo deixou de ser a defesa
 * principal contra vaga morta: hoje é `/release` que a tira da fila assim que
 * ela esvazia, e isto aqui é só a rede de segurança para o caso de a sala morrer
 * sem conseguir avisar.
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

  /** Alguém entrou na fila. */
  private async claim(): Promise<Response> {
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

  /**
   * Uma sala avisou que esvaziou.
   *
   * O `code` é conferido antes de apagar: entre a saída do jogador e a chegada
   * deste aviso, outra pessoa pode ter entrado na fila e tomado a vaga com um
   * código novo. Apagar sem olhar tiraria da fila alguém que acabou de entrar
   * nela, e o sintoma seria o mesmo defeito que este método existe para
   * consertar.
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
