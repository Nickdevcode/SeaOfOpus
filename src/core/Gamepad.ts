/**
 * A layer over the browser's Gamepad API.
 *
 * It follows the "standard" (Xbox) layout, which is what the Gamepad API normalizes. The
 * mapping reproduces Sea of Thieves' default scheme: X interacts, RT fires, LT aims, Y
 * loads the cannon, B leaves the current mode.
 *
 * The Gamepad API emits no button events — the state has to be polled every frame. That
 * is why `poll()` runs once per frame at the start of the loop.
 *
 * What `pad.id` still decides is the buttons' **names**: same index, different engraving
 * on a Sony controller. See `GamepadLayout`.
 */

import { applyDeadzone, clamp01 } from './MathUtils';
import { settings } from './Settings';

/** Button indices of the Gamepad API's "standard" layout. */
export const GamepadButton = {
  A: 0,
  B: 1,
  X: 2,
  Y: 3,
  LB: 4,
  RB: 5,
  LT: 6,
  RT: 7,
  VIEW: 8,
  MENU: 9,
  L3: 10,
  R3: 11,
  DPAD_UP: 12,
  DPAD_DOWN: 13,
  DPAD_LEFT: 14,
  DPAD_RIGHT: 15,
} as const;

const BUTTON_COUNT = 16;
/** Analog triggers count as pressed from this value on. */
const TRIGGER_THRESHOLD = 0.35;

/**
 * The controller's label family.
 *
 * Only the **names** change: the Gamepad API normalizes the indices to the "standard"
 * layout, so button 0 is still the bottom one on any controller. What changes is what is
 * printed on it — `A` on an Xbox, `✕` on a DualSense —, and that is why this lives here
 * and not in a second binding table.
 */
export type GamepadLayout = 'xbox' | 'playstation';

/**
 * The `pad.id` that gives a Sony controller away.
 *
 * `054c` is Sony's vendor identifier and it is the most reliable pattern: Chrome builds
 * ids like `"Wireless Controller (STANDARD GAMEPAD Vendor: 054c Product: 09cc)"` — in
 * which neither "DualShock" nor "PlayStation" appears — and Firefox uses
 * `"054c-09cc-Wireless Controller"`. The spelled-out names stay as a safety net for
 * browsers that only expose the commercial label.
 */
const PLAYSTATION_ID = /(dualshock|dualsense|playstation|054c)/;

/** Works out the label family from the `id` the browser reports. */
function detectLayout(id: string): GamepadLayout {
  return PLAYSTATION_ID.test(id.toLowerCase()) ? 'playstation' : 'xbox';
}

export class GamepadManager {
  connected = false;
  /** Name of the connected controller, shown in the telemetry overlay (F3). */
  deviceName = '';
  /** Label family of the controller in use. See `GamepadLayout`. */
  layout: GamepadLayout = 'xbox';

  /** Left stick with the deadzone already applied. X: right+, Y: down+. */
  readonly leftStick = { x: 0, y: 0 };
  /** Right stick, used to look around. */
  readonly rightStick = { x: 0, y: 0 };
  /** Analog triggers, 0..1. */
  leftTrigger = 0;
  rightTrigger = 0;

  private buttons = new Uint8Array(BUTTON_COUNT);
  private previousButtons = new Uint8Array(BUTTON_COUNT);
  private index: number | null = null;

  constructor() {
    window.addEventListener('gamepadconnected', (event) => {
      const pad = (event as GamepadEvent).gamepad;
      if (pad.mapping === 'standard' || this.index === null) {
        this.index = pad.index;
        this.deviceName = pad.id;
        this.layout = detectLayout(pad.id);
        this.connected = true;
      }
    });

    window.addEventListener('gamepaddisconnected', (event) => {
      if ((event as GamepadEvent).gamepad.index === this.index) {
        this.reset();
      }
    });
  }

  /** Reads the controller's state. It has to run once per frame, before the logic. */
  poll(): void {
    this.previousButtons.set(this.buttons);

    const pad = this.findGamepad();
    if (!pad) {
      if (this.connected) this.reset();
      return;
    }

    this.connected = true;
    if (pad.id !== this.deviceName) {
      this.deviceName = pad.id;
      this.layout = detectLayout(pad.id);
    }

    const deadzone = settings.preferences.gamepadDeadzone;
    const [lx, ly] = applyDeadzone(pad.axes[0] ?? 0, pad.axes[1] ?? 0, deadzone);
    const [rx, ry] = applyDeadzone(pad.axes[2] ?? 0, pad.axes[3] ?? 0, deadzone);

    this.leftStick.x = lx;
    this.leftStick.y = ly;
    this.rightStick.x = rx;
    this.rightStick.y = ry;

    this.leftTrigger = clamp01(pad.buttons[GamepadButton.LT]?.value ?? 0);
    this.rightTrigger = clamp01(pad.buttons[GamepadButton.RT]?.value ?? 0);

    for (let i = 0; i < BUTTON_COUNT; i++) {
      const button = pad.buttons[i];
      if (!button) {
        this.buttons[i] = 0;
        continue;
      }
      // Triggers are analog: they only count as "pressed" above the threshold.
      const isTrigger = i === GamepadButton.LT || i === GamepadButton.RT;
      const pressed = isTrigger ? button.value > TRIGGER_THRESHOLD : button.pressed;
      this.buttons[i] = pressed ? 1 : 0;
    }
  }

  isDown(button: number): boolean {
    return this.buttons[button] === 1;
  }

  /** True only on the frame the button was pressed. */
  wasPressed(button: number): boolean {
    return this.buttons[button] === 1 && this.previousButtons[button] === 0;
  }

  private findGamepad(): Gamepad | null {
    const pads = navigator.getGamepads?.() ?? [];
    if (this.index !== null) {
      const pad = pads[this.index];
      if (pad?.connected) return pad;
    }
    // The index can change after a reconnection: take the first available one.
    for (const pad of pads) {
      if (pad?.connected) {
        this.index = pad.index;
        return pad;
      }
    }
    return null;
  }

  private reset(): void {
    this.connected = false;
    this.deviceName = '';
    this.layout = 'xbox';
    this.index = null;
    this.buttons.fill(0);
    this.previousButtons.fill(0);
    this.leftStick.x = 0;
    this.leftStick.y = 0;
    this.rightStick.x = 0;
    this.rightStick.y = 0;
    this.leftTrigger = 0;
    this.rightTrigger = 0;
  }
}
