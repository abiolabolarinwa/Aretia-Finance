/**
 * Launch Box, the server side:
 *   GET /api/launchbox      every token created through Aretia Launch, with live market data merged in (public, cached about a minute)
 *   GET /api/launchbox-run  the scheduled indexer (Authorization: Bearer CRON_SECRET only)
 *
 * The list comes from Aretia's own index of the chains (never from anything a browser sends). Prices, volume and liquidity come from
 * DexScreener by token address, batched and kept for a minute; an Aretia Curve's status and progress are read from the chain. A token
 * with no pool has no price and says so. If the index has not been set up (its migration not run) the answer says that and lists nothing.
 */
import { bearerMatches } from './_secrets.js';
import { supabaseBase } from '../src/swings/tokens/supabaseAuth.js';
import { overLimit } from './_rpcProxy.js';
import { LAUNCH_CHAINS, type CurveView, type LaunchChain, type LaunchView } from '../src/swings/launchbox/core.js';
import { MissingTableError, SupabaseLaunchStore, type CursorRow, type LaunchStore } from '../src/swings/launchbox/store.js';
import { PUBLIC_EVM_RPC, runIndexer, type IndexerEnv } from '../src/swings/launchbox/indexer.js';
import { fetchPools, readCurves, toView, type MarketInfo } from '../src/swings/launchbox/markets.js';
import { refreshLinks } from '../src/swings/launchbox/links.js';

export interface LaunchboxEnv extends IndexerEnv {
  SUPABASE_URL?: string;
  SUPABASE_SERVICE_ROLE_KEY?: string;
  CRON_SECRET?: string;
}
export interface LaunchboxInput {
  method: string;
  authorization: string | null;
  ip: string;
  env: LaunchboxEnv;
  fetchImpl: typeof fetch;
  now: number;
  /** Tests pass their own store; production builds one from the environment. */
  store?: LaunchStore;
}
export interface LaunchboxOutput {
  status: number;
  body: string;
  headers: Record<string, string>;
}

const json = (status: number, data: unknown, headers: Record<string, string>): LaunchboxOutput => ({ status, body: JSON.stringify(data), headers: { ...headers, 'content-type': 'application/json' } });

const FRESH_MS = 60_000;
/** A token's market numbers older than this are not shown when the source fails. */
const STALE_MS = 6 * 3_600_000;
/** If the indexer has not finished a run for this long, a page visit runs one small step itself. */
const CATCH_UP_AFTER_MS = 5 * 60_000;
const CATCH_UP_BUDGET_MS = 8_000;
const LIST_LIMIT = 300;

let page: { at: number; body: unknown } | null = null;
const marketCache = new Map<LaunchChain, { at: number; map: Map<string, MarketInfo> }>();
let lastCatchUp = 0;
let catchingUp: Promise<unknown> | null = null;

export function resetLaunchboxCache(): void {
  page = null;
  marketCache.clear();
  lastCatchUp = 0;
  catchingUp = null;
}

function storeFor(input: Pick<LaunchboxInput, 'env' | 'fetchImpl' | 'store'>): LaunchStore | null {
  if (input.store) return input.store;
  const url = supabaseBase(input.env.SUPABASE_URL);
  const key = input.env.SUPABASE_SERVICE_ROLE_KEY?.trim();
  return url && key ? new SupabaseLaunchStore(url, key, input.fetchImpl) : null;
}

const evmUrl = (env: IndexerEnv, chain: Exclude<LaunchChain, 'solana'>): string => env[chain === 'bnb' ? 'EVM_RPC_BNB' : chain === 'ethereum' ? 'EVM_RPC_ETHEREUM' : 'EVM_RPC_POLYGON']?.trim() || PUBLIC_EVM_RPC[chain];

function indexStatus(rows: CursorRow[]): { chain: LaunchChain; updatedAt: number | null; expected: number | null; indexed: number | null; unreadable: number | null }[] {
  return LAUNCH_CHAINS.map((chain) => {
    const r = rows.find((x) => x.chain === chain);
    const s = (r?.stats ?? {}) as { expected?: number; indexed?: number; unreadable?: number };
    return { chain, updatedAt: r?.updatedAt ?? null, expected: typeof s.expected === 'number' ? s.expected : null, indexed: typeof s.indexed === 'number' ? s.indexed : null, unreadable: typeof s.unreadable === 'number' ? s.unreadable : null };
  });
}

export async function handleLaunchbox(input: LaunchboxInput): Promise<LaunchboxOutput> {
  const headers: Record<string, string> = { 'cache-control': 'no-store' };
  if (input.method !== 'GET') return json(405, { error: 'method' }, { ...headers, allow: 'GET' });
  if (page && input.now - page.at < FRESH_MS) return json(200, page.body, { ...headers, 'cache-control': 'public, s-maxage=60, stale-while-revalidate=300' });
  if (overLimit(`launchbox:${input.ip}`, input.now)) return page ? json(200, { ...(page.body as object), stale: true }, headers) : json(429, { error: 'rate-limit' }, { ...headers, 'retry-after': '30' });
  const store = storeFor(input);
  const base = { generatedAt: input.now, launches: [] as LaunchView[], index: [] as ReturnType<typeof indexStatus> };
  if (!store) return json(200, { ...base, setup: 'not-configured' }, headers);
  try {
    let cursors = await store.cursors();
    // When the scheduled run has gone quiet, one small, time-boxed catch-up step runs here; it only reads the chains.
    const newest = Math.max(0, ...cursors.map((c) => c.updatedAt));
    if (input.now - newest > CATCH_UP_AFTER_MS && input.now - lastCatchUp > 120_000) {
      lastCatchUp = input.now;
      catchingUp ??= runIndexer({ store, fetchImpl: input.fetchImpl, env: input.env, now: () => Date.now(), budgetMs: CATCH_UP_BUDGET_MS }).catch(() => null).finally(() => (catchingUp = null));
      await catchingUp;
      cursors = await store.cursors();
    }
    const stored = await store.list(LIST_LIMIT);
    let marketOk = true;
    let staleMarket = false;
    const maps = new Map<LaunchChain, Map<string, MarketInfo>>();
    const curves = new Map<string, CurveView | 'none' | 'unknown'>();
    await Promise.all(
      LAUNCH_CHAINS.map(async (chain) => {
        const mine = stored.filter((t) => t.chain === chain);
        if (mine.length === 0) return;
        const addrs = mine.map((t) => t.address);
        const cached = marketCache.get(chain);
        if (cached && input.now - cached.at < FRESH_MS) maps.set(chain, cached.map);
        else {
          try {
            const map = await fetchPools(input.fetchImpl, chain, addrs);
            marketCache.set(chain, { at: input.now, map });
            maps.set(chain, map);
          } catch {
            // The source failed: the last good numbers (up to six hours old) are shown and marked old; with none, the row says unavailable.
            if (cached && input.now - cached.at < STALE_MS) {
              maps.set(chain, cached.map);
              staleMarket = true;
            } else marketOk = false;
          }
        }
        if (chain !== 'solana') for (const [a, c] of await readCurves(input.fetchImpl, evmUrl(input.env, chain), addrs)) curves.set(`${chain}:${a}`, c);
      }),
    );
    const launches = stored.map((t) => {
      const map = maps.get(t.chain);
      const key = t.chain === 'solana' ? t.address : t.address.toLowerCase();
      return toView(t, map?.get(key), map !== undefined, t.chain === 'solana' ? undefined : curves.get(`${t.chain}:${key}`));
    });
    const body = { ...base, setup: 'ok', launches, index: indexStatus(cursors), staleMarket, marketOk };
    page = { at: input.now, body };
    return json(200, body, { ...headers, 'cache-control': 'public, s-maxage=60, stale-while-revalidate=300' });
  } catch (e) {
    if (e instanceof MissingTableError) return json(200, { ...base, setup: 'no-table' }, headers);
    if (page) return json(200, { ...(page.body as object), stale: true }, headers);
    return json(502, { error: 'source' }, headers);
  }
}

export async function handleLaunchboxRun(input: LaunchboxInput): Promise<LaunchboxOutput> {
  const headers: Record<string, string> = { 'cache-control': 'no-store' };
  const secret = input.env.CRON_SECRET?.trim();
  // Nothing runs unless a secret is configured and presented.
  if (!bearerMatches(input.authorization, secret)) return json(401, { error: 'unauthorized' }, headers);
  if (input.method !== 'GET' && input.method !== 'POST') return json(405, { error: 'method' }, { ...headers, allow: 'GET, POST' });
  const store = storeFor(input);
  if (!store) return json(503, { error: 'not-configured' }, headers);
  try {
    const report = await runIndexer({ store, fetchImpl: input.fetchImpl, env: input.env, now: () => Date.now(), budgetMs: 40_000 });
    if (report.missingTable) return json(503, { error: 'no-table', hint: 'Run migration 0012_launchbox.sql (npm run db:migrate).' }, headers);
    const links = await refreshLinks({ store, fetchImpl: input.fetchImpl, env: input.env, now: () => Date.now() }).catch(() => ({ pools: 0, curves: 0, error: 'links failed' }));
    page = null;
    return json(report.ok ? 200 : 207, { ...report, links }, headers);
  } catch (e) {
    if (e instanceof MissingTableError) return json(503, { error: 'no-table', hint: 'Run migration 0012_launchbox.sql (npm run db:migrate).' }, headers);
    return json(500, { error: 'run-failed' }, headers);
  }
}
