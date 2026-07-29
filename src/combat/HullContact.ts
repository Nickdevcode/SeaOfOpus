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
 * comparação exata e barata. O teste aqui é o mais simples que resolve: uma coroa
 * de pontos na linha d'água de cada navio, testada contra o volume do outro.
 *
 * **Por que mola-amortecedor e não impulso.** Resolver colisão por impulso exige o
 * instante exato do contato e refazer o passo; com dois corpos de 37 t flutuando em
 * água que já os empurra, o ganho é nenhum. Uma penalidade elástica proporcional à
 * penetração, com atrito viscoso, dá o que o jogo precisa: os cascos se recusam a
 * ocupar o mesmo lugar, rangem um contra o outro e se afastam girando. Aplicada
 * **no ponto de contato**, ela gera o torque sozinha — encostar de proa faz o navio
 * pivotar, e é o que se espera.
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
import { HALF_LENGTH } from '../ship/ShipDimensions';
import { insideHull } from './HitDetection';
import type { Ship } from '../ship/Ship';

/**
 * Sondagens por bordo, distribuídas ao longo do costado.
 *
 * O espaçamento sai em 1,5 m num casco de 16 m, bem menor que a boca de 5 m do
 * outro navio: não existe ângulo de encontro em que os dois se cruzem sem que
 * alguma sondagem caia dentro.
 */
const SAMPLES_PER_SIDE = 10;

/**
 * Altura das sondagens, em coordenadas locais.
 *
 * Na linha d'água de projeto, que é onde os cascos de fato se tocam. Testar na
 * amurada deixaria as proas se cruzarem por baixo; testar na quilha ignoraria o
 * contato de costado, que é o comum.
 */
const PROBE_Y = 0.1;

/**
 * Rigidez do contato, em newtons por metro de penetração.
 *
 * 1,4 MN/m. Meio metro de penetração devolve 700 kN, ~2 g num casco de 37 t: o
 * navio é expulso em fração de segundo. A estabilidade manda o teto — com 37 t e
 * passo de 1/60 s, o limite do integrador explícito fica na casa de alguns MN/m, e
 * ficar uma boa margem abaixo é o que impede o contato de virar catapulta.
 */
const STIFFNESS = 1.4e6;

/**
 * Amortecimento do contato, em N·s/m.
 *
 * Sem ele a colisão é perfeitamente elástica e os navios quicam um no outro como
 * bolas de bilhar, indo e voltando várias vezes. Com ele o encontro é o que se
 * espera de madeira contra madeira: um baque, um rangido, e os dois se separam.
 */
const DAMPING = 2.2e5;

/**
 * Atrito tangencial, como fração da força normal.
 *
 * É o que faz um casco *raspar* o outro em vez de deslizar no gelo, e o que
 * transfere guinada num abalroamento de esguelha.
 */
const FRICTION = 0.35;

// --- tabela de meia-boca -----------------------------------------------------

/**
 * Meia-boca do casco na linha d'água, tabelada.
 *
 * A mola precisa de *quanto* dentro o ponto está, e `insideHull` só responde
 * "dentro ou fora". Achar a borda por bisseção a cada sondagem custaria umas
 * quatrocentas avaliações de seção por passo, para medir um casco que **não muda**.
 * Então mede-se uma vez, na carga do módulo, e interpola-se.
 *
 * 128 estações dão 12,5 cm de resolução em Z. A meia-boca varia devagar em quase
 * todo o comprimento e só afila rápido nas pontas, onde a interpolação linear erra
 * no máximo alguns milímetros — irrelevante para uma força de contato.
 */
const BEAM_SAMPLES = 128;
const BEAM_TABLE = buildBeamTable();

function buildBeamTable(): Float32Array {
  const table = new Float32Array(BEAM_SAMPLES + 1);
  const probe = new THREE.Vector3();

  for (let i = 0; i <= BEAM_SAMPLES; i++) {
    const z = (i / BEAM_SAMPLES) * 2 * HALF_LENGTH - HALF_LENGTH;

    probe.set(0, PROBE_Y, z);
    if (!insideHull(probe)) {
      table[i] = 0;
      continue;
    }

    let low = 0;
    let high = 3.2;
    for (let k = 0; k < 14; k++) {
      const mid = (low + high) * 0.5;
      probe.set(mid, PROBE_Y, z);
      if (insideHull(probe)) low = mid;
      else high = mid;
    }
    table[i] = low;
  }

  return table;
}

/** Meia-boca interpolada num `z` local. Zero fora do casco. */
function halfBeamAt(z: number): number {
  const position = ((z + HALF_LENGTH) / (2 * HALF_LENGTH)) * BEAM_SAMPLES;
  if (position <= 0 || position >= BEAM_SAMPLES) return 0;

  const index = Math.floor(position);
  const fraction = position - index;
  const a = BEAM_TABLE[index]!;
  return a + (BEAM_TABLE[index + 1]! - a) * fraction;
}

// --- resolução ---------------------------------------------------------------

/** O que o passo de contato apurou, para o áudio e o HUD lerem. */
export interface ContactReport {
  /** Pontos em contato neste passo. Zero é "não estão se tocando". */
  contacts: number;
  /** Maior penetração encontrada, em metros. */
  depth: number;
  /**
   * Velocidade de aproximação no contato mais fundo, em m/s. É ela que separa um
   * roçar de uma pancada — o áudio lê daqui.
   */
  closingSpeed: number;
  /** Ponto do mundo do contato mais fundo, para posicionar o som. */
  readonly point: THREE.Vector3;
}

export function createContactReport(): ContactReport {
  return { contacts: 0, depth: 0, closingSpeed: 0, point: new THREE.Vector3() };
}

const _originA = new THREE.Vector3();
const _originB = new THREE.Vector3();
const _probeLocal = new THREE.Vector3();
const _probeWorld = new THREE.Vector3();
const _solidLocal = new THREE.Vector3();
const _normal = new THREE.Vector3();
const _arm = new THREE.Vector3();
const _velocityProbe = new THREE.Vector3();
const _velocitySolid = new THREE.Vector3();
const _relative = new THREE.Vector3();
const _tangent = new THREE.Vector3();
const _force = new THREE.Vector3();
const LOCAL_OUT = new THREE.Vector3();

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

  probeInto(a, b, out);
  probeInto(b, a, out);
  return out;
}

/** Testa a coroa de sondagens de `probe` contra o volume de `solid`. */
function probeInto(probe: Ship, solid: Ship, out: ContactReport): void {
  for (const side of [-1, 1]) {
    for (let i = 0; i < SAMPLES_PER_SIDE; i++) {
      // Distribuídas no comprimento útil, sem chegar às pontas exatas, onde a
      // meia-boca é zero e a sondagem cairia fora do próprio casco.
      const t = (i + 0.5) / SAMPLES_PER_SIDE;
      const z = (t * 2 - 1) * HALF_LENGTH * 0.94;
      _probeLocal.set(side * halfBeamAt(z), PROBE_Y, z);

      probe.body.localToWorld(_probeLocal, _probeWorld);
      solid.body.worldToLocal(_probeWorld, _solidLocal);
      if (!insideHull(_solidLocal)) continue;

      applyContact(probe, solid, out);
    }
  }
}

/**
 * Uma penalidade de contato para a sondagem já posta em `_probeWorld` /
 * `_solidLocal`.
 *
 * A profundidade é medida **na horizontal, para fora do costado do sólido**: é a
 * direção em que a madeira empurra. Usar a normal completa da superfície incluiria
 * a componente vertical do bojo, e um contato de costado viraria empurrão para
 * cima — um navio escalando o outro.
 */
function applyContact(probe: Ship, solid: Ship, out: ContactReport): void {
  const half = halfBeamAt(_solidLocal.z);
  if (half <= 1e-4) return;

  const depth = half - Math.abs(_solidLocal.x);
  if (depth <= 0) return;

  // Normal para fora do costado do sólido: no referencial dele é ±X puro.
  LOCAL_OUT.set(_solidLocal.x >= 0 ? 1 : -1, 0, 0);
  solid.body.localDirToWorld(LOCAL_OUT, _normal);

  // Velocidade relativa dos dois pontos materiais que se encontram ali.
  _arm.subVectors(_probeWorld, probe.body.comPosition);
  probe.body.pointVelocity(_arm, _velocityProbe);
  _arm.subVectors(_probeWorld, solid.body.comPosition);
  solid.body.pointVelocity(_arm, _velocitySolid);
  _relative.subVectors(_velocityProbe, _velocitySolid);

  const approach = -_relative.dot(_normal);

  // Mola na penetração, mais amortecedor na aproximação. O amortecedor só age
  // enquanto os dois se apertam: segurá-los quando já estão se separando seria
  // madeira que cola, e o contato viraria imã.
  let magnitude = STIFFNESS * depth;
  if (approach > 0) magnitude += DAMPING * approach;

  // Dividido pelas sondagens de um bordo: com dez pontos encostados a força total
  // é a de um contato, não dez vezes ela. Sem isto a rigidez efetiva dependeria de
  // quantos pontos por acidente caíram dentro.
  magnitude /= SAMPLES_PER_SIDE;
  if (magnitude <= 0) return;

  _force.copy(_normal).multiplyScalar(magnitude);

  // Atrito de Coulomb: opõe-se ao escorregamento tangencial, limitado pela normal.
  _tangent.copy(_relative).addScaledVector(_normal, -_relative.dot(_normal));
  const slide = _tangent.length();
  if (slide > 1e-3) {
    _tangent.multiplyScalar(-Math.min(FRICTION * magnitude, (DAMPING / SAMPLES_PER_SIDE) * slide) / slide);
    _force.add(_tangent);
  }

  probe.body.applyForceAtPoint(_force, _probeWorld);
  // Terceira lei: o sólido leva a recíproca, no mesmo ponto.
  solid.body.applyForceAtPoint(_force.negate(), _probeWorld);

  out.contacts++;
  if (depth > out.depth) {
    out.depth = depth;
    out.closingSpeed = Math.max(approach, 0);
    out.point.copy(_probeWorld);
  }
}
