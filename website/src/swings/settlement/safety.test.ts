import { describe, expect, it } from 'vitest';
import { assessSettlement, type SafetyContext } from './safety.js';
import { MockSettlementProvider } from './testing.js';
import type { SettlementIntent } from './types.js';

const NOW = 1_000_000;
const A = '0x' + 'a'.repeat(40);
const B = '0x' + 'b'.repeat(40);
const intent = (over: Partial<SettlementIntent> = {}): SettlementIntent => ({ sourceChain: 'ethereum', sourceAsset: { chain: 'ethereum', address: '0x1' }, sourceAmount: 100_000_000n, destinationChain: 'base', destinationAsset: { chain: 'base', address: '0x2' }, sender: A, recipient: A, ...over });
const provider = new MockSettlementProvider({ id: 'p', now: () => NOW, feeBps: 1 });
const ctx = (over: Partial<SafetyContext> = {}): SafetyContext => ({ now: NOW, provider, enabledChains: ['ethereum', 'base'], sourceBalance: 500_000_000n, destinationNativeBalance: 10n ** 16n, existing: [], maxAmount: 1_000_000_000n, ...over });
const quote = (i = intent(), p = provider) => p.getQuote(i);

describe('settlement safety fails closed', () => {
  it('allows an ordinary, well-funded, own-account move', async () => {
    const v = assessSettlement(await quote(), ctx());
    expect(v).toMatchObject({ verdict: 'allow', blockers: [] });
  });

  it('blocks when anything it needs to verify is missing, rather than assuming it is fine', async () => {
    const q = await quote();
    expect(assessSettlement(q, ctx({ sourceBalance: null })).blockers.join(' ')).toMatch(/balance.*could not be read/);
    expect(assessSettlement(q, ctx({ destinationNativeBalance: null })).verdict).toBe('block');
    expect(assessSettlement(q, ctx({ maxAmount: null })).blockers.join(' ')).toMatch(/No limit per move/);
    expect(assessSettlement(q, ctx({ provider: null })).verdict).toBe('block');
  });

  it('blocks a network the operator has not switched on, an oversized move, too little balance and a nearly-expired quote', async () => {
    const q = await quote();
    expect(assessSettlement(q, ctx({ enabledChains: ['ethereum'] })).blockers.join(' ')).toMatch(/Base is not switched on/);
    expect(assessSettlement(q, ctx({ maxAmount: 50_000_000n })).blockers.join(' ')).toMatch(/above the limit/);
    expect(assessSettlement(q, ctx({ sourceBalance: 1n })).blockers.join(' ')).toMatch(/less than the amount/);
    expect(assessSettlement(q, ctx({ now: NOW + 50_000 })).blockers.join(' ')).toMatch(/about to expire/);
  });

  it('blocks a fee above the allowed share, and a high-risk route', async () => {
    const pricey = new MockSettlementProvider({ id: 'p', now: () => NOW, feeBps: 300 });
    expect(assessSettlement(await quote(intent(), pricey), ctx({ provider: pricey })).blockers.join(' ')).toMatch(/settlement fee is 3.00%/);
    const risky = new MockSettlementProvider({ id: 'p', now: () => NOW, risk: 'high' });
    expect(assessSettlement(await quote(intent(), risky), ctx({ provider: risky })).blockers.join(' ')).toMatch(/high risk/);
  });

  it('a different recipient is blocked unless chosen on purpose, and then needs acknowledgement', async () => {
    const q = await quote(intent({ recipient: B }));
    expect(assessSettlement(q, ctx()).verdict).toBe('block');
    const v = assessSettlement(q, ctx({ recipientIsDifferentOnPurpose: true }));
    expect(v.verdict).toBe('confirm');
    expect(v.confirmations.join(' ')).toMatch(/cannot be undone/);
  });

  it('asks for acknowledgement when there is no gas on the destination to claim with', async () => {
    const v = assessSettlement(await quote(), ctx({ destinationNativeBalance: 0n }));
    expect(v.verdict).toBe('confirm');
    expect(v.confirmations.join(' ')).toMatch(/cannot claim/);
  });

  it('blocks an invalid address and a duplicate in-flight move', async () => {
    const bad = await quote(intent({ sender: 'nope', recipient: 'nope' }));
    expect(assessSettlement(bad, ctx()).blockers.join(' ')).toMatch(/not valid/);
    const q = await quote();
    const inFlight = { state: 'SETTLEMENT_PENDING', quote: q } as never;
    expect(assessSettlement(q, ctx({ existing: [inFlight] })).blockers.join(' ')).toMatch(/already in progress/);
    const done = { state: 'COMPLETED', quote: q } as never;
    expect(assessSettlement(q, ctx({ existing: [done] })).verdict).toBe('allow');
  });
});
