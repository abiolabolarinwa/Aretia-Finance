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

type Stage = 'form' | 'review' | 'working' | 'done' | 'off' | '';
type Tab = 'pool' | 'curve';
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

const STAGE_STATE: Record<string, StepState> = { form: 'current', review: 'current', working: 'busy', done: 'done' };

export interface LaunchHub {
  onShow(): void;
}

export function initLaunchHub(launch: LaunchApi, opts: { curveOn: boolean }): LaunchHub | null {
  const found = document.querySelector<HTMLElement>('[data-launch-hub]');
  if (!found) return null;
  const hub: HTMLElement = found;
  const $ = <T extends HTMLElement>(sel: string): T | null => hub.querySelector<T>(sel);
  const chips = $('[data-hub-networks]');
  const rail = $('[data-hub-rail]');
  const tabsEl = $('[data-hub-market-tabs]');
  const feesEl = $('[data-hub-fees]');
  const previewEl = $('[data-hub-preview]');
  const marketCard = $('[data-step="market"]');
  const marketOff = $('[data-hub-market-off]');
  const panel = (t: Tab): HTMLElement | null => $(`[data-market-panel="${t}"]`);
  const root = (sel: string): HTMLElement | null => $(sel);

  let tab: Tab = 'pool';
  let lastTokenStage: Stage = '';

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
    for (const sel of ['[data-evm-pool-root]', '[data-evm-curve-root]']) root(sel)?.toggleAttribute('hidden', sol);
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
      b.addEventListener('click', () => {
        if (n.key === launch.getNetwork()) return;
        if (!launch.setNetwork(n.key)) {
          chips.setAttribute('data-blocked', '1');
          window.setTimeout(() => chips.removeAttribute('data-blocked'), 1600);
          return;
        }
        tab = 'pool';
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

  function drawRail(): void {
    if (!rail) return;
    const s = steps();
    const items: { key: keyof typeof s; title: string; sub: Record<StepState, string> }[] = [
      { key: 'token', title: 'Create your token', sub: { upcoming: 'Name, supply, your share', current: 'Name, supply, your share', busy: 'Creating it now', done: 'Token created' } },
      { key: 'market', title: 'Give it a market', sub: { upcoming: 'A pool or a bonding curve', current: 'Choose how people buy', busy: 'Opening it now', done: 'Market open' } },
      { key: 'live', title: 'It’s live', sub: { upcoming: 'Anyone can buy it', current: 'Anyone can buy it', busy: '', done: 'People can buy it' } },
    ];
    rail.textContent = '';
    items.forEach((it, i) => {
      const state = s[it.key];
      const li = h('li', `lh-step is-${state}`);
      if (state === 'current' || state === 'busy') li.setAttribute('aria-current', 'step');
      const mark = h('span', 'lh-step__mark');
      mark.textContent = state === 'done' ? '✓' : String(i + 1);
      mark.setAttribute('aria-hidden', 'true');
      const text = h('span', 'lh-step__text');
      text.append(h('strong', '', it.title), h('small', '', it.sub[state]));
      li.append(mark, text);
      rail.append(li);
    });
    hub.dataset.tokenStage = stageOf(roots().token);
    if (marketCard) marketCard.dataset.ready = s.token === 'done' || s.market !== 'upcoming' ? '1' : '0';
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
      hint.hidden = available.length < 2;
      hint.textContent =
        tab === 'pool' && available.includes('curve')
          ? 'A pool opens a market right away at a starting price you choose.'
          : tab === 'curve'
            ? 'A curve sells your token along a rising price, and opens a locked pool when it sells out.'
            : 'A pool opens a market right away at a starting price you choose.';
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

  function drawPreview(): void {
    if (!previewEl) return;
    const name = readInput('launch-name', 'launch-evm-name');
    const symbol = readInput('launch-symbol', 'launch-evm-symbol').toUpperCase();
    const supply = readInput('launch-supply', 'launch-evm-supply');
    const net = launch.networks().find((n) => n.key === launch.getNetwork());
    const done = stageOf(roots().token) === 'done';
    previewEl.textContent = '';
    previewEl.dataset.empty = name === '' && symbol === '' ? '1' : '0';
    const avatar = h('div', 'lh-token__avatar', initials(symbol, name));
    avatar.setAttribute('aria-hidden', 'true');
    const head = h('div', 'lh-token__head');
    head.append(h('strong', 'lh-token__name', name || 'Your token'), h('span', 'lh-token__sym', symbol ? `$${symbol}` : '$SYMBOL'));
    const top = h('div', 'lh-token__top');
    top.append(avatar, head);
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
    previewEl.append(h('h3', 'lh-side__h', done ? 'Your token' : 'Preview'), top, facts);
    if (done) previewEl.append(h('p', 'lh-token__live', 'Created and verified on the network.'));
  }

  // ---------------------------------------------------------------- refresh

  function refresh(): void {
    drawRail();
    drawTabs();
    drawFees();
    drawPreview();
    const tokenStage = stageOf(roots().token);
    if (tokenStage === 'done' && lastTokenStage !== 'done') {
      tab = 'pool';
      drawTabs();
      const reduce = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
      marketCard?.scrollIntoView({ behavior: reduce ? 'auto' : 'smooth', block: 'start' });
    }
    lastTokenStage = tokenStage;
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
  hub.addEventListener('lh:offer', (e) => {
    const panelEl = (e.target as HTMLElement | null)?.closest<HTMLElement>('[data-market-panel]');
    tab = panelEl?.dataset.marketPanel === 'curve' ? 'curve' : 'pool';
    drawTabs();
  });
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
