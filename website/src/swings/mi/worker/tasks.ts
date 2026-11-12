/**
 * Turns configuration into the worker's tasks:
 *   <adapter>            the live run of an adapter (the same `runAll` the HTTP route uses, limited to that one adapter and given a longer slice)
 *   <adapter>:refresh    the reserves refresher (EVM V2/V3 on chains with Multicall3), on unless MI_REFRESH=0
 *   <adapter>:swaps      the swap-history backfill (MI_SWAP_BACKFILL_DAYS > 0): past swaps of the registered pools of chains in MI_SWAP_SCAN
 *   <adapter>:backfill   the creation backfill, only when MI_BACKFILL_DAYS > 0; default adapters: the V2/V3 adapters of BNB Chain
 *   <solana adapter>:discover / :refresh   discovery of existing Solana pools and their liquidity refresher, only when MI_SOLANA_DISCOVERY is set
 *   <chain>:supply       the token supply refresher (for the Markets list's fully diluted value), one per chain, on unless MI_SUPPLY=0
 */
import { chainConfig, type MiChainConfig } from '../chains.js';
import { allSpecs, type DexAdapterSpec } from '../dexes.js';
import { backfillCreations } from '../backfill.js';
import { backfillSwaps } from '../swapBackfill.js';
import { swapScanChains } from '../swapScan.js';
import { DEFAULT_RETENTION_DAYS } from '../track.js';
import type { LaunchLookup } from '../engine.js';
import { nativeUsdReader } from '../reference.js';
import { refreshReserves } from '../refresher.js';
import { makeRead, type Read } from '../rpc.js';
import { enabledSolana, enabledSpecs, rulesFrom, runAll, type RunnerEnv } from '../runner.js';
import { SOLANA_SPECS } from '../dexes.js';
import { discoverVenue, discoveryAdapters } from '../solana/discovery.js';
import { solUsdReader } from '../solana/engine.js';
import { refreshSolanaReserves } from '../solana/refresher.js';
import { refreshSupplies, SUPPLY_LIMIT } from '../supply.js';
import { MULTICALL_CHAINS } from '../reserves.js';
import type { MiStore } from '../store.js';
import type { WorkerTask } from './loop.js';

export interface TaskDeps {
  env: RunnerEnv;
  store: MiStore;
  now: () => number;
  fetchImpl?: typeof fetch;
  launch?: LaunchLookup | null;
  /** Test hook. */
  readFor?: (chain: MiChainConfig) => Read;
}

const int = (v: string | undefined, fallback: number, min: number, max: number): number => {
  const n = Number(v);
  return v !== undefined && v !== '' && Number.isFinite(n) && n >= min && n <= max ? Math.floor(n) : fallback;
};

export function buildTasks(d: TaskDeps): WorkerTask[] {
  const tasks: WorkerTask[] = [];
  const reads = new Map<string, { read: Read; nativeUsd: () => Promise<number | null>; chain: MiChainConfig }>();
  const readerFor = (spec: DexAdapterSpec) => {
    let r = reads.get(spec.chain);
    if (!r) {
      const chain = chainConfig(spec.chain, d.env);
      const read = d.readFor ? d.readFor(chain) : makeRead(chain.rpcUrls, { fetchImpl: d.fetchImpl });
      r = { read, nativeUsd: nativeUsdReader(chain, read, d.now), chain };
      reads.set(spec.chain, r);
    }
    return r;
  };
  const rules = rulesFrom(d.env);

  const live = (id: string, chain: DexAdapterSpec['chain'] | 'solana'): WorkerTask => ({
    id,
    chain,
    run: async (budgetMs) => {
      const report = await runAll({ env: { ...d.env, MI_ADAPTERS: id }, store: d.store, fetchImpl: d.fetchImpl, now: d.now, budgetMs, launch: d.launch ?? null });
      const a = report.adapters[0];
      if (!a) return { ok: true, caughtUp: true };
      const maxRange = chain === 'solana' ? 0 : chainConfig(chain, d.env).maxRange;
      return { ok: a.ok, error: a.error, caughtUp: a.skipped !== null || (a.lagBlocks ?? 0) < Math.max(1, maxRange) };
    },
  });
  for (const s of enabledSpecs(d.env)) tasks.push(live(s.id, s.chain));
  for (const s of enabledSolana(d.env)) tasks.push(live(s.id, 'solana'));

  const evm = enabledSpecs(d.env).filter((s) => s.kind === 'v2' || s.kind === 'v3');
  if (d.env.MI_REFRESH !== '0') {
    for (const spec of evm) {
      tasks.push({
        id: `${spec.id}:refresh`,
        chain: spec.chain,
        idleMs: int(d.env.MI_REFRESH_EVERY_SECONDS, 60, 10, 86_400) * 1000,
        run: async (budgetMs) => {
          const r = readerFor(spec);
          const rep = await refreshReserves({ spec, chain: r.chain, read: r.read, store: d.store, rules, now: d.now, nativeUsd: r.nativeUsd, budgetMs, batch: int(d.env.MI_REFRESH_BATCH, 150, 10, 400), limit: int(d.env.MI_REFRESH_LIMIT, 1_500, 10, 20_000) });
          return { ok: rep.ok, error: rep.error, caughtUp: true };
        },
      });
    }
  }

  // Token supplies, one task per chain: price x supply is the fully diluted value shown in Markets.
  if (d.env.MI_SUPPLY !== '0') {
    const evmChains = new Map<string, DexAdapterSpec>();
    for (const s of enabledSpecs(d.env)) if (MULTICALL_CHAINS.includes(s.chain) && !evmChains.has(s.chain)) evmChains.set(s.chain, s);
    for (const [chainId, spec] of evmChains) {
      tasks.push({
        id: `${chainId}:supply`,
        chain: spec.chain,
        idleMs: 600_000,
        run: async (budgetMs) => {
          const r = readerFor(spec);
          const rep = await refreshSupplies({ chain: r.chain, read: r.read, store: d.store, now: d.now, budgetMs });
          return { ok: rep.ok, error: rep.error, caughtUp: rep.considered < SUPPLY_LIMIT };
        },
      });
    }
    if (enabledSolana(d.env).length > 0 || discoveryAdapters(d.env.MI_SOLANA_DISCOVERY).length > 0) {
      const chain = chainConfig('solana', d.env);
      const rpc = d.readFor ? d.readFor(chain) : makeRead(chain.rpcUrls, { fetchImpl: d.fetchImpl, concurrency: 3 });
      tasks.push({
        id: 'solana:supply',
        chain: 'solana',
        idleMs: 600_000,
        run: async (budgetMs) => {
          const rep = await refreshSupplies({ chain, read: rpc, store: d.store, now: d.now, budgetMs });
          return { ok: rep.ok, error: rep.error, caughtUp: rep.considered < SUPPLY_LIMIT };
        },
      });
    }
  }

  // Existing Solana pools: found by listing a venue's program accounts and kept current from their vaults. Off unless MI_SOLANA_DISCOVERY names venues.
  const solana = discoveryAdapters(d.env.MI_SOLANA_DISCOVERY);
  if (solana.length > 0) {
    const chain = chainConfig('solana', d.env);
    const rpc = d.readFor ? d.readFor(chain) : makeRead(chain.rpcUrls, { fetchImpl: d.fetchImpl, concurrency: 3 });
    const nativeUsd = solUsdReader(rpc, d.now);
    const floor = d.env.MI_BACKFILL_MIN_LIQUIDITY_USD ? Number(d.env.MI_BACKFILL_MIN_LIQUIDITY_USD) : undefined;
    for (const id of solana) {
      const spec = SOLANA_SPECS.find((s) => s.id === id);
      if (!spec) continue;
      tasks.push({
        id: `${id}:discover`,
        chain: 'solana',
        idleMs: 3_600_000,
        run: async (budgetMs) => {
          const rep = await discoverVenue({ chain, rpc, store: d.store, rules, now: d.now, launch: d.launch ?? null, nativeUsd, ...(floor !== undefined && Number.isFinite(floor) ? { floorUsd: floor } : {}), maxList: int(d.env.MI_SOLANA_DISCOVERY_MAX, 400_000, 1_000, 5_000_000) }, id, budgetMs);
          return { ok: rep.ok, error: rep.error, caughtUp: rep.complete };
        },
      });
      if (d.env.MI_REFRESH !== '0') {
        tasks.push({
          id: `${id}:refresh`,
          chain: 'solana',
          idleMs: int(d.env.MI_REFRESH_EVERY_SECONDS, 60, 10, 86_400) * 1000,
          run: async (budgetMs) => {
            const rep = await refreshSolanaReserves({ spec, chain, rpc, store: d.store, rules, now: d.now, launch: d.launch ?? null, nativeUsd, budgetMs, limit: int(d.env.MI_REFRESH_LIMIT, 1_500, 10, 20_000) });
            return { ok: rep.ok, error: rep.error, caughtUp: true };
          },
        });
      }
    }
  }

  const days = int(d.env.MI_BACKFILL_DAYS, 0, 0, 365);
  if (days > 0) {
    const wanted = (d.env.MI_BACKFILL_ADAPTERS ?? '').split(/[\s,;]+/).filter(Boolean);
    const specs = allSpecs().filter((s) => (s.kind === 'v2' || s.kind === 'v3') && (wanted.length ? wanted.includes(s.id) : s.chain === 'bnb' && (s.family === 'pancakeswap' || s.family === 'uniswap')));
    for (const spec of specs) {
      tasks.push({
        id: `${spec.id}:backfill`,
        chain: spec.chain,
        idleMs: 3_600_000,
        run: async (budgetMs) => {
          const r = readerFor(spec);
          const rep = await backfillCreations({ spec, chain: r.chain, read: r.read, store: d.store, rules, now: d.now, nativeUsd: r.nativeUsd, launch: d.launch ?? null, budgetMs, days, minLiquidityUsd: d.env.MI_BACKFILL_MIN_LIQUIDITY_USD ? Number(d.env.MI_BACKFILL_MIN_LIQUIDITY_USD) : undefined });
          return { ok: rep.ok, error: rep.error, caughtUp: rep.state !== 'walking' };
        },
      });
    }
  }

  // Past swaps of the pools already held, so quiet pools have their 24-hour figures. Never reaches back further than the store keeps trades.
  const swapDays = Math.min(int(d.env.MI_SWAP_BACKFILL_DAYS, 0, 0, 365), int(d.env.MI_TRADE_RETENTION_DAYS, DEFAULT_RETENTION_DAYS, 2, 365));
  if (int(d.env.MI_SWAP_BACKFILL_DAYS, 0, 0, 365) > 0) {
    const scanned = swapScanChains(d.env.MI_SWAP_SCAN);
    const wanted = (d.env.MI_SWAP_BACKFILL_ADAPTERS ?? '').split(/[\s,;]+/).filter(Boolean);
    for (const spec of enabledSpecs(d.env)) {
      if ((spec.kind !== 'v2' && spec.kind !== 'v3') || !scanned.has(spec.chain) || (wanted.length > 0 && !wanted.includes(spec.id))) continue;
      tasks.push({
        id: `${spec.id}:swaps`,
        chain: spec.chain,
        idleMs: 3_600_000,
        run: async (budgetMs) => {
          const r = readerFor(spec);
          const rep = await backfillSwaps({ spec, chain: r.chain, read: r.read, store: d.store, rules, now: d.now, budgetMs, days: swapDays });
          return { ok: rep.ok, error: rep.error, caughtUp: rep.state !== 'walking' };
        },
      });
    }
  }
  return tasks;
}
