/**
 * Unified input: keyboard, mouse and gamepad all speak the same language of
 * "actions".
 *
 * The rest of the game never asks "is the F key down?" — it asks "was the
 * INTERACT action triggered?". The gain is that keyboard and controller come in
 * through the same funnel and the UI has a single table of labels to look up
 * (`ACTION_LABELS`): changing a binding here rewrites the prompt on deck and the
 * line on the controls screen without touching either one.
 *
 * The bindings are fixed. There is no player remapping — if there ever is, the
 * place is `KEY_BINDINGS`/`PAD_BINDINGS`, and nothing outside here needs to know.
 *
 * Bindings faithful to Sea of Thieves: F interacts, R loads the cannon, LMB
 * fires, RMB aims. On the controller: X interacts, Y loads, RT fires, LT aims.
 */

import { GamepadButton, GamepadManager, type GamepadLayout } from './Gamepad';
import { clamp } from './MathUtils';
import { settings } from './Settings';

export type Action =
  | 'moveForward'
  | 'moveBack'
  | 'moveLeft'
  | 'moveRight'
  | 'sprint'
  | 'jump'
  | 'interact'
  | 'exit'
  | 'reload'
  | 'fire'
  | 'aim'
  | 'freeCamera'
  | 'controls'
  | 'debug'
  | 'pause';

/** Key (`KeyboardEvent.code`) → action. */
const KEY_BINDINGS: Record<string, Action> = {
  KeyW: 'moveForward',
  KeyS: 'moveBack',
  KeyA: 'moveLeft',
  KeyD: 'moveRight',
  ArrowUp: 'moveForward',
  ArrowDown: 'moveBack',
  ArrowLeft: 'moveLeft',
  ArrowRight: 'moveRight',
  ShiftLeft: 'sprint',
  ShiftRight: 'sprint',
  Space: 'jump',
  KeyF: 'interact',
  KeyX: 'exit',
  KeyR: 'reload',
  KeyC: 'freeCamera',
  Tab: 'controls',
  F3: 'debug',
  Escape: 'pause',
};

/** Gamepad button → action. */
const PAD_BINDINGS: Array<[number, Action]> = [
  [GamepadButton.A, 'jump'],
  [GamepadButton.B, 'exit'],
  [GamepadButton.X, 'interact'],
  [GamepadButton.Y, 'reload'],
  [GamepadButton.RT, 'fire'],
  [GamepadButton.LT, 'aim'],
  [GamepadButton.L3, 'sprint'],
  [GamepadButton.VIEW, 'controls'],
  [GamepadButton.MENU, 'pause'],
];

/**
 * The label for an action with no button on the device being asked about.
 *
 * It's a value, not a loose string, because the UI **decides** based on it: the
 * controls table shows the em dash grayed out, but a footer hint line hides
 * itself entirely instead of announcing a press that doesn't exist (see
 * `Menu.syncGlyphs`).
 */
export const NO_BINDING = '—';

/**
 * Readable labels for the controls screen.
 *
 * In English, and with no accent: "Take the helm", not "Belay there, matey". The
 * UI is where the game **instructs**, and instruction with an accent costs a
 * fraction of a second of decoding every time it's read. The theme lives in the
 * wood, the brass and the sea; the text stays clear.
 *
 * The `gamepad` field always holds the standard layout's name (Xbox). Whatever
 * puts it on screen must go through `Input.padLabel`, which translates it to the
 * layout of the controller actually plugged in.
 */
export const ACTION_LABELS: Record<Action, { name: string; keyboard: string; gamepad: string }> = {
  moveForward: { name: 'Move forward', keyboard: 'W', gamepad: 'Left stick' },
  moveBack: { name: 'Move back', keyboard: 'S', gamepad: 'Left stick' },
  moveLeft: { name: 'Move left', keyboard: 'A', gamepad: 'Left stick' },
  moveRight: { name: 'Move right', keyboard: 'D', gamepad: 'Left stick' },
  sprint: { name: 'Sprint', keyboard: 'Shift', gamepad: 'L3' },
  jump: { name: 'Jump', keyboard: 'Space', gamepad: 'A' },
  interact: { name: 'Interact', keyboard: 'F', gamepad: 'X' },
  exit: { name: 'Leave station', keyboard: 'X', gamepad: 'B' },
  reload: { name: 'Load cannon', keyboard: 'R', gamepad: 'Y' },
  fire: { name: 'Fire', keyboard: 'LMB', gamepad: 'RT' },
  aim: { name: 'Focus aim', keyboard: 'RMB', gamepad: 'LT' },
  freeCamera: { name: 'Free camera', keyboard: 'C', gamepad: NO_BINDING },
  controls: { name: 'Controls', keyboard: 'Tab', gamepad: 'View' },
  debug: { name: 'Physics telemetry', keyboard: 'F3', gamepad: NO_BINDING },
  pause: { name: 'Pause', keyboard: 'Esc', gamepad: 'Menu' },
};

/**
 * What each button is called on a Sony controller.
 *
 * The table is of **labels**, not bindings: the button index doesn't change (the
 * Gamepad API normalizes everything to the "standard" layout), what changes is
 * what's printed on it. Showing `A` to someone holding a DualSense is the same
 * class of error as showing `F` to someone on a controller — the UI is describing
 * a device that isn't the one the player is holding.
 *
 * The key is the Xbox label from `ACTION_LABELS`, not the action: that way a new
 * action reusing an already-translated button needs no line here.
 */
const PLAYSTATION_GLYPHS: Readonly<Record<string, string>> = {
  A: '✕',
  B: '○',
  X: '□',
  Y: '△',
  LB: 'L1',
  RB: 'R1',
  LT: 'L2',
  RT: 'R2',
  View: 'Create',
  Menu: 'Options',
};

/** Translates a button label from the default layout (Xbox) into the one in use. */
function padGlyph(xboxLabel: string, layout: GamepadLayout): string {
  if (layout !== 'playstation') return xboxLabel;
  return PLAYSTATION_GLYPHS[xboxLabel] ?? xboxLabel;
}

/** Radians of rotation per mouse pixel, before the player's sensitivity. */
const MOUSE_RADIANS_PER_PIXEL = 0.0022;
/** Radians per second with the right stick at full deflection. */
const PAD_RADIANS_PER_SECOND = 3.2;

/** Which device the player is using **right now**. */
export type InputDevice = 'keyboard' | 'gamepad';

/**
 * Mouse movement, in pixels within one frame, that counts as "back on the mouse".
 *
 * It is not zero on purpose. A still optical mouse still emits one-pixel events from
 * the desk shaking, and with a threshold of zero the label would flicker between key
 * and button while the player plays on a pad with their hand near the mouse.
 */
const MOUSE_WAKE_PIXELS = 6;

/**
 * Fraction of the stick's range that counts as intent to use the pad.
 *
 * Well above the dead zone on purpose: see the note in `beginFrame`.
 */
const STICK_INTENT = 0.5;

/** Grace frames after locking the pointer. See `onMouseMove`. */
const LOCK_SETTLE_FRAMES = 2;

/**
 * The only pad actions that get through frozen input.
 *
 * It is the same exception the keyboard makes for `Esc` in `onKeyDown`, and it
 * exists for the same reason: the button that opens a screen has to be able to close
 * it. Without this, Menu and View went mute precisely with the menu up — whoever
 * came in on a pad had no way out without touching the keyboard.
 *
 * The rest stays blocked, and that is not excessive caution: `A` confirms a menu
 * button, and if it got through, that same press would become a jump aboard on the
 * frame the screen closes.
 */
const CAPTURED_PAD_ACTIONS: ReadonlySet<Action> = new Set<Action>(['pause', 'controls']);

export class Input {
  readonly gamepad = new GamepadManager();

  /** Look delta accumulated since the last frame, already in radians. */
  readonly look = { x: 0, y: 0 };

  /** True when the pointer is locked to the canvas (game mode). */
  pointerLocked = false;

  /**
   * The device the player has just used. **The whole UI reads from here** to decide
   * whether to show `F` or `X`, `Shift` or `L3`.
   *
   * It is "last used", and not "is connected", and the difference is the one the
   * player notices: with a pad plugged in on the desk and hands on the keyboard,
   * looking at the connection would show buttons they are not touching. Here, the
   * labels swap the instant they touch the stick, and come back when they go back to
   * WASD.
   */
  activeDevice: InputDevice = 'keyboard';

  private held = new Set<Action>();
  private pressedThisFrame = new Set<Action>();

  private mouseDelta = { x: 0, y: 0 };
  private wheelDelta = 0;
  /** Grace frames left after locking the pointer. */
  private lockSettleFrames = 0;

  /** When true, game input is ignored (menu open). */
  private captured = false;

  private canvas: HTMLElement | null = null;

  attach(canvas: HTMLElement): void {
    this.canvas = canvas;

    window.addEventListener('keydown', this.onKeyDown);
    window.addEventListener('keyup', this.onKeyUp);
    window.addEventListener('mousedown', this.onMouseDown);
    window.addEventListener('mouseup', this.onMouseUp);
    window.addEventListener('mousemove', this.onMouseMove);
    window.addEventListener('wheel', this.onWheel, { passive: true });
    window.addEventListener('blur', this.onBlur);
    document.addEventListener('pointerlockchange', this.onPointerLockChange);
    // Without this the context menu steals the right button (focused aim).
    canvas.addEventListener('contextmenu', (event) => event.preventDefault());
  }

  /**
   * Requests the pointer lock.
   *
   * `unadjustedMovement` is what separates a game's aim from a spreadsheet's aim.
   * Without it the browser delivers the delta **already processed by the operating
   * system**: on Windows that includes pointer acceleration, which multiplies fast
   * movements and leaves slow ones alone. The effect is a camera that responds
   * differently to the same gesture depending on the speed of the hand — the player
   * feels "weight" and "slip" that are nowhere in the code, and no sensitivity
   * setting fixes it because the problem is not scale, it is the curve. Asking for
   * unadjusted movement gets the sensor's raw delta.
   *
   * The promise is rejected in browsers that do not support the option; in that case
   * the plain call is the only way out, and the system's acceleration applies again.
   */
  requestPointerLock(): void {
    const canvas = this.canvas;
    if (!canvas?.requestPointerLock) return;
    // Already locked: asking again is not an error, but it spends a promise and a
    // `pointerlockchange` event that restarts the `lockSettleFrames` grace period —
    // and then the first movement after every click disappears.
    if (document.pointerLockElement === canvas) return;

    // Both calls can be refused, and refusal is normal: the browser imposes a grace
    // period of a little over a second after the player leaves the lock with `Esc`.
    // A promise rejected without a `catch` becomes a red error in the console on
    // every click inside that window, which sends you looking for a defect where
    // there is none — what gives the pointer back is the next click.
    const request = canvas.requestPointerLock({ unadjustedMovement: true }) as
      | Promise<void>
      | undefined;
    request?.catch(() => {
      const fallback = canvas.requestPointerLock() as Promise<void> | undefined;
      fallback?.catch(() => {});
    });
  }

  exitPointerLock(): void {
    if (document.pointerLockElement) document.exitPointerLock();
  }

  /**
   * Freezes game input (used while the menu is open), without tearing the listeners
   * down.
   */
  setCaptured(captured: boolean): void {
    this.captured = captured;
    if (captured) {
      this.held.clear();
      this.look.x = 0;
      this.look.y = 0;
    }
  }

  /** Runs at the start of every frame, before any system reads the input. */
  beginFrame(dt: number): void {
    this.gamepad.poll();
    if (this.lockSettleFrames > 0) this.lockSettleFrames--;

    const prefs = settings.preferences;
    const pad = this.gamepad;

    if (this.captured) {
      this.mouseDelta.x = 0;
      this.mouseDelta.y = 0;
      this.look.x = 0;
      this.look.y = 0;
    } else {
      // Mouse: the raw delta in pixels becomes radians.
      let lookX = this.mouseDelta.x * MOUSE_RADIANS_PER_PIXEL * prefs.mouseSensitivity;
      let lookY = this.mouseDelta.y * MOUSE_RADIANS_PER_PIXEL * prefs.mouseSensitivity;
      this.mouseDelta.x = 0;
      this.mouseDelta.y = 0;

      // Gamepad: angular velocity integrated over time (the stick is a position,
      // not a delta), with dt capped so a hitch does not give an absurd spin.
      if (pad.connected) {
        const step = Math.min(dt, 0.1) * PAD_RADIANS_PER_SECOND * prefs.gamepadSensitivity;
        lookX += pad.rightStick.x * step;
        lookY += pad.rightStick.y * step;
      }

      this.look.x = lookX;
      this.look.y = prefs.invertY ? -lookY : lookY;
    }

    if (!pad.connected) return;

    // Gamepad buttons generate the same "pressed" edges as the keyboard.
    //
    // The loop runs **with the menu open too**, and the two reasons are
    // independent. One: `pause` and `controls` need to reach the main loop (see
    // `CAPTURED_PAD_ACTIONS`). Two: it is here, and in the stick test just below,
    // that we find out the player put down the keyboard and picked up the pad —
    // cutting the loop with the menu up was what made the Controls screen announce
    // `Tab`, `F` and `Esc` to somebody with both hands on the gamepad, which is
    // exactly the screen where the wrong label costs the most.
    let padActive = false;
    for (const [button, action] of PAD_BINDINGS) {
      const pressed = pad.wasPressed(button);
      const down = pad.isDown(button);
      if (pressed || down) padActive = true;

      // Frozen, only the menu actions become state. The game ones do not even enter
      // `held`: the menu clears the set on opening, and refilling it here would give
      // the player's control back behind the overlay.
      if (this.captured && !CAPTURED_PAD_ACTIONS.has(action)) continue;

      if (pressed) this.pressedThisFrame.add(action);
      if (down) this.held.add(action);
      else if (!this.isKeyboardSource(action)) this.held.delete(action);
    }

    // The stick only counts as use above a threshold **well** above the dead zone.
    //
    // The default dead zone is 18% of the range, and it is calibrated so the game
    // does not move on its own. It does not work as proof of intent: a worn stick
    // crosses it now and then sitting still on the desk, and with the test at
    // "different from zero" one of those twitches was enough for the whole UI to
    // switch to pad buttons and stay there — the keyboard player saw `X` and `L3` in
    // the HUD without having touched the pad. Half the range is a gesture, not
    // noise.
    const moved =
      Math.hypot(pad.leftStick.x, pad.leftStick.y) > STICK_INTENT ||
      Math.hypot(pad.rightStick.x, pad.rightStick.y) > STICK_INTENT;
    if (moved || padActive) this.setDevice('gamepad');
  }

  /** Switches the device in use. The UI reads `activeDevice` on its own. */
  private setDevice(device: InputDevice): void {
    this.activeDevice = device;
  }

  /** Read shortcut for the UI. */
  get usingGamepad(): boolean {
    return this.activeDevice === 'gamepad';
  }

  /**
   * The pad button's label for an action, already in the connected device's layout.
   *
   * The UI should call this instead of reading `ACTION_LABELS[...].gamepad`
   * directly: the table stores the default layout's name (Xbox), and this is where
   * it becomes `✕`/`○`/`□`/`△` when what is in hand is a DualSense.
   */
  padLabel(action: Action): string {
    return padGlyph(ACTION_LABELS[action].gamepad, this.gamepad.layout);
  }

  /** Runs at the end of the frame: clears the edges. */
  endFrame(): void {
    this.pressedThisFrame.clear();
    this.wheelDelta = 0;
  }

  isDown(action: Action): boolean {
    return this.held.has(action);
  }

  /** True only on the frame the action was triggered. */
  wasPressed(action: Action): boolean {
    return this.pressedThisFrame.has(action);
  }

  /** Combined movement axis: X is lateral (right+), Y is forward (forward+). */
  getMoveAxis(): { x: number; y: number } {
    let x = 0;
    let y = 0;

    if (this.held.has('moveRight')) x += 1;
    if (this.held.has('moveLeft')) x -= 1;
    if (this.held.has('moveForward')) y += 1;
    if (this.held.has('moveBack')) y -= 1;

    // Normalizes the keyboard's diagonal so you do not walk faster diagonally.
    const length = Math.hypot(x, y);
    if (length > 1) {
      x /= length;
      y /= length;
    }

    // The stick disappears along with the rest of game input while the menu is
    // open. Without this test, the same push that moves down a list item flew the
    // free camera across the scene behind the overlay — the keyboard was already
    // covered because `setCaptured` empties `held`, the pad is read directly and was
    // not.
    const pad = this.gamepad;
    if (pad.connected && !this.captured) {
      x = clamp(x + pad.leftStick.x, -1, 1);
      y = clamp(y - pad.leftStick.y, -1, 1);
    }

    return { x, y };
  }

  /** Mouse scroll since the last frame, in normalized "clicks". */
  getWheelDelta(): number {
    return this.wheelDelta;
  }

  private isKeyboardSource(action: Action): boolean {
    // Actions that also have a keyboard/mouse binding cannot be erased by the
    // gamepad when the button is released.
    return this.keyboardHeld.has(action);
  }

  private keyboardHeld = new Set<Action>();

  private onKeyDown = (event: KeyboardEvent): void => {
    const action = KEY_BINDINGS[event.code];
    if (!action) return;

    // Tab moves the focus and Space scrolls the page: neither is welcome **in
    // game**. With the menu open it is the opposite — Tab *is* the navigation and
    // Space activates the focused `<button>`, and swallowing both before looking at
    // `captured` left the whole overlay unusable on the keyboard: no tabbing between
    // the buttons, no pressing the focused one. That is why the suppression is
    // conditional, and not unconditional as it used to be.
    //
    // The test comes before `event.repeat` on purpose: holding Space on deck repeats
    // the keydown, and every repeat has to be suppressed or the page scrolls.
    if (!this.captured && (event.code === 'Tab' || event.code === 'Space' || event.code === 'F3')) {
      event.preventDefault();
    }
    if (event.repeat) return;

    this.setDevice('keyboard');
    this.keyboardHeld.add(action);
    if (this.captured && action !== 'pause') return;

    this.held.add(action);
    this.pressedThisFrame.add(action);
  };

  private onKeyUp = (event: KeyboardEvent): void => {
    const action = KEY_BINDINGS[event.code];
    if (!action) return;

    this.keyboardHeld.delete(action);
    this.held.delete(action);
  };

  private onMouseDown = (event: MouseEvent): void => {
    // Clicking is an unambiguous mouse gesture, and that is why device detection
    // comes **before** the freeze: it is how the labels come back to the keyboard
    // after a stint on the pad, since simply moving the cursor no longer changes
    // anything with the menu open (see `onMouseMove`). What the menu freezes is the
    // action — firing and aiming — not the reading of who is playing.
    this.setDevice('keyboard');
    if (this.captured) return;

    const action: Action | null = event.button === 0 ? 'fire' : event.button === 2 ? 'aim' : null;
    if (!action) return;

    event.preventDefault();
    this.keyboardHeld.add(action);
    this.held.add(action);
    this.pressedThisFrame.add(action);
  };

  private onMouseUp = (event: MouseEvent): void => {
    const action: Action | null = event.button === 0 ? 'fire' : event.button === 2 ? 'aim' : null;
    if (!action) return;

    this.keyboardHeld.delete(action);
    this.held.delete(action);
  };

  private onMouseMove = (event: MouseEvent): void => {
    // Moving the mouse only wakes the keyboard **in game**.
    //
    // With the menu open the cursor is free, and reaching a button takes moving it —
    // including for somebody on a pad who bumps the mouse beside the keyboard. While
    // that switched the device, the Controls screen went back to `Tab` and `F` the
    // instant you went to read it on a pad, which was exactly the opposite of what
    // it exists to do. With the menu open, what switches to keyboard is the key or
    // the click — gestures nobody makes by accident.
    if (
      !this.captured &&
      Math.abs(event.movementX) + Math.abs(event.movementY) >= MOUSE_WAKE_PIXELS
    ) {
      this.setDevice('keyboard');
    }
    if (!this.pointerLocked || this.captured) return;

    // Discards the spike from the first event after locking the pointer.
    //
    // On entering pointer lock the browser delivers, in the first `mousemove`, the
    // displacement accumulated since the cursor's last known position — which can be
    // the whole screen. The symptom is the camera making a violent, random spin the
    // instant you click to play, and behaving normally afterwards. Two grace frames
    // cost nothing and kill the jump.
    if (this.lockSettleFrames > 0) return;

    this.mouseDelta.x += event.movementX;
    this.mouseDelta.y += event.movementY;
  };

  private onWheel = (event: WheelEvent): void => {
    if (this.captured) return;
    this.wheelDelta += Math.sign(event.deltaY);
  };

  /** Losing window focus has to release everything, or the key "sticks". */
  private onBlur = (): void => {
    this.held.clear();
    this.keyboardHeld.clear();
    this.mouseDelta.x = 0;
    this.mouseDelta.y = 0;
  };

  private onPointerLockChange = (): void => {
    this.pointerLocked = document.pointerLockElement === this.canvas;
    if (this.pointerLocked) this.lockSettleFrames = LOCK_SETTLE_FRAMES;
    else this.onBlur();
  };
}
