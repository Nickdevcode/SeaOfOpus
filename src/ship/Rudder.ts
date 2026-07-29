/**
 * Leme e roda do timão.
 *
 * A roda do Sea of Thieves não é um volante de carro: ela não volta ao centro
 * sozinha, e segurar `A`/`D` (ou o analógico) a gira continuamente até o batente.
 * Por isso a entrada aqui é **taxa**, não posição — o ângulo é estado, e quem
 * larga o timão deixa o navio na guinada em que estava. É essa inércia que
 * obriga a antecipar a curva, e é ela que dá o peso do navio grande.
 *
 * A força é hidrodinâmica de verdade, não um torque de guinada aplicado à mão:
 * uma placa inclinada num escoamento gera força normal proporcional a `u²`, e o
 * torque nasce do braço até a popa. Duas consequências que o jogo precisa e que
 * saem de graça: **navio parado não esterça**, e **navio de ré esterça ao
 * contrário**.
 */

import * as THREE from 'three';
import { WATER_DENSITY, clamp } from '../core/MathUtils';
import { measureRudderBlade } from './ShipDimensions';
import type { ShipBody } from './ShipBody';

/** Ângulo máximo do leme, em radianos (35°) — o batente clássico. */
export const MAX_RUDDER = 0.611;
/** Volta completa da roda de um batente ao outro: meia volta para cada lado. */
export const MAX_WHEEL = Math.PI;
/**
 * Velocidade angular da roda com a entrada no máximo, em rad/s.
 *
 * Exportada porque o timoneiro bot comanda um *ângulo* de roda e precisa saber
 * quanto dele cabe num passo para converter isso na taxa que esta classe aceita.
 * Duplicar o número lá seria deixar as duas descrições da mesma roda divergirem.
 */
export const WHEEL_RATE = 2.1;

/**
 * Coeficiente de força normal de uma placa, na formulação de Hoerner. Vale até
 * bem depois do estol, que é o regime em que um leme a 35° realmente trabalha.
 */
const RUDDER_CN = 1.9;

/**
 * Área e centro de pressão da pá, **medidos da geometria que o modelo desenha**
 * (`RUDDER_BLADE` em `ShipDimensions`) e não escolhidos aqui. Antes eram
 * constantes soltas, e as duas descrições da mesma pá divergiram quatro vezes.
 */
const BLADE = measureRudderBlade();
const RUDDER_AREA = BLADE.area;
const RUDDER_CENTER = new THREE.Vector3(0, BLADE.centerY, BLADE.centerZ);

const _localVelocity = new THREE.Vector3();
const _worldPoint = new THREE.Vector3();
const _worldArm = new THREE.Vector3();
const _pointVelocity = new THREE.Vector3();
const _force = new THREE.Vector3();

export class Rudder {
  /** Ângulo da roda, em radianos. Positivo é boreste (navio vira à direita). */
  wheelAngle = 0;
  /** Ângulo do leme, derivado da roda. */
  rudderAngle = 0;

  /** Última força lateral gerada, em newtons. Só telemetria. */
  lastSideForce = 0;

  /**
   * Os dois ângulos no passo anterior, para o desenho interpolar.
   *
   * A roda é a peça que o timoneiro tem na mão, e a única do navio cujo
   * movimento ele mede olhando: um degrau de 60 Hz aqui é lido como "a roda
   * enroscou", e não como taxa de quadros. Ver `Cannon.beginStep`.
   */
  previousWheelAngle = 0;
  previousRudderAngle = 0;

  /** Guarda a pose deste instante como a anterior. Ver `Cannon.beginStep`. */
  beginStep(): void {
    this.previousWheelAngle = this.wheelAngle;
    this.previousRudderAngle = this.rudderAngle;
  }

  /**
   * @param input -1 (bombordo) a +1 (boreste). É taxa de giro, não posição.
   */
  update(input: number, dt: number): void {
    this.wheelAngle = clamp(this.wheelAngle + clamp(input, -1, 1) * WHEEL_RATE * dt, -MAX_WHEEL, MAX_WHEEL);
    this.rudderAngle = (this.wheelAngle / MAX_WHEEL) * MAX_RUDDER;
  }

  /**
   * Põe a roda num ângulo dado, derivando o leme.
   *
   * Existe para quem recebe a pose pronta em vez de integrá-la — o cliente que
   * não simula. Escrever `wheelAngle` direto deixaria o leme com o valor do
   * passo anterior, e a pá desenhada apontando para um lado enquanto o navio
   * vira para o outro.
   */
  setWheel(angle: number): void {
    this.wheelAngle = clamp(angle, -MAX_WHEEL, MAX_WHEEL);
    this.rudderAngle = (this.wheelAngle / MAX_WHEEL) * MAX_RUDDER;
  }

  /** Centra a roda de uma vez — usado ao largar o timão numa transição. */
  center(): void {
    this.wheelAngle = 0;
    this.rudderAngle = 0;
    this.previousWheelAngle = 0;
    this.previousRudderAngle = 0;
  }

  /**
   * @param submersion fração submersa; leme fora d'água não faz força.
   */
  apply(body: ShipBody, submersion: number): void {
    const wetted = Math.min(submersion, 1);
    if (wetted <= 0.05) {
      this.lastSideForce = 0;
      return;
    }

    body.localToWorld(RUDDER_CENTER, _worldPoint);
    _worldArm.subVectors(_worldPoint, body.comPosition);
    body.pointVelocity(_worldArm, _pointVelocity);
    body.worldDirToLocal(_pointVelocity, _localVelocity);

    // Escoamento sobre a pá. `-z` porque a proa aponta para -Z, então avançar é
    // ter z negativo; `x` é a deriva, e como o ponto é a popa ele já traz junto
    // o ω×r da guinada.
    const axial = -_localVelocity.z;
    const lateral = _localVelocity.x;
    const speed = Math.hypot(axial, lateral);
    if (speed < 1e-3) {
      this.lastSideForce = 0;
      return;
    }

    // **O ângulo de ataque não é o ângulo do leme.** É o ângulo do leme menos o
    // ângulo com que a água chega. Duas consequências, e as duas são o navio:
    //
    // - Com o leme no meio e o navio em deriva, a pá ainda faz força — e é ela
    //   que traz a proa de volta. É daqui que sai a estabilidade de rumo; sem
    //   este termo o casco não segurava a proa e espiralava sozinho.
    // - Em curva fechada a deriva come o ângulo do leme, então o leme perde
    //   autoridade justamente quando está todo carregado. É o que impede a
    //   guinada de crescer sem fim.
    //
    // O sinal **soma**, e é fácil errar: a água chegando por boreste deixa o
    // bordo de fuga a boreste da linha do escoamento, que é a mesma coisa que
    // meter leme a boreste. Com o sinal trocado o leme empurrava a deriva em vez
    // de fechá-la, e o navio espiralava com 30° de caranguejo permanente.
    const inflow = Math.atan2(lateral, axial);
    const alpha = this.rudderAngle + inflow;

    const q = 0.5 * WATER_DENSITY * RUDDER_AREA * speed * speed * wetted;
    const normal = q * RUDDER_CN * Math.sin(alpha);

    // A força nasce perpendicular ao **escoamento**, não à quilha: `travel` é a
    // direção em que a pá caminha na água e `side` é a normal a ela, positiva
    // para boreste.
    const travelX = lateral / speed;
    const travelZ = -axial / speed;
    const sideX = axial / speed;
    const sideZ = lateral / speed;

    // Decomposição clássica da placa: a força normal `N` se abre em sustentação
    // perpendicular ao escoamento (`N·cos α`) e arrasto ao longo dele
    // (`N·sen α`). Sem o cosseno o leme de ré esterçaria para o lado errado, e
    // sem o arrasto o navio não perderia velocidade em curva fechada.
    const lift = normal * Math.cos(alpha);
    const induced = Math.abs(normal * Math.sin(alpha));

    this.lastSideForce = -lift;

    _force.set(
      -lift * sideX - induced * travelX,
      0,
      -lift * sideZ - induced * travelZ,
    );
    body.localDirToWorld(_force, _force);
    body.applyForceAtPoint(_force, _worldPoint);
  }
}
