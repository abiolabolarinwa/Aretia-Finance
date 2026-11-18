/**
 * The overview band at the top of the Markets list: the market mood (AMMI), rising / neutral / falling (ARF) and the busiest venues (ADV), then
 * three short lists (top gainers, newly listed, trending). The three cards draw what Aretia's market intelligence engine worked out
 * (src/swings/market/intel/, read through /api/swings-market?src=intel): each says how much data it stands on and when it was worked out, and
 * where there is not enough it says "Insufficient market data" instead of a number. The short lists come from the rows the list holds.
 * A click on a token in a short list opens the token.
 */
import { CHAINS } from '../swings/core/types.js';
import { newlyListed, topGainers, trendingNow } from '../swings/market/overview.js';
import type { IntelResult } from '../swings/market/intel/compute.js';
import type { Window } from '../swings/market/intel/common.js';
import { agoText } from '../swings/market/marketStats.js';
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

const MOOD_TIP = 'The Aretia Market Mood Index, 0 to 100: 30% price trend (liquidity-weighted 24-hour return), 25% breadth (rising tokens, neutral ones half), 20% volume against earlier days, 15% momentum (RSI of the hourly market index) and 10% liquidity (depth and stability). Parts that need stored history appear as it builds up; until then the index is provisional, worked out from the parts that exist.';
const COMPONENTS: [string, string][] = [['T', 'Trend'], ['B', 'Breadth'], ['V', 'Volume'], ['M', 'Momentum'], ['L', 'Liquidity']];
const LEVEL: Record<string, string> = { high: 'High', medium: 'Medium', low: 'Low', none: 'None' };

/** The line at the foot of a card: how much data it stands on and when it was worked out. */
function confidenceLine(conf: IntelResult['confidence']['ammi'], asOf: number, what: string): HTMLElement {
  const p = h('p', `wapp-ov__conf wapp-ov__conf--${conf.level}`);
  p.append(h('span', 'wapp-ov__dot'), document.createTextNode(`Data confidence: ${LEVEL[conf.level] ?? conf.level} · ${conf.eligible.toLocaleString('en-US')} ${what} · ${agoText(asOf, Date.now())}`));
  p.title = `${conf.eligible.toLocaleString('en-US')} of ${conf.considered.toLocaleString('en-US')} pools looked at counted (${Math.round(conf.coverage * 100)}%).${conf.limits.length ? ` Limits: ${conf.limits.join('; ')}.` : ''} This is a rule of thumb from coverage and from which parts had data, not a statistical probability.`;
  return p;
}

function insufficient(c: HTMLElement, why: string): HTMLElement {
  c.append(h('p', 'wapp-ov__none', 'Insufficient market data'), h('p', 'wapp-ov__fine', why));
  return c;
}

function moodCard(intel: IntelResult | null): HTMLElement {
  const c = card('Market mood', intel ? `of ${intel.ammi.eligible.toLocaleString('en-US')} tokens` : 'reading the index', MOOD_TIP);
  if (!intel) return insufficient(c, 'Waiting for the index.');
  const m = intel.ammi;
  if (m.score === null || m.status === 'insufficient') {
    const why = m.eligible < 20 ? `Needs at least 20 eligible tokens (${m.eligible} now).` : 'The price trend or breadth could not be worked out.';
    return insufficient(c, why);
  }
  c.append(moodGauge(m.score), h('div', 'wapp-ov__score', String(m.score)), h('div', 'wapp-ov__label', m.label ?? ''));
  if (m.status === 'provisional') {
    const badge = h('p', 'wapp-ov__prov', 'Provisional');
    badge.title = 'Some parts of the index need stored history that is still building up, so it is worked out from the parts that exist, with their weights scaled to add to 100%.';
    c.append(badge);
  }
  const parts = h('ul', 'wapp-ov__parts');
  for (const [k, name] of COMPONENTS) {
    const part = m.components[k as keyof typeof m.components];
    const li = h('li', part.used ? '' : 'is-off');
    li.append(h('span', '', name), h('strong', '', part.score === null ? '–' : String(Math.round(part.score))));
    li.title = `${name} (${Math.round(part.weight * 100)}%): ${part.note || (part.used ? 'used' : 'not available')}`;
    parts.append(li);
  }
  c.append(parts, confidenceLine(intel.confidence.ammi, intel.asOf, 'tokens'));
  return c;
}

const WINDOW_LABEL: Record<Window, string> = { m5: '5M', h1: '1H', h6: '6H', h24: '24H' };
const WINDOW_NAME: Record<Window, string> = { m5: '5 minutes', h1: 'an hour', h6: '6 hours', h24: '24 hours' };
/** The window the rising / falling card shows; kept while the page is open. */
let arfWindow: Window = 'h24';

function breadthCard(intel: IntelResult | null): HTMLElement {
  const w = arfWindow;
  const r = intel?.arf[w] ?? null;
  const c = card('Rising or falling', r ? `${r.eligible.toLocaleString('en-US')} eligible tokens · ${WINDOW_LABEL[w]}` : 'reading the index', `How many eligible tokens rose by more than 0.5%, fell by more than 0.5%, or stayed within 0.5% (neutral) over ${WINDOW_NAME[w]}. Every eligible token is in exactly one group. A token needs a valid price and a change over that very window, enough liquidity and to be older than the window; one token on several pools counts once.`);
  if (intel) {
    const chips = h('div', 'wapp-ov__chips');
    for (const k of ['m5', 'h1', 'h6', 'h24'] as Window[]) {
      const b = h('button', 'wapp-ov__chip', WINDOW_LABEL[k]);
      b.type = 'button';
      b.setAttribute('aria-pressed', String(k === w));
      b.addEventListener('click', () => {
        arfWindow = k;
        c.replaceWith(breadthCard(intel));
      });
      chips.append(b);
    }
    c.append(chips);
  }
  if (!intel || !r || r.eligible === 0 || r.risingPct === null) return insufficient(c, intel ? `No token has a valid change over ${WINDOW_NAME[w]} yet.` : 'Waiting for the index.');
  const pct = (n: number | null): string => (n === null ? '–' : `${n.toFixed(1)}%`);
  const row = h('div', 'wapp-ov__split3');
  for (const [cls, label, n, p] of [['is-up', 'Rising ▲', r.rising, r.risingPct], ['', 'Neutral', r.neutral, r.neutralPct], ['is-down', 'Falling ▼', r.falling, r.fallingPct]] as const) {
    const cell = h('div', 'wapp-ov__cell');
    cell.append(h('strong', cls, n.toLocaleString('en-US')), h('span', 'wapp-ov__fine', `${label} · ${pct(p)}`));
    row.append(cell);
  }
  const bar = h('div', 'wapp-ov__bar');
  for (const [cls, n] of [['wapp-ov__bar-up', r.rising], ['wapp-ov__bar-flat', r.neutral], ['wapp-ov__bar-down', r.falling]] as const) {
    const part = h('span', cls);
    part.style.width = `${(100 * n) / r.eligible}%`;
    bar.append(part);
  }
  const net = h('p', 'wapp-ov__fine');
  net.append(document.createTextNode('Net market breadth '), h('strong', (r.netBreadth ?? 0) > 0 ? 'is-up' : (r.netBreadth ?? 0) < 0 ? 'is-down' : '', r.netBreadth === null ? '–' : `${r.netBreadth > 0 ? '+' : ''}${r.netBreadth.toFixed(1)}`));
  net.title = '(rising − falling) ÷ eligible × 100: from −100 (everything fell) to +100 (everything rose).';
  const left = Object.values(r.excluded).reduce((a, n) => a + (n ?? 0), 0);
  const ex = h('p', 'wapp-ov__fine', `${left.toLocaleString('en-US')} pools left out`);
  ex.title = `Left out: ${Object.entries(r.excluded).map(([k, n]) => `${n} ${k.replace('-', ' ')}`).join(', ') || 'none'}.`;
  const conf = w === 'h24' ? intel.confidence.arf : { ...intel.confidence.arf, level: r.eligible >= 100 ? ('high' as const) : r.eligible >= 30 ? ('medium' as const) : ('low' as const), eligible: r.eligible, considered: r.considered };
  c.append(row, bar, net, ex, confidenceLine(conf, intel.asOf, 'tokens'));
  return c;
}

function venueCard(intel: IntelResult | null): HTMLElement {
  const c = card('Busiest venues', intel ? `of ${intel.adv.venueCount.toLocaleString('en-US')} venues · 24H` : 'reading the index', "The exchanges with the most traded value in the last 24 hours across the pools that pass the checks (each pool once; pools far over their liquidity or traded by a few accounts are left out), each one's share of the total, and its volume against the 24 hours before. Pool-level volume: a route through several pools counts in each.");
  if (!intel) return insufficient(c, 'Waiting for the index.');
  const a = intel.adv;
  if (a.venues.length === 0) return insufficient(c, 'No venue has eligible volume yet.');
  const list = h('ul', 'wapp-ov__venues');
  for (const v of a.venues) {
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
    fill.style.width = `${Math.max(3, Math.round(v.share))}%`;
    share.append(fill);
    const vol = h('span', 'wapp-ov__vvol', `${compactUsd(v.volume24hUsd)} · ${v.share.toFixed(1)}%`);
    vol.title = `${v.swaps24h.toLocaleString('en-US')}${v.swapsCapped ? '+' : ''} swaps in ${v.pools.toLocaleString('en-US')} pool${v.pools === 1 ? '' : 's'}`;
    const growth = changeSpan(v.growth);
    growth.title = v.growth === null ? 'No stored figure from 24 hours ago yet, so no growth.' : 'Volume against the 24 hours before.';
    li.append(mark, h('span', 'wapp-ov__vname', v.venue), share, vol, growth);
    list.append(li);
  }
  const total = h('p', 'wapp-ov__fine', `${compactUsd(a.totalVolume24hUsd)} eligible volume across ${a.eligiblePools.toLocaleString('en-US')} pools`);
  total.title = `The venues add up to this total (${a.venueCount} venues). Left out as wash trading or a broken price: ${compactUsd(a.excludedVolume24hUsd)}.`;
  c.append(list, total, confidenceLine(intel.confidence.adv, intel.asOf, 'pools'));
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
export function overviewBand(rows: readonly MarketRow[], o: { onOpen(r: MarketRow): void; /** What the market intelligence engine worked out, or null before it has answered. */ intel: IntelResult | null }): HTMLElement | null {
  if (rows.length < 3) return null;
  const band = h('div', 'wapp-ov');
  const cards = h('div', 'wapp-ov__cards');
  cards.append(moodCard(o.intel), breadthCard(o.intel), venueCard(o.intel));
  const lists = h('div', 'wapp-ov__lists');
  lists.append(
    listPanel('Top gainers', 'The biggest 24-hour risers among the tokens in this list that traded at least $1,000 in the day.', topGainers(rows), o.onOpen),
    listPanel('Newly listed', 'The youngest pools in this list that have traded.', newlyListed(rows), o.onOpen),
    listPanel('Trending', 'The most traded value in the last hour among the tokens in this list.', trendingNow(rows), o.onOpen),
  );
  band.append(cards, lists);
  return band;
}
