/**
 * Reading and writing the data the market intelligence engine uses, over the same PostgREST reader the Markets lists use: the pools the index
 * holds (the engine's inputs), the stored snapshots (its history), and writing a snapshot. Used by the public endpoint (api/_swingsMarketIntel.ts)
 * and by the worker task that stores a snapshot every few minutes. Pure apart from the calls the reader and `fetchImpl` make.
 */
import { MAX_PLAUSIBLE_LIQUIDITY_USD, POOL_SELECT, rowFromRecord, type PoolRecord, type Reader } from '../../mi/marketList.js';
import { DEFAULT_CONFIG, fromMarketRow, type IntelPool } from './common.js';
import { historyFrom, scopeOf, type SnapshotRow } from './snapshot.js';
import type { IntelHistory } from './ammi.js';

export const SNAPSHOT_TABLE = 'mi_market_snapshots';
const PAGE = 1_000;
/** The busiest pools by 24-hour volume are read, up to this many pages of 1,000. A longer tail adds little volume and a lot of requests. */
export const MAX_POOL_PAGES = 10;
const DAY = 86_400_000;
const SNAP_COLUMNS = 'scope,at,v,eligible,r1h,r24h,liquidity,volume24h,depth,arf,venues';

/** The pools the engine reads: active, not paused, traded in the last 24 hours, with the liquidity the checks need, busiest first. */
export function poolsPath(page: number, now: number): string {
  const f = ['state=eq.active', 'paused=is.false', 'vol24_usd=gt.0', `liquidity_usd=gte.${DEFAULT_CONFIG.minLiquidityUsd}`, `liquidity_usd=lte.${MAX_PLAUSIBLE_LIQUIDITY_USD}`, `last_trade_at=gte.${Math.floor(now - DAY)}`];
  return `mi_pools?select=${POOL_SELECT}&${f.join('&')}&order=vol24_usd.desc.nullslast,key.desc&limit=${PAGE}&offset=${page * PAGE}`;
}

export async function readIntelPools(reader: Reader, now: number, maxPages = MAX_POOL_PAGES): Promise<IntelPool[]> {
  const out: IntelPool[] = [];
  const empty = new Map();
  for (let page = 0; page < maxPages; page++) {
    const got = await reader.get(poolsPath(page, now), false);
    for (const rec of got.rows as PoolRecord[]) {
      const row = rowFromRecord(rec, empty, now);
      const p = row ? fromMarketRow(row) : null;
      if (p) out.push(p);
    }
    if (got.rows.length < PAGE) break;
  }
  return out;
}

/** The paths that read the history of one scope: the last 26 hours (every row), and the rows around each of 2 to 7 days ago. */
export function historyPaths(scope: string, now: number): string[] {
  const s = encodeURIComponent(scope);
  const windows = [2, 3, 4, 5, 6, 7].map((k) => `and(at.gte.${Math.floor(now - k * DAY - 30 * 60_000)},at.lte.${Math.floor(now - k * DAY + 30 * 60_000)})`);
  return [
    `${SNAPSHOT_TABLE}?select=${SNAP_COLUMNS}&scope=eq.${s}&at=gte.${Math.floor(now - 26 * 3_600_000)}&order=at.desc&limit=400`,
    `${SNAPSHOT_TABLE}?select=${SNAP_COLUMNS}&scope=eq.${s}&or=(${windows.join(',')})&order=at.desc&limit=200`,
  ];
}

export async function readHistory(reader: Reader, scope: string, now: number): Promise<{ history: IntelHistory; venuesPrev: Map<string, number> | null }> {
  const rows: SnapshotRow[] = [];
  for (const path of historyPaths(scope, now)) rows.push(...((await reader.get(path, false)).rows as SnapshotRow[]));
  return historyFrom(rows, now);
}

/** Stores snapshots (one request, a row that already exists is replaced) and removes those older than `keepDays` days. */
export async function writeSnapshots(base: string, headers: Record<string, string>, fetchImpl: typeof fetch, rows: readonly SnapshotRow[], now: number, keepDays = 8): Promise<void> {
  const root = `${base.replace(/\/$/, '')}/rest/v1/${SNAPSHOT_TABLE}`;
  if (rows.length > 0) {
    const res = await fetchImpl(`${root}?on_conflict=scope,at`, { method: 'POST', headers: { ...headers, 'content-type': 'application/json', prefer: 'resolution=merge-duplicates,return=minimal' }, body: JSON.stringify(rows) });
    if (!res.ok) throw new Error(`The snapshot write answered ${res.status}.`);
  }
  const del = await fetchImpl(`${root}?at=lt.${Math.floor(now - keepDays * DAY)}`, { method: 'DELETE', headers: { ...headers, prefer: 'return=minimal' } });
  if (!del.ok) throw new Error(`The snapshot cleanup answered ${del.status}.`);
}

export { scopeOf };
