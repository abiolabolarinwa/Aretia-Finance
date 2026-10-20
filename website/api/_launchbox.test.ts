import { beforeEach, describe, expect, it } from 'vitest';
import { EVM_CURVE, EVM_FACTORIES, TOKEN_CREATED_TOPIC, tokenKey } from '../src/swings/launchbox/core';
import { FakeLaunchStore } from '../src/swings/launchbox/fakeStore';
import { bestPools, decodeCurve, fetchPools } from '../src/swings/launchbox/markets';
import { handleLaunchbox, handleLaunchboxRun, resetLaunchboxCache, type LaunchboxInput } from './_launchbox';

const NOW = 1_760_000_000_000;
const A_SOL = 'SoLmintSoLmintSoLmintSoLmintSoLmintSoLmint1';
const A_BNB = '0x1111111111111111111111111111111111111111';
const A_ETH = '0x2222222222222222222222222222222222222222';

async function seeded(): Promise<FakeLaunchStore> {
  const store = new FakeLaunchStore();
  await store.insertNew(
    [
      { chain: 'solana', address: A_SOL, name: 'Sol Token', symbol: 'SOLT', decimals: 9, supply: '1000', creator: 'cr', createdAt: NOW - 3_600_000, tx: 'tx1', source: 'solana-fee' },
      { chain: 'bnb', address: A_BNB, name: 'Bnb Token', symbol: 'BNBT', decimals: 18, supply: '5', creator: '0xc', createdAt: NOW - 7_200_000, tx: '0xt', source: 'factory' },
      { chain: 'ethereum', address: A_ETH, name: 'Eth Token', symbol: 'ETHT', decimals: 18, supply: '5', creator: '0xc', createdAt: NOW - 100, tx: '0xu', source: 'factory' },
    ],
    NOW,
  );
  // The indexer ran a minute ago on every chain, so a page visit does not start its own catch-up.
  for (const c of ['solana', 'bnb', 'ethereum', 'polygon'] as const) await store.setCursor(c, '1', NOW - 60_000, { expected: c === 'polygon' ? 0 : 1, indexed: c === 'polygon' ? 0 : 1 });
  return store;
}

const w = (n: bigint | number): string => BigInt(n).toString(16).padStart(64, '0');
const curveWords = (status: number, curveTokens: bigint, realTok: bigint): string => '0x' + [status, 0, 0, 0, 0, 0, 0, curveTokens, 0, 0, 0, 0, realTok].map((x) => w(x)).join('');

interface Seen {
  urls: string[];
}
function world(opts: { dex?: 'ok' | 'down' | 'empty'; curve?: string; seen?: Seen } = {}): typeof fetch {
  return (async (url: string, init?: { body?: string }) => {
    opts.seen?.urls.push(url);
    if (url.startsWith('https://api.dexscreener.com/')) {
      if (opts.dex === 'down') return new Response('nope', { status: 503 });
      if (opts.dex === 'empty') return Response.json([]);
      const chain = url.split('/tokens/v1/')[1]!.split('/')[0];
      if (chain === 'solana') return Response.json([{ chainId: 'solana', dexId: 'meteora', url: 'https://dexscreener.com/solana/p1', pairAddress: 'p1', baseToken: { address: A_SOL }, quoteToken: { address: 'So11111111111111111111111111111111111111112', symbol: 'SOL' }, priceUsd: '0.002', priceChange: { h24: 12.5 }, volume: { h24: 1234 }, liquidity: { usd: 5000 }, marketCap: 20000, fdv: 30000 }]);
      return Response.json([]);
    }
    if (init?.body && url.includes('publicnode')) {
      const batch = JSON.parse(init.body) as { id: number; params: { data: string }[] }[];
      return Response.json(batch.map((b) => ({ jsonrpc: '2.0', id: b.id, result: b.params[0]!.data.endsWith(A_BNB.slice(2)) ? (opts.curve ?? curveWords(1, 1000n, 250n)) : curveWords(0, 0n, 0n) })));
    }
    return new Response('unexpected', { status: 500 });
  }) as unknown as typeof fetch;
}

const input = (over: Partial<LaunchboxInput> = {}): LaunchboxInput => ({ method: 'GET', authorization: null, ip: '1.2.3.4', env: { SUPABASE_URL: 'https://x.supabase.co', SUPABASE_SERVICE_ROLE_KEY: 'k', CRON_SECRET: 'cron-secret' }, fetchImpl: world(), now: NOW, ...over });
const parse = (r: { body: string }) => JSON.parse(r.body) as { setup: string; launches: Record<string, unknown>[]; index: Record<string, unknown>[]; staleMarket?: boolean; marketOk?: boolean; stale?: boolean };

beforeEach(() => resetLaunchboxCache());

describe('GET /api/launchbox', () => {
  it('lists the indexed tokens with market data from DexScreener and the curve read from the chain', async () => {
    const store = await seeded();
    const res = await handleLaunchbox(input({ store }));
    expect(res.status).toBe(200);
    expect(res.headers['cache-control']).toContain('s-maxage=60');
    const body = parse(res);
    expect(body.setup).toBe('ok');
    const by = Object.fromEntries(body.launches.map((l) => [l.symbol as string, l]));
    expect(by.SOLT).toMatchObject({ priceUsd: 0.002, change24h: 12.5, volume24hUsd: 1234, liquidityUsd: 5000, capUsd: 20000, capKind: 'mcap', market: 'ok', pool: { dex: 'meteora', address: 'p1' } });
    // No pool: no price, and the row says "none", not zero.
    expect(by.ETHT).toMatchObject({ priceUsd: null, volume24hUsd: null, market: 'none', pool: null, curve: null });
    expect(by.BNBT).toMatchObject({ market: 'none', curve: { status: 'trading', progressPct: 75 }, curveRead: true });
  });

  it('puts the newest token first', async () => {
    const body = parse(await handleLaunchbox(input({ store: await seeded() })));
    expect(body.launches.map((l) => l.symbol)).toEqual(['ETHT', 'SOLT', 'BNBT']);
  });

  it('shows the index status per chain so the page can say what is missing', async () => {
    const body = parse(await handleLaunchbox(input({ store: await seeded() })));
    expect(body.index.find((i) => i.chain === 'bnb')).toMatchObject({ expected: 1, indexed: 1, updatedAt: NOW - 60_000 });
  });

  it('serves the same answer from memory for a minute (one trip to the sources)', async () => {
    const seen: Seen = { urls: [] };
    const store = await seeded();
    await handleLaunchbox(input({ store, fetchImpl: world({ seen }) }));
    const first = seen.urls.length;
    await handleLaunchbox(input({ store, fetchImpl: world({ seen }), now: NOW + 30_000 }));
    expect(seen.urls.length).toBe(first);
    await handleLaunchbox(input({ store, fetchImpl: world({ seen }), now: NOW + 61_000 }));
    expect(seen.urls.length).toBeGreaterThan(first);
  });

  it('asks DexScreener once per chain, for all of that chain\'s tokens together', async () => {
    const seen: Seen = { urls: [] };
    await handleLaunchbox(input({ store: await seeded(), fetchImpl: world({ seen }) }));
    expect(seen.urls.filter((u) => u.includes('dexscreener'))).toHaveLength(3);
  });

  it('marks the market as unavailable, not as empty, when DexScreener fails and nothing older is kept', async () => {
    const body = parse(await handleLaunchbox(input({ store: await seeded(), fetchImpl: world({ dex: 'down' }) })));
    expect(body.marketOk).toBe(false);
    expect(body.launches.every((l) => l.market === 'unavailable')).toBe(true);
  });

  it('shows the last good numbers, marked old, when DexScreener fails later', async () => {
    const store = await seeded();
    await handleLaunchbox(input({ store }));
    const later = parse(await handleLaunchbox(input({ store, fetchImpl: world({ dex: 'down' }), now: NOW + 120_000 })));
    expect(later.staleMarket).toBe(true);
    expect(later.launches.find((l) => l.symbol === 'SOLT')).toMatchObject({ priceUsd: 0.002, market: 'ok' });
  });

  it('answers "being set up" when the migration has not been run, instead of failing', async () => {
    const store = new FakeLaunchStore();
    store.missing = true;
    const res = await handleLaunchbox(input({ store }));
    expect(res.status).toBe(200);
    expect(parse(res)).toMatchObject({ setup: 'no-table', launches: [] });
  });

  it('answers "not configured" when there is no database in the environment', async () => {
    const res = await handleLaunchbox(input({ env: {} }));
    expect(parse(res)).toMatchObject({ setup: 'not-configured', launches: [] });
  });

  it('is an empty list, not an error, before anyone has launched', async () => {
    const store = new FakeLaunchStore();
    for (const c of ['solana', 'bnb', 'ethereum', 'polygon'] as const) await store.setCursor(c, '1', NOW - 1000, null);
    const body = parse(await handleLaunchbox(input({ store })));
    expect(body).toMatchObject({ setup: 'ok', launches: [] });
  });

  it('rejects anything but GET', async () => {
    const res = await handleLaunchbox(input({ method: 'POST', store: await seeded() }));
    expect(res.status).toBe(405);
  });

  it('limits how often one address may ask', async () => {
    const store = await seeded();
    let last = 200;
    for (let i = 0; i < 400; i++) {
      resetLaunchboxCache();
      last = (await handleLaunchbox(input({ store, ip: '9.9.9.9' }))).status;
      if (last === 429) break;
    }
    expect(last).toBe(429);
  });

  it('runs one catch-up of the indexer when it has been quiet, and not when it ran recently', async () => {
    const store = new FakeLaunchStore();
    const seen: Seen = { urls: [] };
    const fetchImpl = (async (url: string, init?: { body?: string }) => {
      seen.urls.push(url);
      if (url.includes('dexscreener')) return Response.json([]);
      const m = init?.body ? (JSON.parse(init.body) as { method?: string }).method : '';
      const result = m === 'eth_blockNumber' ? '0x4e20' : m === 'eth_getTransactionCount' ? '0x1' : [];
      return Response.json({ jsonrpc: '2.0', id: 1, result });
    }) as unknown as typeof fetch;
    await handleLaunchbox(input({ store, fetchImpl, now: Date.now() }));
    expect(seen.urls.some((u) => u.includes('publicnode'))).toBe(true);
    expect((await store.cursors()).length).toBe(4);
  });
});

describe('GET /api/launchbox-run', () => {
  it('refuses without the cron secret, and with a wrong one', async () => {
    const store = await seeded();
    expect((await handleLaunchboxRun(input({ store }))).status).toBe(401);
    expect((await handleLaunchboxRun(input({ store, authorization: 'Bearer nope' }))).status).toBe(401);
    expect((await handleLaunchboxRun(input({ store, authorization: 'Bearer ' }))).status).toBe(401);
  });

  it('refuses everything when no secret is configured at all', async () => {
    expect((await handleLaunchboxRun(input({ store: await seeded(), env: { SUPABASE_URL: 'https://x.supabase.co', SUPABASE_SERVICE_ROLE_KEY: 'k' }, authorization: 'Bearer ' }))).status).toBe(401);
    expect((await handleLaunchboxRun(input({ store: await seeded(), env: {}, authorization: 'Bearer undefined' }))).status).toBe(401);
  });

  it('tells the owner what to run when the table is missing', async () => {
    const store = new FakeLaunchStore();
    store.missing = true;
    const res = await handleLaunchboxRun(input({ store, authorization: 'Bearer cron-secret' }));
    expect(res.status).toBe(503);
    expect(res.body).toContain('0012_launchbox.sql');
  });

  it('runs the indexer with the secret, stores a token it finds, and a second run adds nothing', async () => {
    const store = new FakeLaunchStore();
    for (const c of ['bnb', 'ethereum', 'polygon'] as const) await store.setCursor(c, String(20_000 - 3 - 100), 1, null);
    const token = '0x4444444444444444444444444444444444444444';
    const str = (s: string): string => w(s.length) + [...new TextEncoder().encode(s)].map((x) => x.toString(16).padStart(2, '0')).join('').padEnd(64, '0');
    const log = { address: EVM_FACTORIES.bnb, topics: [TOKEN_CREATED_TOPIC, '0x' + token.slice(2).padStart(64, '0'), '0x' + A_ETH.slice(2).padStart(64, '0')], data: '0x' + w(128) + w(192) + w(18) + w(1000) + str('Fresh') + str('FRS'), blockNumber: '0x4e00', transactionHash: '0x' + 'ee'.repeat(32), logIndex: '0x0' };
    const fetchImpl = (async (url: string, init?: { body?: string }) => {
      if (url.includes('dexscreener')) return Response.json([]);
      const { method, params } = JSON.parse(init!.body!) as { method: string; params: { address?: string }[] };
      const bnb = url.includes('bsc');
      const result =
        method === 'eth_blockNumber' ? '0x4e20'
        : method === 'eth_getBlockByNumber' ? { timestamp: '0x6' }
        : method === 'eth_getTransactionCount' ? (bnb ? '0x2' : '0x1')
        : method === 'eth_getLogs' ? (bnb && params[0]!.address === EVM_FACTORIES.bnb ? [log] : [])
        : [];
      return Response.json({ jsonrpc: '2.0', id: 1, result });
    }) as unknown as typeof fetch;
    const res = await handleLaunchboxRun(input({ store, fetchImpl, authorization: 'Bearer cron-secret' }));
    expect(res.status).toBe(200);
    const body = JSON.parse(res.body) as { chains: { chain: string; added: number }[] };
    expect(body.chains.map((c) => c.chain)).toEqual(['bnb', 'ethereum', 'polygon', 'solana']);
    expect(store.rows.get(`bnb:${token}`)).toMatchObject({ name: 'Fresh', symbol: 'FRS', creator: A_ETH, supply: '1000', createdAt: 6000 });
    await store.setCursor('bnb', String(20_000 - 3 - 100), 2, null);
    const again = JSON.parse((await handleLaunchboxRun(input({ store, fetchImpl, authorization: 'Bearer cron-secret' }))).body) as { chains: { added: number }[] };
    expect(again.chains.reduce((n, c) => n + c.added, 0)).toBe(0);
    expect(store.rows.size).toBe(1);
  });
});

describe('market helpers', () => {
  it('picks, for each token, its pool with the most liquidity, as the base token only', () => {
    const pairs = [
      { chainId: 'solana', dexId: 'a', pairAddress: 'low', url: 'https://d/low', baseToken: { address: A_SOL }, quoteToken: { address: 'So11111111111111111111111111111111111111112', symbol: 'SOL' }, priceUsd: '1', liquidity: { usd: 10 } },
      { chainId: 'solana', dexId: 'b', pairAddress: 'high', url: 'https://d/high', baseToken: { address: A_SOL }, quoteToken: { address: 'So11111111111111111111111111111111111111112', symbol: 'SOL' }, priceUsd: '2', liquidity: { usd: 99 }, fdv: 500 },
      { chainId: 'solana', dexId: 'c', pairAddress: 'quote', url: 'https://d/q', baseToken: { address: 'other' }, priceUsd: '3', liquidity: { usd: 1e9 } },
      { chainId: 'bsc', dexId: 'd', pairAddress: 'wrongchain', url: 'https://d/w', baseToken: { address: A_SOL }, priceUsd: '3', liquidity: { usd: 1e9 } },
    ];
    const m = bestPools(pairs, 'solana', [A_SOL]);
    expect(m.size).toBe(1);
    expect(m.get(A_SOL)).toMatchObject({ priceUsd: 2, pool: { address: 'high' }, capUsd: 500, capKind: 'fdv' });
  });

  it('matches EVM addresses without regard to case and never invents numbers', () => {
    const m = bestPools([{ chainId: 'bsc', dexId: 'pancakeswap', pairAddress: '0xp', url: 'https://d/p', baseToken: { address: A_BNB.toUpperCase().replace('0X', '0x') } }], 'bnb', [A_BNB]);
    expect(m.get(A_BNB)).toMatchObject({ priceUsd: null, change24h: null, volume24hUsd: null, liquidityUsd: null, capUsd: null, capKind: null });
  });

  it('refuses a link that is not https', () => {
    const m = bestPools([{ chainId: 'solana', dexId: 'a', pairAddress: 'p', url: 'javascript:alert(1)', baseToken: { address: A_SOL } }], 'solana', [A_SOL]);
    expect(m.get(A_SOL)?.pool.url).toBe('');
  });

  it('fetchPools throws when the service fails, so the caller can say unavailable', async () => {
    await expect(fetchPools(world({ dex: 'down' }), 'solana', [A_SOL])).rejects.toThrow(/503/);
  });

  it('reads curve progress as the share of curve tokens sold', () => {
    expect(decodeCurve(curveWords(1, 1000n, 250n))).toEqual({ status: 'trading', progressPct: 75 });
    expect(decodeCurve(curveWords(1, 3n, 1n))).toEqual({ status: 'trading', progressPct: 66.66 });
    expect(decodeCurve(curveWords(2, 1000n, 0n))).toEqual({ status: 'soldOut', progressPct: 100 });
    expect(decodeCurve(curveWords(3, 1000n, 0n))).toEqual({ status: 'migrated', progressPct: 100 });
    expect(decodeCurve(curveWords(0, 0n, 0n))).toBe('none');
  });

  it('does not trust a curve that reads wrong', () => {
    expect(decodeCurve(curveWords(1, 10n, 20n))).toBeNull();
    expect(decodeCurve(curveWords(9, 10n, 1n))).toBeNull();
    expect(decodeCurve('0x1234')).toBeNull();
    expect(decodeCurve(undefined)).toBeNull();
  });

  it('calls the curve at the Aretia curve address', () => {
    expect(EVM_CURVE).toBe('0x4e85bc5bd6f08fa87ceb749372e34226556837e8');
    expect(tokenKey('bnb', A_BNB.toUpperCase().replace('0X', '0x'))).toBe(`bnb:${A_BNB}`);
  });
});
