/**
 * Utilitários matemáticos usados pela física, câmera e IA.
 *
 * Tudo aqui é independente de framerate: funções de suavização recebem `dt`
 * e usam decaimento exponencial em vez de `lerp(a, b, 0.1)`, que muda de
 * comportamento conforme o FPS varia.
 */

export const TAU = Math.PI * 2;
export const DEG = Math.PI / 180;
export const RAD = 180 / Math.PI;

/** Gravidade em m/s². Usada pela balística e pelo empuxo. */
export const GRAVITY = 9.81;

/** Densidade da água do mar em kg/m³. */
export const WATER_DENSITY = 1025;

/** Densidade do ar em kg/m³, usada pela força da vela e pelo arrasto da bala. */
export const AIR_DENSITY = 1.225;

export function clamp(v: number, min: number, max: number): number {
  return v < min ? min : v > max ? max : v;
}

export function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

export function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

export function invLerp(a: number, b: number, v: number): number {
  return a === b ? 0 : (v - a) / (b - a);
}

export function remap(v: number, inMin: number, inMax: number, outMin: number, outMax: number): number {
  return lerp(outMin, outMax, clamp01(invLerp(inMin, inMax, v)));
}

export function smoothstep(edge0: number, edge1: number, x: number): number {
  const t = clamp01(invLerp(edge0, edge1, x));
  return t * t * (3 - 2 * t);
}

/**
 * Suavização exponencial independente de framerate.
 * `lambda` é a taxa de decaimento: quanto maior, mais rápido converge.
 * Equivale a um lerp que se comporta igual em 30 ou 144 FPS.
 */
export function damp(current: number, target: number, lambda: number, dt: number): number {
  return lerp(target, current, Math.exp(-lambda * dt));
}

/** Move `current` na direção de `target` no máximo `maxDelta`. */
export function moveTowards(current: number, target: number, maxDelta: number): number {
  const diff = target - current;
  if (Math.abs(diff) <= maxDelta) return target;
  return current + Math.sign(diff) * maxDelta;
}

/** Normaliza um ângulo em radianos para o intervalo (-π, π]. */
export function wrapAngle(a: number): number {
  a = (a + Math.PI) % TAU;
  if (a < 0) a += TAU;
  return a - Math.PI;
}

/** Menor diferença angular entre dois ângulos, no intervalo (-π, π]. */
export function angleDelta(from: number, to: number): number {
  return wrapAngle(to - from);
}

/**
 * Aplica zona morta radial a um par de eixos de analógico e recurva a resposta.
 * Radial (e não por eixo) evita o clássico "canto quadrado" que faz a mira
 * acelerar nas diagonais.
 */
export function applyDeadzone(x: number, y: number, deadzone: number, exponent = 2): [number, number] {
  const mag = Math.hypot(x, y);
  if (mag < deadzone) return [0, 0];
  const normalized = clamp01((mag - deadzone) / (1 - deadzone));
  const curved = Math.pow(normalized, exponent);
  const scale = curved / mag;
  return [x * scale, y * scale];
}

/**
 * Controlador PID discreto, usado pelo timoneiro bot para manter um rumo.
 * Guarda estado interno, então cada instância serve a um único alvo.
 */
export class PID {
  private integral = 0;
  private previousError = 0;
  private initialized = false;

  constructor(
    public kp: number,
    public ki: number,
    public kd: number,
    /** Limita o acúmulo do termo integral para evitar windup. */
    public integralLimit = 1,
  ) {}

  update(error: number, dt: number): number {
    if (dt <= 0) return 0;

    this.integral = clamp(this.integral + error * dt, -this.integralLimit, this.integralLimit);

    // Na primeira chamada não há derivada válida; usar 0 evita um pico inicial.
    const derivative = this.initialized ? (error - this.previousError) / dt : 0;
    this.previousError = error;
    this.initialized = true;

    return this.kp * error + this.ki * this.integral + this.kd * derivative;
  }

  reset(): void {
    this.integral = 0;
    this.previousError = 0;
    this.initialized = false;
  }
}

/**
 * Gerador pseudoaleatório determinístico (mulberry32).
 * Usado para que ondas, decoração e erro de mira da IA sejam reproduzíveis
 * entre partidas — essencial para depurar física.
 */
export function createRandom(seed: number): () => number {
  let a = seed >>> 0;
  return function random(): number {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Amostra de uma normal padrão via Box-Muller, para erro de mira da IA. */
export function gaussian(random: () => number): number {
  let u = 0;
  let v = 0;
  while (u === 0) u = random();
  while (v === 0) v = random();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(TAU * v);
}

/** Converte metros por segundo para nós (usado no HUD). */
export function msToKnots(ms: number): number {
  return ms * 1.943844;
}
