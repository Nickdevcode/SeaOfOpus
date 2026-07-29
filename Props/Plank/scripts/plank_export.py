"""Validação pré-export e escrita de `.blend`, FBX e GLB.

Mesma filosofia de `PirateCharacter/scripts/export.py`: a checagem roda **antes**
de escrever, porque escala não aplicada, normal invertida ou UV faltando só
aparecem dentro da engine, quando já é caro descobrir.

O prefixo é `SM_` (*static mesh*) e não `SK_`: a tábua não tem esqueleto.
"""

import json
import os
import struct
import sys

import bmesh
import bpy

_HERE = os.path.dirname(os.path.abspath(__file__))
if _HERE not in sys.path:
    sys.path.insert(0, _HERE)

import build_plank  # noqa: E402
import plank_spec as S  # noqa: E402

ROOT = os.path.dirname(_HERE)
EXPORT_DIR = os.path.join(ROOT, "export")
TEXTURE_DIR = os.path.join(ROOT, "textures")
MESH_NAME = build_plank.MESH_NAME
BLEND_NAME = "plank.blend"

#: Resolução das texturas na versão para o navegador. O atlas de autoria já é 1K,
#: então aqui não se reduz nada — o ganho vem só do WebP. Ver `export_for_web`.
WEB_TEXTURE_QUALITY = 88


def _select_asset():
    for obj in bpy.context.selected_objects:
        obj.select_set(False)
    obj = bpy.data.objects[MESH_NAME]
    obj.select_set(True)
    bpy.context.view_layer.objects.active = obj
    return obj


def _texture_target(img):
    """Onde este mapa **deveria** estar, em caminho absoluto de sistema.

    ⚠️ **Nunca passe `img.filepath` cru para o `os.path`.** Depois de salvar o
    `.blend`, o Blender reescreve os caminhos para a forma relativa dele:
    `//textures\\T_Plank_D.png`. No Windows, o `ntpath` lê esses dois primeiros
    caracteres como início de **caminho UNC** (`\\\\servidor\\compartilhamento`),
    engole a string inteira como "drive" e devolve `basename() == ""`.

    O estrago era silencioso e completo: o alvo virava a *pasta* `textures\\`,
    `os.path.exists` dizia que sim (pasta existe!), o código "consertava" o
    caminho apontando a imagem para um diretório, o `reload()` esvaziava os
    pixels e o export do GLB web saía com **três texturas e uma imagem** — cor
    base, rugosidade e normal todas no mesmo arquivo. Nenhum erro, código de
    saída zero, arquivo de tamanho plausível que abre sem reclamar.

    `bpy.path.abspath` resolve o `//` antes de o `os.path` chegar perto. O nome do
    datablock é a segunda linha de defesa: neste pipeline ele é sempre o nome do
    arquivo sem extensão, então dá para reconstruir o alvo mesmo se o caminho
    vier ilegível.
    """
    name = os.path.basename(bpy.path.abspath(img.filepath))
    if not name:
        name = f"{img.name}.png"
    return os.path.join(TEXTURE_DIR, name)


def relink_textures():
    """Reaponta os mapas para `textures/` e **sempre** recarrega os pixels.

    O `.blend` grava o caminho de cada imagem, então mover ou renomear a pasta do
    projeto quebra todos de uma vez — e o exportador só resmunga
    ``Image data is empty`` e escreve um GLB sem textura. A armadilha é a mesma
    documentada no `export.py` do personagem; a cura também.

    O `reload()` é incondicional, e não só quando `has_data` é falso: recarregar
    350 KB de PNG é barato e `has_data` não é confiável — o Blender só traz os
    pixels quando alguém pede. Aqui o disco é a fonte da verdade, os mapas
    acabaram de ser bakeados e gravados, então não há edição em memória a perder.
    """
    relinked, missing = [], []
    for img in bpy.data.images:
        if img.source != "FILE" or not img.filepath:
            continue
        target = _texture_target(img)
        if not os.path.isfile(target):  # `isfile`, não `exists`: ver acima
            missing.append(img.name)
            continue
        if os.path.normcase(bpy.path.abspath(img.filepath)) != os.path.normcase(target):
            img.filepath = target
            relinked.append(img.name)
        img.reload()
    return {"relinked": relinked, "missing": missing}


def inspect_glb(path):
    """Lê o GLB gravado e confere que **toda textura tem imagem**.

    Existe por causa de um bug real: o `SM_Plank_web.glb` saía com três texturas
    e **uma** imagem — cor base, rugosidade e normal apontando todas para o mesmo
    arquivo. O Blender avisava com uma linha de WARNING no meio do log e devolvia
    código de sucesso; o arquivo tinha tamanho plausível e abria sem erro. Só
    abrindo o JSON do GLB dá para ver.

    Conferir o **artefato**, e não o processo, é a única checagem que não mente.
    """
    data = open(path, "rb").read()
    if len(data) < 12 or data[:4] != b"glTF":
        return {"error": "não é um GLB"}
    _, _, total = struct.unpack_from("<III", data, 0)
    offset, document = 12, None
    while offset < total:
        length, kind = struct.unpack_from("<II", data, offset)
        if kind == 0x4E4F534A:  # 'JSON'
            document = json.loads(data[offset + 8:offset + 8 + length].decode("utf-8"))
            break
        offset += 8 + length
    if document is None:
        return {"error": "GLB sem bloco JSON"}

    textures = document.get("textures", [])
    # A imagem pode vir no campo padrão `source` ou dentro da extensão WebP.
    orphans = [
        i for i, tex in enumerate(textures)
        if tex.get("source") is None
        and not any(ext.get("source") is not None
                    for ext in tex.get("extensions", {}).values())
    ]
    return {
        "size_kb": round(len(data) / 1024.0, 1),
        "images": [img.get("name", "?") for img in document.get("images", [])],
        "textures": len(textures),
        "textures_without_image": orphans,
        "meshes": [mesh.get("name") for mesh in document.get("meshes", [])],
    }


def validate():
    """Checklist de asset game-ready. Devolve o relatório com o que achou."""
    obj = bpy.data.objects[MESH_NAME]
    mesh = obj.data
    issues = []

    if tuple(round(v, 5) for v in obj.scale) != (1.0, 1.0, 1.0):
        issues.append(f"escala não aplicada: {tuple(obj.scale)}")
    if any(round(r, 5) != 0.0 for r in obj.rotation_euler):
        issues.append(f"rotação não aplicada: {tuple(obj.rotation_euler)}")
    if tuple(round(v, 5) for v in obj.location) != (0.0, 0.0, 0.0):
        issues.append(f"objeto fora da origem: {tuple(obj.location)}")
    if not mesh.uv_layers:
        issues.append("sem UV map")
    if len(mesh.materials) != 1:
        issues.append(f"esperado 1 material no export, achei {len(mesh.materials)}")

    bm = bmesh.new()
    bm.from_mesh(mesh)
    loose = sum(1 for v in bm.verts if not v.link_edges)
    non_manifold = sum(1 for e in bm.edges if not e.is_manifold)
    ngons = sum(1 for f in bm.faces if len(f.verts) > 4)
    tris = sum(1 for f in bm.faces if len(f.verts) == 3)
    quads = sum(1 for f in bm.faces if len(f.verts) == 4)
    # A tábua é um sólido fechado: qualquer aresta de borda é buraco de verdade,
    # diferente das peças de roupa do personagem, que são cascas abertas.
    boundary = sum(1 for e in bm.edges if e.is_boundary)
    # Normal apontando para dentro num sólido fechado é erro, e o teste é
    # geométrico: a face olha para o mesmo lado que o vetor do centro do objeto
    # até ela? Numa peça convexa como esta, isso é exato.
    inverted = 0
    for face in bm.faces:
        if face.normal.dot(face.calc_center_median()) < 0.0:
            inverted += 1
    bm.free()

    if loose:
        issues.append(f"{loose} vértices soltos")
    if ngons:
        issues.append(f"{ngons} n-gons")
    if boundary:
        issues.append(f"{boundary} arestas de borda — a malha não está fechada")
    if non_manifold:
        issues.append(f"{non_manifold} arestas non-manifold")
    if inverted:
        issues.append(f"{inverted} faces com normal invertida")

    xs = [v.co.x for v in mesh.vertices]
    ys = [v.co.y for v in mesh.vertices]
    zs = [v.co.z for v in mesh.vertices]
    mesh.calc_loop_triangles()

    return {
        "issues": issues,
        "tris": len(mesh.loop_triangles),
        "verts": len(mesh.vertices),
        "quads": quads,
        "tri_faces": tris,
        "ngons": ngons,
        "boundary_edges": boundary,
        "non_manifold_edges": non_manifold,
        "inverted_faces": inverted,
        "materials": [m.name for m in mesh.materials if m],
        "uv_layers": [layer.name for layer in mesh.uv_layers],
        "bbox_m": (round(max(xs) - min(xs), 4),
                   round(max(ys) - min(ys), 4),
                   round(max(zs) - min(zs), 4)),
        "nominal_m": (S.LENGTH, S.WIDTH, S.THICKNESS),
    }


def export_all():
    """Escreve `plank.blend`, `SM_Plank.fbx` e `SM_Plank.glb`."""
    os.makedirs(EXPORT_DIR, exist_ok=True)
    written = {"textures": relink_textures()}

    blend_path = os.path.join(ROOT, BLEND_NAME)
    bpy.ops.wm.save_as_mainfile(filepath=blend_path)
    written["blend"] = blend_path

    _select_asset()
    fbx_path = os.path.join(EXPORT_DIR, "SM_Plank.fbx")
    bpy.ops.export_scene.fbx(
        filepath=fbx_path,
        use_selection=True,
        object_types={"MESH"},
        apply_scale_options="FBX_SCALE_NONE",
        axis_forward="-Y",
        axis_up="Z",
        use_mesh_modifiers=True,
        # FACE e não EDGE: a peça é *flat shaded* de propósito (mesmo tratamento
        # do personagem). Exportar suavização por aresta faria a engine
        # reconstruir normais suaves e derreter o facetamento.
        mesh_smooth_type="FACE",
        use_triangles=True,
        add_leaf_bones=False,
        bake_anim=False,
        path_mode="COPY",
        embed_textures=False,
    )
    written["fbx"] = fbx_path

    _select_asset()
    glb_path = os.path.join(EXPORT_DIR, "SM_Plank.glb")
    bpy.ops.export_scene.gltf(
        filepath=glb_path,
        export_format="GLB",
        use_selection=True,
        export_apply=True,
        export_yup=True,
        export_texcoords=True,
        export_normals=True,
        export_animations=False,
    )
    written["glb"] = glb_path

    written["sizes_kb"] = {
        key: round(os.path.getsize(value) / 1024.0, 1)
        for key, value in written.items()
        if isinstance(value, str) and os.path.exists(value)
    }
    written["glb_check"] = inspect_glb(glb_path)
    return written


def export_for_web(path=None, quality=WEB_TEXTURE_QUALITY):
    """GLB enxuto para o navegador: as mesmas texturas, reencodadas em WebP.

    O GLB de autoria carrega três PNG 1024² sem perdas. Isso é o certo para levar
    a peça para outro programa e caro demais para um jogo web, onde a tábua é
    item de consumo e o jogador baixa tudo antes de jogar. O WebP em 88 corta
    ~85% do arquivo sem diferença visível numa superfície de gradiente largo.

    A resolução **não** é reduzida (diferente do personagem, que desce de 4K para
    2K): 1024² já é o mínimo que sustenta o realce do chanfro.
    """
    path = path or os.path.join(EXPORT_DIR, "SM_Plank_web.glb")
    os.makedirs(os.path.dirname(path), exist_ok=True)
    relink_textures()
    _select_asset()
    bpy.ops.export_scene.gltf(
        filepath=path,
        export_format="GLB",
        use_selection=True,
        export_apply=True,
        export_yup=True,
        export_texcoords=True,
        export_normals=True,
        export_animations=False,
        export_image_format="WEBP",
        export_image_quality=quality,
    )
    return {"path": path, "size_kb": round(os.path.getsize(path) / 1024.0, 1),
            "glb_check": inspect_glb(path)}


def run(web=True):
    report = validate()
    report["exported"] = export_all()
    if web:
        report["web"] = export_for_web()

    # Os problemas achados no artefato entram na **mesma** lista de problemas da
    # malha: um GLB com textura órfã é tão inexportável quanto uma malha com
    # n-gon, e não pode ficar escondido num campo que ninguém lê.
    for tag in ("exported", "web"):
        check = report.get(tag, {}).get("glb_check", {})
        if check.get("error"):
            report["issues"].append(f"{tag}: {check['error']}")
        orphans = check.get("textures_without_image") or []
        if orphans:
            report["issues"].append(
                f"{tag}: texturas sem imagem no GLB, índices {orphans}")
    return report
