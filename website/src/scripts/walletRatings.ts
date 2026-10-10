/**
 * Runs Aretia's on-chain check for the rows on screen, a few at a time, and tells the list when some have finished so
 * their cells can change from the market reading to the full rating. Finished checks are remembered (see RiskMemory),
 * so a list refresh, the side panel and the swap screen reuse them instead of asking the chain again.
 */
import type { TokenRisk } from '../swings/core/types.js';
import { needsCheck, riskKey, riskMemory, toRowRisk, withMarketReading, type CheckState } from '../swings/market/rowRisk.js';
import type { MarketRow } from '../swings/market/types.js';

export interface RatingQueueOptions {
  /** Aretia's on-chain check, given the pool's numbers. Null when the token could not be read. */
  assess(row: MarketRow): Promise<TokenRisk | null>;
  /** Some checks finished (called at most a few times a second). Call `sync` with the rows on screen. */
  onChange(): void;
  concurrency?: number;
}

export function createRatingQueue(o: RatingQueueOptions) {
  const state = new Map<string, CheckState>();
  let waiting: MarketRow[] = [];
  let active = 0;
  let timer: ReturnType<typeof setTimeout> | null = null;
  const limit = o.concurrency ?? 3;
  const keyOf = (r: MarketRow): string => riskKey(r.chain, r.address);

  function announce(): void {
    if (timer) return;
    timer = setTimeout(() => {
      timer = null;
      o.onChange();
    }, 250);
  }

  /** Applies a finished check to a row, in place. Returns whether the row's rating changed. */
  function apply(row: MarketRow, risk: TokenRisk | null): boolean {
    if (risk && risk.score !== null && risk.status !== 'unknown') {
      row.risk = toRowRisk(risk, 'onchain');
      state.set(keyOf(row), 'done');
      return true;
    }
    state.set(keyOf(row), 'failed');
    return false;
  }

  function pump(): void {
    while (active < limit && waiting.length > 0) {
      const row = waiting.shift()!;
      active++;
      o.assess(row)
        .catch(() => null)
        .then((risk) => {
          riskMemory.set(row.chain, row.address, risk);
          announce();
        })
        .finally(() => {
          active--;
          pump();
        });
    }
  }

  return {
    /**
     * Gives every row a rating now (its market reading, or a remembered check) and queues the on-chain check for the
     * rows that still need one, in the order they appear. Returns the rows to draw.
     */
    rate(rows: readonly MarketRow[]): MarketRow[] {
      // Checks not yet started belong to a list that is no longer on screen: forget them.
      for (const r of waiting) if (state.get(keyOf(r)) === 'pending') state.delete(keyOf(r));
      waiting = [];
      const out = rows.map((r) => withMarketReading(r));
      for (const row of out) {
        if (!needsCheck(row)) continue;
        const known = riskMemory.get(row.chain, row.address);
        if (known) {
          apply(row, known.risk);
          continue;
        }
        // One already being read keeps going; its result lands in the memory and `sync` hands it to the row.
        if (state.get(keyOf(row)) === 'pending') continue;
        state.set(keyOf(row), 'pending');
        waiting.push(row);
      }
      pump();
      return out;
    },
    /** Hands remembered results to the rows on screen, in place. Returns the rows whose rating changed. */
    sync(rows: readonly MarketRow[]): MarketRow[] {
      const changed: MarketRow[] = [];
      for (const row of rows) {
        if (!needsCheck(row)) continue;
        const known = riskMemory.get(row.chain, row.address);
        if (known && apply(row, known.risk)) changed.push(row);
        else if (known) state.set(keyOf(row), 'failed');
      }
      return changed;
    },
    stateOf: (row: MarketRow): CheckState | undefined => state.get(keyOf(row)),
  };
}
