/**
 * Âncora e cabrestante.
 *
 * Não existe fundo do mar neste jogo — o combate acontece em mar aberto — então
 * "fundear" aqui significa **fixar um ponto no mundo** e amarrar a proa a ele por
 * uma amarra elástica. É a mesma abstração do Sea of Thieves, onde a âncora morde
 * em qualquer lugar, e é o que permite a manobra que interessa.
 *
 * O comportamento que vale a implementação inteira é o **anchor turn**: com a
 * amarra tesa puxando pelo escovém, o navio deixa de girar em torno do próprio
 * centro e passa a girar em torno da proa. O raio despenca e a chalupa vira quase
 * no lugar — a manobra clássica de PvP do jogo. Repare que não há uma linha de
 * código para isso: ele cai do braço entre o escovém e o centro de massa.
 *
 * ## As duas metades da manobra não se parecem, e é de propósito
 *
 * **Largar é um gesto.** Solta-se o ferrolho, a amarra corre sozinha e o
 * cabrestante roda livre até a âncora bater no fundo. Um toque, e o resto é a
 * gravidade trabalhando — quem larga o ferro não faz mais nada.
 *
 * **Recolher é trabalho.** Não há botão que suspenda o ferro: é preciso assumir
 * o cabrestante e **caminhar em volta dele**, empurrando as barras para vante,
 * volta após volta. O cabrestante gira o tanto que o marujo andou, nem um grau a
 * mais, e parar de andar é parar de recolher. É por isso que a âncora decide
 * combates no Sea of Thieves: largar custa meio segundo e desfazer custa onze.
 *
 * Ver `PlayerController.pushCapstan`, que é onde o andar vira volta de barra.
 */

import * as THREE from 'three';
import { TAU } from '../core/MathUtils';
import type { ShipBody } from './ShipBody';
import type { ShipModel } from './ShipBuilder';

export type AnchorState = 'stowed' | 'dropping' | 'set' | 'raising';

/** Profundidade em que a âncora crava, abaixo da linha d'água de projeto. */
const SEABED_DEPTH = 11;
/**
 * Comprimento da amarra.
 *
 * Um pouco maior que a profundidade, e não muito: a folga vira o raio de deriva
 * livre antes de a amarra tesar (aqui ~2,3 m). Folga demais e a âncora vira um
 * freio preguiçoso em vez de um pivô.
 */
const CHAIN_LENGTH = 11.7;

/** Rigidez da amarra, em N/m. */
const CHAIN_STIFFNESS = 165_000;
/**
 * Amortecimento da amarra, em N·s/m.
 *
 * Alto o bastante para o navio **parar**, e não para quicar. Com 60 000 a
 * chalupa esticava a amarra, era arremessada de volta e passava vários segundos
 * pendulando em torno do ferro — o que se via era um barco de borracha. Em
 * 130 000 o sistema fica levemente subamortecido: sobra um caldo só, a proa cai
 * para o ferro e ele assenta. É o que se vê quando um barco de verdade fundeia.
 */
const CHAIN_DAMPING = 130_000;
/** Teto de tração. Existe só para um passo ruim não virar catapulta. */
const MAX_TENSION = 420_000;

/**
 * Arrasto do ferro arrastando no fundo, em N·s/m.
 *
 * Age enquanto a âncora está no fundo e o navio ainda tem seguimento, **antes**
 * de a amarra tesar. Sem ele o navio corre os dois metros de folga na velocidade
 * cheia e só descobre que fundeou quando a corrente estica de uma vez — um
 * solavanco seco que lê como bug. Com ele, largar o ferro em movimento freia o
 * navio progressivamente, que é o que a unha mordendo o fundo realmente faz.
 */
const DRAG_COEFFICIENT = 9_000;

/** Fração da amarra que sai por segundo ao largar. */
const DROP_RATE = 1.6;

/**
 * Quanto tempo o cabrestante segura sozinho depois que o marujo para de andar.
 *
 * Não é zero, e não é infinito, e as duas pontas seriam erradas. Zero puniria a
 * passada trocada: um quadro de titubeio no meio da volta jogaria a âncora
 * inteira de volta ao fundo. Infinito — que era o comportamento anterior —
 * transformava suspender o ferro numa tarefa que se faz em parcelas, e tira do
 * fundeio justamente o que ele tem de tático: **largar é barato e desfazer é
 * caro, e caro sem interrupção**. Nove décimos é o tempo de contornar a barra e
 * pegar a seguinte — subiu junto com o passo mais pesado do marujo, senão a
 * própria travessia entre duas barras já contaria como ter largado o serviço.
 */
const CAPSTAN_GRACE = 0.9;
/**
 * Fração da amarra que corre de volta por segundo quando o marujo larga.
 *
 * Mais lenta que a queda livre do `DROP_RATE` de propósito: o linguete não
 * soltou, o que cede é o homem. Dá tempo de voltar à barra e retomar — o que se
 * perde é o trabalho, não a partida.
 *
 * Caiu de 0,85 quando a volta ficou mais lenta, e é uma conta de proporção: com
 * o serviço a onze segundos, uma taxa que devolvia a amarra inteira em pouco
 * mais de um segundo transformava qualquer titubeio em recomeço do zero. A 0,45
 * são 2,2 s do topo ao fundo — punição sentida, e ainda assim recuperável para
 * quem voltar à barra.
 */
const RUNBACK_RATE = 0.45;
/**
 * Voltas que o cabrestante dá para recolher a amarra inteira.
 *
 * Três, e o número sai do relógio: o marujo caminha a 1,75 m/s num raio de barra
 * de 1,05 m, o que dá pouco mais de um quarto de volta por segundo — **onze
 * segundos** para suspender o ferro sozinho, sem parar.
 *
 * Eram duas voltas a 2,2 m/s, ou seis segundos, e seis segundos é barato demais
 * para o que fundear faz: a âncora decide combate no Sea of Thieves justamente
 * porque desfazê-la ocupa um homem inteiro por um tempo que o adversário sente
 * passar. Meio segundo para largar contra onze para suspender é a assimetria que
 * dá peso à decisão de largar o ferro.
 */
const CAPSTAN_TURNS = 3;
/** Voltas por segundo do cabrestante correndo livre enquanto a amarra sai. */
const FREEWHEEL_TURNS = 2.6;

const _hawseWorld = new THREE.Vector3();
const _chain = new THREE.Vector3();
const _direction = new THREE.Vector3();
const _arm = new THREE.Vector3();
const _pointVelocity = new THREE.Vector3();
const _force = new THREE.Vector3();
const _inverse = new THREE.Quaternion();
const _drag = new THREE.Vector3();

export class Anchor {
  state: AnchorState = 'stowed';
  /** 0 = a pique no turco, 1 = no fundo. */
  deploy = 0;
  /** Tração da amarra no último passo, em newtons. HUD e áudio leem. */
  tension = 0;

  /** Ponto fixo no mundo onde a âncora cravou. Só vale com `deploy > 0`. */
  readonly worldPoint = new THREE.Vector3();

  /** Posição de repouso da âncora no navio — de onde ela sai e para onde volta. */
  private readonly stowed = new THREE.Vector3();
  private readonly stowedRotation = new THREE.Euler();
  /** Escovém: por onde a amarra passa e onde a tração é aplicada. */
  private readonly hawse = new THREE.Vector3();
  private capstanAngle = 0;
  /** Voltas de barra pedidas neste passo, em fração de volta. */
  private heaveTurns = 0;
  /** Segundos desde a última barra empurrada. Ver `CAPSTAN_GRACE`. */
  private idleTime = 0;

  constructor(model: ShipModel) {
    // A pose guardada é a que o `ShipBuilder` desenhou. Ler dela, em vez de
    // repetir as coordenadas aqui, é o que impede a âncora de voltar para um
    // lugar que não é o turco no dia em que a proa mudar de forma.
    this.stowed.copy(model.anchor.position);
    this.stowedRotation.copy(model.anchor.rotation);
    this.hawse.set(0, this.stowed.y - 0.25, this.stowed.z - 0.3);
  }

  /** `true` quando a amarra já pode estar fazendo força. */
  get isDeployed(): boolean {
    return this.deploy > 0.001;
  }

  /** Quanto da amarra já foi recolhida, de 0 (no fundo) a 1 (a pique). */
  get raised(): number {
    return 1 - this.deploy;
  }

  /** Larga o ferro. Sem efeito se já estiver fora. */
  drop(body: ShipBody): void {
    if (this.state !== 'stowed') return;
    this.state = 'dropping';
    body.localToWorld(this.hawse, _hawseWorld);
    // Crava a prumo do escovém: é onde a âncora cairia, e é o que faz o navio
    // girar em volta da própria proa em vez de em volta de um ponto arbitrário.
    this.worldPoint.set(_hawseWorld.x, -SEABED_DEPTH, _hawseWorld.z);
  }

  /**
   * Empurra as barras do cabrestante.
   *
   * @param turns fração de volta empurrada neste passo. Vem do quanto o jogador
   *   **andou** em torno do cabrestante, não de um botão segurado: é a diferença
   *   entre suspender o ferro e pedir para ele ser suspenso.
   */
  heave(turns: number): void {
    if (this.state === 'stowed' || this.state === 'dropping') return;
    this.state = 'raising';
    this.heaveTurns += Math.max(turns, 0);
    this.idleTime = 0;
  }

  fixedUpdate(dt: number, body: ShipBody): void {
    switch (this.state) {
      case 'dropping':
        this.deploy = Math.min(this.deploy + DROP_RATE * dt, 1);
        // O cabrestante roda livre enquanto a amarra corre: ninguém o segura, e
        // é esse giro solto que diz ao jogador que o ferro está caindo.
        this.capstanAngle -= FREEWHEEL_TURNS * TAU * dt;
        if (this.deploy >= 1) this.state = 'set';
        break;

      case 'raising': {
        const recovered = this.heaveTurns / CAPSTAN_TURNS;
        this.deploy = Math.max(this.deploy - recovered, 0);
        this.capstanAngle += this.heaveTurns * TAU;
        if (this.deploy <= 0) this.state = 'stowed';

        // **Largar a barra é perder o que se ganhou.**
        //
        // Antes o progresso congelava: dava para suspender 30% do ferro, largar,
        // ir bombear o porão, voltar e continuar de onde parou. Isso apaga o
        // custo do fundeio, que é a coisa inteira — no Sea of Thieves a âncora
        // decide combates justamente porque suspendê-la ocupa um homem do começo
        // ao fim, e soltar o cabrestante manda a corrente de volta ao fundo.
        //
        // A carência de meio segundo é o que separa "largou" de "trocou o passo".
        if (this.heaveTurns <= 0 && this.deploy > 0) {
          this.idleTime += dt;
          if (this.idleTime > CAPSTAN_GRACE) {
            this.deploy = Math.min(this.deploy + RUNBACK_RATE * dt, 1);
            // Girando ao contrário, que é o sinal de que a amarra está correndo.
            this.capstanAngle -= RUNBACK_RATE * TAU * dt * CAPSTAN_TURNS;
            if (this.deploy >= 1) this.state = 'set';
          }
        } else {
          this.idleTime = 0;
        }

        // Zerado todo passo: quem quiser continuar recolhendo tem de continuar
        // andando. Sem isso o cabrestante giraria sozinho até o fim.
        this.heaveTurns = 0;
        break;
      }

      default:
        break;
    }

    this.applyTension(body);
  }

  private applyTension(body: ShipBody): void {
    this.tension = 0;
    if (!this.isDeployed) return;

    body.localToWorld(this.hawse, _hawseWorld);
    _arm.subVectors(_hawseWorld, body.comPosition);
    body.pointVelocity(_arm, _pointVelocity);

    // Atrito do ferro no fundo. Vale mesmo com a amarra frouxa — é ele que faz
    // largar o ferro em movimento frear o navio em vez de não fazer nada até a
    // corrente esticar de repente.
    _drag.copy(_pointVelocity).multiplyScalar(-DRAG_COEFFICIENT * this.deploy);
    _drag.y = 0;
    body.applyForceAtPoint(_drag, _hawseWorld);

    _chain.subVectors(this.worldPoint, _hawseWorld);
    const distance = _chain.length();
    if (distance <= CHAIN_LENGTH || distance < 1e-4) return;

    _direction.copy(_chain).divideScalar(distance);

    // Elástico + amortecedor ao longo da amarra. O `max` é o que garante que
    // corrente puxa e nunca empurra; o fator `deploy` é a âncora ainda caindo
    // (ou já saindo do fundo), que segura proporcionalmente ao quanto agarrou —
    // e é por isso que o navio volta a andar antes de o ferro estar a pique.
    const stretch = distance - CHAIN_LENGTH;
    const closing = _pointVelocity.dot(_direction);
    const pull = (CHAIN_STIFFNESS * stretch - CHAIN_DAMPING * closing) * this.deploy;
    this.tension = Math.min(Math.max(pull, 0), MAX_TENSION);
    if (this.tension <= 0) return;

    _force.copy(_direction).multiplyScalar(this.tension);
    body.applyForceAtPoint(_force, _hawseWorld);
  }

  /** Põe a âncora e o cabrestante onde a física diz que eles estão. */
  syncModel(model: ShipModel, body: ShipBody): void {
    model.capstan.rotation.y = this.capstanAngle;

    if (!this.isDeployed) {
      model.anchor.position.copy(this.stowed);
      model.anchor.rotation.copy(this.stowedRotation);
      return;
    }

    // A âncora continua sendo filha do navio, mas é desenhada no ponto do mundo
    // onde cravou: converter para o sistema local todo frame custa uma matriz e
    // evita reparentar objeto no meio do jogo, que é fonte garantida de bug de
    // descarte. A rotação inversa a mantém de pé enquanto o casco joga em volta.
    _inverse.copy(body.orientation).invert();
    model.anchor.position
      .subVectors(this.worldPoint, body.comPosition)
      .applyQuaternion(_inverse)
      .add(body.centerOfMass);

    // E daí ela **sobe pela amarra**, na proporção do que já foi recolhido.
    //
    // Sem esta linha o ferro ficava cravado no fundo até o último grau de barra
    // e só então aparecia de volta no turco, de um quadro para o outro. O jogador
    // empurrava o cabrestante minutos a fio sem ver nada acontecer — e agora que
    // largar a barra devolve a amarra ao fundo, ver a âncora subir e descer é a
    // única leitura direta do que o trabalho dele está rendendo. A interpolação é
    // para a pose de repouso, e não para o escovém, para que chegar a zero
    // coincida exatamente com o ferro de volta ao turco, sem salto na troca de
    // estado.
    model.anchor.position.lerp(this.stowed, 1 - this.deploy);
    model.anchor.quaternion.copy(_inverse);
  }

  /** Recolhe tudo de uma vez, sem manivela — reinício de partida. */
  reset(): void {
    this.state = 'stowed';
    this.deploy = 0;
    this.tension = 0;
    this.heaveTurns = 0;
    this.idleTime = 0;
    this.capstanAngle = 0;
  }
}
