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
const EDGE_CACHED = new Set(['/api/swings-ohlcv', '/api/swings-market']);
/** The Marketplace lists also keep a long-lived copy of the last good answer, served (marked old) when the API fails or the source refuses. */
const LAST_GOOD = '/api/swings-market';
const LAST_GOOD_SECONDS = 86_400;
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
  const lastKey = new Request(`${incoming.toString()}#last-good`, { method: 'GET' });
  /** The last good list, as a normal answer that says it is old and from when, or null when none was kept. */
  const oldCopy = async (): Promise<Response | null> => {
    if (!edge || incoming.pathname !== LAST_GOOD || request.method !== 'GET') return null;
    try {
      const kept = await edge.match(lastKey);
      if (!kept) return null;
      const body = (await kept.json()) as Record<string, unknown>;
      const at = Number(kept.headers.get('x-aretia-saved'));
      return new Response(JSON.stringify({ ...body, stale: true, at: Number.isFinite(at) && at > 0 ? at : body.at }), { status: 200, headers: { 'content-type': 'application/json', 'cache-control': 'no-store' } });
    } catch {
      return null;
    }
  };
  let res: Response;
  try {
    res = await fetch(target, { method: request.method, headers, body: hasBody ? request.body : undefined, redirect: 'manual' });
  } catch (e) {
    const old = await oldCopy();
    if (old) return old;
    // Say what failed instead of showing an anonymous gateway page.
    return new Response(JSON.stringify({ error: 'The API could not be reached', detail: e instanceof Error ? e.message.slice(0, 200) : 'unknown' }), { status: 502, headers: { 'content-type': 'application/json', 'cache-control': 'no-store' } });
  }
  if (res.status >= 500 || res.status === 429) {
    const old = await oldCopy();
    if (old) return old;
  }
  // Keep the last good Marketplace list for a day, for the times the source or the API fails.
  if (edge && incoming.pathname === LAST_GOOD && res.status === 200 && /s-maxage=\d+/.test(res.headers.get('cache-control') ?? '')) {
    try {
      const copy = res.clone();
      const keepLast = copy.text().then((text) => edge.put(lastKey, new Response(text, { headers: { 'content-type': 'application/json', 'cache-control': `public, max-age=${LAST_GOOD_SECONDS}`, 'x-aretia-saved': String(Date.now()) } }))).catch(() => undefined);
      if (context.waitUntil) context.waitUntil(keepLast);
      else await keepLast;
    } catch {
      // not kept this time
    }
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
  // A gateway error passed straight through is replaced by Cloudflare's own plain "error code: 502" page, which hides the API's JSON reason
  // from the page. Handing the same status, headers and body on as a new response keeps what the API said.
  if (res.status >= 500 && /json/.test(res.headers.get('content-type') ?? '')) {
    const out = new Headers(res.headers);
    out.set('cache-control', 'no-store');
    out.delete('content-length');
    out.delete('content-encoding');
    return new Response(await res.text(), { status: res.status, headers: out });
  }
  return res;
}
