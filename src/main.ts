/**
 * Entry point: builds the world, hands the game to `Match` and runs the loop.
 *
 * What lives here is the **presentation** — renderer, scene, camera, environment,
 * wake, engine and input. What is *game* belongs to `Match`: the two ships, the
 * enemy captain, the cannonballs, the player aboard. The boundary is worth a
 * paragraph because it's what allows restarting a duel without rebuilding the ocean
 * or regenerating the hull textures, which together cost tenths of a second.
 *
 * The order inside the loop is the one each block's comments justify. None of it is
 * taste: fixed step before the frame, interpolated pose before the camera,
 * offscreen passes before the render.
 */

import * as THREE from 'three';
import { Engine } from './core/Engine';
import { Input } from './core/Input';
import { InputSampler } from './core/InputSampler';
import { createInputFrame, type InputFrame } from './core/InputFrame';
import { Renderer } from './core/Renderer';
import {
  QUALITY_ORDER,
  settings,
  type PlayerPreferences,
  type QualityPreset,
  type WeatherMode,
} from './core/Settings';
import { DEG, RAD, clamp, damp } from './core/MathUtils';
import { Environment } from './world/Environment';
import { WakeFoam } from './world/WakeFoam';
import { Match } from './game/Match';
import { INTENT_LABELS } from './ai/ShipAI';
import { downwindHeading, efficiencyAtHeading } from './ship/SailSim';
import { CameraRig } from './player/CameraRig';
import { HEAD_CLIP_OFF } from './shaders/headClip';
import { Prompts } from './ui/Prompts';
import { Blackout } from './ui/Blackout';
import { CombatHud } from './ui/CombatHud';
import { Menu, type Screen } from './ui/Menu';
import { OnlineSession } from './net/OnlineSession';
import { GameAudio } from './audio/GameAudio';
import './styles/base.css';

const viewport = document.getElementById('viewport');
const uiRoot = document.getElementById('ui-root');

if (!viewport || !uiRoot) {
  throw new Error('index.html structure not found (#viewport / #ui-root).');
}

const renderer = new Renderer();
viewport.appendChild(renderer.canvas);

const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(
  62,
  window.innerWidth / window.innerHeight,
  // Near sits at 15 cm: close enough for first person aboard and far enough for
  // the 24-bit depth buffer to survive the 12 km far plane.
  0.15,
  12000,
);

const environment = new Environment(scene, settings.quality, {
  dayLengthMinutes: settings.preferences.dayLengthMinutes,
});

/**
 * The time the game opens on: mid-afternoon (≈16:20).
 *
 * `timeOfDay` is the fraction of the day, so 0.68 × 24 h. This is art direction, not
 * physics: the low sun gives raking light on the hull side, a long shadow on the
 * deck and a golden sea behind the title, which is the first thing anyone sees of
 * the game. At noon the light comes from overhead, flattens the hull and kills the
 * relief of the planks. The cycle keeps running from here as usual — this only
 * picks where it starts.
 */
environment.dayNight.timeOfDay = 0.68;

const wake = new WakeFoam(settings.quality);

const input = new Input();
input.attach(renderer.canvas);

renderer.compose(scene, camera, environment.sky.sunMesh);

// --- audio -------------------------------------------------------------------
// The audio context can only open inside a player gesture — that's the rule in
// every current browser. Any click or key will do, and after the first one the
// call is cheap (it only checks whether the context got suspended on a tab switch).
const audio = new GameAudio();
const unlockAudio = (): void => audio.unlock();
window.addEventListener('pointerdown', unlockAudio);
window.addEventListener('keydown', unlockAudio);

// --- game --------------------------------------------------------------------
// `match` is filled in just below, but the menu needs to reference it in its
// callbacks — which only fire on a click, long after both lines have run.
let match!: Match;

const rig = new CameraRig(camera);
const prompts = new Prompts(uiRoot);
const hud = new CombatHud(uiRoot);
const blackout = new Blackout(uiRoot);

/**
 * How many rescues the local deckhand has asked for, as of the last look.
 *
 * The cut to black fires on an **edge**, not on state, because the rescue happens
 * inside a fixed step and the frame that notices it may be the next one — or the
 * third, on a 30 Hz display. A counter cannot be missed; a one-step flag can. See
 * `PlayerController.rescueCount`.
 */
let lastRescueCount = 0;

// The conversation with the room server. It's born knowing whether a server exists:
// with no environment variable, online mode is grayed out on the title screen
// instead of failing later.
let online!: OnlineSession;

const menu = new Menu(uiRoot, {
  onStartSolo: (difficulty) => match.startSolo(difficulty),
  onQuitToTitle: () => {
    online.leave();
    match.toMenu();
  },
  onNavigate: (kind) => audio.ui(kind),
  online: {
    onQuickMatch: (nickname) => online.queue(nickname),
    onCreateRoom: (nickname) => online.create(nickname),
    onJoinRoom: (nickname, code) => online.join(nickname, code),
    onCancel: () => online.leave(),
  },
});

match = new Match(scene, environment, {
  onShot: (position) => audio.cannonFire(position),
  onSplash: (position, speed) => audio.splash(position, speed),
  onHullHit: (position, speed, _onPlayer, flooded) =>
    audio.woodImpact(position, speed, flooded),
  onMastHit: (position, speed) => audio.mastHit(position, speed),
  onCollision: (position, speed) => audio.collision(position, speed),
  onStateChange: (state) => {
    if (state !== 'won' && state !== 'lost') return;
    // Online, the room is what announces the end: only the host simulates, and the
    // guest reaches this state through a snapshot, half a second later. Letting both
    // paths open the screen would give two overlapping outcomes on the host's side.
    if (match.role !== 'solo') return;
    audio.outcome(state === 'won');
    menu.showOutcome(state === 'won', match.stats);
  },
});

// After `match`, not before: the session keeps the reference to simulate and
// serialize. Created above, it would keep `undefined` — and the error would only
// show up in the first snapshot of an online duel, a long way from here.
online = new OnlineSession(import.meta.env.VITE_ROOM_SERVER, match);

menu.setOnlineAvailable(
  online.available,
  'Online play is not configured in this build.',
);
online.onChange((state) => menu.setOnlineState(state));

online.onStart((config) => {
  // The world comes from the room, not from local preferences: the sea on both sides
  // has to be the same sea. See the note on weather mode in `DuelRoom.onReady`.
  //
  // The three lines are the whole world: the seed dictates the waves and the
  // sequence of weather turns, the mode dictates the weather, and the hour dictates
  // the light. With the last two missing — as they were — two captains entered the
  // same sea under different skies, each with whatever clock his title screen had
  // reached.
  environment.reseed(config.seed);
  environment.setWeatherMode(config.weather);
  environment.dayNight.timeOfDay = config.timeOfDay;
  // The local weather preference stays out for as long as the duel lasts, and the
  // guard in `applyPreferences` is what holds it back. This only wipes the memory
  // of what was applied, so the room's value isn't confused with it.
  appliedWeather = null;
  menu.show('none');
  match.startOnline(config.role);
});

online.onOver((won, reason) => {
  if (menu.current === 'outcome') return;
  // **Before `leave`**, and the order is what stops the world from wandering off
  // alone behind the end screen: `leave` shuts down the network session, and without
  // it the next step would fall into the simulating path — two hulls integrating
  // local physics, with no machine captain and no input at all for the second.
  match.endOnline(won);
  audio.outcome(won);
  menu.showOutcome(won, match.stats, 'online');
  online.leave();
  void reason;
});

/**
 * Clicking anywhere asks for the pointer — but only while actually playing,
 * otherwise the menu would lose the cursor on the first button click.
 *
 * The listener sits on the **window**, not on the canvas, and the difference has
 * already cost a whole test session: the interface layers cover the entire
 * screen, and one of them forgetting `pointer-events: none` is enough to stop the
 * canvas from receiving clicks — the game keeps drawing, the keyboard keeps
 * walking, and only the mouse camera dies, which is the symptom hardest to connect
 * to its cause. On the window, the click arrives by bubbling wherever it comes
 * from. (The guilty layer was the HUD; see the note in `hud.css`.)
 */
window.addEventListener('click', () => {
  if (!menu.open && match.running) input.requestPointerLock();
});

/**
 * Lines the shell up with the menu state: who receives input, what shows on screen
 * and where the camera sits.
 *
 * Runs when the screen changes, not every frame, because everything here is a state
 * change. The free inspection camera (`C`) is respected: `detached` mode is never
 * overridden, otherwise the capture bench would lose its framing on the first
 * `Esc`.
 */
function syncShell(): void {
  const playing = !menu.open;

  input.setCaptured(!playing);
  prompts.setVisible(playing);
  hud.setVisible(playing && match.running);

  if (playing) {
    if (rig.mode === 'cinematic') rig.attachPlayer();
  } else {
    if (rig.mode === 'player') rig.cinematic();
    input.exitPointerLock();
    // A rescue asked for on the last frame before the menu opens would leave the
    // cinematic orbit behind a black curtain until the cut finished on its own.
    blackout.clear();
  }
}

let lastScreen: Screen | null = null;
syncShell();

// --- free inspection camera (DEV) --------------------------------------------
// It sits outside the game: `C` detaches the camera from the player to inspect the
// scene from outside, and it's what the `__game` bench uses to place screenshots.
const cameraState = {
  yaw: 0,
  pitch: -0.08,
  speed: 14,
  velocity: new THREE.Vector3(),
};

/** Aims the free camera at a point in the world, without moving its position. */
function aimCameraAt(target: THREE.Vector3): void {
  const to = target.clone().sub(camera.position);
  // atan2(-x, -z) because the camera looks down -Z when yaw is zero.
  cameraState.yaw = Math.atan2(-to.x, -to.z);
  cameraState.pitch = Math.atan2(to.y, Math.hypot(to.x, to.z));
}

function updateFreeCamera(dt: number): void {
  cameraState.yaw -= input.look.x;
  cameraState.pitch = clamp(cameraState.pitch - input.look.y, -1.45, 1.45);

  const wheel = input.getWheelDelta();
  if (wheel !== 0) cameraState.speed = clamp(cameraState.speed * (wheel < 0 ? 1.25 : 0.8), 1, 400);

  camera.quaternion.setFromEuler(new THREE.Euler(cameraState.pitch, cameraState.yaw, 0, 'YXZ'));

  const move = input.getMoveAxis();
  const forward = new THREE.Vector3(0, 0, -1).applyQuaternion(camera.quaternion);
  const right = new THREE.Vector3(1, 0, 0).applyQuaternion(camera.quaternion);

  const target = new THREE.Vector3()
    .addScaledVector(forward, move.y)
    .addScaledVector(right, move.x);
  if (input.isDown('jump')) target.y += 1;

  if (target.lengthSq() > 0) target.normalize();
  target.multiplyScalar(cameraState.speed * (input.isDown('sprint') ? 4 : 1));

  // Frame-rate-independent damping: it accelerates and stops with weight.
  cameraState.velocity.x = damp(cameraState.velocity.x, target.x, 9, dt);
  cameraState.velocity.y = damp(cameraState.velocity.y, target.y, 9, dt);
  cameraState.velocity.z = damp(cameraState.velocity.z, target.z, 9, dt);

  camera.position.addScaledVector(cameraState.velocity, dt);

  // Keeps the camera from diving: there's no underwater look yet.
  const waterHeight = environment.sampleHeight(camera.position.x, camera.position.z);
  camera.position.y = Math.max(camera.position.y, waterHeight + 0.8);
}

/** Detaches the camera from the player, leaving it where it is and facing the same way. */
function detachCamera(): void {
  rig.detach();
  const forward = new THREE.Vector3(0, 0, -1).applyQuaternion(camera.quaternion);
  cameraState.yaw = Math.atan2(-forward.x, -forward.z);
  cameraState.pitch = Math.asin(clamp(forward.y, -1, 1));
  cameraState.velocity.set(0, 0, 0);
}

/**
 * `C` toggles between playing and flying the free camera around the scene.
 *
 * It goes through the action system (`freeCamera`), not a loose `keydown` on the
 * window like before. The difference isn't tidiness: a listener of its own ignores
 * `input.captured`, and pressing `C` on the title screen dropped the camera into
 * `detached` mode — which `syncShell` deliberately never pulls anyone out of. The
 * cinematic orbit behind the menu died there and only came back on a page reload.
 */
function toggleFreeCamera(): void {
  if (rig.mode === 'detached') rig.attachPlayer();
  else detachCamera();
}

/**
 * How the opponent is announced on the HUD.
 *
 * Against the machine it's the captain's intent, which is half a read on the duel —
 * seeing someone on "Patching holes" says more than any health bar. Online it's the
 * nickname of whoever is on the other side, because a person's intent isn't ours
 * to tell.
 */
function foeLabel(): string {
  return match.ai ? INTENT_LABELS[match.ai.intent] : online.opponentName;
}

// --- telemetry overlay -------------------------------------------------------
const debugOverlay = document.createElement('pre');
debugOverlay.className = 'debug-overlay';
debugOverlay.hidden = !settings.preferences.showDebug;
uiRoot.appendChild(debugOverlay);

let debugTimer = 0;
const _shipEuler = new THREE.Euler();

function updateDebug(dt: number): void {
  if (input.wasPressed('debug')) {
    settings.update({ showDebug: !settings.preferences.showDebug });
    debugOverlay.hidden = !settings.preferences.showDebug;
  }
  if (debugOverlay.hidden) return;

  debugTimer += dt;
  if (debugTimer < 0.2) return;
  debugTimer = 0;

  const ship = match.playerShip;
  const enemy = match.enemyShip;
  const ai = match.ai;
  const waterHeight = environment.sampleHeight(camera.position.x, camera.position.z);

  // 'YXZ' separates yaw, pitch and roll in the order you read a ship in.
  _shipEuler.setFromQuaternion(ship.body.orientation, 'YXZ');

  // Apparent wind angle measured from the stern: 0° is dead downwind (the fastest
  // heading) and 180° is wind on the bow.
  const windSpeed = ship.sail.localWind.length();
  const pointOfSail = windSpeed > 0.01
    ? Math.acos(clamp(-ship.sail.localWind.z / windSpeed, -1, 1)) * RAD
    : 0;

  // A single read: the getter builds an object, and the overlay uses nine of its fields.
  const avatar = match.avatar.debug;
  const foeBody = match.enemyAvatar.debug;

  let totalInflow = 0;
  for (const breach of ship.damage.breaches) totalInflow += breach.inflow;

  const weather = environment.weather;
  const net = online.telemetry;

  debugOverlay.textContent = [
    `${engine.fps.toFixed(0)} fps  ·  ${engine.frameTimeMs.toFixed(2)} ms  ·  ${match.state}`,
    `clock ${environment.dayNight.getClockLabel()}  ·  night ${environment.dayNight.nightFactor.toFixed(2)}`,
    `weather ${weather.label}  ·  wind ${weather.wind.toFixed(2)} at ${((weather.direction * RAD + 360) % 360).toFixed(0)}°  ·  rain ${weather.rain.toFixed(2)}  ·  vis ${weather.visibility.toFixed(0)} m`,
    `water ${waterHeight.toFixed(2)} m  ·  sigma ${environment.waveField.getElevationSigma().toFixed(2)} m  ·  peak ${environment.waveField.getMaxAmplitude().toFixed(2)} m`,
    '',
    `ship  ${ship.knots.toFixed(2)} kn  (${ship.surge.toFixed(2)} m/s)  ·  heading ${((ship.heading * RAD + 360) % 360).toFixed(0)}°`,
    `pitch ${(_shipEuler.x * RAD).toFixed(1)}°  ·  roll ${(_shipEuler.z * RAD).toFixed(1)}°  ·  submersion ${ship.submersion.toFixed(2)}`,
    `wheel ${(ship.wheelPosition * 100).toFixed(0)}%  ·  rudder ${(ship.rudder.rudderAngle * RAD).toFixed(1)}°`,
    `sail ${(ship.sail.thrust / 1000).toFixed(1)} kN  ·  efficiency ${(ship.sail.efficiency * 100).toFixed(0)}%  ·  wind ${windSpeed.toFixed(1)} m/s at ${pointOfSail.toFixed(0)}° off the stern`,
    `anchor ${ship.anchor.state}  ${(ship.anchor.deploy * 100).toFixed(0)}%  ·  tension ${(ship.anchor.tension / 1000).toFixed(1)} kN`,
    `hold ${(ship.damage.floodFraction * 100).toFixed(1)}%  (${ship.damage.floodVolume.toFixed(2)} of ${ship.damage.holdVolume.toFixed(1)} m³)  ·  holes ${ship.damage.breaches.length}  ·  inflow ${(totalInflow * 1000).toFixed(0)} L/s${ship.damage.isSinking ? '  ·  SINKING' : ''}`,
    '',
    // The machine captain's lines only exist when there is one. Online, what's left
    // is what can be measured from outside: the other hull and the contact.
    ...(ai
      ? [
          `ENEMY (${match.difficulty.label})  ${INTENT_LABELS[ai.intent]}  ·  ${enemy.knots.toFixed(2)} kn`,
          `range ${ai.range.toFixed(0)} m  ·  bearing ${(ai.relativeBearing * RAD).toFixed(0)}°  ·  side ${ai.firingSide > 0 ? 'starboard' : 'port'}`,
          `course ordered ${((ai.helmsman.course * RAD + 360) % 360).toFixed(0)}°  ·  error ${(ai.helmsman.error * RAD).toFixed(1)}°  ·  efficiency ${(efficiencyAtHeading(ai.helmsman.course, environment.waveField) * 100).toFixed(0)}%`,
          `crewman ${ai.crew.post}${ai.crew.onStation ? '' : ` (in transit, ${ai.crew.transit.toFixed(1)} s)`}${ai.crew.reaching > 0 ? ` (crossing the hold, ${ai.crew.reaching.toFixed(1)} s)` : ''}  ·  gun manned ${ai.mannedCannon}  ·  shift ${ai.shiftLeft.toFixed(1)} s left`,
          `enemy hold ${(enemy.damage.floodFraction * 100).toFixed(1)}%  ·  holes ${enemy.damage.breaches.length}  ·  planks ${enemy.planks}  ·  shots ${ai.gunners.map((g) => g.shots).join('/')}`,
        ]
      : [
          `ENEMY (${online.opponentName || 'remote'})  ${enemy.knots.toFixed(2)} kn  ·  range ${match.range.toFixed(0)} m`,
          `enemy hold ${(enemy.damage.floodFraction * 100).toFixed(1)}%  ·  holes ${enemy.damage.breaches.length}  ·  planks ${enemy.planks}`,
          `enemy crew ${match.crew[1].controller.station}${match.crew[1].controller.onLadder ? ' (ladder)' : ''}  ·  local x ${match.crew[1].controller.local.x.toFixed(2)}  z ${match.crew[1].controller.local.z.toFixed(2)}`,
          // His body, measured the same way as the player's just below: this
          // line is what tells whether the opponent is being **animated** or
          // merely positioned — a `gait` pinned at zero while he walks across
          // the screen is exactly the defect the remote body exists not to have.
          `enemy body ${match.enemyAvatar.root.visible ? 'shown' : 'hidden'}  ·  gait w ${foeBody.walk.toFixed(2)} r ${foeBody.run.toFixed(2)} i ${foeBody.idle.toFixed(2)} air ${foeBody.air.toFixed(2)} climb ${foeBody.climb.toFixed(2)} helm ${foeBody.helm.toFixed(2)}  ·  speed ${match.crew[1].controller.gait.speed.toFixed(2)} m/s`,
        ]),
    `contact ${match.contact.contacts} points  ·  depth ${(match.contact.depth * 100).toFixed(0)} cm`,
    // The net block only exists in an online duel, and it's the panel that says
    // whether the netcode is healthy. The targets: rtt < 120 ms, jitter < 30, queue
    // between 2 and 4, starves near zero, prediction error below 5 cm.
    ...(net
      ? [
          '',
          `net ${match.role}  ·  rtt ${net.rtt.toFixed(0)} ms  ·  jitter ${net.jitter.toFixed(0)} ms${net.stalled ? '  ·  HOST IN BACKGROUND' : ''}`,
          `queue ${net.depth} frames  ·  starves ${net.starves}  ·  lead ${net.lead}  ·  prediction ${(net.error * 100).toFixed(1)} cm`,
        ]
      : []),
    '',
    `player ${match.player.station}${match.player.onLadder ? ' (ladder)' : ''}${match.player.grounded ? '' : ' (airborne)'}${match.player.inWater ? ' (swimming)' : ''}  ·  local x ${match.player.local.x.toFixed(2)}  y ${match.player.local.y.toFixed(2)}  z ${match.player.local.z.toFixed(2)}`,
    // The water clock has two phases and two clips, and this line shows both
    // halves: on the left what the clock asks for, on the right (`f`/`s`) the weight
    // each clip actually took. Divergence between the two sides means a GLB with no
    // `Float`/`Swim` — the water returns zero and the body goes back to swimming
    // upright. See `PlayerAvatar.updateSwim`.
    `water ${match.player.inWater ? `${match.player.waterTime.toFixed(1)} s` : 'dry'}  ·  swim w ${match.player.swim.weight.toFixed(2)} stroke ${match.player.swim.stroke.toFixed(2)} phase ${match.player.swim.phase.toFixed(2)}/${match.player.swim.floatPhase.toFixed(2)} at ${match.player.swim.speed.toFixed(2)} m/s  ·  pose f ${avatar.float.toFixed(2)} s ${avatar.swim.toFixed(2)}  ·  rescue ${match.player.canRequestRescue() ? 'ready' : '—'}`,
    `body ${match.avatar.root.visible ? 'worn' : 'hidden'}  ·  legs ${(avatar.twist * RAD).toFixed(0)}° ${avatar.reversed ? 'reverse' : 'forward'}  ·  head clip ${avatar.headClip >= HEAD_CLIP_OFF ? 'off' : avatar.headClip.toFixed(2)}  ·  gait w ${avatar.walk.toFixed(2)} r ${avatar.run.toFixed(2)} i ${avatar.idle.toFixed(2)} air ${avatar.air.toFixed(2)} climb ${avatar.climb.toFixed(2)} helm ${avatar.helm.toFixed(2)}`,
    `cannons ${ship.cannons.map((c) => c.state).join(' / ')}  ·  locker ${ship.cannonballs} shot / ${ship.planks} planks  ·  focus ${match.interaction.focus?.id ?? '—'}`,
    `shot in flight ${match.cannonballs.activeCount}  ·  particles ${match.effects.liveCount}`,
    `camera ${rig.mode} (C)  ·  x ${camera.position.x.toFixed(1)}  y ${camera.position.y.toFixed(2)}  z ${camera.position.z.toFixed(1)}`,
    `ocean ${environment.ocean.getTriangleCount().toLocaleString('en-US')} triangles`,
    `preset ${settings.preferences.quality}  ·  ${renderer.getGpuInfo()}`,
    input.gamepad.connected ? `gamepad: ${input.gamepad.deviceName}` : 'gamepad: none',
  ].join('\n');
}

// --- performance guard -------------------------------------------------------

/**
 * The preset steps down on its own when the machine can't hold what it asked for.
 *
 * Detection by GPU name (see `detectPreset`) gets the order of magnitude right and
 * everything else wrong: it doesn't know the monitor's resolution, doesn't know
 * whether there's a browser with forty tabs alongside, and doesn't know this player
 * is **hosting** a duel, which puts the physics of two hulls on the same machine.
 * When it gets it wrong, the player is left with a game at twenty frames and no hint
 * that the fix is two clicks away in the menu.
 *
 * Three decisions that stand on their own:
 *
 * - **It only goes down.** Climbing back up at the first quiet stretch would give a
 *   game that oscillates between two presets, and the worst moment for a frame rate
 *   drop is combat, which is exactly when it would come back.
 * - **It needs a whole window below the target.** A half-second hitch while loading
 *   a texture isn't a weak machine; six seconds in a row is.
 * - **What was saved counts.** The choice persists, so whoever opened the game on a
 *   modest machine starts the next session on the preset that worked.
 */
const AUTO_QUALITY_FPS = 40;
const AUTO_QUALITY_WINDOW = 6;
/** Grace period after stepping down a rung: gives the new preset time to settle. */
const AUTO_QUALITY_COOLDOWN = 10;

let lowFrameRateTime = 0;
let autoQualityCooldown = AUTO_QUALITY_COOLDOWN;

function guardPerformance(dt: number): void {
  // Only during the match: the menu has a cinematic orbit and transitions, and it's
  // where the frame rate says the least about what the machine can take in play.
  if (menu.open || !match.running) {
    lowFrameRateTime = 0;
    return;
  }

  if (autoQualityCooldown > 0) {
    autoQualityCooldown -= dt;
    return;
  }

  const index = QUALITY_ORDER.indexOf(settings.preferences.quality);
  if (index <= 0) return;

  if (engine.fps >= AUTO_QUALITY_FPS) {
    // Decays instead of resetting to zero: a machine that oscillates around the
    // target still accumulates, only more slowly. Resetting would leave the most
    // common case of all — the one that crosses 40 now and then — never firing.
    lowFrameRateTime = Math.max(0, lowFrameRateTime - dt);
    return;
  }

  lowFrameRateTime += dt;
  if (lowFrameRateTime < AUTO_QUALITY_WINDOW) return;

  lowFrameRateTime = 0;
  autoQualityCooldown = AUTO_QUALITY_COOLDOWN;
  const next = QUALITY_ORDER[index - 1]!;
  console.info(
    `[sea-of-opus] ${engine.fps.toFixed(0)} fps sustained below ${AUTO_QUALITY_FPS}: quality lowered to "${next}".`,
  );
  settings.update({ quality: next });
}

// --- loop --------------------------------------------------------------------
const engine = new Engine();

/**
 * The translator between the monitor's clock and the simulation's.
 *
 * Samples input in `beginFrame` (which runs before the fixed steps) and hands out
 * one frame per step. See `InputSampler` for the two bugs it exists to keep from
 * happening.
 */
const sampler = new InputSampler();

/**
 * The step's input, built once and reused.
 *
 * `enemy` stays `null` while the opponent is the machine; when a second player
 * joins, this is where his frame arrives. Neither of the two fields allocates
 * per tick.
 */
const matchInputs = { player: createInputFrame(), enemy: null as InputFrame | null };

engine.start({
  beginFrame: (dt) => {
    input.beginFrame(dt);
    // Only samples what counts as a command: with the menu up, or the camera loose
    // for inspection, the deckhand gets steps of empty input instead of no step at
    // all — the simulation keeps running, which is what the background world asks for.
    sampler.setLive(!menu.open && rig.mode === 'player' && match.running);
    sampler.sample(input);
  },
  fixedUpdate: (dt, tick) => {
    const guest = online.guest;
    if (guest) {
      // The thin client samples input on the **prediction clock**, ahead of the
      // host, so that it arrives there at the instant it gets consumed. See the
      // three clocks in `GuestSession`.
      const frame = sampler.consume(guest.predictionTick());
      match.fixedUpdateRemote(dt, frame);
      guest.fixedUpdate(frame);
      return;
    }

    matchInputs.player = sampler.consume(tick);
    // Against the machine this is `null` and `ShipAI` is what steers the other hull.
    matchInputs.enemy = online.enemyInput(match.tick + 1);
    match.fixedUpdate(dt, matchInputs);
    online.afterHostStep(match.tick);
  },
  update: (dt, alpha) => {
    // The menu first: it decides whether the rest of the frame is game or showcase.
    menu.update(input, dt);
    // Outside the menu's `if` on purpose: the session also has to run with the menu
    // closed, which is when the online match happens.
    online.update(dt);
    if (menu.open) {
      // With input frozen, `Input` lets through `Esc` from the keyboard and the
      // controller's Menu and View buttons — enough to close what's open without
      // having to put down the device that opened it. `Tab` is left out on purpose:
      // frozen, it's the menu's own focus navigation.
      if (input.wasPressed('pause')) menu.back();
      // View makes the round trip on the same press: it opens the controls screen
      // from wherever you are, and closes it when that's already the one up.
      if (input.wasPressed('controls')) {
        if (menu.current === 'controls') menu.back();
        else menu.openOverlay('controls');
      }
    } else {
      if (input.wasPressed('pause')) menu.openOverlay('settings');
      if (input.wasPressed('controls')) menu.openOverlay('controls');
      // Frozen, `freeCamera` never gets here: the menu is blocking the free camera.
      if (input.wasPressed('freeCamera')) toggleFreeCamera();
    }

    if (menu.current !== lastScreen) {
      lastScreen = menu.current;
      syncShell();
    }

    // The leftover look goes in here: it's what gives the camera the monitor's rate
    // with the head moving at 60 Hz. See `PlayerController.syncView`.
    match.update(dt, alpha, sampler.pendingLookX, sampler.pendingLookY);
    // The reconciliation offset fades in two tenths of a second. See `GuestSession`.
    online.guest?.decayOffset(dt);

    // The rescue's cut to black, on the counter's edge. It lives here and not inside
    // `Match` because it's pure presentation: what pulls the deckhand out of the
    // water is the fixed step (the host's, in an online duel), and this curtain only
    // covers the instant.
    if (match.player.rescueCount !== lastRescueCount) {
      lastRescueCount = match.player.rescueCount;
      blackout.play();
    }
    blackout.update(dt);

    // The interpolated pose has already been written by `match.update`, so the
    // camera reads this frame's matrix and not the previous one's — otherwise it
    // would trail a frame behind and jitter against the deck.
    if (rig.mode === 'detached') updateFreeCamera(dt);
    else rig.update(dt, match.player, match.playerShip);

    // The loop only says **where the body is being looked at from**; whether it
    // shows, with or without a head, is the character's own call. See `PlayerAvatar`.
    match.avatar.update(dt, match.player, rig.mode === 'player');

    environment.update(dt, camera.position);

    prompts.update(input, match.interaction, match.player, match.playerShip);
    hud.update(match.playerShip, match.enemyShip, foeLabel(), camera, environment.waveField);

    // The ear follows the camera, not the ship: at the cannon the head goes behind
    // the breech, and that's where the player hears from.
    audio.setListener(camera);
    audio.setSeaState(environment.waveField.windStrength, environment.dayNight.nightFactor);

    // The lanterns light themselves as night closes in.
    for (const ship of match.ships) {
      ship.model.setLanternIntensity(environment.dayNight.nightFactor);
    }
    guardPerformance(dt);
    updateDebug(dt);
    input.endFrame();
  },
  render: (dt) => {
    // The two offscreen passes come before the frame. The wake stamps on the pose
    // `syncModel` has just written, and the texture swaps places every frame
    // (ping-pong), so the ocean has to be repointed every time.
    wake.update(renderer.webgl, dt, match.ships);
    environment.ocean.setWake(wake.texture, wake.center, wake.size, 1);
    // The sky LUT has to be ready before the render: sea and dome both read from it.
    environment.prepare(renderer.webgl);
    renderer.render(dt);
  },
});

window.addEventListener('resize', () => renderer.resize());

/**
 * Spreads the preferences out to whoever consumes them.
 *
 * Runs on change, not every frame, because everything here is either expensive
 * or state: the graphics preset rebuilds the post-processing chain, the field of
 * view recomposes the projection matrix and held weather halts the weather state
 * machine.
 *
 * ## Why there are equality guards here
 *
 * "On change" was a lie for anyone dragging a slider: every pixel of drag emits
 * an `input`, and every `input` called this **entire** function. Changing the
 * volume threw away and rebuilt the `EffectComposer` (Bloom, GodRays, SMAA) dozens
 * of times a second and, worse, `Environment.applyQuality` regenerates the wave
 * field — the sea of the match in progress was reseeded in the middle of a shot
 * in flight.
 *
 * The guards live on this side because this is where **what** changed is known:
 * `applyQuality` takes a preset object and has no way to tell "the same one
 * again" from "the first time". The price is remembering the previous value; the
 * gain is that volume, sensitivity and field of view keep applying on every frame
 * of the drag, which is what the player needs to see while calibrating.
 */
let appliedQuality: QualityPreset | null = null;
let appliedWeather: WeatherMode | null = null;

function applyPreferences(prefs: PlayerPreferences): void {
  if (prefs.quality !== appliedQuality) {
    appliedQuality = prefs.quality;
    renderer.applyQuality(settings.quality);
    environment.applyQuality(settings.quality);
    wake.applyQuality(settings.quality);
  }

  // `Weather.set` restarts gust, lightning and countdown. Reapplying the same mode
  // on every frame of a drag zeroed the gust before it existed, and the held wind
  // came out as flat as a table.
  //
  // In an online duel the mode belongs to the **room**, and the menu doesn't
  // command it: wind feeds into sail force, so a captain who switched to "clear"
  // mid-match would be picking his own sea. The simulating side ignores the
  // preference; the side that doesn't simulate gets the weather ready-made in
  // the snapshot anyway.
  if (prefs.weather !== appliedWeather && match.role === 'solo') {
    appliedWeather = prefs.weather;
    environment.setWeatherMode(prefs.weather);
  }

  // These three are idempotent, cheap assignments: they apply every time, and it's
  // what gives the slider its immediate feedback while it's being dragged.
  environment.dayNight.dayLengthSeconds = prefs.dayLengthMinutes * 60;
  match.player.setFieldOfView(prefs.fieldOfView);
}

settings.onChange(applyPreferences);
applyPreferences(settings.preferences);

// Inspection bench for the automated tests (wave parity, sky LUT probing, physics
// telemetry, driving the duel without a menu). Dev only — the production build
// strips the whole block by dead-code elimination.
if (import.meta.env.DEV) {
  /**
   * Freezes the scene in an exact state so screenshots can be compared across
   * shader tweaks. Without it the sun moves between one screenshot and the next
   * and any difference turns into noise.
   *
   * `yawTowardSun` points the camera at the sun (`1`), at the opposite side (`-1`)
   * or 90° away from it (`0`), always relative to the sun's current position.
   */
  function setView(options: {
    timeOfDay?: number;
    height?: number;
    pitch?: number;
    yawTowardSun?: number;
    waveTime?: number;
  }): void {
    const { timeOfDay, height = 6, pitch = -0.08, yawTowardSun = 1, waveTime } = options;

    rig.detach();
    environment.dayNight.paused = true;
    if (timeOfDay !== undefined) environment.dayNight.timeOfDay = timeOfDay;
    environment.dayNight.update(0);
    if (waveTime !== undefined) environment.waveField.time = waveTime;

    const sun = environment.dayNight.sunDirection;
    // atan2(x, z) because the camera looks down -Z with yaw = 0.
    const sunYaw = Math.atan2(sun.x, sun.z) + Math.PI;
    cameraState.yaw = sunYaw + (1 - yawTowardSun) * (Math.PI / 2);
    cameraState.pitch = pitch;
    cameraState.velocity.set(0, 0, 0);
    camera.position.set(0, height, 0);
  }

  /** Orbits one of the ships, to inspect the model from every side. */
  function setShipView(options: {
    azimuth?: number;
    distance?: number;
    height?: number;
    target?: number;
    timeOfDay?: number;
    waveTime?: number;
    enemy?: boolean;
  }): void {
    const { azimuth = 0.7, distance = 20, height = 6, target = 2.5 } = options;

    rig.detach();
    environment.dayNight.paused = true;
    if (options.timeOfDay !== undefined) environment.dayNight.timeOfDay = options.timeOfDay;
    environment.dayNight.update(0);
    if (options.waveTime !== undefined) environment.waveField.time = options.waveTime;

    // Orbita o navio onde ele estiver: com física ele já não fica na origem.
    const subject = options.enemy ? match.enemyShip : match.playerShip;
    const pivot = subject.model.root.position.clone().setY(target);
    camera.position.set(
      pivot.x + Math.sin(azimuth) * distance,
      height,
      pivot.z + Math.cos(azimuth) * distance,
    );
    aimCameraAt(pivot);
    cameraState.velocity.set(0, 0, 0);
  }

  /**
   * Enquadra os **dois** navios: a câmera sobe até os dois caberem no campo.
   *
   * É o que permite capturar o duelo sem adivinhar coordenadas — a distância entre
   * eles muda a cada segundo de manobra.
   */
  function setDuelView(options: { height?: number; margin?: number } = {}): void {
    const { margin = 1.5 } = options;

    rig.detach();
    const a = match.playerShip.model.root.position;
    const b = match.enemyShip.model.root.position;
    const mid = a.clone().add(b).multiplyScalar(0.5);
    const spread = a.distanceTo(b) * margin;

    // Altura que enquadra `spread` com o FOV vertical atual, mais uma folga para o
    // mastro de 12 m não sair pelo topo.
    const fov = camera.fov * DEG;
    const height = options.height ?? Math.max(spread / (2 * Math.tan(fov / 2)) * 0.7, 25);

    camera.position.set(mid.x, height, mid.z + spread * 0.55);
    aimCameraAt(mid.setY(4));
    cameraState.velocity.set(0, 0, 0);
  }

  /**
   * Enquadra o corpo do jogador, para conferir animação.
   *
   * Existe porque a câmera livre reconstrói a orientação a partir do estado dela
   * a cada quadro: escrever `camera.lookAt` de fora é desfeito no frame
   * seguinte, e o resultado é uma captura no lugar certo olhando para o lado
   * errado. Quem aponta a câmera livre é `aimCameraAt`, e é o que esta função
   * usa.
   *
   * @param azimuth ângulo em volta do personagem, em radianos. 0 é pela proa.
   */
  function setAvatarView(options: {
    azimuth?: number;
    distance?: number;
    height?: number;
    target?: number;
  } = {}): void {
    const { azimuth = 0.9, distance = 2.6, height = 1.15, target = 0.95 } = options;

    rig.detach();
    const local = match.player.local;
    const root = match.playerShip.model.root;

    const eye = new THREE.Vector3(
      local.x + Math.sin(azimuth) * distance,
      local.y + height,
      local.z + Math.cos(azimuth) * distance,
    );
    const look = new THREE.Vector3(local.x, local.y + target, local.z);
    root.localToWorld(eye);
    root.localToWorld(look);

    camera.position.copy(eye);
    aimCameraAt(look);
    cameraState.velocity.set(0, 0, 0);
  }

  /**
   * Avança a física sem desenhar nada. É o que permite medir regime permanente em
   * milissegundos em vez de esperar o navio acelerar em tempo real.
   */
  function stepPhysics(seconds: number): void {
    const steps = Math.round(seconds * 60);
    // Entrada vazia, e a mesma a cada passo: o que se mede aqui é o navio, e um
    // marujo mexendo no meio da medição é ruído.
    const idle = { player: createInputFrame(), enemy: null };
    for (let i = 0; i < steps; i++) match.fixedUpdate(1 / 60, idle);
    match.update(0, 1);
  }

  /**
   * Mede a velocidade de regime num dado ângulo de vento.
   *
   * @param pointOfSail graus a partir da popa: 0 é vento em popa, 180 pela proa.
   * @returns velocidade em nós depois de `settle` segundos de aceleração.
   */
  function probeSail(pointOfSail: number, settle = 90): number {
    const ship = match.playerShip;
    const heading = downwindHeading(environment.waveField) + pointOfSail * DEG;
    ship.spawn(0, 0, heading, environment.waveField);
    // Sem o duelo rodando, `fixedUpdate` só integra os navios — que é exatamente o
    // que esta medição quer.
    stepPhysics(settle);
    return ship.knots;
  }

  Object.assign(window, {
    __game: {
      THREE,
      renderer,
      scene,
      camera,
      environment,
      engine,
      settings,
      input,
      match,
      rig,
      prompts,
      hud,
      menu,
      audio,
      wake,
      online,
      /**
       * Rede ruim de mentira, para exercitar o netcode fora de `localhost`.
       *
       * Zero milissegundos de ida e volta escondem tudo que o netcode existe
       * para resolver. Um duelo que só foi testado na mesma máquina é um duelo
       * não testado.
       *
       * ```js
       * __game.setSimulatedLag(150, 40, 2)   // 150 ms, 40 de jitter, 2% de perda
       * ```
       */
      setSimulatedLag: (ms: number, jitter = 0, lossPercent = 0) =>
        online.setSimulatedLag(ms, jitter, lossPercent),
      setView,
      setShipView,
      setDuelView,
      setAvatarView,
      stepPhysics,
      probeSail,
    },
  });
}
