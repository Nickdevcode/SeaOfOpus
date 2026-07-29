/**
 * Resistência do casco na água.
 *
 * Três termos, cada um com um papel:
 *
 * - **Avanço** (eixo Z local): uma força só, no centro de carena. É o que define
 *   a velocidade máxima do navio, já que em regime o empuxo da vela iguala este
 *   arrasto.
 * - **Deriva** (eixo X local): distribuída em várias estações ao longo da quilha,
 *   e é aqui que está o truque. Um casco que guina tem, em cada estação, uma
 *   velocidade lateral diferente (ω × r), então a soma dos arrastos laterais
 *   gera **amortecimento de guinada** sozinha. Sem isso seria preciso inventar um
 *   coeficiente de rotação, e o raio de giro deixaria de responder à velocidade.
 * - **Atrito de superfície**: linear, pequeno, e existe para o navio parar em vez
 *   de ficar deslizando eternamente quando o arrasto quadrático já é desprezível.
 *
 * Tudo escala pela fração submersa: navio meio afundado arrasta mais, navio
 * saltando fora da vaga arrasta menos.
 */

import * as THREE from 'three';
import { WATER_DENSITY } from '../core/MathUtils';
import { HULL_LENGTH, sampleSection, tToZ, type HullSection } from './ShipDimensions';
import type { ShipBody } from './ShipBody';

/**
 * Coeficiente de arrasto de avanço, sobre a área da seção mestra (3,7 m²).
 *
 * Alto para um casco (um casco fino fica perto de 0,1), e de propósito: ele
 * carrega junto a resistência de formação de ondas, que num deslocamento de 16 m
 * dispara perto da velocidade de casco. É **este** termo que tem de fixar a
 * velocidade máxima, e a 0,38 ele fixa em ~5 m/s (9,7 nós) com a vela cheia —
 * conferido na bancada de física, não estimado.
 */
const SURGE_CD = 0.38;
/** Área da seção mestra submersa, em m². Medida do próprio casco. */
const MIDSHIP_AREA = 3.7;

/** Arrasto lateral, sobre o plano de deriva. Casco de lado é uma placa. */
const SWAY_CD = 1.15;

/** Estações onde o arrasto lateral é aplicado. Ímpar para uma cair na meia-nau. */
const LATERAL_STATIONS = 9;

/**
 * Atrito viscoso linear, em 1/s sobre a massa.
 *
 * ⚠️ Este número engana. Por ser **linear**, ele não é um termo pequeno que só
 * aparece no fim: ele é `0,012 × 36 905 = 443 N·s/m`, e concorre com o quadrático
 * em toda a faixa. A primeira calibragem usou 0,22 e o resultado foi 20 kN de
 * arrasto a 2,5 m/s — 82% de toda a resistência do navio, o que travava a Chalupa
 * em 4,8 nós e fazia o `SURGE_CD` acima virar decoração.
 *
 * O papel dele é só um: dar uma constante de tempo finita (~83 s) para o navio
 * chegar a zero em vez de deslizar para sempre quando o quadrático já não segura
 * nada. Qualquer valor que o faça pesar em velocidade de cruzeiro está errado.
 */
const SKIN_FRICTION = 0.012;

/**
 * Amortecimento angular residual, em 1/s.
 *
 * Existe para o **balanço** (X e Z), que a carena mal amortece por ser quase
 * circular no bojo. O termo de guinada (Y) é pequeno de propósito: as estações
 * laterais acima já amortecem guinada de verdade, e o valor antigo (0,35) somava
 * outros 15 kN·m a essa conta — metade de toda a resistência à curva vinha de um
 * número inventado, não da água.
 */
const ROLL_DAMPING = new THREE.Vector3(0.9, 0.08, 1.4);

/**
 * Fração do momento de Munk teórico que se aplica ao casco.
 *
 * **O que é.** Um corpo alongado num fluido carrega mais massa adicionada de
 * lado do que de proa (aqui, 1,9 contra 1,06). Quando ele avança em deriva, a
 * quantidade de movimento do fluido deixa de ser paralela à velocidade, e a
 * diferença vira um binário que **abre ainda mais a deriva**. É o termo
 * `(m₂₂ − m₁₁)·u·v` das equações de Kirchhoff, e está em todo modelo de manobra
 * sério (MMG, Abkowitz) exatamente porque sem ele o navio vira um trilho.
 *
 * Era isso que faltava aqui, e o quanto se vê medindo com ele desligado: a volta
 * de 360° cai de **98 s e 113 m de diâmetro** para **63 s e 70 m**. Sem o Munk o
 * leme abre a curva, o casco resiste e nada empurra a guinada a favor.
 *
 * **Por que 0,25 e não o valor teórico.** O 1,0 vem de escoamento potencial, sem
 * separação; num casco real a esteira descolada come boa parte dele. O teto útil
 * aqui é mais duro que a literatura, e sai da bancada: com o navio a 5 m/s e a
 * deriva imposta, mede-se de um lado o Munk mais as estações laterais (os dois
 * abrem a deriva) e do outro o leme no meio (que a fecha, ver `Rudder`).
 *
 * ```
 * deriva    leme      estações   Munk (a 0,25)   fator máximo
 *    5°   −22 689      +2 206        +16 822          0,30
 *   10°   −45 206      +8 755        +33 134          0,27
 *   20°   −89 038     +33 965        +62 271          0,22
 * ```
 *
 * O limite **cai** com o ângulo porque o casco cresce mais rápido que o leme, e
 * isso não é defeito: é a perda de estabilidade direcional em deriva grande, que
 * é justamente o que faz um navio "cavar" a curva em vez de sair de lado. A 0,25
 * o navio segura rumo até uns 13° de deriva e entrega curva de 360° em 63 s com
 * 70 m de diâmetro; navegando livre a deriva fica em 0,3°, folga de sobra.
 *
 * ⚠️ Estes números valem para o leme com o sinal certo. A primeira versão desta
 * tabela foi levantada com `alpha = rudderAngle − inflow`, e nela o leme
 * *somava* à instabilidade em vez de restaurar — o navio andava com 25 a 30° de
 * caranguejo permanente e a volta levava 143 s. Se algum dia mexerem em `Rudder`,
 * remedir isto antes de mexer aqui.
 */
const MUNK_FACTOR = 0.25;

const _localVelocity = new THREE.Vector3();
const _worldPoint = new THREE.Vector3();
const _worldArm = new THREE.Vector3();
const _pointVelocity = new THREE.Vector3();
const _localPointVelocity = new THREE.Vector3();
const _force = new THREE.Vector3();
const _local = new THREE.Vector3();
const _torque = new THREE.Vector3();

export class HullDrag {
  /** Z local de cada estação de arrasto lateral. */
  private readonly stationZ: number[] = [];
  /** Área lateral submersa atribuída a cada estação, em m². */
  private readonly stationArea: number[] = [];
  /** Profundidade média de aplicação: metade do calado local. */
  private readonly stationY: number[] = [];

  constructor() {
    const section: HullSection = { halfBeam: 0, keelY: 0, sheerY: 0, fullness: 1 };
    const dz = HULL_LENGTH / LATERAL_STATIONS;

    for (let i = 0; i < LATERAL_STATIONS; i++) {
      const t = (i + 0.5) / LATERAL_STATIONS;
      sampleSection(t, section);
      const draft = Math.max(-section.keelY, 0);
      this.stationZ.push(tToZ(t));
      this.stationArea.push(draft * dz);
      // Metade do calado é o centro de pressão de uma placa retangular; usar a
      // linha d'água em vez disso daria braço zero e o navio não adernaria ao
      // derrapar numa curva.
      this.stationY.push(-draft * 0.5);
    }
  }

  /**
   * @param submersion fração do volume de projeto submersa (de `Buoyancy`).
   */
  apply(body: ShipBody, submersion: number): void {
    const wetted = Math.min(submersion, 1.4);
    if (wetted <= 0.01) return;

    // --- avanço, no centro de carena -----------------------------------------
    body.worldDirToLocal(body.velocity, _localVelocity);
    const surge = _localVelocity.z;
    const surgeDrag = -0.5 * WATER_DENSITY * SURGE_CD * MIDSHIP_AREA * wetted * Math.abs(surge) * surge;

    _force.set(0, 0, surgeDrag);
    body.localDirToWorld(_force, _force);
    body.applyForce(_force);

    // --- atrito linear --------------------------------------------------------
    _force.copy(body.velocity).multiplyScalar(-SKIN_FRICTION * body.mass * wetted);
    body.applyForce(_force);

    // --- deriva, estação por estação -----------------------------------------
    for (let i = 0; i < this.stationZ.length; i++) {
      _local.set(0, this.stationY[i]!, this.stationZ[i]!);
      body.localToWorld(_local, _worldPoint);
      _worldArm.subVectors(_worldPoint, body.comPosition);
      body.pointVelocity(_worldArm, _pointVelocity);
      body.worldDirToLocal(_pointVelocity, _localPointVelocity);

      const lateral = _localPointVelocity.x;
      const drag = -0.5 * WATER_DENSITY * SWAY_CD * this.stationArea[i]! * wetted * Math.abs(lateral) * lateral;

      _force.set(drag, 0, 0);
      body.localDirToWorld(_force, _force);
      body.applyForceAtPoint(_force, _worldPoint);
    }

    // --- momento de Munk ------------------------------------------------------
    // Sinais: `u` é avanço (a proa é -Z, então avançar é ter z negativo) e `v` é
    // deriva para boreste. Guinar para bombordo é +Y aqui, e o binário de Munk
    // empurra a proa **para fora** da deriva — daí o sinal negativo.
    const munk =
      -MUNK_FACTOR *
      body.mass *
      (body.addedMass.x - body.addedMass.z) *
      _localVelocity.z *
      _localVelocity.x *
      wetted;

    _torque.set(0, munk, 0);
    body.localDirToWorld(_torque, _torque);
    body.applyTorque(_torque);

    // --- amortecimento angular residual --------------------------------------
    body.worldDirToLocal(body.angularVelocity, _torque);
    _torque.set(
      -_torque.x * ROLL_DAMPING.x * body.inertia.x * wetted,
      -_torque.y * ROLL_DAMPING.y * body.inertia.y * wetted,
      -_torque.z * ROLL_DAMPING.z * body.inertia.z * wetted,
    );
    body.localDirToWorld(_torque, _torque);
    body.applyTorque(_torque);
  }
}
