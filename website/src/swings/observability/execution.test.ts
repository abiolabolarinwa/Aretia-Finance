import { describe, expect, it } from 'vitest';
import { redact, Telemetry, type TelemetrySink } from './telemetry.js';
import { ObservedPlanStore, observedExecutionStore, observeRampSearch, observeSettlementSearch } from './execution.js';
import { CrossChainOrchestrator, type ExecutionGateway } from '../orchestrator/orchestrator.js';
import { InMemoryExecutionStore } from '../orchestrator/store.js';
import { MockSettlementProvider } from '../settlement/testing.js';
import { JsonVersionedStore } from '../plan/store.js';
import { PlanRunner } from '../plan/runner.js';
import { combineLegs } from '../plan/executionQuote.js';
import type { PlanRecord } from '../plan/state.js';

const NOW = 1_000_000;
const SENDER = '0x' + 'a'.repeat(40);
const intent = { sourceChain: 'ethereum' as const, sourceAsset: { chain: 'ethereum' as const, address: '0x1' }, sourceAmount: 5_000_000n, destinationChain: 'base' as const, destinationAsset: { chain: 'base' as const, address: '0x2' }, sender: SENDER, recipient: SENDER };

const capture = (): { t: Telemetry; lines: string[] } => {
  const lines: string[] = [];
  const sink: TelemetrySink = { write: (e) => lines.push(JSON.stringify(e)) };
  return { t: new Telemetry([sink], () => NOW), lines };
};

describe('redaction of the new kinds of secret', () => {
  it('removes the query string of a checkout link (it carries a provider key and a signature)', () => {
    const out = redact({ note: 'opened https://buy.moonpay.com/?apiKey=pk_live_abc&signature=Zm9v&walletAddress=0xabc done' }) as { note: string };
    expect(out.note).toBe('opened https://buy.moonpay.com/ done');
    expect(JSON.stringify(out)).not.toMatch(/pk_live|signature|walletAddress/);
  });

  it('removes bearer tokens, and payment and identity fields by name', () => {
    expect(JSON.stringify(redact({ h: 'Authorization failed for Bearer abc.def-123' }))).not.toMatch(/abc\.def/);
    const out = redact({ cardNumber: '4242424242424242', cvv: '123', iban: 'GB00', accountNumber: '1', passport: 'X', sessionId: 's', cookie: 'c', otp: '1', ok: 'visible' }) as Record<string, string>;
    expect(Object.entries(out).filter(([k]) => k !== 'ok').every(([, v]) => v === '[redacted]')).toBe(true);
    expect(out.ok).toBe('visible');
  });

  it('still masks long opaque blobs and keeps bigints readable', () => {
    expect(redact('a'.repeat(120))).toBe('[redacted blob]');
    expect(redact({ n: 5n })).toEqual({ n: '5' });
  });
});

describe('observing executions', () => {
  const gateway: ExecutionGateway = { send: async () => '0x' + '1'.repeat(64), confirmation: async () => 'confirmed' };

  it('records each state change once, with ids and states only: no address, hash, amount or link', async () => {
    const { t, lines } = capture();
    const store = observedExecutionStore(new InMemoryExecutionStore(), t);
    const provider = new MockSettlementProvider({ now: () => NOW });
    const orch = new CrossChainOrchestrator({ store, providers: [provider], gateway, now: () => NOW, newId: () => 'x1', sleep: async () => undefined, confirmTimeoutMs: 0 });
    // The mock provider's declared address is not an EVM address of the sender's, so signing is by the fake gateway.
    const rec = await orch.create(await provider.getQuote(intent));
    await orch.start(rec.id);
    const states = t.recent().filter((e) => e.event.name === 'execution_state').map((e) => `${e.event.from}>${e.event.to}`);
    expect(states).toEqual(['CREATED>QUOTED', 'QUOTED>AWAITING_SIGNATURE', 'AWAITING_SIGNATURE>SOURCE_SUBMITTED', 'SOURCE_SUBMITTED>SOURCE_CONFIRMED', 'SOURCE_CONFIRMED>SETTLEMENT_PENDING']);
    const all = lines.join('\n');
    expect(all).not.toContain(SENDER);
    expect(all).not.toMatch(/0x1{64}/);
    expect(all).not.toMatch(/5000000/);
  });

  it('records a failure with its reason and whether funds may be at risk', async () => {
    const { t } = capture();
    const store = observedExecutionStore(new InMemoryExecutionStore(), t);
    const provider = new MockSettlementProvider({ now: () => NOW, status: () => 'failed' });
    const orch = new CrossChainOrchestrator({ store, providers: [provider], gateway, now: () => NOW, newId: () => 'x1', sleep: async () => undefined, confirmTimeoutMs: 0 });
    const rec = await orch.create(await provider.getQuote(intent));
    await orch.start(rec.id);
    await orch.advance(rec.id);
    const failed = t.recent().find((e) => e.event.name === 'execution_failed');
    expect(failed?.event).toMatchObject({ kind: 'settlement', id: 'x1', fundsMayBeAtRisk: true });
    expect(t.count('execution_failed')).toBe(1);
  });

  it('a broken sink never breaks an execution', async () => {
    const t = new Telemetry([{ write: () => { throw new Error('sink down'); } }], () => NOW);
    const store = observedExecutionStore(new InMemoryExecutionStore(), t);
    const provider = new MockSettlementProvider({ now: () => NOW });
    const orch = new CrossChainOrchestrator({ store, providers: [provider], gateway, now: () => NOW, newId: () => 'x1', sleep: async () => undefined, confirmTimeoutMs: 0 });
    const rec = await orch.create(await provider.getQuote(intent));
    expect((await orch.start(rec.id)).state).toBe('SETTLEMENT_PENDING');
  });
});

describe('observing plans, searches and recovery', () => {
  it('records plan state changes through the store wrapper', async () => {
    const { t } = capture();
    const inner = new JsonVersionedStore<PlanRecord>(null, 'k', (v): v is PlanRecord => typeof v === 'object' && v !== null && 'legs' in v);
    const store = new ObservedPlanStore(inner, t);
    const leg = { id: 'l', kind: 'swap' as const, title: 't', input: { chain: 'base' as const, assetKey: 'a', symbol: 'A', decimals: 6, amount: 1n }, output: { chain: 'base' as const, assetKey: 'b', symbol: 'B', decimals: 6, amount: 1n }, fees: [], estimatedSeconds: 1, risk: 'low' as const, signatures: 1, expiresAt: NOW + 1000, notes: [] };
    const runner = new PlanRunner({ store, executors: { swap: { start: async () => ({ status: 'done' }), poll: async () => ({ status: 'done' }) } }, now: () => NOW, newId: () => 'p1' });
    const p = await runner.create(combineLegs('q', [leg]));
    await runner.step(p.id);
    expect(t.recent().filter((e) => e.event.name === 'execution_state').map((e) => `${e.event.from}>${e.event.to}`)).toEqual(['PLANNED>RUNNING', 'RUNNING>COMPLETED']);
  });

  it('records search outcomes without links or addresses, and keeps the reasons providers gave', () => {
    const { t, lines } = capture();
    observeSettlementSearch(t, 'ethereum', { quotes: [], declined: [{ providerId: 'x', reason: 'no' }], failures: [] }, 12);
    observeRampSearch(t, 'base', 'buy', { quotes: [], declined: [{ providerId: 'moonpay', reason: 'Not in your country.' }], failures: [{ providerId: 'm2', message: 'see https://x.example/pay?apiKey=secret' }] });
    expect(t.count('ramp_options')).toBe(2);
    expect(t.count('settlement_quote')).toBe(1);
    expect(lines.join('\n')).not.toMatch(/apiKey|secret/);
  });
});
