"""Shaders procedurais da tábua e atribuição por face.

Dois materiais: a **face serrada** (o corpo da peça) e o **topo** (as duas
tampas das pontas). Separá-los não é preciosismo — madeira cortada de través é
outro material: bebe mais luz, é mais fosca e mostra os anéis em arco em vez de
faixas compridas.

O que decide a aparência, na ordem em que importa:

  1. **Contenção.** A regra de arte do Sea of Thieves é explícita: o asset carrega
     "só detalhe suficiente para dar a impressão do que ele é". O render oficial
     da tábua tem *duas a quatro* faixas largas na face inteira, e quase nenhum
     detalhe fino. Um veio de carvalho fotográfico aqui seria tecnicamente
     melhor e estilisticamente errado.
  2. **Espaço de objeto, não UV.** Todo o desenho é amostrado nas coordenadas de
     objeto. Isso faz o veio correr no comprimento da peça independentemente de
     como as ilhas de UV caíram, e é o que permite empacotar o UV pelo que é bom
     para o atlas em vez de pelo que é bom para a textura.
  3. **Pointiness nas quinas.** O mesmo termo que dá o couro puído do personagem
     (`PirateCharacter/scripts/materials.py`) aqui dá a quina lixada do chanfro.
  4. **Face estreita mais escura que a larga.** Ver `EDGE_FACE_DARKEN` no
     `plank_spec` — é anatomia da peça, não luz pintada.

Como em `materials.py`, os fatores são combinados com `Math` e resolvidos num
`ColorRamp`: são nós cujos sockets não mudam de nome entre versões do Blender.
"""

import bpy

import plank_spec as S

WOOD_MATERIAL = "Plank_Wood"
END_MATERIAL = "Plank_EndGrain"

# --- Pesos da mistura -------------------------------------------------------
#
# `BASE_LEVEL` é onde a face limpa cai no ColorRamp. Os outros termos empurram
# para os dois lados a partir dali. Os números foram escolhidos para que uma face
# larga sem nó varie entre ~0,52 e ~0,68 — dentro da rampa, mas longe das pontas,
# de forma que o veio apareça como gradiente mole e não como listra chapada.
BASE_LEVEL = 0.77
GRAIN_WEIGHT = 0.22
FINE_GRAIN_WEIGHT = 0.055
KNOT_WEIGHT = 0.42
EDGE_WEIGHT = 0.24

#: Escala do campo de nós. Quanto **maior**, mais células cabem na peça e mais
#: nós aparecem — a contagem cresce com o quadrado. Em 7,0 saíram sete nós por
#: face e a tábua virou pinho de terceira; em 5,0, com o corte abaixo, ficam dois
#: ou três, que é o que o render oficial mostra.
KNOT_SCALE = 5.0

#: Raio do nó, **no espaço já escalado do Voronoi**.
#:
#: ⚠️ Aqui morava um bug silencioso: o valor entrava como `KNOT_RADIUS / SCALE`,
#: por analogia errada com metros. A saída `Distance` do Voronoi do Blender já vem
#: no espaço multiplicado pela escala — o raio de uma célula vale ~0,5 ali dentro,
#: não 0,5/7. Com o divisor a janela ficava em 0,017 e **nenhum pixel passava**:
#: a tábua saiu sem um nó sequer e nada no log reclamou.
#: 0,13 no espaço do Voronoi = 0,13/5 = 2,6 cm de raio, um nó de ~5 cm de
#: diâmetro na largura. No comprimento ele sai mais oval, porque a coordenada é
#: comprimida em X antes do Voronoi — e é assim mesmo que um nó aparece numa
#: tábua serrada em plano: alongado no sentido da fibra.
KNOT_RADIUS = 0.13

#: Só as células cujo valor aleatório passa deste corte viram nó. É isso que faz
#: o Voronoi produzir nós **esparsos** em vez de um por célula.
KNOT_THRESHOLD = 0.70

#: O quanto o nó entorta o veio em volta. Madeira real abre em catedral ao
#: contornar um nó; sem isso o nó vira adesivo colado por cima das faixas.
KNOT_SWIRL = 7.0


def _sock(collection, *names):
    """Devolve o primeiro socket que existir com um destes nomes.

    O Blender renomeou vários sockets ao longo das versões (`Fac` virou `Factor`
    em vários nós). Procurar por uma lista em vez de um nome fixo evita que o
    pipeline quebre num upgrade — o mesmo cuidado que `preview.py` já toma com o
    nome do EEVEE.
    """
    for name in names:
        if name in collection:
            return collection[name]
    raise KeyError(f"nenhum socket entre {names} — existem: {[s.name for s in collection]}")


def _clear(mat):
    mat.use_nodes = True
    nt = mat.node_tree
    for node in list(nt.nodes):
        nt.nodes.remove(node)
    return nt


def _math(nt, operation, location, value=None, clamp=False):
    node = nt.nodes.new("ShaderNodeMath")
    node.operation = operation
    node.location = location
    node.use_clamp = clamp
    if value is not None:
        node.inputs[1].default_value = value
    return node


def _ramp(nt, location, stops):
    """ColorRamp com N paradas. O nó nasce com duas; as demais são inseridas."""
    node = nt.nodes.new("ShaderNodeValToRGB")
    node.location = location
    ramp = node.color_ramp
    ramp.interpolation = "LINEAR"
    while len(ramp.elements) > 1:
        ramp.elements.remove(ramp.elements[-1])
    first = stops[0]
    ramp.elements[0].position = first[0]
    ramp.elements[0].color = (*first[1], 1.0)
    for position, color in stops[1:]:
        element = ramp.elements.new(position)
        element.color = (*color, 1.0)
    return node


def _object_coords(nt, scale, location=(0.0, 0.0, 0.0), at=(-1500, 0)):
    """Coordenada de objeto passada por um Mapping — a base de todo o desenho."""
    coord = nt.nodes.new("ShaderNodeTexCoord")
    coord.location = at
    mapping = nt.nodes.new("ShaderNodeMapping")
    mapping.location = (at[0] + 190, at[1])
    mapping.inputs["Scale"].default_value = scale
    mapping.inputs["Location"].default_value = location
    nt.links.new(coord.outputs["Object"], mapping.inputs["Vector"])
    return mapping


def _edge_factor(nt, at=(-1500, -560)):
    """Realce de quina pelo *pointiness* da geometria.

    A janela 0,46–0,60 é a mesma de `materials.py`: pointiness vive em torno de
    0,5 e essa fatia estreita isola só as arestas convexas.
    """
    geo = nt.nodes.new("ShaderNodeNewGeometry")
    geo.location = at
    node = nt.nodes.new("ShaderNodeMapRange")
    node.location = (at[0] + 190, at[1])
    node.inputs["From Min"].default_value = 0.46
    node.inputs["From Max"].default_value = 0.60
    node.inputs["To Min"].default_value = 0.0
    node.inputs["To Max"].default_value = 1.0
    node.clamp = True
    nt.links.new(geo.outputs["Pointiness"], node.inputs["Value"])
    return geo, node


def _knot_field(nt, at=(-1500, -220)):
    """Nós esparsos: um disco escuro só nas células sorteadas do Voronoi.

    Voronoi puro dá **um nó por célula**, o que cobre a tábua de bolinhas. A
    saída `Color` é um valor aleatório constante dentro de cada célula; usá-la
    como chave liga o disco em ~38% delas e devolve os dois ou três nós que uma
    tábua de verdade tem.

    ⚠️ **E o Voronoi tem de ser 2D.** Com o campo em 3D, os pontos-semente se
    espalham também na espessura, e a tábua é uma fatia de 4,5 cm num espaço de
    células de 14 cm: quase nenhuma semente caía perto o bastante da face para
    virar disco visível. O número esperado de nós na peça inteira dava meio.
    Em 2D o nó vira um **cilindro que atravessa a prancha** — que é literalmente
    o que um nó é: o galho cortado de lado a lado — e ele aparece nas duas faces,
    no mesmo lugar, de graça.
    """
    mapping = _object_coords(nt, (0.55, 1.0, 1.0), at=at)
    voronoi = nt.nodes.new("ShaderNodeTexVoronoi")
    voronoi.location = (at[0] + 380, at[1])
    voronoi.voronoi_dimensions = "2D"
    voronoi.feature = "F1"
    voronoi.inputs["Scale"].default_value = KNOT_SCALE
    voronoi.inputs["Randomness"].default_value = 0.85
    nt.links.new(mapping.outputs["Vector"], voronoi.inputs["Vector"])

    disc = nt.nodes.new("ShaderNodeMapRange")
    disc.location = (at[0] + 570, at[1] + 100)
    disc.inputs["From Min"].default_value = 0.0
    disc.inputs["From Max"].default_value = KNOT_RADIUS
    disc.inputs["To Min"].default_value = 1.0
    disc.inputs["To Max"].default_value = 0.0
    disc.clamp = True
    nt.links.new(voronoi.outputs["Distance"], disc.inputs["Value"])

    split = nt.nodes.new("ShaderNodeSeparateColor")
    split.location = (at[0] + 570, at[1] - 160)
    nt.links.new(voronoi.outputs["Color"], split.inputs["Color"])

    pick = nt.nodes.new("ShaderNodeMapRange")
    pick.location = (at[0] + 760, at[1] - 160)
    pick.inputs["From Min"].default_value = KNOT_THRESHOLD
    pick.inputs["From Max"].default_value = KNOT_THRESHOLD + 0.10
    pick.inputs["To Min"].default_value = 0.0
    pick.inputs["To Max"].default_value = 1.0
    pick.clamp = True
    nt.links.new(split.outputs["Red"], pick.inputs["Value"])

    gate = _math(nt, "MULTIPLY", (at[0] + 950, at[1]))
    nt.links.new(disc.outputs["Result"], gate.inputs[0])
    nt.links.new(pick.outputs["Result"], gate.inputs[1])
    return gate


def _narrow_face_factor(nt, at=(-1500, -900)):
    """1 nas faces estreitas (normal ≈ ±Y), 0 nas faces largas.

    Corte radial contra corte tangencial. A janela começa em 0,55 para os
    chanfros (normal a 45°, |Ny| ≈ 0,71) escurecerem só pela metade — eles ainda
    precisam ler como quina iluminada.
    """
    geo = nt.nodes.new("ShaderNodeNewGeometry")
    geo.location = at
    split = nt.nodes.new("ShaderNodeSeparateXYZ")
    split.location = (at[0] + 190, at[1])
    nt.links.new(geo.outputs["Normal"], split.inputs["Vector"])
    absolute = _math(nt, "ABSOLUTE", (at[0] + 380, at[1]))
    nt.links.new(split.outputs["Y"], absolute.inputs[0])
    window = nt.nodes.new("ShaderNodeMapRange")
    window.location = (at[0] + 570, at[1])
    window.inputs["From Min"].default_value = 0.55
    window.inputs["From Max"].default_value = 0.92
    window.inputs["To Min"].default_value = 0.0
    window.inputs["To Max"].default_value = 1.0
    window.clamp = True
    nt.links.new(absolute.outputs["Value"], window.inputs["Value"])
    return window


def _finish(nt, fac, height, roughness_base, bump_distance):
    """Fecha o material: rugosidade correlacionada, bump e Principled."""
    out = nt.nodes.new("ShaderNodeOutputMaterial")
    out.location = (900, 0)
    bsdf = nt.nodes.new("ShaderNodeBsdfPrincipled")
    bsdf.location = (620, 0)
    nt.links.new(bsdf.outputs["BSDF"], out.inputs["Surface"])

    # Rugosidade puxada pelo **mesmo** fator da cor, e não por um ruído próprio:
    # onde a peça clareou foi porque a mão e a corda lixaram, e superfície lixada
    # é mais lisa. Correlacionar os dois canais é o que impede o "CG barato" em
    # que a cor conta uma história e o brilho conta outra.
    r_ramp = _ramp(nt, (380, -260), [
        (0.0, (roughness_base + 0.10, ) * 3),
        (1.0, (max(0.05, roughness_base - 0.14), ) * 3),
    ])
    nt.links.new(fac, _sock(r_ramp.inputs, "Factor", "Fac"))
    nt.links.new(r_ramp.outputs["Color"], bsdf.inputs["Roughness"])

    # O relevo vem do veio e dos nós, não de ruído fino. Detalhe abaixo do pixel
    # em mapa de normais vira cintilação especular — a armadilha já está anotada
    # em `ProceduralTextures.ts`. Aqui a faixa do veio tem ~6 cm de largura, então
    # é relevo de verdade e sobrevive ao mipmap.
    #
    # ⚠️ **E mesmo assim tem de ser fraco.** A primeira versão usava 0,9 mm com
    # força 0,5 e a tábua saiu **corrugada**, com brilho em faixas: cada anel
    # virou uma calha. Madeira intemperizada tem décimos de milímetro de alívio
    # entre lenho de primavera e de verão — 0,25 mm com força 0,3 é o que se vê
    # de perto e some de longe, que é exatamente o combinado.
    bump = nt.nodes.new("ShaderNodeBump")
    bump.location = (380, -520)
    bump.inputs["Strength"].default_value = 0.30
    bump.inputs["Distance"].default_value = bump_distance
    nt.links.new(height, bump.inputs["Height"])
    nt.links.new(bump.outputs["Normal"], bsdf.inputs["Normal"])

    # Madeira é dielétrica pura. O valor fica explícito aqui porque é justamente
    # por ser constante que o mapa `_M` não é gerado (ver `plank_finalize`).
    bsdf.inputs["Metallic"].default_value = 0.0
    return bsdf


def build_wood_material():
    """Face serrada: veio comprido, nós esparsos, quina lixada."""
    mat = bpy.data.materials.get(WOOD_MATERIAL) or bpy.data.materials.new(WOOD_MATERIAL)
    nt = _clear(mat)

    knot = _knot_field(nt)

    # Veio. O Wave em BANDS/Y varia só na largura, então as linhas correm no
    # comprimento; a distorção é que as empena. Como a coordenada é comprimida em
    # X, essa distorção varia devagar ao longo da peça — e é exatamente isso que
    # produz faixa comprida em vez de mancha de mármore.
    mapping = _object_coords(nt, (S.GRAIN_STRETCH, 1.0, 1.0), at=(-1500, 320))
    swirl = _math(nt, "MULTIPLY_ADD", (-1300, 520), None)
    swirl.inputs[0].default_value = 0.0
    swirl.inputs[1].default_value = KNOT_SWIRL
    swirl.inputs[2].default_value = S.GRAIN_DISTORTION
    nt.links.new(knot.outputs["Value"], swirl.inputs[0])

    wave = nt.nodes.new("ShaderNodeTexWave")
    wave.location = (-1120, 320)
    wave.wave_type = "BANDS"
    wave.bands_direction = "Y"
    wave.wave_profile = "SIN"
    wave.inputs["Scale"].default_value = S.GRAIN_SCALE
    wave.inputs["Detail"].default_value = 2.0
    wave.inputs["Detail Scale"].default_value = 2.0
    wave.inputs["Detail Roughness"].default_value = 0.55
    nt.links.new(mapping.outputs["Vector"], wave.inputs["Vector"])
    # A distorção é ligada, e não constante: a faixa se abre em catedral ao passar
    # pelo nó, que é como madeira de verdade contorna o galho.
    nt.links.new(swirl.outputs["Value"], wave.inputs["Distortion"])
    grain = _sock(wave.outputs, "Factor", "Fac")

    # Segunda frequência do veio: linhas de 2 cm, com um oitavo do peso da faixa
    # larga. É o "só detalhe suficiente" da regra da Rare — de perto dá o que
    # olhar, de longe some no mip. Em qualquer peso maior que isto a tábua volta
    # a virar veludo cotelê, que foi como ela saiu na primeira versão.
    fine = nt.nodes.new("ShaderNodeTexWave")
    fine.location = (-1120, 60)
    fine.wave_type = "BANDS"
    fine.bands_direction = "Y"
    fine.wave_profile = "SIN"
    fine.inputs["Scale"].default_value = S.GRAIN_SCALE * 3.2
    fine.inputs["Detail"].default_value = 2.0
    fine.inputs["Detail Scale"].default_value = 1.6
    nt.links.new(mapping.outputs["Vector"], fine.inputs["Vector"])
    nt.links.new(swirl.outputs["Value"], fine.inputs["Distortion"])

    # Manchas largas. Sem elas a face fica com valor uniforme de ponta a ponta e
    # lê como plástico pintado, por mais correto que o veio esteja.
    mottle_map = _object_coords(nt, (0.45, 1.0, 1.0), at=(-1500, -100))
    mottle = nt.nodes.new("ShaderNodeTexNoise")
    mottle.location = (-1120, -100)
    mottle.inputs["Scale"].default_value = S.MOTTLE_SCALE
    mottle.inputs["Detail"].default_value = 2.0
    mottle.inputs["Roughness"].default_value = 0.5
    nt.links.new(mottle_map.outputs["Vector"], mottle.inputs["Vector"])

    _, edge = _edge_factor(nt)
    narrow = _narrow_face_factor(nt)

    # fac = BASE_LEVEL − veio − manchas − nó + quina − face estreita
    g_mul = _math(nt, "MULTIPLY", (-700, 320), GRAIN_WEIGHT)
    nt.links.new(grain, g_mul.inputs[0])
    m_mul = _math(nt, "MULTIPLY", (-700, 180), S.MOTTLE_WEIGHT)
    nt.links.new(_sock(mottle.outputs, "Factor", "Fac"), m_mul.inputs[0])
    k_mul = _math(nt, "MULTIPLY", (-700, 60), KNOT_WEIGHT)
    nt.links.new(knot.outputs["Value"], k_mul.inputs[0])
    e_mul = _math(nt, "MULTIPLY", (-700, -200), EDGE_WEIGHT)
    nt.links.new(edge.outputs["Result"], e_mul.inputs[0])
    n_mul = _math(nt, "MULTIPLY", (-700, -460), S.EDGE_FACE_DARKEN)
    nt.links.new(narrow.outputs["Result"], n_mul.inputs[0])

    f_mul = _math(nt, "MULTIPLY", (-700, 250), FINE_GRAIN_WEIGHT)
    nt.links.new(_sock(fine.outputs, "Factor", "Fac"), f_mul.inputs[0])

    veins = _math(nt, "ADD", (-500, 380))
    nt.links.new(g_mul.outputs["Value"], veins.inputs[0])
    nt.links.new(f_mul.outputs["Value"], veins.inputs[1])
    soft = _math(nt, "ADD", (-500, 300))
    nt.links.new(veins.outputs["Value"], soft.inputs[0])
    nt.links.new(m_mul.outputs["Value"], soft.inputs[1])
    dark = _math(nt, "ADD", (-500, 180))
    nt.links.new(soft.outputs["Value"], dark.inputs[0])
    nt.links.new(k_mul.outputs["Value"], dark.inputs[1])
    dark_all = _math(nt, "ADD", (-320, 60))
    nt.links.new(dark.outputs["Value"], dark_all.inputs[0])
    nt.links.new(n_mul.outputs["Value"], dark_all.inputs[1])

    lit = _math(nt, "SUBTRACT", (-140, 120))
    lit.inputs[0].default_value = BASE_LEVEL
    nt.links.new(dark_all.outputs["Value"], lit.inputs[1])
    fac = _math(nt, "ADD", (40, 120), clamp=True)
    nt.links.new(lit.outputs["Value"], fac.inputs[0])
    nt.links.new(e_mul.outputs["Value"], fac.inputs[1])

    # A rampa é a paleta inteira num nó só. As posições são o que decide quanta
    # tábua fica em cada cor: a faixa 0,30–0,72 é larga porque é ali que a face
    # limpa vive, e é lá que o veio precisa de espaço para virar gradiente.
    color = _ramp(nt, (240, 300), [
        (0.00, S.COL["knot"]),
        (0.30, S.COL["grain"]),
        (0.72, S.COL["base"]),
        (1.00, S.COL["wear"]),
    ])
    nt.links.new(fac.outputs["Value"], _sock(color.inputs, "Factor", "Fac"))

    # Altura: veio + nó. O nó afunda mais que a faixa mole do veio.
    h_grain = _math(nt, "MULTIPLY", (240, -640), 0.45)
    nt.links.new(grain, h_grain.inputs[0])
    height = _math(nt, "ADD", (420, -740), clamp=True)
    nt.links.new(h_grain.outputs["Value"], height.inputs[0])
    nt.links.new(knot.outputs["Value"], height.inputs[1])

    bsdf = _finish(nt, fac.outputs["Value"], height.outputs["Value"],
                   S.ROUGHNESS_FACE, 0.00025)
    nt.links.new(color.outputs["Color"], bsdf.inputs["Base Color"])

    mat.diffuse_color = (*S.COL["base"], 1.0)
    return mat


def build_end_material():
    """Topo serrado: anéis em arco, mais escuro e mais fosco que a face.

    O centro dos anéis é deslocado para **fora** da peça de propósito: tábua
    serrada em plano não sai do centro da tora, então o topo mostra arcos, e não
    círculos concêntricos. É o detalhe que faz o topo ler como madeira cortada em
    vez de tampa de caixa com textura de alvo.
    """
    mat = bpy.data.materials.get(END_MATERIAL) or bpy.data.materials.new(END_MATERIAL)
    nt = _clear(mat)

    mapping = _object_coords(nt, (1.0, 1.0, 1.0), location=(0.0, 0.20, 0.05),
                             at=(-1500, 320))
    wave = nt.nodes.new("ShaderNodeTexWave")
    wave.location = (-1120, 320)
    wave.wave_type = "RINGS"
    # Anéis em torno do eixo X = círculos no plano do topo. Com SPHERICAL a
    # distância seria dominada pelo próprio X (0,575 m contra 0,11 m de raio) e o
    # topo inteiro cairia dentro de meio anel — chapado.
    wave.rings_direction = "X"
    wave.wave_profile = "SIN"
    # Pela mesma conta do veio da face: período = 2π/(20·Escala). O raio varre
    # 23 cm sobre a tampa, então 9,0 dá ~6 anéis. Em 26 saíam dezoito e o topo
    # virava papelão ondulado; em 5,5 sobrava um arco só, que lia como mancha.
    wave.inputs["Scale"].default_value = 9.0
    wave.inputs["Distortion"].default_value = 1.6
    wave.inputs["Detail"].default_value = 2.0
    wave.inputs["Detail Scale"].default_value = 1.2
    nt.links.new(mapping.outputs["Vector"], wave.inputs["Vector"])
    rings = _sock(wave.outputs, "Factor", "Fac")

    _, edge = _edge_factor(nt)

    r_mul = _math(nt, "MULTIPLY", (-700, 320), 0.30)
    nt.links.new(rings, r_mul.inputs[0])
    e_mul = _math(nt, "MULTIPLY", (-700, -200), 0.34)
    nt.links.new(edge.outputs["Result"], e_mul.inputs[0])

    # 0,80 e não 0,66: no valor antigo o anel escuro dominava e a tampa inteira
    # caía perto da cor de anel, virando um retângulo marrom-escuro colado na
    # ponta. Agora a média cai logo acima de `end_base` e os anéis desenham
    # *sobre* a cor do topo, em vez de virarem a cor do topo.
    lit = _math(nt, "SUBTRACT", (-320, 120))
    lit.inputs[0].default_value = 0.74
    nt.links.new(r_mul.outputs["Value"], lit.inputs[1])
    fac = _math(nt, "ADD", (-140, 120), clamp=True)
    nt.links.new(lit.outputs["Value"], fac.inputs[0])
    nt.links.new(e_mul.outputs["Value"], fac.inputs[1])

    color = _ramp(nt, (240, 300), [
        (0.00, S.COL["end_ring"]),
        (0.58, S.COL["end_base"]),
        (1.00, S.COL["end_wear"]),
    ])
    nt.links.new(fac.outputs["Value"], _sock(color.inputs, "Factor", "Fac"))

    # Topo tem relevo maior que a face: a fibra cortada de través arranca e os
    # anéis moles cavam. 0,6 mm contra 0,25 mm da face — mesma proporção de
    # antes, na escala nova (ver a nota sobre corrugação em `_finish`).
    bsdf = _finish(nt, fac.outputs["Value"], rings, S.ROUGHNESS_END, 0.0006)
    nt.links.new(color.outputs["Color"], bsdf.inputs["Base Color"])

    mat.diffuse_color = (*S.COL["end_base"], 1.0)
    return mat


def apply_materials(obj=None, half_length=None):
    """Aplica os dois materiais: corpo no slot 0, topo nas tampas das pontas.

    O corte é por normal **e** por posição. Só por normal, uma face do miolo que
    o `facet` girasse demais entraria como topo; só por posição, o bisel da ponta
    (que é chanfro, não topo) entraria junto.
    """
    obj = obj or bpy.data.objects["SM_Plank"]
    half_length = half_length or S.HALF_LENGTH
    wood = build_wood_material()
    end = build_end_material()

    obj.data.materials.clear()
    obj.data.materials.append(wood)
    obj.data.materials.append(end)

    caps = 0
    for poly in obj.data.polygons:
        is_cap = abs(poly.normal.x) > 0.80 and abs(poly.center.x) > half_length * 0.85
        poly.material_index = 1 if is_cap else 0
        caps += int(is_cap)
    obj.data.update()
    return {"materials": [wood.name, end.name], "cap_faces": caps,
            "body_faces": len(obj.data.polygons) - caps}
