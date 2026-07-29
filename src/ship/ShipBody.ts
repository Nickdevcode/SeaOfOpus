/**
 * Corpo rígido de 6 graus de liberdade — o integrador que move o navio.
 *
 * É deliberadamente pequeno: acumula força e torque durante o passo, integra uma
 * vez e zera. Quem decide *quais* forças existem são `Buoyancy`, `Rudder`,
 * `SailSim` e `Anchor`; este módulo não sabe o que é água nem vento.
 *
 * **Massa adicionada.** Um casco que acelera de lado arrasta junto uma boa massa
 * de água, e ignorar isso deixa o navio nervoso: ele escorrega para os lados e
 * sobe na onda rápido demais. Em vez de montar o tensor completo de massa
 * adicionada (que acopla arfagem com caturro e vale o dobro do código), a massa
 * é anisotrópica no referencial do navio — o padrão em simulação de barco para
 * jogo. Como empuxo e gravidade são divididos pelo mesmo número, o equilíbrio
 * não muda; só muda a rapidez com que o navio responde em cada eixo.
 *
 * **Termo giroscópico.** ω × (Iω) foi omitido de propósito. Num navio ω é da
 * ordem de 0,3 rad/s e o termo fica três ordens de grandeza abaixo dos torques
 * hidrodinâmicos, mas ele é o primeiro a explodir com integração explícita.
 */

import * as THREE from 'three';

export interface ShipBodyOptions {
  /** Massa em repouso, em kg. Sai do deslocamento do casco. */
  mass: number;
  /**
   * Centro de massa, em coordenadas locais. Fica abaixo da linha d'água: é o
   * lastro que garante que o navio se endireite em vez de emborcar.
   */
  centerOfMass: THREE.Vector3;
  /**
   * Raios de giração em metros, em torno de X (caturro), Y (guinada) e
   * Z (balanço). Já embutem a inércia adicionada da água.
   */
  gyration: THREE.Vector3;
  /**
   * Multiplicadores de massa adicionada por eixo local: X deriva, Y arfagem,
   * Z avanço. Avanço é ~1,05 porque o casco é afilado nessa direção; deriva e
   * arfagem empurram água de lado e quase dobram a massa efetiva.
   */
  addedMass: THREE.Vector3;
}

const _localForce = new THREE.Vector3();
const _accel = new THREE.Vector3();
const _arm = new THREE.Vector3();
const _torqueScratch = new THREE.Vector3();
const _spin = new THREE.Quaternion();
const _invRotation = new THREE.Quaternion();
const _localTorque = new THREE.Vector3();

export class ShipBody {
  readonly mass: number;
  /** Centro de massa em coordenadas locais (constante). */
  readonly centerOfMass: THREE.Vector3;
  /** Momentos de inércia principais, em kg·m², nos eixos locais X/Y/Z. */
  readonly inertia = new THREE.Vector3();
  readonly addedMass: THREE.Vector3;

  /**
   * Massa extra embarcada, em kg — hoje só a água do porão (`ShipDamage`).
   *
   * Existe separada de `mass` porque o peso dela já entra como *força* aplicada
   * no centróide da água, que é o que produz a adernagem. O que falta é a
   * inércia: sem somar aqui, um navio meio alagado ficaria mais leve de manobrar
   * do que um seco, que é exatamente o contrário do que deve acontecer.
   */
  floodedMass = 0;

  /** Posição **do centro de massa** no mundo. É o que o integrador move. */
  readonly comPosition = new THREE.Vector3();
  readonly orientation = new THREE.Quaternion();
  /** Velocidade do centro de massa, no mundo. */
  readonly velocity = new THREE.Vector3();
  /** Velocidade angular no mundo, em rad/s. */
  readonly angularVelocity = new THREE.Vector3();

  /** Pose do passo anterior, para interpolar o visual entre passos fixos. */
  readonly previousCom = new THREE.Vector3();
  readonly previousOrientation = new THREE.Quaternion();

  private readonly force = new THREE.Vector3();
  private readonly torque = new THREE.Vector3();

  constructor(options: ShipBodyOptions) {
    this.mass = options.mass;
    this.centerOfMass = options.centerOfMass.clone();
    this.addedMass = options.addedMass.clone();

    const { x, y, z } = options.gyration;
    this.inertia.set(this.mass * x * x, this.mass * y * y, this.mass * z * z);
  }

  /** Posição da **origem local** do navio (linha d'água de projeto, meia-nau). */
  getOrigin(target: THREE.Vector3): THREE.Vector3 {
    return target.copy(this.centerOfMass).applyQuaternion(this.orientation).negate().add(this.comPosition);
  }

  /** Coloca a origem local do navio num ponto do mundo. */
  setOrigin(x: number, y: number, z: number): void {
    _arm.copy(this.centerOfMass).applyQuaternion(this.orientation);
    this.comPosition.set(x + _arm.x, y + _arm.y, z + _arm.z);
    this.previousCom.copy(this.comPosition);
  }

  /** Converte um ponto local em ponto do mundo. */
  localToWorld(local: THREE.Vector3, target: THREE.Vector3): THREE.Vector3 {
    return target.copy(local).sub(this.centerOfMass).applyQuaternion(this.orientation).add(this.comPosition);
  }

  /** Converte um ponto do mundo em ponto local. Inverso de `localToWorld`. */
  worldToLocal(world: THREE.Vector3, target: THREE.Vector3): THREE.Vector3 {
    _invRotation.copy(this.orientation).invert();
    return target.copy(world).sub(this.comPosition).applyQuaternion(_invRotation).add(this.centerOfMass);
  }

  /** Rotaciona uma direção local para o mundo (sem transladar). */
  localDirToWorld(local: THREE.Vector3, target: THREE.Vector3): THREE.Vector3 {
    return target.copy(local).applyQuaternion(this.orientation);
  }

  /** Rotaciona uma direção do mundo para o referencial do navio. */
  worldDirToLocal(world: THREE.Vector3, target: THREE.Vector3): THREE.Vector3 {
    _invRotation.copy(this.orientation).invert();
    return target.copy(world).applyQuaternion(_invRotation);
  }

  /**
   * Velocidade de um ponto do corpo, dado o **braço até o centro de massa** já
   * no referencial do mundo: v + ω × r.
   */
  pointVelocity(worldArm: THREE.Vector3, target: THREE.Vector3): THREE.Vector3 {
    return target.crossVectors(this.angularVelocity, worldArm).add(this.velocity);
  }

  /** Força no mundo aplicada no centro de massa — não gera torque. */
  applyForce(force: THREE.Vector3): void {
    this.force.add(force);
  }

  /** Força no mundo aplicada num ponto do mundo. Gera torque em torno do CM. */
  applyForceAtPoint(force: THREE.Vector3, worldPoint: THREE.Vector3): void {
    this.force.add(force);
    _arm.subVectors(worldPoint, this.comPosition);
    this.torque.add(_torqueScratch.crossVectors(_arm, force));
  }

  applyTorque(torque: THREE.Vector3): void {
    this.torque.add(torque);
  }

  integrate(dt: number): void {
    this.previousCom.copy(this.comPosition);
    this.previousOrientation.copy(this.orientation);

    // Linear: divide no referencial do navio para a massa adicionada valer por
    // eixo, e só então volta para o mundo.
    const mass = this.mass + this.floodedMass;
    this.worldDirToLocal(this.force, _localForce);
    _accel.set(
      _localForce.x / (mass * this.addedMass.x),
      _localForce.y / (mass * this.addedMass.y),
      _localForce.z / (mass * this.addedMass.z),
    );
    this.localDirToWorld(_accel, _accel);
    this.velocity.addScaledVector(_accel, dt);
    this.comPosition.addScaledVector(this.velocity, dt);

    // Angular: mesmo caminho, agora com o tensor de inércia (diagonal no local).
    // A inércia acompanha a massa embarcada pela mesma razão — água no porão
    // também custa para girar.
    const inertiaScale = mass / this.mass;
    this.worldDirToLocal(this.torque, _localTorque);
    _localTorque.set(
      _localTorque.x / (this.inertia.x * inertiaScale),
      _localTorque.y / (this.inertia.y * inertiaScale),
      _localTorque.z / (this.inertia.z * inertiaScale),
    );
    this.localDirToWorld(_localTorque, _localTorque);
    this.angularVelocity.addScaledVector(_localTorque, dt);

    // q̇ = ½ ω q. Normalizar todo passo é o que impede o erro de integração de
    // virar escala espúria na matriz do navio.
    _spin.set(this.angularVelocity.x, this.angularVelocity.y, this.angularVelocity.z, 0);
    _spin.multiply(this.orientation);
    this.orientation.x += _spin.x * 0.5 * dt;
    this.orientation.y += _spin.y * 0.5 * dt;
    this.orientation.z += _spin.z * 0.5 * dt;
    this.orientation.w += _spin.w * 0.5 * dt;
    this.orientation.normalize();

    this.force.set(0, 0, 0);
    this.torque.set(0, 0, 0);
  }

  /**
   * Descarta o que se acumulou sem integrar.
   *
   * Existe para o lado que **não** simula. Lá a pose chega pronta pela rede e
   * `integrate` nunca roda — mas alguns subsistemas continuam rodando pelo que
   * eles *desenham* (a vela, que precisa medir o vento para se inflar), e eles
   * empurram força ao passar. Sem esta chamada, esse acumulador cresceria por
   * toda a partida sem nunca ser lido: inofensivo hoje, e exatamente o tipo de
   * número que estoura em `Infinity` no dia em que alguém resolver lê-lo.
   */
  clearForces(): void {
    this.force.set(0, 0, 0);
    this.torque.set(0, 0, 0);
  }

  /** Pose interpolada entre o passo anterior e o atual, para o render. */
  sampleOrigin(alpha: number, target: THREE.Vector3, targetRotation: THREE.Quaternion): void {
    targetRotation.copy(this.previousOrientation).slerp(this.orientation, alpha);
    _arm.copy(this.centerOfMass).applyQuaternion(targetRotation);
    target.copy(this.previousCom).lerp(this.comPosition, alpha).sub(_arm);
  }
}
