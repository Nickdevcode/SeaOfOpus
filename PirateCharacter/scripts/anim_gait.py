"""Motor de marcha: constrói um ciclo de locomoção a partir de uma descrição.

Caminhar e correr são a **mesma máquina com números diferentes**, e vale a pena
insistir no que essa máquina faz, porque é o oposto de posar quadro a quadro:

1. Descreve-se a trajetória do pé — onde ele está e como está inclinado a cada
   instante. Durante o apoio ela é uma reta no tempo, andando para trás na
   velocidade exata do corpo. É essa reta que impede o pé de patinar.
2. Mede-se, quadro a quadro, a altura **máxima** que o corpo pode ter sem
   arrancar o pé do chão. É um teto, não uma trajetória.
3. Traça-se a curva vertical do corpo — suave, do feitio da marcha — e rebaixa-se
   ela em bloco até caber sob o quadro mais apertado.
4. Resolve-se cada perna por IK de dois elos, e o joelho sai da lei dos cossenos.

O que muda entre andar e correr não é o método, são os parâmetros — e um deles é
estrutural: com `stance` abaixo de 0,5 existem instantes em que **nenhum** pé
está no chão, e o corpo voa. O teto some nesses quadros (perna no ar não segura
ninguém) e a curva vertical passa a ser livre ali.

A outra diferença importante é de fase, e é contraintuitiva:

| | quadril mais baixo | quadril mais alto |
|---|---|---|
| **andando** | no contato, pernas abertas | na passagem, sobre o pé |
| **correndo** | no meio do apoio, perna absorvendo | no meio do voo |

Um `bounce_phase` desloca o vale da curva e dá conta dos dois casos.

Convenções do rig (as mesmas de `pose_test.py`): o personagem olha para **-Y**,
1 unidade = 1 metro, e o chão é Z = 0.
"""

from __future__ import annotations

import math
from dataclasses import dataclass, field

import bpy
from mathutils import Matrix, Quaternion, Vector

ARMATURE_NAME = "RIG_Pirate"
MESH_NAME = "SK_Pirate"

#: Altura do chão. A malha em repouso afunda 6,3 mm (o menor Z da bota é
#: -0,00634), e as animações **não** herdam isso: a altura do tornozelo sai da
#: envoltória da sola, então a bota encosta no convés em vez de entrar nele.
FLOOR_Z = 0.0

AXES = {"X": Vector((1.0, 0.0, 0.0)),
        "Y": Vector((0.0, 1.0, 0.0)),
        "Z": Vector((0.0, 0.0, 1.0))}


@dataclass(frozen=True)
class GaitSpec:
    """Uma marcha inteira descrita em números."""

    name: str
    action_name: str

    # -- tempo e distância ----------------------------------------------------
    fps: int = 30
    #: Frames de uma passada completa (os dois pés). O último frame repete o
    #: primeiro de propósito: é ele que fecha o laço sem engasgo no three.js.
    cycle_frames: int = 24
    #: Comprimento de um passo, em metros.
    stride: float = 0.66
    #: Fração do ciclo em que o pé está no chão. Andando fica em 0,58-0,62;
    #: abaixo de 0,50 aparece fase aérea e a marcha vira corrida.
    stance: float = 0.58

    # -- alturas --------------------------------------------------------------
    #: Quanto o pé sobe acima do chão no meio do balanço. Escolha de animador:
    #: baixo demais raspa o convés, alto demais vira marcha de ganso.
    ankle_swing_lift: float = 0.115
    #: Metade do sobe-e-desce do corpo, em metros.
    bounce_amplitude: float = 0.021
    #: Onde fica o **vale** da curva vertical, em fração do ciclo. Zero põe no
    #: contato (andar); metade do apoio põe no meio do apoio (correr).
    bounce_phase: float = 0.0
    #: Distância de cada pé à linha do meio — a largura da passada. Fixo de
    #: propósito: o pé de apoio não pode acompanhar o balanço lateral do
    #: quadril, senão varre o chão de lado.
    step_width: float = 0.175
    #: Que fração da excursão do pé fica **à frente** do quadril.
    #:
    #: Meio a meio andando. Correndo, não: pisar muito à frente do corpo é
    #: *overstriding*, e o pé vira freio a cada passo — quem corre toca o chão
    #: quase sob o quadril e faz o avanço todo para trás. Também é o que salva a
    #: geometria: a perna não alcança 0,42 m à frente sem o corpo agachar.
    foot_reach_bias: float = 0.5

    #: Velocidade com que o pé **larga** o chão, no início do balanço.
    #:
    #: Zero dá uma partida macia (é o que se quer andando). Correndo, o pé tem
    #: de recolher depressa: enquanto ele fica esticado lá atrás e o corpo já
    #: subiu no voo, a perna simplesmente **não alcança** o alvo — foi o que
    #: produziu 2,5 cm de escorregamento na primeira corrida.
    swing_launch: float = 0.0
    #: Velocidade do pé ao **chegar** no contato. Negativo faz o pé já estar
    #: recuando quando toca o chão, que é o que evita o freio a cada passo.
    swing_retract: float = 0.0
    #: Onde fica o ponto mais alto do balanço, em fração dele. Adiantar encolhe
    #: a perna cedo, que é o jeito de girar a passada rápido.
    swing_peak: float = 0.45

    # -- perna ----------------------------------------------------------------
    #: Quanto a perna pode esticar. 100% trava o joelho e denuncia a IK.
    leg_extension_limit: float = 0.985
    #: Extensão da perna de apoio no contato, no meio do apoio e no empurrão.
    #: Dobrar o joelho no meio é o que impede o corpo de saltar: como o quadril
    #: acompanha a perna, encurtá-la justo onde ele estaria mais alto achata a
    #: trajetória. É um dos determinantes clássicos da marcha.
    stance_extension: tuple[float, float, float] = (0.985, 0.945, 0.980)

    # -- ângulos do pé, em graus (positivo = ponta para baixo) ----------------
    foot_contact: float = -13.0
    foot_flat: float = 0.0
    foot_toe_off: float = 34.0
    foot_swing: float = -9.0
    #: Fração do apoio até o pé ficar plano, e a partir de onde o calcanhar sobe.
    foot_roll_in: float = 0.16
    foot_roll_out: float = 0.62

    # -- tronco ---------------------------------------------------------------
    hip_sway: float = 0.028
    pelvis_yaw: float = 6.0
    #: O quadril cai para o lado da perna que está no ar (Trendelenburg). É o
    #: detalhe que dá o gingado, e o que mais some quando se anima no olho.
    pelvis_roll: float = 4.2
    pelvis_pitch: float = 3.0
    #: Contra-torção do tronco sobre o quadril, como fração.
    torso_counter_yaw: float = 0.62
    #: Inclinação do tronco para a frente, em graus, distribuída pela coluna.
    torso_lean: float = 0.0

    # -- braços ---------------------------------------------------------------
    #: Quanto o braço desce da T-pose. Não é 90° porque o casaco e a bandoleira
    #: ocupam espaço — colado demais atravessa a manga.
    arm_drop: float = 70.0
    arm_swing: float = 21.0
    #: O braço vai mais para trás do que para a frente, como todo braço que
    #: balança.
    arm_swing_bias: float = 0.35
    elbow_min: float = 16.0
    elbow_max: float = 42.0

    @property
    def cycle_seconds(self) -> float:
        return self.cycle_frames / self.fps

    @property
    def foot_reach(self) -> float:
        """Excursão do pé à frente e atrás do quadril. Cai da conta."""
        return self.stride * self.stance

    @property
    def native_speed(self) -> float:
        """Velocidade que esta marcha anda de verdade, em m/s."""
        return 2.0 * self.stride / self.cycle_seconds

    @property
    def has_flight(self) -> bool:
        """Se há instantes com os dois pés no ar."""
        return self.stance < 0.5


# -- utilidades de curva ------------------------------------------------------


def smoothstep(t: float) -> float:
    """Interpolação com derivada nula nas pontas."""
    t = min(max(t, 0.0), 1.0)
    return t * t * (3.0 - 2.0 * t)


def ramp(value: float, start: float, end: float) -> float:
    """Posição de *value* dentro de [start, end], saturada em 0 e 1."""
    if end == start:
        return 0.0
    return min(max((value - start) / (end - start), 0.0), 1.0)


def blend(a: float, b: float, t: float) -> float:
    return a + (b - a) * smoothstep(t)


def hermite(t: float, launch: float, land: float) -> float:
    """Interpolação de 0 a 1 com as velocidades das duas pontas escolhidas.

    Com ``launch`` e ``land`` em zero, é exatamente `smoothstep`. O que as
    tangentes compram é a forma do balanço: sair rápido do chão e chegar já
    recuando são as duas coisas que distinguem a perna de quem corre da de quem
    anda em câmera rápida.
    """
    t = min(max(t, 0.0), 1.0)
    t2, t3 = t * t, t * t * t
    return ((t3 - 2.0 * t2 + t) * launch
            + (-2.0 * t3 + 3.0 * t2)
            + (t3 - t2) * land)


def rotate_x(vec: Vector, degrees: float) -> Vector:
    return Matrix.Rotation(math.radians(degrees), 3, "X") @ vec


# -- trajetória do pé ---------------------------------------------------------


def foot_plan(spec: GaitSpec, phase: float) -> tuple[float, float, float, float]:
    """Onde o pé está e como está inclinado, na fase *phase* daquela perna.

    ``phase`` = 0 é o instante do contato. Devolve ``(avanço, elevação,
    ângulo_do_pé, ângulo_dos_dedos)``: o avanço em metros à frente do quadril, a
    elevação em metros **acima do chão** (zero durante todo o apoio) e os
    ângulos em graus.

    A altura absoluta do tornozelo não sai daqui de propósito — ela depende de
    quanto o pé está inclinado, e quem resolve isso é `ankle_height`.
    """
    p = phase % 1.0
    # A excursão total é a mesma; o que o viés move é onde ela começa e acaba.
    total = 2.0 * spec.foot_reach
    front = total * spec.foot_reach_bias
    back = total - front

    if p < spec.stance:
        # Pé plantado. A posição é linear no tempo porque o corpo avança a
        # velocidade constante — é esta linha que garante que o pé não patina.
        k = p / spec.stance
        forward = front - total * k

        if k < spec.foot_roll_in:          # calcanhar rola até o pé ficar plano
            pitch = blend(spec.foot_contact, spec.foot_flat,
                          ramp(k, 0.0, spec.foot_roll_in))
        elif k < spec.foot_roll_out:       # pé plano, o corpo passa por cima
            pitch = spec.foot_flat
        else:                              # calcanhar sobe, empurra e larga
            pitch = blend(spec.foot_flat, spec.foot_toe_off,
                          ramp(k, spec.foot_roll_out, 1.0))

        # Enquanto o calcanhar sobe, os dedos continuam no chão: a dobra do
        # metatarso é exatamente o que cancela a inclinação do pé.
        toe = -pitch * ramp(k, spec.foot_roll_out, 1.0)
        return forward, 0.0, pitch, toe

    # Balanço: o pé recolhe, passa a perna de apoio e estende para o contato.
    k = (p - spec.stance) / (1.0 - spec.stance)
    forward = -back + total * hermite(k, spec.swing_launch, spec.swing_retract)

    if k < spec.swing_peak:
        lift = spec.ankle_swing_lift * smoothstep(ramp(k, 0.0, spec.swing_peak))
    else:
        lift = spec.ankle_swing_lift * (1.0 - smoothstep(ramp(k, spec.swing_peak, 1.0)))

    if k < 0.35:
        pitch = blend(spec.foot_toe_off, spec.foot_swing, ramp(k, 0.0, 0.35))
    else:
        pitch = blend(spec.foot_swing, spec.foot_contact, ramp(k, 0.35, 1.0))

    # Os dedos voltam a acompanhar o pé assim que ele deixa o chão — mas não de
    # um frame para o outro. No fim do apoio eles estão dobrados para ficar no
    # chão; zerar isso de uma vez é um estalo de dezenas de graus num frame.
    toe = -spec.foot_toe_off * (1.0 - smoothstep(ramp(k, 0.0, 0.30)))
    return forward, lift, pitch, toe


def ankle_height(profile: dict, pitch: float, toe: float, lift: float) -> float:
    """Altura do tornozelo que põe a sola exatamente no chão.

    Girar o pé em torno do tornozelo move a sola: inclinar a ponta para cima
    enterra o calcanhar, e o contrário enterra os dedos. Chutar essas alturas foi
    o que meteu a bota **1,68 cm dentro do convés** na primeira versão.

    Aqui não se chuta: reproduz-se o mesmo *linear blend skinning* que o Blender
    aplica — a posição de cada ponto é a média, pelos pesos dele, de onde o bone
    do pé o levaria e de onde o bone do dedo o levaria — e procura-se o mais
    baixo. A altura é a que faz esse ponto encostar no chão.

    Misturar os **ângulos** em vez das **posições** parece equivalente e não é:
    a média de duas posições cai por dentro do arco. Com os 34° do
    desprendimento, esse atalho ainda deixava 2 cm de bota dentro do convés.
    """
    hinge = profile["hinge"]
    lowest = float("inf")
    for point, weight in profile["points"]:
        by_foot = rotate_x(point, pitch)
        by_toe = rotate_x(hinge + rotate_x(point - hinge, toe), pitch)
        lowest = min(lowest, by_foot.z * (1.0 - weight) + by_toe.z * weight)
    return FLOOR_Z - lowest + lift


def ankle_target(spec: GaitSpec, metrics: dict, side: str, phase: float) -> Vector:
    """Onde o tornozelo daquele lado tem de estar, em coordenadas do mundo."""
    forward, lift, pitch, toe = foot_plan(spec, phase)
    sign = 1.0 if side == "L" else -1.0
    height = ankle_height(metrics[side]["sole"], pitch, toe, lift)
    # Frente é -Y neste rig, então avanço vira Y negativo.
    return Vector((sign * spec.step_width, -forward, height))


def stance_extension(spec: GaitSpec, phase: float) -> float:
    """Quanto a perna de apoio está estendida, na fase daquela perna.

    Fora do apoio devolve a extensão máxima: perna no ar não segura o corpo, e
    portanto não pode puxar o quadril para baixo.
    """
    p = phase % 1.0
    if p >= spec.stance:
        return spec.leg_extension_limit

    contact, mid, push = spec.stance_extension
    k = p / spec.stance
    if k < 0.35:                           # o peso desce sobre a perna
        return blend(contact, mid, ramp(k, 0.0, 0.35))
    return blend(mid, push, ramp(k, 0.35, 1.0))    # e a perna devolve no empurrão


# -- postura do quadril -------------------------------------------------------


def pelvis_plan(spec: GaitSpec, phase: float) -> dict[str, float]:
    """Deslocamento e rotação do quadril na fase *phase* da passada.

    ``phase`` = 0 é o contato do pé **esquerdo**.
    """
    tau = 2.0 * math.pi * phase
    return {
        "sway": math.sin(tau) * spec.hip_sway,   # peso vai para o pé que apoia
        "yaw": math.sin(tau) * spec.pelvis_yaw,
        # A queda é para o lado da perna no ar, um quarto de ciclo depois do peso.
        "roll": -math.cos(tau) * spec.pelvis_roll,
        "pitch": spec.pelvis_pitch,
    }


# -- resolução geométrica -----------------------------------------------------


def solve_leg(hip: Vector, ankle: Vector, femur: float, tibia: float,
              limit: float, knee_hint: Vector) -> Vector:
    """Posição do joelho para o quadril e o tornozelo dados.

    Dois elos de comprimento fixo com as duas pontas presas deixam o joelho
    livre num círculo; ``knee_hint`` é a direção que escolhe o ponto — para uma
    perna humana, "para a frente". Sem isso o joelho dobraria para trás na
    metade dos frames, que é o defeito clássico de IK escrita às pressas.
    """
    to_ankle = ankle - hip
    dist = to_ankle.length
    reach = (femur + tibia) * limit

    if dist > reach:                       # alvo fora de alcance: estica e para
        to_ankle = to_ankle * (reach / dist)
        dist = reach
    dist = max(dist, abs(femur - tibia) + 1e-4)

    axis = to_ankle / dist
    # Lei dos cossenos: ângulo entre o fêmur e a linha quadril-tornozelo.
    cos_alpha = (dist * dist + femur * femur - tibia * tibia) / (2.0 * dist * femur)
    alpha = math.acos(min(max(cos_alpha, -1.0), 1.0))

    # Componente do palpite perpendicular ao eixo: é para lá que o joelho aponta.
    side = knee_hint - axis * knee_hint.dot(axis)
    if side.length < 1e-5:
        side = Vector((0.0, -1.0, 0.0)) - axis * axis.y
    side.normalize()

    return hip + (axis * math.cos(alpha) + side * math.sin(alpha)) * femur


def world_rotation(pose_bone, steps) -> Quaternion:
    """Compõe rotações de eixo-do-mundo no espaço de repouso do bone.

    Idêntica à de ``pose_test.py`` — descrever pose em euler local seria refém
    do roll da armature, que muda de eixo conforme a orientação do bone.
    """
    inv = pose_bone.bone.matrix_local.to_3x3().inverted()
    quat = Quaternion((1.0, 0.0, 0.0, 0.0))
    for axis_name, degrees in steps:
        axis_local = (inv @ AXES[axis_name]).normalized()
        quat = quat @ Quaternion(axis_local, math.radians(degrees))
    return quat


def aim_bone(pose_bone, direction: Vector, head: Vector | None = None) -> None:
    """Aponta o bone na *direction* (espaço do mundo), pelo caminho mais curto.

    Trabalhar com a direção final em vez de ângulos locais evita depender do
    roll de cada bone, e é o que permite manter o pé plano no chão enquanto a
    canela gira por cima dele.
    """
    rest = pose_bone.bone.matrix_local
    rest_dir = (pose_bone.bone.tail_local - pose_bone.bone.head_local).normalized()
    delta = rest_dir.rotation_difference(direction.normalized())

    matrix = (delta.to_matrix() @ rest.to_3x3()).to_4x4()
    matrix.translation = head if head is not None else pose_bone.matrix.translation
    pose_bone.matrix = matrix


# -- medidas do rig -----------------------------------------------------------


def sole_profile(mesh, arm, side: str) -> dict:
    """Pontos da sola daquele pé, com o quanto cada um obedece ao bone do dedo.

    Uma versão anterior dividia a sola em retropé e antepé e girava cada metade
    em bloco. Errado por 2,8 cm: o vértice que mais furava o convés tinha **74%
    de peso no dedo e 26% no pé**, e portanto não gira nem como um nem como
    outro. Guardar o peso junto com o ponto reproduz a mistura que o skinning
    faz de verdade.
    """
    bones = {g.name: g.index for g in mesh.vertex_groups}
    toe_index = bones.get(f"toe.{side}")
    foot_index = bones.get(f"foot.{side}")
    if toe_index is None or foot_index is None:
        raise RuntimeError(f"grupos do pé {side} não encontrados na malha")

    ankle = arm.data.bones[f"foot.{side}"].head_local
    hinge = arm.data.bones[f"toe.{side}"].head_local - ankle
    points = []
    for vert in mesh.data.vertices:
        point = vert.co
        if abs(point.x - ankle.x) > 0.12:  # o pé do outro lado não interessa
            continue
        if point.z > ankle.z:              # acima do tornozelo nunca toca o chão
            continue

        weights = {g.group: g.weight for g in vert.groups}
        toe_w = weights.get(toe_index, 0.0)
        foot_w = weights.get(foot_index, 0.0)
        if toe_w + foot_w <= 0.0:
            continue
        points.append((Vector((0.0, point.y - ankle.y, point.z - ankle.z)),
                       toe_w / (toe_w + foot_w)))

    if not points:
        raise RuntimeError(f"sola do pé {side} não encontrada na malha")
    return {"points": points, "hinge": Vector((0.0, hinge.y, hinge.z))}


def rest_metrics(arm, mesh=None) -> dict:
    """Medidas do rig em repouso, lidas do próprio esqueleto e da malha."""
    mesh = mesh or bpy.data.objects[MESH_NAME]
    bones = arm.data.bones
    out = {}
    for side in ("L", "R"):
        thigh = bones[f"thigh.{side}"]
        calf = bones[f"calf.{side}"]
        foot = bones[f"foot.{side}"]
        toe = bones[f"toe.{side}"]
        out[side] = {
            "femur": (thigh.tail_local - thigh.head_local).length,
            "tibia": (calf.tail_local - calf.head_local).length,
            "foot_dir": (foot.tail_local - foot.head_local).normalized(),
            "toe_dir": (toe.tail_local - toe.head_local).normalized(),
            "sole": sole_profile(mesh, arm, side),
        }
    out["hip_height"] = bones["thigh.L"].head_local.z
    return out


# -- trajetória vertical do corpo ---------------------------------------------


def measure_ceilings(spec: GaitSpec, pose, metrics: dict) -> list[float]:
    """Quanto o corpo pode subir em cada frame sem arrancar o pé do chão.

    O valor é o **deslocamento do root**, não a altura do quadril, e a diferença
    entre as duas coisas já custou 7 mm de escorregamento: a queda pélvica
    levanta o quadril do lado apoiado em quase 1 cm, então pedir "quadril a tal
    altura" e mover o root por essa diferença entrega outra coisa.

    Trigonometria pura também não serve: a perna deste rig **não é vertical**
    (quadril em X = 0,118, tornozelo em X = 0,215), e essa inclinação lateral
    consome alcance. Junte o balanço lateral, a torção e a queda do quadril e a
    fórmula vira um emaranhado — mais barato posicionar o tronco e **ler** onde
    o quadril foi parar.

    A perna no ar entra na conta também, e por um motivo diferente: ela não
    *segura* o corpo, mas ainda precisa **alcançar** o pé que a trajetória
    mandou. Ignorá-la deixava o corpo subir no voo enquanto o pé de trás ainda
    estava esticado lá atrás — a IK batia no limite e o pé escorregava 2,5 cm.
    A diferença é só quanto se deixa a perna esticar: no apoio ela dobra para
    absorver, no ar vai até o limite.
    """
    ceilings = []
    for frame in range(spec.cycle_frames):
        phase = frame / spec.cycle_frames
        plan = pelvis_plan(spec, phase)

        aim_root(pose["root"], plan, 0.0)
        bpy.context.view_layer.update()
        pose_spine(spec, pose, plan)
        bpy.context.view_layer.update()

        ceiling = float("inf")
        for side, offset in (("L", 0.0), ("R", 0.5)):
            leg_phase = (phase + offset) % 1.0

            hip = pose[f"thigh.{side}"].matrix.translation
            ankle = ankle_target(spec, metrics, side, leg_phase)
            full = metrics[side]["femur"] + metrics[side]["tibia"]
            reach = full * stance_extension(spec, leg_phase)

            planar = math.hypot(hip.x - ankle.x, hip.y - ankle.y)
            vertical = math.sqrt(max(reach * reach - planar * planar, 0.0))
            ceiling = min(ceiling, (ankle.z + vertical) - hip.z)
        ceilings.append(ceiling)
    return ceilings


def plan_body_lift(spec: GaitSpec, ceilings: list[float]):
    """Trajetória vertical do corpo, como deslocamento do root.

    Uma versão anterior colava o corpo no teto quadro a quadro, e o resultado
    media **7 cm de salto em um único frame**: no fim do apoio a perna esticada
    deixava o corpo subir, e no frame seguinte o outro pé tocava o chão e exigia
    que ele descesse tudo de novo. Um degrau desses lê como tranco, não como
    passo.

    O corpo real não persegue o teto — ele descreve uma curva suave que passa
    *por baixo* dele. Aqui: uma senoide de duas subidas por passada (uma por
    perna), rebaixada até caber sob o quadro mais apertado do ciclo.
    """
    def wave(phase: float) -> float:
        return -math.cos(4.0 * math.pi * (phase - spec.bounce_phase)) \
            * spec.bounce_amplitude

    grounded = [(f, c) for f, c in enumerate(ceilings) if math.isfinite(c)]
    if not grounded:
        raise RuntimeError("nenhum quadro com pé no chão: isto não é uma marcha")

    # O maior rebaixamento exigido por qualquer instante manda no ciclo inteiro.
    base = min(c - wave(f / spec.cycle_frames) for f, c in grounded)
    return lambda phase: base + wave(phase)


# -- pose ---------------------------------------------------------------------


def aim_root(root, plan: dict, body_z: float) -> None:
    """Move o corpo inteiro: lateral, vertical e a torção do quadril."""
    matrix = Matrix.Translation(Vector((plan["sway"], 0.0, body_z)))
    matrix = matrix @ Matrix.Rotation(math.radians(plan["yaw"]), 4, "Z")
    root.matrix = matrix @ root.bone.matrix_local


def pose_spine(spec: GaitSpec, pose, plan: dict) -> None:
    """Queda lateral do quadril e a contra-torção que o tronco faz por cima."""
    pose["pelvis"].rotation_quaternion = world_rotation(
        pose["pelvis"], [("Y", plan["roll"]), ("X", plan["pitch"])])

    counter = -plan["yaw"] * spec.torso_counter_yaw
    # A inclinação para a frente é distribuída: concentrá-la num bone só faz um
    # vinco no casaco em vez de um tronco inclinado.
    for name, share, lean in (("spine_01", 0.30, -1.2),
                              ("spine_02", 0.35, -1.0),
                              ("spine_03", 0.35, -0.6)):
        pose[name].rotation_quaternion = world_rotation(
            pose[name], [("Z", counter * share),
                         ("X", lean - spec.torso_lean * share)])

    # A cabeça desfaz a torção do tronco: o olhar fica preso no horizonte, que é
    # o que o pescoço faz de verdade e o que impede o "andar de robô". O mesmo
    # vale para a inclinação — quem corre inclina o tronco, não a cara no chão.
    pose["neck"].rotation_quaternion = world_rotation(
        pose["neck"], [("Z", -counter * 0.45), ("X", 1.5 + spec.torso_lean * 0.55)])
    pose["head"].rotation_quaternion = world_rotation(
        pose["head"], [("Z", -counter * 0.35 - plan["yaw"] * 0.25),
                       ("X", -2.0 + spec.torso_lean * 0.45)])


def pose_legs(spec: GaitSpec, pose, metrics: dict, phase: float) -> float:
    """Resolve as duas pernas e devolve o maior erro de posição do tornozelo.

    O erro é a prova de que o ciclo não patina: se a IK alcançou o alvo, o pé
    está exatamente onde a trajetória mandou, e a trajetória foi construída
    andando para trás na velocidade do corpo.
    """
    error = 0.0
    for side, offset in (("L", 0.0), ("R", 0.5)):
        _, _, foot_pitch, toe_pitch = foot_plan(spec, phase + offset)
        data = metrics[side]

        thigh = pose[f"thigh.{side}"]
        hip = thigh.matrix.translation.copy()   # já deslocado pelo root/pelvis
        ankle = ankle_target(spec, metrics, side, phase + offset)

        knee = solve_leg(hip, ankle, data["femur"], data["tibia"],
                         spec.leg_extension_limit, Vector((0.0, -1.0, 0.0)))

        aim_bone(thigh, knee - hip, hip)
        bpy.context.view_layer.update()

        calf = pose[f"calf.{side}"]
        aim_bone(calf, ankle - knee, calf.matrix.translation.copy())
        bpy.context.view_layer.update()

        foot = pose[f"foot.{side}"]
        # A cabeça do bone do pé *é* o tornozelo: comparar com o alvo mede o
        # escorregamento direto, sem intermediário.
        error = max(error, (foot.matrix.translation - ankle).length)
        aim_bone(foot, rotate_x(data["foot_dir"], foot_pitch),
                 foot.matrix.translation.copy())
        bpy.context.view_layer.update()

        toe = pose[f"toe.{side}"]
        aim_bone(toe, rotate_x(data["toe_dir"], foot_pitch + toe_pitch),
                 toe.matrix.translation.copy())

    return error


def pose_arms(spec: GaitSpec, pose, phase: float) -> None:
    """Braços em oposição às pernas — o contrapeso que estabiliza a marcha."""
    for side, offset in (("L", 0.5), ("R", 0.0)):
        sign = 1.0 if side == "L" else -1.0
        swing_phase = math.sin(2.0 * math.pi * (phase + offset))
        swing = spec.arm_swing * (swing_phase + spec.arm_swing_bias)

        # Direção do braço: baixa da T-pose e depois balança no plano sagital.
        # O sinal segue a convenção do rig (ver `pose_test.py`): girar em +Y
        # baixa o braço esquerdo, e o direito espelha. Invertido, os dois sobem
        # e o personagem anda de mãos ao alto.
        drop = Matrix.Rotation(math.radians(spec.arm_drop * sign), 3, "Y")
        rest_dir = Vector((sign, 0.0, 0.0))
        arm_dir = rotate_x(drop @ rest_dir, swing)

        # O cotovelo fecha quando o braço vem à frente e abre quando vai atrás.
        elbow = spec.elbow_min + (spec.elbow_max - spec.elbow_min) \
            * (0.5 - 0.5 * swing_phase)
        forearm_dir = rotate_x(drop @ rest_dir, swing - elbow)

        aim_bone(pose[f"upperarm.{side}"], arm_dir)
        bpy.context.view_layer.update()
        aim_bone(pose[f"lowerarm.{side}"], forearm_dir,
                 pose[f"lowerarm.{side}"].matrix.translation.copy())
        bpy.context.view_layer.update()
        aim_bone(pose[f"hand.{side}"], forearm_dir,
                 pose[f"hand.{side}"].matrix.translation.copy())


# -- montagem da action -------------------------------------------------------


KEYED_BONES = ("root", "pelvis", "spine_01", "spine_02", "spine_03", "neck", "head")
KEYED_SIDED = ("upperarm", "lowerarm", "hand", "thigh", "calf", "foot", "toe")


def action_fcurves(action):
    """Curvas da action, nas duas APIs.

    O Blender 4.4 trocou a action plana por camadas com *slots*, e a 5.x tirou
    ``action.fcurves`` de vez. Ler as duas formas mantém o script rodando em
    qualquer Blender que abra este arquivo.
    """
    legacy = getattr(action, "fcurves", None)
    if legacy is not None:
        return list(legacy)

    curves = []
    for layer in action.layers:
        for strip in layer.strips:
            for bag in getattr(strip, "channelbags", ()):
                curves.extend(bag.fcurves)
    return curves


def clear_pose(arm) -> None:
    for bone in arm.pose.bones:
        bone.rotation_mode = "QUATERNION"
        bone.rotation_quaternion = (1.0, 0.0, 0.0, 0.0)
        bone.location = (0.0, 0.0, 0.0)
        bone.scale = (1.0, 1.0, 1.0)
    bpy.context.view_layer.update()


def _key_frame(arm, frame: int) -> None:
    """Grava a pose. Só o root leva translação: o resto é rotação pura.

    Manter translação fora dos outros bones não é economia à toa — é o que faz o
    clipe caber em pouca coisa quando ele for replicado pela rede.
    """
    names = list(KEYED_BONES) + [f"{n}.{s}" for n in KEYED_SIDED for s in ("L", "R")]
    for name in names:
        bone = arm.pose.bones[name]
        bone.keyframe_insert("rotation_quaternion", frame=frame, group=name)
        if name == "root":
            bone.keyframe_insert("location", frame=frame, group=name)


def _linear_curves(action) -> None:
    """Interpolação linear: a pose já está amostrada em todo frame.

    Bézier por cima de amostragem densa só inventa ultrapassagem entre chaves —
    e é o three.js quem vai interpolar no fim das contas, também linear.
    """
    for curve in action_fcurves(action):
        for kp in curve.keyframe_points:
            kp.interpolation = "LINEAR"
        curve.update()


def build(spec: GaitSpec, arm=None) -> dict:
    """Gera a action da marcha *spec* e devolve as medidas do ciclo."""
    arm = arm or bpy.data.objects[ARMATURE_NAME]
    metrics = rest_metrics(arm)

    scene = bpy.context.scene
    scene.render.fps = spec.fps
    # O ciclo começa no frame **0**, não no 1. O exportador glTF converte frame
    # em segundos por `frame / fps`, então começar no 1 punha o primeiro
    # keyframe em t = 0,033 s e o clipe saía mais longo do que é: o three.js
    # passaria um frame parado a cada volta, e o passo dava um tranco no laço.
    scene.frame_start = 0
    scene.frame_end = spec.cycle_frames

    clear_pose(arm)

    if arm.animation_data is None:
        arm.animation_data_create()
    old = bpy.data.actions.get(spec.action_name)
    if old is not None:
        bpy.data.actions.remove(old)
    action = bpy.data.actions.new(spec.action_name)
    action.use_fake_user = True            # sem isso a action some ao reabrir
    arm.animation_data.action = action

    pose = arm.pose.bones
    ceilings = measure_ceilings(spec, pose, metrics)
    body_lift = plan_body_lift(spec, ceilings)
    lifts, foot_error = [], 0.0

    # O último frame repete o primeiro de propósito: é ele que fecha o laço.
    for frame in range(0, spec.cycle_frames + 1):
        phase = frame / spec.cycle_frames
        scene.frame_set(frame)

        plan = pelvis_plan(spec, phase)
        lift = body_lift(phase)
        lifts.append(lift)

        aim_root(pose["root"], plan, lift)
        bpy.context.view_layer.update()

        pose_spine(spec, pose, plan)
        bpy.context.view_layer.update()

        foot_error = max(foot_error, pose_legs(spec, pose, metrics, phase))
        pose_arms(spec, pose, phase)
        bpy.context.view_layer.update()

        _key_frame(arm, frame)

    _linear_curves(action)
    scene.frame_set(0)

    flight = sum(1 for f in range(spec.cycle_frames)
                 if all((f / spec.cycle_frames + off) % 1.0 >= spec.stance
                        for off in (0.0, 0.5)))
    return {
        "action": spec.action_name,
        "fps": spec.fps,
        "frames": spec.cycle_frames,
        "cycle_seconds": round(spec.cycle_seconds, 4),
        "stride_m": spec.stride,
        "native_speed_ms": round(spec.native_speed, 4),
        "steps_per_min": round(120.0 / spec.cycle_seconds, 1),
        "hip_low_m": round(metrics["hip_height"] + min(lifts), 4),
        "hip_high_m": round(metrics["hip_height"] + max(lifts), 4),
        "bounce_cm": round((max(lifts) - min(lifts)) * 100, 2),
        "flight_frames": flight,
        # Distância entre onde o tornozelo devia estar e onde de fato foi parar.
        # É a medida direta do escorregamento: se não for ~zero, o pé patina.
        "foot_error_mm": round(foot_error * 1000, 3),
    }
