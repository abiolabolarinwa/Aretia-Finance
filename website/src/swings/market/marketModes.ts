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

export type ModeKind = 'trending' | 'top' | 'gainers' | 'rising';
export type ModeWindow = 'm5' | 'h1' | 'h6' | 'h24';

/** Demand floors: traded value in the window (US dollars) and trades in the window. */
export const DEMAND: Record<ModeWindow, { volume: number; trades: number }> = {
  m5: { volume: 500, trades: 5 },
  h1: { volume: 2_000, trades: 20 },
  h6: { volume: 10_000, trades: 60 },
  h24: { volume: 25_000, trades: 150 },
};
/** Rising: buyers needed in the window, pool size, and how much faster new buyers arrive than before (a ratio). */
export const RISING_MIN_BUYERS: Record<ModeWindow, number> = { m5: 3, h1: 10, h6: 30, h24: 60 };
export const RISING_MIN_LIQUIDITY = 10_000;
export const RISING_MIN_GROWTH = 1.5;
/** Rising puts this many tokens per network at the top. */
export const RISING_PER_CHAIN = 10;
/** A significant gain in the chosen window, in percent. */
export const TOP_GAIN: Record<ModeWindow, number> = { m5: 3, h1: 10, h6: 20, h24: 30 };
/** Gainers must be up by at least this in every window, in percent. */
export const GAINER_FLOOR: Record<ModeWindow, number> = { m5: 1, h1: 3, h6: 5, h24: 10 };

const WINDOWS: readonly ModeWindow[] = ['m5', 'h1', 'h6', 'h24'];
const WORD: Record<ModeWindow, string> = { m5: '5M', h1: '1H', h6: '6H', h24: '24H' };

export const volumeIn = (r: MarketRow, w: ModeWindow): number | null => r.volumeUsd?.[w] ?? (w === 'h24' ? r.volume24hUsd : null);
export const tradesIn = (r: MarketRow, w: ModeWindow): number | null => r.txns?.[w] ?? (w === 'h24' ? r.txns24h : null);

const MINUTES: Record<ModeWindow, number> = { m5: 5, h1: 60, h6: 360, h24: 1440 };
/** The longer window each window is compared with. 24H is compared on its last 6 hours. */
const LONGER: Record<ModeWindow, ModeWindow> = { m5: 'h1', h1: 'h6', h6: 'h24', h24: 'h24' };

export const buyersIn = (r: MarketRow, w: ModeWindow): number | null => r.buyers?.[w] ?? null;

/**
 * How much faster new buyers are arriving in the window than in the earlier part of the longer window: buyers per minute now,
 * divided by buyers per minute before. 1 means no change, 3 means three times as fast. The source counts different buyers per
 * window, so a returning buyer can sit in both; the figure is an estimate. Null when the source gives no buyer counts.
 */
export function buyerGrowth(r: MarketRow, w: ModeWindow): number | null {
  const longer = LONGER[w];
  const recentWindow = w === 'h24' ? 'h6' : w;
  const recent = buyersIn(r, recentWindow);
  const total = buyersIn(r, longer);
  if (recent === null || total === null) return null;
  const nowRate = recent / MINUTES[recentWindow];
  const beforeRate = Math.max(0, total - recent) / (MINUTES[longer] - MINUTES[recentWindow]);
  // One buyer over the long window is the smallest rate that counts, so a token with no earlier buyers does not divide by zero.
  const floor = 1 / MINUTES[longer];
  return (nowRate + floor) / (beforeRate + floor);
}

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
  if (kind === 'rising') return risingRows(w, rows);
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

/** A token with real, growing buying: enough buyers, a pool worth trading in, real demand, and buyers arriving faster than before. */
export function isRising(r: MarketRow, w: ModeWindow): boolean {
  const buyers = buyersIn(r, w === 'h24' ? 'h24' : w);
  const growth = buyerGrowth(r, w);
  return (
    buyers !== null && buyers >= RISING_MIN_BUYERS[w] &&
    growth !== null && growth >= RISING_MIN_GROWTH &&
    (r.liquidityUsd ?? 0) >= RISING_MIN_LIQUIDITY &&
    highDemand(r, w)
  );
}

/**
 * Tokens with growing buyers first, fastest growth first. Each network's best ten go to the top, taken in turns (every network's
 * first, then every network's second, and so on), so no network is crowded out; the other tokens that clear the bar follow, then
 * everything else in the same order of merit. Nothing is removed.
 */
function risingRows(w: ModeWindow, rows: readonly MarketRow[]): { rows: MarketRow[]; count: number } {
  const merit = (r: MarketRow): number => buyerGrowth(r, w) ?? -1;
  const byMerit = (a: MarketRow, b: MarketRow): number => merit(b) - merit(a);
  const passing = rows.filter((r) => isRising(r, w)).sort(byMerit);
  const rest = rows.filter((r) => !isRising(r, w)).sort(byMerit);
  const perChain = new Map<string, MarketRow[]>();
  for (const r of passing) {
    const list = perChain.get(r.chain) ?? [];
    list.push(r);
    perChain.set(r.chain, list);
  }
  const top: MarketRow[] = [];
  for (let i = 0; i < RISING_PER_CHAIN; i++) for (const list of perChain.values()) if (list[i]) top.push(list[i]!);
  const inTop = new Set(top);
  return { rows: [...top, ...passing.filter((r) => !inTop.has(r)), ...rest], count: passing.length };
}

/** The rule in words, shown above the table. */
export function modeNote(kind: ModeKind, w: ModeWindow, count: number, total: number): string {
  const demand = `at least $${DEMAND[w].volume.toLocaleString('en-US')} traded and ${DEMAND[w].trades} trades in ${WORD[w]}`;
  if (kind === 'rising') {
    return `${count} of ${total} tokens have rising buyers: at least ${RISING_MIN_BUYERS[w]} buyers in ${WORD[w]}, new buyers arriving ${RISING_MIN_GROWTH}x faster than before, a pool of $${RISING_MIN_LIQUIDITY.toLocaleString('en-US')}+ and real trading. Each network's top ${RISING_PER_CHAIN} come first. Counted from the market data, which is an estimate.`;
  }
  const rule =
    kind === 'trending'
      ? `high demand (${demand})`
      : kind === 'top'
        ? `up ${TOP_GAIN[w]}% or more in ${WORD[w]} with high demand (${demand})`
        : `up in every window (5M ${GAINER_FLOOR.m5}%+, 1H ${GAINER_FLOOR.h1}%+, 6H ${GAINER_FLOOR.h6}%+, 24H ${GAINER_FLOOR.h24}%+) with high demand in ${WORD[w]}`;
  return `${count} of ${total} tokens are ${rule}. They are listed first; the rest follow in the same order.`;
}
