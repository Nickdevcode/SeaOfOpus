/**
 * Teste de balística — o alcance simulado contra o alcance analítico.
 *
 * O projeto não tem executor de testes instalado (seriam dependências novas para
 * um único arquivo), então este módulo é **rodável no navegador**: o servidor de
 * desenvolvimento serve `/tests/ballistics.ts` como qualquer outro módulo, e
 * quem quiser rodar abre o console e faz
 *
 * ```js
 * const t = await import('/tests/ballistics.ts');
 * console.table(t.runBallisticsTests().cases);
 * ```
 *
 * **O que se prova aqui.** A trajetória com arrasto não tem forma fechada — não
 * existe "resposta certa" para comparar. O que existe é o caso limite: com
 * arrasto zero a integração *tem* que reproduzir a parábola de livro, e é isso
 * que os dois primeiros casos verificam, ida (ângulo → alcance) e volta (alcance
 * → ângulo). Provado o integrador no vácuo, os dois últimos casos verificam que
 * o solucionador e o projétil que voa de verdade concordam entre si, que é a
 * propriedade da qual a mira da IA depende.
 */

import * as THREE from 'three';
import { GRAVITY, DEG, RAD } from '../src/core/MathUtils';
import { dragFactor, maxRange, solveElevation, stepBallistic } from '../src/combat/Ballistics';
import { BALL_MASS, BALL_RADIUS, MUZZLE_SPEED } from '../src/ship/Cannon';

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

/** Alcance de uma parábola de vácuo: `R = v²·sen(2θ)/g`. */
function vacuumRange(speed: number, elevation: number): number {
  return (speed * speed * Math.sin(2 * elevation)) / GRAVITY;
}

/**
 * Integra um tiro no plano vertical até ele voltar à altura de partida e devolve
 * o alcance, interpolando dentro do passo em que cruzou.
 *
 * `dt` é parâmetro porque um dos casos precisa rodar com o passo do projétil de
 * verdade (1/60 dividido em 4 sub-passos), e não com o do solucionador.
 */
function integrateRange(speed: number, elevation: number, dragK: number, dt: number): number {
  const position = new THREE.Vector3(0, 0, 0);
  const velocity = new THREE.Vector3(Math.cos(elevation) * speed, Math.sin(elevation) * speed, 0);
  const previous = new THREE.Vector3();

  for (let i = 0; i < Math.ceil(30 / dt); i++) {
    previous.copy(position);
    stepBallistic(position, velocity, dragK, dt);

    if (position.y <= 0 && velocity.y < 0) {
      const drop = previous.y - position.y;
      const s = drop > 1e-9 ? previous.y / drop : 0;
      return previous.x + (position.x - previous.x) * s;
    }
  }
  return position.x;
}

export function runBallisticsTests(): TestReport {
  const cases: TestCase[] = [];

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

  const dragK = dragFactor(BALL_MASS, BALL_RADIUS);

  // --- 1. vácuo a 45°: o alcance tem que ser v²/g -----------------------------
  // O viés é conhecido e tem sinal: o Euler semi-implícito erra a altura em
  // `−g·t·dt/2`, o que aqui vale ~0,56 m ao fim de 13,7 s de voo e vira um
  // alcance ~0,6 m curto. Tolerar 3 m em 920 é 0,33% — folga suficiente para o
  // teste não ser frágil, e apertada o bastante para pegar um sinal trocado ou
  // uma gravidade errada.
  const elevation45 = 45 * DEG;
  check(
    'vácuo · 45° · alcance',
    integrateRange(MUZZLE_SPEED, elevation45, 0, 1 / 120),
    vacuumRange(MUZZLE_SPEED, elevation45),
    3,
    'm',
  );

  // --- 2. o inverso: dado o alcance, o solucionador acha o ângulo -------------
  // A 30° porque o teto do solucionador é 44,1°: pedir o ângulo de alcance
  // máximo seria pedir justamente o que ele se recusa a devolver, de propósito.
  const elevation30 = 30 * DEG;
  const range30 = vacuumRange(MUZZLE_SPEED, elevation30);
  const solvedVacuum = solveElevation(range30, 0, MUZZLE_SPEED, 0);
  check(
    'vácuo · alcance → ângulo',
    (solvedVacuum?.elevation ?? NaN) * RAD,
    30,
    0.15,
    '°',
  );

  // --- 3. com arrasto, solucionador × projétil de verdade ---------------------
  // O solucionador integra a 120 Hz num plano; o projétil integra a 240 Hz
  // (60 Hz ÷ 4 sub-passos) em três dimensões. Se os dois discordassem, a IA
  // erraria por metros e o jogador nunca saberia por quê.
  const combatRange = 120;
  const solved = solveElevation(combatRange, 0, MUZZLE_SPEED, dragK);
  const flown = solved
    ? integrateRange(MUZZLE_SPEED, solved.elevation, dragK, 1 / 240)
    : NaN;
  check('arrasto · solver × projétil', flown, combatRange, 0.5, 'm');

  // --- 4. o arrasto tem que custar caro --------------------------------------
  // Não é uma correção de segunda ordem: a 95 m/s a bala perde mais da metade do
  // alcance de vácuo. Se este caso passar a bater no valor de vácuo, é porque o
  // `dragFactor` foi zerado em algum lugar.
  const vacuumBest = vacuumRange(MUZZLE_SPEED, 45 * DEG);
  const dragBest = maxRange(MUZZLE_SPEED, dragK);
  cases.push({
    nome: 'arrasto · alcance máximo < vácuo',
    medido: `${dragBest.toFixed(1)} m`,
    esperado: `< ${(vacuumBest * 0.75).toFixed(1)} m`,
    erro: `${((1 - dragBest / vacuumBest) * 100).toFixed(1)}% de perda`,
    passou: dragBest < vacuumBest * 0.75 && dragBest > 100,
  });

  const falhas = cases.filter((c) => !c.passou).length;
  return { passou: falhas === 0, total: cases.length, falhas, cases };
}
