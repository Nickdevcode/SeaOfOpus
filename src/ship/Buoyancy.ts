/**
 * Buoyancy: what makes the ship float, roll and right itself.
 *
 * The hull is sliced into **vertical columns** — a grid of stations along the length by
 * bands along the beam. Each column stores, tabulated at construction time, the
 * submerged volume and that volume's centroid for every possible waterline height
 * inside it. At runtime each column costs one wave sample and two linear
 * interpolations.
 *
 * Why a table and not `ρ·g·V·fraction`: the hull's section thins to almost nothing at
 * the keel, so the submerged fraction is **not** linear in depth. With the linear ramp
 * you see around, the ship sits a few decimeters below the design draft and nobody can
 * say why. With the table, the submerged volume with the waterline at `y = 0` is
 * exactly the design displacement, so the ship is born floating at the drawn draft —
 * with no magic number.
 *
 * Two important effects fall out of this for free:
 * - **Righting moment:** as it heels, the leeward columns submerge more than the
 *   windward ones, and the buoyancy's centroid migrates to the low side. There is no
 *   artificial stability spring in this project.
 * - **Pitch and heave:** the wave arrives at each station at a different phase, and
 *   that is what rocks the ship.
 */

import * as THREE from 'three';
import { GRAVITY, WATER_DENSITY, clamp, clamp01 } from '../core/MathUtils';
import {
  HULL_LENGTH,
  sampleSection,
  sectionHalfWidth,
  sectionV,
  tToZ,
  type HullSection,
} from './ShipDimensions';
import type { ShipBody } from './ShipBody';
import type { WaveField } from '../world/WaveField';

/** Stations along the length. Ten gives ~1.6 m slices. */
const LENGTH_SAMPLES = 10;
/** Bands along the beam. Three (port/center/starboard) are enough for the roll. */
const WIDTH_SAMPLES = 3;
/** Levels of the per-column volume table. */
const LEVELS = 40;
/** Quadrature sub-steps when building the table. */
const QUADRATURE = 8;

/**
 * Radiation damping, in 1/s.
 *
 * A hull that rises and falls creates waves that carry energy away — it is what makes
 * the ship stop bouncing after a swell instead of resonating forever. It acts on the
 * vertical only: applying it horizontally too would lock the ship below 1 knot, because
 * the surge drag is orders of magnitude smaller than this.
 */
const HEAVE_DAMPING = 2.1;

interface HullColumn {
  /** Local X of the column at the design waterline. */
  x: number;
  z: number;
  yBottom: number;
  yTop: number;
  /** Submerged volume (m³) with the waterline at each level. */
  volume: Float32Array;
  /** X of the submerged volume's centroid, per level. */
  centroidX: Float32Array;
  /** Y of the submerged volume's centroid, per level. */
  centroidY: Float32Array;
}

const _worldPoint = new THREE.Vector3();
const _worldArm = new THREE.Vector3();
const _up = new THREE.Vector3();
const _localUp = new THREE.Vector3(0, 1, 0);
const _pointVelocity = new THREE.Vector3();
const _force = new THREE.Vector3();
const _local = new THREE.Vector3();

export interface BuoyancyReport {
  /** Fraction of the design volume that is submerged, 0..1+. */
  submersion: number;
  /** Mean water depth above the design waterline, in meters. */
  meanDepth: number;
}

export class Buoyancy {
  private readonly columns: HullColumn[] = [];
  /** Submerged volume with the waterline exactly at the design draft. */
  readonly designVolume: number;

  private readonly report: BuoyancyReport = { submersion: 0, meanDepth: 0 };

  constructor() {
    const section: HullSection = { halfBeam: 0, keelY: 0, sheerY: 0, fullness: 1 };
    const dz = HULL_LENGTH / LENGTH_SAMPLES;
    let designVolume = 0;

    for (let i = 0; i < LENGTH_SAMPLES; i++) {
      const t = (i + 0.5) / LENGTH_SAMPLES;
      sampleSection(t, section);

      const yBottom = section.keelY;
      const yTop = section.sheerY;
      const span = yTop - yBottom;

      for (let j = 0; j < WIDTH_SAMPLES; j++) {
        // The band follows the section's half width at each height, instead of being
        // a fixed rectangle: that way the columns really tile the hull, with no excess
        // at the keel and no shortfall at the bilge.
        const uCenter = (j + 0.5) / WIDTH_SAMPLES;
        const xFraction = uCenter * 2 - 1;

        const volume = new Float32Array(LEVELS + 1);
        const centroidX = new Float32Array(LEVELS + 1);
        const centroidY = new Float32Array(LEVELS + 1);

        let accumulated = 0;
        let momentX = 0;
        let momentY = 0;

        for (let level = 1; level <= LEVELS; level++) {
          const yLow = yBottom + (span * (level - 1)) / LEVELS;
          const dy = span / LEVELS / QUADRATURE;

          for (let q = 0; q < QUADRATURE; q++) {
            const y = yLow + dy * (q + 0.5);
            const halfWidth = sectionHalfWidth(section, sectionV(section, y));
            const cellVolume = ((halfWidth * 2) / WIDTH_SAMPLES) * dy * dz;
            accumulated += cellVolume;
            momentX += halfWidth * xFraction * cellVolume;
            momentY += y * cellVolume;
          }

          volume[level] = accumulated;
          centroidX[level] = accumulated > 0 ? momentX / accumulated : 0;
          centroidY[level] = accumulated > 0 ? momentY / accumulated : yBottom;
        }

        // Level 0's centroid is not used (zero volume), but leaving it at the bottom
        // avoids a jump in the first level's interpolation.
        centroidY[0] = yBottom;

        const column: HullColumn = {
          x: sectionHalfWidth(section, sectionV(section, 0)) * xFraction,
          z: tToZ(t),
          yBottom,
          yTop,
          volume,
          centroidX,
          centroidY,
        };
        this.columns.push(column);
        designVolume += sampleColumn(column, 0).volume;
      }
    }

    this.designVolume = designVolume;
  }

  /**
   * The mass that makes the ship float exactly at the design draft.
   *
   * It comes from the same table that generates the buoyancy, and not from
   * `computeDisplacement()`: the two quadratures differ by fractions of a percent, and
   * it is exactly that difference that would show up as the ship being born a few
   * centimeters off the waterline and sinking slowly until it settled.
   */
  getDesignMass(): number {
    return this.designVolume * WATER_DENSITY;
  }

  /**
   * Applies buoyancy and vertical damping to the body. Returns telemetry about how much
   * of the hull is in the water, which the flooding and the HUD read.
   */
  apply(body: ShipBody, waves: WaveField): BuoyancyReport {
    body.localDirToWorld(_localUp, _up);
    // Capsized, the projection of the local vertical onto the world's tends to zero
    // and the division would blow up. The floor keeps the arithmetic finite and the
    // ship still receives buoyancy — it just stops having anywhere to right itself to,
    // which is correct.
    const upY = Math.max(_up.y, 0.2);

    let submerged = 0;
    let depthSum = 0;

    for (const column of this.columns) {
      _local.set(column.x, 0, column.z);
      body.localToWorld(_local, _worldPoint);

      const waterY = waves.sampleHeight(_worldPoint.x, _worldPoint.z);
      const depth = waterY - _worldPoint.y;
      depthSum += depth;

      // Local height at which this column crosses the surface: moving `s` along the
      // *ship's* vertical axis rises `s · upY` in the world.
      const crossing = depth / upY;
      const sample = sampleColumn(column, crossing);
      if (sample.volume <= 0) continue;

      submerged += sample.volume;

      _local.set(sample.x, sample.y, column.z);
      body.localToWorld(_local, _worldPoint);
      _worldArm.subVectors(_worldPoint, body.comPosition);

      // Buoyancy: always upward in the world, applied at this column's submerged
      // volume centroid. The arm to the center of mass is what becomes the righting
      // moment when the ship heels.
      _force.set(0, WATER_DENSITY * GRAVITY * sample.volume, 0);

      body.pointVelocity(_worldArm, _pointVelocity);
      _force.y -= HEAVE_DAMPING * WATER_DENSITY * sample.volume * _pointVelocity.y;

      body.applyForceAtPoint(_force, _worldPoint);
    }

    this.report.submersion = submerged / this.designVolume;
    this.report.meanDepth = depthSum / this.columns.length;
    return this.report;
  }
}

const _sample = { volume: 0, x: 0, y: 0 };

/**
 * Reads a column's table at waterline height `y`, interpolating.
 * It returns a shared object — this runs thirty times per physics step.
 */
function sampleColumn(column: HullColumn, y: number): typeof _sample {
  if (y <= column.yBottom) {
    _sample.volume = 0;
    _sample.x = column.x;
    _sample.y = column.yBottom;
    return _sample;
  }

  const span = column.yTop - column.yBottom;
  const position = clamp(((y - column.yBottom) / span) * LEVELS, 0, LEVELS);
  const index = Math.min(Math.floor(position), LEVELS - 1);
  const fraction = clamp01(position - index);

  const a = column.volume[index]!;
  const b = column.volume[index + 1]!;
  _sample.volume = a + (b - a) * fraction;
  _sample.x = column.centroidX[index]! + (column.centroidX[index + 1]! - column.centroidX[index]!) * fraction;
  _sample.y = column.centroidY[index]! + (column.centroidY[index + 1]! - column.centroidY[index]!) * fraction;
  return _sample;
}
