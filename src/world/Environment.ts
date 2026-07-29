/**
 * O mundo: mar, céu, hora do dia e luz, costurados num único objeto.
 *
 * Existe para que o resto do jogo não precise saber que o reflexo da água sai
 * da mesma LUT que o céu desenha, nem que a névoa da cena tem que acompanhar a
 * cor do horizonte. Quem estiver de fora só chama `fixedUpdate` no passo da
 * física, `update` no frame, e `sampleHeight` quando quiser saber onde a água
 * está.
 */

import * as THREE from 'three';
import type { QualitySettings, WeatherMode } from '../core/Settings';
import { DayNightCycle } from './DayNightCycle';
import { Ocean } from './Ocean';
import { Rain } from './Rain';
import { Sky } from './Sky';
import { SkyEnvironment } from './SkyEnvironment';
import { MAX_WAVES, WaveField } from './WaveField';
import { Weather } from './Weather';

/**
 * O quanto a luz hemisférica cai quando o IBL entra.
 *
 * Os dois representam a mesma coisa — a luz que chega de todas as direções que
 * não são o sol — e somá-los inteiros lava as sombras. Não é zero porque a
 * hemisférica ainda faz um trabalho que o IBL não faz: ela vem de baixo também,
 * com a cor do mar, e é o que impede o porão de fechar em preto.
 */
const AMBIENT_WITH_IBL = 0.4;

/** Cor do clarão do relâmpago — branco puxando para o azul frio da descarga. */
const LIGHTNING_COLOR = new THREE.Color(0.82, 0.88, 1);
/** Cor do horizonte com o tempo fechado: chumbo levemente esverdeado. */
const STORM_HORIZON = new THREE.Color(0.29, 0.31, 0.33);

export interface EnvironmentOptions {
  /** Duração de um dia completo, em minutos reais. */
  dayLengthMinutes?: number;
  /** Hora inicial, 0..1 (0.34 ≈ meio da manhã). */
  startTimeOfDay?: number;
  /** Semente do espectro de ondas — a mesma semente dá o mesmo mar. */
  seed?: number;
  windDirection?: number;
  windStrength?: number;
}

export class Environment {
  readonly scene: THREE.Scene;
  readonly waveField: WaveField;
  readonly ocean: Ocean;
  readonly sky: Sky;
  readonly dayNight: DayNightCycle;
  /** O tempo: quem decide vento, nuvem, chuva e visibilidade. */
  readonly weather: Weather;
  readonly rain: Rain;

  /**
   * Nasce só no primeiro `prepare`: o `PMREMGenerator` precisa do renderer, que
   * não existe aqui no construtor.
   */
  private skyEnvironment: SkyEnvironment | null = null;
  private useSkyEnvironment: boolean;

  /** Tempo acumulado, usado por animações puramente visuais. */
  private elapsed = 0;
  /**
   * Duração do último frame. O ambiente se regenera por tempo, e `prepare` — que
   * é quem faz isso — não recebe `dt` porque roda no passo de render.
   */
  private frameDt = 1 / 60;
  private readonly windVector = new THREE.Vector2(1, 0);

  constructor(scene: THREE.Scene, quality: QualitySettings, options: EnvironmentOptions = {}) {
    this.scene = scene;

    // Sempre com o campo cheio, e **nunca** em função do preset gráfico: o mar é
    // simulação. Ver a nota em `QualitySettings`.
    this.waveField = new WaveField(
      MAX_WAVES,
      options.seed ?? 1337,
      options.windDirection ?? 0.7,
      options.windStrength ?? 0.65,
    );

    this.ocean = new Ocean(this.waveField, quality);
    this.sky = new Sky();
    this.dayNight = new DayNightCycle(options.dayLengthMinutes ?? 12, options.startTimeOfDay ?? 0.34);
    this.dayNight.setShadowMapSize(quality.shadowMapSize);

    this.weather = new Weather(
      (options.seed ?? 1337) ^ 0x5eed,
      'breeze',
      options.windDirection ?? 0.7,
    );
    this.rain = new Rain();
    scene.add(this.rain.object);

    this.useSkyEnvironment = quality.skyEnvironment;
    this.dayNight.ambientScale = this.useSkyEnvironment ? AMBIENT_WITH_IBL : 1;

    this.ocean.setSkyLut(this.sky.lutTexture);

    // A névoa da cena usa a mesma fórmula do shader do mar (exp do quadrado da
    // distância), então navio e água desaparecem no horizonte no mesmo ritmo.
    this.scene.fog = new THREE.FogExp2(0x88a5be, 1 / 3200);

    scene.add(this.ocean.mesh);
    scene.add(this.sky.dome);
    scene.add(this.sky.sunMesh);
    scene.add(this.dayNight.sunLight);
    scene.add(this.dayNight.sunLight.target);
    scene.add(this.dayNight.moonLight);
    scene.add(this.dayNight.moonLight.target);
    scene.add(this.dayNight.ambientLight);
  }

  /**
   * Passo fixo: só o que a física precisa ver de forma determinística.
   *
   * O tempo entra aqui, e não no quadro, porque a intensidade do vento vira
   * força de vela: se ela variasse com a taxa de quadros, dois computadores
   * dariam velocidades diferentes ao mesmo navio.
   */
  fixedUpdate(dt: number): void {
    this.weather.fixedUpdate(dt);
    this.dayNight.overcast = this.weather.severity;

    // O mar segue o tempo. A intensidade entra direto; o rumo é seguido com
    // atraso pela ondulação de fundo, que é o que produz o mar cruzado.
    this.waveField.windStrength = this.weather.wind;
    this.waveField.followWind(this.weather.direction, dt);
    this.waveField.syncUniforms();

    this.waveField.update(dt);
    this.dayNight.update(dt);
  }

  /** Passo de frame: tudo que é visual e pode variar com o frame rate. */
  update(dt: number, cameraPosition: THREE.Vector3): void {
    this.elapsed += dt;
    this.frameDt = dt;

    this.waveField.getWindVector(this.windVector).normalize();
    this.sky.setCloudCoverage(this.weather.clouds);
    this.rain.update(dt, cameraPosition, this.weather.rain, this.windVector);

    this.sky.update(
      this.dayNight.sunDirection,
      this.dayNight.moonDirection,
      this.dayNight.sunIntensity,
      this.dayNight.nightFactor,
      this.elapsed,
      this.windVector,
    );

    // Nuvem de temporal é **escura**, e escura por um motivo físico: ela é
    // espessa, e o que se vê de baixo é a base dela, que a própria nuvem já
    // sombreou. Sem isto o céu encobria com o mesmo algodão branco de uma tarde
    // de verão, e a tempestade era só um mar mais alto embaixo de um céu bonito.
    const cloudColors = this.dayNight.getCloudColors();
    const gloom = 1 - this.weather.severity * 0.72;
    cloudColors.sun.multiplyScalar(gloom);
    cloudColors.shadow.multiplyScalar(gloom * 0.85);
    this.sky.setCloudColors(cloudColors.sun, cloudColors.shadow);
    this.sky.follow(cameraPosition);

    this.ocean.update(cameraPosition, this.elapsed);
    this.ocean.setLighting(
      this.dayNight.sunDirection,
      this.dayNight.sunLight.color,
      this.dayNight.sunLight.intensity,
      this.dayNight.moonDirection,
      this.dayNight.nightFactor,
    );

    this.dayNight.follow(cameraPosition);

    // --- névoa e clarão ---
    //
    // A densidade sai da distância de visibilidade que o tempo pede. A conta é a
    // inversa da própria fórmula de névoa (`1 − exp(−(d·ρ)²)`): pedindo 95% de
    // ocultação no alcance, ρ = √(−ln 0,05)/alcance. Assim "ver 750 m" significa
    // literalmente ver 750 m, e o número do preset pode ser conferido no olho.
    const density = Math.sqrt(-Math.log(0.05)) / Math.max(this.weather.visibility, 50);
    const fog = this.scene.fog as THREE.FogExp2;
    fog.density = density;
    this.ocean.setFogDensity(density);

    // O horizonte de mau tempo puxa para o chumbo. `lerp` para uma cor fixa, e
    // não uma multiplicação: escurecer sozinho deixaria o horizonte azul-escuro,
    // e o que se vê num temporal é cinza — a nuvem baixa apaga a cor do céu.
    fog.color.copy(this.dayNight.fogColor).lerp(STORM_HORIZON, this.weather.severity * 0.65);
    // O relâmpago lava a cena de branco-azulado. Entra na névoa e na luz
    // ambiente porque é assim que um clarão se comporta de verdade: ele acende o
    // ar, e não a superfície de cada objeto — quem está na sombra do mastro
    // clareia junto com quem está no sol.
    if (this.weather.flash > 0) {
      fog.color.lerp(LIGHTNING_COLOR, this.weather.flash * 0.75);
    }
    this.dayNight.setLightningFlash(this.weather.flash);
  }

  /**
   * Renderiza a LUT atmosférica e, a partir dela, o ambiente de reflexo. Precisa
   * rodar antes do render principal, porque tanto o céu quanto o mar leem essas
   * texturas no mesmo frame.
   */
  prepare(renderer: THREE.WebGLRenderer): void {
    this.sky.renderLut(renderer);
    if (!this.useSkyEnvironment) return;

    this.skyEnvironment ??= new SkyEnvironment(renderer);
    if (this.skyEnvironment.update(renderer, this.sky.lutTexture, this.sky.lutGeneration, this.frameDt)) {
      // O alvo do PMREM é reaproveitado, mas `fromEquirectangular` pode devolver
      // outro na primeira chamada — reatribuir sempre é barato e evita a cena
      // ficar apontando para uma textura descartada.
      this.scene.environment = this.skyEnvironment.texture;
    }
  }

  /**
   * Registra um casco para o mar ser recortado por dentro dele.
   *
   * Chamar uma vez por navio, logo depois de pôr o modelo na cena. Sem isto a
   * superfície do oceano atravessa o forro e o porão fica alagado de mentira.
   */
  addHullClip(object: THREE.Object3D): void {
    this.ocean.addHullClip(object);
  }

  /** Esquece os cascos registrados — ao desmontar a partida. */
  clearHullClips(): void {
    this.ocean.clearHullClips();
  }

  /** Altura da água em (x, z) — o que a flutuabilidade consome. */
  sampleHeight(x: number, z: number): number {
    return this.waveField.sampleHeight(x, z);
  }

  /** Altura + normal da água, para orientar respingos e espuma. */
  sampleSurface(x: number, z: number, outNormal?: THREE.Vector3): number {
    return this.waveField.sampleSurface(x, z, outNormal);
  }

  /**
   * Refaz mar e tempo a partir de uma semente dada.
   *
   * Só o duelo em rede chama isto, e é a peça que garante que os dois lados
   * naveguem **o mesmo mar**: as ondas, as rajadas e a cadeia de transições de
   * clima saem todas de sorteios semeados, então a mesma semente produz o mesmo
   * oceano em qualquer máquina.
   *
   * A contagem de ondas não é parâmetro: são sempre as seis. Ver a nota em
   * `QualitySettings`.
   */
  reseed(seed: number): void {
    this.waveField.generate(MAX_WAVES, seed);
    this.waveField.time = 0;
    this.waveField.syncUniforms();
    this.weather.reseed(seed ^ 0x5eed);
  }

  applyQuality(quality: QualitySettings): void {
    this.ocean.applyQuality(quality);
    this.dayNight.setShadowMapSize(quality.shadowMapSize);
    // O campo de ondas **não** é regerado aqui. Trocar de preset no meio de uma
    // partida trocava o mar debaixo de um tiro em voo. Ver `QualitySettings`.

    this.useSkyEnvironment = quality.skyEnvironment;
    this.dayNight.ambientScale = this.useSkyEnvironment ? AMBIENT_WITH_IBL : 1;
    if (!this.useSkyEnvironment) {
      this.scene.environment = null;
      this.skyEnvironment?.dispose();
      this.skyEnvironment = null;
    }
  }

  /**
   * Trava o tempo num estado, ou o solta para virar sozinho.
   *
   * Travar não congela o mundo: o vento continua girando e as rajadas continuam
   * vindo, porque o que a opção promete é "o mar fica assim", e não "nada mais
   * acontece". O que ela desliga é a transição para outro estado.
   */
  setWeatherMode(mode: WeatherMode): void {
    if (mode === 'dynamic') {
      this.weather.locked = false;
      return;
    }
    this.weather.set(mode);
    this.weather.locked = true;
  }

  /** Muda o vento: reordena as ondas e reescala a amplitude do mar. */
  setWind(direction: number, strength: number): void {
    this.waveField.windDirection = direction;
    this.waveField.windStrength = strength;
    this.waveField.syncUniforms();
  }

  dispose(): void {
    this.ocean.dispose();
    this.sky.dispose();
    this.rain.dispose();
    this.skyEnvironment?.dispose();
    this.scene.environment = null;
  }
}
