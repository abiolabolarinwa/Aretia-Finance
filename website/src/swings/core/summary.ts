import { DEFAULT_FEE_CONFIG, planAretiaFee } from './fee.js';
import { tokenKey } from './token.js';
import type { AretiaFeeConfig, Cost, Quote } from './types.js';

export interface ExecutionSummary {
  /** 1. The user's intended swap (after the Aretia fee is taken out of what they entered). */
  swap: { amountIn: bigint; expectedOut: bigint; minOut: bigint; priceImpactBps: number | null; route: string[] };
  /** 2. Network cost. Null = the provider did not report it. */
  network: Cost | null;
  /** 3. DEX / provider cost. Null = not itemised. */
  provider: Cost | null;
  /** 4. The Aretia fee, in the asset the user is paying with. */
  aretiaFee: { state: 'off' | 'blocked' | 'ready'; amount: bigint; reasons: string[]; /** When state is 'off': switched off, or the swap is paid with a token that carries no fee (a sale). */ offBecause?: 'policy' | 'token' };
  /** Whether signing may go ahead from the fee policy's point of view. */
  canProceed: boolean;
  /** Everything the user should read before signing, in plain words. */
  notes: string[];
}

/** The four-part summary shown before signing. The fee is reported on its own and never folded into the swap. */
export function summarizeQuote(quote: Quote, config: AretiaFeeConfig = DEFAULT_FEE_CONFIG): ExecutionSummary {
  const plan = planAretiaFee(quote.request.amountIn, quote.request.chain, config, quote.request.from.address);
  // The fee the quote itself took out is what was charged: a screen that has no fee policy of its own must not report "none".
  const charged = quote.costs.aretiaFee.amount;
  const fee = charged > 0n && plan.state !== 'blocked' ? { ...plan, state: 'ready' as const, fee: charged } : plan;
  const notes: string[] = [];
  if (quote.priceImpactBps === null) notes.push('The provider did not report a price impact.');
  else if (quote.priceImpactBps >= 300) notes.push(`High price impact: ${(quote.priceImpactBps / 100).toFixed(2)}%.`);
  if (quote.costs.network === null) notes.push('The network fee was not reported for this quote.');
  if (fee.state === 'blocked') notes.push(...fee.reasons);
  const offBecause = fee.state === 'off' ? fee.offBecause : undefined;
  if (fee.state === 'off') notes.push(offBecause === 'token' ? 'No Aretia fee on this swap: Aretia charges only when you pay with a coin or a stablecoin, so selling a token is free.' : 'No Aretia fee is charged on this swap.');
  const route = quote.route.legs.map((l) => l.venue || tokenKey(l.to));
  return {
    swap: { amountIn: quote.inAmount, expectedOut: quote.expectedOut, minOut: quote.minOut, priceImpactBps: quote.priceImpactBps, route },
    network: quote.costs.network,
    provider: quote.costs.provider,
    aretiaFee: { state: fee.state, amount: fee.fee, reasons: [...fee.reasons], ...(offBecause ? { offBecause } : {}) },
    canProceed: fee.state !== 'blocked',
    notes,
  };
}
