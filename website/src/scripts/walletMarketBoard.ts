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
export const BOARD_FILL_TO = 120;
/** Tokens drawn per column at most. */
export const PER_COLUMN = 200;

export interface BoardOptions {
  rows: readonly MarketRow[];
  fourth: FourthChain;
  onFourth(c: FourthChain): void;
  onOpen(row: MarketRow): void;
  /** True for a token added to fill a column that the current tab alone leaves short; it is listed under a divider, after the tab's own tokens. */
  isFill?(row: MarketRow): boolean;
  /** One network chosen from the rail: a single wide column of that network, with the cards in rows of several. */
  only?: ChainId;
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
  if (o.only) {
    const one = el('div', 'wapp-bd wapp-bd--single');
    const chain = o.only;
    const title = chain === 'solana' ? 'Solana' : chain === 'ethereum' ? 'Ethereum' : chain === 'bnb' ? 'BNB Chain' : chain === 'base' ? 'Base' : chain === 'robinhood' ? 'Robinhood' : chain;
    one.append(column(title, chain, columnRows(o.rows, chain), o));
    return one;
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
