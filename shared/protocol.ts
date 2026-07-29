/**
 * O contrato entre o jogo e o servidor de sala.
 *
 * Este arquivo é importado pelos **dois lados** — pelo cliente, que roda no
 * navegador com o DOM inteiro à disposição, e pelo Worker, que roda num runtime
 * sem DOM nenhum. Daí a única regra que ele tem:
 *
 * ⚠️ **Nada de DOM, nada de Workers, nada de Three.js.** Só tipos e funções puras
 * sobre números e `ArrayBuffer`. Um `WebSocket` mencionado aqui quebraria a
 * compilação de um dos dois lados, porque os dois runtimes declaram esse nome com
 * formatos diferentes.
 *
 * ## Duas linguagens no mesmo fio
 *
 * O lobby fala **JSON**; a partida fala **binário**. A separação sai de graça no
 * recebimento — `typeof event.data === 'string'` já diz qual é qual — e cada uma
 * está no formato certo para o que faz:
 *
 * - O lobby são seis mensagens por sessão, com texto dentro (apelidos), e o que
 *   se quer delas é poder lê-las no inspetor do navegador quando algo der errado.
 * - A partida são 45 mensagens por segundo, e ali JSON custa caro duas vezes: no
 *   fio (`0.7071067811865476` são dezoito caracteres para um número que cabe em
 *   dois bytes) e na CPU, porque `JSON.parse` de alguns quilobytes quinze vezes
 *   por segundo constrói um grafo de objetos novo dentro do quadro de render.
 *
 * ## Versão
 *
 * `PROTOCOL_VERSION` sobe sempre que o formato binário muda. O servidor recusa a
 * conexão de quem chegar com outra — é o que impede duas versões do jogo de se
 * encontrarem numa sala e passarem a partida inteira interpretando os bytes uma
 * da outra ao contrário, que é uma falha silenciosa e horrível de diagnosticar.
 */

/**
 * Sobe a cada mudança de formato. Ver o cabeçalho.
 *
 * **2** — o instantâneo passou a carregar o relógio do dia e o estado do tempo
 * (sem eles, cada lado navegava sob o próprio céu e a própria chuva), e o
 * `ackTick` virou de 16 para 32 bits. O de 16 dava a volta em dezoito minutos de
 * duelo, e agora ele não é mais só telemetria: é ele que diz ao cliente quando a
 * predição de posto foi confirmada. Um `ack` que volta ao zero no meio da
 * partida travaria o jogador fora do timão até o fim dela.
 *
 * **3** — o instantâneo passou a dizer quantos passos o host ficou **sem
 * comando** desde o anterior. O cliente decidia isso olhando a profundidade da
 * fila, e os dois casos que ele precisava distinguir têm a mesma aparência ali:
 * fila vazia é tanto "o comando chegou tarde" quanto "o comando chegou na hora
 * exata". O avanço subia em cima do segundo e nunca mais descia.
 *
 * **4** — três campos que faltavam ao mundo, e os três produziam a mesma queixa
 * ("não está sincronizado") por caminhos diferentes:
 *
 * - **O rumo da ondulação de fundo** (`swellDirection`). Ele nascia do vento
 *   *local* de cada cliente — que era diferente, porque cada um tinha ficado um
 *   tempo diferente na tela de título — e depois só andava no lado que simula.
 *   As duas ondas longas do espectro são as que levantam o casco, então os dois
 *   jogadores viam o mesmo navio flutuando em mares diferentes desde o primeiro
 *   quadro.
 * - **As tábuas pregadas.** Um rombo tapado sumia do costado do adversário em
 *   vez de virar cicatriz com madeira por cima.
 * - **A mira da peça operada**, que agora também é corrigida pelo instantâneo
 *   como já era a roda do timão: acumular deltas dos dois lados só concorda
 *   enquanto nenhum comando se perde.
 */
export const PROTOCOL_VERSION = 4;

/** Casas do código de sala. */
export const CODE_LENGTH = 4;

/**
 * Alfabeto do código de sala: 32 caracteres sem par ambíguo.
 *
 * Sem `I`, `O`, `0` e `1` — os quatro que se confundem quando alguém dita um
 * código por voz ou o copia de uma tela para um papel. Duplicado no cliente
 * (`OnlineMenu`) de propósito: o cliente precisa dele para desenhar as casas, e
 * este módulo não pode importar nada de lá.
 */
export const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

/** Tamanho máximo de um apelido, em caracteres. Grampeado nos dois lados. */
export const NICKNAME_MAX_LENGTH = 16;

// -- lobby, em JSON -----------------------------------------------------------

/** O que o cliente quer da sala ao entrar. */
export type JoinIntent = 'queue' | 'create' | 'join';

/** Cliente → sala. */
export type ClientMessage =
  | {
      t: 'hello';
      v: number;
      nickname: string;
      intent: JoinIntent;
      /**
       * O quanto esta máquina aguenta, de 0 a 100.
       *
       * Serve para escolher **quem simula**. Num duelo host-autoritativo, quem
       * hospeda carrega a física dos dois cascos, então uma máquina fraca no
       * comando engasga os dois jogadores. Medido no cliente a partir da taxa de
       * quadros no menu e dos núcleos disponíveis — ver `measurePerformance`.
       */
      perfScore: number;
    }
  /** Assets carregados; pode começar quando o outro também estiver. */
  | { t: 'ready' }
  /** O host declara o fim. Só ele sabe, porque só ele simula. */
  | { t: 'result'; winner: 0 | 1 }
  /** Sinal de vida durante a espera, para o servidor limpar sala abandonada. */
  | { t: 'ping' };

/** Sala → cliente. */
export type ServerMessage =
  /**
   * Entrou. Eis o código para passar adiante.
   *
   * **Sem papel**, e é de propósito: quem simula é decidido comparando as duas
   * máquinas, e no instante em que o primeiro capitão entra não há com quem
   * comparar. Dar um papel provisório aqui obrigaria a corrigi-lo depois, e um
   * cliente que já se preparou para hospedar e é rebaixado é exatamente o tipo
   * de transição que não vale a pena existir.
   */
  | { t: 'welcome'; v: number; code: string; self: string }
  /**
   * O segundo capitão chegou, e agora dá para dizer quem simula.
   *
   * Os dois recebem esta mensagem, cada um com o **próprio** papel em `role` e o
   * apelido do outro em `nickname`.
   */
  | { t: 'peer'; nickname: string; role: 'host' | 'guest' }
  /** Tudo combinado: eis o mundo, comecem. */
  | {
      t: 'start';
      /** Semente do mar, do tempo e de tudo que sorteia. */
      seed: number;
      /** Modo de tempo da sala. Sobrepõe a preferência local dos dois lados. */
      weather: 'dynamic' | 'clear' | 'breeze' | 'squall' | 'storm';
      /** Fração do dia em que o duelo começa. */
      timeOfDay: number;
    }
  /** Acabou, e por quê. */
  | {
      t: 'over';
      reason: 'sunk' | 'left' | 'timeout' | 'error';
      /** Índice do vencedor do ponto de vista do host, ou `null`. */
      winner: 0 | 1 | null;
    }
  /** Deu errado antes de começar. */
  | { t: 'error'; reason: string }
  | { t: 'pong' };

// -- partida, em binário ------------------------------------------------------

/**
 * O primeiro byte de todo quadro binário.
 *
 * ⚠️ Os valores são o formato de rede: acrescente no fim, nunca reordene.
 */
export const MessageType = {
  /** Guest → host: um lote de `InputFrame`. */
  Input: 1,
  /** Host → guest: o estado do mundo. */
  Snapshot: 2,
  /** Host → guest: "minha janela está em segundo plano, segura aí". */
  Stall: 3,
} as const;

/**
 * Quantos `InputFrame` cabem numa mensagem de entrada.
 *
 * Quatro, sendo dois novos e dois repetidos do envio anterior. A redundância é o
 * que torna a perda de um pacote invisível: o quadro perdido chega de novo no
 * seguinte, dentro do prazo em que o host ainda o consome. Custa 32 bytes por
 * mensagem, num orçamento de subida de ~2 KB/s — barato o bastante para não valer
 * a pena bolar um esquema de confirmação e reenvio.
 */
export const INPUT_BATCH = 4;

/**
 * Rombos (e tábuas pregadas) que o formato transporta por casco.
 *
 * Mora aqui, e não junto do modelo de avaria, porque **é o fio que manda neste
 * número**. A lista viaja atrás de uma contagem de um byte, e o leitor do outro
 * lado precisa parar exatamente onde o escritor parou: enquanto os dois lados
 * tinham cada um o seu teto — o escritor mandava quantos houvesse, o leitor
 * parava em 32 —, um casco muito castigado desalinhava o instantâneo inteiro a
 * partir dali, e o guest passava a ler o marujo, o adversário e os eventos em
 * cima de bytes que pertenciam a outra coisa.
 *
 * Um teto, uma definição, e `ShipDamage` o importa daqui para nunca abrir mais
 * rombos do que cabe contar. Ver `MAX_BREACHES` lá para o que acontece com o
 * tiro que chega com a lista cheia.
 */
export const MAX_BREACHES = 24;

/**
 * Bytes de um `InputFrame` no fio.
 *
 * Dezoito desde a versão 2: os quatro que entraram são o olhar **absoluto**, que
 * passou a viajar ao lado do delta. Ver `PlayerController.applyLook` — em
 * resumo, delta de olhar não sobrevive a pacote perdido, e o que quebra quando
 * ele não sobrevive é o foco de interação do outro jogador.
 */
export const INPUT_FRAME_BYTES = 18;

/**
 * Escalas de quantização.
 *
 * Cada grandeza vira inteiro pela escala que preserva a precisão que **o olho ou
 * a física** exigem, e nem um bit a mais. Um quaternion unitário em `i16` erra no
 * quinto decimal, o que num casco de quinze metros é meio milímetro de guinada;
 * uma velocidade em centésimos de m/s é mais fina que a resolução com que o mar
 * empurra o navio.
 */
export const QUANT = {
  /** Componentes de quaternion, −1..1. */
  quaternion: 32767,
  /** Velocidade linear, m/s. */
  velocity: 256,
  /** Velocidade angular, rad/s. */
  angular: 2048,
  /** Ângulos em radianos (roda, travessia, elevação, rumo da cabeça). */
  angle: 10000,
  /** Posições locais a bordo, m. */
  local: 256,
  /** Posições de rombo no casco, m. */
  breach: 512,
  /**
   * Fração do dia, 0..1.
   *
   * Sobre um dia de doze minutos, um passo desta escala é um centésimo de
   * segundo de jogo — ou seja, o sol nunca salta um pixel por causa da
   * quantização. É gente demais para dois bytes? Não: a alternativa era um
   * `f32` de quatro, e o que se ganharia com ele é precisão em casas que nem o
   * relógio do HUD mostra.
   */
  timeOfDay: 65535,
} as const;

/** Empacota um float numa faixa de `i16`, grampeando nas pontas. */
export function quantize(value: number, scale: number): number {
  const scaled = Math.round(value * scale);
  return scaled < -32768 ? -32768 : scaled > 32767 ? 32767 : scaled;
}

/** Desempacota o que `quantize` produziu. */
export function dequantize(value: number, scale: number): number {
  return value / scale;
}

/** Um código de sala válido: quatro casas do alfabeto, em caixa alta. */
export function isValidCode(code: string): boolean {
  if (code.length !== CODE_LENGTH) return false;
  for (const character of code) {
    if (!CODE_ALPHABET.includes(character)) return false;
  }
  return true;
}

/**
 * Deixa um apelido apresentável, ou devolve um padrão.
 *
 * Roda **nos dois lados**, e é de propósito: o cliente saneia para o jogador ver
 * o nome com que vai entrar, e o servidor saneia porque entrada de rede não se
 * confia nunca — o cliente que manda o `hello` pode não ser o nosso.
 */
export function sanitizeNickname(value: unknown): string {
  if (typeof value !== 'string') return 'Sailor';
  const cleaned = value
    // Controles C0/C1, largura zero, marcas e isolamentos bidirecionais, e o BOM.
    .replace(/[\u0000-\u001F\u007F-\u009F\u200B-\u200F\u2028-\u202E\u2066-\u2069\uFEFF]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  return cleaned.length > 0 ? cleaned.slice(0, NICKNAME_MAX_LENGTH) : 'Sailor';
}
