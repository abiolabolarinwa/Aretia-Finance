import { describe, expect, it } from 'vitest';
import {
  cleanMarketPrefs,
  eventMessage,
  liquidityDrop,
  marketOn,
  MARKET_PREFS_OFF,
  MAX_MARKET_PER_HOUR,
  MAX_MARKET_PER_RUN,
  matchBigBuys,
  matchLaunches,
  matchLiquidityDrops,
  nextMarks,
  planMarket,
  tradeUsd,
  type IndexPool,
  type IndexTrade,
  type MarketEvent,
  type MarketPrefs,
  type PoolMark,
} from './market.js';

const NOW = 1_800_000_000_000;
const MIN = 60_000;
const TOKEN = 'TokenMint1111111111111111111111111111111111';

const pool = (over: Partial<IndexPool> = {}): IndexPool => ({ key: 'solana:Pool1', chain: 'solana', address: 'Pool1', base: TOKEN, quoteDecimals: 9, createdAt: NOW - 5 * MIN, liquidityUsd: 20_000, quoteUsd: 200, reserveBase: 1_000_000, reserveQuote: 100, symbol: 'CAT', ...over });
const prefs = (over: Partial<MarketPrefs> = {}): MarketPrefs => ({ ...MARKET_PREFS_OFF, ...over });
const ev = (kind: MarketEvent['kind'], i: number, chain: MarketEvent['chain'] = 'solana'): MarketEvent => ({ kind, key: `${kind}:${chain}:${i}`, chain, token: `t${i}`, symbol: `T${i}`, amount: 1000 + i, at: NOW - MIN });

describe('cleanMarketPrefs', () => {
  it('keeps only known choices and known networks, and turns anything else off', () => {
    expect(cleanMarketPrefs({ launchChains: ['solana', 'nope', 'base'], launchMinLiqUsd: 5000, bigBuyUsd: 10000, liqDropPct: 50 })).toEqual({ launchChains: ['solana', 'base'], launchMinLiqUsd: 5000, bigBuyUsd: 10000, liqDropPct: 50 });
    expect(cleanMarketPrefs({ launchChains: 'solana', launchMinLiqUsd: 123, bigBuyUsd: -1, liqDropPct: 99 })).toEqual(MARKET_PREFS_OFF);
    expect(cleanMarketPrefs(null)).toEqual(MARKET_PREFS_OFF);
    expect(marketOn(MARKET_PREFS_OFF)).toBe(false);
    expect(marketOn(prefs({ bigBuyUsd: 1000 }))).toBe(true);
  });
});

describe('matchLaunches', () => {
  it('reports new pools on the chosen networks with enough liquidity, newest first', () => {
    const pools = [
      pool({ key: 'solana:A', createdAt: NOW - 10 * MIN }),
      pool({ key: 'solana:B', createdAt: NOW - 2 * MIN }),
      pool({ key: 'base:C', chain: 'base' }),
      pool({ key: 'solana:D', liquidityUsd: 500 }),
      pool({ key: 'solana:E', createdAt: NOW - 45 * MIN }),
      pool({ key: 'solana:F', liquidityUsd: null }),
    ];
    const got = matchLaunches(pools, prefs({ launchChains: ['solana'], launchMinLiqUsd: 1000 }), NOW);
    expect(got.map((e) => e.key)).toEqual(['launch:solana:B', 'launch:solana:A']);
  });
  it('with no minimum still needs some liquidity, and reports nothing when switched off', () => {
    const pools = [pool({ key: 'solana:A', liquidityUsd: 0 }), pool({ key: 'solana:B', liquidityUsd: 5 })];
    expect(matchLaunches(pools, prefs({ launchChains: ['solana'] }), NOW).map((e) => e.key)).toEqual(['launch:solana:B']);
    expect(matchLaunches(pools, prefs(), NOW)).toEqual([]);
  });
});

describe('matchBigBuys', () => {
  const pools = new Map([[pool().key, pool()]]);
  const favs = new Set([`solana:${TOKEN}`]);
  const trade = (over: Partial<IndexTrade> = {}): IndexTrade => ({ chain: 'solana', pool: 'Pool1', id: 'sig:0', time: Math.floor((NOW - 2 * MIN) / 1000), side: 'buy', quoteAmount: String(30 * 1e9), ...over });

  it('values a buy from its quote amount and the quote token price', () => {
    expect(tradeUsd(trade(), pool())).toBe(6000);
    expect(tradeUsd(trade(), pool({ quoteUsd: null }))).toBeNull();
    expect(tradeUsd(trade({ quoteAmount: '1.5' }), pool())).toBeNull();
  });
  it('reports buys of favourites at or over the threshold, inside the window, largest first', () => {
    const trades = [
      trade({ id: 'a', quoteAmount: String(30 * 1e9) }),
      trade({ id: 'b', quoteAmount: String(60 * 1e9) }),
      trade({ id: 'c', quoteAmount: String(10 * 1e9) }),
      trade({ id: 'd', side: 'sell', quoteAmount: String(90 * 1e9) }),
      trade({ id: 'e', time: Math.floor((NOW - 20 * MIN) / 1000) }),
      trade({ id: 'f', pool: 'Other' }),
    ];
    const got = matchBigBuys(trades, pools, favs, prefs({ bigBuyUsd: 5000 }), NOW);
    expect(got.map((e) => [e.key, e.amount])).toEqual([['buy:solana:b', 12_000], ['buy:solana:a', 6000]]);
  });
  it('ignores tokens that are not the person\'s favourites, and does nothing when off', () => {
    expect(matchBigBuys([trade()], pools, new Set(), prefs({ bigBuyUsd: 1000 }), NOW)).toEqual([]);
    expect(matchBigBuys([trade()], pools, favs, prefs(), NOW)).toEqual([]);
  });
});

describe('liquidity drops', () => {
  const mark: PoolMark = { reserveBase: 1_000_000, reserveQuote: 100, at: NOW - 60 * MIN };
  it('counts liquidity as gone only when both sides shrink', () => {
    expect(liquidityDrop(pool({ reserveBase: 400_000, reserveQuote: 40 }), mark)).toBeCloseTo(0.6);
    // A heavy sell: the token side grows, the other side shrinks. Not a removal.
    expect(liquidityDrop(pool({ reserveBase: 3_000_000, reserveQuote: 30 }), mark)).toBe(0);
    expect(liquidityDrop(pool(), undefined)).toBeNull();
  });
  it('reports a favourite whose pool lost at least the chosen share, once per mark', () => {
    const marks = new Map([['solana:Pool1', mark]]);
    const favs = new Set([`solana:${TOKEN}`]);
    const drained = pool({ reserveBase: 400_000, reserveQuote: 40 });
    expect(matchLiquidityDrops([drained], marks, favs, prefs({ liqDropPct: 50 }), NOW)).toMatchObject([{ kind: 'liquidity', key: `liq:solana:Pool1:${mark.at}`, amount: 60 }]);
    expect(matchLiquidityDrops([drained], marks, favs, prefs({ liqDropPct: 80 }), NOW)).toEqual([]);
    expect(matchLiquidityDrops([drained], marks, new Set(), prefs({ liqDropPct: 30 }), NOW)).toEqual([]);
    const old = new Map([['solana:Pool1', { ...mark, at: NOW - 25 * 3_600_000 }]]);
    expect(matchLiquidityDrops([drained], old, favs, prefs({ liqDropPct: 30 }), NOW)).toEqual([]);
  });
  it('marks a new pool, raises the mark when liquidity is added, keeps it through a drain, and restarts it after a day', () => {
    expect(nextMarks([pool()], new Map(), NOW).get('solana:Pool1')).toEqual({ reserveBase: 1_000_000, reserveQuote: 100, at: NOW });
    expect(nextMarks([pool({ reserveBase: 2_000_000, reserveQuote: 200 })], new Map([['solana:Pool1', mark]]), NOW).size).toBe(1);
    expect(nextMarks([pool({ reserveBase: 500_000, reserveQuote: 50 })], new Map([['solana:Pool1', mark]]), NOW).size).toBe(0);
    expect(nextMarks([pool({ reserveBase: 500_000, reserveQuote: 50 })], new Map([['solana:Pool1', { ...mark, at: NOW - 25 * 3_600_000 }]]), NOW).size).toBe(1);
    expect(nextMarks([pool({ reserveBase: null })], new Map(), NOW).size).toBe(0);
  });
});

describe('messages', () => {
  it('carry only a title, numbers and a link to the token page', () => {
    expect(eventMessage({ kind: 'launch', key: 'k', chain: 'solana', token: TOKEN, symbol: 'CAT', amount: 12_300, at: NOW - 4 * MIN }, NOW)).toEqual({ kind: 'launch', title: 'New on Solana: CAT', body: 'Liquidity $12.3K, opened 4 min ago.', url: `/token#/solana/${TOKEN}` });
    expect(eventMessage({ kind: 'buy', key: 'k', chain: 'base', token: '0xabc', symbol: 'DOG', amount: 5_000, at: NOW }, NOW).title).toBe('DOG: $5K buy');
    expect(eventMessage({ kind: 'liquidity', key: 'k', chain: 'bnb', token: '0xabc', symbol: 'X', amount: 60, at: NOW }, NOW).title).toBe('X: 60% of liquidity removed');
  });
  it('take out characters that would turn a symbol into a link', () => {
    expect(eventMessage({ kind: 'launch', key: 'k', chain: 'solana', token: TOKEN, symbol: 'evil.com/@x', amount: 1, at: NOW }, NOW).title).toBe('New on Solana: evilcomx');
  });
});

describe('planMarket limits', () => {
  it('sends at most the per-run number, the last line counting the rest', () => {
    const events = [1, 2, 3, 4, 5, 6].map((i) => ev('buy', i));
    const p = planMarket(events, 0, NOW);
    expect(p.messages).toHaveLength(MAX_MARKET_PER_RUN);
    expect(p.messages[MAX_MARKET_PER_RUN - 1]!.title).toBe('3 more market alerts');
    // Everything is remembered as handled; each message counts once toward the hour.
    expect(p.handled).toHaveLength(6);
    expect(p.handled.filter((h) => h.msg)).toHaveLength(MAX_MARKET_PER_RUN);
  });
  it('sends nothing once the hourly limit is reached, but still remembers what it saw', () => {
    const p = planMarket([ev('buy', 1), ev('launch', 2)], MAX_MARKET_PER_HOUR, NOW);
    expect(p.messages).toEqual([]);
    expect(p.handled.map((h) => h.msg)).toEqual([false, false]);
    expect(planMarket([ev('buy', 1), ev('buy', 2), ev('buy', 3)], MAX_MARKET_PER_HOUR - 1, NOW).messages).toHaveLength(1);
  });
  it('puts liquidity first, then buys, then launches, and groups many launches on one network', () => {
    const launches = [1, 2, 3, 4, 5].map((i) => ev('launch', i));
    const p = planMarket([...launches, ev('buy', 9), ev('liquidity', 8)], 0, NOW);
    expect(p.messages.map((m) => m.kind)).toEqual(['liquidity', 'buy', 'launch']);
    expect(p.messages[2]!.title).toBe('5 new launches on Solana');
    expect(p.handled.filter((h) => h.msg)).toHaveLength(3);
  });
  it('sends a few launches one by one', () => {
    const p = planMarket([ev('launch', 1), ev('launch', 2, 'base')], 0, NOW);
    expect(p.messages.map((m) => m.title)).toEqual(['New on Solana: T1', 'New on Base: T2']);
  });
});
