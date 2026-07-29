/**
 * O artilheiro bot: uma peça, um alvo, e a decisão de quando soltar o tiro.
 *
 * Ele usa **o mesmo solucionador que o teste de balística valida** — nada de
 * parábola de vácuo nem de "acerta com X% de chance". O caminho é o de um
 * artilheiro de verdade:
 *
 * 1. Onde o alvo vai estar quando a bala chegar lá (`solveIntercept`).
 * 2. Que elevação e que azimute levam a bala até aquele ponto, **com arrasto**.
 * 3. Que travessia e que elevação *da carreta* apontam a alma naquela direção
 *    agora, com o navio na atitude em que ele está (`Cannon.solveAim`).
 * 4. Girar a peça para lá, no ritmo que dois braços num espeque conseguem.
 * 5. Esperar. E é o passo 5 que faz o combate parecer combate.
 *
 * ## Um homem, duas mãos, um serviço de cada vez
 *
 * **A medição que motivou esta seção:** o intervalo entre tiros do capitão Lenda era
 * de 1,533 s, e o *mínimo* era exatamente igual à *mediana* — 1,533 s também. Um
 * artilheiro que nunca, em oitenta tiros, perde um décimo de segundo não é um
 * artilheiro: é um metrônomo. E era isso que se sentia jogando contra ele.
 *
 * O erro não estava num número mal escolhido, e sim numa omissão: o único custo de
 * um ciclo de tiro era o tempo de socar a bala, e ele corria **em paralelo** com a
 * pontaria e com o recuo. O servente carregava, apontava e mirava tudo ao mesmo
 * tempo, com dois braços que ele não tem. Três coisas passaram a ser serializadas,
 * que é como elas acontecem numa peça de bordo servida por um homem só:
 *
 * - **A carreta corre de volta ao batente** antes de a peça aceitar a carga. Isso
 *   vive em `Cannon.beginLoad` porque é da peça, não de quem a serve, e por isso
 *   vale igual para o jogador.
 * - **Ele leva um tempo para largar o espeque e pegar a bala seguinte**
 *   (`servingTime`). É o análogo exato de o jogador ter de notar o tiro e apertar
 *   recarregar.
 * - **Ele não aponta enquanto soca.** Este é o que muda o duelo: quando o serviço
 *   acaba, o alvo andou, e a peça — que gira a 29°/s — tem de reencontrá-lo. Uma
 *   manobra do jogador durante a recarga do inimigo passou a custar caro *para o
 *   inimigo*, que é o que faz manobrar valer a pena.
 *
 * O ritmo que sai disso é irregular por construção, e é o ritmo que o texto acima
 * sempre prometeu: o inimigo espera a onda, e agora espera de verdade.
 *
 * ## Por que ele espera, e o que isso produz de graça
 *
 * A conversão do passo 3 é feita **a cada passo de física**, com a orientação do
 * casco daquele instante. Enquanto o navio caturra e balança, os ângulos que
 * acertam o alvo passeiam; a peça, presa ao convés, não consegue acompanhar. O
 * tiro só sai quando os dois coincidem dentro de `fireTolerance`.
 *
 * O resultado emergente é exatamente o que a artilharia naval fazia: **atira-se no
 * alto do balanço**, quando o costado do inimigo abre. Ninguém escreveu essa
 * regra aqui — ela cai da geometria. E ela é o que dá ritmo ao duelo: o inimigo
 * não cospe fogo continuamente, ele espera a onda, e o jogador aprende a ler esse
 * compasso.
 *
 * ## Onde entra o erro humano
 *
 * O desvio é somado **nos ângulos da peça**, depois da balística, e é sorteado
 * **uma vez por carga** — não por quadro. As duas escolhas importam:
 *
 * - Nos ângulos, porque é a mão do artilheiro que erra, não a física da bala. Erro
 *   na física daria trajetórias impossíveis; erro na pontaria dá um tiro perfeito
 *   dado para o lugar errado, que é o que acontece.
 * - Uma vez por carga, porque erro sorteado por quadro viraria tremor: a peça
 *   nunca convergiria e a condição de fogo dispararia por sorte. Fixo por tiro, o
 *   artilheiro *acredita* na pontaria dele, aponta com firmeza e erra com
 *   convicção — e dois tiros seguidos erram para o mesmo lado, como erra gente.
 */

import * as THREE from 'three';
import { clamp, gaussian } from '../core/MathUtils';
import { dragFactor, solveIntercept } from '../combat/Ballistics';
import { BALL_MASS, BALL_RADIUS, MUZZLE_SPEED, type AimAngles } from '../ship/Cannon';
import type { Ship } from '../ship/Ship';
import type { DifficultyPreset } from './Difficulty';

/** Fator de arrasto da bala. Constante — massa e raio não mudam em voo. */
const DRAG_K = dragFactor(BALL_MASS, BALL_RADIUS);

/**
 * Velocidade de pontaria da peça, em rad/s (~29°/s).
 *
 * Não é perícia, é ferro: uma carreta de meia tonelada é girada a espeque, e
 * varrer o batente inteiro (52°) leva perto de dois segundos. **Igual para os três
 * capitães**, de propósito — é isso que garante que um alvo cruzando de perto
 * escape da travessia mesmo da Lenda, e que aproximar-se demais seja tática e não
 * suicídio.
 */
const AIM_RATE = 0.5;

/**
 * Fração do tempo de reação do capitão que o servente gasta para largar o espeque,
 * buscar a bala no paiol ao pé da peça e encostá-la na boca.
 *
 * Sai de `reaction` em vez de ser número próprio porque é a mesma perícia medida de
 * outro ângulo: quem demora a perceber que a situação virou também demora a perceber
 * que a peça esvaziou. Dá 0,60 s ao Grumete, 0,28 s ao Corsário e 0,11 s à Lenda —
 * a mesma faixa em que um jogador nota o estrondo e leva o dedo à tecla de recarga.
 *
 * Metade, e não o valor cheio: reagir a um plano tático é decisão, e reagir à peça
 * vazia é reflexo. Cobrar o mesmo dos dois deixaria o Grumete com 1,2 s de pausa
 * antes de *começar* a carregar, o que na tela lê como travamento e não como um
 * marujo devagar.
 */
const SERVING_REACTION = 0.5;

/**
 * Meia-extensão em que o fogo é distribuído ao longo do alvo, em metros.
 *
 * **Este número já foi uma muleta, e não é mais.** Ele nasceu para compensar um
 * defeito do modelo de avaria: com a fusão de rombos a 90 cm e o teto de vazão fixo
 * por furo, tiro concentrado valia uma fração de tiro varrido, e um artilheiro
 * perfeito que sempre mirava no mesmo ponto causava **dez vezes menos dano** que um
 * mediano cujos erros espalhavam a salva. A IA ganhou a doutrina de varredura e
 * passou a jogar no lado bom daquela curva; o jogador, que não tinha como saber que
 * a curva existia, ficou no lado ruim.
 *
 * O defeito foi consertado onde ele morava — ver `MERGE_DISTANCE` e `MAX_JET_SPEED`
 * em `ShipDamage`. Hoje um acerto vale um acerto, caia onde cair, e este número
 * deixou de ser vantagem para ser o que sempre devia ter sido: **doutrina de
 * artilharia naval, e nada além disso.** Varre-se o costado do inimigo porque um
 * casco furado em cinco lugares afunda mais depressa que um furado em um só, e
 * porque a guarnição não sabe de antemão qual tábua vai ceder.
 *
 * ±3 m num casco de 16 m, e não mais ±5: sem a fusão larga para compensar, um
 * espalhamento largo demais só joga tiro na água a meio-navio de distância.
 */
const FIRE_SPREAD = 3;

/** O que o artilheiro está tentando acertar. */
export interface GunneryTarget {
  /** Centro do ponto de mira, no mundo. */
  readonly point: THREE.Vector3;
  /** Velocidade do alvo, no mundo. */
  readonly velocity: THREE.Vector3;
  /**
   * Direção da proa do alvo, no mundo. É o eixo ao longo do qual o fogo é
   * distribuído — varrer o costado só faz sentido no comprimento dele.
   */
  readonly forward: THREE.Vector3;
}

const _muzzle = new THREE.Vector3();
const _aim = new THREE.Vector3();
const _relative = new THREE.Vector3();
const _desiredWorld = new THREE.Vector3();
const _desiredLocal = new THREE.Vector3();

export class Gunner {
  /** Distância da boca ao alvo no último passo, em metros. */
  range = Infinity;
  /** `true` quando a peça consegue apontar no alvo dentro dos batentes. */
  bearing = false;
  /** Tiros que esta peça deu na partida. Telemetria. */
  shots = 0;

  private readonly angles: AimAngles = { traverse: 0, elevation: 0, bears: false };
  /** Desvio da carga atual, em radianos. Ver a nota sobre erro humano no topo. */
  private biasTraverse = 0;
  private biasElevation = 0;
  /** Onde no comprimento do alvo esta carga vai cair, em metros. Ver `FIRE_SPREAD`. */
  private spread = 0;
  /**
   * Segundos que o servente já gastou indo buscar a carga seguinte.
   *
   * Zera ao largar a peça: quem sai do posto no meio do gesto larga a bala onde
   * estava, e quem volta recomeça. Guardar o progresso daria ao inimigo uma
   * recarga adiantada de graça toda vez que ele atravessasse o convés.
   */
  private serving = 0;

  constructor(
    private readonly ship: Ship,
    /** Índice em `ship.cannons`. */
    private readonly index: number,
    private readonly preset: DifficultyPreset,
    private readonly random: () => number,
  ) {}

  /**
   * Um passo de artilharia.
   *
   * @param manned `false` quando o marujo está em outro posto. Peça sem gente não
   *   carrega, não aponta e não atira — fica onde foi deixada, e é por isso que a
   *   alocação de tripulação de `Crew` tem consequência tática.
   */
  fixedUpdate(dt: number, target: GunneryTarget | null, manned: boolean): void {
    const cannon = this.ship.cannons[this.index];
    if (!cannon) return;

    if (!manned || !target) {
      this.bearing = false;
      this.serving = 0;
      return;
    }

    // Serve a peça vazia: primeiro o tempo de largar o espeque e trazer a bala,
    // depois o comando de carga. `Cannon` ainda espera a carreta assentar antes de
    // deixar o soquete entrar — ver `beginLoad`. O desvio da próxima carga é
    // sorteado aqui: um tiro, um erro.
    if (cannon.state === 'empty') {
      this.serving += dt;
      if (
        this.serving >= this.preset.reaction * SERVING_REACTION &&
        this.ship.loadCannon(this.index)
      ) {
        this.serving = 0;
        this.biasTraverse = gaussian(this.random) * this.preset.aimSigma;
        this.biasElevation = gaussian(this.random) * this.preset.aimSigma;
        // Uniforme, e não gaussiano: varrer o costado é escolher um ponto novo de
        // propósito, e uma normal concentraria os tiros no meio-navio — justamente o
        // que este espalhamento existe para evitar.
        this.spread = (this.random() * 2 - 1) * FIRE_SPREAD;
      }
    } else {
      this.serving = 0;
    }

    // Ponto de mira desta carga: o centro do alvo deslocado ao longo da proa dele.
    _aim.copy(target.point).addScaledVector(target.forward, this.spread);

    cannon.getMuzzleLocal(_muzzle);
    this.ship.body.localToWorld(_muzzle, _muzzle);
    this.range = _muzzle.distanceTo(_aim);

    // Velocidade **relativa**, como `solveIntercept` pede: a bala já nasce com a
    // velocidade do navio que atira somada, então o que sobra a liderar é o
    // quanto o alvo se desloca em relação a nós. `leadFraction` é o quanto deste
    // raciocínio o capitão consegue fazer — abaixo de 1, ele atira atrás.
    _relative
      .subVectors(target.velocity, this.ship.body.velocity)
      .multiplyScalar(this.preset.leadFraction);

    const solution = solveIntercept(
      _muzzle,
      _aim,
      _relative,
      MUZZLE_SPEED,
      DRAG_K,
      this.preset.leadIterations,
    );

    if (!solution) {
      // Fora de alcance mesmo na elevação máxima: nada a apontar.
      this.bearing = false;
      return;
    }

    // Remonta a direção de mundo a partir dos dois ângulos da solução. O azimute
    // de `solveIntercept` é `atan2(x, z)`, então a horizontal dele é
    // `(sen, cos)` — convenção diferente da de `heading`, e trocar as duas aqui
    // espelha o tiro para o outro bordo.
    const cosElevation = Math.cos(solution.elevation);
    _desiredWorld.set(
      Math.sin(solution.azimuth) * cosElevation,
      Math.sin(solution.elevation),
      Math.cos(solution.azimuth) * cosElevation,
    );

    // E aqui a atitude do casco entra na conta, de graça.
    this.ship.body.worldDirToLocal(_desiredWorld, _desiredLocal);
    cannon.solveAim(_desiredLocal, this.angles);
    this.bearing = this.angles.bears;

    const wantTraverse = this.angles.traverse + this.biasTraverse;
    const wantElevation = this.angles.elevation + this.biasElevation;

    // **A peça só é apontada por quem está com as mãos livres.** Enquanto a carreta
    // corre de volta e a bala é socada, o servente acompanha o alvo com o olho e
    // não com o espeque; a peça fica onde o tiro anterior a deixou. É daqui que
    // sai o ritmo irregular do inimigo — e é daqui que sai o prêmio de manobrar
    // durante a recarga dele. Ver a nota no topo.
    if (!cannon.isLoaded) return;

    // Gira a peça no ritmo do ferro. `aim` já grampeia nos batentes, então pedir
    // além deles encosta a carreta no limite em vez de dar erro — que é o que uma
    // peça de verdade faz quando o alvo sai do setor.
    const step = AIM_RATE * dt;
    cannon.aim(
      clamp(wantTraverse - cannon.traverse, -step, step),
      clamp(wantElevation - cannon.elevation, -step, step),
    );

    // Disciplina de fogo: bala é finita, e tiro longe é bala no mar. É o único
    // lugar onde `engageRange` age, e é o que faz o Grumete deixar o jogador se
    // aproximar enquanto a Lenda já está atirando.
    if (this.range > this.preset.engageRange) return;
    if (!this.angles.bears) return;

    const tolerance = this.preset.fireTolerance;
    if (Math.abs(cannon.traverse - wantTraverse) > tolerance) return;
    if (Math.abs(cannon.elevation - wantElevation) > tolerance) return;

    cannon.triggerPull();
    this.shots++;
  }

  /** Zera a telemetria para uma partida nova. */
  reset(): void {
    this.range = Infinity;
    this.bearing = false;
    this.shots = 0;
    this.biasTraverse = 0;
    this.biasElevation = 0;
    this.serving = 0;
  }
}
