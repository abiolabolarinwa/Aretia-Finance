/**
 * The token table used by Find Tokens and Marketplace: one row per token, columns for market cap, price, age,
 * transactions, volume, traders, the 5-minute to 24-hour price changes and liquidity, and (for Find Tokens) Aretia's
 * risk rating. Light theme, sortable columns, scrolls sideways on a narrow screen. Clicking a row opens the token.
 */
import { CHAINS } from '../swings/core/types.js';
import { cachedLogo } from '../swings/tokens/logos.js';
import { compactCount, compactUsd, formatAge, formatChange, formatPrice, sortRows, type MarketRow, type SortKey } from '../swings/market/types.js';

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

/** The liquidity figure, with a padlock when Aretia proved most of the pool's liquidity tokens are burned. */
function liquidityCell(r: MarketRow): HTMLElement {
  const td = el('td', 'wapp-mt__num', compactUsd(r.liquidityUsd));
  if (r.lockedPct === null || r.lockedPct === undefined) return td;
  const lock = el('span', 'wapp-mt__lock');
  lock.title = `Locked: ${r.lockedPct.toFixed(r.lockedPct >= 99.95 ? 0 : 1)}% of this pool's liquidity tokens are burned, so that money cannot be withdrawn. Other liquidity in the pool, and tokens held by lock contracts, are not counted.`;
  lock.setAttribute('role', 'img');
  lock.setAttribute('aria-label', `Liquidity locked, ${r.lockedPct.toFixed(1)} percent burned`);
  lock.innerHTML = '<svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="5" y="11" width="14" height="9" rx="2"/><path d="M8 11V8a4 4 0 0 1 8 0v3"/></svg>';
  td.prepend(lock);
  return td;
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
  hr.append(th('#', 'wapp-mt__rank'), th('Token', 'wapp-mt__tokenhead'));
  if (o.showRisk) hr.append(th('Aretia rating', '', undefined, 'Aretia\'s own rating of the token. It is not advice and is not a promise.'));
  for (const c of COLUMNS) hr.append(th(c.label, 'wapp-mt__numhead', c.key, c.title));
  head.append(hr);

  const body = el('tbody');
  const rows = o.sort.key ? sortRows(o.rows, o.sort.key, o.sort.dir) : o.rows;
  rows.forEach((r, i) => {
    const tr = el('tr', 'wapp-mt__row');
    tr.tabIndex = 0;
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
      const td = el('td');
      const tone = !r.risk ? 'off' : r.risk.status === 'high' || r.risk.status === 'restricted' ? 'bad' : r.risk.status === 'elevated' ? 'warn' : r.risk.status === 'established' || r.risk.status === 'verified' ? 'on' : 'off';
      td.append(el('span', `wapp__state wapp__state--${tone}`, r.risk ? `${r.risk.label}${r.risk.score !== null ? ` · ${r.risk.score}` : ''}` : '–'));
      tr.append(td);
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
