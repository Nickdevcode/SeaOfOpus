/**
 * A cabeça que acompanha o olhar — a metade do corpo que o fio já carregava e
 * que ninguém via.
 *
 * O rumo horizontal do adversário nunca foi problema: parado, o corpo inteiro
 * gira para onde ele olha (`PlayerAvatar.updateFacing`), e andando, a direção do
 * movimento conta a mesma história. O que se perdia era a **vertical**. O
 * instantâneo traz o `pitch` desde a primeira versão do protocolo — ele é o que
 * decide o foco de interação do outro lado —, e o corpo o ignorava: o pirata
 * ficava com o queixo cravado no horizonte enquanto o jogador dele mirava o
 * cesto da gávea, procurava um rombo no porão ou olhava para as próprias mãos.
 *
 * ## Por que dois ossos, e não um
 *
 * Concentrar 50° num osso só dá um pescoço quebrado — a mesma razão pela qual
 * `FirstPersonBody` reparte a torção por três vértebras em vez de torcer um
 * disco. Aqui são dois: o `neck` leva a maior parte e o `head` completa, que é
 * como um pescoço humano se dobra.
 *
 * ## Por que a rotação é conjugada
 *
 * Porque o eixo X do osso **não** é o eixo lateral do personagem. O rig foi
 * montado no Blender em Z-up e a conversão do glTF já girou os eixos de repouso;
 * um `bone.rotateX(θ)` cru inclinaria a cabeça em torno de um eixo torto, e o
 * resultado é um pirata que olha para cima entortando o pescoço para o lado.
 * A rotação é definida no espaço do **avatar** — onde +Z é a frente do
 * personagem, porque é para lá que o modelo olha — e levada até o espaço do osso
 * pelo acumulado dos pais, exatamente como a torção do quadril já faz.
 *
 * As duas parcelas giram em torno do mesmo eixo, então comutam: o acumulado do
 * `head` pode ser colhido depois de o `neck` já ter sido escrito, sem que a
 * conjugação mude de valor. É a mesma propriedade que `FirstPersonBody` usa para
 * percorrer a coluna numa passagem só.
 *
 * ## Quem usa
 *
 * Só o corpo visto **de fora** — o do adversário, e o do jogador com a câmera
 * solta. Vestindo o corpo, quem olha para cima é a câmera, e a cabeça está
 * recortada pelo `headClip` de qualquer forma; pior, ali a torção de
 * `FirstPersonBody` roda no mesmo quadro e as duas rotações **não** comutam
 * (uma em Y, outra em X). Aplicar as duas juntas custaria uma composição
 * correta para ganhar exatamente nada que se veja.
 */

import * as THREE from 'three';
import { clamp } from '../core/MathUtils';

/**
 * Quanto do olhar vertical cada osso leva.
 *
 * Somam menos que 1 de propósito: um pescoço real não entrega os 83° de
 * `PITCH_LIMIT`, e o resto do movimento, num jogador de verdade, sai dos olhos —
 * que este personagem não move. Com 0,85 no total, olhar para o zênite deixa o
 * queixo levantado no limite do crível em vez de dobrar a nuca ao meio.
 */
const NECK_SHARE = 0.5;
const HEAD_SHARE = 0.35;

/** Teto do que o pescoço faz, em radianos (≈57°) para cada lado. */
const LOOK_LIMIT = 1.0;

const _axis = new THREE.Vector3(1, 0, 0);
const _rotation = new THREE.Quaternion();
const _world = new THREE.Quaternion();
const _inverse = new THREE.Quaternion();

export class HeadLook {
  private neck: THREE.Bone | null = null;
  private head: THREE.Bone | null = null;
  /**
   * Os ancestrais de cada osso até o nó do avatar, do mais baixo para o mais
   * alto.
   *
   * Montadas uma vez: a **hierarquia** não muda durante a vida do esqueleto, só
   * os quaternions dentro dela. Refazer as duas listas a cada quadro seria
   * alocar dois vetores por corpo sessenta vezes por segundo, dentro do
   * orçamento de 16 ms do quadro de render.
   */
  private readonly neckChain: THREE.Object3D[] = [];
  private readonly headChain: THREE.Object3D[] = [];
  private ready = false;

  /** Inclinação escrita no último quadro, em radianos. Diagnóstico. */
  pitch = 0;

  /**
   * Resolve os dois ossos. Devolve `false` se algum faltar.
   *
   * Faltar osso não derruba nada: um GLB antigo em cache do navegador perde só
   * o gesto do pescoço, e o corpo continua andando, subindo e governando. É a
   * mesma política do clipe de pulo e da torção do quadril.
   */
  attach(skeleton: THREE.Skeleton, avatarRoot: THREE.Object3D): boolean {
    this.ready = false;
    this.neck = skeleton.bones.find((bone) => bone.name === 'neck') ?? null;
    this.head = skeleton.bones.find((bone) => bone.name === 'head') ?? null;
    if (!this.neck || !this.head) return false;

    collectChain(this.neck, avatarRoot, this.neckChain);
    collectChain(this.head, avatarRoot, this.headChain);

    this.ready = true;
    return true;
  }

  /**
   * Inclina a cabeça. **Depois** de `mixer.update(dt)`, todo quadro.
   *
   * O mixer reescreve os 43 nós a cada passagem, então o que se escreve aqui não
   * realimenta nada e nada acumula — a mesma garantia de `FirstPersonBody`.
   *
   * @param pitch para onde o dono do corpo está olhando, em radianos. Positivo
   *   é para cima, como em `PlayerController.pitch`.
   */
  apply(pitch: number): void {
    if (!this.ready) return;
    this.pitch = clamp(pitch, -LOOK_LIMIT, LOOK_LIMIT);
    if (this.pitch === 0) return;

    rotate(this.neck!, this.neckChain, NECK_SHARE * this.pitch);
    rotate(this.head!, this.headChain, HEAD_SHARE * this.pitch);
  }

  reset(): void {
    this.pitch = 0;
  }
}

/** Os ancestrais de um osso até o nó do avatar, do mais baixo para o mais alto. */
function collectChain(
  bone: THREE.Bone,
  avatarRoot: THREE.Object3D,
  out: THREE.Object3D[],
): void {
  out.length = 0;
  for (let node = bone.parent; node && node !== avatarRoot; node = node.parent) out.push(node);
}

/**
 * `q ← (W⁻¹ · R · W) · q`, com `W` o acumulado do espaço do avatar até o **pai**
 * do osso.
 *
 * O sinal é negativo porque o personagem foi modelado olhando para −Y no
 * Blender, o que vira **+Z** depois da conversão Y-up do glTF: uma rotação
 * positiva em torno de X leva +Z para baixo, e olhar para cima é justamente o
 * contrário.
 */
function rotate(bone: THREE.Bone, chain: readonly THREE.Object3D[], angle: number): void {
  _rotation.setFromAxisAngle(_axis, -angle);

  // Do ancestral mais alto para o mais baixo: é essa a ordem do produto.
  _world.identity();
  for (let i = chain.length - 1; i >= 0; i--) _world.multiply(chain[i]!.quaternion);

  _inverse.copy(_world).invert();
  bone.quaternion.premultiply(_inverse.multiply(_rotation).multiply(_world));
}
