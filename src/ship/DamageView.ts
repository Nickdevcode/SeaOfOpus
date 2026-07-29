/**
 * O que se **vê** do estrago: os rombos no costado e a água subindo no porão.
 *
 * Duas peças, com truques opostos que usam a mesma tabela.
 *
 * **A água do porão** é um plano horizontal no mundo — tem que ser, senão ela
 * adernaria junto com o navio e denunciaria a farsa na primeira onda. Como um
 * plano é infinito e o porão não, o fragmento converte a própria posição para o
 * referencial do navio e se descarta quando cai fora do forro. É exatamente o
 * recorte que o oceano faz em `hullClip`, **de sinal trocado**: lá o mar some
 * dentro do casco, aqui a água só existe dentro do casco. As duas leem a mesma
 * textura de perfil, então nunca vão discordar sobre onde fica a tábua.
 *
 * **As marcas de tiro** são instâncias presas ao modelo do navio, orientadas
 * pela normal do casco naquele ponto e desenhadas por `BreachDecal`. Não são
 * decalques de verdade (projeção sobre a malha): num costado curvo, a diferença
 * entre uma marca encostada na superfície e um decalque projetado é de
 * milímetros, e a instância custa uma entrada de matriz em vez de um passo de
 * renderização inteiro.
 *
 * **Cada rombo tem duas marcas, e não uma.** O costado tem 13 cm de espessura e
 * forro dos dois lados, então uma bala que o atravessa deixa marca no mar *e* no
 * porão. Desenhar só a de fora era o defeito mais estranho que este arquivo já
 * teve: o jogador descia para tapar o rombo e encontrava uma parede intacta, e
 * conseguia pregar a tábua assim mesmo porque a mira do reparo é por ângulo, não
 * por raio. O buraco funcionava sem existir.
 *
 * As duas faces não são espelho uma da outra. Na entrada manda a pólvora
 * (fuligem, borda chamuscada); na saída manda a fibra (lasca grande, carvalho
 * cru, o fundo molhado da água que entra) — ver `BreachFace`, em `BreachDecal`.
 *
 * A mesma malha serve rombo aberto e rombo tapado — muda um atributo. Um casco
 * que já apanhou muito é uma colcha de marcas fechadas com uma ou outra ainda
 * escancarada, e essa leitura só existe porque as duas coisas são a mesma
 * coisa em estados diferentes. Ela vale para os dois lados: por dentro, a tábua
 * é estreita demais para cobrir o rombo inteiro, e o que sobra da cicatriz
 * escapa pelas beiradas dela.
 *
 * **As tábuas** são o que se prega por cima da marca fechada, uma por reparo.
 * Elas chegam pelo `PlankAsset`, que é assíncrono, então o pool nasce vazio e
 * se monta quando o arquivo cai — se ele nunca cair, o rombo continua fechando
 * e o casco fica com a cicatriz sem a madeira.
 */

import * as THREE from 'three';
import { NOISE_GLSL } from '../shaders/noise';
import { HULL_PROFILE, getHullProfileTexture } from '../shaders/hullClip';
import { buildBreachGeometry, createBreachMaterial, type BreachSide } from './BreachDecal';
import { PLANK_TO_DECAL, PLANK_THICKNESS, loadPlank } from './PlankAsset';
import { DECK_Y, HALF_LENGTH, HULL_LENGTH, HULL_THICKNESS } from './ShipDimensions';
import type { Ship } from './Ship';

/**
 * Marcas desenhadas ao mesmo tempo por navio.
 *
 * Cobre rombos abertos **e** tapados no mesmo pool: `ShipDamage` limita cada
 * lista a 24, mas as duas somadas passariam disso num combate longo. Quando
 * estoura, os rombos abertos entram primeiro — é neles que o jogador precisa
 * reparar, e uma cicatriz que some do outro bordo não custa nada.
 */
const MAX_SCARS = 32;

/**
 * Lado do plano d'água, em metros.
 *
 * Cobre o casco (16 × 5 m) em qualquer proa sem precisar girar junto: a diagonal
 * do casco é 16,8 m, e o plano é quadrado.
 */
const WATER_PLANE_SIZE = 18;

const WATER_VERTEX = /* glsl */ `
  varying vec3 vWorldPosition;

  void main() {
    vec4 world = modelMatrix * vec4(position, 1.0);
    vWorldPosition = world.xyz;
    gl_Position = projectionMatrix * viewMatrix * world;
  }
`;

const WATER_FRAGMENT = /* glsl */ `
  uniform mat4 uShipInverse;
  uniform sampler2D uHullProfile;
  uniform float uTime;
  uniform vec3 uShallowColor;
  uniform vec3 uDeepColor;

  varying vec3 vWorldPosition;

  ${NOISE_GLSL}

  void main() {
    vec3 local = (uShipInverse * vec4(vWorldPosition, 1.0)).xyz;

    vec2 uv = vec2(
      (${HALF_LENGTH.toFixed(4)} - local.z) / ${HULL_LENGTH.toFixed(4)},
      (local.y - (${HULL_PROFILE.yMin.toFixed(4)})) / ${HULL_PROFILE.yRange.toFixed(4)}
    );
    if (any(lessThan(uv, vec2(0.0))) || any(greaterThan(uv, vec2(1.0)))) discard;

    // A margem entra **subtraindo** aqui: o mar cresce para cobrir o forro, esta
    // água encolhe para não vazar por fora dele. Mesma tabela, sinal trocado.
    float halfWidth = texture2D(uHullProfile, uv).r * ${HULL_PROFILE.scale.toFixed(4)};
    if (halfWidth <= 0.0 || abs(local.x) > halfWidth - ${HULL_PROFILE.margin.toFixed(4)}) discard;

    // Passou do convés, o navio já está afundando e o que se vê é o mar de fora,
    // não a água de dentro — deixar desenhar aqui só criaria uma folha de água
    // atravessando o tombadilho.
    if (local.y > ${(DECK_Y + 0.1).toFixed(3)}) discard;

    // Marulho: duas camadas de ruído andando em sentidos diferentes, no
    // referencial **do navio**, porque a água balança junto com o casco.
    float ripple = fbm(vec3(local.xz * 1.7 + vec2(uTime * 0.35, -uTime * 0.22), uTime * 0.25), 3, 2.1, 0.55);
    float sheen = smoothstep(0.55, 0.95, ripple);

    // Fundo escuro nas bordas, onde a lâmina encosta no forro e some na sombra.
    float edge = smoothstep(halfWidth, halfWidth * 0.45, abs(local.x));
    vec3 color = mix(uShallowColor, uDeepColor, edge * 0.8);
    color += sheen * 0.16;

    gl_FragColor = vec4(color, 0.82);
  }
`;

/**
 * Quanto a marca fica afastada do costado, em metros.
 *
 * Um centímetro. O `polygonOffset` do material já resolve o z-fighting; isto
 * aqui existe porque o costado é **curvo** e a marca é plana: sem a folga, uma
 * marca de 90 cm de vão pregada numa quina de bochecha afundaria pelas bordas.
 */
const DECAL_LIFT = 0.012;

/**
 * Quanto a marca de dentro é maior que a de fora.
 *
 * A bala não abre um cilindro: ela entra por um furo e sai por um cone. A face
 * de saída é sempre a maior das duas, e 12% é o bastante para o olho registrar
 * a diferença quando compara os dois lados do mesmo rombo sem que ela vire
 * caricatura.
 */
const INNER_SCAR_SCALE = 1.12;

/**
 * Onde fica a marca de dentro, medida a partir da superfície **externa**.
 *
 * O forro interno está a `HULL_THICKNESS` para dentro (ver `buildInnerShell`, em
 * `HullGeometry`), e a marca tem de ficar **além** dele, do lado do porão — daí
 * a soma. Subtrair era o erro óbvio de escrever, e o sintoma dele foi didático:
 * a marca ficava enterrada 1 cm dentro da madeira, e o que se via no porão eram
 * só as lascas altas o bastante para furar o forro — um anel de madeira boiando
 * na parede, sem miolo e sem base. Uma cicatriz já fechada, cujas lascas são
 * baixas, sumia por inteiro.
 *
 * São **dois** valores porque a tábua do reparo passa por aqui. Com o rombo
 * aberto não há nada na frente e a marca usa a mesma folga generosa da face
 * externa. Com ele tapado, a face da tábua está a 6 mm do forro (ver
 * `PLANK_DEPTH`) e a marca tem de caber nessa fresta: 2 mm, contando com o
 * `polygonOffset` do material para o resto.
 */
const INNER_DECAL_DEPTH_OPEN = HULL_THICKNESS + DECAL_LIFT;
const INNER_DECAL_DEPTH_CLOSED = HULL_THICKNESS + 0.002;

/**
 * Onde fica o **centro** da tábua, medido para **dentro** do casco.
 *
 * A tábua é pregada do lado de dentro, e não do lado de fora, porque é ali que
 * o jogador está quando prega: ele desce ao porão, fica de frente para o forro
 * e segura o botão. Uma tábua do lado de fora seria um reparo que só o inimigo
 * enxerga — quem fez o trabalho nunca veria o próprio trabalho.
 *
 * A conta é a espessura do costado (o `local` do rombo mora na superfície
 * **externa**), mais meia tábua, mais 6 mm de folga para a madeira nova não
 * brigar com o forro no z-buffer.
 */
const PLANK_DEPTH = HULL_THICKNESS + PLANK_THICKNESS * 0.5 + 0.006;

/**
 * Giro máximo da tábua em torno da normal, em radianos.
 *
 * ±23°. Uma tábua pregada às pressas nunca sai reta, mas também não sai em pé:
 * quem tapa rombo põe a peça **atravessada** no furo, acompanhando de longe o
 * tabuado do costado, porque é assim que ela pega madeira sã dos dois lados.
 */
const PLANK_ROLL = 0.4;

/** Escorregamento da tábua em relação ao centro do rombo, em metros. */
const PLANK_SLIDE = 0.07;

const _inverse = new THREE.Matrix4();
const _quaternion = new THREE.Quaternion();
const _roll = new THREE.Quaternion();
const _matrix = new THREE.Matrix4();
const _basis = new THREE.Matrix4();
const _scale = new THREE.Vector3();
const _position = new THREE.Vector3();
const _normal = new THREE.Vector3();
const _flipped = new THREE.Vector3();
const _tangent = new THREE.Vector3();
const _bitangent = new THREE.Vector3();
const UP = new THREE.Vector3(0, 1, 0);
const ALONG = new THREE.Vector3(0, 0, 1);
const HIDDEN = new THREE.Vector3(0, 0, 0);
const ORIGIN = new THREE.Vector3(0, 0, 0);
const UNIT = new THREE.Vector3(1, 1, 1);

/**
 * Raio desenhado de um rombo de `area` metros quadrados.
 *
 * O 3,4 é o que separa o furo por onde a água entra da **marca** que a bala
 * deixa em volta dele: a área é hidráulica, e a mancha de fuligem e madeira
 * lascada é bem maior que ela. Ver a divisão em zonas de `BreachDecal`.
 */
function scarRadius(area: number): number {
  return Math.sqrt(area / Math.PI) * 3.4;
}

/**
 * Sorteio estável a partir do identificador do rombo.
 *
 * Estável é o requisito: a pose da tábua é recalculada em todo quadro, e um
 * `Math.random()` aqui faria a madeira tremer no costado. Como o `id` do rombo
 * viaja para o `Patch` que o substitui, a tábua também nasce exatamente na pose
 * que o desenho do rombo já vinha semeando.
 */
function hash01(seed: number): number {
  const value = Math.sin(seed * 127.1 + 311.7) * 43758.5453;
  return value - Math.floor(value);
}

/**
 * O pool de marcas de **uma** das faces do costado.
 *
 * Existe porque o rombo é atravessado: a bala entra por fora e sai por dentro, e
 * as duas faces são desenhadas por instâncias independentes. Malhas separadas em
 * vez de um pool só com o dobro de instâncias porque as duas faces rodam shaders
 * diferentes — a de dentro lasca mais, escurece menos e molha o fundo do furo —
 * e um `InstancedMesh` só carrega um material.
 *
 * O custo é uma chamada de desenho a mais por navio, o que a esta escala não se
 * mede; o que se ganha é que cada face escolhe as próprias constantes sem
 * ramificação no shader do outro.
 */
class ScarPool {
  readonly mesh: THREE.InstancedMesh;
  /** Semente por instância: varia fuligem e fibra de uma marca para a outra. */
  private readonly seed: THREE.InstancedBufferAttribute;
  /** `1` rombo aberto, `0` rombo tapado. Lido pelo shader da marca. */
  private readonly open: THREE.InstancedBufferAttribute;

  constructor(name: string, side: BreachSide) {
    const geometry = buildBreachGeometry();
    this.seed = new THREE.InstancedBufferAttribute(new Float32Array(MAX_SCARS), 1);
    this.open = new THREE.InstancedBufferAttribute(new Float32Array(MAX_SCARS), 1);
    geometry.setAttribute('aSeed', this.seed);
    geometry.setAttribute('aOpen', this.open);

    this.mesh = new THREE.InstancedMesh(geometry, createBreachMaterial(side), MAX_SCARS);
    this.mesh.name = name;
    this.mesh.frustumCulled = false;
    // As lascas sobem do costado e projetariam sombra de recorte no próprio
    // casco; o que se ganharia em relevo se perderia em manchas moles.
    this.mesh.castShadow = false;
    this.mesh.receiveShadow = true;
    this.mesh.count = MAX_SCARS;
    hideAll(this.mesh, MAX_SCARS);
  }

  write(index: number, radius: number, open: number, id: number): void {
    _scale.setScalar(radius);
    this.mesh.setMatrixAt(index, _matrix.compose(_position, _quaternion, _scale));
    // A semente sai do **id do rombo**, e não do índice da instância: as duas
    // faces do mesmo furo têm de sortear a mesma silhueta, senão a borda
    // quebrada de dentro não bate com a de fora e o buraco deixa de ser um
    // buraco só, atravessado, para virar duas marcas coladas nas costas uma da
    // outra. É também o que impede a marca de trocar de cara quando um rombo
    // vizinho fecha e todo mundo anda uma posição no pool.
    this.seed.setX(index, hash01(id));
    this.open.setX(index, open);
  }

  /** Encolhe a zero tudo daí para a frente e sobe as três listas para a GPU. */
  flush(from: number): void {
    for (let i = from; i < MAX_SCARS; i++) {
      this.mesh.setMatrixAt(i, _matrix.compose(ORIGIN, _quaternion.identity(), HIDDEN));
    }
    this.mesh.instanceMatrix.needsUpdate = true;
    this.seed.needsUpdate = true;
    this.open.needsUpdate = true;
  }

  dispose(): void {
    this.mesh.geometry.dispose();
    (this.mesh.material as THREE.Material).dispose();
    this.mesh.removeFromParent();
    this.mesh.dispose();
  }
}

export class DamageView {
  private readonly water: THREE.Mesh;
  private readonly waterMaterial: THREE.ShaderMaterial;
  /** A marca vista do mar: por onde a bala entrou. */
  private readonly outerScars: ScarPool;
  /** A marca vista do porão: por onde ela saiu, e é onde o jogador conserta. */
  private readonly innerScars: ScarPool;
  /** Só existe depois que o glb da tábua chega — e pode nunca chegar. */
  private planks: THREE.InstancedMesh | null = null;
  private disposed = false;
  private time = 0;

  constructor(
    private readonly ship: Ship,
    scene: THREE.Scene,
  ) {
    this.waterMaterial = new THREE.ShaderMaterial({
      uniforms: {
        uShipInverse: { value: new THREE.Matrix4() },
        uHullProfile: { value: getHullProfileTexture() },
        uTime: { value: 0 },
        uShallowColor: { value: new THREE.Color(0.05, 0.13, 0.14) },
        uDeepColor: { value: new THREE.Color(0.01, 0.04, 0.05) },
      },
      vertexShader: WATER_VERTEX,
      fragmentShader: WATER_FRAGMENT,
      transparent: true,
      // Frente e verso: quem está no porão com água pela cintura vê a lâmina por
      // baixo, e ela precisa continuar existindo.
      side: THREE.DoubleSide,
      depthWrite: false,
    });

    this.water = new THREE.Mesh(
      new THREE.PlaneGeometry(WATER_PLANE_SIZE, WATER_PLANE_SIZE),
      this.waterMaterial,
    );
    this.water.rotation.x = -Math.PI / 2;
    this.water.name = `${ship.name}-hold-water`;
    this.water.frustumCulled = false;
    this.water.visible = false;
    this.water.renderOrder = 2;
    scene.add(this.water);

    this.outerScars = new ScarPool(`${ship.name}-breaches`, 'outer');
    this.innerScars = new ScarPool(`${ship.name}-breaches-inner`, 'inner');
    ship.model.root.add(this.outerScars.mesh, this.innerScars.mesh);

    void this.attachPlanks();
  }

  update(dt: number): void {
    this.time += dt;
    this.updateWater();
    this.updateScars();
  }

  dispose(): void {
    this.disposed = true;
    this.water.geometry.dispose();
    this.waterMaterial.dispose();
    this.water.removeFromParent();
    this.outerScars.dispose();
    this.innerScars.dispose();
    if (this.planks) {
      // A geometria e o material são do módulo, e o outro navio ainda os usa:
      // aqui só se solta a instância.
      this.planks.removeFromParent();
      this.planks.dispose();
      this.planks = null;
    }
  }

  /**
   * Monta o pool de tábuas quando o arquivo chega.
   *
   * A guarda de `disposed` não é zelo: uma partida abandonada antes de os
   * 64 KB caírem penduraria a malha num navio que já saiu da cena, e ela
   * ficaria viva pela referência do pai até o fim do processo.
   */
  private async attachPlanks(): Promise<void> {
    const asset = await loadPlank();
    if (!asset || this.disposed) return;

    this.planks = new THREE.InstancedMesh(asset.geometry, asset.material, MAX_SCARS);
    this.planks.name = `${this.ship.name}-patches`;
    this.planks.frustumCulled = false;
    this.planks.castShadow = true;
    this.planks.receiveShadow = true;
    this.planks.count = MAX_SCARS;
    hideAll(this.planks, MAX_SCARS);
    this.ship.model.root.add(this.planks);
  }

  private updateWater(): void {
    const surface = this.ship.damage.getWorldSurfaceY(this.ship.body);
    if (!Number.isFinite(surface)) {
      this.water.visible = false;
      return;
    }

    // O plano segue o navio em X/Z mas ignora a rotação dele: água é horizontal.
    const root = this.ship.model.root;
    this.water.visible = true;
    this.water.position.set(root.position.x, surface, root.position.z);
    this.water.updateMatrixWorld();

    // A matriz do modelo é a pose **interpolada** do quadro, e não a do último
    // passo de física: usar a do corpo faria a lâmina tremer contra o forro em
    // taxas de quadro altas. `updateWorldMatrix` sobe a cadeia sem descer nos
    // filhos porque `syncModel` só escreve posição e quaternion — o
    // `matrixWorld` ainda é o que o render do quadro *anterior* deixou, e ler
    // ele atrasaria a lâmina um quadro contra o forro.
    root.updateWorldMatrix(true, false);
    _inverse.copy(root.matrixWorld).invert();
    (this.waterMaterial.uniforms.uShipInverse!.value as THREE.Matrix4).copy(_inverse);
    this.waterMaterial.uniforms.uTime!.value = this.time;
  }

  /**
   * Escreve as marcas do quadro: primeiro os rombos abertos, depois as
   * cicatrizes com tábua.
   *
   * Os abertos vêm antes porque são eles que disputam o teto de `MAX_SCARS` —
   * um rombo que o jogador precisa achar não pode sumir para dar lugar a um
   * remendo velho.
   */
  private updateScars(): void {
    const { breaches, patches } = this.ship.damage;
    let index = 0;
    let plankIndex = 0;

    for (const breach of breaches) {
      if (index >= MAX_SCARS) break;
      // O furo encolhe um pouco conforme a tábua vai sendo pregada, mas não
      // fecha: o que fecha o rombo é a madeira que chega no fim, e o
      // encolhimento existe só para o esforço aparecer no casco antes disso.
      const radius = scarRadius(breach.area) * (1 - breach.repair * 0.18);
      this.writeScar(index++, breach.local, breach.normal, radius, 1, breach.id);
    }

    for (const patch of patches) {
      if (index >= MAX_SCARS) break;
      const radius = scarRadius(patch.area);
      this.writeScar(index++, patch.local, patch.normal, radius, 0, patch.id);
      if (this.planks) this.writePlank(plankIndex++, patch.local, patch.normal, patch.id);
    }

    this.outerScars.flush(index);
    this.innerScars.flush(index);

    if (!this.planks) return;
    for (let i = plankIndex; i < MAX_SCARS; i++) {
      this.planks.setMatrixAt(i, _matrix.compose(ORIGIN, _quaternion.identity(), HIDDEN));
    }
    this.planks.instanceMatrix.needsUpdate = true;
  }

  /**
   * Escreve as **duas** faces do mesmo rombo: a que o mar vê e a que o porão vê.
   *
   * Uma bala que abre rombo atravessa o costado, e um costado tem 13 cm de
   * espessura com forro dos dois lados. Desenhar só a face de fora deixava o
   * jogador olhando para uma parede intacta exatamente no lugar em que ele
   * precisa pregar a tábua — e a mira do reparo, que é por ângulo e não por
   * raio, deixava consertar assim mesmo. O rombo funcionava sem existir.
   *
   * A face de dentro nasce da mesma `local` e da mesma `normal`, com o sinal
   * trocado: `orientDecal` recebe a normal invertida e devolve uma base que
   * continua com o X no tabuado e o Y para cima (as duas inversões se cancelam
   * no produto vetorial), então a fibra da madeira segue correndo no sentido
   * certo do casco e a marca não sai de cabeça para baixo.
   */
  private writeScar(
    index: number,
    local: THREE.Vector3,
    normal: THREE.Vector3,
    radius: number,
    open: number,
    id: number,
  ): void {
    orientDecal(normal, _quaternion);
    _position.copy(normal).multiplyScalar(DECAL_LIFT).add(local);
    this.outerScars.write(index, radius, open, id);

    orientDecal(_flipped.copy(normal).negate(), _quaternion);
    const depth = open > 0.5 ? INNER_DECAL_DEPTH_OPEN : INNER_DECAL_DEPTH_CLOSED;
    _position.copy(normal).multiplyScalar(-depth).add(local);
    this.innerScars.write(index, radius * INNER_SCAR_SCALE, open, id);
  }

  /**
   * Põe a tábua sobre a cicatriz, atravessada e um pouco fora do prumo.
   *
   * O sorteio sai do `id` do rombo, então duas tábuas nunca ficam iguais e
   * nenhuma delas se mexe entre quadros. Ele decide duas coisas: o giro em
   * torno da normal e o escorregamento no plano do costado — que juntos são o
   * que separa "uma tábua pregada por alguém com pressa" de "um adesivo
   * centralizado".
   */
  private writePlank(index: number, local: THREE.Vector3, normal: THREE.Vector3, id: number): void {
    if (!this.planks) return;

    // `orientDecal` deixa `_tangent` e `_bitangent` prontos como efeito
    // colateral, e são eles que definem o plano em que a tábua escorrega.
    orientDecal(normal, _quaternion);

    const roll = (hash01(id) * 2 - 1) * PLANK_ROLL;
    // O giro é em torno do Z **do decalque**, e o Z do decalque é a normal do
    // casco: a tábua roda no plano do costado, que é onde ela encosta.
    _roll.setFromAxisAngle(ALONG, roll);
    _quaternion.multiply(_roll).multiply(PLANK_TO_DECAL);

    const slideX = (hash01(id * 3.7 + 11) * 2 - 1) * PLANK_SLIDE;
    const slideY = (hash01(id * 7.3 + 29) * 2 - 1) * PLANK_SLIDE;

    _position
      .copy(normal)
      .multiplyScalar(-PLANK_DEPTH)
      .add(local)
      .addScaledVector(_tangent, slideX)
      .addScaledVector(_bitangent, slideY);

    this.planks.setMatrixAt(index, _matrix.compose(_position, _quaternion, UNIT));
  }
}

/**
 * Os dois eixos da marca que ficam **no** costado.
 *
 * `tangent` corre ao longo do tabuado (proa-popa) e `bitangent` sobe por ele.
 * Alinhar o decalque assim não é capricho: a fibra da madeira e as lascas são
 * desenhadas ao longo do X da marca, e madeira racha ao longo da tábua. Com
 * uma orientação qualquer, as rachaduras sairiam cruzando o tabuado — que é a
 * única coisa que madeira não faz.
 */
function decalAxes(normal: THREE.Vector3, tangent: THREE.Vector3, bitangent: THREE.Vector3): void {
  tangent.crossVectors(UP, normal);
  // Rombo na quilha ou no fundo do bojo: a normal aponta para baixo e o
  // produto com a vertical degenera. Aí o tabuado é longitudinal do mesmo
  // jeito, então serve o eixo do navio.
  if (tangent.lengthSq() < 1e-6) tangent.copy(ALONG);
  tangent.normalize();
  bitangent.crossVectors(normal, tangent);
}

/** A orientação da marca: X no tabuado, Y subindo, Z na normal do casco. */
function orientDecal(normal: THREE.Vector3, out: THREE.Quaternion): void {
  decalAxes(normal, _tangent, _bitangent);
  _basis.makeBasis(_tangent, _bitangent, _normal.copy(normal));
  out.setFromRotationMatrix(_basis);
}

/** Encolhe todas as instâncias a zero — é assim que uma instância "não existe". */
function hideAll(mesh: THREE.InstancedMesh, count: number): void {
  for (let i = 0; i < count; i++) {
    mesh.setMatrixAt(i, _matrix.compose(ORIGIN, _quaternion.identity(), HIDDEN));
  }
  mesh.instanceMatrix.needsUpdate = true;
}
