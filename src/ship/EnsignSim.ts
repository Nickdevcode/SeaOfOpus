/**
 * A bandeira do tope: um pano de Verlet preso à cabeça do mastro.
 *
 * Ela existe por um motivo de jogo, não de enfeite — e o motivo é o mesmo que
 * fez a flâmula ser modelada em primeiro lugar. A duzentos metros a Chalupa é
 * uma silhueta escura contra o céu, e o que se distingue nela é o pano: a vela,
 * quando está de frente, e a bandeira, sempre. Só que uma bandeira **rígida**
 * mente duas vezes por partida inteira. A geometria antiga trazia um seno
 * assado nos vértices e apontava para a popa em qualquer condição: com o vento
 * pela alheta ela ficava atravessada, com calmaria continuava esticada, e a
 * onda dela era a mesma prega congelada em todos os quadros do jogo.
 *
 * O que se ganha ao simular não é "a bandeira mexe". É que ela vira um
 * **instrumento**: ela aponta a sotavento, e portanto diz de onde vem o vento
 * antes de o jogador olhar o HUD. Num jogo em que o rumo em relação ao vento
 * decide a velocidade, esse é o dado mais importante da tela — e agora ele está
 * desenhado no topo do próprio mastro, que é onde todo marinheiro real olha.
 *
 * ## Por que Verlet, e por que separado da vela
 *
 * A vela (`SailSim`) tem 143 nós presos em duas relingas e é o que empurra o
 * navio; a bandeira tem 55 nós presos numa borda só e não faz força nenhuma.
 * Compartilhar o solver custaria mais em parametrização do que os quarenta
 * milissegundos por minuto que este arquivo inteiro gasta. E o vento — que é o
 * que os dois têm de comum — vem de fora, do mesmo `localWind` que a vela lê.
 *
 * O tecido roda no referencial do navio, como a vela: a malha é filha do casco,
 * então as posições já estão nesse sistema e o balanço do mar entra de graça.
 */

import * as THREE from 'three';
import { clamp01 } from '../core/MathUtils';
import { ENSIGN_FRAME, ensignRestPoint, ensignVertexIndex } from './ShipParts';

/** Folga do pano ao longo do comprimento. Pouca: flâmula é esticada. */
const CHORD_SLACK = 1.01;
/** Folga na altura, onde o pano realmente ondula. */
const SPAN_SLACK = 1.05;
const RELAX_ITERATIONS = 3;
const CLOTH_DAMPING = 0.984;

/**
 * Aceleração do pano por unidade de **pressão dinâmica** — ou seja, multiplicada
 * pelo quadrado da velocidade do vento, como toda força de fluido.
 *
 * O quadrado importa aqui mais do que na vela: entre a calmaria (6 m/s) e o
 * temporal (20 m/s) a pressão muda dez vezes, e é isso que faz a bandeira pender
 * mole num caso e ficar rija no outro. Com uma relação linear a diferença seria
 * de três vezes, e o jogador não leria o tempo pela bandeira.
 */
const WIND_GAIN = 0.085;
/** Gravidade sentida pelo pano — só o bastante para a ponta cair na calmaria. */
const CLOTH_GRAVITY = 2.6;

/**
 * Ganho da onda viajante que percorre o pano, também sobre a pressão dinâmica.
 *
 * Verlet sozinho, com vento constante, converge para uma bandeira **reta**: sem
 * turbulência não há o que a faça ondular, e o resultado é uma tábua apontando a
 * sotavento — que foi exatamente o que a primeira versão desenhou. A onda entra
 * como uma força transversal que anda ao longo do comprimento, que é o que uma
 * bandeira faz de verdade: a instabilidade de esteira corre da haste para a
 * ponta, crescendo.
 *
 * Um pouco maior que o empurrão do vento de propósito. É a onda que dá vida ao
 * pano, e ela precisa vencer a tração que o próprio vento impõe — foi por
 * subestimar isso que a primeira tentativa produziu um deslocamento de milímetros
 * por segundo, invisível a qualquer distância.
 */
const RIPPLE_GAIN = 0.2;
/**
 * Comprimentos de onda por metro de pano.
 *
 * 0,8 dá uma onda e meia nos 1,9 m da flâmula. Estava em 1,35 — duas ondas e
 * meia —, e o pano só tem dez colunas de vértice: cada crista ficava com quatro
 * quadriláteros e a onda lia como serrilha, não como pano. A malha decide o
 * comprimento de onda mínimo que vale a pena simular.
 */
const RIPPLE_WAVES = 0.8;
/** Quantas vezes por segundo a onda percorre o pano, por m/s de vento. */
const RIPPLE_SPEED = 0.21;

interface ClothConstraint {
  a: number;
  b: number;
  rest: number;
}

const _rest = new THREE.Vector3();

export class EnsignSim {
  private readonly geometry: THREE.BufferGeometry | null;
  private readonly positions: Float32Array | null = null;
  private readonly previous: Float32Array | null = null;
  private readonly pinned: Uint8Array | null = null;
  private readonly constraints: ClothConstraint[] = [];
  private time = 0;

  /**
   * @param mesh malha da bandeira, ou `null` para um navio sem pano visível.
   */
  constructor(mesh: THREE.Mesh | null) {
    this.geometry = mesh?.geometry ?? null;
    if (!this.geometry) return;

    const attribute = this.geometry.getAttribute('position') as THREE.BufferAttribute;
    this.positions = attribute.array as Float32Array;
    this.previous = new Float32Array(this.positions);

    const { columns, rows, length, height } = ENSIGN_FRAME;
    this.pinned = new Uint8Array((columns + 1) * (rows + 1));
    // Só a borda da haste. Todo o resto voa — inclusive as duas bordas
    // horizontais, que é onde a ondulação de uma flâmula aparece.
    for (let j = 0; j <= rows; j++) this.pinned[ensignVertexIndex(0, j)] = 1;

    const dz = length / columns;
    const dy = height / rows;
    const diagonal = Math.hypot(dz, dy);

    for (let j = 0; j <= rows; j++) {
      for (let i = 0; i <= columns; i++) {
        const index = ensignVertexIndex(i, j);
        if (i < columns) {
          this.constraints.push({ a: index, b: ensignVertexIndex(i + 1, j), rest: dz * CHORD_SLACK });
        }
        if (j < rows) {
          this.constraints.push({ a: index, b: ensignVertexIndex(i, j + 1), rest: dy * SPAN_SLACK });
        }
        if (i < columns && j < rows) {
          this.constraints.push({
            a: index,
            b: ensignVertexIndex(i + 1, j + 1),
            rest: diagonal * 1.02,
          });
        }
      }
    }
  }

  /**
   * Um passo do pano.
   *
   * @param localWind vento aparente no referencial do navio — o **mesmo** vetor
   *   que a vela usa para fazer força. É o que garante que a bandeira e o pano
   *   nunca contem histórias diferentes sobre de onde o vento vem.
   */
  update(dt: number, localWind: THREE.Vector3): void {
    const positions = this.positions;
    const previous = this.previous;
    const pinned = this.pinned;
    if (!positions || !previous || !pinned || !this.geometry) return;

    this.time += dt;

    const speed = localWind.length();
    const dynamic = speed * speed;
    const pressure = WIND_GAIN * dynamic;
    const windX = speed > 1e-4 ? localWind.x / speed : 0;
    const windZ = speed > 1e-4 ? localWind.z / speed : 1;

    // A onda cresce com a pressão e some com vento fraco: em calmaria uma
    // bandeira pende, não tremula.
    const ripple = RIPPLE_GAIN * dynamic * clamp01(speed / 5);
    const phase = this.time * speed * RIPPLE_SPEED * Math.PI * 2;
    const dt2 = dt * dt;
    const { columns } = ENSIGN_FRAME;

    for (let index = 0; index < pinned.length; index++) {
      if (pinned[index]) continue;
      const o = index * 3;

      const x = positions[o]!;
      const y = positions[o + 1]!;
      const z = positions[o + 2]!;

      // A onda cresce com a distância da haste (`u²`): junto ao mastro o pano
      // está preso e não tem para onde ir; na ponta ele chicoteia.
      const u = (index % (columns + 1)) / columns;
      const swing =
        ripple * u * u * Math.sin(u * Math.PI * 2 * RIPPLE_WAVES * ENSIGN_FRAME.length - phase);

      // O empurrão do vento é ao longo do vento; a onda é **perpendicular** a
      // ele, no plano horizontal. Girar 90° em Y é trocar as componentes e um
      // sinal, sem nenhuma matriz.
      const ax = pressure * windX + swing * -windZ;
      const az = pressure * windZ + swing * windX;

      positions[o] = x + (x - previous[o]!) * CLOTH_DAMPING + ax * dt2;
      positions[o + 1] = y + (y - previous[o + 1]!) * CLOTH_DAMPING - CLOTH_GRAVITY * dt2;
      positions[o + 2] = z + (z - previous[o + 2]!) * CLOTH_DAMPING + az * dt2;

      previous[o] = x;
      previous[o + 1] = y;
      previous[o + 2] = z;
    }

    for (let iteration = 0; iteration < RELAX_ITERATIONS; iteration++) {
      for (const constraint of this.constraints) {
        const a = constraint.a * 3;
        const b = constraint.b * 3;

        const dx = positions[b]! - positions[a]!;
        const dy = positions[b + 1]! - positions[a + 1]!;
        const dz = positions[b + 2]! - positions[a + 2]!;
        const distance = Math.hypot(dx, dy, dz);
        if (distance < 1e-6 || distance <= constraint.rest) continue;

        const correction = (distance - constraint.rest) / distance / 2;
        const cx = dx * correction;
        const cy = dy * correction;
        const cz = dz * correction;

        if (!pinned[constraint.a]) {
          positions[a] += cx;
          positions[a + 1] += cy;
          positions[a + 2] += cz;
        }
        if (!pinned[constraint.b]) {
          positions[b] -= cx;
          positions[b + 1] -= cy;
          positions[b + 2] -= cz;
        }
      }
    }

    this.geometry.getAttribute('position').needsUpdate = true;
    this.geometry.computeVertexNormals();
    this.geometry.getAttribute('normal').needsUpdate = true;
  }

  /** Devolve o pano à forma de repouso — usado ao reiniciar uma partida. */
  reset(): void {
    const positions = this.positions;
    const previous = this.previous;
    if (!positions || !previous || !this.geometry) return;

    const { columns, rows } = ENSIGN_FRAME;
    for (let j = 0; j <= rows; j++) {
      for (let i = 0; i <= columns; i++) {
        const o = ensignVertexIndex(i, j) * 3;
        ensignRestPoint(i, j, _rest);
        positions[o] = _rest.x;
        positions[o + 1] = _rest.y;
        positions[o + 2] = _rest.z;
      }
    }
    previous.set(positions);
    this.geometry.getAttribute('position').needsUpdate = true;
    this.geometry.computeVertexNormals();
  }
}
