import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import { PlanRunner, type LegExecutor, type LegProgress } from './runner.js';
import { JsonVersionedStore } from './store.js';
import { canPlanMove, movePlan, newPlan, PLAN_FINAL, PLAN_STATES, whereAreTheFunds, type PlanRecord } from './state.js';
import { combineLegs, type ExecutionLeg } from './executionQuote.js';
import { BalanceLegExecutor } from './executors.js';
import { diagnoseExecution, diagnosePlan, triage } from './recovery.js';
import type { ExecutionRecord } from '../orchestrator/states.js';
import { MockSettlementProvider } from '../settlement/testing.js';

const NOW = 1_000_000;
const A = '0x' + 'a'.repeat(40);
const leg = (index: number, kind: ExecutionLeg['kind'], from: string, to: string, over: Partial<ExecutionLeg> = {}): ExecutionLeg => ({
  id: `l${index}`, kind, title: `${kind} ${index}`,
  input: { chain: 'base', assetKey: from, symbol: from.toUpperCase(), decimals: 6, amount: 100n },
  output: { chain: 'base', assetKey: to, symbol: to.toUpperCase(), decimals: 6, amount: 100n },
  fees: [], estimatedSeconds: 60, risk: 'low', signatures: 1, expiresAt: NOW + 60_000, notes: [], ...over,
});
const quote = () => combineLegs('q', [leg(0, 'ramp-buy', 'fiat', 'usdc'), leg(1, 'settlement', 'usdc', 'usdc2'), leg(2, 'swap', 'usdc2', 'act')]);

class Script implements LegExecutor {
  starts = 0;
  polls = 0;
  constructor(private readonly onStart: () => LegProgress | Error, private readonly onPoll: () => LegProgress | Error = () => ({ status: 'done' })) {}
  async start(): Promise<LegProgress> {
    this.starts++;
    const r = this.onStart();
    if (r instanceof Error) throw r;
    return r;
  }
  async poll(): Promise<LegProgress> {
    this.polls++;
    const r = this.onPoll();
    if (r instanceof Error) throw r;
    return r;
  }
}
const make = (ex: Record<string, LegExecutor>, now = () => NOW) => {
  const store = new JsonVersionedStore<PlanRecord>(null, 'k', (v): v is PlanRecord => typeof v === 'object' && v !== null && 'legs' in v);
  let n = 0;
  return { store, runner: new PlanRunner({ store, executors: ex, now, newId: () => `p${++n}` }) };
};

describe('plan state machine', () => {
  it('has no way out of a final state, and no way to cancel or expire once a step has begun', () => {
    for (const f of PLAN_FINAL) for (const to of PLAN_STATES) expect(canPlanMove(f, to)).toBe(false);
    const p = newPlan('p', quote(), NOW);
    const begun: PlanRecord = { ...p, legs: p.legs.map((l, i) => (i === 0 ? { ...l, status: 'active' as const } : l)) };
    expect(() => movePlan(begun, 'CANCELLED', 'x', NOW)).toThrow(/after a step has begun/);
    expect(() => movePlan({ ...p, state: 'RUNNING' }, 'COMPLETED', 'x', NOW)).toThrow(/every step is done/);
  });

  it('property: a random walk of allowed moves never leaves a final state', () => {
    fc.assert(fc.property(fc.array(fc.constantFrom(...PLAN_STATES), { maxLength: 30 }), (moves) => {
      let s: (typeof PLAN_STATES)[number] = 'PLANNED';
      let finalSeen = false;
      for (const m of moves) if (canPlanMove(s, m)) { if (finalSeen) return false; s = m; finalSeen = PLAN_FINAL.includes(s); }
      return true;
    }));
  });

  it('says where the funds are: at the start, or the output of the last finished step', () => {
    const p = newPlan('p', quote(), NOW);
    expect(whereAreTheFunds(p).description).toMatch(/where you started/);
    const two: PlanRecord = { ...p, legs: p.legs.map((l, i) => (i < 2 ? { ...l, status: 'done' as const } : l)) };
    expect(whereAreTheFunds(two)).toMatchObject({ asset: 'USDC2', chain: 'base' });
  });
});

describe('plan runner', () => {
  const done = () => new Script(() => ({ status: 'done' }));

  it('runs every leg in order and completes only when all are done', async () => {
    const order: string[] = [];
    const ex = (name: string): LegExecutor => ({ start: async () => (order.push(name), { status: 'done' }), poll: async () => ({ status: 'done' }) });
    const { runner } = make({ 'ramp-buy': ex('ramp'), settlement: ex('settle'), swap: ex('swap') });
    const p = await runner.step((await runner.create(quote())).id);
    expect(order).toEqual(['ramp', 'settle', 'swap']);
    expect(p.state).toBe('COMPLETED');
    expect(p.legs.every((l) => l.status === 'done')).toBe(true);
  });

  it('stops at a leg that needs the user, starts it once, and resumes by polling', async () => {
    const ramp = new Script(() => ({ status: 'waiting-user', instruction: 'Pay on the provider page.' }), () => ({ status: 'done' }));
    const settle = done();
    const { runner } = make({ 'ramp-buy': ramp, settlement: settle, swap: done() });
    const id = (await runner.create(quote())).id;
    const w = await runner.step(id);
    expect(w.state).toBe('WAITING_USER');
    expect(w.legs[0]!.instruction).toBe('Pay on the provider page.');
    expect(settle.starts).toBe(0); // the next leg did not begin on funds that have not arrived
    const end = await runner.step(id);
    expect(ramp.starts).toBe(1);
    expect(ramp.polls).toBe(1);
    expect(end.state).toBe('COMPLETED');
  });

  it('a failed leg fails the plan, remembers the risk and where it stopped, and runs nothing after it', async () => {
    const settle = new Script(() => ({ status: 'failed', reason: 'Settlement failed.', fundsMayBeAtRisk: true }));
    const swap = done();
    const { runner } = make({ 'ramp-buy': done(), settlement: settle, swap });
    const p = await runner.step((await runner.create(quote())).id);
    expect(p.state).toBe('FAILED');
    expect(p.failure).toEqual({ reason: 'Settlement failed.', fundsMayBeAtRisk: true, legIndex: 1 });
    expect(p.legs.map((l) => l.status)).toEqual(['done', 'failed', 'pending']);
    expect(swap.starts).toBe(0);
  });

  it('an executor that throws changes nothing, the plan waits, and the next call asks again', async () => {
    let first = true;
    const ramp = new Script(() => (first ? ((first = false), new Error('network down')) : { status: 'done' }));
    const { runner } = make({ 'ramp-buy': ramp, settlement: done(), swap: done() });
    const id = (await runner.create(quote())).id;
    const w = await runner.step(id);
    expect(w.state).toBe('WAITING_USER');
    expect(w.legs[0]!.status).toBe('pending');
    expect((await runner.step(id)).state).toBe('COMPLETED');
  });

  it('a leg that needs a new quote makes the plan wait, with the reason', async () => {
    const { runner } = make({ 'ramp-buy': new Script(() => ({ status: 'needs-requote', instruction: 'Quote expired.' })), settlement: done(), swap: done() });
    const p = await runner.step((await runner.create(quote())).id);
    expect(p.state).toBe('WAITING_USER');
    expect(p.legs[0]!.status).toBe('needs-requote');
  });

  it('refuses a plan with a step it cannot carry out, an expired quote, and a plan that expired unstarted', async () => {
    const { runner } = make({ 'ramp-buy': done() });
    await expect(runner.create(quote())).rejects.toThrow(/cannot carry out/);
    let t = NOW;
    const m = make({ 'ramp-buy': done(), settlement: done(), swap: done() }, () => t);
    const id = (await m.runner.create(quote())).id;
    t = NOW + 120_000;
    expect((await m.runner.step(id)).state).toBe('EXPIRED');
    await expect(m.runner.create(quote())).rejects.toThrow(/expired/);
  });

  it('a finished plan is left alone, and two simultaneous steps are refused', async () => {
    const { runner } = make({ 'ramp-buy': done(), settlement: done(), swap: done() });
    const id = (await runner.create(quote())).id;
    const a = runner.step(id);
    await expect(runner.step(id)).rejects.toThrow(/already being worked on/);
    expect((await a).state).toBe('COMPLETED');
    expect((await runner.step(id)).state).toBe('COMPLETED');
  });
});

describe('balance executor', () => {
  const o = (balances: (bigint | null)[]) => {
    let i = 0;
    return new BalanceLegExecutor({ balanceOf: async () => balances[Math.min(i++, balances.length - 1)] ?? null, walletFor: () => A, instruction: () => 'Do it.' });
  };
  const plan = (kind: 'ramp-buy' | 'ramp-sell' | 'swap') => newPlan('p', combineLegs('q', [leg(0, kind, 'a', 'b', { output: { chain: 'base', assetKey: 'b', symbol: 'B', decimals: 6, amount: 50n } })]), NOW);

  it('a buy finishes only when the balance rose, and an unreadable balance is never read as zero', async () => {
    const p = plan('ramp-buy');
    const e = o([100n, 100n, null, 160n]);
    const started = await e.start(p, p.legs[0]!);
    const l = { ...p.legs[0]!, ref: started.status === 'waiting-user' ? started.ref! : {} };
    expect((await e.poll(p, l)).status).toBe('waiting-user');
    expect((await e.poll(p, l)).status).toBe('waiting-user'); // null
    expect((await e.poll(p, l)).status).toBe('done');
  });

  it('a swap needs the output to rise by at least the stated minimum', async () => {
    const p = plan('swap');
    const e = o([10n, 40n, 70n]);
    const s = await e.start(p, p.legs[0]!);
    const l = { ...p.legs[0]!, ref: (s as { ref: { watchBaseline: string } }).ref };
    expect((await e.poll(p, l)).status).toBe('waiting-user'); // +30, minimum 50
    expect((await e.poll(p, l)).status).toBe('done'); // +60
  });

  it('a sale is done when the crypto left, and says the payout is not confirmed', async () => {
    const p = plan('ramp-sell');
    const e = o([100n, 20n]);
    const s = await e.start(p, p.legs[0]!);
    const l = { ...p.legs[0]!, ref: (s as { ref: { watchBaseline: string } }).ref };
    expect(await e.poll(p, l)).toEqual({ status: 'done', ref: { references: ['payout-not-confirmed'] } });
  });

  it('does not begin when the starting balance cannot be read', async () => {
    const p = plan('ramp-buy');
    expect((await o([null]).start(p, p.legs[0]!)).status).toBe('waiting-user');
  });
});

describe('recovery', () => {
  const exec = async (state: ExecutionRecord['state'], over: Partial<ExecutionRecord> = {}): Promise<ExecutionRecord> => ({
    id: 'e1', version: 1, state, createdAt: 0, updatedAt: 0, steps: {}, executionId: null, destinationTxHash: null, refundTxHash: null, failure: null, needsAttention: null, history: [],
    quote: await new MockSettlementProvider({ now: () => 0 }).getQuote({ sourceChain: 'ethereum', sourceAsset: { chain: 'ethereum', address: '0x1' }, sourceAmount: 5n, destinationChain: 'base', destinationAsset: { chain: 'base', address: '0x2' }, sender: A, recipient: A }), ...over,
  });
  const MIN = 60_000;

  it('puts "check your wallet" first for an undetermined send, and never suggests sending again', async () => {
    const [i] = diagnoseExecution(await exec('AWAITING_SIGNATURE', { needsAttention: 'Unsure.' }), 5 * MIN);
    expect(i).toMatchObject({ severity: 'urgent' });
    expect(i!.neverDo.join(' ')).toMatch(/Do not send the transaction again/);
    expect(i!.actions.map((a) => a.id)).toEqual(['check-wallet']);
  });

  it('says funds may be in transit after a failed settlement, never "lost", and tells them not to restart', async () => {
    const [i] = diagnoseExecution(await exec('FAILED', { failure: { reason: 'Provider failed.', fundsMayBeAtRisk: true } }), 0);
    expect(i!.severity).toBe('urgent');
    expect(i!.fundsAt).toMatch(/Possibly in transit/);
    expect(JSON.stringify(i)).not.toMatch(/lost/i);
    expect(i!.neverDo.join(' ')).toMatch(/Do not start the same move again/);
  });

  it('a failure before funds moved says the funds are still where they were', async () => {
    const [i] = diagnoseExecution(await exec('FAILED', { failure: { reason: 'Declined.', fundsMayBeAtRisk: false } }), 0);
    expect(i).toMatchObject({ severity: 'info', fundsAt: expect.stringMatching(/Still in your account on Ethereum/) });
  });

  it('flags an unclaimed release, a slow settlement and a stuck submission by how long they have waited', async () => {
    expect(diagnoseExecution(await exec('SETTLEMENT_PENDING'), 40 * MIN, true)[0]!.actions[0]!.id).toBe('claim');
    expect(diagnoseExecution(await exec('SETTLEMENT_PENDING'), 5 * MIN, true)).toEqual([]);
    expect(diagnoseExecution(await exec('SETTLEMENT_PENDING'), 3 * 60 * MIN)[0]!.problem).toMatch(/much longer than expected/);
    expect(diagnoseExecution(await exec('SOURCE_SUBMITTED'), 20 * MIN)[0]!.neverDo[0]).toMatch(/Do not send/);
    expect(diagnoseExecution(await exec('COMPLETED'), 10 ** 9)).toEqual([]);
  });

  const failedPlan = (risk: boolean): PlanRecord => ({ ...newPlan('p', quote(), NOW), state: 'FAILED', legs: newPlan('p', quote(), NOW).legs.map((l, i) => ({ ...l, status: i === 0 ? ('done' as const) : i === 1 ? ('failed' as const) : ('pending' as const) })), failure: { reason: 'Bridge down.', fundsMayBeAtRisk: risk, legIndex: 1 } });

  it('for a failed plan, says where the funds are and offers to keep them or plan the rest again; with risk it only says to check', () => {
    const calm = diagnosePlan(failedPlan(false), NOW)[0]!;
    expect(calm.fundsAt).toMatch(/USDC at base, from step 1/);
    expect(calm.actions.map((a) => a.id)).toEqual(['keep-funds', 'retry-step']);
    const risky = diagnosePlan(failedPlan(true), NOW)[0]!;
    expect(risky).toMatchObject({ severity: 'urgent' });
    expect(risky.actions.map((a) => a.id)).toEqual(['check-provider']);
    expect(risky.neverDo.join(' ')).toMatch(/from the beginning/);
  });

  it('notices when a plan and the move behind it disagree, and when a ramp has been open for a day', async () => {
    const base = newPlan('p', quote(), NOW);
    const disagree: PlanRecord = { ...base, state: 'RUNNING', legs: base.legs.map((l, i) => (i === 1 ? { ...l, status: 'done' as const, ref: { executionId: 'e1' } } : l)) };
    expect(diagnosePlan(disagree, NOW, new Map([['e1', await exec('FAILED')]]))[0]).toMatchObject({ severity: 'urgent', problem: expect.stringMatching(/records|says step 2 is done/) });
    const ramp: PlanRecord = { ...base, state: 'WAITING_USER', legs: base.legs.map((l, i) => (i === 0 ? { ...l, status: 'waiting-user' as const, startedAt: 0 } : l)) };
    expect(diagnosePlan(ramp, 25 * 60 * MIN)[0]!.neverDo.join(' ')).toMatch(/Do not pay again/);
  });

  it('triage puts the urgent items first', async () => {
    const items = [...diagnosePlan(failedPlan(false), NOW), ...diagnoseExecution(await exec('FAILED', { failure: { reason: 'x', fundsMayBeAtRisk: true } }), 0)];
    expect(triage(items)[0]!.severity).toBe('urgent');
  });
});
