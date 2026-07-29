"""Medidas e cores da tábua de reparo, com a procedência de cada número.

Nada aqui é chute. Cada valor sai de uma destas três fontes, e o comentário ao
lado diz de qual:

  1. **O próprio jogo** — `src/ship/HullGeometry.ts` e `src/ship/ShipMaterials.ts`
     já definem a largura do tabuado do convés e a paleta de madeira da Chalupa.
     A tábua tem de ler como uma peça tirada do paiol *deste* navio.
  2. **O personagem** — `PirateCharacter/scripts/proportions.py`. A tábua é
     segurada atravessada com as duas mãos; a envergadura e a largura de ombro
     dele são a régua de "cabe nas mãos".
  3. **Marcenaria naval real e o próprio Sea of Thieves** — manual de *damage
     control* da US Navy (a *shole*, a prancha de forro do escoramento, tem no
     mínimo 1" de espessura e 8"–12" de largura), a definição de "plank" (acima
     de 1½" de espessura, DIN 68252 exige 40 mm) e o render de inventário da
     tábua no wiki oficial, que lê entre 5:1 e 6:1 de comprimento por largura,
     com espessura entre ⅕ e ¼ da largura.

⚠️ O módulo se chama `plank_spec` e não `proportions` de propósito: os scripts do
personagem entram no `sys.path` junto com estes, e dois `proportions.py` no
caminho fariam o `import` pegar o errado sem avisar.
"""

import math

# ---------------------------------------------------------------------------
# Conversão de cor
# ---------------------------------------------------------------------------

def srgb_to_linear(value):
    """sRGB 0..1 -> linear. O Principled BSDF só entende linear.

    As cores são declaradas em hexadecimal porque é assim que se lê uma paleta;
    entregá-las já convertidas esconderia de onde vieram.
    """
    if value <= 0.04045:
        return value / 12.92
    return ((value + 0.055) / 1.055) ** 2.4


def hex_to_linear(code):
    code = code.lstrip("#")
    return tuple(srgb_to_linear(int(code[i:i + 2], 16) / 255.0) for i in (0, 2, 4))


# ---------------------------------------------------------------------------
# Dimensões (metros — 1 unidade Blender = 1 m, convenção do projeto)
# ---------------------------------------------------------------------------

#: **1,15 m.** É a distância entre as mãos mais a sobra que faz a peça ler como
#: tábua e não como bastão. O personagem tem 0,50 m de ombro a ombro
#: (`R_SHOULDER_X = 0.250`), e na referência as duas luvas estão claramente mais
#: afastadas que isso: ~0,58 m de pegada. Sobrando 0,28 m de cada lado, a tábua
#: atravessa o corpo inteiro na diagonal e ainda aparece nos dois cantos da tela
#: em primeira pessoa — que é exatamente o enquadramento da referência.
#: Confere também com a régua do navio: o tabuado do convés corre 4,5 m entre
#: juntas (`DECK_PLANK_TILE`), então 1,15 m é um quarto de tábua de estoque.
#: E fecha com a razão medida no render de inventário do jogo: 1,15 / 0,22 =
#: **5,2 : 1**, dentro da faixa 5:1–6:1 que a arte original mostra.
#: Peso implícito: 0,0114 m³ × 700 kg/m³ (carvalho) = **8 kg**. Carga de duas
#: mãos; uma tábua de estoque inteira (2,44 m) daria 17 kg e ninguém carrega
#: atravessado no peito — daí o corte curto.
LENGTH = 1.15

#: **0,22 m.** Não é um número escolhido no olho: é *exatamente* a largura do
#: tabuado do convés da Chalupa. `HullGeometry.ts` mapeia `DECK_BAND_TILE = 1.76`
#: metros de convés sobre uma textura de `planks: 8` (`ShipMaterials.ts`), ou
#: seja 1,76 / 8 = 0,22 m por tábua. O jogador pisa nessa largura o jogo inteiro;
#: uma tábua de reparo com a mesma medida lê na hora como peça do próprio navio.
#: (O costado é mais largo, 2,8 / 10 = 0,28 m — ver `HULL_GIRTH_TILE`.)
WIDTH = 0.22

#: **0,045 m.** Tabuado de costado de sloop real fica em 1½"–2" (38–50 mm); 45 mm
#: cai no meio, e bate com a razão do render do jogo (espessura entre ⅕ e ¼ da
#: largura → 44–55 mm para 220 mm). Também tem de ser bem menor que os 0,13 m de
#: `HULL_THICKNESS` (que é o costado inteiro, não uma tábua), senão a peça lê como
#: viga. Abaixo de uns 35 mm o low-poly começa a parecer papelão — a espessura é
#: metade da silhueta de um objeto chapado.
THICKNESS = 0.045

HALF_LENGTH = LENGTH / 2.0
HALF_WIDTH = WIDTH / 2.0
HALF_THICKNESS = THICKNESS / 2.0

# ---------------------------------------------------------------------------
# Acabamento da silhueta — é isto que separa "tábua" de "cubo esticado"
# ---------------------------------------------------------------------------

#: Chanfro das quatro arestas longas. 4 mm em 45 mm de espessura é o que uma
#: plaina de mão tira num passe. Não é enfeite: é a faixa que o *pointiness* do
#: shader clareia, e é ela que desenha o contorno da peça contra o fundo.
CHAMFER = 0.004

#: Recuo do anel de topo. Deixa a tampa da ponta um pouco menor que o corpo, o
#: que produz um bisel em volta do topo — canto de tábua velha nunca é vivo.
#: Em 4,5 mm o bisel ficava largo demais e o topo escuro dentro dele lia como
#: moldura de quadro; 3 mm mantém o canto quebrado sem virar desenho.
END_BEVEL = 0.003

#: Empeno no comprimento (*bow*). 6 mm em 1,15 m = 0,5% — tábua serrada de
#: verdade sempre tem algum, e é o que impede a peça de parecer extrudada.
BOW = 0.006

#: Barriga na largura (*cup*). 2,5 mm em 0,22 m. Move as duas faces largas para o
#: mesmo lado, que é como madeira encana de verdade (a espessura se mantém).
CUP = 0.0025

#: Torção total da ponta A para a ponta B.
TWIST = math.radians(1.8)

#: **A aresta longa ondula.** É a observação mais forte do render oficial: nenhuma
#: linha da tábua do Sea of Thieves é reta — a peça é lavrada, não aplainada. ±4 mm
#: sobre 110 mm de meia-largura é 3,6%: a silhueta serpenteia de leve e a peça
#: para de parecer extrudada, sem virar madeira derretida. É a regra que a Rare
#: chama de *"realistically wonky"*.
WIDTH_WOBBLE = 0.004
#: Mesma ideia na espessura, mais contida (a face estreita aparece menos).
THICK_WOBBLE = 0.0018
#: Afinamento geral de uma ponta para a outra — 3% de conicidade. Toda tábua
#: serrada à mão tem.
TAPER = 0.03

#: **O corte das pontas é enviesado, não esquadrado.** O render oficial mostra
#: topo cortado em ângulo, com o topo da fibra bem visível — corte limpo, porém
#: torto. Não é lascado: serrote errado, não machado.
#: Ângulos diferentes nas duas pontas, senão a peça vira paralelogramo simétrico.
END_SKEW_YAW = (math.radians(6.5), math.radians(-4.0))    # em torno de Z (na largura)
END_SKEW_PITCH = (math.radians(-3.0), math.radians(5.0))  # em torno de Y (na espessura)
#: Torto de verdade: um pouco de ruído por cima do plano de corte, ±1,5 mm.
END_CROOKED = 0.0015

#: Ruído de superfície (`piratelib.facet`). Mesma função que dá o aspecto
#: facetado do personagem. 1,2 mm é subliminar de longe e vira quebra de luz de
#: perto — a tábua é um prop de **primeira pessoa**, fica a meio metro do olho.
FACET_AMOUNT = 0.0012
FACET_SCALE = 11.0
FACET_SEED = 3.7

#: Estações ao longo do comprimento (t de 0 a 1). Concentradas nas pontas, onde
#: moram o bisel e a irregularidade; espaçadas no miolo, que é quase reto.
STATIONS = [0.0, 0.010, 0.055, 0.13, 0.22, 0.32, 0.42, 0.50,
            0.58, 0.68, 0.78, 0.87, 0.945, 0.990, 1.0]

#: Pontos por seção transversal (ver `build_plank.section`). 5 na face de baixo,
#: 5 na de cima, 3 em cada canto/topo lateral.
SECTION_POINTS = 16

# ---------------------------------------------------------------------------
# Paleta
# ---------------------------------------------------------------------------
#
# Método: a referência do Sea of Thieves é um screenshot **submerso**, com filtro
# ciano por cima de tudo. Amostrando a tábua ali sai #96462 7 no ponto mais claro
# — deep orange já comido pela água. Isso é uma condição de luz, não um albedo;
# copiar o número literal daria uma tábua marrom-avermelhada em pleno sol.
#
# O que a referência prova, e foi o que se usou:
#   - a tábua é **muito mais quente e mais clara** que tudo em volta (matiz ~17°
#     mesmo depois do filtro ciano — o convés e os barris ficam esverdeados);
#   - a superfície é quase chapada, com variação **de baixa frequência**. Nada de
#     veio de carvalho fotográfico: é pintura à mão estilizada.
#
# O valor absoluto vem da paleta que já existe no jogo (`ShipMaterials.ts`):
# o convés é #8F704F (`base: [0.56, 0.44, 0.31]`, matiz 31°). A tábua é madeira
# **recém-serrada**, então sobe em valor e em saturação e desce em matiz, ficando
# entre o convés lixado pelo sal e o laranja da referência.
#
# ⚠️ A primeira paleta era **laranja demais** (base #C4794A, S = 0,62). Renderizada,
# a tábua saiu cor de salmão e leu como plástico, não como madeira. O erro foi
# tomar o matiz da referência submersa por valor de albedo: a água come o verde e
# o azul, então tudo lá dentro *parece* mais saturado do que é. O render de
# inventário do jogo, esse sem filtro, mostra um **tan/ocre de saturação
# média-baixa**. Foi para lá que a paleta voltou.
COL = {
    # Corpo da tábua. #BE8355 — matiz 25°, S 0,55, V 0,75. Continua bem mais claro
    # e mais quente que o convés (#8F704F, matiz 31°, V 0,56): é madeira nova
    # contra madeira lixada pelo sal.
    "base":       hex_to_linear("#BE8355"),
    # Faixa escura do veio. Um degrau de valor, não um contraste: no Sea of
    # Thieves o veio é sugerido, nunca desenhado fio a fio.
    "grain":      hex_to_linear("#96603A"),
    # Nó. É o único ponto de valor baixo da peça — um ou dois na tábua inteira.
    "knot":       hex_to_linear("#5E3A22"),
    # Quina gasta. Mesma lógica do `brighten` de `ProceduralTextures.ts`: a aresta
    # que a corda e o pé lixam primeiro volta mais clara **e** dessaturada.
    "wear":       hex_to_linear("#DCB98F"),
    # Topo serrado. Fibra cortada de través bebe mais luz: mais escura que a face.
    "end_base":   hex_to_linear("#A5714B"),
    "end_ring":   hex_to_linear("#6F4A2E"),
    "end_wear":   hex_to_linear("#C9A379"),
}

#: Carvalho intemperizado real fica entre 0,75 e 0,95 de rugosidade — o número já
#: está documentado em `ProceduralTextures.ts`, e vale igual aqui. Fica na parte
#: alta da faixa: a primeira versão, em 0,82 e com bump forte, devolvia um brilho
#: em faixas que fazia a peça parecer envernizada.
ROUGHNESS_FACE = 0.86
#: O topo é fibra aberta: absorve, não devolve. Mais fosco que a face.
ROUGHNESS_END = 0.90

# ---------------------------------------------------------------------------
# Textura
# ---------------------------------------------------------------------------

#: **1024², e não 4096².** Medido, não estimado: a tábua tem **0,5986 m²** de
#: superfície e o empacotamento fecha em **44,5%** do atlas, o que dá
#: **8,8 px/cm** — praticamente o mesmo que o personagem inteiro tem com um atlas
#: 4K (8,69 px/cm), por 1/16 da memória.
#:
#: Os 44,5% não são desleixo do empacotador: a face larga é 5,2:1 e cinco
#: configurações de `smart_project` + `pack_islands` (CONCAVE/CONVEX/AABB,
#: margens de 3 a 6 px, limites de ângulo de 45° a 89°) ficaram todas entre 39,9%
#: e 44,7%. É o teto da forma dentro de um atlas quadrado.
#:
#: Por que 8,8 px/cm basta **aqui**, apesar de a tábua ser prop de primeira
#: pessoa (faixa de referência: 1024–2048 px/m): o que a textura carrega é
#: gradiente largo. A faixa de veio tem ~5 cm (44 texels) e o realce de chanfro,
#: que é a menor feição do mapa, tem 4 mm (3,5 texels). Não existe detalhe fino
#: para perder — a contenção de estilo do Sea of Thieves é justamente essa.
#: Se em primeira pessoa a quina ler mole, **é este número que muda**: 2048
#: dobra tudo e o pipeline reconstrói sem mais nada.
ATLAS = 1024

#: Margem entre ilhas, em pixels do atlas. Entre 3 e 6 px o uso do atlas não
#: mudou (44,5% nos dois), então fica no maior — margem sobrando é o que impede
#: a costura preta aparecer nos níveis de mipmap mais baixos.
UV_MARGIN_PX = 6

#: Escala do nó Wave que desenha o veio.
#:
#: ⚠️ **Este número quer ser alto e não pode — e a conta não é a que parece.**
#: O Wave do Blender monta a onda como `sin(coord · Scale · 20)`, então o período
#: em metros é `2π / (20 · Scale)`. Em 18 (a primeira tentativa) isso dá 17,5 mm:
#: **doze faixas** atravessando os 22 cm da tábua. Renderizado, virou veludo
#: cotelê — listra regular demais para ser madeira e fina demais para o atlas
#: sustentar. Em 5,0 o período sobe para 63 mm e sobram **~3,5 faixas** na
#: largura, que é o que o render oficial do jogo mostra: duas a quatro faixas
#: largas e moles na face inteira, e nada de detalhe fino.
GRAIN_SCALE = 5.0

#: Quanto o veio empena. Em radianos de fase: 4,0 rad = ±0,64 de faixa, o
#: bastante para as linhas serpentearem sem se cruzarem (anéis que se cruzam
#: viram redemoinho de mármore — a armadilha está anotada em `createWoodMaps`).
GRAIN_DISTORTION = 4.0

#: O quanto o veio é esticado no comprimento. O ruído que empena as linhas é
#: amostrado num espaço comprimido em X, então ele varia devagar ao longo da peça
#: e as linhas correm no sentido do comprimento. É esse único número que separa
#: "madeira serrada" de "mármore marrom". Em 0,20, o ruído dá cerca de duas
#: ondulações ao longo de 1,15 m: faixa comprida, com vida, sem virar zebra.
GRAIN_STRETCH = 0.20

#: Manchas de baixa frequência por cima do veio. É o que a referência chama de
#: "large soft value gradients" e é o que impede a face de ler como plástico
#: pintado: madeira nunca tem valor uniforme de ponta a ponta.
MOTTLE_SCALE = 3.2
MOTTLE_WEIGHT = 0.11

#: Quanto a face **estreita** escurece em relação à face larga.
#:
#: O render do jogo tem separação de valor forte entre os planos. A tentação é
#: pintar isso como luz (topo mais claro), mas a tábua gira na mão — luz pintada
#: no albedo viraria mentira no primeiro giro. O que **não** gira é a anatomia da
#: peça: a face larga é corte tangencial e a estreita é corte radial, fibra de
#: pé, que reflete menos. Escurecer por normal em espaço de objeto é um fato do
#: material, não iluminação, e sobrevive a qualquer rotação.
EDGE_FACE_DARKEN = 0.22
