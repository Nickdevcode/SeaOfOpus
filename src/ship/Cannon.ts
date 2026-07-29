/**
 * Canhão de bordo: pontaria, carregamento, disparo e recuo.
 *
 * A peça sabe apontar e cuspir uma bala, e nada além disso. Quem decide *quando*
 * é o jogador (`PlayerController`) ou o artilheiro bot, e quem transforma o
 * disparo em projétil é o módulo de combate — este arquivo só entrega a solução
 * de tiro pronta: de onde a bala sai, para onde vai e com que velocidade.
 *
 * Três decisões que valem explicação:
 *
 * - **A bala herda a velocidade do navio.** Ela nasce com a velocidade do ponto
 *   do casco onde a boca está (translação mais ω × r), como acontece de verdade.
 *   É isso que faz atirar de bordo com o navio a 8 nós exigir uma correção real,
 *   em vez de o navio ser um chão firme disfarçado.
 * - **O disparo acontece no passo fixo, não no frame.** `triggerPull()` só levanta
 *   a bandeira; `fixedUpdate` é quem dispara. Recuo é impulso, e impulso aplicado
 *   num `dt` de render varia com o FPS — o mesmo tiro empurraria o navio mais a
 *   30 fps do que a 144.
 * - **Recuo aplicado no eixo da alma.** Não no centro de massa: a boca fica 2,5 m
 *   acima da linha d'água e 2 m fora do eixo, então o tiro aderna e guina o navio
 *   um tanto. É pouco (uns 10 mm/s), mas é de graça e é o sinal certo.
 * - **O recuo faz parte do relógio da peça, e não só do desenho.** A carreta corre
 *   38 cm para dentro e volta pelos brandais; enquanto ela está correndo, ninguém
 *   soca bala nenhuma. Ver `beginLoad`.
 */

import * as THREE from 'three';
import { clamp, wrapAngle } from '../core/MathUtils';
import type { ShipBody } from './ShipBody';
import {
  BARREL_AXIS_Y,
  BARREL_LENGTH,
  BORE_RADIUS,
  BREECH_OFFSET,
  type CannonAssembly,
} from './ShipParts';

/**
 * Raio da bala, em metros.
 *
 * Menor que a alma de propósito: a folga entre bala e cano ("vento", no jargão de
 * artilharia) era de uns 4% e é o que permitia carregar sem torno. Sai daqui a
 * massa, e da massa saem o recuo e o arrasto da balística.
 */
export const BALL_RADIUS = BORE_RADIUS * 0.96;
/** Densidade do ferro fundido, em kg/m³. */
const IRON_DENSITY = 7200;
/** Massa da bala, em kg. Calculada, não escolhida: ~3,7 kg, um "meia-libra". */
export const BALL_MASS = (4 / 3) * Math.PI * BALL_RADIUS ** 3 * IRON_DENSITY;

/**
 * Velocidade de boca, em m/s.
 *
 * Um canhão de verdade cospe a 300–400 m/s, e com isso o tiro seria reta pura
 * dentro do alcance de combate — não sobraria nada da liderança de alvo que é o
 * miolo do duelo naval no Sea of Thieves. A 95 m/s um tiro de 100 m leva pouco
 * mais de 1 s e cai uns 5 m no caminho: obriga a elevar e a prever o alvo, que é
 * exatamente o comportamento do jogo.
 */
export const MUZZLE_SPEED = 95;

/**
 * Batente de travessia da carreta, em radianos (±26°).
 *
 * Exportado porque é ele que define o problema tático da IA: com o cano preso a
 * 26° do través, manter o alvo sob fogo é obrigação do **timoneiro**, não do
 * artilheiro. Um bot que pudesse girar a peça 180° dispensaria manobra, e a
 * manobra é o jogo.
 */
export const TRAVERSE_LIMIT = 0.45;
/** Elevação mínima: a boca desce um pouco abaixo da horizontal. */
export const ELEVATION_MIN = -0.09;
/** Elevação máxima (~33°), onde a culatra encosta no convés. */
export const ELEVATION_MAX = 0.58;

/** Tempo de socar a bala, em segundos. Só corre com a carreta assentada. */
const LOAD_TIME = 1.5;

/** Quanto a carreta corre para dentro no tiro, em metros. */
const RECOIL_TRAVEL = 0.38;
/**
 * Velocidade com que a carreta volta ao batente, em m/s.
 *
 * Com os 38 cm de curso, dá **0,69 s** entre o tiro e a peça estar em condições de
 * receber a carga seguinte — e esse número deixou de ser decorativo. Ver `beginLoad`.
 */
const RECOIL_RETURN = 0.55;

export type CannonState = 'empty' | 'loading' | 'loaded';

/** Tudo que o módulo de combate precisa para criar o projétil. */
export interface FireSolution {
  /** Posição da boca no mundo, no instante do disparo. */
  readonly position: THREE.Vector3;
  /** Velocidade inicial no mundo, já com a do navio somada. */
  readonly velocity: THREE.Vector3;
  readonly mass: number;
  readonly radius: number;
  /** Quem atirou — o dano precisa saber para não contar fogo amigo. */
  readonly owner: string;
}

/** Par de ângulos da peça, com o veredito de se ela alcança aquela direção. */
export interface AimAngles {
  traverse: number;
  elevation: number;
  /** `true` quando os dois ângulos caem dentro dos batentes da carreta. */
  bears: boolean;
}

const _quat = new THREE.Quaternion();
const _barrel = new THREE.Quaternion();
const _euler = new THREE.Euler(0, 0, 0, 'YXZ');
const _arm = new THREE.Vector3();
const _carry = new THREE.Vector3();
const _force = new THREE.Vector3();
const _pivot = new THREE.Vector3();
const UP = new THREE.Vector3(0, 1, 0);

export class Cannon {
  /** +1 boreste, -1 bombordo. */
  readonly side: 1 | -1;

  /** Travessia dentro do batente da carreta, em radianos. */
  traverse = 0;
  /** Elevação do cano, em radianos. Positivo é boca para cima. */
  elevation = 0.1;

  state: CannonState = 'empty';
  /** 0..1 enquanto carrega. O HUD desenha a barra a partir disto. */
  loadProgress = 0;

  /** Deslocamento atual da carreta pelo recuo, em metros. */
  recoil = 0;

  /**
   * Os três ângulos no passo anterior, para o desenho interpolar entre passos.
   *
   * A peça é mirada e recua no passo fixo, mas é desenhada na taxa do monitor.
   * Sem esta memória, o cano andava em degraus de 60 Hz numa tela de 144 — o
   * recuo era o mais visível, porque é o movimento mais rápido do navio inteiro.
   * Mesma técnica, e mesma razão, de `ShipBody.previousCom`.
   */
  previousTraverse = 0;
  previousElevation = 0.1;
  previousRecoil = 0;

  /** Gatilho pedido neste frame, consumido pelo próximo passo fixo. */
  private triggered = false;

  /**
   * Orientação fixa do bordo, lida do modelo: ∓90°, o cano atravessado.
   *
   * Público porque `solveAim` mede a travessia a partir dele, e a IA precisa
   * conseguir perguntar para que lado a peça olha sem duplicar essa constante.
   */
  readonly sideYaw: number;

  constructor(
    readonly assembly: CannonAssembly,
    /** Nome do navio dono, carregado para a solução de tiro. */
    readonly owner: string,
  ) {
    this.sideYaw = assembly.root.rotation.y;
    this.side = assembly.root.position.x >= 0 ? 1 : -1;
  }

  get isLoaded(): boolean {
    return this.state === 'loaded';
  }

  /** Aponta. Os deltas vêm em radianos, do mouse ou do analógico. */
  aim(deltaTraverse: number, deltaElevation: number): void {
    this.traverse = clamp(this.traverse + deltaTraverse, -TRAVERSE_LIMIT, TRAVERSE_LIMIT);
    this.elevation = clamp(this.elevation + deltaElevation, ELEVATION_MIN, ELEVATION_MAX);
  }

  /**
   * Começa a servir a peça. Devolve `false` se já havia carga ou já está carregando.
   *
   * **O comando é aceito de imediato, mas o trabalho só começa com a carreta
   * assentada.** Depois do tiro a peça está 38 cm para dentro, correndo de volta
   * pelos brandais, e não se enfia soquete em meia tonelada de ferro em
   * movimento — quem serve a peça espera ela parar no batente. São 0,69 s que o
   * modelo já calculava e ninguém cobrava: até aqui o recuo era um enfeite que
   * corria em paralelo com o carregamento, e o ciclo de tiro custava exatamente
   * `LOAD_TIME` e mais nada.
   *
   * O comando entra em fila em vez de ser recusado, e essa parte importa para
   * quem joga: apertar recarregar no estrondo do próprio tiro é o gesto natural,
   * e devolver `false` ali obrigaria o jogador a apertar duas vezes sem nenhuma
   * razão que ele pudesse ver na tela. A bala sai do paiol no instante do
   * comando (`Ship.loadCannon`) — ela já está na mão do servente.
   *
   * Vale para os dois lados do duelo, e é ponto pacífico: `Cannon` não sabe quem
   * a opera. Uma exceção para o navio do jogador aqui dentro seria exatamente o
   * tipo de trapaça que o resto do projeto se dá ao trabalho de evitar.
   */
  beginLoad(): boolean {
    if (this.state !== 'empty') return false;
    this.state = 'loading';
    this.loadProgress = 0;
    return true;
  }

  /** Pede fogo. O tiro sai no próximo passo fixo, se houver carga. */
  triggerPull(): void {
    this.triggered = true;
  }

  /**
   * @returns a solução de tiro quando o canhão dispara neste passo.
   */
  /**
   * Guarda a pose deste instante como a "anterior" do passo que vai começar.
   *
   * Precisa rodar **antes** de quem quer que mire, e é por isso que não mora em
   * `fixedUpdate`: o marujo (ou o artilheiro da máquina) chama `aim` antes de o
   * navio integrar, então quando `fixedUpdate` chegasse a pose já teria mudado e
   * a "anterior" sairia igual à atual — interpolação de nada com nada, e o cano
   * de volta aos degraus de 60 Hz que ela existe para tirar.
   */
  beginStep(): void {
    this.previousTraverse = this.traverse;
    this.previousElevation = this.elevation;
    this.previousRecoil = this.recoil;
  }

  fixedUpdate(dt: number, body: ShipBody): FireSolution | null {
    // A carreta volta ao batente pelos brandais, não instantaneamente — e ela vem
    // **antes** do carregamento porque é ela que o libera. Ver `beginLoad`.
    if (this.recoil > 0) this.recoil = Math.max(this.recoil - RECOIL_RETURN * dt, 0);

    if (this.state === 'loading' && this.recoil <= 0) {
      this.loadProgress += dt / LOAD_TIME;
      if (this.loadProgress >= 1) {
        this.loadProgress = 1;
        this.state = 'loaded';
      }
    }

    if (!this.triggered) return null;
    this.triggered = false;
    if (this.state !== 'loaded') return null;

    return this.discharge(dt, body);
  }

  /**
   * Orientação do cano em coordenadas locais do navio.
   *
   * @param alpha fração do passo já decorrida, para a pose de desenho. Omitido,
   *   devolve a pose **da simulação** — que é o que a balística e o artilheiro
   *   têm de ver: mirar contra uma pose interpolada resolveria o tiro meio passo
   *   atrás de onde a peça de fato está.
   */
  getBarrelQuaternion(target: THREE.Quaternion, alpha?: number): THREE.Quaternion {
    const elevation =
      alpha === undefined
        ? this.elevation
        : this.previousElevation + (this.elevation - this.previousElevation) * alpha;
    const traverse =
      alpha === undefined
        ? this.traverse
        : this.previousTraverse + (this.traverse - this.previousTraverse) * alpha;
    _euler.set(elevation, this.sideYaw + traverse, 0);
    return target.setFromEuler(_euler);
  }

  /** Direção para onde a boca aponta, em coordenadas locais do navio. */
  getAimLocal(target: THREE.Vector3): THREE.Vector3 {
    this.getBarrelQuaternion(_barrel);
    return target.set(0, 0, -1).applyQuaternion(_barrel);
  }

  /**
   * **O inverso de `getAimLocal`:** que travessia e elevação apontam a alma
   * nesta direção. É a ponte entre a balística, que resolve no mundo, e a
   * carreta, que só entende dois ângulos presos ao casco.
   *
   * A conta sai de desmontar a mesma composição que `getBarrelQuaternion` monta.
   * Com a ordem 'YXZ' e sem rolamento, a direção da boca é
   *
   * ```
   * d = ( −cos e · sen a ,  sen e ,  −cos e · cos a )      a = sideYaw + traverse
   * ```
   *
   * de onde `e = asen(d.y)` e `a = atan2(−d.x, −d.z)`. Não há ambiguidade a
   * resolver porque a elevação vive em (−90°, 90°): o arco alto de morteiro
   * simplesmente não existe nesta peça.
   *
   * **Por que a direção entra em coordenadas do navio.** O casco está jogando
   * na onda. Convertendo a solução de mundo para local *no instante do tiro*, a
   * atitude do navio entra de graça na conta — e é isso que faz o artilheiro
   * bot esperar o balanço trazer o cano para cima do alvo em vez de atirar no
   * meio do mar. A pontaria não corrige o balanço: ela espera por ele.
   *
   * @param localDirection direção desejada, em coordenadas do navio. Não precisa
   *   estar normalizada.
   */
  solveAim(localDirection: THREE.Vector3, out: AimAngles): AimAngles {
    const length = localDirection.length();
    if (length < 1e-9) {
      out.traverse = this.traverse;
      out.elevation = this.elevation;
      out.bears = false;
      return out;
    }

    out.elevation = Math.asin(clamp(localDirection.y / length, -1, 1));
    // `wrapAngle` porque `sideYaw` é ±π/2 e o azimute vem em (−π, π]: sem
    // normalizar, a peça de bombordo enxergaria travessias na casa dos 270°.
    out.traverse = wrapAngle(Math.atan2(-localDirection.x, -localDirection.z) - this.sideYaw);
    out.bears =
      Math.abs(out.traverse) <= TRAVERSE_LIMIT &&
      out.elevation >= ELEVATION_MIN &&
      out.elevation <= ELEVATION_MAX;

    return out;
  }

  /**
   * Centro dos munhões — o ponto em torno do qual o cano eleva, e onde o recuo
   * empurra. Em coordenadas locais do navio.
   */
  getPivotLocal(target: THREE.Vector3): THREE.Vector3 {
    const root = this.assembly.root;
    // A carreta corre para trás ao longo da própria linha de tiro. O `sideYaw`
    // fica de fora porque o resultado já é rodado por ele logo abaixo.
    const back = this.recoil;
    _quat.setFromAxisAngle(UP, this.sideYaw);
    target
      .set(Math.sin(this.traverse) * back, BARREL_AXIS_Y, Math.cos(this.traverse) * back)
      .applyQuaternion(_quat)
      .add(root.position);
    return target;
  }

  /** Posição da boca, em coordenadas locais do navio. */
  getMuzzleLocal(target: THREE.Vector3): THREE.Vector3 {
    this.getBarrelQuaternion(_barrel);
    this.getPivotLocal(_pivot);
    return target
      .set(0, 0, BREECH_OFFSET - BARREL_LENGTH)
      .applyQuaternion(_barrel)
      .add(_pivot);
  }

  /** Escreve travessia, elevação e recuo no modelo 3D, na pose do quadro. */
  syncModel(alpha = 1): void {
    const t = this.previousTraverse + (this.traverse - this.previousTraverse) * alpha;
    const e = this.previousElevation + (this.elevation - this.previousElevation) * alpha;
    const r = this.previousRecoil + (this.recoil - this.previousRecoil) * alpha;

    const { traverse, elevation } = this.assembly;
    traverse.rotation.y = t;
    traverse.position.set(Math.sin(t) * r, 0, Math.cos(t) * r);
    elevation.rotation.x = e;
  }

  reset(): void {
    this.state = 'empty';
    this.loadProgress = 0;
    this.recoil = 0;
    this.traverse = 0;
    this.elevation = 0.1;
    this.triggered = false;
    // A pose anterior vai junto: sem isto, o primeiro quadro de uma partida nova
    // interpola a partir de onde a peça estava quando a anterior acabou.
    this.previousTraverse = 0;
    this.previousElevation = 0.1;
    this.previousRecoil = 0;
  }

  private discharge(dt: number, body: ShipBody): FireSolution {
    const position = new THREE.Vector3();
    const direction = new THREE.Vector3();

    this.getMuzzleLocal(position);
    this.getAimLocal(direction);
    body.localToWorld(position, position);
    body.localDirToWorld(direction, direction);

    // Velocidade do próprio ponto da boca: translação do casco mais a rotação.
    _arm.subVectors(position, body.comPosition);
    body.pointVelocity(_arm, _carry);
    const velocity = direction.clone().multiplyScalar(MUZZLE_SPEED).add(_carry);

    // Impulso convertido em força porque o integrador trabalha com forças; num
    // passo fixo os dois são a mesma coisa.
    this.getPivotLocal(_pivot);
    body.localToWorld(_pivot, _pivot);
    _force.copy(direction).multiplyScalar((-BALL_MASS * MUZZLE_SPEED) / dt);
    body.applyForceAtPoint(_force, _pivot);

    this.recoil = RECOIL_TRAVEL;
    this.state = 'empty';
    this.loadProgress = 0;

    return { position, velocity, mass: BALL_MASS, radius: BALL_RADIUS, owner: this.owner };
  }
}
