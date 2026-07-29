"""Biblioteca de construção procedural de malhas low-poly (roda dentro do Blender).

A ideia central: cada peça do personagem é montada por *sweep* — uma sequência de
seções transversais posicionadas ao longo de um caminho 3D e costuradas com quads.
Isso garante:
  - topologia 100% quad no corpo das peças (triângulos só nas tampas),
  - edge loops previsíveis nas articulações (essencial pro rig),
  - controle total da silhueta, que é o que define a semelhança com a referência.

Convenções do projeto:
  - 1 unidade Blender = 1 metro.
  - Personagem olha para -Y (Front View do Blender), +Z é cima, +X é a esquerda dele.
  - Peças laterais são construídas em +X e espelhadas.
"""

import math

import bmesh
import bpy
from mathutils import Matrix, Vector, noise

TAU = math.pi * 2.0


# ---------------------------------------------------------------------------
# Cena
# ---------------------------------------------------------------------------

def purge_scene():
    """Zera a cena inteira (objetos + datablocks órfãos) para builds idempotentes."""
    for obj in list(bpy.data.objects):
        bpy.data.objects.remove(obj, do_unlink=True)
    for block in (bpy.data.meshes, bpy.data.armatures, bpy.data.curves):
        for item in list(block):
            block.remove(item)
    # Materiais/imagens são recriados pelos scripts de textura; limpa os órfãos.
    for block in (bpy.data.materials, bpy.data.images):
        for item in list(block):
            if item.users == 0:
                block.remove(item)


def get_collection(name):
    """Devolve (criando se preciso) uma coleção filha da cena."""
    coll = bpy.data.collections.get(name)
    if coll is None:
        coll = bpy.data.collections.new(name)
    if coll.name not in {c.name for c in bpy.context.scene.collection.children}:
        bpy.context.scene.collection.children.link(coll)
    return coll


def deselect_all():
    for obj in bpy.context.selected_objects:
        obj.select_set(False)


def activate(obj, solo=True):
    """Torna `obj` ativo e (por padrão) o único selecionado — operadores dependem disso."""
    if solo:
        deselect_all()
    obj.select_set(True)
    bpy.context.view_layer.objects.active = obj


# ---------------------------------------------------------------------------
# Perfis de seção
# ---------------------------------------------------------------------------

def superellipse(rx, ry, n_seg=12, squareness=0.35, phase=0.0):
    """Anel superelíptico 2D no plano local (u, v).

    `squareness` 0 = elipse pura, 1 = quase retângulo. É o parâmetro que dá o
    aspecto "bloco arredondado" das roupas sem precisar de bevel.
    """
    exp = 2.0 / (2.0 + 6.0 * max(0.0, min(1.0, squareness)))
    pts = []
    for i in range(n_seg):
        t = TAU * i / n_seg + phase
        c, s = math.cos(t), math.sin(t)
        u = rx * math.copysign(abs(c) ** exp, c)
        v = ry * math.copysign(abs(s) ** exp, s)
        pts.append((u, v))
    return pts


def asym_ring(rx, ry_front, ry_back, n_seg=12, squareness=0.35, phase=0.0):
    """Anel com profundidade diferente na frente (-v) e nas costas (+v).

    Torso, coxa e cabeça não são cilindros simétricos: o peito projeta mais que
    as costas, a nuca é mais chata. Esse anel resolve isso sem custar geometria.
    """
    pts = superellipse(rx, 1.0, n_seg, squareness, phase)
    out = []
    for u, v in pts:
        out.append((u, v * (ry_front if v < 0 else ry_back)))
    return out


def scale_profile(profile, sx, sy):
    return [(u * sx, v * sy) for u, v in profile]


def offset_profile(profile, du, dv):
    return [(u + du, v + dv) for u, v in profile]


# ---------------------------------------------------------------------------
# Frames ao longo de um caminho (parallel transport)
# ---------------------------------------------------------------------------

def path_frames(points, up_hint=Vector((0.0, 0.0, 1.0))):
    """Frames ortonormais (u, v, tangente) ao longo do caminho, sem torção.

    Usa parallel transport: cada frame é o anterior rotacionado pelo mínimo
    necessário para acompanhar a tangente. Evita o "flip" que o método
    ingênuo (up fixo) produz quando o caminho fica paralelo ao up.
    """
    pts = [Vector(p) for p in points]
    n = len(pts)
    tangents = []
    for i in range(n):
        if i == 0:
            t = pts[1] - pts[0]
        elif i == n - 1:
            t = pts[-1] - pts[-2]
        else:
            t = pts[i + 1] - pts[i - 1]
        if t.length < 1e-9:
            t = Vector((0.0, 0.0, 1.0))
        tangents.append(t.normalized())

    # Frame inicial: escolhe um "up" que não seja colinear com a tangente.
    t0 = tangents[0]
    ref = up_hint if abs(t0.dot(up_hint)) < 0.95 else Vector((1.0, 0.0, 0.0))
    u0 = (ref - t0 * ref.dot(t0)).normalized()
    v0 = t0.cross(u0).normalized()

    frames = [(u0, v0, t0)]
    for i in range(1, n):
        pu, pv, pt = frames[-1]
        t = tangents[i]
        axis = pt.cross(t)
        if axis.length < 1e-9:
            u, v = pu, pv
        else:
            angle = math.atan2(axis.length, pt.dot(t))
            rot = Matrix.Rotation(angle, 3, axis.normalized())
            u = (rot @ pu).normalized()
            v = (rot @ pv).normalized()
        frames.append((u, v, t))
    return frames


# ---------------------------------------------------------------------------
# Sweep / loft
# ---------------------------------------------------------------------------

def sweep(points, profiles, cap_start=True, cap_end=True, up_hint=Vector((0.0, 0.0, 1.0)),
          frames=None):
    """Costura seções ao longo de um caminho e devolve (verts, faces).

    `profiles` tem um perfil (lista de pares u,v) por ponto do caminho; todos
    precisam ter o mesmo número de pontos. Tampas viram leque de triângulos a
    partir do centroide — nada de n-gon.
    """
    pts = [Vector(p) for p in points]
    assert len(pts) == len(profiles), "um perfil por ponto do caminho"
    if frames is None:
        frames = path_frames(pts, up_hint)

    verts = []
    rings = []
    for center, (u, v, _t), prof in zip(pts, frames, profiles):
        idx = []
        for pu, pv in prof:
            idx.append(len(verts))
            verts.append(center + u * pu + v * pv)
        rings.append(idx)

    faces = []
    n_seg = len(profiles[0])
    for a, b in zip(rings[:-1], rings[1:]):
        for j in range(n_seg):
            k = (j + 1) % n_seg
            faces.append((a[j], a[k], b[k], b[j]))

    for ring, do_cap, flip in ((rings[0], cap_start, True), (rings[-1], cap_end, False)):
        if not do_cap:
            continue
        centroid = sum((verts[i] for i in ring), Vector()) / len(ring)
        c_idx = len(verts)
        verts.append(centroid)
        for j in range(n_seg):
            k = (j + 1) % n_seg
            tri = (c_idx, ring[j], ring[k])
            faces.append(tri[::-1] if flip else tri)

    return verts, faces


def loft_z(sections, n_seg=12, cap_start=True, cap_end=True):
    """Atalho para peças empilhadas em Z.

    `sections` = lista de dicts com: z, rx, ry_f, ry_b, sq, dx, dy.
    Retorna (verts, faces). Usa frames fixos (u=X, v=Y) porque o eixo é vertical.
    """
    points, profiles = [], []
    for s in sections:
        points.append(Vector((s.get("dx", 0.0), s.get("dy", 0.0), s["z"])))
        prof = asym_ring(
            s["rx"],
            s.get("ry_f", s.get("ry", s["rx"])),
            s.get("ry_b", s.get("ry", s["rx"])),
            n_seg,
            s.get("sq", 0.35),
            s.get("phase", 0.0),
        )
        profiles.append(prof)
    frames = [(Vector((1, 0, 0)), Vector((0, 1, 0)), Vector((0, 0, 1)))] * len(points)
    return sweep(points, profiles, cap_start, cap_end, frames=frames)


# ---------------------------------------------------------------------------
# Criação de objetos
# ---------------------------------------------------------------------------

def make_object(name, verts, faces, collection=None):
    """Cria o objeto, solda vértices coincidentes e recalcula normais pra fora."""
    mesh = bpy.data.meshes.new(name)
    mesh.from_pydata([tuple(v) for v in verts], [], [tuple(f) for f in faces])
    mesh.validate(verbose=False)
    mesh.update()

    bm = bmesh.new()
    bm.from_mesh(mesh)
    bmesh.ops.remove_doubles(bm, verts=bm.verts, dist=1e-5)
    bmesh.ops.recalc_face_normals(bm, faces=bm.faces)
    bm.to_mesh(mesh)
    bm.free()

    obj = bpy.data.objects.new(name, mesh)
    (collection or bpy.context.scene.collection).objects.link(obj)
    return obj


def make_box(name, center, size, sq=0.85, bevel=0.0, collection=None, segments=1):
    """Caixa arredondada (fivelas, bolsos, botões). `bevel` encolhe as tampas."""
    cx, cy, cz = center
    hx, hy, hz = size[0] / 2.0, size[1] / 2.0, size[2] / 2.0
    zs = [-hz, hz] if segments == 1 else [
        -hz + (2 * hz) * i / segments for i in range(segments + 1)
    ]
    sections = []
    for z in zs:
        shrink = 1.0
        if bevel > 0.0 and (abs(z + hz) < 1e-6 or abs(z - hz) < 1e-6):
            shrink = 1.0 - bevel
        sections.append({"z": cz + z, "rx": hx * shrink, "ry": hy * shrink,
                         "sq": sq, "dx": cx, "dy": cy})
    if bevel > 0.0:
        # Insere anéis logo acima/abaixo das tampas para o chanfro ficar visível.
        top = sections[-1]
        bot = sections[0]
        inner_b = dict(bot, z=bot["z"] + hz * bevel, rx=hx, ry=hy)
        inner_t = dict(top, z=top["z"] - hz * bevel, rx=hx, ry=hy)
        sections = [bot, inner_b] + sections[1:-1] + [inner_t, top]
    verts, faces = loft_z(sections, n_seg=8)
    return make_object(name, verts, faces, collection)


def make_plate(name, outline, thickness, collection=None, axis=Vector((0, 1, 0))):
    """Placa com espessura a partir de um contorno 3D fechado (abas, lapelas, aba do chapéu)."""
    axis = Vector(axis).normalized()
    half = axis * (thickness / 2.0)
    pts = [Vector(p) for p in outline]
    n = len(pts)
    verts = [p - half for p in pts] + [p + half for p in pts]
    faces = []
    for i in range(n):
        j = (i + 1) % n
        faces.append((i, j, j + n, i + n))
    # Tampas por leque a partir do centroide de cada lado.
    for base, flip in ((0, True), (n, False)):
        centroid = sum((verts[base + i] for i in range(n)), Vector()) / n
        c = len(verts)
        verts.append(centroid)
        for i in range(n):
            j = (i + 1) % n
            tri = (c, base + i, base + j)
            faces.append(tri[::-1] if flip else tri)
    return make_object(name, verts, faces, collection)


# ---------------------------------------------------------------------------
# Acabamento
# ---------------------------------------------------------------------------

def facet(obj, amount=0.004, scale=9.0, seed=0.0):
    """Empurra vértices ao longo da normal com ruído 3D coerente.

    É isso que reproduz o visual "facetado/amassado" da referência: as faces
    param de ser perfeitamente planas e o flat shading passa a quebrar a luz
    em placas irregulares. O ruído é função da posição, então peças vizinhas
    deformam de forma consistente e não abrem fresta.
    """
    if amount <= 0.0:
        return
    mesh = obj.data
    mesh.calc_loop_triangles()
    normals = {i: Vector((0, 0, 0)) for i in range(len(mesh.vertices))}
    for poly in mesh.polygons:
        for vi in poly.vertices:
            normals[vi] += poly.normal
    off = Vector((seed * 3.7, seed * 1.9, seed * 5.3))
    for i, v in enumerate(mesh.vertices):
        nrm = normals[i]
        if nrm.length < 1e-9:
            continue
        p = Vector(v.co) * scale + off
        d = noise.noise(p) * amount
        v.co = Vector(v.co) + nrm.normalized() * d
    mesh.update()


def shade_flat(obj):
    obj.data.polygons.foreach_set("use_smooth", [False] * len(obj.data.polygons))
    obj.data.update()


def shade_smooth(obj):
    obj.data.polygons.foreach_set("use_smooth", [True] * len(obj.data.polygons))
    obj.data.update()


def mirror_x(obj, apply=True):
    """Espelha a peça em X (usada nas partes laterais construídas só em +X)."""
    mod = obj.modifiers.new("Mirror", "MIRROR")
    mod.use_axis = (True, False, False)
    mod.use_mirror_merge = False
    if apply:
        activate(obj)
        bpy.ops.object.modifier_apply(modifier=mod.name)
    return obj


def bevel_object(obj, width=0.006, segments=1, angle=math.radians(30.0)):
    """Bevel leve por ângulo — tira a aresta 'de papel' das peças chapadas."""
    mod = obj.modifiers.new("Bevel", "BEVEL")
    mod.width = width
    mod.segments = segments
    mod.limit_method = "ANGLE"
    mod.angle_limit = angle
    mod.harden_normals = False
    activate(obj)
    bpy.ops.object.modifier_apply(modifier=mod.name)
    return obj


def solidify(obj, thickness=0.01, offset=-1.0):
    mod = obj.modifiers.new("Solidify", "SOLIDIFY")
    mod.thickness = thickness
    mod.offset = offset
    activate(obj)
    bpy.ops.object.modifier_apply(modifier=mod.name)
    return obj


def apply_transforms(obj):
    activate(obj)
    bpy.ops.object.transform_apply(location=False, rotation=True, scale=True)


def tri_count(obj):
    obj.data.calc_loop_triangles()
    return len(obj.data.loop_triangles)


# ---------------------------------------------------------------------------
# Materiais (slots por face)
# ---------------------------------------------------------------------------

def ensure_material(name, base_color, roughness=0.7, metallic=0.0):
    """Material Principled simples; o script de textura troca por nós procedurais depois."""
    mat = bpy.data.materials.get(name)
    if mat is None:
        mat = bpy.data.materials.new(name)
    mat.use_nodes = True
    bsdf = mat.node_tree.nodes.get("Principled BSDF")
    if bsdf:
        bsdf.inputs["Base Color"].default_value = (*base_color, 1.0)
        bsdf.inputs["Roughness"].default_value = roughness
        bsdf.inputs["Metallic"].default_value = metallic
    mat.diffuse_color = (*base_color, 1.0)
    return mat


def assign_material(obj, mat, predicate=None):
    """Adiciona `mat` ao objeto; se `predicate(face_center, face_normal)` for dado,
    aplica só nas faces que passarem no teste (o resto fica no slot 0)."""
    if mat.name not in [m.name for m in obj.data.materials if m]:
        obj.data.materials.append(mat)
    slot = [i for i, m in enumerate(obj.data.materials) if m and m.name == mat.name][0]
    if predicate is None:
        for poly in obj.data.polygons:
            poly.material_index = slot
        return slot
    for poly in obj.data.polygons:
        if predicate(poly.center, poly.normal):
            poly.material_index = slot
    return slot
