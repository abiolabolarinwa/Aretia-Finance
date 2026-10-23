/**
 * The scheduled run: picks the enabled adapters, gives each a share of the time budget, and works through admin backfill jobs.
 * Which adapters run is configuration (MI_ADAPTERS), not code; an adapter that an administrator disabled is skipped by the engine.
 */
import { chainConfig, type EvmMiChain } from './chains.js';
import { allSpecs, type DexAdapterSpec } from './dexes.js';
import { runAdapter, type EngineDeps, type LaunchLookup, type RunReport } from './engine.js';
import { DEFAULT_RULES, type ListingRules } from './lifecycle.js';
import { nativeUsdReader } from './reference.js';
import { makeRead } from './rpc.js';
import type { MiStore } from './store.js';
import type { BackfillJob } from './types.js';

export interface RunnerEnv {
  /** Comma list of adapter ids, or `*` for every catalogued adapter. Default: the first network only (pancakeswap-v2-bnb). */
  MI_ADAPTERS?: string;
  MI_MIN_LIQUIDITY_USD?: string;
  MI_INACTIVE_AFTER_HOURS?: string;
  [k: string]: string | undefined;
}

/** What runs when nothing is configured: the one adapter that has been demonstrated end to end on a live network. */
export const DEFAULT_ADAPTERS = ['pancakeswap-v2-bnb'];

export function enabledSpecs(env: RunnerEnv): DexAdapterSpec[] {
  const all = allSpecs();
  const raw = (env.MI_ADAPTERS ?? '').trim();
  if (raw === '*') return all;
  const ids = raw ? raw.split(/[\s,;]+/).filter(Boolean) : DEFAULT_ADAPTERS;
  return ids.map((id) => all.find((s) => s.id === id)).filter((s): s is DexAdapterSpec => Boolean(s));
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
  readFor?: (spec: DexAdapterSpec) => EngineDeps['read'];
}

export interface RunAllReport {
  adapters: RunReport[];
  job: { id: string; adapterId: string; status: BackfillJob['status']; doneBlock: number } | null;
  durationMs: number;
}

export async function runAll(d: RunAllDeps): Promise<RunAllReport> {
  const t0 = d.now();
  const specs = enabledSpecs(d.env);
  const rules = rulesFrom(d.env);
  const out: RunReport[] = [];
  const engineFor = (spec: DexAdapterSpec, budgetMs: number): EngineDeps => {
    const chain = chainConfig(spec.chain, d.env);
    const read = d.readFor ? d.readFor(spec) : makeRead(chain.rpcUrls, { fetchImpl: d.fetchImpl });
    return { spec, chain, read, store: d.store, rules, now: d.now, launch: d.launch ?? null, nativeUsd: nativeUsdReader(chain, read, d.now), budgetMs };
  };

  // A backfill requested by an administrator runs first, in its own slice of the budget.
  let job: RunAllReport['job'] = null;
  const claimed = await d.store.claimJob();
  if (claimed) {
    const spec = allSpecs().find((s) => s.id === claimed.adapterId);
    if (!spec) await d.store.updateJob(claimed.id, { status: 'failed', error: 'unknown adapter' });
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

  // Fair share of what is left; the starting adapter rotates with the clock so a slow one does not starve the others.
  const start = specs.length ? Math.floor(d.now() / 60_000) % specs.length : 0;
  const order = specs.map((_, i) => specs[(start + i) % specs.length]!);
  for (let i = 0; i < order.length; i++) {
    const left = d.budgetMs - (d.now() - t0);
    if (left < 2_000) break;
    out.push(await runAdapter(engineFor(order[i]!, Math.floor(left / (order.length - i)))));
  }
  return { adapters: out, job, durationMs: d.now() - t0 };
}

export type { EvmMiChain };
