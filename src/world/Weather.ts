/**
 * O tempo: o que o mar, o céu e o vento estão fazendo agora.
 *
 * ## Por que isto existe separado do resto do mundo
 *
 * Antes, o estado do mar era **uma constante**. O vento tinha uma direção e uma
 * intensidade escolhidas na inicialização e nunca mais mudavam, e todas as ondas
 * nasciam num leque estreito em torno dessa direção única. O resultado era o que
 * se via: um mar que vinha sempre do mesmo lado, com a mesma altura, do primeiro
 * ao último minuto de qualquer partida. Não havia por que olhar para o horizonte.
 *
 * Este módulo é a fonte única do que muda. Ele não desenha nada e não sabe o que
 * é uma onda — ele decide **números** (força e rumo do vento, cobertura de nuvem,
 * chuva, visibilidade) e o `Environment` os distribui para quem os consome. É a
 * mesma divisão que o `WaveField` faz com o oceano: um lugar decide, vários leem.
 *
 * ## A máquina de estados, e por que ela não é um sorteio a cada minuto
 *
 * Tempo real tem **inércia e sequência**. Não se passa de céu limpo para
 * temporal: passa-se por um vento que encrespa, uma nuvem que fecha, um aguaceiro
 * que engrossa. Uma cadeia de Markov com transições restritas dá exatamente isso
 * de graça — cada estado só alcança os vizinhos, então a escalada e a calmaria
 * acontecem em ordem, e o jogador aprende a ler o que vem antes de ele chegar.
 *
 * Cada transição leva minutos, não segundos: o que se vê é o mar **virando**, que
 * é o que dá ao horizonte alguma coisa para dizer.
 */

import { clamp01, createRandom, damp, smoothstep, TAU } from '../core/MathUtils';

export type WeatherId = 'clear' | 'breeze' | 'squall' | 'storm';

/** O alvo de cada grandeza num estado de tempo. */
interface WeatherPreset {
  /** Nome mostrado ao jogador. */
  readonly label: string;
  /** Intensidade do vento, 0..1 — o que escala amplitude e velocidade da onda. */
  readonly wind: number;
  /** Cobertura de nuvem, 0 (limpo) a 1 (encoberto). */
  readonly clouds: number;
  /** Densidade da chuva, 0..1. */
  readonly rain: number;
  /**
   * Alcance de visibilidade, em metros — a distância em que a névoa engole o
   * horizonte. Vira densidade em `Environment`; aqui é distância porque é o que
   * se pode conferir no olho, olhando o navio inimigo sumir.
   */
  readonly visibility: number;
  /** Rajadas por minuto. Zero em céu limpo, muitas no temporal. */
  readonly gusts: number;
  /** Relâmpagos por minuto. Só a tempestade tem. */
  readonly strikes: number;
  /** Duração do estado, em segundos: mínimo e máximo. */
  readonly duration: readonly [number, number];
  /** Para onde este tempo pode virar, com peso. */
  readonly next: readonly (readonly [WeatherId, number])[];
}

/**
 * Os quatro tempos.
 *
 * As durações são longas de propósito. Um duelo dura de três a cinco minutos, e
 * um clima que virasse a cada minuto transformaria o mar num piscar de estados em
 * vez de num lugar. Assim, a maioria das partidas acontece **dentro** de um
 * tempo, e virar o tempo no meio de uma é um acontecimento.
 */
const PRESETS: Record<WeatherId, WeatherPreset> = {
  clear: {
    label: 'Clear skies',
    wind: 0.34,
    clouds: 0.22,
    rain: 0,
    visibility: 4200,
    gusts: 0,
    strikes: 0,
    duration: [180, 420],
    next: [['breeze', 1]],
  },
  breeze: {
    label: 'Fresh wind',
    wind: 0.62,
    clouds: 0.46,
    rain: 0,
    visibility: 3200,
    gusts: 2,
    strikes: 0,
    duration: [200, 480],
    // O caminho de volta para o céu limpo é mais provável que o de subida: mar
    // grosso tem de ser exceção, senão deixa de significar alguma coisa.
    next: [
      ['clear', 2],
      ['squall', 1],
    ],
  },
  squall: {
    label: 'Squall',
    wind: 0.82,
    clouds: 0.78,
    rain: 0.55,
    visibility: 1500,
    gusts: 5,
    strikes: 0.4,
    duration: [120, 260],
    next: [
      ['breeze', 2],
      ['storm', 1],
    ],
  },
  storm: {
    label: 'Storm',
    wind: 1,
    clouds: 0.97,
    rain: 1,
    visibility: 750,
    gusts: 9,
    strikes: 6,
    duration: [110, 220],
    next: [['squall', 1]],
  },
};

/** Ordem crescente de mau tempo. Só serve para o rótulo de severidade. */
export const WEATHER_ORDER: readonly WeatherId[] = ['clear', 'breeze', 'squall', 'storm'];

/**
 * Constante de convergência das grandezas do tempo, em 1/s.
 *
 * 0,022 dá uma meia-vida de ~31 s: a virada leva cerca de dois minutos para se
 * completar. É lento o bastante para ninguém ver o valor "andando" e rápido o
 * bastante para caber numa partida.
 */
const BLEND_RATE = 0.022;

/**
 * Velocidade de rotação do vento, em radianos por segundo.
 *
 * O vento gira sempre, mesmo dentro de um único tempo, e é o que impede o mar de
 * vir eternamente do mesmo lado. 0,006 rad/s são 20° por minuto — perceptível
 * numa partida inteira, invisível de um instante para o outro.
 *
 * Girar de verdade em vez de sortear uma direção nova a cada tempo importa:
 * direção de vento é o que decide qual bordo é o rápido, e ela não pode saltar
 * embaixo de quem está no meio de uma manobra.
 */
const WIND_TURN_RATE = 0.006;

/** Duração de uma rajada, em segundos. */
const GUST_DURATION = 7;
/** Quanto uma rajada acrescenta à intensidade do vento. */
const GUST_STRENGTH = 0.16;

/** Duração do clarão de um relâmpago, em segundos. */
const FLASH_DURATION = 0.42;

export class Weather {
  /** O tempo que está no ar. */
  current: WeatherId;
  /** Para onde ele está indo. Igual a `current` quando já chegou. */
  target: WeatherId;

  /** Intensidade do vento agora, 0..1. Já com a rajada somada. */
  wind = 0;
  /** Rumo do vento, em radianos. Gira sozinho, sempre. */
  direction: number;
  /** Cobertura de nuvem, 0..1. */
  clouds = 0;
  /** Densidade da chuva, 0..1. */
  rain = 0;
  /** Alcance de visibilidade, em metros. */
  visibility = 4000;
  /** Clarão do relâmpago neste instante, 0..1. */
  flash = 0;
  /**
   * `true` congela a **virada** de tempo, não o tempo.
   *
   * O vento continua girando e as rajadas continuam vindo: o que a trava
   * promete ao jogador é "o mar fica assim", e um mar que fica *exatamente*
   * assim, sem nem uma rajada, deixaria de ser mar.
   */
  locked = false;

  /** Segundos até a próxima virada de tempo. */
  private countdown = 0;
  /** Base do vento sem a rajada — é ela que converge para o preset. */
  private baseWind = 0;
  private gust = 0;
  private gustTimer = 0;
  private flashTimer = 0;
  private random: () => number;

  constructor(seed = 90210, start: WeatherId = 'breeze', direction = 0.7) {
    this.random = createRandom(seed);
    this.current = start;
    this.target = start;
    this.direction = direction;

    const preset = PRESETS[start];
    this.baseWind = preset.wind;
    this.wind = preset.wind;
    this.clouds = preset.clouds;
    this.rain = preset.rain;
    this.visibility = preset.visibility;
    this.countdown = this.rollDuration(preset);
  }

  /**
   * Recomeça o tempo a partir de uma semente dada.
   *
   * Existe para o duelo em rede: o vento entra na força da vela, então dois
   * jogadores com climas diferentes teriam velocidades diferentes no mesmo rumo —
   * e isso é vantagem, não enfeite. A mesma semente dá a mesma sequência de
   * rajadas, relâmpagos e viradas nas duas máquinas.
   */
  reseed(seed: number, start: WeatherId = 'breeze'): void {
    this.random = createRandom(seed);
    this.current = start;
    this.target = start;
    this.locked = false;

    const preset = PRESETS[start];
    this.baseWind = preset.wind;
    this.wind = preset.wind;
    this.clouds = preset.clouds;
    this.rain = preset.rain;
    this.visibility = preset.visibility;
    this.gust = 0;
    this.gustTimer = 0;
    this.flash = 0;
    this.flashTimer = 0;
    this.countdown = this.rollDuration(preset);
  }

  /** Nome do tempo, para o HUD. Diz para onde vai quando está virando. */
  get label(): string {
    if (this.target === this.current) return PRESETS[this.current].label;
    return `${PRESETS[this.current].label} → ${PRESETS[this.target].label}`;
  }

  /** Quão severo está o tempo, de 0 (limpo) a 1 (temporal). */
  get severity(): number {
    return clamp01((this.baseWind - PRESETS.clear.wind) / (1 - PRESETS.clear.wind));
  }

  /**
   * Um passo de tempo. Roda no passo fixo da física, junto com o mar: a
   * intensidade do vento entra na força da vela, e força de vela tem de ser
   * determinística.
   */
  fixedUpdate(dt: number): void {
    if (!this.locked) {
      this.countdown -= dt;
      if (this.countdown <= 0) this.roll();
    }

    const preset = PRESETS[this.target];

    // As grandezas convergem para o alvo em vez de saltar. Quem estiver
    // navegando durante a virada vê o mar crescer debaixo do casco.
    this.baseWind = damp(this.baseWind, preset.wind, BLEND_RATE, dt);
    this.clouds = damp(this.clouds, preset.clouds, BLEND_RATE, dt);
    this.rain = damp(this.rain, preset.rain, BLEND_RATE, dt);
    this.visibility = damp(this.visibility, preset.visibility, BLEND_RATE, dt);

    // Chegou perto o bastante: o tempo de destino passa a ser o tempo atual, e o
    // relógio da próxima virada começa a correr.
    if (this.target !== this.current && Math.abs(this.baseWind - preset.wind) < 0.02) {
      this.current = this.target;
      this.countdown = this.rollDuration(preset);
    }

    this.direction = (this.direction + WIND_TURN_RATE * dt) % TAU;

    this.updateGusts(dt, preset);
    this.updateLightning(dt, preset);
  }

  /**
   * Rajadas: um empurrão curto no vento, com subida e descida suaves.
   *
   * Não é ruído decorativo. A rajada é a única coisa no jogo que muda a
   * velocidade dos dois navios ao mesmo tempo sem que nenhum dos dois tenha
   * feito nada — e é ela que faz uma perseguição empatada por física ganhar
   * momentos em que a distância abre e fecha sozinha.
   */
  private updateGusts(dt: number, preset: WeatherPreset): void {
    if (this.gustTimer > 0) {
      this.gustTimer -= dt;
      const k = 1 - Math.abs((this.gustTimer / GUST_DURATION) * 2 - 1);
      this.gust = smoothstep(0, 1, k) * GUST_STRENGTH;
    } else {
      this.gust = 0;
      // Um sorteio por segundo de jogo, escalado pela taxa do preset.
      if (preset.gusts > 0 && this.random() < (preset.gusts / 60) * dt) {
        this.gustTimer = GUST_DURATION;
      }
    }

    this.wind = clamp01(this.baseWind + this.gust);
  }

  /** Relâmpagos: um clarão curto que lava a cena inteira de branco-azulado. */
  private updateLightning(dt: number, preset: WeatherPreset): void {
    if (this.flashTimer > 0) {
      this.flashTimer -= dt;
      // Decaimento rápido com um repique: raio não é um pulso quadrado, é um
      // estouro que pisca duas ou três vezes em menos de meio segundo.
      const k = clamp01(this.flashTimer / FLASH_DURATION);
      this.flash = k * k * (0.6 + 0.4 * Math.abs(Math.sin(k * 22)));
      return;
    }

    this.flash = 0;
    if (preset.strikes > 0 && this.random() < (preset.strikes / 60) * dt) {
      this.flashTimer = FLASH_DURATION;
    }
  }

  /** Escolhe o próximo tempo pela cadeia de transições. */
  private roll(): void {
    const options = PRESETS[this.current].next;
    let total = 0;
    for (const [, weight] of options) total += weight;

    let pick = this.random() * total;
    for (const [id, weight] of options) {
      pick -= weight;
      if (pick <= 0) {
        this.target = id;
        // O relógio só reinicia quando a virada **termina**; até lá ele fica
        // parado, senão um tempo poderia ser trocado no meio da própria entrada.
        this.countdown = Number.POSITIVE_INFINITY;
        return;
      }
    }
  }

  private rollDuration(preset: WeatherPreset): number {
    const [min, max] = preset.duration;
    return min + this.random() * (max - min);
  }

  /** Força um tempo, sem transição. Usado pela bancada e pelo menu de ajustes. */
  set(id: WeatherId): void {
    const preset = PRESETS[id];
    this.current = id;
    this.target = id;
    this.baseWind = preset.wind;
    this.wind = preset.wind;
    this.clouds = preset.clouds;
    this.rain = preset.rain;
    this.visibility = preset.visibility;
    this.countdown = this.rollDuration(preset);
    this.gust = 0;
    this.gustTimer = 0;
    this.flash = 0;
    this.flashTimer = 0;
  }
}
