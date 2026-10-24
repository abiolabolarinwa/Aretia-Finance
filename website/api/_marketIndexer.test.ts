import { beforeEach, describe, expect, it } from 'vitest';
import { chainConfig } from '../src/swings/mi/chains.js';
import { specById } from '../src/swings/mi/dexes.js';
import { runAdapter } from '../src/swings/mi/engine.js';
import { DEFAULT_RULES } from '../src/swings/mi/lifecycle.js';
import { InMemoryMiStore } from '../src/swings/mi/store.js';
import { FakeChain, pairCreatedLog, v2SwapLog } from '../src/swings/mi/testkit.js';
import { resetBudgets } from './_limits.js';
import { resetRateLimit } from './_rpcProxy.js';
import { issueSession } from './_swingsAuth.js';
import { handleMi, handleMiAdmin, handleMiRun, miOhlcv, resetMiCache, type MiEnv } from './_marketIndexer.js';

const spec = specById('pancakeswap-v2-bnb')!;
const WBNB = '0xbb4cdb9cbd36b01bd1cbaebf2de08d9173bc095c';
const USDT = '0x55d398326f99059ff775485246999027b3197955';
const TOKEN = '0x' + 'a1'.repeat(20);
const POOL = '0x' + 'c3'.repeat(20);
const E18 = 10n ** 18n;
const maker = (i: number): string => '0x' + (i + 16).toString(16).padStart(2, '0').repeat(20);

/** A store filled by the real engine from a simulated chain: one active USDT-quoted market with a busy hour. */
async function seeded() {
  const chain = new FakeChain(1000, 1_700_000_000, 30);
  chain.addToken(WBNB, 'WBNB', 18);
  chain.addToken(USDT, 'USDT', 18);
  chain.addToken(TOKEN, 'MEME', 18, 'Meme Token');
  chain.reserves.set(POOL, [1_000_000n * E18, 50_000n * E18]);
  chain.mine([pairCreatedLog(spec.factory, TOKEN, USDT, POOL)]);
  chain.mineEmpty(30);
  for (let i = 0; i < 12; i++) {
    // alternate buys (USDT in, token out) and sells (token in, USDT out), 100 USDT each, from different accounts
    chain.mine([i % 2 === 0 ? v2SwapLog(POOL, { in1: 100n * E18, out0: (1000n + BigInt(i)) * E18 }, maker(i)) : v2SwapLog(POOL, { in0: 1000n * E18, out1: 100n * E18 }, maker(i))]);
    chain.mineEmpty(2);
  }
  chain.mineEmpty(5);
  const store = new InMemoryMiStore();
  const now = () => (chain.blocks[chain.blocks.length - 1]!.time + 5) * 1000;
  await runAdapter({ spec, chain: { ...chainConfig('bnb', { MI_CONFIRMATIONS_BNB: '2' }), maxRange: 200, lookback: 400 }, read: chain.read, store, rules: DEFAULT_RULES, now });
  return { store, chain, now: now() };
}

const env: MiEnv = { SUPABASE_URL: 'https://x.supabase.co', SUPABASE_SERVICE_ROLE_KEY: 'k', SWINGS_SESSION_SECRET: 'secret-for-tests', ADMIN_WALLETS: '0x' + 'a'.repeat(40), CRON_SECRET: 'cron-secret' };
const nofetch = (async () => new Response('{}', { status: 500 })) as unknown as typeof fetch;
const get = (store: InMemoryMiStore, now: number, path: string, query: Record<string, string> = {}, ip = '9.9.9.9') => handleMi({ method: 'GET', query: { path, ...query }, authorization: null, ip, env, fetchImpl: nofetch, now }, store);
const body = (o: { body: string }) => JSON.parse(o.body);

beforeEach(() => {
  resetBudgets();
  resetRateLimit();
  resetMiCache();
});

describe('GET /api/v1 (public read API)', () => {
  it('lists new pairs with real indexed numbers, evidence level and a safe route into the swap flow', async () => {
    const { store, now } = await seeded();
    const out = await get(store, now, 'pools/new', { chain: 'bnb', limit: '5' });
    expect(out.status).toBe(200);
    expect(out.headers['access-control-allow-origin']).toBe('*');
    expect(out.headers['cache-control']).toMatch(/s-maxage=10/);
    const { data, meta } = body(out);
    expect(meta.version).toBe('v1');
    expect(data).toHaveLength(1);
    const p = data[0];
    expect(p).toMatchObject({ chain: 'bnb', address: POOL, state: 'active', dexName: 'PancakeSwap V2', kind: 'v2' });
    expect(p.base).toMatchObject({ symbol: 'MEME', address: TOKEN, decimals: 18 });
    expect(p.quote).toMatchObject({ symbol: 'USDT', nameFlags: [] });
    expect(p.price.usd).toBeGreaterThan(0);
    expect(p.txns.buys.h24).toBe(6);
    expect(p.txns.sells.h24).toBe(6);
    expect(p.volume.usd.h24).toBeCloseTo(1200, 6);
    expect(p.liquidity.usd).toBeCloseTo(100_000, 6);
    expect(p.evidence).toBe('live-verified');
    // The swap link only opens the wallet's swap screen with the token chosen; nothing is executed by the API.
    expect(p.links.swap).toBe(`/wallet#/swap/bnb/${TOKEN}`);
    expect(JSON.stringify(data)).not.toMatch(/service|secret|apikey/i);
  });

  it('pages without repeats and validates every parameter', async () => {
    const { store, now } = await seeded();
    for (const bad of <Record<string, string>[]>[{ limit: '0' }, { limit: '101' }, { limit: 'x' }, { chain: 'dogechain' }, { state: 'bogus' }, { maxAgeHours: '-1' }, { q: '<script>' }, { dex: 'DROP TABLE' }]) {
      const out = await get(store, now, 'pools/new', bad);
      expect(out.status, JSON.stringify(bad)).toBe(400);
      expect(body(out).error.code).toMatch(/^bad-/);
    }
    expect((await get(store, now, 'pools/new', { cursor: '!!!' })).status).toBe(200);
  });

  it('searches by symbol and address, and trending ranks only guarded, real activity', async () => {
    const { store, now } = await seeded();
    expect(body(await get(store, now, 'pools/search', { q: 'meme' })).data).toHaveLength(1);
    expect(body(await get(store, now, 'pools/search', { q: TOKEN })).data).toHaveLength(1);
    expect(body(await get(store, now, 'pools/search', { q: 'zzz' })).data).toHaveLength(0);
    expect((await get(store, now, 'pools/search')).status).toBe(400);
    const t = body(await get(store, now, 'pools/trending'));
    expect(t.data.ranked).toHaveLength(1);
    expect(t.data.ranked[0]).toMatchObject({ rank: 1, address: POOL });
    // Paid placements never appear in the ranked list; they are returned apart (empty here: none is running).
    expect(t.data.promoted).toEqual([]);
    expect(t.meta.method).toMatch(/discounted/);
  });

  it('gives a pool detail, its trades and its candles from stored trades only', async () => {
    const { store, now } = await seeded();
    const detail = body(await get(store, now, `pools/bnb/${POOL}`));
    expect(detail.data.pool.address).toBe(POOL);
    expect(detail.data.otherMarketsOfToken).toEqual([]);
    expect(detail.meta.indexedThroughBlock).toBeGreaterThan(0);
    const trades = body(await get(store, now, `pools/bnb/${POOL}/trades`, { limit: '5' }));
    expect(trades.data).toHaveLength(5);
    expect(trades.data[0].unix).toBeGreaterThanOrEqual(trades.data[4].unix);
    expect(trades.data[0].price).toMatch(/^\d/);
    const candles = body(await get(store, now, `pools/bnb/${POOL}/candles`, { tf: '5m' }));
    expect(candles.meta.unit).toBe('usd');
    expect(candles.data.length).toBeGreaterThan(0);
    for (const [t, o, h, l, c, v] of candles.data) {
      expect(t % 300).toBe(0);
      expect(h).toBeGreaterThanOrEqual(Math.max(o, c));
      expect(l).toBeLessThanOrEqual(Math.min(o, c));
      expect(v).toBeGreaterThan(0);
    }
    expect((await get(store, now, `pools/bnb/${POOL}/candles`, { tf: '7m' })).status).toBe(400);
  });

  it('gives a token with every market it is in', async () => {
    const { store, now } = await seeded();
    const t = body(await get(store, now, `tokens/bnb/${TOKEN}`));
    expect(t.data.token.symbol).toBe('MEME');
    expect(t.data.markets).toHaveLength(1);
    expect(t.data.firstTradeAt).not.toBeNull();
    expect((await get(store, now, `tokens/bnb/0x${'9'.repeat(40)}`)).status).toBe(404);
  });

  it('rejects malformed paths, honestly refuses Solana, and answers CORS preflight', async () => {
    const { store, now } = await seeded();
    expect((await get(store, now, 'pools/bnb/0x123')).status).toBe(400);
    expect((await get(store, now, 'pools/mars/' + POOL)).status).toBe(400);
    expect((await get(store, now, 'pools/solana/0x123')).status).toBe(400);
    expect((await get(store, now, 'pools/solana/So11111111111111111111111111111111111111112')).status).toBe(404);
    expect((await get(store, now, 'nothing/here')).status).toBe(404);
    expect((await get(store, now, '../../etc/passwd')).status).toBe(404);
    expect((await handleMi({ method: 'POST', query: {}, authorization: null, ip: '1.1.1.1', env, fetchImpl: nofetch, now }, store)).status).toBe(405);
    expect((await handleMi({ method: 'OPTIONS', query: {}, authorization: null, ip: '1.1.1.1', env, fetchImpl: nofetch, now }, store)).status).toBe(204);
  });

  it('reports every chain and DEX with its evidence, and lists what is not indexed', async () => {
    const { store, now } = await seeded();
    const s = body(await get(store, now, 'status')).data;
    expect(s.chains.map((c: { id: string }) => c.id).sort()).toEqual(['arbitrum', 'avalanche', 'base', 'bnb', 'ethereum', 'optimism', 'polygon', 'solana']);
    expect(s.chains.find((c: { id: string }) => c.id === 'solana')).toMatchObject({ supported: true, adapters: 3 });
    expect(s.dexes.find((d: { id: string }) => d.id === 'orca-whirlpool-solana')).toMatchObject({ evidence: 'live-verified', state: 'not-running' });
    expect(s.chains.find((c: { id: string }) => c.id === 'bnb').running).toBe(1);
    expect(s.dexes.find((d: { id: string }) => d.id === 'pancakeswap-v2-bnb').state).toBe('ok');
    expect(s.dexes.find((d: { id: string }) => d.id === 'apeswap-v2-polygon').state).toBe('not-running');
    expect(s.notIndexed.map((p: { id: string }) => p.id)).toEqual(['meteora-damm-v2', 'meteora-dlmm', 'meteora-dbc']);
    expect(s.notIndexed.every((p: { evidence: string }) => p.evidence === 'planned')).toBe(true);
  });

  it('rate limits per address and does not count other addresses', async () => {
    const { store, now } = await seeded();
    let last = 200;
    for (let i = 0; i < 125; i++) last = (await get(store, now + i * 10_000 * 0, 'status', { n: String(i) }, '7.7.7.7')).status;
    expect(last).toBe(429);
    expect((await get(store, now, 'status', { n: 'x' }, '8.8.8.8')).status).toBe(200);
  });

  it('does not list a market an administrator paused', async () => {
    const { store, now } = await seeded();
    await store.updatePool(`bnb:${POOL}`, { paused: true, state: 'suspended' });
    expect(body(await get(store, now, 'pools/new', { state: 'active,suspended' })).data).toHaveLength(1);
    expect((await get(store, now, `pools/bnb/${POOL}`)).status).toBe(404);
    expect(body(await get(store, now, 'pools/trending')).data.ranked).toHaveLength(0);
  });

  it('answers not-configured without a database', async () => {
    const out = await handleMi({ method: 'GET', query: { path: 'status' }, authorization: null, ip: '1.2.3.4', env: {}, fetchImpl: nofetch, now: 1 });
    expect(out.status).toBe(503);
  });
});

describe('owner controls', () => {
  const NOW = 1_800_000_000_000;
  const session = `Bearer ${issueSession('secret-for-tests', `evm:0x${'a'.repeat(40)}`, NOW).token}`;
  const db = (async (input: string | URL) => (String(input).includes('account_sessions') ? new Response('[]') : new Response('{}', { status: 404 }))) as unknown as typeof fetch;
  const call = (store: InMemoryMiStore, b: Record<string, unknown>, over: Record<string, unknown> = {}) =>
    handleMiAdmin({ method: 'POST', origin: 'https://aretiafinance.org', authorization: session, ip: '1.1.1.1', body: b, env, fetchImpl: db, now: NOW, ...over } as Parameters<typeof handleMiAdmin>[0], store);

  it('is a 404 for anyone but the owner', async () => {
    const { store } = await seeded();
    for (const over of [{ authorization: null }, { authorization: 'Bearer nope' }, { method: 'GET' }, { origin: 'https://evil.example' }]) {
      const out = await call(store, { action: 'disable-adapter', adapterId: spec.id }, over);
      expect(out, JSON.stringify(over)).toMatchObject({ status: 404, body: '{"error":"not-found"}' });
    }
    expect(store.disabled.size).toBe(0);
    expect(store.audit).toHaveLength(0);
  });

  it('disables and re-enables an adapter, pauses and resumes a market, queues a backfill, and writes an audit entry for each', async () => {
    const { store } = await seeded();
    expect((await call(store, { action: 'disable-adapter', adapterId: spec.id, reason: 'RPC problems' })).status).toBe(200);
    expect(store.disabled.has(spec.id)).toBe(true);
    expect((await call(store, { action: 'enable-adapter', adapterId: spec.id })).status).toBe(200);
    expect(store.disabled.size).toBe(0);
    expect((await call(store, { action: 'pause-pool', chain: 'bnb', pool: POOL, reason: 'reported scam' })).status).toBe(200);
    expect(store.pools.get(`bnb:${POOL}`)).toMatchObject({ paused: true, state: 'suspended' });
    expect((await call(store, { action: 'resume-pool', chain: 'bnb', pool: POOL })).status).toBe(200);
    expect(store.pools.get(`bnb:${POOL}`)).toMatchObject({ paused: false, state: 'validating' });
    const bf = body(await call(store, { action: 'backfill', adapterId: spec.id, fromBlock: 100, toBlock: 900 }));
    expect(bf.ok).toBe(true);
    expect(store.jobs.get(bf.jobId)).toMatchObject({ status: 'pending', fromBlock: 100, toBlock: 900, doneBlock: 99 });
    expect(store.audit.map((a) => a.action)).toEqual(['disable-adapter', 'enable-adapter', 'pause-pool', 'resume-pool', 'backfill']);
    expect(store.audit.every((a) => a.actor === `evm:0x${'a'.repeat(40)}` && a.at === NOW)).toBe(true);
    const overview = body(await call(store, { action: 'overview' }));
    expect(overview.audit).toHaveLength(5);
    expect(overview.jobs).toHaveLength(1);
  });

  it('validates what it is given', async () => {
    const { store } = await seeded();
    for (const b of [{ action: 'disable-adapter', adapterId: 'nope' }, { action: 'pause-pool', chain: 'bnb', pool: '0x1' }, { action: 'backfill', adapterId: spec.id, fromBlock: 5, toBlock: 1 }, { action: 'backfill', adapterId: spec.id, fromBlock: 0, toBlock: 999_999_999 }, { action: 'requeue-job', jobId: '../x' }, { action: 'explode' }]) {
      expect((await call(store, b)).status, JSON.stringify(b)).toBe(400);
    }
    expect((await call(store, { action: 'pause-pool', chain: 'bnb', pool: '0x' + '9'.repeat(40) })).status).toBe(404);
    expect(store.audit).toHaveLength(0);
  });
});

describe('scheduled run', () => {
  it('needs the cron secret', async () => {
    const { store } = await seeded();
    const call = (authorization: string | null) => handleMiRun({ method: 'GET', query: {}, authorization, ip: '1.1.1.1', env, fetchImpl: nofetch, now: 1 }, store);
    expect((await call(null)).status).toBe(401);
    expect((await call('Bearer wrong')).status).toBe(401);
    expect((await handleMiRun({ method: 'GET', query: {}, authorization: 'Bearer ', ip: '1', env: { ...env, CRON_SECRET: '' }, fetchImpl: nofetch, now: 1 }, store)).status).toBe(401);
  });
});

describe('candles for the existing TradingView chart (source=aretia)', () => {
  const ask = (store: InMemoryMiStore, now: number, q: Record<string, string>) => miOhlcv({ query: { chain: 'bnb', pool: POOL, tf: 'minute', agg: '5', before: String(Math.floor(now / 1000)), limit: '300', ...q }, env, fetchImpl: nofetch, now, ip: '3.3.3.3' }, store);

  it('answers in the shape the chart reads, newest first, from stored trades', async () => {
    const { store, now } = await seeded();
    const out = await ask(store, now, {});
    expect(out.status).toBe(200);
    const b = JSON.parse(out.body);
    const list: number[][] = b.data.attributes.ohlcv_list;
    expect(list.length).toBeGreaterThan(1);
    expect(list[0]![0]).toBeGreaterThan(list[list.length - 1]![0]!);
    for (const [t, o, h, l, c, v] of list) {
      expect(t! % 300).toBe(0);
      expect(h).toBeGreaterThanOrEqual(Math.max(o!, c!));
      expect(l).toBeLessThanOrEqual(Math.min(o!, c!));
      expect(v).toBeGreaterThan(0);
    }
    expect(b.unit).toBe('usd');
    expect(b.source).toBe('aretia-index');
  });

  it('never converts a native-quoted pool to dollars, and refuses malformed asks', async () => {
    const { store, now } = await seeded();
    // The same market, pretending its quote is the wrapped native coin: dollars are not available, token units are.
    await store.updatePool(`bnb:${POOL}`, { quote: WBNB });
    expect(JSON.parse((await ask(store, now, { currency: 'usd' })).body).data.attributes.ohlcv_list).toEqual([]);
    expect(JSON.parse((await ask(store, now, { currency: 'token' })).body).data.attributes.ohlcv_list.length).toBeGreaterThan(0);
    for (const q of <Record<string, string>[]>[{ tf: 'week' }, { agg: '7' }, { limit: '0' }, { token: 'quote' }, { pool: '0x123' }, { chain: 'solana' }]) expect((await ask(store, now, q)).status, JSON.stringify(q)).toBe(400);
    expect((await ask(store, now, { pool: '0x' + '9'.repeat(40) })).status).toBe(404);
  });
});
