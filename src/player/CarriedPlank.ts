/**
 * A tábua na mão do jogador, enquanto ele prega o rombo.
 *
 * **Ela não é filha de um osso.** O caminho óbvio seria `handBone.add(plank)`
 * com um offset fixo, e ele funciona — desde que o offset esteja escrito no
 * mesmo referencial em que o osso vive depois de atravessar a conversão Z-up →
 * Y-up do exportador glTF e a convenção de eixo de osso do Blender. São duas
 * passagens em que um sinal trocado não dá erro nenhum: dá uma tábua flutuando
 * ao lado da mão, e a única forma de descobrir é olhando.
 *
 * Então a peça é montada **a partir das duas mãos**, todo quadro:
 *
 * - o eixo do comprimento é a reta que liga um punho ao outro;
 * - o giro em torno dele sai da orientação da mão direita;
 * - o centro é o ponto médio, deslocado pelo que o clipe mediu.
 *
 * Os números de `SOCKET_*` foram medidos no Blender, com a action `Carry`
 * tocando, projetando o referencial da tábua nessa mesma base — e eles se
 * mexem menos de 3 mm ao longo do ciclo, que é o que prova que a base é rígida
 * em relação à peça. Se alguém reconstruir o clipe com a pose mudada, é só
 * remedir: `anim_carry.socket()` cospe estes seis números.
 *
 * O ganho de fazer assim é que a tábua **não pode** descolar das mãos. Ela não
 * é posicionada perto de onde as mãos deveriam estar; ela é posicionada onde as
 * mãos estão.
 */

import * as THREE from 'three';
import { PLANK_LENGTH, PLANK_THICKNESS, PLANK_WIDTH, loadPlank } from '../ship/PlankAsset';

/**
 * Onde o centro da tábua fica em relação ao ponto médio dos dois punhos, na
 * base `(u, e2, e3)` descrita no topo. Em metros.
 *
 * O terceiro número é o que carrega o sentido: 13 cm **para fora** da linha dos
 * punhos, que é meia largura de tábua mais a palma. Os outros dois são ruído de
 * medição e ficam aqui porque copiá-los custa nada e arredondá-los a zero seria
 * escolher um número em vez de medir.
 */
const SOCKET_OFFSET = { along: 0.0013, up: 0.0025, out: -0.1313 } as const;

/** Eixo do comprimento da tábua na mesma base. Quase o eixo entre os punhos. */
const SOCKET_LENGTH = new THREE.Vector3(0.9956, -0.0207, -0.0918);
/** Eixo da largura. É ele que decide de que lado a face grande olha. */
const SOCKET_WIDTH = new THREE.Vector3(-0.0912, -0.4513, -0.8877);

/** Direção do osso no repouso do Blender: os ossos apontam no +Y local. */
const BONE_AXIS = new THREE.Vector3(0, 1, 0);

const _left = new THREE.Vector3();
const _right = new THREE.Vector3();
const _mid = new THREE.Vector3();
const _u = new THREE.Vector3();
const _e2 = new THREE.Vector3();
const _e3 = new THREE.Vector3();
const _boneDir = new THREE.Vector3();
const _length = new THREE.Vector3();
const _width = new THREE.Vector3();
const _thickness = new THREE.Vector3();
const _center = new THREE.Vector3();
const _basis = new THREE.Matrix4();
const _inverseParent = new THREE.Matrix4();

export class CarriedPlank {
  private mesh: THREE.Mesh | null = null;
  private parent: THREE.Object3D | null = null;
  private handLeft: THREE.Bone | null = null;
  private handRight: THREE.Bone | null = null;
  private disposed = false;

  /**
   * Acha os dois ossos e pendura a tábua no nó do avatar.
   *
   * Debaixo do avatar, e não da cena, por uma razão só: é ele que some quando o
   * jogador assume o canhão e quando a câmera está dentro da cabeça. Pendurada
   * na cena, a tábua continuaria visível sozinha, flutuando no convés — e o
   * custo de acompanhar o pai é uma inversão de matriz por quadro.
   *
   * @returns `false` quando os ossos não estão no GLB — e aí o reparo continua
   *   funcionando, sem madeira à vista.
   */
  attach(skeleton: THREE.Skeleton, parent: THREE.Object3D): boolean {
    this.handLeft = findBone(skeleton, 'hand.L');
    this.handRight = findBone(skeleton, 'hand.R');
    if (!this.handLeft || !this.handRight) {
      console.warn('[plank] ossos das mãos não encontrados; o reparo fica sem tábua');
      return false;
    }

    void loadPlank().then((asset) => {
      if (!asset || this.disposed) return;
      const mesh = new THREE.Mesh(asset.geometry, asset.material);
      mesh.name = 'carried-plank';
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      // A matriz é escrita à mão a cada quadro; deixar o Three recompô-la a
      // partir de posição e quaternion seria decompor o que acabou de ser
      // composto.
      mesh.matrixAutoUpdate = false;
      // A peça vive colada às mãos, que o avatar já tira do culling por sair da
      // caixa de repouso do esqueleto.
      mesh.frustumCulled = false;
      mesh.visible = false;
      parent.add(mesh);
      this.mesh = mesh;
      this.parent = parent;
    });

    return true;
  }

  /**
   * Põe a tábua entre as mãos, ou a esconde.
   *
   * Chamar **depois** do `mixer.update` e de qualquer escrita direta em osso: o
   * que se lê aqui são as matrizes de mundo dos punhos, e elas só valem depois
   * que a pose do quadro terminou de ser montada.
   *
   * @param visible se o jogador está com a tábua nas mãos neste quadro.
   */
  update(visible: boolean): void {
    const mesh = this.mesh;
    if (!mesh || !this.handLeft || !this.handRight) return;

    mesh.visible = visible;
    if (!visible) return;

    // Sobe a cadeia até a raiz sem descer nos filhos: sem isto o que se lê é a
    // pose do quadro **anterior**, e a tábua anda um quadro atrás das mãos —
    // que é justamente onde ela seria notada, no gesto de erguer a peça.
    this.handLeft.updateWorldMatrix(true, false);
    this.handRight.updateWorldMatrix(true, false);

    _left.setFromMatrixPosition(this.handLeft.matrixWorld);
    _right.setFromMatrixPosition(this.handRight.matrixWorld);
    _mid.addVectors(_left, _right).multiplyScalar(0.5);

    _u.subVectors(_left, _right);
    if (_u.lengthSq() < 1e-8) return;
    _u.normalize();

    // O giro em torno do eixo dos punhos sai da mão direita. Sem um segundo
    // vetor, a base fica com um grau de liberdade solto e a tábua rola em torno
    // das mãos a cada quadro.
    _boneDir.copy(BONE_AXIS).transformDirection(this.handRight.matrixWorld);
    _e2.copy(_boneDir).addScaledVector(_u, -_boneDir.dot(_u));
    if (_e2.lengthSq() < 1e-8) return;
    _e2.normalize();
    _e3.crossVectors(_u, _e2);

    _center
      .copy(_mid)
      .addScaledVector(_u, SOCKET_OFFSET.along)
      .addScaledVector(_e2, SOCKET_OFFSET.up)
      .addScaledVector(_e3, SOCKET_OFFSET.out);

    combine(_length, SOCKET_LENGTH);
    combine(_width, SOCKET_WIDTH);
    // A espessura fecha a base pela regra da mão direita. O sinal negativo é o
    // que casa com o arquivo: a tábua sai do Blender com o comprimento em X, a
    // **espessura** em Y e a largura em Z, e nessa ordem os três formam uma base
    // canhota se a normal for tomada direto do produto vetorial.
    _thickness.crossVectors(_length, _width).negate().normalize();
    _width.crossVectors(_thickness, _length).normalize();

    _basis.makeBasis(_length, _thickness, _width);
    _basis.setPosition(_center);

    // A base foi montada em coordenadas de mundo, e a malha é filha do avatar:
    // desfazer a transformação do pai é o que põe as duas no mesmo referencial.
    const parent = this.parent;
    if (parent) {
      parent.updateWorldMatrix(true, false);
      _inverseParent.copy(parent.matrixWorld).invert();
      _basis.premultiply(_inverseParent);
    }

    mesh.matrix.copy(_basis);
    mesh.updateMatrixWorld(true);
  }

  dispose(): void {
    this.disposed = true;
    this.handLeft = null;
    this.handRight = null;
    if (!this.mesh) return;
    // Geometria e material são do módulo `PlankAsset` e continuam servindo as
    // tábuas pregadas nos dois cascos: aqui só se solta a instância.
    this.mesh.removeFromParent();
    this.mesh = null;
  }
}

/**
 * Acha um osso pelo nome do Blender, com ou sem o ponto.
 *
 * **O `GLTFLoader` sanitiza os nomes.** O rig chama os ossos lateralizados de
 * `hand.L` e `hand.R`, e é assim que eles saem do exportador; o carregador do
 * Three troca o ponto por nada e o que chega na cena é `handL`. O motivo é o
 * `PropertyBinding`, que usa ponto como separador de caminho — um osso chamado
 * `hand.L` seria lido como a propriedade `L` do objeto `hand`.
 *
 * Isto não aparece em nenhum outro lugar do projeto porque os seis ossos que o
 * `FirstPersonBody` procura (`root`, `pelvis`, `spine_0N`) são justamente os que
 * não têm lado. O sintoma aqui foi um aviso no console e um reparo sem madeira,
 * com todo o resto funcionando.
 *
 * Procurar as duas formas custa uma varredura e sobrevive a uma troca de
 * carregador nos dois sentidos.
 */
function findBone(skeleton: THREE.Skeleton, name: string): THREE.Bone | null {
  const plain = name.replace(/\./g, '');
  return skeleton.bones.find((bone) => bone.name === name || bone.name === plain) ?? null;
}

/** Reconstrói um eixo medido na base `(u, e2, e3)` deste quadro. */
function combine(out: THREE.Vector3, coefficients: THREE.Vector3): void {
  out
    .copy(_u)
    .multiplyScalar(coefficients.x)
    .addScaledVector(_e2, coefficients.y)
    .addScaledVector(_e3, coefficients.z)
    .normalize();
}

/** As medidas da peça, reexportadas para quem desenhar a mira ou o prompt. */
export const PLANK_SIZE = {
  length: PLANK_LENGTH,
  width: PLANK_WIDTH,
  thickness: PLANK_THICKNESS,
} as const;
