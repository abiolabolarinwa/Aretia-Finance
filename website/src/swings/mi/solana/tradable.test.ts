import { beforeEach, describe, expect, it } from 'vitest';
import { readList, SOLANA_READ, type ListQuery, type PoolRecord, type Reader } from '../marketList';
import { isBuyable, jupiterCheck, resetTradableMemory, TRADABLE_MIN_LIQUIDITY_USD, type Tradable } from './tradable';

const NOW = 1_800_000_000_000;
const SOL = 'So11111111111111111111111111111111111111112';
const mint = (i: number): string => `Mint${String(i).padStart(4, '0')}`.padEnd(44, 'x');
const t = (over: Partial<Tradable> = {}): Tradable => ({ liquidityUsd: 50_000, suspicious: false, freezeOff: true, holders: 500, ...over });

describe('what counts as buyable', () => {
  it('needs real liquidity, no suspicion flag, and no freeze authority', () => {
    expect(isBuyable(t())).toBe(true);
    expect(isBuyable(t({ liquidityUsd: TRADABLE_MIN_LIQUIDITY_USD }))).toBe(true);
    expect(isBuyable(t({ liquidityUsd: TRADABLE_MIN_LIQUIDITY_USD - 1 }))).toBe(false); // a drained pool
    expect(isBuyable(t({ suspicious: true }))).toBe(false);
    expect(isBuyable(t({ freezeOff: false }))).toBe(false); // can be bought, cannot be sold
    expect(isBuyable(t({ freezeOff: null }))).toBe(true); // not said: not held against it
    expect(isBuyable(null)).toBe(false); // Jupiter cannot route it
    expect(isBuyable(undefined)).toBe(false);
  });
});

/** A Jupiter that knows the given mints and counts its requests. */
function jupiter(known: Record<string, unknown>) {
  const urls: string[] = [];
  const impl = (async (url: string) => {
    urls.push(url);
    const ids = decodeURIComponent(url.split('query=')[1]!).split(',');
    return new Response(JSON.stringify(ids.filter((id) => known[id]).map((id) => known[id])), { status: 200 });
  }) as unknown as typeof fetch;
  return { impl, urls };
}
const entry = (id: string, liquidity: number, audit: Record<string, unknown> = { freezeAuthorityDisabled: true }) => ({ id, liquidity, holderCount: 10, audit });

describe('the Jupiter check', () => {
  beforeEach(resetTradableMemory);

  it('reads the verdict of each mint, remembers a mint Jupiter does not know, and asks again only after ten minutes', async () => {
    const { impl, urls } = jupiter({ [mint(1)]: entry(mint(1), 80_000), [mint(2)]: entry(mint(2), 0.04, { isSus: true, freezeAuthorityDisabled: true }) });
    const check = jupiterCheck(impl, () => NOW);
    const a = (await check([mint(1), mint(2), mint(3)]))!;
    expect(isBuyable(a.get(mint(1)))).toBe(true);
    expect(isBuyable(a.get(mint(2)))).toBe(false);
    expect(a.get(mint(3))).toBeNull();
    await check([mint(1), mint(2), mint(3)]);
    expect(urls).toHaveLength(1); // the second look is from memory
    await jupiterCheck(impl, () => NOW + 11 * 60_000)([mint(1)]);
    expect(urls).toHaveLength(2);
  });

  it('asks in batches of a hundred', async () => {
    const { impl, urls } = jupiter({});
    await jupiterCheck(impl, () => NOW)(Array.from({ length: 250 }, (_, i) => mint(i)));
    expect(urls).toHaveLength(3);
  });

  it('uses the keyed service, with the key in a header and never in the address, only when a key is set', async () => {
    const seen: { url: string; key: string | null }[] = [];
    const impl = (async (url: string, init?: RequestInit) => {
      seen.push({ url, key: new Headers(init?.headers).get('x-api-key') });
      return new Response('[]', { status: 200 });
    }) as unknown as typeof fetch;
    await jupiterCheck(impl, () => NOW)([mint(1)]);
    await jupiterCheck(impl, () => NOW, undefined, 'secret-key')([mint(2)]);
    expect(seen[0]!.url).toContain('lite-api.jup.ag');
    expect(seen[0]!.key).toBeNull();
    expect(seen[1]!.url).toContain('https://api.jup.ag/');
    expect(seen[1]!.url).not.toContain('secret-key');
    expect(seen[1]!.key).toBe('secret-key');
  });

  it('uses what it learned earlier, up to six hours old, when Jupiter refuses', async () => {
    const { impl } = jupiter({ [mint(1)]: entry(mint(1), 80_000) });
    await jupiterCheck(impl, () => NOW)([mint(1)]);
    const refuse = (async () => new Response('slow down', { status: 429 })) as unknown as typeof fetch;
    const later = (await jupiterCheck(refuse, () => NOW + 30 * 60_000)([mint(1), mint(2)]))!; // mint 2 was never learned
    expect(isBuyable(later.get(mint(1)))).toBe(true);
    expect(later.has(mint(2))).toBe(false); // not checked, so not listed
    expect(await jupiterCheck(refuse, () => NOW + 7 * 3_600_000)([mint(1)])).toBeNull(); // too old to trust
  });

  it('answers null, and stops asking for a minute, when Jupiter cannot be reached', async () => {
    let calls = 0;
    const down = (async () => {
      calls++;
      return new Response('no', { status: 503 });
    }) as unknown as typeof fetch;
    expect(await jupiterCheck(down, () => NOW)([mint(1)])).toBeNull();
    expect(await jupiterCheck(down, () => NOW + 5_000)([mint(2)])).toBeNull();
    expect(calls).toBe(1);
    expect(await jupiterCheck(down, () => NOW + 61_000)([mint(3)])).toBeNull();
    expect(calls).toBe(2);
  });
});

const q = (over: Partial<ListQuery> = {}): ListQuery => ({ kind: 'liquidity', chain: 'solana', window: 'h24', sort: 'rank', dir: 'desc', page: 1, size: 50, minLiquidityUsd: 1000, maxAgeHours: 0, ...over });
const rec = (i: number): PoolRecord => ({
  key: `solana:Pool${i}`,
  chain: 'solana',
  address: `Pool${i}`,
  adapter_id: 'meteora-damm-v2-solana',
  dex: 'meteora',
  base: mint(i),
  quote: SOL,
  base_decimals: 6,
  created_at: NOW - 3_600_000,
  liquidity_usd: 1_000_000 - i,
  vol24_usd: 5_000 - i,
  p_usd: 0.01,
  chg: { m5: 1, h1: 2, h6: 3, h24: 4 },
  buys: { m5: 1, h1: 5, h6: 20, h24: 60 },
  sells: { m5: 1, h1: 4, h6: 18, h24: 50 },
  vol: { m5: 10, h1: 100, h6: 500, h24: 5_000 - i },
  ro: false,
});
function reader(records: PoolRecord[], symbols: Record<string, string> = {}): Reader {
  return {
    async get(path) {
      if (path.startsWith('mi_tokens')) {
        const keys = [...path.matchAll(/"([^"]+)"/g)].map((m) => m[1]!);
        return { rows: keys.map((key) => ({ key, symbol: symbols[key.replace('solana:', '')] ?? `T${key.slice(7, 15)}`, name: 'n', decimals: 6 })), total: null };
      }
      return { rows: records, total: records.length };
    },
  };
}

describe('Solana lists: only what can be bought now', () => {
  beforeEach(resetTradableMemory);

  it('drops pools Jupiter does not know, has flagged, has no liquidity for, or whose issuer can freeze, and says so', async () => {
    const records = [0, 1, 2, 3, 4].map(rec);
    const { impl } = jupiter({
      [mint(0)]: entry(mint(0), 90_000), // good
      [mint(1)]: entry(mint(1), 3_500_000), // fine, but see below: not asked for twice
      [mint(2)]: entry(mint(2), 0.09), // drained
      [mint(3)]: entry(mint(3), 400_000, { isSus: true }), // flagged
      // mint 4 unknown to Jupiter
    });
    const a = await readList(reader(records), q(), NOW, jupiterCheck(impl, () => NOW));
    expect(a.rows.map((r) => r.address)).toEqual([mint(0), mint(1)]);
    expect(a.total).toBe(2);
    expect(a.note).toContain('Jupiter can swap now');
    expect(a.note).toContain('2 of the 5 pools checked');
  });

  it('shows one row per symbol, the best-ranked', async () => {
    const records = [0, 1, 2].map(rec);
    const { impl } = jupiter({ [mint(0)]: entry(mint(0), 5_000), [mint(1)]: entry(mint(1), 90_000), [mint(2)]: entry(mint(2), 90_000) });
    const a = await readList(reader(records, { [mint(0)]: 'ANT', [mint(1)]: 'ant', [mint(2)]: 'BONK' }), q(), NOW, jupiterCheck(impl, () => NOW));
    expect(a.rows.map((r) => r.address)).toEqual([mint(0), mint(2)]);
  });

  it('pages from what passes', async () => {
    const records = Array.from({ length: 12 }, (_, i) => rec(i));
    const known: Record<string, unknown> = {};
    for (let i = 0; i < 12; i++) known[mint(i)] = entry(mint(i), 10_000);
    const { impl } = jupiter(known);
    const check = jupiterCheck(impl, () => NOW);
    const first = await readList(reader(records), q({ size: 5 }), NOW, check);
    const third = await readList(reader(records), q({ size: 5, page: 3 }), NOW, check);
    expect(first.rows).toHaveLength(5);
    expect(first.pages).toBe(3);
    expect(third.rows).toHaveLength(2);
  });

  it('shows the list as it was, never an empty one, when Jupiter cannot be reached', async () => {
    const records = [0, 1, 2].map(rec);
    const down = (async () => new Response('no', { status: 500 })) as unknown as typeof fetch;
    const a = await readList(reader(records), q(), NOW, jupiterCheck(down, () => NOW));
    expect(a.rows).toHaveLength(3);
    expect(a.note).not.toContain('Jupiter');
  });

  it('leaves every other network alone, and the old behaviour when no check is given', async () => {
    const records = [0, 1].map((i) => ({ ...rec(i), key: `bnb:0x${i}`, chain: 'bnb' as const, address: `0x${i}`, base: `0x${'a'.repeat(39)}${i}`, quote: '0x' + 'b'.repeat(40) }));
    let asked = 0;
    const check = async () => {
      asked++;
      return new Map<string, Tradable | null>();
    };
    expect((await readList(reader(records), q({ chain: 'bnb' }), NOW, check)).rows.length).toBe(2);
    expect(asked).toBe(0);
    expect((await readList(reader([0, 1].map(rec)), q(), NOW)).rows.length).toBe(2);
  });
});

describe('Solana lists: a window of repeats', () => {
  beforeEach(resetTradableMemory);

  it('looks at a wide window of pools, and at only the best three of a symbol, so repeats do not fill the list', async () => {
    // 40 pools of one ticker, then 20 other tickers, in the database's order.
    const records = [...Array.from({ length: 40 }, (_, i) => rec(i)), ...Array.from({ length: 20 }, (_, i) => rec(100 + i))];
    const symbols: Record<string, string> = {};
    for (let i = 0; i < 40; i++) symbols[mint(i)] = 'UODF';
    const known: Record<string, unknown> = {};
    for (const r of records) known[r.base] = entry(r.base, 50_000);
    const { impl, urls } = jupiter(known);
    const paths: string[] = [];
    const rd = reader(records, symbols);
    const spy: Reader = { get: async (path, count) => (paths.push(path), rd.get(path, count)) };
    const a = await readList(spy, q(), NOW, jupiterCheck(impl, () => NOW));
    expect(paths.find((p) => p.startsWith('mi_pools'))).toContain(`limit=${SOLANA_READ}`);
    expect(a.rows.filter((r) => symbols[r.address] === 'UODF')).toHaveLength(1); // one row for the ticker
    expect(a.rows).toHaveLength(21); // and every other ticker
    expect(urls.join(' ').match(/Mint0/g)!.length).toBeLessThanOrEqual(23); // 3 UODF + 20 others were asked about, not 60
  });

  it('a drained first pool of a symbol does not hide a good second one', async () => {
    const records = [0, 1, 2].map(rec);
    const symbols = { [mint(0)]: 'AAA', [mint(1)]: 'AAA', [mint(2)]: 'AAA' };
    const { impl } = jupiter({ [mint(0)]: entry(mint(0), 0.05), [mint(1)]: entry(mint(1), 80_000), [mint(2)]: entry(mint(2), 90_000) });
    const a = await readList(reader(records, symbols), q(), NOW, jupiterCheck(impl, () => NOW));
    expect(a.rows.map((r) => r.address)).toEqual([mint(1)]);
  });

  it('asks about at most 300 pools however many distinct symbols there are', async () => {
    const records = Array.from({ length: 450 }, (_, i) => rec(i));
    const known: Record<string, unknown> = {};
    for (const r of records) known[r.base] = entry(r.base, 50_000);
    const { impl, urls } = jupiter(known);
    const a = await readList(reader(records), q({ size: 100 }), NOW, jupiterCheck(impl, () => NOW));
    expect(urls).toHaveLength(3); // three requests of a hundred
    expect(a.total).toBe(300);
  });
});
