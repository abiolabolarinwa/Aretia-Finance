/**
 * MEV exposure estimate. Aretia does not submit swaps through a private or protected route, so a swap
 * can be sandwiched: a bot trades ahead of it, lets it execute at a worse price within the slippage
 * allowed, then trades back. The only controls available here are the slippage limit and trade size,
 * so this reports exposure honestly and does not claim protection.
 */
export type MevLevel = 'low' | 'elevated' | 'high';

export interface MevAssessment {
  level: MevLevel;
  /** Plain-language text for the review screen. */
  note: string;
}

/**
 * @param slippageBps  the slippage the user allows
 * @param impactBps    the trade's own price impact, or null when unknown
 */
export function assessMevExposure(slippageBps: number, impactBps: number | null): MevAssessment {
  const worst = Math.max(slippageBps, impactBps ?? 0);
  const level: MevLevel = slippageBps >= 300 || (impactBps ?? 0) >= 300 ? 'high' : worst >= 100 ? 'elevated' : 'low';
  const unknown = impactBps === null ? ' The size of your trade relative to the pool could not be measured.' : '';
  const notes: Record<MevLevel, string> = {
    low: 'Low sandwich exposure from the limits you set. Swaps are not sent through a protected route, so some exposure always remains.',
    elevated: 'Moderate sandwich exposure: a bot could move the price against you by up to your slippage setting. Lower slippage reduces this but can make the swap fail.',
    high: 'High sandwich exposure: a bot could take a large part of your slippage allowance or more. Consider a smaller amount or lower slippage. Swaps are not sent through a protected route.',
  };
  return { level, note: notes[level] + unknown };
}
