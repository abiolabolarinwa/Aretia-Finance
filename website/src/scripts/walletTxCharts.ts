/**
 * The Charts view of the Transactions pane: four small charts of the pool's recent trades, drawn as SVG with no library. A donut of buys against
 * sells, a histogram of trade sizes, the traded value over time, and a donut of who traded the most. What they are made from is worked out in
 * src/swings/charts/tradeStats.ts. Everything drawn is set as text or as numbers, never as markup.
 */
import type { ChainId } from '../swings/core/types.js';
import { formatAmount, formatTradeUsd, traderLink, type Trade } from '../swings/charts/trades.js';
import { buySellSplit, sizeHistogram, timeHistogram, topTraders, valueBasis, type Basis } from '../swings/charts/tradeStats.js';

const NS = 'http://www.w3.org/2000/svg';

function svgEl<K extends keyof SVGElementTagNameMap>(tag: K, attrs: Record<string, string | number> = {}, cls = ''): SVGElementTagNameMap[K] {
  const e = document.createElementNS(NS, tag);
  for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, String(v));
  if (cls) e.setAttribute('class', cls);
  return e;
}

function node<K extends keyof HTMLElementTagNameMap>(tag: K, cls = '', text?: string): HTMLElementTagNameMap[K] {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text !== undefined) n.textContent = text;
  return n;
}

export interface ChartOptions {
  chain: ChainId;
  /** The pool's other token, for amounts when there is no dollar value. */
  quoteSymbol?: string;
}

const money = (v: number, basis: Basis, quote: string): string => (basis === 'usd' ? formatTradeUsd(v) : `${formatAmount(v)} ${quote}`);
const clock = (ms: number): string => new Date(ms).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
const shortId = (id: string): string => (id.length <= 11 ? id : `${id.slice(0, 4)}…${id.slice(-4)}`);

/** A ring of coloured arcs, one per segment, with up to two short lines of text in the middle. */
function donut(segments: readonly { value: number; cls: string; title: string }[], centre: readonly string[], label: string): SVGSVGElement {
  const R = 42;
  const C = 2 * Math.PI * R;
  const total = segments.reduce((a, s) => a + s.value, 0);
  const svg = svgEl('svg', { viewBox: '0 0 120 120', class: 'wapp-txc__donut', role: 'img', 'aria-label': label });
  svg.append(svgEl('circle', { cx: 60, cy: 60, r: R, fill: 'none', 'stroke-width': 16 }, 'wapp-txc__track'));
  let at = 0;
  for (const s of segments) {
    if (s.value <= 0 || total <= 0) continue;
    const len = (s.value / total) * C;
    const arc = svgEl('circle', { cx: 60, cy: 60, r: R, fill: 'none', 'stroke-width': 16, 'stroke-dasharray': `${Math.max(0, len - 0.6)} ${C - Math.max(0, len - 0.6)}`, 'stroke-dashoffset': -at, transform: 'rotate(-90 60 60)' }, s.cls);
    const t = svgEl('title');
    t.textContent = s.title;
    arc.append(t);
    svg.append(arc);
    at += len;
  }
  centre.forEach((line, i) => {
    const t = svgEl('text', { x: 60, y: centre.length === 1 ? 65 : i === 0 ? 58 : 72, 'text-anchor': 'middle' }, i === 0 ? 'wapp-txc__big' : 'wapp-txc__small');
    t.textContent = line;
    svg.append(t);
  });
  return svg;
}

/** Stacked bars (buys at the bottom, sells above) with the smallest and largest labels under the first and last bar. */
function bars(data: readonly { buys: number; sells: number; title: string }[], from: string, to: string, label: string): SVGSVGElement {
  const W = 260;
  const H = 110;
  const top = 6;
  const base = H - 16;
  const max = Math.max(...data.map((d) => d.buys + d.sells), 0);
  const svg = svgEl('svg', { viewBox: `0 0 ${W} ${H}`, class: 'wapp-txc__bars', role: 'img', 'aria-label': label, preserveAspectRatio: 'none' });
  svg.append(svgEl('line', { x1: 0, y1: base, x2: W, y2: base }, 'wapp-txc__axis'));
  const gap = data.length > 16 ? 1.5 : 4;
  const w = (W - gap * (data.length - 1)) / data.length;
  data.forEach((d, i) => {
    const x = i * (w + gap);
    const hb = max > 0 ? ((base - top) * d.buys) / max : 0;
    const hs = max > 0 ? ((base - top) * d.sells) / max : 0;
    const g = svgEl('g');
    const t = svgEl('title');
    t.textContent = d.title;
    g.append(t);
    if (hb > 0) g.append(svgEl('rect', { x, y: base - hb, width: w, height: hb, rx: 1.5 }, 'wapp-txc__buy-fill'));
    if (hs > 0) g.append(svgEl('rect', { x, y: base - hb - hs, width: w, height: hs, rx: 1.5 }, 'wapp-txc__sell-fill'));
    // A wide invisible bar so the hover reaches a column that is only a few pixels tall.
    g.append(svgEl('rect', { x, y: top, width: w, height: base - top, fill: 'transparent' }));
    svg.append(g);
  });
  const l = svgEl('text', { x: 0, y: H - 3 }, 'wapp-txc__tick');
  l.textContent = from;
  const r = svgEl('text', { x: W, y: H - 3, 'text-anchor': 'end' }, 'wapp-txc__tick');
  r.textContent = to;
  svg.append(l, r);
  return svg;
}

function card(title: string, sub: string): HTMLElement {
  const c = node('section', 'wapp-txc__card');
  c.append(node('h4', 'wapp-txc__h', title), node('p', 'wapp__fine wapp-txc__sub', sub));
  return c;
}

function legend(items: readonly { cls: string; text: string; href?: string | null }[]): HTMLElement {
  const ul = node('ul', 'wapp-txc__legend');
  for (const it of items) {
    const li = node('li');
    li.append(node('i', `wapp-txc__dot ${it.cls}`));
    if (it.href) {
      const a = node('a', 'wapp-txc__link', it.text);
      a.href = it.href;
      a.target = '_blank';
      a.rel = 'noopener noreferrer nofollow';
      li.append(a);
    } else li.append(node('span', '', it.text));
    ul.append(li);
  }
  return ul;
}

/** Draws the four charts for these trades into `host`. */
export function renderCharts(host: HTMLElement, trades: readonly Trade[], o: ChartOptions): void {
  if (trades.length < 3) {
    const p = node('p', 'wapp__fine wapp-tx__empty', 'Too few trades to chart yet. The charts appear once the pool has three or more trades in the last 24 hours.');
    p.setAttribute('role', 'status');
    host.replaceChildren(p);
    return;
  }
  const basis = valueBasis(trades);
  const quote = o.quoteSymbol || 'quote';
  const unit = basis === 'usd' ? 'US dollars' : quote;
  const grid = node('div', 'wapp-txc');

  // 1. Buys against sells.
  const split = buySellSplit(trades, basis);
  const c1 = card('Buys against sells', `Share of the traded value, in ${unit}`);
  const row1 = node('div', 'wapp-txc__row');
  row1.append(
    donut(
      [
        { value: split.buys.value || split.buys.n, cls: 'wapp-txc__buy', title: `Buys: ${split.buys.n} trades, ${money(split.buys.value, basis, quote)}` },
        { value: split.sells.value || split.sells.n, cls: 'wapp-txc__sell', title: `Sells: ${split.sells.n} trades, ${money(split.sells.value, basis, quote)}` },
      ],
      [`${Math.round(split.buyShare)}%`, 'buys'],
      `Buys are ${Math.round(split.buyShare)} percent of the traded value`,
    ),
    legend([
      { cls: 'wapp-txc__buy', text: `▲ Buys · ${split.buys.n} trades · ${money(split.buys.value, basis, quote)}` },
      { cls: 'wapp-txc__sell', text: `▼ Sells · ${split.sells.n} trades · ${money(split.sells.value, basis, quote)}` },
    ]),
  );
  c1.append(row1);

  // 2. Trade sizes.
  const sizes = sizeHistogram(trades, basis);
  const c2 = card('Trade sizes', `How many trades of each size, in ${unit}`);
  if (sizes.length > 0) {
    c2.append(
      bars(
        sizes.map((b) => ({ buys: b.buys, sells: b.sells, title: `${money(b.lo, basis, quote)} to ${money(b.hi, basis, quote)}: ${b.buys} buys, ${b.sells} sells` })),
        money(sizes[0]!.lo, basis, quote),
        money(sizes[sizes.length - 1]!.hi, basis, quote),
        `Trade sizes from ${money(sizes[0]!.lo, basis, quote)} to ${money(sizes[sizes.length - 1]!.hi, basis, quote)}`,
      ),
    );
  }

  // 3. Value over time.
  const time = timeHistogram(trades, basis);
  const c3 = card('Traded value over time', time.length > 0 ? `Each bar is ${time[0]!.seconds >= 3600 ? `${time[0]!.seconds / 3600} h` : `${time[0]!.seconds / 60} min`}, in ${unit}` : '');
  if (time.length > 0) {
    c3.append(
      bars(
        time.map((b) => ({ buys: b.buys, sells: b.sells, title: `${clock(b.start)}: ${b.n} trades, bought ${money(b.buys, basis, quote)}, sold ${money(b.sells, basis, quote)}` })),
        clock(time[0]!.start),
        clock(time[time.length - 1]!.start),
        'Traded value over time, buys and sells',
      ),
    );
  }

  // 4. Who traded.
  const traders = topTraders(trades, basis);
  const c4 = card('Who traded the most', `Share of the traded value by wallet, in ${unit}`);
  if (traders.length > 0) {
    const row4 = node('div', 'wapp-txc__row');
    row4.append(
      donut(
        traders.map((x, i) => ({ value: x.value, cls: x.trader === '' ? 'wapp-txc__c-rest' : `wapp-txc__c${i % 5}`, title: `${x.trader === '' ? 'All other wallets' : x.trader}: ${x.share.toFixed(1)}%, ${x.n} trades` })),
        [`${Math.round(traders[0]!.trader === '' ? 0 : traders[0]!.share)}%`, 'top wallet'],
        `The wallet that traded the most made ${Math.round(traders[0]!.share)} percent of the value`,
      ),
      legend(traders.map((x, i) => ({ cls: x.trader === '' ? 'wapp-txc__c-rest' : `wapp-txc__c${i % 5}`, text: `${x.trader === '' ? 'All others' : shortId(x.trader)} · ${x.share.toFixed(1)}%`, href: x.trader === '' ? null : traderLink(o.chain, x.trader) }))),
    );
    c4.append(row4);
  }

  grid.append(c1, c2, c3, c4);
  host.replaceChildren(grid);
}
