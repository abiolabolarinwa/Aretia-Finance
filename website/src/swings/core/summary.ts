import { DEFAULT_FEE_CONFIG, planBuyback } from './fee.js';
import { tokenKey } from './token.js';
import type { AretiaFeeConfig, Cost, Quote } from './types.js';

export interface ExecutionSummary {
  /** 1. The user's intended swap. */
  swap: { amountIn: bigint; expectedOut: bigint; minOut: bigint; priceImpactBps: number | null; route: string[] };
  /** 2. Network cost. Null = the provider did not report it. */
  network: Cost | null;
  /** 3. DEX / provider cost. Null = not itemised. */
  provider: Cost | null;
  /** 4. The Aretia ACT buyback. */
  aretiaBuyback: { state: 'off' | 'blocked' | 'ready'; amount: bigint; reasons: string[] };
  /** Whether signing may go ahead from the fee policy's point of view. */
  canProceed: boolean;
  /** Everything the user should read before signing, in plain words. */
  notes: string[];
}

/** The four-part summary shown before signing. Buyback is reported on its own and never folded into the swap. */
export function summarizeQuote(quote: Quote, config: AretiaFeeConfig = DEFAULT_FEE_CONFIG): ExecutionSummary {
  const buyback = planBuyback(quote.request.amountIn, quote.request.chain, config);
  const notes: string[] = [];
  if (quote.priceImpactBps === null) notes.push('The provider did not report a price impact.');
  else if (quote.priceImpactBps >= 300) notes.push(`High price impact: ${(quote.priceImpactBps / 100).toFixed(2)}%.`);
  if (quote.costs.network === null) notes.push('The network fee was not reported for this quote.');
  if (buyback.state === 'blocked') notes.push(...buyback.reasons);
  if (buyback.state === 'off') notes.push('No Aretia fee is charged on this swap.');
  const route = quote.route.legs.map((l) => l.venue || tokenKey(l.to));
  return {
    swap: { amountIn: quote.inAmount, expectedOut: quote.expectedOut, minOut: quote.minOut, priceImpactBps: quote.priceImpactBps, route },
    network: quote.costs.network,
    provider: quote.costs.provider,
    aretiaBuyback: { state: buyback.state, amount: buyback.amount, reasons: [...buyback.reasons] },
    canProceed: buyback.state !== 'blocked',
    notes,
  };
}
