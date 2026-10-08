/**
 * The search box in the wallet's top bar, on the same line as the network and price chips. One box finds new and
 * established tokens on every supported network; choosing one opens it in Swap Coins with its chart.
 */
import { CHAINS } from '../swings/core/types.js';
import { searchTokens, type SearchHit } from '../swings/tokens/globalSearch.js';

export const OPEN_TOKEN_EVENT = 'aretia:open-token';

const usd = (n: number | null): string => (n === null ? '' : n >= 1e6 ? `$${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `$${Math.round(n / 1e3)}K` : `$${Math.round(n)}`);
const short = (a: string): string => (a.length > 12 ? `${a.slice(0, 4)}…${a.slice(-4)}` : a);

function el<K extends keyof HTMLElementTagNameMap>(tag: K, props: { class?: string; text?: string; attrs?: Record<string, string> } = {}, children: (Node | null | false)[] = []): HTMLElementTagNameMap[K] {
  const n = document.createElement(tag);
  if (props.class) n.className = props.class;
  if (props.text !== undefined) n.textContent = props.text;
  for (const [k, v] of Object.entries(props.attrs ?? {})) n.setAttribute(k, v);
  for (const c of children) if (c) n.append(c);
  return n;
}

/** The token's picture, or its first letters if it has none or the picture does not load. */
function logoFor(h: SearchHit): HTMLElement {
  const letters = el('span', { class: 'wapp-avatar wapp-search__logo', text: h.symbol.slice(0, 2).toUpperCase() });
  if (!h.icon) return letters;
  const img = el('img', { class: 'wapp-avatar wapp-search__logo', attrs: { src: h.icon, alt: '', loading: 'lazy', referrerpolicy: 'no-referrer', width: '28', height: '28' } });
  img.addEventListener('error', () => img.replaceWith(letters));
  return img;
}

export function mountTokenSearch(): void {
  if (document.querySelector('[data-wapp-search]')) return;
  const wrap = el('div', { class: 'wapp-search', attrs: { 'data-wapp-search': '' } });
  const input = el('input', { class: 'wapp-search__input', attrs: { type: 'search', placeholder: 'Search any token: name, symbol or contract address', autocomplete: 'off', spellcheck: 'false', role: 'combobox', 'aria-expanded': 'false', 'aria-controls': 'wapp-search-list', 'aria-label': 'Search tokens' } });
  const icon = el('span', { class: 'wapp-search__icon', attrs: { 'aria-hidden': 'true' } });
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('width', '16');
  svg.setAttribute('height', '16');
  const ring = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
  for (const [k, v] of Object.entries({ cx: '11', cy: '11', r: '6.5' })) ring.setAttribute(k, v);
  const handle = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  handle.setAttribute('d', 'M16 16l4.5 4.5');
  svg.append(ring, handle);
  icon.append(svg);
  const list = el('ul', { class: 'wapp-search__list', attrs: { id: 'wapp-search-list', role: 'listbox', hidden: '' } });
  wrap.append(icon, input, list);

  // On a wide screen the box sits in the site bar next to the chips; on a narrow one it sits at the top of the page.
  const place = (): void => {
    const bar = document.querySelector<HTMLElement>('header.nav .nav__bar');
    const actions = bar?.querySelector<HTMLElement>('.nav__actions') ?? null;
    const home = document.querySelector<HTMLElement>('.wapp__top');
    const wide = window.matchMedia('(min-width: 1081px)').matches;
    if (wide && bar && actions) bar.insertBefore(wrap, actions);
    else if (home) home.append(wrap);
  };
  window.matchMedia('(min-width: 1081px)').addEventListener('change', place);
  place();

  let hits: SearchHit[] = [];
  let active = -1;
  let seq = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let controller: AbortController | null = null;

  const close = (): void => {
    list.hidden = true;
    input.setAttribute('aria-expanded', 'false');
    active = -1;
  };

  const choose = (h: SearchHit): void => {
    close();
    input.value = '';
    hits = [];
    window.dispatchEvent(new CustomEvent(OPEN_TOKEN_EVENT, { detail: h }));
  };

  function paint(message?: string): void {
    list.replaceChildren();
    if (message) list.append(el('li', { class: 'wapp-search__note', text: message }));
    hits.forEach((h, i) => {
      const row = el('li', { class: 'wapp-search__row', attrs: { role: 'option', 'aria-selected': String(i === active) } });
      const btn = el('button', { class: 'wapp-search__item', attrs: { type: 'button', tabindex: '-1' } });
      btn.append(
        logoFor(h),
        el('span', { class: 'wapp-search__text' }, [el('strong', { text: h.symbol }), el('small', { text: `${h.name || 'No name'} · ${CHAINS[h.chain].name} · ${short(h.address)}` })]),
        el('span', { class: 'wapp-search__side' }, [h.fresh ? el('span', { class: 'wapp-search__new', text: 'New' }) : null, h.liquidityUsd !== null ? el('small', { text: `liq ${usd(h.liquidityUsd)}` }) : null]),
      );
      btn.addEventListener('mousedown', (e) => e.preventDefault());
      btn.addEventListener('click', () => choose(h));
      row.append(btn);
      list.append(row);
    });
    list.hidden = false;
    input.setAttribute('aria-expanded', 'true');
  }

  async function run(q: string): Promise<void> {
    controller?.abort();
    controller = new AbortController();
    const mine = ++seq;
    paint('Searching…');
    try {
      const found = await searchTokens(q, undefined, controller.signal);
      if (mine !== seq) return;
      hits = found;
      active = hits.length > 0 ? 0 : -1;
      paint(hits.length === 0 ? 'No tokens found. Names are not unique: paste the contract address to be sure.' : undefined);
    } catch {
      if (mine !== seq) return;
      hits = [];
      paint('The search could not be reached. Try again in a moment.');
    }
  }

  input.addEventListener('input', () => {
    clearTimeout(timer);
    const q = input.value.trim();
    if (q.length < 2) {
      seq++;
      controller?.abort();
      hits = [];
      close();
      return;
    }
    timer = setTimeout(() => void run(q), 250);
  });
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') return close();
    if (hits.length === 0) return;
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      active = (active + (e.key === 'ArrowDown' ? 1 : -1) + hits.length) % hits.length;
      paint();
    } else if (e.key === 'Enter' && active >= 0) {
      e.preventDefault();
      choose(hits[active]!);
    }
  });
  input.addEventListener('focus', () => {
    if (hits.length > 0) paint();
  });
  document.addEventListener('click', (e) => {
    if (!wrap.contains(e.target as Node)) close();
  });
}
