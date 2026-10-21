/**
 * GET /api/swings-candles?chain=&pool=&tf=: candles built from the prices Aretia has recorded for a pool (pool_ticks).
 * Asking for a pool also marks it as tracked, so the refresh job starts recording it if it was not, but only a pool Aretia
 * already knows (it has recorded prices, or a token in the registry names it), and no more than TRACKS_PER_IP new marks per IP
 * per ten minutes, so made-up addresses cannot push real pools out of the refresh job's slots. Old marks are pruned by the
 * database (migration 0014). The answer says how far back the recording goes, and an empty one is honest about it: the page
 * then falls back to the outside chart.
 */
import { supabaseBase, supabaseHeaders } from '../src/swings/tokens/supabaseAuth.js';
import { overBudget } from './_limits.js';
import { isOriginAllowed, overLimit } from './_rpcProxy.js';
import { isChainId } from '../src/swings/core/types.js';
import { buildCandles, isTimeframe, TIMEFRAMES } from '../src/swings/market/candles.js';
import { SupabaseTickStore } from '../src/swings/market/tickStore.js';
import type { TokensInput, TokensOutput } from './_swingsTokens.js';

const POOL = /^[A-Za-z0-9]{20,100}$/;
const RANGE_CANDLES = 300;
export const TRACKS_PER_IP = 30;

/** Whether a token in the registry names this pool, as its market pool or among its pools. */
async function knownPool(url: string, key: string, fetchImpl: typeof fetch, chain: string, pool: string, given: string): Promise<boolean> {
  const ask = async (filter: string): Promise<boolean> => {
    const res = await fetchImpl(`${url}/rest/v1/token_registry?chain=eq.${chain}&${filter}&select=key&limit=1`, { headers: supabaseHeaders(key) });
    if (!res.ok) return false;
    const rows = (await res.json().catch(() => [])) as unknown[];
    return Array.isArray(rows) && rows.length > 0;
  };
  // The pool is plain letters and digits (checked by POOL), so it needs no quoting; an EVM pool is compared without case.
  const market = chain === 'solana' ? `market->>pool=eq.${pool}` : `market->>pool=ilike.${pool}`;
  const listed = [...new Set([pool, given])].map((p) => `pools=cs.${encodeURIComponent(JSON.stringify([{ address: p }]))}`);
  const answers = await Promise.all([ask(market), ...listed.map(ask)]);
  return answers.some(Boolean);
}

const json = (status: number, data: unknown, headers: Record<string, string>): TokensOutput => ({ status, body: JSON.stringify(data), headers: { ...headers, 'content-type': 'application/json' } });

export async function handleCandles(input: TokensInput): Promise<TokensOutput> {
  const headers: Record<string, string> = { vary: 'origin', 'cache-control': 'no-store' };
  const allowed = isOriginAllowed(input.origin, input.env);
  if (allowed) {
    headers['access-control-allow-origin'] = input.origin!;
    headers['access-control-allow-methods'] = 'GET, OPTIONS';
  }
  if (input.method === 'OPTIONS') return { status: allowed ? 204 : 403, body: '', headers };
  if (input.method !== 'GET') return json(405, { error: 'method' }, { ...headers, allow: 'GET, OPTIONS' });
  if (!allowed) return json(403, { error: 'origin' }, headers);
  const url = supabaseBase(input.env.SUPABASE_URL);
  const key = input.env.SUPABASE_SERVICE_ROLE_KEY?.trim();
  if (!url || !key) return json(503, { error: 'not-configured' }, headers);
  if (overLimit(`candles:${input.ip}`, input.now)) return json(429, { error: 'rate-limit' }, { ...headers, 'retry-after': '60' });
  const { chain, pool } = input.query;
  const tf = input.query.tf ?? '15m';
  if (!chain || !isChainId(chain) || !pool || !POOL.test(pool) || !isTimeframe(tf)) return json(400, { error: 'bad-request' }, headers);
  // Solana pool addresses are case-sensitive; EVM ones are stored lower-case.
  const poolKey = chain === 'solana' ? pool : pool.toLowerCase();
  const store = new SupabaseTickStore(url, key, input.fetchImpl);
  try {
    const bucket = TIMEFRAMES[tf];
    const ticks = await store.list(chain, poolKey, input.now - bucket * RANGE_CANDLES);
    const known = ticks.length > 0 || (await knownPool(url, key, input.fetchImpl, chain, poolKey, pool).catch(() => false));
    if (known && !overBudget(`candles-track:${input.ip}`, input.now, TRACKS_PER_IP, 10 * 60_000)) await store.track(chain, poolKey, input.now).catch(() => undefined);
    const candles = buildCandles(ticks, bucket).slice(-RANGE_CANDLES);
    return json(200, { chain, pool: poolKey, tf, since: ticks[0]?.ts ?? null, candles }, headers);
  } catch {
    return json(502, { error: 'database' }, headers);
  }
}
