/**
 * A pair of hands aboard: the body, the interaction focus and the ship they belong to.
 *
 * It exists because the match now has **two**. While the enemy was the machine,
 * `PlayerController` and `Interaction` could live loose in the `Match` — there was one
 * of each, and they were the player's. With a human on the other side, the enemy ship
 * needs an identical sailor: same body, same list of parts, same rules. Putting them
 * together here is what makes "the other player" a second instance instead of a second
 * code path.
 *
 * `ShipAI` is still the alternative: it writes **exactly** the same vocabulary
 * (`controls.wheel`, `cannon.aim`, `ship.loadCannon`, `ship.patchBreach`), and `Ship`
 * never finds out who is at the controls.
 */

import type { InputFrame } from '../core/InputFrame';
import { Interaction, createShipInteractables } from '../player/Interaction';
import { PlayerController } from '../player/PlayerController';
import type { Ship } from '../ship/Ship';
import type { WaveField } from '../world/WaveField';

export class Crewman {
  readonly controller = new PlayerController();
  readonly interaction = new Interaction();

  constructor(readonly ship: Ship) {
    this.respawn();
  }

  /** Puts the sailor at the starting point and rebuilds their ship's list of parts. */
  respawn(): void {
    this.controller.spawn();
    this.interaction.clear();
    for (const item of createShipInteractables(this.ship, this.controller)) {
      this.interaction.add(item);
    }
  }

  /**
   * One step of the sailor.
   *
   * ⚠️ **The order of the three calls is significant and is documented in all three
   * places that depend on it.** The controller comes first because it is what zeroes
   * the ship's commands on every step; the interaction comes next because the capstan
   * switches on the flag the controller has just zeroed — and because it is what keeps
   * the same tap from entering and leaving the mode. The plank's clock comes last as a
   * matter of who knows what: the controller knows nothing about breaches, and only
   * the interaction sees the hole and the held button on the same step. Advancing it
   * would give wood that appears in the hand one step before the player presses.
   *
   * @param waves the sea. It reaches this far for one reason only, and it comes from
   *   outside the ship: the sailor can **fall into the water**, and the only thing
   *   that decides whether they are in it is the height of the wave under their feet.
   *   See `PlayerController.fixedUpdate`.
   */
  fixedUpdate(dt: number, frame: InputFrame, waves: WaveField): void {
    this.controller.fixedUpdate(dt, frame, this.ship, waves);
    this.interaction.update(dt, frame, this.controller);
    this.controller.carry.update(dt, this.interaction.patching);
  }
}
