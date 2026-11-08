import { describe, expect, it } from 'vitest';
import { onRequest } from '../functions/api/[[path]].js';

/** A stand-in for the edge cache: it keeps what is put and gives it back by URL. */
function fakeCache(): { match(r: Request): Promise<Response | undefined>; put(r: Request, res: Response): Promise<void>; expireFresh(): void } {
  const store = new Map<string, Response>();
  return {
    async match(r) {
      return store.get(r.url)?.clone();
    },
    async put(r, res) {
      store.set(r.url, res.clone());
    },
    /** A minute passes: the short-lived copies go, the day-long ones stay. */
    expireFresh() {
      for (const k of [...store.keys()]) if (!k.endsWith('#last-good')) store.delete(k);
    },
  };
}

describe('the API forwarder keeps the last good Marketplace list', () => {
  const env = { API_ORIGIN: 'https://api.example', CF_PROXY_SECRET: 's' };
  const good = JSON.stringify({ rows: [{ symbol: 'A' }], stale: false, at: 1 });
  const call = (url: string) => onRequest({ request: new Request(url), env });

  it('serves it, marked old, when the API answers an error or cannot be reached', async () => {
    const cache = fakeCache();
    (globalThis as unknown as { caches: unknown }).caches = { default: cache };
    const real = globalThis.fetch;
    try {
      globalThis.fetch = (async () => new Response(good, { status: 200, headers: { 'cache-control': 'public, s-maxage=60' } })) as typeof fetch;
      expect((await call('https://x.org/api/swings-market?kind=top&chain=bnb')).status).toBe(200);
      // another list has nothing kept: the error stays an error (a 503, which Cloudflare leaves alone)
      globalThis.fetch = (async () => new Response('{"error":"source"}', { status: 502 })) as typeof fetch;
      expect((await call('https://x.org/api/swings-market?kind=new&chain=bnb')).status).toBe(503);
      cache.expireFresh();
      // the short-lived copy is gone; the long-lived one answers the error
      const err = await call('https://x.org/api/swings-market?kind=top&chain=bnb');
      expect(err.status).toBe(200);
      expect(await err.json()).toMatchObject({ rows: [{ symbol: 'A' }], stale: true });
      globalThis.fetch = (async () => {
        throw new Error('down');
      }) as typeof fetch;
      expect((await call('https://x.org/api/swings-market?kind=top&chain=bnb')).status).toBe(200);
    } finally {
      globalThis.fetch = real;
    }
  });

  it('hands on the API’s JSON reason when it answers a gateway error', async () => {
    (globalThis as unknown as { caches: unknown }).caches = { default: fakeCache() };
    const real = globalThis.fetch;
    try {
      globalThis.fetch = (async () => new Response('{"error":"source","retryAfter":36}', { status: 502, headers: { 'content-type': 'application/json', 'content-length': '9999' } })) as typeof fetch;
      const out = await call('https://x.org/api/swings-ohlcv?chain=solana&pool=P');
      expect(out.status).toBe(503);
      expect(out.headers.get('content-type')).toContain('json');
      expect(await out.json()).toEqual({ error: 'source', retryAfter: 36 });
    } finally {
      globalThis.fetch = real;
    }
  });

  describe('candles', () => {
    const rows = (from: number, n: number) => Array.from({ length: n }, (_, i) => [from - i * 900, 1, 2, 0.5, 1.5, 10]);
    const answer = (list: number[][], source = 'geckoterminal') => JSON.stringify({ data: { attributes: { ohlcv_list: list } }, source, stale: false });
    const url = (before: number, extra = '') => `https://x.org/api/swings-ohlcv?chain=bnb&pool=0xABC&tf=minute&agg=15&before=${before}&limit=3&token=base&currency=usd${extra}`;

    it('serves the last good candles of the pool, cut to the window asked for and marked old, when the price service fails for a new window', async () => {
      const cache = fakeCache();
      (globalThis as unknown as { caches: unknown }).caches = { default: cache };
      const real = globalThis.fetch;
      try {
        globalThis.fetch = (async () => new Response(answer(rows(9000, 10)), { status: 200, headers: { 'cache-control': 'public, s-maxage=60' } })) as typeof fetch;
        expect((await call(url(9900))).status).toBe(200);
        cache.expireFresh();
        globalThis.fetch = (async () => new Response('{"error":"source","upstream":429}', { status: 502, headers: { 'content-type': 'application/json' } })) as typeof fetch;
        const out = await call(url(8100)); // a different window, never seen
        expect(out.status).toBe(200);
        const body = (await out.json()) as { stale: boolean; source: string; data: { attributes: { ohlcv_list: number[][] } } };
        expect(body.stale).toBe(true);
        expect(body.source).toBe('geckoterminal-stale');
        expect(body.data.attributes.ohlcv_list.map((r) => r[0])).toEqual([8100, 7200, 6300]); // only candles at or before the asked-for time, limit 3
        // the pool's address is compared without case; a window older than anything kept has no stale answer
        globalThis.fetch = (async () => {
          throw new Error('down');
        }) as typeof fetch;
        expect((await call(url(8100).replace('0xABC', '0xabc'))).status).toBe(200);
        expect((await call(url(100))).status).toBe(503);
      } finally {
        globalThis.fetch = real;
      }
    });

    it('does not keep an empty answer, or one built from Aretia\'s own index', async () => {
      const cache = fakeCache();
      (globalThis as unknown as { caches: unknown }).caches = { default: cache };
      const real = globalThis.fetch;
      try {
        globalThis.fetch = (async () => new Response(answer([]), { status: 200, headers: { 'cache-control': 'public, s-maxage=60' } })) as typeof fetch;
        await call(url(9900));
        globalThis.fetch = (async () => new Response(answer(rows(9000, 5), 'aretia-index'), { status: 200, headers: { 'cache-control': 'public, s-maxage=60' } })) as typeof fetch;
        await call(url(9901));
        cache.expireFresh();
        globalThis.fetch = (async () => new Response('{"error":"source"}', { status: 502, headers: { 'content-type': 'application/json' } })) as typeof fetch;
        expect((await call(url(9902))).status).toBe(503);
      } finally {
        globalThis.fetch = real;
      }
    });

    it('turns a plain-text gateway error or an unreachable API into a JSON 503 that says who failed', async () => {
      (globalThis as unknown as { caches: unknown }).caches = { default: fakeCache() };
      const real = globalThis.fetch;
      try {
        globalThis.fetch = (async () => new Response('Bad gateway', { status: 502, headers: { 'content-type': 'text/plain' } })) as typeof fetch;
        const a = await call(url(7000));
        expect(a.status).toBe(503);
        expect(await a.json()).toEqual({ error: 'The API answered with an error', upstream: 502 });
        globalThis.fetch = (async () => {
          throw new Error('connection lost');
        }) as typeof fetch;
        const b = await call(url(7001));
        expect(b.status).toBe(503);
        expect(await b.json()).toMatchObject({ error: 'The API could not be reached', detail: 'connection lost' });
      } finally {
        globalThis.fetch = real;
      }
    });
  });

  it('serves the kept list when the API says it could not read one', async () => {
    (globalThis as unknown as { caches: unknown }).caches = { default: fakeCache() };
    const real = globalThis.fetch;
    try {
      globalThis.fetch = (async () => new Response(good, { status: 200, headers: { 'cache-control': 'public, s-maxage=60' } })) as typeof fetch;
      await call('https://x.org/api/swings-market?kind=top&chain=base');
      globalThis.fetch = (async () => new Response('{"rows":[],"stale":true,"error":"source"}', { status: 200, headers: { 'cache-control': 'no-store' } })) as typeof fetch;
      const url = 'https://x.org/api/swings-market?kind=top&chain=base&v=2';
      expect(await (await call(url)).json()).toMatchObject({ error: 'source' });
      const same = await call('https://x.org/api/swings-market?kind=top&chain=base');
      expect(await same.json()).toMatchObject({ rows: [{ symbol: 'A' }] });
    } finally {
      globalThis.fetch = real;
    }
  });
});
