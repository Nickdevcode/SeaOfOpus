/**
 * The enemy crew: two men, and therefore a problem of choice.
 *
 * **The most important design decision in the whole AI lives here.** The easy path
 * would be to give the bot a single mind able to steer, lay both guns and nail planks
 * all at once. That produces an enemy the player cannot fight: it never stops firing,
 * never lowers its guard, and the only thing the player learns is that the game
 * cheats.
 *
 * So the enemy Sloop is crewed the way the Sea of Thieves Sloop is: **by two**. One
 * stays at the helm from start to finish. The other is one man, and one man is in
 * **one** place: at the starboard gun, at the port gun, or in the hold. Never in two.
 * And going from one to another costs the time to cross the deck or go down the
 * stair.
 *
 * Three good things fall out of that, and none of them had to be programmed as a
 * rule:
 *
 * - **The fight gets room to breathe.** When the enemy takes a breach, its fire
 *   stops. The player *sees* that happen and understands they hit — with no number on
 *   screen.
 * - **Switching sides has a price.** If the player crosses the enemy's stern and
 *   appears on the other side, the gunner has to cross the deck, and there is a real
 *   two-second window where only one of the ships is firing.
 * - **The symmetry stays honest.** A solo player cannot aim and pump at the same time
 *   either. The difference is that they get a helmsman for free — the wheel stays
 *   where it was left — and the enemy pays for its own with the second man.
 *
 * Difficulty does not add people. It changes how quick the sailor is, how much water
 * he lets in before leaving the gun, how much hold time he judges the fight allows
 * and how well he picks the right hole — see `Difficulty`.
 *
 * ## The hold is sixteen meters long, and he walks them
 *
 * The previous version of this file had a cheat hidden in one line: the sailor picked
 * the breach with the highest inflow and **started nailing right away**. Without
 * walking to it, without searching, without letting go of the pump. Measured against
 * eight breaches opened at the waterline, the whole hull was watertight again in 25 s
 * — and the player, who has to go down the stair, cross the hold stooped, find the
 * hole in the dark and aim at it before holding the button, saw that and rightly
 * concluded there was no way to sink that ship.
 *
 * Now the sailor occupies a position in the hold and moves between jobs at 1.15 m/s.
 * A breach in the bow costs eight seconds of walking before the first hammer blow,
 * and going back to the pump costs as many again. **The arithmetic that decides the
 * duel became the same on both sides: is there time to patch that hole before the
 * next salvo arrives?**
 *
 * And he picks the wrong hole. See `pickBreach`.
 */

import * as THREE from 'three';
import { HOLD_FLOOR_Y, STAIR_BOTTOM_Z } from '../ship/ShipDimensions';
import { BILGE_PUMP } from '../ship/ShipParts';
import type { Breach } from '../ship/ShipDamage';
import type { Ship } from '../ship/Ship';
import type { DifficultyPreset } from './Difficulty';

/** Where the only free pair of hands can be. */
export type CrewPost = 'starboard' | 'port' | 'hold';

/**
 * Seconds to cross the deck from one gun to the other.
 *
 * The guns sit ~4 m apart, with the mast and the hatch in the way: you do not cut
 * straight across. 2.2 s is the detour at a hurried pace.
 */
const CROSS_DECK = 2.2;

/**
 * Seconds from the deck to the hold, or back.
 *
 * Walking to the hatch and going down 1.85 m of stair at 1.9 m/s. It is deliberately
 * the most expensive transit on the ship: going below to patch a breach is a
 * commitment, not a break.
 */
const DECK_TO_HOLD = 4.2;

/**
 * Movement speed **inside** the hold, in m/s.
 *
 * Well below the deck's pace (2.8 m/s) and not for lack of skill: the headroom there
 * is 1.85 m, the floor has framing across it, and whoever moves is carrying a 1.15 m
 * plank under one arm with water up to their shins. 1.15 m/s is the short stride of
 * somebody walking stooped — crossing the hull's 16 m costs fourteen seconds.
 */
const HOLD_WALK_SPEED = 1.15;

/**
 * Where he sets foot on the way down — and where the planks are.
 *
 * The two things at the same point is not saving on a constant: the repair lumber
 * comes down through the hatch and is stacked at the foot of the flight, which is the
 * only place in the hold it fits without blocking the corridor. Every plank comes
 * from there, and that is why he comes back here between one breach and the next —
 * see `goToBreach`.
 */
const HOLD_LANDING = new THREE.Vector3(0, HOLD_FLOOR_Y, STAIR_BOTTOM_Z);

/** The pump's handle, which is also a place you go to. */
const PUMP_STATION = new THREE.Vector3(BILGE_PUMP.x, HOLD_FLOOR_Y, BILGE_PUMP.z);

/**
 * Minimum weight of a breach that is not drinking yet, in the triage.
 *
 * A hole above the waterline does not spout, and that is exactly why it enters the
 * draw: the hurried sailor sees it as a hole in the hull and nails the plank there,
 * spending five seconds on damage that was sinking nobody. Zeroing the weight would
 * make the AI right every time — and being right every time is the defect this
 * function came to fix.
 */
const DRY_BREACH_WEIGHT = 0.15;

export class Crew {
  /** Where the sailor is (or where he is heading, if `transit > 0`). */
  post: CrewPost = 'starboard';

  /** Seconds left for him to arrive. Zero is "working". */
  transit = 0;

  /**
   * The breach he has been assigned to, or `null`.
   *
   * It does not mean the plank is on the wood yet: while `reaching` is greater than
   * zero he is still crossing the hold to get there.
   */
  patching: Breach | null = null;

  /** `true` on the step he is actually at the pump. */
  pumping = false;

  /**
   * Where he is in the hold, in the ship's local coordinates.
   *
   * It only means anything while the post is `hold`; on going down, he reappears at
   * the foot of the flight. It is what each job's walking time comes from.
   */
  private readonly spot = new THREE.Vector3().copy(HOLD_LANDING);
  /** The job he is heading to, while `walk > 0`. */
  private readonly destination = new THREE.Vector3().copy(HOLD_LANDING);
  /** Seconds left for him to reach the chosen job. */
  private walk = 0;
  /** `true` when the chosen job is the pump, and not a breach. */
  private onPump = false;

  constructor(
    private readonly preset: DifficultyPreset,
    /**
     * The breach triage's draw. It comes from outside, and from the match's own seed,
     * so a duel stays reproducible end to end — see `ShipAI`.
     */
    private readonly random: () => number,
  ) {}

  /** `true` when he has arrived at the post and is producing work. */
  get onStation(): boolean {
    return this.transit <= 0;
  }

  /**
   * Seconds left for him to reach the job **inside** the hold. Telemetry.
   *
   * Different from `transit`, which is the time to go from one post to another: this
   * is the walk to the plank and to the hole, and it is what makes the enemy's repair
   * cost the same kind of time it costs the player.
   */
  get reaching(): number {
    return Math.max(this.walk, 0);
  }

  /**
   * Sends the sailor to a post. Repeating the order for the current post does
   * nothing — otherwise he would restart the walk on every physics step and never
   * arrive.
   */
  orderTo(post: CrewPost): void {
    if (post === this.post) return;

    const below = post === 'hold' || this.post === 'hold';
    this.transit = (below ? DECK_TO_HOLD : CROSS_DECK) * this.preset.transitScale;
    this.post = post;
    // He dropped the plank halfway through the repair: the breach's progress stays
    // where it was (it is the breach's state, not the sailor's), but he loses his aim
    // at it.
    this.patching = null;
    this.onPump = false;

    // Whoever goes down reappears at the foot of the flight, and the last shift's job
    // does not count: keeping the position between descents would give the enemy a
    // sailor who teleports back to where he stopped, which is exactly what this file
    // stopped doing.
    if (post === 'hold') {
      this.spot.copy(HOLD_LANDING);
      this.destination.copy(HOLD_LANDING);
      this.walk = 0;
    }
  }

  /** Index in `ship.cannons` of the current post, or −1 if he is in the hold. */
  get cannonIndex(): number {
    if (!this.onStation) return -1;
    // `[0]` is starboard and `[1]` port — the order `ShipBuilder` assembles.
    if (this.post === 'starboard') return 0;
    if (this.post === 'port') return 1;
    return -1;
  }

  /**
   * One step of work. It only does anything when the post is the hold: at the gun,
   * what works is the `Gunner`.
   */
  fixedUpdate(dt: number, ship: Ship): void {
    this.pumping = false;

    if (this.transit > 0) {
      this.transit -= dt;
      this.patching = null;
      return;
    }

    if (this.post !== 'hold') {
      this.patching = null;
      this.onPump = false;
      return;
    }

    this.chooseWork(ship);

    // Still crossing the hold to the chosen job: walking is work, but it is not work
    // that closes any hole.
    if (this.walk > 0) {
      this.walk -= dt;
      if (this.walk > 0) return;
      this.spot.copy(this.destination);
    }

    if (this.patching) {
      // One plank at a time, on the breach he chose when he got here.
      if (ship.patchBreach(this.patching, dt)) this.patching = null;
      return;
    }

    // Hull closed and there is still water above what he tolerates: now the pump is
    // the answer. The order is not taste, it is arithmetic: patching a breach costs
    // 2.4 s and holds forever, while pumping with a hole open is work the water undoes
    // behind you — and from six submerged holes on, the inflow beats the pump's rate
    // and the hold rises while you pump. See `PUMP_RATE` and `MAX_JET_SPEED` in
    // `ShipDamage`.
    //
    // **The floor is what makes the damage accumulate.** He lets go of the handle at
    // the level his captain accepts taking back into the fight, and not with the hold
    // dry: a ship that empties completely between two salvos undoes on its own
    // everything the player managed to put inside it. See `bilgeFloor` in
    // `Difficulty`.
    if (ship.damage.floodFraction > this.preset.bilgeFloor) {
      ship.controls.pumping = true;
      this.pumping = true;
    }
  }

  /** Back to the starting post for a fresh match. */
  reset(): void {
    this.post = 'starboard';
    this.transit = 0;
    this.patching = null;
    this.pumping = false;
    this.onPump = false;
    this.walk = 0;
    this.spot.copy(HOLD_LANDING);
    this.destination.copy(HOLD_LANDING);
  }

  /**
   * Decides the next job — and, almost always, decides **not to decide anything**.
   *
   * The "only reevaluate when the previous job is over" guard is what holds
   * `pickBreach`'s random triage up. Drawing on every physics step, the sailor would
   * pick a different breach sixty times a second and spend the whole match walking
   * back and forth across the hold without nailing a plank — the draw has to happen
   * once per job, the way a decision happens.
   *
   * The three doors to reevaluation are: the target breach left the list (it closed,
   * or a fresh ball turned it into something else), he is at the pump and a new hole
   * has appeared to patch, or there is no job in progress at all.
   */
  private chooseWork(ship: Ship): void {
    if (this.patching) {
      if (ship.damage.breaches.includes(this.patching)) return;
      this.patching = null;
    } else if (this.onPump) {
      // Pumping with the hull open is work the water undoes behind you; a new hole
      // beats the handle. With no plank in the magazine, though, the pump is the only
      // thing that still works — and insisting on the breach would leave the enemy
      // standing in front of a hole, sinking on its own.
      if (!ship.hasPlanks || ship.damage.breaches.length === 0) return;
      this.onPump = false;
    }

    const breach = ship.hasPlanks ? this.pickBreach(ship) : null;
    this.patching = breach;
    this.onPump = breach === null;

    if (breach) this.goToBreach(breach);
    else this.goTo(PUMP_STATION);
  }

  /**
   * Sends the sailor to patch a breach — **by way of the magazine to fetch the
   * plank**.
   *
   * It is one plank at a time, and they are stacked at the foot of the flight
   * (`HOLD_LANDING`). A man stooped in a 1.85 m hold does not carry four 1.15 m pieces
   * under one arm, so every hole costs the trip to the pile plus the trip to the hole
   * — and the way back is the next breach's way out, which is why this method does not
   * charge for it twice.
   *
   * **It is the cost that turned the arithmetic around.** Without it, the sailor
   * closed five breaches a minute and no plausible player hit rate could outrun him:
   * the enemy hull recovered on its own from any damage that was not instantaneous.
   * With the trip to the magazine, every breach costs close to nine seconds, and the
   * balance started tipping toward whoever is hitting.
   */
  private goToBreach(breach: Breach): void {
    const toLocker = planarDistance(this.spot, HOLD_LANDING);
    const toBreach = planarDistance(HOLD_LANDING, breach.local);
    this.destination.copy(breach.local);
    this.walk = (toLocker + toBreach) / HOLD_WALK_SPEED;
  }

  /** Sends the sailor to a point in the hold and charges the time to get there. */
  private goTo(target: THREE.Vector3): void {
    this.destination.copy(target);
    this.walk = planarDistance(this.spot, target) / HOLD_WALK_SPEED;
  }

  /**
   * The breach that gets the plank — and it is **not** always the right one.
   *
   * The previous version returned the one with the highest inflow, always, breaking
   * ties by depth. It is the optimal choice, and that is exactly why it was wrong: no
   * sailor has a per-hole inflow report. What he has is a dark hold, water up to his
   * knees and several holes spouting at once — he goes for whatever draws the most
   * attention, and sometimes that is not the one sinking the ship fastest.
   *
   * The draw is weighted by inflow, and the exponent is the skill (`triage`):
   *
   * | captain  | triage | drowned breach vs. dry breach |
   * |----------|--------|-------------------------------|
   * | deckhand | 0.6    | 3× more likely                |
   * | corsair  | 2.0    | 59× more likely               |
   * | legend   | 5.0    | 26,000× — almost always the worst |
   *
   * In other words: the Legend still gets the triage right nearly every time, and that
   * is what keeps its sharpness intact. The Deckhand regularly spends a plank on a
   * bulwark hole, which is how a real sloop gets lost.
   */
  private pickBreach(ship: Ship): Breach | null {
    const breaches = ship.damage.breaches;
    if (breaches.length === 0) return null;

    // The scale is the worst jet in the room, and not an absolute ceiling. A man in
    // the hold does not measure liters per second: he compares the holes he can see,
    // and what decides is which of them shouts loudest.
    let strongest = 0;
    for (const breach of breaches) strongest = Math.max(strongest, breach.inflow);

    let total = 0;
    for (const breach of breaches) total += this.attention(breach, strongest);
    if (total <= 0) return breaches[0] ?? null;

    // Roulette: one draw over the total and a sweep accumulating until it passes.
    let ticket = this.random() * total;
    for (const breach of breaches) {
      ticket -= this.attention(breach, strongest);
      if (ticket <= 0) return breach;
    }

    // It only gets here through rounding on the list's last breach.
    return breaches[breaches.length - 1] ?? null;
  }

  /**
   * How much a breach draws the attention of whoever is in the hold.
   *
   * @param strongest the highest inflow among the open breaches, which is the scale.
   *   With the hold dry it is zero and every hole ends up with the same weight — which
   *   is right: with no jet at all to compare, one hole is as visible as another.
   */
  private attention(breach: Breach, strongest: number): number {
    const jet = strongest > 1e-9 ? breach.inflow / strongest : 0;
    return Math.pow(jet + DRY_BREACH_WEIGHT, this.preset.triage);
  }
}

/**
 * Distance between two points in the hold measured **on the floor**.
 *
 * The vertical is deliberately left out: the breach can be down by the keel or high
 * on the planking, and the difference between crouching and reaching up is not what
 * costs time to somebody crossing a sixteen-meter hold.
 */
function planarDistance(a: THREE.Vector3, b: THREE.Vector3): number {
  return Math.hypot(b.x - a.x, b.z - a.z);
}
