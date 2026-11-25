/**
 * How long to wait before the next read of a price from the chain. While the price is moving, reads stay at the base pace; each read that finds
 * nothing new waits half as long again as the last, up to a ceiling, so a quiet market costs a handful of reads a minute instead of one a second.
 * Any change brings the pace straight back to the base.
 */
export function nextPace(baseMs: number, lastMs: number, changed: boolean, maxMs: number): number {
  if (changed) return baseMs;
  return Math.min(maxMs, Math.round(Math.max(baseMs, lastMs) * 1.5));
}
