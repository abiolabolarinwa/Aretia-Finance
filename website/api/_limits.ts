/**
 * Small fixed-window counters for limits tighter than the general per-IP limit in _rpcProxy.ts: per owner, per IP for one
 * operation, or one global budget for an expensive upstream call. Kept in memory, per server instance, like the general limit;
 * a shared store would make them exact across instances (see docs/operations.md).
 */
const windows = new Map<string, { count: number; start: number }>();

/**
 * Counts one use of `key` and says whether it is over `max` uses in the current window of `windowMs`. A refused use is still
 * counted, so hammering does not reset anything. Old windows are dropped so the map cannot grow without bound.
 */
export function overBudget(key: string, now: number, max: number, windowMs = 60_000): boolean {
  if (windows.size > 20_000) {
    for (const [k, w] of windows) if (now - w.start > 3_600_000) windows.delete(k);
    if (windows.size > 20_000) windows.clear();
  }
  const w = windows.get(key);
  if (!w || now - w.start >= windowMs) {
    windows.set(key, { count: 1, start: now });
    return max < 1;
  }
  w.count += 1;
  return w.count > max;
}

export function resetBudgets(): void {
  windows.clear();
}
