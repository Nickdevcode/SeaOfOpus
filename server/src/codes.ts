/**
 * Room codes.
 *
 * Four slots from a 32-character alphabet give 1,048,576 rooms. That is not many, and it
 * does not need to be: the code only has to be unique **among the rooms open right now**,
 * which on a personal project's queue is a handful. What it really has to do is fit into
 * something dictated out loud — hence the alphabet with no `I`, `O`, `0` or `1`.
 */

import { CODE_ALPHABET, CODE_LENGTH } from '../../shared/protocol';

/**
 * Draws a code.
 *
 * `crypto.getRandomValues` instead of `Math.random` for a practical reason, not a
 * security one: a room code is guessable by nature (it is only four slots), but a
 * predictable generator would let anyone enumerate the rooms open at the moment instead
 * of having to try a million times.
 *
 * Rejecting samples above `limit` removes the modulo bias: 256 is not a multiple of
 * 32... actually it is, but the guard stays because the alphabet can change size, and on
 * that day the bias would show up in silence.
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
