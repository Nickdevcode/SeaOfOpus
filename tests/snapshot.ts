/**
 * Snapshot test — is what the host writes what the guest reads?
 *
 * ```js
 * const s = await import('/tests/snapshot.ts');
 * console.table(s.runSnapshotTests().cases);
 * ```
 *
 * ## Why this test exists
 *
 * Because the network format has a class of defect **no other test catches and no player
 * can describe**: a field the writer sends and the reader does not read (or reads in the
 * wrong order). There is no error, no exception, no `NaN`. What happens is that every
 * field from there on comes out shifted, and the game on the other side starts showing
 * values that belong to something else — the wind's heading read as the fraction of the
 * day, the sailor read as the event list.
 *
 * The two real defects that motivated this file:
 *
 * - **The background swell's heading did not travel.** Except that the symptom was "his
 *   ship floats strangely", which nobody connects to a missing field.
 * - **The breach list had different ceilings on the two sides** — the writer sent however
 *   many there were, the reader stopped at 32. Above that the whole snapshot came out
 *   shifted, and the guest's duel became noise.
 *
 * ## How it tests
 *
 * By assembling a **fake world where everything is different**: each field receives a
 * distinct, improbable value, chosen so that a byte shift cannot go unnoticed. Zeros and
 * repeated values are the enemy here — two fields swapped with the same value inside look
 * right.
 *
 * `Match` is duck-typed: `encodeSnapshot` only reads simple fields, so there is no need to
 * assemble a real ship (or a screen, which is what allows running this outside the
 * browser).
 */

import * as THREE from 'three';
import { MAX_BREACHES } from '../shared/protocol';
import { wrapAngle } from '../src/core/MathUtils';
import type { Match } from '../src/game/Match';
import type { MatchEvent } from '../src/game/MatchEvents';
import { encodeSnapshot } from '../src/net/snapshotCodec';
import { createWorldState, decodeSnapshot } from '../src/net/WorldState';

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
 * Each quantity's tolerance, in its own units.
 *
 * It comes out of `QUANT`'s quantization scale, with some rounding slack: the format **is**
 * lossy, and demanding exact equality would be failing the design instead of testing it.
 * What gets proved here is that the loss fits where it was designed to fit.
 */
const TOLERANCE = {
  angle: 1e-4,
  quaternion: 1e-4,
  velocity: 5e-3,
  angular: 1e-3,
  local: 5e-3,
  breach: 3e-3,
  /** One byte over 0..1. */
  byte: 3e-3,
  /** Fraction of the day over `u16`. */
  timeOfDay: 2e-5,
} as const;

/** One value per field, all different. See the header. */
function makeShip(seed: number) {
  const n = (offset: number) => seed + offset;
  const orientation = new THREE.Quaternion()
    .setFromEuler(new THREE.Euler(n(0.11), n(0.23), n(0.07), 'YXZ'))
    .normalize();

  return {
    body: {
      comPosition: new THREE.Vector3(n(120.5), n(1.25), n(-340.75)),
      orientation,
      velocity: new THREE.Vector3(n(3.5), n(-0.75), n(2.25)),
      angularVelocity: new THREE.Vector3(n(0.35), n(-0.15), n(0.55)),
    },
    rudder: { wheelAngle: n(0.85) },
    cannonballs: 137 + seed,
    planks: 41 + seed,
    anchor: { state: seed === 0 ? 'dropping' : 'raising', deploy: seed === 0 ? 0.25 : 0.75 },
    cannons: [
      { traverse: n(0.21), elevation: n(0.33), state: 'loading', loadProgress: 0.44, recoil: 0.19 },
      { traverse: n(-0.17), elevation: n(0.09), state: 'loaded', loadProgress: 1, recoil: 0.31 },
    ],
    damage: {
      floodFraction: seed === 0 ? 0.375 : 0.8125,
      sinkTime: seed === 0 ? 2.5 : 0,
      breaches: [] as ReturnType<typeof makeBreach>[],
      patches: [] as ReturnType<typeof makePatch>[],
    },
  };
}

function makeBreach(index: number, seed: number) {
  return {
    id: 1 + index + seed * 40,
    local: new THREE.Vector3(1.1 + index * 0.05, -0.4 + index * 0.03, 2.2 - index * 0.07),
    normal: new THREE.Vector3(0.6, 0.2, -0.77).normalize(),
    area: 0.055 * (1 + (index % 3) * 0.6),
    repair: ((index * 7) % 10) / 10,
  };
}

function makePatch(index: number, seed: number) {
  return {
    id: 200 - index - seed * 30,
    local: new THREE.Vector3(-1.4 + index * 0.06, -0.2 - index * 0.02, -3.1 + index * 0.09),
    normal: new THREE.Vector3(-0.5, 0.1, 0.86).normalize(),
    area: 0.055 * (1 + (index % 4) * 0.5),
  };
}

function makeCrew(seed: number) {
  return {
    controller: {
      local: new THREE.Vector3(0.85 + seed, 1.45 - seed * 0.5, -2.35 + seed),
      // ⚠️ **The first is out of range on purpose, and it is a test case.**
      // 7.5 rad is more than a full turn, and it is exactly what the capstan produces:
      // `followCapstan` adds the swept angle straight into the heading, so each turn of
      // the bars is 2π accumulated. At this scale the `i16` saturates at ±3.2767 —
      // without normalizing before quantizing, this sailor arrives on the other side with
      // his head stuck at 3.2767 rad instead of the equivalent 1.2168. See `crewCases`,
      // which compares the **equivalent** angle and not the raw number.
      yaw: seed === 0 ? 7.5 : -2.5625,
      pitch: seed === 0 ? -0.4375 : 0.6875,
      station: seed === 0 ? 'helm' : 'cannon',
      cannonIndex: seed === 0 ? -1 : 1,
      grounded: seed === 0,
      onLadder: seed !== 0,
      atCapstan: seed === 0,
      // The sea, with opposite values like everything else in this file. Its bit is the
      // **seventh** and closes the body-state byte: a shift there does not misalign the
      // frame, it just makes the opponent swim on the deck.
      inWater: seed === 0,
    },
    // The plank in hand is the only body state that does **not** live in the controller:
    // what sees the breach and the held button on the same step is the interaction. The
    // two sailors with opposite values, like everything else in this file — a boolean
    // field that is the same on both is a field that could be being read from the wrong
    // place without anyone noticing.
    interaction: { patching: seed !== 0 },
  };
}

/** All five event types, each with numbers of its own. */
function makeEvents(): MatchEvent[] {
  return [
    {
      kind: 'shot',
      ship: 1,
      position: new THREE.Vector3(11.5, 3.25, -7.75),
      direction: new THREE.Vector3(0.7, 0.14, -0.7).normalize(),
    },
    { kind: 'splash', position: new THREE.Vector3(-22.5, 0.5, 41.25), speed: 37 },
    {
      kind: 'hull',
      ship: 1,
      position: new THREE.Vector3(5.75, 1.5, -3.25),
      normal: new THREE.Vector3(-0.3, 0.4, 0.86).normalize(),
      speed: 63,
      flooded: true,
    },
    { kind: 'mast', ship: 0, position: new THREE.Vector3(0.25, 8.5, 2.75), speed: 51 },
    { kind: 'collision', position: new THREE.Vector3(-3.5, 0.75, 9.25), speed: 12 },
  ];
}

function makeMatch(breaches: number): Match {
  const ships = [makeShip(0), makeShip(1)];
  for (const [slot, ship] of ships.entries()) {
    for (let i = 0; i < breaches; i++) ship.damage.breaches.push(makeBreach(i, slot));
    for (let i = 0; i < breaches; i++) ship.damage.patches.push(makePatch(i, slot));
  }

  return {
    tick: 987654,
    ships,
    crew: [makeCrew(0), makeCrew(1)],
    netEvents: makeEvents(),
    environment: {
      waveField: {
        windDirection: 1.3125,
        windStrength: 0.625,
        time: 412.5,
        swellDirection: -2.1875,
      },
      weather: {
        current: 'squall',
        target: 'storm',
        windBase: 0.75,
        clouds: 0.875,
        rain: 0.5,
        visibility: 1450,
        flash: 0.25,
      },
      dayNight: { timeOfDay: 0.7365 },
    },
  } as unknown as Match;
}

export function runSnapshotTests(): TestReport {
  const cases: TestCase[] = [];

  const check = (name: string, measured: string, expected: string, ok: boolean, error: string) => {
    cases.push({ name, measured, expected, error: ok ? '—' : error, passed: ok });
  };

  // --- 1. o mundo inteiro sobrevive à ida e volta ------------------------------
  {
    const match = makeMatch(3);
    const world = createWorldState();
    const header = decodeSnapshot(
      encodeSnapshot(match, {
        bufferDepth: 7,
        starved: 3,
        ackTick: 123456,
        includeBreaches: true,
        over: true,
        winner: 1,
      }),
      world,
    );

    check(
      'header · tick, queue, starvation, receipt and outcome',
      header
        ? `tick ${header.tick} · queue ${header.bufferDepth} · starved ${header.starved} · ack ${header.ackTick} · over ${header.over}/${header.winner}`
        : 'did not decode',
      'tick 987654 · queue 7 · starved 3 · ack 123456 · over true/1',
      Boolean(
        header &&
          header.tick === 987654 &&
          header.bufferDepth === 7 &&
          header.starved === 3 &&
          header.ackTick === 123456 &&
          header.over &&
          header.winner === 1,
      ),
      'the header is not what was written',
    );

    const waves = match.environment.waveField;
    const windError = Math.abs(world.windDirection - waves.windDirection);
    // ⚠️ This is the field that was missing, and the case this file exists to have.
    const swellError = Math.abs(world.swellDirection - waves.swellDirection);
    check(
      'sea · wind, strength, clock and **background swell**',
      `wind ±${windError.toExponential(1)} · swell ±${swellError.toExponential(1)} · time ${world.waveTime}`,
      `all three within ${TOLERANCE.angle}, time exact`,
      windError < TOLERANCE.angle &&
        swellError < TOLERANCE.angle &&
        Math.abs(world.windStrength - waves.windStrength) < TOLERANCE.byte &&
        world.waveTime === waves.time,
      'a field of the sea did not cross the wire — the two sides sail different seas',
    );

    const weather = match.environment.weather;
    check(
      'sky · weather, transition, cloud, rain, visibility and flash',
      `${world.sky.current}→${world.sky.target} · cloud ${world.sky.clouds.toFixed(3)} · vis ${world.sky.visibility} · hour ${world.sky.timeOfDay.toFixed(4)}`,
      'squall→storm · cloud 0.875 · vis 1450 · hour 0.7365',
      world.sky.current === weather.current &&
        world.sky.target === weather.target &&
        Math.abs(world.sky.baseWind - weather.windBase) < TOLERANCE.byte &&
        Math.abs(world.sky.clouds - weather.clouds) < TOLERANCE.byte &&
        Math.abs(world.sky.rain - weather.rain) < TOLERANCE.byte &&
        world.sky.visibility === weather.visibility &&
        Math.abs(world.sky.flash - weather.flash) < TOLERANCE.byte &&
        Math.abs(world.sky.timeOfDay - match.environment.dayNight.timeOfDay) < TOLERANCE.timeOfDay,
      'one side sails under a sky the other does not see',
    );

    cases.push(...shipCases(match, world));
    cases.push(...crewCases(match, world));
    cases.push(...eventCases(match, world));
  }

  // --- 2. a hull at the breach ceiling does not misalign the frame -------------
  //
  // The case that broke everything: while writer and reader had different ceilings, a
  // badly beaten hull shifted **all the rest** of the snapshot. The symptom was not one
  // more breach missing; it was the sailor, the opponent and the events read on top of
  // bytes belonging to something else.
  {
    const match = makeMatch(MAX_BREACHES);
    const world = createWorldState();
    const header = decodeSnapshot(
      encodeSnapshot(match, {
        bufferDepth: 2,
        starved: 0,
        ackTick: 42,
        includeBreaches: true,
        over: false,
        winner: 0,
      }),
      world,
    );

    const crew = world.crew[1]!;
    const source = match.crew[1]!.controller;
    // If the bytes had slipped, the sailor — who is read **after** the two damage lists —
    // would come out anywhere but where he is.
    const intact =
      Boolean(header) &&
      world.ships[0]!.breaches?.length === MAX_BREACHES &&
      world.ships[1]!.patches?.length === MAX_BREACHES &&
      crew.station === source.station &&
      crew.local.distanceTo(source.local) < TOLERANCE.local &&
      world.events.length === 5;

    check(
      'ceiling · a hull with a full list does not shift the rest of the frame',
      `breaches ${world.ships[0]!.breaches?.length} · planks ${world.ships[1]!.patches?.length} · station "${crew.station}" · events ${world.events.length}`,
      `${MAX_BREACHES} / ${MAX_BREACHES} / "cannon" / 5`,
      intact,
      'the frame came out shifted: from here on the guest reads bytes belonging to something else',
    );
  }

  // --- 3. without the list, the rest stays in place ----------------------------
  //
  // The damage list is a **conditional** field, and its promise is that the frame reads on
  // its own in both shapes. A reader that consumed the count even when it was not written
  // would shift everything — by the same path, in reverse.
  {
    const match = makeMatch(4);
    const world = createWorldState();
    decodeSnapshot(
      encodeSnapshot(match, {
        bufferDepth: 1,
        starved: 0,
        ackTick: 9,
        includeBreaches: false,
        over: false,
        winner: 0,
      }),
      world,
    );

    const crew = world.crew[0]!;
    const source = match.crew[0]!.controller;
    check(
      'conditional field · a frame without the damage list reads the same',
      `breaches ${world.ships[0]!.breaches} · planks ${world.ships[0]!.patches} · gaze ${crew.yaw.toFixed(4)} · events ${world.events.length}`,
      // 1.2168 and not 7.5: the heading crosses normalized. See `crewCases`.
      'null / null / 1.2168 / 5',
      world.ships[0]!.breaches === null &&
        world.ships[0]!.patches === null &&
        Math.abs(wrapAngle(crew.yaw - source.yaw)) < TOLERANCE.angle &&
        world.events.length === 5,
      'the reader and the writer disagree about when the list is in the frame',
    );
  }

  // --- 4. garbage does not take down the network handler -----------------------
  //
  // A truncated frame (another version, a cut packet) has to become `null`, and not an
  // exception: this runs inside the socket's `onmessage`, and whatever escapes there takes
  // down the whole match's network with nothing showing up on screen.
  {
    const match = makeMatch(2);
    const full = encodeSnapshot(match, {
      bufferDepth: 0,
      starved: 0,
      ackTick: 0,
      includeBreaches: true,
      over: false,
      winner: 0,
    });

    const world = createWorldState();
    let threw = false;
    let refused = 0;
    const truncations = [0, 4, 12, 40, Math.floor(full.byteLength / 2), full.byteLength - 3];
    for (const cut of truncations) {
      try {
        if (decodeSnapshot(full.slice(0, cut), world) === null) refused++;
      } catch {
        threw = true;
      }
    }

    check(
      'truncated frame · becomes null, never an exception',
      `${refused} of ${truncations.length} refused · threw ${threw}`,
      `${truncations.length} refused · threw false`,
      !threw && refused === truncations.length,
      'a bad packet takes down the network handler and the world freezes with no error',
    );
  }

  const failures = cases.filter((entry) => !entry.passed).length;
  return { passed: failures === 0, total: cases.length, failures, cases };
}

/** Every field of every hull, measured against its quantity's tolerance. */
function shipCases(match: Match, world: ReturnType<typeof createWorldState>): TestCase[] {
  const out: TestCase[] = [];

  for (let slot = 0; slot < 2; slot++) {
    const source = match.ships[slot]! as unknown as ReturnType<typeof makeShip>;
    const read = world.ships[slot]!;

    const pose =
      read.position.distanceTo(source.body.comPosition) < 1e-3 &&
      Math.abs(read.orientation.dot(source.body.orientation)) > 1 - TOLERANCE.quaternion &&
      read.velocity.distanceTo(source.body.velocity) < TOLERANCE.velocity &&
      read.angularVelocity.distanceTo(source.body.angularVelocity) < TOLERANCE.angular;

    out.push({
      name: `hull ${slot} · pose, velocity and spin`,
      measured: `pos ±${read.position.distanceTo(source.body.comPosition).toExponential(1)} m · vel ±${read.velocity.distanceTo(source.body.velocity).toExponential(1)} m/s`,
      expected: 'position ±1 mm · velocity ±5 mm/s',
      error: pose ? '—' : 'the hull arrives in a pose different from the one written',
      passed: pose,
    });

    const gear =
      Math.abs(read.wheelAngle - source.rudder.wheelAngle) < TOLERANCE.angle &&
      read.cannonballs === source.cannonballs &&
      read.planks === source.planks &&
      read.anchorState === source.anchor.state &&
      Math.abs(read.anchorDeploy - source.anchor.deploy) < TOLERANCE.byte &&
      Math.abs(read.floodFraction - source.damage.floodFraction) < TOLERANCE.byte &&
      Math.abs(read.sinkTime - source.damage.sinkTime) < 1e-3;

    out.push({
      name: `hull ${slot} · wheel, lockers, anchor and flooding`,
      measured: `shot ${read.cannonballs} · plank ${read.planks} · anchor ${read.anchorState} ${read.anchorDeploy.toFixed(2)} · hold ${read.floodFraction.toFixed(3)}`,
      expected: `${source.cannonballs} · ${source.planks} · ${source.anchor.state} ${source.anchor.deploy} · ${source.damage.floodFraction}`,
      error: gear ? '—' : 'one of the ship states arrives wrong on the other side',
      passed: gear,
    });

    let guns = true;
    for (let i = 0; i < 2; i++) {
      const a = source.cannons[i]!;
      const b = read.cannons[i]!;
      guns &&=
        Math.abs(b.traverse - a.traverse) < TOLERANCE.angle &&
        Math.abs(b.elevation - a.elevation) < TOLERANCE.angle &&
        b.state === a.state &&
        Math.abs(b.loadProgress - a.loadProgress) < TOLERANCE.byte &&
        Math.abs(b.recoil - a.recoil) < TOLERANCE.byte;
    }
    out.push({
      name: `hull ${slot} · both guns (aim, charge and recoil)`,
      measured: `${read.cannons.map((c) => `${c.state} ${c.traverse.toFixed(4)}`).join(' | ')}`,
      expected: `${source.cannons.map((c) => `${c.state} ${c.traverse.toFixed(4)}`).join(' | ')}`,
      error: guns ? '—' : 'the gun on the other side points where it is not pointing',
      passed: guns,
    });

    let damage = read.breaches?.length === source.damage.breaches.length;
    for (let i = 0; damage && i < source.damage.breaches.length; i++) {
      const a = source.damage.breaches[i]!;
      const b = read.breaches![i]!;
      damage &&=
        b.id === a.id &&
        b.local.distanceTo(a.local) < TOLERANCE.breach &&
        b.normal.dot(a.normal) > 0.99 &&
        Math.abs(b.area - a.area) < 1e-3 &&
        Math.abs(b.repair - a.repair) < TOLERANCE.byte;
    }
    damage &&= read.patches?.length === source.damage.patches.length;
    for (let i = 0; damage && i < source.damage.patches.length; i++) {
      const a = source.damage.patches[i]!;
      const b = read.patches![i]!;
      damage &&=
        b.id === a.id &&
        b.local.distanceTo(a.local) < TOLERANCE.breach &&
        b.normal.dot(a.normal) > 0.99 &&
        Math.abs(b.area - a.area) < 1e-3;
    }

    out.push({
      name: `hull ${slot} · open breaches and nailed planks`,
      measured: `${read.breaches?.length} breaches · ${read.patches?.length} planks`,
      expected: `${source.damage.breaches.length} · ${source.damage.patches.length}, with position, area and repair`,
      error: damage ? '—' : 'the enemy hull tells a different story from the true one',
      passed: damage,
    });
  }

  return out;
}

function crewCases(match: Match, world: ReturnType<typeof createWorldState>): TestCase[] {
  const out: TestCase[] = [];

  for (let slot = 0; slot < 2; slot++) {
    const crewman = match.crew[slot]! as unknown as ReturnType<typeof makeCrew>;
    const source = crewman.controller;
    const read = world.crew[slot]!;

    // ⚠️ **The heading is compared as an angle, and not as a number.** The wire carries
    // `wrapAngle(yaw)`, so a sailor who has spun more than a full turn arrives on the other
    // side with the **equivalent angle** — which is the right answer, and the only one that
    // fits the `i16`'s range at this scale. Comparing raw would fail the fix.
    const yawError = Math.abs(wrapAngle(read.yaw - source.yaw));

    const ok =
      read.local.distanceTo(source.local) < TOLERANCE.local &&
      yawError < TOLERANCE.angle &&
      Math.abs(read.pitch - source.pitch) < TOLERANCE.angle &&
      read.station === source.station &&
      read.cannonIndex === source.cannonIndex &&
      read.grounded === source.grounded &&
      read.onLadder === source.onLadder &&
      read.atCapstan === source.atCapstan &&
      // The plank's bit shares the byte with the other five body states. A bit shift
      // there does not misalign the frame — it just makes the opponent's body tell the
      // wrong story, which is the kind of defect that stays up for months.
      read.patching === crewman.interaction.patching &&
      read.inWater === source.inWater;

    out.push({
      name: `sailor ${slot} · position, gaze, station and body state`,
      measured: `"${read.station}" gun ${read.cannonIndex} · ground ${read.grounded} ladder ${read.onLadder} capstan ${read.atCapstan} plank ${read.patching} sea ${read.inWater}`,
      expected: `"${source.station}" gun ${source.cannonIndex} · ${source.grounded} ${source.onLadder} ${source.atCapstan} ${crewman.interaction.patching} ${source.inWater}`,
      error: ok ? '—' : 'the sailor on the other side is in a different place, station or pose',
      passed: ok,
    });

    // And one case just for the heading, because the defect it covers is invisible inside
    // the case above: the number **saturates** instead of being slightly wrong, and
    // saturated it is still a plausible angle. Whoever did not normalize here would see
    // the opponent with his head stuck at 187.7° while weighing the anchor — and nothing,
    // not a `NaN` nor an overflow, would say that was what happened.
    out.push({
      name: `sailor ${slot} · a heading out of range survives as the equivalent angle`,
      measured: `${source.yaw.toFixed(4)} rad → ${read.yaw.toFixed(4)} rad · error ${yawError.toExponential(1)}`,
      expected: `${wrapAngle(source.yaw).toFixed(4)} rad (±${TOLERANCE.angle})`,
      error: yawError < TOLERANCE.angle ? '—' : 'the heading saturated on the wire: more than one turn does not fit the `i16` at this scale',
      passed: yawError < TOLERANCE.angle,
    });
  }

  return out;
}

/**
 * The five event types.
 *
 * It matters more than it looks: the events are **the last** thing in the frame and have a
 * variable size per type. A new type written and not read does not only lose that event —
 * it stops the read of every following one, because there is no way to know how many bytes
 * to skip.
 */
function eventCases(match: Match, world: ReturnType<typeof createWorldState>): TestCase[] {
  const source = match.netEvents;
  const read = world.events;

  let ok = read.length === source.length;
  for (let i = 0; ok && i < source.length; i++) {
    const a = source[i]!;
    const b = read[i]!;
    ok &&= a.kind === b.kind;
    if (!ok) break;

    if ('position' in a && 'position' in b) ok &&= b.position.distanceTo(a.position) < 1e-3;
    if ('ship' in a && 'ship' in b) ok &&= a.ship === b.ship;
    if ('speed' in a && 'speed' in b) ok &&= Math.abs(a.speed - b.speed) <= 0.5;
    if (a.kind === 'shot' && b.kind === 'shot') ok &&= b.direction.dot(a.direction) > 0.99;
    if (a.kind === 'hull' && b.kind === 'hull') {
      ok &&= b.normal.dot(a.normal) > 0.99 && a.flooded === b.flooded;
    }
  }

  return [
    {
      name: 'events · all five types, in order and with their fields',
      measured: `${read.length} events: ${read.map((e) => e.kind).join(', ')}`,
      expected: `${source.length}: ${source.map((e) => e.kind).join(', ')}`,
      error: ok ? '—' : 'one event type does not cross, and takes the following ones with it',
      passed: ok,
    },
  ];
}
