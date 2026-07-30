/**
 * The masthead ensign: a Verlet cloth made fast to the masthead.
 *
 * It exists for a gameplay reason, not for decoration — and the reason is the same one
 * that got the pennant modeled in the first place. At two hundred meters the sloop is a
 * dark silhouette against the sky, and what you tell apart on it is the cloth: the sail,
 * when it is face-on, and the ensign, always. Except that a **rigid** ensign lies twice
 * over a whole match. The old geometry carried a sine baked into the vertices and pointed
 * aft in any condition: with the wind on the quarter it lay athwart, in a calm it stayed
 * stretched, and its ripple was the same frozen fold in every frame of the game.
 *
 * What you gain by simulating it is not "the ensign moves". It is that it becomes an
 * **instrument**: it points to leeward, and therefore says where the wind comes from
 * before the player looks at the HUD. In a game where the heading relative to the wind
 * decides the speed, that is the most important datum on screen — and now it is drawn at
 * the top of the mast itself, which is where every real sailor looks.
 *
 * ## Why Verlet, and why separate from the sail
 *
 * The sail (`SailSim`) has 143 nodes made fast on two boltropes and is what pushes the
 * ship; the ensign has 55 nodes made fast on one edge only and makes no force at all.
 * Sharing the solver would cost more in parameterization than the forty milliseconds per
 * minute this whole file spends. And the wind — which is what the two have in common —
 * comes from outside, from the same `localWind` the sail reads.
 *
 * The cloth runs in the ship's frame, like the sail: the mesh is a child of the hull, so
 * the positions are already in that system and the sea's motion comes in for free.
 */

import * as THREE from 'three';
import { clamp01 } from '../core/MathUtils';
import { ENSIGN_FRAME, ensignRestPoint, ensignVertexIndex } from './ShipParts';

/** The cloth's slack along its length. Little: a pennant is stretched. */
const CHORD_SLACK = 1.01;
/** Slack in the height, where the cloth really ripples. */
const SPAN_SLACK = 1.05;
const RELAX_ITERATIONS = 3;
const CLOTH_DAMPING = 0.984;

/**
 * The cloth's acceleration per unit of **dynamic pressure** — that is, multiplied by the
 * square of the wind's speed, like every fluid force.
 *
 * The square matters more here than on the sail: between a calm (6 m/s) and a storm
 * (20 m/s) the pressure changes tenfold, and that is what makes the ensign hang limp in
 * one case and stand stiff in the other. With a linear relationship the difference would
 * be threefold, and the player would not read the weather off the ensign.
 */
const WIND_GAIN = 0.085;
/** The gravity the cloth feels — just enough for the tip to droop in a calm. */
const CLOTH_GRAVITY = 2.6;

/**
 * The gain of the traveling wave that runs along the cloth, also over the dynamic
 * pressure.
 *
 * Verlet on its own, with a constant wind, converges to a **straight** ensign: with no
 * turbulence there is nothing to make it ripple, and the result is a board pointing to
 * leeward — which is exactly what the first version drew. The wave comes in as a
 * transverse force that travels along the length, which is what an ensign really does:
 * the wake instability runs from the staff to the tip, growing.
 *
 * A little larger than the wind's push, on purpose. It is the wave that gives the cloth
 * life, and it has to overcome the tension the wind itself imposes — it was by
 * underestimating that that the first attempt produced a displacement of millimeters per
 * second, invisible at any distance.
 */
const RIPPLE_GAIN = 0.2;
/**
 * Wavelengths per meter of cloth.
 *
 * 0.8 gives one and a half waves across the pennant's 1.9 m. It was at 1.35 — two and a
 * half waves —, and the cloth only has ten columns of vertices: each crest got four
 * quads and the wave read as jagging, not as cloth. The mesh decides the shortest
 * wavelength worth simulating.
 */
const RIPPLE_WAVES = 0.8;
/** How many times per second the wave runs along the cloth, per m/s of wind. */
const RIPPLE_SPEED = 0.21;

interface ClothConstraint {
  a: number;
  b: number;
  rest: number;
}

const _rest = new THREE.Vector3();

export class EnsignSim {
  private readonly geometry: THREE.BufferGeometry | null;
  private readonly positions: Float32Array | null = null;
  private readonly previous: Float32Array | null = null;
  private readonly pinned: Uint8Array | null = null;
  private readonly constraints: ClothConstraint[] = [];
  private time = 0;

  /**
   * @param mesh the ensign's mesh, or `null` for a ship with no visible cloth.
   */
  constructor(mesh: THREE.Mesh | null) {
    this.geometry = mesh?.geometry ?? null;
    if (!this.geometry) return;

    const attribute = this.geometry.getAttribute('position') as THREE.BufferAttribute;
    this.positions = attribute.array as Float32Array;
    this.previous = new Float32Array(this.positions);

    const { columns, rows, length, height } = ENSIGN_FRAME;
    this.pinned = new Uint8Array((columns + 1) * (rows + 1));
    // Only the staff's edge. Everything else flies — including the two horizontal edges,
    // which is where a pennant's ripple shows.
    for (let j = 0; j <= rows; j++) this.pinned[ensignVertexIndex(0, j)] = 1;

    const dz = length / columns;
    const dy = height / rows;
    const diagonal = Math.hypot(dz, dy);

    for (let j = 0; j <= rows; j++) {
      for (let i = 0; i <= columns; i++) {
        const index = ensignVertexIndex(i, j);
        if (i < columns) {
          this.constraints.push({ a: index, b: ensignVertexIndex(i + 1, j), rest: dz * CHORD_SLACK });
        }
        if (j < rows) {
          this.constraints.push({ a: index, b: ensignVertexIndex(i, j + 1), rest: dy * SPAN_SLACK });
        }
        if (i < columns && j < rows) {
          this.constraints.push({
            a: index,
            b: ensignVertexIndex(i + 1, j + 1),
            rest: diagonal * 1.02,
          });
        }
      }
    }
  }

  /**
   * One step of the cloth.
   *
   * @param localWind the apparent wind in the ship's frame — the **same** vector the sail
   *   uses to make force. It is what guarantees the ensign and the canvas never tell
   *   different stories about where the wind comes from.
   */
  update(dt: number, localWind: THREE.Vector3): void {
    const positions = this.positions;
    const previous = this.previous;
    const pinned = this.pinned;
    if (!positions || !previous || !pinned || !this.geometry) return;

    this.time += dt;

    const speed = localWind.length();
    const dynamic = speed * speed;
    const pressure = WIND_GAIN * dynamic;
    const windX = speed > 1e-4 ? localWind.x / speed : 0;
    const windZ = speed > 1e-4 ? localWind.z / speed : 1;

    // The wave grows with the pressure and disappears in a light wind: in a calm an
    // ensign hangs, it does not flutter.
    const ripple = RIPPLE_GAIN * dynamic * clamp01(speed / 5);
    const phase = this.time * speed * RIPPLE_SPEED * Math.PI * 2;
    const dt2 = dt * dt;
    const { columns } = ENSIGN_FRAME;

    for (let index = 0; index < pinned.length; index++) {
      if (pinned[index]) continue;
      const o = index * 3;

      const x = positions[o]!;
      const y = positions[o + 1]!;
      const z = positions[o + 2]!;

      // The wave grows with the distance from the staff (`u²`): at the mast the cloth is
      // made fast and has nowhere to go; at the tip it whips.
      const u = (index % (columns + 1)) / columns;
      const swing =
        ripple * u * u * Math.sin(u * Math.PI * 2 * RIPPLE_WAVES * ENSIGN_FRAME.length - phase);

      // The wind's push is along the wind; the wave is **perpendicular** to it, in the
      // horizontal plane. Turning 90° in Y is swapping the components and one sign, with
      // no matrix at all.
      const ax = pressure * windX + swing * -windZ;
      const az = pressure * windZ + swing * windX;

      positions[o] = x + (x - previous[o]!) * CLOTH_DAMPING + ax * dt2;
      positions[o + 1] = y + (y - previous[o + 1]!) * CLOTH_DAMPING - CLOTH_GRAVITY * dt2;
      positions[o + 2] = z + (z - previous[o + 2]!) * CLOTH_DAMPING + az * dt2;

      previous[o] = x;
      previous[o + 1] = y;
      previous[o + 2] = z;
    }

    for (let iteration = 0; iteration < RELAX_ITERATIONS; iteration++) {
      for (const constraint of this.constraints) {
        const a = constraint.a * 3;
        const b = constraint.b * 3;

        const dx = positions[b]! - positions[a]!;
        const dy = positions[b + 1]! - positions[a + 1]!;
        const dz = positions[b + 2]! - positions[a + 2]!;
        const distance = Math.hypot(dx, dy, dz);
        if (distance < 1e-6 || distance <= constraint.rest) continue;

        const correction = (distance - constraint.rest) / distance / 2;
        const cx = dx * correction;
        const cy = dy * correction;
        const cz = dz * correction;

        if (!pinned[constraint.a]) {
          positions[a] += cx;
          positions[a + 1] += cy;
          positions[a + 2] += cz;
        }
        if (!pinned[constraint.b]) {
          positions[b] -= cx;
          positions[b + 1] -= cy;
          positions[b + 2] -= cz;
        }
      }
    }

    this.geometry.getAttribute('position').needsUpdate = true;
    this.geometry.computeVertexNormals();
    this.geometry.getAttribute('normal').needsUpdate = true;
  }

  /** Returns the cloth to its rest shape — used when restarting a match. */
  reset(): void {
    const positions = this.positions;
    const previous = this.previous;
    if (!positions || !previous || !this.geometry) return;

    const { columns, rows } = ENSIGN_FRAME;
    for (let j = 0; j <= rows; j++) {
      for (let i = 0; i <= columns; i++) {
        const o = ensignVertexIndex(i, j) * 3;
        ensignRestPoint(i, j, _rest);
        positions[o] = _rest.x;
        positions[o + 1] = _rest.y;
        positions[o + 2] = _rest.z;
      }
    }
    previous.set(positions);
    this.geometry.getAttribute('position').needsUpdate = true;
    this.geometry.computeVertexNormals();
  }
}
