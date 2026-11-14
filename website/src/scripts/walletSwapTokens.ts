import { isChainId } from '../swings/core/types.js';
import type { HistoryItem } from '../swings/history.js';
import type { ExtraToken } from './walletEvmHoldings';

/** Fired by the swap page after a wallet's saved swaps were brought onto this device, so the dashboard can look at the tokens they name. */
export const HISTORY_SYNCED_EVENT = 'aretia:history-synced';

/**
 * The tokens a wallet has swapped through Aretia (both sides of every swap that went through), once each. A swap that failed, was rejected or
 * expired never moved a token, so it is not read; one from before addresses were kept names none.
 */
export function swapTokens(items: readonly Pick<HistoryItem, 'status' | 'chain' | 'fromAddress' | 'toAddress'>[]): ExtraToken[] {
  const seen = new Set<string>();
  const out: ExtraToken[] = [];
  for (const h of items) {
    if (h.status !== 'confirmed' && h.status !== 'submitted') continue;
    if (!isChainId(h.chain)) continue;
    for (const address of [h.toAddress, h.fromAddress]) {
      if (!address) continue;
      const key = `${h.chain}:${address.toLowerCase()}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({ chain: h.chain, address });
    }
  }
  return out;
}
