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
  nome: string;
  medido: string;
  esperado: string;
  erro: string;
  passou: boolean;
}

export interface TestReport {
  passou: boolean;
  total: number;
  falhas: number;
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

  function check(nome: string, medido: number, esperado: number, tolerancia: number,
                 unidade: string): void {
    const erro = Math.abs(medido - esperado);
    cases.push({
      nome,
      medido: `${medido.toFixed(4)} ${unidade}`,
      esperado: `${esperado.toFixed(4)} ${unidade}`,
      erro: erro.toFixed(5),
      passou: erro <= tolerancia,
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

  // 13. Agarrar a escada tira os pés do chão sem que ninguém esteja voando. É o
  //     caso que `settle` cobre: alimentar `update` com `grounded` ali faria o
  //     personagem aterrissar no ar, a nove metros do convés.
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

  // 30. **E o portaló deixa passar — passando pela soleira.** Mesmo gesto, mesmo
  //     tempo, um metro ao lado. O caminho tem três trechos e os três são medidos:
  //     convés até a borda, **plataforma** por cima dos 28 cm que separam o costado
  //     do pé da escada, e o vazio depois dela. Sem o trecho do meio o jogador cai
  //     num buraco em cima da própria soleira desenhada, e a escada fica sem topo
  //     alcançável a pé.
  {
    const sillOuter = spec.topX - BOARDING_RUNG_RADIUS;

    // A soleira é chão de verdade: parado em cima dela — do lado **de fora** da
    // borda do convés, onde antes desta peça não havia nada — o corpo fica.
    const standing = atGangway(1);
    standing.local.x = (gangwayEdge + sillOuter) * 0.5;
    stepPlayer(standing, idleFrame(), 1);
    check('a soleira do portaló é piso: o corpo para em cima dela',
      standing.local.y, spec.exitY, 1e-3, ' m');
    check('e ela fica do lado de fora do costado',
      standing.local.x > gangwayEdge ? 1 : 0, 1, 0, '');
    check('sem cair', standing.inWater ? 1 : 0, 0, 0, '');

    // E ela acaba onde a malha acaba: meio metro além, não há mais nada.
    const controller = atGangway(1);
    stepPlayer(controller, walkForward(), 3);
    check('pelo portaló o jogador atravessa e cai na água',
      controller.inWater ? 1 : 0, 1, 0, '');
    check('e ele passou por fora da soleira, não só da borda do convés',
      controller.local.x > sillOuter ? 1 : 0, 1, 0, '');
    check('o portaló é o vão do plano da escada',
      insideGangway(spec.z) && !insideGangway(spec.z + spec.gangwayHalfWidth + 0.5) ? 1 : 0,
      1, 0, '');
    // ⚠️ A régua da soleira é espelhada de `HullGeometry.buildGangways`, e este é o
    // caso que reprova se um dos dois lados mudar sem o outro.
    check('e a soleira mede o que a malha desenha',
      sillOuter, 2.0412, 1e-3, ' m');
  }

  // 31. **A queda até a água tem a duração da queda.** O tombadilho está 1,74 m
  //     acima da linha d'água e o corpo entra na água quando os **pés** cruzam a
  //     superfície, ou seja depois de cair essa altura. `√(2h/g)` são 0,596 s, e a
  //     tolerância é um passo do jogo (a superfície é cruzada no meio de um passo,
  //     não na borda dele) mais o tempo que o corpo leva para andar até a beirada.
  {
    const controller = atGangway(1);
    const { fall } = fallOverboard(controller, fakeShip(), flatSea());

    // A tolerância é **derivada**, não escolhida, e ela tem duas parcelas de meio
    // passo cada. A integração é discreta: o corpo cai `g·dt²·n(n+1)/2` em n
    // passos, contra `g·t²/2` no contínuo, o que adianta o contato em meio passo.
    // E a superfície é cruzada no **meio** de um passo, o que atrasa a detecção em
    // até um passo. Somadas, uma vez e meia o passo do jogo.
    const expected = Math.sqrt((2 * QUARTERDECK_Y) / GRAVITY);
    check('a queda do tombadilho até a água leva o que a gravidade cobra',
      fall, expected, 1.5 / 60, ' s');
  }

  // 32. **Na água o corpo não afunda, e não é um grampo que o segura.** O vínculo é
  //     um amortecedor contra a altura da onda, e amortecedor não ultrapassa o
  //     alvo: o olho para em `SWIM_EYE_HEIGHT` acima da superfície e fica lá, com
  //     ou sem tecla apertada. Dez segundos boiando e dez nadando, para cobrir os
  //     dois — se houvesse deriva vertical, ela apareceria em vinte segundos.
  {
    const controller = atGangway(1);
    const ship = fakeShip();
    const waves = flatSea();
    fallOverboard(controller, ship, waves);

    // Dois segundos para o vínculo assentar — ele é amortecido (λ = 8), e medir
    // durante a convergência mediria o amortecedor. A altura de repouso **não** é
    // um número escolhido: é o olho a `SWIM_EYE_HEIGHT` da superfície, com os pés
    // um corpo abaixo dele.
    stepPlayer(controller, idleFrame(), 2, ship, waves);
    const floating = -(1.66 - 0.22);
    check('boiando, os pés param um corpo abaixo da superfície',
      controller.local.y, floating, 1e-3, ' m');

    // O olho é o que o jogador vê. Vem de `syncView` porque é ela que escreve a
    // pose do **quadro**, que é a que a câmera lê; medir `local` provaria só a
    // metade de dentro.
    controller.syncView(1, 0, 0, ship);
    check('e o olho fica pouco acima da linha d’água',
      controller.eyeLocal.y, 0.22, 1e-3, ' m');

    stepPlayer(controller, idleFrame(), 10, ship, waves);
    check('dez segundos boiando não afundam o corpo',
      controller.local.y, floating, 1e-3, ' m');
    stepPlayer(controller, walkForward(), 10, ship, waves);
    check('e dez nadando também não',
      controller.local.y, floating, 1e-3, ' m');
  }

  // 33. **A velocidade de nado é metade do passo.** Medida como distância por
  //     tempo em regime, e não lendo a constante: entre a tecla e o avanço estão o
  //     amortecimento de `AIR_CONTROL` e a reescrita de `local` a partir da
  //     posição de mundo, e é a cadeia inteira que precisa entregar o número.
  {
    const controller = atGangway(1);
    const ship = fakeShip();
    const waves = flatSea();
    fallOverboard(controller, ship, waves);
    const frame = walkForward();
    // Cinco segundos para o amortecedor convergir (λ = 1,6 dá 0,03% de erro em 5 s),
    // e só então começa a medir. Nadando para **fora** do navio, que é a direção em
    // que o corpo caiu: nadar para dentro esbarraria no costado no meio da medida.
    stepPlayer(controller, frame, 5, ship, waves);
    const from = controller.local.clone();
    stepPlayer(controller, frame, 4, ship, waves);
    const swum = Math.hypot(controller.local.x - from.x, controller.local.z - from.z);
    check('nadar cobre metade do que caminhar cobre', swum / 4, 2.8 / 2, 0.02, ' m/s');
  }

  // 34. **A troca de dono da fase não muda a cadência.** Este caso nasceu provando
  //     um empréstimo — enquanto `Float`/`Swim` não existiam no GLB, quem desenhava
  //     o nado era o clipe de caminhada e `SWIM_DISTANCE` *era* a distância dele,
  //     tomada de propósito para que a chegada dos clipes de verdade não mudasse
  //     nada. Os clipes chegaram, e `anim_swim.py` mediu 1,32 m de ciclo por conta
  //     própria: exatamente o mesmo número. O caso continua valendo palavra por
  //     palavra, só que agora ele mede a **troca** em vez do empréstimo — a fase da
  //     água e a da passada avançam juntas, quadro a quadro, na mesma velocidade.
  {
    const swim = new SwimClock();
    const gait = new GaitClock();
    const steps = 600;
    for (let i = 0; i < steps; i++) {
      swim.update(1 / 60, true, WALK_CLIP.speed);
      gait.update(1 / 60, WALK_CLIP.speed, true);
    }
    const swum = (WALK_CLIP.speed * steps) / 60;
    check('a braçada fecha uma volta a cada distância do ciclo',
      swim.phase, ((swum / SWIM_DISTANCE) % 1 + 1) % 1, 1e-9, '');
    check('e a fase da água anda junto com a da passada que a desenhava',
      swim.phase, gait.phase, 1e-9, '');
    check('porque as duas distâncias de ciclo são o mesmo número',
      SWIM_DISTANCE, WALK_DISTANCE, 1e-12, ' m');
    check('nadando, a pose é braçada', swim.stroke, 1, 0.001, '');
    check('e o peso da água chega a cheio', swim.weight, 1, 0.001, '');

    for (let i = 0; i < 120; i++) swim.update(1 / 60, true, 0);
    check('parado na água, a pose vira boia', swim.stroke, 0, 0.001, '');
    for (let i = 0; i < 120; i++) swim.update(1 / 60, false, 0);
    check('e sair do mar apaga o peso', swim.weight, 0, 0.001, '');
  }

  // 35. **A fase da escada de embarque casa com a grade de barras na subida
  //     inteira.** É o mesmo teorema do caso 15, com a escada do costado: depois de
  //     alinhar uma vez, a barra que o clipe manda a mão agarrar tem de coincidir
  //     com um degrau desenhado do primeiro ao último. Só que aqui há duas coisas a
  //     mais que podem sair errado, e as duas estão medidas: a escada é **inclinada**
  //     (o corpo segue uma reta que se afasta do prumo) e o espaçamento **não foi
  //     arredondado** (ver `BOARDING_RUNG_SPACING`).
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
      // E a reta que o corpo segue é a do plano dos degraus mais o afastamento,
      // medido na perpendicular: 28,1 cm de recuo horizontal a 14,11° de prumo.
      worstStand = Math.max(
        worstStand,
        Math.abs(boardingLadderStandX(spec, feet) - boardingLadderX(spec, feet) - 0.28125),
      );
    }
    check('a mão cai na barra ao longo dos 2,43 m da escada de embarque',
      worstMiss, 0, 0.001, 'm');
    check('e o corpo segue a reta inclinada, medida na perpendicular',
      worstStand, 0, 1e-4, 'm');
    // A inclinação que o corpo assume é a da escada — sem ela o clipe vertical
    // afasta a mão da barra proporcionalmente à altura do alcance.
    check('a escada de embarque é inclinada 14,11°',
      (spec.tilt * 180) / Math.PI, 14.110, 0.01, '°');
  }

  // 36. **Da água ao tombadilho, de pé.** O percurso inteiro num laço só: cair,
  //     nadar até a escada, agarrar e subir. O que se cobra no fim é o que o
  //     jogador vê — ele está **em cima do convés**, no plano do timão, e não
  //     pendurado nem na água.
  {
    const controller = atGangway(1);
    const ship = fakeShip();
    const waves = flatSea();
    fallOverboard(controller, ship, waves);
    check('caiu na água antes de tentar subir', controller.inWater ? 1 : 0, 1, 0, '');

    // Nada de volta para o casco: a queda leva o corpo uns dois metros para fora, e
    // é o jogador quem tem de voltar. Virar o rumo é virar a cabeça — na água o
    // nado segue o olhar, como no convés.
    controller.yaw = Math.PI / 2;
    stepPlayer(controller, walkForward(), 3, ship, waves);
    check('nadando de volta, o costado o para em vez de o deixar entrar',
      Math.abs(controller.local.x) >= halfWidthAtHeight(zToT(controller.local.z), 0) ? 1 : 0,
      1, 0, '');

    const reachable = controller.reachableBoardingLadder();
    check('e a escada do bordo fica ao alcance da mão',
      reachable ? 1 : 0, 1, 0, '');
    if (reachable) controller.grabBoardingLadder(reachable);
    check('agarrar tira o corpo da água', controller.inWater ? 1 : 0, 0, 0, '');
    check('e o põe pendurado na escada', controller.onLadder ? 1 : 0, 1, 0, '');
    check('com o corpo inclinado como ela',
      controller.ladderTilt, spec.tilt, 1e-9, ' rad');
    check('e virado para o bordo dela',
      controller.ladderFacing, -Math.PI / 2, 1e-9, ' rad');

    // Sobe até deixar de estar pendurado, e não por um tempo fixo: são 2,43 m a
    // `CLIMB_SPEED`, mas o que se cobra é o **fim** da subida. Solta a tecla logo
    // em seguida porque, de pé no tombadilho, "para vante" com este rumo é
    // caminhar de volta para fora pelo mesmo portaló.
    const climb = walkForward();
    for (let i = 0; i < 600 && controller.onLadder; i++) {
      controller.fixedUpdate(1 / 60, climb, ship, waves);
    }
    stepPlayer(controller, idleFrame(), 0.5, ship, waves);

    const exitX = Math.abs(controller.local.x);
    // No nível do tombadilho: a soleira é rasada com ele, e a folga de 2 mm é o
    // abaulamento do convés, que vale quase zero na borda.
    check('a subida termina de pé no nível do tombadilho',
      controller.local.y, spec.exitY, 5e-3, ' m');
    check('de pé, e não pendurado', controller.onLadder ? 1 : 0, 0, 0, '');
    check('nem de volta na água', controller.inWater ? 1 : 0, 0, 0, '');
    check('e com os pés no chão', controller.grounded ? 1 : 0, 1, 0, '');
    // Um raio para dentro do fio da tábua — o mais para fora que o corpo cabe sem
    // o cilindro passar dela. Como a soleira só avança 28 cm além da borda do
    // convés e o cilindro tem 30 cm de raio, "inteiro em cima da tábua" não existe:
    // o corpo fica **a cavalo da junta**, metade em cada piso. É exatamente o que
    // se faz ao transpor a soleira de um portaló de verdade.
    check('com o corpo a cavalo da junta entre a soleira e o convés',
      exitX, spec.topX - BOARDING_RUNG_RADIUS - 0.3, 1e-3, ' m');
    // E de lá dá para entrar no navio a pé, que é o que a soleira existe para
    // permitir: um passo para dentro e o piso vira convés.
    stepPlayer(controller, walkForward(), 0.6, ship, waves);
    check('e daí um passo o leva para dentro do costado',
      Math.abs(controller.local.x) < gangwayEdge ? 1 : 0, 1, 0, '');
  }

  // 37. **O relógio do resgate.** Cinco segundos, contados do instante em que o
  //     corpo entra na água — e zerados por sair dela, que é a parte que importa:
  //     quem sobe a escada e cai de novo não chega ao socorro com crédito da queda
  //     anterior. E o resgate acontecendo põe o marujo de volta no ponto de partida.
  {
    const controller = atGangway(1);
    const ship = fakeShip();
    const waves = flatSea();
    fallOverboard(controller, ship, waves);
    const entered = controller.waterTime;
    // Nasce no passo do tombo, e não antes: o relógio conta água, não queda.
    check('o relógio da água nasce no tombo', entered, 0, 1e-9, ' s');

    // Até um passo antes dos cinco segundos, nada de socorro.
    stepPlayer(controller, idleFrame(), 5 - entered - 2 / 60, ship, waves);
    check('antes de cinco segundos não há resgate',
      controller.canRequestRescue() ? 1 : 0, 0, 0, '');
    stepPlayer(controller, idleFrame(), 4 / 60, ship, waves);
    check('e a partir deles há', controller.canRequestRescue() ? 1 : 0, 1, 0, '');
    check('com o relógio em cinco segundos', controller.waterTime, 5, 0.04, ' s');

    const before = controller.rescueCount;
    controller.requestRescue();
    check('o pedido conta uma borda para o apagão da tela',
      controller.rescueCount - before, 1, 0, '');
    check('e devolve o marujo ao navio', controller.inWater ? 1 : 0, 0, 0, '');
    check('no ponto de partida', controller.local.z, 1.2, 1e-9, ' m');
    check('com o relógio da água zerado', controller.waterTime, 0, 1e-9, ' s');
  }

  // 38. **O náufrago do outro lado boia, e não nada.** O corpo remoto recebe só
  //     posições, e na água aquelas posições são do **navio**, que está indo
  //     embora: um adversário parado boiando tem o `local` correndo para a popa a
  //     2,6 m/s. Alimentar o relógio da água com esse número o põe em braçada de
  //     crawl pelo mar sem sair do lugar — e é exatamente o que acontece sem a soma
  //     com a velocidade do casco. O caso monta os dois lados: casco a 2,6 m/s para
  //     vante, corpo parado no mundo.
  //
  //     ⚠️ **A grandeza medida é a do relógio da água, e não a da passada.**
  //     Enquanto os clipes de água não existiam, era o `GaitClock` que recebia a
  //     velocidade de nado e desenhava o mar; hoje ele recebe zero na água por
  //     construção (ver `updateBob`), e quem carrega a velocidade derivada é o
  //     `SwimClock`. Medir `gait.speed` aqui passaria de graça e não provaria nada.
  {
    const controller = new PlayerController();
    controller.spawn();
    const pose = remotePose(controller);
    pose.inWater = true;
    const ship = fakeShip();
    // O casco avança para −Z, que é para vante no referencial dele.
    (ship.body as unknown as { velocity: THREE.Vector3 }).velocity = {
      x: 0,
      y: 0,
      z: -2.6,
    } as THREE.Vector3;

    // Parado no mundo: o corpo anda para +Z **no navio** exatamente o que o navio
    // anda para −Z no mundo. Com o casco sem guinar, as duas contas se cancelam.
    for (let i = 0; i < 120; i++) {
      pose.local.z += 2.6 / 60;
      controller.applyRemoteStep(1 / 60, pose, ship);
    }
    check('o náufrago do outro lado não nada parado',
      controller.swim.speed, 0, 1e-9, ' m/s');
    check('e a passada dele fica fora da água', controller.gait.moving, 0, 0.001, '');
    check('com a água ocupando o corpo', controller.swim.weight, 1, 0.001, '');
    check('em pose de boia', controller.swim.stroke, 0, 0.001, '');

    // E nadando de verdade — 1,4 m/s no mundo, ou seja 4,0 m/s no navio — a pose
    // volta a ser braçada, na velocidade certa.
    for (let i = 0; i < 120; i++) {
      pose.local.z += (2.6 + 1.4) / 60;
      controller.applyRemoteStep(1 / 60, pose, ship);
    }
    check('e nadando ele nada na velocidade de nado',
      controller.swim.speed, 1.4, 1e-9, ' m/s');
    check('com a pose voltando a ser braçada', controller.swim.stroke, 1, 0.001, '');
    check('e a passada continuando fora dela', controller.gait.speed, 0, 1e-12, ' m/s');
  }

  // 39. **O referencial em que a reconciliação compara o nadador.**
  //
  //     Este é o único caso deste arquivo que fala de rede, e ele está aqui porque
  //     a grandeza que ele mede é do corpo, não do fio: é a **diferença entre duas
  //     contas de posição feitas com poses de casco diferentes**.
  //
  //     No convés isso nunca existiu. O `local` de quem anda não lê a pose do casco
  //     para nada — o convés é um chão parado —, então host e guest chegam ao mesmo
  //     número por caminhos independentes e comparar local contra local é honesto.
  //     A água é a **primeira** coisa desta base cujo cálculo de posição depende
  //     numericamente do `ship.body`: o `local` do nadador *é* a posição de mundo
  //     convertida pela pose do casco. E as duas poses não são a mesma — o host usa
  //     a real, o guest usa a interpolada da rede, atrasada de `lead +
  //     INTERP_DELAY` passos. Duas posições de mundo idênticas viram `local`
  //     diferentes, e a reconciliação enxergava um erro que **não existe no mundo**.
  //
  //     O caso mede o viés com o navio **guinando**, que é onde ele cresce com a
  //     distância — e o cenário do recurso é exatamente ficar para trás enquanto o
  //     navio segue navegando.
  {
    // Espelham `GuestSession`, como `PROTOCOL_VERSION` espelha o protocolo em
    // `roomServer.mjs`: repetidos à mão para que uma mudança lá tenha de passar
    // por aqui em vez de concordar por construção.
    const ERROR_IGNORE = 0.08;
    const ERROR_SNAP = 1.5;
    const SHIP_SPEED = 2.6;

    const body = new ShipBody({
      mass: 37000,
      centerOfMass: new THREE.Vector3(0, -0.35, 0.2),
      gyration: new THREE.Vector3(2, 4, 2),
      addedMass: new THREE.Vector3(1.9, 1.9, 1.05),
    });

    /** Põe o casco na pose que ele tinha `lag` segundos antes de agora. */
    const poseAt = (lag: number, omega: number): void => {
      body.comPosition.set(0, 0, SHIP_SPEED * lag);
      body.orientation.setFromAxisAngle(new THREE.Vector3(0, 1, 0), -omega * lag);
    };

    /**
     * O viés entre a conta do host (pose de agora) e a do guest (pose atrasada),
     * para um náufrago parado no mundo a `distance` metros a ré.
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

    // Sem guinar, o viés é só a translação do casco no atraso — e **não depende da
    // distância**. Treze passos são 217 ms, o atraso de uma conexão boa (lead 9
    // mais os 4 de interpolação).
    // Sem guinar o viés é exatamente a translação do casco no atraso: é a conta
    // fechada, e casá-la é o que prova que o modelo do teste é o do jogo.
    const straight = bias(0, 0, 13);
    check('o viés de referencial é a translação do casco no atraso',
      straight, SHIP_SPEED * (13 / 60), 1e-9, ' m');
    check('e ele nasce muito acima da faixa que a reconciliação ignora',
      straight > ERROR_IGNORE ? 1 : 0, 1, 0, '');
    check('quantas vezes acima', straight / ERROR_IGNORE, 7.042, 0.01, '×');

    // Guinando, ele cresce com o raio — que é o que o cenário produz sozinho: a
    // 2,6 m/s o náufrago está 26 m atrás em dez segundos, e o resgate só abre aos
    // cinco.
    check('a 26 m e meia guinada, o viés passa do teleporte legítimo',
      bias(26, 0.4, 13) > ERROR_SNAP ? 1 : 0, 1, 0, '');
    check('e passa cedo: segundos de deriva até cruzar esse limiar',
      // Raio em que o viés cruza `ERROR_SNAP`, dividido pela velocidade do navio.
      (() => {
        for (let r = 0; r <= 200; r += 0.05) if (bias(r, 0.4, 13) >= ERROR_SNAP) return r;
        return Infinity;
      })() / SHIP_SPEED,
      6.31, 0.05, ' s');

    // ⚠️ **E a conta em mundo não tem viés nenhum — é essa a correção.** A posição
    // do host é reconstruída com a pose do casco que veio **no mesmo pacote**, que
    // é a mesma que ele usou; a pose atrasada que o guest tem em mãos não entra na
    // conta e por isso não pode contaminá-la. Zero exato, em qualquer guinada e a
    // qualquer distância. Ver `GuestSession.authoritativePosition`.
    let worstWorld = 0;
    for (const omega of [0, 0.1, 0.2, 0.4]) {
      for (const distance of [0, 5, 26, 52, 120]) {
        const swimmer = new THREE.Vector3(0, 0, distance);
        const local = new THREE.Vector3();
        // O host deriva o `local` com a pose dele...
        poseAt(0, omega);
        body.worldToLocal(swimmer, local);
        // ...e o guest o traz de volta para mundo com **a mesma** pose, que chegou
        // no instantâneo. O que ele tem em `ship.body` fica de fora de propósito.
        const rebuilt = new THREE.Vector3();
        body.localToWorld(local, rebuilt);
        worstWorld = Math.max(worstWorld, rebuilt.distanceTo(swimmer));
      }
    }
    check('comparando em mundo, o viés desaparece por completo',
      worstWorld, 0, 1e-9, ' m');
  }

  // 40. **O desvio de reconciliação chega à tela.**
  //
  //     Este caso existe por causa de um defeito que só um `grep` revelava: o
  //     desvio era calculado, acumulado e decaído dentro do `GuestSession`, com um
  //     getter público jurando que "o desenho soma à posição" — e **nenhum arquivo
  //     do projeto lia aquele getter**. A faixa do meio da reconciliação (de 8 cm a
  //     1,5 m, onde mora quase toda correção real) não era suavizada por nada: a
  //     posição era reescrita crua, quinze vezes por segundo, no convés e na água.
  //     Não dava erro, não sumia do código, e o comentário garantia o contrário.
  //
  //     O que se prova aqui é a ligação: a correção vira **deslocamento visual**
  //     sem mexer na posição simulada, e ela some sozinha.
  {
    const controller = new PlayerController();
    controller.spawn();
    const ship = fakeShip();

    // Um erro típico da faixa do meio: seis centímetros de lado e três de vante.
    const correction = new THREE.Vector3(0.06, 0, 0.03);
    const simulated = controller.local.clone();
    controller.absorbViewOffset(correction);

    // A simulação não se mexeu — é o ponto inteiro do desvio.
    check('absorver um desvio não move a posição simulada',
      controller.local.distanceTo(simulated), 0, 1e-12, ' m');

    // Mas a pose do quadro, sim: nos **dois** consumidores, o corpo e o olho.
    controller.syncView(1, 0, 0, ship);
    check('mas move o corpo desenhado',
      controller.visualLocal.distanceTo(simulated), correction.length(), 1e-9, ' m');
    check('e o olho da câmera junto com ele',
      controller.eyeLocal.y - (controller.visualLocal.y + 1.66), 0, 1e-9, ' m');
    check('na direção certa, e não só na distância certa',
      controller.visualLocal.x - simulated.x, correction.x, 1e-9, ' m');

    // E some sozinho. λ = 16 → sobra `e^(-3,2)` = 4,1% depois de 200 ms; o teste
    // integra quadro a quadro a 60 Hz, que é como o laço de verdade o chama.
    for (let i = 0; i < 12; i++) controller.decayViewOffset(1 / 60);
    check('e o desvio some em dois décimos de segundo',
      controller.viewOffset.length() / correction.length(), Math.exp(-3.2), 1e-3, '');
    check('sobrando menos de 5% do que entrou',
      controller.viewOffset.length() / correction.length() < 0.05 ? 1 : 0, 1, 0, '');

    // Depois de um segundo não sobra nada que um pixel enxergue.
    for (let i = 0; i < 48; i++) controller.decayViewOffset(1 / 60);
    controller.syncView(1, 0, 0, ship);
    check('e um segundo depois a pose voltou a ser a simulada',
      controller.visualLocal.distanceTo(simulated), 0, 1e-4, ' m');
  }

  // 41. **O teto de enjoo do desvio.**
  //
  //     Um desvio que decai exponencialmente arranca a `λ·|desvio|`: sem teto, uma
  //     correção de 1,4 m — que **cabe** na faixa suavizada — poria a câmera de
  //     primeira pessoa a 22 m/s por algumas dezenas de milissegundos, que é pior
  //     que o solavanco que se está escondendo. O teto é derivado da única
  //     velocidade que o jogador já conhece do próprio corpo: a corrida.
  {
    const controller = new PlayerController();
    controller.spawn();
    const RUN_SPEED = 4.7;
    const OFFSET_LAMBDA = 16;

    controller.absorbViewOffset(new THREE.Vector3(1.4, 0, 0));
    check('um desvio grande é grampeado antes de virar deslize',
      controller.viewOffset.length(), RUN_SPEED / OFFSET_LAMBDA, 1e-9, ' m');

    // A velocidade de partida do deslize, medida como o laço a produz: um quadro
    // de decaimento dividido pelo tempo dele.
    //
    // O teto é derivado do valor **instantâneo** em t = 0, que é `λ·|desvio|` =
    // 4,70 m/s exatos. O que um quadro mede é a *média* dele, que é menor porque a
    // exponencial já começou a cair dentro do próprio quadro: `(1 − e^(−λ/60))·60`
    // dá 14,04 por metro de desvio. Cobrar a média contra o teto instantâneo seria
    // afrouxar o teste; a desigualdade abaixo é a que importa, e este número está
    // aqui para a folga entre os dois ficar registrada.
    const before = controller.viewOffset.length();
    controller.decayViewOffset(1 / 60);
    const speed = (before - controller.viewOffset.length()) * 60;
    check('e a câmera nunca desliza mais rápido que o jogador corre',
      speed <= RUN_SPEED ? 1 : 0, 1, 0, '');
    check('velocidade média do primeiro quadro do deslize', speed, 4.1255, 1e-3, ' m/s');
    check('e o pico instantâneo é a corrida, por construção',
      before * OFFSET_LAMBDA, RUN_SPEED, 1e-9, ' m/s');

    // Um desvio pequeno — o caso que de fato acontece — passa intacto.
    controller.viewOffset.set(0, 0, 0);
    controller.absorbViewOffset(new THREE.Vector3(0.05, 0, 0));
    check('e um desvio pequeno não é tocado pelo teto',
      controller.viewOffset.length(), 0.05, 1e-9, ' m');
  }

  // 42. **A escada em que o corpo está sai da posição, e não do fio.** É o que
  //     dispensa um bit no instantâneo — e o caso mede a folga que torna a
  //     derivação segura: as duas escadas do navio estão a sete metros uma da outra
  //     em Z, e `insideGangway` separa as duas com metros de sobra dos dois lados.
  check('o mastro está longe do vão do portaló',
    Math.abs(MAST_LADDER.z - spec.z), 7.164, 0.01, ' m');
  check('e insideGangway não confunde as duas',
    insideGangway(MAST_LADDER.z) ? 1 : 0, 0, 0, '');

  // -- a água, com os clipes dentro ---------------------------------------------

  // 43. **A braçada é indexada pela distância, e o fator de velocidade cai dela.**
  //     É o mesmo teorema do caso 1 com outra régua: um ciclo de `Swim` cobre
  //     `SWIM_DISTANCE` no mar, em qualquer velocidade de nado. E dele cai o número
  //     que ninguém escreveu em lugar nenhum — o clipe foi animado a 1,32 m/s e o
  //     jogo nada a 1,40, então a fase corre 1,06 ciclo por segundo e a braçada
  //     sai 6% mais rápida do que saiu do Blender. É exatamente a conta que a
  //     caminhada já faz (1,65 nativo, 2,80 de jogo, fator 1,70), e é por ela ser
  //     automática que **não existe `timeScale` nenhum** nos dois clipes de água.
  {
    const SWIM_SPEED = 2.8 / 2;
    const swim = new SwimClock();
    const seconds = 8;
    const steps = Math.round(seconds * 60);
    for (let i = 0; i < steps; i++) swim.update(1 / 60, true, SWIM_SPEED);

    const swum = SWIM_SPEED * seconds;
    check('a braçada fecha uma volta a cada 1,32 m nadados',
      swim.phase, ((swum / SWIM_DISTANCE) % 1 + 1) % 1, 1e-9, '');
    // Ciclos por segundo é o mesmo que a razão entre a velocidade do jogo e a
    // nativa — que é a definição do fator de reprodução do clipe.
    check('e a velocidade do jogo toca o clipe 1,06× mais rápido que o nativo',
      SWIM_SPEED / SWIM_DISTANCE, SWIM_SPEED / SWIM_CLIP.speed, 1e-12, ' ciclos/s');
    check('valor do fator', SWIM_SPEED / SWIM_CLIP.speed, 1.0606, 1e-4, '×');
    // A velocidade nativa é a que o `anim_swim.verify` mediu, refeita aqui a partir
    // dos dois números do clipe: se alguém reanimar a braçada com outra cadência e
    // esquecer de trazer o par, este caso reprova.
    check('a velocidade nativa do clipe é a de `anim_swim`',
      SWIM_CLIP.speed / SWIM_CLIP.cycle, 1.32, 1e-9, ' m/s');

    // Parado, a fase da braçada congela: o corpo fica onde o último braço o
    // deixou, como na escada, em vez de remar sem sair do lugar.
    const frozen = swim.phase;
    for (let i = 0; i < 120; i++) swim.update(1 / 60, true, 0);
    check('parado na água, a braçada congela', swim.phase, frozen, 1e-12, '');
  }

  // 44. **A boia é o único clipe de água que roda no relógio.** Boiar não tem
  //     grandeza do mundo de onde ler uma fase — é respiração, e respiração não
  //     acelera com a corrente —, então `Float` é a exceção da mesma família do
  //     `Carry`: 210 quadros a 30 fps, sete segundos por volta. O caso mede a volta
  //     e mede a coisa que a exceção existe para dar: a fase **não** recomeça do
  //     zero quando o marujo sai da água e cai de novo.
  {
    /** Distância entre duas fases num círculo — 0,999 e 0,001 são vizinhas. */
    const gap = (a: number, b: number): number => {
      const d = Math.abs(a - b) % 1;
      return Math.min(d, 1 - d);
    };

    const swim = new SwimClock();
    for (let i = 0; i < 7 * 60; i++) swim.update(1 / 60, true, 0);
    // A tolerância é **derivada**: a fase é somada uma vez por quadro, e 420
    // somas de `1/420` não caem exatamente em 1 em ponto flutuante. O que se
    // cobra é que a volta feche dentro de um quadro dela.
    check('a boia fecha uma volta em sete segundos',
      gap(swim.floatPhase, 0), 0, 1 / (60 * FLOAT_CLIP.duration), '');
    check('e a volta é a duração do clipe: 210 quadros a 30 fps',
      FLOAT_CLIP.duration, 210 / 30, 1e-9, ' s');

    swim.reset();
    for (let i = 0; i < Math.round(2.1 * 60); i++) swim.update(1 / 60, true, 0);
    const breathing = swim.floatPhase;
    check('e no meio do laço ela está onde o tempo a pôs',
      breathing, 2.1 / FLOAT_CLIP.duration, 1e-9, '');

    // Fora da água a respiração para — e para **onde estava**. Quem agarra a
    // escada, escorrega e cai de novo não recomeça o ciclo do começo.
    for (let i = 0; i < 90; i++) swim.update(1 / 60, false, 0);
    check('fora do mar a boia congela', swim.floatPhase, breathing, 1e-12, '');
    swim.update(1 / 60, true, 0);
    check('e cair de novo a retoma de onde parou',
      swim.floatPhase, breathing + 1 / 60 / FLOAT_CLIP.duration, 1e-12, '');
  }

  // 45. **Os pesos de mistura somam 1 — em terra, na água e na travessia entre as
  //     duas.** É a invariante que o Three cobra em silêncio: o que sobra acima de 1
  //     ele renormaliza, encolhendo todo mundo na mesma proporção; o que falta ele
  //     preenche com a pose de repouso do rig, que é a T-pose de braços abertos.
  //     Nenhum dos dois aparece no Blender, e os dois aparecem no primeiro segundo
  //     de jogo.
  //
  //     O caso mede `poseBudget` — a aritmética de verdade, a mesma que o avatar
  //     chama — alimentada pelos **relógios de verdade**, e não por números
  //     escolhidos: é a exclusividade entre escada, timão, água e pulo que faz a
  //     soma fechar, e é ela que o percurso completo exercita.
  {
    /** A soma que o Three vai ver, dado o estado dos relógios de um marujo. */
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

    // O percurso inteiro, passo a passo: andar pelo convés, atravessar o portaló,
    // cair, boiar, nadar de volta, agarrar a escada e subir. Cada quadro é medido.
    const run = (frame: InputFrame, seconds: number): void => {
      for (let i = 0; i < Math.round(seconds * 60); i++) {
        controller.fixedUpdate(1 / 60, frame, ship, waves);
        watch();
      }
    };
    run(walkForward(), 1.2);                       // convés, queda e respingo
    check('caiu na água no meio do percurso', controller.inWater ? 1 : 0, 1, 0, '');
    run(idleFrame(), 1.5);                         // boiando
    controller.yaw = Math.PI / 2;
    run(walkForward(), 3);                         // nadando de volta ao costado
    const reachable = controller.reachableBoardingLadder();
    check('a escada do bordo está ao alcance', reachable ? 1 : 0, 1, 0, '');
    if (reachable) controller.grabBoardingLadder(reachable);
    run(walkForward(), 3);                         // subindo, e o mar se apagando
    check('e a subida terminou fora da água', controller.inWater ? 1 : 0, 0, 0, '');

    check('a mistura soma 1 em todo quadro do percurso água↔terra',
      worstSum, 0, 1e-12, '');
    // E ela fecha **porque** os postos são exclusivos: escada, timão, água e pulo
    // nunca somam mais que um corpo inteiro. Sem isto a soma acima fecharia por
    // grampeamento, que é outra coisa — seria a locomoção sendo apagada em silêncio.
    check('e nenhum quadro pediu mais de um corpo aos postos',
      worstPosts <= 1 ? 1 : 0, 1, 0, '');
    check('quanto o pior quadro pediu', worstPosts, 1, 0.001, '');
  }

  // 46. **A tábua é a única que cede, e ela cede a todos.** A outra metade da
  //     invariante do caso 45: `Carry` convive com os outros postos (dá para
  //     carregar madeira andando pelo porão), então é ela que é grampeada ao que
  //     sobrou. O caso põe o pior cruzamento possível — tábua cheia, água cheia — e
  //     cobra que a soma continue fechada.
  {
    const full = { climb: 0, helm: 0, swim: 1, jump: 0 };
    const drowning = poseBudget(full, 1, 0);
    check('com a água ocupando o corpo, a tábua não pede nada',
      drowning.carry, 0, 1e-12, '');
    check('e a soma continua fechada',
      full.swim + drowning.carry + drowning.ground, 1, 1e-12, '');

    // Andando com a tábua na mão: ela cede à passada, que é o que impede o corpo de
    // deslizar pelo porão com os pés parados.
    const walkingWithPlank = poseBudget({ climb: 0, helm: 0, swim: 0, jump: 0 }, 1, 1);
    check('andando, a tábua cede a pose inteira à passada',
      walkingWithPlank.carry, 0, 1e-12, '');
    check('e parado ela toma o corpo todo',
      poseBudget({ climb: 0, helm: 0, swim: 0, jump: 0 }, 1, 0).carry, 1, 1e-12, '');

    // No ar com a tábua: o pulo é posto, e a madeira sai da frente dele. Sem esta
    // cláusula a soma dava **2** — o pulo cheio mais a tábua cheia.
    const jumpingWithPlank = poseBudget({ climb: 0, helm: 0, swim: 0, jump: 1 }, 1, 0);
    check('no ar a tábua também cede',
      jumpingWithPlank.carry, 0, 1e-12, '');
    check('e a soma do salto com madeira fecha em 1',
      1 + jumpingWithPlank.carry + jumpingWithPlank.ground, 1, 1e-12, '');
  }

  // 47. **O deslocamento vertical da água: 1,44 m, e não 1,32.**
  //
  //     Os dois clipes de água têm `y = 0` na **linha d'água**, e não no chão sob os
  //     pés como os oito de terra. Sem corrigir isso, tocar `Float` põe a linha
  //     d'água do clipe na altura dos pés simulados e o pirata boia um metro e meio
  //     acima do mar.
  //
  //     A correção é `SWIM_SUBMERSION`, que é onde a **física** põe a superfície em
  //     relação aos pés (1,44 m), e não `FLOAT_CLIP.sink`, que é onde o **animador**
  //     pôs os pés em relação à superfície dele (1,32 m). Os 12 cm de diferença são
  //     escolha: alinhar pela física entrega o clipe exatamente como o `verify()`
  //     dele o mediu — queixo 11,8 cm fora da água —, enquanto alinhar pelo clipe o
  //     afundaria esses 12 cm e o queixo raspa a superfície. Ver `waterPoseY`.
  {
    const controller = atGangway(1);
    const ship = fakeShip();
    const waves = flatSea();
    fallOverboard(controller, ship, waves);
    stepPlayer(controller, idleFrame(), 2, ship, waves);
    controller.syncView(1, 0, 0, ship);

    // O mar do teste é uma chapa em y = 0, então "a origem do clipe caiu na linha
    // d'água" se escreve como um zero.
    check('boiando, a origem do clipe de água cai na superfície',
      waterPoseY(controller.visualLocal.y, 1), 0, 1e-3, ' m');
    // E fora da água, ou com um GLB antigo que não traz os clipes, a soma some: o
    // corpo volta a ser pendurado nos pés, que é o que a locomoção quer.
    check('e sem clipe de água o corpo continua pendurado nos pés',
      waterPoseY(controller.visualLocal.y, 0), controller.visualLocal.y, 1e-12, ' m');
    // No meio da mistura o corpo tem de estar no meio do caminho — é a linearidade
    // que faz a transição terra↔água não dar salto, porque a pose que o mixer
    // desenha também é a média ponderada dos dois assentamentos.
    check('e no meio da transição ele está no meio do caminho',
      waterPoseY(controller.visualLocal.y, 0.5),
      (waterPoseY(controller.visualLocal.y, 0) + waterPoseY(controller.visualLocal.y, 1)) / 2,
      1e-12, ' m');

    // ⚠️ O caso que amarra a decisão: os 12 cm entre a física e o clipe. Mexer no
    // enquadramento do olho na água (`SWIM_EYE_HEIGHT`) sem reler o parágrafo de
    // `SWIM_SUBMERSION` reprova aqui.
    check('o afundamento simulado é o do olho a 22 cm da água',
      SWIM_SUBMERSION, 1.44, 1e-9, ' m');
    check('e ele fica 12 cm abaixo do afundamento com que o clipe foi construído',
      SWIM_SUBMERSION - FLOAT_CLIP.sink, 0.12, 1e-9, ' m');
    // Os pés **desenhados** ficam esses 12 cm acima dos pés **simulados**. É o preço
    // da escolha, e ele é pago onde ninguém vê: a um metro e meio de profundidade,
    // num corpo reclinado.
    check('os pés do clipe param 1,32 m abaixo da superfície',
      waterPoseY(controller.visualLocal.y, 1) - FLOAT_CLIP.sink, -1.32, 1e-3, ' m');
  }

  // 48. **A passada larga a água de vez.** Enquanto `Float`/`Swim` não existiam, o
  //     `GaitClock` era alimentado com a velocidade de nado e desenhava o mar de
  //     empréstimo. Agora que os clipes existem, uma passada viva por baixo deles
  //     daria um corpo batendo perna dentro da braçada — e, pior, o balanço de
  //     câmera que ela alimenta (2,1 cm por passo) sacudiria a cabeça de quem está
  //     boiando, num movimento que nada na superfície tem para justificar.
  {
    const controller = atGangway(1);
    const ship = fakeShip();
    const waves = flatSea();
    fallOverboard(controller, ship, waves);

    // O respingo **não é um pouso**. Sem `jump.reset` em `enterWater`, o `airborne`
    // que ficou da queda dispara `JumpLand` com a força do tombo e o pirata passa
    // meio segundo se agachando dentro do mar — e o peso desse agachamento soma com
    // o da água e estoura o total de 1.
    check('o respingo não dispara pouso', controller.jump.land, 0, 1e-12, '');
    check('nem deixa o clipe de ar grudado', controller.jump.air, 0, 1e-12, '');

    stepPlayer(controller, walkForward(), 3, ship, waves);
    check('nadando, quem desenha o corpo é a água', controller.swim.stroke, 1, 0.001, '');
    check('e a passada está apagada', controller.gait.moving, 0, 0.001, '');
    check('com velocidade zero, e não com a de nado', controller.gait.speed, 0, 1e-12, ' m/s');

    // A consequência que se vê: a cabeça de quem nada fica na mesma altura da de
    // quem boia. Antes desta troca ela subia e descia 2,1 cm a cada braçada, que era
    // o balanço da passada emprestada aparecendo na câmera.
    controller.syncView(1, 0, 0, ship);
    check('e o olho de quem nada fica onde o de quem boia fica',
      controller.eyeLocal.y, 0.22, 1e-3, ' m');
  }

  const falhas = cases.filter((c) => !c.passou).length;
  return { passou: falhas === 0, total: cases.length, falhas, cases };
}
