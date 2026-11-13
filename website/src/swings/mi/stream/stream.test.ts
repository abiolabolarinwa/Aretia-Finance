import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { InMemoryMiStore } from '../store.js';
import type { MiPool, PoolStats } from '../types.js';
import { StreamHub } from './hub.js';
import { publishing, StreamPublisher, updateOf } from './publisher.js';
import { cleanUpdate, createStreamServer } from './server.js';

const KEY = 'bnb:0x' + 'ab'.repeat(20);
const SECRET = 'a-long-test-secret-value';
const stats = (over: Partial<PoolStats> = {}): PoolStats =>
  ({
    asOf: 1,
    price: '1',
    priceUsd: 2,
    quoteUsd: 1,
    change: { m5: 100, h1: 200, h6: 300, h24: 400 },
    volumeQuote: { m5: 1, h1: 2, h6: 3, h24: 4 },
    volumeUsd: { m5: 1, h1: 2, h6: 3, h24: 4 },
    buys: { m5: 1, h1: 2, h6: 3, h24: 4 },
    sells: { m5: 0, h1: 1, h6: 1, h24: 2 },
    maxTradeShare24h: 0.1,
    makers24h: 3,
    liquidityQuote: 10,
    liquidityUsd: 5000,
    ...over,
  }) as PoolStats;

describe('what the worker announces', () => {
  it('turns a pool\'s statistics into the update the page applies', () => {
    const u = updateOf(KEY, stats({ reservePriceUsd: 0.5, windowCapped: true }), 123, 999);
    expect(u).toMatchObject({ key: KEY, at: 999, p_usd: 2, rp: 0.5, ro: false, mk: 3, cp: true, last_trade_at: 123, liquidity_usd: 5000 });
    expect(u.chg).toEqual({ m5: 100, h1: 200, h6: 300, h24: 400 });
    expect(updateOf(KEY, stats({ reservesOnly: true }), undefined, 1).ro).toBe(true);
    expect('last_trade_at' in updateOf(KEY, stats(), undefined, 1)).toBe(false); // a reserve refresh does not know it
  });

  it('collects the newest update per pool, sends one request, and carries the secret', async () => {
    const seen: { url: string; secret: string | null; body: { key: string; p_usd: number }[] }[] = [];
    const fetchImpl = (async (url: string, init: RequestInit) => {
      seen.push({ url, secret: new Headers(init.headers).get('x-stream-secret'), body: JSON.parse(String(init.body)) });
      return new Response(null, { status: 204 });
    }) as unknown as typeof fetch;
    const p = new StreamPublisher({ url: 'http://stream:8090/', secret: SECRET, fetchImpl, flushMs: 10_000 });
    p.push({ ...updateOf(KEY, stats({ priceUsd: 1 }), undefined, 1) });
    p.push({ ...updateOf(KEY, stats({ priceUsd: 2 }), undefined, 2) });
    p.push({ ...updateOf('bnb:0x' + 'cd'.repeat(20), stats(), undefined, 3) });
    await p.flush();
    expect(seen).toHaveLength(1);
    expect(seen[0]!.url).toBe('http://stream:8090/publish');
    expect(seen[0]!.secret).toBe(SECRET);
    expect(seen[0]!.body.map((u) => u.p_usd)).toEqual([2, 2]); // the older update of the first pool is gone
    expect(p.published).toBe(2);
  });

  it('never throws when the service is down or refuses, counts what it dropped, and recovers', async () => {
    let mode: 'down' | 'refuse' | 'ok' = 'down';
    const fetchImpl = (async () => {
      if (mode === 'down') throw new Error('connection refused');
      return new Response(null, { status: mode === 'refuse' ? 401 : 204 });
    }) as unknown as typeof fetch;
    const p = new StreamPublisher({ url: 'http://x', secret: SECRET, fetchImpl, flushMs: 10_000 });
    p.push(updateOf(KEY, stats(), undefined, 1));
    await expect(p.flush()).resolves.toBeUndefined();
    mode = 'refuse';
    p.push(updateOf(KEY, stats(), undefined, 2));
    await p.flush();
    expect(p.failures).toBe(2);
    expect(p.dropped).toBe(2);
    mode = 'ok';
    p.push(updateOf(KEY, stats(), undefined, 3));
    await p.flush();
    expect(p.published).toBe(1);
  });

  it('holds a bounded number of updates, dropping the oldest', () => {
    const p = new StreamPublisher({ url: 'http://x', secret: SECRET, fetchImpl: (async () => new Response(null, { status: 204 })) as unknown as typeof fetch, maxHeld: 2, flushMs: 10_000 });
    for (let i = 0; i < 5; i++) p.push(updateOf('bnb:0x' + String(i).repeat(40), stats(), undefined, i));
    expect(p.dropped).toBe(3);
  });

  it('announces every statistics write of the wrapped store, and only those, without changing what the store does', async () => {
    const sent: string[] = [];
    const publisher = { push: (u: { key: string }) => void sent.push(u.key) } as unknown as StreamPublisher;
    const inner = new InMemoryMiStore();
    const pool = { key: KEY, chain: 'bnb', address: '0x' + 'ab'.repeat(20), adapterId: 'a1', state: 'active', stats: null } as unknown as MiPool;
    await inner.insertPool(pool);
    const store = publishing(inner, publisher, () => 5);
    await store.updatePool(KEY, { reserveBase: '1' }); // no statistics: nothing announced
    await store.updatePool(KEY, { stats: stats() });
    expect(sent).toEqual([KEY]);
    expect((await store.getPools([KEY])).get(KEY)!.stats!.priceUsd).toBe(2); // the write reached the real store
    expect(await store.countPools({})).toBe(1);
  });
});

describe('the stream server', () => {
  const open: { close: () => void }[] = [];
  afterEach(() => {
    for (const o of open.splice(0)) o.close();
  });

  async function start(origins = ['https://aretiafinance.org'], maxPerIp = 20) {
    const hub = new StreamHub({ minIntervalMs: 0 });
    const server = createStreamServer({ hub, secret: SECRET, origins, maxPerIp });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    open.push({ close: () => (hub.closeAll(), server.closeAllConnections(), server.close()) });
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const publish = (body: unknown, secret: string | null = SECRET) => fetch(`${base}/publish`, { method: 'POST', headers: secret ? { 'x-stream-secret': secret } : {}, body: JSON.stringify(body) });
    return { hub, base, publish };
  }

  async function readEvents(res: Response, want: number): Promise<{ key: string; p_usd: number | null }[]> {
    const reader = res.body!.getReader();
    const dec = new TextDecoder();
    let buf = '';
    const out: { key: string; p_usd: number | null }[] = [];
    while (out.length < want) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += dec.decode(value);
      for (const part of buf.split('\n\n').slice(0, -1)) {
        const m = /^event: u\ndata: (.*)$/s.exec(part);
        if (m) out.push(...(JSON.parse(m[1]!) as { key: string; p_usd: number | null }[]));
      }
      buf = buf.slice(buf.lastIndexOf('\n\n') + 2);
    }
    void reader.cancel();
    return out;
  }

  it('streams a published update to a viewer of that pool, with the site allowed to read it', async () => {
    const s = await start();
    const res = await fetch(`${s.base}/stream?keys=${KEY}`, { headers: { origin: 'https://aretiafinance.org' } });
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/event-stream');
    expect(res.headers.get('access-control-allow-origin')).toBe('https://aretiafinance.org');
    expect(res.headers.get('cache-control')).toBe('no-store');
    const got = readEvents(res, 1);
    await new Promise((r) => setTimeout(r, 50));
    expect((await s.publish([updateOf(KEY, stats({ priceUsd: 42 }), undefined, Date.now())])).status).toBe(204);
    expect(await got).toEqual([expect.objectContaining({ key: KEY, p_usd: 42 })]);
  });

  it('refuses another site, a bad pool name and too many pools', async () => {
    const s = await start();
    expect((await fetch(`${s.base}/stream?keys=${KEY}`, { headers: { origin: 'https://evil.example' } })).status).toBe(403);
    expect((await fetch(`${s.base}/stream?keys=not-a-key`)).status).toBe(400);
    expect((await fetch(`${s.base}/stream`)).status).toBe(400);
    const many = Array.from({ length: 101 }, (_, i) => `bnb:0x${String(i).padStart(40, '0')}`).join(',');
    expect((await fetch(`${s.base}/stream?keys=${many}`)).status).toBe(400);
  });

  it('limits the connections of one address', async () => {
    const s = await start(['https://aretiafinance.org'], 2);
    const a = await fetch(`${s.base}/stream?keys=${KEY}`);
    const b = await fetch(`${s.base}/stream?keys=${KEY}`);
    expect([a.status, b.status]).toEqual([200, 200]);
    expect((await fetch(`${s.base}/stream?keys=${KEY}`)).status).toBe(429);
    void a.body?.cancel();
    await new Promise((r) => setTimeout(r, 50));
    const c = await fetch(`${s.base}/stream?keys=${KEY}`);
    expect(c.status).toBe(200); // a slot was freed when one viewer left
    void b.body?.cancel();
    void c.body?.cancel();
  });

  it('accepts updates only with the secret, and keeps only the known fields of a valid one', async () => {
    const s = await start();
    expect((await s.publish([], null)).status).toBe(401);
    expect((await s.publish([], 'wrong-secret-of-the-same!')).status).toBe(401);
    expect((await s.publish({ not: 'a list' })).status).toBe(400);
    expect((await s.publish([{ key: 'nonsense', at: 1 }])).status).toBe(204); // invalid items are skipped, not fatal
    expect(s.hub.received).toBe(0);
    expect(cleanUpdate({ key: KEY, at: 1, p_usd: 3, evil: '<script>', chg: { m5: 1, h1: 'x', h6: null, h24: 2 }, buys: { m5: 1 } })).toMatchObject({ key: KEY, p_usd: 3, chg: { m5: 1, h1: null, h6: null, h24: 2 }, buys: null });
    expect(cleanUpdate({ key: KEY })).toBeNull();
    expect(cleanUpdate({ key: 'bnb:short', at: 1 })).toBeNull();
    expect('evil' in (cleanUpdate({ key: KEY, at: 1, evil: 1 }) as object)).toBe(false);
  });

  it('answers a health check and nothing else', async () => {
    const s = await start();
    const h = await fetch(`${s.base}/health`);
    expect(await h.json()).toMatchObject({ ok: true, clients: 0 });
    expect((await fetch(`${s.base}/anything`)).status).toBe(404);
    expect((await fetch(`${s.base}/publish`)).status).toBe(404); // a GET is not a publish
  });
});
