/**
 * Market Indexer over HTTP, three routes of swings-data (the Hobby plan caps the project at twelve functions, so none is added):
 *   GET  /api/v1/...        the public, versioned read API (src/swings/mi/api.ts). Rate limited per IP, cached, CORS open for GET.
 *   GET  /api/mi-run        the scheduled indexer run (Authorization: Bearer CRON_SECRET only).
 *   POST /api/swings-mi-admin   owner controls with an audit log: disable or enable an adapter, pause or resume a market, queue a
 *                           backfill, requeue a stuck job, read the overview. Same sign-in and allow-list as the admin page.
 * Secrets (SUPABASE_SERVICE_ROLE_KEY, CRON_SECRET, node URLs) stay in the server environment; none is ever put in a response.
 */
import { supabaseBase } from '../src/swings/tokens/supabaseAuth.js';
import { authenticateAdmin, NOT_FOUND, type AdminEnv, type AdminInput } from './_adminStats.js';
import { bearerMatches } from './_secrets.js';
import { overBudget } from './_limits.js';
import { handleRead } from '../src/swings/mi/api.js';
import { allSpecs, specById } from '../src/swings/mi/dexes.js';
import { adminTransition } from '../src/swings/mi/lifecycle.js';
import { launchLookup } from '../src/swings/mi/launchLink.js';
import { chainConfig, isMiChain } from '../src/swings/mi/chains.js';
import { makeRead } from '../src/swings/mi/rpc.js';
import { runAll, type RunnerEnv } from '../src/swings/mi/runner.js';
import type { MiStore } from '../src/swings/mi/store.js';
import { MiMissingTableError, SupabaseMiStore } from '../src/swings/mi/supabaseStore.js';
import type { BackfillJob } from '../src/swings/mi/types.js';

export interface MiEnv extends AdminEnv, RunnerEnv {
  CRON_SECRET?: string;
  [k: string]: string | undefined;
}
export interface MiInput {
  method: string;
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

export async function handleMi(input: MiInput, storeOverride?: MiStore): Promise<MiOutput> {
  const cors = { 'access-control-allow-origin': '*', 'access-control-allow-methods': 'GET, OPTIONS', 'access-control-max-age': '86400' };
  if (input.method === 'OPTIONS') return { status: 204, body: '', headers: cors };
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

// ---------------------------------------------------------------------------------------------- scheduled run

export async function handleMiRun(input: MiInput, storeOverride?: MiStore): Promise<MiOutput> {
  if (!bearerMatches(input.authorization, input.env.CRON_SECRET?.trim())) return json(401, { error: 'unauthorized' });
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

const EVM_ADDRESS = /^0x[0-9a-fA-F]{40}$/;
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
      return json(200, { health, disabled: [...disabled].map(([id, v]) => ({ id, ...v })), jobs, audit: log, pools, adapters: allSpecs().map((s) => ({ id: s.id, chain: s.chain, evidence: s.evidence })) }, headers);
    }
    if (action === 'disable-adapter' || action === 'enable-adapter') {
      const id = typeof b.adapterId === 'string' ? b.adapterId : '';
      if (!specById(id)) return json(400, { error: 'unknown-adapter' }, headers);
      const reason = reasonOf(b.reason);
      await store.setAdapterDisabled(id, action === 'disable-adapter', reason, input.now);
      await audit(action, id, { reason });
      return json(200, { ok: true }, headers);
    }
    if (action === 'pause-pool' || action === 'resume-pool') {
      const chain = typeof b.chain === 'string' ? b.chain : '';
      const pool = typeof b.pool === 'string' ? b.pool.toLowerCase() : '';
      if (!isMiChain(chain) || chain === 'solana' || !EVM_ADDRESS.test(pool)) return json(400, { error: 'bad-pool' }, headers);
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
      if (!specById(id)) return json(400, { error: 'unknown-adapter' }, headers);
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

