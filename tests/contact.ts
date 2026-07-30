/**
 * Ramming test — do the hulls refuse to occupy the same place?
 *
 * It runs in the browser, like the others:
 *
 * ```js
 * const t = await import('/tests/contact.ts');
 * console.table(t.runContactTests().cases);
 * ```
 *
 * ## Why it exists
 *
 * Because the two things this file proves are **invisible from looking at the screen**. A
 * weak contact and a missing contact produce the same picture — two hulls going through
 * each other — and neither cause shows up as an error anywhere. That is what happened:
 * `HullContact` existed, ran every step, and the complaint was still "the boats go inside
 * each other". There were two reasons added together, and both were arithmetic:
 *
 * 1. **The force was divided by the number of probes on a side (ten), and not by the ones
 *    that actually touched.** A bow-on meeting puts one or two probes inside the other
 *    hull, so it received a tenth of the designed force.
 * 2. **The probes stopped 1.23 m short of the stem.** One bow against another had nothing
 *    to measure until it had gone two and a half meters in.
 *
 * What gets proved here is not a tuned number, it is the **property**: touching, the two
 * push apart, and they push apart with an acceleration of collision order of magnitude
 * instead of little-nudge order of magnitude. The limits are loose on purpose — tightening
 * them would turn a stiffness calibration into a broken test.
 *
 * ## And the damage
 *
 * The file's second half is `ShipDamage.ram`, and there are exact numbers to prove there:
 * how many breaches each band of speed opens, that they do not merge into one (which would
 * be worth less than their sum) and that a nudge tears out no planking.
 */

import * as THREE from 'three';
import { createContactReport, resolveHullContact } from '../src/combat/HullContact';
import { ShipBody } from '../src/ship/ShipBody';
import { ShipDamage } from '../src/ship/ShipDamage';
import { computeDisplacement, halfWidthAtHeight } from '../src/ship/ShipDimensions';
import type { Ship } from '../src/ship/Ship';

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

/** The simulation's fixed step. Duplicated so the test does not drag `Engine` in. */
const STEP = 1 / 60;

/**
 * The sloop's mass, gyration and added mass.
 *
 * Copied from `Ship`, where they are private, and that is on purpose — it is the same
 * choice as `PROTOCOL_VERSION` in `roomServer.mjs`. Importing them would make the test
 * agree with the code by construction; written here, a hull change that alters the order
 * of magnitude of the contact response shows up as a failure, which is precisely when
 * somebody has to look at the stiffness again.
 */
const GYRATION = new THREE.Vector3(4.16, 4.16, 1.95);
const ADDED_MASS = new THREE.Vector3(1.9, 2.0, 1.06);
const CENTER_OF_MASS = new THREE.Vector3(0, -0.55, 0.91);
const UP = new THREE.Vector3(0, 1, 0);

/**
 * A hull with nothing inside but the rigid body.
 *
 * `resolveHullContact` only touches `ship.body` — no mesh, no sail, no damage — so the
 * mold is honest and avoids dragging `createShipAssets` (which draws textures onto a
 * canvas) into an arithmetic test.
 *
 * @param heading heading in radians. Zero points the bow toward the world's −Z.
 */
function vessel(x: number, z: number, heading = 0): Ship {
  const body = new ShipBody({
    mass: computeDisplacement().mass,
    centerOfMass: CENTER_OF_MASS,
    gyration: GYRATION,
    addedMass: ADDED_MASS,
  });
  body.orientation.setFromAxisAngle(UP, heading);
  // After the orientation: `setOrigin` uses it to find the center of mass.
  body.setOrigin(x, 0, z);
  return { body } as unknown as Ship;
}

const _originA = new THREE.Vector3();
const _originB = new THREE.Vector3();
const _axis = new THREE.Vector3();
const _relative = new THREE.Vector3();

/** What one contact step produced on the two hulls. */
interface Encounter {
  contacts: number;
  depth: number;
  /**
   * The acceleration with which the two separate, in m/s², measured along the line joining
   * the two origins. Negative is "they kept closing".
   *
   * Read from the velocity after `integrate`, and not from a force peeked at inside: that
   * is how the real ship feels the contact, with each axis's added mass already applied.
   */
  separation: number;
  /**
   * Magnitude of the relative acceleration, in m/s², in any direction.
   *
   * It exists alongside `separation` because a contact's shortest way out is **not always
   * the line joining the two centers**, and on a bow-on meeting it never is: two stems
   * touching are half a meter from the other's side and nearly a meter from its tip, so the
   * wood pushes sideways and the two sloops slide past each other instead of stopping nose
   * to nose. It is what happens at sea, and it is what the game has to do — but measured on
   * the axis of the centers it comes to zero, and zero is indistinguishable from there
   * having been no contact at all.
   */
  push: number;
  /** Magnitude of the linear momentum left in the pair. Zero is equal and opposite. */
  residualMomentum: number;
}

function encounter(a: Ship, b: Ship): Encounter {
  const report = createContactReport();
  resolveHullContact(a, b, report);

  a.body.integrate(STEP);
  b.body.integrate(STEP);

  a.body.getOrigin(_originA);
  b.body.getOrigin(_originB);
  _axis.subVectors(_originA, _originB).normalize();
  _relative.subVectors(a.body.velocity, b.body.velocity);

  _originA.copy(a.body.velocity).add(b.body.velocity).multiplyScalar(a.body.mass);

  return {
    contacts: report.contacts,
    depth: report.depth,
    separation: _relative.dot(_axis) / STEP,
    push: _relative.length() / STEP,
    residualMomentum: _originA.length(),
  };
}

/**
 * A separation acceleration that is already a collision, in m/s².
 *
 * Five is the floor because the version with the wrong division delivered **tenths** —
 * 0.3 m/s² for half a meter of overlap, against the more than ten the designed stiffness
 * gives. Any number in this order of magnitude tells the two apart.
 */
const COLLISION_FLOOR = 5;

/**
 * The same acceleration's ceiling, in m/s².
 *
 * A badly clamped contact spring becomes a catapult, and a catapult is as wrong as fog:
 * the ship would leave at several meters per second in one step. 500 m/s² is generous for
 * the design stiffness and tight enough to catch a clamp somebody removed. See
 * `MAX_PUSH_DEPTH`.
 */
const CATAPULT_CEILING = 500;

export function runContactTests(): TestReport {
  const cases: TestCase[] = [];

  function record(name: string, measured: string, expected: string, passed: boolean, error = ''): void {
    cases.push({ name, measured, expected, error: passed ? '—' : error || 'fora do expected', passed });
  }

  function checkCollision(name: string, met: Encounter): void {
    const ok =
      met.contacts > 0 &&
      met.separation >= COLLISION_FLOOR &&
      met.separation <= CATAPULT_CEILING;
    record(
      name,
      `${met.contacts} contacts · ${met.depth.toFixed(2)} m · ${met.separation.toFixed(1)} m/s²`,
      `> 0 contacts · ${COLLISION_FLOOR}–${CATAPULT_CEILING} m/s² of separation`,
      ok,
      met.contacts === 0 ? 'no contact found' : `separation of ${met.separation.toFixed(1)} m/s²`,
    );
  }

  // -- contact ------------------------------------------------------------------

  // The real half-beam at the waterline, so the overlap is the one asked for instead of a
  // guess based on the nominal beam.
  const halfBeam = halfWidthAtHeight(0.5, 0.1);

  // Side to side, parallel, with 40 cm of hull inside hull. It is the most common meeting
  // in a duel: someone trying to cross the other's bow and scraping.
  checkCollision(
    'side to side · the hulls push like wood, not like fog',
    encounter(vessel(0, 0), vessel(2 * halfBeam - 0.4, 0)),
  );

  // The same thing, looking at what is left of the linear momentum. With both on the same
  // heading the added-mass tensors are aligned, so the third law has to close to floating
  // point — if it does not, somebody applied the force to one body and forgot the other,
  // and the pair would gain speed out of nothing.
  {
    const met = encounter(vessel(0, 0), vessel(2 * halfBeam - 0.4, 0));
    const ok = met.contacts > 0 && met.residualMomentum < 1;
    record(
      'side to side · the reaction is equal and opposite',
      `${met.residualMomentum.toFixed(3)} kg·m/s left over`,
      '≈ 0',
      ok,
      `the pair gained ${met.residualMomentum.toFixed(1)} kg·m/s of momentum`,
    );
  }

  // Bow into the side: the classic ramming. A's bow goes 60 cm into B's side, which is lying
  // athwart. The shortest way out is B's side, and that is where the wood pushes.
  checkCollision(
    'bow into the side · the hull is expelled sideways by the other',
    encounter(vessel(0, 0), vessel(0, -8 - halfBeam + 0.6, Math.PI / 2)),
  );

  // Bow to bow, one meter of overlap. It is the case that **did not exist**: the probes
  // stopped 1.23 m short of the stem, so in this arrangement the step found **zero**
  // contacts and the two sloops telescoped with nothing holding them. Hence the contact
  // count being half of what is proved here.
  //
  // The other half is the force, measured as a magnitude and not on the axis of the
  // centers — see `Encounter.push` for why. All that is demanded of the axis is that it
  // not be **negative**: the wood may push sideways, it may not pull inward.
  {
    const met = encounter(vessel(0, 0), vessel(0, -15, Math.PI));
    const ok = met.contacts > 0 && met.push >= COLLISION_FLOOR && met.push <= CATAPULT_CEILING && met.separation > -0.5;
    record(
      'bow to bow · the two refuse to go through each other',
      `${met.contacts} contacts · ${met.depth.toFixed(2)} m · ${met.push.toFixed(1)} m/s² of push`,
      `> 0 contacts · ${COLLISION_FLOOR}–${CATAPULT_CEILING} m/s², no attraction`,
      ok,
      met.contacts === 0 ? 'no contact found' : `push of ${met.push.toFixed(1)} m/s²`,
    );
  }

  // And the opposite of that: far apart, nothing happens. A phantom contact here would be
  // worse than no contact there — the ship would be pushed around on the open sea.
  {
    const met = encounter(vessel(0, 0), vessel(0, -40));
    const ok = met.contacts === 0 && Math.abs(met.separation) < 1e-6;
    record(
      'open sea · with no overlap there is no contact',
      `${met.contacts} contacts · ${met.separation.toFixed(4)} m/s²`,
      '0 contacts · 0 m/s²',
      ok,
      'contact found between hulls that do not touch',
    );
  }

  // -- damage -------------------------------------------------------------------

  /** Rams a clean hull at the waterline, amidships, and says what is left. */
  function ram(speed: number, y = 0.1): ShipDamage {
    const damage = new ShipDamage();
    damage.ram(new THREE.Vector3(halfBeam, y, 0), speed);
    return damage;
  }

  const ladder: ReadonlyArray<[number, number]> = [
    [0.9, 0],
    [1.5, 1],
    [2.5, 2],
    [4, 3],
    [9, 3],
  ];
  for (const [speed, want] of ladder) {
    const got = ram(speed).breaches.length;
    record(
      `ramming · ${speed.toFixed(1)} m/s opens ${want} breach(es)`,
      `${got}`,
      `${want}`,
      got === want,
      `opened ${got}`,
    );
  }

  // Three breaches and not one widened: `RAM_SPREAD` has to beat `MERGE_DISTANCE`, or else
  // the hardest blow in the game would be worth less than the sum of its parts — widening
  // saturates at `MAX_BREACH_SCALE` and three separate holes do not saturate.
  {
    const damage = ram(4);
    let closest = Number.POSITIVE_INFINITY;
    for (let i = 0; i < damage.breaches.length; i++) {
      for (let j = i + 1; j < damage.breaches.length; j++) {
        const gap = damage.breaches[i]!.local.distanceTo(damage.breaches[j]!.local);
        if (gap < closest) closest = gap;
      }
    }
    const ok = damage.breaches.length === 3 && closest > 0.5;
    record(
      'ramming · the three breaches stay apart',
      `${damage.breaches.length} breaches · ${closest.toFixed(2)} m between the closest`,
      '3 breaches · > 0.50 m',
      ok,
      'the blow made a single merged breach',
    );
  }

  // Every breach from a blow has to flood and has to be on the side that was struck.
  {
    const damage = ram(4);
    const below = damage.breaches.every((breach) => breach.local.y < 1.3);
    const onSide = damage.breaches.every((breach) => breach.local.x > 0);
    record(
      'ramming · the breaches open on the struck side, below the deck',
      `${below ? 'below' : 'above'} · ${onSide ? 'to starboard' : 'on the wrong side'}`,
      'below · to starboard',
      below && onSide,
      'breach outside the side that took the blow',
    );
  }

  // Hitting the bulwark tears out splinters and nothing else, as with a shot: above the
  // deck there is no hold to fill.
  {
    const got = ram(6, 1.6).breaches.length;
    record(
      'ramming · a blow above the deck does not open the hull',
      `${got} breaches`,
      '0 breaches',
      got === 0,
      `opened ${got} breach(es) in the bulwark`,
    );
  }

  const failures = cases.filter((entry) => !entry.passed).length;
  return { passed: failures === 0, total: cases.length, failures, cases };
}
