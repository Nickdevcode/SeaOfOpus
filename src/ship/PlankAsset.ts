/**
 * The repair plank, loaded once and lent to whoever needs it.
 *
 * It is the project's **second** binary, after the character, and it arrives by the
 * same path: `GLTFLoader`, waiting for nobody, degrading with a console warning if it
 * fails. A game that does not open because a 64 KB plank did not download would be
 * worse than a game where the breach closes without showing the wood.
 *
 * The promise is memoized at module level because there are **two** consumers and they
 * do not know each other: the planks nailed to the planking (`DamageView`, one per
 * ship) and the one that appears in the player's hand (`PlayerAvatar`). Without the
 * memoization, the same file would be fetched three times and become three copies of
 * geometry on the GPU.
 *
 * **The plank comes out of Blender lying down:** length in X, thickness in Y and width
 * in Z, with the origin at the center of mass. The first two are a consequence of
 * glTF's `export_yup` over a Z-up model; the third was chosen in `Props/Plank`
 * precisely so the piece turns in the fist instead of orbiting it. `PLANK_TO_DECAL` is
 * what reconciles those axes with the basis the rest of the game works in.
 */

import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';

/** Length of the piece, in meters. Measured in `Props/Plank/scripts/plank_spec.py`. */
export const PLANK_LENGTH = 1.15;
/** Width of the piece. It is the same plank as the deck's: `DECK_BAND_TILE / 8`. */
export const PLANK_WIDTH = 0.22;
/** Thickness of the piece. */
export const PLANK_THICKNESS = 0.045;

/**
 * Turns the plank from the frame it is born in into the breach decal's.
 *
 * The decal's basis is `X` = the planking's run, `Y` = climbing up it, `Z` = the normal
 * leaving the hull (see `DamageView.orientDecal`). The plank arrives with its width in
 * Z and its thickness in Y, so a quarter turn in X lays the width along the planking
 * and puts the thickness on the normal's axis — which is how you nail a plank to a
 * wall.
 *
 * **Minus a quarter, and not plus one.** The repair happens on the inside: the player
 * goes below, faces the inner planking and nails the plank there. With the positive
 * turn the thickness points outward from the hull, and the face the player sees becomes
 * the piece's **back** — the material is `doubleSided` and draws anyway, but the
 * normals end up inverted and the wood lights against the light coming through the
 * hatch. The negative turn flips the piece, and the top face ends up looking into the
 * hold.
 */
export const PLANK_TO_DECAL = new THREE.Quaternion().setFromAxisAngle(
  new THREE.Vector3(1, 0, 0),
  -Math.PI / 2,
);

export interface PlankAsset {
  /** Shared geometry. Nobody modifies it — they only instantiate it. */
  readonly geometry: THREE.BufferGeometry;
  /** Shared material, with the 1024² atlas that came in the file. */
  readonly material: THREE.Material;
}

/**
 * Brings the plank's tone down to that of the ship it is going to be nailed to.
 *
 * `Props/Plank` painted the piece as **freshly sawn** wood, and did so on purpose: it
 * is a new plank, taken from the magazine. The problem is the neighbor — the planking
 * is almost-black tarred oak, and the piece comes out of the file so light it looks
 * like a pine sticker glued to the hull.
 *
 * The cut is multiplicative and light: the plank **has** to stay lighter than the
 * planking, because that is how you read, from a distance, how many times that ship has
 * been patched. What is taken away here is the excess — the shine of shop-bought wood —
 * not the contrast.
 *
 * The values are in linear space, which is where the multiplication happens.
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
 * Loads the plank, or returns the load that was already in progress.
 *
 * @returns `null` when the file does not arrive — and in that case the game carries on,
 *   with the breach closing with no wood in sight.
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
        console.warn('[plank] the glb arrived with no mesh inside it');
        return null;
      }

      const found = mesh as THREE.Mesh;
      // The node comes with no transform in the file, but reading the matrix instead
      // of assuming identity is what keeps a re-export with the piece displaced from
      // nailing the plank 20 cm beside the breach, with no error in the console.
      found.updateWorldMatrix(true, false);
      const geometry = found.geometry.clone().applyMatrix4(found.matrixWorld);

      const source = Array.isArray(found.material) ? found.material[0]! : found.material;
      return { geometry, material: weather(source) };
    })
    .catch((error: unknown) => {
      console.warn('[plank] could not load the plank:', error);
      return null;
    });

  return pending;
}
