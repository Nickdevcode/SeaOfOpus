/**
 * A marca que um tiro deixa no costado.
 *
 * O rombo era um disco preto de nove lados, e o problema dele não era ser feio —
 * era não ser **legível**. Um disco chapado no meio de um costado escuro não diz
 * onde a bala bateu; diz que ali falta alguma coisa. O que denuncia um rombo de
 * verdade, e o que o Sea of Thieves acerta, é o que está **em volta** dele: a
 * fuligem que a bala espalha, o miolo claro da tábua que ficou exposto quando a
 * superfície envelhecida foi arrancada, e as lascas que sobraram apontando para
 * fora. O buraco é a menor parte da marca.
 *
 * Então esta peça desenha três anéis em vez de um disco:
 *
 * | zona | raio | o que é |
 * |---|---|---|
 * | furo | até `HOLE_R` | o porão, visto de fora. Escuro de verdade |
 * | lasca | até `LIP_R` | miolo da tábua, claro, com fibras e relevo |
 * | fuligem | até 1 | a mancha da explosão, apagando na madeira sã |
 *
 * **Três decisões que valem o comentário:**
 *
 * 1. **A silhueta é irregular, e a irregularidade mora nos dois lados.** A mesma
 *    função `breachWobble` deforma os vértices no shader de vértice e decide
 *    onde cada zona de cor começa no de fragmento. Se as duas divergissem, a
 *    pintura escorregaria para fora da forma — que é exatamente o defeito que
 *    faz um decalque parecer adesivo.
 *
 * 2. **O furo não tem profundidade geométrica, tem parallax.** Afundar a malha
 *    para dentro do casco não funciona: o costado é opaco e o z-buffer o
 *    esconderia. Então o fundo é amostrado com um deslocamento proporcional à
 *    direção de visão, e o buraco *desliza* quando a câmera anda — que é a
 *    única pista de profundidade que o olho realmente usa a esta distância.
 *
 * 3. **As lascas, essas sim, são geometria.** Elas sobem `SPLINTER_RISE` para
 *    **fora** do costado, onde não há z-buffer para brigar, e é delas que vem a
 *    silhueta quebrada que se vê de raspão — a coisa que nenhuma textura imita.
 *
 * O material é `MeshStandardMaterial` costurado por `onBeforeCompile`, e não um
 * `ShaderMaterial` do zero, porque assim o rombo recebe de graça o mesmo sol, as
 * mesmas sombras, o mesmo nevoeiro e o mesmo mapeamento de tons que o casco em
 * que ele está pregado. Um shader próprio teria de reimplementar tudo isso para
 * não denunciar a colagem em dia de temporal.
 */

import * as THREE from 'three';
import { NOISE_GLSL } from '../shaders/noise';

/**
 * As cores da marca, escritas em sRGB e entregues ao shader em linear.
 *
 * A conversão não é detalhe: `diffuseColor` vive em espaço linear, e as cores
 * do resto do navio chegam lá pela textura, que o Three converte sozinho. Uma
 * cor escrita à mão pula essa etapa — e escrever `0.36` achando que é o mesmo
 * `0.36` do costado põe a madeira **dez vezes** mais clara que ele. O sintoma
 * foi uma coroa branca em volta do furo, com cara de espuma do mar.
 *
 * Os valores saem da paleta que `ShipMaterials` já usa: o costado é `0.2` de
 * base e o convés `0.56`. O miolo exposto tem de cair entre os dois — é madeira
 * nova, mas é madeira de dentro de uma tábua alcatroada, não tábua de convés
 * lixada pelo sal.
 */
const COLORS = {
  /** Miolo da tábua, aberto pela bala. O mais claro da marca. */
  board: 0x7d5e3b,
  /** A borda imediata do furo: madeira chamuscada pela passagem da bala. */
  char: 0x241a12,
  /** O corte na espessura do costado, visto de lado por dentro do furo. */
  wall: 0x15100b,
  /** O porão. Não é preto por elegância — é preto porque lá não entra luz. */
  void: 0x050404,
  /**
   * A tábua do reparo, vista **pelo buraco**, de fora do casco.
   *
   * O remendo é pregado do lado de dentro (ver `DamageView.PLANK_DEPTH`), então
   * o furo no costado continua lá depois de fechado — o que mudou é o que se vê
   * no fundo dele. Mais clara que o miolo lascado porque é madeira que nunca
   * pegou sol nem alcatrão.
   */
  patch: 0x8f7049,
  /** A mancha de fuligem que a explosão deixa na madeira sã em volta. */
  soot: 0x120d0a,
  /**
   * Miolo da tábua visto **por dentro**, onde a bala saiu.
   *
   * Mais claro que `board` porque esta madeira nunca viu alcatrão nem sol: o
   * costado é breado por fora, e o que a face de saída expõe é o carvalho cru
   * do meio da tábua. É esse contraste — e não o buraco — que faz o rombo ser
   * achado no escuro do porão.
   *
   * O valor tem de ser medido contra o **forro**, e não contra o costado. Uma
   * primeira versão saiu em 0x9a7548, um tom acima de `board`, e a diferença
   * evaporou: no porão o miolo mediu mais **escuro** que a tábua ao lado dele,
   * e o rombo aberto virava uma mancha suja em vez de madeira arrancada. Este
   * tom fica entre a base do costado (0,2 linear) e a do convés (0,56) — é
   * madeira nova, mas madeira do meio de uma tábua alcatroada, não tábua de
   * convés lixada pelo sal.
   */
  rawBoard: 0xb28a5c,
  /**
   * O fundo do furo visto de dentro.
   *
   * **Não** é uma janela para o mar. Um vão mostrando oceano lê como recorte de
   * cenário: o que está ali de verdade é madeira encharcada com água entrando, e
   * o olho reconhece isso como buraco muito mais depressa do que reconheceria um
   * pedaço de horizonte do tamanho de um punho.
   */
  flood: 0x081413,
} as const;

/** `vec3(r, g, b)` em linear, pronto para colar no GLSL. */
function linearGlsl(hex: number): string {
  const color = new THREE.Color(hex).convertSRGBToLinear();
  return `vec3(${color.r.toFixed(5)}, ${color.g.toFixed(5)}, ${color.b.toFixed(5)})`;
}

/**
 * Raio do furo de verdade, em fração do raio da marca.
 *
 * Com o raio típico de 45 cm dá um vão de 31 cm, que é o número que
 * `ShipDamage.BREACH_AREA` já usava para calcular a vazão — *"uma bala de 10 cm
 * não abre um furo de 10 cm: ela estilhaça a tábua e leva embora um pedaço de
 * uns 30 cm de vão"*. O furo desenhado e o furo que a água atravessa passam a
 * ser o mesmo furo, e é o resto da marca — mais de meio metro de fuligem — que
 * responde pela pergunta de onde a bala bateu.
 */
const HOLE_R = 0.34;
/** Até onde vai o miolo lascado. Depois disto é só fuligem. */
const LIP_R = 0.6;

/**
 * Quanto as lascas sobem acima do costado, em fração do raio.
 *
 * Com o raio típico de 45 cm dá 4,5 cm de madeira em pé — a ordem de grandeza
 * certa para um costado de 13 cm estilhaçado, e o suficiente para a silhueta
 * aparecer contra o céu quando se olha o casco de raspão.
 */
const SPLINTER_RISE = 0.1;

/**
 * Profundidade aparente do furo, em fração do raio.
 *
 * Não é uma medida do casco: é o quanto o fundo desliza por unidade de
 * inclinação da visão. Meio raio é o que faz o buraco ler como buraco sem que o
 * deslize denuncie a farsa em ângulo rasante.
 */
const HOLE_DEPTH = 0.5;

/** Segmentos em volta. 24 já dá borda quebrada sem contar triângulo à toa. */
const SEGMENTS = 24;

/**
 * Perfil radial da marca, do centro para fora.
 *
 * `edge` é o quanto aquele anel obedece à deformação angular — máximo no lábio
 * do furo, que é onde a madeira arrebentou, e zero nas duas pontas, para o
 * centro não girar em falso e a borda externa fechar redonda contra a madeira sã.
 *
 * `rise` é a altura da lasca, em fração de `SPLINTER_RISE`.
 */
const RINGS: readonly { r: number; edge: number; rise: number }[] = [
  { r: 0.0, edge: 0.0, rise: 0.0 },
  { r: 0.2, edge: 0.3, rise: 0.0 },
  { r: HOLE_R, edge: 1.0, rise: 0.0 },
  { r: 0.46, edge: 0.9, rise: 1.0 },
  { r: LIP_R, edge: 0.7, rise: 0.45 },
  { r: 0.8, edge: 0.3, rise: 0.05 },
  { r: 1.0, edge: 0.0, rise: 0.0 },
];

/**
 * Deformação angular da marca — a mesma no vértice e no fragmento.
 *
 * Três harmônicas em vez de ruído amostrado: assim ela é periódica em 2π **por
 * construção**, e a costura do anel fecha sem emenda. Um `snoise(θ)` precisaria
 * de um domínio circular para não dar um degrau em θ = π.
 */
const WOBBLE_GLSL = /* glsl */ `
  float breachWobble(float ang, float seed) {
    return 0.42 * sin(3.0 * ang + seed * 6.2831)
         + 0.24 * sin(5.0 * ang - seed * 11.0 + 1.7)
         + 0.19 * sin(9.0 * ang + seed * 17.0 + 3.1)
         + 0.15 * sin(14.0 * ang - seed * 23.0 + 0.6);
  }
`;

/**
 * Quanto o furo é mais largo do que alto.
 *
 * Madeira não abre buraco redondo. Ela parte **ao longo da fibra**, e a fibra
 * do costado corre no sentido do comprimento do navio — que é o X da marca. O
 * mesmo golpe que arranca 30 cm na horizontal arranca uns 20 na vertical, e é
 * essa diferença que faz o estrago ler como madeira em vez de chapa.
 */
const FIBER_STRETCH = 1.35;

/**
 * O que separa a face por onde a bala **entra** da face por onde ela **sai**.
 *
 * A mesma marca espelhada não serve, e essa é a única coisa que realmente
 * importa neste bloco. Numa tábua, o lado de saída estilhaça muito mais que o de
 * entrada: é o *spall*, e em navio de linha a chuva de lascas que ele levantava
 * feria mais gente que a própria bala. Na entrada quem manda é a pólvora —
 * fuligem, borda chamuscada, madeira comprimida. Na saída quem manda é a fibra —
 * lasca grande, madeira crua e clara, quase nenhuma queimadura.
 *
 * Há um segundo motivo, de leitura, e ele puxa para o mesmo lado. De fora, o
 * rombo disputa a atenção com um casco inteiro sob o sol. De dentro, ele é a
 * única coisa acontecendo num porão escuro, e é por ele que o jogador procura
 * quando desce com a tábua na mão. A face de dentro pode — e deve — gritar mais
 * alto que a de fora.
 */
interface BreachFace {
  /** Sufixo da chave de cache do programa. Duas faces, dois shaders. */
  readonly id: string;
  /** Multiplica a altura das lascas. A saída lasca mais que a entrada. */
  readonly riseScale: number;
  /**
   * Altura das lascas com o rombo tapado, em fração da altura aberta.
   *
   * Pregar tábua **achata** o que estava em pé — mas o número real vem de uma
   * restrição de espaço: a tábua encosta a poucos centímetros da marca (ver
   * `DamageView.PLANK_DEPTH`), e lasca que não baixe o suficiente atravessa a
   * madeira que acabou de ser pregada.
   */
  readonly closedRise: number;
  /** Quanto o miolo claro avança sobre a fuligem. */
  readonly lipScale: number;
  /** Peso da fuligem sobre a madeira sã em volta. */
  readonly sootWeight: number;
  /** Peso da queimadura na borda imediata do furo. */
  readonly charWeight: number;
  /** Cor do miolo exposto. */
  readonly boardColor: number;
  /** O que se vê no fundo do furo aberto. */
  readonly voidColor: number;
  /** Rugosidade do fundo do furo. Madeira encharcada reflete; breu não. */
  readonly voidRoughness: number;
  /** Quanto da luz sobra no fundo do furo aberto. */
  readonly voidOcclusion: number;
  /**
   * Quanto da luz sobra no miolo exposto.
   *
   * Do lado de fora o miolo está numa cova rasa e recebe menos céu que a
   * superfície em volta — a sombra é o que dá a leitura de profundidade sob o
   * sol aberto. Do lado de dentro não há céu nenhum: a luz do porão é ambiente e
   * fraca, e a mesma sombra só apaga a única coisa que denuncia o rombo ali.
   */
  readonly boardOcclusion: number;
}

/** A face de fora: a bala entrando. Pólvora, fuligem e madeira comprimida. */
const OUTER_FACE: BreachFace = {
  id: 'outer',
  riseScale: 1,
  closedRise: 0.32,
  lipScale: 1,
  sootWeight: 0.6,
  charWeight: 0.7,
  boardColor: COLORS.board,
  voidColor: COLORS.void,
  voidRoughness: 1,
  voidOcclusion: 0.05,
  boardOcclusion: 0.72,
};

/**
 * A face de dentro: a bala saindo. Carvalho cru rasgado e água entrando.
 *
 * Os dois números de altura são contas, e não gosto:
 *
 * **`riseScale`** sobe a lasca de 4,5 para 7,6 cm num rombo típico. Metade a
 * mais que a face de entrada, que é a diferença que se quer — mas não muito
 * mais: o costado tem 13 cm, e lasca perto disso deixa de ler como madeira
 * arrancada e vira um anel de rosquinha colado na parede.
 *
 * **`closedRise`** é o mais frágil dos dois, e o número sai do **pior caso**, não
 * do típico. Com o rombo tapado a marca de dentro vive numa fresta de 4 mm entre
 * o forro e a face da tábua (ver `INNER_DECAL_DEPTH_CLOSED`, em `DamageView`), e
 * a altura da lasca escala com o raio, porque a instância é escalada por inteiro
 * — e um rombo pode ser alargado a `MAX_BREACH_SCALE`, 2,2× a área e 1,48× o
 * raio. No maior rombo possível esta fração dá 2,2 mm, que cabe. Calibrar pelo
 * rombo típico deixaria a madeira atravessando a tábua que acabou de ser
 * pregada, e só no fim de um combate longo — o pior tipo de defeito, porque
 * aparece exatamente quando ninguém está olhando para a parede.
 *
 * Perder a lasca com a tábua pregada não custa a leitura, aliás. Quem denuncia a
 * cicatriz fechada é o **miolo claro**, que é pintura e não geometria, e a tábua
 * tem 22 cm de largura contra quase 1 m de marca: o que sobra escapa **pelos
 * lados** dela, não por cima.
 */
const INNER_FACE: BreachFace = {
  id: 'inner',
  riseScale: 1.5,
  closedRise: 0.02,
  lipScale: 1.25,
  // A pólvora queima do lado de fora. O que chega aqui é o resto de fumaça que
  // passou pelo furo — some quase todo, e é justamente sumir que deixa a
  // madeira clara fazer o trabalho de ser vista.
  sootWeight: 0.12,
  charWeight: 0.15,
  boardColor: COLORS.rawBoard,
  voidColor: COLORS.flood,
  // Molhado, não espelhado. O reflexo é metade do que faz o fundo ler como água
  // entrando em vez de tinta preta — mas abaixo de ~0,4 o furo passa a devolver
  // um ponto especular branco quando o sol entra pela escotilha, e um brilho no
  // meio do buraco desfaz o buraco.
  voidRoughness: 0.5,
  voidOcclusion: 0.18,
  boardOcclusion: 1,
};

/**
 * Monta o disco de anéis com os atributos que o shader lê.
 *
 * A malha nasce **plana** em Z: quem levanta as lascas é o shader de vértice,
 * porque a altura de cada uma depende do ângulo *e* do sorteio da instância, e
 * assar isso na geometria daria a mesma lasca nos vinte e quatro rombos.
 *
 * `aSlope` é a inclinação radial do perfil, calculada aqui por diferença entre
 * anéis vizinhos. Ela existe para a normal acompanhar a lasca: sem isso a
 * madeira erguida recebe a luz como se fosse chapada, e o relevo só apareceria
 * na silhueta.
 */
export function buildBreachGeometry(): THREE.BufferGeometry {
  const rings = RINGS.length;
  const count = rings * SEGMENTS;

  const positions = new Float32Array(count * 3);
  const normals = new Float32Array(count * 3);
  const edges = new Float32Array(count);
  const rises = new Float32Array(count);
  const slopes = new Float32Array(count);

  for (let i = 0; i < rings; i++) {
    const ring = RINGS[i]!;
    const previous = RINGS[i - 1] ?? ring;
    const next = RINGS[i + 1] ?? ring;

    // Inclinação central: sobe do anel de dentro ao de fora. O sinal é o que faz
    // a normal deitar para fora na subida da lasca e voltar na descida.
    const dr = next.r - previous.r;
    const slope = dr > 1e-6 ? ((next.rise - previous.rise) * SPLINTER_RISE) / dr : 0;

    for (let j = 0; j < SEGMENTS; j++) {
      const angle = (j / SEGMENTS) * Math.PI * 2;
      const index = i * SEGMENTS + j;

      positions[index * 3] = Math.cos(angle) * ring.r;
      positions[index * 3 + 1] = Math.sin(angle) * ring.r;
      positions[index * 3 + 2] = 0;

      // Reescrita no shader de vértice a partir de `aSlope`; o valor aqui só
      // precisa ser válido para o Three não reclamar do atributo faltando.
      normals[index * 3 + 2] = 1;

      edges[index] = ring.edge;
      rises[index] = ring.rise;
      slopes[index] = slope;
    }
  }

  const indices: number[] = [];
  for (let i = 0; i < rings - 1; i++) {
    for (let j = 0; j < SEGMENTS; j++) {
      const next = (j + 1) % SEGMENTS;
      const a = i * SEGMENTS + j;
      const b = i * SEGMENTS + next;
      const c = (i + 1) * SEGMENTS + j;
      const d = (i + 1) * SEGMENTS + next;
      indices.push(a, c, b, b, c, d);
    }
  }

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  geometry.setAttribute('normal', new THREE.BufferAttribute(normals, 3));
  geometry.setAttribute('aEdge', new THREE.BufferAttribute(edges, 1));
  geometry.setAttribute('aRise', new THREE.BufferAttribute(rises, 1));
  geometry.setAttribute('aSlope', new THREE.BufferAttribute(slopes, 1));
  geometry.setIndex(indices);
  // O disco vive dentro do raio 1 mais a lasca; a esfera automática erraria
  // porque a malha nasce plana e só cresce no shader.
  geometry.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1.3);
  return geometry;
}

const VERTEX_HEAD = /* glsl */ `
  attribute float aEdge;
  attribute float aRise;
  attribute float aSlope;
  attribute float aSeed;
  attribute float aOpen;

  varying vec2 vBreachLocal;
  varying vec3 vBreachView;
  varying float vBreachSeed;
  varying float vBreachOpen;

  ${WOBBLE_GLSL}
`;

/**
 * Deforma o disco e mede a direção de visão no referencial da marca.
 *
 * A base da instância é ortonormal (só rotação e escala uniforme), então a
 * transposta serve de inversa e a direção da câmera sai de três produtos
 * escalares — sem inverter matriz nenhuma no vértice.
 */
const vertexBody = (face: BreachFace): string => /* glsl */ `
  float breachAngle = atan(position.y, position.x);
  float breachW = breachWobble(breachAngle, aSeed);

  // Um rombo tapado perde o furo mas guarda a cicatriz: a tábua é pregada por
  // cima da madeira quebrada, não no lugar dela. As lascas baixam porque pregar
  // tábua **achata** o que estava em pé — e porque, se não baixassem, elas
  // atravessariam a madeira que acabou de ser pregada.
  transformed.xy *= 1.0 + aEdge * breachW * 0.2;
  float breachRise = mix(${face.closedRise.toFixed(4)}, 1.0, aOpen) * ${face.riseScale.toFixed(4)};
  transformed.z += aRise * ${SPLINTER_RISE.toFixed(4)} * breachRise * (0.55 + 0.45 * breachW);

  // O fragmento recebe a coordenada **antes** do esticamento: assim ele segue
  // raciocinando em círculo, e o achatamento da fibra sai de graça na hora de
  // pousar a malha no costado.
  vBreachLocal = transformed.xy;
  transformed.x *= ${FIBER_STRETCH.toFixed(4)};

  // A inclinação segue a **altura de verdade** da lasca, e não só o perfil
  // assado na geometria: aSlope mede a rampa com as lascas em pé, e uma face que
  // as levanta ao dobro (ou uma cicatriz que as achata a um sétimo) tem rampa na
  // mesma proporção. Sem esta multiplicação a madeira de dentro receberia a luz
  // da madeira de fora, e o relevo só existiria na silhueta.
  float breachSlope = aSlope * breachRise;
  objectNormal = normalize(vec3(
    -breachSlope * cos(breachAngle),
    -breachSlope * sin(breachAngle),
    1.0
  ));
  #ifdef USE_TANGENT
    objectTangent = vec3(1.0, 0.0, 0.0);
  #endif

  #ifdef USE_INSTANCING
    mat4 breachMatrix = modelMatrix * instanceMatrix;
  #else
    mat4 breachMatrix = modelMatrix;
  #endif

  vec3 breachWorld = (breachMatrix * vec4(transformed, 1.0)).xyz;
  vec3 toCamera = cameraPosition - breachWorld;
  vBreachView = vec3(
    dot(toCamera, normalize(breachMatrix[0].xyz)),
    dot(toCamera, normalize(breachMatrix[1].xyz)),
    dot(toCamera, normalize(breachMatrix[2].xyz))
  );

  vBreachSeed = aSeed;
  vBreachOpen = aOpen;
`;

const FRAGMENT_HEAD = /* glsl */ `
  varying vec2 vBreachLocal;
  varying vec3 vBreachView;
  varying float vBreachSeed;
  varying float vBreachOpen;

  ${NOISE_GLSL}
  ${WOBBLE_GLSL}
`;

/**
 * Pinta as três zonas e devolve, além da cor, a oclusão que apaga a luz dentro
 * do furo.
 *
 * A oclusão é separada da cor de propósito. Pintar o fundo de preto não basta:
 * com o sol de través, o `MeshStandardMaterial` acenderia o preto até o cinza e
 * o buraco viraria uma mancha clara. Multiplicar a **luz de saída** é o que faz
 * o interior continuar escuro em qualquer hora do dia — que é o que buraco faz.
 */
const fragmentBody = (face: BreachFace): string => /* glsl */ `
  // A coordenada chega aqui **antes** do esticamento da fibra (ver o vértice),
  // e é por isso que tudo abaixo continua sendo conta de círculo: o achatamento
  // é aplicado na saída da geometria, não no cálculo das zonas.
  float breachR = length(vBreachLocal);
  float breachAngle = atan(vBreachLocal.y, vBreachLocal.x);
  float breachW = breachWobble(breachAngle, vBreachSeed);

  // O furo existe **fechado ou aberto**: a tábua é pregada por dentro, então o
  // que o remendo muda não é a existência do buraco no costado, é o que se vê
  // no fundo dele. Antes o furo simplesmente sumia ao fechar, e um casco que
  // parava de fazer água sem nada acontecer na madeira era a parte menos
  // convincente da coisa toda.
  float holeR = ${HOLE_R.toFixed(4)} * (1.0 + 0.2 * breachW);
  // O miolo claro avança sobre a fuligem na face de saída: é ele que carrega a
  // leitura do rombo, e no escuro do porão ele precisa de mais área. O teto é a
  // borda da malha — um lipScale acima de ~1,35 empurraria a faixa para além do
  // raio 1 e o miolo passaria a ser cortado pelo fim da geometria em vez de
  // morrer no ruído.
  float lipR = ${(LIP_R * face.lipScale).toFixed(4)} * (1.0 + 0.22 * breachW);

  // O fundo desliza com a visão: é daqui que sai a profundidade do furo. Com o
  // rombo tapado o fundo está logo ali, a 13 cm — o deslize encolhe junto.
  vec3 breachView = normalize(vBreachView);
  float slideDepth = ${HOLE_DEPTH.toFixed(4)} * mix(0.22, 1.0, vBreachOpen);
  vec2 slide = breachView.xy / max(breachView.z, 0.35) * slideDepth;
  float bottomR = length(vBreachLocal + slide);

  // Fibra da madeira. O eixo X da marca acompanha o tabuado do costado (ver
  // orientDecal, em DamageView), então a fibra corre em X: frequência baixa
  // nesse eixo e alta no outro é o que faz **linha** em vez de granulado.
  // Uma primeira versão usava 34 ciclos nos dois eixos e o que saiu foi um
  // padrão de coral, que é o oposto de veio de madeira.
  float grain = fbm(vec2(vBreachLocal.x * 1.6, vBreachLocal.y * 9.0) + vBreachSeed * 21.0, 2, 2.2, 0.5);
  // Rachaduras finas, na mesma direção da fibra e mais apertadas.
  float split = fbm(vec2(vBreachLocal.x * 3.0, vBreachLocal.y * 22.0) + vBreachSeed * 5.0, 2, 2.0, 0.5);
  float soot = fbm(vec2(vBreachLocal * 4.5) + vBreachSeed * 13.0, 4, 2.1, 0.5);

  vec3 boardColor = ${linearGlsl(face.boardColor)} * (0.72 + 0.46 * grain);
  // As rachaduras entram como sombra dentro do miolo, não como cor nova.
  boardColor *= 1.0 - 0.45 * smoothstep(0.25, 0.72, split);

  // A queimadura é uma **casca** colada no furo, e não meia marca. Ela chegou a
  // cobrir 55% da faixa de miolo, e o resultado foi um rombo que sumia no
  // costado: num casco alcatroado quase preto, o que denuncia o estrago é a
  // madeira clara: apagá-la é apagar o rombo.
  float charred = 1.0 - smoothstep(holeR, holeR + (lipR - holeR) * 0.22, breachR);
  boardColor = mix(boardColor, ${linearGlsl(COLORS.char)}, charred * ${face.charWeight.toFixed(3)});

  // O fundo do furo: o porão, se ele está aberto; a tábua nova pregada por
  // dentro, se já foi tapado. A parede é o corte na espessura do costado nos
  // dois casos, e só aparece quando se olha de lado.
  vec3 patchWood = ${linearGlsl(COLORS.patch)} * (0.82 + 0.3 * grain);
  vec3 floorColor = mix(patchWood, ${linearGlsl(face.voidColor)}, vBreachOpen);
  vec3 sideColor = mix(patchWood * 0.55, ${linearGlsl(COLORS.wall)}, vBreachOpen);
  vec3 holeColor = mix(floorColor, sideColor, smoothstep(holeR * 0.55, holeR, bottomR));

  // Fendas. Uma bala não faz só um furo: ela **parte** as tábuas, e a fenda
  // corre ao longo da fibra, atravessando a borda do estrago para dentro da
  // madeira sã. É a coisa que mais separa "buraco de bala em madeira" de
  // "buraco de bala em qualquer outra coisa", e ela é reta — não acompanha o
  // contorno do furo.
  float fiber = abs(fract(vBreachLocal.y * 6.0 + vBreachSeed * 4.0) - 0.5);
  float crack = smoothstep(0.11, 0.01, fiber)
    * (1.0 - smoothstep(holeR * 0.7, 1.05, abs(vBreachLocal.x)))
    * (1.0 - smoothstep(holeR * 0.5, holeR * 1.8, abs(vBreachLocal.y)));

  float inHole = 1.0 - smoothstep(holeR - 0.03, holeR, breachR);
  // A borda do miolo é comida pelo ruído: sem isto o lábio fecha um anel
  // perfeito, e anel perfeito é a assinatura de decalque.
  float inBoard = 1.0 - smoothstep(lipR - 0.05, lipR + 0.12, breachR + split * 0.08);

  vec3 breachColor = mix(boardColor, holeColor, inHole);
  // Fuligem: escurece a madeira sã em vez de pintar por cima dela, e escurece
  // **manchado** — uma mancha sólida em volta do furo lê como sujeira de
  // textura, não como pólvora queimada.
  float sootMask = (1.0 - inBoard) * smoothstep(-0.25, 0.55, soot);
  breachColor = mix(breachColor, ${linearGlsl(COLORS.soot)}, sootMask * ${face.sootWeight.toFixed(3)});

  // As fendas são vazio, e vazio não recebe luz: elas escurecem por cima de
  // qualquer zona em que caiam, inclusive por cima da madeira sã.
  breachColor = mix(breachColor, ${linearGlsl(COLORS.wall)}, crack * 0.8 * (1.0 - inHole));

  // A borda externa não é um círculo: some com o ruído, senão o decalque
  // anuncia o próprio raio.
  float fade = 1.0 - smoothstep(0.5, 1.05, breachR + soot * 0.26);
  float breachAlpha = max(max(inBoard, crack), fade * 0.8);

  diffuseColor.rgb = breachColor;
  diffuseColor.a *= breachAlpha;

  // Fundo do furo às escuras, e a fuligem come parte da luz que sobra. Tapado,
  // o fundo é madeira a 13 cm da boca do buraco: fica na sombra do próprio
  // furo, não no breu do porão.
  float breachOcclusion = mix(1.0, mix(0.42, ${face.voidOcclusion.toFixed(3)}, vBreachOpen), inHole);
  breachOcclusion *= mix(1.0, 0.55, sootMask);
  // O miolo fica numa cova rasa e recebe menos céu que a superfície em volta —
  // onde há céu. Ver boardOcclusion.
  breachOcclusion *= mix(1.0, ${face.boardOcclusion.toFixed(3)}, inBoard * (1.0 - inHole));
  breachOcclusion *= mix(1.0, 0.2, crack * (1.0 - inHole));
`;

export interface BreachMaterialOptions {
  /** Rugosidade do miolo exposto. Madeira quebrada não reflete quase nada. */
  roughness?: number;
}

/** Qual das duas faces do costado esta marca desenha. */
export type BreachSide = 'outer' | 'inner';

const FACES: Readonly<Record<BreachSide, BreachFace>> = {
  outer: OUTER_FACE,
  inner: INNER_FACE,
};

/**
 * O material da marca: `MeshStandardMaterial` com a pintura procedural injetada.
 *
 * `polygonOffset` continua aqui pelo mesmo motivo de antes — a marca fica a
 * milímetros do costado e sem o empurrão no z-buffer as duas superfícies
 * brigam. `depthWrite` fica ligado, ao contrário do que se faz com decalque
 * transparente comum: as lascas são geometria de verdade e têm de se ocultar
 * entre si.
 */
export function createBreachMaterial(
  side: BreachSide = 'outer',
  options: BreachMaterialOptions = {},
): THREE.MeshStandardMaterial {
  const face = FACES[side];
  const material = new THREE.MeshStandardMaterial({
    color: 0xffffff,
    roughness: options.roughness ?? 0.94,
    metalness: 0,
    transparent: true,
    // A fuligem morre num degradê e o furo é opaco: sem o corte de alfa o
    // degradê escreveria profundidade e recortaria o que passa atrás dele.
    alphaTest: 0.02,
    side: THREE.DoubleSide,
    polygonOffset: true,
    polygonOffsetFactor: -4,
    polygonOffsetUnits: -4,
  });

  material.onBeforeCompile = (shader) => {
    shader.vertexShader = VERTEX_HEAD + shader.vertexShader;
    shader.vertexShader = shader.vertexShader.replace(
      '#include <begin_vertex>',
      `#include <begin_vertex>\n${vertexBody(face)}`,
    );
    // A normal é reescrita depois de `beginnormal_vertex`, que é onde
    // `objectNormal` nasce — antes dela o símbolo nem existe.
    shader.vertexShader = shader.vertexShader.replace(
      '#include <beginnormal_vertex>',
      `#include <beginnormal_vertex>\n  objectNormal = vec3(0.0, 0.0, 1.0);`,
    );

    shader.fragmentShader = FRAGMENT_HEAD + shader.fragmentShader;
    shader.fragmentShader = shader.fragmentShader.replace(
      '#include <color_fragment>',
      `#include <color_fragment>\n${fragmentBody(face)}`,
    );
    // `roughnessFactor` só nasce no chunk do mapa de rugosidade, que vem
    // **depois** do de cor — mexer nele lá em cima não compilaria. Madeira
    // quebrada é mais áspera que o costado alcatroado: sem esta linha o miolo
    // ganha brilho especular de plástico.
    //
    // O fundo do furo é a exceção, e é por face. Do lado de fora ele é o breu
    // do porão, que não reflete nada; do lado de dentro é madeira encharcada
    // com o mar entrando, e é justamente o reflexo que a faz ler como molhada
    // em vez de pintada de preto.
    shader.fragmentShader = shader.fragmentShader.replace(
      '#include <roughnessmap_fragment>',
      `#include <roughnessmap_fragment>
  roughnessFactor = mix(roughnessFactor, 1.0, charred * 0.6);
  roughnessFactor = mix(roughnessFactor, ${face.voidRoughness.toFixed(3)}, inHole);`,
    );
    // `breachOcclusion` é declarado no bloco acima e continua no escopo aqui:
    // os `#include` do Three são texto colado dentro do mesmo `main`.
    shader.fragmentShader = shader.fragmentShader.replace(
      '#include <opaque_fragment>',
      `outgoingLight *= breachOcclusion;\n#include <opaque_fragment>`,
    );
  };

  // Sem isto o Three reaproveita um programa compilado de outro
  // `MeshStandardMaterial` do navio e a injeção nunca chega à GPU. E o sufixo
  // da face não é enfeite: as duas marcas são o mesmo `MeshStandardMaterial`
  // com a mesma configuração, então uma chave só faria a segunda receber o
  // shader compilado para a primeira — a face de dentro sairia idêntica à de
  // fora, e o bug pareceria "não funcionou" em vez de "cache".
  material.customProgramCacheKey = () => `breach-decal-${face.id}`;
  return material;
}
