/**
 * Smoke, splash, splinter and flash — everything the combat spits into the air.
 *
 * **One mesh per layer, not one object per particle.** A whole broadside puts some 300
 * puffs in the air; 300 `Sprite`s would be 300 draw calls and 300 nodes in the scene.
 * Here there are two `InstancedBufferGeometry`s — one normally translucent (smoke,
 * splash, splinter) and one additive (the muzzle flash and the powder's glow) — and each
 * frame uploads one slice of buffer with only the live particles.
 *
 * **The billboarding is done in the vertex shader**, reading the camera's axes straight
 * out of the `viewMatrix`. It comes for free and avoids what three's `Sprite` does:
 * recomputing one matrix per particle on the CPU.
 *
 * **No fog.** The scene's fog is `FogExp2` with a density of 1/3200, which at 200 m —
 * twice the useful range of a shot — lets 99.6% of the color through. Adding the
 * computation to both shaders would cost more than the effect nobody would see.
 */

import * as THREE from 'three';
import { createRandom } from '../core/MathUtils';
import { createPuffTexture } from '../textures/ProceduralTextures';

/** Simultaneous particles in the translucent layer. */
const SMOKE_CAPACITY = 900;
/** And in the additive one, which is always a handful per shot. */
const GLOW_CAPACITY = 220;

/**
 * The air's drag on a puff, per second.
 *
 * Smoke is light and stops fast: in half a second it loses nearly all its exit velocity
 * and goes on to only rise and grow.
 */
const SMOKE_DRAG = 2.6;

const VERTEX_SHADER = /* glsl */ `
  attribute vec3 aOffset;
  attribute vec3 aParams;  // x size, y alpha, z rotation
  attribute vec3 aTint;

  varying vec2 vUv;
  varying float vAlpha;
  varying vec3 vTint;

  void main() {
    vUv = uv;
    vAlpha = aParams.y;
    vTint = aTint;

    float c = cos(aParams.z);
    float s = sin(aParams.z);
    vec2 corner = vec2(position.x * c - position.y * s, position.x * s + position.y * c) * aParams.x;

    // The viewMatrix's columns transposed = the camera's axes in the world. The mesh
    // stays put at the origin, so there is no modelMatrix in the way.
    vec3 right = vec3(viewMatrix[0][0], viewMatrix[1][0], viewMatrix[2][0]);
    vec3 up = vec3(viewMatrix[0][1], viewMatrix[1][1], viewMatrix[2][1]);

    gl_Position = projectionMatrix * viewMatrix * vec4(aOffset + right * corner.x + up * corner.y, 1.0);
  }
`;

const FRAGMENT_SHADER = /* glsl */ `
  uniform sampler2D uMap;

  varying vec2 vUv;
  varying float vAlpha;
  varying vec3 vTint;

  void main() {
    vec4 texel = texture2D(uMap, vUv);
    float alpha = texel.a * vAlpha;
    // Cut early: with hundreds of stacked quads, the nearly transparent pixel costs the
    // same as the opaque one and does not show.
    if (alpha < 0.004) discard;
    gl_FragColor = vec4(vTint * texel.rgb, alpha);
  }
`;

export interface EmitOptions {
  position: THREE.Vector3;
  velocity: THREE.Vector3;
  /** Color multiplied into the sprite. */
  tint: THREE.Color;
  /** Initial radius in meters. */
  size: number;
  /** Growth of the radius, in meters per second. */
  growth: number;
  /** Seconds of life. */
  life: number;
  /** Opacity at birth; it falls to zero at the end of the life. */
  alpha: number;
  /** Exponential braking, per second. */
  drag: number;
  /** Vertical buoyancy, in m/s². Positive rises (smoke), negative falls (water). */
  rise: number;
  /** Spin, in rad/s. */
  spin: number;
}

/**
 * One particle layer with one blending mode.
 *
 * The live particles are always at the start of the arrays: when one dies, the last live
 * one takes its place. That keeps the slice to send to the GPU contiguous and does away
 * with scanning for holes.
 */
class ParticleLayer {
  readonly mesh: THREE.Mesh;

  private count = 0;

  private readonly px: Float32Array;
  private readonly py: Float32Array;
  private readonly pz: Float32Array;
  private readonly vx: Float32Array;
  private readonly vy: Float32Array;
  private readonly vz: Float32Array;
  private readonly age: Float32Array;
  private readonly life: Float32Array;
  private readonly size: Float32Array;
  private readonly growth: Float32Array;
  private readonly alpha: Float32Array;
  private readonly drag: Float32Array;
  private readonly rise: Float32Array;
  private readonly spin: Float32Array;
  private readonly rotation: Float32Array;

  private readonly offsets: THREE.InstancedBufferAttribute;
  private readonly params: THREE.InstancedBufferAttribute;
  private readonly tints: THREE.InstancedBufferAttribute;

  constructor(
    private readonly capacity: number,
    map: THREE.Texture,
    blending: THREE.Blending,
  ) {
    this.px = new Float32Array(capacity);
    this.py = new Float32Array(capacity);
    this.pz = new Float32Array(capacity);
    this.vx = new Float32Array(capacity);
    this.vy = new Float32Array(capacity);
    this.vz = new Float32Array(capacity);
    this.age = new Float32Array(capacity);
    this.life = new Float32Array(capacity);
    this.size = new Float32Array(capacity);
    this.growth = new Float32Array(capacity);
    this.alpha = new Float32Array(capacity);
    this.drag = new Float32Array(capacity);
    this.rise = new Float32Array(capacity);
    this.spin = new Float32Array(capacity);
    this.rotation = new Float32Array(capacity);

    // The quad is written by hand instead of borrowed from a `PlaneGeometry`: the
    // attributes would be shared, and disposing of the borrowed geometry would take down
    // the buffers this one still uses.
    const geometry = new THREE.InstancedBufferGeometry();
    geometry.setAttribute(
      'position',
      new THREE.BufferAttribute(
        new Float32Array([-0.5, -0.5, 0, 0.5, -0.5, 0, 0.5, 0.5, 0, -0.5, 0.5, 0]),
        3,
      ),
    );
    geometry.setAttribute(
      'uv',
      new THREE.BufferAttribute(new Float32Array([0, 0, 1, 0, 1, 1, 0, 1]), 2),
    );
    geometry.setIndex([0, 1, 2, 0, 2, 3]);

    this.offsets = new THREE.InstancedBufferAttribute(new Float32Array(capacity * 3), 3);
    this.params = new THREE.InstancedBufferAttribute(new Float32Array(capacity * 3), 3);
    this.tints = new THREE.InstancedBufferAttribute(new Float32Array(capacity * 3), 3);
    this.offsets.setUsage(THREE.DynamicDrawUsage);
    this.params.setUsage(THREE.DynamicDrawUsage);
    this.tints.setUsage(THREE.DynamicDrawUsage);

    geometry.setAttribute('aOffset', this.offsets);
    geometry.setAttribute('aParams', this.params);
    geometry.setAttribute('aTint', this.tints);
    geometry.instanceCount = 0;

    const material = new THREE.ShaderMaterial({
      uniforms: { uMap: { value: map } },
      vertexShader: VERTEX_SHADER,
      fragmentShader: FRAGMENT_SHADER,
      transparent: true,
      blending,
      // No depth writing: a translucent particle that writes into the z-buffer cuts out
      // the one behind it and the smoke becomes a mosaic of squares.
      depthWrite: false,
      depthTest: true,
      side: THREE.DoubleSide,
    });

    this.mesh = new THREE.Mesh(geometry, material);
    this.mesh.frustumCulled = false;
    this.mesh.matrixAutoUpdate = false;
    this.mesh.renderOrder = 3;
  }

  get live(): number {
    return this.count;
  }

  /**
   * A particle is born. With the layer full, the request is ignored — losing one puff out
   * of a broadside's 300 is invisible; stalling to make room is not.
   */
  emit(options: EmitOptions): void {
    if (this.count >= this.capacity) return;

    const i = this.count++;
    this.px[i] = options.position.x;
    this.py[i] = options.position.y;
    this.pz[i] = options.position.z;
    this.vx[i] = options.velocity.x;
    this.vy[i] = options.velocity.y;
    this.vz[i] = options.velocity.z;
    this.age[i] = 0;
    this.life[i] = options.life;
    this.size[i] = options.size;
    this.growth[i] = options.growth;
    this.alpha[i] = options.alpha;
    this.drag[i] = options.drag;
    this.rise[i] = options.rise;
    this.spin[i] = options.spin;
    this.rotation[i] = Math.random() * Math.PI * 2;

    this.tints.setXYZ(i, options.tint.r, options.tint.g, options.tint.b);
  }

  /** Integrates and uploads the buffers. It runs on render time, not on the fixed step. */
  update(dt: number): void {
    const offsets = this.offsets.array as Float32Array;
    const params = this.params.array as Float32Array;

    for (let i = 0; i < this.count; ) {
      this.age[i]! += dt;
      if (this.age[i]! >= this.life[i]!) {
        this.remove(i);
        continue;
      }

      // Exact exponential braking, and not `v -= v*k*dt`: the cannon's smoke leaves at
      // 14 m/s and the explicit form would blow up on long frames.
      const decay = Math.exp(-this.drag[i]! * dt);
      this.vx[i]! *= decay;
      this.vy[i]! *= decay;
      this.vz[i]! *= decay;
      this.vy[i]! += this.rise[i]! * dt;

      this.px[i]! += this.vx[i]! * dt;
      this.py[i]! += this.vy[i]! * dt;
      this.pz[i]! += this.vz[i]! * dt;

      this.size[i]! += this.growth[i]! * dt;
      this.rotation[i]! += this.spin[i]! * dt;

      const t = this.age[i]! / this.life[i]!;
      // Rises fast and fades slowly: it is the profile of a puff of powder smoke, which
      // appears with a crack and then dissolves.
      const envelope = Math.min(t * 6, 1) * (1 - t) * (1 - t);

      offsets[i * 3] = this.px[i]!;
      offsets[i * 3 + 1] = this.py[i]!;
      offsets[i * 3 + 2] = this.pz[i]!;
      params[i * 3] = this.size[i]!;
      params[i * 3 + 1] = this.alpha[i]! * envelope;
      params[i * 3 + 2] = this.rotation[i]!;

      i++;
    }

    (this.mesh.geometry as THREE.InstancedBufferGeometry).instanceCount = this.count;
    if (this.count === 0) return;

    // Only the live prefix goes up to the GPU; the rest of the buffer is old garbage
    // `instanceCount` already tells the driver to ignore.
    for (const attribute of [this.offsets, this.params, this.tints]) {
      attribute.clearUpdateRanges();
      attribute.addUpdateRange(0, this.count * 3);
      attribute.needsUpdate = true;
    }
  }

  clear(): void {
    this.count = 0;
    (this.mesh.geometry as THREE.InstancedBufferGeometry).instanceCount = 0;
  }

  /** Removes particle `i` by bringing the last live one into its place. */
  private remove(i: number): void {
    const last = --this.count;
    if (i === last) return;

    this.px[i] = this.px[last]!;
    this.py[i] = this.py[last]!;
    this.pz[i] = this.pz[last]!;
    this.vx[i] = this.vx[last]!;
    this.vy[i] = this.vy[last]!;
    this.vz[i] = this.vz[last]!;
    this.age[i] = this.age[last]!;
    this.life[i] = this.life[last]!;
    this.size[i] = this.size[last]!;
    this.growth[i] = this.growth[last]!;
    this.alpha[i] = this.alpha[last]!;
    this.drag[i] = this.drag[last]!;
    this.rise[i] = this.rise[last]!;
    this.spin[i] = this.spin[last]!;
    this.rotation[i] = this.rotation[last]!;

    const tints = this.tints.array as Float32Array;
    tints[i * 3] = tints[last * 3]!;
    tints[i * 3 + 1] = tints[last * 3 + 1]!;
    tints[i * 3 + 2] = tints[last * 3 + 2]!;
  }
}

const SMOKE_COLOR = new THREE.Color(0.72, 0.71, 0.69);
const FOAM_COLOR = new THREE.Color(0.93, 0.96, 0.97);
const SPRAY_COLOR = new THREE.Color(0.62, 0.79, 0.82);
const SPLINTER_COLOR = new THREE.Color(0.42, 0.29, 0.17);
const FLASH_COLOR = new THREE.Color(1.6, 1.05, 0.45);

const _position = new THREE.Vector3();
const _velocity = new THREE.Vector3();
const _spread = new THREE.Vector3();

export class Effects {
  private readonly smoke: ParticleLayer;
  private readonly glow: ParticleLayer;
  private readonly texture: THREE.Texture;
  private readonly random = createRandom(4271);
  /** The trail's accumulator, to pace it by distance and not by frame. */
  private trailClock = 0;

  constructor(scene: THREE.Scene) {
    this.texture = createPuffTexture();
    this.smoke = new ParticleLayer(SMOKE_CAPACITY, this.texture, THREE.NormalBlending);
    this.glow = new ParticleLayer(GLOW_CAPACITY, this.texture, THREE.AdditiveBlending);

    this.smoke.mesh.name = 'particles-smoke';
    this.glow.mesh.name = 'particles-glow';
    scene.add(this.smoke.mesh, this.glow.mesh);
  }

  /** Live particles in both layers — the debug overlay reads from here. */
  get liveCount(): number {
    return this.smoke.live + this.glow.live;
  }

  update(dt: number): void {
    this.smoke.update(dt);
    this.glow.update(dt);
    this.trailClock += dt;
  }

  clear(): void {
    this.smoke.clear();
    this.glow.clear();
  }

  dispose(): void {
    this.texture.dispose();
    for (const layer of [this.smoke, this.glow]) {
      layer.mesh.geometry.dispose();
      (layer.mesh.material as THREE.Material).dispose();
      layer.mesh.removeFromParent();
    }
  }

  /**
   * The shot: a flash at the muzzle, a jet of smoke along the barrel's axis and the cloud
   * that hangs beside the ship for a few seconds.
   */
  muzzleBlast(position: THREE.Vector3, direction: THREE.Vector3): void {
    this.glow.emit({
      position,
      velocity: _velocity.copy(direction).multiplyScalar(2),
      tint: FLASH_COLOR,
      size: 1.7,
      growth: 6,
      life: 0.11,
      alpha: 1,
      drag: 5,
      rise: 0,
      spin: this.signed(6),
    });

    // The jet: fast, hugging the barrel's axis, with a narrow spread.
    for (let i = 0; i < 14; i++) {
      const speed = 7 + this.random() * 9;
      this.scatter(_velocity.copy(direction).multiplyScalar(speed), 2.4);
      this.smoke.emit({
        position: _position.copy(position).addScaledVector(direction, this.random() * 0.7),
        velocity: _velocity,
        tint: SMOKE_COLOR,
        size: 0.35 + this.random() * 0.4,
        growth: 2.6 + this.random(),
        life: 1.6 + this.random() * 1.4,
        alpha: 0.62,
        drag: SMOKE_DRAG,
        rise: 0.55,
        spin: this.signed(1.4),
      });
    }

    // And the slow cloud left at the bulwark, which is what gives away where the shot
    // came from when you look at the other ship from a distance.
    for (let i = 0; i < 6; i++) {
      this.scatter(_velocity.copy(direction).multiplyScalar(1.4), 1.6);
      this.smoke.emit({
        position: _position.copy(position).addScaledVector(direction, this.random() * 1.6),
        velocity: _velocity,
        tint: SMOKE_COLOR,
        size: 0.9 + this.random() * 0.6,
        growth: 1.5,
        life: 3.4 + this.random() * 1.6,
        alpha: 0.34,
        drag: 1.2,
        rise: 0.35,
        spin: this.signed(0.5),
      });
    }
  }

  /**
   * The ball going into the water: a white column upward and mist around it.
   *
   * The size comes from the impact velocity, so a short shot makes a little splash and a
   * long shot, which arrives diving hard, throws up the whole column.
   */
  waterSplash(position: THREE.Vector3, speed: number): void {
    const power = Math.min(speed / 70, 1.6);

    for (let i = 0; i < 16; i++) {
      const up = 5 + this.random() * 9 * power;
      _velocity.set(this.signed(3.4), up, this.signed(3.4));
      this.smoke.emit({
        position: _position.copy(position).add(_spread.set(this.signed(0.4), 0, this.signed(0.4))),
        velocity: _velocity,
        tint: i % 3 === 0 ? SPRAY_COLOR : FOAM_COLOR,
        size: 0.28 + this.random() * 0.4 * power,
        growth: 0.9,
        life: 0.75 + this.random() * 0.7,
        alpha: 0.85,
        // A droplet does not float: it falls, and falling is what gives the splash its
        // arc.
        drag: 0.7,
        rise: -7.5,
        spin: this.signed(2),
      });
    }

    // The ring of foam left on the surface after the column falls.
    for (let i = 0; i < 5; i++) {
      const angle = (i / 5) * Math.PI * 2;
      _velocity.set(Math.cos(angle) * 2.2, 0.4, Math.sin(angle) * 2.2);
      this.smoke.emit({
        position,
        velocity: _velocity,
        tint: FOAM_COLOR,
        size: 0.5,
        growth: 1.6,
        life: 1.5,
        alpha: 0.5,
        drag: 2.4,
        rise: 0,
        spin: this.signed(0.6),
      });
    }
  }

  /** The ball going into the wood: the impact's flash and the splinter that leaps out of it. */
  woodImpact(position: THREE.Vector3, normal: THREE.Vector3, speed: number): void {
    this.glow.emit({
      position,
      velocity: _velocity.set(0, 0, 0),
      tint: FLASH_COLOR,
      size: 0.8,
      growth: 2,
      life: 0.09,
      alpha: 0.7,
      drag: 4,
      rise: 0,
      spin: 0,
    });

    this.splinters(position, normal, Math.min(speed / 70, 1.5));
  }

  /**
   * Splinters and sawdust leaping out of the shattered wood.
   *
   * Kept apart from `woodImpact` because a ball is not the only thing that tears out
   * planking: a collision does too, and it has **no** powder flash — the flash is hot
   * metal going in, not wood giving way. Putting the same effect on both would give a
   * spark on every nudge between hulls.
   *
   * @param power the damage's force, 0..1.5. It is force and not velocity because the two
   *   causes live on different scales: a ball arrives at 70 m/s and two hulls meet at 3,
   *   and what you want in both cases is the same splinter flying.
   */
  splinters(position: THREE.Vector3, normal: THREE.Vector3, power: number): void {
    for (let i = 0; i < 12; i++) {
      this.scatter(_velocity.copy(normal).multiplyScalar(4 + this.random() * 9 * power), 4);
      this.smoke.emit({
        position,
        velocity: _velocity,
        tint: SPLINTER_COLOR,
        size: 0.09 + this.random() * 0.12,
        growth: 0.1,
        life: 0.6 + this.random() * 0.5,
        alpha: 0.95,
        drag: 1.1,
        rise: -9,
        spin: this.signed(9),
      });
    }

    for (let i = 0; i < 7; i++) {
      this.scatter(_velocity.copy(normal).multiplyScalar(2.5), 2);
      this.smoke.emit({
        position,
        velocity: _velocity,
        tint: SMOKE_COLOR,
        size: 0.3 + this.random() * 0.3,
        growth: 1.4,
        life: 1.1 + this.random(),
        alpha: 0.4,
        drag: 2.2,
        rise: 0.5,
        spin: this.signed(1),
      });
    }
  }

  /**
   * The water coming in through a breach, seen from inside the hold.
   *
   * The inflow decides how many drops and with what force — a shallow hole drips, a deep
   * breach jets, and the difference is read with no number on screen.
   */
  waterJet(position: THREE.Vector3, direction: THREE.Vector3, inflow: number): void {
    if (inflow <= 0) return;
    // A rate proportional to the inflow, drawn per frame so the effect is not tied to
    // the frame rate.
    if (this.random() > Math.min(inflow * 22, 1)) return;

    const speed = 2 + inflow * 26;
    this.scatter(_velocity.copy(direction).multiplyScalar(-speed), 1.6);
    this.smoke.emit({
      position,
      velocity: _velocity,
      tint: SPRAY_COLOR,
      size: 0.09 + this.random() * 0.09,
      growth: 0.5,
      life: 0.75,
      alpha: 0.8,
      drag: 1.4,
      rise: -9.81,
      spin: this.signed(3),
    });
  }

  /**
   * The ball's trail.
   *
   * Paced by accumulated time (`trailClock`), and not one puff per frame: at 144 Hz the
   * trail would become a solid rope, and at 30 Hz, a dotted line.
   */
  ballTrail(position: THREE.Vector3, velocity: THREE.Vector3): void {
    if (this.trailClock < 0.028) return;

    this.scatter(_velocity.copy(velocity).multiplyScalar(0.04), 0.5);
    this.smoke.emit({
      position,
      velocity: _velocity,
      tint: SMOKE_COLOR,
      size: 0.16,
      growth: 0.75,
      life: 0.85,
      alpha: 0.3,
      drag: 2.2,
      rise: 0.4,
      spin: this.signed(1),
    });
  }

  /** Closes the trail's window. Called after walking through every ball. */
  endTrailWindow(): void {
    if (this.trailClock >= 0.028) this.trailClock = 0;
  }

  /** Scatters a vector with isotropic noise of amplitude `amount`. */
  private scatter(target: THREE.Vector3, amount: number): void {
    target.x += this.signed(amount);
    target.y += this.signed(amount);
    target.z += this.signed(amount);
  }

  private signed(amount: number): number {
    return (this.random() * 2 - 1) * amount;
  }
}
