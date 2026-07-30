/**
 * The three enemy captains, and exactly what changes between them.
 *
 * **The rule this file respects:** difficulty touches *skill*, never physics and never
 * crew. All three ships have the same hull, the same canvas, the same two guns and the
 * same crew of two. What changes is how much the gunner's hand shakes, how far off he
 * is on the target's lead, how long the captain takes to notice the situation has
 * turned and at what distance he decides to open fire. None of them gains firing range,
 * hull speed or an extra bilge pump.
 *
 * That matters for two reasons. The first is that difficulty which raises physics
 * numbers becomes a ship the player cannot read: they see the enemy turn faster than
 * their own boat can and conclude the game cheats — and they would be right. The second
 * is that skill produces errors *of the right kind*: the deckhand does not miss by dice
 * roll, he misses **late and short**, which is how a new hand really misses on a gun.
 *
 * ## Where the aiming numbers come from
 *
 * `aimSigma` is the standard deviation of the angular error per shot. The conversion to
 * meters at the target is direct: `deviation ≈ sigma × range`. The Sloop is 16 m long
 * with ~2.6 m of side exposed above the waterline, so at 80 m:
 *
 * | captain  | sigma     | deviation at 80 m | reading                              |
 * |----------|-----------|-------------------|--------------------------------------|
 * | deckhand | 0.050 rad | ±4.0 m            | hits the hull about 1 shot in 3      |
 * | corsair  | 0.018 rad | ±1.4 m            | almost always hits, misses on the wave |
 * | legend   | 0.007 rad | ±0.56 m           | chooses *where* on the hull to hit   |
 *
 * `leadFraction` is the fraction of the target's velocity the gunner manages to
 * anticipate. Below 1 he **shoots behind** a ship that crosses — the classic error of
 * somebody learning, and what gives the player a chance to escape by accelerating.
 *
 * ## The axis that was missing: what he does with his own ship
 *
 * The three captains were born with three gunnery skills and one of command, and **none
 * of damage control** — all three repaired the hull exactly the same, and exactly well.
 * Measured, that meant eight breaches at the waterline became a watertight hull in
 * twenty-five seconds at any difficulty. A player who hit more gained nothing from it,
 * which is the opposite of what a naval combat game should teach.
 *
 * `holdShift`, `gunShift` and `triage` are the axis that was missing, and it measures
 * the same thing as the others: **judgment**. How long leaving the gun is worth it, when
 * to come back to it, and which of the holes deserves the plank in hand. There is still
 * no extra man and no better pump — the Legend enemy saves its ship because it decides
 * better, not because it works faster.
 */

export type DifficultyId = 'recruit' | 'corsair' | 'legend';

export interface DifficultyPreset {
  readonly id: DifficultyId;
  /** The name shown in the menu. */
  readonly label: string;
  /** One line telling the player what they are getting into. */
  readonly blurb: string;

  // --- gunnery ---------------------------------------------------------------
  /** Standard deviation of the aiming error, in radians, drawn on every load. */
  readonly aimSigma: number;
  /**
   * Fraction of the target's velocity the gunner takes into account. 1 is perfect
   * lead; below that he shoots behind a target that crosses.
   */
  readonly leadFraction: number;
  /**
   * Rounds of the fixed-point iteration in `solveIntercept`.
   *
   * A single round already leads the azimuth, but it computes the time of flight to
   * where the target *is* instead of to where it is going to be — an error that grows
   * with distance, which is exactly where the difference between the captains should
   * weigh.
   */
  readonly leadIterations: number;
  /** Maximum range at which the gun opens fire, in meters. */
  readonly engageRange: number;
  /**
   * Angular tolerance for releasing the shot, in radians.
   *
   * Tight, the gunner waits for the roll to bring the barrel exactly onto the target;
   * loose, he fires almost at will. It is precision's second axis, and the most
   * visible: a bad captain shoots **at the wrong moment**, not only crooked.
   */
  readonly fireTolerance: number;

  // --- command ---------------------------------------------------------------
  /** Seconds until the captain reacts to a change in the tactical situation. */
  readonly reaction: number;
  /** The helmsman's gain over the heading error. */
  readonly helmGain: number;
  /** Beam distance the captain tries to keep, in meters. */
  readonly standoff: number;

  // --- crew ------------------------------------------------------------------
  /** Multiplier on the time the sailor takes to change post. */
  readonly transitScale: number;
  /**
   * Flooding fraction that sends the sailor off the gun and down into the hold.
   *
   * The deckhand lets the water rise too far before acting — and that is how a sloop
   * is lost. The legend goes below at the first breach under the waterline.
   */
  readonly floodAlarm: number;
  /**
   * Seconds of work the sailor delivers per trip down into the hold.
   *
   * **It is the number that decides whether the enemy ship can be sunk.** It counts
   * from arriving down there — the stair has already been paid for in `transitScale` —
   * and when it runs out the sailor goes up to the gun with the hull in whatever state
   * it is in.
   *
   * One shift covers one walk and a plank and a half, so the enemy leaves the hold with
   * holes open and goes back to firing anyway. It is not carelessness: it is the bet
   * that it can sink the other one first, and it is the same bet the player makes every
   * time they decide to take one more shot instead of going below.
   *
   * The shift does **not** apply when the hold goes past `BREAK_OFF_FLOOD` — then the
   * captain has broken contact and saving the ship has become the only task. See
   * `ShipAI.assignCrew`.
   */
  readonly holdShift: number;
  /**
   * Seconds he owes the gun before he can go below again.
   *
   * `holdShift`'s partner, and it is what gives the breathing room: between two trips
   * below there is an interval in which the enemy is firing and the water is rising.
   * Without this interval the sailor would go back down on the step after coming up,
   * and the rotation would become the continuous repair it came to replace.
   */
  readonly gunShift: number;
  /**
   * How well he picks **which** breach to patch. See `Crew.pickBreach`.
   *
   * It is the exponent of a draw weighted by each hole's inflow. Near zero, the choice
   * is blind; high, he almost always finds the one sinking the ship fastest. It is the
   * skill axis that was missing: until now all three captains had the same triage, and
   * it was perfect.
   */
  readonly triage: number;
  /**
   * Fraction of the hold he **accepts leaving inside the ship**, 0..1.
   *
   * The pump is the same on both sides and moves the same 750 L/s — what changes is how
   * long somebody stays on it. Until now the enemy sailor pumped until the hold was
   * empty, always, and the effect was a hull that went back to being new between one
   * salvo and the next: the water the player put in there accumulated nothing over the
   * course of the duel.
   *
   * With a floor, it accumulates. He pumps to the level he judges acceptable, lets go
   * of the handle and goes up to the gun — and the duel starts being played by a ship
   * that carries the damage from the previous exchanges. It is the same decision as the
   * hold shift (`holdShift`), applied to the water instead of to the wood, and it is the
   * same kind of error: the Deckhand tolerates a quarter of the hold full and pays
   * dearly at the first fresh breach.
   *
   * **It is also the number that brings him back into the fight**, and there is no
   * second threshold for that: the hold he considers good enough to let go of the pump
   * is the same one he considers good enough to go back to firing. See
   * `ShipAI.desiredIntent`, and the note on why two numbers here would fight.
   */
  readonly bilgeFloor: number;
}

export const DIFFICULTIES: Record<DifficultyId, DifficultyPreset> = {
  recruit: {
    id: 'recruit',
    label: 'Deckhand',
    blurb: 'Shoots behind a moving target and is slow to patch holes. Learn the sea on them.',
    aimSigma: 0.05,
    leadFraction: 0.55,
    leadIterations: 1,
    engageRange: 75,
    fireTolerance: 0.06,
    reaction: 1.2,
    helmGain: 0.75,
    // He gets too close and sometimes fouls himself: part of the charm of fighting
    // him.
    standoff: 48,
    transitScale: 1.6,
    floodAlarm: 0.3,
    holdShift: 8,
    gunShift: 30,
    triage: 0.6,
    bilgeFloor: 0.24,
  },
  corsair: {
    id: 'corsair',
    label: 'Corsair',
    blurb: 'Holds the broadside and wastes no shot. The honest duel.',
    aimSigma: 0.018,
    leadFraction: 0.9,
    leadIterations: 2,
    engageRange: 115,
    fireTolerance: 0.022,
    reaction: 0.55,
    helmGain: 1,
    standoff: 68,
    transitScale: 1.15,
    floodAlarm: 0.18,
    holdShift: 11,
    gunShift: 22,
    triage: 2,
    bilgeFloor: 0.15,
  },
  legend: {
    id: 'legend',
    label: 'Legend',
    blurb: 'Picks which plank to hole. You will learn by sinking.',
    aimSigma: 0.007,
    leadFraction: 1,
    leadIterations: 3,
    engageRange: 155,
    fireTolerance: 0.009,
    reaction: 0.22,
    helmGain: 1.25,
    standoff: 76,
    transitScale: 0.9,
    // Up from 0.08 since the shift has existed: with the alarm at the first hand's
    // breadth of water it would go below every minute for a finger of hold, and the
    // rotation would make the Legend **fire less** than the Corsair. Skill is knowing
    // when to leave the gun, and the right moment is not at the first splash.
    floodAlarm: 0.12,
    holdShift: 14,
    gunShift: 18,
    triage: 5,
    bilgeFloor: 0.08,
  },
};

/** Order the presets appear in the menu. */
export const DIFFICULTY_ORDER: readonly DifficultyId[] = ['recruit', 'corsair', 'legend'];
