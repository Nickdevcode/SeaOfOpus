/**
 * Damage model tests — the property that was missing and nobody saw for months.
 *
 * Runnable in the browser, like the others:
 *
 * ```js
 * const t = await import('/tests/damage.ts');
 * console.table(t.runDamageTests().cases);
 * ```
 *
 * **What gets proven here, and why it's worth a file.** The flooding model has no
 * "right answer" to compare against — breach flow rate in a wooden hull is a tuned
 * number, not a theorem. What it *does* have is a structural property that any
 * combat game needs to respect and that this one violated:
 *
 * > **A hit is worth a hit, wherever it lands.**
 *
 * The violation was subtle and came out of two reasonable rules that added up
 * badly. A shot near an open breach *widened* that breach instead of opening
 * another one (with a 90 cm radius, three and a half times the span a cannonball
 * makes), and each breach's flow rate was limited by a **fixed** ceiling, the same
 * for a small hole and for one twice the size. Together, they said that widening is
 * worth nothing — and therefore that grouping the shots is a waste.
 *
 * Measured: eight hits within a handspan of the hull side put 10% of water in the
 * hold; the same eight swept along the hull **sank the ship**. Whoever aimed better
 * did ten times less damage, and the AI — which sweeps by doctrine — played on the
 * good side of that curve while the player played on the bad side, with no way to
 * know the curve existed.
 *
 * The three cases below pin the fix down: the merge comes out of the breach's real
 * span, the flow rate is linear in area **including past saturation**, and the ratio
 * between grouped fire and swept fire stays above a floor. None of them needs a
 * ship, an ocean or a canvas — only the geometry and the arithmetic.
 */

import * as THREE from 'three';
import {
  MERGE_DISTANCE,
  ShipDamage,
  breachInflow,
} from '../src/ship/ShipDamage';

export interface TestCase {
  name: string;
  measured: string;
  expected: string;
  error: string;
  passed: boolean;
}

export interface TestReport {
  passed: boolean;
  total: number;
  failures: number;
  cases: TestCase[];
}

/** Area of a freshly opened breach, read from the model itself instead of copied. */
function baseArea(): number {
  const damage = new ShipDamage();
  const breach = hit(damage, 0);
  return breach?.area ?? 0;
}

/** Opens (or widens) a breach at the waterline, at station `z`. */
function hit(damage: ShipDamage, z: number) {
  return damage.registerHit({
    fraction: 0,
    local: new THREE.Vector3(1.9, 0.05, z),
    normal: new THREE.Vector3(1, 0, 0),
    part: 'hull',
    floods: true,
  });
}

/** The hull's total water-entry area, in m². */
function openArea(damage: ShipDamage): number {
  let total = 0;
  for (const breach of damage.breaches) total += breach.area;
  return total;
}

/** A standard Gaussian, to simulate the scatter of someone aiming at a point and
 *  missing. */
function gaussian(random: () => number): number {
  let u = 0;
  let v = 0;
  while (u === 0) u = random();
  while (v === 0) v = random();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

function createRandom(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function runDamageTests(): TestReport {
  const cases: TestCase[] = [];
  const AREA = baseArea();

  function check(name: string, measured: number, expected: number, tolerance: number, unidade: string): void {
    const error = measured - expected;
    cases.push({
      name,
      measured: `${measured.toFixed(3)} ${unidade}`,
      expected: `${expected.toFixed(3)} ${unidade}`,
      error: `${error >= 0 ? '+' : ''}${error.toFixed(3)} ${unidade} (tol. ±${tolerance} ${unidade})`,
      passed: Math.abs(error) <= tolerance,
    });
  }

  // --- 1. the merge fits inside the breach's opening --------------------------
  // The opening a ball makes is a circle of the base area. Merging shots far beyond that
  // diameter is saying that sound wood between two holes does not exist — and it is what
  // turned precision into punishment. The ceiling of two diameters is generous on purpose:
  // it covers the cracked wood around without becoming again the 90 cm radius this test
  // came to keep from coming back.
  const bore = 2 * Math.sqrt(AREA / Math.PI);
  cases.push({
    name: 'merge · fits inside two breach bores',
    measured: `${MERGE_DISTANCE.toFixed(3)} m (bore ${bore.toFixed(3)} m)`,
    expected: `≤ ${(bore * 2).toFixed(3)} m`,
    error: MERGE_DISTANCE <= bore * 2 ? '—' : `${(MERGE_DISTANCE / bore).toFixed(1)} bores`,
    passed: MERGE_DISTANCE <= bore * 2,
  });

  // And it really has to merge what is close and separate what is far, or else the number
  // above would be decoration.
  const near = new ShipDamage();
  hit(near, 0);
  hit(near, MERGE_DISTANCE * 0.5);
  const far = new ShipDamage();
  hit(far, 0);
  hit(far, MERGE_DISTANCE * 1.5);
  cases.push({
    name: 'merge · close becomes one breach, far becomes two',
    measured: `close ${near.breaches.length} · far ${far.breaches.length}`,
    expected: 'close 1 · far 2',
    error: near.breaches.length === 1 && far.breaches.length === 2 ? '—' : 'merge outside the radius',
    passed: near.breaches.length === 1 && far.breaches.length === 2,
  });

  // --- 2. the inflow is linear in the area, saturated included -----------------
  // **This is the case that catches the fixed ceiling coming back.** With a ceiling in
  // m³/s per breach, doubling the area of a well-submerged hole changes nothing — and that
  // is what made grouping the shots worth a tenth of spreading them. Shallow (the jet still
  // obeys Torricelli) and deep (the jet has already saturated) have to scale the same.
  for (const [label, depth] of [['shallow', 0.2], ['deep', 3]] as const) {
    const single = breachInflow(AREA, depth);
    const twice = breachInflow(AREA * 2, depth);
    check(`inflow · doubling the area doubles the inflow (${label})`, twice / single, 2, 0.001, '×');
  }

  // The saturation still exists — it is what keeps the sinking's last second from becoming
  // a step. Without this case, "linear in the area" would be satisfied by removing the
  // ceiling, which is the opposite defect.
  const deep = breachInflow(AREA, 3);
  const abyssal = breachInflow(AREA, 12);
  check('inflow · the jet saturates with depth', abyssal / deep, 1, 0.001, '×');

  // --- 2b. the breach above the waterline -------------------------------------
  //
  // The band of side that can open a breach runs up to the deck, at `y = 1.3`, and the
  // waterline passes near `y = 0.05`. That is 1.25 m of dry hull against 85 cm of wet hull
  // — and the player aims at what they can see, which is the dry part. With no wave
  // shipping, four breaches between two ships gave `inflow 0` on both panels and a hold
  // stuck at 2% after a whole fight.
  //
  // What is pinned down here are the three properties that make this game physics and not
  // an invented number: on a flat sea the high hole stays dry; a rough sea wets it more
  // than a gentle one; and none of that touches the submerged regime, which is the real
  // model.
  const ABOVE = -0.5;
  const flat = breachInflow(AREA, ABOVE, 0);
  const gentle = breachInflow(AREA, ABOVE, 0.25);
  const rough = breachInflow(AREA, ABOVE, 0.9);

  check('wave · a flat sea does not wet a high breach', flat, 0, 1e-9, 'm³/s');
  check(
    'wave · a rough sea wets more than a gentle one',
    rough > gentle && gentle > 0 ? 1 : 0,
    1,
    0.001,
    'yes/no',
  );
  // A submerged breach cannot gain or lose inflow because of the wave: there what rules is
  // the water column, and adding the shipping would be counting it twice.
  check(
    'wave · does not interfere with a submerged breach',
    breachInflow(AREA, 0.6, 0.9) / breachInflow(AREA, 0.6, 0),
    1,
    0.001,
    '×',
  );

  // --- 3. aiming well cannot cost dearly --------------------------------------
  // The end-to-end test of the property at the top. Twelve hits, two ways of distributing
  // them, and the water-entry area that comes out of each. Grouped *may* yield less — two
  // shots in the same hand's breadth really do overlap —, but it cannot yield a fraction.
  //
  // The floor is 60%: with today's numbers the ratio comes to ~0.88, and the old value gave
  // 0.24. Anything below 60% means the model has gone back to punishing whoever hits, which
  // is the one thing this file exists to prevent.
  const FLOOR = 0.6;
  const REPS = 120;
  let groupedSum = 0;
  let spreadSum = 0;

  for (let r = 0; r < REPS; r++) {
    const random = createRandom(0xda3a6e + r * 7919);
    const grouped = new ShipDamage();
    const spread = new ShipDamage();

    for (let i = 0; i < 12; i++) {
      // Grouped: aim amidships and miss by 1 m. Spread: the whole side.
      hit(grouped, Math.max(-7, Math.min(7, gaussian(random) * 1)));
      hit(spread, (random() * 2 - 1) * 6);
    }

    groupedSum += openArea(grouped);
    spreadSum += openArea(spread);
  }

  const ratio = groupedSum / spreadSum;
  cases.push({
    name: 'broadside · grouped fire yields close to spread fire',
    measured: `${(ratio * 100).toFixed(0)}% of the area`,
    expected: `≥ ${(FLOOR * 100).toFixed(0)}%`,
    error: ratio >= FLOOR ? '—' : `${((FLOOR - ratio) * 100).toFixed(0)} points below the floor`,
    passed: ratio >= FLOOR,
  });

  const failures = cases.filter((c) => !c.passed).length;
  return { passed: failures === 0, total: cases.length, failures, cases };
}
