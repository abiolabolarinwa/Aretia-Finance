/**
 * The token page opened from a row in Find Tokens or Marketplace: Aretia's TradingView chart (light theme, with
 * its own timeframe and drawing toolbars) filling the width, and beside it the numbers that matter: price, liquidity,
 * value, the 5M to 24H changes, buys and sells, volume, the pool's age and the project's own links. No advertising.
 */
import { CHAINS, type ChainId } from '../swings/core/types.js';
import { DexScreenerPoolFinder } from '../swings/charts/dexscreener.js';
import { watchChainPrice } from '../swings/charts/chainWatch.js';
import { fetchPairDetail, WINDOWS, type PairDetail, type Win } from '../swings/charts/pairDetail.js';
import { poolDetailsGroup } from './walletMarketPanel.js';
import { embedUrl, GECKO_NETWORK } from '../swings/charts/pool.js';
import { mountTvChart, type TvChart } from './walletTvChart';
import { mountTrades, type TradesTable } from './walletTxTable';
import { compactCount, compactUsd, formatAge, formatChange, formatPrice } from '../swings/market/types.js';
import { cachedLogo } from '../swings/tokens/logos.js';
import { tokenShare } from './tokenPageCore';
import { shareButton } from './walletShareButton';
import { openInsight } from './walletInsights';

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
  /** Puts the live swap card, with this token chosen, into the given box (the top of the side panel); 'sell' puts the token on the paying side. */
  mountSwap?: (host: HTMLElement, side?: 'buy' | 'sell') => void;
  /** How much of this token the connected wallet holds, or null when that is not known (no wallet, another network). */
  holding?: () => { amount: number } | null;
  /** The token's place in the person's favourites. */
  favourite?: { on(): boolean; toggle(): void };
  /** Takes the swap card back out, when the page closes or another token opens. */
  unmountSwap?: () => void;
  onBack(): void;
  /** True on the Swap page itself, which has no list to go back to: the button is left out. */
  hideBack?: boolean;
}

const LABEL: Record<Win, string> = { m5: '5M', h1: '1H', h6: '6H', h24: '24H' };
/** The timeframe buttons under the chart on a phone: the chart's interval code and its name. */
const TIMEFRAMES: readonly [string, string][] = [['1', '1m'], ['15', '15m'], ['60', '1H'], ['240', '4H'], ['1D', '1D']];

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

function stat(label: string, value: string, tone?: 'is-up' | 'is-down', key?: string): HTMLElement {
  const d = el('div', tone ? `wapp-tp__stat ${tone}` : 'wapp-tp__stat');
  if (key) d.dataset.live = key;
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
  let tv: TvChart | null = null;
  let trades: TradesTable | null = null;
  let swapHost: HTMLElement | null = null;
  let tabsEl: HTMLElement | null = null;
  let unmountSwap: (() => void) | undefined;

  /** The swap card sits above the numbers, like a trading screen: chart on the left, trade on the right. */
  function mountSwapInto(o: TokenPageOptions, side: HTMLElement): void {
    unmountSwap?.();
    unmountSwap = o.unmountSwap;
    swapHost = null;
    if (!o.mountSwap || !o.onSwap) return;
    swapHost = el('div', 'wapp-tp__swap');
    side.prepend(swapHost);
    o.mountSwap(swapHost);
  }

  function skeleton(o: TokenPageOptions): { chart: HTMLElement; side: HTMLElement; title: HTMLElement } {
    tv?.dispose();
    tv = null;
    trades?.dispose();
    trades = null;
    root.replaceChildren();
    const bar = el('div', 'wapp-tp__top');
    const back = el('button', 'wapp__btn wapp__btn--ghost wapp-tp__back', 'Back to the list');
    back.type = 'button';
    back.addEventListener('click', () => o.onBack());
    const title = el('div', 'wapp-tp__title');
    const headline = el('div', 'wapp-tp__headline');
    headline.dataset.tpHeadline = '';
    // The numbers that matter (prices, liquidity, value, trades) sit in this row, beside the name and price.
    const stats = el('div', 'wapp-tp__stats');
    stats.dataset.tpStats = '';
    const actions = el('div', 'wapp-tp__acts');
    if (o.favourite) {
      const fav = o.favourite;
      const star = el('button', 'wapp__btn wapp__btn--ghost wapp-tp__fav');
      star.type = 'button';
      const paint = (): void => {
        const on = fav.on();
        star.textContent = on ? '★' : '☆';
        star.setAttribute('aria-pressed', String(on));
        star.setAttribute('aria-label', on ? `Remove ${o.symbol} from favourites` : `Add ${o.symbol} to favourites`);
      };
      star.addEventListener('click', () => {
        fav.toggle();
        paint();
      });
      paint();
      actions.append(star);
    }
    actions.append(shareButton(tokenShare(o.chain, o.address, o.symbol)));
    // The amount of this token the wallet holds and what it is worth (filled once the price is known).
    const position = el('div', 'wapp-tp__position');
    position.dataset.tpPosition = '';
    position.hidden = true;
    bar.append(...(o.hideBack ? [] : [back]), title, headline, position, stats, actions);
    const grid = el('div', 'wapp-tp__grid');
    const chart = el('div', 'wapp-tp__chart');
    const side = el('aside', 'wapp-tp__side');
    side.id = 'wapp-tp-side';
    grid.append(chart, side);
    root.append(bar, grid);
    title.append(picture(o.symbol, o.icon ?? cachedLogo(o.chain, o.address)), el('strong', 'wapp-tp__name', o.symbol), el('span', 'wapp-tp__net', `${o.name ? `${o.name} · ` : ''}${CHAINS[o.chain].name}`));
    chart.append(el('p', 'wapp__fine', 'Finding the main pool for this token…'));
    mountSwapInto(o, side);
    side.append(el('p', 'wapp__fine', 'Loading the numbers…'));
    // Phones: a buy button fixed at the bottom of the screen that takes you to the swap card under the chart (hidden on wider screens).
    if (swapHost || o.onSwap) {
      const dock = el('div', 'wapp-tp__dock');
      // Sell and Buy open the swap card in a sheet from the bottom of the screen (it is put back under the chart when the sheet closes).
      const trade = (side: 'buy' | 'sell'): void => {
        if (swapHost && o.mountSwap) {
          o.mountSwap(swapHost, side);
          openInsight({ label: `${side === 'buy' ? 'Buy' : 'Sell'} ${o.symbol}`, el: swapHost });
        } else o.onSwap?.();
      };
      const sell = el('button', 'wapp__btn wapp-tp__sell', 'Sell');
      sell.type = 'button';
      sell.addEventListener('click', () => trade('sell'));
      const buy = el('button', 'wapp__btn wapp__btn--primary wapp-tp__buy', 'Buy');
      buy.type = 'button';
      buy.addEventListener('click', () => trade('buy'));
      dock.append(sell, buy);
      root.append(dock);
    }
    // Phones: Chart, Trades and About as tabs under the header, one at a time (wider screens show everything; see wallet/index.astro).
    const tabs = el('div', 'wapp-tp__tabs');
    tabs.setAttribute('role', 'tablist');
    tabs.setAttribute('aria-label', `${o.symbol} views`);
    const tabList: [string, string][] = [['trades', 'Trades'], ['about', 'About']];
    const pick = (key: string): void => {
      root.dataset.tpTab = key;
      tabs.querySelectorAll<HTMLButtonElement>('button').forEach((b) => b.setAttribute('aria-selected', String(b.dataset.tab === key)));
    };
    for (const [key, label] of tabList) {
      const b = el('button', 'wapp-tp__tab', label);
      b.type = 'button';
      b.dataset.tab = key;
      b.setAttribute('role', 'tab');
      b.addEventListener('click', () => pick(key));
      tabs.append(b);
    }
    // Under the chart, after its timeframe buttons (fill puts them there once the chart is drawn).
    chart.after(tabs);
    tabsEl = tabs;
    pick('trades');
    return { chart, side, title };
  }

  function fill(o: TokenPageOptions, parts: { chart: HTMLElement; side: HTMLElement }, pool: string, d: PairDetail | null, problem: string | null): void {
    // Aretia's own TradingView chart, drawn in the page.
    tv?.dispose();
    trades?.dispose();
    const plot = el('div', 'wapp-tp__frame');
    plot.setAttribute('role', 'img');
    plot.setAttribute('aria-label', `${o.symbol} price chart`);
    const tradesHost = el('div', 'wapp-tp__trades');
    // Phones: timeframe buttons under the chart (the chart's own toolbars are left out there).
    const phone = window.matchMedia('(max-width: 720px)').matches;
    const frames = el('div', 'wapp-tp__tf');
    frames.setAttribute('role', 'group');
    frames.setAttribute('aria-label', 'Timeframe');
    for (const [code, label] of TIMEFRAMES) {
      const b = el('button', 'wapp-tp__tfbtn', label);
      b.type = 'button';
      b.dataset.tf = code;
      b.setAttribute('aria-pressed', String(code === '1'));
      b.addEventListener('click', () => {
        tv?.setInterval?.(code);
        frames.querySelectorAll('button').forEach((x) => x.setAttribute('aria-pressed', String(x === b)));
      });
      frames.append(b);
    }
    parts.chart.replaceChildren(plot, frames, ...(tabsEl ? [tabsEl] : []), tradesHost);
    tv = mountTvChart(plot, { chain: o.chain, pool, symbol: o.symbol, target: o.address, ...(d?.quoteSymbol ? { quoteSymbol: d.quoteSymbol } : {}), priceHint: d?.priceUsd ?? null, interval: '1', toolbar: !phone, minimal: phone, fallbackUrl: embedUrl({ network: GECKO_NETWORK[o.chain], pool }), title: `${o.symbol} price chart` });
    // The pool's recent trades, under the chart.
    trades = mountTrades(tradesHost, { chain: o.chain, pool, symbol: d?.baseSymbol ?? o.symbol, quoteSymbol: d?.quoteSymbol });

    const side = parts.side;
    side.replaceChildren(...(swapHost ? [swapHost] : []));
    const net = CHAINS[o.chain].name;
    const headline = root.querySelector<HTMLElement>('[data-tp-headline]');
    if (headline) {
      headline.replaceChildren();
      if (d) {
        const day = d.change.h24;
        const chg = el('span', `wapp-tp__chg ${day === null ? '' : day >= 0 ? 'is-up' : 'is-down'}`, formatChange(day));
        const priceEl = el('strong', 'wapp-tp__price', formatPrice(d.priceUsd));
        priceEl.dataset.live = 'price';
        chg.dataset.live = 'chg24';
        headline.append(priceEl, chg);
        // What the wallet holds of this token, and its worth at this price.
        const pos = root.querySelector<HTMLElement>('[data-tp-position]');
        const held = o.holding?.();
        if (pos && held && held.amount > 0) {
          const worth = d.priceUsd !== null ? held.amount * d.priceUsd : null;
          pos.replaceChildren(el('span', 'wapp-tp__poslabel', 'Your position'), el('strong', '', `${held.amount.toLocaleString('en-US', { maximumFractionDigits: 4 })} ${o.symbol}`), el('span', '', worth === null ? '' : formatPrice(worth)));
          pos.hidden = false;
        }
      }
    }
    const act = el('div', 'wapp-tp__actions');
    if (swapHost) {
      /* the swap card is already on the page */
    } else if (o.onSwap) {
      const swap = el('button', 'wapp__btn wapp__btn--primary', `Swap into ${o.symbol}`);
      swap.type = 'button';
      swap.addEventListener('click', () => o.onSwap?.());
      act.append(swap);
    } else act.append(el('p', 'wapp__fine', `Swaps on ${net} are switched off at the moment, so this token can be inspected but not traded here.`));
    if (act.childElementCount > 0) side.insertBefore(act, side.firstChild);
    side.append(el('h3', 'wapp-tp__pair', d ? `${d.baseSymbol} / ${d.quoteSymbol}` : o.symbol), el('p', 'wapp__fine', `${net}${d?.dex ? ` · ${d.dex}` : ''}`));
    if (problem || !d) {
      side.append(el('p', 'wapp__fine', problem ?? 'No numbers were found for this pool.'));
    } else {
      const changes = el('div', 'wapp-tp__quad');
      for (const w of WINDOWS) {
        const n = d.change[w];
        const c = stat(LABEL[w], formatChange(n), undefined, `c-${w}`);
        c.classList.add(n === null ? 'is-flat' : n > 0 ? 'is-up' : n < 0 ? 'is-down' : 'is-flat');
        changes.append(c);
      }
      const sum = (r: Record<Win, number | null>): number | null => (r.h24 === null ? null : r.h24);
      const buys = sum(d.buys);
      const sells = sum(d.sells);
      const txns = buys === null || sells === null ? null : buys + sells;
      const stats = root.querySelector<HTMLElement>('[data-tp-stats]');
      if (stats) {
        stats.replaceChildren(stat(`Price ${d.quoteSymbol}`, nativePrice(d), undefined, 'pq'), stat('Liquidity', compactUsd(d.liquidityUsd), undefined, 'liq'), stat('FDV', compactUsd(d.fdvUsd), undefined, 'fdv'), stat('Market cap', compactUsd(d.marketCapUsd), undefined, 'mcap'), stat('Txns 24H', compactCount(txns), undefined, 'txns'), stat('Buys', compactCount(buys), 'is-up', 'buys'), stat('Sells', compactCount(sells), 'is-down', 'sells'));
      }
      const vol = el('div', 'wapp-tp__duo');
      vol.append(stat('Volume 24H', compactUsd(d.volumeUsd.h24), undefined, 'vol24'), stat('Pool age', formatAge(d.ageMs)));
      side.append(changes, vol);
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
    // Pool details sit with the chart that was opened: when the pool opened, what is in it, and the addresses.
    side.append(poolDetailsGroup({ chain: o.chain, address: o.address, pool, ageMs: d?.ageMs ?? null }, d));
    if (o.riskNote) side.append(el('p', 'wapp-tp__risk', o.riskNote));
    side.append(el('p', 'wapp__fine', 'Anyone can create a token, and Aretia does not endorse the tokens listed. Liquidity can be withdrawn by whoever put it there.'));
  }

  /** Writes one number into the page ("price", "liq"...), returning its element when the text changed. */
  function putText(key: string, value: string): HTMLElement | null {
    const host = root.querySelector<HTMLElement>(`[data-live="${key}"]`);
    const v = host && host.classList.contains('wapp-tp__stat') ? host.querySelector<HTMLElement>('.wapp-tp__v') : host;
    if (!v || v.textContent === value) return null;
    v.textContent = value;
    return v;
  }
  /** Shows the price, flashing it green or red when it moved. */
  function showPrice(usd: number | null): void {
    const moved = putText('price', formatPrice(usd));
    if (moved) {
      const prev = Number(moved.dataset.was);
      moved.classList.remove('is-tick-up', 'is-tick-down');
      void moved.offsetWidth;
      if (Number.isFinite(prev) && usd !== null && prev !== usd) moved.classList.add(usd > prev ? 'is-tick-up' : 'is-tick-down');
    }
    const price = root.querySelector<HTMLElement>('[data-live="price"]');
    if (price && usd !== null) price.dataset.was = String(usd);
  }
  function showChange(day: number | null): void {
    putText('chg24', formatChange(day));
    const chgEl = root.querySelector<HTMLElement>('[data-live="chg24"]');
    if (chgEl) chgEl.className = `wapp-tp__chg ${day === null ? '' : day >= 0 ? 'is-up' : 'is-down'}`;
  }

  /** The last reading of the pool's numbers, which the chain's price is measured against (24-hour open, value per dollar of price). */
  let basis: { price: number; open24: number | null; fdv: number | null; mcap: number | null } | null = null;
  /** When the chain's price last reached the page: while it is arriving, the slower reading never overwrites the price, its change or the values that follow it. */
  let chainAt = 0;
  let stopChain: (() => void) | undefined;
  const chainFresh = (): boolean => Date.now() - chainAt < 3_000;

  /** The price read from the chain (about twice a second): the price itself, the 24-hour change against the day's opening price, and the values that follow the price. */
  function applyChain(p: number): void {
    if (!basis || !(p > 0)) return;
    chainAt = Date.now();
    showPrice(p);
    if (basis.open24 !== null) showChange((p / basis.open24 - 1) * 100);
    if (basis.fdv !== null) putText('fdv', compactUsd((basis.fdv / basis.price) * p));
    if (basis.mcap !== null) putText('mcap', compactUsd((basis.mcap / basis.price) * p));
  }

  /** Writes a fresh reading into the numbers already on the page, flashing the price when it moved. Nothing is rebuilt, so the chart and the swap card are not touched. */
  function applyLive(d: PairDetail): void {
    const text = putText;
    setBasis(d);
    const fresh = chainFresh();
    if (!fresh) showPrice(d.priceUsd);
    if (!fresh) {
      showChange(d.change.h24);
      text('fdv', compactUsd(d.fdvUsd));
      text('mcap', compactUsd(d.marketCapUsd));
    }
    text('pq', nativePrice(d));
    text('liq', compactUsd(d.liquidityUsd));
    const buys = d.buys.h24;
    const sells = d.sells.h24;
    text('txns', compactCount(buys === null || sells === null ? null : buys + sells));
    text('buys', compactCount(buys));
    text('sells', compactCount(sells));
    text('vol24', compactUsd(d.volumeUsd.h24));
    for (const w of WINDOWS) {
      const n = d.change[w];
      text(`c-${w}`, formatChange(n));
      const host = root.querySelector<HTMLElement>(`[data-live="c-${w}"]`);
      if (host) {
        host.classList.remove('is-up', 'is-down', 'is-flat');
        host.classList.add(n === null ? 'is-flat' : n > 0 ? 'is-up' : n < 0 ? 'is-down' : 'is-flat');
      }
    }
  }

  /** Remembers the numbers the chain's price is measured against. */
  function setBasis(d: PairDetail): void {
    const h = d.change.h24;
    basis = d.priceUsd !== null && d.priceUsd > 0 ? { price: d.priceUsd, open24: h !== null && h > -100 ? d.priceUsd / (1 + h / 100) : null, fdv: d.fdvUsd, mcap: d.marketCapUsd } : null;
  }

  /** Every few seconds, while the page is open and the tab is shown, the pool's numbers are read again (the chart's own last candle already follows the price every second). */
  let liveTimer: ReturnType<typeof setInterval> | undefined;
  function startLive(mine: number, pool: string, ctl: AbortController): void {
    clearInterval(liveTimer);
    let busy = false;
    liveTimer = setInterval(() => {
      if (mine !== seq || ctl.signal.aborted) return clearInterval(liveTimer);
      if (busy || document.hidden || root.hidden) return;
      busy = true;
      void fetchPairDetail(lastChain, pool, undefined, undefined, ctl.signal)
        .then((d) => {
          if (mine === seq) applyLive(d);
        })
        .catch(() => undefined)
        .finally(() => {
          busy = false;
        });
    }, 5_000);
  }
  let lastChain: ChainId = 'solana';

  async function open(o: TokenPageOptions): Promise<void> {
    const mine = ++seq;
    active?.abort();
    const ctl = new AbortController();
    active = ctl;
    stopChain?.();
    stopChain = undefined;
    basis = null;
    chainAt = 0;
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
      lastChain = o.chain;
      if (detail) {
        startLive(mine, info.pool, ctl);
        setBasis(detail);
        // The price, its change and the values that follow it come from the pool itself, read through the chain's public node (shared with the chart).
        stopChain = watchChainPrice({ chain: o.chain, pool: info.pool, target: o.address, visible: () => !root.hidden }, applyChain);
      }
    } catch (e) {
      if (mine !== seq) return;
      parts.chart.replaceChildren(el('p', 'wapp__fine', e instanceof Error ? e.message : 'No trading pool was found for this token yet. Brand-new tokens can take a few minutes to appear.'));
      parts.side.replaceChildren(...(swapHost ? [swapHost] : []), el('p', 'wapp__fine', 'No market numbers yet.'));
      if (o.onSwap && !swapHost) {
        const swap = el('button', 'wapp__btn wapp__btn--primary', `Swap into ${o.symbol}`);
        swap.type = 'button';
        swap.addEventListener('click', () => o.onSwap?.());
        parts.side.append(swap);
      }
    }
  }

  function close(): void {
    seq++;
    clearInterval(liveTimer);
    stopChain?.();
    stopChain = undefined;
    active?.abort();
    tv?.dispose();
    tv = null;
    trades?.dispose();
    trades = null;
    unmountSwap?.();
    unmountSwap = undefined;
    swapHost = null;
    root.replaceChildren();
    root.hidden = true;
  }

  root.hidden = true;
  return { element: root, open, close };
}
