/**
 * Every sound in the game, **synthesized in code**. No audio files.
 *
 * The choice is not thrift: it is the same one the rest of the project already made. The
 * hull is a function, the textures are born out of 2D canvases, the ocean is a wave
 * spectrum. A cannon `.wav` here would be the one opaque asset in a whole project that
 * explains itself — and it would still bring a license, a download and a magic number
 * (the file's length) impossible to justify in a comment.
 *
 * Synthesized, each sound is a description of the phenomenon. A cannon shot is a pressure
 * transient (broadband noise with a millisecond attack) over a low-frequency cavity (the
 * barrel's air column). Written that way, you can **tune the physics**: distance does not
 * only lower the volume, it closes the filter, because the treble is what the air eats
 * first. That is why a shot at 150 m sounds like muffled thunder and the same shot at
 * 10 m cracks.
 *
 * ## The architecture, in one line
 *
 * `source → panel (pan + distance) → dry ─┬→ master → compressor → output`
 * `                                        └→ reverb → master`
 *
 * The reverb is a convolution with an impulse response **generated here**: noise with an
 * exponential decay, dark and short. It is not a room's acoustics — the open sea has no
 * walls —, it is the tail the air itself and the water's surface send back. Without it
 * the shots sound like clicks in a vacuum; with it, they gain space.
 *
 * ## Why the pan and the attenuation are done by hand
 *
 * Web Audio has `PannerNode` with HRTF and a distance model. It requires keeping an
 * `AudioListener` synchronized with the camera every frame and, in exchange, delivers a
 * spatialization that in an on-screen game is nearly indistinguishable from a
 * `StereoPanner` plus a gain. The manual path costs three lines, leaves the distance
 * curve explicit (and therefore tunable) and allows the air-absorption filter, which the
 * built-in model does not do.
 */

import * as THREE from 'three';
import { clamp, clamp01 } from '../core/MathUtils';
import { settings } from '../core/Settings';

/** Range at which a sound stops being audible, in meters. */
const MAX_AUDIBLE = 320;
/**
 * Reference distance for the attenuation, in meters.
 *
 * Inside it the sound does not get any louder — it is the source's own radius. Without
 * that floor, the `1/d` curve blows up as the distance tends to zero and a shot from the
 * cannon right beside you would clip the output.
 */
const REFERENCE_DISTANCE = 12;

/** Air filter's cutoff: open up close, closed far away, in Hz. */
const AIR_NEAR_HZ = 18000;
const AIR_FAR_HZ = 700;

/** Length of the reverb tail, in seconds. */
const REVERB_SECONDS = 1.9;

/** A point source already resolved into pan, gain and damping. */
interface Placement {
  pan: number;
  gain: number;
  cutoff: number;
}

const _toSource = new THREE.Vector3();
const _right = new THREE.Vector3();

export class GameAudio {
  private context: AudioContext | null = null;
  private master!: GainNode;
  private reverbSend!: GainNode;
  private noise!: AudioBuffer;

  /** Continuous layers: sea and wind. */
  private seaGain: GainNode | null = null;
  private windGain: GainNode | null = null;
  private windFilter: BiquadFilterNode | null = null;

  /** The camera, to orient the pan. Replaced every frame by `setListener`. */
  private readonly listenerPosition = new THREE.Vector3();
  private readonly listenerQuaternion = new THREE.Quaternion();

  /** `true` after the player's first gesture, when the context could open. */
  get ready(): boolean {
    return this.context !== null && this.context.state === 'running';
  }

  /**
   * Opens the audio context. **It has to be called inside a player gesture** — every
   * current browser refuses to start audio without one, and that is why the constructor
   * does nothing.
   */
  unlock(): void {
    if (this.context) {
      if (this.context.state === 'suspended') void this.context.resume();
      return;
    }

    const Constructor: typeof AudioContext | undefined =
      window.AudioContext ??
      (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!Constructor) return;

    const context = new Constructor();
    this.context = context;

    this.master = context.createGain();
    this.master.gain.value = settings.preferences.masterVolume;

    // A compressor on the master: a double broadside plus a splash add up to peaks that
    // would saturate the output. A fast attack to catch the shot's transient, a wide knee
    // so the compression is not audible as "pumping".
    const compressor = context.createDynamicsCompressor();
    compressor.threshold.value = -14;
    compressor.knee.value = 22;
    compressor.ratio.value = 3.5;
    compressor.attack.value = 0.004;
    compressor.release.value = 0.22;

    this.master.connect(compressor);
    compressor.connect(context.destination);

    const convolver = context.createConvolver();
    convolver.buffer = this.buildImpulse(context);
    this.reverbSend = context.createGain();
    this.reverbSend.gain.value = 1;
    this.reverbSend.connect(convolver);
    convolver.connect(this.master);

    this.noise = this.buildNoise(context);
    this.startAmbience(context);

    settings.onChange((prefs) => {
      if (this.master) this.master.gain.value = prefs.masterVolume;
    });
  }

  /** Where the ear is. Call it once per frame, with the camera. */
  setListener(camera: THREE.Camera): void {
    this.listenerPosition.copy(camera.position);
    this.listenerQuaternion.copy(camera.quaternion);
  }

  /** Strength of the continuous layers, from the sea state. */
  setSeaState(windStrength: number, nightFactor: number): void {
    if (!this.context) return;

    const now = this.context.currentTime;
    // The wind gets higher and stronger with the strength — it is the whistle in the
    // rigging, and it is what gives the player the sense of speed.
    this.windFilter?.frequency.setTargetAtTime(400 + windStrength * 1400, now, 0.6);
    this.windGain?.gain.setTargetAtTime(0.055 + windStrength * 0.075, now, 0.8);
    // The sea dampens a little at night: less sparkle, more weight. It is a game-mixing
    // convention, and the ear accepts it because it matches the view going dark.
    this.seaGain?.gain.setTargetAtTime(0.1 - nightFactor * 0.02, now, 1.2);
  }

  // -- combat sounds -----------------------------------------------------------

  /**
   * A cannon shot.
   *
   * Three layers, each answering for one part of the phenomenon: the transient's crack
   * (broadband noise, 6 ms attack), the charge's body (filtered noise, half-second decay)
   * and the barrel's cavity (a sine going down from 110 to 40 Hz, which is what you feel
   * in the chest).
   */
  cannonFire(position: THREE.Vector3): void {
    const at = this.place(position);
    if (!at) return;

    this.burst(at, {
      gain: 0.85,
      attack: 0.006,
      decay: 0.55,
      type: 'lowpass',
      frequency: Math.min(at.cutoff, 2600),
      q: 0.7,
    });
    this.burst(at, {
      gain: 0.4,
      attack: 0.001,
      decay: 0.09,
      type: 'highpass',
      frequency: 1500,
      q: 0.6,
    });
    this.thump(at, 110, 40, 0.6, 0.7);
  }

  /** A ball splashing into the water. Faster and higher the harder the impact. */
  splash(position: THREE.Vector3, speed: number): void {
    const at = this.place(position);
    if (!at) return;

    const force = clamp01(speed / 90);
    this.burst(at, {
      gain: 0.3 + force * 0.3,
      attack: 0.004,
      decay: 0.16 + force * 0.2,
      type: 'bandpass',
      frequency: Math.min(at.cutoff, 900 + force * 1500),
      q: 0.9,
      // It falls while it sounds: the water column rises and collapses, and the
      // spectrum comes down with it. Without the sweep the splash sounds like tape hiss,
      // not like water.
      sweepTo: 320,
    });
  }

  /**
   * A ball into the wood.
   *
   * `flooded` tells apart the two events the game treats as different: a breach below
   * deck gets a low blow underneath, because that is what the player has to **hear** to
   * know they will have to go down into the hold.
   */
  woodImpact(position: THREE.Vector3, speed: number, flooded: boolean): void {
    const at = this.place(position);
    if (!at) return;

    const force = clamp01(speed / 90);
    this.burst(at, {
      gain: 0.5 + force * 0.35,
      attack: 0.001,
      decay: 0.13,
      type: 'bandpass',
      frequency: Math.min(at.cutoff, 1100),
      q: 1.6,
      sweepTo: 420,
    });
    if (flooded) this.thump(at, 78, 34, 0.42, 0.55);
  }

  /** A ball into the mast: the same crack, with a long trunk's ring. */
  mastHit(position: THREE.Vector3, speed: number): void {
    const at = this.place(position);
    if (!at) return;

    const force = clamp01(speed / 90);
    this.burst(at, {
      gain: 0.45 + force * 0.3,
      attack: 0.001,
      decay: 0.1,
      type: 'bandpass',
      frequency: Math.min(at.cutoff, 1800),
      q: 2.4,
    });
    // A 12 m trunk stepped in the hold rings low and takes its time going quiet.
    this.thump(at, 190, 120, 0.9, 0.3);
  }

  /** The two hulls touching. Creak and thud, sized to the blow. */
  collision(position: THREE.Vector3, speed: number): void {
    const at = this.place(position);
    if (!at) return;

    const force = clamp01(speed / 4);
    this.burst(at, {
      gain: 0.4 + force * 0.4,
      attack: 0.02,
      decay: 0.45 + force * 0.3,
      type: 'lowpass',
      frequency: Math.min(at.cutoff, 700),
      q: 1.1,
    });
    this.thump(at, 60, 28, 0.7, 0.6);
  }

  // -- interface ---------------------------------------------------------------

  /** Menu clicks. Brass, short, no tail. */
  ui(kind: 'move' | 'confirm' | 'back'): void {
    if (!this.context) return;
    const at: Placement = { pan: 0, gain: 0.32, cutoff: AIR_NEAR_HZ };

    if (kind === 'move') {
      this.tone(at, 880, 880, 0.05, 0.1, 'triangle');
      return;
    }
    if (kind === 'confirm') {
      // Two brass notes a fifth apart: an approving sound without turning into a
      // jingle.
      this.tone(at, 660, 660, 0.09, 0.16, 'triangle');
      this.tone(at, 990, 990, 0.14, 0.12, 'triangle', 0.05);
      return;
    }
    this.tone(at, 420, 300, 0.1, 0.14, 'triangle');
  }

  /** A short fanfare at the end of the match. */
  outcome(won: boolean): void {
    if (!this.context) return;
    const at: Placement = { pan: 0, gain: 0.4, cutoff: AIR_NEAR_HZ };

    if (won) {
      // An ascending major triad, spaced out: victory without spelling it out.
      const notes = [392, 494, 587, 784];
      notes.forEach((hz, i) => this.tone(at, hz, hz, 0.9, 0.16, 'triangle', i * 0.13));
      return;
    }
    // Defeat: two notes coming down, the second one flat. The interval that does not
    // resolve is what sounds like loss.
    this.tone(at, 330, 320, 1.1, 0.2, 'sine');
    this.tone(at, 233, 208, 1.6, 0.22, 'sine', 0.22);
  }

  dispose(): void {
    void this.context?.close();
    this.context = null;
  }

  // -- primitives --------------------------------------------------------------

  /**
   * Resolves a world position into pan, gain and air cutoff.
   *
   * @returns `null` when the context did not open or the source is too far away to be
   *   worth an audio node — discarding here is what keeps a distant broadside from
   *   creating six inaudible oscillators.
   */
  private place(position: THREE.Vector3): Placement | null {
    if (!this.context) return null;

    _toSource.subVectors(position, this.listenerPosition);
    const distance = _toSource.length();
    if (distance > MAX_AUDIBLE) return null;

    // Inverse attenuation with a reference distance, and a soft cut at the end of the
    // range so the sound does not vanish in a step.
    const attenuation = REFERENCE_DISTANCE / Math.max(distance, REFERENCE_DISTANCE);
    const fade = 1 - clamp01((distance - MAX_AUDIBLE * 0.6) / (MAX_AUDIBLE * 0.4));
    const gain = attenuation * fade;
    if (gain < 0.002) return null;

    // Pan by the projection onto the camera's "right" axis. Normalized by the distance,
    // so a source right against the ear does not slam all the way to one side.
    _right.set(1, 0, 0).applyQuaternion(this.listenerQuaternion);
    const pan = distance > 1e-3 ? clamp(_toSource.dot(_right) / distance, -1, 1) : 0;

    // Air absorption: the treble dies first, and it is what says "that is far away".
    // Exponential because the absorption is in dB per meter, not linear.
    const cutoff = AIR_FAR_HZ + (AIR_NEAR_HZ - AIR_FAR_HZ) * Math.pow(1 - clamp01(distance / MAX_AUDIBLE), 2.2);

    return { pan, gain, cutoff };
  }

  /** The common output chain: pan → dry + reverb send. */
  private connect(source: AudioNode, at: Placement, wet: number): void {
    const context = this.context!;
    const panner = context.createStereoPanner();
    panner.pan.value = at.pan;
    source.connect(panner);
    panner.connect(this.master);

    const send = context.createGain();
    // More reverb the further away: that is how the ear measures distance in open
    // space, far more than by volume.
    send.gain.value = wet * (0.25 + 0.75 * (1 - at.gain));
    panner.connect(send);
    send.connect(this.reverbSend);
  }

  /** A burst of filtered noise, with an attack and exponential-decay envelope. */
  private burst(
    at: Placement,
    options: {
      gain: number;
      attack: number;
      decay: number;
      type: BiquadFilterType;
      frequency: number;
      q: number;
      sweepTo?: number;
    },
  ): void {
    const context = this.context!;
    const now = context.currentTime;

    const source = context.createBufferSource();
    source.buffer = this.noise;
    // A random starting point in the buffer: two shots in a row with the same stretch
    // of noise sound like the same sound repeated, and the ear catches that at once.
    const offset = Math.random() * (this.noise.duration - options.decay - 0.05);

    const filter = context.createBiquadFilter();
    filter.type = options.type;
    filter.frequency.value = options.frequency;
    filter.Q.value = options.q;
    if (options.sweepTo !== undefined) {
      filter.frequency.setValueAtTime(options.frequency, now);
      filter.frequency.exponentialRampToValueAtTime(
        Math.max(options.sweepTo, 40),
        now + options.decay,
      );
    }

    const envelope = context.createGain();
    envelope.gain.setValueAtTime(0.0001, now);
    envelope.gain.exponentialRampToValueAtTime(
      Math.max(options.gain * at.gain, 0.0002),
      now + options.attack,
    );
    envelope.gain.exponentialRampToValueAtTime(0.0001, now + options.attack + options.decay);

    source.connect(filter);
    filter.connect(envelope);
    this.connect(envelope, at, 0.5);

    source.start(now, Math.max(offset, 0), options.attack + options.decay + 0.05);
    source.stop(now + options.attack + options.decay + 0.05);
  }

  /** A low-frequency blow: a sine sweeping down. The shot's weight. */
  private thump(at: Placement, fromHz: number, toHz: number, decay: number, gain: number): void {
    const context = this.context!;
    const now = context.currentTime;

    const oscillator = context.createOscillator();
    oscillator.type = 'sine';
    oscillator.frequency.setValueAtTime(fromHz, now);
    oscillator.frequency.exponentialRampToValueAtTime(Math.max(toHz, 20), now + decay);

    const envelope = context.createGain();
    envelope.gain.setValueAtTime(0.0001, now);
    envelope.gain.exponentialRampToValueAtTime(Math.max(gain * at.gain, 0.0002), now + 0.01);
    envelope.gain.exponentialRampToValueAtTime(0.0001, now + decay);

    oscillator.connect(envelope);
    this.connect(envelope, at, 0.3);

    oscillator.start(now);
    oscillator.stop(now + decay + 0.02);
  }

  /** A plain note, for the interface. */
  private tone(
    at: Placement,
    fromHz: number,
    toHz: number,
    decay: number,
    gain: number,
    type: OscillatorType,
    delay = 0,
  ): void {
    const context = this.context!;
    const start = context.currentTime + delay;

    const oscillator = context.createOscillator();
    oscillator.type = type;
    oscillator.frequency.setValueAtTime(fromHz, start);
    if (toHz !== fromHz) {
      oscillator.frequency.exponentialRampToValueAtTime(Math.max(toHz, 20), start + decay);
    }

    const envelope = context.createGain();
    envelope.gain.setValueAtTime(0.0001, start);
    envelope.gain.exponentialRampToValueAtTime(Math.max(gain * at.gain, 0.0002), start + 0.008);
    envelope.gain.exponentialRampToValueAtTime(0.0001, start + decay);

    oscillator.connect(envelope);
    this.connect(envelope, at, 0.4);

    oscillator.start(start);
    oscillator.stop(start + decay + 0.02);
  }

  // -- ambience ----------------------------------------------------------------

  /**
   * Sea and wind, on a continuous loop.
   *
   * Both come out of the **same** noise buffer, with different filters: the sea is a wide
   * lowpass with the cutoff swinging slowly (the swell's breathing), the wind is a higher
   * bandpass. Reusing the buffer saves the seconds of noise that would be generated
   * twice, and no ear identifies the common origin after filters that far apart.
   */
  private startAmbience(context: AudioContext): void {
    // --- sea ---
    const sea = context.createBufferSource();
    sea.buffer = this.noise;
    sea.loop = true;

    const seaFilter = context.createBiquadFilter();
    seaFilter.type = 'lowpass';
    seaFilter.frequency.value = 520;
    seaFilter.Q.value = 0.6;

    // An LFO on the cutoff: without it the sea is a shower left running. 0.08 Hz gives
    // one swell every twelve seconds, which is the scale of the game's own wave
    // spectrum.
    const swell = context.createOscillator();
    swell.frequency.value = 0.08;
    const swellDepth = context.createGain();
    swellDepth.gain.value = 220;
    swell.connect(swellDepth);
    swellDepth.connect(seaFilter.frequency);
    swell.start();

    this.seaGain = context.createGain();
    this.seaGain.gain.value = 0.1;

    sea.connect(seaFilter);
    seaFilter.connect(this.seaGain);
    this.seaGain.connect(this.master);
    sea.start();

    // --- wind ---
    const wind = context.createBufferSource();
    wind.buffer = this.noise;
    wind.loop = true;

    this.windFilter = context.createBiquadFilter();
    this.windFilter.type = 'bandpass';
    this.windFilter.frequency.value = 900;
    this.windFilter.Q.value = 0.8;

    const gust = context.createOscillator();
    gust.frequency.value = 0.14;
    const gustDepth = context.createGain();
    gustDepth.gain.value = 260;
    gust.connect(gustDepth);
    gustDepth.connect(this.windFilter.frequency);
    gust.start();

    this.windGain = context.createGain();
    this.windGain.gain.value = 0.07;

    wind.connect(this.windFilter);
    this.windFilter.connect(this.windGain);
    this.windGain.connect(this.master);
    wind.start();
  }

  // -- buffers -----------------------------------------------------------------

  /**
   * A few seconds of stereo white noise, reused by everything.
   *
   * Long enough that the sea and wind loops do not give the repetition away, and that the
   * bursts can start at different points inside it.
   */
  private buildNoise(context: AudioContext): AudioBuffer {
    const length = context.sampleRate * 6;
    const buffer = context.createBuffer(2, length, context.sampleRate);

    for (let channel = 0; channel < 2; channel++) {
      const data = buffer.getChannelData(channel);
      for (let i = 0; i < length; i++) data[i] = Math.random() * 2 - 1;
    }

    return buffer;
  }

  /**
   * The reverb's impulse response, generated.
   *
   * Noise with an exponential decay, and the high exponent (3) is what makes the tail die
   * quickly: the open sea sends little back, and a long tail here would sound like a
   * cathedral. The lowpass built into the decay itself — the late samples receive less
   * high-frequency energy — imitates the air eating the reflection's treble, which is
   * what gives the tail its "far away".
   */
  private buildImpulse(context: AudioContext): AudioBuffer {
    const length = Math.floor(context.sampleRate * REVERB_SECONDS);
    const buffer = context.createBuffer(2, length, context.sampleRate);

    for (let channel = 0; channel < 2; channel++) {
      const data = buffer.getChannelData(channel);
      // State of the one-pole lowpass, per channel.
      let low = 0;
      for (let i = 0; i < length; i++) {
        const t = i / length;
        const decay = Math.pow(1 - t, 3);
        const white = Math.random() * 2 - 1;
        // The coefficient falls with time: the later the reflection, the darker.
        low += (white - low) * (0.35 - 0.3 * t);
        data[i] = low * decay;
      }
    }

    return buffer;
  }
}
