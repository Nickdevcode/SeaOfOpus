/**
 * Sumir com a cabeça sem sumir com a sombra.
 *
 * Em primeira pessoa o olho do jogador fica a 1,66 m e o crânio do personagem
 * vai de 1,545 m a 1,76 m — com o tricórnio até 1,94 m. A câmera nasce **dentro**
 * da malha, e o material do pirata é `DoubleSide`, então o interior da cabeça
 * renderiza: sem recorte, a primeira pessoa é uma tela de couro cabeludo por
 * dentro. É por isso que o corpo vivia escondido inteiro.
 *
 * O recorte é `discard` no fragmento, decidido pelo **peso de skinning** do
 * vértice nos ossos da cabeça. Um peso é um campo contínuo, então o corte cai
 * numa curva suave ao longo do pescoço em vez de num plano, e o limiar move essa
 * curva sem recompilar nada — que é o que permite calibrar isto com o olho na
 * tela.
 *
 * **Por que não `head.scale = 0`.** É o truque clássico e aqui ele não serve. Os
 * vértices do pescoço e da gola têm peso **misto** (`PART_Neck` divide entre
 * `neck`, `head` e `spine_03`; `PART_Coat_Collar` entre quatro ossos). Encolher o
 * osso não os apaga: **arrasta** cada um em direção à origem do `head` na fração
 * do peso que tiver, e o que sobra é um funil amassado a 20 cm do olho, para
 * sempre. E não seria nem mais barato — os seis clipes gravam SCALE dos 43 nós,
 * então a escala teria de ser reescrita a cada quadro depois do mixer.
 *
 * **Por que não `clippingPlanes`.** Um plano de recorte é infinito. Um plano na
 * altura do pescoço, com `clipShadows = false`, daria "invisível com sombra
 * inteira" de graça — e amputaria as **mãos na escada**, que no `ClimbUp` sobem
 * bem acima do pescoço. Ou seja: mataria justamente o que a primeira pessoa veio
 * mostrar.
 *
 * **Por que `onBeforeCompile`, que não se usa em nenhum outro lugar daqui.** O
 * padrão da casa é `ShaderMaterial` escrito do zero (`hullClip.ts`, `Ocean`,
 * `Sky`) porque ali o shader **é** o trabalho — são efeitos autorais. Aqui é o
 * oposto: a exigência é preservar exatamente o PBR que o `GLTFLoader` montou
 * (normal map, ORM empacotado, skinning por textura de ossos) e acrescentar uma
 * linha. Reescrever `meshphysical` seria assumir a manutenção de umas 800 linhas
 * de GLSL do three para adicionar um `discard`.
 *
 * **O efeito colateral é o melhor da feature.** `WebGLShadowMap.getDepthMaterial`
 * copia do material de origem só uma lista fechada de campos — `visible`,
 * `side`, `alphaMap`, `alphaTest`, `clipShadows`, `displacementMap` e afins — e
 * `onBeforeCompile` **não** está nela. O mapa de sombras desenha o pirata
 * inteiro, com chapéu, enquanto o passe de cor descarta a cabeça. O jogador
 * ganha a própria sombra no convés, que em primeira pessoa nunca existiu (objeto
 * invisível nem entra no `renderObject` do shadow map). Se um dia se quiser a
 * sombra também sem cabeça, o gancho é `mesh.customDepthMaterial`, que tem
 * prioridade — não é o caso hoje.
 */

import * as THREE from 'three';

/**
 * Limiar que desliga o recorte.
 *
 * Maior que qualquer peso somado possível (os pesos de um vértice somam 1, e a
 * parcela do pescoço entra no máximo com 1 de fator), então nada é descartado
 * sem trocar de programa nem recompilar shader. É o que a terceira pessoa usa
 * quando a câmera se solta com `C`.
 */
export const HEAD_CLIP_OFF = 2;

/**
 * Peso acima do qual o fragmento some, em [0, 1].
 *
 * Meio significa "mais da metade deste vértice pertence à cabeça", que
 * geometricamente cai no meio do pescoço — o `head` começa em 1,545 m e o `neck`
 * em 1,425 m. O tricórnio, os olhos, o nariz, as orelhas, a boca, o bigode e o
 * cabelo estão 100% no `head` e somem em qualquer limiar abaixo de 1.
 */
export const HEAD_CLIP_THRESHOLD = 0.5;

/**
 * Quanto o peso do osso `neck` conta para o corte, em [0, 1].
 *
 * Em zero só a cabeça some e sobra um toco de pescoço apontando para a câmera.
 * Subindo, o corte desce em direção à gola do casaco. Fica em zero por padrão
 * porque o toco está fora do campo de visão na esmagadora maioria dos ângulos, e
 * cortar fundo demais abre o casaco por dentro quando se olha para baixo.
 */
export const HEAD_CLIP_NECK_SHARE = 0;

/** Controle do recorte já instalado num material. */
export interface HeadClipHandle {
  /** Limiar em vigor. `HEAD_CLIP_OFF` quer dizer desligado. */
  readonly threshold: number;
  /** Parcela do pescoço em vigor. */
  readonly neckShare: number;
  setThreshold(value: number): void;
  setNeckShare(value: number): void;
}

/** Declarações comuns aos dois estágios. */
const DECLARATIONS = /* glsl */ `
varying float vHeadClipWeight;
`;

/**
 * Soma o peso do vértice nos ossos da cabeça.
 *
 * Sem ramificação e sem indexar vetor com índice variável: `step` devolve 1
 * exatamente no osso procurado (os índices são inteiros, então a diferença é 0
 * ou pelo menos 1) e o `dot` soma as quatro influências de uma vez. Um índice
 * negativo — o osso que não existe num GLB antigo — nunca casa com nada, e o
 * termo cai a zero sozinho.
 */
const VERTEX_BODY = /* glsl */ `
#ifdef USE_SKINNING
  vHeadClipWeight = dot(step(abs(skinIndex - vec4(uHeadClipHead)), vec4(0.5)), skinWeight)
    + dot(step(abs(skinIndex - vec4(uHeadClipNeck)), vec4(0.5)), skinWeight) * uHeadClipNeckShare;
#else
  vHeadClipWeight = 0.0;
#endif
`;

/**
 * Instala o recorte num material do personagem.
 *
 * Não clona **aqui**, e não precisa: o GLB é carregado uma vez e serve os dois
 * corpos a bordo, mas quem já entrega material privado por avatar é
 * `CharacterAsset.instantiateCharacter`. A ordem importa e é essa — sem o clone
 * de lá, ligar o recorte para ver pelos próprios olhos decapitaria o adversário
 * no mesmo quadro, porque os dois piratas dividiriam o uniform de limiar.
 *
 * O programa compilado, esse sim, é compartilhado de graça:
 * `Material.customProgramCacheKey` devolve o **texto-fonte** do
 * `onBeforeCompile`, idêntico para toda closure criada desta mesma expressão. Um
 * programa, N conjuntos de uniforms.
 *
 * @param headIndex índice do osso `head` em `skeleton.bones`, ou -1.
 * @param neckIndex índice do osso `neck` em `skeleton.bones`, ou -1.
 */
export function installHeadClip(
  material: THREE.Material,
  headIndex: number,
  neckIndex: number,
): HeadClipHandle {
  // Começa desligado: quem liga é o avatar, no primeiro quadro em que souber se
  // a câmera está nos olhos do personagem.
  const uniforms = {
    uHeadClipHead: { value: headIndex },
    uHeadClipNeck: { value: neckIndex },
    uHeadClipNeckShare: { value: HEAD_CLIP_NECK_SHARE },
    uHeadClipThreshold: { value: HEAD_CLIP_OFF },
  };

  material.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, uniforms);

    shader.vertexShader = shader.vertexShader
      .replace(
        '#include <common>',
        `#include <common>
uniform float uHeadClipHead;
uniform float uHeadClipNeck;
uniform float uHeadClipNeckShare;
${DECLARATIONS}`,
      )
      // Depois de `begin_vertex` só porque é uma âncora que existe em qualquer
      // material; a conta não depende de nada que venha antes.
      .replace('#include <begin_vertex>', `#include <begin_vertex>\n${VERTEX_BODY}`);

    shader.fragmentShader = shader.fragmentShader
      .replace(
        '#include <common>',
        `#include <common>
uniform float uHeadClipThreshold;
${DECLARATIONS}`,
      )
      // Antes de tudo o mais: o fragmento descartado não paga normal map,
      // amostragem de ORM nem iluminação.
      .replace(
        '#include <clipping_planes_fragment>',
        `if (vHeadClipWeight > uHeadClipThreshold) discard;
#include <clipping_planes_fragment>`,
      );
  };
  material.needsUpdate = true;

  return {
    get threshold(): number {
      return uniforms.uHeadClipThreshold.value;
    },
    get neckShare(): number {
      return uniforms.uHeadClipNeckShare.value;
    },
    setThreshold(value: number): void {
      uniforms.uHeadClipThreshold.value = value;
    },
    setNeckShare(value: number): void {
      uniforms.uHeadClipNeckShare.value = value;
    },
  };
}
