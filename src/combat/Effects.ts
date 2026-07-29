/**
 * Fumaça, respingo, lasca e clarão — tudo o que o combate cospe no ar.
 *
 * **Uma malha por camada, não um objeto por partícula.** Um bordo inteiro de
 * canhonaço põe umas 300 baforadas no ar; 300 `Sprite` seriam 300 chamadas de
 * desenho e 300 nós na cena. Aqui são duas `InstancedBufferGeometry` — uma
 * translúcida normal (fumaça, respingo, lasca) e uma aditiva (o clarão da boca
 * e o brilho da pólvora) — e cada quadro sobe um pedaço de buffer com só as
 * partículas vivas.
 *
 * **O billboard é feito no vertex shader**, lendo os eixos da câmera direto da
 * `viewMatrix`. Sai de graça e evita o que o `Sprite` do three faz: recalcular
 * uma matriz por partícula na CPU.
 *
 * **Sem névoa.** A névoa da cena é `FogExp2` com densidade 1/3200, o que a 200 m
 * — o dobro do alcance útil de tiro — deixa 99,6% da cor passar. Somar o cálculo
 * aos dois shaders custaria mais do que o efeito que ninguém veria.
 */

import * as THREE from 'three';
import { createRandom } from '../core/MathUtils';
import { createPuffTexture } from '../textures/ProceduralTextures';

/** Partículas simultâneas na camada translúcida. */
const SMOKE_CAPACITY = 900;
/** E na aditiva, que é sempre um punhado por disparo. */
const GLOW_CAPACITY = 220;

/**
 * Arrasto do ar sobre uma baforada, por segundo.
 *
 * Fumaça é leve e para rápido: em meio segundo ela perde quase toda a
 * velocidade de saída e passa a só subir e crescer.
 */
const SMOKE_DRAG = 2.6;

const VERTEX_SHADER = /* glsl */ `
  attribute vec3 aOffset;
  attribute vec3 aParams;  // x tamanho, y alfa, z rotação
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

    // Colunas da viewMatrix transpostas = eixos da câmera no mundo. A malha fica
    // parada na origem, então não há modelMatrix para atrapalhar.
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
    // Corte cedo: com centenas de quads empilhados, o pixel quase transparente
    // custa o mesmo que o opaco e não aparece.
    if (alpha < 0.004) discard;
    gl_FragColor = vec4(vTint * texel.rgb, alpha);
  }
`;

export interface EmitOptions {
  position: THREE.Vector3;
  velocity: THREE.Vector3;
  /** Cor multiplicada pelo sprite. */
  tint: THREE.Color;
  /** Raio inicial em metros. */
  size: number;
  /** Crescimento do raio, em metros por segundo. */
  growth: number;
  /** Segundos de vida. */
  life: number;
  /** Opacidade no nascimento; cai a zero no fim da vida. */
  alpha: number;
  /** Frenagem exponencial, por segundo. */
  drag: number;
  /** Empuxo vertical, em m/s². Positivo sobe (fumaça), negativo cai (água). */
  rise: number;
  /** Giro, em rad/s. */
  spin: number;
}

/**
 * Uma camada de partículas com um modo de mistura.
 *
 * As partículas vivas ficam sempre no começo dos arrays: quando uma morre, a
 * última viva toma o lugar dela. Isso mantém o pedaço a enviar para a GPU
 * contíguo e dispensa varrer buracos.
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

    // O quad é escrito à mão em vez de emprestado de um `PlaneGeometry`: os
    // atributos seriam compartilhados, e descartar a geometria emprestada
    // derrubaria os buffers que esta ainda usa.
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
      // Sem escrita de profundidade: partícula translúcida que escreve no
      // z-buffer recorta a de trás e a fumaça vira um mosaico de quadrados.
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
   * Nasce uma partícula. Com a camada cheia, o pedido é ignorado — perder uma
   * baforada num bordo de 300 é invisível; travar para abrir espaço, não.
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

  /** Integra e sobe os buffers. Roda no tempo de render, não no passo fixo. */
  update(dt: number): void {
    const offsets = this.offsets.array as Float32Array;
    const params = this.params.array as Float32Array;

    for (let i = 0; i < this.count; ) {
      this.age[i]! += dt;
      if (this.age[i]! >= this.life[i]!) {
        this.remove(i);
        continue;
      }

      // Frenagem exponencial exata, e não `v -= v*k*dt`: a fumaça de canhão sai
      // a 14 m/s e a forma explícita explodiria com quadros longos.
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
      // Sobe rápido e some devagar: é o perfil de uma baforada de pólvora, que
      // aparece de estalo e depois se dissolve.
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

    // Só o prefixo vivo sobe para a GPU; o resto do buffer é lixo antigo que
    // `instanceCount` já manda o driver ignorar.
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

  /** Tira a partícula `i` trazendo a última viva para o lugar dela. */
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
  /** Acumulador do rastro, para o cadenciar por distância e não por quadro. */
  private trailClock = 0;

  constructor(scene: THREE.Scene) {
    this.texture = createPuffTexture();
    this.smoke = new ParticleLayer(SMOKE_CAPACITY, this.texture, THREE.NormalBlending);
    this.glow = new ParticleLayer(GLOW_CAPACITY, this.texture, THREE.AdditiveBlending);

    this.smoke.mesh.name = 'particles-smoke';
    this.glow.mesh.name = 'particles-glow';
    scene.add(this.smoke.mesh, this.glow.mesh);
  }

  /** Partículas vivas nas duas camadas — o overlay de depuração lê daqui. */
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
   * O tiro: clarão na boca, jato de fumaça na direção do cano e a nuvem que fica
   * boiando ao lado do navio por uns segundos.
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

    // O jato: rápido, colado no eixo do cano, com abertura pequena.
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

    // E a nuvem lenta que sobra na amurada, que é o que denuncia de onde veio o
    // tiro quando se olha o outro navio de longe.
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
   * A bala entrando na água: coluna branca para cima e névoa em volta.
   *
   * O tamanho vem da velocidade de impacto, então tiro curto faz espirrinho e
   * tiro longo, que chega mergulhando forte, levanta a coluna inteira.
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
        // Gotícula não flutua: cai, e cair é o que dá o arco do respingo.
        drag: 0.7,
        rise: -7.5,
        spin: this.signed(2),
      });
    }

    // O anel de espuma que fica na superfície depois que a coluna cai.
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

  /** A bala entrando na madeira: o clarão do impacto e a lasca que salta dele. */
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
   * Lascas e poeira de serragem saltando da madeira arrebentada.
   *
   * Separada de `woodImpact` porque a bala não é a única coisa que arranca tábua: um
   * abalroamento também, e ele **não** tem clarão de pólvora — o clarão é o metal
   * quente entrando, não a madeira cedendo. Pôr o mesmo efeito nos dois daria uma
   * faísca em cada encostão de casco.
   *
   * @param power força do estrago, 0..1,5. É força e não velocidade porque as duas
   *   causas vivem em escalas diferentes: uma bala chega a 70 m/s e dois cascos se
   *   encontram a 3, e o que se quer nos dois casos é a mesma lasca voando.
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
   * A água entrando por um rombo, vista de dentro do porão.
   *
   * A vazão decide quantas gotas e com que força — um furo raso goteja, um
   * rombo fundo esguicha, e a diferença é lida sem precisar de número na tela.
   */
  waterJet(position: THREE.Vector3, direction: THREE.Vector3, inflow: number): void {
    if (inflow <= 0) return;
    // Cadência proporcional à vazão, sorteada por quadro para não amarrar o
    // efeito à taxa de quadros.
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
   * O rastro da bala.
   *
   * Cadenciado por tempo acumulado (`trailClock`), e não uma baforada por
   * quadro: a 144 Hz o rastro viraria uma corda sólida, e a 30 Hz, pontilhado.
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

  /** Fecha a janela do rastro. Chamado depois de percorrer todas as balas. */
  endTrailWindow(): void {
    if (this.trailClock >= 0.028) this.trailClock = 0;
  }

  /** Espalha um vetor com ruído isotrópico de amplitude `amount`. */
  private scatter(target: THREE.Vector3, amount: number): void {
    target.x += this.signed(amount);
    target.y += this.signed(amount);
    target.z += this.signed(amount);
  }

  private signed(amount: number): number {
    return (this.random() * 2 - 1) * amount;
  }
}
