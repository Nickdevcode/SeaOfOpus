/**
 * A vela: o pano que se mexe e a força que empurra o navio.
 *
 * São dois problemas separados, resolvidos separadamente de propósito.
 *
 * **O pano** é um tecido de Verlet numa grade 13 × 11, rodando no referencial do
 * navio (o mesh é filho do casco, então as posições já estão nesse sistema). Não
 * sentir a aceleração do navio é o certo aqui: uma vela içada e cheia não bate
 * porque o casco subiu numa vaga, ela bate porque o vento mudou.
 *
 * **A força** é analítica, e não a soma da pressão sobre os quads do tecido.
 * Somar do tecido soa mais puro, mas na prática o empuxo passaria a oscilar na
 * frequência do solver e a velocidade máxima do navio dependeria da resolução da
 * malha — o jogador sentiria o navio "tremendo" sem nenhuma causa visível. Aqui o
 * pano é a leitura visual do vento e a força é o modelo; os dois leem exatamente
 * o mesmo vetor de vento, então nunca discordam do que está acontecendo.
 *
 * ## Como a curva de velocidade foi calibrada
 *
 * A Chalupa é a **mais lenta** de popa e de través, e a **menos lenta** de proa
 * ao vento — é por isso que fugir contra o vento é o manual da chalupa perseguida
 * ([fóruns e guias do Sea of Thieves](https://www.sportskeeda.com/mmo/sea-thieves-ship-speeds-explained)).
 * Vento a favor continua sendo o rumo mais rápido para ela; o que ela faz melhor
 * que brigue e galeão é *perder pouco* contra o vento.
 *
 * Com o vento padrão (15,1 m/s) e o arrasto de `HullDrag`, o equilíbrio dá:
 * **popa 5,3 m/s (10,2 nós) · través 4,9 · proa 3,4 (65% da máxima)**.
 */

import * as THREE from 'three';
import { AIR_DENSITY, clamp01 } from '../core/MathUtils';
import { measureWindageProfile } from './ShipDimensions';
import { SAIL_FRAME, mastClearance, sailRestPoint, sailVertexIndex } from './ShipParts';
import type { ShipBody } from './ShipBody';
import type { WaveField } from '../world/WaveField';

// --- vento -------------------------------------------------------------------

/** Velocidade do vento com `windStrength = 0`, em m/s. */
const WIND_BASE_SPEED = 6;
/** Quanto `windStrength = 1` acrescenta, em m/s. */
const WIND_SPEED_RANGE = 14;

/**
 * Vento verdadeiro no mundo, em m/s, a partir do estado do mar.
 *
 * O `WaveField` guarda o vento como direção mais uma intensidade de 0 a 1, que é
 * o que o espectro de ondas precisa. Quem faz força precisa de metros por
 * segundo, e a conversão mora aqui para existir num lugar só.
 */
export function getTrueWind(waves: WaveField, target: THREE.Vector3): THREE.Vector3 {
  const speed = WIND_BASE_SPEED + clamp01(waves.windStrength) * WIND_SPEED_RANGE;
  return target
    .set(Math.cos(waves.windDirection), 0, Math.sin(waves.windDirection))
    .multiplyScalar(speed);
}

/**
 * Rumo em que o vento fica exatamente em popa — o mais rápido da Chalupa.
 *
 * `windDirection` é o ângulo **para onde** o vento sopra, com o vetor
 * `(cos wd, 0, sen wd)`. Vento em popa é a proa apontando no mesmo sentido do
 * vento; como a proa é −Z local, o rumo que satisfaz isso é `atan2(−cos, −sen)`.
 *
 * Mora aqui, e não na IA, porque é conhecimento sobre o vento — e porque a
 * bancada de testes de `main.ts` precisa exatamente do mesmo número. Duas cópias
 * dessa conta é uma cópia a mais.
 */
export function downwindHeading(waves: WaveField): number {
  return Math.atan2(-Math.cos(waves.windDirection), -Math.sin(waves.windDirection));
}

/**
 * Eficiência da vela num rumo, sem simular nada.
 *
 * É a mesma curva de `applyThrust`, reescrita em função do rumo: o alinhamento
 * entre proa e vento é o cosseno do desvio em relação ao rumo de popa. Serve ao
 * timoneiro bot para escolher entre dois cursos que servem à tática, e ao HUD para
 * desenhar a rosa de vento.
 *
 * Usa o vento **verdadeiro**, não o aparente: a correção de vento aparente
 * depende da velocidade que o navio ainda não tem no rumo que está sendo
 * avaliado, e incluí-la exigiria resolver o equilíbrio inteiro para responder
 * "esse bordo é bom?".
 *
 * @returns de `MIN_EFFICIENCY` (vento pela proa) a 1 (vento em popa).
 */
export function efficiencyAtHeading(heading: number, waves: WaveField): number {
  const alignment = Math.cos(heading - downwindHeading(waves));
  return MIN_EFFICIENCY + (1 - MIN_EFFICIENCY) * (1 + alignment) * 0.5;
}

// --- propulsão ---------------------------------------------------------------

/**
 * Área efetiva do aparelho, em m².
 *
 * Bem maior que os ~36 m² de lona desenhada, e assumidamente: o Sea of Thieves
 * estiliza a vela da chalupa pequena, mas move um casco de 37 toneladas a mais de
 * 10 nós, o que aquele pano não faria em vento nenhum. Entre falsear a área e
 * falsear o coeficiente de arrasto, falsear a área é o menor dos males — 124 m²
 * é o que um cúter de 16 m realmente carrega, então todo o resto da conta
 * continua sendo física de verdade em cima de um número plausível.
 */
const RIG_AREA = 124;
/** Arrasto de uma vela redonda cheia. Placa porosa e curva fica perto de 1,6. */
const SAIL_CD = 1.62;

/**
 * Quanto da própria velocidade do navio a vela sente como vento a menos.
 *
 * Com vento aparente puro (1,0) a vela seria um freio: de popa o empuxo cairia
 * junto com a velocidade e o navio empacaria em ~4,4 m/s, com apenas 12% de
 * diferença entre navegar de popa e de proa — reta demais para dar leitura de
 * rumo ao jogador. O valor parcial representa o que um modelo puramente de
 * arrasto não consegue produzir: uma vela redonda também gera sustentação, e é
 * ela que faz um veleiro de pano quadrado andar bem acima do que o arrasto
 * sozinho explicaria.
 */
const APPARENT_RELIEF = 0.45;

/**
 * Eficiência mínima, com o vento na cara.
 *
 * Não é zero porque o vento nunca fica exatamente na proa e porque a chalupa
 * precisa continuar governando de bolina — é este número que define os 65% de
 * velocidade contra o vento que caracterizam o barco.
 */
const MIN_EFFICIENCY = 0.25;

/** Centro de esforço da vela, em coordenadas locais. */
const SAIL_CENTER = new THREE.Vector3(0, (SAIL_FRAME.topY + SAIL_FRAME.bottomY) * 0.5, SAIL_FRAME.z);

/**
 * Área e arrasto do que não é vela: obras mortas, mastro, cordame e a componente
 * tangencial do próprio pano.
 *
 * Existe porque a vela é fixa e sua força é puramente longitudinal — sem este
 * termo o vento não daria **nenhuma** banda nem abatimento, e o navio andaria
 * como se estivesse num trilho. É pequeno de propósito: seu papel é inclinar e
 * derivar, não propelir.
 *
 * 7 m² é o que sobra de área frontal acima d'água num casco de 5 m de boca com
 * 1,5 m de borda livre, mais mastro e cordame. Medido: rende ~830 N a 15 m/s, um
 * décimo do empuxo da vela — a proporção certa para um termo de correção. Já
 * esteve em 26 m², e aí o navio andava a 3 nós de vela ferrada, o que é absurdo.
 */
const WINDAGE_AREA = 7;
const WINDAGE_CD = 0.85;

/**
 * Área lateral do mastro, verga e cordame, em m². Só serve de peso na média que
 * decide o centro de esforço abaixo — a intensidade da força vem de
 * `WINDAGE_AREA`.
 *
 * Mastro de 12,7 m afinando de 0,48 para 0,22 m de diâmetro dá ~4,4 m²; verga,
 * enfrechates e estais somam os outros ~2.
 */
const RIG_SIDE_AREA = 6.4;
/**
 * Altura do centro dessa área. O mastro é mais grosso embaixo, então o centroide
 * dele fica abaixo do meio dos 12,7 m; a verga a 9 m puxa de volta para cima.
 */
const RIG_CENTER_Y = 6.6;

/**
 * Centro do esforço do vento sobre tudo que está acima d'água.
 *
 * **O `z` daqui é o que importa**, e é o único número da força do vento que gera
 * guinada: a parcela longitudinal, aplicada na linha de centro, só dá caturro.
 * Ele estava cravado no mastro, e o mastro fica 2,1 m à vante do centro de massa
 * — braço suficiente para o navio arribar sozinho a ~0,1°/s em qualquer amura,
 * com o leme no meio. Leme de sota permanente é defeito de projeto, não
 * característica.
 *
 * O certo é a média ponderada de duas silhuetas: o costado, medido do mesmo
 * casco que tudo o mais lê (37,7 m², centro em z = −0,21), e a mastreação,
 * estreita e bem mais à vante (6,4 m² em z = −1,2). O costado ganha por área, o
 * centro resultante fica em −0,35 — praticamente a meia-nau, que é onde ele deve
 * estar — e o braço até o centro de massa cai de 2,11 para 1,26 m.
 *
 * Sobra leme de sota? Sobra, ~0,08°/s. E deve sobrar: o pano é fixo e quadrado,
 * o mastro está à vante, e barco largado nessas condições **arriba mesmo** até
 * cair de popa para o vento. Zerar isso exigiria inventar um número; o que dá
 * para fazer com honestidade é pôr a força onde a área está, e é o que está aqui.
 */
const WINDAGE_CENTER = (() => {
  const hull = measureWindageProfile();
  const total = hull.area + RIG_SIDE_AREA;
  return new THREE.Vector3(
    0,
    (hull.centerY * hull.area + RIG_CENTER_Y * RIG_SIDE_AREA) / total,
    (hull.centerZ * hull.area + SAIL_FRAME.z * RIG_SIDE_AREA) / total,
  );
})();

// --- tecido ------------------------------------------------------------------

/** Folga vertical do pano. É o que obriga a lona a embarrigar em vez de esticar. */
const VERTICAL_SLACK = 1.055;
/** Folga diagonal. Menor que a vertical, para o pano resistir a cisalhar. */
const SHEAR_SLACK = 1.02;
/** Iterações de relaxamento por passo. Três já deixa a grade visualmente rígida. */
const RELAX_ITERATIONS = 3;
/** Perda de energia por passo. Sem isso o pano vira gelatina permanente. */
const CLOTH_DAMPING = 0.985;
/** Aceleração da lona por unidade de pressão dinâmica do vento. */
const CLOTH_WIND = 0.085;
/** Gravidade sentida pelo pano. Menor que a real: lona é leve e o ar segura. */
const CLOTH_GRAVITY = 3.4;
/** Amplitude do tremular quando a vela está a pano solto. */
const FLUTTER_GAIN = 0.55;

interface ClothConstraint {
  a: number;
  b: number;
  rest: number;
}

const _trueWind = new THREE.Vector3();
const _relativeWind = new THREE.Vector3();
const _localWind = new THREE.Vector3();
const _force = new THREE.Vector3();
const _worldPoint = new THREE.Vector3();
const _rest = new THREE.Vector3();

export class SailSim {
  /** 0 = aferrada, 1 = a toda vela. Ainda não há input; a força já respeita. */
  trim = 1;

  /** Empuxo longitudinal do último passo, em newtons. Telemetria e HUD. */
  thrust = 0;
  /** Eficiência do rumo em relação ao vento, 0,25 a 1. Alimenta o HUD de vento. */
  efficiency = 0;
  /** Vento aparente no referencial do navio. A IA lê para escolher o rumo. */
  readonly localWind = new THREE.Vector3();

  private readonly geometry: THREE.BufferGeometry | null;
  private readonly positions: Float32Array | null = null;
  private readonly previous: Float32Array | null = null;
  private readonly pinned: Uint8Array | null = null;
  private readonly constraints: ClothConstraint[] = [];
  private clothTime = 0;

  /**
   * @param mesh malha da vela, ou `null` para um navio sem pano visível (o mar
   *   longe, onde o tecido não seria visto e não vale o custo).
   */
  constructor(mesh: THREE.Mesh | null) {
    this.geometry = mesh?.geometry ?? null;
    if (!this.geometry) return;

    const attribute = this.geometry.getAttribute('position') as THREE.BufferAttribute;
    this.positions = attribute.array as Float32Array;
    this.previous = new Float32Array(this.positions);

    const { columns, rows } = SAIL_FRAME;
    this.pinned = new Uint8Array((columns + 1) * (rows + 1));
    for (let i = 0; i <= columns; i++) {
      // Cabeça na verga e pé na retranca: as duas relingas ferradas ao pau.
      this.pinned[sailVertexIndex(i, 0)] = 1;
      this.pinned[sailVertexIndex(i, rows)] = 1;
    }

    // As valeiras (as bordas laterais) ficam soltas de propósito: é nelas que o
    // tremular aparece, e é o que separa uma vela viva de um cartaz esticado.
    const dx = (SAIL_FRAME.halfWidth * 2) / columns;
    const dy = (SAIL_FRAME.topY - SAIL_FRAME.bottomY) / rows;
    const diagonal = Math.hypot(dx, dy * VERTICAL_SLACK);

    for (let j = 0; j <= rows; j++) {
      for (let i = 0; i <= columns; i++) {
        const index = sailVertexIndex(i, j);
        if (i < columns) this.constraints.push({ a: index, b: sailVertexIndex(i + 1, j), rest: dx });
        if (j < rows) {
          this.constraints.push({ a: index, b: sailVertexIndex(i, j + 1), rest: dy * VERTICAL_SLACK });
        }
        if (i < columns && j < rows) {
          this.constraints.push({ a: index, b: sailVertexIndex(i + 1, j + 1), rest: diagonal * SHEAR_SLACK });
          this.constraints.push({
            a: sailVertexIndex(i + 1, j),
            b: sailVertexIndex(i, j + 1),
            rest: diagonal * SHEAR_SLACK,
          });
        }
      }
    }

  }

  /**
   * Passo fixo da vela: aplica as forças ao corpo e sacode o pano.
   *
   * @param waves fonte do vento verdadeiro.
   */
  update(dt: number, body: ShipBody, waves: WaveField): void {
    getTrueWind(waves, _trueWind);

    // Vento aparente parcial: ver `APPARENT_RELIEF`.
    _relativeWind.copy(_trueWind).addScaledVector(body.velocity, -APPARENT_RELIEF);
    body.worldDirToLocal(_relativeWind, _localWind);
    this.localWind.copy(_localWind);

    this.applyThrust(body);
    this.applyWindage(body);
    this.stepCloth(dt);
  }

  /** Empuxo da vela: força longitudinal no centro de esforço. */
  private applyThrust(body: ShipBody): void {
    const windSpeed = _localWind.length();
    if (windSpeed < 0.01 || this.trim <= 0) {
      this.thrust = 0;
      this.efficiency = 0;
      return;
    }

    // A vela é fixa e atravessada, então sua normal é o eixo proa-popa do navio:
    // -Z local é a proa. `alignment` é o cosseno entre o rumo e o vento.
    const alignment = -_localWind.z / windSpeed;
    this.efficiency = MIN_EFFICIENCY + (1 - MIN_EFFICIENCY) * (1 + alignment) * 0.5;

    const dynamicPressure = 0.5 * AIR_DENSITY * windSpeed * windSpeed;
    this.thrust = dynamicPressure * RIG_AREA * SAIL_CD * this.efficiency * this.trim;

    _force.set(0, 0, -this.thrust);
    body.localDirToWorld(_force, _force);
    body.localToWorld(SAIL_CENTER, _worldPoint);
    body.applyForceAtPoint(_force, _worldPoint);
  }

  /** Arrasto do vento sobre obras mortas e mastreação: banda e abatimento. */
  private applyWindage(body: ShipBody): void {
    const speed = _localWind.length();
    if (speed < 0.01) return;

    // Sobre o vento *relativo*, no mundo: esta parcela empurra o navio para
    // sotavento, não para a proa.
    _force
      .copy(_relativeWind)
      .multiplyScalar(0.5 * AIR_DENSITY * WINDAGE_CD * WINDAGE_AREA * speed);
    body.localToWorld(WINDAGE_CENTER, _worldPoint);
    body.applyForceAtPoint(_force, _worldPoint);
  }

  /** Um passo de Verlet no tecido. */
  private stepCloth(dt: number): void {
    const positions = this.positions;
    const previous = this.previous;
    const pinned = this.pinned;
    if (!positions || !previous || !pinned || !this.geometry) return;

    this.clothTime += dt;

    // Pressão sobre o pano: **a mesma eficiência que faz a força**.
    //
    // Aqui estava o defeito que se via como "a vela está do lado errado". A
    // pressão saía de `-localWind.z` cru, ou seja, do sinal do vento — e com o
    // vento pela proa esse sinal inverte: a lona era empurrada para ré, achatava
    // contra o mastro e o navio ficava sem vela nenhuma, uma casca fina enrolada
    // no tronco. Só que a física deste jogo **não** para com vento de proa: a
    // eficiência tem piso em `MIN_EFFICIENCY` e a chalupa continua a 65% da
    // velocidade, que é a característica que define o barco. As duas descrições
    // discordavam, e a que o jogador vê é a errada.
    //
    // Lendo a mesma `efficiency` da propulsão, o pano infla sempre para vante e
    // a barriga vira o **medidor** do rumo: cheia de popa, média de través,
    // rasa de proa. Nada de sinal para inverter, e nunca mais meia vela de cada
    // lado do pau.
    const windSpeed = Math.max(_localWind.length(), 0.001);
    const drive = windSpeed * this.efficiency * this.trim;
    const pressure = CLOTH_WIND * drive * drive;

    // Vela cheia fica dura e quieta; vela mal orientada bate. `luff` vai de 0
    // (vento em popa) a 1 (vento na cara), e o tremular sai da pressão dinâmica
    // **total** — e não da parcela que empurra —, porque uma vela tomada de
    // contravento chacoalha com toda a força do vento, justo por não estar
    // trabalhando.
    const alignment = -_localWind.z / windSpeed;
    const luff = clamp01((1 - alignment) * 0.5);
    const flutter = FLUTTER_GAIN * luff * CLOTH_WIND * windSpeed * windSpeed;
    const dt2 = dt * dt;

    for (let index = 0; index < pinned.length; index++) {
      if (pinned[index]) continue;
      const o = index * 3;

      const x = positions[o]!;
      const y = positions[o + 1]!;
      const z = positions[o + 2]!;

      const turbulence =
        flutter *
        Math.sin(x * 2.3 + this.clothTime * 7.1) *
        Math.sin(y * 1.7 - this.clothTime * 5.3);

      positions[o] = x + (x - previous[o]!) * CLOTH_DAMPING;
      positions[o + 1] = y + (y - previous[o + 1]!) * CLOTH_DAMPING - CLOTH_GRAVITY * dt2;
      positions[o + 2] = z + (z - previous[o + 2]!) * CLOTH_DAMPING - (pressure + turbulence) * dt2;

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
        const length = Math.hypot(dx, dy, dz);
        if (length < 1e-6) continue;

        // Só encurta, nunca estica: lona não é elástico. Deixar a restrição
        // empurrar quando o pano está frouxo é o que criaria aquela ondulação
        // de plástico que denuncia tecido mal simulado.
        if (length <= constraint.rest) continue;

        const correction = (length - constraint.rest) / length / 2;
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

    this.keepOffMast();

    this.geometry.getAttribute('position').needsUpdate = true;
    this.geometry.computeVertexNormals();
    this.geometry.getAttribute('normal').needsUpdate = true;
  }

  /**
   * Empurra a lona para fora do mastro, **sempre para vante**.
   *
   * Sem isto o pano atravessa o tronco: as quatro bordas estão presas no plano
   * do mastro e o meio nasce dentro dele, e o mastro não existe para o solver de
   * Verlet. O que se via era meia vela de cada lado do pau, que é justamente a
   * leitura de "a vela está do lado errado".
   *
   * O lado agora é escolhido, e não herdado. A versão anterior mandava cada nó
   * para o lado em que já estivesse, o que preservava — e petrificava — qualquer
   * pedaço de pano que tivesse escapado para ré num quadro ruim: a lona ficava
   * repartida pelo tronco, metade de cada lado, sem nunca se recompor. Como a
   * pressão passou a inflar sempre a favor da propulsão (ver `stepCloth`), a
   * vela agora tem um lado certo, e é para ele que o mastro empurra.
   *
   * Roda **depois** do relaxamento, e não antes: uma restrição de não penetração
   * aplicada no meio das iterações é desfeita pela seguinte, e o pano volta a
   * piscar por dentro do mastro em quadros alternados.
   */
  private keepOffMast(): void {
    const positions = this.positions;
    const pinned = this.pinned;
    if (!positions || !pinned) return;

    for (let index = 0; index < pinned.length; index++) {
      if (pinned[index]) continue;
      const o = index * 3;

      const clearance = mastClearance(positions[o]!, positions[o + 1]!);
      if (clearance <= 0) continue;

      const front = SAIL_FRAME.z - clearance;
      if (positions[o + 2]! > front) positions[o + 2] = front;
    }
  }

  /** Devolve o pano à forma de repouso — usado ao reiniciar uma partida. */
  reset(): void {
    const positions = this.positions;
    const previous = this.previous;
    if (!positions || !previous || !this.geometry) return;

    const { columns, rows } = SAIL_FRAME;
    for (let j = 0; j <= rows; j++) {
      for (let i = 0; i <= columns; i++) {
        const o = sailVertexIndex(i, j) * 3;
        sailRestPoint(i, j, _rest);
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
