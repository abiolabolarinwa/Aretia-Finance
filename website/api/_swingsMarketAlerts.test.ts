import { describe, expect, it } from 'vitest';
import { rest } from './_swingsAccount.js';
import { fairFavourites, MARKET_TOKEN_BUDGET, poolFromRow, runMarketAlerts, type MarketRunInput } from './_swingsMarketAlerts.js';
import type { PlannedMessage } from '../src/swings/notify/plan.js';
import { MAX_MARKET_PER_HOUR } from '../src/swings/notify/market.js';

const NOW = 1_800_000_000_000;
const OWNER = 'evm:0x1111111111111111111111111111111111111111';
const TOKEN = '0x2222222222222222222222222222222222222222';
const POOL = '0x3333333333333333333333333333333333333333';

interface Call {
  method: string;
  url: string;
  body: unknown;
}

/** A pretend alerts database and market index: every call is recorded and answered by the first matching route. */
function fake(routes: [RegExp, (c: Call) => unknown][]) {
  const calls: Call[] = [];
  const fetchImpl = (async (url: string, init?: RequestInit) => {
    const call: Call = { method: init?.method ?? 'GET', url: decodeURIComponent(url), body: init?.body ? JSON.parse(init.body as string) : null };
    calls.push(call);
    for (const [re, h] of routes) if (re.test(`${call.method} ${call.url}`)) {
      const out = h(call);
      if (out === undefined) continue;
      return out instanceof Response ? out : new Response(JSON.stringify(out ?? []), { status: 200 });
    }
    return new Response('[]', { status: 200 });
  }) as unknown as typeof fetch;
  return { calls, fetchImpl, find: (re: RegExp) => calls.filter((c) => re.test(`${c.method} ${c.url}`)) };
}

const poolRow = { key: `base:${POOL}`, chain: 'base', address: POOL, base: TOKEN, quote_decimals: 18, created_at: NOW - 3 * 60_000, liquidity_usd: 40_000, reserve_base: '1000000', reserve_quote: '10', quote_usd: 3000 };
const buyRow = { chain: 'base', pool: POOL, id: '0xtx:1', time: Math.floor((NOW - 60_000) / 1000), side: 'buy', quote_amount: String(2 * 1e18) };

function setup(over: { prefs?: Record<string, unknown>; sent?: unknown[]; indexFails?: boolean } = {}) {
  const f = fake([
    [/GET .*notify_market_prefs/, () => [{ owner: OWNER, launch_chains: [], launch_min_liq: 0, big_buy_usd: 5000, liq_drop_pct: 0, ...over.prefs }]],
    [/GET .*notify_market_sent/, () => over.sent ?? []],
    [/index\.example.*mi_/, () => (over.indexFails ? new Response('busy', { status: 503 }) : undefined)],
    [/GET .*index\.example.*mi_pools\?chain=in/, () => [{ ...poolRow, key: 'base:0xnew', address: '0xnew', base: '0xnewtoken' }]],
    [/GET .*index\.example.*mi_pools/, () => [poolRow]],
    [/GET .*index\.example.*mi_tokens/, () => [{ key: 'base:0xnewtoken', symbol: 'NEWT' }]],
    [/GET .*index\.example.*mi_trades/, () => [buyRow]],
  ]);
  const sent: { owner: string; m: PlannedMessage }[] = [];
  const input: MarketRunInput = {
    env: { SUPABASE_URL: 'https://db.example.co', SUPABASE_SERVICE_ROLE_KEY: 'k', MI_DATA_URL: 'https://index.example.org', MI_DATA_SERVICE_ROLE_KEY: 'ik' },
    fetchImpl: f.fetchImpl,
    db: rest('https://db.example.co', 'k', f.fetchImpl),
    now: NOW,
    owners: [OWNER],
    favourites: () => [{ chain: 'base', address: TOKEN, symbol: 'AAA' }],
    send: async (owner, m) => {
      sent.push({ owner, m });
      return true;
    },
  };
  return { f, sent, input };
}

describe('runMarketAlerts', () => {
  it('asks the index nothing when nobody has a market alert on', async () => {
    const { f, input } = setup({ prefs: { big_buy_usd: 0 } });
    const stats = await runMarketAlerts(input);
    expect(stats.marketOwners).toBe(0);
    expect(f.find(/index\.example/)).toHaveLength(0);
  });
  it('sends a large buy of a favourite once, with a link and no more than a title and numbers', async () => {
    const { f, sent, input } = setup();
    const stats = await runMarketAlerts(input);
    expect(stats).toMatchObject({ marketOwners: 1, pools: 1, buys: 1, marketSent: 1 });
    expect(sent[0]!.m).toEqual({ kind: 'buy', title: 'AAA: $6K buy', body: 'On Base, 1 min ago.', url: `/token#/base/${TOKEN}` });
    const saved = f.find(/POST .*notify_market_sent/)[0]!.body as { key: string; msg: boolean }[];
    expect(saved).toEqual([{ owner: OWNER, key: 'buy:base:0xtx:1', at: NOW, msg: true }]);
    // Small: the index is asked only for the favourite's pools and their recent buys, each with a row limit.
    const asked = f.find(/index\.example/);
    expect(asked).toHaveLength(2);
    for (const c of asked) expect(c.url).toMatch(/limit=\d+/);
  });
  it('does not send what was already sent', async () => {
    const { sent, input } = setup({ sent: [{ key: 'buy:base:0xtx:1', at: NOW - 60_000, msg: true }] });
    expect((await runMarketAlerts(input)).marketSent).toBe(0);
    expect(sent).toHaveLength(0);
  });
  it('sends nothing past the hourly limit but remembers the buy', async () => {
    const full = Array.from({ length: MAX_MARKET_PER_HOUR }, (_, i) => ({ key: `buy:base:old${i}`, at: NOW - 10 * 60_000, msg: true }));
    const { f, sent, input } = setup({ sent: full });
    await runMarketAlerts(input);
    expect(sent).toHaveLength(0);
    expect(f.find(/POST .*notify_market_sent/)[0]!.body).toEqual([{ owner: OWNER, key: 'buy:base:0xtx:1', at: NOW, msg: false }]);
  });
  it('remembers nothing when no message could be delivered, so the next run tries again', async () => {
    const { f, input } = setup();
    input.send = async () => false;
    const stats = await runMarketAlerts(input);
    expect(stats.marketFailed).toBe(1);
    expect(f.find(/POST .*notify_market_sent/)).toHaveLength(0);
  });
  it('reports new launches on a chosen network, with the token name from the index', async () => {
    const { sent, input } = setup({ prefs: { big_buy_usd: 0, launch_chains: ['base'], launch_min_liq: 10000 } });
    await runMarketAlerts(input);
    expect(sent.map((s) => s.m.title)).toEqual(['New on Base: NEWT']);
  });
  it('marks pools for liquidity drops the first time, and reports a drop against the mark later', async () => {
    const first = setup({ prefs: { big_buy_usd: 0, liq_drop_pct: 50 } });
    await runMarketAlerts(first.input);
    expect(first.sent).toHaveLength(0);
    expect(first.f.find(/POST .*notify_pool_marks/)[0]!.body).toEqual([{ pool_key: `base:${POOL}`, reserve_base: 1_000_000, reserve_quote: 10, at: NOW }]);

    const later = setup({ prefs: { big_buy_usd: 0, liq_drop_pct: 50 } });
    later.f.calls.length = 0;
    const markAt = NOW - 3_600_000;
    const routes = later.input.fetchImpl;
    later.input.fetchImpl = (async (url: string, init?: RequestInit) => (/notify_pool_marks/.test(url) && !init?.method ? new Response(JSON.stringify([{ pool_key: `base:${POOL}`, reserve_base: 3_000_000, reserve_quote: 30, at: markAt }])) : routes(url, init))) as typeof fetch;
    later.input.db = rest('https://db.example.co', 'k', later.input.fetchImpl);
    await runMarketAlerts(later.input);
    expect(later.sent.map((s) => s.m.title)).toEqual(['AAA: 67% of liquidity removed']);
  });
  it('throws when the index fails, so the caller can note it and keep the price alerts', async () => {
    const { input } = setup({ indexFails: true });
    await expect(runMarketAlerts(input)).rejects.toThrow(/503/);
  });
});

describe('helpers', () => {
  it('shares the favourite budget round-robin between people', () => {
    const lists: Record<string, string[]> = { a: ['a1', 'a2', 'a3'], b: ['b1'], c: ['c1', 'c2'] };
    expect(fairFavourites(['a', 'b', 'c'], (o) => lists[o]!, 4, 0)).toEqual(['a1', 'b1', 'c1', 'a2']);
    expect(fairFavourites(['a', 'b', 'c'], (o) => lists[o]!, 4, 1)).toEqual(['b1', 'c1', 'a1', 'c2']);
    expect(MARKET_TOKEN_BUDGET).toBeLessThanOrEqual(100);
  });
  it('refuses a pool row it cannot use', () => {
    expect(poolFromRow({ ...poolRow, chain: 'tron' })).toBeNull();
    expect(poolFromRow({ ...poolRow, created_at: null })).toBeNull();
    expect(poolFromRow(poolRow)).toMatchObject({ chain: 'base', reserveBase: 1_000_000, quoteUsd: 3000 });
  });
});
