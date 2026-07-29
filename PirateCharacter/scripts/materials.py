"""Materiais PBR estilizados e atribuição por objeto/face.

Cada material é um shader procedural: ruído para quebrar a cor chapada +
"pointiness" da geometria para clarear as arestas convexas. Esse segundo termo
é o que reproduz o desgaste nas quinas da referência (couro puído, vivos claros
do casaco) sem precisar pintar nada à mão.

Evita nós Mix de propósito: combinar os fatores com Math e resolver a cor num
ColorRamp usa sockets cujos nomes não mudam entre versões do Blender.
"""

import bpy

import proportions as P

# Mapa objeto -> material padrão (slot 0).
OBJECT_MATERIAL = {
    "Head": "Skin",
    "Neck": "Skin",
    "Hand": "Skin",
    "Nose": "Skin",
    "Ear": "Skin",
    "Brow": "Hair",
    "Eye": "EyeWhite",
    "Pupil": "EyeDark",
    "Mouth": "EyeDark",
    "Beard": "Hair",
    "Sideburn": "Hair",
    "Moustache": "Hair",
    "Hair": "Hair",
    "Hat": "Hat",
    "Torso": "Shirt",
    "Coat": "Coat",
    "Coat_Collar": "Coat",
    "Coat_Lapel": "Coat",
    "Coat_Flap": "Coat",
    "Coat_Epaulette": "Coat",
    "Sleeve": "Coat",
    "Arm_Band": "Leather",
    "Pants": "Pants",
    "Boot": "Boot",
    "Boot_Strap": "Leather",
    "Sash": "Sash",
    "Sash_Tail": "Sash",
    "Belt": "Leather",
    "Buckle": "Metal",
    "Baldric": "Leather",
    "Pouches": "Leather",
    "Buttons": "Brass",
}

# (nome, cor base, cor de aresta/desgaste, roughness, metallic, escala do ruído,
#  peso do ruído, peso da aresta, altura do bump)
MATERIAL_SPECS = [
    ("Skin",     P.COL["skin"],       (0.630, 0.390, 0.255), 0.62, 0.0, 34.0, 0.16, 0.12, 0.0012),
    ("Hair",     P.COL["beard"],      (0.108, 0.078, 0.056), 0.78, 0.0, 60.0, 0.26, 0.20, 0.0020),
    ("EyeDark",  P.COL["eye_dark"],   (0.045, 0.038, 0.032), 0.40, 0.0, 40.0, 0.12, 0.10, 0.0004),
    ("EyeWhite", P.COL["eye_white"],  (0.700, 0.665, 0.620), 0.36, 0.0, 40.0, 0.10, 0.08, 0.0004),
    ("Hat",      P.COL["hat"],        (0.112, 0.109, 0.106), 0.80, 0.0, 22.0, 0.22, 0.26, 0.0022),
    ("Coat",     P.COL["coat"],       (0.120, 0.116, 0.110), 0.82, 0.0, 20.0, 0.24, 0.26, 0.0024),
    ("Shirt",    P.COL["shirt"],      (0.800, 0.760, 0.650), 0.85, 0.0, 26.0, 0.18, 0.18, 0.0016),
    ("Leather",  P.COL["leather"],    (0.165, 0.115, 0.070), 0.62, 0.0, 28.0, 0.22, 0.26, 0.0022),
    ("Pants",    P.COL["pants"],      (0.168, 0.130, 0.092), 0.86, 0.0, 22.0, 0.26, 0.22, 0.0026),
    ("Boot",     P.COL["boot"],       (0.150, 0.105, 0.066), 0.66, 0.0, 24.0, 0.24, 0.26, 0.0024),
    ("BootCuff", P.COL["boot_cuff"],  (0.245, 0.175, 0.112), 0.66, 0.0, 24.0, 0.22, 0.26, 0.0024),
    ("Sash",     P.COL["sash"],       (0.340, 0.082, 0.052), 0.88, 0.0, 30.0, 0.24, 0.18, 0.0022),
    ("Trim",     P.COL["trim"],       (0.435, 0.372, 0.258), 0.74, 0.0, 30.0, 0.20, 0.22, 0.0016),
    ("Metal",    P.COL["metal"],      (0.790, 0.790, 0.800), 0.30, 1.0, 30.0, 0.14, 0.32, 0.0010),
    ("Brass",    P.COL["brass"],      (0.600, 0.455, 0.190), 0.34, 1.0, 34.0, 0.16, 0.30, 0.0010),
]


def _clear_nodes(mat):
    mat.use_nodes = True
    nt = mat.node_tree
    for node in list(nt.nodes):
        nt.nodes.remove(node)
    return nt


def build_material(name, base, edge, roughness, metallic, noise_scale,
                   noise_weight, edge_weight, bump_height):
    """Monta o shader procedural de um material e devolve o datablock."""
    mat = bpy.data.materials.get(name) or bpy.data.materials.new(name)
    nt = _clear_nodes(mat)

    out = nt.nodes.new("ShaderNodeOutputMaterial")
    out.location = (620, 0)
    bsdf = nt.nodes.new("ShaderNodeBsdfPrincipled")
    bsdf.location = (320, 0)
    nt.links.new(bsdf.outputs["BSDF"], out.inputs["Surface"])

    noise = nt.nodes.new("ShaderNodeTexNoise")
    noise.location = (-620, 120)
    noise.inputs["Scale"].default_value = noise_scale
    noise.inputs["Detail"].default_value = 4.0
    noise.inputs["Roughness"].default_value = 0.62

    geo = nt.nodes.new("ShaderNodeNewGeometry")
    geo.location = (-620, -180)

    # Pointiness fica em torno de 0.5; essa janela estreita isola as quinas.
    edge_map = nt.nodes.new("ShaderNodeMapRange")
    edge_map.location = (-430, -180)
    edge_map.inputs["From Min"].default_value = 0.46
    edge_map.inputs["From Max"].default_value = 0.60
    edge_map.inputs["To Min"].default_value = 0.0
    edge_map.inputs["To Max"].default_value = 1.0
    edge_map.clamp = True
    nt.links.new(geo.outputs["Pointiness"], edge_map.inputs["Value"])

    n_mul = nt.nodes.new("ShaderNodeMath")
    n_mul.location = (-430, 120)
    n_mul.operation = "MULTIPLY"
    n_mul.inputs[1].default_value = noise_weight
    nt.links.new(noise.outputs["Fac"], n_mul.inputs[0])

    e_mul = nt.nodes.new("ShaderNodeMath")
    e_mul.location = (-240, -180)
    e_mul.operation = "MULTIPLY"
    e_mul.inputs[1].default_value = edge_weight
    nt.links.new(edge_map.outputs["Result"], e_mul.inputs[0])

    total = nt.nodes.new("ShaderNodeMath")
    total.location = (-60, 0)
    total.operation = "ADD"
    total.use_clamp = True
    nt.links.new(n_mul.outputs["Value"], total.inputs[0])
    nt.links.new(e_mul.outputs["Value"], total.inputs[1])

    ramp = nt.nodes.new("ShaderNodeValToRGB")
    ramp.location = (110, 60)
    ramp.color_ramp.interpolation = "LINEAR"
    # A janela é estreita e começa cedo para a cor base dominar a superfície:
    # o clareamento fica reservado às quinas, não à peça inteira.
    ramp.color_ramp.elements[0].position = 0.05
    ramp.color_ramp.elements[0].color = (*base, 1.0)
    ramp.color_ramp.elements[1].position = 0.55
    ramp.color_ramp.elements[1].color = (*edge, 1.0)
    nt.links.new(total.outputs["Value"], ramp.inputs["Fac"])
    nt.links.new(ramp.outputs["Color"], bsdf.inputs["Base Color"])

    # Roughness também varia com o ruído — superfície uniforme entrega "CG barato".
    r_ramp = nt.nodes.new("ShaderNodeValToRGB")
    r_ramp.location = (110, -240)
    r_ramp.color_ramp.elements[0].position = 0.0
    r_ramp.color_ramp.elements[0].color = (roughness + 0.10, ) * 3 + (1.0, )
    r_ramp.color_ramp.elements[1].position = 1.0
    r_ramp.color_ramp.elements[1].color = (max(0.05, roughness - 0.14), ) * 3 + (1.0, )
    nt.links.new(noise.outputs["Fac"], r_ramp.inputs["Fac"])
    nt.links.new(r_ramp.outputs["Color"], bsdf.inputs["Roughness"])

    bump = nt.nodes.new("ShaderNodeBump")
    bump.location = (110, -460)
    bump.inputs["Strength"].default_value = 0.45
    bump.inputs["Distance"].default_value = max(bump_height, 1e-5)
    nt.links.new(noise.outputs["Fac"], bump.inputs["Height"])
    nt.links.new(bump.outputs["Normal"], bsdf.inputs["Normal"])

    bsdf.inputs["Metallic"].default_value = metallic

    mat.diffuse_color = (*base, 1.0)
    return mat


def build_all_materials():
    return {spec[0]: build_material(*spec) for spec in MATERIAL_SPECS}


# ---------------------------------------------------------------------------
# Atribuição
# ---------------------------------------------------------------------------

def _assign(obj, mat, predicate=None):
    if mat.name not in [m.name for m in obj.data.materials if m]:
        obj.data.materials.append(mat)
    slot = next(i for i, m in enumerate(obj.data.materials)
                if m and m.name == mat.name)
    for poly in obj.data.polygons:
        if predicate is None or predicate(poly.center, poly.normal):
            poly.material_index = slot
    obj.data.update()


def apply_materials():
    """Aplica o material padrão de cada objeto e depois os detalhes por face."""
    mats = build_all_materials()
    coll = bpy.data.collections["Pirate"]

    for obj in coll.objects:
        if obj.type != "MESH":
            continue
        name = OBJECT_MATERIAL.get(obj.name)
        if name is None:
            continue
        obj.data.materials.clear()
        _assign(obj, mats[name])

    torso = coll.objects.get("Torso")
    if torso:
        # Só o peito no decote é camisa. Abaixo disso o torso vira forro escuro:
        # em poses extremas o casaco levanta e, sem isso, aparecia um triângulo
        # branco brilhante entre as pernas.
        _assign(torso, mats["Coat"], lambda c, n: c.z < 1.262)

    # --- Detalhes por face ---
    boot = coll.objects.get("Boot")
    if boot:
        # A dobra larga do cano é de couro mais claro que o resto da bota.
        _assign(boot, mats["BootCuff"],
                lambda c, n: P.Z_BOOT_CUFF_TOP + 0.02 > c.z > 0.335)

    hat = coll.objects.get("Hat")
    if hat:
        # Borda externa da aba: vivo mais claro, como na referência.
        _assign(hat, mats["Trim"],
                lambda c, n: (c.x * c.x + c.y * c.y) ** 0.5 > P.HAT_BRIM_R * 0.80)
        # Faixa da copa, escura e fosca.
        _assign(hat, mats["Leather"],
                lambda c, n: (c.x * c.x + c.y * c.y) ** 0.5 < 0.125
                and P.Z_HAT_BRIM + 0.002 < c.z < P.Z_HAT_BRIM + 0.034)

    strap = coll.objects.get("Boot_Strap")
    if strap:
        _assign(strap, mats["Metal"],
                lambda c, n: c.y < -(P.R_BOOT_CUFF + 0.012))

    baldric = coll.objects.get("Baldric")
    if baldric:
        # As duas fivelas quadradas frontais viram metal.
        _assign(baldric, mats["Metal"],
                lambda c, n: c.y < -0.175 and (1.285 < c.z < 1.345
                                               or 1.125 < c.z < 1.185))

    pouches = coll.objects.get("Pouches")
    if pouches:
        # Aba superior de cada bolso em couro mais claro.
        _assign(pouches, mats["Leather"])

    lapel = coll.objects.get("Coat_Lapel")
    if lapel:
        _assign(lapel, mats["Trim"], lambda c, n: c.y < -0.130)

    epaulette = coll.objects.get("Coat_Epaulette")
    if epaulette:
        _assign(epaulette, mats["Trim"], lambda c, n: c.z > P.Z_SHOULDER + 0.005)

    # Vivos claros: são eles que dão o contraste gráfico da referência contra o
    # casaco quase preto. Sem isso o torso lê como uma mancha escura só.
    sleeve = coll.objects.get("Sleeve")
    if sleeve:
        # Punho dobrado da manga.
        _assign(sleeve, mats["Trim"], lambda c, n: abs(c.x) > 0.726)
        # Braçadeira no antebraço.
        _assign(sleeve, mats["Leather"], lambda c, n: 0.626 < abs(c.x) < 0.680)

    coat = coll.objects.get("Coat")
    if coat:
        # Barra das abas.
        _assign(coat, mats["Trim"], lambda c, n: c.z < P.Z_COAT_HEM + 0.022)

    collar = coll.objects.get("Coat_Collar")
    if collar:
        _assign(collar, mats["Trim"], lambda c, n: c.z > P.Z_CHIN - 0.012)

    return sorted(mats)
