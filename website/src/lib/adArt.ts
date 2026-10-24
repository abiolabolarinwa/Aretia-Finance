/**
 * Decorative chart art for the home-page adverts. The shapes are made up (a seeded random walk) and are always shown as an
 * illustration: they are never a real price history and carry no numbers.
 */

/** A small deterministic generator, so a given seed always draws the same chart. */
function rng(seed: number): () => number {
  let a = seed >>> 0 || 1;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** `count` closing values in 0..1 (1 is the top): a clear climb or fall from one end to the other, with noise on top. */
export function walk(seed: number, count: number, up: boolean): number[] {
  const r = rng(seed);
  const from = up ? 0.2 : 0.8;
  const to = up ? 0.8 : 0.2;
  let noise = 0;
  const out: number[] = [];
  for (let i = 0; i < count; i++) {
    noise = noise * 0.7 + (r() - 0.5) * 0.18;
    const trend = from + ((to - from) * i) / Math.max(1, count - 1);
    out.push(Math.min(0.95, Math.max(0.05, trend + noise)));
  }
  return out;
}

export interface ChartSvg {
  /** The markup inside a 400 by 240 viewBox. */
  inner: string;
}

/** Candlesticks or a filled line, in the light colour given, for a dark panel. */
export function chartArt(seed: number, style: 'candles' | 'line', up: boolean, color = '#ffffff', accent = '#d8d8da'): ChartSvg {
  const W = 400;
  const H = 240;
  const pad = 24;
  const n = style === 'candles' ? 26 : 40;
  const pts = walk(seed, n, up);
  const x = (i: number): number => pad + (i * (W - pad * 2)) / (n - 1);
  const y = (v: number): number => pad + (1 - v) * (H - pad * 2);
  const grid = [0.25, 0.5, 0.75].map((g) => `<line x1="${pad}" x2="${W - pad}" y1="${y(g).toFixed(1)}" y2="${y(g).toFixed(1)}" stroke="${color}" stroke-opacity="0.12" stroke-dasharray="3 5"/>`).join('');
  if (style === 'line') {
    const d = pts.map((v, i) => `${i === 0 ? 'M' : 'L'}${x(i).toFixed(1)} ${y(v).toFixed(1)}`).join('');
    const area = `${d}L${x(n - 1).toFixed(1)} ${H - pad}L${x(0).toFixed(1)} ${H - pad}Z`;
    return { inner: `${grid}<path d="${area}" fill="${accent}" fill-opacity="0.22"/><path d="${d}" fill="none" stroke="${color}" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"/>` };
  }
  const r = rng(seed + 7);
  const bars = pts
    .map((close, i) => {
      const open = i === 0 ? close : pts[i - 1]!;
      const hi = Math.min(0.98, Math.max(open, close) + r() * 0.07);
      const lo = Math.max(0.02, Math.min(open, close) - r() * 0.07);
      const rising = close >= open;
      const fill = rising ? color : accent;
      const top = y(Math.max(open, close));
      const h = Math.max(3, Math.abs(y(open) - y(close)));
      return `<line x1="${x(i).toFixed(1)}" x2="${x(i).toFixed(1)}" y1="${y(hi).toFixed(1)}" y2="${y(lo).toFixed(1)}" stroke="${fill}" stroke-width="2" stroke-linecap="round"/><rect x="${(x(i) - 5).toFixed(1)}" y="${top.toFixed(1)}" width="10" height="${h.toFixed(1)}" rx="2" fill="${fill}"/>`;
    })
    .join('');
  return { inner: grid + bars };
}
