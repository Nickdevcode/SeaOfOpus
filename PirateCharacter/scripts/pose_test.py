"""Poses de teste para validar o skinning.

Rig que não foi posado não está validado: é aqui que aparecem pinçamento de
cotovelo/joelho, peça rígida esticando e vértice preso no lugar errado.

As poses são descritas por rotações em torno de eixos do MUNDO ("baixe o braço
girando em Y") e convertidas para o espaço de cada bone. Descrever em euler
local seria refém do roll calculado na armature, que muda de eixo conforme a
orientação do bone e torna as poses impossíveis de ler.
"""

import math

import bpy
from mathutils import Quaternion, Vector

ARMATURE_NAME = "RIG_Pirate"

AXES = {"X": Vector((1.0, 0.0, 0.0)),
        "Y": Vector((0.0, 1.0, 0.0)),
        "Z": Vector((0.0, 0.0, 1.0))}

# bone -> lista de (eixo do mundo, graus)
# Convenções deste rig, em T-pose com o personagem olhando para -Y:
#   braço desce girando em +Y (sinal invertido no lado direito)
#   cotovelo dobra para a frente girando em Z
#   quadril/joelho dobram girando em X
POSES = {
    "relaxed": {
        "upperarm.L": [("Y", 64)], "upperarm.R": [("Y", -64)],
        "lowerarm.L": [("Z", -26)], "lowerarm.R": [("Z", 26)],
        "hand.L": [("Z", -8)], "hand.R": [("Z", 8)],
        "spine_01": [("X", -3)], "spine_02": [("X", 2)],
        "neck": [("X", 3)], "head": [("Z", 12), ("X", 3)],
    },
    "action": {
        "upperarm.L": [("Y", 18), ("Z", -22)], "upperarm.R": [("Y", -78), ("Z", -14)],
        "lowerarm.L": [("Z", -68)], "lowerarm.R": [("Z", 44)],
        "hand.L": [("Z", -16)], "hand.R": [("Z", 14)],
        "spine_01": [("X", -6), ("Z", 8)], "spine_02": [("X", 4), ("Z", 5)],
        "spine_03": [("Z", 4)],
        "neck": [("X", -4)], "head": [("Z", -16), ("X", -5)],
        "thigh.L": [("X", -38)], "calf.L": [("X", 52)], "foot.L": [("X", -16)],
        "thigh.R": [("X", 24)], "calf.R": [("X", 14)], "foot.R": [("X", -8)],
    },
    "crouch": {
        "thigh.L": [("X", -78), ("Y", 10)], "calf.L": [("X", 104)],
        "foot.L": [("X", -28)],
        "thigh.R": [("X", -78), ("Y", -10)], "calf.R": [("X", 104)],
        "foot.R": [("X", -28)],
        "pelvis": [("X", 16)], "spine_01": [("X", -10)], "spine_02": [("X", -8)],
        "upperarm.L": [("Y", 52), ("Z", -18)], "upperarm.R": [("Y", -52), ("Z", 18)],
        "lowerarm.L": [("Z", -72)], "lowerarm.R": [("Z", 72)],
        "head": [("X", -8)],
    },
    "fist": {
        "upperarm.L": [("Y", 58), ("Z", -30)], "upperarm.R": [("Y", -58), ("Z", 30)],
        "lowerarm.L": [("Z", -80)], "lowerarm.R": [("Z", 80)],
        **{f"finger_{n}_0{i}.{s}": [("Y", (1 if s == "L" else -1) * (62 if i == 1 else 78))]
           for n in ("index", "middle", "ring", "pinky")
           for i in (1, 2) for s in ("L", "R")},
        "thumb_01.L": [("Z", -38)], "thumb_01.R": [("Z", 38)],
        "thumb_02.L": [("Z", -44)], "thumb_02.R": [("Z", 44)],
    },
}


def clear_pose(arm=None):
    arm = arm or bpy.data.objects[ARMATURE_NAME]
    for bone in arm.pose.bones:
        bone.rotation_mode = "QUATERNION"
        bone.rotation_quaternion = (1.0, 0.0, 0.0, 0.0)
        bone.location = (0.0, 0.0, 0.0)
        bone.scale = (1.0, 1.0, 1.0)
    bpy.context.view_layer.update()


def _world_rotation(pose_bone, steps):
    """Compõe rotações de eixo-do-mundo no espaço de repouso do bone."""
    rest = pose_bone.bone.matrix_local.to_3x3()
    inv = rest.inverted()
    quat = Quaternion((1.0, 0.0, 0.0, 0.0))
    for axis_name, degrees in steps:
        axis_local = (inv @ AXES[axis_name]).normalized()
        quat = quat @ Quaternion(axis_local, math.radians(degrees))
    return quat


def apply_pose(name):
    """Aplica uma pose nomeada. Bones ausentes são reportados, não ignorados."""
    arm = bpy.data.objects[ARMATURE_NAME]
    clear_pose(arm)
    missing = []
    for bone_name, steps in POSES[name].items():
        bone = arm.pose.bones.get(bone_name)
        if bone is None:
            missing.append(bone_name)
            continue
        bone.rotation_mode = "QUATERNION"
        bone.rotation_quaternion = _world_rotation(bone, steps)
    bpy.context.view_layer.update()
    return missing
