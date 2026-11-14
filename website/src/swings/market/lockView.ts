/**
 * What every row says about its pool's liquidity lock. A row always says something, and never more than Aretia has proven:
 *  - locked:  liquidity tokens burned (a burn is permanent), shown with the share;
 *  - timed:   held in a locker until a date (a time lock ends);
 *  - guarded: locked, but the token itself keeps an admin power (minting, freezing, pausing, upgrading), so the lock does not protect a buyer;
 *  - open:    Aretia read the pool and found no burn and no lock it can read. This is NOT a promise that the liquidity can be pulled: a lock in a
 *             locker contract Aretia cannot read does not show;
 *  - unknown: Aretia cannot yet read the lock of this kind of pool, or the chain did not answer;
 *  - checking: the read is under way.
 * Pure.
 */
import type { MarketRow } from './types.js';

export type LockKind = 'locked' | 'timed' | 'guarded' | 'open' | 'unknown' | 'checking';

export interface LockView {
  kind: LockKind;
  /** The short words shown in the table. */
  text: string;
  /** The full explanation, for the hover text and screen readers. */
  title: string;
}

const dateOf = (ms: number): string => new Date(ms).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });
const share = (pct: number): string => `${pct.toFixed(pct >= 99.95 ? 0 : 1)}%`;

export function lockView(r: Pick<MarketRow, 'lockedPct' | 'lockInfo' | 'risk' | 'lockState' | 'lockLowPct' | 'pool'>): LockView {
  const pct = r.lockedPct;
  if (pct !== null && pct !== undefined) {
    const timed = r.lockInfo?.kind === 'time-locked';
    const who = r.lockInfo?.by ? `${r.lockInfo.by}'s locker` : 'a locker contract';
    const base = timed
      ? r.lockInfo?.until === null || r.lockInfo?.until === undefined
        ? `${share(pct)} of the pool's active liquidity is held in ${who}, with an unlock date so far ahead it is effectively permanent. It is a lock, not a burn.`
        : `${share(pct)} of the pool's active liquidity is held in ${who} and cannot be withdrawn before ${dateOf(r.lockInfo.until)}. It is a time lock, not a burn: after that date the owner can take it out.`
      : `${share(pct)} of the pool's liquidity tokens are burned, so that money can never be withdrawn. Other liquidity in the pool, and tokens held by lock contracts, are not counted.`;
    if (r.risk?.adminPowers === true) {
      return { kind: 'guarded', text: `${timed ? 'Locked' : 'Burned'} · admin powers`, title: `${base} But the token keeps an admin power (such as minting, freezing, pausing or upgrading), so locked liquidity does not protect a buyer.` };
    }
    if (timed) return { kind: 'timed', text: r.lockInfo?.until ? `Locked · ${new Date(r.lockInfo.until).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: '2-digit' })}` : 'Locked', title: `Liquidity locked: ${base}` };
    return { kind: 'locked', text: `Burned ${share(pct)}`, title: `Liquidity locked: ${base}` };
  }
  if (r.lockState === 'checked') {
    const low = r.lockLowPct !== null && r.lockLowPct !== undefined ? ` Only ${share(r.lockLowPct)} of the liquidity tokens are burned or locked.` : '';
    return { kind: 'open', text: 'No lock found', title: `Aretia read this pool on the chain and found no burned liquidity and no lock it can read.${low} A lock in a locker contract Aretia cannot read would not show here, so this is not proof that the liquidity can be withdrawn.` };
  }
  if (r.lockState === 'unsupported') return { kind: 'unknown', text: 'Not checked', title: "Aretia cannot yet read the liquidity lock of this kind of pool. This is not a sign either way: it means no answer, not 'unlocked'." };
  if (r.lockState === 'unreadable') return { kind: 'unknown', text: 'Not checked', title: 'The chain did not answer when Aretia tried to read this pool. It will try again when the list refreshes. No answer is not a sign either way.' };
  if (!r.pool) return { kind: 'unknown', text: 'Not checked', title: 'This row has no pool address to read a lock from.' };
  return { kind: 'checking', text: 'Checking…', title: "Aretia is reading this pool's liquidity lock from the chain." };
}
