/**
 * Aretia's own price chart, drawn on a canvas from the prices Aretia recorded (see /api/swings-candles). It is used when
 * enough history exists for the pool; otherwise the caller shows the outside chart. History begins when Aretia began
 * recording a pool, so a young record is short, and a gap in the picture is a period nobody recorded.
 */
import type { Candle } from '../swings/market/candles.js';
import type { ChainId } from '../swings/core/types.js';

export type OwnTimeframe = '15m' | '1h' | '4h' | '1d';
export const OWN_TIMEFRAMES: readonly OwnTimeframe[] = ['15m', '1h', '4h', '1d'];
/** Fewer candles than this is not a chart worth drawing; the outside chart is shown instead. */
export const MIN_CANDLES = 8;

export async function fetchOwnCandles(chain: ChainId, pool: string, tf: OwnTimeframe, signal?: AbortSignal): Promise<{ candles: Candle[]; since: number | null } | null> {
  try {
    const res = await fetch(`/api/swings-candles?chain=${chain}&pool=${encodeURIComponent(pool)}&tf=${tf}`, { signal });
    if (!res.ok) return null;
    const body = (await res.json()) as { candles?: Candle[]; since?: number | null };
    return Array.isArray(body.candles) ? { candles: body.candles, since: typeof body.since === 'number' ? body.since : null } : null;
  } catch {
    return null;
  }
}

const css = (name: string, fallback: string): string => getComputedStyle(document.documentElement).getPropertyValue(name).trim() || fallback;

/** Draws up and down candles with a price scale on the right and a time scale underneath. */
export function drawCandles(canvas: HTMLCanvasElement, candles: readonly Candle[], bucketMs: number): void {
  const dpr = window.devicePixelRatio || 1;
  const w = canvas.clientWidth || 600;
  const h = canvas.clientHeight || 320;
  canvas.width = Math.round(w * dpr);
  canvas.height = Math.round(h * dpr);
  const g = canvas.getContext('2d');
  if (!g || candles.length === 0) return;
  g.scale(dpr, dpr);
  const up = '#16a34a';
  const down = '#dc2626';
  const grid = css('--line', 'rgba(128,128,128,.22)');
  const ink = css('--muted', '#6b7280');
  const padR = 62;
  const padB = 22;
  const plotW = w - padR;
  const plotH = h - padB;
  let lo = Math.min(...candles.map((c) => c.l));
  let hi = Math.max(...candles.map((c) => c.h));
  if (hi === lo) {
    hi *= 1.01;
    lo *= 0.99;
  }
  const y = (p: number): number => 4 + (1 - (p - lo) / (hi - lo)) * (plotH - 8);
  g.clearRect(0, 0, w, h);
  g.font = '11px system-ui, sans-serif';
  g.fillStyle = ink;
  g.strokeStyle = grid;
  g.lineWidth = 1;
  for (let i = 0; i <= 4; i++) {
    const p = lo + ((hi - lo) * i) / 4;
    const yy = y(p);
    g.beginPath();
    g.moveTo(0, yy);
    g.lineTo(plotW, yy);
    g.stroke();
    g.fillText(p >= 1 ? p.toFixed(4) : p.toPrecision(4), plotW + 6, yy + 4);
  }
  // Candles sit on a time axis, so a missing period shows as a gap.
  const t0 = candles[0]!.t;
  const span = Math.max(bucketMs, candles[candles.length - 1]!.t - t0 + bucketMs);
  const cw = Math.max(1, Math.min(14, (plotW / span) * bucketMs * 0.7));
  for (const c of candles) {
    const x = ((c.t - t0 + bucketMs / 2) / span) * plotW;
    const color = c.c >= c.o ? up : down;
    g.strokeStyle = color;
    g.fillStyle = color;
    g.beginPath();
    g.moveTo(x, y(c.h));
    g.lineTo(x, y(c.l));
    g.stroke();
    const top = y(Math.max(c.o, c.c));
    g.fillRect(x - cw / 2, top, cw, Math.max(1, y(Math.min(c.o, c.c)) - top));
  }
  g.fillStyle = ink;
  const daily = bucketMs >= 86_400_000;
  const label = (t: number): string => new Date(t).toLocaleString(undefined, daily ? { month: 'short', day: 'numeric' } : { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
  for (let i = 0; i <= 3; i++) g.fillText(label(t0 + (span * i) / 3), (plotW * i) / 3 + (i === 3 ? -80 : 2), h - 6);
}
