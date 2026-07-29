/**
 * O corpo que se torce: pernas para onde se anda, tronco para onde se olha.
 *
 * Fora da primeira pessoa o corpo inteiro aponta para a direção do movimento, e
 * está certo — sem clipes de andar de lado e de ré, um corpo preso ao olhar
 * desliza de costas, o *moonwalk*. Vestindo o corpo, essa mentira barata deixa de
 * ser invisível: andando para trás o jogador veria os próprios pés apontados
 * para ele, e o peito virado para o lado errado da tela.
 *
 * A saída é a de sempre em jogo de primeira pessoa: **separar os dois**. As
 * pernas continuam com a direção do movimento, que é a única que a animação sabe
 * andar; o tronco fica com o olhar, que é a única que a câmera aceita. A
 * diferença vira torção de quadril, e quem paga é a coluna.
 *
 * ## O que se faz com os ossos
 *
 * Roda-se tudo abaixo do osso `root` pelo desvio, e devolve-se o desvio
 * distribuído pela coluna. O resultado é pernas em `legYaw` e ombros de volta em
 * `torsoYaw`, sem tocar em braços, pescoço nem cabeça — eles herdam a coluna e
 * chegam corretos de graça.
 *
 * Distribuir por `spine_01/02/03` em vez de torcer um osso só não é capricho: é
 * a mesma decisão que `anim_gait.pose_spine` já tomou para a contra-torção da
 * marcha, e pelo mesmo motivo escrito lá — concentrar a torção num disco faz um
 * vinco no casaco em vez de um tronco inclinado. Os pesos são os mesmos.
 *
 * **A conjugação não é enfeite.** O eixo Y local do `pelvis` não é a vertical do
 * personagem: o rig anima `pelvis_roll` de 4,2° e `pelvis_pitch` de 3°, e a
 * conversão Z-up→Y-up do glTF já girou os eixos de repouso. Multiplicar o
 * quaternion do osso por um yaw cru torceria em torno de um eixo inclinado e o
 * quadril sairia jogando para os lados conforme a passada. Cada rotação é levada
 * para o espaço do osso antes de ser aplicada.
 *
 * ## Andar de ré sem clipe de ré
 *
 * Acima de um certo desvio, as pernas dobram meia-volta e a passada é **lida ao
 * contrário** — o ciclo de caminhada rodado para trás é uma caminhada para trás
 * convincente, porque os contatos de pé caem nos mesmos instantes. Quem consome
 * `reversed` é o `PlayerAvatar`, que inverte a leitura de `.time` do clipe sem
 * tocar na fase: ela é compartilhada com o balanço da câmera e com os testes.
 *
 * A dobra tem **histerese** por necessidade aritmética, não por gosto: no strafe
 * puro o desvio é exatamente 90°, e um limiar único ali faz as pernas darem
 * meia-volta de 180° a cada quadro.
 */

import * as THREE from 'three';
import { DEG, clamp, damp, wrapAngle } from '../core/MathUtils';

/**
 * Quanto o quadril pode desviar dos ombros, em radianos.
 *
 * Uma separação quadril-ombro real fica em 15–25° andando, e chega a uns 45°
 * parada. 65° é mais do que qualquer anatomia entrega, e é de propósito: quando
 * o limite morde — strafe puro, ré parcial — a escolha é entre escorregar o pé e
 * torcer o boneco, e em primeira pessoa **não se vê o próprio quadril**, mas se
 * vê o pé patinando de relance no rodapé da tela. O erro cai para o lado que não
 * aparece.
 */
const LEG_OFFSET_LIMIT = 65 * DEG;

/**
 * Como a contra-torção se reparte pela coluna, da lombar para cima.
 *
 * Tem de somar 1: é isso que faz os ombros voltarem exatamente para o olhar.
 * Os números são os de `anim_gait.pose_spine`.
 */
const SPINE_SHARES = [0.3, 0.35, 0.35] as const;

/** Convergência das pernas ao alvo, andando, em 1/s. */
const LEG_CHASE_LAMBDA = 12;

/**
 * Convergência das pernas ao olhar, parado, em 1/s.
 *
 * Baixo de propósito: quem gira a cabeça parado vira o corpo **depois**, e é
 * essa preguiça que faz o personagem parecer habitado em vez de colado no mouse.
 */
const LEG_IDLE_LAMBDA = 4;

/** Acima deste desvio o corpo passa a andar de ré. */
const LEG_REVERSE_ENTER = 100 * DEG;
/** E só volta a andar de frente abaixo deste. A folga cobre o ruído do analógico. */
const LEG_REVERSE_EXIT = 80 * DEG;

const _up = new THREE.Vector3(0, 1, 0);
const _rotation = new THREE.Quaternion();
const _delta = new THREE.Quaternion();
const _inverse = new THREE.Quaternion();
const _world = new THREE.Quaternion();
const _original = new THREE.Quaternion();

/**
 * Dobra o rumo das pernas para trás quando o desvio passa do limite.
 *
 * Separada da classe porque é aritmética pura e é ela que carrega o único caso
 * traiçoeiro (o strafe de 90° oscilando entre os dois estados) — assim dá para
 * medir sem esqueleto nenhum. Ver `tests/locomotion.ts`.
 *
 * @param heading para onde as pernas iriam, no referencial do navio.
 * @param torsoYaw para onde o tronco aponta.
 * @param reversed se o corpo já vinha andando de ré.
 */
export function foldLegHeading(
  heading: number,
  torsoYaw: number,
  reversed: boolean,
): { heading: number; reversed: boolean } {
  const deviation = Math.abs(wrapAngle(heading - torsoYaw));
  const next = reversed ? deviation > LEG_REVERSE_EXIT : deviation > LEG_REVERSE_ENTER;
  return { heading: next ? heading + Math.PI : heading, reversed: next };
}

export class FirstPersonBody {
  /** Para onde as pernas apontam, no referencial do navio. */
  legYaw = 0;
  /** `true` quando a passada tem de ser lida ao contrário. */
  reversed = false;
  /** Desvio aplicado neste quadro, em radianos. Já grampeado. Diagnóstico. */
  offset = 0;

  private rootBone: THREE.Bone | null = null;
  private pelvis: THREE.Bone | null = null;
  private readonly spine: THREE.Bone[] = [];
  /**
   * Orientação do rig dentro do avatar, do pai do osso `root` para cima.
   *
   * Estática — nenhum clipe anima os nós acima do esqueleto —, então é medida uma
   * vez. É ela que leva uma rotação do espaço do avatar para o espaço em que o
   * quaternion do osso `root` vive.
   */
  private readonly rigQuaternion = new THREE.Quaternion();
  private ready = false;
  private started = false;

  /**
   * Resolve os ossos. Devolve `false` se algum faltar.
   *
   * Faltar osso não é motivo para derrubar nada: um GLB antigo em cache do
   * navegador pode não ter a coluna com estes nomes, e nesse caso o corpo perde
   * só a torção — continua andando, pulando e subindo escada. É a mesma política
   * que o `PlayerAvatar` já aplica ao clipe de pulo e ao de escalada.
   *
   * @param avatarRoot o nó do avatar; a torção é definida no espaço dele, depois
   *   de o rumo do corpo já ter sido aplicado.
   */
  attach(skeleton: THREE.Skeleton, avatarRoot: THREE.Object3D): boolean {
    this.ready = false;
    this.spine.length = 0;

    const find = (name: string): THREE.Bone | undefined =>
      skeleton.bones.find((bone) => bone.name === name);

    const rootBone = find('root');
    const pelvis = find('pelvis');
    const spine = [find('spine_01'), find('spine_02'), find('spine_03')];
    if (!rootBone || !pelvis || spine.some((bone) => !bone)) return false;

    this.rootBone = rootBone;
    this.pelvis = pelvis;
    for (const bone of spine) this.spine.push(bone!);

    this.rigQuaternion.identity();
    // De baixo para cima recolhendo, de cima para baixo compondo: o acumulado é
    // o produto na ordem do ancestral mais alto para o mais baixo.
    const chain: THREE.Object3D[] = [];
    for (let node = rootBone.parent; node && node !== avatarRoot; node = node.parent) {
      chain.push(node);
    }
    for (let i = chain.length - 1; i >= 0; i--) this.rigQuaternion.multiply(chain[i]!.quaternion);

    this.ready = true;
    return true;
  }

  /**
   * Persegue o rumo das pernas.
   *
   * O estado guardado é o **rumo**, no referencial do navio, e não o desvio em
   * relação aos ombros. A diferença aparece no ar: ali o alvo congela, e com um
   * rumo guardado quem gira o mouse no meio do salto vê as pernas ficarem onde
   * estavam — que é o certo. Com um desvio guardado, elas girariam junto com a
   * câmera, que é exatamente o defeito que a locomoção já tinha consertado no
   * chão.
   *
   * @param torsoYaw para onde o tronco aponta, no referencial do navio.
   * @param target para onde as pernas deveriam ir, ou `null` para congelar.
   * @param moving se o alvo veio do movimento (e não do olhar de quem está parado).
   */
  update(dt: number, torsoYaw: number, target: number | null, moving: boolean): void {
    if (target === null) {
      // Congelado: o desvio se ajusta sozinho conforme o tronco gira.
      this.offset = this.clampOffset(torsoYaw);
      return;
    }

    const folded = foldLegHeading(target, torsoYaw, this.reversed);
    this.reversed = folded.reversed;

    if (!this.started) {
      this.legYaw = folded.heading;
      this.started = true;
    } else {
      // Pelo caminho mais curto, como o rumo do corpo: sem isto, cruzar ±π faz as
      // pernas girarem quase uma volta inteira num quadro.
      const lambda = moving ? LEG_CHASE_LAMBDA : LEG_IDLE_LAMBDA;
      const delta = wrapAngle(folded.heading - this.legYaw);
      this.legYaw = damp(this.legYaw, this.legYaw + delta, lambda, dt);
    }

    this.offset = this.clampOffset(torsoYaw);
  }

  /**
   * Prende as pernas a um rumo e desliga a torção.
   *
   * É o caso da escada: mãos e pés estão nas barras, e virar a cabeça para olhar
   * o convés lá embaixo não pode torcer o tronco de quem está pendurado. Escrever
   * o rumo em vez de só zerar o desvio é o que evita o safanão ao largar — as
   * pernas já estão onde o corpo as deixou, e o desvio nasce de zero.
   */
  hold(yaw: number): void {
    this.legYaw = yaw;
    this.started = true;
    this.reversed = false;
    this.offset = 0;
  }

  private clampOffset(torsoYaw: number): number {
    return clamp(wrapAngle(this.legYaw - torsoYaw), -LEG_OFFSET_LIMIT, LEG_OFFSET_LIMIT);
  }

  /**
   * Escreve a torção nos ossos. **Depois** de `mixer.update(dt)`.
   *
   * Tem de ser todo quadro, e a ordem não é negociável: os seis clipes animam os
   * 43 nós com peso somando 1, então o mixer reescreve `root`, `pelvis` e a
   * coluna inteira a cada passagem. O que se escreve aqui não realimenta o mixer
   * — ele guarda a pose original dele por dentro —, então nada acumula.
   *
   * O acumulado da coluna é colhido **antes** de qualquer escrita, e o osso `root`
   * é o último a ser tocado, porque é ele que os acumulados usam.
   */
  apply(): void {
    if (!this.ready || this.offset === 0) return;
    const rootBone = this.rootBone!;
    const pelvis = this.pelvis!;

    // A rotação pedida, no espaço do avatar.
    _rotation.setFromAxisAngle(_up, this.offset);

    // W do pelvis: do avatar até ele, com os quaternions ainda intactos.
    _world.copy(this.rigQuaternion).multiply(rootBone.quaternion).multiply(pelvis.quaternion);

    for (let i = 0; i < this.spine.length; i++) {
      const bone = this.spine[i]!;
      _original.copy(bone.quaternion);

      // s ← W⁻¹ · R^(-fração) · W · s, com W o acumulado até o **pai** do osso.
      _delta.setFromAxisAngle(_up, -SPINE_SHARES[i]! * this.offset);
      _inverse.copy(_world).invert();
      bone.quaternion.premultiply(_inverse.multiply(_delta).multiply(_world));

      _world.multiply(_original);
    }

    // r ← (A⁻¹ · R · A) · r, por último: os acumulados acima leram o valor antigo.
    _inverse.copy(this.rigQuaternion).invert();
    rootBone.quaternion.premultiply(_inverse.multiply(_rotation).multiply(this.rigQuaternion));
  }

  reset(): void {
    this.legYaw = 0;
    this.reversed = false;
    this.offset = 0;
    this.started = false;
  }
}
