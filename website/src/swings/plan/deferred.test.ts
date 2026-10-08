import { describe, expect, it } from 'vitest';
import { DeferredSettlementExecutor } from './deferred.js';
import { BalanceLegExecutor, SettlementLegExecutor } from './executors.js';
import { combineLegs, legFromRamp, pendingSettlementLeg } from './executionQuote.js';
import { PlanRunner } from './runner.js';
import { JsonVersionedStore } from './store.js';
import type { PlanRecord } from './state.js';
import { CrossChainOrchestrator } from '../orchestrator/orchestrator.js';
import { InMemoryExecutionStore } from '../orchestrator/store.js';
import { SettlementQuoteEngine } from '../settlement/engine.js';
import { assessSettlement } from '../settlement/safety.js';
import { MockSettlementProvider } from '../settlement/testing.js';
import { MoonPayRampProvider } from '../ramp/moonpay.js';
import type { SettlementQuote } from '../settlement/types.js';

const NOW = 1_000_000;
const ME = '0x' + 'a'.repeat(40);
const USDC_ETH = '0x' + '1'.repeat(40);
const USDC_BASE = '0x' + '2'.repeat(40);

async function build(over: { mockOpts?: ConstructorParameters<typeof MockSettlementProvider>[0]; native?: bigint; accept?: boolean; maxAmount?: bigint } = {}) {
  const provider = new MockSettlementProvider({ id: 'mock', now: () => NOW, ...over.mockOpts });
  const quotes = new Map<string, SettlementQuote>();
  const sent: string[] = [];
  const gateway = { send: async (tx: { stepId: string }) => (sent.push(tx.stepId), '0x' + '7'.repeat(64)), confirmation: async () => 'confirmed' as const };
  const orchestrator = new CrossChainOrchestrator({ store: new InMemoryExecutionStore(), providers: [provider], gateway, now: () => NOW, sleep: async () => undefined, confirmTimeoutMs: 0 });
  const balances = new Map<string, bigint>([[`ethereum:${USDC_ETH}`, 0n]]);
  const inner = new SettlementLegExecutor({ orchestrator, quoteFor: (id) => quotes.get(id) ?? null, now: () => NOW });
  const acknowledged: string[][] = [];
  const deferred = new DeferredSettlementExecutor({
    inner, quotes, engine: new SettlementQuoteEngine([provider], { now: () => NOW }),
    balanceOf: async (c, _w, a) => balances.get(`${c}:${a}`) ?? null, walletFor: () => ME, usdc: (c) => (c === 'ethereum' ? USDC_ETH : c === 'base' ? USDC_BASE : null),
    assess: async (q) => assessSettlement(q, { now: NOW, provider, enabledChains: ['ethereum', 'base'], sourceBalance: balances.get(`ethereum:${USDC_ETH}`) ?? null, destinationNativeBalance: over.native ?? 10n ** 16n, existing: [], maxAmount: over.maxAmount ?? 250_000_000n }),
    acknowledge: async (c) => (acknowledged.push(c), over.accept ?? false),
  });
  const rampApi = async (b: Record<string, unknown>): Promise<unknown> => (b.action === 'status' ? { enabled: true, providers: [{ id: 'moonpay', name: 'MoonPay', sides: ['buy'] }] } : { countries: [{ code: 'US', name: 'US', buy: true, sell: true }], fiats: ['usd'], tokens: [{ chain: 'ethereum', symbol: 'USDC', contract: USDC_ETH, sell: true }] });
  const rampQuote = await new MoonPayRampProvider({ api: rampApi, now: () => NOW }).getQuote({ side: 'buy', fiat: 'usd', fiatAmount: 100, asset: { chain: 'ethereum', symbol: 'USDC', address: USDC_ETH, decimals: 6 }, wallet: ME, country: 'US' });
  const quote = combineLegs('q', [legFromRamp(rampQuote), pendingSettlementLeg('pending', { chain: 'ethereum', address: USDC_ETH }, { chain: 'base', address: USDC_BASE }, 1200)]);
  const balance = new BalanceLegExecutor({ balanceOf: async (c, _w, a) => balances.get(`${c}:${a}`) ?? null, walletFor: () => ME, instruction: () => 'Pay on the provider page.' });
  const store = new JsonVersionedStore<PlanRecord>(null, 'p', (v): v is PlanRecord => typeof v === 'object' && v !== null && 'legs' in v);
  const runner = new PlanRunner({ store, executors: { 'ramp-buy': balance, settlement: deferred }, now: () => NOW, newId: () => 'plan1' });
  return { runner, balances, sent, acknowledged, deferred, quote, store };
}

describe('a settlement priced when its turn comes', () => {
  it('the plan quote says the final amount is unknown, because the step cannot be priced yet', async () => {
    const { quote } = await build();
    expect(quote.receive.amount).toBeNull();
    expect(quote.warnings.join(' ')).toMatch(/no price yet/);
    expect(quote.legs[1]!.fees.every((f) => f.amount === null)).toBe(true);
  });

  it('waits for the money, then quotes from the amount that really arrived, and moves exactly that', async () => {
    const { runner, balances, sent, quote, store } = await build();
    const id = (await runner.create(quote)).id;
    expect((await runner.step(id)).legs[0]!.status).toBe('waiting-user');
    balances.set(`ethereum:${USDC_ETH}`, 90_000_000n); // 90 USDC arrived
    const p = await runner.step(id);
    expect(p.legs[0]!.status).toBe('done');
    expect(sent).toEqual(['send']);
    const exec = p.legs[1]!.ref.executionId!;
    expect(exec).toBeTruthy();
    const record = (await store.get(id))!;
    expect(record.legs[1]!.status).toBe('active');
  });

  it('does not start when nothing arrived, and tries again on the next step', async () => {
    const { runner, sent, quote } = await build();
    const id = (await runner.create(quote)).id;
    await runner.step(id);
    const p = await runner.step(id);
    expect(p.legs[0]!.status).toBe('waiting-user');
    expect(sent).toEqual([]);
  });

  it('keeps the funds where they are and says why when no route exists, a blocker applies, or the amount is over the cap', async () => {
    const none = await build({ mockOpts: { pairs: ['solana>base'] } });
    const id1 = (await none.runner.create(none.quote)).id;
    await none.runner.step(id1);
    none.balances.set(`ethereum:${USDC_ETH}`, 90_000_000n);
    const p1 = await none.runner.step(id1);
    expect(p1.state).toBe('WAITING_USER');
    expect(p1.legs[0]!.status).toBe('done');
    expect(p1.legs[1]!.instruction).toMatch(/no route to Base is available.*safe in your wallet/);
    expect(none.sent).toEqual([]);

    const big = await build({ maxAmount: 10_000_000n });
    const id2 = (await big.runner.create(big.quote)).id;
    await big.runner.step(id2);
    big.balances.set(`ethereum:${USDC_ETH}`, 90_000_000n);
    const p2 = await big.runner.step(id2);
    expect(p2.legs[1]!.instruction).toMatch(/not started.*above the limit/);
    expect(big.sent).toEqual([]);
  });

  it('asks the user to accept a flagged risk and does nothing until they do', async () => {
    const declined = await build({ native: 0n, accept: false });
    const id = (await declined.runner.create(declined.quote)).id;
    await declined.runner.step(id);
    declined.balances.set(`ethereum:${USDC_ETH}`, 90_000_000n);
    const p = await declined.runner.step(id);
    expect(declined.acknowledged[0]!.join(' ')).toMatch(/no .* on Base/);
    expect(p.legs[1]!.instruction).toMatch(/Waiting for you to accept/);
    expect(declined.sent).toEqual([]);

    const accepted = await build({ native: 0n, accept: true });
    const id2 = (await accepted.runner.create(accepted.quote)).id;
    await accepted.runner.step(id2);
    accepted.balances.set(`ethereum:${USDC_ETH}`, 90_000_000n);
    await accepted.runner.step(id2);
    expect(accepted.sent).toEqual(['send']);
  });

  it('does not guess the amount when the previous step left no starting balance', async () => {
    const { deferred, quote } = await build();
    const plan = { id: 'p', version: 1, state: 'RUNNING', quote, legs: [{ index: 0, kind: 'ramp-buy', status: 'done', ref: {}, instruction: null, startedAt: 0, doneAt: 0 }, { index: 1, kind: 'settlement', status: 'pending', ref: {}, instruction: null, startedAt: null, doneAt: null }], createdAt: 0, updatedAt: 0, failure: null, history: [] } as PlanRecord;
    const r = await deferred.start(plan, plan.legs[1]!);
    expect(r).toMatchObject({ status: 'waiting-user' });
    expect((r as { instruction: string }).instruction).toMatch(/will not guess/);
  });
});
