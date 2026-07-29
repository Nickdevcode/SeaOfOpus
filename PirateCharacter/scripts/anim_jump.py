"""Pulo: dois clipes que cobrem um salto inteiro, do desprendimento ao pouso.

Um pulo não é um clipe. Andar e correr são ciclos fechados e cabem num arquivo
cada; um salto tem **duração que o jogo decide**, não o animador — o mesmo pulo
dura 0,67 s no convés e três segundos se o sujeito se joga do cesto da gávea. Um
clipe único só funcionaria se toda queda tivesse a mesma altura.

| clipe | quando | como toca |
|---|---|---|
| `JumpAir` | do desprendimento ao contato | **pela velocidade vertical**, não pelo tempo |
| `JumpLand` | tocou o chão | uma vez, 14 quadros |

O `JumpAir` é o que interessa. Ele não roda: ele é **lido**. A fase 0 é o instante
em que o pé larga o convés, 0,5 é o ápice, 1,0 é caindo à velocidade com que se
saltou — e quem escolhe o ponto é `velocity.y` (`air_phase`), exatamente como o
`PlayerAvatar` já faz com o `GaitClock` e os clipes de marcha. É a mesma ideia
pela mesma razão: pose que sai do estado físico não tem como discordar dele. Um
clipe de ar rodando no tempo próprio aterrissaria no meio do ápice num pulinho e
faria três voltas de tuck numa queda longa. Lido pela velocidade, ele satura
sozinho: quem cai do mastro passa a queda inteira na pose do quadro final, com as
pernas já estendidas para receber o chão.

**Por que não há clipe de impulso.** Houve, e ele estava errado. No jogo o pulo é
instantâneo: no quadro em que a tecla desce, `velocity.y` já vale 3,3 m/s e
`grounded` já é falso (`PlayerController`). Não existe janela de antecipação — e
um `JumpStart` que começasse agachado teria de agachar 11 cm no mesmo quadro em
que o motor começa a levantar o corpo, um tranco para baixo durante uma subida.
Pior, os 0,2 s que ele ocupava eram 0,2 s de voo: quando terminasse, a velocidade
já teria caído para 1,34 m/s e o `JumpAir` entraria na fase 0,297, deixando 30%
do clipe sem uso e a emenda num ponto arbitrário da curva.

A saída é a que os jogos usam quando o pulo é instantâneo: o impulso não se
mostra **antes**, mostra-se **depois**. A fase 0 do `JumpAir` já é a pose de
desprendimento — corpo no alto, perna estendida, pé na ponta com os dedos ainda
dobrados —, e os primeiros 30% são a perna terminando de empurrar e começando a
recolher. É a mesma leitura de força, sem dever um quadro sequer ao jogo.

Essa pose de saída não foi escolhida no olho: `TOEOFF_BODY_Z` e `TOEOFF_ANKLE_Z`
foram **medidos** no rig com `ankle_height`, e são o limite do que a perna
alcança com a sola ainda no convés. Um centímetro acima e o pé descolava antes da
hora; o corpo enterrava a bota 5 cm no assoalho na primeira versão deste arquivo,
justamente por chutar esse número.

`JumpLand` é o único que resolve o pé **contra o convés** (`grounded`): lá o
tornozelo não fica onde se manda, fica na altura que põe a *sola* em Z = 0 para
aquela inclinação de pé. No ar não há convés nenhum para servir de referência, e
as pernas se movem em relação ao corpo.

As emendas foram costuradas à mão e valem conferir se alguém mexer nos números:

- fim do `JumpAir` == começo do `JumpLand`: mesmo tornozelo (a largura de apoio
  do `anim_idle`), mesmo `root`. O contato não teleporta o pé.
- fim do `JumpLand` == quadro 0 do `Idle`: mesma altura de corpo, mesmos braços.
  Sem isso o personagem dá um solavanco ao voltar a respirar.

Convenções do rig, como no resto da pasta: o personagem olha para **-Y**,
1 unidade = 1 metro, chão em Z = 0.
"""

from __future__ import annotations

import math
from dataclasses import dataclass

import bpy
from mathutils import Matrix, Vector

import anim_gait
import anim_idle

FPS = 30

#: Velocidade de saída e gravidade do jogo (`PlayerController.JUMP_SPEED` e
#: `MathUtils.GRAVITY`). Não são usados para animar nada — o deslocamento é do
#: motor —, mas são eles que dimensionam os tempos: 0,673 s de voo e 55 cm de
#: altura — e é dela que sai `air_phase`, que escolhe o quadro do `JumpAir`.
JUMP_SPEED = 3.3
GRAVITY = 9.81

#: Quanto a perna pode esticar. Mesmo teto das marchas: 100% trava o joelho e
#: denuncia a IK, e num pulo o joelho estendido aparece muito mais que andando.
LEG_EXTENSION_LIMIT = 0.985

#: Onde os pés ficam quando ele está de pé. Vem do `anim_idle` de propósito: é o
#: que faz o pé não pular de lugar na emenda com o clipe parado, nas duas pontas.
STANCE_WIDTH = anim_idle.STANCE_WIDTH
FOOT_STAGGER = anim_idle.FOOT_STAGGER

#: Altura do corpo no quadro 0 do `Idle`, para o pouso terminar exatamente nela.
#: O `Idle` começa no fim da expiração, então leva o `BREATH_RISE` junto.
IDLE_BODY_Z = -anim_idle.BODY_SETTLE - anim_idle.BREATH_RISE
#: Braços no quadro 0 do `Idle` — mesma conta, mesma razão.
IDLE_ARM_DROP = anim_idle.ARM_DROP - anim_idle.ARM_DRIFT
IDLE_ELBOW = anim_idle.ELBOW_REST - anim_idle.ARM_DRIFT * 0.5

#: Altura do tornozelo nas duas emendas com o `JumpAir`, medida no rig com
#: `ankle_height` — o pé inclinado move a sola, e chutar estes números é o
#: caminho mais curto para enterrar a bota no convés.
#:
#: Na saída, o pé está na ponta (52°/56°, com os dedos desdobrando) e o tornozelo
#: sobe 7 cm acima do repouso. Na chegada, a ponta está levemente para cima
#: (-8°/-4°) e ele volta para perto do repouso.
TOEOFF_ANKLE_Z = {"L": 0.1955, "R": 0.1971}
CONTACT_ANKLE_Z = {"L": 0.1296, "R": 0.1256}

#: Altura do corpo no instante do contato. Zero cabe — a perna fica a 98,5%
#: exatos, que é o limite —, e ficar no limite é a IK clampando: 1,2 cm abaixo
#: compra a folga e ainda deixa o joelho com o que dobrar ao receber o peso.
CONTACT_BODY_Z = -0.012
#: Teto do corpo no desprendimento, também medido. Acima disto a perna não
#: alcança mais o convés e o pé descola antes da hora.
TOEOFF_BODY_Z = 0.060


# -- descrição de um clipe ----------------------------------------------------


#: Uma trilha é uma sequência de `(fase, valor)`. Entre chaves interpola-se com
#: `smoothstep`, então a pose nunca chega nem sai de uma chave com tranco.
Track = tuple[tuple[float, float], ...]


@dataclass(frozen=True)
class JumpPhase:
    """Um dos três clipes, descrito inteiro em trilhas.

    Manter os três na mesma estrutura não é elegância à toa: o que muda entre
    eles é só o conteúdo das trilhas e o `grounded`, então quem for afinar o
    pulo mexe em números, não em código.
    """

    action_name: str
    frames: int

    #: Altura do corpo, como deslocamento do `root` em metros.
    body: Track
    #: Inclinação do tronco para a frente, em graus, distribuída pela coluna.
    lean: Track
    #: Quanto a cabeça olha para baixo, além do que o tronco já pede.
    head_pitch: Track

    arm_drop: Track
    #: Positivo leva o braço para **trás** (o rig olha para -Y).
    arm_swing: Track
    elbow: Track

    #: Alvo do tornozelo por lado. X é sempre positivo aqui; o lado direito
    #: espelha. Com `grounded`, o Z destas chaves é ignorado.
    ankle_l: tuple[tuple[float, tuple[float, float, float]], ...]
    ankle_r: tuple[tuple[float, tuple[float, float, float]], ...]

    #: Ângulo do pé em graus, positivo com a ponta para baixo.
    foot_l: Track
    foot_r: Track
    #: Dobra do metatarso. Só o impulso usa: enquanto o calcanhar sobe, os dedos
    #: continuam no convés, e é essa dobra que cancela a inclinação do pé.
    toe_l: Track = ((0.0, 0.0),)
    toe_r: Track = ((0.0, 0.0),)

    #: Se o pé está no chão. Muda quem manda no Z do tornozelo: com o pé
    #: plantado, ele sai de `ankle_height`, que põe a **sola** no convés em vez
    #: do osso — a diferença que já custou 1,68 cm de bota enterrada na
    #: caminhada.
    grounded: bool = False

    @property
    def seconds(self) -> float:
        return self.frames / FPS


def track(keys: Track, t: float) -> float:
    """Valor da trilha na fase *t*."""
    if t <= keys[0][0]:
        return keys[0][1]
    for (t0, v0), (t1, v1) in zip(keys, keys[1:]):
        if t <= t1:
            return v0 + (v1 - v0) * anim_gait.smoothstep((t - t0) / (t1 - t0))
    return keys[-1][1]


def track_vector(keys, t: float) -> Vector:
    """Mesma interpolação, componente a componente."""
    flat = [tuple((k, v[i]) for k, v in keys) for i in range(3)]
    return Vector(tuple(track(f, t) for f in flat))


# -- os dois clipes -----------------------------------------------------------


#: **No ar.** A fase, não o tempo, é o eixo: 0 é o pé largando o convés a 3,3 m/s,
#: 0,5 é o ápice, 1 é caindo à mesma velocidade com que se saltou. Vinte e quatro
#: quadros são a resolução da curva, não a duração do voo.
#:
#: O primeiro terço é o impulso, mostrado depois de acontecer (ver o topo do
#: arquivo): corpo no alto, perna estendida, pé na ponta com os dedos ainda
#: dobrados de empurrar, braços lançados. Só então as pernas recolhem.
#:
#: As duas pernas fazem coisas diferentes de propósito. Simétrico lê como boneco
#: caindo; uma perna recolhida à frente e a outra estendida atrás lê como alguém
#: que saltou. No fim as duas se juntam na largura de apoio do `Idle`, que é
#: onde o pouso vai encontrá-las.
AIR = JumpPhase(
    action_name="JumpAir",
    frames=24,
    # Sai da altura máxima que a perna alcança com a sola ainda no convés e volta
    # para a do contato. As duas pontas são emendas medidas, não escolhas.
    body=((0.0, TOEOFF_BODY_Z), (0.30, 0.0), (1.0, CONTACT_BODY_Z)),
    lean=((0.0, 6.0), (0.42, 13.0), (1.0, 10.0)),
    head_pitch=((0.0, -2.0), (0.42, 0.0), (1.0, 7.0)),
    # Os braços chegam do `Idle` e só então completam o lançamento, no quadro 3.
    # Partir já no extremo (-58°) obrigaria a mistura a cobrir 58° num quadro, e
    # o que se veria é o braço saltando de posição em vez de sendo atirado.
    # Abertos no ápice: é o que o corpo faz quando não tem nada em que se apoiar.
    arm_drop=((0.0, 56.0), (0.14, 46.0), (0.42, 44.0), (1.0, 56.0)),
    arm_swing=((0.0, -34.0), (0.14, -58.0), (0.42, -8.0), (1.0, -34.0)),
    elbow=((0.0, 28.0), (0.14, 20.0), (0.42, 52.0), (1.0, 42.0)),
    ankle_l=((0.0, (STANCE_WIDTH, -FOOT_STAGGER, TOEOFF_ANKLE_Z["L"])),
             (0.42, (0.175, -0.270, 0.500)),
             (0.72, (0.182, -0.190, 0.380)),
             (1.0, (STANCE_WIDTH, -FOOT_STAGGER, CONTACT_ANKLE_Z["L"]))),
    ankle_r=((0.0, (STANCE_WIDTH, FOOT_STAGGER, TOEOFF_ANKLE_Z["R"])),
             (0.42, (0.172, 0.160, 0.340)),
             (0.72, (0.180, 0.100, 0.260)),
             (1.0, (STANCE_WIDTH, FOOT_STAGGER, CONTACT_ANKLE_Z["R"]))),
    # A ponta desce no impulso e sobe de novo na descida: pé de ponta para baixo
    # na hora do contato é tornozelo torcido.
    foot_l=((0.0, 52.0), (0.42, 16.0), (1.0, -8.0)),
    foot_r=((0.0, 56.0), (0.42, 34.0), (1.0, -4.0)),
    # Os dedos largam a dobra do impulso, mas não de um quadro para o outro.
    toe_l=((0.0, -30.0), (0.25, 0.0)),
    toe_r=((0.0, -32.0), (0.25, 0.0)),
)

#: **Pouso.** Aqui o pé está no convés de novo e não sai mais dele: os alvos são
#: fixos, e quem se move é o corpo. Catorze quadros, 0,47 s — o contato e a
#: absorção levam um terço disso, o resto é a volta ao normal.
#:
#: O último quadro **é** o quadro 0 do `Idle`, altura de corpo e braços
#: inclusive. É a diferença entre o personagem voltar a respirar e o personagem
#: dar um tranco ao chegar.
LAND = JumpPhase(
    action_name="JumpLand",
    frames=14,
    # 21,5 cm de absorção. É perna dobrando de verdade, não um agachinho: quem
    # cai de 55 cm e não dobra o joelho quebra alguma coisa.
    body=((0.0, CONTACT_BODY_Z), (0.28, -0.215), (0.62, -0.075), (1.0, IDLE_BODY_Z)),
    lean=((0.0, 12.0), (0.28, 28.0), (0.65, 8.0), (1.0, 2.0)),
    head_pitch=((0.0, 6.0), (0.28, 9.0), (1.0, 0.0)),
    # Os braços vão para trás na absorção — o contrapeso que impede o tronco de
    # continuar caindo para a frente.
    arm_drop=((0.0, 48.0), (0.28, 62.0), (1.0, IDLE_ARM_DROP)),
    arm_swing=((0.0, -45.0), (0.28, 38.0), (0.65, 6.0), (1.0, 0.0)),
    elbow=((0.0, 30.0), (0.28, 62.0), (0.65, 34.0), (1.0, IDLE_ELBOW)),
    # Z ignorado: com `grounded`, quem manda é a altura da sola.
    ankle_l=((0.0, (STANCE_WIDTH, -FOOT_STAGGER, 0.0)),),
    ankle_r=((0.0, (STANCE_WIDTH, FOOT_STAGGER, 0.0)),),
    # Toca com a ponta um pouco para cima e assenta. Aterrissar de pé plano é o
    # que faz o pouso parecer um saco caindo.
    foot_l=((0.0, -8.0), (0.30, 0.0), (1.0, 0.0)),
    foot_r=((0.0, -4.0), (0.30, 0.0), (1.0, 0.0)),
    grounded=True,
)

PHASES = (AIR, LAND)


# -- construção ---------------------------------------------------------------


def _pose_torso(pose, lean: float, head_pitch: float) -> None:
    """Tronco e cabeça. A inclinação é repartida pela coluna, não concentrada.

    Concentrar num bone só faz um vinco no casaco em vez de um tronco inclinado —
    a mesma razão de `anim_gait.pose_spine`.
    """
    pose["pelvis"].rotation_quaternion = anim_gait.world_rotation(
        pose["pelvis"], [("X", -lean * 0.10)])

    for name, share in (("spine_01", 0.30), ("spine_02", 0.35), ("spine_03", 0.35)):
        pose[name].rotation_quaternion = anim_gait.world_rotation(
            pose[name], [("X", -lean * share)])

    # O pescoço desfaz parte da inclinação: o olhar fica no horizonte, que é o
    # que um pescoço faz de verdade. `head_pitch` é o que se quer *além* disso.
    pose["neck"].rotation_quaternion = anim_gait.world_rotation(
        pose["neck"], [("X", lean * 0.55 + head_pitch * 0.5)])
    pose["head"].rotation_quaternion = anim_gait.world_rotation(
        pose["head"], [("X", lean * 0.45 + head_pitch * 0.5)])


def _pose_arms(pose, drop: float, swing: float, elbow: float) -> None:
    """Braços, na mesma convenção de `anim_gait.pose_arms`.

    `drop` desce da T-pose, `swing` gira no plano sagital (positivo para trás) e
    `elbow` dobra o cotovelo para a frente.
    """
    for side in ("L", "R"):
        sign = 1.0 if side == "L" else -1.0
        rest_dir = Vector((sign, 0.0, 0.0))
        dropped = Matrix.Rotation(math.radians(drop * sign), 3, "Y") @ rest_dir

        arm_dir = anim_gait.rotate_x(dropped, swing)
        forearm_dir = anim_gait.rotate_x(dropped, swing - elbow)

        anim_gait.aim_bone(pose[f"upperarm.{side}"], arm_dir)
        bpy.context.view_layer.update()
        anim_gait.aim_bone(pose[f"lowerarm.{side}"], forearm_dir,
                           pose[f"lowerarm.{side}"].matrix.translation.copy())
        bpy.context.view_layer.update()
        anim_gait.aim_bone(pose[f"hand.{side}"], forearm_dir,
                           pose[f"hand.{side}"].matrix.translation.copy())


def _pose_leg(pose, data: dict, side: str, ankle: Vector,
              foot_pitch: float, toe_pitch: float) -> float:
    """Uma perna por IK contra *ankle*. Devolve o erro de posição do tornozelo.

    O erro é a prova de que a pose é alcançável: se a perna não chega ao alvo, o
    `solve_leg` clampa e a pose que se vê não é a que se pediu.
    """
    thigh = pose[f"thigh.{side}"]
    hip = thigh.matrix.translation.copy()

    knee = anim_gait.solve_leg(hip, ankle, data["femur"], data["tibia"],
                               LEG_EXTENSION_LIMIT, Vector((0.0, -1.0, 0.0)))
    anim_gait.aim_bone(thigh, knee - hip, hip)
    bpy.context.view_layer.update()

    calf = pose[f"calf.{side}"]
    anim_gait.aim_bone(calf, ankle - knee, calf.matrix.translation.copy())
    bpy.context.view_layer.update()

    foot = pose[f"foot.{side}"]
    error = (foot.matrix.translation - ankle).length
    anim_gait.aim_bone(foot, anim_gait.rotate_x(data["foot_dir"], foot_pitch),
                       foot.matrix.translation.copy())
    bpy.context.view_layer.update()

    toe = pose[f"toe.{side}"]
    anim_gait.aim_bone(toe, anim_gait.rotate_x(data["toe_dir"],
                                               foot_pitch + toe_pitch),
                       toe.matrix.translation.copy())
    return error


def _new_action(arm, name: str):
    """Action limpa com o nome dado, ligada ao rig."""
    if arm.animation_data is None:
        arm.animation_data_create()
    old = bpy.data.actions.get(name)
    if old is not None:
        bpy.data.actions.remove(old)
    action = bpy.data.actions.new(name)
    action.use_fake_user = True             # sem isso a action some ao reabrir
    arm.animation_data.action = action
    return action


def build_phase(phase: JumpPhase, arm=None, metrics: dict | None = None) -> dict:
    """Gera a action de um dos dois clipes."""
    arm = arm or bpy.data.objects[anim_gait.ARMATURE_NAME]
    metrics = metrics or anim_gait.rest_metrics(arm)

    scene = bpy.context.scene
    scene.render.fps = FPS
    # Como nos ciclos, o clipe começa no quadro **0**: o exportador glTF divide
    # o número do quadro pelo fps, e começar no 1 põe o primeiro keyframe em
    # t = 0,033 s — um quadro parado no início de cada pulo.
    scene.frame_start = 0
    scene.frame_end = phase.frames

    anim_gait.clear_pose(arm)
    action = _new_action(arm, phase.action_name)
    pose = arm.pose.bones

    foot_error = 0.0
    heights = []
    for frame in range(0, phase.frames + 1):
        t = frame / phase.frames
        scene.frame_set(frame)

        body_z = track(phase.body, t)
        anim_gait.aim_root(pose["root"], {"sway": 0.0, "yaw": 0.0}, body_z)
        bpy.context.view_layer.update()

        _pose_torso(pose, track(phase.lean, t), track(phase.head_pitch, t))
        bpy.context.view_layer.update()

        clearance = float("inf")
        for side, ankle_keys, foot_keys, toe_keys in (
                ("L", phase.ankle_l, phase.foot_l, phase.toe_l),
                ("R", phase.ankle_r, phase.foot_r, phase.toe_r)):
            target = track_vector(ankle_keys, t)
            if side == "R":
                target.x = -target.x
            foot_pitch = track(foot_keys, t)
            toe_pitch = track(toe_keys, t)

            if phase.grounded:
                # Com o pé no convés, a altura do tornozelo não se escolhe: ela
                # é o que põe a **sola** em Z = 0 com o pé naquela inclinação.
                target.z = anim_gait.ankle_height(metrics[side]["sole"],
                                                  foot_pitch, toe_pitch, 0.0)

            foot_error = max(foot_error, _pose_leg(pose, metrics[side], side,
                                                   target, foot_pitch, toe_pitch))
            # Quanto a sola sobra do convés. `ankle_height` devolve a altura de
            # tornozelo que encosta a sola no chão, então a diferença para a
            # altura de fato **é** a folga — sem repetir o skinning aqui.
            clearance = min(clearance, target.z - anim_gait.ankle_height(
                metrics[side]["sole"], foot_pitch, toe_pitch, 0.0))

        _pose_arms(pose, track(phase.arm_drop, t), track(phase.arm_swing, t),
                   track(phase.elbow, t))
        bpy.context.view_layer.update()

        heights.append(clearance)
        anim_gait._key_frame(arm, frame)

    anim_gait._linear_curves(action)
    scene.frame_set(0)

    return {
        "action": phase.action_name,
        "frames": phase.frames,
        "seconds": round(phase.seconds, 3),
        "grounded": phase.grounded,
        # Se a IK não alcançou o alvo, a pose não é a que está descrita acima.
        "foot_error_mm": round(foot_error * 1000, 3),
        # Quanto a sola mais baixa fica do convés. No pouso tem de ser ~zero no
        # primeiro quadro; no ar é a altura a que ele recolheu as pernas.
        "sole_clearance_cm": [round(h * 100, 2) for h in heights],
    }


def build(arm=None) -> dict:
    """Gera os clipes do pulo e devolve o relatório de cada um."""
    arm = arm or bpy.data.objects[anim_gait.ARMATURE_NAME]
    metrics = anim_gait.rest_metrics(arm)

    report = {"clips": [build_phase(p, arm, metrics) for p in PHASES]}
    report["flight_seconds"] = round(2.0 * JUMP_SPEED / GRAVITY, 3)
    report["apex_m"] = round(JUMP_SPEED ** 2 / (2.0 * GRAVITY), 3)
    report["air_phase_note"] = "fase = 0.5 * (1 - velocity.y / 3.3), saturada"
    return report


# -- fase do ar a partir da física -------------------------------------------


def air_phase(vertical_speed: float) -> float:
    """Onde ler o `JumpAir` para uma velocidade vertical dada, em [0, 1].

    É a mesma conta que o jogo vai fazer, e está aqui para o preview usar a
    física de verdade em vez de um palpite — se a curva parecer errada rodando,
    é porque está errada, e não porque o preview mentiu.
    """
    return min(max(0.5 * (1.0 - vertical_speed / JUMP_SPEED), 0.0), 1.0)


def timeline(idle_in: int = 5, idle_out: int = 8) -> list[tuple[str, float, float]]:
    """O pulo inteiro como o jogo vai tocá-lo: `(action, quadro, altura)`.

    Existe porque um clipe de pulo **não se julga no Blender**. Os três clipes
    rodam parados no lugar; quem levanta o personagem do convés é o motor, e
    olhar `JumpAir` sozinho na linha do tempo mostra alguém fazendo caretas em pé.
    Aqui a parábola de verdade (3,3 m/s, 9,81 m/s²) entra por cima, e a fase do ar
    sai da velocidade vertical, como sairá em jogo.

    É também o teste que importa: se as emendas estiverem tortas, é aqui que o
    tranco aparece — e não no clipe isolado, onde tudo parece bem.
    """
    dt = 1.0 / FPS
    frames = [("Idle", float(f), 0.0) for f in range(idle_in)]

    # No ar desde o primeiro quadro: a tecla e a velocidade acontecem no mesmo
    # quadro, então não há impulso a mostrar antes. O quadro do clipe sai da
    # velocidade, não do relógio — é o que faz o mesmo clipe servir a um pulinho
    # e a uma queda do cesto da gávea.
    f = 0
    while True:
        t = f * dt
        height = JUMP_SPEED * t - 0.5 * GRAVITY * t * t
        if height <= 0.0 and f > 0:
            break
        frames.append((AIR.action_name, air_phase(JUMP_SPEED - GRAVITY * t) * AIR.frames,
                       height))
        f += 1

    frames += [(LAND.action_name, float(f), 0.0) for f in range(LAND.frames + 1)]
    frames += [("Idle", float(f), 0.0) for f in range(idle_out)]
    return frames


def _assign_action(arm, name: str) -> None:
    """Troca a action ativa do rig, com o slot que o Blender 4.4+ exige.

    Sem o slot a action fica atribuída e **não avalia**: o personagem congela na
    pose de repouso e o preview sai com uma T-pose no meio do pulo.
    """
    action = bpy.data.actions[name]
    arm.animation_data.action = action
    slots = getattr(action, "slots", None)
    if slots:
        arm.animation_data.action_slot = slots[0]


#: Prefixo que marca o que é andaime e não asset. O `export.py` apaga tudo o que
#: começa com isto antes de gerar o GLB: a action de preview move o **objeto**
#: armature, e um clipe desses dentro do jogo levantaria o personagem uma segunda
#: vez, por cima do que a física já faz. Perder não é problema — `bake_preview`
#: reconstrói em dois segundos, porque é derivada e não fonte.
PREVIEW_PREFIX = "_"
PREVIEW_ACTION = "_JumpPreview"


def bake_preview(arm=None) -> dict:
    """Assa a `timeline` inteira numa action só, para dar Play dentro do Blender.

    Existe porque nenhum dos dois clipes se deixa julgar sozinho na linha do
    tempo: eles animam o corpo **parado no lugar**, e quem levanta o personagem é
    o motor. Apertar Play no `JumpAir` mostra alguém fazendo caretas em pé.

    Aqui a parábola de verdade entra como translação do objeto e as poses são
    amostradas do clipe certo, no quadro certo — a mesma montagem que o preview
    renderizado usa, só que navegável: dá para pausar, girar a câmera e voltar
    quadro a quadro, que é o que falta num GIF.

    Não vai para o jogo. Ver `PREVIEW_PREFIX`.
    """
    arm = arm or bpy.data.objects[anim_gait.ARMATURE_NAME]
    shots = timeline()

    names = (list(anim_gait.KEYED_BONES)
             + [f"{n}.{s}" for n in anim_gait.KEYED_SIDED for s in ("L", "R")])
    scene = bpy.context.scene
    if arm.animation_data is None:
        arm.animation_data_create()
    previous = arm.animation_data.action

    # Duas passadas, e não uma: escrever a pose na action nova enquanto se lê da
    # antiga faria a leitura seguinte vir da action que já se está sobrescrevendo.
    sampled = []
    for action_name, frame, lift in shots:
        _assign_action(arm, action_name)
        scene.frame_set(int(frame), subframe=frame % 1.0)
        bpy.context.view_layer.update()
        sampled.append((
            {n: arm.pose.bones[n].rotation_quaternion.copy() for n in names},
            arm.pose.bones["root"].location.copy(),
            lift,
        ))

    action = _new_action(arm, PREVIEW_ACTION)
    for index, (pose, root_location, lift) in enumerate(sampled):
        for name, rotation in pose.items():
            arm.pose.bones[name].rotation_quaternion = rotation
        arm.pose.bones["root"].location = root_location
        arm.location.z = lift
        anim_gait._key_frame(arm, index)
        arm.keyframe_insert("location", frame=index)

    anim_gait._linear_curves(action)
    scene.frame_start, scene.frame_end = 0, len(shots) - 1
    scene.render.fps = FPS
    scene.frame_set(0)

    return {
        "action": action.name,
        "frames": len(shots),
        "seconds": round(len(shots) / FPS, 3),
        "frame_range": [scene.frame_start, scene.frame_end],
        # A action de preview fica ativa de propósito — é para dar Play. Isto
        # aqui é só o registro de qual clipe estava no rig antes.
        "was_playing": previous.name if previous else None,
        "note": "andaime — apagado pelo export.py, recriável com bake_preview()",
    }


def _temp_ground(size: float = 6.0):
    """Um piso em Z = 0 só para o preview, devolvido para quem tem de apagá-lo.

    Sem ele o preview é inútil para o que se quer julgar aqui: um personagem
    recortado no vazio não mostra altura de pulo nenhuma, e foi assim que a
    primeira leva de quadros saiu. Não entra no `.blend` — o `render` apaga no
    `finally`.
    """
    mesh = bpy.data.meshes.new("__JumpPreviewGround")
    half = size / 2.0
    mesh.from_pydata([(-half, -half, 0.0), (half, -half, 0.0),
                      (half, half, 0.0), (-half, half, 0.0)], [], [(0, 1, 2, 3)])
    mesh.update()

    material = bpy.data.materials.new("__JumpPreviewGroundMat")
    material.use_nodes = True
    bsdf = material.node_tree.nodes["Principled BSDF"]
    # Escuro de propósito: o convés aqui é régua, não cenário, e um piso claro
    # rouba a leitura da silhueta que se está tentando julgar.
    bsdf.inputs["Base Color"].default_value = (0.16, 0.13, 0.10, 1.0)
    bsdf.inputs["Roughness"].default_value = 0.9
    mesh.materials.append(material)

    obj = bpy.data.objects.new("__JumpPreviewGround", mesh)
    bpy.context.scene.collection.objects.link(obj)
    return obj, mesh, material


#: Vistas próprias, e não as do `anim_preview`, por causa do piso. A lateral de
#: lá é ortográfica pura, e um plano horizontal visto exatamente de canto é uma
#: linha de espessura zero: o convés simplesmente sumia do quadro. Cinco graus
#: bastam para ele virar uma faixa e a altura do pulo ficar mensurável a olho.
VIEWS = {
    "side": ("LEFT", 0.0, 0.09),
    "quarter": ("LEFT", 0.70, 0.22),
}


def render(out_dir: str, width: int = 460, height: int = 700,
           views=("side", "quarter"), zoom: float = 0.72,
           raise_pivot: float = 0.30) -> dict:
    """Renderiza a `timeline` em cada vista, um PNG por quadro.

    Só cospe os quadros; quem monta o GIF é o `ffmpeg` de fora, como no
    `anim_preview` — o Blender da Steam vem sem FFMPEG compilado.
    """
    import os

    import anim_preview

    scene = bpy.context.scene
    arm = bpy.data.objects[anim_gait.ARMATURE_NAME]
    mesh = bpy.data.objects[anim_gait.MESH_NAME]
    shots = timeline()
    ground, ground_mesh, ground_material = _temp_ground()

    win, area, region = anim_preview._viewport()
    space = area.spaces.active

    bpy.ops.object.select_all(action="DESELECT")
    mesh.select_set(True)
    bpy.context.view_layer.objects.active = mesh

    scene.render.resolution_x, scene.render.resolution_y = width, height
    scene.render.resolution_percentage = 100
    scene.render.image_settings.file_format = "PNG"
    scene.render.image_settings.color_mode = "RGB"

    previous = (space.shading.type, space.overlay.show_overlays,
                arm.location.z, arm.animation_data.action)
    space.shading.type = "MATERIAL"
    space.overlay.show_overlays = False

    written = {}
    try:
        with bpy.context.temp_override(window=win, area=area, region=region):
            for name in views:
                axis, orbit_x, orbit_y = VIEWS[name]
                bpy.ops.view3d.view_axis(type=axis)
                if orbit_x:
                    bpy.ops.view3d.view_orbit(angle=orbit_x, type="ORBITLEFT")
                if orbit_y:
                    bpy.ops.view3d.view_orbit(angle=orbit_y, type="ORBITUP")
                bpy.ops.view3d.view_selected()
                # O enquadramento é fixo o clipe inteiro, e é escolhido com o
                # personagem parado: seguir o personagem esconderia justamente o
                # que se quer ver, que é ele subindo.
                space.region_3d.view_distance *= zoom
                space.region_3d.view_location.z += raise_pivot

                for index, (action, frame, lift) in enumerate(shots):
                    _assign_action(arm, action)
                    scene.frame_set(int(frame), subframe=frame % 1.0)
                    arm.location.z = lift
                    scene.render.filepath = os.path.join(out_dir, name,
                                                         f"f_{index:04d}")
                    bpy.ops.render.opengl(write_still=True, view_context=True)
                written[name] = len(shots)
    finally:
        # O deslocamento é do preview, não do asset: deixá-lo no rig exportaria
        # um personagem flutuando.
        space.shading.type, space.overlay.show_overlays = previous[0], previous[1]
        arm.location.z = previous[2]
        if previous[3] is not None:
            _assign_action(arm, previous[3].name)
        scene.frame_set(0)
        bpy.data.objects.remove(ground)
        bpy.data.meshes.remove(ground_mesh)
        bpy.data.materials.remove(ground_material)

    written["frames"] = len(shots)
    written["seconds"] = round(len(shots) / FPS, 3)
    return written
