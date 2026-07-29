/**
 * Teste do instantâneo — o que o host escreve é o que o convidado lê?
 *
 * ```js
 * const s = await import('/tests/snapshot.ts');
 * console.table(s.runSnapshotTests().cases);
 * ```
 *
 * ## Por que este teste existe
 *
 * Porque o formato de rede tem uma classe de defeito que **nenhum outro teste
 * pega e nenhum jogador consegue descrever**: um campo que o escritor manda e o
 * leitor não lê (ou lê na ordem errada). Não há erro, não há exceção, não há
 * `NaN`. O que acontece é que todos os campos dali para a frente saem
 * deslocados, e o jogo do outro lado passa a mostrar valores que pertencem a
 * outra coisa — o rumo do vento lido como fração do dia, o marujo lido como
 * lista de eventos.
 *
 * Os dois defeitos reais que motivaram este arquivo:
 *
 * - **O rumo da ondulação de fundo não viajava.** Só que o sintoma era "o navio
 *   dele flutua estranho", que ninguém liga a um campo faltando.
 * - **A lista de rombos tinha tetos diferentes nos dois lados** — o escritor
 *   mandava quantos houvesse, o leitor parava em 32. Acima disso o instantâneo
 *   inteiro saía do lugar, e o duelo do convidado virava ruído.
 *
 * ## Como ele testa
 *
 * Montando um mundo **falso e todo diferente**: cada campo recebe um valor
 * distinto e improvável, escolhido para que um deslocamento de bytes não possa
 * passar despercebido. Zeros e valores repetidos são o inimigo aqui — dois
 * campos trocados de lugar com o mesmo valor dentro parecem certos.
 *
 * O `Match` é pato-tipado: `encodeSnapshot` só lê campos simples, então não é
 * preciso montar um navio de verdade (nem uma tela, o que permite rodar isto
 * fora do navegador).
 */

import * as THREE from 'three';
import { MAX_BREACHES } from '../shared/protocol';
import type { Match } from '../src/game/Match';
import type { MatchEvent } from '../src/game/MatchEvents';
import { encodeSnapshot } from '../src/net/snapshotCodec';
import { createWorldState, decodeSnapshot } from '../src/net/WorldState';

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
 * Tolerância de cada grandeza, em unidades dela.
 *
 * Sai da escala de quantização de `QUANT`, com uma folga de arredondamento: o
 * formato **é** com perda, e cobrar igualdade exata seria reprovar o desenho em
 * vez de testá-lo. O que se prova aqui é que a perda cabe onde ela foi
 * projetada para caber.
 */
const TOLERANCE = {
  angle: 1e-4,
  quaternion: 1e-4,
  velocity: 5e-3,
  angular: 1e-3,
  local: 5e-3,
  breach: 3e-3,
  /** Um byte sobre 0..1. */
  byte: 3e-3,
  /** Fração do dia sobre `u16`. */
  timeOfDay: 2e-5,
} as const;

/** Um valor por campo, todos diferentes. Ver o cabeçalho. */
function makeShip(seed: number) {
  const n = (offset: number) => seed + offset;
  const orientation = new THREE.Quaternion()
    .setFromEuler(new THREE.Euler(n(0.11), n(0.23), n(0.07), 'YXZ'))
    .normalize();

  return {
    body: {
      comPosition: new THREE.Vector3(n(120.5), n(1.25), n(-340.75)),
      orientation,
      velocity: new THREE.Vector3(n(3.5), n(-0.75), n(2.25)),
      angularVelocity: new THREE.Vector3(n(0.35), n(-0.15), n(0.55)),
    },
    rudder: { wheelAngle: n(0.85) },
    cannonballs: 137 + seed,
    planks: 41 + seed,
    anchor: { state: seed === 0 ? 'dropping' : 'raising', deploy: seed === 0 ? 0.25 : 0.75 },
    cannons: [
      { traverse: n(0.21), elevation: n(0.33), state: 'loading', loadProgress: 0.44, recoil: 0.19 },
      { traverse: n(-0.17), elevation: n(0.09), state: 'loaded', loadProgress: 1, recoil: 0.31 },
    ],
    damage: {
      floodFraction: seed === 0 ? 0.375 : 0.8125,
      sinkTime: seed === 0 ? 2.5 : 0,
      breaches: [] as ReturnType<typeof makeBreach>[],
      patches: [] as ReturnType<typeof makePatch>[],
    },
  };
}

function makeBreach(index: number, seed: number) {
  return {
    id: 1 + index + seed * 40,
    local: new THREE.Vector3(1.1 + index * 0.05, -0.4 + index * 0.03, 2.2 - index * 0.07),
    normal: new THREE.Vector3(0.6, 0.2, -0.77).normalize(),
    area: 0.055 * (1 + (index % 3) * 0.6),
    repair: ((index * 7) % 10) / 10,
  };
}

function makePatch(index: number, seed: number) {
  return {
    id: 200 - index - seed * 30,
    local: new THREE.Vector3(-1.4 + index * 0.06, -0.2 - index * 0.02, -3.1 + index * 0.09),
    normal: new THREE.Vector3(-0.5, 0.1, 0.86).normalize(),
    area: 0.055 * (1 + (index % 4) * 0.5),
  };
}

function makeCrew(seed: number) {
  return {
    controller: {
      local: new THREE.Vector3(0.85 + seed, 1.45 - seed * 0.5, -2.35 + seed),
      yaw: seed === 0 ? 1.9375 : -2.5625,
      pitch: seed === 0 ? -0.4375 : 0.6875,
      station: seed === 0 ? 'helm' : 'cannon',
      cannonIndex: seed === 0 ? -1 : 1,
      grounded: seed === 0,
      onLadder: seed !== 0,
      atCapstan: seed === 0,
    },
  };
}

/** Todos os cinco tipos de evento, cada um com números próprios. */
function makeEvents(): MatchEvent[] {
  return [
    {
      kind: 'shot',
      ship: 1,
      position: new THREE.Vector3(11.5, 3.25, -7.75),
      direction: new THREE.Vector3(0.7, 0.14, -0.7).normalize(),
    },
    { kind: 'splash', position: new THREE.Vector3(-22.5, 0.5, 41.25), speed: 37 },
    {
      kind: 'hull',
      ship: 1,
      position: new THREE.Vector3(5.75, 1.5, -3.25),
      normal: new THREE.Vector3(-0.3, 0.4, 0.86).normalize(),
      speed: 63,
      flooded: true,
    },
    { kind: 'mast', ship: 0, position: new THREE.Vector3(0.25, 8.5, 2.75), speed: 51 },
    { kind: 'collision', position: new THREE.Vector3(-3.5, 0.75, 9.25), speed: 12 },
  ];
}

function makeMatch(breaches: number): Match {
  const ships = [makeShip(0), makeShip(1)];
  for (const [slot, ship] of ships.entries()) {
    for (let i = 0; i < breaches; i++) ship.damage.breaches.push(makeBreach(i, slot));
    for (let i = 0; i < breaches; i++) ship.damage.patches.push(makePatch(i, slot));
  }

  return {
    tick: 987654,
    ships,
    crew: [makeCrew(0), makeCrew(1)],
    netEvents: makeEvents(),
    environment: {
      waveField: {
        windDirection: 1.3125,
        windStrength: 0.625,
        time: 412.5,
        swellDirection: -2.1875,
      },
      weather: {
        current: 'squall',
        target: 'storm',
        windBase: 0.75,
        clouds: 0.875,
        rain: 0.5,
        visibility: 1450,
        flash: 0.25,
      },
      dayNight: { timeOfDay: 0.7365 },
    },
  } as unknown as Match;
}

export function runSnapshotTests(): TestReport {
  const cases: TestCase[] = [];

  const check = (nome: string, medido: string, esperado: string, ok: boolean, erro: string) => {
    cases.push({ nome, medido, esperado, erro: ok ? '—' : erro, passou: ok });
  };

  // --- 1. o mundo inteiro sobrevive à ida e volta ------------------------------
  {
    const match = makeMatch(3);
    const world = createWorldState();
    const header = decodeSnapshot(
      encodeSnapshot(match, {
        bufferDepth: 7,
        starved: 3,
        ackTick: 123456,
        includeBreaches: true,
        over: true,
        winner: 1,
      }),
      world,
    );

    check(
      'cabeçalho · tick, fila, fome, recibo e desfecho',
      header
        ? `tick ${header.tick} · fila ${header.bufferDepth} · fome ${header.starved} · ack ${header.ackTick} · fim ${header.over}/${header.winner}`
        : 'não decodificou',
      'tick 987654 · fila 7 · fome 3 · ack 123456 · fim true/1',
      Boolean(
        header &&
          header.tick === 987654 &&
          header.bufferDepth === 7 &&
          header.starved === 3 &&
          header.ackTick === 123456 &&
          header.over &&
          header.winner === 1,
      ),
      'o cabeçalho não é o que foi escrito',
    );

    const waves = match.environment.waveField;
    const windError = Math.abs(world.windDirection - waves.windDirection);
    // ⚠️ Este é o campo que faltava, e o caso que este arquivo existe para ter.
    const swellError = Math.abs(world.swellDirection - waves.swellDirection);
    check(
      'mar · vento, força, relógio e **ondulação de fundo**',
      `vento ±${windError.toExponential(1)} · swell ±${swellError.toExponential(1)} · tempo ${world.waveTime}`,
      `os três dentro de ${TOLERANCE.angle}, tempo exato`,
      windError < TOLERANCE.angle &&
        swellError < TOLERANCE.angle &&
        Math.abs(world.windStrength - waves.windStrength) < TOLERANCE.byte &&
        world.waveTime === waves.time,
      'um campo do mar não atravessou o fio — os dois lados navegam mares diferentes',
    );

    const weather = match.environment.weather;
    check(
      'céu · tempo, transição, nuvem, chuva, visibilidade e clarão',
      `${world.sky.current}→${world.sky.target} · nuvem ${world.sky.clouds.toFixed(3)} · vis ${world.sky.visibility} · hora ${world.sky.timeOfDay.toFixed(4)}`,
      'squall→storm · nuvem 0.875 · vis 1450 · hora 0.7365',
      world.sky.current === weather.current &&
        world.sky.target === weather.target &&
        Math.abs(world.sky.baseWind - weather.windBase) < TOLERANCE.byte &&
        Math.abs(world.sky.clouds - weather.clouds) < TOLERANCE.byte &&
        Math.abs(world.sky.rain - weather.rain) < TOLERANCE.byte &&
        world.sky.visibility === weather.visibility &&
        Math.abs(world.sky.flash - weather.flash) < TOLERANCE.byte &&
        Math.abs(world.sky.timeOfDay - match.environment.dayNight.timeOfDay) < TOLERANCE.timeOfDay,
      'um lado navega sob um céu que o outro não vê',
    );

    cases.push(...shipCases(match, world));
    cases.push(...crewCases(match, world));
    cases.push(...eventCases(match, world));
  }

  // --- 2. o casco no teto de rombos não desalinha o quadro ----------------------
  //
  // O caso que quebrava tudo: enquanto escritor e leitor tinham tetos
  // diferentes, um casco muito castigado deslocava **todo o resto** do
  // instantâneo. O sintoma não era um rombo a mais faltando; era o marujo, o
  // adversário e os eventos lidos em cima de bytes de outra coisa.
  {
    const match = makeMatch(MAX_BREACHES);
    const world = createWorldState();
    const header = decodeSnapshot(
      encodeSnapshot(match, {
        bufferDepth: 2,
        starved: 0,
        ackTick: 42,
        includeBreaches: true,
        over: false,
        winner: 0,
      }),
      world,
    );

    const crew = world.crew[1]!;
    const source = match.crew[1]!.controller;
    // Se os bytes tivessem escorregado, o marujo — que é lido **depois** das duas
    // listas de estrago — sairia em qualquer lugar menos onde ele está.
    const intact =
      Boolean(header) &&
      world.ships[0]!.breaches?.length === MAX_BREACHES &&
      world.ships[1]!.patches?.length === MAX_BREACHES &&
      crew.station === source.station &&
      crew.local.distanceTo(source.local) < TOLERANCE.local &&
      world.events.length === 5;

    check(
      'teto · casco com a lista cheia não desloca o resto do quadro',
      `rombos ${world.ships[0]!.breaches?.length} · tábuas ${world.ships[1]!.patches?.length} · posto "${crew.station}" · eventos ${world.events.length}`,
      `${MAX_BREACHES} / ${MAX_BREACHES} / "cannon" / 5`,
      intact,
      'o quadro saiu do lugar: daqui para a frente o convidado lê bytes de outra coisa',
    );
  }

  // --- 3. sem a lista, o resto continua no lugar --------------------------------
  //
  // A lista de estrago é um campo **condicional**, e a promessa dele é que o
  // quadro se lê sozinho nas duas formas. Um leitor que consumisse a contagem
  // mesmo quando ela não foi escrita deslocaria tudo — pelo mesmo caminho, ao
  // contrário.
  {
    const match = makeMatch(4);
    const world = createWorldState();
    decodeSnapshot(
      encodeSnapshot(match, {
        bufferDepth: 1,
        starved: 0,
        ackTick: 9,
        includeBreaches: false,
        over: false,
        winner: 0,
      }),
      world,
    );

    const crew = world.crew[0]!;
    const source = match.crew[0]!.controller;
    check(
      'campo condicional · quadro sem a lista de estrago se lê igual',
      `rombos ${world.ships[0]!.breaches} · tábuas ${world.ships[0]!.patches} · olhar ${crew.yaw.toFixed(4)} · eventos ${world.events.length}`,
      'null / null / 1.9375 / 5',
      world.ships[0]!.breaches === null &&
        world.ships[0]!.patches === null &&
        Math.abs(crew.yaw - source.yaw) < TOLERANCE.angle &&
        world.events.length === 5,
      'o leitor e o escritor discordam sobre quando a lista está no quadro',
    );
  }

  // --- 4. lixo não derruba o tratador de rede -----------------------------------
  //
  // Um quadro truncado (outra versão, pacote cortado) tem de virar `null`, e não
  // exceção: isto roda dentro do `onmessage` do socket, e o que escapar dali
  // derruba a rede da partida inteira sem nada aparecer na tela.
  {
    const match = makeMatch(2);
    const full = encodeSnapshot(match, {
      bufferDepth: 0,
      starved: 0,
      ackTick: 0,
      includeBreaches: true,
      over: false,
      winner: 0,
    });

    const world = createWorldState();
    let threw = false;
    let refused = 0;
    const truncations = [0, 4, 12, 40, Math.floor(full.byteLength / 2), full.byteLength - 3];
    for (const cut of truncations) {
      try {
        if (decodeSnapshot(full.slice(0, cut), world) === null) refused++;
      } catch {
        threw = true;
      }
    }

    check(
      'quadro truncado · vira null, nunca exceção',
      `${refused} de ${truncations.length} recusados · lançou ${threw}`,
      `${truncations.length} recusados · lançou false`,
      !threw && refused === truncations.length,
      'um pacote ruim derruba o tratador de rede e o mundo congela sem erro',
    );
  }

  const falhas = cases.filter((entry) => !entry.passou).length;
  return { passou: falhas === 0, total: cases.length, falhas, cases };
}

/** Cada campo de cada casco, medido contra a tolerância da grandeza dele. */
function shipCases(match: Match, world: ReturnType<typeof createWorldState>): TestCase[] {
  const out: TestCase[] = [];

  for (let slot = 0; slot < 2; slot++) {
    const source = match.ships[slot]! as unknown as ReturnType<typeof makeShip>;
    const read = world.ships[slot]!;

    const pose =
      read.position.distanceTo(source.body.comPosition) < 1e-3 &&
      Math.abs(read.orientation.dot(source.body.orientation)) > 1 - TOLERANCE.quaternion &&
      read.velocity.distanceTo(source.body.velocity) < TOLERANCE.velocity &&
      read.angularVelocity.distanceTo(source.body.angularVelocity) < TOLERANCE.angular;

    out.push({
      nome: `casco ${slot} · pose, velocidade e giro`,
      medido: `pos ±${read.position.distanceTo(source.body.comPosition).toExponential(1)} m · vel ±${read.velocity.distanceTo(source.body.velocity).toExponential(1)} m/s`,
      esperado: 'posição ±1 mm · velocidade ±5 mm/s',
      erro: pose ? '—' : 'o casco chega numa pose diferente da que foi escrita',
      passou: pose,
    });

    const gear =
      Math.abs(read.wheelAngle - source.rudder.wheelAngle) < TOLERANCE.angle &&
      read.cannonballs === source.cannonballs &&
      read.planks === source.planks &&
      read.anchorState === source.anchor.state &&
      Math.abs(read.anchorDeploy - source.anchor.deploy) < TOLERANCE.byte &&
      Math.abs(read.floodFraction - source.damage.floodFraction) < TOLERANCE.byte &&
      Math.abs(read.sinkTime - source.damage.sinkTime) < 1e-3;

    out.push({
      nome: `casco ${slot} · roda, paióis, âncora e alagamento`,
      medido: `bala ${read.cannonballs} · tábua ${read.planks} · âncora ${read.anchorState} ${read.anchorDeploy.toFixed(2)} · porão ${read.floodFraction.toFixed(3)}`,
      esperado: `${source.cannonballs} · ${source.planks} · ${source.anchor.state} ${source.anchor.deploy} · ${source.damage.floodFraction}`,
      erro: gear ? '—' : 'um estado do navio chega errado do outro lado',
      passou: gear,
    });

    let guns = true;
    for (let i = 0; i < 2; i++) {
      const a = source.cannons[i]!;
      const b = read.cannons[i]!;
      guns &&=
        Math.abs(b.traverse - a.traverse) < TOLERANCE.angle &&
        Math.abs(b.elevation - a.elevation) < TOLERANCE.angle &&
        b.state === a.state &&
        Math.abs(b.loadProgress - a.loadProgress) < TOLERANCE.byte &&
        Math.abs(b.recoil - a.recoil) < TOLERANCE.byte;
    }
    out.push({
      nome: `casco ${slot} · as duas peças (mira, carga e recuo)`,
      medido: `${read.cannons.map((c) => `${c.state} ${c.traverse.toFixed(4)}`).join(' | ')}`,
      esperado: `${source.cannons.map((c) => `${c.state} ${c.traverse.toFixed(4)}`).join(' | ')}`,
      erro: guns ? '—' : 'a peça do outro lado aponta para onde ela não está apontada',
      passou: guns,
    });

    let damage = read.breaches?.length === source.damage.breaches.length;
    for (let i = 0; damage && i < source.damage.breaches.length; i++) {
      const a = source.damage.breaches[i]!;
      const b = read.breaches![i]!;
      damage &&=
        b.id === a.id &&
        b.local.distanceTo(a.local) < TOLERANCE.breach &&
        b.normal.dot(a.normal) > 0.99 &&
        Math.abs(b.area - a.area) < 1e-3 &&
        Math.abs(b.repair - a.repair) < TOLERANCE.byte;
    }
    damage &&= read.patches?.length === source.damage.patches.length;
    for (let i = 0; damage && i < source.damage.patches.length; i++) {
      const a = source.damage.patches[i]!;
      const b = read.patches![i]!;
      damage &&=
        b.id === a.id &&
        b.local.distanceTo(a.local) < TOLERANCE.breach &&
        b.normal.dot(a.normal) > 0.99 &&
        Math.abs(b.area - a.area) < 1e-3;
    }

    out.push({
      nome: `casco ${slot} · rombos abertos e tábuas pregadas`,
      medido: `${read.breaches?.length} rombos · ${read.patches?.length} tábuas`,
      esperado: `${source.damage.breaches.length} · ${source.damage.patches.length}, com posição, área e reparo`,
      erro: damage ? '—' : 'o costado do outro conta uma história diferente da verdadeira',
      passou: damage,
    });
  }

  return out;
}

function crewCases(match: Match, world: ReturnType<typeof createWorldState>): TestCase[] {
  const out: TestCase[] = [];

  for (let slot = 0; slot < 2; slot++) {
    const source = match.crew[slot]!.controller as unknown as ReturnType<typeof makeCrew>['controller'];
    const read = world.crew[slot]!;

    const ok =
      read.local.distanceTo(source.local) < TOLERANCE.local &&
      Math.abs(read.yaw - source.yaw) < TOLERANCE.angle &&
      Math.abs(read.pitch - source.pitch) < TOLERANCE.angle &&
      read.station === source.station &&
      read.cannonIndex === source.cannonIndex &&
      read.grounded === source.grounded &&
      read.onLadder === source.onLadder &&
      read.atCapstan === source.atCapstan;

    out.push({
      nome: `marujo ${slot} · posição, olhar, posto e estado do corpo`,
      medido: `"${read.station}" peça ${read.cannonIndex} · chão ${read.grounded} escada ${read.onLadder} cabrestante ${read.atCapstan}`,
      esperado: `"${source.station}" peça ${source.cannonIndex} · ${source.grounded} ${source.onLadder} ${source.atCapstan}`,
      erro: ok ? '—' : 'o marujo do outro lado está num lugar ou num posto diferente',
      passou: ok,
    });
  }

  return out;
}

/**
 * Os cinco tipos de evento.
 *
 * Importa mais do que parece: os eventos são **os últimos** do quadro e têm
 * tamanho variável por tipo. Um tipo novo escrito e não lido não perde só aquele
 * evento — ele para a leitura de todos os seguintes, porque não há como saber
 * quantos bytes pular.
 */
function eventCases(match: Match, world: ReturnType<typeof createWorldState>): TestCase[] {
  const source = match.netEvents;
  const read = world.events;

  let ok = read.length === source.length;
  for (let i = 0; ok && i < source.length; i++) {
    const a = source[i]!;
    const b = read[i]!;
    ok &&= a.kind === b.kind;
    if (!ok) break;

    if ('position' in a && 'position' in b) ok &&= b.position.distanceTo(a.position) < 1e-3;
    if ('ship' in a && 'ship' in b) ok &&= a.ship === b.ship;
    if ('speed' in a && 'speed' in b) ok &&= Math.abs(a.speed - b.speed) <= 0.5;
    if (a.kind === 'shot' && b.kind === 'shot') ok &&= b.direction.dot(a.direction) > 0.99;
    if (a.kind === 'hull' && b.kind === 'hull') {
      ok &&= b.normal.dot(a.normal) > 0.99 && a.flooded === b.flooded;
    }
  }

  return [
    {
      nome: 'eventos · os cinco tipos, na ordem e com os campos',
      medido: `${read.length} eventos: ${read.map((e) => e.kind).join(', ')}`,
      esperado: `${source.length}: ${source.map((e) => e.kind).join(', ')}`,
      erro: ok ? '—' : 'um tipo de evento não atravessa, e leva os seguintes junto',
      passou: ok,
    },
  ];
}
