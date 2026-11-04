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
      // another list has nothing kept: the error stays an error
      globalThis.fetch = (async () => new Response('{"error":"source"}', { status: 502 })) as typeof fetch;
      expect((await call('https://x.org/api/swings-market?kind=new&chain=bnb')).status).toBe(502);
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
      expect(out.status).toBe(502);
      expect(out.headers.get('content-type')).toContain('json');
      expect(await out.json()).toEqual({ error: 'source', retryAfter: 36 });
    } finally {
      globalThis.fetch = real;
    }
  });
});
