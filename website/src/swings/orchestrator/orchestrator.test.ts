import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import { CrossChainOrchestrator, type ExecutionGateway } from './orchestrator.js';
import { InMemoryExecutionStore, StorageExecutionStore } from './store.js';
import { applyTransition, canTransition, EXECUTION_STATES, FINAL_STATES, parseRecord, serializeRecord, type ExecutionRecord } from './states.js';
import { MockSettlementProvider } from '../settlement/testing.js';
import { SwingsError } from '../core/types.js';
import type { SettlementIntent, SettlementProvider, SettlementStatus, SettlementTransaction } from '../settlement/types.js';

const NOW = 1_000_000;
const USDC_ETH = { chain: 'ethereum' as const, address: '0x' + '1'.repeat(40) };
const USDC_BASE = { chain: 'base' as const, address: '0x' + '2'.repeat(40) };
const SENDER = '0x' + 'a'.repeat(40);
const RECIPIENT = '0x' + 'b'.repeat(40);
const intent: SettlementIntent = { sourceChain: 'ethereum', sourceAsset: USDC_ETH, sourceAmount: 5_000_000_000n, destinationChain: 'base', destinationAsset: USDC_BASE, sender: SENDER, recipient: RECIPIENT };
const hash = (c: string): string => '0x' + c.repeat(64);

/** A provider that builds an approval and a burn, and whose status the test controls. */
class TwoStepProvider extends MockSettlementProvider {
  code: SettlementStatus['code'] = 'awaiting-source';
  claimable = true;
  override async buildSettlement(quote: Parameters<MockSettlementProvider['buildSettlement']>[0]): Promise<SettlementTransaction[]> {
    const mk = (stepId: string): SettlementTransaction => ({ stepId, chain: 'ethereum', description: stepId, unsigned: { kind: 'evm', chainId: 1, tx: { from: SENDER, to: '0x' + '0'.repeat(40) } } });
    void quote;
    return [mk('approve'), mk('burn')];
  }
  override async trackSettlement(executionId: string): Promise<SettlementStatus> {
    return { executionId, code: this.code, destinationTxHash: null, message: 'm', updatedAt: NOW };
  }
  override async buildDestination(): Promise<SettlementTransaction | null> {
    return this.claimable ? { stepId: 'mint', chain: 'base', description: 'mint', unsigned: { kind: 'evm', chainId: 8453, tx: { from: RECIPIENT, to: '0x' + '0'.repeat(40) } } } : null;
  }
}

class FakeGateway implements ExecutionGateway {
  sent: { stepId: string; address: string }[] = [];
  results = new Map<string, 'confirmed' | 'failed' | 'pending'>();
  failNext: Error | null = null;
  n = 0;
  async send(tx: SettlementTransaction, expect: { address: string; allowedDestinations: readonly string[] }): Promise<string> {
    if (this.failNext) {
      const e = this.failNext;
      this.failNext = null;
      throw e;
    }
    if (expect.allowedDestinations.length === 0) throw new Error('the declared addresses were not passed');
    this.sent.push({ stepId: tx.stepId, address: expect.address });
    return hash(String(++this.n % 10));
  }
  async confirmation(_c: string, h: string): Promise<'confirmed' | 'failed' | 'pending'> {
    return this.results.get(h) ?? 'confirmed';
  }
}

const setup = (over: { store?: InMemoryExecutionStore; provider?: TwoStepProvider; gateway?: FakeGateway; now?: () => number } = {}) => {
  const store = over.store ?? new InMemoryExecutionStore();
  const provider = over.provider ?? new TwoStepProvider({ id: 'two', now: () => NOW });
  const gateway = over.gateway ?? new FakeGateway();
  let id = 0;
  const orch = new CrossChainOrchestrator({ store, providers: [provider as SettlementProvider], gateway, now: over.now ?? (() => NOW), newId: () => `x${++id}`, sleep: async () => undefined, confirmTimeoutMs: 0 });
  return { store, provider, gateway, orch };
};
const quoteOf = (p: TwoStepProvider) => p.getQuote(intent);

describe('the state machine', () => {
  it('has no way out of a final state, and COMPLETED is reachable only from the destination states', () => {
    for (const f of FINAL_STATES) for (const to of EXECUTION_STATES) expect(canTransition(f, to)).toBe(false);
    const into = EXECUTION_STATES.filter((s) => canTransition(s, 'COMPLETED'));
    expect(into.sort()).toEqual(['DESTINATION_EXECUTED', 'DESTINATION_RECEIVED']);
    expect(canTransition('SOURCE_CONFIRMED', 'COMPLETED')).toBe(false);
    expect(canTransition('SOURCE_SUBMITTED', 'COMPLETED')).toBe(false);
  });

  it('property: any random walk through allowed moves never leaves a final state and never skips to completion', () => {
    fc.assert(fc.property(fc.array(fc.constantFrom(...EXECUTION_STATES), { maxLength: 30 }), (moves) => {
      let state: (typeof EXECUTION_STATES)[number] = 'CREATED';
      for (const m of moves) {
        if (canTransition(state, m)) {
          if (FINAL_STATES.includes(state)) return false;
          state = m;
        }
      }
      return true;
    }));
  });

  it('refuses expiry after a transaction was sent', async () => {
    const { orch, provider } = setup();
    const r = await orch.create(await quoteOf(provider));
    const sent: ExecutionRecord = { ...r, steps: { burn: { stepId: 'burn', chain: 'ethereum', status: 'submitted', hash: hash('1'), updatedAt: NOW } } };
    expect(() => applyTransition({ ...sent, state: 'AWAITING_SIGNATURE' }, 'EXPIRED', 'x', NOW)).toThrow(/after a transaction was sent/);
  });

  it('keeps bigints through saving and loading, and refuses a damaged record', async () => {
    const { orch, provider } = setup();
    const r = await orch.create(await quoteOf(provider));
    const back = parseRecord(serializeRecord(r));
    expect(back.quote.sourceAmount).toBe(5_000_000_000n);
    expect(() => parseRecord('{"id":"x"}')).toThrow(/damaged/);
  });
});

describe('executing', () => {
  it('walks QUOTED to SETTLEMENT_PENDING, sending the approval, confirming it, then the burn, from the stated sender', async () => {
    const { orch, provider, gateway } = setup();
    const r = await orch.create(await quoteOf(provider));
    expect(r.state).toBe('QUOTED');
    const done = await orch.start(r.id);
    expect(done.state).toBe('SETTLEMENT_PENDING');
    expect(gateway.sent).toEqual([{ stepId: 'approve', address: SENDER }, { stepId: 'burn', address: SENDER }]);
    expect(done.history.map((h) => h.to)).toEqual(['QUOTED', 'AWAITING_SIGNATURE', 'SOURCE_SUBMITTED', 'SOURCE_CONFIRMED', 'SETTLEMENT_PENDING']);
    expect(done.executionId).toMatch(/^two:ethereum:0x/);
  });

  it('does not complete on the source transaction; it completes only when the provider says the destination has it', async () => {
    const { orch, provider } = setup();
    const r = await orch.start((await orch.create(await quoteOf(provider))).id);
    provider.code = 'source-confirmed';
    expect((await orch.advance(r.id)).record.state).toBe('SETTLEMENT_PENDING');
    provider.code = 'unknown';
    expect((await orch.advance(r.id)).record.state).toBe('SETTLEMENT_PENDING');
    provider.code = 'ready-to-complete';
    expect((await orch.advance(r.id)).claimable).toBe(true);
    provider.code = 'completed';
    const end = (await orch.advance(r.id)).record;
    expect(end.state).toBe('COMPLETED');
    expect(end.history.map((h) => h.to).slice(-2)).toEqual(['DESTINATION_RECEIVED', 'COMPLETED']);
  });

  it('claims from the recipient account, and does not offer a second claim while one is in flight', async () => {
    const { orch, provider, gateway } = setup();
    const r = await orch.start((await orch.create(await quoteOf(provider))).id);
    provider.code = 'ready-to-complete';
    const claimed = await orch.claim(r.id);
    expect(gateway.sent.at(-1)).toEqual({ stepId: 'mint', address: RECIPIENT });
    expect(claimed.destinationTxHash).toMatch(/^0x/);
    expect((await orch.advance(r.id)).claimable).toBe(false);
    const sentBefore = gateway.sent.length;
    await orch.claim(r.id);
    expect(gateway.sent.length).toBe(sentBefore); // not sent twice
  });

  it('a declined signature returns to QUOTED with nothing sent, and a later start works', async () => {
    const { orch, provider, gateway } = setup();
    const r = await orch.create(await quoteOf(provider));
    gateway.failNext = new SwingsError('rejected', 'no');
    expect((await orch.start(r.id)).state).toBe('QUOTED');
    expect(gateway.sent).toEqual([]);
    expect((await orch.start(r.id)).state).toBe('SETTLEMENT_PENDING');
  });

  it('if the burn is declined after the approval was sent, it stays resumable and does not resend the approval', async () => {
    const { orch, provider, gateway } = setup();
    const r = await orch.create(await quoteOf(provider));
    let calls = 0;
    const real = gateway.send.bind(gateway);
    gateway.send = async (tx, e) => {
      if (tx.stepId === 'burn' && calls++ === 0) throw new SwingsError('rejected', 'no');
      return real(tx, e);
    };
    expect((await orch.start(r.id)).state).toBe('AWAITING_SIGNATURE');
    expect((await orch.start(r.id)).state).toBe('SETTLEMENT_PENDING');
    expect(gateway.sent.filter((s) => s.stepId === 'approve')).toHaveLength(1);
  });

  it('fails, without claiming funds are at risk, when the source transaction fails on the network', async () => {
    const { orch, provider, gateway } = setup();
    const r = await orch.create(await quoteOf(provider));
    gateway.results.set(hash('1'), 'failed');
    const out = await orch.start(r.id);
    expect(out.state).toBe('FAILED');
    expect(out.failure?.fundsMayBeAtRisk).toBe(false);
  });

  it('fails with funds flagged when the provider reports a failed settlement after the burn', async () => {
    const { orch, provider } = setup();
    const r = await orch.start((await orch.create(await quoteOf(provider))).id);
    provider.code = 'failed';
    const out = (await orch.advance(r.id)).record;
    expect(out.state).toBe('FAILED');
    expect(out.failure?.fundsMayBeAtRisk).toBe(true);
  });

  it('expires an unsigned quote, but refuses to create from an already-expired one', async () => {
    let t = NOW;
    const { orch, provider } = setup({ now: () => t });
    const r = await orch.create(await quoteOf(provider));
    t = NOW + 10 * 60_000;
    expect((await orch.start(r.id)).state).toBe('EXPIRED');
    await expect(orch.create(await quoteOf(provider))).rejects.toThrow(/expired/);
  });

  it('refuses to run twice at once', async () => {
    const { orch, provider } = setup();
    const r = await orch.create(await quoteOf(provider));
    const a = orch.start(r.id);
    await expect(orch.start(r.id)).rejects.toThrow(/already being worked on/);
    await a;
  });
});

describe('recovery from an interruption', () => {
  it('a crash while the wallet was being asked is flagged, never silently retried', async () => {
    const store = new InMemoryExecutionStore();
    const a = setup({ store });
    const r = await a.orch.create(await quoteOf(a.provider));
    // Simulate the page dying inside gateway.send: "sending" was saved, no hash came back.
    const stuck = await store.update({ ...r, state: 'AWAITING_SIGNATURE', steps: { approve: { stepId: 'approve', chain: 'ethereum', status: 'sending', hash: null, updatedAt: NOW } } }, r.version);
    const b = setup({ store });
    const out = await b.orch.start(stuck.id);
    expect(out.needsAttention).toMatch(/cannot tell whether the wallet sent it/);
    expect(b.gateway.sent).toEqual([]);
    await expect(b.orch.start(stuck.id)).rejects.toThrow(/cannot continue by itself/);
    const fixed = await b.orch.resolveAttention(stuck.id, { stepId: 'approve', sent: false });
    expect(fixed.needsAttention).toBeNull();
    expect((await b.orch.start(stuck.id)).state).toBe('SETTLEMENT_PENDING');
  });

  it('after a reload in SOURCE_SUBMITTED it only follows the confirmation, and sends nothing', async () => {
    const store = new InMemoryExecutionStore();
    const a = setup({ store });
    a.gateway.results.set(hash('2'), 'pending'); // the burn is the second send
    const r = await a.orch.create(await quoteOf(a.provider));
    const first = await a.orch.start(r.id);
    expect(first.state).toBe('SOURCE_SUBMITTED');
    expect(first.needsAttention).toMatch(/still not confirmed/);
    const b = setup({ store });
    await b.orch.resolveAttention(r.id, { stepId: 'burn', sent: true, hash: hash('2') });
    const resumed = await b.orch.start(r.id);
    expect(resumed.state).toBe('SETTLEMENT_PENDING');
    expect(b.gateway.sent).toEqual([]);
  });

  it('lists unfinished executions for resuming, newest first', async () => {
    const { orch, provider } = setup();
    const r = await orch.create(await quoteOf(provider));
    expect((await orch.active()).map((x) => x.id)).toEqual([r.id]);
    await orch.recordRefund(r.id, hash('9')).catch(() => undefined);
    expect((await orch.active()).length).toBe(1); // QUOTED cannot be refunded
  });
});

describe('the stores', () => {
  it('refuse a write against an old version, so two tabs cannot overwrite each other', async () => {
    const { orch, provider, store } = setup();
    const r = await orch.create(await quoteOf(provider));
    await store.update({ ...r, updatedAt: 1 }, r.version);
    await expect(store.update({ ...r, updatedAt: 2 }, r.version)).rejects.toThrow(/changed elsewhere/);
  });

  it('the browser-storage store round-trips, skips a damaged entry, and fails loudly when storage is full', async () => {
    const mem = new Map<string, string>();
    const storage = { getItem: (k: string) => mem.get(k) ?? null, setItem: (k: string, v: string) => void mem.set(k, v), removeItem: (k: string) => void mem.delete(k) };
    const store = new StorageExecutionStore(storage);
    const { provider } = setup();
    const orch = new CrossChainOrchestrator({ store, providers: [provider], gateway: new FakeGateway(), now: () => NOW, newId: () => 'x1', sleep: async () => undefined });
    const r = await orch.create(await quoteOf(provider));
    expect((await store.get(r.id))!.quote.sourceAmount).toBe(5_000_000_000n);
    const raw = JSON.parse(mem.get('aretia-swings-executions')!);
    raw.items.bad = '{"nope":1}';
    mem.set('aretia-swings-executions', JSON.stringify(raw));
    expect((await store.list()).map((x) => x.id)).toEqual([r.id]);
    const full = new StorageExecutionStore({ ...storage, setItem: () => { throw new Error('quota'); } });
    await expect(full.create({ ...r, id: 'other' })).rejects.toThrow(/would not save/);
  });
});
