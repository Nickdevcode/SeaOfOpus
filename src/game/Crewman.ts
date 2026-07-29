/**
 * Um par de mãos a bordo: o corpo, o foco de interação e o navio a que pertencem.
 *
 * Existe porque a partida passou a ter **dois**. Enquanto o inimigo era a máquina,
 * o `PlayerController` e a `Interaction` podiam viver soltos no `Match` — havia um
 * de cada, e eram do jogador. Com um humano do outro lado, o navio inimigo precisa
 * de um marujo igual: mesmo corpo, mesma lista de peças, mesmas regras. Juntá-los
 * aqui é o que torna "o outro jogador" uma segunda instância em vez de um segundo
 * caminho de código.
 *
 * O `ShipAI` continua sendo a alternativa: ele escreve **exatamente** o mesmo
 * vocabulário (`controls.wheel`, `cannon.aim`, `ship.loadCannon`,
 * `ship.patchBreach`), e o `Ship` nunca descobre quem está aos comandos.
 */

import type { InputFrame } from '../core/InputFrame';
import { Interaction, createShipInteractables } from '../player/Interaction';
import { PlayerController } from '../player/PlayerController';
import type { Ship } from '../ship/Ship';

export class Crewman {
  readonly controller = new PlayerController();
  readonly interaction = new Interaction();

  constructor(readonly ship: Ship) {
    this.respawn();
  }

  /** Põe o marujo no ponto de partida e refaz a lista de peças do navio dele. */
  respawn(): void {
    this.controller.spawn();
    this.interaction.clear();
    for (const item of createShipInteractables(this.ship, this.controller)) {
      this.interaction.add(item);
    }
  }

  /**
   * Um passo do marujo.
   *
   * ⚠️ **A ordem das três chamadas é significativa e está documentada nos três
   * lugares que dependem dela.** O controlador vem primeiro porque é ele que zera
   * os comandos do navio a cada passo; a interação vem em seguida porque o
   * cabrestante liga a bandeira que o controlador acabou de zerar — e porque é o
   * que impede o mesmo toque de entrar e sair do modo. O relógio da tábua vem por
   * último por uma questão de quem sabe o quê: o controlador não conhece rombos, e
   * só a interação vê o buraco e o botão segurado no mesmo passo. Adiantá-lo daria
   * uma madeira que aparece na mão um passo antes de o jogador apertar.
   */
  fixedUpdate(dt: number, frame: InputFrame): void {
    this.controller.fixedUpdate(dt, frame, this.ship);
    this.interaction.update(dt, frame, this.controller);
    this.controller.carry.update(dt, this.interaction.patching);
  }
}
