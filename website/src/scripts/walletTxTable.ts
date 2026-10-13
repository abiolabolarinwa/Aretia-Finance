/**
 * The Transactions table under the chart: the pool's recent trades (last 24 hours, up to 300), newest first, with the
 * time, buy or sell, value, both amounts, price, the trader and a link to the transaction on the chain's explorer.
 * "All / Buys / Sells" narrows the list. It checks for new trades every second while it is on screen and the tab is in
 * front, and the times move on every second. (Most checks are served from the server's short cache, and the newest trades
 * run about half a minute behind the chain, because that is how far behind GeckoTerminal's own feed is.)
 *
 * Where the rows come from, and how they are cleaned, is in src/swings/charts/trades.ts. Everything drawn here is set as
 * text, never as markup, and every link is built from a hash or address that passed a strict pattern.
 */
import type { ChainId } from '../swings/core/types.js';
import { fetchTrades, formatAmount, formatTradeUsd, timeAgo, traderLink, txLink, type Trade, type TradeSide } from '../swings/charts/trades.js';
import { formatPrice } from '../swings/market/types.js';

const REFRESH_MS = 1_000;

export interface TradesOptions {
  chain: ChainId;
  pool: string;
  /** Which token of the pool is being looked at (the chart's token): the first ("base", the default) or the second. */
  token?: TradeSide;
  /** Names for the two amount columns: the token being looked at, and the other side of the pool. */
  symbol: string;
  quoteSymbol?: string;
}

export interface TradesTable {
  dispose(): void;
}

type Filter = 'all' | 'buy' | 'sell';

function node<K extends keyof HTMLElementTagNameMap>(tag: K, cls = '', text?: string): HTMLElementTagNameMap[K] {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text !== undefined) n.textContent = text;
  return n;
}

const shortId = (id: string): string => (id.length <= 11 ? id : `${id.slice(0, 4)}…${id.slice(-4)}`);

/** Draws the table into `host` and keeps it fresh until disposed. */
export function mountTrades(host: HTMLElement, o: TradesOptions, deps: { fetchImpl?: typeof fetch; now?: () => number } = {}): TradesTable {
  const now = deps.now ?? Date.now;
  const side = o.token ?? 'base';
  let rows: Trade[] | null = null;
  let problem: string | null = null;
  let filter: Filter = 'all';
  let disposed = false;
  let loading = false;
  /** Cancels a read still under way when the table is closed. */
  const active = new AbortController();

  const root = node('section', 'wapp-tx');
  root.setAttribute('aria-label', 'Transactions');
  const head = node('div', 'wapp-tx__head');
  head.append(node('h3', 'wapp-tx__title', 'Transactions'));
  const chips = node('div', 'wapp__seg wapp-tx__filters');
  chips.setAttribute('role', 'group');
  chips.setAttribute('aria-label', 'Show');
  const buttons = new Map<Filter, HTMLButtonElement>();
  for (const [value, label] of [['all', 'All'], ['buy', 'Buys'], ['sell', 'Sells']] as const) {
    const b = node('button', 'wapp__chip wapp__chip--btn', label);
    b.type = 'button';
    b.addEventListener('click', () => {
      filter = value;
      draw();
    });
    buttons.set(value, b);
    chips.append(b);
  }
  head.append(chips, node('span', 'wapp-tx__note wapp__fine', 'Last 24 hours, up to 300 trades'));
  const scroll = node('div', 'wapp-tx__scroll');
  root.append(head, scroll);
  host.replaceChildren(root);

  function message(text: string): void {
    const p = node('p', 'wapp__fine wapp-tx__empty', text);
    p.setAttribute('role', 'status');
    scroll.replaceChildren(p);
  }

  function link(href: string | null, label: string, title: string): HTMLElement {
    if (!href) return node('span', '', label);
    const a = node('a', 'wapp-tx__link', label);
    a.href = href;
    a.target = '_blank';
    a.rel = 'noopener noreferrer nofollow';
    a.title = title;
    return a;
  }

  function draw(): void {
    for (const [value, b] of buttons) b.setAttribute('aria-pressed', String(value === filter));
    if (rows === null) return message(problem ?? 'Loading trades…');
    const shown = filter === 'all' ? rows : rows.filter((r) => r.kind === filter);
    if (shown.length === 0) return message(rows.length === 0 ? 'No trades in the last 24 hours.' : `No ${filter === 'buy' ? 'buys' : 'sells'} in these trades.`);
    const table = node('table', 'wapp-tx__table');
    const thead = node('thead');
    const hr = node('tr');
    for (const [label, cls] of [['Date', ''], ['Type', ''], ['USD', 'num'], [o.symbol, 'num'], [o.quoteSymbol || 'Pair', 'num'], ['Price', 'num'], ['Trader', ''], ['Txn', '']] as const) {
      const th = node('th', cls, label);
      th.scope = 'col';
      hr.append(th);
    }
    thead.append(hr);
    const tbody = node('tbody');
    const t = now();
    for (const r of shown) {
      const tr = node('tr', r.kind === 'buy' ? 'is-buy' : 'is-sell');
      const date = node('td', 'wapp-tx__date', timeAgo(r.t, t));
      date.dataset.t = String(r.t);
      date.title = new Date(r.t).toLocaleString();
      const type = node('td', 'wapp-tx__type', `${r.kind === 'buy' ? '▲' : '▼'} ${r.kind === 'buy' ? 'Buy' : 'Sell'}`);
      const trader = node('td', 'wapp-tx__trader');
      trader.append(link(traderLink(o.chain, r.trader), shortId(r.trader), r.trader));
      const txn = node('td', 'wapp-tx__txn');
      const a = link(txLink(o.chain, r.tx), '↗', 'Open this transaction in the block explorer');
      a.setAttribute('aria-label', 'Open this transaction in the block explorer');
      txn.append(a);
      tr.append(date, type, node('td', 'num', formatTradeUsd(r.usd)), node('td', 'num', formatAmount(r.tokenAmount)), node('td', 'num', formatAmount(r.quoteAmount)), node('td', 'num', formatPrice(r.priceUsd)), trader, txn);
      tbody.append(tr);
    }
    table.append(thead, tbody);
    // Redrawing builds a new table, so keep the reader's place in the list.
    const top = scroll.scrollTop;
    scroll.replaceChildren(table);
    scroll.scrollTop = top;
  }

  /** "6s ago" moves on every second without rebuilding the table. */
  function updateTimes(): void {
    const t = now();
    for (const cell of scroll.querySelectorAll<HTMLElement>('td.wapp-tx__date')) cell.textContent = timeAgo(Number(cell.dataset.t), t);
  }

  async function load(): Promise<void> {
    if (loading) return;
    loading = true;
    try {
      const next = await fetchTrades(o.chain, o.pool, side, deps.fetchImpl, active.signal);
      if (disposed) return;
      // Most reads return what is already on screen (new trades arrive a few at a time), so only a changed list is redrawn.
      const same = rows !== null && rows.length === next.length && rows[0]?.tx === next[0]?.tx && rows[rows.length - 1]?.tx === next[next.length - 1]?.tx;
      rows = next;
      problem = null;
      if (same) updateTimes();
      else draw();
    } catch (e) {
      if (disposed) return;
      // Keep what is already on screen; only say so when there is nothing to show yet.
      if (rows === null) {
        problem = e instanceof Error ? e.message : 'The trades could not be loaded.';
        draw();
      } else updateTimes();
    } finally {
      loading = false;
    }
  }

  draw();
  void load();
  const timer = setInterval(() => {
    // Stop when the table is gone from the page or the tab is in the background.
    if (disposed || !root.isConnected || document.hidden) return;
    // A read still in flight is left to finish; meanwhile the times keep moving.
    if (loading) updateTimes();
    else void load();
  }, REFRESH_MS);

  return {
    dispose() {
      disposed = true;
      clearInterval(timer);
      active.abort();
      host.replaceChildren();
    },
  };
}
