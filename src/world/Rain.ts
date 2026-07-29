/**
 * Chuva: riscos de água caindo em volta de quem está olhando.
 *
 * ## A ideia que faz isto custar quase nada
 *
 * As gotas **não são simuladas**. Elas vivem numa caixa fixa em torno da câmera,
 * e o que se anima é uma única variável: o tempo. A posição de cada gota é uma
 * função do tempo com módulo pela altura da caixa, então uma gota que sai por
 * baixo reaparece em cima sem que ninguém precise testar nada, e a caixa inteira
 * é transladada para a câmera a cada quadro. Não há estado por gota para
 * atualizar, não há alocação e não há laço na CPU — só um uniform de tempo.
 *
 * O preço é que a chuva não interage com nada: não bate no convés, não se
 * acumula, não é bloqueada pela vela. É o preço certo. O que a chuva precisa
 * fazer é dizer ao jogador, sem texto, que o tempo virou; para isso ela precisa
 * estar em todo lugar e custar zero, e é o que ela faz.
 *
 * ## Por que riscos e não pontos
 *
 * Gota de chuva vista por olho humano (e por câmera) é um **traço**, não um
 * ponto: ela percorre alguns centímetros durante o tempo de exposição. Desenhar
 * pontos dá aquela neve de televisão que nenhum jogo consegue fazer ler como
 * chuva. Cada gota aqui é um segmento vertical, e o comprimento dele cresce com
 * a intensidade — porque chover mais forte é chover mais rápido.
 */

import * as THREE from 'three';

/** Meia aresta da caixa de chuva, em metros. */
const BOX_HALF = 26;
/** Altura da caixa. Precisa cobrir do convés ao topo do mastro com folga. */
const BOX_HEIGHT = 30;
/** Gotas na caixa, no máximo. A densidade visível é modulada pela intensidade. */
const DROP_COUNT = 4200;

const VERTEX_SHADER = /* glsl */ `
precision highp float;

uniform float uTime;
uniform float uIntensity;
uniform vec3 uOrigin;
uniform vec2 uWind;
uniform float uBoxHalf;
uniform float uBoxHeight;

/** (x, z, semente, fase) da gota; a altura sai do tempo. */
attribute vec4 aSeed;
/** −1 no topo do risco, +1 no pé. */
attribute float aEnd;

varying float vFade;

void main() {
  // Chuva forte cai mais rápido: de 14 a 26 m/s.
  float fall = 14.0 + uIntensity * 12.0;
  // O comprimento do risco é o quanto a gota anda num tempo de exposição.
  float streak = 0.28 + uIntensity * 0.75;

  // Densidade: as gotas de semente alta só entram quando a chuva engrossa. É o
  // que faz o aguaceiro virar temporal sem trocar de geometria.
  vFade = step(aSeed.z, uIntensity) * uIntensity;

  // A queda é o tempo com módulo pela altura da caixa. A fase espalha as gotas
  // para elas não caírem todas na mesma linha do relógio.
  float drop = mod(uTime * fall + aSeed.w * uBoxHeight, uBoxHeight);
  float y = uOrigin.y + uBoxHeight * 0.5 - drop;

  // A caixa acompanha a câmera em saltos de meia aresta, e não de forma
  // contínua: assim as gotas não escorregam junto com o observador, que é o
  // artefato que denuncia chuva presa na câmera.
  //
  // Arredonda em vez de truncar, e o passo é metade da aresta: truncando por
  // aresta inteira, a câmera podia ficar a uma aresta cheia do canto da célula
  // e saía da caixa — a chuva sumia da tela assim que o navio se afastava da
  // origem do mundo. Com este passo o observador nunca fica a mais de um quarto
  // de aresta do centro, e sobra chuva em todas as direções em volta dele.
  float cell = uBoxHalf;
  vec2 anchor = floor(uOrigin.xz / cell + 0.5) * cell;
  vec2 xz = anchor + aSeed.xy;

  // Inclinação pelo vento: a chuva de temporal cai deitada.
  xz += uWind * (drop * 0.16);

  // O risco: a ponta de cima fica atrás na trajetória.
  y += aEnd * streak * 0.5;

  gl_Position = projectionMatrix * viewMatrix * vec4(xz.x, y, xz.y, 1.0);
}
`;

const FRAGMENT_SHADER = /* glsl */ `
precision highp float;

uniform vec3 uColor;
varying float vFade;

void main() {
  if (vFade <= 0.0) discard;
  gl_FragColor = vec4(uColor, vFade * 0.42);
}
`;

export class Rain {
  readonly object: THREE.LineSegments;

  private readonly material: THREE.ShaderMaterial;

  constructor() {
    const geometry = new THREE.BufferGeometry();

    // Dois vértices por gota: o risco é um segmento.
    const seeds = new Float32Array(DROP_COUNT * 2 * 4);
    const ends = new Float32Array(DROP_COUNT * 2);
    const positions = new Float32Array(DROP_COUNT * 2 * 3);

    for (let i = 0; i < DROP_COUNT; i++) {
      const x = (Math.random() * 2 - 1) * BOX_HALF;
      const z = (Math.random() * 2 - 1) * BOX_HALF;
      // A semente de densidade é o limiar de intensidade em que a gota aparece.
      // Distribuída pela raiz para a contagem crescer de forma perceptualmente
      // linear: dobrar a intensidade tem de parecer o dobro de chuva.
      const threshold = Math.sqrt(Math.random());
      const phase = Math.random();

      for (let end = 0; end < 2; end++) {
        const v = i * 2 + end;
        seeds[v * 4] = x;
        seeds[v * 4 + 1] = z;
        seeds[v * 4 + 2] = threshold;
        seeds[v * 4 + 3] = phase;
        ends[v] = end === 0 ? -1 : 1;
      }
    }

    geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    geometry.setAttribute('aSeed', new THREE.BufferAttribute(seeds, 4));
    geometry.setAttribute('aEnd', new THREE.BufferAttribute(ends, 1));
    // A caixa acompanha a câmera, então nunca sai de campo. Calcular uma esfera
    // envolvente para ela seria descartá-la por engano.
    geometry.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e6);

    this.material = new THREE.ShaderMaterial({
      vertexShader: VERTEX_SHADER,
      fragmentShader: FRAGMENT_SHADER,
      transparent: true,
      depthWrite: false,
      fog: false,
      uniforms: {
        uTime: { value: 0 },
        uIntensity: { value: 0 },
        uOrigin: { value: new THREE.Vector3() },
        uWind: { value: new THREE.Vector2() },
        uBoxHalf: { value: BOX_HALF },
        uBoxHeight: { value: BOX_HEIGHT },
        uColor: { value: new THREE.Color(0.78, 0.85, 0.92) },
      },
    });

    this.object = new THREE.LineSegments(geometry, this.material);
    this.object.frustumCulled = false;
    this.object.matrixAutoUpdate = false;
    // Depois do mar (1) e antes do céu (1000): a chuva é transparente e precisa
    // do que está atrás dela já desenhado.
    this.object.renderOrder = 900;
    this.object.visible = false;
  }

  /**
   * @param intensity 0 (seco) a 1 (temporal).
   * @param wind vetor do vento no plano, para deitar a chuva.
   */
  update(dt: number, camera: THREE.Vector3, intensity: number, wind: THREE.Vector2): void {
    const uniforms = this.material.uniforms;
    uniforms.uIntensity!.value = intensity;
    this.object.visible = intensity > 0.01;
    if (!this.object.visible) return;

    uniforms.uTime!.value += dt;
    (uniforms.uOrigin!.value as THREE.Vector3).copy(camera);
    (uniforms.uWind!.value as THREE.Vector2).copy(wind);
  }

  dispose(): void {
    this.object.geometry.dispose();
    this.material.dispose();
  }
}
