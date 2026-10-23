/**
 * The last good Markets list for each view, kept in this browser. When the market service cannot be reached (it is shared
 * and rate-limited, so now and then it cannot), the page shows the last list it loaded, says how old it is, and keeps
 * trying by itself, instead of an empty page and an error. Only the first page of each view is kept, a few views at most.
 */
import type { StorageLike } from '../swings/history.js';
import type { MarketRow } from '../swings/market/types.js';

const STORE_KEY = 'aretia-market-lists-v1';
export const KEEP_VIEWS = 8;
export const KEEP_ROWS = 100;
/** A list older than this is no longer worth showing as "the last list". */
export const KEEP_MS = 24 * 3_600_000;

export interface SavedList {
  at: number;
  rows: MarketRow[];
}

export const listKey = (q: { kind: string; chain: string; window: string; page: number }): string => `${q.kind}|${q.chain}|${q.window}|${q.page}`;

function readAll(storage: StorageLike | null): Record<string, SavedList> {
  try {
    const raw = storage?.getItem(STORE_KEY);
    const v: unknown = raw ? JSON.parse(raw) : {};
    if (!v || typeof v !== 'object') return {};
    const out: Record<string, SavedList> = {};
    for (const [k, s] of Object.entries(v as Record<string, unknown>)) {
      const e = s as Partial<SavedList> | null;
      if (e && typeof e.at === 'number' && Array.isArray(e.rows)) out[k] = { at: e.at, rows: e.rows as MarketRow[] };
    }
    return out;
  } catch {
    return {};
  }
}

/** Keeps `rows` as the last good list for this view. The oldest views drop off beyond KEEP_VIEWS. */
export function saveList(storage: StorageLike | null, key: string, rows: readonly MarketRow[], now: number): void {
  if (rows.length === 0) return;
  const all = readAll(storage);
  all[key] = { at: now, rows: rows.slice(0, KEEP_ROWS) };
  const newest = Object.entries(all).sort((a, b) => b[1].at - a[1].at).slice(0, KEEP_VIEWS);
  try {
    storage?.setItem(STORE_KEY, JSON.stringify(Object.fromEntries(newest)));
  } catch {
    // storage may be full or blocked: the list simply is not kept
  }
}

/** The last good list for this view, or null when there is none or it is too old. */
export function readList(storage: StorageLike | null, key: string, now: number): SavedList | null {
  const hit = readAll(storage)[key];
  return hit && now - hit.at <= KEEP_MS ? hit : null;
}

/** How long ago, in words: "just now", "5 min ago", "2 h ago". */
export function ago(at: number, now: number): string {
  const min = Math.max(0, Math.round((now - at) / 60_000));
  return min < 1 ? 'just now' : min < 60 ? `${min} min ago` : `${Math.round(min / 60)} h ago`;
}

/** Seconds to wait before the next try after `failures` failures in a row: 8, 15, 30, then every 60. */
export function retryDelayMs(failures: number): number {
  return [8_000, 15_000, 30_000][failures] ?? 60_000;
}
