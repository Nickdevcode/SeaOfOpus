/**
 * The wake — the trail of foam the hull leaves in the water.
 *
 * It is a foam density map drawn into a square render target that follows the ship, and
 * which the ocean's shader reads in `sampleWake`. Two passes happen every frame:
 *
 * 1. **Fade** — the previous target is copied into the new one with a UV offset that
 *    compensates for how far the center moved, multiplied by the decay and with a light
 *    diffusion. That is what makes the foam *stay in the water* instead of traveling
 *    along with the ship: the content is reprojected into the world.
 * 2. **Stamp** — each hull draws a quad on top, additively, with the shape of the foam it
 *    is producing *right now*. It is successive frames along the trajectory that build
 *    the trail; nobody draws the whole trail at once.
 *
 * **Why ping-pong and not a single target.** Reading and writing the same texture in the
 * same pass is undefined behavior in WebGL; the only cheap way out is two targets and
 * alternating between them.
 *
 * **Why the center is snapped to the texel grid.** If it moved freely, the UV offset
 * would land in the middle of a texel and the bilinear sampling would blur the whole map
 * every frame — in ten seconds the foam becomes mist. Snapped, the offset is always a
 * whole number of texels and the copy is exact.
 */

import * as THREE from 'three';
import type { QualitySettings } from '../core/Settings';
import { NOISE_GLSL } from '../shaders/noise';
import { HULL_BEAM, HULL_LENGTH } from '../ship/ShipDimensions';
import type { Ship } from '../ship/Ship';

/**
 * Edge of the covered area, in meters.
 *
 * The duel happens between 40 and 120 m; 256 m cover the whole maneuvering with room to
 * spare and still give 0.5 m per texel at the medium resolution. Raising it wastes texels
 * on empty water — the wake only exists where somebody passed.
 */
const WAKE_SIZE = 256;

/**
 * The foam's useful half-life, in seconds.
 *
 * A sloop's visible trail at 8 knots is some 60 m; at 4 m/s that gives ~15 s of life. The
 * decay is exponential, so the tail disappears before that — in practice the trail sits
 * around 50 m, which is what you see in the game.
 */
const FOAM_LIFETIME = 14;

/** How much bigger than the hull the stamp's quad is, on each axis. */
const STAMP_BEAM = 2.4;
const STAMP_LENGTH = 1.2;

/** The hull's half-dimensions in the stamp's normalized units. */
const HULL_HALF = 1 / STAMP_BEAM;
const HULL_END = 1 / STAMP_LENGTH;

/**
 * The speed at which the wake is already flat out, in m/s.
 *
 * ~5.7 knots. Above that the foam does not get any denser, only longer — which is what
 * the integration over time does on its own.
 */
const FULL_WAKE_SPEED = 2.9;

/** Density added per second of sailing at full speed. */
const EMISSION_RATE = 2.6;

const FADE_VERTEX = /* glsl */ `
  varying vec2 vUv;

  void main() {
    vUv = uv;
    gl_Position = vec4(position.xy, 0.0, 1.0);
  }
`;

const FADE_FRAGMENT = /* glsl */ `
  uniform sampler2D uPrevious;
  uniform vec2 uOffset;
  uniform vec2 uTexel;
  uniform float uDecay;

  varying vec2 vUv;

  void main() {
    vec2 uv = vUv + uOffset;

    // Outside the previous map there was no foam at all: it is water that has just
    // entered the area. Without this test ClampToEdge would stretch the edge inward and
    // the ship would look like it was dragging a smear behind it.
    if (any(lessThan(uv, vec2(0.0))) || any(greaterThan(uv, vec2(1.0)))) {
      gl_FragColor = vec4(0.0);
      return;
    }

    float center = texture2D(uPrevious, uv).r;
    float neighbours =
      texture2D(uPrevious, uv + vec2(uTexel.x, 0.0)).r +
      texture2D(uPrevious, uv - vec2(uTexel.x, 0.0)).r +
      texture2D(uPrevious, uv + vec2(0.0, uTexel.y)).r +
      texture2D(uPrevious, uv - vec2(0.0, uTexel.y)).r;

    // Light diffusion: foam spreads as it dies. Too heavy and the trail becomes a blur;
    // too little and the stamp's edges stay hard.
    float value = mix(center, neighbours * 0.25, 0.2) * uDecay;

    gl_FragColor = vec4(value, 0.0, 0.0, 1.0);
  }
`;

const STAMP_VERTEX = /* glsl */ `
  varying vec2 vUv;
  varying vec2 vWorld;

  void main() {
    vUv = uv;
    vec4 world = modelMatrix * vec4(position, 1.0);
    vWorld = world.xz;
    gl_Position = projectionMatrix * viewMatrix * world;
  }
`;

const STAMP_FRAGMENT = /* glsl */ `
  uniform float uAmount;
  uniform float uTime;

  varying vec2 vUv;
  varying vec2 vWorld;

  ${NOISE_GLSL}

  void main() {
    // p.x is athwartships, p.y runs from the stern (−1) to the bow (+1). The stamp is
    // bigger than the hull, so "along" rescales p.y so that ±1 land exactly on the stem
    // and on the transom.
    vec2 p = vUv * 2.0 - 1.0;
    float across = abs(p.x);
    float along = clamp(p.y / ${HULL_END.toFixed(5)}, -1.0, 1.0);

    // The hull's half-width at the waterline: it tapers to a point at the bow and
    // narrows slightly at the stern, which on a sloop is a narrow transom.
    float bow = max(along, 0.0);
    float stern = max(-along, 0.0);
    float halfWidth = ${HULL_HALF.toFixed(5)} *
      (1.0 - pow(bow, 2.6)) *
      (1.0 - 0.18 * pow(stern, 3.0));

    // The band of foam is born where the side pushes the water aside: at the hull's two
    // edges, not underneath it.
    float edge = abs(across - halfWidth);
    float side = 1.0 - smoothstep(0.0, 0.16, edge);
    // At the bow the wave is still forming; the foam opens a little behind it.
    side *= smoothstep(1.0, 0.72, along);

    // Stern: water churned by the rudder and by the void the hull leaves. Wider and
    // dirtier than the side bands.
    float churn = smoothstep(-0.42, -1.0, p.y) *
      (1.0 - smoothstep(halfWidth * 0.9, halfWidth * 1.45, across));

    // The noise is anchored in the **world**, not to the hull: tied to the hull, the
    // grain would travel along and the trail would come out striped.
    float grain = fbm(vec3(vWorld * 0.6, uTime * 0.15), 3, 2.0, 0.5);

    float density = max(side, churn * 0.9) * (0.5 + 0.75 * grain);

    gl_FragColor = vec4(density * uAmount, 0.0, 0.0, 1.0);
  }
`;

/** Foam target: R8 is all the ocean reads, and it costs a quarter of an RGBA. */
function createTarget(resolution: number): THREE.WebGLRenderTarget {
  const target = new THREE.WebGLRenderTarget(resolution, resolution, {
    format: THREE.RedFormat,
    type: THREE.UnsignedByteType,
    minFilter: THREE.LinearFilter,
    magFilter: THREE.LinearFilter,
    wrapS: THREE.ClampToEdgeWrapping,
    wrapT: THREE.ClampToEdgeWrapping,
    depthBuffer: false,
    stencilBuffer: false,
    generateMipmaps: false,
  });
  target.texture.name = 'wake-foam';
  return target;
}

const _shipPosition = new THREE.Vector3();

export class WakeFoam {
  /** Center of the covered area, in world meters. Only x and z matter. */
  readonly center = new THREE.Vector3();
  readonly size = WAKE_SIZE;

  private front: THREE.WebGLRenderTarget;
  private back: THREE.WebGLRenderTarget;
  private resolution: number;
  private texelSize: number;

  private readonly fadeScene = new THREE.Scene();
  private readonly fadeCamera = new THREE.Camera();
  private readonly fadeMaterial: THREE.ShaderMaterial;

  private readonly stampScene = new THREE.Scene();
  private readonly stampCamera: THREE.OrthographicCamera;
  private readonly stampGeometry: THREE.BufferGeometry;
  private readonly stamps: THREE.Mesh[] = [];

  private time = 0;
  /** False until the first pass: before that the target holds allocation garbage. */
  private primed = false;

  constructor(quality: QualitySettings) {
    this.resolution = quality.wakeResolution;
    this.texelSize = WAKE_SIZE / this.resolution;
    this.front = createTarget(this.resolution);
    this.back = createTarget(this.resolution);

    this.fadeMaterial = new THREE.ShaderMaterial({
      uniforms: {
        uPrevious: { value: null },
        uOffset: { value: new THREE.Vector2() },
        uTexel: { value: new THREE.Vector2(1 / this.resolution, 1 / this.resolution) },
        uDecay: { value: 1 },
      },
      vertexShader: FADE_VERTEX,
      fragmentShader: FADE_FRAGMENT,
      depthTest: false,
      depthWrite: false,
    });

    // A fullscreen triangle: one fewer than the quad, and with no diagonal seam where
    // the two triangles meet.
    const fullscreen = new THREE.BufferGeometry();
    fullscreen.setAttribute(
      'position',
      new THREE.BufferAttribute(new Float32Array([-1, -1, 0, 3, -1, 0, -1, 3, 0]), 3),
    );
    fullscreen.setAttribute('uv', new THREE.BufferAttribute(new Float32Array([0, 0, 2, 0, 0, 2]), 2));
    const fadeMesh = new THREE.Mesh(fullscreen, this.fadeMaterial);
    fadeMesh.frustumCulled = false;
    this.fadeScene.add(fadeMesh);

    // A camera looking down, with **top and bottom swapped**. Flipping the projection's
    // Y axis is what makes `uv.y` grow with the world's Z, which is the convention
    // `Ocean.sampleWake` expects. Without it the wake would come out mirrored and show up
    // on the wrong side of the hull.
    const half = WAKE_SIZE / 2;
    this.stampCamera = new THREE.OrthographicCamera(-half, half, -half, half, 0.1, 400);
    this.stampCamera.rotation.x = -Math.PI / 2;

    // A quad in the XZ plane, with v = 1 at the bow (local −Z, as on the ship).
    this.stampGeometry = new THREE.PlaneGeometry(1, 1).rotateX(-Math.PI / 2);
  }

  /** The texture the ocean samples. */
  get texture(): THREE.Texture {
    return this.front.texture;
  }

  /**
   * Advances the wake by one frame.
   *
   * It has to run in the render phase (it touches render targets) and after `syncModel`,
   * so it stamps in the pose that will show up on screen.
   */
  update(renderer: THREE.WebGLRenderer, dt: number, ships: readonly Ship[]): void {
    if (dt <= 0) return;
    this.time += dt;

    const previousCenter = this.center.clone();
    this.recenter(ships);

    const offset = this.fadeMaterial.uniforms.uOffset!.value as THREE.Vector2;
    offset.set(
      (this.center.x - previousCenter.x) / WAKE_SIZE,
      (this.center.z - previousCenter.z) / WAKE_SIZE,
    );
    // Exact exponential decay: independent of the frame rate.
    this.fadeMaterial.uniforms.uDecay!.value = this.primed ? Math.exp(-dt / FOAM_LIFETIME) : 0;
    this.fadeMaterial.uniforms.uPrevious!.value = this.front.texture;

    this.syncStamps(dt, ships);

    const previousTarget = renderer.getRenderTarget();
    const previousAutoClear = renderer.autoClear;

    renderer.setRenderTarget(this.back);
    renderer.autoClear = false;
    renderer.render(this.fadeScene, this.fadeCamera);

    if (this.stampScene.children.length > 0) {
      this.stampCamera.position.set(this.center.x, 100, this.center.z);
      this.stampCamera.updateMatrixWorld();
      renderer.render(this.stampScene, this.stampCamera);
    }

    renderer.autoClear = previousAutoClear;
    renderer.setRenderTarget(previousTarget);

    const swap = this.front;
    this.front = this.back;
    this.back = swap;
    this.primed = true;
  }

  /** Erases everything — used when restarting the match. */
  reset(): void {
    this.primed = false;
    this.center.set(0, 0, 0);
  }

  applyQuality(quality: QualitySettings): void {
    if (quality.wakeResolution === this.resolution) return;
    this.resolution = quality.wakeResolution;
    this.texelSize = WAKE_SIZE / this.resolution;
    this.front.setSize(this.resolution, this.resolution);
    this.back.setSize(this.resolution, this.resolution);
    (this.fadeMaterial.uniforms.uTexel!.value as THREE.Vector2).set(
      1 / this.resolution,
      1 / this.resolution,
    );
    this.primed = false;
  }

  dispose(): void {
    this.front.dispose();
    this.back.dispose();
    this.fadeMaterial.dispose();
    (this.fadeScene.children[0] as THREE.Mesh).geometry.dispose();
    this.stampGeometry.dispose();
    for (const stamp of this.stamps) (stamp.material as THREE.Material).dispose();
    this.stampScene.clear();
  }

  /**
   * Repositions the area over the first ship, snapped to the texel grid.
   *
   * The first on the list is the player's. Centering between the two would be "fairer",
   * but it would make the area jump when one of them sank.
   */
  private recenter(ships: readonly Ship[]): void {
    const lead = ships[0];
    if (!lead) return;
    const position = lead.model.root.position;
    this.center.set(
      Math.round(position.x / this.texelSize) * this.texelSize,
      0,
      Math.round(position.z / this.texelSize) * this.texelSize,
    );
  }

  /** Places one stamp per ship producing foam at this instant. */
  private syncStamps(dt: number, ships: readonly Ship[]): void {
    this.stampScene.clear();

    for (let i = 0; i < ships.length; i++) {
      const ship = ships[i]!;
      if (ship.damage.isSunk) continue;

      // Speed through the water in the direction that matters: a ship lying beam-on in
      // the current opens no wake, a ship going astern does.
      const speed = Math.abs(ship.surge);
      const strength = Math.min(speed / FULL_WAKE_SPEED, 1);
      if (strength < 0.02) continue;

      const stamp = this.getStamp(i);
      _shipPosition.copy(ship.model.root.position);
      stamp.position.set(_shipPosition.x, 0, _shipPosition.z);
      stamp.rotation.y = ship.heading;
      stamp.scale.set(HULL_BEAM * STAMP_BEAM, 1, HULL_LENGTH * STAMP_LENGTH);

      const uniforms = (stamp.material as THREE.ShaderMaterial).uniforms;
      // Emission per *time*, not per frame: at 30 or at 144 fps the trail has the same
      // density.
      uniforms.uAmount!.value = strength * EMISSION_RATE * dt;
      uniforms.uTime!.value = this.time;

      this.stampScene.add(stamp);
    }
  }

  /** Stamps are created on demand and reused — one per ship. */
  private getStamp(index: number): THREE.Mesh {
    let stamp = this.stamps[index];
    if (stamp) return stamp;

    const material = new THREE.ShaderMaterial({
      uniforms: {
        uAmount: { value: 0 },
        uTime: { value: 0 },
      },
      vertexShader: STAMP_VERTEX,
      fragmentShader: STAMP_FRAGMENT,
      transparent: true,
      // Additive: each frame adds a little foam on top of what was already there.
      blending: THREE.AdditiveBlending,
      depthTest: false,
      depthWrite: false,
      // The projection has Y flipped, which reverses the triangles' winding order;
      // drawing both sides avoids depending on that.
      side: THREE.DoubleSide,
    });

    stamp = new THREE.Mesh(this.stampGeometry, material);
    stamp.frustumCulled = false;
    this.stamps[index] = stamp;
    return stamp;
  }
}
