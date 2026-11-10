/**
 * The "Bullish only" view of the Markets lists, and the rule behind it. Pure.
 *
 * It is a filter the person turns on, with its rule written on the page, never a change to what a list contains by default. A row is
 * bullish when its price is up over both the last hour and the last 24 hours, and it is not a thin or one-wallet move: it needs a
 * minimum of trades, wallets and liquidity. Tokens that do not fit are hidden while it is on; turning it off shows everything again.
 */
import type { MarketRow } from './types.js';

export const BULLISH_RULE = { minLiquidityUsd: 1_000, minTrades24h: 10, minTraders24h: 5 } as const;

/** The sentence the page shows under the lists while the filter is on. */
export const BULLISH_TEXT = `Bullish only: price up over both the last hour and the last 24 hours, with at least ${BULLISH_RULE.minTrades24h} trades, ${BULLISH_RULE.minTraders24h} wallets (where the source counts them) and $${BULLISH_RULE.minLiquidityUsd.toLocaleString('en-US')} of liquidity in the last 24 hours. Tokens that do not fit are hidden; turn it off to see every token.`;

export function isBullish(r: Pick<MarketRow, 'change' | 'txns24h' | 'traders24h' | 'liquidityUsd'>): boolean {
  const h1 = r.change.h1;
  const h24 = r.change.h24;
  if (h1 === null || h24 === null || !(h1 > 0) || !(h24 > 0)) return false;
  if ((r.txns24h ?? 0) < BULLISH_RULE.minTrades24h) return false;
  // A source that does not count wallets cannot be held to that part of the rule; the rest still applies.
  if (r.traders24h !== null && r.traders24h < BULLISH_RULE.minTraders24h) return false;
  return (r.liquidityUsd ?? 0) >= BULLISH_RULE.minLiquidityUsd;
}
