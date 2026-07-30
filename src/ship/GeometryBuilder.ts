/**
 * The mesh accumulator used by every part of the ship.
 *
 * It exists because almost everything on the sloop is a swept surface — hull, deck,
 * bulwark, cannon barrel — and writing a `Float32Array` by hand for each of them would be
 * the same loop copied a dozen times.
 *
 * Two decisions worth explaining:
 *
 * 1. **Every emitted strip has vertices of its own.** There is no reuse between calls, so
 *    the corner between the side and the false rail is born hard without anyone asking,
 *    while the interior of each strip stays smooth. Stitching everything into a global
 *    index would give fewer vertices and a ship that looks like melted plastic.
 *
 * 2. **The normals come out of the triangles' area.** The cross product of the sides is
 *    already proportional to the area, so summing it without normalizing weights each
 *    face by its own importance — and degenerate triangles (the keel, where the hull's
 *    two halves meet at x = 0) contribute zero and disappear on their own, instead of
 *    turning into `NaN`.
 */

import * as THREE from 'three';

/** A vertex under construction: position and UV. The normal is computed at the end. */
export interface Vertex {
  x: number;
  y: number;
  z: number;
  u: number;
  v: number;
}

export function vertex(x: number, y: number, z: number, u: number, v: number): Vertex {
  return { x, y, z, u, v };
}

export class GeometryBuilder {
  private readonly positions: number[] = [];
  private readonly uvs: number[] = [];
  private readonly indices: number[] = [];

  get vertexCount(): number {
    return this.positions.length / 3;
  }

  private push(v: Vertex): number {
    const index = this.positions.length / 3;
    this.positions.push(v.x, v.y, v.z);
    this.uvs.push(v.u, v.v);
    return index;
  }

  /** A loose triangle, in counter-clockwise order seen from outside. */
  addTriangle(a: Vertex, b: Vertex, c: Vertex): void {
    const ia = this.push(a);
    this.indices.push(ia, this.push(b), this.push(c));
  }

  /** A quad, split into two triangles. */
  addQuad(a: Vertex, b: Vertex, c: Vertex, d: Vertex): void {
    const ia = this.push(a);
    const ib = this.push(b);
    const ic = this.push(c);
    const id = this.push(d);
    this.indices.push(ia, ib, ic, ia, ic, id);
  }

  /**
   * Stitches two rows of vertices into a strip of quads.
   *
   * The rows have to be the same length. `flip` reverses the orientation — it is what
   * turns the hull's outer surface into the inner one without duplicating the function
   * that generates the points.
   */
  addStrip(rowA: readonly Vertex[], rowB: readonly Vertex[], flip = false): void {
    const count = Math.min(rowA.length, rowB.length);
    for (let i = 0; i < count - 1; i++) {
      const a = rowA[i]!;
      const b = rowA[i + 1]!;
      const c = rowB[i + 1]!;
      const d = rowB[i]!;
      if (flip) this.addQuad(d, c, b, a);
      else this.addQuad(a, b, c, d);
    }
  }

  /**
   * A parametric surface swept in two directions.
   *
   * `point(s, t)` returns the vertex; `s` runs along one direction and `t` along the
   * other, both in 0..1. It is the shape of practically the whole hull.
   */
  addSurface(
    segmentsS: number,
    segmentsT: number,
    point: (s: number, t: number) => Vertex,
    flip = false,
  ): void {
    let previous: Vertex[] | null = null;
    for (let i = 0; i <= segmentsS; i++) {
      const s = i / segmentsS;
      const row: Vertex[] = [];
      for (let j = 0; j <= segmentsT; j++) row.push(point(s, j / segmentsT));
      if (previous) this.addStrip(previous, row, flip);
      previous = row;
    }
  }

  /** An axis-aligned box, with UV in meters so the texture tiles. */
  addBox(
    center: THREE.Vector3 | { x: number; y: number; z: number },
    size: { x: number; y: number; z: number },
    uvScale = 1,
  ): void {
    const hx = size.x * 0.5;
    const hy = size.y * 0.5;
    const hz = size.z * 0.5;
    const { x, y, z } = center;

    const face = (
      corners: [number, number, number][],
      uSize: number,
      vSize: number,
    ): void => {
      const [p0, p1, p2, p3] = corners;
      this.addQuad(
        vertex(x + p0![0], y + p0![1], z + p0![2], 0, 0),
        vertex(x + p1![0], y + p1![1], z + p1![2], uSize * uvScale, 0),
        vertex(x + p2![0], y + p2![1], z + p2![2], uSize * uvScale, vSize * uvScale),
        vertex(x + p3![0], y + p3![1], z + p3![2], 0, vSize * uvScale),
      );
    };

    // +Z e -Z
    face([[-hx, -hy, hz], [hx, -hy, hz], [hx, hy, hz], [-hx, hy, hz]], size.x, size.y);
    face([[hx, -hy, -hz], [-hx, -hy, -hz], [-hx, hy, -hz], [hx, hy, -hz]], size.x, size.y);
    // +X e -X
    face([[hx, -hy, hz], [hx, -hy, -hz], [hx, hy, -hz], [hx, hy, hz]], size.z, size.y);
    face([[-hx, -hy, -hz], [-hx, -hy, hz], [-hx, hy, hz], [-hx, hy, -hz]], size.z, size.y);
    // +Y e -Y
    face([[-hx, hy, hz], [hx, hy, hz], [hx, hy, -hz], [-hx, hy, -hz]], size.x, size.z);
    face([[-hx, -hy, -hz], [hx, -hy, -hz], [hx, -hy, hz], [-hx, -hy, hz]], size.x, size.z);
  }

  /**
   * A solid of revolution around +Y, with the radius given by a profile.
   *
   * Mast, yard, cannon barrel, capstan and barrel stave are all this: a radius that
   * varies with height. `profile(h)` receives 0..1 from foot to top and returns the
   * radius in meters.
   */
  addLathe(
    base: { x: number; y: number; z: number },
    height: number,
    profile: (h: number) => number,
    options: {
      radialSegments?: number;
      heightSegments?: number;
      capBottom?: boolean;
      capTop?: boolean;
      uvScale?: number;
    } = {},
  ): void {
    const radial = options.radialSegments ?? 16;
    const rows = options.heightSegments ?? 8;
    const uvScale = options.uvScale ?? 1;

    const ring = (h: number): Vertex[] => {
      const radius = profile(h);
      const y = base.y + h * height;
      const row: Vertex[] = [];
      for (let i = 0; i <= radial; i++) {
        const angle = (i / radial) * Math.PI * 2;
        row.push(
          vertex(
            base.x + Math.cos(angle) * radius,
            y,
            base.z + Math.sin(angle) * radius,
            (i / radial) * Math.PI * 2 * Math.max(radius, 0.02) * uvScale,
            h * height * uvScale,
          ),
        );
      }
      return row;
    };

    let previous = ring(0);
    for (let i = 1; i <= rows; i++) {
      const row = ring(i / rows);
      this.addStrip(previous, row, true);
      previous = row;
    }

    if (options.capBottom) this.addDisc(base, profile(0), radial, false, uvScale);
    if (options.capTop) {
      this.addDisc({ ...base, y: base.y + height }, profile(1), radial, true, uvScale);
    }
  }

  /**
   * A cylinder (or truncated cone) between any two points.
   *
   * It is the ship's rigging piece: shrouds, stays, halyards and the anchor's own cable
   * are all this. Since the axis is arbitrary, the orthonormal basis is built on the spot
   * from whichever axis is furthest from the direction — always taking the same reference
   * vector would produce a null cross product on vertical lines, which is precisely the
   * most common case here.
   */
  addTube(
    from: THREE.Vector3,
    to: THREE.Vector3,
    radiusFrom: number,
    radiusTo = radiusFrom,
    radialSegments = 8,
    uvScale = 6,
  ): void {
    const axis = new THREE.Vector3().subVectors(to, from);
    const length = axis.length();
    if (length < 1e-6) return;
    axis.divideScalar(length);

    const reference =
      Math.abs(axis.y) < 0.9 ? new THREE.Vector3(0, 1, 0) : new THREE.Vector3(1, 0, 0);
    const u = new THREE.Vector3().crossVectors(reference, axis).normalize();
    const v = new THREE.Vector3().crossVectors(axis, u);

    const ring = (center: THREE.Vector3, radius: number, along: number): Vertex[] => {
      const row: Vertex[] = [];
      for (let i = 0; i <= radialSegments; i++) {
        const angle = (i / radialSegments) * Math.PI * 2;
        const x = center.x + u.x * Math.cos(angle) * radius + v.x * Math.sin(angle) * radius;
        const y = center.y + u.y * Math.cos(angle) * radius + v.y * Math.sin(angle) * radius;
        const z = center.z + u.z * Math.cos(angle) * radius + v.z * Math.sin(angle) * radius;
        row.push(vertex(x, y, z, (i / radialSegments) * uvScale * radius * 6, along * uvScale));
      }
      return row;
    };

    this.addStrip(ring(from, radiusFrom, 0), ring(to, radiusTo, length));
  }

  /**
   * A torus in the XY plane, with its axis along +Z.
   *
   * That is the plane because the piece that needs it is the helm's rim, which stands
   * upright facing aft and turns around the fore-and-aft axis.
   */
  addTorusZ(
    center: { x: number; y: number; z: number },
    radius: number,
    tube: number,
    radialSegments = 28,
    tubeSegments = 8,
    uvScale = 1,
  ): void {
    this.addSurface(
      radialSegments,
      tubeSegments,
      (s, t) => {
        const phi = s * Math.PI * 2;
        const theta = t * Math.PI * 2;
        const ring = radius + tube * Math.cos(theta);
        return vertex(
          center.x + ring * Math.cos(phi),
          center.y + ring * Math.sin(phi),
          center.z + tube * Math.sin(theta),
          s * Math.PI * 2 * radius * uvScale,
          t * Math.PI * 2 * tube * uvScale,
        );
      },
      true,
    );
  }

  /** A circular cap in the XZ plane, facing up (`up`) or down. */
  addDisc(
    center: { x: number; y: number; z: number },
    radius: number,
    radialSegments = 16,
    up = true,
    uvScale = 1,
  ): void {
    const middle = vertex(center.x, center.y, center.z, 0, 0);
    for (let i = 0; i < radialSegments; i++) {
      const a0 = (i / radialSegments) * Math.PI * 2;
      const a1 = ((i + 1) / radialSegments) * Math.PI * 2;
      const p0 = vertex(
        center.x + Math.cos(a0) * radius,
        center.y,
        center.z + Math.sin(a0) * radius,
        Math.cos(a0) * radius * uvScale,
        Math.sin(a0) * radius * uvScale,
      );
      const p1 = vertex(
        center.x + Math.cos(a1) * radius,
        center.y,
        center.z + Math.sin(a1) * radius,
        Math.cos(a1) * radius * uvScale,
        Math.sin(a1) * radius * uvScale,
      );
      // The angle grows from +X toward +Z, so the direct order gives a downward normal;
      // reversing the order is what makes `up` mean what its name says.
      if (up) this.addTriangle(middle, p1, p0);
      else this.addTriangle(middle, p0, p1);
    }
  }

  /** Applies a transform to everything accumulated from `from` onward. */
  transformFrom(fromVertex: number, matrix: THREE.Matrix4): void {
    const p = new THREE.Vector3();
    for (let i = fromVertex; i < this.vertexCount; i++) {
      p.set(this.positions[i * 3]!, this.positions[i * 3 + 1]!, this.positions[i * 3 + 2]!);
      p.applyMatrix4(matrix);
      this.positions[i * 3] = p.x;
      this.positions[i * 3 + 1] = p.y;
      this.positions[i * 3 + 2] = p.z;
    }
  }

  /**
   * Closes the mesh and computes the area-weighted normals.
   *
   * It does not use three's `computeVertexNormals` for one reason only: it normalizes
   * each face's normal before summing, which gives equal weight to a huge triangle and to
   * a sliver — and at the keel, where the triangles have zero area, normalizing produces
   * a `NaN` that spreads to the neighbors.
   */
  toGeometry(): THREE.BufferGeometry {
    const count = this.vertexCount;
    const normals = new Float32Array(count * 3);
    const pos = this.positions;

    for (let i = 0; i < this.indices.length; i += 3) {
      const ia = this.indices[i]! * 3;
      const ib = this.indices[i + 1]! * 3;
      const ic = this.indices[i + 2]! * 3;

      const ax = pos[ib]! - pos[ia]!;
      const ay = pos[ib + 1]! - pos[ia + 1]!;
      const az = pos[ib + 2]! - pos[ia + 2]!;
      const bx = pos[ic]! - pos[ia]!;
      const by = pos[ic + 1]! - pos[ia + 1]!;
      const bz = pos[ic + 2]! - pos[ia + 2]!;

      const nx = ay * bz - az * by;
      const ny = az * bx - ax * bz;
      const nz = ax * by - ay * bx;

      for (const index of [ia, ib, ic]) {
        normals[index] += nx;
        normals[index + 1] += ny;
        normals[index + 2] += nz;
      }
    }

    for (let i = 0; i < count; i++) {
      const length = Math.hypot(normals[i * 3]!, normals[i * 3 + 1]!, normals[i * 3 + 2]!);
      if (length > 1e-9) {
        normals[i * 3] /= length;
        normals[i * 3 + 1] /= length;
        normals[i * 3 + 2] /= length;
      } else {
        // A vertex that only takes part in degenerate triangles: any normal will do, and
        // up is the one that draws the least attention.
        normals[i * 3 + 1] = 1;
      }
    }

    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(new Float32Array(pos), 3));
    geometry.setAttribute('normal', new THREE.BufferAttribute(normals, 3));
    const uv = new THREE.BufferAttribute(new Float32Array(this.uvs), 2);
    geometry.setAttribute('uv', uv);
    // A second set for the `aoMap`, which three samples through `uv1`.
    geometry.setAttribute('uv1', uv);
    geometry.setIndex(this.indices);
    geometry.computeBoundingSphere();
    return geometry;
  }
}
