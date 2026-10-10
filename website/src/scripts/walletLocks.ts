/**
 * Finds out, in the page, which of the pools on screen have their liquidity locked, so the padlock does not depend on
 * Aretia's server having looked at the token first. The check itself is src/swings/market/lock.ts: it proves only that the
 * pool's liquidity token is burned (EVM V2-style pools and Raydium AMM v4), and says nothing about other kinds of pool.
 * Pools it cannot read, or finds under the limit, are remembered as "not shown to be locked" so they are not asked again.
 */
import { LOCK_MIN_PCT } from '../swings/market/lock.js';
import type { MarketRow } from '../swings/market/types.js';

const TTL_MS = 30 * 60_000;
const poolKey = (r: MarketRow): string => `${r.chain}:${r.chain === 'solana' ? r.pool : r.pool.toLowerCase()}`;

export interface LockQueueOptions {
  /** The share of the pool's liquidity that is burned, or null when it could not be shown. */
  check(row: MarketRow): Promise<number | null>;
  /** Some checks finished (at most a few times a second). Call `sync` with the rows on screen. */
  onChange(): void;
  concurrency?: number;
  now?: () => number;
}

export function createLockQueue(o: LockQueueOptions) {
  const done = new Map<string, { pct: number | null; at: number }>();
  const pending = new Set<string>();
  let waiting: MarketRow[] = [];
  let active = 0;
  let timer: ReturnType<typeof setTimeout> | null = null;
  const limit = o.concurrency ?? 4;
  const now = o.now ?? Date.now;

  const known = (r: MarketRow): { pct: number | null } | null => {
    const hit = done.get(poolKey(r));
    return hit && now() - hit.at <= TTL_MS ? { pct: hit.pct } : null;
  };
  const apply = (r: MarketRow, pct: number | null): boolean => {
    if (pct !== null && pct >= LOCK_MIN_PCT && r.lockedPct !== pct) {
      r.lockedPct = pct;
      return true;
    }
    return false;
  };
  const announce = (): void => {
    if (timer) return;
    timer = setTimeout(() => {
      timer = null;
      o.onChange();
    }, 250);
  };
  function pump(): void {
    while (active < limit && waiting.length > 0) {
      const row = waiting.shift()!;
      const k = poolKey(row);
      active++;
      o.check(row)
        .catch(() => null)
        .then((pct) => {
          done.set(k, { pct, at: now() });
          announce();
        })
        .finally(() => {
          pending.delete(k);
          active--;
          pump();
        });
    }
  }

  return {
    /** Applies what is already known to the rows and queues the rest, in the order they appear. */
    rate(rows: readonly MarketRow[]): MarketRow[] {
      waiting = [];
      pending.clear();
      for (const r of rows) {
        // A padlock Aretia's own records already gave is kept as it is.
        if (r.lockedPct !== null && r.lockedPct !== undefined) continue;
        if (!r.pool) continue;
        const k = known(r);
        if (k) {
          apply(r, k.pct);
          continue;
        }
        const key = poolKey(r);
        if (pending.has(key)) continue;
        pending.add(key);
        waiting.push(r);
      }
      pump();
      return rows as MarketRow[];
    },
    /** Hands finished results to the rows on screen, in place. Returns the rows that just got a padlock. */
    sync(rows: readonly MarketRow[]): MarketRow[] {
      const changed: MarketRow[] = [];
      for (const r of rows) {
        if (r.lockedPct !== null && r.lockedPct !== undefined) continue;
        const k = r.pool ? known(r) : null;
        if (k && apply(r, k.pct)) changed.push(r);
      }
      return changed;
    },
  };
}
