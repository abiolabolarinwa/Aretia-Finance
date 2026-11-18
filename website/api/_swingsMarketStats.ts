/**
 * GET /api/swings-market?src=stats: the numbers behind the Markets page's stats bar, read from Aretia's own Market Indexer: 24-hour volume and
 * transactions summed over the pools that pass the market intelligence engine's checks (the same pools as the busiest-venues card, shared with
 * it, per network and in total), and the newest block the index has seen on each network.
 * Shared by everyone: kept 30 seconds in the function and at the CDN, an older answer served while it refreshes. When the database is
 * unreachable the answer is 200 with an error flag, so the page simply shows no bar. No sign-in is involved; the data is public.
 */
import { overLimit } from './_rpcProxy.js';
import { supabaseBase, supabaseHeaders } from '../src/swings/tokens/supabaseAuth.js';
import { postgrestReader } from '../src/swings/mi/marketList.js';
import { buildStats, type MarketStats } from '../src/swings/mi/marketStats.js';
import { resetIntelPools, sharedIntelPools } from './_intelPools.js';
import type { AdapterHealth } from '../src/swings/mi/types.js';
import type { TokensInput, TokensOutput } from './_swingsTokens.js';

const FRESH_MS = 30_000;
const STALE_MS = 3_600_000;
const DEADLINE_MS = 12_000;
let held: { at: number; stats: MarketStats } | null = null;
export function resetMarketStatsCache(): void {
  held = null;
  resetIntelPools();
}

const json = (status: number, data: unknown, headers: Record<string, string>): TokensOutput => ({ status, body: JSON.stringify(data), headers: { ...headers, 'content-type': 'application/json' } });

export async function handleMarketStats(input: TokensInput): Promise<TokensOutput> {
  const base: Record<string, string> = { 'cache-control': 'no-store' };
  if (input.method !== 'GET') return json(405, { error: 'method' }, { ...base, allow: 'GET' });
  const env = input.env as { SUPABASE_URL?: string; SUPABASE_SERVICE_ROLE_KEY?: string; MI_DATA_URL?: string; MI_DATA_SERVICE_ROLE_KEY?: string };
  const own = Boolean(env.MI_DATA_URL?.trim() && env.MI_DATA_SERVICE_ROLE_KEY?.trim());
  const url = supabaseBase(own ? env.MI_DATA_URL : env.SUPABASE_URL);
  const key = (own ? env.MI_DATA_SERVICE_ROLE_KEY : env.SUPABASE_SERVICE_ROLE_KEY)?.trim();
  const empty = (error: string): TokensOutput => json(200, { error }, base);
  if (!url || !key) return empty('not-configured');
  const ok = (stats: MarketStats, stale: boolean): TokensOutput => json(200, { ...stats, stale }, { ...base, 'cache-control': stale ? 'no-store' : 'public, s-maxage=30, stale-while-revalidate=600' });
  if (held && input.now - held.at < FRESH_MS) return ok(held.stats, false);
  if (overLimit(`marketstats:${input.ip}`, input.now)) return held ? ok(held.stats, true) : json(429, { error: 'rate-limit' }, { ...base, 'retry-after': '30' });
  try {
    const reader = postgrestReader(url, supabaseHeaders(key), input.fetchImpl, AbortSignal.timeout(DEADLINE_MS));
    // The same pools, read the same way and checked the same way as the busiest-venues card, so the two totals are one figure.
    const pools = await sharedIntelPools(reader, input.now);
    const health = ((await reader.get('mi_health?select=data&limit=200', false)).rows as { data?: AdapterHealth }[]).flatMap((r) => (r.data ? [r.data] : []));
    const stats = buildStats(pools, health, input.now);
    held = { at: input.now, stats };
    return ok(stats, false);
  } catch {
    if (held && input.now - held.at < STALE_MS) return ok(held.stats, true);
    return empty('index');
  }
}
