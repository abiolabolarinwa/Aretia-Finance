/**
 * Launch Box on the web wallet: a Markets-style list of every token created through Aretia Launch, on every chain.
 *
 * The list comes from /api/launchbox (Aretia's own index of the chains plus DexScreener market data and curve progress read from the chain).
 * The table reuses the Markets table's look (the wapp-mt styles and its number formats); rows open the public token page. Every number is
 * the server's; a token with no pool shows "No market yet", and data that could not be refreshed is marked old.
 */
import { CHAINS } from '../swings/core/types.js';
import { cachedLogo } from '../swings/tokens/logos.js';
import { compactUsd, formatAge, formatChange, formatPrice } from '../swings/market/types.js';
import { LAUNCH_CHAINS, defaultSort, tokenKey, viewLaunches, type Filter, type LaunchChain, type LaunchView, type Sort, type SortKey, type Tab } from '../swings/launchbox/core.js';
import { verifiedChecker } from './launchBoxVerified';

export interface LaunchBoxIndexRow {
  chain: LaunchChain;
  updatedAt: number | null;
  expected: number | null;
  indexed: number | null;
  unreadable: number | null;
}
export interface LaunchBoxData {
  setup: 'ok' | 'no-table' | 'not-configured';
  generatedAt: number;
  launches: LaunchView[];
  index: LaunchBoxIndexRow[];
  staleMarket?: boolean;
  marketOk?: boolean;
  stale?: boolean;
}

const TABS: { tab: Tab; label: string; title: string }[] = [
  { tab: 'new', label: 'New', title: 'Newest tokens first' },
  { tab: 'trending', label: 'Trending', title: 'Most traded in the last 24 hours' },
  { tab: 'curve', label: 'On a curve', title: 'Tokens sold on an Aretia Curve' },
  { tab: 'pool', label: 'On a pool', title: 'Tokens with a trading pool' },
];

const COLUMNS: { key: SortKey; label: string; title: string }[] = [
  { key: 'age', label: 'Age', title: 'How long ago the token was created' },
  { key: 'price', label: 'Price', title: 'Price in US dollars from its biggest pool' },
  { key: 'change', label: '24H', title: 'Price change over 24 hours' },
  { key: 'volume', label: 'Volume', title: 'Trading volume in the last 24 hours' },
  { key: 'liquidity', label: 'Liquidity / curve', title: 'Money in the pool, or how much of an Aretia Curve is sold' },
  { key: 'cap', label: 'Mcap', title: 'Market cap, or fully diluted value (FDV) when no market cap is reported' },
];

const CURVE_LABEL: Record<string, string> = { trading: 'On curve', soldOut: 'Curve full', migrated: 'Left the curve', aborted: 'Curve unwound' };
const REFRESH_MS = 60_000;

function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls = '', text?: string): HTMLElementTagNameMap[K] {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text !== undefined) n.textContent = text;
  return n;
}

/** The token page for a row, on this site. */
export const tokenHref = (r: Pick<LaunchView, 'chain' | 'address'>): string => `/token#/${r.chain}/${r.chain === 'solana' ? r.address : r.address.toLowerCase()}`;

export function ago(ms: number | null, now: number): string {
  if (ms === null) return 'never';
  const s = Math.max(0, Math.round((now - ms) / 1000));
  if (s < 90) return 'just now';
  if (s < 5400) return `${Math.round(s / 60)} min ago`;
  if (s < 172_800) return `${Math.round(s / 3600)} h ago`;
  return `${Math.round(s / 86_400)} d ago`;
}

function logo(r: LaunchView): HTMLElement {
  const letters = el('span', 'wapp-avatar wapp-mt__logo', (r.symbol || '?').slice(0, 2).toUpperCase());
  const url = cachedLogo(r.chain, r.address);
  if (!url || !(/^https:\/\//.test(url) || url.startsWith('/'))) return letters;
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

function num(label: string, text: string, cls = ''): HTMLTableCellElement {
  const td = el('td', `wapp-mt__num ${cls}`.trim(), text);
  td.dataset.label = label;
  return td;
}

/** The price cell says plainly when there is nothing to price. */
function priceText(r: LaunchView): { text: string; muted: boolean } {
  if (r.priceUsd !== null) return { text: formatPrice(r.priceUsd), muted: false };
  if (r.market === 'unavailable') return { text: 'Unavailable', muted: true };
  return { text: r.curve ? 'On curve' : 'No market yet', muted: true };
}

function liquidityCell(r: LaunchView): HTMLTableCellElement {
  const td = num('Liquidity / curve', r.liquidityUsd !== null ? compactUsd(r.liquidityUsd) : '–');
  if (r.liquidityUsd === null && r.curve) {
    td.textContent = '';
    const bar = el('span', 'wapp-lb__bar');
    const fill = el('span', 'wapp-lb__fill');
    fill.style.width = `${Math.max(2, Math.min(100, r.curve.progressPct))}%`;
    bar.append(fill);
    bar.setAttribute('role', 'img');
    bar.setAttribute('aria-label', `Curve ${r.curve.progressPct.toFixed(0)} percent sold`);
    td.append(bar, el('small', 'wapp-lb__curve', `${r.curve.progressPct.toFixed(r.curve.progressPct < 10 ? 1 : 0)}% · ${CURVE_LABEL[r.curve.status] ?? r.curve.status}`));
  } else if (r.liquidityUsd !== null && r.curve && r.curve.status === 'trading') {
    td.append(el('small', 'wapp-lb__curve', `${r.curve.progressPct.toFixed(0)}% on curve`));
  }
  return td;
}

export interface TableHandlers {
  sort: Sort;
  onSort(key: SortKey): void;
  open(r: LaunchView): void;
  isVerified: ((chain: LaunchChain, address: string) => boolean) | null;
  now: number;
}

export function launchTable(rows: readonly LaunchView[], h: TableHandlers): HTMLElement {
  const wrap = el('div', 'wapp-mt wapp-lb__table');
  const table = el('table', 'wapp-mt__table');
  const head = el('thead');
  const hr = el('tr');
  hr.append(Object.assign(el('th', 'wapp-mt__rank', '#')), el('th', 'wapp-mt__tokenhead', 'Token'));
  for (const c of COLUMNS) {
    const th = el('th', 'wapp-mt__numhead');
    th.title = c.title;
    const b = el('button', 'wapp-mt__sort', c.label);
    b.type = 'button';
    const active = h.sort.key === c.key;
    th.setAttribute('aria-sort', active ? (h.sort.dir === 'asc' ? 'ascending' : 'descending') : 'none');
    if (active) b.append(el('span', 'wapp-mt__arrow', h.sort.dir === 'asc' ? ' ▲' : ' ▼'));
    b.addEventListener('click', () => h.onSort(c.key));
    th.append(b);
    hr.append(th);
  }
  head.append(hr);
  const body = el('tbody');
  rows.forEach((r, i) => {
    const tr = el('tr', 'wapp-mt__row wapp-lb__row');
    tr.tabIndex = 0;
    tr.dataset.k = tokenKey(r.chain, r.address);
    tr.setAttribute('role', 'link');
    tr.setAttribute('aria-label', `${r.symbol || 'Token'} on ${CHAINS[r.chain].name}: open`);
    tr.addEventListener('click', () => h.open(r));
    tr.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        h.open(r);
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
    const link = el('a', 'wapp-lb__link');
    link.href = tokenHref(r);
    link.append(el('strong', '', r.symbol || '?'));
    link.addEventListener('click', (e) => e.stopPropagation());
    line.append(link);
    if (h.isVerified?.(r.chain, r.address)) {
      const v = el('span', 'wapp-lb__verified', '✓');
      v.title = 'Verified by Aretia';
      v.setAttribute('role', 'img');
      v.setAttribute('aria-label', 'Verified');
      line.append(v);
    }
    names.append(line, el('small', 'wapp-mt__fullname', r.name || 'No name given'));
    const cell = el('div', 'wapp-mt__cell');
    cell.append(logo(r), names, chain);
    tok.append(cell);
    tr.append(tok);
    const price = priceText(r);
    tr.append(
      num('Age', r.createdAt === null ? '–' : formatAge(h.now - r.createdAt)),
      num('Price', price.text, price.muted ? 'wapp-lb__muted' : ''),
      num('24H', formatChange(r.change24h), r.change24h === null ? '' : r.change24h > 0 ? 'is-up' : r.change24h < 0 ? 'is-down' : ''),
      num('Volume', compactUsd(r.volume24hUsd)),
      liquidityCell(r),
      num(r.capKind === 'fdv' ? 'FDV' : 'Mcap', compactUsd(r.capUsd)),
    );
    if (r.capKind === 'fdv') tr.lastElementChild!.setAttribute('title', 'Fully diluted value: no market cap is reported for this token');
    body.append(tr);
  });
  table.append(head, body);
  wrap.append(table);
  return wrap;
}

export interface LaunchBoxOptions {
  fetchImpl?: typeof fetch;
  navigate?(href: string): void;
  goLaunch(): void;
}

export function initLaunchBox(o: LaunchBoxOptions): { onShow(): void } {
  const root = document.querySelector<HTMLElement>('[data-lb-root]');
  if (!root) return { onShow() {} };
  const doFetch: typeof fetch = o.fetchImpl ?? ((input, init) => fetch(input, init));
  const navigate = o.navigate ?? ((href: string) => location.assign(href));
  const filter: Filter = { tab: 'new', chain: '', query: '' };
  let sort: Sort | null = null;
  let data: LaunchBoxData | null = null;
  let failed = false;
  let loading = false;
  let timer: number | null = null;
  let fetchedAt = 0;
  let verified: ReturnType<typeof verifiedChecker> | undefined;

  async function load(): Promise<void> {
    if (loading) return;
    loading = true;
    try {
      const res = await doFetch('/api/launchbox', { headers: { accept: 'application/json' } });
      if (!res.ok) throw new Error(String(res.status));
      data = (await res.json()) as LaunchBoxData;
      failed = false;
      fetchedAt = Date.now();
    } catch {
      failed = true;
    } finally {
      loading = false;
      render();
    }
  }

  function status(): HTMLElement | null {
    if (!data || data.setup !== 'ok') return null;
    const now = Date.now();
    const notes: string[] = [];
    if (failed) notes.push('Could not refresh just now. Showing the last list.');
    if (data.stale) notes.push('The server could not refresh this list, so it may be out of date.');
    if (data.staleMarket) notes.push('Prices could not be refreshed from the market source, so the numbers shown may be old.');
    if (data.marketOk === false) notes.push('The market source did not answer, so prices, volume and liquidity are not shown right now.');
    const lagging = data.index.filter((i) => i.updatedAt === null || now - i.updatedAt > 3_600_000);
    if (lagging.length > 0) notes.push(`The index of ${lagging.map((i) => CHAINS[i.chain].name).join(', ')} has not been updated for over an hour, so the newest tokens there may be missing.`);
    const missing = data.index.filter((i) => i.expected !== null && i.indexed !== null && i.indexed < i.expected);
    if (missing.length > 0) notes.push(`Still filling in older tokens: ${missing.map((i) => `${CHAINS[i.chain].name} ${i.indexed} of ${i.expected}`).join(', ')}.`);
    if (notes.length === 0) return null;
    const box = el('div', 'wapp-lb__note');
    box.setAttribute('role', 'status');
    for (const n of notes) box.append(el('p', '', n));
    return box;
  }

  function empty(title: string, text: string, withButton: boolean): HTMLElement {
    const box = el('div', 'wapp-lb__empty');
    box.append(el('h3', '', title), el('p', '', text));
    if (withButton) {
      const b = el('button', 'wapp__btn wapp__btn--primary', 'Launch a token');
      b.type = 'button';
      b.addEventListener('click', () => o.goLaunch());
      box.append(b);
    }
    return box;
  }

  function controls(): HTMLElement {
    const bar = el('div', 'wapp-lb__bar');
    const tabs = el('div', 'wapp__seg wapp-lb__tabs');
    tabs.setAttribute('role', 'group');
    tabs.setAttribute('aria-label', 'Show');
    for (const t of TABS) {
      const b = el('button', 'wapp__chip wapp__chip--btn', t.label);
      b.type = 'button';
      b.title = t.title;
      b.setAttribute('aria-pressed', String(filter.tab === t.tab));
      b.addEventListener('click', () => {
        filter.tab = t.tab;
        sort = null;
        render();
      });
      tabs.append(b);
    }
    const chains = el('div', 'wapp__seg wapp-lb__chains');
    chains.setAttribute('role', 'group');
    chains.setAttribute('aria-label', 'Network');
    for (const c of ['' as const, ...LAUNCH_CHAINS]) {
      const b = el('button', 'wapp__chip wapp__chip--btn', c === '' ? 'All networks' : CHAINS[c].name);
      b.type = 'button';
      b.setAttribute('aria-pressed', String(filter.chain === c));
      b.addEventListener('click', () => {
        filter.chain = c;
        render();
      });
      chains.append(b);
    }
    const search = el('input', 'wapp__input wapp-lb__search');
    search.type = 'search';
    search.placeholder = 'Search by name, symbol or address';
    search.setAttribute('aria-label', 'Search Launch Box');
    search.autocomplete = 'off';
    search.spellcheck = false;
    search.value = filter.query;
    search.addEventListener('input', () => {
      filter.query = search.value;
      renderList();
    });
    const sortSel = el('select', 'wapp__input wapp-lb__sort');
    sortSel.setAttribute('aria-label', 'Sort by');
    const cur = sort ?? defaultSort(filter.tab);
    for (const c of COLUMNS) {
      for (const dir of ['desc', 'asc'] as const) {
        const opt = el('option', '', `${c.key === 'age' ? (dir === 'desc' ? 'Newest first' : 'Oldest first') : `${c.label}: ${dir === 'desc' ? 'high to low' : 'low to high'}`}`);
        opt.value = `${c.key}:${dir}`;
        if (cur.key === c.key && cur.dir === dir) opt.selected = true;
        sortSel.append(opt);
      }
    }
    sortSel.addEventListener('change', () => {
      const [key, dir] = sortSel.value.split(':') as [SortKey, 'asc' | 'desc'];
      sort = { key, dir };
      renderList();
    });
    bar.append(tabs, chains, search, sortSel);
    return bar;
  }

  const listHost = el('div', 'wapp-lb__list');

  function renderList(): void {
    listHost.textContent = '';
    if (!data) {
      listHost.append(failed ? empty('Launch Box could not be loaded', 'Check your connection and try again in a moment.', false) : el('p', 'wapp__fine', 'Loading…'));
      return;
    }
    if (data.setup !== 'ok') {
      listHost.append(empty('Launch Box is being set up', data.setup === 'no-table' ? 'The list of Aretia-launched tokens has not been switched on yet. It will appear here as soon as it is.' : 'The list of Aretia-launched tokens is not connected yet. It will appear here as soon as it is.', false));
      return;
    }
    if (data.launches.length === 0) {
      listHost.append(empty('No tokens launched yet', 'Every token created with Aretia Launch, on Solana, BNB Chain, Ethereum and Polygon, is listed here. Be the first.', true));
      return;
    }
    const rows = viewLaunches(data.launches, filter, sort);
    if (rows.length === 0) {
      listHost.append(empty('Nothing matches', filter.query ? 'No token matches that search with the filters on.' : filter.tab === 'curve' ? 'No launched token is on an Aretia Curve right now.' : filter.tab === 'pool' ? 'No launched token has a trading pool yet.' : 'No token on that network yet.', false));
      return;
    }
    verified ??= verifiedChecker();
    listHost.append(
      launchTable(rows, {
        sort: sort ?? defaultSort(filter.tab),
        onSort: (key) => {
          const cur = sort ?? defaultSort(filter.tab);
          sort = { key, dir: cur.key === key ? (cur.dir === 'desc' ? 'asc' : 'desc') : 'desc' };
          renderList();
        },
        open: (r) => navigate(tokenHref(r)),
        isVerified: verified,
        now: Date.now(),
      }),
    );
  }

  function render(): void {
    root!.textContent = '';
    const head = el('div', 'wapp-lb__head');
    const h = el('div');
    h.append(el('h2', 'wapp__h2', 'Launch Box'), el('p', 'wapp__fine', 'Every token created with Aretia Launch, on every network. Open one to see its page. Prices come from the market, not from Aretia, and a new token may have none yet.'));
    head.append(h);
    if (data?.setup === 'ok') head.append(el('span', 'wapp-lb__count', `${data.launches.length} token${data.launches.length === 1 ? '' : 's'}`));
    root!.append(head, controls());
    const s = status();
    if (s) root!.append(s);
    root!.append(listHost);
    renderList();
    if (data?.setup === 'ok') {
      const foot = el('p', 'wapp-lb__foot', `Updated ${ago(fetchedAt || data.generatedAt, Date.now())}. Not advice: a listing here does not mean a token is safe, and anyone can create one.`);
      root!.append(foot);
    }
  }

  return {
    onShow() {
      render();
      void load();
      if (timer === null) {
        timer = window.setInterval(() => {
          if (!document.hidden && location.hash.replace(/^#\/?/, '').split('/')[0] === 'launchbox') void load();
        }, REFRESH_MS);
      }
    },
  };
}
