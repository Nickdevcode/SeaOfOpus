/**
 * O relógio da passada: uma fase só, da qual saem o passo e o balanço da câmera.
 *
 * Antes disto havia **dois relógios**. A câmera balançava com uma cadência
 * própria (`3.4 + velocidade * 1.15`), inventada quando o jogo era só primeira
 * pessoa e não havia corpo nenhum para discordar dela. Quando o corpo chegou, o
 * pé tocava o convés num instante e o solavanco da câmera acontecia noutro — o
 * passo que se **vê** e o que se **sente** eram passos diferentes. Ninguém
 * aponta o que está errado numa cena dessas; só fica estranho.
 *
 * Agora a fase é uma coisa só e é ela quem manda nos dois. Sai daqui, e não do
 * avatar, por dois motivos: o corpo é um arquivo que carrega de forma assíncrona
 * e pode falhar, e o jogo tem de andar igual sem ele; e é o controlador quem
 * sabe a velocidade, que é o que faz a fase avançar.
 *
 * A fase vale [0, 1) por **passada** — os dois passos. Zero é o pé esquerdo
 * tocando o chão, que é onde os clipes do Blender começam.
 */

import { damp } from '../core/MathUtils';

/**
 * O que cada clipe faz de verdade. Os números saem do Blender (`anim_walk.py`,
 * `anim_run.py`) e **não** são afináveis aqui: quem os define é o comprimento da
 * perna do personagem. Mexer neles sem regerar os clipes reintroduz
 * escorregamento de pé — e, no caso de `bounceAmplitude`, faz o corpo deslizar
 * verticalmente por baixo da câmera de quem o está vestindo.
 *
 * `bounceAmplitude` é a **meia** amplitude com que o clipe levanta o quadril, em
 * metros: `anim_gait.GaitSpec.bounce_amplitude`.
 */
export const WALK_CLIP = {
  speed: 1.65,
  cycle: 0.8,
  bouncePhase: 0.0,
  bounceAmplitude: 0.021,
} as const;
export const RUN_CLIP = {
  speed: 3.6667,
  cycle: 0.6,
  bouncePhase: 0.155,
  bounceAmplitude: 0.035,
} as const;

/** Distância que cada ciclo cobre no chão, em metros. */
export const WALK_DISTANCE = WALK_CLIP.speed * WALK_CLIP.cycle;
export const RUN_DISTANCE = RUN_CLIP.speed * RUN_CLIP.cycle;

/**
 * Velocidade vertical de saída do pulo, em m/s.
 *
 * Mora aqui, e não no `PlayerController` que a aplica, porque é ela quem indexa
 * o clipe de ar: o relógio precisa dela para saber em que ponto da parábola o
 * corpo está, e importar na outra direção fecharia um ciclo.
 */
export const JUMP_SPEED = 3.3;

/**
 * Duração do clipe de pouso, em segundos — 14 quadros a 30 fps, o que
 * `anim_jump.py` gerou. Ao contrário do ar, o pouso **roda no tempo**: ele não
 * tem nenhuma grandeza física de onde ser lido.
 */
export const LAND_CLIP = { cycle: 14 / 30 } as const;

/** Abaixo disto o personagem está parado. */
export const MOVE_THRESHOLD = 0.35;

/** Convergência da mistura e do desaparecimento, em 1/s. */
const BLEND_LAMBDA = 9;

/** Convergência da entrada e da saída do ar, em 1/s. */
const AIR_LAMBDA = 22;

/** Velocidade de impacto que já vale o pouso cheio, em m/s. */
const LAND_FULL_SPEED = JUMP_SPEED;
/** Abaixo disto o pé só encostou, e mostrar pouso seria exagero. */
const LAND_MIN_SPEED = 1.0;
/** Fração do clipe de pouso que fica com peso cheio: a compressão. */
const LAND_HOLD = 0.45;

const lerp = (a: number, b: number, t: number): number => a + (b - a) * t;
const clamp01 = (v: number): number => (v < 0 ? 0 : v > 1 ? 1 : v);
const smoothstep = (t: number): number => t * t * (3 - 2 * t);

/**
 * O que o clipe de escalada faz, e os números que o amarram à escada do navio.
 *
 * `rise` não é escolha de animador: é **dois enfrechates** da escada do mastro.
 * O clipe foi construído em cima disso (`PirateCharacter/scripts/anim_climb.py`)
 * porque é o que permite casar a fase com a altura absoluta — como a subida por
 * ciclo é um múltiplo inteiro do espaçamento, alinhar a mão com uma barra uma
 * vez é alinhar para sempre.
 *
 * `footRung` é a altura, dentro do clipe, da barra que o pé esquerdo toma na
 * fase 0, medida a partir dos pés do jogador. É a âncora do alinhamento.
 */
export const CLIMB_CLIP = { rise: 0.60667, footRung: 0.33, cycle: 1.0 } as const;

/**
 * O relógio da escada: a mesma ideia da passada, de pé.
 *
 * A fase avança pela **altura vencida**, não pelo tempo, e é isso que mantém a
 * mão parada na barra enquanto o corpo sobe — em qualquer `CLIMB_SPEED` que o
 * controlador resolva usar, como a passada já funciona em qualquer velocidade.
 *
 * Descer é o mesmo clipe com a fase andando para trás. Não é economia: os
 * pontos de contato de uma descida têm de cair na **mesma** grade de barras da
 * subida, e um segundo clipe teria de reproduzir essa grade — qualquer
 * divergência apareceria como mão atravessando madeira. Com a fase dirigida
 * pela altura, o contato é idêntico por construção nos dois sentidos.
 */
export class ClimbClock {
  /** Onde o ciclo está, em [0, 1). Zero é o pé esquerdo tomando uma barra. */
  phase = 0;
  /** Quanto do corpo o clipe ocupa — sobe ao agarrar, cai ao largar. */
  weight = 0;

  /**
   * @param climbing se o jogador está na escada neste quadro.
   * @param deltaY quanto ele subiu (positivo) ou desceu (negativo), em metros.
   */
  update(dt: number, climbing: boolean, deltaY: number): void {
    this.weight = damp(this.weight, climbing ? 1 : 0, BLEND_LAMBDA, dt);
    if (!climbing) return;
    // Parado na escada a fase não anda, e é o que se quer: o personagem congela
    // agarrado exatamente onde estava, sem deslizar um milímetro. Um clipe de
    // "agarrado respirando" só funcionaria como camada aditiva; como pose cheia,
    // ele arrastaria as mãos até a barra dele na transição.
    this.phase = (((this.phase + deltaY / CLIMB_CLIP.rise) % 1) + 1) % 1;
  }

  /**
   * A fase que põe as mãos e os pés **nas barras que existem**, para uma altura
   * de pés dada.
   *
   * Chamada uma vez, ao agarrar a escada. Daí em diante o alinhamento se
   * sustenta sozinho, porque a fase e a altura avançam juntas.
   *
   * A conta: no clipe, a barra tomada na fase `p` está a
   * `footRung - rise * p` acima dos pés. Para ela coincidir com uma barra de
   * verdade, essa altura mais a do jogador tem de cair na grade — o que dá
   * `p ≡ u / 2 (mod 1/2)`, com `u` a posição do pé medida em espaçamentos.
   * Sobram duas soluções, meio ciclo entre elas: são as duas pernas, e serve
   * qualquer uma.
   */
  align(feetY: number, bottomY: number, spacing: number): void {
    const u = (feetY + CLIMB_CLIP.footRung - bottomY) / spacing;
    const fraction = ((u % 1) + 1) % 1;
    const candidate = fraction * 0.5;
    // Das duas, a mais perto da fase atual: quem larga a escada e reagarra logo
    // em seguida não troca de perna sem motivo.
    const other = candidate + 0.5;
    const distance = (a: number, b: number): number => {
      const d = Math.abs(a - b) % 1;
      return Math.min(d, 1 - d);
    };
    this.phase = distance(candidate, this.phase) <= distance(other, this.phase)
      ? candidate
      : other;
  }

  reset(): void {
    this.phase = 0;
    this.weight = 0;
  }
}

/**
 * O que o clipe do timão faz, e o que o amarra à roda que está desenhada.
 *
 * `step` não é escolha de animador: a roda tem **oito punhos**, e oito punhos em
 * volta de um círculo dão um passo de 45°. Como o curso inteiro é de `MAX_WHEEL`
 * para cada lado, a roda dá exatamente uma volta de batente a batente — os oito
 * punhos, uma vez cada.
 *
 * É o casamento mais limpo do projeto: ao contrário da escada, cuja grade de
 * barras existe no navio e obriga a um alinhamento (`ClimbClock.align`), aqui a
 * grade **é** o próprio ângulo da roda. Ela é periódica de nascença, e por isso a
 * fase cai certa em qualquer instante, com o leme a meio ou todo carregado.
 */
export const HELM_CLIP = { step: Math.PI / 4 } as const;

/**
 * O relógio do timão: a mesma ideia da escada, de mãos na roda.
 *
 * A fase sai do **ângulo da roda**, e é isso que crava a mão em cima de um punho
 * desenhado enquanto ela gira — em qualquer `WHEEL_RATE`, como a passada funciona
 * em qualquer velocidade. Não há estado acumulado: a fase é uma função do ângulo,
 * então nada tem como derivar ao longo da partida.
 *
 * Girar para bombordo é o mesmo clipe com a fase andando para trás, pelo mesmo
 * motivo que descer a escada é a subida ao contrário: os contatos de uma guinada
 * a bombordo têm de cair nos **mesmos oito punhos** da guinada a boreste, e um
 * segundo clipe teria de reproduzir essa grade. A mão que puxava passa a empurrar,
 * que é exatamente o que o timoneiro faz.
 */
export class HelmClock {
  /** Onde o ciclo está, em [0, 1). Zero é a mão tomando um punho. */
  phase = 0;
  /** Quanto do corpo o clipe ocupa — sobe ao assumir o leme, cai ao largar. */
  weight = 0;

  /**
   * @param atHelm se o jogador está com as mãos na roda neste quadro.
   * @param wheelAngle ângulo da roda, em radianos. Ver `Rudder.wheelAngle`.
   */
  update(dt: number, atHelm: boolean, wheelAngle: number): void {
    this.weight = damp(this.weight, atHelm ? 1 : 0, BLEND_LAMBDA, dt);
    if (!atHelm) return;
    // O módulo duplo não é superstição: em JS `-0.3 % 1` dá `-0.3`, e meia roda
    // do curso vive em ângulo negativo. Uma fase negativa escrita em `.time`
    // sairia como quadro do fim do clipe — a mão saltaria um punho inteiro ao
    // cruzar o leme a meio, justamente onde ninguém desconfiaria dela.
    this.phase = (((wheelAngle / HELM_CLIP.step) % 1) + 1) % 1;
  }

  reset(): void {
    this.phase = 0;
    this.weight = 0;
  }
}

/**
 * Duração do ciclo de carregar a tábua, em segundos.
 *
 * 72 quadros a 30 fps, o que `anim_carry.py` gerou. É o único clipe de posto
 * cuja duração precisa ser repetida aqui, e a razão está na classe abaixo.
 */
export const CARRY_CLIP = { duration: 2.4 } as const;

/**
 * O relógio da tábua na mão: o único posto que roda no **tempo**.
 *
 * Os outros três clipes indexados desta pasta leem uma grandeza do mundo — a
 * passada lê distância, a escada lê altura vencida, o timão lê o ângulo da
 * roda —, e é disso que vem a propriedade de nunca discordarem da física. Aqui
 * não há grandeza para ler: segurar uma tábua não tem período natural nenhum, e
 * amarrar a fase ao progresso do reparo daria um homem que respira mais rápido
 * quanto mais perto de terminar.
 *
 * Então esta é a exceção, e ela é da mesma família do `Idle`: um ciclo de
 * respiração que roda sozinho. O que ela ainda tem em comum com os outros é o
 * peso amortecido — a tábua não aparece na mão num quadro, ela é erguida.
 */
export class CarryClock {
  /** Onde o ciclo está, em [0, 1). */
  phase = 0;
  /** Quanto do corpo o clipe ocupa. Sobe ao pegar a tábua, cai ao largar. */
  weight = 0;

  /** @param carrying se o jogador está com a tábua nas mãos neste quadro. */
  update(dt: number, carrying: boolean): void {
    this.weight = damp(this.weight, carrying ? 1 : 0, BLEND_LAMBDA, dt);
    // A fase só corre com a tábua na mão, e **não** volta a zero ao largar. Não
    // é economia: quem solta o botão por um instante e reaperta retomaria o
    // ciclo do começo, e o salto apareceria como um tranco na respiração
    // justamente no momento em que o jogador está olhando para as próprias mãos.
    if (carrying) this.phase = (this.phase + dt / CARRY_CLIP.duration) % 1;
  }

  reset(): void {
    this.phase = 0;
    this.weight = 0;
  }
}

export class GaitClock {
  /** Onde a passada está, em [0, 1). Zero é o pé esquerdo no chão. */
  phase = 0;
  /** Quanto da mistura é corrida. */
  runBlend = 0;
  /** Quanto da locomoção está valendo — cai a zero quando ele para. */
  moving = 0;
  /** Velocidade horizontal do último quadro, em m/s. */
  speed = 0;

  update(dt: number, speed: number, grounded: boolean): void {
    this.speed = speed;
    const walking = grounded && speed > MOVE_THRESHOLD;

    const target = clamp01((speed - WALK_CLIP.speed) / (RUN_CLIP.speed - WALK_CLIP.speed));
    this.runBlend = damp(this.runBlend, target, BLEND_LAMBDA, dt);
    this.moving = damp(this.moving, walking ? 1 : 0, BLEND_LAMBDA, dt);

    if (!walking) return;

    // A fase avança pela **distância percorrida**, não pelo tempo: é isso que
    // faz o pé ficar parado no chão durante o apoio, em qualquer velocidade.
    this.phase = (this.phase + (speed * dt) / this.distance) % 1;
  }

  /** Distância que a mistura atual cobre num ciclo, em metros. */
  get distance(): number {
    return lerp(WALK_DISTANCE, RUN_DISTANCE, this.runBlend);
  }

  /** Duração de um ciclo na velocidade atual, em segundos. */
  get cycleSeconds(): number {
    return this.distance / Math.max(this.speed, MOVE_THRESHOLD);
  }

  /**
   * Altura do corpo dentro do ciclo, de -1 (mais baixo) a 1 (mais alto).
   *
   * É a mesma curva que o Blender usa para levantar o quadril, inclusive a
   * inversão de fase entre andar e correr: andando o corpo está mais baixo no
   * contato, com as pernas abertas; correndo, no meio do apoio, com a perna
   * absorvendo o peso. Por isso o `bouncePhase` também é interpolado.
   */
  get bounce(): number {
    const offset = lerp(WALK_CLIP.bouncePhase, RUN_CLIP.bouncePhase, this.runBlend);
    return -Math.cos(4 * Math.PI * (this.phase - offset));
  }

  /**
   * A mesma altura, **em metros** — o quanto o clipe de fato levanta o corpo.
   *
   * A amplitude é interpolada pela mistura pelo mesmo motivo que a fase: o corpo
   * na tela é a média ponderada dos dois clipes, então a curva que a câmera segue
   * tem de ser a média ponderada das duas amplitudes. Enquanto a câmera tinha um
   * número próprio, ela subia 4,2 cm onde o corpo subia 2,1 — e a diferença
   * aparecia como o tronco afundando e emergindo a cada passo, para quem está
   * dentro dele.
   */
  get bounceMeters(): number {
    return this.bounce * lerp(WALK_CLIP.bounceAmplitude, RUN_CLIP.bounceAmplitude, this.runBlend);
  }

  reset(): void {
    this.phase = 0;
    this.runBlend = 0;
    this.moving = 0;
    this.speed = 0;
  }
}

/**
 * O relógio do pulo: dois clipes, e nenhum deles tocado como filme.
 *
 * O pulo daqui é instantâneo — no mesmo quadro em que a tecla desce, a
 * velocidade já vale `JUMP_SPEED` e os pés já saíram do convés. Não existe
 * quadro nenhum entre a intenção e a decolagem, e é por isso que **não há clipe
 * de preparo**: antecipação é um empréstimo de tempo que este motor não faz. O
 * impulso que não cabe antes aparece depois, na perna que termina de estender.
 *
 * O clipe de ar é **lido pela velocidade vertical**, não tocado pelo relógio: a
 * fase sai de `velocity.y`, então a pose não tem como discordar da física. Cai
 * de graça o caso difícil — um clipe de duração fixa aterrissaria no meio do
 * ápice num pulinho e daria três voltas numa queda do mastro, enquanto este
 * satura sozinho e passa a queda inteira no quadro final, pernas já estendidas
 * para receber o chão.
 *
 * Fica ao lado do `GaitClock` e pelo mesmo motivo: o corpo é um arquivo que
 * carrega de forma assíncrona e pode falhar, e quem sabe o estado físico é o
 * controlador.
 */
export class JumpClock {
  /** Peso do clipe de ar, em [0, 1]. */
  air = 0;
  /** Peso do clipe de pouso, em [0, 1]. */
  land = 0;
  /** Onde o corpo está na parábola: 0 é a decolagem, 0,5 o ápice, 1 a queda. */
  airPhase = 0;
  /** Onde o pouso está, em [0, 1]. Este sim avança pelo tempo. */
  landPhase = 1;
  /** Força do pouso em curso, em [0, 1]. */
  impact = 0;

  /**
   * Velocidade de queda do último quadro no ar, em m/s e positiva caindo.
   *
   * Guardada porque no quadro do contato ela já não existe: `resolveGround`
   * zera `velocity.y` e liga `grounded` antes de o relógio ser alimentado. Sem
   * esta cópia todo pouso teria a mesma força — a de zero.
   */
  private fallSpeed = 0;
  private airborne = false;

  update(dt: number, verticalSpeed: number, grounded: boolean): void {
    if (!grounded) {
      this.airborne = true;
      this.fallSpeed = Math.max(-verticalSpeed, 0);

      this.airPhase = clamp01(0.5 * (1 - verticalSpeed / JUMP_SPEED));
      this.air = damp(this.air, 1, AIR_LAMBDA, dt);
      // Pular outra vez cancela o pouso que ainda estivesse tocando: são estados
      // que não podem se sobrepor, e deixá-los somar passaria de 1 no peso total.
      this.land = 0;
      this.landPhase = 1;
      return;
    }

    if (this.airborne) {
      this.airborne = false;
      this.impact = clamp01(
        (this.fallSpeed - LAND_MIN_SPEED) / (LAND_FULL_SPEED - LAND_MIN_SPEED),
      );
      this.landPhase = 0;
      // Troca seca, sem mistura: a última pose do ar é a perna estendida à
      // espera do convés, que é exatamente onde o pouso começa. Passar por uma
      // média das duas só borraria o único quadro que o jogador repara.
      this.air = 0;
    }

    this.air = damp(this.air, 0, AIR_LAMBDA, dt);

    if (this.landPhase >= 1) {
      this.land = 0;
      return;
    }

    this.landPhase = Math.min(this.landPhase + dt / LAND_CLIP.cycle, 1);
    // Peso cheio durante a compressão e saída suave depois. O clipe já termina
    // na pose neutra, mas quem sai andando no meio do pouso precisa que o resto
    // se apague em vez de ser cortado no quadro.
    const fade = this.landPhase <= LAND_HOLD
      ? 1
      : 1 - smoothstep((this.landPhase - LAND_HOLD) / (1 - LAND_HOLD));
    this.land = this.impact * fade;
  }

  /**
   * Apaga o pulo sem disparar pouso.
   *
   * É o que se quer quando os pés deixam o chão por outro motivo que não a
   * física: agarrar a escada do mastro, assumir o timão. Alimentar `update` com
   * `grounded` nesses casos faria o personagem aterrissar no ar, agarrado a uma
   * escada a nove metros do convés.
   */
  settle(dt: number): void {
    this.airborne = false;
    this.fallSpeed = 0;
    this.landPhase = 1;
    this.air = damp(this.air, 0, AIR_LAMBDA, dt);
    this.land = damp(this.land, 0, AIR_LAMBDA, dt);
  }

  reset(): void {
    this.air = 0;
    this.land = 0;
    this.airPhase = 0;
    this.landPhase = 1;
    this.impact = 0;
    this.fallSpeed = 0;
    this.airborne = false;
  }
}
