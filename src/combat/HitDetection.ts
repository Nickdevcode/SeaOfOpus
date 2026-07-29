/**
 * Onde a bala bate: teste de segmento contra o casco e contra o mastro.
 *
 * **Não usa a malha.** O casco visual tem dezenas de milhares de triângulos e um
 * BVH sobre ele custaria mais memória e mais código do que a solução real, que já
 * está pronta: o casco *é* uma função. `ShipDimensions` sabe dizer a meia largura
 * em qualquer (estação, altura), então "este ponto está dentro do casco" é uma
 * comparação, e achar onde o segmento entrou é uma bisseção. Custa quase nada e é
 * exato até o milímetro — e, o que importa mais, é a **mesma** descrição que
 * gerou a malha, então o tiro nunca acerta o ar ao lado de uma tábua.
 *
 * O teste roda em coordenadas locais do navio. Isso resolve de graça o problema
 * de o alvo estar jogando nas ondas: não há intersecção com corpo em movimento
 * para resolver, o navio está sempre parado no próprio referencial.
 *
 * A marcha é grosseira (20 cm) porque o casco é um **volume** de 5 m de boca, e
 * não uma casca fina: qualquer tiro que entre nele fica dentro por vários passos.
 * O único caso que escapa é a raspada tangente na amurada, que nem devia contar
 * como acerto.
 */

import * as THREE from 'three';
import { clamp01 } from '../core/MathUtils';
import type { ShipBody } from '../ship/ShipBody';
import {
  DECK_Y,
  HALF_LENGTH,
  sampleSection,
  sectionHalfWidth,
  sectionV,
  hullSurfaceNormal,
  zToT,
  type HullSection,
} from '../ship/ShipDimensions';
import { MAST_BASE_Y, MAST_TOP_Y, MAST_Z, mastRadius } from '../ship/ShipParts';

/** Passo da marcha ao procurar a entrada, em metros. */
const MARCH_STEP = 0.2;
/** Voltas de bisseção depois de achar o passo que entrou (~0,8 mm). */
const REFINE_STEPS = 8;

/** Meia boca máxima do casco, para o descarte rápido. */
const HULL_HALF_BEAM = 2.6;
/** Fundo da quilha, para o mesmo descarte. O teto é o topo do mastro. */
const HULL_BOTTOM = -1.7;

export type HitPart = 'hull' | 'mast';

export interface ShipHit {
  /** Onde no segmento bateu, 0..1 — o projétil para exatamente aqui. */
  fraction: number;
  /** Ponto do impacto, em coordenadas locais do navio. */
  readonly local: THREE.Vector3;
  /** Normal externa da superfície ali, também local. */
  readonly normal: THREE.Vector3;
  part: HitPart;
  /**
   * `true` quando o rombo fica **abaixo do convés**, onde a água entra.
   *
   * É a linha que separa um tiro que afunda o navio de um tiro que só arranca
   * lascas da amurada — e é a mesma regra do Sea of Thieves, onde só o que entra
   * no porão alaga.
   */
  floods: boolean;
}

const _localFrom = new THREE.Vector3();
const _localTo = new THREE.Vector3();
const _probe = new THREE.Vector3();
const _section: HullSection = { halfBeam: 0, keelY: 0, sheerY: 0, fullness: 1 };

/** Verdadeiro quando o ponto local está dentro do volume do casco. */
export function insideHull(local: THREE.Vector3): boolean {
  if (Math.abs(local.z) > HALF_LENGTH) return false;
  sampleSection(zToT(local.z), _section);
  if (local.y <= _section.keelY || local.y >= _section.sheerY) return false;
  return Math.abs(local.x) < sectionHalfWidth(_section, sectionV(_section, local.y));
}

/**
 * Testa um segmento do mundo contra um navio.
 *
 * @param out preenchido só quando devolve `true`; o chamador é dono dele.
 * @returns `true` se o segmento encosta no navio.
 */
export function raycastShip(
  body: ShipBody,
  worldFrom: THREE.Vector3,
  worldTo: THREE.Vector3,
  out: ShipHit,
): boolean {
  body.worldToLocal(worldFrom, _localFrom);
  body.worldToLocal(worldTo, _localTo);

  // Descarte rápido pela caixa envolvente do navio inteiro (casco + mastro).
  if (!segmentTouchesBox(_localFrom, _localTo)) return false;

  const hull = marchHull(out);
  const mast = marchMast(hull ? out.fraction : 1);

  // O mastro sobrescreve só se estiver mais perto — `marchMast` já recebeu a
  // fração do casco como teto, então quando devolve algo é porque venceu.
  if (mast >= 0) {
    out.fraction = mast;
    out.local.copy(_mastPoint);
    out.normal.copy(_mastNormal);
    out.part = 'mast';
    out.floods = false;
    return true;
  }

  return hull;
}

/**
 * Caixa envolvente frouxa em coordenadas locais, testada por slabs.
 *
 * Frouxa de propósito: ela existe para descartar os 99% de balas que passam
 * longe, não para ser justa. Uma caixa apertada custaria mais para montar do que
 * economiza.
 */
function segmentTouchesBox(from: THREE.Vector3, to: THREE.Vector3): boolean {
  return (
    slabOverlap(from.x, to.x, -HULL_HALF_BEAM, HULL_HALF_BEAM) &&
    slabOverlap(from.y, to.y, HULL_BOTTOM, MAST_TOP_Y) &&
    slabOverlap(from.z, to.z, -HALF_LENGTH, HALF_LENGTH)
  );
}

function slabOverlap(a: number, b: number, min: number, max: number): boolean {
  return Math.min(a, b) <= max && Math.max(a, b) >= min;
}

/** Procura a entrada no casco marchando e depois refinando. */
function marchHull(out: ShipHit): boolean {
  const length = _probe.subVectors(_localTo, _localFrom).length();
  if (length < 1e-6) return false;

  const steps = Math.max(Math.ceil(length / MARCH_STEP), 1);

  for (let i = 1; i <= steps; i++) {
    const s = i / steps;
    _probe.lerpVectors(_localFrom, _localTo, s);
    if (!insideHull(_probe)) continue;

    // Achou o passo que entrou; a superfície está entre ele e o anterior.
    let low = (i - 1) / steps;
    let high = s;
    for (let k = 0; k < REFINE_STEPS; k++) {
      const mid = (low + high) * 0.5;
      _probe.lerpVectors(_localFrom, _localTo, mid);
      if (insideHull(_probe)) high = mid;
      else low = mid;
    }

    out.fraction = high;
    out.local.lerpVectors(_localFrom, _localTo, high);
    hullNormalAt(out.local, out.normal);
    out.part = 'hull';
    out.floods = out.local.y < DECK_Y;
    return true;
  }

  return false;
}

/**
 * Normal externa do casco no ponto de impacto.
 *
 * `hullSurfaceNormal` quer (t, v, bordo), então o ponto é convertido de volta
 * para os parâmetros da superfície. Sai um pouco fora quando o impacto é raso na
 * amurada — o `v` ali passa do 1 e é grampeado —, e não faz diferença: a normal
 * só orienta a decalagem do rombo e a direção das lascas.
 */
function hullNormalAt(local: THREE.Vector3, target: THREE.Vector3): THREE.Vector3 {
  const t = zToT(local.z);
  sampleSection(t, _section);
  const v = clamp01(sectionV(_section, local.y));
  return hullSurfaceNormal(t, v, local.x >= 0 ? 1 : -1, target);
}

const _mastFrom = new THREE.Vector2();
const _mastDir = new THREE.Vector2();
// O resultado do mastro fica em rascunho próprio: escrever direto no `out`
// estragaria o acerto de casco já encontrado quando o teste do mastro falha.
const _mastPoint = new THREE.Vector3();
const _mastNormal = new THREE.Vector3();

/**
 * Segmento contra o mastro, tratado como cilindro reto de raio médio.
 *
 * O mastro é cônico (24 cm na base, 11 cm no topo), mas resolver cone é conta
 * de segundo grau com coeficientes variáveis para ganhar 6 cm de precisão numa
 * peça que a bala destrói do mesmo jeito. Cilindro de raio médio, com o raio
 * lido na altura do impacto para a checagem final.
 *
 * @param ceiling fração além da qual não interessa — o casco já ganhou.
 * @returns a fração do impacto, ou −1 quando não bate.
 */
function marchMast(ceiling: number): number {
  _mastFrom.set(_localFrom.x, _localFrom.z - MAST_Z);
  _mastDir.set(_localTo.x - _localFrom.x, _localTo.z - _localFrom.z);

  const a = _mastDir.lengthSq();
  if (a < 1e-9) return -1;

  const radius = mastRadius((MAST_BASE_Y + MAST_TOP_Y) * 0.5);
  const b = 2 * _mastFrom.dot(_mastDir);
  const c = _mastFrom.lengthSq() - radius * radius;

  const discriminant = b * b - 4 * a * c;
  if (discriminant < 0) return -1;

  const fraction = (-b - Math.sqrt(discriminant)) / (2 * a);
  if (fraction < 0 || fraction >= ceiling) return -1;

  _mastPoint.lerpVectors(_localFrom, _localTo, fraction);
  if (_mastPoint.y < MAST_BASE_Y || _mastPoint.y > MAST_TOP_Y) return -1;
  // Confere contra o raio real daquela altura: perto do topo o cilindro médio
  // é gordo demais e aceitaria um tiro que passou de raspão.
  if (Math.hypot(_mastPoint.x, _mastPoint.z - MAST_Z) > mastRadius(_mastPoint.y) + 0.02) return -1;

  _mastNormal.set(_mastPoint.x, 0, _mastPoint.z - MAST_Z).normalize();
  return fraction;
}
