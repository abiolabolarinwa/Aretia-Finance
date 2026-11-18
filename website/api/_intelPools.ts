/**
 * The pools the market intelligence engine reads, read once a minute and shared by everything in this function that needs them: the market
 * intelligence answer (api/_swingsMarketIntel.ts) and the stats bar (api/_swingsMarketStats.ts). One set of pools, so the bar's total and the
 * venues' total are worked out from the same ones. A read that fails leaves what was kept and throws, so the caller can serve its own older answer.
 */
import type { Reader } from '../src/swings/mi/marketList.js';
import type { IntelPool } from '../src/swings/market/intel/common.js';
import { readIntelPools } from '../src/swings/market/intel/read.js';

const FRESH_MS = 60_000;
let held: { at: number; rows: IntelPool[]; running: Promise<IntelPool[]> | null } | null = null;

export function resetIntelPools(): void {
  held = null;
}

export async function sharedIntelPools(reader: Reader, now: number): Promise<IntelPool[]> {
  if (held && now - held.at < FRESH_MS) return held.rows;
  if (held?.running) return held.running;
  const entry = held ?? { at: -Infinity, rows: [], running: null };
  held = entry;
  entry.running = readIntelPools(reader, now)
    .then((rows) => {
      entry.rows = rows;
      entry.at = now;
      return rows;
    })
    .finally(() => {
      entry.running = null;
    });
  return entry.running;
}
