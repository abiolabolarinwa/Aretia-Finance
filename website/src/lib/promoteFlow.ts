/**
 * The pure parts of the "Promote your token" dialog: reading what kind of address was pasted, and turning "start day plus how many
 * days" into the first and last day of a featured place. No DOM, no network.
 */
import { addressOk } from './verified';

export type NetworkGuess = 'solana' | 'evm' | null;
export const EVM_NETWORKS = ['bnb', 'ethereum', 'polygon'] as const;
export const DURATIONS = [3, 7, 14, 30] as const;

/** What the pasted address looks like. An 0x address could be on any of the three EVM networks, so the person picks. */
export function guessNetwork(address: string): NetworkGuess {
  const a = address.trim();
  if (!a) return null;
  if (addressOk('ethereum', a)) return 'evm';
  if (addressOk('solana', a)) return 'solana';
  return null;
}

const DAY = 86_400_000;
const iso = (ms: number): string => new Date(ms).toISOString().slice(0, 10);

/** The day after `now`, in UTC, as YYYY-MM-DD: the default first day. */
export const tomorrow = (now: Date): string => iso(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()) + DAY);

/** The first and last day of a place that starts on `start` and runs `days` days (both days included), or null for a bad start. */
export function featuredWindow(start: string, days: number): { from: string; to: string } | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(start) || !Number.isInteger(days) || days < 1) return null;
  const t = Date.parse(`${start}T00:00:00Z`);
  if (!Number.isFinite(t) || iso(t) !== start) return null;
  return { from: start, to: iso(t + (days - 1) * DAY) };
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
/** "14 Nov" for 2026-11-14. */
export function shortDay(day: string): string {
  const m = /^\d{4}-(\d{2})-(\d{2})$/.exec(day);
  return m ? `${Number(m[2])} ${MONTHS[Number(m[1]) - 1] ?? ''}`.trim() : day;
}
