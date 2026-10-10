/**
 * The token table used by Find Tokens and Marketplace: one row per token, columns for market cap, price, age,
 * transactions, volume, traders, the 5-minute to 24-hour price changes and liquidity, and (for Find Tokens) Aretia's
 * risk rating. Light theme, sortable columns, scrolls sideways on a narrow screen. Clicking a row opens the token.
 */
import { CHAINS } from '../swings/core/types.js';
import { cachedLogo } from '../swings/tokens/logos.js';
import { compactCount, compactUsd, formatAge, formatChange, formatPrice, sortRows, type MarketRow, type SortKey } from '../swings/market/types.js';
import { RATING_BANDS, ratingView, type CheckState } from '../swings/market/rowRisk.js';
import { LOCK_ICON, lockTitle } from './walletIcons.js';

export interface TableState {
  key: SortKey | null;
  dir: 'asc' | 'desc';
}

export interface TableOptions {
  rows: readonly MarketRow[];
  sort: TableState;
  /** Show Aretia's risk column (Find Tokens). */
  showRisk: boolean;
  onSort(key: SortKey): void;
  onOpen(row: MarketRow): void;
  /** Where each row's on-chain check stands, so its rating can say "Checking" or "Couldn't check". */
  ratingState?(row: MarketRow): CheckState | undefined;
  /** The row to show as selected (the one the side panel is describing). */
  selectedKey?: string | null;
  /** A star on each row, to keep a token in the person's favourites. */
  favourites?: { has(row: MarketRow): boolean; toggle(row: MarketRow): void };
}

function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls = '', text?: string): HTMLElementTagNameMap[K] {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text !== undefined) n.textContent = text;
  return n;
}

const COLUMNS: { key: SortKey; label: string; title: string }[] = [
  { key: 'cap', label: 'Mcap', title: 'Market cap, or fully diluted value when no market cap is reported' },
  { key: 'price', label: 'Price', title: 'Price of the token in US dollars, from the pool shown' },
  { key: 'age', label: 'Age', title: 'How long the pool has existed' },
  { key: 'txns', label: 'Txns', title: 'Buys and sells in the last 24 hours' },
  { key: 'volume', label: 'Volume', title: 'Trading volume in the last 24 hours' },
  { key: 'traders', label: 'Traders', title: 'People who bought or sold in the last 24 hours, where the source counts them' },
  { key: 'm5', label: '5M', title: 'Price change over 5 minutes' },
  { key: 'h1', label: '1H', title: 'Price change over 1 hour' },
  { key: 'h6', label: '6H', title: 'Price change over 6 hours' },
  { key: 'h24', label: '24H', title: 'Price change over 24 hours' },
  { key: 'liquidity', label: 'Liquidity', title: 'Money in the pool. It can be withdrawn by whoever put it there.' },
];

function logo(r: MarketRow): HTMLElement {
  const letters = el('span', 'wapp-avatar wapp-mt__logo', (r.symbol || '?').slice(0, 2).toUpperCase());
  const url = r.icon ?? cachedLogo(r.chain, r.address);
  if (!url || !/^https:\/\//.test(url) && !url.startsWith('/')) return letters;
  const img = el('img', 'wapp-avatar wapp-mt__logo');
  img.alt = '';
  img.width = 32;
  img.height = 32;
  img.loading = 'lazy';
  img.referrerPolicy = 'no-referrer';
  img.src = url;
  img.addEventListener('error', () => img.replaceWith(letters), { once: true });
  return img;
}

function changeCell(n: number | null): HTMLElement {
  const td = el('td', `wapp-mt__num ${n === null ? '' : n > 0 ? 'is-up' : n < 0 ? 'is-down' : ''}`, formatChange(n));
  return td;
}

/** The liquidity figure, with a padlock when the pool's liquidity is shown to be locked (burned). */
function liquidityCell(r: MarketRow): HTMLElement {
  const td = el('td', 'wapp-mt__num wapp-mt__liq', compactUsd(r.liquidityUsd));
  if (r.lockedPct === null || r.lockedPct === undefined) return td;
  const timed = r.lockInfo?.kind === 'time-locked';
  const lock = el('span', `wapp-mt__lock${timed ? ' is-timed' : ''}`);
  lock.title = lockTitle(r.lockedPct, r.lockInfo);
  lock.setAttribute('role', 'img');
  lock.setAttribute('aria-label', `Liquidity locked, ${r.lockedPct.toFixed(1)} percent ${timed ? 'in a locker' : 'burned'}`);
  lock.innerHTML = LOCK_ICON;
  td.prepend(lock);
  return td;
}

/** Redraws the liquidity cells (and their padlocks) of the given rows in place. */
export function updateLiquidityCells(table: ParentNode, rows: readonly MarketRow[]): void {
  for (const r of rows) {
    const tr = table.querySelector<HTMLElement>(`.wapp-mt__row[data-k="${CSS.escape(tableRowKey(r))}"]`);
    tr?.querySelector('.wapp-mt__liq')?.replaceWith(liquidityCell(r));
  }
}

/** Aretia's rating cell for a row: a label, drawn lighter while it is only a market reading, with its basis in the tooltip. */
function ratingCell(r: MarketRow, state: CheckState | undefined): HTMLElement {
  const v = ratingView(r, state);
  const td = el('td', 'wapp-mt__rating');
  const chip = el('span', `wapp__state wapp__state--${v.band}${v.soft ? ' wapp__state--soft' : ''}${v.checking ? ' is-checking' : ''}`, v.label);
  chip.title = v.title;
  td.append(chip);
  return td;
}

/** Redraws the rating cells of the given rows in place, without redrawing the table. */
export function updateRatingCells(table: ParentNode, rows: readonly MarketRow[], stateOf: (r: MarketRow) => CheckState | undefined): void {
  for (const r of rows) {
    const tr = table.querySelector<HTMLElement>(`.wapp-mt__row[data-k="${CSS.escape(tableRowKey(r))}"]`);
    tr?.querySelector('.wapp-mt__rating')?.replaceWith(ratingCell(r, stateOf(r)));
  }
}

/** The key a row carries, so a selection can be found again after the table is redrawn. */
export const tableRowKey = (r: MarketRow): string => `${r.chain}:${r.chain === 'solana' ? r.address : r.address.toLowerCase()}`;

/** Moves the "selected" look to one row without redrawing the table. */
export function markSelected(table: ParentNode, key: string | null): void {
  table.querySelectorAll<HTMLElement>('.wapp-mt__row').forEach((tr) => tr.classList.toggle('is-selected', key !== null && tr.dataset.k === key));
}

export function marketTable(o: TableOptions): HTMLElement {
  const wrap = el('div', 'wapp-mt');
  const table = el('table', 'wapp-mt__table');
  const head = el('thead');
  const hr = el('tr');
  const th = (label: string, cls = '', key?: SortKey, title?: string): HTMLElement => {
    const c = el('th', cls);
    if (title) c.title = title;
    if (!key) {
      c.textContent = label;
      return c;
    }
    const b = el('button', 'wapp-mt__sort', label);
    b.type = 'button';
    const active = o.sort.key === key;
    c.setAttribute('aria-sort', active ? (o.sort.dir === 'asc' ? 'ascending' : 'descending') : 'none');
    if (active) b.append(el('span', 'wapp-mt__arrow', o.sort.dir === 'asc' ? ' ▲' : ' ▼'));
    b.addEventListener('click', () => o.onSort(key));
    c.append(b);
    return c;
  };
  if (o.favourites) hr.append(th('', 'wapp-mt__starhead', undefined, 'Favourites'));
  hr.append(th('#', 'wapp-mt__rank'), th('Token', 'wapp-mt__tokenhead'));
  if (o.showRisk) hr.append(th('Aretia rating', '', undefined, `Aretia's own rating of the token, shown as a colour. ${RATING_BANDS.map((b) => `${b.name}: ${b.meaning}`).join(' ')} It is not advice and is not a promise.`));
  for (const c of COLUMNS) hr.append(th(c.label, 'wapp-mt__numhead', c.key, c.title));
  head.append(hr);

  const body = el('tbody');
  const rows = o.sort.key ? sortRows(o.rows, o.sort.key, o.sort.dir) : o.rows;
  rows.forEach((r, i) => {
    const tr = el('tr', 'wapp-mt__row');
    tr.tabIndex = 0;
    tr.dataset.k = tableRowKey(r);
    if (o.selectedKey === tr.dataset.k) tr.classList.add('is-selected');
    tr.setAttribute('role', 'link');
    tr.setAttribute('aria-label', `${r.symbol} on ${CHAINS[r.chain].name}: open`);
    const open = (): void => o.onOpen(r);
    tr.addEventListener('click', open);
    tr.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        open();
      }
    });
    if (o.favourites) {
      const fav = o.favourites;
      const on = fav.has(r);
      const star = el('button', 'wapp-mt__star');
      star.type = 'button';
      star.setAttribute('aria-pressed', String(on));
      star.setAttribute('aria-label', `${on ? 'Remove' : 'Add'} ${r.symbol} ${on ? 'from' : 'to'} favourites`);
      star.title = on ? 'Remove from favourites' : 'Add to favourites';
      star.textContent = on ? '★' : '☆';
      // The row opens the token; the star only toggles the favourite.
      star.addEventListener('click', (e) => {
        e.stopPropagation();
        fav.toggle(r);
        const now = fav.has(r);
        star.setAttribute('aria-pressed', String(now));
        star.textContent = now ? '★' : '☆';
        star.title = now ? 'Remove from favourites' : 'Add to favourites';
      });
      star.addEventListener('keydown', (e) => e.stopPropagation());
      const cell = el('td', 'wapp-mt__starcell');
      cell.append(star);
      tr.append(cell);
    }
    tr.append(el('td', 'wapp-mt__rank', String(i + 1)));
    const tok = el('td', 'wapp-mt__token');
    const chain = el('img', 'wapp-mt__chain');
    chain.alt = CHAINS[r.chain].name;
    chain.title = CHAINS[r.chain].name;
    chain.width = 14;
    chain.height = 14;
    chain.src = `/assets/chains/${r.chain}.png`;
    const names = el('span', 'wapp-mt__names');
    const line = el('span', 'wapp-mt__line');
    line.append(el('strong', '', r.symbol), el('small', '', r.quoteSymbol ? `/ ${r.quoteSymbol}` : ''));
    names.append(line, el('small', 'wapp-mt__fullname', r.name || 'No name given'));
    const cell = el('div', 'wapp-mt__cell');
    cell.append(logo(r), names, chain);
    tok.append(cell);
    tr.append(tok);
    if (o.showRisk) {
      tr.append(ratingCell(r, o.ratingState?.(r)));
    }
    tr.append(
      el('td', 'wapp-mt__num', compactUsd(r.capUsd)),
      el('td', 'wapp-mt__num', formatPrice(r.priceUsd)),
      el('td', 'wapp-mt__num', formatAge(r.ageMs)),
      el('td', 'wapp-mt__num', compactCount(r.txns24h)),
      el('td', 'wapp-mt__num', compactUsd(r.volume24hUsd)),
      el('td', 'wapp-mt__num', compactCount(r.traders24h)),
      changeCell(r.change.m5),
      changeCell(r.change.h1),
      changeCell(r.change.h6),
      changeCell(r.change.h24),
      liquidityCell(r),
    );
    body.append(tr);
  });
  table.append(head, body);
  wrap.append(table);
  return wrap;
}
