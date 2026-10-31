/**
 * Market Indexer over HTTP, three routes of swings-data (the Hobby plan caps the project at twelve functions, so none is added):
 *   GET  /api/v1/...        the public, versioned read API (src/swings/mi/api.ts). Rate limited per IP, cached, CORS open for GET.
 *   GET  /api/mi-run        the scheduled indexer run (Authorization: Bearer MI_CRON_SECRET; CRON_SECRET only when MI_CRON_SECRET is not set).
 *   POST /api/swings-mi-admin   owner controls with an audit log: disable or enable an adapter, pause or resume a market, queue a
 *                           backfill, requeue a stuck job, read the overview. Same sign-in and allow-list as the admin page.
 * Secrets (SUPABASE_SERVICE_ROLE_KEY, CRON_SECRET, node URLs) stay in the server environment; none is ever put in a response.
 */
import { supabaseBase } from '../src/swings/tokens/supabaseAuth.js';
import { authenticateAdmin, NOT_FOUND, type AdminEnv, type AdminInput } from './_adminStats.js';
import { bearerMatches } from './_secrets.js';
import { overBudget } from './_limits.js';
import { handleRead } from '../src/swings/mi/api.js';
import { buildCandleRows } from '../src/swings/mi/stats.js';
import { parseRaw, toNumber, unitsToNumber } from '../src/swings/mi/math.js';
import type { Trade } from '../src/swings/charts/trades.js';
import { adapterById, allSpecs, SOLANA_SPECS, specById } from '../src/swings/mi/dexes.js';
import { isSolanaAddress } from '../src/swings/mi/solana/accounts.js';
import { adminTransition } from '../src/swings/mi/lifecycle.js';
import { launchLookup } from '../src/swings/mi/launchLink.js';
import { chainConfig, isMiChain, type MiChain } from '../src/swings/mi/chains.js';
import { makeRead } from '../src/swings/mi/rpc.js';
import { runAll, rulesFrom, type RunnerEnv } from '../src/swings/mi/runner.js';
import { trackEvmPool, type TrackResult } from '../src/swings/mi/track.js';
import { trackSolanaPool } from '../src/swings/mi/solana/track.js';
import { isOriginAllowed } from './_rpcProxy.js';
import { nativeUsdReader } from '../src/swings/mi/reference.js';
import { solUsdReader } from '../src/swings/mi/solana/engine.js';
import type { MiStore } from '../src/swings/mi/store.js';
import { MiMissingTableError, SupabaseMiStore } from '../src/swings/mi/supabaseStore.js';
import type { BackfillJob } from '../src/swings/mi/types.js';

export interface MiEnv extends AdminEnv, RunnerEnv {
  CRON_SECRET?: string;
  /** A secret just for the indexer's schedule. When set, it is the only one accepted here, so the site's other schedules keep their own. */
  MI_CRON_SECRET?: string;
  [k: string]: string | undefined;
}
export interface MiInput {
  method: string;
  origin?: string | null;
  body?: unknown;
  query: Record<string, string | undefined>;
  authorization: string | null;
  ip: string;
  env: MiEnv;
  fetchImpl: typeof fetch;
  now: number;
}
export interface MiOutput {
  status: number;
  body: string;
  headers: Record<string, string>;
}

const JSON_TYPE = { 'content-type': 'application/json' };
const json = (status: number, data: unknown, headers: Record<string, string> = {}): MiOutput => ({ status, body: JSON.stringify(data), headers: { ...JSON_TYPE, 'cache-control': 'no-store', ...headers } });

export const RATE = { perMinute: 120 };
const CACHE_TTL_MS = 8_000;
const cache = new Map<string, { at: number; out: MiOutput }>();
export function resetMiCache(): void {
  cache.clear();
}

function storeFor(env: { SUPABASE_URL?: string; SUPABASE_SERVICE_ROLE_KEY?: string }, fetchImpl: typeof fetch, now: () => number): MiStore | null {
  const url = supabaseBase(env.SUPABASE_URL);
  const key = env.SUPABASE_SERVICE_ROLE_KEY?.trim();
  return url && key ? new SupabaseMiStore(url, key, fetchImpl, now) : null;
}

const MISSING = (): MiOutput => json(503, { error: { code: 'not-set-up', message: 'The Market Indexer tables have not been created yet (migration 0017_market_indexer.sql).' } });
const NOT_CONFIGURED = (): MiOutput => json(503, { error: { code: 'not-configured', message: 'The Market Indexer is not configured on this server.' } });

// ---------------------------------------------------------------------------------------------- public read

export async function handleMi(input: MiInput, storeOverride?: MiStore, trackDeps?: { readFor?: (chain: MiChain) => import('../src/swings/mi/rpc.js').Read }): Promise<MiOutput> {
  const cors = { 'access-control-allow-origin': '*', 'access-control-allow-methods': 'GET, OPTIONS', 'access-control-max-age': '86400' };
  if (input.method === 'OPTIONS') return { status: 204, body: '', headers: cors };
  if (input.method === 'POST' && (input.query.path ?? '') === 'track') return handleTrack(input, storeOverride, trackDeps);
  if (input.method !== 'GET') return json(405, { error: { code: 'method', message: 'GET only.' } }, { ...cors, allow: 'GET, OPTIONS' });
  if (overBudget(`mi:${input.ip}`, input.now, RATE.perMinute)) return json(429, { error: { code: 'rate-limited', message: `At most ${RATE.perMinute} requests a minute per address.` } }, { ...cors, 'retry-after': '30' });
  const { path: rawPath, ...query } = input.query;
  const segments = (rawPath ?? '').split('/').filter(Boolean);
  if (segments.length > 5 || segments.some((s) => s.length > 100 || !/^[A-Za-z0-9._-]+$/.test(s))) return json(404, { error: { code: 'not-found', message: 'No such endpoint.' } }, cors);
  const cacheKey = `${segments.join('/')}?${Object.entries(query).sort(([a], [b]) => (a < b ? -1 : 1)).map(([k, v]) => `${k}=${v ?? ''}`).join('&')}`;
  const hit = cache.get(cacheKey);
  if (hit && input.now - hit.at < CACHE_TTL_MS) return hit.out;
  const store = storeOverride ?? storeFor(input.env, input.fetchImpl, () => input.now);
  if (!store) return { ...NOT_CONFIGURED(), headers: { ...NOT_CONFIGURED().headers, ...cors } };
  try {
    const r = await handleRead(store, { path: segments, query, now: input.now });
    const out = json(r.status, r.body, { ...cors, ...(r.cacheSeconds > 0 && r.status === 200 ? { 'cache-control': `public, max-age=${Math.min(5, r.cacheSeconds)}, s-maxage=${r.cacheSeconds}, stale-while-revalidate=${r.cacheSeconds * 4}` } : {}) });
    if (r.status === 200 && r.cacheSeconds > 0) {
      if (cache.size > 500) cache.clear();
      cache.set(cacheKey, { at: input.now, out });
    }
    return out;
  } catch (e) {
    if (e instanceof MiMissingTableError) return { ...MISSING(), headers: { ...MISSING().headers, ...cors } };
    return json(500, { error: { code: 'failed', message: 'The request could not be completed.' } }, cors);
  }
}

// ---------------------------------------------------------------------------------------------- track a pool on request

const trackedAt = new Map<string, number>();
const TRACK_COOLDOWN_MS = 5 * 60_000;
export function resetTrackState(): void {
  trackedAt.clear();
}

/**
 * POST /api/v1/track { chain, pool }: adds one existing pool to the index (see src/swings/mi/track.ts). Only the site itself may call it
 * (origin check), each address is limited, there is one budget for all callers, and a pool is not re-read for five minutes. It reads
 * from the chain only after the pool's own `factory()` / owner program has been matched to a DEX Aretia indexes.
 */
async function handleTrack(input: MiInput, storeOverride?: MiStore, deps?: { readFor?: (chain: MiChain) => import('../src/swings/mi/rpc.js').Read }): Promise<MiOutput> {
  if (!isOriginAllowed(input.origin ?? null, input.env)) return json(404, { error: { code: 'not-found', message: 'No such endpoint.' } });
  const cors = { vary: 'origin', 'access-control-allow-origin': input.origin! };
  if (overBudget(`mi-track:${input.ip}`, input.now, 10) || overBudget('mi-track:all', input.now, 120, 600_000)) return json(429, { error: { code: 'rate-limited', message: 'Too many tracking requests. Try again in a minute.' } }, { ...cors, 'retry-after': '60' });
  const b = typeof input.body === 'object' && input.body !== null ? (input.body as Record<string, unknown>) : {};
  const chain = typeof b.chain === 'string' ? b.chain : '';
  const rawPool = typeof b.pool === 'string' ? b.pool : '';
  if (!isMiChain(chain)) return json(400, { error: { code: 'bad-chain', message: 'Unknown network.' } }, cors);
  const pool = chain === 'solana' ? rawPool : rawPool.toLowerCase();
  if (!(chain === 'solana' ? isSolanaAddress(pool) : EVM_ADDRESS.test(pool))) return json(400, { error: { code: 'bad-address', message: 'Not a valid pool address for that network.' } }, cors);
  const store = storeOverride ?? storeFor(input.env, input.fetchImpl, () => input.now);
  if (!store) return { ...NOT_CONFIGURED(), headers: { ...NOT_CONFIGURED().headers, ...cors } };
  const key = `${chain}:${pool}`;
  const last = trackedAt.get(key);
  if (last !== undefined && input.now - last < TRACK_COOLDOWN_MS) return json(200, { data: { status: 'recent' } }, cors);
  if (trackedAt.size > 2_000) trackedAt.clear();
  trackedAt.set(key, input.now);
  try {
    const cfg = chainConfig(chain, input.env);
    const read = deps?.readFor ? deps.readFor(chain) : makeRead(cfg.rpcUrls, { fetchImpl: input.fetchImpl, concurrency: 3 });
    const now = () => Date.now();
    const tokenHint = typeof b.token === 'string' && /^0x[0-9a-fA-F]{40}$/.test(b.token) ? b.token.toLowerCase() : undefined;
    const base = { chain: cfg, store, rules: rulesFrom(input.env), now, budgetMs: 25_000, tokenHint };
    const result: TrackResult = chain === 'solana' ? await trackSolanaPool({ ...base, rpc: read, nativeUsd: solUsdReader(read, now) }, pool) : await trackEvmPool({ ...base, read, nativeUsd: nativeUsdReader(cfg, read, now) }, cfg, pool);
    return json(200, { data: result }, cors);
  } catch (e) {
    trackedAt.delete(key);
    if (e instanceof MiMissingTableError) return { ...MISSING(), headers: { ...MISSING().headers, ...cors } };
    return json(502, { error: { code: 'unreadable', message: 'The network could not be read just now.' } }, cors);
  }
}

// ---------------------------------------------------------------------------------------------- scheduled run

export async function handleMiRun(input: MiInput, storeOverride?: MiStore): Promise<MiOutput> {
  if (!bearerMatches(input.authorization, (input.env.MI_CRON_SECRET?.trim() || input.env.CRON_SECRET?.trim()) || undefined)) return json(401, { error: 'unauthorized' });
  if (input.method !== 'GET' && input.method !== 'POST') return json(405, { error: 'method' }, { allow: 'GET, POST' });
  const store = storeOverride ?? storeFor(input.env, input.fetchImpl, Date.now);
  if (!store) return NOT_CONFIGURED();
  try {
    const url = supabaseBase(input.env.SUPABASE_URL)!;
    const key = input.env.SUPABASE_SERVICE_ROLE_KEY!.trim();
    const launch = storeOverride ? null : launchLookup({ supabaseUrl: url, serviceKey: key, fetchImpl: input.fetchImpl, readFor: (chain) => (isMiChain(chain) && chain !== 'solana' ? makeRead(chainConfig(chain, input.env).rpcUrls, { fetchImpl: input.fetchImpl }) : null) });
    const report = await runAll({ env: input.env, store, fetchImpl: input.fetchImpl, now: Date.now, budgetMs: 45_000, launch });
    const ok = report.adapters.every((a) => a.ok);
    return json(ok ? 200 : 207, report);
  } catch (e) {
    if (e instanceof MiMissingTableError) return MISSING();
    return json(500, { error: 'run-failed' });
  }
}

// ---------------------------------------------------------------------------------------------- owner controls

/** A pool on an EVM chain: a contract address, or (Uniswap V4) a 32-byte pool id. */
const EVM_ADDRESS = /^0x(?:[0-9a-fA-F]{40}|[0-9a-fA-F]{64})$/;
const MAX_BACKFILL_BLOCKS = 200_000;
const obj = (v: unknown): Record<string, unknown> => (typeof v === 'object' && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : {});
const reasonOf = (v: unknown): string => (typeof v === 'string' ? v.replace(/[^\p{L}\p{N} .,:;()_'/+-]/gu, '').trim().slice(0, 200) : '');

export async function handleMiAdmin(input: AdminInput, storeOverride?: MiStore): Promise<MiOutput> {
  // Anything short of a signed-in owner is the same 404 as an unknown path.
  const auth = await authenticateAdmin(input);
  if (!auth) return NOT_FOUND;
  const headers = { vary: 'origin', 'access-control-allow-origin': input.origin! };
  const store = storeOverride ?? storeFor(input.env, input.fetchImpl, () => input.now);
  if (!store) return NOT_CONFIGURED();
  const b = obj(input.body);
  const action = typeof b.action === 'string' ? b.action : 'overview';
  const audit = (act: string, target: string, detail: Record<string, unknown>) => store.appendAudit({ at: input.now, actor: auth.owner, action: act, target, detail });
  try {
    if (action === 'overview') {
      const [health, disabled, jobs, log, pools] = await Promise.all([store.listHealth(), store.disabledAdapters(), store.listJobs(20), store.listAudit(50), store.countPools({})]);
      return json(200, { health, disabled: [...disabled].map(([id, v]) => ({ id, ...v })), jobs, audit: log, pools, adapters: [...allSpecs(), ...SOLANA_SPECS].map((s) => ({ id: s.id, chain: s.chain, evidence: s.evidence })) }, headers);
    }
    if (action === 'disable-adapter' || action === 'enable-adapter') {
      const id = typeof b.adapterId === 'string' ? b.adapterId : '';
      if (!adapterById(id)) return json(400, { error: 'unknown-adapter' }, headers);
      const reason = reasonOf(b.reason);
      await store.setAdapterDisabled(id, action === 'disable-adapter', reason, input.now);
      await audit(action, id, { reason });
      return json(200, { ok: true }, headers);
    }
    if (action === 'pause-pool' || action === 'resume-pool') {
      const chain = typeof b.chain === 'string' ? b.chain : '';
      const rawPool = typeof b.pool === 'string' ? b.pool : '';
      const pool = chain === 'solana' ? rawPool : rawPool.toLowerCase();
      if (!isMiChain(chain) || !(chain === 'solana' ? isSolanaAddress(pool) : EVM_ADDRESS.test(pool))) return json(400, { error: 'bad-pool' }, headers);
      const key = `${chain}:${pool}`;
      const found = (await store.getPools([key])).get(key);
      if (!found) return json(404, { error: 'unknown-pool' }, headers);
      const reason = reasonOf(b.reason);
      if (action === 'pause-pool') {
        await store.updatePool(key, { paused: true, state: 'suspended', stateReason: reason || 'paused by an administrator', stateAt: input.now });
      } else {
        const next = adminTransition(found.state, 'resume');
        await store.updatePool(key, { paused: false, ...(next ? { state: next, stateReason: 'resumed by an administrator', stateAt: input.now } : {}) });
      }
      await audit(action, key, { reason, previousState: found.state });
      return json(200, { ok: true }, headers);
    }
    if (action === 'backfill') {
      const id = typeof b.adapterId === 'string' ? b.adapterId : '';
      const from = Number(b.fromBlock);
      const to = Number(b.toBlock);
      if (!specById(id)) return json(400, { error: 'unknown-adapter', message: 'A backfill is by block range and is available for EVM adapters only.' }, headers);
      if (!Number.isSafeInteger(from) || !Number.isSafeInteger(to) || from < 0 || to < from || to - from + 1 > MAX_BACKFILL_BLOCKS) return json(400, { error: 'bad-range', message: `fromBlock <= toBlock, at most ${MAX_BACKFILL_BLOCKS} blocks.` }, headers);
      const job: BackfillJob = { id: `${input.now.toString(36)}-${Math.random().toString(36).slice(2, 8)}`, adapterId: id, fromBlock: from, toBlock: to, doneBlock: from - 1, status: 'pending', requestedBy: auth.owner, requestedAt: input.now, error: null };
      await store.createJob(job);
      await audit('backfill', id, { jobId: job.id, fromBlock: from, toBlock: to });
      return json(200, { ok: true, jobId: job.id }, headers);
    }
    if (action === 'requeue-job') {
      const id = typeof b.jobId === 'string' && /^[a-z0-9-]{3,40}$/.test(b.jobId) ? b.jobId : '';
      if (!id) return json(400, { error: 'bad-job' }, headers);
      await store.updateJob(id, { status: 'pending', error: null });
      await audit('requeue-job', id, {});
      return json(200, { ok: true }, headers);
    }
    return json(400, { error: 'unknown-action' }, headers);
  } catch (e) {
    if (e instanceof MiMissingTableError) return { ...MISSING(), headers: { ...MISSING().headers, ...headers } };
    return json(500, { error: 'failed' }, headers);
  }
}


// ---------------------------------------------------------------------------------------------- candles for the TradingView chart

const OHLCV_SIZES: Readonly<Record<string, { aggregates: readonly number[]; seconds: number }>> = { minute: { aggregates: [1, 5, 15], seconds: 60 }, hour: { aggregates: [1, 4], seconds: 3600 }, day: { aggregates: [1], seconds: 86_400 } };

/**
 * GET /api/swings-ohlcv?source=aretia: candles of a pool the Market Indexer follows, in the shape the chart already reads
 * (`data.attributes.ohlcv_list`, newest first). They are built from stored on-chain trades only; a period with no trade has no
 * candle. Dollars are offered only for a pool quoted in a dollar stablecoin; a pool quoted in the native coin answers an empty
 * list for `currency=usd` rather than converting history at today's rate.
 */
export async function miOhlcv(input: { query: Record<string, string | undefined>; env: { SUPABASE_URL?: string; SUPABASE_SERVICE_ROLE_KEY?: string }; fetchImpl: typeof fetch; now: number; ip: string }, storeOverride?: MiStore): Promise<MiOutput> {
  const q = input.query;
  const size = OHLCV_SIZES[q.tf ?? ''];
  const aggregate = Math.floor(Number(q.agg ?? '1'));
  const limit = Math.floor(Number(q.limit ?? '300'));
  const before = Math.floor(Number(q.before ?? '0'));
  const pool = q.chain === 'solana' ? (q.pool ?? '') : (q.pool ?? '').toLowerCase();
  if (!isMiChain(q.chain ?? '') || !(q.chain === 'solana' ? isSolanaAddress(pool) : EVM_ADDRESS.test(pool)) || !size || !size.aggregates.includes(aggregate) || (q.token ?? 'base') !== 'base' || !['usd', 'token', undefined].includes(q.currency) || !Number.isFinite(limit) || limit < 1 || limit > 1000 || !Number.isFinite(before) || before < 1) return json(400, { error: 'bad-request' });
  if (overBudget(`mi-ohlcv:${input.ip}`, input.now, 240)) return json(429, { error: 'rate-limit' }, { 'retry-after': '30' });
  const store = storeOverride ?? storeFor(input.env, input.fetchImpl, () => input.now);
  if (!store) return NOT_CONFIGURED();
  try {
    const chain = q.chain as MiChain;
    const p = (await store.getPools([`${chain}:${pool}`])).get(`${chain}:${pool}`);
    if (!p || p.paused) return json(404, { error: 'unknown-pool' });
    const step = size.seconds * aggregate;
    const nowSec = Math.floor(input.now / 1000);
    const end = Math.min(Math.ceil(before / step) * step, Math.ceil(nowSec / step) * step + step);
    const trades = (await store.tradesSince(chain, pool, end - limit * step, 10_000)).filter((t) => t.time < end);
    const quote = chainConfig(chain).quoteTokens.find((x) => x.address === p.quote);
    const wantsUsd = (q.currency ?? 'usd') === 'usd';
    const rows = wantsUsd && quote?.role !== 'usd' ? [] : buildCandleRows(trades, step, p.quoteDecimals);
    const fresh = end > nowSec ? 5 : 60;
    return json(200, { data: { attributes: { ohlcv_list: [...rows].reverse() } }, source: 'aretia-index', unit: quote?.role === 'usd' ? 'usd' : 'quote', stale: false }, { 'cache-control': `public, s-maxage=${fresh}, stale-while-revalidate=${fresh * 4}` });
  } catch (e) {
    if (e instanceof MiMissingTableError) return MISSING();
    return json(500, { error: 'failed' });
  }
}

// ---------------------------------------------------------------------------------------------- recent trades for the chart's table

/**
 * The newest trades of a pool the Market Indexer follows, in the shape the Transactions table under the chart reads, built from stored
 * on-chain trades only. Returns null when the indexer cannot answer for this pool (not configured, the pool is not followed or is
 * paused, it is quoted in something other than a dollar stablecoin so no dollar value is known, or it has no stored trade), so the caller
 * reads its usual source. Never throws.
 */
export async function miTrades(input: { chain: string; pool: string; token: 'base' | 'quote'; env: { SUPABASE_URL?: string; SUPABASE_SERVICE_ROLE_KEY?: string }; fetchImpl: typeof fetch; now: number }, storeOverride?: MiStore): Promise<Trade[] | null> {
  if (!isMiChain(input.chain)) return null;
  const pool = input.chain === 'solana' ? input.pool : input.pool.toLowerCase();
  try {
    const store = storeOverride ?? storeFor(input.env, input.fetchImpl, () => input.now);
    if (!store) return null;
    const chain = input.chain as MiChain;
    const p = (await store.getPools([`${chain}:${pool}`])).get(`${chain}:${pool}`);
    if (!p || p.paused) return null;
    const quote = chainConfig(chain).quoteTokens.find((x) => x.address === p.quote);
    // A dollar-quoted pool gives a dollar value and price. A pool quoted in the chain's own coin has no dollar value that was true at the time of
    // each trade, so those columns are left empty (null) rather than converted at today's rate.
    const dollar = quote?.role === 'usd';
    const rows = await store.recentTrades(chain, pool, 100);
    const out: Trade[] = [];
    for (const t of rows) {
      const baseAmount = unitsToNumber(parseRaw(t.baseAmount) ?? 0n, p.baseDecimals);
      const quoteAmount = unitsToNumber(parseRaw(t.quoteAmount) ?? 0n, p.quoteDecimals);
      const price = toNumber(t.price);
      if (!Number.isFinite(price) || price <= 0 || !Number.isFinite(quoteAmount)) continue;
      const base = input.token === 'base';
      out.push({
        t: t.time * 1000,
        kind: base ? t.side : t.side === 'buy' ? 'sell' : 'buy',
        usd: dollar ? quoteAmount : Number.NaN,
        tokenAmount: base ? baseAmount : quoteAmount,
        quoteAmount: base ? quoteAmount : baseAmount,
        priceUsd: base && dollar ? price : null,
        trader: t.maker,
        tx: t.id.split(':')[0] ?? t.id,
      });
    }
    return out.length > 0 ? out : null;
  } catch {
    return null;
  }
}
