import { describe, expect, it } from 'vitest';
import { CROSS_CHAIN_TRADE_CHAINS, JOURNEY_CAP_RAW, crossChainTradeOn, journeyCapProblem, journeyFeeSchedule, journeyProblems, journeyQuote, landedForSwap, moveAmountWithin, swapProven } from './crossChainTrade.js';
import { JourneySettlementExecutor, SwapLegExecutor, type PreparedTrade, type SendResult, type SwapPorts, type TxStatus } from './swapLeg.js';
import { assetKeyOf, pendingSettlementLeg, type ExecutionLeg } from './executionQuote.js';
import { planRoutes, type Capabilities } from './planner.js';
import { PlanRunner, type LegExecutor, type LegProgress } from './runner.js';
import { JsonVersionedStore } from './store.js';
import { canStopHere, whereAreTheFunds, type PlanLeg, type PlanRecord } from './state.js';
import { diagnosePlan } from './recovery.js';
import { DeferredSettlementExecutor } from './deferred.js';
import { SettlementLegExecutor } from './executors.js';
import { CrossChainOrchestrator } from '../orchestrator/orchestrator.js';
import { InMemoryExecutionStore } from '../orchestrator/store.js';
import { SettlementQuoteEngine } from '../settlement/engine.js';
import { MockSettlementProvider } from '../settlement/testing.js';
import { CCTP_USDC, MOVE_CAP_RAW } from '../settlement/cctp.js';
import { EVM_NATIVE_ADDRESS, type ChainId } from '../core/types.js';
import type { SettlementQuote } from '../settlement/types.js';

const NOW = 1_000_000;
const SOL = 'So11111111111111111111111111111111111111112';
const MEME = 'MeMe9xQwErTyUiOpAsDfGhJkLzXcVbNm1234567pump';
const BASE_TOKEN = '0x' + 'B'.repeat(40);
const EVM_ME = '0x' + 'a'.repeat(40);
const SOL_ME = 'So1anaWa11et1111111111111111111111111111111';
const usdc = (c: ChainId): string | null => CCTP_USDC[c] ?? null;
const usdcKey = (c: ChainId): string => assetKeyOf(c, usdc(c)!);

describe('planning a cross-chain trade', () => {
  it('is off unless the build flag is exactly "1"', () => {
    expect(crossChainTradeOn('1')).toBe(true);
    for (const v of [undefined, '', '0', 'true', 1]) expect(crossChainTradeOn(v)).toBe(false);
  });

  it('covers exactly the networks Circle moves USDC between in the app', () => {
    expect([...CROSS_CHAIN_TRADE_CHAINS].sort()).toEqual(['base', 'ethereum', 'polygon', 'solana']);
    for (const c of CROSS_CHAIN_TRADE_CHAINS) expect(usdc(c)).toBeTruthy();
  });

  it('refuses BNB Chain and Robinhood Chain, same-network trades, zero amounts and USDC-to-USDC, in plain words', () => {
    const t = (chain: ChainId, address: string) => ({ chain, address, symbol: 'X', decimals: 6 });
    expect(journeyProblems({ ...t('bnb', EVM_NATIVE_ADDRESS), amount: 1n }, t('base', BASE_TOKEN), usdc).join(' ')).toMatch(/does not cover BNB Chain/);
    expect(journeyProblems({ ...t('solana', SOL), amount: 1n }, t('robinhood', BASE_TOKEN), usdc).join(' ')).toMatch(/does not cover Robinhood/);
    expect(journeyProblems({ ...t('base', EVM_NATIVE_ADDRESS), amount: 1n }, t('base', BASE_TOKEN), usdc).join(' ')).toMatch(/same network/);
    expect(journeyProblems({ ...t('solana', SOL), amount: 0n }, t('base', BASE_TOKEN), usdc).join(' ')).toMatch(/above zero/);
    expect(journeyProblems({ ...t('solana', usdc('solana')!), amount: 5n }, t('base', usdc('base')!.toUpperCase().replace('0X', '0x')), usdc).join(' ')).toMatch(/Move USDC/);
    expect(journeyProblems({ ...t('solana', SOL), amount: 5n }, t('base', BASE_TOKEN), usdc, (c) => c !== 'base').join(' ')).toMatch(/Base is not switched on/);
    expect(journeyProblems({ ...t('solana', SOL), amount: 5n }, t('base', BASE_TOKEN), usdc)).toEqual([]);
  });

  it('plans swap, move, swap, and keeps Solana addresses exactly as written (lower-casing one names another account)', async () => {
    const cap: Capabilities = { rampChains: async () => [], canSettle: async () => true, canSwap: async () => true, usdc };
    const r = await planRoutes({ from: { kind: 'token', chain: 'solana', address: MEME, symbol: 'MEME', decimals: 6, amount: 1n }, to: { kind: 'token', chain: 'base', address: BASE_TOKEN, symbol: 'B', decimals: 18 }, country: null }, cap);
    expect(r.plans[0]!.steps.map((s) => `${s.kind}@${s.chain}`)).toEqual(['swap@solana', 'settlement@solana', 'swap@base']);
    expect(r.plans[0]!.steps[0]).toMatchObject({ inAddress: MEME, outAddress: usdc('solana') });
    expect(r.plans[0]!.steps[2]).toMatchObject({ inAddress: usdc('base'), outAddress: BASE_TOKEN.toLowerCase() });
    expect(assetKeyOf('solana', MEME)).toBe(MEME);
    expect(assetKeyOf('base', BASE_TOKEN)).toBe(BASE_TOKEN.toLowerCase());
  });

  it('paying with USDC leaves out the first swap', async () => {
    const cap: Capabilities = { rampChains: async () => [], canSettle: async () => true, canSwap: async () => true, usdc };
    const r = await planRoutes({ from: { kind: 'token', chain: 'ethereum', address: usdc('ethereum')!, symbol: 'USDC', decimals: 6, amount: 1n }, to: { kind: 'token', chain: 'solana', address: MEME, symbol: 'MEME', decimals: 6 }, country: null }, cap);
    expect(r.plans[0]!.steps.map((s) => s.kind)).toEqual(['settlement', 'swap']);
  });
});

describe('fees shown up front', () => {
  const tok = (chain: ChainId, address: string, symbol: string) => ({ chain, address, symbol, decimals: 6 });

  it('paying with a coin: 0.58% + 0.1% + 0.58%, the same as doing each step by hand', () => {
    const f = journeyFeeSchedule(tok('solana', SOL, 'SOL'), tok('base', BASE_TOKEN, 'B'), usdc);
    expect(f.lines.map((l) => l.rate)).toEqual(['0.58%', '0.1%', '0.58%']);
    expect(f.maxBps).toBe(126);
    expect(f.summary).toMatch(/at most 1\.26%/);
    expect(f.summary).toMatch(/same fees as doing each step yourself/);
  });

  it('selling a token that is not a coin or stablecoin: no fee on the first swap, like an ordinary sale', () => {
    const f = journeyFeeSchedule(tok('solana', MEME, 'MEME'), tok('base', BASE_TOKEN, 'B'), usdc);
    expect(f.lines.map((l) => l.bps)).toEqual([0, 10, 58]);
    expect(f.lines[0]!.why).toMatch(/no Aretia fee/);
    expect(f.maxBps).toBe(68);
  });

  it('paying with USDC or buying USDC drops the swap that is not needed', () => {
    expect(journeyFeeSchedule(tok('ethereum', usdc('ethereum')!, 'USDC'), tok('solana', MEME, 'MEME'), usdc).lines.map((l) => l.bps)).toEqual([10, 58]);
    expect(journeyFeeSchedule(tok('ethereum', EVM_NATIVE_ADDRESS, 'ETH'), tok('solana', usdc('solana')!, 'USDC'), usdc).lines.map((l) => l.bps)).toEqual([58, 10]);
  });
});

describe('the per-journey cap', () => {
  it('is 10,000 USDC, the same as one Move USDC move', () => {
    expect(JOURNEY_CAP_RAW).toBe(MOVE_CAP_RAW);
    expect(JOURNEY_CAP_RAW).toBe(10_000_000_000n);
  });

  it('refuses an amount above it, an amount it cannot work out, and nothing', () => {
    expect(journeyCapProblem(JOURNEY_CAP_RAW)).toBeNull();
    expect(journeyCapProblem(JOURNEY_CAP_RAW + 1n)).toMatch(/at most 10,?000(\.0+)? USDC/);
    expect(journeyCapProblem(null)).toMatch(/could not be worked out/);
    expect(journeyCapProblem(0n)).toMatch(/no USDC/);
  });

  const swapLeg = (chain: ChainId, from: string, to: string, inAmt: bigint, outAmt: bigint): ExecutionLeg => ({ id: `s-${chain}`, kind: 'swap', title: 'swap', input: { chain, assetKey: assetKeyOf(chain, from), symbol: 'A', decimals: 6, amount: inAmt }, output: { chain, assetKey: assetKeyOf(chain, to), symbol: 'B', decimals: 6, amount: outAmt }, fees: [], estimatedSeconds: 10, risk: 'low', signatures: 1, expiresAt: NOW + 60_000, notes: [] });
  const move = (amount: bigint | null) => ({ ...pendingSettlementLeg('m', { chain: 'solana', address: usdc('solana')! }, { chain: 'base', address: usdc('base')! }, 20), input: { chain: 'solana' as const, assetKey: usdcKey('solana'), symbol: 'USDC', decimals: 6, amount }, output: { chain: 'base' as const, assetKey: usdcKey('base'), symbol: 'USDC', decimals: 6, amount } });

  it('a joined plan that would move more than the cap is refused before anything starts', () => {
    expect(() => journeyQuote('j', { first: swapLeg('solana', SOL, usdc('solana')!, 1n, JOURNEY_CAP_RAW * 2n), move: move(JOURNEY_CAP_RAW + 1n), last: null }, 1n)).toThrow(/at most/);
    const ok = journeyQuote('j', { first: swapLeg('solana', SOL, usdc('solana')!, 5n, 100n), move: move(100n), last: swapLeg('base', usdc('base')!, BASE_TOKEN, 100n, 7n) }, 5n);
    expect(ok.legs.map((l) => l.kind)).toEqual(['swap', 'settlement', 'swap']);
    expect(ok.spend.amount).toBe(5n);
  });

  it('paying with USDC: the move takes exactly what was typed, fees included', () => {
    const q = journeyQuote('j', { first: null, move: move(90n), last: swapLeg('base', usdc('base')!, BASE_TOKEN, 90n, 7n) }, 100n);
    expect(q.spend).toMatchObject({ amount: 100n, symbol: 'USDC', chain: 'solana' });
  });

  it('works out the most USDC a move can carry with its 0.1% fee on top', () => {
    const a = moveAmountWithin(100_000_000n)!;
    expect(a + (a * 10n + 9_999n) / 10_000n).toBeLessThanOrEqual(100_000_000n);
    expect(a).toBeGreaterThan(99_890_000n);
    expect(moveAmountWithin(0n)).toBeNull();
    expect(moveAmountWithin(1_000n, 1_000n)).toBeNull();
  });
});

describe('proof by balance', () => {
  it('a swap is done only when the output rose by its minimum; an unreadable balance proves nothing', () => {
    expect(swapProven({ baseline: 10n, now: 110n, min: 100n, outputIsNative: false, networkFee: null })).toBe(true);
    expect(swapProven({ baseline: 10n, now: 109n, min: 100n, outputIsNative: false, networkFee: null })).toBe(false);
    expect(swapProven({ baseline: 10n, now: null, min: 100n, outputIsNative: false, networkFee: null })).toBe(false);
    // The network's own coin also pays the network fee from the same balance.
    expect(swapProven({ baseline: 0n, now: 9_000n, min: 10_000n, outputIsNative: true, networkFee: 900n })).toBe(true);
    expect(swapProven({ baseline: 0n, now: 5_000n, min: 10_000n, outputIsNative: true, networkFee: 900n })).toBe(false);
  });

  it('the last swap takes what landed from the move, never USDC the user already had', () => {
    expect(landedForSwap(50n, 150n, 100n)).toBe(100n);
    expect(landedForSwap(50n, 250n, 100n)).toBe(100n);
    expect(landedForSwap(50n, 140n, 100n)).toBe(90n);
    expect(landedForSwap(50n, 50n, 100n)).toBeNull();
    expect(landedForSwap(50n, 140n, null)).toBe(90n);
  });
});

// ------------------------------------------------------------------ the journey, end to end, with fake chains

/** A tiny world: balances per chain and asset, a wallet that signs swaps, and a chain that confirms or fails them. */
function world() {
  const balances = new Map<string, bigint>();
  const k = (c: ChainId, a: string) => `${c}:${a}`;
  const get = (c: ChainId, a: string) => balances.get(k(c, a)) ?? 0n;
  const set = (c: ChainId, a: string, v: bigint) => balances.set(k(c, a), v);
  const status = new Map<string, TxStatus>();
  const sent: string[] = [];
  const memory = new Map<string, string>();
  let unreadable = false;
  let outcome: 'land' | 'fail' | 'pending' = 'land';
  let reviewAnswer = true;
  let n = 0;
  const ports: SwapPorts = {
    balanceOf: async (c, _w, a) => (unreadable ? null : get(c, a)),
    walletFor: (c) => (c === 'solana' ? SOL_ME : EVM_ME),
    isNative: (c, a) => a === EVM_NATIVE_ADDRESS || (c === 'solana' && a === SOL),
    prepare: async (r) => ({ amountIn: r.amountIn, expectedOut: r.amountIn * 2n, minOut: r.amountIn * 2n - r.amountIn / 50n, networkFee: 1n, simulationOk: true, blockers: [], warnings: [], handle: r }),
    review: async () => reviewAnswer,
    send: async (t: PreparedTrade): Promise<SendResult> => {
      const r = t.handle as { chain: ChainId; from: string; to: string; amountIn: bigint };
      const txId = `tx${++n}`;
      sent.push(`${r.chain}:${r.amountIn}`);
      if (outcome === 'land') {
        set(r.chain, r.from, get(r.chain, r.from) - r.amountIn);
        set(r.chain, r.to, get(r.chain, r.to) + t.expectedOut);
        status.set(txId, 'confirmed');
      } else status.set(txId, outcome === 'fail' ? 'failed' : 'pending');
      return { status: 'sent', txId };
    },
    txStatus: async (_c, id) => status.get(id) ?? null,
    settledAmount: async () => null,
    memory: { get: (key) => memory.get(key) ?? null, set: (key, v) => void memory.set(key, v) },
  };
  return { ports, get, set, status, sent, memory, setUnreadable: (v: boolean) => (unreadable = v), setOutcome: (v: typeof outcome) => (outcome = v), setReview: (v: boolean) => (reviewAnswer = v) };
}

/** A USDC move that lands what it was asked to move when polled (the real deferred move is tested in deferred.test.ts). */
class FakeMove implements LegExecutor {
  started = 0;
  constructor(private readonly w: ReturnType<typeof world>, private readonly land: () => boolean = () => true) {}
  async start(plan: PlanRecord, leg: PlanLeg): Promise<LegProgress> {
    this.started++;
    const q = plan.quote.legs[leg.index]!;
    const src = q.input.chain!;
    const before = plan.legs[leg.index - 1]?.ref.watchBaseline;
    const amount = before === undefined ? plan.quote.spend.amount! : this.w.get(src, q.input.assetKey) - BigInt(before);
    this.w.set(src, q.input.assetKey, this.w.get(src, q.input.assetKey) - amount);
    (this as unknown as { amount: bigint }).amount = amount;
    return { status: 'active', ref: { executionId: 'm1' } };
  }
  async poll(plan: PlanRecord, leg: PlanLeg): Promise<LegProgress> {
    if (!this.land()) return { status: 'active', ref: { executionId: 'm1' } };
    const q = plan.quote.legs[leg.index]!;
    const amount = (this as unknown as { amount: bigint }).amount;
    if (amount !== undefined) this.w.set(q.output.chain!, q.output.assetKey, this.w.get(q.output.chain!, q.output.assetKey) + amount - amount / 1000n);
    (this as unknown as { amount?: bigint }).amount = undefined;
    return { status: 'done', ref: { executionId: 'm1' } };
  }
  async claim(): Promise<void> {}
}

function journey(w: ReturnType<typeof world>, opts: { payWithUsdc?: boolean; land?: () => boolean; store?: JsonVersionedStore<PlanRecord> } = {}) {
  const swap = new SwapLegExecutor(w.ports);
  const move = new FakeMove(w, opts.land);
  const settle = new JourneySettlementExecutor(move as never, { balanceOf: w.ports.balanceOf, walletFor: w.ports.walletFor, usdc });
  const store = opts.store ?? new JsonVersionedStore<PlanRecord>(null, 'j', (v): v is PlanRecord => typeof v === 'object' && v !== null && 'legs' in v);
  const runner = new PlanRunner({ store, executors: { swap, settlement: settle }, now: () => NOW, newId: () => 'j1' });
  const leg = (chain: ChainId, from: string, to: string, i: bigint, o: bigint): ExecutionLeg => ({ id: `s-${chain}`, kind: 'swap', title: `Swap on ${chain}`, input: { chain, assetKey: assetKeyOf(chain, from), symbol: 'IN', decimals: 6, amount: i }, output: { chain, assetKey: assetKeyOf(chain, to), symbol: 'OUT', decimals: 6, amount: o }, fees: [], estimatedSeconds: 10, risk: 'low', signatures: 1, expiresAt: NOW + 60_000, notes: [] });
  const mv = { ...pendingSettlementLeg('m', { chain: 'solana', address: usdc('solana')! }, { chain: 'base', address: usdc('base')! }, 20) };
  const quote = opts.payWithUsdc
    ? journeyQuote('q', { first: null, move: mv, last: leg('base', usdc('base')!, BASE_TOKEN, 0n, 0n) }, 1_000n)
    : journeyQuote('q', { first: leg('solana', SOL, usdc('solana')!, 1_000n, 1_900n), move: mv, last: leg('base', usdc('base')!, BASE_TOKEN, 0n, 0n) }, 1_000n);
  return { swap, settle, move, runner, store, quote };
}

const current = (p: PlanRecord) => p.legs.find((l) => l.status !== 'done')!;

describe('a cross-chain trade, step by step', () => {
  it('runs swap, move, swap; each step waits for the user and finishes only when the balance proves it', async () => {
    const w = world();
    w.set('solana', SOL, 5_000n);
    const { swap, settle, runner, quote, move } = journey(w);
    let p = await runner.step((await runner.create(quote)).id);
    expect(p.state).toBe('WAITING_USER');
    expect(current(p)).toMatchObject({ index: 0, status: 'waiting-user' });
    expect(w.sent).toEqual([]); // nothing is signed until the user presses

    expect(await swap.run(p, current(p))).toBe('sent');
    expect(w.sent).toEqual(['solana:1000']);
    p = await runner.step(p.id);
    expect(p.legs[0]!.status).toBe('done');
    // The move does not start from a background check: it waits for the user's press.
    expect(current(p)).toMatchObject({ index: 1, status: 'waiting-user' });
    expect(move.started).toBe(0);
    expect(p.legs[1]!.ref.destinationBaseline).toBe('0');

    settle.arm(p, current(p));
    p = await runner.step(p.id);
    expect(move.started).toBe(1);
    expect(p.legs[1]!.status).toBe('active'); // in flight: the plan cannot be stopped now
    p = await runner.step(p.id); // the fake move lands on its first poll
    expect(p.legs[1]!.status).toBe('done');
    expect(current(p)).toMatchObject({ index: 2, status: 'waiting-user' });

    expect(await swap.run(p, current(p))).toBe('sent');
    const landed = w.get('base', usdcKey('base'));
    expect(landed).toBe(0n); // all of it went into the swap
    p = await runner.step(p.id);
    expect(p.state).toBe('COMPLETED');
    expect(w.get('base', BASE_TOKEN.toLowerCase())).toBeGreaterThan(0n);
  });

  it('paying with USDC starts with the move, of exactly what was typed', async () => {
    const w = world();
    w.set('solana', usdcKey('solana'), 1_500n);
    const { settle, runner, quote } = journey(w, { payWithUsdc: true });
    let p = await runner.step((await runner.create(quote)).id);
    expect(current(p)).toMatchObject({ index: 0, kind: 'settlement', status: 'waiting-user' });
    settle.arm(p, current(p));
    p = await runner.step(p.id);
    expect(p.legs[0]!.status).toBe('active');
    expect(w.get('solana', usdcKey('solana'))).toBe(500n);
  });

  it('never guesses a balance: an unreadable one makes the step wait', async () => {
    const w = world();
    w.set('solana', SOL, 5_000n);
    w.setUnreadable(true);
    const { runner, quote, swap } = journey(w);
    const p = await runner.step((await runner.create(quote)).id);
    expect(current(p).instruction).toMatch(/could not be read/);
    expect(swap.canRun(p, current(p))).toBe(false);
  });

  it('refuses to swap more than the wallet holds', async () => {
    const w = world();
    w.set('solana', SOL, 10n);
    const { runner, quote, swap } = journey(w);
    const p = await runner.step((await runner.create(quote)).id);
    await expect(swap.run(p, current(p))).rejects.toThrow(/less than the .* planned. Nothing was sent/);
    expect(w.sent).toEqual([]);
  });

  it('a declined review sends nothing and the step can be reviewed again', async () => {
    const w = world();
    w.set('solana', SOL, 5_000n);
    w.setReview(false);
    const { runner, quote, swap } = journey(w);
    const p = await runner.step((await runner.create(quote)).id);
    expect(await swap.run(p, current(p))).toBe('declined');
    expect(w.sent).toEqual([]);
    expect(swap.canRun(p, current(p))).toBe(true);
  });

  it('a swap that may still land is never offered for signing again; a failed one may be tried again', async () => {
    const w = world();
    w.set('solana', SOL, 5_000n);
    w.setOutcome('pending');
    const { runner, quote, swap } = journey(w);
    let p = await runner.step((await runner.create(quote)).id);
    await swap.run(p, current(p));
    expect(swap.canRun(p, current(p))).toBe(false);
    p = await runner.step(p.id);
    expect(current(p).status).toBe('active');
    expect(canStopHere(p)).toBe(false);
    expect(swap.canRun(p, current(p))).toBe(false);
    await expect(swap.run(p, current(p))).rejects.toThrow(/do not sign again/);

    w.status.set('tx1', 'failed');
    p = await runner.step(p.id);
    expect(current(p).status).toBe('waiting-user');
    expect(current(p).instruction).toMatch(/failed .* still in your wallet/);
    expect(swap.canRun(p, current(p))).toBe(true);
    expect(canStopHere(p)).toBe(true);

    w.setOutcome('land');
    await swap.run(p, current(p));
    p = await runner.step(p.id);
    expect(p.legs[0]!.status).toBe('done');
  });

  it('resumes after a reload: the sent swap is recovered from memory and the plan carries on from the store', async () => {
    const w = world();
    w.set('solana', SOL, 5_000n);
    const store = new JsonVersionedStore<PlanRecord>(null, 'j', (v): v is PlanRecord => typeof v === 'object' && v !== null && 'legs' in v);
    const first = journey(w, { store });
    const p = await first.runner.step((await first.runner.create(first.quote)).id);
    await first.swap.run(p, current(p));
    // The page reloads before the plan recorded the swap: new executors, same storage.
    const second = journey(w, { store });
    expect(second.swap.canRun(p, current(p))).toBe(false); // the remembered swap blocks a second signature
    const after = await second.runner.step(p.id);
    expect(after.legs[0]!.status).toBe('done');
    expect(after.legs[0]!.ref.references).toEqual(['tx:tx1']);
    expect(w.sent).toEqual(['solana:1000']);
  });

  it('after the move, the user may stop and keep the USDC, with plain advice; never while the move is in flight', async () => {
    const w = world();
    w.set('solana', SOL, 5_000n);
    let land = false;
    const { swap, settle, runner, quote } = journey(w, { land: () => land });
    let p = await runner.step((await runner.create(quote)).id);
    await swap.run(p, current(p));
    p = await runner.step(p.id);
    settle.arm(p, current(p));
    p = await runner.step(p.id);
    expect(current(p)).toMatchObject({ index: 1, status: 'active' });
    expect(canStopHere(p)).toBe(false);
    await expect(runner.stopHere(p.id)).rejects.toThrow(/in progress/);

    land = true;
    p = await runner.step(p.id);
    expect(current(p)).toMatchObject({ index: 2, status: 'waiting-user' });
    p = await runner.stopHere(p.id);
    expect(p.state).toBe('FAILED');
    expect(p.failure).toMatchObject({ fundsMayBeAtRisk: false });
    expect(whereAreTheFunds(p)).toMatchObject({ asset: 'USDC', chain: 'base' });
    const advice = diagnosePlan(p, NOW);
    expect(advice[0]!.fundsAt).toMatch(/USDC at base/);
    expect(advice[0]!.actions.map((a) => a.id)).toContain('keep-funds');
  });

  it('a plan that has not begun is simply cancelled', async () => {
    const w = world();
    const { runner, quote } = journey(w);
    const created = await runner.create(quote);
    expect((await runner.stopHere(created.id)).state).toBe('CANCELLED');
  });
});

describe('the real deferred move inside a journey', () => {
  it('starting with USDC moves at most what was typed, to the user\'s own account on the other network', async () => {
    const provider = new MockSettlementProvider({ id: 'mock', now: () => NOW });
    const quotes = new Map<string, SettlementQuote>();
    const intents: { sender: string; recipient: string; amount: bigint }[] = [];
    const gateway = { send: async () => '0x' + '7'.repeat(64), confirmation: async () => 'confirmed' as const };
    const orchestrator = new CrossChainOrchestrator({ store: new InMemoryExecutionStore(), providers: [provider], gateway, now: () => NOW, sleep: async () => undefined, confirmTimeoutMs: 0 });
    const engine = new SettlementQuoteEngine([provider], { now: () => NOW });
    const spy = { quote: async (...a: Parameters<SettlementQuoteEngine['quote']>) => (intents.push({ sender: a[0].sender, recipient: a[0].recipient, amount: a[0].sourceAmount }), engine.quote(...a)) };
    const bal = new Map<string, bigint>([[`ethereum:${usdc('ethereum')}`, 2_000_000n], [`solana:${usdc('solana')}`, 0n]]);
    const deferred = new DeferredSettlementExecutor({
      inner: new SettlementLegExecutor({ orchestrator, quoteFor: (id) => quotes.get(id) ?? null, now: () => NOW }), quotes, engine: spy,
      balanceOf: async (c, _w, a) => bal.get(`${c}:${a}`) ?? null, walletFor: (c) => (c === 'solana' ? SOL_ME : EVM_ME), usdc,
      assess: async () => ({ verdict: 'ok', blockers: [], confirmations: [], notes: [] }) as never, acknowledge: async () => false,
    });
    const settle = new JourneySettlementExecutor(deferred, { balanceOf: async (c, _w, a) => bal.get(`${c}:${a}`) ?? null, walletFor: (c) => (c === 'solana' ? SOL_ME : EVM_ME), usdc });
    const mv = pendingSettlementLeg('m', { chain: 'ethereum', address: usdc('ethereum')! }, { chain: 'solana', address: usdc('solana')! }, 20);
    const quote = journeyQuote('q', { first: null, move: mv, last: null }, 1_000_000n);
    const store = new JsonVersionedStore<PlanRecord>(null, 'd', (v): v is PlanRecord => typeof v === 'object' && v !== null && 'legs' in v);
    const runner = new PlanRunner({ store, executors: { settlement: settle }, now: () => NOW, newId: () => 'd1' });
    let p = await runner.step((await runner.create(quote)).id);
    settle.arm(p, current(p));
    p = await runner.step(p.id);
    expect(intents[0]).toMatchObject({ sender: EVM_ME, recipient: SOL_ME });
    expect(intents.every((i) => i.amount <= 1_000_000n)).toBe(true);
    expect(p.legs[0]!.ref.executionId).toBeTruthy();
    expect(p.legs[0]!.ref.destinationBaseline).toBe('0');
  });
});
