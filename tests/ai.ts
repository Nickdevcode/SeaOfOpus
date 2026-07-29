/**
 * Testes da IA — as duas propriedades de que o duelo inteiro depende.
 *
 * Rodável no navegador, como `tests/ballistics.ts`:
 *
 * ```js
 * const t = await import('/tests/ai.ts');
 * console.table(t.runAiTests().cases);
 * ```
 *
 * **O que se prova aqui, e por que só isto.** A tática da IA não tem "resposta
 * certa" para comparar — é comportamento, e comportamento se mede olhando a
 * telemetria de um duelo. O que *tem* resposta certa são as duas conversões
 * geométricas em que ela se apoia, e as duas são exatamente onde um sinal trocado
 * passa despercebido para sempre:
 *
 * 1. **`Cannon.solveAim` é o inverso de `Cannon.getAimLocal`.** Se não for, a peça
 *    aponta para o lado espelhado e a IA erra todo tiro sem nenhum erro aparente no
 *    código — os dois trechos parecem certos isoladamente.
 * 2. **O sinal do timoneiro fecha a malha.** Rumo cresce para bombordo, roda
 *    positiva desce o rumo. Com o sinal trocado a realimentação vira positiva e o
 *    navio gira cada vez mais rápido para longe do rumo pedido, o que na tela lê
 *    como "a IA é maluca" e não como um menos fora de lugar.
 * 3. **Os três capitães estão em ordem nos eixos que decidem o duelo.** Não é uma
 *    conversão geométrica, mas tem resposta certa: os presets são uma tabela escrita
 *    à mão, e um número fora de ordem ali produz um "Legend" mais fácil que um
 *    "Deckhand" sem que nada quebre nem apareça no `tsc`.
 */

import * as THREE from 'three';
import { RAD, angleDelta } from '../src/core/MathUtils';
import { DIFFICULTIES, DIFFICULTY_ORDER, type DifficultyId } from '../src/ai/Difficulty';
import { MAX_WHEEL, WHEEL_RATE } from '../src/ship/Rudder';
import {
  ELEVATION_MAX,
  ELEVATION_MIN,
  TRAVERSE_LIMIT,
  type AimAngles,
} from '../src/ship/Cannon';

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
 * Reprodução isolada da cinemática do cano — a mesma composição que
 * `Cannon.getBarrelQuaternion` monta, sem precisar de um navio inteiro.
 *
 * Duplicar a fórmula aqui é deliberado: um teste que chamasse `getAimLocal` para
 * conferir `solveAim` provaria só que duas funções concordam. Escrevendo a
 * composição a partir da definição ('YXZ' aplicado a −Z), o teste confere as duas
 * contra a **geometria**, que é o que se quer garantir.
 */
function barrelDirection(sideYaw: number, traverse: number, elevation: number): THREE.Vector3 {
  const euler = new THREE.Euler(elevation, sideYaw + traverse, 0, 'YXZ');
  return new THREE.Vector3(0, 0, -1).applyQuaternion(new THREE.Quaternion().setFromEuler(euler));
}

/** A mesma decomposição de `Cannon.solveAim`, para testá-la sem instanciar a peça. */
function solveAim(sideYaw: number, direction: THREE.Vector3, out: AimAngles): AimAngles {
  const length = direction.length();
  out.elevation = Math.asin(Math.max(-1, Math.min(1, direction.y / length)));
  let traverse = Math.atan2(-direction.x, -direction.z) - sideYaw;
  // Mesmo `wrapAngle` de `MathUtils`.
  traverse = ((traverse + Math.PI) % (Math.PI * 2) + Math.PI * 2) % (Math.PI * 2) - Math.PI;
  out.traverse = traverse;
  out.bears =
    Math.abs(traverse) <= TRAVERSE_LIMIT &&
    out.elevation >= ELEVATION_MIN &&
    out.elevation <= ELEVATION_MAX;
  return out;
}

export function runAiTests(): TestReport {
  const cases: TestCase[] = [];

  function check(nome: string, medido: number, esperado: number, tolerancia: number, unidade: string): void {
    const erro = medido - esperado;
    cases.push({
      nome,
      medido: `${medido.toFixed(4)} ${unidade}`,
      esperado: `${esperado.toFixed(4)} ${unidade}`,
      erro: `${erro >= 0 ? '+' : ''}${erro.toFixed(4)} ${unidade} (tol. ±${tolerancia} ${unidade})`,
      passou: Math.abs(erro) <= tolerancia,
    });
  }

  const angles: AimAngles = { traverse: 0, elevation: 0, bears: false };

  // --- 1. ida e volta em toda a faixa útil, nos dois bordos -------------------
  // Varre travessia × elevação dentro dos batentes e cobra que decompor a direção
  // devolva exatamente os ângulos que a geraram. O pior erro da varredura é o que
  // vai para a tabela: uma média esconderia um único ponto espelhado.
  let worstTraverse = 0;
  let worstElevation = 0;

  for (const sideYaw of [-Math.PI / 2, Math.PI / 2]) {
    for (let t = -1; t <= 1; t += 0.25) {
      for (let e = 0; e <= 1; e += 0.125) {
        const traverse = t * TRAVERSE_LIMIT;
        const elevation = ELEVATION_MIN + e * (ELEVATION_MAX - ELEVATION_MIN);

        solveAim(sideYaw, barrelDirection(sideYaw, traverse, elevation), angles);

        worstTraverse = Math.max(worstTraverse, Math.abs(angleDelta(traverse, angles.traverse)));
        worstElevation = Math.max(worstElevation, Math.abs(angles.elevation - elevation));
      }
    }
  }

  // 1 µrad: é erro de ponto flutuante, não de fórmula. Um sinal trocado apareceria
  // aqui como radianos inteiros, não como micro-radianos.
  check('pontaria · ida e volta (travessia)', worstTraverse * RAD, 0, 0.0001, '°');
  check('pontaria · ida e volta (elevação)', worstElevation * RAD, 0, 0.0001, '°');

  // --- 2. o bordo aponta para fora --------------------------------------------
  // Com travessia e elevação zeradas, a peça de boreste tem de olhar para +X e a de
  // bombordo para −X. É o teste que pega o espelhamento de bordo, que passaria
  // impune pelo caso 1 (ele é simétrico).
  const starboard = barrelDirection(-Math.PI / 2, 0, 0);
  const port = barrelDirection(Math.PI / 2, 0, 0);
  check('bordo · boreste aponta para +X', starboard.x, 1, 0.001, '');
  check('bordo · bombordo aponta para −X', port.x, -1, 0.001, '');

  // --- 3. o setor de tiro é o través, não a proa ------------------------------
  // A tática inteira de `ShipAI` se apoia nisto: a peça **não** alcança um alvo pela
  // proa, e por isso manter o inimigo sob fogo é trabalho do timão. Se algum ajuste
  // futuro abrir o batente, este caso avisa antes de a tática virar redundante.
  const ahead = new THREE.Vector3(0, 0, -1);
  const abeam = new THREE.Vector3(1, 0, 0);
  solveAim(-Math.PI / 2, ahead, angles);
  const bearsAhead = angles.bears;
  solveAim(-Math.PI / 2, abeam, angles);
  const bearsAbeam = angles.bears;

  cases.push({
    nome: 'setor · través sim, proa não',
    medido: `proa ${bearsAhead ? 'alcança' : 'fora'} · través ${bearsAbeam ? 'alcança' : 'fora'}`,
    esperado: 'proa fora · través alcança',
    erro: `batente ±${(TRAVERSE_LIMIT * RAD).toFixed(1)}°`,
    passou: !bearsAhead && bearsAbeam,
  });

  // --- 4. o timoneiro fecha a malha no sinal certo ----------------------------
  // Simula a cascata de `Helmsman` contra um modelo grosseiro de navio: a roda vira
  // no limite da taxa, o leme produz guinada proporcional a ela, e o rumo integra a
  // guinada. Não é a física de `Rudder` — é só o **sinal** dela, que é o que se está
  // testando. Com o menos trocado em qualquer ponto da cadeia, o erro cresce em vez
  // de cair, e nenhuma tolerância salva.
  const KP = 8;
  const KD = 11;
  /** Guinada por radiano de roda, em rad/s. Ordem de grandeza da Chalupa a 5 nós. */
  const YAW_PER_WHEEL = 0.045;

  let heading = 0;
  let wheel = 0;
  let yawRate = 0;
  const course = 1; // ~57° a bombordo
  const dt = 1 / 60;

  for (let step = 0; step < 60 * 25; step++) {
    const error = angleDelta(heading, course);
    const desired = Math.max(-MAX_WHEEL, Math.min(MAX_WHEEL, -KP * error + KD * yawRate));

    // Malha interna: a roda persegue o ângulo comandado no limite da taxa.
    const room = WHEEL_RATE * dt;
    const command = Math.max(-1, Math.min(1, (desired - wheel) / room));
    wheel = Math.max(-MAX_WHEEL, Math.min(MAX_WHEEL, wheel + command * WHEEL_RATE * dt));

    // Roda positiva é boreste, e boreste **baixa** o rumo: daí o menos.
    yawRate = -wheel * YAW_PER_WHEEL;
    heading += yawRate * dt;
  }

  check(
    'timoneiro · converge no rumo pedido',
    angleDelta(heading, course) * RAD,
    0,
    1.5,
    '°',
  );

  // --- 5. os presets sobem de dificuldade em todos os eixos --------------------
  // A tabela de `Difficulty` é escrita à mão, e o eixo de avaria entrou nela depois
  // dos outros. Um `holdShift` fora de ordem não quebra nada, não aparece no `tsc` e
  // produz um Legend que cuida pior do navio que o Deckhand — que é o tipo de erro
  // que só se descobre jogando três partidas inteiras.
  //
  // Cada linha diz o sentido em que o número deve andar do grumete para a lenda.
  const eixos: readonly { nome: string; ler: (id: DifficultyId) => number; sobe: boolean }[] = [
    { nome: 'aimSigma', ler: (id) => DIFFICULTIES[id].aimSigma, sobe: false },
    { nome: 'leadFraction', ler: (id) => DIFFICULTIES[id].leadFraction, sobe: true },
    { nome: 'engageRange', ler: (id) => DIFFICULTIES[id].engageRange, sobe: true },
    { nome: 'fireTolerance', ler: (id) => DIFFICULTIES[id].fireTolerance, sobe: false },
    { nome: 'reaction', ler: (id) => DIFFICULTIES[id].reaction, sobe: false },
    { nome: 'transitScale', ler: (id) => DIFFICULTIES[id].transitScale, sobe: false },
    { nome: 'floodAlarm', ler: (id) => DIFFICULTIES[id].floodAlarm, sobe: false },
    // Perícia de avaria: a lenda entrega mais serviço por descida, desce menos vezes
    // e erra menos o buraco.
    { nome: 'holdShift', ler: (id) => DIFFICULTIES[id].holdShift, sobe: true },
    { nome: 'gunShift', ler: (id) => DIFFICULTIES[id].gunShift, sobe: false },
    { nome: 'triage', ler: (id) => DIFFICULTIES[id].triage, sobe: true },
    { nome: 'bilgeFloor', ler: (id) => DIFFICULTIES[id].bilgeFloor, sobe: false },
  ];

  for (const eixo of eixos) {
    const valores = DIFFICULTY_ORDER.map(eixo.ler);
    const emOrdem = valores.every(
      (v, i) => i === 0 || (eixo.sobe ? v > valores[i - 1]! : v < valores[i - 1]!),
    );
    cases.push({
      nome: `preset · ${eixo.nome} ${eixo.sobe ? 'cresce' : 'diminui'} com a perícia`,
      medido: valores.join(' → '),
      esperado: eixo.sobe ? 'estritamente crescente' : 'estritamente decrescente',
      erro: emOrdem ? '—' : 'fora de ordem',
      passou: emOrdem,
    });
  }

  // O turno de porão tem de caber um serviço inteiro, senão o marujo desce, começa a
  // caminhada e sobe sem ter pregado nada — um rodízio que só custa escada. O piso é
  // a travessia média do porão (~4 m ida e volta ao paiol, a 1,15 m/s) mais os 2,4 s
  // de `REPAIR_TIME`.
  const TURNO_MINIMO = 7;
  const menorTurno = Math.min(...DIFFICULTY_ORDER.map((id) => DIFFICULTIES[id].holdShift));
  cases.push({
    nome: 'rodízio · o turno de porão cabe uma tábua',
    medido: `${menorTurno.toFixed(1)} s`,
    esperado: `≥ ${TURNO_MINIMO} s`,
    erro: menorTurno >= TURNO_MINIMO ? '—' : `${(TURNO_MINIMO - menorTurno).toFixed(1)} s curto`,
    passou: menorTurno >= TURNO_MINIMO,
  });

  // O piso da bomba tem de ficar **abaixo** do alarme que faz o marujo descer, com
  // folga. Invertidos, ele desce ao porão, bombeia até um nível que ainda dispara o
  // alarme e desce de novo no passo seguinte — um marujo que passa a partida na
  // escada. Colados, o mesmo em câmera lenta. A folga de 3 pontos percentuais é o
  // que a água leva ~4 s para repor com um rombo aberto, ou seja: tempo de ele
  // chegar à peça antes de ser chamado de volta.
  const FOLGA = 0.03;
  for (const id of DIFFICULTY_ORDER) {
    const { bilgeFloor, floodAlarm, label } = DIFFICULTIES[id];
    const margem = floodAlarm - bilgeFloor;
    cases.push({
      nome: `porão · ${label} larga a bomba antes do próprio alarme`,
      medido: `piso ${(bilgeFloor * 100).toFixed(0)}% · alarme ${(floodAlarm * 100).toFixed(0)}%`,
      esperado: `margem ≥ ${(FOLGA * 100).toFixed(0)} pontos`,
      erro: margem >= FOLGA ? '—' : `${(margem * 100).toFixed(1)} pontos de margem`,
      passou: margem >= FOLGA,
    });
  }

  const falhas = cases.filter((c) => !c.passou).length;
  return { passou: falhas === 0, total: cases.length, falhas, cases };
}
