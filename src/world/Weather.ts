/**
 * The weather: what the sea, the sky and the wind are doing right now.
 *
 * ## Why this exists separately from the rest of the world
 *
 * The sea's state used to be **a constant**. The wind had a direction and a strength
 * chosen at initialization and never changed again, and every wave was born in a narrow
 * fan around that single direction. The result was what you saw: a sea that always came
 * from the same side, at the same height, from the first to the last minute of any
 * match. There was no reason to look at the horizon.
 *
 * This module is the single source of what changes. It draws nothing and does not know
 * what a wave is — it decides **numbers** (wind strength and heading, cloud cover, rain,
 * visibility) and `Environment` distributes them to whoever consumes them. It is the
 * same split `WaveField` makes with the ocean: one place decides, several read.
 *
 * ## The state machine, and why it is not a draw every minute
 *
 * Real weather has **inertia and sequence**. You do not go from clear skies to a storm:
 * you go through a wind that ruffles, a cloud that closes in, a downpour that thickens.
 * A Markov chain with restricted transitions gives exactly that for free — each state
 * only reaches its neighbors, so the build-up and the calming happen in order, and the
 * player learns to read what is coming before it arrives.
 *
 * Every transition takes minutes, not seconds: what you see is the sea **turning**,
 * which is what gives the horizon something to say.
 */

import { clamp01, createRandom, damp, smoothstep, TAU } from '../core/MathUtils';

export type WeatherId = 'clear' | 'breeze' | 'squall' | 'storm';

/** Each quantity's target in one weather state. */
interface WeatherPreset {
  /** The name shown to the player. */
  readonly label: string;
  /** Wind strength, 0..1 — what scales the wave's amplitude and speed. */
  readonly wind: number;
  /** Cloud cover, 0 (clear) to 1 (overcast). */
  readonly clouds: number;
  /** Rain density, 0..1. */
  readonly rain: number;
  /**
   * Visibility range, in meters — the distance at which the haze swallows the horizon.
   * It becomes a density in `Environment`; here it is a distance because that is what
   * you can check by eye, watching the enemy ship disappear.
   */
  readonly visibility: number;
  /** Gusts per minute. Zero in clear skies, many in a storm. */
  readonly gusts: number;
  /** Lightning strikes per minute. Only the storm has them. */
  readonly strikes: number;
  /** The state's duration, in seconds: minimum and maximum. */
  readonly duration: readonly [number, number];
  /** Where this weather can turn to, with a weight. */
  readonly next: readonly (readonly [WeatherId, number])[];
}

/**
 * The four weathers.
 *
 * The durations are long on purpose. A duel lasts three to five minutes, and a climate
 * that turned every minute would make the sea a flicker of states instead of a place.
 * This way most matches happen **inside** one weather, and the weather turning in the
 * middle of one is an event.
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
    // The road back to clear skies is likelier than the one up: heavy seas have to be
    // the exception, or they stop meaning anything.
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

/** Increasing order of bad weather. It only serves the severity label. */
export const WEATHER_ORDER: readonly WeatherId[] = ['clear', 'breeze', 'squall', 'storm'];

/**
 * Convergence constant of the weather's quantities, in 1/s.
 *
 * 0.022 gives a half-life of ~31 s: the turn takes about two minutes to complete. It is
 * slow enough that nobody sees the value "moving" and fast enough to fit inside a match.
 */
const BLEND_RATE = 0.022;

/**
 * The wind's rate of rotation, in radians per second.
 *
 * The wind always turns, even inside a single weather, and it is what keeps the sea from
 * coming eternally from the same side. 0.006 rad/s is 20° per minute — noticeable over a
 * whole match, invisible from one instant to the next.
 *
 * Really turning instead of drawing a new direction with every weather matters: wind
 * direction is what decides which tack is the fast one, and it cannot jump out from under
 * somebody in the middle of a maneuver.
 */
const WIND_TURN_RATE = 0.006;

/** A gust's duration, in seconds. */
const GUST_DURATION = 7;
/** How much a gust adds to the wind's strength. */
const GUST_STRENGTH = 0.16;

/** Duration of a lightning flash, in seconds. */
const FLASH_DURATION = 0.42;

export class Weather {
  /** The weather that is up. */
  current: WeatherId;
  /** Where it is heading. Equal to `current` once it has arrived. */
  target: WeatherId;

  /** Wind strength right now, 0..1. With the gust already added. */
  wind = 0;
  /** Wind heading, in radians. It turns on its own, always. */
  direction: number;
  /** Cloud cover, 0..1. */
  clouds = 0;
  /** Rain density, 0..1. */
  rain = 0;
  /** Visibility range, in meters. */
  visibility = 4000;
  /** The lightning flash at this instant, 0..1. */
  flash = 0;
  /**
   * `true` freezes the weather's **turning**, not the weather.
   *
   * The wind goes on turning and the gusts go on coming: what the lock promises the
   * player is "the sea stays like this", and a sea that stays *exactly* like this,
   * without even a gust, would stop being a sea.
   */
  locked = false;

  /** Seconds until the next weather change. */
  private countdown = 0;
  /** The wind's base without the gust — it is what converges toward the preset. */
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
   * Restarts the weather from a given seed.
   *
   * It exists for the networked duel: the wind enters the sail's force, so two players
   * with different climates would have different speeds on the same heading — and that is
   * an advantage, not decoration. The same seed gives the same sequence of gusts,
   * lightning and changes on both machines.
   */
  reseed(seed: number, start: WeatherId = 'breeze'): void {
    this.random = createRandom(seed);
    this.current = start;
    this.target = start;
    this.locked = false;

    // ⚠️ **The wind's heading enters the arithmetic, and it used to be left out.**
    //
    // It turns on its own from the moment the page opens (see `WIND_TURN_RATE`), so two
    // players who spent different amounts of time on the title screen arrived at the
    // duel with different headings. The snapshot corrects the wind's — but the
    // **background swell's** heading is born from it, once, inside `WaveField.generate`,
    // and from there on the two seas were different. Seeding the heading here, from the
    // same number that seeds everything, is what makes "the same seed gives the same
    // sea" true from the first frame, and not only from the first snapshot.
    this.direction = (createRandom(seed ^ 0x571d)() * TAU) % TAU;

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

  /**
   * Writes the weather that arrived ready from the other side of the wire.
   *
   * ## Why receive it instead of simulating it
   *
   * The state machine in here is seeded and deterministic, so in theory both sides of a
   * duel could run it in parallel and arrive at the same weather. In practice they
   * cannot: it advances by summing `dt` in floating point, and the client that does not
   * simulate **loses steps by construction** — the engine discards the excess when the
   * tab hitches, which is right for the local physics and fatal for a shared clock. One
   * second of drift on a `countdown` of two hundred is the difference between watching
   * the storm arrive and staying under a clear sky while the opponent is already in the
   * middle of it.
   *
   * By receiving it, the weather is the same by construction, and the cost is ten bytes
   * per snapshot.
   *
   * ⚠️ **`baseWind` comes in with it, and it is not a detail:** it is where `severity`
   * comes from, and severity in turn tints cloud, haze and the whole scene's light.
   * Without it, the guest would receive the rain and carry on under a fine day's sky.
   *
   * What does **not** come in is the gusted wind (`wind`) and the heading (`direction`):
   * both already travel in the snapshot as properties of the sea, because it is the sea
   * that consumes them. The caller here passes both along so the HUD has something to
   * show.
   */
  applyRemote(state: {
    current: WeatherId;
    target: WeatherId;
    baseWind: number;
    clouds: number;
    rain: number;
    visibility: number;
    flash: number;
    wind: number;
    direction: number;
  }): void {
    this.current = state.current;
    this.target = state.target;
    this.baseWind = state.baseWind;
    this.clouds = state.clouds;
    this.rain = state.rain;
    this.visibility = state.visibility;
    this.flash = state.flash;
    this.wind = state.wind;
    this.direction = state.direction;
  }

  /** The weather's name, for the HUD. It says where it is heading while it turns. */
  get label(): string {
    if (this.target === this.current) return PRESETS[this.current].label;
    return `${PRESETS[this.current].label} → ${PRESETS[this.target].label}`;
  }

  /**
   * The wind **without** the gust, which is the quantity that chases the preset.
   *
   * Exposed for reading because the snapshot carries it: it is where `severity` comes
   * from, and without it the other side would receive the right rain and cloud under a
   * fine day's light. See `applyRemote`.
   */
  get windBase(): number {
    return this.baseWind;
  }

  /** How severe the weather is, from 0 (clear) to 1 (storm). */
  get severity(): number {
    return clamp01((this.baseWind - PRESETS.clear.wind) / (1 - PRESETS.clear.wind));
  }

  /**
   * One weather step. It runs on the physics' fixed step, along with the sea: the wind's
   * strength enters the sail's force, and sail force has to be deterministic.
   */
  fixedUpdate(dt: number): void {
    if (!this.locked) {
      this.countdown -= dt;
      if (this.countdown <= 0) this.roll();
    }

    const preset = PRESETS[this.target];

    // The quantities converge toward the target instead of jumping. Whoever is sailing
    // during the change watches the sea grow under the hull.
    this.baseWind = damp(this.baseWind, preset.wind, BLEND_RATE, dt);
    this.clouds = damp(this.clouds, preset.clouds, BLEND_RATE, dt);
    this.rain = damp(this.rain, preset.rain, BLEND_RATE, dt);
    this.visibility = damp(this.visibility, preset.visibility, BLEND_RATE, dt);

    // Close enough: the destination weather becomes the current one, and the clock for
    // the next change starts running.
    if (this.target !== this.current && Math.abs(this.baseWind - preset.wind) < 0.02) {
      this.current = this.target;
      this.countdown = this.rollDuration(preset);
    }

    this.direction = (this.direction + WIND_TURN_RATE * dt) % TAU;

    this.updateGusts(dt, preset);
    this.updateLightning(dt, preset);
  }

  /**
   * Gusts: a short push on the wind, with a smooth rise and fall.
   *
   * It is not decorative noise. The gust is the only thing in the game that changes both
   * ships' speed at once without either of them having done anything — and it is what
   * gives a chase that physics has tied moments where the distance opens and closes on
   * its own.
   */
  private updateGusts(dt: number, preset: WeatherPreset): void {
    if (this.gustTimer > 0) {
      this.gustTimer -= dt;
      const k = 1 - Math.abs((this.gustTimer / GUST_DURATION) * 2 - 1);
      this.gust = smoothstep(0, 1, k) * GUST_STRENGTH;
    } else {
      this.gust = 0;
      // One draw per game second, scaled by the preset's rate.
      if (preset.gusts > 0 && this.random() < (preset.gusts / 60) * dt) {
        this.gustTimer = GUST_DURATION;
      }
    }

    this.wind = clamp01(this.baseWind + this.gust);
  }

  /** Lightning: a short flash that washes the whole scene bluish-white. */
  private updateLightning(dt: number, preset: WeatherPreset): void {
    if (this.flashTimer > 0) {
      this.flashTimer -= dt;
      // Fast decay with a flicker: a bolt is not a square pulse, it is a burst that
      // blinks two or three times in under half a second.
      const k = clamp01(this.flashTimer / FLASH_DURATION);
      this.flash = k * k * (0.6 + 0.4 * Math.abs(Math.sin(k * 22)));
      return;
    }

    this.flash = 0;
    if (preset.strikes > 0 && this.random() < (preset.strikes / 60) * dt) {
      this.flashTimer = FLASH_DURATION;
    }
  }

  /** Picks the next weather from the chain of transitions. */
  private roll(): void {
    const options = PRESETS[this.current].next;
    let total = 0;
    for (const [, weight] of options) total += weight;

    let pick = this.random() * total;
    for (const [id, weight] of options) {
      pick -= weight;
      if (pick <= 0) {
        this.target = id;
        // The clock only restarts when the change **finishes**; until then it stays
        // still, or a weather could be swapped in the middle of its own arrival.
        this.countdown = Number.POSITIVE_INFINITY;
        return;
      }
    }
  }

  private rollDuration(preset: WeatherPreset): number {
    const [min, max] = preset.duration;
    return min + this.random() * (max - min);
  }

  /** Forces a weather, with no transition. Used by the bench and by the settings menu. */
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
