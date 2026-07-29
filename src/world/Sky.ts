/**
 * Céu: LUT atmosférica + domo + sol, lua, estrelas e nuvens.
 *
 * O espalhamento atmosférico é caro demais para rodar por pixel de tela, então
 * ele é avaliado numa LUT equirretangular 256×128 e só quando o sol se move o
 * suficiente para importar. O domo do céu e o reflexo do oceano amostram essa
 * mesma LUT — é isso que faz o mar refletir exatamente o céu que está acima
 * dele, inclusive durante o poente.
 *
 * As nuvens são projetadas num plano alto com fBm animado, sem raymarch. É a
 * mesma escolha que a Rare fez em Sea of Thieves: nuvem barata, com silhueta
 * dirigida pela arte, em vez de volume fisicamente correto e lento.
 */

import * as THREE from 'three';
import { ATMOSPHERE_GLSL, EQUIRECT_GLSL } from '../shaders/atmosphere';
import { NOISE_GLSL } from '../shaders/noise';

// 0.35° por texel na vertical. Parece exagero para um gradiente suave, mas o
// mar amostra a LUT em ângulos rasantes, onde a cor muda depressa: com 128
// linhas a interpolação linear desenhava faixas de Mach visíveis nas ondas.
const LUT_WIDTH = 1024;
const LUT_HEIGHT = 512;
/** Ângulo mínimo (radianos) que o sol precisa andar para recomputar a LUT. */
const LUT_UPDATE_THRESHOLD = 0.004;

/** Raio do domo. Fica dentro do far plane da câmera. */
const DOME_RADIUS = 9000;

/**
 * Intensidade da lua cheia na LUT, na mesma escala do sol (que vai a 22).
 * Calibrada no olho: ver `update` para o porquê de não ser o valor físico.
 */
const MOON_INTENSITY = 0.26;

export class Sky {
  readonly dome: THREE.Mesh;
  /** Malha pequena na direção do sol — alvo do efeito de god rays. */
  readonly sunMesh: THREE.Mesh;

  /** Textura equirretangular do céu, consumida pelo shader do oceano. */
  get lutTexture(): THREE.Texture {
    return this.lutTarget.texture;
  }

  /**
   * Quantas vezes a LUT já foi redesenhada.
   *
   * A textura é sempre a mesma instância, então nada em volta consegue perceber
   * que o conteúdo mudou. Quem tem trabalho caro a refazer a partir dela — o
   * `SkyEnvironment` e sua cadeia de mips — compara este número com o que viu da
   * última vez em vez de refazer tudo a cada frame por precaução.
   */
  lutGeneration = 0;

  private lutTarget: THREE.WebGLRenderTarget;
  private lutScene = new THREE.Scene();
  private lutCamera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
  private lutMaterial: THREE.ShaderMaterial;
  private domeMaterial: THREE.ShaderMaterial;
  private sunMaterial: THREE.MeshBasicMaterial;

  private lastLutSunDirection = new THREE.Vector3(0, -1, 0);
  private lutDirty = true;

  constructor() {
    this.lutTarget = new THREE.WebGLRenderTarget(LUT_WIDTH, LUT_HEIGHT, {
      // HalfFloat: o céu tem faixa dinâmica alta (sol x zênite) e 8 bits
      // produziria banding grosseiro no gradiente do poente.
      type: THREE.HalfFloatType,
      format: THREE.RGBAFormat,
      minFilter: THREE.LinearFilter,
      magFilter: THREE.LinearFilter,
      depthBuffer: false,
      stencilBuffer: false,
    });
    this.lutTarget.texture.wrapS = THREE.RepeatWrapping;
    this.lutTarget.texture.colorSpace = THREE.NoColorSpace;

    this.lutMaterial = new THREE.ShaderMaterial({
      uniforms: {
        uSunDirection: { value: new THREE.Vector3(0, 1, 0) },
        uSunIntensity: { value: 22 },
        uMoonDirection: { value: new THREE.Vector3(0, -1, 0) },
        uMoonIntensity: { value: 0 },
        uNightFactor: { value: 0 },
      },
      vertexShader: /* glsl */ `
        varying vec2 vUv;
        void main() {
          vUv = uv;
          gl_Position = vec4(position.xy, 0.0, 1.0);
        }
      `,
      fragmentShader: /* glsl */ `
        precision highp float;
        varying vec2 vUv;
        uniform vec3 uSunDirection;
        uniform float uSunIntensity;
        uniform vec3 uMoonDirection;
        uniform float uMoonIntensity;
        uniform float uNightFactor;

        ${EQUIRECT_GLSL}
        ${ATMOSPHERE_GLSL}

        void main() {
          vec3 dir = equirectToDirection(vUv);
          vec3 color = nightGlow(dir) * uNightFactor;

          // A lua ilumina o céu pela mesma física do sol — é luz solar refletida
          // atravessando o mesmo ar. Rodar o espalhamento duas vezes dobraria o
          // custo da LUT se as duas fontes coexistissem, mas elas mal se
          // cruzam: fora da meia hora de crepúsculo, uma das duas intensidades é
          // exatamente zero. E como o teste é sobre uniform, a GPU decide o
          // desvio uma vez para a textura inteira, sem divergência.
          if (uSunIntensity > 0.0) {
            color += atmosphere(dir, uSunDirection, uSunIntensity);
          }
          if (uMoonIntensity > 0.0) {
            color += atmosphere(dir, uMoonDirection, uMoonIntensity);
          }

          gl_FragColor = vec4(color, 1.0);
        }
      `,
      depthTest: false,
      depthWrite: false,
    });

    const quad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), this.lutMaterial);
    quad.frustumCulled = false;
    this.lutScene.add(quad);

    this.domeMaterial = this.createDomeMaterial();
    this.dome = new THREE.Mesh(new THREE.SphereGeometry(DOME_RADIUS, 64, 32), this.domeMaterial);
    this.dome.frustumCulled = false;
    // O domo desenha por último entre os opacos, sem escrever profundidade: o
    // teste de Z já descarta cada pixel coberto pelo mar ou pelo navio. Isso
    // importa muito aqui, porque o fragment do céu é caro (nuvens em fBm e
    // estrelas) e desenhá-lo primeiro significaria pagar a tela inteira para
    // depois cobrir metade dela.
    this.dome.renderOrder = 1000;
    this.dome.matrixAutoUpdate = false;

    this.sunMaterial = new THREE.MeshBasicMaterial({
      fog: false,
      transparent: true,
      depthWrite: false,
      // Aditivo, e não substituição: o halo de Mie em volta do sol é HDR (dezenas
      // de vezes o branco), então um disco em cor LDR desenhado por cima dele
      // vira um buraco escuro no meio do sol depois do tone mapping. Somando, o
      // disco só pode clarear o que já está lá. A cor vem de `update`, em
      // radiância bem acima de 1 — é ela que alimenta o bloom.
      blending: THREE.AdditiveBlending,
    });
    this.sunMesh = new THREE.Mesh(new THREE.SphereGeometry(90, 16, 12), this.sunMaterial);
    this.sunMesh.frustumCulled = false;
    this.sunMesh.renderOrder = 1001;
  }

  private createDomeMaterial(): THREE.ShaderMaterial {
    return new THREE.ShaderMaterial({
      side: THREE.BackSide,
      depthWrite: false,
      fog: false,
      uniforms: {
        uSkyLut: { value: this.lutTarget.texture },
        uSunDirection: { value: new THREE.Vector3(0, 1, 0) },
        uMoonDirection: { value: new THREE.Vector3(0, -1, 0) },
        uMoonPhase: { value: 0.35 },
        uTime: { value: 0 },
        uNightFactor: { value: 0 },
        uCloudCoverage: { value: 0.42 },
        uCloudSunColor: { value: new THREE.Color(1, 0.94, 0.82) },
        uCloudShadowColor: { value: new THREE.Color(0.32, 0.36, 0.46) },
        uWindDirection: { value: new THREE.Vector2(1, 0) },
      },
      vertexShader: /* glsl */ `
        varying vec3 vDirection;
        void main() {
          vDirection = normalize(position);
          // A projeção usa apenas a rotação da câmera: o domo acompanha o
          // jogador sem nunca ser alcançado.
          vec4 mvPosition = modelViewMatrix * vec4(position, 1.0);
          gl_Position = projectionMatrix * mvPosition;
        }
      `,
      fragmentShader: /* glsl */ `
        precision highp float;

        varying vec3 vDirection;

        uniform sampler2D uSkyLut;
        uniform vec3 uSunDirection;
        uniform vec3 uMoonDirection;
        uniform float uMoonPhase;
        uniform float uTime;
        uniform float uNightFactor;
        uniform float uCloudCoverage;
        uniform vec3 uCloudSunColor;
        uniform vec3 uCloudShadowColor;
        uniform vec2 uWindDirection;

        ${EQUIRECT_GLSL}
        ${NOISE_GLSL}

        /**
         * Campo de estrelas procedural: divide a esfera em células e sorteia
         * uma estrela por célula. Sem geometria, sem textura, e a densidade
         * acompanha a resolução automaticamente.
         *
         * O que separa "céu estrelado" de "chuvisco de televisão" não é a
         * quantidade, é a **distribuição de magnitude**. No céu real cada degrau
         * de brilho tem cerca de três vezes mais estrelas que o degrau acima
         * dele: umas poucas dominam a cena e a esmagadora maioria é quase
         * invisível. Sortear brilho uniforme — que é o erro fácil aqui — produz
         * milhares de pontinhos idênticos, e o olho lê ruído.
         */
        vec3 starField(vec3 dir) {
          // Extinção atmosférica: rasante, a luz da estrela atravessa dezenas de
          // vezes mais ar. Perto do horizonte só as mais brilhantes sobrevivem.
          float extinction = smoothstep(-0.01, 0.3, dir.y);
          if (extinction <= 0.0) return vec3(0.0);

          vec3 color = vec3(0.0);

          for (int layer = 0; layer < 3; layer++) {
            float scale = 60.0 + float(layer) * 95.0;
            vec3 cell = floor(dir * scale);
            float rnd = hash21(cell.xy + cell.z * 37.0);

            // A densidade cai com a escala porque a contagem de células cresce
            // com o quadrado dela — sem isso a camada fina afogaria as outras.
            float density = 0.006 - float(layer) * 0.0015;
            if (rnd > density) continue;

            // Sorteio remapeado para [0,1] e passado pela lei de potência que
            // faz a distribuição de magnitude.
            float magnitude = pow(rnd / density, 6.0);

            // Estrela brilhante ocupa mais pixels: é o próprio olho (e aqui o
            // bloom) espalhando a luz, não um disco maior no céu.
            float radius = 0.0011 + magnitude * 0.0020;
            vec3 center = (cell + 0.5) / scale;
            float dist = length(normalize(center) - dir);
            float brightness = smoothstep(radius, 0.0, dist);
            if (brightness <= 0.0) continue;

            // Cintilação: é turbulência do ar, então some no zênite e domina
            // rasante — exatamente onde a extinção já está comendo o brilho.
            float flicker = 0.5 + 0.5 * sin(uTime * (1.4 + rnd * 400.0) + rnd * 900.0);
            float twinkle = mix(flicker, 1.0, extinction);

            // Temperatura de cor variando de azulada a alaranjada.
            vec3 tint = mix(vec3(0.75, 0.83, 1.0), vec3(1.0, 0.86, 0.7), hash11(rnd * 91.0));
            color += tint * brightness * twinkle * extinction * (0.25 + magnitude * 5.5);
          }
          return color;
        }

        /** Disco lunar com terminador de fase e crateras em ruído. */
        vec3 moonDisc(vec3 dir) {
          float cosAngle = dot(dir, uMoonDirection);
          if (cosAngle < 0.9993) return vec3(0.0);

          float disc = smoothstep(0.99955, 0.99975, cosAngle);

          // Base local para mapear a superfície do disco.
          vec3 right = normalize(cross(vec3(0.0, 1.0, 0.0), uMoonDirection));
          vec3 up = cross(uMoonDirection, right);
          vec2 local = vec2(dot(dir, right), dot(dir, up)) * 900.0;

          float craters = fbm(vec3(local * 2.4, 0.0), 4, 2.1, 0.55) * 0.5 + 0.5;
          float surface = mix(0.72, 1.0, craters);

          // Terminador: a fase corta o disco com uma borda suave.
          float terminator = smoothstep(-0.25, 0.25, local.x / 900.0 * 4.0 - (uMoonPhase * 2.0 - 1.0) * 2.2);

          return vec3(0.92, 0.94, 1.0) * disc * surface * terminator * 2.4;
        }

        /**
         * Nuvens em camada: o raio é projetado num plano alto e amostrado com
         * fBm. Duas camadas em velocidades diferentes dão paralaxe sem volume.
         */
        vec4 clouds(vec3 dir) {
          if (dir.y < 0.015) return vec4(0.0);

          float planeHeight = 1800.0;
          vec2 uv = dir.xz / max(dir.y, 0.015) * (planeHeight / 4000.0);
          vec2 drift = uWindDirection * uTime * 0.012;

          float base = ridgedFbm(vec3(uv * 0.55 + drift, uTime * 0.008), 5, 2.15, 0.52);
          float detail = fbm(vec3(uv * 1.9 + drift * 1.7, uTime * 0.02), 4, 2.3, 0.5);

          float density = base * 0.78 + detail * 0.22;
          // A cobertura empurra o limiar: 0 = céu limpo, 1 = encoberto.
          //
          // O piso desceu de 0,32 para 0,10 porque 0,32 nunca fechava o céu: no
          // temporal ainda sobravam rasgos de azul entre as nuvens, e um
          // temporal com céu aberto no meio não é um temporal. E a transição
          // aperta junto (de 0,22 para 0,08 de largura) — nuvem de tempestade
          // tem borda dura, ao contrário do algodão de tarde de verão.
          float threshold = mix(0.72, 0.10, uCloudCoverage);
          float edge = mix(0.22, 0.08, uCloudCoverage);
          float alpha = smoothstep(threshold, threshold + edge, density);

          // Some no horizonte para não revelar a borda do plano projetado.
          alpha *= smoothstep(0.02, 0.2, dir.y);

          // Iluminação barata: o gradiente do próprio ruído aproxima a normal.
          float lit = smoothstep(0.35, 0.85, detail * 0.5 + 0.5);
          float sunAlign = max(dot(dir, uSunDirection), 0.0);
          vec3 color = mix(uCloudShadowColor, uCloudSunColor, lit);
          // Borda iluminada quando a nuvem está na frente do sol.
          color += uCloudSunColor * pow(sunAlign, 8.0) * (1.0 - alpha) * 0.9;

          return vec4(color, alpha);
        }

        void main() {
          vec3 dir = normalize(vDirection);

          // A LUT é amostrada com a direção **espelhada** para cima quando o raio
          // aponta para baixo do horizonte.
          //
          // Abaixo da linha do horizonte a integral atmosférica vai a zero e a
          // LUT devolve preto. Isso não aparecia enquanto a névoa era rala, mas
          // o mar acaba em 8 km e o horizonte geométrico está em quase 11: entre
          // os dois há uma faixa em que se vê o domo, e ela se pintava de preto,
          // costurando uma tarja escura entre a água e o céu na tempestade.
          //
          // Espelhar é a aproximação certa: o que existe logo abaixo do horizonte
          // é mar refletindo o céu logo acima dele, então a cor é praticamente a
          // mesma. O erro é imperceptível e a costura some.
          vec3 lutDir = vec3(dir.x, abs(dir.y) * 0.35 + 0.002, dir.z);
          vec3 sky = texture2D(uSkyLut, directionToEquirect(normalize(lutDir))).rgb;
          if (dir.y > 0.0) {
            sky = texture2D(uSkyLut, directionToEquirect(dir)).rgb;
          }

          // Estrelas e lua ficam atrás da atmosfera: somam apenas onde o céu
          // já está escuro, então o dia as apaga naturalmente.
          sky += starField(dir) * uNightFactor;
          sky += moonDisc(dir) * mix(0.35, 1.0, uNightFactor);

          // Halo do sol: complementa o disco geométrico com o brilho difuso.
          float sunAlign = max(dot(dir, uSunDirection), 0.0);
          sky += vec3(1.0, 0.88, 0.68) * pow(sunAlign, 900.0) * 14.0;
          sky += vec3(1.0, 0.7, 0.42) * pow(sunAlign, 42.0) * 0.25;

          vec4 cloud = clouds(dir);
          sky = mix(sky, cloud.rgb, cloud.a);

          gl_FragColor = vec4(sky, 1.0);
        }
      `,
    });
  }

  /**
   * Atualiza o estado do céu.
   * `nightFactor` vai de 0 (dia pleno) a 1 (noite fechada).
   */
  update(
    sunDirection: THREE.Vector3,
    moonDirection: THREE.Vector3,
    sunIntensity: number,
    nightFactor: number,
    time: number,
    windDirection: THREE.Vector2,
  ): void {
    this.domeMaterial.uniforms.uSunDirection!.value.copy(sunDirection);
    this.domeMaterial.uniforms.uMoonDirection!.value.copy(moonDirection);
    this.domeMaterial.uniforms.uNightFactor!.value = nightFactor;
    this.domeMaterial.uniforms.uTime!.value = time;
    this.domeMaterial.uniforms.uWindDirection!.value.copy(windDirection);

    // A LUT só é recomputada quando o sol andou o suficiente para mudar a cor
    // de forma perceptível — economiza ~30 renders de LUT por segundo.
    if (sunDirection.distanceToSquared(this.lastLutSunDirection) > LUT_UPDATE_THRESHOLD * LUT_UPDATE_THRESHOLD) {
      this.lutDirty = true;
    }

    this.lutMaterial.uniforms.uSunDirection!.value.copy(sunDirection);
    this.lutMaterial.uniforms.uSunIntensity!.value = sunIntensity;
    this.lutMaterial.uniforms.uMoonDirection!.value.copy(moonDirection);
    this.lutMaterial.uniforms.uNightFactor!.value = nightFactor;

    // A lua é o sol de novo, quatrocentas mil vezes mais fraca. Esse número
    // exato deixaria a noite invisível: o olho humano se adapta ao escuro e a
    // tela não, então todo jogo exagera a lua. MOON_INTENSITY é a dose que
    // deixa o mar legível sem transformar a noite em tarde azul.
    this.lutMaterial.uniforms.uMoonIntensity!.value =
      MOON_INTENSITY *
      nightFactor *
      THREE.MathUtils.smoothstep(moonDirection.y, -0.06, 0.18);

    // O disco do sol acompanha a direção, sempre longe o bastante para não
    // colidir com nada da cena.
    this.sunMesh.position.copy(sunDirection).multiplyScalar(DOME_RADIUS * 0.85);

    // A radiância do disco vive na cor, não na opacidade: com mistura aditiva as
    // duas fariam exatamente a mesma coisa, e um botão só é mais fácil de
    // calibrar. Ela precisa ficar acima do halo de Mie que a LUT já desenha em
    // volta do sol, senão o olho lê "mancha clara" em vez de "sol".
    //
    // Cai perto do horizonte porque a extinção rasante é real — é o mesmo motivo
    // de dar para encarar o poente e não o meio-dia — e some primeiro no azul,
    // o que deixa o disco alaranjado no fim da tarde sem tabela de cor à mão.
    const horizonFade = THREE.MathUtils.smoothstep(sunDirection.y, 0, 0.2);
    const radiance = THREE.MathUtils.lerp(2.4, 26, horizonFade);
    this.sunMaterial.color.setRGB(
      radiance,
      radiance * THREE.MathUtils.lerp(0.5, 0.97, horizonFade),
      radiance * THREE.MathUtils.lerp(0.2, 0.92, horizonFade),
      // Linear explícito: são valores de radiância, não uma cor de paleta, e
      // passá-los como sRGB aplicaria a curva de transferência por cima.
      THREE.LinearSRGBColorSpace,
    );

    // A opacidade cuida só do sumiço abaixo da linha do horizonte.
    this.sunMaterial.opacity = THREE.MathUtils.clamp(sunDirection.y * 40 + 1, 0, 1);
    this.sunMesh.visible = this.sunMaterial.opacity > 0.01;
  }

  /** Reposiciona o domo e o sol em torno do observador. */
  follow(cameraPosition: THREE.Vector3): void {
    this.dome.position.copy(cameraPosition);
    this.dome.updateMatrix();
    this.dome.updateMatrixWorld(true);
    this.sunMesh.position.add(cameraPosition);
  }

  /** Renderiza a LUT se necessário. Deve rodar antes do render principal. */
  renderLut(renderer: THREE.WebGLRenderer): void {
    if (!this.lutDirty) return;
    this.lutDirty = false;
    this.lutGeneration++;
    this.lastLutSunDirection.copy(this.lutMaterial.uniforms.uSunDirection!.value as THREE.Vector3);

    const previousTarget = renderer.getRenderTarget();
    renderer.setRenderTarget(this.lutTarget);
    renderer.render(this.lutScene, this.lutCamera);
    renderer.setRenderTarget(previousTarget);
  }

  setCloudCoverage(coverage: number): void {
    this.domeMaterial.uniforms.uCloudCoverage!.value = THREE.MathUtils.clamp(coverage, 0, 1);
  }

  setMoonPhase(phase: number): void {
    this.domeMaterial.uniforms.uMoonPhase!.value = phase;
  }

  setCloudColors(sunColor: THREE.Color, shadowColor: THREE.Color): void {
    (this.domeMaterial.uniforms.uCloudSunColor!.value as THREE.Color).copy(sunColor);
    (this.domeMaterial.uniforms.uCloudShadowColor!.value as THREE.Color).copy(shadowColor);
  }

  dispose(): void {
    this.lutTarget.dispose();
    this.lutMaterial.dispose();
    this.domeMaterial.dispose();
    this.sunMaterial.dispose();
    this.dome.geometry.dispose();
    this.sunMesh.geometry.dispose();
  }
}
