/**
 * Acumulador de malha usado por todas as peças do navio.
 *
 * Existe porque quase tudo na Chalupa é uma superfície varrida — casco, convés,
 * amurada, cano de canhão — e escrever `Float32Array` na mão para cada uma delas
 * seria o mesmo laço copiado uma dúzia de vezes.
 *
 * Duas decisões que valem a explicação:
 *
 * 1. **Cada faixa emitida tem vértices próprios.** Não há reuso entre chamadas,
 *    então a quina entre o costado e a borda falsa nasce dura sem ninguém pedir,
 *    enquanto o interior de cada faixa continua suave. Costurar tudo num índice
 *    global daria menos vértices e um navio com aparência de plástico derretido.
 *
 * 2. **As normais saem da área dos triângulos.** O produto vetorial dos lados já
 *    é proporcional à área, então somá-lo sem normalizar pondera cada face pela
 *    própria importância — e triângulos degenerados (a quilha, onde as duas
 *    metades do casco se encontram em x = 0) contribuem com zero e somem
 *    sozinhos, em vez de virarem `NaN`.
 */

import * as THREE from 'three';

/** Um vértice em construção: posição e UV. A normal é calculada no fim. */
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

  /** Triângulo avulso, na ordem anti-horária vista de fora. */
  addTriangle(a: Vertex, b: Vertex, c: Vertex): void {
    const ia = this.push(a);
    this.indices.push(ia, this.push(b), this.push(c));
  }

  /** Quadrilátero, dividido em dois triângulos. */
  addQuad(a: Vertex, b: Vertex, c: Vertex, d: Vertex): void {
    const ia = this.push(a);
    const ib = this.push(b);
    const ic = this.push(c);
    const id = this.push(d);
    this.indices.push(ia, ib, ic, ia, ic, id);
  }

  /**
   * Costura duas fileiras de vértices numa faixa de quadriláteros.
   *
   * As fileiras precisam ter o mesmo comprimento. `flip` inverte a orientação —
   * é o que transforma a superfície externa do casco na interna sem duplicar a
   * função que gera os pontos.
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
   * Superfície paramétrica varrida em duas direções.
   *
   * `point(s, t)` devolve o vértice; `s` corre ao longo de uma direção e `t` da
   * outra, ambos em 0..1. É a forma de praticamente todo o casco.
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

  /** Caixa alinhada aos eixos, com UV em metros para a textura ladrilhar. */
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
   * Sólido de revolução em torno de +Y, com o raio dado por um perfil.
   *
   * Mastro, verga, cabo de canhão, cabrestante e aduela de barril são todos
   * isto: um raio que varia com a altura. `profile(h)` recebe 0..1 do pé ao topo
   * e devolve o raio em metros.
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
   * Cilindro (ou tronco de cone) entre dois pontos quaisquer.
   *
   * É a peça de cordame do navio: enxárcias, estais, adriças e as próprias
   * amarras da âncora são todas isto. Como o eixo é arbitrário, a base ortonormal
   * é construída na hora a partir do eixo mais distante da direção — pegar sempre
   * o mesmo vetor de referência produziria produto vetorial nulo em cabos
   * verticais, que é justamente o caso mais comum aqui.
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
   * Toro no plano XY, com eixo em +Z.
   *
   * O plano é esse porque a peça que precisa dele é o aro do timão, que fica em
   * pé virado para a popa e gira em torno do eixo proa-popa.
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

  /** Tampa circular no plano XZ, virada para cima (`up`) ou para baixo. */
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
      // O ângulo cresce de +X para +Z, então a ordem direta dá a normal para
      // baixo; virar a ordem é o que faz `up` significar o que o nome diz.
      if (up) this.addTriangle(middle, p1, p0);
      else this.addTriangle(middle, p0, p1);
    }
  }

  /** Aplica uma transformação a tudo que já foi acumulado a partir de `from`. */
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
   * Fecha a malha e calcula as normais ponderadas por área.
   *
   * Não usa `computeVertexNormals` do three só por um motivo: ele normaliza a
   * normal de cada face antes de somar, o que dá peso igual a um triângulo
   * enorme e a uma lasca — e na quilha, onde os triângulos têm área zero,
   * normalizar produz `NaN` que se espalha para os vizinhos.
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
        // Vértice que só participa de triângulos degenerados: qualquer normal
        // serve, e para cima é a que menos chama atenção.
        normals[i * 3 + 1] = 1;
      }
    }

    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(new Float32Array(pos), 3));
    geometry.setAttribute('normal', new THREE.BufferAttribute(normals, 3));
    const uv = new THREE.BufferAttribute(new Float32Array(this.uvs), 2);
    geometry.setAttribute('uv', uv);
    // Segundo conjunto para o `aoMap`, que o three amostra por `uv1`.
    geometry.setAttribute('uv1', uv);
    geometry.setIndex(this.indices);
    geometry.computeBoundingSphere();
    return geometry;
  }
}
