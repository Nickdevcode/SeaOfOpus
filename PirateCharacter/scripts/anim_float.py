"""Float: o pirata boiando na superfície, parado, esperando.

É o `Idle` da água — o que o jogador vê ao cair no mar e não apertar nada. E a
diferença com o `Idle` do convés não é de grau, é de natureza: lá o clipe **crava
os dois pés no chão** por IK e todo o resto se pendura nesse contato; aqui não
existe um único ponto preso. Nada segura ninguém, o corpo está mergulhado numa
coisa que empurra de volta, e é justamente por não haver contato que o movimento
tem de carregar **resistência de fluido** — nenhuma partida seca, nenhuma parada
seca, tudo entrando e saindo amortecido. Perna imóvel na água lê como manequim
flutuando; é a pernada devagar que diz que o sujeito está se sustentando.

## O contrato de água

Nos clipes de terra `z = 0` é o chão, sob os pés. Aqui **`z = 0` é a linha
d'água**, e o corpo fica repartido nela: pernas e quadril abaixo, ombros e cabeça
acima. O corpo é posicionado pelo osso `root` (translação e rotação de pose), e
não movendo o objeto — mover o objeto some do GLB e some da action.

Três consequências que valem escrever:

1. **A cabeça inteira fica acima de `z = 0`, com folga.** O jogo não deixa
   mergulhar, então o queixo nunca pode raspar a superfície. `verify()` mede a
   folga do ponto mais baixo do queixo/barba e o menor valor do ciclo é a
   garantia.
2. **O clipe não anima a subida e a descida pela onda.** Quem ergue o avatar pela
   altura da onda é o runtime; repetir isso aqui daria dois balanços somados, e o
   personagem passaria a saltar sobre a crista. O que sobra de vertical é
   micro-oscilação — respiração e o empurrão da pernada —, medida e mantida
   abaixo de 3 cm.
3. **O afundamento é escolhido acima do equilíbrio físico, de propósito.** Um
   corpo humano boiando parado tem a água no queixo; este fica com a água na
   altura do peito e os ombros de fora. Não é descuido: o runtime só conhece a
   altura da onda aproximadamente, e o custo de errar para baixo é a cabeça
   entrando na água — que é a única coisa que o jogo promete que não acontece. A
   pose de quem trabalha para se manter alto (pernada de polo aquático) também é
   muito mais legível de longe do que uma cabeça solta no meio da espuma.

## O que sustenta o corpo

A pernada é um **eggbeater**: cada perna varre um **cone** em torno de um eixo que
pende do quadril, e as duas varrem em **sentidos opostos**. É a pernada que gente
de verdade usa para se manter parada na água, e o nome vem justamente da oposição
— duas batedeiras girando ao contrário uma da outra, com o torque de uma anulando
o da outra, que é o que mantém o corpo de frente em vez de rodando devagar.

A primeira versão deste clipe descrevia a perna como uma **elipse no plano
sagital** — pedalar devagar —, e elipse sagital sempre vai ler como pedalar
*sentado*: a folha de contato lateral entregava um pirata numa cadeira invisível,
coxa quase na horizontal e joelho a 90°. Não era falta de amplitude, era o plano
errado. Ver `LEG_CONE_R` e seguintes para o que mudou, e `RECLINE` para o erro de
sinal que fez a versão anterior tentar consertar isso pelo lado avesso.

O tornozelo fica a distância **quase constante** do quadril ao longo do cone, e
essa é a metade do conserto que não é óbvia: com a distância fixa o joelho não
fecha, e joelho a 90° com coxa horizontal é literalmente a pose de sentar. O
joelho continua saindo de IK de dois elos, como em toda perna desta pasta — o que
mudou foi para onde o palpite manda o joelho apontar: **para fora**, e não para a
frente.

Os braços fazem **sculling**: varrem a água de lado num oito deitado (a
lemniscata `x = sen t`, `y = sen 2t`), com a palma virada **contra o próprio
movimento** e inclinada para baixo. Essa regra da palma não é decoração, é o que
sculling *é*: a mão vira remo, e a componente para baixo da força é o que segura
o corpo. E ela sai da trajetória por diferença finita, então continua certa se
alguém mexer no oito.

## Períodos que não fecham juntos

Como no `anim_idle`, o inimigo é o olho pegar a emenda do laço. A defesa aqui é
aritmética: em 210 quadros cabem **3** pernadas, **5** varreduras de braço e
**2** respirações, e 3, 5 e 2 são primos entre si dois a dois — a combinação das
três só se repete depois do ciclo inteiro, 7 segundos.

> Vale registrar que o `anim_idle` promete isso no comentário e não entrega: lá
> `WEIGHT_SHIFT_CYCLES` é `1/3` e o `build` multiplica por `3.0` de volta, então
> respiração e balanço de peso fecham no mesmo período. Não é problema deste
> arquivo — mas é o defeito que este arquivo tomou cuidado de não copiar.

## O que este clipe não faz

Não nada, não vira, não afunda e não sai do lugar: quem manda na posição e no
rumo é o runtime. Não há transição para o `Swim` aqui dentro — os dois clipes
compartilham só a linha d'água em `z = 0`, e é de propósito que compartilhem
apenas isso.

Convenções do rig, como no resto da pasta: o personagem olha para **-Y**,
1 unidade = 1 metro, e `("X", positivo)` num `world_rotation` joga o topo do osso
para -Y (para a frente).
"""

from __future__ import annotations

import math

import bpy
from mathutils import Matrix, Vector
from mathutils.kdtree import KDTree

import anim_gait

ACTION_NAME = "Float"

FPS = 30

#: 210 quadros = 7,0 s. Longo para um clipe de jogo, e é o ponto: é o menor
#: número que fecha 3 pernadas, 5 varreduras e 2 respirações ao mesmo tempo
#: (210 = 2·3·5·7). Encurtar para 6 s obrigaria a pôr dois osciladores em razão
#: inteira, e é exatamente aí que o laço se denuncia.
CYCLE_FRAMES = 210

#: Ciclos de cada oscilador dentro do laço. Primos entre si dois a dois — é a
#: única coisa que importa nesses três números, e por isso eles estão juntos.
KICK_CYCLES = 3                 # 2,333 s por pernada
SCULL_CYCLES = 5                # 1,400 s por varredura
BREATH_CYCLES = 2               # 3,500 s por respiração = 17,1 por minuto
#: A cabeça varre o horizonte uma vez por laço, com uma harmônica em cima para o
#: passeio não sair de metrônomo.
SCAN_CYCLES = 1
SCAN_HARMONIC = 4


# -- o corpo na água ----------------------------------------------------------

#: Quanto o corpo afunda em relação ao clipe de terra: a origem do rig (o plano
#: dos pés) desce isto abaixo da linha d'água.
#:
#: 1,32 m é medido, não escolhido: é o valor que deixa a água cortando o peito, os
#: ombros 10,1 cm de fora e o ponto mais baixo do rosto **10,4 cm** acima da
#: superfície no pior quadro do ciclo. Subir o número afoga a cabeça; baixar
#: transforma o boiar em "de pé no raso".
#:
#: O ponto mais baixo do rosto é a **barba**, e não a boca: ela desce 7,5 cm abaixo
#: da base do crânio e chega ao nível da própria articulação do ombro. É ela que
#: manda no afundamento deste personagem, e é por isso que a folga medida (10,6 cm)
#: parece pequena para uma cabeça que está com a base do crânio a 19 cm da água.
BODY_SINK = 1.32

#: Altura, no rig em repouso, do ponto em torno do qual o corpo se inclina.
#:
#: Não é o quadril, e essa é a parte pouco óbvia: na água o corpo gira em torno
#: do **centro de flutuação**, que fica no peito, porque o pulmão é o flutuador.
#: Com o pivô no quadril (0,90), reclinar joga a cabeça para trás e para baixo — o
#: contrário do que se vê em qualquer pessoa boiando, que reclina *afundando os
#: pés* e mantendo o rosto no lugar.
PIVOT_Z = 1.18

#: Quanto o corpo recosta, em graus. Positivo é para trás.
#:
#: Boiar é quase vertical e um pouco recostado: a reclinação é o que faz a água
#: cortar o peito em vez do pescoço, e ainda levanta o queixo (que está à frente do
#: pivô, então reclinar o ergue).
#:
#: > [!warning] O sinal estava trocado, e custou o clipe inteiro
#: > A versão anterior subiu este número de 18° para 22° com a justificativa de que
#: > "a perna é descrita no referencial do corpo, então cada grau de reclinação
#: > **tira** um grau da inclinação da coxa no mundo". É o contrário. Reclinar gira
#: > o referencial do corpo para trás, e um vetor que apontava para baixo passa a
#: > apontar para baixo **e para a frente**: cada grau de reclinação *soma* um grau
#: > à inclinação da coxa no mundo. Uma linha de conferência resolve —
#: > `Matrix.Rotation(radians(-22), 4, "X") @ Vector((0,0,-1))` dá 22° à frente.
#: >
#: > Medida na action gravada, a coxa da versão de 22° saía a **71° à frente da
#: > vertical do mundo** (89° no pior quadro, ou seja, horizontal), e não a 26°. A
#: > tentativa de consertar a cadeira reclinando mais tinha piorado a cadeira em
#: > exatamente 4°.
#:
#: 15° é o novo número, e ele é um orçamento repartido em três: abaixo de ~10° o
#: corpo lê como "de pé no raso" e a água sobe no pescoço; acima de ~20° cada grau
#: é um grau a mais de coxa à frente no mundo, que é a moeda mais cara deste clipe;
#: e passando de ~28° vira boia de costas, que seria outro clipe.
#:
#: Os 7° devolvidos valem 7° de coxa e **não custaram folga de queixo nenhuma**:
#: custaram folga negativa, porque a cabeça está *acima* do pivô e reclinar a
#: abaixa. Medido, a folga da barba subiu de 10,38 cm para 11,83 cm com a mesma
#: `BODY_SINK`. O segundo erro do parágrafo de cima era esse: os 22° estavam
#: cobrando duas vezes — a coxa à frente e o queixo mais baixo — e sendo creditados
#: pelos dois.
RECLINE = 15.0

#: Meia amplitude da subida do corpo pela respiração e pela varredura da pernada
#: (`kick_lift`, que pulsa **duas vezes por pernada** — uma por perna).
#:
#: Os dois somados dão 2,5 cm de excursão medida — dentro do teto de 3 cm do
#: contrato de água, e por pouco de propósito: é o máximo que dá para ter sem
#: começar a competir com a onda que o runtime já aplica.
BREATH_HEAVE = 0.009
KICK_HEAVE = 0.005
#: Vaivém horizontal que sobra da pernada. Um centímetro: o suficiente para o
#: tronco não parecer pregado no ar, longe do bastante para não brigar com a
#: velocidade que o runtime dá ao personagem.
KICK_SURGE = 0.010
#: Rolamento para o lado da perna que está empurrando, e guinada no ritmo dos
#: braços, em graus. Pequenos porque o corpo inteiro está acima do pivô: 3° já
#: mexem o chapéu 3 cm.
KICK_ROLL = 2.2
SCULL_YAW = 2.0


# -- pernada: o eggbeater -----------------------------------------------------

#: Raio do cone: distância do quadril ao tornozelo, em metros, e o quanto ela
#: respira ao longo do laço.
#:
#: **É o número que mata a cadeira**, e não a amplitude. Descrever a perna por um
#: raio quase constante em vez de por uma elipse é o que impede o joelho de fechar:
#: com 0,680 m (86% da perna, que mede 0,788 m do quadril ao tornozelo) o joelho
#: fica em **117°** de média, e os ±0,048 de respiro o levam de 105° (recolhendo) a 134°
#: (empurrando). A elipse anterior variava a distância de 0,47 a 0,73 m e por isso
#: passava por **72° de joelho** — que, com a coxa na horizontal, é a pose de
#: sentar desenhada com precisão de engenharia.
#:
#: O respiro é pequeno perto daquilo de propósito: o que tem de mudar ao longo do
#: laço é a **direção** da perna, não o comprimento dela. Perna que estica e encolhe
#: muito lê como pedalar; perna que gira lê como batedeira. O que ele compra é a
#: dobra do joelho aparecer na vista lateral, onde a varredura lateral não aparece.
LEG_CONE_R = 0.680
LEG_CONE_R_SWING = 0.048

#: O eixo do cone, em graus, no **referencial do corpo**: para onde a perna pende
#: quando está no meio da varredura.
#:
#: `OUT` é abdução (para fora, no plano frontal) e `FWD` é flexão (para a frente,
#: no plano sagital). Os dois são medidos contra a vertical do corpo, e é o `FWD`
#: que precisa de atenção: **a reclinação soma nele quando se olha o mundo** (ver
#: `RECLINE`). Com `FWD` = 6° e reclinação de 15°, o eixo pende a 21° à frente da
#: vertical do **mundo** — e a coxa, que o palpite do joelho abre um pouco mais para
#: a frente, fica em 30° medidos (era 71°). Essa é a régua que vale, porque é a que
#: o olho lê na vista lateral: `verify()` a devolve em `thigh_pitch_deg`.
#:
#: `OUT` em 22° é o que tira a perna do plano sagital, e é a outra metade do
#: conserto: com o joelho aberto para fora, a projeção da coxa na vista lateral
#: encurta e o que sobra é uma perna caindo, em vez de uma coxa apontando para a
#: frente do quadro. Começou em 27° e desceu: a **coxa** abre bem mais que o eixo
#: (o joelho se afasta ainda mais da linha quadril-tornozelo, ver `KNEE_LEAD`), e a
#: 27° a medição achou **76° de abdução de coxa** no pior quadro — perna quase na
#: horizontal, espacate e não pernada. A 22° ela para em 65°, com 48° de média, que
#: é a faixa em que um eggbeater de verdade trabalha.
LEG_CONE_OUT = 22.0
LEG_CONE_FWD = 6.0
#: Meia-abertura do cone, em graus, e ela é **achatada**: o quanto a perna se
#: afasta do eixo abrindo (`OUT`) e o quanto se afasta avançando (`FWD`).
#:
#: Um cone redondo (as duas iguais) foi a primeira tentativa e saiu marchando: com
#: 23° nos dois eixos os dois tornozelos se afastavam **1,00 m** um do outro no
#: vaivém, e a vista lateral entregava um sujeito andando debaixo d'água. Eggbeater
#: de verdade é muito mais largo que fundo — a varredura que sustenta é a
#: **lateral**, com a sola inclinada empurrando água para baixo enquanto vai e
#: enquanto volta, e o vaivém é só o que costura uma varredura na outra. Daí 20°
#: para fora contra 16° para a frente, que derruba o afastamento para 0,68 m sem
#: tocar no gesto que faz a sustentação.
#:
#: 13° foi longe demais para o outro lado: a vista lateral ficou parada, com os
#: dois pés quase no mesmo lugar o laço inteiro. A vista de frente é onde o
#: eggbeater se prova, mas é a **lateral** que o Nicolas abre primeiro, e um clipe
#: que só funciona numa vista não funciona.
LEG_SWEEP_OUT = 20.0
LEG_SWEEP_FWD = 16.0

#: Assimetria de tempo do laço da perna. **Positivo** faz a fase correr mais
#: rápido pelo ponto mais aberto do cone (φ = 0, onde o pé chicoteia por fora) e
#: mais devagar pelo mais fechado (φ = π, onde ele se recolhe sob o corpo) — que é
#: como um membro trabalha na água: empuxo vai com o quadrado da velocidade, então
#: o trecho propulsivo é o rápido e a volta é lenta e escorregadia.
#:
#: Era negativo na versão da elipse, e continua querendo dizer a mesma coisa: o
#: sinal acompanhou a mudança de onde fica o empurrão dentro do laço.
#:
#: A reescrita de fase é `p + k·sen(2πp)/2π`: monótona para |k| < 1, com derivada
#: contínua e periódica. Trocar isso por dois trechos de velocidade diferente
#: colados daria o estalo que este clipe inteiro existe para não ter.
KICK_DRAG = 0.22

#: Inclinação do pé, em graus, nos dois extremos do laço.
#:
#: Um valor só, dois comportamentos: no empurrão (por fora) a sola vira para baixo
#: (dorsiflexão, ângulo negativo) porque é ela que joga água para baixo; na
#: recuperação (recolhido) a ponta cai e o pé fatia a água em vez de arrastá-la. Pé
#: rígido é o segundo erro mais visível de uma animação de água, depois de perna
#: parada. Subiu de 15° para 20° quando a pernada saiu do plano sagital: com a
#: perna varrendo de lado, a **sola** é a única parte do gesto que a vista lateral
#: ainda mostra de frente, e 15° não davam para vê-la trabalhar.
FOOT_PITCH_PUSH = 20.0
#: Quanto a ponta do pé aponta para fora, em graus. Constante.
#:
#: É a assinatura do eggbeater e não é enfeite: com a perna varrendo um cone
#: aberto 22° para fora, um pé apontado para a frente ficaria **torcido em relação
#: à própria canela** e a sola varreria a água de lado, de faca. O número segue o
#: eixo do cone de perto por isso — a sola fica quadrada com a varredura, que é a
#: única posição em que ela empurra alguma coisa. Mesmo argumento da palma no
#: sculling (`_aim_palm`), aplicado ao outro par de membros.
FOOT_TOE_OUT = 24.0

#: Para onde o joelho aponta, no referencial do corpo, e como isso acompanha a
#: varredura. A componente lateral é fixa em 1 e estes são medidos contra ela.
#:
#: É a constante que decide sozinha se o clipe lê como cadeira. `solve_leg` deixa o
#: joelho livre num círculo e usa o palpite para escolher o ponto: palpite
#: dominado pela **frente** joga o joelho à frente do quadril e desenha um sujeito
#: sentado; palpite dominado pelo **lado** abre o joelho como sapo, e a mesma perna,
#: com o mesmo tornozelo, passa a ler como alguém se sustentando.
#:
#: A versão anterior usava `(0,55, -0,83, 0)` — razão de 1,5 **a favor da frente** —
#: e media 71° de coxa à frente da vertical do mundo. Aqui a razão inverte para
#: 0,26 contra 1,0, e o que sobra de frente balança com a varredura (`SWING`), para
#: o joelho circular junto com o pé em vez de ficar pendurado num canto enquanto só
#: a canela gira. Zerar a componente lateral seria pior que qualquer uma das duas:
#: a IK escolheria o plano no acaso e as duas canelas se cruzariam no meio do ciclo.
KNEE_LEAD = 0.26
KNEE_LEAD_SWING = 0.20


# -- sculling -----------------------------------------------------------------

#: O oito da mão, em relação ao ombro e no referencial do corpo: para fora
#: (`OUT`), para a frente (`FWD`) e para baixo (`DOWN`), com as amplitudes que
#: fazem o traçado ser uma lemniscata deitada em vez de um arco varrido ida e
#: volta.
#:
#: A varredura lateral e o vaivém correm em razão **1:2** — é isso e só isso que
#: transforma o arco em oito. Com os dois na mesma frequência, a mão vai e volta
#: pela mesma linha, e sculling que refaz o próprio caminho não produz força
#: nenhuma: cada meia varredura desfaria a anterior.
#: Os três raios saíram medidos, e as duas primeiras tentativas erraram nos dois
#: lugares em que este oito pode errar:
#:
#: - **Extensão.** Com `OUT` em 0,255 e `FWD` em 0,250 a medição achou **95,3%**
#:   de braço esticado. Não é travamento, mas é cotovelo quase reto, e ninguém
#:   sculla de braço reto: a força vem do antebraço girando sob um cotovelo
#:   dobrado. O erro foi conferir os extremos isolados (88,8% no mais aberto) e
#:   esquecer que o oito passa por **aberto e à frente ao mesmo tempo**, onde os
#:   dois raios se somam na diagonal.
#: - **Profundidade.** Com `DOWN` em 0,290 o punho chegava a **3,9 cm** da
#:   superfície, e a mão inteira furava a água num clipe que não tem respingo
#:   nenhum para justificar isso. Reclinar o corpo também levanta a mão, porque o
#:   alvo é à frente do ombro e a reclinação transforma "à frente" em "acima" — foi
#:   por isso que `DOWN` teve de ir a 0,355 quando a reclinação subiu para 22°.
#:   Quando a reclinação voltou a 15° (ver `RECLINE`), este número teve de voltar
#:   junto, e pela mesma conta ao contrário: `fwd·sen(θ) - down·cos(θ)` mantido
#:   constante entre as duas reclinações dá **0,316**. Medido no fim: a mão passeia
#:   entre 3,7 e 24,6 cm de profundidade, e o ponto mais alto dela é um dedo, não o
#:   punho.
#: O ponto mais fechado da varredura também foi medido, e por pouco: com `OUT` em
#: 0,240 a mão passava a **2,2 cm** do casaco — e 2,2 cm medidos até o *vértice*
#: mais próximo de uma malha com 4 cm de aresta é mão raspando a barriga. Abrir a
#: mediana e encolher a amplitude na mesma medida afasta o ponto interno sem mexer
#: muito no externo, que é quem manda na extensão do braço — a folga final ficou em
#: 4,5 cm com o braço parando em 94,1% de extensão.
SCULL_OUT = 0.270
SCULL_OUT_HALF = 0.110
SCULL_FWD = 0.205
#: O vaivém corre no **dobro** da frequência da varredura, então ele contribui o
#: dobro para o caminho que a mão percorre — e foi ele que fez a primeira medição
#: dar 1,14 m/s de pico na mão, rápido demais para um sujeito que está só
#: esperando. Encolher de 0,10 para 0,075 tira 20% da velocidade sem desfazer o
#: oito.
SCULL_FWD_HALF = 0.075
#: A mão afunda um pouco no meio da varredura, onde ela está mais rápida, e sobe
#: nas inversões. 2 cm: é o ângulo de ataque da palma que faz isso, não um gesto.
SCULL_DOWN = 0.316
SCULL_DOWN_HALF = 0.020

#: Defasagem dos braços entre si e em relação às pernas.
#:
#: Sculling de sustentação é quase simétrico, e simetria perfeita é o que faz um
#: personagem parecer brinquedo: 0,09 de ciclo (4 quadros) entre um braço e o
#: outro é invisível como gesto e resolve isso. O deslocamento contra a pernada
#: existe para os dois pares não largarem juntos do quadro 0 — e como 3 e 5 são
#: primos entre si, eles já não se reencontram dentro do laço.
SCULL_SPLIT = 0.09
SCULL_OFFSET = 0.37

#: Quanto a palma se vira **contra o movimento** em vez de simplesmente para
#: baixo. 0 deixa a mão de barriga para baixo como uma prancha arrastada de lado
#: (não empurra nada); 1 põe a palma inteira de frente para o deslocamento e a
#: mão vira freio, com o cotovelo torcendo atrás dela. 0,75 é remo.
PALM_AGAINST = 0.75
#: Quebra do punho na direção da palma, como tangente do ângulo. A mão continua o
#: antebraço, mas não em linha reta: quem faz força na água quebra o punho um
#: pouco para o lado que empurra.
WRIST_FLEX = 0.22

#: Para onde o cotovelo aponta: para fora, para trás e principalmente para baixo.
#: Sem a componente para baixo, a IK resolve o braço com o cotovelo apontando
#: para cima e o pirata passa o clipe inteiro com as duas asas abertas.
ELBOW_HINT = (0.45, 0.62, -0.65)

#: Fecho constante dos dedos, em graus por falange. A mão em repouso deste rig
#: tem os dedos abertos e retos, e debaixo d'água isso lê como mão espalmada de
#: susto. Uma concha de leve — bem menos que os 42/48 da pegada da escada — é o
#: que faz a mão ler como remo.
FINGER_CURL = (14.0, 12.0)
THUMB_CURL = (18.0, 14.0)
FINGERS = ("index", "middle", "ring", "pinky")


# -- tronco, cabeça e limites -------------------------------------------------

#: Quanto o peito abre na inspiração e quanto o ombro sobe com ele, em graus.
#: Menor que no `Idle`: metade do tórax está dentro da água, e água não deixa a
#: caixa expandir como o ar deixa.
CHEST_EXPAND = 1.2
SHOULDER_RISE = 0.9

#: Quanto a coluna desfaz a reclinação para a cara ficar de frente para o mar, em
#: graus, e como isso se reparte entre pescoço e cabeça.
#:
#: A soma (7°) é menor que a reclinação (15°) de propósito: os 8° que sobram
#: deixam o queixo apontando um pouco para cima, que é o que qualquer pessoa faz
#: com a água na altura do peito — e é o que dá a folga extra do queixo à
#: superfície. Cada grau a mais aqui custa meio milímetro de folga da barba, que
#: é a coisa mais cara deste clipe.
#:
#: Os dois números caíram junto com `RECLINE` (eram 8° e 6° para 22° de
#: reclinação), e é o **resto** que tinha de ser preservado, não a soma: são os 8°
#: sobrando que decidem para onde o rosto aponta. Manter os 14° antigos sobre uma
#: reclinação de 15° teria virado o queixo para baixo, na direção da água.
NECK_LEVEL = 4.0
HEAD_LEVEL = 3.0
#: Amplitude do passeio da cabeça pelo horizonte, em graus, e da harmônica.
HEAD_SCAN = 9.0
HEAD_SCAN_FINE = 3.5
#: Queda do quadril para o lado da perna que empurra.
PELVIS_ROLL = 2.6
#: Torção do tronco que acompanha o braço que está mais aberto.
TORSO_TWIST = 2.4

#: Tetos de extensão. São rede de segurança, não parâmetro: as trajetórias foram
#: dimensionadas para pararem em 92%, e se a IK precisar clampar em 96% é porque
#: alguma constante acima mudou — o erro de IK que o `build` devolve denuncia.
LEG_EXTENSION_LIMIT = 0.96
ARM_EXTENSION_LIMIT = 0.96


# -- curvas -------------------------------------------------------------------


def _drag(p: float, bias: float) -> float:
    """Reescreve a fase para um trecho do laço correr mais que o outro.

    ``bias`` positivo acelera a passagem por `p = 0` e retarda a por `p = 0,5`;
    negativo troca os dois. Qual ponto do gesto cai em `p = 0` é assunto de quem
    chama — ver `KICK_DRAG`. Monótona e com derivada contínua para |bias| < 1, e
    `_drag(0) == 0`, `_drag(1) == 1` — então o laço continua fechando.
    """
    return p + bias * math.sin(2.0 * math.pi * p) / (2.0 * math.pi)


def _breath(phase: float) -> float:
    """Ciclo respiratório de -1 a 1, com a inspiração mais curta que a expiração.

    Mesma forma do `anim_idle`, com a inspiração ainda mais curta (0,34 contra
    0,40 do ciclo): quem está com a água no peito não enche o pulmão devagar, ele
    rouba o ar entre duas ondas.
    """
    p = phase % 1.0
    if p < 0.34:
        return -math.cos(math.pi * (p / 0.34))
    return math.cos(math.pi * ((p - 0.34) / 0.66))


def kick_angle(side: str, t: float) -> float:
    """Onde a perna está no cone, em radianos, na fase *t* do **clipe**.

    Uma origem só para tudo que a perna faz — tornozelo, pé e joelho saem daqui —,
    porque o defeito clássico é cada parte da perna ter a própria curva e a sola
    virar para baixo na hora errada quando alguém mexer numa delas.

    As duas pernas correm **meio ciclo defasadas**: enquanto uma abre, a outra
    recolhe. É o que dá sustentação contínua (sempre há uma perna empurrando) e é
    o que garante que a silhueta nunca seja simétrica — duas pernas fazendo a mesma
    coisa ao mesmo tempo é metade do que faz um clipe parecer brinquedo.
    """
    phase = (KICK_CYCLES * t + (0.0 if side == "L" else 0.5)) % 1.0
    return 2.0 * math.pi * _drag(phase, KICK_DRAG)


def leg_angles(side: str, t: float) -> tuple[float, float]:
    """Abdução e flexão da perna na fase *t*, em graus, no referencial do corpo.

    Os dois ângulos que descrevem a pernada inteira, e eles são os ângulos
    **projetados** de verdade: `abduction` é o que a vista de frente mede e
    `flexion` é o que a vista lateral mede. Escrever a trajetória assim, e não em
    três meias-amplitudes cartesianas, é o que permite conferir uma constante
    contra a imagem sem intermediário — a menos da reclinação, que soma na flexão
    quando se passa para o mundo (ver `RECLINE`).

    O espelhamento é assimétrico de propósito, e é ele que faz o eggbeater ser um
    eggbeater: a **abdução** é espelhada entre os lados (para fora é +X à esquerda
    e -X à direita) e a **flexão** não é (para a frente é -Y nos dois). Com isso as
    duas pernas percorrem os respectivos laços em **sentidos de rotação opostos** —
    vista de cima, uma gira num sentido e a outra no outro. É dessa oposição que
    vem o nome "batedeira", e é ela que anula o torque de guinada: sem isso o
    personagem giraria devagar em torno do próprio eixo o clipe inteiro.
    """
    angle = kick_angle(side, t)
    return (LEG_CONE_OUT + LEG_SWEEP_OUT * math.cos(angle),
            LEG_CONE_FWD + LEG_SWEEP_FWD * math.sin(angle))


def leg_offset(side: str, t: float) -> Vector:
    """Onde o tornozelo está em relação ao quadril, no referencial do corpo.

    Um laço fechado sobre um cone achatado, percorrido uma vez por pernada. Fechado
    por construção, então o clipe emenda sem tranco e sem nenhum tratamento de
    ponta.

    Em `φ = 0` a perna está no ponto mais **aberto** (e é onde a fase corre mais
    rápido — o empurrão); em `φ = π` no mais **fechado**, recolhida sob o corpo; em
    `φ = π/2` e `3π/2`, à frente e atrás. O raio respira junto: a perna estica um
    pouco ao empurrar e encolhe ao recolher.
    """
    sign = 1.0 if side == "L" else -1.0
    abduction, flexion = leg_angles(side, t)
    direction = Vector((sign * math.tan(math.radians(abduction)),
                        -math.tan(math.radians(flexion)),
                        -1.0)).normalized()
    radius = LEG_CONE_R + LEG_CONE_R_SWING * math.cos(kick_angle(side, t))
    return direction * radius


def foot_pitch(side: str, t: float) -> float:
    """Inclinação do pé na fase *t*. Positivo é ponta para baixo.

    Sai do mesmo ângulo do cone, e não de uma curva própria: o pé é consequência
    do que a perna está fazendo. Negativo no ponto mais aberto (sola para baixo,
    empurrando) e positivo no recolhido (ponta caída, fatiando).
    """
    return -FOOT_PITCH_PUSH * math.cos(kick_angle(side, t))


def knee_hint(side: str, t: float) -> Vector:
    """Para onde o joelho aponta na fase *t*, no referencial do corpo.

    Dominado pela componente **lateral** — é isso que abre o joelho como sapo em
    vez de projetá-lo à frente do quadril —, com o resto de frente balançando junto
    com a varredura para o joelho circular acompanhando o pé.
    """
    sign = 1.0 if side == "L" else -1.0
    lead = KNEE_LEAD + KNEE_LEAD_SWING * math.sin(kick_angle(side, t))
    return Vector((sign, -lead, 0.0))


def arm_offset(side: str, t: float) -> Vector:
    """Onde o punho está em relação ao ombro, no referencial do corpo."""
    sign = 1.0 if side == "L" else -1.0
    phase = (SCULL_CYCLES * t + SCULL_OFFSET
             + (0.0 if side == "L" else SCULL_SPLIT)) % 1.0
    angle = 2.0 * math.pi * phase

    out = SCULL_OUT + SCULL_OUT_HALF * math.sin(angle)
    forward = SCULL_FWD + SCULL_FWD_HALF * math.sin(2.0 * angle)
    down = SCULL_DOWN + SCULL_DOWN_HALF * math.cos(2.0 * angle)
    return Vector((sign * out, -forward, -down))


#: Passo da diferença finita que dá as velocidades, em fração do ciclo. Meio
#: quadro: menor que isso e a subtração começa a perder dígitos.
_STEP = 0.5 / CYCLE_FRAMES


def _velocity(func, side: str, t: float) -> Vector:
    """Velocidade de uma trajetória de efetor, em m/s no referencial do corpo."""
    ahead = func(side, (t + _STEP) % 1.0)
    behind = func(side, (t - _STEP) % 1.0)
    return (ahead - behind) / (2.0 * _STEP * CYCLE_FRAMES / FPS)


def _peak(func, axis: int, mirror: float = 1.0) -> float:
    """Maior valor que a combinação das duas velocidades alcança naquele eixo.

    Com ``mirror`` = 1 mede a **soma** (as duas pernas empurrando para o mesmo
    lado, que é o que levanta o corpo); com -1 mede a **diferença** (uma
    empurrando contra a outra, que é o que rola o corpo). Os dois picos não são
    iguais nem parecidos — com as pernas meio ciclo defasadas a soma quase se
    cancela —, e normalizar os dois pelo mesmo número deixaria uma das duas
    oscilações dez vezes fora de escala.

    Existe para as constantes de balanço ficarem em **metros** em vez de em
    "metros por metro por segundo", e continuarem valendo se alguém mudar o
    cone ou a cadência.
    """
    worst = 0.0
    for i in range(240):
        t = i / 240.0
        combined = (_velocity(func, "L", t)[axis]
                    + mirror * _velocity(func, "R", t)[axis])
        worst = max(worst, abs(combined))
    return worst or 1.0


_KICK_SURGE_PEAK = _peak(leg_offset, 1)
_KICK_ROLL_PEAK = _peak(leg_offset, 2, mirror=-1.0)


def kick_lift(t: float) -> float:
    """Sustentação instantânea da pernada, em unidades arbitrárias.

    Numa pedalada sagital o corpo sobe quando os dois pés descem, e a versão
    anterior deste arquivo media exatamente isso — a soma das velocidades
    verticais. Num eggbeater essa conta perde o sentido: a perna varre um cone e a
    subida e a descida do pé são **consequência geométrica** da abertura, não o
    gesto propulsivo. Quem levanta o corpo aqui é a **varredura lateral** com a
    sola inclinada, exatamente como a mão no sculling: um remo de ângulo de ataque,
    que empurra água para baixo indo e voltando.

    Daí o quadrado: força de fluido vai com o quadrado da velocidade, e o quadrado
    também é o que faz as duas metades da varredura empurrarem para o mesmo lado em
    vez de se cancelarem. Somando as duas pernas, defasadas de meio ciclo, sobram
    **dois pulsos por pernada** — que é o que se vê em quem faz eggbeater de
    verdade, e não um pulso por perna.

    O corpo responde em fase com a força, e não atrasado: a rigidez do empuxo é
    alta o bastante para o regime ser quase estático nesta escala de tempo.
    """
    return sum(_velocity(leg_offset, side, t).x ** 2 for side in ("L", "R"))


_LIFT = [kick_lift(i / 240.0) for i in range(240)]
_LIFT_MEAN = sum(_LIFT) / len(_LIFT)
#: A sustentação é sempre positiva; o que balança o corpo é o **desvio** dela em
#: torno da média. Sem tirar a média, `KICK_HEAVE` viraria um deslocamento
#: constante para cima — ou seja, um `BODY_SINK` a menos, escrito no lugar errado.
_LIFT_PEAK = max(abs(v - _LIFT_MEAN) for v in _LIFT) or 1.0

#: Meia-amplitude da diferença de altura entre os dois tornozelos, medida na
#: própria trajetória. Normaliza o `leg_bias` (a queda do quadril) sem que ninguém
#: precise saber qual semi-eixo do cone responde por ela.
_LEG_BIAS_PEAK = max(
    abs(leg_offset("L", i / 240.0).z - leg_offset("R", i / 240.0).z)
    for i in range(240)
) or 1.0


#: Pico da assimetria dos braços, para `scull_bias` sair normalizado. Com
#: `SCULL_SPLIT` em zero isto seria zero, e por isso o `or 1.0`.
_SCULL_BIAS_PEAK = max(
    abs(arm_offset("L", i / 240.0).x + arm_offset("R", i / 240.0).x)
    for i in range(240)
) or 1.0


def scull_bias(t: float) -> float:
    """Qual braço está mais aberto na fase *t*, de -1 (o direito) a 1 (o esquerdo).

    Sai da **posição** das duas mãos, e não de uma senoide própria: é a defasagem
    de `SCULL_SPLIT` que produz a assimetria, então quem quiser tirar o
    torcicolo do tronco tem só de zerar aquele número — e não caçar uma segunda
    curva escondida aqui.
    """
    return (arm_offset("L", t).x + arm_offset("R", t).x) / _SCULL_BIAS_PEAK

# -- o plano do corpo ---------------------------------------------------------


def body_plan(t: float) -> dict:
    """Como o tronco responde ao que os quatro membros estão fazendo, na fase *t*.

    Nada aqui é senoide inventada — mesma disciplina do `anim_climb.body_plan`. O
    corpo sobe quando as pernas varrem mais rápido (ver `kick_lift`), rola para o
    lado da perna que está empurrando mais, e guina de leve atrás do braço mais
    aberto. Se o cone da perna ou a defasagem dos braços mudar, o balanço acompanha
    sozinho em vez de sair de fase com o gesto.
    """
    kick_y = (_velocity(leg_offset, "L", t).y + _velocity(leg_offset, "R", t).y)
    roll_z = (_velocity(leg_offset, "L", t).z - _velocity(leg_offset, "R", t).z)
    lift = (kick_lift(t) - _LIFT_MEAN) / _LIFT_PEAK
    breath = _breath(BREATH_CYCLES * t)
    bias = scull_bias(t)

    return {
        "heave": lift * KICK_HEAVE + breath * BREATH_HEAVE,
        "surge": (-kick_y / _KICK_SURGE_PEAK) * KICK_SURGE,
        "sway": 0.0,
        "pitch": RECLINE,
        "roll": (roll_z / _KICK_ROLL_PEAK) * KICK_ROLL,
        "yaw": bias * SCULL_YAW,
        "breath": breath,
        "bias": bias,
        # -1 a 1: qual perna está mais funda. Quem manda na queda do quadril.
        "leg_bias": (leg_offset("L", t).z - leg_offset("R", t).z) / _LEG_BIAS_PEAK,
    }


def _aim_root(root, plan: dict) -> Matrix:
    """Põe o corpo na água e devolve a rotação do corpo, em 3x3.

    Duas coisas que o `anim_gait.aim_root` não faz e este clipe precisa:

    - **Reclina.** Numa marcha o corpo só balança e gira em torno de Z; boiar
      exige inclinar para trás, e inclinar em torno do quadril não é o mesmo que
      em torno do peito (ver `PIVOT_Z`). Daí a rotação vir cercada de duas
      translações, que é a forma canônica de girar em torno de um ponto.
    - **Devolve a rotação.** Todos os alvos de IK deste arquivo são descritos no
      **referencial do corpo** — "o punho fica 25 cm à frente do ombro" — e é esta
      matriz que os leva para o mundo. Sem ela, reclinar o corpo deixaria os alvos
      para trás e a pose desmontaria.
    """
    pivot = Vector((0.0, 0.0, PIVOT_Z))
    # X negativo é o que recosta: `("X", positivo)` joga o topo para -Y, que neste
    # rig é para a frente. Errar este sinal deita o pirata de bruços na água, e o
    # resto da pose continua "funcionando" — só de cara no mar.
    rotation = (Matrix.Rotation(math.radians(plan["yaw"]), 4, "Z")
                @ Matrix.Rotation(math.radians(plan["roll"]), 4, "Y")
                @ Matrix.Rotation(math.radians(-plan["pitch"]), 4, "X"))

    offset = Vector((plan["sway"], plan["surge"], plan["heave"] - BODY_SINK))
    matrix = (Matrix.Translation(offset)
              @ Matrix.Translation(pivot) @ rotation
              @ Matrix.Translation(-pivot))
    root.matrix = matrix @ root.bone.matrix_local
    return rotation.to_3x3()


def _pose_torso(pose, plan: dict, t: float) -> None:
    """Coluna, clavículas, pescoço e cabeça.

    A coluna quase não trabalha, e é proposital: o que recosta o corpo é o `root`
    inteiro (o corpo boia recostado, não *se dobra* para trás). O que sobra para a
    coluna é a respiração e uma torção mínima atrás do braço mais aberto.

    Quem tem serviço aqui é o pescoço: ele desfaz 7 dos 15 graus de reclinação
    para o olhar ir ao horizonte em vez de ao céu, e passeia devagar de um bordo
    ao outro — é o que faz o personagem parecer procurando o navio em vez de
    esperando um comando.
    """
    breath = plan["breath"]

    pose["pelvis"].rotation_quaternion = anim_gait.world_rotation(
        pose["pelvis"], [("Y", -plan["leg_bias"] * PELVIS_ROLL)])

    for name, share in (("spine_01", 0.30), ("spine_02", 0.38), ("spine_03", 0.32)):
        pose[name].rotation_quaternion = anim_gait.world_rotation(
            pose[name], [("X", -breath * CHEST_EXPAND * share),
                         ("Z", plan["bias"] * TORSO_TWIST * share)])

    for side in ("L", "R"):
        sign = 1.0 if side == "L" else -1.0
        pose[f"clavicle.{side}"].rotation_quaternion = anim_gait.world_rotation(
            pose[f"clavicle.{side}"],
            [("Y", sign * -breath * SHOULDER_RISE)])

    scan = _head_scan(t)
    # A cabeça vem atrasada em relação ao pescoço, com dois terços do passeio no
    # pescoço e o resto na cabeça: girar os dois juntos dá o olhar de radar.
    pose["neck"].rotation_quaternion = anim_gait.world_rotation(
        pose["neck"], [("X", NECK_LEVEL + breath * 0.8),
                       ("Z", scan * 0.62)])
    pose["head"].rotation_quaternion = anim_gait.world_rotation(
        pose["head"], [("X", HEAD_LEVEL - breath * 1.4),
                       ("Z", scan * 0.38),
                       # Uma pontinha de inclinação lateral no fim do passeio, do
                       # lado para onde a cabeça está virando. É o que separa
                       # "olhando" de "varrendo".
                       ("Y", -scan * 0.18)])


def _head_scan(t: float) -> float:
    """Guinada da cabeça na fase *t*, em graus.

    Fundamental de um ciclo por laço com uma harmônica de quatro em cima, defasada
    de meio radiano: a soma não tem ponto de retorno regular, e é pelo ponto de
    retorno que o olho cronometra um laço. Quatro e não três para o passeio não
    cair no ritmo da pernada.
    """
    return (HEAD_SCAN * math.sin(2.0 * math.pi * SCAN_CYCLES * t)
            + HEAD_SCAN_FINE * math.sin(2.0 * math.pi * SCAN_HARMONIC * t + 0.5))


# -- membros ------------------------------------------------------------------


def _rotate_z(vec: Vector, degrees: float) -> Vector:
    """Gira *vec* em torno do Z do corpo. O par do `anim_gait.rotate_x`.

    O motor de marcha só precisa inclinar o pé para cima e para baixo, porque numa
    caminhada a ponta do pé aponta para onde o corpo anda. Aqui ela aponta para
    fora (ver `FOOT_TOE_OUT`), e essa rotação não existe lá.
    """
    angle = math.radians(degrees)
    cos, sin = math.cos(angle), math.sin(angle)
    return Vector((vec.x * cos - vec.y * sin, vec.x * sin + vec.y * cos, vec.z))


def _foot_direction(rest: Vector, pitch: float, sign: float) -> Vector:
    """Direção de repouso do pé, inclinada e aberta para fora.

    Ainda no referencial do corpo — quem a leva ao mundo é a rotação do tronco.
    """
    return _rotate_z(anim_gait.rotate_x(rest, pitch), sign * FOOT_TOE_OUT)


def _pose_leg(pose, data: dict, side: str, ankle: Vector, pitch: float,
              hint: Vector, rotation: Matrix) -> tuple[float, float]:
    """Uma perna por IK contra *ankle*. Devolve (erro, extensão).

    O pé e o dedo são apontados **na direção de repouso girada pelo corpo**: um pé
    aqui não tem chão para ficar plano contra, ele acompanha a perna, e é o corpo
    reclinado que define onde é "para baixo" para ele.
    """
    sign = 1.0 if side == "L" else -1.0
    thigh = pose[f"thigh.{side}"]
    hip = thigh.matrix.translation.copy()

    reach = data["femur"] + data["tibia"]
    extension = (ankle - hip).length / reach

    knee = anim_gait.solve_leg(hip, ankle, data["femur"], data["tibia"],
                               LEG_EXTENSION_LIMIT, rotation @ hint)
    anim_gait.aim_bone(thigh, knee - hip, hip)
    bpy.context.view_layer.update()

    calf = pose[f"calf.{side}"]
    anim_gait.aim_bone(calf, ankle - knee, calf.matrix.translation.copy())
    bpy.context.view_layer.update()

    foot = pose[f"foot.{side}"]
    error = (foot.matrix.translation - ankle).length
    anim_gait.aim_bone(foot, rotation @ _foot_direction(data["foot_dir"], pitch, sign),
                       foot.matrix.translation.copy())
    bpy.context.view_layer.update()

    toe = pose[f"toe.{side}"]
    # O dedo acompanha o pé com um resto de curva: dedo na linha exata do pé lê
    # como pé de boneco de madeira, e na água ele está solto.
    anim_gait.aim_bone(toe,
                       rotation @ _foot_direction(data["toe_dir"], pitch + 6.0, sign),
                       toe.matrix.translation.copy())
    return error, extension


#: Para onde a palma deste rig aponta na pose de repouso.
#:
#: Herdado do `anim_climb`: os dedos deste rig se fecham girando em torno do Y do
#: mundo, o que na T-pose leva a ponta do dedo de +X para -Z — a palma olha para
#: baixo. É o que permite virar a mão para uma direção pedida sem adivinhação.
REST_PALM = Vector((0.0, 0.0, -1.0))


def _aim_palm(pose_bone, direction: Vector, palm: Vector) -> None:
    """Aponta a mão **e escolhe o giro dela em torno do próprio eixo**.

    `anim_gait.aim_bone` resolve a direção pelo caminho mais curto e deixa o
    *roll* ao acaso. Para um braço isso basta; para uma mão que empurra água, não:
    é o roll que decide para onde a palma olha, e uma palma virada de lado
    atravessa a varredura inteira **de faca**, sem mover uma gota. O gesto lê como
    braço balançando no ar — e nenhuma medida de posição acusa nada, porque a mão
    está exatamente onde deveria.

    Foi o mesmo defeito que custou três versões ao `anim_climb` (ver `_aim_hand`
    lá). A diferença é que ali a palma certa era uma só, dada pela barra; aqui ela
    muda a cada quadro, e vem da direção em que a mão está viajando.
    """
    rest = pose_bone.bone.matrix_local
    rest_dir = (pose_bone.bone.tail_local - pose_bone.bone.head_local).normalized()
    axis = direction.normalized()

    # Só a parte da palma perpendicular ao eixo da mão é escolha nossa; a
    # componente ao longo do eixo é a direção do próprio dedo, e não um roll.
    target = palm - axis * palm.dot(axis)
    swing = rest_dir.rotation_difference(axis)
    if target.length < 1e-5:
        anim_gait.aim_bone(pose_bone, direction, pose_bone.matrix.translation.copy())
        return
    target.normalize()

    current = swing @ REST_PALM
    current = current - axis * current.dot(axis)
    total = swing
    if current.length > 1e-6:
        total = current.normalized().rotation_difference(target) @ swing

    matrix = (total.to_matrix() @ rest.to_3x3()).to_4x4()
    matrix.translation = pose_bone.matrix.translation
    pose_bone.matrix = matrix


def _pose_arm(pose, data: dict, side: str, t: float,
              rotation: Matrix) -> tuple[float, float, Vector]:
    """Um braço varrendo a água. Devolve (erro, extensão, punho).

    O alvo da IK é o **punho**, e não a palma como na escada: aqui a mão não pega
    em nada, ela continua o antebraço e só quebra um pouco na direção que empurra.
    Mirar a palma faria a IK gastar os 7 cm da mão para levar um ponto que não
    tem função nenhuma a um lugar que não tem contato nenhum.
    """
    sign = 1.0 if side == "L" else -1.0
    upper = pose[f"upperarm.{side}"]
    shoulder = upper.matrix.translation.copy()
    wrist = shoulder + rotation @ arm_offset(side, t)

    reach = data["humerus"] + data["forearm"]
    extension = (wrist - shoulder).length / reach

    hint = rotation @ Vector((sign * ELBOW_HINT[0], ELBOW_HINT[1], ELBOW_HINT[2]))
    elbow = anim_gait.solve_leg(shoulder, wrist, data["humerus"], data["forearm"],
                               ARM_EXTENSION_LIMIT, hint)
    anim_gait.aim_bone(upper, elbow - shoulder, shoulder)
    bpy.context.view_layer.update()

    lower = pose[f"lowerarm.{side}"]
    anim_gait.aim_bone(lower, wrist - elbow, lower.matrix.translation.copy())
    bpy.context.view_layer.update()

    # A palma olha **contra o movimento** e para baixo. É a definição de sculling:
    # a mão é um remo de ângulo de ataque, e a componente para baixo da força que
    # ela gera é o que mantém o corpo alto.
    speed = _velocity(arm_offset, side, t)
    if speed.length > 1e-6:
        speed = speed.normalized()
    palm_local = (-speed * PALM_AGAINST + Vector((0.0, 0.0, -1.0))).normalized()
    palm = rotation @ palm_local

    hand = pose[f"hand.{side}"]
    forearm_dir = (wrist - elbow).normalized()
    _aim_palm(hand, (forearm_dir + palm * WRIST_FLEX).normalized(), palm)
    bpy.context.view_layer.update()

    error = (hand.matrix.translation - wrist).length
    return error, extension, wrist


def _pose_hands(pose) -> None:
    """Concha constante nas duas mãos.

    Constante e não animada de propósito: fechar e abrir a mão numa varredura é
    gesto de quem está pegando alguma coisa. Quem só se sustenta mantém a mão como
    pá o tempo inteiro. Mesmo constante, as falanges **precisam entrar no
    `_key_frame`** — sem chave, o GLB reproduz a mão em repouso.
    """
    for side in ("L", "R"):
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


#: Ossos que este clipe anima **além** dos que o `anim_gait._key_frame` grava.
#:
#: A **clavícula** é a armadilha da pasta, e já pegou o `anim_climb`: as marchas
#: não mexem nela, então ela não está em `KEYED_BONES` — mas aqui o ombro sobe com
#: a respiração, e é sobre o ombro deslocado que a IK do braço resolve a pose.
#: Sem gravá-la, a action reproduz o braço com o ombro em repouso e as métricas do
#: `build` continuam ótimas, porque medem a pose construída e não a gravada.
EXTRA_BONES = tuple(f"finger_{n}_0{i}" for n in FINGERS for i in (1, 2)) \
    + ("thumb_01", "thumb_02") + ("clavicle",)


def _key_frame(arm, frame: int) -> None:
    """Grava a pose, com clavículas e dedos."""
    anim_gait._key_frame(arm, frame)
    for name in EXTRA_BONES:
        for side in ("L", "R"):
            bone = arm.pose.bones.get(f"{name}.{side}")
            if bone is not None:
                bone.keyframe_insert("rotation_quaternion", frame=frame,
                                     group=f"{name}.{side}")


def _assign_action(arm, name: str) -> None:
    """Troca a action ativa do rig, com o slot que o Blender 4.4+ exige.

    Sem o slot a action fica atribuída e **não avalia**: o personagem congela em
    repouso e a conferência mede uma T-pose flutuando. Mesma armadilha anotada no
    `anim_climb`; está repetida aqui para este arquivo não depender de uma função
    privada de outro clipe.
    """
    action = bpy.data.actions[name]
    arm.animation_data.action = action
    slots = getattr(action, "slots", None)
    if slots:
        arm.animation_data.action_slot = slots[0]


# -- montagem -----------------------------------------------------------------


def build(arm=None) -> dict:
    """Gera a action `Float` e devolve as medidas do ciclo.

    As medidas daqui saem da pose **construída**, e é bom não confiar demais
    nelas: quem prova que o clipe presta é o `verify()`, que relê a action gravada
    e deforma a malha. Ver a nota do `anim_climb` sobre a clavícula.
    """
    arm = arm or bpy.data.objects[anim_gait.ARMATURE_NAME]
    metrics = anim_gait.rest_metrics(arm)
    arms = {}
    for side in ("L", "R"):
        upper = arm.data.bones[f"upperarm.{side}"]
        lower = arm.data.bones[f"lowerarm.{side}"]
        arms[side] = {
            "humerus": (upper.tail_local - upper.head_local).length,
            "forearm": (lower.tail_local - lower.head_local).length,
        }

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
    action.use_fake_user = True          # sem isso a action some ao reabrir
    arm.animation_data.action = action

    pose = arm.pose.bones
    worst = {"leg_error": 0.0, "arm_error": 0.0,
             "leg_extension": 0.0, "arm_extension": 0.0}
    heaves, chins, wrist_depth = [], [], []

    # O último quadro repete o primeiro de propósito: é ele que fecha o laço.
    for frame in range(0, CYCLE_FRAMES + 1):
        t = (frame % CYCLE_FRAMES) / CYCLE_FRAMES
        scene.frame_set(frame)

        plan = body_plan(t)
        heaves.append(plan["heave"])
        rotation = _aim_root(pose["root"], plan)
        bpy.context.view_layer.update()

        _pose_torso(pose, plan, t)
        _pose_hands(pose)
        bpy.context.view_layer.update()

        for side in ("L", "R"):
            hip = pose[f"thigh.{side}"].matrix.translation.copy()
            ankle = hip + rotation @ leg_offset(side, t)
            error, extension = _pose_leg(pose, metrics[side], side, ankle,
                                         foot_pitch(side, t), knee_hint(side, t),
                                         rotation)
            worst["leg_error"] = max(worst["leg_error"], error)
            worst["leg_extension"] = max(worst["leg_extension"], extension)

        for side in ("L", "R"):
            error, extension, wrist = _pose_arm(pose, arms[side], side, t, rotation)
            worst["arm_error"] = max(worst["arm_error"], error)
            worst["arm_extension"] = max(worst["arm_extension"], extension)
            wrist_depth.append(wrist.z)

        bpy.context.view_layer.update()
        # A cabeça do osso da cabeça é a base do crânio: serve de aviso barato de
        # que o rosto está fora da água. A folga que vale é a da malha, no
        # `verify()` — a barba desce 7,5 cm abaixo deste ponto.
        chins.append(pose["head"].matrix.translation.z)
        _key_frame(arm, frame)

    anim_gait._linear_curves(action)
    scene.frame_set(0)

    return {
        "action": ACTION_NAME,
        "fps": FPS,
        "frames": CYCLE_FRAMES,
        "cycle_seconds": round(CYCLE_FRAMES / FPS, 3),
        "kick_seconds": round(CYCLE_FRAMES / FPS / KICK_CYCLES, 3),
        "scull_seconds": round(CYCLE_FRAMES / FPS / SCULL_CYCLES, 3),
        "breaths_per_min": round(60.0 * BREATH_CYCLES / (CYCLE_FRAMES / FPS), 1),
        "body_sink_m": BODY_SINK,
        "recline_deg": RECLINE,
        # A micro-oscilação vertical que o contrato de água limita a 3 cm.
        "heave_cm": round((max(heaves) - min(heaves)) * 100, 2),
        "skull_base_clearance_cm": round(min(chins) * 100, 2),
        "wrist_depth_cm": [round(min(wrist_depth) * 100, 1),
                           round(max(wrist_depth) * 100, 1)],
        # Se a IK não alcançou o alvo, a pose que se vê não é a que está descrita.
        "ankle_error_mm": round(worst["leg_error"] * 1000, 3),
        "wrist_error_mm": round(worst["arm_error"] * 1000, 3),
        "leg_extension_max": round(worst["leg_extension"], 3),
        "arm_extension_max": round(worst["arm_extension"], 3),
    }


# -- conferência do que ficou gravado -----------------------------------------

#: Grupos cujos vértices formam a cabeça, para a medida de folga. O pescoço entra
#: porque a barba desce por cima dele: a fronteira entre os dois grupos passa no
#: meio do queixo, e medir só `head` deixaria de fora justamente o ponto mais
#: baixo do rosto.
HEAD_PARTS = ("head", "neck")

#: Segmentos tratados como cápsula na busca por membro atravessando membro.
LIMB_BONES = ("thigh", "calf", "upperarm", "lowerarm")
#: E o tronco, medido em separado — ver `_limb_radius` para o porquê de ele não
#: entrar na mesma conta.
TORSO_BONES = ("pelvis", "spine_01", "spine_02", "spine_03")


def _dominant_group(obj) -> dict[int, str]:
    """Para cada vértice, o grupo que mais manda nele."""
    names = {g.index: g.name for g in obj.vertex_groups}
    out = {}
    for vert in obj.data.vertices:
        best, group = 0.0, ""
        for g in vert.groups:
            if g.weight > best:
                best, group = g.weight, names[g.group]
        out[vert.index] = group
    return out


def _limb_radius(obj, arm, bone: str, dominant: dict[int, str],
                 quantile: float = 0.85) -> float:
    """Raio da cápsula daquele osso, medido na malha em repouso.

    Distância perpendicular dos vértices que o osso domina até o eixo dele, no
    **quantil 0,85** e não no máximo — e a escolha é a diferença entre uma medida
    e uma piada. O máximo de `thigh` é a ponta da aba do casaco, que o README já
    declara que interpenetra a calça de propósito; usar o máximo daria uma coxa de
    18 cm de raio e acusaria colisão em qualquer pose com as pernas juntas.
    """
    head = arm.data.bones[bone].head_local
    tail = arm.data.bones[bone].tail_local
    axis = (tail - head)
    length = axis.length
    axis = axis / length

    radii = []
    for vert in obj.data.vertices:
        if dominant.get(vert.index) != bone:
            continue
        offset = vert.co - head
        along = min(max(offset.dot(axis), 0.0), length)
        radii.append((offset - axis * along).length)
    if not radii:
        raise RuntimeError(f"nenhum vértice dominado por {bone}")
    radii.sort()
    return radii[min(int(quantile * len(radii)), len(radii) - 1)]


def _segment_distance(p0: Vector, p1: Vector, q0: Vector, q1: Vector) -> float:
    """Menor distância entre dois segmentos de reta.

    Vale a pena não usar distância entre **retas**: dois membros deste rig são
    quase sempre reversos, e a perpendicular comum das retas infinitas cai fora dos
    dois segmentos na maioria dos quadros — daria colisão onde não há nenhuma.
    """
    u, v, w = p1 - p0, q1 - q0, p0 - q0
    uu, uv, vv = u.dot(u), u.dot(v), v.dot(v)
    uw, vw = u.dot(w), v.dot(w)
    denom = uu * vv - uv * uv

    if denom < 1e-12:                       # paralelos
        s, t = 0.0, (vw / vv if vv > 1e-12 else 0.0)
    else:
        s = (uv * vw - vv * uw) / denom
        t = (uu * vw - uv * uw) / denom
    s = min(max(s, 0.0), 1.0)
    # Depois de saturar um parâmetro, o ótimo do outro muda: uma rodada de
    # reajuste é o que separa esta conta de um chute nos casos de borda.
    t = min(max((uv * s + vw) / vv, 0.0), 1.0) if vv > 1e-12 else 0.0
    s = min(max((uv * t - uw) / uu, 0.0), 1.0) if uu > 1e-12 else 0.0
    return (p0 + u * s - (q0 + v * t)).length


def _pairs() -> list[tuple[str, str]]:
    """Pares de segmentos que não podem se atravessar.

    Todo membro contra todo membro do outro lado, mais braço contra perna dos dois
    lados. O que **não** entra: segmentos vizinhos na mesma cadeia (coxa e canela
    da mesma perna se tocam no joelho por definição) e braço contra braço do mesmo
    lado.
    """
    out = []
    for i, a in enumerate(LIMB_BONES):
        for b in LIMB_BONES[i:]:
            for sa in ("L", "R"):
                for sb in ("L", "R"):
                    if sa == sb:
                        # Mesmo lado: só interessa braço contra perna.
                        arm_a = a.startswith(("upper", "lower"))
                        arm_b = b.startswith(("upper", "lower"))
                        if arm_a == arm_b:
                            continue
                    if (a, sa) >= (b, sb):
                        continue
                    out.append((f"{a}.{sa}", f"{b}.{sb}"))
    return out


def _capsule_gaps(segment: dict, radius: dict) -> dict[tuple, float]:
    """Sobreposição de cada par de cápsulas. Positivo é membro dentro de membro."""
    return {(a, b): (radius[a] + radius[b])
            - _segment_distance(*segment[a], *segment[b])
            for a, b in _pairs()}


def verify(arm=None, action: str = ACTION_NAME) -> dict:
    """Mede o clipe **relendo a action**, com a malha deformada de verdade.

    Existe pelo mesmo motivo do `anim_climb.verify`: as métricas do `build` medem a
    pose no instante em que é construída, e entre construir e gravar há um
    `_key_frame` que só leva os ossos que alguém lembrou de listar. Quando a
    clavícula ficou de fora, lá, o `build` reportava contato perfeito e o
    personagem agarrava o ar cinco centímetros ao lado da barra.

    Aqui não há contato para medir — é o que distingue este clipe de todos os
    outros — então as réguas são outras cinco:

    1. **Folga do queixo à superfície**, no pior quadro. O jogo promete que a
       cabeça não entra na água.
    2. **Fração de vértices submersos**, e a estabilidade dela. Se ela subir ao
       longo do ciclo, o corpo está afundando devagar e o laço vai dar um pulo.
    3. **Extensão máxima** de braço e perna, para nenhuma articulação travar.
    4. **Membro atravessando membro**, por cápsulas medidas na malha.
    5. **Aceleração dos efetores e a emenda do laço**: água não deixa nada partir
       nem parar de repente, e o quadro da virada não pode ser diferente dos
       outros.
    """
    arm = arm or bpy.data.objects[anim_gait.ARMATURE_NAME]
    obj = bpy.data.objects[anim_gait.MESH_NAME]
    _assign_action(arm, action)

    dominant = _dominant_group(obj)
    head_verts = [i for i, g in dominant.items() if g.startswith(HEAD_PARTS)]
    hand_verts = [i for i, g in dominant.items()
                  if any(k in g for k in ("hand", "finger", "thumb"))]
    foot_verts = [i for i, g in dominant.items()
                  if g.startswith(("foot", "toe"))]
    total = len(obj.data.vertices)

    torso_verts = [i for i, g in dominant.items()
                   if g.startswith(TORSO_BONES) or g.startswith("clavicle")]

    radius = {b: _limb_radius(obj, arm, b, dominant)
              for b in [f"{n}.{s}" for n in LIMB_BONES for s in ("L", "R")]}
    #: A mesma medida de cápsula aplicada ao **esqueleto em repouso**. É a
    #: calibração sem a qual o número não quer dizer nada: com o raio no quantil
    #: 0,85, as duas coxas deste personagem já se sobrepõem 1,9 cm **de pé e
    #: parado**, porque a aba do casaco e a perna da calça entram na conta da coxa.
    #: E a sobreposição bruta do par das coxas é a mesma em todo quadro, porque o
    #: ponto mais próximo entre as duas está nos quadris, que são rígidos entre si
    #: — por isso o número que importa é o **excesso par a par** sobre o repouso,
    #: e não o pior bruto, que fica saturado nesse par.
    rest_gaps = _capsule_gaps(
        {b: (arm.data.bones[b].head_local.copy(), arm.data.bones[b].tail_local.copy())
         for b in radius}, radius)
    rest_overlap = max(rest_gaps.values())

    scene = bpy.context.scene
    chin = math.inf
    chin_frame = -1
    submerged, deepest = [], -math.inf
    hand_z, foot_z, shoulder_z = [math.inf, -math.inf], -math.inf, math.inf
    hand_to_body = math.inf
    overlap, excess, overlap_at = -math.inf, -math.inf, None
    wrists: dict[str, list[Vector]] = {"L": [], "R": []}
    ankles: dict[str, list[Vector]] = {"L": [], "R": []}
    thigh_pitch, thigh_abduction, knee_bend = [], [], []

    for frame in range(CYCLE_FRAMES):
        scene.frame_set(frame)
        bpy.context.view_layer.update()
        evaluated = obj.evaluated_get(bpy.context.evaluated_depsgraph_get())
        mesh = evaluated.to_mesh()

        low = min(mesh.vertices[i].co.z for i in head_verts)
        if low < chin:
            chin, chin_frame = low, frame
        under = sum(1 for v in mesh.vertices if v.co.z < 0.0)
        submerged.append(under / total)
        deepest = max(deepest, -min(v.co.z for v in mesh.vertices))

        hand_z[0] = min(hand_z[0], min(mesh.vertices[i].co.z for i in hand_verts))
        hand_z[1] = max(hand_z[1], max(mesh.vertices[i].co.z for i in hand_verts))
        foot_z = max(foot_z, max(mesh.vertices[i].co.z for i in foot_verts))

        # Quanto a mão chega perto do **casaco**, e não do eixo do corpo: a
        # varredura passa à frente da barriga, que neste personagem se projeta
        # 24,8 cm à frente do eixo do rig, e medir contra o eixo daria uma folga
        # inventada de um palmo. A KD-tree é o que faz caber: 1,8 mil vértices de
        # tronco contra 200 de mão, 210 vezes, sem varredura de todos contra todos.
        tree = KDTree(len(torso_verts))
        for slot, i in enumerate(torso_verts):
            tree.insert(mesh.vertices[i].co, slot)
        tree.balance()
        for i in hand_verts:
            hand_to_body = min(hand_to_body, tree.find(mesh.vertices[i].co)[2])
        evaluated.to_mesh_clear()

        shoulder_z = min(shoulder_z, min(arm.pose.bones[f"upperarm.{s}"].head.z
                                         for s in ("L", "R")))

        # As cápsulas saem da pose avaliada, não da construída: é a mesma leitura
        # que o olho faz no preview.
        segment = {name: (arm.pose.bones[name].head.copy(),
                          arm.pose.bones[name].tail.copy())
                   for name in radius}
        for pair, gap in _capsule_gaps(segment, radius).items():
            overlap = max(overlap, gap)
            # Os pares que **já** se sobrepõem de pé e parado (as duas coxas, presas
            # ao mesmo quadril) não têm o que dizer sobre esta animação: o ponto
            # mais próximo entre eles é rígido, e o número seria o mesmo em
            # qualquer clipe. O que responde à pergunta é o pior entre os pares que
            # estavam livres em repouso.
            if rest_gaps[pair] < 0.0 and gap > excess:
                excess, overlap_at = gap, (*pair, frame)

        for side in ("L", "R"):
            wrists[side].append(arm.pose.bones[f"hand.{side}"].head.copy())
            ankles[side].append(arm.pose.bones[f"foot.{side}"].head.copy())

            # A régua da cadeira, e ela é sempre **no mundo**: a perna é descrita
            # no referencial do corpo, e o corpo está reclinado, então o ângulo
            # que se escreveu na constante não é o que o olho vê. Medir no
            # referencial do corpo foi o erro que deixou uma coxa a 71° à frente
            # da vertical passar por 26° durante um clipe inteiro.
            thigh = arm.pose.bones[f"thigh.{side}"]
            hip, knee = thigh.head.copy(), thigh.tail.copy()
            ankle_at = arm.pose.bones[f"foot.{side}"].head
            direction = (knee - hip).normalized()
            sign = 1.0 if side == "L" else -1.0
            thigh_pitch.append(
                math.degrees(math.atan2(-direction.y, -direction.z)))
            thigh_abduction.append(
                math.degrees(math.atan2(sign * direction.x, -direction.z)))
            knee_bend.append(
                math.degrees((hip - knee).angle(ankle_at - knee)))

    scene.frame_set(0)

    motion = {}
    for name, tracks in (("wrist", wrists), ("ankle", ankles)):
        speeds, accels, seams = [], [], []
        for points in tracks.values():
            steps = [(points[(i + 1) % CYCLE_FRAMES] - points[i]).length * FPS
                     for i in range(CYCLE_FRAMES)]
            accels += [abs(steps[(i + 1) % CYCLE_FRAMES] - steps[i]) * FPS
                       for i in range(CYCLE_FRAMES)]
            speeds += steps
            # A emenda do laço, medida contra os **vizinhos** dela e não contra a
            # mediana do ciclo. A primeira versão comparava com a mediana e
            # acusava 1,40 num laço perfeitamente contínuo — só porque a emenda
            # caiu num trecho rápido do gesto, e a mediana inclui os lentos.
            neighbours = (steps[-2] + steps[0]) * 0.5
            seams.append(steps[-1] / neighbours if neighbours else 1.0)
        motion[f"{name}_speed_max_ms"] = round(max(speeds), 3)
        motion[f"{name}_accel_max_ms2"] = round(max(accels), 2)
        motion[f"{name}_seam_ratio"] = round(max(seams), 3)

    extension = _extension_from_action(arm)

    def spread(track, axis: int) -> float:
        values = [p[axis] for p in track]
        return (max(values) - min(values)) * 100

    return {
        "action": action,
        # Positivo é coxa **à frente** da vertical do mundo. É a régua da cadeira:
        # 90° é coxa horizontal, e horizontal com joelho a 90° é a pose de sentar.
        "thigh_pitch_deg": [round(min(thigh_pitch), 1),
                            round(sum(thigh_pitch) / len(thigh_pitch), 1),
                            round(max(thigh_pitch), 1)],
        # E a outra metade: quanto dessa inclinação está **fora** do plano sagital.
        "thigh_abduction_deg": [round(min(thigh_abduction), 1),
                                round(sum(thigh_abduction)
                                      / len(thigh_abduction), 1),
                                round(max(thigh_abduction), 1)],
        # 180° é perna reta; 90° é a cadeira.
        "knee_angle_deg": [round(min(knee_bend), 1),
                           round(sum(knee_bend) / len(knee_bend), 1),
                           round(max(knee_bend), 1)],
        # A órbita do tornozelo no mundo, eixo a eixo: é o tamanho do círculo que
        # o eggbeater desenha, e é ele que faz a silhueta mudar ao longo do laço.
        "ankle_orbit_cm": [round(spread(ankles["L"], 0), 1),
                           round(spread(ankles["L"], 1), 1),
                           round(spread(ankles["L"], 2), 1)],
        # Quanto os dois pés se abrem entre si, no vaivém e na abertura. Zero nos
        # dois seria pose simétrica em todo quadro — brinquedo, não personagem.
        "ankle_scissor_cm": [
            round((max(a.y - b.y for a, b in zip(ankles["L"], ankles["R"]))
                   - min(a.y - b.y for a, b in zip(ankles["L"], ankles["R"])))
                  * 100, 1),
            round((max(a.x - b.x for a, b in zip(ankles["L"], ankles["R"]))
                   - min(a.x - b.x for a, b in zip(ankles["L"], ankles["R"])))
                  * 100, 1)],
        # Positivo é queixo fora da água, que é a única possibilidade aceitável.
        "chin_clearance_cm": round(chin * 100, 2),
        "chin_worst_frame": chin_frame,
        "shoulder_clearance_cm": round(shoulder_z * 100, 2),
        "submerged_pct": round(sum(submerged) / len(submerged) * 100, 2),
        # A estabilidade é o que prova que o corpo não afunda ao longo do ciclo.
        "submerged_spread_pct": round((max(submerged) - min(submerged)) * 100, 3),
        "submerged_trend_pct_s": round(_trend(submerged) * 100, 4),
        "deepest_point_cm": round(deepest * 100, 1),
        "hand_depth_cm": [round(hand_z[0] * 100, 1), round(hand_z[1] * 100, 1)],
        "foot_highest_cm": round(foot_z * 100, 1),
        "leg_extension_max": round(extension["leg"], 3),
        "arm_extension_max": round(extension["arm"], 3),
        # Positivo é cápsula dentro de cápsula. O que interessa é a comparação com
        # o valor de repouso: se o do clipe não passa dele, a animação não criou
        # interpenetração nenhuma que o personagem já não tivesse parado.
        "limb_overlap_cm": round(overlap * 100, 2),
        "limb_overlap_rest_cm": round(rest_overlap * 100, 2),
        # O número que responde pela animação: o pior entre os pares que estavam
        # livres em repouso. Negativo é folga sobrando entre as duas cápsulas.
        "limb_free_overlap_cm": round(excess * 100, 2),
        "limb_free_overlap_at": overlap_at,
        # A mão contra a superfície do casaco, pelo vértice mais próximo.
        "hand_to_torso_cm": round(hand_to_body * 100, 1),
        **motion,
    }


def _trend(values: list[float]) -> float:
    """Inclinação da reta de mínimos quadrados, por segundo.

    Serve a uma pergunta só: a fração submersa está **derivando** ao longo do
    ciclo? Espalhamento pode ser oscilação honesta (respirar sobe e desce a linha
    d'água); tendência não pode ser nada além de o corpo afundando.
    """
    n = len(values)
    mean_x = (n - 1) / 2.0
    mean_y = sum(values) / n
    num = sum((i - mean_x) * (v - mean_y) for i, v in enumerate(values))
    den = sum((i - mean_x) ** 2 for i in range(n))
    return (num / den) * FPS if den else 0.0


def _extension_from_action(arm) -> dict:
    """Extensão de braço e perna lida da **action**, quadro a quadro.

    A medida do `build` sai da pose construída; esta sai da pose que ficou
    gravada. As duas concordarem é o que diz que o `_key_frame` levou todo mundo.
    """
    bones = arm.data.bones
    reach = {
        "leg": (bones["thigh.L"].tail_local - bones["thigh.L"].head_local).length
        + (bones["calf.L"].tail_local - bones["calf.L"].head_local).length,
        "arm": (bones["upperarm.L"].tail_local
                - bones["upperarm.L"].head_local).length
        + (bones["lowerarm.L"].tail_local - bones["lowerarm.L"].head_local).length,
    }
    scene = bpy.context.scene
    worst = {"leg": 0.0, "arm": 0.0}
    for frame in range(CYCLE_FRAMES):
        scene.frame_set(frame)
        bpy.context.view_layer.update()
        for side in ("L", "R"):
            hip = arm.pose.bones[f"thigh.{side}"].head
            ankle = arm.pose.bones[f"foot.{side}"].head
            worst["leg"] = max(worst["leg"], (ankle - hip).length / reach["leg"])
            shoulder = arm.pose.bones[f"upperarm.{side}"].head
            wrist = arm.pose.bones[f"hand.{side}"].head
            worst["arm"] = max(worst["arm"], (wrist - shoulder).length / reach["arm"])
    scene.frame_set(0)
    return worst


# -- preview ------------------------------------------------------------------

#: A superfície do preview é uma **grade vazada**, e não um plano translúcido.
#:
#: Andaime, não cenário — mesmo papel da escada temporária do `anim_climb`: sem
#: uma régua em `z = 0` não há como julgar um clipe cujo contrato inteiro é a
#: linha d'água. A grade vazada resolve o problema que um plano cheio criaria: o
#: `playblast` renderiza no Workbench, onde transparência de material depende de
#: opções de sombreamento que mudam de versão, e mesmo funcionando um plano opaco
#: esconderia exatamente a metade do corpo que se quer conferir. Vazada, ela lê
#: como plano na vista de três quartos (a grade dá a perspectiva) e vira uma linha
#: fina na vista lateral, que é onde a folga do queixo se mede a olho.
WATER_HALF = 1.20
#: Passo e largura da barra: grade rala e fina de propósito. Com 15 cm de passo e
#: 18 mm de barra, a vista de três quartos ficava com a superfície tapando o peito
#: — a régua comendo justo o que ela deveria deixar conferir. Vista de 12° de
#: elevação, qualquer grade fecha por escorço, então o remédio é diminuir o
#: **número** de barras, não a largura delas.
WATER_PITCH = 0.26
WATER_BAR = 0.011
#: Meia espessura das barras. As barras são **caixas**, e não folhas planas.
#:
#: Duas tentativas morreram aqui. Uma grade de quadriláteros em `z = 0` some por
#: completo na vista **lateral**: a câmera está na elevação zero e um plano visto
#: de perfil não tem pixel nenhum — o primeiro teste saiu com o pirata boiando num
#: vazio cinza, sem régua, justamente na vista em que a folga do queixo se julga a
#: olho. Desdobrar em duas folhas a ±6 mm não resolveu nada, pelo mesmo motivo:
#: duas folhas de espessura zero continuam sendo espessura zero. O que a lateral
#: precisa é de **face vertical**, e é isso que uma caixa tem.
WATER_SHEET = 0.007


def _temp_water(half: float = WATER_HALF):
    """A superfície do mar em `z = 0`, só para o preview. Devolve o que apagar."""
    verts, faces = [], []

    def bar(along_x: bool, offset: float) -> None:
        base = len(verts)
        lo, hi = offset - WATER_BAR * 0.5, offset + WATER_BAR * 0.5
        for z in (-WATER_SHEET, WATER_SHEET):
            for a, b in ((-half, lo), (half, lo), (half, hi), (-half, hi)):
                verts.append((a, b, z) if along_x else (b, a, z))
        faces.append((base, base + 1, base + 2, base + 3))          # fundo
        faces.append((base + 7, base + 6, base + 5, base + 4))      # topo
        for i in range(4):                                          # laterais
            j = (i + 1) % 4
            faces.append((base + i, base + j, base + 4 + j, base + 4 + i))

    steps = int(half / WATER_PITCH)
    for k in range(-steps, steps + 1):
        bar(True, k * WATER_PITCH)
        bar(False, k * WATER_PITCH)

    mesh = bpy.data.meshes.new("__FloatPreviewWater")
    mesh.from_pydata(verts, [], faces)
    mesh.update()

    material = bpy.data.materials.new("__FloatPreviewWaterMat")
    material.use_nodes = True
    bsdf = material.node_tree.nodes["Principled BSDF"]
    bsdf.inputs["Base Color"].default_value = (0.06, 0.42, 0.55, 1.0)
    bsdf.inputs["Roughness"].default_value = 0.25
    # O Workbench em modo `MATERIAL`/`TEXTURE` lê a cor de viewport, e não o nó.
    material.diffuse_color = (0.06, 0.42, 0.55, 1.0)
    mesh.materials.append(material)

    obj = bpy.data.objects.new("__FloatPreviewWater", mesh)
    bpy.context.scene.collection.objects.link(obj)
    return obj, mesh, material


#: Enquadramentos do preview. O corpo vai de -1,16 m (dedo do pé) a +0,55 m (topo
#: do chapéu), então o alvo da câmera fica bem **abaixo** da linha d'água — centrar
#: no personagem como nos clipes de terra cortaria os pés ou jogaria metade do
#: quadro no céu.
PREVIEW_CENTER = (0.0, 0.0, -0.33)
PREVIEW_ORTHO = 2.30


def render_preview(cycles: int = 2, width: int = 520, height: int = 700,
                   views=("quarter", "side"), arm=None) -> dict:
    """Grava os MP4 de conferência e a folha de contato, com a água desenhada.

    Dois ciclos por vídeo, e não um: um laço só não mostra a emenda, que é
    justamente o defeito que os períodos primos entre si existem para evitar — se
    ela aparecer, aparece na virada dos 7 s.
    """
    import playblast

    arm = arm or bpy.data.objects[anim_gait.ARMATURE_NAME]
    _assign_action(arm, ACTION_NAME)

    water, mesh, material = _temp_water()
    frames = [f % CYCLE_FRAMES for f in range(cycles * CYCLE_FRAMES)]
    out = {}
    try:
        for view in views:
            out[view] = playblast.clip(
                "float", frames, view=view, fps=FPS, center=PREVIEW_CENTER,
                ortho=PREVIEW_ORTHO, width=width, height=height)
        # Duas folhas, e as duas na elevação zero — onde a superfície vira uma
        # linha e não tapa nada. A de três quartos foi tentada primeiro e é a pior
        # das três para este clipe: com a grade vista de 12°, o escorço fecha a
        # água justamente na altura do peito, que é onde os braços varrem.
        #
        # De lado se julga a inclinação da coxa e a folga do queixo; de frente se
        # julga o eggbeater, que é onde a varredura lateral aparece — e o sculling
        # junto, que a lateral esconde atrás do próprio tronco.
        # Um quadro a cada 15 cobre o ciclo inteiro em 14 poses.
        for view in ("side", "front"):
            out[f"sheet_{view}"] = playblast.sheet(
                "float", range(0, CYCLE_FRAMES, 15), view=view, columns=7,
                center=PREVIEW_CENTER, ortho=PREVIEW_ORTHO,
                width=int(width * 0.75), height=int(height * 0.75))
    finally:
        bpy.data.objects.remove(water)
        bpy.data.meshes.remove(mesh)
        bpy.data.materials.remove(material)
        bpy.context.scene.frame_set(0)
    return out
