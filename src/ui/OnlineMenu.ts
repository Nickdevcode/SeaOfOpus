/**
 * As três telas do duelo em rede: escolher como encontrar alguém, digitar um
 * código, e esperar.
 *
 * Constrói DOM e nada mais. Véu, folha, foco, `Voltar` e navegação por controle
 * continuam sendo de `Menu` — ver o cabeçalho de lá para o porquê da divisa. O que
 * torna estas três diferentes das outras é o relógio: o conteúdo delas muda por
 * evento de socket, não por clique, e é `render` que absorve essa diferença.
 *
 * ## `render` é chamada muitas vezes por segundo
 *
 * Enquanto o cronômetro da fila corre, `render` roda a cada quadro. Duas regras
 * saem daí, e as duas são obrigatórias:
 *
 * 1. **Nunca reconstruir DOM.** Só escrever `textContent` e alternar `hidden`.
 *    Um `replaceChildren` por quadro apagaria o elemento focado, e o foco do
 *    navegador voltaria para o corpo do documento — o d-pad pararia de funcionar
 *    sozinho, no meio da espera.
 * 2. **Sair cedo quando nada mudou.** A chave de comparação em `lastKey` é a
 *    mesma técnica de `Menu.syncGlyphs`, pelo mesmo motivo.
 *
 * ## Quem navega é o clique, não o estado
 *
 * `render` **não** troca de tela. Quem leva de "online" para "esperando" é o
 * ouvinte do botão, no mesmo instante em que o jogador aperta. Se a navegação
 * viesse do estado da rede, a tela mudaria sozinha em cima da mão de quem está
 * apertando outra coisa, e o histórico do `Voltar` passaria a depender da latência
 * do servidor.
 */

import { NICKNAME_MAX_LENGTH, readString, settings } from '../core/Settings';
import { el } from './dom';
import type { Menu } from './Menu';

/**
 * Alfabeto do código de sala: 32 caracteres sem par ambíguo.
 *
 * Fora `I`, `O`, `0` e `1` — os quatro que se confundem quando alguém lê um
 * código em voz alta ou o copia de uma tela para um papel. Sobram 32 símbolos e
 * quatro casas, que dão 1.048.576 salas: o bastante para a colisão ser um caso
 * raro tratado pelo servidor, e curto o suficiente para caber num ditado.
 */
export const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

/** Casas do código. Ver `CODE_ALPHABET` para o tamanho do espaço. */
export const CODE_LENGTH = 4;

/** Em que pé está a conversa com o servidor de sala. */
export type OnlinePhase =
  | 'idle'
  | 'connecting'
  | 'queued'
  | 'hosting'
  | 'joining'
  | 'ready'
  | 'error';

/** Tudo que as telas de rede precisam saber para se desenharem. */
export interface OnlineViewState {
  phase: OnlinePhase;
  /** O código desta sala, quando já há um. */
  code: string | null;
  /** Apelido de quem está do outro lado, quando já entrou. */
  opponent: string | null;
  /** O que deu errado, ou uma linha de contexto. */
  message: string | null;
  /** Há quanto tempo se espera, para o cronômetro da fila. */
  waitingSeconds: number;
}

export interface OnlineMenuCallbacks {
  /** Entrar na fila e pegar quem estiver esperando. */
  onQuickMatch(nickname: string): void;
  /** Abrir uma sala e receber um código para passar adiante. */
  onCreateRoom(nickname: string): void;
  /** Entrar numa sala existente pelo código. */
  onJoinRoom(nickname: string, code: string): void;
  /** Desistir do que estiver em curso. Tem de ser idempotente. */
  onCancel(): void;
}

const IDLE_STATE: OnlineViewState = {
  phase: 'idle',
  code: null,
  opponent: null,
  message: null,
  waitingSeconds: 0,
};

/** `74` vira `1:14`. O cronômetro da espera não passa de minutos. */
function formatWait(seconds: number): string {
  const whole = Math.max(0, Math.floor(seconds));
  return `${Math.floor(whole / 60)}:${(whole % 60).toString().padStart(2, '0')}`;
}

export class OnlineMenu {
  /** As telas prontas, para `Menu` registrar no mapa dele. */
  readonly screens: ReadonlyMap<'online' | 'join' | 'room', HTMLDivElement>;

  /** Os quatro botões do código, cada um com o índice dele no alfabeto. */
  private readonly slots: HTMLButtonElement[] = [];
  private readonly codeIndices: number[] = new Array(CODE_LENGTH).fill(0);

  private readonly roomTitle: HTMLHeadingElement;
  private readonly roomBlurb: HTMLParagraphElement;
  private readonly roomCode: HTMLDivElement;
  private readonly roomCodeText: HTMLSpanElement;
  private readonly roomCopy: HTMLButtonElement;
  private readonly roomTimer: HTMLDivElement;
  private readonly nickInput: HTMLInputElement;
  private readonly onlineActions: HTMLButtonElement[] = [];

  /** Última pintura, para `render` sair cedo. Ver o cabeçalho. */
  private lastKey: string | null = null;
  /** Rótulo do "Copy", que vira "Copied" por um instante. */
  private copyTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(
    root: HTMLElement,
    private readonly callbacks: OnlineMenuCallbacks,
    private readonly menu: Menu,
  ) {
    const online = this.buildOnline(root);
    const join = this.buildJoin(root);

    const room = this.buildRoom(root);
    this.roomTitle = room.title;
    this.roomBlurb = room.blurb;
    this.roomCode = room.codeBox;
    this.roomCodeText = room.codeText;
    this.roomCopy = room.copy;
    this.roomTimer = room.timer;

    this.nickInput = online.nickInput;

    this.screens = new Map([
      ['online', online.overlay],
      ['join', join],
      ['room', room.overlay],
    ] as const);

    this.render(IDLE_STATE);
  }

  /**
   * Repinta as telas de rede. Barata e idempotente — ver o cabeçalho do módulo.
   */
  render(state: OnlineViewState): void {
    // O cronômetro entra na chave em segundos inteiros: sem isso a espera nunca
    // andaria; com o valor bruto, a comparação nunca casaria e a saída cedo
    // deixaria de existir.
    const key = [
      state.phase,
      state.code ?? '',
      state.opponent ?? '',
      state.message ?? '',
      Math.floor(state.waitingSeconds),
    ].join('|');
    if (key === this.lastKey) return;
    this.lastKey = key;

    const busy = state.phase === 'connecting';
    for (const button of this.onlineActions) button.disabled = busy;

    const showCode = state.phase === 'hosting' && state.code !== null;
    this.roomCode.hidden = !showCode;
    if (showCode && state.code) this.roomCodeText.textContent = state.code;

    // O relógio só corre enquanto de fato se espera. Numa tela de erro ou de
    // "achei", um cronômetro andando diria que ainda há o que aguardar.
    const waiting = state.phase === 'queued' || state.phase === 'hosting';
    this.roomTimer.hidden = !waiting;
    if (waiting) this.roomTimer.textContent = formatWait(state.waitingSeconds);

    this.roomTitle.textContent = this.titleFor(state);
    this.roomBlurb.textContent = state.message ?? this.blurbFor(state);
  }

  private titleFor(state: OnlineViewState): string {
    switch (state.phase) {
      case 'connecting':
        return 'Casting off';
      case 'queued':
        return 'Looking for a captain';
      case 'hosting':
        return 'Your room is open';
      case 'joining':
        return 'Boarding the room';
      case 'ready':
        return state.opponent ? `${state.opponent} is aboard` : 'Opponent aboard';
      case 'error':
        return 'The line went dead';
      default:
        return 'Online duel';
    }
  }

  private blurbFor(state: OnlineViewState): string {
    switch (state.phase) {
      case 'connecting':
        return 'Reaching the harbour master.';
      case 'queued':
        return 'You will be paired with the next captain who shows up.';
      case 'hosting':
        return 'Pass the code along. The duel starts the moment someone joins.';
      case 'joining':
        return 'Hold on.';
      case 'ready':
        return 'Weighing anchor.';
      default:
        return '';
    }
  }

  // -- construção ---------------------------------------------------------------

  private buildOnline(root: HTMLElement): {
    overlay: HTMLDivElement;
    nickInput: HTMLInputElement;
  } {
    const overlay = el('div', 'overlay', root);
    const sheet = el('div', 'sheet sheet--narrow', overlay);

    // Sem a marca: subtela não repete logotipo — é a mesma regra que Ajustes e
    // Controles já seguem, e o cabeçalho de seção dá o título que falta.
    const nameSection = el('div', 'section', sheet);
    el('h2', 'section__label', nameSection, 'Sail under the name');

    const nickInput = el('input', 'nickname', nameSection);
    nickInput.type = 'text';
    nickInput.maxLength = NICKNAME_MAX_LENGTH;
    nickInput.value = settings.preferences.nickname;
    nickInput.spellcheck = false;
    nickInput.autocomplete = 'off';
    // O rótulo visível é o cabeçalho da seção, que não é um `<label>`; daí o
    // `aria-label`, que diz a mesma coisa sem inventar um id só para o `for`.
    nickInput.setAttribute('aria-label', 'Your name');
    nickInput.addEventListener('input', () => {
      // Grava cru e saneia na leitura: cortar acentos ou espaços **enquanto** se
      // digita mexe na posição do cursor, e o campo passa a "comer" letras.
      settings.update({ nickname: nickInput.value });
    });

    const section = el('div', 'section', sheet);
    el('h2', 'section__label', section, 'Find your duel');

    const actions = el('div', 'actions actions--stacked', section);

    const quick = el('button', 'button button--primary', actions, 'Find a captain');
    quick.type = 'button';
    quick.addEventListener('click', () => {
      this.menu.push('room');
      this.callbacks.onQuickMatch(this.nickname());
    });

    const create = el('button', 'button', actions, 'Open a room');
    create.type = 'button';
    create.addEventListener('click', () => {
      this.menu.push('room');
      this.callbacks.onCreateRoom(this.nickname());
    });

    const join = el('button', 'button', actions, 'Enter a room');
    join.type = 'button';
    join.addEventListener('click', () => this.menu.push('join'));

    const back = el('button', 'button', actions, 'Back');
    back.type = 'button';
    back.addEventListener('click', () => this.menu.back());

    this.onlineActions.push(quick, create, join);

    this.menu.buildHintLine(sheet, [
      { key: '↑ ↓', text: 'Move between fields' },
      { action: 'pause', text: 'Back' },
    ]);

    return { overlay, nickInput };
  }

  private buildJoin(root: HTMLElement): HTMLDivElement {
    const overlay = el('div', 'overlay', root);
    const sheet = el('div', 'sheet sheet--narrow', overlay);

    const section = el('div', 'section', sheet);
    el('h2', 'section__label', section, 'Room code');

    const box = el('div', 'code', section);
    box.setAttribute('role', 'group');
    box.setAttribute('aria-label', `Room code, ${CODE_LENGTH} characters`);

    for (let i = 0; i < CODE_LENGTH; i++) {
      const slot = el('button', 'code__slot', box, CODE_ALPHABET[0]);
      slot.type = 'button';
      // `spinbutton` é o papel de um campo cujo valor se percorre numa lista
      // ordenada — que é exatamente o que ↑/↓ fazem aqui.
      slot.setAttribute('role', 'spinbutton');
      slot.setAttribute('aria-label', `Character ${i + 1} of ${CODE_LENGTH}`);
      slot.setAttribute('aria-valuetext', CODE_ALPHABET[0] ?? 'A');
      this.slots.push(slot);
      this.menu.registerWidget(slot, {
        // ←/→ **não** mudam a letra: eles andam entre as casas, que é como se lê
        // um código. Devolver `false` entrega o passo a `moveFocus`, e do último
        // slot ele escapa para o botão de confirmar. Ver `MenuWidget.step`.
        cycle: () => false,
        step: (direction) => {
          this.nudgeSlot(i, direction);
          return true;
        },
      });
    }

    // Digitar é o caminho de quem tem teclado, e ele tem de ser o mais direto:
    // a letra entra na casa focada e o foco anda sozinho, como num campo de
    // código de banco.
    box.addEventListener('keydown', (event) => this.onCodeKey(event));
    box.addEventListener('paste', (event) => this.onCodePaste(event));

    const actions = el('div', 'actions', sheet);
    const confirm = el('button', 'button button--primary', actions, 'Enter');
    confirm.type = 'button';
    confirm.addEventListener('click', () => {
      this.menu.replace('room');
      this.callbacks.onJoinRoom(this.nickname(), this.readCode());
    });

    const back = el('button', 'button', actions, 'Back');
    back.type = 'button';
    back.addEventListener('click', () => this.menu.back());

    this.menu.buildHintLine(sheet, [
      { key: '↑ ↓', text: 'Change the character' },
      { key: '← →', text: 'Move between characters' },
    ]);

    return overlay;
  }

  private buildRoom(root: HTMLElement): {
    overlay: HTMLDivElement;
    title: HTMLHeadingElement;
    blurb: HTMLParagraphElement;
    codeBox: HTMLDivElement;
    codeText: HTMLSpanElement;
    copy: HTMLButtonElement;
    timer: HTMLDivElement;
  } {
    const overlay = el('div', 'overlay', root);
    const sheet = el('div', 'sheet sheet--narrow', overlay);

    const title = el('h2', 'room__title', sheet, 'Online duel');
    const blurb = el('p', 'room__blurb', sheet, '');

    const codeBox = el('div', 'code-display', sheet);
    const codeText = el('span', 'code-display__value', codeBox, '····');
    // `aria-live` na região do código, e não no título: o código é a única coisa
    // desta tela que alguém precisa **anotar**, e é o que tem de ser lido em voz
    // alta assim que aparece.
    codeBox.setAttribute('aria-live', 'polite');

    const copy = el('button', 'button code-display__copy', codeBox, 'Copy');
    copy.type = 'button';
    copy.addEventListener('click', () => void this.copyCode());

    const timer = el('div', 'code-display__timer', sheet, '0:00');

    const actions = el('div', 'actions', sheet);
    const cancel = el('button', 'button button--primary', actions, 'Cancel');
    cancel.type = 'button';
    cancel.addEventListener('click', () => this.menu.back());

    return { overlay, title, blurb, codeBox, codeText, copy, timer };
  }

  // -- código de sala -----------------------------------------------------------

  /** Move uma casa do código um passo no alfabeto, dando a volta nas pontas. */
  private nudgeSlot(index: number, direction: 1 | -1): void {
    const size = CODE_ALPHABET.length;
    const next = (this.codeIndices[index]! + direction + size) % size;
    this.writeSlot(index, next);
  }

  private writeSlot(index: number, alphabetIndex: number): void {
    const slot = this.slots[index];
    if (!slot) return;
    const character = CODE_ALPHABET[alphabetIndex] ?? CODE_ALPHABET[0]!;
    this.codeIndices[index] = alphabetIndex;
    slot.textContent = character;
    slot.setAttribute('aria-valuetext', character);
  }

  /** Põe um caractere na casa focada e avança, se ele existir no alfabeto. */
  private typeCharacter(character: string): void {
    const focused = document.activeElement as HTMLElement | null;
    const index = focused ? this.slots.indexOf(focused as HTMLButtonElement) : -1;
    if (index < 0) return;

    const alphabetIndex = CODE_ALPHABET.indexOf(character.toUpperCase());
    // Caractere fora do alfabeto é ignorado em silêncio. Adivinhar (mapear `0`
    // para `O`) seria pior: nenhum dos dois existe aqui, e o palpite entraria uma
    // letra errada com a mesma confiança de uma certa.
    if (alphabetIndex < 0) return;

    this.writeSlot(index, alphabetIndex);
    this.slots[index + 1]?.focus();
  }

  private onCodeKey(event: KeyboardEvent): void {
    if (event.key === 'Backspace') {
      event.preventDefault();
      const focused = document.activeElement as HTMLElement | null;
      const index = focused ? this.slots.indexOf(focused as HTMLButtonElement) : -1;
      if (index < 0) return;
      // Apaga a casa atual e recua, que é o que a tecla faz em qualquer campo.
      this.writeSlot(index, 0);
      this.slots[index - 1]?.focus();
      return;
    }

    // Uma tecla só, e sem modificador: `Tab`, as setas e os atalhos do navegador
    // continuam sendo de quem já os trata.
    if (event.key.length !== 1 || event.ctrlKey || event.metaKey || event.altKey) return;
    event.preventDefault();
    this.typeCharacter(event.key);
  }

  private onCodePaste(event: ClipboardEvent): void {
    const text = event.clipboardData?.getData('text') ?? '';
    if (!text) return;
    event.preventDefault();

    // Aceita o código colado de qualquer forma — com espaços, em minúsculas, ou
    // dentro de um link de convite: o que interessa são os últimos caracteres
    // válidos, que é o que um código é.
    const characters = [...text.toUpperCase()].filter((c) => CODE_ALPHABET.includes(c));
    const code = characters.slice(0, CODE_LENGTH);
    for (let i = 0; i < code.length; i++) {
      this.writeSlot(i, CODE_ALPHABET.indexOf(code[i]!));
    }
    this.slots[Math.min(code.length, CODE_LENGTH - 1)]?.focus();
  }

  private readCode(): string {
    return this.codeIndices.map((index) => CODE_ALPHABET[index] ?? 'A').join('');
  }

  private async copyCode(): Promise<void> {
    const code = this.roomCodeText.textContent ?? '';
    if (!code) return;
    try {
      await navigator.clipboard.writeText(code);
      this.flashCopied('Copied');
    } catch {
      // Área de transferência negada (contexto inseguro, permissão recusada): o
      // código continua na tela em corpo grande, que é o plano de fundo desde o
      // começo. Dizer o que houve vale mais que um botão que não reage.
      this.flashCopied('Copy failed');
    }
  }

  private flashCopied(label: string): void {
    this.roomCopy.textContent = label;
    if (this.copyTimer !== null) clearTimeout(this.copyTimer);
    this.copyTimer = setTimeout(() => {
      this.copyTimer = null;
      this.roomCopy.textContent = 'Copy';
    }, 1400);
  }

  /** O apelido já saneado, que é o que vai para o servidor. */
  private nickname(): string {
    const clean = readString(this.nickInput.value, NICKNAME_MAX_LENGTH, 'Sailor');
    // O campo é reescrito com o que de fato será usado: quem digitou só espaços
    // tem de ver o nome com que vai entrar, e não descobri-lo pelo adversário.
    if (clean !== this.nickInput.value) {
      this.nickInput.value = clean;
      settings.update({ nickname: clean });
    }
    return clean;
  }
}
