/**
 * Teste do relógio de rede — o comando do cliente chega ao passo certo do host?
 *
 * Roda no navegador como os outros, e **também** fora dele: este é o único teste
 * que não toca em Three.js, então dá para bundlá-lo e rodar no Node, o que o
 * torna útil quando não há navegador à mão.
 *
 * ```js
 * const t = await import('/tests/netclock.ts');
 * console.table(t.runNetClockTests().cases);
 * ```
 *
 * **O que se prova aqui, e por que ele existe.** O cliente que não simula carimba
 * cada comando com o passo em que ele deve valer, e o host guarda esses comandos
 * numa fila até chegar a vez. Se os dois relógios não andarem juntos, o host fica
 * sem comando para consumir — e como ele não pode pular um passo à espera da
 * rede, ele repete o último. O jogador do outro lado vira um boneco que anda
 * sozinho e não obedece.
 *
 * O teste nasceu de um bug real: o carimbo era calculado como `hostTick + lead`,
 * e `hostTick` só avança quando chega um instantâneo — a cada quatro passos.
 * Três de cada quatro comandos saíam com o carimbo repetido, eram descartados
 * como duplicata, e o host passava fome com a rede perfeita. `starves` na casa
 * dos milhares foi o que denunciou.
 */

import { createInputFrame, InputBit, type InputFrame } from '../src/core/InputFrame';
import { InputBuffer } from '../src/net/InputBuffer';
import { decodeInput, encodeInput } from '../src/net/snapshotCodec';

export interface TestCase {
  nome: string;
  medido: string;
  esperado: string;
  erro: string;
  passou: boolean;
}

export interface TestReport {
  passou: boolean;
  total: number;
  falhas: number;
  cases: TestCase[];
}

/** Instantâneo a cada quatro passos, como no jogo. */
const SNAPSHOT_EVERY = 4;
/** Lote de comandos a cada dois passos, como no jogo. */
const SEND_EVERY = 2;
/** Passos simulados. Dez segundos. */
const TICKS = 600;

/**
 * O relógio do cliente, na versão **corrigida**: anda um por passo e é ajustado
 * pelo instantâneo, em vez de derivado dele.
 */
class GuestClock {
  localTick = 0;
  hostTick = 0;
  lead = 4;
  private sinceAdjust = 0;

  /**
   * @param depth quantos comandos o host tem em fila. É o sinal que faz o avanço
   *   se ajustar sozinho à latência de verdade — sem ele, o avanço fixo de quatro
   *   passos não cobre uma rede lenta e o host passa fome para sempre.
   */
  onSnapshot(hostTick: number, depth: number): void {
    this.hostTick = hostTick;
    if (this.localTick === 0) {
      this.localTick = hostTick + this.lead;
      return;
    }

    // O ajuste do avanço é bem mais raro que o do relógio no jogo (dois
    // segundos); aqui ele corre a cada instantâneo para o teste caber em dez.
    this.sinceAdjust++;
    if (this.sinceAdjust >= 2) {
      this.sinceAdjust = 0;
      if (depth < 2) this.lead = Math.min(this.lead + 1, 20);
      else if (depth > 4) this.lead = Math.max(this.lead - 1, 2);
    }

    const drift = this.hostTick + this.lead - this.localTick;
    if (Math.abs(drift) > 30) this.localTick = this.hostTick + this.lead;
    else if (Math.abs(drift) > 2) this.localTick += Math.sign(drift);
  }

  next(): number {
    return ++this.localTick;
  }
}

/** O relógio quebrado de antes, para o teste provar que ele **não** serve. */
class BrokenClock {
  hostTick = 0;
  lead = 4;

  onSnapshot(hostTick: number): void {
    this.hostTick = hostTick;
  }

  next(): number {
    return this.hostTick + this.lead;
  }
}

interface ClockLike {
  onSnapshot(hostTick: number, depth: number): void;
  next(): number;
}

/**
 * Roda o vaivém completo: cliente carimba, empacota, envia; host desempacota,
 * enfileira, consome. Sem atalho — passa pelo codec de verdade.
 *
 * @returns quantas vezes o host ficou sem comando.
 */
function simulate(
  clock: ClockLike,
  latencyTicks: number,
): { starves: number; consumed: number; lateStarves: number; lateConsumed: number } {
  /**
   * Passos que não contam para o regime.
   *
   * Os primeiros são a partida se acertando: o cliente ainda não sabe onde o host
   * está, e o avanço ainda não encontrou a latência. Contar isso como defeito
   * seria reprovar o sistema justamente pelo que ele faz de certo — se ajustar.
   */
  const WARMUP = 200;

  const buffer = new InputBuffer();
  let starvesAtWarmup = 0;
  const outbox: InputFrame[] = Array.from({ length: 4 }, createInputFrame);
  let outboxCount = 0;

  /** Pacotes em trânsito: chegam `latencyTicks` depois de saírem. */
  const wire: { at: number; data: ArrayBuffer }[] = [];
  const incoming: InputFrame[] = Array.from({ length: 8 }, createInputFrame);

  let hostTick = 0;
  let consumed = 0;

  for (let step = 0; step < TICKS; step++) {
    // --- host: entrega o que chegou ---
    for (let i = wire.length - 1; i >= 0; i--) {
      const packet = wire[i]!;
      if (packet.at > step) continue;
      wire.splice(i, 1);
      const count = decodeInput(packet.data, incoming);
      for (let k = 0; k < count; k++) buffer.push(incoming[k]!);
    }

    // --- cliente: um passo ---
    const tick = clock.next();
    const frame = createInputFrame();
    frame.tick = tick;
    frame.held = InputBit.MoveForward;
    frame.moveY = 1;

    for (let i = outbox.length - 1; i > 0; i--) {
      const source = outbox[i - 1]!;
      const target = outbox[i]!;
      target.tick = source.tick;
      target.held = source.held;
      target.pressed = source.pressed;
      target.moveX = source.moveX;
      target.moveY = source.moveY;
      target.lookX = source.lookX;
      target.lookY = source.lookY;
    }
    const first = outbox[0]!;
    first.tick = frame.tick;
    first.held = frame.held;
    first.moveY = frame.moveY;
    outboxCount = Math.min(outboxCount + 1, outbox.length);

    if (tick % SEND_EVERY === 0) {
      wire.push({ at: step + latencyTicks, data: encodeInput(outbox.slice(0, outboxCount)) });
    }

    // --- host: consome o passo dele ---
    hostTick++;
    buffer.consume(hostTick);
    consumed++;

    // --- host: manda instantâneo ---
    if (hostTick % SNAPSHOT_EVERY === 0) clock.onSnapshot(hostTick, buffer.depth);
    if (step === WARMUP - 1) starvesAtWarmup = buffer.starves;
  }

  return {
    starves: buffer.starves,
    consumed,
    lateStarves: buffer.starves - starvesAtWarmup,
    lateConsumed: consumed - WARMUP,
  };
}

export function runNetClockTests(): TestReport {
  const cases: TestCase[] = [];

  // --- 1. o relógio corrigido alimenta o host ---------------------------------
  // Alguma fome no começo é esperada e correta: até o primeiro instantâneo
  // chegar, o cliente nem sabe em que passo o host está, e o avanço ainda não se
  // acertou com a latência. O que não pode é a fome continuar depois disso —
  // então o que se mede é o **regime**, não o total.
  for (const latency of [1, 3, 9]) {
    const run = simulate(new GuestClock(), latency);
    const rate = run.lateStarves / run.lateConsumed;
    cases.push({
      nome: `relógio corrigido · ${latency} passos de rede`,
      medido: `${run.lateStarves} fomes em ${run.lateConsumed} passos (${(rate * 100).toFixed(1)}%)`,
      esperado: '< 5% depois de estabilizar',
      erro: rate < 0.05 ? '—' : 'o host segue simulando sem comando do outro lado',
      passou: rate < 0.05,
    });
  }

  // --- 2. o relógio antigo tem de falhar --------------------------------------
  // Se este caso passar, o teste deixou de testar o que ele existe para testar.
  const broken = simulate(new BrokenClock(), 3);
  const brokenRate = broken.starves / broken.consumed;
  cases.push({
    nome: 'relógio derivado · reproduz o bug',
    medido: `${broken.starves} fomes (${(brokenRate * 100).toFixed(1)}%)`,
    esperado: '> 50% — ele tem mesmo de falhar',
    erro: brokenRate > 0.5 ? '—' : 'o teste não está mais reproduzindo o defeito',
    passou: brokenRate > 0.5,
  });

  // --- 3. o codec preserva o quadro -------------------------------------------
  const original = createInputFrame();
  original.tick = 123456;
  original.held = InputBit.MoveForward | InputBit.Sprint | InputBit.Aim;
  original.pressed = InputBit.Fire | InputBit.Jump;
  original.moveX = -1;
  original.moveY = 1;
  original.lookX = 0.0731;
  original.lookY = -0.0244;

  const decoded = Array.from({ length: 4 }, createInputFrame);
  decodeInput(encodeInput([original]), decoded);
  const back = decoded[0]!;
  const lookError = Math.max(
    Math.abs(back.lookX - original.lookX),
    Math.abs(back.lookY - original.lookY),
  );
  const exact =
    back.tick === original.tick &&
    back.held === original.held &&
    back.pressed === original.pressed &&
    Math.abs(back.moveX - original.moveX) < 0.01 &&
    Math.abs(back.moveY - original.moveY) < 0.01;

  cases.push({
    nome: 'codec · ida e volta preserva o comando',
    medido: `bits ${exact ? 'exatos' : 'ERRADOS'} · olhar ±${lookError.toExponential(1)} rad`,
    esperado: 'bits exatos · olhar ±1e-4 rad',
    erro: exact && lookError < 1e-4 ? '—' : 'o comando chega diferente do que saiu',
    passou: exact && lookError < 1e-4,
  });

  // --- 4. a fome repete direito ------------------------------------------------
  // Repetir `held` mantém quem estava andando andando; repetir `pressed` daria um
  // tiro que ninguém deu. Ver a política em `InputBuffer`.
  const buffer = new InputBuffer();
  const held = createInputFrame();
  held.tick = 1;
  held.held = InputBit.MoveForward;
  held.pressed = InputBit.Fire;
  held.moveY = 1;
  held.lookX = 0.5;
  buffer.push(held);
  buffer.consume(1);
  const repeated = buffer.consume(2);

  const politicaOk =
    repeated.held === InputBit.MoveForward &&
    repeated.moveY === 1 &&
    repeated.pressed === 0 &&
    repeated.lookX === 0;
  cases.push({
    nome: 'fome · repete o segurado, esquece a borda',
    medido: `held ${repeated.held} · pressed ${repeated.pressed} · look ${repeated.lookX}`,
    esperado: 'held mantido · pressed 0 · look 0',
    erro: politicaOk ? '—' : 'borda repetida vira comando fantasma',
    passou: politicaOk,
  });

  const falhas = cases.filter((c) => !c.passou).length;
  return { passou: falhas === 0, total: cases.length, falhas, cases };
}
