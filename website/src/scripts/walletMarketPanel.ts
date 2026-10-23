/**
 * The panel at the right of the Markets list: pick a row and its numbers appear beside the list without leaving it.
 * Liquidity, value, the 5M to 24H windows (changes, buys, sells, volume), the pool's age and amounts, and the addresses
 * to copy. Above all of it sits Aretia's own check of the token, so the rating is in front of the person before they
 * choose to trade. Only numbers the sources actually report are shown; a figure a source does not give is a dash.
 */
import { LINK_ICONS, linkKind } from './walletLinkIcons.js';
import { CHAINS, type ChainId, type TokenRisk } from '../swings/core/types.js';
import { fetchPairDetail, WINDOWS, type PairDetail, type Win } from '../swings/charts/pairDetail.js';
import { compactCount, compactUsd, formatChange, formatPrice, type MarketRow } from '../swings/market/types.js';
import { describeSafety } from '../swings/tokens/safety.js';
import { ratingView } from '../swings/market/rowRisk.js';
import { padlockShown } from '../swings/market/lock.js';
import { ratingGuide } from './walletRatingGuide.js';
import { checkHash } from '../swings/shield/classify.js';
import { WatchStore } from '../swings/shield/watch.js';
import { browserStorage } from '../swings/history.js';
import { sponsorBlock } from './walletSponsor.js';
import { CHECK_ICON, COPY_ICON, LOCK_ICON, lockTitle, OPEN_ICON } from './walletIcons.js';
import { cachedLogo } from '../swings/tokens/logos.js';
import { tokenTitle } from './walletTitle.js';

export interface MarketPanelOptions {
  /** Aretia's own on-chain check of a token. Null when it could not be made. */
  assess(row: MarketRow): Promise<TokenRisk | null>;
  isFavourite(row: MarketRow): boolean;
  toggleFavourite(row: MarketRow): void;
  openChart(row: MarketRow): void;
  /** Null when swaps on the token's network are switched off. */
  swapFor(row: MarketRow): (() => void) | null;
}

const LABEL: Record<Win, string> = { m5: '5M', h1: '1H', h6: '6H', h24: '24H' };
const ADDRESS_URL: Readonly<Record<ChainId, string>> = {
  solana: 'https://solscan.io/account/',
  ethereum: 'https://etherscan.io/address/',
  bnb: 'https://bscscan.com/address/',
  polygon: 'https://polygonscan.com/address/',
  arbitrum: 'https://arbiscan.io/address/',
  optimism: 'https://optimistic.etherscan.io/address/',
  avalanche: 'https://snowtrace.io/address/',
  base: 'https://basescan.org/address/',
  robinhood: 'https://robinhoodchain.blockscout.com/address/',
};
const DETAIL_TTL_MS = 60_000;

function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls = '', text?: string): HTMLElementTagNameMap[K] {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text !== undefined) n.textContent = text;
  return n;
}

const rowKey = (r: MarketRow): string => `${r.chain}:${r.chain === 'solana' ? r.address : r.address.toLowerCase()}`;
const short = (a: string): string => (a.length > 14 ? `${a.slice(0, 5)}…${a.slice(-4)}` : a);

/** "5d 8h ago", "3h 12m ago", "40m ago". */
function agoLong(ms: number | null): string {
  if (ms === null || !Number.isFinite(ms) || ms < 0) return '–';
  const m = Math.floor(ms / 60_000);
  if (m < 1) return 'just now';
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 48) return `${h}h ${m % 60}m ago`;
  const d = Math.floor(h / 24);
  if (d < 365) return `${d}d ${h % 24}h ago`;
  const y = Math.floor(d / 365);
  return `${y}y ${Math.floor((d % 365) / 30)}mo ago`;
}

function amount(n: number | null): string {
  if (n === null || !Number.isFinite(n)) return '–';
  return n >= 1000 ? n.toLocaleString('en-US', { maximumFractionDigits: 0 }) : n.toLocaleString('en-US', { maximumFractionDigits: 2 });
}

type Span = 3 | 4 | 6 | 12;

/** One cell of the numbers grid: a small label over its figure. */
function cell(label: string, value: string, span: Span, tone = ''): HTMLElement {
  const d = el('div', `wapp-mp__cell wapp-mp__span-${span}${tone ? ` ${tone}` : ''}`);
  d.append(el('span', 'wapp-mp__k', label), el('strong', 'wapp-mp__v', value));
  return d;
}

/** A full-width header row of the grid. */

/** A small heading that says what the group below it is. */
const heading = (text: string): HTMLElement => el('h4', 'wapp-mp__h', text);


function picture(r: MarketRow): HTMLElement {
  const letters = el('span', 'wapp-avatar wapp-mp__logo', (r.symbol || '?').slice(0, 2).toUpperCase());
  const url = r.icon ?? cachedLogo(r.chain, r.address);
  if (!url || !(/^https:\/\//.test(url) || url.startsWith('/'))) return letters;
  const img = el('img', 'wapp-avatar wapp-mp__logo');
  img.alt = '';
  img.width = 36;
  img.height = 36;
  img.referrerPolicy = 'no-referrer';
  img.src = url;
  img.addEventListener('error', () => img.replaceWith(letters), { once: true });
  return img;
}

export function createMarketPanel(o: MarketPanelOptions) {
  const root = el('aside', 'wapp-mp');
  root.setAttribute('aria-label', 'Selected token');
  // The page's smooth-scroll library takes every mouse-wheel turn for the page; this tells it to leave the wheel to the panel while the pointer is over it.
  root.setAttribute('data-lenis-prevent', '');
  const cache = new Map<string, { at: number; detail: PairDetail }>();
  let row: MarketRow | null = null;
  let win: Win = 'h24';
  let detail: PairDetail | null = null;
  let problem: string | null = null;
  /** For a token with no pool on the row: still being looked up, or looked up and none exists. */
  let poolState: 'looking' | 'none' | 'failed' | null = null;
  let check: { state: 'loading' | 'done'; risk: TokenRisk | null } = { state: 'loading', risk: null };
  let seq = 0;
  let ctl: AbortController | null = null;

  function copyButton(text: string, what: string): HTMLButtonElement {
    const b = el('button', 'wapp-mp__icon');
    b.type = 'button';
    b.innerHTML = COPY_ICON;
    b.title = `Copy the ${what}`;
    b.setAttribute('aria-label', `Copy the ${what}`);
    b.addEventListener('click', () => {
      const done = (): void => {
        b.innerHTML = CHECK_ICON;
        b.title = 'Copied';
        setTimeout(() => {
          b.innerHTML = COPY_ICON;
          b.title = `Copy the ${what}`;
        }, 1500);
      };
      if (navigator.clipboard?.writeText) void navigator.clipboard.writeText(text).then(done, () => undefined);
    });
    return b;
  }

  function addressRow(label: string, address: string, chain: ChainId): HTMLElement {
    const r = el('div', 'wapp-mp__line');
    r.append(el('span', 'wapp-mp__lk', label));
    const right = el('span', 'wapp-mp__lv');
    const what = label.toLowerCase();
    right.append(el('code', 'wapp-mp__addr', short(address)), copyButton(address, what));
    // A Uniswap V4 pool is named by a 32-byte id, which is not an address: a block explorer has no page for it.
    if (chain === 'solana' || address.length <= 42) {
      const a = el('a', 'wapp-mp__icon');
      a.innerHTML = OPEN_ICON;
      a.href = ADDRESS_URL[chain] + encodeURIComponent(address);
      a.target = '_blank';
      a.rel = 'noopener noreferrer';
      a.title = `View the ${what} on the block explorer`;
      a.setAttribute('aria-label', `View the ${what} on the block explorer`);
      right.append(a);
    }
    r.append(right);
    return r;
  }

  /** Aretia's check, first in the panel: its rating, then what an on-chain look at the token found. */
  function checkBlock(r: MarketRow): HTMLElement {
    const box = el('div', 'wapp-mp__check');
    const v0 = ratingView(r, check.state === 'loading' ? 'pending' : check.risk ? 'done' : 'failed');
    const head = el('div', 'wapp-mp__checkhead');
    head.append(el('span', 'wapp-mp__k', 'Aretia check'));
    const chip = el('span', `wapp__state wapp__state--${v0.band}${v0.soft ? ' wapp__state--soft' : ''}${v0.checking ? ' is-checking' : ''}`, v0.label);
    chip.title = v0.title;
    head.append(chip);
    box.append(head);
    if (check.state === 'loading') {
      box.append(el('p', 'wapp__fine', 'Checking this token on-chain…'), shieldRow(r, shieldLink(r)));
      return box;
    }
    if (!check.risk) {
      box.append(el('p', 'wapp__fine', r.risk && r.risk.basis !== 'market' ? 'The live on-chain check could not be made just now. The rating above is Aretia’s earlier one.' : 'Aretia could not read this token on-chain (it may not be a standard token, or the network did not answer). Until it can, treat it as unchecked and look into it yourself before buying.'));
      box.append(shieldRow(r, shieldLink(r)));
      return box;
    }
    const v = describeSafety(check.risk);
    box.append(el('p', `wapp-mp__headline wapp-mp__headline--${v.tone}`, v.headline));
    if (v.concerns.length > 0) {
      const list = el('ul', 'wapp-mp__concerns');
      for (const c of v.concerns) list.append(el('li', '', `${c.severe ? 'Serious: ' : ''}${c.text}`));
      box.append(list);
    }
    const more = el('details', 'wapp-mp__more');
    more.append(el('summary', '', `What was checked: ${v.passed} passed${v.concerns.length > 0 ? `, ${v.concerns.length} concern${v.concerns.length === 1 ? '' : 's'}` : ''}`));
    more.append(el('p', 'wapp-mp__note', `${v.unchecked.length > 0 ? `Not checked: ${v.unchecked.join(', ')}. ` : ''}A pass is not a guarantee of safety.`));
    box.append(more, ratingGuide(), shieldRow(r, shieldLink(r)));
    return box;
  }

  function shieldLink(r: MarketRow): HTMLElement {
    const full = el('a', 'wapp-mp__shieldlink', 'Full Shield report');
    full.href = checkHash(r.address);
    full.title = 'Open this token in Shield: the colour, every finding, what could not be checked, and a link to share';
    return full;
  }

  /**
   * "Watch" under the check: Shield re-checks the token while the wallet page is open and rings the bell only if its rating gets worse.
   * It is the same watchlist as Shield's own, so the token shows in Shield's Watching tab.
   */
  function shieldRow(r: MarketRow, report: HTMLElement): HTMLElement {
    const row = el('div', 'wapp-mp__shieldrow');
    const store = new WatchStore(browserStorage());
    const watch = el('button', 'wapp-mp__watch');
    watch.type = 'button';
    const paint = (): void => {
      const on = store.has(r.address);
      watch.textContent = on ? 'Watching ✓' : 'Watch for changes';
      watch.setAttribute('aria-pressed', String(on));
      watch.title = on ? 'Shield will tell you in the bell if this token gets worse. Press to stop.' : 'Shield re-checks this token while the wallet page is open and rings the bell if its rating gets worse.';
    };
    paint();
    watch.addEventListener('click', () => {
      if (store.has(r.address)) store.remove(r.address);
      else if (!store.add(r.address, r.symbol || null, null)) {
        watch.textContent = 'Watchlist is full (30)';
        return;
      }
      paint();
    });
    row.append(watch, report);
    return row;
  }

  /** The numbers as one grid table: size, price change by time window, and what traded in the window that is picked. */
  function dataGrid(r: MarketRow, d: PairDetail | null): HTMLElement {
    const g = el('div', 'wapp-mp__grid');
    const liq = cell('Liquidity', compactUsd(d?.liquidityUsd ?? r.liquidityUsd), 4);
    // A padlock beside the figure when the pool's liquidity is shown to be locked.
    if (padlockShown(r.lockedPct, r.risk)) {
      const timed = r.lockInfo?.kind === 'time-locked';
      const lock = el('span', `wapp-mp__lock${timed ? ' is-timed' : ''}`);
      lock.innerHTML = LOCK_ICON;
      lock.title = lockTitle(r.lockedPct, r.lockInfo);
      lock.setAttribute('role', 'img');
      lock.setAttribute('aria-label', timed ? `Liquidity locked, ${r.lockedPct.toFixed(1)} percent in a locker` : `Liquidity tokens burned, ${r.lockedPct.toFixed(1)} percent`);
      liq.querySelector('.wapp-mp__v')?.prepend(lock);
    }
    g.append(liq, cell('FDV', compactUsd(d?.fdvUsd ?? null), 4), cell('Market cap', compactUsd(d?.marketCapUsd ?? r.capUsd), 4));
    if (!r.pool) {
      g.append(el('div', 'wapp-mp__cell wapp-mp__span-12 wapp-mp__wait', poolState === 'none' ? 'This token has no trading pool yet, so there is no price, liquidity or chart to show. A token still on its launch curve looks like this. Check back once it has a pool.' : poolState === 'failed' ? 'The pool for this token could not be looked up just now. Try again in a minute.' : 'Looking for this token’s trading pool…'));
      return g;
    }
    if (problem || !d) {
      g.append(el('div', 'wapp-mp__cell wapp-mp__span-12 wapp-mp__wait', problem ?? 'Loading the numbers…'));
      return g;
    }

    for (const w of WINDOWS) {
      const n = d.change[w];
      const b = el('button', `wapp-mp__cell wapp-mp__span-3 wapp-mp__tab ${n === null ? '' : n > 0 ? 'is-up' : n < 0 ? 'is-down' : ''}`);
      b.type = 'button';
      b.setAttribute('aria-pressed', String(w === win));
      b.append(el('span', 'wapp-mp__k', LABEL[w]), el('strong', 'wapp-mp__v', formatChange(n)));
      b.addEventListener('click', () => {
        win = w;
        render();
      });
      g.append(b);
    }

    const buys = d.buys[win];
    const sells = d.sells[win];
    const txns = buys === null || sells === null ? null : buys + sells;
    g.append(cell('Trades', compactCount(txns), 4), cell('Buys', compactCount(buys), 4, 'is-up'), cell('Sells', compactCount(sells), 4, 'is-down'));
    if (buys !== null && sells !== null && buys + sells > 0) {
      const share = Math.round((buys / (buys + sells)) * 100);
      const meter = el('div', 'wapp-mp__meter');
      const bar = el('span', 'wapp-mp__meter-buy');
      bar.style.width = `${share}%`;
      meter.append(bar);
      meter.title = `${share}% of trades were buys and ${100 - share}% were sells`;
      const holder = el('div', 'wapp-mp__cell wapp-mp__span-12 wapp-mp__meterrow');
      holder.append(meter);
      g.append(holder);
    }
    g.append(cell('Volume', compactUsd(d.volumeUsd[win]), 6), cell('Traders (24H)', compactCount(row?.traders24h ?? null), 6));
    return g;
  }

  function render(): void {
    root.replaceChildren();
    if (!row) {
      root.append(el('p', 'wapp__fine', 'Choose a token in the list to see its numbers here.'));
      return;
    }
    const r = row;
    const d = detail;
    const net = CHAINS[r.chain].name;
    const head = el('div', 'wapp-mp__head');
    const names = el('div', 'wapp-mp__names');
    names.append(el('strong', 'wapp-mp__pair', d ? `${d.baseSymbol} / ${d.quoteSymbol}` : `${r.symbol}${r.quoteSymbol ? ` / ${r.quoteSymbol}` : ''}`), el('span', 'wapp-mp__sub', `${net}${d?.dex ? ` · ${d.dex}` : ''}`));
    head.append(picture(r), names, el('strong', 'wapp-mp__price', formatPrice(d?.priceUsd ?? r.priceUsd)));
    root.append(head, checkBlock(r));

    const row2 = el('div', 'wapp-mp__duo');
    const favLabel = (): string => (o.isFavourite(r) ? '★ Favourited' : '☆ Favourite');
    const fav = el('button', 'wapp__btn wapp__btn--primary', favLabel());
    fav.type = 'button';
    fav.addEventListener('click', () => {
      o.toggleFavourite(r);
      fav.textContent = favLabel();
    });
    const chart = el('button', 'wapp__btn wapp__btn--primary', 'Full chart');
    chart.type = 'button';
    chart.addEventListener('click', () => o.openChart(r));
    row2.append(fav, chart);
    root.append(row2, dataGrid(r, d));

    const act = el('div', 'wapp-mp__actions');
    const swap = o.swapFor(r);
    const buy = el('button', 'wapp__btn wapp__btn--primary', swap ? `Swap into ${r.symbol}` : 'Swapping not available yet');
    buy.type = 'button';
    buy.disabled = !swap;
    if (swap) buy.addEventListener('click', swap);
    act.append(buy);
    root.append(act);

    const info = el('div', 'wapp-mp__group');
    info.append(heading(r.pool ? 'Pool details' : 'Token details'));
    const line = (k: string, v: string): HTMLElement => {
      const l = el('div', 'wapp-mp__line');
      l.append(el('span', 'wapp-mp__lk', k), el('strong', 'wapp-mp__lv', v));
      return l;
    };
    if (r.pool) {
      info.append(line('Pool opened', agoLong(d?.ageMs ?? r.ageMs)));
      if (d && d.pooledBase !== null && d.pooledQuote !== null) info.append(line('In the pool', `${amount(d.pooledBase)} ${d.baseSymbol} · ${amount(d.pooledQuote)} ${d.quoteSymbol}`));
      info.append(addressRow((d?.pair ?? r.pool).length > 42 && r.chain !== 'solana' ? 'Pool ID' : 'Pool address', d?.pair ?? r.pool, r.chain));
    }
    info.append(addressRow('Token address', r.address, r.chain));
    root.append(info);
    if (d && d.links.length > 0) {
      const g = el('div', 'wapp-mp__group');
      g.append(heading('Links from the project'));
      const links = el('div', 'wapp-mp__links');
      for (const l of d.links) {
        const a = el('a', 'wapp-mp__icon wapp-mp__icon--link');
        a.innerHTML = LINK_ICONS[linkKind(l.url, l.label)];
        a.title = l.label;
        a.setAttribute('aria-label', l.label);
        a.href = l.url;
        a.target = '_blank';
        a.rel = 'noopener noreferrer nofollow';
        links.append(a);
      }
      g.append(links);
      root.append(g);
    }
    // Paid or not, the card is labelled, sits after everything that helps a decision, and never changes the rating above.
    root.append(sponsorBlock('token-panel', { chain: r.chain, seed: rowKey(r), compact: true }));
    root.append(el('p', 'wapp-mp__tiny', 'Anyone can create a token. Aretia does not endorse the tokens listed.'));
    applyTitle();
  }

  /** Shows a row. The same row again only refreshes what is drawn; a new one starts its numbers and its check. */
  function show(r: MarketRow, lookup: 'looking' | 'none' | 'failed' | null = null): void {
    const same = row !== null && rowKey(row) === rowKey(r) && row.pool === r.pool;
    row = r;
    poolState = r.pool ? null : lookup ?? 'looking';
    if (same) return render();
    ctl?.abort();
    ctl = new AbortController();
    const mine = ++seq;
    const cached = cache.get(r.pool);
    detail = cached && Date.now() - cached.at < DETAIL_TTL_MS ? cached.detail : null;
    problem = null;
    check = { state: 'loading', risk: null };
    render();
    if (!detail && r.pool) {
      void fetchPairDetail(r.chain, r.pool, undefined, undefined, ctl.signal).then(
        (d) => {
          if (mine !== seq) return;
          cache.set(r.pool, { at: Date.now(), detail: d });
          detail = d;
          render();
        },
        (e: unknown) => {
          if (mine !== seq) return;
          problem = e instanceof Error ? e.message : 'The numbers could not be loaded.';
          render();
        },
      );
    }
    void o.assess(r).then(
      (risk) => {
        if (mine !== seq) return;
        check = { state: 'done', risk };
        render();
      },
      () => {
        if (mine !== seq) return;
        check = { state: 'done', risk: null };
        render();
      },
    );
  }

  // The browser tab names the token that is open and its price, so it can be read from another tab. It goes back to the page's
  // own title when no token is showing (another page, or the panel hidden on a narrow screen).
  const baseTitle = document.title;
  function applyTitle(): void {
    if (!row || !root.isConnected || root.offsetParent === null) {
      document.title = baseTitle;
      return;
    }
    document.title = tokenTitle({ symbol: detail?.baseSymbol ?? row.symbol, name: detail?.name || row.name, quoteSymbol: detail?.quoteSymbol ?? row.quoteSymbol, chainName: CHAINS[row.chain].name, dex: detail?.dex ?? null, priceUsd: detail?.priceUsd ?? row.priceUsd }, 'Aretia Finance');
  }
  window.addEventListener('hashchange', () => setTimeout(applyTitle, 80));
  // The price in the title is read again every 20 seconds while the tab is in view; the panel itself is not redrawn by it.
  setInterval(() => {
    if (document.hidden || !row || !row.pool || root.offsetParent === null) return;
    const mine = seq;
    void fetchPairDetail(row.chain, row.pool).then((d) => {
      if (mine !== seq) return;
      cache.set(row!.pool, { at: Date.now(), detail: d });
      detail = d;
      applyTitle();
    }, () => undefined);
  }, 20_000);

  render();
  return {
    element: root,
    show,
    selectedKey: (): string | null => (row ? rowKey(row) : null),
  };
}
