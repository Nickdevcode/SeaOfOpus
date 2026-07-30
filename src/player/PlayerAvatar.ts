/**
 * The player's body aboard: mesh, skeleton and locomotion blend.
 *
 * The body is watched from two places, and each one charges for something
 * different. From outside — the free camera, and the opponent in a networked
 * duel — the flaw that gives a character away is the foot skating on the deck.
 * From inside, in first person, what gives it away is the head: the eye sits at
 * 1.66 m and the skull occupies exactly that height. The first problem is
 * solved by the single stride phase, right below; the second by the clipping in
 * `shaders/headClip.ts`, and that is what let the body stop hiding in first person.
 *
 * That's why the blend between walking and running is **not** a `lerp` of weights
 * with each clip running at its own speed. Both are put at the **same point of
 * the stride**, frame by frame, from the phase the `GaitClock` keeps — there
 * isn't even a `timeScale` here. Since both clips start on the left foot
 * touching the ground, the contacts land at the same instant and the foot stays
 * planted on the deck through the stance, at any point of the blend. Leaving
 * each one at its own rhythm would make the two disagree about where the foot
 * is, and the average of two truths is a lie that slips.
 *
 * The clock lives in `PlayerController` and not here on purpose: it's also what
 * drives the camera bob, and the two have to be the same step. On top of that
 * the body is a file that loads asynchronously and can fail; the game has to
 * run the same without it.
 *
 * The avatar goes in as a **child of the ship model**, so it follows bow pitch
 * and heel for free — the same reason `CameraRig` composes with
 * `ship.model.root` and not with `ship.body`.
 *
 * ## Two bodies, one class
 *
 * A match instantiates **two**: the player's, hung on his hull, and the
 * opponent's, hung on the other. It's the same class because it's the same thing
 * — a deckhand aboard —, and the only difference is where the `PlayerController`
 * that feeds it comes from: on the host and in the local duel it is simulated
 * here, and on the client that doesn't simulate, the pose arrives over the wire
 * and `PlayerController.applyRemoteStep` turns it into the same clocks. All the
 * rest of this file is blind to that distinction, and that's what makes the
 * other player's body walk, run, jump, climb the ladder, steer and nail planks
 * with the same clips and the same rules as yours.
 */

import * as THREE from 'three';
import { damp } from '../core/MathUtils';
import { instantiateCharacter, loadCharacter } from './CharacterAsset';
import { HeadLook } from './HeadLook';
import {
  HEAD_CLIP_OFF,
  HEAD_CLIP_THRESHOLD,
  type HeadClipHandle,
  installHeadClip,
} from '../shaders/headClip';
import { STATION_BLEND } from './CameraRig';
import { FirstPersonBody } from './FirstPersonBody';
import type {
  CarryClock,
  ClimbClock,
  GaitClock,
  HelmClock,
  JumpClock,
  SwimClock,
} from './Locomotion';
import { CarriedPlank } from './CarriedPlank';
import { SWIM_SUBMERSION, type PlayerController } from './PlayerController';

/** Convergence of the body's facing, in 1/s. */
const FACING_LAMBDA = 11;

/**
 * Where the body settles on the vertical, given the height of the simulated feet.
 *
 * ## The two water clips have another origin, and that's what this line fixes
 *
 * In the eight land clips `y = 0` is the **ground, under the feet**, which is why
 * the whole avatar is hung at the position of the feet and that's it. In the two
 * water clips `y = 0` is the **waterline**: the body was built split at it, legs
 * and hips below, shoulders and head above. Playing `Float` without handling that
 * puts the clip's waterline at the height of the simulated feet, and the pirate
 * floats a meter and a half above the sea — or, put the other way round, the sea
 * starts cutting him off at the ankles.
 *
 * The fix is a single sum: raise the body by `SWIM_SUBMERSION` when the water has
 * the whole body, nothing when it has none of it, and the fraction in between.
 *
 * ## Why the fraction is linear, and why it doesn't jump
 *
 * Because the pose is too. Through the transition the rig's `root` is the weighted
 * average of the two clips: with weight `w` in the water, `Float`'s submersion
 * translation comes in worth `w × 1.32` and the rest of the body comes from the
 * land clips. Adding `w × 1.44` on the outside makes the drawn body interpolate
 * **in a straight line** between the two settlings — simulated feet when `w = 0`,
 * clip settled on the surface when `w = 1`, and nothing discontinuous between the
 * two. Any curve other than the weight's would peel the clip's origin off the pose
 * it is drawing.
 *
 * ⚠️ **`water` has to be the weight the clips actually got**, not the clock's:
 * with no `Float` in the GLB (an old cached file) the body is still drawn by
 * locomotion, which wants the feet where the feet are. See `updateSwim`.
 *
 * @param feetY height of the simulated feet, in ship coordinates.
 * @param water how much of the body the water clips took, in [0, 1].
 */
export function waterPoseY(feetY: number, water: number): number {
  return feetY + SWIM_SUBMERSION * water;
}

/**
 * Splits what's left of the body between the plank and locomotion.
 *
 * It's the only arithmetic in this file with an **invariant**, and that's why it
 * moved out of the method: the weights have to add up to exactly 1. Whatever is
 * left over above 1 Three renormalizes, shrinking everyone by the same
 * proportion; whatever is missing it fills in with the rig's rest pose, which is
 * the T-pose with the arms out. Neither flaw shows up in Blender and both show up
 * in the first second of play.
 *
 * ⚠️ **The sum only closes because the inputs are exclusive**, and each exclusion
 * is a line of code in another file: there's no way to be on the ladder and at the
 * rudder, nor on the ladder and in the sea (`updateLadder` clears the water, which
 * is what the hull-side ladder just pulled him out of), nor in the sea and in the
 * middle of a jump (`enterWater` ends the flight without firing a landing). Where
 * two of them cross, they cross with the same λ and the sum carries one body
 * through the handover. What checks this frame by frame over a
 * deck→sea→ladder→deck run is `tests/locomotion.ts`.
 *
 * The only one that **coexists** with the others is the plank — you can carry
 * lumber while walking through the hold —, and it's the one that yields to all the
 * rest: to the station, because you don't nail a plank hanging off a ladder; to
 * the jump, because you don't nail a plank in the air; and to whoever is walking,
 * because a body sliding across the deck in the carry pose is exactly the flaw the
 * rest of this file exists to avoid.
 *
 * @param posts what ladder, helm, water and jump have already taken.
 * @param carry the weight the plank asked for.
 * @param moving how much of locomotion is walking, in [0, 1].
 */
export function poseBudget(
  posts: { climb: number; helm: number; swim: number; jump: number },
  carry: number,
  moving: number,
): { carry: number; ground: number } {
  const taken = posts.climb + posts.helm + posts.swim + posts.jump;
  const held = Math.max(0, Math.min(carry, (1 - taken) * (1 - moving)));
  return { carry: held, ground: Math.max(0, 1 - taken - held) };
}

/**
 * How far the body pulls back from the eye in first person, in meters.
 *
 * **Without this first person doesn't work**, and the reason is anatomical. The
 * camera sits `EYE_HEIGHT` above the feet, **on the axis of the spine** — a
 * human's eye isn't there, it's some ten centimeters ahead of it, because the
 * skull comes off the spine and the face juts forward. With the camera on the
 * axis, looking down means looking into your own chest: the hole the head clipping
 * opens at the neck falls exactly on the line of sight, and the screen turns into
 * a wall of shapeless coat. Measured at run time: at the `PITCH_LIMIT` limit the
 * torso filled the entire screen.
 *
 * Pulling the **body** back instead of pushing the camera forward is deliberate.
 * The eye is the reach origin for `Interaction`, for the ear in
 * `audio.setListener` and for the cannon's aim; touching it to fix a framing would
 * change gameplay distances. The body owes nobody anything — pulling it back is a
 * lie only the view tells, and it costs eleven centimeters of standing back from
 * the edge that nobody measures.
 *
 * **Eleven, not twenty.** It was measured at both ends of `PITCH_LIMIT`, because
 * the error has two sides: too little setback and the torso becomes a shapeless
 * wall when looking straight down; too much and the body **disappears** at the 55°
 * you actually walk around at — the pirate hangs in front of the camera instead of
 * under it. At 0.18 the shoulder already didn't show up at 55°; at 0.11 it sits at
 * the bottom of the frame in both cases, which is the framing you're after.
 */
const FIRST_PERSON_SETBACK = 0.11;

const _velocity = new THREE.Vector2();

export class PlayerAvatar {
  /** Node that goes inside the ship model. */
  readonly root = new THREE.Group();

  private mixer: THREE.AnimationMixer | null = null;
  private idle: THREE.AnimationAction | null = null;
  private walk: THREE.AnimationAction | null = null;
  private run: THREE.AnimationAction | null = null;
  private jumpAir: THREE.AnimationAction | null = null;
  private jumpLand: THREE.AnimationAction | null = null;
  private climbUp: THREE.AnimationAction | null = null;
  private helm: THREE.AnimationAction | null = null;
  private carry: THREE.AnimationAction | null = null;
  private float: THREE.AnimationAction | null = null;
  private swim: THREE.AnimationAction | null = null;

  /** The lumber in the hands while a plank is being nailed. See `CarriedPlank`. */
  private readonly plank = new CarriedPlank();

  private facing = 0;
  private facingReady = false;

  /**
   * The head clipping, one per mesh material.
   *
   * Stays empty if the GLB doesn't bring the `head` bone — and then first person
   * just doesn't turn the body on, instead of showing the skull from the inside.
   */
  private readonly headClips: HeadClipHandle[] = [];
  /** Threshold in force while the clipping is on. See `calibrate`. */
  private headClipThreshold = HEAD_CLIP_THRESHOLD;
  /** Setback in force. See `FIRST_PERSON_SETBACK` and `calibrate`. */
  private setback = FIRST_PERSON_SETBACK;

  /**
   * The twist that separates legs from torso. Only holds in first person: from
   * outside, the whole body pointing where it walks is still the right thing, and
   * that's the pose the opponent shows. What he gets in its place is the neck —
   * see `HeadLook`.
   */
  private readonly body = new FirstPersonBody();
  private twistReady = false;

  /**
   * The neck that follows the gaze. Only acts on the body seen **from outside** —
   * see `HeadLook`, which explains why it and the hip twist don't coexist.
   */
  private readonly headLook = new HeadLook();
  private headLookReady = false;

  /**
   * Materials of **this** body, for disposal. See `CharacterAsset`: the geometry
   * and the textures are shared with the other avatar and are not ours to free.
   */
  private readonly materials: THREE.Material[] = [];

  /**
   * Makes the whole body disappear, without spending an animation step on it.
   *
   * It exists because of the opponent's body, which only makes sense over the
   * network: against the machine, what commands the enemy hull is the `ShipAI`,
   * which moves no deckhand at all — and a pirate planted on the deck in the idle
   * pose, never taking a step, is worse than no pirate. See `Match.startOnline`.
   */
  hidden = false;

  /** Body position, lagged by the station transition. See `updateStation`. */
  private readonly stationPosition = new THREE.Vector3();
  /** 1 = transition finished. Starts ready so the first frame doesn't jump. */
  private stationBlend = 1;
  private lastStationChange = -1;

  loaded = false;

  /**
   * Loads the character. Failing here does **not** bring the game down: with no
   * body, everything else stays playable, and in first person it doesn't even show.
   *
   * The file comes from `CharacterAsset`, which downloads it **once** and hands
   * back an independent copy per avatar — mesh and texture shared, skeleton and
   * material private. See there the reason for each of those halves.
   */
  async load(url: string): Promise<boolean> {
    try {
      const character = instantiateCharacter(await loadCharacter(url));
      const { model, skinned } = character;
      this.materials.push(...character.materials);

      this.root.add(model);
      this.mixer = new THREE.AnimationMixer(model);
      this.installHeadClip(skinned);
      this.installTwist(skinned);
      this.installHeadLook(skinned);

      this.idle = this.action(character.animations, 'Idle');
      this.walk = this.action(character.animations, 'Walk');
      this.run = this.action(character.animations, 'Run');
      if (!this.idle || !this.walk || !this.run) {
        console.warn('[avatar] locomotion clips not found in the GLB');
        return false;
      }

      // The jump is optional: an old GLB in the browser cache can't take
      // locomotion away from the player, which is what he uses all the time.
      this.jumpAir = this.action(character.animations, 'JumpAir');
      this.jumpLand = this.action(character.animations, 'JumpLand');
      if (!this.jumpAir || !this.jumpLand) {
        console.warn('[avatar] jump clips not found in the GLB; the body jumps with no pose');
      }

      // Climbing is optional for the same reason as the jump: an old cached GLB
      // can't take locomotion from the player, which is what he uses all the time.
      this.climbUp = this.action(character.animations, 'ClimbUp');
      if (!this.climbUp) {
        console.warn('[avatar] climb clip not found in the GLB');
      }

      // The helm, likewise. Without it the game stays whole: the helmsman steers
      // in the idle pose, which is exactly what he did before this clip existed.
      this.helm = this.action(character.animations, 'Helm');
      if (!this.helm) {
        console.warn('[avatar] helm clip not found in the GLB');
      }

      // And the repair plank. Without the clip, the breach still closes and the
      // lumber still shows up nailed to the hull — what's lost is the gesture.
      this.carry = this.action(character.animations, 'Carry');
      if (!this.carry) {
        console.warn('[avatar] plank-carry clip not found in the GLB');
      }

      // And the water, which is **two** and counts as one: with no `Float` there
      // is no floating pose, and with no `Swim` the stroke never starts — half a
      // pair would give a body that floats and then slides with no gesture, which
      // is worse than the upright body locomotion drew before the two existed.
      // With either one missing, the water returns zero weight and the game goes
      // back to being the one from then.
      this.float = this.action(character.animations, 'Float');
      this.swim = this.action(character.animations, 'Swim');
      if (!this.float || !this.swim) {
        console.warn('[avatar] water clips not found in the GLB; the body swims with no pose');
      }
      if (skinned) this.plank.attach((skinned as THREE.SkinnedMesh).skeleton, this.root);

      // What advances the time on these is a clock, frame by frame: the stride for
      // walking and running, the vertical speed for the air, the landing timer for
      // the landing. Idle is the only one that isn't: it breathes at its own
      // rhythm, which has nothing to do with anyone's speed.
      this.walk.setEffectiveTimeScale(0);
      this.run.setEffectiveTimeScale(0);
      this.jumpAir?.setEffectiveTimeScale(0);
      this.jumpLand?.setEffectiveTimeScale(0);
      // Climbing is indexed by the height cleared, as the stride is by distance on
      // the ground. Standing still on the ladder the phase doesn't advance, and the
      // character freezes clinging to it — which is exactly what's wanted.
      this.climbUp?.setEffectiveTimeScale(0);
      // And the helm by the wheel's angle, for the same reason: stopped with the
      // rudder held over, the helmsman keeps his hands on the spoke handles where
      // the wheel stopped.
      this.helm?.setEffectiveTimeScale(0);
      // The plank too, but for a different reason than the others: its phase comes
      // from no quantity in the world, it comes from a clock — and the clock is
      // `CarryClock`, on the outside, so that the breathing doesn't restart from
      // zero every time the hand goes back to the lumber.
      this.carry?.setEffectiveTimeScale(0);
      // The stroke is indexed by the **distance swum**, as the stride is by
      // distance on the ground: it's what makes the hand push water instead of
      // skating on it, at any swimming speed.
      this.swim?.setEffectiveTimeScale(0);
      // And the float by time, same family as the plank and idle — only on a clock
      // this file doesn't own, so that the breathing of someone who falls into the
      // sea twice doesn't restart from zero the second time. See `SwimClock`.
      this.float?.setEffectiveTimeScale(0);

      this.loaded = true;
      return true;
    } catch (error) {
      console.warn('[avatar] could not load the character:', error);
      return false;
    }
  }

  private action(clips: THREE.AnimationClip[], name: string): THREE.AnimationAction | null {
    const clip = clips.find((c) => c.name === name);
    if (!clip || !this.mixer) return null;
    const action = this.mixer.clipAction(clip);
    action.setLoop(THREE.LoopRepeat, Infinity);
    action.play();
    action.setEffectiveWeight(0);
    return action;
  }

  /**
   * Sets up the head clipping on the mesh's materials.
   *
   * The indices come from `skeleton.bones`, which is exactly the table the
   * geometry's `skinIndex` attribute references — looking the bone up by name in
   * the scene graph would give the right `Object3D` and the wrong index.
   *
   * Failing here brings nothing down: with no clipping the avatar just doesn't
   * turn the body on in first person, and the game goes back to what it was
   * before. It's the same policy the file already applies to the jump clip and to
   * the climb clip.
   */
  private installHeadClip(mesh: THREE.SkinnedMesh | null): void {
    if (!mesh) {
      console.warn('[avatar] skinned mesh not found in the GLB; no first-person body');
      return;
    }

    const bones = mesh.skeleton.bones;
    const head = bones.findIndex((bone) => bone.name === 'head');
    const neck = bones.findIndex((bone) => bone.name === 'neck');
    if (head < 0) {
      console.warn('[avatar] `head` bone not found in the GLB; no first-person body');
      return;
    }

    const materials = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
    for (const material of materials) this.headClips.push(installHeadClip(material, head, neck));
  }

  /**
   * Sets up the first-person twist. Failing here costs only the twist: the body
   * keeps walking, jumping and climbing the ladder, pointed where it walks.
   */
  private installTwist(mesh: THREE.SkinnedMesh | null): void {
    if (!mesh) return;
    this.twistReady = this.body.attach(mesh.skeleton, this.root);
    if (!this.twistReady) {
      console.warn('[avatar] spine not found in the GLB; the body does not twist in first person');
    }
  }

  /**
   * Sets up the neck that follows the gaze. Failing costs only the gesture — and
   * it only shows on the body seen from outside, which is the opponent's. See
   * `HeadLook`.
   */
  private installHeadLook(mesh: THREE.SkinnedMesh | null): void {
    if (!mesh) return;
    this.headLookReady = this.headLook.attach(mesh.skeleton, this.root);
    if (!this.headLookReady) {
      console.warn('[avatar] neck not found in the GLB; the head does not follow the gaze');
    }
  }

  /** Hangs the body on the ship model. */
  attach(parent: THREE.Object3D): void {
    parent.add(this.root);
  }

  /**
   * @param firstPerson `true` when the camera is in this body's eyes.
   *
   * The policy for when the body shows belongs to the character, not to the main
   * loop: whoever knows that the cannon takes the camera out of the head is
   * whoever knows the stations. The rule is one sentence — **the body shows when
   * the camera is in its eyes** —, and it covers both cases at once.
   *
   * Hidden, the body keeps animating. Stopping the mixer along with it would make
   * the character show up frozen on the frame it vanished on, the moment the
   * camera comes loose (`C` key) or the cannon is let go.
   */
  update(dt: number, player: PlayerController, firstPerson: boolean): void {
    if (!this.loaded || !this.mixer || !this.idle || !this.walk || !this.run) return;

    // A body that's off doesn't spend mixer. It's the opposite of the rule in the
    // paragraph above, and on purpose: there the body vanishes for a frame and
    // comes back (the camera comes loose, the cannon is let go), here it vanishes
    // for a whole match.
    if (this.hidden) {
      this.root.visible = false;
      return;
    }

    // At the cannon the camera goes behind the breech and the feet stay where they
    // were when the button was pressed — the body would show from outside,
    // decapitated, meters off to the side.
    const embodied = firstPerson && this.headClips.length > 0;
    this.root.visible = !firstPerson || (embodied && player.station !== 'cannon');
    this.setHeadClip(embodied);
    // The **visual** pose, not the collision one: on a ladder the feet clear a
    // whole rung in one frame, and it's the view that absorbs that. See
    // `PlayerController`.
    this.updateStation(dt, player);

    _velocity.set(player.velocity.x, player.velocity.z);
    // "Walking" is the body advancing by its own gesture, and in the water that
    // gesture is the stroke. This is the bit that points the body where it's
    // **going** instead of where it's looking, and a swimmer with his heading tied
    // to his gaze does sideways what the moonwalk did backwards.
    const walking = player.gait.moving > 0.5 || player.swim.stroke > 0.5;

    // The ladder takes the whole body: whoever is hanging off it is neither walking
    // nor falling. What it occupies comes off the budget before anything else.
    const climbing = this.updateClimb(player.climb);
    // The helm comes off the same budget and for the same reason: whoever has his
    // hands on the wheel isn't walking. The two never overlap — there's no way to
    // be on the ladder and at the rudder —, so adding them doesn't blow the total.
    const helming = this.updateHelm(player.helm);
    // And the water, which is the third exclusive station: whoever is in the sea
    // isn't hanging off a mast rung nor with his hands on the wheel. See
    // `updateSwim`.
    const swimming = this.updateSwim(player.swim);
    // The jump is the fourth, and by construction it doesn't coexist with the
    // water — the splash ends the flight in `PlayerController.enterWater`, without
    // firing a landing.
    const jumping = this.updateJump(player.jump);

    // The rest is split between the plank and locomotion, and the sum closes at 1.
    // The arithmetic lives outside here because it's the only one in this file with
    // an invariant: see `poseBudget`, which explains why the plank is the only one
    // that yields.
    const { carry: carrying, ground } = poseBudget(
      { climb: climbing, helm: helming, swim: swimming, jump: jumping },
      // The clock asks, but whoever has no clip occupies no body at all: without
      // this guard the budget would reserve weight for a pose nobody draws, and
      // whatever was left over would turn into T-pose.
      this.carry ? player.carry.weight : 0,
      player.gait.moving,
    );
    this.applyCarry(player.carry, carrying);

    // The twist is exclusive to whoever is inside the body. Seen from outside, the
    // whole body pointed where it walks is still the right thing — and that's the
    // pose the opponent shows.
    const twisting = embodied && this.twistReady;
    if (twisting) this.updateWornFacing(dt, player, walking);
    else this.updateFacing(dt, player, walking);

    // After the heading, which is what says where "behind" is.
    this.applyPosition(embodied, player, swimming);
    this.updateLocomotion(player.gait, ground, twisting && this.body.reversed);
    this.mixer.update(dt);
    // After the mixer, always: it rewrites all 43 bones on every pass.
    if (twisting) this.body.apply();
    // And the neck, which is the same gaze seen from the other side. Exclusive to
    // whoever is **not** inside the body: in first person the head is clipped and
    // the hip's twist takes up the same instant, and the two rotations do not
    // commute. See `HeadLook`.
    //
    // ⚠️ **And it yields to the water in proportion to how much of the body the
    // water took.** The sea's two clips do not have the head where they have it by
    // accident: `anim_swim.solve_attitude` solved the torso's attitude and the
    // neck's extension **against a constraint** — the face never goes into the water
    // — and each one's `verify()` measures the clearance left (3.5 cm swimming,
    // 10.4 cm floating). `HeadLook` does not know that constraint: it adds up to 49°
    // of tilt on top of what the clip already solved, and on a lying body 49°
    // downward is the opponent's face sinking every time its owner looks at their own
    // feet. In the water the head belongs to the clip.
    else if (this.headLookReady) this.headLook.apply(player.pitch * (1 - swimming));
    // And the plank after both, because it reads the wrists' matrices: read before,
    // it would draw the previous frame's pose.
    // The threshold is the clip's weight, and not the clock's: walking gives the
    // pose over to locomotion, and the wood has to leave with it — nobody runs
    // through the hold with a plank floating in front of their chest.
    this.plank.update(this.root.visible && carrying > 0.35);
  }

  /**
   * Seats the body, set back from the eye when it is the player wearing it.
   *
   * The setback is along the **torso's** axis (the model looks at local +Z, hence the
   * sine and cosine of the heading), and not along the movement's: what rules the
   * framing is the head, and it is the head that follows the torso. See
   * `FIRST_PERSON_SETBACK`.
   *
   * **At the helm there is no setback**, and it is the only station where that holds.
   * The setback exists to take the torso out from in front of the eye, and it works
   * because the torso follows the gaze; there the body is locked facing the bow (see
   * `updateWornFacing`), so setting back along the torso's axis means moving the body
   * away **from the wheel** — the 11 cm add to the gap the arm already has to cover
   * and the player's hands land short of the handles. Compensating in the clip is no
   * good: it is the same clip the other player sees from outside, where there is no
   * setback at all.
   *
   * **In the water the setback still applies, and it is still 11 cm** — but the
   * geometry it solves is no longer the same, and the numbers deserve writing down.
   * Measured in the GLB, with the clip's origin already seated on the waterline and
   * the camera at `SWIM_EYE_HEIGHT`'s 22 cm, the neck joint sits:
   *
   * - **standing on deck:** 28 cm below and 9 cm behind the camera;
   * - **floating (`Float`):** 14 cm below and 17 cm behind — the body reclines 15°
   *   backwards and the setback adds to that, so it is even further out of view than
   *   on land. The clip's head sits 9 cm behind the origin, meaning behind the camera;
   * - **swimming (`Swim`):** 18 cm below and **1 cm ahead**. The body is lying flat,
   *   the head advances 19 cm from the origin and the setback barely manages to bring
   *   it back under the eye.
   *
   * The last case is the only one that does not close on paper by itself. What saves
   * it is the camera's 15 cm `near`: looking forward, the clipping plane falls ahead
   * of the neck and of the whole head, and what is left on screen are the arms in the
   * stroke, which is exactly what we want to see. Looking **down**, at `PITCH_LIMIT`'s
   * stop, the plane drops and the hole the clipping opens in the neck fits back into
   * the framing. This is a look-at-the-screen matter, and the knob is at hand:
   * `calibrate({ setback })` through the `window.__game` bench.
   *
   * The vertical is the other half of the seating, and it is all the water's: see
   * `waterPoseY`.
   *
   * @param water how much of the body the water clips took, in [0, 1].
   */
  private applyPosition(embodied: boolean, player: PlayerController, water: number): void {
    this.root.position.copy(this.stationPosition);
    this.root.position.y = waterPoseY(this.root.position.y, water);
    if (!embodied || player.station === 'helm') return;
    this.root.position.x -= Math.sin(this.facing) * this.setback;
    this.root.position.z -= Math.cos(this.facing) * this.setback;
  }

  /**
   * Takes the body to the station on the same step as the camera.
   *
   * Taking the helm **teleports** the feet: `takeHelm` writes `local` straight into
   * `HELM_STAND`, which can be two meters away. The camera never suffered from that
   * because `CameraRig` already interpolated the change over 0.28 s — the body did
   * not, and while it was hidden nobody saw. Wearing the body, the difference is a
   * decapitated pirate crossing the deck toward the player while the camera has not
   * moved yet.
   *
   * The curve is deliberately the rig's: same duration, same smoothstep, same
   * constant. Two similar but not identical smoothings would be worse than none.
   */
  private updateStation(dt: number, player: PlayerController): void {
    if (player.stationChangeCount !== this.lastStationChange) {
      // The first time is the spawn, and there is nowhere to come from there.
      this.stationBlend = this.lastStationChange < 0 ? 1 : 0;
      this.lastStationChange = player.stationChangeCount;
    }

    if (this.stationBlend >= 1) {
      this.stationPosition.copy(player.visualLocal);
      return;
    }

    this.stationBlend = Math.min(this.stationBlend + dt / STATION_BLEND, 1);
    const s = this.stationBlend * this.stationBlend * (3 - 2 * this.stationBlend);
    this.stationPosition.lerp(player.visualLocal, s);
  }

  /**
   * Switches the head clipping on and off.
   *
   * Only a uniform changes — no shader recompile, no program switch — so releasing
   * the camera with `C` gives the head back on the same frame. Writing every time,
   * instead of comparing with the previous state, is what keeps a calibrated
   * threshold valid after a round trip to third person.
   */
  private setHeadClip(on: boolean): void {
    const threshold = on ? this.headClipThreshold : HEAD_CLIP_OFF;
    for (const clip of this.headClips) clip.setThreshold(threshold);
  }

  /**
   * Where the body points.
   *
   * It is not where the player looks. With no side-step and backward clips, a body
   * tied to the gaze makes the character slide backwards when walking back — the
   * classic "moonwalk". Turning the body toward the direction of movement is a cheap
   * and invisible lie: the animation always walks forward, which is the only thing it
   * knows how to do.
   *
   * **It holds the same in the water**, and `walking` already arrives counting the
   * stroke: `Swim` is a crawl that advances head-first, and a swimmer with their
   * heading tied to the gaze would cross the sea sideways every time the player
   * looked at the ladder instead of where they are going. Floating there is nowhere
   * to point, and then the gaze rules again.
   */
  private updateFacing(dt: number, player: PlayerController, walking: boolean): void {
    // In the air nobody twists their body: the heading is whatever was taken at
    // takeoff. Without this the locomotion fades out during the flight, the target
    // falls back to the gaze, and whoever jumps sideways sees the character spin
    // mid-leap.
    if (this.facingReady && player.jump.air > 0.5) return;

    // The character was modeled looking at -Y in Blender, which becomes +Z after
    // glTF's Y-up conversion.
    //
    // On the ladder the heading is not a choice: the body faces the ladder, which is
    // forward of the player (the ship's -Z). Letting it follow the gaze would make
    // the pirate climb sideways — and the whole clip was built with the rungs in
    // front of the chest.
    //
    // At the helm the same holds, and the wheel is forward too: the clip puts the
    // hands on handles that are at a fixed position on the ship, and a body that
    // turns takes both with it. See `updateWornFacing`, which pays the price of that
    // from the inside.
    if (player.onLadder || player.station === 'helm') {
      // The ladder's heading comes from the **controller**, and is no longer a
      // `Math.PI` hardcoded here: that number was the mast ladder's heading, the only
      // one there was. A boarding ladder sits on the ship's side and is faced from
      // outside in.
      this.facing = player.onLadder ? player.ladderFacing : Math.PI;
      this.facingReady = true;
      this.applyFacing(player);
      return;
    }

    const target = walking
      ? Math.atan2(_velocity.x, _velocity.y)
      : player.yaw + Math.PI;

    if (!this.facingReady) {
      this.facing = target;
      this.facingReady = true;
    } else {
      // By the short path: without this, crossing ±π makes the body turn almost a
      // full revolution in one frame.
      let delta = (target - this.facing) % (Math.PI * 2);
      if (delta > Math.PI) delta -= Math.PI * 2;
      if (delta < -Math.PI) delta += Math.PI * 2;
      this.facing = damp(this.facing, this.facing + delta, FACING_LAMBDA, dt);
    }

    this.applyFacing(player);
  }

  /**
   * Where the body points when it is the player wearing it.
   *
   * The torso goes with the gaze **with no smoothing at all**: it is the camera, and
   * a chest that chases the camera with a delay makes the world turn inside your own
   * body. What damps is the leg, on the other side of the twist.
   *
   * The legs' heading is not the same everywhere, and the list of exceptions is short
   * but mandatory — each one is a place where the body has its feet attached to
   * something and the gaze does not.
   */
  private updateWornFacing(dt: number, player: PlayerController, walking: boolean): void {
    // On the ladder the body is hanging from the rungs: neither the heading nor the
    // twist is the looker's choice. See `updateFacing`, which solves the same thing
    // from outside.
    //
    // **And at the helm, for the same reason and with the same remedy.** The arms
    // inherit `spine_03`: with the torso tied to the gaze, both hands leave the wheel
    // the instant the player looks aside, and there is no clip that fixes that — the
    // clip puts the hand on a handle, not in space. `hold` locks the legs and zeroes
    // the twist at once, which is what keeps the whole body facing the bow.
    //
    // ⚠️ **And in the water, for a reason that is not busy hands: there the twist's
    // axis stops being the spine.** `FirstPersonBody` rotates the hip about the
    // avatar's vertical, and that is a torso twist while the torso is upright.
    // Swimming, the body is lying flat: that same rotation becomes perpendicular to
    // the spine, and what it produces is not a twisted hip, it is a swimmer **bent
    // sideways** like a banana — up to 65° of it, which is the limit
    // `LEG_OFFSET_LIMIT` allows without anyone seeing a problem on land.
    //
    // `hold` plants the legs on the body's heading and zeroes the offset, so `apply`
    // goes out the front door and the clip reaches the mixer intact. What is lost is
    // the legs/torso separation in the water, and there it costs nothing: whoever is
    // floating has no foot on the ground to slip with.
    if (player.inWater) {
      this.facing = player.yaw + Math.PI;
      this.facingReady = true;
      this.applyFacing(player);
      this.body.hold(this.facing);
      return;
    }

    // The cost is real and it is the same one the ladder already pays: the body
    // stops following the gaze. The trade is worth it precisely where the hands are
    // busy — and `legTarget` already planted the legs here, so half of it was already
    // owed.
    if (player.onLadder || player.station === 'helm') {
      this.facing = player.onLadder ? player.ladderFacing : Math.PI;
      this.facingReady = true;
      this.applyFacing(player);
      this.body.hold(this.facing);
      return;
    }

    this.facing = player.yaw + Math.PI;
    this.facingReady = true;
    this.applyFacing(player);

    this.body.update(dt, this.facing, this.legTarget(player, walking), walking);
  }

  /**
   * Writes the body's orientation: heading plus **ladder rake**.
   *
   * It is the only writer of `root.rotation`, and it became so out of necessity: the
   * rake lives on the X axis, so a path that only wrote `.y` would leave the body
   * lying at 14° after the player let go of the boarding ladder.
   *
   * ⚠️ **The rake is what makes that ladder work.** `ClimbUp` was built for rungs on
   * a vertical line in front of the chest; the boarding ladder is raked 14.11° to
   * follow the bilge, and an upright body on it sees the rung above escape 14° to the
   * side — an error that **grows with height**, because the line moves away from the
   * vertical linearly. Tilting the body by the same angle makes the ladder vertical
   * again in its frame and the grip matches on any rung, for free.
   *
   * The `'YXZ'` order composes `Ry(heading) · Rx(−rake)`: it turns toward the side
   * first and only then lays the body down about **its own** lateral axis. On the
   * mast ladder and on solid ground the rake is zero, and this becomes the usual
   * `rotation.y`.
   */
  private applyFacing(player: PlayerController): void {
    // Negative because the model looks at local +Z and a positive `Rx` would take the
    // top of the body *forward*; what we want is the top going backwards, in the
    // direction the ladder moves away from the planking.
    const tilt = player.onLadder ? -player.ladderTilt : 0;
    this.root.rotation.set(tilt, this.facing, 0, 'YXZ');
  }

  /**
   * Where the legs should point, or `null` to freeze them where they are.
   *
   * Off the ground the heading is whatever was taken at takeoff — without this,
   * turning the mouse mid-jump turns the legs with it, which is the same defect the
   * third-person heading already avoids. At the helm the feet stay planted behind the
   * wheel: `takeHelm` teleports the player there and the gaze stays free, so anyone
   * looking astern would see their own body turn around with its feet still.
   */
  private legTarget(player: PlayerController, walking: boolean): number | null {
    if (player.jump.air > 0.5) return null;
    if (player.station === 'helm') return Math.PI;
    // Walking, the direction of movement; standing still, the gaze — and it is
    // `FirstPersonBody` that decides whether that is a forward or a backward walk.
    return walking ? Math.atan2(_velocity.x, _velocity.y) : player.yaw + Math.PI;
  }

  /**
   * Puts both clips at the same point of the stride and splits the weights.
   *
   * Writing `action.time` instead of speeding up with `timeScale` removes any chance
   * of drift: two clips of different durations running on their own move a few
   * milliseconds apart per cycle, and within a minute one's contact lands in the
   * middle of the other's stance.
   */
  private updateLocomotion(gait: GaitClock, ground: number, reversed: boolean): void {
    const walk = this.walk!;
    const run = this.run!;

    // Walking backwards is the walk cycle read back to front. It works because the
    // foot contacts still land at the same instants of the stride — it is the same
    // reason going down the ladder is `ClimbUp` with the phase running backwards.
    //
    // The inversion lives **in the reading**, and not in the phase: the phase is
    // shared with the camera's bob and with `tests/locomotion.ts`, and flipping it
    // there would make the camera jolt opposite to the foot. The remainder (`%1`)
    // keeps phase zero from landing exactly at the end of the clip.
    const phase = reversed ? (1 - gait.phase) % 1 : gait.phase;
    walk.time = phase * (walk.getClip().duration || 1);
    run.time = phase * (run.getClip().duration || 1);

    walk.setEffectiveWeight((1 - gait.runBlend) * gait.moving * ground);
    run.setEffectiveWeight(gait.runBlend * gait.moving * ground);
    // What is left goes to the idle. Without this line the character falls back to
    // the rig's rest pose when nobody walks — the T-pose, arms out. It is a defect
    // that does not show up in Blender and does show up in the game's first second.
    this.idle!.setEffectiveWeight((1 - gait.moving) * ground);
  }

  /**
   * Puts the jump's two clips at the right point. Returns how much of the body they
   * took, which is what the locomotion stops occupying.
   *
   * The air one is indexed by **vertical velocity** and not by time, so writing
   * `.time` here is not an optimization as it is on the stride: it is the only way to
   * play it. See `JumpClock`.
   */
  private updateJump(jump: JumpClock): number {
    const air = this.jumpAir;
    const land = this.jumpLand;
    if (!air || !land) return 0;

    air.time = jump.airPhase * (air.getClip().duration || 1);
    land.time = jump.landPhase * (land.getClip().duration || 1);

    air.setEffectiveWeight(jump.air);
    land.setEffectiveWeight(jump.land);
    return jump.air + jump.land;
  }

  /**
   * Puts the climb clip at the right point of the cycle. Returns how much of the body
   * it took.
   *
   * Like the stride, the clip is **positioned** and not played: what chooses the frame
   * is the height gained, which `ClimbClock` turns into a phase. Writing `.time`
   * instead of speeding up with `timeScale` is what guarantees the hand stays on the
   * rung at any climbing speed — and it is what makes going down work for free, with
   * the phase running backwards.
   */
  private updateClimb(climb: ClimbClock): number {
    const action = this.climbUp;
    if (!action) return 0;

    action.time = climb.phase * (action.getClip().duration || 1);
    action.setEffectiveWeight(climb.weight);
    return climb.weight;
  }

  /**
   * Puts the helm clip at the right point of the cycle. Returns how much of the body
   * it took.
   *
   * The same contract as the climb, with another ruler: what chooses the frame is the
   * wheel's angle, which `HelmClock` turns into a phase. Writing `.time` is what pins
   * the hand to the handle at any rate of turn — and it is what makes turning to port
   * work for free, with the phase running backwards.
   */
  private updateHelm(clock: HelmClock): number {
    const action = this.helm;
    if (!action) return 0;

    action.time = clock.phase * (action.getClip().duration || 1);
    action.setEffectiveWeight(clock.weight);
    return clock.weight;
  }

  /**
   * Puts the water's two clips at the right point and splits them between themselves.
   * Returns how much of the body they took.
   *
   * ## Two rulers, because they are two different gestures
   *
   * `Swim` is indexed by **distance swum**, as the stride is by distance on the
   * ground: it is what makes the hand push water instead of skating on it, at any
   * speed. `Float` is indexed by **time**, like the plank, because floating has no
   * world quantity to read a phase from — it is breathing, and breathing does not
   * speed up with the current. Both live in the same `SwimClock`, which is the only
   * one that knows whether the sailor is at sea.
   *
   * The split is `stroke`, the sibling of the stride's `moving`: above the movement
   * threshold the body strokes, below it floats, and in between the two clips overlap
   * in the same proportion the body is between one gesture and the other. `weight` is
   * the whole water, and it is what this method returns — the sum of the two weights
   * is exactly it, so the pose budget does not know the water has two halves.
   *
   * ## No clip, zero weight
   *
   * The same policy as the jump and the climb: an old GLB in the browser's cache
   * cannot take the rest of the body away from the player. With either of the two
   * missing, the water returns zero, the locomotion takes the budget back and the body
   * goes back to swimming upright — which is exactly what it did before these clips
   * existed. That is why the **returned value** is what seats the vertical in
   * `waterPoseY`, and not `clock.weight`: with no water clip there is no water origin
   * to correct.
   */
  private updateSwim(clock: SwimClock): number {
    const float = this.float;
    const swim = this.swim;
    if (!float || !swim) return 0;

    swim.time = clock.phase * (swim.getClip().duration || 1);
    float.time = clock.floatPhase * (float.getClip().duration || 1);

    const stroking = clock.weight * clock.stroke;
    swim.setEffectiveWeight(stroking);
    float.setEffectiveWeight(clock.weight - stroking);
    return clock.weight;
  }

  /**
   * The plank in the hands, at the weight `poseBudget` released for it.
   *
   * @param weight how much body the plank got, already clamped to the budget.
   */
  private applyCarry(clock: CarryClock, weight: number): void {
    const action = this.carry;
    if (!action) return;

    action.time = clock.phase * (action.getClip().duration || 1);
    action.setEffectiveWeight(weight);
  }

  /** Diagnostics for the `window.__game` bench and for the telemetry overlay. */
  get debug(): {
    facing: number;
    walk: number;
    run: number;
    idle: number;
    air: number;
    land: number;
    climb: number;
    helm: number;
    /** The float's weight. Zero out of the water — and zero without the GLB's clips. */
    float: number;
    /** The stroke's weight, which splits the water with the float by `SwimClock.stroke`. */
    swim: number;
    /** Hip twist in effect, in radians. Zero outside first person. */
    twist: number;
    /** `true` when the stride is being read in reverse. */
    reversed: boolean;
    /** Head clipping threshold. `HEAD_CLIP_OFF` means the whole head. */
    headClip: number;
  } {
    return {
      facing: this.facing,
      walk: this.walk?.getEffectiveWeight() ?? 0,
      run: this.run?.getEffectiveWeight() ?? 0,
      idle: this.idle?.getEffectiveWeight() ?? 0,
      air: this.jumpAir?.getEffectiveWeight() ?? 0,
      land: this.jumpLand?.getEffectiveWeight() ?? 0,
      climb: this.climbUp?.getEffectiveWeight() ?? 0,
      helm: this.helm?.getEffectiveWeight() ?? 0,
      float: this.float?.getEffectiveWeight() ?? 0,
      swim: this.swim?.getEffectiveWeight() ?? 0,
      twist: this.body.offset,
      reversed: this.body.reversed,
      headClip: this.headClips[0]?.threshold ?? HEAD_CLIP_OFF,
    };
  }

  /**
   * Live calibration, through the `window.__game` bench.
   *
   * Where the neck has to vanish and how far the body sets back from the eye are
   * things you only decide with your eye on the screen. They are here, and not in
   * `Settings`, because they are the author's choices and not the player's: once
   * settled, they become the constants at the top of the file.
   *
   * @param threshold weight from which the fragment disappears, in [0, 1].
   * @param neckShare how much the `neck` bone counts toward that weight, in [0, 1].
   * @param setback the body's setback relative to the eye, in meters.
   */
  calibrate(options: { threshold?: number; neckShare?: number; setback?: number }): void {
    if (options.threshold !== undefined) this.headClipThreshold = options.threshold;
    if (options.setback !== undefined) this.setback = options.setback;
    if (options.neckShare === undefined) return;
    for (const clip of this.headClips) clip.setNeckShare(options.neckShare);
  }

  /**
   * Disposes of **this** body.
   *
   * ⚠️ The geometry and the textures are **not** released here, and that is not an
   * oversight: they belong to `CharacterAsset` and the other avatar is still using
   * the same ones. Releasing them from here would erase the opponent's body along
   * with the player's. What releases them is `disposeCharacterAsset`, after both.
   */
  dispose(): void {
    this.mixer?.stopAllAction();
    // Before sweeping the tree: the plank is a child of this node, but its geometry
    // and material belong to the `PlankAsset` module and still serve both hulls.
    this.plank.dispose();
    this.root.removeFromParent();
    for (const material of this.materials) material.dispose();
    this.materials.length = 0;
  }
}
