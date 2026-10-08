import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import { durationText, formatUnits, parseUnits, viewQuote, viewStatus } from './view.js';
import { MockSettlementProvider } from '../settlement/testing.js';
import { EXECUTION_STATES, type ExecutionRecord } from '../orchestrator/states.js';

const NOW = 1_000;
const intent = { sourceChain: 'ethereum' as const, sourceAsset: { chain: 'ethereum' as const, address: '0x1' }, sourceAmount: 25_500_000n, destinationChain: 'base' as const, destinationAsset: { chain: 'base' as const, address: '0x2' }, sender: '0xa', recipient: '0xb' };

describe('amounts', () => {
  it('format and parse exactly, without floating point', () => {
    expect(formatUnits(1_234_500n, 6)).toBe('1.2345');
    expect(formatUnits(5n, 6)).toBe('0.000005');
    expect(formatUnits(10_000_000n, 6)).toBe('10');
    expect(parseUnits('25.5', 6)).toBe(25_500_000n);
    expect(parseUnits('.5', 6)).toBe(500_000n);
    expect(parseUnits('1.1234567', 6)).toBeNull(); // too many places: refused, never rounded
    expect(parseUnits('-1', 6)).toBeNull();
    expect(parseUnits('1e3', 6)).toBeNull();
    expect(parseUnits('', 6)).toBeNull();
  });

  it('property: parsing what was formatted gives the same amount back', () => {
    fc.assert(fc.property(fc.bigInt({ min: 0n, max: 10n ** 24n }), fc.integer({ min: 0, max: 18 }), (raw, d) => parseUnits(formatUnits(raw, d), d) === raw));
  });

  it('describes durations in plain words', () => {
    expect(durationText(20)).toBe('about 20 seconds');
    expect(durationText(19 * 60)).toBe('about 19 minutes');
    expect(durationText(5 * 3600)).toBe('about 5.0 hours');
  });
});

describe('quote view', () => {
  it('lists each cost separately, says network fees are not estimated, and shows exact amounts on named chains', async () => {
    const q = await new MockSettlementProvider({ now: () => NOW, feeBps: 10 }).getQuote(intent);
    const v = viewQuote(q, NOW);
    expect(v.youSend).toBe('25.5 USDC on Ethereum');
    expect(v.youReceive).toBe('25.4745 USDC on Base');
    expect(v.fees.map((f) => f.label)).toEqual(['Transfer fee', 'Network fees']);
    expect(v.fees[1]!.value).toMatch(/Not estimated.*ETH on Ethereum and ETH on Base/);
    expect(v.steps.at(-1)!.chain).toBe('Base');
    expect(v.secondsLeft).toBe(60);
  });

  it('says "None" for a free settlement rather than a zero that looks like an omission', async () => {
    const q = await new MockSettlementProvider({ now: () => NOW, feeBps: 0 }).getQuote(intent);
    expect(viewQuote(q, NOW).fees[0]!.value).toBe('None');
  });
});

describe('status view', () => {
  const record = async (state: ExecutionRecord['state'], over: Partial<ExecutionRecord> = {}): Promise<ExecutionRecord> => ({
    id: 'x', version: 1, state, quote: await new MockSettlementProvider({ now: () => NOW }).getQuote(intent), createdAt: 0, updatedAt: 0, steps: {}, executionId: null, destinationTxHash: null, refundTxHash: null, failure: null, needsAttention: null, history: [], ...over,
  });

  it('says the funds arrived only in COMPLETED, for every state', async () => {
    for (const st of EXECUTION_STATES) {
      const v = viewStatus(await record(st), false);
      const claimsArrival = /in your Base account/.test(v.detail) || v.title === 'Complete';
      expect(claimsArrival, st).toBe(st === 'COMPLETED');
    }
  });

  it('tells the user to claim only when claimable, and never offers to sign again once finished', async () => {
    expect(viewStatus(await record('SETTLEMENT_PENDING'), true).next).toBe('claim');
    expect(viewStatus(await record('SETTLEMENT_PENDING'), false).next).toBe('wait');
    for (const st of ['COMPLETED', 'FAILED', 'EXPIRED', 'REFUNDED'] as const) expect(viewStatus(await record(st), true).next).toBe('none');
  });

  it('puts "check your wallet" ahead of any state, and warns when funds may be in transit', async () => {
    expect(viewStatus(await record('SOURCE_SUBMITTED', { needsAttention: 'look' }), false).next).toBe('check-wallet');
    expect(viewStatus(await record('FAILED', { failure: { reason: 'x', fundsMayBeAtRisk: true } }), false).detail).toMatch(/may be in transit/);
    expect(viewStatus(await record('FAILED', { failure: { reason: 'x', fundsMayBeAtRisk: false } }), false).detail).toMatch(/No funds were moved/);
  });
});
