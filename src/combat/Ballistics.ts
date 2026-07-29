/**
 * Balística: a física de uma bala de canhão no ar, e o inverso dela.
 *
 * Duas coisas moram aqui, e é de propósito que morem juntas:
 *
 * - **O passo de integração** que o projétil usa em voo.
 * - **O solucionador de pontaria** — dado onde o alvo está e para onde vai, qual
 *   elevação e qual direção acertam.
 *
 * O solucionador não tem fórmula fechada: com arrasto quadrático a trajetória
 * deixa de ser parábola e a inversa não existe em forma analítica. Então ele
 * **simula** com a mesma função de passo que o projétil real usa, e busca o
 * ângulo por bisseção. É mais caro que uma conta de papel, e é a única maneira de
 * o tiro previsto e o tiro disparado concordarem — se a IA usasse a parábola de
 * vácuo, erraria por metros justamente nos tiros longos, que é onde a diferença
 * entre as três dificuldades tem que aparecer.
 *
 * Escala do problema: a 95 m/s a bala perde ~5,4 m/s² só de arrasto no início do
 * voo, contra os 9,81 da gravidade. Não é um detalhe que dê para ignorar.
 */

import * as THREE from 'three';
import { AIR_DENSITY, GRAVITY, clamp } from '../core/MathUtils';

/** Coeficiente de arrasto de uma esfera lisa em regime subsônico. */
export const SPHERE_DRAG = 0.47;

/** Passo da simulação interna do solucionador, em segundos. */
const SOLVER_STEP = 1 / 120;
/** Teto de tempo de voo que o solucionador considera, em segundos. */
const SOLVER_MAX_TIME = 14;

/** Elevação mais baixa que o solucionador tenta, em radianos. */
const SOLVER_MIN_ELEVATION = -0.35;
/**
 * E a mais alta (44°).
 *
 * Fica logo abaixo do ângulo de alcance máximo de propósito: é ali que a altura
 * a uma dada distância deixa de crescer com a elevação, e a bisseção precisa de
 * monotonicidade para valer. Quem quiser o arco alto que suba o limite — mas o
 * combate naval é tiro tenso, não morteiro.
 */
const SOLVER_MAX_ELEVATION = 0.77;

/**
 * Fator de arrasto de um projétil: `k = ½·ρ·Cd·A / m`.
 *
 * Guardado pronto porque a desaceleração é `k·|v|·v` e essa conta roda por
 * sub-passo, por bala. Depende só de massa e raio, que não mudam em voo.
 */
export function dragFactor(mass: number, radius: number): number {
  return (0.5 * AIR_DENSITY * SPHERE_DRAG * Math.PI * radius * radius) / mass;
}

const _accel = new THREE.Vector3();

/**
 * Um passo de voo, semi-implícito: acelera primeiro, anda depois.
 *
 * Semi-implícito (e não Euler puro) porque com arrasto o erro do explícito se
 * acumula sempre no mesmo sentido — a bala vai parando um pouco menos do que
 * devia a cada passo, e a 60 Hz isso vira metros de alcance a mais.
 */
export function stepBallistic(
  position: THREE.Vector3,
  velocity: THREE.Vector3,
  dragK: number,
  dt: number,
): void {
  const speed = velocity.length();
  _accel.copy(velocity).multiplyScalar(-dragK * speed);
  _accel.y -= GRAVITY;

  velocity.addScaledVector(_accel, dt);
  position.addScaledVector(velocity, dt);
}

export interface FlightResult {
  /** Altura relativa ao ponto de partida quando o alcance foi cruzado. */
  height: number;
  /** Tempo de voo até ali, em segundos. */
  time: number;
  /** `false` quando a bala nunca chegou ao alcance pedido. */
  reached: boolean;
}

const _flightPos = new THREE.Vector3();
const _flightVel = new THREE.Vector3();
const _previousPos = new THREE.Vector3();

/**
 * Voa um tiro no plano vertical e devolve a altura ao cruzar `range`.
 *
 * Trabalha em duas dimensões (X é o alcance no chão, Y a altura) porque o
 * problema *é* bidimensional: o vento não desvia a bala neste jogo, então o
 * plano do tiro contém a origem, o alvo e a gravidade.
 */
export function flyToRange(
  range: number,
  elevation: number,
  speed: number,
  dragK: number,
): FlightResult {
  _flightPos.set(0, 0, 0);
  _flightVel.set(Math.cos(elevation) * speed, Math.sin(elevation) * speed, 0);

  const steps = Math.ceil(SOLVER_MAX_TIME / SOLVER_STEP);
  for (let i = 0; i < steps; i++) {
    _previousPos.copy(_flightPos);
    stepBallistic(_flightPos, _flightVel, dragK, SOLVER_STEP);

    if (_flightPos.x >= range) {
      // Interpola dentro do passo em que cruzou: sem isso o resultado ganha um
      // degrau de até 80 cm (um passo de voo), e a bisseção fica procurando um
      // ângulo que a discretização escondeu.
      const span = _flightPos.x - _previousPos.x;
      const s = span > 1e-9 ? (range - _previousPos.x) / span : 0;
      return {
        height: _previousPos.y + (_flightPos.y - _previousPos.y) * s,
        time: (i + s) * SOLVER_STEP,
        reached: true,
      };
    }

    // Já vem descendo e passou bem abaixo do alvo: não vai chegar.
    if (_flightVel.x <= 0.01) break;
  }

  return { height: _flightPos.y, time: SOLVER_MAX_TIME, reached: false };
}

export interface AimSolution {
  /** Elevação do cano acima da horizontal, em radianos. */
  elevation: number;
  /** Tempo de voo até o alvo, em segundos. */
  time: number;
}

/**
 * Elevação que faz a bala passar por (`range`, `height`) relativo à boca.
 *
 * Bisseção sobre o arco baixo. A altura no alcance cresce com a elevação até o
 * ângulo de alcance máximo, e `SOLVER_MAX_ELEVATION` fica abaixo dele — dentro
 * dessa faixa a função é monótona e a bisseção é exata.
 *
 * @returns `null` quando nem na elevação máxima a bala chega lá.
 */
export function solveElevation(
  range: number,
  height: number,
  speed: number,
  dragK: number,
): AimSolution | null {
  if (range <= 0.01) return null;

  const highest = flyToRange(range, SOLVER_MAX_ELEVATION, speed, dragK);
  if (!highest.reached || highest.height < height) return null;

  let low = SOLVER_MIN_ELEVATION;
  let high = SOLVER_MAX_ELEVATION;
  let result = highest;

  // Vinte voltas levam a faixa de 1,12 rad a ~1 µrad: muito além do que a
  // travessia da carreta consegue apontar, e ainda assim barato (uma simulação
  // de 2D por volta, ~2 mil passos no pior caso).
  for (let i = 0; i < 20; i++) {
    const mid = (low + high) * 0.5;
    result = flyToRange(range, mid, speed, dragK);
    if (result.reached && result.height >= height) high = mid;
    else low = mid;
  }

  return { elevation: high, time: result.time };
}

const _toTarget = new THREE.Vector3();
const _predicted = new THREE.Vector3();

export interface InterceptSolution extends AimSolution {
  /** Azimute do tiro, em radianos, medido como `atan2(x, z)` no mundo. */
  azimuth: number;
  /** Ponto do mundo onde a bala e o alvo se encontram. */
  readonly aimPoint: THREE.Vector3;
}

/**
 * Onde apontar para acertar um alvo que está andando.
 *
 * O problema é implícito — o tempo de voo depende de onde o alvo vai estar, e
 * onde ele vai estar depende do tempo de voo —, então resolve-se por iteração de
 * ponto fixo. Três voltas bastam: o alvo faz no máximo uns 6 m/s e a correção da
 * terceira volta já está na casa dos centímetros.
 *
 * A velocidade da boca herdada do navio que atira **não** entra aqui. Quem chama
 * subtrai a própria velocidade do alvo antes, se quiser essa correção — do jeito
 * que está, `targetVelocity` é a velocidade *relativa* que interessa.
 */
export function solveIntercept(
  muzzle: THREE.Vector3,
  targetPosition: THREE.Vector3,
  targetVelocity: THREE.Vector3,
  speed: number,
  dragK: number,
  iterations = 3,
): InterceptSolution | null {
  _predicted.copy(targetPosition);
  let solution: AimSolution | null = null;

  for (let i = 0; i < iterations; i++) {
    _toTarget.subVectors(_predicted, muzzle);
    const range = Math.hypot(_toTarget.x, _toTarget.z);

    solution = solveElevation(range, _toTarget.y, speed, dragK);
    if (!solution) return null;

    _predicted.copy(targetPosition).addScaledVector(targetVelocity, solution.time);
  }

  if (!solution) return null;

  _toTarget.subVectors(_predicted, muzzle);
  return {
    elevation: solution.elevation,
    time: solution.time,
    azimuth: Math.atan2(_toTarget.x, _toTarget.z),
    aimPoint: _predicted.clone(),
  };
}

/**
 * Alcance máximo teórico, em metros — quanto voa um tiro saindo da linha d'água
 * no melhor ângulo. Serve para a IA descartar alvos longe demais sem simular.
 */
export function maxRange(speed: number, dragK: number): number {
  let best = 0;
  for (let i = 0; i <= 12; i++) {
    const elevation = clamp((i / 12) * SOLVER_MAX_ELEVATION, 0, SOLVER_MAX_ELEVATION);
    _flightPos.set(0, 0, 0);
    _flightVel.set(Math.cos(elevation) * speed, Math.sin(elevation) * speed, 0);

    const steps = Math.ceil(SOLVER_MAX_TIME / SOLVER_STEP);
    for (let s = 0; s < steps; s++) {
      _previousPos.copy(_flightPos);
      stepBallistic(_flightPos, _flightVel, dragK, SOLVER_STEP);
      if (_flightPos.y <= 0) {
        const drop = _previousPos.y - _flightPos.y;
        const f = drop > 1e-9 ? _previousPos.y / drop : 0;
        best = Math.max(best, _previousPos.x + (_flightPos.x - _previousPos.x) * f);
        break;
      }
    }
  }
  return best;
}
