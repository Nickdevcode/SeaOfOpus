/**
 * The player aboard.
 *
 * **The idea that holds the whole file together:** the player lives in the
 * ship's local coordinates, not the world's. Walking on a deck that rolls,
 * heels and yaws is an ugly problem in world coordinates — it would mean adding
 * the hull's velocity, correcting for the rotation, and the player would still
 * slide with every wave. Keeping the position in the ship's frame makes the
 * deck a floor that stands still: the sea rocks the *frame*, and whoever is on
 * top of it comes along for free. It's how Sea of Thieves solves it, and it's
 * why there you can run across a ship mid-turn without thinking twice.
 *
 * The price is that the frame isn't inertial: strictly speaking a jump would be
 * missing Coriolis and centrifugal terms. For a 0.6 s jump on a 16 m hull that
 * comes to centimeters — and the behavior without those forces is what the
 * player *expects* (you land where you jumped). Gravity, on the other hand, does
 * come in rotated into the ship's frame, so jumping on a heeled deck throws the
 * body toward the low side.
 *
 * ## And what happens when the player leaves the ship
 *
 * Falling into the sea is the only state where the sentence above stops holding,
 * and for a physical reason: whoever is in the water **is not carried by the
 * hull**. If the body kept living in ship coordinates, a deckhand floating still
 * would be dragged along at five knots astern of the stern for free — exactly
 * the effect these coordinates exist to produce on deck.
 *
 * The way out is narrow and compatible with everything already here: while
 * swimming, the real position is the **world** one (`worldFeet`), and `local` is
 * rewritten from it every step. The ship pulls away, and `local` follows on its
 * own. Nothing downstream changes a line — camera, avatar, interpolation and
 * snapshot keep reading `local`, without knowing the number is now derived
 * instead of integrated. The same goes for the head's heading: it is
 * ship-relative by construction (the camera composes with the hull's matrix), so
 * swimming means subtracting the ship's yaw to keep the gaze still in the world.
 * See `updateSwim`.
 *
 * ⚠️ **The ceiling on this is `QUANT.local`:** local positions travel as `i16`
 * over 256, which saturates at **±128 m from the ship**. An abandoned swimmer
 * drifts out of that range in a little under half a minute of ship under sail,
 * and from there on his body arrives clamped to the far edge. It's acceptable
 * because the rescue opens in five seconds and the duel is between two hulls,
 * not between two swimmers; it stops being acceptable the day someone wants to
 * watch the opponent bobbing from a distance.
 *
 * What is this file's job: walking, jumping, climbing a ladder, swimming, taking
 * the helm and taking the cannon. The camera belongs to `CameraRig`, interaction
 * focus to `Interaction`.
 */

import * as THREE from 'three';
import { GRAVITY, TAU, clamp, damp, wrapAngle } from '../core/MathUtils';
// `JUMP_SPEED` comes from there because the air clip is what depends on it the
// most: the pose is indexed by vertical velocity, and the scale of that reading
// is the takeoff speed. See `JumpClock`.
import {
  CarryClock,
  CLIMB_CLIP,
  ClimbClock,
  GaitClock,
  HelmClock,
  JUMP_SPEED,
  JumpClock,
  RUN_CLIP,
  SwimClock,
} from './Locomotion';
import { InputBit, held, pressed, type InputFrame } from '../core/InputFrame';
import type { Ship } from '../ship/Ship';
import { HELM_STAND } from '../ship/ShipBuilder';
import {
  BOARDING_RUNG_RADIUS,
  type BoardingLadderSpec,
  boardingLadderForSide,
  boardingLadderStandX,
  insideGangway,
} from '../ship/BoardingLadder';
import { BARREL_BLOCKERS, CANOPY_BLOCKERS, CROW_NEST, MAST_LADDER } from '../ship/ShipParts';
import {
  DECK_Y,
  HOLD_FLOOR_Y,
  HULL_THICKNESS,
  STATIONS,
  ceilingY,
  deckCamber,
  deckHalfWidth,
  halfWidthAtHeight,
  isOverHatch,
  stairSurfaceY,
  tToZ,
  walkableY,
  zToT,
} from '../ship/ShipDimensions';
import type { WaveField } from '../world/WaveField';

/** Where the player is: loose about the ship or working one of its stations. */
export type PlayerStation = 'deck' | 'helm' | 'cannon';

const WALK_SPEED = 2.8;
const RUN_SPEED = 4.7;
/** Convergence of the horizontal velocity, in 1/s. High on ground, low in air. */
const GROUND_CONTROL = 14;
const AIR_CONTROL = 1.6;

const PLAYER_RADIUS = 0.3;
const EYE_HEIGHT = 1.66;
/** Step you go up (and down) without leaving the floor. Covers the 44 cm quarterdeck. */
const STEP_HEIGHT = 0.5;

const PITCH_LIMIT = 1.45;

/**
 * Climb speed on the mast ladder, in m/s.
 *
 * There is only one rigging ladder on the ship now — the mast's. The hold's
 * became a sloped flight, which is floor and needs no mode at all: see
 * `stairSurfaceY`.
 *
 * It was 2.1 m/s before the character had a body, and 2.1 is **seven rungs per
 * second**: with the climb clip playing, the pirate turns into a cartoon. There
 * is nothing wrong with the clip at that speed — the phase is driven by height
 * and the contact stays exact — the problem is that nobody climbs like that. 1.2
 * gives four rungs per second, still nimble, and takes 7.5 s from deck to crow's
 * nest.
 */
const CLIMB_SPEED = 1.2;

/**
 * How far behind the plane of the rungs the player stays, in meters.
 *
 * **Read off the clip, not written here.** It's the thickness of the pirate's
 * coat, so it belongs to the character — and it holds the same for both of the
 * ship's ladders. See `CLIMB_CLIP.standoff` for the story behind the number.
 */
const LADDER_STANDOFF = CLIMB_CLIP.standoff;

/**
 * Half-width of the zone where the mast ladder can be grabbed.
 *
 * **It now takes pressing the interaction button.** The previous version grabbed
 * on brushing against it while walking forward, and that cost plenty: crossing
 * the deck close by the mast glued the player to the ladder with nobody having
 * asked for it, and — worse — reaching the crow's nest gave no way out at all,
 * because going down took the same gesture as going up and the player was stuck
 * up there. With a key, up and down are the same explicit choice, both ways.
 */
const MAST_LADDER_REACH = 0.55;

/**
 * Half-width of the zone where the boarding ladder can be grabbed, measured in
 * the plane of the water from where the body would hang.
 *
 * **More than twice the mast ladder's reach, and the difference is the floor.**
 * There the player stands on a deck that holds still and can shuffle over a
 * centimeter at a time, so 0.55 + 0.30 = 85 cm is slack to spare. A swimmer has
 * none of that: the wave lifts and drops him some 64 cm of standard deviation
 * (`getElevationSigma` in a breeze) and the ladder rocks along with the hull, so
 * a tight reach would make the prompt blink to the rhythm of the sea — and a
 * button that comes and goes on its own is worse than a button that isn't there.
 *
 * 1.20 + `PLAYER_RADIUS` gives 1.50 m from the rung, which is a body's distance:
 * that's where a person actually grabs a boat's ladder. And it's still little
 * enough not to catch the other side — the two rung planes are 3.3 m apart in X.
 */
const BOARDING_LADDER_REACH = 1.2;

/**
 * Surface swim speed, in m/s.
 *
 * **Half the walk, and not a fraction picked at random.** Walking is 2.8 m/s;
 * real swimming, clothed and in open water, sits at 1.2–1.4 m/s for someone who
 * can swim (a cruising crawl), and exactly half the walk lands right on the good
 * end of that range. Writing the ratio instead of the number is what keeps the
 * two tied together if the walk changes: the sea has to stay *twice* the effort
 * of crossing the deck.
 *
 * **There is no sprint in the water**, and that's a decision, not a gap. Three
 * reasons, in order of weight: (1) `Sprint` in the water would be a second speed
 * at no cost at all — this game has no breath and no stamina — and a speed it is
 * never worth *not* using is a button the player holds down forever; (2) the two
 * speeds call for two different strokes (breaststroke and crawl), and there
 * isn't even one clip yet; (3) what decides a duel in the water is reaching the
 * ladder, and the ladder doesn't get any closer for pressing a key. Swimming is
 * a time penalty, and it has to carry one price only.
 *
 * To calibrate what that costs: the Sloop running downwind makes about 2.6 m/s.
 * Swimming after your own ship is impossible on purpose — that's what the rescue
 * is for.
 */
const SWIM_SPEED = WALK_SPEED / 2;

/**
 * How far above the surface the eye sits while floating, in meters.
 *
 * This is where the height of the **feet** in the water comes from (`EYE_HEIGHT`
 * minus this), and not the other way around: what gets framed is the waterline
 * on screen, and it has to sit at the bottom — high enough to see where to swim,
 * low enough for the sea to dominate the view and for the situation to look like
 * what it is. 22 cm is where the eyes of a person treading water actually are.
 */
const SWIM_EYE_HEIGHT = 0.22;

/**
 * How far below the waterline the simulated feet sit while floating, in meters.
 *
 * Falls out for free from the two heights above — the eye is 1.66 m from the feet
 * and 0.22 m from the surface, so the surface is 1.44 m from the feet. It exists
 * as an **exported** constant because it stopped being the physics' business
 * alone: it's what `PlayerAvatar` adds to the body's position to put the origin
 * of the water clips on top of the waterline. See `waterPoseY`.
 *
 * ⚠️ **It is not the same number as `FLOAT_CLIP.sink`, and the 12 cm difference
 * is a choice.** The clip was built with the rig's origin 1.32 m below the
 * surface; the physics simulates 1.44. The physics wins, and the reason is that
 * the two numbers measure different things: 1.32 is where the **animator** put
 * the character's feet so that the chin would clear 11.8 cm of water, and 1.44
 * is where the **camera** is — the surface sits 22 cm from the eye because that
 * is how the sea frames at the bottom of the screen, and that is a decision about
 * the view, not about anatomy.
 *
 * Lining the clip's origin up with the surface (adding 1.44) delivers the clip
 * exactly as it was verified: shoulder 11.2 cm and chin 11.8 cm above the water,
 * which is the clearance `verify()` in `anim_float.py` measures **relative to its
 * own origin**. Adding 1.32 instead would sink the clip 12 cm and the chin grazes
 * the surface — the one thing this game promises does not happen. The price is
 * that the *drawn* feet end up 12 cm above the *simulated* feet; they are a meter
 * and a half down, on a reclined body, and nobody sees them.
 */
export const SWIM_SUBMERSION = EYE_HEIGHT - SWIM_EYE_HEIGHT;

/**
 * Convergence of the body to the wave height, in 1/s.
 *
 * It's the number that decides whether the swimmer **floats** or **runs on a
 * rail**, and it is picked from the sea's spectrum. A first-order damper against
 * a sinusoid delivers `λ/√(λ²+ω²)` of the amplitude with `atan(ω/λ)` of lag; the
 * spectrum in a breeze runs from T = 5.2 s (ω 1.22 — the two long waves, which
 * carry most of the 64 cm of standard deviation) to T = 2.6 s (ω 2.39, the short
 * chop).
 *
 * With 8: the long ones come through at 98.9% and 8.6° of lag — the body rides
 * the big wave practically glued to it, which is what's wanted; the short chop
 * comes through at 95.8% and 16.6°, which reads as the small wave **passing
 * through the body** instead of carrying it, which is exactly what a floating
 * person does.
 *
 * Below ~5 the chop starts getting genuinely flattened (the head sinks at the
 * crest); above ~15 the body is welded to the surface and the vertical motion
 * stops reading as floating.
 */
const SWIM_BOB_LAMBDA = 8;

/**
 * Seconds in the water before the rescue is offered.
 *
 * Five. The delay is not decoration and not punishment: it's what separates "I
 * slipped off the gangway" from "I lost the ship". In those five seconds a swimmer
 * covers 7 m, which is more than enough to reach the boarding ladder if he fell
 * near it — and it's the difference between a player who learns to climb back up
 * and one who learns to press the button. Offering the rescue on the first frame
 * would make the ladder decorative.
 */
const RESCUE_DELAY = 5;

/**
 * Convergence of the step damping, in 1/s.
 *
 * **This is the number that takes the "flick" out of the hold stairs.** The
 * flight has seven 26 cm steps, and the floor under the foot is a staircase
 * function: at every riser crossed the controller reseats the body a whole step
 * in a single frame. For the feet that's the right thing — a step is a step —
 * but the head comes along, and 26 cm of vertical teleport 1.66 m from the eye
 * is exactly the jump you see.
 *
 * The fix is the classic one for FPS games with stairs: the physics stays
 * discrete and the **view** carries a remainder that fades out.
 */
const STEP_SMOOTH_LAMBDA = 16;

/**
 * Ceiling on the speed at which that remainder fades: a fixed part (m/s) plus a
 * share proportional to the walker's speed.
 *
 * A pure exponential wasn't enough, and the reason is arithmetic: with λ = 16 at
 * 60 fps the **first** frame after the step eats 23% of the debt — 8 cm of a
 * 35 cm step. The largest jump still landed right at the instant of the jolt,
 * which is where it bothers; the rest of the curve was invisible from being so
 * smooth.
 *
 * The ceiling fixes that, but it can't be a single number. The hold's flight
 * drops 1.85 m over 1.55 m of run: at a 2.8 m/s walk that's **3.4 m/s of
 * descent**, and a ceiling below that saturates — the debt grows faster than it
 * gets paid and the excess leaks back into the camera step by step. With the
 * ceiling tracking the walk, the view goes down the stairs at the *ramp's* speed
 * while the feet keep landing on the steps, which is exactly the split that's
 * wanted: the feet know there are steps, the eye doesn't need to.
 *
 * And a constant speed is not what gets noticed — what gets noticed is the
 * discontinuity. Dropping 5.6 cm per frame without a jolt reads like walking down
 * a slope.
 */
const STEP_SMOOTH_BASE_RATE = 1.4;
const STEP_SMOOTH_RATE_PER_SPEED = 1.35;

/** Center of the capstan, in local coordinates. */
const CAPSTAN_STAND = new THREE.Vector3(0, DECK_Y, tToZ(STATIONS.capstan));
/**
 * Radius the deckhand walks at while pushing the bars.
 *
 * It's the radius of the bars themselves, measured off `createCapstan`: they come
 * out of the top and reach 1.15 m from the axis. Walking outside them would be
 * pushing air.
 */
const CAPSTAN_RADIUS = 1.05;
/**
 * How far from the axis the interaction button still catches the bars.
 *
 * Exported because the capstan's prompt has to light up **inside** this radius
 * and not outside it: the interactable's `range` is measured from the eye to a
 * point 45 cm above the deck, which adds 1.21 m of vertical leg to the sum.
 * A prompt that lights up where the mode refuses to engage is a button that
 * doesn't answer. See `createShipInteractables`.
 */
export const CAPSTAN_REACH = 2.1;
/**
 * Walking speed around the capstan, in m/s.
 *
 * Well below the normal walk (2.8 m/s) because you don't push a capstan bar by
 * walking: you push it **with your chest**, body leaning in, and the whole ship on
 * the far end of the cable. It's half the tactical cost of anchoring — the other
 * half is the turns, in `Anchor.CAPSTAN_TURNS`.
 */
const CAPSTAN_WALK_SPEED = 1.75;
/**
 * How firmly the head follows the turn, in 1/s: a fixed part plus a share
 * proportional to the effort.
 *
 * The fixed part is what brings the gaze back to the bar when the player lets
 * go of the mouse; the effort share is what keeps the bar from escaping the
 * center of the screen just as he speeds up. See `followCapstan`.
 */
const CAPSTAN_LOOK_LAMBDA = 4;
const CAPSTAN_LOOK_LAMBDA_PER_EFFORT = 5;
/** Where the chin drops while pushing: the hands are on the bars, not the sea. */
const CAPSTAN_PITCH = -0.22;

/**
 * Where the player spawns: mid main deck, between the hatch and the cannons,
 * facing the bow.
 *
 * Not at `HELM_STAND` — which was the obvious pick, since the helm is the first
 * thing anyone wants to use. Except there the player spawns 5 cm from the wheel's
 * collision radius, and whoever holds W in the first second of play doesn't walk:
 * he pushes the wheel head-on, with no tangential component to slide along, and
 * concludes the character is stuck. That's an expensive first impression to save
 * two meters.
 *
 * Nor is it just aft of the hatch, which would be the natural path for someone
 * coming down from the quarterdeck: between the step and the edge of the hole
 * there's a little over a meter, and spawning with your back to an open hatch
 * cover is worse than spawning glued to the helm.
 *
 * From here there's 70 cm to the edge of the hatch, and the view opens onto the
 * mast and the full sail, with the two cannons up in the bows and the stem
 * beyond. The wheel ends up behind whoever turns the camera.
 */
const DECK_SPAWN = new THREE.Vector3(0, DECK_Y, 1.2);

/**
 * Initial heading of the gaze: 24° open to starboard, not the bow exactly.
 *
 * The mast sits on the centerline 2.4 m from the spawn. Looking at 0° it takes up
 * the middle of the screen and the game's first frame is a wooden trunk. Turning
 * a quarter of a radian moves the mast off to the left, and what opens up in its
 * place is the deck all the way to the bow with the sea behind — the same scene,
 * but showing the ship.
 */
const SPAWN_YAW = -0.42;

/**
 * Convergence of the reconciliation offset, in 1/s. ~200 ms to disappear.
 *
 * With 16, what's left after two tenths of a second is `e^(-3.2)` — 4% of the
 * offset, which is to say invisible. It came from `GuestSession`, where it was
 * already written; what changed is that now it **is used**.
 */
const OFFSET_LAMBDA = 16;

/**
 * Largest reconciliation offset the view will slide away, in meters.
 *
 * ⚠️ **It's a motion-sickness ceiling, and the number is derived.** An offset
 * that decays exponentially takes off at `λ·|offset|` in the first instant: with
 * λ = 16, an offset of 1.4 m — which fits comfortably in the band the
 * reconciliation smooths — puts the first-person camera at **22 m/s** for a few
 * tens of milliseconds. Fast camera translation the player never asked for is the
 * classic trigger for motion sickness, and there it would be worse than the jolt
 * it is trying to hide.
 *
 * The ceiling is the speed the player **already knows from his own body**:
 * running. `RUN_SPEED / OFFSET_LAMBDA` is the largest offset whose takeoff is no
 * faster than a run, and a camera that slides at most as fast as the character
 * runs has no way of bothering more than running does.
 *
 * The excess above that is **not** slid away: it lands dry. It's the same decision
 * as `absorbStep` with `STEP_HEIGHT`, and for the same reason written there —
 * above a certain size, smoothing stops being a courtesy and becomes hiding from
 * the player that something happened. An error of thirty centimeters is
 * prediction; one of a meter and a half is disagreement, and disagreement gets
 * shown.
 *
 * In practice the ceiling almost never bites: the error left over on a healthy
 * connection is centimeters (see `GuestSession.reconcile`), and since the swimmer
 * started being compared in world space it's millimeters.
 */
const OFFSET_LIMIT = RUN_SPEED / OFFSET_LAMBDA;

/**
 * Convergence of the step bob, in 1/s.
 *
 * **It was 16, and 16 had a bug that only showed up from inside the body.** A
 * first-order damper against a sinusoidal input lags the output by `atan(ω/λ)`
 * and shrinks it by `λ/√(λ²+ω²)`. Walking at 2.8 m/s the stride gives a 0.65 s
 * cycle with **two** bounces, that is ω = 19.3 rad/s: with λ = 16 the camera came
 * out 50° late and at 64% of the height asked for. While nobody could see his
 * own body that was just seasoning. Once you're wearing the body, it becomes the
 * torso sinking and surfacing 4 cm with every step, 20 cm from the eye.
 *
 * With 48 the lag drops to 22° and the gain rises to 0.94. Above ~80 what's
 * gained in phase is marginal and the curve starts reading as a jolt on dropped
 * frames, because the damping stops filtering what it is there to filter.
 */
const BOB_LAMBDA = 48;

/**
 * Distance from the feet to the top of the head, for ceiling purposes in the hold.
 *
 * It is not the character's real height: 1.78 m does *not* fit under a deck
 * 1.76 m off the floor, and using the honest value would push the player below
 * the floor. What this number protects is the camera — with the eye at 1.66 m,
 * there's room for the bob at its worst case (the run) plus a three-centimeter
 * margin so the head doesn't pass through the plank and reveal the deck from the
 * inside. The Sloop's hold is that tight for real: you walk in it, you don't jump.
 */
const HEAD_CLEARANCE = EYE_HEIGHT + RUN_CLIP.bounceAmplitude + 0.03;

/**
 * Field of view on foot, in degrees. The player tunes it in Settings.
 *
 * Aiming down the cannon is a **fraction** of this value, and not a fixed
 * number: the zoom is what the gunner gains by putting his eye to the gun, and
 * that advantage can't depend on how wide the player opened his field in the
 * menu. With a hard-coded `AIM_FOV`, someone playing at 100° of field would get
 * three times the zoom of someone playing at 62° — a competitive edge hidden in
 * a comfort option.
 */
const AIM_FOV_RATIO = 34 / 62;

/**
 * Deck obstacles, as vertical cylinders in local coordinates.
 *
 * A cylinder is crude for a cannon, but it is what the player feels: he does not
 * touch the outline of the piece, he goes around an obstruction. What matters is
 * that mast, capstan and cannons exist for the feet, and not only for the eyes.
 */
interface Blocker {
  x: number;
  z: number;
  radius: number;
  /** If `true`, the obstacle also exists in the hold (only the mast, today). */
  throughHold?: boolean;
}

/**
 * The pose of a sailor arriving ready over the network. See `applyRemoteStep`.
 *
 * It is satisfied structurally by the `CrewState` the snapshot produces — on
 * purpose: a type imported from `net/` here would invert the dependency and make
 * the player on deck need the network format in order to compile.
 */
export interface RemoteCrewPose {
  /** Position of the feet, in their ship's local coordinates. */
  readonly local: THREE.Vector3;
  readonly yaw: number;
  readonly pitch: number;
  readonly station: PlayerStation;
  readonly cannonIndex: number;
  readonly grounded: boolean;
  readonly onLadder: boolean;
  readonly atCapstan: boolean;
  /** `true` when they have the plank in their hands. See `Interaction.patching`. */
  readonly patching: boolean;
  /**
   * `true` when they are in the sea.
   *
   * It is the only water state that crosses the wire. Everything else is derived
   * from the position, which already travels: the body's height relative to the
   * wave, the swimming heading — and even **which of the two boarding ladders**
   * they are hanging from, because the two are seven meters apart in Z. See
   * `boardingLadder`.
   */
  readonly inWater: boolean;
}

/**
 * Displacement that stops being walking and becomes a teleport, in meters per step.
 *
 * Half a meter is seven times what a run covers in a 1/60 s step (4.7 m/s gives
 * 7.8 cm), so no legitimate walk comes close — and the real discontinuities
 * (taking the helm, mounting the gun, respawning) pass it comfortably.
 */
const REMOTE_TELEPORT = 0.5;

const _moveDir = new THREE.Vector3();
const _gravity = new THREE.Vector3();
const _euler = new THREE.Euler(0, 0, 0, 'YXZ');
const _pivot = new THREE.Vector3();
/** The remote sailor's displacement on this step. See `applyRemoteStep`. */
const _remoteStep = new THREE.Vector3();
/** World scratch, for swimming's round trips. See `updateSwim`. */
const _world = new THREE.Vector3();
/** The step's walking axis. Reused: nothing here allocates per tick. */
const _move = { x: 0, y: 0 };

/**
 * `true` when (x, z) falls **outside the deck's edge** — outboard of the
 * planking, where there is neither floor nor planking to hold anyone up.
 *
 * ## Why the ruler is the deck's edge, and not the hull at body height
 *
 * Because the second is not monotonic and the first is. The hull changes width
 * with height: at the quarterdeck it has already pulled in (the bulwark falls
 * inward) and further down it opens back out to the maximum beam. Testing against
 * the width *at body height* would make a body that fell straight down through the
 * gangway be "inside" the hull again halfway through the fall, and the solvers
 * would fish it back into the hold. Against a ruler that does not depend on `y`,
 * whoever left is outside and stays outside until they touch the water.
 *
 * And it is conservative in both directions, which was measured: the hold is never
 * wider than the deck's edge at the same station (the worst case is 5 cm **less**,
 * at the bow), so nobody in the hold is read as being outside the ship.
 */
function outsideHull(x: number, z: number): boolean {
  return Math.abs(x) > deckHalfWidth(zToT(z));
}

/** What `surfaceAt` returns where there is no floor. See the note there. */
const NO_FLOOR = Number.NEGATIVE_INFINITY;

/**
 * How far the gangway's sill sticks out past the planking, in `|x|`.
 *
 * ⚠️ **It mirrors `HullGeometry.buildGangways`**, and the mirroring is mandatory:
 * that plank is the only thing crossing the 18 cm between the planking and the
 * ladder, and without it the top rung hangs over the sea. If the mesh stopped
 * short of here, the player would walk over nothing all the way to its edge; if it
 * stopped past it, they would fall on top of a plank that is drawn.
 *
 * The arithmetic is the one over there, letter for letter: the sill dies at the
 * **inner edge** of the top rung, which is where the step's nose starts.
 */
function gangwaySillX(spec: BoardingLadderSpec): number {
  return spec.topX - BOARDING_RUNG_RADIUS;
}

/**
 * Height of the gangway's sill under (x, z), or `null` where it is not.
 *
 * ⚠️ **The `outsideHull` guard is what keeps the sill from becoming the hold's
 * ceiling.** It is a 42 cm plank that starts *at* the deck's edge and advances
 * outward from it — inboard of the planking, in the same band of Z, what rules is
 * still the deck (or the hold's floor, for whoever is down there). Without the
 * guard, a sailor pumping in the hold under the gangway would be lifted 2.3 m and
 * planted on top of a plank that is outside the ship.
 *
 * The joint with the deck is smooth by construction: the camber (`deckCamber`) is
 * zero exactly at the edge, so the two floors meet at `QUARTERDECK_Y` with no
 * step. Whoever crosses the gangway feels nothing — which is right, because the
 * wood there is continuous.
 */
function gangwaySurface(x: number, z: number): number | null {
  if (!insideGangway(z) || !outsideHull(x, z)) return null;
  const spec = boardingLadderForSide(x);
  return Math.abs(x) <= gangwaySillX(spec) ? spec.exitY : null;
}

export class PlayerController {
  station: PlayerStation = 'deck';
  /** Index of the occupied cannon, or -1. */
  cannonIndex = -1;

  /** Position of the feet, in the ship's local coordinates. */
  readonly local = new THREE.Vector3();
  /** Velocity in the ship's frame, in m/s. */
  readonly velocity = new THREE.Vector3();

  /** Heading of the head **relative to the ship**: 0 looks at the bow. */
  yaw = 0;
  pitch = 0;

  grounded = true;
  /**
   * `true` while the player is hanging from a ladder — the mast's or one of the
   * two boarding ladders.
   *
   * Which one is **not** stored here: `boardingLadder` derives it from the
   * position, and that is why the snapshot does not spend a bit on the question.
   */
  onLadder = false;
  /**
   * `true` while the player is in the sea, floating or swimming.
   *
   * There is no punishment attached to this at all: no drowning, no death, no end
   * timer. The ship keeps sailing on its own and the player gets back aboard by
   * the boarding ladder or by the rescue. Falling into the sea is a loss of *time*
   * and of position in the duel, and that is expensive enough already.
   */
  inWater = false;
  /**
   * Uninterrupted seconds in the water. It is the rescue's clock.
   *
   * Zeroed on leaving the sea by any route, and that is the part that matters:
   * somebody who climbs the ladder, falls in again and climbs back out does not
   * accumulate rescue credit between the falls.
   */
  waterTime = 0;
  /**
   * The speed at which the body entered the water on this step, in m/s, or 0.
   *
   * Consumed by `Match`, which turns it into the **same** splash event the ball
   * uses — and that is why it leaves from here instead of the controller talking to
   * the effects: the event already knows how to become smoke, sound and network
   * bytes, so the opponent sees the splash of whoever fell without a new field in
   * the snapshot.
   */
  splashSpeed = 0;
  /** Where in the world that splash happened. See `splashSpeed`. */
  readonly splashAt = new THREE.Vector3();
  /**
   * How many rescues this sailor has asked for. Changes on every request granted.
   *
   * A counter, and not a flag: whoever draws the screen's blackout needs an
   * **edge**, and a flag that lasts one step is lost to any frame that does not
   * land on top of it. See `Blackout`.
   */
  rescueCount = 0;
  /**
   * Position of the feet in **world** space, maintained while swimming.
   *
   * It is the real position in the water: `local` becomes derived from it on every
   * step, and not the other way round. See the file's header.
   *
   * Public because the network reconciliation needs it: in the water **this** is
   * the quantity the prediction owns, and comparing the derived one would be
   * comparing two calculations made with different hull poses. See
   * `GuestSession.reconcile`. Only valid with `inWater`.
   */
  readonly worldFeet = new THREE.Vector3();
  /**
   * Swimming velocity in **world** space, in m/s.
   *
   * It is what integrates `worldFeet`, and it exists separately from `velocity`
   * because the two measure different things in the water: this one is what the
   * body does against the sea, and `velocity` is still what it does against the
   * ship — which is what all the rest of the game reads, from the body's heading to
   * the stride's clock. Out of the water it is worth nothing.
   */
  private readonly worldVelocity = new THREE.Vector3();
  /** The hull's heading on the previous step, to deduct its yaw while swimming. */
  private shipHeading = 0;
  /**
   * Step remainder the view has not absorbed yet, in meters.
   *
   * Positive when the foot has just **gone up** a step (the view falls behind and
   * catches up), negative when it went down. See `STEP_SMOOTH_LAMBDA`.
   */
  private stepOffset = 0;
  /**
   * An offset **only the view** owes, in the ship's local coordinates.
   *
   * It is a sibling of the `stepOffset` just above: a debt the simulation created
   * and the eye pays off slowly, without the simulated position knowing. The
   * difference is where it comes from — there it is a step, here it is the network
   * correcting a prediction.
   *
   * ## ⚠️ The piece existed in full and was never wired to anything
   *
   * This offset was computed, accumulated and decayed inside `GuestSession` for as
   * long as reconciliation has existed, with a public getter documented as "the
   * body's visual offset, which the render adds to the position" — and **no file in
   * the project read that getter**. `decayOffset` was called every frame by the main
   * loop, so the debt was born and died properly, without ever reaching a pixel.
   *
   * The effect is the opposite of what the comment over there promises: the middle
   * band of the reconciliation — from 8 cm to 1.5 m, which is where almost every
   * real correction lives — was smoothed by **nothing**. What happened was a raw
   * write into the position, fifteen times a second, on deck and in the water. It is
   * the kind of defect that raises no error, does not disappear from the code and
   * even has a comment swearing it works; it stayed live for years because the only
   * evidence of it is a `grep` that finds nobody.
   *
   * It lives here, and not in `GuestSession`, for two reasons: `syncView` is what
   * assembles the frame's pose (adding it from outside would take reaching into
   * `eyeLocal` between two calls of the main loop and hoping the order never
   * changes), and here it is testable without `Match` — which needs a canvas and
   * does not run outside the browser.
   */
  readonly viewOffset = new THREE.Vector3();
  /**
   * Turns of the bar pushed on the capstan this frame.
   *
   * It comes from here, and not from `Interaction`, because whoever knows how far
   * the player walked is the controller. The interactable only passes it on. See
   * `pushCapstan`.
   */
  capstanTurns = 0;
  /**
   * `true` while the player has their hands on the capstan bars.
   *
   * It is a **mode**, not a held button: you enter with one tap and leave with
   * another. See `enterCapstan`.
   */
  atCapstan = false;

  /**
   * The eye pose `CameraRig` consumes, in local coordinates.
   *
   * It is the **frame's** pose — interpolated between two steps by `syncView`, and
   * not the one the simulation wrote. Whoever wants the simulation's uses `local`.
   */
  readonly eyeLocal = new THREE.Vector3();
  readonly eyeQuaternion = new THREE.Quaternion();

  /** The current step's pose and the previous one's, which `syncView` interpolates. */
  private readonly simEyeLocal = new THREE.Vector3();
  private readonly simVisualLocal = new THREE.Vector3();
  private readonly previousEyeLocal = new THREE.Vector3();
  private readonly previousVisualLocal = new THREE.Vector3();
  /**
   * Where the feet **appear** to be, in local coordinates.
   *
   * It differs from `local` only vertically, and only while a step is being
   * absorbed. It is what the player's body (`PlayerAvatar`) draws: without it the
   * camera would go up the stairs smoothly and the character beside it would go up
   * in jumps, which is the same defect seen from outside.
   */
  readonly visualLocal = new THREE.Vector3();
  /** Desired field of view, in degrees. */
  fov = 62;
  /** Field of view on foot, chosen by the player in Settings. */
  private baseFov = 62;

  /** Changes on every station change: the rig uses it to trigger the transition. */
  stationChangeCount = 0;

  /**
   * The stride's clock. It is public because the player's body (`PlayerAvatar`)
   * reads from here instead of keeping a count of its own: one phase alone means
   * the foot you see touch the deck is the same one that shakes the camera.
   */
  readonly gait = new GaitClock();

  /**
   * The jump's clock, public for the same reason as the stride's: whoever knows
   * whether the feet are on the deck is this object, and the body only reads. It is
   * separate from `GaitClock` because the two overlap — you can jump while running,
   * and the air's weight comes in on top of the locomotion blend instead of
   * replacing it.
   */
  readonly jump = new JumpClock();

  /**
   * The ladder's clock, public for the same reasons as the other two — and with one
   * extra demand: it needs to know **how far the body climbed on this frame**, not
   * at what speed, because it is the height that marries the hand to the rung. What
   * has that number is `climb`, down here.
   */
  readonly climb = new ClimbClock();

  /**
   * The helm's clock, public like the other three. It asks for the cheapest
   * quantity of all — the **wheel's angle**, which `Rudder` already maintains — and
   * that is why the helmsman's hand lands on top of a handle that is drawn without
   * anything needing to be aligned on taking the helm.
   */
  readonly helm = new HelmClock();

  /**
   * The repair plank's clock. It is the only one **not** fed from in here: whoever
   * knows whether the player is nailing a plank is `Interaction`, which sees the
   * breach and the button in the same frame. See `Match.update`.
   */
  readonly carry = new CarryClock();

  /**
   * The water's clock, public like the other five. It reads the swimming velocity,
   * which is the cheapest world quantity there is here, and splits the sea's two
   * clips between them. See `SwimClock` and `PlayerAvatar.updateSwim`.
   */
  readonly swim = new SwimClock();
  private bobOffset = 0;
  /** Where the player returns to on letting go of the helm or the cannon. */
  private readonly stationReturn = new THREE.Vector3();
  private stationReturnYaw = 0;

  private readonly blockers: Blocker[];
  /** Band of Z where the deck is wide enough to fit somebody. */
  private readonly deckRange: { min: number; max: number };
  private readonly holdRange: { min: number; max: number };

  constructor() {
    const cannonX = deckHalfWidth(STATIONS.cannon) - 0.5;
    this.blockers = [
      // The mast has a 24 cm radius at the deck, and the iron bands add 4 cm. The
      // 0.46 it used to be was guessed margin, and on a trunk born in the middle
      // of the corridor 20 cm of invented margin costs 20 cm of passage on each
      // side.
      { x: 0, z: tToZ(STATIONS.mast), radius: 0.34, throughHold: true },
      { x: 0, z: tToZ(STATIONS.capstan), radius: 0.55 },
      { x: cannonX, z: tToZ(STATIONS.cannon), radius: 0.75 },
      { x: -cannonX, z: tToZ(STATIONS.cannon), radius: 0.75 },
      // The rudder drum. **0.32, and not the 0.5 it used to be**: the helmsman's
      // station came in to 62 cm from the plane of the wheel (see `HELM_STAND`),
      // and 0.5 plus the player cylinder's 0.30 puts the station itself **inside**
      // the obstacle — anyone walking up would be pushed off the helm before they
      // could take it. 0.62 − PLAYER_RADIUS is the largest radius that still
      // leaves the station outside, and it is not an invented radius: the drum's
      // after face sits 0.22 m from the plane of the wheel, so there are 10 cm
      // left between the wood and the cylinder.
      { x: 0, z: tToZ(STATIONS.helm), radius: 0.32 },
      // Binnacle, just ahead of the wheel. Mirrors the box in `buildBinnacle`.
      { x: 0, z: tToZ(STATIONS.helm) - 1.05, radius: 0.32 },
      // Barrels: read from `BARREL_BLOCKERS`, which is the same list that draws
      // them. They used to be three pairs of numbers copied by hand, and they had
      // already diverged from the model — the collision sat 17 cm beside the wood.
      ...BARREL_BLOCKERS.map((barrel) => ({ ...barrel })),
      // The after awning's columns, for the same reason as the barrels: they are
      // real wood in the path of whoever walks the quarterdeck.
      ...CANOPY_BLOCKERS.map((post) => ({ ...post })),
    ];

    // Measured off the hull itself instead of hardcoded: the day the bow gets
    // finer or the hold changes height, the walking limit follows on its own.
    this.deckRange = measureWalkRange((t) => deckHalfWidth(t));
    this.holdRange = measureWalkRange(
      (t) => halfWidthAtHeight(t, HOLD_FLOOR_Y + 0.5) - HULL_THICKNESS,
    );
  }

  /**
   * `true` when the player is below the main deck.
   *
   * The water is excluded on purpose, and not out of caution: the swimmer's feet
   * sit 1.44 m below the surface, which in ship coordinates is well below the deck
   * — and without this clause a sailor floating away would start being read as
   * being in the hold. Everybody who asks this (the hold's ceiling, the deck's
   * obstacles, the interaction focus's floor) would give the wrong answer.
   */
  get inHold(): boolean {
    return !this.inWater && this.local.y < DECK_Y - STEP_HEIGHT;
  }

  /**
   * `true` when the body is outboard of the planking — in the gangway opening or
   * beyond it.
   *
   * It is the question that releases all three solvers at once: outside the hull
   * there is no floor, no planking and no obstacle. See `outsideHull`.
   */
  private get overboard(): boolean {
    return outsideHull(this.local.x, this.local.z);
  }

  /**
   * The boarding ladder the player is hanging from, or `null` when the ladder is
   * the mast's.
   *
   * **Derived from the position, and that is why the snapshot does not spend a bit
   * on it.** The ship's two ladders are 7.16 m apart in Z — the mast's at −0.86,
   * the boarding ones at +6.30 — and `insideGangway` is exactly the same question
   * the gangway already asks. Keeping the answer in a field would be keeping
   * something the position already says, at the cost of one more piece of state to
   * synchronize; deriving costs two comparisons and works the same for the
   * opponent's body, which only receives positions.
   */
  private get boardingLadder(): BoardingLadderSpec | null {
    if (!this.onLadder || !insideGangway(this.local.z)) return null;
    return boardingLadderForSide(this.local.x);
  }

  /**
   * Heading the ladder imposes on the body, in radians. Only valid with `onLadder`.
   *
   * It exists because there was a `Math.PI` hardcoded in `PlayerAvatar`, and that
   * number was the heading of the **mast ladder** — the only one there was. A
   * boarding ladder sits on the ship's side and is faced from outside in, so the
   * body has to turn a quarter turn toward its side.
   */
  get ladderFacing(): number {
    const spec = this.boardingLadder;
    if (!spec) return Math.PI;
    // The body is **outboard** of the plane of the rungs (the standoff adds in
    // |x|), so it faces the ship: −X on starboard, +X on port. The model looks at
    // local +Z after the rotation, and (sin f, cos f) = (−1, 0) gives f = −π/2.
    return spec.side > 0 ? -Math.PI / 2 : Math.PI / 2;
  }

  /**
   * Tilt the ladder imposes on the body, in radians. Only valid with `onLadder`.
   *
   * ⚠️ **Without this the clip puts the hand off the rung, and the error grows with
   * height.** `ClimbUp` was built for a **vertical** ladder: the rungs are on a
   * vertical line in front of the chest. The boarding ladder is raked 14.11° to
   * follow the bilge, so relative to a standing body the rung above comes out 14°
   * to the side — and the deviation accumulates with the climb, because the line
   * moves away from the vertical linearly. Tilting the body by the same angle makes
   * the ladder vertical again *in its frame* and the grip matches by construction,
   * on any rung.
   */
  get ladderTilt(): number {
    return this.boardingLadder?.tilt ?? 0;
  }

  /** Sets the field of view on foot. Comes from the player's preferences. */
  setFieldOfView(degrees: number): void {
    this.baseFov = clamp(degrees, 45, 110);
    if (this.station !== 'cannon') this.fov = this.baseFov;
  }

  /** Puts the player standing on the main deck, looking at the bow. */
  spawn(): void {
    this.station = 'deck';
    this.cannonIndex = -1;
    this.onLadder = false;
    this.atCapstan = false;
    this.grounded = true;
    this.inWater = false;
    this.waterTime = 0;
    this.splashSpeed = 0;
    this.local.copy(DECK_SPAWN);
    this.velocity.set(0, 0, 0);
    this.yaw = SPAWN_YAW;
    this.pitch = -0.05;
    this.gait.reset();
    this.jump.reset();
    this.climb.reset();
    this.carry.reset();
    this.helm.reset();
    this.swim.reset();
    this.bobOffset = 0;
    this.stepOffset = 0;
    // Respawning is the biggest teleport there is: an offset saved from before it
    // would drag the view to the place the body drowned in.
    this.viewOffset.set(0, 0, 0);
    this.fov = this.baseFov;
    this.stationChangeCount++;
    this.updateEye();
  }

  /**
   * Takes the helm. No effect if already at a station — or in the water.
   *
   * The water enters all three stations' guard because `station` is still `'deck'`
   * for whoever is floating: the post does not change on falling into the sea, and
   * without this clause a swimmer at the stern would take the helm from inside the
   * ocean. The interaction focus already does not offer the part (the sea is a
   * level of its own — see `Interactable.level`), but this is not called only by
   * it.
   */
  takeHelm(): void {
    if (this.station !== 'deck' || this.inWater) return;
    this.saveReturn();
    this.station = 'helm';
    this.local.copy(HELM_STAND);
    this.velocity.set(0, 0, 0);
    this.grounded = true;
    this.onLadder = false;
    this.atCapstan = false;

    // Turning toward the bow is not framing, it is the only possible pose.
    //
    // The wheel sits at z 6.32 and the helmsman's station at 6.94: whoever takes
    // the helm is *abaft* it, facing the ship. Except that lighting the prompt
    // takes looking at the wheel, meaning looking astern — and without this line
    // the player was teleported behind the wheel keeping that head heading. The
    // result is what the capture showed: a screen full of open sea, the helm
    // behind the back of the head and the whole ship out of frame. Nobody steers a
    // boat with their back to it.
    //
    // `CameraRig` interpolates the orientation over 0.28 s, so the half turn comes
    // out as a turn of the head and not as a hard cut. And `leaveStation` already
    // returns the heading saved in `saveReturn`, so letting go of the helm puts
    // the gaze exactly back where it was before taking it.
    this.yaw = 0;
    // A little downward: it is where the wheel and the binnacle are, and it is the
    // natural tilt of somebody with their hands on the helm.
    this.pitch = -0.14;

    this.stationChangeCount++;
  }

  /** Mounts a cannon by index in `ship.cannons`. See `takeHelm`'s guard. */
  mountCannon(index: number): void {
    if (this.station !== 'deck' || this.inWater) return;
    this.saveReturn();
    this.station = 'cannon';
    this.cannonIndex = index;
    this.velocity.set(0, 0, 0);
    this.grounded = true;
    this.onLadder = false;
    this.atCapstan = false;
    this.stationChangeCount++;
  }

  /** Lets go of the helm or the cannon and walks again from where it left. */
  leaveStation(): void {
    if (this.station === 'deck') return;
    this.station = 'deck';
    this.cannonIndex = -1;
    this.local.copy(this.stationReturn);
    this.yaw = this.stationReturnYaw;
    this.velocity.set(0, 0, 0);
    this.fov = this.baseFov;
    this.stationChangeCount++;
  }

  /**
   * `true` when the player is close enough to the mast ladder to grab it. The one
   * asking is the interactable, which lights the prompt.
   *
   * The reach is measured in the plane of the deck and the height band covers both
   * ends: the foot of the ladder and the crow's nest. It is the same question in
   * both places, which makes "up" and "down" the same gesture in opposite
   * directions.
   */
  canGrabMastLadder(): boolean {
    if (this.station !== 'deck' || this.onLadder || !this.grounded || this.inWater) return false;

    // In the crow's nest, **being in the nest** already means being at the foot of
    // the ladder: it has a 98 cm radius, the body takes up 30 and the gap is the
    // only way out. Demanding alignment up there would trap the player in the nest
    // over fifteen centimeters — which is exactly the defect this part came to fix.
    if (this.onCrowNest()) return true;

    if (this.local.y < MAST_LADDER.bottomY - 0.3 || this.local.y > CROW_NEST.y + 0.4) return false;
    return (
      Math.abs(this.local.x) <= MAST_LADDER_REACH + PLAYER_RADIUS &&
      Math.abs(this.local.z - MAST_LADDER.z) <= MAST_LADDER_REACH + PLAYER_RADIUS
    );
  }

  /**
   * Grabs the mast ladder. Called by the interaction button.
   *
   * **Forward climbs, back descends — at both ends.** There was a version that
   * remembered the direction the ladder had been taken from and made W "continue
   * the gesture": whoever entered through the crow's nest went down with the same W
   * that took them up there. The intent was good and the result was the opposite of
   * what anyone who has ever climbed a ladder in a game expects — hanging nine
   * meters up, pushing the stick forward went **down**. A command that inverts
   * halfway is not a shortcut, it is a bug with a justification.
   */
  grabMastLadder(): void {
    this.onLadder = true;
    this.atCapstan = false;
    this.velocity.set(0, 0, 0);
    this.grounded = false;
    this.stepOffset = 0;
    this.local.x = 0;
    this.local.z = MAST_LADDER.z + LADDER_STANDOFF;
    // Whoever enters through the nest starts just below its floor; whoever enters
    // from the deck stays where they are. The upper clamp is what keeps the exit
    // at the top from firing on the same frame as the grab and putting the player
    // back in the nest without their having gone down a single rung.
    this.local.y = Math.min(this.local.y, CROW_NEST.y - 0.25);
    // And the clip is aligned to the grid of rungs **once**, here. Since the phase
    // advances with the height gained and the cycle climbs exactly two ratlines,
    // the alignment holds on its own until the player lets go — no matter how many
    // meters they climb, nor whether they stop halfway, nor whether they descend.
    this.climb.align(this.local.y, MAST_LADDER.bottomY, MAST_LADDER.rungSpacing);
  }

  /**
   * The boarding ladder within reach of somebody in the water, or `null`.
   *
   * **From the water only**, and it is a design decision: the ladder is for
   * *climbing*. To get into the sea the player jumps through the gangway, which is
   * the gap in the bulwark that exists for exactly that. A ladder you could grab
   * from aboard would give a duel two ways of doing the same thing, and the worse
   * of them would be the one that traps the player in a mode by brushing the
   * bulwark — the defect the mast ladder already paid once to fix (see
   * `MAST_LADDER_REACH`).
   *
   * The reach is measured in the plane of the water, from the position the body
   * **would hang at** on the bottom rung — and not from the plane of the rungs. The
   * difference is the coat's standoff (29 cm), and using the plane of the rungs
   * would light the prompt 29 cm further away than the hand reaches.
   */
  reachableBoardingLadder(): BoardingLadderSpec | null {
    if (!this.inWater || this.onLadder || this.station !== 'deck') return null;

    const spec = boardingLadderForSide(this.local.x);
    const grip = boardingLadderStandX(spec, spec.bottomY);
    const dx = Math.abs(this.local.x) - grip;
    const dz = this.local.z - spec.z;
    const reach = BOARDING_LADDER_REACH + PLAYER_RADIUS;
    return dx * dx + dz * dz <= reach * reach ? spec : null;
  }

  /**
   * Grabs the boarding ladder and leaves the water. Called by the interaction
   * button.
   *
   * The height is the one the body already had, clamped to the ladder: whoever
   * arrives swimming has their feet 1.44 m below the surface, meaning **below the
   * deepest rung**, and the clamp is the gesture of pulling yourself up to the
   * first hold. The upper clamp exists for the same reason as on the mast ladder —
   * without it the exit at the top would fire on the same frame as the grab.
   */
  grabBoardingLadder(spec: BoardingLadderSpec): void {
    this.leaveWater();
    this.onLadder = true;
    this.atCapstan = false;
    this.velocity.set(0, 0, 0);
    this.grounded = false;
    this.stepOffset = 0;
    this.local.y = clamp(this.local.y, spec.bottomY, spec.topY - 0.25);
    this.local.x = spec.side * boardingLadderStandX(spec, this.local.y);
    this.local.z = spec.z;
    // The same single alignment as the mast ladder, with **this** ladder's grid.
    // It did not round the spacing (see `BOARDING_RUNG_SPACING`), so the phase
    // falls even more exactly: the rise per cycle is two gaps by construction.
    this.climb.align(this.local.y, spec.bottomY, spec.rungSpacing);
  }

  /**
   * Writes the authoritative position that arrived over the network, in the frame
   * it was compared in.
   *
   * ⚠️ **It exists because in the water the real position is the world one.**
   * `local` is derived from it on every step, so correcting only the derived one
   * would be a correction undone on the next step — a swimmer's prediction error
   * would never close. And the reverse holds too: on deck what rules is `local`,
   * and writing world there would mean translating by a hull pose that is nobody's.
   *
   * @param world `true` when `position` is in world space. The one who decides is
   *   `GuestSession.reconcile`, which compared one of the two things.
   */
  applyAuthoritative(position: THREE.Vector3, world: boolean, ship: Ship): void {
    if (world) {
      this.worldFeet.copy(position);
      ship.body.worldToLocal(this.worldFeet, this.local);
      return;
    }
    this.local.copy(position);
    if (this.inWater) ship.body.localToWorld(this.local, this.worldFeet);
  }

  /**
   * Writes the water state the host confirmed.
   *
   * It only acts on the **change**, and only entering has work to do: starting to
   * swim requires seeding the world position, which is where the body starts
   * living. Leaving is just switching off — whoever puts the body somewhere is the
   * teleport that came with it (the ladder, the rescue), and that arrives through
   * `applyAuthoritative`.
   *
   * The rescue clock is zeroed in both directions on purpose: if the host disagreed
   * about where this sailor was, the count over here was describing a different
   * dunking.
   */
  applyAuthoritativeWater(inWater: boolean, ship: Ship): void {
    if (inWater === this.inWater) return;
    this.inWater = inWater;
    this.waterTime = 0;
    if (!inWater) return;
    this.grounded = true;
    this.velocity.set(0, 0, 0);
    this.worldVelocity.set(0, 0, 0);
    // For the same reason as `enterWater`: if the host disagreed about where this
    // sailor was, this is where their fall ends — and it does not end in a landing.
    this.jump.reset();
    ship.body.localToWorld(this.local, this.worldFeet);
  }

  /**
   * `true` when the player has been in the water long enough to call for help.
   *
   * See `RESCUE_DELAY` for why five seconds.
   */
  canRequestRescue(): boolean {
    return this.inWater && this.waterTime >= RESCUE_DELAY;
  }

  /**
   * Back aboard: the crew throws a rope and the body reappears at their ship's
   * starting point.
   *
   * **In a networked duel this is executed by the host**, like everything that
   * touches authoritative position. The guest calls the same method on the same
   * step (it is the same `Crewman.fixedUpdate` on both sides) and predicts the
   * teleport; the next snapshot describes a past earlier than the request, so the
   * position that arrives is still the one in the water — and the difference is
   * more than a meter and a half, which falls into the reconciliation's legitimate
   * teleport band and is resolved with a single jump instead of an oscillation. See
   * `GuestSession.reconcile`.
   *
   * The screen blackout is **local and visual**: it decides nothing, it only covers
   * the instant the body changes place. See `rescueCount` and `Blackout`.
   */
  requestRescue(): void {
    if (!this.canRequestRescue()) return;
    this.spawn();
    this.rescueCount++;
  }

  /**
   * Puts the hands on the capstan bars.
   *
   * **It is a mode, and not a held button.** Weighing the anchor by holding the
   * interaction button seemed faithful — it is the gesture of somebody pushing —
   * but in practice it asked the player to keep a key pressed, walk in a circle and
   * still fix the camera with whatever hand was left. One tap enters, another
   * leaves, and in between what is asked is the only thing that matters: **walking
   * forward**, turn after turn. See `pushCapstan`.
   */
  enterCapstan(): void {
    if (this.station !== 'deck' || this.onLadder || this.inHold || this.inWater) return;
    this.atCapstan = true;
    this.velocity.set(0, 0, 0);
  }

  /**
   * Lets go of the bars and walks the deck again.
   *
   * It zeroes the velocity because whatever is left is tangential to the capstan's
   * circle (see `pushCapstan`): without this, letting go mid-turn would spit the
   * player out sideways, in the direction the bar was taking them.
   */
  leaveCapstan(): void {
    this.atCapstan = false;
    this.velocity.set(0, 0, 0);
  }

  /**
   * One simulation step of the sailor.
   *
   * It runs on the fixed step, and not on the frame, for two reasons that add up.
   * The network one is obvious: without a whole shared clock there is no way for
   * the other side to reproduce what this player did. The physics one predates it
   * and holds even offline — `capstanTurns` was a quantity measured **per frame**
   * and consumed **per step**, which made weighing the anchor depend on the FPS. At
   * 144 frames the capstan received more than the step could spend; at 30, less.
   */
  fixedUpdate(dt: number, frame: InputFrame, ship: Ship, waves: WaveField): void {
    // Zeroed every step: whoever wants to turn the capstan or pump has to ask
    // again. Releasing `F` stops acting on the same step, with no command inertia.
    ship.controls.capstanTurns = 0;
    ship.controls.pumping = false;
    ship.controls.wheel = 0;
    this.capstanTurns = 0;
    // Likewise: the splash belongs to the step the body crossed the surface on, and
    // what consumes it is `Match`, on the same step. See `splashSpeed`.
    this.splashSpeed = 0;

    // The previous step's pose, saved before anything touches it: it is what
    // `syncView` interpolates from. Same technique as `ShipBody.previousCom`, and
    // for the same reason — without it the camera would move in 60 Hz steps on a
    // 144 Hz screen.
    this.previousEyeLocal.copy(this.simEyeLocal);
    this.previousVisualLocal.copy(this.simVisualLocal);

    // `X` (or B on the pad) lets go of the part. It comes before the switch so the
    // rest of the step already runs as a player on foot — with no ghost station
    // step.
    if (this.station !== 'deck' && pressed(frame, InputBit.Exit)) this.leaveStation();

    switch (this.station) {
      case 'helm':
        this.updateHelm(dt, frame, ship);
        break;
      case 'cannon':
        this.updateCannon(dt, frame, ship);
        break;
      default:
        this.updateOnFoot(dt, frame, ship, waves);
        break;
    }

    // At the end of the step, and after the body has already moved: the hull's
    // heading is the reference swimming uses to deduct the yaw, and it has to be
    // the one from the **previous step** when `updateSwim` runs. See there.
    this.shipHeading = ship.heading;
    this.updateEye();
  }

  /**
   * One step of a sailor that is **not** simulated here: the pose arrives ready.
   *
   * It is the opponent body's path on the client that does not simulate. It exists
   * because the pose alone animates nobody: what moves the character on screen is
   * not the position, it is the **clocks** — stride, jump, ladder, helm and plank —
   * and they are fed by quantities the snapshot does not carry (velocity on deck,
   * height gained per frame, wheel angle). Without this method, the sailor on the
   * other side arrived at the right place in a statue's pose, sliding across the
   * deck like a board-game piece.
   *
   * ## Why the velocity is derived, and not transmitted
   *
   * Because deriving it comes for free and arrives **better**. The position already
   * comes interpolated between two snapshots (see `GuestSession.applyCrew`), so the
   * difference between two steps is exactly how far the body moved on screen — and
   * that, and not the velocity the other one had, is what the stride needs to know
   * for the foot to stay planted on the deck during stance. Sending the vector
   * would cost six bytes per sailor per snapshot to produce a foot that skates
   * whenever the network stutters.
   *
   * ## What counts as a teleport
   *
   * Taking the helm, mounting a cannon, grabbing the ladder and respawning move the
   * body meters in one step. Deriving velocity from that would give a pirate at a
   * sprint for one frame — and, worse, a jump detected in the middle. In those
   * cases the velocity is zeroed and the jump and ladder clocks are seated instead
   * of fed.
   *
   * @param pose this step's authoritative state.
   * @param ship the hull they are on — it is where the wheel angle comes from.
   */
  applyRemoteStep(dt: number, pose: RemoteCrewPose, ship: Ship): void {
    // The previous step's pose, before anything touches it: it is what `syncView`
    // interpolates from for the monitor's rate. Same opening as `fixedUpdate`, and
    // for the same reason.
    this.previousEyeLocal.copy(this.simEyeLocal);
    this.previousVisualLocal.copy(this.simVisualLocal);

    const stationChanged =
      pose.station !== this.station || pose.cannonIndex !== this.cannonIndex;
    const grabbedLadder = pose.onLadder && !this.onLadder;

    _remoteStep.subVectors(pose.local, this.local);
    const teleported =
      stationChanged ||
      grabbedLadder ||
      _remoteStep.lengthSq() > REMOTE_TELEPORT * REMOTE_TELEPORT;

    if (teleported) this.velocity.set(0, 0, 0);
    else this.velocity.copy(_remoteStep).divideScalar(dt);

    this.local.copy(pose.local);
    this.yaw = pose.yaw;
    this.pitch = pose.pitch;
    // Before writing the station: it is the **change** the body uses to take the
    // feet to the station with the same smoothing as the camera. See
    // `PlayerAvatar.updateStation`.
    if (stationChanged) this.stationChangeCount++;
    this.station = pose.station;
    this.cannonIndex = pose.cannonIndex;
    this.grounded = pose.grounded;
    this.onLadder = pose.onLadder;
    this.atCapstan = pose.atCapstan;
    this.inWater = pose.inWater;

    // On the ladder and at the stations the body is attached to something, and the
    // stride has to fade out — it is the same rule as `settleBob` and
    // `updateLadder`.
    const onFoot = this.station === 'deck' && !this.onLadder;
    // ⚠️ **In the water the velocity is measured in the world, not on the ship.**
    // Anywhere else the two are the same thing, because the body walks *on* the
    // hull; at sea they are not, because the hull goes away. An opponent floating
    // still has their local position running aft at the ship's speed — 2.6 m/s
    // running downwind — and feeding the stride with that number puts the castaway
    // **sprinting through the water**, with the run clip, without moving at all.
    //
    // The arithmetic is the sum the derivative requires: the local velocity rotated
    // into the world plus the hull's own. It ignores `ω × r`, and it can: the sloop
    // turns at most 0.4 rad/s, and a castaway ten meters from the center would gain
    // 0.3 m/s from that in the worst case — below the stride's movement threshold.
    const speed = onFoot ? this.remoteSpeed(this.inWater ? ship : null) : 0;
    // The stride keeps the deck and the water keeps the sea, and the same derived
    // velocity serves both — what changes is which of them receives it. Feeding
    // both would have the opponent swimming with a walker's legs, which is the
    // mirror image of the defect `updateBob` avoids on the simulating side.
    this.gait.update(dt, this.inWater ? 0 : speed, onFoot ? this.grounded : true);
    this.swim.update(dt, this.inWater, this.inWater ? speed : 0);

    // The ladder is indexed by **height gained**, as on the simulating side. The
    // alignment with the grid of rungs is done once, on grabbing, and from there on
    // it holds by itself — without it the other player's hand would float between
    // two ratlines for the rest of the climb.
    //
    // ⚠️ **And the grid is that of the ladder they are on**, which comes from the
    // position and not from the wire: the ship's two ladders have spacings that
    // differ in the fifth decimal (0.30333 against 0.30334), which over nine meters
    // of mast would give half a gap of error. See `boardingLadder`.
    if (grabbedLadder) {
      const spec = this.boardingLadder;
      if (spec) this.climb.align(this.local.y, spec.bottomY, spec.rungSpacing);
      else this.climb.align(this.local.y, MAST_LADDER.bottomY, MAST_LADDER.rungSpacing);
    }
    this.climb.update(dt, this.onLadder, this.onLadder && !teleported ? _remoteStep.y : 0);

    // The helm comes from the wheel's angle, which is authoritative and has already
    // been written on this step: the hand lands on top of a handle that is drawn
    // without anything needing to travel.
    this.helm.update(dt, this.station === 'helm', ship.rudder.wheelAngle);
    // And the plank, from the only bit this method needs the wire to carry:
    // whoever sees the breach and the held button is the `Interaction` on the other
    // side.
    this.carry.update(dt, pose.patching);

    if (onFoot && !teleported) this.jump.update(dt, this.velocity.y, this.grounded);
    // `settle` and not `update`: whoever was teleported behind the wheel did not
    // land from anywhere, and a landing fired there has the opponent crouching
    // while standing at the station. See `JumpClock.settle`.
    else this.jump.settle(dt);

    this.updateEye();
  }

  /**
   * Horizontal speed the remote sailor's clocks are fed with.
   *
   * @param ship the hull when the measurement has to be made **in the world** (only
   *   in the water), or `null` when the ship's frame is the right one — which is
   *   the case everywhere the body stands on it. See the note in `applyRemoteStep`.
   */
  private remoteSpeed(ship: Ship | null): number {
    if (!ship) return Math.hypot(this.velocity.x, this.velocity.z);
    ship.body.localDirToWorld(this.velocity, _world);
    _world.add(ship.body.velocity);
    return Math.hypot(_world.x, _world.z);
  }

  // -- on foot -----------------------------------------------------------------

  private updateOnFoot(dt: number, frame: InputFrame, ship: Ship, waves: WaveField): void {
    this.applyLook(frame);
    this.fov = damp(this.fov, this.baseFov, 10, dt);
    // Before anything touches the body: the previous step's remainder fades out on
    // its own, whether you walk, climb or push the capstan.
    this.decayStep(dt);

    _move.x = frame.moveX;
    _move.y = frame.moveY;
    const move = _move;

    if (this.onLadder) {
      this.updateLadder(dt, frame, move.y, ship, waves);
      return;
    }

    // The water comes before the capstan and after the ladder, and the order is
    // that of the exclusions: whoever is hanging from a rung is not in the sea (the
    // ladder is what takes you out of the sea), and whoever is in the sea has no
    // capstan bar within reach.
    if (this.inWater) {
      this.updateSwim(dt, frame, move, ship, waves);
      return;
    }

    if (this.pushCapstan(dt, frame, move, ship)) return;

    const speed = held(frame, InputBit.Sprint) ? RUN_SPEED : WALK_SPEED;
    const sin = Math.sin(this.yaw);
    const cos = Math.cos(this.yaw);
    // Local forward = Ry(yaw)·(0,0,-1); right = Ry(yaw)·(1,0,0).
    _moveDir.set(-sin * move.y + cos * move.x, 0, -cos * move.y - sin * move.x);
    if (_moveDir.lengthSq() > 1) _moveDir.normalize();

    const control = this.grounded ? GROUND_CONTROL : AIR_CONTROL;
    this.velocity.x = damp(this.velocity.x, _moveDir.x * speed, control, dt);
    this.velocity.z = damp(this.velocity.z, _moveDir.z * speed, control, dt);

    if (this.grounded && pressed(frame, InputBit.Jump)) {
      this.velocity.y = JUMP_SPEED;
      this.grounded = false;
    }

    if (!this.grounded) {
      // Gravity belongs to the world; in the ship's frame it leaves the vertical by
      // as much as the hull is heeled.
      _gravity.set(0, -GRAVITY, 0);
      ship.body.worldDirToLocal(_gravity, _gravity);
      this.velocity.addScaledVector(_gravity, dt);
    }

    this.local.addScaledVector(this.velocity, dt);

    this.resolveHull();
    this.resolveBlockers();
    this.resolveGround();
    this.resolveCeiling();
    // After the solvers, and it is mandatory: they are what decide whether this
    // step ended with the body outboard of the planking, and that is the only
    // situation in which the sea's surface has anything to say. See
    // `checkWaterEntry`.
    this.checkWaterEntry(ship, waves);
    this.updateBob(dt);
  }

  // -- the water ---------------------------------------------------------------

  /**
   * Detects crossing the sea's surface, outboard of the hull.
   *
   * ⚠️ **The `overboard` guard is not caution — without it the hold becomes the
   * sea.** The hold's floor is at −0.55 on the ship and the ship has draft: in world
   * coordinates that floor is **below** the waterline. A little hop in the hold
   * would cross the ocean's surface without anybody having left the ship, and the
   * player would find themselves swimming inside their own hull. The hold's water is
   * another thing entirely (it is `ShipDamage`), and it never comes through here.
   *
   * The entry speed is saved for the splash. It is the **vertical** one, and not the
   * magnitude: what raises a column of water is the body piercing the surface, and a
   * shallow dive at five meters per second horizontally is a glide, not a fall.
   */
  private checkWaterEntry(ship: Ship, waves: WaveField): void {
    if (this.inWater || this.onLadder || !this.overboard) return;

    ship.body.localToWorld(this.local, _world);
    const surface = waves.sampleHeight(_world.x, _world.z);
    if (_world.y > surface) return;

    this.splashAt.set(_world.x, surface, _world.z);
    this.splashSpeed = Math.max(-this.velocity.y, 0);
    this.enterWater(_world, surface);
  }

  /**
   * Moves the body into the world frame and switches the swimming state on.
   *
   * `grounded` stays **true**, and that is on purpose: the bit does not mean "there
   * is deck under the foot", it means "the body has support" — and the sea
   * supports. It is what keeps the air clip from sticking to the character for the
   * rest of the swim and what avoids a landing fired on leaving the water. The same
   * reading `JumpClock.settle` makes for the ladder, resolved one level up.
   *
   * @param world position of the feet in the world, at the instant of entry.
   * @param surface height of the water there, in world space.
   */
  private enterWater(world: THREE.Vector3, surface: number): void {
    this.inWater = true;
    this.waterTime = 0;
    this.grounded = true;
    this.onLadder = false;
    this.atCapstan = false;
    this.stepOffset = 0;
    // Both of them: the one the ship reads and the one the sea integrates. The fall
    // does not become swimming impulse — whoever enters the water enters at rest,
    // and the first stroke is theirs.
    this.velocity.set(0, 0, 0);
    this.worldVelocity.set(0, 0, 0);
    // ⚠️ **The splash is not a landing.** `grounded` has just become true, and
    // without this line the jump's clock reads the next frame as contact with the
    // deck: the `airborne` left over from the fall fires `JumpLand` with the fall's
    // force, and the pirate spends half a second crouching inside the sea. Worse,
    // that crouch's weight **adds** to the water's and blows past the total of 1 —
    // exactly the sum `PlayerAvatar.poseBudget` exists to keep closed.
    //
    // `reset` and not `settle`: there is no `dt` here to damp with, and it would
    // not be missed. The air clip being cut is the fall's last pose, and it is
    // being replaced on the same frame by the float — erasing it at once is the
    // same dry gesture `JumpClock` already makes on the air→landing change, and for
    // the same reason.
    this.jump.reset();
    // The body surfaces in an already-settled float pose, and not at the point of
    // impact: what you see is the head coming out of the water, and falling two and
    // a half meters only to then rise 1.44 m with damping would be the body
    // bouncing off the surface.
    this.worldFeet.set(world.x, surface - SWIM_SUBMERSION, world.z);
  }

  /**
   * Returns the body to the ship's frame. Called by whoever takes the sailor out of
   * the water — the boarding ladder, the rescue, the respawn.
   */
  private leaveWater(): void {
    this.inWater = false;
    this.waterTime = 0;
  }

  /**
   * Swimming and floating on the surface.
   *
   * ## What gets written, and in which frame
   *
   * The real position is the **world** one (`worldFeet`): it is what receives the
   * displacement, and `local` is rewritten from it at the end of the step. That is
   * what makes the ship go away without taking the swimmer along — see the file's
   * header, and the ±128 m ceiling the quantization imposes.
   *
   * ## The vertical is not physics, it is a constraint
   *
   * The body is **tied** to the wave's height with damping, and the vertical
   * velocity stays at zero. There is no gravity, no integrated buoyancy and no
   * jump: a damper that only approaches its target never overshoots it, so **there
   * is no diving by construction** — there is no separate clamp saying "do not
   * sink", there is an equation with no way to sink. See `SWIM_BOB_LAMBDA` for why
   * that number.
   *
   * ## And the head has to stay still in the world
   *
   * `yaw` is measured in the hull's frame (the camera composes with its matrix),
   * which on deck is exactly what we want and in the water is the opposite: a ship
   * yawing 30° would drag the view of whoever is floating 30° along with it,
   * without anyone having touched the mouse. Deducting the hull's yaw from the
   * head's heading gives back a gaze that stays where it was left. It is the same
   * gesture as `followCapstan`, in reverse: there the body turns and the head
   * follows, here the world turns and the head refuses.
   *
   * ⚠️ Only on the **delta** path. When the gaze arrives absolute (every frame that
   * came over the network), it is already the angle the other side computed *with*
   * the compensation inside it — deducting again would turn the opponent's head
   * twice for every yaw.
   */
  private updateSwim(
    dt: number,
    frame: InputFrame,
    move: { x: number; y: number },
    ship: Ship,
    waves: WaveField,
  ): void {
    this.waterTime += dt;

    if (!frame.absoluteView) {
      this.yaw -= wrapAngle(ship.heading - this.shipHeading);
    }

    // The swimming heading is the gaze's, **in the world**: the body goes where the
    // head points, and the head has already had the hull's yaw deducted. Adding the
    // ship's heading brings the local angle back into the world.
    const heading = this.yaw + this.shipHeading;
    const sin = Math.sin(heading);
    const cos = Math.cos(heading);
    _moveDir.set(-sin * move.y + cos * move.x, 0, -cos * move.y - sin * move.x);
    if (_moveDir.lengthSq() > 1) _moveDir.normalize();

    // ⚠️ **The swimming velocity is integrated in the world, and not on the ship.**
    // It is the same reason as the position: the water does not turn with the hull,
    // and a damper whose target rotates with the bow would make the castaway
    // describe a curve every time the ship yawed. No `Sprint`: see `SWIM_SPEED`.
    // And the damping is the air's, not the ground's — water gives no traction to
    // change direction in one frame, and `AIR_CONTROL` is already this file's
    // constant for "the body takes a while to obey".
    this.worldVelocity.x = damp(this.worldVelocity.x, _moveDir.x * SWIM_SPEED, AIR_CONTROL, dt);
    this.worldVelocity.z = damp(this.worldVelocity.z, _moveDir.z * SWIM_SPEED, AIR_CONTROL, dt);
    this.worldVelocity.y = 0;

    this.worldFeet.x += this.worldVelocity.x * dt;
    this.worldFeet.z += this.worldVelocity.z * dt;

    const surface = waves.sampleHeight(this.worldFeet.x, this.worldFeet.z);
    this.worldFeet.y = damp(this.worldFeet.y, surface - SWIM_SUBMERSION, SWIM_BOB_LAMBDA, dt);

    // And `local` becomes whatever the world position says it is. From here on
    // camera, body, interpolation and snapshot read the usual thing — including the
    // **velocity**, which goes back to being the ship frame's as in all the rest of
    // the file. Without this return trip, the body's heading (`PlayerAvatar`) would
    // read a world vector as if it were local, and the castaway would show up
    // swimming sideways whenever the hull was not pointing north.
    ship.body.worldToLocal(this.worldFeet, this.local);
    ship.body.worldDirToLocal(this.worldVelocity, this.velocity);
    this.pushOutOfHull(ship);
    this.grounded = true;

    const speed = Math.hypot(this.velocity.x, this.velocity.z);
    this.swim.update(dt, true, speed);
    // And the stride does **not** receive this velocity: what draws the water are
    // `Float` and `Swim`, and feeding the `GaitClock` here would put the walk clip's
    // legs underneath the stroke, splitting the body between two gestures. The one
    // handling that guard is `updateBob` itself. The cadence did not change in the
    // handover — the water's phase measures the same distance the stride's measured
    // (see `SWIM_DISTANCE`).
    this.updateBob(dt);
  }

  /**
   * Pushing the capstan bars: the player walks **around** it.
   *
   * This is the half of anchoring that costs. Dropping the anchor is one tap;
   * weighing it means taking the capstan and walking around it, turn after turn,
   * exactly as in Sea of Thieves. The capstan turns by the angle the sailor covered
   * — there is no fixed rate, no bar filling on its own, and stopping walking is
   * stopping hauling.
   *
   * The conversion is direct: the angle swept around the axis **is** the angle the
   * bar turned. No conversion factor, no tuning constant.
   *
   * What switches the mode on and off is the interactable (`press`), which runs
   * **after** the player in the frame — that is what keeps the same tap from
   * entering and leaving. What lives here is only the exits that are not a tap:
   * letting go of the part, falling into the hold, moving away from the bars and
   * reaching the end of the job.
   *
   * @returns `true` when it has taken over this frame's movement.
   */
  private pushCapstan(
    dt: number,
    frame: InputFrame,
    move: { x: number; y: number },
    ship: Ship,
  ): boolean {
    if (!this.atCapstan) return false;

    // Leaving by the back door: `X`/`B` and the jump let go of the bars the way
    // they let go of any other part, and the anchor home (or running back to the
    // bottom) ends the job on its own — there is nothing to push in either case.
    if (
      pressed(frame, InputBit.Exit) ||
      pressed(frame, InputBit.Jump) ||
      this.inHold ||
      ship.anchor.state === 'stowed' ||
      ship.anchor.state === 'dropping'
    ) {
      this.leaveCapstan();
      return false;
    }

    const dx = this.local.x - CAPSTAN_STAND.x;
    const dz = this.local.z - CAPSTAN_STAND.z;
    const distance = Math.hypot(dx, dz);
    if (distance > CAPSTAN_REACH) {
      this.leaveCapstan();
      return false;
    }

    // It stays on the circumference of the bars, but **walking** to it instead of
    // jumping: whoever pressed the button two meters from the axis approaches the
    // bar like somebody approaching, not like somebody being teleported.
    const angle = Math.atan2(dx, dz);
    const radius = damp(distance, CAPSTAN_RADIUS, 7, dt);

    // **Walking forward is going around, and only walking forward.** The player
    // does not have to turn the mouse to follow the bar: it is the bar that
    // describes the circle, and their body goes after it. Projecting the gaze's
    // direction onto the tangent seemed more honest and was unplayable — a quarter
    // turn in, the gaze is perpendicular to the path, the projection goes to zero
    // and the sailor locks up with the anchor halfway up.
    //
    // Only the forward component counts, and that is the difference that makes the
    // gesture a gesture: with the stick's magnitude, pushing the capstan was
    // pointing the stick in any direction at all — sideways, backwards, diagonally,
    // it made no difference. A capstan bar is pushed with the chest, in the
    // direction the body is going, and that is what the player does now.
    //
    // And the direction is always the hauling one, because the capstan has a pawl:
    // pushing the bar the other way does not let the cable back out. There is
    // nothing to decide here, so the player is not asked for a decision.
    const effort = clamp(move.y, 0, 1);
    const swept = (effort * CAPSTAN_WALK_SPEED * dt) / Math.max(radius, 0.2);
    const next = angle + swept;

    this.local.x = CAPSTAN_STAND.x + Math.sin(next) * radius;
    this.local.z = CAPSTAN_STAND.z + Math.cos(next) * radius;
    this.local.y = this.surfaceAt(this.local.x, this.local.z, this.local.y);
    this.grounded = true;

    // **The real tangential velocity, and not zero.** What writes the position here
    // is the orbit, so this vector moves nobody — but it is where the stride's clock
    // and the body's heading (`PlayerAvatar`) come from, and with zero the pirate
    // went around the whole circle in an idle pose, sliding sideways like a
    // board-game piece. The tangent is the derivative of the position on the circle:
    // (cos, −sin).
    const pace = effort * CAPSTAN_WALK_SPEED;
    this.velocity.set(Math.cos(next) * pace, 0, -Math.sin(next) * pace);

    this.followCapstan(dt, next, swept, effort);

    // The command goes straight to the ship, and **not** through the interactable.
    //
    // Going through `Interaction` would require the capstan to be in focus, and it
    // stops being so as soon as the sailor makes the first quarter turn — the bar
    // leaves the view cone because their body is the one turning. The result was
    // walking in a circle without hauling anything. Whoever knows they are pushing
    // is whoever is pushing.
    this.capstanTurns = swept / TAU;
    ship.controls.capstanTurns += this.capstanTurns;
    this.updateBob(dt);
    return true;
  }

  /**
   * The head follows the turn around the capstan.
   *
   * Without this, the body described the circle and the gaze stayed where the
   * player had left it: you could weigh the whole anchor **with your back to the
   * part**, or looking at the sky, and what you saw on screen was the deck turning
   * on its own with no explanation. Pushing a bar is a whole-body gesture —
   * whoever pushes looks where the bar is going.
   *
   * Guided, and not locked. The player can still turn their head to see where the
   * enemy is while working — their aim only comes back to the bar on its own when
   * they let go of the mouse, and it comes back more firmly the faster they walk.
   * Locking it outright would take away the one thing you can still do with your
   * hands busy: look around.
   *
   * @param angle the sailor's angular position around the axis, already advanced.
   * @param swept how far the body turned around the axis this frame, in radians.
   * @param effort how much of the walking range is being asked for, 0 to 1.
   */
  private followCapstan(dt: number, angle: number, swept: number, effort: number): void {
    // **The head turns with the body, degree for degree.**
    //
    // Without this term the following becomes chasing, and chasing by damping has a
    // permanent error: the turn runs at ~1.7 rad/s and no playable λ closes that
    // gap, so the bar sat a fifth of a radian off the center of the screen the whole
    // time. With the body's rotation added straight into the heading, the damping
    // below only has to correct what is left — which is the offset the **player**
    // asked for with the mouse, and not the one the circle imposed.
    this.yaw += swept;

    // The circle's tangent, in the direction of the turn. `angle` is measured from
    // +Z toward +X (`atan2(dx, dz)`), so the position is (sin, cos) and the tangent
    // comes from the derivative: (cos, −sin).
    //
    // The `yaw` heading looks at (−sin yaw, −cos yaw) — the same convention as the
    // movement and the eye's matrix — and matching the two gives `atan2(−cos, sin)`.
    // There was a flipped sign here: the target was the **mirror** of the right
    // heading and counter-rotated, agreeing with the correct one at only two points
    // of the turn. That, and not the damping, was what made the view spin freely
    // around the part while the body went around.
    const heading = Math.atan2(-Math.cos(angle), Math.sin(angle));

    // Always by the short path, otherwise going round the wrong way gives a turn of
    // nearly 360° every time the stride crosses the stern.
    let delta = (heading - this.yaw) % TAU;
    if (delta > Math.PI) delta -= TAU;
    if (delta < -Math.PI) delta += TAU;

    // Guided, and not locked: the player still turns their head to find the enemy
    // while working, and the aim comes back to the bar on its own when they let go
    // of the mouse — more firmly the faster they walk.
    const lambda = CAPSTAN_LOOK_LAMBDA + CAPSTAN_LOOK_LAMBDA_PER_EFFORT * effort;
    this.yaw = damp(this.yaw, this.yaw + delta, lambda, dt);
    // And the chin drops toward the bars: it is where the hands are.
    this.pitch = damp(this.pitch, CAPSTAN_PITCH, lambda * 0.7, dt);
  }

  /**
   * Goes up and down **a** ladder. Forward climbs, back descends.
   *
   * It is called `updateLadder` and not `climb` because `climb` is now the climb's
   * **clock**, next to `gait` and `jump`.
   *
   * ## Two ladders, one step
   *
   * It used to be hardcoded to `MAST_LADDER`, and generalizing instead of
   * duplicating is not taste: what makes the hand land on the rung is the marriage
   * between the clip's phase and the ladder's **grid** (see `ClimbClock.align`), and
   * a second copy of this method would be a second chance for that marriage to
   * diverge. What differs between the two ladders is little and isolated in three
   * places — the line the body follows, the exit at the top and the exit at the
   * bottom. The rest is identical by construction.
   *
   * Which ladder is the current one comes from `boardingLadder`, meaning **from the
   * position**. See there for why there is neither a field nor a network bit for it.
   */
  private updateLadder(
    dt: number,
    frame: InputFrame,
    forward: number,
    ship: Ship,
    waves: WaveField,
  ): void {
    // Lets go halfway — from there on it is a fall.
    //
    // The interaction button lets go of the ladder just as much as the exit one
    // does: it is what grabs, and a command that holds without releasing leaves the
    // player hunting for the right key hanging nine meters above the deck. The
    // pressed edge is what keeps the same tap that grabbed from letting go — by the
    // time this code runs, that frame has passed (the interaction focus runs *after*
    // the player).
    if (
      pressed(frame, InputBit.Jump) ||
      pressed(frame, InputBit.Exit) ||
      pressed(frame, InputBit.Interact)
    ) {
      this.releaseLadder(ship, waves);
      return;
    }

    // On the ladder `grounded` is false, but nobody is flying: feeding the clock
    // with that false would leave the air clip stuck to the character for the whole
    // climb, and the landing would fire on reaching the nest.
    this.jump.settle(dt);
    // The stride has to fade out too: without this the body blends walking with
    // climbing for as long as the player holds the movement key.
    this.gait.update(dt, 0, true);
    // ⚠️ **And the water, which is the only ladder that arrives wet.** The one on
    // the ship's side takes the sailor out of the sea, and this is the only path by
    // which they leave it swimming: neither of the two clock settlers (`updateBob`,
    // `settleBob`) runs while climbing, so without this line the water's weight
    // stayed pinned at 1 for the whole climb. With `Float`/`Swim` in the GLB that is
    // the float adding to the climb and blowing past the total of 1 — and before
    // them it was invisible, because the water drew nothing. The ladder and the sea
    // fade out with the same λ, so the sum of the two crosses the handover worth
    // exactly one body.
    this.swim.update(dt, false, 0);

    const rise = forward * CLIMB_SPEED * dt;
    this.local.y += rise;
    // The ladder's clock advances with **height**, not with time — it is what pins
    // the hand to the rung at any speed and what makes descending the same gesture
    // in reverse, with no separate clip.
    this.climb.update(dt, true, rise);
    this.velocity.set(0, 0, 0);
    this.grounded = false;

    const boarding = this.boardingLadder;
    if (boarding) {
      this.followBoardingLadder(dt, boarding, ship, waves);
      return;
    }

    // Centers between the stiles: climbing crooked reads as a bug.
    this.local.x = damp(this.local.x, 0, 10, dt);
    this.local.z = damp(this.local.z, MAST_LADDER.z + LADDER_STANDOFF, 10, dt);

    // Reached the nest: comes in through the gap and becomes a standing person
    // again.
    //
    // It exits **forward** of the mast, and not stuck to the ladder: whoever has
    // just climbed needs half a meter of nest between them and the gap they came
    // through, or the first step throws them back down the hole.
    if (this.local.y >= CROW_NEST.y) {
      this.onLadder = false;
      this.local.y = CROW_NEST.y;
      this.local.z = CROW_NEST.z - 0.5;
      this.grounded = true;
      return;
    }

    if (this.local.y <= MAST_LADDER.bottomY) {
      this.onLadder = false;
      this.local.y = this.surfaceAt(this.local.x, this.local.z, MAST_LADDER.bottomY + 0.3);
      this.grounded = true;
    }
  }

  /**
   * The planking pushing away whoever is against it, from outside.
   *
   * ⚠️ **Without this the swimmer goes through the hull.** `resolveHull` is
   * switched off in the water on purpose (it *carries* the body along with the
   * ship, which is exactly what we do not want), and what was left was a sailor who
   * swims into the planking and ends up submerged inside the hold, seeing the world
   * from inside the wood.
   *
   * The difference between this push and that clamp is everything: that one writes
   * the body's position on every frame, this one only resolves the **penetration** —
   * when the body is outside, it does nothing, and the ship goes away without taking
   * anybody. What is left goes on living in `worldFeet`, and that is why the world
   * position is rewritten at the end: without that return trip, the push would be
   * undone on the next step by the world-to-local conversion.
   *
   * The width is measured **at the waterline** and not at the feet's height, and it
   * is the right choice for two reasons: that is where the swimmer's torso is (the
   * feet are 1.44 m below, where the hull has already narrowed toward the keel), and
   * it is the widest section they can encounter — which makes the push always err on
   * the safe side.
   */
  private pushOutOfHull(ship: Ship): void {
    const half = halfWidthAtHeight(zToT(this.local.z), 0) + PLAYER_RADIUS;
    const distance = Math.abs(this.local.x);
    if (distance >= half) return;

    // Right on the centerline (underneath the keel) it picks a side instead of
    // dividing by zero — it is the same escape as `pushOutOf`.
    this.local.x = distance > 1e-4 ? Math.sign(this.local.x) * half : half;
    ship.body.localToWorld(this.local, this.worldFeet);

    // The component going into the hull dies; the one sliding along it stays. It is
    // what makes swimming around the stern feel like going around, and not like
    // getting stuck. The return trip to the world is mandatory: it is
    // `worldVelocity` that integrates the position, and killing only the local copy
    // would leave the body pushing against the wood forever.
    const outward = Math.sign(this.local.x);
    if (this.velocity.x * outward >= 0) return;
    this.velocity.x = 0;
    ship.body.localDirToWorld(this.velocity, this.worldVelocity);
  }

  /**
   * Lets go of the ladder halfway — from there on it is a fall.
   *
   * On the mast ladder that is just releasing your hands. On a boarding ladder,
   * letting go is **falling into the sea**, because outboard of the planking there
   * is no deck — and its foot takes one extra care: `boardingLadderStandX` comes
   * back inside the deck-edge ruler below y ≈ −0.21 (the body sits at 1.64 against
   * 1.76), so there `checkWaterEntry` would not recognize the body as being outside
   * the ship and `resolveGround` would plant it on the hold's floor. Below that
   * height the ladder is submerged anyway, so what is under the body is sea and it
   * is handed straight to the water. Higher up, the fall runs normally and the
   * surface catches it.
   */
  private releaseLadder(ship: Ship, waves: WaveField): void {
    // Read **before** switching `onLadder` off: it is what the getter depends on.
    const boarding = this.boardingLadder;
    this.onLadder = false;
    this.grounded = false;
    if (!boarding || this.overboard) return;
    ship.body.localToWorld(this.local, _world);
    this.enterWater(_world, waves.sampleHeight(_world.x, _world.z));
  }

  /**
   * The body following a boarding ladder's raked line, with both of its exits.
   *
   * The body chases `boardingLadderStandX` at the height it is at — the line
   * measured **perpendicular** to the plane of the rungs, and not horizontally. The
   * tilt the body takes on to match that line is `ladderTilt`, and what draws it is
   * `PlayerAvatar`; see there and in `ladderTilt` what happens without it.
   *
   * The two ends are the opposite of each other, and that is what the part is: at
   * the top it ends **standing on the quarterdeck**, at the bottom it ends **in the
   * sea**. The deepest rung is submerged on purpose (`BOARDING_RUNG_COUNT`), so
   * going down to it means entering the water — and handing the body to the water
   * here, instead of dropping it into a fall, is mandatory: at the foot of the
   * ladder the body is still 12 cm **inside** the deck's edge (1.64 against 1.76),
   * so `checkWaterEntry` would not recognize it as being outside the ship and
   * `resolveGround` would plant it on the hold's floor.
   */
  private followBoardingLadder(
    dt: number,
    spec: BoardingLadderSpec,
    ship: Ship,
    waves: WaveField,
  ): void {
    // Exit at the top: **standing on the gangway's sill**, which is the floor the
    // top rung meets. It is not the deck inside, and the difference matters:
    // between the top rung and the deck's edge there are 28 cm of platform (the
    // ladder ended up 18 cm outboard so its wood would not go through the
    // narrowing stern), and teleporting the body over it would skip exactly the
    // step the part exists to give. Whoever climbs steps on the plank and then
    // comes in.
    //
    // The body sits one radius inboard of the sill's edge, which is the furthest
    // out it fits without the cylinder passing the plank — and it is still
    // `spec.exitY` because the sill is flush with the quarterdeck. See
    // `gangwaySurface`.
    if (this.local.y >= spec.topY) {
      this.onLadder = false;
      this.local.y = spec.exitY;
      this.local.z = spec.z;
      this.local.x = spec.side * Math.max(gangwaySillX(spec) - PLAYER_RADIUS, 0);
      this.grounded = true;
      this.velocity.set(0, 0, 0);
      return;
    }

    this.local.x = damp(
      this.local.x,
      spec.side * boardingLadderStandX(spec, this.local.y),
      10,
      dt,
    );
    this.local.z = damp(this.local.z, spec.z, 10, dt);

    // Exit at the bottom: past the last rung, in the sea.
    if (this.local.y > spec.bottomY) return;
    this.local.y = spec.bottomY;
    ship.body.localToWorld(this.local, _world);
    this.enterWater(_world, waves.sampleHeight(_world.x, _world.z));
  }

  // -- stations ----------------------------------------------------------------

  private updateHelm(dt: number, frame: InputFrame, ship: Ship): void {
    this.applyLook(frame);
    this.fov = damp(this.fov, this.baseFov, 10, dt);

    // A/D (or the stick) turn the wheel. No self-centering, as in the game: the
    // wheel stays where it was left and the rudder with it.
    ship.controls.wheel = frame.moveX;

    // And the body reads the wheel back. The helm's clock is indexed by **its
    // angle**, as the ladder's is by height gained: 45° of wheel is one handle, and
    // the hand changes handle at the angle the next handle arrives under it.
    // Turning to port is the same cycle with the phase running backwards, and that
    // falls out of the arithmetic for free — there is no direction of turn to
    // handle here.
    this.helm.update(dt, true, ship.rudder.wheelAngle);

    this.local.copy(HELM_STAND);
    this.velocity.set(0, 0, 0);
    this.settleBob(dt);
  }

  private updateCannon(dt: number, frame: InputFrame, ship: Ship): void {
    const cannon = ship.cannons[this.cannonIndex];
    if (!cannon) {
      this.leaveStation();
      return;
    }

    // The gaze does not turn the head: it turns the gun. The deltas already come in
    // radians, which makes the cannon's sensitivity the same as aiming on foot.
    cannon.aim(-frame.lookX, -frame.lookY);

    if (pressed(frame, InputBit.Reload)) ship.loadCannon(this.cannonIndex);
    if (pressed(frame, InputBit.Fire)) cannon.triggerPull();

    const aiming = held(frame, InputBit.Aim);
    const target = aiming ? this.baseFov * AIM_FOV_RATIO : this.baseFov;
    this.fov = damp(this.fov, target, 9, dt);

    // The player stands beside the breech; it is the camera that goes behind the
    // barrel. Keeping the feet in the right place matters for damage by region
    // later on.
    this.local.copy(this.stationReturn);
    this.velocity.set(0, 0, 0);
    this.settleBob(dt);
  }

  // -- collision and floor -----------------------------------------------------

  /**
   * Height of the floor under a point.
   *
   * The hatch opening is the only discontinuity: inside it there is no deck, and
   * that is why you fall into the hold when passing over it with the cover open.
   */
  private surfaceAt(x: number, z: number, feetY: number): number {
    // The crow's nest is the only platform above the deck, and it takes priority
    // over everything: whoever is up there is nine meters from any other floor.
    const nest = this.crowNestSurface(x, z, feetY);
    if (nest !== null) return nest;

    // The gangway's sill is the ship's second platform, and the only one outboard
    // of the planking. It comes before the next line because it is precisely the
    // exception to it.
    const sill = gangwaySurface(x, z);
    if (sill !== null) return sill;

    // ⚠️ **Outside the planking there is no floor at all, and that is what makes
    // the gangway a door.** Before this line `surfaceAt` never returned "no floor":
    // the deck was valid for any x, and the only reason nobody fell off the ship was
    // `resolveHull` clamping the body inside the hull on every frame. Opening the
    // gap in the bulwark without opening this exception, the player would walk over
    // the sea.
    //
    // `-Infinity`, and not a low number: `resolveGround` compares with a tolerance,
    // and any finite floor would be an invisible floor at some height above the
    // water.
    if (outsideHull(x, z)) return NO_FLOOR;

    const t = zToT(z);
    const deck = walkableY(t) + deckCamber(x, deckHalfWidth(t));

    if (!isOverHatch(x, z)) {
      // Being more than one step below the deck means being in the hold, and then
      // the deck becomes a ceiling instead of a floor.
      return feetY >= deck - STEP_HEIGHT ? deck : HOLD_FLOOR_Y;
    }

    // Inside the hatch opening: the floor is the flight's step where it exists, and
    // the hold's floor over the rest of the hole. This is what makes going below an
    // act of walking — no key, no mode, no state.
    return stairSurfaceY(x, z) ?? HOLD_FLOOR_Y;
  }

  /** Height of the crow's nest floor under (x, z), or `null` outside it. */
  private crowNestSurface(x: number, z: number, feetY: number): number | null {
    if (feetY < CROW_NEST.y - STEP_HEIGHT) return null;
    const dx = x - 0;
    const dz = z - CROW_NEST.z;
    return dx * dx + dz * dz <= CROW_NEST.radius * CROW_NEST.radius ? CROW_NEST.y : null;
  }

  private resolveGround(): void {
    const surface = this.surfaceAt(this.local.x, this.local.z, this.local.y);
    const tolerance = this.grounded ? STEP_HEIGHT : 0.02;

    if (this.velocity.y <= 0 && this.local.y <= surface + tolerance) {
      // The step the foot has just cleared becomes the view's debt, not a jump.
      //
      // It only applies to whoever **was already** on the ground: falling from a
      // height and cushioning the landing with the same arithmetic would give that
      // floaty landing of a game with a badly attached camera. Whoever falls,
      // falls; whoever walks, walks smoothly.
      if (this.grounded) this.absorbStep(surface - this.local.y);

      this.local.y = surface;
      this.velocity.y = 0;
      this.grounded = true;
      return;
    }

    this.grounded = false;
  }

  /**
   * Saves a step for the view to catch up with, instead of teleporting the head.
   *
   * The clamp at `STEP_HEIGHT` is what separates a step from a fall: nothing above
   * half a meter is climbed on foot, and smoothing more than that would hide from
   * the player that they fell off something.
   */
  private absorbStep(rise: number): void {
    if (Math.abs(rise) < 1e-4) return;
    this.stepOffset = clamp(this.stepOffset + rise, -STEP_HEIGHT, STEP_HEIGHT);
  }

  /**
   * Saves a network correction for the view to catch up with, instead of jumping
   * with it.
   *
   * Called by the reconciliation **before** the position is corrected: the offset is
   * the difference that is about to stop existing in the simulation and start
   * existing only in the render. It vanishes on its own in ~200 ms (see
   * `OFFSET_LAMBDA`).
   *
   * The clamp is what separates prediction from disagreement — see `OFFSET_LIMIT`
   * for the motion-sickness arithmetic that defines it, and `absorbStep`, which does
   * the same with steps.
   *
   * @param delta the difference, in the ship's local coordinates.
   */
  absorbViewOffset(delta: THREE.Vector3): void {
    this.viewOffset.add(delta);
    if (this.viewOffset.lengthSq() > OFFSET_LIMIT * OFFSET_LIMIT) {
      this.viewOffset.setLength(OFFSET_LIMIT);
    }
  }

  /**
   * Fades the view's offset out. Runs on the **frame**, with the real `dt` — the
   * smoothing is a render matter, so it has to run at the monitor's rate and not at
   * the fixed step's.
   */
  decayViewOffset(dt: number): void {
    this.viewOffset.multiplyScalar(Math.exp(-OFFSET_LAMBDA * dt));
  }

  private decayStep(dt: number): void {
    const magnitude = Math.abs(this.stepOffset);
    if (magnitude < 1e-4) {
      this.stepOffset = 0;
      return;
    }

    const speed = Math.hypot(this.velocity.x, this.velocity.z);
    const ceiling = STEP_SMOOTH_BASE_RATE + STEP_SMOOTH_RATE_PER_SPEED * speed;
    // Exponential at the end of the movement, where it is good: it is what takes
    // the corner off "stopped all of a sudden" when the debt gets near zero.
    const rate = Math.min(magnitude * STEP_SMOOTH_LAMBDA, ceiling);
    const move = Math.min(rate * dt, magnitude);
    this.stepOffset -= Math.sign(this.stepOffset) * move;
  }

  /**
   * The deck as a ceiling, for whoever is in the hold.
   *
   * It exists because the deck gained an underside: without this stop, a jump in the
   * hold took the camera into the wood and, from there, through to the other side —
   * and the world seen from inside a back face is the void. Under the hatch there is
   * no ceiling at all, which is where you climb up.
   */
  private resolveCeiling(): void {
    // Outside the planking there is no ceiling, and the guard is mandatory: whoever
    // falls through the gangway crosses the hold's height on the way to the water,
    // and without it the deck — which there is *beside* the body, not above it —
    // would fish the player out mid-fall.
    if (this.overboard || !this.inHold) return;

    const t = zToT(this.local.z);
    if (isOverHatch(this.local.x, this.local.z)) return;

    // The floor beats the ceiling when the two fight: the hold's headroom and the
    // eye's height are two centimeters apart, and if a future tweak inverts that
    // margin it is better for the head to graze than for the player to sink into
    // the floor and be pushed back on every frame.
    const limit = Math.max(ceilingY(t, this.local.x) - HEAD_CLEARANCE, HOLD_FLOOR_Y);
    if (this.local.y <= limit) return;

    this.local.y = limit;
    if (this.velocity.y > 0) this.velocity.y = 0;
  }

  /** Keeps the player inside the planking, on deck or in the hold. */
  private resolveHull(): void {
    // In the crow's nest the hull has nothing to say: the limit up there is the
    // basket's wall, and applying the deck's band nine meters up would drag the
    // player into the mast.
    if (this.onCrowNest()) {
      const dz = this.local.z - CROW_NEST.z;
      const distance = Math.hypot(this.local.x, dz);
      const limit = CROW_NEST.radius - PLAYER_RADIUS;
      if (distance > limit && distance > 1e-4) {
        const scale = limit / distance;
        this.local.x *= scale;
        this.local.z = CROW_NEST.z + dz * scale;
      }
      return;
    }

    // In the water the hull has nothing to say: the body is in the sea and `local`
    // is only the translation of its world position. Clamping here would drag the
    // swimmer back inside the ship on the first frame. See `updateSwim`.
    if (this.inWater) return;

    const hold = this.inHold;
    const range = hold ? this.holdRange : this.deckRange;
    this.local.z = clamp(this.local.z, range.min, range.max);

    const t = zToT(this.local.z);
    const half = hold
      ? halfWidthAtHeight(t, HOLD_FLOOR_Y + 0.5) - HULL_THICKNESS
      : deckHalfWidth(t);

    // ⚠️ **The gangway is this solver's exception, as the crow's nest is the whole
    // solver's exception.** Without one of the two, this method is geometrically
    // inescapable — it clamps x inside the planking on *every* frame, and that is
    // the only reason leaving the ship was impossible. The gap in the bulwark is the
    // only place the clamp does not apply, and its width is chosen so that nobody
    // falls out by accident: whoever goes through there meant to (see
    // `BOARDING_GANGWAY_HALF_WIDTH`).
    if (!hold && insideGangway(this.local.z)) return;
    // And whoever is already outside is not brought back by the planking. It is what
    // allows crossing the gangway diagonally: the body leaves through the opening,
    // Z keeps moving and leaves its band, and without this line the hull would
    // teleport it back onto the deck mid-fall.
    if (Math.abs(this.local.x) > half) return;

    const limit = Math.max(half - PLAYER_RADIUS, 0);
    this.local.x = clamp(this.local.x, -limit, limit);
  }

  /**
   * `true` when the player is standing in the crow's nest.
   *
   * Public because the ladder's prompt needs the **same** answer to choose between
   * "up" and "down". There used to be two thresholds for that question, 20 cm apart,
   * and two different heights for the same doubt is a divergence waiting for a new
   * step to show up in.
   */
  onCrowNest(): boolean {
    return this.local.y > CROW_NEST.y - STEP_HEIGHT;
  }

  private resolveBlockers(): void {
    // In the crow's nest the only obstacle is the mast, and it has a 13 cm radius up
    // there against the 34 at its foot. Reusing the deck's radius nine meters up
    // would take up the whole basket and the player would have nowhere to stand.
    if (this.onCrowNest()) {
      this.pushOutOf(0, CROW_NEST.z, CROW_NEST.mastRadius + 0.04);
      return;
    }

    // Outside the planking there is no obstacle: the deck's parts are all inboard,
    // and the cannon's collision cylinder reaches as much as 55 cm past the edge — a
    // body falling along the hull at the level of the bows would be pushed by a
    // cannon that is on the other side of the wood.
    if (this.overboard) return;

    const hold = this.inHold;

    for (const blocker of this.blockers) {
      if (hold && !blocker.throughHold) continue;
      this.pushOutOf(blocker.x, blocker.z, blocker.radius);
    }
  }

  /** Pushes the player out of a vertical cylinder at (x, z). */
  private pushOutOf(x: number, z: number, radius: number): void {
    const dx = this.local.x - x;
    const dz = this.local.z - z;
    const distance = Math.hypot(dx, dz);
    const minimum = radius + PLAYER_RADIUS;
    if (distance >= minimum) return;

    // Pushes outward along the normal. Right on the axis (distance ~0) it picks any
    // direction instead of dividing by zero.
    const nx = distance > 1e-4 ? dx / distance : 1;
    const nz = distance > 1e-4 ? dz / distance : 0;
    this.local.x = x + nx * minimum;
    this.local.z = z + nz * minimum;

    // It kills only the component going into the obstacle: sliding along the part is
    // what makes going around a cannon feel natural instead of getting stuck.
    const into = this.velocity.x * nx + this.velocity.z * nz;
    if (into < 0) {
      this.velocity.x -= into * nx;
      this.velocity.z -= into * nz;
    }
  }

  // -- the head ----------------------------------------------------------------

  /**
   * The head, from what the input frame brings.
   *
   * ## Two ways of saying the same thing, and why both exist
   *
   * **Locally**, the gaze is a *delta*: the mouse delivers displacement, not
   * position, and integrating is what gives the rotation. It is the usual path, and
   * it is the only one in the duel against the machine.
   *
   * **Over the network**, the gaze arrives *absolute*, and the difference is what
   * decides whether the other player can use the parts of their ship. Integrating
   * deltas from the other side, **one** lost packet is enough for the angle here to
   * stop being the angle over there — and the error never closes again, because
   * there is nothing to bring it back. What you see when that happens is not the
   * wrong head (nobody looks at the opponent's head with that precision): it is the
   * **interaction focus** diverging. The player on the other side points at the
   * cannon, presses the button, and here their sailor is looking three meters to the
   * side, has no focus at all and nothing happens. Measured in a duel: yaw 1.571 on
   * one side and −0.420 on the other, with the position agreeing to the second
   * decimal.
   *
   * Absolute, the angle is the same by construction, and a lost packet costs one
   * frame of smoothness instead of a permanent desynchronization.
   */
  private applyLook(frame: InputFrame): void {
    if (frame.absoluteView) {
      this.yaw = frame.yaw;
      this.pitch = clamp(frame.pitch, -PITCH_LIMIT, PITCH_LIMIT);
      return;
    }
    this.yaw -= frame.lookX;
    this.pitch = clamp(this.pitch - frame.lookY, -PITCH_LIMIT, PITCH_LIMIT);
  }

  /**
   * Settles the bob when the player is at a station.
   *
   * Zeroing `bobOffset` alone has not been enough since there has been a body: the
   * stride's clock would keep the value from the last frame of walking, and whoever
   * took the helm **while running** would leave the character frozen in a running
   * pose behind the wheel. Feeding the clock with zero velocity makes the locomotion
   * fade out on its own and lets the idle take over.
   */
  private settleBob(dt: number): void {
    this.gait.update(dt, 0, true);
    this.climb.update(dt, false, 0);
    // The helm is the exception among the stations, and the guard is mandatory:
    // whoever is at the wheel has already fed this clock with the wheel's angle, in
    // `updateHelm`, and a second `damp` on the same frame would pull the weight back
    // down. The two would balance out with half a helmsman on screen — and the other
    // half of the pose budget would go to the idle, hands in mid-air.
    if (this.station !== 'helm') this.helm.update(dt, false, 0);
    // At a station you are not in the sea — there is no way to take the helm while
    // floating (see `takeHelm`'s guard), so here the water can only fade out.
    this.swim.update(dt, false, 0);
    // `settle` and not `update`: whoever takes the helm mid-jump does not land, they
    // are teleported behind the wheel. A landing fired there would come out with the
    // character crouching while standing at the station.
    this.jump.settle(dt);
    this.bobOffset = damp(this.bobOffset, 0, 12, dt);
    // At a station the body is teleported to the part's pose, and a step remainder
    // left over there would read as a dip of the head on taking the helm.
    this.stepOffset = 0;
  }

  private updateBob(dt: number): void {
    // ⚠️ **In the water the stride receives zero, and not the swimming velocity.**
    // It drew the sea while `Float` and `Swim` did not exist; now that they do, a
    // live stride underneath them would give a body kicking its legs inside the
    // stroke — and the camera bob it feeds (2.1 cm per step) would become a jolt
    // nothing on the surface has to justify. With zero, the locomotion fades out on
    // its own and `bobOffset` falls to the lower branch, which is what lets the
    // swimmer's head rise and fall with the wave alone.
    const speed = this.inWater ? 0 : Math.hypot(this.velocity.x, this.velocity.z);
    this.gait.update(dt, speed, this.grounded);
    // Off the ladder the climb clip fades out on its own. The **phase** stays where
    // it stopped on purpose: whoever lets go of the ladder and grabs it again two
    // meters up does not restart the cycle from zero — `align` finds the rung again
    // from it.
    this.climb.update(dt, false, 0);
    // And the same with the helm, which is what makes the helmsman let go of the
    // wheel on leaving the station instead of walking off across the deck with
    // cupped hands.
    this.helm.update(dt, false, 0);
    // The water is the exception, and the guard is mandatory for the same reason as
    // the helm's in `settleBob`: whoever is swimming has already fed this clock on
    // this step (in `updateSwim`), and a second `damp` on the same frame would pull
    // the weight back down — the two would balance out with half the water on the
    // body.
    if (!this.inWater) this.swim.update(dt, false, 0);
    // After `resolveGround`, on purpose: it is what decides whether this frame is
    // flight or contact, and the jump's clock needs the answer already made.
    this.jump.update(dt, this.velocity.y, this.grounded);

    if (this.gait.moving > 0.001) {
      // Neither the cadence nor the height is invented here. The cadence comes from
      // the distance the stride covers on the ground — the same arithmetic that
      // keeps the character's foot planted on the deck during stance. The height
      // comes from the clip, in meters: it is **the same movement** that lifts the
      // hips of the body the player is wearing, and not an exaggerated version of
      // it.
      //
      // A `min(speed / RUN_SPEED, 1)` that damped the bob at low speed used to be
      // here. It made sense while the amplitude was a loose number; against the
      // clip's amplitude it is double counting, and what it produces is exactly the
      // sliding being fixed — the camera rising less than the torso it is supposed
      // to be following.
      const target = this.gait.bounceMeters * this.gait.moving;
      this.bobOffset = damp(this.bobOffset, target, BOB_LAMBDA, dt);
    } else {
      this.bobOffset = damp(this.bobOffset, 0, 9, dt);
    }
  }

  /** The **step's** pose, in local coordinates. What shows it is `syncView`. */
  private updateEye(): void {
    // The **fake** feet first: they are what the camera and the body follow, and
    // they stay the step remainder behind the real feet. See `absorbStep`.
    this.simVisualLocal.set(this.local.x, this.local.y - this.stepOffset, this.local.z);
    this.simEyeLocal.set(
      this.simVisualLocal.x,
      this.simVisualLocal.y + EYE_HEIGHT + this.bobOffset,
      this.simVisualLocal.z,
    );
  }

  /**
   * The pose the camera and the body use this frame.
   *
   * ## Why the gaze is not interpolated like the position
   *
   * The position comes from two steps and is interpolated by `alpha` — it is the
   * same technique as the hull's, and the half-step delay it introduces is invisible
   * on a body walking at 3 m/s.
   *
   * The **gaze** is not. Interpolating the head at 60 Hz on a 144 Hz screen is the
   * difference between an aim that sticks to the mouse and one that drags, and there
   * is no player who does not feel it. That is why the rotation is composed of two
   * pieces: what the simulation has already absorbed (`yaw`/`pitch`) plus what
   * arrived after the last step and has not been consumed yet (the residual, which
   * comes from `InputSampler`).
   *
   * The sum is **continuous across the handover**: when the fixed step consumes the
   * residual, `yaw` moves exactly what the residual was worth and the residual zeroes
   * at the same instant, so that `yaw + residual` does not change. The `pitch` clamp
   * is applied on both sides for the same reason — without it, looking up would
   * accumulate a residual outside the limit that would have to be "unwound" before
   * the head could come down.
   *
   * @param residualX horizontal look not yet consumed, in radians.
   * @param residualY the same, vertical.
   */
  syncView(alpha: number, residualX: number, residualY: number, ship: Ship): void {
    if (this.station === 'cannon' && this.applyCannonView(alpha, ship)) return;

    this.visualLocal.lerpVectors(this.previousVisualLocal, this.simVisualLocal, alpha);
    this.eyeLocal.lerpVectors(this.previousEyeLocal, this.simEyeLocal, alpha);

    // And the reconciliation offset on top of both, **after** the interpolation.
    //
    // After, and not inside, because it is not a step quantity: it decays on the
    // frame's clock, so interpolating it between two simulation poses would be
    // mixing two different rates. The view's three debts add up here without running
    // into each other, and each in a direction of its own — the step (`stepOffset`)
    // only vertically and already inside `updateEye`, the bob (`bobOffset`) only at
    // the eye, and this one on both, because a network correction moves the whole
    // body.
    this.visualLocal.add(this.viewOffset);
    this.eyeLocal.add(this.viewOffset);

    _euler.set(
      clamp(this.pitch - residualY, -PITCH_LIMIT, PITCH_LIMIT),
      this.yaw - residualX,
      0,
    );
    this.eyeQuaternion.setFromEuler(_euler);
  }

  /**
   * The camera's pose when the player is at the cannon: behind and a little above
   * the breech, aligned with the barrel. Since the camera's line is **parallel** to
   * the bore, the screen's crosshair works as an aiming reference — and the ball's
   * drop is still down to whoever is shooting, which is what the duel asks for.
   *
   * The look residual does **not** come in here, and it is not an oversight: at the
   * cannon the gaze turns the gun, not the head. Advancing the camera without
   * advancing the barrel would make the tube swim against the crosshair — and the
   * crosshair is precisely what this view exists to give. The smoothness comes from
   * the cannon's own interpolated pose.
   *
   * @returns `false` when the cannon is gone — the caller falls back to the on-foot
   *   view.
   */
  private applyCannonView(alpha: number, ship: Ship): boolean {
    const cannon = ship.cannons[this.cannonIndex];
    if (!cannon) return false;

    cannon.getBarrelQuaternion(this.eyeQuaternion, alpha);
    cannon.getPivotLocal(_pivot);
    // The reconciliation offset does **not** come in here, and it is the only view
    // it does not come into: the camera is attached to the part, and the part
    // belongs to the ship. A prediction error of the *body* has nothing to say about
    // where the barrel is pointing — adding it there would drag the aim of somebody
    // who is aiming.
    this.eyeLocal.set(0, 0.45, 1.35).applyQuaternion(this.eyeQuaternion).add(_pivot);
    // The feet stay where the step left them: what draws them is the body, and it
    // does not follow the breech. That one does carry the offset, as in `syncView`.
    this.visualLocal.lerpVectors(this.previousVisualLocal, this.simVisualLocal, alpha);
    this.visualLocal.add(this.viewOffset);
    return true;
  }

  private saveReturn(): void {
    this.stationReturn.copy(this.local);
    this.stationReturnYaw = this.yaw;
  }
}

/**
 * Sweeps the hull and returns the band of Z where somebody still fits standing up.
 *
 * Without it the player would walk to the very tip of the bow, where the deck is a
 * hand's breadth wide, and would end up hanging in mid-air with their body outboard
 * of the planking.
 */
function measureWalkRange(halfWidthAt: (t: number) => number): { min: number; max: number } {
  const needed = PLAYER_RADIUS + 0.08;
  let tMin = 0.02;
  let tMax = 0.98;

  for (let i = 0; i <= 200; i++) {
    const t = i / 200;
    if (halfWidthAt(t) >= needed) {
      tMin = t;
      break;
    }
  }
  for (let i = 200; i >= 0; i--) {
    const t = i / 200;
    if (halfWidthAt(t) >= needed) {
      tMax = t;
      break;
    }
  }

  // `t` grows toward the bow and Z shrinks: the extremes swap sides.
  return { min: tToZ(tMax), max: tToZ(tMin) };
}
