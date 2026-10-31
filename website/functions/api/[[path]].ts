/**
 * Cloudflare Pages Function: forwards every /api/* request to the API that still runs on Vercel.
 * Set API_ORIGIN (the project's *.vercel.app address, no trailing slash) and CF_PROXY_SECRET in the Pages project settings.
 *
 * Vercel sees this Worker as the caller, so the visitor's real address goes along in a header that Vercel only trusts
 * when it comes with the shared secret (see api/_clientIp.ts). Everything else, Origin and Referer included, passes through.
 */
interface Env {
  API_ORIGIN?: string;
  CF_PROXY_SECRET?: string;
}

const DROP = new Set(['host', 'cf-connecting-ip', 'cf-ray', 'cf-visitor', 'cf-ipcountry', 'x-forwarded-for', 'x-real-ip', 'x-aretia-proxy-secret', 'x-aretia-client-ip']);

/** Public, shared reads that Vercel marks cacheable (s-maxage). Kept at Cloudflare's edge so a visitor is not sent to Vercel in the US for each one. */
const EDGE_CACHED = new Set(['/api/swings-ohlcv']);
/** The Market Indexer's public read API: every GET under it is shared data, and the answer says how long it may be kept (s-maxage). */
const edgeCacheable = (pathname: string): boolean => EDGE_CACHED.has(pathname) || pathname === '/api/v1' || pathname.startsWith('/api/v1/');

export async function onRequest(context: { request: Request; env: Env; waitUntil?: (p: Promise<unknown>) => void }): Promise<Response> {
  const { request, env } = context;
  if (!env.API_ORIGIN || !env.CF_PROXY_SECRET) return new Response(JSON.stringify({ error: 'API is not configured' }), { status: 503, headers: { 'content-type': 'application/json' } });
  const incoming = new URL(request.url);
  const target = new URL(incoming.pathname + incoming.search, env.API_ORIGIN);
  const headers = new Headers();
  request.headers.forEach((value, key) => {
    if (!DROP.has(key)) headers.set(key, value);
  });
  headers.set('x-aretia-proxy-secret', env.CF_PROXY_SECRET);
  headers.set('x-aretia-client-ip', request.headers.get('cf-connecting-ip') ?? '');
  const hasBody = request.method !== 'GET' && request.method !== 'HEAD';
  const edge = request.method === 'GET' && edgeCacheable(incoming.pathname) ? (caches as unknown as { default: Cache }).default : null;
  // The cache key is the public URL alone: nothing the visitor sent (cookies, headers) changes a public candle answer.
  const cacheKey = new Request(incoming.toString(), { method: 'GET' });
  // The edge cache is only a speed-up: if reading or writing it fails, the visitor still gets the answer from the API.
  if (edge) {
    try {
      const hit = await edge.match(cacheKey);
      if (hit) return hit;
    } catch {
      // fall through to the API
    }
  }
  let res: Response;
  try {
    res = await fetch(target, { method: request.method, headers, body: hasBody ? request.body : undefined, redirect: 'manual' });
  } catch (e) {
    // Say what failed instead of showing an anonymous gateway page.
    return new Response(JSON.stringify({ error: 'The API could not be reached', detail: e instanceof Error ? e.message.slice(0, 200) : 'unknown' }), { status: 502, headers: { 'content-type': 'application/json', 'cache-control': 'no-store' } });
  }
  // Only an answer Vercel marked as shareable (a stale or refused one says no-store) is kept.
  if (edge && res.status === 200 && /s-maxage=\d+/.test(res.headers.get('cache-control') ?? '')) {
    try {
      const keep = edge.put(cacheKey, res.clone()).catch(() => undefined);
      if (context.waitUntil) context.waitUntil(keep);
      else await keep;
    } catch {
      // not cached this time
    }
  }
  return res;
}
