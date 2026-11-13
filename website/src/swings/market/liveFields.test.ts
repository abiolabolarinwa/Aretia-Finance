import { describe, expect, it } from 'vitest';
import { rowFromRecord, type PoolRecord } from '../mi/marketList.js';
import { applyLive, capAtPrice, liveFieldsOf, type LiveRecord } from './liveFields.js';
import type { MarketRow } from './types.js';

const NOW = 1_700_000_000_000;
const WBNB = '0xbb4cdb9cbd36b01bd1cbaebf2de08d9173bc095c';
const hex = (n: number): string => `0x${n.toString(16).padStart(40, '0')}`;
const SUPPLY = (1_000_000n * 10n ** 18n).toString();

const rec = (over: Partial<PoolRecord> = {}): PoolRecord => ({
  key: `bnb:${hex(1001)}`,
  chain: 'bnb',
  address: hex(1001),
  adapter_id: 'pancakeswap-v2-bnb',
  dex: 'pancakeswap',
  base: hex(1),
  quote: WBNB,
  base_decimals: 18,
  created_at: NOW - 3_600_000,
  last_trade_at: NOW - 1_000,
  liquidity_usd: 5000,
  vol24_usd: 10_000,
  p_usd: 1.5,
  chg: { m5: 100, h1: 250, h6: 400, h24: 1000 },
  buys: { m5: 1, h1: 5, h6: 20, h24: 60 },
  sells: { m5: 1, h1: 4, h6: 18, h24: 50 },
  vol: { m5: 100, h1: 1000, h6: 5000, h24: 10_000 },
  ro: false,
  mk: 12,
  ...over,
});
const tokens = new Map([
  [`bnb:${hex(1)}`, { symbol: 'MEME', name: 'Meme', decimals: 18, total_supply: SUPPLY }],
  [`bnb:${WBNB}`, { symbol: 'WBNB', name: 'Wrapped BNB', decimals: 18 }],
]);
const rowOf = (p: PoolRecord, now = NOW): MarketRow => rowFromRecord(p, tokens, now)!;
const liveOf = (p: PoolRecord): LiveRecord => ({ p_usd: p.p_usd, rp: p.rp, chg: p.chg, buys: p.buys, sells: p.sells, vol: p.vol, ro: p.ro, mk: p.mk, cp: p.cp, last_trade_at: p.last_trade_at, liquidity_usd: p.liquidity_usd });
const LIVE_KEYS = ['priceUsd', 'priceFromReserves', 'txns24h', 'txnsCapped', 'volume24hUsd', 'traders24h', 'volumeUsd', 'txns', 'change', 'liquidityUsd', 'capUsd', 'capIsFdv'] as const;
const liveView = (r: MarketRow): Record<string, unknown> => Object.fromEntries(LIVE_KEYS.map((k) => [k, r[k]]));

describe('live fields of a row', () => {
  it('give exactly what the server list gives for the same stored pool, in every state a pool can be in', () => {
    const cases: PoolRecord[] = [
      rec(), // traded
      rec({ cp: true }), // 5,000+ trades
      rec({ ro: true, p_usd: null, rp: 0.7, chg: null, buys: null, sells: null, vol: null, mk: null }), // no stored trade: reserve price
      rec({ ro: true, p_usd: null, rp: null, chg: null, buys: null, sells: null, vol: null }), // nothing known
      rec({ last_trade_at: NOW - 2 * 3_600_000 }), // quiet for two hours: the 5-minute and 1-hour windows are empty
      rec({ last_trade_at: NOW - 30 * 3_600_000 }), // quiet for over a day
      rec({ chg: { m5: null, h1: null, h6: null, h24: 500 } }),
    ];
    for (const p of cases) {
      const server = rowOf(p);
      // The page starts from the row it was sent (here: the same row made from an older state), then applies the live update.
      const older = rowOf(rec({ p_usd: 1, chg: null, buys: null, sells: null, vol: null, ro: true, rp: 1 }));
      const live = applyLive({ ...server, ...older, capUsd: server.capUsd, capIsFdv: server.capIsFdv, priceUsd: server.priceUsd }, liveOf(p), NOW);
      expect(liveView(live)).toEqual(liveView(server));
    }
  });

  it('keeps everything that is not a trade number: name, age, icon, risk', () => {
    const base = { ...rowOf(rec()), icon: 'x.png', risk: { level: 'low' } as unknown as MarketRow['risk'] };
    const next = applyLive(base, liveOf(rec({ p_usd: 9 })), NOW);
    expect(next.symbol).toBe(base.symbol);
    expect(next.ageMs).toBe(base.ageMs);
    expect(next.icon).toBe('x.png');
    expect(next.risk).toBe(base.risk);
    expect(next.priceUsd).toBe(9);
  });

  it('moves the fully diluted value with the price, from the row\'s own supply, and drops it when it cannot be known', () => {
    const row = rowOf(rec({ p_usd: 2 })); // 2 dollars x 1,000,000 tokens
    expect(row.capUsd).toBe(2_000_000);
    expect(applyLive(row, liveOf(rec({ p_usd: 3 })), NOW).capUsd).toBe(3_000_000);
    const gone = applyLive(row, liveOf(rec({ p_usd: null })), NOW);
    expect(gone.capUsd).toBeNull();
    expect(gone.capIsFdv).toBeUndefined();
    expect(capAtPrice({ priceUsd: 2, capUsd: 2_000_000, capIsFdv: false }, 3)).toBeNull(); // a real market cap is never recomputed
    expect(capAtPrice({ priceUsd: 2, capUsd: 2_000_000, capIsFdv: true }, 1e9)).toBeNull(); // beyond a plausible value
  });

  it('clears the reserve-price and capped marks when a trade has since been stored', () => {
    const waiting = rowOf(rec({ ro: true, p_usd: null, rp: 0.7, chg: null, buys: null, sells: null, vol: null, cp: true }));
    expect(waiting.priceFromReserves).toBe(true);
    const traded = applyLive(waiting, liveOf(rec()), NOW);
    expect(traded.priceFromReserves).toBeUndefined();
    expect(traded.txnsCapped).toBeUndefined();
    expect(liveFieldsOf(liveOf(rec()), NOW).priceFromReserves).toBe(false);
  });
});
