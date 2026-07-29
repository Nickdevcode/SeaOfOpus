"""Validação pré-export e exportação para .blend, FBX e GLB.

A checagem antes de exportar não é burocracia: escala não aplicada, normal
invertida ou UV faltando só aparecem depois, dentro da engine, quando já é caro
descobrir. Melhor falhar aqui.
"""

import math
import os

import bmesh
import bpy

#: Derivado do próprio script, e não escrito à mão: o caminho fixo apontava para
#: uma pasta que foi renomeada, e o export passou a gravar num diretório que não
#: existia mais. `scripts/` mora dentro da raiz do personagem, então a raiz é o
#: pai — e continua certa se a pasta mudar de nome de novo.
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
EXPORT_DIR = os.path.join(ROOT, "export")
#: Os mapas de autoria, ao lado do script pelo mesmo motivo do `ROOT`.
TEXTURE_DIR = os.path.join(ROOT, "textures")
MESH_NAME = "SK_Pirate"
ARMATURE_NAME = "RIG_Pirate"

#: Actions com este prefixo são andaime de preview, não asset. Ver
#: `anim_jump.PREVIEW_PREFIX`, que é quem as cria.
PREVIEW_PREFIX = "_"


def drop_preview_actions():
    """Apaga as actions de preview antes de exportar. Devolve o que tirou.

    O exportador leva **todas** as actions do `bpy.data` (`ACTIONS` +
    `bake_anim_use_all_actions`), e a action de preview do pulo anima a
    translação do **objeto** armature para simular a parábola do motor. Dentro do
    jogo isso levantaria o personagem uma segunda vez, por cima da física — um
    clipe que só faz sentido no Blender viraria bug na engine.

    Apagar é seguro: é dado derivado, e `anim_jump.bake_preview()` reconstrói.
    """
    doomed = [a for a in bpy.data.actions if a.name.startswith(PREVIEW_PREFIX)]
    for action in doomed:
        action.use_fake_user = False
    names = [a.name for a in doomed]
    for action in doomed:
        bpy.data.actions.remove(action)
    return names


def relink_textures():
    """Reaponta os mapas para `textures/` e recarrega os que estiverem vazios.

    O `.blend` grava o caminho absoluto de cada imagem, então renomear a pasta do
    projeto quebra todos de uma vez — e o estrago é silencioso em dois tempos. O
    exportador só resmunga ``Image data is empty, not exporting image`` e escreve
    um GLB sem textura; e o ``img.reload()`` que `export_for_web` faz no fim
    descarta os pixels que ainda restavam em memória, que é quando o personagem
    fica branco para valer. Como os mapas moram ao lado deste script, o nome do
    arquivo basta para reencontrá-los.
    """
    relinked, missing = [], []
    for img in bpy.data.images:
        if img.source != "FILE" or not img.filepath:
            continue
        target = os.path.join(TEXTURE_DIR, os.path.basename(img.filepath))
        if not os.path.exists(target):
            missing.append(img.name)
            continue
        if os.path.normcase(bpy.path.abspath(img.filepath)) != os.path.normcase(target):
            img.filepath = target
            relinked.append(img.name)
        # Reaponta e recarrega são coisas diferentes: trocar o caminho não traz
        # os pixels de volta sozinho.
        if not img.has_data:
            img.reload()
    return {"relinked": relinked, "missing": missing}


def widen_frame_range():
    """Abre a faixa da cena até caber a action mais longa. Devolve o `frame_end`.

    O exportador FBX bakeia cada action dentro da faixa da **cena**, não da
    action. Como os clipes têm durações diferentes (o `Idle` tem 96 quadros, o
    `JumpLand` tem 14), qualquer faixa mais curta que a maior corta um clipe pela
    metade — em silêncio, e só se descobre com o personagem congelado no jogo.
    Trabalhar no Blender mexe nessa faixa o tempo todo, então ela é reposta aqui
    em vez de confiada ao estado em que a cena ficou.
    """
    scene = bpy.context.scene
    longest = max((a.frame_range[1] for a in bpy.data.actions), default=1.0)
    scene.frame_start = 0
    scene.frame_end = int(math.ceil(longest))
    return scene.frame_end


def validate():
    """Checklist de asset game-ready. Devolve um relatório com problemas achados."""
    obj = bpy.data.objects[MESH_NAME]
    arm = bpy.data.objects[ARMATURE_NAME]
    mesh = obj.data
    issues = []

    if tuple(round(s, 5) for s in obj.scale) != (1.0, 1.0, 1.0):
        issues.append(f"escala do mesh não aplicada: {tuple(obj.scale)}")
    if any(round(r, 5) != 0.0 for r in obj.rotation_euler):
        issues.append(f"rotação do mesh não aplicada: {tuple(obj.rotation_euler)}")
    if tuple(round(s, 5) for s in arm.scale) != (1.0, 1.0, 1.0):
        issues.append(f"escala da armature não aplicada: {tuple(arm.scale)}")
    if not mesh.uv_layers:
        issues.append("sem UV map")

    bm = bmesh.new()
    bm.from_mesh(mesh)
    loose_verts = sum(1 for v in bm.verts if not v.link_edges)
    non_manifold = sum(1 for e in bm.edges if not e.is_manifold)
    ngons = sum(1 for f in bm.faces if len(f.verts) > 4)
    tris = sum(1 for f in bm.faces if len(f.verts) == 3)
    quads = sum(1 for f in bm.faces if len(f.verts) == 4)
    bm.free()

    if loose_verts:
        issues.append(f"{loose_verts} vértices soltos")
    if ngons:
        issues.append(f"{ngons} n-gons")

    # Vértices sem nenhum peso ficariam presos na origem ao animar.
    unweighted = 0
    for vert in mesh.vertices:
        if sum(g.weight for g in vert.groups) <= 1e-5:
            unweighted += 1
    if unweighted:
        issues.append(f"{unweighted} vértices sem peso")

    mesh.calc_loop_triangles()
    lowest = min(v.co.z for v in mesh.vertices)
    if abs(lowest) > 0.02:
        issues.append(f"solas fora do chão (z mínimo = {lowest:.3f})")

    return {
        "issues": issues,
        "tris": len(mesh.loop_triangles),
        "verts": len(mesh.vertices),
        "quads": quads,
        "tris_faces": tris,
        "ngons": ngons,
        # Arestas de borda são esperadas: as peças de roupa são cascas abertas.
        "non_manifold_edges": non_manifold,
        "bones": len(arm.data.bones),
        "materials": [m.name for m in mesh.materials if m],
        "height_m": round(max(v.co.z for v in mesh.vertices) - lowest, 3),
    }


def _select_asset():
    for o in bpy.context.selected_objects:
        o.select_set(False)
    mesh_obj = bpy.data.objects[MESH_NAME]
    arm = bpy.data.objects[ARMATURE_NAME]
    mesh_obj.select_set(True)
    arm.select_set(True)
    bpy.context.view_layer.objects.active = arm
    return mesh_obj, arm


def export_all(with_animation=True):
    """Escreve .blend, FBX e GLB.

    ``with_animation`` leva junto as actions do rig. Fica ligado por padrão
    desde que existe ciclo de caminhada; passar ``False`` volta a exportar só a
    pose de repouso, que é o que se quer quando o destino é esculpir ou
    retopologizar em outro programa.
    """
    os.makedirs(EXPORT_DIR, exist_ok=True)
    written = {}
    # Antes do `.blend`, e não só antes do GLB: salvar o andaime junto faria a
    # próxima exportação a partir do arquivo salvo repetir o problema. Vale o
    # mesmo para os caminhos das texturas — salvar consertado é o que impede a
    # próxima sessão de reabrir quebrada.
    written["textures"] = relink_textures()
    written["dropped_preview_actions"] = drop_preview_actions()
    written["scene_frame_end"] = widen_frame_range()

    blend_path = os.path.join(ROOT, "pirate_character.blend")
    bpy.ops.wm.save_as_mainfile(filepath=blend_path)
    written["blend"] = blend_path

    _select_asset()

    fbx_path = os.path.join(EXPORT_DIR, "SK_Pirate.fbx")
    bpy.ops.export_scene.fbx(
        filepath=fbx_path,
        use_selection=True,
        object_types={"ARMATURE", "MESH"},
        apply_scale_options="FBX_SCALE_NONE",
        axis_forward="-Y",
        axis_up="Z",
        use_mesh_modifiers=True,
        mesh_smooth_type="FACE",
        use_triangles=True,
        add_leaf_bones=False,
        primary_bone_axis="Y",
        secondary_bone_axis="X",
        bake_anim=with_animation,
        # Todas as actions, não só a ativa: são vários clipes por personagem.
        bake_anim_use_all_actions=with_animation,
        bake_anim_use_nla_strips=False,
        bake_anim_step=1.0,
        # Sem simplificação: o ciclo já está amostrado em todo frame, e deixar o
        # exportador jogar chaves fora reintroduz o escorregamento de pé que
        # custou caro para eliminar.
        bake_anim_simplify_factor=0.0,
        path_mode="COPY",
        embed_textures=False,
    )
    written["fbx"] = fbx_path

    glb_path = os.path.join(EXPORT_DIR, "SK_Pirate.glb")
    _select_asset()
    bpy.ops.export_scene.gltf(
        filepath=glb_path,
        export_format="GLB",
        use_selection=True,
        export_apply=True,
        export_yup=True,
        export_texcoords=True,
        export_normals=True,
        export_skins=True,
        export_animations=with_animation,
        export_animation_mode="ACTIONS",
        # Cada action pela **própria** duração, não pela faixa da cena. Ligado,
        # este flag recorta todo mundo no `frame_end` da cena: com a faixa em 48
        # (o que o preview do pulo deixa) o `Idle`, que tem 96 quadros, sairia
        # pela metade e o personagem congelaria no meio da respiração.
        export_frame_range=False,
        # Idem FBX: otimizar o tamanho da animação remove chaves "redundantes",
        # e no ciclo de caminhada nenhuma é.
        export_optimize_animation_size=False,
    )
    written["glb"] = glb_path

    for path in written.values():
        written[[k for k, v in written.items() if v == path][0]] = path
    written["sizes_kb"] = {
        k: round(os.path.getsize(v) / 1024.0, 1)
        for k, v in written.items() if isinstance(v, str) and os.path.exists(v)
    }
    return written


#: Resolução das texturas na versão para o jogo. O atlas de autoria é 4K, e ele
#: continua sendo a fonte — isto aqui é só o que desce pelo cabo.
WEB_TEXTURE_SIZE = 2048
#: Qualidade do WebP. Acima de 85 o arquivo cresce sem diferença visível num
#: personagem estilizado.
WEB_TEXTURE_QUALITY = 85


def export_for_web(path=None, size=WEB_TEXTURE_SIZE, quality=WEB_TEXTURE_QUALITY):
    """GLB enxuto para o navegador: texturas reduzidas e em WebP.

    O GLB de autoria tem **21,7 MB** — quatro mapas 4K em PNG sem perdas dentro
    do arquivo. Isso é ótimo para levar o personagem para outro programa e
    inaceitável para um jogo web, onde ele é a primeira coisa que o jogador
    espera baixar.

    As imagens são reduzidas **em memória** e recarregadas do disco no fim, então
    o `.blend` e os mapas originais ficam intactos. O exportador reencoda a
    partir do que está na memória, que é justamente o que se quer aqui.
    """
    path = path or os.path.join(EXPORT_DIR, "SK_Pirate_web.glb")
    os.makedirs(os.path.dirname(path), exist_ok=True)
    # Repetido de propósito: esta função também é chamada sozinha, e o GLB do
    # navegador é justamente o que não pode carregar andaime.
    textures = relink_textures()
    dropped = drop_preview_actions()
    widen_frame_range()

    # O arquivo tem de existir, e `has_data` não serve para checar isso: o
    # Blender só traz os pixels quando alguém pede, então uma imagem perfeitamente
    # sadia passa a sessão inteira com `has_data` falso. Já uma imagem desligada
    # do disco continua reportando o tamanho antigo — reduzir esse fantasma
    # quebra o exportador lá adiante com um `expected sequence size 0` que não
    # aponta para lugar nenhum.
    touched = [img for img in bpy.data.images
               if img.source == "FILE" and max(img.size) > size
               and os.path.exists(bpy.path.abspath(img.filepath))]
    for img in touched:
        img.scale(size, size)

    try:
        _select_asset()
        bpy.ops.export_scene.gltf(
            filepath=path,
            export_format="GLB",
            use_selection=True,
            export_apply=True,
            export_yup=True,
            export_texcoords=True,
            export_normals=True,
            export_skins=True,
            export_animations=True,
            export_animation_mode="ACTIONS",
            # Ver a mesma nota em `export_all`.
            export_frame_range=False,
            export_optimize_animation_size=False,
            export_image_format="WEBP",
            export_image_quality=quality,
        )
    finally:
        # Volta ao 4K do disco mesmo se o export falhar: deixar a cena com
        # textura reduzida seria uma perda silenciosa de qualidade.
        for img in touched:
            img.reload()

    return {"path": path, "size_kb": round(os.path.getsize(path) / 1024.0, 1),
            "textures_rescaled": [img.name for img in touched],
            "texture_size": size,
            "textures": textures,
            "dropped_preview_actions": dropped}


def run(web=True):
    report = validate()
    report["exported"] = export_all()
    if web:
        report["web"] = export_for_web()
    return report
