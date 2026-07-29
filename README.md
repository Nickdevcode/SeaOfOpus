# 🏴‍☠️ Sea of Opus — Duelo de Chalupas

Jogo web 3D de combate naval, inspirado no Sea of Thieves. Você comanda uma chalupa
sozinho — anda no convés, assume o timão, larga a âncora, sobe à gávea, carrega e
aponta os canhões, desce ao porão para tapar rombos e bombear água — contra uma
chalupa inimiga tripulada por uma IA de dois homens.

Roda no navegador, em WebGL2. Casco, texturas, mar, céu, chuva e todo o áudio são
**gerados em código** — o único arquivo binário do projeto é o personagem, e ele
também nasceu de script (ver `PirateCharacter/`).

> 🇬🇧 A interface do jogo é em **inglês**. Este README e os comentários do código
> ficam em português — é onde eu penso, e o jogo é onde eu falo com quem joga.

---

## 🚀 Como rodar

```bash
npm install
npm run dev      # servidor de desenvolvimento (Vite)
```

| Comando | O que faz |
|---|---|
| `npm run dev` | Sobe o servidor de desenvolvimento com HMR |
| `npm run build` | Confere os tipos e gera o `dist/` |
| `npm run preview` | Serve o `dist/` já construído |
| `npm run check` | Só a checagem de tipos (`tsc --noEmit`) |
| `npm run check:all` | Tipos do jogo **e** do servidor de sala |
| `npm run dev:server` | Sobe o servidor de sala local (`wrangler dev`, porta 8930) |

> ⚠️ O áudio só abre depois do **primeiro clique ou tecla**. Não é bug: todo
> navegador atual recusa iniciar um `AudioContext` fora de um gesto do usuário.

### Para duelar em rede localmente

Precisa dos **dois** servidores no ar, cada um num terminal:

```bash
npm run dev          # o jogo, em :5173
npm run dev:server   # o servidor de sala, em :8930
```

O `wrangler dev` roda os Durable Objects na sua máquina e **não pede conta na
Cloudflare** — só o `deploy` pede.

Para conferir num segundo que o servidor de sala é mesmo o seu:

```bash
curl http://127.0.0.1:8930/health     # tem que responder {"ok":true}
```

> ⚠️ **Por que 8930 e não a 8787 padrão do wrangler.** No Windows, dois processos
> conseguem escutar a mesma porta quando o primeiro liga com `SO_REUSEADDR` — que
> é o padrão do `python -m http.server`. Quando isso acontece, o wrangler sobe
> anunciando sucesso e as conexões vão para o outro processo: o jogo recebe um
> "connection dropped" sem nenhuma pista, e não há erro para achar em lado
> nenhum. Se o `/health` acima devolver HTML em vez de JSON, é exatamente isso —
> tem outra coisa na porta. A porta está fixa em `server/wrangler.jsonc` e no
> `.env.development`; mudou numa, muda na outra.

> ⚠️ Teste em **duas janelas**, não em duas abas. Navegador estrangula o
> `requestAnimationFrame` de aba em segundo plano, e como quem hospeda simula os
> dois cascos, o duelo inteiro para. Uma janela normal e uma anônima é o jeito
> mais rápido — assim cada uma tem o próprio apelido salvo.

---

## 🎮 Controles

Teclado e controle funcionam juntos, e a interface **troca os rótulos no instante em
que você encosta no controle** — não quando ele é plugado. Voltar ao WASD traz os
rótulos de teclado de volta (em jogo, mexer o mouse também basta; no menu, onde o
cursor está solto, é preciso uma tecla ou um clique).

Num controle da Sony os rótulos saem no layout de lá: `✕ ○ □ △`, `L1/L2`, `Create` e
`Options`. Os botões são os mesmos — só o que está gravado neles muda.

> 🖱️ **No mouse, dê um clique na tela ao entrar na partida.** O navegador só
> entrega movimento cru de mouse para quem *travou o ponteiro*, e travar exige um
> gesto — não há como o jogo fazer isso sozinho quando a partida começa, ainda
> mais em rede, onde o começo vem do servidor e não da sua mão. Enquanto o
> ponteiro está solto, o jogo escreve **"Click to look around"** na base da tela.
> Quem joga de controle nunca vê esse aviso: o analógico direito olha em volta
> sem depender de trava nenhuma.

| Ação | Teclado | Controle |
|---|---|---|
| Andar / correr / pular | `W A S D` · `Shift` · `Espaço` | Analógico esq. · `L3` · `A` |
| Interagir (timão, cabrestante, canhão, escada do mastro, bomba, rombo) | `F` | `X` |
| Sair do posto atual — e soltar a escada | `X` | `B` |
| Carregar o canhão | `R` | `Y` |
| Disparar | Botão esquerdo | `RT` |
| Mira focada | Botão direito | `LT` |
| Ver controles | `Tab` | `View` |
| Pausar / ajustes | `Esc` | `Menu` |
| Telemetria de física | `F3` | — |
| Câmera livre de inspeção | `C` | — |

### O que **não** tem tecla, de propósito

Duas coisas a bordo são feitas **andando**, e é isso que as faz parecer trabalho em
vez de menu:

- 🪜 **Descer ao porão.** A escada é um lance inclinado, não uma escada de mão.
  Você anda para o buraco e desce. Nenhuma tecla, nenhum modo. Os pés pisam
  degrau a degrau; a **vista** desce pela rampa, senão cada espelho de 26 cm
  daria um tranco na câmera.
- ⚓ **Suspender a âncora.** Um toque de `F` no cabrestante **assume as barras** —
  daí em diante não há botão a segurar: você **anda para frente** e ele gira o
  tanto que você andou, volta após volta, com a câmera acompanhando o giro. Outro
  toque de `F` (ou `X`) larga as barras. Largar o ferro é um toque; suspendê-lo
  custa **onze segundos** de caminhada — e **sem parar**: parar a passada por mais
  de nove décimos manda a amarra de volta ao fundo, como no Sea of Thieves.

### E a que tem, pelo motivo oposto

- 🧗 **A escada do mastro.** `F` para agarrar, `W`/`S` para subir e descer, `F`
  (ou `X`, ou `Espaço`) para largar. **Frente sobe e ré desce nas duas pontas** —
  no convés e na gávea. Enquanto bastava encostar andando, subir acontecia sem
  ninguém pedir (o mastro fica no meio do corredor) e não havia como descer,
  porque descer exigia exatamente o gesto de subir.

---

## ⚔️ Como se ganha um duelo

Não existe barra de vida. **O estado do navio é a água dentro dele.**

1. Um tiro abre um furo numa posição do casco.
2. Água entra por ele na vazão que a diferença de pressão manda (Torricelli).
3. O peso dessa água faz o navio calar mais fundo.
4. Calando mais fundo, **mais furos ficam submersos** e a vazão cresce.

O navio afunda quando ninguém segura essa realimentação. Por isso tapar rombo vem
antes de bombear: a bomba tira 750 L/s e cada rombo submerso mete até 130 L/s, então
**a partir de seis furos abertos a água sobe enquanto você bombeia**. Com o casco
fechado, a bomba esvazia um porão a 30% em meio minuto.

A bomba do inimigo é essa mesma, com a mesma vazão. O que ele faz de diferente é
**largá-la antes de o porão secar** — ver a seção da IA. Você pode secar o seu até a
última gota; ele carrega o que ficou.

A 92% de porão o convés entra n'água e não há mais volta — daí em diante o mar passa
por cima e o casco inteiro enche. São **74 m³ de água** para afundar uma chalupa.

### O ponto de mira que importa

Só o que entra **abaixo do convés** alaga. Tiro na amurada arranca lasca e nada mais.
E um rombo acima da linha d'água só bebe quando passa crista de onda. Mire na linha
d'água — é lá que o furo custa caro.

### 🎯 Acertar duas vezes no mesmo lugar vale por dois

Parece óbvio, e por muito tempo não foi. O modelo de avaria tinha duas regras que se
somavam mal: um tiro a menos de **90 cm** de um rombo aberto *alargava* aquele rombo em
vez de abrir outro, e a vazão de cada rombo era limitada por um teto **fixo** — o mesmo
para um furo pequeno e para um do dobro do tamanho. Juntas, elas diziam que alargar um
buraco não vale quase nada.

O resultado era perverso, e medido:

| Dispersão dos seus 8 acertos | Dano entregue (antes) | Agora |
|---|---|---|
| ±0,5 m — mira excelente | **22%** | **72%** |
| ±1,0 m — mira boa | 36% | 81% |
| ±2,0 m — mira mediana | 53% | 89% |
| ±5,0 m — praticamente sorte | 70% | 93% |

**Quanto melhor você mirava, menos dano causava** — um jogador preciso entregava um
terço do dano de um relaxado, e a IA, que varre o costado por doutrina, jogava no
topo daquela curva enquanto você jogava no fundo dela. Era essa a razão de "acerto
nele e não alaga nada".

As duas regras foram consertadas na raiz: a fusão passou a sair do vão real do rombo
(26 cm de buraco → **42 cm** de fusão, em vez de 90) e o teto de vazão virou uma
**velocidade de veia**, que multiplicada pela área do rombo cresce junto com ele. Um
rombo alargado quatro vezes bebe quatro vezes mais, como qualquer buraco faria.

Sobra um resíduo de ~28% no caso extremo, e ele é honesto: oito balas num palmo de
costado **realmente** se sobrepõem. O que não sobra é a curva invertida.

### 🎒 Os dois paióis, e por que eles **não** decidem o duelo

Nada reabastece no mar. O que o navio leva na largada é o que ele tem para a partida
inteira, dos dois lados:

| Paiol | Carga | Consome quando |
|---|---|---|
| 💣 **Balas** | 160 | carrega um canhão |
| 🪵 **Tábuas** | 48 | um rombo **termina** de fechar |

A tábua sai do paiol **no fim do trabalho, não no começo**. Quem solta o botão no meio
não perde a peça, e o progresso parcial fica guardado no rombo para a próxima tentativa
— o reparo é interrompido o tempo todo pela onda, pelo tiro que chega e pela bomba que
precisa de alguém, e cobrar adiantado transformaria cada interrupção numa multa.

**Os dois números existem para nunca serem alcançados num duelo honesto.** É a terceira
afinação deles, e as duas primeiras erraram pelo mesmo motivo: tratavam o paiol como
peça de balanceamento. Ele não é. Um duelo tem de terminar por quem manobra e mira
melhor — se ele termina porque um dos dois ficou sem bala, o que a partida mediu foi
contabilidade, e não briga. Em 80, a telemetria mostrava o capitão Legend zerando o
paiol aos quatro minutos com o alvo em 74% de porão: o limite estava decidindo a
partida, e pelo relógio. Em 160 ele tem quase sete minutos de fogo ininterrupto, e um
duelo não é ininterrupto.

O teto continua tendo função — tiro a esmo a 150 m custa bala, e o paiol é a única
coisa que cobra por isso — e continua criando a decisão que interessa: com o casco
furado em cinco lugares e três deles acima da linha d'água, **tapar tudo não é de
graça**. O inimigo joga pela mesma regra; quando a madeira dele acaba, o marujo larga
o buraco e vai para a bomba, a única coisa que ainda funciona sem tábua.

### 🪚 O casco conta a história do combate

O rombo era um disco preto de nove lados, e o problema dele não era ser feio — era
não ser **legível**. Um disco chapado no meio de um costado alcatroado não diz onde
a bala bateu; diz que ali falta alguma coisa. O que denuncia um rombo de verdade é
o que está **em volta** dele, e a marca hoje tem três zonas:

| Zona | Raio | O que é |
|---|---|---|
| 🕳️ Furo | 31 cm de vão | O porão, visto de fora. Escuro em qualquer hora do dia |
| 🪵 Miolo | até 54 cm | A madeira de dentro da tábua, clara, com fibra e lascas em relevo |
| 🌫️ Fuligem | até 90 cm | A mancha da explosão, apagando na madeira sã |

Três decisões sustentam isso, e nenhuma é a óbvia:

- **A silhueta não é um círculo, e a irregularidade mora nos dois lados.** A mesma
  função deforma os vértices no shader de vértice e decide onde cada zona de cor
  começa no de fragmento. Se as duas divergissem, a pintura escorregaria para fora
  da forma — que é exatamente o defeito que faz um decalque parecer adesivo.
- **A madeira parte ao longo da fibra.** O furo é 35% mais largo que alto, e as
  fendas que saem dele correm no sentido do tabuado, atravessando a borda do
  estrago para dentro da madeira sã. É a coisa que mais separa "buraco de bala em
  madeira" de "buraco de bala em qualquer outra coisa".
- **O furo tem profundidade sem ter geometria.** Afundar a malha para dentro do
  casco não funciona: o costado é opaco e o z-buffer esconderia o buraco. Então o
  fundo é amostrado com um deslocamento proporcional à direção de visão e *desliza*
  quando a câmera anda. As lascas, essas sim, são geometria — elas sobem 4,5 cm
  para **fora**, onde não há z-buffer para brigar.

### 🔨 O remendo fica onde ele foi pregado

A tábua é pregada **por dentro**, no forro do porão — que é onde o jogador está
quando prega. Parece detalhe e não é: com a peça do lado de fora, o reparo vira uma
coisa que só o inimigo enxerga, e quem fez o trabalho nunca vê o próprio trabalho.

Isso muda o que se vê de cada lado, e os dois estão certos ao mesmo tempo:

| De onde se olha | O que aparece |
|---|---|
| 🪵 **Do porão** | a tábua nova, atravessada e fora do prumo, pregada no forro |
| ⚓ **Do mar** | o furo continua aberto no costado — mas o fundo dele agora é **madeira clara**, a tábua vista pelo buraco, em vez do breu do porão |

O furo **não some** ao ser tapado, e essa foi a segunda correção: um casco que para de
fazer água sem nada acontecer na madeira era a parte menos convincente da coisa toda.
O que o remendo muda é o fundo do buraco, e é isso que deixa distinguir, de longe,
um rombo aberto de um rombo remendado.

### 🕳️ O rombo atravessa — e a face de dentro não é a de fora espelhada

Mudar a tábua de lado consertou metade do problema e deixou a outra metade à mostra:
o **rombo** continuou sendo desenhado só na face externa. O costado tem 13 cm de
espessura e forro dos dois lados, então o jogador descia para tapar o buraco e
encontrava uma parede intacta — e conseguia pregar a tábua assim mesmo, porque a mira
do reparo é por ângulo e não por raio. O rombo funcionava sem existir.

Agora cada rombo tem **duas** marcas, e elas são diferentes de propósito. Numa tábua,
o lado por onde o projétil sai estilhaça muito mais que o lado por onde ele entra — é
o *spall*, que em navio de linha feria mais gente que a própria bala:

| | ⚓ Face de fora (entrada) | 🪵 Face de dentro (saída) |
|---|---|---|
| **Quem manda** | a pólvora | a fibra |
| **Lasca** | 4,5 cm | 7,6 cm, e o furo é 12% maior |
| **Queimadura** | borda chamuscada e fuligem larga | quase nenhuma — carvalho cru |
| **Fundo do furo** | o breu do porão | madeira encharcada, com a água entrando |

O fundo de dentro **não** é uma janela para o mar, e isso é escolha: um vão do tamanho
de um punho mostrando oceano lê como recorte de cenário, enquanto madeira molhada lê
como buraco na hora. E como no porão não há sol competindo com nada, a face de dentro
pode gritar mais alto que a de fora — é ela que o jogador procura quando desce com a
tábua na mão.

Com o rombo tapado, a cicatriz de dentro continua lá: a tábua tem 22 cm de largura
contra quase 1 m de marca, então o que sobra da madeira arrancada **escapa pelos lados
dela**. A colcha de retalhos que o casco vira num combate longo passou a existir nas
duas faces.

A pose da tábua é sorteada a partir do identificador do rombo — giro de até ±23° em
torno da normal e uns centímetros de escorregamento —, o que dá duas coisas: nenhuma
fica igual à outra, e nenhuma treme entre quadros. Um tiro novo no mesmo lugar
**arranca a tábua** e devolve o rombo do tamanho que ele tinha: um remendo é a parte
fraca do casco, e quem tapou um buraco alargado por três balas não recomeça de um
furo pequeno.

> [!note] Por que a cor estava dez vezes errada
> `diffuseColor` vive em espaço **linear**, e as cores do resto do navio chegam lá
> pela textura, que o Three converte sozinho. Uma cor escrita à mão pula essa etapa:
> escrever `0.36` achando que é o mesmo `0.36` do costado põe a madeira dez vezes
> mais clara que ele. O sintoma foi uma coroa branca em volta do furo, com cara de
> espuma do mar.

---

## 🌩️ O tempo

O mar **não é uma constante**. Quatro estados de tempo se encadeiam numa cadeia de
Markov de transições restritas, cada transição levando cerca de dois minutos:

| | ☀️ Clear skies | 🌬️ Fresh wind | 🌧️ Squall | ⛈️ Storm |
|---|---|---|---|---|
| Vento | 0,34 | 0,62 | 0,82 | 1,00 |
| Visibilidade | 4,2 km | 3,2 km | 1,5 km | **750 m** |
| Chuva | — | — | média | fechada |
| Rajadas / min | 0 | 2 | 5 | 9 |
| Relâmpagos / min | — | — | 0,4 | 6 |

Não se passa de céu limpo para temporal: passa-se por um vento que encrespa, uma
nuvem que fecha, um aguaceiro que engrossa. A escalada e a calmaria acontecem em
ordem, e o jogador aprende a ler o que vem antes de ele chegar.

O que isso muda no jogo, além da paisagem:

- 🌊 **A onda quadruplica de amplitude** entre a calmaria e o temporal. Mar grosso
  mexe com a pontaria dos dois lados: a peça é presa ao convés, e o convés está se
  mexendo.
- 💨 **O vento gira sempre**, 20° por minuto, mesmo dentro de um único tempo. O bordo
  rápido de agora não é o bordo rápido de dois minutos atrás.
- 🌀 **Rajadas** empurram os dois navios ao mesmo tempo, sem que nenhum tenha feito
  nada — e é isso que dá momentos numa perseguição que a física, sozinha, empataria.
- 🔀 **Mar cruzado.** A ondulação de fundo segue o vento a um quarto da velocidade,
  então o ângulo entre as duas famílias de onda se abre ao longo da partida. É o que
  separa um mar de uma chapa ondulada.

Quem quiser um mar previsível — para treinar tiro, ou para *ver* o temporal sem
esperar — trava o tempo nos Ajustes.

---

## 🤖 A IA inimiga

### Uma tripulação de dois, e é isso que a torna justa

O caminho fácil seria dar ao bot uma consciência única que governa, aponta as duas
peças e prega tábua ao mesmo tempo. Isso produz um inimigo incombatível, e a única
coisa que o jogador aprende é que o jogo trapaceia.

Então a chalupa inimiga é tripulada como uma chalupa de verdade: **por dois**. Um fica
no timão do começo ao fim. O outro é um homem só, e um homem só está em **um** lugar —
canhão de boreste, de bombordo, ou porão. Ir de um ao outro custa o tempo de
atravessar o convés (2,2 s) ou descer a escada (4,2 s).

Três coisas caem disso de graça:

- 🩹 **O combate ganha respiro.** Quando o inimigo toma rombo, o fogo dele para. Você
  *vê* isso acontecer e entende que acertou — sem número na tela.
- 🔄 **Trocar de bordo tem preço.** Cruze a popa dele e apareça do outro lado: o
  artilheiro tem de atravessar o convés, e há uma janela real em que só você atira.
- ⚖️ **A simetria fica honesta.** Você também não consegue mirar e bombear ao mesmo
  tempo. A diferença é que você tem timoneiro de graça, e ele paga com o segundo homem.

A simetria vale para os paióis também: o inimigo larga das mesmas 160 balas e das
mesmas 48 tábuas. Quando a madeira dele acaba, o marujo do porão **para de escolher
rombo** e vai direto para a bomba — não porque desistiu, mas porque é a única coisa que
ainda funciona sem tábua. Um bot que insistisse no buraco ficaria parado na frente dele
afundando sozinho, e é exatamente esse o bug que a checagem evita.

### 🔁 O serviço da peça: o metrônomo que virou ritmo

Uma medição derrubou a versão anterior deste inimigo. O intervalo entre tiros do
capitão Legend era de **1,533 s — e o mínimo era igual à mediana**, também 1,533 s. Um
artilheiro que em oitenta tiros nunca perde um décimo de segundo não é um artilheiro, é
um metrônomo. Era exatamente essa a sensação de jogar contra ele: a de que a peça dele
nunca precisava ser recarregada.

O erro não era um número mal escolhido, era uma omissão. O único custo do ciclo de tiro
era socar a bala, e ele corria **em paralelo** com o recuo e com a pontaria — o
servente carregava, corria a carreta e apontava tudo ao mesmo tempo, com dois braços
que ele não tem. Três coisas passaram a acontecer em fila, que é como acontecem numa
peça de bordo servida por um homem só:

| Etapa | Custo | Vale para |
|---|---|---|
| 🛞 A carreta corre de volta ao batente | 0,69 s | **os dois** — é da peça, não de quem a serve |
| 🫱 Largar o espeque e trazer a bala | 0,11–0,60 s | o inimigo (o seu equivalente é apertar `R`) |
| 🧨 Socar a carga | 1,5 s | os dois |
| 🎯 Reencontrar o alvo com a peça | variável | o inimigo — a peça dele gira a 29°/s |

A terceira linha é a que mudou o duelo. **O inimigo não aponta enquanto soca a bala**:
quando o serviço acaba, você já andou, e a peça tem de reencontrar você. Manobrar
durante a recarga dele passou a custar caro **para ele**.

Medido depois: o intervalo mediano subiu para 2,37 s e o *mínimo* para 2,22 s — que é,
cravado, o mesmo ciclo que você consegue no canhão apertando `R` no estrondo do próprio
tiro. E o máximo deixou de ser igual ao mínimo: agora há tiros que demoram cinco, oito,
dez segundos, porque o alvo saiu do setor no meio do serviço. O ritmo virou irregular
por construção, que é o que esta seção sempre prometeu.

> 🎮 Apertar `R` no instante do tiro **não** é desperdiçado: o comando entra em fila e o
> trabalho começa sozinho quando a carreta assenta. Você não é punido por ser rápido.

### A tática nasce do batente da carreta

O canhão só gira **±26°** em torno do través. O setor de tiro de cada bordo é a faixa
de 64° a 116° de marcação — ou seja, **manter você sob fogo é trabalho do timão dele**,
não da pontaria. A conta que faz isso é uma linha:

```
β = 90° − k · (distância − distância_de_combate)
```

Longe, `β` cai e a proa dele vira para você: fecha distância. Perto, `β` passa de 90°
e ele abre. No ponto certo, `β` = 90° e ele fica de través com as duas peças em
batalha. Um controlador proporcional disfarçado de manobra naval — e o que se vê na
tela é um capitão circulando você.

### O artilheiro espera o balanço

A conversão "onde acertar → que ângulos da carreta" é refeita **a cada passo de
física**, com a atitude do casco daquele instante. Enquanto o navio caturra, os
ângulos que acertam passeiam; a peça, presa ao convés, não acompanha. O tiro só sai
quando os dois coincidem.

O resultado emergente é o que a artilharia naval sempre fez: **atira-se no alto do
balanço**. Ninguém programou essa regra — ela cai da geometria. E é ela que dá ritmo
ao duelo: o inimigo não cospe fogo, ele espera a onda.

### 🕳️ Ele não conserta tudo — e é por isso que dá para afundá-lo

O outro lado da mesma medição. O marujo inimigo escolhia o rombo de maior vazão e **já
começava a pregar**: sem caminhar até ele, sem buscar a tábua, sem procurar no escuro.
Oito rombos abertos na linha d'água viravam casco estanque em **25 segundos**, em
qualquer dificuldade. Você não estava enfrentando um adversário com um par de mãos.
Estava enfrentando um estaleiro.

Quatro coisas mudaram, e nenhuma delas é o bot ficar burro:

- 🚶 **O porão tem dezesseis metros, e ele os anda.** Cada tábua vem da pilha ao pé do
  lance, e de lá até o buraco. A 1,15 m/s — o passo curto de quem anda curvado num
  pé-direito de 1,85 m com água pela canela — um rombo na proa custa perto de nove
  segundos antes da primeira martelada.
- 🎲 **Ele erra o buraco.** Ninguém tem relatório de vazão por furo: o que ele tem é um
  porão escuro com vários esguichando ao mesmo tempo, e ele vai no que chama mais a
  atenção. O sorteio é ponderado pela vazão, e a perícia é o expoente — o Legend acha o
  pior furo quase sempre, o Deckhand gasta tábua em rombo de amurada com frequência.
- ⏱️ **O turno acaba e ele sobe.** Ele entrega 8 a 14 segundos de porão e volta para a
  peça **com o casco no estado em que estiver**, porque a briga está lá em cima. Não é
  desatenção: é a aposta de afundar você primeiro — a mesma que você faz toda vez que
  decide dar mais um tiro em vez de descer.
- 🪣 **E ele não seca o porão.** A bomba é a mesma dos dois lados e tira os mesmos
  750 L/s — o que mudou é quanto tempo alguém fica nela. Cada capitão tem um nível de
  água que aceita levar de volta para o combate (24% / 15% / 8%), larga a alavanca ali
  e sobe. **É isso que faz o estrago acumular:** antes, o casco dele voltava a ser novo
  entre uma salva e outra, e a água que você tinha posto lá dentro sumia sozinha. Hoje
  a sua próxima salva começa de onde a anterior parou.

A exceção é o que mantém o bot esperto: com o porão passando de 50% o capitão já rompeu
contato, e aí não há turno que valha — o marujo fica embaixo até o casco fechar. Um
inimigo que subisse para a peça com o porão pela metade não seria mais difícil, seria
só suicida.

> 🧮 O nível que ele aceita é **o mesmo número** que o traz de volta ao combate, e não
> dois. Houve dois — um piso de bomba e um limiar de "voltar a brigar" — e eles brigaram
> exatamente como se esperaria: com o piso acima do limiar, o marujo largava a alavanca
> num porão que o capitão ainda considerava crítico, e o navio fugia para sempre
> bombeando nada e atirando nada. Uma pergunta, um número.

**O que isso vale na prática**, medindo contra um jogador sintético que varre o costado
a uma taxa constante — três duelos por célula, com o estado do mar deslocado entre eles:

| Rombos que você abre | 🪣 Deckhand | ⚔️ Corsair | 💀 Legend |
|---|---|---|---|
| 2 / min | afunda em 1 de 3 (4:31) | aguenta (pico 74–79%) | **ela te afunda** em 2 de 3 |
| 3 / min | **afunda** 3:49 | **afunda** 4:07 | **afunda** em 2 de 3 (4:21) |
| 4 / min | **afunda** 3:21 | **afunda** 3:23 | **afunda** 3:43 |

A fronteira fica em **três rombos por minuto**. Abaixo dela você não faz dano suficiente
e a Legend te leva ao fundo primeiro; nela você ganha na maioria dos duelos; acima,
ganha sempre. É a forma que se quer de uma curva de dificuldade — e note que ela existe
por causa da bomba: com o inimigo secando o porão entre as salvas, nenhuma dessas linhas
terminava.

E ela depende de *como* você atira: os números acima são de fogo varrido pelo costado.
Martelando sempre o meio-navio, a Legend aguenta uma taxa a mais — não porque o dano
seja menor (não é mais, ver acima), mas porque o marujo dela **caminha menos**: com
todos os buracos no mesmo pedaço de porão, ele fecha um atrás do outro sem atravessar o
casco. Varrer o costado obriga o inimigo a correr o porão inteiro, e é assim que a
doutrina de artilharia naval passa a valer alguma coisa neste jogo — por logística, e
não por contabilidade de rombos.

E o casco dele passa o combate com **2 a 5 rombos abertos** e o porão nunca abaixo do
piso dele — você *vê* que está ganhando, na água que fica e no fogo que para.

> ⚠️ As células com "2 de 3" não são ruído a arredondar: são o formato certo de uma
> fronteira. Uma linha em que o resultado depende da onda que passou é exatamente onde a
> habilidade do jogador começa a pesar mais que a tabela.

### Os três capitães

A dificuldade mexe em **perícia, nunca em física ou tripulação**. Os três têm o mesmo
casco, o mesmo pano, os mesmos dois canhões e os mesmos dois homens.

| | 🪣 Deckhand | ⚔️ Corsair | 💀 Legend |
|---|---|---|---|
| Erro de pontaria (a 80 m) | ±4,0 m | ±1,4 m | ±0,56 m |
| Liderança do alvo | 55% | 90% | 100% |
| Reação a mudança de situação | 1,2 s | 0,55 s | 0,22 s |
| Abre fogo a até | 75 m | 115 m | 155 m |
| Larga o canhão com o porão em | 30% | 18% | 12% |
| **Água que aceita deixar no porão** | 24% | 15% | 8% |
| Turno de porão por descida | 8 s | 11 s | 14 s |
| Deve à peça antes de descer | 30 s | 22 s | 18 s |
| Acerta o rombo certo | raramente | quase sempre | sempre |
| **Tiros que acertam o seu casco** | 10% | 12% | 32% |
| Balas gastas para afundar um alvo fundeado | ~91 | ~80 | ~84 |
| **Afunda um alvo fundeado em** | 6,2 min | 4,5 min | 4,3 min |

As três últimas linhas são **medidas**, não estimadas: mediana de quatro duelos contra
um alvo fundeado que não conserta nada, com o estado do mar deslocado entre eles — sem
esse deslocamento as quatro medições são a mesma, e a dispersão entre repetições chega a
25%. Precisa ser fundeado: duas chalupas idênticas numa caça de popa empatam por física,
e um alvo à deriva mediria perseguição em vez de pontaria. Nenhum dos três chega perto de
esvaziar o paiol de 160 fazendo isso, que é o ponto da afinação daquele número.

> 🎯 **A taxa de acerto é a única coisa que separa os três em dano.** Cada acerto abre um
> rombo, e é o mesmo rombo nos três níveis — não há multiplicador de dano escondido na
> dificuldade, e nunca houve. O Legend machuca mais porque acerta três vezes mais, e não
> porque a bala dele fura mais fundo.

> 🧠 O Deckhand não erra por sorteio: ele erra **atrasado e curto**, que é como gente
> nova erra de verdade num canhão.

---

## 🏴‍☠️ O corpo a bordo

O jogador tem corpo, e **enxerga o próprio corpo**: olhar para baixo mostra os
ombros, o casaco e os pés se revezando no convés; a escada mostra as mãos caindo
nas barras. Ele também é o que o outro jogador vai ver quando houver multiplayer,
e é aí que o defeito clássico aparece, o pé patinando no convés.

Oito clipes, todos gerados por script no Blender e medidos, não afinados no olho:

| Clipe | Indexado por | Detalhe |
|---|---|---|
| `Idle` | tempo | 3,2 s de respiração, peso migrando de um pé para o outro |
| `Walk` | distância (1,65 m/s nativos) | apoio em 58% do ciclo, sempre um pé no chão |
| `Run` | distância (3,67 m/s nativos) | apoio em 31%, com **fase aérea** de 6 quadros |
| `JumpAir` | **velocidade vertical** | 24 quadros: pernas recolhem na subida, estendem na descida |
| `JumpLand` | tempo (0,47 s) | 14 quadros de amortecimento, com a força vinda do impacto |
| `ClimbUp` | **altura vencida** | um ciclo = dois enfrechates; descer é o mesmo clipe ao contrário |
| `Helm` | **ângulo da roda** | um ciclo = um punho (45°); bombordo é o mesmo clipe ao contrário |
| `Carry` | tempo (2,4 s) | a tábua atravessada no corpo, uma mão em cada ponta |

### Um relógio só: o passo que se vê e o que se sente

Corpo e câmera saem da **mesma fase de passada** (`GaitClock`, em
`player/Locomotion.ts`). Ela não avança pelo tempo, avança pela distância:

```
fase += (velocidade × dt) / distância_do_ciclo
```

Disso cai a propriedade que sustenta tudo: **uma passada cobre exatamente a
distância do ciclo**, em qualquer velocidade e com qualquer mistura — que é o
mesmo que dizer que o pé fica parado no convés durante o apoio. É o que
`tests/locomotion.ts` mede, e o erro dá **zero**.

Os dois clipes são postos no mesmo ponto da passada quadro a quadro; não há
`timeScale`. Dois clipes de durações diferentes rodando por conta própria se
afastam alguns milissegundos por ciclo, e em um minuto o contato de um cai no
meio do apoio do outro. Na velocidade de caminhada do jogo (2,8 m/s) a mistura
fica em **57% corrida**, medido em execução.

> [!note] O balanço da câmera tinha um relógio próprio
> Era `3.4 + velocidade × 1.15`, inventado quando o jogo era só primeira pessoa e
> não havia corpo para discordar. Com o corpo em cena, o pé tocava o convés num
> instante e o solavanco acontecia noutro. Agora o balanço lê a mesma curva
> vertical que levanta o quadril do personagem — inclusive a inversão de fase
> entre andar e correr.

E depois tinha uma **amplitude** própria, que durou até o corpo virar coisa de se
vestir. Eram 4,2 cm afinados no olho contra os 2,1 cm que o clipe de caminhada
levanta de verdade, mais 50° de atraso que o amortecedor introduzia — de fora,
tempero; de dentro, o tronco afundando e emergindo 4 cm a cada passo, a um palmo
do olho. Hoje a câmera pede a altura em metros ao próprio clipe.

### 🙋 Ver o corpo por dentro

Três coisas separam "ter corpo" de "vestir corpo", e nenhuma é a óbvia:

| Problema | O que se fez |
|---|---|
| A câmera nasce dentro do crânio, e o material é `DoubleSide` | `discard` no fragmento pelo **peso de skinning** nos ossos da cabeça (`shaders/headClip.ts`). Encolher o osso não serve: pescoço e gola têm peso misto e seriam *arrastados* para dentro. Um plano de recorte também não: é infinito, e amputaria as mãos na escada. |
| O olho fica no eixo da coluna, e o de gente fica à frente dele | O **corpo** recua 11 cm, não a câmera. O olho é origem de alcance de interação, do ouvido e da mira do canhão — mexer nele para acertar um enquadramento mudaria distâncias de jogo. |
| O corpo aponta para onde anda, e a câmera para onde se olha | Em primeira pessoa os dois se separam: pernas no movimento, tronco no olhar, e a torção repartida por `spine_01/02/03` nos mesmos pesos que o Blender usa. Andar de ré dobra as pernas e toca a passada **ao contrário** — com histerese, senão o strafe de 90° faz o corpo girar a cada quadro. |

Um efeito colateral virou ganho: o mapa de sombras não herda o recorte, então o
pirata projeta a silhueta **inteira, com chapéu**, enquanto a tela mostra o corpo
sem cabeça. Antes o jogador em primeira pessoa não tinha sombra nenhuma.

Visto de fora — a câmera livre, o multiplayer que vem —, nada disso vale: ali o
corpo aponta para **onde anda**, porque sem clipes de andar de lado e de ré um
corpo preso ao olhar desliza de costas, o *moonwalk*.

> [!warning] O canhão é o único lugar onde o corpo some
> `applyCannonView` manda a câmera para 1,35 m atrás da culatra e os pés ficam
> onde estavam ao apertar o botão. A regra que resolve isso em uma linha é *o
> corpo aparece quando a câmera está nos olhos dele* — e o preço é a sombra
> desaparecer do convés enquanto se está no canhão.

### O pulo não é um filme, é uma leitura da física

O pulo do jogo é **instantâneo**: no mesmo quadro em que o `Espaço` desce, a
velocidade vertical já vale 3,3 m/s e os pés já saíram do convés. Não existe
quadro nenhum entre a intenção e a decolagem — e é por isso que **não há clipe de
preparo**. Antecipação é um empréstimo de tempo que este motor não faz; o impulso
que não cabe antes aparece depois, na perna que termina de estender.

O clipe de ar não é *tocado*, é **lido**:

```
faseAr = clamp(0.5 × (1 − vy / 3.3), 0, 1)
```

Fase 0 é a decolagem, 0,5 o ápice, 1 a queda na mesma velocidade com que se
subiu. A pose sai da velocidade vertical, então ela **não tem como discordar da
física**. E o caso difícil cai de graça: um clipe de duração fixa aterrissaria no
meio do ápice num pulinho e daria três voltas numa queda do mastro. Este satura
sozinho e passa a queda inteira no quadro final, pernas já estendidas para
receber o chão.

O pouso é o contrário — roda no tempo, porque não tem grandeza física de onde ser
lido —, mas a **força** dele vem da velocidade de impacto: 3,3 m/s (o pulo cheio)
dão peso 1, e abaixo de 1,0 m/s o pé só encostou e não vale mostrar pouso nenhum.
Tropeçar num degrau de 4 cm não dobra os joelhos do personagem.

| Medido no jogo | Valor |
|---|---|
| Tempo de voo | 0,66 s (0,673 s na teoria) |
| Altura do ápice | 0,545 m |
| Fase do clipe no ápice | 0,494 |
| Força do pouso, pulo cheio | 0,86 |
| Soma dos pesos, em todo quadro | **1,0000** |

Essa última linha é a que mais importa: os pesos dos cinco clipes têm de somar 1
em todo quadro, senão o Three preenche o que falta com a pose de repouso do rig —
a T-pose, de braços abertos. Ar e pouso nunca se sobrepõem (pular de novo cancela
o pouso), e o que eles não ocupam é exatamente o que sobra para a locomoção.

> [!note] No ar ninguém torce o corpo
> O rumo do corpo congela na decolagem. Sem isso a locomoção se apaga durante o
> voo, o alvo do rumo cai de volta para a direção do olhar, e quem pula de lado vê
> o personagem girar no meio do salto.

Sair do chão por outro motivo que não a física — agarrar a escada do mastro,
assumir o timão — usa um caminho separado que apaga o pulo **sem** disparar
pouso. Do contrário o personagem aterrissaria no ar, agarrado a uma escada a nove
metros do convés.

### 🪜 A escada: a mão cai na barra que está desenhada

A escalada é a passada de pé. A fase avança pela **altura vencida**, e enquanto a
mão segura o degrau ele está parado no mundo — no referencial do corpo, desce numa
reta na velocidade exata da subida. Quatro contatos em vez de um, e desta vez com
a régua na tela: o degrau.

O que a torna diferente dos outros clipes é o casamento com a **geometria do
navio**. A escada do mastro tem 30,33 cm entre enfrechates (o `round` do
`ShipParts` arredonda o número de vãos, não o espaçamento), e o ciclo sobe
exatamente dois deles. Como a subida por ciclo é múltiplo inteiro do espaçamento,
alinhar a fase **uma vez**, no instante de agarrar, alinha para sempre:

```
fase = frac((pé + 0,33 − fundoDaEscada) / espaçamento) / 2
```

Daí em diante fase e altura sobem juntas, e a mão continua caindo em cima da
madeira pelos nove metros. Medido em execução, subindo do convés ao cesto: a sola
fica a **0,0 cm** da grade de degraus e a palma a 1,4 cm da barra.

Descer é **o mesmo clipe com a fase andando para trás**. Não é economia: os
contatos da descida têm de cair na mesma grade da subida, e um segundo clipe
teria de reproduzir essa grade — qualquer divergência apareceria como mão
atravessando barra.

| Medido no jogo | Subida | Descida |
|---|---|---|
| Percurso | convés → cesto (8,95 m) | cesto → convés |
| Tempo a 1,2 m/s | 7,1 s | 6,9 s |
| Sola fora da grade de degraus | **0,0 cm** | 0,0 cm |
| Saída | de pé na gávea | de pé no convés |

> [!warning] `CLIMB_SPEED` era 2,1 m/s
> Sete degraus por segundo. Sem corpo isso não incomodava ninguém; com o clipe
> tocando, o pirata virava desenho animado. Agora são 1,2 m/s — quatro degraus por
> segundo, ainda ágil. O clipe funciona em qualquer velocidade (a fase é dirigida
> pela altura), então é só um número.

![o pirata no convés](PirateCharacter/preview/in_game.png)
![na escada do mastro](PirateCharacter/preview/climb_in_game.png)

### 🎡 O timão: o posto era enquadramento e virou anatomia

A roda é a régua mais limpa do projeto. Ela tem **oito punhos**, o curso vai de
`MAX_WHEEL` para cada lado, e disso cai que a roda dá exatamente uma volta de
batente a batente — oito punhos, uma vez cada. Um ciclo do clipe cobre um punho:

```
fase = frac(ânguloDaRoda / (π/4))
```

E aqui não há nem o alinhamento que a escada precisa. A grade de barras da escada
existe no navio e tem de ser encontrada uma vez (`ClimbClock.align`); a grade da
roda **é** o próprio ângulo, periódica de nascença, então a fase cai certa com o
leme a meio, todo carregado ou em qualquer lugar entre os dois. Girar para
bombordo é o mesmo clipe com a fase recuando, pela mesma razão que descer é subir
ao contrário: os contatos das duas guinadas têm de cair nos mesmos oito punhos.

> [!warning] O posto do timoneiro estava 23 cm longe demais — e ninguém sabia
> `HELM_STAND` ficava 85 cm a ré do plano da roda, e esses 85 cm foram escolhidos
> por **enquadramento**, numa época em que o jogador não tinha corpo: o que se
> julgava ali era quanto do navio cabia na tela. No dia em que o corpo chegou, a
> mesma distância virou uma medida **anatômica** — e não fecha. O braço deste rig
> mede 0,678 m do ombro à palma, e o vão era de 0,850 m: **faltavam 17 cm**, mais
> os 11 cm de recuo que a primeira pessoa ainda soma.

Havia duas saídas, e a diferença entre elas é o que se vê. Pagar os 17 cm com
postura funciona — 15 cm de quadril avançado, 18° de tronco, 12° de clavícula —,
e o resultado é honesto no pior sentido: um homem esticado sobre uma roda longe
demais, com o braço a **91%** da extensão. Aproximar o posto para 62 cm sai mais
barato e devolve um timoneiro **em pé**, cotovelo dobrado, braço a **86%** no pior
quadro do ciclo. A variante esticada continua reconstruível no Blender
(`_HelmIntact`), que é como se volta atrás.

Os 0,62 são apertados dos dois lados: é o maior valor que segura os 86% e está a
10 cm do menor que cabe — a face de ré do tambor do leme fica a 0,22 m do plano da
roda, e o cilindro de colisão do jogador tem 0,30 m de raio. Foi esse cilindro que
cobrou a segunda linha: com o obstáculo do timão em 0,5 de raio, **o posto passa a
ficar dentro do próprio obstáculo**, e quem chegasse a pé era expelido do leme
antes de conseguir assumi-lo. O raio virou `0,62 − 0,30 = 0,32`.

E duas coisas no corpo, sem as quais o clipe não vale nada:

| Sintoma | Causa | O que se fez |
|---|---|---|
| As mãos saem da roda quando o jogador olha para o lado | Os braços herdam `spine_03`, e em primeira pessoa o tronco vai para o olhar | O corpo trava de frente para a proa no timão, como já fazia na escada. O custo é o mesmo: ele deixa de acompanhar o olhar — troca barata onde as mãos estão ocupadas |
| As mãos caem 11 cm aquém dos punhos | `FIRST_PERSON_SETBACK` recua o corpo no eixo do tronco, e ali o tronco aponta para a proa: o recuo **soma** ao vão | Recuo zerado no timão. Compensar no clipe não serve — é o mesmo clipe que o outro jogador vê de fora, onde não há recuo |

| Medido no jogo | Valor |
|---|---|
| Ciclo do clipe | 45° de roda (25 quadros a 30 fps) |
| Curso completo da roda | 8 punhos, **8 ciclos exatos** |
| Deriva da mão ao longo dos 360° | 0,27 mm |
| Extensão de braço, pior quadro | 86% |
| Soma dos pesos, com o timoneiro no leme | **1,0000** |

![o timoneiro no jogo](PirateCharacter/preview/helm_in_game.png)

#### 🖐️ Três defeitos que só apareceram puxando o fio de um deles

Uma mão de cabeça para baixo, um corpo que andava aos trancos e um erro de meio
grau que estava escondido atrás dos outros dois. Os três são o mesmo tipo de
falha: **coisas que nenhuma medida do arquivo tinha como reclamar**, porque todas
elas mediam *onde* as peças estavam e nenhuma media para onde estavam viradas.

**1. A mão direita saía invertida.** Uma mão não é um plano, é um objeto
*quiral*: fixados a direção dos dedos e a normal da palma, o polegar não é mais
escolha — ele cai em `dedos × palma` de um lado e no oposto do outro. O arquivo
usava a mesma tangente da roda para as duas mãos, então uma ficava com o polegar
para cima e a outra para baixo. E o contato continuava perfeito: a palma encostava
na madeira com a mesma precisão de sempre, só que pelo lado errado.

Agora cada mão pousa do **seu** lado do punho e olha para o meio do corpo, que é o
que um par de mãos faz ao segurar duas barras verticais. `verify()` passou a cobrar
dois números que teriam pegado isso no primeiro dia: o polegar contra o eixo do
punho (`+0,55`, tinha de ser positivo nas duas mãos, e era **−0,67** na direita) e a
torção do antebraço a partir do neutro anatômico (**78°**, contra os 162° de antes —
um antebraço humano gira uns 90°).

**2. O corpo dava quatro trancos por ciclo.** Tudo o que o tronco fazia era lido
de "a mão está na madeira ou não está", que é uma pergunta de sim ou não: na
troca de punho o quadril atravessava a excursão inteira em 1/25 de segundo. Agora
o corpo lê **quanto peso cada mão sustenta**, que é uma rampa — cada mão carrega o
máximo no meio do trecho em que é a única na roda e entrega devagar quando a outra
chega. De quebra o clipe ganhou o que nunca teve: 4 cm de sobe-e-desce, lidos da
altura das próprias mãos. O timoneiro agora **assenta nos joelhos** enquanto
empurra o punho para baixo.

| Antes | Depois | |
|---|---|---|
| **1,000** | **0,225** | maior salto do corpo entre dois quadros, em fração da excursão (`1,0` é degrau; `0,126` é o piso de 25 quadros) |
| 0 mm | **39 mm** | quanto o corpo sobe e desce no ciclo |
| 10° | 12° | torção do tronco |

**3. E as duas mãos pegavam 2,7° fora da grade dos punhos.** Este só apareceu
porque o primeiro foi consertado. A fase zero do clipe é `ângulo da roda ≡ 0`, e
nesse instante os oito punhos estão em ângulos conhecidos — mas o arquivo escolhia
onde pegar pelo **alcance do ombro**, e caía 2,7° (3,1 cm de arco) ao lado da
madeira. Ninguém via porque `verify()` media a mão contra um punho desenhado *no
ângulo da mão*: um punho fantasma acompanha qualquer erro. O que acontecia de
verdade era a palma afundar 2 cm na peça, escondida pelo tanto que a concha da mão
já sobrepõe a madeira de propósito.

Com a palma da direita do outro lado do punho, os 2,7° deixaram de ser compensados
e viraram **1 cm de mão no ar** — que o `sweep_check` acusou na hora. Os arcos agora
são travados na grade (`off_grid_deg` dá zero nas duas mãos), e o preço é uma
assimetria de 5,4° entre eles que o vão entre as mãos torna inevitável: 3,0° de
desvio na direita, 8,4° na esquerda, 1,2 cm de alcance a menos no braço esquerdo.
O `sweep_check` passou a medir contato na **geometria** e não no centroide do punho
fechado, e as duas medições independentes agora fecham no mesmo número: −2,2 cm de
mão dentro da madeira, em qualquer ângulo de leme do curso inteiro.

> [!note] O que continua em aberto: parado no leme, ele é uma estátua
> A fase do clipe **é** o ângulo da roda — essa é a graça dele —, e navio em rumo
> reto tem roda parada. O corpo então congela no quadro em que estava. Consertar
> isso é um segundo clipe (`HelmIdle`, com as mãos nos mesmos punhos e a respiração
> rodando no tempo) misturado pela *taxa* de giro, e não pelo ângulo. Não está feito.

### 🪚 A tábua: o primeiro clipe que não lê grandeza nenhuma

Os três clipes indexados acima leem alguma coisa do mundo — a passada lê distância, a
escada lê altura vencida, o timão lê o ângulo da roda —, e é disso que vem a
propriedade de nunca discordarem da física. Segurar uma tábua **não tem período
natural nenhum**, e amarrar a fase ao progresso do reparo daria um homem que respira
mais rápido quanto mais perto de terminar. Então este é o único posto que roda no
tempo, como o `Idle`.

O que ele tem de próprio é o resto:

| Problema | O que se fez |
|---|---|
| A referência pedia 58 cm entre as mãos, e este braço não dá | Com as mãos a 29 cm do centro a mão de baixo fica a 99% de extensão — o braço reto, travado no batente da IK. Fechando a pegada para **50 cm** ela cai para 85%, a mesma folga do timão. Perdem-se 4 cm de sobra em cada ponta, e sobram 32 cm de madeira para fora de cada mão |
| A mão espalmada na face da tábua saía torta | 82° de desvio de palma, e a causa não era o código: era o gesto. Ninguém carrega oito quilos espalmando a mão na face; a peça **repousa** na mão, e os dedos sobem pela outra face só para segurá-la ali. Com a palma na aresta, o desvio cai para 27° |
| O pulso saía com 110° de dobra | O timão trava a mão numa direção fixa porque lá a palma precisa ficar tangente ao punho ou escorrega. Aqui a tábua é presa **às mãos**, então não há superfície sobre a qual escorregar: a mão volta a continuar o antebraço, como na escada, e a dobra vira zero |

| Medido no clipe | Valor |
|---|---|
| Erro de mão, pose gravada | **0,000 mm** |
| Variação da distância entre as palmas ao longo do ciclo | **0,000 mm** |
| Extensão de braço, pior quadro | 82% |
| Desvio de palma, pior quadro | 27° |
| Penetração da tábua no corpo (55 128 vértices testados) | **0 mm**, com 1,1 cm de folga no ponto mais próximo |

> [!note] A tábua não é filha de um osso
> O caminho óbvio seria pendurá-la em `hand.R` com um offset fixo, e ele funciona —
> desde que o offset esteja escrito no mesmo referencial em que o osso vive depois de
> atravessar a conversão Z-up → Y-up do exportador glTF e a convenção de eixo de osso
> do Blender. São duas passagens em que um sinal trocado não dá erro nenhum: dá uma
> tábua flutuando ao lado da mão. Então a peça é montada **a partir das duas mãos**,
> todo quadro — o comprimento é a reta que liga um punho ao outro, e o giro sai da
> orientação da direita. Assim ela não é posicionada perto de onde as mãos deveriam
> estar; ela é posicionada onde as mãos **estão**.

> [!warning] O `GLTFLoader` apaga o ponto dos nomes
> O rig chama os ossos lateralizados de `hand.L` e `hand.R`, e é assim que eles saem
> do exportador. O carregador do Three troca o ponto por nada — o `PropertyBinding`
> usa ponto como separador de caminho — e o que chega na cena é `handL`. Isso não
> apareceu em nenhum outro lugar do projeto porque os seis ossos que o
> `FirstPersonBody` procura (`root`, `pelvis`, `spine_0N`) são justamente os que não
> têm lado. O sintoma foi um aviso no console e um reparo sem madeira, com todo o
> resto funcionando.

## 🌊 O que é simulado de verdade

| Sistema | O que tem dentro |
|---|---|
| **Casco** | Uma *função*, não uma malha. `ShipDimensions` sabe a meia-boca em qualquer (estação, altura) — e é a mesma descrição que gera a geometria, detecta os tiros, mede o porão, resolve o abalroamento e decide onde o pé pisa. |
| **Flutuação** | Empuxo por colunas integradas contra a onda. Centro de massa e raios de giração **medidos**, não escolhidos: GM ≈ 0,89 m dá o balanço curto de 4,2 s de um barco de 16 m. |
| **Corpo rígido** | 6 graus de liberdade, com massa adicionada anisotrópica (deriva e arfagem quase dobram a massa efetiva; avanço mal chega a 5%). |
| **Leme** | Placa num escoamento, com o ângulo de ataque real (leme menos ângulo de chegada da água). Daí saem de graça: **navio parado não esterça** e **navio de ré esterça ao contrário**. |
| **Vela** | Tecido de Verlet 13×11 para o visual, força analítica para a física — os dois leem o mesmo vetor de vento, **e a mesma eficiência**: o pano infla na proporção do empuxo, sempre para vante. É o que faz a barriga da lona valer como medidor de rumo, e o que impede a vela de achatar contra o mastro quando o vento vem pela proa. |
| **Bandeira** | Um segundo tecido de Verlet, de 55 nós, preso na cabeça do mastro e lendo o mesmo vento. Não faz força nenhuma: serve de instrumento. Ela aponta a sotavento, então diz de onde vem o vento antes de o jogador procurar o HUD. |
| **Balística** | Arrasto quadrático. A 95 m/s a bala perde 5,4 m/s² só de arrasto, contra 9,81 de gravidade — não é detalhe que dê para ignorar. Alcance máximo cai 29% em relação ao vácuo. |
| **Alagamento** | Volume com superfície livre horizontal **no mundo**: ao adernar, a água escorre para o bordo baixo e o peso vai junto, o que aderna mais. |
| **Âncora** | Amarra elástica com amortecimento, mais o atrito do ferro no fundo. Largar a 10 nós freia o navio em 2,5 s, com um caldo depois — e a amarra tesa no escovém faz o navio pivotar em torno da proa (o *anchor turn*). O ferro é desenhado subindo pela amarra conforme se recolhe, e volta ao fundo se a passada no cabrestante parar. |
| **Abalroamento** | Mola-amortecedor entre os dois cascos, aplicada no ponto de contato — encostar de proa faz o navio pivotar. |
| **Esteira** | Mapa de espuma em render target com ping-pong, reprojetado no mundo a cada quadro para a espuma **ficar na água** em vez de andar com o navio. |
| **Chuva** | Riscos numa caixa fixa em volta da câmera, com a posição de cada gota sendo função só do tempo. Zero estado na CPU, zero alocação: o que se anima é um uniform. |
| **Áudio** | Web Audio puro. Distância não baixa só o volume: **fecha o filtro**, porque é o agudo que o ar come primeiro. A reverberação é uma convolução com resposta ao impulso gerada em código. |

---

## 🪵 Três peças do navio que são jogabilidade

O casco inteiro sai de números (ver acima). Estas três, porém, não estão lá por
fidelidade — cada uma resolve um problema de quem joga.

- 🟡 **O punho de latão do timão.** Os oito punhos da roda eram idênticos, e a
  roda dá mais de uma volta de batente a batente: não havia como saber, olhando
  para ela, se o leme estava no meio ou uma volta fora dele. Um punho de latão
  que só fica **em pé quando o leme está a meio** transforma a roda num
  instrumento — é a mesma marca que o Sea of Thieves usa, e pelo mesmo motivo.
- ⛺ **O toldo do tombadilho.** Popa descoberta lê como balsa. As quatro colunas
  e o telhado dão massa à silhueta contra o horizonte (que é como o inimigo vê
  este navio), e põem o timoneiro *dentro* de alguma coisa. As alturas saem do
  olho do jogador, não de proporção: a cumeeira fica 42 cm acima do ponto mais
  alto que a cabeça alcança num pulo.
- 🧺 **A gávea, agora com espessura.** Ela era feita de superfícies de face
  única, e superfície de face única **não existe** vista do outro lado: do
  convés, olhando para cima, o cesto sumia e sobravam as escoras boiando em
  volta do mastro. Piso, parede e cinta ganharam as duas faces — o mesmo
  conserto que o convés já tinha recebido, pelo mesmo motivo.

## 🎨 A interface

A direção de arte segue uma regra: **tudo é um objeto que existiria a bordo.** Não há
painéis — há tábuas, chapas de latão e folhas de pergaminho pregadas nelas.

- O menu é um **pergaminho pregado numa tábua**, com borda cortada à mão, manchas de
  água e quatro pregos de latão nos cantos.
- Os botões são **placas de latão parafusadas**, com texto gravado. Apertar afunda a
  placa e apaga o brilho de cima.
- Cada capitão é uma **carta de bordo**, e a escolhida leva um carimbo de lacre.
- No HUD, o poço de porão é uma **sonda de vidro** com marcas gravadas, e o estado de
  cada peça é a própria bala: contorno vazio, meia carga, bala dentro.

Tipografia: Cinzel só no logotipo (capital romana lapidar, feita para ser gravada) e
IM Fell English em todo o resto — a digitalização dos tipos da Oxford University Press
do século XVII, com a irregularidade de tinta de quem imprimiu em prensa. Números em
monoespaçada, porque mudam a cada quadro e fonte proporcional os faz dançar.

Nenhuma imagem. Madeira, latão e pergaminho são gradientes repetidos; as bordas
irregulares são `clip-path`.

---

## 🗂️ Organização

```
PirateCharacter/  o personagem: malha, rig e animações, tudo por script
Props/Plank/      a tábua de reparo, também por script (headless)
public/models/    os dois binários — o personagem e a tábua, exportados para a web
src/
├── core/       motor, entrada, matemática, preferências
├── world/      oceano, ondas, céu, clima, chuva, ciclo dia-noite, esteira
├── ship/       casco, flutuação, leme, vela, âncora, canhão, avaria
├── combat/     balística, projéteis, detecção de acerto, contato, efeitos
├── ai/         dificuldade, timoneiro, artilheiro, tripulação, capitão
├── player/     controlador a bordo, câmera, interação, corpo e sua torção
├── game/       máquina de estados de partida
├── ui/         menu, HUD, prompts contextuais
├── audio/      síntese de todo o som
├── shaders/    GLSL compartilhado (ruído, atmosfera, recorte de casco e de cabeça)
├── textures/   geração procedural de mapas
├── net/        sessão de sala, relógios, codec binário e estado interpolado
└── styles/     tokens de design e folhas por módulo
server/         o Worker da sala: rotas, pareamento e o Durable Object do duelo
shared/         o contrato entre os dois — tipos e funções puras, sem DOM nem Three
tests/          balística, IA, avaria, locomoção, relógio de rede e determinismo
```

---

## ⚙️ Desempenho

Há quatro presets no menu (Baixo, Médio, Alto, Ultra) e um palpite inicial pelo nome
da GPU. Por cima deles, duas coisas acontecem sozinhas:

- 🖥️ **Teto de resolução.** O custo de tudo que o renderizador faz cresce com o
  **quadrado** da densidade de pixels, e a tela de notebook é justamente onde ela é
  maior: 1440×900 com razão 2 são 5,2 milhões de pixels por quadro, contra 2,1
  milhões de um monitor 1080p de mesa — a máquina mais fraca das duas recebendo duas
  vezes e meia o trabalho. O teto é o de uma tela 1440p, e só morde em telas HiDPI e
  4K, que é onde a densidade sobrando é a que menos se enxerga.
- 📉 **O preset desce sozinho** se a taxa de quadros ficar seis segundos seguidos
  abaixo de 40, e a escolha fica gravada. Só desce, nunca sobe: um preset que
  oscilasse voltaria a subir no primeiro trecho calmo e cairia de novo no combate,
  que é o pior momento possível para uma queda de quadros. O motivo de existir é
  que hospedar um duelo põe a física de **dois** cascos na mesma máquina, e o
  palpite pelo nome da GPU não sabe nada disso.

Quem quiser mandar na própria máquina continua mandando: escolher um preset no menu
manda no teto de detalhe, e a queda automática só age a partir do que estiver
escolhido.

---

## 🧪 Testes

Não há executor de testes instalado — seriam dependências novas para quatro arquivos.
Eles rodam **no navegador**, com o servidor de desenvolvimento no ar:

```js
// no console do navegador
const b = await import('/tests/ballistics.ts');
console.table(b.runBallisticsTests().cases);

const a = await import('/tests/ai.ts');
console.table(a.runAiTests().cases);

const d = await import('/tests/damage.ts');
console.table(d.runDamageTests().cases);

const l = await import('/tests/locomotion.ts');
console.table(l.runLocomotionTests().cases);

const n = await import('/tests/netclock.ts');
console.table(n.runNetClockTests().cases);

const s = await import('/tests/determinism.ts');
console.table(s.runDeterminismTests().cases);
```

**Balística** prova o caso limite: com arrasto zero a integração *tem* que reproduzir
a parábola de livro, ida e volta. Provado o integrador, os outros casos verificam que
o solucionador e o projétil que voa de verdade concordam — a propriedade de que a mira
da IA depende.

**IA** prova as duas conversões geométricas onde um sinal trocado passaria
despercebido para sempre: que decompor a direção do cano é o inverso exato de compô-la,
e que o sinal do timoneiro fecha a malha em vez de abri-la. Prende também a **ordem da
tabela de dificuldade**: os onze eixos de perícia têm de andar no mesmo sentido do
Deckhand para o Legend, e um número fora de ordem ali produz um "Legend" mais fácil que
um "Deckhand" sem quebrar nada, sem aparecer no `tsc` e sem se revelar em menos de três
partidas inteiras. E prende as duas relações **entre** eixos que travariam o bot: o
turno de porão tem de caber uma tábua inteira, e o nível de água que o capitão aceita
tem de ficar abaixo do alarme que manda o marujo descer — invertidos, ele passa a
partida na escada.

**Avaria** prova a propriedade estrutural que o modelo de alagamento violava em
silêncio: **um acerto vale um acerto, caia onde cair.** Não há resposta certa para
comparar — vazão de rombo em casco de madeira é número afinado, não teorema —, mas há
uma forma que a curva precisa ter, e ela estava invertida: quem mirava melhor causava
dez vezes menos dano. Os casos prendem os dois lados do conserto (a fusão sai do vão
real do rombo, a vazão é linear na área inclusive saturada) e medem a razão entre fogo
agrupado e fogo varrido contra um piso. Hoje ela dá 84%; com o modelo antigo, 24%.

**Locomoção** prova a igualdade de que o corpo inteiro depende: uma passada cobre
exatamente a distância do ciclo, em qualquer velocidade e em qualquer ponto da
mistura entre andar e correr. Se isso deixar de valer, o pé patina — e patinar é
a primeira coisa que o outro jogador vai notar quando houver multiplayer. Os
outros casos prendem a fase da curva vertical, que é onde um cosseno com o sinal
trocado faria a câmera **subir** quando o pé bate.

Os casos do **pulo** simulam a queda inteira com a mesma ordem de operações do
`PlayerController` (gravidade → integração → chão → relógio) e conferem o clipe
contra a parábola: fase 0,5 no ápice e ~1 no contato, com a tolerância derivada de
um quadro de gravidade a 60 fps em vez de chutada. Também prendem o que não se vê
num teste de olho — que ar e pouso nunca se sobrepõem, que uma queda do mastro
satura em vez de dar voltas, e que soltar os pés na escada **não** dispara pouso.

Os da **escada** amarram a animação à geometria do navio: um deles sobe os nove
metros inteiros conferindo, quadro a quadro, se a barra que o clipe manda a mão
agarrar coincide com um enfrechate desenhado — o erro máximo dá menos de 1 mm.
Se alguém mexer no espaçamento da escada ou na altura do cesto sem regerar o
clipe, é aqui que estoura.

Os do **corpo vestido** cobrem o que só passou a poder estar errado depois que o
jogador enxerga a si mesmo: que a câmera sobe exatamente o que o clipe sobe (e
não um exagero afinado no olho), e que a dobra das pernas para andar de ré não
oscila no strafe puro — ali o desvio fica cravado nos 90°, e sem histerese o
corpo daria meia-volta a cada quadro.

**Relógio de rede** é o único que roda **fora** do navegador também — ele não toca em
Three.js. São dois relógios diferentes, e cada um já quebrou de um jeito próprio:

- O de **comando**, que carimba a entrada. Ele tem de andar sozinho e ser apenas
  corrigido pelo instantâneo; derivado dele, o carimbo ficava parado três passos e
  pulava quatro, e três de cada quatro comandos morriam como duplicata.
- O de **desenho**, que decide a pose mostrada entre dois instantâneos. Ele tem de
  ficar **exatamente um intervalo** atrás do mais novo: mais que isso e o alvo cai
  antes do mais velho dos dois que se tem em mão, a interpolação vive grampeada no
  começo e o mundo inteiro do cliente passa a andar a 15 quadros por segundo,
  independentemente de a que taxa ele desenhe.

Cada um tem, ao lado do caso que prova o conserto, um caso que **reproduz o defeito**
— o relógio velho continua no arquivo só para falhar. Se ele parar de falhar, o teste
deixou de testar o que existe para testar, e é isso que o caso denuncia.

### Bancada de inspeção

Em desenvolvimento, `window.__game` expõe o jogo inteiro. O bloco é removido do build
de produção por eliminação de código morto.

```js
__game.match.start('legend');          // começa um duelo
__game.menu.show('none');              // fecha o menu por cima dele
__game.environment.weather.set('storm'); // força um temporal
__game.stepPhysics(30);                // adianta 30 s de física sem desenhar
__game.setDuelView();                  // enquadra os dois navios
__game.setAvatarView({ azimuth: 1.7 }); // enquadra o corpo do jogador
__game.match.player.gait;              // fase da passada, mistura e cadência
__game.match.avatar.debug;             // pesos dos clipes, torção e corte da cabeça
__game.match.avatar.calibrate({ setback: 0.11, threshold: 0.5, neckShare: 0 });
__game.probeSail(90);                  // velocidade de regime a 90° do vento
```

> [!note] Por que existe um `setAvatarView`
> A câmera livre reconstrói a orientação a partir do estado dela a cada quadro,
> então escrever `camera.lookAt` de fora é desfeito no frame seguinte — e a
> captura sai no lugar certo olhando para o lado errado. Custou uns quinze
> minutos de "por que o personagem não aparece".

---

## 🧭 Estado e próximos passos

**Pronto:** navegação em primeira pessoa a bordo · timão com marca de leme a meio ·
âncora com cabrestante que se empurra andando (e corre de volta se largado) · gávea
acessível pela escada de mão, subindo e descendo · dois canhões com recarga e mira ·
balística com arrasto · rombos, alagamento, reparo e bomba · naufrágio · navio inimigo
com IA de três níveis · abalroamento · clima dinâmico com chuva e relâmpago · ciclo
dia-noite · menu, HUD, ajustes e tela de controles · áudio completo · **corpo do
jogador com parado, caminhada, corrida e pulo misturados pela própria física, e
visível em primeira pessoa — pés, ombros, mãos na escada e mãos nos punhos da
roda** · vela e bandeira simuladas lendo o mesmo vento · **marca de tiro no costado
com furo, lascas e fuligem, e a tábua do reparo saindo das mãos para ficar pregada
onde estava o buraco** · **duelo 1v1 em rede, com sala por código, fila de
pareamento e servidor próprio na Cloudflare**.

**O que falta, em ordem de impacto:**

1. 🎚️ **Vela ajustável.** É a lacuna que mais se sente. Hoje o pano está sempre cheio,
   e duas chalupas idênticas numa caça de popa **empatam por física** — a que foge não
   é alcançável. Poder ferrar a vela é o que devolve a decisão de parar e brigar, e é
   exatamente por isso que o Sea of Thieves tem esse controle.
2. 🪣 **Balde.** Tirar água com balde exige item na mão, e não há inventário ainda.
3. 🎯 **Dano por região.** Hoje o mastro para a bala mas não cai.
4. 🔊 **Sons de manobra.** Passos, roda do timão, corrente da âncora, cabrestante e
   bomba não têm som próprio — faltam ganchos de evento para eles, não síntese.
5. ⚡ **Trovão.** O relâmpago acende o céu, mas não faz barulho.
6. 🧍 **Poses de trabalho: falta o canhão e a bomba.** Saíram o timão (mãos nos
   punhos, indexadas pelo ângulo da roda) e a tábua de reparo (a peça atravessada
   no corpo, lida das duas mãos), mas no canhão e na bomba o corpo continua parado
   respirando enquanto as mãos deveriam estar ocupadas. Nas duas o problema é mais
   difícil que no timão, porque nenhuma tem uma grandeza tão limpa para indexar a
   fase: a bomba é cadência escolhida, e o canhão é uma sequência de gestos, não um
   ciclo.
7. 🕳️ **A marca do tiro não se vê por dentro.** A tábua do reparo sim — ela é
   pregada no forro —, mas o furo e as lascas são desenhados na superfície
   **externa**, e do porão o que se enxerga é o forro, a 13 cm dela. Quem desce
   para tapar localiza o buraco pelo esguicho e pelo prompt, que é como já era
   antes de a marca existir; um furo que atravessasse o costado nos dois sentidos
   seria melhor do que isso.
8. 🎞️ **Clipes de andar de lado e de ré.** A torção de quadril e a passada lida
   ao contrário resolvem o essencial sem tocar no GLB, mas continuam sendo
   disfarce: um `anim_strafe.py` entregaria o contato de pé certo no strafe.

---

## 🌐 O duelo em rede

Dois capitães, um contra um. Três formas de se encontrar: **fila** (pega quem
estiver esperando), **abrir uma sala** (você recebe um código de quatro letras) ou
**entrar numa sala** (você digita o código de alguém).

### Como ele funciona, em um parágrafo

Quem simula é **um dos dois jogadores**, não o servidor. O servidor de sala — um
Worker com Durable Objects na Cloudflare — apresenta os dois e retransmite bytes,
sem nunca abrir um quadro de simulação. O motivo é a conta do plano gratuito: um
laço de 60 Hz dentro de um Durable Object custaria ~36.000 requests por partida
(três duelos por dia); retransmitindo, o mesmo duelo custa ~685 — **cerca de 145
duelos por dia, de graça**.

### Quem hospeda não é quem clicou primeiro

É quem tem a **máquina melhor**. Cada cliente manda uma nota de desempenho no
`hello`, e a sala dá o comando ao mais capaz — porque quem hospeda carrega a
física dos dois cascos, e uma máquina fraca no comando engasga os dois jogadores.
Quem abriu a sala tem preferência e só perde o posto para uma diferença clara.

> ⚠️ E "quem abriu" é lido de um **carimbo de chegada**, não da ordem em que a
> plataforma devolve os sockets — ela não promete ordem nenhuma. Enquanto a regra
> se apoiava nessa ordem, a preferência era sorteio: um jogador abriu a sala com
> nota máxima e recebeu o papel de convidado, que é exatamente o que a regra
> existe para impedir.

### O que o cliente prevê, e o que ele espera

| Prevê localmente | Espera do host |
|---|---|
| O corpo no convés | Pose e rumo dos cascos |
| A câmera (nunca corrigida) | Dano, rombos, alagamento |
| **O ângulo da roda do leme** | O que cada bala acerta |
| A mira e a barra de recarga | O tempo, o vento e a hora do dia |
| **Assumir e largar um posto** | — |

A última linha mudou depois do primeiro teste com gente de verdade. Ela **sempre**
esteve prevista na prática — `Interaction.press` chama `takeHelm()` nos dois lados,
porque é o mesmo código —, só que sem reconciliação: o instantâneo seguinte, que
descreve um instante anterior ao aperto, devolvia o jogador ao convés, e ele
piscava entre a roda e o chão até o host confirmar. Hoje a predição fica de pé até
o **recibo** (o `ackTick`) mostrar que o host já viu o comando que a causou. É a
diferença entre um timão que responde na hora e um que responde em 400 ms — ou
que parece não responder.

A lista da esquerda tem uma coisa em comum: são todas **integração pura do próprio
comando**, então os dois lados chegam ao mesmo número sem precisar conversar. É o
que faz a roda do leme girar na hora — o navio responder dois segundos depois não
é latência, é massa, e é assim que se lê.

E nada disso precisa de rollback, por uma razão que já estava no projeto muito
antes de existir rede: **o jogador vive em coordenadas locais do navio**. O convés
é um chão parado, e andar nele não depende de onda, vela nem leme.

### O primeiro teste com gente de verdade, e os quatro defeitos que ele revelou

Tudo acima já estava escrito e passando nos testes quando o duelo foi ao ar pela
primeira vez com duas pessoas. Ele estava injogável, e por quatro motivos que só
aparecem quando existe uma segunda máquina do outro lado do mundo:

| O que se via | O que era |
|---|---|
| O mundo do convidado andando **aos trancos**, a ~15 Hz | O atraso de desenho era de seis passos, e os instantâneos vêm de quatro em quatro: o alvo caía **antes** do mais velho dos dois instantâneos em mão, e a interpolação vivia grampeada no começo. A pose só mudava quando chegava pacote |
| O adversário **atirando sem bala**, sem estrondo e sem fumaça | A lista de eventos é esvaziada pelo desenho a cada quadro, e o instantâneo sai a cada quatro passos — três de cada quatro tiros, respingos e impactos nunca chegavam ao outro lado. E é do evento de tiro que nasce a bala do convidado |
| O marujo **andando mas não obedecendo**, e puxado de volta a cada segundo | O avanço do relógio de comando era calculado com **metade** da ida e volta, quando a conta pede ela inteira: o `hostTick` que se lê já vem meia volta atrasado, e o comando ainda leva a outra meia para chegar. Ele nascia atrasado, era descartado, e a posição prevista se afastava até estourar o limite de correção |
| Tudo isso **pior nos primeiros segundos** | A primeira medição de latência só saía dois segundos depois de conectar, então o duelo começava com ida e volta valendo zero — e um avanço calculado sobre zero é avanço nenhum |

O quinto não chegou a se ver, mas estava lá: o instantâneo era decodificado **por
cima** da base da interpolação antes de o tick ser conferido, então um pacote fora de
ordem destruía essa base para depois ser recusado.

### E a segunda rodada, que só apareceu depois da primeira

Corrigidos os cinco, o duelo voltou ao ar e continuou ruim — **para um dos dois
lados**. O relato foi "tremendo ao andar, não consigo mexer no timão nem no
canhão, e os controles parecem se inverter", com o `F3` mostrando `net guest`,
`starves 0` e `prediction 0.2 cm`. Ou seja: a rede estava saudável e o corpo não
estava sendo corrigido. O que sobrava eram quatro defeitos que a primeira rodada
não podia revelar, porque três deles **foram introduzidos ou expostos por ela**:

| O que se via | O que era |
|---|---|
| Tremor ao andar | O relógio de desenho perseguia `hostTick` com ganho proporcional — e `hostTick` é um **degrau** (parado quatro passos, sobe quatro). Perseguir degrau com ganho dá dente de serra: o mundo avançava 1,00 · 0,90 · 0,81 · 0,75 tick por passo e recomeçava. Velocidade oscilando 25% a 15 Hz. A média está certa, e é por isso que nenhum contador de quadros acusa |
| Toda ação demorando ~370 ms | O avanço do relógio de predição estava em **22 passos** numa conexão que pede 12. `estimateLead` nunca rodava (a guarda era `localTick === 0`, e o relógio já tinha andado dezenas de passos quando o primeiro instantâneo chega), então o valor nascia de fábrica e subia por catraca: subia com fila baixa, só descia com fila alta, e estabilizava numa faixa morta onde nada o trazia de volta |
| Entrar no timão e voltar sozinho | Predição de posto sem reconciliação. Ver a tabela acima |
| **Interagir simplesmente não funcionar** | O olhar viajava só como **delta**. Um pacote perdido leva embora aquele pedaço de giro, e o ângulo dos dois lados nunca mais se encontra. O que quebra não é a cabeça do adversário — é o **foco de interação** dele: o jogador aponta para o canhão e aperta o botão, e do lado que decide o marujo está olhando três metros ao lado, sem foco nenhum. Medido em duelo: yaw 1,571 aqui e −0,420 lá, com a posição batendo na segunda casa |

O último é o mais instrutivo dos nove. Ele não é um erro de cálculo nem de
formato: é a diferença entre transmitir **o que mudou** e transmitir **o que é**,
e ela só cobra quando um pacote se perde. Hoje o olhar vai absoluto ao lado do
delta — quatro bytes a mais por quadro de entrada, e o ângulo passa a ser o mesmo
por construção. O delta continua indo porque é dele que a mira do canhão vive.

### Medindo

`F3` abre um bloco `net` durante um duelo em rede. Os alvos:

| Métrica | Saudável |
|---|---|
| `rtt` / `jitter` | < 120 ms / < 30 ms no mesmo país |
| `queue` | 1 a 3 quadros, estável |
| `starves` | perto de zero |
| `lead` | perto de `rtt ÷ 17` **+ 4**, e **não** grudado em 24 |
| `prediction` | < 5 cm |

O `lead` é o que mais vale olhar quando algo parece lento sem estar travado: ele é
latência de comando pura, e cada passo dele são 17 ms entre a mão e o convés. Um
`lead` de 22 com `rtt` de 127 ms — que foi o que apareceu no primeiro duelo de
verdade — significa 370 ms para o timão responder, e o jogador lê isso como "não
está funcionando", não como "está devagar".

E para testar sem sair da própria máquina, a bancada tem rede ruim de mentira:

```js
__game.setSimulatedLag(150, 40, 3)   // 150 ms, 40 de jitter, 3% de perda
```

> ⚠️ **Use isso.** Latência zero esconde tudo que o netcode existe para resolver:
> o buffer nunca passa fome, a predição nunca erra, a reconciliação nunca roda. Um
> duelo testado só em `localhost` é um duelo não testado.

A latência simulada vale **também para as mensagens de lobby**, e isso não é
detalhe: o `ping` é uma delas, e é dele que sai o `rtt` que decide o avanço
inicial. Enquanto o lobby ficava de fora, a bancada rodava com 150 ms nos quadros
e `rtt 0` no medidor — mentindo exatamente sobre o número que ela deveria ajudar
a testar. A **perda** continua sem se aplicar ao lobby: são seis mensagens por
sessão, nenhuma com reenvio, e descartar uma só trava a entrada na sala.

### Publicar o servidor de sala

```bash
npm run deploy:server        # da raiz, e é o jeito recomendado
```

> ⚠️ **`npx wrangler deploy` na raiz não publica nada** — e essa é a pegadinha
> mais cara deste repositório, porque ela **parece** ter funcionado. A
> configuração do Worker mora em `server/wrangler.jsonc`, e o wrangler só procura
> no diretório atual e nos pais, nunca nos filhos. Da raiz, ele para com *"The
> Cloudflare application detection logic has been run in the root of a workspace
> instead of targeting a specific project"* e **sai sem subir nada**. Quem rodar
> isso no meio de uma sessão de correções fica com o cliente novo no ar e o
> servidor velho embaixo dele — e o sintoma disso não é "o deploy falhou", é o
> jogo recusando toda conexão com *"This game version cannot duel that one"*,
> porque as duas pontas passam a discordar do `PROTOCOL_VERSION`.
>
> O script acima existe justamente para tornar o erro impossível: ele entra no
> workspace certo por conta própria. Se preferir o comando cru, é
> `cd server && npx wrangler deploy` — o `cd` **não** é opcional.

A primeira vez pede autenticação: `npx wrangler login` dentro de `server/` (conta
gratuita, sem cartão). Para conferir o que está de fato no ar a qualquer momento:

```bash
cd server && npx wrangler deployments list   # data e versão de cada publicação
curl https://<seu-worker>.workers.dev/health # deve devolver {"ok":true}
```

Depois, na hospedagem do jogo, defina `VITE_ROOM_SERVER` com o endereço que o
deploy imprimir (trocando `https://` por `wss://`) e **reconstrua** — o Vite
embute a variável no build, então republicar o mesmo artefato mantém o valor
antigo. E ponha o domínio de produção em `ALLOWED_ORIGINS`, no `wrangler.jsonc`:
sem isso, qualquer página da internet abre salas na sua conta.

### Quando não conecta

| Sintoma | O que é | O que fazer |
|---|---|---|
| **"This game version cannot duel that one"** | Cliente e servidor discordam do `PROTOCOL_VERSION`. Quase sempre é o Worker que ficou para trás — ver a pegadinha do `cd server` acima | `npm run deploy:server` e recarregue os dois navegadores sem cache |
| **"No room server at ws://…"** | Não há nada escutando naquele endereço | O segundo terminal está rodando? `curl http://127.0.0.1:8930/health` devolve `{"ok":true}`? |
| `/health` devolve **HTML** | Outro processo tomou a porta | `netstat -ano \| findstr :8930`, encerre o intruso — ou troque a porta em `wrangler.jsonc` **e** no `.env.development` |
| Botão de online apagado | Falta `VITE_ROOM_SERVER` | Local: o `.env.development` existe? Publicado: refaça o build **sem cache** |
| Preso em "Casting off" | Servidor de sala fora do ar | `npm run dev:server` |
| "Room is full" | Já há dois na sala | Abra outra |
| Duelo congela ao trocar de janela | O navegador **congela** a janela de quem hospeda, e com ela a simulação inteira | Deixe as duas visíveis lado a lado. Quem hospeda avisa o outro lado ao sair de foco, e o `F3` do convidado passa a mostrar `HOST IN BACKGROUND` — é a diferença entre "o adversário minimizou" e "a partida quebrou" |
| Câmera não gira no mouse (mas gira no controle) | O ponteiro não está travado | Clique uma vez na tela. Se o aviso **"Click to look around"** não sumir depois do clique, alguma camada de interface está comendo o clique: toda camada que cobre a tela sem ser clicável precisa de um `#ui-root > .classe { pointer-events: none }`, porque a regra genérica de `base.css` ganha delas por especificidade |

---

## 📦 Stack

TypeScript · Three.js · postprocessing · Vite, e Cloudflare Workers com Durable
Objects no servidor de sala. Nenhuma dependência de física, de áudio, de UI ou de
rede: tudo aqui é do projeto.
