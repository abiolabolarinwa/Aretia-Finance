/**
 * The Markets board: four columns side by side, one per network, in the way pump.fun lays out its coin lists.
 * Solana, Ethereum, BNB Chain and a fourth for Base or Robinhood Chain. Each token is one compact card that carries the three
 * numbers that matter at a glance: market cap (large), the one-hour price change (a coloured pill) and the price. A card opens
 * the token. The columns hold the same tokens the table would show, in the same order, split by network.
 */
import type { ChainId } from '../swings/core/types.js';
import { compactUsd, formatChange, formatPrice, type MarketRow } from '../swings/market/types.js';
import { marketLogo, tableRowKey } from './walletMarketTable.js';

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
/** Tokens drawn per column at most: all of them in practice, the column's own scroll reaches every one (the header count is what is in the list). */
export const PER_COLUMN = 10_000;

export interface BoardOptions {
  rows: readonly MarketRow[];
  fourth: FourthChain;
  onFourth(c: FourthChain): void;
  onOpen(row: MarketRow): void;
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

function changeTone(n: number | null): 'up' | 'down' | 'flat' {
  return n === null || !Number.isFinite(n) || n === 0 ? 'flat' : n > 0 ? 'up' : 'down';
}

function card(r: MarketRow, o: BoardOptions): HTMLElement {
  const h1 = r.change.h1;
  const tone = changeTone(h1);
  const c = el('div', `wapp-bd__card is-${tone}`);
  c.setAttribute('role', 'button');
  c.tabIndex = 0;
  c.dataset.k = tableRowKey(r);
  if (r.pool) c.dataset.pool = poolKey(r);
  c.setAttribute('aria-label', `${r.symbol}, market cap ${compactUsd(r.capUsd)}, one hour ${formatChange(h1)}, price ${formatPrice(r.priceUsd)}`);
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

  // Two short lines: symbol and name above the price on the left; market cap above the one-hour change on the right.
  const mid = el('div', 'wapp-bd__mid');
  const top = el('div', 'wapp-bd__top');
  top.append(el('strong', 'wapp-bd__sym', r.symbol), el('span', 'wapp-bd__name', r.name));
  mid.append(top, el('span', 'wapp-bd__price', formatPrice(r.priceUsd)));

  const right = el('div', 'wapp-bd__right');
  const cap = el('span', 'wapp-bd__cap', compactUsd(r.capUsd));
  cap.title = r.capIsFdv ? 'Market cap (fully diluted: price times total supply)' : 'Market cap';
  const chg = el('span', `wapp-bd__chg is-${tone}`, tone === 'up' ? `▲ ${formatChange(h1)}` : tone === 'down' ? `▼ ${formatChange(h1).replace('-', '')}` : formatChange(h1));
  chg.title = 'Price change over the last hour';
  right.append(cap, chg);

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
  head.append(el('span', 'wapp-bd__legend', 'MCAP · 1H'));
  if (switcher) head.append(switcher);
  col.append(head);
  const list = el('div', 'wapp-bd__list');
  if (rows.length === 0) list.append(el('p', 'wapp-bd__empty', `No ${title} tokens match right now.`));
  const fill = o.isFill;
  const own = fill ? rows.filter((r) => !fill(r)) : rows;
  const extra = fill ? rows.filter((r) => fill(r)) : [];
  const ordered = [...own.slice(0, PER_COLUMN), ...extra.slice(0, Math.max(0, PER_COLUMN - own.length))];
  let dividerShown = false;
  for (const r of ordered) {
    if (fill && fill(r) && !dividerShown) {
      dividerShown = true;
      list.append(el('p', 'wapp-bd__divider', `More on ${title}, by liquidity`));
    }
    list.append(card(r, o));
  }
  if (rows.length > ordered.length) list.append(el('p', 'wapp-bd__more', `${rows.length - ordered.length} more not shown. Use the search.`));
  col.append(list);
  return col;
}

export function marketBoard(o: BoardOptions): HTMLElement {
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
    const price = c.querySelector('.wapp-bd__price');
    const next = formatPrice(r.priceUsd);
    if (price && price.textContent !== next) {
      price.textContent = next;
      if (prev && prev.priceUsd !== null && r.priceUsd !== null && r.priceUsd !== prev.priceUsd) flash(price, r.priceUsd > prev.priceUsd ? 'up' : 'down');
    }
    const cap = c.querySelector('.wapp-bd__cap');
    if (cap && cap.textContent !== compactUsd(r.capUsd)) cap.textContent = compactUsd(r.capUsd);
    const chg = c.querySelector<HTMLElement>('.wapp-bd__chg');
    if (chg) {
      const h1 = r.change.h1;
      const tone = changeTone(h1);
      const text = tone === 'up' ? `▲ ${formatChange(h1)}` : tone === 'down' ? `▼ ${formatChange(h1).replace('-', '')}` : formatChange(h1);
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
    return io;
  });
  return () => {
    clearTimeout(timer);
    observers.forEach((o) => o.disconnect());
  };
}
