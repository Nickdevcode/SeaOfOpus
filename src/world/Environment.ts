/**
 * The world: sea, sky, time of day and light, stitched into a single object.
 *
 * It exists so the rest of the game does not have to know the water's reflection comes
 * out of the same LUT the sky draws, nor that the scene's fog has to follow the
 * horizon's color. Whoever is outside only calls `fixedUpdate` on the physics step,
 * `update` on the frame, and `sampleHeight` when they want to know where the water is.
 */

import * as THREE from 'three';
import type { QualitySettings, WeatherMode } from '../core/Settings';
import { DayNightCycle } from './DayNightCycle';
import { Ocean } from './Ocean';
import { Rain } from './Rain';
import { Sky } from './Sky';
import { SkyEnvironment } from './SkyEnvironment';
import { MAX_WAVES, WaveField } from './WaveField';
import { Weather } from './Weather';

/**
 * How far the hemisphere light drops when the IBL comes in.
 *
 * The two represent the same thing — the light arriving from every direction that is not
 * the sun — and adding them in full washes the shadows out. It is not zero because the
 * hemisphere light still does a job the IBL does not: it also comes from below, with the
 * sea's color, and it is what keeps the hold from closing to black.
 */
const AMBIENT_WITH_IBL = 0.4;

/** Color of the lightning flash — white pulling toward the discharge's cold blue. */
const LIGHTNING_COLOR = new THREE.Color(0.82, 0.88, 1);
/** Horizon color with the weather closed in: lead, faintly green. */
const STORM_HORIZON = new THREE.Color(0.29, 0.31, 0.33);

export interface EnvironmentOptions {
  /** Length of a full day, in real minutes. */
  dayLengthMinutes?: number;
  /** Starting time, 0..1 (0.34 ≈ mid-morning). */
  startTimeOfDay?: number;
  /** Seed for the wave spectrum — the same seed gives the same sea. */
  seed?: number;
  windDirection?: number;
  windStrength?: number;
}

export class Environment {
  readonly scene: THREE.Scene;
  readonly waveField: WaveField;
  readonly ocean: Ocean;
  readonly sky: Sky;
  readonly dayNight: DayNightCycle;
  /** The weather: what decides wind, cloud, rain and visibility. */
  readonly weather: Weather;
  readonly rain: Rain;

  /**
   * It is only born on the first `prepare`: `PMREMGenerator` needs the renderer, which
   * does not exist here in the constructor.
   */
  private skyEnvironment: SkyEnvironment | null = null;
  private useSkyEnvironment: boolean;

  /** Accumulated time, used by purely visual animations. */
  private elapsed = 0;
  /**
   * The last frame's duration. The environment regenerates on time, and `prepare` —
   * which is what does it — does not receive `dt` because it runs on the render step.
   */
  private frameDt = 1 / 60;
  private readonly windVector = new THREE.Vector2(1, 0);

  constructor(scene: THREE.Scene, quality: QualitySettings, options: EnvironmentOptions = {}) {
    this.scene = scene;

    // Always with the full field, and **never** as a function of the graphics preset:
    // the sea is simulation. See the note in `QualitySettings`.
    this.waveField = new WaveField(
      MAX_WAVES,
      options.seed ?? 1337,
      options.windDirection ?? 0.7,
      options.windStrength ?? 0.65,
    );

    this.ocean = new Ocean(this.waveField, quality);
    this.sky = new Sky();
    this.dayNight = new DayNightCycle(options.dayLengthMinutes ?? 12, options.startTimeOfDay ?? 0.34);
    this.dayNight.setShadowMapSize(quality.shadowMapSize);

    this.weather = new Weather(
      (options.seed ?? 1337) ^ 0x5eed,
      'breeze',
      options.windDirection ?? 0.7,
    );
    this.rain = new Rain();
    scene.add(this.rain.object);

    this.useSkyEnvironment = quality.skyEnvironment;
    this.dayNight.ambientScale = this.useSkyEnvironment ? AMBIENT_WITH_IBL : 1;

    this.ocean.setSkyLut(this.sky.lutTexture);

    // The scene's fog uses the same formula as the sea's shader (exp of the squared
    // distance), so ship and water disappear into the horizon at the same rate.
    this.scene.fog = new THREE.FogExp2(0x88a5be, 1 / 3200);

    scene.add(this.ocean.mesh);
    scene.add(this.sky.dome);
    scene.add(this.sky.sunMesh);
    scene.add(this.dayNight.sunLight);
    scene.add(this.dayNight.sunLight.target);
    scene.add(this.dayNight.moonLight);
    scene.add(this.dayNight.moonLight.target);
    scene.add(this.dayNight.ambientLight);
  }

  /**
   * The fixed step: only what the physics has to see deterministically.
   *
   * The weather comes in here, and not on the frame, because the wind's strength becomes
   * sail force: if it varied with the frame rate, two computers would give the same ship
   * different speeds.
   */
  fixedUpdate(dt: number): void {
    this.weather.fixedUpdate(dt);
    this.dayNight.overcast = this.weather.severity;

    // The sea follows the weather. The strength goes straight in; the heading is
    // followed with a lag by the background swell, which is what produces the cross sea.
    this.waveField.windStrength = this.weather.wind;
    this.waveField.followWind(this.weather.direction, dt);
    this.waveField.syncUniforms();

    this.waveField.update(dt);
    this.dayNight.update(dt);
  }

  /**
   * The fixed step for the side that does **not** simulate.
   *
   * The weather and the time of day arrive ready in the snapshot — see
   * `Weather.applyRemote` for why they are not simulated on both sides. What is left to
   * do here is recompute what **depends** on them: the sun's and moon's positions, each
   * light's intensity and color, the night factor and the fog's color.
   *
   * `dayNight.update(0)` is the call that does that without advancing the clock: with
   * `dt` zero, `timeOfDay` stays exactly where the network put it, and everything else is
   * derived from it.
   */
  fixedUpdateRemote(): void {
    this.dayNight.overcast = this.weather.severity;
    this.dayNight.update(0);
  }

  /** The frame step: everything visual that can vary with the frame rate. */
  update(dt: number, cameraPosition: THREE.Vector3): void {
    this.elapsed += dt;
    this.frameDt = dt;

    this.waveField.getWindVector(this.windVector).normalize();
    this.sky.setCloudCoverage(this.weather.clouds);
    this.rain.update(dt, cameraPosition, this.weather.rain, this.windVector);

    this.sky.update(
      this.dayNight.sunDirection,
      this.dayNight.moonDirection,
      this.dayNight.sunIntensity,
      this.dayNight.nightFactor,
      this.elapsed,
      this.windVector,
    );

    // A storm cloud is **dark**, and dark for a physical reason: it is thick, and what
    // you see from below is its base, which the cloud has already shadowed. Without this
    // the sky closed in with the same white cotton as a summer afternoon, and the storm
    // was only a higher sea under a pretty sky.
    const cloudColors = this.dayNight.getCloudColors();
    const gloom = 1 - this.weather.severity * 0.72;
    cloudColors.sun.multiplyScalar(gloom);
    cloudColors.shadow.multiplyScalar(gloom * 0.85);
    this.sky.setCloudColors(cloudColors.sun, cloudColors.shadow);
    this.sky.follow(cameraPosition);

    this.ocean.update(cameraPosition, this.elapsed);
    this.ocean.setLighting(
      this.dayNight.sunDirection,
      this.dayNight.sunLight.color,
      this.dayNight.sunLight.intensity,
      this.dayNight.moonDirection,
      this.dayNight.nightFactor,
    );

    this.dayNight.follow(cameraPosition);

    // --- fog and flash ---
    //
    // The density comes from the visibility distance the weather asks for. The
    // arithmetic is the inverse of the fog formula itself (`1 − exp(−(d·ρ)²)`): asking
    // for 95% occlusion at the range, ρ = √(−ln 0.05)/range. That way "seeing 750 m"
    // literally means seeing 750 m, and the preset's number can be checked by eye.
    const density = Math.sqrt(-Math.log(0.05)) / Math.max(this.weather.visibility, 50);
    const fog = this.scene.fog as THREE.FogExp2;
    fog.density = density;
    this.ocean.setFogDensity(density);

    // The bad-weather horizon pulls toward lead. A `lerp` to a fixed color, and not a
    // multiplication: darkening on its own would leave the horizon dark blue, and what
    // you see in a storm is gray — the low cloud erases the sky's color.
    fog.color.copy(this.dayNight.fogColor).lerp(STORM_HORIZON, this.weather.severity * 0.65);
    // The lightning washes the scene bluish-white. It goes into the fog and into the
    // ambient light because that is how a flash really behaves: it lights the air, and
    // not each object's surface — whoever is in the mast's shadow brightens along with
    // whoever is in the sun.
    if (this.weather.flash > 0) {
      fog.color.lerp(LIGHTNING_COLOR, this.weather.flash * 0.75);
    }
    this.dayNight.setLightningFlash(this.weather.flash);
  }

  /**
   * Renders the atmospheric LUT and, from it, the reflection environment. It has to run
   * before the main render, because both the sky and the sea read those textures on the
   * same frame.
   */
  prepare(renderer: THREE.WebGLRenderer): void {
    this.sky.renderLut(renderer);
    if (!this.useSkyEnvironment) return;

    this.skyEnvironment ??= new SkyEnvironment(renderer);
    if (this.skyEnvironment.update(renderer, this.sky.lutTexture, this.sky.lutGeneration, this.frameDt)) {
      // The PMREM's target is reused, but `fromEquirectangular` can return a different
      // one on the first call — reassigning every time is cheap and keeps the scene from
      // pointing at a disposed texture.
      this.scene.environment = this.skyEnvironment.texture;
    }
  }

  /**
   * Registers a hull so the sea is clipped away inside it.
   *
   * Call it once per ship, right after putting the model in the scene. Without it the
   * ocean's surface goes through the planking and the hold is falsely flooded.
   */
  addHullClip(object: THREE.Object3D): void {
    this.ocean.addHullClip(object);
  }

  /** Forgets the registered hulls — when tearing the match down. */
  clearHullClips(): void {
    this.ocean.clearHullClips();
  }

  /** Water height at (x, z) — what the buoyancy consumes. */
  sampleHeight(x: number, z: number): number {
    return this.waveField.sampleHeight(x, z);
  }

  /** Water height + normal, to orient splashes and foam. */
  sampleSurface(x: number, z: number, outNormal?: THREE.Vector3): number {
    return this.waveField.sampleSurface(x, z, outNormal);
  }

  /**
   * Rebuilds sea and weather from a given seed.
   *
   * Only the networked duel calls this, and it is the piece that guarantees both sides
   * sail **the same sea**: the waves, the gusts and the weather's chain of transitions
   * all come out of seeded draws, so the same seed produces the same ocean on any
   * machine.
   *
   * The wave count is not a parameter: it is always the six. See the note in
   * `QualitySettings`.
   */
  reseed(seed: number): void {
    // ⚠️ **The weather comes first, and the order is the fix.**
    //
    // `WaveField.generate` pins the background swell's heading to the wind's heading at
    // **that instant**, and it is where the spectrum's two long waves take their
    // direction from for the rest of the match. Generating the sea before seeding the
    // weather, the heading it froze was whatever the local wind had reached by turning
    // since the page opened — a different number on each machine. The two players
    // entered the same sea with the big waves coming from different sides, and the
    // complaint that produces is the vaguest one possible: "it is not synchronized".
    this.weather.reseed(seed ^ 0x5eed);
    this.waveField.windDirection = this.weather.direction;
    this.waveField.windStrength = this.weather.wind;
    this.waveField.generate(MAX_WAVES, seed);
    this.waveField.time = 0;
    this.waveField.syncUniforms();
  }

  applyQuality(quality: QualitySettings): void {
    this.ocean.applyQuality(quality);
    this.dayNight.setShadowMapSize(quality.shadowMapSize);
    // The wave field is **not** regenerated here. Changing preset mid-match used to
    // change the sea under a shot in flight. See `QualitySettings`.

    this.useSkyEnvironment = quality.skyEnvironment;
    this.dayNight.ambientScale = this.useSkyEnvironment ? AMBIENT_WITH_IBL : 1;
    if (!this.useSkyEnvironment) {
      this.scene.environment = null;
      this.skyEnvironment?.dispose();
      this.skyEnvironment = null;
    }
  }

  /**
   * Locks the weather into one state, or releases it to turn on its own.
   *
   * Locking does not freeze the world: the wind goes on turning and the gusts go on
   * coming, because what the option promises is "the sea stays like this", and not
   * "nothing else happens". What it switches off is the transition to another state.
   */
  setWeatherMode(mode: WeatherMode): void {
    if (mode === 'dynamic') {
      this.weather.locked = false;
      return;
    }
    this.weather.set(mode);
    this.weather.locked = true;
  }

  /** Changes the wind: it reorders the waves and rescales the sea's amplitude. */
  setWind(direction: number, strength: number): void {
    this.waveField.windDirection = direction;
    this.waveField.windStrength = strength;
    this.waveField.syncUniforms();
  }

  dispose(): void {
    this.ocean.dispose();
    this.sky.dispose();
    this.rain.dispose();
    this.skyEnvironment?.dispose();
    this.scene.environment = null;
  }
}
