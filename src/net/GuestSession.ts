/**
 * The side that doesn't simulate.
 *
 * The guest **integrates no hull at all**: no buoyancy, no sails, no rudder, no
 * contact. It receives the pose ready-made, interpolates between two snapshots and
 * draws. What it simulates locally is only its own body on the deck — and that is
 * what makes this model work without rollback.
 *
 * ## Why the body can be predicted without predicting the ship
 *
 * Because `PlayerController` lives in **ship-local coordinates**. The deck is a
 * still floor: walking on it doesn't depend on waves, on sails or on heading. The
 * hull is just a frame of reference that arrives over the network, and the body
 * walks on top of it none the wiser. It's the architectural decision this whole
 * file cashes in on, and it was made long before there was a network — because of
 * the camera.
 *
 * ## Three clocks
 *
 * - **The host's** (`hostTick`), which arrives in the snapshots. It's the truth.
 * - **The render clock**, `hostTick − INTERP_DELAY`. It lags on purpose: it's the
 *   delay that provides two snapshots to interpolate between. Without it the
 *   client would always be extrapolating, and extrapolation on a bad connection
 *   is what produces a ship that shakes and then corrects.
 * - **The prediction clock**, `hostTick + lead`. It's where the local body runs,
 *   ahead, so that input reaches the host at the instant it needs it.
 *
 * The third is the only adjustable one, and it adjusts itself via `bufferDepth`.
 */

import * as THREE from 'three';
import { FIXED_TIMESTEP } from '../core/Engine';
import { wrapAngle } from '../core/MathUtils';
import type { InputFrame } from '../core/InputFrame';
import type { Match } from '../game/Match';
import type { PlayerStation } from '../player/PlayerController';
import type { Ship } from '../ship/Ship';
import { BALL_MASS, BALL_RADIUS, MUZZLE_SPEED } from '../ship/Cannon';
import { breachInflow } from '../ship/ShipDamage';
import { encodeInput } from './snapshotCodec';
import { InputOutbox } from './InputOutbox';
import { advanceHostEstimate, correctHostEstimate, interpolationFactor } from './renderClock';
import { createWorldState, decodeSnapshot, type WorldState } from './WorldState';
import type { RoomClient } from './RoomClient';

/**
 * Steps between snapshots. It's `HostSession`'s `SNAPSHOT_EVERY`, seen from here.
 *
 * Duplicated on purpose: the side that simulates decides the rate and the side
 * that draws needs to know it in order to lag by exactly the right amount. If the
 * rate ever changes, both change.
 */
const SNAPSHOT_INTERVAL = 4;

/**
 * Render delay, in steps.
 *
 * ⚠️ **Exactly one interval, and no more.** It was six — one and a half intervals,
 * meant as headroom for jitter — and the result was the opposite of the intent:
 * with two snapshots in hand, the older one is `SNAPSHOT_INTERVAL` steps behind
 * the newer, so a target six steps back falls **before the first of the two**. The
 * interpolation factor sat clamped at zero, the pose stayed frozen on the previous
 * snapshot and only jumped when the next one arrived. Which means: the guest's
 * entire world — its hull, the deck under its feet and the camera along with them
 * — moved at fifteen frames per second, in lurches, in a game that drew at a
 * hundred and forty-four.
 *
 * With exactly one interval, the render clock enters `from` the instant the pair
 * is assembled and reaches `to` right as the next pair arrives. Jitter headroom no
 * longer comes from delaying the render: it comes from the clamp at 1, which
 * **freezes** on the last known pose while the late packet hasn't arrived, instead
 * of extrapolating. Freezing for twenty milliseconds isn't visible; extrapolating
 * is.
 */
const INTERP_DELAY = SNAPSHOT_INTERVAL;

// The render clock arithmetic lives in `renderClock`, where it can be proven
// without dragging Three.js and `Match` into a test.

/** One input batch every two steps: 30 messages per second. */
const SEND_EVERY = 2;

/**
 * Queue floor to keep at the host, in frames.
 *
 * One frame is the minimum cushion: with it, a packet late by up to a whole step
 * still finds something to consume. Two would be safer and would cost an extra
 * 17 ms of command latency all the time — and the safety they'd buy is already
 * bought for free by the batch's redundancy, which resends every frame twice.
 * See `adjustLead`.
 */
const DEPTH_TARGET = 1;

/**
 * Bounds on the lead, in steps.
 *
 * The floor isn't zero because a null lead means stamping the command with the
 * tick the host has already consumed — it would be born discarded. The ceiling
 * exists because lead is command latency: twenty-four steps are 400 ms between the
 * hand and the deck, and past that the problem is no longer sync, it's the
 * connection.
 */
const LEAD_MIN = 3;
const LEAD_MAX = 24;

/** Fraction of the rudder deviation corrected per snapshot. See `applyShipParts`. */
const WHEEL_CATCHUP = 0.08;

/** Fraction of the aim deviation corrected per snapshot. See `correctOperatedAim`. */
const AIM_CATCHUP = 0.12;

/**
 * Interval between lead adjustments, in steps. Half a second.
 *
 * It was two seconds, and that served while the lead still had to **discover** the
 * latency by climbing one step at a time. Now it is born measured (see
 * `estimateLead`) and this adjustment only chases drift, so it can be more frequent
 * without getting restless — every change of lead is a small hop in the player's
 * clock.
 */
const LEAD_ADJUST_EVERY = 30;

/**
 * Slack on the local clock before correcting, in steps.
 *
 * Two steps are 33 ms. Below that the "divergence" is just the snapshot having been
 * written between two steps on this side, and correcting would be chasing your own
 * tail.
 */
const CLOCK_TOLERANCE = 2;

/** Divergence that stops being drift and becomes something else. Half a second. */
const CLOCK_SNAP = 30;

/**
 * Body prediction error, in meters, and what to do with each band.
 *
 * Below the first it's floating-point noise and a one-step misalignment —
 * correcting would be shaking for nothing. Between the two, the error is real but
 * small: the body takes the host's position and the **render** absorbs the
 * difference over two tenths of a second, so nobody sees the jump. Above the second
 * it isn't error, it's a legitimate teleport (took a station, grabbed the ladder,
 * respawned), and then going straight there is the right thing.
 */
const ERROR_IGNORE = 0.08;
const ERROR_SNAP = 1.5;

const _position = new THREE.Vector3();
const _quaternion = new THREE.Quaternion();
/** The authoritative body pose brought to world space. See `authoritativePosition`. */
const _authority = new THREE.Vector3();

/**
 * A stored prediction: **the quantity the body owned** at that step.
 *
 * ⚠️ It isn't always the same quantity, and that's the reason this class exists. On
 * the deck the body owns the **local** position — it walks on a still floor and the
 * hull never enters the arithmetic. In the water it owns the **world** one, and
 * `local` is derived from it by the hull's pose. Always storing `local` would make
 * reconciliation compare, in the water case, two computations made with different
 * hull poses — see `GuestSession.reconcile`.
 */
interface PredictedStep {
  readonly position: THREE.Vector3;
  /** `true` when `position` is in world space. */
  inWater: boolean;
}

export class GuestSession {
  /**
   * The two snapshots the frame is drawn between.
   *
   * They aren't `readonly` because they swap roles on every arrival: the "to"
   * becomes the "from", by swapping references. Copying the world field by field
   * fifteen times per second would be work for nothing.
   */
  private from = createWorldState();
  private to = createWorldState();
  /**
   * The third one, where every snapshot is read before it counts.
   *
   * It exists because the decision to accept a snapshot depends on what comes
   * inside it: the tick is only known after decoding. Decoding straight onto
   * `from` — which is what used to happen — meant a packet arriving out of order
   * destroyed the base of the interpolation **before** being refused, and the ship
   * started being drawn between an old pose and the current one. A third buffer
   * costs a few kilobytes once in a lifetime and closes the door for good.
   */
  private spare = createWorldState();
  private hasFrom = false;
  private hasTo = false;

  /** The host's clock, as the guest knows it. Only moves when a snapshot arrives. */
  hostTick = 0;

  /**
   * The local clock, which moves **one per step**.
   *
   * ⚠️ This cannot be `hostTick + lead` computed on the spot, and the reason is the
   * most expensive bug this file has ever had: `hostTick` only advances when a
   * snapshot arrives, and a snapshot arrives every four steps. Derived from it, the
   * command stamp sat still for three steps and jumped four — and since the host
   * discards a repeated command (the batch's redundancy depends on that), **three
   * out of every four commands were thrown away**. The symptom was `starves` in
   * the thousands on a perfect connection.
   *
   * Here it moves on its own and the snapshot only **corrects** it, one step at a
   * time. See `syncClock`.
   */
  private localTick = 0;

  /**
   * Where the host's clock is thought to be **now**, in fractional steps.
   *
   * It moves on its own, one per step, and the snapshot corrects only its phase.
   * The render clock is this estimate minus the interpolation delay — and it's by
   * being derived from a ramp that it moves smoothly. See `renderClock.ts`, which
   * tells the story of the previous version and why it shook.
   */
  private hostEstimate = 0;

  /** `true` once the first snapshot has aligned the two clocks. */
  private clockStarted = false;

  /** How far ahead of the host the local body runs, in steps. */
  lead = 4;
  /** Depth of the host's queue, as it came in the snapshot. Telemetry. */
  depth = 0;
  /** Prediction error from the last snapshot, in meters. Telemetry. */
  predictionError = 0;

  /**
   * The view offset **doesn't live here any more**, and the change is a fix.
   *
   * It was a private vector on this class, with a public getter documented as "the
   * body's view offset, which the render adds to the position" — and nobody, in any
   * file of the project, read that getter. The middle band of reconciliation was
   * left with no smoothing at all. Now it is `PlayerController.viewOffset`, which
   * is where the frame's pose is assembled and where it actually reaches the
   * screen; see the full note there.
   */
  private get viewOffset(): THREE.Vector3 {
    return this.match.crew[0].controller.viewOffset;
  }

  /** History of the predicted body, indexed by tick, for reconciling. */
  private readonly history = new Map<number, PredictedStep>();
  private readonly historyPool: PredictedStep[] = [];

  /**
   * The window of commands that leaves here, with the stitching that keeps it whole.
   *
   * See `InputOutbox` — in short, every correction of the prediction clock skips or
   * repeats a stamp, and the host discards both. Without the stitching, each
   * correction cost the player one command.
   */
  private readonly outbox = new InputOutbox();

  private leadTimer = 0;
  /**
   * The emptiest queue the host has reported since the last lead adjustment.
   *
   * It's the **minimum**, and not the last value, because it's the minimum that
   * says whether there is slack to spare: a queue that swings between zero and
   * four has no fat at all to trim, even if the snapshot you looked at showed four.
   */
  private minDepthSinceAdjust = Number.POSITIVE_INFINITY;
  /** Steps the host spent with no command since the last lead adjustment. */
  private starvedSinceAdjust = 0;

  /**
   * The opponent's pose at this instant, built once and rewritten every step.
   *
   * A single object, and not a fresh `CrewState` per frame: this runs sixty times
   * per second inside the render frame's budget. See the allocation note in
   * `snapshotCodec`.
   */
  private readonly remotePose = {
    local: new THREE.Vector3(),
    yaw: 0,
    pitch: 0,
    station: 'deck' as PlayerStation,
    cannonIndex: -1,
    grounded: true,
    onLadder: false,
    atCapstan: false,
    patching: false,
    inWater: false,
  };

  /** Step where the station changed by local prediction, awaiting the host's receipt. */
  private stationPredictedAt = -1;
  private lastStation: 'deck' | 'helm' | 'cannon' = 'deck';
  private lastCannonIndex = -1;
  private lastOnLadder = false;
  private lastAtCapstan = false;
  private lastInWater = false;

  /** `true` when the host has warned that its window lost focus. */
  stalled = false;

  constructor(
    private readonly match: Match,
    private readonly client: RoomClient,
    /** Which of the two hulls is mine. Decided by the room. */
    private readonly slot: 0 | 1,
  ) {}

  /** The opponent's index **on the wire**. See the inversion note in `applyWorld`. */
  private get remote(): 0 | 1 {
    return this.slot === 0 ? 1 : 0;
  }

  /** The gun the local player is serving, or `-1`. */
  private get operatedCannon(): number {
    const mine = this.match.crew[0].controller;
    return mine.station === 'cannon' ? mine.cannonIndex : -1;
  }

  get ready(): boolean {
    return this.hasTo;
  }

  reset(): void {
    this.hasFrom = false;
    this.hasTo = false;
    this.hostTick = 0;
    this.localTick = 0;
    this.hostEstimate = 0;
    this.clockStarted = false;
    this.minDepthSinceAdjust = Number.POSITIVE_INFINITY;
    this.starvedSinceAdjust = 0;
    this.stationPredictedAt = -1;
    this.lead = 4;
    this.viewOffset.set(0, 0, 0);
    this.releaseHistory(Number.POSITIVE_INFINITY);
    this.outbox.reset();
    this.stalled = false;
  }

  /** A snapshot has arrived. */
  onFrame(frame: ArrayBuffer): void {
    // Read into the spare, always. See the note on `spare`.
    const header = decodeSnapshot(frame, this.spare);
    if (!header) return;

    // Out of order or repeated: the network delivered an old packet after a new
    // one. Applying it would make the world move backwards.
    if (this.hasTo && header.tick <= this.to.tick) return;

    // A rotation of three, by swapping references: copying the world field by
    // field fifteen times per second would be work for nothing. What leaves
    // circulation is the old `from` — or the old `to`, while there is no pair yet.
    const freed = this.hasTo ? this.from : this.to;
    if (this.hasTo) {
      this.from = this.to;
      this.hasFrom = true;
    }
    this.to = this.spare;
    this.spare = freed;

    this.hasTo = true;
    this.hostTick = this.to.tick;
    this.depth = this.to.bufferDepth;
    if (this.depth < this.minDepthSinceAdjust) this.minDepthSinceAdjust = this.depth;
    if (this.to.starved > 0) this.starvedSinceAdjust += this.to.starved;
    this.stalled = false;

    // First snapshot: the lead is born measured, and both clocks are born aligned
    // to it. See `estimateLead` and `advanceRenderClock`.
    //
    // ⚠️ The guard is a flag, and **not** `localTick === 0`, which is what used to
    // be here and was never true: `predictionTick` increments the clock every step
    // from the moment the match starts, and the first snapshot arrives dozens of
    // steps later. It was the branch below that always ran, and the effect was the
    // lead being born at the factory value and having to **discover** the latency
    // by climbing one step at a time — which is exactly the work `estimateLead`
    // exists to make unnecessary.
    if (!this.clockStarted) {
      this.clockStarted = true;
      this.lead = this.estimateLead();
      this.localTick = this.hostTick + this.lead;
      this.hostEstimate = this.hostTick;
    } else {
      this.syncClock();
      // The estimate's phase is corrected **here**, and only here: it's the only
      // moment when there is new information about where the host is.
      this.hostEstimate = correctHostEstimate(this.hostEstimate, this.hostTick);
    }

    this.reconcile();
    this.correctOperatedAim();
    // The host's events become this step's events: smoke, boom, splinters and the
    // cannonballs are all born here. See `MatchEvents` — one path, two roles.
    //
    // The `ship` field is inverted too, like everything that comes off the wire:
    // without it, the boom of my own cannon would come out at long-range volume
    // and the splinters off my hull would end up on his.
    for (const event of this.to.events) {
      if ('ship' in event) event.ship = event.ship === this.slot ? 0 : 1;
      if (event.kind === 'shot') this.spawnGhostBall(event.position, event.direction);
      this.match.events.push(event);
    }
    this.to.events.length = 0;
  }

  /**
   * Pulls the aim of the gun **I** serve back toward the angle the host has for it.
   *
   * ⚠️ **Without this, the cannon's aim is the only thing in the game that diverges
   * forever.** It is accumulate-and-clamp over the same deltas on both sides, which
   * agrees perfectly as long as no command is lost — and commands do get lost. One
   * was enough, and from then on the barrel I see pointed at his hull isn't the
   * barrel the ball leaves from: I aim, I fire, the ball is born on the other side
   * at another angle and misses wide. It's the most frustrating read a duel can
   * give, because nothing on screen suggests the problem wasn't the aim.
   *
   * It's the same remedy as the helm wheel (see `WHEEL_CATCHUP`) and it runs at the
   * same rhythm at which new information arrives: **once per snapshot**, and not
   * once per step. Here the difference matters more than on the wheel, because this
   * angle is under the hand of whoever is aiming right now — pulling it sixty times
   * per second would be dragging the gun against the player himself.
   *
   * The gain is small on purpose: the value that arrives describes half a round
   * trip ago. At twelve percent per snapshot, an error closes in about half a
   * second and is imperceptible with the barrel in motion.
   */
  private correctOperatedAim(): void {
    const index = this.operatedCannon;
    if (index < 0) return;
    const cannon = this.match.ships[0]!.cannons[index];
    const target = this.to.ships[this.slot]!.cannons[index];
    if (!cannon || !target) return;

    cannon.traverse += (target.traverse - cannon.traverse) * AIM_CATCHUP;
    cannon.elevation += (target.elevation - cannon.elevation) * AIM_CATCHUP;
  }

  /**
   * Puts in the air the cannonball of a shot the host announced.
   *
   * The velocity is reconstructed as `direction × muzzle speed`, and doesn't come
   * over the wire. The approximation is good because the muzzle is two orders of
   * magnitude faster than the ship: a sloop at 5 m/s against 95 m/s of powder gives
   * less than 3% error in magnitude, and the direction — which is what decides
   * where the ball **appears** to fall — comes through exact. Sending the full
   * vector would cost six bytes per shot to fix what nobody can see.
   */
  private spawnGhostBall(position: THREE.Vector3, direction: THREE.Vector3): void {
    _position.copy(direction).multiplyScalar(MUZZLE_SPEED);
    this.match.cannonballs.spawnGhost(position, _position, BALL_MASS, BALL_RADIUS);
  }

  /** The host warned that its window is in the background. */
  markStalled(): void {
    this.stalled = true;
  }

  /**
   * The guest's step.
   *
   * @param frame the local input for this step, already stamped with the prediction
   * tick.
   */
  fixedUpdate(frame: InputFrame): void {
    if (!this.hasTo) return;

    // Before `applyWorld`, which is what writes the authority over the top. See
    // `trackStationPrediction`.
    this.trackStationPrediction(frame.tick);
    // One per step, always. All the correction lives in the snapshot's arrival —
    // it's what keeps the world's speed constant between two packets.
    this.hostEstimate = advanceHostEstimate(this.hostEstimate);
    this.applyWorld();
    this.rememberStation();
    this.rememberPrediction(frame.tick);
    this.queueOutgoing(frame);
    this.adjustLead();
  }

  /**
   * The instant being drawn, in fractional steps.
   *
   * One snapshot behind the host estimate: it's where the pose already has the two
   * points to interpolate between.
   */
  private get renderClock(): number {
    return this.hostEstimate - INTERP_DELAY;
  }

  /**
   * The step the local body runs on, and the one the command is stamped with.
   *
   * It advances **here**, once per call, because it is called once per step. See
   * `localTick` for why it is not derived from the host's clock.
   */
  predictionTick(): number {
    return ++this.localTick;
  }

  /**
   * Aligns the local clock to the host's, without a jolt.
   *
   * The target is `hostTick + lead`: a command stamped there arrives just before it
   * is needed. Small divergence is corrected **one step per snapshot** — the player
   * feels it as the world going a shade slower or faster, which is imperceptible.
   * Large divergence is not drift, it is something else (the tab slept, the network
   * vanished for seconds), and then jumping is right: catching up one at a time would
   * take minutes.
   */
  private syncClock(): void {
    const target = this.hostTick + this.lead;
    const drift = target - this.localTick;
    if (drift === 0) return;
    if (Math.abs(drift) > CLOCK_SNAP) {
      this.localTick = target;
      return;
    }
    if (Math.abs(drift) > CLOCK_TOLERANCE) this.localTick += Math.sign(drift);
  }

  /**
   * Decays the visual offset. Runs on the frame, with the real `dt`.
   *
   * The `offset` getter that used to sit beside this **has been removed**: it was the
   * loose end of a piece that was never wired up, and keeping it would publish again
   * a vector nobody reads. What adds the offset to the pose now is
   * `PlayerController.syncView`.
   */
  decayOffset(dt: number): void {
    this.match.crew[0].controller.decayViewOffset(dt);
  }

  // -- application ---------------------------------------------------------------

  /**
   * Writes the render instant's pose into the `Match`.
   *
   * The trick that keeps `syncModel(alpha)` working without a line of change: on
   * every step, the current pose becomes the "previous" one and the interpolated one
   * becomes the "current". `ShipBody` already knows how to interpolate between the
   * two — it has done so since before there was any network, so the 144 Hz screen
   * does not see the 60 Hz simulation.
   */
  private applyWorld(): void {
    // No pair yet: there is only one pose, and it is the current one.
    const t = this.hasFrom
      ? interpolationFactor(this.renderClock, this.from.tick, this.to.tick)
      : 1;

    for (let local = 0; local < 2; local++) {
      // ⚠️ **The indices invert here, and it is the most important line in the
      // file.**
      //
      // On the wire, index 0 is always the simulating side's ship. Locally, index 0
      // is always "mine" — it is what makes the camera, the HUD, the body and the
      // audio work without knowing there is a network. Translating on the way in
      // keeps both worlds coherent and leaves the rest of the game alone; not
      // translating would give a guest looking through the opponent's eyes, and it
      // would take hours to work out why.
      const net = local === 0 ? this.slot : this.remote;
      const ship = this.match.ships[local]!;
      const to = this.to.ships[net]!;
      const from = this.hasFrom ? this.from.ships[net]! : to;

      const { body } = ship;
      body.previousCom.copy(body.comPosition);
      body.previousOrientation.copy(body.orientation);

      body.comPosition.lerpVectors(from.position, to.position, t);
      _quaternion.copy(from.orientation).slerp(to.orientation, t);
      body.orientation.copy(_quaternion);
      body.velocity.lerpVectors(from.velocity, to.velocity, t);
      body.angularVelocity.lerpVectors(from.angularVelocity, to.angularVelocity, t);

      this.applyShipParts(ship, from, to, t, local === 0);
    }

    // The sea is written, not advanced: adding `dt` sixty times a second for ten
    // minutes would drive the two sides' sea clocks apart through floating-point
    // accumulation, and the hull would float on a wave the other one cannot see.
    const waves = this.match.environment.waveField;
    waves.time = this.from.waveTime + (this.to.waveTime - this.from.waveTime) * t;
    waves.windDirection = this.to.windDirection;
    waves.windStrength = this.to.windStrength;
    // ⚠️ **And the background swell's heading with it**, which is what was missing
    // and what had the two players sailing different seas. What moves it is
    // `WaveField.followWind`, and `followWind` lives in the simulating side's step:
    // on this side it stayed frozen at the factory value while on the other it turned
    // 2% per second toward the wind. The spectrum's two long waves compose their
    // direction with it — and they are the ones that lift the hull.
    waves.swellDirection = this.to.swellDirection;
    waves.syncUniforms();

    this.applySky();
    this.applyCrew(t);
  }

  /**
   * The sky and the weather, written as they arrived.
   *
   * **Without interpolating**, and that is a choice, not an oversight: 67 ms pass
   * between two snapshots, and in that time the sun of a twelve-minute day moves
   * three hundredths of a degree. Interpolating that would cost handling the midnight
   * wrap (0.99 → 0.01, which interpolated gives a whole day backwards in one step) to
   * gain exactly nothing anybody can see.
   */
  private applySky(): void {
    const sky = this.to.sky;
    const environment = this.match.environment;

    environment.dayNight.timeOfDay = sky.timeOfDay;
    environment.weather.applyRemote({
      current: sky.current,
      target: sky.target,
      baseWind: sky.baseWind,
      clouds: sky.clouds,
      rain: sky.rain,
      visibility: sky.visibility,
      flash: sky.flash,
      // Wind and heading travel as properties of the sea, because it is the sea
      // that consumes them; the weather gets them back only so the HUD has something
      // to show.
      wind: this.to.windStrength,
      direction: this.to.windDirection,
    });
    environment.fixedUpdateRemote();
  }

  private applyShipParts(
    ship: Ship,
    from: WorldState['ships'][0],
    to: WorldState['ships'][0],
    t: number,
    mine: boolean,
  ): void {
    ship.rudder.previousWheelAngle = ship.rudder.wheelAngle;
    ship.rudder.previousRudderAngle = ship.rudder.rudderAngle;

    if (mine) {
      // **My** wheel turns here, on the same step the command leaves my hand — what
      // integrates it is `Ship.fixedUpdateRemote`, and without that call it did not
      // turn at all. This is what takes away the feeling of a jammed helm: the ship
      // responding later is not latency, it is mass, and the player reads it as mass.
      //
      // But it is **also** nudged gently toward the host's angle, and the reason is
      // the same one that forced the gaze to travel absolute: both sides reach the
      // angle by adding increments, and one lost command leaves the two angles
      // different **forever**, with nothing to bring them back together. Here the
      // drift costs less than on the gaze — the wheel hits the stop and comes back
      // amidships several times per fight, and each of those resynchronizes on its
      // own — but "less" is not "nothing" in a ten-minute duel.
      //
      // The gain is deliberately small. The value arriving describes the past of half
      // a round trip ago; pulling hard toward it would be dragging the wheel against
      // the hand of whoever is turning it now. At eight percent per snapshot, an
      // error closes in about a second of a still wheel and is imperceptible with the
      // wheel in motion.
      ship.rudder.setWheel(
        ship.rudder.wheelAngle + (to.wheelAngle - ship.rudder.wheelAngle) * WHEEL_CATCHUP,
      );
    } else {
      ship.rudder.setWheel(from.wheelAngle + (to.wheelAngle - from.wheelAngle) * t);
    }

    ship.cannonballs = to.cannonballs;
    ship.planks = to.planks;
    ship.anchor.state = to.anchorState;
    ship.anchor.deploy = to.anchorDeploy;

    for (let i = 0; i < ship.cannons.length; i++) {
      const cannon = ship.cannons[i]!;
      const target = to.cannons[i]!;
      const previous = from.cannons[i]!;
      cannon.beginStep();
      // The gun **I** am operating is not overwritten every step: the aim responds
      // to my mouse now, and a barrel that jumps half a degree fifteen times a second
      // is impossible to point. What brings it back toward the truth is
      // `correctOperatedAim`, once per snapshot and gently.
      const operatedByMe = mine && this.operatedCannon === i;
      if (!operatedByMe) {
        cannon.traverse = previous.traverse + (target.traverse - previous.traverse) * t;
        cannon.elevation = previous.elevation + (target.elevation - previous.elevation) * t;
      }
      cannon.state = target.state;
      cannon.loadProgress = target.loadProgress;
      cannon.recoil = previous.recoil + (target.recoil - previous.recoil) * t;
    }

    // Damage is always authoritative: there is nothing the client can predict about
    // a ball the other one fired.
    ship.damage.floodVolume = to.floodFraction * ship.damage.holdVolume;
    ship.damage.sinkTime = to.sinkTime;
    if (to.breaches) this.applyBreaches(ship, to.breaches, to.patches);
    // Even when the list has not changed, the jet does: the wave moved and the hull
    // heeled. See `refreshBreachInflow`.
    else if (ship.damage.breaches.length > 0) this.refreshBreachInflow(ship);

    // ⚠️ **And the water sheet is solved here, every step.**
    //
    // The volume arrives ready on the line above and always did — the HUD climbed,
    // the hull sat deeper, all correct. What was missing was converting that volume
    // into the **plane** the render reads, and what did that conversion was
    // `ShipDamage.fixedUpdate`, which is the simulating side's path. On this side the
    // plane stayed at `-Infinity` forever, and `DamageView` hides the water when it
    // is not finite: the player went below with a holed hull and found a dry floor.
    // "I opened a breach and no water comes in" is exactly this.
    //
    // Every step, and not only when the list changes, because the plane depends on
    // the heel — and the heel changes sixty times a second.
    ship.damage.solveWaterPlane(ship.body);
  }

  private applyBreaches(
    ship: Ship,
    incoming: NonNullable<WorldState['ships'][0]['breaches']>,
    patches: WorldState['ships'][0]['patches'],
  ): void {
    const { breaches } = ship.damage;
    breaches.length = 0;
    for (const source of incoming) {
      breaches.push({
        id: source.id,
        local: source.local.clone(),
        normal: source.normal.clone(),
        area: source.area,
        repair: source.repair,
        // The inflow does **not** come over the wire, and does not need to: it is a
        // function of the hull's pose and of the sea, and the guest has both.
        // Computing it here costs one square root per breach and is what makes the
        // jet exist on this side — before, this field went in zeroed and the guest's
        // hold stayed dry of visible water while it really filled, which made the
        // breach look decorative to precisely the person who had to run and patch it.
        inflow: 0,
      });
    }
    this.refreshBreachInflow(ship);

    // The planks come in the same conditional field, and they are what was missing
    // for the opponent's planking to tell the right story: without them, the breach
    // they had just patched **vanished** from the hull instead of becoming a scar
    // with wood over it. Rewriting the whole list is safe because it is authoritative
    // on both sides — including mine, which I predicted locally and the host has just
    // confirmed.
    if (!patches) return;
    const list = ship.damage.patches;
    list.length = 0;
    for (const source of patches) {
      list.push({
        id: source.id,
        local: source.local.clone(),
        normal: source.normal.clone(),
        area: source.area,
      });
    }
  }

  /**
   * Recomputes each breach's jet with this instant's pose and sea.
   *
   * It runs every step, and not only when the list changes: the inflow depends on
   * where the wave is now and on how far the hull is heeled, and both change sixty
   * times a second while the breach list goes minutes without changing.
   */
  private refreshBreachInflow(ship: Ship): void {
    const waves = this.match.environment.waveField;
    const sigma = waves.getElevationSigma();
    for (const breach of ship.damage.breaches) {
      ship.body.localToWorld(breach.local, _position);
      const depth = waves.sampleHeight(_position.x, _position.z) - _position.y;
      breach.inflow = breachInflow(breach.area, depth, sigma);
    }
  }

  /**
   * The opponent's body is authoritative; mine, only in the fields I do not predict.
   *
   * ## Why their body is interpolated like the hull
   *
   * Because it is **seen**, and since there has been an opponent avatar that has
   * stopped being a detail. Writing the last snapshot's pose straight into the
   * controller — which is what was done, and was enough while nobody drew it — gives
   * a sailor moving at fifteen frames a second on top of a deck moving at a hundred
   * and forty-four: the body in jerks, and with every jerk a foot skating on the wood.
   *
   * The `t` is the **same** as the hull's, and that is the part that cannot diverge:
   * the body walks in ship coordinates, so body and deck have to be drawn at the same
   * instant or the sailor slides over his own floor.
   *
   * What is **not** interpolated are the discrete fields — station, gun, ladder,
   * capstan, plank. They hold from the `from` until the `to` arrives, and it is the
   * `from` that describes the instant being drawn. Interpolating a station means
   * nothing; advancing it would have the body take the helm before reaching it.
   *
   * @param t where the render clock sits between the two snapshots.
   */
  private applyCrew(t: number): void {
    // Indices inverted as in `applyWorld`: local 1 is always the opponent, and on
    // the wire they are `this.remote`.
    const remote = this.match.crew[1].controller;
    const to = this.to.crew[this.remote]!;
    const state = this.hasFrom ? this.from.crew[this.remote]! : to;
    const pose = this.remotePose;

    // Taking the helm or mounting the gun **teleports** the feet meters away.
    // Interpolating that straight line would give a pirate sliding across the deck in
    // an idle pose; pinning them to the origin station until the change applies hands
    // the jump back to whoever knows how to smooth it — `PlayerAvatar.updateStation`,
    // which takes the body to the station on the camera's same 0.28 s curve.
    const switching = state.station !== to.station || state.cannonIndex !== to.cannonIndex;
    if (switching) {
      pose.local.copy(state.local);
      pose.yaw = state.yaw;
      pose.pitch = state.pitch;
    } else {
      pose.local.lerpVectors(state.local, to.local, t);
      // By the short path: without this, crossing ±π makes their head turn almost a
      // full revolution between two snapshots.
      pose.yaw = state.yaw + wrapAngle(to.yaw - state.yaw) * t;
      pose.pitch = state.pitch + (to.pitch - state.pitch) * t;
    }

    pose.station = state.station;
    pose.cannonIndex = state.cannonIndex;
    pose.grounded = state.grounded;
    pose.onLadder = state.onLadder;
    pose.atCapstan = state.atCapstan;
    pose.patching = state.patching;
    // The water joins the discrete list, and that is right: interpolating "is at
    // sea" means nothing, and advancing it would have the opponent swimming across
    // the deck on the last step before they actually jumped.
    pose.inWater = state.inWater;

    // Their body's step: this is where the pose becomes stride, jump, climb, hands
    // on the wheel and plank in hand. See `PlayerController.applyRemoteStep`.
    remote.applyRemoteStep(FIXED_TIMESTEP, pose, this.match.ships[1]!);

    // ⚠️ **The station is only written once the host has seen the command that
    // changed it.**
    //
    // Writing always — which is what was done — starts from a reasonable and wrong
    // premise: that the client does not predict the station. It does, and it always
    // did, because `Crewman.fixedUpdate` is the **same** code on both sides and
    // `Interaction.press` calls `takeHelm()` here too. What there was was a prediction
    // with no reconciliation: the player took the helm at this instant and the next
    // snapshot, which describes a past earlier than the press, put them back on the
    // deck. With the round trip this project has, that is five or six snapshots
    // undoing the command before the host confirms it — and the player sees the camera
    // jumping between the deck and the wheel, with the controls changing meaning on
    // every jump. It was the "the controls invert".
    //
    // `ackTick` is the receipt: while the last command the host consumed is earlier
    // than the one that caused the change over here, the state arriving **cannot** yet
    // speak about it, and the right thing is to leave the prediction standing. When
    // the receipt passes, the authority applies in full again — and if the host
    // refused, the correction happens then, once, instead of flickering.
    const settled = this.stationPredictedAt < 0 || this.to.ackTick >= this.stationPredictedAt;
    if (!settled) return;
    this.stationPredictedAt = -1;

    const mine = this.match.crew[0].controller;
    const mineState = this.to.crew[this.slot]!;
    mine.station = mineState.station;
    mine.cannonIndex = mineState.cannonIndex;
    mine.onLadder = mineState.onLadder;
    mine.atCapstan = mineState.atCapstan;
    // The water comes in through the same receipt as the others — falling into the
    // sea is predicted here, and the snapshot describing the past before the jump
    // still says "on deck". Through a method, and not by assignment: entering the
    // water means changing the body's frame, and what knows how to do that is the
    // controller. See `applyAuthoritativeWater`.
    mine.applyAuthoritativeWater(mineState.inWater, this.match.ships[0]!);
  }

  /**
   * Notes that the station changed **here**, and on which step.
   *
   * It runs before `applyWorld`, and the order is what makes the reading possible:
   * the local sailor's step has already happened (`Match.fixedUpdateRemote` runs
   * before this session), and the authority has not been written over it yet. A
   * difference from what was left by the previous step can only have come from here.
   */
  private trackStationPrediction(tick: number): void {
    const mine = this.match.crew[0].controller;
    const changed =
      mine.station !== this.lastStation ||
      mine.cannonIndex !== this.lastCannonIndex ||
      mine.onLadder !== this.lastOnLadder ||
      mine.atCapstan !== this.lastAtCapstan ||
      // Falling into the sea and leaving it are predicted here like any station
      // change, and for the same reason they enter the receipt's arithmetic: without
      // this, the snapshot describing the past before the jump would put the player
      // back on deck half a dozen times before the host confirmed they jumped.
      mine.inWater !== this.lastInWater;

    if (changed) this.stationPredictedAt = tick;

    this.rememberStation();
  }

  /** After `applyCrew`: the authority also counts as "what was left". */
  private rememberStation(): void {
    const mine = this.match.crew[0].controller;
    this.lastStation = mine.station;
    this.lastCannonIndex = mine.cannonIndex;
    this.lastOnLadder = mine.onLadder;
    this.lastAtCapstan = mine.atCapstan;
    this.lastInWater = mine.inWater;
  }

  // -- prediction -----------------------------------------------------------------

  private rememberPrediction(tick: number): void {
    const controller = this.match.crew[0].controller;
    const slot = this.historyPool.pop() ?? { position: new THREE.Vector3(), inWater: false };
    // The quantity the prediction **owns** on this step, and not a chosen one: on
    // deck it is the local one, in the water it is the world one. See `PredictedStep`.
    slot.inWater = controller.inWater;
    slot.position.copy(controller.inWater ? controller.worldFeet : controller.local);
    this.history.set(tick, slot);
    // One second of history is enough: the snapshot that will charge the prediction
    // arrives in under a hundred milliseconds.
    this.releaseHistory(tick - 60);
  }

  /**
   * The host's position **in world space**, rebuilt with the hull pose from the same
   * snapshot.
   *
   * ⚠️ **The pose has to be the snapshot's, and not `ship.body`'s.** `applyWorld`
   * writes the **interpolated** pose into `ship.body`, which sits `INTERP_DELAY`
   * steps behind the render clock — and the render clock is already `lead` steps
   * behind the tick being charged. Using that pose here would reintroduce exactly the
   * bias this method exists to remove. The pose that came in the packet is the one
   * the host had at tick `to.tick` — the same one it derived the `local` being
   * compared from.
   *
   * The arithmetic is `ShipBody.localToWorld` letter for letter. `centerOfMass` does
   * not travel on the wire and does not need to: it is a constant of the hull,
   * computed identically on both sides.
   */
  private authoritativePosition(local: THREE.Vector3, ship: Ship): THREE.Vector3 {
    const state = this.to.ships[this.slot]!;
    return _authority
      .copy(local)
      .sub(ship.body.centerOfMass)
      .applyQuaternion(state.orientation)
      .add(state.position);
  }

  /**
   * Checks the body's prediction against the host's truth.
   *
   * **It does not resimulate.** With the body in local coordinates, the error left is
   * that of one walking step — centimeters. Correcting the position and letting the
   * render catch up in two tenths is indistinguishable from not having missed, and it
   * costs one subtraction instead of a history of whole states to replay.
   */
  private reconcile(): void {
    const authoritative = this.to.crew[this.slot]!;
    const predicted = this.history.get(this.to.tick);
    if (!predicted) return;

    const controller = this.match.crew[0].controller;

    // ⚠️ **All three have to agree about the frame, or there is nothing to
    // compare.** The prediction saved local or world depending on whether the body
    // was on deck or at sea; the authority describes the same step from the host's
    // point of view; and the current body is the one that will receive the
    // correction. When they diverge it is because somebody entered or left the water
    // between the step being charged and this one — and then the change is already a
    // legitimate teleport that the station's receipt covers, in `applyCrew`.
    // Measuring the distance between a sea position and a deck position would give a
    // large and meaningless number, and the `ERROR_SNAP` branch would obey it.
    if (predicted.inWater !== authoritative.inWater) return;
    if (predicted.inWater !== controller.inWater) return;

    const ship = this.match.ships[0]!;
    // ⚠️ **The comparison is made in the frame the prediction owns.**
    //
    // Always comparing in local coordinates seemed natural and hid a systematic bias
    // that only the water reveals. On deck there is no bias at all: a walker's
    // `local` does not read the hull's pose for anything, so both sides reach the
    // same number by independent routes. In the water, no — a swimmer's `local` **is**
    // the world position converted by the hull's pose, and the two poses are
    // different: the host uses the real one, the guest uses the one interpolated from
    // the network, `lead + INTERP_DELAY` steps behind (150 to 300 ms, depending on the
    // connection). Two *identical* world positions become different `local`s, and the
    // reconciliation saw an error that does not exist in the world.
    //
    // Measured: the hull's translation alone at 2.6 m/s gives 0.39 m at 150 ms and
    // 0.78 m at 300 ms — five to ten times `ERROR_IGNORE`, from the first frame in the
    // water and without depending on distance. With the ship yawing the term grows
    // with the **radius**, and that is exactly the feature's scenario: falling behind
    // while the ship sails. At 0.4 rad/s the bias crosses `ERROR_SNAP` at 11 to 24 m,
    // meaning in 4 to 9 seconds of drift — inside the window where the rescue has not
    // even opened.
    //
    // The way out is to compare where both sides do the same arithmetic with the same
    // data: in **world space**, rebuilding the host's position with the hull pose that
    // came in the same packet. See `authoritativePosition`.
    const target = predicted.inWater
      ? this.authoritativePosition(authoritative.local, ship)
      : authoritative.local;

    const error = predicted.position.distanceTo(target);
    this.predictionError = error;
    if (error < ERROR_IGNORE) return;

    if (error > ERROR_SNAP) {
      // A legitimate teleport. Go straight there, with no offset: dragging the
      // render across a meter and a half would be drawing the player going through
      // the deck.
      controller.applyAuthoritative(target, predicted.inWater, ship);
      this.viewOffset.set(0, 0, 0);
      this.releaseHistory(Number.POSITIVE_INFINITY);
      return;
    }

    // The offset saves the difference **before** the position is corrected, and the
    // render adds it back — the body goes to the right place without anyone seeing.
    //
    // ⚠️ **In ship coordinates, always.** The comparison happens in the frame the
    // prediction owns, and in the water that frame is the world — but what adds this
    // vector is `syncView`, which assembles a local pose. Adding a world displacement
    // there would skew the correction by the hull's heading, and the error would be
    // largest exactly when beam-on, which is the most common pose of a ship in
    // combat.
    _position.copy(predicted.position).sub(target);
    if (predicted.inWater) ship.body.worldDirToLocal(_position, _position);
    controller.absorbViewOffset(_position);
    controller.applyAuthoritative(target, predicted.inWater, ship);
    this.releaseHistory(this.to.tick);
  }

  private releaseHistory(upTo: number): void {
    for (const [tick, step] of this.history) {
      if (tick > upTo) continue;
      this.history.delete(tick);
      this.historyPool.push(step);
    }
  }

  // -- sending ----------------------------------------------------------------------

  /**
   * Queues the frame and sends a batch every two steps.
   *
   * The batch carries the last four frames, two of which are repeats. It is what
   * makes a lost packet invisible with no acknowledgement and no retransmission — see
   * `INPUT_BATCH`.
   */
  private queueOutgoing(frame: InputFrame): void {
    // The gaze this step produced, measured **after** the sailor has already moved —
    // `Match.fixedUpdateRemote` runs before this session. It is the exact angle the
    // interaction was decided with here, and it is what the host has to use to decide
    // the same. See `PlayerController.applyLook`.
    const view = this.match.crew[0].controller;
    frame.yaw = view.yaw;
    frame.pitch = view.pitch;

    this.outbox.add(frame);

    if (frame.tick % SEND_EVERY !== 0) return;
    this.client.sendFrame(encodeInput(this.outbox.batch));
  }

  /**
   * The initial lead, from the round-trip time already measured.
   *
   * ## The arithmetic is the **whole** round trip, and not half of it
   *
   * It used to be half, on the reasoning that "only the outbound leg matters", and
   * that arithmetic is wrong by a factor of two. The clock the guest stamps itself
   * against is `hostTick`, and `hostTick` is the number that came **inside** a
   * snapshot: by the time it arrives here, the host has already moved half a trip
   * beyond it. The command stamped now will still take the other half trip to get
   * there. Added together, it is the whole trip that separates the `hostTick` you know
   * from the instant the command will be consumed.
   *
   * With half, the command arrived systematically late and was **discarded** —
   * `InputBuffer.push` refuses a tick that has already passed. The host then repeated
   * the last known frame: the `pressed` edges vanished (interacting, firing and
   * jumping simply did not happen), the `held` state kept applying and the
   * authoritative position drifted from the predicted one until it blew past
   * `ERROR_SNAP`. What the player saw was a sailor who walks but does not obey, and
   * who is yanked back to where they were every second.
   *
   * The jitter is added in because it is asymmetric in what matters: a packet that
   * arrives early only fattens the queue, one that arrives late is lost. And the
   * four-step margin covers the snapshot's granularity — it goes out every four
   * steps, so the `hostTick` you read can already be a whole interval old on top of
   * the network.
   */
  private estimateLead(): number {
    const stepMs = FIXED_TIMESTEP * 1000;
    const ticks = Math.ceil((this.client.rtt + this.client.jitter) / stepMs);
    return Math.max(LEAD_MIN, Math.min(ticks + SNAPSHOT_INTERVAL, LEAD_MAX));
  }

  /**
   * Adjusts how far ahead the body runs, from the **floor** of the host's queue.
   *
   * ## Why the minimum, and not the last reading
   *
   * Because lead is pure command latency — every extra step is a step the command
   * waits in the queue before applying — and the only slack you can cut safely is the
   * one that existed the **whole** time since the last adjustment. A queue that
   * oscillates between zero and four has a mean of two and no fat at all: cutting
   * there means choosing to starve in the next trough.
   *
   * ## The defect this replaces
   *
   * The previous version looked at the last reading, went up with a queue below two
   * and only came down with a queue above four. Between the two there was a dead
   * band, and any hitch that pushed the lead up stayed there: going up was easy,
   * coming down required a fat queue that the high lead itself prevented from
   * happening. It was a ratchet, and it always turned the same way — the player who
   * reported this had a lead of 22 (366 ms of delay on every action that depends on
   * the host) on a 127 ms connection, which asks for 12.
   */
  private adjustLead(): void {
    this.leadTimer++;
    if (this.leadTimer < LEAD_ADJUST_EVERY) return;
    this.leadTimer = 0;

    const floor = this.minDepthSinceAdjust;
    const starved = this.starvedSinceAdjust;
    this.minDepthSinceAdjust = Number.POSITIVE_INFINITY;
    this.starvedSinceAdjust = 0;
    // No snapshot in the window: there is nothing to measure, and guessing would be
    // worse.
    if (!Number.isFinite(floor)) return;

    // Going up is a response to **real starvation**, reported by the host, and not
    // to an empty queue. The two looked like the same thing and are not: the queue
    // sits at zero also when the command arrives exactly on time, which is the
    // target. Steering by it made the lead climb precisely when it was right, and
    // never come back down.
    //
    // The size of the step up follows the size of the starvation. It used to be two
    // always, and two is the right answer for a network that really hitched — not for
    // the single lost step one late packet produces. Since lead is pure command
    // latency, going up two because of one costs 33 ms of permanent delay on every
    // action that depends on the host, and the next adjustment only gives one of them
    // back.
    if (starved >= 4) this.lead = Math.min(this.lead + 2, LEAD_MAX);
    else if (starved > 0) this.lead = Math.min(this.lead + 1, LEAD_MAX);
    else if (floor > DEPTH_TARGET) this.lead = Math.max(this.lead - 1, LEAD_MIN);
  }
}
