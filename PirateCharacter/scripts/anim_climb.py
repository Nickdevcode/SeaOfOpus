"""Escalada: um ciclo, quatro pegadas e a grade de degraus do navio.

Subir escada é o primo vertical da caminhada, e tem o mesmo defeito capital: se o
contato escorrega, morre. Andando é o pé que patina no convés; aqui são **quatro**
pontos ao mesmo tempo, e a mão deslizando 5 cm por degrau é mais óbvia do que
qualquer coisa que a marcha já produziu — porque o degrau está lá, na tela, como
régua.

A saída é a mesma do `anim_gait`, e por isso este arquivo não inventa motor
nenhum: **a fase avança pela altura vencida, não pelo relógio**. Durante o apoio,
o degrau está parado no mundo, então no referencial do corpo ele desce numa reta,
na velocidade exata da subida. É uma linha de código (`z_grab - CYCLE_RISE * k`) e
é ela que garante contato limpo em qualquer velocidade que o `PlayerController`
resolva usar.

## Por que o ciclo mede exatamente dois degraus

Porque a escada é real e tem medida. Em `src/ship/ShipParts.ts` a escada do mastro
vai de `DECK_Y` = 1,30 a `CROW_NEST_Y + 0,15` = 10,40, com
``rungs = round(9,10 / 0,3)`` = 30 vãos — logo **30,33 cm** entre degraus, e não os
30 redondos que a fórmula sugere. Quem sobe pega um degrau de cada vez: a mão
direita passa da barra 5 para a 7, o corpo sobe uma barra; depois a esquerda faz o
mesmo. Ciclo fechado = dois degraus = **60,67 cm**, e cada membro avança dois
degraus por volta enquanto os pés ficam sempre separados por um.

Esse número não é decorativo. Ele é o que permite ao runtime **casar a fase com a
altura absoluta** ao agarrar a escada: como a subida por ciclo é um múltiplo
inteiro do espaçamento, acertar uma vez é acertar para sempre, e a mão do
personagem cai em cima da barra que está desenhada ali — não entre duas.

## A diagonal

Mão direita com pé esquerdo, mão esquerda com pé direito: é como gente sobe, e é o
que mantém dois apoios opostos enquanto os outros dois viajam. A mão **lidera** o
pé em 0,15 do ciclo — primeiro a mão agarra alto, depois o pé sobe puxado por ela.
Sincronizar os quatro no mesmo instante dá aquele andar de brinquedo de corda.

As mãos ficam presas 0,58 do ciclo cada, então **sempre** há uma na escada e na
maior parte do tempo há duas. Os pés ficam 0,46 — menos de metade, de propósito:
existe um instante curto com os dois viajando, que é o que quem sobe depressa faz
de fato, pendurado pelos braços, e é o que impede o joelho de dobrar tanto que
vai bater na barra de cima.

## Descer é este clipe ao contrário

E não é preguiça. Os pontos de contato de uma descida têm de cair na **mesma**
grade de 30,33 cm da subida; um segundo clipe teria de reproduzir essa grade e
qualquer divergência apareceria como mão atravessando barra. Rodando o mesmo
ciclo com a fase decrescente — que é o que sai de graça quando ela é dirigida pela
altura — o contato é idêntico por construção. O gesto de escada é reversível de
verdade: o que muda numa descida real é para onde se olha, e a cabeça aqui fica
quase neutra justamente para servir aos dois sentidos.

## O que este clipe cobrou do resto do personagem

Escalar levanta o joelho a 90°, e nenhuma animação anterior chegava perto disso —
a caminhada levanta 30. Foi este clipe que expôs um defeito de skinning que
estava lá desde sempre: seis ilhas de aba, bolso e fralda do casaco tinham entre
65% e 97% de peso na **coxa**, herdado do vizinho mais próximo por
`_bind_islands_to_host` sem passar pela whitelist da peça. Andando isso quase não
aparecia; numa escada, meio guarda-roupa subia junto com a perna e a silhueta se
desmanchava na frente do quadril. A correção está no `build_rig.py`
(`_free_hip_shell_islands` e o filtro de whitelist no bind) e vale para todas as
animações — agachar e pular também melhoram.

## O que este clipe **não** faz

Não há `ClimbHold`. Parado na escada, o runtime congela a fase, e o personagem
fica exatamente onde estava — mãos e pés nas barras, zero deslizamento. Um clipe
de "agarrado respirando" só valeria como camada **aditiva**: como pose completa
ele mandaria as quatro pegadas para as barras *dele*, e a transição arrastaria as
mãos por até 15 cm. O motor não tem aditivo hoje, e um congelamento honesto vale
mais que uma respiração que escorrega.

Convenções do rig, como no resto da pasta: o personagem olha para **-Y**,
1 unidade = 1 metro, chão em Z = 0. Aqui o -Y aponta para a escada.
"""

from __future__ import annotations

import math
from dataclasses import dataclass

import bpy
from mathutils import Vector

import anim_gait

ACTION_NAME = "ClimbUp"

FPS = 30
#: 30 quadros = 1,0 s por ciclo, o que dá 0,607 m/s de subida nativa — dois
#: degraus por segundo, que é escalada rápida de gente com pressa. Não precisa
#: bater com a velocidade do jogo: quem manda na fase é a altura vencida, como
#: `WALK_CLIP.speed` já não bate com `WALK_SPEED`.
CYCLE_FRAMES = 30


# -- a escada de verdade ------------------------------------------------------

#: Medidas lidas de `src/ship/ShipParts.ts`. Estão aqui em cópia porque o Blender
#: não lê TypeScript, e comentadas porque um número solto vira mentira na
#: primeira vez que alguém mexer no navio: se a escada mudar, este clipe muda.
LADDER_BOTTOM_Y = 1.30                      # MAST_LADDER.bottomY (= DECK_Y)
LADDER_TOP_Y = 10.40                        # CROW_NEST_Y + 0.15
RUNG_COUNT = 30                             # round((topY - bottomY) / 0.3)
#: 30,33 cm — e não 30. O `round` do navio arredonda o **número de vãos**, então
#: o espaçamento que sobra não é o que a fórmula parece prometer.
RUNG_SPACING = (LADDER_TOP_Y - LADDER_BOTTOM_Y) / RUNG_COUNT
#: Quanto o corpo sobe num ciclo. Múltiplo inteiro do espaçamento de propósito.
CYCLE_RISE = 2.0 * RUNG_SPACING

RUNG_RADIUS = 0.026                         # meia espessura da barra
RUNG_HALF_WIDTH = 0.24                      # MAST_LADDER.halfWidth

#: Distância do eixo do corpo ao plano das barras. No rig a frente é -Y, então as
#: barras passam por aqui.
#:
#: O jogo usa **24 cm** hoje (`PlayerController.grabMastLadder`), e 24 não cabe:
#: o casaco deste pirata se projeta 24,8 cm à frente do eixo do rig na altura da
#: faixa, e a barra tem 2,6 cm de raio. Com o número antigo ele atravessa a
#: escada **parado**, antes de qualquer animação começar. Implementar este clipe
#: implica mudar aquele 0.24 para 0.29 lá também; é a única coisa que ele exige
#: do runtime além de tocá-lo.
#:
#: 29 cm é o mínimo que cabe, e vale a pena ficar no mínimo: cada centímetro a
#: mais afasta o corpo da escada e o gesto vai perdendo a leitura de escalada
#: para virar a de alguém pendurado longe. A 33 cm — onde este arquivo já esteve
#: — o pirata parecia sentado numa cadeira invisível.
LADDER_STANDOFF = 0.29
RUNG_Y = -LADDER_STANDOFF


# -- onde o corpo toca a barra ------------------------------------------------

#: Meia distância entre as mãos e entre os pés. As duas obedecem à mesma régua e
#: acabam em lugares opostos dela.
#:
#: O **pé** é limitado pela face interna do montante, em x = 0,24 - 0,038 =
#: 0,202: a bota mede 8,2 cm do tornozelo à borda externa, então pisar além de
#: 0,11 enfia o salto na madeira. Foi o que a medição achou com os pés na largura
#: da caminhada — 3,5 cm de bota dentro do montante.
#:
#: A **mão** obedece à mesma régua, e por pouco: com a pegada a 0,145 a medição
#: ainda encontra 1,2 cm de dedo dentro do montante, e a 0,185 são 2,8 cm — o
#: personagem passa a agarrar a madeira errada. 0,13 é o último valor que deixa
#: a mão inteira no vão livre.
HAND_X = 0.130
FOOT_X = 0.115

#: Distância do punho ao centro da barra agarrada, ao longo do antebraço.
#:
#: Quem segura o degrau é a **palma**, não o osso do punho — e a diferença não é
#: detalhe: este braço mede 60,8 cm do ombro ao punho, e mirar o punho na barra
#: em vez da palma joga fora 7 cm de alcance. Foi o que fez a primeira versão
#: deste arquivo pedir 103% do braço para agarrar a barra de cima, com a IK
#: clampando 2,8 cm de erro em plena pegada.
#:
#: O valor é o comprimento do bone da mão mais o raio da barra: os dedos
#: envolvem o degrau, então o centro dele cai um pouco além dos nós.
HAND_GRIP_REACH = 0.070

#: Onde a palma pousa em relação ao eixo da barra: em cima e um pouco atrás.
#: Mão agarrando por cima não centra o osso na madeira — e cravar a palma no
#: eixo empurra a barra para dentro do punho, que foi o que a medição de folga
#: pegou com 2,4 cm.
PALM_ABOVE_RUNG = 0.014
PALM_BEHIND_RUNG = 0.024

#: Onde o tornozelo fica em relação à barra que o pé pisa. A escada se sobe com
#: o **antepé**, não com o pé inteiro: a barra passa sob o metatarso, então o
#: tornozelo sobra 11,5 cm atrás dela e 9,8 cm acima.
ANKLE_ABOVE_RUNG = 0.098
ANKLE_BEHIND_RUNG = 0.145
#: Ponta levemente para baixo, calcanhar solto no ar. Pé plano numa barra de
#: 5 cm é pose de quem nunca subiu escada.
FOOT_PITCH = 16.0

#: Altura, no corpo, do degrau que o pé toma no instante em que o toma. É a
#: âncora de todas as outras: a grade inteira sai daqui.
#:
#: Não é escolha estética, é o meio da janela que a perna alcança. Com o quadril
#: em 0,90 e 0,788 m de perna, o tornozelo pode ir de ~0,13 (perna quase reta,
#: fim do apoio) a ~0,45 (joelho dobrado, recém-pousado) — e o joelho da ponta
#: de cima é o que decide: dobrado além disso ele avança e bate na barra
#: seguinte, por mais que a IK resolva a pose sem reclamar.
FOOT_RUNG_Z = 0.330
#: Onde se **quer** que a mão agarre. O valor de fato é este ajustado à grade
#: (ver `snap_rung`): a barra existe onde existe, não onde daria jeito.
HAND_RUNG_WISH = 1.920

#: Quanto do ciclo cada membro passa preso na barra.
#:
#: A mão fica **mais** que meio ciclo, e é isso que importa: em todo quadro há
#: pelo menos uma mão na escada, e na maior parte do tempo as duas. O pé fica
#: menos de meio ciclo de propósito — há um instante curto com os dois pés
#: viajando, que é o que acontece de verdade em quem sobe depressa pendurado
#: pelos braços, e é o que impede o joelho de dobrar tanto a ponto de bater na
#: barra de cima.
FOOT_STANCE = 0.46
HAND_STANCE = 0.58
#: Quanto a mão se antecipa ao pé do mesmo par diagonal.
HAND_LEAD = 0.15

#: Quanto o membro recua do plano das barras no meio da viagem — medido a partir
#: dele, e não em coordenada absoluta, para sobreviver a uma mudança de
#: `LADDER_STANDOFF`.
#:
#: O pé recua bem mais que a mão: ele passa **por trás** de um degrau inteiro no
#: caminho, e raspar nele é o erro mais visível que uma escalada pode ter.
HAND_SWING_BACK = 0.090
FOOT_SWING_BACK = 0.210
#: Quanto o membro se aproxima da linha do meio no auge da viagem.
SWING_NARROW = 0.95
HAND_SWING_Y = -LADDER_STANDOFF + HAND_SWING_BACK
FOOT_SWING_Y = -LADDER_STANDOFF + FOOT_SWING_BACK
#: Quanto o membro sobe além da reta no meio da viagem, para chegar por cima da
#: barra em vez de por baixo dela.
HAND_SWING_ARC = 0.030
FOOT_SWING_ARC = 0.045

#: Teto de extensão dos membros. O mesmo das marchas: 100% trava a articulação e
#: denuncia a IK — e aqui a perna de baixo passa perto disso todo ciclo.
LEG_EXTENSION_LIMIT = 0.985
ARM_EXTENSION_LIMIT = 0.980

#: Para onde apontam joelho e cotovelo. Não é detalhe de IK: é **postura**, e é
#: o que decide se o gesto lê como escalada ou como fantoche.
#:
#: O joelho aponta quase reto para a frente. Com o pé no degrau de cima a perna
#: dobra muito, e o joelho avança 30 cm à frente do quadril — não há como evitar
#: com esta perna e este vão; o que se escolhe é se ele avança **entre** as
#: barras (certo) ou de lado, contra o montante (errado). Um palmo de abertura
#: lateral basta para a canela não raspar a madeira.
#:
#: O cotovelo aponta para fora e principalmente para **baixo**. É o que mais
#: mudou nesta animação depois de ver o resultado: com o cotovelo jogado para
#: trás, o braço vira asa de galinha em todo quadro do apoio. Cotovelo caído é o
#: que sobra quando o peso do corpo está pendurado naquela mão.
KNEE_HINT = (0.15, -0.99, 0.0)
ELBOW_HINT = (0.55, 0.25, -0.80)


# -- postura ------------------------------------------------------------------

#: Quanto o corpo assenta em relação ao repouso. Negativo abaixa o quadril, o
#: que é o que compra alcance para a perna de baixo no fim do apoio dela.
BODY_SETTLE = -0.015
#: Meia amplitude do pulso vertical. O motor sobe em linha reta; é este pulso
#: que faz a subida parecer esforço em vez de elevador.
#:
#: A fase não é escolhida no olho: o corpo está **mais baixo** no instante em
#: que a mão agarra no alto e sobe enquanto ela puxa. Além de ser o que o corpo
#: faz, é o que empresta 3 cm de alcance justo onde o braço mais precisa.
BODY_PULSE = 0.035
#: Balanço lateral, para o lado do pé que sustenta.
BODY_SWAY = 0.020
#: Aproximação e afastamento da escada, no ritmo da mão que puxa.
#:
#: Perto quando a mão está alta, longe quando ela chega ao peito — e nessa
#: ordem, porque puxar traz o corpo para a escada. O ganho geométrico é o mesmo
#: do pulso: com o ombro perto, o braço alcança mais **acima**; com ele longe, a
#: mão de baixo não colapsa contra o próprio ombro.
BODY_SURGE = 0.022

#: Inclinação do tronco, em graus. Positivo joga o peito para a escada.
#:
#: Pouco, e por um motivo pouco óbvio: **inclinar o tronco empurra a barriga**.
#: O ponto mais avançado deste personagem fica na altura da faixa, a dez
#: centímetros do quadril, então cada grau de inclinação come folga contra a
#: barra sem trazer o ombro perto o bastante para compensar. Quem chega perto da
#: escada aqui é o corpo inteiro (`LADDER_STANDOFF`), não a coluna.
TORSO_LEAN = 6.0
#: Torção do tronco que leva à frente o ombro do braço que está alto.
TORSO_TWIST = 7.0
#: Queda do quadril para o lado da perna que viaja.
PELVIS_ROLL = 3.5
#: Torção do quadril: o lado da perna que viaja avança.
PELVIS_YAW = 5.0
#: Levantada e avanço do ombro do braço alto, em graus na clavícula.
#:
#: O ritmo escápulo-umeral: braço acima da cabeça não é só braço: o ombro sobe e
#: avança junto, e isso vale mais 5 cm de alcance. Ignorar essa parte é o que
#: faz personagem parecer que tem os braços pregados no tronco.
SHOULDER_RISE = 9.0
SHOULDER_REACH = 6.0

#: A cabeça olha um pouco para cima — o próximo degrau —, mas **pouco**: este
#: mesmo clipe roda ao contrário para descer, e um olhar cravado no alto viraria
#: um pirata descendo de costas para onde vai.
HEAD_PITCH = -5.0

#: Fecho da mão na barra. Bem menos que o soco do `pose_test` ("fist" usa
#: 62/78), e a razão é geométrica: a barra tem 5,2 cm de diâmetro e ocupa o vão
#: que o punho fechado não deixa. Dobrar até o fim faz o dedo entrar na madeira
#: e a mão lê como soco, não como pegada.
FINGER_CURL = (42.0, 48.0)
THUMB_CURL = (26.0, 30.0)

FINGERS = ("index", "middle", "ring", "pinky")


# -- pegadas ------------------------------------------------------------------


@dataclass(frozen=True)
class Grip:
    """Um ponto de contato ao longo do ciclo: quando pega, quanto segura, por
    onde volta.

    O membro passa a vida em dois regimes. **Preso**, ele não se move no mundo —
    o que se descreve aqui é a barra descendo no referencial do corpo, e essa
    reta é o contrato inteiro deste arquivo. **Viajando**, ele sobe dois degraus
    e volta ao mesmo lugar de onde saiu no ciclo anterior, que é o que faz o
    laço fechar sem tranco.
    """

    #: Fase em que toma a barra, em [0, 1).
    grab: float
    #: Fração do ciclo presa a ela.
    stance: float
    #: Altura da barra tomada, no referencial do corpo, no instante do agarre.
    rung: float
    #: Meia distância à linha do meio.
    x: float
    #: Deslocamento do efetor (punho ou tornozelo) em relação à barra.
    above: float
    behind: float
    #: Afastamento da barra e altura extra no meio da viagem.
    swing_y: float
    swing_arc: float

    def holding(self, t: float) -> bool:
        return (t - self.grab) % 1.0 <= self.stance

    def target(self, t: float, side: str) -> Vector:
        """Onde o efetor tem de estar na fase *t*, no espaço do rig."""
        k = (t - self.grab) % 1.0
        sign = 1.0 if side == "L" else -1.0

        if k <= self.stance:
            # Preso. A barra está parada no mundo e o corpo sobe a velocidade
            # constante, então ela desce numa reta — e é por ser **reta**, e não
            # uma curva suavizada, que a mão não escorrega.
            rung_z = self.rung - CYCLE_RISE * k
            return Vector((sign * self.x,
                           RUNG_Y + self.behind,
                           rung_z + self.above))

        # Viagem. Sai de onde o apoio terminou e chega exatamente na barra de
        # onde partiu — dois degraus acima, no mundo.
        s = (k - self.stance) / (1.0 - self.stance)
        low = self.rung - CYCLE_RISE * self.stance
        # Sair devagar seria mentira: a mão larga a barra com a velocidade que
        # tinha. `hermite` com tangente de partida negativa continua o
        # movimento por um instante antes de inverter.
        rung_z = low + (self.rung - low) * anim_gait.hermite(s, -0.35, 0.0)
        arc = self.swing_arc * math.sin(math.pi * s)
        y = RUNG_Y + self.behind + (self.swing_y - (RUNG_Y + self.behind)) \
            * math.sin(math.pi * s)
        # A mão também recolhe para dentro no meio do caminho. Sem isto o
        # antebraço sobe raspando o montante, que é a única madeira vertical
        # que existe e fica exatamente na largura da pegada.
        narrow = 1.0 - (1.0 - SWING_NARROW) * math.sin(math.pi * s)
        return Vector((sign * self.x * narrow, y, rung_z + self.above + arc))


def snap_rung(wish: float, grab: float) -> float:
    """Ajusta uma altura de barra desejada para a barra que existe de verdade.

    A grade é definida pelo pé: a barra que ele toma na fase 0 é a origem, e
    todas as outras estão a múltiplos inteiros de `RUNG_SPACING` dela **no
    mundo**. Como cada grip agarra num instante diferente, a conversão passa
    pelo mundo e volta — sem isso, uma mão "1,93 acima do corpo" cai a meio
    palmo da barra e o personagem agarra ar.

    Que o ciclo suba `2 × RUNG_SPACING` é o que faz esta conta valer para
    sempre: um ciclo inteiro de diferença ainda é um número redondo de degraus.
    """
    world = wish + CYCLE_RISE * grab
    index = round((world - FOOT_RUNG_Z) / RUNG_SPACING)
    return FOOT_RUNG_Z + index * RUNG_SPACING - CYCLE_RISE * grab


#: A mão do par diagonal agarra `HAND_LEAD` antes do pé. Como o pé esquerdo pega
#: na fase 0, a mão direita pega no fim do ciclo anterior.
HAND_GRAB_R = (1.0 - HAND_LEAD) % 1.0
HAND_GRAB_L = (0.5 - HAND_LEAD) % 1.0
HAND_RUNG_Z = snap_rung(HAND_RUNG_WISH, HAND_GRAB_R)

FEET = {
    "L": Grip(grab=0.0, stance=FOOT_STANCE, rung=FOOT_RUNG_Z, x=FOOT_X,
              above=ANKLE_ABOVE_RUNG, behind=ANKLE_BEHIND_RUNG,
              swing_y=FOOT_SWING_Y, swing_arc=FOOT_SWING_ARC),
    "R": Grip(grab=0.5, stance=FOOT_STANCE, rung=FOOT_RUNG_Z, x=FOOT_X,
              above=ANKLE_ABOVE_RUNG, behind=ANKLE_BEHIND_RUNG,
              swing_y=FOOT_SWING_Y, swing_arc=FOOT_SWING_ARC),
}

HANDS = {
    # A barra da esquerda é **um degrau acima** da barra da direita, no mundo —
    # mas o número aqui é o mesmo, e tem de ser. `rung` é altura no *corpo* no
    # instante do agarre, e meio ciclo depois o corpo já subiu esse degrau: as
    # duas mãos agarram na mesma altura de peito. Somar o espaçamento aqui foi o
    # primeiro erro deste arquivo, e mandou a mão 30 cm além do que o braço
    # alcança.
    # O alvo da mão é a **palma**, não o punho — quem recua o osso é o
    # `_pose_arm`. E a palma não fica no eixo da barra: fica um pouco acima e
    # atrás dele, que é onde a mão de quem agarra por cima realmente pousa. Com
    # a palma cravada no eixo, a barra sai pelo punho.
    "L": Grip(grab=HAND_GRAB_L, stance=HAND_STANCE,
              rung=HAND_RUNG_Z, x=HAND_X,
              above=PALM_ABOVE_RUNG, behind=PALM_BEHIND_RUNG,
              swing_y=HAND_SWING_Y, swing_arc=HAND_SWING_ARC),
    "R": Grip(grab=HAND_GRAB_R, stance=HAND_STANCE, rung=HAND_RUNG_Z, x=HAND_X,
              above=PALM_ABOVE_RUNG, behind=PALM_BEHIND_RUNG,
              swing_y=HAND_SWING_Y, swing_arc=HAND_SWING_ARC),
}


# -- medidas do braço ---------------------------------------------------------


def arm_metrics(arm) -> dict:
    """Comprimentos do braço, para a IK. O `rest_metrics` só mede a perna.

    A cadeia é a mesma coisa que a perna — dois elos rígidos com as pontas
    presas —, então quem resolve é o mesmo `solve_leg`: fêmur vira úmero, tíbia
    vira antebraço e o joelho vira cotovelo.
    """
    bones = arm.data.bones
    out = {}
    for side in ("L", "R"):
        upper = bones[f"upperarm.{side}"]
        lower = bones[f"lowerarm.{side}"]
        hand = bones[f"hand.{side}"]
        out[side] = {
            "humerus": (upper.tail_local - upper.head_local).length,
            "forearm": (lower.tail_local - lower.head_local).length,
            "hand": (hand.tail_local - hand.head_local).length,
        }
    return out


# -- curvas do corpo ----------------------------------------------------------


def body_plan(t: float) -> dict:
    """Como o tronco acompanha as quatro pegadas, na fase *t*.

    Nada aqui é senoide inventada: as oscilações saem da **posição das próprias
    pegadas**, que é a quem o corpo responde. Quando a mão direita está alta e a
    esquerda no peito, o ombro direito sobe e avança; a senoide que se
    escreveria no lugar disso acertaria a fase por acaso e erraria assim que
    qualquer `grab` mudasse.

    ``pull`` é a peça central: vale 1 no instante em que a mão de cima toma a
    barra e -1 quando ela chega ao peito e larga. É ele que puxa o corpo para a
    escada e o levanta — as duas coisas que uma braçada faz — e, de quebra, é
    ele que redistribui alcance do braço entre o alto e o baixo do gesto.
    """
    foot_bias = (FEET["L"].target(t, "L").z - FEET["R"].target(t, "R").z) / RUNG_SPACING
    hand_bias = (HANDS["L"].target(t, "L").z - HANDS["R"].target(t, "R").z) / RUNG_SPACING

    # A mão que está segurando mais alto, medida em degraus a partir do meio da
    # sua excursão. Duas batidas por ciclo, uma por braçada — e em fase com o
    # gesto, não com o relógio.
    top = max(HANDS["L"].target(t, "L").z, HANDS["R"].target(t, "R").z)
    span = CYCLE_RISE * HAND_STANCE
    pull = 2.0 * (top - (HAND_RUNG_Z - span * 0.5)) / span - 1.0
    pull = min(max(pull, -1.0), 1.0)

    return {
        # Baixo quando a mão agarra no alto, alto quando ela termina de puxar.
        "lift": BODY_SETTLE - pull * BODY_PULSE,
        # O peso mora no pé que está preso e mais baixo — o que sustenta.
        "sway": -foot_bias * BODY_SWAY,
        # Negativo é para a escada: perto no início da braçada, longe no fim.
        "surge": -pull * BODY_SURGE,
        "pelvis_yaw": foot_bias * PELVIS_YAW,
        "pelvis_roll": -foot_bias * PELVIS_ROLL,
        "twist": hand_bias * TORSO_TWIST,
        "shoulder": hand_bias,
        "foot_bias": foot_bias,
        "hand_bias": hand_bias,
        "pull": pull,
    }


def _aim_root(root, plan: dict) -> None:
    """Move o corpo inteiro. Versão local do `anim_gait.aim_root`.

    A diferença é o avanço em Y: numa marcha o corpo nunca precisa se aproximar
    de nada — quem avança é o motor —, e aqui o tronco chega e sai da escada a
    cada braçada.
    """
    from mathutils import Matrix

    matrix = Matrix.Translation(Vector((plan["sway"], plan["surge"], plan["lift"])))
    matrix = matrix @ Matrix.Rotation(math.radians(plan["pelvis_yaw"]), 4, "Z")
    root.matrix = matrix @ root.bone.matrix_local


def _pose_torso(pose, plan: dict) -> None:
    """Coluna, pescoço e clavículas.

    O sinal de ``X`` aqui é o que parece: **positivo joga o topo do bone para
    -Y**, que é para onde o personagem olha. Vale conferir antes de copiar de
    outro arquivo da pasta — trocar esse sinal inclina o pirata para trás na
    escada, e o defeito não salta aos olhos: ele só empurra o ombro 11 cm para
    longe da barra e faz a IK do braço estourar sem explicação aparente.
    """
    pose["pelvis"].rotation_quaternion = anim_gait.world_rotation(
        pose["pelvis"], [("Y", plan["pelvis_roll"]), ("X", TORSO_LEAN * 0.10)])

    # A inclinação é repartida pela coluna: concentrada num bone só, faz um
    # vinco no casaco em vez de um tronco inclinado.
    for name, share in (("spine_01", 0.30), ("spine_02", 0.35), ("spine_03", 0.35)):
        pose[name].rotation_quaternion = anim_gait.world_rotation(
            pose[name], [("X", TORSO_LEAN * share),
                         ("Z", plan["twist"] * share)])

    # O ombro do braço alto sobe **e avança**. As duas coisas juntas, porque é
    # assim que o ombro funciona: quem levanta o braço acima da cabeça leva a
    # escápula junto, e são esses centímetros que decidem se a mão alcança a
    # barra de cima ou fica pendurada 3 cm abaixo dela.
    for side in ("L", "R"):
        sign = 1.0 if side == "L" else -1.0
        bias = plan["shoulder"] * sign          # +1 quando este braço está alto
        pose[f"clavicle.{side}"].rotation_quaternion = anim_gait.world_rotation(
            pose[f"clavicle.{side}"],
            [("Y", -bias * SHOULDER_RISE), ("Z", -sign * bias * SHOULDER_REACH)])

    # O pescoço desfaz a inclinação do tronco — o olhar volta para a escada em
    # vez de ficar cravado nas próprias botas.
    pose["neck"].rotation_quaternion = anim_gait.world_rotation(
        pose["neck"], [("X", -TORSO_LEAN * 0.30 + HEAD_PITCH * 0.5)])
    pose["head"].rotation_quaternion = anim_gait.world_rotation(
        pose["head"], [("X", -TORSO_LEAN * 0.25 + HEAD_PITCH * 0.5),
                       ("Z", -plan["twist"] * 0.35)])


def _pose_leg(pose, data: dict, side: str, ankle: Vector) -> tuple[float, float]:
    """Uma perna por IK contra *ankle*. Devolve (erro, extensão)."""
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
    anim_gait.aim_bone(foot, anim_gait.rotate_x(data["foot_dir"], FOOT_PITCH),
                       foot.matrix.translation.copy())
    bpy.context.view_layer.update()

    toe = pose[f"toe.{side}"]
    anim_gait.aim_bone(toe, anim_gait.rotate_x(data["toe_dir"], FOOT_PITCH),
                       toe.matrix.translation.copy())
    return error, extension


#: Para onde os dedos deste rig se fecham quando estão na pose de repouso.
#:
#: `pose_test.POSES["fist"]` dobra os dedos girando em torno do **Y do mundo**, o
#: que na T-pose leva a ponta do dedo de +X para -Z: a palma olha para baixo.
#: Guardar isso aqui é o que permite virar a mão para a barra sem adivinhação.
REST_PALM = Vector((0.0, 0.0, -1.0))


#: Eixo das barras, no espaço do rig: elas correm de um montante ao outro.
RUNG_AXIS = Vector((1.0, 0.0, 0.0))


def _aim_hand(pose_bone, direction: Vector) -> None:
    """Aponta a mão **e escolhe o giro em torno do próprio eixo**.

    `anim_gait.aim_bone` resolve a direção pelo caminho mais curto, e para um
    braço ou uma perna isso basta: o que importa é onde a ponta vai parar. Numa
    mão que agarra, não basta — sobra um grau de liberdade, o *roll*, e é ele que
    decide para onde a **palma** olha. Deixado ao acaso, o punho fecha de lado e
    a barra atravessa os dedos: a mão fica cerrada no ar ao lado do degrau, com
    o pau saindo pelo meio dela. Foi assim que este arquivo passou três versões,
    com todas as métricas de contato dando zero — porque medir a *posição* da
    palma não diz nada sobre para onde ela está virada.

    A palma certa é a perpendicular comum entre o antebraço e a **barra**: é a
    superfície que encosta na madeira. Os dedos, que são filhos, fecham nessa
    direção e envolvem o degrau.
    """
    rest = pose_bone.bone.matrix_local
    rest_dir = (pose_bone.bone.tail_local - pose_bone.bone.head_local).normalized()
    axis = direction.normalized()

    palm = RUNG_AXIS.cross(axis)
    if palm.length < 1e-4:              # braço paralelo à barra: nada a escolher
        anim_gait.aim_bone(pose_bone, direction, pose_bone.matrix.translation.copy())
        return
    palm.normalize()
    # Dos dois sentidos possíveis, o que olha para **longe** de quem sobe.
    #
    # A pegada de escada é pronada, como a de uma barra fixa: as costas da mão
    # ficam voltadas para o rosto, os dedos passam por cima do degrau e fecham do
    # lado de lá, o polegar por baixo do lado de cá. Com a palma virada para o
    # corpo — que foi como este arquivo nasceu — a mão fica de dorso para a
    # madeira e o gesto lê como invertido, ainda que a geometria encoste.
    if palm.y > 0.0:
        palm = -palm

    swing = rest_dir.rotation_difference(axis)
    current = swing @ REST_PALM
    current = current - axis * current.dot(axis)

    total = swing
    if current.length > 1e-6:
        total = current.normalized().rotation_difference(palm) @ swing

    matrix = (total.to_matrix() @ rest.to_3x3()).to_4x4()
    matrix.translation = pose_bone.matrix.translation
    pose_bone.matrix = matrix


def _pose_arm(pose, data: dict, side: str, grip: Vector) -> tuple[float, float, Vector]:
    """Um braço por IK, com a **palma** em *grip*. Devolve (erro, extensão, palma).

    O alvo que entra é a barra; o punho sai dela recuado por `HAND_GRIP_REACH` na
    direção do ombro, porque é a mão que segura o degrau e ela continua o
    antebraço. Mirar o punho na barra encolhe o braço em 7 cm — num braço de
    60,8 cm, é a diferença entre alcançar a barra de cima e não alcançar.

    O cotovelo aponta para fora e para baixo: é a única dica que impede a IK de
    dobrar o braço para dentro do peito quando a mão está na altura das
    costelas, que é metade do ciclo.
    """
    sign = 1.0 if side == "L" else -1.0
    upper = pose[f"upperarm.{side}"]
    shoulder = upper.matrix.translation.copy()

    # A mão entra na cadeia como parte do antebraço, e o alvo da IK é a palma.
    #
    # Recuar o punho na direção do **ombro** parece equivalente e não é: quem
    # leva a palma até a barra é o antebraço, e com o cotovelo fechado essas
    # duas direções divergem 40°. Foi assim que a versão anterior errou 11 cm no
    # ponto mais dobrado do ciclo — com a IK reportando sucesso, porque ela
    # tinha alcançado exatamente o punho errado que se pediu.
    forearm = data["forearm"] + HAND_GRIP_REACH
    reach = data["humerus"] + forearm
    extension = (grip - shoulder).length / reach

    elbow = anim_gait.solve_leg(shoulder, grip, data["humerus"], forearm,
                                ARM_EXTENSION_LIMIT,
                                Vector((sign * ELBOW_HINT[0], ELBOW_HINT[1],
                                        ELBOW_HINT[2])))
    anim_gait.aim_bone(upper, elbow - shoulder, shoulder)
    bpy.context.view_layer.update()

    lower = pose[f"lowerarm.{side}"]
    anim_gait.aim_bone(lower, grip - elbow, lower.matrix.translation.copy())
    bpy.context.view_layer.update()

    hand = pose[f"hand.{side}"]
    # A mão continua o antebraço — mas com a palma virada para a barra, que é o
    # que faz os dedos fecharem em volta dela em vez de ao lado.
    _aim_hand(hand, grip - elbow)
    bpy.context.view_layer.update()

    # Onde a palma foi parar **de fato**, depois de a IK ter dito o que podia
    # fazer. É este ponto que tem de coincidir com a barra, e é a distância dele
    # ao alvo que denuncia braço curto demais.
    palm = hand.matrix.translation + (hand.tail - hand.head).normalized() * HAND_GRIP_REACH
    return (palm - grip).length, extension, palm


def _pose_hand_grip(pose, side: str, closed: float) -> None:
    """Fecha os dedos em volta da barra.

    ``closed`` vai de 0 (mão aberta, viajando) a 1 (fechada na barra). Abrir na
    viagem não é firula: uma mão cerrada atravessando o ar entre dois degraus é
    a coisa que mais denuncia animação de escada feita às pressas.

    As rotações são de eixo-do-mundo **na pose de repouso** (`world_rotation`),
    então continuam valendo com o braço em qualquer posição — é o que permite
    fechar a mão sem saber para onde ela está apontando.
    """
    sign = 1.0 if side == "L" else -1.0
    for name in FINGERS:
        for i, curl in enumerate(FINGER_CURL, start=1):
            bone = pose.get(f"finger_{name}_0{i}.{side}")
            if bone is None:
                continue
            bone.rotation_quaternion = anim_gait.world_rotation(
                bone, [("Y", sign * curl * closed)])

    for i, curl in enumerate(THUMB_CURL, start=1):
        bone = pose.get(f"thumb_0{i}.{side}")
        if bone is None:
            continue
        bone.rotation_quaternion = anim_gait.world_rotation(
            bone, [("Z", -sign * curl * closed)])


def grip_closure(grip: Grip, t: float) -> float:
    """Quanto a mão está fechada na fase *t*.

    Fecha antes de tocar a barra e abre logo depois de soltar — a mão se
    prepara, não reage.
    """
    k = (t - grip.grab) % 1.0
    if k <= grip.stance:
        # Solta a pegada nos últimos 8% do apoio.
        return 1.0 - anim_gait.smoothstep(anim_gait.ramp(k, grip.stance - 0.08,
                                                         grip.stance)) * 0.65
    s = (k - grip.stance) / (1.0 - grip.stance)
    if s < 0.5:
        return 0.35 * (1.0 - anim_gait.smoothstep(anim_gait.ramp(s, 0.0, 0.35)))
    return anim_gait.smoothstep(anim_gait.ramp(s, 0.55, 1.0))


# -- montagem -----------------------------------------------------------------


#: Bones que este clipe anima **além** dos que o `anim_gait._key_frame` grava.
#:
#: Os dedos, porque este é o único clipe em que a mão faz alguma coisa. E a
#: **clavícula**, que é a armadilha desta pasta: `anim_gait.KEYED_BONES` não a
#: inclui — as marchas não mexem nela —, mas aqui o ombro sobe e avança 9° e 6°,
#: e é sobre o ombro deslocado que a IK do braço resolve a pose.
#:
#: Sem gravá-la, a action reproduz o braço com o ombro em repouso: a mão sai 5 cm
#: do lugar e agarra o ar ao lado da barra. E o pior — as métricas de contato
#: continuam dando zero, porque medem a pose que foi **construída**, não a que
#: ficou gravada. É por isso que `verify()` existe e lê a action de volta.
GRIP_BONES = tuple(f"finger_{n}_0{i}" for n in FINGERS for i in (1, 2)) \
    + ("thumb_01", "thumb_02") + ("clavicle",)


def _key_frame(arm, frame: int) -> None:
    """Grava a pose, com dedos e clavículas."""
    anim_gait._key_frame(arm, frame)
    for name in GRIP_BONES:
        for side in ("L", "R"):
            bone = arm.pose.bones.get(f"{name}.{side}")
            if bone is not None:
                bone.keyframe_insert("rotation_quaternion", frame=frame,
                                     group=f"{name}.{side}")


def build(arm=None) -> dict:
    """Gera a action `ClimbUp` e devolve as medidas que provam que ela presta."""
    arm = arm or bpy.data.objects[anim_gait.ARMATURE_NAME]
    metrics = anim_gait.rest_metrics(arm)
    arms = arm_metrics(arm)

    scene = bpy.context.scene
    scene.render.fps = FPS
    # Começa no quadro 0: o exportador glTF divide o número do quadro pelo fps, e
    # começar no 1 põe o primeiro keyframe em t = 0,033 s.
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
    report = {
        "foot_error": 0.0, "hand_error": 0.0,
        "foot_extension": 0.0, "hand_extension": 0.0,
        "foot_slip": 0.0, "hand_slip": 0.0,
    }
    #: Onde cada efetor esteve **no mundo** durante cada apoio. É daqui que sai a
    #: prova de que nada escorrega: com o corpo subindo a velocidade constante,
    #: um ponto preso na barra tem de ficar imóvel.
    held: dict[str, list] = {}

    for frame in range(0, CYCLE_FRAMES + 1):
        t = frame / CYCLE_FRAMES
        scene.frame_set(frame)

        plan = body_plan(t)
        _aim_root(pose["root"], plan)
        bpy.context.view_layer.update()
        _pose_torso(pose, plan)
        bpy.context.view_layer.update()

        for side in ("L", "R"):
            target = FEET[side].target(t, side)
            error, extension = _pose_leg(pose, metrics[side], side, target)
            report["foot_error"] = max(report["foot_error"], error)
            report["foot_extension"] = max(report["foot_extension"], extension)
            if FEET[side].holding(t):
                held.setdefault(f"foot.{side}", []).append(
                    pose[f"foot.{side}"].matrix.translation.z + CYCLE_RISE * t)

        for side in ("L", "R"):
            target = HANDS[side].target(t, side)
            error, extension, palm = _pose_arm(pose, arms[side], side, target)
            report["hand_error"] = max(report["hand_error"], error)
            report["hand_extension"] = max(report["hand_extension"], extension)
            _pose_hand_grip(pose, side, grip_closure(HANDS[side], t))
            if HANDS[side].holding(t):
                # A palma, e não o punho: o punho **tem** de se mexer durante o
                # apoio (o braço se dobra), quem não pode sair da barra é a mão.
                held.setdefault(f"hand.{side}", []).append(palm.z + CYCLE_RISE * t)

        bpy.context.view_layer.update()
        _key_frame(arm, frame)

    anim_gait._linear_curves(action)
    scene.frame_set(0)

    for name, heights in held.items():
        # Um apoio que atravessa o fim do ciclo aparece aqui como dois trechos
        # separados por um degrau inteiro; o que interessa é a dispersão dentro
        # de cada trecho, e por isso o corte em 0,15 m.
        spread = 0.0
        run = [heights[0]]
        for value in heights[1:]:
            if abs(value - run[-1]) > 0.15:
                spread = max(spread, max(run) - min(run))
                run = []
            run.append(value)
        spread = max(spread, max(run) - min(run))
        key = "foot_slip" if name.startswith("foot") else "hand_slip"
        report[key] = max(report[key], spread)

    return {
        "action": ACTION_NAME,
        "fps": FPS,
        "frames": CYCLE_FRAMES,
        "cycle_seconds": round(CYCLE_FRAMES / FPS, 3),
        "rung_spacing_cm": round(RUNG_SPACING * 100, 2),
        "cycle_rise_m": round(CYCLE_RISE, 4),
        "native_speed_ms": round(CYCLE_RISE / (CYCLE_FRAMES / FPS), 3),
        "rungs_per_second": round(CYCLE_RISE / (CYCLE_FRAMES / FPS) / RUNG_SPACING, 2),
        "hand_rung_z": round(HAND_RUNG_Z, 4),
        "hand_rung_snap_mm": round((HAND_RUNG_Z - HAND_RUNG_WISH) * 1000, 1),
        # Se a IK não alcançou o alvo, a pose que se vê não é a que está descrita.
        "foot_error_mm": round(report["foot_error"] * 1000, 3),
        "hand_error_mm": round(report["hand_error"] * 1000, 3),
        # Quanto o ponto preso andou no mundo. É o "escorregamento do pé" da
        # caminhada, medido nos quatro apoios.
        "foot_slip_mm": round(report["foot_slip"] * 1000, 3),
        "hand_slip_mm": round(report["hand_slip"] * 1000, 3),
        "foot_extension_max": round(report["foot_extension"], 3),
        "hand_extension_max": round(report["hand_extension"], 3),
    }


# -- conferência do que ficou gravado -----------------------------------------


def verify(arm=None, action: str = ACTION_NAME) -> dict:
    """Mede o contato **relendo a action**, com a malha deformada de verdade.

    Existe porque as métricas do `build` mentiram uma vez e podem mentir de
    novo: elas medem a pose no instante em que é construída, e entre construir e
    gravar há um `_key_frame` que só leva os bones que alguém lembrou de listar.
    Quando a clavícula ficou de fora, o `build` reportava contato perfeito e o
    personagem agarrava o ar cinco centímetros ao lado da barra.

    Aqui não há pose construída: troca-se o quadro, deixa-se o Blender avaliar a
    action e mede-se a **geometria da mão** contra o cilindro da barra que ela
    deveria estar segurando. É o mesmo que o olho faz no preview, só que em
    milímetros.
    """
    arm = arm or bpy.data.objects[anim_gait.ARMATURE_NAME]
    obj = bpy.data.objects[anim_gait.MESH_NAME]
    _assign_action(arm, action)

    names = {g.index: g.name for g in obj.vertex_groups}
    hand_verts = {"L": [], "R": []}
    for vert in obj.data.vertices:
        best, group = 0.0, ""
        for g in vert.groups:
            if g.weight > best:
                best, group = g.weight, names[g.group]
        for side in ("L", "R"):
            if group.endswith(f".{side}") and any(k in group for k in
                                                  ("hand", "finger", "thumb")):
                hand_verts[side].append(vert.index)

    scene = bpy.context.scene
    worst_hold, worst_stile, loose = -9.0, -9.0, 0.0
    for frame in range(CYCLE_FRAMES):
        t = frame / CYCLE_FRAMES
        scene.frame_set(frame)
        evaluated = obj.evaluated_get(bpy.context.evaluated_depsgraph_get())
        mesh = evaluated.to_mesh()
        lift = CYCLE_RISE * t
        for side in ("L", "R"):
            grip = HANDS[side]
            if not grip.holding(t):
                continue
            target = grip.target(t, side)
            index = round((target.z + lift - FOOT_RUNG_Z) / RUNG_SPACING)
            rung_z = FOOT_RUNG_Z + index * RUNG_SPACING - lift
            stile = RUNG_HALF_WIDTH if side == "L" else -RUNG_HALF_WIDTH

            near = 9.0
            for i in hand_verts[side]:
                point = mesh.vertices[i].co
                near = min(near, math.hypot(point.y - RUNG_Y, point.z - rung_z)
                           - RUNG_RADIUS)
                worst_stile = max(worst_stile, 0.038 - math.hypot(point.x - stile,
                                                                  point.y - RUNG_Y))
            # `near` positivo é mão flutuando: a pegada não encosta na madeira.
            loose = max(loose, near)
            worst_hold = max(worst_hold, -near)
        evaluated.to_mesh_clear()
    scene.frame_set(0)

    return {
        # Quanto a mão envolve a barra, em cm. Tem de ser positivo: a pegada
        # fecha *em volta* da madeira, então há sobreposição por construção.
        "grip_wrap_cm": round(worst_hold * 100, 2),
        # E nenhum quadro de apoio pode ter a mão solta no ar.
        "worst_loose_cm": round(loose * 100, 2),
        # A mão não pode estar segurando o montante em vez do degrau.
        "hand_in_stile_cm": round(worst_stile * 100, 2),
    }


# -- o corpo contra a escada --------------------------------------------------


#: Peças que **têm** de tocar a madeira. Mão e pé são o ponto do exercício;
#: medi-los como colisão condenaria toda pegada boa.
TOUCHING = ("hand", "finger", "thumb", "foot", "toe")

#: O resto do corpo, separado em duas classes — porque as duas não têm o mesmo
#: peso.
#:
#: Tronco encostando na escada é defeito de verdade: significa que o corpo está
#: perto demais e o personagem atravessa o cenário no meio da tela. Já um membro
#: raspando é outra conversa: braço e perna **precisam** cruzar o plano das
#: barras para levar mão e pé até lá, e a borda larga de um casaco ou de uma
#: calça bufante vai passar perto da madeira em algum quadro. É a mesma
#: interpenetração que o resto deste personagem já tem entre bota e calça.
CORE = ("spine", "pelvis", "neck", "head", "clavicle")
LIMBS = ("thigh", "calf", "upperarm", "lowerarm")


def clearance(arm=None, action: str = ACTION_NAME) -> dict:
    """Quanto o corpo entra na escada, quadro a quadro. Devolve o pior caso.

    É o `sole_clearance` da caminhada virado de lado. Lá o erro clássico é a
    bota dentro do convés; aqui são três, e nenhum aparece olhando o clipe
    isolado: o joelho da perna que sobe passa exatamente na altura da barra
    seguinte, o cotovelo do braço estendido cruza o montante, e a barriga —
    que neste personagem avança 24,8 cm à frente do eixo do rig — encosta na
    escada antes de qualquer animação começar.

    A malha é lida **deformada** (`evaluated_get`), porque é a pose que colide,
    não o rig. E a grade das barras acompanha a subida do corpo: no referencial
    do clipe, é ela que desce.
    """
    arm = arm or bpy.data.objects[anim_gait.ARMATURE_NAME]
    obj = bpy.data.objects[anim_gait.MESH_NAME]
    _assign_action(arm, action)

    def dominant(vert) -> str:
        """A que classe o vértice pertence, pelo bone que mais manda nele."""
        best, group = 0.0, ""
        for g in vert.groups:
            if g.weight > best:
                best, group = g.weight, obj.vertex_groups[g.group].name
        if any(k in group for k in TOUCHING):
            return "touching"
        if any(k in group for k in LIMBS):
            return "limb"
        return "core"

    kind = {v.index: dominant(v) for v in obj.data.vertices}

    scene = bpy.context.scene
    worst = {"core": (-1.0, None), "limb": (-1.0, None)}
    for frame in range(CYCLE_FRAMES):
        scene.frame_set(frame)
        evaluated = obj.evaluated_get(bpy.context.evaluated_depsgraph_get())
        mesh = evaluated.to_mesh()
        lift = CYCLE_RISE * frame / CYCLE_FRAMES
        for vert in mesh.vertices:
            group = kind[vert.index]
            if group == "touching":
                continue
            x, y, z = vert.co
            gap = -1.0
            if abs(x) <= RUNG_HALF_WIDTH:
                # Só a barra mais próxima interessa: as outras estão a 30 cm.
                index = round((z + lift - FOOT_RUNG_Z) / RUNG_SPACING)
                rung_z = FOOT_RUNG_Z + index * RUNG_SPACING - lift
                gap = RUNG_RADIUS - math.hypot(y - RUNG_Y, z - rung_z)
            for stile in (RUNG_HALF_WIDTH, -RUNG_HALF_WIDTH):
                gap = max(gap, 0.038 - math.hypot(x - stile, y - RUNG_Y))
            if gap > worst[group][0]:
                worst[group] = (gap, (frame, round(x, 3), round(y, 3), round(z, 3)))
        evaluated.to_mesh_clear()
    scene.frame_set(0)

    return {
        # Positivo é madeira dentro do pirata; negativo é folga.
        # No tronco tem de ser negativo. Nos membros, alguns milímetros são o
        # preço de levar mão e pé até a escada.
        "core_penetration_cm": round(worst["core"][0] * 100, 2),
        "core_worst_frame": worst["core"][1],
        "limb_penetration_cm": round(worst["limb"][0] * 100, 2),
        "limb_worst_frame": worst["limb"][1],
    }


# -- preview ------------------------------------------------------------------


#: Andaime, não asset: o `export.py` apaga toda action que comece com isto antes
#: de gerar o GLB. A de preview move o **objeto** armature para simular a subida
#: que no jogo é do motor — dentro da engine ela levantaria o personagem uma
#: segunda vez.
PREVIEW_PREFIX = "_"
PREVIEW_ACTION = "_ClimbPreview"
PREVIEW_CYCLES = 3


def _tube(verts, faces, a: Vector, b: Vector, radius: float, segments: int = 8):
    """Um cilindro de *a* a *b*, acrescentado às listas dadas."""
    axis = (b - a).normalized()
    # Qualquer perpendicular serve; a escolha só decide onde caem as arestas.
    helper = Vector((0.0, 0.0, 1.0)) if abs(axis.z) < 0.9 else Vector((1.0, 0.0, 0.0))
    u = axis.cross(helper).normalized()
    v = axis.cross(u)

    base = len(verts)
    for i in range(segments):
        angle = 2.0 * math.pi * i / segments
        offset = (u * math.cos(angle) + v * math.sin(angle)) * radius
        verts.append(a + offset)
        verts.append(b + offset)
    for i in range(segments):
        j = (i + 1) % segments
        faces.append((base + i * 2, base + j * 2, base + j * 2 + 1, base + i * 2 + 1))


def _temp_ladder(bottom: float, top: float):
    """A escada do mastro, só para o preview. Devolve o que tem de ser apagado.

    Não é cenário: é **régua**. Um ciclo de escalada não se julga com o
    personagem no vazio — sem as barras no lugar exato onde a grade diz que elas
    estão, não há como ver se a mão agarra madeira ou ar. Os degraus saem da
    mesma conta que o clipe usa, e é isso que faz o preview provar alguma coisa.
    """
    verts, faces = [], []
    for side in (1.0, -1.0):
        _tube(verts, faces,
              Vector((side * RUNG_HALF_WIDTH, RUNG_Y, bottom)),
              Vector((side * RUNG_HALF_WIDTH, RUNG_Y, top)), 0.038, 8)

    first = math.ceil((bottom - FOOT_RUNG_Z) / RUNG_SPACING)
    last = math.floor((top - FOOT_RUNG_Z) / RUNG_SPACING)
    for k in range(first, last + 1):
        z = FOOT_RUNG_Z + k * RUNG_SPACING
        _tube(verts, faces,
              Vector((-RUNG_HALF_WIDTH, RUNG_Y, z)),
              Vector((RUNG_HALF_WIDTH, RUNG_Y, z)), RUNG_RADIUS, 8)

    mesh = bpy.data.meshes.new("__ClimbPreviewLadder")
    mesh.from_pydata([tuple(v) for v in verts], [], faces)
    mesh.update()

    material = bpy.data.materials.new("__ClimbPreviewLadderMat")
    material.use_nodes = True
    bsdf = material.node_tree.nodes["Principled BSDF"]
    bsdf.inputs["Base Color"].default_value = (0.19, 0.13, 0.08, 1.0)
    bsdf.inputs["Roughness"].default_value = 0.85
    mesh.materials.append(material)

    obj = bpy.data.objects.new("__ClimbPreviewLadder", mesh)
    bpy.context.scene.collection.objects.link(obj)
    return obj, mesh, material


def timeline(cycles: int = PREVIEW_CYCLES) -> list[tuple[float, float]]:
    """A subida como o jogo vai tocá-la: `(quadro do clipe, altura)`.

    A altura não é decoração e a fase não é relógio: as duas saem da mesma
    conta que o runtime fará (`fase += subida / CYCLE_RISE`). Se as barras
    passarem pelas mãos com qualquer deriva, é aqui que aparece — e é o único
    lugar onde aparece, porque o clipe sozinho anima um sujeito escalando
    parado no lugar.
    """
    total = cycles * CYCLE_FRAMES
    return [(i % CYCLE_FRAMES, CYCLE_RISE * i / CYCLE_FRAMES)
            for i in range(total + 1)]


def _assign_action(arm, name: str) -> None:
    """Troca a action ativa do rig, com o slot que o Blender 4.4+ exige.

    Sem o slot a action fica atribuída e **não avalia**: o personagem congela na
    pose de repouso e o preview sai com uma T-pose no meio da escada.
    """
    action = bpy.data.actions[name]
    arm.animation_data.action = action
    slots = getattr(action, "slots", None)
    if slots:
        arm.animation_data.action_slot = slots[0]


def _new_action(arm, name: str):
    if arm.animation_data is None:
        arm.animation_data_create()
    old = bpy.data.actions.get(name)
    if old is not None:
        bpy.data.actions.remove(old)
    action = bpy.data.actions.new(name)
    action.use_fake_user = True
    arm.animation_data.action = action
    return action


def bake_preview(arm=None, cycles: int = PREVIEW_CYCLES) -> dict:
    """Assa a `timeline` numa action só, para dar Play dentro do Blender."""
    arm = arm or bpy.data.objects[anim_gait.ARMATURE_NAME]
    shots = timeline(cycles)

    names = (list(anim_gait.KEYED_BONES)
             + [f"{n}.{s}" for n in anim_gait.KEYED_SIDED for s in ("L", "R")]
             + [f"{n}.{s}" for n in GRIP_BONES for s in ("L", "R")])
    names = [n for n in names if n in arm.pose.bones]

    scene = bpy.context.scene
    if arm.animation_data is None:
        arm.animation_data_create()

    # Duas passadas, e não uma: escrever a pose na action nova enquanto se lê da
    # antiga faria a leitura seguinte vir da action que já se está sobrescrevendo.
    _assign_action(arm, ACTION_NAME)
    sampled = []
    for frame, lift in shots:
        scene.frame_set(int(frame))
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
        _key_frame(arm, index)
        arm.keyframe_insert("location", frame=index)

    anim_gait._linear_curves(action)
    scene.frame_start, scene.frame_end = 0, len(shots) - 1
    scene.render.fps = FPS
    scene.frame_set(0)

    return {"action": action.name, "frames": len(shots),
            "seconds": round(len(shots) / FPS, 3),
            "rise_m": round(shots[-1][1], 3),
            "note": "andaime — apagado pelo export.py, recriável com bake_preview()"}


#: Vistas do preview. A frontal entra aqui e não entrou no pulo porque numa
#: escada ela é a que mostra o que mais denuncia: mão e pé caindo fora da barra,
#: ou o corpo torto entre os montantes.
VIEWS = {
    "side": ("LEFT", 0.0, 0.06),
    "quarter": ("LEFT", 0.75, 0.20),
    "front": ("FRONT", 0.0, 0.06),
}


def render(out_dir: str, width: int = 460, height: int = 720,
           views=("side", "quarter", "front"), zoom: float = 0.95,
           cycles: int = PREVIEW_CYCLES) -> dict:
    """Renderiza a subida em cada vista, um PNG por quadro.

    A câmera **sobe junto** com o personagem, e a escada fica parada. É o
    contrário do preview do pulo, e de propósito: aqui o que se julga é a
    pegada, não a altura. Com o enquadramento fixo, três ciclos de subida deixam
    o pirata do tamanho de uma unha no topo do quadro; com a câmera junto, são
    as barras que passam — e é justamente vê-las passar sem arrastar as mãos
    que prova o clipe.
    """
    import os

    import anim_preview

    scene = bpy.context.scene
    arm = bpy.data.objects[anim_gait.ARMATURE_NAME]
    mesh = bpy.data.objects[anim_gait.MESH_NAME]
    shots = timeline(cycles)
    ladder, ladder_mesh, ladder_material = _temp_ladder(
        FOOT_RUNG_Z - 1.2, shots[-1][1] + 2.6)

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
        _assign_action(arm, ACTION_NAME)
        with bpy.context.temp_override(window=win, area=area, region=region):
            for name in views:
                axis, orbit_x, orbit_y = VIEWS[name]
                arm.location.z = 0.0
                scene.frame_set(0)
                bpy.ops.view3d.view_axis(type=axis)
                if orbit_x:
                    bpy.ops.view3d.view_orbit(angle=orbit_x, type="ORBITLEFT")
                if orbit_y:
                    bpy.ops.view3d.view_orbit(angle=orbit_y, type="ORBITUP")
                bpy.ops.view3d.view_selected()
                space.region_3d.view_distance *= zoom
                base_z = space.region_3d.view_location.z

                for index, (frame, lift) in enumerate(shots):
                    scene.frame_set(int(frame))
                    arm.location.z = lift
                    location = space.region_3d.view_location.copy()
                    location.z = base_z + lift
                    space.region_3d.view_location = location
                    scene.render.filepath = os.path.join(out_dir, name,
                                                         f"f_{index:04d}")
                    bpy.ops.render.opengl(write_still=True, view_context=True)
                written[name] = len(shots)
    finally:
        space.shading.type, space.overlay.show_overlays = previous[0], previous[1]
        arm.location.z = previous[2]
        if previous[3] is not None:
            _assign_action(arm, previous[3].name)
        scene.frame_set(0)
        bpy.data.objects.remove(ladder)
        bpy.data.meshes.remove(ladder_mesh)
        bpy.data.materials.remove(ladder_material)

    written["frames"] = len(shots)
    written["seconds"] = round(len(shots) / FPS, 3)
    return written
