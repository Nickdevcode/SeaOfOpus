/**
 * O jogador a bordo.
 *
 * **A ideia que sustenta o arquivo inteiro:** o jogador vive em coordenadas
 * locais do navio, não do mundo. Andar num convés que joga, aderna e guina é um
 * problema feio em coordenadas de mundo — seria preciso somar a velocidade do
 * casco, corrigir a rotação e ainda assim o jogador escorregaria a cada onda.
 * Guardando a posição no referencial do navio, o convés é um chão parado: o mar
 * balança o *referencial*, e quem está em cima vai junto de graça. É como o Sea
 * of Thieves resolve, e é por isso que lá dá para correr num navio em curva sem
 * pensar duas vezes.
 *
 * O preço é que o referencial não é inercial: rigorosamente faltariam Coriolis e
 * centrífuga num salto. Para um pulo de 0,6 s num casco de 16 m dá centímetros —
 * e o comportamento sem essas forças é o que o jogador *espera* (cai onde pulou).
 * A gravidade, essa sim, entra rodada para o referencial do navio, então saltar
 * num convés adernado joga o corpo para o lado de baixo.
 *
 * O que é responsabilidade daqui: andar, pular, subir escada, ocupar o timão e
 * ocupar o canhão. Câmera é do `CameraRig`, foco de interação é do `Interaction`.
 */

import * as THREE from 'three';
import { GRAVITY, TAU, clamp, damp } from '../core/MathUtils';
// `JUMP_SPEED` vem de lá porque é o clipe de ar quem mais depende dela: a pose
// é indexada pela velocidade vertical, e a escala dessa leitura é a velocidade
// de saída. Ver `JumpClock`.
import {
  CarryClock,
  ClimbClock,
  GaitClock,
  HelmClock,
  JUMP_SPEED,
  JumpClock,
  RUN_CLIP,
} from './Locomotion';
import { InputBit, held, pressed, type InputFrame } from '../core/InputFrame';
import type { Ship } from '../ship/Ship';
import { HELM_STAND } from '../ship/ShipBuilder';
import { BARREL_BLOCKERS, CANOPY_BLOCKERS, CROW_NEST, MAST_LADDER } from '../ship/ShipParts';
import {
  DECK_Y,
  HOLD_FLOOR_Y,
  HULL_THICKNESS,
  STATIONS,
  ceilingY,
  deckCamber,
  deckHalfWidth,
  halfWidthAtHeight,
  isOverHatch,
  stairSurfaceY,
  tToZ,
  walkableY,
  zToT,
} from '../ship/ShipDimensions';

/** Onde o jogador está: solto pelo navio ou operando alguma peça. */
export type PlayerStation = 'deck' | 'helm' | 'cannon';

const WALK_SPEED = 2.8;
const RUN_SPEED = 4.7;
/** Convergência da velocidade horizontal, em 1/s. Alto no chão, baixo no ar. */
const GROUND_CONTROL = 14;
const AIR_CONTROL = 1.6;

const PLAYER_RADIUS = 0.3;
const EYE_HEIGHT = 1.66;
/** Degrau que se sobe (e desce) sem sair do chão. Cobre o tombadilho, de 44 cm. */
const STEP_HEIGHT = 0.5;

const PITCH_LIMIT = 1.45;

/**
 * Velocidade de subida na escada do mastro, em m/s.
 *
 * Só existe uma escada de mão no navio agora — a do mastro. A do porão virou um
 * lance inclinado, que é chão e não precisa de modo nenhum: ver `stairSurfaceY`.
 *
 * Eram 2,1 m/s antes de o personagem ter corpo, e 2,1 é **sete degraus por
 * segundo**: com o clipe de escalada tocando, o pirata vira desenho animado. Não
 * há nada de errado com o clipe nessa velocidade — a fase é dirigida pela altura
 * e o contato continua exato —, o problema é que ninguém sobe assim. 1,2 dá
 * quatro degraus por segundo, ainda ágil, e leva 7,5 s do convés ao cesto.
 */
const CLIMB_SPEED = 1.2;

/**
 * Quanto o jogador fica atrás do plano dos degraus, em metros.
 *
 * Eram 24 cm, e 24 não cabe: o casaco deste pirata avança 24,8 cm à frente do
 * eixo do corpo na altura da faixa, e a barra ainda tem 2,6 cm de raio. Com o
 * número antigo ele atravessava a escada **parado**, antes de qualquer animação.
 * O valor está espelhado em `anim_climb.LADDER_STANDOFF`, que é onde o clipe foi
 * construído — mexer em um sem o outro descasa a mão da barra.
 */
const LADDER_STANDOFF = 0.29;

/**
 * Meia largura da zona em que a escada do mastro pode ser agarrada.
 *
 * **Agora é preciso apertar o botão de interação.** A versão anterior agarrava
 * por encostar andando para vante, e o custo disso era grande: atravessar o
 * convés rente ao mastro grudava o jogador na escada sem que ninguém tivesse
 * pedido, e — pior — chegar ao cesto não dava saída nenhuma, porque descer
 * exigia o mesmo gesto que subir e o jogador ficava preso lá em cima. Com uma
 * tecla, subir e descer são a mesma escolha explícita, nos dois sentidos.
 */
const MAST_LADDER_REACH = 0.55;

/**
 * Convergência do amortecimento do degrau, em 1/s.
 *
 * **É este número que tira a "flicada" da escada do porão.** O lance tem sete
 * degraus de 26 cm, e o chão embaixo do pé é uma função em escada: a cada
 * espelho cruzado o controlador reassenta o corpo um degrau inteiro num único
 * quadro. Para os pés isso é o certo — degrau é degrau —, mas a cabeça vai
 * junto, e 26 cm de teletransporte vertical a 1,66 m do olho é exatamente o
 * salto que se vê.
 *
 * A correção é a clássica de FPS com escadas: a física continua discreta e a
 * **vista** carrega um resto que se apaga.
 */
const STEP_SMOOTH_LAMBDA = 16;

/**
 * Teto de velocidade com que esse resto se apaga: parte fixa (m/s) mais uma
 * parcela proporcional à velocidade de quem anda.
 *
 * Exponencial puro não bastava, e o motivo é aritmético: com λ = 16 a 60 fps o
 * **primeiro** quadro depois do degrau come 23% da dívida — 8 cm de um degrau de
 * 35 cm. O maior salto continuava caindo justamente no instante do tranco, que é
 * onde ele incomoda; o resto da curva era invisível de tão suave.
 *
 * O teto resolve isso, mas ele não pode ser um número só. O lance do porão desce
 * 1,85 m em 1,55 m de avanço: a 2,8 m/s de caminhada são **3,4 m/s de descida**,
 * e um teto abaixo disso satura — a dívida cresce mais rápido do que se paga e o
 * excesso volta a vazar para a câmera degrau a degrau. Com o teto acompanhando o
 * andar, a vista desce a escada na velocidade da *rampa* enquanto os pés
 * continuam pisando os degraus, que é exatamente a divisão que se quer: os pés
 * sabem que há degrau, o olho não precisa saber.
 *
 * E velocidade constante não é o que se nota — o que se nota é a descontinuidade.
 * Descer 5,6 cm por quadro sem sobressalto lê como andar numa ladeira.
 */
const STEP_SMOOTH_BASE_RATE = 1.4;
const STEP_SMOOTH_RATE_PER_SPEED = 1.35;

/** Centro do cabrestante, em coordenadas locais. */
const CAPSTAN_STAND = new THREE.Vector3(0, DECK_Y, tToZ(STATIONS.capstan));
/**
 * Raio em que o marujo caminha ao empurrar as barras.
 *
 * É o raio das próprias barras, medido de `createCapstan`: elas saem do topo e
 * vão até 1,15 m do eixo. Andar por fora delas seria empurrar o ar.
 */
const CAPSTAN_RADIUS = 1.05;
/**
 * Até que distância do eixo o botão de interação pega as barras.
 *
 * Exportado porque o prompt do cabrestante precisa acender **dentro** deste
 * raio, e não fora dele: o `range` da peça interativa é medido do olho até um
 * ponto 45 cm acima do convés, o que soma 1,21 m de perna vertical à conta.
 * Um prompt que acende onde o modo se recusa a entrar é um botão que não
 * responde. Ver `createShipInteractables`.
 */
export const CAPSTAN_REACH = 2.1;
/**
 * Velocidade de caminhada ao redor do cabrestante, em m/s.
 *
 * Bem abaixo do passo normal (2,8 m/s) porque não se empurra uma barra de
 * cabrestante caminhando: empurra-se **de peito**, com o corpo inclinado, e o
 * navio inteiro na outra ponta da amarra. É metade do custo tático de fundear —
 * a outra metade são as voltas, em `Anchor.CAPSTAN_TURNS`.
 */
const CAPSTAN_WALK_SPEED = 1.75;
/**
 * Firmeza com que a cabeça acompanha a volta, em 1/s: parte fixa mais uma
 * parcela proporcional ao esforço.
 *
 * A parte fixa é o que traz o olhar de volta para a barra quando o jogador
 * larga o mouse; a parcela de esforço é o que impede a barra de fugir do centro
 * da tela justamente quando ele acelera. Ver `followCapstan`.
 */
const CAPSTAN_LOOK_LAMBDA = 4;
const CAPSTAN_LOOK_LAMBDA_PER_EFFORT = 5;
/** Para onde o queixo cai ao empurrar: as mãos estão nas barras, não no mar. */
const CAPSTAN_PITCH = -0.22;

/**
 * Onde o jogador nasce: no meio do convés principal, entre a escotilha e os
 * canhões, olhando para a proa.
 *
 * Não é no `HELM_STAND` — que era o óbvio, já que o timão é a primeira coisa que
 * se quer usar. Só que ali o jogador nasce a 5 cm do raio de colisão da roda, e
 * quem segura o W no primeiro segundo de jogo não anda: empurra a roda de frente,
 * sem componente tangencial para deslizar, e conclui que o personagem travou. É
 * uma primeira impressão cara por uma economia de dois metros.
 *
 * Também não é logo a ré da escotilha, que seria o caminho natural de quem desce
 * do tombadilho: entre o degrau e a borda do buraco sobra pouco mais de um metro,
 * e nascer de costas para um alçapão aberto é pior que nascer colado no timão.
 *
 * Daqui sobram 70 cm até a borda da escotilha, e a vista abre para o mastro e a
 * vela cheia, com os dois canhões nas amuras e a proa ao fundo. O timão fica atrás
 * de quem virar a câmera.
 */
const DECK_SPAWN = new THREE.Vector3(0, DECK_Y, 1.2);

/**
 * Rumo inicial do olhar: 24° abertos para boreste, não a proa exata.
 *
 * O mastro fica na linha de centro a 2,4 m do spawn. Olhando a 0° ele ocupa o
 * meio da tela e o primeiro quadro do jogo é um tronco de madeira. Girando um
 * quarto de rádio o mastro sai para a esquerda, e o que abre no lugar é o convés
 * até a proa com o mar de fundo — a mesma cena, mas mostrando o navio.
 */
const SPAWN_YAW = -0.42;

/**
 * Convergência do balanço de passo, em 1/s.
 *
 * **Era 16, e 16 tinha um erro que só aparecia de dentro do corpo.** Um
 * amortecedor de primeira ordem contra uma entrada senoidal atrasa a saída em
 * `atan(ω/λ)` e a encolhe em `λ/√(λ²+ω²)`. Andando a 2,8 m/s a passada dá um
 * ciclo de 0,65 s com **dois** quiques, ou seja ω = 19,3 rad/s: com λ = 16 a
 * câmera saía 50° atrasada e com 64% da altura pedida. Enquanto ninguém via o
 * próprio corpo isso era só um tempero. Vestindo o corpo, vira o tronco
 * afundando e emergindo 4 cm a cada passo, a 20 cm do olho.
 *
 * Com 48 o atraso cai para 22° e o ganho sobe para 0,94. Acima de ~80 o que se
 * ganha de fase é marginal e a curva começa a ler como tranco nos quadros
 * perdidos, porque o amortecimento deixa de filtrar o que deveria filtrar.
 */
const BOB_LAMBDA = 48;

/**
 * Distância dos pés ao topo da cabeça, para efeito de teto no porão.
 *
 * Não é a altura real do personagem: 1,78 m não *cabe* embaixo de um convés a
 * 1,76 m do assoalho, e usar o valor honesto empurraria o jogador para baixo do
 * piso. O que este número protege é a câmera — com o olho a 1,66 m, sobra a
 * altura do balanço no pior caso (o da corrida) e ainda uma margem de três
 * centímetros para a cabeça não atravessar a tábua e revelar o convés por
 * dentro. O porão da Chalupa é apertado assim mesmo: anda-se nele, não se pula.
 */
const HEAD_CLEARANCE = EYE_HEIGHT + RUN_CLIP.bounceAmplitude + 0.03;

/**
 * Campo de visão a pé, em graus. O jogador ajusta nos Ajustes.
 *
 * A mira pelo canhão é uma **fração** deste valor, e não um número fixo: o zoom
 * é o que o artilheiro ganha ao encostar o olho na peça, e essa vantagem não
 * pode depender de quanto o jogador abriu o campo no menu. Com um `AIM_FOV`
 * cravado, quem jogasse com 100° de campo teria três vezes mais zoom que quem
 * joga com 62° — uma vantagem competitiva escondida numa opção de conforto.
 */
const AIM_FOV_RATIO = 34 / 62;

/**
 * Obstáculos do convés, como cilindros verticais em coordenadas locais.
 *
 * Cilindro é grosseiro para um canhão, mas é o que o jogador sente: ele não
 * encosta no contorno da peça, ele contorna um estorvo. O que importa é que
 * mastro, cabrestante e canhões existam para os pés, e não só para os olhos.
 */
interface Blocker {
  x: number;
  z: number;
  radius: number;
  /** Se `true`, o obstáculo também existe no porão (só o mastro, hoje). */
  throughHold?: boolean;
}

/**
 * A pose de um marujo que chega pronta pela rede. Ver `applyRemoteStep`.
 *
 * É satisfeita estruturalmente pelo `CrewState` que o instantâneo produz — de
 * propósito: um tipo importado de `net/` aqui inverteria a dependência e faria o
 * jogador do convés precisar do formato de rede para compilar.
 */
export interface RemoteCrewPose {
  /** Posição dos pés, em coordenadas locais do navio dele. */
  readonly local: THREE.Vector3;
  readonly yaw: number;
  readonly pitch: number;
  readonly station: PlayerStation;
  readonly cannonIndex: number;
  readonly grounded: boolean;
  readonly onLadder: boolean;
  readonly atCapstan: boolean;
  /** `true` quando ele está com a tábua nas mãos. Ver `Interaction.patching`. */
  readonly patching: boolean;
}

/**
 * Deslocamento que deixa de ser caminhada e vira teleporte, em metros por passo.
 *
 * Meio metro é sete vezes o que a corrida cobre num passo de 1/60 s (4,7 m/s dá
 * 7,8 cm), então nenhuma caminhada legítima chega perto — e as descontinuidades
 * de verdade (assumir o leme, montar a peça, renascer) passam disso com folga.
 */
const REMOTE_TELEPORT = 0.5;

const _moveDir = new THREE.Vector3();
const _gravity = new THREE.Vector3();
const _euler = new THREE.Euler(0, 0, 0, 'YXZ');
const _pivot = new THREE.Vector3();
/** Deslocamento do marujo remoto neste passo. Ver `applyRemoteStep`. */
const _remoteStep = new THREE.Vector3();
/** Eixo de caminhada do passo. Reaproveitado: nada aqui aloca por tick. */
const _move = { x: 0, y: 0 };

export class PlayerController {
  station: PlayerStation = 'deck';
  /** Índice do canhão ocupado, ou -1. */
  cannonIndex = -1;

  /** Posição dos pés, em coordenadas locais do navio. */
  readonly local = new THREE.Vector3();
  /** Velocidade no referencial do navio, em m/s. */
  readonly velocity = new THREE.Vector3();

  /** Rumo da cabeça **relativo ao navio**: 0 olha para a proa. */
  yaw = 0;
  pitch = 0;

  grounded = true;
  /** `true` enquanto o jogador está pendurado na escada do mastro. */
  onLadder = false;
  /**
   * Resto de degrau ainda não absorvido pela vista, em metros.
   *
   * Positivo quando o pé acabou de **subir** um degrau (a vista fica para trás
   * e alcança), negativo quando desceu. Ver `STEP_SMOOTH_LAMBDA`.
   */
  private stepOffset = 0;
  /**
   * Voltas de barra empurradas no cabrestante neste quadro.
   *
   * Sai daqui, e não do `Interaction`, porque quem sabe o quanto o jogador andou
   * é o controlador. A peça interativa só repassa. Ver `pushCapstan`.
   */
  capstanTurns = 0;
  /**
   * `true` enquanto o jogador está com as mãos nas barras do cabrestante.
   *
   * É um **modo**, e não um botão segurado: entra-se com um toque e sai-se com
   * outro. Ver `enterCapstan`.
   */
  atCapstan = false;

  /**
   * Pose do olho que o `CameraRig` consome, em coordenadas locais.
   *
   * É a pose **do quadro** — interpolada entre dois passos por `syncView`, e não
   * a que a simulação escreveu. Quem quiser a da simulação usa `local`.
   */
  readonly eyeLocal = new THREE.Vector3();
  readonly eyeQuaternion = new THREE.Quaternion();

  /** A pose do passo atual e a do anterior, de onde `syncView` interpola. */
  private readonly simEyeLocal = new THREE.Vector3();
  private readonly simVisualLocal = new THREE.Vector3();
  private readonly previousEyeLocal = new THREE.Vector3();
  private readonly previousVisualLocal = new THREE.Vector3();
  /**
   * Onde os pés **parecem** estar, em coordenadas locais.
   *
   * Difere de `local` só na vertical, e só enquanto um degrau está sendo
   * absorvido. É o que o corpo do jogador (`PlayerAvatar`) desenha: sem isto a
   * câmera subiria a escada macia e o personagem ao lado dela subiria aos
   * pulos, que é o mesmo defeito visto de fora.
   */
  readonly visualLocal = new THREE.Vector3();
  /** Campo de visão desejado, em graus. */
  fov = 62;
  /** Campo de visão a pé, escolhido pelo jogador nos Ajustes. */
  private baseFov = 62;

  /** Muda a cada troca de estação: o rig usa para disparar a transição. */
  stationChangeCount = 0;

  /**
   * O relógio da passada. É público porque o corpo do jogador (`PlayerAvatar`)
   * lê daqui em vez de manter a contagem dele: uma fase só significa que o pé
   * que se vê tocar o convés é o mesmo que sacode a câmera.
   */
  readonly gait = new GaitClock();

  /**
   * O relógio do pulo, público pela mesma razão que o da passada: quem sabe se
   * os pés estão no convés é este objeto, e o corpo só lê. Fica separado do
   * `GaitClock` porque as duas coisas se sobrepõem — dá para pular correndo, e
   * o peso do ar entra por cima da mistura de locomoção em vez de substituí-la.
   */
  readonly jump = new JumpClock();

  /**
   * O relógio da escada, público pelos mesmos motivos dos outros dois — e com
   * uma exigência a mais: ele precisa saber **quanto o corpo subiu neste
   * quadro**, não a que velocidade, porque é a altura que casa a mão com a
   * barra. Quem tem esse número é o `climb`, aqui embaixo.
   */
  readonly climb = new ClimbClock();

  /**
   * O relógio do timão, público como os outros três. Ele pede a grandeza mais
   * barata de todas — o **ângulo da roda**, que o `Rudder` já mantém —, e é por
   * isso que a mão do timoneiro cai em cima de um punho desenhado sem que nada
   * precise ser alinhado ao assumir o leme.
   */
  readonly helm = new HelmClock();

  /**
   * O relógio da tábua de reparo. É o único que **não** é alimentado daqui de
   * dentro: quem sabe se o jogador está pregando tábua é a `Interaction`, que
   * vê o rombo e o botão no mesmo quadro. Ver `Match.update`.
   */
  readonly carry = new CarryClock();
  private bobOffset = 0;
  /** Para onde o jogador volta ao largar o timão ou o canhão. */
  private readonly stationReturn = new THREE.Vector3();
  private stationReturnYaw = 0;

  private readonly blockers: Blocker[];
  /** Faixa de Z em que o convés é largo o bastante para caber alguém. */
  private readonly deckRange: { min: number; max: number };
  private readonly holdRange: { min: number; max: number };

  constructor() {
    const cannonX = deckHalfWidth(STATIONS.cannon) - 0.5;
    this.blockers = [
      // O mastro tem 24 cm de raio no convés, e as cintas de ferro somam 4 cm.
      // O 0,46 de antes era margem chutada, e num tronco que nasce no meio do
      // corredor 20 cm de margem inventada custam 20 cm de passagem de cada lado.
      { x: 0, z: tToZ(STATIONS.mast), radius: 0.34, throughHold: true },
      { x: 0, z: tToZ(STATIONS.capstan), radius: 0.55 },
      { x: cannonX, z: tToZ(STATIONS.cannon), radius: 0.75 },
      { x: -cannonX, z: tToZ(STATIONS.cannon), radius: 0.75 },
      // O tambor do leme. **0,32, e não os 0,5 de antes**: o posto do timoneiro
      // veio para 62 cm do plano da roda (ver `HELM_STAND`), e 0,5 mais os 0,30
      // do cilindro do jogador põem o próprio posto **dentro** do obstáculo —
      // quem chegasse a pé seria expelido do leme antes de conseguir assumi-lo.
      // 0,62 − PLAYER_RADIUS é o maior raio que ainda deixa o posto do lado de
      // fora, e não é raio inventado: a face de ré do tambor fica a 0,22 m do
      // plano da roda, então sobram 10 cm entre a madeira e o cilindro.
      { x: 0, z: tToZ(STATIONS.helm), radius: 0.32 },
      // Bitácula, logo à frente da roda. Espelha a caixa de `buildBinnacle`.
      { x: 0, z: tToZ(STATIONS.helm) - 1.05, radius: 0.32 },
      // Barris: lidos de `BARREL_BLOCKERS`, que é a mesma lista que os desenha.
      // Antes eram três pares de números copiados à mão, e eles já tinham
      // divergido do modelo — a colisão ficava 17 cm ao lado da madeira.
      ...BARREL_BLOCKERS.map((barrel) => ({ ...barrel })),
      // As colunas do toldo de popa, pela mesma razão dos barris: elas são
      // madeira de verdade no caminho de quem anda pelo tombadilho.
      ...CANOPY_BLOCKERS.map((post) => ({ ...post })),
    ];

    // Medido do próprio casco em vez de fixado à mão: no dia em que a proa afinar
    // ou o porão mudar de altura, o limite de caminhada acompanha sozinho.
    this.deckRange = measureWalkRange((t) => deckHalfWidth(t));
    this.holdRange = measureWalkRange(
      (t) => halfWidthAtHeight(t, HOLD_FLOOR_Y + 0.5) - HULL_THICKNESS,
    );
  }

  /** `true` quando o jogador está abaixo do convés principal. */
  get inHold(): boolean {
    return this.local.y < DECK_Y - STEP_HEIGHT;
  }

  /** Ajusta o campo de visão a pé. Vem das preferências do jogador. */
  setFieldOfView(degrees: number): void {
    this.baseFov = clamp(degrees, 45, 110);
    if (this.station !== 'cannon') this.fov = this.baseFov;
  }

  /** Põe o jogador de pé no convés principal, olhando para a proa. */
  spawn(): void {
    this.station = 'deck';
    this.cannonIndex = -1;
    this.onLadder = false;
    this.atCapstan = false;
    this.grounded = true;
    this.local.copy(DECK_SPAWN);
    this.velocity.set(0, 0, 0);
    this.yaw = SPAWN_YAW;
    this.pitch = -0.05;
    this.gait.reset();
    this.jump.reset();
    this.climb.reset();
    this.carry.reset();
    this.helm.reset();
    this.bobOffset = 0;
    this.stepOffset = 0;
    this.fov = this.baseFov;
    this.stationChangeCount++;
    this.updateEye();
  }

  /** Assume o timão. Sem efeito se já estiver em alguma estação. */
  takeHelm(): void {
    if (this.station !== 'deck') return;
    this.saveReturn();
    this.station = 'helm';
    this.local.copy(HELM_STAND);
    this.velocity.set(0, 0, 0);
    this.grounded = true;
    this.onLadder = false;
    this.atCapstan = false;

    // Virar para a proa não é enquadramento, é a única pose possível.
    //
    // A roda fica em z 6,32 e o posto do timoneiro em 6,94: quem assume o leme
    // está *a ré* dela, de frente para o navio. Só que para acender o prompt é
    // preciso olhar para a roda, ou seja, olhar para a popa — e sem esta linha o
    // jogador era teleportado para trás da roda mantendo aquele rumo de cabeça.
    // O resultado é o que a captura mostrou: tela cheia de mar aberto, o timão
    // atrás da nuca e o navio inteiro fora de campo. Ninguém governa um barco de
    // costas para ele.
    //
    // O `CameraRig` interpola a orientação em 0,28 s, então a meia-volta sai
    // como um giro de cabeça e não como um corte seco. E `leaveStation` já
    // devolve o rumo salvo em `saveReturn`, então largar o leme recoloca o olhar
    // exatamente onde ele estava antes de assumir.
    this.yaw = 0;
    // Um pouco para baixo: é onde a roda e a bitácula ficam, e é a inclinação
    // natural de quem está com as mãos no leme.
    this.pitch = -0.14;

    this.stationChangeCount++;
  }

  /** Monta um canhão pelo índice em `ship.cannons`. */
  mountCannon(index: number): void {
    if (this.station !== 'deck') return;
    this.saveReturn();
    this.station = 'cannon';
    this.cannonIndex = index;
    this.velocity.set(0, 0, 0);
    this.grounded = true;
    this.onLadder = false;
    this.atCapstan = false;
    this.stationChangeCount++;
  }

  /** Larga o timão ou o canhão e volta a andar de onde saiu. */
  leaveStation(): void {
    if (this.station === 'deck') return;
    this.station = 'deck';
    this.cannonIndex = -1;
    this.local.copy(this.stationReturn);
    this.yaw = this.stationReturnYaw;
    this.velocity.set(0, 0, 0);
    this.fov = this.baseFov;
    this.stationChangeCount++;
  }

  /**
   * `true` quando o jogador está perto o bastante da escada do mastro para
   * agarrá-la. Quem pergunta é a peça interativa, que acende o prompt.
   *
   * O alcance é medido no plano do convés e a faixa de altura cobre as duas
   * pontas: o pé da escada e o cesto. É a mesma pergunta nos dois lugares, o que
   * faz "subir" e "descer" serem o mesmo gesto em sentidos opostos.
   */
  canGrabMastLadder(): boolean {
    if (this.station !== 'deck' || this.onLadder || !this.grounded) return false;

    // No cesto, **estar no cesto** já é estar ao pé da escada: ele tem 98 cm de
    // raio, o corpo ocupa 30 e o portaló é a única saída. Cobrar alinhamento ali
    // em cima prenderia o jogador na gávea por quinze centímetros — que é
    // exatamente o defeito que esta peça veio consertar.
    if (this.onCrowNest()) return true;

    if (this.local.y < MAST_LADDER.bottomY - 0.3 || this.local.y > CROW_NEST.y + 0.4) return false;
    return (
      Math.abs(this.local.x) <= MAST_LADDER_REACH + PLAYER_RADIUS &&
      Math.abs(this.local.z - MAST_LADDER.z) <= MAST_LADDER_REACH + PLAYER_RADIUS
    );
  }

  /**
   * Agarra a escada do mastro. Chamado pelo botão de interação.
   *
   * **Vante sobe, ré desce — nas duas pontas.** Houve uma versão que guardava o
   * sentido em que a escada tinha sido tomada e fazia o W "continuar o gesto":
   * quem entrava pela gávea descia com o mesmo W que o levou até lá. A intenção
   * era boa e o resultado era o oposto do esperado por qualquer um que já subiu
   * uma escada em um jogo — pendurado a nove metros, empurrar o analógico para
   * cima **descia**. Um comando que inverte no meio do caminho não é um atalho,
   * é um bug com justificativa.
   */
  grabMastLadder(): void {
    this.onLadder = true;
    this.atCapstan = false;
    this.velocity.set(0, 0, 0);
    this.grounded = false;
    this.stepOffset = 0;
    this.local.x = 0;
    this.local.z = MAST_LADDER.z + LADDER_STANDOFF;
    // Quem entra pelo cesto começa logo abaixo do piso dele; quem entra pelo
    // convés fica onde está. O grampo de cima é o que impede a saída pelo alto
    // de disparar no mesmo quadro do agarrão e devolver o jogador ao cesto sem
    // que ele tenha descido um degrau.
    this.local.y = Math.min(this.local.y, CROW_NEST.y - 0.25);
    // E o clipe é alinhado à grade de barras **uma vez**, aqui. Como a fase
    // avança pela altura vencida e o ciclo sobe exatamente dois enfrechates, o
    // alinhamento se sustenta sozinho até o jogador soltar — não importa quantos
    // metros ele suba, nem se parar no meio, nem se descer.
    this.climb.align(this.local.y, MAST_LADDER.bottomY, MAST_LADDER.rungSpacing);
  }

  /**
   * Põe as mãos nas barras do cabrestante.
   *
   * **É um modo, e não um botão segurado.** Suspender o ferro segurando o botão
   * de interação parecia fiel — é o gesto de quem empurra —, mas na prática
   * pedia ao jogador que mantivesse uma tecla apertada, andasse em círculo e
   * ainda arrumasse a câmera com a mão que sobrasse. Um toque entra, outro sai,
   * e no meio o que se pede é a única coisa que interessa: **andar para vante**,
   * volta após volta. Ver `pushCapstan`.
   */
  enterCapstan(): void {
    if (this.station !== 'deck' || this.onLadder || this.inHold) return;
    this.atCapstan = true;
    this.velocity.set(0, 0, 0);
  }

  /**
   * Larga as barras e volta a andar pelo convés.
   *
   * Zera a velocidade porque a que ficou é tangencial ao círculo do cabrestante
   * (ver `pushCapstan`): sem isto, soltar a peça em pleno giro cuspiria o
   * jogador de lado, na direção em que a barra o estava levando.
   */
  leaveCapstan(): void {
    this.atCapstan = false;
    this.velocity.set(0, 0, 0);
  }

  /**
   * Um passo de simulação do marujo.
   *
   * Roda no passo fixo, e não no quadro, por duas razões que se somam. A de rede
   * é óbvia: sem um relógio inteiro compartilhado não há como o outro lado
   * reproduzir o que este jogador fez. A de física é anterior a ela e vale mesmo
   * offline — `capstanTurns` era uma quantidade medida **por quadro** e consumida
   * **por passo**, o que fazia suspender a âncora depender do FPS. A 144 quadros
   * o cabrestante recebia mais do que o passo conseguia gastar; a 30, menos.
   */
  fixedUpdate(dt: number, frame: InputFrame, ship: Ship): void {
    // Zerado todo passo: quem quiser virar o cabrestante ou bombear tem de pedir
    // de novo. Soltar o `F` para de agir no mesmo passo, sem inércia de comando.
    ship.controls.capstanTurns = 0;
    ship.controls.pumping = false;
    ship.controls.wheel = 0;
    this.capstanTurns = 0;

    // A pose do passo anterior, guardada antes de qualquer coisa mexer nela: é
    // dela que `syncView` interpola. Mesma técnica de `ShipBody.previousCom`, e
    // pela mesma razão — sem ela a câmera andaria em degraus de 60 Hz numa tela
    // de 144.
    this.previousEyeLocal.copy(this.simEyeLocal);
    this.previousVisualLocal.copy(this.simVisualLocal);

    // `X` (ou B no controle) larga a peça. Fica antes do switch para o resto do
    // passo já correr como jogador a pé — sem um passo de estação fantasma.
    if (this.station !== 'deck' && pressed(frame, InputBit.Exit)) this.leaveStation();

    switch (this.station) {
      case 'helm':
        this.updateHelm(dt, frame, ship);
        break;
      case 'cannon':
        this.updateCannon(dt, frame, ship);
        break;
      default:
        this.updateOnFoot(dt, frame, ship);
        break;
    }

    this.updateEye();
  }

  /**
   * Um passo de um marujo que **não** é simulado aqui: a pose chega pronta.
   *
   * É o caminho do corpo do adversário no cliente que não simula. Ele existe
   * porque a pose sozinha não anima ninguém: o que move o personagem na tela não
   * é a posição, são os **relógios** — passada, pulo, escada, timão e tábua —, e
   * eles são alimentados por grandezas que o instantâneo não carrega (velocidade
   * no convés, altura vencida por quadro, ângulo da roda). Sem este método, o
   * marujo do outro lado chegava ao lugar certo em pose de estátua, deslizando
   * pelo convés como peça de tabuleiro.
   *
   * ## Por que a velocidade é derivada, e não transmitida
   *
   * Porque derivá-la sai de graça e chega **melhor**. A posição já vem
   * interpolada entre dois instantâneos (ver `GuestSession.applyCrew`), então a
   * diferença entre dois passos é exatamente o quanto o corpo andou na tela — e
   * é isso, e não a velocidade que o outro tinha, que a passada precisa saber
   * para o pé ficar parado no convés durante o apoio. Mandar o vetor custaria
   * seis bytes por marujo por instantâneo para produzir um pé que patina sempre
   * que a rede engasgasse.
   *
   * ## O que conta como teleporte
   *
   * Assumir o timão, montar um canhão, agarrar a escada e renascer movem o corpo
   * metros num passo. Derivar velocidade disso daria um pirata em disparada por
   * um quadro — e, pior, um pulo detectado no meio. Nesses casos a velocidade é
   * zerada e os relógios de pulo e escada são assentados em vez de alimentados.
   *
   * @param pose o estado autoritativo deste passo.
   * @param ship o casco em que ele está — é dele que sai o ângulo da roda.
   */
  applyRemoteStep(dt: number, pose: RemoteCrewPose, ship: Ship): void {
    // A pose do passo anterior, antes de qualquer coisa mexer nela: é dela que
    // `syncView` interpola para a taxa do monitor. Mesma abertura de
    // `fixedUpdate`, e pela mesma razão.
    this.previousEyeLocal.copy(this.simEyeLocal);
    this.previousVisualLocal.copy(this.simVisualLocal);

    const stationChanged =
      pose.station !== this.station || pose.cannonIndex !== this.cannonIndex;
    const grabbedLadder = pose.onLadder && !this.onLadder;

    _remoteStep.subVectors(pose.local, this.local);
    const teleported =
      stationChanged ||
      grabbedLadder ||
      _remoteStep.lengthSq() > REMOTE_TELEPORT * REMOTE_TELEPORT;

    if (teleported) this.velocity.set(0, 0, 0);
    else this.velocity.copy(_remoteStep).divideScalar(dt);

    this.local.copy(pose.local);
    this.yaw = pose.yaw;
    this.pitch = pose.pitch;
    // Antes de escrever o posto: é a **mudança** que o corpo usa para levar os
    // pés até a estação com a mesma suavização da câmera. Ver
    // `PlayerAvatar.updateStation`.
    if (stationChanged) this.stationChangeCount++;
    this.station = pose.station;
    this.cannonIndex = pose.cannonIndex;
    this.grounded = pose.grounded;
    this.onLadder = pose.onLadder;
    this.atCapstan = pose.atCapstan;

    // Na escada e nas estações o corpo está preso a alguma coisa, e a passada
    // tem de se apagar — é a mesma regra de `settleBob` e de `updateLadder`.
    const onFoot = this.station === 'deck' && !this.onLadder;
    const speed = onFoot ? Math.hypot(this.velocity.x, this.velocity.z) : 0;
    this.gait.update(dt, speed, onFoot ? this.grounded : true);

    // A escada é indexada pela **altura vencida**, como do lado de quem simula.
    // O alinhamento com a grade de barras é feito uma vez, ao agarrar, e daí em
    // diante se sustenta sozinho — sem ele a mão do outro jogador flutuaria
    // entre dois enfrechates pelo resto da subida.
    if (grabbedLadder) {
      this.climb.align(this.local.y, MAST_LADDER.bottomY, MAST_LADDER.rungSpacing);
    }
    this.climb.update(dt, this.onLadder, this.onLadder && !teleported ? _remoteStep.y : 0);

    // O timão sai do ângulo da roda, que é autoritativo e já foi escrito neste
    // passo: a mão cai em cima de um punho desenhado sem nada precisar viajar.
    this.helm.update(dt, this.station === 'helm', ship.rudder.wheelAngle);
    // E a tábua, do único bit que este método precisa que o fio carregue: quem
    // vê o rombo e o botão segurado é a `Interaction` do outro lado.
    this.carry.update(dt, pose.patching);

    if (onFoot && !teleported) this.jump.update(dt, this.velocity.y, this.grounded);
    // `settle` e não `update`: quem foi teleportado para trás da roda não
    // aterrissou de lugar nenhum, e um pouso disparado ali põe o adversário se
    // agachando de pé no posto. Ver `JumpClock.settle`.
    else this.jump.settle(dt);

    this.updateEye();
  }

  // -- a pé --------------------------------------------------------------------

  private updateOnFoot(dt: number, frame: InputFrame, ship: Ship): void {
    this.applyLook(frame);
    this.fov = damp(this.fov, this.baseFov, 10, dt);
    // Antes de qualquer coisa mexer no corpo: o resto de degrau do passo
    // passado se apaga sozinho, ande-se, suba-se ou empurre-se o cabrestante.
    this.decayStep(dt);

    _move.x = frame.moveX;
    _move.y = frame.moveY;
    const move = _move;

    if (this.onLadder) {
      this.updateLadder(dt, frame, move.y);
      return;
    }

    if (this.pushCapstan(dt, frame, move, ship)) return;

    const speed = held(frame, InputBit.Sprint) ? RUN_SPEED : WALK_SPEED;
    const sin = Math.sin(this.yaw);
    const cos = Math.cos(this.yaw);
    // Frente local = Ry(yaw)·(0,0,-1); direita = Ry(yaw)·(1,0,0).
    _moveDir.set(-sin * move.y + cos * move.x, 0, -cos * move.y - sin * move.x);
    if (_moveDir.lengthSq() > 1) _moveDir.normalize();

    const control = this.grounded ? GROUND_CONTROL : AIR_CONTROL;
    this.velocity.x = damp(this.velocity.x, _moveDir.x * speed, control, dt);
    this.velocity.z = damp(this.velocity.z, _moveDir.z * speed, control, dt);

    if (this.grounded && pressed(frame, InputBit.Jump)) {
      this.velocity.y = JUMP_SPEED;
      this.grounded = false;
    }

    if (!this.grounded) {
      // A gravidade é do mundo; no referencial do navio ela sai da vertical
      // tanto quanto o casco estiver adernado.
      _gravity.set(0, -GRAVITY, 0);
      ship.body.worldDirToLocal(_gravity, _gravity);
      this.velocity.addScaledVector(_gravity, dt);
    }

    this.local.addScaledVector(this.velocity, dt);

    this.resolveHull();
    this.resolveBlockers();
    this.resolveGround();
    this.resolveCeiling();
    this.updateBob(dt);
  }

  /**
   * Empurrar as barras do cabrestante: o jogador anda **em volta** dele.
   *
   * Esta é a metade do fundeio que custa. Largar o ferro é um toque; suspendê-lo
   * é assumir o cabrestante e caminhar em torno dele, volta após volta,
   * exatamente como no Sea of Thieves. O cabrestante gira o ângulo que o marujo
   * percorreu — não há taxa fixa, não há barra enchendo sozinha, e parar de
   * andar é parar de recolher.
   *
   * A conversão é direta: o ângulo varrido em volta do eixo **é** o ângulo que a
   * barra girou. Nenhum fator de conversão, nenhuma constante de sintonia.
   *
   * Quem liga e desliga o modo é a peça interativa (`press`), que roda **depois**
   * do jogador no quadro — é o que impede o mesmo toque de entrar e sair. Aqui
   * ficam só as saídas que não são um toque: largar a peça, cair no porão,
   * afastar-se das barras e chegar ao fim do serviço.
   *
   * @returns `true` quando tomou conta do movimento deste quadro.
   */
  private pushCapstan(
    dt: number,
    frame: InputFrame,
    move: { x: number; y: number },
    ship: Ship,
  ): boolean {
    if (!this.atCapstan) return false;

    // Sair pela porta dos fundos: `X`/`B` e o pulo largam as barras como largam
    // qualquer outra peça, e o ferro em casa (ou correndo de volta ao fundo)
    // encerra o serviço sozinho — não há o que empurrar em nenhum dos dois.
    if (
      pressed(frame, InputBit.Exit) ||
      pressed(frame, InputBit.Jump) ||
      this.inHold ||
      ship.anchor.state === 'stowed' ||
      ship.anchor.state === 'dropping'
    ) {
      this.leaveCapstan();
      return false;
    }

    const dx = this.local.x - CAPSTAN_STAND.x;
    const dz = this.local.z - CAPSTAN_STAND.z;
    const distance = Math.hypot(dx, dz);
    if (distance > CAPSTAN_REACH) {
      this.leaveCapstan();
      return false;
    }

    // Fica na circunferência das barras, mas **caminhando** até ela em vez de
    // saltar: quem apertou o botão a dois metros do eixo se aproxima da barra
    // como quem se aproxima, não como quem é teleportado.
    const angle = Math.atan2(dx, dz);
    const radius = damp(distance, CAPSTAN_RADIUS, 7, dt);

    // **Andar para vante é dar a volta, e só andar para vante.** O jogador não
    // precisa girar o mouse acompanhando a barra: a barra é que descreve o
    // círculo, e o corpo dele vai atrás dela. Projetar a direção do olhar na
    // tangente parecia mais honesto e era injogável — a um quarto de volta o
    // olhar fica perpendicular ao caminho, a projeção zera e o marujo trava com
    // a âncora no meio da subida.
    //
    // Só a componente de vante conta, e essa é a diferença que faz o gesto ser
    // um gesto: com a magnitude do analógico, empurrar o cabrestante era virar
    // o stick para qualquer lado — de lado, para trás, em diagonal, tanto fazia.
    // Uma barra de cabrestante se empurra de peito, na direção em que o corpo
    // está indo, e é isso que o jogador faz agora.
    //
    // E o sentido é sempre o de recolher, porque o cabrestante tem linguete:
    // empurrar a barra ao contrário não larga a amarra de volta. Não há o que
    // decidir aqui, então não se pede uma decisão ao jogador.
    const effort = clamp(move.y, 0, 1);
    const swept = (effort * CAPSTAN_WALK_SPEED * dt) / Math.max(radius, 0.2);
    const next = angle + swept;

    this.local.x = CAPSTAN_STAND.x + Math.sin(next) * radius;
    this.local.z = CAPSTAN_STAND.z + Math.cos(next) * radius;
    this.local.y = this.surfaceAt(this.local.x, this.local.z, this.local.y);
    this.grounded = true;

    // **A velocidade tangencial de verdade, e não zero.** Quem escreve a posição
    // aqui é a órbita, então este vetor não move ninguém — mas é dele que saem o
    // relógio da passada e o rumo do corpo (`PlayerAvatar`), e com zero o pirata
    // dava a volta inteira em pose de parado, deslizando de lado feito peça de
    // tabuleiro. A tangente é a derivada da posição no círculo: (cos, −sen).
    const pace = effort * CAPSTAN_WALK_SPEED;
    this.velocity.set(Math.cos(next) * pace, 0, -Math.sin(next) * pace);

    this.followCapstan(dt, next, swept, effort);

    // O comando vai direto para o navio, e **não** pela peça interativa.
    //
    // Passar por `Interaction` exigiria que o cabrestante estivesse em foco, e
    // ele deixa de estar assim que o marujo dá o primeiro quarto de volta — a
    // barra sai do cone de visão porque o corpo dela é que está girando. O
    // resultado era andar em círculo sem recolher nada. Quem sabe que está
    // empurrando é quem está empurrando.
    this.capstanTurns = swept / TAU;
    ship.controls.capstanTurns += this.capstanTurns;
    this.updateBob(dt);
    return true;
  }

  /**
   * A cabeça acompanha a volta em torno do cabrestante.
   *
   * Sem isto, o corpo descrevia o círculo e o olhar ficava onde o jogador o
   * tinha deixado: dava para suspender o ferro inteiro **de costas para a
   * peça**, ou olhando para o céu, e o que se via na tela era o convés girando
   * sozinho sem explicação. Empurrar uma barra é um gesto de corpo inteiro —
   * quem empurra olha para onde a barra vai.
   *
   * Conduzido, e não travado. O jogador continua podendo virar a cabeça para ver
   * onde está o inimigo enquanto trabalha — a mira dele só volta sozinha para a
   * barra quando ele solta o mouse, e volta mais firme quanto mais rápido ele
   * anda. Travar de vez seria tirar dele a única coisa que ainda dá para fazer
   * com as mãos ocupadas: olhar em volta.
   *
   * @param angle posição angular do marujo em torno do eixo, já avançada.
   * @param swept quanto o corpo girou em torno do eixo neste quadro, em radianos.
   * @param effort quanto do curso de caminhada está sendo pedido, 0 a 1.
   */
  private followCapstan(dt: number, angle: number, swept: number, effort: number): void {
    // **A cabeça gira junto com o corpo, grau a grau.**
    //
    // Sem este termo o acompanhamento vira perseguição, e perseguição por
    // amortecimento tem erro permanente: a volta corre a ~1,7 rad/s e nenhum λ
    // jogável fecha essa conta, então a barra ficava um quinto de radiano fora
    // do centro da tela o tempo todo. Com o giro do corpo somado direto ao rumo,
    // o amortecimento abaixo só tem de corrigir o que sobra — que é o desvio que
    // o **jogador** pediu com o mouse, e não o que o círculo impôs.
    this.yaw += swept;

    // A tangente do círculo, no sentido do giro. `angle` é medido de +Z para
    // +X (`atan2(dx, dz)`), então a posição é (sen, cos) e a tangente sai da
    // derivada: (cos, −sen).
    //
    // O rumo `yaw` olha para (−sen yaw, −cos yaw) — a mesma convenção do
    // movimento e da matriz do olho —, e casar as duas dá `atan2(−cos, sen)`.
    // Havia um sinal trocado aqui: o alvo era o **espelho** do rumo certo e
    // contra-rotacionava, batendo com o correto só em dois pontos da volta. Era
    // isso, e não o amortecimento, que fazia a vista rodar solta em torno da
    // peça enquanto o corpo dava a volta.
    const heading = Math.atan2(-Math.cos(angle), Math.sin(angle));

    // Sempre no caminho curto, senão a volta pelo lado errado dá um giro de
    // quase 360° toda vez que a passada cruza a popa.
    let delta = (heading - this.yaw) % TAU;
    if (delta > Math.PI) delta -= TAU;
    if (delta < -Math.PI) delta += TAU;

    // Conduzido, e não travado: o jogador ainda vira a cabeça para achar o
    // inimigo enquanto trabalha, e a mira volta sozinha para a barra quando ele
    // solta o mouse — mais firme quanto mais rápido ele anda.
    const lambda = CAPSTAN_LOOK_LAMBDA + CAPSTAN_LOOK_LAMBDA_PER_EFFORT * effort;
    this.yaw = damp(this.yaw, this.yaw + delta, lambda, dt);
    // E o queixo desce para as barras: é onde as mãos estão.
    this.pitch = damp(this.pitch, CAPSTAN_PITCH, lambda * 0.7, dt);
  }

  /**
   * Sobe e desce a escada do mastro. Frente sobe, ré desce.
   *
   * Chama-se `updateLadder` e não `climb` porque `climb` agora é o **relógio**
   * da escalada, ao lado de `gait` e `jump`.
   */
  private updateLadder(dt: number, frame: InputFrame, forward: number): void {
    // Solta no meio do caminho — daí em diante é queda.
    //
    // O botão de interação larga a escada tanto quanto o de sair: é ele que
    // agarra, e um comando que prende sem soltar deixa o jogador procurando a
    // tecla certa pendurado a nove metros do convés. A borda de pressionada é o
    // que impede o mesmo toque que agarrou de soltar — quando este código roda,
    // aquele frame já passou (o foco de interação corre *depois* do jogador).
    if (
      pressed(frame, InputBit.Jump) ||
      pressed(frame, InputBit.Exit) ||
      pressed(frame, InputBit.Interact)
    ) {
      this.onLadder = false;
      this.grounded = false;
      return;
    }

    // Na escada `grounded` é falso, mas ninguém está voando: alimentar o relógio
    // com esse falso deixaria o clipe de ar grudado no personagem durante a
    // subida inteira, e o pouso dispararia ao chegar ao cesto.
    this.jump.settle(dt);
    // A passada também tem de se apagar: sem isto o corpo mistura caminhada com
    // escalada enquanto o jogador estiver com a tecla de andar apertada.
    this.gait.update(dt, 0, true);

    const rise = forward * CLIMB_SPEED * dt;
    this.local.y += rise;
    // O relógio da escada anda pela **altura**, não pelo tempo — é o que crava a
    // mão na barra em qualquer velocidade e o que faz descer ser o mesmo gesto
    // ao contrário, sem clipe separado.
    this.climb.update(dt, true, rise);
    // Centraliza nos montantes: subir torto lê como bug.
    this.local.x = damp(this.local.x, 0, 10, dt);
    this.local.z = damp(this.local.z, MAST_LADDER.z + LADDER_STANDOFF, 10, dt);
    this.velocity.set(0, 0, 0);
    this.grounded = false;

    // Chegou ao cesto: entra pelo portaló e vira gente de pé outra vez.
    //
    // Sai para o lado de **vante** do mastro, e não colado na escada: quem
    // acabou de subir precisa de meio metro de cesto entre ele e o vão por onde
    // veio, senão o primeiro passo o joga de volta para o buraco.
    if (this.local.y >= CROW_NEST.y) {
      this.onLadder = false;
      this.local.y = CROW_NEST.y;
      this.local.z = CROW_NEST.z - 0.5;
      this.grounded = true;
      return;
    }

    if (this.local.y <= MAST_LADDER.bottomY) {
      this.onLadder = false;
      this.local.y = this.surfaceAt(this.local.x, this.local.z, MAST_LADDER.bottomY + 0.3);
      this.grounded = true;
    }
  }

  // -- estações ----------------------------------------------------------------

  private updateHelm(dt: number, frame: InputFrame, ship: Ship): void {
    this.applyLook(frame);
    this.fov = damp(this.fov, this.baseFov, 10, dt);

    // A/D (ou o analógico) giram a roda. Sem auto-centragem, como no jogo: a
    // roda fica onde foi deixada e o leme junto.
    ship.controls.wheel = frame.moveX;

    // E o corpo lê a roda de volta. O relógio do timão é indexado pelo **ângulo
    // dela**, como o da escada é pela altura vencida: 45° de roda é um punho, e a
    // mão troca de punho no ângulo em que o punho seguinte chega debaixo dela.
    // Girar para bombordo é o mesmo ciclo com a fase recuando, e isso cai de
    // graça da conta — não há sentido de giro para tratar aqui.
    this.helm.update(dt, true, ship.rudder.wheelAngle);

    this.local.copy(HELM_STAND);
    this.velocity.set(0, 0, 0);
    this.settleBob(dt);
  }

  private updateCannon(dt: number, frame: InputFrame, ship: Ship): void {
    const cannon = ship.cannons[this.cannonIndex];
    if (!cannon) {
      this.leaveStation();
      return;
    }

    // O olhar não vira a cabeça: vira a peça. Os deltas já vêm em radianos, o
    // que faz a sensibilidade do canhão ser a mesma da mira a pé.
    cannon.aim(-frame.lookX, -frame.lookY);

    if (pressed(frame, InputBit.Reload)) ship.loadCannon(this.cannonIndex);
    if (pressed(frame, InputBit.Fire)) cannon.triggerPull();

    const aiming = held(frame, InputBit.Aim);
    const target = aiming ? this.baseFov * AIM_FOV_RATIO : this.baseFov;
    this.fov = damp(this.fov, target, 9, dt);

    // O jogador fica de pé ao lado da culatra; a câmera é que vai para trás do
    // cano. Manter os pés no lugar certo importa para o dano por região depois.
    this.local.copy(this.stationReturn);
    this.velocity.set(0, 0, 0);
    this.settleBob(dt);
  }

  // -- colisão e chão ----------------------------------------------------------

  /**
   * Altura do piso sob um ponto.
   *
   * O buraco da escotilha é a única descontinuidade: dentro dele não há convés,
   * e é por isso que se cai no porão ao passar por cima com a tampa aberta.
   */
  private surfaceAt(x: number, z: number, feetY: number): number {
    // A gávea é a única plataforma acima do convés, e ela ganha prioridade sobre
    // tudo: quem está lá em cima está a nove metros de qualquer outro piso.
    const nest = this.crowNestSurface(x, z, feetY);
    if (nest !== null) return nest;

    const t = zToT(z);
    const deck = walkableY(t) + deckCamber(x, deckHalfWidth(t));

    if (!isOverHatch(x, z)) {
      // Estar mais de um degrau abaixo do convés significa estar no porão, e aí
      // o convés vira teto em vez de chão.
      return feetY >= deck - STEP_HEIGHT ? deck : HOLD_FLOOR_Y;
    }

    // Dentro do vão da escotilha: o chão é o degrau do lance onde ele existe, e
    // o piso do porão no resto do buraco. É isto que faz descer ao porão ser um
    // ato de andar — nenhuma tecla, nenhum modo, nenhum estado.
    return stairSurfaceY(x, z) ?? HOLD_FLOOR_Y;
  }

  /** Altura do piso da gávea sob (x, z), ou `null` fora dela. */
  private crowNestSurface(x: number, z: number, feetY: number): number | null {
    if (feetY < CROW_NEST.y - STEP_HEIGHT) return null;
    const dx = x - 0;
    const dz = z - CROW_NEST.z;
    return dx * dx + dz * dz <= CROW_NEST.radius * CROW_NEST.radius ? CROW_NEST.y : null;
  }

  private resolveGround(): void {
    const surface = this.surfaceAt(this.local.x, this.local.z, this.local.y);
    const tolerance = this.grounded ? STEP_HEIGHT : 0.02;

    if (this.velocity.y <= 0 && this.local.y <= surface + tolerance) {
      // O degrau que o pé acabou de vencer vira dívida da vista, não salto.
      //
      // Só vale para quem **já estava** no chão: cair de uma altura e amortecer
      // a queda com a mesma conta daria aquela aterrissagem flutuante de jogo
      // com câmera mal presa. Quem cai, cai; quem anda, anda macio.
      if (this.grounded) this.absorbStep(surface - this.local.y);

      this.local.y = surface;
      this.velocity.y = 0;
      this.grounded = true;
      return;
    }

    this.grounded = false;
  }

  /**
   * Guarda um degrau para a vista alcançar, em vez de teleportar a cabeça.
   *
   * O grampo em `STEP_HEIGHT` é o que separa degrau de queda: nada acima de meio
   * metro é subida a pé, e alisar mais que isso esconderia do jogador que ele
   * caiu de algum lugar.
   */
  private absorbStep(rise: number): void {
    if (Math.abs(rise) < 1e-4) return;
    this.stepOffset = clamp(this.stepOffset + rise, -STEP_HEIGHT, STEP_HEIGHT);
  }

  private decayStep(dt: number): void {
    const magnitude = Math.abs(this.stepOffset);
    if (magnitude < 1e-4) {
      this.stepOffset = 0;
      return;
    }

    const speed = Math.hypot(this.velocity.x, this.velocity.z);
    const ceiling = STEP_SMOOTH_BASE_RATE + STEP_SMOOTH_RATE_PER_SPEED * speed;
    // Exponencial no fim do movimento, onde ele é bom: é o que tira a quina de
    // "parou de repente" quando a dívida chega perto de zero.
    const rate = Math.min(magnitude * STEP_SMOOTH_LAMBDA, ceiling);
    const move = Math.min(rate * dt, magnitude);
    this.stepOffset -= Math.sign(this.stepOffset) * move;
  }

  /**
   * O convés como teto, para quem está no porão.
   *
   * Existe porque o convés passou a ter face de baixo: sem esta trava, um pulo
   * no porão levava a câmera para dentro da madeira e, de lá, atravessava para o
   * outro lado — e o mundo visto de dentro de uma face traseira é o vazio. Sob a
   * escotilha não há teto nenhum, que é por onde se sobe.
   */
  private resolveCeiling(): void {
    if (!this.inHold) return;

    const t = zToT(this.local.z);
    if (isOverHatch(this.local.x, this.local.z)) return;

    // O piso ganha do teto quando os dois brigam: o pé direito do porão e a
    // altura do olho estão a dois centímetros um do outro, e se um ajuste
    // futuro inverter essa margem é melhor a cabeça raspar do que o jogador
    // afundar no assoalho e ser empurrado de volta a cada quadro.
    const limit = Math.max(ceilingY(t, this.local.x) - HEAD_CLEARANCE, HOLD_FLOOR_Y);
    if (this.local.y <= limit) return;

    this.local.y = limit;
    if (this.velocity.y > 0) this.velocity.y = 0;
  }

  /** Mantém o jogador dentro do costado, no convés ou no porão. */
  private resolveHull(): void {
    // Na gávea o casco não tem nada a dizer: o limite lá é a parede do cesto, e
    // aplicar a faixa do convés a nove metros de altura arrastaria o jogador
    // para dentro do mastro.
    if (this.onCrowNest()) {
      const dz = this.local.z - CROW_NEST.z;
      const distance = Math.hypot(this.local.x, dz);
      const limit = CROW_NEST.radius - PLAYER_RADIUS;
      if (distance > limit && distance > 1e-4) {
        const scale = limit / distance;
        this.local.x *= scale;
        this.local.z = CROW_NEST.z + dz * scale;
      }
      return;
    }

    const hold = this.inHold;
    const range = hold ? this.holdRange : this.deckRange;
    this.local.z = clamp(this.local.z, range.min, range.max);

    const t = zToT(this.local.z);
    const half = hold
      ? halfWidthAtHeight(t, HOLD_FLOOR_Y + 0.5) - HULL_THICKNESS
      : deckHalfWidth(t);
    const limit = Math.max(half - PLAYER_RADIUS, 0);
    this.local.x = clamp(this.local.x, -limit, limit);
  }

  /**
   * `true` quando o jogador está de pé no cesto da gávea.
   *
   * Público porque o prompt da escada precisa da **mesma** resposta para
   * escolher entre "subir" e "descer". Havia dois limiares para essa pergunta,
   * 20 cm um do outro, e duas alturas diferentes para a mesma dúvida é uma
   * divergência esperando um degrau novo para aparecer.
   */
  onCrowNest(): boolean {
    return this.local.y > CROW_NEST.y - STEP_HEIGHT;
  }

  private resolveBlockers(): void {
    // Na gávea o único estorvo é o mastro, e ele tem 13 cm de raio ali em cima
    // contra os 34 do pé. Reaproveitar o raio do convés a nove metros de altura
    // ocuparia o cesto inteiro e o jogador não teria onde ficar.
    if (this.onCrowNest()) {
      this.pushOutOf(0, CROW_NEST.z, CROW_NEST.mastRadius + 0.04);
      return;
    }

    const hold = this.inHold;

    for (const blocker of this.blockers) {
      if (hold && !blocker.throughHold) continue;
      this.pushOutOf(blocker.x, blocker.z, blocker.radius);
    }
  }

  /** Empurra o jogador para fora de um cilindro vertical em (x, z). */
  private pushOutOf(x: number, z: number, radius: number): void {
    const dx = this.local.x - x;
    const dz = this.local.z - z;
    const distance = Math.hypot(dx, dz);
    const minimum = radius + PLAYER_RADIUS;
    if (distance >= minimum) return;

    // Empurra para fora pela normal. Colado no eixo (distância ~0) escolhe uma
    // direção qualquer em vez de dividir por zero.
    const nx = distance > 1e-4 ? dx / distance : 1;
    const nz = distance > 1e-4 ? dz / distance : 0;
    this.local.x = x + nx * minimum;
    this.local.z = z + nz * minimum;

    // Mata só a componente que entrava no obstáculo: deslizar rente à peça é
    // o que faz contornar um canhão parecer natural em vez de travar.
    const into = this.velocity.x * nx + this.velocity.z * nz;
    if (into < 0) {
      this.velocity.x -= into * nx;
      this.velocity.z -= into * nz;
    }
  }

  // -- cabeça ------------------------------------------------------------------

  /**
   * A cabeça, a partir do que o quadro de entrada traz.
   *
   * ## Duas formas de dizer a mesma coisa, e por que as duas existem
   *
   * **Localmente**, o olhar é um *delta*: o mouse entrega deslocamento, não
   * posição, e integrar é o que dá a rotação. É o caminho de sempre, e é o único
   * no duelo contra a máquina.
   *
   * **Pela rede**, o olhar chega *absoluto*, e a diferença é o que decide se o
   * outro jogador consegue usar as peças do navio dele. Integrando deltas do
   * outro lado, basta **um** pacote perdido para o ângulo aqui deixar de ser o
   * ângulo de lá — e o erro nunca mais se fecha, porque não há nada que o traga
   * de volta. O que se vê quando isso acontece não é a cabeça errada (ninguém
   * olha para a cabeça do adversário com essa precisão): é o **foco de
   * interação** divergindo. O jogador do outro lado aponta para o canhão, aperta
   * o botão, e aqui o marujo dele está olhando três metros ao lado, não tem foco
   * nenhum e nada acontece. Medido em duelo: yaw 1,571 de um lado e −0,420 do
   * outro, com a posição batendo na segunda casa.
   *
   * Absoluto, o ângulo é o mesmo por construção, e um pacote perdido custa um
   * quadro de suavidade em vez de uma dessincronização permanente.
   */
  private applyLook(frame: InputFrame): void {
    if (frame.absoluteView) {
      this.yaw = frame.yaw;
      this.pitch = clamp(frame.pitch, -PITCH_LIMIT, PITCH_LIMIT);
      return;
    }
    this.yaw -= frame.lookX;
    this.pitch = clamp(this.pitch - frame.lookY, -PITCH_LIMIT, PITCH_LIMIT);
  }

  /**
   * Assenta o balanço quando o jogador está numa estação.
   *
   * Zerar só o `bobOffset` não basta desde que existe corpo: o relógio da
   * passada continuaria com o valor do último quadro em que se andava, e quem
   * assumisse o timão **correndo** deixaria o personagem congelado em pose de
   * corrida atrás da roda. Alimentar o relógio com velocidade zero faz a
   * locomoção se apagar sozinha e o parado assumir.
   */
  private settleBob(dt: number): void {
    this.gait.update(dt, 0, true);
    this.climb.update(dt, false, 0);
    // O timão é a exceção entre as estações, e a guarda é obrigatória: quem está
    // no leme já alimentou este relógio com o ângulo da roda, em `updateHelm`, e
    // um segundo `damp` no mesmo quadro puxaria o peso de volta para baixo. Os
    // dois se equilibrariam com meio timoneiro na tela — e a outra metade do
    // orçamento de pesos iria para o parado, de mãos no vazio.
    if (this.station !== 'helm') this.helm.update(dt, false, 0);
    // `settle` e não `update`: quem assume o timão em pleno salto não aterrissa,
    // é teleportado para trás da roda. Um pouso disparado ali sairia com o
    // personagem se agachando de pé no posto.
    this.jump.settle(dt);
    this.bobOffset = damp(this.bobOffset, 0, 12, dt);
    // Numa estação o corpo é teleportado para a pose da peça, e um resto de
    // degrau sobrando ali cairia como um afundão de cabeça ao assumir o leme.
    this.stepOffset = 0;
  }

  private updateBob(dt: number): void {
    const speed = Math.hypot(this.velocity.x, this.velocity.z);
    this.gait.update(dt, speed, this.grounded);
    // Fora da escada o clipe de escalada se apaga sozinho. A **fase** fica onde
    // parou de propósito: quem larga a escada e reagarra dois metros acima não
    // recomeça o ciclo do zero — `align` reencontra a barra a partir dela.
    this.climb.update(dt, false, 0);
    // E o mesmo com o timão, que é o que faz o timoneiro largar a roda ao sair
    // do posto em vez de sair andando pelo convés de mãos em concha.
    this.helm.update(dt, false, 0);
    // Depois de `resolveGround`, de propósito: é ele quem decide se este quadro
    // é voo ou contato, e o relógio do pulo precisa da resposta já tomada.
    this.jump.update(dt, this.velocity.y, this.grounded);

    if (this.gait.moving > 0.001) {
      // Nem a cadência nem a altura são inventadas aqui. A cadência sai da
      // distância que a passada cobre no chão — a mesma conta que põe o pé do
      // personagem parado no convés durante o apoio. A altura sai do clipe, em
      // metros: é **o mesmo movimento** que levanta o quadril do corpo que o
      // jogador está vestindo, e não uma versão exagerada dele.
      //
      // Saiu daqui um `min(speed / RUN_SPEED, 1)` que atenuava o balanço em
      // velocidade baixa. Ele fazia sentido enquanto a amplitude era um número
      // solto; contra a amplitude do clipe é contagem dupla, e o que ele produz
      // é justamente o deslizamento que se está consertando — a câmera subindo
      // menos do que o tronco que ela deveria acompanhar.
      const target = this.gait.bounceMeters * this.gait.moving;
      this.bobOffset = damp(this.bobOffset, target, BOB_LAMBDA, dt);
    } else {
      this.bobOffset = damp(this.bobOffset, 0, 9, dt);
    }
  }

  /** A pose **do passo**, em coordenadas locais. Quem a mostra é `syncView`. */
  private updateEye(): void {
    // Os pés **de mentira** primeiro: são eles que a câmera e o corpo seguem, e
    // eles ficam o resto de degrau atrás dos pés de verdade. Ver `absorbStep`.
    this.simVisualLocal.set(this.local.x, this.local.y - this.stepOffset, this.local.z);
    this.simEyeLocal.set(
      this.simVisualLocal.x,
      this.simVisualLocal.y + EYE_HEIGHT + this.bobOffset,
      this.simVisualLocal.z,
    );
  }

  /**
   * A pose que a câmera e o corpo usam neste quadro.
   *
   * ## Por que o olhar não é interpolado como a posição
   *
   * A posição vem de dois passos e é interpolada por `alpha` — é a mesma técnica
   * do casco, e o atraso de meio passo que ela introduz é invisível num corpo que
   * anda a 3 m/s.
   *
   * O **olhar**, não. Interpolar a cabeça a 60 Hz numa tela de 144 é a diferença
   * entre uma mira que gruda no mouse e uma que arrasta, e não existe jogador que
   * não sinta. Por isso a rotação é composta de dois pedaços: o que a simulação
   * já absorveu (`yaw`/`pitch`) mais o que chegou depois do último passo e ainda
   * não foi consumido (o resíduo, que vem de `InputSampler`).
   *
   * A soma é **contínua na troca**: quando o passo fixo consome o resíduo, `yaw`
   * anda exatamente o que o resíduo valia e o resíduo zera no mesmo instante, de
   * modo que `yaw + resíduo` não muda. O grampo do `pitch` é aplicado dos dois
   * lados pela mesma razão — sem ele, olhar para o alto acumularia um resíduo
   * fora do limite que teria de ser "desandado" antes de a cabeça descer.
   *
   * @param residualX olhar horizontal ainda não consumido, em radianos.
   * @param residualY idem, vertical.
   */
  syncView(alpha: number, residualX: number, residualY: number, ship: Ship): void {
    if (this.station === 'cannon' && this.applyCannonView(alpha, ship)) return;

    this.visualLocal.lerpVectors(this.previousVisualLocal, this.simVisualLocal, alpha);
    this.eyeLocal.lerpVectors(this.previousEyeLocal, this.simEyeLocal, alpha);

    _euler.set(
      clamp(this.pitch - residualY, -PITCH_LIMIT, PITCH_LIMIT),
      this.yaw - residualX,
      0,
    );
    this.eyeQuaternion.setFromEuler(_euler);
  }

  /**
   * Pose da câmera quando o jogador está no canhão: atrás e um pouco acima da
   * culatra, alinhada com o cano. Como a linha da câmera é **paralela** à alma,
   * a mira da tela vale como referência de pontaria — e o tombo da bala continua
   * por conta de quem atira, que é o que o duelo pede.
   *
   * Aqui o resíduo de olhar **não** entra, e não é esquecimento: no canhão o
   * olhar gira a peça, não a cabeça. Adiantar a câmera sem adiantar o cano faria
   * o tubo nadar contra a mira — e a mira é justamente o que esta vista existe
   * para dar. A suavidade vem da pose interpolada do próprio canhão.
   *
   * @returns `false` quando o canhão sumiu — o chamador cai na vista a pé.
   */
  private applyCannonView(alpha: number, ship: Ship): boolean {
    const cannon = ship.cannons[this.cannonIndex];
    if (!cannon) return false;

    cannon.getBarrelQuaternion(this.eyeQuaternion, alpha);
    cannon.getPivotLocal(_pivot);
    this.eyeLocal.set(0, 0.45, 1.35).applyQuaternion(this.eyeQuaternion).add(_pivot);
    // Os pés continuam onde o passo os deixou: quem os desenha é o corpo, e ele
    // não acompanha a culatra.
    this.visualLocal.lerpVectors(this.previousVisualLocal, this.simVisualLocal, alpha);
    return true;
  }

  private saveReturn(): void {
    this.stationReturn.copy(this.local);
    this.stationReturnYaw = this.yaw;
  }
}

/**
 * Varre o casco e devolve a faixa de Z em que ainda cabe alguém de pé.
 *
 * Sem isso o jogador andaria até a ponta da proa, onde o convés tem meio palmo
 * de largura, e ficaria pendurado no ar com o corpo do lado de fora do costado.
 */
function measureWalkRange(halfWidthAt: (t: number) => number): { min: number; max: number } {
  const needed = PLAYER_RADIUS + 0.08;
  let tMin = 0.02;
  let tMax = 0.98;

  for (let i = 0; i <= 200; i++) {
    const t = i / 200;
    if (halfWidthAt(t) >= needed) {
      tMin = t;
      break;
    }
  }
  for (let i = 200; i >= 0; i--) {
    const t = i / 200;
    if (halfWidthAt(t) >= needed) {
      tMax = t;
      break;
    }
  }

  // `t` cresce em direção à proa e Z diminui: os extremos trocam de lado.
  return { min: tToZ(tMax), max: tToZ(tMin) };
}
