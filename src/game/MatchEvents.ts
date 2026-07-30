/**
 * What happened in one simulation step, for whoever has to react afterwards.
 *
 * ## Why a queue and not direct calls
 *
 * `Match.fixedUpdate` used to call `effects.muzzleBlast` and `listener.onShot` from
 * inside the step. It worked, and it brought three problems at once:
 *
 * 1. **It dirtied the step.** `Effects` draws each particle's rotation with
 *    `Math.random()`, so the "deterministic" step consumed unseeded randomness. It
 *    broke nothing while the game was single-player, and it would break everything the
 *    instant two machines had to agree.
 * 2. **It doubled the work at 144 fps.** One frame can contain up to five steps, and
 *    each of them fired its own smoke — the trail got denser with the frame rate.
 * 3. **It did not cross the network.** A bang is an instant, not a state: it does not
 *    fit in a snapshot, and without a queue there was nothing to send.
 *
 * With the queue, the simulating side only **notes things down**. Whoever draws and
 * whoever plays sound drain it afterwards, on the frame. And the client that receives
 * these same events over the network stacks them into the same array and calls the
 * same code as ever — one path, two roles.
 *
 * ⚠️ The vectors are **the step's scratch values**: the queue is emptied on every
 * `update`, and whoever wants to keep one of them copies it.
 */

import type * as THREE from 'three';

/** Index of the ship in the match. 0 is always the local player's. */
export type ShipSlot = 0 | 1;

export type MatchEvent =
  /** A cannon spat. `position` and `direction` are the muzzle at the instant of the shot. */
  | {
      kind: 'shot';
      ship: ShipSlot;
      position: THREE.Vector3;
      direction: THREE.Vector3;
    }
  /** Ball into the water. */
  | { kind: 'splash'; position: THREE.Vector3; speed: number }
  /** Ball into the wood. `flooded` when the breach ends up below the waterline. */
  | {
      kind: 'hull';
      ship: ShipSlot;
      position: THREE.Vector3;
      /** Hull normal at the point, **in world coordinates**. */
      normal: THREE.Vector3;
      speed: number;
      flooded: boolean;
    }
  /** Ball into the mast. */
  | { kind: 'mast'; ship: ShipSlot; position: THREE.Vector3; speed: number }
  /** The two hulls touched. */
  | { kind: 'collision'; position: THREE.Vector3; speed: number };
