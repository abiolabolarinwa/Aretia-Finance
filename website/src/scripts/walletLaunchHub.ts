/**
 * The Launch page's frame: one network choice, a three-step journey (create the token, give it a market, it is live), a live preview
 * of the token being made, and what each step costs on the chosen network. It draws none of the forms. Each form is drawn by its own
 * module into its own root, and tells this file where it is by setting `data-stage` on that root ('form', 'review', 'working',
 * 'done', or 'off' when the feature is not available on the network). This file reads those attributes and arranges the page.
 *
 * Nothing here moves money or changes what a form sends. Everything typed is shown with textContent, never as markup.
 */
import { fromSmallestUnit } from './walletTools';
import { LAUNCH_FEE_LAMPORTS } from './walletLaunchCore';
import { POOL_FEE_LAMPORTS } from './walletPoolCore';
import { CURVE_FEE_BPS } from './walletCurveCore';
import { LAUNCH_EVM_CHAINS } from './walletLaunchEvmCore';
import type { LaunchApi, LaunchNetwork } from './walletLaunch';
import { appendTokenShare } from './walletTokenLinks';
import { detailsState, onDetailsChange } from './walletLaunchMeta';
import { validateDetails } from '../swings/launchmeta/core.js';
import { metaBlock } from './tokenMetaView';

type Stage = 'form' | 'review' | 'working' | 'done' | 'off' | '';
type Tab = 'pool' | 'curve';
type View = 'token' | 'market' | 'live' | 'pools';
type StepState = 'upcoming' | 'current' | 'busy' | 'done';

const h = <K extends keyof HTMLElementTagNameMap>(tag: K, cls = '', text?: string): HTMLElementTagNameMap[K] => {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text !== undefined) n.textContent = text;
  return n;
};

const grouped = (text: string): string => text.replace(/^(\d+)/, (whole) => whole.replace(/\B(?=(\d{3})+(?!\d))/g, ','));
const initials = (symbol: string, name: string): string => (symbol || name || '?').trim().slice(0, 2).toUpperCase() || '?';

/** The logo for each network; a test network wears the logo of its main network. */
const LOGO: Record<string, string> = {
  solana: 'solana',
  bnb: 'bnb',
  bscTestnet: 'bnb',
  ethereum: 'ethereum',
  sepolia: 'ethereum',
  polygon: 'polygon',
  polygonAmoy: 'polygon',
};
function logo(key: string, cls: string): HTMLImageElement | HTMLSpanElement {
  const file = LOGO[key];
  if (!file) return h('span', cls);
  const img = h('img', cls);
  img.src = `/assets/chains/${file}.png`;
  img.alt = '';
  img.width = 22;
  img.height = 22;
  img.decoding = 'async';
  return img;
}

const VIEW_ORDER: Record<View, number> = { token: 0, market: 1, live: 2, pools: 3 };

const STAGE_STATE: Record<string, StepState> = { form: 'current', review: 'current', working: 'busy', done: 'done' };

export interface LaunchHub {
  onShow(): void;
}

export function initLaunchHub(launch: LaunchApi, opts: { curveOn: boolean; /** Clears every form, for launching another token. */ resetAll?: () => void; /** Told when the Your pools stage opens. */ onPools?: () => void }): LaunchHub | null {
  const found = document.querySelector<HTMLElement>('[data-launch-hub]');
  if (!found) return null;
  const hub: HTMLElement = found;
  const $ = <T extends HTMLElement>(sel: string): T | null => hub.querySelector<T>(sel);
  const chips = $('[data-hub-networks]');
  const rail = $('[data-hub-rail]');
  const tabsEl = $('[data-hub-market-tabs]');
  const feesEl = $('[data-hub-fees]');
  const previewEl = $('[data-hub-preview]');
  const marketOff = $('[data-hub-market-off]');
  const panel = (t: Tab): HTMLElement | null => $(`[data-market-panel="${t}"]`);
  const root = (sel: string): HTMLElement | null => $(sel);

  let tab: Tab = 'pool';
  let view: View = 'token';
  let lastTokenStage: Stage = '';
  let lastMarketDone = false;
  /** What was made, read off the created screens the moment they appear, because create another clears them. */
  let made: { token: string | null; pool: string | null } = { token: null, pool: null };

  const stageOf = (el: HTMLElement | null): Stage => ((el?.dataset.stage ?? '') as Stage);
  const onSolana = (): boolean => launch.getNetwork() === 'solana';

  /** The roots that belong to the chosen network. */
  function roots(): { token: HTMLElement | null; pool: HTMLElement | null; curve: HTMLElement | null } {
    return onSolana()
      ? { token: root('[data-launch-root]'), pool: root('[data-pool-root]'), curve: root('[data-curve-root]') }
      : { token: root('[data-launch-root]'), pool: root('[data-evm-pool-root]'), curve: root('[data-evm-curve-root]') };
  }

  /** Shows only the roots of the chosen network; the others stay empty and hidden. */
  function placeRoots(): void {
    const sol = onSolana();
    for (const sel of ['[data-pool-root]', '[data-curve-root]']) root(sel)?.toggleAttribute('hidden', !sol);
    for (const sel of ['[data-evm-pool-root]', '[data-evm-curve-root]', '[data-evm-aretia-pool-root]', '[data-evm-orders-root]']) root(sel)?.toggleAttribute('hidden', sol);
  }

  // ---------------------------------------------------------------- network chips

  function drawChips(): void {
    if (!chips) return;
    chips.textContent = '';
    const current = launch.getNetwork();
    const all = launch.networks();
    const add = (n: LaunchNetwork, into: HTMLElement): void => {
      const b = h('button', `lh-chip${n.key === current ? ' is-on' : ''}${n.testnet ? ' is-test' : ''}`);
      b.type = 'button';
      b.setAttribute('aria-pressed', String(n.key === current));
      b.dataset.net = n.key;
      b.disabled = !n.enabled;
      if (!n.enabled) b.title = 'Not available yet';
      b.append(logo(n.key, 'lh-chip__logo'), document.createTextNode(n.name));
      if (n.key === current) b.append(h('span', 'lh-chip__check', '✓'));
      b.addEventListener('click', () => {
        if (n.key === launch.getNetwork()) return;
        if (!launch.setNetwork(n.key)) {
          chips.setAttribute('data-blocked', '1');
          window.setTimeout(() => chips.removeAttribute('data-blocked'), 1600);
          return;
        }
        tab = 'pool';
        view = 'token';
        placeRoots();
        drawChips();
        refresh();
      });
      into.append(b);
    };
    const main = all.filter((n) => !n.testnet);
    const test = all.filter((n) => n.testnet);
    for (const n of main) add(n, chips);
    if (test.length > 0) {
      const sep = h('span', 'lh-chips__sep', 'Test networks');
      chips.append(sep);
      for (const n of test) add(n, chips);
    }
  }

  // ---------------------------------------------------------------- journey rail

  function steps(): { token: StepState; market: StepState; live: StepState } {
    const r = roots();
    const token = STAGE_STATE[stageOf(r.token)] ?? 'upcoming';
    const marketStages = [stageOf(r.pool), stageOf(r.curve)];
    const marketDone = marketStages.includes('done');
    const marketBusy = marketStages.includes('working');
    const market: StepState = marketDone ? 'done' : marketBusy ? 'busy' : token === 'done' || marketStages.some((s) => s === 'review') ? 'current' : 'upcoming';
    const live: StepState = marketDone ? 'done' : 'upcoming';
    return { token, market, live };
  }

  /** Which stages a person may open now. The first two are always open; the last only once a market exists. Nothing moves while something is being made. */
  function canOpen(v: View): boolean {
    const r = roots();
    const working = [r.token, r.pool, r.curve].some((el) => stageOf(el) === 'working');
    if (working) return v === view;
    if (v === 'live') return steps().live === 'done';
    return true; // the token, market and pools stages are always open (when nothing is being made)
  }

  function go(next: View): void {
    if (!canOpen(next)) return;
    view = next;
    applyView();
    const reduce = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
    hub.scrollIntoView({ behavior: reduce ? 'auto' : 'smooth', block: 'start' });
  }

  function drawRail(): void {
    if (!rail) return;
    const s = steps();
    const items: { key: keyof typeof s; view: View; title: string; sub: Record<StepState, string> }[] = [
      { key: 'token', view: 'token', title: 'Create your token', sub: { upcoming: 'Name, supply, your share', current: 'Name, supply, your share', busy: 'Creating it now', done: 'Token created' } },
      { key: 'market', view: 'market', title: 'Give it a market', sub: { upcoming: 'A pool or a bonding curve', current: 'Choose how people buy', busy: 'Opening it now', done: 'Market open' } },
      { key: 'live', view: 'live', title: 'It’s live', sub: { upcoming: 'Anyone can buy it', current: 'Anyone can buy it', busy: '', done: 'People can buy it' } },
    ];
    rail.textContent = '';
    items.forEach((it, i) => {
      const state = s[it.key];
      const li = h('li', `lh-step is-${state}${it.view === view ? ' is-here' : ''}`);
      const btn = h('button', 'lh-step__btn');
      btn.type = 'button';
      btn.disabled = !canOpen(it.view);
      if (it.view === view) btn.setAttribute('aria-current', 'step');
      btn.addEventListener('click', () => go(it.view));
      const mark = h('span', 'lh-step__mark');
      mark.textContent = state === 'done' ? '✓' : String(i + 1);
      mark.setAttribute('aria-hidden', 'true');
      const text = h('span', 'lh-step__text');
      text.append(h('strong', '', it.title), h('small', '', it.sub[state]));
      btn.append(mark, text);
      li.append(btn);
      rail.append(li);
    });
    hub.dataset.tokenStage = stageOf(roots().token);
    const fill = $('[data-hub-bar] > span');
    if (fill) fill.style.width = `${(s.token === 'done' ? 50 : s.token === 'busy' ? 20 : 0) + (s.market === 'done' ? 50 : s.market === 'busy' ? 20 : 0)}%`;
  }

  // ---------------------------------------------------------------- stages

  /** Slides the stage that just opened in, from the side it is reached from. Skipped when the person asks for less motion. */
  function enter(v: View): void {
    if (window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) return;
    const el = $(`[data-step="${v}"]`);
    if (!el) return;
    el.classList.remove('lh-enter');
    void el.offsetWidth;
    el.classList.add('lh-enter');
  }

  /** Shows the one stage that is open and hides the others. */
  function applyView(): void {
    const changed = hub.dataset.view !== undefined && hub.dataset.view !== view;
    if (changed) hub.dataset.dir = VIEW_ORDER[view] >= VIEW_ORDER[hub.dataset.view as View] ? 'fwd' : 'back';
    hub.dataset.view = view;
    if (changed) enter(view);
    drawRail();
    drawNavs();
    drawLive();
  }

  /** The buttons that carry a person from one stage to the next, shown only when the stage before is finished. */
  function drawNavs(): void {
    const tokenNav = $('[data-hub-token-nav]');
    const marketNav = $('[data-hub-market-nav]');
    const s = steps();
    if (tokenNav) {
      tokenNav.textContent = '';
      tokenNav.hidden = s.token !== 'done';
      if (s.token === 'done') {
        const next = h('button', 'wapp__btn wapp__btn--primary lh-nav__go', 'Continue: give it a market');
        next.type = 'button';
        next.addEventListener('click', () => {
          tab = 'pool';
          go('market');
        });
        tokenNav.append(h('p', 'lh-nav__note', 'Your token exists. The next step lets people buy it.'), next);
      }
    }
    if (marketNav) {
      marketNav.textContent = '';
      const back = h('button', 'lh-nav__back', '← Back to your token');
      back.type = 'button';
      back.disabled = !canOpen('token');
      back.addEventListener('click', () => go('token'));
      marketNav.append(back);
      if (s.live === 'done') {
        const next = h('button', 'wapp__btn wapp__btn--primary lh-nav__go', 'Finish: see your launch');
        next.type = 'button';
        next.addEventListener('click', () => go('live'));
        marketNav.append(next);
      }
    }
  }

  /** Reads a labelled value (such as "Token address") off a created screen. */
  function readRow(from: HTMLElement | null, label: RegExp): string | null {
    if (!from) return null;
    for (const dt of from.querySelectorAll('dt')) {
      if (label.test(dt.textContent ?? '')) {
        const text = dt.nextElementSibling?.textContent?.trim() ?? '';
        if (text !== '') return text;
      }
    }
    return null;
  }

  function drawLive(): void {
    const el = $('[data-hub-live]');
    if (!el) return;
    el.textContent = '';
    if (view !== 'live') return;
    const net = launch.networks().find((n) => n.key === launch.getNetwork());
    const mark = h('div', 'lh-live__mark', '✓');
    mark.setAttribute('aria-hidden', 'true');
    el.append(mark, h('h2', 'lh-live__title', 'Your token is live'), h('p', 'lh-live__lead', `It exists on ${net?.name ?? 'the network'} and has a market, so people can buy it.`));
    const dl = h('dl', 'lh-live__rows');
    const add = (k: string, v: string | null): void => {
      if (!v) return;
      const d = h('div');
      const dd = h('dd', 'wapp-mono');
      dd.textContent = v;
      const copy = h('button', 'lh-live__copy', 'Copy');
      copy.type = 'button';
      copy.addEventListener('click', () => {
        void navigator.clipboard?.writeText(v).then(() => {
          copy.textContent = 'Copied';
          window.setTimeout(() => (copy.textContent = 'Copy'), 1600);
        });
      });
      d.append(h('dt', '', k), dd, copy);
      dl.append(d);
    };
    add('Token address', made.token);
    add('Market address', made.pool);
    el.append(dl);
    if (made.token) appendTokenShare(el, launch.getNetwork(), made.token);
    const again = h('button', 'wapp__btn wapp__btn--primary lh-nav__go', 'Launch another token');
    again.type = 'button';
    again.addEventListener('click', () => {
      opts.resetAll?.();
      made = { token: null, pool: null };
      view = 'token';
      lastTokenStage = '';
      lastMarketDone = false;
      tab = 'pool';
      refresh();
    });
    el.append(again);
  }

  // ---------------------------------------------------------------- market tabs

  function drawTabs(): void {
    if (!tabsEl) return;
    const r = roots();
    const poolOff = stageOf(r.pool) === 'off';
    const curveOff = !opts.curveOn || r.curve === null || stageOf(r.curve) === 'off';
    const available: Tab[] = [];
    if (!poolOff) available.push('pool');
    if (!curveOff) available.push('curve');
    if (!available.includes(tab)) tab = available[0] ?? 'pool';
    tabsEl.textContent = '';
    tabsEl.hidden = available.length < 2;
    for (const t of available) {
      const b = h('button', `lh-tab${t === tab ? ' is-on' : ''}`, t === 'pool' ? 'Liquidity pool' : 'Bonding curve');
      b.type = 'button';
      b.setAttribute('role', 'tab');
      b.setAttribute('aria-selected', String(t === tab));
      b.addEventListener('click', () => {
        tab = t;
        drawTabs();
      });
      tabsEl.append(b);
    }
    for (const t of ['pool', 'curve'] as Tab[]) panel(t)?.toggleAttribute('hidden', t !== tab || available.length === 0);
    if (marketOff) {
      marketOff.hidden = available.length > 0;
      const net = launch.networks().find((n) => n.key === launch.getNetwork());
      marketOff.textContent = `Pools and curves are not available on ${net?.name ?? 'this network'} yet. You can still create the token.`;
    }
    const hint = $('[data-hub-market-hint]');
    if (hint) {
      const protection = ' Launch protection is on by default: the fee starts at 5% and falls in a straight line to yours over 10, 30 or 60 minutes, so buying the instant a pool opens costs a bot more. The first buyers pay the higher fee, and it goes to you.';
      hint.hidden = available.length < 2 && !(tab === 'pool' && onSolana());
      hint.textContent =
        tab === 'pool' && available.includes('curve')
          ? 'A pool opens a market right away at a starting price you choose.' + (onSolana() ? protection : '')
          : tab === 'curve'
            ? 'A curve sells your token along a rising price, and opens a locked pool when it sells out.'
            : 'A pool opens a market right away at a starting price you choose.' + (tab === 'pool' && onSolana() ? protection : '');
    }
  }

  // ---------------------------------------------------------------- fees

  function drawFees(): void {
    if (!feesEl) return;
    const net = launch.getNetwork();
    const r = roots();
    const rows: [string, string][] = [];
    if (net === 'solana') {
      rows.push(['Create a token', `${fromSmallestUnit(LAUNCH_FEE_LAMPORTS, 9)} SOL`]);
      if (stageOf(r.pool) !== 'off') rows.push(['Open a pool', `${fromSmallestUnit(POOL_FEE_LAMPORTS, 9)} SOL`]);
    } else {
      const chain = LAUNCH_EVM_CHAINS.find((c) => c.key === net);
      if (chain) rows.push(['Create a token', `${fromSmallestUnit(chain.feeWei, 18)} ${chain.symbol}`]);
      if (stageOf(r.pool) !== 'off') rows.push(['Open a pool', '10 USDC or USDT']);
    }
    if (opts.curveOn && r.curve && stageOf(r.curve) !== 'off') rows.push(['Sell on a curve', `${CURVE_FEE_BPS / 100}% of each trade`]);
    feesEl.textContent = '';
    const dl = h('dl', 'lh-fees');
    for (const [k, v] of rows) {
      const d = h('div');
      d.append(h('dt', '', k), h('dd', '', v));
      dl.append(d);
    }
    feesEl.append(h('h3', 'lh-side__h', 'What Aretia charges'), dl, h('p', 'lh-side__fine', 'Flat fees, shown again before you sign. Network fees and account deposits are extra and also shown first.'));
  }

  // ---------------------------------------------------------------- preview

  function readInput(...ids: string[]): string {
    for (const id of ids) {
      const el = document.getElementById(id) as HTMLInputElement | null;
      if (el) return el.value.trim();
    }
    return '';
  }

  /** What the creator keeps, read from the form on show: the Solana share, or what is left after the locked pool on an Ethereum-style network. */
  function creatorShare(): { label: string; value: string } | null {
    const sol = readInput('launch-creatorPct');
    if (sol !== '') return /^\d{1,3}(\.\d{1,2})?$/.test(sol) ? { label: 'Your share', value: `${Number(sol)}%` } : null;
    const pool = readInput('launch-evm-poolPct');
    if (pool !== '') return /^\d{1,3}(\.\d{1,2})?$/.test(pool) && Number(pool) <= 100 ? { label: 'You keep', value: `${Number((100 - Number(pool)).toFixed(2))}%` } : null;
    return document.getElementById('launch-evm-name') ? { label: 'You keep', value: '100%' } : null;
  }

  function drawPreview(): void {
    if (!previewEl) return;
    const name = readInput('launch-name', 'launch-evm-name');
    const symbol = readInput('launch-symbol', 'launch-evm-symbol').toUpperCase();
    const supply = readInput('launch-supply', 'launch-evm-supply');
    const net = launch.networks().find((n) => n.key === launch.getNetwork());
    const done = stageOf(roots().token) === 'done';
    previewEl.textContent = '';
    previewEl.dataset.empty = name === '' && symbol === '' ? '1' : '0';
    // The picture, description and links come from the same fields the token page will show them from.
    const shown = detailsState();
    const avatar = h('div', 'lh-token__avatar', shown.image ? '' : initials(symbol, name));
    avatar.setAttribute('aria-hidden', 'true');
    if (shown.image) {
      const img = h('img', 'lh-token__img');
      img.alt = '';
      img.src = shown.image.previewUrl;
      avatar.append(img);
    }
    const head = h('div', 'lh-token__head');
    head.append(h('strong', 'lh-token__name', name || 'Your token'), h('span', 'lh-token__sym', symbol ? `$${symbol}` : '$SYMBOL'));
    const top = h('div', 'lh-token__top');
    top.append(avatar, head);
    const about = ((): HTMLElement | null => {
      const v = validateDetails(shown.details);
      // Only what would pass the checks is shown, so the preview never promises a field that will be refused.
      const d = v.ok ? v.value : { description: '', website: '', x: '', telegram: '' };
      return metaBlock({ description: d.description, website: d.website || null, x: d.x || null, telegram: d.telegram || null }, 'lh-token', false);
    })();
    const facts = h('dl', 'lh-token__facts');
    const fact = (k: string, v: string): void => {
      const d = h('div');
      d.append(h('dt', '', k), h('dd', '', v));
      facts.append(d);
    };
    const netRow = h('div');
    const netValue = h('dd', 'lh-token__net');
    netValue.append(logo(launch.getNetwork(), 'lh-token__netlogo'), document.createTextNode(net?.name ?? ''));
    netRow.append(h('dt', '', 'Network'), netValue);
    facts.append(netRow);
    fact('Total supply', supply ? grouped(supply.replace(/,/g, '')) : '–');
    fact('Supply can grow', 'Never');
    const share = creatorShare();
    if (share) fact(share.label, share.value);
    previewEl.append(h('h3', 'lh-side__h', done ? 'Your token' : 'Preview'), top);
    if (about) previewEl.append(about);
    previewEl.append(facts);
    if (done) previewEl.append(h('p', 'lh-token__live', 'Created and verified on the network.'));
  }

  // ---------------------------------------------------------------- refresh

  function refresh(): void {
    drawTabs();
    drawFees();
    drawPreview();
    const r = roots();
    const tokenStage = stageOf(r.token);
    const marketDone = steps().live === 'done';
    // Remember what was made, read off the created screens while they are on show.
    if (tokenStage === 'done' && lastTokenStage !== 'done') made.token = readRow(r.token, /token address/i) ?? made.token;
    if (marketDone && !lastMarketDone) made.pool = readRow(stageOf(r.pool) === 'done' ? r.pool : r.curve, /(pool|curve|market)( address)?$/i) ?? made.pool;
    lastTokenStage = tokenStage;
    lastMarketDone = marketDone;
    if (view === 'live' && !marketDone) view = 'market';
    // The Your pools stage is its own place, not a step of the journey: the rail stays as it was and is hidden there by the page's styles.
    applyView();
  }

  /** Marks the total in any cost list, so the number a person is about to approve stands out from the rows above it. */
  function markTotals(): void {
    for (const row of hub.querySelectorAll<HTMLElement>('.lh__main dl.wapp__rows > div')) {
      const label = row.querySelector('dt')?.textContent ?? '';
      row.classList.toggle('is-total', label.trim().toLowerCase().startsWith('total'));
    }
  }
  const main = $('.lh__main');
  if (main) new MutationObserver(markTotals).observe(main, { childList: true, subtree: true });

  // Each form announces where it is by changing data-stage; typing in the create form updates the preview.
  new MutationObserver(() => refresh()).observe(hub, { attributes: true, attributeFilter: ['data-stage'], subtree: true });
  // "Open a pool / curve for it" on the created screen: show the tab that holds the card that was just prepared.
  // The Your pools link in the header, and the back link inside it.
  $('[data-hub-open-pools]')?.addEventListener('click', () => {
    go('pools');
    opts.onPools?.();
  });
  hub.addEventListener('lh:back', () => go('token'));
  hub.addEventListener('lh:offer', (e) => {
    const panelEl = (e.target as HTMLElement | null)?.closest<HTMLElement>('[data-market-panel]');
    tab = panelEl?.dataset.marketPanel === 'curve' ? 'curve' : 'pool';
    view = 'market';
    refresh();
  });
  onDetailsChange(() => drawPreview());
  hub.addEventListener('input', (e) => {
    if ((e.target as HTMLElement | null)?.closest('[data-launch-root]')) drawPreview();
  });

  placeRoots();
  drawChips();
  refresh();

  return {
    onShow(): void {
      placeRoots();
      drawChips();
      refresh();
    },
  };
}
