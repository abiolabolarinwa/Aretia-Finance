/**
 * The tokens the overview cards (market mood, rising or falling, busiest venues) are worked out from: the index's own busiest pools by 24-hour
 * traded value, on every network or the chosen one, whatever list is on screen. A list such as Gainers holds only risers, so cards worked out
 * from the list's rows would always say "everything is up". These pools also carry the exchange they trade on (the market feed's rows do not),
 * which is what the busiest-venues card needs. Answers are kept for two minutes; a failed read gives what was kept, or nothing.
 */
import type { MarketRow } from './types.js';
import { marketRowsFromPools } from '../mi/clientRows.js';

const PAGES = 2;
const PAGE = 100;
const TTL_MS = 120_000;
const cache = new Map<string, { at: number; rows: MarketRow[]; running: Promise<MarketRow[]> | null }>();

export function resetOverviewSample(): void {
  cache.clear();
}

/** What is kept for this network choice now (empty before the first read). */
export function overviewSampleNow(chain: string): MarketRow[] {
  return cache.get(chain)?.rows ?? [];
}

export function fetchOverviewSample(chain: string, now: number, fetchImpl: typeof fetch = (...a) => fetch(...a)): Promise<MarketRow[]> {
  let e = cache.get(chain);
  if (!e) cache.set(chain, (e = { at: -Infinity, rows: [], running: null }));
  if (e.running) return e.running;
  if (now - e.at < TTL_MS) return Promise.resolve(e.rows);
  const entry = e;
  entry.running = (async (): Promise<MarketRow[]> => {
    const rows: MarketRow[] = [];
    let cursor: string | null = null;
    for (let page = 0; page < PAGES; page++) {
      const q = new URLSearchParams({ limit: String(PAGE) });
      if (chain) q.set('chain', chain);
      if (cursor) q.set('cursor', cursor);
      try {
        const res = await fetchImpl(`/api/v1/pools/top?${q}`, { headers: { accept: 'application/json' } });
        if (!res.ok) break;
        const body = (await res.json()) as { data?: unknown; meta?: { nextCursor?: unknown } };
        rows.push(...marketRowsFromPools(body.data, now));
        cursor = typeof body.meta?.nextCursor === 'string' && body.meta.nextCursor ? body.meta.nextCursor : null;
      } catch {
        break;
      }
      if (!cursor) break;
    }
    if (rows.length > 0) {
      entry.rows = rows;
      entry.at = now;
    }
    entry.running = null;
    return entry.rows;
  })();
  return entry.running;
}
