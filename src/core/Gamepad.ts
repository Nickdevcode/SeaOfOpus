/**
 * Camada sobre a Gamepad API do navegador.
 *
 * Segue o layout "standard" (Xbox), que é o que a Gamepad API normaliza. O
 * mapeamento reproduz o esquema padrão do Sea of Thieves: X interage, RT
 * dispara, LT mira, Y carrega o canhão, B sai do modo atual.
 *
 * A Gamepad API não emite eventos de botão — é preciso pesquisar o estado a
 * cada frame. Por isso `poll()` roda uma vez por frame no início do loop.
 *
 * O que o `pad.id` ainda decide é o **nome** dos botões: mesmo índice, gravação
 * diferente num controle da Sony. Ver `GamepadLayout`.
 */

import { applyDeadzone, clamp01 } from './MathUtils';
import { settings } from './Settings';

/** Índices de botão do layout "standard" da Gamepad API. */
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
/** Gatilhos analógicos contam como pressionados a partir deste valor. */
const TRIGGER_THRESHOLD = 0.35;

/**
 * Família de rótulos do controle.
 *
 * Só os **nomes** mudam: a Gamepad API normaliza os índices para o layout
 * "standard", então o botão 0 continua sendo o de baixo em qualquer controle. O
 * que muda é o que está impresso nele — `A` num Xbox, `✕` num DualSense —, e é
 * por isso que isto vive aqui e não numa segunda tabela de bindings.
 */
export type GamepadLayout = 'xbox' | 'playstation';

/**
 * `pad.id` que denuncia um controle da Sony.
 *
 * O `054c` é o identificador de fabricante da Sony e é o padrão mais confiável:
 * o Chrome monta ids como `"Wireless Controller (STANDARD GAMEPAD Vendor: 054c
 * Product: 09cc)"` — em que nem "DualShock" nem "PlayStation" aparecem — e o
 * Firefox usa `"054c-09cc-Wireless Controller"`. Os nomes por extenso ficam como
 * rede de segurança para navegadores que só expõem o rótulo comercial.
 */
const PLAYSTATION_ID = /(dualshock|dualsense|playstation|054c)/;

/** Descobre a família de rótulos a partir do `id` que o navegador reporta. */
function detectLayout(id: string): GamepadLayout {
  return PLAYSTATION_ID.test(id.toLowerCase()) ? 'playstation' : 'xbox';
}

export class GamepadManager {
  connected = false;
  /** Nome do controle conectado, mostrado no overlay de telemetria (F3). */
  deviceName = '';
  /** Família de rótulos do controle em uso. Ver `GamepadLayout`. */
  layout: GamepadLayout = 'xbox';

  /** Analógico esquerdo já com zona morta aplicada. X: direita+, Y: baixo+. */
  readonly leftStick = { x: 0, y: 0 };
  /** Analógico direito, usado para olhar. */
  readonly rightStick = { x: 0, y: 0 };
  /** Gatilhos analógicos, 0..1. */
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

  /** Lê o estado do controle. Deve rodar uma vez por frame, antes da lógica. */
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
      // Gatilhos são analógicos: só contam como "pressionados" acima do limiar.
      const isTrigger = i === GamepadButton.LT || i === GamepadButton.RT;
      const pressed = isTrigger ? button.value > TRIGGER_THRESHOLD : button.pressed;
      this.buttons[i] = pressed ? 1 : 0;
    }
  }

  isDown(button: number): boolean {
    return this.buttons[button] === 1;
  }

  /** Verdadeiro apenas no frame em que o botão foi pressionado. */
  wasPressed(button: number): boolean {
    return this.buttons[button] === 1 && this.previousButtons[button] === 0;
  }

  private findGamepad(): Gamepad | null {
    const pads = navigator.getGamepads?.() ?? [];
    if (this.index !== null) {
      const pad = pads[this.index];
      if (pad?.connected) return pad;
    }
    // O índice pode mudar após reconexão: pegar o primeiro disponível.
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
