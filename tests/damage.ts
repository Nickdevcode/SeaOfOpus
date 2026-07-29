/**
 * Testes do modelo de avaria — a propriedade que faltava e ninguém viu por meses.
 *
 * Rodável no navegador, como os outros:
 *
 * ```js
 * const t = await import('/tests/damage.ts');
 * console.table(t.runDamageTests().cases);
 * ```
 *
 * **O que se prova aqui, e por que vale um arquivo.** O modelo de alagamento não
 * tem "resposta certa" para comparar — vazão de rombo em casco de madeira é um
 * número afinado, não um teorema. O que ele *tem* é uma propriedade estrutural que
 * qualquer jogo de combate precisa respeitar e que este aqui violava:
 *
 * > **Um acerto vale um acerto, caia onde cair.**
 *
 * A violação era discreta e vinha de duas regras razoáveis que se somavam mal. Um
 * tiro perto de um rombo aberto *alargava* aquele rombo em vez de abrir outro (com
 * um raio de 90 cm, três vezes e meia o vão que a bala faz), e a vazão de cada rombo
 * era limitada por um teto **fixo**, igual para um furo pequeno e para um do dobro
 * do tamanho. Juntas, elas diziam que alargar não vale nada — e, portanto, que
 * agrupar os tiros é desperdício.
 *
 * Medido: oito acertos num palmo do costado punham 10% de água no porão; os mesmos
 * oito varridos ao longo do casco **afundavam o navio**. Quem mirava melhor causava
 * dez vezes menos dano, e a IA — que varre por doutrina — jogava no lado bom daquela
 * curva enquanto o jogador jogava no lado ruim, sem ter como saber que a curva
 * existia.
 *
 * Os três casos abaixo prendem o conserto: a fusão sai do vão real do rombo, a vazão
 * é linear na área **inclusive depois da saturação**, e a razão entre fogo agrupado
 * e fogo varrido fica acima de um piso. Nenhum deles precisa de navio, de oceano nem
 * de canvas — só da geometria e da conta.
 */

import * as THREE from 'three';
import {
  MERGE_DISTANCE,
  ShipDamage,
  breachInflow,
} from '../src/ship/ShipDamage';

export interface TestCase {
  nome: string;
  medido: string;
  esperado: string;
  erro: string;
  passou: boolean;
}

export interface TestReport {
  passou: boolean;
  total: number;
  falhas: number;
  cases: TestCase[];
}

/** Área de um rombo recém-aberto, lida do próprio modelo em vez de copiada. */
function baseArea(): number {
  const damage = new ShipDamage();
  const breach = hit(damage, 0);
  return breach?.area ?? 0;
}

/** Abre (ou alarga) um rombo na linha d'água, na estação `z`. */
function hit(damage: ShipDamage, z: number) {
  return damage.registerHit({
    fraction: 0,
    local: new THREE.Vector3(1.9, 0.05, z),
    normal: new THREE.Vector3(1, 0, 0),
    part: 'hull',
    floods: true,
  });
}

/** Área total de entrada de água do casco, em m². */
function openArea(damage: ShipDamage): number {
  let total = 0;
  for (const breach of damage.breaches) total += breach.area;
  return total;
}

/** Gaussiana padrão, para simular a dispersão de quem mira um ponto e erra. */
function gaussian(random: () => number): number {
  let u = 0;
  let v = 0;
  while (u === 0) u = random();
  while (v === 0) v = random();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

function createRandom(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function runDamageTests(): TestReport {
  const cases: TestCase[] = [];
  const AREA = baseArea();

  function check(nome: string, medido: number, esperado: number, tolerancia: number, unidade: string): void {
    const erro = medido - esperado;
    cases.push({
      nome,
      medido: `${medido.toFixed(3)} ${unidade}`,
      esperado: `${esperado.toFixed(3)} ${unidade}`,
      erro: `${erro >= 0 ? '+' : ''}${erro.toFixed(3)} ${unidade} (tol. ±${tolerancia} ${unidade})`,
      passou: Math.abs(erro) <= tolerancia,
    });
  }

  // --- 1. a fusão cabe no vão do rombo ----------------------------------------
  // O vão que uma bala abre é um círculo da área base. Fundir tiros muito além
  // desse diâmetro é dizer que madeira sã entre dois furos não existe — e é o que
  // transformava precisão em punição. O teto de dois diâmetros é generoso de
  // propósito: cobre a madeira trincada em volta sem virar de novo o raio de 90 cm
  // que este teste veio impedir de voltar.
  const vao = 2 * Math.sqrt(AREA / Math.PI);
  cases.push({
    nome: 'fusão · cabe em dois vãos de rombo',
    medido: `${MERGE_DISTANCE.toFixed(3)} m (vão ${vao.toFixed(3)} m)`,
    esperado: `≤ ${(vao * 2).toFixed(3)} m`,
    erro: MERGE_DISTANCE <= vao * 2 ? '—' : `${(MERGE_DISTANCE / vao).toFixed(1)} vãos`,
    passou: MERGE_DISTANCE <= vao * 2,
  });

  // E ela precisa de fato fundir o que está perto e separar o que está longe,
  // senão o número acima seria decoração.
  const perto = new ShipDamage();
  hit(perto, 0);
  hit(perto, MERGE_DISTANCE * 0.5);
  const longe = new ShipDamage();
  hit(longe, 0);
  hit(longe, MERGE_DISTANCE * 1.5);
  cases.push({
    nome: 'fusão · perto vira um rombo, longe vira dois',
    medido: `perto ${perto.breaches.length} · longe ${longe.breaches.length}`,
    esperado: 'perto 1 · longe 2',
    erro: perto.breaches.length === 1 && longe.breaches.length === 2 ? '—' : 'fusão fora do raio',
    passou: perto.breaches.length === 1 && longe.breaches.length === 2,
  });

  // --- 2. a vazão é linear na área, inclusive saturada -------------------------
  // **É este caso que pega a volta do teto fixo.** Com um teto em m³/s por rombo,
  // dobrar a área de um furo bem submerso não muda nada — e é isso que fazia
  // agrupar os tiros valer um décimo de varrê-los. Raso (a veia ainda obedece
  // Torricelli) e fundo (a veia já saturou) têm de escalar igual.
  for (const [rotulo, profundidade] of [['raso', 0.2], ['fundo', 3]] as const) {
    const simples = breachInflow(AREA, profundidade);
    const dobro = breachInflow(AREA * 2, profundidade);
    check(`vazão · dobrar a área dobra a vazão (${rotulo})`, dobro / simples, 2, 0.001, '×');
  }

  // A saturação continua existindo — ela é o que impede o último segundo do
  // naufrágio de virar um degrau. Sem este caso, "linear na área" seria satisfeito
  // por remover o teto, que é o defeito oposto.
  const fundo = breachInflow(AREA, 3);
  const abissal = breachInflow(AREA, 12);
  check('vazão · a veia satura com a profundidade', abissal / fundo, 1, 0.001, '×');

  // --- 3. mirar bem não pode custar caro --------------------------------------
  // O teste de ponta a ponta da propriedade do topo. Doze acertos, duas formas de
  // distribuí-los, e a área de entrada de água que sai de cada uma. Agrupado
  // *pode* render menos — dois tiros no mesmo palmo realmente se sobrepõem —, mas
  // não pode render uma fração.
  //
  // O piso é 60%: com os números de hoje a razão dá ~0,88, e o valor antigo dava
  // 0,24. Qualquer coisa abaixo de 60% significa que o modelo voltou a punir quem
  // acerta, que é a única coisa que este arquivo existe para impedir.
  const PISO = 0.6;
  const REPS = 120;
  let somaAgrupada = 0;
  let somaVarrida = 0;

  for (let r = 0; r < REPS; r++) {
    const random = createRandom(0xda3a6e + r * 7919);
    const agrupada = new ShipDamage();
    const varrida = new ShipDamage();

    for (let i = 0; i < 12; i++) {
      // Agrupada: mira o meio-navio e erra 1 m. Varrida: o costado inteiro.
      hit(agrupada, Math.max(-7, Math.min(7, gaussian(random) * 1)));
      hit(varrida, (random() * 2 - 1) * 6);
    }

    somaAgrupada += openArea(agrupada);
    somaVarrida += openArea(varrida);
  }

  const razao = somaAgrupada / somaVarrida;
  cases.push({
    nome: 'salva · fogo agrupado rende perto do varrido',
    medido: `${(razao * 100).toFixed(0)}% da área`,
    esperado: `≥ ${(PISO * 100).toFixed(0)}%`,
    erro: razao >= PISO ? '—' : `${((PISO - razao) * 100).toFixed(0)} pontos abaixo do piso`,
    passou: razao >= PISO,
  });

  const falhas = cases.filter((c) => !c.passou).length;
  return { passou: falhas === 0, total: cases.length, falhas, cases };
}
