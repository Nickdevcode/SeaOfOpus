"""Playblast por câmera, sem GUI: o mesmo comando constrói o clipe e grava o MP4.

`anim_preview.py` e `anim_climb.render` gravam a **viewport** (`render.opengl` com
`view_context=True`), e viewport só existe com o Blender aberto na tela. Quando o
pipeline roda em `blender --background` — que é como ele roda sem ninguém para
abrir o Blender, e é o único jeito de dois clipes serem trabalhados ao mesmo
tempo em processos separados — não há janela, não há `VIEW_3D` e aquele caminho
falha na primeira linha.

Aqui a vista é uma **câmera ortográfica de verdade**, como a das folhas de contato
de `preview.py`, que sempre renderizou por `render.render` e por isso nunca
precisou de tela. O preço é escolher o enquadramento à mão em vez de herdar o
`view_selected`; a vantagem é que o enquadramento fica **escrito** — dois clipes
comparados lado a lado usam a mesma régua, e um quadro renderizado hoje é
idêntico ao de amanhã.

Uso típico, de dentro do Blender (com ou sem GUI):

```python
import anim_float, playblast
anim_float.build()
playblast.clip("float", frames=range(0, 96), view="side", center=(0, 0, 0.55),
               ortho=2.4)
```

O MP4 sai em `preview/float_side.mp4`. A codificação é do `ffmpeg` de fora, e não
do Blender: a build da Steam nem sempre traz FFMPEG compilado, e quando traz
ainda não dá para escolher o *pixel format* que todo player entende.
"""

from __future__ import annotations

import math
import os
import shutil
import subprocess

import bpy
from mathutils import Vector

import preview

#: Onde os vídeos e as sequências caem. Mesma pasta das folhas de contato.
OUT_DIR = preview.OUT_DIR

FPS = 30

#: Cada vista é uma direção de onde se olha, em graus: (azimute, elevação).
#: Azimute 0 é de frente (do −Y), 90 é do bordo direito (do +X). Elevação
#: positiva olha de cima para baixo.
#:
#: `quarter` é a vista que mais engana menos: de frente esconde o passo, de lado
#: esconde o cruzamento dos membros, e três quartos mostra os dois ao mesmo
#: tempo. `top` só interessa a clipe deitado — nado, por exemplo, é o único em
#: que a braçada some nas duas vistas verticais.
VIEWS: dict[str, tuple[float, float]] = {
    "front": (0.0, 0.0),
    "side": (90.0, 0.0),
    "back": (180.0, 0.0),
    "quarter": (35.0, 12.0),
    "quarter_back": (145.0, 12.0),
    "top": (90.0, 88.0),
    "low": (60.0, -18.0),
}

#: Distância da câmera ao alvo. Em ortográfica ela não muda o tamanho da imagem,
#: só precisa ser grande o bastante para o corpo inteiro ficar à frente do plano
#: de recorte.
CAM_DISTANCE = 8.0


def _aim_ortho(cam, center: Vector, view: str, ortho: float) -> None:
    """Aponta a câmera para *center* a partir da direção de *view*."""
    azimuth, elevation = VIEWS[view]
    az, el = math.radians(azimuth), math.radians(elevation)
    offset = Vector((
        math.sin(az) * math.cos(el),
        -math.cos(az) * math.cos(el),
        math.sin(el),
    )) * CAM_DISTANCE
    preview._aim(cam, center + offset, center)
    cam.data.type = "ORTHO"
    cam.data.ortho_scale = ortho
    cam.data.clip_start = 0.1
    cam.data.clip_end = CAM_DISTANCE * 3.0


def subject_center(subject: str = "SK_Pirate") -> Vector:
    """Centro da malha **deformada** no quadro atual.

    Ler `obj.bound_box` devolve a caixa da malha em repouso: o armature é um
    modificador, e a caixa do objeto não o enxerga. Quem sabe onde o corpo
    realmente está é o objeto avaliado pelo depsgraph.
    """
    depsgraph = bpy.context.evaluated_depsgraph_get()
    obj = bpy.data.objects[subject].evaluated_get(depsgraph)
    mesh = obj.to_mesh()
    try:
        matrix = obj.matrix_world
        lo = Vector((math.inf,) * 3)
        hi = Vector((-math.inf,) * 3)
        for vert in mesh.vertices:
            world = matrix @ vert.co
            for axis in range(3):
                lo[axis] = min(lo[axis], world[axis])
                hi[axis] = max(hi[axis], world[axis])
    finally:
        obj.to_mesh_clear()
    return (lo + hi) * 0.5


def sequence(out_dir: str, frames, view: str = "quarter",
             center=(0.0, 0.0, 0.95), ortho: float = 2.1,
             width: int = 480, height: int = 640, engine: str = "WORKBENCH",
             shading: str = "TEXTURE", on_frame=None, track: bool = False,
             subject: str = "SK_Pirate") -> list[str]:
    """Renderiza um PNG por quadro de *frames* e devolve os caminhos.

    - *frames*: qualquer iterável de números de quadro. Repetir quadro é
      legítimo — um ciclo de 30 quadros rodado três vezes vira um vídeo de 3 s
      sem precisar de action mais longa.
    - *on_frame(index, frame)*: gancho chamado **depois** do `frame_set`, para
      quem precisa mexer na cena por quadro (erguer o armature numa subida,
      mover um prop). Se devolver um vetor, ele vira o alvo da câmera.
    - *track*: recentra a câmera no corpo a cada quadro. Serve a clipe com
      deslocamento; num ciclo no lugar só adiciona tremor, então o padrão é não.
    """
    os.makedirs(out_dir, exist_ok=True)
    preview._setup_engine(engine)
    if engine == "WORKBENCH":
        # `preview` pede `MATERIAL`, que no Workbench é a *cor de viewport* do
        # material — e a do atlas é um cinza único, porque a cor vive na textura.
        # Para julgar movimento a silhueta cinza até serve; para o Nicolas
        # conferir o clipe, o pirata tem de estar vestido.
        bpy.context.scene.display.shading.color_type = shading
    cam = preview._ensure_camera()
    scene = bpy.context.scene
    scene.camera = cam
    scene.render.resolution_x, scene.render.resolution_y = width, height
    scene.render.resolution_percentage = 100
    scene.render.image_settings.file_format = "PNG"
    scene.render.image_settings.color_mode = "RGB"

    written = []
    for index, frame in enumerate(frames):
        scene.frame_set(int(frame))
        target = Vector(center)
        hint = on_frame(index, int(frame)) if on_frame is not None else None
        if hint is not None:
            target = Vector(hint)
        elif track:
            target = subject_center(subject)
        _aim_ortho(cam, target, view, ortho)
        path = os.path.join(out_dir, f"f_{index:04d}.png")
        scene.render.filepath = path
        bpy.ops.render.render(write_still=True)
        written.append(path)
    return written


def encode(png_dir: str, mp4_path: str, fps: int = FPS,
           keep_frames: bool = False) -> dict:
    """Junta `f_%04d.png` num MP4 H.264 e (por padrão) apaga os PNGs.

    `yuv420p` não é capricho: sem ele o H.264 sai em `yuv444p`, que o Windows
    Media Player e o preview do Explorer abrem em tela preta.
    """
    ffmpeg = shutil.which("ffmpeg")
    if ffmpeg is None:
        raise RuntimeError("ffmpeg não está no PATH; o MP4 não pode ser gerado")
    os.makedirs(os.path.dirname(os.path.abspath(mp4_path)), exist_ok=True)
    command = [
        ffmpeg, "-y", "-loglevel", "error",
        "-framerate", str(fps),
        "-i", os.path.join(png_dir, "f_%04d.png"),
        "-c:v", "libx264", "-pix_fmt", "yuv420p", "-crf", "18",
        # Dimensão ímpar quebra o H.264; o filtro arredonda para par.
        "-vf", "scale=trunc(iw/2)*2:trunc(ih/2)*2",
        mp4_path,
    ]
    subprocess.run(command, check=True, capture_output=True)
    count = len([n for n in os.listdir(png_dir) if n.startswith("f_")])
    if not keep_frames:
        shutil.rmtree(png_dir, ignore_errors=True)
    return {"mp4": mp4_path, "frames": count,
            "seconds": round(count / fps, 3),
            "size_kb": round(os.path.getsize(mp4_path) / 1024, 1)}


def clip(name: str, frames, view: str = "quarter", fps: int = FPS,
         out_dir: str | None = None, keep_frames: bool = False,
         **kwargs) -> dict:
    """`sequence` + `encode` numa chamada. Grava `preview/<name>_<view>.mp4`."""
    out_dir = out_dir or OUT_DIR
    work = os.path.join(out_dir, f"_seq_{name}_{view}")
    sequence(work, frames, view=view, **kwargs)
    return encode(work, os.path.join(out_dir, f"{name}_{view}.mp4"), fps=fps,
                  keep_frames=keep_frames)


def sheet(name: str, frames, view: str = "side", columns: int | None = None,
          out_dir: str | None = None, **kwargs) -> str:
    """Folha de contato de uma animação: os quadros pedidos em grade num PNG.

    Vídeo mostra o movimento; folha de contato mostra as **poses**, que é onde se
    vê pé patinando e membro atravessando geometria. As duas conferências
    existem porque nenhuma das duas sozinha pegou tudo — ver as notas de
    `anim_climb.verify`.
    """
    import numpy as np

    out_dir = out_dir or OUT_DIR
    work = os.path.join(out_dir, f"_sheet_{name}_{view}")
    paths = sequence(work, frames, view=view, **kwargs)

    tiles = []
    for path in paths:
        img = bpy.data.images.load(path, check_existing=False)
        height, width = img.size[1], img.size[0]
        pixels = np.array(img.pixels[:], dtype=np.float32).reshape(height, width, 4)
        bpy.data.images.remove(img)
        tiles.append(pixels[::-1])

    columns = columns or len(tiles)
    rows = [tiles[i:i + columns] for i in range(0, len(tiles), columns)]
    # A última linha pode ficar curta; completa com quadros preenchidos de fundo
    # para o `concatenate` aceitar.
    blank = np.zeros_like(tiles[0])
    rows = [row + [blank] * (columns - len(row)) for row in rows]
    grid = np.concatenate([np.concatenate(row, axis=1) for row in rows], axis=0)

    out = bpy.data.images.new(f"Sheet_{name}", width=grid.shape[1],
                              height=grid.shape[0], alpha=False)
    out.pixels = grid[::-1].ravel().tolist()
    path = os.path.join(out_dir, f"{name}_{view}_sheet.png")
    out.filepath_raw = path
    out.file_format = "PNG"
    out.save()
    bpy.data.images.remove(out)
    shutil.rmtree(work, ignore_errors=True)
    return path
