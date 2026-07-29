/**
 * As telas de sobreposição: título, duelo contra a máquina, ajustes, controles e
 * fim de partida — mais as três de jogo em rede, que vêm de `OnlineMenu`.
 *
 * As daqui moram juntas porque são **uma família**: mesmo véu, mesma folha, mesma
 * navegação, e nunca mais de uma visível. Separá-las em cinco módulos duplicaria a
 * lógica de mostrar/esconder e a de foco em quatro lugares para ganhar nada — quem
 * mexer no véu quer mexer em todas de uma vez.
 *
 * ## Por que o online é o único que sai daqui
 *
 * Tudo neste arquivo é **síncrono**: nada muda sem um clique ou um passo de foco.
 * As telas de rede são o oposto — o conteúdo delas muda por evento externo (o
 * socket), num relógio que não é o do jogador. `OnlineMenu` constrói aquele DOM e
 * o registra em `screens`; véu, foco, `back()` e navegação por controle continuam
 * sendo daqui. É extração de *construção*, não de *comportamento*.
 *
 * ## Navegação
 *
 * Tudo aqui é `<button>` de verdade, e não `div` com `onclick`. Sai de graça o que
 * seria caro reimplementar: ordem de tabulação, `Enter`/`Espaço`, foco visível,
 * leitura por leitor de tela e o cursor certo. O d-pad e o analógico esquerdo viram
 * um passo de foco entre os botões da tela ativa, o que faz o controle funcionar sem
 * um sistema de foco paralelo ao do navegador.
 *
 * Os dois eixos não fazem a mesma coisa, e é o que torna a tela de Ajustes operável
 * só no controle: **vertical troca de campo, horizontal mexe no campo focado** —
 * arrasta o deslizante, alterna a opção do grupo, vira o interruptor. Ver
 * `navigate`.
 *
 * O gamepad é lido direto de `input.gamepad`, e não das ações de `Input`: com o
 * menu aberto a entrada de jogo está congelada (`setCaptured`), e é justamente isso
 * que se quer — `A` no menu não pode virar pulo a bordo no quadro seguinte. As
 * únicas ações que `Input` deixa passar congelado são `pause` e `controls`, que é o
 * que faz o botão Menu fechar o que ele abriu; quem as consome é o laço principal.
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

/** Qual tela está no ar. `none` é o jogo rodando, sem sobreposição. */
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
 * Telas de onde o "Voltar" tem para onde ir.
 *
 * `title` é a raiz e `outcome` é um beco com saídas próprias ("Sail again" e
 * "Main menu") — em nenhuma das duas `Esc`/`B` deve fazer nada, e é por isso que
 * a regra é uma lista e não um `screen !== 'title'`.
 */
const RETURNABLE: ReadonlySet<Screen> = new Set<Screen>([
  'solo',
  'online',
  'join',
  'room',
  'settings',
  'controls',
]);

/** Ações que a tela de controles lista, na ordem em que se aprende o navio. */
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

/** Rótulos das opções de tempo. A lista de modos vem de `WEATHER_MODES`. */
const WEATHER_LABELS: Record<WeatherMode, string> = {
  dynamic: 'Live',
  clear: 'Clear',
  breeze: 'Breeze',
  squall: 'Squall',
  storm: 'Storm',
};

/**
 * Leitura do analógico esquerdo que conta como uma direção de menu.
 *
 * O número é baixo porque o valor que chega de `GamepadManager` **já passou por
 * uma curva quadrática** (ver `applyDeadzone`): 0,2 de leitura corresponde a
 * pouco mais de meio curso físico com a zona morta padrão, que é o gesto que se
 * espera de quem quer descer um item. Comparar contra 0,5 aqui exigiria três
 * quartos do curso, e a navegação pareceria emperrada.
 */
const NAV_STICK = 0.2;

/**
 * Repetição de uma direção presa, em segundos: espera até a primeira repetição e
 * intervalo entre as seguintes.
 *
 * O primeiro passo é sempre imediato — quem toca o d-pad quer um passo, não uma
 * espera. A pausa que vem depois é o que separa "andei um item" de "atravessei a
 * barra de volume", e o intervalo curto depois dela é o que torna suportável
 * arrastar um deslizante de 0 a 100% com o controle.
 */
const NAV_FIRST_REPEAT = 0.42;
const NAV_REPEAT = 0.08;

/**
 * O que conta como um passo de foco.
 *
 * Uma constante, e não o seletor escrito duas vezes: `show` usa isto para escolher
 * onde o foco entra e `moveFocus` para saber por onde ele anda. Enquanto eram dois
 * literais, um campo novo aparecia na navegação do d-pad mas nunca recebia o foco
 * de entrada — e o sintoma era um primeiro `↓` que parecia não fazer nada.
 *
 * Botão desabilitado fica de fora: ele não recebe foco, e incluí-lo daria um passo
 * de d-pad que some no vazio.
 */
const FOCUSABLE = 'button:not([disabled]), input[type="range"], input[type="text"]';

/**
 * Escreve uma preferência numérica.
 *
 * O `as` é seguro por construção: todo campo listado em `RangedPreference` é
 * `number` em `PlayerPreferences`. A alternativa era uma cadeia de `if` por
 * campo, que é o tipo de código que envelhece mal a cada ajuste novo.
 */
function updateNumber(preference: RangedPreference, value: number): void {
  settings.update({ [preference]: value } as Partial<PlayerPreferences>);
}

/** Duas teclas opostas viram um eixo. Apertadas juntas se anulam. */
function axis(positive: boolean, negative: boolean): -1 | 0 | 1 {
  return positive === negative ? 0 : positive ? 1 : -1;
}

/**
 * Aferições mostradas em cada cartão de capitão, de 0 a 1.
 *
 * São **derivadas dos presets**, não digitadas: mudar `aimSigma` em `Difficulty`
 * move a barrinha sozinho. Precisão e reação são invertidas porque nos dois casos
 * o número baixo é o bom.
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
 * Uma dica de rodapé.
 *
 * Com `action`, o glifo troca sozinho quando o jogador muda de aparelho — que é
 * o ponto: a linha dizia `Tab`, `Esc` e `C` para sempre, inclusive com o
 * controle na mão. `key` é a saída para as dicas que não são uma ação do jogo
 * (um `W / S` de escada, por exemplo).
 */
export interface Hint {
  action?: Action;
  key?: string;
  text: string;
}

export interface MenuCallbacks {
  /** O jogador soltou amarras contra a máquina. */
  onStartSolo(difficulty: DifficultyId): void;
  /** Voltou ao menu de título a partir do fim de partida. */
  onQuitToTitle(): void;
  /** Qualquer clique ou movimento de foco, para o áudio responder. */
  onNavigate?(kind: 'move' | 'confirm' | 'back'): void;
  /** O que os botões das telas de rede acionam. Ver `OnlineMenu`. */
  readonly online: OnlineMenuCallbacks;
}

/** Como uma partida terminou, para a tela de fim saber o que oferecer. */
export type OutcomeMode = 'solo' | 'online';

/**
 * Um campo que responde a ←/→ sem ser um deslizante, um grupo de opções ou um
 * interruptor.
 *
 * Existe para `cycleOption` continuar sendo a regra horizontal do menu inteiro
 * enquanto telas de fora acrescentam campos próprios. Sem isto, `Menu` teria de
 * conhecer a classe CSS de cada widget novo — e o que é um caractere de código de
 * sala não é assunto deste arquivo.
 *
 * @returns `false` quando o passo não foi consumido: quem assume é `moveFocus`, e
 * o foco escapa para o campo vizinho. É o mesmo contrato da ponta de um grupo.
 */
export interface MenuWidget {
  /** ←/→ no campo focado. */
  cycle(direction: 1 | -1): boolean;
  /**
   * ↑/↓ no campo focado, para os campos em que o eixo natural é o vertical.
   *
   * É a exceção declarada à regra "vertical troca de campo", e ela existe por um
   * caso: um código de sala é lido da esquerda para a direita, então ←/→ têm de
   * andar entre os caracteres — é o gesto que qualquer pessoa tenta primeiro. Se
   * a letra mudasse no horizontal, atravessar o código exigiria o eixo que o olho
   * usa para lê-lo, e sair do campo ficaria sem saída nenhuma.
   *
   * Quem devolve `false` aqui devolve o passo a `moveFocus`, como sempre.
   */
  step?(direction: 1 | -1): boolean;
}

export class Menu {
  private readonly root: HTMLDivElement;
  private readonly screens = new Map<Exclude<Screen, 'none'>, HTMLDivElement>();

  private screen: Screen = 'title';
  private difficulty: DifficultyId = 'corsair';

  /** As três telas de rede. Constrói o DOM delas; a navegação continua sendo daqui. */
  private readonly online: OnlineMenu;

  /**
   * A carta "Duel another captain".
   *
   * Guardada porque ela é a única da tela que pode nascer morta: sem servidor de
   * sala configurado não há jogo em rede, e um botão que abre uma tela para dar
   * erro é pior que um botão apagado que diz o porquê. Ver `setOnlineAvailable`.
   *
   * `!` porque quem a cria é `buildTitle`, chamada do construtor.
   */
  private onlineCard!: HTMLButtonElement;
  /** A frase de chamada original da carta, para repor quando o modo voltar. */
  private onlineBlurb = '';

  private readonly choiceButtons = new Map<DifficultyId, HTMLButtonElement>();
  private readonly outcomeBox: HTMLDivElement;
  private readonly outcomeTitle: HTMLHeadingElement;
  private readonly outcomeBlurb: HTMLParagraphElement;
  private readonly tally: HTMLDivElement;
  /** "Sail again", que só existe contra a máquina — ver `showOutcome`. */
  private readonly outcomeAgain: HTMLButtonElement;
  /** Linhas da tela de controles, para trocar os glifos ao vivo. */
  private readonly controlRows: {
    action: Action;
    keyboard: HTMLElement;
    gamepad: HTMLElement;
  }[] = [];
  /** Glifos das linhas de dica, que trocam de aparelho junto com a tabela. */
  private readonly hintGlyphs: { action: Action; item: HTMLElement; glyph: HTMLElement }[] = [];
  /** Aparelho + layout já pintados, para não reescrever o DOM a cada quadro. */
  private lastGlyphKey: string | null = null;

  /** Direção de menu sustentada no controle, e o tempo até o próximo passo. */
  private navX = 0;
  private navY = 0;
  private navRepeat = 0;

  /**
   * Por onde se chegou até aqui, para o "Voltar" desfazer um passo de cada vez.
   *
   * Era um campo só (`returnTo`), e bastava enquanto ajustes e controles eram as
   * únicas subtelas. Com `título → online → entrar em sala`, um campo só perde o
   * degrau do meio e o Voltar salta para o título. Empilhar `'none'` continua
   * sendo o que faz `Esc` no meio do duelo devolver o jogador ao convés.
   */
  private readonly history: Screen[] = [];

  /** Campos de telas de fora que respondem a ←/→. Ver `MenuWidget`. */
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

    // Depois das daqui: o construtor de `OnlineMenu` chama `registerWidget`, que
    // depende de `this.widgets` — e campos de classe já estão inicializados aqui.
    this.online = new OnlineMenu(this.root, callbacks.online, this);
    for (const [name, overlay] of this.online.screens) this.screens.set(name, overlay);

    this.show('title');
  }

  /**
   * Um campo de tela externa que quer ←/→. Ver `MenuWidget`.
   *
   * Público porque quem chama é `OnlineMenu`, que constrói o próprio DOM e é o
   * único que sabe o que cada elemento dele faz.
   */
  registerWidget(element: HTMLElement, widget: MenuWidget): void {
    this.widgets.set(element, widget);
  }

  /** Repinta as telas de rede com o estado que o `OnlineSession` reporta. */
  setOnlineState(state: OnlineViewState): void {
    this.online.render(state);
  }

  /**
   * Liga ou desliga o duelo em rede na tela de título.
   *
   * Desligado, a carta continua na tela com o motivo escrito onde estava a frase
   * de chamada — falhar aqui é falhar na hora certa. Esconder a carta seria pior:
   * quem procura o modo online concluiria que ele não existe.
   */
  setOnlineAvailable(available: boolean, reason?: string): void {
    this.onlineCard.disabled = !available;
    const blurb = this.onlineCard.querySelector<HTMLElement>('.mode__blurb');
    if (!blurb) return;
    // A frase de chamada é reposta quando o modo volta: o motivo é um estado, não
    // uma substituição definitiva.
    blurb.textContent = available ? this.onlineBlurb : (reason ?? this.onlineBlurb);
  }

  get current(): Screen {
    return this.screen;
  }

  /** `true` quando alguma sobreposição está no ar (e o jogo não deve receber entrada). */
  get open(): boolean {
    return this.screen !== 'none';
  }

  show(screen: Screen): void {
    this.screen = screen;
    for (const [name, overlay] of this.screens) overlay.hidden = name !== screen;

    if (screen === 'none') return;
    // O foco vai para o primeiro botão da tela: sem isso, `Tab` começaria do topo
    // do documento e o d-pad não teria de onde partir.
    const first = this.screens.get(screen)?.querySelector<HTMLElement>(FOCUSABLE);
    first?.focus();
  }

  /**
   * Mostra o resultado de uma partida.
   *
   * `mode` decide se há "Sail again": contra a máquina o botão reinicia o duelo
   * na hora, mas em rede não há o que reiniciar de um lado só — o adversário já
   * está de volta ao menu dele, e revanche é uma conversa entre os dois.
   */
  showOutcome(won: boolean, stats: MatchStats, mode: OutcomeMode = 'solo'): void {
    // A tela de fim é um beco: o Voltar não sai dela, e o que estava empilhado
    // antes já não leva a lugar nenhum. Sem esta linha a pilha só cresce.
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
   * Um quadro de menu: navegação por controle e sincronia dos glifos.
   *
   * Roda sempre, mesmo com o menu fechado, porque a troca teclado↔controle precisa
   * estar em dia quando a tela de controles abrir.
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

    // D-pad e analógico esquerdo entram pelo mesmo caminho: os dois são "uma
    // direção", e quem segura qualquer um dos dois espera repetição. Tratar o
    // d-pad como toque isolado (`wasPressed`) obrigava a martelar o botão para
    // atravessar um deslizante de ponta a ponta.
    const x = axis(
      pad.isDown(GamepadButton.DPAD_RIGHT) || pad.leftStick.x > NAV_STICK,
      pad.isDown(GamepadButton.DPAD_LEFT) || pad.leftStick.x < -NAV_STICK,
    );
    // O analógico devolve Y positivo para baixo (ver `GamepadManager`), que é o
    // mesmo sentido do d-pad aqui: empurrar para baixo avança na lista.
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
   * Abre ajustes ou controles por cima do que estiver acontecendo.
   *
   * Durante a partida isto **é** a pausa: `returnTo` fica em `'none'`, então o
   * "Voltar" devolve o jogador ao convés em vez de ao título. Uma tela de pausa
   * dedicada seria uma quinta tela para repetir dois botões.
   */
  openOverlay(screen: Extract<Screen, 'settings' | 'controls'>): void {
    this.openSub(screen);
  }

  /** `Esc`/`B`: sai da tela atual para a anterior. */
  back(): void {
    if (!RETURNABLE.has(this.screen)) return;

    // Sair da sala de espera **é** desistir dela. Sem isto, quem aperta Voltar
    // continuaria ocupando uma vaga na fila, e o adversário que entrasse depois
    // encontraria um oponente que já foi embora.
    if (this.screen === 'room' || this.screen === 'join') this.callbacks.online.onCancel();

    this.callbacks.onNavigate?.('back');
    this.show(this.history.pop() ?? 'title');
  }

  dispose(): void {
    this.root.remove();
  }

  // -- construção --------------------------------------------------------------

  /**
   * A primeira tela: com quem se vai brigar, antes de qualquer outra pergunta.
   *
   * Os dois modos são **cartas**, e não dois botões numa fileira, porque a escolha
   * precisa de uma frase cada. "Online" num botão de latão não diz se é contra
   * quem está do lado ou contra quem está longe, se precisa de amigo, nem se há
   * gente para jogar — e essas três dúvidas são exatamente o que faz alguém não
   * clicar. A tarja acima do nome resolve a única que não cabe numa frase.
   *
   * A dificuldade saiu daqui de propósito: ela só existe contra a máquina, e
   * perguntá-la antes de saber se a máquina está em jogo é perguntar cedo.
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

    // A câmera livre saiu daqui e entrou na tabela de controles: ela era
    // anunciada nas duas telas, e a tabela é onde uma lista de comandos pertence.
    this.buildHintLine(sheet, [
      { action: 'controls', text: 'Controls' },
      { action: 'pause', text: 'Pause mid-duel' },
    ]);

    return overlay;
  }

  /** Uma das cartas de modo da tela de título. */
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

  /** A escolha de capitão, que só faz sentido quando o adversário é a máquina. */
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

    // --- preset gráfico ---
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

    // --- deslizantes ---
    // As faixas não estão aqui: vêm de `PREFERENCE_RANGES`, a mesma tabela contra
    // a qual o `Settings` valida o que sai do `localStorage`. Números repetidos
    // nos dois lugares saem de sincronia na primeira vez que um deles muda.
    this.buildSlider(grid, 'Master volume', 'masterVolume', (v) => `${Math.round(v * 100)}%`);
    this.buildSlider(grid, 'Mouse sensitivity', 'mouseSensitivity', (v) => `${v.toFixed(2)}×`);
    this.buildSlider(grid, 'Gamepad sensitivity', 'gamepadSensitivity', (v) => `${v.toFixed(2)}×`);
    this.buildSlider(grid, 'Stick deadzone', 'gamepadDeadzone', (v) => `${Math.round(v * 100)}%`);
    this.buildSlider(grid, 'Day length', 'dayLengthMinutes', (v) => `${v.toFixed(0)} min`);
    this.buildSlider(grid, 'Field of view', 'fieldOfView', (v) => `${v.toFixed(0)}°`);

    // --- tempo ---
    // Deixar o jogador travar o tempo é o que torna o sistema de clima jogável
    // em vez de só observável: quem quer treinar num mar previsível trava em
    // "Clear", quem quer ver o temporal trava em "Storm" e não espera a cadeia
    // de transições chegar lá sozinha.
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

    // --- interruptor ---
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
    // `input`, e não `change`: o valor tem de valer enquanto o cursor arrasta —
    // ninguém calibra sensibilidade sem ver o efeito. O custo de aplicar dezenas
    // de vezes por segundo é contido do outro lado (guarda de preset em
    // `applyPreferences`, gravação adiada em `Settings`), e não aqui.
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
      // A escada do mastro entrou nesta lista no dia em que deixou de ser
      // automática: agarra-se e solta-se com a mesma tecla, e é a única peça do
      // navio em que isso vale nas duas pontas — no convés ela sobe, na gávea
      // ela desce. Quem não souber disso fica preso lá em cima.
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
   * Uma linha de dicas no rodapé de uma folha.
   *
   * Pública porque `OnlineMenu` também tem rodapé, e os glifos têm de ser
   * registrados **aqui**: quem os troca quando o jogador larga o teclado e pega o
   * controle é `syncGlyphs`, que varre uma lista só. Uma segunda lista no outro
   * módulo daria uma tela em que os glifos param de acompanhar o aparelho.
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

  // -- estado ------------------------------------------------------------------

  private openSub(screen: Extract<Screen, 'settings' | 'controls'>): void {
    this.push(screen);
  }

  /**
   * Avança uma tela, guardando de onde veio.
   *
   * Público-para-dentro porque `OnlineMenu` também navega (o "Join a room" leva à
   * tela do código), e o histórico tem de ser o mesmo dos dois lados — duas pilhas
   * é como o Voltar passa a mentir.
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
