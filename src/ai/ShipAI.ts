/**
 * The enemy captain: decides the intent, and splits the two men he has.
 *
 * This is the only AI file that knows a *duel* exists. `Helmsman` knows how to
 * steer, `Gunner` knows how to shoot, `Crew` knows there is only one pair of free
 * hands — none of them knows there is an enemy. Here the geometry of the two
 * ships is read, and out of it come three orders: a course, a firing side and a
 * post for the deckhand.
 *
 * ## The tactics come from the end of the carriage's travel
 *
 * The gun only traverses 26° to either side of the beam (`TRAVERSE_LIMIT`). That
 * means each side's firing arc is the band from 64° to 116° of relative bearing —
 * and that **keeping the enemy under fire is the helm's job**, not the gunner's.
 * Every tactic in this file follows from that: the captain spends the match
 * trying to put his opponent abeam, and that dance is what the player is up
 * against.
 *
 * The math that does it is one line. The target's desired relative bearing is
 *
 * ```
 * β = 90° − k · (range − standoff)
 * ```
 *
 * Far out, `β` drops and the bow swings toward the enemy: it closes. Close in,
 * `β` goes past 90° and the ship opens. **At the right distance, `β` = 90° and he
 * sits abeam, with both guns in the fight.** A proportional range controller
 * dressed up as a naval maneuver — and what shows up on screen is a captain
 * circling the player.
 *
 * ## What difficulty does *not* change
 *
 * No physics. See the table in `Difficulty`. What changes is how late he notices
 * the situation has turned (`reaction`), how firm his hand is on the helm
 * (`helmGain`), the distance he judges good (`standoff`), how much water he lets
 * in before he leaves the gun (`floodAlarm`) and how much of the shift he gives
 * the hold before the fight calls him back (`holdShift`/`gunShift`).
 *
 * ## The deckhand doesn't fix everything, and this is where that gets decided
 *
 * The rotation in `assignCrew` is the piece that lets a duel end. Before it, the
 * deckhand went down to the hold and only came back up with the hull sealed and
 * the bilge dry — one pair of hands closing five breaches a minute while the
 * helmsman kept steering, and no plausible player hit rate could beat that. Now
 * he gives one shift and comes up, with the hull in whatever state it is in,
 * because the fight is up there. See the long note in `assignCrew`.
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

/** What the captain is trying to do right now. The HUD shows this to the player. */
export type Intent = 'closing' | 'engaging' | 'evading' | 'repairing' | 'sunk';

/** Intent labels, for the HUD and for telemetry. */
export const INTENT_LABELS: Record<Intent, string> = {
  closing: 'Closing in',
  engaging: 'Engaging',
  evading: 'Breaking off',
  repairing: 'Patching holes',
  sunk: 'Going down',
};

const HALF_PI = Math.PI / 2;

/**
 * Where gunnery aims, in target coordinates: **at the waterline**.
 *
 * The number was measured, not chosen, and the first attempt was wrong. Aiming at
 * 0.39 m (a hand's breadth above the design waterline), the Legend opened nine
 * breaches in forty shots and the target's flooding passed 4% in two and a half
 * minutes — absurd for someone who hits whatever he aims at.
 *
 * The cause is that `floods` and *flooding* are not the same thing. `HitDetection`
 * marks `floods` on anything that gets in below deck, but water only actually
 * comes in while `depth = surface − breach` is positive (`ShipDamage`). A breach
 * above the waterline only drinks when a wave crest goes past; in a sea of 1.8 m
 * significant height, at 0.39 m that is less than a third of the time.
 *
 * At 0.10 m the breach stays submerged more than half the time, and the flooding
 * happens. It goes no lower than that because the cannonball arrives on a
 * descending arc: aiming below the surface makes the segment cross the water
 * before it meets the hull side, and `CannonballPool` resolves that as a short
 * splash — a wasted shot.
 *
 * It is the point of aim naval gunnery always preached, and for exactly this
 * reason: the waterline is where a hole costs dear.
 */
const AIM_LOCAL = new THREE.Vector3(0, 0.1, 0);

/**
 * Distance below which the captain breaks contact, in meters.
 *
 * It is not fear: it is the end of the carriage's travel. Right alongside, the
 * target's angular velocity across the sight beats the 29°/s the gun trains at,
 * and both sides stop being able to point. Staying there trades the duel for a
 * shoving match.
 */
const RAM_RANGE = 34;

/** Above `standoff` × this, he counts himself far off and moves to close. */
const CLOSE_FACTOR = 1.6;

/** Range gain on the closing course, in rad per meter of error. */
const CLOSE_GAIN = 0.03;
/**
 * How far the bow may come off the beam while closing: **90°**, that is, up to a
 * pure chase.
 *
 * The value has a measured reason. With the limit at 72°, the desired bearing never
 * dropped below 18°, and telemetry showed the enemy settling 255 m from a target
 * running away astern: those 18° of crabbing cost exactly the 2% of sail efficiency
 * he was missing to gain ground, and the duel stalemated forever.
 *
 * Outside gun range there is no reason to hold a broadside — the carriage's arc
 * only matters when you are going to shoot. At 90° `β` reaches zero and he points
 * the bow at the enemy, which is what any captain does in a chase.
 */
const CLOSE_LIMIT = HALF_PI;

/** The same two, in the fight: smaller corrections, so the arc isn't lost. */
const ENGAGE_GAIN = 0.022;
const ENGAGE_LIMIT = 0.75;

/** Bearing he puts the target on when breaking contact (150°: well on the quarter). */
const EVADE_BEARING = 150 * DEG;

/**
 * Relative bearing the target has to reach on the other side for the captain to
 * switch firing sides (20°).
 *
 * Without this hysteresis, a target crossing the bow is one step to port, one to
 * starboard, and the deckhand crosses the deck forever without ever loading a thing.
 */
const SIDE_SWITCH = 20 * DEG;

/**
 * Flooding that interrupts the fight to save the ship.
 *
 * What sends him back into the fight is `preset.bilgeFloor`, and **not** a second
 * constant from here. There was one, nailed to 15%, and it fought with the pump's
 * floor: the deckhand let go of the lever at the level his captain finds acceptable
 * and the captain stayed in repair mode because his own number was a different one.
 * With the two values misaligned in the wrong direction, the enemy ran away forever
 * with the hold idle — pumping nothing, shooting nothing, waiting for a threshold
 * nobody was going to reach.
 *
 * One number says both things, which are after all the same question: **how much
 * water does this captain accept having inside the ship while he fights?**
 */
const BREAK_OFF_FLOOD = 0.5;

/**
 * How close to the wind off the bow a heading may come, in radians (35°).
 *
 * The Sloop makes 65% of her speed against the wind, so beating isn't impossible —
 * but the heading *exactly* in the wind's eye is the only one that truly stops her
 * dead. When the geometry asks for a course inside this cone, it gets pushed to the
 * edge: it's a sailing ship's tack, and the ship goes up in a zigzag instead of
 * leaning into the wind and dying.
 */
const NO_GO_HALF_ANGLE = 35 * DEG;

/** The bow, in any ship's local coordinates. */
const LOCAL_BOW = new THREE.Vector3(0, 0, -1);

const _myOrigin = new THREE.Vector3();
const _foeOrigin = new THREE.Vector3();
const _aimPoint = new THREE.Vector3();

export class ShipAI {
  readonly helmsman = new Helmsman();
  readonly crew: Crew;
  /** One per gun, in the same order as `ship.cannons`. */
  readonly gunners: readonly Gunner[];

  /** What he is doing. Read by the HUD. */
  intent: Intent = 'closing';
  /** Chosen firing side: +1 starboard, −1 port. */
  firingSide: 1 | -1 = 1;

  /** Distance between the two ships' origins, in meters. */
  range = Infinity;
  /** Target bearing from the bow, in radians. Positive is port. */
  relativeBearing = 0;

  private readonly target: GunneryTarget;
  /** `true` while the deckhand is detailed to the hold. */
  private inHold = false;
  /**
   * Seconds of work the deckhand has already put in at the current post.
   *
   * It counts from **arrival**, not from the order: the ladder and the walk across
   * the deck are already charged in `Crew.transit`, and adding them to the shift
   * would make the Deckhand — whose `transitScale` is 1.6 — spend six of his eight
   * seconds of hold time going down the steps. See `assignCrew`.
   */
  private postTime = 0;
  private pendingIntent: Intent | null = null;
  private reactionTimer = 0;

  constructor(
    private readonly ship: Ship,
    private readonly preset: DifficultyPreset,
    /**
     * Seed for the aiming error. Fixed per match on purpose: a duel that repeats
     * exactly is the only way to debug a complaint of "the AI hit me with an
     * impossible shot".
     */
    seed = 0x5eaf00d,
  ) {
    const random = createRandom(seed);
    // A stream of its own, not the gunners': with a single draw, the number of times
    // the deckhand picks a breach would end up deciding which aiming deviation comes
    // out of the next shot. Still reproducible — the seed is the same — but the two
    // skills stop talking to each other by accident.
    this.crew = new Crew(preset, createRandom(seed ^ 0x9e3779b9));
    this.gunners = ship.cannons.map((_, index) => new Gunner(ship, index, preset, random));
    this.target = {
      point: _aimPoint,
      velocity: new THREE.Vector3(),
      forward: new THREE.Vector3(),
    };
  }

  /** The cannon that is manned right now, or −1. Telemetry and HUD. */
  get mannedCannon(): number {
    return this.crew.cannonIndex;
  }

  /**
   * Seconds left in the current post's shift before the rotation may change it.
   * Telemetry only — see `assignCrew`.
   */
  get shiftLeft(): number {
    const shift = this.inHold ? this.preset.holdShift : this.preset.gunShift;
    return Math.max(shift - this.postTime, 0);
  }

  /**
   * One command step. Runs **before** `ship.fixedUpdate`, so that this step's helm,
   * aim and trigger go into the physics of this same step.
   */
  fixedUpdate(dt: number, foe: Ship, waves: WaveField): void {
    // Zeroed here because they are per-step commands: whoever wants to pump on this
    // step asks again. `Ship` reads them after us.
    this.ship.controls.capstanTurns = 0;
    this.ship.controls.pumping = false;

    this.measure(foe);

    if (this.ship.damage.isSinking) {
      // A sinking is not commanded. Drop everything and let the sea finish it.
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

    // The gunner's target: where to hit, where it is running to, and along which
    // axis fire is swept (the length of its hull).
    foe.body.localToWorld(AIM_LOCAL, _aimPoint);
    this.target.velocity.copy(foe.body.velocity);
    foe.body.localDirToWorld(LOCAL_BOW, this.target.forward);

    const manned = this.crew.cannonIndex;
    const fireable = this.intent === 'engaging' || this.intent === 'closing' || this.intent === 'evading';
    for (let i = 0; i < this.gunners.length; i++) {
      // A sinking target is already out of the match: spending shot on it is noise.
      const engage = fireable && !foe.damage.isSinking;
      this.gunners[i]!.fixedUpdate(dt, engage ? this.target : null, i === manned);
    }
  }

  /** Returns the captain to his start-of-match state. */
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

  // -- perception --------------------------------------------------------------

  private measure(foe: Ship): void {
    this.ship.body.getOrigin(_myOrigin);
    foe.body.getOrigin(_foeOrigin);

    const dx = _foeOrigin.x - _myOrigin.x;
    const dz = _foeOrigin.z - _myOrigin.z;
    this.range = Math.hypot(dx, dz);

    // `atan2(−x, −z)` is the same convention as `Ship.heading`: the heading that
    // points the bow at the target. `solveIntercept`'s is another — see `Gunner`.
    const bearing = Math.atan2(-dx, -dz);
    this.relativeBearing = angleDelta(this.ship.heading, bearing);
  }

  // -- decision ----------------------------------------------------------------

  /**
   * Picks the intent, with the preset's reaction delay.
   *
   * The delay is not a `setTimeout` in disguise: it exists because a captain who
   * changes plan on the same step the situation changes produces a jumpy ship,
   * one that corrects its heading on every wave. Holding the decision for half a
   * second is what gives the maneuver weight — and it is the most visible
   * difference between the Deckhand and the Legend.
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

    // Hysteresis on the flooding: it kicks in at 50%, and he only fights again once
    // the hold reaches the level this captain accepts taking into combat. Without it
    // the ship alternates between running and coming back right on the threshold,
    // and does neither. See `BREAK_OFF_FLOOD` for why the floor to return is the
    // preset's.
    if (this.intent === 'repairing') {
      if (flood > this.preset.bilgeFloor) return 'repairing';
    } else if (flood >= BREAK_OFF_FLOOD) {
      return 'repairing';
    }

    // Target already sinking: no duel left, only getting clear of the wreckage.
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
