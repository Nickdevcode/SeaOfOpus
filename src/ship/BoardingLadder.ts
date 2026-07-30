/**
 * The boarding ladder: how you get back aboard after falling into the sea.
 *
 * One per side, aft, beside the helm. It exists to **climb out of the water**, and only
 * for that: getting down means jumping through the gangway. That is why it is born
 * submerged and dies at the quarterdeck's floor, with no part above the bulwark.
 *
 * This module is the **single source** of the measurements, in the same spirit as
 * `RUDDER_BLADE` and `MAST_LADDER`: the mesh (`ShipParts.buildBoardingLadders`), the
 * interaction's reach and `PlayerController`'s climbing step all read from here. It ended
 * up in a file of its own because three things depend on it — geometry, player physics
 * and the Blender clip — and none of the three owns the others.
 *
 * ## The three constraints that dictate every number
 *
 * 1. **The clip rules the spacing.** `ClimbUp` rises `CLIMB_CLIP.rise` per cycle
 *    covering *two* ratlines, so the only grid where the hand lands on the rung that is
 *    drawn is `CLIMB_CLIP.rise / 2`. The mast ladder reached that number by rounding (it
 *    had a fixed height to cover); here the depth is free, so the **exact** spacing is
 *    used and the foot falls where it falls.
 * 2. **The hull rules the rake.** The bilge pulls in nearly a meter between the
 *    quarterdeck and the waterline, so a vertical ladder would hang its foot 1.3 m
 *    outboard. It is raked — and since the clip is for a vertical ladder, the body tilts
 *    by the same angle (`tilt`), which is what keeps the grip married: relative to the
 *    body, the rung above is exactly above again.
 * 3. **The wave rules the depth.** The lowest rung has to be underwater even in a big
 *    wave's trough, or the swimmer reaches the ladder with nothing to grab.
 */

import {
  QUARTERDECK_Y,
  halfWidthAtHeight,
  tToZ,
  zToT,
} from './ShipDimensions';
import { CLIMB_CLIP } from '../player/Locomotion';

/**
 * The ladder's station, in `t`.
 *
 * `STATIONS.helm` is 0.105 and the wheel sits at z = +6.32: the ladder climbs **in the
 * plane of the helm**, so whoever comes back aboard arrives at the station already. The
 * passage is clear on both sides: the awning's columns are at z = +7.25 and +5.00
 * (`CANOPY_BLOCKERS`), the quarterdeck's steps are at t ≈ 0.20 and the after shrouds at
 * z = +7.45.
 */
export const BOARDING_LADDER_T = 0.106;

/** Half width between the stiles. The same as the mast ladder's, and for the same
 *  reason: `anim_climb.RUNG_HALF_WIDTH` is baked into the clip. */
export const BOARDING_LADDER_HALF_WIDTH = 0.24;

/**
 * Spacing between rungs: half the rise of one clip cycle.
 *
 * Not rounding here is what makes this ladder different from the mast's — see note 1 at
 * the top of the file.
 */
export const BOARDING_RUNG_SPACING = CLIMB_CLIP.rise / 2;

/** How many gaps the ladder has. Eight puts the bottom rung 69 cm below the sea's
 *  resting surface, deep enough that a big wave's trough does not leave the swimmer
 *  without a grip. */
export const BOARDING_RUNG_COUNT = 8;

/**
 * How far the ladder sets back horizontally from top to bottom.
 *
 * It is the piece's most contested number, and it comes from a squeeze between two
 * things: following the hull would ask for 1.0 m of setback (26° from vertical), and the
 * climbing clip asks for the least possible — the body tilts by the same angle as the
 * ladder, and a ladder laid too far back leaves the character hanging instead of
 * standing. 0.61 m gives **14.11°**, and it is what decides where the bilge's curve comes
 * closest to the straight line: at y ≈ 1.33, which is where
 * `BOARDING_LADDER_CLEARANCE`'s gap is measured.
 */
export const BOARDING_LADDER_RUN = 0.61;

/** Radius of the stile. The mesh (`ShipParts`) draws with it, and the clearance to the
 *  hull is solved from it — it is the thickest wood in the piece. */
export const BOARDING_STILE_RADIUS = 0.04;
/** Radius of the rung. The same as the mast ladder's ratline. */
export const BOARDING_RUNG_RADIUS = 0.026;

/**
 * Minimum clearance the ladder's wood keeps from the planking, at any height and at
 * **any** of the stations it occupies.
 *
 * Four centimeters is deliberately little: it is enough for the planking and the ladder
 * never to interpenetrate (not even with the hull drawn in 18 cm chords, which fall
 * inside the analytic curve), and little enough not to push the piece off the ship. See
 * `BOARDING_LADDER_CLEARANCE`.
 */
export const BOARDING_LADDER_HULL_GAP = 0.04;

/**
 * Clearance between the plane of the rungs and the planking, measured at the top.
 * **Computed.**
 *
 * It was 8 cm, chosen by hand, and 8 cm was wrong for a reason that only shows when you
 * measure the ladder as a 48 cm wide object instead of a profile: **the clearance is not
 * measured at the ladder's station, but at the widest one it touches.** The stern narrows
 * 26 cm per meter of length in that stretch, so between the two stiles (z = 6.06 and
 * z = 6.54) the planking moves 12.6 cm of half breadth. With 8 cm the forward stile ended
 * up **5.7 cm inside the hull** at y = 1.33 — and with it the forward end of three rungs.
 * The profile in the plane of the rungs gave the 4.5 cm announced; the whole piece went
 * through the planking.
 *
 * That is why the number stopped being chosen: `solveClearance` sweeps the ladder's width
 * and returns the smallest setback that keeps `BOARDING_LADDER_HULL_GAP` across all of
 * it. Today it comes to **17.7 cm**, which puts the top rung 18 cm outboard of the
 * planking — hence the gangway's sill (`HullGeometry.buildGangways`) reaching out to the
 * top rung, or there would be an 18 cm gap between the last rung and the deck. The price
 * of a straight plane on a stern that pulls in a meter over that stretch is at the foot:
 * it sits 79 cm outboard, which is what any small boat's stern ladder really does — and
 * what lets the swimmer reach it in open water instead of under the bilge.
 *
 * ⚠️ The calculation deliberately ignores the wales, and that is a **constraint shared
 * with `HullGeometry`**: `WALE_HEIGHTS` puts one at y = 1.02 standing 5.5 cm proud of the
 * wood, and it passes through the ladder's opening. Counting it would push the ladder
 * another 5.5 cm off the ship; the way out is the same one the hatch coaming uses to let
 * the hold's stair through — **the wale breaks at the opening** — and it is `buildWales`
 * that holds up its end. Removing that break without touching here puts the stile inside
 * the wale.
 */
export const BOARDING_LADDER_CLEARANCE = solveClearance();

/**
 * Distance from the body to the plane of the rungs, measured perpendicular.
 *
 * **It is not this piece's number**, and that is why it is not written here: what
 * dictates it is the pirate's coat, not the rung, and the same standoff applies to the
 * mast ladder. It lives with the clip that baked it (`CLIMB_CLIP.standoff`) because that
 * is where it came from — and while the ladder and `PlayerController` each had their own
 * copy of 0.29, a divergence between the two would fail no test at all.
 */
export const BOARDING_LADDER_STANDOFF = CLIMB_CLIP.standoff;

/**
 * Half width of the gangway — the opening in the bulwark you fall into the sea through.
 *
 * The ladder is not for going down, so this is the way out: a gap in the bulwark, from
 * the floor to the top, wide enough for the player to pass (their cylinder has a 30 cm
 * radius) and narrow enough not to become the normal way of falling — whoever goes
 * through there meant to.
 */
export const BOARDING_GANGWAY_HALF_WIDTH = 0.42;

/** One boarding ladder, in absolute numbers and in the ship's frame. */
export interface BoardingLadderSpec {
  /** +1 starboard, −1 port. */
  readonly side: 1 | -1;
  /** Local Z of the plane of the rungs. */
  readonly z: number;
  /** Half width between the stiles. */
  readonly halfWidth: number;
  /** Height of the top rung, which coincides with the exit floor. */
  readonly topY: number;
  /** Height of the lowest rung, submerged in calm water. */
  readonly bottomY: number;
  /** Vertical spacing between rungs. */
  readonly rungSpacing: number;
  /** Number of gaps (rungs = gaps + 1). */
  readonly rungCount: number;
  /** `|x|` of the plane of the rungs at the top rung. */
  readonly topX: number;
  /** `|x|` of the plane of the rungs at the bottom rung. */
  readonly bottomX: number;
  /** Rake of the plane of the rungs from vertical, in radians. */
  readonly tilt: number;
  /** Distance from the body to the plane of the rungs, perpendicular. */
  readonly standoff: number;
  /** The floor the climb ends on — the quarterdeck. */
  readonly exitY: number;
  /** Half width of the gangway, in Z. */
  readonly gangwayHalfWidth: number;
}

function makeSpec(side: 1 | -1): BoardingLadderSpec {
  const z = tToZ(BOARDING_LADDER_T);
  const topY = QUARTERDECK_Y;
  const bottomY = topY - BOARDING_RUNG_COUNT * BOARDING_RUNG_SPACING;
  const topX = halfWidthAtHeight(BOARDING_LADDER_T, topY) + BOARDING_LADDER_CLEARANCE;
  const bottomX = topX - BOARDING_LADDER_RUN;
  return {
    side,
    z,
    halfWidth: BOARDING_LADDER_HALF_WIDTH,
    topY,
    bottomY,
    rungSpacing: BOARDING_RUNG_SPACING,
    rungCount: BOARDING_RUNG_COUNT,
    topX,
    bottomX,
    tilt: Math.atan2(BOARDING_LADDER_RUN, topY - bottomY),
    standoff: BOARDING_LADDER_STANDOFF,
    exitY: QUARTERDECK_Y,
    gangwayHalfWidth: BOARDING_GANGWAY_HALF_WIDTH,
  };
}

/** The two ladders: starboard first, to match the cannons' order. */
export const BOARDING_LADDERS: readonly BoardingLadderSpec[] = [
  makeSpec(1),
  makeSpec(-1),
];

/**
 * `|x|` of the plane of the rungs at height *y*, extrapolating outside the range.
 *
 * Extrapolating instead of clamping is on purpose: the climbing step queries heights
 * slightly outside the ends (the body reaches the top rung coming from below it) and a
 * clamp would put a false step there.
 */
export function boardingLadderX(spec: BoardingLadderSpec, y: number): number {
  const k = (spec.topY - y) / (spec.topY - spec.bottomY);
  return spec.topX - k * (spec.topX - spec.bottomX);
}

/**
 * Point on the plane of the rungs at height *y*, in the ship's local coordinates.
 * It writes into *out* so it does not allocate in the physics step.
 */
export function boardingLadderPoint(
  spec: BoardingLadderSpec,
  y: number,
  out: { x: number; y: number; z: number },
): { x: number; y: number; z: number } {
  out.x = spec.side * boardingLadderX(spec, y);
  out.y = y;
  out.z = spec.z;
  return out;
}

/**
 * Where the body sits, in `|x|`, when gripping the ladder at height *y*.
 *
 * The standoff is measured **perpendicular** to the plane of the rungs, not
 * horizontally: on a ladder raked 14° the two calculations diverge by 3 cm, and 3 cm is
 * the difference between the palm wrapping the rung and passing beside it.
 */
export function boardingLadderStandX(spec: BoardingLadderSpec, y: number): number {
  return boardingLadderX(spec, y) + spec.standoff * Math.cos(spec.tilt);
}

/** The ladder on the side *x* is on. */
export function boardingLadderForSide(x: number): BoardingLadderSpec {
  return x >= 0 ? BOARDING_LADDERS[0]! : BOARDING_LADDERS[1]!;
}

/** True when *z* falls inside the gangway's opening. */
export function insideGangway(z: number): boolean {
  const spec = BOARDING_LADDERS[0]!;
  return Math.abs(z - spec.z) <= spec.gangwayHalfWidth;
}

/** `t` of the ladder's station, for whoever needs to query the hull there. */
export function boardingLadderT(): number {
  return zToT(BOARDING_LADDERS[0]!.z);
}

/**
 * The smallest setback that keeps the whole ladder `BOARDING_LADDER_HULL_GAP` off the
 * planking — see `BOARDING_LADDER_CLEARANCE`.
 *
 * A sweep, and not a bisection: the constraint is a linear inequality in the setback
 * (the plane's `x` is the setback minus a term that depends only on the height), so the
 * smallest feasible value is the **maximum** of what each point demands, and that reads
 * straight off without iterating. Nine stations across the width, with the stile's radius
 * at both ends and the rung's in between: the ends are what rule, but sampling the middle
 * costs nothing and covers a future station table where the planking stops being
 * monotonic across the ladder's width.
 *
 * It runs once, at module load. The heights stop at the bottom rung because below it the
 * planking only pulls in — the stub of stile left underneath is never the worst case.
 */
function solveClearance(): number {
  const topY = QUARTERDECK_Y;
  const bottomY = topY - BOARDING_RUNG_COUNT * BOARDING_RUNG_SPACING;
  const reference = halfWidthAtHeight(BOARDING_LADDER_T, topY);
  const stations = 8;
  const heights = 240;
  let needed = 0;

  for (let i = 0; i <= stations; i++) {
    const u = i / stations;
    const t = zToT(tToZ(BOARDING_LADDER_T) + (u * 2 - 1) * BOARDING_LADDER_HALF_WIDTH);
    const radius = i === 0 || i === stations ? BOARDING_STILE_RADIUS : BOARDING_RUNG_RADIUS;

    for (let j = 0; j <= heights; j++) {
      const y = bottomY + ((topY - bottomY) * j) / heights;
      // The plane of the rungs at that height is `setback + reference - k * run`; what
      // the hull demands there is `hull + gap + radius`. Isolating the setback gives
      // this.
      const k = (topY - y) / (topY - bottomY);
      const demand =
        halfWidthAtHeight(t, y) + BOARDING_LADDER_HULL_GAP + radius - reference + k * BOARDING_LADDER_RUN;
      if (demand > needed) needed = demand;
    }
  }

  return needed;
}
