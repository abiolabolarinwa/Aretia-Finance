/**
 * The scheduled run: picks the enabled adapters, gives each a share of the time budget, and works through admin backfill jobs.
 * Which adapters run is configuration (MI_ADAPTERS), not code; an adapter that an administrator disabled is skipped by the engine.
 */
import { chainConfig, type EvmMiChain } from './chains.js';
import { allSpecs, SOLANA_SPECS, type DexAdapterSpec, type SolanaAdapterSpec } from './dexes.js';
import { runSolanaAdapter, solUsdReader } from './solana/engine.js';
import { deepenSolanaHistory } from './solana/track.js';
import { deepenHistory, DEFAULT_RETENTION_DAYS as TRACK_RETENTION_DAYS } from './track.js';
import { runAdapter, type EngineDeps, type LaunchLookup, type RunReport } from './engine.js';
import { DEFAULT_RULES, type ListingRules } from './lifecycle.js';
import { nativeUsdReader } from './reference.js';
import { makeRead } from './rpc.js';
import { scanCacheFor, swapScanChains } from './swapScan.js';
import type { MiStore } from './store.js';
import type { BackfillJob } from './types.js';

export interface RunnerEnv {
  /** Comma list of adapter ids, or `*` for every catalogued adapter. Default: the first network only (pancakeswap-v2-bnb). */
  MI_ADAPTERS?: string;
  MI_MIN_LIQUIDITY_USD?: string;
  MI_INACTIVE_AFTER_HOURS?: string;
  /** Trades older than this many days are deleted (default 14). Candles and stats for older periods are then not available. */
  MI_TRADE_RETENTION_DAYS?: string;
  /** How many pools' swaps are followed per adapter: the newest created and the most recently traded (default 100 each). */
  MI_FOLLOW_NEWEST?: string;
  MI_FOLLOW_RECENT?: string;
  /** Chains (comma list, e.g. `ethereum,base`) whose V2/V3 swaps are read chain-wide by event, covering every registered pool (swapScan.ts). Off by default. */
  MI_SWAP_SCAN?: string;
  [k: string]: string | undefined;
}

/** Trades older than this are deleted (the database also does it hourly, migration 0021). Charts of up to two weeks stay whole. */
export const DEFAULT_RETENTION_DAYS = TRACK_RETENTION_DAYS;

/** What runs when nothing is configured: the adapters that were run end to end against a live network (see `live-verified` in dexes.ts). */
export const DEFAULT_ADAPTERS = ['pancakeswap-v2-bnb', 'raydium-cpmm-solana', 'orca-whirlpool-solana', 'pumpswap-solana'];

export function enabledSpecs(env: RunnerEnv): DexAdapterSpec[] {
  const all = allSpecs();
  const raw = (env.MI_ADAPTERS ?? '').trim();
  if (raw === '*') return all;
  const ids = raw ? raw.split(/[\s,;]+/).filter(Boolean) : DEFAULT_ADAPTERS;
  return ids.map((id) => all.find((s) => s.id === id)).filter((s): s is DexAdapterSpec => Boolean(s));
}

export function enabledSolana(env: RunnerEnv): SolanaAdapterSpec[] {
  const raw = (env.MI_ADAPTERS ?? '').trim();
  if (raw === '*') return [...SOLANA_SPECS];
  const ids = new Set(raw ? raw.split(/[\s,;]+/).filter(Boolean) : DEFAULT_ADAPTERS);
  return SOLANA_SPECS.filter((s) => ids.has(s.id));
}

export function rulesFrom(env: RunnerEnv): ListingRules {
  const minLiquidityUsd = Number(env.MI_MIN_LIQUIDITY_USD);
  const hours = Number(env.MI_INACTIVE_AFTER_HOURS);
  return {
    ...DEFAULT_RULES,
    ...(Number.isFinite(minLiquidityUsd) && minLiquidityUsd >= 0 && env.MI_MIN_LIQUIDITY_USD !== undefined ? { minLiquidityUsd } : {}),
    ...(Number.isFinite(hours) && hours > 0 && env.MI_INACTIVE_AFTER_HOURS !== undefined ? { inactiveAfterMs: hours * 3_600_000 } : {}),
  };
}

export interface RunAllDeps {
  env: RunnerEnv;
  store: MiStore;
  fetchImpl?: typeof fetch;
  now: () => number;
  budgetMs: number;
  launch?: LaunchLookup | null;
  /** Test hook: replaces the JSON-RPC reader for a chain. */
  readFor?: (spec: DexAdapterSpec | SolanaAdapterSpec) => EngineDeps['read'];
}

export interface RunAllReport {
  adapters: RunReport[];
  job: { id: string; adapterId: string; status: BackfillJob['status']; doneBlock: number } | null;
  pruned: number;
  durationMs: number;
}

export async function runAll(d: RunAllDeps): Promise<RunAllReport> {
  const t0 = d.now();
  const evm = enabledSpecs(d.env);
  const sol = enabledSolana(d.env);
  const specs: (DexAdapterSpec | SolanaAdapterSpec)[] = [...evm, ...sol];
  const rules = rulesFrom(d.env);
  const out: RunReport[] = [];
  const count = (v: string | undefined): number | undefined => (v !== undefined && Number.isInteger(Number(v)) && Number(v) >= 0 && Number(v) <= 2_000 ? Number(v) : undefined);
  const retentionDays = (): number => {
    const v = Number(d.env.MI_TRADE_RETENTION_DAYS);
    return Number.isFinite(v) && v >= 2 && d.env.MI_TRADE_RETENTION_DAYS !== undefined ? v : DEFAULT_RETENTION_DAYS;
  };
  const runOne = async (spec: DexAdapterSpec | SolanaAdapterSpec, budgetMs: number): Promise<RunReport> => {
    // Most of the slice goes to the live run; a bounded part reads tracked pools' history further back (see track.ts).
    const historyMs = Math.min(10_000, Math.floor(budgetMs / 4));
    if (spec.chain !== 'solana') {
      const deps = engineFor(spec as DexAdapterSpec, budgetMs - historyMs);
      const report = await runAdapter(deps);
      if (report.ok) await deepenHistory({ ...deps, retentionDays: retentionDays(), budgetMs: historyMs }, { budgetMs: historyMs }).catch(() => undefined);
      return report;
    }
    const chain = chainConfig('solana', d.env);
    const rpc = d.readFor ? d.readFor(spec) : makeRead(chain.rpcUrls, { fetchImpl: d.fetchImpl, concurrency: 3 });
    const solDeps = { spec: spec as SolanaAdapterSpec, chain, rpc, store: d.store, rules, now: d.now, launch: d.launch ?? null, nativeUsd: solUsdReader(rpc, d.now), budgetMs: budgetMs - historyMs, followNewest: count(d.env.MI_FOLLOW_NEWEST), followRecent: count(d.env.MI_FOLLOW_RECENT) };
    const report = await runSolanaAdapter(solDeps);
    if (report.ok) await deepenSolanaHistory({ ...solDeps, retentionDays: retentionDays() }, { budgetMs: historyMs }).catch(() => undefined);
    return report;
  };
  const scanChains = swapScanChains(d.env.MI_SWAP_SCAN);
  const swapScan = (spec: DexAdapterSpec): boolean => spec.kind !== 'v4' && scanChains.has(spec.chain);
  const engineFor = (spec: DexAdapterSpec, budgetMs: number): EngineDeps => {
    const chain = chainConfig(spec.chain, d.env);
    const read = d.readFor ? d.readFor(spec) : makeRead(chain.rpcUrls, { fetchImpl: d.fetchImpl });
    return { spec, chain, read, store: d.store, rules, now: d.now, launch: d.launch ?? null, nativeUsd: nativeUsdReader(chain, read, d.now), budgetMs, followNewest: count(d.env.MI_FOLLOW_NEWEST), followRecent: count(d.env.MI_FOLLOW_RECENT), ...(swapScan(spec) ? { swapScan: true, scanCache: scanCacheFor(spec.id) } : {}) };
  };

  // A backfill requested by an administrator runs first, in its own slice of the budget.
  let job: RunAllReport['job'] = null;
  const claimed = await d.store.claimJob();
  if (claimed) {
    const spec = allSpecs().find((s) => s.id === claimed.adapterId);
    if (!spec) await d.store.updateJob(claimed.id, { status: 'failed', error: 'a backfill is by block range and is available for EVM adapters only' });
    else {
      let done = claimed.doneBlock;
      const r = await runAdapter(engineFor(spec, Math.floor(d.budgetMs / 2)), {
        range: { from: Math.max(claimed.fromBlock, claimed.doneBlock + 1), to: claimed.toBlock },
        onProgress: async (block) => {
          done = block;
          await d.store.updateJob(claimed.id, { doneBlock: block });
        },
      });
      const status: BackfillJob['status'] = !r.ok ? 'failed' : done >= claimed.toBlock || r.skipped === 'up-to-date' ? 'done' : 'pending';
      await d.store.updateJob(claimed.id, { status, doneBlock: done, error: r.ok ? null : r.error });
      job = { id: claimed.id, adapterId: claimed.adapterId, status, doneBlock: done };
    }
  }

  // Fair share of what is left. The adapter that last succeeded longest ago goes first (never run: first of all), so one that was cut short,
  // or that sits late in the list, is served next time instead of waiting for a clock to rotate to it. Ties keep the catalogue order.
  const health = new Map((await d.store.listHealth().catch(() => [])).map((h) => [h.adapterId, h]));
  const age = (s: DexAdapterSpec | SolanaAdapterSpec): number => health.get(s.id)?.lastSuccessAt ?? 0;
  const order = specs.map((s, i) => ({ s, i })).sort((x, y) => age(x.s) - age(y.s) || x.i - y.i).map((x) => x.s);
  for (let i = 0; i < order.length; i++) {
    const left = d.budgetMs - (d.now() - t0);
    if (left < 2_000) break;
    out.push(await runOne(order[i]!, Math.floor(left / (order.length - i))));
  }
  // Retention: a bounded slice per run, so the table cannot grow without limit and no run is slowed by a big delete.
  const days = Number(d.env.MI_TRADE_RETENTION_DAYS);
  const keepDays = Number.isFinite(days) && days >= 2 && d.env.MI_TRADE_RETENTION_DAYS !== undefined ? days : DEFAULT_RETENTION_DAYS;
  const pruned = d.now() - t0 < d.budgetMs ? await d.store.pruneTrades(Math.floor(d.now() / 1000) - keepDays * 86_400, 2_000).catch(() => 0) : 0;
  return { adapters: out, job, pruned, durationMs: d.now() - t0 };
}

export type { EvmMiChain };
