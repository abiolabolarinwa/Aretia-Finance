/**
 * Candles from Aretia's own recorded prices. A tick is one price reading of a pool at a moment; a candle is the first,
 * highest, lowest and last reading inside one time bucket. Buckets with no reading are left out, not filled in: a gap
 * means Aretia did not record that period, and the chart shows it as one.
 */
export interface Tick {
  ts: number;
  price: number;
}

export interface Candle {
  /** Start of the bucket, ms. */
  t: number;
  o: number;
  h: number;
  l: number;
  c: number;
  /** How many readings fell in the bucket. */
  n: number;
}

export const TIMEFRAMES = { '5m': 300_000, '15m': 900_000, '1h': 3_600_000, '4h': 14_400_000, '1d': 86_400_000 } as const;
export type Timeframe = keyof typeof TIMEFRAMES;
export const isTimeframe = (v: unknown): v is Timeframe => typeof v === 'string' && v in TIMEFRAMES;

/** Pure. Ticks may arrive in any order; bad prices are ignored. */
export function buildCandles(ticks: readonly Tick[], bucketMs: number): Candle[] {
  const sorted = ticks.filter((t) => Number.isFinite(t.ts) && Number.isFinite(t.price) && t.price > 0).sort((a, b) => a.ts - b.ts);
  const out: Candle[] = [];
  for (const t of sorted) {
    const start = Math.floor(t.ts / bucketMs) * bucketMs;
    const last = out[out.length - 1];
    if (last && last.t === start) {
      last.h = Math.max(last.h, t.price);
      last.l = Math.min(last.l, t.price);
      last.c = t.price;
      last.n++;
    } else out.push({ t: start, o: t.price, h: t.price, l: t.price, c: t.price, n: 1 });
  }
  return out;
}
