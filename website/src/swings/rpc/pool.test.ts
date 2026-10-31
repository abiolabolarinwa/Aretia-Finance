import { describe, expect, it } from 'vitest';
import { cacheTtlMs, logRangeOf, resetSharedPools, RpcPool, sharedPool, type PoolOptions } from './pool.js';

const reply = (body: unknown, status = 200, headers: Record<string, string> = {}) => new Response(JSON.stringify(body), { status, headers });

/** A pool on a fake clock: waiting advances the clock, so tests are instant and exact. */
function fixture(urls: string[], handler: (url: string, req: { method: string; params: unknown[] }) => Response | Promise<Response>, o: PoolOptions = {}) {
  let t = 1_000_000;
  const calls: { url: string; method: string }[] = [];
  const fetchImpl = (async (url: string, init: { body: string }) => {
    const req = JSON.parse(init.body) as { method: string; params: unknown[] };
    calls.push({ url, method: req.method });
    return handler(url, req);
  }) as unknown as typeof fetch;
  let seed = 7;
  const random = () => {
    seed = (seed * 16807) % 2147483647;
    return seed / 2147483647;
  };
  const pool = new RpcPool(urls, { fetchImpl, now: () => t, sleep: async (ms) => void (t += ms), random, ...o });
  return { pool, calls, clock: () => t, advance: (ms: number) => void (t += ms) };
}
const ok = (result: unknown) => reply({ jsonrpc: '2.0', id: 1, result });
const hex = (n: number) => '0x' + n.toString(16);
const logs = (from: number, to: number): [string, unknown[]] => ['eth_getLogs', [{ fromBlock: hex(from), toBlock: hex(to) }]];

describe('RPC pool: sharing the work among nodes', () => {
  it('spreads requests over every node instead of using only the first', async () => {
    const f = fixture(['https://a', 'https://b', 'https://c'], () => ok('0x1'), { rps: 50, maxInFlight: 100 });
    await Promise.all(Array.from({ length: 60 }, (_, i) => f.pool.read('eth_getBalance', [hex(i), 'latest'])));
    const per = new Map<string, number>();
    for (const c of f.calls) per.set(c.url, (per.get(c.url) ?? 0) + 1);
    expect(per.size).toBe(3);
    for (const n of per.values()) expect(n).toBeGreaterThan(5);
  });

  it("stays inside each node's allowance: a node given 2 requests a second is not asked faster, so the pool waits instead", async () => {
    const f = fixture(['https://a'], () => ok('0x1'), { rps: 2, maxInFlight: 50 });
    const start = f.clock();
    await Promise.all(Array.from({ length: 12 }, (_, i) => f.pool.read('eth_getBalance', [hex(i), 'latest'])));
    // A bucket of 4 to begin with, then 2 a second: 8 more take about 4 seconds.
    expect(f.clock() - start).toBeGreaterThanOrEqual(3_500);
    expect(f.calls).toHaveLength(12);
  });
});

describe('RPC pool: refusals', () => {
  it("leaves a node that said 429 alone for as long as it asked (Retry-After), and uses the others meanwhile", async () => {
    const f = fixture(['https://a', 'https://b'], (url) => (url === 'https://a' ? reply({}, 429, { 'retry-after': '30' }) : ok('0x2')), { rps: 50 });
    for (let i = 0; i < 6; i++) expect(await f.pool.read('eth_getBalance', [hex(i), 'latest'])).toBe('0x2');
    const aCalls = f.calls.filter((c) => c.url === 'https://a').length;
    expect(aCalls).toBeLessThanOrEqual(1);
    expect(f.pool.health().find((h) => h.url === 'a')).toMatchObject({ state: 'cooling', limited: 1 });
    // After the pause it may be asked again.
    f.advance(31_000);
    expect(f.pool.health().find((h) => h.url === 'a')!.state).toBe('ok');
  });

  it('learns that a node cannot serve a method and does not ask it again for that method, but still asks it for others', async () => {
    const f = fixture(['https://a', 'https://b'], (url, req) => (url === 'https://a' && req.method === 'eth_getLogs' ? reply({ error: { message: 'The method eth_getLogs is not supported.' } }) : ok([])), { rps: 50 });
    for (let i = 0; i < 8; i++) await f.pool.read(...logs(100 + i * 10, 105 + i * 10));
    expect(f.calls.filter((c) => c.url === 'https://a' && c.method === 'eth_getLogs').length).toBe(1);
    for (let i = 0; i < 40; i++) await f.pool.read('eth_getBalance', [hex(i), 'latest']);
    expect(f.calls.some((c) => c.url === 'https://a' && c.method === 'eth_getBalance')).toBe(true);
  });

  it('learns the widest log range a node takes, and sends wide requests to a node that takes them', async () => {
    const f = fixture(['https://narrow', 'https://wide'], (url, req) => {
      const [filter] = req.params as [{ fromBlock: string; toBlock: string }];
      const span = Number.parseInt(filter.toBlock, 16) - Number.parseInt(filter.fromBlock, 16) + 1;
      if (url === 'https://narrow' && span > 100) return reply({ error: { message: 'block range is too wide' } });
      return ok([]);
    }, { rps: 50 });
    for (let i = 0; i < 6; i++) await f.pool.read(...logs(10_000 + i * 2000, 10_000 + i * 2000 + 999));
    const narrowWide = f.calls.filter((c) => c.url === 'https://narrow').length;
    expect(narrowWide).toBeLessThanOrEqual(1);
    // A small range may still go to the narrow node.
    for (let i = 0; i < 30; i++) await f.pool.read(...logs(50_000 + i * 100, 50_000 + i * 100 + 49));
    expect(f.calls.filter((c) => c.url === 'https://narrow').length).toBeGreaterThan(narrowWide);
  });

  it('hands the refusal back so the caller can halve the range, when no node takes it', async () => {
    const f = fixture(['https://a', 'https://b'], () => reply({ error: { message: 'query returned more than 10000 results' } }), { rps: 50 });
    await expect(f.pool.read(...logs(1, 5000))).rejects.toMatchObject({ kind: 'node-error', message: expect.stringContaining('more than 10000') });
  });

  it("returns a node's own error (a revert) at once, without trying the other nodes", async () => {
    const f = fixture(['https://a', 'https://b'], () => reply({ error: { code: 3, message: 'execution reverted' } }), { rps: 50 });
    await expect(f.pool.read('eth_call', [{}, 'latest'])).rejects.toMatchObject({ kind: 'node-error' });
    expect(f.calls).toHaveLength(1);
  });

  it('fails as a transport error when every node is down, within its time budget', async () => {
    const f = fixture(['https://a', 'https://b'], () => {
      throw new Error('network down');
    }, { rps: 50, budgetMs: 5_000 });
    await expect(f.pool.read('eth_blockNumber', [])).rejects.toMatchObject({ kind: 'transport' });
    expect(f.clock() - 1_000_000).toBeLessThan(6_000);
  });
});

describe('RPC pool: asking less often', () => {
  it('answers identical requests made at the same moment with one call', async () => {
    const f = fixture(['https://a'], async () => {
      await Promise.resolve();
      return ok('0x1');
    });
    const out = await Promise.all(Array.from({ length: 10 }, () => f.pool.read('eth_getBalance', ['0xabc', 'latest'])));
    expect(out).toEqual(Array(10).fill('0x1'));
    expect(f.calls).toHaveLength(1);
  });

  it('keeps answers that cannot change, and answers that barely change for a moment, but never "latest" data', async () => {
    const f = fixture(['https://a'], (_, req) => ok(req.method === 'eth_blockNumber' ? hex(1000 + f.calls.length) : { n: 1 }));
    await f.pool.read('eth_getBlockByNumber', [hex(5), false]);
    await f.pool.read('eth_getBlockByNumber', [hex(5), false]);
    expect(f.calls).toHaveLength(1);
    await f.pool.read('eth_getBlockByNumber', ['latest', false]);
    await f.pool.read('eth_getBlockByNumber', ['latest', false]);
    expect(f.calls).toHaveLength(3);
    const head = await f.pool.read('eth_blockNumber', []);
    expect(await f.pool.read('eth_blockNumber', [])).toBe(head);
    f.advance(2_000);
    expect(await f.pool.read('eth_blockNumber', [])).not.toBe(head);
  });

  it('keeps finished log ranges and not open-ended ones, and does not keep an empty receipt (not mined yet)', () => {
    expect(cacheTtlMs('eth_getLogs', [{ fromBlock: '0x1', toBlock: '0x9' }], { result: [] })).toBeGreaterThan(0);
    expect(cacheTtlMs('eth_getLogs', [{ fromBlock: '0x1', toBlock: 'latest' }], { result: [] })).toBe(0);
    expect(cacheTtlMs('eth_getTransactionReceipt', ['0x1'], { result: null })).toBe(0);
    expect(cacheTtlMs('eth_getTransactionReceipt', ['0x1'], { result: { status: '0x1' } })).toBeGreaterThan(0);
    expect(cacheTtlMs('getAccountInfo', ['x'], { result: {} })).toBe(0);
    expect(cacheTtlMs('eth_call', [], { error: { message: 'x' } })).toBe(0);
  });

  it('reads the block span of a getLogs request', () => {
    expect(logRangeOf('eth_getLogs', [{ fromBlock: '0x10', toBlock: '0x1f' }])).toBe(16);
    expect(logRangeOf('eth_getLogs', [{ fromBlock: '0x10', toBlock: 'latest' }])).toBe(0);
    expect(logRangeOf('eth_call', [])).toBe(0);
  });
});

describe('RPC pool: housekeeping', () => {
  it('shows each node by host only (an address can carry a key) with what it has done', async () => {
    const f = fixture(['https://nodes.example.com/v2/SECRETKEY1234567890'], () => ok('0x1'));
    await f.pool.read('eth_blockNumber', []);
    const h = f.pool.health();
    expect(JSON.stringify(h)).not.toContain('SECRETKEY');
    expect(h[0]).toMatchObject({ url: 'nodes.example.com', ok: 1, state: 'ok' });
  });

  it('shares one pool per list of nodes, and never a pool that was given its own fetch', () => {
    resetSharedPools();
    expect(sharedPool(['https://a', 'https://b'])).toBe(sharedPool(['https://a', 'https://b']));
    expect(sharedPool(['https://a', 'https://b'])).not.toBe(sharedPool(['https://a']));
    const fetchImpl = (async () => ok('0x1')) as unknown as typeof fetch;
    expect(sharedPool(['https://a', 'https://b'], { fetchImpl })).not.toBe(sharedPool(['https://a', 'https://b'], { fetchImpl }));
    resetSharedPools();
  });
});
