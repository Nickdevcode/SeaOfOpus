"""Ciclo de caminhada do pirata.

O método está em `anim_gait.py`; aqui só os números que fazem esta marcha ser
andar e não correr. Os dois que mandam:

- **passo de 0,66 m.** Não é escolha estética. Com a perna deste personagem
  (0,788 m do quadril ao tornozelo) um passo maior obriga o quadril a descer
  tanto no contato que a caminhada vira agachamento andando.
- **apoio em 58% do ciclo.** Acima de 50% sempre há um pé no chão, e é isso que
  separa andar de correr. Ninguém "decola" andando.

Disso sai a velocidade, que é consequência e não parâmetro: **1,65 m/s**.

> O jogo anda a 2,8 m/s (`WALK_SPEED`). O acerto é no runtime, com
> `timeScale = velocidade / 1,65`, e o buraco que sobra é o motivo de existir
> `anim_run.py`: a 2,8 m/s o certo é misturar caminhada e corrida, não esticar
> a caminhada em 70%.
"""

from __future__ import annotations

import anim_gait
from anim_gait import GaitSpec

WALK = GaitSpec(
    name="caminhada",
    action_name="Walk",
    fps=30,
    cycle_frames=24,                       # 0,800 s por passada
    stride=0.66,
    #: Andando, humano fica em 60-62% de apoio; 58% porque esta é uma marcha
    #: apressada, e apoio menor encurta o alcance que a perna precisa ter no
    #: contato.
    stance=0.58,

    ankle_swing_lift=0.115,
    #: Gente andando oscila 2 a 3 cm para cima e para baixo; passar disso vira
    #: marcha de desenho animado.
    bounce_amplitude=0.021,
    #: Vale no contato: andando, o corpo está mais baixo com as pernas abertas e
    #: mais alto ao passar por cima do pé de apoio (pêndulo invertido).
    bounce_phase=0.0,
    step_width=0.175,

    foot_contact=-13.0,                    # ataque de calcanhar
    foot_toe_off=34.0,

    hip_sway=0.028,
    pelvis_yaw=6.0,
    pelvis_roll=4.2,
    pelvis_pitch=3.0,
    torso_counter_yaw=0.62,
    torso_lean=0.0,                        # andando se anda ereto

    arm_drop=70.0,
    arm_swing=21.0,
    arm_swing_bias=0.35,
    elbow_min=16.0,
    elbow_max=42.0,
)

#: Velocidade que este clipe anda de verdade. Quem integra precisa deste número
#: para calcular o `timeScale`.
NATIVE_SPEED = WALK.native_speed

# Compatibilidade com quem já importava daqui.
CYCLE_FRAMES = WALK.cycle_frames
FPS = WALK.fps
action_fcurves = anim_gait.action_fcurves


def build(arm=None) -> dict:
    """Gera a action ``Walk``."""
    return anim_gait.build(WALK, arm)
