/**
 * GET /api/swings-candles?chain=&pool=&tf=: candles built from the prices Aretia has recorded for a pool (pool_ticks).
 * Asking for a pool also marks it as tracked, so the refresh job starts recording it if it was not. The answer says how
 * far back the recording goes, and an empty one is honest about it: the page then falls back to the outside chart.
 */
import { supabaseBase } from '../src/swings/tokens/supabaseAuth.js';
import { isOriginAllowed, overLimit } from './_rpcProxy.js';
import { isChainId } from '../src/swings/core/types.js';
import { buildCandles, isTimeframe, TIMEFRAMES } from '../src/swings/market/candles.js';
import { SupabaseTickStore } from '../src/swings/market/tickStore.js';
import type { TokensInput, TokensOutput } from './_swingsTokens.js';

const POOL = /^[A-Za-z0-9]{20,100}$/;
const RANGE_CANDLES = 300;

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
    await store.track(chain, poolKey, input.now).catch(() => undefined);
    const candles = buildCandles(ticks, bucket).slice(-RANGE_CANDLES);
    return json(200, { chain, pool: poolKey, tf, since: ticks[0]?.ts ?? null, candles }, headers);
  } catch {
    return json(502, { error: 'database' }, headers);
  }
}
