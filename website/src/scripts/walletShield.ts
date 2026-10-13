/**
 * The Shield page of the wallet: "know before you sign". Three tabs.
 *  - Check: paste an address, a token, a contract or a link and get a colour verdict with the reasons, what could not be checked,
 *    and ways to act on it or share it.
 *  - My wallet: scan the connected wallet for risky tokens and permissions, with one-tap fixes (revoke, reclaim) signed by the
 *    person's own wallet, and an approvals scan for Ethereum-style addresses.
 *  - Watching: tokens and addresses Shield re-checks while the page is open, ringing the bell only when something gets worse,
 *    plus the addresses the person saved or sent to.
 * Everything a third party says is shown with textContent, never as markup.
 */
import { CHAINS, type ChainId } from '../swings/core/types.js';
import { isFeeAsset } from '../swings/core/feeAssets.js';
import { browserStorage } from '../swings/history.js';
import { isChainEnabled } from '../swings/runtime.js';
import { DexScreenerPoolFinder } from '../swings/charts/dexscreener.js';
import { publicRead } from '../swings/chains/evmSession.js';
import { assessTokenSafety } from '../swings/live.js';
import { bandOf } from '../swings/market/rowRisk.js';
import { RISK_LABELS } from '../swings/tokens/risk.js';
import { checkToken, runCheck } from '../swings/shield/check.js';
import { checkHash, classifyInput, valueFromHash } from '../swings/shield/classify.js';
import { searchTokens } from '../swings/tokens/globalSearch.js';
import { analyseWallet, readTokenAccounts, type HealthItem, type HealthReport, type HeldTokenCheck, type TokenAccount } from '../swings/shield/health.js';
import { describeApprovals, readApprovals, type Approval, type ApprovalFinding } from '../swings/shield/approvals.js';
import { liveDeps, solRead } from '../swings/shield/liveDeps.js';
import { AddressBook, cleanLabel } from '../swings/shield/addressBook.js';
import { fingerprintOf, WatchStore, worsened } from '../swings/shield/watch.js';
import { bandWord, shareLink, shareText } from '../swings/shield/verdict.js';
import type { Band, Finding, Severity, Verdict } from '../swings/shield/types.js';
import { notify } from './walletNotifications.js';
import { KNOWN_TOKENS } from './walletTools.js';
import { OPEN_TOKEN_EVENT } from './walletSearch.js';
import { SHOW_MARKET_EVENT } from './walletNotifications.js';
import { reclaim, revoke } from './walletShieldTx.js';
import { renderShareCard } from './walletShieldCard.js';
import type { SearchHit } from '../swings/tokens/globalSearch.js';

export interface ShieldHost {
  /** The connected Solana wallet, or null. */
  getAddress(): string | null;
  getHoldings(): { mint: string; symbol: string; value: number | null; amount: number }[] | null;
  /** The connected Ethereum-style account, or null. */
  evmAccount(): string | null;
  /** Takes back a token permission through the connected Ethereum-style wallet. Resolves to the transaction hash. */
  revokeEvm(chain: ChainId, token: string, spender: string): Promise<string>;
  refreshWallet(): void;
}

type Tab = 'check' | 'wallet' | 'watch';

function h<K extends keyof HTMLElementTagNameMap>(tag: K, cls = '', text?: string): HTMLElementTagNameMap[K] {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text !== undefined) n.textContent = text;
  return n;
}

const ICON = {
  ok: '<svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true"><circle cx="12" cy="12" r="9"/><path d="M8 12.5l2.7 2.7L16 9.5"/></svg>',
  warn: '<svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true"><path d="M12 4l9 16H3z"/><path d="M12 10v4.5M12 17.5v.01"/></svg>',
  note: '<svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true"><circle cx="12" cy="12" r="9"/><path d="M12 7.5v5M12 16v.01"/></svg>',
  info: '<svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true"><circle cx="12" cy="12" r="9"/><path d="M12 11v5M12 8v.01"/></svg>',
  shield: '<svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true"><path d="M12 3l8 3v6c0 4.5-3.2 7.8-8 9-4.8-1.2-8-4.5-8-9V6z"/></svg>',
};
const GLYPH: Record<Severity, string> = { bad: ICON.warn, warn: ICON.warn, note: ICON.note, ok: ICON.ok, info: ICON.info };
const SEVERITY_WORD: Record<Severity, string> = { bad: 'Problem', warn: 'Caution', note: 'Note', ok: 'Passed', info: 'Context' };

const short = (v: string): string => (v.length > 16 ? `${v.slice(0, 6)}…${v.slice(-6)}` : v);
const ago = (t: number | null): string => {
  if (t === null) return 'not yet';
  const m = Math.round((Date.now() - t) / 60_000);
  return m < 1 ? 'just now' : m < 60 ? `${m} min ago` : m < 1440 ? `${Math.round(m / 60)} h ago` : `${Math.round(m / 1440)} d ago`;
};
const KIND_WORD: Record<string, string> = {
  'solana-wallet': 'Solana wallet',
  'solana-program': 'Solana program',
  'solana-token': 'Solana token',
  'solana-token-account': 'Solana token account',
  'evm-wallet': 'Ethereum-style wallet',
  'evm-contract': 'Smart contract',
  'evm-token': 'Token',
  site: 'Link',
  unknown: 'Not recognised',
};

const RECENT_KEY = 'aretia-shield-recent-v1';

export function initShield(host: ShieldHost): { onShow(hash: string): void; onWalletChange(): void; book(): AddressBook } {
  const root = document.querySelector<HTMLElement>('[data-shield-root]');
  const storage = browserStorage();
  const watchStore = new WatchStore(storage);
  const finder = new DexScreenerPoolFinder();
  const owner = (): string | null => host.getAddress() ?? host.evmAccount();
  const book = (): AddressBook => new AddressBook(storage, owner());
  const deps = () => liveDeps({ own: host.getAddress() ?? host.evmAccount(), known: book().list() });

  // ---- the watcher: runs whatever page is open, while the browser tab is showing
  let watching = false;
  async function watchTick(): Promise<void> {
    if (watching || document.hidden) return;
    const due = watchStore.list().filter((w) => w.checkedAt === null || Date.now() - w.checkedAt > 15 * 60_000).slice(0, 2);
    if (due.length === 0) return;
    watching = true;
    try {
      for (const item of due) {
        const v = await runCheck(item.value, deps()).catch(() => null);
        if (!v || v.band === 'grey') continue;
        const change = worsened(item.last, fingerprintOf(v), v);
        watchStore.record(item.value, v);
        if (change) notify({ title: change.title, detail: change.detail, tone: change.tone, icon: v.subject.icon });
      }
      if (tab === 'watch' && root) renderWatch();
    } finally {
      watching = false;
    }
  }
  setTimeout(() => void watchTick(), 20_000);
  setInterval(() => void watchTick(), 60_000);

  if (!root) return { onShow() {}, onWalletChange() {}, book };

  // ---- the shell
  let tab: Tab = 'check';
  let current: { input: string; verdict: Verdict } | null = null;
  let checking = false;
  const panels: Record<Tab, HTMLElement> = { check: h('div', 'wapp-sh__panel'), wallet: h('div', 'wapp-sh__panel'), watch: h('div', 'wapp-sh__panel') };
  const tabButtons = new Map<Tab, HTMLButtonElement>();
  const input = h('input', 'wapp__input wapp-sh__input');
  const go = h('button', 'wapp__btn wapp-sh__go', 'Check');

  const hero = h('section', 'wapp-sh__hero');
  const heroText = h('div', 'wapp-sh__herotext');
  heroText.append(h('span', 'wapp-sh__kicker', 'Aretia Shield'), h('h2', 'wapp-sh__title', 'Know before you sign.'), h('p', 'wapp-sh__lede', 'Type a token\u2019s name, or paste an address, a contract or a link. Shield reads the public record and tells you what it found, as a colour you can act on.'));
  const form = h('form', 'wapp-sh__form');
  input.type = 'text';
  input.placeholder = 'Search a token by name, or paste an address, contract or link';
  input.autocomplete = 'off';
  input.spellcheck = false;
  input.setAttribute('aria-label', 'Address, token, contract or link to check');
  go.type = 'submit';
  const paste = h('button', 'wapp-sh__ghost', 'Paste');
  paste.type = 'button';
  paste.title = 'Paste what you copied';
  paste.addEventListener('click', async () => {
    try {
      const t = (await navigator.clipboard.readText()).trim();
      if (t) {
        input.value = t;
        void check(t);
      }
    } catch {
      input.focus();
    }
  });
  // The box is also a search: type a token's name and pick it from the list.
  const field = h('div', 'wapp-sh__field');
  const suggest = h('ul', 'wapp-sh__suggest');
  suggest.setAttribute('data-lenis-prevent', '');
  suggest.id = 'wapp-sh-suggest';
  suggest.setAttribute('role', 'listbox');
  suggest.hidden = true;
  input.setAttribute('role', 'combobox');
  input.setAttribute('aria-autocomplete', 'list');
  input.setAttribute('aria-controls', suggest.id);
  input.setAttribute('aria-expanded', 'false');
  field.append(input, suggest);
  form.append(field, paste, go);
  const chips = h('div', 'wapp-sh__chips');
  hero.append(heroText, form, chips);

  const tabs = h('div', 'wapp-sh__tabs');
  tabs.setAttribute('role', 'tablist');
  for (const [id, label] of [['check', 'Check'], ['wallet', 'My wallet'], ['watch', 'Watching']] as const) {
    const b = h('button', 'wapp-sh__tab');
    b.type = 'button';
    b.setAttribute('role', 'tab');
    b.dataset.tab = id;
    b.textContent = label;
    b.addEventListener('click', () => show(id));
    tabButtons.set(id, b);
    tabs.append(b);
  }
  const foot = h('p', 'wapp-sh__foot', 'Shield reads public data and is not advice. It never says something is safe: green means no problems were found in what it could check, and every result lists what it could not.');
  root.replaceChildren(hero, tabs, panels.check, panels.wallet, panels.watch, foot);

  function show(next: Tab): void {
    tab = next;
    for (const [id, b] of tabButtons) {
      b.setAttribute('aria-selected', String(id === next));
      panels[id].hidden = id !== next;
    }
    const count = watchStore.list().length;
    tabButtons.get('watch')!.textContent = count > 0 ? `Watching (${count})` : 'Watching';
    hero.hidden = next !== 'check';
    if (next === 'check') renderCheck();
    if (next === 'wallet') renderWallet();
    if (next === 'watch') renderWatch();
  }

  // ---- recent checks, as chips
  function recent(): string[] {
    try {
      const v: unknown = JSON.parse(storage?.getItem(RECENT_KEY) ?? '[]');
      return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string').slice(0, 6) : [];
    } catch {
      return [];
    }
  }
  function remember(text: string): void {
    try {
      storage?.setItem(RECENT_KEY, JSON.stringify([text, ...recent().filter((r) => r !== text)].slice(0, 6)));
    } catch {
      // not remembered
    }
  }
  function drawChips(): void {
    chips.replaceChildren();
    const add = (label: string, text: string, title?: string): void => {
      const b = h('button', 'wapp-sh__chip', label);
      b.type = 'button';
      if (title) b.title = title;
      b.addEventListener('click', () => {
        input.value = text;
        void check(text);
      });
      chips.append(b);
    };
    const mine = host.getAddress();
    if (mine) add('My wallet', mine, 'Check the wallet you have connected');
    for (const r of recent()) add(r.length > 18 ? `${r.slice(0, 7)}…${r.slice(-5)}` : r, r, r);
    if (chips.children.length === 0) {
      chips.append(h('span', 'wapp-sh__chiphint', 'Try:'));
      add('a look-alike link', 'phantom-app.xyz/claim');
      add('USDC on Solana', 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v');
    }
  }

  // ---- the Check tab
  // ---- type-ahead: a name that is not an address, a link or a name service entry is searched for as a token
  let hits: SearchHit[] = [];
  let active = -1;
  let searchTimer: ReturnType<typeof setTimeout> | undefined;
  let searchSeq = 0;
  const wantsSearch = (text: string): boolean => {
    const t = text.trim();
    return t.length >= 2 && classifyInput(t).kind === 'unknown' && !/^0x[0-9a-f]*$/i.test(t) && !/\s{2,}/.test(t);
  };
  const closeSuggest = (): void => {
    suggest.hidden = true;
    suggest.replaceChildren();
    input.setAttribute('aria-expanded', 'false');
    input.removeAttribute('aria-activedescendant');
    hits = [];
    active = -1;
  };
  const usd = (n: number | null): string => (n === null ? '' : n >= 1e6 ? `$${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `$${Math.round(n / 1e3)}K` : `$${Math.round(n)}`);
  function suggestNote(text: string): void {
    suggest.replaceChildren(h('li', 'wapp-sh__note', text));
    suggest.hidden = false;
    input.setAttribute('aria-expanded', 'true');
  }
  function drawSuggest(): void {
    suggest.replaceChildren();
    hits.forEach((hit, i) => {
      const li = h('li', 'wapp-sh__sug');
      li.id = `wapp-sh-sug-${i}`;
      li.setAttribute('role', 'option');
      li.setAttribute('aria-selected', String(i === active));
      const pic = h('span', 'wapp-sh__sugpic', hit.symbol.slice(0, 2).toUpperCase());
      if (hit.icon && /^https:\/\//.test(hit.icon)) {
        const img = h('img');
        img.alt = '';
        img.loading = 'lazy';
        img.referrerPolicy = 'no-referrer';
        img.src = hit.icon;
        img.addEventListener('error', () => img.remove(), { once: true });
        pic.textContent = '';
        pic.append(img);
      }
      const text = h('span', 'wapp-sh__sugtext');
      text.append(h('strong', '', hit.symbol), h('small', '', hit.name));
      const meta = h('span', 'wapp-sh__sugmeta');
      meta.append(h('span', 'wapp-sh__sugchain', CHAINS[hit.chain].name));
      if (hit.liquidityUsd !== null) meta.append(h('small', '', `${usd(hit.liquidityUsd)} liquidity`));
      li.append(pic, text, meta);
      // mousedown, not click: the box must not lose focus (and close the list) before the choice is read.
      li.addEventListener('mousedown', (e) => {
        e.preventDefault();
        void pickHit(hit);
      });
      suggest.append(li);
    });
    suggest.hidden = hits.length === 0;
    input.setAttribute('aria-expanded', String(hits.length > 0));
    if (active >= 0) input.setAttribute('aria-activedescendant', `wapp-sh-sug-${active}`);
  }
  async function search(text: string): Promise<void> {
    const mine = ++searchSeq;
    suggestNote('Searching…');
    let found: SearchHit[];
    try {
      found = await searchTokens(text);
    } catch {
      found = [];
    }
    if (mine !== searchSeq || input.value.trim() !== text.trim()) return;
    hits = found.slice(0, 8);
    active = -1;
    if (hits.length === 0) suggestNote('No token found by that name. Names are not unique, so paste the address if you have it.');
    else drawSuggest();
  }
  async function pickHit(hit: SearchHit): Promise<void> {
    closeSuggest();
    input.value = hit.symbol;
    await check(hit.address, () => checkToken(hit.chain, hit.address, deps()));
  }
  input.addEventListener('input', () => {
    clearTimeout(searchTimer);
    if (!wantsSearch(input.value)) {
      searchSeq++;
      closeSuggest();
      return;
    }
    suggestNote('Searching…');
    searchTimer = setTimeout(() => void search(input.value.trim()), 280);
  });
  input.addEventListener('keydown', (e) => {
    if (suggest.hidden || hits.length === 0) {
      if (e.key === 'Escape') closeSuggest();
      return;
    }
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      active = (active + (e.key === 'ArrowDown' ? 1 : -1) + hits.length) % hits.length;
      drawSuggest();
    } else if (e.key === 'Escape') closeSuggest();
    else if (e.key === 'Enter' && active >= 0) {
      e.preventDefault();
      void pickHit(hits[active]!);
    }
  });
  input.addEventListener('blur', () => setTimeout(closeSuggest, 120));

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    clearTimeout(searchTimer);
    const text = input.value.trim();
    // A name, not an address: take the best match, searching now if the list has not come back yet.
    if (wantsSearch(text)) {
      if (hits.length === 0) await search(text);
      if (hits.length > 0) return void pickHit(hits[Math.max(active, 0)]!);
      return;
    }
    closeSuggest();
    void check(text);
  });

  async function check(text: string, run?: () => Promise<Verdict>): Promise<void> {
    const t = text.trim();
    if (!t || checking) return;
    checking = true;
    input.value = t;
    go.disabled = true;
    current = null;
    show('check');
    panels.check.replaceChildren(skeleton());
    try {
      const verdict = await (run ? run() : runCheck(t, deps()));
      current = { input: t, verdict };
      remember(t);
      history.replaceState(null, '', checkHash(t));
    } catch {
      current = null;
      panels.check.replaceChildren(h('p', 'wapp__fine', 'Shield could not complete that check. Try again in a moment.'));
    } finally {
      checking = false;
      go.disabled = false;
    }
    drawChips();
    renderCheck();
  }

  function skeleton(): HTMLElement {
    const box = h('div', 'wapp-sh__card wapp-sh__loading');
    box.setAttribute('role', 'status');
    box.append(h('div', 'wapp-sh__bar wapp-sh__bar--grey'), h('p', 'wapp__fine', 'Reading the public record…'));
    return box;
  }

  function renderCheck(): void {
    const p = panels.check;
    if (checking) return;
    if (!current) {
      p.replaceChildren(intro());
      return;
    }
    p.replaceChildren(verdictCard(current.input, current.verdict));
  }

  function intro(): HTMLElement {
    const box = h('div', 'wapp-sh__intro');
    const items: [string, string][] = [
      ['Addresses', 'Is it a person or a program? How old, how busy? Does it copy an address you use? Solana and eight Ethereum-style networks.'],
      ['Tokens', 'Aretia’s rating, the market, and whether the liquidity is locked: the same engine as the Markets list.'],
      ['Links', 'Fake versions of sites you trust, hidden destinations and brand-new domains.'],
    ];
    for (const [title, body] of items) {
      const c = h('div', 'wapp-sh__introcard');
      c.append(h('strong', '', title), h('span', '', body));
      box.append(c);
    }
    return box;
  }

  function bandBadge(b: Band): HTMLElement {
    const s = h('span', `wapp-sh__dot wapp-sh__dot--${b}`);
    s.setAttribute('aria-hidden', 'true');
    return s;
  }

  function findingRow(f: Finding): HTMLElement {
    const li = h('li', `wapp-sh__finding wapp-sh__finding--${f.severity}`);
    const ic = h('span', 'wapp-sh__glyph');
    ic.innerHTML = GLYPH[f.severity];
    const text = h('div', 'wapp-sh__ftext');
    const t = h('strong', '', f.title);
    const tag = h('span', 'wapp-sh__ftag', SEVERITY_WORD[f.severity]);
    text.append(t, h('span', 'wapp-sh__fdetail', f.detail));
    li.append(ic, text, tag);
    return li;
  }

  function copyButton(label: string, text: () => string): HTMLButtonElement {
    const b = h('button', 'wapp-sh__action', label);
    b.type = 'button';
    b.addEventListener('click', async () => {
      try {
        await navigator.clipboard.writeText(text());
        b.textContent = 'Copied';
      } catch {
        b.textContent = 'Could not copy';
      }
      setTimeout(() => (b.textContent = label), 1600);
    });
    return b;
  }

  function verdictCard(inputText: string, v: Verdict): HTMLElement {
    const card = h('article', `wapp-sh__card wapp-sh__verdict wapp-sh__verdict--${v.band}`);
    card.setAttribute('aria-live', 'polite');

    // The colour band: the answer first.
    const bar = h('header', `wapp-sh__bar wapp-sh__bar--${v.band}`);
    const word = h('span', 'wapp-sh__bandword', bandWord(v.band));
    const headline = h('p', 'wapp-sh__headline', v.headline);
    bar.append(word, headline);
    card.append(bar);

    // Who or what was checked.
    const who = h('div', 'wapp-sh__who');
    const avatar = h('span', 'wapp-sh__avatar');
    if (v.subject.icon && /^https:\/\//.test(v.subject.icon)) {
      const img = h('img');
      img.alt = '';
      img.referrerPolicy = 'no-referrer';
      img.src = v.subject.icon;
      img.addEventListener('error', () => (avatar.textContent = (v.subject.label ?? '?').slice(0, 2).toUpperCase()), { once: true });
      avatar.append(img);
    } else avatar.textContent = (v.subject.label ?? v.subject.value).replace(/^https?:\/\//, '').slice(0, 2).toUpperCase();
    const names = h('div', 'wapp-sh__names');
    const title = h('strong', '', v.subject.label ?? short(v.subject.value));
    names.append(title);
    const sub = h('span', 'wapp-sh__sub');
    sub.append(h('span', 'wapp-sh__kind', `${KIND_WORD[v.subject.kind] ?? 'Address'}${v.subject.chain ? ` · ${CHAINS[v.subject.chain].name}` : ''}`));
    if (v.ratingLabel) sub.append(h('span', `wapp__state wapp__state--${bandOf(RATING_TO_STATUS[v.ratingLabel] ?? '')}`, v.ratingLabel));
    names.append(sub, h('code', 'wapp-sh__value', v.subject.value));
    who.append(avatar, names, ...v.links.slice(0, 2).map((l) => {
      const a = h('a', 'wapp-sh__link', l.label);
      a.href = l.url;
      a.target = '_blank';
      a.rel = 'noopener noreferrer';
      // The chart opens in Aretia's own Markets page (chart and details), not on another site; the link stays as the fallback.
      const subject = v.subject;
      if (l.inApp === 'chart' && (subject.kind === 'solana-token' || subject.kind === 'evm-token') && subject.chain) {
        const chain = subject.chain;
        a.addEventListener('click', (e) => {
          e.preventDefault();
          window.dispatchEvent(new CustomEvent(SHOW_MARKET_EVENT, { detail: { chain, address: subject.value, symbol: subject.label ?? short(subject.value), name: subject.name ?? subject.label ?? '', icon: subject.icon, page: 'swings' } }));
        });
      }
      return a;
    }));
    card.append(who);

    if (v.facts.length > 0) {
      const dl = h('dl', 'wapp-sh__facts');
      for (const f of v.facts) {
        const d = h('div');
        d.append(h('dt', '', f.label), h('dd', '', f.value));
        dl.append(d);
      }
      card.append(dl);
    }

    const list = h('ul', 'wapp-sh__findings');
    for (const f of v.findings) list.append(findingRow(f));
    card.append(list);

    const cannot = h('details', 'wapp-sh__cannot');
    cannot.append(h('summary', '', `What Shield could not check (${v.couldNot.length})`));
    const cl = h('ul');
    for (const c of v.couldNot) cl.append(h('li', '', c));
    cannot.append(cl);
    card.append(cannot);

    card.append(actions(inputText, v));
    card.append(h('p', 'wapp-sh__stamp', `Read live ${new Date(v.checkedAt).toLocaleTimeString()}. A reading of public data, not advice.`));
    return card;
  }

  const RATING_TO_STATUS: Record<string, string> = Object.fromEntries(Object.entries(RISK_LABELS).map(([k, label]) => [label, k]));

  function actions(inputText: string, v: Verdict): HTMLElement {
    const row = h('div', 'wapp-sh__actions');
    const s = v.subject;

    // Swap into a token, when it can be done here.
    if ((s.kind === 'solana-token' || s.kind === 'evm-token') && s.chain && typeof s.decimals === 'number' && isChainEnabled(s.chain)) {
      const swap = h('button', 'wapp-sh__action wapp-sh__action--primary', `Swap into ${s.label ?? 'this token'}`);
      swap.type = 'button';
      swap.addEventListener('click', () => {
        const detail: SearchHit = { chain: s.chain!, address: s.value, symbol: s.label ?? '', name: s.name ?? s.label ?? '', icon: s.icon, decimals: s.decimals ?? null, liquidityUsd: null, priceUsd: null, fresh: false, risk: null };
        window.dispatchEvent(new CustomEvent(OPEN_TOKEN_EVENT, { detail }));
      });
      row.append(swap);
    }

    // Watch.
    const watchBtn = h('button', 'wapp-sh__action');
    watchBtn.type = 'button';
    const setWatch = (): void => {
      watchBtn.textContent = watchStore.has(inputText) ? 'Watching: tell me if it gets worse' : 'Watch this';
      watchBtn.setAttribute('aria-pressed', String(watchStore.has(inputText)));
    };
    setWatch();
    watchBtn.addEventListener('click', () => {
      if (watchStore.has(inputText)) watchStore.remove(inputText);
      else if (!watchStore.add(inputText, s.label, v)) watchBtn.textContent = 'Watchlist is full';
      setWatch();
      show('check');
    });
    if (s.kind !== 'unknown') row.append(watchBtn);

    // Save an address you trust, so a copy-cat of it is caught.
    if (s.kind === 'solana-wallet' || s.kind === 'evm-wallet') {
      const b = book();
      const saved = b.find(s.value);
      if (owner()) {
        const save = h('button', 'wapp-sh__action', saved?.trusted ? 'Saved: remove' : 'Save as trusted');
        save.type = 'button';
        save.addEventListener('click', () => {
          if (saved?.trusted) {
            b.remove(s.value);
            renderCheck();
            return;
          }
          const name = h('input', 'wapp__input wapp-sh__name');
          name.placeholder = 'A name, for example Mum';
          name.maxLength = 40;
          name.setAttribute('aria-label', 'Name for this address');
          const ok = h('button', 'wapp-sh__action wapp-sh__action--primary', 'Save');
          ok.type = 'button';
          ok.addEventListener('click', () => {
            b.trust(s.value, name.value || 'Trusted');
            renderCheck();
          });
          save.replaceWith(name, ok);
          name.focus();
        });
        row.append(save);
      }
    }

    row.append(copyButton('Copy link', () => shareLink(location.origin, inputText)), copyButton('Copy summary', () => shareText(v, location.origin)));
    const card = h('button', 'wapp-sh__action', 'Download card');
    card.type = 'button';
    card.addEventListener('click', async () => {
      try {
        const blob = await renderShareCard(v, location.origin);
        const a = h('a');
        a.href = URL.createObjectURL(blob);
        a.download = `aretia-shield-${bandWord(v.band).toLowerCase()}.png`;
        a.click();
        setTimeout(() => URL.revokeObjectURL(a.href), 4000);
      } catch {
        card.textContent = 'Could not make the card';
      }
    });
    row.append(card);
    return row;
  }

  // ---- the My wallet tab
  let scanning = false;
  let walletReport: { owner: string; report: HealthReport; accounts: TokenAccount[]; readOnly: boolean } | null = null;
  let evmScan: { owner: string; findings: ApprovalFinding[]; notes: string[] } | null = null;
  let walletMessage: { tone: 'ok' | 'warn'; text: string } | null = null;

  function renderWallet(): void {
    const p = panels.wallet;
    p.replaceChildren();
    const mine = host.getAddress();
    const top = h('section', 'wapp-sh__card');
    top.append(h('h3', 'wapp-sh__h', 'Wallet health'), h('p', 'wapp__fine', 'Scans a Solana wallet for tokens that look risky, permissions you gave other addresses, and empty accounts holding SOL you can take back. It only reads. Fixing anything asks your wallet to approve.'));
    const row = h('form', 'wapp-sh__form wapp-sh__form--small');
    const addr = h('input', 'wapp__input wapp-sh__input');
    addr.placeholder = 'A Solana wallet address';
    addr.value = walletReport?.owner ?? mine ?? '';
    addr.spellcheck = false;
    addr.setAttribute('aria-label', 'Solana wallet to scan');
    const scan = h('button', 'wapp__btn wapp-sh__go', mine && addr.value === mine ? 'Scan my wallet' : 'Scan');
    scan.type = 'submit';
    row.append(addr, scan);
    row.addEventListener('submit', (e) => {
      e.preventDefault();
      void scanWallet(addr.value.trim());
    });
    top.append(row);
    if (!mine) {
      const connect = h('button', 'wapp-sh__action wapp-sh__action--primary', 'Connect wallet');
      connect.type = 'button';
      connect.addEventListener('click', () => document.querySelector<HTMLButtonElement>('[data-aretia-wallet-mount] button')?.click());
      top.append(h('p', 'wapp__fine', 'Connect your wallet to scan it and fix things, or paste any address to read it.'), connect);
    }
    p.append(top);

    if (walletMessage) {
      const m = h('p', `wapp__banner wapp__banner--${walletMessage.tone}`, walletMessage.text);
      m.setAttribute('role', 'status');
      p.append(m);
    }
    if (scanning) p.append(skeleton());
    else if (walletReport) p.append(healthCard(walletReport));
    p.append(evmCard());
  }

  async function scanWallet(address: string): Promise<void> {
    if (scanning) return;
    const web3ok = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(address);
    if (!web3ok) {
      walletMessage = { tone: 'warn', text: 'That is not a Solana address.' };
      return renderWallet();
    }
    scanning = true;
    walletMessage = null;
    renderWallet();
    try {
      const [accounts, balance] = await Promise.all([readTokenAccounts(address, solRead), solRead<{ value: number }>('getBalance', [address, { commitment: 'confirmed' }])]);
      // Rate the tokens held, largest first, a few at a time. The rest are counted, not silently dropped.
      const holdings = new Map((host.getHoldings() ?? []).map((x) => [x.mint, x]));
      const held = [...new Set(accounts.filter((a) => a.amount > 0n).map((a) => a.mint))].sort((a, b) => (holdings.get(b)?.value ?? 0) - (holdings.get(a)?.value ?? 0));
      const LIMIT = 14;
      const checks: HeldTokenCheck[] = [];
      const queue = held.slice(0, LIMIT);
      await Promise.all(
        Array.from({ length: 3 }, async () => {
          for (let mint = queue.shift(); mint; mint = queue.shift()) {
            if (isFeeAsset('solana', mint)) {
              checks.push({ mint, symbol: holdings.get(mint)?.symbol ?? KNOWN_TOKENS.find((k) => k.mint === mint)?.symbol ?? null, band: 'green', ratingLabel: 'Major asset', noMarket: false });
              continue;
            }
            const pool = await finder.find('solana', mint).catch(() => null);
            const risk = await assessTokenSafety('solana', mint, pool ? { liquidityUsd: pool.liquidityUsd, volume24hUsd: pool.volume24hUsd, ageMs: null, hasPool: true } : null).catch(() => null);
            checks.push({ mint, symbol: pool?.baseSymbol ?? holdings.get(mint)?.symbol ?? null, band: risk ? bandOf(risk.status) : 'grey', ratingLabel: risk ? RISK_LABELS[risk.status] : null, noMarket: !pool });
          }
        }),
      );
      const report = analyseWallet({ lamports: BigInt(balance.value), accounts, checks, skipped: Math.max(0, held.length - LIMIT) });
      walletReport = { owner: address, report, accounts, readOnly: address !== host.getAddress() };
    } catch {
      walletReport = null;
      walletMessage = { tone: 'warn', text: 'The scan could not be completed. The network may be busy: try again in a moment.' };
    } finally {
      scanning = false;
      renderWallet();
    }
  }

  function healthCard(w: NonNullable<typeof walletReport>): HTMLElement {
    const r = w.report;
    const card = h('article', `wapp-sh__card wapp-sh__verdict wapp-sh__verdict--${r.band}`);
    const bar = h('header', `wapp-sh__bar wapp-sh__bar--${r.band}`);
    bar.append(h('span', 'wapp-sh__bandword', bandWord(r.band)), h('p', 'wapp-sh__headline', r.headline));
    card.append(bar);
    const dl = h('dl', 'wapp-sh__facts');
    for (const [k, v] of [['Wallet', short(w.owner)], ['Tokens held', String(r.tokenCount)], ['Rated', String(r.checkedTokens)]] as const) {
      const d = h('div');
      d.append(h('dt', '', k), h('dd', '', v));
      dl.append(d);
    }
    card.append(dl);
    const list = h('ul', 'wapp-sh__findings');
    for (const item of r.items) list.append(healthRow(item, w));
    card.append(list);
    if (w.readOnly) card.append(h('p', 'wapp__fine wapp-sh__pad', 'This is not the wallet you have connected, so it is read-only here. Connect it to fix anything.'));
    const cannot = h('details', 'wapp-sh__cannot');
    cannot.append(h('summary', '', `What Shield could not check (${r.couldNot.length})`));
    const cl = h('ul');
    for (const c of r.couldNot) cl.append(h('li', '', c));
    cannot.append(cl);
    card.append(cannot);
    return card;
  }

  function healthRow(item: HealthItem, w: NonNullable<typeof walletReport>): HTMLElement {
    const li = findingRow(item);
    const a = item.action;
    if (!a) return li;
    const text = li.querySelector<HTMLElement>('.wapp-sh__ftext')!;
    const bar = h('div', 'wapp-sh__rowactions');
    if (a.kind === 'check' && a.value) {
      const b = h('button', 'wapp-sh__action', 'See the full check');
      b.type = 'button';
      b.addEventListener('click', () => {
        input.value = a.value!;
        void check(a.value!);
      });
      bar.append(b);
    } else if ((a.kind === 'revoke' || a.kind === 'reclaim') && !w.readOnly && a.accounts) {
      const label = a.kind === 'revoke' ? 'Take the permission back' : `Get ${(Number(w.report.reclaimLamports) / 1e9).toFixed(4)} SOL back`;
      const b = h('button', 'wapp-sh__action wapp-sh__action--primary', label);
      b.type = 'button';
      b.addEventListener('click', async () => {
        b.disabled = true;
        const step = (done: number, total: number): void => void (b.textContent = `Confirming ${done} of ${total}…`);
        b.textContent = 'Waiting for your wallet…';
        try {
          const run = a.kind === 'revoke' ? revoke : reclaim;
          const res = await run(w.owner, a.accounts!, step);
          walletMessage = { tone: res.confirmed ? 'ok' : 'warn', text: res.confirmed ? (a.kind === 'revoke' ? 'Done. The permission was taken back.' : 'Done. The empty accounts were closed and the SOL returned to your wallet.') : 'Sent, but not confirmed yet. Check your wallet activity, then scan again.' };
          host.refreshWallet();
          await scanWallet(w.owner);
        } catch (e) {
          b.disabled = false;
          b.textContent = label;
          const msg = e instanceof Error ? e.message : 'It could not be sent.';
          walletMessage = { tone: 'warn', text: /reject|declin|denied|cancel/i.test(msg) ? 'You declined in your wallet. Nothing was changed.' : msg };
          renderWallet();
        }
      });
      bar.append(b);
    }
    if (bar.children.length > 0) text.append(bar);
    return li;
  }

  function evmCard(): HTMLElement {
    const card = h('section', 'wapp-sh__card');
    card.append(h('h3', 'wapp-sh__h', 'Approvals on Ethereum-style networks'), h('p', 'wapp__fine', 'A swap leaves a permission behind: the venue may keep spending your token. This lists the permissions you gave the swap venues Aretia knows, on all eight networks, and lets you take them back.'));
    const form2 = h('form', 'wapp-sh__form wapp-sh__form--small');
    const addr = h('input', 'wapp__input wapp-sh__input');
    addr.placeholder = '0x… wallet address';
    addr.value = evmScan?.owner ?? host.evmAccount() ?? '';
    addr.spellcheck = false;
    addr.setAttribute('aria-label', 'Ethereum-style address to scan');
    const b = h('button', 'wapp__btn wapp-sh__go', 'Scan approvals');
    b.type = 'submit';
    form2.append(addr, b);
    card.append(form2);
    form2.addEventListener('submit', (e) => {
      e.preventDefault();
      void scanApprovals(addr.value.trim(), b);
    });
    if (evmScan) {
      const mineEvm = host.evmAccount();
      const canFix = !!mineEvm && mineEvm.toLowerCase() === evmScan.owner.toLowerCase();
      if (evmScan.findings.length === 0) card.append(h('p', 'wapp-sh__clear', 'No permissions found for the swap venues Aretia knows.'));
      const list = h('ul', 'wapp-sh__findings');
      for (const f of evmScan.findings) {
        const li = findingRow(f);
        if (canFix) {
          const fix = h('button', 'wapp-sh__action wapp-sh__action--primary', 'Take it back');
          fix.type = 'button';
          fix.addEventListener('click', async () => {
            fix.disabled = true;
            fix.textContent = 'Waiting for your wallet…';
            try {
              await host.revokeEvm(f.approval.chain, f.approval.token.address, f.approval.spender.address);
              evmScan = { ...evmScan!, findings: evmScan!.findings.filter((x) => x !== f) };
              walletMessage = { tone: 'ok', text: 'The permission was taken back. It may take a moment to show as removed.' };
            } catch (e) {
              fix.disabled = false;
              fix.textContent = 'Take it back';
              const msg = e instanceof Error ? e.message : 'It could not be sent.';
              walletMessage = { tone: 'warn', text: /reject|declin|denied|cancel/i.test(msg) ? 'You declined in your wallet. Nothing was changed.' : msg };
            }
            renderWallet();
          });
          li.querySelector('.wapp-sh__ftext')!.append(h('div', 'wapp-sh__rowactions'));
          li.querySelector('.wapp-sh__rowactions')!.append(fix);
        }
        list.append(li);
      }
      card.append(list);
      if (!canFix && evmScan.findings.length > 0) card.append(h('p', 'wapp__fine wapp-sh__pad', 'Read-only: connect this address in your Ethereum-style wallet (on the Swap page) to take permissions back.'));
      const cannot = h('details', 'wapp-sh__cannot');
      cannot.append(h('summary', '', `What Shield could not check (${evmScan.notes.length})`));
      const cl = h('ul');
      for (const c of evmScan.notes) cl.append(h('li', '', c));
      cannot.append(cl);
      card.append(cannot);
    }
    return card;
  }

  let scanningEvm = false;
  async function scanApprovals(address: string, button: HTMLButtonElement): Promise<void> {
    if (scanningEvm) return;
    if (!/^0x[0-9a-fA-F]{40}$/.test(address)) {
      walletMessage = { tone: 'warn', text: 'That is not an Ethereum-style address.' };
      return renderWallet();
    }
    scanningEvm = true;
    button.disabled = true;
    button.textContent = 'Scanning…';
    const notes = ['Permissions to contracts Shield does not know, and for tokens it was not asked about: finding those needs a full transaction index. This lists the common ones only.'];
    const found: Approval[] = [];
    const chains = (Object.values(CHAINS).filter((c) => c.kind === 'evm').map((c) => c.id)) as ChainId[];
    await Promise.all(
      chains.map(async (chain) => {
        try {
          found.push(...(await readApprovals(chain, address.toLowerCase(), publicRead(chain))));
        } catch {
          notes.push(`${CHAINS[chain].name} did not answer, so its permissions are not listed.`);
        }
      }),
    );
    evmScan = { owner: address, findings: describeApprovals(found).sort((a, b) => Number(b.approval.unlimited) - Number(a.approval.unlimited)), notes };
    scanningEvm = false;
    renderWallet();
  }

  // ---- the Watching tab
  function renderWatch(): void {
    const p = panels.watch;
    p.replaceChildren();
    const items = watchStore.list();
    const card = h('section', 'wapp-sh__card');
    card.append(h('h3', 'wapp-sh__h', 'Watching'), h('p', 'wapp__fine', 'Shield re-checks these while this page is open and rings the bell only when something gets worse: the colour moves toward red, a new problem appears, or a liquidity lock goes. Nothing is checked when the page is closed.'));
    if (items.length === 0) card.append(h('p', 'wapp-sh__clear', 'Nothing watched yet. Check a token or address and press Watch this.'));
    const list = h('ul', 'wapp-sh__watchlist');
    for (const w of items) {
      const li = h('li', 'wapp-sh__watch');
      li.append(bandBadge(w.last?.band ?? 'grey'));
      const text = h('div', 'wapp-sh__ftext');
      text.append(h('strong', '', w.label ?? short(w.value)), h('span', 'wapp-sh__fdetail', `${w.last ? bandWord(w.last.band) : 'Not checked yet'} · checked ${ago(w.checkedAt)}`));
      const acts = h('div', 'wapp-sh__rowactions');
      const open = h('button', 'wapp-sh__action', 'Check now');
      open.type = 'button';
      open.addEventListener('click', () => {
        input.value = w.value;
        void check(w.value);
      });
      const del = h('button', 'wapp-sh__action', 'Stop watching');
      del.type = 'button';
      del.addEventListener('click', () => {
        watchStore.remove(w.value);
        show('watch');
      });
      acts.append(open, del);
      li.append(text, acts);
      list.append(li);
    }
    card.append(list);
    p.append(card);

    // The addresses this device knows.
    const bookCard = h('section', 'wapp-sh__card');
    bookCard.append(h('h3', 'wapp-sh__h', 'Addresses you know'), h('p', 'wapp__fine', 'Saved and recently paid addresses, kept in this browser only. Shield compares every new address with them to catch copy-cats.'));
    const known = book().list();
    if (!owner()) bookCard.append(h('p', 'wapp-sh__clear', 'Connect a wallet to keep a list of addresses.'));
    else if (known.length === 0) bookCard.append(h('p', 'wapp-sh__clear', 'None yet. Addresses you send to are remembered here, and you can save one with a name from its check.'));
    const kl = h('ul', 'wapp-sh__watchlist');
    for (const k of known.slice(0, 30)) {
      const li = h('li', 'wapp-sh__watch');
      const text = h('div', 'wapp-sh__ftext');
      text.append(h('strong', '', k.label ?? 'Sent to before'), h('code', 'wapp-sh__fdetail wapp-mono', short(k.address)));
      const acts = h('div', 'wapp-sh__rowactions');
      if (!k.trusted) {
        const save = h('button', 'wapp-sh__action', 'Save with a name');
        save.type = 'button';
        save.addEventListener('click', () => {
          const name = h('input', 'wapp__input wapp-sh__name');
          name.placeholder = 'A name';
          name.maxLength = 40;
          name.setAttribute('aria-label', 'Name for this address');
          const ok = h('button', 'wapp-sh__action wapp-sh__action--primary', 'Save');
          ok.type = 'button';
          ok.addEventListener('click', () => {
            book().trust(k.address, cleanLabel(name.value) || 'Trusted');
            renderWatch();
          });
          save.replaceWith(name, ok);
          name.focus();
        });
        acts.append(save);
      }
      const del = h('button', 'wapp-sh__action', 'Forget');
      del.type = 'button';
      del.addEventListener('click', () => {
        book().remove(k.address);
        renderWatch();
      });
      acts.append(del);
      li.append(text, acts);
      kl.append(li);
    }
    bookCard.append(kl);
    p.append(bookCard);
  }

  drawChips();
  show('check');

  return {
    onShow(hash: string): void {
      drawChips();
      const value = valueFromHash(hash);
      if (value && value !== current?.input) {
        input.value = value;
        void check(value);
      } else show(tab);
    },
    onWalletChange(): void {
      walletReport = null;
      walletMessage = null;
      drawChips();
      if (tab === 'wallet') renderWallet();
    },
    book,
  };
}
