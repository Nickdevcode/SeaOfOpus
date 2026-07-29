"""Equipamento: faixa, cinto, fivela, bandoleira, bolsos, botões e tiras das botas.

É esse conjunto que dá a leitura de "pirata" e resolve a silhueta do meio do
corpo — sem ele o casaco lê como uma túnica reta.
"""

import math

import bpy
from mathutils import Vector

import piratelib as L
import proportions as P

COLL = None
FRONT = -math.pi / 2.0


# ---------------------------------------------------------------------------
# Helpers de posicionamento sobre o corpo
# ---------------------------------------------------------------------------

def surface_point(theta, rx, ry_f, ry_b, sq=0.34):
    """Ponto da seção superelíptica do tronco no ângulo `theta` (plano XY)."""
    exp = 2.0 / (2.0 + 6.0 * sq)
    c, s = math.cos(theta), math.sin(theta)
    u = rx * math.copysign(abs(c) ** exp, c)
    v = math.copysign(abs(s) ** exp, s)
    v *= ry_f if v < 0 else ry_b
    return u, v


def surface_normal(u, v, rx, ry):
    """Normal aproximada da seção (gradiente da elipse equivalente)."""
    n = Vector((u / (rx * rx), v / (ry * ry), 0.0))
    return n.normalized() if n.length > 1e-9 else Vector((0.0, -1.0, 0.0))


def oriented_box(name, size, position, yaw, sq=0.8, bevel=0.25):
    """Cria uma caixa alinhada ao eixo e a gira em Z para encostar no corpo."""
    obj = L.make_box(name, (0.0, 0.0, 0.0), size, sq=sq, bevel=bevel, collection=COLL)
    rot = Vector((math.cos(yaw), math.sin(yaw), 0.0))
    for vert in obj.data.vertices:
        x, y, z = vert.co
        vert.co = Vector((
            x * rot.x - y * rot.y + position[0],
            x * rot.y + y * rot.x + position[1],
            z + position[2],
        ))
    obj.data.update()
    return obj


def ring_shell(name, rows, n_seg=20, thickness=0.014, seed=30.0, facet=0.003):
    """Peça anular (faixa/cinto): tubo aberto + Solidify."""
    sections = [{"z": z, "rx": rx, "ry_f": ry_f, "ry_b": ry_b, "sq": sq}
                for z, rx, ry_f, ry_b, sq in rows]
    verts, faces = L.loft_z(sections, n_seg=n_seg, cap_start=False, cap_end=False)
    obj = L.make_object(name, verts, faces, COLL)
    L.solidify(obj, thickness=thickness, offset=1.0)
    L.facet(obj, amount=facet, scale=8.0, seed=seed)
    L.shade_flat(obj)
    return obj


# ---------------------------------------------------------------------------
# Faixa e cinto
# ---------------------------------------------------------------------------

def build_sash():
    """Faixa de pano na cintura, mais volumosa no meio (efeito 'enrolada')."""
    rows = [
        (P.Z_SASH_BOT,        0.282, 0.202, 0.188, 0.32),
        (P.Z_SASH_BOT + 0.05, 0.286, 0.206, 0.192, 0.32),
        (1.000,               0.278, 0.200, 0.186, 0.33),
        (1.062,               0.256, 0.185, 0.172, 0.33),
        (P.Z_SASH_TOP,        0.230, 0.167, 0.156, 0.33),
    ]
    return ring_shell("Sash", rows, n_seg=20, thickness=0.016, seed=30.0, facet=0.004)


def build_sash_tail():
    """Ponta da faixa caindo na lateral do quadril."""
    rows = [
        {"z": P.Z_SASH_BOT + 0.010, "rx": 0.052, "ry": 0.030, "sq": 0.45,
         "dx": -0.212, "dy": 0.052},
        {"z": 0.800, "rx": 0.048, "ry": 0.028, "sq": 0.45, "dx": -0.220, "dy": 0.060},
        {"z": 0.742, "rx": 0.040, "ry": 0.024, "sq": 0.45, "dx": -0.228, "dy": 0.066},
        {"z": 0.700, "rx": 0.024, "ry": 0.016, "sq": 0.45, "dx": -0.232, "dy": 0.070},
    ]
    verts, faces = L.loft_z(rows, n_seg=8)
    obj = L.make_object("Sash_Tail", verts, faces, COLL)
    L.facet(obj, amount=0.003, scale=12.0, seed=31.0)
    L.shade_flat(obj)
    return obj


def build_belt():
    """Cinto de couro largo por cima da faixa — a peça mais larga do personagem."""
    rows = [
        (P.Z_BELT_BOT,        0.292, 0.210, 0.196, 0.34),
        (0.985,               0.288, 0.207, 0.193, 0.34),
        (P.Z_BELT_TOP,        0.264, 0.191, 0.178, 0.34),
    ]
    return ring_shell("Belt", rows, n_seg=20, thickness=0.016, seed=32.0, facet=0.0025)


def build_buckle():
    """Fivela retangular grande: moldura em quads + pino.

    Construída como dois contornos superelípticos (externo e interno) ligados em
    quatro faixas — nada de n-gon e sem precisar de boolean.
    """
    # y precisa ficar à frente do cinto JÁ com o Solidify (offset=1.0 empurra a
    # espessura toda para fora), senão a fivela fica engolida pelo couro.
    cx, cy, cz = 0.0, -0.238, 0.986
    rx_out, rz_out = 0.086, 0.063
    rx_in, rz_in = 0.058, 0.038
    depth = 0.019
    n = 20
    sq = 0.80

    outer = L.superellipse(rx_out, rz_out, n, sq)
    inner = L.superellipse(rx_in, rz_in, n, sq)

    verts, faces = [], []
    layers = []
    for cont, dy in ((outer, -depth / 2.0), (inner, -depth / 2.0),
                     (inner, depth / 2.0), (outer, depth / 2.0)):
        idx = []
        for u, w in cont:
            idx.append(len(verts))
            verts.append(Vector((cx + u, cy + dy, cz + w)))
        layers.append(idx)
    for a, b in zip(layers, layers[1:] + [layers[0]]):
        for j in range(n):
            k = (j + 1) % n
            faces.append((a[j], a[k], b[k], b[j]))
    frame = L.make_object("Buckle_Frame", verts, faces, COLL)

    # Pino da fivela, atravessando a moldura na horizontal.
    prong = L.make_box("Buckle_Prong", (-0.028, cy + 0.002, cz),
                       (0.086, 0.013, 0.013), sq=0.5, bevel=0.3, collection=COLL)
    # Travessa vertical onde o pino se apoia.
    bar = L.make_box("Buckle_Bar", (0.040, cy, cz),
                     (0.014, 0.017, 0.098), sq=0.6, bevel=0.2, collection=COLL)

    L.deselect_all()
    for part in (frame, prong, bar):
        part.select_set(True)
    bpy.context.view_layer.objects.active = frame
    bpy.ops.object.join()
    buckle = bpy.context.view_layer.objects.active
    buckle.name = "Buckle"
    buckle.data.name = "Buckle"
    L.shade_flat(buckle)
    return buckle


# ---------------------------------------------------------------------------
# Bandoleira
# ---------------------------------------------------------------------------

def build_baldric():
    """Bandoleira cruzada: ombro esquerdo do personagem ao quadril direito.

    O caminho dá a volta completa pelas costas para a peça ficar correta em 360°,
    com as duas pontas se encontrando sob a ombreira.
    """
    path = [
        (0.150, -0.055, 1.478),
        (0.148, -0.128, 1.428),
        (0.126, -0.168, 1.350),
        (0.086, -0.186, 1.272),
        (0.040, -0.194, 1.190),
        (-0.010, -0.196, 1.112),
        (-0.062, -0.194, 1.040),
        (-0.116, -0.186, 0.972),
        (-0.170, -0.150, 0.930),
        (-0.208, -0.060, 0.926),
        (-0.212, 0.052, 0.952),
        (-0.186, 0.132, 1.030),
        (-0.140, 0.168, 1.116),
        (-0.086, 0.180, 1.198),
        (-0.026, 0.180, 1.276),
        (0.040, 0.170, 1.348),
        (0.104, 0.140, 1.418),
        (0.146, 0.070, 1.470),
    ]
    half_w, half_t = 0.030, 0.008
    profiles = [L.superellipse(half_t, half_w, 8, 0.85) for _ in path]
    verts, faces = L.sweep(path, profiles, up_hint=Vector((0.0, -1.0, 0.0)))
    obj = L.make_object("Baldric", verts, faces, COLL)
    L.facet(obj, amount=0.0018, scale=14.0, seed=33.0)
    L.shade_flat(obj)

    # Duas fivelas quadradas na parte frontal, como na referência.
    plates = []
    for i, (pos, yaw) in enumerate((
        ((0.106, -0.190, 1.312), math.radians(-8.0)),
        ((-0.036, -0.202, 1.152), math.radians(4.0)),
    )):
        plates.append(oriented_box(f"Baldric_Buckle_{i}", (0.050, 0.014, 0.050),
                                   pos, yaw, sq=0.85, bevel=0.25))
    L.deselect_all()
    for part in [obj] + plates:
        part.select_set(True)
    bpy.context.view_layer.objects.active = obj
    bpy.ops.object.join()
    baldric = bpy.context.view_layer.objects.active
    baldric.name = "Baldric"
    baldric.data.name = "Baldric"
    L.shade_flat(baldric)
    return baldric


# ---------------------------------------------------------------------------
# Bolsos, botões e tiras
# ---------------------------------------------------------------------------

def build_pouches():
    """Abas retangulares penduradas no cinto, seguindo a curva do quadril."""
    specs = [
        # (ângulo no tronco, largura, altura, z do centro, profundidade)
        (math.radians(-52.0), 0.130, 0.116, 0.850, 0.044),
        (math.radians(-128.0), 0.130, 0.116, 0.850, 0.044),
        (math.radians(-90.0), 0.104, 0.092, 0.838, 0.038),
        (math.radians(-16.0), 0.112, 0.100, 0.858, 0.042),
        (math.radians(-164.0), 0.112, 0.100, 0.858, 0.042),
        (math.radians(150.0), 0.106, 0.094, 0.852, 0.040),
        (math.radians(30.0), 0.106, 0.094, 0.852, 0.040),
    ]
    rx, ry_f, ry_b = 0.276, 0.198, 0.184
    parts = []
    for i, (theta, w, h, z, depth) in enumerate(specs):
        u, v = surface_point(theta, rx, ry_f, ry_b)
        n = surface_normal(u, v, rx, ry_f if v < 0 else ry_b)
        pos = (u + n.x * depth * 0.35, v + n.y * depth * 0.35, z)
        yaw = math.atan2(n.y, n.x)
        parts.append(oriented_box(f"Pouch_{i}", (depth, w, h), pos, yaw,
                                  sq=0.75, bevel=0.22))
    L.deselect_all()
    for part in parts:
        part.select_set(True)
    bpy.context.view_layer.objects.active = parts[0]
    bpy.ops.object.join()
    pouches = bpy.context.view_layer.objects.active
    pouches.name = "Pouches"
    pouches.data.name = "Pouches"
    L.facet(pouches, amount=0.0018, scale=14.0, seed=34.0)
    L.shade_flat(pouches)
    return pouches


def build_buttons():
    """Botões de latão no peito e nas ombreiras."""
    specs = [
        ((-0.140, -0.196, 1.256), 0.012),
        ((-0.156, -0.190, 1.166), 0.011),
        ((0.198, -0.096, 1.462), 0.009),
        ((-0.198, -0.096, 1.462), 0.009),
    ]
    parts = []
    for i, (pos, r) in enumerate(specs):
        sections = [
            {"z": pos[2] - r * 0.5, "rx": r * 0.72, "ry": r * 0.72, "sq": 0.2,
             "dx": pos[0], "dy": pos[1] + 0.006},
            {"z": pos[2], "rx": r, "ry": r, "sq": 0.2, "dx": pos[0], "dy": pos[1]},
            {"z": pos[2] + r * 0.5, "rx": r * 0.72, "ry": r * 0.72, "sq": 0.2,
             "dx": pos[0], "dy": pos[1] + 0.006},
        ]
        verts, faces = L.loft_z(sections, n_seg=8)
        parts.append(L.make_object(f"Button_{i}", verts, faces, COLL))
    L.deselect_all()
    for part in parts:
        part.select_set(True)
    bpy.context.view_layer.objects.active = parts[0]
    bpy.ops.object.join()
    buttons = bpy.context.view_layer.objects.active
    buttons.name = "Buttons"
    buttons.data.name = "Buttons"
    L.shade_flat(buttons)
    return buttons


def build_boot_straps():
    """Tira com fivela na dobra de cada bota (só +X, espelha depois)."""
    x = P.X_KNEE + 0.014
    z = 0.412
    rows = [
        {"z": z - 0.026, "rx": P.R_BOOT_CUFF + 0.012, "ry": P.R_BOOT_CUFF + 0.012,
         "sq": 0.30, "dx": x},
        {"z": z + 0.026, "rx": P.R_BOOT_CUFF + 0.013, "ry": P.R_BOOT_CUFF + 0.013,
         "sq": 0.30, "dx": x},
    ]
    verts, faces = L.loft_z(rows, n_seg=12, cap_start=False, cap_end=False)
    strap = L.make_object("Boot_Strap", verts, faces, COLL)
    L.solidify(strap, thickness=0.010, offset=1.0)

    plate = L.make_box("Boot_StrapBuckle", (x, -(P.R_BOOT_CUFF + 0.024), z),
                       (0.046, 0.016, 0.044), sq=0.85, bevel=0.25, collection=COLL)
    L.deselect_all()
    for part in (strap, plate):
        part.select_set(True)
    bpy.context.view_layer.objects.active = strap
    bpy.ops.object.join()
    obj = bpy.context.view_layer.objects.active
    obj.name = "Boot_Strap"
    obj.data.name = "Boot_Strap"
    L.mirror_x(obj)
    L.facet(obj, amount=0.0016, scale=16.0, seed=35.0)
    L.shade_flat(obj)
    return obj


def build_arm_bands():
    """Braçadeira de couro no antebraço (só +X, espelha depois)."""
    z = P.Z_SHOULDER_PIVOT - 0.019
    rows = []
    for dx, r in ((0.628, P.R_FOREARM + 0.010), (0.676, P.R_FOREARM + 0.010)):
        rows.append({"z": z, "rx": r, "ry": r, "sq": 0.22, "dx": dx})
    # Anel ao longo de X: constrói como tubo em X usando sweep.
    path = [(0.626, 0.004, z), (0.678, 0.004, z)]
    profiles = [L.superellipse(P.R_FOREARM + 0.011, P.R_FOREARM + 0.012, 10, 0.22)
                for _ in path]
    verts, faces = L.sweep(path, profiles, cap_start=False, cap_end=False,
                           up_hint=Vector((0, 0, 1)))
    obj = L.make_object("Arm_Band", verts, faces, COLL)
    L.solidify(obj, thickness=0.008, offset=1.0)
    L.mirror_x(obj)
    L.facet(obj, amount=0.0014, scale=18.0, seed=36.0)
    L.shade_flat(obj)
    return obj


# ---------------------------------------------------------------------------
# Entrada
# ---------------------------------------------------------------------------

def run():
    global COLL
    COLL = L.get_collection("Pirate")
    built = {
        "Sash": build_sash(),
        "Sash_Tail": build_sash_tail(),
        "Belt": build_belt(),
        "Buckle": build_buckle(),
        "Baldric": build_baldric(),
        "Pouches": build_pouches(),
        "Buttons": build_buttons(),
        "Boot_Strap": build_boot_straps(),
        "Arm_Band": build_arm_bands(),
    }
    return {name: L.tri_count(obj) for name, obj in built.items()}
