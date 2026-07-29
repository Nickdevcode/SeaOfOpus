/**
 * Códigos de sala.
 *
 * Quatro casas de um alfabeto de 32 dão 1.048.576 salas. Não é muito, e não
 * precisa ser: o código só tem de ser único **entre as salas abertas agora**, que
 * numa fila de projeto pessoal são unidades. O que ele precisa mesmo é caber num
 * ditado por voz — daí o alfabeto sem `I`, `O`, `0` e `1`.
 */

import { CODE_ALPHABET, CODE_LENGTH } from '../../shared/protocol';

/**
 * Sorteia um código.
 *
 * `crypto.getRandomValues` em vez de `Math.random` por um motivo prático, não de
 * segurança: um código de sala é adivinhável por natureza (são só quatro casas),
 * mas um gerador previsível deixaria qualquer um enumerar as salas abertas no
 * momento em vez de ter de tentar um milhão de vezes.
 *
 * A rejeição de amostras acima de `limit` tira o viés do módulo: 256 não é
 * múltiplo de 32... na verdade é, mas a guarda fica porque o alfabeto pode mudar
 * de tamanho, e nesse dia o viés apareceria em silêncio.
 */
export function generateCode(): string {
  const size = CODE_ALPHABET.length;
  const limit = Math.floor(256 / size) * size;
  const bytes = new Uint8Array(CODE_LENGTH * 2);
  let code = '';

  while (code.length < CODE_LENGTH) {
    crypto.getRandomValues(bytes);
    for (const byte of bytes) {
      if (byte >= limit) continue;
      code += CODE_ALPHABET[byte % size];
      if (code.length === CODE_LENGTH) break;
    }
  }

  return code;
}
