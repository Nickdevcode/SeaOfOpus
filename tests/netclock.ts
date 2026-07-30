/**
 * Net clock test — does the client's command reach the right step on the host?
 *
 * Runs in the browser like the others, and **also** outside it: this is the only
 * test that doesn't touch Three.js, so it can be bundled and run under Node,
 * which makes it useful when there's no browser at hand.
 *
 * ```js
 * const t = await import('/tests/netclock.ts');
 * console.table(t.runNetClockTests().cases);
 * ```
 *
 * **What this proves, and why it exists.** The client that doesn't simulate
 * stamps every command with the step it is meant to take effect on, and the host
 * holds those commands in a queue until their turn comes. If the two clocks don't
 * run together, the host has no command to consume — and since it can't skip a
 * step waiting for the network, it repeats the last one. The player on the other
 * side turns into a puppet that walks off on its own and won't obey.
 *
 * The test was born from a real bug: the stamp was computed as
 * `hostTick + lead`, and `hostTick` only advances when a snapshot arrives —
 * every four steps. Three out of every four commands went out with a repeated
 * stamp, were dropped as duplicates, and the host starved on a perfect network.
 * `starves` in the thousands was what gave it away.
 */

import { createInputFrame, InputBit, type InputFrame } from '../src/core/InputFrame';
import { InputBuffer } from '../src/net/InputBuffer';
import { InputOutbox } from '../src/net/InputOutbox';
import {
  advanceHostEstimate,
  correctHostEstimate,
  interpolationFactor,
} from '../src/net/renderClock';
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

/** Snapshot every four steps, as in the game. */
const SNAPSHOT_EVERY = 4;
/** Command batch every two steps, as in the game. */
const SEND_EVERY = 2;
/** Simulated steps. Ten seconds. */
const TICKS = 600;

/**
 * The edges each step identifies itself with, in rotation.
 *
 * Four distinct bits, one per step. That's what makes it possible to prove, on
 * the host side, **which** presses arrived — and not just how many frames. See
 * the note in `simulate`.
 */
const STEP_MARKS = [InputBit.Fire, InputBit.Jump, InputBit.Reload, InputBit.Interact];

/**
 * The client clock, in the **corrected** version: it advances one per step and is
 * adjusted by the snapshot instead of derived from it.
 */
class GuestClock {
  localTick = 0;
  hostTick = 0;
  lead = 4;
  private sinceAdjust = 0;

  /**
   * @param depth how many commands the host has queued. It's the signal that makes
   *   the lead adjust itself to the real latency — without it, the fixed four-step
   *   lead doesn't cover a slow network and the host starves forever.
   */
  onSnapshot(hostTick: number, depth: number): void {
    this.hostTick = hostTick;
    if (this.localTick === 0) {
      this.localTick = hostTick + this.lead;
      return;
    }

    // The lead adjustment is far rarer than the clock's in the game (two
    // seconds); here it runs on every snapshot so the test fits in ten.
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

/** The old broken clock, so the test can prove it **doesn't** work. */
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

/**
 * A clock that **corrects its phase all the time**, to exercise the stitching.
 *
 * The `GuestClock` above eventually settles: once the warmup is over the lead
 * finds the latency and the correction disappears, so it never gets to exercise
 * the case that matters. And the case that matters is the normal one in a real
 * duel — two quartz crystals in different machines always drift, and every lead
 * adjustment reopens the correction.
 *
 * This one forces the issue: it goes up and down one step alternately, at the
 * rate an unstable network would produce over a whole afternoon. Every step up
 * is a skipped stamp and every step down is a repeated stamp — which was exactly
 * one lost command, one way or the other.
 */
class DriftingClock {
  localTick = 0;
  hostTick = 0;
  lead = 8;
  private snapshots = 0;
  private direction = 1;
  /**
   * ⚠️ A flag, and **not** `localTick === 0`.
   *
   * The clock runs from the first step, and the first snapshot arrives dozens of
   * steps later — so the comparison against zero is never true and the initial
   * alignment never happens. It's the same mistake `GuestSession` made, and it
   * was reproduced here by accident while writing this test: the host starved on
   * a hundred percent of the steps, which is exactly the symptom the original
   * defect produced.
   */
  private started = false;

  onSnapshot(hostTick: number): void {
    this.hostTick = hostTick;
    if (!this.started) {
      this.started = true;
      this.localTick = hostTick + this.lead;
      return;
    }

    // One nudge every three snapshots: five per second, alternating sides. It's
    // more punishment than a real network hands out, and that's the point.
    this.snapshots++;
    if (this.snapshots % 3 !== 0) return;
    this.localTick += this.direction;
    this.direction = this.direction === 1 ? -1 : 1;
  }

  next(): number {
    return ++this.localTick;
  }
}

interface ClockLike {
  onSnapshot(hostTick: number, depth: number): void;
  next(): number;
}

/**
 * Runs the full round trip: client stamps, packs, sends; host unpacks, queues,
 * consumes. No shortcut — it goes through the real codec.
 *
 * @returns how many times the host ran out of commands.
 */
function simulate(
  clock: ClockLike,
  latencyTicks: number,
): {
  starves: number;
  consumed: number;
  lateStarves: number;
  lateConsumed: number;
  /** Edges the player produced and the host actually applied. */
  delivered: number;
  /** Edges the player produced inside the counted window. */
  stamped: number;
} {
  /**
   * Steps that don't count toward the steady state.
   *
   * The first ones are the match settling in: the client doesn't know yet where
   * the host is, and the lead hasn't found the latency. Counting that as a defect
   * would fail the system for the very thing it gets right — adjusting.
   */
  const WARMUP = 200;

  const buffer = new InputBuffer();
  let starvesAtWarmup = 0;
  const outbox = new InputOutbox();

  /** Packets in flight: they arrive `latencyTicks` after leaving. */
  const wire: { at: number; data: ArrayBuffer }[] = [];
  const incoming: InputFrame[] = Array.from({ length: 8 }, createInputFrame);

  let hostTick = 0;
  let consumed = 0;

  /**
   * The **edges** the player produced on each tick, and the ones that got there.
   *
   * It's the measurement that really matters, and getting to it took two tries.
   * Counting starvation measures the host, not the player. Counting *delivered
   * ticks* isn't enough either, and that was the first version of this test: when
   * a stamp repeats, the tick arrives — with the other step's command missing
   * inside it. The counter said "delivered" and the `F` at the helm was gone.
   *
   * An edge is what the player presses, and it's where the loss hurts: a shot
   * that doesn't go off, a station nobody takes, a jump that doesn't happen. The
   * expectation is the **union** of the edges on one same tick, because two steps
   * landing on the same stamp are two presses that both have to count.
   */
  const expected = new Map<number, number>();
  const arrived = new Map<number, number>();
  /**
   * The last step on which stamping still counts.
   *
   * The client runs ahead of the host, so the commands from the final steps are
   * still on the wire or in the queue when the run ends — charging for them would
   * fail the system for not having traveled in time. The margin covers the lead,
   * the network and the batch granularity.
   */
  const LAST_COUNTED = TICKS - latencyTicks - 24;

  for (let step = 0; step < TICKS; step++) {
    // --- host: deliver what arrived ---
    for (let i = wire.length - 1; i >= 0; i--) {
      const packet = wire[i]!;
      if (packet.at > step) continue;
      wire.splice(i, 1);
      const count = decodeInput(packet.data, incoming);
      for (let k = 0; k < count; k++) buffer.push(incoming[k]!);
    }

    // --- client: one step ---
    const tick = clock.next();
    const frame = createInputFrame();
    frame.tick = tick;
    frame.held = InputBit.MoveForward;
    frame.moveY = 1;
    // One edge per step, and the mark comes from the **step**, not from the tick.
    //
    // The distinction is what gives the test teeth, and the first version got it
    // wrong: with the mark coming from the tick, two steps landing on the same
    // stamp — which is exactly what a downward clock correction produces —
    // pressed the same button. The lost command was indistinguishable from the
    // delivered one, and the counter said zero losses while the stitching was off.
    frame.pressed = STEP_MARKS[step % STEP_MARKS.length]!;
    if (step >= WARMUP && step < LAST_COUNTED) {
      expected.set(tick, (expected.get(tick) ?? 0) | frame.pressed);
    }

    outbox.add(frame);
    if (tick % SEND_EVERY === 0) {
      wire.push({ at: step + latencyTicks, data: encodeInput(outbox.batch) });
    }

    // --- host: consume its own step ---
    hostTick++;
    const applied = buffer.consume(hostTick);
    consumed++;
    // Anotado pelo **carimbo de origem**, e não pelo passo do host: `claimAhead`
    // pode entregar o comando num passo vizinho, e ele continua sendo o comando
    // que o jogador deu. Ver `InputBuffer.appliedTick`.
    if (buffer.appliedTick >= 0) {
      arrived.set(buffer.appliedTick, (arrived.get(buffer.appliedTick) ?? 0) | applied.pressed);
    }

    // --- host: manda instantâneo ---
    if (hostTick % SNAPSHOT_EVERY === 0) clock.onSnapshot(hostTick, buffer.depth);
    if (step === WARMUP - 1) starvesAtWarmup = buffer.starves;
  }

  let stamped = 0;
  let delivered = 0;
  for (const [tick, bits] of expected) {
    stamped += popcount(bits);
    delivered += popcount(bits & (arrived.get(tick) ?? 0));
  }

  return {
    starves: buffer.starves,
    consumed,
    lateStarves: buffer.starves - starvesAtWarmup,
    lateConsumed: consumed - WARMUP,
    delivered,
    stamped,
  };
}

/** Quantos bits ligados há num inteiro. Cada bit é um aperto do jogador. */
function popcount(bits: number): number {
  let count = 0;
  for (let value = bits; value !== 0; value >>>= 1) count += value & 1;
  return count;
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

  // --- 1b. nenhum comando se perde na correção do relógio ----------------------
  //
  // O caso que este arquivo passou a existir para provar. Contar fome não bastava
  // e nunca bastou: uma correção de relógio **para baixo** repete o carimbo, o
  // host descarta o segundo quadro como duplicata e o comando daquele passo some
  // sem que nenhum contador se mexa. Uma correção **para cima** abre um buraco, e
  // esse sim vira fome — que o cliente lê como "preciso correr mais à frente", o
  // que provoca mais correção e mais buraco. A catraca girava até o teto de
  // avanço, e do lado de lá isso se vê como um marujo que anda sem obedecer e é
  // puxado de volta a cada instantâneo.
  //
  // O que se mede aqui é o jogador, não o host: de cada comando carimbado,
  // quantos o host chegou a aplicar. Ver `InputOutbox` para a costura.
  {
    const run = simulate(new DriftingClock(), 3);
    const lost = run.stamped - run.delivered;
    cases.push({
      nome: 'costura · relógio corrigindo não come comando',
      medido: `${lost} apertos perdidos em ${run.stamped}`,
      esperado: '0 — a janela costura buraco e duplicata',
      erro: lost === 0 ? '—' : 'cada correção de relógio custa um comando do jogador',
      passou: lost === 0,
    });

    const rate = run.lateStarves / run.lateConsumed;
    cases.push({
      nome: 'costura · relógio corrigindo não provoca fome',
      medido: `${run.lateStarves} fomes em ${run.lateConsumed} passos (${(rate * 100).toFixed(1)}%)`,
      esperado: '< 2% — sem buraco não há o que faltar',
      erro: rate < 0.02 ? '—' : 'o buraco do relógio virou fome, e fome faz o avanço subir',
      passou: rate < 0.02,
    });
  }

  // --- 1c. um buraco de um passo é fechado pela fila ---------------------------
  //
  // O outro lado da mesma moeda, medido de dentro do `InputBuffer`: quando o
  // quadro pedido não veio mas o **seguinte** já está em mãos, ele não vem mais —
  // a rede entrega em ordem. Repetir o comando anterior nesse caso é jogar fora o
  // comando certo, que está guardado a um passo de distância.
  {
    const gap = new InputBuffer();
    const primeiro = createInputFrame();
    primeiro.tick = 1;
    primeiro.held = InputBit.MoveForward;
    gap.push(primeiro);

    const terceiro = createInputFrame();
    terceiro.tick = 3;
    terceiro.held = InputBit.MoveBack;
    terceiro.pressed = InputBit.Fire;
    gap.push(terceiro);

    gap.consume(1);
    const noBuraco = gap.consume(2);
    const fechou =
      gap.starves === 0 &&
      gap.appliedTick === 3 &&
      noBuraco.held === InputBit.MoveBack &&
      noBuraco.pressed === InputBit.Fire;

    cases.push({
      nome: 'fila · buraco de um passo usa o comando seguinte',
      medido: `fomes ${gap.starves} · aplicou o tick ${gap.appliedTick} · pressed ${noBuraco.pressed}`,
      esperado: 'fomes 0 · tick 3 · a borda preservada',
      erro: fechou ? '—' : 'o comando certo estava na fila e foi trocado por uma repetição',
      passou: fechou,
    });
  }

  // --- 1d. um salto de relógio não é confundido com buraco ---------------------
  //
  // A guarda do caso acima. Um comando que só vale daqui a meio segundo não pode
  // ser puxado para agora só porque o de agora está atrasado — aí a espera é o
  // certo, e é o que a política de fome cobre.
  {
    const jump = new InputBuffer();
    const futuro = createInputFrame();
    futuro.tick = 400;
    futuro.pressed = InputBit.Fire;
    jump.push(futuro);
    jump.consume(1);

    cases.push({
      nome: 'fila · comando de um futuro distante espera a vez dele',
      medido: `fomes ${jump.starves} · aplicou ${jump.appliedTick}`,
      esperado: 'fomes 1 · aplicou -1 (repetiu)',
      erro:
        jump.starves === 1 && jump.appliedTick === -1
          ? '—'
          : 'um comando de meio segundo à frente foi aplicado agora',
      passou: jump.starves === 1 && jump.appliedTick === -1,
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
  // O olhar absoluto entrou na versão 2 do formato. O rumo vai perto de meia
  // volta de propósito: é onde a normalização para −π..π tem de agir, e sem ela
  // o `i16` desta escala satura em ±3,27 rad e a cabeça do adversário fica presa
  // num canto assim que ele der algumas voltas.
  original.yaw = 3.0416;
  original.pitch = -0.6123;

  const decoded = Array.from({ length: 4 }, createInputFrame);
  decodeInput(encodeInput([original]), decoded);
  const back = decoded[0]!;
  const lookError = Math.max(
    Math.abs(back.lookX - original.lookX),
    Math.abs(back.lookY - original.lookY),
  );
  const viewError = Math.max(
    Math.abs(back.yaw - original.yaw),
    Math.abs(back.pitch - original.pitch),
  );
  const exact =
    back.tick === original.tick &&
    back.held === original.held &&
    back.pressed === original.pressed &&
    back.absoluteView &&
    Math.abs(back.moveX - original.moveX) < 0.01 &&
    Math.abs(back.moveY - original.moveY) < 0.01;

  cases.push({
    nome: 'codec · ida e volta preserva o comando',
    medido: `bits ${exact ? 'exatos' : 'ERRADOS'} · delta ±${lookError.toExponential(1)} · olhar ±${viewError.toExponential(1)} rad`,
    esperado: 'bits exatos · ambos ±1e-4 rad',
    erro:
      exact && lookError < 1e-4 && viewError < 1e-4
        ? '—'
        : 'o comando chega diferente do que saiu',
    passou: exact && lookError < 1e-4 && viewError < 1e-4,
  });

  // --- 4b. uma volta inteira não estoura a escala ------------------------------
  // O rumo cresce sem limite enquanto o jogador gira sempre para o mesmo lado.
  // O que tem de chegar do outro lado é o **mesmo apontamento**, e não o mesmo
  // número: 7 rad e 7 − 2π apontam para o lugar idêntico.
  const girado = createInputFrame();
  girado.tick = 7;
  girado.yaw = 7.4;
  const voltas = Array.from({ length: 4 }, createInputFrame);
  decodeInput(encodeInput([girado]), voltas);
  const equivalente = Math.abs(
    Math.atan2(Math.sin(voltas[0]!.yaw - girado.yaw), Math.cos(voltas[0]!.yaw - girado.yaw)),
  );
  cases.push({
    nome: 'codec · rumo além de uma volta aponta para o mesmo lado',
    medido: `${girado.yaw} rad → ${voltas[0]!.yaw.toFixed(4)} rad (${equivalente.toExponential(1)} de diferença angular)`,
    esperado: '< 1e-4 rad',
    erro: equivalente < 1e-4 ? '—' : 'o rumo satura e a cabeça do adversário trava num canto',
    passou: equivalente < 1e-4,
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

  cases.push(...renderClockCases());

  const falhas = cases.filter((c) => !c.passou).length;
  return { passou: falhas === 0, total: cases.length, falhas, cases };
}

// --- o relógio de desenho ------------------------------------------------------

/**
 * Simula o desenho de dez segundos e devolve o que se vê da pose.
 *
 * O que interessa medir não é o relógio em si, é o **fator de interpolação**:
 * ele é o que decide a pose desenhada, e um fator que não anda é uma imagem que
 * não anda. Daí as duas medidas: quantos passos o fator ficou parado (a imagem
 * congelada) e o maior salto que ele deu de um passo para o outro (o tranco).
 *
 * @param delay atraso de desenho em passos, contado do instantâneo mais novo.
 */
function simulateRender(delay: number): {
  congelados: number;
  maiorAvanco: number;
  menorAvanco: number;
  total: number;
} {
  const TICKS = 600;
  const WARMUP = 60;

  let hostEstimate = 0;
  let fromTick = 0;
  let toTick = 0;
  let hostTick = 0;
  let temPar = false;
  let comecou = false;
  let anterior = -1;

  let congelados = 0;
  let maiorAvanco = 0;
  let menorAvanco = Number.POSITIVE_INFINITY;
  let total = 0;

  for (let step = 0; step < TICKS; step++) {
    hostTick++;

    // O host manda um instantâneo a cada quatro passos; aqui ele chega no mesmo
    // passo, porque o que está sob teste é a interpolação e não a rede.
    if (hostTick % SNAPSHOT_EVERY === 0) {
      if (toTick > 0) {
        fromTick = toTick;
        temPar = true;
      }
      toTick = hostTick;
      if (!comecou) {
        comecou = true;
        hostEstimate = hostTick;
      } else {
        hostEstimate = correctHostEstimate(hostEstimate, hostTick);
      }
    }
    if (!comecou) continue;

    hostEstimate = advanceHostEstimate(hostEstimate);
    const t = temPar ? interpolationFactor(hostEstimate - delay, fromTick, toTick) : 1;

    if (step < WARMUP) {
      anterior = t;
      continue;
    }

    total++;
    // O fator anda para trás quando o par troca (o `to` vira `from` e o fator
    // volta ao começo do novo intervalo), e isso é normal — o que se conta como
    // congelamento é ele não sair do lugar de um passo para o outro, e como
    // avanço só o que acontece dentro de um mesmo par.
    const avanco = t - anterior;
    if (Math.abs(avanco) < 1e-9) congelados++;
    else if (avanco > 0) {
      maiorAvanco = Math.max(maiorAvanco, avanco);
      menorAvanco = Math.min(menorAvanco, avanco);
    }
    anterior = t;
  }

  return { congelados, maiorAvanco, menorAvanco, total };
}

function renderClockCases(): TestCase[] {
  const cases: TestCase[] = [];

  // --- 5. o desenho anda a cada passo -----------------------------------------
  // O defeito que este caso guarda: com o atraso maior que o intervalo entre
  // instantâneos, o alvo do desenho cai **antes** do mais velho dos dois que se
  // tem em mão, o fator vive grampeado em zero e a pose só muda quando chega
  // pacote. O mundo do cliente passa a andar a quinze quadros por segundo.
  const corrigido = simulateRender(SNAPSHOT_EVERY);
  const taxaCongelada = corrigido.congelados / corrigido.total;
  cases.push({
    nome: 'desenho · a pose anda em todo passo',
    medido: `${corrigido.congelados} passos parados em ${corrigido.total} (${(taxaCongelada * 100).toFixed(1)}%)`,
    esperado: '< 5% — a imagem não congela entre instantâneos',
    erro: taxaCongelada < 0.05 ? '—' : 'o mundo do cliente anda na taxa dos pacotes, aos trancos',
    passou: taxaCongelada < 0.05,
  });

  // --- 6. o atraso antigo tem de falhar ----------------------------------------
  //
  // Mesma lógica do caso 2: se este passar, o teste parou de testar.
  //
  // A conta explica o sintoma melhor que qualquer descrição: com o alvo antes do
  // instantâneo mais velho dos dois, o relógio gasta o começo de cada intervalo
  // à esquerda da janela — fator grampeado em zero, imagem parada — e só depois
  // a pose anda.
  //
  // O limiar é 10%, e a distância entre os dois lados é o que o justifica: o
  // atraso certo dá **zero** passos parados e o errado dá um quarto deles. Um
  // corte no meio dessa distância não vira igualdade disfarçada — que foi
  // exatamente o que aconteceu quando ele ficou colado no valor medido, primeiro
  // em 50% e depois em 25%, e o caso passou a quebrar a cada ajuste na constante
  // de correção sem que nada de verdade tivesse mudado.
  const antigo = simulateRender(6);
  const taxaAntiga = antigo.congelados / antigo.total;
  cases.push({
    nome: 'desenho · atraso de seis passos reproduz o bug',
    medido: `${antigo.congelados} passos parados (${(taxaAntiga * 100).toFixed(1)}%)`,
    esperado: '> 10% — ele tem mesmo de falhar',
    erro: taxaAntiga > 0.1 ? '—' : 'o teste não está mais reproduzindo o defeito',
    passou: taxaAntiga > 0.1,
  });

  // --- 7. e anda com velocidade constante ---------------------------------------
  //
  // **Este é o caso do tremor**, e ele é mais exigente que o anterior de
  // propósito: uma imagem pode andar em todo passo e ainda assim tremer, se
  // andar quantidades diferentes a cada um. Era o que acontecia com o relógio
  // que perseguia `hostTick` por ganho proporcional — como `hostTick` é um
  // degrau (parado quatro passos, sobe quatro), a perseguição virava um dente de
  // serra e a velocidade do mundo oscilava 25% a quinze hertz.
  //
  // O que se mede é a razão entre o maior e o menor avanço do fator dentro de um
  // par. Em regime ela tem de ser praticamente 1.
  const variacao = corrigido.maiorAvanco / corrigido.menorAvanco;
  cases.push({
    nome: 'desenho · a velocidade do mundo não oscila',
    medido: `avanço entre ${corrigido.menorAvanco.toFixed(4)} e ${corrigido.maiorAvanco.toFixed(4)} (${((variacao - 1) * 100).toFixed(1)}% de oscilação)`,
    esperado: '< 2% — velocidade constante entre pacotes',
    erro: variacao < 1.02 ? '—' : 'o mundo acelera e desacelera a cada pacote: é o tremor',
    passou: variacao < 1.02,
  });

  // --- 8. a estimativa persegue o host sem saltar --------------------------------
  // Um pacote atrasado não pode puxar a fase de uma vez: o salto entraria como
  // um solavanco no tempo do mundo. E um desvio grande demais não é deriva —
  // aí saltar é o certo, porque alcançar de um quinto em um quinto levaria
  // minutos.
  const suave = correctHostEstimate(1000, 1002);
  const salto = correctHostEstimate(1000, 1200);
  const suaveOk = suave > 1000 && suave < 1000.5;
  cases.push({
    nome: 'desenho · a fase se corrige aos poucos, e salta só no absurdo',
    medido: `desvio de 2 → +${(suave - 1000).toFixed(2)} · desvio de 200 → ${salto}`,
    esperado: 'parcial no pequeno · direto no grande',
    erro: suaveOk && salto === 1200 ? '—' : 'a correção de fase não está graduada',
    passou: suaveOk && salto === 1200,
  });

  return cases;
}
