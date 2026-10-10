/**
 * Finds out, in the page, which of the pools on screen have their liquidity locked, so the padlock does not depend on
 * Aretia's server having looked at the token first. The check itself is src/swings/market/lock.ts: it proves only that the
 * pool's liquidity token is burned (EVM V2-style pools and Raydium AMM v4), and says nothing about other kinds of pool.
 * Pools it cannot read, or finds under the limit, are remembered as "not shown to be locked" so they are not asked again.
 */
import { LOCK_MIN_PCT } from '../swings/market/lock.js';
import type { MarketRow } from '../swings/market/types.js';

const TTL_MS = 30 * 60_000;
/** A read that failed (a busy node) is tried again after this long; it is never remembered as "not locked". */
const RETRY_MS = 30_000;
/** How many times a failed read is tried again on its own before it waits for the next refresh of the list. */
const MAX_TRIES = 3;
const poolKey = (r: MarketRow): string => `${r.chain}:${r.chain === 'solana' ? r.pool : r.pool.toLowerCase()}`;

/** What a check found: how much of the pool's liquidity is locked, and how. */
export interface LockFound {
  pct: number;
  kind: 'burned' | 'time-locked';
  until: number | null;
  by?: string | undefined;
}

export interface LockQueueOptions {
  /** What was found for the pool, or null when no lock could be shown. */
  check(row: MarketRow): Promise<LockFound | null>;
  /** Some checks finished (at most a few times a second). Call `sync` with the rows on screen. */
  onChange(): void;
  concurrency?: number;
  now?: () => number;
}

export function createLockQueue(o: LockQueueOptions) {
  const done = new Map<string, { found: LockFound | null; at: number }>();
  const pending = new Set<string>();
  const retryAt = new Map<string, number>();
  const tries = new Map<string, number>();
  let waiting: MarketRow[] = [];
  let active = 0;
  let timer: ReturnType<typeof setTimeout> | null = null;
  const limit = o.concurrency ?? 4;
  const now = o.now ?? Date.now;

  const known = (r: MarketRow): { found: LockFound | null } | null => {
    const hit = done.get(poolKey(r));
    return hit && now() - hit.at <= TTL_MS ? { found: hit.found } : null;
  };
  const apply = (r: MarketRow, found: LockFound | null): boolean => {
    if (found !== null && found.pct >= LOCK_MIN_PCT && r.lockedPct !== found.pct) {
      r.lockedPct = found.pct;
      r.lockInfo = { kind: found.kind, until: found.until, ...(found.by ? { by: found.by } : {}) };
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
        .then(
          (found) => {
            done.set(k, { found, at: now() });
            retryAt.delete(k);
            announce();
          },
          () => {
            // The node did not answer: no answer is remembered, and the pool is asked again after a pause (a few times on its
            // own, then whenever the list next refreshes).
            retryAt.set(k, now() + RETRY_MS);
            const n = (tries.get(k) ?? 0) + 1;
            tries.set(k, n);
            if (n < MAX_TRIES) {
              setTimeout(() => {
                if (done.has(k) || pending.has(k)) return;
                pending.add(k);
                waiting.push(row);
                pump();
              }, RETRY_MS);
            }
          },
        )
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
          apply(r, k.found);
          continue;
        }
        const key = poolKey(r);
        if (pending.has(key)) continue;
        if ((retryAt.get(key) ?? 0) > now()) continue;
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
        if (k && apply(r, k.found)) changed.push(r);
      }
      return changed;
    },
  };
}
