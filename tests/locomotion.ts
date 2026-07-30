/**
 * Tests for the body clocks — the properties that hold up body and camera.
 *
 * Runnable in the browser, like the others:
 *
 * ```js
 * const t = await import('/tests/locomotion.ts');
 * console.table(t.runLocomotionTests().cases);
 * ```
 *
 * **What gets proved here, for the stride.** The whole animation rests on one
 * equality: the foot stays planted on the ground through stance *if and only if*
 * the phase advances by distance traveled, and not by time. Written on one
 * line:
 *
 *     phase += (speed × dt) / cycle_distance
 *
 * Out of that falls **one stride per cycle covers exactly the cycle distance**,
 * at any speed and with any blend between walking and running. That is what the
 * first two cases measure, integrating the clock frame by frame instead of
 * checking the formula against itself.
 *
 * The other two cover the phase of the vertical curve, which is where a flipped
 * sign goes unnoticed: the body has to be **low** at contact when walking and
 * **high** at mid-flight when running. Inverted, the camera rises when the foot
 * lands — and the effect reads as "something looks off", never as "the cosine
 * has the wrong sign".
 *
 * **And for the jump.** The air clip is indexed by vertical speed, and out of
 * that falls the property that turned three clips into two: **the standard jump
 * runs through the whole clip exactly once**, from takeoff to contact, without
 * anyone having tuned a duration for it. A clip measured against the clock would
 * land halfway through the apex on a small hop and go around three times on a
 * fall from the mast; this one saturates on its own.
 *
 * The flight is simulated with the **same order of operations** as
 * `PlayerController`, including the detail that bites: the ground is resolved
 * *before* the clock is fed, so on the contact frame the impact speed is already
 * zero. Testing the clock with the speed it "should" see would hide exactly the
 * bug the in-test copy exists to avoid.
 *
 * **And for the helm.** It is the same theorem as the ladder with a different
 * ruler, and the ruler here is the wheel itself: one cycle of the clip covers 45°
 * and the wheel has eight spoke handles, so sweeping the whole travel — stop to
 * stop, one full turn — has to close **exactly eight cycles** and hand the phase
 * back where it started. Translated into what you see: the hand comes back to the
 * same spoke handle. The sweep runs against the real `Rudder`, because it is the
 * `Rudder` that clamps the travel and sets the cadence.
 *
 * And there is the case that only exists in JavaScript: half the travel lives at
 * a negative angle, and `-0.3 % 1` gives `-0.3` in this language. A negative
 * phase written into `.time` comes out as a frame from the end of the clip — the
 * hand jumping a spoke handle as the rudder crosses amidships. The last case
 * measures exactly that, with the number that breaks it.
 *
 * **And for the worn body.** Now that the player sees their own body, two things
 * that had no way of being wrong before can be. The first is the amplitude of the
 * bob: in third person the camera could exaggerate all it wanted, and from inside
 * any exaggeration is the torso sliding under the eye — the cases measure that
 * the height asked for is **the clip's**, at both native speeds. The second is
 * the leg fold for walking backwards, whose hard case is the pure strafe: there
 * the deviation sits pinned at 90° and, without hysteresis, the body would turn
 * around every frame. The test feeds the fold the same deviation 120 times and
 * demands that it not move, entering from both sides.
 *
 * **And for the water.** The two sea clips brought in three things that existed
 * nowhere else in this codebase. The first is a **different origin**: they have
 * `y = 0` at the waterline, and not on the ground under the feet, so the body has
 * to rise 1.44 m for the clip to land where it was built — and the case that
 * measures it is the one that pins down the 12 cm of divergence between the
 * physics and the clip (see `waterPoseY`). The second is the **sum of the
 * weights**: until now the stations were exclusive by luck, and the water forced
 * them to be exclusive by construction; the case measures the sum frame by frame
 * over a whole run of deck→sea→ladder→deck, which is where all four transitions
 * happen. The third is the **handover of the phase**: while the clips did not
 * exist, the one drawing the swim was the walk, and the case that proved the
 * borrowing now proves the handover did not move a single cadence.
 */

import * as THREE from 'three';
import { GRAVITY, wrapAngle } from '../src/core/MathUtils';
import { InputBit, createInputFrame, type InputFrame } from '../src/core/InputFrame';
import { foldLegHeading } from '../src/player/FirstPersonBody';
import { poseBudget, waterPoseY } from '../src/player/PlayerAvatar';
import {
  PlayerController,
  SWIM_SUBMERSION,
  type RemoteCrewPose,
} from '../src/player/PlayerController';
import type { Ship } from '../src/ship/Ship';
import {
  CLIMB_CLIP,
  ClimbClock,
  FLOAT_CLIP,
  GaitClock,
  HELM_CLIP,
  HelmClock,
  JUMP_SPEED,
  JumpClock,
  LAND_CLIP,
  RUN_CLIP,
  RUN_DISTANCE,
  SWIM_CLIP,
  SWIM_DISTANCE,
  SwimClock,
  WALK_CLIP,
  WALK_DISTANCE,
} from '../src/player/Locomotion';
import {
  BOARDING_LADDERS,
  BOARDING_RUNG_RADIUS,
  boardingLadderStandX,
  boardingLadderX,
  insideGangway,
} from '../src/ship/BoardingLadder';
import { MAX_WHEEL, Rudder } from '../src/ship/Rudder';
import { ShipBody } from '../src/ship/ShipBody';
import {
  QUARTERDECK_Y,
  deckHalfWidth,
  halfWidthAtHeight,
  zToT,
} from '../src/ship/ShipDimensions';
import { MAST_LADDER } from '../src/ship/ShipParts';
import type { WaveField } from '../src/world/WaveField';

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
 * Runs the clock until it settles and returns the distance covered per cycle.
 *
 * The measurement goes **from wrap to wrap**, and not over some arbitrary
 * interval. The first version divided the distance of 6 s by the number of whole
 * wraps inside it; since 6 s does not close a whole number of cycles, a piece of
 * stride was left over in the numerator and the result came out 6% low. The code
 * was right and the test wrong — the cheapest way there is to lose an afternoon.
 */
function distancePerCycle(speed: number, dt = 1 / 240): { distance: number; cycles: number } {
  const gait = new GaitClock();

  // Half a second for the blend to converge: it is damped, and measuring during
  // the convergence would measure the damper, not the stride.
  for (let t = 0; t < 0.5; t += dt) gait.update(dt, speed, true);

  let closed = 0;                           // only cycles that closed
  let pending = 0;                          // the cycle in progress
  let cycles = 0;
  let counting = false;
  let previous = gait.phase;

  for (let t = 0; t < 8; t += dt) {
    gait.update(dt, speed, true);
    const wrapped = gait.phase < previous;
    previous = gait.phase;

    if (wrapped && !counting) {
      counting = true;                      // starts counting on the first wrap
      continue;
    }
    if (!counting) continue;

    pending += speed * dt;
    if (wrapped) {                          // closed: only now is it a measure
      closed += pending;
      pending = 0;
      cycles++;
    }
  }
  return { distance: closed / cycles, cycles };
}

interface FlightLog {
  /** Time between leaving the ground and contact, in seconds. */
  flight: number;
  /** Phase of the air clip on the frame where the rise turned into a fall. */
  phaseAtApex: number;
  /** Phase of the air clip on the last frame before contact. */
  phaseAtContact: number;
  /** Largest sum of weights seen on any frame of the flight. */
  peakWeight: number;
  /** Frames where air and landing had weight at the same time. */
  overlap: number;
  /** Strength of the landing triggered at contact. */
  impact: number;
}

/**
 * Simulates a fall from `fromHeight` meters, optionally with an initial impulse.
 *
 * Reproduces the `PlayerController` loop in the order it happens: gravity,
 * integration, ground, and **only then** the clock. A standard jump is
 * `simulateFall(0, JUMP_SPEED)`; the fall from the crow's nest is
 * `simulateFall(9)`.
 */
function simulateFall(fromHeight: number, launch = 0, dt = 1 / 60): FlightLog {
  const clock = new JumpClock();
  let y = fromHeight;
  let vy = launch;
  let grounded = false;
  let rising = launch > 0;

  const log: FlightLog = {
    flight: 0,
    phaseAtApex: 0,
    phaseAtContact: 0,
    peakWeight: 0,
    overlap: 0,
    impact: 0,
  };

  for (let t = 0; t < 12; t += dt) {
    if (!grounded) {
      vy -= GRAVITY * dt;
      y += vy * dt;
    }

    const peaked = rising && vy <= 0;
    if (peaked) rising = false;

    const wasAirborne = !grounded;
    if (vy <= 0 && y <= 0) {
      // Read before `update`, which is where it still exists: the clock never
      // gets to see this phase, it only left it recorded on the previous frame.
      if (wasAirborne) log.phaseAtContact = clock.airPhase;
      y = 0;
      vy = 0;
      grounded = true;
    }

    clock.update(dt, vy, grounded);

    if (peaked) log.phaseAtApex = clock.airPhase;
    log.peakWeight = Math.max(log.peakWeight, clock.air + clock.land);
    if (clock.air > 1e-4 && clock.land > 1e-4) log.overlap++;
    if (grounded && wasAirborne) {
      log.flight = t + dt;
      log.impact = clock.impact;
      // Another half second on the ground: what the landing needs to run and go.
      for (let u = 0; u < 0.5; u += dt) {
        clock.update(dt, 0, true);
        log.peakWeight = Math.max(log.peakWeight, clock.air + clock.land);
        if (clock.air > 1e-4 && clock.land > 1e-4) log.overlap++;
      }
      break;
    }
  }

  return log;
}

interface HelmSweep {
  /** Spoke handles the hand changed over the run: one phase wrap per handle. */
  cycles: number;
  /** Phase at the end of the travel. */
  phase: number;
  /** Lowest phase seen on any frame. Negative here is modulo leaking. */
  minPhase: number;
  /** Frames the travel took, at the wheel's real cadence. */
  frames: number;
}

/**
 * Turns the wheel from one stop to the other and integrates the helm clock frame
 * by frame.
 *
 * Uses the game's `Rudder`, and not a ramp written by hand: it is the `Rudder`
 * that clamps the travel at `MAX_WHEEL` and knows how far the wheel moves per
 * second. A test that reproduced that arithmetic would be measuring its own copy
 * — the same reason the ladder case reads the spacing off the real ladder.
 *
 * @param direction +1 turns to starboard, -1 to port.
 */
function sweepWheel(direction: 1 | -1, dt = 1 / 60): HelmSweep {
  const rudder = new Rudder();
  const clock = new HelmClock();

  // From the opposite stop, so the run is the whole travel and not a piece of it.
  rudder.wheelAngle = -direction * MAX_WHEEL;
  clock.update(dt, true, rudder.wheelAngle);

  const sweep: HelmSweep = {
    cycles: 0,
    phase: clock.phase,
    minPhase: clock.phase,
    frames: 0,
  };
  let previous = clock.phase;

  // What ends the loop is the `Rudder`'s clamp: reaching the stop is reaching the
  // end of the travel. The last frame is partial on purpose — the wheel does not
  // take a whole number of frames to go from one stop to the other, and that is
  // exactly where a rounding error would show up.
  while (rudder.wheelAngle * direction < MAX_WHEEL && sweep.frames < 600) {
    rudder.update(direction, dt);
    clock.update(dt, true, rudder.wheelAngle);
    // Starboard raises the phase and port lowers it, so the end of the cycle
    // switches sides with it: always counting "it dropped" would find one wrap per
    // frame on the way down.
    if (direction > 0 ? clock.phase < previous : clock.phase > previous) sweep.cycles++;
    previous = clock.phase;
    sweep.minPhase = Math.min(sweep.minPhase, clock.phase);
    sweep.frames++;
  }

  sweep.phase = clock.phase;
  return sweep;
}

/**
 * The hull the deckhand needs, and nothing beyond it.
 *
 * `applyRemoteStep` touches the ship for one thing and one thing only — the helm
 * angle, which is the ruler of the steering clip. `fixedUpdate` asks for a little
 * more: the controls it zeroes every step, gravity rotated into the hull's frame,
 * the heading and the two conversions between ship and world. Building a real
 * `Ship` here would drag canvas texture generation in with it, and the test would
 * stop running outside the browser for nothing.
 *
 * **The hull sits still at the origin, with no heel and no yaw**, and that is on
 * purpose: this way `local` and world are the same number, and a case that talks
 * in meters can be read in either one without mental translation. What is being
 * measured here is the deckhand, not the ship.
 */
function fakeShip(wheelAngle = 0): Ship {
  const copy = (from: THREE.Vector3, to: THREE.Vector3): THREE.Vector3 => to.copy(from);
  return {
    rudder: { wheelAngle },
    heading: 0,
    controls: { capstanTurns: 0, pumping: false, wheel: 0 },
    anchor: { state: 'stowed' },
    body: {
      // Still: this way the castaway's world velocity is his own, and not the sum
      // with the hull's. A moving hull here would measure the sum — which is what
      // the case for the opponent in the water measures, just below, with a
      // `body.velocity` of its own.
      velocity: { x: 0, y: 0, z: 0 },
      localToWorld: copy,
      worldToLocal: copy,
      localDirToWorld: copy,
      worldDirToLocal: copy,
    },
  } as unknown as Ship;
}

/**
 * The test's sea: a still sheet at `y = 0`.
 *
 * A real wave here would measure `WaveField`, which already has its own tests.
 * What these cases need from the sea is a **surface**, and a flat surface is the
 * only one against which "the feet sit 1.44 m below it" can be written down and
 * the number demanded.
 */
function flatSea(): WaveField {
  return { sampleHeight: () => 0 } as unknown as WaveField;
}

/** An empty input frame, reused. Nothing here allocates per step. */
function idleFrame(): InputFrame {
  return createInputFrame();
}

/**
 * Runs the local deckhand for `seconds`, with the same input on every step.
 *
 * This is the game loop, and not a reproduction of it: it calls the real
 * `fixedUpdate`, with the same fixed step. That is what makes these cases cover
 * the resolvers, the fall, the entry into the water and the swim together, instead
 * of each piece against itself.
 */
function stepPlayer(
  controller: PlayerController,
  frame: InputFrame,
  seconds: number,
  ship = fakeShip(),
  waves = flatSea(),
  dt = 1 / 60,
): void {
  const steps = Math.round(seconds / dt);
  for (let i = 0; i < steps; i++) controller.fixedUpdate(dt, frame, ship, waves);
}

/**
 * Stands the sailor in the gangway's opening, facing outboard.
 *
 * `x` halfway to the edge so the body has to **walk** to it: a test that was born already
 * outside the hull would prove that the clamping does not exist, not that it opened in the
 * right place.
 */
function atGangway(side: 1 | -1): PlayerController {
  const controller = new PlayerController();
  controller.spawn();
  const spec = BOARDING_LADDERS[0]!;
  controller.local.set(side * 0.9, QUARTERDECK_Y, spec.z);
  // Outboard: the heading looks toward (−sin, −cos), so starboard is −π/2.
  controller.yaw = side > 0 ? -Math.PI / 2 : Math.PI / 2;
  return controller;
}

/** One frame walking forward at full throttle. */
function walkForward(): InputFrame {
  const frame = idleFrame();
  frame.moveY = 1;
  frame.held = InputBit.MoveForward;
  return frame;
}

/**
 * Crosses the gangway and falls into the sea, measuring the two halves separately.
 *
 * The dividing line is `grounded`: while there is deck under the foot it is walking, and
 * from the frame it disappears it is falling. Separating them is what allows demanding of
 * the second what gravity demands, with no walking in the middle — and the walking has no
 * fixed duration, because it starts with `GROUND_CONTROL`'s acceleration.
 *
 * The key is **released** during the fall, which is what a player does: nobody holds W
 * after having already left the ship. Holding it would push the body another 1.7 m
 * outboard while it falls, which is a choice of the test and not of the game.
 */
function fallOverboard(
  controller: PlayerController,
  ship: Ship,
  waves: WaveField,
  dt = 1 / 60,
): { walk: number; fall: number } {
  const forward = walkForward();
  const idle = idleFrame();
  let walk = 0;
  let fall = 0;

  for (let i = 0; i < 600 && controller.grounded; i++) {
    controller.fixedUpdate(dt, forward, ship, waves);
    walk += dt;
  }
  for (let i = 0; i < 600 && !controller.inWater; i++) {
    controller.fixedUpdate(dt, idle, ship, waves);
    fall += dt;
  }

  return { walk, fall };
}

/**
 * The pose as the test needs it: writable.
 *
 * `RemoteCrewPose` is read-only because whoever receives it may not alter it — it is the
 * other side's authoritative state. Here it is the opposite: we are the other side.
 */
type MutablePose = { -readonly [K in keyof RemoteCrewPose]: RemoteCrewPose[K] };

/** The remote sailor's starting pose, where he is born. */
function remotePose(controller: PlayerController): MutablePose {
  return {
    local: controller.local.clone(),
    yaw: controller.yaw,
    pitch: 0,
    station: 'deck',
    cannonIndex: -1,
    grounded: true,
    onLadder: false,
    atCapstan: false,
    patching: false,
    inWater: false,
  };
}

/**
 * The opponent walking in a straight line, fed the way the network feeds him: only the
 * pose, one step at a time, never saying what speed he is going.
 *
 * It returns the distance each stride cycle covered, measured **between phase crossings**
 * — as `distancePerCycle` does for the local body, and for the same reason: a partial
 * cycle at the start or the end would contaminate the average.
 */
function remoteWalkCycle(speed: number, seconds: number, dt = 1 / 240): number {
  const controller = new PlayerController();
  controller.spawn();
  const pose = remotePose(controller);
  const ship = fakeShip();

  let travelled = 0;
  let previous = controller.gait.phase;
  let first = -1;
  let last = 0;
  let crossings = 0;

  const steps = Math.round(seconds / dt);
  for (let i = 0; i < steps; i++) {
    // Forward is −Z in the ship's frame, as in `updateOnFoot`.
    pose.local.z -= speed * dt;
    travelled += speed * dt;
    controller.applyRemoteStep(dt, pose, ship);

    if (controller.gait.phase < previous) {
      crossings++;
      if (first < 0) first = travelled;
      last = travelled;
    }
    previous = controller.gait.phase;
  }

  return crossings > 1 ? (last - first) / (crossings - 1) : 0;
}

export function runLocomotionTests(): TestReport {
  const cases: TestCase[] = [];

  function check(name: string, measured: number, expected: number, tolerance: number,
                 unidade: string): void {
    const error = Math.abs(measured - expected);
    cases.push({
      name,
      measured: `${measured.toFixed(4)} ${unidade}`,
      expected: `${expected.toFixed(4)} ${unidade}`,
      error: error.toFixed(5),
      passed: error <= tolerance,
    });
  }

  // 1. At the walk's native speed, the cycle has to cover exactly the walk clip's
  //    distance — no more, no less.
  const walk = distancePerCycle(WALK_CLIP.speed);
  check('a stride at 1.65 m/s covers the distance of the walk clip',
    walk.distance, WALK_DISTANCE, 0.02, 'm');

  // 2. The same for the run. Between the two, the distance is interpolated, and that is
  //    why the foot does not skate in the middle of the blend.
  const run = distancePerCycle(RUN_CLIP.speed);
  check('a stride at 3.67 m/s covers the distance of the run clip',
    run.distance, RUN_DISTANCE, 0.03, 'm');

  // 3. Walking, the body is at its lowest at contact (phase 0), which is when the legs
  //    are furthest apart.
  const walking = new GaitClock();
  for (let t = 0; t < 1; t += 1 / 60) walking.update(1 / 60, WALK_CLIP.speed, true);
  walking.phase = 0;
  check('walking, the body is at its low point at contact', walking.bounce, -1, 0.001, '');

  walking.phase = 0.25;
  check('walking, the body is at its high point at passing', walking.bounce, 1, 0.001, '');

  // 4. Running, the low point migrates to mid-stance — the leg has become a spring. At
  //    contact the body is no longer at the bottom.
  const running = new GaitClock();
  for (let t = 0; t < 2; t += 1 / 60) running.update(1 / 60, RUN_CLIP.speed * 1.5, true);
  running.phase = RUN_CLIP.bouncePhase;
  check('running, the body is at its low point at mid-stance', running.bounce, -1, 0.01, '');

  running.phase = RUN_CLIP.bouncePhase + 0.25;
  check('running, the body is at its high point at mid-flight', running.bounce, 1, 0.01, '');

  // 5. Standing still, the phase freezes: without this the character "walks in place"
  //    while the camera sways on its own.
  const still = new GaitClock();
  for (let t = 0; t < 0.5; t += 1 / 60) still.update(1 / 60, 2.8, true);
  const frozen = still.phase;
  for (let t = 0; t < 1; t += 1 / 60) still.update(1 / 60, 0, true);
  check('standing still, the phase does not advance', still.phase, frozen, 1e-9, '');

  // 6. And the locomotion fades on its own. It is what makes the character drop the
  //    running pose when taking the helm: whoever is at a station feeds the clock zero
  //    speed, and the idle takes over by weight. Without this he stays frozen in a
  //    running frame behind the wheel.
  const settling = new GaitClock();
  for (let t = 0; t < 1; t += 1 / 60) settling.update(1 / 60, RUN_CLIP.speed, true);
  for (let t = 0; t < 1; t += 1 / 60) settling.update(1 / 60, 0, true);
  check('locomotion fades out one second after stopping', settling.moving, 0, 0.001, '');

  // -- the jump ----------------------------------------------------------------

  // 7. The central property: the game's jump runs through the air clip end to end, once
  //    only. Nobody tuned the clip's duration for that — it falls out of the phase being
  //    read from the vertical speed, with the takeoff speed as the scale.
  //
  //    The tolerance is **derived**, not chosen: the phase is sampled once per frame, and
  //    one frame of fall is worth this much phase. Tightening it would demand of the clock
  //    a resolution the game loop does not have, and loosening it would let a real error
  //    through. See `distancePerCycle`'s note about the afternoon you lose to a wrong test
  //    on right code.
  const FRAME_PHASE = (GRAVITY * (1 / 60)) / (2 * JUMP_SPEED);

  const jump = simulateFall(0, JUMP_SPEED);
  check('a standard jump flies for 0.67 s', jump.flight, (2 * JUMP_SPEED) / GRAVITY, 0.03, 's');
  check('at the apex, the air clip is halfway through',
    jump.phaseAtApex, 0.5, FRAME_PHASE, '');
  // Twice as much here: the body crosses the deck in the **middle** of a frame, so the
  // last point sampled in the air is further from contact than the apex one is from the
  // top.
  check('at contact, the air clip has reached its end',
    jump.phaseAtContact, 1, 2 * FRAME_PHASE, '');

  // 8. Falling nine meters breaks nothing: the phase saturates and the body spends the
  //    whole fall on the last frame, legs extended waiting for the deck. It is what allows
  //    a single clip for any height.
  const drop = simulateFall(9);
  check('a fall from the mast saturates the air phase', drop.phaseAtContact, 1, 1e-9, '');
  check('a fall from the mast gives a full landing', drop.impact, 1, 1e-9, '');

  // 9. And the game's own jump is the reference for a full landing: falling nine meters
  //    cannot hit harder than that, because there is only one clip. The comparison is
  //    against the fall, and not against 1, because the stored speed is the last frame's
  //    *in the air* and not the contact one — the clock never gets to see the second, and
  //    that one-frame difference is precisely what the in-test copy exists not to lose
  //    entirely.
  check('a standard jump lands as hard as a fall from the mast',
    jump.impact, drop.impact, 0.1, '');

  // 10. A four-centimeter stumble, on the other hand, is no landing at all. Without this
  //     floor, any unevenness in the deck would make the character crouch.
  const stumble = simulateFall(0.04);
  check('a 4 cm stumble does not trigger a landing', stumble.impact, 0, 1e-9, '');

  // 11. The weights are a partition, not a loose sum: the air reaches 1 in flight and
  //     nothing ever goes past that. What went above 1 Three would take out of the
  //     locomotion; what was missing it would fill with the rig's T-pose.
  check('in flight, the air clip reaches full weight', jump.peakWeight, 1, 0.001, '');
  check('air and landing never carry weight on the same frame', jump.overlap, 0, 0, ' frames');

  // 12. The landing is the only one of the two that runs on the clock, and it ends
  //     together with the clip — it does not stay half-crouched forever.
  const landing = new JumpClock();
  for (let t = 0; t < 0.3; t += 1 / 60) landing.update(1 / 60, -JUMP_SPEED, false);
  landing.update(1 / 60, 0, true);
  const firstFrame = landing.land;
  for (let t = 0; t < LAND_CLIP.cycle; t += 1 / 60) landing.update(1 / 60, 0, true);
  check('the landing starts at full weight', firstFrame, 1, 0.05, '');
  check('the landing ends together with the clip', landing.land, 0, 1e-9, '');

  // 13. Grabbing the ladder takes the feet off the floor without anyone flying. It is the
  //     case `settle` covers: feeding `update` with `grounded` there would make the
  //     character land in mid-air, nine meters above the deck.
  const ladder = new JumpClock();
  for (let t = 0; t < 0.3; t += 1 / 60) ladder.update(1 / 60, -JUMP_SPEED, false);
  for (let t = 0; t < 0.5; t += 1 / 60) ladder.settle(1 / 60);
  check('grabbing the ladder puts out the air clip', ladder.air, 0, 0.001, '');
  ladder.update(1 / 60, 0, true);
  check('reaching the nest does not trigger a landing', ladder.land, 0, 1e-9, '');

  // -- the ladder --------------------------------------------------------------

  // 14. The climb's central property, twin of the stride: climbing one cycle's height
  //     turns the clip exactly one revolution. It is what keeps the hand still on the rung
  //     while the body climbs, at any `CLIMB_SPEED`.
  const climb = new ClimbClock();
  climb.phase = 0;
  const steps = 600;
  for (let i = 0; i < steps; i++) climb.update(1 / 60, true, CLIMB_CLIP.rise / steps);
  check('climbing one cycle closes one revolution of the phase', climb.phase, 0, 1e-9, '');

  // 15. And the revolution happens at the right height **on the real ladder**: after
  //     aligning once, the rung the clip tells the hand to grab coincides with a drawn
  //     ratline, all the way up the mast. This is the test that ties the animation to the
  //     ship's geometry — if somebody touches the ladder's spacing or the nest's height
  //     without regenerating the clip, it breaks here.
  const aligned = new ClimbClock();
  let feet = MAST_LADDER.bottomY;
  aligned.align(feet, MAST_LADDER.bottomY, MAST_LADDER.rungSpacing);

  let worstMiss = 0;
  for (let i = 0; i < 2000; i++) {
    const rise = 0.004;                       // ~ one frame at 0.24 m/s
    feet += rise;
    aligned.update(1 / 60, true, rise);
    if (feet > MAST_LADDER.topY) break;
    // The height, on the ship, of the rung the left foot is holding right now.
    const held = feet + CLIMB_CLIP.footRung - CLIMB_CLIP.rise * aligned.phase;
    const u = (held - MAST_LADDER.bottomY) / MAST_LADDER.rungSpacing;
    const fraction = ((u % 1) + 1) % 1;
    worstMiss = Math.max(worstMiss,
      Math.min(fraction, 1 - fraction) * MAST_LADDER.rungSpacing);
  }
  check('the hand lands on a rung along the 9 m of ladder', worstMiss, 0, 0.001, 'm');

  // 16. Going down is the same clip in reverse: climbing and coming back returns the phase
  //     to where it started. It is what does away with a second clip — and what guarantees
  //     the descent's contacts land on the same grid of rungs as the climb's.
  const reversible = new ClimbClock();
  reversible.phase = 0.37;
  for (let i = 0; i < 120; i++) reversible.update(1 / 60, true, 0.01);
  for (let i = 0; i < 120; i++) reversible.update(1 / 60, true, -0.01);
  check('going down undoes the climb at the same phase', reversible.phase, 0.37, 1e-9, '');

  // 17. Still on the ladder the phase freezes: the character stays gripping exactly where
  //     he was, without sliding. It is the reason there is no "hold" clip.
  const holding = new ClimbClock();
  for (let i = 0; i < 60; i++) holding.update(1 / 60, true, 0.02);
  const held = holding.phase;
  for (let i = 0; i < 120; i++) holding.update(1 / 60, true, 0);
  check('still on the ladder, the phase does not move', holding.phase, held, 1e-9, '');

  // 18. And letting go of the ladder puts the clip out without touching the phase —
  //     whoever grabs on again higher up does not restart the cycle from zero.
  const released = new ClimbClock();
  for (let i = 0; i < 60; i++) released.update(1 / 60, true, 0.02);
  const frozenPhase = released.phase;
  for (let i = 0; i < 90; i++) released.update(1 / 60, false, 0);
  check('letting go of the ladder puts out the weight', released.weight, 0, 0.001, '');
  check('letting go of the ladder preserves the phase', released.phase, frozenPhase, 1e-9, '');

  // -- the helm ----------------------------------------------------------------

  // 19. The helm's central property, twin of the ladder's: the wheel turns exactly one
  //     revolution from stop to stop, and one revolution is the eight handles. Sweeping the
  //     whole travel has to close eight cycles and return the phase to where it started —
  //     which is the same as saying the hand comes back to the **same handle**.
  //
  //     This is the test that ties the clip to the drawn wheel: if somebody changes
  //     `MAX_WHEEL` or the number of handles without regenerating the animation, it breaks
  //     here, exactly as the ladder's case breaks if the spacing changes.
  const starboard = sweepWheel(1);
  check('the wheel goes stop to stop in eight handles', starboard.cycles, 8, 0, ' handles');
  check('and the hand comes back to the same handle', starboard.phase, 0, 1e-9, '');

  // 20. The way back is the same clip with the phase running backward — that is what does
  //     away with a second clip and what guarantees that the contacts of a turn to port
  //     land on the same eight handles as a turn to starboard.
  const port = sweepWheel(-1);
  check('port undoes the same eight handles', port.cycles, 8, 0, ' handles');
  check('and closes the travel at the same phase', port.phase, 0, 1e-9, '');

  // 21. Half the travel lives at a negative angle, and that is where the language bites:
  //     `-0.3 % 1` gives `-0.3` in JS, not `0.7`. A negative phase in `.time` comes out as
  //     a frame from the end of the clip, that is, the hand jumping a whole handle as it
  //     crosses the rudder amidships. The two cases cover the leak from both sides: the
  //     exact number that breaks it, and the whole travel swept.
  const negative = new HelmClock();
  negative.update(1 / 60, true, -0.3 * HELM_CLIP.step);
  check('a wheel to port does not leak a negative phase', negative.phase, 0.7, 1e-9, '');
  check('and no frame of the travel leaks either', port.minPhase, 0, 1e-9, '');

  // 22. Letting go of the helm puts the clip out without touching the phase, like letting
  //     go of the ladder. Here that is free — the phase is a function of the wheel's angle,
  //     and the wheel stays where it was left —, but it is still what makes the helmsman
  //     let go of the wheel instead of walking off across the deck with his hands cupped.
  const helmReleased = new HelmClock();
  helmReleased.update(1 / 60, true, 0.6 * HELM_CLIP.step);
  const helmPhase = helmReleased.phase;
  for (let i = 0; i < 90; i++) helmReleased.update(1 / 60, false, 0);
  check('letting go of the helm puts out the weight', helmReleased.weight, 0, 0.001, '');
  check('letting go of the helm preserves the phase', helmReleased.phase, helmPhase, 1e-9, '');

  // -- the worn body -----------------------------------------------------------

  // 23. The height the camera chases is the **same** one the clip raises. At both native
  //     speeds the bob has to give exactly the amplitude written in Blender: this is where
  //     the camera's invented 4.2 cm disagreed with the walk clip's 2.1 cm, and the
  //     difference showed up as the torso sliding under the eye of whoever wears the
  //     body.
  const bobWalk = new GaitClock();
  for (let t = 0; t < 1; t += 1 / 60) bobWalk.update(1 / 60, WALK_CLIP.speed, true);
  bobWalk.phase = 0.25;
  check('walking, the camera rises what the walk clip rises',
    bobWalk.bounceMeters, WALK_CLIP.bounceAmplitude, 1e-4, 'm');

  const bobRun = new GaitClock();
  for (let t = 0; t < 2; t += 1 / 60) bobRun.update(1 / 60, RUN_CLIP.speed * 1.5, true);
  bobRun.phase = RUN_CLIP.bouncePhase + 0.25;
  check('running, the camera rises what the run clip rises',
    bobRun.bounceMeters, RUN_CLIP.bounceAmplitude, 1e-3, 'm');

  // 24. The pure strafe is the case that breaks a single threshold: the deviation sits
  //     pinned at 90°, and without hysteresis the legs would flip 180° every frame. Fed
  //     the same deviation over and over, the state has to stay where it was — from both
  //     directions.
  let straferForward = false;
  let straferBack = true;
  for (let i = 0; i < 120; i++) {
    straferForward = foldLegHeading(Math.PI / 2, 0, straferForward).reversed;
    straferBack = foldLegHeading(Math.PI / 2, 0, straferBack).reversed;
  }
  check('a pure strafe does not oscillate entering forward', straferForward ? 1 : 0, 0, 0, '');
  check('a pure strafe does not oscillate entering backward', straferBack ? 1 : 0, 1, 0, '');

  // 25. And the flip still happens where it has to: walking backward becomes reverse, and
  //     the flipped heading points back to where the animation knows how to walk.
  const backwards = foldLegHeading(Math.PI, 0, false);
  check('walking backward flips the legs', backwards.reversed ? 1 : 0, 1, 0, '');
  check('and the flipped heading lines up with the torso',
    Math.abs(wrapAngle(backwards.heading - 0)), 0, 1e-9, 'rad');

  // -- the opponent's body -----------------------------------------------------
  //
  // The body the network moves receives no velocity at all: it receives positions, and
  // `applyRemoteStep` derives the rest. The cases below cover the three ways that
  // derivation can come out wrong — and none of them produces an error, an exception or a
  // log.

  // 26. **The opponent's foot does not skate.** It is the same equality as the local
  //     stride, measured from the opposite direction: there the speed is known and the
  //     distance comes out of it; here only the positions arrive, and it is the speed that
  //     is deduced. If the deduction scales wrong — dividing by the wrong dt, for example
  //     —, the cycle stops covering the clip's distance and the other player's foot slides
  //     across the deck. It is the classic networked-character defect.
  check('the opponent stride covers the distance of the walk clip',
    remoteWalkCycle(WALK_CLIP.speed, 6), WALK_DISTANCE, 0.02, 'm');
  check('and the run one, at running speed',
    remoteWalkCycle(RUN_CLIP.speed, 6), RUN_DISTANCE, 0.02, 'm');

  // 27. Taking the helm **teleports** his feet: `takeHelm` writes the helmsman's station,
  //     which can be two meters away. Deriving velocity from that jump would give 120 m/s
  //     for one frame — the opponent tearing off in a running pose, and a landing fired
  //     right afterward when the "flight" ended. The teleport has to zero the velocity, and
  //     the jump has to be settled instead of fed.
  {
    const controller = new PlayerController();
    controller.spawn();
    const pose = remotePose(controller);
    const ship = fakeShip();
    for (let i = 0; i < 30; i++) {
      pose.local.z -= WALK_CLIP.speed / 60;
      controller.applyRemoteStep(1 / 60, pose, ship);
    }

    pose.station = 'helm';
    pose.local.set(0, controller.local.y, controller.local.z + 2);
    controller.applyRemoteStep(1 / 60, pose, ship);

    check('taking the helm does not send the opponent tearing off',
      controller.velocity.length(), 0, 1e-9, 'm/s');
    check('nor make him land on his feet behind the wheel', controller.jump.land, 0, 1e-9, '');
    check('and the body is told about the station change',
      controller.stationChangeCount > 1 ? 1 : 0, 1, 0, '');
  }

  // 28. His jump also comes out of the position, and the air clip is indexed by the
  //     **vertical** speed: at the apex the phase has to be halfway, as in the local jump.
  //     A flipped sign in the derivative puts the opponent falling on the way up and
  //     rising on the way down, with his legs in the wrong pose on both stretches.
  {
    const controller = new PlayerController();
    controller.spawn();
    const pose = remotePose(controller);
    const ship = fakeShip();
    const dt = 1 / 60;
    const groundY = pose.local.y;

    let vertical = JUMP_SPEED;
    let peak = 0;
    pose.grounded = false;
    for (let i = 0; i < 60 && pose.local.y >= groundY; i++) {
      pose.local.y += vertical * dt;
      vertical -= GRAVITY * dt;
      controller.applyRemoteStep(dt, pose, ship);
      // The apex is where the climb turns into a fall.
      if (Math.abs(vertical) < GRAVITY * dt) peak = controller.jump.airPhase;
    }

    check('at the apex of the opponent leap, the air clip is halfway through',
      peak, 0.5, 0.05, '');
    check('and the air clip reached full weight', controller.jump.air, 1, 0.05, '');
  }

  // -- the sea -----------------------------------------------------------------
  //
  // Leaving the ship was **geometrically impossible** until now: `resolveHull` clamped x
  // inside the side every frame, and `surfaceAt` never returned "no floor". The cases below
  // cover the exception that opened that door and everything that goes down through it —
  // and the first of them is what keeps the exception from becoming a hole: the side has to
  // go on being the side everywhere that is not the gangway.
  //
  // They all run the real `fixedUpdate`, with the hull sitting at the origin (see
  // `fakeShip`) and the sea flat at y = 0 (`flatSea`). That way the meters that appear here
  // are the ship's meters, with no translation.

  const spec = BOARDING_LADDERS[0]!;
  const gangwayEdge = deckHalfWidth(zToT(spec.z));

  // 29. **The side goes on being the side.** Half a meter aft of the opening, walking
  //     outboard at full throttle for three seconds — more than twice what it takes to
  //     cover the ship's width —, the body has to stop at the deck's edge and stay there.
  //     Without this case, "opening the gangway" and "erasing the hull's collision" would
  //     pass the same test.
  {
    const controller = atGangway(1);
    controller.local.z = spec.z + spec.gangwayHalfWidth + 0.5;
    stepPlayer(controller, walkForward(), 3);
    // The edge is measured at the **body's** Z, and not the gangway's: half a meter aft of
    // the opening the hull has already narrowed by 14 cm, and demanding the opening's
    // number here would fail the correct clamping.
    const edgeHere = deckHalfWidth(zToT(controller.local.z)) - 0.3;
    check('the side holds whoever tries to leave outside the gangway',
      controller.local.x, edgeHere, 0.01, ' m');
    check('and whoever is outside the opening does not fall', controller.inWater ? 1 : 0, 0, 0, '');
  }

  // 30. **And the gangway lets you through — by way of the sill.** The same gesture, the
  //     same time, one meter to the side. The path has three stretches and all three are
  //     measured: deck to the edge, **platform** over the 28 cm that separate the side from
  //     the foot of the ladder, and the void after it. Without the middle stretch the
  //     player falls into a hole on top of the drawn sill itself, and the ladder is left
  //     with no top you can reach on foot.
  {
    const sillOuter = spec.topX - BOARDING_RUNG_RADIUS;

    // The sill is real floor: standing on it — **outside** the deck's edge, where before
    // this piece there was nothing — the body stays.
    const standing = atGangway(1);
    standing.local.x = (gangwayEdge + sillOuter) * 0.5;
    stepPlayer(standing, idleFrame(), 1);
    check('the gangway sill is floor: the body stops on top of it',
      standing.local.y, spec.exitY, 1e-3, ' m');
    check('and it sits outside the side',
      standing.local.x > gangwayEdge ? 1 : 0, 1, 0, '');
    check('without falling', standing.inWater ? 1 : 0, 0, 0, '');

    // And it ends where the mesh ends: half a meter further, there is nothing.
    const controller = atGangway(1);
    stepPlayer(controller, walkForward(), 3);
    check('through the gangway the player crosses and falls into the water',
      controller.inWater ? 1 : 0, 1, 0, '');
    check('and he passed outside the sill, not just the edge of the deck',
      controller.local.x > sillOuter ? 1 : 0, 1, 0, '');
    check('the gangway is the opening in the plane of the ladder',
      insideGangway(spec.z) && !insideGangway(spec.z + spec.gangwayHalfWidth + 0.5) ? 1 : 0,
      1, 0, '');
    // ⚠️ The sill's ruler is mirrored from `HullGeometry.buildGangways`, and this is the
    // case that fails if one of the two sides changes without the other.
    check('and the sill measures what the mesh draws',
      sillOuter, 2.0412, 1e-3, ' m');
  }

  // 31. **The fall to the water takes as long as the fall takes.** The quarterdeck is
  //     1.74 m above the waterline and the body enters the water when its **feet** cross
  //     the surface, that is after falling that height. `√(2h/g)` is 0.596 s, and the
  //     tolerance is one game step (the surface is crossed in the middle of a step, not at
  //     its edge) plus the time the body takes to walk to the edge.
  {
    const controller = atGangway(1);
    const { fall } = fallOverboard(controller, fakeShip(), flatSea());

    // The tolerance is **derived**, not chosen, and it has two half-step parts. The
    // integration is discrete: the body falls `g·dt²·n(n+1)/2` in n steps, against
    // `g·t²/2` in the continuous case, which brings contact forward by half a step. And
    // the surface is crossed in the **middle** of a step, which delays detection by up to
    // one step. Added together, one and a half game steps.
    const expected = Math.sqrt((2 * QUARTERDECK_Y) / GRAVITY);
    check('the fall from the quarterdeck to the water takes what gravity demands',
      fall, expected, 1.5 / 60, ' s');
  }

  // 32. **In the water the body does not sink, and it is not a clamp that holds it.** The
  //     constraint is a damper against the wave's height, and a damper does not overshoot
  //     its target: the eye stops at `SWIM_EYE_HEIGHT` above the surface and stays there,
  //     with or without a key held. Ten seconds floating and ten swimming, to cover both —
  //     if there were vertical drift, it would show up in twenty seconds.
  {
    const controller = atGangway(1);
    const ship = fakeShip();
    const waves = flatSea();
    fallOverboard(controller, ship, waves);

    // Two seconds for the constraint to settle — it is damped (λ = 8), and measuring
    // during the convergence would measure the damper. The rest height is **not** a chosen
    // number: it is the eye at `SWIM_EYE_HEIGHT` from the surface, with the feet one body
    // below it.
    stepPlayer(controller, idleFrame(), 2, ship, waves);
    const floating = -(1.66 - 0.22);
    check('floating, the feet stop one body below the surface',
      controller.local.y, floating, 1e-3, ' m');

    // The eye is what the player sees. It comes from `syncView` because that is what
    // writes the **frame's** pose, which is the one the camera reads; measuring `local`
    // would prove only the inner half.
    controller.syncView(1, 0, 0, ship);
    check('and the eye sits a little above the waterline',
      controller.eyeLocal.y, 0.22, 1e-3, ' m');

    stepPlayer(controller, idleFrame(), 10, ship, waves);
    check('ten seconds floating do not sink the body',
      controller.local.y, floating, 1e-3, ' m');
    stepPlayer(controller, walkForward(), 10, ship, waves);
    check('and ten swimming do not either',
      controller.local.y, floating, 1e-3, ' m');
  }

  // 33. **The swimming speed is half the walking one.** Measured as distance over time in
  //     steady state, and not by reading the constant: between the key and the movement sit
  //     `AIR_CONTROL`'s damping and the rewrite of `local` from the world position, and it
  //     is the whole chain that has to deliver the number.
  {
    const controller = atGangway(1);
    const ship = fakeShip();
    const waves = flatSea();
    fallOverboard(controller, ship, waves);
    const frame = walkForward();
    // Five seconds for the damper to converge (λ = 1.6 gives 0.03% of error in 5 s), and
    // only then does it start measuring. Swimming **away** from the ship, which is the
    // direction the body fell in: swimming toward it would run into the side in the middle
    // of the measurement.
    stepPlayer(controller, frame, 5, ship, waves);
    const from = controller.local.clone();
    stepPlayer(controller, frame, 4, ship, waves);
    const swum = Math.hypot(controller.local.x - from.x, controller.local.z - from.z);
    check('swimming covers half of what walking covers', swum / 4, 2.8 / 2, 0.02, ' m/s');
  }

  // 34. **Handing the phase over does not change the cadence.** This case was born
  //     proving a loan — while `Float`/`Swim` did not exist in the GLB, what drew the swim
  //     was the walk clip and `SWIM_DISTANCE` *was* its distance, taken on purpose so that
  //     the arrival of the real clips would change nothing. The clips arrived, and
  //     `anim_swim.py` measured a 1.32 m cycle on its own: exactly the same number. The
  //     case still holds word for word, only now it measures the **handover** instead of
  //     the loan — the water's phase and the stride's advance together, frame by frame, at
  //     the same speed.
  {
    const swim = new SwimClock();
    const gait = new GaitClock();
    const steps = 600;
    for (let i = 0; i < steps; i++) {
      swim.update(1 / 60, true, WALK_CLIP.speed);
      gait.update(1 / 60, WALK_CLIP.speed, true);
    }
    const swum = (WALK_CLIP.speed * steps) / 60;
    check('the stroke closes one revolution every cycle distance',
      swim.phase, ((swum / SWIM_DISTANCE) % 1 + 1) % 1, 1e-9, '');
    check('and the water phase moves along with the stride that used to draw it',
      swim.phase, gait.phase, 1e-9, '');
    check('because the two cycle distances are the same number',
      SWIM_DISTANCE, WALK_DISTANCE, 1e-12, ' m');
    check('swimming, the pose is a stroke', swim.stroke, 1, 0.001, '');
    check('and the water weight reaches full', swim.weight, 1, 0.001, '');

    for (let i = 0; i < 120; i++) swim.update(1 / 60, true, 0);
    check('still in the water, the pose becomes a float', swim.stroke, 0, 0.001, '');
    for (let i = 0; i < 120; i++) swim.update(1 / 60, false, 0);
    check('and leaving the sea puts out the weight', swim.weight, 0, 0.001, '');
  }

  // 35. **The boarding ladder's phase matches the grid of rungs over the whole climb.** It
  //     is case 15's theorem again, with the side ladder: after aligning once, the rung the
  //     clip tells the hand to grab has to coincide with a drawn rung from the first to the
  //     last. Except that here there are two more things that can go wrong, and both are
  //     measured: the ladder is **tilted** (the body follows a line that leans away from
  //     plumb) and the spacing was **not rounded** (see `BOARDING_RUNG_SPACING`).
  {
    const aligned = new ClimbClock();
    let feet = spec.bottomY;
    aligned.align(feet, spec.bottomY, spec.rungSpacing);

    let worstMiss = 0;
    let worstStand = 0;
    for (let i = 0; i < 2000; i++) {
      const rise = 0.004;
      feet += rise;
      aligned.update(1 / 60, true, rise);
      if (feet > spec.topY) break;
      const held = feet + CLIMB_CLIP.footRung - CLIMB_CLIP.rise * aligned.phase;
      const u = (held - spec.bottomY) / spec.rungSpacing;
      const fraction = ((u % 1) + 1) % 1;
      worstMiss = Math.max(worstMiss, Math.min(fraction, 1 - fraction) * spec.rungSpacing);
      // And the line the body follows is the rungs' plane plus the standoff, measured
      // perpendicular: 28.1 cm of horizontal setback at 14.11° from plumb.
      worstStand = Math.max(
        worstStand,
        Math.abs(boardingLadderStandX(spec, feet) - boardingLadderX(spec, feet) - 0.28125),
      );
    }
    check('the hand lands on a rung along the 2.43 m of boarding ladder',
      worstMiss, 0, 0.001, 'm');
    check('and the body follows the tilted line, measured perpendicular',
      worstStand, 0, 1e-4, 'm');
    // The tilt the body takes is the ladder's — without it the vertical clip moves the
    // hand off the rung in proportion to the height of the reach.
    check('the boarding ladder is tilted 14.11°',
      (spec.tilt * 180) / Math.PI, 14.110, 0.01, '°');
  }

  // 36. **From the water to the quarterdeck, on his feet.** The whole route in one loop:
  //     fall, swim to the ladder, grab on and climb. What is demanded at the end is what
  //     the player sees — he is **on top of the deck**, at the helm's level, and neither
  //     hanging nor in the water.
  {
    const controller = atGangway(1);
    const ship = fakeShip();
    const waves = flatSea();
    fallOverboard(controller, ship, waves);
    check('he fell into the water before trying to climb', controller.inWater ? 1 : 0, 1, 0, '');

    // He swims back to the hull: the fall carries the body a couple of meters out, and it
    // is the player who has to come back. Turning the heading is turning the head — in the
    // water the swim follows the gaze, as on deck.
    controller.yaw = Math.PI / 2;
    stepPlayer(controller, walkForward(), 3, ship, waves);
    check('swimming back, the side stops him instead of letting him in',
      Math.abs(controller.local.x) >= halfWidthAtHeight(zToT(controller.local.z), 0) ? 1 : 0,
      1, 0, '');

    const reachable = controller.reachableBoardingLadder();
    check('and the ladder on that side is within reach',
      reachable ? 1 : 0, 1, 0, '');
    if (reachable) controller.grabBoardingLadder(reachable);
    check('grabbing on takes the body out of the water', controller.inWater ? 1 : 0, 0, 0, '');
    check('and hangs him on the ladder', controller.onLadder ? 1 : 0, 1, 0, '');
    check('with the body tilted like it',
      controller.ladderTilt, spec.tilt, 1e-9, ' rad');
    check('and facing its side',
      controller.ladderFacing, -Math.PI / 2, 1e-9, ' rad');

    // He climbs until he is no longer hanging, and not for a fixed time: it is 2.43 m at
    // `CLIMB_SPEED`, but what is demanded is the **end** of the climb. The key is released
    // right afterward because, standing on the quarterdeck, "forward" at this heading is
    // walking back out through the same gangway.
    const climb = walkForward();
    for (let i = 0; i < 600 && controller.onLadder; i++) {
      controller.fixedUpdate(1 / 60, climb, ship, waves);
    }
    stepPlayer(controller, idleFrame(), 0.5, ship, waves);

    const exitX = Math.abs(controller.local.x);
    // At the quarterdeck's level: the sill is flush with it, and the 2 mm of slack is the
    // deck's camber, which is worth almost nothing at the edge.
    check('the climb ends standing at the level of the quarterdeck',
      controller.local.y, spec.exitY, 5e-3, ' m');
    check('standing, and not hanging', controller.onLadder ? 1 : 0, 0, 0, '');
    check('nor back in the water', controller.inWater ? 1 : 0, 0, 0, '');
    check('and with his feet on the floor', controller.grounded ? 1 : 0, 1, 0, '');
    // One radius inside the board's edge — the furthest out the body fits without the
    // cylinder going past it. Since the sill only reaches 28 cm beyond the deck's edge and
    // the cylinder has a 30 cm radius, "entirely on the board" does not exist: the body
    // sits **astride the joint**, half on each floor. It is exactly what you do when
    // stepping over a real gangway's sill.
    check('with the body astride the joint between the sill and the deck',
      exitX, spec.topX - BOARDING_RUNG_RADIUS - 0.3, 1e-3, ' m');
    // And from there you can walk into the ship, which is what the sill exists to allow:
    // one step inboard and the floor becomes deck.
    stepPlayer(controller, walkForward(), 0.6, ship, waves);
    check('and from there one step takes him inside the side',
      Math.abs(controller.local.x) < gangwayEdge ? 1 : 0, 1, 0, '');
  }

  // 37. **The rescue clock.** Five seconds, counted from the instant the body enters the
  //     water — and reset by leaving it, which is the part that matters: whoever climbs the
  //     ladder and falls in again does not reach the rescue with credit from the previous
  //     fall. And the rescue happening puts the sailor back at the starting point.
  {
    const controller = atGangway(1);
    const ship = fakeShip();
    const waves = flatSea();
    fallOverboard(controller, ship, waves);
    const entered = controller.waterTime;
    // It is born on the step of the fall, and not before: the clock counts water, not
    // falling.
    check('the water clock is born at the fall', entered, 0, 1e-9, ' s');

    // Until one step short of five seconds, no rescue.
    stepPlayer(controller, idleFrame(), 5 - entered - 2 / 60, ship, waves);
    check('before five seconds there is no rescue',
      controller.canRequestRescue() ? 1 : 0, 0, 0, '');
    stepPlayer(controller, idleFrame(), 4 / 60, ship, waves);
    check('and from then on there is', controller.canRequestRescue() ? 1 : 0, 1, 0, '');
    check('with the clock at five seconds', controller.waterTime, 5, 0.04, ' s');

    const before = controller.rescueCount;
    controller.requestRescue();
    check('the request counts one edge for the screen blackout',
      controller.rescueCount - before, 1, 0, '');
    check('and returns the sailor to the ship', controller.inWater ? 1 : 0, 0, 0, '');
    check('at the starting point', controller.local.z, 1.2, 1e-9, ' m');
    check('with the water clock reset', controller.waterTime, 0, 1e-9, ' s');
  }

  // 38. **The castaway on the other side floats, he does not swim.** The remote body
  //     receives only positions, and in the water those positions are the **ship's**, which
  //     is leaving: an opponent floating still has his `local` running aft at 2.6 m/s.
  //     Feeding the water clock that number puts him doing a crawl across the sea without
  //     going anywhere — and that is exactly what happens without adding the hull's
  //     velocity. The case sets up both sides: hull at 2.6 m/s forward, body still in the
  //     world.
  //
  //     ⚠️ **The quantity measured is the water clock's, and not the stride's.** While the
  //     water clips did not exist, it was `GaitClock` that received the swimming speed and
  //     drew the sea; today it receives zero in the water by construction (see
  //     `updateBob`), and what carries the derived speed is `SwimClock`. Measuring
  //     `gait.speed` here would pass for free and prove nothing.
  {
    const controller = new PlayerController();
    controller.spawn();
    const pose = remotePose(controller);
    pose.inWater = true;
    const ship = fakeShip();
    // The hull moves toward −Z, which is forward in its own frame.
    (ship.body as unknown as { velocity: THREE.Vector3 }).velocity = {
      x: 0,
      y: 0,
      z: -2.6,
    } as THREE.Vector3;

    // Still in the world: the body moves toward +Z **on the ship** exactly as much as the
    // ship moves toward −Z in the world. With the hull not yawing, the two cancel out.
    for (let i = 0; i < 120; i++) {
      pose.local.z += 2.6 / 60;
      controller.applyRemoteStep(1 / 60, pose, ship);
    }
    check('the castaway on the other side does not swim in place',
      controller.swim.speed, 0, 1e-9, ' m/s');
    check('and his stride stays out of the water', controller.gait.moving, 0, 0.001, '');
    check('with the water taking the body', controller.swim.weight, 1, 0.001, '');
    check('in a floating pose', controller.swim.stroke, 0, 0.001, '');

    // And swimming for real — 1.4 m/s in the world, that is 4.0 m/s on the ship — the pose
    // goes back to being a stroke, at the right speed.
    for (let i = 0; i < 120; i++) {
      pose.local.z += (2.6 + 1.4) / 60;
      controller.applyRemoteStep(1 / 60, pose, ship);
    }
    check('and swimming he swims at swimming speed',
      controller.swim.speed, 1.4, 1e-9, ' m/s');
    check('with the pose going back to a stroke', controller.swim.stroke, 1, 0.001, '');
    check('and the stride staying out of it', controller.gait.speed, 0, 1e-12, ' m/s');
  }

  // 39. **The frame the reconciliation compares the swimmer in.**
  //
  //     This is the only case in this file that talks about the network, and it is here
  //     because the quantity it measures belongs to the body, not to the wire: it is the
  //     **difference between two position computations made with different hull poses**.
  //
  //     On deck that never existed. The `local` of whoever walks does not read the hull's
  //     pose at all — the deck is still ground —, so host and guest arrive at the same
  //     number by independent paths and comparing local against local is honest. The water
  //     is the **first** thing in this codebase whose position computation depends
  //     numerically on `ship.body`: the swimmer's `local` *is* the world position converted
  //     by the hull's pose. And the two poses are not the same — the host uses the real one,
  //     the guest uses the one interpolated from the network, delayed by
  //     `lead + INTERP_DELAY` steps. Two identical world positions become different
  //     `local`s, and the reconciliation saw an error that **does not exist in the world**.
  //
  //     The case measures the bias with the ship **yawing**, which is where it grows with
  //     the distance — and the feature's scenario is precisely being left behind while the
  //     ship sails on.
  {
    // These mirror `GuestSession`, as `PROTOCOL_VERSION` mirrors the protocol in
    // `roomServer.mjs`: repeated by hand so that a change over there has to come through
    // here instead of agreeing by construction.
    const ERROR_IGNORE = 0.08;
    const ERROR_SNAP = 1.5;
    const SHIP_SPEED = 2.6;

    const body = new ShipBody({
      mass: 37000,
      centerOfMass: new THREE.Vector3(0, -0.35, 0.2),
      gyration: new THREE.Vector3(2, 4, 2),
      addedMass: new THREE.Vector3(1.9, 1.9, 1.05),
    });

    /** Puts the hull in the pose it had `lag` seconds before now. */
    const poseAt = (lag: number, omega: number): void => {
      body.comPosition.set(0, 0, SHIP_SPEED * lag);
      body.orientation.setFromAxisAngle(new THREE.Vector3(0, 1, 0), -omega * lag);
    };

    /**
     * The bias between the host's computation (the pose of now) and the guest's (the
     * delayed pose), for a castaway sitting still in the world `distance` meters astern.
     */
    const bias = (distance: number, omega: number, lagSteps: number): number => {
      const swimmer = new THREE.Vector3(0, 0, distance);
      const host = new THREE.Vector3();
      const guest = new THREE.Vector3();
      poseAt(0, omega);
      body.worldToLocal(swimmer, host);
      poseAt(lagSteps / 60, omega);
      body.worldToLocal(swimmer, guest);
      return host.distanceTo(guest);
    };

    // With no yaw, the bias is only the hull's translation over the delay — and it **does
    // not depend on the distance**. Thirteen steps is 217 ms, the delay of a good
    // connection (lead 9 plus the 4 of interpolation).
    //
    // With no yaw the bias is exactly the hull's translation over the delay: it is the
    // closed-form answer, and matching it is what proves the test's model is the game's.
    const straight = bias(0, 0, 13);
    check('the frame bias is the translation of the hull over the delay',
      straight, SHIP_SPEED * (13 / 60), 1e-9, ' m');
    check('and it is born far above the band the reconciliation ignores',
      straight > ERROR_IGNORE ? 1 : 0, 1, 0, '');
    check('how many times above', straight / ERROR_IGNORE, 7.042, 0.01, '×');

    // Yawing, it grows with the radius — which is what the scenario produces on its own:
    // at 2.6 m/s the castaway is 26 m behind in ten seconds, and the rescue only opens at
    // five.
    check('at 26 m and half a yaw, the bias passes the legitimate teleport',
      bias(26, 0.4, 13) > ERROR_SNAP ? 1 : 0, 1, 0, '');
    check('and it passes early: seconds of drift before crossing that threshold',
      // The radius at which the bias crosses `ERROR_SNAP`, divided by the ship's speed.
      (() => {
        for (let r = 0; r <= 200; r += 0.05) if (bias(r, 0.4, 13) >= ERROR_SNAP) return r;
        return Infinity;
      })() / SHIP_SPEED,
      6.31, 0.05, ' s');

    // ⚠️ **And the computation in world space has no bias at all — that is the fix.** The
    // host's position is rebuilt with the hull pose that came **in the same packet**, which
    // is the same one it used; the delayed pose the guest has in hand does not enter the
    // computation and therefore cannot contaminate it. Exactly zero, at any yaw and any
    // distance. See `GuestSession.authoritativePosition`.
    let worstWorld = 0;
    for (const omega of [0, 0.1, 0.2, 0.4]) {
      for (const distance of [0, 5, 26, 52, 120]) {
        const swimmer = new THREE.Vector3(0, 0, distance);
        const local = new THREE.Vector3();
        // The host derives the `local` with its own pose...
        poseAt(0, omega);
        body.worldToLocal(swimmer, local);
        // ...and the guest brings it back to world space with **the same** pose, which
        // arrived in the snapshot. What it has in `ship.body` is left out on purpose.
        const rebuilt = new THREE.Vector3();
        body.localToWorld(local, rebuilt);
        worstWorld = Math.max(worstWorld, rebuilt.distanceTo(swimmer));
      }
    }
    check('comparing in world space, the bias disappears entirely',
      worstWorld, 0, 1e-9, ' m');
  }

  // 40. **The reconciliation offset reaches the screen.**
  //
  //     This case exists because of a defect only a `grep` revealed: the offset was
  //     computed, accumulated and decayed inside `GuestSession`, with a public getter
  //     swearing that "the drawing adds it to the position" — and **no file in the project
  //     read that getter**. The reconciliation's middle band (from 8 cm to 1.5 m, where
  //     nearly every real correction lives) was smoothed by nothing: the position was
  //     rewritten raw, fifteen times a second, on deck and in the water. It gave no error,
  //     it did not disappear from the code, and the comment guaranteed the opposite.
  //
  //     What gets proved here is the link: the correction becomes a **visual displacement**
  //     without touching the simulated position, and it fades on its own.
  {
    const controller = new PlayerController();
    controller.spawn();
    const ship = fakeShip();

    // A typical error from the middle band: six centimeters sideways and three forward.
    const correction = new THREE.Vector3(0.06, 0, 0.03);
    const simulated = controller.local.clone();
    controller.absorbViewOffset(correction);

    // The simulation did not move — that is the whole point of the offset.
    check('absorbing an offset does not move the simulated position',
      controller.local.distanceTo(simulated), 0, 1e-12, ' m');

    // But the frame's pose does: on **both** consumers, the body and the eye.
    controller.syncView(1, 0, 0, ship);
    check('but it does move the drawn body',
      controller.visualLocal.distanceTo(simulated), correction.length(), 1e-9, ' m');
    check('and the eye of the camera along with it',
      controller.eyeLocal.y - (controller.visualLocal.y + 1.66), 0, 1e-9, ' m');
    check('in the right direction, and not only at the right distance',
      controller.visualLocal.x - simulated.x, correction.x, 1e-9, ' m');

    // And it fades on its own. λ = 16 → `e^(-3.2)` = 4.1% left after 200 ms; the test
    // integrates frame by frame at 60 Hz, which is how the real loop calls it.
    for (let i = 0; i < 12; i++) controller.decayViewOffset(1 / 60);
    check('and the offset fades in two tenths of a second',
      controller.viewOffset.length() / correction.length(), Math.exp(-3.2), 1e-3, '');
    check('leaving less than 5% of what came in',
      controller.viewOffset.length() / correction.length() < 0.05 ? 1 : 0, 1, 0, '');

    // After a second nothing is left that a pixel can see.
    for (let i = 0; i < 48; i++) controller.decayViewOffset(1 / 60);
    controller.syncView(1, 0, 0, ship);
    check('and a second later the pose is the simulated one again',
      controller.visualLocal.distanceTo(simulated), 0, 1e-4, ' m');
  }

  // 41. **The offset's motion-sickness ceiling.**
  //
  //     An offset that decays exponentially starts off at `λ·|offset|`: with no ceiling, a
  //     1.4 m correction — which **fits** in the smoothed band — would put the first-person
  //     camera at 22 m/s for a few tens of milliseconds, which is worse than the lurch it
  //     is hiding. The ceiling is derived from the one speed the player already knows from
  //     their own body: running.
  {
    const controller = new PlayerController();
    controller.spawn();
    const RUN_SPEED = 4.7;
    const OFFSET_LAMBDA = 16;

    controller.absorbViewOffset(new THREE.Vector3(1.4, 0, 0));
    check('a large offset is clamped before it becomes a slide',
      controller.viewOffset.length(), RUN_SPEED / OFFSET_LAMBDA, 1e-9, ' m');

    // The slide's starting speed, measured the way the loop produces it: one frame of
    // decay divided by its duration.
    //
    // The ceiling is derived from the **instantaneous** value at t = 0, which is
    // `λ·|offset|` = exactly 4.70 m/s. What one frame measures is its *average*, which is
    // smaller because the exponential has already started falling within the frame
    // itself: `(1 − e^(−λ/60))·60` gives 14.04 per meter of offset. Demanding the average
    // against the instantaneous ceiling would loosen the test; the inequality below is the
    // one that matters, and this number is here so the slack between the two is on
    // record.
    const before = controller.viewOffset.length();
    controller.decayViewOffset(1 / 60);
    const speed = (before - controller.viewOffset.length()) * 60;
    check('and the camera never slides faster than the player runs',
      speed <= RUN_SPEED ? 1 : 0, 1, 0, '');
    check('average speed of the first frame of the slide', speed, 4.1255, 1e-3, ' m/s');
    check('and the instantaneous peak is running, by construction',
      before * OFFSET_LAMBDA, RUN_SPEED, 1e-9, ' m/s');

    // A small offset — the case that actually happens — passes through intact.
    controller.viewOffset.set(0, 0, 0);
    controller.absorbViewOffset(new THREE.Vector3(0.05, 0, 0));
    check('and a small offset is not touched by the ceiling',
      controller.viewOffset.length(), 0.05, 1e-9, ' m');
  }

  // 42. **Which ladder the body is on comes out of the position, and not off the wire.** It
  //     is what does away with a bit in the snapshot — and the case measures the clearance
  //     that makes the derivation safe: the ship's two ladders are seven meters apart in Z,
  //     and `insideGangway` separates them with meters to spare on both sides.
  check('the mast is far from the gangway opening',
    Math.abs(MAST_LADDER.z - spec.z), 7.164, 0.01, ' m');
  check('and insideGangway does not confuse the two',
    insideGangway(MAST_LADDER.z) ? 1 : 0, 0, 0, '');

  // -- the water, with the clips in it ------------------------------------------

  // 43. **The stroke is indexed by distance, and the speed factor falls out of it.** It is
  //     case 1's theorem with a different ruler: one cycle of `Swim` covers `SWIM_DISTANCE`
  //     in the sea, at any swimming speed. And out of it falls the number nobody wrote
  //     anywhere — the clip was animated at 1.32 m/s and the game swims at 1.40, so the
  //     phase runs 1.06 cycles per second and the stroke comes out 6% faster than it left
  //     Blender. It is exactly the arithmetic the walk already does (1.65 native, 2.80 in
  //     game, factor 1.70), and it is because it is automatic that **there is no
  //     `timeScale` at all** on either water clip.
  {
    const SWIM_SPEED = 2.8 / 2;
    const swim = new SwimClock();
    const seconds = 8;
    const steps = Math.round(seconds * 60);
    for (let i = 0; i < steps; i++) swim.update(1 / 60, true, SWIM_SPEED);

    const swum = SWIM_SPEED * seconds;
    check('the stroke closes one revolution every 1.32 m swum',
      swim.phase, ((swum / SWIM_DISTANCE) % 1 + 1) % 1, 1e-9, '');
    // Cycles per second is the same as the ratio between the game's speed and the native
    // one — which is the definition of the clip's playback factor.
    check('and the game speed plays the clip 1.06× faster than native',
      SWIM_SPEED / SWIM_DISTANCE, SWIM_SPEED / SWIM_CLIP.speed, 1e-12, ' cycles/s');
    check('value of the factor', SWIM_SPEED / SWIM_CLIP.speed, 1.0606, 1e-4, '×');
    // The native speed is the one `anim_swim.verify` measured, rebuilt here from the
    // clip's two numbers: if somebody reanimates the stroke at another cadence and forgets
    // to bring the pair along, this case fails.
    check('the native speed of the clip is the one from `anim_swim`',
      SWIM_CLIP.speed / SWIM_CLIP.cycle, 1.32, 1e-9, ' m/s');

    // Still, the stroke's phase freezes: the body stays where the last arm left it, as on
    // the ladder, instead of paddling without going anywhere.
    const frozen = swim.phase;
    for (let i = 0; i < 120; i++) swim.update(1 / 60, true, 0);
    check('still in the water, the stroke freezes', swim.phase, frozen, 1e-12, '');
  }

  // 44. **The float is the only water clip that runs on the clock.** Floating has no
  //     quantity in the world to read a phase from — it is breathing, and breathing does
  //     not speed up with the current —, so `Float` is the exception of the same family as
  //     `Carry`: 210 frames at 30 fps, seven seconds per revolution. The case measures the
  //     revolution and measures the thing the exception exists to give: the phase does
  //     **not** restart from zero when the sailor leaves the water and falls in again.
  {
    /** The distance between two phases on a circle — 0.999 and 0.001 are neighbors. */
    const gap = (a: number, b: number): number => {
      const d = Math.abs(a - b) % 1;
      return Math.min(d, 1 - d);
    };

    const swim = new SwimClock();
    for (let i = 0; i < 7 * 60; i++) swim.update(1 / 60, true, 0);
    // The tolerance is **derived**: the phase is added once per frame, and 420 additions
    // of `1/420` do not land exactly on 1 in floating point. What is demanded is that the
    // revolution close within one frame of it.
    check('the float closes one revolution in seven seconds',
      gap(swim.floatPhase, 0), 0, 1 / (60 * FLOAT_CLIP.duration), '');
    check('and the revolution is the length of the clip: 210 frames at 30 fps',
      FLOAT_CLIP.duration, 210 / 30, 1e-9, ' s');

    swim.reset();
    for (let i = 0; i < Math.round(2.1 * 60); i++) swim.update(1 / 60, true, 0);
    const breathing = swim.floatPhase;
    check('and halfway through the loop it is where the time put it',
      breathing, 2.1 / FLOAT_CLIP.duration, 1e-9, '');

    // Out of the water the breathing stops — and stops **where it was**. Whoever grabs the
    // ladder, slips and falls in again does not restart the cycle from the beginning.
    for (let i = 0; i < 90; i++) swim.update(1 / 60, false, 0);
    check('out of the sea the float freezes', swim.floatPhase, breathing, 1e-12, '');
    swim.update(1 / 60, true, 0);
    check('and falling in again picks it up where it stopped',
      swim.floatPhase, breathing + 1 / 60 / FLOAT_CLIP.duration, 1e-12, '');
  }

  // 45. **The blend weights add up to 1 — on land, in the water and on the crossing
  //     between the two.** It is the invariant Three enforces in silence: what goes above 1
  //     it renormalizes, shrinking everyone in the same proportion; what is missing it
  //     fills with the rig's rest pose, which is the T-pose with arms out. Neither appears
  //     in Blender, and both appear in the game's first second.
  //
  //     The case measures `poseBudget` — the real arithmetic, the same one the avatar calls
  //     — fed by the **real clocks**, and not by chosen numbers: it is the exclusivity
  //     between ladder, helm, water and jump that makes the sum close, and it is what the
  //     full route exercises.
  {
    /** The sum Three is going to see, given the state of one sailor's clocks. */
    const total = (c: PlayerController): { sum: number; posts: number } => {
      const posts = {
        climb: c.climb.weight,
        helm: c.helm.weight,
        swim: c.swim.weight,
        jump: c.jump.air + c.jump.land,
      };
      const { carry, ground } = poseBudget(posts, c.carry.weight, c.gait.moving);
      return {
        sum: posts.climb + posts.helm + posts.swim + posts.jump + carry + ground,
        posts: posts.climb + posts.helm + posts.swim + posts.jump,
      };
    };

    const controller = atGangway(1);
    const ship = fakeShip();
    const waves = flatSea();
    let worstSum = 0;
    let worstPosts = 0;
    const watch = (): void => {
      const { sum, posts } = total(controller);
      worstSum = Math.max(worstSum, Math.abs(sum - 1));
      worstPosts = Math.max(worstPosts, posts);
    };

    // The whole route, step by step: walk along the deck, cross the gangway, fall, float,
    // swim back, grab the ladder and climb. Every frame is measured.
    const run = (frame: InputFrame, seconds: number): void => {
      for (let i = 0; i < Math.round(seconds * 60); i++) {
        controller.fixedUpdate(1 / 60, frame, ship, waves);
        watch();
      }
    };
    run(walkForward(), 1.2);                       // deck, fall and splash
    check('he fell into the water partway through the route', controller.inWater ? 1 : 0, 1, 0, '');
    run(idleFrame(), 1.5);                         // floating
    controller.yaw = Math.PI / 2;
    run(walkForward(), 3);                         // swimming back to the side
    const reachable = controller.reachableBoardingLadder();
    check('the ladder on that side is within reach', reachable ? 1 : 0, 1, 0, '');
    if (reachable) controller.grabBoardingLadder(reachable);
    run(walkForward(), 3);                         // climbing, and the sea fading out
    check('and the climb ended out of the water', controller.inWater ? 1 : 0, 0, 0, '');

    check('the blend adds up to 1 on every frame of the water↔land route',
      worstSum, 0, 1e-12, '');
    // And it closes **because** the stations are exclusive: ladder, helm, water and jump
    // never add up to more than one whole body. Without that the sum above would close by
    // clamping, which is a different thing — it would be the locomotion being erased in
    // silence.
    check('and no frame asked the stations for more than one body',
      worstPosts <= 1 ? 1 : 0, 1, 0, '');
    check('how much the worst frame asked for', worstPosts, 1, 0.001, '');
  }

  // 46. **The plank is the only one that yields, and it yields to everyone.** The other
  //     half of case 45's invariant: `Carry` coexists with the other stations (you can
  //     carry wood while walking through the hold), so it is the one clamped to whatever is
  //     left. The case sets up the worst possible crossing — full plank, full water — and
  //     demands that the sum stay closed.
  {
    const full = { climb: 0, helm: 0, swim: 1, jump: 0 };
    const drowning = poseBudget(full, 1, 0);
    check('with the water taking the body, the plank asks for nothing',
      drowning.carry, 0, 1e-12, '');
    check('and the sum stays closed',
      full.swim + drowning.carry + drowning.ground, 1, 1e-12, '');

    // Walking with the plank in hand: it yields to the stride, which is what keeps the body
    // from sliding through the hold with its feet still.
    const walkingWithPlank = poseBudget({ climb: 0, helm: 0, swim: 0, jump: 0 }, 1, 1);
    check('walking, the plank yields the whole pose to the stride',
      walkingWithPlank.carry, 0, 1e-12, '');
    check('and standing still it takes the whole body',
      poseBudget({ climb: 0, helm: 0, swim: 0, jump: 0 }, 1, 0).carry, 1, 1e-12, '');

    // In the air with the plank: the jump is a station, and the wood gets out of its way.
    // Without this clause the sum came to **2** — the full jump plus the full plank.
    const jumpingWithPlank = poseBudget({ climb: 0, helm: 0, swim: 0, jump: 1 }, 1, 0);
    check('in the air the plank yields too',
      jumpingWithPlank.carry, 0, 1e-12, '');
    check('and the sum of a leap with wood closes at 1',
      1 + jumpingWithPlank.carry + jumpingWithPlank.ground, 1, 1e-12, '');
  }

  // 47. **The water's vertical offset: 1.44 m, and not 1.32.**
  //
  //     Both water clips have `y = 0` at the **waterline**, and not on the floor under the
  //     feet like the eight land ones. Without correcting that, playing `Float` puts the
  //     clip's waterline at the height of the simulated feet and the pirate floats a meter
  //     and a half above the sea.
  //
  //     The correction is `SWIM_SUBMERSION`, which is where the **physics** puts the
  //     surface relative to the feet (1.44 m), and not `FLOAT_CLIP.sink`, which is where
  //     the **animator** put the feet relative to their own surface (1.32 m). The 12 cm of
  //     difference are a choice: aligning by the physics delivers the clip exactly as its
  //     `verify()` measured it — chin 11.8 cm out of the water —, while aligning by the
  //     clip would sink it those 12 cm and the chin would graze the surface. See
  //     `waterPoseY`.
  {
    const controller = atGangway(1);
    const ship = fakeShip();
    const waves = flatSea();
    fallOverboard(controller, ship, waves);
    stepPlayer(controller, idleFrame(), 2, ship, waves);
    controller.syncView(1, 0, 0, ship);

    // The test's sea is a flat plate at y = 0, so "the clip's origin landed on the
    // waterline" is written as a zero.
    check('floating, the origin of the water clip lands on the surface',
      waterPoseY(controller.visualLocal.y, 1), 0, 1e-3, ' m');
    // And out of the water, or with an old GLB that does not carry the clips, the offset
    // disappears: the body goes back to hanging from its feet, which is what the locomotion
    // wants.
    check('and with no water clip the body still hangs from its feet',
      waterPoseY(controller.visualLocal.y, 0), controller.visualLocal.y, 1e-12, ' m');
    // Halfway through the blend the body has to be halfway along — it is the linearity that
    // keeps the land↔water transition from jumping, because the pose the mixer draws is
    // also the weighted average of the two seatings.
    check('and halfway through the transition it is halfway along',
      waterPoseY(controller.visualLocal.y, 0.5),
      (waterPoseY(controller.visualLocal.y, 0) + waterPoseY(controller.visualLocal.y, 1)) / 2,
      1e-12, ' m');

    // ⚠️ The case that pins the decision down: the 12 cm between the physics and the clip.
    // Touching the eye's framing in the water (`SWIM_EYE_HEIGHT`) without rereading
    // `SWIM_SUBMERSION`'s paragraph fails here.
    check('the simulated submersion is the one with the eye 22 cm out of the water',
      SWIM_SUBMERSION, 1.44, 1e-9, ' m');
    check('and it sits 12 cm below the submersion the clip was built with',
      SWIM_SUBMERSION - FLOAT_CLIP.sink, 0.12, 1e-9, ' m');
    // The **drawn** feet sit those 12 cm above the **simulated** feet. It is the price of
    // the choice, and it is paid where nobody sees it: a meter and a half down, on a
    // reclined body.
    check('the feet of the clip stop 1.32 m below the surface',
      waterPoseY(controller.visualLocal.y, 1) - FLOAT_CLIP.sink, -1.32, 1e-3, ' m');
  }

  // 48. **The stride lets go of the water for good.** While `Float`/`Swim` did not exist,
  //     `GaitClock` was fed the swimming speed and drew the sea on loan. Now that the clips
  //     exist, a live stride underneath them would give a body kicking its legs inside the
  //     stroke — and, worse, the camera bob it feeds (2.1 cm per step) would shake the head
  //     of whoever is floating, in a movement nothing on the surface has to justify it.
  {
    const controller = atGangway(1);
    const ship = fakeShip();
    const waves = flatSea();
    fallOverboard(controller, ship, waves);

    // The splash is **not a landing**. Without `jump.reset` in `enterWater`, the `airborne`
    // left over from the fall fires `JumpLand` with the fall's force and the pirate spends
    // half a second crouching inside the sea — and that crouch's weight adds to the water's
    // and overflows the total of 1.
    check('the splash does not trigger a landing', controller.jump.land, 0, 1e-12, '');
    check('nor leave the air clip stuck on', controller.jump.air, 0, 1e-12, '');

    stepPlayer(controller, walkForward(), 3, ship, waves);
    check('swimming, what draws the body is the water', controller.swim.stroke, 1, 0.001, '');
    check('and the stride is switched off', controller.gait.moving, 0, 0.001, '');
    check('at zero speed, and not at swimming speed', controller.gait.speed, 0, 1e-12, ' m/s');

    // The consequence you can see: the head of whoever swims sits at the same height as the
    // head of whoever floats. Before this handover it rose and fell 2.1 cm on every stroke,
    // which was the borrowed stride's bob showing up in the camera.
    controller.syncView(1, 0, 0, ship);
    check('and the eye of whoever swims sits where the eye of whoever floats sits',
      controller.eyeLocal.y, 0.22, 1e-3, ' m');
  }

  const failures = cases.filter((c) => !c.passed).length;
  return { passed: failures === 0, total: cases.length, failures, cases };
}
