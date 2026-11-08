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
  /** Comma-separated origins of the native apps that may call the API from inside the app (capacitor://localhost, https://localhost). Empty: no cross-origin access. */
  APP_ORIGINS?: string;
}

const DROP = new Set(['host', 'cf-connecting-ip', 'cf-ray', 'cf-visitor', 'cf-ipcountry', 'x-forwarded-for', 'x-real-ip', 'x-aretia-proxy-secret', 'x-aretia-client-ip']);

/** Public, shared reads that Vercel marks cacheable (s-maxage). Kept at Cloudflare's edge so a visitor is not sent to Vercel in the US for each one. */
const EDGE_CACHED = new Set(['/api/swings-ohlcv', '/api/swings-market']);
/** The Marketplace lists also keep a long-lived copy of the last good answer, served (marked old) when the API fails or the source refuses. */
const LAST_GOOD = '/api/swings-market';
const LAST_GOOD_SECONDS = 86_400;
/**
 * Candles keep a day-long copy per pool and candle size (not per time window), served marked old, and cut to the window asked for, when the
 * API or the price service fails or refuses. The free price service allows each caller only a few requests a minute, so a burst of opens
 * (or a quiet minute after one) would otherwise leave the chart empty although the same pool was read a moment ago.
 */
const CANDLES = '/api/swings-ohlcv';
const CANDLES_KEPT_SECONDS = 86_400;
function candlesKey(u: URL): Request | null {
  if (u.pathname !== CANDLES || u.searchParams.has('source')) return null;
  const chain = u.searchParams.get('chain') ?? '';
  const pool = u.searchParams.get('pool') ?? '';
  const q = new URLSearchParams();
  q.set('chain', chain);
  q.set('pool', chain === 'solana' ? pool : pool.toLowerCase());
  for (const k of ['tf', 'agg', 'token', 'currency']) q.set(k, u.searchParams.get(k) ?? '');
  return new Request(`${u.origin}${u.pathname}?${q.toString()}#last-good`, { method: 'GET' });
}
type CandleRow = number[];
const candleRows = (body: unknown): CandleRow[] => {
  const list = (body as { data?: { attributes?: { ohlcv_list?: unknown } } } | null)?.data?.attributes?.ohlcv_list;
  return Array.isArray(list) ? (list.filter((r) => Array.isArray(r) && r.length >= 6 && Number.isFinite(Number(r[0]))) as CandleRow[]) : [];
};

/** The Market Indexer's public read API: every GET under it is shared data, and the answer says how long it may be kept (s-maxage). */
const edgeCacheable = (pathname: string): boolean => EDGE_CACHED.has(pathname) || pathname === '/api/v1' || pathname.startsWith('/api/v1/');

async function handle(context: { request: Request; env: Env; waitUntil?: (p: Promise<unknown>) => void }): Promise<Response> {
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
    if (!edge || request.method !== 'GET') return null;
    const candleCopy = candlesKey(incoming);
    if (candleCopy) {
      try {
        const kept = await edge.match(candleCopy);
        if (!kept) return null;
        const before = Number(incoming.searchParams.get('before'));
        const limit = Math.min(1000, Math.max(1, Math.floor(Number(incoming.searchParams.get('limit')) || 300)));
        // Rows are newest first; only candles that opened at or before the asked-for time belong to this window.
        const rows = candleRows(await kept.json()).filter((r) => !Number.isFinite(before) || r[0]! <= before).slice(0, limit);
        if (rows.length === 0) return null;
        return new Response(JSON.stringify({ data: { attributes: { ohlcv_list: rows } }, source: 'geckoterminal-stale', stale: true }), { status: 200, headers: { 'content-type': 'application/json', 'cache-control': 'no-store' } });
      } catch {
        return null;
      }
    }
    if (incoming.pathname !== LAST_GOOD) return null;
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
    // A 503, not a 502: Cloudflare swaps even a 502 made here for its own plain page, which hides this reason from the chart.
    return new Response(JSON.stringify({ error: 'The API could not be reached', detail: e instanceof Error ? e.message.slice(0, 200) : 'unknown' }), { status: 503, headers: { 'content-type': 'application/json', 'cache-control': 'no-store' } });
  }
  // The API answers a list it could not read as 200 with no rows and an error, so the older copy kept here is better.
  if (incoming.pathname === LAST_GOOD && res.status === 200 && !(res.headers.get('cache-control') ?? '').includes('s-maxage')) {
    const failed = await res.clone().json().then((b: { error?: unknown }) => typeof b?.error === 'string').catch(() => false);
    if (failed) {
      const old = await oldCopy();
      if (old) return old;
    }
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
  // Keep the last good candles of this pool and candle size for a day (never an old or index-built answer, never an empty one).
  const candleKeep = edge && res.status === 200 && /s-maxage=\d+/.test(res.headers.get('cache-control') ?? '') ? candlesKey(incoming) : null;
  if (edge && candleKeep) {
    try {
      const copy = res.clone();
      const keepCandles = copy
        .text()
        .then((text) => {
          const body = JSON.parse(text) as { source?: string; stale?: boolean };
          if (body.source !== 'geckoterminal' || body.stale === true || candleRows(body).length === 0) return undefined;
          return edge.put(candleKeep, new Response(text, { headers: { 'content-type': 'application/json', 'cache-control': `public, max-age=${CANDLES_KEPT_SECONDS}` } }));
        })
        .catch(() => undefined);
      if (context.waitUntil) context.waitUntil(keepCandles);
      else await keepCandles;
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
    // Cloudflare swaps even a re-made 502 or 504 for its own page, so the reason travels as a 503, which it leaves alone.
    return new Response(await res.text(), { status: res.status === 502 || res.status === 504 ? 503 : res.status, headers: out });
  }
  // A plain-text gateway error (Vercel's or the network's) would reach the page as an anonymous 502: hand on a JSON 503 that says who failed.
  if (res.status >= 500) return new Response(JSON.stringify({ error: 'The API answered with an error', upstream: res.status }), { status: 503, headers: { 'content-type': 'application/json', 'cache-control': 'no-store' } });
  return res;
}

/**
 * Cross-origin access for the native apps only. The apps load the site from capacitor://localhost or https://localhost, so their API
 * calls are cross-origin. Only the origins listed in APP_ORIGINS get the headers; with none listed the website behaves as before.
 */
export async function onRequest(context: { request: Request; env: Env; waitUntil?: (p: Promise<unknown>) => void }): Promise<Response> {
  const origin = context.request.headers.get('origin') ?? '';
  const allowed = (context.env.APP_ORIGINS ?? '').split(',').map((s) => s.trim()).filter(Boolean);
  if (!origin || !allowed.includes(origin)) return handle(context);
  const cors: Record<string, string> = { 'access-control-allow-origin': origin, vary: 'Origin' };
  if (context.request.method === 'OPTIONS') {
    return new Response(null, {
      status: 204,
      headers: {
        ...cors,
        'access-control-allow-methods': 'GET, POST, PUT, DELETE, OPTIONS',
        'access-control-allow-headers': context.request.headers.get('access-control-request-headers') ?? 'content-type',
        'access-control-max-age': '86400',
      },
    });
  }
  const res = await handle(context);
  const out = new Response(res.body, res);
  for (const [k, v] of Object.entries(cors)) out.headers.set(k, v);
  return out;
}
