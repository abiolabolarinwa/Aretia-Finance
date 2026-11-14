/** The windows the boards cover. All in UTC, so every player in the world sees the same day, week and month. */
export type Period = 'day' | 'week' | 'month' | 'all';
export const PERIODS: readonly Period[] = ['day', 'week', 'month', 'all'];

export const isPeriod = (v: unknown): v is Period => typeof v === 'string' && (PERIODS as readonly string[]).includes(v);

/** When the current window began, in ms. A day starts at 00:00 UTC, a week on Monday at 00:00 UTC, a month on the 1st. */
export function periodStart(period: Period, now: number): number {
  if (period === 'all') return 0;
  const d = new Date(now);
  const day = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
  if (period === 'day') return day;
  if (period === 'week') return day - ((d.getUTCDay() + 6) % 7) * 86_400_000;
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1);
}

/** When the current window ends (the next one starts), in ms; null for all time. */
export function periodEnd(period: Period, now: number): number | null {
  if (period === 'all') return null;
  const start = periodStart(period, now);
  if (period === 'day') return start + 86_400_000;
  if (period === 'week') return start + 7 * 86_400_000;
  const d = new Date(now);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1);
}
