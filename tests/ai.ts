/**
 * AI tests — the two properties the whole duel rests on.
 *
 * Runnable in the browser, like `tests/ballistics.ts`:
 *
 * ```js
 * const t = await import('/tests/ai.ts');
 * console.table(t.runAiTests().cases);
 * ```
 *
 * **What gets proved here, and why only this.** The AI's tactics have no "right answer"
 * to compare against — it is behavior, and behavior is measured by watching a duel's
 * telemetry. What *does* have a right answer are the two geometric conversions it rests
 * on, and both are exactly where a flipped sign goes unnoticed forever:
 *
 * 1. **`Cannon.solveAim` is the inverse of `Cannon.getAimLocal`.** If it is not, the gun
 *    points to the mirrored side and the AI misses every shot with no apparent error in
 *    the code — both pieces look right in isolation.
 * 2. **The helmsman's sign closes the loop.** The heading grows to port, a positive wheel
 *    lowers the heading. With the sign flipped the feedback turns positive and the ship
 *    turns faster and faster away from the requested heading, which on screen reads as
 *    "the AI is crazy" and not as a misplaced minus.
 * 3. **The three captains are in order on the axes that decide the duel.** It is not a
 *    geometric conversion, but it does have a right answer: the presets are a hand-written
 *    table, and one number out of order there produces a "Legend" that is easier than a
 *    "Deckhand" without anything breaking or showing up in `tsc`.
 */

import * as THREE from 'three';
import { RAD, angleDelta } from '../src/core/MathUtils';
import { DIFFICULTIES, DIFFICULTY_ORDER, type DifficultyId } from '../src/ai/Difficulty';
import { MAX_WHEEL, WHEEL_RATE } from '../src/ship/Rudder';
import {
  ELEVATION_MAX,
  ELEVATION_MIN,
  TRAVERSE_LIMIT,
  type AimAngles,
} from '../src/ship/Cannon';

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

/**
 * An isolated reproduction of the barrel's kinematics — the same composition
 * `Cannon.getBarrelQuaternion` puts together, without needing a whole ship.
 *
 * Duplicating the formula here is deliberate: a test that called `getAimLocal` to check
 * `solveAim` would only prove that two functions agree. By writing the composition from
 * the definition ('YXZ' applied to −Z), the test checks both against the **geometry**,
 * which is what we want to guarantee.
 */
function barrelDirection(sideYaw: number, traverse: number, elevation: number): THREE.Vector3 {
  const euler = new THREE.Euler(elevation, sideYaw + traverse, 0, 'YXZ');
  return new THREE.Vector3(0, 0, -1).applyQuaternion(new THREE.Quaternion().setFromEuler(euler));
}

/** The same decomposition as `Cannon.solveAim`, to test it without instancing the gun. */
function solveAim(sideYaw: number, direction: THREE.Vector3, out: AimAngles): AimAngles {
  const length = direction.length();
  out.elevation = Math.asin(Math.max(-1, Math.min(1, direction.y / length)));
  let traverse = Math.atan2(-direction.x, -direction.z) - sideYaw;
  // The same `wrapAngle` as in `MathUtils`.
  traverse = ((traverse + Math.PI) % (Math.PI * 2) + Math.PI * 2) % (Math.PI * 2) - Math.PI;
  out.traverse = traverse;
  out.bears =
    Math.abs(traverse) <= TRAVERSE_LIMIT &&
    out.elevation >= ELEVATION_MIN &&
    out.elevation <= ELEVATION_MAX;
  return out;
}

export function runAiTests(): TestReport {
  const cases: TestCase[] = [];

  function check(name: string, measured: number, expected: number, tolerance: number, unidade: string): void {
    const error = measured - expected;
    cases.push({
      name,
      measured: `${measured.toFixed(4)} ${unidade}`,
      expected: `${expected.toFixed(4)} ${unidade}`,
      error: `${error >= 0 ? '+' : ''}${error.toFixed(4)} ${unidade} (tol. ±${tolerance} ${unidade})`,
      passed: Math.abs(error) <= tolerance,
    });
  }

  const angles: AimAngles = { traverse: 0, elevation: 0, bears: false };

  // --- 1. round trip over the whole useful range, on both sides ---------------
  // It sweeps traverse × elevation inside the stops and demands that decomposing the
  // direction return exactly the angles that generated it. The sweep's worst error is what
  // goes into the table: an average would hide a single mirrored point.
  let worstTraverse = 0;
  let worstElevation = 0;

  for (const sideYaw of [-Math.PI / 2, Math.PI / 2]) {
    for (let t = -1; t <= 1; t += 0.25) {
      for (let e = 0; e <= 1; e += 0.125) {
        const traverse = t * TRAVERSE_LIMIT;
        const elevation = ELEVATION_MIN + e * (ELEVATION_MAX - ELEVATION_MIN);

        solveAim(sideYaw, barrelDirection(sideYaw, traverse, elevation), angles);

        worstTraverse = Math.max(worstTraverse, Math.abs(angleDelta(traverse, angles.traverse)));
        worstElevation = Math.max(worstElevation, Math.abs(angles.elevation - elevation));
      }
    }
  }

  // 1 µrad: that is floating-point error, not formula error. A flipped sign would show
  // up here as whole radians, not as micro-radians.
  check('aim · round trip (traverse)', worstTraverse * RAD, 0, 0.0001, '°');
  check('aim · round trip (elevation)', worstElevation * RAD, 0, 0.0001, '°');

  // --- 2. the side points outboard --------------------------------------------
  // With traverse and elevation zeroed, the starboard gun has to look toward +X and the
  // port one toward −X. It is the test that catches the side mirroring, which would pass
  // unpunished through case 1 (that one is symmetric).
  const starboard = barrelDirection(-Math.PI / 2, 0, 0);
  const port = barrelDirection(Math.PI / 2, 0, 0);
  check('side · starboard points toward +X', starboard.x, 1, 0.001, '');
  check('side · port points toward −X', port.x, -1, 0.001, '');

  // --- 3. the firing arc is the beam, not the bow -----------------------------
  // The whole of `ShipAI`'s tactics rests on this: the gun does **not** reach a target
  // over the bow, and that is why keeping the enemy under fire is the helm's job. If some
  // future tuning opens the stop, this case warns before the tactics become redundant.
  const ahead = new THREE.Vector3(0, 0, -1);
  const abeam = new THREE.Vector3(1, 0, 0);
  solveAim(-Math.PI / 2, ahead, angles);
  const bearsAhead = angles.bears;
  solveAim(-Math.PI / 2, abeam, angles);
  const bearsAbeam = angles.bears;

  cases.push({
    name: 'arc · beam yes, bow no',
    measured: `bow ${bearsAhead ? 'bears' : 'out'} · beam ${bearsAbeam ? 'bears' : 'out'}`,
    expected: 'bow out · beam bears',
    error: `stop ±${(TRAVERSE_LIMIT * RAD).toFixed(1)}°`,
    passed: !bearsAhead && bearsAbeam,
  });

  // --- 4. the helmsman closes the loop with the right sign --------------------
  // It simulates `Helmsman`'s cascade against a coarse ship model: the wheel turns at the
  // rate limit, the rudder produces yaw proportional to it, and the heading integrates the
  // yaw. It is not `Rudder`'s physics — it is only its **sign**, which is what is being
  // tested. With the minus flipped anywhere in the chain, the error grows instead of
  // falling, and no tolerance saves it.
  const KP = 8;
  const KD = 11;
  /** Yaw per radian of wheel, in rad/s. The sloop's order of magnitude at 5 knots. */
  const YAW_PER_WHEEL = 0.045;

  let heading = 0;
  let wheel = 0;
  let yawRate = 0;
  const course = 1; // ~57° to port
  const dt = 1 / 60;

  for (let step = 0; step < 60 * 25; step++) {
    const error = angleDelta(heading, course);
    const desired = Math.max(-MAX_WHEEL, Math.min(MAX_WHEEL, -KP * error + KD * yawRate));

    // Inner loop: the wheel chases the commanded angle at the rate limit.
    const room = WHEEL_RATE * dt;
    const command = Math.max(-1, Math.min(1, (desired - wheel) / room));
    wheel = Math.max(-MAX_WHEEL, Math.min(MAX_WHEEL, wheel + command * WHEEL_RATE * dt));

    // A positive wheel is starboard, and starboard **lowers** the heading: hence the
    // minus.
    yawRate = -wheel * YAW_PER_WHEEL;
    heading += yawRate * dt;
  }

  check(
    'helmsman · converges on the requested heading',
    angleDelta(heading, course) * RAD,
    0,
    1.5,
    '°',
  );

  // --- 5. the presets climb in difficulty on every axis -----------------------
  // `Difficulty`'s table is hand-written, and the damage-control axis went into it after
  // the others. A `holdShift` out of order breaks nothing, does not show up in `tsc` and
  // produces a Legend that looks after the ship worse than a Deckhand — which is the kind
  // of error you only find by playing three whole matches.
  //
  // Each row says which way the number has to move from deckhand to legend.
  const axes: readonly { name: string; read: (id: DifficultyId) => number; rises: boolean }[] = [
    { name: 'aimSigma', read: (id) => DIFFICULTIES[id].aimSigma, rises: false },
    { name: 'leadFraction', read: (id) => DIFFICULTIES[id].leadFraction, rises: true },
    { name: 'engageRange', read: (id) => DIFFICULTIES[id].engageRange, rises: true },
    { name: 'fireTolerance', read: (id) => DIFFICULTIES[id].fireTolerance, rises: false },
    { name: 'reaction', read: (id) => DIFFICULTIES[id].reaction, rises: false },
    { name: 'transitScale', read: (id) => DIFFICULTIES[id].transitScale, rises: false },
    { name: 'floodAlarm', read: (id) => DIFFICULTIES[id].floodAlarm, rises: false },
    // Damage-control skill: the legend delivers more work per trip below, goes down fewer
    // times and misses the hole less often.
    { name: 'holdShift', read: (id) => DIFFICULTIES[id].holdShift, rises: true },
    { name: 'gunShift', read: (id) => DIFFICULTIES[id].gunShift, rises: false },
    { name: 'triage', read: (id) => DIFFICULTIES[id].triage, rises: true },
    { name: 'bilgeFloor', read: (id) => DIFFICULTIES[id].bilgeFloor, rises: false },
  ];

  for (const axis of axes) {
    const values = DIFFICULTY_ORDER.map(axis.read);
    const inOrder = values.every(
      (v, i) => i === 0 || (axis.rises ? v > values[i - 1]! : v < values[i - 1]!),
    );
    cases.push({
      name: `preset · ${axis.name} ${axis.rises ? 'rises' : 'falls'} with skill`,
      measured: values.join(' → '),
      expected: axis.rises ? 'strictly increasing' : 'strictly decreasing',
      error: inOrder ? '—' : 'out of order',
      passed: inOrder,
    });
  }

  // The hold shift has to fit a whole job, or else the sailor goes below, starts the walk
  // and comes back up without having nailed anything — a rotation that only costs stairs.
  // The floor is the hold's average transit (~4 m round trip to the locker, at 1.15 m/s)
  // plus `REPAIR_TIME`'s 2.4 s.
  const MIN_SHIFT = 7;
  const shortestShift = Math.min(...DIFFICULTY_ORDER.map((id) => DIFFICULTIES[id].holdShift));
  cases.push({
    name: 'rotation · the hold shift fits one plank',
    measured: `${shortestShift.toFixed(1)} s`,
    expected: `≥ ${MIN_SHIFT} s`,
    error: shortestShift >= MIN_SHIFT ? '—' : `${(MIN_SHIFT - shortestShift).toFixed(1)} s short`,
    passed: shortestShift >= MIN_SHIFT,
  });

  // The pump's floor has to sit **below** the alarm that sends the sailor down, with room
  // to spare. Inverted, he goes into the hold, pumps to a level that still trips the alarm
  // and goes down again on the next step — a sailor who spends the match on the stairs.
  // Touching, the same thing in slow motion. The 3 percentage points of margin are what
  // the water takes ~4 s to put back with an open breach, that is: time for him to reach
  // the gun before being called back.
  const MARGIN = 0.03;
  for (const id of DIFFICULTY_ORDER) {
    const { bilgeFloor, floodAlarm, label } = DIFFICULTIES[id];
    const margin = floodAlarm - bilgeFloor;
    cases.push({
      name: `hold · ${label} leaves the pump before their own alarm`,
      measured: `floor ${(bilgeFloor * 100).toFixed(0)}% · alarm ${(floodAlarm * 100).toFixed(0)}%`,
      expected: `margin ≥ ${(MARGIN * 100).toFixed(0)} points`,
      error: margin >= MARGIN ? '—' : `${(margin * 100).toFixed(1)} points of margin`,
      passed: margin >= MARGIN,
    });
  }

  const failures = cases.filter((c) => !c.passed).length;
  return { passed: failures === 0, total: cases.length, failures, cases };
}
