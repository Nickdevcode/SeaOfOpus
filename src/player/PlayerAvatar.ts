/**
 * O corpo do jogador a bordo: malha, esqueleto e mistura de locomoção.
 *
 * O corpo é olhado de dois lugares, e cada um cobra uma coisa diferente. De fora
 * — a câmera livre, e o adversário no duelo em rede — o defeito que trai um
 * personagem é o pé patinando no convés. De dentro, em primeira pessoa, o que
 * trai é a cabeça: o olho nasce a 1,66 m e o crânio ocupa exatamente essa
 * altura. O primeiro problema se resolve com a fase única da
 * passada, logo abaixo; o segundo com o recorte de `shaders/headClip.ts`, e é
 * por ele que o corpo deixou de ficar escondido em primeira pessoa.
 *
 * Por isso a mistura entre andar e correr **não** é um `lerp` de pesos com cada
 * clipe rodando na sua própria velocidade. Os dois são postos no **mesmo ponto
 * da passada**, quadro a quadro, a partir da fase que o `GaitClock` mantém —
 * nem sequer há `timeScale` aqui. Como ambos os clipes começam no pé esquerdo
 * tocando o chão, os contatos caem no mesmo instante e o pé continua parado no
 * convés durante o apoio, em qualquer ponto da mistura. Deixar cada um no seu
 * ritmo faria os dois discordarem de onde o pé está, e a média de duas verdades
 * é uma mentira que escorrega.
 *
 * O relógio vive no `PlayerController` e não aqui de propósito: é dele que sai
 * também o balanço da câmera, e as duas coisas têm de ser o mesmo passo. Além
 * disso o corpo é um arquivo que carrega de forma assíncrona e pode falhar; o
 * jogo precisa andar igual sem ele.
 *
 * O avatar entra como **filho do modelo do navio**, então acompanha jogo de
 * proa e adernada de graça — a mesma razão de `CameraRig` compor com
 * `ship.model.root` e não com `ship.body`.
 *
 * ## Dois corpos, uma classe
 *
 * A partida instancia **dois**: o do jogador, pendurado no casco dele, e o do
 * adversário, pendurado no outro. É a mesma classe porque é a mesma coisa — um
 * marujo a bordo —, e a única diferença é de onde vem o `PlayerController` que
 * a alimenta: no host e no duelo local ele é simulado aqui, e no cliente que não
 * simula a pose chega pela rede e `PlayerController.applyRemoteStep` a
 * transforma nos mesmos relógios. Todo o resto deste arquivo é cego a essa
 * distinção, e é isso que faz o corpo do outro jogador andar, correr, pular,
 * subir a escada, governar e pregar tábua com os mesmos clipes e as mesmas
 * regras do seu.
 */

import * as THREE from 'three';
import { damp } from '../core/MathUtils';
import { instantiateCharacter, loadCharacter } from './CharacterAsset';
import { HeadLook } from './HeadLook';
import {
  HEAD_CLIP_OFF,
  HEAD_CLIP_THRESHOLD,
  type HeadClipHandle,
  installHeadClip,
} from '../shaders/headClip';
import { STATION_BLEND } from './CameraRig';
import { FirstPersonBody } from './FirstPersonBody';
import type { CarryClock, ClimbClock, GaitClock, HelmClock, JumpClock } from './Locomotion';
import { CarriedPlank } from './CarriedPlank';
import type { PlayerController } from './PlayerController';

/** Convergência da direção do corpo, em 1/s. */
const FACING_LAMBDA = 11;

/**
 * Quanto o corpo recua do olho em primeira pessoa, em metros.
 *
 * **Sem isto a primeira pessoa não funciona**, e o motivo é anatômico. A câmera
 * fica em `EYE_HEIGHT` acima dos pés, **no eixo da coluna** — o olho de um
 * humano não fica ali, fica uns dez centímetros à frente, porque o crânio sai da
 * coluna e o rosto avança. Com a câmera no eixo, olhar para baixo é olhar para
 * dentro do próprio tronco: o buraco que o recorte da cabeça abre no pescoço cai
 * exatamente na linha de visão, e a tela vira uma parede de casaco sem forma.
 * Medido em execução: no limite de `PITCH_LIMIT` o torso ocupava a tela inteira.
 *
 * Recuar o **corpo** em vez de adiantar a câmera é de propósito. O olho é a
 * origem de alcance do `Interaction`, do ouvido em `audio.setListener` e da mira
 * do canhão; mexer nele para consertar um enquadramento mudaria distâncias de
 * jogo. O corpo não deve nada a ninguém — recuá-lo é uma mentira que só a vista
 * conta, e ela custa onze centímetros de pé atrás da beirada que ninguém mede.
 *
 * **Onze, e não vinte.** Foi medido nos dois extremos do `PITCH_LIMIT`, porque o
 * erro tem dois lados: recuo de menos e o tronco vira uma parede sem forma
 * olhando reto para baixo; recuo de mais e o corpo **some** nos 55° em que se
 * anda de fato — o pirata fica pendurado à frente da câmera em vez de embaixo
 * dela. Com 0,18 o ombro já não aparecia a 55°; com 0,11 ele fica no rodapé nos
 * dois casos, que é o enquadramento que se procura.
 */
const FIRST_PERSON_SETBACK = 0.11;

const _velocity = new THREE.Vector2();

export class PlayerAvatar {
  /** Nó que vai para dentro do modelo do navio. */
  readonly root = new THREE.Group();

  private mixer: THREE.AnimationMixer | null = null;
  private idle: THREE.AnimationAction | null = null;
  private walk: THREE.AnimationAction | null = null;
  private run: THREE.AnimationAction | null = null;
  private jumpAir: THREE.AnimationAction | null = null;
  private jumpLand: THREE.AnimationAction | null = null;
  private climbUp: THREE.AnimationAction | null = null;
  private helm: THREE.AnimationAction | null = null;
  private carry: THREE.AnimationAction | null = null;

  /** A madeira nas mãos enquanto se prega tábua. Ver `CarriedPlank`. */
  private readonly plank = new CarriedPlank();

  private facing = 0;
  private facingReady = false;

  /**
   * O recorte da cabeça, um por material da malha.
   *
   * Fica vazio se o GLB não trouxer o osso `head` — e então a primeira pessoa
   * simplesmente não liga o corpo, em vez de mostrar o crânio por dentro.
   */
  private readonly headClips: HeadClipHandle[] = [];
  /** Limiar em vigor quando o recorte está ligado. Ver `calibrate`. */
  private headClipThreshold = HEAD_CLIP_THRESHOLD;
  /** Recuo em vigor. Ver `FIRST_PERSON_SETBACK` e `calibrate`. */
  private setback = FIRST_PERSON_SETBACK;

  /**
   * A torção que separa pernas de tronco. Só vale em primeira pessoa: de fora,
   * o corpo inteiro apontando para onde anda continua sendo o certo, e é essa a
   * pose que o adversário mostra. O que ele ganha no lugar dela é o pescoço —
   * ver `HeadLook`.
   */
  private readonly body = new FirstPersonBody();
  private twistReady = false;

  /**
   * O pescoço que segue o olhar. Só age no corpo visto **de fora** — ver
   * `HeadLook`, que explica por que ele e a torção do quadril não convivem.
   */
  private readonly headLook = new HeadLook();
  private headLookReady = false;

  /**
   * Materiais **deste** corpo, para o descarte. Ver `CharacterAsset`: a
   * geometria e as texturas são compartilhadas com o outro avatar e não são
   * nossas para liberar.
   */
  private readonly materials: THREE.Material[] = [];

  /**
   * Some com o corpo por inteiro, sem gastar um passo de animação com ele.
   *
   * Existe por causa do corpo do adversário, que só faz sentido em rede: contra
   * a máquina, quem comanda o casco inimigo é o `ShipAI`, que não move marujo
   * nenhum — e um pirata plantado no convés em pose de parado, sem nunca dar um
   * passo, é pior que nenhum pirata. Ver `Match.startOnline`.
   */
  hidden = false;

  /** Posição do corpo, atrasada pela transição de estação. Ver `updateStation`. */
  private readonly stationPosition = new THREE.Vector3();
  /** 1 = transição terminada. Começa pronto para o primeiro quadro não saltar. */
  private stationBlend = 1;
  private lastStationChange = -1;

  loaded = false;

  /**
   * Carrega o personagem. Falhar aqui **não** derruba o jogo: sem corpo, tudo
   * o mais continua jogável, e em primeira pessoa nem se nota.
   *
   * O arquivo vem de `CharacterAsset`, que o baixa **uma vez** e devolve uma
   * cópia independente por avatar — malha e textura compartilhadas, esqueleto e
   * material privados. Ver lá o porquê de cada uma dessas metades.
   */
  async load(url: string): Promise<boolean> {
    try {
      const character = instantiateCharacter(await loadCharacter(url));
      const { model, skinned } = character;
      this.materials.push(...character.materials);

      this.root.add(model);
      this.mixer = new THREE.AnimationMixer(model);
      this.installHeadClip(skinned);
      this.installTwist(skinned);
      this.installHeadLook(skinned);

      this.idle = this.action(character.animations, 'Idle');
      this.walk = this.action(character.animations, 'Walk');
      this.run = this.action(character.animations, 'Run');
      if (!this.idle || !this.walk || !this.run) {
        console.warn('[avatar] clipes de locomoção não encontrados no GLB');
        return false;
      }

      // O pulo é opcional: um GLB antigo em cache do navegador não pode tirar do
      // jogador a locomoção, que é o que ele usa o tempo todo.
      this.jumpAir = this.action(character.animations, 'JumpAir');
      this.jumpLand = this.action(character.animations, 'JumpLand');
      if (!this.jumpAir || !this.jumpLand) {
        console.warn('[avatar] clipes de pulo não encontrados no GLB; o corpo salta sem pose');
      }

      // A escalada é opcional pelo mesmo motivo do pulo: um GLB antigo em cache
      // não pode tirar do jogador a locomoção, que é o que ele usa o tempo todo.
      this.climbUp = this.action(character.animations, 'ClimbUp');
      if (!this.climbUp) {
        console.warn('[avatar] clipe de escalada não encontrado no GLB');
      }

      // O timão, idem. Sem ele o jogo continua inteiro: o timoneiro governa em
      // pose de parado, que é exatamente o que fazia antes deste clipe existir.
      this.helm = this.action(character.animations, 'Helm');
      if (!this.helm) {
        console.warn('[avatar] clipe do timão não encontrado no GLB');
      }

      // E a tábua de reparo. Sem o clipe, o rombo continua fechando e a madeira
      // continua aparecendo pregada no casco — o que se perde é o gesto.
      this.carry = this.action(character.animations, 'Carry');
      if (!this.carry) {
        console.warn('[avatar] clipe de carregar tábua não encontrado no GLB');
      }
      if (skinned) this.plank.attach((skinned as THREE.SkinnedMesh).skeleton, this.root);

      // Quem avança o tempo destes é um relógio, quadro a quadro: a passada para
      // andar e correr, a velocidade vertical para o ar, o cronômetro do pouso
      // para o pouso. O parado é o único que não: ele respira no ritmo dele, que
      // não tem nada a ver com a velocidade de ninguém.
      this.walk.setEffectiveTimeScale(0);
      this.run.setEffectiveTimeScale(0);
      this.jumpAir?.setEffectiveTimeScale(0);
      this.jumpLand?.setEffectiveTimeScale(0);
      // A escalada é indexada pela altura vencida, como a passada é pela
      // distância no chão. Parado na escada a fase não anda, e o personagem
      // congela agarrado — que é exatamente o que se quer.
      this.climbUp?.setEffectiveTimeScale(0);
      // E o timão pelo ângulo da roda, pela mesma razão: parado com o leme
      // carregado, o timoneiro fica com as mãos nos punhos em que a roda parou.
      this.helm?.setEffectiveTimeScale(0);
      // A tábua também, mas por um motivo diferente dos outros: a fase dela não
      // sai de grandeza nenhuma do mundo, sai de um relógio — e o relógio é o
      // `CarryClock`, do lado de fora, para que a respiração não recomece do
      // zero a cada vez que a mão volta à madeira.
      this.carry?.setEffectiveTimeScale(0);

      this.loaded = true;
      return true;
    } catch (error) {
      console.warn('[avatar] não foi possível carregar o personagem:', error);
      return false;
    }
  }

  private action(clips: THREE.AnimationClip[], name: string): THREE.AnimationAction | null {
    const clip = clips.find((c) => c.name === name);
    if (!clip || !this.mixer) return null;
    const action = this.mixer.clipAction(clip);
    action.setLoop(THREE.LoopRepeat, Infinity);
    action.play();
    action.setEffectiveWeight(0);
    return action;
  }

  /**
   * Prepara o recorte da cabeça nos materiais da malha.
   *
   * Os índices saem de `skeleton.bones`, que é exatamente a tabela que o atributo
   * `skinIndex` da geometria referencia — procurar pelo nome do osso no grafo da
   * cena daria um `Object3D` certo e um índice errado.
   *
   * Falhar aqui não derruba nada: sem recorte o avatar só não liga o corpo em
   * primeira pessoa, e o jogo volta a ser o de antes. É a mesma política que o
   * arquivo já aplica ao clipe de pulo e ao de escalada.
   */
  private installHeadClip(mesh: THREE.SkinnedMesh | null): void {
    if (!mesh) {
      console.warn('[avatar] malha com esqueleto não encontrada no GLB; sem corpo em 1ª pessoa');
      return;
    }

    const bones = mesh.skeleton.bones;
    const head = bones.findIndex((bone) => bone.name === 'head');
    const neck = bones.findIndex((bone) => bone.name === 'neck');
    if (head < 0) {
      console.warn('[avatar] osso `head` não encontrado no GLB; sem corpo em 1ª pessoa');
      return;
    }

    const materials = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
    for (const material of materials) this.headClips.push(installHeadClip(material, head, neck));
  }

  /**
   * Prepara a torção de primeira pessoa. Falhar aqui custa só a torção: o corpo
   * continua andando, pulando e subindo escada, apontado para onde anda.
   */
  private installTwist(mesh: THREE.SkinnedMesh | null): void {
    if (!mesh) return;
    this.twistReady = this.body.attach(mesh.skeleton, this.root);
    if (!this.twistReady) {
      console.warn('[avatar] coluna não encontrada no GLB; o corpo não se torce em 1ª pessoa');
    }
  }

  /**
   * Prepara o pescoço que segue o olhar. Falhar custa só o gesto — e ele só
   * aparece no corpo visto de fora, que é o do adversário. Ver `HeadLook`.
   */
  private installHeadLook(mesh: THREE.SkinnedMesh | null): void {
    if (!mesh) return;
    this.headLookReady = this.headLook.attach(mesh.skeleton, this.root);
    if (!this.headLookReady) {
      console.warn('[avatar] pescoço não encontrado no GLB; a cabeça não segue o olhar');
    }
  }

  /** Pendura o corpo no modelo do navio. */
  attach(parent: THREE.Object3D): void {
    parent.add(this.root);
  }

  /**
   * @param firstPerson `true` quando a câmera está nos olhos deste corpo.
   *
   * A política de quando o corpo aparece é do personagem, não do laço principal:
   * quem sabe que o canhão tira a câmera de dentro da cabeça é quem conhece as
   * estações. A regra é uma frase — **o corpo aparece quando a câmera está nos
   * olhos dele** —, e ela cobre os dois casos de uma vez.
   *
   * Escondido, o corpo continua animando. Parar o mixer junto faria o
   * personagem aparecer congelado no quadro em que sumiu, na hora em que a
   * câmera se solta (tecla `C`) ou em que se larga o canhão.
   */
  update(dt: number, player: PlayerController, firstPerson: boolean): void {
    if (!this.loaded || !this.mixer || !this.idle || !this.walk || !this.run) return;

    // Corpo desligado não gasta mixer. É o contrário da regra do parágrafo
    // acima, e de propósito: ali o corpo some por um quadro e volta (a câmera se
    // solta, o canhão é largado), aqui ele some por uma partida inteira.
    if (this.hidden) {
      this.root.visible = false;
      return;
    }

    // No canhão a câmera vai para trás da culatra e os pés ficam onde estavam ao
    // apertar o botão — o corpo apareceria de fora, decapitado, metros ao lado.
    const embodied = firstPerson && this.headClips.length > 0;
    this.root.visible = !firstPerson || (embodied && player.station !== 'cannon');
    this.setHeadClip(embodied);
    // A pose **visual**, não a de colisão: numa escada os pés vencem um degrau
    // inteiro num quadro, e é a vista que absorve isso. Ver `PlayerController`.
    this.updateStation(dt, player);

    _velocity.set(player.velocity.x, player.velocity.z);
    const walking = player.gait.moving > 0.5;

    // A escada leva o corpo inteiro: quem está pendurado nela não está andando
    // nem caindo. O que ela ocupa sai do orçamento antes de tudo.
    const climbing = this.updateClimb(player.climb);
    // O timão sai do mesmo orçamento e pelo mesmo motivo: quem está de mãos na
    // roda não está andando. Os dois nunca se sobrepõem — não há como estar na
    // escada e no leme —, então somá-los não estoura o total.
    const helming = this.updateHelm(player.helm);
    // A tábua sai do mesmo orçamento, e é o único posto que **convive** com os
    // outros: dá para estar no porão com a madeira na mão, e não dá para estar
    // na escada e no leme ao mesmo tempo. Por isso ela é grampeada ao que
    // sobrou, em vez de somada de igual para igual — do contrário, um quadro
    // com escada e tábua ao mesmo tempo passaria de 1 e apagaria a locomoção.
    //
    // E ela **cede a quem anda**. O timão e a escada prendem o jogador no
    // lugar; pregar tábua não prende, e o alcance de reparo é de três metros,
    // então dá para caminhar segurando o botão. Sem esta cláusula o corpo
    // deslizaria pelo porão na pose de carregar, com os pés parados — que é
    // exatamente o defeito que o resto deste arquivo existe para evitar.
    const carrying = this.updateCarry(
      player.carry,
      (1 - climbing - helming) * (1 - player.gait.moving),
    );
    // O que sobra do pulo é o que a locomoção pode ocupar. Os pesos têm de somar
    // 1: o que faltar o Three preenche com a pose de repouso do rig, que é a
    // T-pose de braços abertos.
    const ground = Math.max(0, 1 - climbing - helming - carrying - this.updateJump(player.jump));

    // A torção é exclusiva de quem está dentro do corpo. Visto de fora, o corpo
    // inteiro apontado para onde anda continua sendo o certo — e é essa a pose
    // que o adversário mostra.
    const twisting = embodied && this.twistReady;
    if (twisting) this.updateWornFacing(dt, player, walking);
    else this.updateFacing(dt, player, walking);

    // Depois do rumo, que é quem diz para onde é "atrás".
    this.applyPosition(embodied, player);
    this.updateLocomotion(player.gait, ground, twisting && this.body.reversed);
    this.mixer.update(dt);
    // Depois do mixer, sempre: ele reescreve os 43 ossos a cada passagem.
    if (twisting) this.body.apply();
    // E o pescoço, que é o mesmo olhar visto do outro lado. Exclusivo de quem
    // **não** está dentro do corpo: em primeira pessoa a cabeça está recortada e
    // a torção do quadril ocupa o mesmo instante, e as duas rotações não
    // comutam. Ver `HeadLook`.
    else if (this.headLookReady) this.headLook.apply(player.pitch);
    // E a tábua depois dos dois, porque ela lê as matrizes dos punhos: lida
    // antes, ela desenharia a pose do quadro anterior.
    // O limiar é o mesmo do peso do clipe, e não do relógio: andar cede a pose
    // à locomoção, e a madeira tem de sair junto — ninguém corre pelo porão com
    // uma tábua flutuando à frente do peito.
    this.plank.update(this.root.visible && carrying > 0.35);
  }

  /**
   * Assenta o corpo, recuado do olho quando é o jogador que o veste.
   *
   * O recuo é no eixo do **tronco** (o modelo olha para +Z local, daí o seno e o
   * cosseno do rumo), e não no do movimento: quem manda no enquadramento é a
   * cabeça, e é ela que segue o tronco. Ver `FIRST_PERSON_SETBACK`.
   *
   * **No timão não há recuo**, e é a única estação em que isso vale. O recuo
   * existe para tirar o tronco da frente do olho, e ele funciona porque o tronco
   * acompanha o olhar; ali o corpo está travado de frente para a proa (ver
   * `updateWornFacing`), então recuar no eixo do tronco é afastar o corpo **da
   * roda** — os 11 cm somam ao vão que o braço já tem de vencer e as mãos do
   * jogador caem aquém dos punhos. Compensar no clipe não serve: é o mesmo clipe
   * que o outro jogador vê de fora, onde não há recuo nenhum.
   */
  private applyPosition(embodied: boolean, player: PlayerController): void {
    this.root.position.copy(this.stationPosition);
    if (!embodied || player.station === 'helm') return;
    this.root.position.x -= Math.sin(this.facing) * this.setback;
    this.root.position.z -= Math.cos(this.facing) * this.setback;
  }

  /**
   * Leva o corpo até a estação no mesmo passo que a câmera.
   *
   * Assumir o timão **teleporta** os pés: `takeHelm` escreve `local` direto em
   * `HELM_STAND`, que pode estar a dois metros. A câmera nunca sofreu com isso
   * porque o `CameraRig` já interpolava a troca em 0,28 s — só que o corpo não, e
   * enquanto ele estava escondido ninguém viu. Vestindo o corpo, a diferença é
   * um pirata decapitado atravessando o convés na direção do jogador enquanto a
   * câmera ainda não saiu do lugar.
   *
   * A curva é a mesma do rig, deliberadamente: mesma duração, mesmo smoothstep,
   * mesma constante. Duas suavizações parecidas mas não idênticas seriam pior
   * que nenhuma.
   */
  private updateStation(dt: number, player: PlayerController): void {
    if (player.stationChangeCount !== this.lastStationChange) {
      // A primeira vez é o spawn, e ali não há de onde vir.
      this.stationBlend = this.lastStationChange < 0 ? 1 : 0;
      this.lastStationChange = player.stationChangeCount;
    }

    if (this.stationBlend >= 1) {
      this.stationPosition.copy(player.visualLocal);
      return;
    }

    this.stationBlend = Math.min(this.stationBlend + dt / STATION_BLEND, 1);
    const s = this.stationBlend * this.stationBlend * (3 - 2 * this.stationBlend);
    this.stationPosition.lerp(player.visualLocal, s);
  }

  /**
   * Liga e desliga o recorte da cabeça.
   *
   * Só um uniform muda — nem recompila shader nem troca de programa —, então
   * soltar a câmera com `C` devolve a cabeça no mesmo quadro. Escrever sempre, em
   * vez de comparar com o estado anterior, é o que mantém o limiar calibrado
   * valendo depois de uma ida e volta à terceira pessoa.
   */
  private setHeadClip(on: boolean): void {
    const threshold = on ? this.headClipThreshold : HEAD_CLIP_OFF;
    for (const clip of this.headClips) clip.setThreshold(threshold);
  }

  /**
   * Para onde o corpo aponta.
   *
   * Não é para onde o jogador olha. Sem clipes de andar de lado e de ré, um
   * corpo preso ao olhar faz o personagem deslizar de costas quando se anda
   * para trás — o "moonwalk" clássico. Virar o corpo para a direção do
   * movimento é mentira barata e invisível: a animação sempre anda para a
   * frente, que é a única coisa que ela sabe fazer.
   */
  private updateFacing(dt: number, player: PlayerController, walking: boolean): void {
    // No ar ninguém torce o corpo: o rumo é o que se levou na decolagem. Sem
    // isto a locomoção se apaga durante o voo, o alvo cai de volta para o olhar,
    // e quem pula de lado vê o personagem girar no meio do salto.
    if (this.facingReady && player.jump.air > 0.5) return;

    // O personagem foi modelado olhando para -Y no Blender, que vira +Z depois
    // da conversão para Y-up do glTF.
    //
    // Na escada o rumo não é escolha: o corpo encara a escada, que fica a vante
    // do jogador (-Z do navio). Deixá-lo seguir o olhar faria o pirata subir de
    // lado — e o clipe inteiro foi construído com as barras à frente do peito.
    //
    // No timão vale o mesmo, e a roda também fica a vante: o clipe põe as mãos
    // em punhos que estão numa posição fixa do navio, e um corpo que gira leva as
    // duas junto. Ver `updateWornFacing`, que paga o preço disso por dentro.
    if (player.onLadder || player.station === 'helm') {
      this.facing = Math.PI;
      this.facingReady = true;
      this.root.rotation.y = this.facing;
      return;
    }

    const target = walking
      ? Math.atan2(_velocity.x, _velocity.y)
      : player.yaw + Math.PI;

    if (!this.facingReady) {
      this.facing = target;
      this.facingReady = true;
    } else {
      // Pelo caminho mais curto: sem isto, cruzar ±π faz o corpo girar quase
      // uma volta inteira num quadro.
      let delta = (target - this.facing) % (Math.PI * 2);
      if (delta > Math.PI) delta -= Math.PI * 2;
      if (delta < -Math.PI) delta += Math.PI * 2;
      this.facing = damp(this.facing, this.facing + delta, FACING_LAMBDA, dt);
    }

    this.root.rotation.y = this.facing;
  }

  /**
   * Para onde o corpo aponta quando é o jogador que o está vestindo.
   *
   * O tronco vai para o olhar **sem suavização nenhuma**: ele é a câmera, e um
   * peito que persegue a câmera com atraso faz o mundo girar dentro do próprio
   * corpo. Quem amortece é a perna, do outro lado da torção.
   *
   * O rumo das pernas não é o mesmo em todo lugar, e a lista de exceções é curta
   * mas obrigatória — cada uma delas é um lugar onde o corpo tem os pés presos em
   * algo e o olhar não.
   */
  private updateWornFacing(dt: number, player: PlayerController, walking: boolean): void {
    // Na escada o corpo está pendurado nas barras: nem o rumo nem a torção são
    // escolha de quem olha. Ver `updateFacing`, que resolve o mesmo de fora.
    //
    // **E no timão, pelo mesmo motivo e com o mesmo remédio.** Os braços herdam
    // `spine_03`: com o tronco preso ao olhar, as duas mãos saem da roda no
    // instante em que o jogador olha para o lado, e não há clipe que conserte
    // isso — o clipe põe a mão num punho, não no espaço. `hold` trava as pernas e
    // zera a torção de uma vez, que é o que faz o corpo inteiro ficar de frente
    // para a proa.
    //
    // O custo é real e é o mesmo que a escada já paga: o corpo deixa de
    // acompanhar o olhar. Vale a troca justamente onde as mãos estão ocupadas —
    // e `legTarget` já plantava as pernas aqui, então metade dele já era devida.
    if (player.onLadder || player.station === 'helm') {
      this.facing = Math.PI;
      this.facingReady = true;
      this.root.rotation.y = this.facing;
      this.body.hold(Math.PI);
      return;
    }

    this.facing = player.yaw + Math.PI;
    this.facingReady = true;
    this.root.rotation.y = this.facing;

    this.body.update(dt, this.facing, this.legTarget(player, walking), walking);
  }

  /**
   * Para onde as pernas deveriam apontar, ou `null` para congelar onde estão.
   *
   * Fora do chão o rumo é o que se levou na decolagem — sem isto, girar o mouse
   * no meio do salto gira as pernas junto, que é o mesmo defeito que o rumo de
   * terceira pessoa já evita. No timão os pés ficam plantados atrás da roda:
   * `takeHelm` teleporta o jogador para lá e o olhar continua livre, então quem
   * olhasse para a popa veria o próprio corpo dar meia-volta com os pés parados.
   */
  private legTarget(player: PlayerController, walking: boolean): number | null {
    if (player.jump.air > 0.5) return null;
    if (player.station === 'helm') return Math.PI;
    // Andando, a direção do movimento; parado, o olhar — e é o `FirstPersonBody`
    // que decide se aquilo é uma caminhada de frente ou de ré.
    return walking ? Math.atan2(_velocity.x, _velocity.y) : player.yaw + Math.PI;
  }

  /**
   * Põe os dois clipes no mesmo ponto da passada e reparte os pesos.
   *
   * Escrever `action.time` em vez de acelerar com `timeScale` tira qualquer
   * chance de deriva: dois clipes de durações diferentes rodando por conta
   * própria se afastam alguns milissegundos por ciclo, e em um minuto o contato
   * de um cai no meio do apoio do outro.
   */
  private updateLocomotion(gait: GaitClock, ground: number, reversed: boolean): void {
    const walk = this.walk!;
    const run = this.run!;

    // Andar de ré é o ciclo de caminhada lido de trás para frente. Funciona porque
    // os contatos de pé continuam caindo nos mesmos instantes da passada — é a
    // mesma razão pela qual descer a escada é o `ClimbUp` com a fase recuando.
    //
    // A inversão fica **na leitura**, e não na fase: a fase é compartilhada com o
    // balanço da câmera e com `tests/locomotion.ts`, e virá-la ali faria a câmera
    // solavancar ao contrário do pé. O resto (`%1`) é para a fase zero não cair
    // exatamente no fim do clipe.
    const phase = reversed ? (1 - gait.phase) % 1 : gait.phase;
    walk.time = phase * (walk.getClip().duration || 1);
    run.time = phase * (run.getClip().duration || 1);

    walk.setEffectiveWeight((1 - gait.runBlend) * gait.moving * ground);
    run.setEffectiveWeight(gait.runBlend * gait.moving * ground);
    // O que sobra vai para o parado. Sem esta linha o personagem volta à pose de
    // repouso do rig quando ninguém anda — a T-pose, de braços abertos. É um
    // defeito que não aparece no Blender e aparece no primeiro segundo de jogo.
    this.idle!.setEffectiveWeight((1 - gait.moving) * ground);
  }

  /**
   * Põe os dois clipes do pulo no ponto certo. Devolve quanto do corpo eles
   * tomaram, que é o que a locomoção deixa de ocupar.
   *
   * O do ar é indexado pela **velocidade vertical** e não pelo tempo, então
   * escrever `.time` aqui não é uma otimização como na passada: é a única forma
   * de tocá-lo. Ver `JumpClock`.
   */
  private updateJump(jump: JumpClock): number {
    const air = this.jumpAir;
    const land = this.jumpLand;
    if (!air || !land) return 0;

    air.time = jump.airPhase * (air.getClip().duration || 1);
    land.time = jump.landPhase * (land.getClip().duration || 1);

    air.setEffectiveWeight(jump.air);
    land.setEffectiveWeight(jump.land);
    return jump.air + jump.land;
  }

  /**
   * Põe o clipe de escalada no ponto certo do ciclo. Devolve quanto do corpo ele
   * tomou.
   *
   * Como a passada, o clipe é **posicionado** e não tocado: quem escolhe o
   * quadro é a altura vencida, que o `ClimbClock` transforma em fase. Escrever
   * `.time` em vez de acelerar com `timeScale` é o que garante que a mão fique
   * na barra em qualquer velocidade de subida — e é o que faz descer funcionar
   * de graça, com a fase andando para trás.
   */
  private updateClimb(climb: ClimbClock): number {
    const action = this.climbUp;
    if (!action) return 0;

    action.time = climb.phase * (action.getClip().duration || 1);
    action.setEffectiveWeight(climb.weight);
    return climb.weight;
  }

  /**
   * Põe o clipe do timão no ponto certo do ciclo. Devolve quanto do corpo ele
   * tomou.
   *
   * Mesmo contrato da escalada, com outra régua: quem escolhe o quadro é o
   * ângulo da roda, que o `HelmClock` transforma em fase. Escrever `.time` é o
   * que crava a mão no punho em qualquer cadência de giro — e é o que faz girar
   * para bombordo funcionar de graça, com a fase andando para trás.
   */
  private updateHelm(clock: HelmClock): number {
    const action = this.helm;
    if (!action) return 0;

    action.time = clock.phase * (action.getClip().duration || 1);
    action.setEffectiveWeight(clock.weight);
    return clock.weight;
  }

  /**
   * A tábua nas mãos, no que sobrou do orçamento de pose.
   *
   * @param budget quanto de corpo os outros postos deixaram livre.
   * @returns o peso que este clipe de fato ocupou.
   */
  private updateCarry(clock: CarryClock, budget: number): number {
    const action = this.carry;
    if (!action) return 0;

    const weight = Math.max(0, Math.min(clock.weight, budget));
    action.time = clock.phase * (action.getClip().duration || 1);
    action.setEffectiveWeight(weight);
    return weight;
  }

  /** Diagnóstico para a bancada `window.__game` e para o overlay de telemetria. */
  get debug(): {
    facing: number;
    walk: number;
    run: number;
    idle: number;
    air: number;
    land: number;
    climb: number;
    helm: number;
    /** Torção do quadril em vigor, em radianos. Zero fora da primeira pessoa. */
    twist: number;
    /** `true` quando a passada está sendo lida ao contrário. */
    reversed: boolean;
    /** Limiar do recorte da cabeça. `HEAD_CLIP_OFF` quer dizer cabeça inteira. */
    headClip: number;
  } {
    return {
      facing: this.facing,
      walk: this.walk?.getEffectiveWeight() ?? 0,
      run: this.run?.getEffectiveWeight() ?? 0,
      idle: this.idle?.getEffectiveWeight() ?? 0,
      air: this.jumpAir?.getEffectiveWeight() ?? 0,
      land: this.jumpLand?.getEffectiveWeight() ?? 0,
      climb: this.climbUp?.getEffectiveWeight() ?? 0,
      helm: this.helm?.getEffectiveWeight() ?? 0,
      twist: this.body.offset,
      reversed: this.body.reversed,
      headClip: this.headClips[0]?.threshold ?? HEAD_CLIP_OFF,
    };
  }

  /**
   * Calibração ao vivo, pela bancada `window.__game`.
   *
   * Onde o pescoço tem de sumir e o quanto o corpo recua do olho são coisas que
   * só se decidem com o olho na tela. Estão aqui, e não em `Settings`, porque são
   * escolhas de autor e não de jogador: uma vez acertadas, viram as constantes do
   * topo do arquivo.
   *
   * @param threshold peso a partir do qual o fragmento some, em [0, 1].
   * @param neckShare quanto o osso `neck` conta para esse peso, em [0, 1].
   * @param setback recuo do corpo em relação ao olho, em metros.
   */
  calibrate(options: { threshold?: number; neckShare?: number; setback?: number }): void {
    if (options.threshold !== undefined) this.headClipThreshold = options.threshold;
    if (options.setback !== undefined) this.setback = options.setback;
    if (options.neckShare === undefined) return;
    for (const clip of this.headClips) clip.setNeckShare(options.neckShare);
  }

  /**
   * Descarta **este** corpo.
   *
   * ⚠️ A geometria e as texturas **não** são liberadas aqui, e não é
   * esquecimento: elas são do `CharacterAsset` e o outro avatar ainda está
   * usando as mesmas. Liberá-las daqui apagaria o corpo do adversário junto com
   * o do jogador. Quem as libera é `disposeCharacterAsset`, depois dos dois.
   */
  dispose(): void {
    this.mixer?.stopAllAction();
    // Antes de varrer a árvore: a tábua é filha deste nó, mas a geometria e o
    // material dela são do módulo `PlankAsset` e ainda servem os dois cascos.
    this.plank.dispose();
    this.root.removeFromParent();
    for (const material of this.materials) material.dispose();
    this.materials.length = 0;
  }
}
