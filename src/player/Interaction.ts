/**
 * Foco de interação: o que o jogador está olhando e pode usar com `F`.
 *
 * **Não usa raycast.** Um raio contra a malha do navio pareceria mais rigoroso,
 * mas custaria caro por frame e daria um resultado pior: exigiria mirar no pixel
 * certo do timão, quando o que se quer é "estou perto e virado para o timão".
 * Proximidade, pavimento e ângulo de visão são o que o Sea of Thieves entrega na
 * prática — perdoa a mira e nunca oferece uma peça que está atrás de você.
 *
 * Tudo aqui trabalha em coordenadas locais do navio, no mesmo referencial em que
 * o `PlayerController` já vive: sem conversão de matriz e sem depender da pose
 * interpolada do modelo.
 */

import * as THREE from 'three';
import { InputBit, held as isHeld, pressed, type InputFrame } from '../core/InputFrame';
import { clamp, clamp01 } from '../core/MathUtils';
import type { Ship } from '../ship/Ship';
import { DECK_Y, STATIONS, tToZ } from '../ship/ShipDimensions';
import {
  BILGE_PUMP,
  BILGE_PUMP_HANDLE_Y,
  CROW_NEST,
  MAST_LADDER,
  WHEEL_Y,
} from '../ship/ShipParts';
import type { Breach } from '../ship/ShipDamage';
import type { PlayerController } from './PlayerController';

/** Uma coisa a bordo que responde ao `F`. */
export interface Interactable {
  readonly id: string;
  /**
   * Ponto de foco, em coordenadas locais do navio.
   *
   * `readonly` é a referência, não o conteúdo: peças que se movem reescrevem o
   * vetor em `refresh()`. Trocar o objeto quebraria a comparação de identidade
   * que zera `holdTime` ao mudar de alvo.
   */
  readonly local: THREE.Vector3;
  /** Distância máxima do olho ao ponto, em metros. */
  readonly range: number;
  /**
   * Em que pavimento a peça fica. O foco não atravessa o piso.
   *
   * Sem isso, quem está no porão embaixo do tombadilho vê o timão a 1,5 m do
   * olho — distância curta, cone aberto, prompt aceso — e assume o leme através
   * das tábuas, de dentro do casco. Vale igual para os canhões e o cabrestante,
   * todos ao alcance de quem passa por baixo deles.
   *
   * É a checagem barata que substitui o raycast que este arquivo faz questão de
   * não ter: o navio só tem dois pavimentos, e nenhuma peça pertence aos dois.
   */
  readonly level: 'deck' | 'hold';
  /**
   * Texto do prompt agora. `null` esconde a peça — é assim que o canhão some da
   * lista quando o jogador já está em outro canhão.
   */
  /**
   * Reposiciona o alvo antes do teste de foco, para peças que não têm lugar
   * fixo. É o que permite os rombos serem uma entrada só na lista em vez de uma
   * por buraco: a cada frame ela se muda para o rombo mais perto do jogador.
   */
  refresh?(player: PlayerController): void;
  label(): string | null;
  /**
   * Enquanto devolver `true`, a peça **segura o foco** — nem o cone de visão nem
   * a distância tiram o prompt dela.
   *
   * Existe por causa do cabrestante, que é a única peça do navio que vira um
   * modo: quem está dando voltas nas barras sai do cone delas no primeiro quarto
   * de volta, e recalcular o foco ali dentro apagaria o prompt justamente na mão
   * de quem precisa dele para largar a peça. É um contrato explícito, e não o
   * efeito colateral de um botão segurado.
   */
  locks?(): boolean;
  /** Toque: dispara uma vez por pressionada. */
  press?(): void;
  /** Segurar: chamado a cada frame enquanto o `F` estiver pressionado. */
  hold?(dt: number): void;
  /**
   * Progresso de 0 a 1 para a barra do prompt, ou `null` quando não há nada em
   * andamento. É o estado da peça, não o tempo de tecla segurada: o cabrestante
   * mostra o quanto da amarra já subiu, e soltar o `F` congela a barra onde
   * estava em vez de zerá-la.
   */
  progress?(): number | null;
}

/**
 * Meia-abertura do foco na horizontal, em radianos (40°).
 *
 * O limite é geométrico, não de gosto: com FOV vertical de 62° em 16:9 a
 * meia-tela horizontal dá ~47°. Passar disso acende o prompt de uma peça que não
 * está desenhada em lugar nenhum — no spawn, o canhão de boreste fica 53° fora
 * do centro e pintava "Assumir o canhão de boreste" sobre o mar vazio. 40° cabe
 * na tela em qualquer proporção razoável e ainda dá 80° de tolerância.
 */
const FOCUS_AZIMUTH = 0.7;
/**
 * E na vertical, bem mais folgado (65°).
 *
 * Não é assimetria gratuita: a tela é mais larga que alta e a cabeça vira muito
 * mais fácil do que abaixa. O cabrestante e a escotilha estão na altura da
 * cintura e do chão — de pé a um passo deles, o alvo cai 48° e 57° abaixo do
 * olhar sem que ninguém esteja mirando errado. Cobrar 40° aqui apagaria o prompt
 * justo de quem já chegou na peça.
 */
const FOCUS_ELEVATION = 1.13;

/**
 * Até onde a mão alcança um rombo, em metros.
 *
 * Mais folgado que o alcance das outras peças: um rombo pode abrir rente à
 * quilha, num canto onde não dá para chegar de pé, e cobrar 2,2 m ali deixaria
 * o buraco impossível de tapar sem motivo nenhum.
 */
const REPAIR_REACH = 3;

const _toItem = new THREE.Vector3();
const _eyeSpace = new THREE.Vector3();
const _inverseEye = new THREE.Quaternion();
const _aim = new THREE.Vector3();
const _toBreach = new THREE.Vector3();

export class Interaction {
  readonly items: Interactable[] = [];

  /** O que está em foco neste frame, ou `null`. */
  focus: Interactable | null = null;
  /** Segundos que o `F` está sendo segurado no foco atual. */
  holdTime = 0;

  /**
   * `true` enquanto o jogador está de fato pregando tábua num rombo.
   *
   * Não é o mesmo que "o foco é um rombo": olhar para o buraco sem apertar nada
   * não põe madeira na mão de ninguém. Quem lê isto é o corpo do jogador, para
   * saber quando trocar a pose e quando fazer a tábua aparecer.
   *
   * Mora aqui porque é aqui que a informação existe. O `PlayerController` não
   * conhece rombos, e a `ShipDamage` não conhece botão segurado — só esta classe
   * vê as duas coisas no mesmo quadro.
   */
  patching = false;

  add(item: Interactable): void {
    this.items.push(item);
  }

  /**
   * Um passo de foco contextual.
   *
   * Roda no passo fixo junto com o marujo, e não no quadro. O que isso conserta
   * de imediato, mesmo sem rede: `hold(dt)` alimentava `ship.patchBreach` com o
   * `dt` do **quadro**, então pregar uma tábua era mais rápido a 144 fps que a 30.
   */
  update(dt: number, frame: InputFrame, player: PlayerController): void {
    // Em estação, o único comando que interessa é sair dela — e quem cuida
    // disso é o loop principal, não o foco de interação.
    if (player.station !== 'deck' || player.onLadder) {
      this.focus = null;
      this.holdTime = 0;
      this.patching = false;
      return;
    }

    const previous = this.focus;
    // **Segurar prende o foco.** Sem isto, começar uma ação e virar a cabeça a
    // interrompe.
    //
    // O alvo continua tendo de existir (`label()`), e é essa cláusula que faz o
    // reparo se comportar: no quadro em que o rombo fecha, ele sai da lista, o
    // rótulo vira `null` e o foco é recalculado na hora — sem soltar o botão, a
    // tábua seguinte já engata no buraco seguinte. Antes o alvo ficava congelado
    // num rombo que não existia mais, e o jogador via o contador passar de 100%
    // com o furo ainda esguichando ao lado.
    //
    // Uma peça em modo (`locks`) tem precedência sobre as duas coisas: ela não
    // depende de botão segurado nem de estar no cone.
    const locked = this.lockedItem();
    const held = isHeld(frame, InputBit.Interact) && previous !== null && previous.label() !== null;
    this.focus = locked ?? (held ? previous : this.findFocus(player));

    // Trocar de peça zera a contagem: não dá para começar a girar o cabrestante
    // num alvo e terminar noutro.
    if (this.focus !== previous) this.holdTime = 0;
    if (!this.focus) {
      this.patching = false;
      return;
    }

    if (pressed(frame, InputBit.Interact)) this.focus.press?.();
    if (isHeld(frame, InputBit.Interact)) {
      this.holdTime += dt;
      this.focus.hold?.(dt);
    } else {
      this.holdTime = 0;
    }

    // Depois do `hold`, e não antes: o quadro em que o rombo fecha é justamente
    // o quadro em que `hold` o tira da lista, e é aí que a tábua tem de sair da
    // mão para reaparecer pregada no casco.
    this.patching = this.focus.id === 'breach'
      && isHeld(frame, InputBit.Interact)
      && this.focus.label() !== null;
  }

  /** Rótulo do prompt a ser desenhado, ou `null` quando não há foco. */
  get prompt(): string | null {
    return this.focus?.label() ?? null;
  }

  clear(): void {
    this.items.length = 0;
    this.focus = null;
    this.holdTime = 0;
  }

  /**
   * A peça que está segurando o foco por ser um modo, se houver.
   *
   * Varre a lista em vez de olhar só para o foco do quadro anterior: assim o
   * modo se sustenta mesmo depois de uma pausa, de um menu ou de qualquer outra
   * coisa que tenha zerado o foco no meio do caminho.
   */
  private lockedItem(): Interactable | null {
    for (const item of this.items) {
      if (item.locks?.()) return item;
    }
    return null;
  }

  private findFocus(player: PlayerController): Interactable | null {
    const level = player.inHold ? 'hold' : 'deck';
    _inverseEye.copy(player.eyeQuaternion).invert();

    let best: Interactable | null = null;
    let bestScore = 0;

    for (const item of this.items) {
      if (item.level !== level) continue;
      item.refresh?.(player);
      if (!item.label()) continue;

      _toItem.subVectors(item.local, player.eyeLocal);
      const distance = _toItem.length();
      if (distance > item.range || distance < 1e-4) continue;

      // No referencial do olho a direção vira dois ângulos separados, e é isso
      // que permite cobrar da horizontal e da vertical coisas diferentes.
      // Frente é −Z, como em todo o resto do projeto.
      _eyeSpace.copy(_toItem).applyQuaternion(_inverseEye);
      const azimuth = Math.atan2(_eyeSpace.x, -_eyeSpace.z);
      const elevation = Math.atan2(_eyeSpace.y, Math.hypot(_eyeSpace.x, _eyeSpace.z));

      // Distância angular normalizada pelos dois limites: 1 é a borda da elipse.
      // O que está atrás cai fora sozinho — o azimute passa de 90°.
      const offAxis = Math.hypot(azimuth / FOCUS_AZIMUTH, elevation / FOCUS_ELEVATION);
      if (offAxis > 1) continue;

      // Mira pesa mais que distância: entre o timão e o cabrestante quase
      // juntos, ganha aquele para o qual o jogador virou a cabeça.
      const score = (1 - offAxis) / (1 + distance * 0.25);
      if (score > bestScore) {
        bestScore = score;
        best = item;
      }
    }

    return best;
  }
}

/**
 * Monta as peças interativas da Chalupa.
 *
 * Fica aqui, e não em `main.ts`, porque cada uma depende de saber *onde* a peça
 * foi desenhada — e essa conta é a mesma que o `ShipBuilder` fez. Todas leem de
 * `ShipDimensions`, então mover uma estação move o modelo e o prompt junto.
 */
export function createShipInteractables(ship: Ship, player: PlayerController): Interactable[] {
  const items: Interactable[] = [
    {
      id: 'helm',
      local: new THREE.Vector3(0, WHEEL_Y, tToZ(STATIONS.helm)),
      range: 2.4,
      level: 'deck',
      label: () => 'Take the helm',
      press: () => player.takeHelm(),
    },
    {
      id: 'capstan',
      local: new THREE.Vector3(0, DECK_Y + 0.45, tToZ(STATIONS.capstan)),
      // Um pouco **menor** que o alcance do modo, e não maior: o ponto de foco
      // fica 1,21 m acima do olho-a-pé, então 2,4 m de olho ao alvo são 2,07 m
      // no plano do convés — dentro dos 2,1 m que `pushCapstan` exige. Assim o
      // prompt nunca acende num lugar de onde o toque não pega as barras.
      range: 2.4,
      level: 'deck',
      label: () => {
        const anchor = ship.anchor;
        if (anchor.state === 'stowed') return 'Drop anchor';
        if (anchor.state === 'dropping') return 'Dropping anchor…';
        // Diz o que fazer, não o que está acontecendo: quem assume o cabrestante
        // com o ferro no fundo precisa descobrir que tem de **andar para
        // frente**, e essa é a única chance de contar isso sem tela de tutorial.
        const raised = Math.round(clamp01(anchor.raised) * 100);
        return player.atCapstan
          ? `Walk forward to heave — ${raised}%`
          : `Take the capstan — ${raised}%`;
      },
      // Largar é um toque, suspender é um **modo**. A assimetria é a do jogo, e
      // vem de `Anchor`: o ferrolho solta sozinho, o cabrestante precisa de
      // braço — e aqui braço é o jogador dando voltas de verdade.
      //
      // O mesmo botão entra e sai. Isto roda **depois** do `PlayerController` no
      // quadro (ver `Match.update`), que é o que garante que o toque de entrada
      // não seja lido como saída no mesmo quadro.
      press: () => {
        if (player.atCapstan) {
          player.leaveCapstan();
          return;
        }
        const anchor = ship.anchor;
        if (anchor.state === 'stowed') {
          anchor.drop(ship.body);
          return;
        }
        // Durante a queda não há barra que responda — `Anchor.heave` descarta o
        // esforço enquanto a amarra corre, e entrar no modo ali daria voltas em
        // falso.
        if (anchor.state === 'set' || anchor.state === 'raising') player.enterCapstan();
      },
      // Não há `hold`: quem soma as voltas é o próprio `PlayerController`, que é
      // o único que sabe o quanto o marujo andou. Ver `pushCapstan`.
      locks: () => player.atCapstan,
      progress: () => (ship.anchor.isDeployed ? clamp01(ship.anchor.raised) : null),
    },
    // A escada do porão **não** está nesta lista, e é de propósito: ela virou um
    // lance inclinado, que é chão. Não há o que interagir com um chão — anda-se
    // nele. Ver `stairSurfaceY`.
    {
      id: 'pump',
      local: new THREE.Vector3(BILGE_PUMP.x - 0.5, BILGE_PUMP_HANDLE_Y, BILGE_PUMP.z + 0.1),
      range: 2.3,
      level: 'hold',
      // Só aparece com água no porão: bomba seca não tem o que fazer, e o
      // prompt aceso à toa competiria com o da escada, logo ao lado.
      // "Hold to pump — hold at 45%" tinha a mesma palavra em dois sentidos na
      // mesma frase: o verbo de segurar o botão e o porão que se esvazia. Quem
      // lia entendia que 45% era o progresso do bombeio, ficava segurando à
      // espera de chegar a 100 e concluía que a bomba não fazia nada.
      label: () => {
        const flood = ship.damage.floodFraction;
        if (flood < 0.005) return null;
        return `Work the pump — bilge at ${Math.round(flood * 100)}%`;
      },
      hold: () => {
        ship.controls.pumping = true;
      },
      // A barra mostra o quanto **falta** esvaziar, então ela enche conforme a
      // água baixa. Uma barra que anda para trás enquanto se trabalha seria a
      // leitura errada do esforço.
      progress: () =>
        ship.damage.floodFraction > 0.005 ? clamp01(1 - ship.damage.floodFraction) : null,
    },
  ];

  // A escada do mastro: um modo em que se entra e se sai pela **mesma tecla**,
  // e é isso que a separa do lance do porão logo acima.
  //
  // Ela era agarrada por encostar andando para vante, e aquilo custava as duas
  // coisas que um modo não pode custar. Subia sem ninguém pedir — o mastro fica
  // no meio do corredor e quem o contorna raspa nos degraus. E não tinha saída
  // pelo alto: descer exigia o mesmo gesto de subir, então quem chegava ao cesto
  // ficava preso lá em cima com o mar de moldura.
  //
  // O alvo persegue a altura do olho porque o mesmo item serve às duas pontas.
  // Fixo no pé da escada, o prompt sumiria justo na gávea, que é de onde mais se
  // precisa dele.
  const ladderItem: Interactable = {
    id: 'mast-ladder',
    local: new THREE.Vector3(0, DECK_Y + 1, MAST_LADDER.z),
    range: 2.4,
    level: 'deck',
    refresh: () => {
      // Na altura do olho, e não na do pé: o alvo tem de cair perto da linha
      // de visada nas duas pontas, senão na gávea ele fica um metro abaixo do
      // olhar e sai do cone justamente de quem quer descer.
      ladderItem.local.y = clamp(
        player.eyeLocal.y,
        MAST_LADDER.bottomY + 0.5,
        CROW_NEST.y + 1.4,
      );
    },
    label: () => {
      if (!player.canGrabMastLadder()) return null;
      // A mesma pergunta que o controlador faz para saber em que piso o jogador
      // está — não uma altura parecida escrita de novo aqui.
      return player.onCrowNest() ? 'Climb down to the deck' : 'Climb to the crow’s nest';
    },
    press: () => player.grabMastLadder(),
  };
  items.push(ladderItem);

  // Rombos: uma entrada só, que se muda para o buraco mais próximo. São até 24
  // ao mesmo tempo e nascem em posições imprevisíveis — cadastrar um item por
  // rombo obrigaria a mexer na lista no meio do combate.
  let targetBreach: Breach | null = null;

  /**
   * O alvo, se ele ainda for um rombo de verdade.
   *
   * O alvo é uma referência guardada numa closure, e `refresh` só roda quando o
   * foco é recalculado — ou seja, **nunca** enquanto o botão está segurado. Um
   * rombo tapado no meio do hold continuava aqui dentro, vivo e recebendo
   * tábuas, porque nada avisava esta variável de que ele tinha saído da lista.
   * A checagem de pertinência é o aviso, e ela é barata: no pior caso são 24
   * comparações de referência.
   */
  const currentBreach = (): Breach | null => {
    if (targetBreach && !ship.damage.breaches.includes(targetBreach)) targetBreach = null;
    return targetBreach;
  };

  const breachItem: Interactable = {
    id: 'breach',
    local: new THREE.Vector3(),
    range: REPAIR_REACH,
    level: 'hold',
    refresh: () => {
      targetBreach = aimedBreach(ship, player);
      if (targetBreach) breachItem.local.copy(targetBreach.local);
    },
    label: () => {
      const breach = currentBreach();
      if (!breach) return null;
      // O paiol vazio continua mostrando o rombo, e de propósito: sumir com o
      // aviso deixaria o jogador achando que está longe demais ou mirando
      // errado. O que ele precisa saber é que o buraco está lá e que não há mais
      // madeira para ele — daí em diante o trabalho é na bomba.
      if (!ship.hasPlanks) return 'No planks left — man the pump';
      const done = Math.round(clamp01(breach.repair) * 100);
      const left = `${ship.planks} in the locker`;
      return done > 0 ? `Hold to patch — ${done}% · ${left}` : `Hold to patch the hole · ${left}`;
    },
    hold: (dt) => {
      const breach = currentBreach();
      if (!breach) return;
      // O retorno **importa**: é ele que diz que o buraco fechou. Ignorá-lo era
      // o que mantinha o jogador pregando tábua no vazio depois dos 100%.
      if (ship.patchBreach(breach, dt)) targetBreach = null;
    },
    progress: () => {
      const breach = currentBreach();
      return breach && breach.repair > 0 ? clamp01(breach.repair) : null;
    },
  };
  items.push(breachItem);

  ship.cannons.forEach((cannon, index) => {
    const local = new THREE.Vector3();
    items.push({
      id: cannon.side > 0 ? 'cannon-starboard' : 'cannon-port',
      // O ponto de foco é a culatra, não a boca: é de onde se opera a peça, e é
      // o que impede o canhão de boreste de roubar o foco de quem está a
      // bombordo olhando através do navio.
      local: cannon.getPivotLocal(local),
      range: 2.5,
      level: 'deck',
      label: () => (cannon.side > 0 ? 'Man the starboard cannon' : 'Man the port cannon'),
      press: () => player.mountCannon(index),
    });
  });

  return items;
}

/**
 * O rombo que o jogador está **olhando**, e não simplesmente o mais próximo.
 *
 * `ShipDamage.findNear` responde por distância pura, que é o certo para decidir
 * se uma bala nova alarga um furo existente — mas é a pergunta errada aqui. Uma
 * salva abre vários buracos na mesma tábua, e `MERGE_DISTANCE` é de só 42 cm:
 * com dois rombos dentro do alcance da mão, o jogador mirava um e o código
 * pregava a tábua no outro, aos pés dele. A barra enchia, um buraco fechava, e o
 * que ele estava olhando continuava esguichando — exatamente a leitura de "cheguei
 * a 100% e o rombo não sumiu". Com a fusão mais apertada isso ficou **mais**
 * frequente, não menos: cabem mais rombos no mesmo palmo de costado.
 *
 * A pontuação é a mesma do foco de interação: mira pesa mais que distância.
 */
function aimedBreach(ship: Ship, player: PlayerController): Breach | null {
  // Frente é −Z, como em todo o resto do projeto.
  _aim.set(0, 0, -1).applyQuaternion(player.eyeQuaternion);

  let best: Breach | null = null;
  let bestScore = 0;

  for (const breach of ship.damage.breaches) {
    _toBreach.subVectors(breach.local, player.eyeLocal);
    const distance = _toBreach.length();
    if (distance > REPAIR_REACH || distance < 1e-4) continue;

    // Cosseno do ângulo entre a mira e o rombo. O que está atrás cai fora
    // sozinho, sem precisar de um segundo teste.
    const alignment = _toBreach.dot(_aim) / distance;
    if (alignment <= 0) continue;

    const score = alignment / (1 + distance * 0.25);
    if (score > bestScore) {
      bestScore = score;
      best = breach;
    }
  }

  return best;
}
