import { describe, expect, it } from 'vitest';
import { poolFromRow, SupabaseMiStore } from './supabaseStore.js';
import { InMemoryMiStore, decodeCursor, encodeCursor } from './store.js';
import type { MiPool, MiToken, MiTrade } from './types.js';

const pool = (i: number, over: Partial<MiPool> = {}): MiPool => ({
  key: `bnb:0x${i.toString(16).padStart(40, '0')}`,
  chain: 'bnb',
  address: `0x${i.toString(16).padStart(40, '0')}`,
  adapterId: 'a1',
  dex: 'pancakeswap',
  kind: 'v2',
  feeTier: null,
  base: `0x${(1000 + i).toString(16).padStart(40, '0')}`,
  quote: '0xbb4cdb9cbd36b01bd1cbaebf2de08d9173bc095c',
  baseDecimals: 18,
  quoteDecimals: 18,
  baseIsToken0: true,
  baseVault: null,
  quoteVault: null,
  tickSpacing: null,
  hooks: null,
  historyBlock: null,
  historyDone: true,
  createdBlock: i,
  createdTx: '0xtx',
  createdAt: 1_000_000 + i * 1000,
  state: 'active',
  stateReason: '',
  stateAt: 1,
  reserveBase: '1',
  reserveQuote: '1',
  reserveBlock: null,
  firstTradeAt: null,
  lastTradeAt: null,
  paused: false,
  stats: null,
  ...over,
});
const token = (p: MiPool, symbol: string): MiToken => ({ key: `bnb:${p.base}`, chain: 'bnb', address: p.base, symbol, name: symbol + ' coin', decimals: 18, firstSeenAt: 1, firstTradeAt: null, launchboxKey: null });

describe('in-memory store contract', () => {
  it('inserts a pool once and leaves an existing one untouched', async () => {
    const s = new InMemoryMiStore();
    expect(await s.insertPool(pool(1))).toBe(true);
    expect(await s.insertPool(pool(1, { state: 'unsupported' }))).toBe(false);
    expect((await s.getPools([pool(1).key])).get(pool(1).key)!.state).toBe('active');
  });

  it('upserts a token without duplicating, keeping the earliest sighting and filling unknowns', async () => {
    const s = new InMemoryMiStore();
    const t = token(pool(1), 'AAA');
    expect(await s.upsertToken({ ...t, firstSeenAt: 500, symbol: '', launchboxKey: null })).toBe(true);
    expect(await s.upsertToken({ ...t, firstSeenAt: 100, launchboxKey: 'bnb:x' })).toBe(false);
    const got = (await s.getTokens([t.key])).get(t.key)!;
    expect([got.firstSeenAt, got.symbol, got.launchboxKey]).toEqual([100, 'AAA', 'bnb:x']);
    expect(s.tokens.size).toBe(1);
  });

  it('pages newest-first with a stable cursor and no repeats', async () => {
    const s = new InMemoryMiStore();
    for (let i = 1; i <= 25; i++) await s.insertPool(pool(i));
    const seen: string[] = [];
    let cursor: string | null = null;
    for (let page = 0; page < 10; page++) {
      const r = await s.listPools({ sort: 'newest', limit: 10, cursor, states: ['active'] });
      seen.push(...r.pools.map((p) => p.address));
      cursor = r.nextCursor;
      if (!cursor) break;
    }
    expect(seen).toHaveLength(25);
    expect(new Set(seen).size).toBe(25);
    expect(seen[0]).toBe(pool(25).address);
    expect(seen[24]).toBe(pool(1).address);
  });

  it('filters by chain, state, text, token and age', async () => {
    const s = new InMemoryMiStore();
    const a = pool(1);
    const b = pool(2, { state: 'awaiting_liquidity' });
    const c = pool(3, { chain: 'base', key: 'base:0x3', address: '0x3' });
    for (const p of [a, b, c]) await s.insertPool(p);
    await s.upsertToken(token(a, 'DOGE'));
    expect((await s.listPools({ sort: 'newest', limit: 10, states: ['active'], chain: 'bnb' })).pools).toHaveLength(1);
    expect((await s.listPools({ sort: 'newest', limit: 10, text: 'doge' })).pools.map((p) => p.address)).toEqual([a.address]);
    expect((await s.listPools({ sort: 'newest', limit: 10, tokenKey: `bnb:${a.base}` })).pools).toHaveLength(1);
    expect((await s.listPools({ sort: 'newest', limit: 10, createdAfter: b.createdAt })).pools).toHaveLength(2);
  });

  it('answers trade queries and ignores duplicates', async () => {
    const s = new InMemoryMiStore();
    const t = (id: string, time: number): MiTrade => ({ chain: 'bnb', pool: '0xp', id, block: time, blockHash: '0x', time, side: 'buy', baseAmount: '1', quoteAmount: '1', price: '1', maker: 'm' });
    expect(await s.putTrades('a1', [t('1', 10), t('2', 20), t('3', 30)])).toBe(3);
    expect(await s.putTrades('a1', [t('2', 20), t('4', 40)])).toBe(1);
    expect((await s.recentTrades('bnb', '0xp', 2)).map((x) => x.id)).toEqual(['4', '3']);
    expect((await s.tradesSince('bnb', '0xp', 20, 10)).map((x) => x.id)).toEqual(['2', '3', '4']);
    expect((await s.lastTradeBefore('bnb', '0xp', 25))!.id).toBe('2');
    expect(await s.deleteTradesFrom('a1', 30)).toBe(2);
  });

  it('cursors survive only if well formed', () => {
    expect(decodeCursor(encodeCursor([5, 'x']))).toEqual([5, 'x']);
    expect(decodeCursor('not base64 json !!')).toBeNull();
    expect(decodeCursor(Buffer.from('{"a":1}').toString('base64url'))).toBeNull();
  });
});

describe('Supabase store request shapes', () => {
  function stub(responses: Record<string, unknown> = {}) {
    const calls: { url: string; method: string; headers: Record<string, string>; body: unknown }[] = [];
    const fetchImpl = (async (url: string, init: RequestInit = {}) => {
      calls.push({ url: url.replace('https://x.supabase.co/rest/v1/', ''), method: init.method ?? 'GET', headers: (init.headers ?? {}) as Record<string, string>, body: init.body ? JSON.parse(String(init.body)) : undefined });
      const hit = Object.entries(responses).find(([k]) => url.includes(k));
      return new Response(hit ? JSON.stringify(hit[1]) : '[]', { status: 200 });
    }) as unknown as typeof fetch;
    return { calls, store: new SupabaseMiStore('https://x.supabase.co', 'sb_secret_test', fetchImpl, () => 42) };
  }

  it('inserts a pool with ignore-duplicates and reports whether it was new', async () => {
    const { calls, store } = stub({ 'mi_pools?on_conflict=key': [{ key: 'k' }] });
    expect(await store.insertPool(pool(1))).toBe(true);
    expect(calls[0]!.method).toBe('POST');
    expect(calls[0]!.headers.prefer).toBe('resolution=ignore-duplicates,return=representation');
    expect(calls[0]!.headers.apikey).toBe('sb_secret_test');
    const row = (calls[0]!.body as Record<string, unknown>[])[0]!;
    expect(row).toMatchObject({ key: pool(1).key, adapter_id: 'a1', created_block: 1, base_is_token0: true, state: 'active' });
    const none = stub({ 'mi_pools?on_conflict=key': [] });
    expect(await none.store.insertPool(pool(1))).toBe(false);
  });

  it('writes trades idempotently on (chain,pool,id) and counts only the new ones', async () => {
    const { calls, store } = stub({ 'mi_trades': [{ id: 'a' }] });
    const t: MiTrade = { chain: 'bnb', pool: '0xp', id: 'a', block: 5, blockHash: '0xh', time: 9, side: 'sell', baseAmount: '123456789012345678901234567890', quoteAmount: '2', price: '0.1', maker: '0xm' };
    expect(await store.putTrades('a1', [t, { ...t, id: 'b' }])).toBe(1);
    expect(calls[0]!.url).toBe('mi_trades?on_conflict=chain,pool,id');
    expect((calls[0]!.body as Record<string, unknown>[])[0]).toMatchObject({ adapter_id: 'a1', base_amount: '123456789012345678901234567890' });
  });

  it('moves the checkpoint with an upsert, and reads the control and audit tables', async () => {
    const { calls, store } = stub({ 'mi_controls': [{ adapter_id: 'x', reason: 'r', at: 3 }] });
    await store.setCheckpoint({ adapterId: 'a1', block: 77, blockHash: '0xh', updatedAt: 1 });
    expect(calls[0]!.url).toBe('mi_checkpoints?on_conflict=adapter_id');
    expect(calls[0]!.headers.prefer).toContain('merge-duplicates');
    expect([...(await store.disabledAdapters()).keys()]).toEqual(['x']);
  });

  it('keyset-pages the newest list and turns a stored row back into a pool', async () => {
    const rows = Array.from({ length: 3 }, (_, i) => ({ key: `bnb:0x${i}`, chain: 'bnb', address: `0x${i}`, adapter_id: 'a1', dex: 'pancakeswap', kind: 'v2', base: 'b', quote: 'q', base_decimals: 18, quote_decimals: 18, base_is_token0: true, created_block: 5 - i, created_tx: 't', created_at: 100 - i, state: 'active', state_at: 1 }));
    const { calls, store } = stub({ 'mi_pools?': rows });
    const page = await store.listPools({ sort: 'newest', limit: 2, states: ['active'], chain: 'bnb' });
    expect(page.pools).toHaveLength(2);
    expect(page.nextCursor).not.toBeNull();
    expect(calls[0]!.url).toContain('chain=eq.bnb');
    expect(calls[0]!.url).toContain('state=in.("active")');
    expect(calls[0]!.url).toContain('order=created_at.desc.nullslast,key.desc&limit=3');
    await store.listPools({ sort: 'newest', limit: 2, cursor: page.nextCursor });
    expect(calls[1]!.url).toContain('or=(created_at.lt.99,and(created_at.eq.99,key.lt."bnb:0x1"))');
    expect(poolFromRow(rows[0]!).createdBlock).toBe(5);
  });

  it('filters the trades of a pool with unquoted values (PostgREST reads quote marks after eq. literally and would match nothing)', async () => {
    const { calls, store } = stub();
    const pool = '0x' + 'c3'.repeat(20);
    await store.tradesSince('bnb', pool, 100, 10);
    await store.recentTrades('bnb', pool, 5);
    await store.lastTradeBefore('bnb', pool, 100);
    for (const c of calls) {
      expect(c.url).toContain(`pool=eq.${pool}&`);
      expect(c.url).not.toContain(`eq."`);
    }
  });

  it('rejects a table that does not exist with a clear error', async () => {
    const fetchImpl = (async () => new Response('{"code":"PGRST205","message":"schema cache"}', { status: 404 })) as unknown as typeof fetch;
    await expect(new SupabaseMiStore('https://x.supabase.co', 'k', fetchImpl).getCheckpoint('a')).rejects.toThrow(/0017/);
  });

  it('strips characters that could change a filter from user text', async () => {
    const { calls, store } = stub();
    await store.searchTokens('a,b)or=(x', 5);
    expect(calls[0]!.url).toBe('mi_tokens?or=(symbol.ilike.*aborx*,name.ilike.*aborx*)&select=*&limit=5');
  });
});
