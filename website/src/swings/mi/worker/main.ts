/**
 * Entry point of the long-running indexer worker (bundled by server/worker/Dockerfile; run with `node dist/worker.mjs`).
 * Reads only environment variables: SUPABASE_URL (the data service, e.g. http://caddy:8080), SUPABASE_SERVICE_ROLE_KEY, MI_* (see
 * docs/market-indexer.md). SIGTERM/SIGINT stop it gracefully: no new slice starts, the running ones finish (their writes are
 * checkpointed and idempotent), then it exits; a second signal or MI_WORKER_GRACE_SECONDS (default 75) forces the exit.
 */
import { chainConfig, isMiChain } from '../chains.js';
import { launchLookup } from '../launchLink.js';
import { makeRead } from '../rpc.js';
import { StreamPublisher, publishing } from '../stream/publisher.js';
import { watchedReader } from '../stream/watched.js';
import { SupabaseMiStore } from '../supabaseStore.js';
import { DEFAULT_LOOP, runWorker, type LoopOptions } from './loop.js';
import { buildTasks } from './tasks.js';

const env = process.env as Record<string, string | undefined>;
const stamp = (): string => new Date().toISOString();
const log = (line: string): void => console.log(`${stamp()} ${line}`);

const url = (env.SUPABASE_URL ?? '').trim().replace(/\/+$/, '');
const key = (env.SUPABASE_SERVICE_ROLE_KEY ?? '').trim();
if (!url || !key) {
  console.error('SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be set. Nothing was started.');
  process.exit(2);
}

const num = (v: string | undefined, fallback: number): number => (v !== undefined && Number.isFinite(Number(v)) && Number(v) > 0 ? Number(v) : fallback);
const options: LoopOptions = {
  sliceMs: num(env.MI_WORKER_SLICE_SECONDS, DEFAULT_LOOP.sliceMs / 1000) * 1000,
  idleMs: num(env.MI_WORKER_IDLE_SECONDS, DEFAULT_LOOP.idleMs / 1000) * 1000,
  backoffBaseMs: DEFAULT_LOOP.backoffBaseMs,
  backoffMaxMs: DEFAULT_LOOP.backoffMaxMs,
};

let stopping = false;
const sleepers = new Set<() => void>();
const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    const done = (): void => {
      clearTimeout(timer);
      sleepers.delete(done);
      resolve();
    };
    const timer = setTimeout(done, ms);
    sleepers.add(done);
  });

const database = new SupabaseMiStore(url, key, fetch, Date.now);
// Live market stream: when MI_STREAM_URL names the stream service, every pool statistics write is also announced to it (never blocks or fails indexing).
const streamUrl = (env.MI_STREAM_URL ?? '').trim();
const streamSecret = (env.STREAM_SECRET ?? '').trim();
const publisher = streamUrl && streamSecret ? new StreamPublisher({ url: streamUrl, secret: streamSecret }) : null;
const store = publisher ? publishing(database, publisher) : database;
if (publisher) setInterval(() => log(`stream: ${publisher.published} sent, ${publisher.dropped} dropped, ${publisher.failures} failed request(s)`), 10 * 60_000).unref();
const launch = launchLookup({ supabaseUrl: url, serviceKey: key, fetchImpl: fetch, readFor: (chain) => (isMiChain(chain) && chain !== 'solana' ? makeRead(chainConfig(chain, env).rpcUrls) : null) });
const tasks = buildTasks({ env, store, now: Date.now, launch, watched: publisher ? watchedReader({ url: streamUrl, secret: streamSecret }) : null });
log(`worker starting: ${tasks.length} task(s): ${tasks.map((t) => t.id).join(', ') || 'none (check MI_ADAPTERS)'}`);

const stop = (signal: string): void => {
  if (stopping) {
    log(`${signal} again: exiting now`);
    process.exit(0);
  }
  stopping = true;
  log(`${signal}: finishing the running slice(s), then exiting`);
  for (const wake of [...sleepers]) wake();
  setTimeout(() => {
    log('grace period over: exiting');
    process.exit(0);
  }, num(env.MI_WORKER_GRACE_SECONDS, 75) * 1000).unref();
};
process.on('SIGTERM', () => stop('SIGTERM'));
process.on('SIGINT', () => stop('SIGINT'));

await runWorker({ tasks, options, now: Date.now, sleep, stopping: () => stopping, log });
log('worker stopped');
process.exit(0);
