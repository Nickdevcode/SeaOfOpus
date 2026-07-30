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
    // Recorded by the **origin stamp**, and not by the host's step: `claimAhead` can
    // deliver the command on a neighboring step, and it is still the command the player
    // gave. See `InputBuffer.appliedTick`.
    if (buffer.appliedTick >= 0) {
      arrived.set(buffer.appliedTick, (arrived.get(buffer.appliedTick) ?? 0) | applied.pressed);
    }

    // --- host: sends a snapshot ---
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

/** How many bits are set in an integer. Each bit is one press by the player. */
function popcount(bits: number): number {
  let count = 0;
  for (let value = bits; value !== 0; value >>>= 1) count += value & 1;
  return count;
}

export function runNetClockTests(): TestReport {
  const cases: TestCase[] = [];

  // --- 1. the corrected clock feeds the host ----------------------------------
  // Some starvation at the start is expected and correct: until the first snapshot
  // arrives, the client does not even know what step the host is on, and the lead has not
  // yet settled against the latency. What cannot happen is the starvation continuing after
  // that — so what gets measured is the **steady state**, not the total.
  for (const latency of [1, 3, 9]) {
    const run = simulate(new GuestClock(), latency);
    const rate = run.lateStarves / run.lateConsumed;
    cases.push({
      nome: `corrected clock · ${latency} steps of network`,
      medido: `${run.lateStarves} starvations in ${run.lateConsumed} steps (${(rate * 100).toFixed(1)}%)`,
      esperado: '< 5% after settling',
      erro: rate < 0.05 ? '—' : 'the host goes on simulating with no command from the other side',
      passou: rate < 0.05,
    });
  }

  // --- 1b. no command is lost to the clock's correction ------------------------
  //
  // The case this file came to exist to prove. Counting starvation was not enough and
  // never was: a **downward** clock correction repeats the stamp, the host discards the
  // second frame as a duplicate and that step's command disappears without any counter
  // moving. An **upward** correction opens a gap, and that one does become starvation —
  // which the client reads as "I have to run further ahead", which causes more correction
  // and more gap. The ratchet turned all the way to the lead ceiling, and from over there
  // that looks like a sailor who walks without obeying and gets yanked back on every
  // snapshot.
  //
  // What gets measured here is the player, not the host: of every stamped command, how
  // many the host actually applied. See `InputOutbox` for the stitching.
  {
    const run = simulate(new DriftingClock(), 3);
    const lost = run.stamped - run.delivered;
    cases.push({
      nome: 'stitching · a correcting clock eats no command',
      medido: `${lost} presses lost out of ${run.stamped}`,
      esperado: '0 — the window stitches gap and duplicate',
      erro: lost === 0 ? '—' : 'every clock correction costs the player one command',
      passou: lost === 0,
    });

    const rate = run.lateStarves / run.lateConsumed;
    cases.push({
      nome: 'stitching · a correcting clock causes no starvation',
      medido: `${run.lateStarves} starvations in ${run.lateConsumed} steps (${(rate * 100).toFixed(1)}%)`,
      esperado: '< 2% — with no gap there is nothing to be missing',
      erro: rate < 0.02 ? '—' : 'the clock gap became starvation, and starvation pushes the lead up',
      passou: rate < 0.02,
    });
  }

  // --- 1c. a one-step gap is closed by the queue -------------------------------
  //
  // The other side of the same coin, measured from inside `InputBuffer`: when the
  // requested frame did not arrive but the **next** one is already in hand, it is not
  // coming — the network delivers in order. Repeating the previous command in that case is
  // throwing away the right command, which is sitting one step away.
  {
    const gap = new InputBuffer();
    const first = createInputFrame();
    first.tick = 1;
    first.held = InputBit.MoveForward;
    gap.push(first);

    const third = createInputFrame();
    third.tick = 3;
    third.held = InputBit.MoveBack;
    third.pressed = InputBit.Fire;
    gap.push(third);

    gap.consume(1);
    const inTheGap = gap.consume(2);
    const closed =
      gap.starves === 0 &&
      gap.appliedTick === 3 &&
      inTheGap.held === InputBit.MoveBack &&
      inTheGap.pressed === InputBit.Fire;

    cases.push({
      nome: 'queue · a one-step gap uses the next command',
      medido: `starvations ${gap.starves} · applied tick ${gap.appliedTick} · pressed ${inTheGap.pressed}`,
      esperado: 'starvations 0 · tick 3 · the edge preserved',
      erro: closed ? '—' : 'the right command was in the queue and got swapped for a repeat',
      passou: closed,
    });
  }

  // --- 1d. a clock jump is not mistaken for a gap ------------------------------
  //
  // The guard for the case above. A command that is only valid half a second from now
  // cannot be pulled into the present just because the present one is late — there waiting
  // is right, and that is what the starvation policy covers.
  {
    const jump = new InputBuffer();
    const future = createInputFrame();
    future.tick = 400;
    future.pressed = InputBit.Fire;
    jump.push(future);
    jump.consume(1);

    cases.push({
      nome: 'queue · a command from a distant future waits its turn',
      medido: `starvations ${jump.starves} · applied ${jump.appliedTick}`,
      esperado: 'starvations 1 · applied -1 (repeated)',
      erro:
        jump.starves === 1 && jump.appliedTick === -1
          ? '—'
          : 'a command half a second ahead was applied now',
      passou: jump.starves === 1 && jump.appliedTick === -1,
    });
  }

  // --- 2. the old clock has to fail -------------------------------------------
  // If this case passes, the test has stopped testing what it exists to test.
  const broken = simulate(new BrokenClock(), 3);
  const brokenRate = broken.starves / broken.consumed;
  cases.push({
    nome: 'drifting clock · reproduces the bug',
    medido: `${broken.starves} starvations (${(brokenRate * 100).toFixed(1)}%)`,
    esperado: '> 50% — it really does have to fail',
    erro: brokenRate > 0.5 ? '—' : 'the test is no longer reproducing the defect',
    passou: brokenRate > 0.5,
  });

  // --- 3. the codec preserves the frame ---------------------------------------
  const original = createInputFrame();
  original.tick = 123456;
  original.held = InputBit.MoveForward | InputBit.Sprint | InputBit.Aim;
  original.pressed = InputBit.Fire | InputBit.Jump;
  original.moveX = -1;
  original.moveY = 1;
  original.lookX = 0.0731;
  original.lookY = -0.0244;
  // The absolute gaze entered version 2 of the format. The heading goes near half a turn
  // on purpose: that is where the normalization to −π..π has to act, and without it the
  // `i16` at this scale saturates at ±3.27 rad and the opponent's head gets stuck in a
  // corner as soon as they spin around a few times.
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
    nome: 'codec · the round trip preserves the command',
    medido: `bits ${exact ? 'exact' : 'WRONG'} · delta ±${lookError.toExponential(1)} · gaze ±${viewError.toExponential(1)} rad`,
    esperado: 'exact bits · both ±1e-4 rad',
    erro:
      exact && lookError < 1e-4 && viewError < 1e-4
        ? '—'
        : 'the command arrives different from how it left',
    passou: exact && lookError < 1e-4 && viewError < 1e-4,
  });

  // --- 4b. a whole turn does not overflow the scale ----------------------------
  // The heading grows without bound while the player keeps spinning the same way. What has
  // to arrive on the other side is the **same bearing**, and not the same number: 7 rad and
  // 7 − 2π point at the identical place.
  const spun = createInputFrame();
  spun.tick = 7;
  spun.yaw = 7.4;
  const turns = Array.from({ length: 4 }, createInputFrame);
  decodeInput(encodeInput([spun]), turns);
  const equivalent = Math.abs(
    Math.atan2(Math.sin(turns[0]!.yaw - spun.yaw), Math.cos(turns[0]!.yaw - spun.yaw)),
  );
  cases.push({
    nome: 'codec · a heading past one turn points the same way',
    medido: `${spun.yaw} rad → ${turns[0]!.yaw.toFixed(4)} rad (${equivalent.toExponential(1)} of angular difference)`,
    esperado: '< 1e-4 rad',
    erro: equivalent < 1e-4 ? '—' : 'the heading saturates and the head of the opponent sticks in a corner',
    passou: equivalent < 1e-4,
  });

  // --- 4. starvation repeats properly ------------------------------------------
  // Repeating `held` keeps whoever was walking walking; repeating `pressed` would give a
  // shot nobody fired. See the policy in `InputBuffer`.
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

  const policyOk =
    repeated.held === InputBit.MoveForward &&
    repeated.moveY === 1 &&
    repeated.pressed === 0 &&
    repeated.lookX === 0;
  cases.push({
    nome: 'starvation · repeats the held, forgets the edge',
    medido: `held ${repeated.held} · pressed ${repeated.pressed} · look ${repeated.lookX}`,
    esperado: 'held kept · pressed 0 · look 0',
    erro: policyOk ? '—' : 'a repeated edge becomes a phantom command',
    passou: policyOk,
  });

  cases.push(...renderClockCases());

  const falhas = cases.filter((c) => !c.passou).length;
  return { passou: falhas === 0, total: cases.length, falhas, cases };
}

// --- the render clock ----------------------------------------------------------

/**
 * Simulates ten seconds of drawing and returns what you see of the pose.
 *
 * What matters to measure is not the clock itself, it is the **interpolation factor**: it
 * is what decides the pose drawn, and a factor that does not move is a picture that does
 * not move. Hence the two measurements: how many steps the factor sat still (the frozen
 * picture) and the biggest jump it made from one step to the next (the lurch).
 *
 * @param delay render delay in steps, counted from the newest snapshot.
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

    // The host sends a snapshot every four steps; here it arrives on the same step,
    // because what is under test is the interpolation and not the network.
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
    // The factor moves backward when the pair changes (`to` becomes `from` and the factor
    // goes back to the start of the new interval), and that is normal — what counts as a
    // freeze is it not moving from one step to the next, and what counts as advance is
    // only what happens within one pair.
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

  // --- 5. the drawing advances every step --------------------------------------
  // The defect this case guards: with the delay larger than the interval between
  // snapshots, the render target falls **before** the older of the two you have in hand,
  // the factor lives clamped at zero and the pose only changes when a packet arrives. The
  // client's world starts running at fifteen frames per second.
  const corrigido = simulateRender(SNAPSHOT_EVERY);
  const taxaCongelada = corrigido.congelados / corrigido.total;
  cases.push({
    nome: 'render · the pose advances on every step',
    medido: `${corrigido.congelados} frozen steps out of ${corrigido.total} (${(taxaCongelada * 100).toFixed(1)}%)`,
    esperado: '< 5% — the picture does not freeze between snapshots',
    erro: taxaCongelada < 0.05 ? '—' : 'the world of the client runs at the packet rate, in lurches',
    passou: taxaCongelada < 0.05,
  });

  // --- 6. the old delay has to fail --------------------------------------------
  //
  // The same logic as case 2: if this one passes, the test has stopped testing.
  //
  // The arithmetic explains the symptom better than any description: with the target
  // before the older of the two snapshots, the clock spends the start of every interval to
  // the left of the window — factor clamped at zero, picture still — and only afterward
  // does the pose move.
  //
  // The threshold is 10%, and the distance between the two sides is what justifies it: the
  // right delay gives **zero** frozen steps and the wrong one gives a quarter of them. A
  // cut in the middle of that distance does not become equality in disguise — which is
  // exactly what happened when it sat glued to the measured value, first at 50% and then at
  // 25%, and the case started breaking on every tweak to the correction constant without
  // anything real having changed.
  const antigo = simulateRender(6);
  const taxaAntiga = antigo.congelados / antigo.total;
  cases.push({
    nome: 'render · a six-step delay reproduces the bug',
    medido: `${antigo.congelados} frozen steps (${(taxaAntiga * 100).toFixed(1)}%)`,
    esperado: '> 10% — it really does have to fail',
    erro: taxaAntiga > 0.1 ? '—' : 'the test is no longer reproducing the defect',
    passou: taxaAntiga > 0.1,
  });

  // --- 7. and it advances at a constant speed ----------------------------------
  //
  // **This is the judder case**, and it is more demanding than the previous one on
  // purpose: a picture can advance every step and still judder, if it advances different
  // amounts each time. That is what happened with the clock that chased `hostTick` by
  // proportional gain — since `hostTick` is a staircase (still for four steps, up by
  // four), the chase became a sawtooth and the world's speed oscillated 25% at fifteen
  // hertz.
  //
  // What gets measured is the ratio between the largest and the smallest advance of the
  // factor within one pair. In steady state it has to be practically 1.
  const variacao = corrigido.maiorAvanco / corrigido.menorAvanco;
  cases.push({
    nome: 'render · the speed of the world does not oscillate',
    medido: `advance between ${corrigido.menorAvanco.toFixed(4)} and ${corrigido.maiorAvanco.toFixed(4)} (${((variacao - 1) * 100).toFixed(1)}% of oscillation)`,
    esperado: '< 2% — constant speed between packets',
    erro: variacao < 1.02 ? '—' : 'the world speeds up and slows down on every packet: that is the judder',
    passou: variacao < 1.02,
  });

  // --- 8. the estimate chases the host without jumping -------------------------
  // A late packet cannot pull the phase all at once: the jump would come in as a lurch in
  // the world's time. And too large a deviation is not drift — there jumping is right,
  // because catching up a fifth at a time would take minutes.
  const suave = correctHostEstimate(1000, 1002);
  const salto = correctHostEstimate(1000, 1200);
  const suaveOk = suave > 1000 && suave < 1000.5;
  cases.push({
    nome: 'render · the phase corrects gradually, and jumps only on the absurd',
    medido: `deviation of 2 → +${(suave - 1000).toFixed(2)} · deviation of 200 → ${salto}`,
    esperado: 'partial on the small · direct on the large',
    erro: suaveOk && salto === 1200 ? '—' : 'the phase correction is not graduated',
    passou: suaveOk && salto === 1200,
  });

  return cases;
}
