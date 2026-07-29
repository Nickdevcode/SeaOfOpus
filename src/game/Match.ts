/**
 * A partida: dois navios, um duelo, e o que acontece quando um deles vai ao fundo.
 *
 * Este módulo é dono de **tudo que é jogo** — os dois cascos, o capitão inimigo, as
 * balas no ar, os efeitos, o jogador a bordo e as peças que ele usa. O que fica
 * fora dele é a *apresentação*: renderizador, cena, câmera, ambiente, motor e
 * entrada continuam sendo do `main.ts`. A divisa é útil na prática: reiniciar uma
 * partida é um método daqui, e não uma reconstrução do mundo — o oceano, o céu e as
 * texturas do navio nunca são refeitos, e trocar de dificuldade custa poucos
 * milissegundos em vez dos décimos de segundo que `createShipAssets` leva.
 *
 * ## A ordem do passo de física, que não é arbitrária
 *
 * 1. **Contato entre cascos**, antes de tudo. As forças ficam acumuladas em
 *    `ShipBody` e entram no passo que começa agora — ver a nota em `HullContact`.
 * 2. **O capitão inimigo**, antes do navio dele. Timão, pontaria e gatilho deste
 *    passo têm de valer neste passo, e não no seguinte.
 * 3. **Os navios**, cada um integrando a própria física.
 * 4. **As balas**, por último, porque o teste de acerto lê a pose que os navios
 *    acabaram de escrever. Ao contrário, a bala atravessaria um casco de um passo
 *    atrás.
 *
 * Trocar 2 e 3 dá um inimigo que reage sempre um passo tarde; trocar 3 e 4 dá balas
 * que erram por 1,6 m. Nenhuma das duas aparece como bug óbvio, e é por isso que a
 * ordem está escrita aqui.
 */

import * as THREE from 'three';
import { DIFFICULTIES, type DifficultyId, type DifficultyPreset } from '../ai/Difficulty';
import { ShipAI } from '../ai/ShipAI';
import { CannonballPool, type BallImpact } from '../combat/Cannonball';
import { Effects } from '../combat/Effects';
import {
  createContactReport,
  resolveHullContact,
  type ContactReport,
} from '../combat/HullContact';
import { disposeCharacterAsset } from '../player/CharacterAsset';
import { PlayerAvatar } from '../player/PlayerAvatar';
import type { Interaction } from '../player/Interaction';
import type { PlayerController } from '../player/PlayerController';
import { DamageView } from '../ship/DamageView';
import { Ship } from '../ship/Ship';
import { createShipAssets, type ShipAssets } from '../ship/ShipBuilder';
import { downwindHeading } from '../ship/SailSim';
import type { Environment } from '../world/Environment';
import type { InputFrame } from '../core/InputFrame';
import { Crewman } from './Crewman';
import type { MatchEvent, ShipSlot } from './MatchEvents';

export type MatchState = 'menu' | 'fighting' | 'won' | 'lost';

/**
 * Quem manda na simulação.
 *
 * `solo` e `host` percorrem exatamente o mesmo caminho de código — a única
 * diferença é de onde vem a entrada do segundo navio. `guest` é o cliente magro:
 * ele não integra casco nenhum, recebe a pose pronta e simula só o próprio corpo.
 */
export type MatchRole = 'solo' | 'host' | 'guest';

/** A entrada de um passo, um quadro por navio. */
export interface MatchInputs {
  readonly player: InputFrame;
  /** `null` quando quem pilota o navio inimigo é o `ShipAI`. */
  readonly enemy: InputFrame | null;
}

/** Nome dos navios. É o mesmo `owner` que os tiros de cada um carregam. */
const PLAYER_SHIP = 'player-sloop';
const ENEMY_SHIP = 'enemy-sloop';

/**
 * Distância inicial entre os dois, em metros.
 *
 * 220 m é escolhido pelo relógio, não pela régua: fora do alcance de tiro de
 * qualquer dificuldade (a Lenda abre fogo a 155 m), e a ~5 m/s de aproximação
 * mútua dá perto de meio minuto antes do primeiro tiro. É o tempo de o jogador
 * assumir o timão, descer e carregar as duas peças e voltar ao convés — a partida
 * começa com uma tarefa, não com um susto.
 */
const SPAWN_RANGE = 220;

/**
 * Marcação em que o inimigo nasce, relativa à proa do jogador.
 *
 * Negativa é boreste, e é de propósito: `PlayerController` põe a cabeça do jogador
 * virada 24° para boreste no spawn, para a primeira vista do jogo mostrar o convés
 * em vez do mastro. Pondo a vela inimiga no mesmo lado, a primeira coisa que ele vê
 * ao aparecer no convés é com quem vai brigar.
 */
const SPAWN_BEARING = -0.45;

/**
 * Tingimento da vela inimiga: carmim sujo, quase seco.
 *
 * Escuro o bastante para a silhueta ler como ameaça contra céu claro, e ainda
 * assim visível contra o mar à noite — a vela crua do jogador some no cinza da
 * bruma, esta não. Ver `tintSail` para o porquê de ser multiplicação.
 */
const ENEMY_SAIL = 0x8a2f28;

/**
 * O personagem, em disco. Um arquivo para os dois corpos a bordo.
 *
 * `BASE_URL` é o prefixo com que o Vite publica o `public/` — em produção ele
 * pode não ser a raiz do domínio, e um caminho absoluto cravado aqui daria um
 * 404 silencioso que só apareceria como "os piratas sumiram" depois do deploy.
 */
const CHARACTER_MODEL = `${import.meta.env.BASE_URL}models/pirate.glb`;

/** Números da partida, para a tela de fim. */
export interface MatchStats {
  /** Segundos de combate. */
  duration: number;
  /** Tiros que o jogador deu. */
  shotsFired: number;
  /** Tiros do jogador que encontraram o casco ou o mastro inimigo. */
  shotsLanded: number;
  /** Rombos que o jogador abriu no inimigo. */
  breachesDealt: number;
  /** Rombos que o jogador levou. */
  breachesTaken: number;
}

/**
 * Avisos da partida para quem quiser reagir — áudio e interface.
 *
 * Callbacks opcionais em vez de um emissor de eventos: são cinco avisos, todos com
 * assinatura própria, e um `Map<string, Function[]>` aqui só trocaria checagem de
 * tipo por texto solto.
 */
export interface MatchListener {
  /** Um canhão disparou. `byPlayer` distingue o estrondo perto do longe. */
  onShot?(position: THREE.Vector3, direction: THREE.Vector3, byPlayer: boolean): void;
  onSplash?(position: THREE.Vector3, speed: number): void;
  /** Bala na madeira. `flooded` é `true` quando abriu rombo que alaga. */
  onHullHit?(position: THREE.Vector3, speed: number, onPlayer: boolean, flooded: boolean): void;
  onMastHit?(position: THREE.Vector3, speed: number): void;
  /** Os dois cascos se encostaram. */
  onCollision?(position: THREE.Vector3, speed: number): void;
  onStateChange?(state: MatchState, previous: MatchState): void;
}

/** Lista vazia de navios, para o passo do guest. Ver `fixedUpdateRemote`. */
const EMPTY_SHIPS: readonly Ship[] = [];

/** Teto da fila de eventos à espera de instantâneo. Ver `collectNetEvents`. */
const MAX_NET_EVENTS = 64;

const _muzzleDirection = new THREE.Vector3();
const _impactNormal = new THREE.Vector3();
const _jetPosition = new THREE.Vector3();
const _jetDirection = new THREE.Vector3();

export class Match {
  state: MatchState = 'menu';
  role: MatchRole = 'solo';
  difficulty: DifficultyPreset = DIFFICULTIES.corsair;

  /**
   * Passos desde o início desta partida.
   *
   * O relógio do duelo, e não o do processo — `Engine.tick` conta desde que a
   * página abriu. É este que carimba entrada e instantâneo na rede, porque é este
   * que os dois lados podem zerar juntos.
   */
  tick = 0;

  /**
   * O que aconteceu neste passo. Drenado em `update`. Ver `MatchEvents`.
   */
  readonly events: MatchEvent[] = [];

  /**
   * Os eventos que ainda não foram pelo fio, quando este é o lado que simula.
   *
   * ⚠️ **Existe porque os dois relógios não batem, e isso custou o duelo em rede
   * inteiro.** `events` é do **quadro**: `drainEvents` o esvazia em toda chamada
   * de `update`, que roda uma vez por quadro do monitor. O instantâneo, ao
   * contrário, sai a cada **quatro passos**. A 60 fps são quatro esvaziamentos
   * para cada instantâneo, e o instantâneo só encontrava na lista o que tinha
   * acontecido depois do último deles — três de cada quatro tiros, respingos e
   * impactos nunca chegavam ao outro lado. Como é do evento de tiro que nasce a
   * bala do guest, o efeito era um adversário que atirava sem bala, sem estrondo
   * e sem fumaça, três vezes em cada quatro.
   *
   * Esta lista é do **instantâneo**: quem a esvazia é `HostSession`, depois de
   * escrevê-la no fio. Guardar a mesma referência nas duas é seguro — todo vetor
   * que entra num evento já é clonado por quem o cria.
   */
  readonly netEvents: MatchEvent[] = [];

  readonly assets: ShipAssets;
  readonly playerShip: Ship;
  readonly enemyShip: Ship;
  /**
   * Todos os navios. **A ordem importa em dois lugares:** a esteira centra a área
   * coberta no primeiro, e o teste de acerto pula quem tem o mesmo nome do dono do
   * tiro. O jogador vem primeiro.
   */
  readonly ships: readonly Ship[];

  /**
   * Os dois marujos, na mesma ordem de `ships`. O índice 0 é sempre o local.
   *
   * O segundo existe mesmo contra a máquina, e não é desperdício: é ele que dá ao
   * navio inimigo um corpo e uma lista de peças idênticas às do jogador, de modo
   * que trocar o `ShipAI` por uma pessoa não muda nada além de onde a entrada vem.
   */
  readonly crew: readonly [Crewman, Crewman];

  /**
   * O corpo do jogador. Carrega sozinho e em paralelo: é o único asset binário
   * do projeto, e o jogo tem de estar jogável antes de ele chegar.
   */
  readonly avatar = new PlayerAvatar();

  /**
   * O corpo do adversário, pendurado no casco dele.
   *
   * Mesma classe, mesmos clipes, mesmo arquivo — o que muda é só de onde vem o
   * controlador que o alimenta: no host ele é simulado aqui com a entrada que
   * chega pela rede, e no cliente que não simula a pose vem pronta no
   * instantâneo e `PlayerController.applyRemoteStep` a converte nos relógios de
   * animação. Ver `CharacterAsset` para o porquê de os dois corpos saírem de um
   * download só.
   *
   * Fica **escondido fora do duelo em rede**: contra a máquina quem comanda o
   * outro casco é o `ShipAI`, que não move marujo nenhum, e um pirata plantado
   * no convés sem nunca dar um passo é pior que nenhum pirata.
   */
  readonly enemyAvatar = new PlayerAvatar();
  readonly cannonballs: CannonballPool;
  readonly effects: Effects;

  /** O capitão inimigo. `null` quando quem comanda o outro casco é uma pessoa. */
  ai: ShipAI | null;

  readonly contact: ContactReport = createContactReport();

  readonly stats: MatchStats = {
    duration: 0,
    shotsFired: 0,
    shotsLanded: 0,
    breachesDealt: 0,
    breachesTaken: 0,
  };

  private readonly damageViews: readonly DamageView[];
  /** Rombos de cada navio no passo anterior, para detectar os novos. */
  private previousBreaches = { player: 0, enemy: 0 };

  constructor(
    scene: THREE.Scene,
    /**
     * Mar, vento e céu. Público em leitura porque o duelo depende dele para ser
     * o mesmo dos dois lados — o teste de determinismo o compara, e o
     * instantâneo de rede carrega o vento que sai daqui.
     */
    readonly environment: Environment,
    private readonly listener: MatchListener = {},
  ) {
    // A parte caríssima da inicialização, e roda uma vez só: texturas em canvas
    // 2D mais a varredura do casco. Os dois navios compartilham tudo isso.
    this.assets = createShipAssets();

    this.playerShip = new Ship(this.assets, PLAYER_SHIP);
    this.enemyShip = new Ship(this.assets, ENEMY_SHIP, { sailTint: ENEMY_SAIL });
    this.ships = [this.playerShip, this.enemyShip];

    for (const ship of this.ships) {
      scene.add(ship.model.root);
      // Sem isto o oceano é desenhado por dentro do casco e o porão fica cheio de
      // mar mesmo com o navio seco.
      environment.addHullClip(ship.model.root);
    }

    this.effects = new Effects(scene);
    this.cannonballs = new CannonballPool((impact) => this.onImpact(impact));
    scene.add(this.cannonballs.mesh);

    this.damageViews = this.ships.map((ship) => new DamageView(ship, scene));

    this.crew = [new Crewman(this.playerShip), new Crewman(this.enemyShip)];

    this.ai = new ShipAI(this.enemyShip, this.difficulty);

    // Filhos do modelo de cada navio, não da cena: assim eles acompanham jogo,
    // adernada e avanço sem ninguém recompor nada — a mesma razão de `CameraRig`
    // compor com `ship.model.root`.
    this.avatar.attach(this.playerShip.model.root);
    this.enemyAvatar.attach(this.enemyShip.model.root);
    // Um pedido só de rede para os dois: o segundo `load` encontra o mesmo
    // `Promise` e instancia uma cópia. Ver `CharacterAsset`.
    void this.avatar.load(CHARACTER_MODEL);
    void this.enemyAvatar.load(CHARACTER_MODEL);
    // Só aparece em rede — ver a nota do campo.
    this.enemyAvatar.hidden = true;

    this.deploy();
  }

  /** `true` quando a física e os comandos devem correr. */
  get running(): boolean {
    return this.state === 'fighting';
  }

  /** O marujo local: o corpo que a câmera segue e o que o jogador comanda. */
  get player(): PlayerController {
    return this.crew[0].controller;
  }

  /** O foco contextual do marujo local, que os prompts desenham. */
  get interaction(): Interaction {
    return this.crew[0].interaction;
  }

  /**
   * Distância entre os dois navios, em metros. O HUD desenha a partir daqui.
   *
   * Medida aqui, e não lida de `ai.range`: sem capitão da máquina não haveria de
   * onde ler, e a distância entre dois cascos nunca dependeu de haver um bot.
   */
  get range(): number {
    return this.playerShip.body.comPosition.distanceTo(this.enemyShip.body.comPosition);
  }

  // -- ciclo de vida -----------------------------------------------------------

  /** Começa um duelo novo contra o capitão escolhido. */
  startSolo(id: DifficultyId): void {
    this.role = 'solo';
    this.enemyAvatar.hidden = true;
    this.difficulty = DIFFICULTIES[id];
    // Refeito porque os artilheiros nascem amarrados ao preset — e porque uma
    // semente nova por partida seria o contrário do que se quer: o duelo tem de
    // ser reproduzível para uma queixa de "esse tiro era impossível" ser apurável.
    this.ai = new ShipAI(this.enemyShip, this.difficulty);

    this.deploy();
    this.setState('fighting');
  }

  /**
   * Começa um duelo contra outra pessoa.
   *
   * O capitão da máquina é **descartado**, e não desligado: ele mantém sementes e
   * relógios próprios, e um `ShipAI` vivo em segundo plano num duelo em rede é
   * uma segunda mão escrevendo nos mesmos comandos que a pessoa do outro lado.
   */
  startOnline(role: Exclude<MatchRole, 'solo'>): void {
    this.role = role;
    // E o adversário ganha corpo: do outro lado do fio há alguém que anda,
    // corre, sobe a escada e prega tábua, e agora isso se vê.
    this.enemyAvatar.hidden = false;
    this.ai = null;
    this.deploy();
    this.setState('fighting');
  }

  /**
   * Encerra um duelo em rede com o resultado que a sala anunciou.
   *
   * ⚠️ **Sem isto, o duelo do cliente que não simula nunca acabava.** Quem
   * decide o fim é o host, e a notícia chega pelo lobby; deste lado o estado
   * continuava em `fighting` e o mundo seguia rodando atrás da tela de
   * resultado. Pior: a sessão de rede é desligada junto com o anúncio, e sem
   * ela o passo do quadro seguinte cai no caminho de **quem simula** — com o
   * capitão da máquina descartado e nenhuma entrada para o segundo casco. Os
   * dois navios voltavam a integrar física local, do nada, sob a tela de fim.
   *
   * Não passa por `checkOutcome` porque o veredito não é nosso: aqui só se
   * escreve o que já foi decidido do outro lado do fio.
   */
  endOnline(won: boolean): void {
    if (this.role === 'solo') return;
    this.setState(won ? 'won' : 'lost');
  }

  /**
   * Volta ao menu, com o mundo intacto para servir de plano de fundo.
   *
   * O papel volta a ser `solo` junto, e não é arrumação: enquanto ele ficasse em
   * `guest`, o mundo de fundo continuaria contando estatística de eventos que já
   * não vêm de lugar nenhum, e `collectNetEvents` continuaria enchendo a fila do
   * instantâneo de um duelo que acabou.
   */
  toMenu(): void {
    this.role = 'solo';
    this.enemyAvatar.hidden = true;
    this.deploy();
    this.setState('menu');
  }

  /** Repõe tudo no lugar de partida. */
  private deploy(): void {
    const waves = this.environment.waveField;

    // O jogador nasce com o vento em popa: o rumo mais rápido da Chalupa, e o que
    // deixa a vela cheia e quieta na primeira vista do jogo.
    const heading = downwindHeading(waves);
    this.playerShip.spawn(0, 0, heading, waves);

    const bearing = heading + SPAWN_BEARING;
    this.enemyShip.spawn(
      -Math.sin(bearing) * SPAWN_RANGE,
      -Math.cos(bearing) * SPAWN_RANGE,
      // De proa para o jogador: ele vem brigar, não passeia.
      bearing + Math.PI,
      waves,
    );

    for (const crewman of this.crew) crewman.respawn();

    this.cannonballs.clear();
    this.effects.clear();
    this.events.length = 0;
    this.netEvents.length = 0;
    this.ai?.reset();
    this.tick = 0;

    this.stats.duration = 0;
    this.stats.shotsFired = 0;
    this.stats.shotsLanded = 0;
    this.stats.breachesDealt = 0;
    this.stats.breachesTaken = 0;
    this.previousBreaches.player = 0;
    this.previousBreaches.enemy = 0;

    for (const ship of this.ships) ship.syncModel(1);
  }

  private setState(state: MatchState): void {
    if (state === this.state) return;
    const previous = this.state;
    this.state = state;
    this.listener.onStateChange?.(state, previous);
  }

  // -- passo de física ---------------------------------------------------------

  fixedUpdate(dt: number, inputs: MatchInputs): void {
    const waves = this.environment.waveField;
    // Onde a lista está **antes** deste passo. O que for empilhado daqui para a
    // frente é deste passo, e é o que precisa ser copiado para `netEvents` — ver
    // a nota lá. Ler o comprimento em vez de zerar a lista mantém intacto o que
    // um passo anterior do mesmo quadro deixou para o `drainEvents` desenhar.
    const eventsBefore = this.events.length;
    this.environment.fixedUpdate(dt);

    // A pose das peças móveis antes que alguém mire ou gire a roda. Ver
    // `Ship.beginStep` — tem de vir antes dos marujos, não dentro dos navios.
    for (const ship of this.ships) ship.beginStep();

    if (!this.running) {
      // No menu e nas telas de fim o mundo continua vivo — o mar mexe, o dia
      // corre, os dois navios flutuam. O que para é o duelo.
      for (const ship of this.ships) ship.fixedUpdate(dt, waves);
      return;
    }

    this.tick++;
    this.stats.duration += dt;

    // 1. Contato: forças acumuladas antes de qualquer um integrar.
    const before = this.contact.contacts;
    resolveHullContact(this.playerShip, this.enemyShip, this.contact);
    if (this.contact.contacts > 0 && before === 0 && this.contact.closingSpeed > 0.4) {
      this.events.push({
        kind: 'collision',
        position: this.contact.point,
        speed: this.contact.closingSpeed,
      });
    }

    // 2. Quem comanda, antes dos navios que eles comandam. Timão, pontaria e
    //    gatilho deste passo têm de valer neste passo, e não no seguinte.
    this.crew[0].fixedUpdate(dt, inputs.player);
    if (inputs.enemy) this.crew[1].fixedUpdate(dt, inputs.enemy);
    else this.ai?.fixedUpdate(dt, this.playerShip, waves);

    // 3. Os navios.
    for (const ship of this.ships) {
      ship.fixedUpdate(dt, waves);
      this.drainShots(ship);
    }

    // 4. As balas, sobre a pose recém-integrada.
    this.cannonballs.fixedUpdate(dt, this.ships, waves);

    this.countNewBreaches();
    this.checkOutcome();

    if (this.role === 'host') this.collectNetEvents(eventsBefore);
  }

  /**
   * Copia os eventos deste passo para a fila do instantâneo.
   *
   * O teto é uma rede de segurança, não um orçamento: `HostSession` esvazia a
   * fila a cada quatro passos, então ela nunca passa de uma dúzia num duelo
   * saudável. Se um dia alguém parar de esvaziá-la, o que se quer é um evento
   * antigo perdido, e não memória crescendo até a aba morrer.
   */
  private collectNetEvents(from: number): void {
    for (let i = from; i < this.events.length; i++) {
      if (this.netEvents.length >= MAX_NET_EVENTS) return;
      this.netEvents.push(this.events[i]!);
    }
  }

  /**
   * O passo de quem **não** simula.
   *
   * Curto de propósito, e explicitamente separado de `fixedUpdate` em vez de um
   * punhado de `if` dentro dele: o caminho de quem simula tem de ficar idêntico
   * ao do duelo contra a máquina, byte por byte, ou o modo offline regride toda
   * vez que o netcode mexer em alguma coisa.
   *
   * Aqui não há empuxo, vela, leme, arrasto, contato nem detecção de acerto — a
   * pose dos dois cascos chega pronta e é escrita por `GuestSession`. O que roda
   * é o corpo do jogador local, que é a única coisa que ele controla, e as balas
   * de enfeite, que voam pela mesma balística sem acertar nada.
   *
   * ⚠️ **A fila de tiros é esvaziada sem ser usada.** O canhão local dispara de
   * verdade (recuo, som, munição), mas a bala dele é decidida do outro lado — se
   * ela virasse projétil aqui também, o jogador veria duas.
   */
  fixedUpdateRemote(dt: number, frame: InputFrame): void {
    for (const ship of this.ships) ship.beginStep();
    if (!this.running) return;

    this.tick++;
    this.stats.duration += dt;

    this.crew[0].fixedUpdate(dt, frame);

    // ⚠️ **Depois do marujo, e é o que faz o timão funcionar deste lado.** Ele
    // acabou de escrever `controls.wheel`; sem alguém integrando esse comando, a
    // roda não gira, as mãos não giram e o painel diz `wheel 0%` enquanto o
    // navio guina lá longe por decisão do host. Ver `Ship.fixedUpdateRemote`.
    //
    // Roda para os **dois** cascos: o do adversário não tem comando local (a roda
    // dele fica em zero aqui), e a pose autoritativa dele é escrita logo em
    // seguida por `GuestSession.applyShipParts`, que roda depois deste método e
    // ganha de qualquer coisa que se tenha calculado.
    const waves = this.environment.waveField;
    for (const ship of this.ships) ship.fixedUpdateRemote(dt, waves);

    for (const ship of this.ships) ship.pendingShots.length = 0;

    // Sem navios na lista: nenhuma bala tem contra o que resolver acerto, que é
    // exatamente o que se quer. Ver `CannonballPool.spawnGhost`.
    this.cannonballs.fixedUpdate(dt, EMPTY_SHIPS, this.environment.waveField);

    // Os rombos chegam prontos do host, e contá-los é a única parte das
    // estatísticas que este lado consegue medir sozinho. Sem esta linha a tela
    // de fim de quem não simula mostrava quatro zeros — o duelo inteiro sem
    // número nenhum.
    this.countNewBreaches();
  }

  /**
   * Esvazia a fila de tiros de um navio, pondo cada um no ar.
   *
   * A fila é do **passo**, não do quadro: o canhão empurra o recuo e enfileira o
   * tiro dentro de `fixedUpdate`, e ele vira projétil aqui, com a mesma pose que
   * produziu o recuo. Esvaziar é obrigação de quem consome.
   */
  private drainShots(vessel: Ship): void {
    const slot: ShipSlot = vessel === this.playerShip ? 0 : 1;
    for (const shot of vessel.pendingShots) {
      this.cannonballs.spawn(shot);
      // A velocidade já traz a do navio somada, mas ela é duas ordens de grandeza
      // menor que a de boca: normalizar dá o eixo do cano.
      _muzzleDirection.copy(shot.velocity).normalize();
      // Anotado, não desenhado: quem faz fumaça e estrondo é `update`. Os vetores
      // são clonados porque `shot` volta para o pool no passo seguinte.
      this.events.push({
        kind: 'shot',
        ship: slot,
        position: shot.position.clone(),
        direction: _muzzleDirection.clone(),
      });
      if (slot === 0) this.stats.shotsFired++;
    }
    vessel.pendingShots.length = 0;
  }

  private onImpact(impact: BallImpact): void {
    const speed = impact.velocity.length();

    if (impact.kind === 'water') {
      this.events.push({ kind: 'splash', position: impact.position.clone(), speed });
      return;
    }

    const target = impact.ship;
    const hit = impact.hit;
    if (!target || !hit) return;

    const slot: ShipSlot = target === this.playerShip ? 0 : 1;
    if (slot === 1) this.stats.shotsLanded++;

    if (hit.part === 'mast') {
      this.events.push({ kind: 'mast', ship: slot, position: impact.position.clone(), speed });
    } else {
      // A normal vem em coordenadas do navio; as lascas voam no mundo.
      target.body.localDirToWorld(hit.normal, _impactNormal);
      this.events.push({
        kind: 'hull',
        ship: slot,
        position: impact.position.clone(),
        normal: _impactNormal.clone(),
        speed,
        flooded: hit.floods,
      });
    }

    // `hit` é rascunho compartilhado e só vale durante esta chamada — quem guardar
    // algo dele copia. `registerHit` clona o que precisa.
    target.damage.registerHit(hit);
  }

  /** Conta os rombos que apareceram neste passo, para as estatísticas. */
  private countNewBreaches(): void {
    const player = this.playerShip.damage.breaches.length;
    const enemy = this.enemyShip.damage.breaches.length;

    if (player > this.previousBreaches.player) {
      this.stats.breachesTaken += player - this.previousBreaches.player;
    }
    if (enemy > this.previousBreaches.enemy) {
      this.stats.breachesDealt += enemy - this.previousBreaches.enemy;
    }

    this.previousBreaches.player = player;
    this.previousBreaches.enemy = enemy;
  }

  /**
   * Fim de partida.
   *
   * `isSunk` só vira `true` sete segundos depois do ponto de não retorno, então o
   * jogador **assiste** ao naufrágio antes de a tela aparecer — o que é metade da
   * recompensa de ganhar, e a outra metade da lição de perder.
   */
  private checkOutcome(): void {
    if (this.enemyShip.damage.isSunk) {
      this.setState('won');
      return;
    }
    if (this.playerShip.damage.isSunk) this.setState('lost');
  }

  // -- passo de quadro ---------------------------------------------------------

  /**
   * O quadro: pose interpolada, efeitos e som. Nenhuma decisão de jogo mora aqui.
   *
   * Não recebe mais `input` nem `controlling` — quem comanda o marujo é o passo
   * fixo, e quem decide se ele recebe comando é quem monta o `InputFrame`. Um
   * `if` a menos aqui é um caminho a menos em que o duelo em rede pode divergir
   * do local.
   *
   * @param lookResidualX olhar horizontal que o jogador já fez e nenhum passo
   *   consumiu ainda, em radianos. É o que mantém a câmera na taxa do monitor
   *   com a simulação a 60 Hz — ver `PlayerController.syncView`.
   * @param lookResidualY idem, vertical.
   */
  update(dt: number, alpha: number, lookResidualX = 0, lookResidualY = 0): void {
    this.crew[0].controller.syncView(alpha, lookResidualX, lookResidualY, this.playerShip);
    // O marujo de lá não tem resíduo: ninguém olha pelos olhos dele, e o que se vê
    // dele é o corpo, não a câmera.
    this.crew[1].controller.syncView(alpha, 0, 0, this.enemyShip);

    for (const ship of this.ships) ship.syncModel(alpha);
    this.cannonballs.syncModel(alpha);

    // O corpo do adversário mora aqui, e o do jogador no laço principal, porque
    // só o segundo depende da câmera: é `main.ts` que sabe se ela está nos olhos
    // dele. Ninguém olha pelos olhos deste, então ele é sempre visto de fora — e
    // depois do `syncView` acima, que é quem escreve a pose do quadro.
    this.enemyAvatar.update(dt, this.crew[1].controller, false);

    this.drainEvents();

    // `update` primeiro (é ele que abre a janela do rastro), depois as emissões do
    // quadro, e a janela fecha no fim — assim o rastro tem a mesma densidade a 30 e
    // a 144 fps.
    this.effects.update(dt);
    this.cannonballs.forEachActive((position, velocity) =>
      this.effects.ballTrail(position, velocity),
    );
    this.effects.endTrailWindow();

    for (const ship of this.ships) this.updateWaterJets(ship);
    for (const view of this.damageViews) view.update(dt);
  }

  /**
   * Transforma o que o passo anotou em fumaça, respingo e som, e esvazia a fila.
   *
   * É o único lugar do jogo que liga simulação a apresentação, e é de propósito:
   * no duelo em rede, o cliente que não simula recebe esta mesma lista pelo fio,
   * empilha no mesmo array e chama este mesmo método. Um caminho, dois papéis.
   */
  private drainEvents(): void {
    // Quem não simula não tem `drainShots` nem `onImpact` para contar tiro — o
    // que ele tem é esta lista, que chega pronta do host com os índices já
    // traduzidos para "0 é o meu". É a mesma contagem, medida de onde dá.
    const counting = this.role === 'guest';

    for (const event of this.events) {
      switch (event.kind) {
        case 'shot':
          if (counting && event.ship === 0) this.stats.shotsFired++;
          this.effects.muzzleBlast(event.position, event.direction);
          this.listener.onShot?.(event.position, event.direction, event.ship === 0);
          break;
        case 'splash':
          this.effects.waterSplash(event.position, event.speed);
          this.listener.onSplash?.(event.position, event.speed);
          break;
        case 'hull':
          if (counting && event.ship === 1) this.stats.shotsLanded++;
          this.effects.woodImpact(event.position, event.normal, event.speed);
          this.listener.onHullHit?.(
            event.position,
            event.speed,
            event.ship === 0,
            event.flooded,
          );
          break;
        case 'mast':
          if (counting && event.ship === 1) this.stats.shotsLanded++;
          this.listener.onMastHit?.(event.position, event.speed);
          break;
        case 'collision':
          this.listener.onCollision?.(event.position, event.speed);
          break;
      }
    }
    this.events.length = 0;
  }

  /** Os esguichos que entram pelos rombos abertos, vistos do porão. */
  private updateWaterJets(vessel: Ship): void {
    for (const breach of vessel.damage.breaches) {
      if (breach.inflow <= 0) continue;
      vessel.body.localToWorld(breach.local, _jetPosition);
      vessel.body.localDirToWorld(breach.normal, _jetDirection);
      // `waterJet` esguicha *contra* a direção recebida, e a normal aponta para
      // fora do casco — é a mesma convenção: a água entra empurrando para dentro.
      this.effects.waterJet(_jetPosition, _jetDirection, breach.inflow);
    }
  }

  dispose(): void {
    this.avatar.dispose();
    this.enemyAvatar.dispose();
    // Depois dos dois, sempre: a malha e as texturas são compartilhadas por
    // eles, e liberá-las antes tiraria o chão de debaixo do que ainda estivesse
    // na cena. Ver `CharacterAsset.disposeCharacterAsset`.
    disposeCharacterAsset(CHARACTER_MODEL);
    for (const view of this.damageViews) view.dispose();
    for (const ship of this.ships) ship.dispose();
    this.environment.clearHullClips();
    this.cannonballs.mesh.removeFromParent();
    this.effects.dispose();
    this.assets.dispose();
  }
}
