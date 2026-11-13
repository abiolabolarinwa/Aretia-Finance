import { describe, expect, it } from 'vitest';
import { fdvOf, resetSupplyColumnMemory, candidatePath, dedupeTokens, listNote, postgrestReader, readList, rowFromRecord, sqlPath, usesCandidates, type ListQuery, type PoolRecord, type Reader } from './marketList';
import { sourceLabel } from '../market/types';
import { parseListQuery } from '../../../api/_swingsMarketIndex';

const NOW = 1_700_000_000_000;
const CAKE = '0x0e09fabb73bd3ade0a17ecc321fd13a19e81ce82';
const WBNB = '0xbb4cdb9cbd36b01bd1cbaebf2de08d9173bc095c';
const hex = (n: number): string => `0x${n.toString(16).padStart(40, '0')}`;

const q = (over: Partial<ListQuery> = {}): ListQuery => ({ kind: 'top', chain: 'bnb', window: 'h24', sort: 'rank', dir: 'desc', page: 1, size: 50, minLiquidityUsd: 1000, maxAgeHours: 0, ...over });
const rec = (i: number, over: Partial<PoolRecord> = {}): PoolRecord => ({
  key: `bnb:${hex(1000 + i)}`,
  chain: 'bnb',
  address: hex(1000 + i),
  adapter_id: 'pancakeswap-v2-bnb',
  dex: 'pancakeswap',
  base: hex(i),
  quote: WBNB,
  base_decimals: 18,
  created_at: NOW - 3_600_000,
  liquidity_usd: 5000 + i,
  vol24_usd: 10_000 - i,
  p_usd: 1.5,
  chg: { m5: 100, h1: 250, h6: 400, h24: 1000 },
  buys: { m5: 1, h1: 5, h6: 20, h24: 60 },
  sells: { m5: 1, h1: 4, h6: 18, h24: 50 },
  vol: { m5: 100, h1: 1000, h6: 5000, h24: 10_000 - i },
  ro: false,
  ...over,
});

/** A reader that answers the pool query with the given records and every token query with names built from the address. */
function fake(records: PoolRecord[], total: number | null = records.length): { reader: Reader; paths: string[] } {
  const paths: string[] = [];
  const reader: Reader = {
    async get(path) {
      paths.push(path);
      if (path.startsWith('mi_tokens')) {
        const keys = [...path.matchAll(/"([^"]+)"/g)].map((m) => m[1]!);
        return { rows: keys.map((key) => ({ key, symbol: key.endsWith(WBNB) ? 'WBNB' : `T${key.slice(-4)}`, name: `Token ${key.slice(-4)}`, decimals: 18 })), total: null };
      }
      return { rows: records, total };
    },
  };
  return { reader, paths };
}

describe('the plausibility ceiling on liquidity', () => {
  it('is asked of the database in every list, so no pool of an estimate gone wrong is listed', () => {
    for (const kind of ['top', 'liquidity', 'new', 'gainers'] as const) {
      expect(sqlPath(q({ kind }), NOW)).toContain('liquidity_usd=lte.100000000');
      expect(candidatePath(q({ kind }), NOW)).toContain('liquidity_usd=lte.100000000');
    }
  });
});

describe('paths', () => {
  it('reads narrow columns, never the whole row, and filters in the database', () => {
    const p = sqlPath(q(), NOW);
    expect(p).not.toContain('select=*');
    expect(p).toContain('stats->priceUsd');
    expect(p).not.toMatch(/select=[^&]*(^|,)stats(,|&)/);
    expect(p).toContain('chain=eq.bnb');
    expect(p).toContain('liquidity_usd=gte.1000');
    expect(p).toContain('vol24_usd=gt.0');
    expect(p).toContain('order=vol24_usd.desc.nullslast,key.desc');
    expect(p).toContain('limit=50&offset=0');
  });
  it('pages by offset and applies the dust floor when the minimum is zero', () => {
    const p = sqlPath(q({ page: 3, size: 100, minLiquidityUsd: 0 }), NOW);
    expect(p).toContain('limit=100&offset=200');
    expect(p).toContain('liquidity_usd=gte.50');
  });
  it('New and By liquidity do not need trades and use their own order', () => {
    expect(sqlPath(q({ kind: 'new' }), NOW)).not.toContain('vol24_usd=gt.0');
    expect(sqlPath(q({ kind: 'new' }), NOW)).toContain('order=created_at.desc');
    expect(sqlPath(q({ kind: 'liquidity' }), NOW)).toContain('order=liquidity_usd.desc');
  });
  it('ranked lists hold only pools that traded in the last 24 hours', () => {
    expect(sqlPath(q({ kind: 'trending' }), NOW)).toContain(`last_trade_at=gte.${NOW - 86_400_000}`);
    expect(candidatePath(q({ kind: 'gainers' }), NOW)).toContain(`last_trade_at=gte.${NOW - 86_400_000}`);
    expect(sqlPath(q({ kind: 'new' }), NOW)).not.toContain('last_trade_at=gte');
  });
  it('an age limit becomes a created_at bound', () => {
    expect(sqlPath(q({ kind: 'new', maxAgeHours: 24 }), NOW)).toContain(`created_at=gte.${NOW - 86_400_000}`);
  });
  it('windowed lists use candidates', () => {
    expect(usesCandidates(q({ kind: 'gainers' }))).toBe(true);
    expect(usesCandidates(q({ kind: 'trending', window: 'h1' }))).toBe(true);
    expect(usesCandidates(q({ kind: 'trending', window: 'h24' }))).toBe(false);
    expect(usesCandidates(q({ kind: 'new', sort: 'change' }))).toBe(true);
    expect(candidatePath(q({ kind: 'gainers' }), NOW)).toContain('limit=600');
  });
});

describe('rowFromRecord', () => {
  const tokens = new Map([[`bnb:${hex(1)}`, { symbol: 'PEPE', name: 'Pepe', decimals: 18 }], [`bnb:${WBNB}`, { symbol: 'WBNB', name: 'Wrapped BNB', decimals: 18 }]]);
  it('maps a traded pool, changes from basis points to percent, and labels the source', () => {
    const r = rowFromRecord(rec(1), tokens, NOW)!;
    expect(r.symbol).toBe('PEPE');
    expect(r.quoteSymbol).toBe('WBNB');
    expect(r.change.h24).toBe(10);
    expect(r.txns24h).toBe(110);
    expect(r.liquidityUsd).toBe(5001);
    expect(r.ageMs).toBe(3_600_000);
    expect(r.source).toBe('index');
    expect(sourceLabel(r)).toBe('Aretia index');
    expect(r.venue).toBe('PancakeSwap V2');
  });
  it('a window that closed after the last trade is empty, whatever the stored figures say', () => {
    // Stored figures from when the pool last traded: 110 trades and a 10% change. It last traded 7 hours ago.
    const r = rowFromRecord(rec(1, { last_trade_at: NOW - 7 * 3_600_000 }), tokens, NOW)!;
    expect(r.txns?.m5).toBe(0);
    expect(r.txns?.h1).toBe(0);
    expect(r.txns?.h6).toBe(0);
    expect(r.txns?.h24).toBe(110);
    expect(r.change.h6).toBeNull();
    expect(r.change.h24).toBe(10);
    expect(r.volumeUsd?.h1).toBe(0);
    const dead = rowFromRecord(rec(1, { last_trade_at: NOW - 4 * 86_400_000 }), tokens, NOW)!;
    expect(dead.txns24h).toBe(0);
    expect(dead.volume24hUsd).toBe(0);
    expect(dead.change.h24).toBeNull();
    expect(dead.traders24h).toBeNull();
  });
  it('a pool with liquidity only has dashes (null), never zero', () => {
    const r = rowFromRecord(rec(1, { ro: true, vol24_usd: null, p_usd: null, chg: { m5: null, h1: null, h6: null, h24: null }, buys: { m5: 0, h1: 0, h6: 0, h24: 0 }, sells: { m5: 0, h1: 0, h6: 0, h24: 0 }, vol: null }), tokens, NOW)!;
    expect(r.priceUsd).toBeNull();
    expect(r.volume24hUsd).toBeNull();
    expect(r.txns24h).toBeNull();
    expect(r.change).toEqual({ m5: null, h1: null, h6: null, h24: null });
    expect(r.volumeUsd?.h1).toBeNull();
    expect(r.liquidityUsd).toBe(5001);
  });
  it('a pool with no stats document at all is also all dashes', () => {
    const r = rowFromRecord(rec(1, { p_usd: null, chg: null, buys: null, sells: null, vol: null, ro: null }), tokens, NOW)!;
    expect(r.priceUsd).toBeNull();
    expect(r.txns24h).toBeNull();
    expect(r.change.h24).toBeNull();
  });
  it('a token the index has not named still gets a short address as its symbol', () => {
    const r = rowFromRecord(rec(7), new Map(), NOW)!;
    expect(r.symbol).toBe(hex(7).slice(0, 6));
  });
  it('rejects an unknown chain', () => {
    expect(rowFromRecord(rec(1, { chain: 'nope' }), tokens, NOW)).toBeNull();
  });
  it('an unlabelled row is the outside feed', () => {
    expect(sourceLabel({})).toBe('GeckoTerminal');
  });
});

describe('readList: SQL paging', () => {
  it('returns the page, the database total and the page count', async () => {
    const { reader } = fake(Array.from({ length: 50 }, (_, i) => rec(i + 1)), 22_400);
    const a = await readList(reader, q(), NOW);
    expect(a.rows).toHaveLength(50);
    expect(a.total).toBe(22_400);
    expect(a.pages).toBe(448);
    expect(a.rows[0]!.source).toBe('index');
    expect(a.rankedAmong).toBeUndefined();
  });
  it('drops dead, no-sell and repeated-token pools from the page', async () => {
    const dead = rec(1, { chg: { m5: -9990, h1: -9990, h6: -9990, h24: -9990 } });
    const honey = rec(2, { buys: { m5: 5, h1: 20, h6: 30, h24: 40 }, sells: { m5: 0, h1: 0, h6: 0, h24: 0 } });
    const twin = rec(3, { key: `bnb:${hex(9000)}`, address: hex(9000), base: hex(4) });
    const a = await readList(fake([dead, honey, rec(3), rec(4), twin]).reader, q(), NOW);
    expect(a.rows.map((r) => r.address)).toEqual([hex(3), hex(4)]);
  });
  it('a reserves-only pool in New is not mistaken for a no-sell token', async () => {
    const lonely = rec(5, { ro: true, buys: { m5: 0, h1: 0, h6: 0, h24: 99 }, sells: { m5: 0, h1: 0, h6: 0, h24: 0 }, vol24_usd: null });
    const a = await readList(fake([lonely]).reader, q({ kind: 'new' }), NOW);
    expect(a.rows).toHaveLength(1);
    expect(a.rows[0]!.volume24hUsd).toBeNull();
  });
  it('asks for tokens in batches of 50', async () => {
    const { reader, paths } = fake(Array.from({ length: 50 }, (_, i) => rec(i + 1)));
    await readList(reader, q(), NOW);
    expect(paths.filter((p) => p.startsWith('mi_tokens')).length).toBeGreaterThanOrEqual(2);
    expect(paths.some((p) => p.includes('select=*'))).toBe(false);
  });
});

describe('readList: candidate ranking', () => {
  it('gainers: only gains in the window, biggest first, with floors, paged from the ranked set', async () => {
    const list = [
      rec(1, { chg: { m5: 10, h1: 500, h6: 0, h24: 0 } }),
      rec(2, { chg: { m5: 10, h1: 900, h6: 0, h24: 0 } }),
      rec(3, { chg: { m5: 10, h1: -100, h6: 0, h24: 0 } }),
      rec(4, { chg: { m5: 10, h1: 700, h6: 0, h24: 0 }, liquidity_usd: 900 }),
      rec(5, { chg: { m5: 10, h1: 300, h6: 0, h24: 0 }, created_at: NOW - 60_000 }),
      rec(6, { chg: null, p_usd: null }),
    ];
    const a = await readList(fake(list).reader, q({ kind: 'gainers', window: 'h1', size: 50 }), NOW);
    expect(a.rows.map((r) => r.address)).toEqual([hex(2), hex(1)]);
    expect(a.total).toBe(2);
    expect(a.rankedAmong).toBe(6);
    const second = await readList(fake(list).reader, q({ kind: 'gainers', window: 'h1', size: 50, page: 2 }), NOW);
    expect(second.rows).toEqual([]);
    expect(second.total).toBe(2);
  });
  it('trending in a short window ranks by that window’s volume and skips pools with none', async () => {
    const list = [rec(1, { vol: { m5: 5, h1: 100, h6: 0, h24: 9 } }), rec(2, { vol: { m5: 5, h1: 900, h6: 0, h24: 9 } }), rec(3, { vol: { m5: 5, h1: 0, h6: 0, h24: 9 } }), rec(4, { vol: null, ro: true })];
    const a = await readList(fake(list).reader, q({ kind: 'trending', window: 'h1' }), NOW);
    expect(a.rows.map((r) => r.address)).toEqual([hex(2), hex(1)]);
  });
  it('keeps one row per token, the best pool', async () => {
    const list = [rec(1, { vol: { m5: 0, h1: 900, h6: 0, h24: 9 } }), rec(2, { key: 'bnb:x', address: hex(777), base: hex(1), vol: { m5: 0, h1: 50, h6: 0, h24: 9 } })];
    const a = await readList(fake(list).reader, q({ kind: 'trending', window: 'h1' }), NOW);
    expect(a.rows.map((r) => r.pool)).toEqual([hex(1001)]);
  });
  it('pools without a number to rank by go last when sorted by change', async () => {
    const list = [rec(1, { chg: null, p_usd: null }), rec(2, { chg: { m5: 0, h1: 0, h6: 0, h24: 300 } }), rec(3, { chg: { m5: 0, h1: 0, h6: 0, h24: 900 } })];
    const a = await readList(fake(list).reader, q({ kind: 'top', sort: 'change' }), NOW);
    expect(a.rows.map((r) => r.address)).toEqual([hex(3), hex(2), hex(1)]);
    expect(a.rows[2]!.change.h24).toBeNull();
  });
});

describe('dedupeTokens and notes', () => {
  it('keeps the first row of a token', () => {
    const a = rowFromRecord(rec(1), new Map(), NOW)!;
    const b = { ...a, pool: 'other' };
    expect(dedupeTokens([{ row: a }, { row: b }]).map((x) => x.row.pool)).toEqual([a.pool]);
  });
  it('the note says why a tab has fewer rows', () => {
    expect(listNote(q({ kind: 'top' }), 10)).toMatch(/stored trade/);
    expect(listNote(q({ kind: 'new' }), 10)).toMatch(/no trade yet/);
    expect(listNote(q({ kind: 'gainers' }), 3, 600)).toMatch(/3 of the 600/);
  });
});

describe('postgrestReader', () => {
  it('reads the total from Content-Range and fails on an error status', async () => {
    const ok = (async () => new Response('[{"a":1}]', { status: 200, headers: { 'content-range': '0-0/22400' } })) as unknown as typeof fetch;
    expect(await postgrestReader('https://data.example.org', {}, ok).get('mi_pools?x', true)).toEqual({ rows: [{ a: 1 }], total: 22_400 });
    const bad = (async () => new Response('', { status: 500 })) as unknown as typeof fetch;
    await expect(postgrestReader('https://data.example.org', {}, bad).get('mi_pools?x', true)).rejects.toThrow();
  });
});

describe('parseListQuery', () => {
  it('accepts a normal request and rejects bad ones', () => {
    expect(parseListQuery({ kind: 'new', chain: 'bnb', page: '2', size: '100', minLiq: '1000' })).toMatchObject({ kind: 'new', chain: 'bnb', page: 2, size: 100, minLiquidityUsd: 1000 });
    expect(parseListQuery({ kind: 'nope' })).toBeNull();
    expect(parseListQuery({ chain: 'dogechain' })).toBeNull();
    expect(parseListQuery({ size: '75' })).toBeNull();
    expect(parseListQuery({ page: '0' })).toBeNull();
    expect(parseListQuery({ page: '500', size: '100' })).toBeNull();
    expect(parseListQuery({ minLiq: '-5' })).toBeNull();
  });
});

void CAKE;

describe('fully diluted value and traders in a Markets row', () => {
  const tok = (supply: string | null | undefined, decimals = 18) => new Map([[`bnb:${hex(1)}`, { symbol: 'MEME', name: 'Meme', decimals, ...(supply === undefined ? {} : { total_supply: supply }) }]]);
  const E18 = 10n ** 18n;
  it('is price times total supply in whole tokens, marked as a fully diluted value', () => {
    expect(fdvOf(2, (1_000n * E18).toString(), 18)).toBe(2000);
    expect(fdvOf(0.5, '1000000', 6)).toBe(0.5);
    const r = rowFromRecord(rec(1), tok((1_000n * E18).toString()), NOW)!;
    expect(r.capUsd).toBe(1500); // price $1.5 from the record
    expect(r.capIsFdv).toBe(true);
  });
  it('is a dash when the price or the supply is unknown, or the result is not plausible', () => {
    expect(rowFromRecord(rec(1), tok(null), NOW)!.capUsd).toBeNull();
    expect(rowFromRecord(rec(1), tok(undefined), NOW)!.capUsd).toBeNull();
    expect(rowFromRecord(rec(1, { ro: true, p_usd: null, rp: null }), tok('1000'), NOW)!.capUsd).toBeNull();
    for (const bad of ['', 'abc', '-5', '1e18', '9'.repeat(79)]) expect(fdvOf(1, bad, 18), bad).toBeNull();
    expect(fdvOf(1, '0', 18)).toBeNull();
    expect(fdvOf(Number.NaN, '1000', 18)).toBeNull();
    expect(fdvOf(1, (10n ** 40n).toString(), 18)).toBeNull(); // $1e22: past the plausibility limit
  });
  it('also prices a pool with no trade from its reserve price', () => {
    const r = rowFromRecord(rec(1, { ro: true, p_usd: null, rp: 0.01, vol24_usd: null }), tok((1_000n * E18).toString()), NOW)!;
    expect(r.priceFromReserves).toBe(true);
    expect(r.capUsd).toBe(10);
  });
  it('shows the traders (distinct receiving accounts) of a traded pool, and a dash otherwise', () => {
    expect(rowFromRecord(rec(1, { mk: 37 }), tok(null), NOW)!.traders24h).toBe(37);
    expect(rowFromRecord(rec(1, { mk: null }), tok(null), NOW)!.traders24h).toBeNull();
    expect(rowFromRecord(rec(1, { ro: true, mk: 0 }), tok(null), NOW)!.traders24h).toBeNull();
  });
  it('asks for the supply, and still lists (without caps) when the database has not got the column yet', async () => {
    resetSupplyColumnMemory();
    const paths: string[] = [];
    const reader: Reader = {
      async get(path) {
        paths.push(path);
        if (path.startsWith('mi_tokens') && path.includes('total_supply')) throw new Error('The Market Indexer database answered 400.');
        if (path.startsWith('mi_tokens')) return { rows: [{ key: `bnb:${hex(1)}`, symbol: 'MEME', name: 'Meme', decimals: 18 }, { key: `bnb:${WBNB}`, symbol: 'WBNB', name: 'Wrapped BNB', decimals: 18 }], total: null };
        return { rows: [rec(1)], total: 1 };
      },
    };
    const a = await readList(reader, q({ kind: 'liquidity', sort: 'rank' }), NOW);
    expect(a.rows).toHaveLength(1);
    expect(a.rows[0]!.capUsd).toBeNull();
    expect(paths.filter((p) => p.startsWith('mi_tokens'))).toHaveLength(2); // tried with the supply, then without
    await readList(reader, q({ kind: 'liquidity', sort: 'rank' }), NOW + 1000);
    expect(paths.filter((p) => p.startsWith('mi_tokens') && p.includes('total_supply'))).toHaveLength(1); // not asked again for a while
    resetSupplyColumnMemory();
  });
});

describe('the bullish filter on the server', () => {
  const recs = [
    rec(1), // up over 1h and 24h, 110 trades, $5,001
    rec(2, { chg: { m5: 0, h1: -50, h6: 0, h24: 900 } }), // down over the hour
    rec(3, { chg: { m5: 0, h1: 100, h6: 0, h24: -200 } }), // down over the day
    rec(4, { buys: { m5: 0, h1: 0, h6: 0, h24: 2 }, sells: { m5: 0, h1: 0, h6: 0, h24: 3 } }), // 5 trades
    rec(5, { mk: 2 }), // two wallets
    rec(6, { liquidity_usd: 500 }), // thin
  ];
  const reader = (paths: string[]): Reader => ({
    async get(path) {
      paths.push(path);
      if (path.startsWith('mi_tokens')) return { rows: [...recs.map((r) => ({ key: `bnb:${r.base}`, symbol: `T${recs.indexOf(r) + 1}`, name: 'Token', decimals: 18 })), { key: `bnb:${WBNB}`, symbol: 'WBNB', name: 'Wrapped BNB', decimals: 18 }], total: null };
      return { rows: recs, total: recs.length };
    },
  });
  it('is built from the busiest pools and keeps only the rows that fit the rule, whatever the tab', async () => {
    resetSupplyColumnMemory();
    for (const kind of ['trending', 'top', 'new', 'liquidity'] as const) {
      const paths: string[] = [];
      const a = await readList(reader(paths), q({ kind, bullish: true, sort: 'rank' }), NOW);
      expect(a.rows.map((r) => r.symbol), kind).toEqual(['T1']);
      expect(a.note).toContain('Bullish only');
      expect(a.note).toContain('1 fit');
      expect(paths.some((p) => p.includes('vol24_usd=gt.0') && !p.includes('offset='))).toBe(true);
    }
  });
  it('changes nothing when it is off', async () => {
    const a = await readList(reader([]), q({ kind: 'liquidity', sort: 'rank' }), NOW);
    expect(a.rows.length).toBe(6);
    expect(a.note).not.toContain('Bullish');
  });
  it('is read from the request as bullish=1 only, and keeps its own cache entry', () => {
    expect(parseListQuery({ kind: 'top', chain: 'bnb', bullish: '1' })?.bullish).toBe(true);
    expect(parseListQuery({ kind: 'top', chain: 'bnb', bullish: '0' })?.bullish).toBeUndefined();
    expect(parseListQuery({ kind: 'top', chain: 'bnb' })?.bullish).toBeUndefined();
    expect(parseListQuery({ kind: 'top', chain: 'bnb', bullish: 'yes' })).toBeNull();
  });
});
