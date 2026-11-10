/**
 * The "Top gainers" strip above the Markets lists: the five biggest 24-hour price rises on the chosen network (or on all of them), read
 * from Aretia's own market index. It is the index's Gainers list, so it carries that list's own bar (liquidity, trades, age) and is
 * labelled with it; nothing is added or removed to make it look better.
 */
import type { ChainId } from '../core/types.js';
import { isDeadMarket } from './dead.js';
import type { MarketRow } from './types.js';

export const STRIP_SIZE = 5;
/** The liquidity bar of the strip (the index's gainers also need trades and a pool older than ten minutes). */
export const STRIP_MIN_LIQUIDITY_USD = 1_000;

export function gainersStripUrl(chain: '' | ChainId): string {
  const q = new URLSearchParams({ src: 'index', kind: 'gainers', window: 'h24', page: '1', size: '50', minLiq: String(STRIP_MIN_LIQUIDITY_USD) });
  if (chain) q.set('chain', chain);
  return `/api/swings-market?${q}`;
}

/** The first rows that are really up over the day, best first. */
export function pickGainers(rows: readonly MarketRow[]): MarketRow[] {
  return rows.filter((r) => r.change.h24 !== null && r.change.h24 > 0 && !isDeadMarket(r)).slice(0, STRIP_SIZE);
}

/** The strip's rows, or an empty list when the index is unreachable or holds no gainers: a missing strip is never an error on the page. */
export async function fetchGainersStrip(chain: '' | ChainId, fetchImpl: typeof fetch = (...a) => fetch(...a), signal?: AbortSignal): Promise<MarketRow[]> {
  try {
    const res = await fetchImpl(gainersStripUrl(chain), { signal, headers: { accept: 'application/json' } });
    if (!res.ok) return [];
    const body = (await res.json()) as { rows?: unknown; error?: unknown };
    if (body.error || !Array.isArray(body.rows)) return [];
    return pickGainers(body.rows as MarketRow[]);
  } catch {
    return [];
  }
}
