/**
 * Os três capitães inimigos, e o que exatamente muda entre eles.
 *
 * **A regra que este arquivo respeita:** a dificuldade mexe em *perícia*, nunca
 * em física nem em tripulação. Os três navios têm o mesmo casco, o mesmo pano, os
 * mesmos dois canhões e a mesma tripulação de dois. O que muda é o quanto a mão
 * do artilheiro trema, quanto ele erra a liderança do alvo, quanto tempo o
 * capitão leva para perceber que a situação virou e a que distância ele resolve
 * abrir fogo. Nenhum deles ganha alcance de tiro, velocidade de casco ou bomba de
 * porão extra.
 *
 * Isso importa por dois motivos. O primeiro é que dificuldade que aumenta números
 * de física vira um navio que o jogador não consegue ler: ele vê o inimigo virar
 * mais rápido do que o barco dele consegue e conclui que o jogo trapaceia — e
 * estaria certo. O segundo é que perícia produz erros *do tipo certo*: o grumete
 * não erra por sorteio, ele erra **atrasado e curto**, que é como gente nova erra
 * de verdade num canhão.
 *
 * ## De onde saem os números de pontaria
 *
 * `aimSigma` é o desvio padrão do erro angular por tiro. A conversão para metros
 * no alvo é direta: `desvio ≈ sigma × alcance`. A Chalupa tem 16 m de comprimento
 * e ~2,6 m de costado exposto acima da linha d'água, então a 80 m:
 *
 * | capitão  | sigma    | desvio a 80 m | leitura                              |
 * |----------|----------|---------------|--------------------------------------|
 * | grumete  | 0,050 rad| ±4,0 m        | acerta o casco em ~1 tiro de 3       |
 * | corsário | 0,018 rad| ±1,4 m        | acerta quase sempre, erra na onda    |
 * | lenda    | 0,007 rad| ±0,56 m       | escolhe *onde* no casco vai acertar  |
 *
 * `leadFraction` é a fração da velocidade do alvo que o artilheiro consegue
 * prever. Abaixo de 1 ele **atira atrás** do navio que cruza — o erro clássico de
 * quem está aprendendo, e o que dá ao jogador a chance de escapar acelerando.
 *
 * ## O eixo que faltava: o que ele faz com o navio dele
 *
 * Os três capitães nasceram com três perícias de artilharia e uma de comando, e
 * **nenhuma de avaria** — os três consertavam o casco exatamente igual, e exatamente
 * bem. Medindo, isso queria dizer que oito rombos na linha d'água viravam casco
 * estanque em vinte e cinco segundos em qualquer dificuldade. Um jogador que
 * acertasse mais não ganhava nada com isso, o que é o contrário do que um jogo de
 * combate naval deve ensinar.
 *
 * `holdShift`, `gunShift` e `triage` são o eixo que faltava, e ele mede a mesma
 * coisa que os outros: **julgamento**. Quanto tempo largar a peça vale a pena,
 * quando voltar a ela, e qual dos buracos merece a tábua que está na mão. Continua
 * não havendo gente a mais nem bomba melhor — o inimigo Lenda salva o navio dele
 * porque decide melhor, não porque trabalha mais rápido.
 */

export type DifficultyId = 'recruit' | 'corsair' | 'legend';

export interface DifficultyPreset {
  readonly id: DifficultyId;
  /** Nome mostrado no menu. */
  readonly label: string;
  /** Uma linha que diz ao jogador no que ele está se metendo. */
  readonly blurb: string;

  // --- artilharia ------------------------------------------------------------
  /** Desvio padrão do erro de pontaria, em radianos, sorteado a cada carga. */
  readonly aimSigma: number;
  /**
   * Fração da velocidade do alvo que o artilheiro leva em conta. 1 é liderança
   * perfeita; abaixo disso ele atira atrás do alvo que atravessa.
   */
  readonly leadFraction: number;
  /**
   * Voltas da iteração de ponto fixo em `solveIntercept`.
   *
   * Uma volta só já lidera o azimute, mas calcula o tempo de voo para onde o
   * alvo *está* em vez de para onde ele vai estar — erro que cresce com a
   * distância, que é justamente onde a diferença entre os capitães deve pesar.
   */
  readonly leadIterations: number;
  /** Alcance máximo em que a peça abre fogo, em metros. */
  readonly engageRange: number;
  /**
   * Tolerância angular para soltar o tiro, em radianos.
   *
   * Apertada, o artilheiro espera o balanço trazer o cano exatamente para cima
   * do alvo; folgada, ele atira quase à vontade. É o segundo eixo da precisão, e
   * o mais visível: um capitão ruim atira **na hora errada**, não só torto.
   */
  readonly fireTolerance: number;

  // --- comando ---------------------------------------------------------------
  /** Segundos até o capitão reagir a uma mudança de situação tática. */
  readonly reaction: number;
  /** Ganho do timoneiro sobre o erro de rumo. */
  readonly helmGain: number;
  /** Distância de través que o capitão tenta manter, em metros. */
  readonly standoff: number;

  // --- tripulação ------------------------------------------------------------
  /** Multiplicador do tempo que o marujo leva para trocar de posto. */
  readonly transitScale: number;
  /**
   * Fração de alagamento que manda o marujo largar o canhão e descer ao porão.
   *
   * O grumete deixa a água subir demais antes de agir — e é assim que se perde
   * uma chalupa. A lenda desce ao primeiro rombo abaixo da linha d'água.
   */
  readonly floodAlarm: number;
  /**
   * Segundos de trabalho que o marujo entrega por descida ao porão.
   *
   * **É o número que decide se o navio inimigo pode ser afundado.** Ele conta a
   * partir da chegada lá embaixo — a escada já foi paga em `transitScale` —, e ao
   * esgotar-se o marujo sobe para a peça com o casco no estado em que estiver.
   *
   * Um turno cobre uma caminhada e uma tábua e meia, então o inimigo sai do porão
   * com buracos abertos e volta a atirar mesmo assim. Não é desatenção: é a aposta
   * de que dá para afundar o outro primeiro, e é a mesma aposta que o jogador faz
   * toda vez que decide dar mais um tiro em vez de descer.
   *
   * O turno **não** vale quando o porão passa de `BREAK_OFF_FLOOD` — aí o capitão
   * rompeu contato e salvar o navio virou a única tarefa. Ver `ShipAI.assignCrew`.
   */
  readonly holdShift: number;
  /**
   * Segundos que ele deve à peça antes de poder descer de novo.
   *
   * O par de `holdShift`, e é ele que dá o respiro: entre duas descidas há um
   * intervalo em que o inimigo está atirando e a água está subindo. Sem este
   * intervalo o marujo desceria de volta no passo seguinte ao de subir, e o
   * rodízio viraria o reparo contínuo que ele veio substituir.
   */
  readonly gunShift: number;
  /**
   * Quão bem ele escolhe **qual** rombo tapar. Ver `Crew.pickBreach`.
   *
   * É o expoente de um sorteio ponderado pela vazão de cada furo. Perto de zero, a
   * escolha é às cegas; alto, ele quase sempre acha o que mais está afundando o
   * navio. É o eixo de perícia que faltava: até aqui os três capitães tinham a
   * mesma triagem, e ela era perfeita.
   */
  readonly triage: number;
  /**
   * Fração de porão que ele **aceita deixar dentro do navio**, 0..1.
   *
   * A bomba é a mesma dos dois lados e tira os mesmos 750 L/s — o que muda é quanto
   * tempo alguém fica nela. Até aqui o marujo inimigo bombeava até o porão zerar,
   * sempre, e o efeito era um casco que voltava a ser novo entre uma salva e outra:
   * a água que o jogador pôs lá dentro não acumulava nada ao longo do duelo.
   *
   * Com um piso, ela acumula. Ele bombeia até o nível que julga aceitável, larga a
   * alavanca e sobe para a peça — e o duelo passa a ser jogado por um navio que
   * carrega o estrago das trocas anteriores. É a mesma decisão do turno de porão
   * (`holdShift`), aplicada à água em vez de à madeira, e é o mesmo tipo de erro:
   * o Grumete tolera um quarto do porão cheio e paga caro no primeiro rombo novo.
   *
   * **É também o número que o traz de volta ao combate**, e não há um segundo
   * limiar para isso: o porão que ele considera bom o bastante para largar a bomba é
   * o mesmo que ele considera bom o bastante para voltar a atirar. Ver
   * `ShipAI.desiredIntent`, e a nota sobre por que dois números aqui brigariam.
   */
  readonly bilgeFloor: number;
}

export const DIFFICULTIES: Record<DifficultyId, DifficultyPreset> = {
  recruit: {
    id: 'recruit',
    label: 'Deckhand',
    blurb: 'Shoots behind a moving target and is slow to patch holes. Learn the sea on them.',
    aimSigma: 0.05,
    leadFraction: 0.55,
    leadIterations: 1,
    engageRange: 75,
    fireTolerance: 0.06,
    reaction: 1.2,
    helmGain: 0.75,
    // Chega perto demais e às vezes se enrosca: parte do charme de enfrentá-lo.
    standoff: 48,
    transitScale: 1.6,
    floodAlarm: 0.3,
    holdShift: 8,
    gunShift: 30,
    triage: 0.6,
    bilgeFloor: 0.24,
  },
  corsair: {
    id: 'corsair',
    label: 'Corsair',
    blurb: 'Holds the broadside and wastes no shot. The honest duel.',
    aimSigma: 0.018,
    leadFraction: 0.9,
    leadIterations: 2,
    engageRange: 115,
    fireTolerance: 0.022,
    reaction: 0.55,
    helmGain: 1,
    standoff: 68,
    transitScale: 1.15,
    floodAlarm: 0.18,
    holdShift: 11,
    gunShift: 22,
    triage: 2,
    bilgeFloor: 0.15,
  },
  legend: {
    id: 'legend',
    label: 'Legend',
    blurb: 'Picks which plank to hole. You will learn by sinking.',
    aimSigma: 0.007,
    leadFraction: 1,
    leadIterations: 3,
    engageRange: 155,
    fireTolerance: 0.009,
    reaction: 0.22,
    helmGain: 1.25,
    standoff: 76,
    transitScale: 0.9,
    // Sobe de 0,08 desde que o turno existe: com o alarme no primeiro palmo de
    // água ela desceria a cada minuto por um dedo de porão, e o rodízio faria a
    // Lenda **atirar menos** que o Corsário. Perícia é saber a hora de largar a
    // peça, e a hora certa não é ao primeiro respingo.
    floodAlarm: 0.12,
    holdShift: 14,
    gunShift: 18,
    triage: 5,
    bilgeFloor: 0.08,
  },
};

/** Ordem em que os presets aparecem no menu. */
export const DIFFICULTY_ORDER: readonly DifficultyId[] = ['recruit', 'corsair', 'legend'];
