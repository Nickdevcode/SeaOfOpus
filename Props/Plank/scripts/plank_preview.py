"""Renders de conferência da tábua.

Três perguntas, três imagens:

  - `turnaround.png` — a silhueta fecha de todos os lados? É onde se vê se a peça
    virou cubo esticado.
  - `detail.png` — a textura sustenta o olho de perto? A tábua é prop de primeira
    pessoa; ela vai ficar a meio metro da câmera.
  - `topology.png` — a malha é limpa? Quads visíveis, sem triângulo escondido.
  - `scale.png` — o tamanho está certo? Contra o pirata de 1,80 m, que é a única
    régua que importa.

As vistas são renderizadas uma a uma e concatenadas em memória, como as folhas
de contato do personagem. As primitivas de câmera, luz e escolha de engine vêm de
`PirateCharacter/scripts/preview.py` — mesma cena, mesmo olho.
"""

import math
import os
import sys

import bpy
import numpy as np
from mathutils import Vector

_HERE = os.path.dirname(os.path.abspath(__file__))
if _HERE not in sys.path:
    sys.path.insert(0, _HERE)

import build_plank  # noqa: E402  (põe os scripts do personagem no sys.path)
import plank_spec as S  # noqa: E402
import preview as PV  # noqa: E402  (o módulo de preview do personagem)

OUT_DIR = os.path.join(os.path.dirname(_HERE), "preview")
PIRATE_GLB = os.path.normpath(os.path.join(
    _HERE, "..", "..", "..", "PirateCharacter", "export", "SK_Pirate_web.glb"))

#: Amostras do Cycles. Cycles e não EEVEE porque em `--background` o EEVEE
#: depende de um contexto GL que nem sempre existe; a peça é minúscula e o
#: caminho de raios resolve em segundos.
SAMPLES = 96


# ---------------------------------------------------------------------------
# Cena
# ---------------------------------------------------------------------------

def setup(world_color=(0.075, 0.079, 0.088)):
    """Cycles + luz de três pontos + fundo escuro, como no personagem."""
    scene = bpy.context.scene
    scene.render.engine = "CYCLES"
    scene.cycles.samples = SAMPLES
    scene.cycles.use_denoising = True
    scene.render.film_transparent = False
    PV.setup_scene_lighting()
    world = scene.world
    if world and world.use_nodes:
        background = world.node_tree.nodes.get("Background")
        if background:
            background.inputs["Color"].default_value = (*world_color, 1.0)
    # As luzes de `setup_scene_lighting` miram a 1,1 m de altura (cintura do
    # pirata). A tábua vive na origem, então elas são reapontadas para cá — sem
    # isso a peça fica no pé do cone de luz e sai chapada.
    for name in ("Key", "Fill", "Rim"):
        light = bpy.data.objects.get(name)
        if light:
            PV._aim(light, tuple(light.location), (0.0, 0.0, 0.0))
    _bounce_light()
    _side_light()
    return scene


def _side_light():
    """Quinta luz, vinda de +X — a que ilumina o **topo** da tábua.

    ⚠️ Sem ela o topo saía marrom-escuro nos renders e a leitura natural era
    "o material do topo ficou escuro demais". Não era: medido no atlas bakeado, o
    topo sai em #BA8F67, mais **claro** que a face. O que estava escuro era a
    cena — o trio de luzes do personagem vem todo de cima, de trás e da esquerda,
    e uma face olhando para +X recebia contribuição de exatamente uma delas.
    Depurar o shader por causa disto teria estragado um material que estava certo.
    """
    obj = bpy.data.objects.get("Side")
    if obj is None:
        data = bpy.data.lights.new("Side", "AREA")
        obj = bpy.data.objects.new("Side", data)
        bpy.context.scene.collection.objects.link(obj)
    obj.data.type = "AREA"
    obj.data.energy = 90.0
    obj.data.size = 2.0
    PV._aim(obj, (4.2, -1.6, 1.0), (0.0, 0.0, 0.0))
    return obj


def _bounce_light():
    """Quarta luz, vinda de baixo. O trio do personagem vem todo de cima, e a
    tábua é vista pelos dois lados: a vista por baixo do turnaround saía preta e
    não provava nada sobre a silhueta, que é justamente o que ela existe para
    mostrar."""
    obj = bpy.data.objects.get("Bounce")
    if obj is None:
        data = bpy.data.lights.new("Bounce", "AREA")
        obj = bpy.data.objects.new("Bounce", data)
        bpy.context.scene.collection.objects.link(obj)
    obj.data.type = "AREA"
    obj.data.energy = 60.0
    obj.data.size = 3.2
    PV._aim(obj, (-1.4, -2.0, -2.4), (0.0, 0.0, 0.0))
    return obj


def _camera(perspective=False, lens=50.0):
    cam = PV._ensure_camera()
    cam.data.type = "PERSP" if perspective else "ORTHO"
    cam.data.lens = lens
    return cam


def _render(cam, spec, res_x, res_y):
    """Renderiza uma vista e devolve os pixels (linha 0 = topo)."""
    PV._aim(cam, spec["loc"], spec.get("target", (0.0, 0.0, 0.0)))
    if cam.data.type == "ORTHO":
        cam.data.ortho_scale = spec["scale"]
    scene = bpy.context.scene
    scene.camera = cam
    scene.render.resolution_x = res_x
    scene.render.resolution_y = res_y
    scene.render.resolution_percentage = 100
    scene.render.image_settings.file_format = "PNG"
    scene.render.image_settings.color_mode = "RGB"
    tmp = os.path.join(OUT_DIR, "_tmp_view.png")
    scene.render.filepath = tmp
    bpy.ops.render.render(write_still=True)
    img = bpy.data.images.load(tmp, check_existing=False)
    pixels = np.array(img.pixels[:], dtype=np.float32).reshape(res_y, res_x, 4)
    bpy.data.images.remove(img)
    os.remove(tmp)
    return pixels[::-1]


def _sheet(tiles, filename, columns=None):
    """Concatena as vistas numa grade e grava o PNG."""
    os.makedirs(OUT_DIR, exist_ok=True)
    columns = columns or len(tiles)
    rows = []
    for i in range(0, len(tiles), columns):
        chunk = tiles[i:i + columns]
        while len(chunk) < columns:  # completa a linha com preto
            chunk.append(np.zeros_like(chunk[0]))
        rows.append(np.concatenate(chunk, axis=1))
    sheet = np.concatenate(rows, axis=0)

    height, width = sheet.shape[0], sheet.shape[1]
    out = bpy.data.images.new("PlankSheet", width=width, height=height, alpha=False)
    out.pixels = sheet[::-1].ravel().tolist()
    path = os.path.join(OUT_DIR, filename)
    out.filepath_raw = path
    out.file_format = "PNG"
    out.save()
    bpy.data.images.remove(out)
    return path


# ---------------------------------------------------------------------------
# As folhas
# ---------------------------------------------------------------------------

#: Vistas ortográficas do turnaround. A escala é a mesma em todas menos as de
#: topo — comparar comprimento entre vistas com zoom diferente não prova nada.
TURNAROUND = [
    {"loc": (0.0, -4.0, 0.0), "scale": 1.35},                 # face larga, de frente
    {"loc": (0.0, -3.0, 2.6), "scale": 1.35},                 # de cima, em ângulo
    {"loc": (0.0, 0.0, 4.0), "target": (0.0, 0.0, 0.0), "scale": 1.35},  # planta
    {"loc": (2.8, -2.8, 1.6), "scale": 1.40},                 # três quartos
    {"loc": (-2.6, -2.6, -1.4), "scale": 1.40},               # três quartos por baixo
    {"loc": (4.0, 0.0, 0.0), "scale": 0.30},                  # topo (a ponta)
]

#: Close-ups. Perspectiva de verdade, e não ortográfica: é assim que o jogador
#: vai ver a peça, e é a perspectiva que denuncia relevo chapado.
#: A distância de câmera é ~0,35 m: é onde a tábua fica quando é carregada em
#: primeira pessoa, e portanto é o teste que vale para a densidade de texel.
DETAIL = [
    # Superfície: enquadra ~45 cm de tábua, o bastante para caber mais de uma
    # faixa de veio e um nó. Mais perto que isso a face vira gradiente sem
    # referência e não se consegue julgar nada.
    {"loc": (-0.10, -0.46, 0.30), "target": (-0.14, 0.0, 0.0)},
    # O topo tem de ser visto quase de frente. Na primeira versão a câmera olhava
    # a ponta de esguelha e a tampa saía como uma lasca de dois pixels.
    {"loc": (0.92, -0.13, 0.09), "target": (0.55, 0.0, 0.0)},     # topo serrado
    # Rasante ao longo da peça: é o ângulo que denuncia empeno, ondulação da
    # aresta e o realce do chanfro — as três coisas que a vista de frente esconde.
    {"loc": (-0.62, -0.17, 0.085), "target": (0.30, 0.01, 0.0)},
]


def turnaround(res=520, filename="turnaround.png"):
    cam = _camera()
    tiles = [_render(cam, spec, res, res) for spec in TURNAROUND]
    return _sheet(tiles, filename, columns=3)


def detail(res=620, filename="detail.png"):
    cam = _camera(perspective=True, lens=55.0)
    tiles = [_render(cam, spec, res, res) for spec in DETAIL]
    return _sheet(tiles, filename)


# ---------------------------------------------------------------------------
# Topologia
# ---------------------------------------------------------------------------

def topology(res=620, filename="topology.png"):
    """Wireframe renderizado, e não overlay de viewport.

    Em `--background` não existe overlay: o que aparece no render é o que tem
    geometria. Então a malha é duplicada, recebe um modificador `Wireframe` com
    material emissivo e é renderizada por cima da original clareada. É a única
    forma honesta de publicar a topologia a partir de um script.
    """
    source = bpy.data.objects[build_plank.MESH_NAME]

    wire = source.copy()
    wire.data = source.data.copy()
    wire.name = "_PlankWire"
    bpy.context.scene.collection.objects.link(wire)
    modifier = wire.modifiers.new("Wire", "WIREFRAME")
    modifier.thickness = 0.0022
    modifier.use_replace = True
    modifier.use_even_offset = True

    ink = bpy.data.materials.new("_WireInk")
    ink.use_nodes = True
    nodes = ink.node_tree.nodes
    for node in list(nodes):
        nodes.remove(node)
    out = nodes.new("ShaderNodeOutputMaterial")
    emission = nodes.new("ShaderNodeEmission")
    emission.inputs["Color"].default_value = (0.02, 0.03, 0.05, 1.0)
    emission.inputs["Strength"].default_value = 1.0
    ink.node_tree.links.new(emission.outputs["Emission"], out.inputs["Surface"])
    wire.data.materials.clear()
    wire.data.materials.append(ink)

    # A malha de baixo entra chapada e clara, para o fio preto ler contra ela.
    flat = bpy.data.materials.new("_WirePaper")
    flat.use_nodes = True
    nodes = flat.node_tree.nodes
    for node in list(nodes):
        nodes.remove(node)
    out = nodes.new("ShaderNodeOutputMaterial")
    emission = nodes.new("ShaderNodeEmission")
    emission.inputs["Color"].default_value = (0.62, 0.60, 0.57, 1.0)
    flat.node_tree.links.new(emission.outputs["Emission"], out.inputs["Surface"])
    original = list(source.data.materials)
    source.data.materials.clear()
    source.data.materials.append(flat)

    cam = _camera()
    # Planta primeiro: é a vista que mostra a grade de quads na face larga, que é
    # onde mora quase toda a malha. A vista de topo (de -Y) só mostraria o fio da
    # peça e não prova nada.
    tiles = [
        _render(cam, {"loc": (0.0, 0.0, 4.0), "scale": 1.32}, res, res),
        _render(cam, {"loc": (2.4, -2.4, 1.6), "scale": 1.36}, res, res),
        _render(cam, {"loc": (2.2, -0.9, 0.5), "target": (0.50, 0.0, 0.0),
                      "scale": 0.34}, res, res),
    ]
    path = _sheet(tiles, filename)

    # Desmonta o andaime: preview não pode deixar rastro na cena que vai exportar.
    bpy.data.objects.remove(wire, do_unlink=True)
    source.data.materials.clear()
    for material in original:
        source.data.materials.append(material)
    for extra in (ink, flat):
        bpy.data.materials.remove(extra)
    return path


# ---------------------------------------------------------------------------
# Escala
# ---------------------------------------------------------------------------

#: Onde o pirata fica em X, para não ocupar o mesmo espaço da tábua.
PIRATE_X = 0.60
#: Altura do peito do personagem (`PirateCharacter/scripts/proportions.Z_CHEST`).
CHEST_Z = 1.375


def _import_pirate():
    """Traz o pirata do GLB e o congela em **pose de repouso**.

    ⚠️ O importador de glTF aplica a primeira animação do arquivo, e o
    `SK_Pirate_web.glb` leva cinco clipes. A primeira tentativa saiu com o pirata
    no meio de um salto: flutuando, membros abertos, sem pé no chão — inútil como
    régua, porque não dá para medir contra um personagem que não está de pé.
    `pose_position = "REST"` devolve a pose de bind, que é determinística e tem a
    sola em Z = 0.

    ⚠️ E o GLB é aberto **somente para leitura**. Ele é o entregável de outro
    asset; nada aqui o regrava. A importação acontece nesta cena, que é desmontada
    no fim da função.
    """
    if not os.path.exists(PIRATE_GLB):
        return []
    before = set(bpy.data.objects)
    bpy.ops.import_scene.gltf(filepath=PIRATE_GLB)
    imported = [o for o in bpy.data.objects if o not in before]
    for obj in imported:
        if obj.type == "ARMATURE":
            obj.data.pose_position = "REST"
        obj.animation_data_clear()
        if obj.parent is None:
            obj.location.x += PIRATE_X
    return imported


def scale_check(res_x=820, res_y=980, filename="scale.png"):
    """A tábua contra o pirata de 1,80 m e contra uma régua de 1 m."""
    imported = _import_pirate()

    plank = bpy.data.objects[build_plank.MESH_NAME]
    # Pose de porte: atravessada na diagonal à frente do peito, como na
    # referência. Não é rig nem encaixe — é só o enquadramento que prova a escala.
    # A rotação é em **Y** e não em Z: quem olha de -Y precisa ver a diagonal no
    # plano da tela; girar em Z apenas encurtaria a peça em perspectiva.
    plank.rotation_euler = (0.0, math.radians(-34.0), 0.0)
    plank.location = (PIRATE_X - 0.06, -0.46, CHEST_Z - 0.14)

    ruler = _ruler()

    cam = _camera()
    tiles = [
        _render(cam, {"loc": (0.0, -6.0, 0.95), "target": (0.35, 0.0, 0.95),
                      "scale": 2.35}, res_x, res_y),
        _render(cam, {"loc": (5.0, -3.4, 1.5), "target": (0.42, 0.0, 0.95),
                      "scale": 2.35}, res_x, res_y),
    ]
    path = _sheet(tiles, filename)

    for obj in imported + [ruler]:
        bpy.data.objects.remove(obj, do_unlink=True)
    plank.rotation_euler = (0.0, 0.0, 0.0)
    plank.location = (0.0, 0.0, 0.0)
    return path


def _ruler(length=1.0, step=0.1):
    """Régua de 1 m em barras de 10 cm, no chão, ao pé do personagem.

    Existe porque "parece do tamanho certo" não é medida: com a régua na imagem
    dá para contar os decímetros da tábua sem abrir o Blender.
    """
    import bmesh
    mesh = bpy.data.meshes.new("_Ruler")
    bm = bmesh.new()
    count = int(round(length / step))
    for i in range(count):
        cube = bmesh.ops.create_cube(bm, size=1.0)["verts"]
        for vert in cube:
            vert.co.x = vert.co.x * step * 0.92 + (i + 0.5) * step - length / 2.0
            vert.co.y = vert.co.y * 0.075
            vert.co.z = vert.co.z * 0.022 + 0.011 + (0.024 if i % 2 else 0.0)
    bm.to_mesh(mesh)
    bm.free()
    obj = bpy.data.objects.new("_Ruler", mesh)
    bpy.context.scene.collection.objects.link(obj)
    obj.location = (PIRATE_X - 0.05, -0.60, 0.0)
    return obj


def run():
    setup()
    return {
        "turnaround": turnaround(),
        "detail": detail(),
        "topology": topology(),
        "scale": scale_check(),
    }
