"""Cabeça, feições, barba e chapéu tricórnio.

O tricórnio é a peça mais característica do personagem, então ele é modelado de
verdade (aba com raio e altura variando por ângulo, dobrada em três setores)
em vez de virar um cone com uma aba plana.
"""

import math

import bpy
from mathutils import Vector

import piratelib as L
import proportions as P

COLL = None
FRONT = -math.pi / 2.0
N_HEAD = 16


def arc(rx, ry_f, ry_b, n_pts, sq, center, half_span):
    """Arco superelíptico centrado em `center` com meia-abertura `half_span`."""
    exp = 2.0 / (2.0 + 6.0 * sq)
    pts = []
    for i in range(n_pts):
        t = center - half_span + (2.0 * half_span) * i / (n_pts - 1)
        c, s = math.cos(t), math.sin(t)
        u = rx * math.copysign(abs(c) ** exp, c)
        v = math.copysign(abs(s) ** exp, s)
        v *= ry_f if v < 0 else ry_b
        pts.append((u, v))
    return pts


def sweep_open(points, profiles):
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


def smoothstep(x):
    x = max(0.0, min(1.0, x))
    return x * x * (3.0 - 2.0 * x)


# ---------------------------------------------------------------------------
# Crânio
# ---------------------------------------------------------------------------

# Seções do crânio. Ficam no escopo do módulo porque as feições (olhos, nariz,
# boca, sobrancelhas) precisam ser ancoradas na superfície real da cabeça —
# posicionar "no olho" afunda a geometria dentro do crânio e ela some.
HEAD_SECTIONS = [
    {"z": P.Z_CHIN - 0.008, "rx": 0.040, "ry_f": 0.046, "ry_b": 0.052, "sq": 0.30},
    {"z": P.Z_CHIN + 0.014, "rx": 0.062, "ry_f": 0.070, "ry_b": 0.072, "sq": 0.36},
    {"z": 1.618,            "rx": P.R_JAW_X, "ry_f": 0.082, "ry_b": 0.088, "sq": 0.42},
    {"z": P.Z_MOUTH,        "rx": 0.084, "ry_f": 0.089, "ry_b": 0.096, "sq": 0.44},
    {"z": P.Z_NOSE,         "rx": 0.090, "ry_f": 0.093, "ry_b": 0.102, "sq": 0.44},
    {"z": P.Z_EYE,          "rx": P.R_HEAD_X, "ry_f": P.R_HEAD_YF,
     "ry_b": P.R_HEAD_YB, "sq": 0.42},
    {"z": P.Z_BROW,         "rx": P.R_CRANIUM_X, "ry_f": 0.094,
     "ry_b": P.R_HEAD_YB, "sq": 0.40},
    {"z": 1.772,            "rx": 0.082, "ry_f": 0.083, "ry_b": 0.095, "sq": 0.34},
    {"z": P.Z_HEAD_TOP,     "rx": 0.050, "ry_f": 0.052, "ry_b": 0.060, "sq": 0.28},
]


def head_profile_at(z):
    """Interpola (rx, ry_f, ry_b, sq) do crânio na altura z."""
    keys = ("rx", "ry_f", "ry_b", "sq")
    if z <= HEAD_SECTIONS[0]["z"]:
        return tuple(HEAD_SECTIONS[0][k] for k in keys)
    if z >= HEAD_SECTIONS[-1]["z"]:
        return tuple(HEAD_SECTIONS[-1][k] for k in keys)
    for a, b in zip(HEAD_SECTIONS[:-1], HEAD_SECTIONS[1:]):
        if a["z"] <= z <= b["z"]:
            t = (z - a["z"]) / (b["z"] - a["z"])
            return tuple(a[k] + (b[k] - a[k]) * t for k in keys)
    raise ValueError(z)


def face_y(x, z, offset=0.0):
    """Y da superfície frontal do crânio em (x, z), deslocado `offset` para fora.

    Inverte a parametrização da superelipse: dado x, acha o ângulo e devolve o v
    correspondente. É o que garante que a feição fique *em cima* da pele.
    """
    rx, ry_f, _ry_b, sq = head_profile_at(z)
    exp = 2.0 / (2.0 + 6.0 * sq)
    r = min(abs(x) / rx, 1.0)
    cos_t = r ** (1.0 / exp)
    sin_t = math.sqrt(max(0.0, 1.0 - cos_t * cos_t))
    return -ry_f * (sin_t ** exp) - offset


def skull_point(theta, z, offset=0.0):
    """Ponto na superfície do crânio no ângulo `theta` e altura `z`.

    `theta` é absoluto no plano XY (FRONT aponta para a face). O offset segue a
    normal da seção, então peças coladas na cabeça (barba, bigode) acompanham a
    forma em vez de flutuar.
    """
    rx, ry_f, ry_b, sq = head_profile_at(z)
    exp = 2.0 / (2.0 + 6.0 * sq)
    c, s = math.cos(theta), math.sin(theta)
    u = math.copysign(abs(c) ** exp, c)
    v = math.copysign(abs(s) ** exp, s)
    ry = ry_f if v < 0 else ry_b
    px, py = rx * u, ry * v
    n = Vector((px / (rx * rx), py / (ry * ry), 0.0))
    n = n.normalized() if n.length > 1e-9 else Vector((0.0, -1.0, 0.0))
    return Vector((px + n.x * offset, py + n.y * offset, z))


def facial_shell(name, half_span_deg, z_top_fn, z_bot_fn, offset_fn,
                 n_theta=21, n_rows=5, thickness=0.008, seed=23.0):
    """Casca colada no rosto, com borda superior e inferior variáveis por ângulo.

    É o que permite a barba seguir a linha real da mandíbula — subindo até a
    costeleta nas laterais e parando abaixo do lábio na frente — em vez de virar
    uma faixa horizontal que corta o rosto.
    """
    grid = []
    for i in range(n_theta):
        a = -1.0 + 2.0 * i / (n_theta - 1)          # -1 .. 1
        theta = FRONT + math.radians(half_span_deg) * a
        z_top, z_bot = z_top_fn(abs(a)), z_bot_fn(abs(a))
        col = []
        for j in range(n_rows):
            t = j / (n_rows - 1)
            z = z_bot + (z_top - z_bot) * t
            col.append(skull_point(theta, z, offset_fn(abs(a), t)))
        grid.append(col)

    verts, idx = [], []
    for col in grid:
        col_idx = []
        for p in col:
            col_idx.append(len(verts))
            verts.append(p)
        idx.append(col_idx)
    faces = []
    for a_col, b_col in zip(idx[:-1], idx[1:]):
        for j in range(n_rows - 1):
            faces.append((a_col[j], a_col[j + 1], b_col[j + 1], b_col[j]))

    obj = L.make_object(name, verts, faces, COLL)
    L.solidify(obj, thickness=thickness, offset=0.0)
    L.facet(obj, amount=0.0014, scale=26.0, seed=seed)
    L.shade_flat(obj)
    return obj


def build_head():
    """Crânio + face. Perfis assimétricos: a face é mais chata que o occipital."""
    verts, faces = L.loft_z(HEAD_SECTIONS, n_seg=N_HEAD)
    obj = L.make_object("Head", verts, faces, COLL)
    L.facet(obj, amount=0.0018, scale=14.0, seed=20.0)
    L.shade_flat(obj)
    return obj


def _band(xs, z_top_fn, z_bot_fn, out=0.003):
    """Contorno fechado de uma faixa horizontal grudada na face.

    Percorre `xs` na borda de cima e volta pela de baixo, tirando o Y de cada
    ponto da superfície real do crânio.
    """
    top = [(x, face_y(x, z_top_fn(x), out), z_top_fn(x)) for x in xs]
    bot = [(x, face_y(x, z_bot_fn(x), out), z_bot_fn(x)) for x in reversed(xs)]
    return top + bot


def build_nose():
    """Nariz reto e proeminente, como na referência."""
    # (z, meia-largura, projeção em -Y a partir da pele)
    spec = [
        (1.648, 0.019, 0.014),
        (1.664, 0.022, 0.026),
        (1.682, 0.021, 0.031),
        (1.700, 0.017, 0.026),
        (1.720, 0.013, 0.014),
        (1.736, 0.011, 0.005),
    ]
    sections = []
    for z, hw, proj in spec:
        y_skin = face_y(0.0, z)
        back = 0.020
        sections.append({"z": z, "rx": hw, "ry_f": proj + back, "ry_b": 0.024,
                         "sq": 0.45, "dy": y_skin + back})
    verts, faces = L.loft_z(sections, n_seg=8)
    obj = L.make_object("Nose", verts, faces, COLL)
    L.facet(obj, amount=0.0008, scale=22.0, seed=21.0)
    L.shade_flat(obj)
    return obj


def build_brow():
    """Sobrancelha grossa e marcada (só +X, espelha depois).

    Fica deliberadamente afastada do olho: quando as duas peças escuras se
    encostam, a leitura vira uma venda em vez de um rosto.
    """
    # Abaixo de ~1.731 para não ficar escondida pela aba do chapéu.
    xs = [0.011, 0.026, 0.042, 0.058, 0.070]
    tops = {0.011: 1.7285, 0.026: 1.7330, 0.042: 1.7325, 0.058: 1.7265, 0.070: 1.7185}
    outline = _band(xs, lambda x: tops[x], lambda x: tops[x] - 0.016, out=0.005)
    obj = L.make_plate("Brow", outline, 0.014, COLL, axis=Vector((0.0, -1.0, 0.0)))
    L.mirror_x(obj)
    L.shade_flat(obj)
    return obj


def build_eyes():
    """Olho em duas peças: esclera clara + íris escura por cima.

    Só a fenda escura lia como um risco; separar esclera e íris é o que dá
    direção de olhar e vida ao rosto sem custar quase nada de geometria.
    """
    xs = [0.020, 0.031, 0.043, 0.054]
    tops = {0.020: 1.7040, 0.031: 1.7072, 0.043: 1.7064, 0.054: 1.7022}
    sclera_outline = _band(xs, lambda x: tops[x], lambda x: tops[x] - 0.011, out=0.002)
    sclera = L.make_plate("Eye", sclera_outline, 0.008, COLL,
                          axis=Vector((0.0, -1.0, 0.0)))
    L.mirror_x(sclera)
    L.shade_flat(sclera)

    ix = [0.031, 0.037, 0.043]
    itops = {0.031: 1.7062, 0.037: 1.7066, 0.043: 1.7060}
    iris_outline = _band(ix, lambda x: itops[x], lambda x: itops[x] - 0.0095, out=0.005)
    iris = L.make_plate("Pupil", iris_outline, 0.006, COLL,
                        axis=Vector((0.0, -1.0, 0.0)))
    L.mirror_x(iris)
    L.shade_flat(iris)
    return sclera, iris


def build_ear():
    """Orelha simplificada, colada à lateral do crânio."""
    outline = [
        (P.R_HEAD_X - 0.010, 0.004, P.Z_EYE + 0.020),
        (P.R_HEAD_X + 0.012, 0.011, P.Z_EYE + 0.010),
        (P.R_HEAD_X + 0.015, 0.016, P.Z_EYE - 0.014),
        (P.R_HEAD_X + 0.004, 0.014, P.Z_EYE - 0.032),
        (P.R_HEAD_X - 0.012, 0.003, P.Z_EYE - 0.026),
    ]
    obj = L.make_plate("Ear", outline, 0.022, COLL, axis=Vector((1.0, 0.18, 0.0)))
    L.mirror_x(obj)
    L.facet(obj, amount=0.0008, scale=24.0, seed=22.0)
    L.shade_flat(obj)
    return obj


def build_mouth():
    """Linha da boca: placa fina e escura sob o bigode."""
    xs = [-0.030, -0.015, 0.0, 0.015, 0.030]
    z_line = P.Z_MOUTH - 0.004
    outline = _band(xs, lambda x: z_line + 0.004 - abs(x) * 0.06,
                    lambda x: z_line - 0.005 - abs(x) * 0.06, out=0.002)
    obj = L.make_plate("Mouth", outline, 0.008, COLL, axis=Vector((0.0, -1.0, 0.0)))
    L.shade_flat(obj)
    return obj


# ---------------------------------------------------------------------------
# Barba
# ---------------------------------------------------------------------------

def build_beard():
    """Barba curta contínua: para abaixo do lábio na frente e sobe até a
    costeleta nas laterais, seguindo a linha da mandíbula."""
    return facial_shell(
        "Beard",
        half_span_deg=140.0,
        z_top_fn=lambda a: 1.629 + 0.114 * (a ** 1.55),
        z_bot_fn=lambda a: 1.560 + 0.110 * (a ** 1.45),
        # Afina para as bordas e para o topo, para a barba "morrer" na pele.
        offset_fn=lambda a, t: (0.0068 - 0.0026 * a) * (1.0 - 0.30 * t),
        n_theta=25, n_rows=6, thickness=0.008, seed=23.0,
    )


def build_moustache():
    """Bigode: estreito sob o nariz e caindo nas pontas para encontrar a barba."""
    return facial_shell(
        "Moustache",
        half_span_deg=42.0,
        z_top_fn=lambda a: 1.6525 + 0.0105 * a,
        z_bot_fn=lambda a: 1.6395 + 0.0030 * a,
        offset_fn=lambda a, t: 0.0072 - 0.0018 * a,
        n_theta=13, n_rows=4, thickness=0.007, seed=25.0,
    )


def build_hair():
    """Calota de cabelo sob o chapéu — evita ver o crânio nu pela aba."""
    sections = [
        {"z": 1.712, "rx": 0.096, "ry_f": 0.099, "ry_b": 0.108, "sq": 0.42},
        {"z": 1.748, "rx": 0.095, "ry_f": 0.097, "ry_b": 0.108, "sq": 0.40},
        {"z": 1.778, "rx": 0.086, "ry_f": 0.087, "ry_b": 0.099, "sq": 0.34},
        {"z": P.Z_HEAD_TOP + 0.006, "rx": 0.054, "ry_f": 0.056, "ry_b": 0.064, "sq": 0.28},
    ]
    verts, faces = L.loft_z(sections, n_seg=N_HEAD)
    obj = L.make_object("Hair", verts, faces, COLL)
    L.facet(obj, amount=0.0014, scale=20.0, seed=26.0)
    L.shade_flat(obj)
    return obj


# ---------------------------------------------------------------------------
# Chapéu tricórnio
# ---------------------------------------------------------------------------

# Pontas da aba: duas à frente-lateral e uma atrás. Vista de frente, isso produz
# o painel central levantado com duas pontas largas nos lados — a leitura do
# tricórnio na referência.
HAT_CORNERS = [FRONT - math.radians(68.0), FRONT + math.radians(68.0),
               FRONT + math.pi]


def _sector_t(theta):
    """Posição normalizada dentro do setor: 0 numa ponta, 1 no meio da dobra."""
    best = None
    for i, a in enumerate(HAT_CORNERS):
        b = HAT_CORNERS[(i + 1) % len(HAT_CORNERS)]
        span = (b - a) % (2.0 * math.pi)
        rel = (theta - a) % (2.0 * math.pi)
        if rel <= span + 1e-9:
            t = rel / span
            d = 1.0 - abs(2.0 * t - 1.0)  # 0 nas bordas, 1 no centro
            best = d if best is None else max(best, d)
    return best if best is not None else 0.0


def build_hat():
    """Copa + aba dobrada. A aba é uma faixa cujo raio e altura variam por ângulo."""
    # --- Copa (baixa; a aba levantada é que domina a silhueta) ---
    crown_sections = [
        {"z": P.Z_HAT_BRIM - 0.034, "rx": 0.104, "ry": 0.108, "sq": 0.30},
        {"z": P.Z_HAT_BRIM + 0.012, "rx": 0.108, "ry": 0.112, "sq": 0.30},
        {"z": 1.812,                "rx": 0.107, "ry": 0.111, "sq": 0.28},
        {"z": 1.856,                "rx": 0.101, "ry": 0.105, "sq": 0.26},
        {"z": P.Z_HAT_TOP,          "rx": 0.076, "ry": 0.079, "sq": 0.22},
    ]
    verts, faces = L.loft_z(crown_sections, n_seg=14)
    crown = L.make_object("Hat_Crown", verts, faces, COLL)

    # --- Aba ---
    n_theta = 44
    n_radial = 5
    r_inner = 0.101
    z_inner = P.Z_HAT_BRIM - 0.014
    rows = []
    for k in range(n_radial):
        u = k / (n_radial - 1)          # 0 junto à copa, 1 na borda externa
        ring = []
        for i in range(n_theta):
            theta = 2.0 * math.pi * i / n_theta
            t = smoothstep(_sector_t(theta))
            # Nas dobras a aba encosta na copa (raio menor) e sobe acima dela;
            # nas pontas ela se estende ao máximo e cai para a altura da testa.
            r_outer = P.HAT_BRIM_R * (1.0 - 0.34 * t)
            z_outer = P.Z_HAT_BRIM + (P.Z_HAT_PEAK - P.Z_HAT_BRIM) * t
            r = r_inner + (r_outer - r_inner) * u
            # Curva da aba: quase plana junto à copa, subindo forte na borda.
            z = z_inner + (z_outer - z_inner) * (u ** 1.7)
            ring.append(Vector((r * math.cos(theta), r * math.sin(theta), z)))
        rows.append(ring)

    bverts, bfaces = [], []
    idx = []
    for ring in rows:
        row_idx = []
        for v in ring:
            row_idx.append(len(bverts))
            bverts.append(v)
        idx.append(row_idx)
    for a, b in zip(idx[:-1], idx[1:]):
        for j in range(n_theta):
            k = (j + 1) % n_theta
            bfaces.append((a[j], a[k], b[k], b[j]))
    brim = L.make_object("Hat_Brim", bverts, bfaces, COLL)
    L.solidify(brim, thickness=P.HAT_BRIM_T, offset=0.0)

    # --- Faixa da copa ---
    band_sections = [
        {"z": P.Z_HAT_BRIM + 0.004, "rx": 0.110, "ry": 0.114, "sq": 0.30},
        {"z": P.Z_HAT_BRIM + 0.030, "rx": 0.111, "ry": 0.115, "sq": 0.30},
    ]
    v2, f2 = L.loft_z(band_sections, n_seg=14, cap_start=False, cap_end=False)
    band = L.make_object("Hat_Band", v2, f2, COLL)
    L.solidify(band, thickness=0.006, offset=1.0)

    L.deselect_all()
    for part in (crown, brim, band):
        part.select_set(True)
    bpy.context.view_layer.objects.active = crown
    bpy.ops.object.join()
    hat = bpy.context.view_layer.objects.active
    hat.name = "Hat"
    hat.data.name = "Hat"
    L.facet(hat, amount=0.0026, scale=11.0, seed=27.0)
    L.shade_flat(hat)
    return hat


# ---------------------------------------------------------------------------
# Entrada
# ---------------------------------------------------------------------------

def run():
    global COLL
    COLL = L.get_collection("Pirate")
    sclera, iris = build_eyes()
    built = {
        "Head": build_head(),
        "Nose": build_nose(),
        "Brow": build_brow(),
        "Eye": sclera,
        "Pupil": iris,
        "Ear": build_ear(),
        "Mouth": build_mouth(),
        "Beard": build_beard(),
        "Moustache": build_moustache(),
        "Hair": build_hair(),
        "Hat": build_hat(),
    }
    return {name: L.tri_count(obj) for name, obj in built.items()}
