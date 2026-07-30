/**
 * The overlay screens: title, duel against the machine, settings, controls and end
 * of match — plus the three networked ones, which come from `OnlineMenu`.
 *
 * The ones in here live together because they are **one family**: same veil, same
 * sheet, same navigation, and never more than one visible. Splitting them into five
 * modules would duplicate the show/hide logic and the focus logic across four places
 * to gain nothing — whoever touches the veil wants to touch all of them at once.
 *
 * ## Why online is the only one that leaves this file
 *
 * Everything in this file is **synchronous**: nothing changes without a click or a
 * focus step. The network screens are the opposite — their content changes on an
 * external event (the socket), on a clock that is not the player's. `OnlineMenu`
 * builds that DOM and registers it in `screens`; veil, focus, `back()` and gamepad
 * navigation are still handled here. It is an extraction of *construction*, not of
 * *behavior*.
 *
 * ## Navigation
 *
 * Everything here is a real `<button>`, not a `div` with an `onclick`. What would be
 * expensive to reimplement comes for free: tab order, `Enter`/`Space`, visible focus,
 * screen-reader announcement and the right cursor. The d-pad and the left stick
 * become a focus step between the buttons of the active screen, which makes the
 * gamepad work without a focus system running in parallel with the browser's.
 *
 * The two axes do not do the same thing, and that is what makes the Settings screen
 * operable on the gamepad alone: **vertical changes field, horizontal moves the
 * focused field** — drags the slider, cycles the option in the group, flips the
 * toggle. See `navigate`.
 *
 * The gamepad is read straight from `input.gamepad`, not from `Input`'s actions: with
 * the menu open game input is frozen (`setCaptured`), and that is exactly what is
 * wanted — `A` in the menu must not turn into a jump on deck on the next frame. The
 * only actions `Input` lets through while frozen are `pause` and `controls`, which is
 * what makes the Menu button close what it opened; the main loop consumes them.
 */

import { DIFFICULTIES, DIFFICULTY_ORDER, type DifficultyId } from '../ai/Difficulty';
import { GamepadButton } from '../core/Gamepad';
import { ACTION_LABELS, NO_BINDING, type Action, type Input } from '../core/Input';
import { clamp } from '../core/MathUtils';
import {
  PREFERENCE_RANGES,
  QUALITY_ORDER,
  WEATHER_MODES,
  settings,
  type PlayerPreferences,
  type QualityPreset,
  type RangedPreference,
  type WeatherMode,
} from '../core/Settings';
import type { MatchStats } from '../game/Match';
import { buildBrand, el } from './dom';
import {
  OnlineMenu,
  type OnlineMenuCallbacks,
  type OnlineViewState,
} from './OnlineMenu';
import '../styles/menu.css';

/** Which screen is up. `none` is the game running, with no overlay. */
export type Screen =
  | 'none'
  | 'title'
  | 'solo'
  | 'online'
  | 'join'
  | 'room'
  | 'settings'
  | 'controls'
  | 'outcome';

/**
 * Screens the "Back" has somewhere to go from.
 *
 * `title` is the root and `outcome` is a dead end with exits of its own ("Sail
 * again" and "Main menu") — on neither of them should `Esc`/`B` do anything, and
 * that is why the rule is a list and not a `screen !== 'title'`.
 */
const RETURNABLE: ReadonlySet<Screen> = new Set<Screen>([
  'solo',
  'online',
  'join',
  'room',
  'settings',
  'controls',
]);

/** Actions the controls screen lists, in the order you learn the ship. */
const LISTED_ACTIONS: readonly Action[] = [
  'moveForward',
  'moveLeft',
  'moveBack',
  'moveRight',
  'sprint',
  'jump',
  'interact',
  'exit',
  'reload',
  'fire',
  'aim',
  'freeCamera',
  'controls',
  'debug',
  'pause',
];

/** Labels for the weather options. The list of modes comes from `WEATHER_MODES`. */
const WEATHER_LABELS: Record<WeatherMode, string> = {
  dynamic: 'Live',
  clear: 'Clear',
  breeze: 'Breeze',
  squall: 'Squall',
  storm: 'Storm',
};

/**
 * Left-stick reading that counts as a menu direction.
 *
 * The number is low because the value arriving from `GamepadManager` **has
 * already been through a quadratic curve** (see `applyDeadzone`): a reading of
 * 0.2 matches a little over half the physical travel with the default deadzone,
 * which is the gesture expected from someone who wants to step down one item.
 * Comparing against 0.5 here would demand three quarters of the travel, and the
 * navigation would feel sticky.
 */
const NAV_STICK = 0.2;

/**
 * Repeat of a held direction, in seconds: the wait until the first repeat and the
 * interval between the ones after it.
 *
 * The first step is always immediate — whoever taps the d-pad wants a step, not a
 * wait. The pause that follows is what separates "moved one item" from "crossed
 * the volume bar", and the short interval after it is what makes dragging a
 * slider from 0 to 100% with the gamepad bearable.
 */
const NAV_FIRST_REPEAT = 0.42;
const NAV_REPEAT = 0.08;

/**
 * What counts as a focus step.
 *
 * A constant, and not the selector written twice: `show` uses this to pick where
 * focus lands and `moveFocus` to know where it can walk. While they were two
 * literals, a new field would show up in d-pad navigation but never take the entry
 * focus — and the symptom was a first `↓` that looked like it did nothing.
 *
 * A disabled button is left out: it takes no focus, and including it would give a
 * d-pad step that vanishes into thin air.
 */
const FOCUSABLE = 'button:not([disabled]), input[type="range"], input[type="text"]';

/**
 * Writes a numeric preference.
 *
 * The `as` is safe by construction: every field listed in `RangedPreference` is a
 * `number` in `PlayerPreferences`. The alternative was a chain of `if`s, one per
 * field, which is the kind of code that ages badly with every new setting.
 */
function updateNumber(preference: RangedPreference, value: number): void {
  settings.update({ [preference]: value } as Partial<PlayerPreferences>);
}

/** Two opposite keys become an axis. Pressed together they cancel out. */
function axis(positive: boolean, negative: boolean): -1 | 0 | 1 {
  return positive === negative ? 0 : positive ? 1 : -1;
}

/**
 * Meters shown on each captain card, from 0 to 1.
 *
 * They are **derived from the presets**, not typed in: changing `aimSigma` in
 * `Difficulty` moves the little bar on its own. Gunnery and reaction are inverted
 * because in both the low number is the good one.
 */
function meters(id: DifficultyId): readonly { label: string; value: number }[] {
  const preset = DIFFICULTIES[id];
  return [
    { label: 'Gunnery', value: 1 - preset.aimSigma / 0.06 },
    { label: 'Reaction', value: 1 - preset.reaction / 1.4 },
    { label: 'Reach', value: preset.engageRange / 160 },
  ];
}

/**
 * A footer hint.
 *
 * With `action`, the glyph swaps on its own when the player changes device — which
 * is the point: the line used to say `Tab`, `Esc` and `C` forever, gamepad in
 * hand included. `key` is the way out for hints that are not a game action (a
 * ladder's `W / S`, for example).
 */
export interface Hint {
  action?: Action;
  key?: string;
  text: string;
}

export interface MenuCallbacks {
  /** The player cast off against the machine. */
  onStartSolo(difficulty: DifficultyId): void;
  /** Came back to the title menu from the end of a match. */
  onQuitToTitle(): void;
  /** Any click or focus move, so the audio can answer. */
  onNavigate?(kind: 'move' | 'confirm' | 'back'): void;
  /** What the buttons on the network screens trigger. See `OnlineMenu`. */
  readonly online: OnlineMenuCallbacks;
}

/** How a match ended, so the outcome screen knows what to offer. */
export type OutcomeMode = 'solo' | 'online';

/**
 * A field that answers ←/→ without being a slider, an option group or a toggle.
 *
 * It exists so `cycleOption` stays the horizontal rule for the whole menu while
 * outside screens add fields of their own. Without it, `Menu` would have to know
 * the CSS class of every new widget — and what counts as one character of a room
 * code is not this file's business.
 *
 * @returns `false` when the step was not consumed: `moveFocus` takes over, and the
 * focus escapes to the neighboring field. It is the same contract as the end of a
 * group.
 */
export interface MenuWidget {
  /** ←/→ on the focused field. */
  cycle(direction: 1 | -1): boolean;
  /**
   * ↑/↓ on the focused field, for the fields whose natural axis is the vertical one.
   *
   * It is the declared exception to the "vertical changes field" rule, and it
   * exists for one case: a room code is read from left to right, so ←/→ have to
   * walk between the characters — it is the gesture anyone tries first. If the
   * letter changed on the horizontal, crossing the code would demand the axis the
   * eye uses to read it, and leaving the field would have no way out at all.
   *
   * Returning `false` here hands the step back to `moveFocus`, as always.
   */
  step?(direction: 1 | -1): boolean;
}

export class Menu {
  private readonly root: HTMLDivElement;
  private readonly screens = new Map<Exclude<Screen, 'none'>, HTMLDivElement>();

  private screen: Screen = 'title';
  private difficulty: DifficultyId = 'corsair';

  /** The three network screens. Builds their DOM; navigation is still handled here. */
  private readonly online: OnlineMenu;

  /**
   * The "Duel another captain" card.
   *
   * Kept because it is the only one on the screen that can be born dead: with no
   * room server configured there is no network play, and a button that opens a
   * screen only to fail is worse than a dimmed button that says why. See
   * `setOnlineAvailable`.
   *
   * `!` because what creates it is `buildTitle`, called from the constructor.
   */
  private onlineCard!: HTMLButtonElement;
  /** The card's original blurb, to put back when the mode returns. */
  private onlineBlurb = '';

  private readonly choiceButtons = new Map<DifficultyId, HTMLButtonElement>();
  private readonly outcomeBox: HTMLDivElement;
  private readonly outcomeTitle: HTMLHeadingElement;
  private readonly outcomeBlurb: HTMLParagraphElement;
  private readonly tally: HTMLDivElement;
  /** "Sail again", which only exists against the machine — see `showOutcome`. */
  private readonly outcomeAgain: HTMLButtonElement;
  /** Rows of the controls screen, to swap the glyphs live. */
  private readonly controlRows: {
    action: Action;
    keyboard: HTMLElement;
    gamepad: HTMLElement;
  }[] = [];
  /** Glyphs of the hint lines, which change device along with the table. */
  private readonly hintGlyphs: { action: Action; item: HTMLElement; glyph: HTMLElement }[] = [];
  /** Device + layout already painted, so the DOM is not rewritten every frame. */
  private lastGlyphKey: string | null = null;

  /** Menu direction held on the gamepad, and the time until the next step. */
  private navX = 0;
  private navY = 0;
  private navRepeat = 0;

  /**
   * The path taken to get here, so "Back" undoes one step at a time.
   *
   * It was a single field (`returnTo`), and that was enough while settings and
   * controls were the only subscreens. With `title → online → join a room`, a
   * single field loses the middle rung and Back jumps to the title. Pushing
   * `'none'` is still what makes `Esc` mid-duel hand the player back to the deck.
   */
  private readonly history: Screen[] = [];

  /** Fields from outside screens that answer ←/→. See `MenuWidget`. */
  private readonly widgets = new WeakMap<HTMLElement, MenuWidget>();

  constructor(
    parent: HTMLElement,
    private readonly callbacks: MenuCallbacks,
  ) {
    this.root = el('div', '', parent);

    this.screens.set('title', this.buildTitle());
    this.screens.set('solo', this.buildSolo());
    this.screens.set('settings', this.buildSettings());
    this.screens.set('controls', this.buildControls());

    const outcome = this.buildOutcome();
    this.screens.set('outcome', outcome.overlay);
    this.outcomeBox = outcome.box;
    this.outcomeTitle = outcome.title;
    this.outcomeBlurb = outcome.blurb;
    this.tally = outcome.tally;
    this.outcomeAgain = outcome.again;

    // After the ones from here: `OnlineMenu`'s constructor calls `registerWidget`,
    // which depends on `this.widgets` — and class fields are already initialized.
    this.online = new OnlineMenu(this.root, callbacks.online, this);
    for (const [name, overlay] of this.online.screens) this.screens.set(name, overlay);

    this.show('title');
  }

  /**
   * A field from an outside screen that wants ←/→. See `MenuWidget`.
   *
   * Public because the caller is `OnlineMenu`, which builds its own DOM and is the
   * only one that knows what each of its elements does.
   */
  registerWidget(element: HTMLElement, widget: MenuWidget): void {
    this.widgets.set(element, widget);
  }

  /** Repaints the network screens with the state `OnlineSession` reports. */
  setOnlineState(state: OnlineViewState): void {
    this.online.render(state);
  }

  /**
   * Turns the network duel on or off on the title screen.
   *
   * Turned off, the card stays on the screen with the reason written where the
   * blurb was — failing here is failing at the right time. Hiding the card would be
   * worse: someone looking for the online mode would conclude it does not exist.
   */
  setOnlineAvailable(available: boolean, reason?: string): void {
    this.onlineCard.disabled = !available;
    const blurb = this.onlineCard.querySelector<HTMLElement>('.mode__blurb');
    if (!blurb) return;
    // The blurb is put back when the mode returns: the reason is a state, not a
    // permanent replacement.
    blurb.textContent = available ? this.onlineBlurb : (reason ?? this.onlineBlurb);
  }

  get current(): Screen {
    return this.screen;
  }

  /** `true` when an overlay is up (and the game should not receive input). */
  get open(): boolean {
    return this.screen !== 'none';
  }

  show(screen: Screen): void {
    this.screen = screen;
    for (const [name, overlay] of this.screens) overlay.hidden = name !== screen;

    if (screen === 'none') return;
    // Focus goes to the screen's first button: without this, `Tab` would start from
    // the top of the document and the d-pad would have nowhere to set out from.
    const first = this.screens.get(screen)?.querySelector<HTMLElement>(FOCUSABLE);
    first?.focus();
  }

  /**
   * Shows the result of a match.
   *
   * `mode` decides whether there is a "Sail again": against the machine the button
   * restarts the duel on the spot, but over the network there is nothing to restart
   * from one side alone — the opponent is already back in their own menu, and a
   * rematch is a conversation between the two.
   */
  showOutcome(won: boolean, stats: MatchStats, mode: OutcomeMode = 'solo'): void {
    // The outcome screen is a dead end: Back does not leave it, and what was on the
    // stack before no longer leads anywhere. Without this line the stack only grows.
    this.history.length = 0;
    this.outcomeAgain.hidden = mode !== 'solo';
    this.outcomeBox.className = `sheet outcome ${won ? 'outcome--won' : 'outcome--lost'}`;
    this.outcomeTitle.textContent = won ? 'Enemy sloop sunk' : 'Your sloop went down';
    this.outcomeBlurb.textContent = won
      ? 'The red sail is under. The horizon is yours.'
      : 'The water outran the hammer. It happens.';

    const minutes = Math.floor(stats.duration / 60);
    const seconds = Math.floor(stats.duration % 60);
    const accuracy = stats.shotsFired > 0
      ? `${Math.round((stats.shotsLanded / stats.shotsFired) * 100)}%`
      : '—';

    this.tally.replaceChildren(
      ...[
        { value: `${minutes}:${seconds.toString().padStart(2, '0')}`, label: 'Duration' },
        { value: `${stats.shotsFired}`, label: 'Shots fired' },
        { value: accuracy, label: 'Hit rate' },
        { value: `${stats.breachesDealt}`, label: 'Holes dealt' },
        { value: `${stats.breachesTaken}`, label: 'Holes taken' },
      ].map((entry) => {
        const item = el('div', 'tally__item');
        el('div', 'tally__value', item, entry.value);
        el('div', 'tally__label', item, entry.label);
        return item;
      }),
    );

    this.show('outcome');
  }

  /**
   * One menu frame: gamepad navigation and glyph syncing.
   *
   * It always runs, even with the menu closed, because the keyboard↔gamepad swap
   * has to be up to date when the controls screen opens.
   */
  update(input: Input, dt: number): void {
    this.syncGlyphs(input);
    if (!this.open) {
      this.navX = 0;
      this.navY = 0;
      return;
    }

    const pad = input.gamepad;
    if (!pad.connected) return;

    // D-pad and left stick come in through the same path: both are "a direction",
    // and whoever holds either one expects repetition. Treating the d-pad as an
    // isolated tap (`wasPressed`) meant hammering the button to cross a slider
    // from end to end.
    const x = axis(
      pad.isDown(GamepadButton.DPAD_RIGHT) || pad.leftStick.x > NAV_STICK,
      pad.isDown(GamepadButton.DPAD_LEFT) || pad.leftStick.x < -NAV_STICK,
    );
    // The stick returns positive Y downward (see `GamepadManager`), which is the
    // same direction as the d-pad here: pushing down advances through the list.
    const y = axis(
      pad.isDown(GamepadButton.DPAD_DOWN) || pad.leftStick.y > NAV_STICK,
      pad.isDown(GamepadButton.DPAD_UP) || pad.leftStick.y < -NAV_STICK,
    );

    if (x !== this.navX || y !== this.navY) {
      this.navX = x;
      this.navY = y;
      this.navRepeat = NAV_FIRST_REPEAT;
      if (x !== 0 || y !== 0) this.navigate(x, y);
    } else if (x !== 0 || y !== 0) {
      this.navRepeat -= dt;
      if (this.navRepeat <= 0) {
        this.navRepeat = NAV_REPEAT;
        this.navigate(x, y);
      }
    }

    if (pad.wasPressed(GamepadButton.A)) this.confirm();
    if (pad.wasPressed(GamepadButton.B)) this.back();
  }

  /**
   * Opens settings or controls on top of whatever is happening.
   *
   * Mid-match this **is** the pause: `returnTo` stays at `'none'`, so "Back" hands
   * the player back to the deck instead of to the title. A dedicated pause screen
   * would be a fifth screen to repeat two buttons.
   */
  openOverlay(screen: Extract<Screen, 'settings' | 'controls'>): void {
    this.openSub(screen);
  }

  /** `Esc`/`B`: leaves the current screen for the previous one. */
  back(): void {
    if (!RETURNABLE.has(this.screen)) return;

    // Leaving the waiting room **is** giving it up. Without this, whoever presses
    // Back would go on holding a slot in the queue, and the opponent who came in
    // later would find an opponent who had already left.
    if (this.screen === 'room' || this.screen === 'join') this.callbacks.online.onCancel();

    this.callbacks.onNavigate?.('back');
    this.show(this.history.pop() ?? 'title');
  }

  dispose(): void {
    this.root.remove();
  }

  // -- construction ------------------------------------------------------------

  /**
   * The first screen: who you are going to fight, before any other question.
   *
   * The two modes are **cards**, not two buttons in a row, because the choice needs
   * a sentence each. "Online" on a brass button does not say whether it is against
   * the person next to you or against someone far away, whether it needs a friend,
   * or whether there is anyone around to play — and those three doubts are exactly
   * what makes someone not click. The badge above the name settles the one that
   * does not fit in a sentence.
   *
   * Difficulty left this screen on purpose: it only exists against the machine, and
   * asking it before knowing whether the machine is in play is asking too early.
   */
  private buildTitle(): HTMLDivElement {
    const overlay = el('div', 'overlay', this.root);
    const sheet = el('div', 'sheet', overlay);
    buildBrand(sheet, 'A Sloop Duel');

    const section = el('div', 'section', sheet);
    el('h2', 'section__label', section, 'Take to the water');
    const modes = el('div', 'modes', section);

    this.onlineBlurb =
      'One against one, live. Open a room, join a code, or take whoever is waiting.';
    this.onlineCard = this.buildModeCard(modes, {
      badge: 'Online',
      name: 'Duel another captain',
      blurb: this.onlineBlurb,
      primary: true,
      onPick: () => this.push('online'),
    });

    this.buildModeCard(modes, {
      badge: 'Offline',
      name: 'Sail against the crew',
      blurb: 'The ship’s own captain, at three levels of nerve. No connection needed.',
      primary: false,
      onPick: () => this.push('solo'),
    });

    const actions = el('div', 'actions', sheet);
    const controls = el('button', 'button', actions, 'Controls');
    controls.type = 'button';
    controls.addEventListener('click', () => this.openSub('controls'));

    const settingsButton = el('button', 'button', actions, 'Settings');
    settingsButton.type = 'button';
    settingsButton.addEventListener('click', () => this.openSub('settings'));

    // The free camera left this screen for the controls table: it was announced on
    // both screens, and the table is where a list of commands belongs.
    this.buildHintLine(sheet, [
      { action: 'controls', text: 'Controls' },
      { action: 'pause', text: 'Pause mid-duel' },
    ]);

    return overlay;
  }

  /** One of the mode cards on the title screen. */
  private buildModeCard(
    parent: HTMLElement,
    options: {
      badge: string;
      name: string;
      blurb: string;
      primary: boolean;
      onPick: () => void;
    },
  ): HTMLButtonElement {
    const card = el('button', `mode${options.primary ? ' mode--primary' : ''}`, parent);
    card.type = 'button';
    el('span', 'mode__badge', card, options.badge);
    el('span', 'mode__name', card, options.name);
    el('span', 'mode__blurb', card, options.blurb);
    card.addEventListener('click', () => {
      if (card.disabled) return;
      options.onPick();
    });
    return card;
  }

  /** The captain choice, which only makes sense when the opponent is the machine. */
  private buildSolo(): HTMLDivElement {
    const overlay = el('div', 'overlay', this.root);
    const sheet = el('div', 'sheet', overlay);

    const section = el('div', 'section', sheet);
    el('h2', 'section__label', section, 'Choose your opponent');
    const choices = el('div', 'choices', section);
    choices.setAttribute('role', 'radiogroup');

    for (const id of DIFFICULTY_ORDER) {
      const preset = DIFFICULTIES[id];
      const card = el('button', 'choice', choices);
      card.type = 'button';
      card.setAttribute('role', 'radio');
      el('span', 'choice__name', card, preset.label);
      el('span', 'choice__blurb', card, preset.blurb);

      const meterBox = el('div', 'choice__meters', card);
      for (const meter of meters(id)) {
        const row = el('div', 'meter', meterBox);
        el('span', '', row, meter.label);
        const track = el('div', 'meter__track', row);
        const fill = el('div', 'meter__fill', track);
        fill.style.transform = `scaleX(${Math.max(0, Math.min(1, meter.value)).toFixed(3)})`;
      }

      card.addEventListener('click', () => this.selectDifficulty(id));
      this.choiceButtons.set(id, card);
    }

    const actions = el('div', 'actions', sheet);
    const start = el('button', 'button button--primary', actions, 'Set sail');
    start.type = 'button';
    start.addEventListener('click', () => {
      this.callbacks.onNavigate?.('confirm');
      this.show('none');
      this.callbacks.onStartSolo(this.difficulty);
    });

    const back = el('button', 'button', actions, 'Back');
    back.type = 'button';
    back.addEventListener('click', () => this.back());

    this.selectDifficulty(this.difficulty);
    return overlay;
  }

  private buildSettings(): HTMLDivElement {
    const overlay = el('div', 'overlay', this.root);
    const sheet = el('div', 'sheet', overlay);

    const section = el('div', 'section', sheet);
    el('h2', 'section__label', section, 'Settings');
    const grid = el('div', 'settings', section);

    // --- graphics preset ---
    const qualityField = el('div', 'field', grid);
    el('span', '', qualityField, 'Graphics preset');
    const qualityValue = el('span', 'field__value', qualityField);
    const segmented = el('div', 'segmented', qualityField);
    segmented.classList.add('field__control');

    const qualityButtons = new Map<QualityPreset, HTMLButtonElement>();
    const paintQuality = (): void => {
      for (const [preset, button] of qualityButtons) {
        button.setAttribute('aria-pressed', String(settings.preferences.quality === preset));
      }
      const q = settings.quality;
      qualityValue.textContent = `${q.oceanRings} rings · shadows ${q.shadowMapSize || 'off'}`;
    };
    for (const preset of QUALITY_ORDER) {
      const option = el('button', 'segmented__option', segmented, preset);
      option.type = 'button';
      option.addEventListener('click', () => {
        settings.update({ quality: preset });
        paintQuality();
        this.callbacks.onNavigate?.('confirm');
      });
      qualityButtons.set(preset, option);
    }
    paintQuality();

    // --- sliders ---
    // The ranges are not here: they come from `PREFERENCE_RANGES`, the same table
    // `Settings` validates whatever comes out of `localStorage` against. Numbers
    // repeated in two places fall out of sync the first time one of them changes.
    this.buildSlider(grid, 'Master volume', 'masterVolume', (v) => `${Math.round(v * 100)}%`);
    this.buildSlider(grid, 'Mouse sensitivity', 'mouseSensitivity', (v) => `${v.toFixed(2)}×`);
    this.buildSlider(grid, 'Gamepad sensitivity', 'gamepadSensitivity', (v) => `${v.toFixed(2)}×`);
    this.buildSlider(grid, 'Stick deadzone', 'gamepadDeadzone', (v) => `${Math.round(v * 100)}%`);
    this.buildSlider(grid, 'Day length', 'dayLengthMinutes', (v) => `${v.toFixed(0)} min`);
    this.buildSlider(grid, 'Field of view', 'fieldOfView', (v) => `${v.toFixed(0)}°`);

    // --- weather ---
    // Letting the player lock the weather is what makes the weather system
    // playable instead of only watchable: whoever wants to train on a predictable
    // sea locks it on "Clear", whoever wants to see the storm locks it on "Storm"
    // and does not wait for the chain of transitions to get there on its own.
    const weatherField = el('div', 'field', grid);
    el('span', '', weatherField, 'Weather');
    const weatherValue = el('span', 'field__value', weatherField);
    const weatherBox = el('div', 'segmented field__control', weatherField);

    const weatherButtons = new Map<WeatherMode, HTMLButtonElement>();
    const paintWeather = (): void => {
      for (const [mode, button] of weatherButtons) {
        button.setAttribute('aria-pressed', String(settings.preferences.weather === mode));
      }
      weatherValue.textContent =
        settings.preferences.weather === 'dynamic' ? 'turns on its own' : 'held';
    };
    for (const mode of WEATHER_MODES) {
      const option = el('button', 'segmented__option', weatherBox, WEATHER_LABELS[mode]);
      option.type = 'button';
      option.addEventListener('click', () => {
        settings.update({ weather: mode });
        paintWeather();
        this.callbacks.onNavigate?.('confirm');
      });
      weatherButtons.set(mode, option);
    }
    paintWeather();

    // --- toggle ---
    const invertField = el('div', 'field', grid);
    el('span', '', invertField, 'Invert vertical axis');
    const toggle = el('button', 'toggle', invertField);
    toggle.type = 'button';
    el('span', 'toggle__knob', toggle);
    const paintToggle = (): void =>
      toggle.setAttribute('aria-pressed', String(settings.preferences.invertY));
    toggle.addEventListener('click', () => {
      settings.update({ invertY: !settings.preferences.invertY });
      paintToggle();
      this.callbacks.onNavigate?.('confirm');
    });
    paintToggle();

    const actions = el('div', 'actions', sheet);
    const back = el('button', 'button button--primary', actions, 'Back');
    back.type = 'button';
    back.addEventListener('click', () => this.back());

    return overlay;
  }

  private buildSlider(
    parent: HTMLElement,
    label: string,
    preference: RangedPreference,
    format: (value: number) => string,
  ): void {
    const range = PREFERENCE_RANGES[preference];
    const initial = settings.preferences[preference];

    const field = el('div', 'field', parent);
    el('span', '', field, label);
    const value = el('span', 'field__value', field, format(initial));

    const input = el('input', 'field__control', field);
    input.type = 'range';
    input.min = `${range.min}`;
    input.max = `${range.max}`;
    input.step = `${range.step}`;
    input.value = `${initial}`;
    input.setAttribute('aria-label', label);
    // `input`, not `change`: the value has to count while the cursor drags — nobody
    // calibrates sensitivity without seeing the effect. The cost of applying it
    // dozens of times per second is held down on the other side (preset guard in
    // `applyPreferences`, deferred write in `Settings`), not here.
    input.addEventListener('input', () => {
      const parsed = Number.parseFloat(input.value);
      updateNumber(preference, parsed);
      value.textContent = format(parsed);
    });
  }

  private buildControls(): HTMLDivElement {
    const overlay = el('div', 'overlay', this.root);
    const sheet = el('div', 'sheet', overlay);

    const section = el('div', 'section', sheet);
    el('h2', 'section__label', section, 'Controls');
    const grid = el('div', 'controls-grid', section);

    for (const action of LISTED_ACTIONS) {
      const binding = ACTION_LABELS[action];
      const row = el('div', 'controls-row', grid);
      el('span', '', row, binding.name);
      const keys = el('div', 'controls-row__keys', row);
      const keyboard = el('span', 'glyph', keys, binding.keyboard);
      const gamepad = el('span', 'glyph', keys, binding.gamepad);
      this.controlRows.push({ action, keyboard, gamepad });
    }

    this.buildHintLine(sheet, [
      // The mast ladder joined this list the day it stopped being automatic: you
      // grab it and let go of it with the same key, and it is the only piece of the
      // ship where that holds at both ends — on the deck it goes up, on the topsail
      // platform it goes down. Whoever does not know that gets stuck up there.
      { action: 'interact', text: 'Helm, capstan, cannons, mast ladder, pump and holes' },
    ]);

    const actions = el('div', 'actions', sheet);
    const back = el('button', 'button button--primary', actions, 'Back');
    back.type = 'button';
    back.addEventListener('click', () => this.back());

    return overlay;
  }

  private buildOutcome(): {
    overlay: HTMLDivElement;
    box: HTMLDivElement;
    title: HTMLHeadingElement;
    blurb: HTMLParagraphElement;
    tally: HTMLDivElement;
    again: HTMLButtonElement;
  } {
    const overlay = el('div', 'overlay', this.root);
    const box = el('div', 'sheet outcome', overlay);

    const title = el('h2', 'outcome__title', box, '');
    const blurb = el('p', 'outcome__blurb', box, '');
    const tally = el('div', 'tally', box);

    const actions = el('div', 'actions', box);
    const again = el('button', 'button button--primary', actions, 'Sail again');
    again.type = 'button';
    again.addEventListener('click', () => {
      this.callbacks.onNavigate?.('confirm');
      this.show('none');
      this.callbacks.onStartSolo(this.difficulty);
    });

    const toTitle = el('button', 'button', actions, 'Main menu');
    toTitle.type = 'button';
    toTitle.addEventListener('click', () => {
      this.callbacks.onNavigate?.('back');
      this.callbacks.onQuitToTitle();
      this.show('title');
    });

    return { overlay, box, title, blurb, tally, again };
  }

  /**
   * A line of hints in a sheet's footer.
   *
   * Public because `OnlineMenu` has a footer too, and the glyphs have to be
   * registered **here**: what swaps them when the player drops the keyboard and
   * picks up the gamepad is `syncGlyphs`, which sweeps a single list. A second list
   * in the other module would give a screen where the glyphs stop following the
   * device.
   */
  buildHintLine(parent: HTMLElement, hints: readonly Hint[]): void {
    const line = el('div', 'hint-line', parent);
    for (const hint of hints) {
      const item = el('div', 'hint-line__item', line);
      const initial = hint.action ? ACTION_LABELS[hint.action].keyboard : (hint.key ?? '');
      const glyph = el('span', 'glyph glyph--active', item, initial);
      el('span', '', item, hint.text);
      if (hint.action) this.hintGlyphs.push({ action: hint.action, item, glyph });
    }
  }

  // -- state -------------------------------------------------------------------

  private openSub(screen: Extract<Screen, 'settings' | 'controls'>): void {
    this.push(screen);
  }

  /**
   * Advances one screen, remembering where it came from.
   *
   * Public-but-internal because `OnlineMenu` navigates too (the "Join a room" leads
   * to the code screen), and the history has to be the same on both sides — two
   * stacks is how Back starts to lie.
   */
  push(screen: Exclude<Screen, 'none'>): void {
    this.history.push(this.screen);
    this.callbacks.onNavigate?.('confirm');
    this.show(screen);
  }

  /**
   * Troca a tela atual sem empilhar, para quem já está numa e mudou de estado.
   *
   * É o que leva de "entrar em sala" para "esperando na sala" sem que o Voltar
   * passe por um campo de código que já foi preenchido.
   */
  replace(screen: Exclude<Screen, 'none'>): void {
    this.show(screen);
  }

  private selectDifficulty(id: DifficultyId): void {
    this.difficulty = id;
    for (const [key, button] of this.choiceButtons) {
      button.setAttribute('aria-checked', String(key === id));
    }
    this.callbacks.onNavigate?.('move');
  }

  /**
   * Um passo de navegação numa direção.
   *
   * A regra é a de qualquer painel de ajustes de console, e ela existe porque os
   * dois eixos fazem coisas diferentes: **vertical troca de campo, horizontal
   * mexe no campo**. Enquanto ←/→ também trocavam de campo, um deslizante era um
   * item pelo qual se passava — nunca um item que se pudesse ajustar —, e a tela
   * de Ajustes ficava com metade dos controles inalcançáveis no gamepad.
   *
   * Na diagonal, o vertical vence: é o que evita que uma inclinada do analógico
   * mexa num valor quando a intenção era só descer a lista.
   */
  private navigate(x: number, y: number): void {
    const focused = document.activeElement as HTMLElement | null;
    const widget = focused ? this.widgets.get(focused) : undefined;

    if (y !== 0) {
      const vertical = y > 0 ? 1 : -1;
      if (widget?.step?.(vertical)) return;
      this.moveFocus(vertical);
      return;
    }

    const direction = x > 0 ? 1 : -1;

    if (focused instanceof HTMLInputElement && focused.type === 'range') {
      this.nudgeSlider(focused, direction);
      return;
    }
    // Grupo de opções (preset, tempo) e interruptor: ←/→ mudam a escolha. Na
    // ponta do grupo a chamada devolve `false` e o passo escapa para o campo
    // vizinho, que é a saída horizontal de quem entrou no grupo.
    if (focused && this.cycleOption(focused, direction)) return;

    this.moveFocus(direction);
  }

  /**
   * `A` no item focado.
   *
   * O deslizante fica de fora porque `HTMLInputElement.click()` num
   * `type="range"` não move o cursor um milímetro — era o que o `A` fazia, e o
   * resultado era o som de confirmação tocando sobre um valor que não mudou.
   * Quem move deslizante é `nudgeSlider`.
   */
  private confirm(): void {
    const focused = document.activeElement as HTMLElement | null;
    if (!focused) return;
    // Nenhum `<input>` faz nada útil com um clique programático: no deslizante o
    // cursor não anda um milímetro, e no campo de texto não há teclado de console
    // para abrir. Quem move deslizante é `nudgeSlider`; quem escreve com o
    // controle são os slots de código, que são botões de verdade.
    if (focused instanceof HTMLInputElement) return;

    this.callbacks.onNavigate?.('confirm');
    focused.click();
  }

  /**
   * Move um deslizante um passo, como se o jogador tivesse arrastado o cursor.
   *
   * Escrever `value` não notifica ninguém — o DOM só emite `input` quando quem
   * mexe é o usuário. Daí o `dispatchEvent`: o valor entra pelo **mesmo** ouvinte
   * que o mouse e o teclado usam, e não por um segundo caminho de escrita que
   * teria de ser mantido em dia com o primeiro.
   */
  private nudgeSlider(slider: HTMLInputElement, direction: 1 | -1): void {
    const min = Number.parseFloat(slider.min);
    const max = Number.parseFloat(slider.max);
    const step = Number.parseFloat(slider.step) || 1;
    const current = Number.parseFloat(slider.value);
    if (!Number.isFinite(current)) return;

    // Reancorar o passo na grade do `min` mantém o valor redondo: somar 0,05 seis
    // vezes em ponto flutuante produz 0,30000000000000004, e é isso que apareceria
    // no rótulo e iria parar no `localStorage`.
    const target = clamp(current + step * direction, min, max);
    const next = Number((min + Math.round((target - min) / step) * step).toFixed(6));
    if (next === current) return;

    slider.value = `${next}`;
    slider.dispatchEvent(new Event('input', { bubbles: true }));
    this.callbacks.onNavigate?.('move');
  }

  /**
   * `←`/`→` num grupo de opções ou num interruptor.
   *
   * @returns `false` quando o item focado não é um desses, ou quando o grupo
   * acabou — nos dois casos quem assume é `moveFocus`.
   */
  private cycleOption(focused: HTMLElement, direction: 1 | -1): boolean {
    // Campos de telas de fora primeiro: eles são os mais específicos, e um slot de
    // código de sala não deve ter de evitar as classes que este arquivo conhece.
    const widget = this.widgets.get(focused);
    if (widget) return widget.cycle(direction);

    if (focused.classList.contains('toggle')) {
      // Duas posições, e cada lado tem um sentido: → liga, ← desliga. Como o
      // clique alterna, só clica quando o estado pedido é diferente do atual —
      // senão apertar → duas vezes desligaria o que a primeira ligou.
      const wanted = direction > 0;
      if ((focused.getAttribute('aria-pressed') === 'true') !== wanted) {
        focused.click();
      }
      return true;
    }

    const group = focused.closest('.segmented');
    if (!group) return false;

    const options = [...group.querySelectorAll<HTMLButtonElement>('.segmented__option')];
    const index = options.indexOf(focused as HTMLButtonElement);
    const next = index < 0 ? undefined : options[index + direction];
    if (!next) return false;

    next.focus();
    next.click();
    return true;
  }

  /** Move o foco entre os botões da tela ativa, para o d-pad funcionar. */
  private moveFocus(direction: 1 | -1): void {
    const overlay = this.screen === 'none' ? null : this.screens.get(this.screen);
    if (!overlay) return;

    const focusable = [...overlay.querySelectorAll<HTMLElement>(FOCUSABLE)].filter(
      (node) => node.offsetParent !== null,
    );
    if (focusable.length === 0) return;

    const index = focusable.indexOf(document.activeElement as HTMLElement);
    // Sem foco na tela, entra pelo primeiro (ou pelo último, se veio de trás).
    const next =
      index < 0
        ? direction > 0 ? 0 : focusable.length - 1
        : (index + direction + focusable.length) % focusable.length;

    focusable[next]?.focus();
    this.callbacks.onNavigate?.('move');
  }

  /**
   * Acende o glifo do aparelho em uso e desbota o outro.
   *
   * Na tabela de controles desbota em vez de esconder: quem joga de teclado e olha
   * a tela ainda quer saber qual é o botão do controle. Some seria perder
   * informação para ganhar nada.
   *
   * As linhas de dica são o caso oposto e por isso trocam de texto em vez de cor:
   * ali cabe **um** glifo, e o que ele tem de dizer é o aperto que funciona agora.
   */
  private syncGlyphs(input: Input): void {
    // A chave carrega o layout junto com o aparelho: trocar um Xbox por um
    // DualSense sem soltar o controle muda todos os rótulos de botão sem mudar o
    // aparelho ativo, e um teste só em `usingGamepad` não veria nada acontecer.
    const key = `${input.usingGamepad ? 'pad' : 'kbm'}:${input.gamepad.layout}`;
    if (key === this.lastGlyphKey) return;
    this.lastGlyphKey = key;

    const usingPad = input.usingGamepad;

    for (const row of this.controlRows) {
      row.gamepad.textContent = input.padLabel(row.action);
      row.keyboard.classList.toggle('glyph--active', !usingPad);
      row.gamepad.classList.toggle('glyph--active', usingPad);
    }

    for (const hint of this.hintGlyphs) {
      const label = usingPad ? input.padLabel(hint.action) : ACTION_LABELS[hint.action].keyboard;
      hint.glyph.textContent = label;
      // Ação sem botão no aparelho em uso não vira um travessão solto no rodapé:
      // a dica inteira sai de cena até o jogador voltar ao outro aparelho.
      hint.item.hidden = label === NO_BINDING;
    }
  }
}
