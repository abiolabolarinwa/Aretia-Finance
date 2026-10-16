import { ACT as ACT_INFO } from '../data/site';
import { EVM_ACCOUNT_EVENT, initSwings } from './walletSwings';
import { isEvmNativeMint, loadEvmHoldings, type EvmHolding } from './walletEvmHoldings';
import { EvmSession, publicRead } from '../swings/chains/evmSession.js';
import { checkEvmRecipient, EVM_EXPLORER_TX, maxNativeSend, planEvmSend, sendEvmTransfer, waitForEvmReceipt, type EvmSendPlan } from './walletEvmSend';
import { CHAIN_IDS, CHAINS, isChainId, type ChainId } from '../swings/core/types.js';
import { initWalletLock } from './walletLock';
import { initRadar } from './walletRadar';
import { initNotifications } from './walletNotifications';
import { initShield } from './walletShield';
import { initLaunch } from './walletLaunch';
import { initPool } from './walletPool';
import { initCurve } from './walletCurve';
import { loadTrades, type TradeRow } from './walletTrades';
import { checkHash } from '../swings/shield/classify';
import { guardRecipient } from '../swings/shield/guard';
import { sidebarItemFor } from './walletNav';
import { checkSendInput, sendAssetLabel } from './walletSendInput';
import { PREFILL_SWAP_EVENT } from './walletSearch';
import { lamportsToBalance, mergeBalances, parseTokenAccountsResult, splitByPrice, TOKEN_2022_PROGRAM_ID, TOKEN_PROGRAM_ID, type RawBalance } from './walletHoldings';
import { loadWeb3, planSend, rpcCall, resolveName, signAndSubmit, simulatePlan, waitForConfirmation, type SendPlan, type SendRequest, type Simulation } from './walletSend';
import { BASE_FEE_LAMPORTS, candidatesFor, fromSmallestUnit, isSolanaAddress, parseIntent, shieldFindings, toSmallestUnit, type AccountSnapshot, type Candidate, type ParsedIntent } from './walletTools';

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

type View = 'dashboard' | 'send' | 'swap' | 'launch' | 'carbon' | 'swings' | 'favourites' | 'radar' | 'activity' | 'shield' | 'intent' | 'safesend' | 'universal';
const VIEWS: View[] = ['dashboard', 'send', 'swap', 'launch', 'carbon', 'swings', 'favourites', 'radar', 'activity', 'shield', 'intent', 'safesend', 'universal'];
const TITLES: Record<View, string> = { dashboard: 'Dashboard', send: 'Pay', swap: 'Swap', launch: 'Launch', carbon: 'Carbon Credit', swings: 'Markets', favourites: 'Favourites', radar: 'Radar', activity: 'Activity', shield: 'Shield', intent: 'Intent', safesend: 'SafeSend', universal: 'Universal' };

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
  // The Ethereum-style account (MetaMask's other account) and what it holds. Solana's `holdings` stays Solana-only: Send and the swap read it.
  let evmAccount: string | null = null;
  let evmHoldings: EvmHolding[] = [];
  let evmToken = 0;
  const evmSession = new EvmSession();
  let activity: ActivityItem[] | null = null;
  /** What the wallet bought and sold in those transactions, read from the chain; null while it is being read. */
  let trades: TradeRow[] | null = null;
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
  initRadar();
  const swings = initSwings({ getAddress: () => address, getWalletName: () => walletName, getHoldings: () => holdings, refresh: () => refresh() });
  const shield = initShield({
    getAddress: () => address,
    getHoldings: () => (holdings ?? []).map((x) => ({ mint: x.mint, symbol: x.symbol, value: x.value, amount: x.amount })),
    evmAccount: () => swings.evmAccount(),
    revokeEvm: (chain, token, spender) => swings.revokeEvm(chain, token, spender),
    refreshWallet: () => void refresh(),
  });

  const pool = initPool({ getAddress: () => address, refreshWallet: () => void refresh() });
  const curve = initCurve({ getAddress: () => address, refreshWallet: () => void refresh() });
  const launch = initLaunch({ getAddress: () => address, refreshWallet: () => void refresh(), offerPool: (mint) => pool.offer(mint) });

  const currentView = (): View => {
    // "#/shield/<what to check>" is a shareable check: the first part names the page.
    const raw = location.hash.replace(/^#\/?/, '').split('/')[0] ?? '';
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
    const refresh = $<HTMLElement>('[data-refresh]');
    if (refresh) refresh.hidden = !(address && (view === 'dashboard' || view === 'activity'));
    const addr = $('[data-address]');
    if (addr) addr.textContent = address ?? '';
    const scan = $<HTMLAnchorElement>('[data-solscan]');
    if (scan && address) scan.href = `https://solscan.io/account/${address}`;
  }

  /** Solana holdings plus the Ethereum-style account's, best value first, for the dashboard only. */
  function dashboardHoldings(): Holding[] | null {
    if (holdings === null) return null;
    const evmRows = evmHoldings.map((e): Holding => ({ mint: e.mint, symbol: e.symbol, name: e.name, icon: null, amount: e.amount, raw: null, decimals: e.decimals, price: e.price, priceSource: e.price === null ? null : 'DexScreener', value: e.value, thin: false }));
    if (evmRows.length === 0) return holdings;
    return [...holdings, ...evmRows].sort((a, b) => (b.value ?? -1) - (a.value ?? -1) || b.amount - a.amount);
  }
  const isNativeMint = (mint: string): boolean => mint === SOL_MINT || isEvmNativeMint(mint);

  /** Reads the Ethereum-style account's holdings. The account comes from the swap's connection, or from a wallet already allowed on this page. */
  async function loadEvm(account: string | null): Promise<void> {
    const mine = ++evmToken;
    evmAccount = account;
    if (!account) {
      evmHoldings = [];
      renderSendAssets();
      return renderDashboard();
    }
    try {
      const rows = await loadEvmHoldings(account, CHAIN_IDS.filter((c) => CHAINS[c].kind === 'evm'));
      if (mine !== evmToken) return;
      evmHoldings = rows;
    } catch {
      if (mine !== evmToken) return;
      evmHoldings = [];
    }
    renderDashboard();
    renderSendAssets();
  }
  window.addEventListener(EVM_ACCOUNT_EVENT, (e) => {
    const account = (e as CustomEvent<string | null>).detail;
    if (account !== evmAccount) void loadEvm(account);
  });

  /** The side card and the count on the dashboard: wallet name, token count and the Ethereum-style account when one is connected. */
  function renderTopAssets(): void {
    const name = $('[data-wallet-name]');
    const count = $('[data-token-count]');
    const evmLine = $('[data-evm-line]');
    if (name) name.textContent = address ? (walletName ?? 'Wallet') : '—';
    const all = dashboardHoldings();
    if (count) count.textContent = all ? `${all.length} token${all.length === 1 ? '' : 's'}` : '';
    if (evmLine) {
      evmLine.hidden = !(address && evmAccount);
      evmLine.textContent = evmAccount ? `Also reading ${shorten(evmAccount)} on the Ethereum-style networks.` : '';
    }
  }

  /** The split of the portfolio by value: one segment per top token, the rest together, with a legend beneath. */
  function renderAllocation(all: Holding[] | null, sum: number): void {
    const box = $('[data-alloc]');
    const bar = $('[data-alloc-bar]');
    const legend = $('[data-alloc-legend]');
    if (!box || !bar || !legend) return;
    bar.textContent = '';
    legend.textContent = '';
    const priced = (all ?? []).filter((h) => (h.value ?? 0) > 0);
    box.hidden = priced.length === 0 || sum <= 0;
    if (box.hidden) return;
    const shades = ['#ffffff', '#cfc7ff', '#a595ff', '#7a66f5'];
    const top = priced.slice(0, shades.length);
    const rest = priced.slice(shades.length).reduce((t, h) => t + (h.value ?? 0), 0);
    const parts = top.map((h, i) => ({ label: h.symbol, value: h.value ?? 0, color: shades[i]! }));
    if (rest > 0) parts.push({ label: 'Other', value: rest, color: 'rgba(255, 255, 255, 0.4)' });
    const labels: string[] = [];
    for (const p of parts) {
      const pct = (p.value / sum) * 100;
      const seg = el('span');
      seg.style.width = `${pct}%`;
      seg.style.background = p.color;
      bar.append(seg);
      const dot = el('i');
      dot.style.background = p.color;
      legend.append(el('li', {}, [dot, el('span', { text: p.label }), el('b', { text: `${pct < 1 ? '<1' : Math.round(pct)}%` })]));
      labels.push(`${p.label} ${pct < 1 ? 'under 1' : Math.round(pct)}%`);
    }
    bar.setAttribute('aria-label', `Portfolio split: ${labels.join(', ')}`);
  }

  /** The latest few transactions, for the side card on the dashboard. */
  function renderRecent(error?: string): void {
    const list = $('[data-recent]');
    if (!list) return;
    list.textContent = '';
    if (!address) return;
    if (error) return void list.append(el('li', { class: 'wapp-sub', text: "Couldn't load activity." }));
    if (activity === null) return void list.append(el('li', { class: 'wapp-sub', text: 'Loading activity…' }));
    if (activity.length === 0) return void list.append(el('li', { class: 'wapp-sub', text: 'No transactions yet.' }));
    for (const a of activity.slice(0, 4)) {
      const link = el('a', { class: 'wapp-mono', text: shorten(a.signature, 6), attrs: { href: `https://solscan.io/tx/${a.signature}`, target: '_blank', rel: 'noopener noreferrer' } });
      list.append(el('li', {}, [el('span', { class: `wapp-dash__dot${a.ok ? '' : ' is-fail'}`, attrs: { title: a.ok ? 'Success' : 'Failed' } }), link, el('time', { text: a.time ? relativeTime(a.time) : '—' })]));
    }
  }

  function renderDashboard(error?: string): void {
    renderTopAssets();
    const total = $('[data-total]');
    const sub = $('[data-total-sub]');
    const body = $('[data-holdings]');
    if (!total || !sub || !body) return;
    body.textContent = '';
    renderAllocation(null, 0);
    if (!address) return;
    if (error) {
      total.textContent = '—';
      sub.textContent = '';
      body.append(el('p', { class: 'wapp-error', text: `Couldn't load balances: ${error}` }));
      return;
    }
    const all = dashboardHoldings();
    if (all === null) {
      total.textContent = '…';
      sub.textContent = 'Loading balances';
      return;
    }
    const priced = all.filter((h) => h.value !== null);
    const sum = priced.reduce((s, h) => s + (h.value ?? 0), 0);
    const { shown, hiddenUnpriced } = splitByPrice(all, isNativeMint, showUnpriced);
    // How many tokens the toggle governs: those with no price, other than the native coin.
    const unpricedCount = priced.length > 0 ? all.filter((h) => h.value === null && !isNativeMint(h.mint)).length : 0;
    total.textContent = priced.length > 0 ? (amountsHidden ? '••••' : formatUsd(sum)) : '—';
    renderAllocation(all, sum);
    sub.textContent = all.length === 0 ? 'This wallet holds no tokens yet.' : `${priced.length} of ${all.length} token${all.length === 1 ? '' : 's'} priced`;
    if (all.length === 0) return;

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
    renderRecent(error);
    const body = $('[data-activity]');
    if (!body) return;
    body.textContent = '';
    if (!address) return;
    if (error) return void body.append(el('p', { class: 'wapp-error', text: `Couldn't load activity: ${error}` }));
    if (activity === null) return void body.append(el('p', { class: 'wapp-sub', text: 'Loading activity…' }));
    if (activity.length === 0) return void body.append(el('p', { class: 'wapp-sub', text: 'No transactions found for this address.' }));
    if (trades) return void renderTrades(body, trades);
    body.append(el('p', { class: 'wapp-sub', text: 'Reading what was bought and sold in these transactions…' }));
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

  /** A price with three significant figures and no exponent, however small the token's price is. */
  const sig3 = (n: number): string => n.toLocaleString('en-US', { maximumSignificantDigits: 3, maximumFractionDigits: 12 });
  const dateTime = (t: number | null): string => (t ? new Date(t * 1000).toLocaleString(undefined, { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' }) : '—');

  /** Buys and sells: what was traded, at what price, and when. Everything else the wallet did is listed as what it was. */
  function renderTrades(body: HTMLElement, rows: TradeRow[]): void {
    const wrap = el('div', { class: 'wapp-trades-wrap' });
    const table = el('table', { class: 'wapp-table wapp-trades' });
    table.append(el('thead', {}, [el('tr', {}, ['When', 'Activity', 'Price per token', 'Value', 'Transaction'].map((t) => el('th', { text: t })))]));
    const tbody = el('tbody');
    for (const t of rows) {
      const pill = (text: string, tone: string) => el('span', { class: `wapp-trade wapp-trade--${tone}`, text });
      const leg = (l: { amount: number; symbol: string }) => `${formatAmount(l.amount)} ${l.symbol}`;
      const what = el('div', { class: 'wapp-trades__what' });
      let price = '—';
      let value = '—';
      if (!t.ok) what.append(pill('Failed', 'fail'), el('span', { text: 'The transaction did not go through' }));
      else if (!t.read) what.append(el('span', { class: 'wapp-sub', text: 'Details not available from the node' }));
      else if ((t.kind === 'bought' || t.kind === 'sold') && t.token && t.quote) {
        what.append(pill(t.kind === 'bought' ? 'Bought' : 'Sold', t.kind === 'bought' ? 'buy' : 'sell'), el('span', { text: leg(t.token) }));
        price = t.price.usd !== null ? `$${sig3(t.price.usd)}` : t.price.inQuote !== null ? `${sig3(t.price.inQuote)} ${t.quote.symbol}` : '—';
        value = t.price.valueUsd !== null ? formatUsd(t.price.valueUsd) : leg(t.quote);
        what.title = `${t.kind === 'bought' ? 'Paid' : 'Received'} ${leg(t.quote)}`;
      } else if (t.kind === 'swapped' && t.token && t.quote) what.append(pill('Swapped', 'move'), el('span', { text: `${leg(t.token)} → ${leg(t.quote)}` }));
      else if (t.kind === 'received' && t.token) what.append(pill('Received', 'in'), el('span', { text: leg(t.token) }));
      else if (t.kind === 'sent' && t.token) what.append(pill('Sent', 'out'), el('span', { text: leg(t.token) }));
      else {
        const parts = [...t.spent.map((l) => `−${leg(l)}`), ...t.gained.map((l) => `+${leg(l)}`)];
        what.append(pill('Other', 'move'), el('span', { text: parts.length > 0 ? parts.join(', ') : 'No change to your balances' }));
      }
      const link = el('a', { class: 'wapp-mono', text: shorten(t.signature, 6), attrs: { href: `https://solscan.io/tx/${t.signature}`, target: '_blank', rel: 'noopener noreferrer' } });
      tbody.append(
        el('tr', {}, [
          el('td', {}, [el('div', { class: 'wapp-trades__when' }, [el('span', { text: dateTime(t.time) }), el('small', { text: t.time ? relativeTime(t.time) : '' })])]),
          el('td', {}, [what]),
          el('td', { class: 'num', text: price }),
          el('td', { class: 'num', text: value }),
          el('td', {}, [link]),
        ]),
      );
    }
    table.append(tbody);
    wrap.append(table);
    body.append(wrap);
    const unread = rows.some((t) => t.ok && !t.read);
    body.append(
      el('p', {
        class: 'wapp-sub wapp-trades__note',
        text: `Read from this wallet's own transactions on Solana (the latest ${rows.length}). The price is what this wallet got for each token in that trade. A dollar value is the stablecoin amount, or for SOL its price that hour from GeckoTerminal; between two other tokens only the amounts are shown. SOL amounts leave out the network fee and the small deposit for opening a token account.${unread ? ' Some transactions could not be read from the node just now; Refresh tries again.' : ''}`,
      }),
    );
  }

  // ---- loading
  async function refresh(): Promise<void> {
    const mine = ++loadToken;
    holdings = null;
    holdingsFailed = false;
    activity = null;
    trades = null;
    renderDashboard();
    renderActivity();
    renderSendAssets();
    if (!address) return;
    const a = address;
    void (evmAccount ? loadEvm(evmAccount) : evmSession.resume(walletName).then(loadEvm).catch(() => undefined));
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
      // The trades are read after the list is on screen: it can take a few seconds, and the list is useful meanwhile.
      void loadTrades(a, act.value).then(
        (rows) => {
          if (mine !== loadToken) return;
          trades = rows;
          renderActivity();
        },
        () => undefined,
      );
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

  // Sending from an Ethereum-style account. The network box exists only on builds with PUBLIC_PAY_EVM_SEND=1.
  const sendChain = (): ChainId => {
    const v = $<HTMLSelectElement>('[data-send-network]')?.value;
    return isChainId(v) ? v : 'solana';
  };
  const isEvmSend = (): boolean => sendChain() !== 'solana';
  const selectedEvmHolding = (): EvmHolding | undefined => {
    const { asset } = sendEls();
    return evmHoldings.find((e) => e.mint === asset?.value && e.chain === sendChain());
  };
  $('[data-send-network]')?.addEventListener('change', () => {
    sendEls().out?.replaceChildren();
    renderSendAssets();
  });

  /** The wallet that signs for the Ethereum-style account: the one already allowed on this page, or the sidebar's wallet asked now. */
  async function ensureEvmWallet(): Promise<NonNullable<EvmSession['adapter']>> {
    if (!evmSession.adapter) {
      await evmSession.resume(walletName);
      if (!evmSession.adapter) {
        const found = await evmSession.discover();
        const want = (walletName ?? '').trim().toLowerCase();
        const w = found.find((x) => x.info.name.toLowerCase() === want) ?? (found.length === 1 ? found[0] : undefined);
        if (!w) throw new Error('No Ethereum-style wallet was found in this browser. Connect one in Swap first.');
        await evmSession.connect(w.info.uuid);
      }
    }
    const adapter = evmSession.adapter;
    if (!adapter) throw new Error('Your Ethereum-style wallet is not connected.');
    return adapter;
  }

  async function onEvmSendSubmit(): Promise<void> {
    const { to, amount, out } = sendEls();
    if (!out || !to || !amount) return;
    out.textContent = '';
    const h = selectedEvmHolding();
    if (!evmAccount || !h) return void out.append(el('p', { class: 'wapp-error', text: 'Connect your Ethereum-style wallet in Swap, then choose an asset.' }));
    const recipient = checkEvmRecipient(to.value, evmAccount);
    if (recipient.problem !== null) return void out.append(el('p', { class: 'wapp-error', text: recipient.problem }));
    if (!amount.value.trim()) return void out.append(el('p', { class: 'wapp-error', text: 'Enter an amount.' }));
    out.append(el('p', { class: 'wapp-sub', text: 'Checking the transfer…' }));
    try {
      const plan = await planEvmSend({ chain: h.chain, from: evmAccount, to: recipient.address, token: h.mint.endsWith(':native') ? null : h.address, symbol: h.symbol, decimals: h.decimals, amountText: amount.value }, publicRead(h.chain));
      renderEvmReview(plan);
    } catch (e) {
      out.textContent = '';
      out.append(el('p', { class: 'wapp-error', text: friendlyError(e) }));
    }
  }

  function renderEvmReview(plan: EvmSendPlan): void {
    const { out } = sendEls();
    if (!out) return;
    out.textContent = '';
    const req = plan.request;
    const net = CHAINS[req.chain];
    const card = el('div', { class: 'wapp__result' });
    out.append(card);
    const rows: [string, Node | string][] = [
      ['You send', `${req.amountText.trim()} ${req.symbol}`],
      ['To', el('code', { class: 'wapp-mono', text: req.to })],
      ['Network', net.name],
      ['Network fee', plan.feeWei === null ? 'could not be estimated' : `up to about ${fromSmallestUnit(plan.feeWei, 18)} ${net.nativeSymbol}`],
    ];
    card.append(el('strong', { text: 'Review before you sign' }), rowsList(rows));
    if (plan.recipientIsContract) card.append(banner('warn', 'This address is a smart contract, not a normal wallet. Funds sent to a contract that does not expect them can be lost. Send only if you know what it does.'));
    for (const b of plan.blockers) card.append(banner('warn', b));
    const canGo = plan.blockers.length === 0 && plan.tx !== null;
    const ack = el('input', { attrs: { type: 'checkbox', id: 'send-ack' } });
    if (canGo && plan.needsAck) card.append(el('label', { class: 'wapp__check', attrs: { for: 'send-ack' } }, [ack, el('span', { text: 'I know this address is a contract and I want to send to it anyway.' })]));
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
        const hash = await sendEvmTransfer(plan, await ensureEvmWallet());
        status.textContent = '';
        const link = el('a', { text: 'View transaction', attrs: { href: `${EVM_EXPLORER_TX[req.chain] ?? ''}${hash}`, target: '_blank', rel: 'noopener noreferrer' } });
        status.append(el('p', { class: 'wapp__banner wapp__banner--info' }, [document.createTextNode('Sent. Waiting for confirmation… '), link]));
        actions.hidden = true;
        const result = await waitForEvmReceipt(publicRead(req.chain), hash);
        status.textContent = '';
        const text = result === 'confirmed' ? `Confirmed on ${net.name}.` : result === 'failed' ? 'The transaction failed on-chain. Check the explorer for the reason.' : 'Not confirmed yet. It may still land; check the explorer.';
        status.append(el('p', { class: `wapp__banner wapp__banner--${result === 'confirmed' ? 'ok' : result === 'failed' ? 'warn' : 'info'}` }, [document.createTextNode(`${text} `), el('a', { text: 'View transaction', attrs: { href: `${EVM_EXPLORER_TX[req.chain] ?? ''}${hash}`, target: '_blank', rel: 'noopener noreferrer' } })]));
        if (evmAccount) void loadEvm(evmAccount);
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

  function renderSendAssets(): void {
    const { asset } = sendEls();
    if (!asset) return;
    const previous = asset.value;
    asset.textContent = '';
    asset.disabled = true;
    if (isEvmSend()) {
      if (!evmAccount) return void asset.append(new Option('Connect your Ethereum-style wallet in Swap first', ''));
      const rows = evmHoldings.filter((e) => e.chain === sendChain());
      if (rows.length === 0) return void asset.append(new Option(`No ${CHAINS[sendChain()].name} coins or known tokens found`, ''));
      asset.disabled = false;
      for (const e of rows) asset.append(new Option(`${e.symbol} · ${formatAmount(e.amount)}`, e.mint));
      if (rows.some((e) => e.mint === previous)) asset.value = previous;
      return;
    }
    if (!address) return void asset.append(new Option('Connect a wallet first', ''));
    if (holdings === null) return void asset.append(new Option(holdingsFailed ? "Couldn't load your tokens. Use Refresh on the Dashboard." : 'Loading your tokens…', ''));
    if (holdings.length === 0) return void asset.append(new Option('This wallet holds no tokens', ''));
    asset.disabled = false;
    // Priced tokens first, so airdropped spam sits at the bottom of the list.
    const ordered = [...holdings.filter((h) => h.value !== null || h.mint === SOL_MINT), ...holdings.filter((h) => h.value === null && h.mint !== SOL_MINT)];
    for (const h of ordered) asset.append(new Option(sendAssetLabel(h, holdings, formatAmount(h.amount), SOL_MINT, shorten), h.mint));
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
    // Shield's guard: is it an address you know, a copy-cat of one, or a first time.
    const guard = plan.blockers.length === 0 ? guardRecipient(plan.to, shield.book().list(), address) : null;
    if (guard) for (const f of guard.findings) card.append(banner(f.severity === 'bad' ? 'warn' : f.severity === 'ok' ? 'ok' : 'info', f.severity === 'ok' || f.severity === 'info' ? f.title : `${f.title} ${f.detail}`));
    for (const b of plan.blockers) card.append(banner('warn', b));
    const simBanner = sim ? (sim.ok ? banner('ok', 'Simulation passed: the network would accept this transaction. No funds have moved.') : banner('warn', `Simulation failed, so this was not sent to your wallet: ${sim.error}`)) : null;
    if (simBanner) card.append(simBanner);

    const canGo = plan.blockers.length === 0 && sim?.ok === true;
    const ack = el('input', { attrs: { type: 'checkbox', id: 'send-ack' } });
    if (canGo && plan.needsAck) card.append(el('label', { class: 'wapp__check', attrs: { for: 'send-ack' } }, [ack, el('span', { text: 'This address is owned by another program, not a normal wallet. I understand and want to continue.' })]));

    const guardAck = el('input', { attrs: { type: 'checkbox', id: 'send-guard-ack' } });
    if (canGo && guard?.needsAck) card.append(el('label', { class: 'wapp__check', attrs: { for: 'send-guard-ack' } }, [guardAck, el('span', { text: 'I compared every character of this address with the one I meant to use, and it is the same.' })]));

    const status = el('div', { attrs: { 'aria-live': 'polite' } });
    const actions = el('div', { class: 'wapp__row-actions' });
    const confirm = el('button', { class: 'wapp__btn wapp__btn--primary', text: 'Confirm in my wallet', attrs: { type: 'button' } });
    const cancel = el('button', { class: 'wapp__btn wapp__btn--ghost', text: canGo ? 'Cancel' : 'Back', attrs: { type: 'button' } });
    const sync = () => (confirm.disabled = !canGo || sendBusy || (plan.needsAck && !ack.checked) || (!!guard?.needsAck && !guardAck.checked));
    sync();
    ack.addEventListener('change', sync);
    guardAck.addEventListener('change', sync);
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
        // Remembered from now on, so a copy-cat of it can be caught next time.
        shield.book().rememberSent(active.to);
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
    if (isEvmSend()) return onEvmSendSubmit();
    const { to, amount, out } = sendEls();
    if (!out || !to || !amount) return;
    out.textContent = '';
    const h = selectedHolding();
    const target = to.value.trim();
    const amountText = amount.value.trim();
    if (!address || !h) return void out.append(el('p', { class: 'wapp-error', text: 'Connect a wallet and choose an asset first.' }));
    const problem = checkSendInput({ from: address, target, amountText, decimals: h.decimals, balanceRaw: h.raw, symbol: h.symbol });
    if (problem) return void out.append(el('p', { class: 'wapp-error', text: problem }));
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
    if (isEvmSend()) {
      const e = selectedEvmHolding();
      const { amount: field } = sendEls();
      if (!e || !field) return;
      if (!e.mint.endsWith(':native')) return void (field.value = fromSmallestUnit(BigInt(e.raw), e.decimals));
      // The native coin: leave room for the fee (a plain transfer's gas, with the same margin the review uses).
      void publicRead(e.chain)('eth_gasPrice', []).then((p) => {
        const price = typeof p === 'string' && /^0x[0-9a-fA-F]+$/.test(p) ? BigInt(p) : null;
        if (price !== null) field.value = fromSmallestUnit(maxNativeSend(BigInt(e.raw), (21_000n * 12n * price) / 10n), e.decimals);
      }).catch(() => undefined);
      return;
    }
    const h = selectedHolding();
    const { amount } = sendEls();
    if (!h || !amount || h.decimals === null || h.raw === null) return;
    let raw = BigInt(h.raw);
    if (h.mint === SOL_MINT) raw = raw > BASE_FEE_LAMPORTS ? raw - BASE_FEE_LAMPORTS : 0n; // leave the network fee
    amount.value = fromSmallestUnit(raw, h.decimals);
  });

  // ---- shield tab
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
            location.hash = checkHash(intent.recipient);
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
    if (view === 'shield') shield.onShow(location.hash);
    if (view === 'launch') {
      launch.onShow();
      pool.onShow();
      curve.onShow();
    }
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
  // Receive: bring the person to their address, ready to copy.
  $('[data-receive]')?.addEventListener('click', () => {
    const card = $('[data-wallet-card]');
    if (!card) return;
    card.scrollIntoView({ block: 'center', behavior: scrollBehavior() });
    card.classList.remove('is-nudged');
    void card.offsetWidth; // restart the highlight if it is already running
    card.classList.add('is-nudged');
    $<HTMLElement>('[data-copy]')?.focus({ preventScroll: true });
  });

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
    for (const sel of ['[data-send-review]', '[data-intent-result]']) $(sel)?.replaceChildren();
    for (const sel of ['[data-send-to]', '[data-send-amount]', '#intent-input']) {
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
    shield.onWalletChange();
    launch.onWalletChange();
    pool.onWalletChange();
    curve.onWalletChange();
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
