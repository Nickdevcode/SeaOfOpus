/**
 * Rain: streaks of water falling around whoever is looking.
 *
 * ## The idea that makes this cost almost nothing
 *
 * The drops are **not simulated**. They live in a fixed box around the camera, and what
 * is animated is a single variable: time. Each drop's position is a function of time
 * modulo the box's height, so a drop that leaves at the bottom reappears at the top
 * without anyone having to test anything, and the whole box is translated to the camera
 * every frame. There is no per-drop state to update, no allocation and no loop on the
 * CPU — only a time uniform.
 *
 * The price is that the rain interacts with nothing: it does not hit the deck, it does
 * not pool, it is not blocked by the sail. That is the right price. What the rain has to
 * do is tell the player, with no text, that the weather has turned; for that it has to be
 * everywhere and cost zero, and that is what it does.
 *
 * ## Why streaks and not dots
 *
 * A raindrop seen by a human eye (and by a camera) is a **streak**, not a dot: it travels
 * a few centimeters during the exposure time. Drawing dots gives that television snow no
 * game manages to make read as rain. Each drop here is a vertical segment, and its length
 * grows with the intensity — because raining harder is raining faster.
 */

import * as THREE from 'three';

/** Half the rain box's edge, in meters. */
const BOX_HALF = 26;
/** The box's height. It has to cover from the deck to the masthead with room to spare. */
const BOX_HEIGHT = 30;
/** Drops in the box, at most. The visible density is modulated by the intensity. */
const DROP_COUNT = 4200;

const VERTEX_SHADER = /* glsl */ `
precision highp float;

uniform float uTime;
uniform float uIntensity;
uniform vec3 uOrigin;
uniform vec2 uWind;
uniform float uBoxHalf;
uniform float uBoxHeight;

/** The drop's (x, z, seed, phase); the height comes out of the time. */
attribute vec4 aSeed;
/** −1 at the streak's top, +1 at its foot. */
attribute float aEnd;

varying float vFade;

void main() {
  // Heavy rain falls faster: from 14 to 26 m/s.
  float fall = 14.0 + uIntensity * 12.0;
  // The streak's length is how far the drop travels in one exposure time.
  float streak = 0.28 + uIntensity * 0.75;

  // Density: the high-seed drops only come in when the rain thickens. It is what makes
  // the downpour become a storm without swapping geometry.
  vFade = step(aSeed.z, uIntensity) * uIntensity;

  // The fall is time modulo the box's height. The phase spreads the drops so they do not
  // all fall on the same line of the clock.
  float drop = mod(uTime * fall + aSeed.w * uBoxHeight, uBoxHeight);
  float y = uOrigin.y + uBoxHeight * 0.5 - drop;

  // The box follows the camera in half-edge jumps, and not continuously: that way the
  // drops do not slide along with the observer, which is the artifact that gives away
  // rain pinned to the camera.
  //
  // It rounds instead of truncating, and the step is half the edge: truncating by a whole
  // edge, the camera could end up a full edge from the cell's corner and leave the box —
  // the rain disappeared from the screen as soon as the ship moved away from the world's
  // origin. With this step the observer is never more than a quarter of an edge from the
  // center, and there is rain left in every direction around them.
  float cell = uBoxHalf;
  vec2 anchor = floor(uOrigin.xz / cell + 0.5) * cell;
  vec2 xz = anchor + aSeed.xy;

  // Slant from the wind: storm rain falls sideways.
  xz += uWind * (drop * 0.16);

  // The streak: the upper end sits behind along the trajectory.
  y += aEnd * streak * 0.5;

  gl_Position = projectionMatrix * viewMatrix * vec4(xz.x, y, xz.y, 1.0);
}
`;

const FRAGMENT_SHADER = /* glsl */ `
precision highp float;

uniform vec3 uColor;
varying float vFade;

void main() {
  if (vFade <= 0.0) discard;
  gl_FragColor = vec4(uColor, vFade * 0.42);
}
`;

export class Rain {
  readonly object: THREE.LineSegments;

  private readonly material: THREE.ShaderMaterial;

  constructor() {
    const geometry = new THREE.BufferGeometry();

    // Two vertices per drop: the streak is a segment.
    const seeds = new Float32Array(DROP_COUNT * 2 * 4);
    const ends = new Float32Array(DROP_COUNT * 2);
    const positions = new Float32Array(DROP_COUNT * 2 * 3);

    for (let i = 0; i < DROP_COUNT; i++) {
      const x = (Math.random() * 2 - 1) * BOX_HALF;
      const z = (Math.random() * 2 - 1) * BOX_HALF;
      // The density seed is the intensity threshold at which the drop appears.
      // Distributed by the square root so the count grows perceptually linearly:
      // doubling the intensity has to look like twice the rain.
      const threshold = Math.sqrt(Math.random());
      const phase = Math.random();

      for (let end = 0; end < 2; end++) {
        const v = i * 2 + end;
        seeds[v * 4] = x;
        seeds[v * 4 + 1] = z;
        seeds[v * 4 + 2] = threshold;
        seeds[v * 4 + 3] = phase;
        ends[v] = end === 0 ? -1 : 1;
      }
    }

    geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    geometry.setAttribute('aSeed', new THREE.BufferAttribute(seeds, 4));
    geometry.setAttribute('aEnd', new THREE.BufferAttribute(ends, 1));
    // The box follows the camera, so it never leaves the frustum. Computing a bounding
    // sphere for it would be culling it by mistake.
    geometry.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e6);

    this.material = new THREE.ShaderMaterial({
      vertexShader: VERTEX_SHADER,
      fragmentShader: FRAGMENT_SHADER,
      transparent: true,
      depthWrite: false,
      fog: false,
      uniforms: {
        uTime: { value: 0 },
        uIntensity: { value: 0 },
        uOrigin: { value: new THREE.Vector3() },
        uWind: { value: new THREE.Vector2() },
        uBoxHalf: { value: BOX_HALF },
        uBoxHeight: { value: BOX_HEIGHT },
        uColor: { value: new THREE.Color(0.78, 0.85, 0.92) },
      },
    });

    this.object = new THREE.LineSegments(geometry, this.material);
    this.object.frustumCulled = false;
    this.object.matrixAutoUpdate = false;
    // After the sea (1) and before the sky (1000): the rain is transparent and needs
    // what is behind it already drawn.
    this.object.renderOrder = 900;
    this.object.visible = false;
  }

  /**
   * @param intensity 0 (dry) to 1 (storm).
   * @param wind the wind's vector in the plane, to slant the rain.
   */
  update(dt: number, camera: THREE.Vector3, intensity: number, wind: THREE.Vector2): void {
    const uniforms = this.material.uniforms;
    uniforms.uIntensity!.value = intensity;
    this.object.visible = intensity > 0.01;
    if (!this.object.visible) return;

    uniforms.uTime!.value += dt;
    (uniforms.uOrigin!.value as THREE.Vector3).copy(camera);
    (uniforms.uWind!.value as THREE.Vector2).copy(wind);
  }

  dispose(): void {
    this.object.geometry.dispose();
    this.material.dispose();
  }
}
