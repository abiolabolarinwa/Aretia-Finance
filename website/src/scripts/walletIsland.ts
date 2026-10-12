/**
 * The "island": a dark pill in the wallet's top bar, in the middle beside the search box, that shows tokens Aretia has just
 * detected. Closed, it names one token at a time and cycles through the latest. Opened (by hovering or pressing it), it shows
 * the token's name, network, price, liquidity and market cap, Aretia's rating, and a Buy button. When a token appears that
 * was not there a moment ago it opens by itself for a few seconds.
 *
 * It only reads Aretia's registry and shows it. Buying opens the same swap the Markets page opens, where the person reviews
 * and confirms; nothing is bought from here. New tokens are risky, and the island says so.
 */
import { CHAINS, type ChainId } from '../swings/core/types.js';
import { compactUsd, formatAge, formatPrice } from '../swings/market/types.js';

export interface IslandToken {
  /** `chain:address`, the same token has the same key every time. */
  key: string;
  chain: ChainId;
  address: string;
  symbol: string;
  name: string;
  icon: string | null;
  priceUsd: number | null;
  liquidityUsd: number | null;
  capUsd: number | null;
  ageMs: number | null;
  /** Aretia's rating word ("New", "Unverified", "Elevated risk"), or null when it has none. */
  rating: string | null;
}

export interface IslandDeps {
  /** The newest tokens, newest first. */
  load(): Promise<IslandToken[]>;
  /** Opens the swap for a token, or null when swaps on its network are not open. */
  buy(t: IslandToken): (() => void) | null;
  /** Opens the token's chart and details. */
  view(t: IslandToken): void;
}

const SEEN_KEY = 'aretia-island-seen-v1';
const POLL_MS = 45_000;
const CYCLE_MS = 4_500;
const ANNOUNCE_MS = 7_000;
export const ISLAND_MAX = 12;

/** The tokens in `tokens` that are not in `seen`, in their order. Pure. */
export function pickArrivals(tokens: readonly IslandToken[], seen: ReadonlySet<string>): IslandToken[] {
  return tokens.filter((t) => !seen.has(t.key));
}

/** Keeps the newest `max`, each token once, newest first. Pure. */
export function mergeTokens(fresh: readonly IslandToken[], current: readonly IslandToken[], max = ISLAND_MAX): IslandToken[] {
  const out: IslandToken[] = [];
  const have = new Set<string>();
  for (const t of [...fresh, ...current]) {
    if (have.has(t.key)) continue;
    have.add(t.key);
    out.push(t);
    if (out.length >= max) break;
  }
  return out;
}

function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls = '', text?: string): HTMLElementTagNameMap[K] {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text !== undefined) n.textContent = text;
  return n;
}

function logo(t: IslandToken, cls: string): HTMLElement {
  const letters = el('span', `${cls} wapp-island__letters`, t.symbol.slice(0, 2).toUpperCase());
  if (!t.icon || !/^https:\/\//.test(t.icon)) return letters;
  const img = el('img', cls);
  img.alt = '';
  img.referrerPolicy = 'no-referrer';
  img.src = t.icon;
  img.addEventListener('error', () => img.replaceWith(letters), { once: true });
  return img;
}

function loadSeen(): Set<string> {
  try {
    const v: unknown = JSON.parse(sessionStorage.getItem(SEEN_KEY) ?? '[]');
    return new Set(Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []);
  } catch {
    return new Set();
  }
}

function saveSeen(seen: Set<string>): void {
  try {
    sessionStorage.setItem(SEEN_KEY, JSON.stringify([...seen].slice(-200)));
  } catch {
    // not remembered: the island still works
  }
}

export function mountIsland(deps: IslandDeps): void {
  if (document.querySelector('[data-wapp-island]')) return;
  const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  const root = el('div', 'wapp-island');
  root.setAttribute('data-wapp-island', '');
  const body = el('div', 'wapp-island__body');
  const head = el('button', 'wapp-island__head');
  head.type = 'button';
  head.setAttribute('aria-expanded', 'false');
  head.setAttribute('aria-controls', 'wapp-island-more');
  const more = el('div', 'wapp-island__more');
  more.id = 'wapp-island-more';
  more.setAttribute('role', 'region');
  more.setAttribute('aria-label', 'Newly detected tokens');
  const inner = el('div', 'wapp-island__inner');
  more.append(inner);
  body.append(head, more);
  root.append(body);

  let tokens: IslandToken[] = [];
  let index = 0;
  let open = false;
  let pinned = false;
  let announceTimer: ReturnType<typeof setTimeout> | undefined;
  const seen = loadSeen();
  let first = true;

  const current = (): IslandToken | null => tokens[index] ?? null;

  function drawHead(): void {
    head.replaceChildren();
    const t = current();
    head.append(el('span', 'wapp-island__dot'));
    if (!t) {
      head.append(el('span', 'wapp-island__idle', 'Watching for new tokens'));
      return;
    }
    const chain = el('img', 'wapp-island__chain');
    chain.alt = '';
    chain.src = `/assets/chains/${t.chain}.png`;
    chain.width = 14;
    chain.height = 14;
    const label = el('span', 'wapp-island__label');
    label.append(el('strong', '', t.symbol), el('span', 'wapp-island__price', formatPrice(t.priceUsd)));
    head.append(logo(t, 'wapp-island__pic'), label, chain, el('span', 'wapp-island__chev'));
    head.setAttribute('aria-label', `New token ${t.symbol} on ${CHAINS[t.chain].name}, ${formatPrice(t.priceUsd)}. ${open ? 'Close' : 'Open'} details.`);
  }

  function stat(label: string, value: string): HTMLElement {
    const d = el('div', 'wapp-island__stat');
    d.append(el('span', '', label), el('strong', '', value));
    return d;
  }

  function drawMore(): void {
    inner.replaceChildren();
    const t = current();
    if (!t) {
      inner.append(el('p', 'wapp-island__note', 'Aretia is watching every network. When a new token appears with a trading pool, it shows up here.'));
      return;
    }
    const top = el('div', 'wapp-island__top');
    const names = el('div', 'wapp-island__names');
    names.append(el('strong', '', t.name || t.symbol));
    const sub = el('span', 'wapp-island__sub');
    sub.append(`${t.symbol} · ${CHAINS[t.chain].name}${t.ageMs !== null ? ` · ${formatAge(t.ageMs)} old` : ''}`);
    names.append(sub);
    top.append(logo(t, 'wapp-island__big'), names);
    if (t.rating) top.append(el('span', 'wapp-island__rating', t.rating));
    inner.append(top);

    const stats = el('div', 'wapp-island__stats');
    stats.append(stat('Price', formatPrice(t.priceUsd)), stat('Liquidity', compactUsd(t.liquidityUsd)), stat('Market cap', compactUsd(t.capUsd)));
    inner.append(stats);

    const actions = el('div', 'wapp-island__actions');
    const go = deps.buy(t);
    if (go) {
      const buy = el('button', 'wapp-island__buy', `Buy ${t.symbol}`);
      buy.type = 'button';
      buy.addEventListener('click', go);
      actions.append(buy);
    } else actions.append(el('span', 'wapp-island__closed', `Swaps are not open on ${CHAINS[t.chain].name} yet`));
    const view = el('button', 'wapp-island__view', 'Chart');
    view.type = 'button';
    view.addEventListener('click', () => deps.view(t));
    actions.append(view);
    inner.append(actions);

    const foot = el('div', 'wapp-island__foot');
    foot.append(el('span', '', 'New tokens are risky. Aretia checks them but cannot vouch for them.'));
    if (tokens.length > 1) {
      const pager = el('span', 'wapp-island__pager');
      const prev = el('button', 'wapp-island__step', '‹');
      prev.type = 'button';
      prev.setAttribute('aria-label', 'Previous token');
      prev.addEventListener('click', () => step(-1, true));
      const next = el('button', 'wapp-island__step', '›');
      next.type = 'button';
      next.setAttribute('aria-label', 'Next token');
      next.addEventListener('click', () => step(1, true));
      pager.append(prev, el('span', '', `${index + 1}/${tokens.length}`), next);
      foot.append(pager);
    }
    inner.append(foot);
  }

  function draw(): void {
    drawHead();
    drawMore();
  }

  function setOpen(next: boolean): void {
    open = next;
    root.classList.toggle('is-open', open);
    head.setAttribute('aria-expanded', String(open));
    drawHead();
  }

  function step(by: number, manual = false): void {
    if (tokens.length === 0) return;
    index = (index + by + tokens.length) % tokens.length;
    if (manual) pinned = true;
    if (!reduce) {
      head.classList.remove('is-swap');
      void head.offsetWidth;
      head.classList.add('is-swap');
    }
    draw();
  }

  head.addEventListener('click', () => {
    pinned = !open;
    clearTimeout(announceTimer);
    setOpen(!open);
  });
  root.addEventListener('pointerenter', () => {
    if (window.matchMedia('(hover: hover)').matches) {
      clearTimeout(announceTimer);
      setOpen(true);
    }
  });
  root.addEventListener('pointerleave', () => {
    if (!pinned) setOpen(false);
  });
  document.addEventListener('pointerdown', (e) => {
    if (open && !root.contains(e.target as Node)) {
      pinned = false;
      setOpen(false);
    }
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && open) {
      pinned = false;
      setOpen(false);
      head.focus();
    }
  });

  // Closed, the pill moves through the latest tokens by itself; it stops while it is open or hovered.
  setInterval(() => {
    if (!open && !document.hidden && tokens.length > 1) step(1);
  }, CYCLE_MS);

  async function poll(): Promise<void> {
    if (document.hidden) return;
    let got: IslandToken[];
    try {
      got = await deps.load();
    } catch {
      return;
    }
    const arrivals = pickArrivals(got, seen);
    for (const t of got) seen.add(t.key);
    saveSeen(seen);
    const showing = current()?.key;
    tokens = mergeTokens(got, tokens);
    index = Math.max(0, tokens.findIndex((t) => t.key === showing));
    // The first look only fills the pill; tokens that arrive after that open it for a few seconds.
    if (!first && arrivals.length > 0 && !pinned) {
      index = Math.max(0, tokens.findIndex((t) => t.key === arrivals[0]!.key));
      root.classList.remove('is-ping');
      void root.offsetWidth;
      root.classList.add('is-ping');
      setOpen(true);
      clearTimeout(announceTimer);
      announceTimer = setTimeout(() => {
        if (!pinned) setOpen(false);
      }, ANNOUNCE_MS);
    }
    first = false;
    draw();
  }

  // On a wide screen the island sits in the site bar, in the middle after the search box; on a narrow one, under the search box.
  const place = (): void => {
    const bar = document.querySelector<HTMLElement>('header.nav .nav__bar');
    const search = document.querySelector<HTMLElement>('[data-wapp-search]');
    const home = document.querySelector<HTMLElement>('.wapp__top');
    const wide = window.matchMedia('(min-width: 1081px)').matches;
    const tabs = bar?.querySelector<HTMLElement>(':scope > .wapp__seg--tabs') ?? null;
    if (wide && bar && search?.parentElement === bar) (tabs ?? search).after(root);
    else if (home) home.append(root);
  };
  window.matchMedia('(min-width: 1081px)').addEventListener('change', place);
  place();
  // The search box and the tabs are put in the bar by other scripts; look again once they have.
  setTimeout(place, 600);
  setTimeout(place, 2_000);

  draw();
  void poll();
  setInterval(() => void poll(), POLL_MS);
}
