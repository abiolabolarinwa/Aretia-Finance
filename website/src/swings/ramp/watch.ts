/**
 * How Aretia knows a ramp order is done when the provider cannot be asked. It watches the user's own wallet.
 *
 *  - Buy: done when the token balance is HIGHER than it was when the order was started. Aretia can say the crypto
 *    arrived; it cannot say how much of the increase came from this order, so the increase is shown, not assumed.
 *  - Sell: the crypto leaving the wallet is visible (balance LOWER than at the start), but the money arriving in the
 *    user's bank is not. Aretia says "the crypto was sent" and nothing about the payout, which is the provider's.
 */
import type { RampSide } from './types.js';

export interface RampWatch {
  side: RampSide;
  /** Raw token balance when the order was started. */
  baseline: bigint;
  startedAt: number;
}

export type WatchOutcome =
  | { state: 'waiting'; message: string }
  | { state: 'arrived'; delta: bigint; message: string }
  | { state: 'sent'; delta: bigint; message: string }
  | { state: 'unreadable'; message: string };

/** Pure. `current` is null when the balance could not be read, which is never treated as zero. */
export function judgeWatch(w: RampWatch, current: bigint | null): WatchOutcome {
  if (current === null) return { state: 'unreadable', message: 'Your balance could not be read just now. Nothing is assumed; try again shortly.' };
  if (w.side === 'buy') {
    return current > w.baseline
      ? { state: 'arrived', delta: current - w.baseline, message: 'Your balance went up since you started, so the crypto has arrived.' }
      : { state: 'waiting', message: 'Nothing has arrived yet. Card payments can take a few minutes; bank transfers longer.' };
  }
  return current < w.baseline
    ? { state: 'sent', delta: w.baseline - current, message: 'Your crypto has left your wallet. The provider pays you out, which Aretia cannot see: check with the provider for the payout.' }
    : { state: 'waiting', message: 'Your crypto is still in your wallet. Send it to the address the provider showed you to complete the sale.' };
}
