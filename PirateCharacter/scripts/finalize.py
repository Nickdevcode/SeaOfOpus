"""Consolidação para asset game-ready: join, UV, bake de texturas e material final.

Fluxo:
  1. Junta as peças num único mesh (um atlas, um material, uma malha para o rig).
  2. Smart UV Project com margem proporcional à resolução do atlas.
  3. Bake dos shaders procedurais para PNG (base color, roughness, normal, AO).
  4. Reconstrói um material único que lê essas texturas.

O bake é o que transforma "material procedural bonito no Blender" em textura de
verdade, que qualquer engine consegue usar.
"""

import math
import os

import bpy

#: Derivado do próprio script: o caminho fixo apontava para uma pasta renomeada.
#: Ver a mesma nota em `export.py`.
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
TEX_DIR = os.path.join(ROOT, "textures")
MESH_NAME = "SK_Pirate"
# 2048 dava só 4.3 px/cm neste modelo (muita área de malha, incluindo geometria
# interna das peças que se interpenetram). As transições entre materiais viram
# bordas na textura, então densidade baixa serrilha o vivo claro contra o casaco.
ATLAS = 4096

# (sufixo, tipo de bake, socket do Principled a redirecionar para Emission, espaço)
#
# Base color, metallic e roughness são bakeados via EMIT em vez dos passes
# nativos: o passe DIFFUSE de um material com metallic=1 não tem componente
# difusa e sai PRETO, o que apagava todas as fivelas. Redirecionar o socket
# para um Emission bakeia o valor cru, que é exatamente o que a engine espera.
BAKE_PASSES = [
    ("D", "EMIT", "Base Color", "sRGB"),
    ("M", "EMIT", "Metallic", "Non-Color"),
    ("R", "EMIT", "Roughness", "Non-Color"),
    ("N", "NORMAL", None, "Non-Color"),
    ("AO", "AO", None, "Non-Color"),
]


def _activate(obj):
    for o in bpy.context.selected_objects:
        o.select_set(False)
    obj.select_set(True)
    bpy.context.view_layer.objects.active = obj


def join_pieces():
    """Junta as malhas da coleção Pirate num objeto só, preservando materiais."""
    coll = bpy.data.collections["Pirate"]
    meshes = [o for o in coll.objects if o.type == "MESH"]
    if not meshes:
        raise RuntimeError("nenhuma malha para juntar")
    # O Torso vira o objeto base só porque é o maior; a origem vai para (0,0,0).
    base = next((o for o in meshes if o.name == "Torso"), meshes[0])

    # Cada peça leva um vertex group PART_<nome> antes do join. Depois de juntar
    # tudo num mesh só, é a única forma de voltar a identificar "isto é o chapéu"
    # para forçar peso rígido no rig ou reabrir um ajuste de material.
    for o in meshes:
        group = o.vertex_groups.get(f"PART_{o.name}") or \
            o.vertex_groups.new(name=f"PART_{o.name}")
        group.add(list(range(len(o.data.vertices))), 1.0, "REPLACE")

    for o in bpy.context.selected_objects:
        o.select_set(False)
    for o in meshes:
        o.select_set(True)
    bpy.context.view_layer.objects.active = base
    bpy.ops.object.join()

    obj = bpy.context.view_layer.objects.active
    obj.name = MESH_NAME
    obj.data.name = MESH_NAME
    obj.location = (0.0, 0.0, 0.0)
    _activate(obj)
    bpy.ops.object.transform_apply(location=True, rotation=True, scale=True)
    return obj


def unwrap(obj, margin_px=16):
    """Smart UV Project. A margem em pixels é convertida para fração do atlas."""
    _activate(obj)
    bpy.ops.object.mode_set(mode="EDIT")
    bpy.ops.mesh.select_all(action="SELECT")
    bpy.ops.uv.smart_project(
        angle_limit=math.radians(66.0),
        island_margin=margin_px / ATLAS,
        area_weight=0.0,
        correct_aspect=True,
        scale_to_bounds=False,
    )
    bpy.ops.uv.select_all(action="SELECT")
    bpy.ops.uv.pack_islands(margin=margin_px / ATLAS, rotate=True)
    bpy.ops.object.mode_set(mode="OBJECT")
    return len(obj.data.uv_layers)


def _bake_target_node(mat, image):
    nt = mat.node_tree
    node = nt.nodes.get("BakeTarget")
    if node is None:
        node = nt.nodes.new("ShaderNodeTexImage")
        node.name = "BakeTarget"
        node.location = (-900, 400)
    node.image = image
    node.select = True
    nt.nodes.active = node
    return node


def _drop_bake_nodes(obj):
    for slot in obj.material_slots:
        mat = slot.material
        if not mat or not mat.use_nodes:
            continue
        node = mat.node_tree.nodes.get("BakeTarget")
        if node:
            mat.node_tree.nodes.remove(node)


def _nodes_of(mat):
    nt = mat.node_tree
    bsdf = next((n for n in nt.nodes if n.type == "BSDF_PRINCIPLED"), None)
    out = next((n for n in nt.nodes if n.type == "OUTPUT_MATERIAL"), None)
    return nt, bsdf, out


def _emit_override(mat, input_name):
    """Liga um Emission com o valor do socket pedido direto no Material Output."""
    nt, bsdf, out = _nodes_of(mat)
    if not bsdf or not out:
        return
    emit = nt.nodes.get("BakeEmit")
    if emit is None:
        emit = nt.nodes.new("ShaderNodeEmission")
        emit.name = "BakeEmit"
        emit.location = (220, 320)
    sock = bsdf.inputs[input_name]
    if sock.is_linked:
        nt.links.new(sock.links[0].from_socket, emit.inputs["Color"])
    else:
        value = sock.default_value
        if hasattr(value, "__len__"):
            emit.inputs["Color"].default_value = tuple(value)[:3] + (1.0, )
        else:
            emit.inputs["Color"].default_value = (value, value, value, 1.0)
    nt.links.new(emit.outputs["Emission"], out.inputs["Surface"])


def _emit_restore(mat):
    nt, bsdf, out = _nodes_of(mat)
    emit = nt.nodes.get("BakeEmit")
    if emit:
        nt.nodes.remove(emit)
    if bsdf and out:
        nt.links.new(bsdf.outputs["BSDF"], out.inputs["Surface"])


def bake_textures(obj, resolution=ATLAS, samples=8):
    """Bakeia cada passe para um PNG em textures/ e devolve os caminhos."""
    os.makedirs(TEX_DIR, exist_ok=True)
    scene = bpy.context.scene
    previous_engine = scene.render.engine
    scene.render.engine = "CYCLES"
    scene.cycles.samples = samples
    scene.cycles.use_denoising = False
    scene.render.bake.use_clear = True
    scene.render.bake.margin = 12
    scene.render.bake.use_selected_to_active = False

    written = {}
    for suffix, bake_type, emit_socket, colorspace in BAKE_PASSES:
        name = f"T_Pirate_{suffix}"
        img = bpy.data.images.get(name)
        if img:
            bpy.data.images.remove(img)
        img = bpy.data.images.new(name, width=resolution, height=resolution,
                                  alpha=False, float_buffer=False,
                                  is_data=(colorspace != "sRGB"))
        img.colorspace_settings.name = colorspace

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

        path = os.path.join(TEX_DIR, f"{name}.png")
        img.filepath_raw = path
        img.file_format = "PNG"
        img.save()
        written[suffix] = path

    _drop_bake_nodes(obj)
    scene.render.engine = previous_engine
    return written


def build_final_material(obj, paths):
    """Material único lendo as texturas bakeadas — o que vai no FBX/GLB."""
    mat = bpy.data.materials.get("M_Pirate") or bpy.data.materials.new("M_Pirate")
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

    base = tex("D", (-460, 260), False)
    nt.links.new(base.outputs["Color"], bsdf.inputs["Base Color"])

    rough = tex("R", (-460, -20), True)
    nt.links.new(rough.outputs["Color"], bsdf.inputs["Roughness"])

    metal = tex("M", (-460, -160), True)
    nt.links.new(metal.outputs["Color"], bsdf.inputs["Metallic"])

    nrm = tex("N", (-620, -300), True)
    nmap = nt.nodes.new("ShaderNodeNormalMap")
    nmap.location = (-300, -300)
    nt.links.new(nrm.outputs["Color"], nmap.inputs["Color"])
    nt.links.new(nmap.outputs["Normal"], bsdf.inputs["Normal"])

    obj.data.materials.clear()
    obj.data.materials.append(mat)
    for poly in obj.data.polygons:
        poly.material_index = 0
    obj.data.update()
    return mat


def texel_density(obj, resolution=ATLAS):
    """px/cm médio — usado para conferir que o atlas não está subdimensionado."""
    mesh = obj.data
    uv = mesh.uv_layers.active.data
    total_world = total_uv = 0.0
    for poly in mesh.polygons:
        loops = list(poly.loop_indices)
        pts = [uv[i].uv for i in loops]
        area = 0.0
        for i in range(len(pts)):
            a, b = pts[i], pts[(i + 1) % len(pts)]
            area += a.x * b.y - b.x * a.y
        total_uv += abs(area) * 0.5
        total_world += poly.area
    if total_world <= 0.0:
        return 0.0
    return (resolution * math.sqrt(total_uv)) / (math.sqrt(total_world) * 100.0)


def run():
    obj = join_pieces()
    unwrap(obj)
    density = texel_density(obj)
    paths = bake_textures(obj)
    build_final_material(obj, paths)
    obj.data.calc_loop_triangles()
    return {
        "object": obj.name,
        "tris": len(obj.data.loop_triangles),
        "verts": len(obj.data.vertices),
        "texel_density_px_per_cm": round(density, 2),
        "textures": paths,
    }
