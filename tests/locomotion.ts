/**
 * Testes dos relógios do corpo — as propriedades que sustentam corpo e câmera.
 *
 * Rodável no navegador, como os outros:
 *
 * ```js
 * const t = await import('/tests/locomotion.ts');
 * console.table(t.runLocomotionTests().cases);
 * ```
 *
 * **O que se prova aqui, na passada.** A animação inteira se apoia numa
 * igualdade só: o pé fica parado no chão durante o apoio *se e somente se* a
 * fase avançar pela distância percorrida, e não pelo tempo. Escrito em uma
 * linha:
 *
 *     fase += (velocidade × dt) / distância_do_ciclo
 *
 * Disso cai que **uma passada por ciclo cobre exatamente a distância do ciclo**,
 * em qualquer velocidade e com qualquer mistura entre andar e correr. É o que os
 * dois primeiros casos medem, integrando o relógio quadro a quadro em vez de
 * conferir a fórmula contra ela mesma.
 *
 * Os outros dois cobrem a fase da curva vertical, que é onde um sinal trocado
 * passa despercebido: o corpo tem de estar **baixo** no contato quando anda e
 * **alto** no meio do voo quando corre. Invertido, a câmera sobe quando o pé
 * bate — e o efeito lê como "algo está estranho", nunca como "o cosseno está
 * com o sinal errado".
 *
 * **E no pulo.** O clipe de ar é indexado pela velocidade vertical, e disso cai
 * a propriedade que fez três clipes virarem dois: **o pulo padrão percorre o
 * clipe inteiro exatamente uma vez**, da decolagem ao contato, sem que ninguém
 * tenha ajustado uma duração para isso. Um clipe medido no relógio aterrissaria
 * no meio do ápice num pulinho e daria três voltas numa queda do mastro; este
 * satura sozinho.
 *
 * O voo é simulado com a **mesma ordem de operações** do `PlayerController`,
 * incluindo o detalhe que morde: o chão é resolvido *antes* de o relógio ser
 * alimentado, então no quadro do contato a velocidade de impacto já vale zero.
 * Testar o relógio com a velocidade que ele "deveria" ver esconderia justamente
 * o bug que a cópia interna existe para evitar.
 *
 * **E no timão.** É o mesmo teorema da escada com outra régua, e a régua aqui é a
 * própria roda: um ciclo do clipe cobre 45° e a roda tem oito punhos, então varrer
 * o curso inteiro — de batente a batente, uma volta redonda — tem de fechar
 * **oito ciclos exatos** e devolver a fase de onde ela saiu. Traduzido para o que
 * se vê: a mão volta ao mesmo punho. O sweep roda contra o `Rudder` de verdade,
 * porque é ele quem grampeia o curso e define a cadência.
 *
 * E há o caso que só existe em JavaScript: metade do curso vive em ângulo
 * negativo, e `-0.3 % 1` dá `-0.3` nesta linguagem. Uma fase negativa escrita em
 * `.time` vira quadro do fim do clipe — a mão saltando um punho ao cruzar o leme
 * a meio. O último caso mede exatamente isso, com o número que quebra.
 *
 * **E no corpo vestido.** Desde que o jogador enxerga o próprio corpo, duas
 * coisas que antes não tinham como estar erradas passaram a ter. A primeira é a
 * amplitude do balanço: em terceira pessoa a câmera podia exagerar à vontade, e
 * de dentro qualquer exagero é o tronco deslizando por baixo do olho — os casos
 * medem que a altura pedida é **a do clipe**, nas duas velocidades nativas. A
 * segunda é a dobra das pernas para andar de ré, cujo caso difícil é o strafe
 * puro: ali o desvio fica cravado nos 90° e, sem histerese, o corpo daria
 * meia-volta a cada quadro. O teste alimenta a dobra com o mesmo desvio 120
 * vezes e exige que ela não se mexa, entrando pelos dois lados.
 */

import { GRAVITY, wrapAngle } from '../src/core/MathUtils';
import { foldLegHeading } from '../src/player/FirstPersonBody';
import {
  CLIMB_CLIP,
  ClimbClock,
  GaitClock,
  HELM_CLIP,
  HelmClock,
  JUMP_SPEED,
  JumpClock,
  LAND_CLIP,
  RUN_CLIP,
  RUN_DISTANCE,
  WALK_CLIP,
  WALK_DISTANCE,
} from '../src/player/Locomotion';
import { MAX_WHEEL, Rudder } from '../src/ship/Rudder';
import { MAST_LADDER } from '../src/ship/ShipParts';

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
 * Roda o relógio até ele estabilizar e devolve a distância coberta por ciclo.
 *
 * A medição vai **de volta a volta**, e não ao longo de um intervalo qualquer.
 * A primeira versão dividia a distância de 6 s pelo número de voltas inteiras
 * dentro dela; como 6 s não fecha um número inteiro de ciclos, sobrava um
 * pedaço de passada no numerador e o resultado saía 6% baixo. O código estava
 * certo e o teste, errado — que é o jeito mais barato de perder uma tarde.
 */
function distancePerCycle(speed: number, dt = 1 / 240): { distance: number; cycles: number } {
  const gait = new GaitClock();

  // Meio segundo para a mistura convergir: ela é amortecida, e medir durante a
  // convergência mediria o amortecedor, não a passada.
  for (let t = 0; t < 0.5; t += dt) gait.update(dt, speed, true);

  let closed = 0;                           // só ciclos que fecharam
  let pending = 0;                          // o ciclo em andamento
  let cycles = 0;
  let counting = false;
  let previous = gait.phase;

  for (let t = 0; t < 8; t += dt) {
    gait.update(dt, speed, true);
    const wrapped = gait.phase < previous;
    previous = gait.phase;

    if (wrapped && !counting) {
      counting = true;                      // começa a contar na primeira volta
      continue;
    }
    if (!counting) continue;

    pending += speed * dt;
    if (wrapped) {                          // fechou: só agora vira medida
      closed += pending;
      pending = 0;
      cycles++;
    }
  }
  return { distance: closed / cycles, cycles };
}

interface FlightLog {
  /** Tempo entre a saída do chão e o contato, em segundos. */
  flight: number;
  /** Fase do clipe de ar no quadro em que a subida virou queda. */
  phaseAtApex: number;
  /** Fase do clipe de ar no último quadro antes do contato. */
  phaseAtContact: number;
  /** Maior soma de pesos vista em qualquer quadro do voo. */
  peakWeight: number;
  /** Quadros em que ar e pouso tiveram peso ao mesmo tempo. */
  overlap: number;
  /** Força do pouso disparado no contato. */
  impact: number;
}

/**
 * Simula uma queda de `fromHeight` metros, opcionalmente com impulso inicial.
 *
 * Reproduz o laço do `PlayerController` na ordem em que ele acontece: gravidade,
 * integração, chão, e **só então** o relógio. Um pulo padrão é
 * `simulateFall(0, JUMP_SPEED)`; a queda do cesto da gávea é `simulateFall(9)`.
 */
function simulateFall(fromHeight: number, launch = 0, dt = 1 / 60): FlightLog {
  const clock = new JumpClock();
  let y = fromHeight;
  let vy = launch;
  let grounded = false;
  let rising = launch > 0;

  const log: FlightLog = {
    flight: 0,
    phaseAtApex: 0,
    phaseAtContact: 0,
    peakWeight: 0,
    overlap: 0,
    impact: 0,
  };

  for (let t = 0; t < 12; t += dt) {
    if (!grounded) {
      vy -= GRAVITY * dt;
      y += vy * dt;
    }

    const peaked = rising && vy <= 0;
    if (peaked) rising = false;

    const wasAirborne = !grounded;
    if (vy <= 0 && y <= 0) {
      // Lido antes do `update`, que é onde ela ainda existe: o relógio nunca
      // chega a ver esta fase, ele só a deixou registrada no quadro anterior.
      if (wasAirborne) log.phaseAtContact = clock.airPhase;
      y = 0;
      vy = 0;
      grounded = true;
    }

    clock.update(dt, vy, grounded);

    if (peaked) log.phaseAtApex = clock.airPhase;
    log.peakWeight = Math.max(log.peakWeight, clock.air + clock.land);
    if (clock.air > 1e-4 && clock.land > 1e-4) log.overlap++;
    if (grounded && wasAirborne) {
      log.flight = t + dt;
      log.impact = clock.impact;
      // Mais meio segundo no chão: é o que o pouso precisa para rodar e sumir.
      for (let u = 0; u < 0.5; u += dt) {
        clock.update(dt, 0, true);
        log.peakWeight = Math.max(log.peakWeight, clock.air + clock.land);
        if (clock.air > 1e-4 && clock.land > 1e-4) log.overlap++;
      }
      break;
    }
  }

  return log;
}

interface HelmSweep {
  /** Punhos que a mão trocou no percurso: uma volta de fase por punho. */
  cycles: number;
  /** Fase no fim do curso. */
  phase: number;
  /** Menor fase vista em qualquer quadro. Negativo aqui é módulo vazando. */
  minPhase: number;
  /** Quadros que o curso levou, na cadência real da roda. */
  frames: number;
}

/**
 * Gira a roda de um batente ao outro e integra o relógio do timão quadro a
 * quadro.
 *
 * Usa o `Rudder` do jogo, e não uma rampa escrita à mão: é ele quem grampeia o
 * curso em `MAX_WHEEL` e quem sabe quanto a roda anda por segundo. Um teste que
 * reproduzisse essa aritmética estaria medindo a própria cópia — é o mesmo motivo
 * pelo qual o caso da escada lê o espaçamento da escada de verdade.
 *
 * @param direction +1 gira para boreste, -1 para bombordo.
 */
function sweepWheel(direction: 1 | -1, dt = 1 / 60): HelmSweep {
  const rudder = new Rudder();
  const clock = new HelmClock();

  // Do batente contrário, para o percurso ser o curso inteiro e não um pedaço.
  rudder.wheelAngle = -direction * MAX_WHEEL;
  clock.update(dt, true, rudder.wheelAngle);

  const sweep: HelmSweep = {
    cycles: 0,
    phase: clock.phase,
    minPhase: clock.phase,
    frames: 0,
  };
  let previous = clock.phase;

  // Quem encerra o laço é o grampo do `Rudder`: chegar ao batente é chegar ao fim
  // do curso. O último quadro é parcial de propósito — a roda não leva um número
  // inteiro de quadros de um batente ao outro, e é justamente aí que um erro de
  // arredondamento apareceria.
  while (rudder.wheelAngle * direction < MAX_WHEEL && sweep.frames < 600) {
    rudder.update(direction, dt);
    clock.update(dt, true, rudder.wheelAngle);
    // Boreste sobe a fase e bombordo a desce, então o fim do ciclo troca de lado
    // junto: contar sempre "caiu" acharia uma volta por quadro na descida.
    if (direction > 0 ? clock.phase < previous : clock.phase > previous) sweep.cycles++;
    previous = clock.phase;
    sweep.minPhase = Math.min(sweep.minPhase, clock.phase);
    sweep.frames++;
  }

  sweep.phase = clock.phase;
  return sweep;
}

export function runLocomotionTests(): TestReport {
  const cases: TestCase[] = [];

  function check(nome: string, medido: number, esperado: number, tolerancia: number,
                 unidade: string): void {
    const erro = Math.abs(medido - esperado);
    cases.push({
      nome,
      medido: `${medido.toFixed(4)} ${unidade}`,
      esperado: `${esperado.toFixed(4)} ${unidade}`,
      erro: erro.toFixed(5),
      passou: erro <= tolerancia,
    });
  }

  // 1. Na velocidade nativa da caminhada, o ciclo tem de cobrir exatamente a
  //    distância do clipe de caminhada — nem mais, nem menos.
  const walk = distancePerCycle(WALK_CLIP.speed);
  check('passada a 1,65 m/s cobre a distância do clipe de andar',
    walk.distance, WALK_DISTANCE, 0.02, 'm');

  // 2. Idem na corrida. Entre as duas, a distância é interpolada, e é por isso
  //    que o pé não patina no meio da mistura.
  const run = distancePerCycle(RUN_CLIP.speed);
  check('passada a 3,67 m/s cobre a distância do clipe de correr',
    run.distance, RUN_DISTANCE, 0.03, 'm');

  // 3. Andando, o corpo está no ponto mais baixo no contato (fase 0), que é
  //    quando as pernas estão mais abertas.
  const walking = new GaitClock();
  for (let t = 0; t < 1; t += 1 / 60) walking.update(1 / 60, WALK_CLIP.speed, true);
  walking.phase = 0;
  check('andando, corpo no ponto baixo no contato', walking.bounce, -1, 0.001, '');

  walking.phase = 0.25;
  check('andando, corpo no ponto alto na passagem', walking.bounce, 1, 0.001, '');

  // 4. Correndo, o ponto baixo migra para o meio do apoio — a perna virou mola.
  //    No contato o corpo já não está no fundo.
  const running = new GaitClock();
  for (let t = 0; t < 2; t += 1 / 60) running.update(1 / 60, RUN_CLIP.speed * 1.5, true);
  running.phase = RUN_CLIP.bouncePhase;
  check('correndo, corpo no ponto baixo no meio do apoio', running.bounce, -1, 0.01, '');

  running.phase = RUN_CLIP.bouncePhase + 0.25;
  check('correndo, corpo no ponto alto no meio do voo', running.bounce, 1, 0.01, '');

  // 5. Parado, a fase congela: sem isto o personagem "anda no lugar" enquanto a
  //    câmera balança sozinha.
  const still = new GaitClock();
  for (let t = 0; t < 0.5; t += 1 / 60) still.update(1 / 60, 2.8, true);
  const frozen = still.phase;
  for (let t = 0; t < 1; t += 1 / 60) still.update(1 / 60, 0, true);
  check('parado, a fase não avança', still.phase, frozen, 1e-9, '');

  // 6. E a locomoção se apaga sozinha. É o que faz o personagem largar a pose de
  //    corrida ao assumir o timão: quem está numa estação alimenta o relógio com
  //    velocidade zero, e o parado assume por peso. Sem isto ele fica congelado
  //    num quadro de corrida atrás da roda.
  const settling = new GaitClock();
  for (let t = 0; t < 1; t += 1 / 60) settling.update(1 / 60, RUN_CLIP.speed, true);
  for (let t = 0; t < 1; t += 1 / 60) settling.update(1 / 60, 0, true);
  check('locomoção se apaga um segundo depois de parar', settling.moving, 0, 0.001, '');

  // -- o pulo ------------------------------------------------------------------

  // 7. A propriedade central: o pulo do jogo percorre o clipe de ar de ponta a
  //    ponta, uma vez só. Ninguém ajustou a duração do clipe para isso — ela cai
  //    da fase ser lida da velocidade vertical, com a de saída como escala.
  //
  //    A tolerância é **derivada**, não escolhida: a fase é amostrada uma vez
  //    por quadro, e um quadro de queda vale isto de fase. Apertar mais seria
  //    exigir do relógio uma resolução que o laço do jogo não tem, e afrouxar
  //    mais deixaria passar um erro de verdade. Ver a nota de `distancePerCycle`
  //    sobre a tarde que se perde com um teste errado sobre um código certo.
  const FRAME_PHASE = (GRAVITY * (1 / 60)) / (2 * JUMP_SPEED);

  const jump = simulateFall(0, JUMP_SPEED);
  check('pulo padrão voa 0,67 s', jump.flight, (2 * JUMP_SPEED) / GRAVITY, 0.03, 's');
  check('no ápice, o clipe de ar está na metade',
    jump.phaseAtApex, 0.5, FRAME_PHASE, '');
  // O dobro aqui: o corpo cruza o convés no **meio** de um quadro, então o
  // último ponto amostrado no ar fica mais longe do contato do que o do ápice
  // fica do topo.
  check('no contato, o clipe de ar chegou ao fim',
    jump.phaseAtContact, 1, 2 * FRAME_PHASE, '');

  // 8. Cair de nove metros não quebra nada: a fase satura e o corpo passa a
  //    queda inteira no último quadro, pernas estendidas à espera do convés. É o
  //    que permite um clipe só para qualquer altura.
  const drop = simulateFall(9);
  check('queda do mastro satura a fase do ar', drop.phaseAtContact, 1, 1e-9, '');
  check('queda do mastro dá pouso cheio', drop.impact, 1, 1e-9, '');

  // 9. E o pulo do próprio jogo é a referência do pouso cheio: cair de nove
  //    metros não tem como bater mais forte que isso, porque o clipe é um só.
  //    A comparação é contra a queda, e não contra 1, porque a velocidade
  //    guardada é a do último quadro *no ar* e não a do contato — o relógio
  //    nunca chega a ver a segunda, e essa diferença de um quadro é justamente o
  //    que a cópia interna existe para não perder por inteiro.
  check('pulo padrão pousa tão forte quanto a queda do mastro',
    jump.impact, drop.impact, 0.1, '');

  // 10. Já um tropeço de quatro centímetros não é pouso nenhum. Sem este piso,
  //     qualquer irregularidade do convés faria o personagem se agachar.
  const stumble = simulateFall(0.04);
  check('tropeço de 4 cm não dispara pouso', stumble.impact, 0, 1e-9, '');

  // 11. Os pesos são uma partição, não uma soma solta: o ar chega a 1 no voo e
  //     nada nunca passa disso. O que sobrasse acima de 1 o Three tira da
  //     locomoção; o que faltasse ele preencheria com a T-pose do rig.
  check('no voo, o clipe de ar chega a peso cheio', jump.peakWeight, 1, 0.001, '');
  check('ar e pouso nunca têm peso no mesmo quadro', jump.overlap, 0, 0, ' quadros');

  // 12. O pouso é o único dos dois que roda no relógio, e ele termina junto com
  //     o clipe — não fica meio agachado para sempre.
  const landing = new JumpClock();
  for (let t = 0; t < 0.3; t += 1 / 60) landing.update(1 / 60, -JUMP_SPEED, false);
  landing.update(1 / 60, 0, true);
  const firstFrame = landing.land;
  for (let t = 0; t < LAND_CLIP.cycle; t += 1 / 60) landing.update(1 / 60, 0, true);
  check('pouso começa com peso cheio', firstFrame, 1, 0.05, '');
  check('pouso acaba junto com o clipe', landing.land, 0, 1e-9, '');

  // 13. Agarrar a escada tira os pés do chão sem que ninguém esteja voando. É o
  //     caso que `settle` cobre: alimentar `update` com `grounded` ali faria o
  //     personagem aterrissar no ar, a nove metros do convés.
  const ladder = new JumpClock();
  for (let t = 0; t < 0.3; t += 1 / 60) ladder.update(1 / 60, -JUMP_SPEED, false);
  for (let t = 0; t < 0.5; t += 1 / 60) ladder.settle(1 / 60);
  check('agarrar a escada apaga o clipe de ar', ladder.air, 0, 0.001, '');
  ladder.update(1 / 60, 0, true);
  check('chegar ao cesto não dispara pouso', ladder.land, 0, 1e-9, '');

  // -- a escada ----------------------------------------------------------------

  // 14. A propriedade central da escalada, gêmea da passada: subir a altura de um
  //     ciclo gira o clipe exatamente uma volta. É o que mantém a mão parada na
  //     barra enquanto o corpo sobe, em qualquer `CLIMB_SPEED`.
  const climb = new ClimbClock();
  climb.phase = 0;
  const steps = 600;
  for (let i = 0; i < steps; i++) climb.update(1 / 60, true, CLIMB_CLIP.rise / steps);
  check('subir um ciclo fecha uma volta da fase', climb.phase, 0, 1e-9, '');

  // 15. E a volta acontece na altura certa **da escada de verdade**: depois de
  //     alinhar uma vez, a barra que o clipe manda a mão agarrar coincide com um
  //     enfrechate desenhado, subindo o mastro inteiro. Este é o teste que
  //     amarra a animação à geometria do navio — se alguém mexer no espaçamento
  //     da escada ou na altura do cesto sem regerar o clipe, ele quebra aqui.
  const aligned = new ClimbClock();
  let feet = MAST_LADDER.bottomY;
  aligned.align(feet, MAST_LADDER.bottomY, MAST_LADDER.rungSpacing);

  let worstMiss = 0;
  for (let i = 0; i < 2000; i++) {
    const rise = 0.004;                       // ~ um quadro a 0,24 m/s
    feet += rise;
    aligned.update(1 / 60, true, rise);
    if (feet > MAST_LADDER.topY) break;
    // Altura, no navio, da barra que o pé esquerdo está segurando agora.
    const held = feet + CLIMB_CLIP.footRung - CLIMB_CLIP.rise * aligned.phase;
    const u = (held - MAST_LADDER.bottomY) / MAST_LADDER.rungSpacing;
    const fraction = ((u % 1) + 1) % 1;
    worstMiss = Math.max(worstMiss,
      Math.min(fraction, 1 - fraction) * MAST_LADDER.rungSpacing);
  }
  check('a mão cai na barra ao longo dos 9 m de escada', worstMiss, 0, 0.001, 'm');

  // 16. Descer é o mesmo clipe ao contrário: subir e voltar devolve a fase de
  //     onde saiu. É o que dispensa um segundo clipe — e o que garante que os
  //     contatos da descida caiam na mesma grade de barras da subida.
  const reversible = new ClimbClock();
  reversible.phase = 0.37;
  for (let i = 0; i < 120; i++) reversible.update(1 / 60, true, 0.01);
  for (let i = 0; i < 120; i++) reversible.update(1 / 60, true, -0.01);
  check('descer desfaz a subida na mesma fase', reversible.phase, 0.37, 1e-9, '');

  // 17. Parado na escada a fase congela: o personagem fica agarrado exatamente
  //     onde estava, sem deslizar. É a razão de não haver clipe de "hold".
  const holding = new ClimbClock();
  for (let i = 0; i < 60; i++) holding.update(1 / 60, true, 0.02);
  const held = holding.phase;
  for (let i = 0; i < 120; i++) holding.update(1 / 60, true, 0);
  check('parado na escada, a fase não anda', holding.phase, held, 1e-9, '');

  // 18. E largar a escada apaga o clipe sem mexer na fase — quem reagarra mais
  //     acima não recomeça o ciclo do zero.
  const released = new ClimbClock();
  for (let i = 0; i < 60; i++) released.update(1 / 60, true, 0.02);
  const frozenPhase = released.phase;
  for (let i = 0; i < 90; i++) released.update(1 / 60, false, 0);
  check('largar a escada apaga o peso', released.weight, 0, 0.001, '');
  check('largar a escada preserva a fase', released.phase, frozenPhase, 1e-9, '');

  // -- o timão -----------------------------------------------------------------

  // 19. A propriedade central do timão, gêmea da escada: a roda dá exatamente uma
  //     volta de batente a batente, e uma volta são os oito punhos. Varrer o
  //     curso inteiro tem de fechar oito ciclos e devolver a fase de onde ela
  //     saiu — que é o mesmo que dizer que a mão volta ao **mesmo punho**.
  //
  //     Este é o teste que amarra o clipe à roda desenhada: se alguém mudar
  //     `MAX_WHEEL` ou o número de punhos sem regerar a animação, ele quebra
  //     aqui, exatamente como o caso da escada quebra se o espaçamento mudar.
  const starboard = sweepWheel(1);
  check('a roda vai de batente a batente em oito punhos', starboard.cycles, 8, 0, ' punhos');
  check('e a mão volta ao mesmo punho', starboard.phase, 0, 1e-9, '');

  // 20. O caminho de volta é o mesmo clipe com a fase recuando — é isso que
  //     dispensa um segundo clipe e o que garante que os contatos de uma guinada
  //     a bombordo caiam nos mesmos oito punhos da guinada a boreste.
  const port = sweepWheel(-1);
  check('bombordo desfaz os mesmos oito punhos', port.cycles, 8, 0, ' punhos');
  check('e fecha o curso na mesma fase', port.phase, 0, 1e-9, '');

  // 21. Metade do curso vive em ângulo negativo, e é aí que a linguagem morde:
  //     `-0.3 % 1` dá `-0.3` em JS, não `0.7`. Uma fase negativa em `.time` sai
  //     como quadro do fim do clipe, ou seja, a mão saltando um punho inteiro ao
  //     cruzar o leme a meio. Os dois casos cobrem o vazamento pelos dois lados:
  //     o número exato que quebra, e o curso inteiro varrido.
  const negative = new HelmClock();
  negative.update(1 / 60, true, -0.3 * HELM_CLIP.step);
  check('roda a bombordo não vaza fase negativa', negative.phase, 0.7, 1e-9, '');
  check('e nenhum quadro do curso vaza tampouco', port.minPhase, 0, 1e-9, '');

  // 22. Largar o leme apaga o clipe sem mexer na fase, como largar a escada. Aqui
  //     isso é de graça — a fase é função do ângulo da roda, e a roda fica onde
  //     foi deixada —, mas continua sendo o que faz o timoneiro soltar a roda em
  //     vez de sair andando pelo convés de mãos em concha.
  const helmReleased = new HelmClock();
  helmReleased.update(1 / 60, true, 0.6 * HELM_CLIP.step);
  const helmPhase = helmReleased.phase;
  for (let i = 0; i < 90; i++) helmReleased.update(1 / 60, false, 0);
  check('largar o leme apaga o peso', helmReleased.weight, 0, 0.001, '');
  check('largar o leme preserva a fase', helmReleased.phase, helmPhase, 1e-9, '');

  // -- o corpo vestido ---------------------------------------------------------

  // 23. A altura que a câmera persegue é a **mesma** que o clipe levanta. Nas
  //     duas velocidades nativas o balanço tem de dar exatamente a amplitude
  //     escrita no Blender: era aqui que os 4,2 cm inventados da câmera
  //     discordavam dos 2,1 cm do clipe de caminhada, e a diferença aparecia
  //     como o tronco deslizando por baixo do olho de quem veste o corpo.
  const bobWalk = new GaitClock();
  for (let t = 0; t < 1; t += 1 / 60) bobWalk.update(1 / 60, WALK_CLIP.speed, true);
  bobWalk.phase = 0.25;
  check('andando, a câmera sobe o que o clipe de andar sobe',
    bobWalk.bounceMeters, WALK_CLIP.bounceAmplitude, 1e-4, 'm');

  const bobRun = new GaitClock();
  for (let t = 0; t < 2; t += 1 / 60) bobRun.update(1 / 60, RUN_CLIP.speed * 1.5, true);
  bobRun.phase = RUN_CLIP.bouncePhase + 0.25;
  check('correndo, a câmera sobe o que o clipe de correr sobe',
    bobRun.bounceMeters, RUN_CLIP.bounceAmplitude, 1e-3, 'm');

  // 24. O strafe puro é o caso que quebra um limiar único: o desvio fica cravado
  //     em 90°, e sem histerese as pernas dariam meia-volta de 180° a cada
  //     quadro. Alimentado sempre com o mesmo desvio, o estado tem de ficar onde
  //     estava — nos dois sentidos.
  let straferForward = false;
  let straferBack = true;
  for (let i = 0; i < 120; i++) {
    straferForward = foldLegHeading(Math.PI / 2, 0, straferForward).reversed;
    straferBack = foldLegHeading(Math.PI / 2, 0, straferBack).reversed;
  }
  check('strafe puro não oscila entrando de frente', straferForward ? 1 : 0, 0, 0, '');
  check('strafe puro não oscila entrando de ré', straferBack ? 1 : 0, 1, 0, '');

  // 25. E a dobra continua acontecendo onde tem de acontecer: andar de ré vira
  //     ré, e o rumo dobrado volta a apontar para onde a animação sabe andar.
  const backwards = foldLegHeading(Math.PI, 0, false);
  check('andar de ré dobra as pernas', backwards.reversed ? 1 : 0, 1, 0, '');
  check('e o rumo dobrado alinha com o tronco',
    Math.abs(wrapAngle(backwards.heading - 0)), 0, 1e-9, 'rad');

  const falhas = cases.filter((c) => !c.passou).length;
  return { passou: falhas === 0, total: cases.length, falhas, cases };
}
