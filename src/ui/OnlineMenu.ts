/**
 * The three screens of the networked duel: choosing how to find someone, typing a code,
 * and waiting.
 *
 * It builds DOM and nothing else. Veil, sheet, focus, `Back` and gamepad navigation still
 * belong to `Menu` — see the header over there for why the line is drawn where it is.
 * What makes these three different from the others is the clock: their content changes on
 * a socket event, not on a click, and it is `render` that absorbs that difference.
 *
 * ## `render` is called many times a second
 *
 * While the queue's timer runs, `render` runs every frame. Two rules follow from that,
 * and both are mandatory:
 *
 * 1. **Never rebuild DOM.** Only write `textContent` and toggle `hidden`. One
 *    `replaceChildren` per frame would wipe out the focused element, and the browser's
 *    focus would fall back to the document body — the d-pad would stop working on its
 *    own, in the middle of the wait.
 * 2. **Bail out early when nothing changed.** The comparison key in `lastKey` is the same
 *    technique as `Menu.syncGlyphs`, for the same reason.
 *
 * ## What navigates is the click, not the state
 *
 * `render` does **not** change screens. What takes you from "online" to "waiting" is the
 * button's listener, at the very instant the player presses it. If the navigation came
 * from the network's state, the screen would change on its own under the hand of someone
 * pressing something else, and the `Back` history would come to depend on the server's
 * latency.
 */

import { NICKNAME_MAX_LENGTH, readString, settings } from '../core/Settings';
import { el } from './dom';
import type { Menu } from './Menu';

/**
 * The room code's alphabet: 32 characters with no ambiguous pair.
 *
 * `I`, `O`, `0` and `1` are out — the four that get confused when someone reads a code
 * out loud or copies it from a screen onto paper. That leaves 32 symbols and four slots,
 * which give 1,048,576 rooms: enough for a collision to be a rare case handled by the
 * server, and short enough to fit into something dictated over the phone.
 */
export const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

/** Slots in the code. See `CODE_ALPHABET` for the size of the space. */
export const CODE_LENGTH = 4;

/** Where the conversation with the room server stands. */
export type OnlinePhase =
  | 'idle'
  | 'connecting'
  | 'queued'
  | 'hosting'
  | 'joining'
  | 'ready'
  | 'error';

/** Everything the network screens have to know in order to draw themselves. */
export interface OnlineViewState {
  phase: OnlinePhase;
  /** This room's code, once there is one. */
  code: string | null;
  /** The nickname of whoever is on the other side, once they have joined. */
  opponent: string | null;
  /** What went wrong, or a line of context. */
  message: string | null;
  /** How long the wait has been, for the queue's timer. */
  waitingSeconds: number;
}

export interface OnlineMenuCallbacks {
  /** Get into the queue and take whoever is waiting. */
  onQuickMatch(nickname: string): void;
  /** Open a room and get a code to pass along. */
  onCreateRoom(nickname: string): void;
  /** Join an existing room by its code. */
  onJoinRoom(nickname: string, code: string): void;
  /** Give up on whatever is underway. It has to be idempotent. */
  onCancel(): void;
}

const IDLE_STATE: OnlineViewState = {
  phase: 'idle',
  code: null,
  opponent: null,
  message: null,
  waitingSeconds: 0,
};

/** `74` becomes `1:14`. The waiting timer never goes past minutes. */
function formatWait(seconds: number): string {
  const whole = Math.max(0, Math.floor(seconds));
  return `${Math.floor(whole / 60)}:${(whole % 60).toString().padStart(2, '0')}`;
}

export class OnlineMenu {
  /** The finished screens, for `Menu` to register in its map. */
  readonly screens: ReadonlyMap<'online' | 'join' | 'room', HTMLDivElement>;

  /** The code's four buttons, each with its index into the alphabet. */
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

  /** The last paint, so `render` can bail out early. See the header. */
  private lastKey: string | null = null;
  /** The "Copy" label, which turns into "Copied" for a moment. */
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
   * Repaints the network screens. Cheap and idempotent — see the module's header.
   */
  render(state: OnlineViewState): void {
    // The timer goes into the key as whole seconds: without that the wait would never
    // move; with the raw value, the comparison would never match and the early bail-out
    // would stop existing.
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

    // The clock only runs while you are actually waiting. On an error screen or on a
    // "found them" screen, a running timer would say there is still something to wait
    // for.
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

  // -- construction -------------------------------------------------------------

  private buildOnline(root: HTMLElement): {
    overlay: HTMLDivElement;
    nickInput: HTMLInputElement;
  } {
    const overlay = el('div', 'overlay', root);
    const sheet = el('div', 'sheet sheet--narrow', overlay);

    // No wordmark: a subscreen does not repeat the logo — it is the same rule Settings
    // and Controls already follow, and the section header gives the title it is missing.
    const nameSection = el('div', 'section', sheet);
    el('h2', 'section__label', nameSection, 'Sail under the name');

    const nickInput = el('input', 'nickname', nameSection);
    nickInput.type = 'text';
    nickInput.maxLength = NICKNAME_MAX_LENGTH;
    nickInput.value = settings.preferences.nickname;
    nickInput.spellcheck = false;
    nickInput.autocomplete = 'off';
    // The visible label is the section's header, which is not a `<label>`; hence the
    // `aria-label`, which says the same thing without inventing an id just for `for`.
    nickInput.setAttribute('aria-label', 'Your name');
    nickInput.addEventListener('input', () => {
      // Store it raw and sanitize on read: trimming accents or spaces **while** typing
      // moves the caret, and the field starts "eating" letters.
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
      // `spinbutton` is the role of a field whose value is walked through an ordered
      // list — which is exactly what ↑/↓ do here.
      slot.setAttribute('role', 'spinbutton');
      slot.setAttribute('aria-label', `Character ${i + 1} of ${CODE_LENGTH}`);
      slot.setAttribute('aria-valuetext', CODE_ALPHABET[0] ?? 'A');
      this.slots.push(slot);
      this.menu.registerWidget(slot, {
        // ←/→ do **not** change the letter: they walk between the slots, which is how a
        // code is read. Returning `false` hands the step over to `moveFocus`, and from
        // the last slot it escapes to the confirm button. See `MenuWidget.step`.
        cycle: () => false,
        step: (direction) => {
          this.nudgeSlot(i, direction);
          return true;
        },
      });
    }

    // Typing is the path for whoever has a keyboard, and it has to be the most direct
    // one: the letter goes into the focused slot and the focus moves on its own, like in
    // a bank's code field.
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
    // `aria-live` on the code's region, and not on the title: the code is the one thing
    // on this screen someone has to **write down**, and it is what has to be read out
    // loud as soon as it appears.
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

  // -- room code ----------------------------------------------------------------

  /** Moves one slot of the code a step through the alphabet, wrapping at the ends. */
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

  /** Puts a character into the focused slot and moves on, if it exists in the alphabet. */
  private typeCharacter(character: string): void {
    const focused = document.activeElement as HTMLElement | null;
    const index = focused ? this.slots.indexOf(focused as HTMLButtonElement) : -1;
    if (index < 0) return;

    const alphabetIndex = CODE_ALPHABET.indexOf(character.toUpperCase());
    // A character outside the alphabet is ignored in silence. Guessing (mapping `0` to
    // `O`) would be worse: neither of the two exists here, and the guess would enter a
    // wrong letter with the same confidence as a right one.
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
      // It clears the current slot and steps back, which is what the key does in any
      // field.
      this.writeSlot(index, 0);
      this.slots[index - 1]?.focus();
      return;
    }

    // A single key, and no modifier: `Tab`, the arrows and the browser's shortcuts stay
    // with whoever already handles them.
    if (event.key.length !== 1 || event.ctrlKey || event.metaKey || event.altKey) return;
    event.preventDefault();
    this.typeCharacter(event.key);
  }

  private onCodePaste(event: ClipboardEvent): void {
    const text = event.clipboardData?.getData('text') ?? '';
    if (!text) return;
    event.preventDefault();

    // It accepts the code pasted in any shape — with spaces, in lowercase, or inside an
    // invite link: what matters are the valid characters, which is what a code is.
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
      // Clipboard denied (insecure context, permission refused): the code is still on
      // the screen in large type, which has been the fallback from the start. Saying what
      // happened is worth more than a button that does not react.
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

  /** The nickname already sanitized, which is what goes to the server. */
  private nickname(): string {
    const clean = readString(this.nickInput.value, NICKNAME_MAX_LENGTH, 'Sailor');
    // The field is rewritten with what will actually be used: whoever typed only spaces
    // has to see the name they are going in with, and not find it out from their
    // opponent.
    if (clean !== this.nickInput.value) {
      this.nickInput.value = clean;
      settings.update({ nickname: clean });
    }
    return clean;
  }
}
