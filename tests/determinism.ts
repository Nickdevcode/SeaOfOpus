/**
 * Teste de determinismo — duas partidas com a mesma semente têm de ser a mesma.
 *
 * Como os outros testes do projeto, roda no navegador:
 *
 * ```js
 * const t = await import('/tests/determinism.ts');
 * console.table((await t.runDeterminismTests()).cases);
 * ```
 *
 * **O que se prova aqui, e por que ele é o mais importante dos quatro.** Todo o
 * duelo em rede se apoia numa única promessa: dadas a mesma semente e a mesma
 * sequência de entradas, duas máquinas chegam ao mesmo estado. Se essa promessa
 * falhar, nada do netcode funciona — e o modo como ela falha é o pior possível,
 * porque a divergência começa pequena, cresce sozinha e só aparece quando os dois
 * jogadores já estão discutindo qual dos dois viu o tiro certo.
 *
 * Duas `Match` completas, dois ambientes, um roteiro de entrada só. Rodam lado a
 * lado por 1800 passos (trinta segundos de duelo) e são comparadas **bit a bit** —
 * sem tolerância, de propósito: qualquer folga aqui esconderia justamente o tipo
 * de erro que se acumula.
 *
 * O roteiro de entrada é gerado por `createRandom`, então ele é sempre o mesmo
 * roteiro. Um teste de determinismo com entrada aleatória de verdade seria um
 * teste que só falha às vezes.
 */

import * as THREE from 'three';
import { createRandom } from '../src/core/MathUtils';
import { InputBit, createInputFrame, type InputFrame } from '../src/core/InputFrame';
import { QUALITY_PRESETS } from '../src/core/Settings';
import { Match, type MatchInputs } from '../src/game/Match';
import { Environment } from '../src/world/Environment';

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
 * Passos simulados. 5400 a 60 Hz são noventa segundos de duelo.
 *
 * O número é escolhido pelo relógio do combate, não por gosto: os dois navios
 * nascem a 220 m e levam perto de um minuto para entrar em alcance. Com trinta
 * segundos o teste passava sem que um único tiro tivesse sido dado — e é
 * justamente no dano que moram os dois fluxos de sorteio que entram na
 * simulação (o desvio de pontaria do artilheiro e a escolha de rombo do marujo).
 * Um teste de determinismo que não chega a atirar não testa o que interessa.
 */
const TICKS = 5400;

/** A semente do roteiro de entrada. Fixa: ver o cabeçalho. */
const SCRIPT_SEED = 0xd0d0;

/**
 * Um roteiro de entrada que **mexe em tudo**.
 *
 * Não basta andar: o teste tem de exercitar as bordas de pressionada (que é onde
 * um amostrador mal feito perde ou repete comandos), a troca de posto, a mira e o
 * gatilho. Os pesos são escolhidos para o marujo passar a maior parte do tempo
 * andando e ainda assim assumir peças com regularidade.
 */
function buildScript(ticks: number): InputFrame[] {
  const random = createRandom(SCRIPT_SEED);
  const script: InputFrame[] = [];

  let held = 0;
  for (let tick = 0; tick < ticks; tick++) {
    // O estado segurado muda em blocos, e não a cada passo: alguém que anda,
    // anda por um tempo. Trocar tudo a cada passo testaria um jogador que não
    // existe e esconderia a integração de velocidade.
    if (tick % 24 === 0) {
      held = 0;
      if (random() < 0.75) held |= InputBit.MoveForward;
      if (random() < 0.2) held |= InputBit.MoveBack;
      if (random() < 0.3) held |= InputBit.MoveLeft;
      if (random() < 0.3) held |= InputBit.MoveRight;
      if (random() < 0.35) held |= InputBit.Sprint;
      if (random() < 0.25) held |= InputBit.Interact;
      if (random() < 0.15) held |= InputBit.Aim;
    }

    let pressedBits = 0;
    if (random() < 0.02) pressedBits |= InputBit.Jump;
    if (random() < 0.03) pressedBits |= InputBit.Interact;
    if (random() < 0.02) pressedBits |= InputBit.Exit;
    // Carregar e atirar com frequência: são as duas ações que colocam bala no ar,
    // e é a bala no ar que faz o teste passar pelo dano.
    if (random() < 0.12) pressedBits |= InputBit.Reload;
    if (random() < 0.1) pressedBits |= InputBit.Fire;

    const frame = createInputFrame();
    frame.tick = tick;
    frame.held = held;
    frame.pressed = pressedBits;
    frame.moveX = (held & InputBit.MoveRight ? 1 : 0) - (held & InputBit.MoveLeft ? 1 : 0);
    frame.moveY = (held & InputBit.MoveForward ? 1 : 0) - (held & InputBit.MoveBack ? 1 : 0);
    frame.lookX = (random() - 0.5) * 0.06;
    frame.lookY = (random() - 0.5) * 0.04;
    script.push(frame);
  }

  return script;
}

/**
 * Tudo que define o estado de uma partida, achatado numa lista de números.
 *
 * Achatar é o que permite comparar sem escrever um comparador por subsistema — e
 * o que faz um campo novo entrar no teste só por ser acrescentado aqui.
 */
function fingerprint(match: Match): number[] {
  const out: number[] = [];

  for (const ship of match.ships) {
    const { body } = ship;
    out.push(body.comPosition.x, body.comPosition.y, body.comPosition.z);
    out.push(body.orientation.x, body.orientation.y, body.orientation.z, body.orientation.w);
    out.push(body.velocity.x, body.velocity.y, body.velocity.z);
    out.push(body.angularVelocity.x, body.angularVelocity.y, body.angularVelocity.z);
    out.push(body.floodedMass);

    out.push(ship.rudder.wheelAngle, ship.rudder.rudderAngle);
    out.push(ship.cannonballs, ship.planks);
    out.push(ship.anchor.deploy, ship.anchor.tension);

    for (const cannon of ship.cannons) {
      out.push(cannon.traverse, cannon.elevation, cannon.recoil, cannon.loadProgress);
      out.push(cannon.state === 'empty' ? 0 : cannon.state === 'loading' ? 1 : 2);
    }

    const { damage } = ship;
    out.push(damage.floodVolume, damage.sinkTime, damage.breaches.length, damage.patches.length);
    for (const breach of damage.breaches) {
      out.push(breach.id, breach.local.x, breach.local.y, breach.local.z);
      out.push(breach.area, breach.repair);
    }
    for (const patch of damage.patches) {
      out.push(patch.id, patch.local.x, patch.local.y, patch.local.z, patch.area);
    }
  }

  for (const crewman of match.crew) {
    const c = crewman.controller;
    out.push(c.local.x, c.local.y, c.local.z);
    out.push(c.velocity.x, c.velocity.y, c.velocity.z);
    out.push(c.yaw, c.pitch);
    out.push(c.station === 'deck' ? 0 : c.station === 'helm' ? 1 : 2);
    out.push(c.cannonIndex, c.grounded ? 1 : 0, c.onLadder ? 1 : 0, c.atCapstan ? 1 : 0);
  }

  const waves = match.environment.waveField;
  out.push(waves.time, waves.windStrength, waves.windDirection, waves.swellDirection);

  out.push(match.tick, match.stats.shotsFired, match.stats.shotsLanded);
  out.push(match.stats.breachesDealt, match.stats.breachesTaken);

  return out;
}

/** Uma partida isolada, com cena e ambiente próprios. */
function createMatch(): { match: Match; dispose: () => void } {
  const scene = new THREE.Scene();
  const environment = new Environment(scene, QUALITY_PRESETS.low, { seed: 1337 });
  const match = new Match(scene, environment);
  return {
    match,
    dispose: () => {
      match.dispose();
      environment.dispose();
    },
  };
}

/** O que aconteceu numa execução, para o caso 3 saber se valeu a pena. */
interface RunResult {
  fingerprint: number[];
  shotsFired: number;
  shotsLanded: number;
  playerHoles: number;
  enemyHoles: number;
}

/**
 * Passo a partir do qual o marujo é posto no canhão à força.
 *
 * O roteiro sorteado anda, pula, interage e mira — mas **assumir uma peça**
 * depende de estar no lugar certo apertando o botão certo, e um sorteio quase
 * nunca acerta os dois. Sem isto, o jogador nunca atirava, o navio inimigo nunca
 * levava rombo, e o marujo da máquina nunca precisava escolher qual buraco tapar:
 * um dos dois fluxos de sorteio da simulação ficava inteiro fora do teste.
 *
 * A intervenção é determinística — depende só do passo e do estado, que são
 * iguais nas duas execuções —, então ela não enfraquece o que está sendo provado.
 * 900 passos são quinze segundos: tempo de o duelo se aproximar antes.
 */
const MOUNT_CANNON_AT = 900;

/** Roda o roteiro inteiro numa partida e devolve a assinatura final. */
function run(match: Match, script: readonly InputFrame[]): RunResult {
  match.startSolo('corsair');
  const inputs: MatchInputs = { player: createInputFrame(), enemy: null };
  const mutable = inputs as { player: InputFrame };
  const controller = match.crew[0].controller;

  for (const frame of script) {
    // Remonta sempre que o roteiro tiver largado a peça (o `Exit` é sorteado).
    if (frame.tick >= MOUNT_CANNON_AT && controller.station !== 'cannon') {
      controller.mountCannon(frame.tick % 2 === 0 ? 0 : 1);
    }
    mutable.player = frame;
    match.fixedUpdate(1 / 60, inputs);
  }

  return {
    fingerprint: fingerprint(match),
    shotsFired: match.stats.shotsFired,
    shotsLanded: match.stats.shotsLanded,
    playerHoles: match.playerShip.damage.breaches.length,
    enemyHoles: match.enemyShip.damage.breaches.length,
  };
}

export async function runDeterminismTests(): Promise<TestReport> {
  const cases: TestCase[] = [];
  const script = buildScript(TICKS);

  const matchA = createMatch();
  const matchB = createMatch();

  let a: RunResult;
  let b: RunResult;
  try {
    a = run(matchA.match, script);
    b = run(matchB.match, script);
  } finally {
    matchA.dispose();
    matchB.dispose();
  }

  const first = a.fingerprint;
  const second = b.fingerprint;

  // --- 1. as duas assinaturas têm o mesmo tamanho ------------------------------
  cases.push({
    nome: 'assinatura · mesmo número de campos',
    medido: `${first.length}`,
    esperado: `${second.length}`,
    erro: first.length === second.length ? '—' : 'listas de rombos divergiram',
    passou: first.length === second.length,
  });

  // --- 2. bit a bit, sem tolerância -------------------------------------------
  let mismatches = 0;
  let worst = 0;
  let worstIndex = -1;
  const shared = Math.min(first.length, second.length);
  for (let i = 0; i < shared; i++) {
    const delta = Math.abs(first[i]! - second[i]!);
    if (delta === 0) continue;
    mismatches++;
    if (delta > worst) {
      worst = delta;
      worstIndex = i;
    }
  }

  cases.push({
    nome: `${TICKS} passos · estado idêntico`,
    medido: `${mismatches} campos divergentes`,
    esperado: '0 campos divergentes',
    erro:
      mismatches === 0
        ? '—'
        : `pior: campo ${worstIndex}, Δ ${worst.toExponential(3)}`,
    passou: mismatches === 0,
  });

  // --- 3. o roteiro fez alguma coisa ------------------------------------------
  // Um teste de determinismo passa trivialmente se nada acontecer. Este caso é o
  // que impede o teste de virar decoração no dia em que o roteiro parar de mexer
  // no jogo — dois navios parados são idênticos e não provam nada.
  const moved = Math.hypot(first[0]!, first[2]!);
  const shots = a.shotsFired + a.shotsLanded;
  const holes = a.playerHoles + a.enemyHoles;
  cases.push({
    nome: 'roteiro · o duelo de fato aconteceu',
    medido: `${moved.toFixed(1)} m · ${shots} tiros · ${holes} rombos`,
    esperado: '> 20 m, com tiro e rombo',
    erro:
      moved > 20 && shots > 0 && holes > 0
        ? '—'
        : 'sem combate, o teste não exercita os sorteios da simulação',
    passou: moved > 20 && shots > 0 && holes > 0,
  });

  const falhas = cases.filter((c) => !c.passou).length;
  return { passou: falhas === 0, total: cases.length, falhas, cases };
}
