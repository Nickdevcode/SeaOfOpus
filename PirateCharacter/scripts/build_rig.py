"""Armature humanoide + skinning do pirata.

Hierarquia no padrão comum de engine (pelvis/spine/neck/head, clavícula-braço-mão
com dedos, perna-pé-ponta), com sufixos .L/.R para o Blender reconhecer simetria.

O skinning usa pesos automáticos (heat weighting) e depois passa por duas
correções que fazem a diferença entre "riggado" e "riggado direito":
  - vértices que o heat weighting não alcançou recebem o bone mais próximo;
  - peças rígidas (chapéu, fivelas, botões) são travadas num bone só, senão
    esticam junto com a malha ao redor.
"""

import math

import bpy
from mathutils import Vector
from mathutils.kdtree import KDTree

import proportions as P

ARMATURE_NAME = "RIG_Pirate"
MESH_NAME = "SK_Pirate"

Z_ARM = P.Z_SHOULDER_PIVOT

# (nome, head, tail, pai, conectado ao pai)
BONES = [
    ("root",        (0.000, 0.000, 0.000), (0.000, -0.180, 0.000), None, False),
    ("pelvis",      (0.000, 0.010, 0.895), (0.000, 0.006, 1.010), "root", False),
    ("spine_01",    (0.000, 0.006, 1.010), (0.000, 0.002, 1.130), "pelvis", True),
    ("spine_02",    (0.000, 0.002, 1.130), (0.000, 0.000, 1.275), "spine_01", True),
    ("spine_03",    (0.000, 0.000, 1.275), (0.000, 0.000, 1.425), "spine_02", True),
    ("neck",        (0.000, 0.004, 1.425), (0.000, 0.004, 1.545), "spine_03", True),
    ("head",        (0.000, 0.004, 1.545), (0.000, 0.004, 1.760), "neck", True),

    ("clavicle.L",  (0.028, 0.004, 1.452), (0.145, 0.004, 1.462), "spine_03", False),
    ("upperarm.L",  (0.145, 0.004, 1.462), (0.500, 0.004, 1.419), "clavicle.L", True),
    ("lowerarm.L",  (0.500, 0.004, 1.419), (0.750, 0.004, 1.407), "upperarm.L", True),
    ("hand.L",      (0.750, 0.004, 1.407), (0.807, -0.002, 1.403), "lowerarm.L", True),

    ("thigh.L",     (0.118, 0.006, 0.900), (0.175, 0.000, 0.440), "pelvis", False),
    ("calf.L",      (0.175, 0.000, 0.440), (0.215, 0.005, 0.118), "thigh.L", True),
    ("foot.L",      (0.215, 0.005, 0.118), (0.215, -0.080, 0.040), "calf.L", True),
    ("toe.L",       (0.215, -0.080, 0.040), (0.215, -0.190, 0.038), "foot.L", True),
]

# Dedos: (nome, deslocamento em Y na palma, comprimento total)
FINGERS = [
    ("index",  -0.0225, 0.042),
    ("middle", -0.0075, 0.049),
    ("ring",    0.0075, 0.046),
    ("pinky",   0.0215, 0.038),
]
FINGER_X = 0.807
FINGER_Z = P.Z_SHOULDER_PIVOT - 0.028

# Bones que cada peça PODE usar. O heat weighting não sabe que a aba do casaco
# não é perna: sem isso, agachar puxa o torso/casaco junto com a coxa e a
# geometria de baixo do casaco atravessa para fora.
PART_BONE_ALLOW = {
    "PART_Torso":          ("pelvis", "spine_", "neck", "clavicle"),
    "PART_Coat":           ("pelvis", "spine_", "neck", "clavicle"),
    "PART_Coat_Collar":    ("spine_03", "neck", "head", "clavicle"),
    "PART_Coat_Lapel":     ("spine_", "clavicle"),
    "PART_Coat_Flap":      ("spine_", "pelvis"),
    "PART_Coat_Epaulette": ("clavicle", "spine_03", "upperarm"),
    "PART_Neck":           ("neck", "head", "spine_03"),
    "PART_Head":           ("head", "neck"),
    "PART_Beard":          ("head", "neck"),
    "PART_Sleeve":         ("clavicle", "upperarm", "lowerarm", "spine_03"),
    "PART_Arm_Band":       ("lowerarm", "hand"),
    "PART_Hand":           ("hand", "lowerarm", "finger_", "thumb_"),
    "PART_Pants":          ("pelvis", "thigh", "calf"),
    "PART_Boot":           ("calf", "foot", "toe", "thigh"),
    "PART_Boot_Strap":     ("calf", "thigh"),
    "PART_Sash":           ("pelvis", "spine_01"),
    "PART_Sash_Tail":      ("pelvis", "spine_01"),
    "PART_Belt":           ("pelvis", "spine_01"),
    "PART_Pouches":        ("pelvis", "spine_01"),
    "PART_Baldric":        ("spine_", "clavicle", "pelvis"),
}

# Peças que não devem deformar: travadas 100% num bone.
RIGID_PARTS = {
    "PART_Hat": "head",
    "PART_Buckle": "spine_01",
    "PART_Buttons": "spine_02",
    "PART_Eye": "head",
    "PART_Pupil": "head",
    "PART_Brow": "head",
    "PART_Nose": "head",
    "PART_Ear": "head",
    "PART_Mouth": "head",
    "PART_Moustache": "head",
    "PART_Hair": "head",
}


def _finger_bones():
    """Dois bones por dedo + polegar, gerados a partir da geometria da mão."""
    out = []
    for name, dy, length in FINGERS:
        mid = FINGER_X + length * 0.55
        tip = FINGER_X + length
        out.append((f"finger_{name}_01.L", (FINGER_X, dy, FINGER_Z),
                    (mid, dy * 1.12, FINGER_Z - 0.003), "hand.L", False))
        out.append((f"finger_{name}_02.L", (mid, dy * 1.12, FINGER_Z - 0.003),
                    (tip, dy * 1.22, FINGER_Z - 0.006), f"finger_{name}_01.L", True))
    # Polegar: sai da lateral frontal da palma.
    out.append(("thumb_01.L", (0.766, -0.020, P.Z_SHOULDER_PIVOT - 0.024),
                (0.792, -0.036, P.Z_SHOULDER_PIVOT - 0.027), "hand.L", False))
    out.append(("thumb_02.L", (0.792, -0.036, P.Z_SHOULDER_PIVOT - 0.027),
                (0.812, -0.048, P.Z_SHOULDER_PIVOT - 0.030), "thumb_01.L", True))
    return out


def _mirror(spec):
    """Espelha em X um bone .L, gerando o .R equivalente."""
    name, head, tail, parent, connected = spec
    m_name = name[:-2] + ".R"
    m_parent = parent[:-2] + ".R" if parent and parent.endswith(".L") else parent
    return (m_name, (-head[0], head[1], head[2]),
            (-tail[0], tail[1], tail[2]), m_parent, connected)


def build_armature():
    """Cria (ou recria) a armature com toda a hierarquia."""
    old = bpy.data.objects.get(ARMATURE_NAME)
    if old:
        bpy.data.objects.remove(old, do_unlink=True)

    arm_data = bpy.data.armatures.new(ARMATURE_NAME)
    arm = bpy.data.objects.new(ARMATURE_NAME, arm_data)
    bpy.context.scene.collection.objects.link(arm)

    specs = list(BONES) + _finger_bones()
    specs += [_mirror(s) for s in specs if s[0].endswith(".L")]

    for o in bpy.context.selected_objects:
        o.select_set(False)
    arm.select_set(True)
    bpy.context.view_layer.objects.active = arm
    bpy.ops.object.mode_set(mode="EDIT")

    edit_bones = arm_data.edit_bones
    for name, head, tail, _parent, _conn in specs:
        bone = edit_bones.new(name)
        bone.head = Vector(head)
        bone.tail = Vector(tail)
        bone.use_deform = name != "root"
    for name, _h, _t, parent, connected in specs:
        if parent:
            edit_bones[name].parent = edit_bones[parent]
            edit_bones[name].use_connect = connected

    bpy.ops.armature.select_all(action="SELECT")
    # Alinha o roll para o eixo Z do bone apontar para cima onde faz sentido;
    # sem isso, bones horizontais (braços em T-pose) nascem com roll aleatório
    # e a rotação em pose mode fica imprevisível.
    bpy.ops.armature.calculate_roll(type="GLOBAL_POS_Z")
    bpy.ops.object.mode_set(mode="OBJECT")

    arm_data.display_type = "OCTAHEDRAL"
    return arm


def _segment_distance(p, a, b):
    ab = b - a
    denom = ab.dot(ab)
    t = 0.0 if denom < 1e-12 else max(0.0, min(1.0, (p - a).dot(ab) / denom))
    return (p - (a + ab * t)).length


def _fill_unweighted(mesh_obj, arm):
    """Dá peso ao bone mais próximo para vértices que o heat weighting ignorou.

    Acontece em malha com peças soltas/interpenetrantes: o solver não encontra
    solução para partes isoladas e elas ficariam presas no lugar ao animar.
    """
    deform = [b for b in arm.data.bones if b.use_deform]
    segments = [(b.name, b.head_local.copy(), b.tail_local.copy()) for b in deform]
    groups = {g.name: g for g in mesh_obj.vertex_groups}
    for bone_name, _a, _b in segments:
        if bone_name not in groups:
            groups[bone_name] = mesh_obj.vertex_groups.new(name=bone_name)

    fixed = 0
    for vert in mesh_obj.data.vertices:
        total = 0.0
        for g in vert.groups:
            gname = mesh_obj.vertex_groups[g.group].name
            if gname in groups and not gname.startswith("PART_"):
                total += g.weight
        if total > 1e-4:
            continue
        p = vert.co
        best = min(segments, key=lambda s: _segment_distance(p, s[1], s[2]))
        groups[best[0]].add([vert.index], 1.0, "REPLACE")
        fixed += 1
    return fixed


def _restrict_part_bones(mesh_obj):
    """Zera pesos de bones que não fazem sentido para a peça e renormaliza.

    Se sobrar peso nenhum depois do filtro, o vértice fica como está — melhor
    uma influência estranha do que um vértice órfão travado na origem.
    """
    groups = mesh_obj.vertex_groups
    index_name = {g.index: g.name for g in groups}
    tracked = {p for p in PART_BONE_ALLOW if groups.get(p)}

    removals, additions = {}, {}
    for vert in mesh_obj.data.vertices:
        weights, part = {}, None
        for g in vert.groups:
            name = index_name[g.group]
            if name.startswith("PART_"):
                if name in tracked:
                    part = name
            else:
                weights[name] = g.weight
        if part is None or not weights:
            continue
        prefixes = PART_BONE_ALLOW[part]
        keep = {n: w for n, w in weights.items()
                if any(n.startswith(p) for p in prefixes)}
        if not keep:
            continue
        total = sum(keep.values()) or 1.0
        for name in weights:
            if name not in keep:
                removals.setdefault(name, []).append(vert.index)
        for name, w in keep.items():
            additions.setdefault(name, []).append((vert.index, w / total))

    for name, verts in removals.items():
        groups[name].remove(verts)
    for name, pairs in additions.items():
        group = groups[name]
        for vert_index, weight in pairs:
            group.add([vert_index], weight, "REPLACE")
    return sum(len(v) for v in removals.values())


# Peças cujas ilhas soltas pequenas (fivelas, placas, bolsos) devem se mover
# como corpo rígido. Elas não compartilham vértices com a tira/cinto que as
# carrega, então o skinning dá pesos diferentes e a peça descola visivelmente.
ISLAND_RIGID_PARTS = {
    "PART_Baldric", "PART_Boot_Strap", "PART_Pouches",
    "PART_Belt", "PART_Sash", "PART_Sash_Tail", "PART_Arm_Band",
    # Placas do casaco: são ilhas soltas apoiadas no peito e, sem o bind, sobram
    # flutuando à frente do torso assim que a espinha gira.
    "PART_Coat_Epaulette", "PART_Coat_Lapel", "PART_Coat_Flap",
}
# Lista de inclusão de propósito: uma regra genérica por tamanho travaria peças
# que precisam deformar (pescoço, dedos), que também são ilhas pequenas.
ISLAND_MAX_VERTS = 120


def _mesh_islands(mesh):
    """Componentes conexos da malha, via union-find sobre as arestas."""
    parent = list(range(len(mesh.vertices)))

    def find(i):
        while parent[i] != i:
            parent[i] = parent[parent[i]]
            i = parent[i]
        return i

    for edge in mesh.edges:
        a, b = find(edge.vertices[0]), find(edge.vertices[1])
        if a != b:
            parent[a] = b

    islands = {}
    for i in range(len(mesh.vertices)):
        islands.setdefault(find(i), []).append(i)
    return list(islands.values())


def _bind_islands_to_host(mesh_obj):
    """Cola cada ilha pequena nos pesos do vértice vizinho que a carrega.

    Uniformizar os pesos *dentro* da ilha não basta: se a fivela fica 100% num
    bone e a tira sob ela está misturada entre dois, a fivela ainda desliza para
    fora em pose. Copiar os pesos do vértice hospedeiro mais próximo faz a peça
    acompanhar exatamente a superfície onde está montada.
    """
    mesh = mesh_obj.data
    groups = mesh_obj.vertex_groups
    index_name = {g.index: g.name for g in groups}
    tracked = {groups[p].index for p in ISLAND_RIGID_PARTS if groups.get(p)}
    if not tracked:
        return 0

    kd = KDTree(len(mesh.vertices))
    for i, vert in enumerate(mesh.vertices):
        kd.insert(vert.co, i)
    kd.balance()

    done = 0
    for island in _mesh_islands(mesh):
        if len(island) > ISLAND_MAX_VERTS:
            continue
        island_set = set(island)
        verts = [mesh.vertices[i] for i in island]
        if not any(g.group in tracked for v in verts for g in v.groups):
            continue

        center = Vector((0.0, 0.0, 0.0))
        for v in verts:
            center += v.co
        center /= len(verts)

        host = None
        for _co, idx, _dist in kd.find_n(center, 64):
            if idx not in island_set:
                host = mesh.vertices[idx]
                break
        if host is None:
            continue

        # Herdar do vizinho, **mas sem furar a whitelist da própria peça**.
        #
        # Sem este filtro o bind desfaz o `_restrict_part_bones` que acabou de
        # rodar: quando o vizinho mais próximo de uma aba do casaco é um vértice
        # da calça, a aba inteira sai com 97% de `thigh` e passa a viajar com a
        # perna. Na caminhada isso quase não aparece — a coxa levanta pouco. Numa
        # escada, com o joelho subindo 90°, o casaco vai junto e a silhueta se
        # desmancha na frente do quadril.
        part = next((index_name[g.group] for v in verts for g in v.groups
                     if index_name[g.group] in PART_BONE_ALLOW), None)
        allowed = PART_BONE_ALLOW.get(part)
        weights = {index_name[g.group]: g.weight for g in host.groups
                   if not index_name[g.group].startswith("PART_")
                   and (allowed is None
                        or any(index_name[g.group].startswith(p) for p in allowed))}
        if not weights:
            continue
        norm = sum(weights.values()) or 1.0
        for name in list(index_name.values()):
            if name.startswith("PART_") or name in weights:
                continue
            groups[name].remove(island)
        for name, weight in weights.items():
            groups[name].add(island, weight / norm, "REPLACE")
        done += 1
    return done


def _lock_rigid_parts(mesh_obj):
    """Trava peças rígidas em um único bone (100% de peso, zerando o resto)."""
    locked = {}
    bone_groups = {g.name: g for g in mesh_obj.vertex_groups}
    for part, bone in RIGID_PARTS.items():
        src = mesh_obj.vertex_groups.get(part)
        if src is None or bone not in bone_groups:
            continue
        idx = src.index
        verts = [v.index for v in mesh_obj.data.vertices
                 if any(g.group == idx for g in v.groups)]
        if not verts:
            continue
        for g in mesh_obj.vertex_groups:
            if g.name.startswith("PART_") or g.name == bone:
                continue
            g.remove(verts)
        bone_groups[bone].add(verts, 1.0, "REPLACE")
        locked[part] = len(verts)
    return locked


# Faixa em que o peso da coxa é desligado por distância, em metros. Abaixo de
# WAIST_LEG_NEAR o vértice é coxa mesmo (a calça larga chega a ~13 cm do osso);
# acima de WAIST_LEG_FAR não há como ser.
WAIST_LEG_NEAR = 0.13
WAIST_LEG_FAR = 0.24
# Só se mexe daqui para cima. Abaixo do quadril existe geometria legitimamente
# longe do osso da coxa — a bota larga, a barra da calça — e soltá-la da perna
# seria muito pior do que o problema que se está consertando.
WAIST_LEG_GUARD = 0.02


def _relax_waist_leg_weights(mesh_obj, arm):
    """Tira da coxa o que está na cintura e não é perna.

    `_bind_islands_to_host` roda **depois** de `_restrict_part_bones`, e copia
    os pesos do vizinho mais próximo sem passar pela lista de bones permitidos.
    Quando o vizinho de uma ilha da faixa é um vértice da coxa, a peça inteira
    sai com 100% de `thigh` — furando a whitelist que existe justamente para
    impedir isso. O sintoma só aparece animando: a aba do casaco viaja 16 cm
    junto com a perna e rasga a silhueta na frente do quadril.

    A correção é geométrica, não por peça, porque os grupos `PART_` já foram
    descartados a esta altura: o peso da coxa decai com a distância ao osso e o
    que sai vai para o `pelvis`. Decair em vez de cortar importa — um corte seco
    deixaria dois vértices vizinhos com pesos muito diferentes, e a costura
    apareceria como um vinco na malha.
    """
    groups = mesh_obj.vertex_groups
    pelvis = groups.get("pelvis")
    if pelvis is None:
        return 0

    guard_z = arm.data.bones["thigh.L"].head_local.z - WAIST_LEG_GUARD
    moved = 0

    for side in ("L", "R"):
        thigh = groups.get(f"thigh.{side}")
        bone = arm.data.bones.get(f"thigh.{side}")
        if thigh is None or bone is None:
            continue
        head, tail = bone.head_local.copy(), bone.tail_local.copy()

        for vert in mesh_obj.data.vertices:
            if vert.co.z < guard_z:
                continue
            weights = {g.group: g.weight for g in vert.groups}
            leg = weights.get(thigh.index, 0.0)
            if leg <= 0.0:
                continue

            distance = _segment_distance(vert.co, head, tail)
            if distance <= WAIST_LEG_NEAR:
                continue
            keep = max(0.0, (WAIST_LEG_FAR - distance)
                       / (WAIST_LEG_FAR - WAIST_LEG_NEAR))

            thigh.add([vert.index], leg * keep, "REPLACE")
            pelvis.add([vert.index],
                       weights.get(pelvis.index, 0.0) + leg * (1.0 - keep),
                       "REPLACE")
            moved += 1

    return moved


# Uma ilha só é "casca de quadril" se estiver toda nesta faixa de altura e for
# mais larga que o volume da perna. Os números saem do rig: a coxa nasce em
# z = 0,90 e a saia do casaco desce até ~0,70; nada de perna passa de 0,19 m do
# eixo do corpo nessa altura, mas aba, bolso e fralda de casaco passam.
HIP_SHELL_Z = (0.62, 1.18)
HIP_SHELL_RADIUS = 0.19
HIP_SHELL_MAX_VERTS = 260


def _free_hip_shell_islands(mesh_obj, arm):
    """Solta da perna as peças soltas penduradas no quadril.

    Rede de segurança geométrica para o mesmo defeito que o filtro de whitelist
    no `_bind_islands_to_host` previne — e que aqui é corrigido **sem** os grupos
    `PART_`, que já não existem depois do `_drop_part_groups`. Serve para
    consertar um personagem já construído sem reconstruir a malha inteira.

    O critério é a ilha, não o vértice: a peça viaja como um corpo só, e mexer
    em metade dela criaria um vinco na costura. O que sai da coxa vai para o
    `pelvis` — que é onde uma aba de casaco de fato se pendura.
    """
    groups = mesh_obj.vertex_groups
    pelvis = groups.get("pelvis")
    if pelvis is None:
        return {"islands": 0, "verts": 0}

    mesh = mesh_obj.data
    index_name = {g.index: g.name for g in groups}
    thighs = [groups[n] for n in ("thigh.L", "thigh.R") if groups.get(n)]

    freed_islands, freed_verts = 0, 0
    for island in _mesh_islands(mesh):
        if len(island) > HIP_SHELL_MAX_VERTS:
            continue
        coords = [mesh.vertices[i].co for i in island]
        if not all(HIP_SHELL_Z[0] <= c.z <= HIP_SHELL_Z[1] for c in coords):
            continue
        radius = sum(math.hypot(c.x, c.y) for c in coords) / len(coords)
        if radius <= HIP_SHELL_RADIUS:
            continue

        moved = False
        for index in island:
            vert = mesh.vertices[index]
            weights = {index_name[g.group]: g.weight for g in vert.groups}
            leg = sum(w for n, w in weights.items() if n.startswith("thigh"))
            if leg <= 1e-4:
                continue
            for thigh in thighs:
                thigh.remove([index])
            pelvis.add([index], weights.get("pelvis", 0.0) + leg, "REPLACE")
            freed_verts += 1
            moved = True
        if moved:
            freed_islands += 1

    return {"islands": freed_islands, "verts": freed_verts}


# Até onde a clavícula pode mandar. Abaixo de `CLAVICLE_FADE[0]` ela não pesa
# nada; entre os dois valores o peso decai suavemente, para não deixar costura.
# O ombro deste rig está em z = 1,45; um palmo abaixo do peito já é território da
# coluna.
CLAVICLE_FADE = (1.18, 1.34)


def _clip_clavicle_reach(mesh_obj, arm):
    """Tira a clavícula da roupa que não é ombro.

    O heat weighting espalha a clavícula por metade do casaco — a whitelist a
    permite em `PART_Coat`, e com razão, porque o ombro do casaco é dela. Só que
    "o casaco" vai do ombro ao joelho: a medição encontrou **35% de clavícula na
    saia** e **50% no tronco**, o que significa que levantar o ombro arrasta a
    fralda do casaco e o cinto junto.

    O defeito ficou latente enquanto nenhuma animação mexeu no ombro — as
    marchas não mexem, o `anim_idle` mexe 1,1°. A escalada levanta 9°, e aí a
    roupa inteira balança com o braço.

    O peso tirado vai para o bone de coluna mais próximo, escolhido por distância
    ponto-segmento, que é o mesmo critério do `_fill_unweighted`.
    """
    groups = mesh_obj.vertex_groups
    spine = [(n, arm.data.bones[n]) for n in
             ("pelvis", "spine_01", "spine_02", "spine_03")
             if n in arm.data.bones and groups.get(n)]
    claviculas = [groups[n] for n in ("clavicle.L", "clavicle.R") if groups.get(n)]
    if not spine or not claviculas:
        return {"verts": 0, "weight": 0.0}

    low, high = CLAVICLE_FADE
    touched, moved = 0, 0.0
    for vert in mesh_obj.data.vertices:
        if vert.co.z >= high:
            continue
        weights = {g.group: g.weight for g in vert.groups}
        share = sum(weights.get(c.index, 0.0) for c in claviculas)
        if share <= 1e-4:
            continue

        keep = 0.0 if vert.co.z <= low else (vert.co.z - low) / (high - low)
        give = share * (1.0 - keep)
        if give <= 1e-4:
            continue

        host = min(spine, key=lambda item: _segment_distance(
            vert.co, item[1].head_local, item[1].tail_local))[0]
        for clavicle in claviculas:
            current = weights.get(clavicle.index, 0.0)
            if current > 0.0:
                clavicle.add([vert.index], current * keep, "REPLACE")
        groups[host].add([vert.index],
                         weights.get(groups[host].index, 0.0) + give, "REPLACE")
        touched += 1
        moved += give

    return {"verts": touched, "weight": round(moved, 1)}


def _drop_part_groups(mesh_obj):
    for g in [g for g in mesh_obj.vertex_groups if g.name.startswith("PART_")]:
        mesh_obj.vertex_groups.remove(g)


def skin(mesh_obj, arm, keep_part_groups=False):
    """Parenteia a malha à armature com pesos automáticos e corrige o resultado."""
    for o in bpy.context.selected_objects:
        o.select_set(False)
    mesh_obj.select_set(True)
    arm.select_set(True)
    bpy.context.view_layer.objects.active = arm

    used_fallback = False
    try:
        bpy.ops.object.parent_set(type="ARMATURE_AUTO")
    except RuntimeError:
        # Heat weighting falha em malha com ilhas soltas; cai para envelope e
        # o passo seguinte conserta o que ficou sem peso.
        bpy.ops.object.parent_set(type="ARMATURE_ENVELOPE")
        used_fallback = True

    fixed = _fill_unweighted(mesh_obj, arm)
    restricted = _restrict_part_bones(mesh_obj)
    islands = _bind_islands_to_host(mesh_obj)
    locked = _lock_rigid_parts(mesh_obj)
    # Depois do bind de ilhas, porque é ele quem reintroduz peso de perna em
    # peça de cintura ao copiar do vizinho.
    relaxed = _relax_waist_leg_weights(mesh_obj, arm)
    freed = _free_hip_shell_islands(mesh_obj, arm)
    clavicle = _clip_clavicle_reach(mesh_obj, arm)
    if not keep_part_groups:
        _drop_part_groups(mesh_obj)

    # Engines limitam a 4 influências por vértice. Cortar aqui (e renormalizar)
    # garante que o que se vê no Blender é o que a engine vai calcular; deixar
    # para o exportador resolver faz a deformação divergir silenciosamente.
    for o in bpy.context.selected_objects:
        o.select_set(False)
    mesh_obj.select_set(True)
    bpy.context.view_layer.objects.active = mesh_obj
    bpy.ops.object.vertex_group_limit_total(limit=4)
    bpy.ops.object.vertex_group_normalize_all(lock_active=False)

    # Garante que o modificador exista e aponte para a armature certa.
    mod = next((m for m in mesh_obj.modifiers if m.type == "ARMATURE"), None)
    if mod is None:
        mod = mesh_obj.modifiers.new("Armature", "ARMATURE")
    mod.object = arm
    mod.use_vertex_groups = True

    return {"fallback_envelope": used_fallback, "verts_fixed": fixed,
            "weights_restricted": restricted, "islands_bound": islands,
            "rigid_locked": locked, "waist_relaxed": relaxed,
            "hip_shell_freed": freed, "clavicle_clipped": clavicle}


def run():
    mesh_obj = bpy.data.objects[MESH_NAME]
    arm = build_armature()
    stats = skin(mesh_obj, arm)
    stats["bones"] = len(arm.data.bones)
    stats["deform_bones"] = sum(1 for b in arm.data.bones if b.use_deform)
    return stats
