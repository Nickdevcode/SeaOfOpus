/**
 * Ponto de entrada: monta o mundo, entrega o jogo ao `Match` e roda o laço.
 *
 * O que mora aqui é a **apresentação** — renderizador, cena, câmera, ambiente,
 * esteira, motor e entrada. O que é *jogo* é do `Match`: os dois navios, o capitão
 * inimigo, as balas, o jogador a bordo. A divisa vale um parágrafo porque ela é o
 * que permite reiniciar um duelo sem reconstruir o oceano nem regerar as texturas
 * do casco, que juntos custam décimos de segundo.
 *
 * A ordem dentro do laço é a que os comentários de cada bloco justificam. Nenhuma
 * delas é gosto: passo fixo antes do quadro, pose interpolada antes da câmera,
 * passes fora de tela antes do render.
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
  // O near fica em 15 cm: perto o suficiente para a primeira pessoa a bordo e
  // longe o suficiente para o depth buffer de 24 bits aguentar os 12 km de far.
  0.15,
  12000,
);

const environment = new Environment(scene, settings.quality, {
  dayLengthMinutes: settings.preferences.dayLengthMinutes,
});

/**
 * Hora em que o jogo abre: meio da tarde (≈16h20).
 *
 * `timeOfDay` é a fração do dia, então 0,68 × 24 h. É direção de arte, não física: o
 * sol baixo dá luz rasante no costado, sombra comprida no convés e um mar dourado
 * atrás do título, que é a primeira coisa que alguém vê do jogo. Ao meio-dia a luz
 * vem de cima, achata o casco e apaga o relevo das tábuas. O ciclo segue correndo
 * daqui normalmente — isto escolhe só onde ele começa.
 */
environment.dayNight.timeOfDay = 0.68;

const wake = new WakeFoam(settings.quality);

const input = new Input();
input.attach(renderer.canvas);

renderer.compose(scene, camera, environment.sky.sunMesh);

// --- áudio -------------------------------------------------------------------
// O contexto de áudio só pode abrir dentro de um gesto do jogador — é regra de
// todo navegador atual. Qualquer clique ou tecla serve, e depois do primeiro a
// chamada é barata (só confere se o contexto foi suspenso ao trocar de aba).
const audio = new GameAudio();
const unlockAudio = (): void => audio.unlock();
window.addEventListener('pointerdown', unlockAudio);
window.addEventListener('keydown', unlockAudio);

// --- jogo --------------------------------------------------------------------
// `match` é preenchido logo abaixo, mas o menu precisa referenciá-lo nos callbacks
// dele — que só disparam por clique, muito depois das duas linhas rodarem.
let match!: Match;

const rig = new CameraRig(camera);
const prompts = new Prompts(uiRoot);
const hud = new CombatHud(uiRoot);

// A conversa com o servidor de sala. Nasce sabendo se há servidor: sem a variável
// de ambiente, o modo online é apagado na tela de título em vez de falhar depois.
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
    // Em rede, quem anuncia o fim é a sala: só o host simula, e o guest chega a
    // este estado por instantâneo, meio segundo depois. Deixar os dois caminhos
    // abrirem a tela daria dois resultados sobrepostos no lado do host.
    if (match.role !== 'solo') return;
    audio.outcome(state === 'won');
    menu.showOutcome(state === 'won', match.stats);
  },
});

// Depois do `match`, e não antes: a sessão guarda a referência para simular e
// serializar. Criada acima, ela guardaria `undefined` — e o erro só apareceria no
// primeiro instantâneo de um duelo em rede, muito longe daqui.
online = new OnlineSession(import.meta.env.VITE_ROOM_SERVER, match);

menu.setOnlineAvailable(
  online.available,
  'Online play is not configured in this build.',
);
online.onChange((state) => menu.setOnlineState(state));

online.onStart((config) => {
  // O mundo vem da sala, e não das preferências locais: o mar dos dois lados tem
  // de ser o mesmo mar. Ver a nota sobre o modo de tempo em `DuelRoom.onReady`.
  //
  // As três linhas são o mundo inteiro: a semente dita as ondas e a sequência de
  // viradas de tempo, o modo dita o tempo, e a hora dita a luz. Faltando as duas
  // últimas — como faltavam —, dois capitães entravam no mesmo mar sob céus
  // diferentes, cada um com o relógio que a tela de título dele tinha alcançado.
  environment.reseed(config.seed);
  environment.setWeatherMode(config.weather);
  environment.dayNight.timeOfDay = config.timeOfDay;
  // A preferência local de tempo fica de fora enquanto durar o duelo, e a
  // guarda de `applyPreferences` é que a segura. Aqui só se apaga a memória do
  // que estava aplicado, para o valor da sala não ser confundido com ele.
  appliedWeather = null;
  menu.show('none');
  match.startOnline(config.role);
});

online.onOver((won, reason) => {
  if (menu.current === 'outcome') return;
  audio.outcome(won);
  menu.showOutcome(won, match.stats, 'online');
  online.leave();
  void reason;
});

/**
 * Clicar em qualquer lugar pede o ponteiro — mas só quando se está de fato
 * jogando, senão o menu perderia o cursor no primeiro clique de botão.
 *
 * O ouvinte fica na **janela**, e não no canvas, e a diferença já custou uma
 * sessão inteira de teste: as camadas de interface cobrem a tela toda, e basta
 * uma delas esquecer o `pointer-events: none` para o canvas parar de receber
 * clique — o jogo continua desenhando, o teclado continua andando, e só a câmera
 * do mouse morre, que é o sintoma mais difícil de ligar à causa. Na janela, o
 * clique chega por borbulhamento venha ele de onde vier. (A camada culpada era o
 * HUD; ver a nota em `hud.css`.)
 */
window.addEventListener('click', () => {
  if (!menu.open && match.running) input.requestPointerLock();
});

/**
 * Alinha a casca ao estado do menu: quem recebe entrada, o que aparece na tela e
 * onde a câmera fica.
 *
 * Roda quando a tela muda, e não a cada quadro, porque tudo aqui é troca de estado.
 * A câmera livre de inspeção (`C`) é respeitada: o modo `detached` nunca é
 * atropelado, senão a bancada de capturas perderia o enquadramento no primeiro
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
  }
}

let lastScreen: Screen | null = null;
syncShell();

// --- câmera livre de inspeção (DEV) ------------------------------------------
// Fica fora do jogo: `C` solta a câmera do jogador para inspecionar a cena de
// fora, e é o que a bancada `__game` usa para posicionar capturas de tela.
const cameraState = {
  yaw: 0,
  pitch: -0.08,
  speed: 14,
  velocity: new THREE.Vector3(),
};

/** Aponta a câmera livre para um ponto do mundo, sem mexer na posição dela. */
function aimCameraAt(target: THREE.Vector3): void {
  const to = target.clone().sub(camera.position);
  // atan2(-x, -z) porque a câmera olha para -Z quando o yaw é zero.
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

  // Amortecimento independente do frame rate: acelera e para com peso.
  cameraState.velocity.x = damp(cameraState.velocity.x, target.x, 9, dt);
  cameraState.velocity.y = damp(cameraState.velocity.y, target.y, 9, dt);
  cameraState.velocity.z = damp(cameraState.velocity.z, target.z, 9, dt);

  camera.position.addScaledVector(cameraState.velocity, dt);

  // Não deixa a câmera mergulhar: por enquanto não há visual submerso.
  const waterHeight = environment.sampleHeight(camera.position.x, camera.position.z);
  camera.position.y = Math.max(camera.position.y, waterHeight + 0.8);
}

/** Solta a câmera do jogador e a põe onde ela está agora, olhando para o mesmo lado. */
function detachCamera(): void {
  rig.detach();
  const forward = new THREE.Vector3(0, 0, -1).applyQuaternion(camera.quaternion);
  cameraState.yaw = Math.atan2(-forward.x, -forward.z);
  cameraState.pitch = Math.asin(clamp(forward.y, -1, 1));
  cameraState.velocity.set(0, 0, 0);
}

/**
 * `C` alterna entre jogar e voar de câmera livre pela cena.
 *
 * Passa pelo sistema de ações (`freeCamera`), e não por um `keydown` solto na
 * janela como antes. A diferença não é organização: um ouvinte próprio ignora o
 * `input.captured`, e apertar `C` na tela de título soltava a câmera para o modo
 * `detached` — do qual `syncShell` nunca tira ninguém, de propósito. A órbita
 * cinematográfica atrás do menu morria ali e só voltava recarregando a página.
 */
function toggleFreeCamera(): void {
  if (rig.mode === 'detached') rig.attachPlayer();
  else detachCamera();
}

/**
 * Como o adversário é anunciado no HUD.
 *
 * Contra a máquina é a intenção do capitão, que é meia leitura do duelo — ver
 * alguém em "Tapando rombos" diz mais que qualquer barra de vida. Em rede é o
 * apelido de quem está do outro lado, porque a intenção de uma pessoa não é
 * nossa para contar.
 */
function foeLabel(): string {
  return match.ai ? INTENT_LABELS[match.ai.intent] : online.opponentName;
}

// --- overlay de telemetria ---------------------------------------------------
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

  // 'YXZ' separa guinada, caturro e balanço na ordem em que se lê um navio.
  _shipEuler.setFromQuaternion(ship.body.orientation, 'YXZ');

  // Ângulo do vento aparente medido a partir da popa: 0° é vento em popa (o rumo
  // mais rápido) e 180° é vento pela proa.
  const windSpeed = ship.sail.localWind.length();
  const pointOfSail = windSpeed > 0.01
    ? Math.acos(clamp(-ship.sail.localWind.z / windSpeed, -1, 1)) * RAD
    : 0;

  // Uma leitura só: o getter monta um objeto, e o overlay usa nove campos dele.
  const avatar = match.avatar.debug;

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
    // As linhas do capitão da máquina só existem quando há um. Em rede, o que
    // sobra é o que se pode medir de fora: o casco do outro e o contato.
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
          `enemy crew ${match.crew[1].controller.station}  ·  local x ${match.crew[1].controller.local.x.toFixed(2)}  z ${match.crew[1].controller.local.z.toFixed(2)}`,
        ]),
    `contact ${match.contact.contacts} points  ·  depth ${(match.contact.depth * 100).toFixed(0)} cm`,
    // O bloco de rede só existe num duelo em rede, e é o painel que diz se o
    // netcode está saudável. Os alvos: rtt < 120 ms, jitter < 30, fila entre 2 e
    // 4, fome perto de zero, erro de predição abaixo de 5 cm.
    ...(net
      ? [
          '',
          `net ${match.role}  ·  rtt ${net.rtt.toFixed(0)} ms  ·  jitter ${net.jitter.toFixed(0)} ms${net.stalled ? '  ·  HOST IN BACKGROUND' : ''}`,
          `queue ${net.depth} frames  ·  starves ${net.starves}  ·  lead ${net.lead}  ·  prediction ${(net.error * 100).toFixed(1)} cm`,
        ]
      : []),
    '',
    `player ${match.player.station}${match.player.onLadder ? ' (ladder)' : ''}${match.player.grounded ? '' : ' (airborne)'}  ·  local x ${match.player.local.x.toFixed(2)}  y ${match.player.local.y.toFixed(2)}  z ${match.player.local.z.toFixed(2)}`,
    `body ${match.avatar.root.visible ? 'worn' : 'hidden'}  ·  legs ${(avatar.twist * RAD).toFixed(0)}° ${avatar.reversed ? 'reverse' : 'forward'}  ·  head clip ${avatar.headClip >= HEAD_CLIP_OFF ? 'off' : avatar.headClip.toFixed(2)}  ·  gait w ${avatar.walk.toFixed(2)} r ${avatar.run.toFixed(2)} i ${avatar.idle.toFixed(2)} air ${avatar.air.toFixed(2)} climb ${avatar.climb.toFixed(2)} helm ${avatar.helm.toFixed(2)}`,
    `cannons ${ship.cannons.map((c) => c.state).join(' / ')}  ·  locker ${ship.cannonballs} shot / ${ship.planks} planks  ·  focus ${match.interaction.focus?.id ?? '—'}`,
    `shot in flight ${match.cannonballs.activeCount}  ·  particles ${match.effects.liveCount}`,
    `camera ${rig.mode} (C)  ·  x ${camera.position.x.toFixed(1)}  y ${camera.position.y.toFixed(2)}  z ${camera.position.z.toFixed(1)}`,
    `ocean ${environment.ocean.getTriangleCount().toLocaleString('en-US')} triangles`,
    `preset ${settings.preferences.quality}  ·  ${renderer.getGpuInfo()}`,
    input.gamepad.connected ? `gamepad: ${input.gamepad.deviceName}` : 'gamepad: none',
  ].join('\n');
}

// --- guarda de desempenho ----------------------------------------------------

/**
 * O preset desce sozinho quando a máquina não sustenta o que ela pediu.
 *
 * A detecção por nome de GPU (ver `detectPreset`) acerta a ordem de grandeza e
 * erra o resto: ela não sabe a resolução do monitor, não sabe se há um navegador
 * com quarenta abas do lado, e não sabe que este jogador está **hospedando** um
 * duelo, o que põe a física de dois cascos na mesma máquina. Quando erra, o
 * jogador fica com um jogo a vinte quadros e nenhuma pista de que a solução está
 * a dois cliques de distância no menu.
 *
 * Três decisões que valem por si:
 *
 * - **Só desce.** Subir de volta ao primeiro trecho tranquilo daria um jogo que
 *   oscila entre dois presets, e o pior momento de uma queda de quadros é o
 *   combate, que é exatamente quando ela voltaria.
 * - **Precisa de uma janela inteira abaixo do alvo.** Um engasgo de meio segundo
 *   ao carregar uma textura não é uma máquina fraca; seis segundos seguidos são.
 * - **Vale o que ficou gravado.** A escolha persiste, então quem abriu o jogo
 *   numa máquina modesta já começa a próxima sessão no preset que funcionou.
 */
const AUTO_QUALITY_FPS = 40;
const AUTO_QUALITY_WINDOW = 6;
/** Carência depois de descer um degrau: dá tempo de o preset novo se assentar. */
const AUTO_QUALITY_COOLDOWN = 10;

let lowFrameRateTime = 0;
let autoQualityCooldown = AUTO_QUALITY_COOLDOWN;

function guardPerformance(dt: number): void {
  // Só durante a partida: o menu tem órbita cinematográfica e transições, e é
  // onde a taxa de quadros diz menos sobre o que a máquina aguenta jogando.
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
    // Decai em vez de zerar: uma máquina que oscila em volta do alvo ainda
    // acumula, só que mais devagar. Zerar deixaria o caso mais comum de todos —
    // o que passa de 40 de vez em quando — nunca disparar.
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
 * O tradutor entre o relógio do monitor e o da simulação.
 *
 * Amostra a entrada em `beginFrame` (que roda antes dos passos fixos) e entrega
 * um quadro por passo. Ver `InputSampler` para os dois bugs que ele existe para
 * não deixar acontecer.
 */
const sampler = new InputSampler();

/**
 * A entrada do passo, montada uma vez e reaproveitada.
 *
 * `enemy` fica em `null` enquanto o adversário é a máquina; quando um segundo
 * jogador entrar, é aqui que o quadro dele chega. Nenhum dos dois campos aloca
 * por tick.
 */
const matchInputs = { player: createInputFrame(), enemy: null as InputFrame | null };

engine.start({
  beginFrame: (dt) => {
    input.beginFrame(dt);
    // Só amostra o que vale como comando: com o menu no ar, ou com a câmera solta
    // para inspeção, o marujo recebe passos de entrada vazia em vez de nenhum
    // passo — a simulação continua correndo, que é o que o mundo de fundo pede.
    sampler.setLive(!menu.open && rig.mode === 'player' && match.running);
    sampler.sample(input);
  },
  fixedUpdate: (dt, tick) => {
    const guest = online.guest;
    if (guest) {
      // O cliente magro amostra a entrada no **relógio de predição**, à frente do
      // host, para que ela chegue lá no instante em que for consumida. Ver os três
      // relógios em `GuestSession`.
      const frame = sampler.consume(guest.predictionTick());
      match.fixedUpdateRemote(dt, frame);
      guest.fixedUpdate(frame);
      return;
    }

    matchInputs.player = sampler.consume(tick);
    // Contra a máquina isto é `null` e quem pilota o outro casco é o `ShipAI`.
    matchInputs.enemy = online.enemyInput(match.tick + 1);
    match.fixedUpdate(dt, matchInputs);
    online.afterHostStep(match.tick);
  },
  update: (dt, alpha) => {
    // O menu primeiro: ele decide se o resto do quadro é jogo ou vitrine.
    menu.update(input, dt);
    // Fora do `if` do menu de propósito: a sessão também tem de correr com o menu
    // fechado, que é quando a partida em rede acontece.
    online.update(dt);
    if (menu.open) {
      // Com a entrada congelada, `Input` deixa passar `Esc` do teclado e os botões
      // Menu e View do controle — o suficiente para fechar o que está aberto sem
      // precisar largar o aparelho que abriu. `Tab` fica de fora de propósito:
      // congelado, ele é a navegação de foco do próprio menu.
      if (input.wasPressed('pause')) menu.back();
      // View faz o caminho de ida e de volta com o mesmo aperto: abre a tela de
      // controles de onde estiver, e a fecha quando ela já é a que está no ar.
      if (input.wasPressed('controls')) {
        if (menu.current === 'controls') menu.back();
        else menu.openOverlay('controls');
      }
    } else {
      if (input.wasPressed('pause')) menu.openOverlay('settings');
      if (input.wasPressed('controls')) menu.openOverlay('controls');
      // Congelado, `freeCamera` nem chega aqui: é o menu barrando a câmera livre.
      if (input.wasPressed('freeCamera')) toggleFreeCamera();
    }

    if (menu.current !== lastScreen) {
      lastScreen = menu.current;
      syncShell();
    }

    // O resíduo de olhar entra aqui: é ele que dá à câmera a taxa do monitor com
    // a cabeça andando a 60 Hz. Ver `PlayerController.syncView`.
    match.update(dt, alpha, sampler.pendingLookX, sampler.pendingLookY);
    // O desvio de reconciliação some em dois décimos de segundo. Ver `GuestSession`.
    online.guest?.decayOffset(dt);

    // A pose interpolada já foi escrita por `match.update`, então a câmera lê a
    // matriz do quadro e não a do anterior — do contrário ela seguiria um frame
    // atrás e tremeria contra o convés.
    if (rig.mode === 'detached') updateFreeCamera(dt);
    else rig.update(dt, match.player, match.playerShip);

    // O laço só informa **de onde o corpo está sendo olhado**; se ele aparece, e
    // com ou sem cabeça, é decisão do próprio personagem. Ver `PlayerAvatar`.
    match.avatar.update(dt, match.player, rig.mode === 'player');

    environment.update(dt, camera.position);

    prompts.update(input, match.interaction, match.player, match.playerShip);
    hud.update(match.playerShip, match.enemyShip, foeLabel(), camera, environment.waveField);

    // O ouvido acompanha a câmera, e não o navio: no canhão a cabeça vai para trás
    // da culatra, e é de lá que o jogador escuta.
    audio.setListener(camera);
    audio.setSeaState(environment.waveField.windStrength, environment.dayNight.nightFactor);

    // As lanternas acendem sozinhas conforme a noite fecha.
    for (const ship of match.ships) {
      ship.model.setLanternIntensity(environment.dayNight.nightFactor);
    }
    guardPerformance(dt);
    updateDebug(dt);
    input.endFrame();
  },
  render: (dt) => {
    // Os dois passes fora de tela vêm antes do quadro. A esteira carimba na pose
    // que `syncModel` acabou de escrever, e a textura troca de lugar a cada quadro
    // (ping-pong), então o oceano tem de ser reapontado sempre.
    wake.update(renderer.webgl, dt, match.ships);
    environment.ocean.setWake(wake.texture, wake.center, wake.size, 1);
    // A LUT do céu precisa estar pronta antes do render: mar e domo leem dela.
    environment.prepare(renderer.webgl);
    renderer.render(dt);
  },
});

window.addEventListener('resize', () => renderer.resize());

/**
 * Espalha as preferências para quem as consome.
 *
 * Roda na troca, e não a cada quadro, porque tudo aqui é caro ou é estado: o
 * preset gráfico remonta a cadeia de pós-processamento, o campo de visão
 * recompõe a matriz de projeção e o tempo travado interrompe a máquina de
 * estados do clima.
 *
 * ## Por que há guardas de igualdade aqui
 *
 * "Na troca" era mentira para quem arrasta um deslizante: cada pixel de arraste
 * emite um `input`, e cada `input` chamava esta função **inteira**. Mudar o
 * volume descartava e remontava o `EffectComposer` (Bloom, GodRays, SMAA) dezenas
 * de vezes por segundo e, pior, `Environment.applyQuality` regera o campo de
 * ondas — o mar da partida em curso era ressemeado no meio de um tiro em voo.
 *
 * As guardas ficam deste lado porque é aqui que se sabe **o que** mudou:
 * `applyQuality` recebe um objeto de preset e não tem como distinguir "de novo o
 * mesmo" de "a primeira vez". O preço é lembrar do valor anterior; o ganho é que
 * volume, sensibilidade e campo de visão continuam aplicando a cada quadro de
 * arraste, que é o que o jogador precisa ver enquanto calibra.
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

  // `Weather.set` reinicia rajada, relâmpago e contagem regressiva. Reaplicar o
  // mesmo modo a cada quadro de arraste zerava a rajada antes de ela existir, e o
  // vento travado ficava liso como uma tabela.
  //
  // Num duelo em rede o modo é da **sala**, e o menu não manda nele: o vento
  // entra na força da vela, então um capitão que trocasse para "calmaria" no
  // meio da partida estaria escolhendo o próprio mar. Quem simula ignora a
  // preferência; quem não simula recebe o tempo pronto no instantâneo de
  // qualquer forma.
  if (prefs.weather !== appliedWeather && match.role === 'solo') {
    appliedWeather = prefs.weather;
    environment.setWeatherMode(prefs.weather);
  }

  // Estes três são atribuições idempotentes e baratas: aplicam sempre, e é o que
  // dá o retorno imediato do deslizante enquanto ele está sendo arrastado.
  environment.dayNight.dayLengthSeconds = prefs.dayLengthMinutes * 60;
  match.player.setFieldOfView(prefs.fieldOfView);
}

settings.onChange(applyPreferences);
applyPreferences(settings.preferences);

// Bancada de inspeção para os testes automatizados (paridade de onda, sondagem da
// LUT do céu, telemetria de física, condução do duelo sem menu). Só existe em dev —
// o build de produção remove o bloco inteiro por dead-code elimination.
if (import.meta.env.DEV) {
  /**
   * Congela a cena num estado exato para comparar capturas de tela entre ajustes
   * de shader. Sem isso o sol anda entre um screenshot e o outro e qualquer
   * diferença vira ruído.
   *
   * `yawTowardSun` aponta a câmera para o sol (`1`), para o lado oposto (`-1`) ou
   * para 90° dele (`0`), sempre relativo à posição atual do astro.
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
    // atan2(x, z) porque a câmera olha para -Z com yaw = 0.
    const sunYaw = Math.atan2(sun.x, sun.z) + Math.PI;
    cameraState.yaw = sunYaw + (1 - yawTowardSun) * (Math.PI / 2);
    cameraState.pitch = pitch;
    cameraState.velocity.set(0, 0, 0);
    camera.position.set(0, height, 0);
  }

  /** Órbita ao redor de um dos navios, para inspecionar o modelo de todos os lados. */
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
