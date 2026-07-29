"""Ciclo de corrida do pirata.

Mesma máquina de `anim_gait.py`, outra marcha. E é outra marcha mesmo — correr
não é andar acelerado. Três coisas mudam de natureza, não de grau:

1. **Fase aérea.** Com apoio em 34% do ciclo, sobram 16% de cada passo em que
   **nenhum** pé está no chão. Nesses quadros nada limita a altura do corpo: ele
   voa. É a fase aérea que permite passo grande sem o quadril ter de descer, e é
   por isso que a corrida alcança velocidade que a caminhada não alcança.

2. **A curva vertical inverte.** Andando, o corpo está mais baixo com as pernas
   abertas e mais alto ao passar sobre o pé — pêndulo invertido. Correndo é o
   contrário: mais baixo **no meio do apoio**, com a perna absorvendo o peso
   como mola, e mais alto **no meio do voo**. Daí o `bounce_phase` na metade do
   apoio.

3. **O pé toca quase sob o corpo.** Pisar à frente é *overstriding*: o pé vira
   freio e o joelho leva o impacto. Por isso `foot_reach_bias` em 0,35 — um
   terço da excursão à frente, dois terços atrás.

O resto é grau: passo maior, cadência maior, joelho recolhendo mais alto,
cotovelo fechado em ~90° e tronco inclinado à frente.

Velocidade nativa: **3,67 m/s**, contra os 4,7 m/s de `RUN_SPEED` no jogo. A
folga fica por conta do `timeScale`, e é maior do que se gostaria pelo mesmo
motivo de sempre: esta perna tem 0,788 m, e passo grande não cabe nela.
"""

from __future__ import annotations

import anim_gait
from anim_gait import GaitSpec

RUN = GaitSpec(
    name="corrida",
    action_name="Run",
    fps=30,
    #: 18 quadros a 30 fps = 0,600 s por passada, ou 200 passos por minuto.
    #: Corrida de verdade fica entre 170 e 190; acima disso aqui de propósito —
    #: ver a nota do passo.
    cycle_frames=18,
    #: 1,10 m, e não os 1,20 da primeira tentativa.
    #:
    #: A excursão do pé durante o apoio é `2 × passo × apoio`, e com 1,20 m ela
    #: dava 82 cm: o pé chegava a 51 cm **atrás** do quadril no desprendimento, e
    #: para a perna alcançar isso o corpo tinha de descer 18 cm. Corria agachado.
    #: Encurtar o passo e girar mais rápido mantém a velocidade e devolve 9 cm de
    #: altura — que é exatamente o que quem tem perna curta faz para correr.
    stride=1.10,
    #: Abaixo de 0,50 aparece fase aérea. Corredor recreativo fica em 0,35-0,40;
    #: velocista desce de 0,25. Aqui 0,31 pelo mesmo motivo do passo: apoio curto
    #: encurta a excursão, e é a fase aérea que paga a velocidade.
    stance=0.31,
    #: Um terço da excursão à frente do quadril, dois terços atrás.
    foot_reach_bias=0.35,
    #: O pé larga o chão depressa e recolhe — sem isso ele fica esticado atrás
    #: enquanto o corpo já subiu no voo, e a perna não alcança.
    swing_launch=1.9,
    #: E chega ao contato **já recuando**, que é o que impede o pé de frear o
    #: corpo a cada passo.
    swing_retract=-0.35,
    #: Ponto mais alto do balanço bem adiantado: o calcanhar sobe quase até o
    #: glúteo logo depois do desprendimento. Perna curta gira mais rápido.
    swing_peak=0.32,

    #: O calcanhar sobe muito mais que andando — quase até o glúteo. Não é
    #: enfeite: recolher a perna encurta o pêndulo e é o que deixa a passada
    #: girar rápido o bastante.
    ankle_swing_lift=0.30,
    #: O corpo de quem corre oscila bem mais que o de quem anda: 3,5 cm para
    #: cada lado, contra 2,1 cm da caminhada.
    bounce_amplitude=0.035,
    #: **O vale no meio do apoio**, não no contato — metade de `stance`. Ver o
    #: item 2 do cabeçalho.
    bounce_phase=0.155,
    #: Correndo, os pés caem quase na mesma linha; andando, cada um na sua.
    step_width=0.130,

    #: A perna dobra mais que andando ao receber o peso — é ela que faz o papel
    #: de mola.
    #:
    #: Vale saber o que este parâmetro **não** faz: ele é um teto, não um
    #: comando. Afrouxá-lo de 0,895 para 0,928 não mexeu um milímetro na altura
    #: do quadril, porque no meio do apoio quem manda é a curva do corpo, que já
    #: passa abaixo do limite. Só os quadros em que ele é o gargalo — contato e
    #: desprendimento — sentem a diferença.
    stance_extension=(0.978, 0.928, 0.985),

    #: Contato mais plano — de bota e em velocidade, ninguém ataca de calcanhar
    #: como andando.
    foot_contact=-6.0,
    #: E o empurrão é mais forte, com o tornozelo estendendo mais no fim.
    foot_toe_off=44.0,
    #: No ar o pé fica com a ponta bem para cima, senão a bota raspa o convés na
    #: passagem — que é rasante numa corrida.
    foot_swing=-16.0,
    #: O rolamento do pé é bem mais rápido do que andando.
    foot_roll_in=0.12,
    foot_roll_out=0.46,

    #: Menos balanço lateral: em velocidade o corpo estabiliza.
    hip_sway=0.018,
    #: Mas a pelve gira mais, e o tronco contra-gira mais junto.
    pelvis_yaw=8.5,
    pelvis_roll=3.0,
    pelvis_pitch=4.0,
    torso_counter_yaw=0.70,
    #: Tronco inclinado à frente. É o que faz ler como corrida já no primeiro
    #: quadro, antes mesmo de a perna se mexer.
    torso_lean=11.0,

    arm_drop=76.0,
    #: Braço balança muito mais, e mais para trás do que para a frente.
    arm_swing=34.0,
    arm_swing_bias=0.28,
    #: Cotovelo fechado perto de 90° o tempo todo — a marca registrada de quem
    #: corre. Andando ele abre até 16°.
    elbow_min=62.0,
    elbow_max=98.0,
)

#: Velocidade que este clipe corre de verdade. Quem integra precisa deste número
#: para calcular o `timeScale`.
NATIVE_SPEED = RUN.native_speed

CYCLE_FRAMES = RUN.cycle_frames
FPS = RUN.fps
action_fcurves = anim_gait.action_fcurves


def build(arm=None) -> dict:
    """Gera a action ``Run``."""
    return anim_gait.build(RUN, arm)
