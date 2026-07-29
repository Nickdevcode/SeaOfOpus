/**
 * Ambiente de reflexo (IBL): o céu e o mar viram a luz indireta do navio.
 *
 * **Por que isto precisa existir.** A cena já tinha um `HemisphereLight` fazendo
 * as vezes de luz ambiente, e ele resolve o difuso: sem ele a sombra do costado
 * seria um buraco preto. Só que luz de hemisfério **não entra no especular** —
 * nenhuma luz analítica entra. Para um material metálico isso é fatal, porque
 * `metalness ≈ 0.9` zera o difuso por definição: o metal só tem reflexo. O
 * resultado no jogo era exatamente o previsto pela teoria e visível na tela: o
 * latão e o ferro fundido só existiam onde o lobo especular do sol batia, e ali
 * estouravam; fora dele, eram silhuetas pretas. A tampa da bitácula, deitada
 * para o céu bem no meio da tela de quem está no timão, lia como uma barra de
 * ouro. Não era a cor nem a rugosidade: era não haver céu nenhum para refletir.
 *
 * **O que ele faz.** Recompõe um equirretangular pequeno — céu por cima, água
 * por baixo — e passa pelo `PMREMGenerator`, que devolve o cubo pré-filtrado por
 * rugosidade que o `MeshStandardMaterial` sabe consumir. Uma textura, todos os
 * materiais do navio, difuso e especular de uma vez.
 *
 * **Por que compor em vez de usar a LUT direta.** A LUT do céu cobre a esfera
 * inteira, mas abaixo do horizonte ela é o raymarch atravessando o planeta: uma
 * faixa creme sem significado físico. É a mesma razão pela qual o shader do mar
 * espelha o raio refletido para cima em vez de grampeá-lo. Alimentar o IBL com
 * aquilo pintaria de areia a barriga de todo objeto a bordo. Metade do que um
 * navio vê é água, e é água que tem de entrar ali.
 *
 * **Custo.** A fonte tem 256×128 e o cubo, 128. O PMREM só roda quando o `Sky`
 * de fato recomputou a LUT (ele já tem seu próprio limiar de movimento do sol) e
 * no máximo algumas vezes por segundo. É uma fração de milissegundo amortizada.
 */

import * as THREE from 'three';
import { EQUIRECT_GLSL } from '../shaders/atmosphere';
import { OCEAN_DEEP_COLOR, OCEAN_SHALLOW_COLOR } from './Ocean';

/** Resolução do equirretangular que alimenta o PMREM. */
const SOURCE_WIDTH = 256;
const SOURCE_HEIGHT = 128;

/**
 * Intervalo mínimo entre duas gerações, em segundos.
 *
 * O `Sky` já segura a LUT por ângulo do sol, mas num dia de 12 minutos esse
 * limiar dispara várias vezes por segundo — barato para um quad, caro para uma
 * cadeia de mips. A luz do céu muda devagar até no poente; um terço de segundo
 * de atraso não é perceptível em lugar nenhum.
 */
const MIN_INTERVAL = 0.33;

const COMPOSITE_FRAGMENT = /* glsl */ `
precision highp float;

${EQUIRECT_GLSL}

uniform sampler2D uSkyLut;
uniform vec3 uDeepColor;
uniform vec3 uShallowColor;

varying vec2 vUv;

void main() {
  // A LUT usa exatamente este mapeamento, então o UV serve para as duas sem
  // conversão: é o mesmo atlas, só com a metade de baixo reescrita.
  vec3 direction = equirectToDirection(vUv);
  vec3 sky = texture2D(uSkyLut, vUv).rgb;

  // Mesma luz ambiente que o shader do mar usa para o corpo da água, lida do
  // zênite da própria LUT. Assim o IBL escurece sozinho ao anoitecer, sem
  // nenhuma curva paralela para manter em sincronia.
  vec3 zenith = texture2D(uSkyLut, vec2(0.5, 0.02)).rgb;
  vec3 body = mix(uDeepColor, uShallowColor, 0.35) * zenith * 2.1;

  // Rasante, o mar é quase só o céu refletido (Fresnel perto de 1); a pique,
  // é o corpo da água. A transição em ~20° abaixo do horizonte aproxima essa
  // virada bem o bastante para uma textura que ainda vai ser borrada pelo PMREM.
  vec3 horizon = texture2D(uSkyLut, vec2(vUv.x, 0.498)).rgb;
  vec3 sea = mix(horizon * 0.6, body, smoothstep(0.0, -0.35, direction.y));

  // Faixa estreita de mistura no horizonte: sem ela fica uma linha dura que o
  // PMREM transforma num anel visível nos mips de baixa rugosidade.
  float below = smoothstep(0.035, -0.02, direction.y);
  gl_FragColor = vec4(mix(sky, sea, below), 1.0);
}
`;

export class SkyEnvironment {
  /** O cubo pré-filtrado, pronto para virar `scene.environment`. */
  get texture(): THREE.Texture | null {
    return this.envTarget?.texture ?? null;
  }

  private readonly pmrem: THREE.PMREMGenerator;
  private readonly sourceTarget: THREE.WebGLRenderTarget;
  private readonly sourceScene = new THREE.Scene();
  private readonly sourceCamera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
  private readonly sourceMaterial: THREE.ShaderMaterial;
  private readonly sourceQuad: THREE.Mesh;

  private envTarget: THREE.WebGLRenderTarget | null = null;
  private lastGeneration = -1;
  private sinceLastBuild = MIN_INTERVAL;

  constructor(renderer: THREE.WebGLRenderer) {
    this.pmrem = new THREE.PMREMGenerator(renderer);
    // Compilar agora evita o engasgo de compilação no primeiro frame de jogo.
    this.pmrem.compileEquirectangularShader();

    this.sourceTarget = new THREE.WebGLRenderTarget(SOURCE_WIDTH, SOURCE_HEIGHT, {
      // O céu tem faixa dinâmica alta e o PMREM só é útil se ela sobreviver:
      // em 8 bits o realce do sol satura e o reflexo perde o que interessa.
      type: THREE.HalfFloatType,
      format: THREE.RGBAFormat,
      depthBuffer: false,
      stencilBuffer: false,
    });
    this.sourceTarget.texture.mapping = THREE.EquirectangularReflectionMapping;
    this.sourceTarget.texture.minFilter = THREE.LinearFilter;
    this.sourceTarget.texture.magFilter = THREE.LinearFilter;
    // A costura em φ = ±π cai no meio da textura ao envolver: sem repetição em
    // X o PMREM lê a borda espelhada e desenha uma emenda vertical no cubo.
    this.sourceTarget.texture.wrapS = THREE.RepeatWrapping;
    this.sourceTarget.texture.wrapT = THREE.ClampToEdgeWrapping;

    this.sourceMaterial = new THREE.ShaderMaterial({
      vertexShader: /* glsl */ `
        varying vec2 vUv;
        void main() {
          vUv = uv;
          gl_Position = vec4(position.xy, 0.0, 1.0);
        }
      `,
      fragmentShader: COMPOSITE_FRAGMENT,
      depthTest: false,
      depthWrite: false,
      uniforms: {
        uSkyLut: { value: null },
        uDeepColor: { value: OCEAN_DEEP_COLOR.clone() },
        uShallowColor: { value: OCEAN_SHALLOW_COLOR.clone() },
      },
    });

    this.sourceQuad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), this.sourceMaterial);
    this.sourceQuad.frustumCulled = false;
    this.sourceScene.add(this.sourceQuad);
  }

  /**
   * Regenera o ambiente se o céu mudou e o intervalo mínimo já passou.
   *
   * `generation` é o contador de renders da LUT do `Sky`: enquanto ele não
   * anda, não há nada novo para pré-filtrar. Devolve `true` quando reconstruiu,
   * que é quando o chamador precisa reatribuir `scene.environment`.
   */
  update(renderer: THREE.WebGLRenderer, skyLut: THREE.Texture, generation: number, dt: number): boolean {
    this.sinceLastBuild += dt;
    if (generation === this.lastGeneration) return false;
    if (this.sinceLastBuild < MIN_INTERVAL && this.envTarget) return false;

    this.lastGeneration = generation;
    this.sinceLastBuild = 0;

    this.sourceMaterial.uniforms.uSkyLut!.value = skyLut;

    const previousTarget = renderer.getRenderTarget();
    renderer.setRenderTarget(this.sourceTarget);
    renderer.render(this.sourceScene, this.sourceCamera);
    renderer.setRenderTarget(previousTarget);

    // Passar o alvo anterior faz o gerador reaproveitá-lo em vez de alocar uma
    // cadeia de mips nova a cada poucos frames.
    this.envTarget = this.pmrem.fromEquirectangular(this.sourceTarget.texture, this.envTarget ?? undefined);
    return true;
  }

  dispose(): void {
    this.envTarget?.dispose();
    this.sourceTarget.dispose();
    this.sourceMaterial.dispose();
    this.sourceQuad.geometry.dispose();
    this.pmrem.dispose();
  }
}
