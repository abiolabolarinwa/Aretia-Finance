import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import fc from 'fast-check';
import { quoteProblems, rankQuotes, SettlementQuoteEngine } from './engine.js';
import { MockSettlementProvider } from './testing.js';
import { executionIdOf, parseExecutionId, type SettlementIntent, type SettlementProvider } from './types.js';

const USDC_SOL = { chain: 'solana' as const, address: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v' };
const USDC_BASE = { chain: 'base' as const, address: '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913' };
const intent = (over: Partial<SettlementIntent> = {}): SettlementIntent => ({ sourceChain: 'solana', sourceAsset: USDC_SOL, sourceAmount: 1_000_000_000n, destinationChain: 'base', destinationAsset: USDC_BASE, sender: 'SenderSol1111111111111111111111111111111111', recipient: '0x' + '1'.repeat(40), ...over });
const NOW = 1_000_000;
const engine = (providers: SettlementProvider[], over: ConstructorParameters<typeof SettlementQuoteEngine>[1] = {}) => new SettlementQuoteEngine(providers, { now: () => NOW, ...over });
const mock = (o: ConstructorParameters<typeof MockSettlementProvider>[0] = {}) => new MockSettlementProvider({ now: () => NOW, ...o });

describe('SettlementQuoteEngine', () => {
  it('asks every provider, keeps the quotes that pass, and ranks by cost, then time', async () => {
    const cheap = mock({ id: 'cheap', feeBps: 1, seconds: 900 });
    const quick = mock({ id: 'quick', feeBps: 5, seconds: 20 });
    const search = await engine([quick, cheap]).quote(intent());
    expect(search.quotes.map((q) => q.providerId)).toEqual(['cheap', 'quick']); // balanced: more arrives first
    expect(search.declined).toEqual([]);
    expect(search.failures).toEqual([]);
    expect((await engine([quick, cheap]).quote(intent(), 'fastest')).quotes.map((q) => q.providerId)).toEqual(['quick', 'cheap']);
    expect((await engine([quick, cheap]).quote(intent(), 'cheapest')).quotes[0]!.providerId).toBe('cheap');
  });

  it('says why a provider cannot help instead of staying silent, and does not offer a route nobody supports', async () => {
    const onlyEth = mock({ id: 'eth-only', pairs: ['ethereum>base'] });
    const search = await engine([onlyEth]).quote(intent());
    expect(search.quotes).toEqual([]);
    expect(search.declined).toEqual([{ providerId: 'eth-only', reason: 'The mock does not list solana>base.' }]);
    await expect(engine([onlyEth]).best(intent())).rejects.toThrow(/No settlement route is available.*eth-only: The mock does not list/);
  });

  it('survives a provider that fails or hangs, reporting it, and still answers from the others', async () => {
    const down = mock({ id: 'down', failQuote: true });
    const hangs: SettlementProvider = { ...mock({ id: 'hangs' }), id: 'hangs', name: 'h', supports: () => new Promise(() => undefined), getQuote: () => new Promise(() => undefined), buildSettlement: async () => [], buildDestination: async () => null, trackSettlement: async () => { throw new Error('unused'); } };
    const ok = mock({ id: 'ok' });
    const search = await engine([down, hangs, ok], { timeoutMs: 30 }).quote(intent());
    expect(search.quotes.map((q) => q.providerId)).toEqual(['ok']);
    expect(search.failures.map((f) => f.providerId)).toEqual(['down', 'hangs']);
    expect(search.failures[1]!.message).toMatch(/too long/);
  });

  it('declines quotes above the allowed risk, with the reason, and still prefers lower risk over a lower price', async () => {
    const risky = mock({ id: 'risky', feeBps: 0, risk: 'high' });
    const safe = mock({ id: 'safe', feeBps: 20, risk: 'low' });
    const search = await engine([risky, safe]).quote(intent());
    expect(search.quotes.map((q) => q.providerId)).toEqual(['safe']);
    expect(search.declined[0]).toMatchObject({ providerId: 'risky' });
    expect(search.declined[0]!.reason).toMatch(/risk \(high\)/);
    const medium = mock({ id: 'medium', feeBps: 0, risk: 'medium' });
    expect((await engine([medium, safe]).quote(intent())).quotes.map((q) => q.providerId)).toEqual(['safe', 'medium']);
  });

  it('refuses nonsense requests before asking anyone', async () => {
    await expect(engine([mock()]).quote(intent({ sourceAmount: 0n }))).rejects.toThrow(/above zero/);
    await expect(engine([mock()]).quote(intent({ destinationChain: 'solana' }))).rejects.toThrow(/two different chains/);
  });
});

describe('the engine does not trust a provider\'s quote', () => {
  const bad = async (sloppy: NonNullable<ConstructorParameters<typeof MockSettlementProvider>[0]>['sloppy']) => (await engine([mock({ id: 'liar', sloppy })]).quote(intent())).failures[0]?.message ?? '';

  it('rejects a quote that changes the amount, pays out more than was sent, has expired, has no destination step, or names another provider', async () => {
    expect(await bad({ changeAmount: true })).toMatch(/changes the amount/);
    expect(await bad({ payMore: true })).toMatch(/more than was sent/);
    expect(await bad({ expired: true })).toMatch(/already expired/);
    expect(await bad({ noReceiveStep: true })).toMatch(/destination receiving the value/);
    expect(await bad({ otherProvider: true })).toMatch(/different provider/);
  });

  it('rejects a quote for a different request, one outside its own limits, or with a bad time estimate', async () => {
    const q = await mock().getQuote(intent());
    expect(quoteProblems(intent({ recipient: '0x' + '9'.repeat(40) }), q, NOW).join(' ')).toMatch(/different request/);
    expect(quoteProblems(intent(), { ...q, limits: { min: 2_000_000_000n, max: null } }, NOW).join(' ')).toMatch(/below the route's minimum/);
    expect(quoteProblems(intent(), { ...q, limits: { min: null, max: 5n } }, NOW).join(' ')).toMatch(/above the route's maximum/);
    expect(quoteProblems(intent(), { ...q, estimatedSeconds: Number.NaN }, NOW).join(' ')).toMatch(/time estimate/);
    expect(quoteProblems(intent(), { ...q, route: { ...q.route, steps: [] } }, NOW).join(' ')).toMatch(/no steps/);
    expect(quoteProblems(intent(), q, NOW)).toEqual([]);
  });

  it('allows a converting route to deliver a different amount than was sent, since the units differ', async () => {
    const q = await mock().getQuote(intent());
    expect(quoteProblems(intent(), { ...q, route: { ...q.route, kind: 'convert' }, destinationAmount: q.sourceAmount * 100n }, NOW)).toEqual([]);
  });
});

describe('rankQuotes', () => {
  it('property: ranking is deterministic, loses nothing, and never puts higher risk ahead of lower risk', async () => {
    const levels = ['low', 'medium', 'high'] as const;
    await fc.assert(
      fc.asyncProperty(fc.array(fc.record({ fee: fc.integer({ min: 0, max: 50 }), secs: fc.integer({ min: 1, max: 5_000 }), risk: fc.constantFrom(...levels) }), { minLength: 1, maxLength: 8 }), fc.constantFrom('balanced' as const, 'cheapest' as const, 'fastest' as const), async (rows, pref) => {
        const quotes = await Promise.all(rows.map((r, i) => mock({ id: `p${i}`, feeBps: r.fee, seconds: r.secs, risk: r.risk }).getQuote(intent())));
        const a = rankQuotes(quotes, pref);
        const b = rankQuotes([...quotes].reverse(), pref);
        const risk = { low: 0, medium: 1, high: 2 };
        return a.length === quotes.length && a.every((q, i) => q.id === b[i]!.id) && a.every((q, i) => i === 0 || risk[a[i - 1]!.risk.level] <= risk[q.risk.level]);
      }),
      { numRuns: 60 },
    );
  });
});

describe('execution ids', () => {
  it('round-trip, and a malformed id is refused', () => {
    const id = executionIdOf('cctp', 'base', '0xabc');
    expect(parseExecutionId(id)).toEqual({ providerId: 'cctp', sourceChain: 'base', sourceTx: '0xabc' });
    expect(parseExecutionId('nonsense')).toBeNull();
  });
});

describe('the test provider cannot leak into the product', () => {
  it('is imported by no production module', () => {
    const offenders: string[] = [];
    const walk = (dir: string): void => {
      for (const f of readdirSync(dir)) {
        const p = join(dir, f);
        if (statSync(p).isDirectory()) walk(p);
        else if (/\.(ts|astro)$/.test(f) && !/\.test\.ts$|\.live\.ts$|settlement[\\/]testing\.ts$/.test(p) && /settlement\/testing/.test(readFileSync(p, 'utf8'))) offenders.push(p);
      }
    };
    walk(join(process.cwd(), 'src'));
    walk(join(process.cwd(), 'api'));
    expect(offenders).toEqual([]);
  });
});
