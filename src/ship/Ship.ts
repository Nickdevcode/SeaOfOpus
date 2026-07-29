/**
 * A Chalupa completa: o modelo 3D, o corpo rígido e todos os subsistemas.
 *
 * Esta classe não faz física nenhuma — ela **compõe**. Cada subsistema sabe
 * aplicar uma família de forças ao corpo e mais nada, e aqui só se define a
 * ordem em que eles falam. Quem quiser um navio inimigo instancia outro `Ship`;
 * quem quiser trocar o modelo de vela troca `SailSim` sem tocar no resto.
 *
 * A separação entre `fixedUpdate` e `syncModel` é a que importa: a física roda a
 * 60 Hz cravados e o desenho roda na taxa do monitor, então o `alpha` do
 * `Engine` interpola entre o passo anterior e o atual. Sem isso o navio treme
 * visivelmente em telas de 144 Hz, e nenhuma quantidade de suavização de câmera
 * esconde isso.
 */

import * as THREE from 'three';
import { GRAVITY, msToKnots } from '../core/MathUtils';
import { Anchor } from './Anchor';
import { Buoyancy } from './Buoyancy';
import { Cannon, type FireSolution } from './Cannon';
import { EnsignSim } from './EnsignSim';
import { HullDrag } from './HullDrag';
import { MAX_WHEEL, Rudder } from './Rudder';
import { SailSim } from './SailSim';
import { ShipBody } from './ShipBody';
import { ShipDamage, type Breach } from './ShipDamage';
import { createShip, type ShipAssets, type ShipModel, type ShipOptions } from './ShipBuilder';
import type { WaveField } from '../world/WaveField';

/**
 * Centro de massa, em coordenadas locais. **Os dois valores são medidos, não
 * escolhidos** — ver a bancada `__game` em `main.ts`.
 *
 * O `z` iguala o centro de carena deste casco (+0,91 m, medido pelo torque que a
 * flutuabilidade produz com o navio a direito). É o que um construtor faz de
 * verdade ao distribuir o lastro: casar o centro de gravidade com o de carena
 * para o navio flutuar sem cair de proa nem de popa.
 *
 * O `y` é a altura, e é ela que decide se o navio é rijo ou tenro. Com o centro
 * de massa na linha d'água este casco dá GM ≈ 0,54 m, tenro demais — jogaria com
 * um período de 5,3 s, lento e enjoativo. Descendo o lastro para −0,55 m o GM
 * sobe para ~0,89 m e o período cai para ~4,2 s, que é o balanço curto e vivo de
 * um barco de 16 m.
 */
const CENTER_OF_MASS = new THREE.Vector3(0, -0.55, 0.91);

/**
 * Balas que o paiol carrega no começo da partida.
 *
 * **160, e o número existe para nunca ser alcançado num duelo honesto.** Esta é a
 * terceira afinação deste campo, e as duas primeiras erraram pelo mesmo motivo:
 * tratavam o paiol como uma peça de balanceamento. Ele não é. Um duelo tem de ser
 * decidido por quem manobra e mira melhor — se ele termina porque um dos dois ficou
 * sem bala, o que a partida mediu foi a contabilidade do paiol, e não a briga.
 *
 * Em 40, o capitão Lenda gastava tudo num alvo parado e o deixava em 59% de porão.
 * Em 80, ele afundava aquele alvo — mas com o serviço da peça passando a custar
 * 2,4 s por tiro (ver `Cannon.beginLoad` e `Gunner`), 80 voltaram a ser pouco: a
 * telemetria mostra o paiol zerando aos 240 s com o alvo em 74%. O limite estava
 * decidindo a partida de novo, e da pior forma — pelo relógio.
 *
 * 160 dão à Lenda perto de sete minutos de fogo ininterrupto, e um duelo não é
 * ininterrupto: ela passa boa parte dele fechando distância, reparando ou rompendo
 * contato. Ao jogador, que atira num ritmo bem mais folgado, dão um quarto de hora.
 *
 * **O teto continua existindo, e continua tendo função.** Tiro a esmo a 150 m custa
 * bala, e o paiol é a única coisa que cobra por isso. O que ele deixou de ser é o
 * que termina o combate — que é o que se quer também para o duelo online, onde dois
 * jogadores humanos consomem munição bem mais devagar que um bot.
 */
export const MAGAZINE_SIZE = 160;

/**
 * Tábuas que o paiol carrega no começo da partida.
 *
 * **48, e o número sai do paiol do outro lado.** É a mesma ideia das balas — um
 * recurso finito que faz tiro a esmo e reparo a esmo custarem alguma coisa —, só
 * que a conta de quantas tem de ser feita contra o que o inimigo consegue abrir,
 * e não copiada de lá.
 *
 * As 160 balas do inimigo compram cerca de 40 rombos (nem toda bala acerta, e as
 * que batem acima da linha d'água não alagam). Um tiro novo em cima de uma tábua
 * **arranca a tábua** e devolve o rombo, então alguns pontos do casco são pagos
 * duas vezes. Quarenta e oito cobre os rombos do caso normal e ainda sobra para
 * uma dúzia de remendos arrancados — o suficiente para nunca perder um duelo por
 * contabilidade, e pouco o bastante para tapar rombo de amurada que não alaga
 * deixar de ser de graça.
 *
 * O mesmo valor das balas foi considerado e não serve: com 160 tábuas o paiol
 * nunca esvazia, o contador não morde nunca, e a única coisa que a feature entrega
 * é um número na tela. Um limite que não limita é pior que limite nenhum, porque
 * custa a atenção do jogador sem cobrar nada dele.
 */
export const PLANK_LOCKER_SIZE = 48;

/**
 * Raios de giração, em metros.
 *
 * Caturro e guinada usam 0,26 do comprimento e balanço 0,39 da boca — as regras
 * de bolso de arquitetura naval. O balanço pequeno é o que faz a chalupa rolar
 * rápido e curto nas ondas em vez de gingar como um navio grande.
 */
const GYRATION = new THREE.Vector3(4.16, 4.16, 1.95);

/**
 * Massa adicionada por eixo local.
 *
 * Deriva e arfagem empurram uma parede de água à frente e quase dobram a massa
 * efetiva; avanço mal chega a 5% porque o casco é afilado justamente nessa
 * direção. Ver a explicação longa em `ShipBody`.
 */
const ADDED_MASS = new THREE.Vector3(1.9, 2.0, 1.06);

/** O que pilota o navio. O jogador e a IA preenchem a mesma estrutura. */
export interface ShipControls {
  /** Taxa de giro do timão: -1 todo a bombordo, +1 todo a boreste. */
  wheel: number;
  /**
   * Voltas de barra empurradas no cabrestante neste passo, em fração de volta.
   *
   * Número, e não bandeira, porque suspender o ferro deixou de ser um botão
   * segurado: quem recolhe **anda** em volta do cabrestante, e o que chega aqui
   * é o quanto ele andou. Ver `Anchor.heave`.
   */
  capstanTurns: number;
  /** `true` enquanto alguém estiver na alavanca da bomba de porão. */
  pumping: boolean;
}

const _origin = new THREE.Vector3();
const _rotation = new THREE.Quaternion();
const _localVelocity = new THREE.Vector3();
const _euler = new THREE.Euler();
const UP = new THREE.Vector3(0, 1, 0);

export class Ship {
  /** Nome do navio. É o mesmo `owner` que os tiros dele carregam. */
  readonly name: string;
  readonly model: ShipModel;
  readonly body: ShipBody;
  readonly buoyancy: Buoyancy;
  readonly hullDrag: HullDrag;
  readonly rudder: Rudder;
  readonly sail: SailSim;
  /** A bandeira do tope. Não faz força — é leitura de vento para quem olha. */
  readonly ensign: EnsignSim;
  readonly anchor: Anchor;
  readonly damage: ShipDamage;
  /** `[0]` boreste, `[1]` bombordo — a mesma ordem do modelo. */
  readonly cannons: readonly Cannon[];

  readonly controls: ShipControls = { wheel: 0, capstanTurns: 0, pumping: false };

  /**
   * Balas no paiol. Carregar um canhão consome uma.
   *
   * Não reabastece: o que o navio leva é a partida inteira, e é o que impede os
   * dois lados de resolverem o duelo por volume de fogo. Com os ~2,4 s que o
   * serviço completo de uma peça custa, dá para mais de seis minutos de fogo
   * ininterrupto — folga suficiente para nunca ser o que decide, e teto suficiente
   * para tiro a esmo custar. Ver `MAGAZINE_SIZE`.
   */
  cannonballs = MAGAZINE_SIZE;

  /**
   * Tábuas no paiol. Fechar um rombo consome uma.
   *
   * Como as balas, não reabastece: o que o navio leva é o que ele tem para a
   * partida inteira. É o que dá peso à escolha de **qual** rombo tapar quando o
   * casco está furado em cinco lugares e três deles estão acima da linha d'água.
   */
  planks = PLANK_LOCKER_SIZE;

  /**
   * Tiros disparados neste passo, à espera de quem os transforme em projétil.
   * Quem consome esvazia a fila — o navio não guarda histórico.
   */
  readonly pendingShots: FireSolution[] = [];

  /** Fração do volume de projeto submersa. 1 é o calado desenhado. */
  submersion = 1;

  /** Peso, constante. Guardado pronto para não recalcular 60 vezes por segundo. */
  private readonly weight = new THREE.Vector3();

  constructor(assets: ShipAssets, name = 'ship', options: ShipOptions = {}) {
    this.name = name;
    this.model = createShip(assets, name, options);

    this.buoyancy = new Buoyancy();
    this.body = new ShipBody({
      // A massa vem da mesma tabela que gera o empuxo — ver `getDesignMass`.
      mass: this.buoyancy.getDesignMass(),
      centerOfMass: CENTER_OF_MASS,
      gyration: GYRATION,
      addedMass: ADDED_MASS,
    });

    this.hullDrag = new HullDrag();
    this.rudder = new Rudder();
    this.sail = new SailSim(this.model.sail);
    this.ensign = new EnsignSim(this.model.ensign);
    this.anchor = new Anchor(this.model);
    this.damage = new ShipDamage();
    this.cannons = this.model.cannons.map((assembly) => new Cannon(assembly, name));

    this.weight.set(0, -this.body.mass * GRAVITY, 0);
  }

  /**
   * Manda socar uma bala neste canhão. Devolve `false` se o paiol estiver vazio
   * ou se a peça já tiver carga — quem chama usa isso para o retorno sonoro.
   */
  loadCannon(index: number): boolean {
    const cannon = this.cannons[index];
    if (!cannon || this.cannonballs <= 0) return false;
    if (!cannon.beginLoad()) return false;
    this.cannonballs--;
    return true;
  }

  /** `true` enquanto ainda houver tábua no paiol para pregar. */
  get hasPlanks(): boolean {
    return this.planks > 0;
  }

  /**
   * Prega tábua num rombo por `dt` segundos. Devolve `true` **no quadro em que o
   * rombo fecha**, que é quando a tábua sai do paiol.
   *
   * O consumo acontece no fim, e não no começo, por dois motivos. O justo: quem
   * solta o botão no meio do trabalho não perde a peça, e o progresso parcial que
   * `ShipDamage` guarda continua valendo para a próxima tentativa. O prático: o
   * reparo é interrompido o tempo todo — pela onda, pelo tiro que chega, pela
   * bomba que precisa de alguém —, e cobrar adiantado transformaria cada
   * interrupção numa multa.
   *
   * Existe aqui, e não em `ShipDamage`, porque o paiol é do navio e não do
   * estrago: `ShipDamage` responde por rombos, alagamento e vazão, e não tem por
   * que saber de logística. É o mesmo desenho de `loadCannon` — o subsistema faz
   * o trabalho, o navio decide se há material para ele.
   */
  patchBreach(breach: Breach, dt: number): boolean {
    if (!this.hasPlanks) return false;
    if (!this.damage.repair(breach, dt)) return false;
    this.planks--;
    return true;
  }

  /** Velocidade sobre o fundo, em nós. */
  get knots(): number {
    return msToKnots(this.body.velocity.length());
  }

  /** Avanço no referencial do navio, em m/s. Negativo é dar de ré. */
  get surge(): number {
    this.body.worldDirToLocal(this.body.velocity, _localVelocity);
    return -_localVelocity.z;
  }

  /** Rumo em radianos, 0 = -Z do mundo. É para onde a proa aponta. */
  get heading(): number {
    _euler.setFromQuaternion(this.body.orientation, 'YXZ');
    return _euler.y;
  }

  /** Posição da roda do timão, -1 a +1. O HUD desenha a partir disto. */
  get wheelPosition(): number {
    return this.rudder.wheelAngle / MAX_WHEEL;
  }

  /**
   * Põe o navio n'água. `heading` em radianos, medido como `Ship.heading`.
   *
   * A altura vem da própria onda naquele ponto, e não de `y = 0`: nascer no
   * calado certo mas dentro de uma cava faria o navio quicar no primeiro passo.
   */
  spawn(x: number, z: number, heading: number, waves: WaveField): void {
    this.body.velocity.set(0, 0, 0);
    this.body.angularVelocity.set(0, 0, 0);
    this.body.orientation.setFromAxisAngle(UP, heading);
    this.body.previousOrientation.copy(this.body.orientation);
    this.body.setOrigin(x, waves.sampleHeight(x, z), z);

    this.rudder.center();
    this.anchor.reset();
    this.sail.reset();
    this.ensign.reset();
    this.damage.reset();
    this.body.floodedMass = 0;
    this.submersion = 1;
    this.cannonballs = MAGAZINE_SIZE;
    this.planks = PLANK_LOCKER_SIZE;
    for (const cannon of this.cannons) cannon.reset();
    this.pendingShots.length = 0;
    this.controls.wheel = 0;
    this.controls.capstanTurns = 0;
    this.controls.pumping = false;

    this.syncModel(1);
  }

  /**
   * Um passo de física. A ordem é deliberada: primeiro os comandos, depois as
   * forças (que só acumulam), e a integração por último — assim tudo que age
   * neste passo enxerga exatamente o mesmo estado, sem um subsistema colher a
   * velocidade que o anterior acabou de mudar.
   */
  /**
   * Guarda a pose das peças móveis antes que alguém as mexa neste passo.
   *
   * Roda no topo de `Match.fixedUpdate`, **antes** dos marujos, porque é o marujo
   * (ou o artilheiro da máquina) quem mira e quem gira a roda — deixar a captura
   * para `fixedUpdate` daria uma pose "anterior" já alterada. Ver `Cannon.beginStep`.
   */
  beginStep(): void {
    this.rudder.beginStep();
    for (const cannon of this.cannons) cannon.beginStep();
  }

  fixedUpdate(dt: number, waves: WaveField): void {
    this.rudder.update(this.controls.wheel, dt);
    if (this.controls.capstanTurns > 0) this.anchor.heave(this.controls.capstanTurns);

    // Gravidade primeiro, para o empuxo ter contra o que trabalhar.
    this.body.applyForce(this.weight);

    const report = this.buoyancy.apply(this.body, waves);
    this.submersion = report.submersion;

    this.hullDrag.apply(this.body, this.submersion);
    this.rudder.apply(this.body, this.submersion);
    this.sail.update(dt, this.body, waves);
    // Depois da vela, e lendo o vento que ela acabou de medir: a bandeira não
    // faz força nenhuma, mas tem de contar a mesma história sobre o vento.
    this.ensign.update(dt, this.sail.localWind);
    this.anchor.fixedUpdate(dt, this.body);
    // O comando é por *quadro* e o alagamento roda por *passo*: repassar aqui é
    // o que garante que a bomba tire o mesmo tanto de água a 30 ou a 144 fps.
    this.damage.pumping = this.controls.pumping;
    this.damage.fixedUpdate(dt, this.body, waves);

    // Os canhões entram antes da integração porque o recuo é força como
    // qualquer outra: quem dispara neste passo empurra o casco neste passo.
    for (const cannon of this.cannons) {
      const shot = cannon.fixedUpdate(dt, this.body);
      if (shot) this.pendingShots.push(shot);
    }

    this.body.integrate(dt);
  }

  /** Escreve a pose interpolada e a das peças móveis no modelo 3D. */
  syncModel(alpha: number): void {
    this.body.sampleOrigin(alpha, _origin, _rotation);
    this.model.root.position.copy(_origin);
    this.model.root.quaternion.copy(_rotation);

    // A roda gira no próprio Z; o sinal negativo é o que faz "virar para a
    // direita" ser sentido horário na visão de quem está ao leme.
    const { previousWheelAngle, wheelAngle, previousRudderAngle, rudderAngle } = this.rudder;
    this.model.wheel.rotation.z =
      -(previousWheelAngle + (wheelAngle - previousWheelAngle) * alpha);
    // A pá acompanha o leme direto: bordo de fuga a boreste desvia água para
    // boreste, empurra a popa para bombordo e a proa vai para boreste. Estava
    // negativo aqui, o que desenhava a pá apontando para o lado oposto ao da
    // curva — errado no olho de quem sabe olhar, e invisível no de quem não.
    this.model.rudder.rotation.y =
      previousRudderAngle + (rudderAngle - previousRudderAngle) * alpha;

    for (const cannon of this.cannons) cannon.syncModel(alpha);
    this.anchor.syncModel(this.model, this.body);
  }

  dispose(): void {
    this.model.dispose();
  }
}
