/**
 * Presets gráficos e preferências do jogador.
 *
 * O preset é detectado automaticamente na primeira execução a partir do
 * renderer WebGL relatado pela GPU, e depois pode ser trocado no menu.
 * Tudo é persistido em localStorage.
 */

export type QualityPreset = 'low' | 'medium' | 'high' | 'ultra';

/**
 * Os presets na ordem em que aparecem no menu, do mais leve ao mais pesado.
 *
 * Existe para o menu e o validador do `localStorage` não escreverem a lista cada
 * um por conta própria: um preset novo entra aqui e os dois se ajustam.
 */
export const QUALITY_ORDER: readonly QualityPreset[] = ['low', 'medium', 'high', 'ultra'];

export interface QualitySettings {
  /** Multiplicador da resolução de render (1 = nativo, limitado pelo devicePixelRatio). */
  renderScale: number;
  /** Resolução do shadow map da luz direcional. 0 desliga sombras. */
  shadowMapSize: number;
  /**
   * Anéis concêntricos da malha do oceano. Os raios crescem em progressão
   * geométrica, então cada anel a mais aumenta a densidade em toda a extensão,
   * não só perto — o triângulo mantém sempre o mesmo tamanho aparente.
   *
   * Anéis e segmentos são escolhidos juntos para que o passo radial
   * (`raio × (crescimento − 1)`) fique próximo do passo angular
   * (`raio × 2π/segmentos`). Triângulos aproximadamente equiláteros filtram
   * onda melhor que fatias compridas com a mesma contagem de triângulos.
   */
  oceanRings: number;
  /** Divisões angulares do oceano (quantos "gomos" cada anel tem). */
  oceanSegments: number;
  //
  // ⚠️ **Não** volte a pôr `waveCount` aqui.
  //
  // Ele existiu, variando de 4 a 6 conforme o preset, e era um defeito de duas
  // caras. O visível: arrastar o deslizante de qualidade regerava o campo de
  // ondas no meio da partida, e um tiro em voo caía num mar que não era o de
  // onde tinha sido disparado. O invisível, e pior: o mar é simulação, não
  // enfeite — dois jogadores em presets diferentes navegariam mares diferentes,
  // com forças de empuxo diferentes, na mesma sala. O campo agora tem sempre as
  // seis ondas, e quem faz o trabalho de aliviar máquina fraca é o `waveFilterWeight`
  // do oceano, que é onde esse trabalho pertence. O custo no preset Baixo são
  // duas iterações a mais num laço de vertex shader.
  //
  /** Resolução do render target da espuma de esteira. */
  wakeResolution: number;
  bloom: boolean;
  godRays: boolean;
  /** Antialiasing por SMAA no composer. */
  smaa: boolean;
  /**
   * Mapa de ambiente pré-filtrado a partir do céu.
   *
   * É o que dá reflexo aos metais e aos vidros do navio — sem ele o latão e o
   * ferro só existem onde o sol bate. Desligado no preset Baixo, onde a luz
   * hemisférica volta à intensidade cheia para cobrir o difuso sozinha.
   */
  skyEnvironment: boolean;
  /** Partículas de respingo e fumaça por evento. */
  particleBudget: number;
}

export const QUALITY_PRESETS: Record<QualityPreset, QualitySettings> = {
  low: {
    renderScale: 0.75,
    shadowMapSize: 0,
    oceanRings: 150,
    oceanSegments: 128,
    wakeResolution: 256,
    bloom: false,
    godRays: false,
    smaa: false,
    skyEnvironment: false,
    particleBudget: 24,
  },
  medium: {
    renderScale: 1,
    shadowMapSize: 1024,
    oceanRings: 200,
    oceanSegments: 176,
    wakeResolution: 512,
    bloom: true,
    godRays: false,
    smaa: true,
    skyEnvironment: true,
    particleBudget: 48,
  },
  high: {
    renderScale: 1,
    shadowMapSize: 2048,
    oceanRings: 260,
    oceanSegments: 240,
    wakeResolution: 512,
    bloom: true,
    godRays: true,
    smaa: true,
    skyEnvironment: true,
    particleBudget: 96,
  },
  ultra: {
    renderScale: 1,
    shadowMapSize: 4096,
    oceanRings: 340,
    oceanSegments: 320,
    wakeResolution: 1024,
    bloom: true,
    godRays: true,
    smaa: true,
    skyEnvironment: true,
    particleBudget: 160,
  },
};

/**
 * Como o tempo se comporta na partida.
 *
 * `dynamic` deixa a máquina de estados do `Weather` correr; qualquer outro valor
 * trava o tempo naquele estado. Travar existe por dois motivos legítimos: quem
 * quer treinar tiro num mar previsível, e quem quer *ver* a tempestade sem
 * esperar a cadeia de transições chegar nela.
 */
export type WeatherMode = 'dynamic' | 'clear' | 'breeze' | 'squall' | 'storm';

/** Os modos de tempo na ordem do menu. Mesma razão de `QUALITY_ORDER`. */
export const WEATHER_MODES: readonly WeatherMode[] = [
  'dynamic',
  'clear',
  'breeze',
  'squall',
  'storm',
];

export interface PlayerPreferences {
  quality: QualityPreset;
  /**
   * Nome que o adversário vê no duelo online.
   *
   * Mora aqui, e não numa chave própria de `localStorage`, porque é o único lugar
   * do projeto com validação de entrada externa, gravação adiada e descarga no
   * `pagehide` — três coisas que um `getItem('nickname')` solto teria de repetir.
   */
  nickname: string;
  /** Sensibilidade do mouse, multiplicador sobre a base. */
  mouseSensitivity: number;
  /** Sensibilidade do analógico direito. */
  gamepadSensitivity: number;
  gamepadDeadzone: number;
  invertY: boolean;
  masterVolume: number;
  /** Duração de um dia completo no jogo, em minutos reais. */
  dayLengthMinutes: number;
  /** Campo de visão a pé, em graus. */
  fieldOfView: number;
  /** Tempo fixo, ou `dynamic` para deixá-lo virar sozinho. */
  weather: WeatherMode;
  /** Mostra o overlay de telemetria de física (F3). */
  showDebug: boolean;
}

/** Faixa de um ajuste numérico: o que o deslizante oferece e o que a validação aceita. */
export interface SettingRange {
  min: number;
  max: number;
  /** Passo do deslizante — e também o passo do d-pad na navegação por controle. */
  step: number;
}

/** Preferências numéricas, as únicas que precisam de faixa. */
export type RangedPreference =
  | 'masterVolume'
  | 'mouseSensitivity'
  | 'gamepadSensitivity'
  | 'gamepadDeadzone'
  | 'dayLengthMinutes'
  | 'fieldOfView';

/**
 * As faixas dos ajustes numéricos, **em um lugar só**.
 *
 * O menu constrói os deslizantes a partir daqui e o validador do `localStorage`
 * confere contra a mesma tabela. Repetir os números nos dois lados é como um
 * `fieldOfView: 5000` gravado por uma versão antiga sobrevive a uma faixa que
 * encolheu depois: o menu limita o que o jogador escolhe *agora*, mas quem entra
 * pelo armazenamento não passa por deslizante nenhum.
 *
 * Sobre o campo de visão: aqui a faixa é 55–100 e o
 * `PlayerController.setFieldOfView` grampeia em 45–110. A diferença é
 * intencional e a direção importa — esta faixa vive **dentro** da do
 * controlador, então nenhum valor aceito aqui chega lá para ser silenciosamente
 * alterado. Quem for alargar isto tem de conferir a folga do outro lado antes.
 */
export const PREFERENCE_RANGES: Readonly<Record<RangedPreference, SettingRange>> = {
  masterVolume: { min: 0, max: 1, step: 0.05 },
  mouseSensitivity: { min: 0.2, max: 3, step: 0.05 },
  gamepadSensitivity: { min: 0.2, max: 3, step: 0.05 },
  gamepadDeadzone: { min: 0.02, max: 0.4, step: 0.01 },
  dayLengthMinutes: { min: 2, max: 40, step: 1 },
  fieldOfView: { min: 55, max: 100, step: 1 },
};

const STORAGE_KEY = 'sea-of-opus:prefs';

/**
 * Espera antes de gravar as preferências, em milissegundos.
 *
 * Um deslizante emite um `input` por pixel arrastado. Sem esta folga, atravessar
 * a barra de volume serializa e grava o objeto inteiro dezenas de vezes — e
 * `localStorage.setItem` é síncrono, então cada uma dessas gravações acontece
 * dentro do quadro. O jogador não perde nada com o atraso: o valor já está em
 * memória e já foi aplicado; o que espera é só a cópia em disco.
 */
const PERSIST_DEBOUNCE_MS = 250;

/**
 * Teto do apelido, em caracteres.
 *
 * Dezesseis é o que cabe no cartão de oponente sem quebrar linha na menor largura
 * de tela suportada, e é o mesmo número que o servidor de sala grampeia — quem
 * cortar tem de cortar dos dois lados, ou o nome que aparece para o adversário
 * deixa de ser o nome que o dono digitou.
 */
export const NICKNAME_MAX_LENGTH = 16;

/** Um apelido de estreia, para ninguém precisar inventar um antes de jogar. */
function defaultNickname(): string {
  return `Sailor${Math.floor(Math.random() * 900 + 100)}`;
}

const DEFAULT_PREFERENCES: PlayerPreferences = {
  quality: 'high',
  nickname: defaultNickname(),
  mouseSensitivity: 1,
  gamepadSensitivity: 1,
  gamepadDeadzone: 0.18,
  invertY: false,
  masterVolume: 0.7,
  dayLengthMinutes: 12,
  fieldOfView: 62,
  weather: 'dynamic',
  showDebug: false,
};

/**
 * Estima um preset a partir da string de renderer da GPU.
 *
 * É uma heurística grosseira de propósito: erra para o lado seguro e o jogador
 * pode subir no menu. Só serve para a primeira execução.
 *
 * A ordem dos testes é a correção mais importante daqui. Testar as integradas
 * primeiro parece razoável e está errado, porque as strings se sobrepõem: um
 * híbrido de notebook reporta algo como "Intel(R) UHD Graphics / NVIDIA GeForce
 * RTX 4060", e uma máquina com RTX travava em `medium` só por ter a palavra
 * "Intel" no nome. Dedicadas primeiro, integradas por último — o teste mais
 * específico vence.
 */
function detectPreset(): QualityPreset {
  try {
    const canvas = document.createElement('canvas');
    const gl = canvas.getContext('webgl2');
    if (!gl) return 'low';

    const debugInfo = gl.getExtension('WEBGL_debug_renderer_info');
    const renderer = debugInfo
      ? String(gl.getParameter(debugInfo.UNMASKED_RENDERER_WEBGL))
      : '';
    const gpu = renderer.toLowerCase();

    // Placas dedicadas de topo.
    if (/(rtx (40|50)|rx (7[6-9]|9[0-9])00|apple m[2-9] (max|ultra))/.test(gpu)) {
      return 'ultra';
    }
    // Dedicadas em geral (inclui a RX 6600 alvo e a Arc, que traz "intel" no nome).
    if (/(rtx|gtx|radeon rx|arc a\d)/.test(gpu)) {
      return 'high';
    }
    // Integradas conhecidas: `low`, que é o que o comentário desta lista sempre
    // disse e o código não fazia — devolvia `medium`, o mesmo do caso "não sei",
    // o que tornava o teste inteiro decorativo. Uma UHD 630 não roda este oceano
    // em `medium`, e subir de preset no menu custa dois cliques; descobrir por que
    // o jogo abre a 12 fps custa a sessão.
    //
    // O padrão perdeu o espaço solto que havia antes de `radeon graphics`: com
    // ele, a marca só casava precedida de espaço, e uma string que **começasse**
    // com "Radeon Graphics" escapava.
    if (/(intel|uhd graphics|iris|vega \d|radeon graphics|adreno|mali|apple a\d)/.test(gpu)) {
      return 'low';
    }
    return 'medium';
  } catch {
    return 'medium';
  }
}

// --- validação do que vem do armazenamento -----------------------------------
//
// O `localStorage` é entrada externa como qualquer outra: o jogador pode editá-lo
// no console, uma extensão pode corrompê-lo e uma versão anterior do jogo pode ter
// gravado um formato que não existe mais. Sem validação, um `quality: "potato"`
// vira `QUALITY_PRESETS["potato"] === undefined` e o primeiro acesso a
// `quality.shadowMapSize` no `Renderer` derruba o boot inteiro — tela preta, sem
// menu para consertar. Cada campo cai no padrão quando não passa.

function readEnum<T extends string>(value: unknown, allowed: readonly T[], fallback: T): T {
  return typeof value === 'string' && (allowed as readonly string[]).includes(value)
    ? (value as T)
    : fallback;
}

function readBoolean(value: unknown, fallback: boolean): boolean {
  return typeof value === 'boolean' ? value : fallback;
}

/**
 * Texto curto e apresentável, ou o padrão.
 *
 * Ao contrário de `readNumber`, aqui **saneia em vez de rejeitar**: um apelido com
 * um espaço a mais na ponta é o mesmo apelido, e devolver "Sailor427" a quem
 * digitou "  Barbanegra  " seria trocar a intenção do jogador por um erro de
 * digitação. O que não sobrevive são os caracteres de controle — inclusive os de
 * direção de texto, que reordenam visualmente o resto de uma linha e são a forma
 * clássica de um nome falsificar o que está escrito ao lado dele.
 */
export function readString(value: unknown, maxLength: number, fallback: string): string {
  if (typeof value !== 'string') return fallback;
  const cleaned = value
    // Controles C0/C1, largura zero, marcas e isolamentos bidirecionais, e o BOM.
    .replace(/[\u0000-\u001F\u007F-\u009F\u200B-\u200F\u2028-\u202E\u2066-\u2069\uFEFF]/g, '')
    // Espaços em série viram um só: "Barba      negra" é o mesmo nome, escrito
    // para ocupar a largura de dois.
    .replace(/\s+/g, ' ')
    .trim();
  return cleaned.length > 0 ? cleaned.slice(0, maxLength) : fallback;
}

/**
 * Número dentro da faixa, ou o padrão.
 *
 * Fora da faixa cai no padrão em vez de ser grampeado: um `fieldOfView: 5000` não
 * é um 100 exagerado, é um valor que não veio do menu, e adivinhar a intenção de
 * um dado corrompido é pior que voltar ao conhecido. `Number.isFinite` cobre
 * `NaN` e os infinitos, que sobrevivem a um `JSON.parse` vindo de string.
 */
function readNumber(value: unknown, range: SettingRange, fallback: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback;
  return value >= range.min && value <= range.max ? value : fallback;
}

function sanitizePreferences(raw: unknown, defaults: PlayerPreferences): PlayerPreferences {
  const stored = (typeof raw === 'object' && raw !== null ? raw : {}) as Record<string, unknown>;
  const ranges = PREFERENCE_RANGES;

  // Campo a campo, e não `{ ...defaults, ...stored }`: o espalhamento deixaria
  // passar tanto os valores inválidos quanto chaves que já não existem.
  return {
    quality: readEnum(stored.quality, QUALITY_ORDER, defaults.quality),
    nickname: readString(stored.nickname, NICKNAME_MAX_LENGTH, defaults.nickname),
    mouseSensitivity: readNumber(
      stored.mouseSensitivity,
      ranges.mouseSensitivity,
      defaults.mouseSensitivity,
    ),
    gamepadSensitivity: readNumber(
      stored.gamepadSensitivity,
      ranges.gamepadSensitivity,
      defaults.gamepadSensitivity,
    ),
    gamepadDeadzone: readNumber(
      stored.gamepadDeadzone,
      ranges.gamepadDeadzone,
      defaults.gamepadDeadzone,
    ),
    invertY: readBoolean(stored.invertY, defaults.invertY),
    masterVolume: readNumber(stored.masterVolume, ranges.masterVolume, defaults.masterVolume),
    dayLengthMinutes: readNumber(
      stored.dayLengthMinutes,
      ranges.dayLengthMinutes,
      defaults.dayLengthMinutes,
    ),
    fieldOfView: readNumber(stored.fieldOfView, ranges.fieldOfView, defaults.fieldOfView),
    weather: readEnum(stored.weather, WEATHER_MODES, defaults.weather),
    showDebug: readBoolean(stored.showDebug, defaults.showDebug),
  };
}

function loadPreferences(): PlayerPreferences {
  let raw: unknown = null;
  try {
    const text = localStorage.getItem(STORAGE_KEY);
    if (text) raw = JSON.parse(text);
  } catch {
    // localStorage indisponível ou JSON corrompido: seguir com o padrão.
  }

  const defaults: PlayerPreferences = { ...DEFAULT_PREFERENCES };

  // A GPU só opina quando não há preset gravado **válido**. Um preset inválido
  // conta como ausente: é o mesmo caso de "não sei o que este jogador escolheu".
  const stored = (typeof raw === 'object' && raw !== null ? raw : {}) as Record<string, unknown>;
  const hasQuality =
    typeof stored.quality === 'string' &&
    (QUALITY_ORDER as readonly string[]).includes(stored.quality);
  if (!hasQuality) defaults.quality = detectPreset();

  return sanitizePreferences(raw, defaults);
}

class SettingsStore {
  readonly preferences: PlayerPreferences = loadPreferences();

  private listeners = new Set<(prefs: PlayerPreferences) => void>();
  private persistTimer: ReturnType<typeof setTimeout> | null = null;

  constructor() {
    // A gravação é adiada (ver `PERSIST_DEBOUNCE_MS`), então fechar a aba dentro
    // da janela de espera perderia o último ajuste. `pagehide` cobre o fechamento
    // e a navegação; `visibilitychange` cobre o celular indo para segundo plano,
    // que em iOS costuma ser o último evento que a página vê.
    window.addEventListener('pagehide', () => this.flush());
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'hidden') this.flush();
    });
  }

  get quality(): QualitySettings {
    return QUALITY_PRESETS[this.preferences.quality];
  }

  update(patch: Partial<PlayerPreferences>): void {
    Object.assign(this.preferences, patch);
    this.schedulePersist();
    for (const listener of this.listeners) listener(this.preferences);
  }

  onChange(listener: (prefs: PlayerPreferences) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** Grava agora o que estiver pendente. Chamada ao sair da página. */
  flush(): void {
    if (this.persistTimer === null) return;
    clearTimeout(this.persistTimer);
    this.persistTimer = null;
    this.persist();
  }

  private schedulePersist(): void {
    if (this.persistTimer !== null) clearTimeout(this.persistTimer);
    this.persistTimer = setTimeout(() => {
      this.persistTimer = null;
      this.persist();
    }, PERSIST_DEBOUNCE_MS);
  }

  private persist(): void {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(this.preferences));
    } catch {
      // Modo privado do navegador pode bloquear a escrita: não é fatal.
    }
  }
}

export const settings = new SettingsStore();
