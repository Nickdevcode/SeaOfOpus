/**
 * A paleta de materiais da Chalupa.
 *
 * Existe separado de quem constrói a geometria por dois motivos práticos: as
 * texturas são caras de gerar e nascem uma vez só para os dois navios da
 * partida, e trocar a cor do casco do inimigo vira uma linha em vez de uma
 * caçada por `new MeshStandardMaterial` espalhados pelo código.
 *
 * Todos os mapas vêm de `ProceduralTextures`. O canal R do ORM é oclusão, então
 * toda geometria que usar estes materiais precisa ter o atributo `uv1` (o three
 * lê `aoMap` por ele) — `withAoUv` cuida disso.
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
 * Duplica `uv` em `uv1`.
 *
 * O `aoMap` do three amostra pelo segundo conjunto de UV, uma herança do glTF,
 * onde a oclusão costuma ter um atlas próprio. Aqui a oclusão está no mesmo
 * ladrilho da cor, então o segundo conjunto é literalmente uma cópia — e sem
 * ela o mapa some sem nenhum aviso no console.
 */
export function withAoUv(geometry: THREE.BufferGeometry): THREE.BufferGeometry {
  const uv = geometry.getAttribute('uv');
  if (uv && !geometry.getAttribute('uv1')) geometry.setAttribute('uv1', uv);
  return geometry;
}

/**
 * `normalScale` entra como escalar por conveniência — os dois eixos sempre andam
 * juntos aqui. Precisa ser `Omit` e não interseção: cruzar com o tipo do three
 * daria `Vector2 & number`, que nenhum valor satisfaz.
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
    // Com os mapas presentes estes escalares viram multiplicadores; deixá-los
    // em 1 é o que preserva o que a textura escreveu em cada canal.
    roughness: 1,
    metalness: 1,
    aoMapIntensity: 0.9,
    ...rest,
  });
}

export interface ShipMaterials {
  /** Costado externo: carvalho alcatroado, quase preto. */
  hull: THREE.MeshStandardMaterial;
  /** Convés: carvalho claro, lixado pelo pé e pelo sal. */
  deck: THREE.MeshStandardMaterial;
  /** Madeira interna do porão e da amurada por dentro. */
  interior: THREE.MeshStandardMaterial;
  /** Peças torneadas: mastro, verga, cabrestante, timão. */
  spar: THREE.MeshStandardMaterial;
  /** Faixa decorativa e entalhes — o vermelho característico da Chalupa. */
  trim: THREE.MeshStandardMaterial;
  sail: THREE.MeshStandardMaterial;
  rope: THREE.MeshStandardMaterial;
  iron: THREE.MeshStandardMaterial;
  brass: THREE.MeshStandardMaterial;
  glass: THREE.MeshPhysicalMaterial;
  /** Chama da lanterna: só emissivo, sem depender de luz da cena. */
  flame: THREE.MeshBasicMaterial;

  dispose(): void;
}

/**
 * Gera texturas e materiais. Roda uma vez por partida — são alguns décimos de
 * segundo de canvas 2D, então nunca deve ser chamada dentro do laço.
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
  // Ferro fundido de canhão sai da areia de fundição fosco: com rugosidade de
  // metal polido ele lia como obsidiana, não como peça de artilharia.
  const ironMaps = createMetalMaps({
    base: [0.2, 0.2, 0.21],
    corrosion: 0.42,
    metalness: 0.95,
    roughness: 0.62,
    seed: 811,
  });
  // Latão de bordo é latão *de trabalho*: exposto à maresia, ele embaça em dias.
  //
  // A rugosidade continua alta (0,62, a mesma do ferro fundido) pelo motivo de
  // sempre: peça de serviço não devolve o sol como espelho, e a chapa polida
  // lia como barra de ouro largada no tombadilho.
  //
  // **A corrosão, essa, caiu de 0,26 para 0,12**, e a razão é que o latão mudou
  // de tamanho no navio. Ela tinha sido calibrada numa tampa de bitácula de
  // 50 × 42 cm — superfície grande, onde 26% de zinabre vira textura. Essa tampa
  // deixou de existir, e o que restou de latão são peças pequenas e **próximas
  // do olho**: as cantoneiras da bitácula e, principalmente, o punho que marca o
  // leme a meio, a meio metro da câmera de quem governa. Nessa escala, um quarto
  // de mancha verde não lê como pátina — lê como limo, e a marca que precisa
  // dizer "isto aqui é latão, repare em mim" aparecia mofada. O verde-azulado
  // continua sendo a cor certa do óxido (liga de cobre cria zinabre, não
  // ferrugem); o que mudou foi a dose.
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
    // A vela é vista dos dois lados e é fina: `DoubleSide` mais um pouco de
    // transmissão de luz é o que dá o brilho de sol atravessando o pano.
    sail: standard(sailMaps, {
      side: THREE.DoubleSide,
      normalScale: 0.7,
      // Sem isso a face de trás fica preta quando o sol bate na frente. O tom
      // é quente de propósito: a luz que atravessa a lona sai com a cor dela,
      // e é isso que impede a vela na sombra de ler como chapa cinza-azulada.
      emissive: new THREE.Color(0x2a2016),
    }),
    rope: standard(ropeMaps, { normalScale: 1.3 }),
    // Relevo contido: adensar o UV do cano do canhão dobrou a frequência do
    // mapa, e é a *inclinação* (amplitude × frequência) que produz o brilho
    // serrilhado. Metade da escala anterior mantém a picotagem de fundição
    // legível sem transformar cada pite numa cratera com sombra própria.
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
    // Cor acima de 1 de propósito: é o que o bloom do compositor procura.
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
