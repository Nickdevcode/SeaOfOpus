/**
 * A tripulação inimiga: dois homens, e por isso um problema de escolha.
 *
 * **A decisão de projeto mais importante da IA inteira mora aqui.** O caminho
 * fácil seria dar ao bot uma consciência única capaz de governar, apontar as duas
 * peças e pregar tábua ao mesmo tempo. Isso produz um inimigo que o jogador não
 * consegue combater: ele nunca para de atirar, nunca abaixa a guarda, e a única
 * coisa que o jogador aprende é que o jogo trapaceia.
 *
 * Então a Chalupa inimiga é tripulada como a Chalupa do Sea of Thieves é: **por
 * dois**. Um fica no timão do começo ao fim. O outro é um homem só, e um homem só
 * está em **um** lugar: no canhão de boreste, no de bombordo, ou no porão. Nunca em
 * dois. E ir de um para outro custa o tempo de atravessar o convés ou de descer a
 * escada.
 *
 * Três coisas boas caem disso, e nenhuma precisou ser programada como regra:
 *
 * - **O combate ganha respiro.** Quando o inimigo toma um rombo, o fogo dele para.
 *   O jogador *vê* isso acontecer e entende que acertou — sem número na tela.
 * - **Trocar de bordo tem preço.** Se o jogador cruza pela popa do inimigo e
 *   aparece do outro lado, o artilheiro tem de atravessar o convés, e há uma
 *   janela real de dois segundos em que só um dos navios atira.
 * - **A simetria fica honesta.** O jogador solo também não consegue mirar e
 *   bombear ao mesmo tempo. A diferença é que ele tem um timoneiro de graça — a
 *   roda fica onde foi deixada —, e o inimigo paga pelo dele com o segundo homem.
 *
 * A dificuldade não acrescenta gente. Ela muda a rapidez do marujo, o quanto de
 * água ele deixa entrar antes de largar a peça, quanto tempo de porão ele julga que
 * a briga permite e o quanto ele acerta na escolha do buraco — ver `Difficulty`.
 *
 * ## O porão tem dezesseis metros, e ele os anda
 *
 * A versão anterior deste arquivo tinha uma trapaça escondida em uma linha: o
 * marujo escolhia o rombo de maior vazão e **já começava a pregar**. Sem caminhar
 * até ele, sem procurar, sem largar a bomba. Medido contra oito rombos abertos na
 * linha d'água, o casco inteiro voltava a ser estanque em 25 s — e o jogador, que
 * precisa descer a escada, atravessar o porão agachado, achar o buraco no escuro e
 * mirar nele antes de segurar o botão, via aquilo e concluía com razão que não
 * havia como afundar aquele navio.
 *
 * Agora o marujo ocupa uma posição no porão e se desloca entre os serviços a
 * 1,15 m/s. Um rombo na proa custa oito segundos de caminhada antes da primeira
 * martelada, e voltar à bomba custa outros tantos. **A conta que decide o duelo
 * passou a ser a mesma dos dois lados: dá tempo de tapar aquele buraco antes que a
 * próxima salva chegue?**
 *
 * E ele erra o buraco. Ver `pickBreach`.
 */

import * as THREE from 'three';
import { HOLD_FLOOR_Y, STAIR_BOTTOM_Z } from '../ship/ShipDimensions';
import { BILGE_PUMP } from '../ship/ShipParts';
import type { Breach } from '../ship/ShipDamage';
import type { Ship } from '../ship/Ship';
import type { DifficultyPreset } from './Difficulty';

/** Onde o único par de mãos livres pode estar. */
export type CrewPost = 'starboard' | 'port' | 'hold';

/**
 * Segundos para atravessar o convés de um canhão ao outro.
 *
 * As peças ficam a ~4 m uma da outra, com o mastro e a escotilha no meio do
 * caminho: não se corta reto. 2,2 s é o desvio a passo apressado.
 */
const CROSS_DECK = 2.2;

/**
 * Segundos do convés ao porão, ou de volta.
 *
 * Andar até a escotilha e descer 1,85 m de escada a 1,9 m/s. É de propósito o
 * trânsito mais caro do navio: descer para tapar rombo é um compromisso, não uma
 * pausa.
 */
const DECK_TO_HOLD = 4.2;

/**
 * Velocidade de deslocamento **dentro** do porão, em m/s.
 *
 * Bem abaixo do passo de convés (2,8 m/s) e não por perícia: o pé-direito ali é de
 * 1,85 m, o piso tem cavername atravessado, e quem se move carrega uma tábua de
 * 1,15 m debaixo do braço com água pela canela. 1,15 m/s é o passo curto de quem
 * anda curvado — atravessar os 16 m do casco custa catorze segundos.
 */
const HOLD_WALK_SPEED = 1.15;

/**
 * Onde ele põe o pé ao descer — e onde estão as tábuas.
 *
 * As duas coisas no mesmo ponto não é economia de constante: a madeira de reparo
 * desce pela escotilha e fica empilhada ao pé do lance, que é o único lugar do
 * porão onde ela cabe sem atravancar o corredor. É de lá que sai cada tábua, e é
 * por isso que ele volta aqui entre um rombo e o seguinte — ver `goToBreach`.
 */
const HOLD_LANDING = new THREE.Vector3(0, HOLD_FLOOR_Y, STAIR_BOTTOM_Z);

/** A alavanca da bomba, que também é um lugar a que se vai. */
const PUMP_STATION = new THREE.Vector3(BILGE_PUMP.x, HOLD_FLOOR_Y, BILGE_PUMP.z);

/**
 * Peso mínimo de um rombo que ainda não está bebendo, na triagem.
 *
 * Um furo acima da linha d'água não esguicha, e é justamente por isso que ele entra
 * no sorteio: o marujo apressado o vê como buraco no casco e prega a tábua ali,
 * gastando cinco segundos numa avaria que não estava afundando ninguém. Zerar o
 * peso faria a IA acertar sempre — e acertar sempre é o defeito que esta função
 * veio consertar.
 */
const DRY_BREACH_WEIGHT = 0.15;

export class Crew {
  /** Onde o marujo está (ou para onde está indo, se `transit > 0`). */
  post: CrewPost = 'starboard';

  /** Segundos que faltam para ele chegar. Zero é "trabalhando". */
  transit = 0;

  /**
   * Rombo a que ele foi destacado, ou `null`.
   *
   * Não quer dizer que a tábua já esteja na madeira: enquanto `reaching` for maior
   * que zero ele ainda está atravessando o porão para chegar lá.
   */
  patching: Breach | null = null;

  /** `true` no passo em que ele está de fato na bomba. */
  pumping = false;

  /**
   * Onde ele está no porão, em coordenadas locais do navio.
   *
   * Só tem sentido enquanto o posto é `hold`; ao descer, ele reaparece no pé do
   * lance. É a partir daqui que sai o tempo de caminhada de cada serviço.
   */
  private readonly spot = new THREE.Vector3().copy(HOLD_LANDING);
  /** Serviço para onde ele está indo, enquanto `walk > 0`. */
  private readonly destination = new THREE.Vector3().copy(HOLD_LANDING);
  /** Segundos que faltam para ele chegar ao serviço escolhido. */
  private walk = 0;
  /** `true` quando o serviço escolhido é a bomba, e não um rombo. */
  private onPump = false;

  constructor(
    private readonly preset: DifficultyPreset,
    /**
     * Sorteio da triagem de rombos. Vem de fora, e da mesma semente da partida,
     * para um duelo continuar reproduzível de ponta a ponta — ver `ShipAI`.
     */
    private readonly random: () => number,
  ) {}

  /** `true` quando ele chegou no posto e está produzindo trabalho. */
  get onStation(): boolean {
    return this.transit <= 0;
  }

  /**
   * Segundos que faltam para ele chegar ao serviço **dentro** do porão. Telemetria.
   *
   * Diferente de `transit`, que é o tempo de ir de um posto a outro: este é o
   * caminho até a tábua e até o buraco, e é ele que faz o reparo do inimigo custar
   * o mesmo tipo de tempo que custa ao jogador.
   */
  get reaching(): number {
    return Math.max(this.walk, 0);
  }

  /**
   * Manda o marujo para um posto. Repetir a ordem do posto atual não faz nada —
   * senão ele reiniciaria a caminhada a cada passo de física e nunca chegaria.
   */
  orderTo(post: CrewPost): void {
    if (post === this.post) return;

    const below = post === 'hold' || this.post === 'hold';
    this.transit = (below ? DECK_TO_HOLD : CROSS_DECK) * this.preset.transitScale;
    this.post = post;
    // Largou a tábua no meio do reparo: o progresso do rombo fica onde estava
    // (é estado do rombo, não do marujo), mas ele perde a mira nele.
    this.patching = null;
    this.onPump = false;

    // Quem desce reaparece no pé do lance, e o serviço do turno passado não conta:
    // guardar a posição entre descidas daria ao inimigo um marujo que se
    // teletransporta para onde parou, que é justamente o que este arquivo deixou
    // de fazer.
    if (post === 'hold') {
      this.spot.copy(HOLD_LANDING);
      this.destination.copy(HOLD_LANDING);
      this.walk = 0;
    }
  }

  /** Índice em `ship.cannons` do posto atual, ou −1 se ele está no porão. */
  get cannonIndex(): number {
    if (!this.onStation) return -1;
    // `[0]` é boreste e `[1]` bombordo — a ordem que `ShipBuilder` monta.
    if (this.post === 'starboard') return 0;
    if (this.post === 'port') return 1;
    return -1;
  }

  /**
   * Um passo de trabalho. Só faz algo quando o posto é o porão: no canhão, quem
   * trabalha é o `Gunner`.
   */
  fixedUpdate(dt: number, ship: Ship): void {
    this.pumping = false;

    if (this.transit > 0) {
      this.transit -= dt;
      this.patching = null;
      return;
    }

    if (this.post !== 'hold') {
      this.patching = null;
      this.onPump = false;
      return;
    }

    this.chooseWork(ship);

    // Ainda atravessando o porão até o serviço escolhido: caminhar é trabalho, mas
    // não é trabalho que feche buraco nenhum.
    if (this.walk > 0) {
      this.walk -= dt;
      if (this.walk > 0) return;
      this.spot.copy(this.destination);
    }

    if (this.patching) {
      // Uma tábua por vez, no rombo que ele escolheu ao chegar aqui.
      if (ship.patchBreach(this.patching, dt)) this.patching = null;
      return;
    }

    // Casco fechado e ainda há água acima do que ele tolera: agora a bomba resolve.
    // A ordem não é gosto, é conta: tapar um rombo custa 2,4 s e vale para sempre,
    // enquanto bombear com furo aberto é trabalho que a água desfaz atrás — e a
    // partir de seis furos submersos a entrada supera a vazão da bomba e o porão
    // sobe enquanto se bombeia. Ver `PUMP_RATE` e `MAX_JET_SPEED` em `ShipDamage`.
    //
    // **O piso é o que faz o estrago acumular.** Ele larga a alavanca no nível que
    // o capitão dele aceita levar de volta para o combate, e não com o porão
    // enxuto: um navio que seca por completo entre duas salvas desfaz sozinho tudo
    // que o jogador conseguiu pôr dentro dele. Ver `bilgeFloor` em `Difficulty`.
    if (ship.damage.floodFraction > this.preset.bilgeFloor) {
      ship.controls.pumping = true;
      this.pumping = true;
    }
  }

  /** Volta ao posto inicial para uma partida nova. */
  reset(): void {
    this.post = 'starboard';
    this.transit = 0;
    this.patching = null;
    this.pumping = false;
    this.onPump = false;
    this.walk = 0;
    this.spot.copy(HOLD_LANDING);
    this.destination.copy(HOLD_LANDING);
  }

  /**
   * Decide o próximo serviço — e, quase sempre, decide **não decidir nada**.
   *
   * A guarda de "só reavalia quando o serviço anterior acabou" é o que sustenta a
   * triagem aleatória de `pickBreach`. Sorteando a cada passo de física, o marujo
   * escolheria um rombo diferente sessenta vezes por segundo e passaria a partida
   * inteira andando de um lado para o outro do porão sem pregar uma tábua — o
   * sorteio precisa acontecer uma vez por serviço, como acontece uma decisão.
   *
   * As três portas de reavaliação são: o rombo alvo saiu da lista (fechou, ou uma
   * bala nova o transformou noutra coisa), ele está na bomba e apareceu buraco novo
   * para tapar, ou não há serviço nenhum em andamento.
   */
  private chooseWork(ship: Ship): void {
    if (this.patching) {
      if (ship.damage.breaches.includes(this.patching)) return;
      this.patching = null;
    } else if (this.onPump) {
      // Bombear com o casco aberto é trabalho que a água desfaz atrás; buraco novo
      // ganha da alavanca. Sem tábua no paiol, porém, a bomba é a única coisa que
      // ainda funciona — e insistir no rombo deixaria o inimigo parado na frente
      // de um buraco, afundando sozinho.
      if (!ship.hasPlanks || ship.damage.breaches.length === 0) return;
      this.onPump = false;
    }

    const breach = ship.hasPlanks ? this.pickBreach(ship) : null;
    this.patching = breach;
    this.onPump = breach === null;

    if (breach) this.goToBreach(breach);
    else this.goTo(PUMP_STATION);
  }

  /**
   * Manda o marujo tapar um rombo — **passando pelo paiol para pegar a tábua**.
   *
   * É uma tábua por vez, e elas estão empilhadas ao pé do lance (`HOLD_LANDING`).
   * Um homem curvado num porão de 1,85 m não carrega quatro peças de 1,15 m
   * debaixo do braço, então cada buraco custa a ida à pilha mais a ida ao buraco —
   * e a volta é a ida do rombo seguinte, que é por isso que este método não a
   * cobra duas vezes.
   *
   * **É o custo que fez a conta virar.** Sem ele, o marujo fechava cinco rombos por
   * minuto e nenhuma taxa de acerto plausível do jogador conseguia ultrapassá-lo: o
   * casco inimigo se recuperava sozinho de qualquer estrago que não fosse
   * instantâneo. Com a ida ao paiol, cada rombo custa perto de nove segundos, e a
   * balança passou a pender para quem está acertando.
   */
  private goToBreach(breach: Breach): void {
    const toLocker = planarDistance(this.spot, HOLD_LANDING);
    const toBreach = planarDistance(HOLD_LANDING, breach.local);
    this.destination.copy(breach.local);
    this.walk = (toLocker + toBreach) / HOLD_WALK_SPEED;
  }

  /** Manda o marujo a um ponto do porão e cobra o tempo de chegar lá. */
  private goTo(target: THREE.Vector3): void {
    this.destination.copy(target);
    this.walk = planarDistance(this.spot, target) / HOLD_WALK_SPEED;
  }

  /**
   * O rombo que ganha a tábua — e ele **não** é sempre o certo.
   *
   * A versão anterior devolvia o de maior vazão, sempre, com desempate pelo mais
   * fundo. É a escolha ótima, e é exatamente por isso que estava errada: nenhum
   * marujo tem um relatório de vazão por furo. O que ele tem é um porão escuro,
   * água até o joelho e vários buracos esguichando ao mesmo tempo — ele vai no que
   * chama mais a atenção, e às vezes esse não é o que mais está afundando o navio.
   *
   * O sorteio é ponderado pela vazão, e o expoente é a perícia (`triage`):
   *
   * | capitão  | triage | rombo afogado vs. rombo seco |
   * |----------|--------|------------------------------|
   * | grumete  | 0,6    | 3× mais provável             |
   * | corsário | 2,0    | 59× mais provável            |
   * | lenda    | 5,0    | 26 000× — quase sempre o pior|
   *
   * Ou seja: a Lenda continua acertando a triagem quase todas as vezes, e é isso
   * que mantém a esperteza dela intacta. O Grumete gasta tábua em buraco de amurada
   * com frequência, que é como se perde uma chalupa de verdade.
   */
  private pickBreach(ship: Ship): Breach | null {
    const breaches = ship.damage.breaches;
    if (breaches.length === 0) return null;

    // A escala é o pior esguicho da sala, e não um teto absoluto. Um homem no porão
    // não mede litros por segundo: ele compara os buracos que está vendo, e o que
    // decide é qual grita mais alto entre eles.
    let strongest = 0;
    for (const breach of breaches) strongest = Math.max(strongest, breach.inflow);

    let total = 0;
    for (const breach of breaches) total += this.attention(breach, strongest);
    if (total <= 0) return breaches[0] ?? null;

    // Roleta: um sorteio no total e uma varredura acumulando até passar dele.
    let ticket = this.random() * total;
    for (const breach of breaches) {
      ticket -= this.attention(breach, strongest);
      if (ticket <= 0) return breach;
    }

    // Só chega aqui por arredondamento no último rombo da lista.
    return breaches[breaches.length - 1] ?? null;
  }

  /**
   * O quanto um rombo chama a atenção de quem está no porão.
   *
   * @param strongest a maior vazão entre os rombos abertos, que é a escala. Com o
   *   porão seco ela é zero e todos os buracos ficam com o mesmo peso — que é o
   *   certo: sem esguicho nenhum para comparar, um furo é tão visível quanto outro.
   */
  private attention(breach: Breach, strongest: number): number {
    const jet = strongest > 1e-9 ? breach.inflow / strongest : 0;
    return Math.pow(jet + DRY_BREACH_WEIGHT, this.preset.triage);
  }
}

/**
 * Distância entre dois pontos do porão medida **no assoalho**.
 *
 * A vertical fica de fora de propósito: o rombo pode estar rente à quilha ou no alto
 * do costado, e a diferença entre agachar e esticar o braço não é o que custa tempo
 * a quem atravessa um porão de dezesseis metros.
 */
function planarDistance(a: THREE.Vector3, b: THREE.Vector3): number {
  return Math.hypot(b.x - a.x, b.z - a.z);
}
