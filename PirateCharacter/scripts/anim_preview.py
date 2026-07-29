"""Renderiza um ciclo de animação em várias vistas, para conferência.

Ciclo de caminhada não se julga em número nem em pose parada — se julga vendo
rodar, de lado (onde aparece o passo) e de frente (onde aparece o gingado e o
cruzamento das pernas). Este módulo só cospe os PNGs; quem monta o GIF é o
`ffmpeg` do lado de fora, porque o Blender da Steam vem sem FFMPEG compilado.

Roda por OpenGL na viewport, não pelo Cycles: são segundos em vez de minutos, e
para avaliar movimento o sombreado de material já basta.
"""

from __future__ import annotations

import os

import bpy

#: Vistas geradas: nome -> (eixo base, giro lateral, giro vertical) em radianos.
VIEWS = {
    "side": ('LEFT', 0.0, 0.0),
    "quarter": ('LEFT', 0.70, 0.22),
    "front": ('FRONT', 0.0, 0.0),
}

#: Fração da distância que o `view_selected` escolhe. Ele deixa margem demais
#: para um personagem sozinho no quadro.
ZOOM = 0.62


def _viewport():
    win = bpy.context.window_manager.windows[0]
    area = next(a for a in win.screen.areas if a.type == 'VIEW_3D')
    region = next(r for r in area.regions if r.type == 'WINDOW')
    return win, area, region


def render_cycle(out_dir: str, frames: int = 24, width: int = 460,
                 height: int = 620, subject: str = "SK_Pirate") -> dict:
    """Renderiza ``frames`` quadros em cada vista dentro de *out_dir*."""
    scene = bpy.context.scene
    # O ciclo vive de 0 a frames-1; o frame `frames` repete o 0 e sairia como
    # quadro duplicado no GIF.
    scene.frame_start, scene.frame_end = 0, frames - 1

    win, area, region = _viewport()
    space = area.spaces.active

    obj = bpy.data.objects[subject]
    bpy.ops.object.select_all(action='DESELECT')
    obj.select_set(True)
    bpy.context.view_layer.objects.active = obj

    scene.render.resolution_x, scene.render.resolution_y = width, height
    scene.render.resolution_percentage = 100
    scene.render.image_settings.file_format = 'PNG'
    scene.render.image_settings.color_mode = 'RGB'

    previous_shading = space.shading.type
    previous_overlays = space.overlay.show_overlays
    space.shading.type = 'MATERIAL'
    space.overlay.show_overlays = False     # sem grade e sem bones no quadro

    with bpy.context.temp_override(window=win, area=area, region=region):
        for name, (axis, orbit_x, orbit_y) in VIEWS.items():
            bpy.ops.view3d.view_axis(type=axis)
            if orbit_x:
                bpy.ops.view3d.view_orbit(angle=orbit_x, type='ORBITLEFT')
            if orbit_y:
                bpy.ops.view3d.view_orbit(angle=orbit_y, type='ORBITUP')
            bpy.ops.view3d.view_selected()
            space.region_3d.view_distance *= ZOOM
            scene.render.filepath = os.path.join(out_dir, name, "f_")
            bpy.ops.render.opengl(animation=True, view_context=True)

    space.shading.type = previous_shading
    space.overlay.show_overlays = previous_overlays
    scene.frame_set(1)

    return {name: len(os.listdir(os.path.join(out_dir, name))) for name in VIEWS}
