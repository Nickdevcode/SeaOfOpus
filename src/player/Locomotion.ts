/**
 * The stride's clock: one phase, from which both the step and the camera bob come.
 *
 * Before this there were **two clocks**. The camera bobbed at a cadence of its own
 * (`3.4 + speed * 1.15`), invented when the game was first person only and there was
 * no body to disagree with it. When the body arrived, the foot touched the deck at
 * one instant and the camera's jolt happened at another — the step you **see** and
 * the one you **feel** were different steps. Nobody points at what is wrong in a
 * scene like that; it just feels off.
 *
 * Now the phase is one thing and it rules both. It comes from here, and not from the
 * avatar, for two reasons: the body is a file that loads asynchronously and can fail,
 * and the game has to walk the same without it; and it is the controller that knows
 * the speed, which is what makes the phase advance.
 *
 * The phase runs [0, 1) per **stride** — both steps. Zero is the left foot touching
 * the ground, which is where the Blender clips start.
 */

import { damp } from '../core/MathUtils';

/**
 * What each clip actually does. The numbers come from Blender (`anim_walk.py`,
 * `anim_run.py`) and are **not** tunable here: what defines them is the character's
 * leg length. Touching them without regenerating the clips reintroduces foot slip —
 * and, in `bounceAmplitude`'s case, makes the body slide vertically underneath the
 * camera of whoever is wearing it.
 *
 * `bounceAmplitude` is the **half** amplitude with which the clip lifts the hips, in
 * meters: `anim_gait.GaitSpec.bounce_amplitude`.
 */
export const WALK_CLIP = {
  speed: 1.65,
  cycle: 0.8,
  bouncePhase: 0.0,
  bounceAmplitude: 0.021,
} as const;
export const RUN_CLIP = {
  speed: 3.6667,
  cycle: 0.6,
  bouncePhase: 0.155,
  bounceAmplitude: 0.035,
} as const;

/** Distance each cycle covers on the ground, in meters. */
export const WALK_DISTANCE = WALK_CLIP.speed * WALK_CLIP.cycle;
export const RUN_DISTANCE = RUN_CLIP.speed * RUN_CLIP.cycle;

/**
 * Vertical takeoff speed of the jump, in m/s.
 *
 * It lives here, and not in the `PlayerController` that applies it, because it is
 * what indexes the air clip: the clock needs it to know where on the parabola the
 * body is, and importing in the other direction would close a cycle.
 */
export const JUMP_SPEED = 3.3;

/**
 * Duration of the landing clip, in seconds — 14 frames at 30 fps, which is what
 * `anim_jump.py` generated. Unlike the air one, the landing **runs on time**: it has
 * no physical quantity to be read from.
 */
export const LAND_CLIP = { cycle: 14 / 30 } as const;

/** Below this the character is standing still. */
export const MOVE_THRESHOLD = 0.35;

/** Convergence of the blend and of the fade-out, in 1/s. */
const BLEND_LAMBDA = 9;

/** Convergence of entering and leaving the air, in 1/s. */
const AIR_LAMBDA = 22;

/** Impact speed that is already worth a full landing, in m/s. */
const LAND_FULL_SPEED = JUMP_SPEED;
/** Below this the foot merely touched, and showing a landing would be overkill. */
const LAND_MIN_SPEED = 1.0;
/** Fraction of the landing clip that keeps full weight: the compression. */
const LAND_HOLD = 0.45;

const lerp = (a: number, b: number, t: number): number => a + (b - a) * t;
const clamp01 = (v: number): number => (v < 0 ? 0 : v > 1 ? 1 : v);
const smoothstep = (t: number): number => t * t * (3 - 2 * t);

/**
 * What the climb clip does, and the numbers that tie it to the ship's ladder.
 *
 * `rise` is not an animator's choice: it is **two ratlines** of the mast ladder. The
 * clip was built on top of that (`PirateCharacter/scripts/anim_climb.py`) because it
 * is what allows the phase to be married to the absolute height — since the rise per
 * cycle is an integer multiple of the spacing, aligning the hand with a rung once is
 * aligning it forever.
 *
 * `footRung` is the height, inside the clip, of the rung the left foot takes at
 * phase 0, measured from the player's feet. It is the alignment's anchor.
 *
 * `standoff` is how far the body stays behind the plane of the rungs, in meters, and
 * it lives here — and not on each ladder — because **what dictates it is the
 * character**. It was 24 cm, and 24 does not fit: this pirate's coat sticks out
 * 24.8 cm ahead of the body's axis at the sash's height, and the rung still has a
 * 2.6 cm radius; with the old number he went through the ladder **standing still**,
 * before any animation. The value is mirrored in `anim_climb.LADDER_STANDOFF`, which
 * is where the clip was built — touching one without the other unmarries the hand
 * from the rung.
 *
 * ⚠️ **One constant for both of the ship's ladders**, and it is on purpose: the mast
 * one and the boarding one hold the body off for the same physical reason (the coat's
 * thickness), and while the number existed twice — once in `PlayerController`, once
 * in `BoardingLadder` — neither alignment test would fail a divergence between them,
 * because each read the copy on its own side.
 */
export const CLIMB_CLIP = {
  rise: 0.60667,
  footRung: 0.33,
  cycle: 1.0,
  standoff: 0.29,
} as const;

/**
 * The ladder's clock: the same idea as the stride, standing up.
 *
 * The phase advances with the **height gained**, not with time, and that is what
 * keeps the hand still on the rung while the body climbs — at whatever `CLIMB_SPEED`
 * the controller decides to use, as the stride already works at any speed.
 *
 * Going down is the same clip with the phase running backwards. It is not thrift: a
 * descent's contact points have to land on the **same** grid of rungs as the climb,
 * and a second clip would have to reproduce that grid — any divergence would show up
 * as a hand going through wood. With the phase driven by height, the contact is
 * identical by construction in both directions.
 */
export class ClimbClock {
  /** Where the cycle is, in [0, 1). Zero is the left foot taking a rung. */
  phase = 0;
  /** How much of the body the clip takes — rises on grabbing, falls on letting go. */
  weight = 0;

  /**
   * @param climbing whether the player is on the ladder this frame.
   * @param deltaY how far they climbed (positive) or descended (negative), in meters.
   */
  update(dt: number, climbing: boolean, deltaY: number): void {
    this.weight = damp(this.weight, climbing ? 1 : 0, BLEND_LAMBDA, dt);
    if (!climbing) return;
    // Standing still on the ladder the phase does not advance, and that is what we
    // want: the character freezes gripping exactly where they were, without sliding a
    // millimeter. A "gripping and breathing" clip would only work as an additive
    // layer; as a full pose, it would drag the hands to its own rung on the
    // transition.
    this.phase = (((this.phase + deltaY / CLIMB_CLIP.rise) % 1) + 1) % 1;
  }

  /**
   * The phase that puts the hands and the feet **on the rungs that exist**, for a
   * given foot height.
   *
   * Called once, on grabbing the ladder. From there on the alignment holds by itself,
   * because the phase and the height advance together.
   *
   * The arithmetic: in the clip, the rung taken at phase `p` sits `footRung - rise * p`
   * above the feet. For it to coincide with a real rung, that height plus the player's
   * has to land on the grid — which gives `p ≡ u / 2 (mod 1/2)`, with `u` the foot's
   * position measured in spacings. Two solutions are left, half a cycle apart: they
   * are the two legs, and either will do.
   */
  align(feetY: number, bottomY: number, spacing: number): void {
    const u = (feetY + CLIMB_CLIP.footRung - bottomY) / spacing;
    const fraction = ((u % 1) + 1) % 1;
    const candidate = fraction * 0.5;
    // Of the two, the one closest to the current phase: whoever lets go of the ladder
    // and grabs it again right afterwards does not change legs for no reason.
    const other = candidate + 0.5;
    const distance = (a: number, b: number): number => {
      const d = Math.abs(a - b) % 1;
      return Math.min(d, 1 - d);
    };
    this.phase = distance(candidate, this.phase) <= distance(other, this.phase)
      ? candidate
      : other;
  }

  reset(): void {
    this.phase = 0;
    this.weight = 0;
  }
}

/**
 * What the helm clip does, and what ties it to the wheel that is drawn.
 *
 * `step` is not an animator's choice: the wheel has **eight handles**, and eight
 * handles around a circle give a 45° step. Since the whole travel is `MAX_WHEEL` each
 * way, the wheel turns exactly once from stop to stop — the eight handles, once each.
 *
 * It is the cleanest marriage in the project: unlike the ladder, whose grid of rungs
 * exists on the ship and forces an alignment (`ClimbClock.align`), here the grid **is**
 * the wheel's angle itself. It is periodic from birth, and that is why the phase falls
 * right at any instant, with the rudder amidships or hard over.
 */
export const HELM_CLIP = { step: Math.PI / 4 } as const;

/**
 * The helm's clock: the same idea as the ladder, with hands on the wheel.
 *
 * The phase comes from the **wheel's angle**, and that is what pins the hand on top
 * of a handle that is drawn while it turns — at any `WHEEL_RATE`, as the stride works
 * at any speed. There is no accumulated state: the phase is a function of the angle,
 * so nothing has any way to drift over the course of a match.
 *
 * Turning to port is the same clip with the phase running backwards, for the same
 * reason going down the ladder is the climb in reverse: a port turn's contacts have
 * to land on the **same eight handles** as a starboard turn's, and a second clip would
 * have to reproduce that grid. The hand that was pulling starts pushing, which is
 * exactly what the helmsman does.
 */
export class HelmClock {
  /** Where the cycle is, in [0, 1). Zero is the hand taking a handle. */
  phase = 0;
  /** How much of the body the clip takes — rises on taking the helm, falls on letting go. */
  weight = 0;

  /**
   * @param atHelm whether the player has their hands on the wheel this frame.
   * @param wheelAngle the wheel's angle, in radians. See `Rudder.wheelAngle`.
   */
  update(dt: number, atHelm: boolean, wheelAngle: number): void {
    this.weight = damp(this.weight, atHelm ? 1 : 0, BLEND_LAMBDA, dt);
    if (!atHelm) return;
    // The double modulo is not superstition: in JS `-0.3 % 1` gives `-0.3`, and half
    // the travel lives at negative angles. A negative phase written into `.time` would
    // come out as a frame from the end of the clip — the hand would jump a whole
    // handle on crossing amidships, precisely where nobody would suspect it.
    this.phase = (((wheelAngle / HELM_CLIP.step) % 1) + 1) % 1;
  }

  reset(): void {
    this.phase = 0;
    this.weight = 0;
  }
}

/**
 * Duration of the plank-carrying cycle, in seconds.
 *
 * 72 frames at 30 fps, which is what `anim_carry.py` generated. It is the only
 * station clip whose duration has to be repeated here, and the reason is in the class
 * below.
 */
export const CARRY_CLIP = { duration: 2.4 } as const;

/**
 * The clock for the plank in hand: the only station that runs on **time**.
 *
 * The other three indexed clips in this folder read a quantity from the world — the
 * stride reads distance, the ladder reads height gained, the helm reads the wheel's
 * angle — and that is where the property of never disagreeing with the physics comes
 * from. Here there is no quantity to read: holding a plank has no natural period at
 * all, and tying the phase to the repair's progress would give a man who breathes
 * faster the closer he gets to finishing.
 *
 * So this is the exception, and it is of the same family as `Idle`: a breathing cycle
 * that runs on its own. What it still has in common with the others is the damped
 * weight — the plank does not appear in the hand in one frame, it is raised.
 */
export class CarryClock {
  /** Where the cycle is, in [0, 1). */
  phase = 0;
  /** How much of the body the clip takes. Rises on picking up the plank, falls on dropping it. */
  weight = 0;

  /** @param carrying whether the player has the plank in their hands this frame. */
  update(dt: number, carrying: boolean): void {
    this.weight = damp(this.weight, carrying ? 1 : 0, BLEND_LAMBDA, dt);
    // The phase only runs with the plank in hand, and it does **not** go back to zero
    // on dropping it. It is not thrift: whoever releases the button for an instant and
    // presses again would restart the cycle from the beginning, and the jump would show
    // up as a jolt in the breathing precisely when the player is looking at their own
    // hands.
    if (carrying) this.phase = (this.phase + dt / CARRY_CLIP.duration) % 1;
  }

  reset(): void {
    this.phase = 0;
    this.weight = 0;
  }
}

/**
 * What the stroke clip does. The numbers come from `anim_swim.py`, as the stride's
 * come from `anim_walk.py`, and they are not tunable here.
 *
 * `speed` is the gesture's **native** speed: `CYCLE_DISTANCE` of 1.32 m in
 * `CYCLE_FRAMES / FPS` = 1.0 s. It is not an animator's choice — it comes from the
 * hand's sweep (2.18 m with both arms) times the propulsive efficiency of a head-up
 * crawl (0.605), which is deliberately poor because the inclined torso drags. See the
 * header of `anim_swim.py`.
 *
 * The game swims at `SWIM_SPEED` = 1.4 m/s, so the phase runs 1.06 cycles per second
 * and the clip comes out 6% faster than it was animated. **There is no `timeScale`
 * written anywhere**: the phase is driven by distance, and the factor falls out of it
 * on its own — exactly the same arithmetic the walk already does, where a native 1.65
 * becomes the game's 2.8 (a factor of 1.70).
 */
export const SWIM_CLIP = { speed: 1.32, cycle: 1.0 } as const;

/**
 * Distance one stroke cycle covers in the water, in meters.
 *
 * ⚠️ **It is worth the same as `WALK_DISTANCE`, and that is measurement, not
 * borrowing.** While `Swim` did not exist in the GLB, what drew the water was the
 * walk and this number *was* its own, taken deliberately so that the real clip's
 * arrival would not change the legs' cadence. The clip arrived with a 1.32 m cycle on
 * its own, and the coincidence became the proof: the `tests/locomotion.ts` case that
 * measured the borrowing now measures the **handover**, and it is phase for phase the
 * same.
 */
export const SWIM_DISTANCE = SWIM_CLIP.speed * SWIM_CLIP.cycle;

/**
 * What the float clip has, and the number of its own the runtime decides not to use.
 *
 * `duration` is 210 frames at 30 fps: the smallest loop that closes 3 leg beats, 5 arm
 * sweeps and 2 breaths at the same time (210 = 2·3·5·7). Since there is no world
 * quantity to read — floating has no natural period — it is the only water clip that
 * runs on **time**. See `CarryClock`, which is the same exception.
 *
 * `sink` is the depth the clip was built at: the rig's origin (the plane of the
 * character's feet) goes 1.32 m below the waterline, which is where the clip puts its
 * `z = 0`. **The runtime does not use this number**, and the 12 cm difference from the
 * depth the physics simulates (`SWIM_SUBMERSION`, 1.44 m) is deliberate: see the note
 * there and the test case that pins it. It lives here so that divergence has an owner
 * and an alarm — touching the eye's framing without rereading that paragraph fails the
 * test.
 */
export const FLOAT_CLIP = { duration: 7, sink: 1.32 } as const;

/**
 * The water's clock: **two** phases, because the water has two clips.
 *
 * `phase` is the stroke and it advances with the **distance swum**, not with time,
 * for the usual reason — it is what makes the stroke a gesture of advance at any
 * speed, instead of a film running on top of a body that slides. `stroke` is the
 * equivalent of the stride's `moving`: above the movement threshold the body swims,
 * below it floats, and the two clips split by it.
 *
 * `floatPhase` is the float, and it runs on **time**. It is the same exception as
 * `CarryClock` and for the same reason written there: floating has no natural period
 * at all to read a phase from. Tying it to the wave would give a man who breathes
 * faster in a heavy sea; tying it to speed would give somebody who holds their breath
 * to stay still.
 *
 * ## Why the two live in the same clock
 *
 * Because they are **one state** of the body, and what separates them is a number that
 * is already here (`stroke`). A separate clock for the float would have to receive the
 * same `inWater`, be zeroed in the same `reset` and be passed at the same place in the
 * snapshot — three chances for the water's two halves to disagree about whether the
 * sailor is in it.
 *
 * ## Neither of the two goes back to zero on leaving the sea
 *
 * Like the ladder's phase and the plank's. Whoever falls in, grabs the ladder and
 * slips back does not restart the stroke or the breathing from the beginning — and
 * that restart's jolt would show up precisely on the frame the player is watching
 * their own hand come out of the water.
 */
export class SwimClock {
  /** Where the stroke is, in [0, 1). This one runs on distance. */
  phase = 0;
  /** Where the float is, in [0, 1). This one runs on time. */
  floatPhase = 0;
  /** How much of the body the water takes — rises on falling in, falls on leaving. */
  weight = 0;
  /** How much of the pose is stroke instead of float, in [0, 1]. */
  stroke = 0;
  /** Horizontal speed in the water on the last frame, in m/s. Diagnostics. */
  speed = 0;

  /**
   * @param inWater whether the body is at sea this frame.
   * @param speed horizontal speed in the water, in m/s.
   */
  update(dt: number, inWater: boolean, speed: number): void {
    this.speed = speed;
    const swimming = inWater && speed > MOVE_THRESHOLD;
    this.weight = damp(this.weight, inWater ? 1 : 0, BLEND_LAMBDA, dt);
    this.stroke = damp(this.stroke, swimming ? 1 : 0, BLEND_LAMBDA, dt);
    // Floating, the phase freezes, as on the ladder: the body stays where the last
    // stroke left it instead of going on paddling in place.
    if (swimming) this.phase = (this.phase + (speed * dt) / SWIM_DISTANCE) % 1;
    // The float runs with the body in the water, swimming or not: it is the breathing
    // underneath, and `Swim` on top of it only covers it while there is a stroke.
    if (inWater) this.floatPhase = (this.floatPhase + dt / FLOAT_CLIP.duration) % 1;
  }

  reset(): void {
    this.phase = 0;
    this.floatPhase = 0;
    this.weight = 0;
    this.stroke = 0;
    this.speed = 0;
  }
}

export class GaitClock {
  /** Where the stride is, in [0, 1). Zero is the left foot on the ground. */
  phase = 0;
  /** How much of the blend is running. */
  runBlend = 0;
  /** How much of the locomotion applies — falls to zero when they stop. */
  moving = 0;
  /** Horizontal speed on the last frame, in m/s. */
  speed = 0;

  update(dt: number, speed: number, grounded: boolean): void {
    this.speed = speed;
    const walking = grounded && speed > MOVE_THRESHOLD;

    const target = clamp01((speed - WALK_CLIP.speed) / (RUN_CLIP.speed - WALK_CLIP.speed));
    this.runBlend = damp(this.runBlend, target, BLEND_LAMBDA, dt);
    this.moving = damp(this.moving, walking ? 1 : 0, BLEND_LAMBDA, dt);

    if (!walking) return;

    // The phase advances with the **distance covered**, not with time: that is what
    // keeps the foot still on the ground during stance, at any speed.
    this.phase = (this.phase + (speed * dt) / this.distance) % 1;
  }

  /** Distance the current blend covers in one cycle, in meters. */
  get distance(): number {
    return lerp(WALK_DISTANCE, RUN_DISTANCE, this.runBlend);
  }

  /** Duration of one cycle at the current speed, in seconds. */
  get cycleSeconds(): number {
    return this.distance / Math.max(this.speed, MOVE_THRESHOLD);
  }

  /**
   * The body's height within the cycle, from -1 (lowest) to 1 (highest).
   *
   * It is the same curve Blender uses to lift the hips, including the phase inversion
   * between walking and running: walking, the body is lowest at contact, with the legs
   * apart; running, in the middle of stance, with the leg absorbing the weight. That is
   * why `bouncePhase` is interpolated too.
   */
  get bounce(): number {
    const offset = lerp(WALK_CLIP.bouncePhase, RUN_CLIP.bouncePhase, this.runBlend);
    return -Math.cos(4 * Math.PI * (this.phase - offset));
  }

  /**
   * The same height, **in meters** — how far the clip actually lifts the body.
   *
   * The amplitude is interpolated by the blend for the same reason the phase is: the
   * body on screen is the weighted average of the two clips, so the curve the camera
   * follows has to be the weighted average of the two amplitudes. While the camera had
   * a number of its own, it rose 4.2 cm where the body rose 2.1 — and the difference
   * showed up as the torso sinking and surfacing with every step, for whoever is
   * inside it.
   */
  get bounceMeters(): number {
    return this.bounce * lerp(WALK_CLIP.bounceAmplitude, RUN_CLIP.bounceAmplitude, this.runBlend);
  }

  reset(): void {
    this.phase = 0;
    this.runBlend = 0;
    this.moving = 0;
    this.speed = 0;
  }
}

/**
 * The jump's clock: two clips, and neither of them played as a film.
 *
 * The jump here is instantaneous — on the same frame the key goes down, the velocity
 * is already `JUMP_SPEED` and the feet have already left the deck. There is no frame
 * at all between the intent and the takeoff, and that is why there is **no wind-up
 * clip**: anticipation is a loan of time this engine does not take out. The impulse
 * that does not fit before shows up afterwards, in the leg that finishes extending.
 *
 * The air clip is **read by the vertical velocity**, not played by the clock: the
 * phase comes from `velocity.y`, so the pose has no way to disagree with the physics.
 * The hard case falls out for free — a clip of fixed duration would land in the middle
 * of the apex on a little hop and go round three times on a fall from the mast, while
 * this one saturates on its own and spends the whole fall on the final frame, legs
 * already extended to take the ground.
 *
 * It sits beside `GaitClock` and for the same reason: the body is a file that loads
 * asynchronously and can fail, and what knows the physical state is the controller.
 */
export class JumpClock {
  /** Weight of the air clip, in [0, 1]. */
  air = 0;
  /** Weight of the landing clip, in [0, 1]. */
  land = 0;
  /** Where the body is on the parabola: 0 is takeoff, 0.5 the apex, 1 the fall. */
  airPhase = 0;
  /** Where the landing is, in [0, 1]. This one does advance with time. */
  landPhase = 1;
  /** Force of the landing in progress, in [0, 1]. */
  impact = 0;

  /**
   * Fall speed from the last frame in the air, in m/s and positive while falling.
   *
   * Saved because on the frame of contact it no longer exists: `resolveGround` zeroes
   * `velocity.y` and switches `grounded` on before the clock is fed. Without this copy
   * every landing would have the same force — zero.
   */
  private fallSpeed = 0;
  private airborne = false;

  update(dt: number, verticalSpeed: number, grounded: boolean): void {
    if (!grounded) {
      this.airborne = true;
      this.fallSpeed = Math.max(-verticalSpeed, 0);

      this.airPhase = clamp01(0.5 * (1 - verticalSpeed / JUMP_SPEED));
      this.air = damp(this.air, 1, AIR_LAMBDA, dt);
      // Jumping again cancels a landing that was still playing: they are states that
      // cannot overlap, and letting them add would push the total weight past 1.
      this.land = 0;
      this.landPhase = 1;
      return;
    }

    if (this.airborne) {
      this.airborne = false;
      this.impact = clamp01(
        (this.fallSpeed - LAND_MIN_SPEED) / (LAND_FULL_SPEED - LAND_MIN_SPEED),
      );
      this.landPhase = 0;
      // A dry change, with no blend: the air's last pose is the leg extended waiting
      // for the deck, which is exactly where the landing starts. Going through an
      // average of the two would only blur the one frame the player notices.
      this.air = 0;
    }

    this.air = damp(this.air, 0, AIR_LAMBDA, dt);

    if (this.landPhase >= 1) {
      this.land = 0;
      return;
    }

    this.landPhase = Math.min(this.landPhase + dt / LAND_CLIP.cycle, 1);
    // Full weight during the compression and a smooth exit afterwards. The clip
    // already ends in the neutral pose, but whoever walks off in the middle of the
    // landing needs the remainder to fade out instead of being cut on the frame.
    const fade = this.landPhase <= LAND_HOLD
      ? 1
      : 1 - smoothstep((this.landPhase - LAND_HOLD) / (1 - LAND_HOLD));
    this.land = this.impact * fade;
  }

  /**
   * Fades the jump out without firing a landing.
   *
   * It is what you want when the feet leave the ground for a reason other than
   * physics: grabbing the mast ladder, taking the helm. Feeding `update` with
   * `grounded` in those cases would make the character land in mid-air, hanging off a
   * ladder nine meters above the deck.
   */
  settle(dt: number): void {
    this.airborne = false;
    this.fallSpeed = 0;
    this.landPhase = 1;
    this.air = damp(this.air, 0, AIR_LAMBDA, dt);
    this.land = damp(this.land, 0, AIR_LAMBDA, dt);
  }

  reset(): void {
    this.air = 0;
    this.land = 0;
    this.airPhase = 0;
    this.landPhase = 1;
    this.impact = 0;
    this.fallSpeed = 0;
    this.airborne = false;
  }
}
