/**
 * The Markets board: four columns side by side, one per network, in the way pump.fun lays out its coin lists.
 * Solana, Ethereum, BNB Chain and a fourth for Base or Robinhood Chain. Each token is one compact card that carries the three
 * numbers that matter at a glance: market cap (large), the one-hour price change (a coloured pill) and the price. A card opens
 * the token. The columns hold the same tokens the table would show, in the same order, split by network.
 */
import type { ChainId } from '../swings/core/types.js';
import { compactUsd, formatChange, formatPrice, type MarketRow } from '../swings/market/types.js';
import { marketLogo } from './walletMarketTable.js';

export type FourthChain = 'base' | 'robinhood';
export type BoardView = 'board' | 'table';

const VIEW_KEY = 'aretia-markets-view';
interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

/** The layout the person last chose; the board until they choose the table. */
export function loadBoardView(storage: StorageLike | null): BoardView {
  try {
    return storage?.getItem(VIEW_KEY) === 'table' ? 'table' : 'board';
  } catch {
    return 'board';
  }
}

export function saveBoardView(storage: StorageLike | null, v: BoardView): void {
  try {
    storage?.setItem(VIEW_KEY, v);
  } catch {
    // Not remembered; the choice lasts until the page is closed.
  }
}

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
export const FOURTH_TITLES: Readonly<Record<FourthChain, string>> = { base: 'Base', robinhood: 'Robinhood Chain' };
export const FOURTH_CHOICES: readonly FourthChain[] = ['base', 'robinhood'];

/** Tokens shown per column. A column that has more says how many it left out. */
export const PER_COLUMN = 30;

export interface BoardOptions {
  rows: readonly MarketRow[];
  fourth: FourthChain;
  onFourth(c: FourthChain): void;
  onOpen(row: MarketRow): void;
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

function changeTone(n: number | null): 'up' | 'down' | 'flat' {
  return n === null || !Number.isFinite(n) || n === 0 ? 'flat' : n > 0 ? 'up' : 'down';
}

function card(r: MarketRow, o: BoardOptions): HTMLElement {
  const h1 = r.change.h1;
  const tone = changeTone(h1);
  const c = el('div', `wapp-bd__card is-${tone}`);
  c.setAttribute('role', 'button');
  c.tabIndex = 0;
  c.dataset.key = `${r.chain}:${r.address.toLowerCase()}`;
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

  const mid = el('div', 'wapp-bd__mid');
  const top = el('div', 'wapp-bd__top');
  top.append(el('strong', 'wapp-bd__sym', r.symbol));
  if (r.quoteSymbol) top.append(el('span', 'wapp-bd__quote', `/ ${r.quoteSymbol}`));
  mid.append(top, el('span', 'wapp-bd__name', r.name));
  mid.append(el('span', 'wapp-bd__price', formatPrice(r.priceUsd)));

  const right = el('div', 'wapp-bd__right');
  const cap = el('span', 'wapp-bd__cap', compactUsd(r.capUsd));
  cap.title = r.capIsFdv ? 'Fully diluted value: price times total supply' : 'Market cap';
  const chg = el('span', `wapp-bd__chg is-${tone}`, tone === 'up' ? `▲ ${formatChange(h1)}` : tone === 'down' ? `▼ ${formatChange(h1).replace('-', '')}` : formatChange(h1));
  chg.title = 'Price change over the last hour';
  right.append(el('span', 'wapp-bd__lab', 'MCAP'), cap, chg);

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
  if (switcher) head.append(switcher);
  col.append(head);
  const list = el('div', 'wapp-bd__list');
  if (rows.length === 0) list.append(el('p', 'wapp-bd__empty', `No ${title} tokens match right now.`));
  for (const r of rows.slice(0, PER_COLUMN)) list.append(card(r, o));
  if (rows.length > PER_COLUMN) list.append(el('p', 'wapp-bd__more', `${rows.length - PER_COLUMN} more not shown. Use the search or the table.`));
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
    const b = el('button', '', FOURTH_TITLES[c].replace(' Chain', ''));
    b.type = 'button';
    b.setAttribute('aria-pressed', String(c === fourth));
    b.addEventListener('click', () => o.onFourth(c));
    sw.append(b);
  }
  board.append(column(FOURTH_TITLES[fourth], fourth, columnRows(o.rows, fourth), o, sw));
  return board;
}
