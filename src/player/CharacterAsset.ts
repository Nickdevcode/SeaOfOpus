/**
 * O personagem em disco, carregado uma vez e vestido duas.
 *
 * Enquanto havia um corpo só a bordo, o `PlayerAvatar` podia chamar o
 * `GLTFLoader` por conta própria: um arquivo, um parse, um dono. Com o
 * adversário ganhando corpo, o mesmo GLB passa a servir **dois** avatares — e
 * carregá-lo duas vezes seria pagar duas vezes 2,4 MB de malha e cinco texturas
 * idênticas byte a byte, além de um segundo parse dentro do quadro em que o
 * duelo começa.
 *
 * Então o arquivo é carregado uma vez e **instanciado** por avatar.
 *
 * ## Por que o clone é o do `SkeletonUtils`
 *
 * Porque `Object3D.clone()` copia os `SkinnedMesh` ainda apontando para o
 * **esqueleto do original**: os dois piratas passariam a ler os mesmos ossos, e
 * o que se veria é um deles vestindo a pose do outro — os dois andando quando um
 * anda, os dois parados quando um para. O clone daqui refaz a árvore de ossos e
 * religa a malha à cópia, que é a única forma de dois corpos animarem sozinhos.
 *
 * ## O que é compartilhado e o que é privado de cada corpo
 *
 * **Geometria e textura são compartilhadas.** São os dois recursos caros e
 * nenhum dos dois guarda estado de quem os usa.
 *
 * **O material é privado**, e não é zelo: `installHeadClip` escreve um
 * `onBeforeCompile` e um uniform de limiar nele, e é esse limiar que faz a
 * cabeça sumir em primeira pessoa. Compartilhado, o dono do corpo decapitaria o
 * adversário toda vez que olhasse pelos próprios olhos — que é literalmente o
 * aviso deixado em `headClip.ts` para o dia em que o multiplayer chegasse.
 * Clonar um material copia **referências** de textura, então o preço é um objeto
 * por corpo, não um megabyte.
 *
 * Os clipes de animação também são compartilhados, e podem ser: um
 * `AnimationClip` é uma tabela de quadros que ninguém reescreve, e quem guarda o
 * estado da reprodução é o `AnimationMixer` de cada avatar. Os tracks casam com
 * os ossos **pelo nome**, e o clone preserva os nomes.
 */

import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { clone as cloneSkeleton } from 'three/addons/utils/SkeletonUtils.js';

/**
 * O que este módulo precisa de um GLTF, e nada mais.
 *
 * Tipado estruturalmente em vez de importar o tipo `GLTF` do carregador: são
 * dois campos, e depender do formato inteiro do addon só amarraria este arquivo
 * a uma versão do Three.
 */
interface CharacterSource {
  readonly scene: THREE.Group;
  readonly animations: THREE.AnimationClip[];
}

/** Um corpo pronto para ser pendurado num avatar. */
export interface CharacterInstance {
  /** O nó a acrescentar ao avatar. */
  readonly model: THREE.Object3D;
  /** Os clipes do arquivo, compartilhados com as outras instâncias. */
  readonly animations: THREE.AnimationClip[];
  /** A malha com esqueleto, ou `null` se o GLB não trouxer uma. */
  readonly skinned: THREE.SkinnedMesh | null;
  /**
   * Os materiais **desta** instância. É por eles que o recorte de cabeça é
   * instalado, e são eles — só eles — que o avatar libera ao ser descartado.
   */
  readonly materials: THREE.Material[];
}

/**
 * Um carregamento por URL, e o mesmo `Promise` para quem chegar depois.
 *
 * Memoizar a promessa e não o resultado é o que faz os dois avatares
 * construídos no mesmo quadro esperarem o **mesmo** download: guardando só o
 * resultado, o segundo pedido sairia antes de o primeiro terminar e o arquivo
 * viria duas vezes.
 */
const loads = new Map<string, Promise<CharacterSource>>();

/** Carrega o personagem, ou devolve o carregamento que já está em curso. */
export function loadCharacter(url: string): Promise<CharacterSource> {
  const pending = loads.get(url);
  if (pending) return pending;

  const load = new GLTFLoader().loadAsync(url) as Promise<CharacterSource>;
  // A falha sai do cache: um erro de rede não pode condenar a partida seguinte
  // a nunca mais tentar carregar o corpo.
  const guarded = load.catch((error: unknown) => {
    loads.delete(url);
    throw error;
  });

  loads.set(url, guarded);
  return guarded;
}

/**
 * Veste uma cópia independente do personagem.
 *
 * @param source o que `loadCharacter` devolveu.
 */
export function instantiateCharacter(source: CharacterSource): CharacterInstance {
  const model = cloneSkeleton(source.scene);
  const materials: THREE.Material[] = [];
  let skinned: THREE.SkinnedMesh | null = null;

  model.traverse((node) => {
    const mesh = node as THREE.Mesh;
    if (!mesh.isMesh) return;

    // O personagem é visto de perto — pelo dono do corpo e pelo adversário. Sem
    // isto o Three corta a malha quando o esqueleto a leva para fora da caixa de
    // repouso.
    mesh.frustumCulled = false;
    mesh.castShadow = true;
    mesh.receiveShadow = true;

    // Privado desta instância: ver a nota do cabeçalho sobre o recorte da
    // cabeça. O clone mantém as texturas, que é o que custa memória.
    const original = mesh.material;
    if (Array.isArray(original)) {
      const copies = original.map((material) => material.clone());
      mesh.material = copies;
      materials.push(...copies);
    } else {
      const copy = original.clone();
      mesh.material = copy;
      materials.push(copy);
    }

    const skin = mesh as THREE.SkinnedMesh;
    if (skin.isSkinnedMesh) skinned ??= skin;
  });

  return { model, animations: source.animations, skinned, materials };
}

/**
 * Libera a malha e as texturas que as instâncias compartilham.
 *
 * ⚠️ **Depois de todas elas**, e é a ordem que importa: as cópias apontam para
 * esta geometria e para estas texturas, então liberar aqui enquanto um corpo
 * ainda estiver na cena tira o chão de debaixo dele. Quem chama é
 * `Match.dispose`, depois de descartar os dois avatares.
 */
export function disposeCharacterAsset(url: string): void {
  const pending = loads.get(url);
  if (!pending) return;
  loads.delete(url);

  void pending
    .then((source) => {
      source.scene.traverse((node) => {
        const mesh = node as THREE.Mesh;
        if (!mesh.isMesh) return;
        mesh.geometry.dispose();
        const material = mesh.material;
        for (const entry of Array.isArray(material) ? material : [material]) {
          disposeTextures(entry);
          entry.dispose();
        }
      });
    })
    // Um asset que nunca chegou não tem o que liberar, e a falha já foi
    // relatada por quem pediu o carregamento.
    .catch(() => undefined);
}

/**
 * As texturas de um material.
 *
 * `Material.dispose` **não** as libera — ele só avisa o renderizador de que o
 * programa pode sair do cache —, e são elas que ocupam a memória de vídeo do
 * personagem. Varrer as propriedades é o único caminho genérico: um
 * `MeshStandardMaterial` do glTF traz de cinco a sete mapas, com nomes que
 * dependem do que o exportador escreveu.
 */
function disposeTextures(material: THREE.Material): void {
  for (const value of Object.values(material as unknown as Record<string, unknown>)) {
    const texture = value as THREE.Texture | null;
    if (texture && (texture as THREE.Texture).isTexture) texture.dispose();
  }
}
