/**
 * Teste do abalroamento — os cascos se recusam a ocupar o mesmo lugar?
 *
 * Roda no navegador, como os outros:
 *
 * ```js
 * const t = await import('/tests/contact.ts');
 * console.table(t.runContactTests().cases);
 * ```
 *
 * ## Por que ele existe
 *
 * Porque as duas coisas que este arquivo prova são **invisíveis olhando a tela**.
 * Um contato fraco e um contato ausente produzem a mesma imagem — dois cascos se
 * atravessando — e nenhuma das duas causas aparece como erro em lugar nenhum. Foi o
 * que aconteceu: `HullContact` existia, rodava todo passo, e ainda assim a queixa
 * era "os barcos entram um dentro do outro". Havia duas razões somadas, e as duas
 * eram de aritmética:
 *
 * 1. **A força era dividida pelo número de sondagens de um bordo (dez), e não pelas
 *    que de fato tocaram.** Um encontro de proa põe uma ou duas sondagens dentro do
 *    outro casco, então ele recebia um décimo da força projetada.
 * 2. **As sondagens paravam a 1,23 m da roda de proa.** Uma proa contra a outra não
 *    tinha o que medir até ter entrado dois metros e meio.
 *
 * O que se prova aqui não é um número afinado, é a **propriedade**: encostados, os
 * dois se afastam, e se afastam com aceleração de ordem de grandeza de colisão em
 * vez de ordem de grandeza de empurrãozinho. Os limites são frouxos de propósito —
 * apertá-los transformaria uma calibração de rigidez num teste quebrado.
 *
 * ## E o estrago
 *
 * A segunda metade do arquivo é `ShipDamage.ram`, e ali sim há números exatos a
 * provar: quantos rombos cada faixa de velocidade abre, que eles não se fundem num
 * só (o que valeria menos que a soma deles) e que um encostão não arranca tábua.
 */

import * as THREE from 'three';
import { createContactReport, resolveHullContact } from '../src/combat/HullContact';
import { ShipBody } from '../src/ship/ShipBody';
import { ShipDamage } from '../src/ship/ShipDamage';
import { computeDisplacement, halfWidthAtHeight } from '../src/ship/ShipDimensions';
import type { Ship } from '../src/ship/Ship';

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

/** O passo fixo da simulação. Duplicado para o teste não arrastar `Engine`. */
const STEP = 1 / 60;

/**
 * Massa, giração e massa adicionada da Chalupa.
 *
 * Copiados de `Ship`, onde eles são privados, e é de propósito — é a mesma escolha
 * de `PROTOCOL_VERSION` em `roomServer.mjs`. Importá-los faria o teste concordar
 * com o código por construção; escritos aqui, uma mudança de casco que altere a
 * ordem de grandeza da resposta ao contato aparece como falha, que é justamente
 * quando alguém precisa olhar de novo para a rigidez.
 */
const GYRATION = new THREE.Vector3(4.16, 4.16, 1.95);
const ADDED_MASS = new THREE.Vector3(1.9, 2.0, 1.06);
const CENTER_OF_MASS = new THREE.Vector3(0, -0.55, 0.91);
const UP = new THREE.Vector3(0, 1, 0);

/**
 * Um casco só com o corpo rígido dentro.
 *
 * `resolveHullContact` só toca em `ship.body` — nem malha, nem vela, nem avaria —
 * então o molde é honesto e evita arrastar `createShipAssets` (que desenha textura
 * em canvas) para dentro de um teste de aritmética.
 *
 * @param heading rumo em radianos. Zero aponta a proa para o −Z do mundo.
 */
function vessel(x: number, z: number, heading = 0): Ship {
  const body = new ShipBody({
    mass: computeDisplacement().mass,
    centerOfMass: CENTER_OF_MASS,
    gyration: GYRATION,
    addedMass: ADDED_MASS,
  });
  body.orientation.setFromAxisAngle(UP, heading);
  // Depois da orientação: `setOrigin` a usa para achar o centro de massa.
  body.setOrigin(x, 0, z);
  return { body } as unknown as Ship;
}

const _originA = new THREE.Vector3();
const _originB = new THREE.Vector3();
const _axis = new THREE.Vector3();
const _relative = new THREE.Vector3();

/** O que um passo de contato produziu nos dois cascos. */
interface Encounter {
  contacts: number;
  depth: number;
  /**
   * Aceleração com que os dois se separam, em m/s², medida ao longo da linha que
   * liga as duas origens. Negativa é "continuaram se aproximando".
   *
   * Lida da velocidade depois de `integrate`, e não de uma força espiada por
   * dentro: é assim que o navio de verdade sente o contato, com a massa adicionada
   * de cada eixo já aplicada.
   */
  separation: number;
  /**
   * Módulo da aceleração relativa, em m/s², em qualquer direção.
   *
   * Existe ao lado de `separation` porque a saída mais curta de um contato **não é
   * sempre a linha que liga os dois centros**, e no encontro de proa ela nunca é:
   * duas rodas de proa se tocando estão a meio metro do bordo do outro e a quase um
   * metro da ponta dele, então a madeira empurra para o lado e as duas chalupas
   * escorregam uma pela outra em vez de pararem nariz a nariz. É o que acontece no
   * mar, e é o que o jogo tem de fazer — mas medido no eixo dos centros dá zero, e
   * zero é indistinguível de não ter havido contato nenhum.
   */
  push: number;
  /** Módulo do momento linear que sobrou no par. Zero é reação igual e contrária. */
  residualMomentum: number;
}

function encounter(a: Ship, b: Ship): Encounter {
  const report = createContactReport();
  resolveHullContact(a, b, report);

  a.body.integrate(STEP);
  b.body.integrate(STEP);

  a.body.getOrigin(_originA);
  b.body.getOrigin(_originB);
  _axis.subVectors(_originA, _originB).normalize();
  _relative.subVectors(a.body.velocity, b.body.velocity);

  _originA.copy(a.body.velocity).add(b.body.velocity).multiplyScalar(a.body.mass);

  return {
    contacts: report.contacts,
    depth: report.depth,
    separation: _relative.dot(_axis) / STEP,
    push: _relative.length() / STEP,
    residualMomentum: _originA.length(),
  };
}

/**
 * Aceleração de separação que já é colisão, em m/s².
 *
 * Cinco é o piso porque a versão com a divisão errada entregava **décimos** —
 * 0,3 m/s² para meio metro de sobreposição, contra os mais de dez que a rigidez
 * projetada dá. Qualquer número nesta ordem de grandeza distingue as duas.
 */
const COLLISION_FLOOR = 5;

/**
 * Teto da mesma aceleração, em m/s².
 *
 * Uma mola de contato mal grampeada vira catapulta, e catapulta é tão errado quanto
 * névoa: o navio sairia dali a vários metros por segundo em um passo. 500 m/s² é
 * folgado para a rigidez de projeto e apertado o bastante para pegar um grampo que
 * alguém tirou. Ver `MAX_PUSH_DEPTH`.
 */
const CATAPULT_CEILING = 500;

export function runContactTests(): TestReport {
  const cases: TestCase[] = [];

  function record(nome: string, medido: string, esperado: string, passou: boolean, erro = ''): void {
    cases.push({ nome, medido, esperado, erro: passou ? '—' : erro || 'fora do esperado', passou });
  }

  function checkCollision(nome: string, met: Encounter): void {
    const ok =
      met.contacts > 0 &&
      met.separation >= COLLISION_FLOOR &&
      met.separation <= CATAPULT_CEILING;
    record(
      nome,
      `${met.contacts} contatos · ${met.depth.toFixed(2)} m · ${met.separation.toFixed(1)} m/s²`,
      `> 0 contatos · ${COLLISION_FLOOR}–${CATAPULT_CEILING} m/s² de separação`,
      ok,
      met.contacts === 0 ? 'nenhum contato encontrado' : `separação de ${met.separation.toFixed(1)} m/s²`,
    );
  }

  // -- contato ------------------------------------------------------------------

  // A meia-boca de verdade na linha d'água, para a sobreposição ser a pedida em
  // vez de um chute sobre a boca nominal.
  const halfBeam = halfWidthAtHeight(0.5, 0.1);

  // Costado a costado, paralelos, com 40 cm de casco dentro do casco. É o encontro
  // mais comum de um duelo: alguém tentando cruzar a proa do outro e raspando.
  checkCollision(
    'costado a costado · os cascos se empurram como madeira, não como névoa',
    encounter(vessel(0, 0), vessel(2 * halfBeam - 0.4, 0)),
  );

  // A mesma coisa, olhando o que sobrou de momento linear. Com os dois no mesmo
  // rumo os tensores de massa adicionada estão alinhados, então a terceira lei tem
  // de fechar até o ponto flutuante — se não fechar, alguém aplicou a força num
  // corpo e esqueceu do outro, e o par ganharia velocidade do nada.
  {
    const met = encounter(vessel(0, 0), vessel(2 * halfBeam - 0.4, 0));
    const ok = met.contacts > 0 && met.residualMomentum < 1;
    record(
      'costado a costado · a reação é igual e contrária',
      `${met.residualMomentum.toFixed(3)} kg·m/s de sobra`,
      '≈ 0',
      ok,
      `o par ganhou ${met.residualMomentum.toFixed(1)} kg·m/s de momento`,
    );
  }

  // Proa no costado: o abalroamento clássico. A proa de A entra 60 cm no costado de
  // B, que está atravessado. A saída mais curta é o bordo de B, e é para lá que a
  // madeira empurra.
  checkCollision(
    'proa no costado · o casco é expulso pelo bordo do outro',
    encounter(vessel(0, 0), vessel(0, -8 - halfBeam + 0.6, Math.PI / 2)),
  );

  // Proa contra proa, um metro de sobreposição. É o caso que **não existia**: as
  // sondagens paravam a 1,23 m da roda de proa, então neste arranjo o passo achava
  // **zero** contatos e as duas chalupas se telescopavam sem nada as segurar. Daí a
  // contagem de contatos ser metade do que se prova aqui.
  //
  // A outra metade é a força, medida em módulo e não no eixo dos centros — ver
  // `Encounter.push` para o porquê. O que se exige do eixo é só que ele não seja
  // **negativo**: a madeira pode empurrar de lado, não pode puxar para dentro.
  {
    const met = encounter(vessel(0, 0), vessel(0, -15, Math.PI));
    const ok = met.contacts > 0 && met.push >= COLLISION_FLOOR && met.push <= CATAPULT_CEILING && met.separation > -0.5;
    record(
      'proa contra proa · as duas se recusam a se atravessar',
      `${met.contacts} contatos · ${met.depth.toFixed(2)} m · ${met.push.toFixed(1)} m/s² de empurrão`,
      `> 0 contatos · ${COLLISION_FLOOR}–${CATAPULT_CEILING} m/s², nada de atração`,
      ok,
      met.contacts === 0 ? 'nenhum contato encontrado' : `empurrão de ${met.push.toFixed(1)} m/s²`,
    );
  }

  // E o contrário disso: longe um do outro, nada acontece. Um contato fantasma aqui
  // seria pior que nenhum contato lá — o navio sairia empurrado no mar aberto.
  {
    const met = encounter(vessel(0, 0), vessel(0, -40));
    const ok = met.contacts === 0 && Math.abs(met.separation) < 1e-6;
    record(
      'mar aberto · sem sobreposição não há contato',
      `${met.contacts} contatos · ${met.separation.toFixed(4)} m/s²`,
      '0 contatos · 0 m/s²',
      ok,
      'contato encontrado entre cascos que não se tocam',
    );
  }

  // -- estrago ------------------------------------------------------------------

  /** Abalroa um casco limpo na linha d'água, a meia-nau, e diz o que ficou. */
  function ram(speed: number, y = 0.1): ShipDamage {
    const damage = new ShipDamage();
    damage.ram(new THREE.Vector3(halfBeam, y, 0), speed);
    return damage;
  }

  const escada: ReadonlyArray<[number, number]> = [
    [0.9, 0],
    [1.5, 1],
    [2.5, 2],
    [4, 3],
    [9, 3],
  ];
  for (const [speed, esperado] of escada) {
    const medido = ram(speed).breaches.length;
    record(
      `abalroamento · ${speed.toFixed(1)} m/s abre ${esperado} rombo(s)`,
      `${medido}`,
      `${esperado}`,
      medido === esperado,
      `abriu ${medido}`,
    );
  }

  // Três rombos e não um alargado: `RAM_SPREAD` tem de vencer `MERGE_DISTANCE`,
  // senão a pancada mais forte do jogo valeria menos que a soma das partes dela —
  // alargar satura em `MAX_BREACH_SCALE` e três buracos separados não saturam.
  {
    const damage = ram(4);
    let closest = Number.POSITIVE_INFINITY;
    for (let i = 0; i < damage.breaches.length; i++) {
      for (let j = i + 1; j < damage.breaches.length; j++) {
        const gap = damage.breaches[i]!.local.distanceTo(damage.breaches[j]!.local);
        if (gap < closest) closest = gap;
      }
    }
    const ok = damage.breaches.length === 3 && closest > 0.5;
    record(
      'abalroamento · os três rombos ficam separados',
      `${damage.breaches.length} rombos · ${closest.toFixed(2)} m entre os mais próximos`,
      '3 rombos · > 0,50 m',
      ok,
      'os rombos da pancada se fundiram num só',
    );
  }

  // Todo rombo de pancada tem de alagar e tem de estar no bordo em que se bateu.
  {
    const damage = ram(4);
    const abaixo = damage.breaches.every((breach) => breach.local.y < 1.3);
    const noBordo = damage.breaches.every((breach) => breach.local.x > 0);
    record(
      'abalroamento · os rombos abrem no bordo da pancada, abaixo do convés',
      `${abaixo ? 'abaixo' : 'acima'} · ${noBordo ? 'a boreste' : 'no bordo errado'}`,
      'abaixo · a boreste',
      abaixo && noBordo,
      'rombo fora do costado que levou a pancada',
    );
  }

  // Bater na amurada arranca lasca e nada mais, como no tiro: acima do convés não
  // há porão para encher.
  {
    const medido = ram(6, 1.6).breaches.length;
    record(
      'abalroamento · pancada acima do convés não abre casco',
      `${medido} rombos`,
      '0 rombos',
      medido === 0,
      `abriu ${medido} rombo(s) na amurada`,
    );
  }

  const falhas = cases.filter((entry) => !entry.passou).length;
  return { passou: falhas === 0, total: cases.length, falhas, cases };
}
