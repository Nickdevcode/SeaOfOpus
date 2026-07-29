/**
 * Todo o som do jogo, **sintetizado em código**. Nenhum arquivo de áudio.
 *
 * A escolha não é economia: é a mesma que o resto do projeto já fez. O casco é uma
 * função, as texturas nascem de canvas 2D, o oceano é um espectro de ondas. Um
 * `.wav` de canhão aqui seria o único asset opaco de um projeto inteiro que se
 * explica sozinho — e ainda traria licença, download e um número mágico (a duração
 * do arquivo) impossível de justificar num comentário.
 *
 * Sintetizado, cada som é uma descrição do fenômeno. Uma canhonada é um transiente
 * de pressão (ruído de banda larga com ataque de milissegundos) sobre uma cavidade
 * de baixa frequência (a coluna de ar do cano). Escrito assim, dá para **ajustar o
 * físico**: a distância não baixa só o volume, ela fecha o filtro, porque é o agudo
 * que o ar come primeiro. É por isso que um tiro a 150 m soa como um trovão surdo e
 * o mesmo tiro a 10 m estala.
 *
 * ## A arquitetura, em uma frase
 *
 * `fonte → painel (pan + distância) → seco ─┬→ mestre → compressor → saída`
 * `                                          └→ reverberação → mestre`
 *
 * A reverberação é uma convolução com uma resposta ao impulso **gerada aqui**:
 * ruído com decaimento exponencial, escuro e curto. Não é a acústica de uma sala —
 * mar aberto não tem paredes —, é a cauda que o próprio ar e a superfície da água
 * devolvem. Sem ela os tiros soam como cliques no vácuo; com ela, ganham espaço.
 *
 * ## Por que o pan e a atenuação são feitos à mão
 *
 * A Web Audio tem `PannerNode` com HRTF e modelo de distância. Ele exige manter um
 * `AudioListener` sincronizado com a câmera todo quadro e, em troca, entrega uma
 * espacialização que num jogo de tela é quase indistinguível de um `StereoPanner`
 * mais um ganho. O caminho manual custa três linhas, deixa a curva de distância
 * explícita (e portanto ajustável) e permite o filtro de absorção do ar, que o
 * modelo embutido não faz.
 */

import * as THREE from 'three';
import { clamp, clamp01 } from '../core/MathUtils';
import { settings } from '../core/Settings';

/** Alcance em que um som deixa de ser audível, em metros. */
const MAX_AUDIBLE = 320;
/**
 * Distância de referência da atenuação, em metros.
 *
 * Dentro dela o som não fica mais alto — é o raio da própria fonte. Sem esse piso,
 * a curva `1/d` explode quando a distância tende a zero e um tiro do canhão ao lado
 * estouraria a saída.
 */
const REFERENCE_DISTANCE = 12;

/** Corte do filtro de ar: aberto de perto, fechado de longe, em Hz. */
const AIR_NEAR_HZ = 18000;
const AIR_FAR_HZ = 700;

/** Duração da cauda de reverberação, em segundos. */
const REVERB_SECONDS = 1.9;

/** Uma fonte pontual já resolvida em pan, ganho e abafamento. */
interface Placement {
  pan: number;
  gain: number;
  cutoff: number;
}

const _toSource = new THREE.Vector3();
const _right = new THREE.Vector3();

export class GameAudio {
  private context: AudioContext | null = null;
  private master!: GainNode;
  private reverbSend!: GainNode;
  private noise!: AudioBuffer;

  /** Camadas contínuas: mar e vento. */
  private seaGain: GainNode | null = null;
  private windGain: GainNode | null = null;
  private windFilter: BiquadFilterNode | null = null;

  /** Câmera, para orientar o pan. Trocada a cada quadro por `setListener`. */
  private readonly listenerPosition = new THREE.Vector3();
  private readonly listenerQuaternion = new THREE.Quaternion();

  /** `true` depois do primeiro gesto do jogador, quando o contexto pôde abrir. */
  get ready(): boolean {
    return this.context !== null && this.context.state === 'running';
  }

  /**
   * Abre o contexto de áudio. **Precisa ser chamada dentro de um gesto do
   * jogador** — todo navegador atual recusa iniciar áudio sem isso, e é a razão de
   * o construtor não fazer nada.
   */
  unlock(): void {
    if (this.context) {
      if (this.context.state === 'suspended') void this.context.resume();
      return;
    }

    const Constructor: typeof AudioContext | undefined =
      window.AudioContext ??
      (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!Constructor) return;

    const context = new Constructor();
    this.context = context;

    this.master = context.createGain();
    this.master.gain.value = settings.preferences.masterVolume;

    // Compressor no mestre: uma bordada dupla mais um respingo somam picos que
    // saturariam a saída. Ataque rápido para pegar o transiente do tiro, joelho
    // largo para a compressão não ser audível como "bombeamento".
    const compressor = context.createDynamicsCompressor();
    compressor.threshold.value = -14;
    compressor.knee.value = 22;
    compressor.ratio.value = 3.5;
    compressor.attack.value = 0.004;
    compressor.release.value = 0.22;

    this.master.connect(compressor);
    compressor.connect(context.destination);

    const convolver = context.createConvolver();
    convolver.buffer = this.buildImpulse(context);
    this.reverbSend = context.createGain();
    this.reverbSend.gain.value = 1;
    this.reverbSend.connect(convolver);
    convolver.connect(this.master);

    this.noise = this.buildNoise(context);
    this.startAmbience(context);

    settings.onChange((prefs) => {
      if (this.master) this.master.gain.value = prefs.masterVolume;
    });
  }

  /** Onde está o ouvido. Chamar uma vez por quadro, com a câmera. */
  setListener(camera: THREE.Camera): void {
    this.listenerPosition.copy(camera.position);
    this.listenerQuaternion.copy(camera.quaternion);
  }

  /** Intensidade das camadas contínuas, do estado do mar. */
  setSeaState(windStrength: number, nightFactor: number): void {
    if (!this.context) return;

    const now = this.context.currentTime;
    // O vento fica mais agudo e mais forte com a intensidade — é o assobio no
    // cordame, e ele é o que dá ao jogador a sensação de velocidade.
    this.windFilter?.frequency.setTargetAtTime(400 + windStrength * 1400, now, 0.6);
    this.windGain?.gain.setTargetAtTime(0.055 + windStrength * 0.075, now, 0.8);
    // O mar abafa um pouco à noite: menos brilho, mais peso. É convenção de mixagem
    // de jogo, e o ouvido aceita porque combina com a vista escurecendo.
    this.seaGain?.gain.setTargetAtTime(0.1 - nightFactor * 0.02, now, 1.2);
  }

  // -- sons do combate ---------------------------------------------------------

  /**
   * Canhonada.
   *
   * Três camadas, e cada uma responde por uma parte do fenômeno: o estalo do
   * transiente (ruído em banda larga, 6 ms de ataque), o corpo da carga (ruído
   * filtrado, decaimento de meio segundo) e a cavidade do cano (uma senoide
   * descendo de 110 para 40 Hz, que é o que se sente no peito).
   */
  cannonFire(position: THREE.Vector3): void {
    const at = this.place(position);
    if (!at) return;

    this.burst(at, {
      gain: 0.85,
      attack: 0.006,
      decay: 0.55,
      type: 'lowpass',
      frequency: Math.min(at.cutoff, 2600),
      q: 0.7,
    });
    this.burst(at, {
      gain: 0.4,
      attack: 0.001,
      decay: 0.09,
      type: 'highpass',
      frequency: 1500,
      q: 0.6,
    });
    this.thump(at, 110, 40, 0.6, 0.7);
  }

  /** Respingo de bala na água. Mais rápido e mais agudo quanto mais forte o impacto. */
  splash(position: THREE.Vector3, speed: number): void {
    const at = this.place(position);
    if (!at) return;

    const force = clamp01(speed / 90);
    this.burst(at, {
      gain: 0.3 + force * 0.3,
      attack: 0.004,
      decay: 0.16 + force * 0.2,
      type: 'bandpass',
      frequency: Math.min(at.cutoff, 900 + force * 1500),
      q: 0.9,
      // Cai enquanto soa: a coluna de água sobe e desaba, e o espectro desce com
      // ela. Sem a varredura o respingo soa como um "chh" de fita, não como água.
      sweepTo: 320,
    });
  }

  /**
   * Bala na madeira.
   *
   * `flooded` distingue os dois eventos que o jogo trata como diferentes: rombo
   * abaixo do convés ganha um golpe grave por baixo, porque é o que o jogador
   * precisa **ouvir** para saber que vai ter de descer ao porão.
   */
  woodImpact(position: THREE.Vector3, speed: number, flooded: boolean): void {
    const at = this.place(position);
    if (!at) return;

    const force = clamp01(speed / 90);
    this.burst(at, {
      gain: 0.5 + force * 0.35,
      attack: 0.001,
      decay: 0.13,
      type: 'bandpass',
      frequency: Math.min(at.cutoff, 1100),
      q: 1.6,
      sweepTo: 420,
    });
    if (flooded) this.thump(at, 78, 34, 0.42, 0.55);
  }

  /** Bala no mastro: o mesmo estalo, com um ressoar longo de tronco. */
  mastHit(position: THREE.Vector3, speed: number): void {
    const at = this.place(position);
    if (!at) return;

    const force = clamp01(speed / 90);
    this.burst(at, {
      gain: 0.45 + force * 0.3,
      attack: 0.001,
      decay: 0.1,
      type: 'bandpass',
      frequency: Math.min(at.cutoff, 1800),
      q: 2.4,
    });
    // Um tronco de 12 m preso no porão ressoa grave e demora a calar.
    this.thump(at, 190, 120, 0.9, 0.3);
  }

  /** Os dois cascos se encostando. Rangido e baque, na medida da pancada. */
  collision(position: THREE.Vector3, speed: number): void {
    const at = this.place(position);
    if (!at) return;

    const force = clamp01(speed / 4);
    this.burst(at, {
      gain: 0.4 + force * 0.4,
      attack: 0.02,
      decay: 0.45 + force * 0.3,
      type: 'lowpass',
      frequency: Math.min(at.cutoff, 700),
      q: 1.1,
    });
    this.thump(at, 60, 28, 0.7, 0.6);
  }

  // -- interface ---------------------------------------------------------------

  /** Cliques do menu. Latão, curto, sem cauda. */
  ui(kind: 'move' | 'confirm' | 'back'): void {
    if (!this.context) return;
    const at: Placement = { pan: 0, gain: 0.32, cutoff: AIR_NEAR_HZ };

    if (kind === 'move') {
      this.tone(at, 880, 880, 0.05, 0.1, 'triangle');
      return;
    }
    if (kind === 'confirm') {
      // Duas notas de latão em quinta: som de aprovação sem virar jingle.
      this.tone(at, 660, 660, 0.09, 0.16, 'triangle');
      this.tone(at, 990, 990, 0.14, 0.12, 'triangle', 0.05);
      return;
    }
    this.tone(at, 420, 300, 0.1, 0.14, 'triangle');
  }

  /** Fanfarra curta de fim de partida. */
  outcome(won: boolean): void {
    if (!this.context) return;
    const at: Placement = { pan: 0, gain: 0.4, cutoff: AIR_NEAR_HZ };

    if (won) {
      // Tríade maior ascendente, espaçada: vitória sem soletrar.
      const notes = [392, 494, 587, 784];
      notes.forEach((hz, i) => this.tone(at, hz, hz, 0.9, 0.16, 'triangle', i * 0.13));
      return;
    }
    // Derrota: duas notas descendo, a segunda desafinada para baixo. O intervalo
    // que não fecha é o que soa como perda.
    this.tone(at, 330, 320, 1.1, 0.2, 'sine');
    this.tone(at, 233, 208, 1.6, 0.22, 'sine', 0.22);
  }

  dispose(): void {
    void this.context?.close();
    this.context = null;
  }

  // -- primitivas --------------------------------------------------------------

  /**
   * Resolve uma posição do mundo em pan, ganho e corte de ar.
   *
   * @returns `null` quando o contexto não abriu ou a fonte está longe demais para
   *   valer um nó de áudio — descartar aqui é o que impede uma bordada distante de
   *   criar seis osciladores inaudíveis.
   */
  private place(position: THREE.Vector3): Placement | null {
    if (!this.context) return null;

    _toSource.subVectors(position, this.listenerPosition);
    const distance = _toSource.length();
    if (distance > MAX_AUDIBLE) return null;

    // Atenuação inversa com distância de referência, e um corte suave no fim do
    // alcance para o som não desaparecer num degrau.
    const attenuation = REFERENCE_DISTANCE / Math.max(distance, REFERENCE_DISTANCE);
    const fade = 1 - clamp01((distance - MAX_AUDIBLE * 0.6) / (MAX_AUDIBLE * 0.4));
    const gain = attenuation * fade;
    if (gain < 0.002) return null;

    // Pan pela projeção no eixo "direita" da câmera. Normalizado pela distância,
    // então a fonte encostada no ouvido não estoura para um lado só.
    _right.set(1, 0, 0).applyQuaternion(this.listenerQuaternion);
    const pan = distance > 1e-3 ? clamp(_toSource.dot(_right) / distance, -1, 1) : 0;

    // Absorção do ar: o agudo morre primeiro, e é ele que diz "isso está longe".
    // Exponencial porque a absorção é em dB por metro, não linear.
    const cutoff = AIR_FAR_HZ + (AIR_NEAR_HZ - AIR_FAR_HZ) * Math.pow(1 - clamp01(distance / MAX_AUDIBLE), 2.2);

    return { pan, gain, cutoff };
  }

  /** Cadeia comum de saída: pan → seco + envio de reverberação. */
  private connect(source: AudioNode, at: Placement, wet: number): void {
    const context = this.context!;
    const panner = context.createStereoPanner();
    panner.pan.value = at.pan;
    source.connect(panner);
    panner.connect(this.master);

    const send = context.createGain();
    // Mais reverberação quanto mais longe: é assim que o ouvido mede distância em
    // espaço aberto, muito mais que pelo volume.
    send.gain.value = wet * (0.25 + 0.75 * (1 - at.gain));
    panner.connect(send);
    send.connect(this.reverbSend);
  }

  /** Rajada de ruído filtrado, com envelope de ataque e decaimento exponencial. */
  private burst(
    at: Placement,
    options: {
      gain: number;
      attack: number;
      decay: number;
      type: BiquadFilterType;
      frequency: number;
      q: number;
      sweepTo?: number;
    },
  ): void {
    const context = this.context!;
    const now = context.currentTime;

    const source = context.createBufferSource();
    source.buffer = this.noise;
    // Ponto de partida aleatório no buffer: dois tiros seguidos com o mesmo trecho
    // de ruído soam como o mesmo som repetido, e o ouvido pega isso na hora.
    const offset = Math.random() * (this.noise.duration - options.decay - 0.05);

    const filter = context.createBiquadFilter();
    filter.type = options.type;
    filter.frequency.value = options.frequency;
    filter.Q.value = options.q;
    if (options.sweepTo !== undefined) {
      filter.frequency.setValueAtTime(options.frequency, now);
      filter.frequency.exponentialRampToValueAtTime(
        Math.max(options.sweepTo, 40),
        now + options.decay,
      );
    }

    const envelope = context.createGain();
    envelope.gain.setValueAtTime(0.0001, now);
    envelope.gain.exponentialRampToValueAtTime(
      Math.max(options.gain * at.gain, 0.0002),
      now + options.attack,
    );
    envelope.gain.exponentialRampToValueAtTime(0.0001, now + options.attack + options.decay);

    source.connect(filter);
    filter.connect(envelope);
    this.connect(envelope, at, 0.5);

    source.start(now, Math.max(offset, 0), options.attack + options.decay + 0.05);
    source.stop(now + options.attack + options.decay + 0.05);
  }

  /** Golpe de baixa frequência: senoide varrendo para baixo. O peso do tiro. */
  private thump(at: Placement, fromHz: number, toHz: number, decay: number, gain: number): void {
    const context = this.context!;
    const now = context.currentTime;

    const oscillator = context.createOscillator();
    oscillator.type = 'sine';
    oscillator.frequency.setValueAtTime(fromHz, now);
    oscillator.frequency.exponentialRampToValueAtTime(Math.max(toHz, 20), now + decay);

    const envelope = context.createGain();
    envelope.gain.setValueAtTime(0.0001, now);
    envelope.gain.exponentialRampToValueAtTime(Math.max(gain * at.gain, 0.0002), now + 0.01);
    envelope.gain.exponentialRampToValueAtTime(0.0001, now + decay);

    oscillator.connect(envelope);
    this.connect(envelope, at, 0.3);

    oscillator.start(now);
    oscillator.stop(now + decay + 0.02);
  }

  /** Nota simples, para a interface. */
  private tone(
    at: Placement,
    fromHz: number,
    toHz: number,
    decay: number,
    gain: number,
    type: OscillatorType,
    delay = 0,
  ): void {
    const context = this.context!;
    const start = context.currentTime + delay;

    const oscillator = context.createOscillator();
    oscillator.type = type;
    oscillator.frequency.setValueAtTime(fromHz, start);
    if (toHz !== fromHz) {
      oscillator.frequency.exponentialRampToValueAtTime(Math.max(toHz, 20), start + decay);
    }

    const envelope = context.createGain();
    envelope.gain.setValueAtTime(0.0001, start);
    envelope.gain.exponentialRampToValueAtTime(Math.max(gain * at.gain, 0.0002), start + 0.008);
    envelope.gain.exponentialRampToValueAtTime(0.0001, start + decay);

    oscillator.connect(envelope);
    this.connect(envelope, at, 0.4);

    oscillator.start(start);
    oscillator.stop(start + decay + 0.02);
  }

  // -- ambiência ---------------------------------------------------------------

  /**
   * Mar e vento, em laço contínuo.
   *
   * Os dois saem do **mesmo** buffer de ruído, com filtros diferentes: o mar é um
   * passa-baixa largo com o corte oscilando devagar (a respiração das vagas), o
   * vento é um passa-banda mais agudo. Reaproveitar o buffer economiza os segundos
   * de ruído que seriam gerados duas vezes, e nenhum ouvido identifica a origem
   * comum depois de filtros tão distantes.
   */
  private startAmbience(context: AudioContext): void {
    // --- mar ---
    const sea = context.createBufferSource();
    sea.buffer = this.noise;
    sea.loop = true;

    const seaFilter = context.createBiquadFilter();
    seaFilter.type = 'lowpass';
    seaFilter.frequency.value = 520;
    seaFilter.Q.value = 0.6;

    // LFO no corte: sem ele o mar é um chuveiro parado. 0,08 Hz dá uma vaga a cada
    // doze segundos, que é a escala do próprio espectro de ondas do jogo.
    const swell = context.createOscillator();
    swell.frequency.value = 0.08;
    const swellDepth = context.createGain();
    swellDepth.gain.value = 220;
    swell.connect(swellDepth);
    swellDepth.connect(seaFilter.frequency);
    swell.start();

    this.seaGain = context.createGain();
    this.seaGain.gain.value = 0.1;

    sea.connect(seaFilter);
    seaFilter.connect(this.seaGain);
    this.seaGain.connect(this.master);
    sea.start();

    // --- vento ---
    const wind = context.createBufferSource();
    wind.buffer = this.noise;
    wind.loop = true;

    this.windFilter = context.createBiquadFilter();
    this.windFilter.type = 'bandpass';
    this.windFilter.frequency.value = 900;
    this.windFilter.Q.value = 0.8;

    const gust = context.createOscillator();
    gust.frequency.value = 0.14;
    const gustDepth = context.createGain();
    gustDepth.gain.value = 260;
    gust.connect(gustDepth);
    gustDepth.connect(this.windFilter.frequency);
    gust.start();

    this.windGain = context.createGain();
    this.windGain.gain.value = 0.07;

    wind.connect(this.windFilter);
    this.windFilter.connect(this.windGain);
    this.windGain.connect(this.master);
    wind.start();
  }

  // -- buffers -----------------------------------------------------------------

  /**
   * Ruído branco estéreo de alguns segundos, reaproveitado por tudo.
   *
   * Longo o bastante para os laços de mar e vento não denunciarem a repetição, e
   * para as rajadas poderem começar em pontos diferentes dele.
   */
  private buildNoise(context: AudioContext): AudioBuffer {
    const length = context.sampleRate * 6;
    const buffer = context.createBuffer(2, length, context.sampleRate);

    for (let channel = 0; channel < 2; channel++) {
      const data = buffer.getChannelData(channel);
      for (let i = 0; i < length; i++) data[i] = Math.random() * 2 - 1;
    }

    return buffer;
  }

  /**
   * Resposta ao impulso da reverberação, gerada.
   *
   * Ruído com decaimento exponencial, e o expoente alto (3) é o que faz a cauda
   * morrer rápido: mar aberto devolve pouco, e uma cauda longa aqui soaria como
   * catedral. O passa-baixa embutido no próprio decaimento — as amostras tardias
   * recebem menos energia de alta frequência — imita o ar comendo o agudo da
   * reflexão, que é o que dá o "longe" da cauda.
   */
  private buildImpulse(context: AudioContext): AudioBuffer {
    const length = Math.floor(context.sampleRate * REVERB_SECONDS);
    const buffer = context.createBuffer(2, length, context.sampleRate);

    for (let channel = 0; channel < 2; channel++) {
      const data = buffer.getChannelData(channel);
      // Estado do passa-baixa de um polo, por canal.
      let low = 0;
      for (let i = 0; i < length; i++) {
        const t = i / length;
        const decay = Math.pow(1 - t, 3);
        const white = Math.random() * 2 - 1;
        // O coeficiente cai com o tempo: quanto mais tarde a reflexão, mais escura.
        low += (white - low) * (0.35 - 0.3 * t);
        data[i] = low * decay;
      }
    }

    return buffer;
  }
}
