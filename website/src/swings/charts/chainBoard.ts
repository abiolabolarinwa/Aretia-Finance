/**
 * The dollar prices of every pool a Markets page shows, read from the chain together. Each network gets one request per read for all its
 * pools (one getMultipleAccounts on Solana, one batched call on the Ethereum-style networks), so fifty rows cost the public node about the same
 * as one chart. A pool is described once (what to read, the decimals) before its first price; a pool whose kind cannot be read is left to the
 * board's other sources.
 */
import { chainNativeUsd, planChainPrice, PUBLIC_NODES, publicRpc, type ChainPriceDeps, type PricePlan, type Rpc } from './chainPrice.js';
import { fromBase64 } from '../mi/solana/accounts.js';
import { nextPace } from './pace.js';
import type { ChainId } from '../core/types.js';

export interface BoardPool {
  chain: ChainId;
  pool: string;
  /** The token address whose price the row shows. */
  address: string;
}
export interface BoardPrice {
  /** `chain:pool` (the pool lower-cased except on Solana), the same key the live stream uses. */
  key: string;
  usd: number;
}

export type BatchRpc = (calls: { method: string; params: unknown[] }[]) => Promise<unknown[]>;

export interface BoardEnv {
  rpc: (chain: ChainId) => Rpc;
  batch: (chain: ChainId) => BatchRpc;
  usdOf: ChainPriceDeps['usdOf'];
  everyMs: number;
  /** How many pools are described at once. */
  describeAtOnce: number;
  isHidden: () => boolean;
  setTimer: (fn: () => void, ms: number) => unknown;
  clearTimer: (t: unknown) => void;
}

export const poolKey = (chain: ChainId, pool: string): string => `${chain}:${chain === 'solana' ? pool : pool.toLowerCase()}`;

/** A JSON-RPC batch to a chain's public node. A failed entry answers null; a failed request throws. */
export function publicBatch(chain: ChainId, fetchImpl: typeof fetch = (...a) => fetch(...a)): BatchRpc {
  return async (calls) => {
    const body = calls.map((c, i) => ({ jsonrpc: '2.0', id: i + 1, method: c.method, params: c.params }));
    const res = await fetchImpl(PUBLIC_NODES[chain], { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    if (!res.ok) throw new Error(`node answered ${res.status}`);
    const answer = (await res.json()) as unknown;
    if (!Array.isArray(answer)) throw new Error('batch not answered');
    const out: unknown[] = calls.map(() => null);
    for (const a of answer as { id?: number; result?: unknown; error?: unknown }[]) if (typeof a.id === 'number' && a.id >= 1 && a.id <= calls.length && !a.error) out[a.id - 1] = a.result ?? null;
    return out;
  };
}

/** The public Solana node answers at most 10 accounts to one getMultipleAccounts, so a read of fifty pools is several requests sent together. */
const SOLANA_CHUNK = 10;
/** How many accounts the first look at a page's pools covers. */
const PREFETCH_MAX = 100;
const EVM_CHUNK = 40;
const MAX_BACKOFF_MS = 10_000;
/** The longest wait between reads while no price on the page is moving. */
export const BOARD_CALM_MAX_MS = 8_000;
/** At most this many pools are read from the chain: the top of the list, where people look. The rest keep the index's live numbers. */
export const BOARD_CHAIN_MAX = 50;
const DESCRIBE_TRIES = 3;
const DESCRIBE_RETRY_MS = 3_000;

export function createBoardFeed(env: Partial<BoardEnv> & { onPrices: (list: BoardPrice[]) => void }): { setPools: (pools: readonly BoardPool[]) => void; stop: () => void; stats: () => { readable: number; unreadable: number; waiting: number } } {
  const rpcs = new Map<ChainId, Rpc>();
  const e: BoardEnv = {
    rpc:
      env.rpc ??
      ((chain) => {
        let r = rpcs.get(chain);
        if (!r) {
          r = publicRpc(chain);
          rpcs.set(chain, r);
        }
        return r;
      }),
    batch: env.batch ?? ((chain) => publicBatch(chain)),
    usdOf: env.usdOf ?? chainNativeUsd((c) => publicRpc(c)),
    everyMs: env.everyMs ?? 1000,
    describeAtOnce: env.describeAtOnce ?? 4,
    isHidden: env.isHidden ?? ((): boolean => typeof document !== 'undefined' && document.hidden),
    setTimer: env.setTimer ?? ((fn, ms): unknown => setTimeout(fn, ms)),
    clearTimer: env.clearTimer ?? ((t): void => clearTimeout(t as ReturnType<typeof setTimeout>)),
  };

  /** Pool key -> its plan, null when it cannot be read, undefined while it is being described. */
  const plans = new Map<string, PricePlan | null | undefined>();
  let wanted: BoardPool[] = [];
  let queue: BoardPool[] = [];
  let describing = 0;
  const lastSent = new Map<string, number>();
  const attempts = new Map<string, number>();
  let stopped = false;
  let timer: unknown = null;
  let backoff = 0;
  /** The wait before the next read while the reads succeed: the base pace, longer while nothing changes. */
  let pace = 0;

  /** Solana accounts (pools, token mints) read together before the pools are described, so describing a pool needs no request of its own. */
  const known = new Map<string, { owner: string; data: [string, string] } | null>();
  let prefetching: Promise<void> | null = null;
  const asked = new Set<string>();
  function prefetch(): void {
    if (prefetching) return;
    const want = [...new Set(queue.filter((p) => p.chain === 'solana').flatMap((p) => [p.pool, p.address]))].filter((a) => !asked.has(a)).slice(0, PREFETCH_MAX);
    if (want.length === 0) return;
    want.forEach((a) => asked.add(a));
    prefetching = (async () => {
      try {
        const parts: string[][] = [];
        for (let i = 0; i < want.length; i += SOLANA_CHUNK) parts.push(want.slice(i, i + SOLANA_CHUNK));
        await Promise.all(
          parts.map(async (part) => {
            try {
              const got = (await e.rpc('solana')('getMultipleAccounts', [part, { encoding: 'base64', commitment: 'confirmed' }])) as { value: ({ owner: string; data: [string, string] } | null)[] } | null;
              part.forEach((a, i) => {
                const v = got?.value?.[i];
                if (v) known.set(a, { owner: v.owner, data: v.data });
              });
            } catch {
              // Describing then asks for each of this part's accounts itself.
            }
          }),
        );
      } catch {
        // Describing then asks for each account itself.
      }
    })().finally(() => {
      prefetching = null;
      pump();
    });
  }
  /** The node, answering from the prefetched accounts where it can (describing only: prices are never read from here). */
  const describeRpc = (chain: ChainId): Rpc => {
    const base = e.rpc(chain);
    if (chain !== 'solana') return base;
    return async (method, params) => {
      if (method === 'getAccountInfo') {
        const hit = known.get(params[0] as string);
        if (hit) return { value: hit };
      } else if (method === 'getMultipleAccounts') {
        const list = params[0] as string[];
        if (list.every((a) => known.has(a))) return { value: list.map((a) => known.get(a)!) };
      }
      return base(method, params);
    };
  };

  function pump(): void {
    if (queue.some((p) => p.chain === 'solana') && !prefetching) prefetch();
    // Solana pools wait for their accounts to arrive.
    while (!stopped && describing < e.describeAtOnce && queue.length > 0 && !(prefetching && queue[0]!.chain === 'solana' && !known.has(queue[0]!.pool))) {
      const p = queue.shift()!;
      const key = poolKey(p.chain, p.pool);
      describing++;
      void planChainPrice({ chain: p.chain, pool: p.pool, target: p.address }, { rpc: describeRpc(p.chain), usdOf: e.usdOf })
        .then((plan) => {
          if (stopped) return;
          const tries = (attempts.get(key) ?? 0) + 1;
          attempts.set(key, tries);
          // A pool that could not be described may be of a kind that is not read, or the node may have refused a busy moment: it is asked
          // again a couple of times, a few seconds apart, before it is left to the board's other sources.
          if (plan === null && tries < DESCRIBE_TRIES) {
            setTimeout(() => {
              if (!stopped && wanted.some((w) => poolKey(w.chain, w.pool) === key)) {
                queue.push({ ...wanted.find((w) => poolKey(w.chain, w.pool) === key)! });
                pump();
              }
            }, DESCRIBE_RETRY_MS);
          } else plans.set(key, plan);
        })
        .catch(() => {
          if (!stopped) plans.set(key, null);
        })
        .finally(() => {
          describing--;
          pump();
        });
    }
  }

  async function readChain(chain: ChainId, keys: string[]): Promise<BoardPrice[]> {
    const out: BoardPrice[] = [];
    const ready = keys.map((k) => [k, plans.get(k)] as const).filter((x): x is readonly [string, PricePlan] => !!x[1]);
    if (chain === 'solana') {
      const mine = ready.filter((x) => x[1].kind === 'solana') as unknown as readonly [string, Extract<PricePlan, { kind: 'solana' }>][];
      const accounts = [...new Set(mine.flatMap(([, p]) => p.accounts))];
      const data = new Map<string, Uint8Array | null>();
      const parts: string[][] = [];
      for (let i = 0; i < accounts.length; i += SOLANA_CHUNK) parts.push(accounts.slice(i, i + SOLANA_CHUNK));
      await Promise.all(
        parts.map(async (part) => {
          const got = (await e.rpc(chain)('getMultipleAccounts', [part, { encoding: 'base64', commitment: 'confirmed' }])) as { value: ({ data: [string, string] } | null)[] } | null;
          part.forEach((a, j) => data.set(a, got?.value?.[j] ? fromBase64(got.value[j]!.data[0]) : null));
        }),
      );
      for (const [k, plan] of mine) {
        try {
          const usd = await plan.price(plan.accounts.map((a) => data.get(a) ?? null));
          if (usd !== null && usd > 0) out.push({ key: k, usd });
        } catch {
          // This pool gives no price this time; the others are unaffected.
        }
      }
      return out;
    }
    const mine = ready.filter((x) => x[1].kind === 'evm') as unknown as readonly [string, Extract<PricePlan, { kind: 'evm' }>][];
    const calls = mine.flatMap(([k, p]) => p.calls.map((c) => ({ k, c })));
    const results = new Map<string, (string | null)[]>();
    for (let i = 0; i < calls.length; i += EVM_CHUNK) {
      const part = calls.slice(i, i + EVM_CHUNK);
      const got = await e.batch(chain)(part.map((x) => ({ method: 'eth_call', params: [x.c, 'latest'] })));
      part.forEach((x, j) => {
        const list = results.get(x.k) ?? [];
        list.push(typeof got[j] === 'string' ? (got[j] as string) : null);
        results.set(x.k, list);
      });
    }
    for (const [k, plan] of mine) {
      try {
        const usd = await plan.price(results.get(k) ?? []);
        if (usd !== null && usd > 0) out.push({ key: k, usd });
      } catch {
        // As above.
      }
    }
    return out;
  }

  let lastChanged = true;
  async function tick(): Promise<void> {
    if (stopped) return;
    let failed = false;
    if (!e.isHidden()) {
      const byChain = new Map<ChainId, string[]>();
      for (const p of wanted) {
        const k = poolKey(p.chain, p.pool);
        if (!plans.get(k)) continue;
        const list = byChain.get(p.chain) ?? [];
        list.push(k);
        byChain.set(p.chain, list);
      }
      const changed: BoardPrice[] = [];
      await Promise.all(
        [...byChain].map(async ([chain, keys]) => {
          try {
            for (const r of await readChain(chain, keys)) {
              if (lastSent.get(r.key) !== r.usd) {
                lastSent.set(r.key, r.usd);
                changed.push(r);
              }
            }
          } catch {
            failed = true;
          }
        }),
      );
      lastChanged = changed.length > 0;
      if (!stopped && changed.length > 0) env.onPrices(changed);
    }
    backoff = failed ? Math.min(MAX_BACKOFF_MS, (backoff || e.everyMs) * 2) : 0;
    if (!e.isHidden() && !failed) pace = nextPace(e.everyMs, pace || e.everyMs, lastChanged, BOARD_CALM_MAX_MS);
    if (!stopped) timer = e.setTimer(() => void tick(), (pace || e.everyMs) + backoff);
  }

  return {
    setPools(pools) {
      if (stopped) return;
      wanted = pools.filter((p) => p.pool && p.address).slice(0, BOARD_CHAIN_MAX);
      // A new set of rows is read at the base pace at first, so its prices arrive quickly.
      pace = 0;
      const keep = new Set(wanted.map((p) => poolKey(p.chain, p.pool)));
      for (const k of [...lastSent.keys()]) if (!keep.has(k)) lastSent.delete(k);
      // Pools that left the page before they were described are forgotten, so they are described if they come back.
      for (const p of queue) if (!keep.has(poolKey(p.chain, p.pool))) plans.delete(poolKey(p.chain, p.pool));
      queue = queue.filter((p) => keep.has(poolKey(p.chain, p.pool)));
      for (const p of wanted) {
        const k = poolKey(p.chain, p.pool);
        if (plans.has(k)) continue;
        plans.set(k, undefined);
        queue.push(p);
      }
      pump();
      if (timer === null && wanted.length > 0) timer = e.setTimer(() => void tick(), 0);
    },
    stats() {
      const all = [...plans.values()];
      return { readable: all.filter((x) => !!x).length, unreadable: all.filter((x) => x === null).length, waiting: all.filter((x) => x === undefined).length };
    },
    stop() {
      stopped = true;
      if (timer !== null) e.clearTimer(timer);
      timer = null;
    },
  };
}
