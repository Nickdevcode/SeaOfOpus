/**
 * The balls in flight: a pool of projectiles with physics and swept collision.
 *
 * **Why swept.** At 95 m/s the ball travels 1.58 m per physics step. A hull of 13 cm of
 * planking has an 8% chance of being noticed by a point test — the ball would go through
 * the whole ship between two frames and land on the other side. Each step is split into
 * four, and each substep tests the **segment** from where the ball was to where it went.
 * It is the same reason a shooter sweeps the projectile instead of teleporting it.
 *
 * **Pool.** Nothing is allocated during combat: 64 slots, all created at startup, and a
 * single `InstancedMesh` draws them all in one call. A ball "dies" by becoming a `false`
 * in an array.
 *
 * The visual radius is larger than the physical one on purpose. A real 10 cm ball at 80 m
 * takes up half a pixel — it disappears. The collision uses the true radius; the drawing
 * uses an honest exaggeration, the same way Sea of Thieves does.
 */

import * as THREE from 'three';
import { dragFactor, stepBallistic } from './Ballistics';
import { raycastShip, type ShipHit } from './HitDetection';
import type { Ship } from '../ship/Ship';
import type { FireSolution } from '../ship/Cannon';
import type { WaveField } from '../world/WaveField';

/** Simultaneous balls in flight. Two ships with two guns each do not come close. */
const CAPACITY = 64;
/** Subdivisions of the physics step for the sweep. */
const SUBSTEPS = 4;
/** Seconds until the ball gives up, if it hit nothing. */
const MAX_LIFETIME = 14;
/** Exaggeration factor for the drawn radius. */
const VISUAL_SCALE = 2.4;
/** Bisection rounds to find where the ball pierced the sea's surface. */
const WATER_REFINE = 6;

export type ImpactKind = 'water' | 'ship';

/**
 * The owner of a ball that exists only to be seen. See `spawnGhost`.
 *
 * It is a ship name no ship has, and that is enough: `resolveSegment` already skips the
 * hull whose name matches the shot's owner, and a decorative ball is skipped before
 * that.
 */
const GHOST_OWNER = '\0ghost';

export interface BallImpact {
  kind: ImpactKind;
  /** The point of impact, in the world. */
  readonly position: THREE.Vector3;
  /** The ball's velocity at the instant of impact — it sets the splash's size. */
  readonly velocity: THREE.Vector3;
  /** Filled in only when `kind === 'ship'`. */
  ship: Ship | null;
  /** Detail of the hit on the hull; shared, valid only during the call. */
  hit: ShipHit | null;
}

interface Ball {
  active: boolean;
  readonly position: THREE.Vector3;
  readonly previous: THREE.Vector3;
  readonly velocity: THREE.Vector3;
  dragK: number;
  radius: number;
  life: number;
  owner: string;
}

const _from = new THREE.Vector3();
const _to = new THREE.Vector3();
const _probe = new THREE.Vector3();
const _matrix = new THREE.Matrix4();
const _renderPosition = new THREE.Vector3();
const _scale = new THREE.Vector3();
const _identity = new THREE.Quaternion();
const HIDDEN = new THREE.Vector3(0, 0, 0);

export type ImpactHandler = (impact: BallImpact) => void;

function createHit(): ShipHit {
  return {
    fraction: 0,
    local: new THREE.Vector3(),
    normal: new THREE.Vector3(),
    part: 'hull',
    floods: false,
  };
}

function copyHit(source: ShipHit, target: ShipHit): void {
  target.fraction = source.fraction;
  target.local.copy(source.local);
  target.normal.copy(source.normal);
  target.part = source.part;
  target.floods = source.floods;
}

export class CannonballPool {
  readonly mesh: THREE.InstancedMesh;

  private readonly balls: Ball[] = [];
  /** Scratch space for each ship's test. */
  private readonly hit: ShipHit = createHit();
  /** A copy of the nearest hit so far — see `resolveSegment`. */
  private readonly best: ShipHit = createHit();
  private readonly impact: BallImpact = {
    kind: 'water',
    position: new THREE.Vector3(),
    velocity: new THREE.Vector3(),
    ship: null,
    hit: null,
  };

  constructor(private readonly onImpact: ImpactHandler) {
    // An icosahedron instead of a UV sphere: 80 triangles give a round enough silhouette
    // on a 12 cm object flying past, for a sixth of the cost.
    const geometry = new THREE.IcosahedronGeometry(1, 1);
    const material = new THREE.MeshStandardMaterial({
      color: 0x14161a,
      roughness: 0.62,
      metalness: 0.75,
    });

    this.mesh = new THREE.InstancedMesh(geometry, material, CAPACITY);
    this.mesh.name = 'cannonballs';
    this.mesh.castShadow = true;
    // The mesh's bounding box stays at the origin while the instances fly hundreds of
    // meters away; leaving culling on would erase every ball.
    this.mesh.frustumCulled = false;
    this.mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);

    for (let i = 0; i < CAPACITY; i++) {
      this.balls.push({
        active: false,
        position: new THREE.Vector3(),
        previous: new THREE.Vector3(),
        velocity: new THREE.Vector3(),
        dragK: 0,
        radius: 0.05,
        life: 0,
        owner: '',
      });
      this.mesh.setMatrixAt(i, _matrix.compose(HIDDEN, _identity, HIDDEN));
    }
    this.mesh.instanceMatrix.needsUpdate = true;
  }

  /** How many balls are in the air. Only the debug overlay uses it. */
  get activeCount(): number {
    let count = 0;
    for (const ball of this.balls) if (ball.active) count++;
    return count;
  }

  /**
   * Puts into the air the shot a cannon has just fired.
   *
   * With no free slot, the shot is discarded in silence: with 64 slots that does not
   * happen in play, and stalling the shot would be worse than losing a ball.
   */
  spawn(shot: FireSolution): void {
    const ball = this.balls.find((candidate) => !candidate.active);
    if (!ball) return;

    ball.active = true;
    ball.position.copy(shot.position);
    ball.previous.copy(shot.position);
    ball.velocity.copy(shot.velocity);
    ball.dragK = dragFactor(shot.mass, shot.radius);
    ball.radius = shot.radius;
    ball.life = 0;
    ball.owner = shot.owner;
  }

  /**
   * Puts into the air a ball that **exists only to be seen**.
   *
   * It is what the client that does not simulate uses: it receives the shot event with
   * the muzzle's exact position and velocity, and the ball flies here through the same
   * pure ballistics function the host uses. The trajectory comes out identical — and
   * smoother than if the position came over the wire fifteen times a second.
   *
   * What it does **not** do is hit. Splash, splinter, sound and breach all arrive through
   * the host's event list, and a ball that also fired them here would duplicate all four.
   * See `GHOST_OWNER`.
   */
  spawnGhost(position: THREE.Vector3, velocity: THREE.Vector3, mass: number, radius: number): void {
    const ball = this.balls.find((candidate) => !candidate.active);
    if (!ball) return;

    ball.active = true;
    ball.position.copy(position);
    ball.previous.copy(position);
    ball.velocity.copy(velocity);
    ball.dragK = dragFactor(mass, radius);
    ball.radius = radius;
    ball.life = 0;
    ball.owner = GHOST_OWNER;
  }

  /** Takes every ball out of the air — end of match, respawn. */
  clear(): void {
    for (const ball of this.balls) ball.active = false;
  }

  /**
   * One physics step for every ball.
   *
   * @param ships every ship in play; the shot's owner is skipped.
   */
  fixedUpdate(dt: number, ships: readonly Ship[], waves: WaveField): void {
    const sub = dt / SUBSTEPS;

    for (const ball of this.balls) {
      if (!ball.active) continue;

      ball.previous.copy(ball.position);
      ball.life += dt;
      if (ball.life > MAX_LIFETIME) {
        ball.active = false;
        continue;
      }

      for (let s = 0; s < SUBSTEPS; s++) {
        _from.copy(ball.position);
        stepBallistic(ball.position, ball.velocity, ball.dragK, sub);
        _to.copy(ball.position);

        // A decorative ball collides with nothing: what decides what it hits is the
        // host, and the news arrives through the event list. See `spawnGhost`.
        //
        // But it **stops at the sea**, and not out of realism: without that, a ball that
        // misses goes on descending for fourteen seconds underwater, and the ocean's
        // surface is translucent enough for the sinking blur to be seen. The splash is
        // still the host's — here the ball is only collected, with nothing announced.
        if (ball.owner === GHOST_OWNER) {
          if (ball.position.y <= waves.sampleHeight(ball.position.x, ball.position.z)) {
            ball.active = false;
            break;
          }
          continue;
        }
        if (this.resolveSegment(ball, ships, waves)) break;
      }
    }
  }

  /**
   * Writes the instances' matrices, interpolating between the last two physics steps —
   * the ball is the fastest object in the scene and without this it moves in 1.6 m steps
   * when the render is above 60 Hz.
   */
  syncModel(alpha: number): void {
    for (let i = 0; i < CAPACITY; i++) {
      const ball = this.balls[i]!;
      if (!ball.active) {
        this.mesh.setMatrixAt(i, _matrix.compose(HIDDEN, _identity, HIDDEN));
        continue;
      }

      _renderPosition.lerpVectors(ball.previous, ball.position, alpha);
      const radius = ball.radius * VISUAL_SCALE;
      _scale.set(radius, radius, radius);
      this.mesh.setMatrixAt(i, _matrix.compose(_renderPosition, _identity, _scale));
    }
    this.mesh.instanceMatrix.needsUpdate = true;
  }

  /** Walks the live balls. The smoke trail is what uses it. */
  forEachActive(visit: (position: THREE.Vector3, velocity: THREE.Vector3) => void): void {
    for (const ball of this.balls) {
      if (ball.active) visit(ball.position, ball.velocity);
    }
  }

  /**
   * Tests the segment `_from → _to` against ships and against the sea.
   *
   * The order matters: the ship beats the sea even when the impact point is below the
   * waterline, because a shot that enters through the hull's wet edge is precisely what
   * opens a breach — if the sea won, every grazing shot would become a splash.
   *
   * @returns `true` when the ball died on this segment.
   */
  private resolveSegment(ball: Ball, ships: readonly Ship[], waves: WaveField): boolean {
    let closest = Infinity;
    let target: Ship | null = null;

    for (const ship of ships) {
      if (ship.name === ball.owner) continue;
      if (!raycastShip(ship.body, _from, _to, this.hit)) continue;
      if (this.hit.fraction >= closest) continue;

      // Copied, and not referenced: the next ship overwrites `this.hit` in its own test,
      // and the ball hits whoever was nearest, not the last one.
      closest = this.hit.fraction;
      copyHit(this.hit, this.best);
      target = ship;
    }

    if (target) {
      target.body.localToWorld(this.best.local, this.impact.position);
      this.impact.velocity.copy(ball.velocity);
      this.impact.kind = 'ship';
      this.impact.ship = target;
      this.impact.hit = this.best;
      this.onImpact(this.impact);

      ball.active = false;
      ball.position.copy(this.impact.position);
      return true;
    }

    const surface = waves.sampleHeight(_to.x, _to.z);
    if (_to.y > surface) return false;

    this.impact.position.copy(this.findSplash(waves));
    this.impact.velocity.copy(ball.velocity);
    this.impact.kind = 'water';
    this.impact.ship = null;
    this.impact.hit = null;
    this.onImpact(this.impact);

    ball.active = false;
    ball.position.copy(this.impact.position);
    return true;
  }

  /**
   * Where exactly the segment crossed the sea's surface.
   *
   * Bisection over the wave function itself, and not over `y = 0`: with a significant
   * wave height of 1.8 m, treating the sea as flat puts the splash up to a meter out of
   * place — plainly visible when the ball lands on a crest.
   */
  private findSplash(waves: WaveField): THREE.Vector3 {
    let low = 0;
    let high = 1;

    for (let i = 0; i < WATER_REFINE; i++) {
      const mid = (low + high) * 0.5;
      _probe.lerpVectors(_from, _to, mid);
      if (_probe.y > waves.sampleHeight(_probe.x, _probe.z)) low = mid;
      else high = mid;
    }

    return _probe.lerpVectors(_from, _to, high);
  }
}
