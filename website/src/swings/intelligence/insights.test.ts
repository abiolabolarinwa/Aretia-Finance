import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import { compareSettlementQuotes, providerReliability, quoteWarnings, wilsonLowerBound } from './insights.js';
import { rankQuotes } from '../settlement/engine.js';
import { MockSettlementProvider } from '../settlement/testing.js';

const NOW = 10_000_000;
const intent = { sourceChain: 'ethereum' as const, sourceAsset: { chain: 'ethereum' as const, address: '0x1' }, sourceAmount: 100_000_000n, destinationChain: 'base' as const, destinationAsset: { chain: 'base' as const, address: '0x2' }, sender: '0xa', recipient: '0xa' };
const quotes = async (...specs: { id: string; feeBps: number; seconds: number; risk?: 'low' | 'medium' | 'high' }[]) =>
  Promise.all(specs.map((s) => new MockSettlementProvider({ now: () => NOW, ...s }).getQuote(intent)));

describe('reliability', () => {
  it('is cautious: few successes score low, many score high, and nothing is trusted without data', () => {
    expect(wilsonLowerBound(0, 0)).toBe(0);
    expect(wilsonLowerBound(2, 2)).toBeLessThan(0.7);
    expect(wilsonLowerBound(200, 200)).toBeGreaterThan(0.98);
    expect(wilsonLowerBound(180, 200)).toBeLessThan(0.9);
  });

  it('property: the score is between 0 and 1, never above the raw success rate, and rises with more evidence of the same rate', () => {
    fc.assert(fc.property(fc.integer({ min: 1, max: 500 }), fc.integer({ min: 0, max: 500 }), (total, s) => {
      const ok = Math.min(s, total);
      const w = wilsonLowerBound(ok, total);
      return w >= 0 && w <= 1 && w <= ok / total + 1e-9 && wilsonLowerBound(ok * 2, total * 2) >= w - 1e-9;
    }));
  });

  it('labels a provider by recent history only, and says when history is too short to judge', () => {
    const run = (n: number, fails: number, at = NOW) => Array.from({ length: n }, (_, i) => ({ ok: i >= fails, at }));
    expect(providerReliability([], NOW).label).toBe('no history');
    expect(providerReliability(run(5, 1), NOW)).toMatchObject({ label: 'limited history', summary: '1 of the last 5 attempts failed. That is too few to judge.' });
    expect(providerReliability(run(100, 1), NOW).label).toBe('reliable');
    expect(providerReliability(run(100, 30), NOW).label).toBe('unreliable');
    expect(providerReliability(run(100, 30, NOW - 30 * 24 * 3_600_000), NOW).label).toBe('no history'); // too old to count
  });
});

describe('comparing routes', () => {
  it('states what the choice saves or costs, in amounts and time', async () => {
    const qs = rankQuotes(await quotes({ id: 'cheap', feeBps: 1, seconds: 1200 }, { id: 'quick', feeBps: 20, seconds: 20 }), 'balanced');
    const c = compareSettlementQuotes(qs)!;
    expect(c.headline).toMatch(/arrives on Base in about 20 minutes/);
    expect(c.details[0]).toMatch(/0\.19 USDC more arrives on Base/);
    expect(c.details[0]).toMatch(/19 minutes slower|20 minutes slower|minutes slower/);
    expect(compareSettlementQuotes([])).toBeNull();
  });

  it('is deterministic: the same quotes give the same words', async () => {
    const qs = await quotes({ id: 'a', feeBps: 5, seconds: 60 }, { id: 'b', feeBps: 9, seconds: 30 });
    expect(compareSettlementQuotes(qs)).toEqual(compareSettlementQuotes(qs));
  });
});

describe('warnings', () => {
  it('notes a single option, an outlier, a risky or slow route, and an empty set', async () => {
    expect(quoteWarnings([])[0]!.severity).toBe('caution');
    expect(quoteWarnings(await quotes({ id: 'only', feeBps: 1, seconds: 10 }))[0]!.text).toMatch(/Only one route/);
    const w = quoteWarnings(await quotes({ id: 'a', feeBps: 1, seconds: 10 }, { id: 'b', feeBps: 300, seconds: 7200, risk: 'medium' }));
    const text = w.map((x) => x.text).join(' | ');
    expect(text).toMatch(/2\.9\d% less than the best route/);
    expect(text).toMatch(/rated medium risk/);
    expect(text).toMatch(/takes about 2\.0 hours/);
  });
});
