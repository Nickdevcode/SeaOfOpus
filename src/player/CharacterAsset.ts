/**
 * The character on disk, loaded once and worn twice.
 *
 * While there was only one body aboard, `PlayerAvatar` could call `GLTFLoader` on its
 * own: one file, one parse, one owner. With the opponent gaining a body, the same GLB
 * serves **two** avatars — and loading it twice would mean paying twice for 2.4 MB of
 * mesh and five byte-identical textures, plus a second parse inside the frame the duel
 * starts on.
 *
 * So the file is loaded once and **instantiated** per avatar.
 *
 * ## Why the clone is `SkeletonUtils`'s
 *
 * Because `Object3D.clone()` copies the `SkinnedMesh`es still pointing at the
 * **original's skeleton**: the two pirates would start reading the same bones, and what
 * you would see is one of them wearing the other's pose — both walking when one walks,
 * both still when one stops. The clone from here rebuilds the bone tree and rewires the
 * mesh to the copy, which is the only way for two bodies to animate independently.
 *
 * ## What is shared and what is private to each body
 *
 * **Geometry and textures are shared.** They are the two expensive resources and
 * neither of them holds any state about who is using it.
 *
 * **The material is private**, and that is not caution: `installHeadClip` writes an
 * `onBeforeCompile` and a threshold uniform into it, and it is that threshold that
 * makes the head vanish in first person. Shared, the body's owner would decapitate the
 * opponent every time they looked through their own eyes — which is literally the
 * warning left in `headClip.ts` for the day multiplayer arrived. Cloning a material
 * copies texture **references**, so the price is one object per body, not a megabyte.
 *
 * The animation clips are shared too, and they can be: an `AnimationClip` is a table of
 * frames nobody rewrites, and what holds the playback state is each avatar's
 * `AnimationMixer`. The tracks match the bones **by name**, and the clone preserves the
 * names.
 */

import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { clone as cloneSkeleton } from 'three/addons/utils/SkeletonUtils.js';

/**
 * What this module needs from a GLTF, and nothing more.
 *
 * Typed structurally instead of importing the loader's `GLTF` type: it is two fields,
 * and depending on the addon's whole shape would only tie this file to one version of
 * Three.
 */
interface CharacterSource {
  readonly scene: THREE.Group;
  readonly animations: THREE.AnimationClip[];
}

/** A body ready to be hung on an avatar. */
export interface CharacterInstance {
  /** The node to add to the avatar. */
  readonly model: THREE.Object3D;
  /** The file's clips, shared with the other instances. */
  readonly animations: THREE.AnimationClip[];
  /** The skinned mesh, or `null` if the GLB does not bring one. */
  readonly skinned: THREE.SkinnedMesh | null;
  /**
   * **This** instance's materials. They are what the head clipping is installed on, and
   * they are — only they are — what the avatar releases on disposal.
   */
  readonly materials: THREE.Material[];
}

/**
 * One load per URL, and the same `Promise` for whoever arrives afterwards.
 *
 * Memoizing the promise and not the result is what makes two avatars built on the same
 * frame wait for the **same** download: keeping only the result, the second request
 * would go out before the first finished and the file would come twice.
 */
const loads = new Map<string, Promise<CharacterSource>>();

/** Loads the character, or returns the load already in progress. */
export function loadCharacter(url: string): Promise<CharacterSource> {
  const pending = loads.get(url);
  if (pending) return pending;

  const load = new GLTFLoader().loadAsync(url) as Promise<CharacterSource>;
  // A failure leaves the cache: a network error cannot condemn the next match to
  // never trying to load the body again.
  const guarded = load.catch((error: unknown) => {
    loads.delete(url);
    throw error;
  });

  loads.set(url, guarded);
  return guarded;
}

/**
 * Puts on an independent copy of the character.
 *
 * @param source what `loadCharacter` returned.
 */
export function instantiateCharacter(source: CharacterSource): CharacterInstance {
  const model = cloneSkeleton(source.scene);
  const materials: THREE.Material[] = [];
  let skinned: THREE.SkinnedMesh | null = null;

  model.traverse((node) => {
    const mesh = node as THREE.Mesh;
    if (!mesh.isMesh) return;

    // The character is seen up close — by the body's owner and by the opponent.
    // Without this Three culls the mesh when the skeleton takes it outside the rest
    // pose's box.
    mesh.frustumCulled = false;
    mesh.castShadow = true;
    mesh.receiveShadow = true;

    // Private to this instance: see the header's note about the head clipping. The
    // clone keeps the textures, which is what costs memory.
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
 * Releases the mesh and the textures the instances share.
 *
 * ⚠️ **After all of them**, and the order is what matters: the copies point at this
 * geometry and at these textures, so releasing here while a body is still in the scene
 * pulls the floor out from under it. The caller is `Match.dispose`, after disposing of
 * both avatars.
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
    // An asset that never arrived has nothing to release, and the failure has already
    // been reported by whoever requested the load.
    .catch(() => undefined);
}

/**
 * A material's textures.
 *
 * `Material.dispose` does **not** release them — it only tells the renderer the program
 * can leave the cache — and they are what occupies the character's video memory.
 * Sweeping the properties is the only generic route: a glTF `MeshStandardMaterial`
 * brings five to seven maps, with names that depend on what the exporter wrote.
 */
function disposeTextures(material: THREE.Material): void {
  for (const value of Object.values(material as unknown as Record<string, unknown>)) {
    const texture = value as THREE.Texture | null;
    if (texture && (texture as THREE.Texture).isTexture) texture.dispose();
  }
}
