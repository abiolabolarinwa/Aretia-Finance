/**
 * Small line icons shared by the Markets list and the token panel. Static markup only: nothing here comes from a token,
 * a pool or a person, so it is safe to set as HTML.
 */
const svg = (inner: string, size = 14): string =>
  `<svg viewBox="0 0 24 24" width="${size}" height="${size}" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${inner}</svg>`;

/** A closed padlock: this pool's liquidity is locked. */
export const LOCK_ICON = svg('<rect x="5" y="11" width="14" height="9" rx="2"/><path d="M8 11V8a4 4 0 0 1 8 0v3"/>');
export const COPY_ICON = svg('<rect x="9" y="9" width="11" height="11" rx="2"/><path d="M5 15V6a2 2 0 0 1 2-2h9"/>', 16);
export const CHECK_ICON = svg('<path d="M5 12.5l4.5 4.5L19 7.5"/>', 16);
export const OPEN_ICON = svg('<path d="M14 4h6v6M20 4l-9 9"/><path d="M18 14v4a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4"/>', 16);

export interface LockInfo {
  kind: 'burned' | 'time-locked';
  until: number | null;
  by?: string | undefined;
}

const dateOf = (ms: number): string => new Date(ms).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });

/** What the padlock means, in words, for its tooltip. A burn is permanent; a time lock ends, and says when. */
export function lockTitle(pct: number, info?: LockInfo | null): string {
  const share = pct.toFixed(pct >= 99.95 ? 0 : 1);
  if (info?.kind === 'time-locked') {
    const who = info.by ? `${info.by}'s locker` : 'a locker contract';
    return info.until === null
      ? `Locked: ${share}% of this pool's active liquidity is held in ${who}, with an unlock date so far ahead it is effectively permanent. It is still a lock, not a burn.`
      : `Locked until ${dateOf(info.until)}: ${share}% of this pool's active liquidity is held in ${who} and cannot be withdrawn before that date. It is a time lock, not a burn: after the date the owner can take it out.`;
  }
  return `Locked: ${share}% of this pool's liquidity tokens are burned, so that money cannot be withdrawn. Other liquidity in the pool, and tokens held by lock contracts, are not counted. No padlock means "not shown to be locked", not "unlocked".`;
}
