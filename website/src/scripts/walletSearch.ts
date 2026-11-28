/**
 * The search box in the wallet's top bar, on the same line as the network and price chips. One box finds new and
 * established tokens on every supported network; choosing one opens it in Swap Coins with its chart.
 */
import { SHOW_MARKET_EVENT } from './walletNotifications.js';
import { CHAINS } from '../swings/core/types.js';
import { searchTokens, type SearchHit } from '../swings/tokens/globalSearch.js';
import { lookupAddress } from './walletAddressLookup.js';
import { imitationChip } from '../lib/imitationChip';
import { clearRecent, loadRecent } from './walletRecentTokens';

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
  const input = el('input', { class: 'wapp-search__input', attrs: { type: 'search', placeholder: 'Search any token', title: 'Search by name, symbol or contract address', autocomplete: 'off', spellcheck: 'false', role: 'combobox', 'aria-expanded': 'false', 'aria-controls': 'wapp-search-list', 'aria-label': 'Search tokens', enterkeyhint: 'search' } });
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
  const list = el('ul', { class: 'wapp-search__list', attrs: { id: 'wapp-search-list', role: 'listbox', hidden: '', 'data-lenis-prevent': '' } });
  // Paste: puts a copied contract address in the box and searches it at once (shown while the box is empty).
  const paste = el('button', { class: 'wapp-search__paste', attrs: { type: 'button', 'aria-label': 'Paste a token address' } });
  const clip = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  clip.setAttribute('viewBox', '0 0 24 24');
  clip.setAttribute('width', '16');
  clip.setAttribute('height', '16');
  clip.setAttribute('aria-hidden', 'true');
  const board = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
  for (const [k, v] of Object.entries({ x: '8', y: '3', width: '8', height: '4', rx: '1.2' })) board.setAttribute(k, v);
  const sheetPath = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  sheetPath.setAttribute('d', 'M8 5H6.5A1.5 1.5 0 0 0 5 6.5v13A1.5 1.5 0 0 0 6.5 21h11a1.5 1.5 0 0 0 1.5-1.5v-13A1.5 1.5 0 0 0 17.5 5H16');
  clip.append(board, sheetPath);
  paste.append(clip, el('span', { text: 'Paste' }));
  wrap.append(icon, input, paste, list);

  // On a wide screen the box sits in the site bar next to the chips, and on a phone beside the logo; in between it sits at the top of the page.
  const place = (): void => {
    const bar = document.querySelector<HTMLElement>('header.nav .nav__bar');
    const actions = bar?.querySelector<HTMLElement>('.nav__actions') ?? null;
    const home = document.querySelector<HTMLElement>('.wapp__top');
    const inBar = window.matchMedia('(min-width: 1081px)').matches || window.matchMedia('(max-width: 720px)').matches;
    if (inBar && bar && actions) bar.insertBefore(wrap, actions);
    else if (home) home.append(wrap);
  };
  window.matchMedia('(min-width: 1081px)').addEventListener('change', place);
  window.matchMedia('(max-width: 720px)').addEventListener('change', place);
  place();

  let hits: SearchHit[] = [];
  let active = -1;
  let seq = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let controller: AbortController | null = null;
  /** Enter (or Paste) was pressed before the results came in: open the first one as soon as they do. */
  let openFirst = false;
  const syncPaste = (): void => {
    paste.hidden = input.value.trim() !== '';
  };

  const close = (): void => {
    list.hidden = true;
    input.setAttribute('aria-expanded', 'false');
    active = -1;
  };

  const choose = (h: SearchHit): void => {
    close();
    input.value = '';
    syncPaste();
    openFirst = false;
    hits = [];
    // A picked token opens its details and chart on Markets (the Swap button is there); the swap itself is one click further.
    window.dispatchEvent(new CustomEvent(SHOW_MARKET_EVENT, { detail: { chain: h.chain, address: h.address, symbol: h.symbol, name: h.name, icon: h.icon, page: 'swings' } }));
  };

  function paint(message?: string): void {
    list.replaceChildren();
    if (message) list.append(el('li', { class: 'wapp-search__note', text: message }));
    list.classList.toggle('is-recent', showingRecent);
    hits.forEach((h, i) => {
      const row = el('li', { class: 'wapp-search__row', attrs: { role: 'option', 'aria-selected': String(i === active) } });
      const btn = el('button', { class: 'wapp-search__item', attrs: { type: 'button', tabindex: '-1' } });
      btn.append(
        logoFor(h),
        el('span', { class: 'wapp-search__text' }, [el('strong', { text: h.symbol }, [imitationChip(h.chain, h.address, h.symbol, h.name)]), el('small', { text: `${h.name || 'No name'} · ${CHAINS[h.chain].name} · ${short(h.address)}` })]),
        el('span', { class: 'wapp-search__side' }, [h.fresh ? el('span', { class: 'wapp-search__new', text: 'New' }) : null, h.liquidityUsd !== null ? el('small', { text: `liq ${usd(h.liquidityUsd)}` }) : null]),
      );
      btn.addEventListener('mousedown', (e) => e.preventDefault());
      btn.addEventListener('click', () => choose(h));
      row.append(btn);
      list.append(row);
    });
    if (showingRecent && hits.length > 0) {
      const clear = el('button', { class: 'wapp-search__clear', text: 'Clear recent', attrs: { type: 'button' } });
      clear.addEventListener('mousedown', (e) => e.preventDefault());
      clear.addEventListener('click', () => {
        clearRecent();
        showRecent();
      });
      list.append(el('li', { class: 'wapp-search__foot' }, [clear]));
    }
    list.hidden = false;
    input.setAttribute('aria-expanded', 'true');
  }

  /** With the box empty: the tokens opened recently on this device, newest first. */
  let showingRecent = false;
  function showRecent(): void {
    const recent = loadRecent();
    showingRecent = true;
    hits = recent.map((r) => ({ chain: r.chain, address: r.address, symbol: r.symbol, name: r.name, icon: r.icon, decimals: null, liquidityUsd: null, priceUsd: null, fresh: false, risk: null }));
    active = -1;
    paint(hits.length > 0 ? 'Recently viewed' : 'Tokens you open show here, so you can go back to them in one tap.');
  }

  async function run(q: string): Promise<void> {
    showingRecent = false;
    controller?.abort();
    controller = new AbortController();
    const mine = ++seq;
    paint('Searching…');
    try {
      let found = await searchTokens(q, undefined, controller.signal);
      // A token made a minute ago is on the chain but in no index yet: a pasted address is read from the chain itself.
      if (found.length === 0) found = await lookupAddress(q, controller.signal);
      if (mine !== seq) return;
      hits = found;
      active = hits.length > 0 ? 0 : -1;
      if (openFirst && hits.length > 0) return choose(hits[0]!);
      openFirst = false;
      paint(hits.length === 0 ? 'No tokens found. Names are not unique: paste the contract address to be sure.' : undefined);
    } catch {
      if (mine !== seq) return;
      hits = [];
      paint('The search could not be reached. Try again in a moment.');
    }
  }

  /** Searches now, without the typing pause; with `open`, the first result opens as soon as it is found. */
  const searchNow = (open: boolean): void => {
    clearTimeout(timer);
    const q = input.value.trim();
    if (q.length < 2) return;
    openFirst = open;
    void run(q);
  };
  paste.addEventListener('mousedown', (e) => e.preventDefault());
  paste.addEventListener('click', async () => {
    let text = '';
    try {
      text = (await navigator.clipboard.readText()).trim();
    } catch {
      // The phone did not let the page read the clipboard: the box is focused so a long press offers its own Paste.
    }
    input.focus();
    if (!text) {
      hits = [];
      paint('Nothing to paste was found. Press and hold in the box, then choose Paste.');
      return;
    }
    input.value = text.slice(0, 200);
    syncPaste();
    // A full contract address opens its token straight away; anything else shows the results.
    searchNow(/^(0x[0-9a-fA-F]{40}|[1-9A-HJ-NP-Za-km-z]{32,44})$/.test(input.value));
  });

  input.addEventListener('input', () => {
    clearTimeout(timer);
    syncPaste();
    openFirst = false;
    const q = input.value.trim();
    if (q.length < 2) {
      seq++;
      controller?.abort();
      hits = [];
      if (q === '') showRecent();
      else close();
      return;
    }
    timer = setTimeout(() => void run(q), 250);
  });
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') return close();
    // Enter searches at once (no waiting for the typing pause) and opens the first token found.
    if (e.key === 'Enter' && (hits.length === 0 || list.querySelector('.wapp-search__note'))) {
      e.preventDefault();
      searchNow(true);
      return;
    }
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
  // The round search button on phones opens the list itself too (the box may already have had focus, so no focus event comes).
  input.addEventListener('wapp-search-open', () => {
    if (input.value.trim() === '') showRecent();
  });
  input.addEventListener('focus', () => {
    if (input.value.trim() === '') showRecent();
    else if (hits.length > 0) paint();
  });
  document.addEventListener('click', (e) => {
    if (!wrap.contains(e.target as Node)) close();
  });
}
