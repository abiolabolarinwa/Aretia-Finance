/**
 * /api/swings-radar: the wallet's door to the Aretia Radar server.
 *
 *   GET  ?op=home                  what Radar has analyzed lately, grouped for the Radar page
 *   GET  ?op=asset&assetId=        the stored analysis of one token
 *   POST ?op=analyze  {assetId}    analyze one token now (spends provider quota, so it is limited harder)
 *
 * The Radar server needs a secret key and must not be exposed to every page, so the browser never talks to it: this
 * function holds RADAR_API_URL and RADAR_API_KEY, accepts only the three operations above, checks the token id before
 * building any upstream address, and never passes the server's own error text on. Radar only reads and explains; nothing
 * here can trade, sign or send.
 */
import { isOriginAllowed, overLimit, type ProxyEnv } from './_rpcProxy.js';

export interface RadarEnv extends ProxyEnv {
  RADAR_API_URL?: string;
  RADAR_API_KEY?: string;
}

export interface RadarInput {
  method: string;
  origin: string | null;
  ip: string;
  query: Record<string, string | undefined>;
  body: unknown;
  env: RadarEnv;
  fetchImpl: typeof fetch;
  now: number;
}

export interface RadarOutput {
  status: number;
  body: string;
  headers: Record<string, string>;
}

const SOLANA = /^solana:[1-9A-HJ-NP-Za-km-z]{32,44}$/;
const EVM = /^(ethereum|base|bnb|polygon):(0x[0-9a-fA-F]{40})$/;
const MAX_BYTES = 1_000_000;
/** Analyses per caller per minute, and across all callers: an analysis spends the Radar server's data-provider quota. */
const ANALYZE_PER_IP = 6;
const ANALYZE_ALL = 60;
const HOME_KEEP_MS = 30_000;

const analyzeLog = new Map<string, number[]>();
let homeCache: { at: number; body: string } | null = null;

export function resetRadarProxy(): void {
  analyzeLog.clear();
  homeCache = null;
}

const json = (status: number, data: unknown, headers: Record<string, string>): RadarOutput => ({ status, body: JSON.stringify(data), headers: { ...headers, 'content-type': 'application/json' } });

/** The canonical Radar asset id, or null. EVM addresses are lower-cased so one token is never held twice. */
export function radarAssetId(input: unknown): string | null {
  if (typeof input !== 'string') return null;
  const id = input.trim();
  if (SOLANA.test(id)) return id;
  const m = EVM.exec(id);
  return m ? `${m[1]}:${m[2]!.toLowerCase()}` : null;
}

function analyzeLimited(ip: string, now: number): boolean {
  const recent = (key: string): number[] => (analyzeLog.get(key) ?? []).filter((t) => now - t < 60_000);
  const mine = recent(ip);
  const all = recent('*');
  if (mine.length >= ANALYZE_PER_IP || all.length >= ANALYZE_ALL) return true;
  analyzeLog.set(ip, [...mine, now]);
  analyzeLog.set('*', [...all, now]);
  if (analyzeLog.size > 5000) for (const [k, v] of analyzeLog) if (k !== '*' && v.every((t) => now - t >= 60_000)) analyzeLog.delete(k);
  return false;
}

/** The upstream base address, or null when it is missing, malformed, or plain http outside local development. */
function upstreamBase(env: RadarEnv): string | null {
  const raw = env.RADAR_API_URL?.trim();
  if (!raw || !env.RADAR_API_KEY?.trim()) return null;
  try {
    const u = new URL(raw);
    const local = u.hostname === 'localhost' || u.hostname === '127.0.0.1';
    if (u.protocol !== 'https:' && !(u.protocol === 'http:' && local && env.VERCEL_ENV !== 'production')) return null;
    return u.origin;
  } catch {
    return null;
  }
}

export async function handleRadar(input: RadarInput): Promise<RadarOutput> {
  const headers: Record<string, string> = { vary: 'origin', 'cache-control': 'no-store' };
  const allowed = isOriginAllowed(input.origin, input.env);
  if (allowed) {
    headers['access-control-allow-origin'] = input.origin!;
    headers['access-control-allow-methods'] = 'GET, POST, OPTIONS';
    headers['access-control-allow-headers'] = 'content-type';
  }
  if (input.method === 'OPTIONS') return { status: allowed ? 204 : 403, body: '', headers };
  if (!allowed) return json(403, { error: 'origin' }, headers);

  const op = input.query.op;
  const wantsPost = op === 'analyze';
  if (input.method !== (wantsPost ? 'POST' : 'GET') || (op !== 'home' && op !== 'asset' && op !== 'analyze')) {
    return op === 'home' || op === 'asset' || op === 'analyze' ? json(405, { error: 'method' }, { ...headers, allow: wantsPost ? 'POST, OPTIONS' : 'GET, OPTIONS' }) : json(404, { error: 'not-found' }, headers);
  }

  const base = upstreamBase(input.env);
  if (!base) return json(503, { error: 'radar-not-configured' }, headers);
  if (overLimit(`radar:${input.ip}`, input.now)) return json(429, { error: 'rate-limit' }, { ...headers, 'retry-after': '60' });

  let path: string;
  let init: RequestInit = { method: 'GET' };
  let timeoutMs = 15_000;
  if (op === 'home') {
    if (homeCache && input.now - homeCache.at < HOME_KEEP_MS) return { status: 200, body: homeCache.body, headers: { ...headers, 'content-type': 'application/json' } };
    path = '/api/radar';
  } else {
    const id = radarAssetId(op === 'asset' ? input.query.assetId : (input.body as { assetId?: unknown } | null)?.assetId);
    if (!id) return json(400, { error: 'bad-asset' }, headers);
    if (op === 'asset') path = `/api/radar/${encodeURIComponent(id)}`;
    else {
      if (analyzeLimited(input.ip, input.now)) return json(429, { error: 'rate-limit' }, { ...headers, 'retry-after': '60' });
      path = '/api/radar/analyze';
      init = { method: 'POST', body: JSON.stringify({ assetId: id }), headers: { 'content-type': 'application/json' } };
      timeoutMs = 55_000;
    }
  }

  let res: Response;
  let text: string;
  try {
    res = await input.fetchImpl(base + path, { ...init, headers: { ...(init.headers as Record<string, string> | undefined), authorization: `Bearer ${input.env.RADAR_API_KEY!.trim()}`, accept: 'application/json' }, signal: AbortSignal.timeout(timeoutMs) });
    text = await res.text();
  } catch {
    return json(502, { error: 'radar-unreachable' }, headers);
  }
  if (text.length > MAX_BYTES) return json(502, { error: 'radar-bad-answer' }, headers);
  if (res.status === 429) return json(429, { error: 'radar-busy' }, { ...headers, 'retry-after': '60' });
  if (res.status === 404) return json(404, { error: 'not-analyzed' }, headers);
  if (res.status === 400) return json(400, { error: 'bad-asset' }, headers);
  // 401 here means the site's own key is wrong: a deployment problem, not something the visitor can fix or should read about.
  if (!res.ok) return json(502, { error: 'radar-error' }, headers);
  try {
    JSON.parse(text);
  } catch {
    return json(502, { error: 'radar-bad-answer' }, headers);
  }
  if (op === 'home') homeCache = { at: input.now, body: text };
  return { status: 200, body: text, headers: { ...headers, 'content-type': 'application/json' } };
}
