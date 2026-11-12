/**
 * Two guards for the Markets lists, both pure.
 *
 * A price change beyond MAX_CREDIBLE_CHANGE_PCT (1,000%, an eleven-fold move) is shown as ">1,000%" and does not rank in Gainers:
 * on a pool that opened days ago and was thin, the starting price is often a dust-priced first trade, so the exact figure means
 * nothing and a list sorted by it is topped by the least trustworthy tokens.
 *
 * One token symbol is listed once per network in a list (the best-ranked pool stays). Copies of a token, made to look like it and
 * sharing its symbol, would otherwise fill several rows. A token's page, search and Favourites are not affected.
 */
import type { MarketRow } from './types.js';

export const MAX_CREDIBLE_CHANGE_PCT = 1000;

/** True when a change is a number but beyond what is credible. */
export const isBeyondCredible = (n: number | null): boolean => n !== null && Number.isFinite(n) && Math.abs(n) > MAX_CREDIBLE_CHANGE_PCT;

const symbolKey = (r: Pick<MarketRow, 'chain' | 'symbol'>): string | null => {
  const s = r.symbol.trim().toUpperCase();
  return s ? `${r.chain}:${s}` : null;
};

/** The list with each symbol on each network once, in the order given: the first row of a symbol stays. */
export function dedupeBySymbol<T extends Pick<MarketRow, 'chain' | 'symbol'>>(rows: readonly T[]): T[] {
  const seen = new Set<string>();
  const out: T[] = [];
  for (const r of rows) {
    const k = symbolKey(r);
    if (k !== null) {
      if (seen.has(k)) continue;
      seen.add(k);
    }
    out.push(r);
  }
  return out;
}
