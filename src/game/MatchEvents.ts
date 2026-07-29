/**
 * O que aconteceu num passo de simulação, para quem precisa reagir depois.
 *
 * ## Por que uma fila e não as chamadas diretas
 *
 * Antes, `Match.fixedUpdate` chamava `effects.muzzleBlast` e `listener.onShot`
 * de dentro do passo. Funcionava, e trazia três problemas de uma vez:
 *
 * 1. **Sujava o passo.** `Effects` sorteia a rotação de cada partícula com
 *    `Math.random()`, então o passo "determinístico" consumia aleatoriedade não
 *    semeada. Não quebrava nada enquanto o jogo era de um jogador só, e quebraria
 *    tudo no instante em que duas máquinas tivessem de concordar.
 * 2. **Dobrava o trabalho a 144 fps.** Um quadro pode conter até cinco passos, e
 *    cada um deles disparava a sua fumaça — o rastro ficava mais denso conforme a
 *    taxa de quadros.
 * 3. **Não atravessava a rede.** Um estrondo é um instante, não um estado: ele não
 *    cabe num instantâneo, e sem fila não havia o que enviar.
 *
 * Com a fila, quem simula só **anota**. Quem desenha e quem toca drenam depois, no
 * quadro. E o cliente que recebe estes mesmos eventos pela rede os empilha no mesmo
 * array e chama o mesmo código de sempre — um caminho, dois papéis.
 *
 * ⚠️ Os vetores são **rascunhos do passo**: a fila é esvaziada em todo `update`, e
 * quem quiser guardar um deles copia.
 */

import type * as THREE from 'three';

/** Índice do navio na partida. 0 é sempre o do jogador local. */
export type ShipSlot = 0 | 1;

export type MatchEvent =
  /** Um canhão cuspiu. `position` e `direction` são a boca no instante do tiro. */
  | {
      kind: 'shot';
      ship: ShipSlot;
      position: THREE.Vector3;
      direction: THREE.Vector3;
    }
  /** Bala na água. */
  | { kind: 'splash'; position: THREE.Vector3; speed: number }
  /** Bala na madeira. `flooded` quando o rombo fica abaixo da linha d'água. */
  | {
      kind: 'hull';
      ship: ShipSlot;
      position: THREE.Vector3;
      /** Normal do casco no ponto, **em coordenadas do mundo**. */
      normal: THREE.Vector3;
      speed: number;
      flooded: boolean;
    }
  /** Bala no mastro. */
  | { kind: 'mast'; ship: ShipSlot; position: THREE.Vector3; speed: number }
  /** Os dois cascos se encostaram. */
  | { kind: 'collision'; position: THREE.Vector3; speed: number };
