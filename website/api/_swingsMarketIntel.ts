/**
 * GET /api/swings-market?src=intel&chain=: the market mood (AMMI), rising/falling (ARF) and busiest venues (ADV) of Aretia's own index, for all
 * networks or one, worked out by src/swings/market/intel/ from the pools the index holds and the snapshots the worker stores. Shared by everyone:
 * the pools are read once a minute and kept in the function, the answer for each scope is kept a minute, an older one is served while the
 * database is unreachable, and a failure is a 200 with an error flag so the page simply shows no figure. No sign-in is involved; the data is public.
 */
import { overLimit } from './_rpcProxy.js';
import { supabaseBase, supabaseHeaders } from '../src/swings/tokens/supabaseAuth.js';
import { isMiChain } from '../src/swings/mi/chains.js';
import { postgrestReader } from '../src/swings/mi/marketList.js';
import { computeIntel, type IntelResult } from '../src/swings/market/intel/compute.js';
import { readHistory } from '../src/swings/market/intel/read.js';
import { resetIntelPools, sharedIntelPools } from './_intelPools.js';
import { scopeOf } from '../src/swings/market/intel/snapshot.js';
import type { TokensInput, TokensOutput } from './_swingsTokens.js';

const FRESH_MS = 60_000;
const STALE_MS = 3_600_000;
const DEADLINE_MS = 20_000;
const answers = new Map<string, { at: number; result: IntelResult }>();
export function resetMarketIntelCache(): void {
  resetIntelPools();
  answers.clear();
}

const json = (status: number, data: unknown, headers: Record<string, string>): TokensOutput => ({ status, body: JSON.stringify(data), headers: { ...headers, 'content-type': 'application/json' } });

export async function handleMarketIntel(input: TokensInput): Promise<TokensOutput> {
  const base: Record<string, string> = { 'cache-control': 'no-store' };
  if (input.method !== 'GET') return json(405, { error: 'method' }, { ...base, allow: 'GET' });
  const chain = input.query.chain ?? '';
  if (chain !== '' && !isMiChain(chain)) return json(400, { error: 'bad-request' }, base);
  const scope = scopeOf(chain);
  const env = input.env as { SUPABASE_URL?: string; SUPABASE_SERVICE_ROLE_KEY?: string; MI_DATA_URL?: string; MI_DATA_SERVICE_ROLE_KEY?: string };
  const own = Boolean(env.MI_DATA_URL?.trim() && env.MI_DATA_SERVICE_ROLE_KEY?.trim());
  const url = supabaseBase(own ? env.MI_DATA_URL : env.SUPABASE_URL);
  const key = (own ? env.MI_DATA_SERVICE_ROLE_KEY : env.SUPABASE_SERVICE_ROLE_KEY)?.trim();
  const empty = (error: string): TokensOutput => json(200, { error }, base);
  if (!url || !key) return empty('not-configured');
  const ok = (result: IntelResult, stale: boolean): TokensOutput => json(200, { ...result, stale }, { ...base, 'cache-control': stale ? 'no-store' : 'public, s-maxage=60, stale-while-revalidate=600' });
  const hit = answers.get(scope);
  if (hit && input.now - hit.at < FRESH_MS) return ok(hit.result, false);
  if (overLimit(`marketintel:${input.ip}`, input.now)) return hit ? ok(hit.result, true) : json(429, { error: 'rate-limit' }, { ...base, 'retry-after': '30' });
  try {
    const reader = postgrestReader(url, supabaseHeaders(key), input.fetchImpl, AbortSignal.timeout(DEADLINE_MS));
    const rows = await sharedIntelPools(reader, input.now);
    const stored = await readHistory(reader, scope, input.now).catch(() => ({ history: { dailyVolumes: [], hourlyReturns: [], liquiditySamples: [] }, venuesPrev: null }));
    const result = computeIntel(rows, scope, input.now, stored);
    if (answers.size > 20) answers.clear();
    answers.set(scope, { at: input.now, result });
    return ok(result, false);
  } catch {
    if (hit && input.now - hit.at < STALE_MS) return ok(hit.result, true);
    return empty('index');
  }
}
