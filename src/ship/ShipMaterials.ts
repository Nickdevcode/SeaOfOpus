/**
 * The sloop's material palette.
 *
 * It exists apart from whoever builds the geometry for two practical reasons: the
 * textures are expensive to generate and are born once for both ships in the match, and
 * changing the enemy hull's color becomes one line instead of a hunt for
 * `new MeshStandardMaterial`s scattered through the code.
 *
 * Every map comes from `ProceduralTextures`. The ORM's R channel is occlusion, so any
 * geometry using these materials has to have the `uv1` attribute (three reads `aoMap`
 * through it) — `withAoUv` takes care of that.
 */

import * as THREE from 'three';
import {
  createMetalMaps,
  createRopeMaps,
  createSailMaps,
  createWoodMaps,
  disposeMaps,
  type MaterialMaps,
} from '../textures/ProceduralTextures';

/**
 * Duplicates `uv` into `uv1`.
 *
 * Three's `aoMap` samples through the second UV set, an inheritance from glTF, where the
 * occlusion usually has an atlas of its own. Here the occlusion is on the same tile as
 * the color, so the second set is literally a copy — and without it the map disappears
 * with no warning in the console at all.
 */
export function withAoUv(geometry: THREE.BufferGeometry): THREE.BufferGeometry {
  const uv = geometry.getAttribute('uv');
  if (uv && !geometry.getAttribute('uv1')) geometry.setAttribute('uv1', uv);
  return geometry;
}

/**
 * `normalScale` comes in as a scalar for convenience — both axes always move together
 * here. It has to be an `Omit` and not an intersection: crossing with three's type would
 * give `Vector2 & number`, which no value satisfies.
 */
function standard(
  maps: MaterialMaps,
  options: Omit<THREE.MeshStandardMaterialParameters, 'normalScale'> & { normalScale?: number } = {},
): THREE.MeshStandardMaterial {
  const { normalScale = 1, ...rest } = options;
  return new THREE.MeshStandardMaterial({
    map: maps.map,
    normalMap: maps.normalMap,
    normalScale: new THREE.Vector2(normalScale, normalScale),
    aoMap: maps.ormMap,
    roughnessMap: maps.ormMap,
    metalnessMap: maps.ormMap,
    // With the maps present these scalars become multipliers; leaving them at 1 is what
    // preserves what the texture wrote into each channel.
    roughness: 1,
    metalness: 1,
    aoMapIntensity: 0.9,
    ...rest,
  });
}

export interface ShipMaterials {
  /** The outer side: tarred oak, nearly black. */
  hull: THREE.MeshStandardMaterial;
  /** The deck: pale oak, sanded by feet and salt. */
  deck: THREE.MeshStandardMaterial;
  /** Interior wood of the hold and of the bulwark's inner face. */
  interior: THREE.MeshStandardMaterial;
  /** Turned pieces: mast, yard, capstan, helm. */
  spar: THREE.MeshStandardMaterial;
  /** Decorative band and carvings — the sloop's characteristic red. */
  trim: THREE.MeshStandardMaterial;
  sail: THREE.MeshStandardMaterial;
  rope: THREE.MeshStandardMaterial;
  iron: THREE.MeshStandardMaterial;
  brass: THREE.MeshStandardMaterial;
  glass: THREE.MeshPhysicalMaterial;
  /** The lantern's flame: emissive only, depending on no scene light. */
  flame: THREE.MeshBasicMaterial;

  dispose(): void;
}

/**
 * Generates textures and materials. It runs once per match — a few tenths of a second of
 * 2D canvas, so it must never be called inside the loop.
 */
export function createShipMaterials(): ShipMaterials {
  const hullMaps = createWoodMaps({
    base: [0.2, 0.135, 0.095],
    grain: [0.075, 0.05, 0.035],
    planks: 10,
    plankAspect: 2.2,
    wear: 0.35,
    nails: true,
    seed: 4021,
    repeat: [1, 1],
  });

  const deckMaps = createWoodMaps({
    base: [0.56, 0.44, 0.31],
    grain: [0.31, 0.22, 0.14],
    planks: 8,
    plankAspect: 3,
    wear: 0.75,
    nails: true,
    seed: 1181,
  });

  const interiorMaps = createWoodMaps({
    base: [0.38, 0.27, 0.18],
    grain: [0.17, 0.11, 0.07],
    planks: 9,
    plankAspect: 2.6,
    wear: 0.3,
    nails: true,
    seed: 7703,
  });

  const sparMaps = createWoodMaps({
    base: [0.45, 0.33, 0.21],
    grain: [0.22, 0.15, 0.09],
    planks: 1,
    plankAspect: 6,
    wear: 0.45,
    nails: false,
    seed: 5519,
  });

  const trimMaps = createWoodMaps({
    base: [0.33, 0.08, 0.06],
    grain: [0.13, 0.03, 0.025],
    planks: 3,
    plankAspect: 4,
    wear: 0.5,
    nails: false,
    seed: 3313,
  });

  const sailMaps = createSailMaps();
  const ropeMaps = createRopeMaps();
  // A cannon's cast iron comes out of the foundry sand matte: with polished-metal
  // roughness it read as obsidian, not as a piece of artillery.
  const ironMaps = createMetalMaps({
    base: [0.2, 0.2, 0.21],
    corrosion: 0.42,
    metalness: 0.95,
    roughness: 0.62,
    seed: 811,
  });
  // Brass aboard is *working* brass: exposed to the salt air, it dulls in days.
  //
  // The roughness is still high (0.62, the same as the cast iron) for the usual reason: a
  // working piece does not throw the sun back like a mirror, and the polished plate read
  // as a gold bar left on the quarterdeck.
  //
  // **The corrosion, that one, came down from 0.26 to 0.12**, and the reason is that the
  // brass changed size on the ship. It had been calibrated on a 50 × 42 cm binnacle lid —
  // a large surface, where 26% of verdigris becomes texture. That lid stopped existing,
  // and what is left of the brass are small pieces **close to the eye**: the binnacle's
  // corner pieces and, above all, the handle that marks the rudder amidships, half a
  // meter from the camera of whoever is steering. At that scale, a quarter of green stain
  // does not read as patina — it reads as slime, and the mark that has to say "this is
  // brass, look at me" showed up moldy. The blue-green is still the oxide's right color
  // (a copper alloy makes verdigris, not rust); what changed was the dose.
  const brassMaps = createMetalMaps({
    base: [0.76, 0.58, 0.26],
    corrosion: 0.12,
    metalness: 0.9,
    roughness: 0.58,
    corrosionColor: [0.24, 0.38, 0.31],
    seed: 1607,
  });

  const allMaps = [hullMaps, deckMaps, interiorMaps, sparMaps, trimMaps, sailMaps, ropeMaps, ironMaps, brassMaps];

  const materials: ShipMaterials = {
    hull: standard(hullMaps, { normalScale: 1.1 }),
    deck: standard(deckMaps, { normalScale: 0.9 }),
    interior: standard(interiorMaps),
    spar: standard(sparMaps, { normalScale: 0.8 }),
    trim: standard(trimMaps),
    // The sail is seen from both sides and it is thin: `DoubleSide` plus a little light
    // transmission is what gives the glow of sun coming through the cloth.
    sail: standard(sailMaps, {
      side: THREE.DoubleSide,
      normalScale: 0.7,
      // Without this the back face goes black when the sun hits the front. The tone is
      // warm on purpose: the light crossing the canvas comes out with the canvas's color,
      // and that is what keeps a shaded sail from reading as a blue-gray plate.
      emissive: new THREE.Color(0x2a2016),
    }),
    rope: standard(ropeMaps, { normalScale: 1.3 }),
    // Restrained relief: tightening the cannon barrel's UV doubled the map's frequency,
    // and it is the *slope* (amplitude × frequency) that produces the jagged glint. Half
    // the previous scale keeps the foundry pitting legible without turning every pit into
    // a crater with a shadow of its own.
    iron: standard(ironMaps, { normalScale: 0.45 }),
    brass: standard(brassMaps, { normalScale: 0.9 }),
    glass: new THREE.MeshPhysicalMaterial({
      color: 0xd8cba8,
      roughness: 0.12,
      metalness: 0,
      transmission: 0.85,
      thickness: 0.01,
      transparent: true,
      opacity: 0.5,
    }),
    // Color above 1 on purpose: it is what the compositor's bloom looks for.
    flame: new THREE.MeshBasicMaterial({ color: new THREE.Color(9, 4.4, 1.4), fog: false }),

    dispose(): void {
      for (const maps of allMaps) disposeMaps(maps);
      for (const value of Object.values(materials)) {
        if (value instanceof THREE.Material) value.dispose();
      }
    },
  };

  return materials;
}
