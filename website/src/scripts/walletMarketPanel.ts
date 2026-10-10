/**
 * The panel at the right of the Markets list: pick a row and its numbers appear beside the list without leaving it.
 * Liquidity, value, the 5M to 24H windows (changes, buys, sells, volume), the pool's age and amounts, and the addresses
 * to copy. Above all of it sits Aretia's own check of the token, so the rating is in front of the person before they
 * choose to trade. Only numbers the sources actually report are shown; a figure a source does not give is a dash.
 */
import { CHAINS, type ChainId, type TokenRisk } from '../swings/core/types.js';
import { fetchPairDetail, WINDOWS, type PairDetail, type Win } from '../swings/charts/pairDetail.js';
import { compactCount, compactUsd, formatChange, formatPrice, type MarketRow } from '../swings/market/types.js';
import { describeSafety } from '../swings/tokens/safety.js';
import { ratingView } from '../swings/market/rowRisk.js';
import { cachedLogo } from '../swings/tokens/logos.js';

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

function stat(label: string, value: string, tone = ''): HTMLElement {
  const d = el('div', `wapp-mp__stat${tone ? ` ${tone}` : ''}`);
  d.append(el('span', 'wapp-mp__k', label), el('strong', 'wapp-mp__v', value));
  return d;
}

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
  const cache = new Map<string, { at: number; detail: PairDetail }>();
  let row: MarketRow | null = null;
  let win: Win = 'h24';
  let detail: PairDetail | null = null;
  let problem: string | null = null;
  let check: { state: 'loading' | 'done'; risk: TokenRisk | null } = { state: 'loading', risk: null };
  let seq = 0;
  let ctl: AbortController | null = null;

  function copyButton(text: string, what: string): HTMLButtonElement {
    const b = el('button', 'wapp-mp__copy', 'Copy');
    b.type = 'button';
    b.setAttribute('aria-label', `Copy the ${what} address`);
    b.addEventListener('click', () => {
      const done = (): void => {
        b.textContent = 'Copied';
        setTimeout(() => (b.textContent = 'Copy'), 1500);
      };
      if (navigator.clipboard?.writeText) void navigator.clipboard.writeText(text).then(done, () => undefined);
    });
    return b;
  }

  function addressRow(label: string, address: string, chain: ChainId): HTMLElement {
    const r = el('div', 'wapp-mp__line');
    r.append(el('span', 'wapp-mp__lk', label));
    const right = el('span', 'wapp-mp__lv');
    right.append(el('code', 'wapp-mp__addr', short(address)), copyButton(address, label.toLowerCase()));
    const a = el('a', 'wapp-mp__exp', 'View');
    a.href = ADDRESS_URL[chain] + encodeURIComponent(address);
    a.target = '_blank';
    a.rel = 'noopener noreferrer';
    right.append(a);
    r.append(right);
    return r;
  }

  /** Aretia's check, first in the panel: its rating, then what an on-chain look at the token found. */
  function checkBlock(r: MarketRow): HTMLElement {
    const box = el('div', 'wapp-mp__check');
    box.append(el('span', 'wapp-mp__k', 'Aretia check'));
    const v0 = ratingView(r, check.state === 'loading' ? 'pending' : check.risk ? 'done' : 'failed');
    const head = el('div', 'wapp-mp__checkhead');
    const chip = el('span', `wapp__state wapp__state--${v0.tone}${v0.soft ? ' wapp__state--soft' : ''}${v0.checking ? ' is-checking' : ''}`, v0.label);
    chip.title = v0.title;
    head.append(chip);
    box.append(head);
    if (check.state === 'loading') {
      box.append(el('p', 'wapp__fine', 'Checking this token on-chain…'));
      return box;
    }
    if (!check.risk) {
      box.append(el('p', 'wapp__fine', r.risk && r.risk.basis !== 'market' ? 'The live on-chain check could not be made just now. The rating above is Aretia’s earlier one.' : 'Aretia could not read this token on-chain (it may not be a standard token, or the network did not answer). Until it can, treat it as unchecked and look into it yourself before buying.'));
      return box;
    }
    const v = describeSafety(check.risk);
    box.append(el('p', `wapp-mp__headline wapp-mp__headline--${v.tone}`, v.headline));
    if (v.concerns.length > 0) {
      const list = el('ul', 'wapp-mp__concerns');
      for (const c of v.concerns.slice(0, 4)) list.append(el('li', '', `${c.severe ? 'Serious: ' : ''}${c.text}`));
      if (v.concerns.length > 4) list.append(el('li', '', `…and ${v.concerns.length - 4} more in the swap screen.`));
      box.append(list);
    }
    box.append(el('p', 'wapp__fine', `${v.passed} check${v.passed === 1 ? '' : 's'} passed.${v.unchecked.length > 0 ? ` Not checked: ${v.unchecked.join(', ')}.` : ''} Passing is not a guarantee of safety.`));
    return box;
  }

  function windowStats(d: PairDetail): HTMLElement {
    const wrap = el('div', 'wapp-mp__win');
    const tabs = el('div', 'wapp-mp__tabs');
    tabs.setAttribute('role', 'group');
    tabs.setAttribute('aria-label', 'Time window');
    for (const w of WINDOWS) {
      const n = d.change[w];
      const b = el('button', `wapp-mp__tab ${n === null ? '' : n > 0 ? 'is-up' : n < 0 ? 'is-down' : ''}`);
      b.type = 'button';
      b.setAttribute('aria-pressed', String(w === win));
      b.append(el('span', 'wapp-mp__tabk', LABEL[w]), el('strong', '', formatChange(n)));
      b.addEventListener('click', () => {
        win = w;
        render();
      });
      tabs.append(b);
    }
    const buys = d.buys[win];
    const sells = d.sells[win];
    const txns = buys === null || sells === null ? null : buys + sells;
    const grid = el('div', 'wapp-mp__flow');
    grid.append(stat('Txns', compactCount(txns)), stat('Buys', compactCount(buys), 'is-up'), stat('Sells', compactCount(sells), 'is-down'));
    const meter = el('div', 'wapp-mp__meter');
    if (buys !== null && sells !== null && buys + sells > 0) {
      const bar = el('span', 'wapp-mp__meter-buy');
      bar.style.width = `${Math.round((buys / (buys + sells)) * 100)}%`;
      meter.append(bar);
      meter.title = 'Share of the trades in this window that were buys (green) and sells (red)';
    } else meter.hidden = true;
    const money = el('div', 'wapp-mp__duo');
    money.append(stat(`Volume ${LABEL[win]}`, compactUsd(d.volumeUsd[win])), stat('Traders 24H', compactCount(row?.traders24h ?? null)));
    wrap.append(tabs, grid, meter, money);
    return wrap;
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
    names.append(el('strong', 'wapp-mp__pair', d ? `${d.baseSymbol} / ${d.quoteSymbol}` : `${r.symbol}${r.quoteSymbol ? ` / ${r.quoteSymbol}` : ''}`), el('span', 'wapp__fine', `${net}${d?.dex ? ` · ${d.dex}` : ''}`));
    head.append(picture(r), names, el('strong', 'wapp-mp__price', formatPrice(d?.priceUsd ?? r.priceUsd)));
    root.append(head, checkBlock(r));

    const liq = el('div', 'wapp-mp__trio');
    const liqStat = stat('Liquidity', compactUsd(d?.liquidityUsd ?? r.liquidityUsd));
    if (r.lockedPct !== null && r.lockedPct !== undefined) liqStat.title = `Locked: ${r.lockedPct.toFixed(1)}% of this pool's liquidity tokens are burned.`;
    liq.append(liqStat, stat('FDV', compactUsd(d?.fdvUsd ?? null)), stat('Mkt cap', compactUsd(d?.marketCapUsd ?? r.capUsd)));
    root.append(liq);

    if (problem) root.append(el('p', 'wapp__fine', problem));
    else if (!d) root.append(el('p', 'wapp__fine', 'Loading the numbers…'));
    else root.append(windowStats(d));

    const act = el('div', 'wapp-mp__actions');
    const swap = o.swapFor(r);
    const buy = el('button', 'wapp__btn wapp__btn--primary', swap ? `Swap into ${r.symbol}` : 'Swaps are off on this network');
    buy.type = 'button';
    buy.disabled = !swap;
    if (swap) buy.addEventListener('click', swap);
    const row2 = el('div', 'wapp-mp__duo');
    const fav = el('button', 'wapp__btn wapp__btn--ghost', o.isFavourite(r) ? '★ Watching' : '☆ Watchlist');
    fav.type = 'button';
    fav.addEventListener('click', () => {
      o.toggleFavourite(r);
      fav.textContent = o.isFavourite(r) ? '★ Watching' : '☆ Watchlist';
    });
    const chart = el('button', 'wapp__btn wapp__btn--ghost', 'Full chart');
    chart.type = 'button';
    chart.addEventListener('click', () => o.openChart(r));
    row2.append(fav, chart);
    act.append(buy, row2);
    root.append(act);

    const info = el('div', 'wapp-mp__info');
    const line = (k: string, v: string): HTMLElement => {
      const l = el('div', 'wapp-mp__line');
      l.append(el('span', 'wapp-mp__lk', k), el('strong', 'wapp-mp__lv', v));
      return l;
    };
    info.append(line('Pair created', agoLong(d?.ageMs ?? r.ageMs)));
    if (d) {
      if (d.pooledBase !== null) info.append(line(`Pooled ${d.baseSymbol}`, amount(d.pooledBase)));
      if (d.pooledQuote !== null) info.append(line(`Pooled ${d.quoteSymbol}`, amount(d.pooledQuote)));
    }
    info.append(addressRow('Pair', d?.pair ?? r.pool, r.chain), addressRow('Token', r.address, r.chain));
    root.append(info);
    if (d && d.links.length > 0) {
      const links = el('div', 'wapp-mp__links');
      for (const l of d.links) {
        const a = el('a', 'wapp__chip', l.label);
        a.href = l.url;
        a.target = '_blank';
        a.rel = 'noopener noreferrer nofollow';
        links.append(a);
      }
      root.append(links);
    }
    root.append(el('p', 'wapp__fine', 'Anyone can create a token, and Aretia does not endorse the tokens listed. Liquidity can be withdrawn by whoever put it there.'));
  }

  /** Shows a row. The same row again only refreshes what is drawn; a new one starts its numbers and its check. */
  function show(r: MarketRow): void {
    const same = row !== null && rowKey(row) === rowKey(r);
    row = r;
    if (same) return render();
    ctl?.abort();
    ctl = new AbortController();
    const mine = ++seq;
    const cached = cache.get(r.pool);
    detail = cached && Date.now() - cached.at < DETAIL_TTL_MS ? cached.detail : null;
    problem = null;
    check = { state: 'loading', risk: null };
    render();
    if (!detail) {
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

  render();
  return {
    element: root,
    show,
    selectedKey: (): string | null => (row ? rowKey(row) : null),
  };
}
