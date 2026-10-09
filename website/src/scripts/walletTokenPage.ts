/**
 * The token page opened from a row in Find Tokens or Marketplace: the DexScreener chart (light theme, with its own
 * timeframe toolbar and trades table) filling the width, and beside it the numbers that matter: price, liquidity,
 * value, the 5M to 24H changes, buys and sells, volume, the pool's age and the project's own links. No advertising.
 */
import { CHAINS, type ChainId } from '../swings/core/types.js';
import { DexScreenerPoolFinder } from '../swings/charts/dexscreener.js';
import { fetchPairDetail, WINDOWS, type PairDetail, type Win } from '../swings/charts/pairDetail.js';
import { dexScreenerEmbedUrl } from '../swings/charts/pool.js';
import { compactCount, compactUsd, formatAge, formatChange, formatPrice } from '../swings/market/types.js';
import { cachedLogo } from '../swings/tokens/logos.js';

export interface TokenPageOptions {
  chain: ChainId;
  address: string;
  symbol: string;
  name: string;
  icon: string | null;
  /** Aretia's own note for this token, when it has one (Find Tokens). */
  riskNote?: string | null;
  /** Null when swaps on this network are switched off. */
  onSwap: (() => void) | null;
  onBack(): void;
}

const LABEL: Record<Win, string> = { m5: '5M', h1: '1H', h6: '6H', h24: '24H' };

function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls = '', text?: string): HTMLElementTagNameMap[K] {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text !== undefined) n.textContent = text;
  return n;
}

function picture(symbol: string, url: string | null): HTMLElement {
  const letters = el('span', 'wapp-avatar wapp-tp__logo', (symbol || '?').slice(0, 2).toUpperCase());
  if (!url || !(/^https:\/\//.test(url) || url.startsWith('/'))) return letters;
  const img = el('img', 'wapp-avatar wapp-tp__logo');
  img.alt = '';
  img.width = 40;
  img.height = 40;
  img.referrerPolicy = 'no-referrer';
  img.src = url;
  img.addEventListener('error', () => img.replaceWith(letters), { once: true });
  return img;
}

function stat(label: string, value: string): HTMLElement {
  const d = el('div', 'wapp-tp__stat');
  d.append(el('span', 'wapp-tp__k', label), el('strong', 'wapp-tp__v', value));
  return d;
}

function nativePrice(d: PairDetail): string {
  return d.priceNative === null ? '–' : `${formatPrice(d.priceNative).replace('$', '')} ${d.quoteSymbol}`;
}

export function createTokenPage(finder = new DexScreenerPoolFinder()) {
  const root = el('section', 'wapp-tp');
  let seq = 0;
  let active: AbortController | null = null;

  function skeleton(o: TokenPageOptions): { chart: HTMLElement; side: HTMLElement; title: HTMLElement } {
    root.replaceChildren();
    const bar = el('div', 'wapp-tp__top');
    const back = el('button', 'wapp__btn wapp__btn--ghost wapp-tp__back', '← Back to the list');
    back.type = 'button';
    back.addEventListener('click', () => o.onBack());
    const title = el('div', 'wapp-tp__title');
    bar.append(back, title);
    const grid = el('div', 'wapp-tp__grid');
    const chart = el('div', 'wapp-tp__chart');
    const side = el('aside', 'wapp-tp__side');
    grid.append(chart, side);
    root.append(bar, grid);
    title.append(picture(o.symbol, o.icon ?? cachedLogo(o.chain, o.address)), el('strong', 'wapp-tp__name', o.symbol), el('span', 'wapp-tp__net', `${o.name ? `${o.name} · ` : ''}${CHAINS[o.chain].name}`));
    chart.append(el('p', 'wapp__fine', 'Finding the main pool for this token…'));
    side.append(el('p', 'wapp__fine', 'Loading the numbers…'));
    return { chart, side, title };
  }

  function fill(o: TokenPageOptions, parts: { chart: HTMLElement; side: HTMLElement }, pool: string, d: PairDetail | null, problem: string | null): void {
    const frame = el('iframe', 'wapp-tp__frame');
    frame.title = `${o.symbol} price chart`;
    frame.src = dexScreenerEmbedUrl(o.chain, pool, '15', { toolbar: true });
    frame.referrerPolicy = 'no-referrer';
    frame.loading = 'lazy';
    frame.setAttribute('sandbox', 'allow-scripts allow-same-origin allow-popups');
    parts.chart.replaceChildren(frame, el('p', 'wapp__fine', 'Past prices say nothing certain about future ones.'));

    const side = parts.side;
    side.replaceChildren();
    const net = CHAINS[o.chain].name;
    side.append(el('h3', 'wapp-tp__pair', d ? `${d.baseSymbol} / ${d.quoteSymbol}` : o.symbol), el('p', 'wapp__fine', `${net}${d?.dex ? ` · ${d.dex}` : ''}`));
    if (problem || !d) {
      side.append(el('p', 'wapp__fine', problem ?? 'No numbers were found for this pool.'));
    } else {
      const prices = el('div', 'wapp-tp__duo');
      prices.append(stat('Price USD', formatPrice(d.priceUsd)), stat(`Price ${d.quoteSymbol}`, nativePrice(d)));
      const money = el('div', 'wapp-tp__trio');
      money.append(stat('Liquidity', compactUsd(d.liquidityUsd)), stat('FDV', compactUsd(d.fdvUsd)), stat('Market cap', compactUsd(d.marketCapUsd)));
      const changes = el('div', 'wapp-tp__quad');
      for (const w of WINDOWS) {
        const n = d.change[w];
        const c = stat(LABEL[w], formatChange(n));
        c.classList.add(n === null ? 'is-flat' : n > 0 ? 'is-up' : n < 0 ? 'is-down' : 'is-flat');
        changes.append(c);
      }
      const sum = (r: Record<Win, number | null>): number | null => (r.h24 === null ? null : r.h24);
      const buys = sum(d.buys);
      const sells = sum(d.sells);
      const txns = buys === null || sells === null ? null : buys + sells;
      const flow = el('div', 'wapp-tp__trio');
      flow.append(stat('Txns 24H', compactCount(txns)), stat('Buys', compactCount(buys)), stat('Sells', compactCount(sells)));
      if (buys !== null && sells !== null && buys + sells > 0) {
        const meter = el('div', 'wapp-tp__meter');
        const bar = el('span', 'wapp-tp__meter-buy');
        bar.style.width = `${Math.round((buys / (buys + sells)) * 100)}%`;
        meter.append(bar);
        meter.title = 'Share of the 24-hour trades that were buys (green) and sells (red)';
        flow.append(meter);
      }
      const vol = el('div', 'wapp-tp__duo');
      vol.append(stat('Volume 24H', compactUsd(d.volumeUsd.h24)), stat('Pool age', formatAge(d.ageMs)));
      side.append(prices, money, changes, flow, vol);
      if (d.links.length > 0) {
        const links = el('div', 'wapp-tp__links');
        for (const l of d.links) {
          const a = el('a', 'wapp__chip', l.label);
          a.href = l.url;
          a.target = '_blank';
          a.rel = 'noopener noreferrer nofollow';
          links.append(a);
        }
        side.append(links);
      }
    }
    if (o.riskNote) side.append(el('p', 'wapp-tp__risk', o.riskNote));
    const act = el('div', 'wapp-tp__actions');
    if (o.onSwap) {
      const swap = el('button', 'wapp__btn wapp__btn--primary', `Swap into ${o.symbol}`);
      swap.type = 'button';
      swap.addEventListener('click', () => o.onSwap?.());
      act.append(swap);
    } else act.append(el('p', 'wapp__fine', `Swaps on ${net} are switched off at the moment, so this token can be inspected but not traded here.`));
    side.append(act, el('p', 'wapp__fine', 'Anyone can create a token, and Aretia does not endorse the tokens listed. Liquidity can be withdrawn by whoever put it there.'));
  }

  async function open(o: TokenPageOptions): Promise<void> {
    const mine = ++seq;
    active?.abort();
    const ctl = new AbortController();
    active = ctl;
    const parts = skeleton(o);
    root.hidden = false;
    try {
      const info = await finder.find(o.chain, o.address, ctl.signal);
      if (mine !== seq) return;
      let detail: PairDetail | null = null;
      let problem: string | null = null;
      try {
        detail = await fetchPairDetail(o.chain, info.pool, undefined, undefined, ctl.signal);
      } catch (e) {
        problem = e instanceof Error ? e.message : 'The numbers could not be loaded.';
      }
      if (mine !== seq) return;
      fill(o, parts, info.pool, detail, problem);
    } catch (e) {
      if (mine !== seq) return;
      parts.chart.replaceChildren(el('p', 'wapp__fine', e instanceof Error ? e.message : 'No trading pool was found for this token yet. Brand-new tokens can take a few minutes to appear.'));
      parts.side.replaceChildren(el('p', 'wapp__fine', 'No market numbers yet.'));
      if (o.onSwap) {
        const swap = el('button', 'wapp__btn wapp__btn--primary', `Swap into ${o.symbol}`);
        swap.type = 'button';
        swap.addEventListener('click', () => o.onSwap?.());
        parts.side.append(swap);
      }
    }
  }

  function close(): void {
    seq++;
    active?.abort();
    root.replaceChildren();
    root.hidden = true;
  }

  root.hidden = true;
  return { element: root, open, close };
}
