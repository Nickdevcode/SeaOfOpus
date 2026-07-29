"""UV, bake do atlas e material final da tábua.

Mesmo fluxo do personagem (`PirateCharacter/scripts/finalize.py`): desdobra,
bakeia os shaders procedurais para PNG e reconstrói um material único que lê
essas texturas. As funções delicadas — o desvio por Emission, o nó de destino do
bake, a medida de densidade de texel — são **importadas** de lá em vez de
copiadas: a armadilha do bake existe uma vez só no projeto, e é lá.

⚠️ **Base color se bakeia por EMIT, não por DIFFUSE.** A anotação é do README do
personagem e continua valendo. Aqui não há metal, então o sintoma seria outro (o
passe DIFFUSE traria a cor *depois* da conta de luz em vez do valor cru), mas o
remédio é o mesmo e o código é o mesmo.

**O que este pipeline deliberadamente NÃO gera:**

  - `_M` (metallic). Madeira é dielétrica: o mapa seria 1024² de preto puro.
    O valor entra como escalar 0 no material final.
  - `_AO` — *se* a medição provar que ele não carrega informação. A tábua é uma
    peça convexa; oclusão de contato só existiria nas reentrâncias que ela não
    tem. O bake roda mesmo assim e o número decide (ver `AO_KEEP_THRESHOLD`),
    porque "acho que é convexo" não é medição.
"""

import math
import os
import sys

import bpy
import numpy as np

_HERE = os.path.dirname(os.path.abspath(__file__))
if _HERE not in sys.path:
    sys.path.insert(0, _HERE)

import build_plank  # noqa: E402  (põe os scripts do personagem no sys.path)
import plank_spec as S  # noqa: E402

# Reuso direto do motor de bake do personagem. São privados por convenção de
# módulo, não por serem frágeis — e duplicá-los criaria duas versões da mesma
# armadilha documentada. Quando o terceiro prop chegar, isto vira um `bakelib`.
from finalize import (  # noqa: E402
    _bake_target_node,
    _drop_bake_nodes,
    _emit_override,
    _emit_restore,
    texel_density,
)

ROOT = os.path.dirname(_HERE)
TEX_DIR = os.path.join(ROOT, "textures")
MESH_NAME = build_plank.MESH_NAME
FINAL_MATERIAL = "M_Plank"

# (sufixo, tipo de bake, socket a desviar para Emission, espaço de cor)
BAKE_PASSES = [
    ("D", "EMIT", "Base Color", "sRGB"),
    ("R", "EMIT", "Roughness", "Non-Color"),
    ("N", "NORMAL", None, "Non-Color"),
]

#: Oclusão **média** abaixo da qual o mapa `_AO` vale a pena existir.
#:
#: ⚠️ O teste natural seria pelo mínimo, e ele mente: o mínimo medido foi 0,039,
#: o que sugeriria oclusão profundíssima numa peça que não tem uma única
#: reentrância. São os pixels da **borda da ilha de UV**, onde o raio de oclusão
#: sai da superfície. A média (0,995) e o percentil 1 (0,79) contam a história
#: verdadeira: o mapa é branco com uma franja. Por isso o corte é pela média.
AO_KEEP_THRESHOLD = 0.97


def _activate(obj):
    for other in bpy.context.selected_objects:
        other.select_set(False)
    obj.select_set(True)
    bpy.context.view_layer.objects.active = obj


def unwrap(obj, margin_px=S.UV_MARGIN_PX):
    """Smart UV Project + empacotamento.

    Não há projeção manual porque não faz falta: o desenho todo é amostrado em
    **coordenadas de objeto**, então o veio sai certo qualquer que seja a
    orientação da ilha. Isso libera o empacotador para otimizar área — que é o
    que decide a densidade de texel — em vez de preservar um alinhamento que
    ninguém vai usar.
    """
    _activate(obj)
    bpy.ops.object.mode_set(mode="EDIT")
    bpy.ops.mesh.select_all(action="SELECT")
    bpy.ops.uv.smart_project(
        angle_limit=math.radians(66.0),
        island_margin=margin_px / S.ATLAS,
        area_weight=0.0,
        correct_aspect=True,
        scale_to_bounds=False,
    )
    bpy.ops.uv.select_all(action="SELECT")
    bpy.ops.uv.pack_islands(margin=margin_px / S.ATLAS, rotate=True)
    bpy.ops.object.mode_set(mode="OBJECT")
    return len(obj.data.uv_layers)


def _new_image(name, resolution, colorspace):
    img = bpy.data.images.get(name)
    if img:
        bpy.data.images.remove(img)
    img = bpy.data.images.new(name, width=resolution, height=resolution,
                              alpha=False, float_buffer=False,
                              is_data=(colorspace != "sRGB"))
    img.colorspace_settings.name = colorspace
    return img


def _bake_into(obj, img, bake_type, emit_socket):
    for slot in obj.material_slots:
        if not slot.material:
            continue
        _bake_target_node(slot.material, img)
        if emit_socket:
            _emit_override(slot.material, emit_socket)

    _activate(obj)
    bpy.ops.object.bake(type=bake_type, use_clear=True)

    if emit_socket:
        for slot in obj.material_slots:
            if slot.material:
                _emit_restore(slot.material)
                _bake_target_node(slot.material, img)


def _save(img, name):
    os.makedirs(TEX_DIR, exist_ok=True)
    path = os.path.join(TEX_DIR, f"{name}.png")
    img.filepath_raw = path
    img.file_format = "PNG"
    img.save()
    return path


def bake_textures(obj, resolution=S.ATLAS, samples=24):
    """Bakeia os passes para `textures/` e devolve os caminhos escritos."""
    scene = bpy.context.scene
    previous = scene.render.engine
    scene.render.engine = "CYCLES"
    scene.cycles.samples = samples
    scene.cycles.use_denoising = False
    scene.render.bake.use_clear = True
    # Dilatação em pixels. Escala com o atlas: 12 px num 4K é o mesmo que 3 px
    # num 1K, e é a margem que impede a costura preta na borda da ilha depois do
    # mipmap. 6 px dá folga de dois níveis de mip.
    scene.render.bake.margin = 6
    scene.render.bake.use_selected_to_active = False

    written = {}
    for suffix, bake_type, emit_socket, colorspace in BAKE_PASSES:
        name = f"T_Plank_{suffix}"
        img = _new_image(name, resolution, colorspace)
        _bake_into(obj, img, bake_type, emit_socket)
        written[suffix] = _save(img, name)

    ao = _probe_ao(obj, resolution)
    if ao["mean"] < AO_KEEP_THRESHOLD:
        written["AO"] = _save(bpy.data.images["T_Plank_AO"], "T_Plank_AO")
    else:
        bpy.data.images.remove(bpy.data.images["T_Plank_AO"])
        # Apaga o arquivo de uma rodada anterior que tenha decidido diferente.
        # Sem isso, mudar o critério deixa um `_AO` órfão no disco: ele não
        # entraria no material nem no GLB, e ainda assim pareceria entregável.
        stale = os.path.join(TEX_DIR, "T_Plank_AO.png")
        if os.path.exists(stale):
            os.remove(stale)

    _drop_bake_nodes(obj)
    scene.render.engine = previous
    return written, ao


def _probe_ao(obj, resolution):
    """Bakeia oclusão só para **medir** se ela carrega alguma informação."""
    img = _new_image("T_Plank_AO", resolution, "Non-Color")
    _bake_into(obj, img, "AO", None)
    pixels = np.array(img.pixels[:], dtype=np.float32).reshape(-1, 4)[:, 0]
    # Fora das ilhas o bake deixa preto; medir isso mediria o fundo, não a peça.
    inside = pixels[pixels > 0.0]
    if inside.size == 0:
        return {"min": 1.0, "mean": 1.0, "p01": 1.0}
    return {
        "min": float(inside.min()),
        "mean": float(inside.mean()),
        "p01": float(np.percentile(inside, 1.0)),
    }


def build_final_material(obj, paths):
    """Material único lendo o atlas bakeado — é este que sai no GLB/FBX."""
    mat = bpy.data.materials.get(FINAL_MATERIAL) or bpy.data.materials.new(FINAL_MATERIAL)
    mat.use_nodes = True
    nt = mat.node_tree
    for node in list(nt.nodes):
        nt.nodes.remove(node)

    out = nt.nodes.new("ShaderNodeOutputMaterial")
    out.location = (520, 0)
    bsdf = nt.nodes.new("ShaderNodeBsdfPrincipled")
    bsdf.location = (220, 0)
    nt.links.new(bsdf.outputs["BSDF"], out.inputs["Surface"])

    def tex(suffix, location, non_color):
        node = nt.nodes.new("ShaderNodeTexImage")
        node.location = location
        node.image = bpy.data.images.load(paths[suffix], check_existing=True)
        if non_color:
            node.image.colorspace_settings.name = "Non-Color"
        return node

    nt.links.new(tex("D", (-460, 260), False).outputs["Color"], bsdf.inputs["Base Color"])
    nt.links.new(tex("R", (-460, -20), True).outputs["Color"], bsdf.inputs["Roughness"])

    normal = tex("N", (-620, -300), True)
    nmap = nt.nodes.new("ShaderNodeNormalMap")
    nmap.location = (-300, -300)
    nt.links.new(normal.outputs["Color"], nmap.inputs["Color"])
    nt.links.new(nmap.outputs["Normal"], bsdf.inputs["Normal"])

    # Escalar, e não mapa: ver a nota no cabeçalho.
    bsdf.inputs["Metallic"].default_value = 0.0

    obj.data.materials.clear()
    obj.data.materials.append(mat)
    for poly in obj.data.polygons:
        poly.material_index = 0
    obj.data.update()
    return mat


def run(obj=None):
    obj = obj or bpy.data.objects[MESH_NAME]
    unwrap(obj)
    density = texel_density(obj, S.ATLAS)
    paths, ao = bake_textures(obj)
    build_final_material(obj, paths)
    obj.data.calc_loop_triangles()
    return {
        "object": obj.name,
        "atlas": S.ATLAS,
        "texel_density_px_per_cm": round(density, 2),
        "ao_probe": {k: round(v, 4) for k, v in ao.items()},
        "ao_written": "AO" in paths,
        "textures": paths,
    }
