/**
 * Breaches, flooding and sinking.
 *
 * The model is Sea of Thieves read through real physics, and what makes it
 * interesting is that **nothing here is a health bar**. A shot opens a hole at a
 * position on the hull; water comes in through it at the flow rate the pressure
 * difference dictates; the weight of that water makes the ship sit deeper; sitting
 * deeper, more holes go under and the flow rate grows. The ship sinks when nobody
 * holds that feedback loop back — not when a counter reaches zero.
 *
 * **Free surface.** The hold water is treated as a volume whose top is
 * *horizontal in world space*, not as dead weight at the center of the ship. As
 * the ship heels, it runs to the low side and the weight goes with it, which heels
 * it further. That's the free surface effect, the same one that capsizes real
 * ships with a half-full hold, and it falls out for free from treating the water
 * as a volume instead of a number.
 *
 * The math uses the same column structure as `Buoyancy`, only turned inward:
 * there the columns measure how much hull is under water, here they measure how
 * much water is inside the hull. Both read the same station table.
 *
 * **Deliberately left out:** the bucket. Bailing needs an item in hand, and the
 * scope of this delivery has no inventory — the bilge pump does the same job with
 * `F` held down, which is the verb the rest of the ship already uses.
 */

import * as THREE from 'three';
import { MAX_BREACHES } from '../../shared/protocol';
import { GRAVITY, WATER_DENSITY, clamp, clamp01 } from '../core/MathUtils';
import type { ShipBody } from './ShipBody';
import {
  DECK_Y,
  HALF_LENGTH,
  HOLD_FLOOR_Y,
  HULL_LENGTH,
  ceilingY,
  hullSurfaceNormal,
  hullSurfacePoint,
  innerHalfWidthAt,
  sampleSection,
  sectionV,
  tToZ,
  zToT,
  type HullSection,
} from './ShipDimensions';
import type { ShipHit } from '../combat/HitDetection';
import type { WaveField } from '../world/WaveField';

/** Hold stations along the length. */
const LENGTH_SAMPLES = 8;
/** Strips across the beam: port, center, starboard. */
const WIDTH_SAMPLES = 3;
/** Levels in the per-column volume table. */
const LEVELS = 24;
/** Quadrature sub-steps when building the table. */
const QUADRATURE = 6;

/**
 * Effective area of a cannonball breach, in m².
 *
 * A 10 cm ball doesn't open a 10 cm hole: it shatters the plank and takes away a
 * piece some 30 cm across. The number is the opening's, not the ball's, and it's
 * the one that sets the pace of the game — the water inflow rate comes out of it.
 */
const BREACH_AREA = 0.055;

/**
 * Discharge coefficient of a sharp-edged hole.
 *
 * The water coming in through a ragged hole doesn't use the whole area: the jet
 * contracts. 0.62 is the classic value for a thin-plate orifice, and it's what
 * turns "hole area" into real flow rate.
 */
const DISCHARGE_COEFFICIENT = 0.62;

/**
 * Maximum speed of the jet coming in through a breach, in m/s.
 *
 * Torricelli doesn't know a hull exists: with the ship already sinking, the water
 * column over the hole passes two meters and the jet would reach 6 m/s, which
 * turns the last second of the sinking into a step. This cap is the missing piece
 * of physics — the resistance of the water's own path through the framing — boiled
 * down to a number, and 3.81 m/s is the jet of a 74 cm column: above that, what
 * rules the flow rate is the path, not the pressure.
 *
 * The value is **not** chosen: it's the old cap (130 L/s) converted, that is,
 * `0.13 / (DISCHARGE_COEFFICIENT × BREACH_AREA)`. That way a freshly opened breach
 * delivers exactly the same water as before and nothing in the balance already
 * measured moves — all that changes is what happens when it **grows**. Getting
 * that conversion wrong (forgetting the discharge coefficient, say) drops the flow
 * rate of every submerged breach by 38% at once, and the symptom is a duel that
 * runs a minute longer for no apparent reason.
 *
 * **It was a flow rate cap (0.13 m³/s per breach) and became a speed cap, and the
 * difference decides the game.** Fixed per breach, it said that a hole twice the
 * size drinks the same as a small one — that is, that widening a breach is worth
 * nothing and only opening new holes counts. Telemetry showed the price of that:
 * eight hits concentrated within a handspan of hull side put 10% of water in the
 * hold, while the same eight spread along the hull **sank the ship**. Whoever
 * aimed better did ten times less damage.
 *
 * The framing's resistance is per *passage area*, not per hole: two holes side by
 * side are two paths, and so is one hole twice the size. Multiplied by the area,
 * the cap started saying that — and widening a breach is worth exactly what its
 * area says.
 */
const MAX_JET_SPEED = 3.81;

/** Seconds of `F` held down to nail a plank over the breach. */
const REPAIR_TIME = 2.4;

/**
 * Bilge pump flow rate, in m³/s.
 *
 * **This number was wrong by an order of magnitude.** It was 90 L/s — an honest
 * hand pump, and completely out of scale for an 81 m³ hold: it gave 0.11
 * percentage point per second, meaning the HUD counter only changed every nine
 * seconds of held button and the water sheet dropped 1.8 mm per second. The player
 * held it down, watched, and concluded — rightly — that the pump did nothing.
 * The bug wasn't in the code: it was in the arithmetic.
 *
 * 750 L/s is almost a percentage point per second, which gives half a minute to
 * dry out a hold at 30% and a hundred-odd seconds to empty it all. It's still
 * work, and patching after pumping is still a losing move: a new, well submerged
 * breach delivers up to 130 L/s (see `MAX_JET_SPEED`), so **six open holes still
 * fill faster than the pump empties** — and a widened breach counts as several.
 * What it gives is what it always should have: the chance to recover a ship that's
 * already patched before the fight is over.
 */
const PUMP_RATE = 0.75;

/**
 * Distance within which a new cannonball is absorbed by an existing breach.
 *
 * Without this, two balls in the same plank open two overlapping holes and the
 * hull gets twice the flow rate in an area that physically fits only one breach.
 *
 * **It stopped being a chosen number and now comes out of the breach itself.** It
 * was pinned at 90 cm — three and a half times the opening a shot makes — and that
 * is what made eight tightly grouped hits yield less than two breaches: the 16 m
 * hull side held only eleven distinct positions, and the aim of a player who
 * corrects his gunnery fits entirely inside one of them. Precision became
 * punishment.
 *
 * The opening of `BREACH_AREA` is a 26 cm circle. Two shots open the same hole
 * when their openings touch, and the 1.6 factor is the slack of cracked wood
 * between them — what's left of plank between two holes half a meter apart won't
 * hold water. Tied to the area, the day a breach's opening changes brings the
 * merge along with it.
 */
export const MERGE_DISTANCE = 2 * Math.sqrt(BREACH_AREA / Math.PI) * 1.6;

/**
 * Distance within which a shot tears off an already nailed plank.
 *
 * Larger than `MERGE_DISTANCE` because the plank is a 1.15 m piece laid across
 * the hole: a ball landing a meter from the center of the breach still catches
 * wood. Smaller than half its length because hitting the leftover tip shouldn't
 * open the hull again.
 */
const PATCH_DISTANCE = 1.1;

/**
 * Nailed planks a hull keeps at once.
 *
 * The same cap as the breach visuals, and for the same reason. Blowing past it
 * retires the oldest plank — which, in a match where twenty-four have already been
 * nailed, is on a piece of hull nobody is looking at.
 */
const MAX_PATCHES = 24;

/**
 * Open breaches a hull keeps at once.
 *
 * ⚠️ **This cap was missing, and its absence wasn't a visual detail: it was the
 * wire format.** See `MAX_BREACHES` in `shared/protocol` — that's where the number
 * comes from, because the wire is what rules it. And it wasn't a theoretical
 * limit: with `MERGE_DISTANCE` at 42 cm, a 16 m hull side holds far more distinct
 * positions than that.
 *
 * With the list full, a new shot **widens the nearest breach** instead of opening
 * one more. That's the right degradation: the hull goes on drinking more with
 * every hit (the flow rate is linear in the area — see `breachInflow`), and the
 * player doesn't lose the effect of the shot he landed.
 */
export { MAX_BREACHES };

/**
 * How much a breach can grow by absorbing further shots.
 *
 * Raised from 2.2 when the flow rate cap started scaling with the area
 * (`MAX_JET_SPEED`): while widening was worth nothing, the number made no
 * difference; now that it is worth something, it becomes the limit on how many
 * hits in the same handspan still count. At 3.2 that's four shots absorbed before
 * saturating (each one adds 0.6 of the base area) — from there on what the ball
 * tears out is framing, and hull with no frame isn't a breach anymore, it's a
 * different kind of damage, which this file doesn't model.
 */
const MAX_BREACH_SCALE = 3.2;

/**
 * Effective speed of the water taken on through a breach above the line, in m/s.
 *
 * It doesn't come from Torricelli — there's no water column to turn into speed.
 * It comes from the order of magnitude of what a crest carries as it sweeps the
 * hull side, and it was calibrated against the clock of the fight: with it, three
 * high breaches in a sea of half a meter of deviation fill the hold in about ten
 * minutes, and those same three with the ship already heeled (which is what
 * happens once water comes in) in far less. Too high, and a single grazing hit
 * sinks a sloop; too low, and it's back to what it was — holes that mean nothing.
 */
const SPRAY_SPEED = 1.6;

/**
 * Closing speed from which a ramming opens hull, in m/s.
 *
 * Below that the hulls touch, groan and drift apart — that's coming alongside, and
 * coming alongside doesn't tear out plank. 1.2 m/s is more than the sea pushes two
 * ships resting against each other in a normal swell, and less than any maneuver
 * where someone *chose* to go at the other. The separation matters: without it,
 * sticking to the enemy and letting the wave do the work would sink both for free.
 */
const RAM_SPEED = 1.2;

/**
 * How much extra speed one extra breach is worth, in m/s.
 *
 * The ladder comes out at 1.2 → one breach, 2.1 → two, 3.0 and above → three. A
 * sloop under full sail does some 5 m/s, so a deliberate charge delivers the cap
 * and a bump while maneuvering delivers a single hole. That's the reading the game
 * wants: you hit it, you broke it, and the harder you hit, the more you broke.
 */
const RAM_SPEED_STEP = 0.9;

/** Breaches a ramming opens per hull, at most. See `RAM_SPEED_STEP`. */
const RAM_BREACHES_MAX = 3;

/**
 * Distance between the breaches of one and the same ramming, along the hull side.
 *
 * It has to be larger than `MERGE_DISTANCE` (42 cm), or the three breaches the
 * impact opens turn into a single widened one — and a widened breach drinks less
 * than three separate ones, because widening saturates at `MAX_BREACH_SCALE`.
 * 90 cm gives twice the slack needed and still keeps the damage concentrated where
 * the hulls touched, which is where it has to be for the story to read on the hull
 * side.
 */
const RAM_SPREAD = 0.9;

/**
 * Fraction of the hold filled that counts as lost.
 *
 * It isn't 1: with the hold at 92% the water is already coming over the deck beam
 * and the ship doesn't come back. Waiting for the last percent would only delay
 * the end of the match.
 */
const FATAL_FLOOD = 0.92;

/** Seconds between "it is sinking" and "it sank", so the sinking gets watched. */
const SINK_DURATION = 7;

/**
 * Water shipped **above the hold** at the end of the sinking, in kg.
 *
 * Without this term the ship does not sink, and the arithmetic is worth doing: the
 * hull displaces ~37 t at the design waterline and something close to 74 t fully
 * submerged. With the hold full (~28 t of water) the total reaches 65 t — still
 * **less** than the buoyancy available. The ship would float with its sheer in the
 * water forever, and `sinkTime` would count seven seconds with nothing happening on
 * screen.
 *
 * What the physics is missing is not an invented push: it is that at 92% of the hold
 * the covering board is already in the water and the sea comes **over the deck**,
 * through the hatch and through the gunports. From there on it fills the whole hull,
 * not only the hold — and that is what this number represents. 45 t take the total to
 * ~110 t against 74 t of buoyancy, and the ship goes down with conviction.
 *
 * The weight is applied at the **center of mass**, and not at the centroid of the
 * hold's water. That is not laziness: 45 t on the 2 m lever arm the centroid reaches
 * would give 900 kN·m against the ~323 kN·m/rad of righting moment, meaning it would
 * capsize the ship in under a second. A real sinking does sometimes capsize, but here
 * the result on screen would be a hull rolling over like a toy. At the center of
 * mass, the heel still comes from the hold's free-surface effect, which is already
 * the right mechanism — only deeper with every second.
 */
const SWAMP_MASS = 45000;

/**
 * Inflow through a breach, in m³/s.
 *
 * Pure, and exported, because it is **the** calculation of the damage model: it is
 * what decides whether a hull holed in five places sinks or holds, and it is the only
 * thing in here you can prove in a test without assembling a ship. See
 * `tests/damage.ts`.
 *
 * The property it needs to have, and that it once lacked: **being linear in the
 * area.** A breach twice the size drinks twice as much, including after the jet
 * saturates — that is what makes two hits within a hand's breadth of planking worth
 * two hits.
 *
 * ## And the breach that sits **above** the waterline
 *
 * It drinks too, and the reason that became a rule is geometric. A hit opens a breach
 * at any point below the deck, which sits at `y = 1.3`; the waterline at rest runs
 * near `y = 0.05`. That is **1.25 m of dry topsides** against 85 cm of wet — and the
 * player aims at what they can see, which is exactly the dry part. The result was
 * measured on the F3 panel: four breaches added up between the two ships and
 * `inflow 0 L/s` on both, with the hold sitting at 2% after a whole engagement.
 * Hitting stopped having consequences, which is the opposite of what the damage model
 * exists to do.
 *
 * The way out is not to pretend the high hole is submerged: it is to recognize that
 * **the sea rises to it**. Planking holed half a meter above the water ships a wave
 * with every trough, and the heavier the sea, the more often. The arithmetic uses the
 * standard deviation of the wave field's own elevation as the scale — the same number
 * the HUD shows as `sigma` — so it ties into the weather: in a dead calm a high breach
 * barely drinks, and in a storm it drinks almost as if it were submerged. It becomes
 * one more reason to run from heavy seas with a holed hull, which is exactly the
 * decision this game wants to exist.
 *
 * @param area effective inlet area, in m².
 * @param depth water column above the breach, in meters. Negative is height above.
 * @param waveSigma standard deviation of the sea's elevation, in meters. Zero switches
 *   the wave shipping off and returns the pure submerged model — which is what the
 *   inflow tests want to measure.
 */
export function breachInflow(area: number, depth: number, waveSigma = 0): number {
  if (depth > 0) {
    // Torricelli, as far as the path through the framing allows. See `MAX_JET_SPEED`.
    const speed = Math.min(Math.sqrt(2 * GRAVITY * depth), MAX_JET_SPEED);
    return DISCHARGE_COEFFICIENT * area * speed;
  }

  if (waveSigma <= 1e-3) return 0;

  // Fraction of the time the crest reaches the breach. It is the tail of a normal
  // with standard deviation `waveSigma`, approximated by the gaussian itself: half a
  // sigma above the line it gives 88%, at one sigma 61%, at two sigma 14%, and it
  // vanishes. The approximation overshoots a little in the middle of the range and
  // errs on the generous side, which is the right side when the alternative is combat
  // with no consequences.
  const above = -depth / waveSigma;
  const wetness = Math.exp(-0.5 * above * above);
  return DISCHARGE_COEFFICIENT * area * SPRAY_SPEED * wetness;
}

export interface Breach {
  /** Center of the breach, in the ship's local coordinates. */
  readonly local: THREE.Vector3;
  /** Outward hull normal there — it orients the plank and the jet. */
  readonly normal: THREE.Vector3;
  /** Effective water inlet area, in m². */
  area: number;
  /** 0..1 of the repair in progress. It reaches 1 and the breach leaves the list. */
  repair: number;
  /** Inflow right now, in m³/s. The jet's visuals read from here. */
  inflow: number;
  /** Stable identifier, so the visuals match the breach between frames. */
  readonly id: number;
}

/**
 * A plank nailed over a breach that has already been closed.
 *
 * It does **no** physics at all: a patched breach leaves `breaches` and stops letting
 * water in, and that is what resolves the flooding. This exists so the hull has a
 * memory of the damage — the plank stays nailed where the hole was, and a fresh ball
 * in the same place tears it off and reopens the breach at the size it had.
 *
 * It is the same reading as Sea of Thieves: a ship at the end of a long fight is a
 * patchwork quilt, and the quilt tells the story better than any health bar.
 */
export interface Patch {
  /** Center of the patched breach, in the ship's local coordinates. */
  readonly local: THREE.Vector3;
  /** Outward hull normal there — the plank lies against it. */
  readonly normal: THREE.Vector3;
  /**
   * Area of the breach this plank closed, in m².
   *
   * Kept because it is what comes back when the plank is torn off: whoever patched a
   * breach widened by three balls does not start over from a small hole.
   */
  readonly area: number;
  /** Stable identifier, and the seed for drawing the plank's pose. */
  readonly id: number;
}

interface HoldColumn {
  /** Local X of the column's axis. */
  x: number;
  z: number;
  yFloor: number;
  yCeiling: number;
  /** Water volume (m³) with the surface at each level. */
  volume: Float32Array;
  centroidX: Float32Array;
  centroidY: Float32Array;
}

const _worldPoint = new THREE.Vector3();
const _centroid = new THREE.Vector3();
const _force = new THREE.Vector3();
const WORLD_UP = new THREE.Vector3(0, 1, 0);

/** Scratch values for the ramming breach. See `ShipDamage.ram`. */
const _ramSection: HullSection = { halfBeam: 0, keelY: 0, sheerY: 0, fullness: 1 };
const _ramHit: ShipHit = {
  fraction: 0,
  local: new THREE.Vector3(),
  normal: new THREE.Vector3(),
  part: 'hull',
  floods: true,
};

export class ShipDamage {
  readonly breaches: Breach[] = [];
  /** Nailed planks, from the oldest to the newest. See `Patch`. */
  readonly patches: Patch[] = [];

  /** Water in the hold, in m³. */
  floodVolume = 0;
  /** Total hold capacity, in m³. Measured from the geometry, not chosen. */
  readonly holdVolume: number;

  /**
   * Offset of the internal water plane in the local frame: the surface's points
   * satisfy `p · localUp = waterPlane`. Kept because the hold water's visuals draw
   * exactly this plane.
   */
  waterPlane = -Infinity;

  /** Seconds since the sinking started; `0` while the ship is alive. */
  sinkTime = 0;

  /** Switched on by whoever is at the pump this step. Zeroed every step. */
  pumping = false;

  /** Water above the deck during the sinking, in kg. See `SWAMP_MASS`. */
  private swampMass = 0;

  /**
   * Next breach identifier for **this hull**.
   *
   * It used to be a module-level counter, shared by both ships in the match — and
   * with a single counter, the ids each hull receives start depending on the order
   * the two were hit in. That breaks two things at once: the damage decal draws its
   * appearance from the id (`DamageView.hash01`), so the same shot drew a different
   * hole depending on what had happened on the other side; and, over the network, two
   * clients receiving the events in slightly different orders diverge forever. Per
   * instance, a breach's id is a function of its own ship alone.
   */
  private nextBreachId = 1;

  private readonly columns: HoldColumn[] = [];
  /**
   * The world's vertical in the ship's frame, from the last step. It is per instance
   * (and not a module scratch) because the match's two ships alternate steps and the
   * visuals read this outside `fixedUpdate`.
   */
  private readonly localUp = new THREE.Vector3(0, 1, 0);

  constructor() {
    const dz = HULL_LENGTH / LENGTH_SAMPLES;
    let total = 0;

    for (let i = 0; i < LENGTH_SAMPLES; i++) {
      const t = (i + 0.5) / LENGTH_SAMPLES;
      const z = tToZ(t);

      for (let j = 0; j < WIDTH_SAMPLES; j++) {
        const xFraction = ((j + 0.5) / WIDTH_SAMPLES) * 2 - 1;

        // The column's axis follows the planking at the hold's mid height — it is
        // where the water spends most of its time, and it is the X the water plane
        // uses.
        const midHeight = (HOLD_FLOOR_Y + DECK_Y) * 0.5;
        const x = innerHalfWidthAt(t, midHeight) * xFraction;
        const yCeiling = ceilingY(t, x);
        const span = yCeiling - HOLD_FLOOR_Y;
        if (span <= 0) continue;

        const volume = new Float32Array(LEVELS + 1);
        const centroidX = new Float32Array(LEVELS + 1);
        const centroidY = new Float32Array(LEVELS + 1);

        let accumulated = 0;
        let momentX = 0;
        let momentY = 0;

        for (let level = 1; level <= LEVELS; level++) {
          const yLow = HOLD_FLOOR_Y + (span * (level - 1)) / LEVELS;
          const dy = span / LEVELS / QUADRATURE;

          for (let q = 0; q < QUADRATURE; q++) {
            const y = yLow + dy * (q + 0.5);
            const halfWidth = innerHalfWidthAt(t, y);
            const cellVolume = ((halfWidth * 2) / WIDTH_SAMPLES) * dy * dz;
            accumulated += cellVolume;
            momentX += halfWidth * xFraction * cellVolume;
            momentY += y * cellVolume;
          }

          volume[level] = accumulated;
          centroidX[level] = accumulated > 0 ? momentX / accumulated : x;
          centroidY[level] = accumulated > 0 ? momentY / accumulated : HOLD_FLOOR_Y;
        }

        centroidX[0] = x;
        centroidY[0] = HOLD_FLOOR_Y;

        this.columns.push({ x, z, yFloor: HOLD_FLOOR_Y, yCeiling, volume, centroidX, centroidY });
        total += accumulated;
      }
    }

    this.holdVolume = total;
  }

  /** Fraction of the hold flooded, 0..1 — what the HUD draws. */
  get floodFraction(): number {
    return clamp01(this.floodVolume / this.holdVolume);
  }

  /** `true` from the instant the ship passes the point of no return. */
  get isSinking(): boolean {
    return this.sinkTime > 0;
  }

  /** `true` when the sinking is over and the ship has left the match. */
  get isSunk(): boolean {
    return this.sinkTime >= SINK_DURATION;
  }

  /**
   * Registers an impact. Only what gets in below the deck becomes a breach — a shot
   * into the bulwark tears splinters and nothing else, as in the game.
   *
   * @returns the breach affected, new or widened, or `null` if the shot does not
   *   flood.
   */
  registerHit(hit: ShipHit): Breach | null {
    if (!hit.floods || hit.part !== 'hull') return null;

    const existing = this.findNear(hit.local);
    if (existing) {
      // A shot on top of an open breach: it widens instead of duplicating.
      return this.widen(existing);
    }

    // Hull at the breach ceiling: the shot widens the nearest one there is, with no
    // distance limit. See `MAX_BREACHES` — the hit's effect has to go on existing,
    // and widening is the effect this model has.
    if (this.breaches.length >= MAX_BREACHES) {
      const nearest = this.findNear(hit.local, Number.POSITIVE_INFINITY);
      return nearest ? this.widen(nearest) : null;
    }

    // A shot on top of a nailed plank: it tears the plank off and gives back the
    // breach it was closing. The repair was a patch, and a patch is the weak part of
    // a hull — that is why it comes back at the size it had, and not at the size of a
    // fresh hole.
    const patch = this.findPatchNear(hit.local);
    if (patch) this.patches.splice(this.patches.indexOf(patch), 1);

    const breach: Breach = {
      local: hit.local.clone(),
      normal: hit.normal.clone(),
      area: patch ? patch.area : BREACH_AREA,
      repair: 0,
      inflow: 0,
      id: this.nextBreachId++,
    };
    this.breaches.push(breach);
    return breach;
  }

  /**
   * Tears the hull open in a ramming.
   *
   * ## Why ramming has to open a hull
   *
   * Because without it `HullContact` is only a fence: the ships stop going through
   * each other, and getting close still costs nothing. Two 37 t sloops meeting at
   * three meters per second trade 157 kJ, which is more energy than almost any ball
   * in the game delivers — and the wood has no way not to give. Hit, broken, in
   * **both** hulls: whoever charges takes the same damage they give, and that is what
   * keeps ramming from becoming the optimal strategy instead of a risk.
   *
   * ## A ball's breach, and not a new kind of damage
   *
   * What the impact opens is the same thing a ball opens — same area, same merging,
   * same plank to nail over it. It is deliberate reuse: `registerHit` already resolves
   * breach on top of breach, breach on top of plank and hull at the breach ceiling,
   * and a separate path for ramming would mean keeping the three rules in two places.
   * What the impact has that is different is not the hole, it is **how many** of them
   * — see `RAM_SPEED_STEP`.
   *
   * @param local the contact point, in this hull's local coordinates. It does not
   *   have to be on the surface: what is read from it is the station, the height and
   *   the side, and the breach is put on the planking that corresponds.
   * @param speed closing speed at the contact, in m/s.
   * @returns how many breaches were opened or widened. Zero is "it only touched".
   */
  ram(local: THREE.Vector3, speed: number): number {
    if (speed < RAM_SPEED) return 0;

    const count = Math.min(
      1 + Math.floor((speed - RAM_SPEED) / RAM_SPEED_STEP),
      RAM_BREACHES_MAX,
    );
    // The side comes from X's sign: the impact came from the side the point is on.
    const side = local.x >= 0 ? 1 : -1;

    let opened = 0;
    for (let i = 0; i < count; i++) {
      // Centered on the contact and spread to both sides of it along the planking,
      // without reaching the exact ends — at the stem there is no planking to put a
      // breach on.
      const z = clamp(
        local.z + (i - (count - 1) / 2) * RAM_SPREAD,
        -HALF_LENGTH * 0.96,
        HALF_LENGTH * 0.96,
      );
      if (this.tear(z, local.y, side)) opened++;
    }
    return opened;
  }

  /**
   * Opens a breach on the hull's surface, at station `z` and height `y`.
   *
   * The height comes from the contact and is projected onto the surface by the
   * section's `v` parameter, which is the same conversion the ball uses
   * (`HitDetection.hullNormalAt`) — so the breach is born exactly where the mesh has
   * wood, and not floating beside it.
   */
  private tear(z: number, y: number, side: number): boolean {
    const t = zToT(z);
    const section = sampleSection(t, _ramSection);
    const v = clamp01(sectionV(section, y));

    hullSurfacePoint(t, v, side, _ramHit.local);
    // Above the deck it is bulwark: it tears splinters and nothing else, as with a
    // shot. It is the same line `ShipHit.floods` draws, and it holds for any cause.
    if (_ramHit.local.y >= DECK_Y) return false;

    hullSurfaceNormal(t, v, side, _ramHit.normal);
    return this.registerHit(_ramHit) !== null;
  }

  /** Widens an existing breach, up to the `MAX_BREACH_SCALE` ceiling. */
  private widen(breach: Breach): Breach {
    breach.area = Math.min(breach.area + BREACH_AREA * 0.6, BREACH_AREA * MAX_BREACH_SCALE);
    breach.repair = 0;
    return breach;
  }

  /** The breach nearest a local point within repair reach. */
  findNear(local: THREE.Vector3, radius = MERGE_DISTANCE): Breach | null {
    let best: Breach | null = null;
    let bestDistance = radius;

    for (const breach of this.breaches) {
      const distance = breach.local.distanceTo(local);
      if (distance < bestDistance) {
        bestDistance = distance;
        best = breach;
      }
    }
    return best;
  }

  /** The nailed plank nearest a local point, or `null`. */
  findPatchNear(local: THREE.Vector3, radius = PATCH_DISTANCE): Patch | null {
    let best: Patch | null = null;
    let bestDistance = radius;

    for (const patch of this.patches) {
      const distance = patch.local.distanceTo(local);
      if (distance < bestDistance) {
        bestDistance = distance;
        best = patch;
      }
    }
    return best;
  }

  /**
   * Nails a plank over a breach. Call it every frame while `F` is held.
   *
   * **Idempotent by construction.** A breach that has already left the list accepts
   * no more work, and the progress never goes past 1. Both things were missing, and
   * what you saw on screen was the exact consequence: the breach closed, whoever was
   * holding the button kept feeding the same object — which still existed, because
   * the interactable held the reference — and the prompt climbed to 200%, 300%, with
   * no ceiling and nothing happening to the hull.
   *
   * @returns `true` **only** on the frame the breach closes, and never afterwards. It
   *   is that contract that lets the caller drop the target at the right moment.
   */
  repair(breach: Breach, dt: number): boolean {
    const index = this.breaches.indexOf(breach);
    if (index < 0) return false;

    breach.repair = clamp01(breach.repair + dt / REPAIR_TIME);
    if (breach.repair < 1) return false;

    this.breaches.splice(index, 1);

    // The plank inherits the breach's `id`, and not a counter of its own: it is what
    // seeds the pose draw in the render, so the plank stays in the same place frame
    // after frame instead of jittering.
    this.patches.push({
      local: breach.local.clone(),
      normal: breach.normal.clone(),
      area: breach.area,
      id: breach.id,
    });
    if (this.patches.length > MAX_PATCHES) this.patches.shift();

    return true;
  }

  /**
   * One flooding step.
   *
   * The order is: water comes in through the breaches, water goes out through the
   * pump, the volume becomes a water plane, and the plane becomes weight applied at
   * the centroid.
   */
  fixedUpdate(dt: number, body: ShipBody, waves: WaveField): void {
    this.orientToWorld(body);
    // Zeroed here and rewritten only if there is water: otherwise a drained hold
    // would keep weighing the previous step's value forever.
    body.floodedMass = 0;

    // How much the sea rises and falls right now. It is the scale of the wave
    // shipping on the breaches above the waterline — see `breachInflow`.
    const sigma = waves.getElevationSigma();

    let inflow = 0;
    for (const breach of this.breaches) {
      body.localToWorld(breach.local, _worldPoint);
      const depth = waves.sampleHeight(_worldPoint.x, _worldPoint.z) - _worldPoint.y;

      // A submerged breach drinks by Torricelli; a breach above the line drinks
      // what the crest throws into it. Heeling toward the sound side is still a
      // maneuver, and not decoration: it takes the hole out of the water in both
      // regimes.
      breach.inflow = breachInflow(breach.area, depth, sigma);
      inflow += breach.inflow;
    }

    if (this.pumping) inflow -= PUMP_RATE;
    this.pumping = false;

    this.floodVolume = clamp(this.floodVolume + inflow * dt, 0, this.holdVolume);

    if (this.floodVolume <= 1e-4) {
      this.waterPlane = -Infinity;
      this.updateSinking(dt, body);
      return;
    }

    this.solveWaterPlane();
    const volume = this.sampleAtPlane(this.waterPlane, this.localUp, _centroid);
    if (volume <= 1e-6) {
      this.updateSinking(dt, body);
      return;
    }

    // The water's weight is vertical in the world and lands at the volume's centroid
    // — which is on the side the ship is already heeling toward. It is that lever arm
    // that makes the free-surface effect exist.
    body.localToWorld(_centroid, _worldPoint);
    _force.set(0, -WATER_DENSITY * GRAVITY * volume, 0);
    body.applyForceAtPoint(_force, _worldPoint);

    // The water goes along in the acceleration too: without this a flooded ship
    // would get *more* agile, because it would gain weight without gaining mass.
    body.floodedMass = WATER_DENSITY * volume;

    this.updateSinking(dt, body);
  }

  /**
   * Recomputes the water plane from the volume already in `floodVolume`.
   *
   * ⚠️ **It exists because of the networked duel, and its absence left the hold of
   * the client that does not simulate dry forever.** The water volume arrives
   * authoritative in the snapshot — the HUD climbed, the ship sat deeper, all
   * correct — but whoever draws the sheet reads `waterPlane`, and `waterPlane` was
   * only solved inside `fixedUpdate`, which is the simulating side's path. The player
   * on the other side went below with a holed hull and found a dry floor: "I opened a
   * breach and no water comes in".
   *
   * Separated instead of letting the whole of `fixedUpdate` run on the guest because
   * the rest of `fixedUpdate` **decides** the flooding (inflow, pump, the water's
   * weight), and deciding here would open a second truth about the same hull. This
   * only looks.
   *
   * @param body the ship's body, to know where "up" is in the local frame. Omitted,
   *   it reuses the last step's vertical — which is what `fixedUpdate` wants, because
   *   it has already measured it.
   */
  solveWaterPlane(body?: ShipBody): void {
    if (body) this.orientToWorld(body);
    if (this.floodVolume <= 1e-4) {
      this.waterPlane = -Infinity;
      return;
    }
    this.waterPlane = this.solvePlane(this.floodVolume, this.localUp);
  }

  /** Measures the world's vertical in the hull's frame. */
  private orientToWorld(body: ShipBody): void {
    body.worldDirToLocal(WORLD_UP, this.localUp);
  }

  /** Zeroes everything — used on respawn and when assembling a fresh match. */
  reset(): void {
    this.breaches.length = 0;
    this.patches.length = 0;
    this.floodVolume = 0;
    this.waterPlane = -Infinity;
    this.sinkTime = 0;
    this.pumping = false;
    this.swampMass = 0;
  }

  /**
   * Height of the hold's water on the centerline, in local coordinates.
   * The water sheet's visuals use this to position themselves. `-Infinity` when there
   * is no water.
   */
  getWaterHeightAtCenter(): number {
    if (!Number.isFinite(this.waterPlane)) return -Infinity;
    return this.waterPlane / Math.max(this.localUp.y, 0.2);
  }

  /**
   * World height of the hold water's surface, or `-Infinity` if the hold is dry.
   *
   * It comes from the plane's definition: the surface's points satisfy `p·up = H`,
   * and a local point's height in the world is `(p − com)·up + comPosition.y`.
   * Putting the two together eliminates `p` and leaves a three-term calculation.
   */
  getWorldSurfaceY(body: ShipBody): number {
    if (!Number.isFinite(this.waterPlane)) return -Infinity;
    return this.waterPlane - body.centerOfMass.dot(this.localUp) + body.comPosition.y;
  }

  /**
   * Advances the sinking and, if it has already started, ships the water that comes
   * over the deck — the term that actually takes the ship down (see `SWAMP_MASS`).
   */
  private updateSinking(dt: number, body: ShipBody): void {
    if (this.sinkTime <= 0) {
      if (this.floodFraction >= FATAL_FLOOD) this.sinkTime = 1e-4;
      return;
    }

    this.sinkTime = Math.min(this.sinkTime + dt, SINK_DURATION);

    // It grows with the square of time: the deck enters the water slowly and, once
    // the sheer goes under, the inflow takes off. It is the same feedback as the rest
    // of the file — the deeper, the faster — and it is what makes the sinking's last
    // second the fast one, instead of the ship going down on a constant ramp.
    const progress = clamp01(this.sinkTime / SINK_DURATION);
    this.swampMass = SWAMP_MASS * progress * progress;

    _force.set(0, -this.swampMass * GRAVITY, 0);
    body.applyForce(_force);
    // Added to the inertia too: a hull full of water does not only sink, it gets
    // heavy to move. It is what takes the helm's response away in the last seconds.
    body.floodedMass += this.swampMass;
  }

  /**
   * Finds the water plane that contains exactly `target` of volume.
   *
   * Bisection because the relationship between level and volume has no closed-form
   * inverse — the hold's section changes with height *and* with the ship's tilt.
   * Twenty rounds over a 7 m range give micrometer precision, and each round costs
   * one sweep of the 24 columns.
   */
  private solvePlane(target: number, up: THREE.Vector3): number {
    let low = -4;
    let high = 4;

    for (let i = 0; i < 20; i++) {
      const mid = (low + high) * 0.5;
      if (this.sampleAtPlane(mid, up, null) < target) low = mid;
      else high = mid;
    }

    return (low + high) * 0.5;
  }

  /**
   * Water volume below the plane `p · up = offset`, and its centroid.
   *
   * Each column crosses the plane at a height of its own:
   * `y = (offset − x·upX − z·upZ) / upY`. It is that dependence on `x` that puts more
   * water on the low side when the ship heels.
   */
  private sampleAtPlane(offset: number, up: THREE.Vector3, centroid: THREE.Vector3 | null): number {
    // Capsized, `upY` tends to zero and the division blows up. The floor keeps the
    // arithmetic finite; by then the ship is lost anyway.
    const upY = Math.max(up.y, 0.2);

    let total = 0;
    let momentX = 0;
    let momentY = 0;
    let momentZ = 0;

    for (const column of this.columns) {
      const crossing = (offset - column.x * up.x - column.z * up.z) / upY;
      const span = column.yCeiling - column.yFloor;
      if (crossing <= column.yFloor) continue;

      const position = clamp(((crossing - column.yFloor) / span) * LEVELS, 0, LEVELS);
      const index = Math.min(Math.floor(position), LEVELS - 1);
      const fraction = clamp01(position - index);

      const a = column.volume[index]!;
      const volume = a + (column.volume[index + 1]! - a) * fraction;
      if (volume <= 0) continue;

      total += volume;
      if (!centroid) continue;

      const cx = column.centroidX[index]!;
      const cy = column.centroidY[index]!;
      momentX += (cx + (column.centroidX[index + 1]! - cx) * fraction) * volume;
      momentY += (cy + (column.centroidY[index + 1]! - cy) * fraction) * volume;
      momentZ += column.z * volume;
    }

    if (centroid) {
      if (total > 1e-6) centroid.set(momentX / total, momentY / total, momentZ / total);
      else centroid.set(0, HOLD_FLOOR_Y, 0);
    }

    return total;
  }
}
