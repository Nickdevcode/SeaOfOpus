/**
 * Flutuabilidade: o que faz o navio boiar, jogar e se endireitar.
 *
 * O casco é fatiado em **colunas verticais** — uma grade de estações ao longo do
 * comprimento por faixas ao longo da boca. Cada coluna guarda, tabelado na
 * construção, o volume submerso e o centróide desse volume para cada altura
 * possível da linha d'água dentro dela. Em tempo de execução cada coluna custa
 * uma amostragem de onda e duas interpolações lineares.
 *
 * Por que tabela e não `ρ·g·V·fração`: a seção do casco afina até virar quase
 * nada na quilha, então a fração submersa **não** é linear na profundidade. Com
 * a rampa linear que se vê por aí, o navio afunda alguns decímetros abaixo do
 * calado de projeto e ninguém sabe dizer por quê. Com a tabela, o volume
 * submerso com a linha d'água em `y = 0` é exatamente o deslocamento de projeto,
 * então o navio nasce boiando no calado desenhado — sem número mágico.
 *
 * Dois efeitos importantes caem de graça daqui:
 * - **Momento de endireitamento:** ao adernar, as colunas de sotavento submergem
 *   mais que as de barlavento, e o centróide do empuxo migra para o lado baixo.
 *   Não existe mola artificial de estabilidade neste projeto.
 * - **Caturro e arfagem:** a onda chega em cada estação numa fase diferente, e é
 *   isso que balança o navio.
 */

import * as THREE from 'three';
import { GRAVITY, WATER_DENSITY, clamp, clamp01 } from '../core/MathUtils';
import {
  HULL_LENGTH,
  sampleSection,
  sectionHalfWidth,
  sectionV,
  tToZ,
  type HullSection,
} from './ShipDimensions';
import type { ShipBody } from './ShipBody';
import type { WaveField } from '../world/WaveField';

/** Estações ao longo do comprimento. Dez dá ~1,6 m de fatia. */
const LENGTH_SAMPLES = 10;
/** Faixas ao longo da boca. Três (bombordo/centro/boreste) bastam para o balanço. */
const WIDTH_SAMPLES = 3;
/** Níveis da tabela de volume por coluna. */
const LEVELS = 40;
/** Sub-passos da quadratura ao montar a tabela. */
const QUADRATURE = 8;

/**
 * Amortecimento de radiação, em 1/s.
 *
 * Um casco que sobe e desce cria ondas que levam energia embora — é o que faz o
 * navio parar de quicar depois de uma vaga em vez de ressoar para sempre. Age só
 * na vertical: aplicá-lo também na horizontal travaria o navio a menos de 1 nó,
 * porque o arrasto de avanço é ordens de grandeza menor que este.
 */
const HEAVE_DAMPING = 2.1;

interface HullColumn {
  /** X local da coluna na linha d'água de projeto. */
  x: number;
  z: number;
  yBottom: number;
  yTop: number;
  /** Volume submerso (m³) com a linha d'água em cada nível. */
  volume: Float32Array;
  /** X do centróide do volume submerso, por nível. */
  centroidX: Float32Array;
  /** Y do centróide do volume submerso, por nível. */
  centroidY: Float32Array;
}

const _worldPoint = new THREE.Vector3();
const _worldArm = new THREE.Vector3();
const _up = new THREE.Vector3();
const _localUp = new THREE.Vector3(0, 1, 0);
const _pointVelocity = new THREE.Vector3();
const _force = new THREE.Vector3();
const _local = new THREE.Vector3();

export interface BuoyancyReport {
  /** Fração do volume de projeto que está submersa, 0..1+. */
  submersion: number;
  /** Profundidade média da água acima da linha d'água de projeto, em metros. */
  meanDepth: number;
}

export class Buoyancy {
  private readonly columns: HullColumn[] = [];
  /** Volume submerso com a linha d'água exatamente no calado de projeto. */
  readonly designVolume: number;

  private readonly report: BuoyancyReport = { submersion: 0, meanDepth: 0 };

  constructor() {
    const section: HullSection = { halfBeam: 0, keelY: 0, sheerY: 0, fullness: 1 };
    const dz = HULL_LENGTH / LENGTH_SAMPLES;
    let designVolume = 0;

    for (let i = 0; i < LENGTH_SAMPLES; i++) {
      const t = (i + 0.5) / LENGTH_SAMPLES;
      sampleSection(t, section);

      const yBottom = section.keelY;
      const yTop = section.sheerY;
      const span = yTop - yBottom;

      for (let j = 0; j < WIDTH_SAMPLES; j++) {
        // A faixa acompanha a meia largura da seção em cada altura, em vez de
        // ser um retângulo fixo: assim as colunas ladrilham o casco de verdade,
        // sem sobra na quilha nem falta no bojo.
        const uCenter = (j + 0.5) / WIDTH_SAMPLES;
        const xFraction = uCenter * 2 - 1;

        const volume = new Float32Array(LEVELS + 1);
        const centroidX = new Float32Array(LEVELS + 1);
        const centroidY = new Float32Array(LEVELS + 1);

        let accumulated = 0;
        let momentX = 0;
        let momentY = 0;

        for (let level = 1; level <= LEVELS; level++) {
          const yLow = yBottom + (span * (level - 1)) / LEVELS;
          const dy = span / LEVELS / QUADRATURE;

          for (let q = 0; q < QUADRATURE; q++) {
            const y = yLow + dy * (q + 0.5);
            const halfWidth = sectionHalfWidth(section, sectionV(section, y));
            const cellVolume = ((halfWidth * 2) / WIDTH_SAMPLES) * dy * dz;
            accumulated += cellVolume;
            momentX += halfWidth * xFraction * cellVolume;
            momentY += y * cellVolume;
          }

          volume[level] = accumulated;
          centroidX[level] = accumulated > 0 ? momentX / accumulated : 0;
          centroidY[level] = accumulated > 0 ? momentY / accumulated : yBottom;
        }

        // O centróide do nível 0 não é usado (volume zero), mas deixá-lo no
        // fundo evita um salto na interpolação do primeiro nível.
        centroidY[0] = yBottom;

        const column: HullColumn = {
          x: sectionHalfWidth(section, sectionV(section, 0)) * xFraction,
          z: tToZ(t),
          yBottom,
          yTop,
          volume,
          centroidX,
          centroidY,
        };
        this.columns.push(column);
        designVolume += sampleColumn(column, 0).volume;
      }
    }

    this.designVolume = designVolume;
  }

  /**
   * Massa que faz o navio boiar exatamente no calado de projeto.
   *
   * Sai da mesma tabela que gera o empuxo, e não de `computeDisplacement()`:
   * as duas quadraturas diferem em frações de por cento, e é justamente essa
   * diferença que apareceria como o navio nascendo alguns centímetros fora da
   * linha d'água e afundando devagar até se acomodar.
   */
  getDesignMass(): number {
    return this.designVolume * WATER_DENSITY;
  }

  /**
   * Aplica empuxo e amortecimento vertical ao corpo. Devolve telemetria de
   * quanto do casco está na água, que o alagamento e o HUD leem.
   */
  apply(body: ShipBody, waves: WaveField): BuoyancyReport {
    body.localDirToWorld(_localUp, _up);
    // Emborcado, a projeção da vertical local na vertical do mundo tende a zero
    // e a divisão explodiria. O piso mantém a conta finita e o navio ainda
    // recebe empuxo — só deixa de ter para onde se endireitar, que é o certo.
    const upY = Math.max(_up.y, 0.2);

    let submerged = 0;
    let depthSum = 0;

    for (const column of this.columns) {
      _local.set(column.x, 0, column.z);
      body.localToWorld(_local, _worldPoint);

      const waterY = waves.sampleHeight(_worldPoint.x, _worldPoint.z);
      const depth = waterY - _worldPoint.y;
      depthSum += depth;

      // Altura local em que esta coluna corta a superfície: andar `s` ao longo
      // do eixo vertical *do navio* sobe `s · upY` no mundo.
      const crossing = depth / upY;
      const sample = sampleColumn(column, crossing);
      if (sample.volume <= 0) continue;

      submerged += sample.volume;

      _local.set(sample.x, sample.y, column.z);
      body.localToWorld(_local, _worldPoint);
      _worldArm.subVectors(_worldPoint, body.comPosition);

      // Empuxo: sempre para cima no mundo, aplicado no centróide do volume
      // submerso desta coluna. O braço até o centro de massa é o que vira
      // momento de endireitamento quando o navio aderna.
      _force.set(0, WATER_DENSITY * GRAVITY * sample.volume, 0);

      body.pointVelocity(_worldArm, _pointVelocity);
      _force.y -= HEAVE_DAMPING * WATER_DENSITY * sample.volume * _pointVelocity.y;

      body.applyForceAtPoint(_force, _worldPoint);
    }

    this.report.submersion = submerged / this.designVolume;
    this.report.meanDepth = depthSum / this.columns.length;
    return this.report;
  }
}

const _sample = { volume: 0, x: 0, y: 0 };

/**
 * Lê a tabela de uma coluna na altura `y` da linha d'água, interpolando.
 * Devolve um objeto compartilhado — isto roda trinta vezes por passo de física.
 */
function sampleColumn(column: HullColumn, y: number): typeof _sample {
  if (y <= column.yBottom) {
    _sample.volume = 0;
    _sample.x = column.x;
    _sample.y = column.yBottom;
    return _sample;
  }

  const span = column.yTop - column.yBottom;
  const position = clamp(((y - column.yBottom) / span) * LEVELS, 0, LEVELS);
  const index = Math.min(Math.floor(position), LEVELS - 1);
  const fraction = clamp01(position - index);

  const a = column.volume[index]!;
  const b = column.volume[index + 1]!;
  _sample.volume = a + (b - a) * fraction;
  _sample.x = column.centroidX[index]! + (column.centroidX[index + 1]! - column.centroidX[index]!) * fraction;
  _sample.y = column.centroidY[index]! + (column.centroidY[index + 1]! - column.centroidY[index]!) * fraction;
  return _sample;
}
