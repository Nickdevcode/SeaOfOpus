"""Constrói corpo e roupas: pescoço, torso, casaco, mangas, mãos, calças e botas.

Estratégia por peça:
  - Torso é um sólido (representa corpo + camisa) e serve de base para tudo.
  - Casaco é uma *casca aberta* na frente (arco parcial em vez de anel fechado) +
    Solidify. É assim que roupa se modela de verdade e é o que produz o V do peito
    com espessura visível na borda, igual à referência.
  - Membros são sweeps com parallel transport, então a bota consegue virar de
    vertical (cano) para horizontal (pé) sem torcer o perfil.
"""

import math

from mathutils import Vector

import piratelib as L
import proportions as P

COLL = None
N_TORSO = 16
FRONT = -math.pi / 2.0   # ângulo do eixo frontal no plano (X, Y): frente = -Y


# ---------------------------------------------------------------------------
# Helpers locais
# ---------------------------------------------------------------------------

def arc_profile(rx, ry_f, ry_b, n_pts, sq, gap):
    """Arco superelíptico aberto na frente, com meia-abertura `gap` (radianos).

    Vai de FRONT+gap, passando pelas costas, até FRONT+2pi-gap. Usado pelo casaco:
    variando `gap` com a altura nasce o decote em V.
    """
    exp = 2.0 / (2.0 + 6.0 * sq)
    pts = []
    span = TAU_ = (math.pi * 2.0) - 2.0 * gap
    for i in range(n_pts):
        t = FRONT + gap + span * i / (n_pts - 1)
        c, s = math.cos(t), math.sin(t)
        u = rx * math.copysign(abs(c) ** exp, c)
        v = math.copysign(abs(s) ** exp, s)
        v *= ry_f if v < 0 else ry_b
        pts.append((u, v))
    return pts


def sweep_open(points, profiles):
    """Superfície aberta (sem fechar o anel e sem tampas) — para cascas de roupa."""
    verts, rings = [], []
    for center, prof in zip(points, profiles):
        idx = []
        for u, v in prof:
            idx.append(len(verts))
            verts.append(Vector((center[0] + u, center[1] + v, center[2])))
        rings.append(idx)
    faces = []
    n = len(profiles[0])
    for a, b in zip(rings[:-1], rings[1:]):
        for j in range(n - 1):
            faces.append((a[j], a[j + 1], b[j + 1], b[j]))
    return verts, faces


def smoothstep(edge0, edge1, x):
    t = max(0.0, min(1.0, (x - edge0) / (edge1 - edge0)))
    return t * t * (3.0 - 2.0 * t)


# ---------------------------------------------------------------------------
# Torso (corpo + camisa)
# ---------------------------------------------------------------------------

def build_torso():
    """Sólido do tronco. Fica quase todo escondido pelo casaco; o que aparece é
    o peito em V (camisa) e por isso ele leva o material da camisa na frente."""
    sections = [
        {"z": P.Z_COAT_HEM - 0.02, "rx": 0.185, "ry_f": 0.140, "ry_b": 0.130, "sq": 0.30},
        {"z": P.Z_HIP,             "rx": 0.196, "ry_f": 0.146, "ry_b": 0.136, "sq": 0.32},
        {"z": P.Z_WAIST,           "rx": P.R_WAIST_X, "ry_f": P.R_WAIST_YF,
         "ry_b": P.R_WAIST_YB, "sq": 0.34},
        {"z": 1.270,               "rx": 0.206, "ry_f": 0.148, "ry_b": 0.130, "sq": 0.34},
        {"z": P.Z_CHEST,           "rx": P.R_CHEST_X, "ry_f": P.R_CHEST_YF,
         "ry_b": P.R_CHEST_YB, "sq": 0.33},
        {"z": P.Z_ARMPIT + 0.09,   "rx": 0.208, "ry_f": 0.140, "ry_b": 0.126, "sq": 0.30},
        {"z": P.Z_SHOULDER,        "rx": 0.198, "ry_f": 0.122, "ry_b": 0.114, "sq": 0.26},
        {"z": P.Z_NECK_BASE + 0.01, "rx": 0.108, "ry_f": 0.082, "ry_b": 0.080, "sq": 0.20},
    ]
    verts, faces = L.loft_z(sections, n_seg=N_TORSO)
    obj = L.make_object("Torso", verts, faces, COLL)
    L.facet(obj, amount=0.0035, scale=7.0, seed=1.0)
    L.shade_flat(obj)
    return obj


# ---------------------------------------------------------------------------
# Casaco
# ---------------------------------------------------------------------------

def coat_gap(z):
    """Meia-abertura frontal do casaco em função da altura.

    Fechado (fresta fina) até o esterno, abrindo rápido em direção ao colarinho —
    é o V generoso que a referência mostra, com a camisa aparecendo por baixo.
    """
    # 26° no colarinho abre ~0.19 m — as lapelas cobrem as bordas e sobra a faixa
    # de camisa estreita da referência. Com mais que isso o peito fica nu demais.
    return math.radians(2.0) + math.radians(26.0) * smoothstep(1.250, P.Z_SHOULDER + 0.01, z)


def build_coat():
    """Casca do casaco: gola até a barra, alargando nas abas do quadril."""
    profile_pts = 21
    rows = [
        # (z, rx, ry_f, ry_b, sq)
        (P.Z_NECK_BASE + 0.005, 0.130, 0.098, 0.096, 0.22),
        (P.Z_SHOULDER,          0.214, 0.132, 0.124, 0.28),
        (P.Z_ARMPIT + 0.09,     0.222, 0.152, 0.138, 0.31),
        (P.Z_CHEST,             0.224, 0.160, 0.142, 0.33),
        (1.270,                 0.216, 0.157, 0.139, 0.34),
        (P.Z_WAIST,             0.206, 0.152, 0.135, 0.34),
        (P.Z_SASH_TOP + 0.008,  0.212, 0.154, 0.140, 0.34),
        (P.Z_BELT_TOP,          0.234, 0.168, 0.152, 0.34),
        (P.Z_HIP,               0.264, 0.188, 0.172, 0.34),
        (P.Z_SASH_BOT,          0.274, 0.196, 0.180, 0.33),
        (P.Z_COAT_HEM,          0.276, 0.198, 0.184, 0.32),
    ]
    points, profiles = [], []
    for z, rx, ry_f, ry_b, sq in rows:
        points.append((0.0, 0.0, z))
        profiles.append(arc_profile(rx, ry_f, ry_b, profile_pts, sq, coat_gap(z)))
    verts, faces = sweep_open(points, profiles)
    obj = L.make_object("Coat", verts, faces, COLL)
    L.solidify(obj, thickness=0.018, offset=0.0)
    L.facet(obj, amount=0.004, scale=6.5, seed=2.0)
    L.shade_flat(obj)
    return obj


def build_collar():
    """Gola alta virada, atrás e nas laterais do pescoço."""
    profile_pts = 15
    # Sobe até quase a mandíbula: na referência a gola engole o pescoço e é o
    # que assenta a cabeça nos ombros em vez de deixá-la "flutuando".
    rows = [
        (P.Z_NECK_BASE - 0.010, 0.132, 0.102, 0.102, 0.20, math.radians(44.0)),
        (P.Z_NECK_BASE + 0.040, 0.130, 0.104, 0.108, 0.20, math.radians(48.0)),
        (P.Z_NECK_TOP + 0.008,  0.122, 0.100, 0.114, 0.20, math.radians(56.0)),
        (P.Z_CHIN + 0.006,      0.114, 0.094, 0.116, 0.20, math.radians(64.0)),
    ]
    points, profiles = [], []
    for z, rx, ry_f, ry_b, sq, gap in rows:
        points.append((0.0, 0.0, z))
        profiles.append(arc_profile(rx, ry_f, ry_b, profile_pts, sq, gap))
    verts, faces = sweep_open(points, profiles)
    obj = L.make_object("Coat_Collar", verts, faces, COLL)
    L.solidify(obj, thickness=0.016, offset=0.0)
    L.facet(obj, amount=0.003, scale=8.0, seed=3.0)
    L.shade_flat(obj)
    return obj


def build_lapel():
    """Lapela: painel ao longo da borda do V, virado para fora (só +X, espelha depois)."""
    outline = [
        (0.036, -0.152, P.Z_NECK_BASE + 0.014),
        (0.112, -0.132, P.Z_NECK_BASE + 0.004),
        (0.148, -0.108, P.Z_SHOULDER - 0.062),
        (0.126, -0.140, 1.330),
        (0.080, -0.158, 1.284),
        (0.034, -0.160, 1.258),
    ]
    obj = L.make_plate("Coat_Lapel", outline, 0.020, COLL, axis=Vector((0.35, -0.9, 0.0)))
    L.mirror_x(obj)
    L.facet(obj, amount=0.0022, scale=10.0, seed=4.0)
    L.shade_flat(obj)
    return obj


def build_coat_front_flap():
    """Sobreposição diagonal do casaco abaixo do decote (o 'transpasse')."""
    outline = [
        (-0.070, -0.150, 1.268),
        (0.115, -0.132, 1.242),
        (0.150, -0.120, 1.150),
        (0.140, -0.118, P.Z_SASH_TOP + 0.004),
        (-0.130, -0.130, P.Z_SASH_TOP + 0.004),
        (-0.150, -0.128, 1.180),
    ]
    obj = L.make_plate("Coat_Flap", outline, 0.016, COLL, axis=Vector((0.0, -1.0, 0.12)))
    L.facet(obj, amount=0.0022, scale=10.0, seed=5.0)
    L.shade_flat(obj)
    return obj


def build_epaulette():
    """Aba do ombro (só +X, espelha depois)."""
    outline = [
        (0.080, -0.120, P.Z_SHOULDER + 0.014),
        (0.232, -0.092, P.Z_SHOULDER - 0.026),
        (0.250, 0.000, P.Z_SHOULDER - 0.036),
        (0.230, 0.096, P.Z_SHOULDER - 0.028),
        (0.082, 0.116, P.Z_SHOULDER + 0.010),
        (0.066, 0.000, P.Z_SHOULDER + 0.028),
    ]
    obj = L.make_plate("Coat_Epaulette", outline, 0.022, COLL, axis=Vector((0.18, 0.0, 1.0)))
    L.mirror_x(obj)
    L.facet(obj, amount=0.0022, scale=10.0, seed=6.0)
    L.shade_flat(obj)
    return obj


# ---------------------------------------------------------------------------
# Pescoço
# ---------------------------------------------------------------------------

def build_neck():
    sections = [
        {"z": P.Z_NECK_BASE - 0.055, "rx": 0.090, "ry": 0.082, "sq": 0.22},
        {"z": P.Z_NECK_BASE,         "rx": 0.072, "ry": 0.070, "sq": 0.20},
        {"z": P.Z_NECK_TOP,          "rx": P.R_NECK, "ry": 0.060, "sq": 0.15},
        {"z": P.Z_CHIN + 0.012,      "rx": 0.070, "ry": 0.070, "sq": 0.15},
    ]
    verts, faces = L.loft_z(sections, n_seg=10)
    obj = L.make_object("Neck", verts, faces, COLL)
    L.facet(obj, amount=0.002, scale=12.0, seed=7.0)
    L.shade_flat(obj)
    return obj


# ---------------------------------------------------------------------------
# Braço (manga do casaco)
# ---------------------------------------------------------------------------

def build_sleeve():
    """Manga do ombro ao punho, em T-pose ao longo de +X.

    O caminho desce levemente e recua em Y para o braço não sair 'grudado' no
    torso; os raios reproduzem a manga larga no deltoide, afinando no antebraço
    e alargando de novo no punho dobrado.
    """
    y0 = 0.004
    path = [
        (0.140, y0, P.Z_SHOULDER_PIVOT + 0.034),
        (P.X_SHOULDER, y0, P.Z_SHOULDER_PIVOT + 0.016),
        (0.330, y0, P.Z_SHOULDER_PIVOT + 0.002),
        (0.420, y0, P.Z_SHOULDER_PIVOT - 0.005),
        (P.X_ELBOW, y0, P.Z_SHOULDER_PIVOT - 0.011),
        (0.578, y0, P.Z_SHOULDER_PIVOT - 0.016),
        (0.640, y0, P.Z_SHOULDER_PIVOT - 0.019),
        (0.664, y0, P.Z_SHOULDER_PIVOT - 0.020),
        (0.706, y0, P.Z_SHOULDER_PIVOT - 0.022),
        (0.730, y0, P.Z_SHOULDER_PIVOT - 0.023),
        (P.X_WRIST, y0, P.Z_SHOULDER_PIVOT - 0.024),
    ]
    radii = [
        (0.078, 0.084),   # raiz no torso
        (P.R_DELTOID, P.R_DELTOID + 0.004),
        (P.R_UPPERARM + 0.008, P.R_UPPERARM + 0.010),
        (P.R_UPPERARM, P.R_UPPERARM + 0.002),
        (P.R_ELBOW + 0.002, P.R_ELBOW + 0.004),
        (P.R_FOREARM + 0.002, P.R_FOREARM + 0.004),
        (P.R_FOREARM + 0.007, P.R_FOREARM + 0.009),   # braçadeira de couro
        (P.R_FOREARM + 0.006, P.R_FOREARM + 0.008),
        (P.R_FOREARM - 0.002, P.R_FOREARM),
        (P.R_CUFF, P.R_CUFF + 0.002),                  # punho dobrado
        (P.R_CUFF - 0.004, P.R_CUFF - 0.002),
    ]
    profiles = [L.superellipse(a, b, 10, 0.22) for a, b in radii]
    verts, faces = L.sweep(path, profiles, cap_start=True, cap_end=True,
                           up_hint=Vector((0, 0, 1)))
    obj = L.make_object("Sleeve", verts, faces, COLL)
    L.mirror_x(obj)
    L.facet(obj, amount=0.0028, scale=9.0, seed=8.0)
    L.shade_flat(obj)
    return obj


# ---------------------------------------------------------------------------
# Mão
# ---------------------------------------------------------------------------

def build_hand():
    """Palma + 4 dedos + polegar, construída em +X e espelhada.

    Dedos separados custam pouco em low-poly e são o que permite um rig de mão
    de verdade depois.
    """
    parts = []
    x0 = P.X_WRIST - 0.012
    zc = P.Z_SHOULDER_PIVOT - 0.024
    palm_path = [
        (x0, 0.0, zc),
        (x0 + 0.020, -0.002, zc - 0.001),
        (x0 + 0.044, -0.004, zc - 0.002),
        (x0 + P.HAND_LEN, -0.005, zc - 0.004),
    ]
    palm_profiles = [
        L.superellipse(P.HAND_T * 0.50, P.HAND_W * 0.42, 8, 0.55),
        L.superellipse(P.HAND_T * 0.54, P.HAND_W * 0.52, 8, 0.62),
        L.superellipse(P.HAND_T * 0.52, P.HAND_W * 0.54, 8, 0.64),
        L.superellipse(P.HAND_T * 0.44, P.HAND_W * 0.50, 8, 0.64),
    ]
    verts, faces = L.sweep(palm_path, palm_profiles, up_hint=Vector((0, 0, 1)))
    parts.append(L.make_object("Hand_Palm", verts, faces, COLL))

    # Quatro dedos, levemente abertos em leque a partir da borda da palma.
    finger_x = x0 + P.HAND_LEN - 0.005
    spread = [-0.0225, -0.0075, 0.0075, 0.0215]
    lengths = [0.042, 0.049, 0.046, 0.038]
    for i, (dy, flen) in enumerate(zip(spread, lengths)):
        path = [
            (finger_x, dy, zc - 0.004),
            (finger_x + flen * 0.45, dy * 1.10, zc - 0.005),
            (finger_x + flen * 0.80, dy * 1.18, zc - 0.007),
            (finger_x + flen, dy * 1.22, zc - 0.009),
        ]
        r = P.FINGER_R
        profiles = [
            L.superellipse(r, r * 0.95, 6, 0.35),
            L.superellipse(r * 0.94, r * 0.90, 6, 0.35),
            L.superellipse(r * 0.84, r * 0.80, 6, 0.35),
            L.superellipse(r * 0.62, r * 0.58, 6, 0.35),
        ]
        v, f = L.sweep(path, profiles, up_hint=Vector((0, 0, 1)))
        parts.append(L.make_object(f"Hand_Finger_{i}", v, f, COLL))

    # Polegar: sai da lateral frontal da palma, apontando para -Y e um pouco +X.
    thumb_path = [
        (x0 + 0.016, -0.020, zc),
        (x0 + 0.032, -0.033, zc - 0.002),
        (x0 + 0.048, -0.042, zc - 0.004),
        (x0 + 0.060, -0.047, zc - 0.006),
    ]
    tr = P.FINGER_R * 1.16
    thumb_profiles = [
        L.superellipse(tr, tr * 0.95, 6, 0.40),
        L.superellipse(tr * 0.95, tr * 0.90, 6, 0.40),
        L.superellipse(tr * 0.82, tr * 0.78, 6, 0.40),
        L.superellipse(tr * 0.58, tr * 0.55, 6, 0.40),
    ]
    v, f = L.sweep(thumb_path, thumb_profiles, up_hint=Vector((0, 0, 1)))
    parts.append(L.make_object("Hand_Thumb", v, f, COLL))

    L.deselect_all()
    for p in parts:
        p.select_set(True)
    import bpy
    bpy.context.view_layer.objects.active = parts[0]
    bpy.ops.object.join()
    hand = bpy.context.view_layer.objects.active
    hand.name = "Hand"
    hand.data.name = "Hand"
    L.mirror_x(hand)
    L.facet(hand, amount=0.0012, scale=18.0, seed=9.0)
    L.shade_flat(hand)
    return hand


# ---------------------------------------------------------------------------
# Perna (calça)
# ---------------------------------------------------------------------------

def build_pants():
    """Calça do quadril até entrar na bota, com a perna abrindo para fora."""
    path = [
        (P.X_HIP - 0.010, 0.006, P.Z_HIP + 0.030),
        (P.X_HIP, 0.004, P.Z_CROTCH),
        (P.X_HIP + 0.018, 0.002, P.Z_THIGH),
        (P.X_KNEE - 0.010, 0.000, P.Z_KNEE + 0.055),
        (P.X_KNEE, -0.002, P.Z_KNEE),
        (P.X_KNEE + 0.008, -0.002, P.Z_BOOT_CUFF_TOP - 0.055),
        (P.X_KNEE + 0.014, -0.002, 0.375),
    ]
    radii = [
        P.R_THIGH_TOP + 0.008,
        P.R_THIGH_TOP,
        P.R_THIGH,
        P.R_KNEE + 0.006,
        P.R_KNEE,
        P.R_CALF,
        P.R_CALF - 0.004,
    ]
    profiles = [L.superellipse(r, r * 0.94, 10, 0.28) for r in radii]
    verts, faces = L.sweep(path, profiles, up_hint=Vector((0, 0, 1)))
    obj = L.make_object("Pants", verts, faces, COLL)
    L.mirror_x(obj)
    L.facet(obj, amount=0.0032, scale=8.0, seed=10.0)
    L.shade_flat(obj)
    return obj


# ---------------------------------------------------------------------------
# Bota
# ---------------------------------------------------------------------------

def build_boot():
    """Cano + dobra larga + pé, num único sweep em L.

    O parallel transport da lib é o que deixa isso funcionar: o perfil acompanha
    a virada de vertical para horizontal no tornozelo sem torcer.
    """
    x = P.X_ANKLE
    xk = P.X_KNEE + 0.014
    # A dobra larga do cano (z 0.34-0.48) é um marco da referência, então ela
    # ganha anéis próprios com salto de raio em vez de virar uma transição suave.
    path = [
        (xk, -0.002, P.Z_BOOT_CUFF_TOP),
        (xk + 0.002, -0.002, P.Z_BOOT_CUFF_TOP - 0.022),
        (xk + 0.003, -0.002, P.Z_BOOT_CUFF_TOP - 0.070),
        (xk + 0.004, -0.002, 0.348),
        (xk + 0.005, -0.002, 0.336),
        (x - 0.008, 0.000, 0.290),
        (x, 0.004, 0.195),
        (x, 0.006, P.Z_ANKLE),
        (x, -0.010, 0.062),
        (x, -0.070, 0.040),
        (x, -0.135, 0.034),
        (x, P.FOOT_TOE_Y + 0.020, 0.036),
        (x, P.FOOT_TOE_Y, 0.042),
    ]
    # (largura em X, "altura" local) — o segundo raio vira vertical no cano e
    # horizontal no pé, por causa do transporte do frame.
    radii = [
        (P.R_BOOT_CUFF, P.R_BOOT_CUFF * 0.94),
        (P.R_BOOT_CUFF + 0.008, P.R_BOOT_CUFF * 1.00),
        (P.R_BOOT_CUFF + 0.010, P.R_BOOT_CUFF * 1.02),
        (P.R_BOOT_CUFF + 0.004, P.R_BOOT_CUFF * 0.96),
        (P.R_BOOT_SHAFT - 0.002, P.R_BOOT_SHAFT * 0.94),   # degrau da dobra
        (P.R_BOOT_SHAFT - 0.006, P.R_BOOT_SHAFT * 0.90),
        (P.R_ANKLE + 0.008, P.R_ANKLE * 1.04),
        (P.R_ANKLE, P.R_ANKLE * 0.96),
        (P.R_ANKLE + 0.002, 0.062),
        (P.FOOT_W * 0.50, 0.046),
        (P.FOOT_W * 0.52, 0.040),
        (P.FOOT_W * 0.46, 0.034),
        (P.FOOT_W * 0.30, 0.024),
    ]
    profiles = [L.superellipse(a, b, 10, 0.42) for a, b in radii]
    verts, faces = L.sweep(path, profiles, up_hint=Vector((0, 0, 1)))
    obj = L.make_object("Boot", verts, faces, COLL)

    # Sola: placa fina sob o pé, ligeiramente maior que a bota.
    sole = L.make_box(
        "Boot_Sole",
        (x, -0.058, 0.016),
        (P.FOOT_W + 0.014, 0.300, 0.032),
        sq=0.72, bevel=0.35, collection=COLL,
    )
    # Salto, atrás.
    heel = L.make_box(
        "Boot_Heel",
        (x, 0.062, 0.018),
        (P.FOOT_W * 0.92, 0.090, 0.036),
        sq=0.8, bevel=0.2, collection=COLL,
    )
    import bpy
    L.deselect_all()
    for p in (obj, sole, heel):
        p.select_set(True)
    bpy.context.view_layer.objects.active = obj
    bpy.ops.object.join()
    boot = bpy.context.view_layer.objects.active
    boot.name = "Boot"
    boot.data.name = "Boot"
    L.mirror_x(boot)
    L.facet(boot, amount=0.0030, scale=9.0, seed=11.0)
    L.shade_flat(boot)
    return boot


# ---------------------------------------------------------------------------
# Entrada
# ---------------------------------------------------------------------------

def run():
    global COLL
    L.purge_scene()
    COLL = L.get_collection("Pirate")
    built = {
        "Torso": build_torso(),
        "Neck": build_neck(),
        "Coat": build_coat(),
        "Coat_Collar": build_collar(),
        "Coat_Lapel": build_lapel(),
        "Coat_Flap": build_coat_front_flap(),
        "Coat_Epaulette": build_epaulette(),
        "Sleeve": build_sleeve(),
        "Hand": build_hand(),
        "Pants": build_pants(),
        "Boot": build_boot(),
    }
    return {name: L.tri_count(obj) for name, obj in built.items()}
