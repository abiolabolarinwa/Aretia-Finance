/**
 * The token table used by Find Tokens and Marketplace: one row per token, columns for market cap, price, age,
 * transactions, volume, traders, the 5-minute to 24-hour price changes and liquidity, and (for Find Tokens) Aretia's
 * risk rating. Light theme, sortable columns, scrolls sideways on a narrow screen. Clicking a row opens the token.
 */
import { CHAINS } from '../swings/core/types.js';
import { cachedLogo } from '../swings/tokens/logos.js';
import { sparkPoints } from '../swings/market/overview.js';
import { compactCount, compactUsd, formatAge, formatChange, formatPrice, sortRows, type MarketRow, type SortKey } from '../swings/market/types.js';
import { RATING_BANDS, ratingView, type CheckState } from '../swings/market/rowRisk.js';
import { LOCK_ICON, lockTitle } from './walletIcons.js';
import { dexInitial, dexLogoSrc } from '../swings/market/dexLogo.js';
import { padlockShown } from '../swings/market/lock.js';
import { verifiedBadge } from '../lib/verifiedBadge';
import { imitationChip } from '../lib/imitationChip';

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
  /** The Trade button at the end of each row. Absent: no button (the row still opens the token). */
  onTrade?(row: MarketRow): void;
  /** The Last 24h price line column. Only the all-networks view (the Aretia mark) shows it; a single network keeps the plain table. */
  showSpark?: boolean;
  /** Where each row's on-chain check stands, so its rating can say "Checking" or "Couldn't check". */
  ratingState?(row: MarketRow): CheckState | undefined;
  /** The row to show as selected (the one the side panel is describing). */
  selectedKey?: string | null;
  /** A star on each row, to keep a token in the person's favourites. */
  favourites?: { has(row: MarketRow): boolean; toggle(row: MarketRow): void };
  /** The rank of the first row, when the table is one page of a longer list. */
  rankStart?: number;
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
  { key: 'traders', label: 'Traders', title: 'Different wallets that received the output of a swap in the last 24 hours, where the source counts them. A router or aggregator counts as one wallet.' },
  { key: 'm5', label: '5M', title: 'Price change over 5 minutes' },
  { key: 'h1', label: '1H', title: 'Price change over 1 hour' },
  { key: 'h6', label: '6H', title: 'Price change over 6 hours' },
  { key: 'h24', label: '24H', title: 'Price change over 24 hours' },
  { key: 'liquidity', label: 'Liquidity', title: 'Money in the pool. It can be withdrawn by whoever put it there.' },
];

export function marketLogo(r: MarketRow): HTMLElement {
  return logo(r);
}

/** A small price line for the last 24 hours, green when the day's change is up and red when down; empty when the figures cannot draw one. */
function sparkCell(r: MarketRow): HTMLElement {
  const td = el('td', 'wapp-mt__num wapp-mt__spark');
  const pts = sparkPoints(r);
  if (!pts) return td;
  const W = 84;
  const H = 26;
  const prices = pts.map((p) => p[1]);
  const lo = Math.min(...prices);
  const hi = Math.max(...prices);
  const span = hi - lo || 1;
  const xy = pts.map(([x, p]) => `${(x * W).toFixed(1)},${(H - 3 - ((p - lo) / span) * (H - 6)).toFixed(1)}`).join(' ');
  const ns = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(ns, 'svg');
  svg.setAttribute('viewBox', `0 0 ${W} ${H}`);
  svg.setAttribute('width', String(W));
  svg.setAttribute('height', String(H));
  svg.setAttribute('aria-hidden', 'true');
  const line = document.createElementNS(ns, 'polyline');
  line.setAttribute('points', xy);
  line.setAttribute('fill', 'none');
  line.setAttribute('stroke', (r.change.h24 ?? 0) >= 0 ? '#1b8a4b' : '#b3261e');
  line.setAttribute('stroke-width', '1.6');
  line.setAttribute('stroke-linejoin', 'round');
  line.setAttribute('stroke-linecap', 'round');
  svg.append(line);
  td.append(svg);
  return td;
}

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

/** The market cap, or the fully diluted value (price x total supply) the index gives, with a hover note saying so. */
function capCell(r: MarketRow): HTMLElement {
  const td = el('td', 'wapp-mt__num', compactUsd(r.capUsd));
  if (r.capIsFdv) td.title = 'Fully diluted value: price times the token\'s total supply. How much is in circulation is not known.';
  return td;
}

/** The price, with a tilde and a hover note when it was read from the pool's reserves because no trade of the pool is stored yet. */
function priceCell(r: MarketRow): HTMLElement {
  if (!r.priceFromReserves) return el('td', 'wapp-mt__num', formatPrice(r.priceUsd));
  const td = el('td', 'wapp-mt__num', `~${formatPrice(r.priceUsd)}`);
  td.title = "Read from the pool's reserves. No trade of this pool has been recorded yet.";
  return td;
}

/** A price change; grey "0.00%" with a hover note while the pool has no trade data for the window, never a coloured figure. */
function changeCell(n: number | null): HTMLElement {
  if (n === null) {
    const td = el('td', 'wapp-mt__num is-pending', formatChange(0));
    td.title = 'No trade data for this window yet. It fills in when the pool trades.';
    return td;
  }
  return el('td', `wapp-mt__num ${n > 0 ? 'is-up' : n < 0 ? 'is-down' : ''}`, formatChange(n));
}

/** The liquidity figure, with a padlock when the pool's liquidity tokens are shown to be burned or locked, and the token keeps no admin power. */
function liquidityCell(r: MarketRow): HTMLElement {
  const td = el('td', 'wapp-mt__num wapp-mt__liq', compactUsd(r.liquidityUsd));
  if (!padlockShown(r.lockedPct, r.risk)) return td;
  const timed = r.lockInfo?.kind === 'time-locked';
  const lock = el('span', `wapp-mt__lock${timed ? ' is-timed' : ''}`);
  lock.title = lockTitle(r.lockedPct, r.lockInfo);
  lock.setAttribute('role', 'img');
  lock.setAttribute('aria-label', timed ? `Liquidity locked, ${r.lockedPct.toFixed(1)} percent in a locker` : `Liquidity tokens burned, ${r.lockedPct.toFixed(1)} percent`);
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

/** The cells whose numbers move with trades, in column order: value, price, transactions, volume, traders, the four changes, liquidity. Each carries its place in `data-live`. */
function liveCells(r: MarketRow): HTMLElement[] {
  const txns = el('td', 'wapp-mt__num', r.txnsCapped && r.txns24h !== null ? `${compactCount(r.txns24h)}+` : compactCount(r.txns24h));
  if (r.txnsCapped) txns.title = 'This pool traded more than 5,000 times today. Aretia counts its newest 5,000, so the real number of transactions and the volume are higher.';
  const cells = [capCell(r), priceCell(r), txns, el('td', 'wapp-mt__num', compactUsd(r.volume24hUsd)), el('td', 'wapp-mt__num', compactCount(r.traders24h)), changeCell(r.change.m5), changeCell(r.change.h1), changeCell(r.change.h6), changeCell(r.change.h24), liquidityCell(r)];
  cells.forEach((c, i) => {
    c.dataset.live = String(i);
  });
  return cells;
}

/**
 * Redraws the moving numbers of the given rows in place (a live update), without redrawing the table. Only a cell whose text changed is
 * replaced, and a price or change that moved up or down flashes briefly, so the eye finds what just happened.
 */
export function updateLiveCells(table: ParentNode, rows: readonly MarketRow[], before?: ReadonlyMap<string, MarketRow>): void {
  for (const r of rows) {
    const k = tableRowKey(r);
    const tr = table.querySelector<HTMLElement>(`.wapp-mt__row[data-k="${CSS.escape(k)}"]`);
    if (!tr) continue;
    const prev = before?.get(k);
    liveCells(r).forEach((fresh, i) => {
      const old = tr.querySelector<HTMLElement>(`[data-live="${i}"]`);
      if (!old || (old.textContent === fresh.textContent && old.className === fresh.className)) return;
      const dir = i === 1 && prev && prev.priceUsd !== null && r.priceUsd !== null && r.priceUsd !== prev.priceUsd ? (r.priceUsd > prev.priceUsd ? 'up' : 'down') : null;
      if (dir) fresh.classList.add(`is-tick-${dir}`);
      old.replaceWith(fresh);
    });
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
  const table = el('table', o.showSpark ? 'wapp-mt__table has-spark' : 'wapp-mt__table');
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
  if (o.showSpark) hr.append(th('Last 24h', 'wapp-mt__numhead wapp-mt__sparkhead', undefined, 'The price over the last 24 hours, drawn from the price now and its changes over 5 minutes, 1, 6 and 24 hours.'));
  if (o.onTrade) hr.append(th('', 'wapp-mt__tradehead'));
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
    tr.append(el('td', 'wapp-mt__rank', String((o.rankStart ?? 1) + i)));
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
    const verified = verifiedBadge(r.chain, r.address, { plain: true });
    if (verified) line.append(verified);
    const imitates = imitationChip(r.chain, r.address, r.symbol, r.name);
    if (imitates) line.append(imitates);
    const full = el('small', 'wapp-mt__fullname', r.name || 'No name given');
    // Neither the data source nor the exchange is written out: the exchange is a logo beside the network's.
    names.append(line, full);
    const cell = el('div', 'wapp-mt__cell');
    cell.append(logo(r), names);
    if (r.venue) {
      const src = dexLogoSrc(r.venue);
      let dex: HTMLElement;
      if (src) {
        const img = el('img', 'wapp-mt__chain wapp-mt__dex');
        img.src = src;
        img.width = 14;
        img.height = 14;
        img.alt = r.venue;
        dex = img;
      } else {
        dex = el('span', 'wapp-mt__chain wapp-mt__dex wapp-mt__dex--letter', dexInitial(r.venue));
      }
      dex.title = r.venue;
      cell.append(dex);
    }
    cell.append(chain);
    tok.append(cell);
    tr.append(tok);
    if (o.showRisk) {
      tr.append(ratingCell(r, o.ratingState?.(r)));
    }
    const live = liveCells(r);
    tr.append(live[0]!, live[1]!, el('td', 'wapp-mt__num', formatAge(r.ageMs)), ...live.slice(2), ...(o.showSpark ? [sparkCell(r)] : []));
    if (o.onTrade) {
      const trade = o.onTrade;
      const cell = el('td', 'wapp-mt__tradecell');
      const b = el('button', 'wapp-mt__trade', 'Trade');
      b.type = 'button';
      b.setAttribute('aria-label', `Trade ${r.symbol}`);
      // The row opens the token; the button starts a trade.
      b.addEventListener('click', (e) => {
        e.stopPropagation();
        trade(r);
      });
      b.addEventListener('keydown', (e) => e.stopPropagation());
      cell.append(b);
      tr.append(cell);
    }
    body.append(tr);
  });
  table.append(head, body);
  wrap.append(table);
  return wrap;
}
