/**
 * Ballistics test — the simulated range against the analytic range.
 *
 * The project has no test runner installed (that would be new dependencies for a single
 * file), so this module is **runnable in the browser**: the dev server serves
 * `/tests/ballistics.ts` like any other module, and whoever wants to run it opens the
 * console and does
 *
 * ```js
 * const t = await import('/tests/ballistics.ts');
 * console.table(t.runBallisticsTests().cases);
 * ```
 *
 * **What gets proved here.** The trajectory with drag has no closed form — there is no
 * "right answer" to compare against. What there is is the limiting case: with zero drag
 * the integration *has* to reproduce the textbook parabola, and that is what the first
 * two cases check, forward (angle → range) and back (range → angle). With the integrator
 * proved in vacuum, the last two cases check that the solver and the projectile that
 * actually flies agree with each other, which is the property the AI's aim depends on.
 */

import * as THREE from 'three';
import { GRAVITY, DEG, RAD } from '../src/core/MathUtils';
import { dragFactor, maxRange, solveElevation, stepBallistic } from '../src/combat/Ballistics';
import { BALL_MASS, BALL_RADIUS, MUZZLE_SPEED } from '../src/ship/Cannon';

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

/** Range of a vacuum parabola: `R = v²·sin(2θ)/g`. */
function vacuumRange(speed: number, elevation: number): number {
  return (speed * speed * Math.sin(2 * elevation)) / GRAVITY;
}

/**
 * Integrates a shot in the vertical plane until it comes back to its starting height and
 * returns the range, interpolating inside the step where it crossed.
 *
 * `dt` is a parameter because one of the cases has to run with the real projectile's step
 * (1/60 split into 4 substeps), and not with the solver's.
 */
function integrateRange(speed: number, elevation: number, dragK: number, dt: number): number {
  const position = new THREE.Vector3(0, 0, 0);
  const velocity = new THREE.Vector3(Math.cos(elevation) * speed, Math.sin(elevation) * speed, 0);
  const previous = new THREE.Vector3();

  for (let i = 0; i < Math.ceil(30 / dt); i++) {
    previous.copy(position);
    stepBallistic(position, velocity, dragK, dt);

    if (position.y <= 0 && velocity.y < 0) {
      const drop = previous.y - position.y;
      const s = drop > 1e-9 ? previous.y / drop : 0;
      return previous.x + (position.x - previous.x) * s;
    }
  }
  return position.x;
}

export function runBallisticsTests(): TestReport {
  const cases: TestCase[] = [];

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

  const dragK = dragFactor(BALL_MASS, BALL_RADIUS);

  // --- 1. vacuum at 45°: the range has to be v²/g -----------------------------
  // The bias is known and has a sign: semi-implicit Euler gets the height wrong by
  // `−g·t·dt/2`, which here is worth ~0.56 m at the end of 13.7 s of flight and becomes a
  // range ~0.6 m short. Tolerating 3 m in 920 is 0.33% — enough room for the test not to
  // be brittle, and tight enough to catch a flipped sign or a wrong gravity.
  const elevation45 = 45 * DEG;
  check(
    'vacuum · 45° · range',
    integrateRange(MUZZLE_SPEED, elevation45, 0, 1 / 120),
    vacuumRange(MUZZLE_SPEED, elevation45),
    3,
    'm',
  );

  // --- 2. the inverse: given the range, the solver finds the angle ------------
  // At 30° because the solver's ceiling is 44.1°: asking for the maximum-range angle would
  // be asking for precisely what it refuses to return, on purpose.
  const elevation30 = 30 * DEG;
  const range30 = vacuumRange(MUZZLE_SPEED, elevation30);
  const solvedVacuum = solveElevation(range30, 0, MUZZLE_SPEED, 0);
  check(
    'vacuum · range → angle',
    (solvedVacuum?.elevation ?? NaN) * RAD,
    30,
    0.15,
    '°',
  );

  // --- 3. with drag, solver × the real projectile ----------------------------
  // The solver integrates at 120 Hz in a plane; the projectile integrates at 240 Hz
  // (60 Hz ÷ 4 substeps) in three dimensions. If the two disagreed, the AI would miss by
  // meters and the player would never know why.
  const combatRange = 120;
  const solved = solveElevation(combatRange, 0, MUZZLE_SPEED, dragK);
  const flown = solved
    ? integrateRange(MUZZLE_SPEED, solved.elevation, dragK, 1 / 240)
    : NaN;
  check('drag · solver × projectile', flown, combatRange, 0.5, 'm');

  // --- 4. the drag has to cost dearly ----------------------------------------
  // It is not a second-order correction: at 95 m/s the ball loses more than half the
  // vacuum range. If this case starts matching the vacuum value, it is because
  // `dragFactor` got zeroed somewhere.
  const vacuumBest = vacuumRange(MUZZLE_SPEED, 45 * DEG);
  const dragBest = maxRange(MUZZLE_SPEED, dragK);
  cases.push({
    name: 'drag · maximum range < vacuum',
    measured: `${dragBest.toFixed(1)} m`,
    expected: `< ${(vacuumBest * 0.75).toFixed(1)} m`,
    error: `${((1 - dragBest / vacuumBest) * 100).toFixed(1)}% lost`,
    passed: dragBest < vacuumBest * 0.75 && dragBest > 100,
  });

  const failures = cases.filter((c) => !c.passed).length;
  return { passed: failures === 0, total: cases.length, failures, cases };
}
