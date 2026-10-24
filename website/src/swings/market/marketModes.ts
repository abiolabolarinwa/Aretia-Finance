/**
 * What each Markets tab shows. The tab picks the kind of list, the 5M / 1H / 6H / 24H buttons pick the window, and a token must
 * clear the bar for that tab in that window or it is left out:
 *
 * - every list: high demand in the window (money traded and number of trades, both over a floor);
 * - Trending: the most demand first;
 * - Top: a significant gain in the window, the biggest first;
 * - Gainers: a gain in every window at once (5M, 1H, 6H and 24H), the biggest in the chosen window first.
 *
 * The floors are plain numbers so they can be tuned in one place. A token the source gives no figure for in a window is
 * left out of that window rather than guessed at.
 */
import type { MarketRow } from './types.js';

export type ModeKind = 'trending' | 'top' | 'gainers';
export type ModeWindow = 'm5' | 'h1' | 'h6' | 'h24';

/** Demand floors: traded value in the window (US dollars) and trades in the window. */
export const DEMAND: Record<ModeWindow, { volume: number; trades: number }> = {
  m5: { volume: 500, trades: 5 },
  h1: { volume: 2_000, trades: 20 },
  h6: { volume: 10_000, trades: 60 },
  h24: { volume: 25_000, trades: 150 },
};
/** A significant gain in the chosen window, in percent. */
export const TOP_GAIN: Record<ModeWindow, number> = { m5: 3, h1: 10, h6: 20, h24: 30 };
/** Gainers must be up by at least this in every window, in percent. */
export const GAINER_FLOOR: Record<ModeWindow, number> = { m5: 1, h1: 3, h6: 5, h24: 10 };

const WINDOWS: readonly ModeWindow[] = ['m5', 'h1', 'h6', 'h24'];
const WORD: Record<ModeWindow, string> = { m5: '5M', h1: '1H', h6: '6H', h24: '24H' };

export const volumeIn = (r: MarketRow, w: ModeWindow): number | null => r.volumeUsd?.[w] ?? (w === 'h24' ? r.volume24hUsd : null);
export const tradesIn = (r: MarketRow, w: ModeWindow): number | null => r.txns?.[w] ?? (w === 'h24' ? r.txns24h : null);

export function highDemand(r: MarketRow, w: ModeWindow): boolean {
  const v = volumeIn(r, w);
  const t = tradesIn(r, w);
  return v !== null && t !== null && v >= DEMAND[w].volume && t >= DEMAND[w].trades;
}

/**
 * The whole list, ordered by the tab's rule: the tokens that clear the bar come first, best first, and every other token follows
 * in the same order of merit. Nothing is removed, so a list never shrinks; `count` says how many clear the bar.
 */
export function modeRows(kind: ModeKind, w: ModeWindow, rows: readonly MarketRow[]): { rows: MarketRow[]; count: number } {
  const merit = (r: MarketRow): number => (kind === 'trending' ? (volumeIn(r, w) ?? -1) : (r.change[w] ?? -Infinity));
  const clears = (r: MarketRow): boolean => {
    if (!highDemand(r, w)) return false;
    if (kind === 'trending') return true;
    if (kind === 'top') return (r.change[w] ?? -Infinity) >= TOP_GAIN[w];
    return WINDOWS.every((x) => (r.change[x] ?? -Infinity) >= GAINER_FLOOR[x]);
  };
  const byMerit = (a: MarketRow, b: MarketRow): number => merit(b) - merit(a);
  const passing = rows.filter(clears).sort(byMerit);
  const rest = rows.filter((r) => !clears(r)).sort(byMerit);
  return { rows: [...passing, ...rest], count: passing.length };
}

/** The rule in words, shown above the table. */
export function modeNote(kind: ModeKind, w: ModeWindow, count: number, total: number): string {
  const demand = `at least $${DEMAND[w].volume.toLocaleString('en-US')} traded and ${DEMAND[w].trades} trades in ${WORD[w]}`;
  const rule =
    kind === 'trending'
      ? `high demand (${demand})`
      : kind === 'top'
        ? `up ${TOP_GAIN[w]}% or more in ${WORD[w]} with high demand (${demand})`
        : `up in every window (5M ${GAINER_FLOOR.m5}%+, 1H ${GAINER_FLOOR.h1}%+, 6H ${GAINER_FLOOR.h6}%+, 24H ${GAINER_FLOOR.h24}%+) with high demand in ${WORD[w]}`;
  return `${count} of ${total} tokens are ${rule}. They are listed first; the rest follow in the same order.`;
}
