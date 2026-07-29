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
  e fora de fase com ela. Duas oscilações de períodos diferentes é o que evita
  o padrão óbvio de loop — o olho pega repetição de 3 s, não de 8 s.
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
#: 96 quadros = 3,2 s, ou ~19 respirações por minuto. Respiração humana em
#: repouso fica entre 12 e 20.
CYCLE_FRAMES = 96
#: O balanço do peso leva três respirações para fechar, de propósito: períodos
#: que não são múltiplos escondem o ponto de emenda do laço.
WEIGHT_SHIFT_CYCLES = 1.0 / 3.0

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

        breath = _breath(phase)
        shift = math.sin(2.0 * math.pi * phase * WEIGHT_SHIFT_CYCLES * 3.0)

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
        "breaths_per_min": round(60.0 / (CYCLE_FRAMES / FPS), 1),
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
