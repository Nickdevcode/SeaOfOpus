"""Ciclo parado: o pirata de pé no convés, respirando.

Este clipe não nasceu de um plano, nasceu de um defeito. Com só andar e correr,
o personagem parado volta à **pose de repouso do rig** — braços abertos em cruz,
a T-pose — porque é isso que sobra quando todo peso de animação é zero. Ninguém
vê isso no Blender; aparece no primeiro segundo dentro do jogo.

Não é uma marcha, então não usa o motor de `anim_gait.py` inteiro — mas usa a
parte que importa: os pés são resolvidos por IK contra alvos **fixos no chão**.
Um idle com o corpo oscilando e as pernas em FK faria o pé deslizar alguns
milímetros por ciclo, que é pouco para se notar de relance e o bastante para
parecer que o personagem flutua.

O que se move, e por quê:

- **Respiração** — o peito sobe e desce, e o corpo inteiro sobe junto, bem
  menos. Só o tórax subindo lê como fole; o corpo todo junto lê como gente.
- **Peso migrando de um pé para o outro**, num ciclo mais lento que a respiração
  e que **não fecha junto com ela**. Duas oscilações cujos contadores são primos
  entre si é o que evita o padrão óbvio de loop: em 9,6 s cabem três respirações
  e dois balanços, e a combinação das duas só volta ao ponto de partida no laço
  inteiro. O olho pega repetição de 3 s; de 9,6 s, não. Ver `CYCLE_FRAMES` para
  o que este parágrafo prometia antes de o código cumprir.
- **Cabeça** com deriva mínima, atrasada em relação ao tronco.
"""

from __future__ import annotations

import math

import bpy
from mathutils import Vector

import anim_gait
from anim_gait import GaitSpec

ACTION_NAME = "Idle"

FPS = 30
#: 288 quadros = 9,6 s. Longo para um clipe de personagem parado, e é o ponto:
#: mantida a respiração nos 96 quadros já conferidos, é o **menor** laço que fecha
#: um número inteiro de respirações e de balanços de peso com os dois contadores
#: primos entre si e maiores que um — 288 = 2⁵ · 3², três de 96 e dois de 144.
#: (Encurtar exigiria dois de 96 e **um** balanço, e um oscilador que dá uma volta
#: por laço marca o laço sozinho; ou apertar a respiração para 3,0 s, que é a
#: ponta da faixa de repouso. Os dois pagam mais caro do que os 96 quadros que se
#: economizariam.)
#:
#: > [!warning] Eram 96 quadros, e o comentário prometia o que o código desfazia
#: > O cabeçalho sempre disse que respiração e balanço fecham em períodos
#: > diferentes "para o olho não cronometrar o laço", e `WEIGHT_SHIFT_CYCLES`
#: > valia `1/3` — só que o `build` multiplicava por `3.0` de volta na hora de
#: > montar a senoide. As duas oscilações fechavam no **mesmo** período de 3,2 s,
#: > que é o padrão de laço mais fácil de pegar que existe: o clipe inteiro era
#: > uma respiração.
#: >
#: > O multiplicador não era o defeito, era o remendo. Tirá-lo deixaria o balanço
#: > a um terço do caminho no fim do laço, e a emenda passaria a dar um tranco
#: > visível — pior que o defeito que se queria consertar. O defeito era o laço
#: > ser curto demais para caber mais de um período de cada coisa. O conserto é
#: > o do `anim_float`: alongar até os períodos serem primos entre si.
#:
#: A respiração **não mudou** — continua um ciclo a cada 96 quadros, que é o que
#: já tinha sido conferido em vídeo. O que mudou é ela ter deixado de ser a
#: duração do clipe.
CYCLE_FRAMES = 288

#: Ciclos de cada oscilador dentro do laço. Primos entre si, e é a única coisa
#: que importa nestes dois números — por isso eles estão juntos, como os três de
#: `anim_float`.
#:
#: - **3 respirações**, 96 quadros cada: 3,2 s, ou 18,75 por minuto. Respiração
#:   humana em repouso fica entre 12 e 20.
#: - **2 balanços**, 144 quadros cada: 4,8 s. Mais lento que a respiração, como o
#:   cabeçalho sempre disse que era.
#:
#: 3 e 2 não têm divisor comum, então a combinação dos dois só se repete depois
#: dos 288 quadros inteiros — `verify()` prova isso varrendo os sub-períodos em
#: vez de acreditar na aritmética.
BREATH_CYCLES = 3
WEIGHT_SHIFT_CYCLES = 2

#: O quadro 0 é o fim da expiração (`_breath(0) == -1`) e o meio do balanço
#: (`sen 0 == 0`), e isso **não pode mudar**: `anim_jump` costura o último quadro
#: do `JumpLand` exatamente nessa pose, lendo daqui `BODY_SETTLE`, `BREATH_RISE`,
#: `ARM_DROP`, `ELBOW_REST` e `ARM_DRIFT`. Contagem inteira de ciclos preserva os
#: dois valores de partida; contagem fracionária, não — e o pouso passaria a
#: terminar num quadro que o `Idle` não tem.

#: Distância de cada pé à linha do meio. Mais largo que andando — parado no
#: convés de um barco que joga, ninguém fica de pés juntos.
STANCE_WIDTH = 0.19
#: Um pé um pouco à frente do outro. Simétrico demais lê como boneco.
FOOT_STAGGER = 0.055

#: Quanto o corpo baixa em relação ao repouso: o joelho de quem está de pé não
#: fica travado.
#:
#: 2,2 cm não bastavam — com os pés afastados e um à frente do outro, a perna
#: precisa de mais comprimento do que tem para alcançar o alvo, e a IK clampava
#: com 6,5 mm de erro. Assentar mais resolve e ainda melhora a pose: ninguém
#: fica de joelho travado no convés de um barco que joga.
BODY_SETTLE = 0.035
#: Amplitude da subida do corpo na inspiração.
BREATH_RISE = 0.006
#: Deslocamento lateral do quadril ao trocar o peso de pé.
WEIGHT_SWAY = 0.017

#: Extensão máxima da perna parada. Um pouco abaixo do limite das marchas: em pé
#: e sem carga, o joelho fica mais solto do que no apoio de uma passada.
IDLE_EXTENSION_LIMIT = 0.975

#: Ângulos do tronco na inspiração, em graus.
CHEST_EXPAND = 1.5
SHOULDER_RISE = 1.1

#: Pose dos braços em repouso. Mesmos valores da pose `relaxed` de
#: `pose_test.py`, que já foi validada contra o skinning.
ARM_DROP = 64.0
ELBOW_REST = 26.0
#: Micro-movimento do braço, para ele não ficar de pedra.
ARM_DRIFT = 2.4


def _breath(phase: float) -> float:
    """Ciclo respiratório de -1 a 1. A inspiração é mais curta que a expiração.

    Uma senoide pura respira igual nos dois sentidos, o que não é o que um
    peito faz: enche depressa e esvazia devagar.
    """
    p = phase % 1.0
    if p < 0.4:
        return -math.cos(math.pi * (p / 0.4))
    return math.cos(math.pi * ((p - 0.4) / 0.6))


def build(arm=None) -> dict:
    """Gera a action ``Idle``."""
    arm = arm or bpy.data.objects[anim_gait.ARMATURE_NAME]
    metrics = anim_gait.rest_metrics(arm)

    scene = bpy.context.scene
    scene.render.fps = FPS
    scene.frame_start = 0
    scene.frame_end = CYCLE_FRAMES

    anim_gait.clear_pose(arm)

    if arm.animation_data is None:
        arm.animation_data_create()
    old = bpy.data.actions.get(ACTION_NAME)
    if old is not None:
        bpy.data.actions.remove(old)
    action = bpy.data.actions.new(ACTION_NAME)
    action.use_fake_user = True
    arm.animation_data.action = action

    pose = arm.pose.bones
    # Os pés não saem do lugar o clipe inteiro: é o que define um idle.
    ankles = {}
    for side, stagger in (("L", FOOT_STAGGER), ("R", -FOOT_STAGGER)):
        sign = 1.0 if side == "L" else -1.0
        height = anim_gait.ankle_height(metrics[side]["sole"], 0.0, 0.0, 0.0)
        ankles[side] = Vector((sign * STANCE_WIDTH, -stagger, height))

    foot_error = 0.0
    for frame in range(0, CYCLE_FRAMES + 1):
        phase = frame / CYCLE_FRAMES
        scene.frame_set(frame)

        # Cada oscilador conta os **próprios** ciclos dentro do laço, e é só isso
        # que garante que os dois fechem no quadro final sem tranco: com contagem
        # inteira, `phase = 1` cai no mesmo ponto da curva que `phase = 0`.
        breath = _breath(BREATH_CYCLES * phase)
        shift = math.sin(2.0 * math.pi * WEIGHT_SHIFT_CYCLES * phase)

        _pose_body(pose, breath, shift)
        bpy.context.view_layer.update()

        foot_error = max(foot_error, _pose_legs(pose, metrics, ankles))
        _pose_arms(pose, breath, shift)
        bpy.context.view_layer.update()

        anim_gait._key_frame(arm, frame)

    anim_gait._linear_curves(action)
    scene.frame_set(0)

    return {
        "action": ACTION_NAME,
        "fps": FPS,
        "frames": CYCLE_FRAMES,
        "cycle_seconds": round(CYCLE_FRAMES / FPS, 3),
        "breath_seconds": round(CYCLE_FRAMES / BREATH_CYCLES / FPS, 3),
        "breaths_per_min": round(60.0 * BREATH_CYCLES / (CYCLE_FRAMES / FPS), 1),
        "weight_shift_seconds": round(CYCLE_FRAMES / WEIGHT_SHIFT_CYCLES / FPS, 3),
        "foot_error_mm": round(foot_error * 1000, 3),
    }


def _pose_body(pose, breath: float, shift: float) -> None:
    """Corpo: assenta, respira e passa o peso de um pé para o outro."""
    lift = -BODY_SETTLE + breath * BREATH_RISE
    plan = {"sway": shift * WEIGHT_SWAY, "yaw": shift * 1.2,
            "roll": -shift * 2.0, "pitch": 1.2}
    anim_gait.aim_root(pose["root"], plan, lift)

    pose["pelvis"].rotation_quaternion = anim_gait.world_rotation(
        pose["pelvis"], [("Y", plan["roll"]), ("X", plan["pitch"])])

    # O peito é quem abre na inspiração; a lombar quase não participa.
    for name, share in (("spine_01", 0.15), ("spine_02", 0.45), ("spine_03", 0.40)):
        pose[name].rotation_quaternion = anim_gait.world_rotation(
            pose[name], [("X", -breath * CHEST_EXPAND * share),
                         ("Z", -shift * 0.8 * share)])

    for side in ("L", "R"):
        pose[f"clavicle.{side}"].rotation_quaternion = anim_gait.world_rotation(
            pose[f"clavicle.{side}"],
            [("Y", (1.0 if side == "L" else -1.0) * -breath * SHOULDER_RISE)])

    # A cabeça vem atrasada: ela reage ao corpo, não junto com ele.
    pose["neck"].rotation_quaternion = anim_gait.world_rotation(
        pose["neck"], [("X", breath * 0.6), ("Z", shift * 0.5)])
    pose["head"].rotation_quaternion = anim_gait.world_rotation(
        pose["head"], [("X", -breath * 0.4), ("Z", shift * 0.9)])


def _pose_legs(pose, metrics: dict, ankles: dict) -> float:
    """Pernas por IK contra alvos parados: o pé fica cravado no convés."""
    error = 0.0
    for side in ("L", "R"):
        data = metrics[side]
        thigh = pose[f"thigh.{side}"]
        hip = thigh.matrix.translation.copy()
        ankle = ankles[side]

        knee = anim_gait.solve_leg(hip, ankle, data["femur"], data["tibia"],
                                   IDLE_EXTENSION_LIMIT, Vector((0.0, -1.0, 0.0)))
        anim_gait.aim_bone(thigh, knee - hip, hip)
        bpy.context.view_layer.update()

        calf = pose[f"calf.{side}"]
        anim_gait.aim_bone(calf, ankle - knee, calf.matrix.translation.copy())
        bpy.context.view_layer.update()

        foot = pose[f"foot.{side}"]
        error = max(error, (foot.matrix.translation - ankle).length)
        anim_gait.aim_bone(foot, data["foot_dir"], foot.matrix.translation.copy())
        bpy.context.view_layer.update()

        toe = pose[f"toe.{side}"]
        anim_gait.aim_bone(toe, data["toe_dir"], toe.matrix.translation.copy())

    return error


def _pose_arms(pose, breath: float, shift: float) -> None:
    """Braços caídos, com deriva pequena o bastante para não virar gesto."""
    from mathutils import Matrix

    for side in ("L", "R"):
        sign = 1.0 if side == "L" else -1.0
        drift = breath * ARM_DRIFT + shift * 1.2 * sign

        drop = Matrix.Rotation(math.radians((ARM_DROP + drift) * sign), 3, "Y")
        rest_dir = Vector((sign, 0.0, 0.0))
        arm_dir = drop @ rest_dir
        forearm_dir = anim_gait.rotate_x(arm_dir, -(ELBOW_REST + drift * 0.5))

        anim_gait.aim_bone(pose[f"upperarm.{side}"], arm_dir)
        bpy.context.view_layer.update()
        anim_gait.aim_bone(pose[f"lowerarm.{side}"], forearm_dir,
                           pose[f"lowerarm.{side}"].matrix.translation.copy())
        bpy.context.view_layer.update()
        anim_gait.aim_bone(pose[f"hand.{side}"], forearm_dir,
                           pose[f"hand.{side}"].matrix.translation.copy())


# -- conferência do laço ------------------------------------------------------

#: Pontos que a conferência segue, como `(osso, ponta)`. Extremidades, porque é
#: nelas que um tranco de emenda aparece primeiro — mão e chapéu andam dezenas de
#: vezes mais que o quadril —, e o quadril junto, porque é ele que carrega a
#: respiração e o balanço somados.
SEAM_POINTS = (("hand.L", "head"), ("hand.R", "head"),
               ("head", "tail"), ("pelvis", "head"))


def _assign_action(arm, name: str) -> None:
    """Troca a action ativa do rig, com o slot que o Blender 4.4+ exige.

    Sem o slot a action fica atribuída e **não avalia**: a conferência leria a
    pose de repouso e daria um laço perfeito para qualquer clipe. Mesma armadilha
    anotada no `anim_climb` e no `anim_float`.
    """
    action = bpy.data.actions[name]
    if arm.animation_data is None:
        arm.animation_data_create()
    arm.animation_data.action = action
    slots = getattr(action, "slots", None)
    if slots:
        arm.animation_data.action_slot = slots[0]


def verify(arm=None, action: str = ACTION_NAME) -> dict:
    """Relê a action **gravada** e responde as duas perguntas sobre o laço.

    1. **A emenda fecha?** O passo do último quadro para o quadro 0, comparado
       com os **vizinhos** dele e não com a mediana do ciclo — a mediana mistura
       os trechos lentos do gesto e acusa emenda onde não há. É a régua do
       `anim_float.verify`, e o número a procurar é 1,0.
    2. **O laço se repete antes de terminar?** Se respiração e balanço voltarem
       juntos ao ponto de partida em algum sub-período, a pose se repete lá — e é
       lá que o olho vai cronometrar o clipe, não no fim. Varrer os divisores do
       laço responde isso medindo, em vez de pedir fé na aritmética dos dois
       contadores. A tabela se lê de baixo para cima: os sub-períodos **longos**
       são os candidatos a laço falso, e nenhum deles pode chegar perto de zero.
       Os divisores pequenos são pequenos por construção — em um quadro o corpo
       anda um quadro — e não dizem nada.

    Medir a pose construída não provaria nada — ver a nota do `anim_climb`. Daqui
    sai a pose avaliada da action, que é a que o jogo vai tocar.
    """
    arm = arm or bpy.data.objects[anim_gait.ARMATURE_NAME]
    _assign_action(arm, action)
    scene = bpy.context.scene

    # O quadro `CYCLE_FRAMES` é uma cópia do 0 (é o que fecha o laço na linha do
    # tempo); amostrá-lo daria um passo zero de brinde no meio da conta.
    tracks = {name: [] for name, _ in SEAM_POINTS}
    for frame in range(CYCLE_FRAMES):
        scene.frame_set(frame)
        bpy.context.view_layer.update()
        for name, end in SEAM_POINTS:
            bone = arm.pose.bones[name]
            tracks[name].append((bone.head if end == "head" else bone.tail).copy())
    scene.frame_set(0)

    seams, worst_ratio = {}, 0.0
    for name, points in tracks.items():
        steps = [(points[(i + 1) % CYCLE_FRAMES] - points[i]).length
                 for i in range(CYCLE_FRAMES)]
        neighbours = (steps[-2] + steps[0]) * 0.5
        ratio = steps[-1] / neighbours if neighbours > 1e-9 else 1.0
        seams[name] = round(ratio, 3)
        worst_ratio = max(worst_ratio, abs(ratio - 1.0))

    repeats = {}
    for period in (d for d in range(1, CYCLE_FRAMES) if CYCLE_FRAMES % d == 0):
        repeats[period] = round(max(
            (points[(i + period) % CYCLE_FRAMES] - points[i]).length * 1000
            for points in tracks.values() for i in range(CYCLE_FRAMES)), 2)

    # Os dois sub-períodos que denunciariam o defeito antigo: um de respiração e
    # um de balanço. Com contadores primos entre si, nenhum dos dois traz a pose
    # de volta — voltar num deles seria o clipe de 3,2 s escrito com mais
    # quadros. Perto de zero em qualquer linha da tabela é a mesma doença.
    breath_period = CYCLE_FRAMES // BREATH_CYCLES
    shift_period = CYCLE_FRAMES // WEIGHT_SHIFT_CYCLES

    return {
        "action": action,
        "frames": CYCLE_FRAMES,
        "seconds": round(CYCLE_FRAMES / FPS, 3),
        "breath_seconds": round(CYCLE_FRAMES / BREATH_CYCLES / FPS, 3),
        "weight_shift_seconds": round(CYCLE_FRAMES / WEIGHT_SHIFT_CYCLES / FPS, 3),
        # 1,0 é emenda perfeita; o que importa é o desvio, e ele vale para os dois
        # lados (0,5 é um quadro parado, 2,0 é um pulo).
        "seam_ratio": seams,
        "seam_worst_deviation": round(worst_ratio, 3),
        # Quanto a pose anda em cada sub-período que divide o laço, em mm.
        "repeat_mm": repeats,
        "repeat_at_breath_mm": repeats.get(breath_period),
        "repeat_at_shift_mm": repeats.get(shift_period),
    }
