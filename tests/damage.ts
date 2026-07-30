/**
 * Damage model tests — the property that was missing and nobody saw for months.
 *
 * Runnable in the browser, like the others:
 *
 * ```js
 * const t = await import('/tests/damage.ts');
 * console.table(t.runDamageTests().cases);
 * ```
 *
 * **What gets proven here, and why it's worth a file.** The flooding model has no
 * "right answer" to compare against — breach flow rate in a wooden hull is a tuned
 * number, not a theorem. What it *does* have is a structural property that any
 * combat game needs to respect and that this one violated:
 *
 * > **A hit is worth a hit, wherever it lands.**
 *
 * The violation was subtle and came out of two reasonable rules that added up
 * badly. A shot near an open breach *widened* that breach instead of opening
 * another one (with a 90 cm radius, three and a half times the span a cannonball
 * makes), and each breach's flow rate was limited by a **fixed** ceiling, the same
 * for a small hole and for one twice the size. Together, they said that widening is
 * worth nothing — and therefore that grouping the shots is a waste.
 *
 * Measured: eight hits within a handspan of the hull side put 10% of water in the
 * hold; the same eight swept along the hull **sank the ship**. Whoever aimed better
 * did ten times less damage, and the AI — which sweeps by doctrine — played on the
 * good side of that curve while the player played on the bad side, with no way to
 * know the curve existed.
 *
 * The three cases below pin the fix down: the merge comes out of the breach's real
 * span, the flow rate is linear in area **including past saturation**, and the ratio
 * between grouped fire and swept fire stays above a floor. None of them needs a
 * ship, an ocean or a canvas — only the geometry and the arithmetic.
 */

import * as THREE from 'three';
import {
  MERGE_DISTANCE,
  ShipDamage,
  breachInflow,
} from '../src/ship/ShipDamage';

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

/** Área de um rombo recém-aberto, lida do próprio modelo em vez de copiada. */
function baseArea(): number {
  const damage = new ShipDamage();
  const breach = hit(damage, 0);
  return breach?.area ?? 0;
}

/** Abre (ou alarga) um rombo na linha d'água, na estação `z`. */
function hit(damage: ShipDamage, z: number) {
  return damage.registerHit({
    fraction: 0,
    local: new THREE.Vector3(1.9, 0.05, z),
    normal: new THREE.Vector3(1, 0, 0),
    part: 'hull',
    floods: true,
  });
}

/** Área total de entrada de água do casco, em m². */
function openArea(damage: ShipDamage): number {
  let total = 0;
  for (const breach of damage.breaches) total += breach.area;
  return total;
}

/** Gaussiana padrão, para simular a dispersão de quem mira um ponto e erra. */
function gaussian(random: () => number): number {
  let u = 0;
  let v = 0;
  while (u === 0) u = random();
  while (v === 0) v = random();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

function createRandom(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function runDamageTests(): TestReport {
  const cases: TestCase[] = [];
  const AREA = baseArea();

  function check(nome: string, medido: number, esperado: number, tolerancia: number, unidade: string): void {
    const erro = medido - esperado;
    cases.push({
      nome,
      medido: `${medido.toFixed(3)} ${unidade}`,
      esperado: `${esperado.toFixed(3)} ${unidade}`,
      erro: `${erro >= 0 ? '+' : ''}${erro.toFixed(3)} ${unidade} (tol. ±${tolerancia} ${unidade})`,
      passou: Math.abs(erro) <= tolerancia,
    });
  }

  // --- 1. a fusão cabe no vão do rombo ----------------------------------------
  // O vão que uma bala abre é um círculo da área base. Fundir tiros muito além
  // desse diâmetro é dizer que madeira sã entre dois furos não existe — e é o que
  // transformava precisão em punição. O teto de dois diâmetros é generoso de
  // propósito: cobre a madeira trincada em volta sem virar de novo o raio de 90 cm
  // que este teste veio impedir de voltar.
  const vao = 2 * Math.sqrt(AREA / Math.PI);
  cases.push({
    nome: 'fusão · cabe em dois vãos de rombo',
    medido: `${MERGE_DISTANCE.toFixed(3)} m (vão ${vao.toFixed(3)} m)`,
    esperado: `≤ ${(vao * 2).toFixed(3)} m`,
    erro: MERGE_DISTANCE <= vao * 2 ? '—' : `${(MERGE_DISTANCE / vao).toFixed(1)} vãos`,
    passou: MERGE_DISTANCE <= vao * 2,
  });

  // E ela precisa de fato fundir o que está perto e separar o que está longe,
  // senão o número acima seria decoração.
  const perto = new ShipDamage();
  hit(perto, 0);
  hit(perto, MERGE_DISTANCE * 0.5);
  const longe = new ShipDamage();
  hit(longe, 0);
  hit(longe, MERGE_DISTANCE * 1.5);
  cases.push({
    nome: 'fusão · perto vira um rombo, longe vira dois',
    medido: `perto ${perto.breaches.length} · longe ${longe.breaches.length}`,
    esperado: 'perto 1 · longe 2',
    erro: perto.breaches.length === 1 && longe.breaches.length === 2 ? '—' : 'fusão fora do raio',
    passou: perto.breaches.length === 1 && longe.breaches.length === 2,
  });

  // --- 2. a vazão é linear na área, inclusive saturada -------------------------
  // **É este caso que pega a volta do teto fixo.** Com um teto em m³/s por rombo,
  // dobrar a área de um furo bem submerso não muda nada — e é isso que fazia
  // agrupar os tiros valer um décimo de varrê-los. Raso (a veia ainda obedece
  // Torricelli) e fundo (a veia já saturou) têm de escalar igual.
  for (const [rotulo, profundidade] of [['raso', 0.2], ['fundo', 3]] as const) {
    const simples = breachInflow(AREA, profundidade);
    const dobro = breachInflow(AREA * 2, profundidade);
    check(`vazão · dobrar a área dobra a vazão (${rotulo})`, dobro / simples, 2, 0.001, '×');
  }

  // A saturação continua existindo — ela é o que impede o último segundo do
  // naufrágio de virar um degrau. Sem este caso, "linear na área" seria satisfeito
  // por remover o teto, que é o defeito oposto.
  const fundo = breachInflow(AREA, 3);
  const abissal = breachInflow(AREA, 12);
  check('vazão · a veia satura com a profundidade', abissal / fundo, 1, 0.001, '×');

  // --- 2b. o rombo acima da linha d'água ---------------------------------------
  //
  // A faixa de costado que abre rombo vai até o convés, em `y = 1,3`, e a linha
  // d'água passa perto de `y = 0,05`. São 1,25 m de casco seco contra 85 cm de
  // casco molhado — e o jogador mira no que enxerga, que é a parte seca. Sem
  // embarque por onda, quatro rombos entre dois navios rendiam `inflow 0` nos
  // dois painéis e um porão parado em 2% depois de um combate inteiro.
  //
  // O que se prende aqui são as três propriedades que fazem isso ser física de
  // jogo e não um número inventado: em mar liso o buraco alto continua seco; o
  // mar grosso molha mais que o manso; e nada disso mexe no regime submerso, que
  // é o modelo de verdade.
  const ACIMA = -0.5;
  const liso = breachInflow(AREA, ACIMA, 0);
  const manso = breachInflow(AREA, ACIMA, 0.25);
  const grosso = breachInflow(AREA, ACIMA, 0.9);

  check('onda · mar liso não molha rombo alto', liso, 0, 1e-9, 'm³/s');
  check(
    'onda · mar grosso molha mais que mar manso',
    grosso > manso && manso > 0 ? 1 : 0,
    1,
    0.001,
    'sim/não',
  );
  // O rombo submerso não pode ganhar nem perder vazão por causa da onda: ali
  // quem manda é a coluna d'água, e somar o embarque seria contar duas vezes.
  check(
    'onda · não interfere no rombo submerso',
    breachInflow(AREA, 0.6, 0.9) / breachInflow(AREA, 0.6, 0),
    1,
    0.001,
    '×',
  );

  // --- 3. mirar bem não pode custar caro --------------------------------------
  // O teste de ponta a ponta da propriedade do topo. Doze acertos, duas formas de
  // distribuí-los, e a área de entrada de água que sai de cada uma. Agrupado
  // *pode* render menos — dois tiros no mesmo palmo realmente se sobrepõem —, mas
  // não pode render uma fração.
  //
  // O piso é 60%: com os números de hoje a razão dá ~0,88, e o valor antigo dava
  // 0,24. Qualquer coisa abaixo de 60% significa que o modelo voltou a punir quem
  // acerta, que é a única coisa que este arquivo existe para impedir.
  const PISO = 0.6;
  const REPS = 120;
  let somaAgrupada = 0;
  let somaVarrida = 0;

  for (let r = 0; r < REPS; r++) {
    const random = createRandom(0xda3a6e + r * 7919);
    const agrupada = new ShipDamage();
    const varrida = new ShipDamage();

    for (let i = 0; i < 12; i++) {
      // Agrupada: mira o meio-navio e erra 1 m. Varrida: o costado inteiro.
      hit(agrupada, Math.max(-7, Math.min(7, gaussian(random) * 1)));
      hit(varrida, (random() * 2 - 1) * 6);
    }

    somaAgrupada += openArea(agrupada);
    somaVarrida += openArea(varrida);
  }

  const razao = somaAgrupada / somaVarrida;
  cases.push({
    nome: 'salva · fogo agrupado rende perto do varrido',
    medido: `${(razao * 100).toFixed(0)}% da área`,
    esperado: `≥ ${(PISO * 100).toFixed(0)}%`,
    erro: razao >= PISO ? '—' : `${((PISO - razao) * 100).toFixed(0)} pontos abaixo do piso`,
    passou: razao >= PISO,
  });

  const falhas = cases.filter((c) => !c.passou).length;
  return { passou: falhas === 0, total: cases.length, falhas, cases };
}
