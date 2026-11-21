/**
 * The numbers behind the Transactions pane's Charts view, worked out from the pool's recent trades (see trades.ts): how much was bought and how much
 * sold, how the trades are spread by size, how they fall over time, and who made them. Pure: no page, no clock except the one handed in.
 *
 * "Value" is the trade's US dollar value when the trades have one, otherwise the amount of the pool's other token (the quote), so a chart is never
 * empty only because a source gives no dollar figure.
 */
import type { Trade } from './trades.js';

export type Basis = 'usd' | 'quote';

/** Dollars when most trades carry a dollar value, otherwise the quote token's amount. */
export function valueBasis(trades: readonly Pick<Trade, 'usd'>[]): Basis {
  const withUsd = trades.filter((t) => Number.isFinite(t.usd) && t.usd > 0).length;
  return trades.length > 0 && withUsd * 2 >= trades.length ? 'usd' : 'quote';
}

export const valueOf = (t: Pick<Trade, 'usd' | 'quoteAmount'>, basis: Basis): number => {
  const v = basis === 'usd' ? t.usd : t.quoteAmount;
  return Number.isFinite(v) && v > 0 ? v : 0;
};

export interface Split {
  buys: { n: number; value: number };
  sells: { n: number; value: number };
  /** Buys' share of the traded value, 0 to 100 (50 when there is none). */
  buyShare: number;
}

export function buySellSplit(trades: readonly Trade[], basis: Basis): Split {
  const s: Split = { buys: { n: 0, value: 0 }, sells: { n: 0, value: 0 }, buyShare: 50 };
  for (const t of trades) {
    const side = t.kind === 'buy' ? s.buys : s.sells;
    side.n++;
    side.value += valueOf(t, basis);
  }
  const total = s.buys.value + s.sells.value;
  if (total > 0) s.buyShare = (100 * s.buys.value) / total;
  else if (s.buys.n + s.sells.n > 0) s.buyShare = (100 * s.buys.n) / (s.buys.n + s.sells.n);
  return s;
}

export interface SizeBar {
  /** The bucket holds trades worth at least `lo` and less than `hi` (the last one includes `hi`). */
  lo: number;
  hi: number;
  buys: number;
  sells: number;
}

/** Trades counted by size, in buckets whose edges grow by a constant factor (a few big trades and many small ones read on one chart). */
export function sizeHistogram(trades: readonly Trade[], basis: Basis, buckets = 8): SizeBar[] {
  const values = trades.map((t) => ({ v: valueOf(t, basis), kind: t.kind })).filter((x) => x.v > 0);
  if (values.length === 0) return [];
  const min = Math.min(...values.map((x) => x.v));
  const max = Math.max(...values.map((x) => x.v));
  if (min === max) return [{ lo: min, hi: max, buys: values.filter((x) => x.kind === 'buy').length, sells: values.filter((x) => x.kind === 'sell').length }];
  const factor = Math.pow(max / min, 1 / buckets);
  const bars: SizeBar[] = Array.from({ length: buckets }, (_, i) => ({ lo: min * Math.pow(factor, i), hi: min * Math.pow(factor, i + 1), buys: 0, sells: 0 }));
  for (const x of values) {
    const i = Math.min(buckets - 1, Math.max(0, Math.floor(Math.log(x.v / min) / Math.log(factor))));
    if (x.kind === 'buy') bars[i]!.buys++;
    else bars[i]!.sells++;
  }
  return bars;
}

export interface TimeBar {
  /** Start of the bucket, in milliseconds. */
  start: number;
  seconds: number;
  buys: number;
  sells: number;
  /** Trades in the bucket. */
  n: number;
}

const BUCKET_SECONDS = [60, 300, 900, 1800, 3600, 7200] as const;

/** Traded value over time: buckets of 1, 5, 15, 30, 60 or 120 minutes, whichever keeps the chart to about `bars` columns, oldest first, with empty buckets kept. */
export function timeHistogram(trades: readonly Trade[], basis: Basis, bars = 24): TimeBar[] {
  const ok = trades.filter((t) => Number.isFinite(t.t));
  if (ok.length === 0) return [];
  const first = Math.min(...ok.map((t) => t.t));
  const last = Math.max(...ok.map((t) => t.t));
  const span = Math.max(1, (last - first) / 1000);
  const seconds = BUCKET_SECONDS.find((s) => span / s <= bars) ?? BUCKET_SECONDS[BUCKET_SECONDS.length - 1]!;
  const slot = (ms: number): number => Math.floor(ms / 1000 / seconds) * seconds * 1000;
  const start = slot(first);
  const count = Math.floor((slot(last) - start) / (seconds * 1000)) + 1;
  const out: TimeBar[] = Array.from({ length: count }, (_, i) => ({ start: start + i * seconds * 1000, seconds, buys: 0, sells: 0, n: 0 }));
  for (const t of ok) {
    const b = out[Math.floor((slot(t.t) - start) / (seconds * 1000))];
    if (!b) continue;
    b.n++;
    if (t.kind === 'buy') b.buys += valueOf(t, basis);
    else b.sells += valueOf(t, basis);
  }
  return out;
}

export interface TraderShare {
  trader: string;
  value: number;
  n: number;
  /** Share of all the traded value, 0 to 100. */
  share: number;
}

/** The wallets that traded the most value (at most `top`), then the rest together as one entry with an empty `trader`. */
export function topTraders(trades: readonly Trade[], basis: Basis, top = 5): TraderShare[] {
  const by = new Map<string, { value: number; n: number }>();
  let total = 0;
  for (const t of trades) {
    const v = valueOf(t, basis);
    total += v;
    const cur = by.get(t.trader) ?? { value: 0, n: 0 };
    cur.value += v;
    cur.n++;
    by.set(t.trader, cur);
  }
  if (total <= 0) return [];
  const sorted = [...by].map(([trader, x]) => ({ trader, ...x })).sort((a, b) => b.value - a.value);
  const head = sorted.slice(0, top).map((x) => ({ trader: x.trader, value: x.value, n: x.n, share: (100 * x.value) / total }));
  const rest = sorted.slice(top);
  if (rest.length > 0) {
    const value = rest.reduce((a, x) => a + x.value, 0);
    head.push({ trader: '', value, n: rest.reduce((a, x) => a + x.n, 0), share: (100 * value) / total });
  }
  return head;
}
