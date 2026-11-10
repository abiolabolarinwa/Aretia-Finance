import { describe, expect, it } from 'vitest';
import { BULLISH_RULE, BULLISH_TEXT, isBullish } from './bullish.js';
import { fetchGainersStrip, gainersStripUrl, pickGainers, STRIP_SIZE } from './gainersStrip.js';
import type { MarketRow } from './types.js';

const row = (over: Partial<Pick<MarketRow, 'change' | 'txns24h' | 'traders24h' | 'liquidityUsd'>> = {}): Pick<MarketRow, 'change' | 'txns24h' | 'traders24h' | 'liquidityUsd'> => ({
  change: { m5: 1, h1: 2, h6: 3, h24: 4 },
  txns24h: 50,
  traders24h: 20,
  liquidityUsd: 5_000,
  ...over,
});

describe('the bullish rule', () => {
  it('needs a rise over both the hour and the day, with enough trades, wallets and liquidity', () => {
    expect(isBullish(row())).toBe(true);
    expect(isBullish(row({ change: { m5: 1, h1: -0.1, h6: 3, h24: 4 } }))).toBe(false);
    expect(isBullish(row({ change: { m5: 1, h1: 2, h6: 3, h24: 0 } }))).toBe(false);
    expect(isBullish(row({ change: { m5: null, h1: null, h6: null, h24: 4 } }))).toBe(false);
    expect(isBullish(row({ txns24h: BULLISH_RULE.minTrades24h - 1 }))).toBe(false);
    expect(isBullish(row({ txns24h: null }))).toBe(false);
    expect(isBullish(row({ traders24h: BULLISH_RULE.minTraders24h - 1 }))).toBe(false);
    expect(isBullish(row({ liquidityUsd: BULLISH_RULE.minLiquidityUsd - 1 }))).toBe(false);
    expect(isBullish(row({ liquidityUsd: null }))).toBe(false);
  });
  it('does not hold a source that does not count wallets to the wallet part of the rule', () => {
    expect(isBullish(row({ traders24h: null }))).toBe(true);
  });
  it('states its own rule in words', () => {
    expect(BULLISH_TEXT).toContain('last hour');
    expect(BULLISH_TEXT).toContain('24 hours');
    expect(BULLISH_TEXT).toContain('$1,000');
    expect(BULLISH_TEXT).toContain('turn it off');
  });
});

describe('the top gainers strip', () => {
  const r = (symbol: string, h24: number | null, over: Partial<MarketRow> = {}): MarketRow =>
    ({ chain: 'ethereum', address: `0x${symbol}`, symbol, quoteSymbol: 'WETH', name: symbol, icon: null, decimals: 18, pool: `0xp${symbol}`, priceUsd: 1, capUsd: null, ageMs: 1, txns24h: 20, volume24hUsd: 1, traders24h: 5, change: { m5: null, h1: null, h6: null, h24 }, liquidityUsd: 5_000, risk: null, fresh: false, ...over }) as MarketRow;
  it('asks the index for the 24-hour gainers with a $1,000 bar, for one network or all', () => {
    const u = new URL(gainersStripUrl('bnb'), 'https://x.test');
    expect(u.pathname).toBe('/api/swings-market');
    expect(Object.fromEntries(u.searchParams)).toMatchObject({ src: 'index', kind: 'gainers', window: 'h24', chain: 'bnb', minLiq: '1000' });
    expect(new URL(gainersStripUrl(''), 'https://x.test').searchParams.has('chain')).toBe(false);
  });
  it('keeps the first five that are really up, and drops falling, unknown and dead markets', () => {
    const rows = [r('A', 90), r('B', -5), r('C', null), r('D', 40), r('E', 30), r('F', 20), r('G', 10), r('H', 5)];
    expect(pickGainers(rows).map((x) => x.symbol)).toEqual(['A', 'D', 'E', 'F', 'G']);
    expect(pickGainers(rows)).toHaveLength(STRIP_SIZE);
  });
  it('is empty, never an error, when the index is unreachable or holds nothing', async () => {
    const answer = (body: unknown, ok = true) => (async () => new Response(JSON.stringify(body), { status: ok ? 200 : 500 })) as unknown as typeof fetch;
    expect(await fetchGainersStrip('', answer({ rows: [r('A', 5)] }))).toHaveLength(1);
    expect(await fetchGainersStrip('', answer({ rows: [] }))).toEqual([]);
    expect(await fetchGainersStrip('', answer({ error: 'x', rows: [] }))).toEqual([]);
    expect(await fetchGainersStrip('', answer({}, false))).toEqual([]);
    expect(await fetchGainersStrip('', (async () => { throw new Error('offline'); }) as unknown as typeof fetch)).toEqual([]);
  });
});
