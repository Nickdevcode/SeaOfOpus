"""Carregar a tábua de reparo: a peça atravessada no corpo, uma mão em cada ponta.

Convenções do rig, como no resto da pasta: o personagem olha para **-Y**,
1 unidade = 1 metro, chão em Z = 0, **+X é a esquerda dele**.

Este é o quarto clipe indexado por alguma coisa que não é o relógio — mas, ao
contrário da passada (distância), da escada (altura) e do timão (ângulo da
roda), **não há grandeza física para ler aqui**. Segurar uma tábua não tem
período natural nenhum. Então este ciclo roda no tempo, como o `Idle`, e o que
ele descreve é o que um corpo faz com oito quilos de madeira nos braços: nada de
espetacular, um assentamento lento e uma respiração mais curta que a de quem
está de mãos vazias.

**A tábua não é desenhada aqui.** Ela é um prop do jogo (`Props/Plank`), e o
jogo a prende entre as duas mãos lendo os ossos dos dedos — não por um socket
com offset calculado neste arquivo. A diferença importa: um offset gravado aqui
teria de sobreviver à conversão Z-up → Y-up do exportador glTF e à convenção de
osso do Blender, e qualquer erro nessas duas passagens apareceria como uma
tábua flutuando ao lado das mãos, sem nenhum aviso. Lida das duas mãos, a peça
cai onde as mãos estiverem, hoje e depois de qualquer mexida neste clipe.

O que este arquivo **precisa** garantir, então, é uma coisa só, e ela é medida em
`build`: que a distância entre as duas palmas não mude ao longo do ciclo. É ela
que vira o comprimento aparente da tábua no jogo, e ela variando é a tábua
esticando e encolhendo na tela.

A geometria da pega não foi escolhida aqui: `Props/Plank/scripts/plank_spec.py`
dimensionou a peça **para esta pose**, a partir da referência de arte — 1,15 m
de comprimento para uma pegada de perto de 0,58 m com sobra de folgado nas duas
pontas. O que este arquivo faz é conferir se o braço deste rig alcança isso, e
o que ele descobriu é que **não alcança**: ver `GRIP_SPAN`.
"""

from __future__ import annotations

import math

import bpy
from mathutils import Matrix, Vector

import anim_climb
import anim_gait


ACTION_NAME = "Carry"
FPS = 30

#: Duração do ciclo, em quadros.
#:
#: 2,4 s, contra os 3,2 s do `Idle`. Não é estilo: quem está com peso nos braços
#: respira mais curto, e o ciclo tem de fechar num número de quadros que ponha os
#: extremos do balanço em keyframe cheio — 72 divide por 4 e por 8.
CYCLE_FRAMES = 72


# -- a tábua ------------------------------------------------------------------
#
# As três medidas espelham `Props/Plank/scripts/plank_spec.py`. Elas são repetidas
# e não importadas porque aquele pacote roda **headless** e este roda dentro da
# GUI: importar de lá arrastaria `piratelib` e o `sys.path` do outro projeto para
# dentro desta sessão. O custo de repetir são três números; o de importar seria
# uma dependência cruzada entre dois pipelines que hoje não se conhecem.

PLANK_LENGTH = 1.15
PLANK_WIDTH = 0.22
PLANK_THICKNESS = 0.045
HALF_WIDTH = PLANK_WIDTH / 2.0
HALF_THICKNESS = PLANK_THICKNESS / 2.0

#: Distância entre as duas palmas, em metros.
#:
#: **A referência pedia 0,58 e este rig não dá.** Vale a conta, porque ela é o
#: motivo de o número estar aqui em vez de lá. Com as mãos a 29 cm do centro, a
#: tábua inclinada põe a mão de baixo a 0,672 m do ombro — contra os 0,678 m de
#: `ARM_REACH`, ou seja, **99% de extensão**: o braço reto, travado no batente da
#: IK, que é a pose que este arquivo mais evita. Fechando para 0,50 m a mão de
#: baixo cai para 0,58 m de ombro e o braço trabalha a 86%, que é a mesma folga
#: com que o timão sai (88%).
#:
#: O que se perde são 4 cm de sobra em cada ponta da tábua, e não se perde a
#: leitura: com 1,15 m de peça e 0,50 m de pegada sobram **32 cm** de madeira
#: para fora de cada mão, que continua sendo o desenho de quem carrega uma tábua
#: atravessada, e não de quem segura uma régua.
GRIP_SPAN = 0.50
HALF_SPAN = GRIP_SPAN / 2.0

#: Centro da tábua, no referencial do rig, com o corpo em repouso.
#:
#: Os três números saíram de uma varredura de dezoito combinações medindo duas
#: coisas ao mesmo tempo: quanto o braço de baixo estica e quantos graus a palma
#: fica de encarar a madeira. Eles brigam — aproximar a peça do corpo alivia o
#: braço e torce a palma, afastá-la faz o contrário.
#:
#: O `z` é o que mais pesa, e é contraintuitivo: **subir** a tábua alivia os dois
#: ao mesmo tempo, porque põe as mãos na altura em que o cotovelo trabalha
#: dobrado. De 1,14 para 1,20 o braço cai de 88% para 80% e o desvio de palma de
#: 33° para 24°.
#:
#: O `y` é o que aperta por baixo: a barriga deste personagem avança **24,8 cm**
#: do eixo do corpo na altura da faixa (medido em `anim_climb`), e a face interna
#: da tábua fica a `HALF_THICKNESS` do centro. Com -0,32 sobram 7,5 cm de folga —
#: o bastante para o assentamento do ciclo não meter a peça dentro do casaco.
PLANK_CENTER = Vector((0.0, -0.32, 1.20))

#: Inclinação da tábua no plano frontal, em graus. Positivo sobe para a esquerda.
#:
#: 20° é o meio-termo da mesma varredura: a 12° a tábua fica horizontal demais e
#: deixa de ler como peça carregada de través, e a 22° o desvio de palma passa
#: dos 29°. Cada grau a mais desce a mão direita 0,9 cm e a afasta do ombro
#: quase o mesmo.
PLANK_TILT = 20.0

#: Giro da tábua em torno da vertical, em graus. Recua a ponta **de baixo**.
#:
#: É o que tira a peça do plano do peito e a põe **atravessada** — sem ele a
#: tábua fica paralela aos ombros, que é como se carrega uma bandeja, não uma
#: tábua. 14° dão 12 cm de diferença de profundidade entre as duas mãos.
#:
#: O sinal não é indiferente, e a medição pegou isso: recuando a ponta **alta**
#: em vez da baixa, o braço de baixo vai a 89% de extensão, porque a mão que já
#: estava mais longe do ombro ainda avança. Recuando a de baixo, ela fica a 82%.
#: Também é o que o corpo faz: o lado que sustenta o peso vem para perto.
PLANK_YAW = -14.0

#: Quanto o alto da tábua se afasta do corpo, em graus.
#:
#: Uma tábua encostada no peito fica sempre um pouco caída para fora, porque é
#: assim que o peso dela se equilibra sobre as mãos em vez de sobre os pulsos.
PLANK_LEAN = 18.0

#: Folga entre a palma e a face da madeira, em metros.
#:
#: Mesma lógica do `PALM_OVER_HANDLE` do timão: quem segura é a palma, e cravar
#: o ponto de pega na superfície enfia a tábua um centímetro dentro da mão.
PALM_CLEAR = 0.012

#: Quanto a palma sobe da aresta inferior da tábua, em metros.
#:
#: A mão agarra pela **borda**: palma na face de dentro, dedos passando por baixo
#: da aresta. 4,5 cm põem o centro da palma perto da metade de baixo da peça, que
#: é onde ela precisa estar para os dedos alcançarem a outra face.
PALM_INSET = 0.045

#: Fecho dos dedos, em graus por falange.
#:
#: Entre a escada (42/48) e o timão (28/32), e a conta é a mesma que o timão usa:
#: um dedo de 4,6 cm envolve `4,6/2,25 = 2,0 rad` da espessura desta tábua, quase
#: o mesmo que os 1,8 rad da barra da escada. Fica perto do fecho da escada, um
#: pouco aberto porque aqui o polegar apoia por cima em vez de fechar em volta.
FINGER_CURL = (38.0, 44.0)
THUMB_CURL = (24.0, 27.0)
FINGERS = anim_climb.FINGERS

ARM_EXTENSION_LIMIT = anim_climb.ARM_EXTENSION_LIMIT
LEG_EXTENSION_LIMIT = anim_climb.LEG_EXTENSION_LIMIT
HAND_GRIP_REACH = anim_climb.HAND_GRIP_REACH
ARM_REACH = 0.678

#: Cotovelo para fora e para baixo, como no resto da pasta.
#:
#: Aqui os dois braços trabalham **na frente do corpo** e bem dobrados, que é
#: justamente a região em que a IK de dois elos tem mais liberdade para escolher
#: errado — sem a dica, o cotovelo esquerdo sobe acima do ombro em metade do
#: ciclo.
ELBOW_HINT = (0.70, 0.16, -0.70)
KNEE_HINT = (0.20, -0.97, 0.0)


# -- postura ------------------------------------------------------------------

#: Afastamento dos pés e defasagem entre eles, em metros.
#:
#: Um pouco mais aberto que o `Idle` (0,19): com peso nos braços a base alarga
#: sozinha. O escalonamento é o que impede a pose de virar posição de sentido.
FOOT_X = 0.115
FOOT_STAGGER = 0.045
FOOT_SPLAY = 7.0

#: Recuo do quadril, em metros. O peso está à frente, então o corpo vai atrás.
#:
#: É a compensação que qualquer um faz ao pegar peso: o centro de massa do
#: conjunto tem de continuar caindo entre os pés, e 8 kg a 33 cm à frente pedem
#: uns 3 cm de quadril para trás.
HIP_SETBACK = 0.030
#: Assentamento: joelho de leve, para o peso não ficar sobre a perna travada.
SETTLE = 0.022
#: Inclinação do tronco para trás, em graus. Mesmo motivo do recuo do quadril.
TORSO_LEAN = -6.0

#: Amplitudes do ciclo, em metros e graus.
#:
#: Tudo pequeno de propósito: este clipe toca enquanto o jogador está **parado
#: pregando tábua**, e o que se vê dele é sobretudo periférico, em primeira
#: pessoa. Amplitude grande aqui não lê como respiração, lê como tremor.
BOB = 0.012
SWAY = 0.008
BREATH = 0.006
PLANK_ROCK = 1.6


def plank_frame(t: float) -> tuple:
    """Referencial da tábua na fase *t*: (centro, comprimento, largura, normal).

    Os três eixos são ortonormais e saem de duas rotações sobre a horizontal —
    `PLANK_YAW` em torno da vertical e `PLANK_TILT` no plano que sobra —, mais o
    `PLANK_LEAN` que deita a peça sobre o corpo. Montá-los por rotação em vez de
    escrever os vetores à mão é o que garante que continuem perpendiculares
    depois de qualquer mexida nos ângulos.

    O balanço do ciclo entra aqui, e não numa camada por cima: se a tábua tivesse
    relógio próprio, ela descolaria das mãos, que leem daqui.
    """
    phase = 2.0 * math.pi * t

    yaw = Matrix.Rotation(math.radians(PLANK_YAW), 3, "Z")
    # Sinal negativo: girar em torno de +Y leva +X para **-Z**, e sem a troca um
    # `PLANK_TILT` positivo desceria para a esquerda — o contrário do que o nome
    # da constante promete. Custou um preview para aparecer.
    tilt = Matrix.Rotation(math.radians(-PLANK_TILT), 3, "Y")
    # O balanço da peça é o resto do movimento do corpo chegando nela pelas mãos.
    rock = Matrix.Rotation(math.radians(-PLANK_ROCK * math.sin(phase)), 3, "Y")

    # O comprimento sai do eixo X — a esquerda dele — girado pelos dois ângulos.
    length = (yaw @ rock @ tilt @ Vector((1.0, 0.0, 0.0))).normalized()

    # A normal parte da frente do personagem (-Y) e deita pelo `PLANK_LEAN`.
    lean = Matrix.Rotation(math.radians(PLANK_LEAN), 3, "X")
    normal = (yaw @ lean @ Vector((0.0, -1.0, 0.0))).normalized()

    # Reortogonaliza: as duas rotações acima não garantem perpendicularidade
    # entre si, e um desvio de um grau aqui vira meio centímetro de palma fora
    # da madeira lá na frente.
    width = normal.cross(length).normalized()
    normal = length.cross(width).normalized()

    center = PLANK_CENTER.copy()
    center.z += BOB * math.sin(phase) - SETTLE
    center.x += SWAY * math.sin(phase + math.pi * 0.5)
    center.y += HIP_SETBACK * 0.5

    return center, length, width, normal


def grip_target(t: float, side: str) -> Vector:
    """Onde a palma daquele lado tem de estar, na fase *t*.

    A esquerda toma a ponta que sobe; a direita, a que desce. Sai só da tábua —
    nada aqui olha para onde o ombro está, o que tira a circularidade de "o ombro
    projeta pelo que a mão pede, e a mão pede pelo que o ombro decidiu".

    A mão vai **por baixo**, com a palma contra a aresta inferior. Foi a segunda
    tentativa: com a palma espalmada na face larga, o relatório acusou **82°** de
    desvio de palma, ou seja, a mão encarando um lado e a madeira outro. E a
    causa não era o código — era o gesto. Ninguém carrega oito quilos de tábua
    espalmando a mão na face dela; a peça repousa na mão, e os dedos sobem pela
    outra face só para segurá-la ali.
    """
    center, length, width, _ = plank_frame(t)
    sign = 1.0 if side == "L" else -1.0

    point = center + length * (sign * HALF_SPAN)
    point -= width * (HALF_WIDTH + PALM_CLEAR)
    return point


def palm_direction(t: float) -> Vector:
    """Para onde a palma olha: para cima, contra a aresta que ela sustenta.

    As duas mãos olham para o mesmo lado, porque as duas estão embaixo da mesma
    peça — ao contrário do timão, onde cada palma encara um raio diferente da
    roda.
    """
    _, _, width, _ = plank_frame(t)
    return width.copy()


def body_plan(t: float) -> dict:
    """O que o corpo faz enquanto segura: respiração e um assentamento lento."""
    phase = 2.0 * math.pi * t
    return {
        "breath": BREATH * math.sin(phase),
        "sway": SWAY * math.sin(phase + math.pi * 0.5),
        "settle": SETTLE + BOB * 0.5 * math.sin(phase),
    }


def _aim_root(root, plan: dict) -> None:
    """Corpo inteiro: recuo do quadril, assentamento e o balanço do ciclo."""
    matrix = Matrix.Translation(Vector((plan["sway"], HIP_SETBACK, -plan["settle"])))
    root.matrix = matrix @ root.bone.matrix_local


def _pose_torso(pose, plan: dict) -> None:
    """Coluna, pescoço e cabeça.

    O tronco vai para **trás** (`TORSO_LEAN` é negativo), ao contrário de todos os
    outros clipes desta pasta: aqui o peso está à frente do corpo, e inclinar
    para a frente somaria ao braço de alavanca em vez de compensá-lo.

    A cabeça desfaz o recuo e olha um pouco para baixo, para a peça — que é onde
    olha quem carrega alguma coisa que pode escapar.
    """
    pose["pelvis"].rotation_quaternion = anim_gait.world_rotation(
        pose["pelvis"], [("X", TORSO_LEAN * 0.15)])

    for name, share in (("spine_01", 0.30), ("spine_02", 0.35), ("spine_03", 0.35)):
        pose[name].rotation_quaternion = anim_gait.world_rotation(
            pose[name], [("X", TORSO_LEAN * share),
                         ("Y", plan["breath"] * 90.0)])

    undo = -TORSO_LEAN * 1.15
    pose["neck"].rotation_quaternion = anim_gait.world_rotation(
        pose["neck"], [("X", undo * 0.5 + 6.0)])
    pose["head"].rotation_quaternion = anim_gait.world_rotation(
        pose["head"], [("X", undo * 0.5 + 9.0)])


#: Ganho e limiar da projeção de ombro, iguais aos do timão.
SHOULDER_REACH_GAIN = 9.0
SHOULDER_REACH_ONSET = 0.80
#: Projeção de base: os dois ombros já vêm um pouco para a frente, porque as duas
#: mãos estão à frente do corpo o tempo todo.
SHOULDER_BASE = 5.0


def _pose_clavicles(pose, targets: dict) -> dict:
    """Projeta cada ombro pelo tanto que a **sua** mão está pedindo.

    A assimetria é o ponto: a mão de baixo trabalha a 86% do braço e a de cima a
    58%, então o ombro direito projeta e o esquerdo quase não. Um valor único
    para os dois deixaria um ombro curto e o outro empurrado sem motivo.

    E é esta a rotação que o `anim_gait._key_frame` **não grava** — ver
    `_key_frame`, no fim do arquivo.
    """
    demand = {}
    for side in ("L", "R"):
        sign = 1.0 if side == "L" else -1.0
        shoulder = pose[f"upperarm.{side}"].matrix.translation
        need = (targets[side] - shoulder).length / ARM_REACH
        demand[side] = need

        extra = SHOULDER_REACH_GAIN * anim_gait.smoothstep(
            anim_gait.ramp(need, SHOULDER_REACH_ONSET, 1.0))
        pose[f"clavicle.{side}"].rotation_quaternion = anim_gait.world_rotation(
            pose[f"clavicle.{side}"], [("Z", -sign * (SHOULDER_BASE + extra))])
    return demand


def _pose_leg(pose, data: dict, side: str, ankle: Vector) -> tuple:
    """Uma perna por IK contra *ankle*. Devolve (erro, extensão).

    Cópia estrutural da do timão, e pelo mesmo motivo: o pé fica plantado e o
    corpo é que se move por cima dele, então o escorregamento é zero por
    construção.
    """
    sign = 1.0 if side == "L" else -1.0
    thigh = pose[f"thigh.{side}"]
    hip = thigh.matrix.translation.copy()

    reach = data["femur"] + data["tibia"]
    extension = (ankle - hip).length / reach

    knee = anim_gait.solve_leg(hip, ankle, data["femur"], data["tibia"],
                               LEG_EXTENSION_LIMIT,
                               Vector((sign * KNEE_HINT[0], KNEE_HINT[1], KNEE_HINT[2])))
    anim_gait.aim_bone(thigh, knee - hip, hip)
    bpy.context.view_layer.update()

    calf = pose[f"calf.{side}"]
    anim_gait.aim_bone(calf, ankle - knee, calf.matrix.translation.copy())
    bpy.context.view_layer.update()

    foot = pose[f"foot.{side}"]
    error = (foot.matrix.translation - ankle).length
    turn = Matrix.Rotation(math.radians(sign * FOOT_SPLAY), 3, "Z")
    anim_gait.aim_bone(foot, turn @ data["foot_dir"], foot.matrix.translation.copy())
    bpy.context.view_layer.update()

    toe = pose[f"toe.{side}"]
    anim_gait.aim_bone(toe, turn @ data["toe_dir"], toe.matrix.translation.copy())
    return error, extension


def _aim_hand(pose_bone, direction: Vector, palm: Vector) -> None:
    """Aponta a mão e escolhe o giro dela em torno do próprio eixo.

    É o `anim_helm._aim_hand` com o eixo vindo de fora — aqui ele é o da largura
    da tábua, constante ao longo do ciclo a menos do balanço. Sem escolher o
    roll, a IK de dois elos deixa a mão em qualquer giro que satisfaça a posição,
    e a palma sai encarando o lado errado da madeira em metade dos quadros.
    """
    rest = pose_bone.bone.matrix_local
    rest_dir = (pose_bone.bone.tail_local - pose_bone.bone.head_local).normalized()
    axis = direction.normalized()

    wanted = palm - axis * palm.dot(axis)
    if wanted.length < 1e-6:
        anim_gait.aim_bone(pose_bone, direction, pose_bone.matrix.translation.copy())
        return
    wanted.normalize()

    swing = rest_dir.rotation_difference(axis)
    current = swing @ anim_climb.REST_PALM
    current = current - axis * current.dot(axis)

    total = swing
    if current.length > 1e-6:
        total = current.normalized().rotation_difference(wanted) @ swing

    matrix = (total.to_matrix() @ rest.to_3x3()).to_4x4()
    matrix.translation = pose_bone.matrix.translation
    pose_bone.matrix = matrix


def _pose_arm(pose, data: dict, side: str, target: Vector, palm: Vector) -> tuple:
    """Um braço por IK, com a **palma** em *target*.

    Devolve (erro, extensão, palma, desvio da palma em graus).

    A cadeia resolvida é ombro→cotovelo→**palma**, com a mão contando como o
    último pedaço do antebraço — que é o caminho do `anim_climb`, e não o do
    `anim_helm`.

    A escolha não foi de gosto, foi medida. O timão trava a mão numa direção
    fixa (de frente para a roda) porque ali a palma **tem** de ficar exatamente
    tangente ao punho, senão ela escorrega sobre a madeira ao longo do giro. Aqui
    tentou-se o mesmo, com a mão apontada para a aresta de baixo da tábua, e o
    relatório devolveu **109,6° de dobra de pulso** — quase o dobro do que um
    pulso humano faz. O motivo é geométrico: com os dois braços trabalhando
    dobrados e à frente do corpo, o antebraço chega quase horizontal, e pedir
    que a mão aponte para baixo a partir dali é pedir uma fratura.

    E o que o timão comprava com aquela trava não é preciso aqui: a tábua do
    jogo é presa **às mãos** (lê os ossos dos dedos das duas), então ela vai para
    onde a palma for. Não há superfície fixa sobre a qual escorregar. O que se
    passa a medir, no lugar do escorregamento, é o desvio da palma — quantos
    graus ela ficou de encarar a face da madeira.
    """
    sign = 1.0 if side == "L" else -1.0
    upper = pose[f"upperarm.{side}"]
    shoulder = upper.matrix.translation.copy()

    # A mão entra na cadeia: quem segura é a palma, e o punho é só a última
    # dobra antes dela.
    reach = data["humerus"] + data["forearm"] + HAND_GRIP_REACH
    extension = (target - shoulder).length / reach

    elbow = anim_gait.solve_leg(shoulder, target, data["humerus"],
                                data["forearm"] + HAND_GRIP_REACH,
                                ARM_EXTENSION_LIMIT,
                                Vector((sign * ELBOW_HINT[0], ELBOW_HINT[1],
                                        ELBOW_HINT[2])))
    anim_gait.aim_bone(upper, elbow - shoulder, shoulder)
    bpy.context.view_layer.update()

    lower = pose[f"lowerarm.{side}"]
    anim_gait.aim_bone(lower, target - elbow, lower.matrix.translation.copy())
    bpy.context.view_layer.update()

    hand = pose[f"hand.{side}"]
    wrist = hand.matrix.translation.copy()
    direction = (target - wrist).normalized()
    _aim_hand(hand, direction, palm)
    bpy.context.view_layer.update()

    got = hand.matrix.translation + direction * HAND_GRIP_REACH
    # Para onde a palma **de fato** ficou olhando, depois de o roll ser
    # resolvido no que sobrava perpendicular ao antebraço.
    facing = hand.matrix.to_3x3() @ anim_climb.REST_PALM
    drift = math.degrees(facing.angle(palm))
    return (got - target).length, extension, got, drift


def _pose_hand_grip(pose, side: str) -> None:
    """Fecha os dedos sobre a aresta da tábua.

    Fecho constante o ciclo inteiro: ao contrário do timão e da escada, aqui a
    mão nunca larga. Uma mão que abre e fecha segurando peso é a leitura de quem
    está prestes a deixar cair.
    """
    sign = 1.0 if side == "L" else -1.0
    for name in FINGERS:
        for i, curl in enumerate(FINGER_CURL, start=1):
            bone = pose.get(f"finger_{name}_0{i}.{side}")
            if bone is not None:
                bone.rotation_quaternion = anim_gait.world_rotation(
                    bone, [("Y", sign * curl)])
    for i, curl in enumerate(THUMB_CURL, start=1):
        bone = pose.get(f"thumb_0{i}.{side}")
        if bone is not None:
            bone.rotation_quaternion = anim_gait.world_rotation(
                bone, [("Z", -sign * curl)])


def _key_frame(arm, frame: int) -> None:
    """Grava a pose, com dedos, polegares e clavículas.

    O `anim_gait._key_frame` leva 21 ossos e **não leva a clavícula** nem os
    dedos. Aqui os dois estão em uso — o ombro direito projeta pela demanda da
    mão de baixo, e os dez dedos estão fechados na madeira. Gravar pelo caminho
    do gait produziria uma action com o ombro em repouso e as mãos abertas, com
    todas as métricas deste arquivo continuando a dar zero: elas medem a pose
    **construída**, não a gravada.
    """
    anim_climb._key_frame(arm, frame)


def build(arm=None) -> dict:
    """Gera a action e devolve as medidas que provam que ela presta."""
    arm = arm or bpy.data.objects[anim_gait.ARMATURE_NAME]
    metrics = anim_gait.rest_metrics(arm)
    arms = anim_climb.arm_metrics(arm)

    scene = bpy.context.scene
    scene.render.fps = FPS
    # Quadro 0: o exportador glTF divide o número do quadro pelo fps, e começar
    # no 1 poria o primeiro keyframe em t = 0,033 s.
    scene.frame_start = 0
    scene.frame_end = CYCLE_FRAMES

    anim_gait.clear_pose(arm)
    action = anim_climb._new_action(arm, ACTION_NAME)
    pose = arm.pose.bones

    ankles = {
        side: Vector((
            (1.0 if side == "L" else -1.0) * FOOT_X,
            arm.data.bones[f"foot.{side}"].head_local.y
            - (1.0 if side == "L" else -1.0) * FOOT_STAGGER,
            arm.data.bones[f"foot.{side}"].head_local.z,
        ))
        for side in ("L", "R")
    }

    report = {"hand_error": 0.0, "arm_extension": 0.0, "leg_extension": 0.0,
              "foot_error": 0.0, "demand": 0.0, "palm_drift": 0.0}
    #: Distância entre as palmas em cada quadro. É o comprimento aparente da
    #: tábua no jogo, e ela variando é a peça esticando na tela.
    spans: list[float] = []

    for frame in range(0, CYCLE_FRAMES + 1):
        t = (frame % CYCLE_FRAMES) / CYCLE_FRAMES
        scene.frame_set(frame)

        plan = body_plan(t)
        _aim_root(pose["root"], plan)
        bpy.context.view_layer.update()
        _pose_torso(pose, plan)
        bpy.context.view_layer.update()

        targets = {side: grip_target(t, side) for side in ("L", "R")}
        palm = palm_direction(t)

        demand = _pose_clavicles(pose, targets)
        bpy.context.view_layer.update()
        report["demand"] = max(report["demand"], max(demand.values()))

        for side in ("L", "R"):
            error, extension = _pose_leg(pose, metrics[side], side, ankles[side])
            report["foot_error"] = max(report["foot_error"], error)
            report["leg_extension"] = max(report["leg_extension"], extension)

        got = {}
        for side in ("L", "R"):
            error, extension, palm_at, drift = _pose_arm(
                pose, arms[side], side, targets[side], palm)
            report["hand_error"] = max(report["hand_error"], error)
            report["arm_extension"] = max(report["arm_extension"], extension)
            report["palm_drift"] = max(report["palm_drift"], drift)
            _pose_hand_grip(pose, side)
            got[side] = palm_at

        spans.append((got["L"] - got["R"]).length)

        bpy.context.view_layer.update()
        _key_frame(arm, frame)

    anim_gait._linear_curves(action)
    scene.frame_set(0)

    return {
        "action": ACTION_NAME,
        "fps": FPS,
        "frames": CYCLE_FRAMES,
        "cycle_seconds": round(CYCLE_FRAMES / FPS, 3),
        "grip_span_m": GRIP_SPAN,
        "plank_overhang_cm": round((PLANK_LENGTH - GRIP_SPAN) / 2.0 * 100, 1),
        # Se a IK não alcançou o alvo, a pose que se vê não é a que está descrita.
        "hand_error_mm": round(report["hand_error"] * 1000, 3),
        "foot_error_mm": round(report["foot_error"] * 1000, 3),
        # O que a tábua do jogo vai ler das duas mãos. Variação aqui é a peça
        # mudando de tamanho na tela.
        "span_drift_mm": round((max(spans) - min(spans)) * 1000, 3),
        "span_mean_cm": round(sum(spans) / len(spans) * 100, 2),
        "arm_extension_max": round(report["arm_extension"], 3),
        "leg_extension_max": round(report["leg_extension"], 3),
        "reach_demand_max": round(report["demand"], 3),
        # Quantos graus a palma ficou de encarar a face da tábua. Não precisa ser
        # zero — precisa ser pequeno o bastante para a mão não ler como torta.
        "palm_drift_max_deg": round(report["palm_drift"], 1),
    }


def run(arm=None) -> dict:
    """Ponto de entrada: constrói e confere."""
    arm = arm or bpy.data.objects[anim_gait.ARMATURE_NAME]
    return {"build": build(arm), "verify": verify(arm), "clearance": clearance(arm)}


#: Prefixo do andaime de preview.
#:
#: Dois underscores, como o do timão: um só é o prefixo que o `export.py` usa
#: para reconhecer **action** de andaime, e um objeto com o mesmo prefixo
#: passaria despercebido por aquela varredura. Este aqui é apagado por `_purge`,
#: e `preview` chama `_purge` antes de qualquer coisa.
PREVIEW_PREFIX = "__CarryPreview"


def _purge() -> int:
    """Apaga o andaime de preview. Idempotente e seguro de chamar sempre."""
    doomed = [o for o in bpy.data.objects if o.name.startswith(PREVIEW_PREFIX)]
    for obj in doomed:
        bpy.data.objects.remove(obj, do_unlink=True)
    return len(doomed)


def preview(arm=None) -> dict:
    """Monta a tábua de mentira na cena, para a pose poder ser olhada.

    A peça é construída com as **mesmas constantes** que o clipe usa — é isso
    que faz o preview provar alguma coisa em vez de ilustrar. Uma caixa desenhada
    "por onde parece certo" mostraria uma pose que não existe.

    A tábua entra parentada ao osso `hand.L`: assim ela acompanha o ciclo inteiro
    ao arrastar a linha do tempo, e qualquer descolamento entre a mão e a peça
    aparece na hora. Não é como o jogo prende a peça (lá ela lê as **duas** mãos),
    mas para conferir a pose no Blender é o suficiente e não exige driver nenhum.
    """
    arm = arm or bpy.data.objects[anim_gait.ARMATURE_NAME]
    _purge()
    if bpy.data.actions.get(ACTION_NAME) is not None:
        anim_climb._assign_action(arm, ACTION_NAME)

    scene = bpy.context.scene
    scene.frame_set(0)
    center, length, width, normal = plank_frame(0.0)

    mesh = bpy.data.meshes.new(PREVIEW_PREFIX + "Mesh")
    half = (0.5, 0.5, 0.5)
    corners = [(sx * half[0], sy * half[1], sz * half[2])
               for sx in (-1, 1) for sy in (-1, 1) for sz in (-1, 1)]
    faces = [(0, 1, 3, 2), (4, 6, 7, 5), (0, 4, 5, 1),
             (2, 3, 7, 6), (0, 2, 6, 4), (1, 5, 7, 3)]
    mesh.from_pydata(corners, [], faces)
    mesh.update()

    plank = bpy.data.objects.new(PREVIEW_PREFIX + "Plank", mesh)
    scene.collection.objects.link(plank)

    basis = Matrix((
        (length.x, width.x, normal.x, center.x),
        (length.y, width.y, normal.y, center.y),
        (length.z, width.z, normal.z, center.z),
        (0.0, 0.0, 0.0, 1.0),
    ))
    plank.matrix_world = basis @ Matrix.Diagonal(
        Vector((PLANK_LENGTH, PLANK_WIDTH, PLANK_THICKNESS, 1.0)))

    # Parenteia à mão pelo inverso da matriz dela: é o que congela a peça em
    # relação ao punho e deixa o ciclo inteiro navegável.
    hand = arm.pose.bones["hand.L"]
    plank.parent = arm
    plank.parent_type = "BONE"
    plank.parent_bone = "hand.L"
    plank.matrix_parent_inverse = (arm.matrix_world @ hand.matrix).inverted()
    plank.matrix_world = basis @ Matrix.Diagonal(
        Vector((PLANK_LENGTH, PLANK_WIDTH, PLANK_THICKNESS, 1.0)))

    return {"object": plank.name, "frames": CYCLE_FRAMES}


def clearance(arm=None) -> dict:
    """Quanto a tábua entra no corpo, medido na malha deformada.

    A pergunta que só a malha responde: a peça passa a 7,5 cm do eixo do corpo,
    e o eixo do corpo não é o corpo — a barriga avança 24,8 cm, o casaco tem
    espessura e o braço cruza por cima. Uma tábua que atravessa o casaco não
    aparece em nenhuma das métricas de `build`, porque lá só existem ossos.

    O teste é feito no referencial da própria tábua, onde o volume dela é uma
    caixa alinhada aos eixos e "está dentro" vira três comparações.
    """
    arm = arm or bpy.data.objects[anim_gait.ARMATURE_NAME]
    mesh_object = bpy.data.objects[anim_gait.MESH_NAME]
    if bpy.data.actions.get(ACTION_NAME) is not None:
        anim_climb._assign_action(arm, ACTION_NAME)

    scene = bpy.context.scene
    depsgraph = bpy.context.evaluated_depsgraph_get()

    half = Vector((PLANK_LENGTH / 2.0, HALF_WIDTH, HALF_THICKNESS))
    worst = 0.0
    worst_frame = 0
    #: A menor folga achada. Ela não é enfeite: um `worst` de zero também sai de
    #: uma tábua flutuando a meio metro do peito, e é esta linha que separa os
    #: dois casos.
    closest = 9.0
    counted = 0
    #: Os dedos **têm** de entrar na madeira um pouco — é isso que agarrar é.
    #: A conta ignora quem está perto das duas pegas.
    grip_radius = 0.10

    for frame in range(0, CYCLE_FRAMES + 1, 6):
        t = (frame % CYCLE_FRAMES) / CYCLE_FRAMES
        scene.frame_set(frame)
        depsgraph.update()

        center, length, width, normal = plank_frame(t)
        grips = [grip_target(t, side) for side in ("L", "R")]

        evaluated = mesh_object.evaluated_get(depsgraph)
        deformed = evaluated.to_mesh()
        try:
            for vertex in deformed.vertices:
                point = mesh_object.matrix_world @ vertex.co
                if min((point - g).length for g in grips) < grip_radius:
                    continue

                offset = point - center
                local = Vector((offset.dot(length), offset.dot(width), offset.dot(normal)))
                counted += 1

                depth = min(half[i] - abs(local[i]) for i in range(3))
                if depth > worst:
                    worst = depth
                    worst_frame = frame

                # Distância ao ponto mais próximo da caixa: zero lá dentro.
                outside = Vector((max(abs(local[i]) - half[i], 0.0) for i in range(3)))
                closest = min(closest, outside.length)
        finally:
            evaluated.to_mesh_clear()

    scene.frame_set(0)
    return {
        "action": ACTION_NAME,
        # Positivo é penetração: quanto o corpo entrou na caixa da tábua.
        "worst_penetration_mm": round(worst * 1000, 2),
        "worst_frame": worst_frame,
        "closest_gap_mm": round(closest * 1000, 2),
        "vertices_tested": counted,
    }


def verify(arm=None) -> dict:
    """Relê a **action gravada** e mede a pose que ela realmente produz.

    Existe pela armadilha que esta pasta já pagou três vezes: as métricas do
    `build` medem a pose construída em memória, e uma rotação que não foi gravada
    (a clavícula é a suspeita de sempre) some na action sem que nenhum número
    acuse. Aqui o quadro é avaliado pelo depsgraph, com a action tocando, e o que
    se mede é o que o jogo vai ver.
    """
    arm = arm or bpy.data.objects[anim_gait.ARMATURE_NAME]
    action = bpy.data.actions.get(ACTION_NAME)
    if action is None:
        return {"error": f"action {ACTION_NAME} não existe — rode build() antes"}

    anim_climb._assign_action(arm, ACTION_NAME)
    scene = bpy.context.scene
    depsgraph = bpy.context.evaluated_depsgraph_get()

    worst = 0.0
    spans = []
    for frame in range(0, CYCLE_FRAMES + 1):
        t = (frame % CYCLE_FRAMES) / CYCLE_FRAMES
        scene.frame_set(frame)
        depsgraph.update()

        evaluated = arm.evaluated_get(depsgraph)
        got = {}
        for side in ("L", "R"):
            bone = evaluated.pose.bones[f"hand.{side}"]
            # A palma fica `HAND_GRIP_REACH` adiante do punho, na direção do
            # próprio bone — que no Blender aponta no +Y local dele.
            direction = (bone.matrix.to_3x3() @ Vector((0.0, 1.0, 0.0))).normalized()
            got[side] = bone.matrix.translation + direction * HAND_GRIP_REACH
            worst = max(worst, (got[side] - grip_target(t, side)).length)
        spans.append((got["L"] - got["R"]).length)

    scene.frame_set(0)
    return {
        "action": ACTION_NAME,
        "hand_error_mm": round(worst * 1000, 3),
        "span_drift_mm": round((max(spans) - min(spans)) * 1000, 3),
        "span_mean_cm": round(sum(spans) / len(spans) * 100, 2),
    }
