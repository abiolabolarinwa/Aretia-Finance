/**
 * Turns configuration into the worker's tasks:
 *   <adapter>            the live run of an adapter (the same `runAll` the HTTP route uses, limited to that one adapter and given a longer slice)
 *   <adapter>:refresh    the reserves refresher (EVM V2/V3 on chains with Multicall3), on unless MI_REFRESH=0
 *   <adapter>:swaps      the swap-history backfill (MI_SWAP_BACKFILL_DAYS > 0): past swaps of the registered pools of chains in MI_SWAP_SCAN
 *   <adapter>:backfill   the creation backfill, only when MI_BACKFILL_DAYS > 0; default adapters: the V2/V3 adapters of BNB Chain
 *   <solana adapter>:discover / :refresh   discovery of existing Solana pools and their liquidity refresher, only when MI_SOLANA_DISCOVERY is set
 *   solana:listen       new Solana pools heard as they are created (websocket), only when MI_SOLANA_LISTEN names venues (solana/listener.ts)
 *   solana:seed     pools that already existed: each venue's list of its deepest pools, every one read from the chain before it is accepted, only when MI_SOLANA_SEED=1 (solana/venueLists.ts, known.ts)
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
import { refreshSolanaReserves } from '../solana/refresher.js';
import { followWatchedPools } from '../solana/engine.js';
import { gateFor } from '../solana/gate.js';
import { listenableVenues, registerHeard, startListener, type Heard, type Listener, type Socket } from '../solana/listener.js';
import { emptyReport, solUsdReader, type TokenFacts } from '../solana/engine.js';
import { postgrestReader } from '../marketList.js';
import { MI_CHAINS } from '../chains.js';
import { buildSnapshot, rowOf } from '../../market/intel/snapshot.js';
import { readIntelPools, writeSnapshots } from '../../market/intel/read.js';
import { supabaseHeaders } from '../../tokens/supabaseAuth.js';
import { refreshSupplies, SUPPLY_LIMIT } from '../supply.js';
import { MULTICALL_CHAINS } from '../reserves.js';
import type { MiStore } from '../store.js';
import type { MiPool } from '../types.js';
import type { WorkerTask } from './loop.js';
import { findCandidates, type Candidate } from '../solana/venueLists.js';
import { registerKnownPools } from '../solana/known.js';

export interface TaskDeps {
  env: RunnerEnv;
  store: MiStore;
  now: () => number;
  fetchImpl?: typeof fetch;
  launch?: LaunchLookup | null;
  /** Test hook. */
  readFor?: (chain: MiChainConfig) => Read;
  /** The pools open Markets pages are showing now (the stream service's answer); absent when the stream is off. */
  watched?: (() => Promise<string[]>) | null;
  /** The data service the market intelligence snapshot task reads pools from and writes snapshots to (the worker's own database address and key). */
  intel?: { url: string; key: string } | null;
  /** Test hook: opens the websocket the creation listener uses. */
  listenOpen?: (url: string) => Socket;
  /** Where the watched-pools task says what it did (at most one line a minute, and only while somebody is watching). */
  log?: (line: string) => void;
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

  // The pools open Markets pages are showing now, grouped by adapter. One answer is reused for two seconds by every task that needs it.
  const watchEvery = int(d.env.MI_WATCH_EVERY_SECONDS, 2, 1, 600) * 1000;
  const watch = { at: 0, byAdapter: new Map<string, MiPool[]>() };
  const refreshWatch = async (): Promise<void> => {
    if (!d.watched || d.now() - watch.at < 2_000) return;
    watch.at = d.now();
    try {
      const keys = await d.watched();
      const found = keys.length > 0 ? [...(await d.store.getPools(keys.slice(0, 300))).values()] : [];
      const by = new Map<string, MiPool[]>();
      for (const p of found) by.set(p.adapterId, [...(by.get(p.adapterId) ?? []), p]);
      watch.byAdapter = by;
    } catch {
      watch.byAdapter = new Map();
    }
  };

  const live = (id: string, chain: DexAdapterSpec['chain'] | 'solana'): WorkerTask => ({
    id,
    chain,
    // While somebody is watching one of this adapter's pools, it runs every MI_WATCH_EVERY_SECONDS instead of every 15 seconds (EVM; Solana has its own task).
    idleMs: d.watched && chain !== 'solana' ? () => (watch.byAdapter.has(id) ? watchEvery : undefined) : undefined,
    run: async (budgetMs) => {
      await refreshWatch();
      const report = await runAll({ env: { ...d.env, MI_ADAPTERS: id, MI_SOLANA_GATE: d.env.MI_SOLANA_GATE === '0' ? '0' : '1' }, store: d.store, fetchImpl: d.fetchImpl, now: d.now, budgetMs, launch: d.launch ?? null, extraPools: d.watched && chain !== 'solana' ? async (aid) => watch.byAdapter.get(aid) ?? [] : undefined });
      const a = report.adapters[0];
      if (!a) return { ok: true, caughtUp: true };
      const maxRange = chain === 'solana' ? 0 : chainConfig(chain, d.env).maxRange;
      return { ok: a.ok, error: a.error, caughtUp: a.skipped !== null || (a.lagBlocks ?? 0) < Math.max(1, maxRange) };
    },
  });
  for (const s of enabledSpecs(d.env)) tasks.push(live(s.id, s.chain));
  for (const s of enabledSolana(d.env)) tasks.push(live(s.id, 'solana'));

  // The Solana pools people are looking at get their trades read often, on a lane of their own so the slow rotation never makes them wait.
  if (d.watched && enabledSolana(d.env).length > 0) {
    // Any Solana venue whose pools people are watching, not only the ones MI_ADAPTERS scans for new pools: following a pool that is already
    // known costs the same whichever venue it is on, and the trending pools are mostly on venues the server does not scan.
    const specs = new Map(SOLANA_SPECS.map((s) => [s.id, s]));
    const maxPools = int(d.env.MI_WATCH_MAX, 30, 1, 200);
    // `confirmed` is 1 to 2 seconds behind the chain; `finalized` (the normal reading) about 13. A confirmed swap that the chain later dropped is
    // vanishingly rare, and this reading only adds trades the normal reading would add a few seconds later.
    const commitment = d.env.MI_WATCH_COMMITMENT === 'finalized' ? 'finalized' : 'confirmed';
    const lastPolled = new Map<string, number>();
    const gate = d.env.MI_SOLANA_GATE === '0' ? undefined : gateFor('watched');
    const sum = { passes: 0, watched: 0, eligible: 0, polled: 0, traded: 0 };
    let loggedAt = 0;
    tasks.push({
      id: 'solana:watched',
      chain: 'solana',
      lane: 'solana-watched',
      idleMs: watchEvery,
      run: async (budgetMs) => {
        watch.at = 0;
        await refreshWatch();
        const groups = [...specs].map(([id, spec]) => ({ spec, pools: watch.byAdapter.get(id) ?? [] })).filter((g) => g.pools.length > 0);
        if (groups.length === 0) return { ok: true, caughtUp: true };
        const chain = chainConfig('solana', d.env);
        const rpc = d.readFor ? d.readFor(chain) : makeRead(chain.rpcUrls, { fetchImpl: d.fetchImpl, concurrency: 3 });
        const nativeUsd = solUsdReader(rpc, d.now);
        sum.passes++;
        sum.watched = Math.max(sum.watched, groups.reduce((n, g) => n + g.pools.length, 0));
        let failed: string | null = null;
        const off = await d.store.disabledAdapters();
        for (const { spec, pools } of groups) {
          if (off.has(spec.id)) continue;
          try {
            const got = await followWatchedPools({ spec, chain, rpc, store: d.store, rules, now: d.now, launch: d.launch ?? null, nativeUsd, commitment, ...(gate ? { gate } : {}) }, pools, { budgetMs: Math.min(budgetMs, 20_000), maxPools, fastMs: watchEvery, lastPolled });
            sum.eligible += got.eligible;
            sum.polled += got.polled;
            sum.traded += got.traded;
          } catch (e) {
            failed = e instanceof Error ? e.message : 'the watched pools could not be read';
          }
        }
        if (d.log && d.now() - loggedAt >= 60_000) {
          loggedAt = d.now();
          d.log(`watched: ${sum.passes} pass(es) this minute, ${sum.watched} Solana pool(s) on screen (in the index), ${sum.eligible} followable, ${sum.polled} read, ${sum.traded} with new trades${gate ? `; balance check left ${gate.stats.skipped} of ${gate.stats.asked} alone` : ''}`);
          Object.assign(sum, { passes: 0, watched: 0, eligible: 0, polled: 0, traded: 0 });
        }
        return { ok: failed === null, error: failed, caughtUp: true };
      },
    });
  }

  // New Solana pools heard as they are created, not looked for: a websocket on each listed venue's program, one transaction read per creation.
  const listen = listenableVenues(d.env.MI_SOLANA_LISTEN);
  if (listen.length > 0) {
    const chain = chainConfig('solana', d.env);
    const rpc = d.readFor ? d.readFor(chain) : makeRead(chain.rpcUrls, { fetchImpl: d.fetchImpl, concurrency: 3 });
    const nativeUsd = solUsdReader(rpc, d.now);
    const wsUrl = /^wss:\/\/[^\s]+$/.test((d.env.MI_SOLANA_WS_URL ?? '').trim()) ? d.env.MI_SOLANA_WS_URL!.trim() : 'wss://api.mainnet-beta.solana.com';
    const queue: { h: Heard; tries: number }[] = [];
    const cache = new Map<string, TokenFacts | null>();
    const sum = { registered: 0, retried: 0, failed: 0 };
    let listener: Listener | null = null;
    let loggedAt = 0;
    tasks.push({
      id: 'solana:listen',
      chain: 'solana',
      lane: 'solana-listen',
      idleMs: 3_000,
      run: async (budgetMs) => {
        listener ??= startListener({ url: wsUrl, venues: listen, now: d.now, maxBytesPerMinute: int(d.env.MI_SOLANA_LISTEN_MAX_MB, 4, 1, 500) * 1_000_000, ...(d.log ? { log: d.log } : {}), ...(d.listenOpen ? { open: d.listenOpen } : {}), onHeard: (h) => { if (queue.length < 500) queue.push({ h, tries: 0 }); } });
        const deadline = d.now() + Math.min(budgetMs, 20_000);
        const later: { h: Heard; tries: number }[] = [];
        let error: string | null = null;
        while (queue.length > 0 && d.now() < deadline) {
          const item = queue.shift()!;
          try {
            const r = await registerHeard({ chain, rpc, store: d.store, rules, now: d.now, launch: d.launch ?? null, nativeUsd }, item.h, cache, emptyReport(item.h.adapterId));
            sum.registered += r.pools;
            if (r.retry && item.tries < 5) {
              later.push({ h: item.h, tries: item.tries + 1 });
              sum.retried++;
            }
          } catch (e) {
            error = e instanceof Error ? e.message : 'a new pool could not be registered';
            if (item.tries < 3) later.push({ h: item.h, tries: item.tries + 1 });
            else sum.failed++;
          }
        }
        queue.push(...later);
        if (d.log && d.now() - loggedAt >= 60_000) {
          loggedAt = d.now();
          const s = listener.stats;
          d.log(`listen: ${s.connected ? 'connected' : 'not connected'}, ${s.heard} creation(s) heard, ${sum.registered} pool(s) registered, ${sum.retried} retried, ${sum.failed} given up, ${Math.round(s.bytes / 1024)} KB received`);
        }
        return { ok: error === null, error, caughtUp: true };
      },
    });
  }

  // Pools that already existed: the venues' lists of their deepest pools are only hints; each address is read from the chain (owner program checked,
  // account parsed) before the index accepts it. A hundred accounts per read, a few new pools per run, deepest first. Off unless MI_SOLANA_SEED=1.
  if (d.env.MI_SOLANA_SEED === '1') {
    const chain = chainConfig('solana', d.env);
    const rpc = d.readFor ? d.readFor(chain) : makeRead(chain.rpcUrls, { fetchImpl: d.fetchImpl, concurrency: 3 });
    const nativeUsd = solUsdReader(rpc, d.now);
    const cache = new Map<string, TokenFacts | null>();
    const minTvl = int(d.env.MI_SOLANA_SEED_MIN_TVL, 3_000, 100, 10_000_000);
    const perRun = int(d.env.MI_SOLANA_SEED_PER_RUN, 25, 1, 100);
    const relistMs = 6 * 3_600_000;
    let list: { at: number; candidates: Candidate[]; cursor: number; failed: string[]; perSource: Record<string, number> } | null = null;
    const sum = { registered: 0, known: 0, skipped: 0, missing: 0 };
    let loggedAt = 0;
    tasks.push({
      id: 'solana:seed',
      chain: 'solana',
      lane: 'solana-seed',
      idleMs: int(d.env.MI_SOLANA_SEED_EVERY_SECONDS, 20, 5, 3_600) * 1000,
      run: async (budgetMs) => {
        const now = d.now();
        if (!list || (list.cursor >= list.candidates.length && now - list.at >= relistMs)) {
          const found = await findCandidates({ fetchImpl: d.fetchImpl ?? fetch, signal: AbortSignal.timeout(60_000), minTvlUsd: minTvl, maxPerSource: int(d.env.MI_SOLANA_SEED_MAX_PER_VENUE, 6_000, 100, 50_000) });
          // A venue that failed is tried again in a minute, not in six hours.
          list = { at: found.failed.length > 0 ? now - relistMs + 60_000 : now, candidates: found.candidates, cursor: 0, failed: found.failed, perSource: found.perSource };
        }
        const deadline = now + Math.min(budgetMs, 25_000);
        let error: string | null = null;
        try {
          // Pools already in the index cost one lookup, so they are skipped through quickly; the run stops after a batch that added pools.
          for (;;) {
            if (list.cursor >= list.candidates.length || d.now() >= deadline) break;
            const chunk = list.candidates.slice(list.cursor, list.cursor + perRun).map((c) => c.address);
            const r = await registerKnownPools({ chain, rpc, store: d.store, rules, now: d.now, launch: d.launch ?? null, nativeUsd }, chunk, cache, emptyReport('solana:seed'));
            list.cursor += chunk.length;
            sum.registered += r.registered;
            sum.known += r.known;
            sum.skipped += r.skipped;
            sum.missing += r.missing;
            if (r.registered > 0) break;
          }
        } catch (e) {
          error = e instanceof Error ? e.message : 'known pools could not be registered';
        }
        if (d.log && d.now() - loggedAt >= 60_000) {
          loggedAt = d.now();
          const per = Object.entries(list.perSource).map(([k, v]) => `${k} ${v}`).join(', ');
          d.log(`seed: ${list.candidates.length} pool(s) listed (${per}${list.failed.length > 0 ? `; failed: ${list.failed.join(', ')}` : ''}) at $${minTvl.toLocaleString('en-US')}+, ${list.cursor} looked at, ${sum.registered} added, ${sum.known} already known, ${sum.skipped} skipped, ${sum.missing} gone`);
        }
        return { ok: error === null, error, caughtUp: list.cursor >= list.candidates.length };
      },
    });
  }

  // Market intelligence: every few minutes the pools the index holds are read once and a snapshot of what the mood, rising/falling and venue
  // calculations read is stored for each network and for all of them (src/swings/market/intel/). The volume, momentum and stability parts of the
  // mood index and the venue growth figure are worked out from these. Off with MI_INTEL=0.
  if (d.intel && d.env.MI_INTEL !== '0') {
    const { url, key } = d.intel;
    tasks.push({
      id: 'market:intel',
      chain: 'solana',
      lane: 'market-intel',
      idleMs: int(d.env.MI_INTEL_EVERY_SECONDS, 300, 60, 3_600) * 1000,
      run: async () => {
        const now = d.now();
        const fetchImpl = d.fetchImpl ?? fetch;
        const headers = supabaseHeaders(key);
        const pools = await readIntelPools(postgrestReader(url, headers, fetchImpl, AbortSignal.timeout(90_000)), now);
        const rows = ['all', ...MI_CHAINS].flatMap((scope) => {
          const snap = buildSnapshot(pools, scope, now);
          return scope === 'all' || snap.eligible > 0 || snap.venues.length > 0 ? [rowOf(snap)] : [];
        });
        await writeSnapshots(url, headers, fetchImpl, rows, now);
        d.log?.(`market intel: ${pools.length} pool(s) read, ${rows.length} snapshot(s) stored`);
        return { ok: true, caughtUp: true };
      },
    });
  }

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
