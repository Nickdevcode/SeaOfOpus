/**
 * Quando os dois cascos se encostam: abalroamento.
 *
 * Existe porque a alternativa é pior do que parece. Sem contato, os navios se
 * **atravessam** — e não é só feio: some a única consequência de chegar perto, que
 * é o risco. O duelo inteiro se resolveria a dez metros, onde nenhuma carreta
 * consegue apontar, e o jogador descobriria que colar no inimigo é a estratégia
 * ótima do jogo.
 *
 * **Não usa malha, pelo mesmo motivo que `HitDetection` não usa.** O casco é uma
 * função (`ShipDimensions`), então "este ponto está dentro do outro navio" já é uma
 * comparação exata e barata. O teste aqui é o mais simples que resolve: coroas de
 * pontos ao longo do costado de cada navio, testadas contra o volume do outro.
 *
 * **Por que mola-amortecedor e não impulso.** Resolver colisão por impulso exige o
 * instante exato do contato e refazer o passo; com dois corpos de 37 t flutuando em
 * água que já os empurra, o ganho é nenhum. Uma penalidade elástica proporcional à
 * penetração, com atrito viscoso, dá o que o jogo precisa: os cascos se recusam a
 * ocupar o mesmo lugar, rangem um contra o outro e se afastam girando. Aplicada
 * **no ponto de contato**, ela gera o torque sozinha — encostar de proa faz o navio
 * pivotar, e é o que se espera.
 *
 * ## Duas passadas, e por que não uma
 *
 * A força de um contato de penalidade é `k × penetração`, e ela tem de valer **por
 * contato**, não por sondagem: quantas sondagens caem dentro do outro casco é
 * detalhe de amostragem, e a madeira não empurra dez vezes mais forte porque a
 * grade ficou mais fina ali.
 *
 * ⚠️ A versão anterior aplicava a força na hora de encontrá-la e dividia por
 * `SAMPLES_PER_SIDE` — dez, o número de sondagens de **um bordo**, não o número de
 * sondagens que de fato tocaram. Um encontro de esguelha ou de proa põe uma ou duas
 * sondagens dentro do outro casco, e nessas o navio recebia um décimo da força
 * projetada. Era exatamente o caso em que se batia de verdade, e o que se via era
 * uma proa entrando no costado do outro como se ele fosse névoa.
 *
 * Então junta-se tudo primeiro (`gather`) e aplica-se depois (`apply`), dividindo
 * pela contagem real. O resultado é `k × penetração média`, que é o que uma mola de
 * contato deve entregar, e ele deixou de depender de quantos pontos por acidente
 * caíram dentro.
 *
 * A **direção** também é do par, e não da sondagem: ver `chooseExit`, e o
 * cancelamento perfeito que a escolha ponto a ponto produzia num encontro de proa.
 *
 * O que este arquivo promete está escrito como teste em `tests/contact.ts` — os
 * quatro encontros que existem, mais a reação igual e contrária.
 *
 * ## Onde isto roda, e por que antes e não depois
 *
 * `Ship.fixedUpdate` integra no fim dele mesmo, então não há janela entre "somar as
 * forças" e "integrar". A solução é chamar este passo **antes** dos navios: as
 * forças ficam acumuladas em `ShipBody` (que só zera no `integrate`) e entram no
 * passo que está começando. O custo é que a penetração medida é a do passo
 * anterior — 1,6 cm de defasagem a 1 m/s de aproximação, três ordens de grandeza
 * abaixo da precisão que uma força de contato precisa. Trocar isso por uma cirurgia
 * em `Ship` para expor um `integrate` separado seria pagar caro por nada.
 */

import * as THREE from 'three';
import {
  HALF_LENGTH,
  HULL_BEAM,
  HULL_LENGTH,
  halfWidthAtHeight,
  zToT,
} from '../ship/ShipDimensions';
import { insideHull } from './HitDetection';
import type { Ship } from '../ship/Ship';

/**
 * Sondagens por bordo e por altura, distribuídas ao longo do costado.
 *
 * O espaçamento sai em 1,5 m num casco de 16 m, bem menor que a boca de 5 m do
 * outro navio: não existe ângulo de encontro em que os dois se cruzem sem que
 * alguma sondagem caia dentro.
 */
const SAMPLES_PER_SIDE = 10;

/**
 * Alturas das coroas de sondagem, em coordenadas locais.
 *
 * ⚠️ **Eram uma só, na linha d'água de projeto**, e uma coroa plana só encontra o
 * outro casco enquanto os dois estiverem mais ou menos no mesmo plano. Dois navios
 * que se encontram estão jogando: um sobe na crista enquanto o outro desce no
 * cavado, e cada um aderna para o seu lado. Nesses instantes — que são a maioria
 * deles num mar de meio metro — a coroa da linha d'água de um passava **por baixo**
 * do bojo do outro ou **por cima** da amurada, e o contato simplesmente não
 * existia: os cascos se cruzavam e voltavam a se repelir na onda seguinte.
 *
 * Três alturas cobrem o costado inteiro do bojo à amurada: `-0,7` é a barriga do
 * casco (onde o contato acontece quando um está adernado para longe), `0,1` é a
 * linha d'água de projeto (onde acontece com os dois quietos) e `0,9` é o costado
 * seco, logo abaixo do trincaniz (onde acontece quando um aderna *para dentro* do
 * outro). Custa 120 sondagens por passo em vez de 40, e uma sondagem é uma
 * conversão de referencial mais uma comparação de seção.
 */
const PROBE_HEIGHTS = [-0.7, 0.1, 0.9] as const;

/**
 * Rigidez do contato, em newtons por metro de penetração.
 *
 * 6 MN/m. O número sai da energia do encontro, e não do gosto: dois cascos de 37 t
 * (70 t de massa efetiva com a água que arrastam de lado, ~35 t de massa reduzida
 * para o par) fechando a 3 m/s carregam 157 kJ, e uma mola desta rigidez os para
 * com 23 cm de penetração — o casco *deforma* o que a madeira deformaria, e não
 * mais que isso. A metade da velocidade, são 12 cm; a um encontrão de 6 m/s, meio
 * metro, e aí o afastamento é violento como deve ser.
 *
 * **Era 1,4 MN/m**, e com a divisão errada de `apply` (ver o cabeçalho) um contato
 * de proa entregava 140 kN/m efetivos — 2% do que está aqui. Meio metro de proa
 * dentro do costado devolvia 70 kN contra 37 t, ou seja, 1,9 m/s² para desfazer uma
 * aproximação de vários metros por segundo. Não dava.
 *
 * A estabilidade tem folga de sobra: com 35 t de massa reduzida e passo de 1/60 s,
 * `ω·dt` fica em 0,2 contra o limite de 2 do integrador explícito. Daria para subir
 * dez vezes ainda; o que segura o número aqui é o realismo do amassado, não a
 * aritmética.
 */
const STIFFNESS = 6e6;

/**
 * Amortecimento do contato, em N·s/m.
 *
 * Sem ele a colisão é perfeitamente elástica e os navios quicam um no outro como
 * bolas de bilhar, indo e voltando várias vezes. Com ele o encontro é o que se
 * espera de madeira contra madeira: um baque, um rangido, e os dois se separam.
 *
 * 4,5×10⁵ é metade do amortecimento crítico do par (`2√(k·m)` dá 9,2×10⁵). Meio
 * crítico deixa um único repique curto — que é o que se vê e se ouve num casco
 * batendo em outro — em vez do retorno morto que o amortecimento cheio daria.
 */
const DAMPING = 4.5e5;

/**
 * Atrito tangencial, como fração da força normal.
 *
 * É o que faz um casco *raspar* o outro em vez de deslizar no gelo, e o que
 * transfere guinada num abalroamento de esguelha.
 */
const FRICTION = 0.35;

/**
 * Penetração máxima que ainda vira força de mola, em metros.
 *
 * Não é limite de física, é rede de segurança. Um engasgo do host, uma queda de
 * quadro ou um reposicionamento podem entregar a este passo dois cascos já
 * sobrepostos por dois metros; sem grampo, a mola devolveria 12 MN e a chalupa
 * sairia dali a 3 m/s de uma vez, o que na tela lê como catapulta e não como
 * colisão. Com o grampo, ela é empurrada para fora com convicção e em vários
 * passos, que é como um casco encalhado em outro sai mesmo.
 */
const MAX_PUSH_DEPTH = 1;

// --- resolução ---------------------------------------------------------------

/** O que o passo de contato apurou, para o áudio, o estrago e o HUD lerem. */
export interface ContactReport {
  /** Pontos em contato neste passo. Zero é "não estão se tocando". */
  contacts: number;
  /** Maior penetração encontrada, em metros. */
  depth: number;
  /**
   * Maior velocidade de aproximação entre os pontos em contato, em m/s.
   *
   * É ela que separa um roçar de uma pancada — o áudio e a avaria de abalroamento
   * leem daqui. É a **maior** e não a do contato mais fundo, e a diferença
   * aparece justamente no instante que interessa: no primeiro passo de uma
   * pancada a penetração de todos os pontos ainda é milimétrica, e o que já é
   * enorme é a velocidade com que eles se aproximam.
   */
  closingSpeed: number;
  /** Ponto do mundo do contato mais forte, para o som e o rombo. */
  readonly point: THREE.Vector3;
}

export function createContactReport(): ContactReport {
  return { contacts: 0, depth: 0, closingSpeed: 0, point: new THREE.Vector3() };
}

/**
 * Uma sondagem que caiu dentro do outro casco, já medida.
 *
 * Existe porque a força só pode ser calculada depois de se saber **quantos**
 * contatos há — ver o cabeçalho. Guarda o que a segunda passada precisa e nada
 * mais.
 */
interface Penetration {
  /** `true` quando a sondagem é do primeiro casco e o volume é do segundo. */
  fromA: boolean;
  /** Ponto do mundo onde a força será aplicada nos dois corpos. */
  readonly point: THREE.Vector3;
  /** Normal de saída, no mundo. A mesma para todo o par — ver `chooseExit`. */
  readonly normal: THREE.Vector3;
  /** Velocidade relativa dos dois pontos materiais que se encontram ali. */
  readonly relative: THREE.Vector3;
  depth: number;
  /** Componente da velocidade relativa contra a normal. Negativa é separando. */
  approach: number;
}

/**
 * O caderno das sondagens penetrantes, montado uma vez.
 *
 * Duas passadas (cada casco sondando o outro) × dois bordos × sondagens × alturas.
 * Alocado na carga do módulo porque isto roda sessenta vezes por segundo: 120
 * objetos com três vetores cada por passo seriam lixo para o coletor recolher
 * dentro do orçamento do quadro.
 */
const PENETRATIONS: Penetration[] = Array.from(
  { length: 4 * SAMPLES_PER_SIDE * PROBE_HEIGHTS.length },
  () => ({
    fromA: true,
    point: new THREE.Vector3(),
    normal: new THREE.Vector3(),
    relative: new THREE.Vector3(),
    depth: 0,
    approach: 0,
  }),
);

const _originA = new THREE.Vector3();
const _originB = new THREE.Vector3();
const _probeLocal = new THREE.Vector3();
const _probeWorld = new THREE.Vector3();
const _solidLocal = new THREE.Vector3();
const _arm = new THREE.Vector3();
const _velocityProbe = new THREE.Vector3();
const _velocitySolid = new THREE.Vector3();
const _tangent = new THREE.Vector3();
const _force = new THREE.Vector3();
const LOCAL_OUT = new THREE.Vector3();
const _solidOrigin = new THREE.Vector3();
const _probeOrigin = new THREE.Vector3();
const _bearing = new THREE.Vector3();
const _exitNormal = new THREE.Vector3();

/** A saída escolhida para o par em curso. Ver `chooseExit`. */
let _lateralExit = true;
let _exitSign = 1;

/**
 * Resolve o contato entre dois cascos. Chamar **antes** dos `fixedUpdate` deles —
 * ver a nota no topo do arquivo.
 */
export function resolveHullContact(a: Ship, b: Ship, out: ContactReport): ContactReport {
  out.contacts = 0;
  out.depth = 0;
  out.closingSpeed = 0;

  // Descarte por distância: dois cascos de 16 m não se tocam com as origens a mais
  // de um comprimento inteiro de distância.
  a.body.getOrigin(_originA);
  b.body.getOrigin(_originB);
  const reach = HALF_LENGTH * 2 + 1;
  if (_originA.distanceToSquared(_originB) > reach * reach) return out;

  // Os dois sentidos entram na **mesma** contagem: é um contato só, visto de dois
  // lados. Normalizar cada sentido por conta própria daria força dobrada num
  // encontro em que as duas coroas se alcançam.
  let count = gather(a, b, true, 0);
  count = gather(b, a, false, count);
  if (count === 0) return out;

  apply(a, b, count, out);
  return out;
}

/**
 * Anota as sondagens de `probe` que caíram dentro do volume de `solid`.
 *
 * @param start onde continuar escrevendo no caderno.
 * @returns o novo fim do caderno.
 */
function gather(probe: Ship, solid: Ship, fromA: boolean, start: number): number {
  let count = start;
  chooseExit(probe, solid);

  for (const height of PROBE_HEIGHTS) {
    for (const side of [-1, 1]) {
      for (let i = 0; i < SAMPLES_PER_SIDE; i++) {
        // ⚠️ **De ponta a ponta, e antes eram só os 94% centrais amostrados pelo
        // meio.** Com dez amostras no meio de cada faixa, a sondagem mais avançada
        // caía a 1,23 m da roda de proa — e uma proa só encontrava o outro casco
        // depois de entrar nele **dois metros e meio**, que é o momento em que a
        // sondagem finalmente alcança uma seção do outro navio mais cheia que a
        // dela. Era exatamente a queixa de "um barco entra dentro do outro", e ela
        // não era da força: era de não haver o que medir.
        //
        // Amostrando as pontas, a sondagem mais avançada fica a 8 cm do talha-mar e
        // o contato de proa começa com uns 16 cm de sobreposição. Chegar à ponta
        // exata é seguro por causa do descarte de meia-boca logo abaixo.
        const t = SAMPLES_PER_SIDE > 1 ? i / (SAMPLES_PER_SIDE - 1) : 0.5;
        const z = (t * 2 - 1) * HALF_LENGTH * 0.99;
        const half = halfWidthAtHeight(zToT(z), height);
        // Aquela altura não tem costado nesta estação: perto das pontas a quilha
        // sobe, e a coroa de baixo passa por fora do casco. Sondar dali mediria a
        // penetração de um ponto que não é do navio.
        if (half <= 1e-3) continue;

        _probeLocal.set(side * half, height, z);
        probe.body.localToWorld(_probeLocal, _probeWorld);
        solid.body.worldToLocal(_probeWorld, _solidLocal);
        if (!insideHull(_solidLocal)) continue;

        // Caderno cheio: só num encontro de costado inteiro, e aí as sondagens que
        // faltam descrevem o mesmo contato que as 120 já anotadas.
        if (count >= PENETRATIONS.length) return count;
        if (measure(probe, solid, fromA, PENETRATIONS[count]!)) count++;
      }
    }
  }

  return count;
}

/**
 * Escolhe por onde o casco de `solid` vai expulsar o de `probe`, **uma vez para o
 * par**, e não uma vez por sondagem.
 *
 * ## Por que a decisão é do par
 *
 * A saída de um contato de penalidade é para a face mais próxima, e a primeira
 * versão a escolhia ponto a ponto: cada sondagem comparava a distância até o
 * costado com a distância até a ponta e ia pela menor. É o certo para um ponto
 * isolado, e é catastrófico para um casco.
 *
 * ⚠️ **Duas proas de frente cancelavam a força inteira.** A roda de proa é
 * simétrica, então as sondagens de bombordo e de boreste entram no outro casco em
 * espelho: uma fica mais perto do costado de bombordo dele, a outra do de boreste, e
 * as duas empurram em sentidos opostos com o mesmo módulo. Soma zero — medido: oito
 * contatos, 36 cm de penetração e **0,0 m/s² de empurrão**. As duas chalupas se
 * atravessavam com o passo de contato rodando e achando contato.
 *
 * A saída não é geometria de ponto, é geometria de par: **o casco empurra na direção
 * de onde o outro vem**. A marcação relativa dos dois centros diz isso, é a mesma
 * para todas as sondagens (então nada se cancela) e muda devagar (então nada
 * oscila). Comparada em coordenadas normalizadas pelas dimensões do casco, ela
 * separa os três encontros que existem:
 *
 * | o outro está | a saída é | e é o certo porque |
 * |---|---|---|
 * | pelo través | pelo costado | é o bordo que está sendo amassado |
 * | pela proa ou pela popa | pela ponta | é o talha-mar ou o painel de popa |
 * | pela alheta, misturado | pelo costado | é o que a amurada do través resolve |
 *
 * O sinal também vem da marcação, e não do ponto: uma sondagem que passou do meio
 * do outro casco tem de sair pelo lado por onde **entrou**, e não pelo mais próximo
 * dela agora.
 *
 * Nenhuma das duas saídas é vertical, de propósito: incluir a componente vertical do
 * bojo transformaria um contato de costado em empurrão para cima, e o que se veria é
 * um navio escalando o outro.
 */
function chooseExit(probe: Ship, solid: Ship): void {
  solid.body.getOrigin(_solidOrigin);
  probe.body.getOrigin(_probeOrigin);
  _bearing.subVectors(_probeOrigin, _solidOrigin);
  solid.body.worldDirToLocal(_bearing, _bearing);

  // Normalizado pelas dimensões: 3 m de través num casco de 5 m de boca é muito mais
  // "pelo lado" do que 3 m de proa num casco de 16 m de comprimento.
  _lateralExit = Math.abs(_bearing.x) / HULL_BEAM >= Math.abs(_bearing.z) / HULL_LENGTH;
  _exitSign = (_lateralExit ? _bearing.x : _bearing.z) >= 0 ? 1 : -1;

  LOCAL_OUT.set(_lateralExit ? _exitSign : 0, 0, _lateralExit ? 0 : _exitSign);
  solid.body.localDirToWorld(LOCAL_OUT, _exitNormal);
}

/**
 * Mede a sondagem já posta em `_probeWorld` / `_solidLocal`, na saída que
 * `chooseExit` decidiu para este par.
 *
 * A profundidade é o quanto falta andar naquela direção para sair do casco:
 * `meia boca − s·x` pelo costado, `meia eslora − s·z` pela ponta. Escrito com o
 * sinal em vez de módulo, ele continua certo para a sondagem que já passou do meio
 * do outro casco — ali a saída é longa, e é longa mesmo.
 *
 * @returns `false` quando a conta não devolve penetração (borda numérica).
 */
function measure(probe: Ship, solid: Ship, fromA: boolean, into: Penetration): boolean {
  const depth = _lateralExit
    ? halfWidthAtHeight(zToT(_solidLocal.z), _solidLocal.y) - _exitSign * _solidLocal.x
    : HALF_LENGTH - _exitSign * _solidLocal.z;
  if (depth <= 0) return false;

  into.depth = depth;
  into.normal.copy(_exitNormal);

  _arm.subVectors(_probeWorld, probe.body.comPosition);
  probe.body.pointVelocity(_arm, _velocityProbe);
  _arm.subVectors(_probeWorld, solid.body.comPosition);
  solid.body.pointVelocity(_arm, _velocitySolid);
  into.relative.subVectors(_velocityProbe, _velocitySolid);

  into.approach = -into.relative.dot(into.normal);
  into.point.copy(_probeWorld);
  into.fromA = fromA;
  return true;
}

/** Aplica as sondagens anotadas, divididas pela contagem real. Ver o cabeçalho. */
function apply(a: Ship, b: Ship, count: number, out: ContactReport): void {
  // O contato mais forte manda no relatório. `-Infinity` garante que o primeiro
  // sempre escreva o ponto, mesmo num rangido em que ninguém se aproxima.
  let hardest = Number.NEGATIVE_INFINITY;

  for (let i = 0; i < count; i++) {
    const contact = PENETRATIONS[i]!;
    const probe = contact.fromA ? a : b;
    const solid = contact.fromA ? b : a;

    // Mola na penetração, mais amortecedor na aproximação. O amortecedor só age
    // enquanto os dois se apertam: segurá-los quando já estão se separando seria
    // madeira que cola, e o contato viraria imã.
    let magnitude = STIFFNESS * Math.min(contact.depth, MAX_PUSH_DEPTH);
    if (contact.approach > 0) magnitude += DAMPING * contact.approach;
    magnitude /= count;
    if (magnitude <= 0) continue;

    _force.copy(contact.normal).multiplyScalar(magnitude);

    // Atrito de Coulomb: opõe-se ao escorregamento tangencial, limitado pela normal.
    _tangent
      .copy(contact.relative)
      .addScaledVector(contact.normal, -contact.relative.dot(contact.normal));
    const slide = _tangent.length();
    if (slide > 1e-3) {
      _tangent.multiplyScalar(
        -Math.min(FRICTION * magnitude, (DAMPING / count) * slide) / slide,
      );
      _force.add(_tangent);
    }

    probe.body.applyForceAtPoint(_force, contact.point);
    // Terceira lei: o sólido leva a recíproca, no mesmo ponto.
    solid.body.applyForceAtPoint(_force.negate(), contact.point);

    out.contacts++;
    if (contact.depth > out.depth) out.depth = contact.depth;
    if (contact.approach > hardest) {
      hardest = contact.approach;
      out.closingSpeed = Math.max(contact.approach, 0);
      out.point.copy(contact.point);
    }
  }
}
