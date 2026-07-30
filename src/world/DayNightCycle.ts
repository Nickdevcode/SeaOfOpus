/**
 * The full day/night cycle: the sun's and moon's orbits, the light's color and
 * intensity, ambient, fog and clouds.
 *
 * The directional light's color is not a hand-painted ramp — it comes out of the sky's
 * own physics. The lower the sun, the more atmosphere the light crosses ("air mass"),
 * and the blue is scattered out first. That is why the sunset goes orange on its own,
 * with nobody choosing the color.
 */

import * as THREE from 'three';
import { clamp, clamp01, smoothstep, TAU } from '../core/MathUtils';

/**
 * Rayleigh coefficients integrated over the atmosphere's thickness.
 * They are the shader's own (`atmosphere.ts`), multiplied by the 8 km scale height —
 * keeping them in sync is what makes the scene's light match the rendered sky's color.
 */
const RAYLEIGH_OPTICAL_DEPTH = new THREE.Vector3(0.044, 0.104, 0.179);

/** Tilt of the orbital plane: it keeps the sun from crossing the exact zenith. */
const ORBIT_TILT = 0.38;

// The cycle's fixed palette. They are module constants, and not literals inside the
// methods, because `update` runs at 60 Hz: allocating half a dozen Colors per frame
// gives a few hundred objects a second just for the GC to sweep up afterwards.
const AMBIENT_SKY_DAY = new THREE.Color(0.55, 0.72, 0.95);
// Lighter and bluer than the previous (0.05 · 0.08 · 0.16). The real night sky is not
// black: it is navy blue, and it is where almost everything you can see on a deck at
// night comes from.
const AMBIENT_SKY_NIGHT = new THREE.Color(0.11, 0.16, 0.3);
/** Color of the lightning flash applied to the ambient light. */
const LIGHTNING_TINT = new THREE.Color(0.85, 0.9, 1);
const AMBIENT_TWILIGHT = new THREE.Color(0.95, 0.55, 0.35);
const HORIZON_DAY = new THREE.Color(0.62, 0.74, 0.88);
const HORIZON_NIGHT = new THREE.Color(0.035, 0.055, 0.1);
const HORIZON_TWILIGHT = new THREE.Color(0.85, 0.45, 0.28);
const CLOUD_SHADOW_TINT = new THREE.Color(0.25, 0.29, 0.4);
const NIGHT_CLOUD_LIT = new THREE.Color(0.1, 0.12, 0.18);
const NIGHT_CLOUD_SHADOW = new THREE.Color(0.02, 0.026, 0.045);

export class DayNightCycle {
  /** 0 = midnight, 0.25 = sunrise, 0.5 = noon, 0.75 = sunset. */
  timeOfDay: number;
  /** Length of a full day, in real seconds. */
  dayLengthSeconds: number;
  /** Freezes the clock (used by the menu, which sits at a fixed sunset). */
  paused = false;

  readonly sunDirection = new THREE.Vector3(0, 1, 0);
  readonly moonDirection = new THREE.Vector3(0, -1, 0);

  readonly sunLight: THREE.DirectionalLight;
  readonly moonLight: THREE.DirectionalLight;
  readonly ambientLight: THREE.HemisphereLight;

  /**
   * Multiplier on the hemisphere light.
   *
   * When there is an environment map in the scene, the sky already enters every
   * material's diffuse through the IBL — keeping the hemisphere light at full intensity
   * would count the same light twice and wash the shadows out. It does not disappear
   * because it is still the lighting floor on the Low preset, where the IBL is switched
   * off.
   */
  ambientScale = 1;

  /**
   * How overcast the sky is, 0..1. What writes it is `Weather`.
   *
   * It is not decoration: cloud blocks sun. Without this factor the storm had a leaden
   * sky with **sharp noon shadows** cast on the deck, which is the easiest visual
   * contradiction to notice in a boat game. Here it cuts the directional light (the
   * shadows disappear and the light goes diffuse) and drops the intensity feeding the
   * atmospheric LUT, which darkens the dome and, by extension, the sea's reflection —
   * which reads the same texture.
   */
  overcast = 0;

  /** 0 in full day, 1 in deep night. Used by the stars and the lanterns. */
  nightFactor = 0;
  /** The fog's color, matched to the sky's horizon. */
  readonly fogColor = new THREE.Color();
  /** The sun's intensity passed to the atmospheric LUT. */
  sunIntensity = 22;

  private readonly scattered = new THREE.Color();
  /** The lightning flash on this frame, 0..1. */
  private flash = 0;

  constructor(dayLengthMinutes = 12, startTimeOfDay = 0.34) {
    this.dayLengthSeconds = dayLengthMinutes * 60;
    this.timeOfDay = startTimeOfDay;

    this.sunLight = new THREE.DirectionalLight(0xffffff, 3);
    this.sunLight.castShadow = true;
    this.configureShadow(this.sunLight);

    // The moon casts no shadow: the visual gain does not pay for a second shadow map.
    this.moonLight = new THREE.DirectionalLight(0xb9cbe8, 0.12);
    this.moonLight.castShadow = false;

    this.ambientLight = new THREE.HemisphereLight(0x9dc4e0, 0x0d3040, 0.6);
  }

  private configureShadow(light: THREE.DirectionalLight): void {
    const camera = light.shadow.camera;
    // The frustum covers the ship and a little sea around it; it follows the player in
    // `update`, so it does not have to be large.
    camera.left = -34;
    camera.right = 34;
    camera.top = 34;
    camera.bottom = -34;
    camera.near = 1;
    camera.far = 220;

    light.shadow.bias = -0.0006;
    light.shadow.normalBias = 0.05;
    light.shadow.radius = 2.5;
  }

  setShadowMapSize(size: number): void {
    this.sunLight.castShadow = size > 0;
    if (size > 0) {
      this.sunLight.shadow.mapSize.set(size, size);
      this.sunLight.shadow.map?.dispose();
      this.sunLight.shadow.map = null;
    }
  }

  update(dt: number): void {
    if (!this.paused) {
      this.timeOfDay = (this.timeOfDay + dt / this.dayLengthSeconds) % 1;
    }

    // Orbital angle: at timeOfDay 0.25 the sun is on the eastern horizon.
    const angle = (this.timeOfDay - 0.25) * TAU;
    const cosT = Math.cos(ORBIT_TILT);
    const sinT = Math.sin(ORBIT_TILT);

    this.sunDirection
      .set(Math.cos(angle), Math.sin(angle) * cosT, Math.sin(angle) * sinT)
      .normalize();

    // The moon sits opposite the sun, with an offset that avoids a perfect eclipse.
    const moonAngle = angle + Math.PI + 0.22;
    this.moonDirection
      .set(Math.cos(moonAngle), Math.sin(moonAngle) * cosT, Math.sin(moonAngle) * sinT * -1)
      .normalize();

    const elevation = this.sunDirection.y;

    // The day→night transition centered on the horizon, with the twilight's width.
    this.nightFactor = 1 - smoothstep(-0.14, 0.1, elevation);

    this.updateSunLight(elevation);
    this.updateMoonLight();
    this.updateAmbient(elevation);
    this.updateFog(elevation);

    this.sunIntensity = 22 * clamp01(elevation * 3 + 0.25) * (1 - this.overcast * 0.72);
  }

  /**
   * The sunlight's color and intensity from the air mass crossed.
   *
   * `airMass ≈ 1/sin(elevation)`: at the zenith the light crosses one atmosphere; near
   * grazing, it crosses dozens. The `+0.06` in the denominator avoids the singularity and
   * approximates the Earth's curvature, which is what keeps the light from going black at
   * the horizon.
   */
  private updateSunLight(elevation: number): void {
    const airMass = 1 / Math.max(elevation + 0.06, 0.06);

    const r = Math.exp(-RAYLEIGH_OPTICAL_DEPTH.x * airMass);
    const g = Math.exp(-RAYLEIGH_OPTICAL_DEPTH.y * airMass);
    const b = Math.exp(-RAYLEIGH_OPTICAL_DEPTH.z * airMass);

    this.sunLight.color.setRGB(r, g, b);

    // The intensity falls before the disc disappears: the sun does not light much any
    // more once it is grazing the horizon.
    // The overcast cuts almost the whole directional light: with the sky closed what is
    // left is diffuse light, and that is why nothing casts a shadow in a storm.
    const strength = smoothstep(-0.08, 0.28, elevation) * (1 - this.overcast * 0.88);
    this.sunLight.intensity = 3.4 * strength;
    this.sunLight.visible = this.sunLight.intensity > 0.01;

    // The light points from the sun's direction toward the origin; the position is moved
    // in `follow` to follow the player.
    this.sunLight.position.copy(this.sunDirection).multiplyScalar(120);
  }

  /**
   * The moon's light.
   *
   * **0.95, and not the previous 0.22.** The night was impossible to play: with a fifth
   * of a candle of moon and the hemisphere light dropping to 0.11, the whole deck fell
   * below the threshold at which an ordinary monitor can show a difference in tone, and
   * the player could not see their own bulwark.
   *
   * The temptation is to fix that by raising the ambient, and it is the wrong road:
   * ambient light lights everything equally and erases relief, so the night comes out
   * bright and **flat**. The moon is directional — it gives edges, shadow and highlights
   * on metal. Raising the moon makes the night legible while it goes on looking like
   * night, which is what Sea of Thieves does and why the night there is beautiful instead
   * of blind.
   *
   * It is still 3.5 times less than the noon sun, so nobody confuses the two.
   */
  private updateMoonLight(): void {
    const elevation = this.moonDirection.y;
    const strength = smoothstep(-0.05, 0.3, elevation) * this.nightFactor;
    this.moonLight.intensity = 0.95 * strength;
    this.moonLight.visible = this.moonLight.intensity > 0.005;
    this.moonLight.position.copy(this.moonDirection).multiplyScalar(120);
  }

  /**
   * The lightning flash, 0..1.
   *
   * It goes into the ambient light and not into a new source: a bolt kilometers away
   * lights up the **air**, and what reaches the ship comes from the whole sky, from every
   * direction at once. A directional light would give sharp shadows pointing at one spot
   * on the horizon, which is the opposite of what you see.
   */
  setLightningFlash(flash: number): void {
    this.flash = flash;
  }

  /**
   * Hemispherical ambient light: sky above, the sea's reflection below.
   * It is what keeps the shadows from becoming black holes.
   */
  private updateAmbient(elevation: number): void {
    const day = smoothstep(-0.12, 0.22, elevation);

    // Sky: light blue by day, deep navy at night.
    this.ambientLight.color.copy(AMBIENT_SKY_DAY).lerp(AMBIENT_SKY_NIGHT, 1 - day);

    // Ground: the color the sea returns to the underside of the ship.
    this.ambientLight.groundColor.setRGB(0.06, 0.19, 0.24).multiplyScalar(0.35 + day * 0.65);

    // At twilight the ambient gets a warm push from the orange sky.
    const twilight = smoothstep(0.22, 0.0, Math.abs(elevation)) * 0.5;
    this.ambientLight.color.lerp(AMBIENT_TWILIGHT, twilight * 0.45);

    // The night floor went up from 0.28 to 0.46: enough for the shadows to stop closing
    // to black without flattening the relief, which is the moon's job. See
    // `updateMoonLight` for why the bulk of the gain went there.
    let intensity = (0.46 + day * 0.62) * this.ambientScale;

    // The lightning multiplies the ambient by up to five. It is brutal on purpose: a
    // flash that does not blind for an instant is not a flash.
    if (this.flash > 0) {
      intensity *= 1 + this.flash * 4;
      this.ambientLight.color.lerp(LIGHTNING_TINT, this.flash * 0.8);
    }

    this.ambientLight.intensity = intensity;
  }

  /**
   * The fog's color, approximating the sky near the horizon.
   *
   * We deliberately do not read the LUT off the GPU: `readPixels` forces a sync and eats
   * several milliseconds per frame. This approximation uses the same Rayleigh
   * coefficients, so it converges visually with the rendered sky.
   */
  private updateFog(elevation: number): void {
    const airMass = 1 / Math.max(elevation + 0.06, 0.06);

    // What was scattered out of the direct beam is what colors the horizon.
    this.scattered.setRGB(
      (1 - Math.exp(-RAYLEIGH_OPTICAL_DEPTH.x * airMass * 0.55)) * 0.55,
      (1 - Math.exp(-RAYLEIGH_OPTICAL_DEPTH.y * airMass * 0.55)) * 0.62,
      (1 - Math.exp(-RAYLEIGH_OPTICAL_DEPTH.z * airMass * 0.55)) * 0.78,
    );

    const day = smoothstep(-0.12, 0.25, elevation);

    this.fogColor
      .copy(HORIZON_NIGHT)
      .lerp(HORIZON_DAY, day)
      .lerp(this.scattered, clamp(0.35 + (1 - day) * 0.25, 0, 0.7));

    // A warm push at twilight, when the horizon catches fire.
    const twilight = smoothstep(0.2, -0.02, Math.abs(elevation - 0.02));
    this.fogColor.lerp(HORIZON_TWILIGHT, twilight * 0.5);
  }

  /** Top and bottom colors of the clouds for the sky shader. */
  getCloudColors(): { sun: THREE.Color; shadow: THREE.Color } {
    const sun = this.sunLight.color.clone().multiplyScalar(0.9 + this.sunLight.intensity * 0.12);
    const shadow = this.fogColor.clone().lerp(CLOUD_SHADOW_TINT, 0.5);

    if (this.nightFactor > 0.5) {
      // A cloud at night is dark, not light gray: the only light it receives is the
      // moon's, orders of magnitude below the sun. What makes it visible is its
      // silhouette against the stars, not its own brightness — drawing it too light
      // erases the starry sky behind it.
      const t = (this.nightFactor - 0.5) * 2;
      sun.lerp(NIGHT_CLOUD_LIT, t);
      shadow.lerp(NIGHT_CLOUD_SHADOW, t);
    }
    return { sun, shadow };
  }

  /**
   * Moves the lights around the target so the shadow map, which is small, always covers
   * the player's ship.
   */
  follow(target: THREE.Vector3): void {
    this.sunLight.position.copy(this.sunDirection).multiplyScalar(120).add(target);
    this.sunLight.target.position.copy(target);
    this.sunLight.target.updateMatrixWorld();

    this.moonLight.position.copy(this.moonDirection).multiplyScalar(120).add(target);
    this.moonLight.target.position.copy(target);
    this.moonLight.target.updateMatrixWorld();
  }

  /** Time label for the HUD, in 24 h format. */
  getClockLabel(): string {
    const totalMinutes = this.timeOfDay * 24 * 60;
    const hours = Math.floor(totalMinutes / 60) % 24;
    const minutes = Math.floor(totalMinutes % 60);
    return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}`;
  }
}
