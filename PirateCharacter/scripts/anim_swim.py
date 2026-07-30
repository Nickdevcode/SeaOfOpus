"""Nado de braçada na superfície: crawl de **cabeça erguida**.

O jogo não deixa mergulhar, e essa regra não é um detalhe de câmera — ela escolhe
o estilo de nado. Crawl de competição respira de lado e passa metade do ciclo com
o rosto na água; aqui o rosto **nunca** entra. O que sobra é o crawl de cabeça
erguida, o nado de resgate: mesma braçada alternada, mesma pernada, mas com o
tronco mais inclinado, o pescoço estendido, a braçada mais curta e o rolamento
cortado à metade. É o compromisso que todo jogo de pirata faz, e é o que mantém a
câmera de primeira pessoa fora da água.

Ele custa caro em eficiência — e é honesto que custe: este clipe nada a
1,32 m/s nativos contra os 1,5 m/s de projeto (ver `CYCLE_DISTANCE`).

## O contrato de água

Nos clipes de terra `z = 0` é o convés, debaixo dos pés. Aqui `z = 0` é a
**linha d'água**, e isso muda quem manda na altura do corpo:

- O corpo é **deitado e reposicionado** pelo `root` — rotação e translação de
  pose — de modo que o tronco fique **sobre a origem**. Girar sem transladar
  deixaria a origem nos pés e o corpo esparramado um metro e meio à frente dela:
  no jogo o avatar apareceria deslocado da posição do jogador. A âncora é a
  cabeça do `spine_03` (o esterno), e ela cai a `TRUNK_DEPTH` da superfície.
- A **cabeça inteira** fica acima de `z = 0`. E não por conferência depois do
  fato: a folga do rosto é a **entrada** do problema. `solve_attitude` resolve
  qual atitude de tronco produz a folga pedida, medindo a malha deformada de
  verdade — é o mesmo espírito do `ankle_height` do `anim_gait`, que põe a sola
  no convés em vez de chutar a altura do tornozelo.
- O clipe **não** anima a subida e a descida pela onda; isso é do runtime. O que
  ele tem é micro-oscilação de braçada (`HEAVE`, `SURGE`, `PITCH_PULSE`), na
  ordem de um centímetro — o bastante para o corpo não parecer um flutuador
  rígido, pouco o bastante para não competir com a onda que o motor põe por cima.
- O **avanço não é do clipe**. Como `Walk` e `Run`, ele é indexado pela distância
  percorrida: `CYCLE_DISTANCE` é quanto o corpo anda numa braçada completa, e a
  velocidade nativa cai daí.

## Por que a atitude do tronco é a variável resolvida, e não a da cabeça

As duas poderiam levantar o rosto. A da cabeça tem batente: extensão cervical
humana vai a uns 70°, e um pescoço no batente lê como pescoço quebrado. A do
tronco não tem batente anatômico — ela custa **arrasto**, que é exatamente a
moeda que o nadador de cabeça erguida gasta. Então a extensão de pescoço fica
fixa num valor anatômico (`NECK_EXTENSION` + `HEAD_EXTENSION` = 42°, o que um
jogador de polo aquático faz durante uma partida inteira) e quem se ajusta é o
tronco. Se um dia a folga pedida exigir tronco além de `PITCH_LIMITS`, o
`solve_attitude` clampa e **avisa** no relatório em vez de entregar um pirata com
o rosto na água.

## O que faz a braçada parecer nado

Resistência de fluido é o assunto. Em terra o defeito capital é o pé patinar;
aqui é o membro se mover como se o meio não existisse. Quatro coisas dão conta:

1. **A velocidade ao longo do caminho é irregular de propósito.** A mão entra
   devagar (1,5 m/s), a puxada acelera até 4 m/s no empurrão, a recuperação
   cruza solta a 2,9 m/s e **desacelera** para entrar. Isso está escrito no
   espaçamento das chaves de `HAND_PATH`, não numa curva de tempo por cima.
2. **A palma vira ao longo do gesto** (`PALM_FACING`): de gume na entrada, para
   trás na apanhada, para dentro na varredura, para cima na saída, solta na
   recuperação. Uma palma travada numa direção só é o que mais denuncia nado
   feito às pressas — a mão fica remando de canto.
3. **O cotovelo é alto** na apanhada e na varredura (`ELBOW_HINT`), porque é o
   antebraço que empurra água, não a mão sozinha.
4. **O tronco rola atrás do braço que puxa** — mas só 15°, contra os 40° do
   crawl de competição: rolar mais enterra o rosto, e o rosto é o contrato.

A pernada é de crawl, três batidas por braçada (`KICK_CYCLES`), joelho quase
esticado e amplitude pequena. Ela não é decorativa: sem ela as pernas deste
personagem afundam e o gesto lê como alguém se debatendo.

E a cabeça fica **quieta**. Ela é a referência do jogador em primeira pessoa;
chicotear ali é náusea. O `verify` mede a taxa angular dela por segundo.

Convenções do rig, como no resto da pasta: o personagem encara **-Y** (e nada
para lá), 1 unidade = 1 metro, **+X é a esquerda dele**. O que muda é só o
significado de `z = 0`.
"""

from __future__ import annotations

import math

import bpy
from mathutils import Matrix, Vector

import anim_carry
import anim_climb
import anim_gait

ACTION_NAME = "Swim"

FPS = 30

#: Quadros de uma braçada completa — os **dois** braços, como a passada da
#: caminhada são os dois pés.
#:
#: 30 quadros = 1,0 s = 120 braços por minuto. É cadência alta, e é o que o nado
#: de cabeça erguida faz: braçada curta e rápida, porque manter o rosto fora da
#: água não permite o deslize longo do crawl deitado. Trinta também divide por 3,
#: que é o que deixa a pernada de três batidas fechar em número inteiro de
#: quadros (10 por batida) e o laço não engasgar.
CYCLE_FRAMES = 30

#: Metros de avanço por ciclo de braçada. O clipe é indexado por esta distância,
#: como `Walk` e `Run` são indexados pelo passo.
#:
#: O número não é escolhido, é derivado — e o `verify` refaz a conta relendo a
#: action. A mão varre 1,09 m para trás em relação ao corpo durante a puxada
#: (medido: `hand_sweep_cm`), duas mãos varrem 2,18 m, e o corpo não avança tudo
#: isso porque **a mão escorrega na água**: não há chão para segurar. A fração
#: que sobra é a eficiência propulsiva, e num nado de cabeça erguida ela é ruim —
#: 0,60 contra 0,75-0,85 do crawl deitado, porque o tronco inclinado arrasta e o
#: rolamento cortado encurta a alavanca. 2,18 × 0,605 ≈ 1,32.
#:
#: **Isso dá 1,32 m/s contra os 1,5 m/s de projeto.** Não vale forçar: puxar
#: 1,5 m por ciclo exigiria eficiência de 0,69, que este nado não tem, ou uma
#: braçada de 1,24 m de varredura, que este braço de 66,5 cm não alcança. O
#: acerto é no runtime, com `timeScale = 1,5 / 1,32 = 1,14` — a mesma coisa que
#: já se faz com a caminhada, que anda a 1,65 nativo contra 2,8 do jogo.
CYCLE_DISTANCE = 1.32


# -- o contrato de água -------------------------------------------------------

#: A superfície. Existe como constante para o número não virar `0.0` solto no
#: meio de uma conta de profundidade — em clipe de água o zero **significa** algo.
WATER_Z = 0.0

#: Profundidade da âncora do tronco, em metros (negativo = submerso).
#:
#: A âncora é a cabeça do `spine_03`, que fica dentro do peito na altura do
#: esterno. Com ela a 5 cm da superfície, as costas do casaco emergem uns 4 cm
#: (o tronco deste personagem mede 21 cm do eixo do rig até as costas) e o peito
#: fica uns 25 cm submerso. É a flutuação de quem nada de verdade: metade do
#: tronco fora, metade dentro.
#:
#: Não é o mesmo que dizer que a origem fica no esterno — ela fica 5 cm acima
#: dele, na altura das escápulas, **na linha d'água**. Ver `origin_on_body` no
#: relatório do `build`.
TRUNK_DEPTH = -0.050

#: Folga mínima pedida entre o ponto mais baixo da cabeça e a superfície.
#:
#: É esta linha que a atitude do tronco tem de comprar. 3,5 cm é margem de
#: engenheiro, não de artista: a onda do runtime tem amplitude própria, o clipe
#: oscila mais 1,2 cm por conta da braçada, e o rosto encostando na água **uma
#: vez** já é o defeito que este clipe existe para não ter.
FACE_CLEARANCE = 0.035

#: Peso mínimo no bone `head` para um vértice contar como "cabeça".
#:
#: Metade, e não mais: o queixo e a barba dividem influência com o `neck`, e
#: exigir 0,8 deixaria justamente o ponto mais crítico fora da conta. Quem sobra
#: do outro lado — a base do pescoço, colada ao ombro — **pode** molhar, e molha:
#: é medido em separado (`neck_min_cm`) para o número da cabeça não ser
#: contaminado por ela.
HEAD_SHELL_WEIGHT = 0.5

#: Bone cuja cabeça é a âncora do corpo na origem. O esterno.
ANCHOR_BONE = "spine_03"


# -- atitude do corpo ---------------------------------------------------------

#: Extensão cervical, em graus, repartida entre pescoço e cabeça.
#:
#: Os 42° somados são o que um jogador de polo aquático sustenta durante uma
#: partida — extensão forte, longe do batente de ~70°. Reparti-los é o que
#: impede o vinco: concentrar tudo no bone `head` faria a nuca dobrar num ponto
#: só e o gorjal do casaco atravessaria a mandíbula.
#:
#: Mais extensão gastaria menos inclinação de tronco (e portanto menos arrasto),
#: mas o pescoço passaria a ler como travado. Menos extensão exigiria tronco tão
#: erguido que o pirata pareceria estar sentado na água.
NECK_EXTENSION = 20.0
HEAD_EXTENSION = 22.0

#: Arqueamento do tronco, em graus (negativo = extensão, peito para cima).
#:
#: Quem nada de cabeça erguida arqueia a lombar — é o que põe o peito na
#: superfície sem ter de erguer o corpo inteiro. Repartido pela coluna:
#: concentrado num bone só faz um vinco no casaco em vez de um tronco arqueado,
#: exatamente como no `anim_gait.pose_spine`.
#:
#: **Dezesseis graus, e não oito, porque a medição mostrou quem é a alavanca
#: boa.** Varrendo extensão cervical contra arqueamento e lendo a inclinação de
#: tronco que o `solve_attitude` devolvia:
#:
#: | pescoço | arco -8° | arco -14° | arco -20° |
#: |---|---|---|---|
#: | 42° | 28,5° | 21,9° | 15,4° |
#: | 52° | 25,2° | 18,7° | 12,2° |
#: | 60° | 22,3° | 15,8° |  9,3° |
#:
#: Cada 6° de arco compram 6,5° de tronco; cada 10° de pescoço compram 3. Faz
#: sentido: arquear gira o corpo inteiro acima da lombar, e a cabeça vai junto;
#: estender o pescoço gira só a cabeça. Com arco de 8° o pirata nadava a 28° de
#: inclinação, e a folha de contato mostrava alguém **mergulhando ladeira
#: abaixo** em vez de nadando na superfície. Com 16° a inclinação cai para 20°,
#: que é o meio da faixa do crawl de cabeça erguida (15-25°), sem o pescoço
#: precisar sair dos 42° anatômicos.
SPINE_ARCH = -16.0

#: Faixa em que `solve_attitude` pode procurar a inclinação do tronco, em graus
#: acima da horizontal.
#:
#: O teto de 34° não é geometria, é leitura: além disso o corpo deixa de ler como
#: nado e passa a ler como alguém pedalando na água de pé. O piso de 4° existe
#: para o solver não devolver um corpo horizontal caso alguém baixe
#: `FACE_CLEARANCE` a zero.
PITCH_LIMITS = (4.0, 34.0)

#: Quantas bisseções o solver faz. Vinte fecham 30° em 0,00003° — muito mais que
#: o necessário, e ainda assim vinte avaliações de malha, que custam milissegundos.
PITCH_STEPS = 20


# -- micro-oscilação ----------------------------------------------------------
#
# Tudo pequeno, e o motivo é o contrato: a subida e a descida pela onda são do
# runtime. O que sobra aqui é só o que a **braçada** faz ao corpo, e a braçada
# faz pouco — num nadador competente o quadril quase não sobe. Amplitude grande
# aqui não lê como nado, lê como boia.

#: Meia amplitude vertical do corpo, em metros. Duas subidas por ciclo, uma por
#: braço.
HEAVE = 0.012
#: Meia amplitude de avanço e recuo, em metros.
#:
#: A velocidade de quem nada **não** é constante dentro do ciclo: o corpo
#: acelera no empurrão e desacelera na entrada. Somado ao avanço constante que o
#: motor aplica, este vaivém de 6 mm é justamente essa variação. É pequeno de
#: propósito: o clipe é indexado por distância, e qualquer coisa maior começaria
#: a discutir com a indexação em vez de enfeitá-la.
SURGE = 0.006
#: Meia amplitude do cabeceio, em graus. O peito sobe quando a mão apanha a água.
PITCH_PULSE = 1.4
#: Fase das três oscilações, em fração de ciclo.
#:
#: Escolhida para o pico cair na **apanhada** (fase 0,22 de cada braço), que é
#: quando a mão pressiona a água para baixo e o corpo responde subindo. Com a
#: oscilação em 2× o ciclo, isso põe a fase em 0,22 - 0,125 = 0,095.
PULSE_PHASE = 0.095

#: Rolamento máximo do tronco em torno do eixo longo, em graus.
#:
#: Quinze, contra os 35-45° do crawl de competição. O corte é o preço da cabeça
#: fora da água: o rolamento gira o rosto junto, e a 40° o queixo entra na água
#: em metade do ciclo, por mais alto que o tronco esteja. O que se perde é
#: comprimento de braçada — e é por isso que a eficiência deste nado é 0,60.
ROLL = 15.0
#: Diferença de profundidade entre as duas mãos que satura o rolamento, em
#: metros. Sai do próprio `HAND_PATH`: a mão que puxa chega a -0,36 e a que
#: recupera a +0,11, ou seja 0,47 de diferença no auge.
ROLL_SPAN = 0.45
#: Quanto do rolamento o quadril acompanha, como fração.
#:
#: O crawl gira o corpo inteiro em torno do eixo longo — inclusive as pernas, e é
#: isso que dá o "rolamento de eixo longo" que os treinadores cobram. Mas o
#: ombro rola mais que o quadril, sempre: 0,55 no quadril e o resto repartido
#: pela coluna, de modo que o ombro receba o total.
HIP_ROLL_SHARE = 0.55
#: Quanto a cabeça acompanha o rolamento do tronco, como fração.
#:
#: Um quinto. Zero seria uma cabeça presa num tripé, e lê como robô; um seria a
#: cabeça rolando com o tronco, e aí o rosto entra na água. Um quinto é o que
#: sobra de um nadador que fixa o olhar na frente e deixa o corpo girar por baixo.
HEAD_ROLL_FOLLOW = 0.20


# -- a braçada ----------------------------------------------------------------

#: Fase em que a mão **larga** a água, em fração do ciclo do braço. É a chave de
#: saída do `HAND_PATH`, repetida aqui como declaração de intenção.
#:
#: Com os braços defasados 0,5, qualquer coisa acima de 0,50 garante uma mão na
#: água o tempo todo — e esse "o tempo todo" é o que o nado de cabeça erguida
#: precisa: a propulsão contínua é o que sustenta o peso da cabeça fora da água.
#: Crawl deitado pode se dar ao luxo de um deslize sem mão nenhuma empurrando;
#: este não.
#:
#: O valor é declarado e **conferido**, e a conferência corrige a declaração:
#: `pull_fraction_measured` dá **0,60**, não 0,52. A diferença é honesta e vem da
#: geometria — a mão ainda está 5,5 cm abaixo da linha d'água na chave de saída e
#: só emerge por volta de 0,56, e na entrada ela já furou a superfície em 0,96.
#: Na prática são 20% do ciclo com as **duas** mãos empurrando, que é mais
#: sobreposição do que a constante promete e melhor do que ela prometia.
PULL_END = 0.52

#: Caminho da mão **esquerda**, em coordenadas absolutas do rig. O lado direito
#: espelha o X.
#:
#: Coordenada absoluta e não relativa ao ombro, e isso é escolha: a origem deste
#: clipe cai num marco do corpo (a linha d'água sobre o esterno), então "y =
#: -0,75" já quer dizer "75 cm à frente do esterno". Amarrar ao ombro faria o
#: caminho perseguir um ombro que rola, e o gesto perderia a referência fixa.
#:
#: O espaçamento das chaves **é** o perfil de velocidade — ver a nota 1 do topo
#: do arquivo. Cada trecho está anotado com o que ele custa em m/s.
HAND_PATH = (
    # Entrada: pontas dos dedos furando a superfície, à frente e um pouco fora
    # da linha do ombro. Não é o ponto de alcance máximo — o crawl entra com o
    # cotovelo ainda dobrado e **estende debaixo da água**.
    (0.00, (0.240, -0.660, -0.020)),
    # Extensão completa. É aqui que o braço mais estica (91% medidos), e o
    # trecho anterior levou 0,10 do ciclo para andar 15 cm: 1,5 m/s, a mão
    # desacelerando contra a água em vez de cravar.
    (0.10, (0.205, -0.750, -0.130)),
    # Apanhada: a mão pressiona para baixo e para trás, cotovelo alto. 2,4 m/s.
    (0.22, (0.180, -0.520, -0.300)),
    # Varredura para dentro, sob o peito. O ponto mais fundo do gesto.
    #
    # Ela não vai até a linha do meio, e a razão é medida: com x = 0,11 a mão
    # passava a **1 mm** da aba do casaco (`hand|core` no `verify`). Um crawl de
    # verdade cruza a linha do corpo, mas este pirata tem 25 cm de barriga à
    # frente do eixo do rig — o que sobra de vão é menos do que a anatomia
    # sugere, e 15 cm de afastamento é o que devolve folga sem descaracterizar
    # a varredura em S.
    (0.32, (0.150, -0.260, -0.385)),
    # Sob a cintura, já subindo — a mão vira e começa a empurrar para trás.
    (0.40, (0.152, 0.000, -0.335)),
    # Empurrão: para trás e para fora, o trecho mais rápido do ciclo. 4,1 m/s.
    (0.46, (0.200, 0.200, -0.190)),
    # Saída, junto ao quadril e na superfície. Os 29 cm de afastamento são
    # medidos, não estéticos: a 26 cm a mão saía a 6 mm da aba do casaco sobre a
    # coxa, e a saída da braçada é justamente onde a mão tem de **passar** pelo
    # quadril sem enfiar a mão no bolso.
    (0.52, (0.290, 0.340, -0.055)),
    # Fora da água. A mão sobe pouco: recuperação **rasa**, ver a nota abaixo.
    (0.60, (0.330, 0.340, 0.080)),
    # Meio da recuperação, larga o bastante para o antebraço não raspar o casaco.
    (0.72, (0.400, 0.020, 0.110)),
    # Já à frente do ombro, começando a fechar para dentro.
    (0.86, (0.350, -0.380, 0.100)),
    # Desacelerando para entrar: 2,8 m/s aqui contra 1,8 no trecho seguinte.
    (0.94, (0.280, -0.580, 0.040)),
)
#: Sobre a **altura da recuperação**, que sai do `HAND_PATH` acima e é medida em
#: `build` como `recovery_height_cm`: são 11 cm, contra os 30-40 cm de um crawl
#: de competição.
#:
#: Recuperação alta exige rolar o corpo, e rolar enterra o rosto. Braço rasante,
#: cotovelo baixo e mão quase raspando a água é o que o nado de resgate faz, e é
#: o que este clipe faz. Não há constante aqui de propósito: um número repetido
#: fora da trilha vira mentira na primeira vez que alguém mexer nela.

#: Para onde aponta o cotovelo, por fase do braço. X positivo é para **fora**
#: (o lado direito espelha).
#:
#: Não é detalhe de IK, é técnica. "Cotovelo alto" é o único jargão de natação
#: que vale um comentário aqui: na apanhada e na varredura o cotovelo fica acima
#: da mão, quase na superfície, e é o **antebraço** que faz a pá. Com o cotovelo
#: caído, a mão sozinha empurra água e o gesto lê como cachorrinho.
ELBOW_HINT = (
    (0.00, (0.50, -0.10, 0.86)),   # entrada: cotovelo alto e um pouco à frente
    (0.22, (0.60, 0.00, 0.80)),    # apanhada: cotovelo acima da mão
    (0.32, (0.78, 0.10, 0.62)),    # varredura: abre para fora
    (0.46, (0.82, 0.24, 0.52)),    # empurrão: cotovelo para fora e para trás
    (0.60, (0.72, 0.34, 0.60)),    # saída: o cotovelo sai primeiro
    (0.72, (0.58, 0.52, 0.63)),    # recuperação: cotovelo à frente do ombro
    (0.86, (0.52, 0.60, 0.61)),
    (0.94, (0.50, 0.30, 0.81)),
)

#: Para onde a **palma** olha, por fase do braço. X positivo é para fora.
#:
#: É a trilha que mais muda a leitura do clipe, e a que menos aparece em
#: métrica: uma palma travada satisfaz toda medição de posição e ainda assim
#: rema de canto. A sequência é a do crawl: gume na entrada (a mão corta), para
#: trás na apanhada, para **dentro** na varredura (a palma segue a curva em S),
#: para cima na saída, e solta na recuperação, com o dorso à frente.
PALM_FACING = (
    (0.00, (0.30, 0.10, -0.95)),
    (0.22, (0.18, 0.55, -0.82)),
    (0.32, (-0.22, 0.92, -0.32)),
    (0.46, (0.22, 0.94, 0.25)),
    (0.52, (0.20, 0.62, 0.76)),
    # Chave intermediária só para governar a virada de 180° da saída para a
    # recuperação: sem ela a interpolação passa perto do vetor nulo e o roll da
    # mão dá um giro aleatório em dois quadros.
    (0.62, (-0.15, 0.55, -0.20)),
    (0.72, (-0.55, 0.20, -0.81)),
    (0.86, (-0.35, -0.18, -0.92)),
    (0.94, (0.05, -0.05, -0.99)),
)

#: Projeção do ombro por fase do braço: +1 é ombro à frente e fora da água, -1 é
#: ombro recuado e afundado.
#:
#: O ritmo escápulo-umeral também vale aqui, e vale duplo: além dos centímetros
#: de alcance que ele empresta (a mesma nota do `anim_climb`), é a escápula que
#: tira o ombro da água na recuperação. Sem ela o braço parece pregado no tronco
#: e a recuperação raspa a própria roupa.
SHOULDER_TRACK = (
    (0.00, 0.35),
    (0.22, -0.60),
    (0.52, -0.20),
    (0.72, 1.00),
    (0.94, 0.70),
)
#: Ganhos da clavícula, em graus. `LIFT` tira o ombro da água; `REACH` o joga
#: para a frente do nado.
SHOULDER_LIFT = 7.0
SHOULDER_REACH = 5.0

#: Distância do punho ao centro da palma, em metros.
#:
#: O efetor deste clipe é a **palma**, não o punho, pelo mesmo motivo do
#: `anim_climb`: mirar o punho joga fora 3,5 cm de alcance e, pior, mede a
#: excursão da mão errada. Aqui não há barra para envolver, então o valor é só o
#: centro da mão — o bone mede 5,75 cm e a mão da malha um pouco mais.
PALM_REACH = 0.035

#: Teto de extensão dos membros. O mesmo do resto da pasta: 100% trava a
#: articulação e denuncia a IK.
ARM_EXTENSION_LIMIT = 0.980
LEG_EXTENSION_LIMIT = 0.985

#: Fecho dos dedos, em graus por falange.
#:
#: Quase nada, e é o ponto: a mão que nada é uma **pá** — dedos juntos e
#: levemente em concha. O fecho da escada (42/48) viraria punho, e punho não
#: empurra água, cavita. Na recuperação a mão relaxa um pouco mais, que é o que
#: uma mão fora da água faz.
FINGER_CURL = (12.0, 16.0)
FINGER_CURL_LOOSE = (20.0, 26.0)
#: O polegar encosta na borda da mão para fechar a pá. Dedo aberto vaza água.
THUMB_CURL = (18.0, 14.0)
FINGERS = anim_climb.FINGERS


# -- a pernada ----------------------------------------------------------------

#: Batidas de pernada por braçada completa, por perna.
#:
#: Três é o "seis tempos" dos treinadores (seis batidas por ciclo, três de cada
#: perna) e é o que mais gente faz. Dois seria o crawl de fundo, econômico e
#: preguiçoso; quatro só aparece em sprint. Três também é o que fecha em número
#: inteiro de quadros: 30 / 3 = 10 quadros por batida.
KICK_CYCLES = 3.0
#: Defasagem da pernada em relação à braçada, em fração do ciclo da perna.
KICK_LEAD = 0.0

#: Ângulo da perna no plano sagital, em graus. **Positivo desce o pé.**
#:
#: Amplitude de 28° sobre uma perna de 78,8 cm dá 38 cm de excursão de tornozelo
#: — a faixa de uma pernada de crawl de verdade (30-45 cm). O tempo é
#: assimétrico de propósito: a descida leva 0,42 do ciclo e a subida 0,58,
#: porque é a **descida** que empurra. Simétrico lê como tesoura de brinquedo.
KICK_ANGLE = (
    (0.00, -13.0),   # alto da subida: quadril fletido, pé perto da superfície
    (0.20, 1.0),
    (0.42, 15.0),    # fundo da descida — o chicote
    (0.70, 3.0),
)
#: Extensão da perna ao longo da batida, como fração de quadril-tornozelo.
#:
#: O joelho dobra no começo da descida e **estica no fim** — é essa sequência
#: que faz o chicote, e é o que separa a pernada de crawl de uma perna de pau
#: girando no quadril. 0,945 são 39° de joelho e 0,982 são 22°; nenhum dos dois
#: chega perto de travar, e a faixa fica dentro dos 85-98% do resto da pasta.
KICK_EXTENSION = (
    (0.00, 0.945),
    (0.25, 0.962),
    (0.42, 0.982),
    (0.70, 0.964),
)
#: Dorsiflexão do tornozelo, em graus a partir do pé alinhado com a canela.
#:
#: Perto de zero é pé em ponta, que é o pé de quem nada. Mas não zero: pé em
#: ponta absoluto é pose de bailarina e este personagem está de bota. Os valores
#: vão de 10° no fim da descida (o pé mais em ponta, empurrando) a 22° no alto
#: da subida, quando a água empurra o pé de volta.
ANKLE_DORSI = (
    (0.00, 22.0),
    (0.42, 10.0),
    (0.70, 17.0),
)
#: Quanto o pé converge para a linha do meio, como componente lateral da direção
#: da perna.
#:
#: Este rig abre: o quadril fica em x = 0,118 e o tornozelo em repouso em 0,215,
#: quase 10 cm de abertura. Quem nada mantém as pernas juntas — a pernada aberta
#: é freio. Este valor traz o tornozelo para x ≈ 0,09.
LEG_CONVERGE = 0.037

#: Para onde aponta o joelho. Não é o mesmo palpite dos clipes de terra, e não
#: pode ser: o joelho aponta para a **frente do corpo**, e neste clipe a frente
#: do corpo aponta para **baixo**. Copiar o `(0, -1, 0)` do `anim_gait` faria o
#: joelho dobrar para o lado.
KNEE_HINT = (0.15, -0.28, -0.95)


# -- trilhas ------------------------------------------------------------------


def track(keys, t: float) -> float:
    """Valor de uma trilha **cíclica** `(fase, valor)` na fase *t*.

    Não é o `anim_jump.track`, e a diferença importa. Aquele interpola com
    `smoothstep` entre chaves, o que zera a derivada **em cada chave** — ótimo
    para um clipe de pose, onde o corpo de fato pousa em cada extremo. Numa
    braçada de onze chaves por segundo, isso é a mão parando onze vezes por
    ciclo: na água lê como engasgo, porque água não deixa nada parar e voltar a
    andar de graça.

    Aqui a interpolação é Catmull-Rom com espaçamento não uniforme: passa por
    todas as chaves e chega em cada uma com a velocidade média das vizinhas, o
    que dá continuidade de primeira ordem e um caminho com inércia. O preço é
    que ela pode **ultrapassar** entre chaves — o `verify` mede a profundidade
    extrema da mão justamente para essa ultrapassagem não pôr a mão fora da água
    no meio da puxada.

    A ciclicidade é de verdade: a chave depois da última é a primeira somada a um
    ciclo, então o laço fecha sem costura e sem exigir chave repetida em 1,0.
    """
    n = len(keys)
    t = t % 1.0

    def key(i: int):
        wrap, j = divmod(i, n)
        phase, value = keys[j]
        return phase + wrap, value

    # Trecho que contém *t*. O -1 cobre o intervalo entre a última chave do ciclo
    # anterior e a primeira deste, que existe sempre que keys[0][0] > 0.
    index = -1
    for i in range(n):
        if keys[i][0] <= t:
            index = i
    t1, v1 = key(index)
    t2, v2 = key(index + 1)
    t0, v0 = key(index - 1)
    t3, v3 = key(index + 2)

    span = t2 - t1
    s = (t - t1) / span
    # Tangentes de Catmull-Rom, escaladas para o parâmetro local do trecho.
    m1 = (v2 - v0) / (t2 - t0) * span
    m2 = (v3 - v1) / (t3 - t1) * span
    s2, s3 = s * s, s * s * s
    return ((2.0 * s3 - 3.0 * s2 + 1.0) * v1
            + (s3 - 2.0 * s2 + s) * m1
            + (-2.0 * s3 + 3.0 * s2) * v2
            + (s3 - s2) * m2)


def track_vector(keys, t: float, mirror: float = 1.0) -> Vector:
    """A mesma interpolação, componente a componente.

    ``mirror`` multiplica o X: as trilhas descrevem o lado **esquerdo** e o
    direito é o espelho. Espelhar aqui, e não na chamada, é o que impede o erro
    de espelhar o alvo e esquecer o palpite do cotovelo.
    """
    lanes = [tuple((phase, value[i]) for phase, value in keys) for i in range(3)]
    out = Vector(tuple(track(lane, t) for lane in lanes))
    out.x *= mirror
    return out


def arm_phase(t: float, side: str) -> float:
    """Fase do braço daquele lado. Zero é a entrada da mão na água."""
    return (t + (0.0 if side == "L" else 0.5)) % 1.0


def leg_phase(t: float, side: str) -> float:
    """Fase da batida daquela perna. Zero é o alto da subida."""
    return (t * KICK_CYCLES + KICK_LEAD + (0.0 if side == "L" else 0.5)) % 1.0


def hand_target(t: float, side: str) -> Vector:
    """Onde a palma daquele lado tem de estar, no espaço do rig."""
    return track_vector(HAND_PATH, arm_phase(t, side),
                        1.0 if side == "L" else -1.0)


def _clamp(value: float, low: float = -1.0, high: float = 1.0) -> float:
    return min(max(value, low), high)


# -- plano do corpo -----------------------------------------------------------


def body_plan(t: float) -> dict:
    """O que o tronco faz na fase *t*.

    O rolamento sai da **posição das próprias mãos**, e não de uma senoide: é a
    mão que puxa que afunda o ombro, então derivar da diferença de profundidade
    entre as duas mantém a fase certa mesmo que alguém mexa em `HAND_PATH`. É a
    mesma escolha do `anim_climb.body_plan`, e pelo mesmo motivo — uma senoide
    acertaria a fase por acaso hoje e erraria na primeira mexida.

    As três oscilações (`HEAVE`, `SURGE`, `PITCH_PULSE`) são senoides em 2× o
    ciclo, porque há duas braçadas por ciclo e cada uma dá seu empurrão.
    """
    depth_l = hand_target(t, "L").z
    depth_r = hand_target(t, "R").z

    # Positivo levanta o ombro **esquerdo**. Quando a mão esquerda está funda
    # (puxando) e a direita alta (recuperando), a diferença é negativa e o ombro
    # esquerdo desce — o corpo rola para o lado que puxa, que é o que dá
    # comprimento à braçada.
    roll = ROLL * _clamp((depth_l - depth_r) / ROLL_SPAN)

    beat = 2.0 * math.pi * 2.0 * (t - PULSE_PHASE)
    return {
        "roll": roll,
        "heave": HEAVE * math.sin(beat),
        "surge": SURGE * math.sin(beat),
        "pitch_pulse": PITCH_PULSE * math.sin(beat),
    }


def _aim_root(root, pitch: float, plan: dict, offset: Vector) -> None:
    """Deita o corpo, rola-o no eixo longo e o põe sobre a origem.

    A ordem das duas rotações não é indiferente e não é gosto: `R_x` depois
    `R_z`. Em repouso o eixo longo do corpo é o **+Z**, então um rolamento em
    torno dele é uma rotação em Z; deitar depois disso (`R_x`) carrega o
    rolamento junto e ele continua sendo em torno do eixo longo. Na ordem
    trocada, o "rolamento" viraria uma guinada do corpo deitado — o pirata
    nadando de lado.

    ``offset`` é o que põe o tronco sobre a origem, e ele não é chutado: sai de
    `solve_attitude`, que posiciona o corpo com deslocamento zero, **lê** onde a
    âncora foi parar e subtrai.

    O cabeceio da braçada (`pitch_pulse`) entra **depois** do deslocamento, e não
    junto com `lay`. Isso já foi um defeito medido: as duas rotações pivotam na
    origem do rig, que antes do deslocamento fica nos **pés**; um cabeceio de
    1,4° em torno de um pivô a 1,13 m do esterno movia a âncora 2,8 cm para cima
    e para baixo, e o rosto — que estava com 4,7 cm de folga na pose neutra —
    encostava na água no quadro 14. Aplicado depois, o pivô é a própria origem,
    ou seja o esterno, e o cabeceio move a âncora 1,2 mm.
    """
    lay = Matrix.Rotation(math.radians(90.0 - pitch), 4, "X")
    spin = Matrix.Rotation(math.radians(plan["roll"] * HIP_ROLL_SHARE), 4, "Z")
    move = Matrix.Translation(offset + Vector((0.0, plan["surge"], plan["heave"])))
    nod = Matrix.Rotation(math.radians(-plan["pitch_pulse"]), 4, "X")
    root.matrix = nod @ move @ lay @ spin @ root.bone.matrix_local


def _pose_torso(pose, plan: dict) -> None:
    """Coluna, clavículas, pescoço e cabeça.

    Duas notas de sinal, porque as duas já custaram tempo em outros arquivos
    desta pasta:

    - Em ``world_rotation`` os eixos são os do **mundo em repouso**, e em
      repouso este personagem está de pé. Então ``X`` continua sendo
      flexão/extensão no plano sagital do corpo e ``Z`` continua sendo rolamento
      em torno do eixo longo, esteja o corpo deitado ou não. É isso que deixa
      escrever "arqueia 8°" sem pensar em como o corpo está orientado.
    - ``X`` positivo joga o topo do bone para -Y, ou seja, flexão para a frente.
      O arqueamento é **negativo** de propósito.
    """
    spine_roll = plan["roll"] * (1.0 - HIP_ROLL_SHARE)

    pose["pelvis"].rotation_quaternion = anim_gait.world_rotation(
        pose["pelvis"], [("X", SPINE_ARCH * 0.10)])

    # O arqueamento e o resto do rolamento repartidos pela coluna. As frações
    # somam 1 nos dois casos: o ombro recebe o rolamento inteiro, o quadril só a
    # parte que o `root` já deu.
    for name, share in (("spine_01", 0.30), ("spine_02", 0.35), ("spine_03", 0.35)):
        pose[name].rotation_quaternion = anim_gait.world_rotation(
            pose[name], [("Z", spine_roll * share), ("X", SPINE_ARCH * share)])

    # A cabeça desfaz quase todo o rolamento do tronco: o olhar fica preso na
    # frente e o corpo gira por baixo. E a extensão cervical é o que tira o
    # rosto da água — ela é fixa, porque uma cabeça que oscila em pitch é a
    # coisa que mais incomoda em primeira pessoa.
    undo = -plan["roll"] * (1.0 - HEAD_ROLL_FOLLOW)
    pose["neck"].rotation_quaternion = anim_gait.world_rotation(
        pose["neck"], [("Z", undo * 0.5), ("X", -NECK_EXTENSION)])
    pose["head"].rotation_quaternion = anim_gait.world_rotation(
        pose["head"], [("Z", undo * 0.5), ("X", -HEAD_EXTENSION)])


def _pose_clavicles(pose, t: float) -> None:
    """Projeta cada ombro pela fase do **seu** braço.

    Os sinais, uma vez que o corpo está deitado, deixam de ser óbvios — vale
    escrever o que cada eixo faz aqui:

    - ``Y`` é elevação no referencial do corpo. Com o corpo deitado, o "alto" do
      corpo aponta para a frente do nado, então ``Y`` leva o ombro **à frente**.
    - ``Z`` é protração no referencial do corpo. Com o corpo deitado, ela leva o
      ombro **para cima**, fora da água. É a que importa na recuperação.
    """
    for side in ("L", "R"):
        sign = 1.0 if side == "L" else -1.0
        bias = track(SHOULDER_TRACK, arm_phase(t, side))
        pose[f"clavicle.{side}"].rotation_quaternion = anim_gait.world_rotation(
            pose[f"clavicle.{side}"],
            [("Z", sign * bias * SHOULDER_LIFT),
             ("Y", -sign * bias * SHOULDER_REACH)])


# -- membros ------------------------------------------------------------------


def _pose_arm(pose, data: dict, side: str, target: Vector,
              hint: Vector, palm: Vector) -> tuple[float, float, Vector]:
    """Um braço por IK, com a **palma** em *target*.

    Devolve `(erro, extensão, palma)`. A cadeia é ombro → cotovelo → palma, com
    a mão contando como o último pedaço do antebraço — o caminho do `anim_climb`.

    O roll da mão é escolhido, não sobra: `anim_carry._aim_hand` põe a palma na
    direção pedida no que resta perpendicular ao antebraço. Sem isso a IK deixa
    a mão em qualquer giro que satisfaça a posição, e metade da braçada sai com a
    palma de canto — remando com a lateral do dedo mínimo, que é fisicamente
    inútil e visualmente evidente.
    """
    upper = pose[f"upperarm.{side}"]
    shoulder = upper.matrix.translation.copy()

    forearm = data["forearm"] + PALM_REACH
    reach = data["humerus"] + forearm
    extension = (target - shoulder).length / reach

    elbow = anim_gait.solve_leg(shoulder, target, data["humerus"], forearm,
                                ARM_EXTENSION_LIMIT, Vector(hint))
    anim_gait.aim_bone(upper, elbow - shoulder, shoulder)
    bpy.context.view_layer.update()

    lower = pose[f"lowerarm.{side}"]
    anim_gait.aim_bone(lower, target - elbow, lower.matrix.translation.copy())
    bpy.context.view_layer.update()

    hand = pose[f"hand.{side}"]
    wrist = hand.matrix.translation.copy()
    direction = (target - wrist).normalized()
    anim_carry._aim_hand(hand, direction, palm)
    bpy.context.view_layer.update()

    got = hand.matrix.translation + direction * PALM_REACH
    return (got - target).length, extension, got


def _pose_leg(pose, data: dict, side: str, t: float) -> tuple[float, float, Vector]:
    """Uma perna, resolvida como batida de pernada. Devolve `(erro, extensão, tornozelo)`.

    A direção da perna sai da atitude **medida** do quadril (o bone `pelvis` já
    posado), e não de um vetor absoluto: assim a pernada acompanha o rolamento e
    o cabeceio do tronco de graça. O giro da batida é em torno do X do mundo em
    vez do eixo lateral exato do corpo — com rolamento de 15°, a diferença é uma
    componente lateral de milímetros na batida, e ela até ajuda: pernada de
    verdade não é perfeitamente sagital.
    """
    sign = 1.0 if side == "L" else -1.0
    k = leg_phase(t, side)

    # "Para baixo do corpo": o oposto da direção do bone do quadril.
    pelvis = pose["pelvis"]
    down = -(pelvis.matrix.to_3x3() @ Vector((0.0, 1.0, 0.0))).normalized()

    # Sinal invertido porque `rotate_x` positivo **levanta** o pé quando a perna
    # aponta para trás e para baixo. Conferido: a constante promete "positivo
    # desce o pé", e é isso que o clipe faz.
    direction = anim_gait.rotate_x(down, -track(KICK_ANGLE, k))
    direction.x -= sign * LEG_CONVERGE
    direction.normalize()

    thigh = pose[f"thigh.{side}"]
    hip = thigh.matrix.translation.copy()
    span = data["femur"] + data["tibia"]
    extension = track(KICK_EXTENSION, k)
    ankle = hip + direction * (span * extension)

    knee = anim_gait.solve_leg(hip, ankle, data["femur"], data["tibia"],
                               LEG_EXTENSION_LIMIT,
                               Vector((sign * KNEE_HINT[0], KNEE_HINT[1],
                                       KNEE_HINT[2])))
    anim_gait.aim_bone(thigh, knee - hip, hip)
    bpy.context.view_layer.update()

    calf = pose[f"calf.{side}"]
    anim_gait.aim_bone(calf, ankle - knee, calf.matrix.translation.copy())
    bpy.context.view_layer.update()

    foot = pose[f"foot.{side}"]
    error = (foot.matrix.translation - ankle).length
    # O pé continua a canela, menos a dorsiflexão. Ler a direção da canela
    # **depois** da IK, em vez de reconstruí-la, é o que mantém o pé alinhado
    # mesmo nos quadros em que o joelho dobra mais.
    shin = (ankle - knee).normalized()
    foot_dir = anim_gait.rotate_x(shin, track(ANKLE_DORSI, k))
    anim_gait.aim_bone(foot, foot_dir, foot.matrix.translation.copy())
    bpy.context.view_layer.update()

    toe = pose[f"toe.{side}"]
    anim_gait.aim_bone(toe, foot_dir, toe.matrix.translation.copy())
    return error, extension, ankle


def _pose_hand_shape(pose, side: str, loose: float) -> None:
    """Fecha a mão em pá. ``loose`` vai de 0 (na água) a 1 (fora dela)."""
    sign = 1.0 if side == "L" else -1.0
    for name in FINGERS:
        for i, (tight, slack) in enumerate(zip(FINGER_CURL, FINGER_CURL_LOOSE),
                                           start=1):
            bone = pose.get(f"finger_{name}_0{i}.{side}")
            if bone is None:
                continue
            curl = tight + (slack - tight) * loose
            bone.rotation_quaternion = anim_gait.world_rotation(
                bone, [("Y", sign * curl)])
    for i, curl in enumerate(THUMB_CURL, start=1):
        bone = pose.get(f"thumb_0{i}.{side}")
        if bone is not None:
            bone.rotation_quaternion = anim_gait.world_rotation(
                bone, [("Z", -sign * curl)])


# -- resolver a atitude -------------------------------------------------------


def head_shell(obj) -> list[int]:
    """Índices dos vértices que a cabeça manda: crânio, rosto, barba e tricórnio."""
    names = {g.index: g.name for g in obj.vertex_groups}
    out = []
    for vert in obj.data.vertices:
        for group in vert.groups:
            if names[group.group] == "head" and group.weight >= HEAD_SHELL_WEIGHT:
                out.append(vert.index)
                break
    if not out:
        raise RuntimeError("nenhum vértice dominado pelo bone head")
    return out


def _lowest(obj, indices) -> tuple[float, Vector]:
    """Menor Z entre *indices*, na malha **deformada**. Devolve `(z, ponto)`.

    Ler `obj.data.vertices` daria a malha em repouso: o armature é um
    modificador, e a malha do objeto não o enxerga. É o mesmo cuidado do
    `playblast.subject_center`.
    """
    bpy.context.view_layer.update()
    evaluated = obj.evaluated_get(bpy.context.evaluated_depsgraph_get())
    mesh = evaluated.to_mesh()
    try:
        best = min((mesh.vertices[i].co.copy() for i in indices),
                   key=lambda p: p.z)
    finally:
        evaluated.to_mesh_clear()
    return best.z, best


#: Quantas correções de ciclo o solver faz depois da bisseção neutra. Ver
#: `solve_attitude`. Duas bastam: a primeira tira quase todo o déficit e a
#: segunda confirma.
PITCH_PASSES = 2

#: Quantos quadros o solver amostra ao medir a folga ao longo do ciclo.
#:
#: Dez, e não trinta: as três oscilações que baixam a cabeça (`HEAVE`,
#: `PITCH_PULSE` e o rolamento) têm período de meio ciclo, então dez amostras
#: dariam cinco por período, e o vale sairia com milímetros de erro — o bastante
#: para o `verify` (que mede os trinta) devolver 3,29 cm onde o solver prometeu
#: 3,51. Amostrar na mesma grade de quadros da action faz os dois números serem
#: **o mesmo número**, que é o que se quer de uma conferência.
PITCH_SAMPLES = CYCLE_FRAMES


def _pose_body(arm, pitch: float, plan: dict, offset: Vector) -> None:
    """Root, coluna, pescoço e cabeça. Só o que a altura do rosto depende.

    Braços e pernas ficam de fora de propósito: nenhum vértice da cabeça tem peso
    neles, e posá-los custaria dez vezes mais dentro da bisseção.
    """
    pose = arm.pose.bones
    _aim_root(pose["root"], pitch, plan, offset)
    bpy.context.view_layer.update()
    _pose_torso(pose, plan)
    bpy.context.view_layer.update()


def _anchor_offset(arm, pitch: float) -> Vector:
    """Deslocamento que põe a âncora do tronco sobre a origem, na pose neutra."""
    neutral = {"roll": 0.0, "heave": 0.0, "surge": 0.0, "pitch_pulse": 0.0}
    anim_gait.clear_pose(arm)
    _pose_body(arm, pitch, neutral, Vector((0.0, 0.0, 0.0)))
    anchor = arm.pose.bones[ANCHOR_BONE].matrix.translation
    return Vector((0.0, -anchor.y, TRUNK_DEPTH - anchor.z))


def solve_attitude(arm, obj=None) -> dict:
    """Descobre a inclinação de tronco que põe a cabeça fora da água.

    A folga do rosto é **entrada**, não saída. O que se procura é a atitude que a
    produz, e ela se procura medindo: para cada candidato, o corpo é posado, a
    malha é deformada pelo depsgraph e o ponto mais baixo da cabeça é lido. Como
    erguer o tronco só levanta a cabeça, a função é monótona e bisseção resolve.

    Só que a bisseção sozinha resolve o quadro **neutro**, e a folga que vale é a
    do quadro mais apertado do ciclo — a oscilação vertical, o cabeceio da
    braçada e o rolamento tiram, juntos, quase dois centímetros do rosto. A
    primeira versão deste arquivo resolvia para 4,7 cm na pose neutra e o
    `verify` media **-0,02 cm** no quadro 14: o rosto encostava na água.

    Bisseccionar direto sobre o ciclo inteiro custaria trinta poses por
    candidato. Em vez disso, o alvo é **corrigido**: bisecciona-se no neutro,
    mede-se o vale do ciclo, e o déficit vira margem no alvo da bisseção
    seguinte. Como a relação inclinação → folga é quase linear na faixa útil,
    duas passadas fecham. É o mesmo raciocínio do `plan_body_lift` do
    `anim_gait`, que rebaixa a curva inteira até caber sob o quadro mais
    apertado em vez de sob o quadro médio.

    Devolve a inclinação, o deslocamento que põe a âncora sobre a origem, a folga
    medida e se o batente de `PITCH_LIMITS` foi atingido — porque um solver que
    clampa em silêncio entrega um pirata com o rosto na água e nenhum aviso.
    """
    obj = obj or bpy.data.objects[anim_gait.MESH_NAME]
    shell = head_shell(obj)
    neutral = {"roll": 0.0, "heave": 0.0, "surge": 0.0, "pitch_pulse": 0.0}

    def neutral_clearance(pitch: float) -> float:
        anim_gait.clear_pose(arm)
        _pose_body(arm, pitch, neutral, Vector((0.0, 0.0, 0.0)))
        # A âncora ainda não está sobre a origem aqui; a translação que a poria
        # lá entra como correção, o que evita uma segunda pose por candidato.
        anchor = arm.pose.bones[ANCHOR_BONE].matrix.translation.z
        low, _ = _lowest(obj, shell)
        return low - anchor + TRUNK_DEPTH

    def cycle_clearance(pitch: float) -> tuple[float, tuple]:
        offset = _anchor_offset(arm, pitch)
        worst, where = 9.0, None
        for step in range(PITCH_SAMPLES):
            t = step / PITCH_SAMPLES
            anim_gait.clear_pose(arm)
            _pose_body(arm, pitch, body_plan(t), offset)
            low, point = _lowest(obj, shell)
            if low < worst:
                worst, where = low, (round(t, 3),
                                     tuple(round(v, 4) for v in point))
        return worst, where

    def bisect(target: float) -> tuple[float, str]:
        low, high = PITCH_LIMITS
        if neutral_clearance(high) < target:
            return high, "teto"
        if neutral_clearance(low) >= target:
            return low, "piso"
        for _ in range(PITCH_STEPS):
            middle = 0.5 * (low + high)
            if neutral_clearance(middle) < target:
                low = middle
            else:
                high = middle
        return high, ""

    target = WATER_Z + FACE_CLEARANCE
    pitch, clamped = bisect(target)
    worst, where = cycle_clearance(pitch)
    for _ in range(PITCH_PASSES):
        deficit = (WATER_Z + FACE_CLEARANCE) - worst
        if deficit <= 0.0005:
            break
        target += deficit
        pitch, clamped = bisect(target)
        worst, where = cycle_clearance(pitch)

    anim_gait.clear_pose(arm)
    return {
        "pitch": pitch,
        "offset": _anchor_offset(arm, pitch),
        "clearance": worst,
        "lowest_point": where,
        "clamped": clamped,
    }


# -- montagem -----------------------------------------------------------------


def build(arm=None) -> dict:
    """Gera a action `Swim` e devolve as medidas que provam que ela presta."""
    arm = arm or bpy.data.objects[anim_gait.ARMATURE_NAME]
    metrics = anim_gait.rest_metrics(arm)
    arms = anim_climb.arm_metrics(arm)

    scene = bpy.context.scene
    scene.render.fps = FPS
    # Quadro 0: o exportador glTF divide o número do quadro pelo fps, e começar
    # no 1 poria o primeiro keyframe em t = 0,033 s — um quadro parado por volta.
    scene.frame_start = 0
    scene.frame_end = CYCLE_FRAMES

    anim_gait.clear_pose(arm)
    attitude = solve_attitude(arm)
    anim_gait.clear_pose(arm)

    action = anim_climb._new_action(arm, ACTION_NAME)
    pose = arm.pose.bones

    report = {"hand_error": 0.0, "foot_error": 0.0,
              "arm_extension": 0.0, "leg_extension": 0.0}
    sweeps = {"L": [], "R": []}
    #: Quantos quadros cada mão passa **de fato** abaixo da linha d'água. É o
    #: `stance` da caminhada traduzido para a água: a fração do ciclo em que o
    #: membro está empurrando. Contado pelo Z medido da palma, para poder ser
    #: comparado com o `PULL_END` que a trilha promete.
    underwater = {"L": 0, "R": 0}
    ankle_z = []
    anchor_z = []

    for frame in range(0, CYCLE_FRAMES + 1):
        t = (frame % CYCLE_FRAMES) / CYCLE_FRAMES
        scene.frame_set(frame)

        plan = body_plan(t)
        _aim_root(pose["root"], attitude["pitch"], plan, attitude["offset"])
        bpy.context.view_layer.update()
        _pose_torso(pose, plan)
        bpy.context.view_layer.update()
        _pose_clavicles(pose, t)
        bpy.context.view_layer.update()

        anchor_z.append(pose[ANCHOR_BONE].matrix.translation.z)

        for side in ("L", "R"):
            error, extension, ankle = _pose_leg(pose, metrics[side], side, t)
            report["foot_error"] = max(report["foot_error"], error)
            report["leg_extension"] = max(report["leg_extension"], extension)
            ankle_z.append(ankle.z)

        for side in ("L", "R"):
            k = arm_phase(t, side)
            mirror = 1.0 if side == "L" else -1.0
            target = hand_target(t, side)
            hint = track_vector(ELBOW_HINT, k, mirror)
            palm = track_vector(PALM_FACING, k, mirror).normalized()

            error, extension, got = _pose_arm(pose, arms[side], side, target,
                                              hint, palm)
            report["hand_error"] = max(report["hand_error"], error)
            report["arm_extension"] = max(report["arm_extension"], extension)
            # Fora da água a mão relaxa. O critério é o Z medido da palma, não a
            # fase: assim ele continua certo se alguém mexer em `HAND_PATH`.
            _pose_hand_shape(pose, side, 1.0 if got.z > WATER_Z else 0.0)
            if got.z <= WATER_Z:
                sweeps[side].append(got.y)
                underwater[side] += 1

        bpy.context.view_layer.update()
        anim_climb._key_frame(arm, frame)

    anim_gait._linear_curves(action)
    scene.frame_set(0)

    sweep = max(max(v) - min(v) for v in sweeps.values())
    seconds = CYCLE_FRAMES / FPS
    return {
        "action": ACTION_NAME,
        "fps": FPS,
        "frames": CYCLE_FRAMES,
        "cycle_seconds": round(seconds, 3),
        "cycle_distance_m": CYCLE_DISTANCE,
        "native_speed_ms": round(CYCLE_DISTANCE / seconds, 3),
        "arm_strokes_per_min": round(120.0 / seconds, 1),
        "kick_beats_per_cycle": int(2 * KICK_CYCLES),
        # A atitude não foi escolhida: foi resolvida para a folga do rosto.
        "body_pitch_deg": round(attitude["pitch"], 2),
        "pitch_clamped": attitude["clamped"] or "não",
        "face_clearance_cm": round(attitude["clearance"] * 100, 2),
        "lowest_head_point": attitude["lowest_point"],
        "origin_on_body": "linha d'água sobre o esterno (5,0 cm acima da"
                          " cabeça do spine_03, na altura das escápulas)",
        "root_offset_m": tuple(round(v, 4) for v in attitude["offset"]),
        "anchor_depth_cm": round(sum(anchor_z) / len(anchor_z) * 100, 2),
        # A varredura da mão na água é o que justifica `CYCLE_DISTANCE`.
        "hand_sweep_cm": round(sweep * 100, 1),
        "slip_ratio": round(CYCLE_DISTANCE / (2.0 * sweep), 3),
        "recovery_height_cm": round(max(p[2] for _, p in HAND_PATH) * 100, 1),
        # Declarado em `PULL_END` e conferido aqui. Acima de 0,50 há sempre uma
        # mão na água, que é o que sustenta a cabeça erguida.
        "pull_fraction_declared": PULL_END,
        "pull_fraction_measured": round(
            max(underwater.values()) / CYCLE_FRAMES, 3),
        "ankle_travel_cm": round((max(ankle_z) - min(ankle_z)) * 100, 1),
        "roll_deg": ROLL,
        "heave_cm": round(HEAVE * 200, 2),
        # Se a IK não alcançou o alvo, a pose que se vê não é a que está descrita.
        "hand_error_mm": round(report["hand_error"] * 1000, 3),
        "foot_error_mm": round(report["foot_error"] * 1000, 3),
        "arm_extension_max": round(report["arm_extension"], 3),
        "leg_extension_max": round(report["leg_extension"], 3),
    }


def run(arm=None) -> dict:
    """Ponto de entrada: constrói e confere."""
    arm = arm or bpy.data.objects[anim_gait.ARMATURE_NAME]
    return {"build": build(arm), "verify": verify(arm)}


# -- conferência do que ficou gravado -----------------------------------------

#: Como os vértices se dividem para as medições. A chave é o rótulo; o valor são
#: os pedaços de nome de vertex group que caem nele.
#:
#: A divisão não é decorativa: ela é o que permite perguntar "a mão atravessa o
#: tronco?" sem que a resposta seja contaminada pelo ombro, que **encosta** no
#: tronco por construção.
PARTS = {
    "head": ("head",),
    "neck": ("neck",),
    "core": ("spine", "pelvis", "clavicle"),
    "arm": ("upperarm", "lowerarm"),
    "hand": ("hand", "finger", "thumb"),
    "leg": ("thigh", "calf", "foot", "toe"),
}

#: Pares que **não** podem se encontrar, com a folga mínima aceitável em metros.
#:
#: Duas limitações declaradas, e as duas mudam como o número deve ser lido:
#:
#: 1. A medição é de **proximidade entre superfícies**, não de penetração com
#:    sinal: dois pontos a 2 cm podem ser folga honesta ou uma agulha
#:    atravessada. O que ela pega bem é o caso grosseiro — a mão entrando no
#:    peito, o antebraço cruzando a coxa.
#: 2. A classificação é pelo **bone dominante**, e neste personagem há ilhas de
#:    casaco herdadas de bones de membro (é a mesma herança que a escalada
#:    desenterrou, ver o README). Uma gola presa ao `upperarm` conta como
#:    "braço" e mora no esterno — então `arm.L|arm.R` mede, em parte, dois
#:    pedaços de gola vizinhos, e não dois braços.
#:
#: Por isso os pisos abaixo não foram inventados: são **medidos nos clipes que já
#: estão no jogo**. `verify(action="Walk")` devolve `hand|core` a 0,2 cm e
#: `arm|head` a 0,8 cm — quer dizer, o braço da caminhada já raspa a gola nesses
#: valores, e cobrar do nado mais do que se cobra do que está publicado seria
#: régua torta. O piso de cada par é o que a caminhada faz, arredondado para
#: baixo; o que interessa é o nado **não piorar** o que já existe.
COLLISION_PAIRS = (
    ("hand.L", "core", 0.002),
    ("hand.R", "core", 0.002),
    ("hand.L", "head", 0.080),
    ("hand.R", "head", 0.080),
    ("arm.L", "head", 0.008),
    ("arm.R", "head", 0.008),
    ("hand.L", "hand.R", 0.050),
    # Coxa contra coxa a zero **é o certo aqui**: quem nada mantém as pernas
    # juntas, e o ponto que a medição acha é a costura interna da calça, em
    # x = 0, onde os dois vértices são vizinhos na malha por construção. Na
    # caminhada isso dá 2,7 cm só porque as pernas estão abertas.
    ("leg.L", "leg.R", 0.000),
    ("arm.L", "arm.R", 0.010),
    ("hand.L", "leg.L", 0.020),
    ("hand.R", "leg.R", 0.020),
    ("hand.L", "leg.R", 0.060),
    ("hand.R", "leg.L", 0.060),
)


def part_index(obj) -> dict[str, list[int]]:
    """Vértices por parte do corpo, pelo bone que mais manda em cada um.

    Os membros saem separados por lado (`hand.L`, `leg.R`); tronco, pescoço e
    cabeça não têm lado.
    """
    names = {g.index: g.name for g in obj.vertex_groups}
    out: dict[str, list[int]] = {}
    for vert in obj.data.vertices:
        best, group = 0.0, ""
        for entry in vert.groups:
            if entry.weight > best:
                best, group = entry.weight, names[entry.group]
        for label, keys in PARTS.items():
            if any(key in group for key in keys):
                if label in ("head", "neck", "core"):
                    out.setdefault(label, []).append(vert.index)
                elif group.endswith(".L"):
                    out.setdefault(f"{label}.L", []).append(vert.index)
                elif group.endswith(".R"):
                    out.setdefault(f"{label}.R", []).append(vert.index)
                break
    return out


def verify(arm=None, action: str = ACTION_NAME) -> dict:
    """Mede o clipe **relendo a action gravada**, com a malha deformada.

    Existe porque as métricas do `build` já mentiram nesta pasta: elas medem a
    pose no instante em que é construída, e entre construir e gravar há um
    `_key_frame` que só leva os bones que alguém listou. Quando a clavícula ficou
    de fora do `anim_climb`, o `build` reportava contato perfeito e o personagem
    agarrava o ar cinco centímetros ao lado da barra. Aqui a clavícula está em
    uso pesado — é ela que tira o ombro da água — e a armadilha é a mesma.

    O que se mede, e por que cada coisa:

    - **Folga do rosto.** É o contrato. Mínimo do ciclo, não média.
    - **Fração submersa e atitude.** Um nado que "afunda progressivamente" tem
      fração submersa crescendo ao longo do ciclo; e o laço só fecha se o quadro
      0 e o quadro final tiverem a mesma pose (`loop_gap_mm`).
    - **Varredura da mão na água.** É a medida que justifica `CYCLE_DISTANCE`.
    - **Extensão de braço e perna.** Fora da faixa 85-98% a articulação trava e
      a IK aparece.
    - **Proximidade entre membros.** Ver a nota de `COLLISION_PAIRS`.
    - **Taxa angular da cabeça.** Ela é a referência do jogador; chicotear ali é
      náusea, e nenhuma outra métrica pegaria isso.
    """
    from mathutils import kdtree

    arm = arm or bpy.data.objects[anim_gait.ARMATURE_NAME]
    obj = bpy.data.objects[anim_gait.MESH_NAME]
    if bpy.data.actions.get(action) is None:
        return {"error": f"action {action} não existe — rode build() antes"}
    anim_climb._assign_action(arm, action)

    shell = head_shell(obj)
    parts = part_index(obj)
    scene = bpy.context.scene

    face = (9.0, None)
    neck_low = 9.0
    submerged = []
    anchor = []
    pitch_seen = []
    sweeps = {"L": [], "R": []}
    hand_error = 0.0
    arm_ext = 0.0
    leg_ext = 0.0
    worst_pair = {f"{a}|{b}": (9.0, None) for a, b, _ in COLLISION_PAIRS}
    head_dirs = []
    hand_speed = {"water": 0.0, "entry": 9.0}
    loop = {}
    previous_hands = {}

    arms = anim_climb.arm_metrics(arm)
    legs = anim_gait.rest_metrics(arm)

    for frame in range(0, CYCLE_FRAMES + 1):
        t = (frame % CYCLE_FRAMES) / CYCLE_FRAMES
        scene.frame_set(frame)
        bpy.context.view_layer.update()
        depsgraph = bpy.context.evaluated_depsgraph_get()
        evaluated = obj.evaluated_get(depsgraph)
        mesh = evaluated.to_mesh()
        posed = arm.evaluated_get(depsgraph).pose.bones
        try:
            points = [v.co.copy() for v in mesh.vertices]

            # -- o contrato de água ------------------------------------------
            for index in shell:
                if points[index].z < face[0]:
                    face = (points[index].z,
                            (frame, tuple(round(v, 3) for v in points[index])))
            for index in parts.get("neck", ()):
                neck_low = min(neck_low, points[index].z)
            submerged.append(sum(1 for p in points if p.z < WATER_Z) / len(points))
            anchor.append(posed[ANCHOR_BONE].matrix.translation.z)

            # Atitude medida: o ângulo do eixo do tronco com a horizontal. Sai da
            # geometria posada, não da constante — é o jeito de saber que o
            # `solve_attitude` fez o que disse.
            axis = (posed["neck"].matrix.translation
                    - posed["pelvis"].matrix.translation)
            pitch_seen.append(math.degrees(math.asin(
                _clamp(axis.z / max(axis.length, 1e-6)))))

            # -- braços e pernas ---------------------------------------------
            for side in ("L", "R"):
                hand = posed[f"hand.{side}"]
                direction = (hand.matrix.to_3x3()
                             @ Vector((0.0, 1.0, 0.0))).normalized()
                palm = hand.matrix.translation + direction * PALM_REACH
                hand_error = max(hand_error,
                                 (palm - hand_target(t, side)).length)

                shoulder = posed[f"upperarm.{side}"].matrix.translation
                reach = (arms[side]["humerus"] + arms[side]["forearm"]
                         + PALM_REACH)
                arm_ext = max(arm_ext, (palm - shoulder).length / reach)

                hip = posed[f"thigh.{side}"].matrix.translation
                ankle = posed[f"foot.{side}"].matrix.translation
                span = legs[side]["femur"] + legs[side]["tibia"]
                leg_ext = max(leg_ext, (ankle - hip).length / span)

                if palm.z <= WATER_Z:
                    sweeps[side].append(palm.y)
                if side in previous_hands:
                    step = (palm - previous_hands[side]).length * FPS
                    if palm.z <= WATER_Z:
                        hand_speed["water"] = max(hand_speed["water"], step)
                        # A entrada: a mão acabou de furar a superfície.
                        if previous_hands[side].z > WATER_Z:
                            hand_speed["entry"] = min(hand_speed["entry"], step)
                previous_hands[side] = palm.copy()

            head_dirs.append((posed["head"].matrix.to_3x3()
                              @ Vector((0.0, 1.0, 0.0))).normalized())

            # -- membro contra membro ----------------------------------------
            trees = {}
            for label in {b for _, b, _ in COLLISION_PAIRS}:
                indices = parts.get(label, ())
                tree = kdtree.KDTree(len(indices))
                for index in indices:
                    tree.insert(points[index], index)
                tree.balance()
                trees[label] = tree
            for first, second, _ in COLLISION_PAIRS:
                tree = trees[second]
                near = 9.0
                for index in parts.get(first, ()):
                    _, _, dist = tree.find(points[index])
                    near = min(near, dist)
                name = f"{first}|{second}"
                if near < worst_pair[name][0]:
                    worst_pair[name] = (near, frame)

            if frame in (0, CYCLE_FRAMES):
                loop[frame] = points
        finally:
            evaluated.to_mesh_clear()

    scene.frame_set(0)

    gap = max((loop[0][i] - loop[CYCLE_FRAMES][i]).length
              for i in range(len(loop[0])))
    swing = max(head_dirs[0].angle(d) for d in head_dirs)
    rate = max(a.angle(b) for a, b in zip(head_dirs, head_dirs[1:]))
    # Uma action que não seja esta pode nunca pôr a mão na água — e este `verify`
    # é chamado assim de propósito, com `action="Idle"`, para medir a **linha de
    # base** de proximidade entre membros (ver a nota de `COLLISION_PAIRS`).
    sweep = max((max(v) - min(v) for v in sweeps.values() if v), default=0.0)

    breaches = {}
    for first, second, floor in COLLISION_PAIRS:
        near, at = worst_pair[f"{first}|{second}"]
        if near < floor:
            breaches[f"{first}|{second}"] = (round(near * 100, 2), at)

    return {
        "action": action,
        # -- o contrato de água -------------------------------------------
        "face_clearance_cm": round(face[0] * 100, 2),
        "face_worst": face[1],
        "neck_lowest_cm": round(neck_low * 100, 2),
        "submerged_min_pct": round(min(submerged) * 100, 1),
        "submerged_max_pct": round(max(submerged) * 100, 1),
        # Se o corpo afundasse ao longo do ciclo, esta faixa seria larga e o
        # `loop_gap_mm` não fecharia.
        "anchor_depth_range_cm": round((max(anchor) - min(anchor)) * 100, 2),
        "body_pitch_measured_deg": (round(min(pitch_seen), 2),
                                    round(max(pitch_seen), 2)),
        "loop_gap_mm": round(gap * 1000, 3),
        # -- a braçada ----------------------------------------------------
        "hand_sweep_cm": round(sweep * 100, 1),
        "slip_ratio": round(CYCLE_DISTANCE / (2.0 * sweep), 3) if sweep else None,
        "hand_speed_pull_ms": round(hand_speed["water"], 2),
        "hand_speed_entry_ms": round(hand_speed["entry"], 2),
        "hand_error_mm": round(hand_error * 1000, 3),
        "arm_extension_max": round(arm_ext, 3),
        "leg_extension_max": round(leg_ext, 3),
        # -- a cabeça -----------------------------------------------------
        "head_swing_deg": round(math.degrees(swing), 2),
        "head_rate_deg_s": round(math.degrees(rate) * FPS, 1),
        # -- membro contra membro -----------------------------------------
        "closest_pairs_cm": {f"{a}|{b}": round(worst_pair[f'{a}|{b}'][0] * 100, 2)
                             for a, b, _ in COLLISION_PAIRS},
        "breaches_cm": breaches or "nenhuma",
    }


# -- preview ------------------------------------------------------------------

#: Prefixo do andaime. Dois underscores, como o do `anim_carry`: um só é o que o
#: `export.py` usa para reconhecer **action** de andaime, e um objeto com aquele
#: prefixo passaria despercebido por aquela varredura.
PREVIEW_PREFIX = "__SwimPreview"

#: A superfície do preview é uma **grade de barras finas**, não um plano.
#:
#: Um plano opaco em z = 0 esconderia metade do pirata, que é justamente a
#: metade que este clipe precisa provar. Um plano translúcido dependeria de o
#: Workbench honrar alpha, o que muda entre modos de sombreamento — e este
#: preview roda sem GUI, onde não há como conferir de relance. Uma grade resolve
#: os dois: ela ocupa 5% da imagem, marca a linha d'água nas três vistas
#: (inclusive na de cima, onde um plano visto de topo seria uma parede) e
#: funciona em qualquer motor.
#:
#: A barra tem altura, e não é enfeite: um plano de espessura zero visto de lado
#: some. Um centímetro dá três pixels na régua deste playblast — o bastante para
#: a linha d'água existir na vista lateral, que é a que decide se o rosto está
#: fora da água.
WATER_SPACING = 0.25
WATER_BAR = 0.008
WATER_RISE = 0.010
WATER_SPAN_X = (-1.15, 1.15)
WATER_SPAN_Y = (-1.45, 2.05)


def _box(verts, faces, low: Vector, high: Vector) -> None:
    """Uma caixa alinhada aos eixos, acrescentada às listas dadas."""
    base = len(verts)
    for i in range(8):
        verts.append(Vector((high.x if i & 1 else low.x,
                             high.y if i & 2 else low.y,
                             high.z if i & 4 else low.z)))
    for quad in ((0, 1, 3, 2), (4, 6, 7, 5), (0, 4, 5, 1),
                 (2, 3, 7, 6), (0, 2, 6, 4), (1, 5, 7, 3)):
        faces.append(tuple(base + i for i in quad))


def _temp_water():
    """A superfície da água, só para o preview. Devolve o que tem de ser apagado.

    Não é cenário: é **régua**, como a escada do `anim_climb._temp_ladder`. Um
    ciclo de nado julgado com o personagem no vazio não prova nada — sem a linha
    d'água no lugar exato onde o contrato diz que ela está, não há como ver se o
    rosto está fora ou dentro.
    """
    verts, faces = [], []
    half = WATER_BAR * 0.5
    x0, x1 = WATER_SPAN_X
    y0, y1 = WATER_SPAN_Y

    steps = int(round((y1 - y0) / WATER_SPACING))
    for i in range(steps + 1):
        y = y0 + i * (y1 - y0) / steps
        _box(verts, faces, Vector((x0, y - half, WATER_Z - WATER_RISE)),
             Vector((x1, y + half, WATER_Z)))
    steps = int(round((x1 - x0) / WATER_SPACING))
    for i in range(steps + 1):
        x = x0 + i * (x1 - x0) / steps
        _box(verts, faces, Vector((x - half, y0, WATER_Z - WATER_RISE)),
             Vector((x + half, y1, WATER_Z)))

    mesh = bpy.data.meshes.new(PREVIEW_PREFIX + "Mesh")
    mesh.from_pydata([tuple(v) for v in verts], [], faces)
    mesh.update()

    material = bpy.data.materials.new(PREVIEW_PREFIX + "Mat")
    material.use_nodes = True
    bsdf = material.node_tree.nodes["Principled BSDF"]
    bsdf.inputs["Base Color"].default_value = (0.06, 0.34, 0.42, 1.0)
    bsdf.inputs["Roughness"].default_value = 0.35
    # O Workbench em modo TEXTURE cai na cor de viewport do material para quem
    # não tem imagem — é ela que faz a grade sair verde-água em vez de cinza.
    material.diffuse_color = (0.06, 0.34, 0.42, 1.0)
    mesh.materials.append(material)

    obj = bpy.data.objects.new(PREVIEW_PREFIX + "Water", mesh)
    bpy.context.scene.collection.objects.link(obj)
    return obj, mesh, material


def _purge() -> int:
    """Apaga o andaime. Idempotente e seguro de chamar sempre."""
    gone = 0
    for obj in [o for o in bpy.data.objects if o.name.startswith(PREVIEW_PREFIX)]:
        bpy.data.objects.remove(obj, do_unlink=True)
        gone += 1
    for mesh in [m for m in bpy.data.meshes if m.name.startswith(PREVIEW_PREFIX)]:
        bpy.data.meshes.remove(mesh)
    for mat in [m for m in bpy.data.materials if m.name.startswith(PREVIEW_PREFIX)]:
        bpy.data.materials.remove(mat)
    return gone


#: Enquadramento por vista: `(centro, escala ortográfica, largura, altura)`.
#:
#: Corpo deitado pede enquadramento deitado, e o padrão retrato do `playblast`
#: (480×640) cortaria o pirata pela cintura. Os números saem da **caixa medida**
#: da malha deformada ao longo do ciclo, não do olho:
#:
#: | eixo | de | até | vão |
#: |---|---|---|---|
#: | X | -0,467 | +0,467 | 0,93 m |
#: | Y | -0,807 | +1,292 | 2,10 m |
#: | Z | -0,755 | +0,566 | 1,32 m |
#:
#: O centro em y = +0,24 é o centro do **corpo**, e não a origem. A origem cai no
#: esterno, e o esterno não fica no meio de um nadador: sobra mais gente atrás
#: dele do que à frente.
#:
#: A vista de cima é a única em que a braçada aparece inteira — a lateral esconde
#: a varredura em S e a de três quartos mostra metade dela. E ela é **paisagem**,
#: não retrato: a câmera do `playblast` usa +Y como topo da imagem, então vista
#: de cima o eixo longo do corpo cai na horizontal. A primeira versão deste
#: dicionário supôs o contrário e cortou o pirata nas duas pontas.
FRAMING = {
    "side": ((0.0, 0.24, -0.10), 2.30, 800, 520),
    "quarter": ((0.0, 0.24, -0.10), 2.45, 780, 600),
    "top": ((0.0, 0.24, -0.10), 2.30, 840, 400),
}

#: Quantos ciclos os vídeos mostram. Três: com dois, o olho ainda não separa o
#: laço do gesto; com quatro, o arquivo dobra sem mostrar nada novo.
PREVIEW_CYCLES = 3


def preview(cycles: int = PREVIEW_CYCLES, views=("side", "quarter", "top"),
            sheets=("side", "top")) -> dict:
    """Grava os MP4 e as folhas de contato em `preview/`.

    O andaime da água é montado antes e removido no `finally`, como o da escada:
    um preview que deixa lixo na cena contamina o próximo `export.py`.
    """
    import playblast

    arm = bpy.data.objects[anim_gait.ARMATURE_NAME]
    if bpy.data.actions.get(ACTION_NAME) is None:
        raise RuntimeError(f"action {ACTION_NAME} não existe — rode build() antes")
    anim_climb._assign_action(arm, ACTION_NAME)

    _purge()
    water, mesh, material = _temp_water()
    out = {}
    try:
        frames = [f % CYCLE_FRAMES for f in range(cycles * CYCLE_FRAMES)]
        for view in views:
            center, ortho, width, height = FRAMING[view]
            out[view] = playblast.clip("swim", frames, view=view, center=center,
                                       ortho=ortho, width=width, height=height,
                                       shading="TEXTURE")
        for view in sheets:
            center, ortho, width, height = FRAMING[view]
            # Dez quadros de um ciclo, um a cada três: é a resolução em que uma
            # braçada de trinta quadros ainda mostra entrada, apanhada,
            # varredura, empurrão, saída e recuperação em poses distintas.
            out[f"{view}_sheet"] = playblast.sheet(
                "swim", range(0, CYCLE_FRAMES, 3), view=view, columns=5,
                center=center, ortho=ortho, width=width // 2, height=height // 2,
                shading="TEXTURE")
    finally:
        bpy.data.objects.remove(water, do_unlink=True)
        bpy.data.meshes.remove(mesh)
        bpy.data.materials.remove(material)
        bpy.context.scene.frame_set(0)
    return out
