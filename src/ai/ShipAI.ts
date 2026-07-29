/**
 * O capitão inimigo: decide a intenção, e distribui os dois homens que tem.
 *
 * Este arquivo é o único da IA que sabe que existe um *duelo*. `Helmsman` sabe
 * governar, `Gunner` sabe atirar, `Crew` sabe que só há um par de mãos livres —
 * nenhum deles sabe que há um inimigo. Aqui se lê a geometria dos dois navios e
 * dela saem três ordens: um rumo, um bordo de combate e um posto para o marujo.
 *
 * ## A tática nasce do batente da carreta
 *
 * O canhão só gira 26° para cada lado do través (`TRAVERSE_LIMIT`). Isso significa
 * que o setor de tiro de cada bordo é a faixa de 64° a 116° de marcação relativa —
 * e que **manter o inimigo sob fogo é trabalho do timão**, não da pontaria. Toda a
 * tática deste arquivo é uma consequência disso: o capitão passa a partida
 * tentando pôr o adversário no través, e é essa dança que o jogador enfrenta.
 *
 * A conta que faz isso é uma linha. A marcação relativa desejada do alvo é
 *
 * ```
 * β = 90° − k · (alcance − distância_de_combate)
 * ```
 *
 * Longe, `β` cai e a proa vira para o inimigo: fecha distância. Perto, `β` passa
 * de 90° e o navio abre. **No ponto certo, `β` = 90° e ele fica de través, com as
 * duas peças em batalha.** Um controlador proporcional de distância disfarçado de
 * manobra naval — e o que se vê na tela é um capitão circulando o jogador.
 *
 * ## O que a dificuldade *não* muda
 *
 * Nada de física. Ver a tabela em `Difficulty`. O que muda é o atraso com que ele
 * percebe a mudança de situação (`reaction`), a firmeza da mão no timão
 * (`helmGain`), a distância que ele julga boa (`standoff`), o quanto de água ele
 * deixa entrar antes de largar o canhão (`floodAlarm`) e quanto do turno ele
 * entrega ao porão antes de a briga chamá-lo de volta (`holdShift`/`gunShift`).
 *
 * ## O marujo não conserta tudo, e é aqui que se decide isso
 *
 * O rodízio de `assignCrew` é a peça que faz um duelo terminar. Antes dele, o
 * marujo descia ao porão e só voltava com o casco fechado e o poço seco — um par de
 * mãos que fechava cinco rombos por minuto enquanto o timoneiro seguia governando,
 * e nenhuma taxa de acerto plausível do jogador ultrapassava isso. Agora ele entrega
 * um turno e sobe, com o casco no estado em que estiver, porque o combate está lá em
 * cima. Ver a nota longa em `assignCrew`.
 */

import * as THREE from 'three';
import { DEG, angleDelta, clamp, createRandom, wrapAngle } from '../core/MathUtils';
import { downwindHeading } from '../ship/SailSim';
import type { Ship } from '../ship/Ship';
import type { WaveField } from '../world/WaveField';
import type { DifficultyPreset } from './Difficulty';
import { Crew } from './Crew';
import { Gunner, type GunneryTarget } from './Gunner';
import { Helmsman } from './Helmsman';

/** O que o capitão está tentando fazer agora. O HUD mostra isso ao jogador. */
export type Intent = 'closing' | 'engaging' | 'evading' | 'repairing' | 'sunk';

/** Rótulos das intenções, para o HUD e para a telemetria. */
export const INTENT_LABELS: Record<Intent, string> = {
  closing: 'Closing in',
  engaging: 'Engaging',
  evading: 'Breaking off',
  repairing: 'Patching holes',
  sunk: 'Going down',
};

const HALF_PI = Math.PI / 2;

/**
 * Onde a pontaria mira, em coordenadas do alvo: **na linha d'água**.
 *
 * O número foi medido, não escolhido, e a primeira tentativa estava errada. Mirando
 * a 0,39 m (um palmo acima da linha d'água de projeto), a Lenda abria nove rombos
 * em quarenta tiros e o alagamento do alvo passava de 4% em dois minutos e meio —
 * absurdo para quem acerta o que quer.
 *
 * A causa é que `floods` e *alagar* não são a mesma coisa. `HitDetection` marca
 * `floods` em tudo que entra abaixo do convés, mas a água só entra de fato enquanto
 * `depth = superfície − rombo` for positivo (`ShipDamage`). Um rombo acima da linha
 * d'água só bebe quando passa crista de onda; com o mar de 1,8 m de altura
 * significativa a 0,39 m isso dá menos de um terço do tempo.
 *
 * Em 0,10 m o rombo fica submerso mais da metade do tempo, e o alagamento acontece.
 * Não desce mais que isso porque a bala chega em arco descendente: mirar abaixo da
 * superfície faz o segmento cruzar a água antes de encontrar o costado, e
 * `CannonballPool` resolve isso como respingo curto — tiro perdido.
 *
 * É o ponto de mira que a artilharia naval sempre pregou, e por exatamente esta
 * razão: na linha d'água é onde o furo custa caro.
 */
const AIM_LOCAL = new THREE.Vector3(0, 0.1, 0);

/**
 * Distância abaixo da qual o capitão rompe o contato, em metros.
 *
 * Não é medo: é o batente da carreta. Colado, a velocidade angular do alvo na
 * vista supera os 29°/s que a peça gira, e as duas partes deixam de conseguir
 * apontar. Ficar ali é trocar o duelo por um empurra-empurra.
 */
const RAM_RANGE = 34;

/** Acima de `standoff` × isto, ele considera que está longe e vai fechar. */
const CLOSE_FACTOR = 1.6;

/** Ganho de distância no rumo de aproximação, em rad por metro de erro. */
const CLOSE_GAIN = 0.03;
/**
 * Quanto a proa pode sair do través ao fechar: **90°**, ou seja, até a caça pura.
 *
 * O valor tem uma razão medida. Com o limite em 72°, a marcação desejada nunca
 * baixava de 18°, e a telemetria mostrou o inimigo estabilizar a 255 m de um alvo
 * que fugia de popa: os 18° de caranguejo custavam justo os 2% de eficiência de
 * vela que faltavam para ele ganhar terreno, e o duelo empatava para sempre.
 *
 * Fora do alcance de tiro não existe motivo para segurar bordada — o setor da
 * carreta só importa quando se vai atirar. Em 90° o `β` chega a zero e ele aponta a
 * proa no inimigo, que é o que qualquer capitão faz numa perseguição.
 */
const CLOSE_LIMIT = HALF_PI;

/** Os mesmos dois, em batalha: correções menores, para não perder o setor. */
const ENGAGE_GAIN = 0.022;
const ENGAGE_LIMIT = 0.75;

/** Marcação em que ele põe o alvo ao romper contato (150°: bem pela alheta). */
const EVADE_BEARING = 150 * DEG;

/**
 * Marcação relativa que o alvo precisa alcançar do outro lado para o capitão
 * trocar de bordo de combate (20°).
 *
 * Sem esta histerese, um alvo passando pela proa fica um passo a bombordo, um a
 * boreste, e o marujo atravessa o convés para sempre sem chegar a carregar nada.
 */
const SIDE_SWITCH = 20 * DEG;

/**
 * Alagamento que interrompe o combate para salvar o navio.
 *
 * O que o devolve à briga é `preset.bilgeFloor`, e **não** uma segunda constante
 * daqui. Houve uma, cravada em 15%, e ela brigava com o piso da bomba: o marujo
 * largava a alavanca no nível que o capitão dele considera aceitável e o capitão
 * continuava em modo de reparo porque o número dele era outro. Com os dois valores
 * desalinhados no sentido errado, o inimigo fugia para sempre com o porão parado —
 * bombeando nada, atirando nada, esperando um limiar que ninguém ia atingir.
 *
 * Um só número diz as duas coisas, que afinal são a mesma pergunta: **quanta água
 * este capitão aceita ter dentro do navio enquanto briga?**
 */
const BREAK_OFF_FLOOD = 0.5;

/**
 * Quanto o rumo pode chegar perto do vento pela proa, em radianos (35°).
 *
 * A Chalupa faz 65% da velocidade contra o vento, então bolina não é impossível —
 * mas o rumo *exatamente* na cara do vento é o único que a deixa parada de
 * verdade. Quando a geometria pede um curso dentro deste cone, ele é empurrado
 * para a borda: é a guinada de bordo de um veleiro, e o navio anda em ziguezague
 * em vez de encostar no vento e morrer.
 */
const NO_GO_HALF_ANGLE = 35 * DEG;

/** Proa, em coordenadas locais de qualquer navio. */
const LOCAL_BOW = new THREE.Vector3(0, 0, -1);

const _myOrigin = new THREE.Vector3();
const _foeOrigin = new THREE.Vector3();
const _aimPoint = new THREE.Vector3();

export class ShipAI {
  readonly helmsman = new Helmsman();
  readonly crew: Crew;
  /** Um por peça, na mesma ordem de `ship.cannons`. */
  readonly gunners: readonly Gunner[];

  /** O que ele está fazendo. Leitura para o HUD. */
  intent: Intent = 'closing';
  /** Bordo de combate escolhido: +1 boreste, −1 bombordo. */
  firingSide: 1 | -1 = 1;

  /** Distância entre as origens dos dois navios, em metros. */
  range = Infinity;
  /** Marcação do alvo a partir da proa, em radianos. Positivo é bombordo. */
  relativeBearing = 0;

  private readonly target: GunneryTarget;
  /** `true` enquanto o marujo está destacado para o porão. */
  private inHold = false;
  /**
   * Segundos de trabalho que o marujo já entregou no posto atual.
   *
   * Conta a partir da **chegada**, e não da ordem: a escada e a travessia do
   * convés já são cobradas em `Crew.transit`, e somá-las ao turno faria o Grumete
   * — que tem `transitScale` 1,6 — gastar seis dos oito segundos de porão dele
   * descendo os degraus. Ver `assignCrew`.
   */
  private postTime = 0;
  private pendingIntent: Intent | null = null;
  private reactionTimer = 0;

  constructor(
    private readonly ship: Ship,
    private readonly preset: DifficultyPreset,
    /**
     * Semente do erro de pontaria. Fixa por partida de propósito: um duelo que se
     * repete exatamente é a única forma de depurar uma queixa de "a IA me acertou
     * um tiro impossível".
     */
    seed = 0x5eaf00d,
  ) {
    const random = createRandom(seed);
    // Fluxo próprio, e não o dos artilheiros: com um sorteio só, o número de vezes
    // que o marujo escolhe um rombo passaria a decidir qual desvio de pontaria sai
    // no tiro seguinte. Continua reproduzível — a semente é a mesma —, mas as duas
    // perícias deixam de conversar por acidente.
    this.crew = new Crew(preset, createRandom(seed ^ 0x9e3779b9));
    this.gunners = ship.cannons.map((_, index) => new Gunner(ship, index, preset, random));
    this.target = {
      point: _aimPoint,
      velocity: new THREE.Vector3(),
      forward: new THREE.Vector3(),
    };
  }

  /** O canhão que está guarnecido agora, ou −1. Telemetria e HUD. */
  get mannedCannon(): number {
    return this.crew.cannonIndex;
  }

  /**
   * Segundos que faltam no turno do posto atual antes de o rodízio poder mudá-lo.
   * Só telemetria — ver `assignCrew`.
   */
  get shiftLeft(): number {
    const shift = this.inHold ? this.preset.holdShift : this.preset.gunShift;
    return Math.max(shift - this.postTime, 0);
  }

  /**
   * Um passo de comando. Roda **antes** de `ship.fixedUpdate`, para o timão, a
   * pontaria e o gatilho deste passo entrarem na física deste mesmo passo.
   */
  fixedUpdate(dt: number, foe: Ship, waves: WaveField): void {
    // Zerados aqui porque são comandos de passo: quem quiser bombear neste passo
    // pede de novo. `Ship` os lê depois de nós.
    this.ship.controls.capstanTurns = 0;
    this.ship.controls.pumping = false;

    this.measure(foe);

    if (this.ship.damage.isSinking) {
      // Naufrágio não se comanda. Larga tudo e deixa o mar terminar.
      this.intent = 'sunk';
      this.pendingIntent = null;
      this.helmsman.release(this.ship);
      for (const gunner of this.gunners) gunner.fixedUpdate(dt, null, false);
      return;
    }

    this.chooseIntent(dt, foe);
    this.chooseSide();
    this.helmsman.setCourse(this.plotCourse(waves));
    this.helmsman.update(dt, this.ship, this.preset.helmGain);

    this.assignCrew(dt);
    this.crew.fixedUpdate(dt, this.ship);

    // O alvo do artilheiro: onde acertar, para onde ele foge, e ao longo de que
    // eixo o fogo é varrido (o comprimento do casco dele).
    foe.body.localToWorld(AIM_LOCAL, _aimPoint);
    this.target.velocity.copy(foe.body.velocity);
    foe.body.localDirToWorld(LOCAL_BOW, this.target.forward);

    const manned = this.crew.cannonIndex;
    const fireable = this.intent === 'engaging' || this.intent === 'closing' || this.intent === 'evading';
    for (let i = 0; i < this.gunners.length; i++) {
      // Alvo afundando já saiu da partida: gastar bala nele é só ruído.
      const engage = fireable && !foe.damage.isSinking;
      this.gunners[i]!.fixedUpdate(dt, engage ? this.target : null, i === manned);
    }
  }

  /** Devolve o capitão ao estado de início de partida. */
  reset(): void {
    this.intent = 'closing';
    this.pendingIntent = null;
    this.reactionTimer = 0;
    this.firingSide = 1;
    this.inHold = false;
    this.postTime = 0;
    this.range = Infinity;
    this.relativeBearing = 0;
    this.crew.reset();
    for (const gunner of this.gunners) gunner.reset();
  }

  // -- percepção ---------------------------------------------------------------

  private measure(foe: Ship): void {
    this.ship.body.getOrigin(_myOrigin);
    foe.body.getOrigin(_foeOrigin);

    const dx = _foeOrigin.x - _myOrigin.x;
    const dz = _foeOrigin.z - _myOrigin.z;
    this.range = Math.hypot(dx, dz);

    // `atan2(−x, −z)` é a mesma convenção de `Ship.heading`: o rumo que aponta a
    // proa para o alvo. A de `solveIntercept` é outra — ver `Gunner`.
    const bearing = Math.atan2(-dx, -dz);
    this.relativeBearing = angleDelta(this.ship.heading, bearing);
  }

  // -- decisão -----------------------------------------------------------------

  /**
   * Escolhe a intenção, com o atraso de reação do preset.
   *
   * O atraso não é um `setTimeout` disfarçado: ele existe porque um capitão que
   * troca de plano no mesmo passo em que a situação muda produz um navio nervoso,
   * que corrige rumo a cada onda. Segurar a decisão por meio segundo é o que dá
   * peso à manobra — e é a diferença mais visível entre o Grumete e a Lenda.
   */
  private chooseIntent(dt: number, foe: Ship): void {
    const desired = this.desiredIntent(foe);

    if (desired === this.intent) {
      this.pendingIntent = null;
      return;
    }

    if (desired !== this.pendingIntent) {
      this.pendingIntent = desired;
      this.reactionTimer = this.preset.reaction;
    }

    this.reactionTimer -= dt;
    if (this.reactionTimer > 0) return;

    this.intent = desired;
    this.pendingIntent = null;
  }

  private desiredIntent(foe: Ship): Intent {
    const flood = this.ship.damage.floodFraction;

    // Histerese no alagamento: entra em 50%, só volta a brigar quando o porão chega
    // ao nível que este capitão aceita levar para o combate. Sem ela o navio
    // alterna entre fugir e voltar em cima do limiar, e não faz nem uma coisa nem
    // outra. Ver `BREAK_OFF_FLOOD` para por que o piso de volta é o do preset.
    if (this.intent === 'repairing') {
      if (flood > this.preset.bilgeFloor) return 'repairing';
    } else if (flood >= BREAK_OFF_FLOOD) {
      return 'repairing';
    }

    // Alvo já afundando: não há mais duelo, só sair de perto dos destroços.
    if (foe.damage.isSinking) return 'evading';

    if (this.range < RAM_RANGE) return 'evading';
    if (this.range > this.preset.standoff * CLOSE_FACTOR) return 'closing';
    return 'engaging';
  }

  /** Qual bordo briga, com histerese para não atravessar o convés à toa. */
  private chooseSide(): void {
    // `relativeBearing < 0` é alvo a boreste, que é o bordo `+1`.
    const onStarboard = this.relativeBearing < 0;
    const usingStarboard = this.firingSide === 1;
    if (onStarboard === usingStarboard) return;
    if (Math.abs(this.relativeBearing) < SIDE_SWITCH) return;

    this.firingSide = onStarboard ? 1 : -1;
  }

  /**
   * Manda o marujo para onde ele é mais necessário — e o traz de volta antes de o
   * serviço estar pronto.
   *
   * **O rodízio é a resposta a "não dá para afundar esse navio".** A regra antiga
   * era um só limiar: descia com o porão em `floodAlarm` e só subia com o casco
   * fechado *e* o porão seco. Medindo, isso queria dizer que oito rombos na linha
   * d'água viravam um casco estanque em 25 segundos, sempre, enquanto o timoneiro
   * seguia governando. O jogador não estava enfrentando um adversário com um par de
   * mãos: estava enfrentando um estaleiro.
   *
   * O que entrou no lugar é a escolha que o jogador faz o tempo todo: **a briga
   * está lá em cima.** O marujo entrega um turno de porão (`holdShift`) e volta
   * para a peça, tenha fechado o casco ou não, e deve um turno de canhão
   * (`gunShift`) antes de poder descer de novo. O casco acumula avaria entre uma
   * descida e outra — e é nesse acúmulo que uma boa salva do jogador vira uma
   * vantagem que não se desfaz sozinha.
   *
   * **A exceção é o que mantém a IA esperta.** Com o porão em `BREAK_OFF_FLOOD` o
   * capitão já largou o combate (`desiredIntent`), e aí não há turno que valha:
   * salvar o navio passa a ser a única tarefa e o marujo fica embaixo até o casco
   * fechar. Um inimigo que subisse para a peça com o porão pela metade não seria
   * mais difícil, seria só suicida.
   */
  private assignCrew(dt: number): void {
    const damage = this.ship.damage;
    const flood = damage.floodFraction;
    // Só conta trabalho: o tempo de escada é de `Crew.transit`. Ver `postTime`.
    if (this.crew.onStation) this.postTime += dt;

    const emergency = this.intent === 'repairing';

    if (this.inHold) {
      // Não há mais o que fazer lá embaixo, e ele sobe antes de o turno acabar. São
      // duas condições, e a segunda é a que fecha o caso degenerado: o porão tem de
      // estar no nível que ele aceita levar para o combate (o piso **não** é zero —
      // ver `bilgeFloor`), e não pode haver buraco que ele **consiga** tapar. Sem
      // tábua no paiol, um casco furado deixa de ser trabalho: insistir ali prenderia
      // o marujo num porão em que ele não tem nada a fazer nem nada a bombear.
      const canPatch = damage.breaches.length > 0 && this.ship.hasPlanks;
      const finished = !canPatch && flood < this.preset.bilgeFloor;
      if (finished || (!emergency && this.postTime >= this.preset.holdShift)) {
        this.inHold = false;
        this.postTime = 0;
      }
    } else if (flood >= this.preset.floodAlarm) {
      if (emergency || this.postTime >= this.preset.gunShift) {
        this.inHold = true;
        this.postTime = 0;
      }
    }

    if (this.inHold) {
      this.crew.orderTo('hold');
      return;
    }
    this.crew.orderTo(this.firingSide === 1 ? 'starboard' : 'port');
  }

  // -- navegação ---------------------------------------------------------------

  /** O rumo que a intenção atual pede, já corrigido pelo vento. */
  private plotCourse(waves: WaveField): number {
    const bearing = wrapAngle(this.ship.heading + this.relativeBearing);

    switch (this.intent) {
      case 'engaging':
        return this.avoidNoGo(this.broadside(bearing, ENGAGE_GAIN, ENGAGE_LIMIT), waves);
      case 'closing':
        return this.avoidNoGo(this.broadside(bearing, CLOSE_GAIN, CLOSE_LIMIT), waves);
      case 'evading':
      case 'repairing':
        return this.escape(bearing, waves);
      default:
        return this.ship.heading;
    }
  }

  /**
   * O rumo que põe o alvo na marcação de través corrigida pela distância.
   *
   * `heading = marcação + bordo · β` sai de `marcação_relativa = marcação −
   * rumo`: para o alvo cair em `−bordo · β` de marcação relativa, o rumo tem de
   * ser a marcação mais `bordo · β`. Errar este sinal faz o navio girar para o
   * lado oposto ao inimigo — e, como a realimentação fica positiva, girar cada
   * vez mais rápido.
   */
  private broadside(bearing: number, gain: number, limit: number): number {
    const rangeError = this.range - this.preset.standoff;
    const beta = HALF_PI - clamp(rangeError * gain, -limit, limit);
    return wrapAngle(bearing + this.firingSide * beta);
  }

  /**
   * Rumo de fuga: o mais rápido entre os que abrem distância.
   *
   * Fugir na direção oposta ao inimigo é o óbvio e às vezes é o pior — se aquele
   * rumo for contra o vento, ele foge a 65% da velocidade enquanto o perseguidor
   * decide o dele. Então entre "de costas para o inimigo" e "vento em popa" ele
   * escolhe o de popa, desde que este ainda o afaste (menos de 90° do rumo de
   * fuga puro). É o manual da chalupa perseguida, ao contrário.
   */
  private escape(bearing: number, waves: WaveField): number {
    const away = wrapAngle(bearing + Math.PI);
    const downwind = downwindHeading(waves);

    if (Math.abs(angleDelta(away, downwind)) < HALF_PI) return downwind;

    // Nem o rumo de popa serve: mantém o alvo bem pela alheta, que ao menos deixa
    // um canhão em setor enquanto ele se afasta.
    return wrapAngle(bearing + this.firingSide * EVADE_BEARING);
  }

  /**
   * Empurra um rumo para fora do cone de vento pela proa.
   *
   * Só age quando a geometria pediu um curso dentro do cone: nesse caso ele sai
   * pela borda **mais próxima**, que é a mesma escolha de quem dá uma guinada de
   * bordo. O efeito visível é o navio subir contra o vento em ziguezague em vez
   * de encostar nele e ficar parado com a vela batendo.
   */
  private avoidNoGo(course: number, waves: WaveField): number {
    const upwind = wrapAngle(downwindHeading(waves) + Math.PI);
    const off = angleDelta(upwind, course);
    if (Math.abs(off) >= NO_GO_HALF_ANGLE) return course;

    // `off` pode ser exatamente 0 (vento na cara cravado); nesse caso qualquer
    // bordo serve, e o de boreste é tão bom quanto o outro.
    const side = off >= 0 ? 1 : -1;
    return wrapAngle(upwind + side * NO_GO_HALF_ANGLE);
  }
}
