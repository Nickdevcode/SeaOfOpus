"""Renderiza folhas de contato (várias vistas numa imagem só) para conferir o modelo.

Existe porque comparar com a arte de referência é o único jeito honesto de saber
se a silhueta está batendo. Junta as vistas num PNG único para inspeção rápida.
"""

import math
import os

import bpy
import numpy as np
from mathutils import Vector

#: Derivado do próprio script: o caminho fixo apontava para uma pasta renomeada.
#: Ver a mesma nota em `export.py`.
OUT_DIR = os.path.join(
    os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "preview"
)

# Cada vista: (posição da câmera, alvo, escala ortográfica)
VIEWS = {
    "front":   ((0.0, -6.0, 0.95), (0.0, 0.0, 0.95), 2.05),
    "side":    ((6.0, 0.0, 0.95), (0.0, 0.0, 0.95), 2.05),
    "back":    ((0.0, 6.0, 0.95), (0.0, 0.0, 0.95), 2.05),
    "quarter": ((4.2, -4.2, 2.4), (0.0, 0.0, 0.95), 2.15),
    "head":    ((0.0, -2.2, 1.70), (0.0, 0.0, 1.70), 0.46),
    "head_q":  ((1.5, -1.6, 1.80), (0.0, 0.0, 1.68), 0.50),
    "hat_top": ((0.9, -1.2, 2.65), (0.0, 0.0, 1.78), 0.60),
    "boots":   ((0.0, -2.5, 0.35), (0.0, 0.0, 0.35), 0.90),
    "hands":   ((0.75, -1.4, 1.41), (0.75, 0.0, 1.41), 0.42),
}


def _aim(cam_obj, location, target):
    """Posiciona a câmera e a aponta para o alvo (sem depender de constraints)."""
    loc = Vector(location)
    cam_obj.location = loc
    direction = Vector(target) - loc
    cam_obj.rotation_euler = direction.to_track_quat("-Z", "Y").to_euler()


def _ensure_camera():
    cam = bpy.data.objects.get("PreviewCam")
    if cam is None:
        cam_data = bpy.data.cameras.new("PreviewCam")
        cam = bpy.data.objects.new("PreviewCam", cam_data)
        bpy.context.scene.collection.objects.link(cam)
    cam.data.type = "ORTHO"
    return cam


def _setup_engine(engine):
    scene = bpy.context.scene
    if engine == "WORKBENCH":
        scene.render.engine = "BLENDER_WORKBENCH"
        shading = scene.display.shading
        shading.light = "STUDIO"
        shading.studio_light = "Default"
        shading.color_type = "MATERIAL"
        shading.show_cavity = True
        shading.cavity_type = "BOTH"
        shading.curvature_ridge_factor = 1.0
        shading.curvature_valley_factor = 1.0
        scene.display.render_aa = "8"
    else:
        # Nome do EEVEE mudou entre versões; pega o que existir.
        available = {
            item.identifier
            for item in bpy.types.RenderSettings.bl_rna.properties["engine"].enum_items
        }
        for candidate in ("BLENDER_EEVEE_NEXT", "BLENDER_EEVEE"):
            if candidate in available:
                scene.render.engine = candidate
                break
        scene.render.film_transparent = False


def _render_view(cam, name, res, engine):
    location, target, ortho = VIEWS[name]
    _aim(cam, location, target)
    cam.data.ortho_scale = ortho
    scene = bpy.context.scene
    scene.camera = cam
    scene.render.resolution_x = res
    scene.render.resolution_y = res
    scene.render.resolution_percentage = 100
    scene.render.image_settings.file_format = "PNG"
    scene.render.image_settings.color_mode = "RGB"
    tmp = os.path.join(OUT_DIR, f"_tmp_{name}.png")
    scene.render.filepath = tmp
    bpy.ops.render.render(write_still=True)
    img = bpy.data.images.load(tmp, check_existing=False)
    pixels = np.array(img.pixels[:], dtype=np.float32).reshape(res, res, 4)
    bpy.data.images.remove(img)
    os.remove(tmp)
    return pixels[::-1]  # Blender guarda a imagem de baixo para cima


def contact_sheet(views=("front", "quarter", "side"), res=560, engine="WORKBENCH",
                  filename="preview.png"):
    """Renderiza as vistas pedidas lado a lado e devolve o caminho do PNG."""
    os.makedirs(OUT_DIR, exist_ok=True)
    _setup_engine(engine)
    cam = _ensure_camera()

    tiles = [_render_view(cam, v, res, engine) for v in views]
    sheet = np.concatenate(tiles, axis=1)

    h, w = sheet.shape[0], sheet.shape[1]
    out = bpy.data.images.new("ContactSheet", width=w, height=h, alpha=False)
    out.pixels = sheet[::-1].ravel().tolist()
    path = os.path.join(OUT_DIR, filename)
    out.filepath_raw = path
    out.file_format = "PNG"
    out.save()
    bpy.data.images.remove(out)
    return path


def setup_scene_lighting():
    """Luz de três pontos + fundo escuro, aproximando a apresentação da referência."""
    world = bpy.context.scene.world
    if world is None:
        world = bpy.data.worlds.new("World")
        bpy.context.scene.world = world
    world.use_nodes = True
    bg = world.node_tree.nodes.get("Background")
    if bg:
        bg.inputs["Color"].default_value = (0.055, 0.055, 0.058, 1.0)
        bg.inputs["Strength"].default_value = 1.0

    # AgX (padrão do Blender 4+) lava e dessatura a arte estilizada; a referência
    # é de cor chapada e contrastada, então o transform Standard é o correto aqui.
    view = bpy.context.scene.view_settings
    try:
        view.view_transform = "Standard"
        view.look = "None"
        view.exposure = 0.0
        view.gamma = 1.0
    except TypeError:
        pass

    specs = [
        ("Key", "AREA", (2.6, -3.4, 3.2), 185.0, 2.6),
        ("Fill", "AREA", (-3.2, -2.2, 1.5), 55.0, 3.0),
        ("Rim", "AREA", (0.0, 4.0, 2.6), 125.0, 2.4),
    ]
    for name, kind, loc, power, size in specs:
        obj = bpy.data.objects.get(name)
        if obj is None:
            data = bpy.data.lights.new(name, kind)
            obj = bpy.data.objects.new(name, data)
            bpy.context.scene.collection.objects.link(obj)
        obj.data.type = kind
        obj.data.energy = power
        obj.data.size = size
        _aim(obj, loc, (0.0, 0.0, 1.1))
