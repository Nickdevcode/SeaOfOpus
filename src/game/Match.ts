/**
 * The match: two ships, one duel, and what happens when one of them goes down.
 *
 * This module owns **everything that is game** — both hulls, the enemy captain, the
 * balls in the air, the effects, the player aboard and the parts they use. What stays
 * outside it is the *presentation*: renderer, scene, camera, environment, engine and
 * input still belong to `main.ts`. The boundary is useful in practice: restarting a
 * match is a method in here, not a rebuild of the world — the ocean, the sky and the
 * ship's textures are never remade, and switching difficulty costs a few milliseconds
 * instead of the tenths of a second `createShipAssets` takes.
 *
 * ## The order of the physics step, which is not arbitrary
 *
 * 1. **Contact between hulls**, before anything else. The forces are accumulated in
 *    `ShipBody` and enter the step that is starting now — see the note in `HullContact`.
 * 2. **The enemy captain**, before their ship. This step's helm, aim and trigger have
 *    to apply on this step, not on the next one.
 * 3. **The ships**, each one integrating its own physics.
 * 4. **The balls**, last, because the hit test reads the pose the ships have just
 *    written. The other way round, the ball would go through a hull from one step ago.
 *
 * Swapping 2 and 3 gives an enemy that always reacts one step late; swapping 3 and 4
 * gives balls that miss by 1.6 m. Neither one shows up as an obvious bug, and that is
 * why the order is written down here.
 */

import * as THREE from 'three';
import { DIFFICULTIES, type DifficultyId, type DifficultyPreset } from '../ai/Difficulty';
import { ShipAI } from '../ai/ShipAI';
import { CannonballPool, type BallImpact } from '../combat/Cannonball';
import { Effects } from '../combat/Effects';
import {
  createContactReport,
  resolveHullContact,
  type ContactReport,
} from '../combat/HullContact';
import { disposeCharacterAsset } from '../player/CharacterAsset';
import { PlayerAvatar } from '../player/PlayerAvatar';
import type { Interaction } from '../player/Interaction';
import type { PlayerController } from '../player/PlayerController';
import { DamageView } from '../ship/DamageView';
import { Ship } from '../ship/Ship';
import { createShipAssets, type ShipAssets } from '../ship/ShipBuilder';
import { downwindHeading } from '../ship/SailSim';
import type { Environment } from '../world/Environment';
import type { InputFrame } from '../core/InputFrame';
import { Crewman } from './Crewman';
import type { MatchEvent, ShipSlot } from './MatchEvents';

export type MatchState = 'menu' | 'fighting' | 'won' | 'lost';

/**
 * Who is in charge of the simulation.
 *
 * `solo` and `host` walk exactly the same code path — the only difference is where the
 * second ship's input comes from. `guest` is the thin client: it integrates no hull at
 * all, receives the pose ready-made and simulates only its own body.
 */
export type MatchRole = 'solo' | 'host' | 'guest';

/** One step's input, one frame per ship. */
export interface MatchInputs {
  readonly player: InputFrame;
  /** `null` when the one flying the enemy ship is the `ShipAI`. */
  readonly enemy: InputFrame | null;
}

/** The ships' names. It is the same `owner` each one's shots carry. */
const PLAYER_SHIP = 'player-sloop';
const ENEMY_SHIP = 'enemy-sloop';

/**
 * Initial distance between the two, in meters.
 *
 * 220 m is chosen by the clock, not by the ruler: outside firing range at any
 * difficulty (the Legend opens fire at 155 m), and at ~5 m/s of mutual approach it
 * gives close to half a minute before the first shot. It is the time to take the helm,
 * go below and load both guns and come back on deck — the match starts with a task, not
 * with a fright.
 */
const SPAWN_RANGE = 220;

/**
 * The bearing the enemy is born on, relative to the player's bow.
 *
 * Negative is starboard, and that is on purpose: `PlayerController` puts the player's
 * head turned 24° to starboard at spawn, so the game's first view shows the deck instead
 * of the mast. Putting the enemy sail on the same side makes the first thing they see on
 * appearing on deck the one they are going to fight.
 */
const SPAWN_BEARING = -0.45;

/**
 * The enemy sail's tint: dirty crimson, almost dry.
 *
 * Dark enough for the silhouette to read as a threat against a bright sky, and still
 * visible against the sea at night — the player's raw canvas vanishes into the gray of
 * the haze, this one does not. See `tintSail` for why it is a multiplication.
 */
const ENEMY_SAIL = 0x8a2f28;

/**
 * The character, on disk. One file for both bodies aboard.
 *
 * `BASE_URL` is the prefix Vite publishes `public/` under — in production it may not be
 * the root of the domain, and an absolute path hardcoded here would give a silent 404
 * that would only show up as "the pirates are gone" after the deploy.
 */
const CHARACTER_MODEL = `${import.meta.env.BASE_URL}models/pirate.glb`;

/** The match's numbers, for the end screen. */
export interface MatchStats {
  /** Seconds of combat. */
  duration: number;
  /** Shots the player fired. */
  shotsFired: number;
  /** The player's shots that found the enemy hull or mast. */
  shotsLanded: number;
  /** Breaches the player opened in the enemy. */
  breachesDealt: number;
  /** Breaches the player took. */
  breachesTaken: number;
}

/**
 * The match's notices for whoever wants to react — audio and UI.
 *
 * Optional callbacks instead of an event emitter: there are five notices, each with its
 * own signature, and a `Map<string, Function[]>` here would only trade type checking for
 * loose strings.
 */
export interface MatchListener {
  /** A cannon fired. `byPlayer` tells the near bang from the far one. */
  onShot?(position: THREE.Vector3, direction: THREE.Vector3, byPlayer: boolean): void;
  onSplash?(position: THREE.Vector3, speed: number): void;
  /** Ball into wood. `flooded` is `true` when it opened a breach that floods. */
  onHullHit?(position: THREE.Vector3, speed: number, onPlayer: boolean, flooded: boolean): void;
  onMastHit?(position: THREE.Vector3, speed: number): void;
  /** The two hulls touched. */
  onCollision?(position: THREE.Vector3, speed: number): void;
  onStateChange?(state: MatchState, previous: MatchState): void;
}

/**
 * Closing speed from which the hulls meeting makes a sound, in m/s.
 *
 * Below that the two are merely touching, and the sea works on them the whole time: a
 * crash on every roll would be noise, not information.
 */
const COLLISION_SPEED = 0.4;

/**
 * Seconds of rearm between two impacts that open a hull.
 *
 * It is what separates "they hit again" from "they are still grinding". Side to side the
 * wave makes the closing speed rise and fall several times a second, and without a rearm
 * a grapple would open a breach on every step — sixty a second. A second and a half is
 * more than the time for the two hulls to separate and come back, so a fresh charge
 * always counts, and a continuous creak counts once.
 */
const RAM_COOLDOWN = 1.5;

/** An empty list of ships, for the guest's step. See `fixedUpdateRemote`. */
const EMPTY_SHIPS: readonly Ship[] = [];

/** Ceiling of the event queue waiting for a snapshot. See `collectNetEvents`. */
const MAX_NET_EVENTS = 64;

const _muzzleDirection = new THREE.Vector3();
const _impactNormal = new THREE.Vector3();
const _jetPosition = new THREE.Vector3();
const _jetDirection = new THREE.Vector3();
const _ramLocal = new THREE.Vector3();
const _splinterNormal = new THREE.Vector3();

export class Match {
  state: MatchState = 'menu';
  role: MatchRole = 'solo';
  difficulty: DifficultyPreset = DIFFICULTIES.corsair;

  /**
   * Steps since this match started.
   *
   * The duel's clock, not the process's — `Engine.tick` counts from when the page
   * opened. This is the one that stamps input and snapshot on the network, because
   * this is the one both sides can zero together.
   */
  tick = 0;

  /**
   * What happened on this step. Drained in `update`. See `MatchEvents`.
   */
  readonly events: MatchEvent[] = [];

  /**
   * The events that have not gone over the wire yet, when this is the simulating side.
   *
   * ⚠️ **It exists because the two clocks do not agree, and that cost the whole
   * networked duel.** `events` belongs to the **frame**: `drainEvents` empties it on
   * every call to `update`, which runs once per monitor frame. The snapshot, by
   * contrast, goes out every **four steps**. At 60 fps that is four drains per
   * snapshot, and the snapshot only found in the list what had happened after the last
   * of them — three out of every four shots, splashes and impacts never reached the
   * other side. Since the guest's ball is born from the fire event, the effect was an
   * opponent firing with no ball, no bang and no smoke, three times out of four.
   *
   * This list belongs to the **snapshot**: what empties it is `HostSession`, after
   * writing it to the wire. Keeping the same reference in both is safe — every vector
   * that goes into an event is already cloned by whoever creates it.
   */
  readonly netEvents: MatchEvent[] = [];

  readonly assets: ShipAssets;
  readonly playerShip: Ship;
  readonly enemyShip: Ship;
  /**
   * All the ships. **The order matters in two places:** the wake centers its covered
   * area on the first, and the hit test skips whoever has the same name as the shot's
   * owner. The player comes first.
   */
  readonly ships: readonly Ship[];

  /**
   * The two sailors, in the same order as `ships`. Index 0 is always the local one.
   *
   * The second one exists even against the machine, and it is not waste: it is what
   * gives the enemy ship a body and a list of parts identical to the player's, so that
   * swapping the `ShipAI` for a person changes nothing beyond where the input comes
   * from.
   */
  readonly crew: readonly [Crewman, Crewman];

  /**
   * The player's body. It loads on its own and in parallel: it is the project's only
   * binary asset, and the game has to be playable before it arrives.
   */
  readonly avatar = new PlayerAvatar();

  /**
   * The opponent's body, hanging off their hull.
   *
   * Same class, same clips, same file — all that changes is where the controller
   * feeding it comes from: on the host it is simulated here with the input arriving
   * over the network, and on the client that does not simulate the pose arrives ready
   * in the snapshot and `PlayerController.applyRemoteStep` converts it into the
   * animation clocks. See `CharacterAsset` for why both bodies come out of a single
   * download.
   *
   * It stays **hidden outside the networked duel**: against the machine the other hull
   * is commanded by `ShipAI`, which moves no sailor at all, and a pirate planted on the
   * deck without ever taking a step is worse than no pirate.
   */
  readonly enemyAvatar = new PlayerAvatar();
  readonly cannonballs: CannonballPool;
  readonly effects: Effects;

  /** The enemy captain. `null` when the other hull is commanded by a person. */
  ai: ShipAI | null;

  readonly contact: ContactReport = createContactReport();

  readonly stats: MatchStats = {
    duration: 0,
    shotsFired: 0,
    shotsLanded: 0,
    breachesDealt: 0,
    breachesTaken: 0,
  };

  private readonly damageViews: readonly DamageView[];
  /** Each ship's breaches on the previous step, to detect the new ones. */
  private previousBreaches = { player: 0, enemy: 0 };
  /** Seconds until the next impact can open a hull. See `RAM_COOLDOWN`. */
  private ramCooldown = 0;

  constructor(
    scene: THREE.Scene,
    /**
     * Sea, wind and sky. Publicly readable because the duel depends on it being the
     * same on both sides — the determinism test compares it, and the network
     * snapshot carries the wind that comes out of here.
     */
    readonly environment: Environment,
    private readonly listener: MatchListener = {},
  ) {
    // The very expensive part of the initialization, and it runs exactly once:
    // textures on a 2D canvas plus the hull sweep. Both ships share all of it.
    this.assets = createShipAssets();

    this.playerShip = new Ship(this.assets, PLAYER_SHIP);
    this.enemyShip = new Ship(this.assets, ENEMY_SHIP, { sailTint: ENEMY_SAIL });
    this.ships = [this.playerShip, this.enemyShip];

    for (const ship of this.ships) {
      scene.add(ship.model.root);
      // Without this the ocean is drawn inside the hull and the hold is full of sea
      // even with the ship dry.
      environment.addHullClip(ship.model.root);
    }

    this.effects = new Effects(scene);
    this.cannonballs = new CannonballPool((impact) => this.onImpact(impact));
    scene.add(this.cannonballs.mesh);

    this.damageViews = this.ships.map((ship) => new DamageView(ship, scene));

    this.crew = [new Crewman(this.playerShip), new Crewman(this.enemyShip)];

    this.ai = new ShipAI(this.enemyShip, this.difficulty);

    // Children of each ship's model, not of the scene: that way they follow roll,
    // heel and surge without anyone recomposing anything — the same reason
    // `CameraRig` composes with `ship.model.root`.
    this.avatar.attach(this.playerShip.model.root);
    this.enemyAvatar.attach(this.enemyShip.model.root);
    // A single network request for both: the second `load` finds the same `Promise`
    // and instantiates a copy. See `CharacterAsset`.
    void this.avatar.load(CHARACTER_MODEL);
    void this.enemyAvatar.load(CHARACTER_MODEL);
    // Only shows up over the network — see the field's note.
    this.enemyAvatar.hidden = true;

    this.deploy();
  }

  /** `true` when the physics and the commands should run. */
  get running(): boolean {
    return this.state === 'fighting';
  }

  /** The local sailor: the body the camera follows and the one the player commands. */
  get player(): PlayerController {
    return this.crew[0].controller;
  }

  /** The local sailor's contextual focus, which the prompts draw. */
  get interaction(): Interaction {
    return this.crew[0].interaction;
  }

  /**
   * Distance between the two ships, in meters. The HUD draws from here.
   *
   * Measured here, and not read off `ai.range`: with no machine captain there would be
   * nowhere to read it from, and the distance between two hulls never depended on
   * there being a bot.
   */
  get range(): number {
    return this.playerShip.body.comPosition.distanceTo(this.enemyShip.body.comPosition);
  }

  // -- life cycle --------------------------------------------------------------

  /** Starts a fresh duel against the chosen captain. */
  startSolo(id: DifficultyId): void {
    this.role = 'solo';
    this.enemyAvatar.hidden = true;
    this.difficulty = DIFFICULTIES[id];
    // Remade because the gunners are born tied to the preset — and because a fresh
    // seed per match would be the opposite of what we want: the duel has to be
    // reproducible for a complaint of "that shot was impossible" to be checkable.
    this.ai = new ShipAI(this.enemyShip, this.difficulty);

    this.deploy();
    this.setState('fighting');
  }

  /**
   * Starts a duel against another person.
   *
   * The machine captain is **discarded**, not switched off: it keeps seeds and clocks
   * of its own, and a live `ShipAI` in the background of a networked duel is a second
   * hand writing into the same controls as the person on the other side.
   */
  startOnline(role: Exclude<MatchRole, 'solo'>): void {
    this.role = role;
    // And the opponent gets a body: on the other side of the wire there is somebody
    // who walks, runs, climbs the ladder and nails planks, and now you can see it.
    this.enemyAvatar.hidden = false;
    this.ai = null;
    this.deploy();
    this.setState('fighting');
  }

  /**
   * Ends a networked duel with the result the room announced.
   *
   * ⚠️ **Without this, the duel never ended on the client that does not simulate.**
   * The one who decides the end is the host, and the news arrives through the lobby;
   * on this side the state stayed at `fighting` and the world kept running behind the
   * result screen. Worse: the network session is switched off along with the
   * announcement, and without it the next frame's step falls onto the **simulating**
   * path — with the machine captain discarded and no input for the second hull. Both
   * ships went back to integrating local physics, out of nowhere, under the end
   * screen.
   *
   * It does not go through `checkOutcome` because the verdict is not ours: here we
   * only write down what has already been decided on the other side of the wire.
   */
  endOnline(won: boolean): void {
    if (this.role === 'solo') return;
    this.setState(won ? 'won' : 'lost');
  }

  /**
   * Back to the menu, with the world intact to serve as a backdrop.
   *
   * The role goes back to `solo` along with it, and that is not tidying: while it
   * stayed at `guest`, the background world would keep counting statistics from events
   * that no longer come from anywhere, and `collectNetEvents` would keep filling the
   * snapshot queue of a duel that is over.
   */
  toMenu(): void {
    this.role = 'solo';
    this.enemyAvatar.hidden = true;
    this.deploy();
    this.setState('menu');
  }

  /** Puts everything back at its starting place. */
  private deploy(): void {
    const waves = this.environment.waveField;

    // The player is born with the wind astern: the Sloop's fastest heading, and the one
    // that leaves the sail full and quiet in the game's first view.
    const heading = downwindHeading(waves);
    this.playerShip.spawn(0, 0, heading, waves);

    const bearing = heading + SPAWN_BEARING;
    this.enemyShip.spawn(
      -Math.sin(bearing) * SPAWN_RANGE,
      -Math.cos(bearing) * SPAWN_RANGE,
      // Bow-on toward the player: they are coming to fight, not to cruise.
      bearing + Math.PI,
      waves,
    );

    for (const crewman of this.crew) crewman.respawn();

    this.cannonballs.clear();
    this.effects.clear();
    this.events.length = 0;
    this.netEvents.length = 0;
    this.ai?.reset();
    this.tick = 0;

    this.stats.duration = 0;
    this.stats.shotsFired = 0;
    this.stats.shotsLanded = 0;
    this.stats.breachesDealt = 0;
    this.stats.breachesTaken = 0;
    this.previousBreaches.player = 0;
    this.previousBreaches.enemy = 0;
    this.ramCooldown = 0;
    this.contact.contacts = 0;

    for (const ship of this.ships) ship.syncModel(1);
  }

  private setState(state: MatchState): void {
    if (state === this.state) return;
    const previous = this.state;
    this.state = state;
    this.listener.onStateChange?.(state, previous);
  }

  // -- physics step ------------------------------------------------------------

  fixedUpdate(dt: number, inputs: MatchInputs): void {
    const waves = this.environment.waveField;
    // Where the list stands **before** this step. Anything stacked up from here on
    // belongs to this step, and is what needs copying into `netEvents` — see the note
    // over there. Reading the length instead of clearing the list keeps intact
    // whatever an earlier step of the same frame left for `drainEvents` to draw.
    const eventsBefore = this.events.length;
    this.environment.fixedUpdate(dt);

    // The moving parts' pose before anybody aims or turns the wheel. See
    // `Ship.beginStep` — it has to come before the sailors, not inside the ships.
    for (const ship of this.ships) ship.beginStep();

    if (!this.running) {
      // In the menu and on the end screens the world stays alive — the sea moves, the
      // day runs, both ships float. What stops is the duel.
      for (const ship of this.ships) ship.fixedUpdate(dt, waves);
      return;
    }

    this.tick++;
    this.stats.duration += dt;

    // 1. Contact: forces accumulated before anyone integrates.
    const contactsBefore = this.contact.contacts;
    resolveHullContact(this.playerShip, this.enemyShip, this.contact);
    this.registerCollision(dt, contactsBefore);

    // 2. Whoever commands, before the ships they command. This step's helm, aim and
    //    trigger have to apply on this step, not on the next one.
    this.crew[0].fixedUpdate(dt, inputs.player, waves);
    if (inputs.enemy) this.crew[1].fixedUpdate(dt, inputs.enemy, waves);
    else this.ai?.fixedUpdate(dt, this.playerShip, waves);
    // Right after them, while the splash still belongs to this step. See
    // `PlayerController.splashSpeed`.
    this.drainSplashes();

    // 3. The ships.
    for (const ship of this.ships) {
      ship.fixedUpdate(dt, waves);
      this.drainShots(ship);
    }

    // 4. The balls, over the freshly integrated pose.
    this.cannonballs.fixedUpdate(dt, this.ships, waves);

    this.countNewBreaches();
    this.checkOutcome();

    if (this.role === 'host') this.collectNetEvents(eventsBefore);
  }

  /**
   * Translates this step's contact into a thud and into damage.
   *
   * ## What opens a hull is the impact, and it opens both
   *
   * `HullContact` makes the hulls refuse to occupy the same place, and that on its own
   * is just a fence: getting close stops being impossible and goes on costing nothing.
   * Two 37 t sloops meeting at 3 m/s trade 157 kJ — more energy than almost any ball in
   * the game delivers — and the wood gives. The damage is symmetric on purpose:
   * whoever charges takes what they give, and that is what keeps ramming a risk instead
   * of the optimal strategy. See `ShipDamage.ram`.
   *
   * The speed threshold lives over there, not here: it is `ram` that returns zero when
   * the encounter was only a nudge, and it is from that zero that the decision not to
   * even arm the rearm comes. One rule, one place.
   *
   * @param before how many contacts there were on the previous step. It is what
   *   distinguishes the first instant of an encounter from the middle of a creak that
   *   has been going on for a while.
   */
  private registerCollision(dt: number, before: number): void {
    this.ramCooldown = Math.max(0, this.ramCooldown - dt);

    const { contacts, closingSpeed, point } = this.contact;
    if (contacts === 0) return;

    let opened = 0;
    if (this.ramCooldown <= 0) {
      for (const ship of this.ships) {
        ship.body.worldToLocal(point, _ramLocal);
        opened += ship.damage.ram(_ramLocal, closingSpeed);
      }
      if (opened > 0) this.ramCooldown = RAM_COOLDOWN;
    }

    // The thud goes out on the encounter's first step and on every fresh impact. A
    // creak that is already happening does not repeat the crash sixty times a second.
    if (opened === 0 && (before > 0 || closingSpeed <= COLLISION_SPEED)) return;

    // ⚠️ **Cloned**, and it did not use to be. `netEvents` holds this object for up to
    // four steps waiting for the snapshot, and `contact.point` is rewritten every
    // step: without the copy, the ramming reached the other side at the place the
    // hulls were four steps later. It is the same rule every event in here follows —
    // see `MatchEvents`.
    this.events.push({ kind: 'collision', position: point.clone(), speed: closingSpeed });
  }

  /**
   * Copies this step's events into the snapshot's queue.
   *
   * The ceiling is a safety net, not a budget: `HostSession` empties the queue every
   * four steps, so it never goes past a dozen in a healthy duel. If one day somebody
   * stops emptying it, what we want is an old event lost, and not memory growing until
   * the tab dies.
   */
  private collectNetEvents(from: number): void {
    for (let i = from; i < this.events.length; i++) {
      if (this.netEvents.length >= MAX_NET_EVENTS) return;
      this.netEvents.push(this.events[i]!);
    }
  }

  /**
   * The step for the side that does **not** simulate.
   *
   * Short on purpose, and explicitly separated from `fixedUpdate` instead of a handful
   * of `if`s inside it: the simulating side's path has to stay identical to the duel
   * against the machine, byte for byte, or the offline mode regresses every time the
   * netcode touches something.
   *
   * There is no buoyancy, sail, rudder, drag, contact or hit detection here — both
   * hulls' poses arrive ready and are written by `GuestSession`. What runs is the local
   * player's body, which is the only thing they control, and the decorative balls,
   * which fly by the same ballistics without hitting anything.
   *
   * ⚠️ **The shot queue is emptied without being used.** The local cannon really does
   * fire (recoil, sound, ammunition), but its ball is decided on the other side — if it
   * became a projectile here too, the player would see two.
   */
  fixedUpdateRemote(dt: number, frame: InputFrame): void {
    for (const ship of this.ships) ship.beginStep();
    if (!this.running) return;

    this.tick++;
    this.stats.duration += dt;

    const waves = this.environment.waveField;
    this.crew[0].fixedUpdate(dt, frame, waves);
    // ⚠️ **The splash from your own fall is discarded here**, for the same reason as
    // the shot queue just below: the host announces that event in the snapshot, and
    // raising the water column on both sides would give two splashes at the same
    // point. The price is the splash showing up half a round trip after the jump; the
    // alternative is it showing up twice.
    this.crew[0].controller.splashSpeed = 0;

    // ⚠️ **After the sailor, and it is what makes the helm work on this side.** They
    // have just written `controls.wheel`; with nobody integrating that command, the
    // wheel does not turn, the hands do not turn and the panel says `wheel 0%` while
    // the ship yaws away in the distance by the host's decision. See
    // `Ship.fixedUpdateRemote`.
    //
    // It runs for **both** hulls: the opponent's has no local command (its wheel stays
    // at zero here), and its authoritative pose is written right afterwards by
    // `GuestSession.applyShipParts`, which runs after this method and beats anything
    // that may have been computed.
    for (const ship of this.ships) ship.fixedUpdateRemote(dt, waves);

    for (const ship of this.ships) ship.pendingShots.length = 0;

    // With no ships in the list: no ball has anything to resolve a hit against, which
    // is exactly what we want. See `CannonballPool.spawnGhost`.
    this.cannonballs.fixedUpdate(dt, EMPTY_SHIPS, this.environment.waveField);

    // The breaches arrive ready from the host, and counting them is the only part of
    // the statistics this side can measure on its own. Without this line the end
    // screen on the non-simulating side showed four zeros — the whole duel with no
    // numbers at all.
    this.countNewBreaches();
  }

  /**
   * Turns a sailor falling into the sea into the **same** splash event as the ball's.
   *
   * Reusing the event instead of inventing a second one is what makes the fall arrive
   * ready-made: `Effects.waterSplash` raises the water column, `GameAudio.splash`
   * plays, and the snapshot carries the event to the other side without a single new
   * byte — the opponent sees the splash of whoever fell because it already knew how to
   * see a splash.
   *
   * It walks **both** sailors because on the host both are simulated here.
   */
  private drainSplashes(): void {
    for (const crewman of this.crew) {
      const controller = crewman.controller;
      if (controller.splashSpeed <= 0) continue;
      this.events.push({
        kind: 'splash',
        position: controller.splashAt.clone(),
        speed: controller.splashSpeed,
      });
      controller.splashSpeed = 0;
    }
  }

  /**
   * Empties a ship's shot queue, putting each one in the air.
   *
   * The queue belongs to the **step**, not to the frame: the cannon pushes the recoil
   * and queues the shot inside `fixedUpdate`, and it becomes a projectile here, with
   * the same pose that produced the recoil. Emptying it is the consumer's duty.
   */
  private drainShots(vessel: Ship): void {
    const slot: ShipSlot = vessel === this.playerShip ? 0 : 1;
    for (const shot of vessel.pendingShots) {
      this.cannonballs.spawn(shot);
      // The velocity already has the ship's added in, but that is two orders of
      // magnitude smaller than the muzzle velocity: normalizing gives the bore's axis.
      _muzzleDirection.copy(shot.velocity).normalize();
      // Noted down, not drawn: what makes smoke and bang is `update`. The vectors are
      // cloned because `shot` goes back to the pool on the next step.
      this.events.push({
        kind: 'shot',
        ship: slot,
        position: shot.position.clone(),
        direction: _muzzleDirection.clone(),
      });
      if (slot === 0) this.stats.shotsFired++;
    }
    vessel.pendingShots.length = 0;
  }

  private onImpact(impact: BallImpact): void {
    const speed = impact.velocity.length();

    if (impact.kind === 'water') {
      this.events.push({ kind: 'splash', position: impact.position.clone(), speed });
      return;
    }

    const target = impact.ship;
    const hit = impact.hit;
    if (!target || !hit) return;

    const slot: ShipSlot = target === this.playerShip ? 0 : 1;
    if (slot === 1) this.stats.shotsLanded++;

    if (hit.part === 'mast') {
      this.events.push({ kind: 'mast', ship: slot, position: impact.position.clone(), speed });
    } else {
      // The normal comes in ship coordinates; the splinters fly in the world.
      target.body.localDirToWorld(hit.normal, _impactNormal);
      this.events.push({
        kind: 'hull',
        ship: slot,
        position: impact.position.clone(),
        normal: _impactNormal.clone(),
        speed,
        flooded: hit.floods,
      });
    }

    // `hit` is a shared scratch value and is only good during this call — whoever
    // keeps something from it copies. `registerHit` clones what it needs.
    target.damage.registerHit(hit);
  }

  /** Counts the breaches that appeared on this step, for the statistics. */
  private countNewBreaches(): void {
    const player = this.playerShip.damage.breaches.length;
    const enemy = this.enemyShip.damage.breaches.length;

    if (player > this.previousBreaches.player) {
      this.stats.breachesTaken += player - this.previousBreaches.player;
    }
    if (enemy > this.previousBreaches.enemy) {
      this.stats.breachesDealt += enemy - this.previousBreaches.enemy;
    }

    this.previousBreaches.player = player;
    this.previousBreaches.enemy = enemy;
  }

  /**
   * End of match.
   *
   * `isSunk` only becomes `true` seven seconds after the point of no return, so the
   * player **watches** the sinking before the screen shows up — which is half the
   * reward of winning, and the other half of the lesson of losing.
   */
  private checkOutcome(): void {
    if (this.enemyShip.damage.isSunk) {
      this.setState('won');
      return;
    }
    if (this.playerShip.damage.isSunk) this.setState('lost');
  }

  // -- frame step --------------------------------------------------------------

  /**
   * The frame: interpolated pose, effects and sound. No game decision lives here.
   *
   * It no longer receives `input` or `controlling` — the sailor is commanded by the
   * fixed step, and whether they receive a command is decided by whoever assembles the
   * `InputFrame`. One `if` less here is one less path along which the networked duel
   * can diverge from the local one.
   *
   * @param lookResidualX horizontal look the player has already made and no step has
   *   consumed yet, in radians. It is what keeps the camera at the monitor's rate with
   *   the simulation at 60 Hz — see `PlayerController.syncView`.
   * @param lookResidualY the same, vertical.
   */
  update(dt: number, alpha: number, lookResidualX = 0, lookResidualY = 0): void {
    this.crew[0].controller.syncView(alpha, lookResidualX, lookResidualY, this.playerShip);
    // The sailor over there has no residual: nobody looks through their eyes, and what
    // you see of them is the body, not the camera.
    this.crew[1].controller.syncView(alpha, 0, 0, this.enemyShip);

    for (const ship of this.ships) ship.syncModel(alpha);
    this.cannonballs.syncModel(alpha);

    // The opponent's body lives here, and the player's in the main loop, because only
    // the second depends on the camera: it is `main.ts` that knows whether it is at
    // their eyes. Nobody looks through this one's eyes, so it is always seen from
    // outside — and after the `syncView` above, which is what writes the frame's pose.
    this.enemyAvatar.update(dt, this.crew[1].controller, false);

    this.drainEvents();

    // `update` first (it is what opens the trail's window), then the frame's
    // emissions, and the window closes at the end — that way the trail has the same
    // density at 30 and at 144 fps.
    this.effects.update(dt);
    this.cannonballs.forEachActive((position, velocity) =>
      this.effects.ballTrail(position, velocity),
    );
    this.effects.endTrailWindow();

    for (const ship of this.ships) this.updateWaterJets(ship);
    for (const view of this.damageViews) view.update(dt);
  }

  /**
   * Turns what the step noted down into smoke, splash and sound, and empties the queue.
   *
   * It is the only place in the game that connects simulation to presentation, and
   * that is on purpose: in a networked duel, the client that does not simulate
   * receives this same list over the wire, stacks it into the same array and calls this
   * same method. One path, two roles.
   */
  private drainEvents(): void {
    // The side that does not simulate has neither `drainShots` nor `onImpact` to count
    // shots with — what it has is this list, which arrives ready from the host with the
    // indices already translated into "0 is mine". It is the same count, measured from
    // wherever it can be.
    const counting = this.role === 'guest';

    for (const event of this.events) {
      switch (event.kind) {
        case 'shot':
          if (counting && event.ship === 0) this.stats.shotsFired++;
          this.effects.muzzleBlast(event.position, event.direction);
          this.listener.onShot?.(event.position, event.direction, event.ship === 0);
          break;
        case 'splash':
          this.effects.waterSplash(event.position, event.speed);
          this.listener.onSplash?.(event.position, event.speed);
          break;
        case 'hull':
          if (counting && event.ship === 1) this.stats.shotsLanded++;
          this.effects.woodImpact(event.position, event.normal, event.speed);
          this.listener.onHullHit?.(
            event.position,
            event.speed,
            event.ship === 0,
            event.flooded,
          );
          break;
        case 'mast':
          if (counting && event.ship === 1) this.stats.shotsLanded++;
          this.listener.onMastHit?.(event.position, event.speed);
          break;
        case 'collision':
          this.splinterCollision(event.position, event.speed);
          this.listener.onCollision?.(event.position, event.speed);
          break;
      }
    }
    this.events.length = 0;
  }

  /**
   * Splinters flying off both hulls at the point of the ramming.
   *
   * The normal does not travel in the event and does not need to: it is the direction
   * from each ship's center to the contact point, flattened horizontally, and both
   * sides of the wire have both hulls' poses. Two handfuls of splinters in opposite
   * directions is what a meeting of wood against wood looks like — and it comes for
   * free, without a single extra byte in the snapshot.
   *
   * The force comes from the speed on a scale of its own: 4 m/s is the collision that
   * tears off everything there is to tear off. See `Effects.splinters` for why it is
   * not the same scale as the ball's.
   */
  private splinterCollision(position: THREE.Vector3, speed: number): void {
    const power = Math.min(speed / 4, 1.2);
    for (const ship of this.ships) {
      _splinterNormal.subVectors(position, ship.body.comPosition);
      _splinterNormal.y = 0;
      if (_splinterNormal.lengthSq() < 1e-6) continue;
      this.effects.splinters(position, _splinterNormal.normalize(), power);
    }
  }

  /** The jets coming in through the open breaches, seen from the hold. */
  private updateWaterJets(vessel: Ship): void {
    for (const breach of vessel.damage.breaches) {
      if (breach.inflow <= 0) continue;
      vessel.body.localToWorld(breach.local, _jetPosition);
      vessel.body.localDirToWorld(breach.normal, _jetDirection);
      // `waterJet` sprays *against* the direction it receives, and the normal points
      // outward from the hull — it is the same convention: the water comes in pushing
      // inward.
      this.effects.waterJet(_jetPosition, _jetDirection, breach.inflow);
    }
  }

  dispose(): void {
    this.avatar.dispose();
    this.enemyAvatar.dispose();
    // After both, always: the mesh and the textures are shared by them, and releasing
    // them earlier would pull the floor out from under whatever was still in the
    // scene. See `CharacterAsset.disposeCharacterAsset`.
    disposeCharacterAsset(CHARACTER_MODEL);
    for (const view of this.damageViews) view.dispose();
    for (const ship of this.ships) ship.dispose();
    this.environment.clearHullClips();
    this.cannonballs.mesh.removeFromParent();
    this.effects.dispose();
    this.assets.dispose();
  }
}
