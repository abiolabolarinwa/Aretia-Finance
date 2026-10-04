/**
 * Price chart for the web wallet's Trade tab.
 *
 * Candles come from GeckoTerminal's public API (CORS-open, no key, nothing about the visitor is
 * sent: only a token or pool address). A thin market such as ACT has candles only for minutes in
 * which someone traded, so the series is filled forward (flat line when nothing traded) and the
 * axis is never stretched to make a fraction of a percent look dramatic.
 */

const GT = 'https://api.geckoterminal.com/api/v2/networks/solana';
const GT_HEADERS = { accept: 'application/json;version=20230302' };

export type Range = '1h' | '24h' | '7d';
interface RangeSpec {
  unit: 'minute' | 'hour';
  aggregate: number;
  limit: number;
  /** Seconds covered, and seconds per bucket. */
  span: number;
  step: number;
}
export const RANGES: Record<Range, RangeSpec> = {
  '1h': { unit: 'minute', aggregate: 1, limit: 60, span: 3600, step: 60 },
  '24h': { unit: 'minute', aggregate: 15, limit: 96, span: 86_400, step: 900 },
  '7d': { unit: 'hour', aggregate: 1, limit: 168, span: 604_800, step: 3600 },
};

export interface Candle {
  t: number;
  o: number;
  h: number;
  l: number;
  c: number;
  v: number;
}
export interface Point {
  t: number;
  c: number;
}

// ------------------------------------------------------------------ pure helpers

/**
 * One point per bucket across the whole range. A bucket with a candle uses its close; a bucket
 * without one carries the previous close forward; buckets before the first candle start from its
 * open. Returns [] when there are no candles at all.
 */
export function fillSeries(candles: readonly Candle[], range: Range, nowSec: number): Point[] {
  if (candles.length === 0) return [];
  const { step, span } = RANGES[range];
  const start = Math.floor((nowSec - span) / step) * step;
  const end = Math.floor(nowSec / step) * step;
  const byBucket = new Map<number, Candle>();
  let before: Candle | null = null;
  for (const c of [...candles].sort((a, b) => a.t - b.t)) {
    const bucket = Math.floor(c.t / step) * step;
    if (bucket < start) before = c;
    else byBucket.set(bucket, c);
  }
  const first = [...byBucket.entries()].sort((a, b) => a[0] - b[0])[0]?.[1];
  let last = before?.c ?? first?.o ?? candles[0]!.o;
  const out: Point[] = [];
  for (let t = start; t <= end; t += step) {
    const candle = byBucket.get(t);
    if (candle) last = candle.c;
    out.push({ t, c: last });
  }
  return out;
}

/** Axis limits: padded, and never tighter than ±1% around the middle, so a flat market looks flat. */
export function axisRange(values: readonly number[]): { min: number; max: number } {
  const lo = Math.min(...values);
  const hi = Math.max(...values);
  const mid = (lo + hi) / 2;
  let min = lo;
  let max = hi;
  if (mid > 0 && (hi - lo) / mid < 0.02) {
    min = mid * 0.99;
    max = mid * 1.01;
  }
  const pad = (max - min) * 0.06;
  return { min: Math.max(0, min - pad), max: max + pad };
}

export interface ChartStats {
  price: number;
  /** Change over the range as a fraction (0.02 = +2%). */
  change: number | null;
  high: number;
  low: number;
  /** Traded volume in USD over the candles shown. */
  volume: number;
}

export function chartStats(series: readonly Point[], candles: readonly Candle[], range: Range, nowSec: number): ChartStats | null {
  if (series.length === 0) return null;
  const first = series[0]!.c;
  const price = series[series.length - 1]!.c;
  const since = nowSec - RANGES[range].span;
  const inRange = candles.filter((c) => c.t >= since);
  const highs = inRange.map((c) => c.h);
  const lows = inRange.map((c) => c.l);
  return {
    price,
    change: first > 0 ? price / first - 1 : null,
    high: highs.length > 0 ? Math.max(...highs) : price,
    low: lows.length > 0 ? Math.min(...lows) : price,
    volume: inRange.reduce((sum, c) => sum + c.v, 0),
  };
}

/** Prices span from $60,000 to $0.0000004: four significant digits, never scientific notation. */
export function formatPrice(n: number): string {
  if (!Number.isFinite(n)) return '—';
  if (n >= 1000) return `$${n.toLocaleString('en-US', { maximumFractionDigits: 2 })}`;
  if (n >= 1) return `$${n.toFixed(2)}`;
  if (n === 0) return '$0';
  const digits = Math.min(10, Math.max(4, 3 - Math.floor(Math.log10(n))));
  return `$${n.toFixed(digits)}`;
}

// ------------------------------------------------------------------ data

interface GtList<T> {
  data?: T;
}
const poolCache = new Map<string, string | null>();
const candleCache = new Map<string, { at: number; candles: Candle[] }>();

async function gtJson<T>(path: string): Promise<T | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 12_000);
  try {
    const res = await fetch(`${GT}${path}`, { headers: GT_HEADERS, signal: controller.signal });
    return res.ok ? ((await res.json()) as T) : null;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/** The pool GeckoTerminal ranks first for a token, or null if it has none. */
export async function findPool(mint: string): Promise<string | null> {
  if (poolCache.has(mint)) return poolCache.get(mint) ?? null;
  const res = await gtJson<GtList<{ attributes?: { address?: string } }[]>>(`/tokens/${mint}/pools?page=1`);
  const address = res?.data?.[0]?.attributes?.address ?? null;
  if (address !== null || res !== null) poolCache.set(mint, address);
  return address;
}

/** Candles for a token's price in USD, oldest first. Cached for a minute. Null if the service is unavailable. */
export async function loadCandles(pool: string, mint: string, range: Range): Promise<Candle[] | null> {
  const key = `${pool}:${mint}:${range}`;
  const cached = candleCache.get(key);
  if (cached && Date.now() - cached.at < 60_000) return cached.candles;
  const r = RANGES[range];
  const res = await gtJson<GtList<{ attributes?: { ohlcv_list?: number[][] } }>>(`/pools/${pool}/ohlcv/${r.unit}?aggregate=${r.aggregate}&limit=${r.limit}&currency=usd&token=${mint}`);
  const list = res?.data?.attributes?.ohlcv_list;
  if (!Array.isArray(list)) return null;
  const candles = list
    .filter((row) => Array.isArray(row) && row.length >= 6 && row.slice(0, 6).every((x) => typeof x === 'number' && Number.isFinite(x)))
    .map(([t, o, h, l, c, v]) => ({ t: t!, o: o!, h: h!, l: l!, c: c!, v: v! }))
    .sort((a, b) => a.t - b.t);
  candleCache.set(key, { at: Date.now(), candles });
  return candles;
}

// ------------------------------------------------------------------ drawing

const SVG_NS = 'http://www.w3.org/2000/svg';
const svg = <K extends keyof SVGElementTagNameMap>(tag: K, attrs: Record<string, string>): SVGElementTagNameMap[K] => {
  const node = document.createElementNS(SVG_NS, tag);
  for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, v);
  return node;
};

function timeLabel(t: number, range: Range): string {
  const d = new Date(t * 1000);
  if (range === '7d') return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
  // The 24-hour axis starts and ends at the same clock time, so it needs the date to be readable.
  if (range === '24h') return d.toLocaleString('en-US', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false });
  return d.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: false });
}

/** Draws the line and area, the price axis and a hover read-out into `host`, replacing what was there. */
export function drawChart(host: HTMLElement, series: readonly Point[], range: Range, label: string): void {
  host.textContent = '';
  if (series.length < 2) return;
  const W = 640;
  const H = 240;
  const pad = { top: 12, right: 64, bottom: 26, left: 6 };
  const innerW = W - pad.left - pad.right;
  const innerH = H - pad.top - pad.bottom;
  const { min, max } = axisRange(series.map((p) => p.c));
  const x = (i: number) => pad.left + (i / (series.length - 1)) * innerW;
  const y = (v: number) => pad.top + (1 - (v - min) / (max - min || 1)) * innerH;

  const root = svg('svg', { viewBox: `0 0 ${W} ${H}`, role: 'img', 'aria-label': label, class: 'wapp__chart-svg' });
  const gradient = svg('linearGradient', { id: 'wapp-chart-fill', x1: '0', y1: '0', x2: '0', y2: '1' });
  gradient.append(svg('stop', { offset: '0%', 'stop-color': '#3a22c8', 'stop-opacity': '0.28' }), svg('stop', { offset: '100%', 'stop-color': '#3a22c8', 'stop-opacity': '0' }));
  root.append(svg('defs', {}));
  root.firstElementChild!.append(gradient);

  for (let g = 0; g <= 3; g++) {
    const v = min + ((max - min) * g) / 3;
    const gy = y(v);
    root.append(svg('line', { x1: String(pad.left), x2: String(W - pad.right), y1: String(gy), y2: String(gy), class: 'wapp__chart-grid' }));
    const text = svg('text', { x: String(W - pad.right + 6), y: String(gy + 4), class: 'wapp__chart-axis' });
    text.textContent = formatPrice(v);
    root.append(text);
  }
  const line = series.map((p, i) => `${i === 0 ? 'M' : 'L'}${x(i).toFixed(1)},${y(p.c).toFixed(1)}`).join(' ');
  root.append(svg('path', { d: `${line} L${x(series.length - 1).toFixed(1)},${pad.top + innerH} L${x(0).toFixed(1)},${pad.top + innerH} Z`, fill: 'url(#wapp-chart-fill)' }));
  root.append(svg('path', { d: line, class: 'wapp__chart-line' }));
  for (const [i, anchor] of [[0, 'start'], [series.length - 1, 'end']] as const) {
    const text = svg('text', { x: String(x(i)), y: String(H - 6), 'text-anchor': anchor, class: 'wapp__chart-axis' });
    text.textContent = timeLabel(series[i]!.t, range);
    root.append(text);
  }

  // hover read-out
  const cursor = svg('line', { y1: String(pad.top), y2: String(pad.top + innerH), class: 'wapp__chart-cursor', visibility: 'hidden' });
  const dot = svg('circle', { r: '4', class: 'wapp__chart-dot', visibility: 'hidden' });
  const hit = svg('rect', { x: String(pad.left), y: String(pad.top), width: String(innerW), height: String(innerH), fill: 'transparent' });
  root.append(cursor, dot, hit);
  const tip = document.createElement('div');
  tip.className = 'wapp__chart-tip';
  tip.hidden = true;
  host.append(root, tip);

  const show = (clientX: number) => {
    const box = root.getBoundingClientRect();
    const px = ((clientX - box.left) / box.width) * W;
    const i = Math.max(0, Math.min(series.length - 1, Math.round(((px - pad.left) / innerW) * (series.length - 1))));
    const p = series[i]!;
    cursor.setAttribute('x1', String(x(i)));
    cursor.setAttribute('x2', String(x(i)));
    dot.setAttribute('cx', String(x(i)));
    dot.setAttribute('cy', String(y(p.c)));
    cursor.setAttribute('visibility', 'visible');
    dot.setAttribute('visibility', 'visible');
    tip.hidden = false;
    tip.textContent = `${formatPrice(p.c)} · ${new Date(p.t * 1000).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false })}`;
    const left = (x(i) / W) * box.width;
    tip.style.left = `${Math.max(8, Math.min(box.width - 8, left))}px`;
  };
  const hide = () => {
    cursor.setAttribute('visibility', 'hidden');
    dot.setAttribute('visibility', 'hidden');
    tip.hidden = true;
  };
  hit.addEventListener('pointermove', (e) => show(e.clientX));
  hit.addEventListener('pointerdown', (e) => show(e.clientX));
  hit.addEventListener('pointerleave', hide);
}
