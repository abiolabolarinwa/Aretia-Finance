/**
 * The Markets board: four columns side by side, one per network, in the way pump.fun lays out its coin lists.
 * Solana, Ethereum, BNB Chain and a fourth for Base or Robinhood Chain. Each token is one compact card that carries the three
 * numbers that matter at a glance: market cap (large), the one-hour price change (a coloured pill) and the price. A card opens
 * the token. The columns hold the same tokens the table would show, in the same order, split by network.
 */
import type { ChainId } from '../swings/core/types.js';
import { compactUsd, formatChange, formatPrice, type MarketRow } from '../swings/market/types.js';
import { marketLogo, tableRowKey } from './walletMarketTable.js';
import { knownCap } from './walletMarketCap.js';

export type FourthChain = 'base' | 'robinhood';
export interface BoardColumn {
  /** The network this column shows. */
  chain: ChainId;
  title: string;
}

/** The three fixed columns, and the names of the two networks the fourth can show. */
export const FIXED_COLUMNS: readonly BoardColumn[] = [
  { chain: 'solana', title: 'Solana' },
  { chain: 'ethereum', title: 'Ethereum' },
  { chain: 'bnb', title: 'BNB Chain' },
];
export const FOURTH_TITLES: Readonly<Record<FourthChain, string>> = { base: 'Base', robinhood: 'Robinhood' };
export const FOURTH_CHOICES: readonly FourthChain[] = ['base', 'robinhood'];

/** Every network the board can show, in the order it asks the index for them. */
export const BOARD_CHAINS: readonly ChainId[] = ['solana', 'ethereum', 'bnb', 'base', 'robinhood'];
/** The index serves 100 tokens a page; the board reads two pages of each network, so a column starts with 100 or more. */
export const BOARD_PAGE_SIZE = 100;
/** A column holding fewer tokens than this from the tab itself is filled up with the network's most liquid ones (the tab's own may be filtered a little more afterwards). */
export const BOARD_FILL_TO = 150;
/** Cards drawn at first in a column, and added each time its scroll gets near the end: a column of 500 tokens is not 500 elements until it is read that far. */
export const CHUNK = 50;
/** How many cards each column has drawn so far, kept across redraws so a refresh does not cut a column short under the reader. */
const drawnCount = new Map<string, number>();
let drawnFor = '';

/** Tokens drawn per column at most: all of them in practice, the column's own scroll reaches every one (the header count is what is in the list). */
export const PER_COLUMN = 10_000;

export interface BoardOptions {
  rows: readonly MarketRow[];
  fourth: FourthChain;
  onFourth(c: FourthChain): void;
  onOpen(row: MarketRow): void;
  /** Names the list on screen (tab and window): a different one starts every column again at its first screen of cards. */
  listKey?: string;
  /** True for a token added to fill a column that the current tab alone leaves short; it is listed under a divider, after the tab's own tokens. */
  isFill?(row: MarketRow): boolean;
  /** The key of the token on screen elsewhere (the selected one), to mark. */
  selectedKey?: string | null;
  favourites?: { has(row: MarketRow): boolean; toggle(row: MarketRow): void };
}

function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls = '', text?: string): HTMLElementTagNameMap[K] {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text !== undefined) n.textContent = text;
  return n;
}

/** The rows of one network, in the order they came, with those that carry no price or market cap last so a card is never mostly dashes. */
export function columnRows(rows: readonly MarketRow[], chain: ChainId): MarketRow[] {
  const mine = rows.filter((r) => r.chain === chain);
  const full = (r: MarketRow): boolean => r.priceUsd !== null && r.capUsd !== null;
  return [...mine.filter(full), ...mine.filter((r) => !full(r))];
}

/** Which fourth network to open on: the chosen one, unless it has nothing and the other has something. */
export function pickFourth(rows: readonly MarketRow[], chosen: FourthChain): FourthChain {
  const other: FourthChain = chosen === 'base' ? 'robinhood' : 'base';
  return columnRows(rows, chosen).length === 0 && columnRows(rows, other).length > 0 ? other : chosen;
}

/** The key the live stream knows a row's pool by. */
export const poolKey = (r: Pick<MarketRow, 'chain' | 'pool'>): string => `${r.chain}:${r.chain === 'solana' ? r.pool : r.pool.toLowerCase()}`;

/** The windows tried, in order, for the pill: the hour first, then the shorter and the longer ones, whichever the source has. */
const WINDOWS = [['h1', '1H'], ['m5', '5M'], ['h6', '6H'], ['h24', '24H']] as const;
export type ChangeKey = (typeof WINDOWS)[number][0];

/** The price change the card shows: the one-hour change, or the 5-minute, 6-hour or 24-hour one when the hour is not available. Null value when none is. */
export function pillChange(c: MarketRow['change']): { key: ChangeKey; label: string; value: number | null } {
  for (const [key, label] of WINDOWS) {
    const v = c[key];
    if (v !== null && v !== undefined && Number.isFinite(v)) return { key, label, value: v };
  }
  return { key: 'h1', label: '1H', value: null };
}

/** The pill's words: an arrow and the figure, and the window's name when it is not the hour. */
export function pillText(p: { label: string; value: number | null }): string {
  const v = p.value;
  const body = v === null || v === 0 ? formatChange(v) : v > 0 ? `▲ ${formatChange(v)}` : `▼ ${formatChange(v).replace('-', '')}`;
  return v === null || p.label === '1H' ? body : `${p.label} ${body}`;
}

function changeTone(n: number | null): 'up' | 'down' | 'flat' {
  return n === null || !Number.isFinite(n) || n === 0 ? 'flat' : n > 0 ? 'up' : 'down';
}

function card(r: MarketRow, o: BoardOptions): HTMLElement {
  const pill = pillChange(r.change);
  const tone = changeTone(pill.value);
  // A card the index gave no market cap is filled from an earlier answer of the outside source when there is one, and is marked so the board asks for the rest.
  const earlier = knownCap(r);
  const capNow = r.capUsd ?? earlier?.capUsd ?? null;
  const c = el('div', `wapp-bd__card is-${tone}${capNow === null ? ' is-nocap' : ''}`);
  c.setAttribute('role', 'button');
  c.tabIndex = 0;
  c.dataset.k = tableRowKey(r);
  if (r.pool) c.dataset.pool = poolKey(r);
  c.setAttribute('aria-label', `${r.symbol}, price ${formatPrice(r.priceUsd)}, ${pill.label} ${formatChange(pill.value)}, market cap ${compactUsd(r.capUsd)}`);
  const open = (): void => o.onOpen(r);
  c.addEventListener('click', (e) => {
    if ((e.target as HTMLElement).closest('.wapp-bd__star')) return;
    open();
  });
  c.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      open();
    }
  });

  // Two short lines: symbol and name above the market cap on the left; the price (large) above the price change on the right.
  const mid = el('div', 'wapp-bd__mid');
  const top = el('div', 'wapp-bd__top');
  top.append(el('strong', 'wapp-bd__sym', r.symbol), el('span', 'wapp-bd__name', r.name));
  const subLine = el('span', 'wapp-bd__sub');
  const capEl = el('span', 'wapp-bd__cap', compactUsd(capNow));
  capEl.title = (r.capUsd !== null ? r.capIsFdv : earlier?.isFdv) ? 'Market cap (fully diluted: price times total supply)' : 'Market cap';
  subLine.append(el('span', 'wapp-bd__mc', 'MC '), capEl);
  mid.append(top, subLine);

  const right = el('div', 'wapp-bd__right');
  const big = el('span', 'wapp-bd__big', formatPrice(r.priceUsd));
  big.title = 'Price';
  const chg = el('span', `wapp-bd__chg is-${tone}`, pillText(pill));
  chg.title = `Price change over ${pill.label === '1H' ? 'the last hour' : pill.label === '5M' ? 'the last 5 minutes' : pill.label === '6H' ? 'the last 6 hours' : 'the last 24 hours'}`;
  right.append(big, chg);

  c.append(marketLogo(r), mid, right);
  if (o.favourites) {
    const fav = o.favourites;
    const star = el('button', 'wapp-bd__star', fav.has(r) ? '★' : '☆');
    star.type = 'button';
    star.setAttribute('aria-label', fav.has(r) ? `Remove ${r.symbol} from favourites` : `Add ${r.symbol} to favourites`);
    star.addEventListener('click', () => fav.toggle(r));
    c.append(star);
  }
  return c;
}

function column(title: string, chain: ChainId, rows: readonly MarketRow[], o: BoardOptions, switcher?: HTMLElement): HTMLElement {
  const col = el('section', 'wapp-bd__col');
  col.dataset.chain = chain;
  const head = el('header', 'wapp-bd__head');
  const logo = el('img', 'wapp-bd__chain');
  logo.src = `/assets/chains/${chain}.png`;
  logo.alt = '';
  logo.width = 22;
  logo.height = 22;
  head.append(logo, el('h3', 'wapp-bd__title', title), el('span', 'wapp-bd__count', String(rows.length)));
  head.append(el('span', 'wapp-bd__legend', 'PRICE · CHANGE'));
  if (switcher) head.append(switcher);
  col.append(head);
  const list = el('div', 'wapp-bd__list');
  // The page scrolls smoothly through a library that takes the mouse wheel for itself; this tells it to leave a column alone, so the wheel moves the column.
  list.setAttribute('data-lenis-prevent', '');
  if (rows.length === 0) list.append(el('p', 'wapp-bd__empty', `No ${title} tokens match right now.`));
  const fill = o.isFill;
  const own = fill ? rows.filter((r) => !fill(r)) : rows;
  const extra = fill ? rows.filter((r) => fill(r)) : [];
  const ordered = [...own.slice(0, PER_COLUMN), ...extra.slice(0, Math.max(0, PER_COLUMN - own.length))];
  const fillAt = fill ? ordered.findIndex((r) => fill(r)) : -1;
  const start = Math.min(ordered.length, Math.max(CHUNK, drawnCount.get(chain) ?? 0));
  const draw = (from: number, to: number): void => {
    for (let i = from; i < to; i++) {
      if (i === fillAt) list.append(el('p', 'wapp-bd__divider', `More on ${title}, by liquidity`));
      list.append(card(ordered[i]!, o));
    }
    drawnCount.set(chain, to);
  };
  draw(0, start);
  if (start < ordered.length && typeof IntersectionObserver !== 'undefined') {
    // The next cards are added when the end of what is drawn comes within a few screens of the top of the column's view.
    const sentinel = el('div', 'wapp-bd__sentinel');
    list.append(sentinel);
    let next = start;
    const io = new IntersectionObserver((entries) => {
      if (!entries.some((e) => e.isIntersecting)) return;
      const to = Math.min(ordered.length, next + CHUNK);
      sentinel.remove();
      draw(next, to);
      next = to;
      if (next < ordered.length) list.append(sentinel);
      else io.disconnect();
    }, { root: list, rootMargin: '600px 0px' });
    io.observe(sentinel);
  } else if (start < ordered.length) {
    draw(start, ordered.length);
  }
  col.append(list);
  return col;
}

export function marketBoard(o: BoardOptions): HTMLElement {
  const key = o.listKey ?? '';
  if (key !== drawnFor) {
    drawnFor = key;
    drawnCount.clear();
  }
  const board = el('div', 'wapp-bd');
  for (const c of FIXED_COLUMNS) board.append(column(c.title, c.chain, columnRows(o.rows, c.chain), o));
  const fourth = pickFourth(o.rows, o.fourth);
  const sw = el('div', 'wapp-bd__switch');
  sw.setAttribute('role', 'group');
  sw.setAttribute('aria-label', 'Fourth network');
  for (const c of FOURTH_CHOICES) {
    const b = el('button', '', FOURTH_TITLES[c]);
    b.type = 'button';
    b.setAttribute('aria-pressed', String(c === fourth));
    b.addEventListener('click', () => o.onFourth(c));
    sw.append(b);
  }
  board.append(column(FOURTH_TITLES[fourth], fourth, columnRows(o.rows, fourth), o, sw));
  return board;
}

const tickTimers = new WeakMap<Element, ReturnType<typeof setTimeout>>();
function flash(e: Element, dir: 'up' | 'down'): void {
  e.classList.remove('is-tick-up', 'is-tick-down');
  void (e as HTMLElement).offsetWidth;
  e.classList.add(`is-tick-${dir}`);
  clearTimeout(tickTimers.get(e));
  tickTimers.set(e, setTimeout(() => e.classList.remove('is-tick-up', 'is-tick-down'), 700));
}

/** Writes fresh numbers (from the live stream) into the cards already on screen, with a brief green or red flash on a price that moved. */
export function updateBoardCards(board: ParentNode, rows: readonly MarketRow[], before?: ReadonlyMap<string, MarketRow>): void {
  for (const r of rows) {
    const k = tableRowKey(r);
    const c = board.querySelector<HTMLElement>(`.wapp-bd__card[data-k="${CSS.escape(k)}"]`);
    if (!c) continue;
    const prev = before?.get(k);
    const price = c.querySelector('.wapp-bd__big');
    const next = formatPrice(r.priceUsd);
    if (price && price.textContent !== next) {
      price.textContent = next;
      if (prev && prev.priceUsd !== null && r.priceUsd !== null && r.priceUsd !== prev.priceUsd) flash(price, r.priceUsd > prev.priceUsd ? 'up' : 'down');
    }
    const cap = c.querySelector('.wapp-bd__cap');
    const capNow = r.capUsd ?? knownCap(r)?.capUsd ?? null;
    if (cap && cap.textContent !== compactUsd(capNow)) cap.textContent = compactUsd(capNow);
    if (capNow !== null) c.classList.remove('is-nocap');
    const chg = c.querySelector<HTMLElement>('.wapp-bd__chg');
    if (chg) {
      const pill = pillChange(r.change);
      const tone = changeTone(pill.value);
      const text = pillText(pill);
      if (chg.textContent !== text) chg.textContent = text;
      chg.className = `wapp-bd__chg is-${tone}`;
      c.classList.remove('is-up', 'is-down', 'is-flat');
      c.classList.add(`is-${tone}`);
    }
  }
}

/**
 * Names to `onKeys` the pools whose cards are on screen, as they scroll in and out of their column (the stream follows at most 100 pools, so only the
 * visible ones are named). Returns a function that stops watching.
 */
export function observeBoard(board: HTMLElement, onKeys: (keys: string[]) => void): () => void {
  if (typeof IntersectionObserver === 'undefined') {
    onKeys([...board.querySelectorAll<HTMLElement>('.wapp-bd__card[data-pool]')].slice(0, 100).map((c) => c.dataset.pool!));
    return () => undefined;
  }
  const visible = new Set<string>();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const push = (): void => {
    clearTimeout(timer);
    timer = setTimeout(() => onKeys([...visible].slice(0, 100)), 150);
  };
  const observers = [...board.querySelectorAll<HTMLElement>('.wapp-bd__list')].map((list) => {
    const io = new IntersectionObserver((entries) => {
      for (const e of entries) {
        const k = (e.target as HTMLElement).dataset.pool;
        if (!k) continue;
        if (e.isIntersecting) visible.add(k);
        else visible.delete(k);
      }
      push();
    }, { root: list });
    list.querySelectorAll('.wapp-bd__card[data-pool]').forEach((c) => io.observe(c));
    // Cards the column adds as it is scrolled are watched too.
    const mo = new MutationObserver((muts) => {
      for (const mu of muts) mu.addedNodes.forEach((n) => { if (n instanceof HTMLElement && n.matches('.wapp-bd__card[data-pool]')) io.observe(n); });
    });
    mo.observe(list, { childList: true });
    return { disconnect: () => { io.disconnect(); mo.disconnect(); } };
  });
  return () => {
    clearTimeout(timer);
    observers.forEach((o) => o.disconnect());
  };
}

/**
 * Names to `onKeys` the cards without a market cap that are on screen (their row keys), as columns scroll; the board asks the outside source for just
 * those. Returns a function that stops watching.
 */
export function observeMissingCaps(board: HTMLElement, onKeys: (keys: string[]) => void): () => void {
  const pick = (): string[] => [...board.querySelectorAll<HTMLElement>('.wapp-bd__card.is-nocap')].map((c) => c.dataset.k ?? '').filter(Boolean);
  if (typeof IntersectionObserver === 'undefined') {
    onKeys(pick().slice(0, 60));
    return () => undefined;
  }
  const visible = new Set<string>();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const push = (): void => {
    clearTimeout(timer);
    timer = setTimeout(() => onKeys([...visible].slice(0, 90)), 250);
  };
  const observers = [...board.querySelectorAll<HTMLElement>('.wapp-bd__list')].map((list) => {
    const io = new IntersectionObserver((entries) => {
      for (const e of entries) {
        const el2 = e.target as HTMLElement;
        const k = el2.dataset.k;
        if (!k) continue;
        if (e.isIntersecting && el2.classList.contains('is-nocap')) visible.add(k);
        else visible.delete(k);
      }
      push();
    }, { root: list, rootMargin: '200px 0px' });
    list.querySelectorAll('.wapp-bd__card.is-nocap').forEach((c) => io.observe(c));
    const mo = new MutationObserver((muts) => {
      for (const mu of muts) mu.addedNodes.forEach((n) => { if (n instanceof HTMLElement && n.matches('.wapp-bd__card.is-nocap')) io.observe(n); });
    });
    mo.observe(list, { childList: true });
    return { disconnect: () => { io.disconnect(); mo.disconnect(); } };
  });
  return () => {
    clearTimeout(timer);
    observers.forEach((o) => o.disconnect());
  };
}

/**
 * Tracks which cards are on screen: inside their column's view and with that column on the page's screen. `keys()` gives their row keys at the moment
 * it is called (the price poll asks for these once a second). `stop()` ends the watching.
 */
export function observeVisibleCards(board: HTMLElement): { keys(): string[]; stop(): void } {
  const inView = new Set<HTMLElement>();
  const observers = typeof IntersectionObserver === 'undefined' ? [] : [...board.querySelectorAll<HTMLElement>('.wapp-bd__list')].map((list) => {
    const io = new IntersectionObserver((entries) => {
      for (const e of entries) {
        const c = e.target as HTMLElement;
        if (e.isIntersecting) inView.add(c);
        else inView.delete(c);
      }
    }, { root: list });
    list.querySelectorAll('.wapp-bd__card').forEach((c) => io.observe(c));
    // Cards a column adds as it is scrolled are watched too.
    const mo = new MutationObserver((muts) => {
      for (const mu of muts) mu.addedNodes.forEach((n) => { if (n instanceof HTMLElement && n.matches('.wapp-bd__card')) io.observe(n); });
    });
    mo.observe(list, { childList: true });
    return { disconnect: () => { io.disconnect(); mo.disconnect(); } };
  });
  return {
    keys: () => {
      const out: string[] = [];
      const listOnScreen = new Map<Element, boolean>();
      for (const c of inView) {
        if (!c.isConnected) continue;
        const list = c.parentElement;
        if (!list) continue;
        let on = listOnScreen.get(list);
        if (on === undefined) {
          const r = list.getBoundingClientRect();
          on = r.bottom > 0 && r.top < window.innerHeight;
          listOnScreen.set(list, on);
        }
        if (on && c.dataset.k) out.push(c.dataset.k);
      }
      return out;
    },
    stop: () => observers.forEach((o) => o.disconnect()),
  };
}

/**
 * Takes cards out of the board in place (a token whose on-chain check just rated it risky, with risky tokens hidden) and lowers each column's count,
 * instead of drawing the whole board again for every rating that finishes. Returns how many cards were taken out.
 */
export function hideBoardCards(board: ParentNode, keys: readonly string[]): number {
  const removed = new Map<HTMLElement, number>();
  let total = 0;
  for (const k of keys) {
    const c = board.querySelector<HTMLElement>(`.wapp-bd__card[data-k="${CSS.escape(k)}"]`);
    if (!c) continue;
    const col = c.closest<HTMLElement>('.wapp-bd__col');
    c.remove();
    total++;
    if (col) removed.set(col, (removed.get(col) ?? 0) + 1);
  }
  for (const [col, n] of removed) {
    const count = col.querySelector('.wapp-bd__count');
    const now = Number(count?.textContent);
    if (count && Number.isFinite(now)) count.textContent = String(Math.max(0, now - n));
  }
  return total;
}
