/**
 * Monta a Chalupa inteira e entrega as alças que o resto do jogo precisa girar.
 *
 * A construção é dividida em dois passos de propósito. `createShipAssets()` gera
 * o que é caro e idêntico nos dois navios da partida — texturas, materiais,
 * casco e todas as peças fixas — e `createShip()` só instancia malhas em cima
 * dessa geometria compartilhada. O navio inimigo custa, em memória de GPU,
 * praticamente nada além das poucas peças que giram.
 *
 * Tudo aqui vive no sistema local do navio (`-Z` proa, `+Y` cima, origem na
 * linha d'água de projeto). Quem move o navio no mundo é `ShipBody`, escrevendo
 * na matriz de `root` — nada neste módulo sabe onde o navio está.
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
 * Onde o timoneiro fica de pé, atrás da roda, olhando para a proa.
 *
 * **Eram 85 cm, e 85 cm é uma medida de enquadramento.** Foi escolhida quando o
 * jogador não tinha corpo: com a câmera solta atrás da roda, o que se julgava era
 * quanto do navio cabia na tela. No dia em que o corpo chegou, a mesma distância
 * virou uma medida **anatômica** — e não fecha. O braço deste rig mede 0,678 m do
 * ombro à palma (`anim_helm.ARM_REACH`), e o ombro fica 1,462 m acima dos pés:
 * para um vão de 0,850 m faltam **17 cm** que nenhuma pose inventa de graça. Em
 * primeira pessoa é pior, porque o corpo ainda recua `FIRST_PERSON_SETBACK`.
 *
 * A alternativa era pagar os 17 cm com postura — tronco inclinado, quadril
 * avançado, ombro projetado —, e ela existiu (`_HelmIntact`). Funciona, e parece
 * o que é: um homem esticado sobre uma roda longe demais, com o braço a 91% da
 * extensão. Aproximar o posto sai mais barato e o timoneiro fica **em pé**, com o
 * cotovelo dobrado e o braço em 88% no pior quadro do ciclo.
 *
 * 0,62 é o maior valor que mantém esse pior quadro abaixo dos 88%, e o menor que
 * ainda cabe: a face de ré do tambor do leme fica a 0,22 m do plano da roda, e
 * sobram 10 cm para o cilindro de colisão do jogador. Mexer aqui pede mexer junto
 * no raio do obstáculo do timão, em `PlayerController` — foi ele que expulsava o
 * jogador do posto.
 */
export const HELM_STAND = new THREE.Vector3(
  0,
  QUARTERDECK_Y + deckCamber(0, deckHalfWidth(STATIONS.helm)),
  tToZ(STATIONS.helm) + 0.62,
);

/**
 * Clona o material da vela e multiplica a cor dele.
 *
 * Multiplica, e não substitui: a lona já tem cor e mapa de textura próprios, e
 * jogar uma cor chapada em cima apagaria a trama do pano. Multiplicando, o tingido
 * atravessa o tecido — que é literalmente o que tinta faz em lona.
 *
 * O emissivo vai junto, na mesma proporção. Ele existe para a face de trás não
 * ficar preta com o sol de frente (ver `ShipMaterials`), e se ficasse na cor
 * original a vela tingida acenderia com a luz do pano cru na contraluz.
 */
function tintSail(base: THREE.MeshStandardMaterial, tint: THREE.ColorRepresentation): THREE.MeshStandardMaterial {
  const material = base.clone();
  material.color.multiply(new THREE.Color(tint));
  material.emissive.multiply(new THREE.Color(tint));
  return material;
}

/** Cor das lanternas — chama de óleo, bem quente. */
const LANTERN_COLOR = 0xffab5e;
/** Intensidade da luz pontual de cada lanterna, em candela, com a noite fechada. */
const LANTERN_INTENSITY = 7;
/** Alcance da luz. Curto de propósito: lanterna ilumina o convés, não o mar. */
const LANTERN_RANGE = 13;

/**
 * O que é compartilhado entre todos os navios. Criar isso é a parte cara da
 * inicialização (texturas em canvas 2D mais a varredura do casco), então roda
 * uma vez só, no carregamento da partida.
 */
export interface ShipAssets {
  materials: ShipMaterials;
  hull: HullGeometrySet;
  /** Geometria de tudo que não se mexe, agrupada por material. */
  parts: PartGeometries;
  /** Onde ficam as lanternas, e quais delas nunca apagam. */
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
  /** Raiz do navio. É nela que `ShipBody` escreve posição e orientação. */
  root: THREE.Group;
  /** Roda do timão. Gira no próprio Z. */
  wheel: THREE.Group;
  /** Cabrestante. Gira no próprio Y enquanto a âncora sobe. */
  capstan: THREE.Group;
  /** Leme. Gira no próprio Y; o ângulo é o que `Rudder` calcula. */
  rudder: THREE.Group;
  anchor: THREE.Group;
  /** Índice 0 é boreste, índice 1 é bombordo. */
  cannons: readonly CannonAssembly[];
  /** Pano da vela. A geometria é dele, e `SailSim` reescreve as posições. */
  sail: THREE.Mesh;
  /** Bandeira do tope. Mesma história do pano: `EnsignSim` a reescreve. */
  ensign: THREE.Mesh;
  /** Luzes das lanternas, já penduradas no navio. */
  lanterns: readonly THREE.PointLight[];
  /**
   * Acende ou apaga as lanternas. `k` vai de 0 (apagadas, e a chama some) a 1
   * (noite fechada) — quem decide é `DayNightCycle`.
   */
  setLanternIntensity(k: number): void;
  dispose(): void;
}

export interface ShipOptions {
  /**
   * Cor multiplicada na vela, para distinguir um navio do outro no horizonte.
   *
   * A vela é o único lugar honesto para fazer isso. É a maior superfície do navio,
   * a única visível a 200 m, e a que um capitão de verdade *escolheria* — bandeira e
   * pano eram a identidade do barco. Pintar o casco de outra cor seria mentir sobre
   * o material; trocar a silhueta exigiria um segundo modelo.
   *
   * Custa um clone de material por navio: os mapas de textura são compartilhados
   * por referência, então o gasto de GPU é zero.
   */
  sailTint?: THREE.ColorRepresentation;
}

export function createShip(assets: ShipAssets, name = 'ship', options: ShipOptions = {}): ShipModel {
  const { materials } = assets;
  const root = new THREE.Group();
  root.name = name;

  // Casco: quatro malhas, uma por material.
  for (const [key, geometry] of Object.entries(assets.hull)) {
    const mesh = new THREE.Mesh(geometry, materials[key as keyof HullGeometrySet]);
    mesh.name = `hull-${key}`;
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    root.add(mesh);
  }

  const partMeshes = meshesFromParts(assets.parts, materials, root);
  const flames = partMeshes.filter((mesh) => mesh.material === materials.flame);

  // Peças móveis: geometria própria, porque cada navio as gira para um lado.
  const wheel = createWheel(materials);
  const capstan = createCapstan(materials);
  const rudder = createRudder(materials);
  const anchor = createAnchor(materials);
  const cannons = [createCannon(materials, 1), createCannon(materials, -1)] as const;

  root.add(wheel, capstan, rudder, anchor, cannons[0].root, cannons[1].root);

  // Vela: geometria por navio, já que `SailSim` reescreve as posições dela.
  const sailMaterial = options.sailTint === undefined
    ? materials.sail
    : tintSail(materials.sail, options.sailTint);
  const sail = new THREE.Mesh(createSailGeometry(), sailMaterial);
  sail.name = 'sail';
  sail.castShadow = true;
  // Não recebe sombra de propósito. O pano tem espessura zero, então as duas
  // faces caem na mesma profundidade do shadow map e a vela se auto-sombreia:
  // dá manchas moles espalhadas pelo pano, que o PCF de raio 2.5 ainda espalha
  // mais. Perde-se a sombra da enxárcia sobre a lona; ganha-se um pano limpo.
  sail.receiveShadow = false;
  // O pano se deforma todo quadro, então a esfera envolvente calculada na
  // criação envelhece. Sem isto a vela sumiria justamente quando enfunasse.
  sail.frustumCulled = false;
  root.add(sail);

  // A bandeira usa o mesmo material da vela — inclusive o tingido deste navio —
  // então ela nasce carmim no inimigo sem nenhuma linha a mais.
  const ensign = new THREE.Mesh(createEnsign(), sailMaterial);
  ensign.name = 'ensign';
  ensign.castShadow = true;
  ensign.receiveShadow = false;
  // Mesmo motivo da vela: o pano se deforma todo quadro, e a esfera envolvente
  // calculada na criação envelheceria — a bandeira sumiria justo quando esticasse.
  ensign.frustumCulled = false;
  root.add(ensign);

  const lanterns = assets.lanternSpots.map((spot, index) => {
    const light = new THREE.PointLight(LANTERN_COLOR, 0, LANTERN_RANGE, 2);
    light.name = `lantern-${index}`;
    light.position.copy(spot.position);
    // Sem sombra: são luzes de ambientação, e cada mapa de sombra dinâmico aqui
    // custaria mais que tudo que elas iluminam.
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
        // A do porão fica acesa o dia inteiro: lá embaixo não existe hora.
        const on = assets.lanternSpots[index]?.alwaysOn ? 1 : clamped;
        light.intensity = on * LANTERN_INTENSITY;
      });
      // A chama é `MeshBasicMaterial` compartilhado, e uma malha só carrega
      // todas elas: quem apaga é a visibilidade da malha, não a cor do
      // material. Como a do porão nunca apaga, a malha fica sempre visível — o
      // que se perde é a chama das de convés sumindo de dia, e ela é pequena
      // demais para alguém notar contra um convés iluminado pelo sol.
      for (const flame of flames) flame.visible = true;
    },

    dispose(): void {
      // Só a geometria deste navio. A compartilhada é de `ShipAssets`.
      sail.geometry.dispose();
      ensign.geometry.dispose();
      // E o material da vela apenas se ele for o clone tingido deste navio. Os
      // mapas ficam de fora: são de `ShipAssets`, e `Material.dispose` não os
      // toca — se tocasse, tingir um navio apagaria a textura do outro.
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
