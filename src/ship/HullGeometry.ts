/**
 * The Sloop's hull, swept from the station table.
 *
 * Nothing here is modeled by hand: it all comes out of `ShipDimensions`, so
 * touching one row of the table changes the drawing, the buoyancy and the
 * collision at the same time. That coupling is exactly what was wanted — a
 * visual hull and a physics hull disagreeing is the most expensive bug to find
 * in a boat game.
 *
 * The output comes split by material, not by part. One `Mesh` per material
 * gives five draw calls for the whole ship; splitting by part would give
 * dozens, and the enemy ship would double the count.
 */

import * as THREE from 'three';
import { GeometryBuilder, vertex, type Vertex } from './GeometryBuilder';
import {
  DECK_THICKNESS,
  DECK_Y,
  HALF_LENGTH,
  HATCH_HALF_T,
  HATCH_HALF_WIDTH,
  HOLD_FLOOR_Y,
  HULL_LENGTH,
  HULL_THICKNESS,
  QUARTERDECK_T,
  QUARTERDECK_Y,
  STATIONS,
  deckCamber,
  deckEdgeHalfWidth,
  deckHalfWidth,
  hullSurfaceNormal,
  hullSurfacePoint,
  innerHalfWidthAt,
  sampleSection,
  sectionHalfWidth,
  sectionV,
  tToZ,
  zToT,
  type HullSection,
} from './ShipDimensions';
import { BOARDING_LADDERS, BOARDING_RUNG_RADIUS } from './BoardingLadder';

/** Longitudinal mesh stations. 72 gives ~22 cm between frames — a smooth curve. */
const LENGTH_SEGMENTS = 72;
/** Divisions from the keel to the top of the bulwark. */
const GIRTH_SEGMENTS = 22;

/** Length of one hull-side plank, in meters (one tile of the texture). */
const HULL_PLANK_TILE = 4;
/** Girth covered by one tile of the hull-side texture (10 planks of 28 cm). */
const HULL_GIRTH_TILE = 2.8;
/** Approximate midships girth, from the keel to the rail — just to scale the UV. */
const MIDSHIP_GIRTH = 4.6;

/** Length of one deck plank and width of the 8-plank band. */
const DECK_PLANK_TILE = 4.5;
const DECK_BAND_TILE = 1.76;

/** Wale heights: one just below the deck, the other halfway up the bulwark. */
const WALE_HEIGHTS = [1.02, 1.92];

/**
 * Range of `t` covered by the inner liner and by the hold floor.
 *
 * Both use the same interval on purpose: when the floor stopped short of the
 * liner, triangular holes were left at both ends of the hold. It doesn't reach
 * 0 and 1 because at the extremes the section degenerates to a point and the
 * normal is undefined.
 */
const SHELL_T_FROM = 0.006;
const SHELL_T_TO = 0.994;
/** How far the liner runs below the floor, so the joint stays covered. */
const FLOOR_OVERLAP = 0.16;
/**
 * How far the hold ceiling reaches outboard of the deck.
 *
 * The usable deck is already the half width *minus* the hull thickness; the
 * ceiling uses the same row, so without this overshoot its edge would hang in
 * the air, a hand's breadth from the liner. With it, the edge dies buried in
 * the hull-side timber.
 */
const CEILING_OUTSET = 0.09;

// -- the gangway -------------------------------------------------------------
//
// The opening in the bulwark you jump into the sea through, one per side, right
// above the boarding ladder. It isn't a part: it's a **hole**, and that's why it
// lives here and not in `ShipParts` — what has to stop existing is the hull
// side, the liner and the cap.
//
// The band is the same on both sides (the ladder is symmetric), so `t` is worked
// out once. `BoardingLadder` is the source: moving the ladder's station there
// moves the opening here, and that's what keeps the ladder from climbing to a
// closed bulwark.

const GANGWAY_SPEC = BOARDING_LADDERS[0]!;
/** Aft edge of the opening (lower `t`, higher Z) and forward edge (higher `t`). */
const GANGWAY_T_FROM = zToT(GANGWAY_SPEC.z + GANGWAY_SPEC.gangwayHalfWidth);
const GANGWAY_T_TO = zToT(GANGWAY_SPEC.z - GANGWAY_SPEC.gangwayHalfWidth);

/**
 * How far below the hull side the **liner** is cut, at the opening.
 *
 * The two can't be cut on the same line, and the reason is the usual one on
 * this hull: the liner is offset along the normal, not horizontally. On the
 * stern bulwark the normal points slightly downward (n·y = −0.07), so the liner
 * point at the same `v` station as the hull side comes out **9 mm higher** —
 * cutting both at equal `v` would leave a sliver of liner across the middle of
 * the gangway floor, on the inboard side. Two centimeters of slack put the
 * liner's edge at y ≈ 1.729: below the floor and inside the thickness of the
 * sill, which covers it.
 */
const GANGWAY_LINER_DROP = 0.02;

/** Thickness of the gangway sill. It fits inside `DECK_THICKNESS` on purpose:
 *  its inboard end dies buried in the deck itself. */
const GANGWAY_SILL_THICKNESS = 0.05;

/** `true` when the station falls inside the opening, on both sides. */
function inGangway(t: number): boolean {
  return t > GANGWAY_T_FROM && t < GANGWAY_T_TO;
}

/** `v` where the **hull side** dies at the opening: the quarterdeck floor line. */
function gangwaySillV(t: number): number {
  return sectionV(sampleSection(t, sectionScratchB), QUARTERDECK_Y);
}

/** `v` where the **liner** dies at the opening — see `GANGWAY_LINER_DROP`. */
function gangwayLinerV(t: number): number {
  return sectionV(sampleSection(t, sectionScratchB), QUARTERDECK_Y - GANGWAY_LINER_DROP);
}

const sectionScratchB: HullSection = { halfBeam: 0, keelY: 0, sheerY: 0, fullness: 1 };

const pointScratch = new THREE.Vector3();
const normalScratch = new THREE.Vector3();

/**
 * Hull point offset `offset` meters along the normal (negative = inboard), with
 * the plank UV already applied.
 */
function hullVertex(t: number, v: number, side: number, offset: number): Vertex {
  hullSurfacePoint(t, v, side, pointScratch);
  if (offset !== 0) {
    hullSurfaceNormal(t, v, side, normalScratch);
    pointScratch.addScaledVector(normalScratch, offset);
  }
  return vertex(
    pointScratch.x,
    pointScratch.y,
    pointScratch.z,
    (t * HULL_LENGTH) / HULL_PLANK_TILE,
    (v * MIDSHIP_GIRTH) / HULL_GIRTH_TILE,
  );
}

export interface HullGeometrySet {
  /** Outer hull side, transom, keel, stem and sternpost. */
  hull: THREE.BufferGeometry;
  /** Inner liner of the bulwark and the hold, plus the hold floor and ceiling. */
  interior: THREE.BufferGeometry;
  /** Deck, quarterdeck, steps, cap rail, coaming and hatch rim. */
  deck: THREE.BufferGeometry;
  /** Wales and the transom's molding. */
  trim: THREE.BufferGeometry;
}

/**
 * Builds the whole hull. Runs once per ship, when the match is created.
 */
export function buildHullGeometry(): HullGeometrySet {
  const hull = new GeometryBuilder();
  const interior = new GeometryBuilder();
  const deck = new GeometryBuilder();
  const trim = new GeometryBuilder();

  buildShell(hull);
  buildTransom(hull, interior);
  buildInnerShell(interior);
  buildHoldFloor(interior);
  buildCapRail(deck);
  buildGangways(deck);
  buildDeck(deck, interior);
  buildQuarterdeck(deck, interior);
  buildHatchCoaming(deck);
  buildHatchRim(deck);
  buildBackbone(hull);
  buildWales(trim);

  return {
    hull: hull.toGeometry(),
    interior: interior.toGeometry(),
    deck: deck.toGeometry(),
    trim: trim.toGeometry(),
  };
}

/**
 * The outer hull side, one half at a time.
 *
 * The two sides don't form a single closed strip: at `v = 0` the two halves meet
 * at `x = 0`, and emitting a strip that runs through there would create a whole
 * row of zero-area triangles. Kept apart, the keel becomes just a seam between
 * two surfaces — and the keel timber covers the seam.
 */
function buildShell(builder: GeometryBuilder): void {
  // No longer a single sweep because of the gangway: the opening's edges go in
  // as explicit stations (otherwise the cut would come out jagged at the mesh
  // step) and the strips inside it stop at the floor line.
  const rows = deckRows(0, 1, LENGTH_SEGMENTS, [GANGWAY_T_FROM, GANGWAY_T_TO]);

  for (const side of [1, -1]) {
    for (let i = 0; i < rows.length - 1; i++) {
      const tA = rows[i]!;
      const tB = rows[i + 1]!;
      const cut = inGangway((tA + tB) * 0.5);
      builder.addStrip(girthRow(tA, side, cut), girthRow(tB, side, cut), side > 0);
    }
  }
}

/**
 * One row from the keel to the rail, optionally cut off at the gangway sill.
 *
 * The cut is a **clamp** on `v`, not a shorter row: that way the vertices below
 * the sill land on exactly the same `v` as the untouched neighboring strip, and
 * the two meet with no gap. What is left above the clamp are zero-area quads,
 * which `GeometryBuilder` already discards on its own when it sums the normals —
 * that's the price, a cheap one, of not having two different samplings of the
 * same curve butted against each other.
 */
function girthRow(t: number, side: number, cut: boolean): Vertex[] {
  const maxV = cut ? gangwaySillV(t) : 1;
  const row: Vertex[] = [];
  for (let j = 0; j <= GIRTH_SEGMENTS; j++) {
    row.push(hullVertex(t, Math.min(j / GIRTH_SEGMENTS, maxV), side, 0));
  }
  return row;
}

/**
 * Transom: the flat wall that closes the hull off at the back.
 *
 * It comes in two sheets, one facing outward with the dark hull-side timber and
 * one facing inward — the Sloop has the most visible stern in the game, and a
 * single-sided panel would show the emptiness inside every time the camera swept
 * past the helm.
 */
function buildTransom(outer: GeometryBuilder, inner: GeometryBuilder): void {
  const section = sampleSection(0, sectionScratchB);
  const height = section.sheerY - section.keelY;

  outer.addSurface(GIRTH_SEGMENTS, 16, (v, u) => {
    const halfWidth = sectionHalfWidth(section, v);
    const x = (u * 2 - 1) * halfWidth;
    return vertex(
      x,
      section.keelY + height * v,
      HALF_LENGTH,
      x / HULL_PLANK_TILE,
      (v * height) / HULL_GIRTH_TILE,
    );
  });

  // The inner face sits exactly where the side liner **starts**, and not one
  // hull thickness in from the outer panel. The two numbers were different — the
  // liner begins at `SHELL_T_FROM`, 9.6 cm forward of the stern, and the inner
  // panel sat 3.4 cm behind it. The hold's stern corner had a tear that wide
  // running top to bottom, with the sea showing through it.
  //
  // The width comes from `innerHalfWidthAt`, the same function that describes
  // the liner, for the same reason: a horizontal inset and an inset along the
  // normal are not the same point, and on the transom — which is nearly vertical
  // but has the hull side running away forward — the difference reaches a hand's
  // breadth down at the bottom.
  const innerZ = tToZ(SHELL_T_FROM);
  // Its own object: `sectionScratchB` is the module's shared scratch, and
  // holding a reference to it here would let the next sampling rewrite this
  // section from under it.
  const innerSection: HullSection = { halfBeam: 0, keelY: 0, sheerY: 0, fullness: 1 };
  sampleSection(SHELL_T_FROM, innerSection);
  const innerHeight = innerSection.sheerY - innerSection.keelY;

  inner.addSurface(
    GIRTH_SEGMENTS,
    16,
    (v, u) => {
      const y = innerSection.keelY + innerHeight * v;
      const halfWidth = innerHalfWidthAt(SHELL_T_FROM, y);
      const x = (u * 2 - 1) * halfWidth;
      return vertex(x, y, innerZ, x / HULL_PLANK_TILE, (v * innerHeight) / HULL_GIRTH_TILE);
    },
    true,
  );
}

/**
 * Inner liner: the same hull-side surface, pushed inboard by the planking
 * thickness and with the normals flipped.
 *
 * It runs from the hold floor's height to the top of the bulwark in one go,
 * because it is literally the same plank — it's the deck that cuts this liner in
 * two halfway up, separating what you see standing on deck from what you see
 * going down the hatch.
 */
function buildInnerShell(builder: GeometryBuilder): void {
  const rows = deckRows(SHELL_T_FROM, SHELL_T_TO, LENGTH_SEGMENTS, [
    GANGWAY_T_FROM,
    GANGWAY_T_TO,
  ]);

  for (const side of [1, -1]) {
    for (let i = 0; i < rows.length - 1; i++) {
      const tA = rows[i]!;
      const tB = rows[i + 1]!;
      const cut = inGangway((tA + tB) * 0.5);
      builder.addStrip(innerRow(tA, side, cut), innerRow(tB, side, cut), side < 0);
    }
  }
}

/** One liner row, with the same clamp as `girthRow` at the gangway. */
function innerRow(t: number, side: number, cut: boolean): Vertex[] {
  const section = sampleSection(t, sectionScratchB);
  // The hold floor rises above the keel amidships and meets it at the ends;
  // below it there is no liner to draw. Starting a hand's breadth *below* it is
  // deliberate: the floor rests on top of the liner, the way it does on a real
  // boat, and the joint disappears under the plank instead of depending on two
  // independent calculations agreeing to the millimeter.
  const vFloor = Math.max(sectionV(section, HOLD_FLOOR_Y - FLOOR_OVERLAP), 0);
  const maxV = cut ? gangwayLinerV(t) : 1;

  const row: Vertex[] = [];
  for (let j = 0; j <= GIRTH_SEGMENTS; j++) {
    const v = vFloor + (1 - vFloor) * (j / GIRTH_SEGMENTS);
    row.push(hullVertex(t, Math.min(v, maxV), side, -HULL_THICKNESS));
  }
  return row;
}

/**
 * Hold floor: a flat floor, as wide as the liner allows.
 *
 * The edge comes from `innerHalfWidthAt`, the same function that describes the
 * liner, and not from a horizontal inset of the outer half width. This isn't
 * fussiness: at the bilge the hull side runs at 40° from vertical, and there
 * "13 cm inboard horizontally" and "13 cm along the normal" are different points
 * — 3 cm in X, 8 cm in Y. The old version left exactly that gap running down
 * both sides, with the sea showing through it.
 */
function buildHoldFloor(builder: GeometryBuilder): void {
  const rows = 48;

  let previousT = SHELL_T_FROM;
  for (let i = 1; i <= rows; i++) {
    const t = SHELL_T_FROM + (i / rows) * (SHELL_T_TO - SHELL_T_FROM);
    const hwA = innerHalfWidthAt(previousT, HOLD_FLOOR_Y);
    const hwB = innerHalfWidthAt(t, HOLD_FLOOR_Y);

    // At the ends the liner has already closed below the floor and no floor is
    // left; a degenerate triangle there would do no harm, but it draws nothing
    // either.
    if (hwA > 1e-3 || hwB > 1e-3) {
      const columns = 6;
      const rowA: Vertex[] = [];
      const rowB: Vertex[] = [];
      for (let j = 0; j <= columns; j++) {
        const u = j / columns;
        const xa = (u * 2 - 1) * hwA;
        const xb = (u * 2 - 1) * hwB;
        rowA.push(
          vertex(xa, HOLD_FLOOR_Y, tToZ(previousT), tToZ(previousT) / DECK_PLANK_TILE, xa / DECK_BAND_TILE),
        );
        rowB.push(vertex(xb, HOLD_FLOOR_Y, tToZ(t), tToZ(t) / DECK_PLANK_TILE, xb / DECK_BAND_TILE));
      }
      builder.addStrip(rowA, rowB);
    }
    previousT = t;
  }
}

/**
 * Cap rail: the strip that closes the top, joining the outer face to the inner.
 *
 * It's the part the camera gets closest to — anyone walking the deck spends the
 * whole time right up against it — so it gets the deck's pale oak instead of the
 * hull side's tar, which is what Rare does on the Sloop.
 */
/**
 * The cap **drops** a little down both faces instead of resting on top of them.
 *
 * The previous version was a flat strip at the exact top of the bulwark, raised
 * 12 mm so it wouldn't fight the hull side for depth. Those 12 mm were an open
 * slot all the way around the ship, on both sides — and the deck is exactly
 * where the player's nose ends up against the bulwark. Dropping 2.5 cm outboard
 * and inboard, the part wraps the corner, covers the seam instead of hovering
 * over it, and gets the thickness a cap plank really has.
 */
const CAP_RAIL_DROP = 0.025;

/**
 * A point on the cap rail. `w` runs across the part: 0 at the outer skirt, 0.5
 * at the top, 1 at the inner skirt.
 *
 * It lives in its own function because the gangway jamb has to end **exactly**
 * on this profile. The cap is interrupted at the opening, and the bulwark's cut
 * shows underneath it: if the jamb stopped at the straight line of the hull
 * side's top, 1.4 cm of gap would be left under the crown of the cap in the
 * middle of the part and 1.1 cm of lip would stick out at the outer corner.
 * Reading the same profile, the two parts meet flush by construction.
 */
function capRailVertex(t: number, w: number, side: number): Vertex {
  const across = Math.min(w, 1 - w) * 2;
  const point = hullVertex(t, 1, side, -w * HULL_THICKNESS);
  return vertex(
    point.x,
    // Rises in the middle and drops at both edges: a rounded-top profile.
    point.y + 0.014 - CAP_RAIL_DROP * (1 - across),
    point.z,
    (t * HULL_LENGTH) / DECK_PLANK_TILE,
    (w * HULL_THICKNESS * side) / DECK_BAND_TILE,
  );
}

/** Divisions across the cap. The gangway jamb uses the same ones. */
const CAP_RAIL_SEGMENTS = 6;

function capRailRow(t: number, side: number): Vertex[] {
  const row: Vertex[] = [];
  for (let j = 0; j <= CAP_RAIL_SEGMENTS; j++) row.push(capRailVertex(t, j / CAP_RAIL_SEGMENTS, side));
  return row;
}

function buildCapRail(builder: GeometryBuilder): void {
  // Interrupted at the gangway: it's the cap that makes the bulwark a wall, and
  // letting it run over the opening would give a window instead of a way out.
  const rows = deckRows(0.004, 0.996, LENGTH_SEGMENTS, [GANGWAY_T_FROM, GANGWAY_T_TO]);

  for (const side of [1, -1]) {
    for (let i = 0; i < rows.length - 1; i++) {
      const tA = rows[i]!;
      const tB = rows[i + 1]!;
      if (inGangway((tA + tB) * 0.5)) continue;
      builder.addStrip(capRailRow(tA, side), capRailRow(tB, side), side > 0);
    }
  }

  // Transom: without this cap the bulwark dies in a 13 cm edge of faceless
  // timber, right in the frame of whoever is at the helm.
  const section = sampleSection(0, sectionScratchB);
  const top = section.sheerY;
  const outerHalf = sectionHalfWidth(section, 1);
  const innerHalf = Math.max(innerHalfWidthAt(SHELL_T_FROM, top - 0.02), outerHalf - HULL_THICKNESS);
  const zOuter = HALF_LENGTH;
  const zInner = tToZ(SHELL_T_FROM);

  const columns = 14;
  const outerRow: Vertex[] = [];
  const innerRow: Vertex[] = [];
  for (let i = 0; i <= columns; i++) {
    const u = (i / columns) * 2 - 1;
    outerRow.push(
      vertex(u * outerHalf, top - CAP_RAIL_DROP, zOuter, (u * outerHalf) / DECK_BAND_TILE, 0),
    );
    innerRow.push(
      vertex(u * innerHalf, top + 0.014, zInner, (u * innerHalf) / DECK_BAND_TILE, 0.4),
    );
  }
  builder.addStrip(outerRow, innerRow, true);
}

/**
 * The two gangways: the jambs that close the bulwark's cut, and the sill.
 *
 * **This is where the topsail-platform lesson and the deck one pay off.** The
 * hull side, the liner and the cap are single-sided surfaces: cutting them
 * leaves the bulwark's 13 cm of thickness wide open, and single-sided timber
 * doesn't exist seen edge-on — through the opening the sea would show through
 * the wall itself. Both faces of the cut have to be drawn, and that's what the
 * jambs are: a strip joining the hull side to the liner at each edge of the
 * opening, from the sill's edge to the cap's profile.
 *
 * The sill is a single part on purpose, and it runs from the deck to the foot of
 * the boarding ladder. Naturally it would be two — the one that caps the
 * bulwark's thickness and the platform that spans the 18 cm between the hull
 * side and the ladder — but two floor parts at the same height butted edge to
 * edge flicker against each other in depth. A single plank has no joint, and
 * it's also the right thing aboard: a ship's gangway has a platform, otherwise
 * the first step of whoever comes aboard is into thin air.
 */
function buildGangways(builder: GeometryBuilder): void {
  for (const spec of BOARDING_LADDERS) {
    const { side } = spec;

    for (const isFore of [false, true]) {
      const t = isFore ? GANGWAY_T_TO : GANGWAY_T_FROM;
      // The jamb starts on the **liner**'s line, not the hull side's: it's the
      // lower of the two (see `GANGWAY_LINER_DROP`), and starting on the other
      // would leave 2 cm of liner with no jamb at the inner corner. The excess
      // disappears under the sill.
      const vLow = gangwayLinerV(t);
      builder.addSurface(
        1,
        CAP_RAIL_SEGMENTS,
        (w, k) =>
          k >= 1
            ? capRailVertex(t, w, side)
            : hullVertex(t, vLow + (1 - vLow) * k, side, -w * HULL_THICKNESS),
        // The face looks into the opening: forward at the aft edge, vice versa.
        isFore ? side < 0 : side > 0,
      );
    }

    // Sill. Longer than the opening at both ends so the end faces die inside the
    // bulwark instead of butting against the plane of the jambs; what sticks out
    // past the hull side is the platform's side, which is a part on show.
    const xIn = Math.min(deckEdgeHalfWidth(GANGWAY_T_FROM), deckEdgeHalfWidth(GANGWAY_T_TO)) - 0.05;
    // Stops at the inner edge of the ladder's top bar: the bar stands 2.6 cm
    // above the plank and becomes the step's nosing, which is what you see on a
    // gangway.
    const xOut = spec.topX - BOARDING_RUNG_RADIUS;
    builder.addBox(
      {
        x: side * (xIn + xOut) * 0.5,
        y: QUARTERDECK_Y - GANGWAY_SILL_THICKNESS * 0.5,
        z: spec.z,
      },
      {
        x: xOut - xIn,
        y: GANGWAY_SILL_THICKNESS,
        z: (spec.gangwayHalfWidth + 0.02) * 2,
      },
      1 / DECK_BAND_TILE,
    );
  }
}

/**
 * Deck station rows.
 *
 * The hatch edges go in as explicit stations so the cutout comes out
 * rectangular; without that the hole would come out jagged by the size of the
 * mesh step.
 */
function deckRows(from: number, to: number, count: number, extra: number[] = []): number[] {
  const rows: number[] = [];
  for (let i = 0; i <= count; i++) rows.push(from + ((to - from) * i) / count);
  for (const value of extra) {
    if (value > from && value < to) rows.push(value);
  }
  rows.sort((a, b) => a - b);
  return rows;
}

/** X extents of a deck span, each one a function of the row's half width. */
type Span = [(halfWidth: number) => number, (halfWidth: number) => number];

/**
 * How to emit the band. With no options it comes out as the top face, the one
 * you walk on; with `CEILING` the same band comes out facing down, a little
 * lower and a little further outboard — the hold ceiling.
 */
interface BandOptions {
  /** Vertical offset applied to the whole band. */
  offsetY?: number;
  /** Flips the orientation of the faces. */
  flip?: boolean;
  /** Widens the row outboard (the hatch edge, which is fixed, doesn't move). */
  outset?: number;
}

const CEILING: BandOptions = { offsetY: -DECK_THICKNESS, flip: true, outset: CEILING_OUTSET };

function emitDeckBand(
  builder: GeometryBuilder,
  tA: number,
  tB: number,
  y: number,
  spans: Span[],
  options: BandOptions = {},
): void {
  const { offsetY = 0, flip = false, outset = 0 } = options;
  // The drawn edge goes out to the liner, and not to the usable half width — see
  // `deckEdgeHalfWidth`. It's what closes the gap at the bow and stern corners.
  const hwA = deckEdgeHalfWidth(tA) + outset;
  const hwB = deckEdgeHalfWidth(tB) + outset;
  const zA = tToZ(tA);
  const zB = tToZ(tB);

  for (const [fromX, toX] of spans) {
    const x0a = fromX(hwA);
    const x1a = toX(hwA);
    const x0b = fromX(hwB);
    const x1b = toX(hwB);
    // Near the bow the deck gets narrower than the hatch; there the side span
    // inverts and the only right thing to do is emit nothing.
    if (x1a - x0a < 0.02 || x1b - x0b < 0.02) continue;

    // The camber is measured from the **usable** width, and not from the drawn
    // one: the floor height has to be exactly what `deckCamber` returns for the
    // physics, otherwise the player's foot floats a centimeter above the plank.
    const camberA = deckHalfWidth(tA);
    const camberB = deckHalfWidth(tB);

    const columns = Math.max(2, Math.round(Math.max(x1a - x0a, x1b - x0b) / 0.35));
    const rowA: Vertex[] = [];
    const rowB: Vertex[] = [];
    for (let j = 0; j <= columns; j++) {
      const u = j / columns;
      const xa = x0a + (x1a - x0a) * u;
      const xb = x0b + (x1b - x0b) * u;
      rowA.push(
        vertex(xa, y + offsetY + deckCamber(xa, camberA), zA, zA / DECK_PLANK_TILE, xa / DECK_BAND_TILE),
      );
      rowB.push(
        vertex(xb, y + offsetY + deckCamber(xb, camberB), zB, zB / DECK_PLANK_TILE, xb / DECK_BAND_TILE),
      );
    }
    builder.addStrip(rowA, rowB, flip);
  }
}

/**
 * Main deck, from the quarterdeck's edge to the bow, with the hatch cut out.
 *
 * It comes out twice: the top face in the deck material, the bottom one in the
 * hold's. The deck is a zero-thickness shell, and a zero-thickness shell with a
 * `FrontSide` material **does not exist** for anyone looking from below — going
 * down into the hold you saw the sky and the rigging through the very deck you
 * had just been standing on. Both faces come from the same row of stations, so
 * the ceiling follows the sheer and the camber with no chance of diverging.
 */
function buildDeck(builder: GeometryBuilder, ceiling: GeometryBuilder): void {
  const hatchFrom = STATIONS.hatch - HATCH_HALF_T;
  const hatchTo = STATIONS.hatch + HATCH_HALF_T;
  const rows = deckRows(QUARTERDECK_T, 0.995, 40, [hatchFrom, hatchTo]);

  const full: Span[] = [[(hw) => -hw, (hw) => hw]];
  const sides: Span[] = [
    [(hw) => -hw, () => -HATCH_HALF_WIDTH],
    [() => HATCH_HALF_WIDTH, (hw) => hw],
  ];

  for (let i = 0; i < rows.length - 1; i++) {
    const tA = rows[i]!;
    const tB = rows[i + 1]!;
    const middle = (tA + tB) * 0.5;
    const inHatch = middle > hatchFrom && middle < hatchTo;
    const spans = inHatch ? sides : full;
    emitDeckBand(builder, tA, tB, DECK_Y, spans);
    emitDeckBand(ceiling, tA, tB, DECK_Y, spans, CEILING);
  }
}

/**
 * The after quarterdeck and what climbs up to it.
 *
 * The step between the two decks is what puts the helm above the sail's line —
 * without it the helmsman would sail looking at canvas. The two stairs sit
 * against the bulwarks, leaving the middle clear for the mizzen mast and for
 * anyone running from bow to stern.
 */
function buildQuarterdeck(builder: GeometryBuilder, ceiling: GeometryBuilder): void {
  // Starts exactly where the stern's inner liner starts. This isn't half a
  // centimeter of fussiness: the floor stopped at 0.004 and the inner panel at
  // 0.006, and the band between them was an opening onto the sea right under the
  // helmsman.
  const rows = deckRows(SHELL_T_FROM, QUARTERDECK_T, 12);
  const full: Span[] = [[(hw) => -hw, (hw) => hw]];
  for (let i = 0; i < rows.length - 1; i++) {
    emitDeckBand(builder, rows[i]!, rows[i + 1]!, QUARTERDECK_Y, full);
    emitDeckBand(ceiling, rows[i]!, rows[i + 1]!, QUARTERDECK_Y, full, CEILING);
  }

  // The quarterdeck's front wall, facing the bow. It goes down to *below* the
  // main deck's ceiling because it also closes the 44 cm step between the two
  // ceilings — seen from the hold, that step was one more tear open to the sky.
  const hw = deckEdgeHalfWidth(QUARTERDECK_T);
  const camberHalf = deckHalfWidth(QUARTERDECK_T);
  const z = tToZ(QUARTERDECK_T);
  const columns = 12;
  const bottomY = DECK_Y - DECK_THICKNESS - 0.01;
  const bottom: Vertex[] = [];
  const top: Vertex[] = [];
  for (let j = 0; j <= columns; j++) {
    const x = (j / columns) * 2 * hw - hw;
    bottom.push(
      vertex(x, bottomY + deckCamber(x, camberHalf), z, x / DECK_BAND_TILE, bottomY / DECK_PLANK_TILE),
    );
    top.push(
      vertex(
        x,
        QUARTERDECK_Y + deckCamber(x, camberHalf),
        z,
        x / DECK_BAND_TILE,
        QUARTERDECK_Y / DECK_PLANK_TILE,
      ),
    );
  }
  builder.addStrip(bottom, top, true);

  // Two two-step stairs, one per side. Each step is a solid block that starts at
  // the deck: that way the space underneath isn't open when the camera crouches,
  // and the top of each block is already the walkable surface.
  const steps = 2;
  const rise = (QUARTERDECK_Y - DECK_Y) / steps;
  const tread = 0.32;
  for (const side of [1, -1]) {
    const x = side * (camberHalf - 0.62);
    for (let step = 0; step < steps; step++) {
      const top = DECK_Y + rise * (step + 1);
      // The topmost step meets the wall; the lower ones reach forward.
      const centerZ = z - tread * (steps - step - 0.5);
      builder.addBox(
        { x, y: (DECK_Y + top) * 0.5, z: centerZ },
        { x: 1.05, y: top - DECK_Y, z: tread },
        1 / DECK_BAND_TILE,
      );
    }
  }
}

/**
 * The deck's thickness seen from inside the hatchway.
 *
 * The coaming covers the top 16 cm; from there down it is this collar that closes the cut
 * between the deck's top face and its bottom face. It is four blocks fitted into the
 * deck's own thickness, half a centimeter outside the opening, so they do not fight the
 * coaming's inner face for depth.
 */
function buildHatchRim(builder: GeometryBuilder): void {
  const zFore = tToZ(STATIONS.hatch + HATCH_HALF_T);
  const zAft = tToZ(STATIONS.hatch - HATCH_HALF_T);
  const halfLength = (zAft - zFore) * 0.5;
  const centerZ = (zAft + zFore) * 0.5;
  const inner = HATCH_HALF_WIDTH + 0.005;
  const thickness = 0.06;
  // It goes into the coaming from above and past the ceiling from below: both overhangs
  // disappear inside wood that already exists, and no joint is left on an edge.
  const top = DECK_Y + 0.1;
  const bottom = DECK_Y - DECK_THICKNESS - 0.02;
  const center = { y: (top + bottom) * 0.5 };
  const height = top - bottom;

  for (const side of [1, -1]) {
    builder.addBox(
      { x: side * (inner + thickness * 0.5), y: center.y, z: centerZ },
      { x: thickness, y: height, z: halfLength * 2 + thickness * 2 },
      1 / DECK_BAND_TILE,
    );
    builder.addBox(
      { x: 0, y: center.y, z: centerZ + side * (halfLength + thickness * 0.5 + 0.005) },
      { x: (inner + thickness) * 2, y: height, z: thickness },
      1 / DECK_BAND_TILE,
    );
  }
}

/**
 * The hatch coaming: the rim that keeps the deck's water from falling into the hold.
 * Besides being real, it hides the zero thickness of the cut in the deck.
 *
 * **Open aft**, and that is not saving geometry: it is where the stairs come up, and a
 * coaming closed on all four sides would be a 16 cm step laid across the mouth of the
 * flight — exactly where the foot of whoever is coming out of the hold lands. A real ship
 * does the same: the side you come in through is cut away.
 */
function buildHatchCoaming(builder: GeometryBuilder): void {
  const zFore = tToZ(STATIONS.hatch + HATCH_HALF_T);
  const zAft = tToZ(STATIONS.hatch - HATCH_HALF_T);
  const halfLength = (zAft - zFore) * 0.5;
  const centerZ = (zAft + zFore) * 0.5;
  const height = 0.16;
  const thickness = 0.1;
  const y = DECK_Y + deckCamber(0, deckHalfWidth(STATIONS.hatch)) + height * 0.5 - 0.02;

  for (const side of [1, -1]) {
    builder.addBox(
      { x: side * (HATCH_HALF_WIDTH + thickness * 0.5), y, z: centerZ },
      { x: thickness, y: height, z: halfLength * 2 + thickness },
      1 / DECK_BAND_TILE,
    );
  }

  // Only the forward head, on the side opposite the stairs.
  builder.addBox(
    { x: 0, y, z: zFore - thickness * 0.5 },
    { x: (HATCH_HALF_WIDTH + thickness) * 2, y: height, z: thickness },
    1 / DECK_BAND_TILE,
  );
}

/**
 * Keel, stem and sternpost — the skeleton that shows from outside.
 *
 * They are rectangular-section sweeps following the bottom's line and the bow's. Besides
 * giving the ship the right profile from a distance, they cover the seam where the hull's
 * two halves meet.
 */
function buildBackbone(builder: GeometryBuilder): void {
  const halfWidth = 0.13;
  const depth = 0.22;

  // Quilha: acompanha `keelY` de ponta a ponta.
  const profile: [number, number][] = [
    [-halfWidth, 0.04],
    [-halfWidth, -depth],
    [halfWidth, -depth],
    [halfWidth, 0.04],
  ];

  const ringAt = (t: number): Vertex[] => {
    const section = sampleSection(t, sectionScratchB);
    const z = tToZ(t);
    const row: Vertex[] = [];
    for (let i = 0; i <= profile.length; i++) {
      const [dx, dy] = profile[i % profile.length]!;
      row.push(
        vertex(dx, section.keelY + dy, z, (t * HULL_LENGTH) / HULL_PLANK_TILE, i * 0.12),
      );
    }
    return row;
  };

  const steps = 48;
  let previous = ringAt(0.015);
  for (let i = 1; i <= steps; i++) {
    const t = 0.015 + (i / steps) * 0.955;
    const row = ringAt(t);
    builder.addStrip(previous, row, true);
    previous = row;
  }

  // Stem: it rises from the keel to the rail, following the hull's front outline. It is
  // what gives the sloop that straight, tall bow profile.
  const stemSteps = 20;
  const stemRing = (h: number): Vertex[] => {
    const section = sampleSection(0.985, sectionScratchB);
    const y = section.keelY + (section.sheerY - section.keelY) * h;
    // The bow reaches out as it rises: the stem rakes forward.
    const z = tToZ(0.985) - 0.06 - h * 0.34;
    const row: Vertex[] = [];
    for (let i = 0; i <= profile.length; i++) {
      const [dx, dy] = profile[i % profile.length]!;
      row.push(vertex(dx, y + dy * 0.35, z + dy * 0.9, h * 3, i * 0.12));
    }
    return row;
  };
  previous = stemRing(0);
  for (let i = 1; i <= stemSteps; i++) {
    const row = stemRing(i / stemSteps);
    builder.addStrip(previous, row, true);
    previous = row;
  }

  // Sternpost: the vertical piece at the stern, which the rudder hangs on.
  const sternSection = sampleSection(0.01, sectionScratchB);
  builder.addBox(
    {
      x: 0,
      y: (sternSection.keelY + DECK_Y) * 0.5,
      z: HALF_LENGTH - 0.04,
    },
    { x: 0.26, y: DECK_Y - sternSection.keelY, z: 0.22 },
    1 / HULL_GIRTH_TILE,
  );
}

/**
 * Wales: the two horizontal bands running along the side.
 *
 * On a real ship they are the thickest planks, which take the shock of coming alongside a
 * quay. In the game they do another, equally important job: they break the side's smooth
 * surface and give the silhouette the sheer line you read from a distance, which is what
 * makes the sloop look like the sloop even at two hundred meters.
 */
/**
 * Both wales stop at the gangway's opening, and that is not decoration: it is what
 * deixa a escada de embarque existir.
 *
 * The lower one (y = 1.02) stands 5.5 cm proud of the wood and passes **behind** the
 * rungs' plane — at the forward stile's station it reaches 1.84 m against the stile's
 * 1.85 m, that is, one centimeter of clearance for a piece with a 4 cm radius. Setting
 * the ladder further out would cost the whole 5.5 cm in distance from the side (see
 * `BOARDING_LADDER_CLEARANCE`); interrupting the wale costs an 84 cm gap a real gangway
 * has anyway. It is the same device as the hatch coaming, open aft so the hold's stairs
 * can come up.
 *
 * The upper one (y = 1.92) falls inside the opening for the same geometric reason and for
 * a more obvious one: with the side cut away there, it would lie across the middle of the
 * doorway, hanging from nothing.
 *
 * The cut's ends are **capped**. The wale is a closed-section sweep, that is, a tube:
 * cutting it without a cap would leave two holes you can see the inside of the piece
 * through — the same trap as the single face, now on a solid piece.
 */
function buildWales(builder: GeometryBuilder): void {
  const steps = 56;
  const height = 0.19;
  const stand = 0.055;
  const rows = deckRows(0.01, 0.975, steps, [GANGWAY_T_FROM, GANGWAY_T_TO]);

  for (const waleY of WALE_HEIGHTS) {
    for (const side of [1, -1]) {
      const ringAt = (t: number): Vertex[] => {
        const section = sampleSection(t, sectionScratchB);
        const vLow = sectionV(section, waleY - height * 0.5);
        const vHigh = sectionV(section, waleY + height * 0.5);
        const normal = hullSurfaceNormal(t, sectionV(section, waleY), side, normalScratch).clone();

        const low = hullSurfacePoint(t, vLow, side, new THREE.Vector3());
        const high = hullSurfacePoint(t, vHigh, side, new THREE.Vector3());
        const u = (t * HULL_LENGTH) / HULL_PLANK_TILE;

        const corners = [
          low.clone(),
          low.clone().addScaledVector(normal, stand),
          high.clone().addScaledVector(normal, stand),
          high.clone(),
        ];
        const row: Vertex[] = [];
        for (let i = 0; i <= corners.length; i++) {
          const p = corners[i % corners.length]!;
          row.push(vertex(p.x, p.y, p.z, u, i * 0.09));
        }
        return row;
      };

      for (let i = 0; i < rows.length - 1; i++) {
        const tA = rows[i]!;
        const tB = rows[i + 1]!;
        if (inGangway((tA + tB) * 0.5)) continue;
        builder.addStrip(ringAt(tA), ringAt(tB), side > 0);
      }

      // The caps on the cut's two ends. The direct order of the four corners gives a
      // normal toward +Z to starboard and toward −Z to port (the profile's traversal
      // mirrors along with the hull), and each end has to face away from the piece that
      // is left — hence the comparison between the side and which end it is.
      for (const isFore of [false, true]) {
        const corners = ringAt(isFore ? GANGWAY_T_TO : GANGWAY_T_FROM);
        const [a, b, c, d] = corners as [Vertex, Vertex, Vertex, Vertex];
        if (isFore === (side > 0)) builder.addQuad(a, b, c, d);
        else builder.addQuad(d, c, b, a);
      }
    }
  }
}
