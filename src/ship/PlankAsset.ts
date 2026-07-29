/**
 * A tábua de reparo, carregada uma vez e emprestada a quem precisar.
 *
 * Ela é o **segundo** binário do projeto, depois do personagem, e chega pelo
 * mesmo caminho que ele: `GLTFLoader`, sem esperar ninguém, degradando com um
 * aviso no console se falhar. Um jogo que não abre porque uma tábua de 64 KB
 * não baixou seria pior que um jogo em que o rombo fecha sem mostrar a madeira.
 *
 * A promessa é memoizada no módulo porque há **dois** consumidores e eles não
 * se conhecem: as tábuas pregadas no costado (`DamageView`, uma por navio) e a
 * que aparece na mão do jogador (`PlayerAvatar`). Sem a memoização, o mesmo
 * arquivo seria buscado três vezes e viraria três cópias de geometria na GPU.
 *
 * **A tábua sai do Blender deitada:** comprimento em X, espessura em Y e
 * largura em Z, com a origem no centro de massa. As duas primeiras coisas são
 * consequência do `export_yup` do glTF sobre um modelo Z-up; a terceira foi
 * escolhida em `Props/Plank` justamente para a peça girar no punho em vez de
 * orbitá-lo. `PLANK_TO_DECAL` é o que reconcilia esses eixos com a base em que
 * o resto do jogo trabalha.
 */

import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';

/** Comprimento da peça, em metros. Medido em `Props/Plank/scripts/plank_spec.py`. */
export const PLANK_LENGTH = 1.15;
/** Largura da peça. É a mesma tábua do convés: `DECK_BAND_TILE / 8`. */
export const PLANK_WIDTH = 0.22;
/** Espessura da peça. */
export const PLANK_THICKNESS = 0.045;

/**
 * Gira a tábua do referencial em que ela nasce para o da marca de rombo.
 *
 * A base do decalque é `X` = tabuado do costado, `Y` = subindo por ele, `Z` =
 * normal saindo do casco (ver `DamageView.orientDecal`). A tábua chega com a
 * largura em Z e a espessura em Y, então um quarto de volta em X põe a largura
 * deitada no costado e a espessura no eixo da normal — que é como se prega uma
 * tábua numa parede.
 *
 * **Menos um quarto, e não mais um.** O reparo acontece do lado de dentro: o
 * jogador desce ao porão, fica de frente para o forro e prega a tábua ali. Com
 * o giro positivo a espessura aponta para fora do casco, e a face que o jogador
 * enxerga passa a ser o **verso** da peça — o material é `doubleSided` e
 * desenha assim mesmo, mas as normais ficam invertidas e a madeira acende ao
 * contrário da luz que entra pela escotilha. O giro negativo vira a peça, e a
 * face de cima passa a olhar para dentro do porão.
 */
export const PLANK_TO_DECAL = new THREE.Quaternion().setFromAxisAngle(
  new THREE.Vector3(1, 0, 0),
  -Math.PI / 2,
);

export interface PlankAsset {
  /** Geometria compartilhada. Ninguém a modifica — só a instancia. */
  readonly geometry: THREE.BufferGeometry;
  /** Material compartilhado, com o atlas de 1024² que veio no arquivo. */
  readonly material: THREE.Material;
}

/**
 * Baixa o tom da tábua para o do navio em que ela vai ser pregada.
 *
 * `Props/Plank` pintou a peça como madeira **recém-serrada**, e fez isso de
 * propósito: é uma tábua nova, tirada do paiol. O problema é o vizinho — o
 * costado é carvalho alcatroado quase preto, e a peça sai do arquivo tão clara
 * que parece um adesivo de pinho colado no casco.
 *
 * O corte é multiplicativo e leve: a tábua **tem** que continuar mais clara que
 * o costado, porque é assim que se lê, de longe, quantas vezes aquele navio já
 * foi remendado. O que se tira aqui é o excesso — o brilho de madeira de
 * loja —, não o contraste.
 *
 * Os valores estão em espaço linear, que é onde a multiplicação acontece.
 */
function weather(source: THREE.Material): THREE.Material {
  const material = source.clone();
  if (material instanceof THREE.MeshStandardMaterial) {
    material.color.setRGB(0.62, 0.55, 0.46, THREE.LinearSRGBColorSpace);
  }
  return material;
}

let pending: Promise<PlankAsset | null> | null = null;

/**
 * Carrega a tábua, ou devolve o carregamento que já estava em curso.
 *
 * @returns `null` quando o arquivo não chega — e nesse caso o jogo continua,
 *   com o rombo fechando sem madeira à vista.
 */
export function loadPlank(): Promise<PlankAsset | null> {
  pending ??= new GLTFLoader()
    .loadAsync(`${import.meta.env.BASE_URL}models/plank.glb`)
    .then((gltf) => {
      let mesh: THREE.Mesh | null = null;
      gltf.scene.traverse((node) => {
        if (mesh === null && (node as THREE.Mesh).isMesh) mesh = node as THREE.Mesh;
      });
      if (!mesh) {
        console.warn('[plank] o glb chegou sem malha nenhuma dentro');
        return null;
      }

      const found = mesh as THREE.Mesh;
      // O nó vem sem transformação no arquivo, mas ler a matriz em vez de
      // supor identidade é o que impede um reexport com a peça deslocada de
      // pregar a tábua 20 cm ao lado do rombo, sem nenhum erro no console.
      found.updateWorldMatrix(true, false);
      const geometry = found.geometry.clone().applyMatrix4(found.matrixWorld);

      const source = Array.isArray(found.material) ? found.material[0]! : found.material;
      return { geometry, material: weather(source) };
    })
    .catch((error: unknown) => {
      console.warn('[plank] não deu para carregar a tábua:', error);
      return null;
    });

  return pending;
}
