/**
 * Graphics presets and player preferences.
 *
 * The preset is detected automatically on the first run from the WebGL renderer the
 * GPU reports, and can be changed in the menu afterwards. Everything is persisted in
 * localStorage.
 */

export type QualityPreset = 'low' | 'medium' | 'high' | 'ultra';

/**
 * The presets in the order they appear in the menu, from lightest to heaviest.
 *
 * It exists so the menu and the `localStorage` validator do not each write the list
 * on their own: a new preset goes in here and both adjust.
 */
export const QUALITY_ORDER: readonly QualityPreset[] = ['low', 'medium', 'high', 'ultra'];

export interface QualitySettings {
  /** Render resolution multiplier (1 = native, capped by devicePixelRatio). */
  renderScale: number;
  /** Resolution of the directional light's shadow map. 0 switches shadows off. */
  shadowMapSize: number;
  /**
   * Concentric rings of the ocean mesh. The radii grow geometrically, so every extra
   * ring raises the density over the whole extent, not only nearby — the triangle
   * always keeps the same apparent size.
   *
   * Rings and segments are chosen together so that the radial step
   * (`radius × (growth − 1)`) stays close to the angular step
   * (`radius × 2π/segments`). Roughly equilateral triangles filter waves better than
   * long slivers with the same triangle count.
   */
  oceanRings: number;
  /** Angular divisions of the ocean (how many "gores" each ring has). */
  oceanSegments: number;
  //
  // ⚠️ Do **not** put `waveCount` back in here.
  //
  // It existed, varying from 4 to 6 depending on the preset, and it was a two-faced
  // defect. The visible one: dragging the quality slider regenerated the wave field
  // mid-match, and a shot in flight landed on a sea that was not the one it had been
  // fired from. The invisible one, and worse: the sea is simulation, not decoration —
  // two players on different presets would sail different seas, with different
  // buoyancy forces, in the same room. The field now always has the six waves, and
  // what does the work of easing a weak machine is the ocean's `waveFilterWeight`,
  // which is where that work belongs. The cost on the Low preset is two extra
  // iterations in a vertex shader loop.
  //
  /** Resolution of the wake foam's render target. */
  wakeResolution: number;
  bloom: boolean;
  godRays: boolean;
  /**
   * God-ray samples, per pixel.
   *
   * It is the most expensive parameter in the post-processing chain: every sample is
   * one texture read per pixel, and the pass runs at full resolution. The difference
   * between 32 and 48 samples is very slight banding in the sun's fringes — visible
   * in a side-by-side comparison and in no other situation — and it costs a third of
   * the effect's cost. That is why the High preset settled at 32 and only Ultra pays
   * the 48.
   */
  godRaySamples: number;
  /** SMAA antialiasing in the composer. */
  smaa: boolean;
  /**
   * Environment map prefiltered from the sky.
   *
   * It is what gives the ship's metals and glass their reflections — without it the
   * brass and the iron only exist where the sun hits. Switched off on the Low preset,
   * where the hemisphere light goes back to full intensity to cover the diffuse on its
   * own.
   */
  skyEnvironment: boolean;
  /** Splash and smoke particles per event. */
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
    godRaySamples: 0,
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
    godRaySamples: 0,
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
    godRaySamples: 32,
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
    godRaySamples: 48,
    smaa: true,
    skyEnvironment: true,
    particleBudget: 160,
  },
};

/**
 * How the weather behaves in a match.
 *
 * `dynamic` lets `Weather`'s state machine run; any other value locks the weather in
 * that state. Locking exists for two legitimate reasons: whoever wants to practice
 * gunnery on a predictable sea, and whoever wants to *see* the storm without waiting
 * for the chain of transitions to reach it.
 */
export type WeatherMode = 'dynamic' | 'clear' | 'breeze' | 'squall' | 'storm';

/** The weather modes in menu order. Same reason as `QUALITY_ORDER`. */
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
   * The name the opponent sees in an online duel.
   *
   * It lives here, and not in a `localStorage` key of its own, because this is the
   * only place in the project with external input validation, deferred writing and a
   * flush on `pagehide` — three things a loose `getItem('nickname')` would have to
   * repeat.
   */
  nickname: string;
  /** Mouse sensitivity, a multiplier over the base. */
  mouseSensitivity: number;
  /** Right stick sensitivity. */
  gamepadSensitivity: number;
  gamepadDeadzone: number;
  invertY: boolean;
  masterVolume: number;
  /** Length of a full in-game day, in real minutes. */
  dayLengthMinutes: number;
  /** Field of view on foot, in degrees. */
  fieldOfView: number;
  /** Fixed weather, or `dynamic` to let it turn on its own. */
  weather: WeatherMode;
  /** Shows the physics telemetry overlay (F3). */
  showDebug: boolean;
}

/** A numeric setting's range: what the slider offers and what validation accepts. */
export interface SettingRange {
  min: number;
  max: number;
  /** The slider's step — and also the d-pad's step in pad navigation. */
  step: number;
}

/** Numeric preferences, the only ones that need a range. */
export type RangedPreference =
  | 'masterVolume'
  | 'mouseSensitivity'
  | 'gamepadSensitivity'
  | 'gamepadDeadzone'
  | 'dayLengthMinutes'
  | 'fieldOfView';

/**
 * The numeric settings' ranges, **in one place only**.
 *
 * The menu builds the sliders from here and the `localStorage` validator checks
 * against the same table. Repeating the numbers on both sides is how a
 * `fieldOfView: 5000` written by an old version survives a range that shrank later:
 * the menu limits what the player chooses *now*, but whatever comes in through
 * storage passes through no slider at all.
 *
 * About the field of view: here the range is 55–100 and
 * `PlayerController.setFieldOfView` clamps to 45–110. The difference is intentional
 * and the direction matters — this range lives **inside** the controller's, so no
 * value accepted here reaches it to be silently altered. Whoever widens this has to
 * check the margin on the other side first.
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
 * Wait before writing the preferences, in milliseconds.
 *
 * A slider emits one `input` per pixel dragged. Without this margin, crossing the
 * volume bar serializes and writes the whole object dozens of times — and
 * `localStorage.setItem` is synchronous, so each of those writes happens inside the
 * frame. The player loses nothing to the delay: the value is already in memory and
 * has already been applied; what waits is only the copy on disk.
 */
const PERSIST_DEBOUNCE_MS = 250;

/**
 * Nickname ceiling, in characters.
 *
 * Sixteen is what fits on the opponent card without wrapping at the smallest
 * supported screen width, and it is the same number the room server clamps to —
 * whoever trims it has to trim both sides, or the name the opponent sees stops being
 * the name its owner typed.
 */
export const NICKNAME_MAX_LENGTH = 16;

/** A starter nickname, so nobody has to invent one before playing. */
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
 * Guesses a preset from the GPU's renderer string.
 *
 * It is a crude heuristic on purpose: it errs on the safe side and the player can go
 * up in the menu. It only serves the first run.
 *
 * The order of the tests is the most important correction in here. Testing the
 * integrated ones first seems reasonable and is wrong, because the strings overlap: a
 * laptop hybrid reports something like "Intel(R) UHD Graphics / NVIDIA GeForce RTX
 * 4060", and a machine with an RTX was locked to `medium` just for having the word
 * "Intel" in its name. Discrete first, integrated last — the more specific test wins.
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

    // Top-end discrete cards.
    if (/(rtx (40|50)|rx (7[6-9]|9[0-9])00|apple m[2-9] (max|ultra))/.test(gpu)) {
      return 'ultra';
    }
    // Discrete in general (includes the target RX 6600 and the Arc, which carries
    // "intel" in its name).
    if (/(rtx|gtx|radeon rx|arc a\d)/.test(gpu)) {
      return 'high';
    }
    // Known integrated ones: `low`, which is what this list's comment always said
    // and the code did not do — it returned `medium`, the same as the "I do not know"
    // case, which made the whole test decorative. A UHD 630 does not run this ocean
    // at `medium`, and going up a preset in the menu costs two clicks; working out
    // why the game opens at 12 fps costs the session.
    //
    // The pattern lost the loose space that used to precede `radeon graphics`: with
    // it, the brand only matched when preceded by a space, and a string that
    // **started** with "Radeon Graphics" escaped.
    if (/(intel|uhd graphics|iris|vega \d|radeon graphics|adreno|mali|apple a\d)/.test(gpu)) {
      return 'low';
    }
    return 'medium';
  } catch {
    return 'medium';
  }
}

// --- validating what comes out of storage ------------------------------------
//
// `localStorage` is external input like any other: the player can edit it in the
// console, an extension can corrupt it and an earlier version of the game may have
// written a format that no longer exists. Without validation, a `quality: "potato"`
// becomes `QUALITY_PRESETS["potato"] === undefined` and the first access to
// `quality.shadowMapSize` in the `Renderer` brings the whole boot down — a black
// screen, with no menu to fix it from. Every field falls back to the default when it
// does not pass.

function readEnum<T extends string>(value: unknown, allowed: readonly T[], fallback: T): T {
  return typeof value === 'string' && (allowed as readonly string[]).includes(value)
    ? (value as T)
    : fallback;
}

function readBoolean(value: unknown, fallback: boolean): boolean {
  return typeof value === 'boolean' ? value : fallback;
}

/**
 * Short, presentable text, or the default.
 *
 * Unlike `readNumber`, this **sanitizes instead of rejecting**: a nickname with one
 * extra space at the end is the same nickname, and returning "Sailor427" to somebody
 * who typed "  Blackbeard  " would trade the player's intent for a typo. What does
 * not survive are the control characters — including the text-direction ones, which
 * visually reorder the rest of a line and are the classic way for a name to falsify
 * what is written beside it.
 */
export function readString(value: unknown, maxLength: number, fallback: string): string {
  if (typeof value !== 'string') return fallback;
  const cleaned = value
    // C0/C1 controls, zero width, bidirectional marks and isolates, and the BOM.
    .replace(/[\u0000-\u001F\u007F-\u009F\u200B-\u200F\u2028-\u202E\u2066-\u2069\uFEFF]/g, '')
    // Runs of spaces become one: "Black      beard" is the same name, written to take
    // up the width of two.
    .replace(/\s+/g, ' ')
    .trim();
  return cleaned.length > 0 ? cleaned.slice(0, maxLength) : fallback;
}

/**
 * A number inside the range, or the default.
 *
 * Out of range it falls back to the default instead of being clamped: a
 * `fieldOfView: 5000` is not an exaggerated 100, it is a value that did not come from
 * the menu, and guessing the intent of corrupted data is worse than going back to
 * what is known. `Number.isFinite` covers `NaN` and the infinities, which survive a
 * `JSON.parse` from a string.
 */
function readNumber(value: unknown, range: SettingRange, fallback: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback;
  return value >= range.min && value <= range.max ? value : fallback;
}

function sanitizePreferences(raw: unknown, defaults: PlayerPreferences): PlayerPreferences {
  const stored = (typeof raw === 'object' && raw !== null ? raw : {}) as Record<string, unknown>;
  const ranges = PREFERENCE_RANGES;

  // Field by field, and not `{ ...defaults, ...stored }`: the spread would let
  // through both the invalid values and keys that no longer exist.
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
    // localStorage unavailable or corrupted JSON: carry on with the default.
  }

  const defaults: PlayerPreferences = { ...DEFAULT_PREFERENCES };

  // The GPU only gets a say when there is no **valid** preset stored. An invalid
  // preset counts as absent: it is the same case as "I do not know what this player
  // chose".
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
    // The write is deferred (see `PERSIST_DEBOUNCE_MS`), so closing the tab inside
    // the wait window would lose the last change. `pagehide` covers closing and
    // navigation; `visibilitychange` covers a phone going into the background, which
    // on iOS is usually the last event the page ever sees.
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

  /** Writes whatever is pending right now. Called on leaving the page. */
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
      // The browser's private mode can block the write: it is not fatal.
    }
  }
}

export const settings = new SettingsStore();
