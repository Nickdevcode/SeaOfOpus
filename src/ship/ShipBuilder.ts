/**
 * Assembles the whole sloop and hands over the handles the rest of the game has to turn.
 *
 * The build is split into two steps on purpose. `createShipAssets()` generates what is
 * expensive and identical on both ships in the match — textures, materials, hull and
 * every fixed part — and `createShip()` only instances meshes on top of that shared
 * geometry. The enemy ship costs, in GPU memory, practically nothing beyond the few parts
 * that turn.
 *
 * Everything here lives in the ship's local frame (`-Z` forward, `+Y` up, origin at the
 * design waterline). What moves the ship in the world is `ShipBody`, writing into `root`'s
 * matrix — nothing in this module knows where the ship is.
 */

import * as THREE from 'three';
import { buildHullGeometry, type HullGeometrySet } from './HullGeometry';
import { createShipMaterials, type ShipMaterials } from './ShipMaterials';
import {
  buildStaticParts,
  createAnchor,
  createCannon,
  createCapstan,
  createEnsign,
  createPartBuilders,
  createRudder,
  createSailGeometry,
  createWheel,
  meshesFromParts,
  toPartGeometries,
  type CannonAssembly,
  type LanternSpot,
  type PartGeometries,
} from './ShipParts';
import { QUARTERDECK_Y, STATIONS, deckCamber, deckHalfWidth, tToZ } from './ShipDimensions';

/**
 * Where the helmsman stands, behind the wheel, facing the bow.
 *
 * **It used to be 85 cm, and 85 cm is a framing measurement.** It was chosen when the
 * player had no body: with the camera loose behind the wheel, what you were judging was
 * how much of the ship fit on screen. The day the body arrived, the same distance became
 * an **anatomical** measurement — and it does not add up. This rig's arm measures 0.678 m
 * from shoulder to palm (`anim_helm.ARM_REACH`), and the shoulder sits 1.462 m above the
 * feet: for a gap of 0.850 m there are **17 cm** missing that no pose invents for free.
 * In first person it is worse, because the body also steps back by
 * `FIRST_PERSON_SETBACK`.
 *
 * The alternative was to pay the 17 cm with posture — leaning torso, hips forward,
 * shoulder thrown out —, and it existed (`_HelmIntact`). It works, and it looks like what
 * it is: a man stretched over a wheel that is too far away, with his arm at 91% of its
 * extension. Bringing the station closer is cheaper and the helmsman stands **upright**,
 * with his elbow bent and his arm at 88% in the cycle's worst frame.
 *
 * 0.62 is the largest value that keeps that worst frame under 88%, and the smallest that
 * still fits: the after face of the tiller drum sits 0.22 m from the wheel's plane, and
 * 10 cm are left for the player's collision cylinder. Touching this means touching the
 * helm obstacle's radius in `PlayerController` too — that is what used to push the player
 * out of the station.
 */
export const HELM_STAND = new THREE.Vector3(
  0,
  QUARTERDECK_Y + deckCamber(0, deckHalfWidth(STATIONS.helm)),
  tToZ(STATIONS.helm) + 0.62,
);

/**
 * Clones the sail's material and multiplies its color.
 *
 * It multiplies, and does not replace: the canvas already has its own color and texture
 * map, and throwing a flat color on top would erase the cloth's weave. By multiplying,
 * the dye goes through the fabric — which is literally what dye does to canvas.
 *
 * The emissive goes with it, in the same proportion. It exists so the back face does not
 * go black with the sun in front (see `ShipMaterials`), and if it stayed the original
 * color the dyed sail would light up with raw canvas's light when backlit.
 */
function tintSail(base: THREE.MeshStandardMaterial, tint: THREE.ColorRepresentation): THREE.MeshStandardMaterial {
  const material = base.clone();
  material.color.multiply(new THREE.Color(tint));
  material.emissive.multiply(new THREE.Color(tint));
  return material;
}

/** The lanterns' color — an oil flame, good and warm. */
const LANTERN_COLOR = 0xffab5e;
/** Intensity of each lantern's point light, in candela, at full night. */
const LANTERN_INTENSITY = 7;
/** The light's range. Short on purpose: a lantern lights the deck, not the sea. */
const LANTERN_RANGE = 13;

/**
 * What is shared across every ship. Creating this is the expensive part of startup (2D
 * canvas textures plus the hull's sweep), so it runs only once, when the match loads.
 */
export interface ShipAssets {
  materials: ShipMaterials;
  hull: HullGeometrySet;
  /** Geometry of everything that does not move, grouped by material. */
  parts: PartGeometries;
  /** Where the lanterns are, and which of them never go out. */
  lanternSpots: readonly LanternSpot[];
  dispose(): void;
}

export function createShipAssets(): ShipAssets {
  const materials = createShipMaterials();
  const hull = buildHullGeometry();

  const builders = createPartBuilders();
  const { lanterns } = buildStaticParts(builders);
  const parts = toPartGeometries(builders);

  return {
    materials,
    hull,
    parts,
    lanternSpots: lanterns,
    dispose(): void {
      materials.dispose();
      for (const geometry of Object.values(hull)) geometry.dispose();
      for (const geometry of Object.values(parts)) geometry?.dispose();
    },
  };
}

export interface ShipModel {
  /** The ship's root. It is where `ShipBody` writes position and orientation. */
  root: THREE.Group;
  /** The ship's wheel. It turns on its own Z. */
  wheel: THREE.Group;
  /** The capstan. It turns on its own Y while the anchor comes up. */
  capstan: THREE.Group;
  /** The rudder. It turns on its own Y; the angle is what `Rudder` computes. */
  rudder: THREE.Group;
  anchor: THREE.Group;
  /** Index 0 is starboard, index 1 is port. */
  cannons: readonly CannonAssembly[];
  /** The sail's cloth. The geometry belongs to it, and `SailSim` rewrites the positions. */
  sail: THREE.Mesh;
  /** The masthead ensign. Same story as the cloth: `EnsignSim` rewrites it. */
  ensign: THREE.Mesh;
  /** The lanterns' lights, already hung on the ship. */
  lanterns: readonly THREE.PointLight[];
  /**
   * Lights the lanterns or puts them out. `k` runs from 0 (out, and the flame
   * disappears) to 1 (full night) — what decides is `DayNightCycle`.
   */
  setLanternIntensity(k: number): void;
  dispose(): void;
}

export interface ShipOptions {
  /**
   * A color multiplied into the sail, to tell one ship from the other on the horizon.
   *
   * The sail is the only honest place to do this. It is the ship's largest surface, the
   * only one visible at 200 m, and the one a real captain would *choose* — the flag and
   * the canvas were the boat's identity. Painting the hull another color would be lying
   * about the material; changing the silhouette would take a second model.
   *
   * It costs one material clone per ship: the texture maps are shared by reference, so
   * the GPU cost is zero.
   */
  sailTint?: THREE.ColorRepresentation;
}

export function createShip(assets: ShipAssets, name = 'ship', options: ShipOptions = {}): ShipModel {
  const { materials } = assets;
  const root = new THREE.Group();
  root.name = name;

  // The hull: four meshes, one per material.
  for (const [key, geometry] of Object.entries(assets.hull)) {
    const mesh = new THREE.Mesh(geometry, materials[key as keyof HullGeometrySet]);
    mesh.name = `hull-${key}`;
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    root.add(mesh);
  }

  const partMeshes = meshesFromParts(assets.parts, materials, root);
  const flames = partMeshes.filter((mesh) => mesh.material === materials.flame);

  // Moving parts: their own geometry, because each ship turns them a different way.
  const wheel = createWheel(materials);
  const capstan = createCapstan(materials);
  const rudder = createRudder(materials);
  const anchor = createAnchor(materials);
  const cannons = [createCannon(materials, 1), createCannon(materials, -1)] as const;

  root.add(wheel, capstan, rudder, anchor, cannons[0].root, cannons[1].root);

  // The sail: geometry per ship, since `SailSim` rewrites its positions.
  const sailMaterial = options.sailTint === undefined
    ? materials.sail
    : tintSail(materials.sail, options.sailTint);
  const sail = new THREE.Mesh(createSailGeometry(), sailMaterial);
  sail.name = 'sail';
  sail.castShadow = true;
  // It does not receive shadow on purpose. The cloth has zero thickness, so both faces
  // land at the same depth in the shadow map and the sail self-shadows: it gives soft
  // blotches spread over the cloth, which the radius-2.5 PCF spreads further still. You
  // lose the shroud's shadow on the canvas; you gain a clean cloth.
  sail.receiveShadow = false;
  // The cloth deforms every frame, so the bounding sphere computed at creation goes
  // stale. Without this the sail would disappear exactly when it filled.
  sail.frustumCulled = false;
  root.add(sail);

  // The ensign uses the sail's material — this ship's tint included — so it is born
  // crimson on the enemy without a single extra line.
  const ensign = new THREE.Mesh(createEnsign(), sailMaterial);
  ensign.name = 'ensign';
  ensign.castShadow = true;
  ensign.receiveShadow = false;
  // Same reason as the sail: the cloth deforms every frame, and the bounding sphere
  // computed at creation would go stale — the ensign would disappear exactly when it
  // streamed out.
  ensign.frustumCulled = false;
  root.add(ensign);

  const lanterns = assets.lanternSpots.map((spot, index) => {
    const light = new THREE.PointLight(LANTERN_COLOR, 0, LANTERN_RANGE, 2);
    light.name = `lantern-${index}`;
    light.position.copy(spot.position);
    // No shadow: they are mood lights, and each dynamic shadow map here would cost more
    // than everything they light.
    light.castShadow = false;
    root.add(light);
    return light;
  });

  return {
    root,
    wheel,
    capstan,
    rudder,
    anchor,
    cannons,
    sail,
    ensign,
    lanterns,

    setLanternIntensity(k: number): void {
      const clamped = Math.min(Math.max(k, 0), 1);
      lanterns.forEach((light, index) => {
        // The hold's stays lit all day: down there is no hour.
        const on = assets.lanternSpots[index]?.alwaysOn ? 1 : clamped;
        light.intensity = on * LANTERN_INTENSITY;
      });
      // The flame is a shared `MeshBasicMaterial`, and a single mesh carries all of
      // them: what puts it out is the mesh's visibility, not the material's color. Since
      // the hold's never goes out, the mesh stays visible always — what you lose is the
      // deck lanterns' flame disappearing by day, and it is too small for anyone to
      // notice against a sunlit deck.
      for (const flame of flames) flame.visible = true;
    },

    dispose(): void {
      // Only this ship's geometry. The shared one belongs to `ShipAssets`.
      sail.geometry.dispose();
      ensign.geometry.dispose();
      // And the sail's material only if it is this ship's dyed clone. The maps stay out
      // of it: they belong to `ShipAssets`, and `Material.dispose` does not touch them —
      // if it did, tinting one ship would erase the other's texture.
      if (sailMaterial !== materials.sail) sailMaterial.dispose();
      for (const group of [wheel, capstan, rudder, anchor, cannons[0].root, cannons[1].root]) {
        group.traverse((object) => {
          if (object instanceof THREE.Mesh) object.geometry.dispose();
        });
      }
      root.removeFromParent();
    },
  };
}
