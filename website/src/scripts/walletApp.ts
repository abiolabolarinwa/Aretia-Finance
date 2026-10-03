/**
 * Aretia web wallet (aretiafinance.org/wallet).
 *
 * A non-custodial page: the visitor connects a wallet they already own
 * (Phantom, Solflare, Backpack, the Aretia extension, ...) through
 * `window.AretiaWallet` (assets/wallet/wallet.js, Wallet Standard). This page
 * never sees a key or a recovery phrase. It reads public data for the
 * connected address and hands trades to the Jupiter widget, which asks the
 * visitor's own wallet to sign.
 *
 * Data (the connected address goes to these, and nowhere else):
 *   - Jupiter  ultra/balances   token balances for the address
 *   - Jupiter  tokens/v2/search names, icons and prices for those mints
 *   - DexScreener tokens/v1     price for mints Jupiter has no price for (e.g. ACT)
 *   - Solana RPC (publicnode)   recent signatures for the Activity tab
 *
 * Token names, symbols and icons come from third parties and may be hostile
 * (spam tokens are common), so everything is rendered with textContent and
 * element creation, never innerHTML.
 */

const ACT_MINT = '7Ut5njM9ajGDjP83WvJmvrAcfi9JoVYrHSK5x5sSFrTG';
const SOL_MINT = 'So11111111111111111111111111111111111111112';
const RPC_URL = 'https://solana-rpc.publicnode.com';
const JUPITER_PLUGIN = 'https://plugin.jup.ag/plugin-v1.js';
const MAX_MINTS = 100;

interface WalletState {
  account: { address: string } | null;
  connecting: boolean;
  walletName: string | null;
}
interface AretiaWalletApi {
  getState(): WalletState;
  subscribe(fn: (s: WalletState) => void): () => void;
  getWalletContextState(): unknown;
}
interface JupiterApi {
  init(options: Record<string, unknown>): void;
}
declare global {
  interface Window {
    AretiaWallet?: AretiaWalletApi;
    Jupiter?: JupiterApi;
  }
}

export interface Holding {
  mint: string;
  symbol: string;
  name: string;
  icon: string | null;
  amount: number;
  price: number | null;
  priceSource: 'Jupiter' | 'DexScreener' | null;
  /** Value is `amount x price`, or null without a price. */
  value: number | null;
  /** The only pool behind the price holds under $10,000, so the dollar value is only indicative. */
  thin: boolean;
}

// ---------------------------------------------------------------- formatting

export function formatAmount(n: number): string {
  if (n === 0) return '0';
  const digits = n >= 1000 ? 2 : n >= 1 ? 4 : 6;
  return n.toLocaleString('en-US', { maximumFractionDigits: digits });
}
const USD = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' });
export function formatUsd(n: number): string {
  // Sub-cent prices need more places than a currency format gives.
  if (n > 0 && n < 0.01) return `$${n.toPrecision(2)}`;
  return USD.format(n);
}
export function shorten(address: string, chars = 4): string {
  return address.length <= chars * 2 + 3 ? address : `${address.slice(0, chars)}…${address.slice(-chars)}`;
}
export function relativeTime(seconds: number, now = Date.now() / 1000): string {
  const d = Math.max(0, Math.round(now - seconds));
  if (d < 60) return 'just now';
  if (d < 3600) return `${Math.floor(d / 60)} min ago`;
  if (d < 86400) return `${Math.floor(d / 3600)} h ago`;
  return `${Math.floor(d / 86400)} d ago`;
}
/** Only https image URLs are ever used as an icon source. */
export function safeIcon(url: unknown): string | null {
  return typeof url === 'string' && url.startsWith('https://') ? url : null;
}

// ---------------------------------------------------------------- data

async function getJson<T>(url: string, init?: RequestInit): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 15_000);
  try {
    const res = await fetch(url, { ...init, signal: controller.signal });
    if (!res.ok) throw new Error(`${new URL(url).hostname} answered ${res.status}`);
    return (await res.json()) as T;
  } finally {
    clearTimeout(timer);
  }
}

interface JupBalance {
  uiAmount?: number;
}
interface JupToken {
  id: string;
  name?: string;
  symbol?: string;
  icon?: string;
  usdPrice?: number;
}
interface DexPair {
  baseToken?: { address?: string };
  priceUsd?: string;
  liquidity?: { usd?: number };
}

/** Everything the connected address holds, with names, icons and a price where one exists. */
export async function loadHoldings(address: string): Promise<Holding[]> {
  const balances = await getJson<Record<string, JupBalance>>(`https://lite-api.jup.ag/ultra/v1/balances/${address}`);
  const entries = Object.entries(balances)
    .map(([key, b]) => [key === 'SOL' ? SOL_MINT : key, Number(b.uiAmount ?? 0)] as const)
    .filter(([, amount]) => Number.isFinite(amount) && amount > 0)
    .slice(0, MAX_MINTS);
  if (entries.length === 0) return [];
  const mints = entries.map(([mint]) => mint);

  const meta = new Map<string, JupToken>();
  try {
    for (const t of await getJson<JupToken[]>(`https://lite-api.jup.ag/tokens/v2/search?query=${mints.join(',')}`)) meta.set(t.id, t);
  } catch {
    // Names and icons are decoration; balances still show without them.
  }

  const prices = new Map<string, { price: number; source: 'Jupiter' | 'DexScreener'; thin: boolean }>();
  for (const [mint, token] of meta) {
    if (typeof token.usdPrice === 'number' && token.usdPrice > 0) prices.set(mint, { price: token.usdPrice, source: 'Jupiter', thin: false });
  }
  const unpriced = mints.filter((m) => !prices.has(m));
  if (unpriced.length > 0) {
    try {
      const pairs = await getJson<DexPair[]>(`https://api.dexscreener.com/tokens/v1/solana/${unpriced.slice(0, 30).join(',')}`);
      const best = new Map<string, DexPair>();
      for (const p of pairs) {
        const mint = p.baseToken?.address;
        if (!mint || !p.priceUsd) continue;
        if (!best.has(mint) || (p.liquidity?.usd ?? 0) > (best.get(mint)?.liquidity?.usd ?? 0)) best.set(mint, p);
      }
      for (const [mint, p] of best) {
        const price = Number(p.priceUsd);
        if (Number.isFinite(price) && price > 0) prices.set(mint, { price, source: 'DexScreener', thin: (p.liquidity?.usd ?? 0) < 10_000 });
      }
    } catch {
      // No fallback price: those rows show "—" rather than a guess.
    }
  }

  return entries
    .map(([mint, amount]): Holding => {
      const t = meta.get(mint);
      const p = prices.get(mint);
      const native = mint === SOL_MINT; // Jupiter names this mint "Wrapped SOL"; the balance here is the native coin
      return {
        mint,
        symbol: native ? 'SOL' : (t?.symbol ?? '').slice(0, 20) || shorten(mint),
        name: native ? 'Solana' : (t?.name ?? '').slice(0, 60),
        icon: safeIcon(t?.icon),
        amount,
        price: p?.price ?? null,
        priceSource: p?.source ?? null,
        value: p ? amount * p.price : null,
        thin: p?.thin ?? false,
      };
    })
    .sort((a, b) => (b.value ?? -1) - (a.value ?? -1) || b.amount - a.amount);
}

export interface ActivityItem {
  signature: string;
  time: number | null;
  ok: boolean;
}

export async function loadActivity(address: string): Promise<ActivityItem[]> {
  const body = { jsonrpc: '2.0', id: 1, method: 'getSignaturesForAddress', params: [address, { limit: 25 }] };
  const res = await getJson<{ result?: { signature: string; blockTime: number | null; err: unknown }[]; error?: { message: string } }>(RPC_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.result) throw new Error(res.error?.message ?? 'The RPC returned no result');
  return res.result.map((s) => ({ signature: s.signature, time: s.blockTime, ok: s.err === null }));
}

// ---------------------------------------------------------------- DOM helpers

function el<K extends keyof HTMLElementTagNameMap>(tag: K, props: { class?: string; text?: string; attrs?: Record<string, string> } = {}, children: (Node | null)[] = []): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (props.class) node.className = props.class;
  if (props.text !== undefined) node.textContent = props.text;
  for (const [k, v] of Object.entries(props.attrs ?? {})) node.setAttribute(k, v);
  for (const c of children) if (c) node.append(c);
  return node;
}
const $ = <T extends HTMLElement>(sel: string) => document.querySelector<T>(sel);

function avatar(h: { icon: string | null; symbol: string }): HTMLElement {
  if (h.icon) {
    const img = el('img', { class: 'wapp-avatar', attrs: { alt: '', width: '32', height: '32', loading: 'lazy', referrerpolicy: 'no-referrer' } });
    img.src = h.icon;
    img.addEventListener('error', () => img.replaceWith(el('span', { class: 'wapp-avatar', text: h.symbol.slice(0, 2).toUpperCase() })), { once: true });
    return img;
  }
  return el('span', { class: 'wapp-avatar', text: h.symbol.slice(0, 2).toUpperCase() });
}

// ---------------------------------------------------------------- app

type View = 'dashboard' | 'trade' | 'activity';
const VIEWS: View[] = ['dashboard', 'trade', 'activity'];
const TITLES: Record<View, string> = { dashboard: 'Dashboard', trade: 'Trade', activity: 'Activity' };

export function initWalletApp(): void {
  const root = $<HTMLElement>('[data-wapp]');
  if (!root) return;
  let address: string | null = null;
  let walletName: string | null = null;
  let holdings: Holding[] | null = null;
  let activity: ActivityItem[] | null = null;
  let amountsHidden = false;
  let loadToken = 0;

  const currentView = (): View => {
    const h = location.hash.replace(/^#\/?/, '') as View;
    return VIEWS.includes(h) ? h : 'dashboard';
  };

  // ---- rendering
  function renderChrome(): void {
    const view = currentView();
    root!.dataset.connected = address ? 'true' : 'false';
    root!.dataset.view = view;
    const title = $('[data-title]');
    if (title) title.textContent = TITLES[view];
    // Only the sidebar entries show a current page; other [data-nav] buttons are plain shortcuts.
    document.querySelectorAll<HTMLElement>('.wapp__nav [data-nav]').forEach((b) => {
      if (b.dataset.nav === view) b.setAttribute('aria-current', 'page');
      else b.removeAttribute('aria-current');
    });
    document.querySelectorAll<HTMLElement>('[data-pane]').forEach((p) => (p.hidden = p.dataset.pane !== view));
    const chip = $('[data-account]');
    if (chip) {
      chip.textContent = '';
      if (address) chip.append(el('strong', { text: walletName ?? 'Wallet' }), el('span', { class: 'wapp-mono', text: shorten(address) }));
      else chip.append(el('strong', { text: 'Not connected' }), el('span', { text: 'Connect a wallet to begin' }));
    }
    const addr = $('[data-address]');
    if (addr) addr.textContent = address ?? '';
    const scan = $<HTMLAnchorElement>('[data-solscan]');
    if (scan && address) scan.href = `https://solscan.io/account/${address}`;
  }

  function renderDashboard(error?: string): void {
    const total = $('[data-total]');
    const sub = $('[data-total-sub]');
    const body = $('[data-holdings]');
    if (!total || !sub || !body) return;
    body.textContent = '';
    if (!address) return;
    if (error) {
      total.textContent = '—';
      sub.textContent = '';
      body.append(el('p', { class: 'wapp-error', text: `Couldn't load balances: ${error}` }));
      return;
    }
    if (holdings === null) {
      total.textContent = '…';
      sub.textContent = 'Loading balances';
      return;
    }
    const priced = holdings.filter((h) => h.value !== null);
    const sum = priced.reduce((s, h) => s + (h.value ?? 0), 0);
    total.textContent = priced.length > 0 ? (amountsHidden ? '••••' : formatUsd(sum)) : '—';
    sub.textContent = holdings.length === 0 ? 'This wallet holds no tokens yet.' : `${priced.length} of ${holdings.length} token${holdings.length === 1 ? '' : 's'} priced`;
    if (holdings.length === 0) return;

    const mask = (t: string) => (amountsHidden ? '••••' : t);
    const table = el('table', { class: 'wapp-table' });
    table.append(
      el('thead', {}, [el('tr', {}, ['Asset', 'Balance', 'Price', 'Value', 'Weight'].map((t, i) => el('th', { text: t, class: i > 0 && i < 4 ? 'num' : '' })))]),
    );
    const tbody = el('tbody');
    for (const h of holdings) {
      const weight = h.value !== null && sum > 0 ? (h.value / sum) * 100 : null;
      const bar = el('span', { class: 'wapp-bar' }, [el('span')]);
      (bar.firstElementChild as HTMLElement).style.width = `${Math.max(0, Math.min(100, weight ?? 0))}%`;
      const priceCell = el('td', { class: 'num' });
      priceCell.append(h.price === null ? '—' : formatUsd(h.price));
      if (h.priceSource) priceCell.title = h.thin ? `Price from ${h.priceSource}; the pool behind it is thin, so this is only indicative` : `Price from ${h.priceSource}`;
      if (h.thin) priceCell.append(el('span', { class: 'wapp-flag', text: ' thin' }));
      tbody.append(
        el('tr', {}, [
          el('td', {}, [el('div', { class: 'wapp-asset' }, [avatar(h), el('div', {}, [el('strong', { text: h.symbol }), el('span', { class: 'wapp-sub', text: h.name })])])]),
          el('td', { class: 'num', text: mask(formatAmount(h.amount)) }),
          priceCell,
          el('td', { class: 'num', text: h.value === null ? '—' : mask(formatUsd(h.value)) }),
          el('td', {}, [weight === null ? el('span', { text: '—' }) : el('span', { class: 'wapp-weight' }, [bar, el('span', { text: `${weight < 1 ? '<1' : Math.round(weight)}%` })])]),
        ]),
      );
    }
    table.append(tbody);
    body.append(table);
  }

  function renderActivity(error?: string): void {
    const body = $('[data-activity]');
    if (!body) return;
    body.textContent = '';
    if (!address) return;
    if (error) return void body.append(el('p', { class: 'wapp-error', text: `Couldn't load activity: ${error}` }));
    if (activity === null) return void body.append(el('p', { class: 'wapp-sub', text: 'Loading activity…' }));
    if (activity.length === 0) return void body.append(el('p', { class: 'wapp-sub', text: 'No transactions found for this address.' }));
    const table = el('table', { class: 'wapp-table' });
    table.append(el('thead', {}, [el('tr', {}, ['When', 'Transaction', 'Status'].map((t) => el('th', { text: t })))]));
    const tbody = el('tbody');
    for (const a of activity) {
      const link = el('a', { class: 'wapp-mono', text: shorten(a.signature, 8), attrs: { href: `https://solscan.io/tx/${a.signature}`, target: '_blank', rel: 'noopener noreferrer' } });
      tbody.append(el('tr', {}, [el('td', { text: a.time ? relativeTime(a.time) : '—' }), el('td', {}, [link]), el('td', {}, [el('span', { class: `wapp-status ${a.ok ? 'is-ok' : 'is-fail'}`, text: a.ok ? 'Success' : 'Failed' })])]));
    }
    table.append(tbody);
    body.append(table);
  }

  // ---- loading
  async function refresh(): Promise<void> {
    const mine = ++loadToken;
    holdings = null;
    activity = null;
    renderDashboard();
    renderActivity();
    if (!address) return;
    const a = address;
    const [h, act] = await Promise.allSettled([loadHoldings(a), loadActivity(a)]);
    if (mine !== loadToken) return; // the wallet changed while this was loading
    if (h.status === 'fulfilled') {
      holdings = h.value;
      renderDashboard();
    } else renderDashboard(h.reason instanceof Error ? h.reason.message : 'unknown error');
    if (act.status === 'fulfilled') {
      activity = act.value;
      renderActivity();
    } else renderActivity(act.reason instanceof Error ? act.reason.message : 'unknown error');
  }

  // ---- trade widget (loaded only when the Trade tab is first opened)
  let jupiterStarted = false;
  function startJupiter(): void {
    if (jupiterStarted) return;
    jupiterStarted = true;
    const init = () => {
      window.Jupiter?.init({
        displayMode: 'integrated',
        integratedTargetId: 'jupiter-terminal',
        endpoint: RPC_URL,
        enableWalletPassthrough: true,
        passthroughWalletContextState: window.AretiaWallet?.getWalletContextState(),
        formProps: { initialInputMint: SOL_MINT, initialOutputMint: ACT_MINT, fixedOutputMint: false },
      });
    };
    if (window.Jupiter) return init();
    const s = document.createElement('script');
    s.src = JUPITER_PLUGIN;
    s.dataset.preload = '';
    s.onload = () => {
      // The plugin finishes registering window.Jupiter just after load.
      let tries = 0;
      const t = setInterval(() => {
        if (window.Jupiter || ++tries > 50) {
          clearInterval(t);
          if (window.Jupiter) init();
        }
      }, 100);
    };
    document.head.append(s);
  }

  // ---- wiring
  function onRoute(): void {
    renderChrome();
    if (currentView() === 'trade') startJupiter();
  }
  window.addEventListener('hashchange', onRoute);
  document.querySelectorAll<HTMLElement>('[data-nav]').forEach((b) => b.addEventListener('click', () => (location.hash = `#/${b.dataset.nav}`)));

  $('[data-connect]')?.addEventListener('click', () => {
    const navButton = document.querySelector<HTMLButtonElement>('[data-aretia-wallet-mount] button');
    navButton?.click();
  });
  $('[data-refresh]')?.addEventListener('click', () => void refresh());
  $('[data-hide]')?.addEventListener('click', (e) => {
    amountsHidden = !amountsHidden;
    (e.currentTarget as HTMLElement).setAttribute('aria-pressed', String(amountsHidden));
    renderDashboard();
  });
  $('[data-copy]')?.addEventListener('click', async (e) => {
    if (!address) return;
    const btn = e.currentTarget as HTMLElement;
    try {
      await navigator.clipboard.writeText(address);
      btn.textContent = 'Copied';
      setTimeout(() => (btn.textContent = 'Copy address'), 1500);
    } catch {
      // The address is also shown as selectable text.
    }
  });
  $('[data-receive]')?.addEventListener('click', () => {
    const panel = $<HTMLElement>('[data-receive-panel]');
    if (panel) panel.hidden = !panel.hidden;
  });

  function onWallet(state: WalletState): void {
    const next = state.account?.address ?? null;
    walletName = state.walletName;
    if (next === address) return void renderChrome();
    address = next;
    renderChrome();
    void refresh();
  }
  const wire = () => {
    const api = window.AretiaWallet;
    if (!api) return false;
    api.subscribe(onWallet);
    onWallet(api.getState());
    return true;
  };
  onRoute();
  if (!wire()) {
    // wallet.js loads just before this script; wait briefly if it is a tick behind.
    let tries = 0;
    const t = setInterval(() => {
      if (wire() || ++tries > 40) clearInterval(t);
    }, 100);
  }
}
