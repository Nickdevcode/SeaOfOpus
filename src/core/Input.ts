/**
 * Entrada unificada: teclado, mouse e gamepad falam a mesma língua de "ações".
 *
 * O resto do jogo nunca pergunta "a tecla F está pressionada?" — pergunta
 * "a ação INTERACT foi acionada?". O ganho é que teclado e controle entram pelo
 * mesmo funil e a interface tem uma única tabela de rótulos para consultar
 * (`ACTION_LABELS`): trocar um binding aqui reescreve o prompt no convés e a
 * linha na tela de controles sem tocar em nenhum dos dois.
 *
 * Os bindings são fixos. Não há remapeamento pelo jogador — se um dia houver, o
 * lugar é `KEY_BINDINGS`/`PAD_BINDINGS`, e nada fora daqui precisa saber.
 *
 * Bindings fiéis ao Sea of Thieves: F interage, R carrega o canhão, LMB
 * dispara, RMB mira. No controle: X interage, Y carrega, RT dispara, LT mira.
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

/** Tecla (`KeyboardEvent.code`) → ação. */
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

/** Botão do gamepad → ação. */
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
 * Rótulo de uma ação que não tem botão no aparelho perguntado.
 *
 * Vale como valor, e não como string solta, porque a interface **decide** com
 * base nele: a tabela de controles mostra o travessão desbotado, mas uma linha
 * de dica de rodapé se esconde inteira em vez de anunciar um aperto que não
 * existe (ver `Menu.syncGlyphs`).
 */
export const NO_BINDING = '—';

/**
 * Rótulos legíveis para a tela de controles.
 *
 * Em inglês, e sem sotaque: "Take the helm", não "Belay there, matey". A
 * interface é o lugar onde o jogo **instrui**, e instrução com sotaque custa uma
 * fração de segundo de decodificação toda vez que é lida. O tema fica na
 * madeira, no latão e no mar; o texto fica claro.
 *
 * O campo `gamepad` guarda sempre o nome do layout padrão (Xbox). Quem mostra na
 * tela deve passar por `Input.padLabel`, que traduz para o layout do controle que
 * está de fato ligado.
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
 * Como cada botão se chama num controle da Sony.
 *
 * A tabela é de **rótulos**, não de bindings: o índice do botão não muda (a
 * Gamepad API normaliza tudo para o layout "standard"), muda o que está gravado
 * nele. Mostrar `A` para quem tem um DualSense na mão é a mesma classe de erro
 * que mostrar `F` para quem está de controle — a interface está descrevendo um
 * aparelho que não é o que o jogador está segurando.
 *
 * A chave é o rótulo Xbox de `ACTION_LABELS`, e não a ação: assim uma ação nova
 * que reaproveite um botão já traduzido não precisa de linha aqui.
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

/** Traduz um rótulo de botão do layout padrão (Xbox) para o layout em uso. */
function padGlyph(xboxLabel: string, layout: GamepadLayout): string {
  if (layout !== 'playstation') return xboxLabel;
  return PLAYSTATION_GLYPHS[xboxLabel] ?? xboxLabel;
}

/** Radianos de rotação por pixel de mouse, antes da sensibilidade do jogador. */
const MOUSE_RADIANS_PER_PIXEL = 0.0022;
/** Radianos por segundo com o analógico direito no talo. */
const PAD_RADIANS_PER_SECOND = 3.2;

/** Que aparelho o jogador está usando **agora**. */
export type InputDevice = 'keyboard' | 'gamepad';

/**
 * Movimento de mouse, em pixels num frame, que conta como "voltei ao mouse".
 *
 * Não é zero de propósito. Mouse ótico parado ainda emite eventos de um pixel por
 * tremor de mesa, e com limiar zero o rótulo piscaria entre tecla e botão enquanto
 * o jogador joga de controle com a mão perto do mouse.
 */
const MOUSE_WAKE_PIXELS = 6;

/**
 * Fração do curso do analógico que conta como intenção de usar o controle.
 *
 * Bem acima da zona morta de propósito: ver a nota em `beginFrame`.
 */
const STICK_INTENT = 0.5;

/** Quadros de carência depois de travar o ponteiro. Ver `onMouseMove`. */
const LOCK_SETTLE_FRAMES = 2;

/**
 * As únicas ações de controle que atravessam a entrada congelada.
 *
 * É a mesma exceção que o teclado faz para `Esc` em `onKeyDown`, e existe pelo
 * mesmo motivo: o botão que abre uma tela precisa poder fechá-la. Sem isto, Menu
 * e View ficavam mudos justamente com o menu no ar — quem entrou de controle não
 * tinha como sair sem encostar no teclado.
 *
 * O resto continua barrado, e isso não é excesso de zelo: `A` confirma um botão
 * do menu, e se ele passasse, o mesmo aperto viraria pulo a bordo no quadro em
 * que a tela fecha.
 */
const CAPTURED_PAD_ACTIONS: ReadonlySet<Action> = new Set<Action>(['pause', 'controls']);

export class Input {
  readonly gamepad = new GamepadManager();

  /** Delta de olhar acumulado desde o último frame, já em radianos. */
  readonly look = { x: 0, y: 0 };

  /** Verdadeiro quando o ponteiro está travado no canvas (modo jogo). */
  pointerLocked = false;

  /**
   * Aparelho que o jogador acabou de usar. **Toda a interface lê daqui** para
   * decidir se mostra `F` ou `X`, `Shift` ou `L3`.
   *
   * É "último usado", e não "está conectado", e a diferença é a que o jogador
   * percebe: com um controle plugado na mesa e as mãos no teclado, olhar a conexão
   * mostraria botões que ele não está tocando. Aqui, os rótulos trocam no instante
   * em que ele encosta no analógico, e voltam quando ele volta ao WASD.
   */
  activeDevice: InputDevice = 'keyboard';

  private held = new Set<Action>();
  private pressedThisFrame = new Set<Action>();

  private mouseDelta = { x: 0, y: 0 };
  private wheelDelta = 0;
  /** Quadros restantes de carência após travar o ponteiro. */
  private lockSettleFrames = 0;

  /** Quando true, a entrada de jogo é ignorada (menu aberto). */
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
    // Sem isso o menu de contexto rouba o botão direito (mira focada).
    canvas.addEventListener('contextmenu', (event) => event.preventDefault());
  }

  /**
   * Pede o pointer lock.
   *
   * `unadjustedMovement` é o que separa uma mira de jogo de uma mira de
   * planilha. Sem ele o navegador entrega o delta **já processado pelo sistema
   * operacional**: no Windows isso inclui a aceleração de ponteiro, que
   * multiplica movimentos rápidos e não mexe nos lentos. O efeito é uma câmera
   * que responde diferente ao mesmo gesto conforme a velocidade da mão — o
   * jogador sente "peso" e "escorregão" que não estão em lugar nenhum do código,
   * e nenhum ajuste de sensibilidade conserta porque o problema não é escala, é
   * a curva. Pedindo movimento não ajustado, chega o delta cru do sensor.
   *
   * A promessa é rejeitada em navegadores que não suportam a opção; nesse caso
   * a chamada simples é a única saída, e a aceleração do sistema volta a valer.
   */
  requestPointerLock(): void {
    const canvas = this.canvas;
    if (!canvas?.requestPointerLock) return;
    // Já travado: pedir de novo não é erro, mas gasta uma promessa e um evento
    // de `pointerlockchange` que reinicia a carência de `lockSettleFrames` — e
    // aí o primeiro movimento depois de cada clique some.
    if (document.pointerLockElement === canvas) return;

    // As duas chamadas podem ser recusadas, e a recusa é normal: o navegador
    // impõe uma carência de pouco mais de um segundo depois de o jogador sair do
    // lock com `Esc`. Uma promessa rejeitada sem `catch` vira um erro vermelho no
    // console a cada clique dentro dessa janela, o que faz procurar defeito onde
    // não há — quem devolve o ponteiro é o clique seguinte.
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
   * Congela a entrada de jogo (usado enquanto o menu está aberto), sem
   * desmontar os listeners.
   */
  setCaptured(captured: boolean): void {
    this.captured = captured;
    if (captured) {
      this.held.clear();
      this.look.x = 0;
      this.look.y = 0;
    }
  }

  /** Roda no início de cada frame, antes de qualquer sistema ler a entrada. */
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
      // Mouse: delta bruto em pixels vira radianos.
      let lookX = this.mouseDelta.x * MOUSE_RADIANS_PER_PIXEL * prefs.mouseSensitivity;
      let lookY = this.mouseDelta.y * MOUSE_RADIANS_PER_PIXEL * prefs.mouseSensitivity;
      this.mouseDelta.x = 0;
      this.mouseDelta.y = 0;

      // Gamepad: velocidade angular integrada no tempo (o analógico é posição,
      // não delta), com dt limitado para não dar um giro absurdo após um travo.
      if (pad.connected) {
        const step = Math.min(dt, 0.1) * PAD_RADIANS_PER_SECOND * prefs.gamepadSensitivity;
        lookX += pad.rightStick.x * step;
        lookY += pad.rightStick.y * step;
      }

      this.look.x = lookX;
      this.look.y = prefs.invertY ? -lookY : lookY;
    }

    if (!pad.connected) return;

    // Botões do gamepad geram as mesmas bordas de "pressionado" do teclado.
    //
    // O laço roda **também com o menu aberto**, e os dois motivos são
    // independentes. Um: `pause` e `controls` precisam chegar ao laço principal
    // (ver `CAPTURED_PAD_ACTIONS`). Dois: é aqui, e no teste de analógico logo
    // abaixo, que se descobre que o jogador largou o teclado e pegou o controle —
    // cortar o laço com o menu no ar era o que fazia a tela de Controles anunciar
    // `Tab`, `F` e `Esc` para quem estava com as duas mãos no gamepad, que é
    // justamente a tela onde o rótulo errado custa mais caro.
    let padActive = false;
    for (const [button, action] of PAD_BINDINGS) {
      const pressed = pad.wasPressed(button);
      const down = pad.isDown(button);
      if (pressed || down) padActive = true;

      // Congelado, só as ações de menu viram estado. As de jogo nem entram em
      // `held`: o menu limpa o conjunto ao abrir, e reabastecê-lo aqui seria
      // devolver o controle do jogador para trás da sobreposição.
      if (this.captured && !CAPTURED_PAD_ACTIONS.has(action)) continue;

      if (pressed) this.pressedThisFrame.add(action);
      if (down) this.held.add(action);
      else if (!this.isKeyboardSource(action)) this.held.delete(action);
    }

    // Analógico só conta como uso acima de um limiar **bem** acima da zona morta.
    //
    // A zona morta padrão é 18% do curso, e é calibrada para o jogo não andar
    // sozinho. Ela não serve como prova de intenção: um analógico gasto passa
    // dela de vez em quando parado na mesa, e com o teste em "diferente de zero"
    // bastava um desses tremores para a interface inteira trocar para botões de
    // controle e ficar lá — o jogador de teclado via `X` e `L3` no HUD sem ter
    // encostado no controle. Meio curso é gesto, não ruído.
    const moved =
      Math.hypot(pad.leftStick.x, pad.leftStick.y) > STICK_INTENT ||
      Math.hypot(pad.rightStick.x, pad.rightStick.y) > STICK_INTENT;
    if (moved || padActive) this.setDevice('gamepad');
  }

  /** Troca o aparelho em uso. A interface lê `activeDevice` por conta própria. */
  private setDevice(device: InputDevice): void {
    this.activeDevice = device;
  }

  /** Atalho de leitura para a interface. */
  get usingGamepad(): boolean {
    return this.activeDevice === 'gamepad';
  }

  /**
   * Rótulo do botão de controle para uma ação, já no layout do aparelho ligado.
   *
   * A interface deve chamar isto em vez de ler `ACTION_LABELS[...].gamepad`
   * direto: a tabela guarda o nome do layout padrão (Xbox), e é aqui que ele
   * vira `✕`/`○`/`□`/`△` quando quem está na mão é um DualSense.
   */
  padLabel(action: Action): string {
    return padGlyph(ACTION_LABELS[action].gamepad, this.gamepad.layout);
  }

  /** Roda no fim do frame: limpa as bordas. */
  endFrame(): void {
    this.pressedThisFrame.clear();
    this.wheelDelta = 0;
  }

  isDown(action: Action): boolean {
    return this.held.has(action);
  }

  /** Verdadeiro apenas no frame em que a ação foi acionada. */
  wasPressed(action: Action): boolean {
    return this.pressedThisFrame.has(action);
  }

  /** Eixo de movimento combinado: X é lateral (direita+), Y é frente (frente+). */
  getMoveAxis(): { x: number; y: number } {
    let x = 0;
    let y = 0;

    if (this.held.has('moveRight')) x += 1;
    if (this.held.has('moveLeft')) x -= 1;
    if (this.held.has('moveForward')) y += 1;
    if (this.held.has('moveBack')) y -= 1;

    // Normaliza a diagonal do teclado para não andar mais rápido na diagonal.
    const length = Math.hypot(x, y);
    if (length > 1) {
      x /= length;
      y /= length;
    }

    // O analógico some junto com o resto da entrada de jogo enquanto o menu está
    // aberto. Sem este teste, o mesmo empurrão que desce um item da lista voava a
    // câmera livre pela cena atrás da sobreposição — o teclado já estava coberto
    // porque `setCaptured` esvazia `held`, o controle é lido direto e não estava.
    const pad = this.gamepad;
    if (pad.connected && !this.captured) {
      x = clamp(x + pad.leftStick.x, -1, 1);
      y = clamp(y - pad.leftStick.y, -1, 1);
    }

    return { x, y };
  }

  /** Rolagem do mouse desde o último frame, em "cliques" normalizados. */
  getWheelDelta(): number {
    return this.wheelDelta;
  }

  private isKeyboardSource(action: Action): boolean {
    // Ações que também têm binding de teclado/mouse não podem ser apagadas
    // pelo gamepad quando o botão está solto.
    return this.keyboardHeld.has(action);
  }

  private keyboardHeld = new Set<Action>();

  private onKeyDown = (event: KeyboardEvent): void => {
    const action = KEY_BINDINGS[event.code];
    if (!action) return;

    // Tab move o foco e Espaço rola a página: nenhum dos dois é bem-vindo **em
    // jogo**. Com o menu aberto é o oposto — Tab *é* a navegação e Espaço aciona
    // o `<button>` focado, e engolir os dois antes de olhar para `captured`
    // deixava a sobreposição inteira inoperável no teclado: nem tabular entre os
    // botões, nem apertar o que estava focado. Por isso a supressão é condicional,
    // e não incondicional como era.
    //
    // O teste fica antes de `event.repeat` de propósito: segurar Espaço no convés
    // repete o keydown, e cada repetição precisa ser suprimida ou a página rola.
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
    // Clicar é gesto de mouse sem ambiguidade, e por isso a detecção de aparelho
    // vem **antes** do congelamento: é assim que os rótulos voltam para o teclado
    // depois de uma passada pelo controle, já que o simples mover do cursor não
    // troca mais nada com o menu aberto (ver `onMouseMove`). O que o menu congela
    // é a ação — disparar e mirar —, não a leitura de quem está jogando.
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
    // Mover o mouse só desperta o teclado **em jogo**.
    //
    // Com o menu aberto o cursor está solto, e chegar a um botão exige movê-lo —
    // inclusive para quem está de controle e esbarra no mouse ao lado do teclado.
    // Enquanto isso trocava o aparelho, a tela de Controles voltava para `Tab` e
    // `F` no instante em que se ia lê-la de controle, que era exatamente o
    // contrário do que ela existe para fazer. Aberto o menu, quem troca para
    // teclado é a tecla ou o clique — gestos que ninguém dá sem querer.
    if (
      !this.captured &&
      Math.abs(event.movementX) + Math.abs(event.movementY) >= MOUSE_WAKE_PIXELS
    ) {
      this.setDevice('keyboard');
    }
    if (!this.pointerLocked || this.captured) return;

    // Descarta o pico do primeiro evento depois de travar o ponteiro.
    //
    // Ao entrar em pointer lock o navegador entrega, no primeiro `mousemove`, o
    // deslocamento acumulado desde a última posição conhecida do cursor — que
    // pode ser a tela inteira. O sintoma é a câmera dar um giro violento e
    // aleatório no instante em que se clica para jogar, e depois se comportar
    // normalmente. Dois quadros de carência custam nada e matam o salto.
    if (this.lockSettleFrames > 0) return;

    this.mouseDelta.x += event.movementX;
    this.mouseDelta.y += event.movementY;
  };

  private onWheel = (event: WheelEvent): void => {
    if (this.captured) return;
    this.wheelDelta += Math.sign(event.deltaY);
  };

  /** Perder o foco da janela precisa soltar tudo, senão a tecla "gruda". */
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
