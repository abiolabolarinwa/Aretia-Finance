/**
 * Core of the Solana RPC proxy behind aretiafinance.org/api/rpc. No framework types, so it can be
 * tested on its own. The wallet page sends JSON-RPC here instead of straight to a public endpoint,
 * so the provider key (SOLANA_RPC_URL) stays on the server and the browser never sees it.
 *
 * What it enforces, and what it cannot:
 *  - Only POST from an allowed browser origin, a single JSON-RPC object, a short list of methods.
 *    The origin check stops other websites using the key from a browser; it cannot stop a script
 *    that fakes the header. Set a rate limit and a domain allowlist on the key at the provider too.
 *  - A per-IP limit held in memory. Serverless instances do not share memory, so this is a
 *    best-effort brake, not a guarantee.
 *  - It forwards only the fields it validated, never the caller's raw body or headers.
 */

/** Read methods and the transaction calls the wallet page needs. Everything else is refused. */
export const ALLOWED_METHODS: ReadonlySet<string> = new Set([
  'getAccountInfo',
  'getMultipleAccounts',
  'getBalance',
  'getBlockHeight',
  'getEpochInfo',
  'getFeeForMessage',
  'getLatestBlockhash',
  'getMinimumBalanceForRentExemption',
  'getRecentPrioritizationFees',
  'getSignatureStatuses',
  'getSignaturesForAddress',
  'getSlot',
  'getTokenAccountBalance',
  'getTokenAccountsByOwner',
  'getTokenLargestAccounts',
  'getTransaction',
  'isBlockhashValid',
  'sendTransaction',
  'simulateTransaction',
]);

export const PUBLIC_FALLBACK_RPC = 'https://solana-rpc.publicnode.com';
export const MAX_BODY_BYTES = 16 * 1024;
export const RATE_LIMIT = { perMinute: 120 };
const UPSTREAM_TIMEOUT_MS = 15_000;
/** Public production origins; extra ones (previews, staging) come from RPC_ALLOWED_ORIGINS. */
const BASE_ORIGINS = ['https://aretiafinance.org', 'https://www.aretiafinance.org'];

export interface ProxyEnv {
  SOLANA_RPC_URL?: string;
  RPC_ALLOWED_ORIGINS?: string;
  /** Vercel sets this to "production", "preview" or "development". */
  VERCEL_ENV?: string;
}

export interface ProxyInput {
  method: string;
  origin: string | null;
  ip: string;
  contentType: string | null;
  body: string;
  env: ProxyEnv;
  fetchImpl: typeof fetch;
  now: number;
}

export interface ProxyOutput {
  status: number;
  body: string;
  headers: Record<string, string>;
}

// ------------------------------------------------------------------ origin

export function allowedOrigins(env: ProxyEnv): string[] {
  const extra = (env.RPC_ALLOWED_ORIGINS ?? '').split(',').map((s) => s.trim()).filter(Boolean);
  return [...BASE_ORIGINS, ...extra];
}

/**
 * The origin a request really comes from. Browsers send an Origin header on cross-site requests and on same-site
 * requests that change something, but NOT on a plain same-site GET, so the page asking its own server for settings
 * arrived with no origin and was refused. For that case only, the browser's own Sec-Fetch-Site: same-origin marker
 * (which page scripts cannot set) lets the Referer's origin stand in. Anything else still needs a real Origin header.
 */
export function requestOrigin(headers: Record<string, string | string[] | undefined>): string | null {
  const one = (v: string | string[] | undefined): string | null => (Array.isArray(v) ? (v[0] ?? null) : (v ?? null));
  const origin = one(headers.origin);
  if (origin) return origin;
  if (one(headers['sec-fetch-site']) !== 'same-origin') return null;
  const referer = one(headers.referer);
  if (!referer) return null;
  try {
    return new URL(referer).origin;
  } catch {
    return null;
  }
}

export function isOriginAllowed(origin: string | null, env: ProxyEnv): boolean {
  if (!origin) return false;
  if (allowedOrigins(env).includes(origin)) return true;
  // Local development only, never on the production deployment.
  return env.VERCEL_ENV !== 'production' && /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin);
}

function corsHeaders(origin: string | null, env: ProxyEnv): Record<string, string> {
  const headers: Record<string, string> = { vary: 'origin', 'cache-control': 'no-store' };
  if (isOriginAllowed(origin, env)) {
    headers['access-control-allow-origin'] = origin!;
    headers['access-control-allow-methods'] = 'POST, OPTIONS';
    headers['access-control-allow-headers'] = 'content-type';
    headers['access-control-max-age'] = '600';
  }
  return headers;
}

// ------------------------------------------------------------------ rate limit

const buckets = new Map<string, { count: number; windowStart: number }>();

/** True if this caller is over the limit. Old entries are dropped so the map cannot grow without bound. */
export function overLimit(ip: string, now: number): boolean {
  if (buckets.size > 5000) {
    for (const [key, b] of buckets) if (now - b.windowStart > 60_000) buckets.delete(key);
  }
  const b = buckets.get(ip);
  if (!b || now - b.windowStart > 60_000) {
    buckets.set(ip, { count: 1, windowStart: now });
    return false;
  }
  b.count += 1;
  return b.count > RATE_LIMIT.perMinute;
}

export function resetRateLimit(): void {
  buckets.clear();
}

// ------------------------------------------------------------------ handling

function rpcError(status: number, id: unknown, code: number, message: string, headers: Record<string, string>): ProxyOutput {
  return { status, headers: { ...headers, 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: id ?? null, error: { code, message } }) };
}

export async function proxyRpc(input: ProxyInput): Promise<ProxyOutput> {
  const { env } = input;
  const headers = corsHeaders(input.origin, env);

  if (input.method === 'OPTIONS') {
    return isOriginAllowed(input.origin, env) ? { status: 204, body: '', headers } : { status: 403, body: '', headers };
  }
  if (input.method !== 'POST') return rpcError(405, null, -32600, 'Use POST.', { ...headers, allow: 'POST, OPTIONS' });
  if (!isOriginAllowed(input.origin, env)) return rpcError(403, null, -32600, 'This origin is not allowed.', headers);
  if (!(input.contentType ?? '').toLowerCase().includes('application/json')) return rpcError(415, null, -32600, 'Send JSON.', headers);
  if (new TextEncoder().encode(input.body).length > MAX_BODY_BYTES) return rpcError(413, null, -32600, 'Request too large.', headers);

  let parsed: unknown;
  try {
    parsed = JSON.parse(input.body);
  } catch {
    return rpcError(400, null, -32700, 'Invalid JSON.', headers);
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return rpcError(400, null, -32600, 'Send a single JSON-RPC request, not a batch.', headers);
  }
  const call = parsed as { jsonrpc?: unknown; id?: unknown; method?: unknown; params?: unknown };
  const id = typeof call.id === 'number' || typeof call.id === 'string' ? call.id : null;
  if (call.jsonrpc !== '2.0' || typeof call.method !== 'string') return rpcError(400, id, -32600, 'Not a JSON-RPC 2.0 request.', headers);
  if (!ALLOWED_METHODS.has(call.method)) return rpcError(403, id, -32601, `${call.method} is not available through this proxy.`, headers);
  if (call.params !== undefined && !Array.isArray(call.params)) return rpcError(400, id, -32602, 'params must be an array.', headers);

  if (overLimit(input.ip, input.now)) return rpcError(429, id, -32005, 'Too many requests. Try again in a minute.', { ...headers, 'retry-after': '60' });

  const upstream = env.SOLANA_RPC_URL?.trim() || PUBLIC_FALLBACK_RPC;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), UPSTREAM_TIMEOUT_MS);
  try {
    const res = await input.fetchImpl(upstream, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      // Only what was validated above; the caller's extra fields are dropped.
      body: JSON.stringify({ jsonrpc: '2.0', id, method: call.method, params: call.params ?? [] }),
      signal: controller.signal,
    });
    const text = await res.text();
    if (!res.ok) {
      // Never relay an upstream error page: it can name the endpoint or the key's plan.
      return rpcError(res.status === 429 ? 429 : 502, id, -32003, 'The RPC provider could not complete that request.', headers);
    }
    return { status: 200, body: text, headers: { ...headers, 'content-type': 'application/json' } };
  } catch {
    return rpcError(504, id, -32003, 'The RPC provider did not answer in time.', headers);
  } finally {
    clearTimeout(timer);
  }
}
