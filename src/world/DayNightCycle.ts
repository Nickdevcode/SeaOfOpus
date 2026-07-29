/**
 * Ciclo dia/noite completo: órbita do sol e da lua, cor e intensidade da luz,
 * ambiente, névoa e nuvens.
 *
 * A cor da luz direcional não é uma rampa pintada à mão — ela sai da mesma
 * física do céu. Quanto mais baixo o sol, mais atmosfera a luz atravessa
 * ("massa de ar"), e o azul é espalhado para fora primeiro. É por isso que o
 * poente fica laranja sozinho, sem ninguém escolher a cor.
 */

import * as THREE from 'three';
import { clamp, clamp01, smoothstep, TAU } from '../core/MathUtils';

/**
 * Coeficientes de Rayleigh integrados na espessura da atmosfera.
 * São os mesmos do shader (`atmosphere.ts`), multiplicados pela altura de
 * escala de 8 km — mantê-los em sincronia é o que faz a luz da cena casar com
 * a cor do céu renderizado.
 */
const RAYLEIGH_OPTICAL_DEPTH = new THREE.Vector3(0.044, 0.104, 0.179);

/** Inclinação do plano orbital: impede o sol de cruzar o zênite exato. */
const ORBIT_TILT = 0.38;

// Paleta fixa do ciclo. São constantes de módulo, e não literais dentro dos
// métodos, porque `update` roda a 60 Hz: alocar meia dúzia de Color por quadro
// dá algumas centenas de objetos por segundo só para o GC recolher depois.
const AMBIENT_SKY_DAY = new THREE.Color(0.55, 0.72, 0.95);
// Mais claro e mais azul que os (0,05 · 0,08 · 0,16) de antes. O céu noturno
// real não é preto: é azul-marinho, e é dele que vem quase tudo que se enxerga
// num convés à noite.
const AMBIENT_SKY_NIGHT = new THREE.Color(0.11, 0.16, 0.3);
/** Cor do clarão do relâmpago aplicada à luz ambiente. */
const LIGHTNING_TINT = new THREE.Color(0.85, 0.9, 1);
const AMBIENT_TWILIGHT = new THREE.Color(0.95, 0.55, 0.35);
const HORIZON_DAY = new THREE.Color(0.62, 0.74, 0.88);
const HORIZON_NIGHT = new THREE.Color(0.035, 0.055, 0.1);
const HORIZON_TWILIGHT = new THREE.Color(0.85, 0.45, 0.28);
const CLOUD_SHADOW_TINT = new THREE.Color(0.25, 0.29, 0.4);
const NIGHT_CLOUD_LIT = new THREE.Color(0.1, 0.12, 0.18);
const NIGHT_CLOUD_SHADOW = new THREE.Color(0.02, 0.026, 0.045);

export class DayNightCycle {
  /** 0 = meia-noite, 0.25 = amanhecer, 0.5 = meio-dia, 0.75 = entardecer. */
  timeOfDay: number;
  /** Duração de um dia completo, em segundos reais. */
  dayLengthSeconds: number;
  /** Congela o relógio (usado pelo menu, que fica num poente fixo). */
  paused = false;

  readonly sunDirection = new THREE.Vector3(0, 1, 0);
  readonly moonDirection = new THREE.Vector3(0, -1, 0);

  readonly sunLight: THREE.DirectionalLight;
  readonly moonLight: THREE.DirectionalLight;
  readonly ambientLight: THREE.HemisphereLight;

  /**
   * Multiplicador da luz hemisférica.
   *
   * Quando existe um mapa de ambiente na cena, o céu já entra no difuso de todo
   * material pelo IBL — manter a hemisférica na intensidade cheia contaria a
   * mesma luz duas vezes e lavaria as sombras. Ela não some porque continua
   * sendo o piso de iluminação no preset Baixo, onde o IBL é desligado.
   */
  ambientScale = 1;

  /**
   * Quanto o céu está encoberto, 0..1. Quem escreve é o `Weather`.
   *
   * Não é decoração: nuvem bloqueia sol. Sem este fator a tempestade tinha um
   * céu de chumbo com **sombras nítidas de meio-dia** projetadas no convés, que
   * é a contradição visual mais fácil de notar num jogo de barco. Aqui ele corta
   * a direcional (as sombras somem e a luz vira difusa) e derruba a intensidade
   * que alimenta a LUT atmosférica, o que escurece o domo e, por tabela, o
   * reflexo do mar — que lê a mesma textura.
   */
  overcast = 0;

  /** 0 no dia pleno, 1 na noite fechada. Usado por estrelas e lanternas. */
  nightFactor = 0;
  /** Cor da névoa, casada com o horizonte do céu. */
  readonly fogColor = new THREE.Color();
  /** Intensidade do sol passada à LUT atmosférica. */
  sunIntensity = 22;

  private readonly scattered = new THREE.Color();
  /** Clarão do relâmpago neste quadro, 0..1. */
  private flash = 0;

  constructor(dayLengthMinutes = 12, startTimeOfDay = 0.34) {
    this.dayLengthSeconds = dayLengthMinutes * 60;
    this.timeOfDay = startTimeOfDay;

    this.sunLight = new THREE.DirectionalLight(0xffffff, 3);
    this.sunLight.castShadow = true;
    this.configureShadow(this.sunLight);

    // A lua não projeta sombra: o ganho visual não paga um segundo shadow map.
    this.moonLight = new THREE.DirectionalLight(0xb9cbe8, 0.12);
    this.moonLight.castShadow = false;

    this.ambientLight = new THREE.HemisphereLight(0x9dc4e0, 0x0d3040, 0.6);
  }

  private configureShadow(light: THREE.DirectionalLight): void {
    const camera = light.shadow.camera;
    // O frustum cobre o navio e um pouco de mar em volta; ele segue o jogador
    // em `update`, então não precisa ser grande.
    camera.left = -34;
    camera.right = 34;
    camera.top = 34;
    camera.bottom = -34;
    camera.near = 1;
    camera.far = 220;

    light.shadow.bias = -0.0006;
    light.shadow.normalBias = 0.05;
    light.shadow.radius = 2.5;
  }

  setShadowMapSize(size: number): void {
    this.sunLight.castShadow = size > 0;
    if (size > 0) {
      this.sunLight.shadow.mapSize.set(size, size);
      this.sunLight.shadow.map?.dispose();
      this.sunLight.shadow.map = null;
    }
  }

  update(dt: number): void {
    if (!this.paused) {
      this.timeOfDay = (this.timeOfDay + dt / this.dayLengthSeconds) % 1;
    }

    // Ângulo orbital: em timeOfDay 0.25 o sol está no horizonte leste.
    const angle = (this.timeOfDay - 0.25) * TAU;
    const cosT = Math.cos(ORBIT_TILT);
    const sinT = Math.sin(ORBIT_TILT);

    this.sunDirection
      .set(Math.cos(angle), Math.sin(angle) * cosT, Math.sin(angle) * sinT)
      .normalize();

    // A lua fica oposta ao sol, com um deslocamento que evita eclipse perfeito.
    const moonAngle = angle + Math.PI + 0.22;
    this.moonDirection
      .set(Math.cos(moonAngle), Math.sin(moonAngle) * cosT, Math.sin(moonAngle) * sinT * -1)
      .normalize();

    const elevation = this.sunDirection.y;

    // Transição dia→noite centrada no horizonte, com a largura do crepúsculo.
    this.nightFactor = 1 - smoothstep(-0.14, 0.1, elevation);

    this.updateSunLight(elevation);
    this.updateMoonLight();
    this.updateAmbient(elevation);
    this.updateFog(elevation);

    this.sunIntensity = 22 * clamp01(elevation * 3 + 0.25) * (1 - this.overcast * 0.72);
  }

  /**
   * Cor e intensidade da luz solar a partir da massa de ar atravessada.
   *
   * `airMass ≈ 1/sin(elevação)`: no zênite a luz cruza uma atmosfera; rasante,
   * cruza dezenas. O `+0.06` no denominador evita a singularidade e aproxima a
   * curvatura da Terra, que é o que impede a luz de ficar preta no horizonte.
   */
  private updateSunLight(elevation: number): void {
    const airMass = 1 / Math.max(elevation + 0.06, 0.06);

    const r = Math.exp(-RAYLEIGH_OPTICAL_DEPTH.x * airMass);
    const g = Math.exp(-RAYLEIGH_OPTICAL_DEPTH.y * airMass);
    const b = Math.exp(-RAYLEIGH_OPTICAL_DEPTH.z * airMass);

    this.sunLight.color.setRGB(r, g, b);

    // A intensidade cai antes de o disco sumir: o sol já não ilumina muito
    // quando raspa o horizonte.
    // O encoberto corta a direcional quase inteira: com o céu fechado o que
    // sobra é luz difusa, e é por isso que num temporal nada projeta sombra.
    const strength = smoothstep(-0.08, 0.28, elevation) * (1 - this.overcast * 0.88);
    this.sunLight.intensity = 3.4 * strength;
    this.sunLight.visible = this.sunLight.intensity > 0.01;

    // A luz aponta da direção do sol para a origem; a posição é reposicionada
    // em `follow` para acompanhar o jogador.
    this.sunLight.position.copy(this.sunDirection).multiplyScalar(120);
  }

  /**
   * Luz da lua.
   *
   * **0,95, e não os 0,22 de antes.** A noite estava impossível de jogar: com
   * um quinto de candela de lua e a hemisférica caindo para 0,11, o convés
   * inteiro ficava abaixo do limiar em que um monitor comum consegue mostrar
   * diferença de tom, e o jogador não enxergava a própria amurada.
   *
   * A tentação é resolver isso subindo o ambiente, e é o caminho errado: luz
   * ambiente ilumina tudo por igual e apaga o relevo, então a noite fica clara e
   * **chapada**. A lua é direcional — ela dá aresta, sombra e brilho no metal.
   * Subindo a lua a noite fica legível continuando a parecer noite, que é o que
   * o Sea of Thieves faz e é por isso que a noite lá é bonita em vez de cega.
   *
   * Ainda são 3,5 vezes menos que o sol de meio-dia, então ninguém confunde as
   * duas.
   */
  private updateMoonLight(): void {
    const elevation = this.moonDirection.y;
    const strength = smoothstep(-0.05, 0.3, elevation) * this.nightFactor;
    this.moonLight.intensity = 0.95 * strength;
    this.moonLight.visible = this.moonLight.intensity > 0.005;
    this.moonLight.position.copy(this.moonDirection).multiplyScalar(120);
  }

  /**
   * Clarão do relâmpago, 0..1.
   *
   * Entra na luz ambiente e não numa fonte nova: um raio a quilômetros de
   * distância acende o **ar**, e o que chega ao navio vem do céu inteiro, de
   * todas as direções ao mesmo tempo. Uma direcional daria sombras nítidas
   * apontando para um ponto do horizonte, que é o oposto do que se vê.
   */
  setLightningFlash(flash: number): void {
    this.flash = flash;
  }

  /**
   * Luz ambiente hemisférica: céu por cima, reflexo do mar por baixo.
   * É o que impede as sombras de virarem buracos pretos.
   */
  private updateAmbient(elevation: number): void {
    const day = smoothstep(-0.12, 0.22, elevation);

    // Céu: azul claro de dia, azul-marinho profundo à noite.
    this.ambientLight.color.copy(AMBIENT_SKY_DAY).lerp(AMBIENT_SKY_NIGHT, 1 - day);

    // Chão: a cor que o mar devolve para baixo do navio.
    this.ambientLight.groundColor.setRGB(0.06, 0.19, 0.24).multiplyScalar(0.35 + day * 0.65);

    // No crepúsculo o ambiente ganha um empurrão quente do céu alaranjado.
    const twilight = smoothstep(0.22, 0.0, Math.abs(elevation)) * 0.5;
    this.ambientLight.color.lerp(AMBIENT_TWILIGHT, twilight * 0.45);

    // O piso noturno subiu de 0,28 para 0,46: o suficiente para as sombras
    // pararem de fechar em preto sem chapar o relevo, que é trabalho da lua.
    // Ver `updateMoonLight` para o porquê de o grosso do ganho ir para lá.
    let intensity = (0.46 + day * 0.62) * this.ambientScale;

    // O relâmpago multiplica o ambiente por até cinco. É brutal de propósito: um
    // clarão que não cega por um instante não é um clarão.
    if (this.flash > 0) {
      intensity *= 1 + this.flash * 4;
      this.ambientLight.color.lerp(LIGHTNING_TINT, this.flash * 0.8);
    }

    this.ambientLight.intensity = intensity;
  }

  /**
   * Cor da névoa aproximando o céu junto ao horizonte.
   *
   * Não lemos a LUT da GPU de propósito: `readPixels` força sincronização e
   * come vários milissegundos por frame. Esta aproximação usa os mesmos
   * coeficientes de Rayleigh, então converge visualmente com o céu renderizado.
   */
  private updateFog(elevation: number): void {
    const airMass = 1 / Math.max(elevation + 0.06, 0.06);

    // O que foi espalhado para fora do feixe direto é o que colore o horizonte.
    this.scattered.setRGB(
      (1 - Math.exp(-RAYLEIGH_OPTICAL_DEPTH.x * airMass * 0.55)) * 0.55,
      (1 - Math.exp(-RAYLEIGH_OPTICAL_DEPTH.y * airMass * 0.55)) * 0.62,
      (1 - Math.exp(-RAYLEIGH_OPTICAL_DEPTH.z * airMass * 0.55)) * 0.78,
    );

    const day = smoothstep(-0.12, 0.25, elevation);

    this.fogColor
      .copy(HORIZON_NIGHT)
      .lerp(HORIZON_DAY, day)
      .lerp(this.scattered, clamp(0.35 + (1 - day) * 0.25, 0, 0.7));

    // Empurrão quente no crepúsculo, quando o horizonte pega fogo.
    const twilight = smoothstep(0.2, -0.02, Math.abs(elevation - 0.02));
    this.fogColor.lerp(HORIZON_TWILIGHT, twilight * 0.5);
  }

  /** Cor de topo e de base das nuvens para o shader do céu. */
  getCloudColors(): { sun: THREE.Color; shadow: THREE.Color } {
    const sun = this.sunLight.color.clone().multiplyScalar(0.9 + this.sunLight.intensity * 0.12);
    const shadow = this.fogColor.clone().lerp(CLOUD_SHADOW_TINT, 0.5);

    if (this.nightFactor > 0.5) {
      // Nuvem à noite é escura, não cinza-clara: a única luz que recebe é a da
      // lua, ordens de grandeza abaixo do sol. Quem a torna visível é a
      // silhueta contra as estrelas, não o próprio brilho — desenhá-la clara
      // demais apaga o céu estrelado atrás dela.
      const t = (this.nightFactor - 0.5) * 2;
      sun.lerp(NIGHT_CLOUD_LIT, t);
      shadow.lerp(NIGHT_CLOUD_SHADOW, t);
    }
    return { sun, shadow };
  }

  /**
   * Reposiciona as luzes em torno do alvo para que o shadow map, que é
   * pequeno, sempre cubra o navio do jogador.
   */
  follow(target: THREE.Vector3): void {
    this.sunLight.position.copy(this.sunDirection).multiplyScalar(120).add(target);
    this.sunLight.target.position.copy(target);
    this.sunLight.target.updateMatrixWorld();

    this.moonLight.position.copy(this.moonDirection).multiplyScalar(120).add(target);
    this.moonLight.target.position.copy(target);
    this.moonLight.target.updateMatrixWorld();
  }

  /** Rótulo do horário para o HUD, no formato 24 h. */
  getClockLabel(): string {
    const totalMinutes = this.timeOfDay * 24 * 60;
    const hours = Math.floor(totalMinutes / 60) % 24;
    const minutes = Math.floor(totalMinutes % 60);
    return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}`;
  }
}
