/**
 * The overview band at the top of the Markets list: a "market mood" gauge, rising against falling, the busiest venues, and three short lists
 * (top gainers, newly listed, trending). Everything is worked out from the rows the list already holds (src/swings/market/overview.ts), so
 * it costs no request, and each card's hover text says what it was worked out from. A click on a token in a short list opens the token.
 */
import { CHAINS } from '../swings/core/types.js';
import { breadth, busiestVenues, marketMood, newlyListed, topGainers, trendingNow } from '../swings/market/overview.js';
import { compactUsd, formatChange, formatPrice, type MarketRow } from '../swings/market/types.js';
import { dexInitial, dexLogoSrc } from '../swings/market/dexLogo.js';
import { marketLogo } from './walletMarketTable.js';

const SVG = 'http://www.w3.org/2000/svg';

function h<K extends keyof HTMLElementTagNameMap>(tag: K, cls = '', text?: string): HTMLElementTagNameMap[K] {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text !== undefined) n.textContent = text;
  return n;
}
function s<K extends keyof SVGElementTagNameMap>(tag: K, attrs: Record<string, string>): SVGElementTagNameMap[K] {
  const n = document.createElementNS(SVG, tag);
  for (const [k, v] of Object.entries(attrs)) n.setAttribute(k, v);
  return n;
}

/** A half-circle gauge, red through amber to green, with a needle at `score` (0 to 100). */
export function moodGauge(score: number): SVGSVGElement {
  const svg = s('svg', { viewBox: '0 0 200 112', class: 'wapp-ov__gauge', role: 'img', 'aria-label': `Market mood ${score} out of 100` });
  const defs = s('defs', {});
  const grad = s('linearGradient', { id: 'wapp-ov-grad', x1: '0', x2: '1', y1: '0', y2: '0' });
  for (const [o, c] of [['0', '#e5484d'], ['0.5', '#f5a524'], ['1', '#2fb36a']] as const) grad.append(s('stop', { offset: o, 'stop-color': c }));
  defs.append(grad);
  svg.append(defs, s('path', { d: 'M 20 100 A 80 80 0 0 1 180 100', fill: 'none', stroke: 'url(#wapp-ov-grad)', 'stroke-width': '14', 'stroke-linecap': 'round' }));
  // The needle: the angle runs from 180 degrees (0) to 0 degrees (100).
  const a = Math.PI * (1 - Math.max(0, Math.min(100, score)) / 100);
  const x = 100 + 62 * Math.cos(a);
  const y = 100 - 62 * Math.sin(a);
  svg.append(s('line', { x1: '100', y1: '100', x2: x.toFixed(1), y2: y.toFixed(1), stroke: 'currentColor', 'stroke-width': '3', 'stroke-linecap': 'round' }), s('circle', { cx: '100', cy: '100', r: '6', fill: 'currentColor' }));
  return svg;
}

function card(title: string, hint: string, tip: string): HTMLElement {
  const c = h('section', 'wapp-ov__card');
  c.title = tip;
  c.append(h('h3', 'wapp-ov__title', title), h('p', 'wapp-ov__hint', hint));
  return c;
}

function changeSpan(n: number | null): HTMLElement {
  return h('span', `wapp-ov__chg ${n !== null && n > 0 ? 'is-up' : n !== null && n < 0 ? 'is-down' : ''}`, n === null ? '–' : formatChange(n));
}

function moodCard(rows: readonly MarketRow[]): HTMLElement {
  const mood = marketMood(rows);
  const c = card('Market mood', mood ? `from ${mood.basis} tokens` : 'not enough trading yet', 'The share of the last 24 hours of traded value that sat on tokens whose price rose, among the tokens in this list. 0 means everything traded fell, 100 means everything traded rose. It describes the pools Aretia follows, not the whole market.');
  if (!mood) {
    c.append(h('p', 'wapp-ov__none', 'Too few tokens with both a price change and a volume to say.'));
    return c;
  }
  c.append(moodGauge(mood.score), h('div', 'wapp-ov__score', String(mood.score)), h('div', 'wapp-ov__label', mood.label));
  return c;
}

function breadthCard(rows: readonly MarketRow[]): HTMLElement {
  const b = breadth(rows);
  const total = b.rising + b.falling + b.flat;
  const c = card('Rising or falling', `${total.toLocaleString('en-US')} tokens with a 24H change`, 'How many tokens in this list rose, fell or did not move over 24 hours, and the middle change among them.');
  const row = h('div', 'wapp-ov__split');
  row.append(h('strong', 'is-up', `${b.rising.toLocaleString('en-US')} ▲`), h('strong', 'is-down', `${b.falling.toLocaleString('en-US')} ▼`));
  const bar = h('div', 'wapp-ov__bar');
  if (total > 0) {
    const part = (cls: string, n: number): HTMLElement => {
      const p = h('span', cls);
      p.style.width = `${(100 * n) / total}%`;
      return p;
    };
    bar.append(part('wapp-ov__bar-up', b.rising), part('wapp-ov__bar-flat', b.flat), part('wapp-ov__bar-down', b.falling));
  }
  const med = h('p', 'wapp-ov__fine');
  med.append(document.createTextNode('Middle 24H change '), changeSpan(b.median));
  c.append(row, bar, med);
  return c;
}

function venueCard(rows: readonly MarketRow[]): HTMLElement {
  const venues = busiestVenues(rows, 4);
  const c = card('Busiest venues', 'by 24H traded value', 'The exchanges with the most traded value among the tokens in this list, their share of it, and the value-weighted 24-hour price change of their tokens (each token capped at ±500% so one outlier cannot set it).');
  if (venues.length === 0) {
    c.append(h('p', 'wapp-ov__none', 'No venue is named for these tokens.'));
    return c;
  }
  const list = h('ul', 'wapp-ov__venues');
  for (const v of venues) {
    const li = h('li', 'wapp-ov__venue');
    const src = dexLogoSrc(v.venue);
    let mark: HTMLElement;
    if (src) {
      const img = h('img', 'wapp-ov__dex');
      img.src = src;
      img.alt = '';
      img.width = 18;
      img.height = 18;
      mark = img;
    } else mark = h('span', 'wapp-ov__dex wapp-ov__dex--letter', dexInitial(v.venue));
    const share = h('span', 'wapp-ov__vshare');
    const fill = h('i');
    fill.style.width = `${Math.max(3, Math.round(v.share * 100))}%`;
    share.append(fill);
    li.append(mark, h('span', 'wapp-ov__vname', v.venue), share, h('span', 'wapp-ov__vvol', compactUsd(v.volumeUsd)), changeSpan(v.change));
    list.append(li);
  }
  c.append(list);
  return c;
}

function listPanel(title: string, tip: string, items: readonly MarketRow[], onOpen: (r: MarketRow) => void): HTMLElement {
  const c = h('section', 'wapp-ov__panel');
  c.title = tip;
  c.append(h('h3', 'wapp-ov__ptitle', title));
  if (items.length === 0) {
    c.append(h('p', 'wapp-ov__none', 'Nothing yet.'));
    return c;
  }
  const head = h('div', 'wapp-ov__phead');
  head.append(h('span', '', 'Token'), h('span', '', 'Price'), h('span', '', '24H'));
  c.append(head);
  for (const r of items) {
    const b = h('button', 'wapp-ov__prow');
    b.type = 'button';
    b.setAttribute('aria-label', `${r.symbol} on ${CHAINS[r.chain].name}: open`);
    const who = h('span', 'wapp-ov__who');
    const names = h('span', 'wapp-ov__names');
    const line = h('span', 'wapp-ov__line');
    line.append(h('strong', '', r.symbol), h('small', '', r.quoteSymbol ? `/ ${r.quoteSymbol}` : ''));
    names.append(line, h('small', 'wapp-ov__full', r.name || CHAINS[r.chain].name));
    who.append(marketLogo(r), names);
    b.append(who, h('span', 'wapp-ov__price', formatPrice(r.priceUsd)), changeSpan(r.change.h24));
    b.addEventListener('click', () => onOpen(r));
    c.append(b);
  }
  return c;
}

/** The band, or null when the list is too short to say anything. */
export function overviewBand(rows: readonly MarketRow[], o: { onOpen(r: MarketRow): void; /** The list was picked for its risers (Gainers, Rising), so a mood or a rising count worked out from it would say nothing: only the short lists are shown. */ biased?: boolean }): HTMLElement | null {
  if (rows.length < 3) return null;
  const band = h('div', 'wapp-ov');
  const cards = h('div', 'wapp-ov__cards');
  if (!o.biased) cards.append(moodCard(rows), breadthCard(rows), venueCard(rows));
  const lists = h('div', 'wapp-ov__lists');
  lists.append(
    listPanel('Top gainers', 'The biggest 24-hour risers among the tokens in this list that traded at least $1,000 in the day.', topGainers(rows), o.onOpen),
    listPanel('Newly listed', 'The youngest pools in this list that have traded.', newlyListed(rows), o.onOpen),
    listPanel('Trending', 'The most traded value in the last hour among the tokens in this list.', trendingNow(rows), o.onOpen),
  );
  if (cards.childElementCount > 0) band.append(cards);
  band.append(lists);
  return band;
}
