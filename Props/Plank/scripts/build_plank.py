"""Constrói a malha da tábua de reparo.

A peça é um *sweep*: quinze seções transversais posicionadas ao longo do
comprimento e costuradas com quads, exatamente como as peças do personagem
(`piratelib.sweep`). Reusar o mesmo motor não é economia de código — é o que
garante que a tábua tenha a mesma gramática de topologia do resto do projeto:
quads no corpo, triângulos só nas tampas, zero n-gon.

**O que impede isto de virar um cubo esticado**, em ordem de importância visual:

  1. a meia-largura *ondula* ao longo da peça (±4 mm) — a aresta longa serpenteia;
  2. as duas pontas são cortadas em **plano enviesado**, com ângulos diferentes;
  3. as quatro arestas longas têm chanfro de 4 mm, e o topo tem bisel;
  4. a tábua empena no comprimento (*bow*) e encana na largura (*cup*);
  5. `piratelib.facet` empurra cada vértice pela normal com ruído coerente.

Nenhuma dessas cinco custa triângulo: todas moram nos vértices que a topologia já
precisava ter.
"""

import math
import os
import sys

import bpy
from mathutils import Vector, noise

#: Os scripts do personagem entram no caminho para dar acesso ao `piratelib`, o
#: motor de sweep/facetamento do projeto. É um acoplamento consciente e anotado
#: no README: quando chegar o terceiro prop, a lib sobe para um lugar comum em
#: vez de morar dentro da pasta de um asset.
_HERE = os.path.dirname(os.path.abspath(__file__))
_PIRATE_SCRIPTS = os.path.normpath(
    os.path.join(_HERE, "..", "..", "..", "PirateCharacter", "scripts")
)
for _path in (_HERE, _PIRATE_SCRIPTS):
    if _path not in sys.path:
        sys.path.insert(0, _path)

if not os.path.isdir(_PIRATE_SCRIPTS):
    raise RuntimeError(
        f"piratelib não encontrado em {_PIRATE_SCRIPTS!r}. A tábua reusa o motor de "
        "sweep do personagem; se a pasta mudou de lugar, ajuste _PIRATE_SCRIPTS."
    )

import piratelib as L  # noqa: E402
import plank_spec as S  # noqa: E402

COLLECTION = "Plank"
MESH_NAME = "SM_Plank"


# ---------------------------------------------------------------------------
# Seção transversal
# ---------------------------------------------------------------------------

def section(half_width, half_thickness, chamfer, cup):
    """Perfil da tábua no plano (u = largura, v = espessura).

    Dezesseis pontos, distribuídos assim:

        7   6   5   4   3        <- face de cima (5 pts, com barriga do cup)
      8                   2      <- chanfro
      9                   1      <- face estreita (topo lateral)
     10                   0      <- chanfro
       11  12  13  14  15        <- face de baixo (5 pts)

    Os cinco pontos nas faces largas existem para o *cup* ter onde acontecer e
    para o quad ficar quase quadrado (0,055 × 0,082 m), que é o que o `facet` e o
    bake pedem. As faces estreitas ganham um ponto no meio pelo mesmo motivo.

    O cup desloca as **duas** faces para o mesmo lado — é assim que madeira
    encana de verdade; mover só uma seria afinar a peça no meio.
    """
    inner_w = half_width - chamfer
    inner_t = half_thickness - chamfer

    def cup_offset(s):
        """Barriga parabólica, nula nos cantos (s = ±1) e máxima no meio."""
        return cup * (1.0 - s * s)

    pts = []
    # Face de baixo, da direita para a esquerda seria anti-horário; começamos na
    # direita-baixo para o anel sair no mesmo sentido em todas as estações.
    steps = 4
    bottom = []
    for i in range(steps + 1):
        s = -1.0 + 2.0 * i / steps
        bottom.append((inner_w * s, -half_thickness + cup_offset(s)))
    top = []
    for i in range(steps + 1):
        s = 1.0 - 2.0 * i / steps
        top.append((inner_w * s, half_thickness + cup_offset(s)))

    pts.extend(bottom)                                   # 0..4   (esq -> dir)
    pts.append((half_width, -inner_t + cup_offset(1.0)))  # 5   chanfro dir-baixo
    pts.append((half_width, 0.0 + cup_offset(1.0)))       # 6   meio da face estreita
    pts.append((half_width, inner_t + cup_offset(1.0)))   # 7   chanfro dir-cima
    pts.extend(top)                                       # 8..12  (dir -> esq)
    pts.append((-half_width, inner_t + cup_offset(-1.0)))  # 13
    pts.append((-half_width, 0.0 + cup_offset(-1.0)))      # 14
    pts.append((-half_width, -inner_t + cup_offset(-1.0)))  # 15
    return pts


# ---------------------------------------------------------------------------
# Variação ao longo do comprimento
# ---------------------------------------------------------------------------

def _wobble(t, seed, octaves=2):
    """Ruído 1D coerente em -1..1, para a ondulação da aresta.

    `noise.noise` do Blender é determinístico pela posição, então a mesma
    semente sempre reconstrói a mesma tábua — o build continua idempotente.
    """
    value = 0.0
    amplitude = 1.0
    total = 0.0
    frequency = 3.0
    for _ in range(octaves):
        value += noise.noise(Vector((t * frequency, seed, seed * 0.37))) * amplitude
        total += amplitude
        amplitude *= 0.5
        frequency *= 2.3
    return value / total


def stations():
    """Devolve (pontos do caminho, perfis, frames) prontos para o `sweep`."""
    points, profiles, frames = [], [], []
    for t in S.STATIONS:
        # Conicidade: a tábua afina de uma ponta para a outra.
        taper = 1.0 - S.TAPER * t
        # Ondulação: é ela que tira a aresta longa da linha reta.
        hw = S.HALF_WIDTH * taper + S.WIDTH_WOBBLE * _wobble(t, 11.3)
        ht = S.HALF_THICKNESS * taper + S.THICK_WOBBLE * _wobble(t, 29.7)
        # Cup muda de intensidade (e de sinal) ao longo da peça — tábua não
        # encana igual do começo ao fim.
        cup = S.CUP * _wobble(t, 47.1, octaves=1)
        # O bisel do topo: só os dois anéis das extremidades recuam.
        if t <= 0.0 or t >= 1.0:
            hw -= S.END_BEVEL
            ht -= S.END_BEVEL

        profiles.append(section(hw, ht, S.CHAMFER, cup))

        x = (t - 0.5) * S.LENGTH
        # Empeno: a peça sobe no meio. Meia onda de seno, zero nas pontas.
        z = S.BOW * math.sin(math.pi * t)
        points.append(Vector((x, 0.0, z)))

        # Torção em torno do próprio comprimento. Os frames vão fixos (e não pelo
        # `path_frames`): o empeno é de 6 mm em 1,15 m, e deixar o transporte
        # paralelo girar o perfil por causa disso introduziria uma rotação que a
        # madeira não tem. Aqui a única rotação é a que se pede.
        angle = S.TWIST * (t - 0.5)
        u = Vector((0.0, math.cos(angle), math.sin(angle)))
        v = Vector((0.0, -math.sin(angle), math.cos(angle)))
        frames.append((u, v, Vector((1.0, 0.0, 0.0))))

    return points, profiles, frames


# ---------------------------------------------------------------------------
# Pontas
# ---------------------------------------------------------------------------

def skew_ends(verts):
    """Corta as duas pontas em plano enviesado, com ângulos diferentes.

    Serrote de bordo não faz esquadro, e o render oficial do jogo mostra
    exatamente isso: topo em ângulo, corte limpo mas torto.

    O anel de topo é identificado por posição, e a identificação é **exata**: só
    ele está em |x| = HALF_LENGTH, porque o perfil só contribui em Y e Z (os
    frames não têm componente X). O centroide da tampa cai ali também, por ser a
    média do anel.

    ⚠️ **O bisel tem de vir junto.** A primeira versão movia só o anel de topo, e
    o resultado tinha um defeito de verdade: o desvio chega a 30 mm na largura,
    enquanto o anel do bisel fica a 13 mm da ponta. O canto mais recuado do topo
    passava **para trás** do bisel, a face virava do avesso e aparecia um degrau
    de fatia arrancada na quina — visível no render de topo e no wireframe.
    Serrote corta um plano, não um anel: agora os dois anéis da ponta andam
    juntos e o bisel continua com largura constante em toda a volta.

    Depois de inclinar, cada ponta é recuada até o vértice mais avançado voltar a
    encostar em ±HALF_LENGTH. Assim `LENGTH` continua sendo a medida da peça, e
    não uma média que ninguém consegue conferir com uma trena.
    """
    eps = 1e-6
    # Fronteira da "zona de topo": tudo além do penúltimo anel anda junto.
    zone = (S.STATIONS[-2] - 0.5) * S.LENGTH - eps
    for sign, index in ((-1.0, 0), (1.0, 1)):
        tip = sign * S.HALF_LENGTH
        yaw = math.tan(S.END_SKEW_YAW[index])
        pitch = math.tan(S.END_SKEW_PITCH[index])

        def shift_of(v):
            crooked = noise.noise(Vector((v.y * 21.0, v.z * 21.0, index * 5.0)))
            return v.y * yaw + v.z * pitch + crooked * S.END_CROOKED

        block = [v for v in verts if v.x * sign >= zone]
        ring = [v for v in block if abs(v.x - tip) < eps]
        if not ring:
            continue
        # O recuo sai só do anel de topo: é ele que define onde a peça acaba.
        bias = max(shift_of(v) for v in ring) if sign > 0 else \
            min(shift_of(v) for v in ring)
        for v in block:
            v.x += shift_of(v) - bias
    return verts


# ---------------------------------------------------------------------------
# Build
# ---------------------------------------------------------------------------

def build():
    """Constrói a tábua e devolve o objeto. Limpa a cena antes — idempotente."""
    L.purge_scene()
    coll = L.get_collection(COLLECTION)

    points, profiles, frames = stations()
    verts, faces = L.sweep(points, profiles, cap_start=True, cap_end=True,
                           frames=frames)
    skew_ends(verts)

    obj = L.make_object(MESH_NAME, verts, faces, coll)
    L.facet(obj, amount=S.FACET_AMOUNT, scale=S.FACET_SCALE, seed=S.FACET_SEED)
    L.shade_flat(obj)

    # Origem no centro geométrico: é o ponto de equilíbrio da peça, o que a mão
    # segura e o que a física vai usar como centro de massa quando a tábua for
    # solta no convés. Uma origem numa ponta faria a tábua orbitar o punho.
    _center_origin(obj)
    L.apply_transforms(obj)
    return obj


def _center_origin(obj):
    """Move a malha para que o centro da caixa envolvente caia na origem.

    Feito nos dados e não com `origin_set`: o operador depende de contexto (área
    3D ativa, seleção) e em `--background` ele já falhou em silêncio antes.
    """
    mesh = obj.data
    xs = [v.co.x for v in mesh.vertices]
    ys = [v.co.y for v in mesh.vertices]
    zs = [v.co.z for v in mesh.vertices]
    offset = Vector(((min(xs) + max(xs)) / 2.0,
                     (min(ys) + max(ys)) / 2.0,
                     (min(zs) + max(zs)) / 2.0))
    for v in mesh.vertices:
        v.co -= offset
    mesh.update()
    obj.location = (0.0, 0.0, 0.0)


def report(obj=None):
    """Números de conferência da malha — os mesmos que o README publica."""
    obj = obj or bpy.data.objects[MESH_NAME]
    mesh = obj.data
    mesh.calc_loop_triangles()
    quads = sum(1 for p in mesh.polygons if len(p.vertices) == 4)
    tris = sum(1 for p in mesh.polygons if len(p.vertices) == 3)
    ngons = sum(1 for p in mesh.polygons if len(p.vertices) > 4)
    xs = [v.co.x for v in mesh.vertices]
    ys = [v.co.y for v in mesh.vertices]
    zs = [v.co.z for v in mesh.vertices]

    # ⚠️ A caixa envolvente **não** é a espessura da peça: o empeno de 6 mm
    # levanta o meio da tábua, e a caixa soma isso à espessura. Quem quiser a
    # medida de trena (a que uma plaina veria) tem de medir seção por seção.
    local = _section_sizes(mesh)
    widths = [w for w, _ in local]
    thicknesses = [t for _, t in local]

    return {
        "tris": len(mesh.loop_triangles),
        "verts": len(mesh.vertices),
        "quads": quads,
        "tri_faces": tris,
        "ngons": ngons,
        "bbox_m": (round(max(xs) - min(xs), 4),
                   round(max(ys) - min(ys), 4),
                   round(max(zs) - min(zs), 4)),
        "width_mm": (round(min(widths) * 1000, 1), round(max(widths) * 1000, 1)),
        "thickness_mm": (round(min(thicknesses) * 1000, 1),
                         round(max(thicknesses) * 1000, 1)),
        "origin_offset_mm": (round(abs(min(xs) + max(xs)) * 500, 3),
                             round(abs(min(ys) + max(ys)) * 500, 3),
                             round(abs(min(zs) + max(zs)) * 500, 3)),
    }


def _section_sizes(mesh):
    """Largura e espessura reais, anel por anel, em metros.

    Mede **um anel de cada vez**, e não uma fatia larga: como a tábua empena, uma
    fatia de vários centímetros somaria a subida do empeno à espessura e
    devolveria uma peça mais grossa do que ela é. As pontas ficam de fora — bisel
    e corte enviesado não são medida de tábua.
    """
    out = []
    for t in S.STATIONS[2:-2]:
        target = (t - 0.5) * S.LENGTH
        # ±10 mm isola um anel: as estações do miolo estão a 53 mm umas das
        # outras, e o `facet` desloca no máximo 1,2 mm.
        ring = [v.co for v in mesh.vertices if abs(v.co.x - target) < 0.010]
        if len(ring) < 8:
            continue
        ys = [p.y for p in ring]
        zs = [p.z for p in ring]
        out.append((max(ys) - min(ys), max(zs) - min(zs)))
    return out


def run():
    obj = build()
    return report(obj)


if __name__ == "__main__":
    print(run())
