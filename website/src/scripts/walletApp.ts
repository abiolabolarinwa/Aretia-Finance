import { ACT as ACT_INFO } from '../data/site';
import { initSwings } from './walletSwings';
import { initWalletLock } from './walletLock';
import { initNotifications } from './walletNotifications';
import { sidebarItemFor } from './walletNav';
import { PREFILL_SWAP_EVENT } from './walletSearch';
import { lamportsToBalance, mergeBalances, parseTokenAccountsResult, splitByPrice, TOKEN_2022_PROGRAM_ID, TOKEN_PROGRAM_ID, type RawBalance } from './walletHoldings';
import { loadWeb3, planSend, rpcCall, resolveName, signAndSubmit, simulatePlan, waitForConfirmation, type SendPlan, type SendRequest, type Simulation } from './walletSend';
import { BASE_FEE_LAMPORTS, candidatesFor, fromSmallestUnit, isSolanaAddress, parseIntent, shieldFindings, toSmallestUnit, type AccountSnapshot, type Candidate, type Finding, type ParsedIntent } from './walletTools';

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
 *   - Solana RPC getTokenAccountsByOwner  every token account the address owns, read from the chain, so a token
 *                               Jupiter's list leaves out (or a Jupiter outage) does not hide a holding
 *   - Jupiter  tokens/v2/search names, icons and prices for those mints
 *   - DexScreener tokens/v1     price for mints Jupiter has no price for (e.g. ACT)
 *   - Solana RPC (via /api/rpc, public fallback)  recent signatures for the Activity tab, the
 *                               account read behind Shield, and everything Send needs
 *
 * Token names, symbols and icons come from third parties and may be hostile
 * (spam tokens are common), so everything is rendered with textContent and
 * element creation, never innerHTML.
 */

const SOL_MINT = 'So11111111111111111111111111111111111111112';
const MAX_MINTS = 100;
/** Below this much SOL a swap can fail: the network fee, plus about 0.002 SOL to open a new token account. */
const LOW_SOL = 0.003;
const lowSolMessage = (sol: number): string =>
  `This wallet holds ${formatAmount(sol)} SOL. A swap needs a little SOL for the network fee, and your first ACT purchase also needs about 0.002 SOL to open your ACT account. Add some SOL first, or the swap will fail.`;

interface WalletState {
  account: { address: string } | null;
  connecting: boolean;
  walletName: string | null;
  /** The wallet's own logo as a base64 data URI (checked in wallet.js). Absent on older cached copies. */
  walletIcon?: string | null;
}
interface AretiaWalletApi {
  getState(): WalletState;
  disconnect(): Promise<void>;
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
  /** Exact balance in the smallest unit (a decimal string), when Jupiter gave it. */
  raw: string | null;
  /** Decimal places, from Jupiter's token data (9 for native SOL); null when unknown. */
  decimals: number | null;
  price: number | null;
  priceSource: 'Jupiter' | 'DexScreener' | 'GeckoTerminal' | null;
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
  /** Exact balance in the token's smallest unit. */
  amount?: string;
}
interface JupToken {
  id: string;
  name?: string;
  symbol?: string;
  icon?: string;
  usdPrice?: number;
  decimals?: number;
}
interface DexPair {
  baseToken?: { address?: string };
  priceUsd?: string;
  liquidity?: { usd?: number };
}

const inBatches = <T>(items: readonly T[], size: number): T[][] => Array.from({ length: Math.ceil(items.length / size) }, (_, i) => items.slice(i * size, (i + 1) * size));

/** Jupiter's list of what the address holds, one entry per mint. */
async function fetchJupiterBalances(address: string): Promise<RawBalance[]> {
  const balancesUrl = `https://lite-api.jup.ag/ultra/v1/balances/${address}`;
  let balances: Record<string, JupBalance>;
  try {
    balances = await getJson<Record<string, JupBalance>>(balancesUrl);
  } catch {
    // Jupiter's free API is occasionally slow or throttled; one more try before giving up.
    balances = await getJson<Record<string, JupBalance>>(balancesUrl);
  }
  return Object.entries(balances)
    .map(([key, b]): RawBalance => ({
      mint: key === 'SOL' ? SOL_MINT : key,
      amount: Number(b.uiAmount ?? 0),
      raw: typeof b.amount === 'string' && /^\d+$/.test(b.amount) ? b.amount : null,
      decimals: null,
    }))
    .filter((b) => Number.isFinite(b.amount) && b.amount > 0);
}

/**
 * Every token account the address owns, read from the chain under both token programs (the original SPL Token
 * program and Token-2022). This does not depend on any list, so it finds tokens Jupiter does not index. If one
 * program's read fails the other's results are still used; only if both fail is it an error.
 */
async function discoverTokensOnChain(address: string): Promise<RawBalance[]> {
  const read = (programId: string) => rpcCall<unknown>('getTokenAccountsByOwner', [address, { programId }, { encoding: 'jsonParsed' }]);
  const [spl, token2022] = await Promise.allSettled([read(TOKEN_PROGRAM_ID), read(TOKEN_2022_PROGRAM_ID)]);
  if (spl.status === 'rejected' && token2022.status === 'rejected') throw spl.reason;
  return [
    ...(spl.status === 'fulfilled' ? parseTokenAccountsResult(spl.value) : []),
    ...(token2022.status === 'fulfilled' ? parseTokenAccountsResult(token2022.value) : []),
  ];
}

/** Everything the connected address holds, with names, icons and a price where one exists. */
export async function loadHoldings(address: string): Promise<Holding[]> {
  const [jupiter, onChain, lamports] = await Promise.allSettled([
    fetchJupiterBalances(address),
    discoverTokensOnChain(address),
    rpcCall<{ value: number }>('getBalance', [address]),
  ]);
  if (jupiter.status === 'rejected' && onChain.status === 'rejected') throw jupiter.reason;
  const native = lamports.status === 'fulfilled' ? lamportsToBalance(SOL_MINT, lamports.value.value) : null;
  const merged = mergeBalances(jupiter.status === 'fulfilled' ? jupiter.value : [], [
    ...(onChain.status === 'fulfilled' ? onChain.value : []),
    ...(native ? [native] : []),
  ]);
  // The native coin first, so a wallet with a great many token accounts can never push SOL out of the lookup limit.
  const ordered = [...merged.filter((b) => b.mint === SOL_MINT), ...merged.filter((b) => b.mint !== SOL_MINT)].slice(0, MAX_MINTS);
  const entries = ordered.map((b) => [b.mint, b.amount, b.raw] as const);
  if (entries.length === 0) return [];
  const mints = entries.map(([mint]) => mint);
  const rawByMint = new Map(entries.map(([mint, , raw]) => [mint, raw] as const));
  const decimalsByMint = new Map(ordered.map((b) => [b.mint, b.decimals] as const));

  const meta = new Map<string, JupToken>();
  try {
    for (const t of await getJson<JupToken[]>(`https://lite-api.jup.ag/tokens/v2/search?query=${mints.join(',')}`)) meta.set(t.id, t);
  } catch {
    // Names and icons are decoration; balances still show without them.
  }

  const prices = new Map<string, { price: number; source: 'Jupiter' | 'DexScreener' | 'GeckoTerminal'; thin: boolean }>();
  for (const [mint, token] of meta) {
    if (typeof token.usdPrice === 'number' && token.usdPrice > 0) prices.set(mint, { price: token.usdPrice, source: 'Jupiter', thin: false });
  }
  // Both fallbacks take at most 30 mints per request. A wallet can hold more unpriced mints than that (and unpriced
  // tokens are hidden by default), so every batch is asked, not just the first.
  const unpriced = mints.filter((m) => !prices.has(m));
  await Promise.allSettled(
    inBatches(unpriced, 30).map(async (batch) => {
      const pairs = await getJson<DexPair[]>(`https://api.dexscreener.com/tokens/v1/solana/${batch.join(',')}`);
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
    }),
  );
  // A token neither Jupiter nor DexScreener prices (DexScreener can lag on a new pool) may still be priced by
  // GeckoTerminal, which reads the pool from the chain. A failed batch leaves those rows at "—" rather than a guess.
  const stillUnpriced = mints.filter((m) => !prices.has(m));
  await Promise.allSettled(
    inBatches(stillUnpriced, 30).map(async (batch) => {
      const r = await getJson<{ data?: { attributes?: { token_prices?: Record<string, string> } } }>(`https://api.geckoterminal.com/api/v2/simple/networks/solana/token_price/${batch.join(',')}`);
      for (const [mint, value] of Object.entries(r.data?.attributes?.token_prices ?? {})) {
        const price = Number(value);
        if (batch.includes(mint) && Number.isFinite(price) && price > 0) prices.set(mint, { price, source: 'GeckoTerminal', thin: false });
      }
    }),
  );

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
        raw: rawByMint.get(mint) ?? null,
        decimals: native ? 9 : (decimalsByMint.get(mint) ?? (typeof t?.decimals === 'number' ? t.decimals : null)),
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
  const sigs = await rpcCall<{ signature: string; blockTime: number | null; err: unknown }[]>('getSignaturesForAddress', [address, { limit: 25 }]);
  return sigs.map((s) => ({ signature: s.signature, time: s.blockTime, ok: s.err === null }));
}

/** One `getAccountInfo` read with no data, enough to tell a wallet from a program or an unused address. */
export async function loadAccountSnapshot(address: string): Promise<AccountSnapshot> {
  const result = await rpcCall<{ value: { executable: boolean; owner: string } | null }>('getAccountInfo', [address, { encoding: 'base64', dataSlice: { offset: 0, length: 0 } }]);
  const v = result.value;
  return v ? { exists: true, executable: v.executable, owner: v.owner } : { exists: false, executable: false, owner: null };
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

type View = 'dashboard' | 'send' | 'swap' | 'carbon' | 'swings' | 'favourites' | 'activity' | 'shield' | 'intent' | 'safesend' | 'universal';
const VIEWS: View[] = ['dashboard', 'send', 'swap', 'carbon', 'swings', 'favourites', 'activity', 'shield', 'intent', 'safesend', 'universal'];
const TITLES: Record<View, string> = { dashboard: 'Dashboard', send: 'Pay', swap: 'Swap', carbon: 'Carbon Credit', swings: 'Markets', favourites: 'Favourites', activity: 'Activity', shield: 'Shield', intent: 'Intent', safesend: 'SafeSend', universal: 'Universal' };

/**
 * The sidebar can be folded down to an icon strip. The choice is remembered on this device. The width is one
 * CSS variable on the page, so the top bar and the content move with it.
 */
function initSidebar(): void {
  const root = document.documentElement;
  const wapp = document.querySelector<HTMLElement>('[data-wapp]');
  const side = document.querySelector<HTMLElement>('.wapp__side');
  if (!wapp || !side) return;

  // The sidebar always rests as an icon rail; it opens over the page while the pointer is on it
  // or keyboard focus is inside it, and closes when both leave.
  root.dataset.wappSidebar = 'collapsed';
  let hover = false;
  let focus = false;
  const sync = (): void => {
    if (hover || focus || 'wappHold' in root.dataset) root.dataset.wappPeek = '';
    else delete root.dataset.wappPeek;
  };
  // The notification list keeps the sidebar open beside it while it is showing.
  window.addEventListener('aretia:sidebar-hold', sync);
  side.addEventListener('mouseenter', () => { hover = true; sync(); });
  side.addEventListener('mouseleave', () => { hover = false; sync(); });
  side.addEventListener('focusin', (e) => { focus = (e.target as HTMLElement).matches(':focus-visible'); sync(); });
  side.addEventListener('focusout', () => { focus = false; sync(); });
  // Turn the width animation on only after the first paint, so a remembered state does not slide in on load.
  requestAnimationFrame(() => requestAnimationFrame(() => wapp.classList.add('wapp--ready')));
}

export function initWalletApp(): void {
  const root = $<HTMLElement>('[data-wapp]');
  if (!root) return;
  let address: string | null = null;
  let walletName: string | null = null;
  let walletIcon: string | null = null;
  let holdings: Holding[] | null = null;
  let holdingsFailed = false;
  let activity: ActivityItem[] | null = null;
  let amountsHidden = false;
  // Tokens with no price (mostly airdropped spam) are hidden from the table unless this is on. Remembered on this device.
  const UNPRICED_PREF_KEY = 'aretia.wallet.showUnpriced';
  const readShowUnpriced = (): boolean => {
    try {
      return localStorage.getItem(UNPRICED_PREF_KEY) === '1';
    } catch {
      return false; // storage can be blocked; the default is "hidden"
    }
  };
  let showUnpriced = readShowUnpriced();
  let loadToken = 0;
  const swings = initSwings({ getAddress: () => address, getWalletName: () => walletName, getHoldings: () => holdings, refresh: () => refresh() });

  const currentView = (): View => {
    const raw = location.hash.replace(/^#\/?/, '');
    // Trade was folded into Swap, which covers more networks; old links still land somewhere useful.
    const h = (raw === 'trade' ? 'swap' : raw) as View;
    return VIEWS.includes(h) ? h : 'dashboard';
  };

  // ---- rendering
  function renderChrome(): void {
    const view = currentView();
    root!.dataset.connected = address ? 'true' : 'false';
    // Favourites is the Markets list filtered to the person's favourites, so it takes the Markets layout.
    root!.dataset.view = view === 'favourites' ? 'swings' : view;
    root!.dataset.page = view;
    const title = $('[data-title]');
    if (title) title.textContent = TITLES[view];
    // Only the sidebar entries show a current page; other [data-nav] buttons are plain shortcuts.
    document.querySelectorAll<HTMLElement>('.wapp__nav [data-nav]').forEach((b) => {
      if (b.dataset.nav === sidebarItemFor(view)) b.setAttribute('aria-current', 'page');
      else b.removeAttribute('aria-current');
    });
    // The Swap page shows the same panel the Markets page is built on.
    const pane = view === 'swap' || view === 'favourites' ? 'swings' : view;
    document.querySelectorAll<HTMLElement>('[data-pane]').forEach((p) => (p.hidden = p.dataset.pane !== pane));
    const chip = $('[data-account]');
    if (chip) {
      chip.textContent = '';
      if (address) {
        if (walletIcon) {
          const logo = el('img', { attrs: { alt: '', width: '34', height: '34', referrerpolicy: 'no-referrer' } });
          logo.src = walletIcon;
          chip.append(logo);
        }
        chip.append(el('div', {}, [el('strong', { text: walletName ?? 'Wallet' }), el('span', { class: 'wapp-mono', text: shorten(address) })]));
      } else chip.append(el('div', {}, [el('strong', { text: 'Not connected' }), el('span', { text: 'Connect a wallet to begin' })]));
    }
    if (view === 'send') void loadMarketplace(); // the Buy card sits beside Send; it loads once
    const refresh = $<HTMLElement>('[data-refresh]');
    if (refresh) refresh.hidden = !(address && (view === 'dashboard' || view === 'activity'));
    const addr = $('[data-address]');
    if (addr) addr.textContent = address ?? '';
    const scan = $<HTMLAnchorElement>('[data-solscan]');
    if (scan && address) scan.href = `https://solscan.io/account/${address}`;
  }

  /** The overview card on the dashboard: wallet name, token count and the top few holdings. */
  function renderTopAssets(): void {
    const name = $('[data-wallet-name]');
    const count = $('[data-token-count]');
    const list = $('[data-top-assets]');
    if (name) name.textContent = address ? (walletName ?? 'Wallet') : '—';
    if (count) count.textContent = holdings ? String(holdings.length) : '—';
    if (!list) return;
    list.textContent = '';
    if (!address) return;
    if (holdingsFailed) return void list.append(el('li', { class: 'wapp-sub', text: "Couldn't load balances." }));
    if (holdings === null) return void list.append(el('li', { class: 'wapp-sub', text: 'Loading balances…' }));
    if (holdings.length === 0) return void list.append(el('li', { class: 'wapp-sub', text: 'This wallet holds no tokens yet.' }));
    const mask = (text: string) => (amountsHidden ? '••••' : text);
    for (const h of holdings.slice(0, 4)) {
      list.append(
        el('li', {}, [
          avatar(h),
          el('div', { class: 'wapp__hero-asset-name' }, [el('strong', { text: h.symbol }), el('span', { text: h.name })]),
          el('div', { class: 'wapp__hero-asset-amt' }, [el('strong', { text: mask(formatAmount(h.amount)) }), el('span', { text: h.value === null ? '' : mask(formatUsd(h.value)) })]),
        ]),
      );
    }
  }

  function renderDashboard(error?: string): void {
    renderTopAssets();
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
    const { shown, hiddenUnpriced } = splitByPrice(holdings, SOL_MINT, showUnpriced);
    // How many tokens the toggle governs: those with no price, other than the native coin.
    const unpricedCount = priced.length > 0 ? holdings.filter((h) => h.value === null && h.mint !== SOL_MINT).length : 0;
    total.textContent = priced.length > 0 ? (amountsHidden ? '••••' : formatUsd(sum)) : '—';
    sub.textContent = holdings.length === 0 ? 'This wallet holds no tokens yet.' : `${priced.length} of ${holdings.length} token${holdings.length === 1 ? '' : 's'} priced`;
    if (holdings.length === 0) return;

    const mask = (t: string) => (amountsHidden ? '••••' : t);
    const table = el('table', { class: 'wapp-table' });
    table.append(
      el('thead', {}, [el('tr', {}, ['Asset', 'Balance', 'Price', 'Value', 'Weight'].map((t, i) => el('th', { text: t, class: i > 0 && i < 4 ? 'num' : '' })))]),
    );
    const tbody = el('tbody');
    for (const h of shown) {
      const weight = h.value !== null && sum > 0 ? (h.value / sum) * 100 : null;
      const bar = el('span', { class: 'wapp-bar' }, [el('span')]);
      (bar.firstElementChild as HTMLElement).style.width = `${Math.max(0, Math.min(100, weight ?? 0))}%`;
      const priceCell = el('td', { class: 'num' });
      priceCell.append(h.price === null ? '—' : formatUsd(h.price));
      if (h.priceSource) priceCell.title = h.thin ? `Price from a public market feed; the pool behind it is thin, so this is only indicative` : 'Price from a public market feed';
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

    if (unpricedCount > 0) {
      const noun = `unpriced token${unpricedCount === 1 ? '' : 's'}`;
      const toggle = el('button', {
        class: 'wapp__btn wapp__btn--ghost wapp-unpriced-toggle',
        text: showUnpriced ? `Hide ${unpricedCount} ${noun}` : `Show ${hiddenUnpriced.length} ${noun}`,
        attrs: { type: 'button', 'aria-pressed': String(showUnpriced), 'data-unpriced-toggle': '' },
      });
      toggle.addEventListener('click', () => {
        showUnpriced = !showUnpriced;
        try {
          localStorage.setItem(UNPRICED_PREF_KEY, showUnpriced ? '1' : '0');
        } catch {
          // Not remembered; the choice still applies until the page is closed.
        }
        renderDashboard();
      });
      body.append(toggle, el('p', { class: 'wapp-sub', text: 'Tokens with no market price are often airdropped spam, so they are hidden by default. They are still in your wallet.' }));
    }
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
    holdingsFailed = false;
    activity = null;
    renderDashboard();
    renderActivity();
    renderSendAssets();
    if (!address) return;
    const a = address;
    const [h, act] = await Promise.allSettled([loadHoldings(a), loadActivity(a)]);
    if (mine !== loadToken) return; // the wallet changed while this was loading
    if (h.status === 'fulfilled') {
      holdings = h.value;
      renderDashboard();
    } else {
      holdingsFailed = true;
      renderDashboard(h.reason instanceof Error ? h.reason.message : 'unknown error');
    }
    renderSendAssets();
    if (act.status === 'fulfilled') {
      activity = act.value;
      renderActivity();
    } else renderActivity(act.reason instanceof Error ? act.reason.message : 'unknown error');
  }

  // ---- send tab
  let sendBusy = false;
  const sendEls = () => ({
    asset: $<HTMLSelectElement>('[data-send-asset]'),
    to: $<HTMLInputElement>('[data-send-to]'),
    amount: $<HTMLInputElement>('[data-send-amount]'),
    out: $<HTMLElement>('[data-send-review]'),
  });
  const selectedHolding = (): Holding | undefined => {
    const { asset } = sendEls();
    return asset && holdings ? holdings.find((h) => h.mint === asset.value) : undefined;
  };

  function renderSendAssets(): void {
    const { asset } = sendEls();
    if (!asset) return;
    const previous = asset.value;
    asset.textContent = '';
    asset.disabled = true;
    if (!address) return void asset.append(new Option('Connect a wallet first', ''));
    if (holdings === null) return void asset.append(new Option(holdingsFailed ? "Couldn't load your tokens. Use Refresh on the Dashboard." : 'Loading your tokens…', ''));
    if (holdings.length === 0) return void asset.append(new Option('This wallet holds no tokens', ''));
    asset.disabled = false;
    for (const h of holdings) asset.append(new Option(`${h.symbol} · ${formatAmount(h.amount)}${h.mint === SOL_MINT ? '' : ` · ${shorten(h.mint)}`}`, h.mint));
    if (holdings.some((h) => h.mint === previous)) asset.value = previous;
  }

  /** Called by Intent: fills the Send form and opens it. Nothing is reviewed or sent yet. */
  function prefillSend(mint: string, recipient: string, amount: string): void {
    const { asset, to, amount: amountField, out } = sendEls();
    if (asset) asset.value = mint;
    if (to) to.value = recipient;
    if (amountField) amountField.value = amount;
    if (out) out.textContent = '';
    location.hash = '#/send';
  }

  const friendlyError = (e: unknown): string => {
    const m = e instanceof Error ? e.message : 'unknown error';
    return /reject|declin|denied|cancel/i.test(m) ? 'You declined the request in your wallet. Nothing was sent.' : m;
  };
  const banner = (kind: 'ok' | 'warn' | 'info', text: string) => el('p', { class: `wapp__banner wapp__banner--${kind}`, text });

  function rowsList(rows: [string, Node | string][]): HTMLElement {
    const dl = el('dl', { class: 'wapp__rows' });
    for (const [k, v] of rows) dl.append(el('div', {}, [el('dt', { text: k }), el('dd', {}, [typeof v === 'string' ? document.createTextNode(v) : v])]));
    return dl;
  }

  function renderSendReview(plan: SendPlan, sim: Simulation | null, name: string | null, req: SendRequest, plannedAt: number): void {
    const { out } = sendEls();
    if (!out) return;
    out.textContent = '';
    const card = el('div', { class: 'wapp__result' });
    out.append(card);
    const sol = (lamports: bigint) => `${fromSmallestUnit(lamports, 9)} SOL`;
    const toCell = el('span', {}, [name ? el('strong', { text: `${name} ` }) : null, el('code', { class: 'wapp-mono', text: plan.to })]);
    const rows: [string, Node | string][] = [
      ['You send', `${plan.amountText} ${plan.symbol}`],
      ['To', toCell],
      ['Network fee', `about ${sol(plan.feeLamports)}`],
    ];
    if (plan.createsDestAta) rows.push(['Opens recipient account', `about ${sol(plan.rentLamports)}, paid by you`]);
    card.append(el('strong', { text: 'Review before you sign' }), rowsList(rows));

    if (plan.mint === ACT_INFO.mint) {
      const received = Number(plan.amountText) * (1 - ACT_INFO.transferFee.totalPercent / 100);
      card.append(banner('info', `ACT withholds a ${ACT_INFO.transferFee.totalPercent}% transfer fee, so the recipient receives about ${formatAmount(received)} ACT.`));
    } else if (plan.mayCharge) {
      card.append(banner('info', 'This token may withhold a transfer fee of its own, so the recipient may receive slightly less.'));
    }
    if (plan.blockers.length === 0) for (const f of shieldFindings(plan.recipient, address, plan.to)) card.append(banner(f.severity === 'warning' ? 'warn' : 'info', f.message));
    for (const b of plan.blockers) card.append(banner('warn', b));
    const simBanner = sim ? (sim.ok ? banner('ok', 'Simulation passed: the network would accept this transaction. No funds have moved.') : banner('warn', `Simulation failed, so this was not sent to your wallet: ${sim.error}`)) : null;
    if (simBanner) card.append(simBanner);

    const canGo = plan.blockers.length === 0 && sim?.ok === true;
    const ack = el('input', { attrs: { type: 'checkbox', id: 'send-ack' } });
    if (canGo && plan.needsAck) card.append(el('label', { class: 'wapp__check', attrs: { for: 'send-ack' } }, [ack, el('span', { text: 'This address is owned by another program, not a normal wallet. I understand and want to continue.' })]));

    const status = el('div', { attrs: { 'aria-live': 'polite' } });
    const actions = el('div', { class: 'wapp__row-actions' });
    const confirm = el('button', { class: 'wapp__btn wapp__btn--primary', text: 'Confirm in my wallet', attrs: { type: 'button' } });
    const cancel = el('button', { class: 'wapp__btn wapp__btn--ghost', text: canGo ? 'Cancel' : 'Back', attrs: { type: 'button' } });
    const sync = () => (confirm.disabled = !canGo || sendBusy || (plan.needsAck && !ack.checked));
    sync();
    ack.addEventListener('change', sync);
    cancel.addEventListener('click', () => (out.textContent = ''));
    confirm.addEventListener('click', async () => {
      if (sendBusy) return;
      sendBusy = true;
      sync();
      status.textContent = '';
      status.append(banner('info', 'Waiting for your wallet to approve…'));
      try {
        if (address !== plan.from) throw new Error('The connected wallet changed. Review the transfer again.');
        let active = plan;
        if (Date.now() - plannedAt > 45_000) {
          // The blockhash in the reviewed transaction is about to expire: rebuild it from the same inputs.
          active = await planSend(req);
          const again = active.blockers.length === 0 ? await simulatePlan(active) : null;
          if (active.blockers.length > 0 || !again?.ok) return void renderSendReview(active, again, name, req, Date.now());
        }
        const signature = await signAndSubmit(active);
        status.textContent = '';
        if (simBanner) simBanner.hidden = true; // "no funds have moved" is no longer true once it is sent
        const link = el('a', { text: 'View on Solscan', attrs: { href: `https://solscan.io/tx/${signature}`, target: '_blank', rel: 'noopener noreferrer' } });
        status.append(el('p', { class: 'wapp__banner wapp__banner--info' }, [document.createTextNode('Sent. Waiting for confirmation… '), link]));
        actions.hidden = true;
        const result = await waitForConfirmation(signature);
        status.textContent = '';
        const text = result === 'confirmed' ? 'Confirmed on Solana.' : result === 'failed' ? 'The transaction failed on-chain. Check Solscan for the reason.' : 'Not confirmed yet. It may still land; check Solscan.';
        status.append(el('p', { class: `wapp__banner wapp__banner--${result === 'confirmed' ? 'ok' : result === 'failed' ? 'warn' : 'info'}` }, [document.createTextNode(`${text} `), el('a', { text: 'View on Solscan', attrs: { href: `https://solscan.io/tx/${signature}`, target: '_blank', rel: 'noopener noreferrer' } })]));
        void refresh();
      } catch (e) {
        status.textContent = '';
        status.append(banner('warn', friendlyError(e)));
      } finally {
        sendBusy = false;
        sync();
      }
    });
    actions.append(confirm, cancel);
    if (!canGo) confirm.hidden = true;
    card.append(actions, status);
  }

  async function onSendSubmit(): Promise<void> {
    const { to, amount, out } = sendEls();
    if (!out || !to || !amount) return;
    out.textContent = '';
    const h = selectedHolding();
    const target = to.value.trim();
    const amountText = amount.value.trim();
    if (!address || !h) return void out.append(el('p', { class: 'wapp-error', text: 'Connect a wallet and choose an asset first.' }));
    if (!target || !amountText) return void out.append(el('p', { class: 'wapp-error', text: 'Enter a recipient and an amount.' }));
    out.append(el('p', { class: 'wapp-sub', text: 'Checking the transfer…' }));
    try {
      let recipient = target;
      let name: string | null = null;
      if (!isSolanaAddress(target)) {
        recipient = await resolveName(target);
        name = target;
      }
      const req: SendRequest = { from: address, to: recipient, mint: h.mint === SOL_MINT ? null : h.mint, symbol: h.symbol, amountText };
      const plan = await planSend(req);
      const sim = plan.blockers.length === 0 ? await simulatePlan(plan) : null;
      renderSendReview(plan, sim, name, req, Date.now());
    } catch (e) {
      out.textContent = '';
      out.append(el('p', { class: 'wapp-error', text: friendlyError(e) }));
    }
  }

  $('[data-send-form]')?.addEventListener('submit', (e) => {
    e.preventDefault();
    void onSendSubmit();
  });
  $('[data-send-max]')?.addEventListener('click', () => {
    const h = selectedHolding();
    const { amount } = sendEls();
    if (!h || !amount || h.decimals === null || h.raw === null) return;
    let raw = BigInt(h.raw);
    if (h.mint === SOL_MINT) raw = raw > BASE_FEE_LAMPORTS ? raw - BASE_FEE_LAMPORTS : 0n; // leave the network fee
    amount.value = fromSmallestUnit(raw, h.decimals);
  });

  // ---- Aretia Pay: buy USDT/USDC with local currency (only wired up on builds that include the Buy tab)
  interface RampStatus {
    enabled: boolean;
    providers?: { id: string; name: string; sides: string[] }[];
  }
  interface RampCatalog {
    countries: { code: string; name: string }[];
    fiats: string[];
  }
  const market = { side: 'buy' as 'buy' | 'sell', asset: 'USDC' as 'USDC' | 'USDT', embedded: false, loadState: 'idle' as 'idle' | 'loading' | 'ready' | 'failed', status: null as RampStatus | null, catalog: null as RampCatalog | null, message: null as { kind: 'ok' | 'warn' | 'info'; text: string } | null };

  async function rampApi<T>(body: Record<string, unknown>): Promise<T> {
    const res = await fetch('/api/ramp', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    const data = (await res.json().catch(() => null)) as (T & { error?: string }) | null;
    if (!res.ok || !data) throw new Error(data?.error ?? `The marketplace service answered ${res.status}`);
    return data;
  }

  async function loadMarketplace(): Promise<void> {
    if (!$('[data-market]') || market.loadState === 'loading' || market.loadState === 'ready') return;
    market.loadState = 'loading';
    renderMarketplace();
    try {
      market.status = await rampApi<RampStatus>({ action: 'status' });
      if (market.status.enabled && (market.status.providers?.length ?? 0) > 0) market.catalog = await rampApi<RampCatalog>({ action: 'catalog' });
      market.loadState = 'ready';
    } catch {
      market.loadState = 'failed';
    }
    renderMarketplace();
  }

  function fillSelect(sel: HTMLSelectElement | null, options: { value: string; label: string }[], preferred: string | null): void {
    if (!sel) return;
    const keep = sel.value && options.some((o) => o.value === sel.value) ? sel.value : preferred && options.some((o) => o.value === preferred) ? preferred : '';
    sel.textContent = '';
    if (keep === '') sel.append(new Option('Choose…', ''));
    for (const o of options) sel.append(new Option(o.label, o.value));
    sel.value = keep;
    sel.disabled = options.length === 0;
  }

  function renderMarketplace(): void {
    const root = $('[data-market]');
    if (!root) return;
    document.querySelectorAll<HTMLElement>('[data-side]').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.side === market.side)));
    document.querySelectorAll<HTMLElement>('[data-market-asset]').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.marketAsset === market.asset)));
    const notes = $('[data-market-notes]');
    const list = $('[data-market-providers]');
    const form = $<HTMLElement>('[data-market-form]');
    const embed = $<HTMLElement>('[data-market-embed]');
    if (!notes || !list || !form || !embed) return;
    embed.hidden = !market.embedded;
    if (market.embedded) {
      form.hidden = true;
      list.textContent = '';
      notes.textContent = '';
      return;
    }
    notes.textContent = '';
    list.textContent = '';
    const note = (kind: 'ok' | 'warn' | 'info', text: string) => notes.append(banner(kind, text));

    if (market.loadState === 'loading' || market.loadState === 'idle') return void note('info', 'Loading…');
    if (market.loadState === 'failed' || market.status === null) {
      form.hidden = true;
      return void note('info', "Buying with local currency isn't available here right now.");
    }
    if (!market.status.enabled) {
      form.hidden = true;
      return void note('info', "Buying with local currency isn't open yet.");
    }
    const providers = (market.status.providers ?? []).filter((p) => p.sides.includes(market.side));
    if (market.side === 'sell') {
      form.hidden = true;
      return void note('info', 'Selling USDT or USDC for local currency is not available yet. Buying is.');
    }
    form.hidden = false;
    if (market.catalog) {
      const region = (navigator.language.split('-')[1] ?? '').toUpperCase();
      fillSelect($<HTMLSelectElement>('[data-market-country]'), market.catalog.countries.map((c) => ({ value: c.code, label: c.name })), region);
      fillSelect($<HTMLSelectElement>('[data-market-fiat]'), market.catalog.fiats.map((f) => ({ value: f, label: f.toUpperCase() })), 'usd');
    }
    if (providers.length === 0) note('info', 'No provider is available yet.');
    for (const p of providers) {
      const go = el('button', { class: 'wapp__btn wapp__btn--primary', text: `Continue with ${p.name}`, attrs: { type: 'button' } });
      go.addEventListener('click', () => void openProvider(p.id, p.name));
      list.append(el('div', { class: 'wapp__provider' }, [el('div', {}, [el('strong', { text: p.name }), el('span', { text: `Buy ${market.asset} with local currency` })]), go]));
    }
    if (market.message) note(market.message.kind, market.message.text);
    note('info', `${market.asset} is delivered to ${address ?? 'your wallet'} on Solana. The provider handles identity checks and payment; fees and limits are theirs.`);
  }

  async function openProvider(id: string, name: string): Promise<void> {
    if (!address) return;
    const amountText = $<HTMLInputElement>('[data-market-amount]')?.value.trim() ?? '';
    if (amountText !== '' && !/^\d{1,7}$/.test(amountText)) {
      market.message = { kind: 'warn', text: 'The amount must be a whole number.' };
      return void renderMarketplace();
    }
    const fiat = $<HTMLSelectElement>('[data-market-fiat]')?.value ?? '';
    try {
      const body: Record<string, unknown> = { action: 'session', provider: id, side: market.side, asset: market.asset, wallet: address };
      if (fiat) body.fiat = fiat;
      if (amountText !== '') body.amount = Number(amountText);
      const { url } = await rampApi<{ url: string }>(body);
      if (!embedProvider(url, name)) throw new Error('The provider address was not what was expected, so it was not opened.');
      return void renderMarketplace();
    } catch (e) {
      market.message = { kind: 'warn', text: e instanceof Error ? e.message : 'Could not open the provider.' };
    }
    renderMarketplace();
  }

  /** Opens the provider's checkout inside this page. Only an https MoonPay address is ever framed. */
  function embedProvider(url: string, name: string): boolean {
    const host = $<HTMLElement>('[data-market-embed]');
    if (!host) return false;
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      return false;
    }
    if (parsed.protocol !== 'https:' || !/(^|\.)moonpay\.com$/.test(parsed.hostname)) return false;
    host.textContent = '';
    const frame = el('iframe', {
      class: 'wapp__embed-frame',
      attrs: {
        title: `${name} checkout`,
        // "payment" for card and wallet payments, "camera" for the provider's ID check.
        allow: 'payment; camera',
        referrerpolicy: 'strict-origin-when-cross-origin',
        // No top-navigation: the provider can show pages and pop-ups but cannot send this page elsewhere.
        sandbox: 'allow-scripts allow-same-origin allow-forms allow-popups allow-popups-to-escape-sandbox allow-modals',
      },
    });
    frame.src = url;
    const close = el('button', { class: 'wapp__btn wapp__btn--ghost', text: 'Close checkout', attrs: { type: 'button' } });
    close.addEventListener('click', () => {
      market.embedded = false;
      market.message = null;
      host.textContent = '';
      renderMarketplace();
    });
    const out = el('a', { text: 'Open in a new tab instead', attrs: { href: url, target: '_blank', rel: 'noopener noreferrer' } });
    host.append(
      el('div', { class: 'wapp__embed-bar' }, [el('span', { class: 'wapp__fine', text: `Your ${market.asset} will arrive in this wallet when ${name} finishes.` }), close]),
      frame,
      el('p', { class: 'wapp__fine' }, [out, document.createTextNode(' if the checkout does not load here.')]),
    );
    market.embedded = true;
    return true;
  }

  document.querySelectorAll<HTMLElement>('[data-side]').forEach((b) =>
    b.addEventListener('click', () => {
      market.side = b.dataset.side === 'sell' ? 'sell' : 'buy';
      market.message = null;
      renderMarketplace();
    }),
  );
  document.querySelectorAll<HTMLElement>('[data-market-asset]').forEach((b) =>
    b.addEventListener('click', () => {
      market.asset = b.dataset.marketAsset === 'USDT' ? 'USDT' : 'USDC';
      market.message = null;
      renderMarketplace();
    }),
  );

  // ---- shield tab
  function renderFindings(findings: Finding[]): Node[] {
    if (findings.length === 0) {
      return [el('p', { class: 'wapp__banner wapp__banner--ok', text: 'No risks found. That means nothing unusual was seen, not that the address is safe. Confirm it with the recipient another way before you send.' })];
    }
    return findings.map((f) => el('p', { class: `wapp__banner wapp__banner--${f.severity === 'warning' ? 'warn' : 'info'}`, text: f.message }));
  }

  async function runShield(input: string): Promise<void> {
    const out = $('[data-shield-result]');
    if (!out) return;
    out.textContent = '';
    const value = input.trim();
    if (!value) return;
    if (!isSolanaAddress(value)) {
      out.append(el('p', { class: 'wapp-error', text: "That isn't a valid Solana address. Names such as bob.sns aren't looked up on this page yet, so paste the address itself." }));
      return;
    }
    out.append(el('p', { class: 'wapp-sub', text: 'Checking…' }));
    try {
      const snapshot = await loadAccountSnapshot(value);
      out.textContent = '';
      out.append(el('div', { class: 'wapp__result' }, [el('code', { class: 'wapp-mono', text: value }), ...renderFindings(shieldFindings(snapshot, address, value))]));
    } catch (e) {
      out.textContent = '';
      out.append(el('p', { class: 'wapp-error', text: `Couldn't check that address: ${e instanceof Error ? e.message : 'unknown error'}` }));
    }
  }

  // ---- intent tab
  function candidateLabel(c: Candidate): string {
    return `${c.symbol} · ${shorten(c.mint)} · ${c.held && c.amount !== null ? `you hold ${formatAmount(c.amount)}` : 'not in your wallet'}`;
  }

  function pickGroup(name: string, title: string, candidates: Candidate[], chosen: { mint: string | null }, onChange: () => void): HTMLElement {
    const box = el('div', { class: 'wapp__pick' });
    box.append(el('span', { class: 'wapp-sub', text: title }));
    for (const c of candidates) {
      const input = el('input', { attrs: { type: 'radio', name, value: c.mint } });
      input.checked = chosen.mint === c.mint;
      input.addEventListener('change', () => {
        chosen.mint = c.mint;
        onChange();
      });
      box.append(el('label', {}, [input, el('span', { text: candidateLabel(c) })]));
    }
    return box;
  }

  function renderIntent(phrase: string): void {
    const out = $('[data-intent-result]');
    if (!out) return;
    out.textContent = '';
    if (!phrase.trim()) return;
    const intent: ParsedIntent | null = parseIntent(phrase);
    if (!intent) {
      out.append(el('p', { class: 'wapp__banner wapp__banner--warn', text: 'Intent could not read that. It understands phrases like "swap 10 USDC for SOL" and "send 0.5 SOL to an address". Amounts must be plain numbers, not "$50" or "half".' }));
      return;
    }
    const card = el('div', { class: 'wapp__result' });
    out.append(card);

    if (intent.kind === 'send') {
      card.append(el('strong', { text: `Read as: send ${intent.amount} ${intent.assetSymbol} to ${intent.recipient}` }));
      if (!address) {
        card.append(el('p', { class: 'wapp__banner wapp__banner--info', text: 'Connect a wallet so Intent can see what you hold.' }));
        const connect = el('button', { class: 'wapp__btn wapp__btn--primary', text: 'Connect wallet', attrs: { type: 'button' } });
        connect.addEventListener('click', () => document.querySelector<HTMLButtonElement>('[data-aretia-wallet-mount] button')?.click());
        card.append(connect);
        return;
      }
      if (holdings === null) {
        card.append(el('p', { class: 'wapp-sub', text: 'Still loading your balances. Try again in a moment.' }));
        return;
      }
      const options = candidatesFor(intent.assetSymbol, holdings, false);
      const pick = { mint: options.length === 1 ? options[0]!.mint : (null as string | null) };
      const actions = el('div', { class: 'wapp__row-actions' });
      const renderSendActions = () => {
        actions.textContent = '';
        const chosen = options.find((c) => c.mint === pick.mint);
        const problems: string[] = [];
        if (options.length === 0) problems.push(`You do not hold ${intent.assetSymbol} in this wallet.`);
        if (chosen && chosen.amount !== null && Number(intent.amount) > chosen.amount) problems.push(`You hold ${formatAmount(chosen.amount)} ${chosen.symbol}, which is less than ${intent.amount}.`);
        for (const p of problems) actions.append(el('p', { class: 'wapp__banner wapp__banner--warn', text: p }));
        const go = el('button', { class: 'wapp__btn wapp__btn--primary', text: 'Continue to Send', attrs: { type: 'button' } });
        go.disabled = !chosen || problems.length > 0;
        go.addEventListener('click', () => chosen && prefillSend(chosen.mint, intent.recipient, intent.amount));
        actions.append(go);
        if (isSolanaAddress(intent.recipient)) {
          const check = el('button', { class: 'wapp__btn wapp__btn--ghost', text: 'Check this address with Shield', attrs: { type: 'button' } });
          check.addEventListener('click', () => {
            const field = $<HTMLInputElement>('#shield-input');
            if (field) field.value = intent.recipient;
            location.hash = '#/shield';
            void runShield(intent.recipient);
          });
          actions.append(check);
        }
      };
      if (options.length > 1) card.append(pickGroup('intent-send', `${intent.assetSymbol} matches more than one token you hold. Which one?`, options, pick, renderSendActions));
      card.append(actions);
      renderSendActions();
      return;
    }

    card.append(el('strong', { text: `Read as: swap ${intent.amount} ${intent.fromAssetSymbol} for ${intent.toAssetSymbol}` }));
    if (!address) {
      card.append(el('p', { class: 'wapp__banner wapp__banner--info', text: 'Connect a wallet so Intent can see what you hold.' }));
      const connect = el('button', { class: 'wapp__btn wapp__btn--primary', text: 'Connect wallet', attrs: { type: 'button' } });
      connect.addEventListener('click', () => document.querySelector<HTMLButtonElement>('[data-aretia-wallet-mount] button')?.click());
      card.append(connect);
      return;
    }
    if (holdings === null) {
      card.append(el('p', { class: 'wapp-sub', text: 'Still loading your balances. Try again in a moment.' }));
      return;
    }
    const from = candidatesFor(intent.fromAssetSymbol, holdings, false);
    const to = candidatesFor(intent.toAssetSymbol, holdings, true);
    const fromPick = { mint: from.length === 1 ? from[0]!.mint : null as string | null };
    const toPick = { mint: to.length === 1 ? to[0]!.mint : null as string | null };
    const actions = el('div');
    const render = () => {
      actions.textContent = '';
      const f = from.find((c) => c.mint === fromPick.mint);
      const t = to.find((c) => c.mint === toPick.mint);
      const problems: string[] = [];
      if (from.length === 0) problems.push(`You do not hold ${intent.fromAssetSymbol} in this wallet.`);
      if (to.length === 0) problems.push(`Intent does not know ${intent.toAssetSymbol}. It only swaps into tokens you hold, plus SOL, USDC, USDT and ACT. Use the Swap page to search for others.`);
      if (f && t && f.mint === t.mint) problems.push('That swaps a token for itself.');
      if (f && f.amount !== null && Number(intent.amount) > f.amount) problems.push(`You hold ${formatAmount(f.amount)} ${f.symbol}, which is less than ${intent.amount}.`);
      const raw = f && f.decimals !== null ? toSmallestUnit(intent.amount, f.decimals) : null;
      if (f && f.decimals !== null && raw === null) problems.push(`${f.symbol} has ${f.decimals} decimal places, so ${intent.amount} is too precise.`);
      if (f && f.decimals === null) actions.append(el('p', { class: 'wapp__banner wapp__banner--info', text: `Intent does not know how many decimals ${f.symbol} uses, so it will not fill in the amount. Enter it on the Swap page.` }));
      for (const p of problems) actions.append(el('p', { class: 'wapp__banner wapp__banner--warn', text: p }));
      // Not a blocker (the wallet may still have enough), but the usual reason a non-SOL swap fails.
      const sol = holdings?.find((h) => h.mint === SOL_MINT)?.amount ?? 0;
      if (f && f.mint !== SOL_MINT && sol < LOW_SOL) actions.append(el('p', { class: 'wapp__banner wapp__banner--warn', text: lowSolMessage(sol) }));
      const ready = f !== undefined && t !== undefined && problems.length === 0;
      const go = el('button', { class: 'wapp__btn wapp__btn--primary', text: 'Continue to Swap', attrs: { type: 'button' } });
      go.disabled = !ready;
      go.addEventListener('click', () => {
        if (!f || !t) return;
        window.dispatchEvent(new CustomEvent(PREFILL_SWAP_EVENT, { detail: { from: { mint: f.mint, symbol: f.symbol, decimals: f.decimals }, to: { mint: t.mint, symbol: t.symbol, decimals: t.decimals }, amount: intent.amount } }));
        location.hash = '#/swap';
      });
      actions.append(go);
    };
    if (from.length > 1) card.append(pickGroup('intent-from', `${intent.fromAssetSymbol} matches more than one token you hold. Which one?`, from, fromPick, render));
    if (to.length > 1) card.append(pickGroup('intent-to', `${intent.toAssetSymbol} matches more than one token. Which one?`, to, toPick, render));
    card.append(actions);
    render();
  }

  $('[data-shield-form]')?.addEventListener('submit', (e) => {
    e.preventDefault();
    void runShield($<HTMLInputElement>('#shield-input')?.value ?? '');
  });
  $('[data-intent-form]')?.addEventListener('submit', (e) => {
    e.preventDefault();
    renderIntent($<HTMLInputElement>('#intent-input')?.value ?? '');
  });
  document.querySelectorAll<HTMLElement>('[data-example]').forEach((b) =>
    b.addEventListener('click', () => {
      const field = $<HTMLInputElement>('#intent-input');
      if (field) field.value = b.dataset.example ?? '';
      renderIntent(b.dataset.example ?? '');
    }),
  );

  // The network chip and Refresh live in the site's top bar, before the ACT price, whenever that bar has room
  // for them (it hides its right-hand side on narrow screens, so there they stay at the top of the page).
  function placeChips(): void {
    const chips = $<HTMLElement>('.wapp__chips');
    const actions = document.querySelector<HTMLElement>('header.nav .nav__actions');
    const home = $<HTMLElement>('.wapp__top');
    if (!chips || !actions || !home) return;
    const wide = window.matchMedia('(min-width: 1081px)').matches;
    if (wide) actions.insertBefore(chips, actions.firstElementChild);
    else if (chips.parentElement !== home) home.append(chips);
  }
  window.matchMedia('(min-width: 1081px)').addEventListener('change', placeChips);
  placeChips();

  // ---- wiring
  function onRoute(): void {
    renderChrome();
    const view = currentView();
    if (view === 'swings' || view === 'swap' || view === 'favourites') swings.onShow(view);
    if (view === 'activity') swings.onActivityShow();
    if (view === 'send') {
      void loadWeb3();
      swings.onPayShow();
    }
  }
  window.addEventListener('hashchange', onRoute);
  // Only the wallet's own buttons navigate. The site's top bar also carries a data-nav attribute (for its own script), and the
  // Swings tabs and search box now sit inside it, so a bare [data-nav] selector sent every click there to the dashboard.
  document.querySelectorAll<HTMLElement>('[data-wapp] [data-nav]').forEach((b) => b.addEventListener('click', () => (location.hash = `#/${b.dataset.nav}`)));

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
  const scrollBehavior = (): ScrollBehavior => (window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth');
  function selectTab(name: string): void {
    document.querySelectorAll<HTMLElement>('[data-tab]').forEach((b) => b.setAttribute('aria-selected', String(b.dataset.tab === name)));
    document.querySelectorAll<HTMLElement>('[data-tabpanel]').forEach((p) => (p.hidden = p.dataset.tabpanel !== name));
  }
  document.querySelectorAll<HTMLElement>('[data-tab]').forEach((b) => b.addEventListener('click', () => selectTab(b.dataset.tab ?? 'assets')));
  $('[data-receive]')?.addEventListener('click', () => {
    selectTab('address');
    $('[data-tabpanel="address"]')?.scrollIntoView({ block: 'nearest', behavior: scrollBehavior() });
  });
  document.querySelectorAll<HTMLElement>('[data-scroll]').forEach((b) => b.addEventListener('click', () => document.getElementById(b.dataset.scroll ?? '')?.scrollIntoView({ behavior: scrollBehavior() })));
  const track = $<HTMLElement>('[data-tools-track]');
  $('[data-tools-prev]')?.addEventListener('click', () => track?.scrollBy({ left: -340, behavior: scrollBehavior() }));
  $('[data-tools-next]')?.addEventListener('click', () => track?.scrollBy({ left: 340, behavior: scrollBehavior() }));

  // The sidebar's lock button: an optional, per-wallet lock for this page on a desktop or laptop (set up in its own window).
  // On a phone or tablet it keeps its old job of disconnecting, which is all it can honestly do there.
  const lock = initWalletLock({
    getAddress: () => address,
    getWalletName: () => walletName,
    disconnect: () => void window.AretiaWallet?.disconnect(),
    async proveOwnership(message) {
      const ctx = window.AretiaWallet?.getWalletContextState() as { signMessage?: (m: Uint8Array) => Promise<Uint8Array> } | undefined;
      if (!ctx?.signMessage) return 'unsupported';
      try {
        await ctx.signMessage(new TextEncoder().encode(message));
        return 'approved';
      } catch {
        return 'declined';
      }
    },
  });
  initNotifications();

  function clearSessionOutputs(): void {
    for (const sel of ['[data-send-review]', '[data-intent-result]', '[data-shield-result]', '[data-market-embed]']) $(sel)?.replaceChildren();
    market.embedded = false;
    market.message = null;
    for (const sel of ['[data-send-to]', '[data-send-amount]', '#intent-input', '#shield-input']) {
      const field = $<HTMLInputElement>(sel);
      if (field) field.value = '';
    }
  }

  function onWallet(state: WalletState): void {
    const next = state.account?.address ?? null;
    walletName = state.walletName;
    // Only an inert image is ever shown: wallet.js already filters, and this checks again.
    walletIcon = typeof state.walletIcon === 'string' && /^data:image\/(svg\+xml|png|webp|gif);base64,[A-Za-z0-9+/=]+$/.test(state.walletIcon) ? state.walletIcon : null;
    if (next === address) return void renderChrome();
    address = next;
    // A wallet that has set up a lock is locked before anything of it is drawn; one that has not is left alone.
    lock.onWallet(next);
    clearSessionOutputs();
    swings.onWalletChange();
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
  initSidebar();
  onRoute();
  if (!wire()) {
    // wallet.js loads just before this script; wait briefly if it is a tick behind.
    let tries = 0;
    const t = setInterval(() => {
      if (wire() || ++tries > 40) clearInterval(t);
    }, 100);
  }
}
