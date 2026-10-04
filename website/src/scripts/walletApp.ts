import { ACT as ACT_INFO, POOLS } from '../data/site';
import { fetchQuote, fetchSizeImpact, planSwap, searchTokens, signAndSubmitSwap, type Quote, type SwapPlan, type TokenInfo } from './walletSwap';
import { RPC_URL, loadWeb3, planSend, rpcCall, resolveName, signAndSubmit, simulatePlan, waitForConfirmation, type SendPlan, type SendRequest, type Simulation } from './walletSend';
import { BASE_FEE_LAMPORTS, KNOWN_TOKENS, SWAP_SOL_OVERHEAD_LAMPORTS, candidatesFor, defaultSlippageBps, fromSmallestUnit, isSolanaAddress, parseIntent, shieldFindings, toSmallestUnit, type AccountSnapshot, type Candidate, type Finding, type ParsedIntent } from './walletTools';

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
 *   - Solana RPC (via /api/rpc, public fallback)  recent signatures for the Activity tab, the
 *                               account read behind Shield, and everything Send needs
 *
 * Token names, symbols and icons come from third parties and may be hostile
 * (spam tokens are common), so everything is rendered with textContent and
 * element creation, never innerHTML.
 */

const ACT_MINT = '7Ut5njM9ajGDjP83WvJmvrAcfi9JoVYrHSK5x5sSFrTG';
const SOL_MINT = 'So11111111111111111111111111111111111111112';
const JUPITER_PLUGIN = 'https://plugin.jup.ag/plugin-v1.js';
const MAX_MINTS = 100;
/** Below this much SOL a swap can fail: the network fee, plus about 0.002 SOL to open a new token account. */
const LOW_SOL = 0.003;
const lowSolMessage = (sol: number): string =>
  `This wallet holds ${formatAmount(sol)} SOL. A swap needs a little SOL for the network fee, and your first ACT purchase also needs about 0.002 SOL to open your ACT account. Add some SOL first, or the swap will fail.`;

interface WalletState {
  account: { address: string } | null;
  connecting: boolean;
  walletName: string | null;
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

/** Everything the connected address holds, with names, icons and a price where one exists. */
export async function loadHoldings(address: string): Promise<Holding[]> {
  const balancesUrl = `https://lite-api.jup.ag/ultra/v1/balances/${address}`;
  let balances: Record<string, JupBalance>;
  try {
    balances = await getJson<Record<string, JupBalance>>(balancesUrl);
  } catch {
    // Jupiter's free API is occasionally slow or throttled; one more try before giving up.
    balances = await getJson<Record<string, JupBalance>>(balancesUrl);
  }
  const entries = Object.entries(balances)
    .map(([key, b]) => [key === 'SOL' ? SOL_MINT : key, Number(b.uiAmount ?? 0), typeof b.amount === 'string' && /^\d+$/.test(b.amount) ? b.amount : null] as const)
    .filter(([, amount]) => Number.isFinite(amount) && amount > 0)
    .slice(0, MAX_MINTS);
  if (entries.length === 0) return [];
  const mints = entries.map(([mint]) => mint);
  const rawByMint = new Map(entries.map(([mint, , raw]) => [mint, raw] as const));

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
        raw: rawByMint.get(mint) ?? null,
        decimals: native ? 9 : typeof t?.decimals === 'number' ? t.decimals : null,
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

type View = 'dashboard' | 'send' | 'trade' | 'activity' | 'shield' | 'intent' | 'safesend' | 'universal';
const VIEWS: View[] = ['dashboard', 'send', 'trade', 'activity', 'shield', 'intent', 'safesend', 'universal'];
const TITLES: Record<View, string> = { dashboard: 'Dashboard', send: 'Pay', trade: 'Trade', activity: 'Activity', shield: 'Shield', intent: 'Intent', safesend: 'SafeSend', universal: 'Universal' };

export function initWalletApp(): void {
  const root = $<HTMLElement>('[data-wapp]');
  if (!root) return;
  let address: string | null = null;
  let walletName: string | null = null;
  let holdings: Holding[] | null = null;
  let holdingsFailed = false;
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
    renderSwap();
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

  // ---- swap tab (our own screen; Jupiter quotes and builds, the page checks before anything is signed)
  const SOL = 'So11111111111111111111111111111111111111112';
  const KNOWN_NAMES: Record<string, string> = { SOL: 'Solana', USDC: 'USD Coin', USDT: 'Tether USD', ACT: 'Aretia Finance Protocol' };
  // ACT and SOL logos ship with the site so they always show; the others are fetched once and remembered.
  const LOCAL_ICONS: Record<string, string> = { [ACT_INFO.mint]: '/assets/logo-mark.png', [SOL]: '/assets/chains/solana.png' };
  const iconCache = new Map<string, string>(Object.entries(LOCAL_ICONS));
  const tokenIcon = (tk: { mint: string; icon: string | null }): string | null => LOCAL_ICONS[tk.mint] ?? tk.icon ?? iconCache.get(tk.mint) ?? holding(tk.mint)?.icon ?? null;
  const knownTokens: TokenInfo[] = KNOWN_TOKENS.map((k) => ({ mint: k.mint, symbol: k.symbol, name: KNOWN_NAMES[k.symbol] ?? k.symbol, decimals: k.decimals, icon: null, verified: k.symbol === 'ACT' ? null : true }));
  async function loadKnownIcons(): Promise<void> {
    try {
      const found = await searchTokens(KNOWN_TOKENS.map((k) => k.mint).join(','));
      for (const tk of found) if (tk.icon && KNOWN_TOKENS.some((k) => k.mint === tk.mint)) iconCache.set(tk.mint, tk.icon);
      renderSwap();
      void ensureChart();
    } catch {
      // The initials stay until the next visit.
    }
  }
  const tokenByMint = (mint: string): TokenInfo | undefined => knownTokens.find((k) => k.mint === mint);
  const swap = {
    from: tokenByMint(SOL)!,
    to: tokenByMint(ACT_INFO.mint)!,
    amountText: '',
    slip: 'auto' as 'auto' | number,
    quote: null as Quote | null,
    impact: null as number | null,
    quoting: false,
    error: null as string | null,
    seq: 0,
    busy: false,
  };
  let swapTimer: number | undefined;
  const swapEls = () => ({
    amount: $<HTMLInputElement>('[data-swap-amount]'),
    out: $('[data-swap-out]'),
    go: $<HTMLButtonElement>('[data-swap-go]'),
    details: $('[data-swap-details]'),
    notes: $('[data-swap-notes]'),
    review: $('[data-swap-review]'),
  });
  const involvesAct = () => swap.from.mint === ACT_INFO.mint || swap.to.mint === ACT_INFO.mint;
  const slipBps = () => (swap.slip === 'auto' ? defaultSlippageBps(involvesAct()) : swap.slip);
  const holding = (mint: string) => holdings?.find((h) => h.mint === mint);
  const fmtRaw = (raw: bigint, decimals: number) => formatAmount(Number(fromSmallestUnit(raw, decimals)));
  const solText = (lamports: bigint) => `${fromSmallestUnit(lamports, 9)} SOL`;
  const amountRaw = (): bigint | null => {
    const r = swap.amountText ? toSmallestUnit(swap.amountText, swap.from.decimals) : null;
    return r === null || BigInt(r) === 0n ? null : BigInt(r);
  };

  function tokenButton(side: 'from' | 'to'): void {
    const btn = $<HTMLButtonElement>(`[data-token-btn="${side}"]`);
    if (!btn) return;
    const tk = swap[side];
    btn.textContent = '';
    btn.append(avatar({ icon: tokenIcon(tk), symbol: tk.symbol }), el('span', { text: tk.symbol }));
    btn.insertAdjacentHTML('beforeend', '<svg viewBox="0 0 24 24" width="14" height="14" aria-hidden="true"><path d="M6 9l6 6 6-6" /></svg>');
  }

  function renderSwap(): void {
    if (!$('[data-swap]')) return;
    const { amount, out, go, details, notes } = swapEls();
    if (!out || !go || !details || !notes || !amount) return;
    tokenButton('from');
    tokenButton('to');
    const fromHold = holding(swap.from.mint);
    const toHold = holding(swap.to.mint);
    const bal = (h: Holding | undefined, tk: TokenInfo) => (address ? (holdings === null ? 'Loading…' : `Balance: ${formatAmount(h?.amount ?? 0)} ${tk.symbol}`) : '');
    const fromBal = $('[data-swap-from-bal]');
    const toBal = $('[data-swap-to-bal]');
    if (fromBal) fromBal.textContent = bal(fromHold, swap.from);
    if (toBal) toBal.textContent = bal(toHold, swap.to);
    const fromUsd = $('[data-swap-from-usd]');
    if (fromUsd) fromUsd.textContent = fromHold?.price != null && Number(swap.amountText) > 0 ? `≈ ${formatUsd(Number(swap.amountText) * fromHold.price)}` : '';
    document.querySelectorAll<HTMLElement>('[data-slip]').forEach((b) => b.setAttribute('aria-pressed', String(String(swap.slip) === b.dataset.slip)));

    // result
    out.textContent = swap.quote ? fmtRaw(swap.quote.outAmount, swap.to.decimals) : '0.0';
    void ensureChart();

    // details
    details.textContent = '';
    if (swap.quote) {
      const q = swap.quote;
      const rate = Number(fromSmallestUnit(q.outAmount, swap.to.decimals)) / Number(fromSmallestUnit(q.inAmount, swap.from.decimals));
      const row = (k: string, v: string) => details.append(el('div', {}, [el('dt', { text: k }), el('dd', { text: v })]));
      row('Rate', `1 ${swap.from.symbol} ≈ ${formatAmount(rate)} ${swap.to.symbol}`);
      row('Minimum you receive', `${fmtRaw(q.minOut, swap.to.decimals)} ${swap.to.symbol}`);
      row('Route', q.routes.join(' → ') || '—');
      row('Price impact of your size', swap.impact === null ? '—' : swap.impact < 0.001 ? '<0.1%' : `${(swap.impact * 100).toFixed(1)}%`);
      row('Slippage allowed', `${(slipBps() / 100).toString()}%${swap.slip === 'auto' ? ' (auto)' : ''}`);
    }

    // notes
    notes.textContent = '';
    const note = (kind: 'ok' | 'warn' | 'info', text: string) => notes.append(banner(kind, text));
    const sol = holding(SOL)?.amount ?? 0;
    if (address && holdings !== null && sol < LOW_SOL && swap.from.mint !== SOL) note('warn', lowSolMessage(sol));
    for (const tk of [swap.from, swap.to]) {
      if (tk.verified === false) note('warn', `${tk.symbol} is not verified by Jupiter. Anyone can create a token with this name. Check the mint address: ${tk.mint}`);
    }
    if (involvesAct()) note('info', `ACT is Aretia's own token. Jupiter flags it because it is new and thinly traded, and shows its price impact as −100%, which is not a real measure. ACT carries a ${ACT_INFO.transferFee.totalPercent}% transfer fee on every move; it is already included in the amounts shown here. Real mint: ${ACT_INFO.mint}`);
    if (swap.impact !== null && swap.impact >= 0.05) note('warn', swap.impact >= 0.2 ? `Your trade would move the price by about ${(swap.impact * 100).toFixed(0)}%. This pool is thin: a smaller trade gets a much better price.` : `Your trade would move the price by about ${(swap.impact * 100).toFixed(1)}%.`);
    if (swap.error) note('warn', swap.error);
    if (swap.error && /no route/i.test(swap.error) && swap.from.mint === ACT_INFO.mint) note('info', 'ACT can only be sold for as much as buyers have paid into the pool. Try a smaller amount.');

    // button
    const raw = amountRaw();
    let label = 'Review swap';
    let disabled = false;
    if (!address) label = 'Connect wallet';
    else if (swap.from.mint === swap.to.mint) [label, disabled] = ['Choose two different tokens', true];
    else if (!swap.amountText) [label, disabled] = ['Enter an amount', true];
    else if (raw === null) [label, disabled] = [`Enter a valid ${swap.from.symbol} amount`, true];
    else if (holdings !== null && raw > BigInt(fromHold?.raw ?? '0')) [label, disabled] = [`Not enough ${swap.from.symbol}`, true];
    else if (swap.quoting) [label, disabled] = ['Getting a quote…', true];
    else if (!swap.quote) [label, disabled] = ['No quote available', true];
    go.textContent = label;
    go.disabled = disabled || swap.busy;
  }

  async function requestQuote(): Promise<void> {
    const mine = ++swap.seq;
    const raw = amountRaw();
    swap.quote = null;
    swap.impact = null;
    swap.error = null;
    swap.quoting = false;
    swapEls().review?.replaceChildren();
    if (raw === null || swap.from.mint === swap.to.mint) return void renderSwap();
    swap.quoting = true;
    renderSwap();
    try {
      const q = await fetchQuote(swap.from.mint, swap.to.mint, raw, slipBps());
      if (mine !== swap.seq) return;
      swap.quote = q;
      swap.quoting = false;
      renderSwap();
      const impact = await fetchSizeImpact(swap.from.mint, swap.to.mint, q);
      if (mine !== swap.seq) return;
      swap.impact = impact;
    } catch (e) {
      if (mine !== swap.seq) return;
      swap.error = e instanceof Error ? e.message : 'Could not get a quote.';
      swap.quoting = false;
    }
    renderSwap();
  }
  function scheduleQuote(): void {
    window.clearTimeout(swapTimer);
    swap.seq++;
    swap.quote = null;
    swap.impact = null;
    swapEls().review?.replaceChildren();
    swapTimer = window.setTimeout(() => void requestQuote(), 450);
    renderSwap();
  }

  /** Called by Intent: fills the swap screen and opens it. Nothing is reviewed or sent yet. */
  function prefillSwap(fromMint: string, toMint: string, amountText: string): void {
    const asToken = (mint: string): TokenInfo | undefined => {
      const k = tokenByMint(mint);
      if (k) return k;
      const h = holding(mint);
      return h && h.decimals !== null ? { mint, symbol: h.symbol, name: h.name, decimals: h.decimals, icon: h.icon, verified: null } : undefined;
    };
    const f = asToken(fromMint);
    const t = asToken(toMint);
    if (!f || !t) return;
    swap.from = f;
    swap.to = t;
    swap.amountText = amountText;
    const { amount } = swapEls();
    if (amount) amount.value = amountText;
    location.hash = '#/trade';
    void requestQuote();
  }

  // token picker
  let pickerSide: 'from' | 'to' | null = null;
  let pickerSeq = 0;
  function closePicker(): void {
    pickerSide = null;
    const panel = $<HTMLElement>('[data-picker]');
    if (panel) panel.hidden = true;
  }
  function chooseToken(tk: TokenInfo): void {
    if (!pickerSide) return;
    const other = pickerSide === 'from' ? 'to' : 'from';
    if (swap[other].mint === tk.mint) swap[other] = swap[pickerSide];
    swap[pickerSide] = tk;
    closePicker();
    const { amount } = swapEls();
    // The amount was typed for the old token's decimals: re-check it.
    if (swap.amountText && toSmallestUnit(swap.amountText, swap.from.decimals) === null) {
      swap.amountText = '';
      if (amount) amount.value = '';
    }
    scheduleQuote();
  }
  function pickerRow(tk: TokenInfo): HTMLElement {
    const h = holding(tk.mint);
    const tag = tk.mint === ACT_INFO.mint ? el('span', { class: 'wapp__tag wapp__tag--ok', text: 'Aretia' }) : tk.verified === true ? el('span', { class: 'wapp__tag wapp__tag--ok', text: 'Verified' }) : tk.verified === false ? el('span', { class: 'wapp__tag wapp__tag--warn', text: 'Unverified' }) : null;
    const btn = el('button', { attrs: { type: 'button' } }, [
      avatar({ icon: tokenIcon(tk), symbol: tk.symbol }),
      el('span', { class: 'wapp__picker-name' }, [el('strong', {}, [document.createTextNode(tk.symbol), tag]), el('span', { text: `${tk.name} · ${shorten(tk.mint)}` })]),
      el('span', { class: 'wapp__picker-bal', text: h ? formatAmount(h.amount) : '' }),
    ]);
    btn.addEventListener('click', () => chooseToken(tk));
    return el('li', {}, [btn]);
  }
  async function renderPicker(query: string): Promise<void> {
    const list = $('[data-picker-list]');
    if (!list) return;
    const q = query.trim().toLowerCase();
    const local = new Map<string, TokenInfo>();
    for (const tk of knownTokens) local.set(tk.mint, tk);
    for (const h of holdings ?? []) if (h.decimals !== null && !local.has(h.mint)) local.set(h.mint, { mint: h.mint, symbol: h.symbol, name: h.name, decimals: h.decimals, icon: h.icon, verified: null });
    const matches = [...local.values()].filter((tk) => !q || tk.symbol.toLowerCase().includes(q) || tk.name.toLowerCase().includes(q) || tk.mint.toLowerCase() === q);
    matches.sort((a, b) => Number(Boolean(holding(b.mint))) - Number(Boolean(holding(a.mint))));
    list.textContent = '';
    for (const tk of matches) list.append(pickerRow(tk));
    if (q.length < 2) return;
    const mine = ++pickerSeq;
    list.append(el('li', { class: 'wapp-sub', text: 'Searching Jupiter…' }));
    try {
      const found = await searchTokens(query);
      if (mine !== pickerSeq) return;
      list.lastElementChild?.remove();
      for (const tk of found) if (!local.has(tk.mint)) list.append(pickerRow(tk));
      if (list.children.length === 0) list.append(el('li', { class: 'wapp-sub', text: 'No tokens found.' }));
    } catch {
      if (mine !== pickerSeq) return;
      list.lastElementChild?.remove();
      list.append(el('li', { class: 'wapp-sub', text: 'Search is unavailable right now. Your own tokens are listed above.' }));
    }
  }
  function openPicker(side: 'from' | 'to'): void {
    pickerSide = side;
    const panel = $<HTMLElement>('[data-picker]');
    const search = $<HTMLInputElement>('[data-picker-search]');
    if (!panel || !search) return;
    panel.hidden = false;
    search.value = '';
    void renderPicker('');
    search.focus();
  }

  // review and sign
  function renderSwapReview(plan: SwapPlan, args: { user: string; from: TokenInfo; to: TokenInfo; amountRaw: bigint }, plannedAt: number): void {
    const { review } = swapEls();
    if (!review) return;
    review.textContent = '';
    const card = el('div', { class: 'wapp__result' });
    review.append(card);
    const v = plan.verdict;
    const got = v.received ?? plan.quote.outAmount;
    const rows: [string, string][] = [
      ['You pay', `${fromSmallestUnit(v.paid ?? args.amountRaw, args.from.decimals)} ${args.from.symbol}`],
      [v.received === null ? 'You receive about (quote)' : 'You receive about (simulated)', `${fmtRaw(got, args.to.decimals)} ${args.to.symbol}`],
      ['Minimum you receive', `${fmtRaw(plan.quote.minOut, args.to.decimals)} ${args.to.symbol}`],
      ['Route', plan.quote.routes.join(' → ') || '—'],
      ['Network fee', `about ${solText(BASE_FEE_LAMPORTS + BigInt(plan.priorityFeeLamports))}`],
    ];
    if (plan.opensOutputAccount) rows.push(['Opens your token account', 'about 0.002 SOL, paid by you']);
    card.append(el('strong', { text: 'Review before you sign' }), rowsList(rows));
    const okBanner = plan.blockers.length === 0 ? banner('ok', 'Checked against your balances: nothing else in your wallet changes, and the swap would succeed. No funds have moved.') : null;
    if (okBanner) card.append(okBanner);
    for (const b of plan.blockers) card.append(banner('warn', b));
    const canGo = plan.blockers.length === 0;
    const status = el('div', { attrs: { 'aria-live': 'polite' } });
    const actions = el('div', { class: 'wapp__row-actions' });
    const confirm = el('button', { class: 'wapp__btn wapp__btn--primary', text: 'Confirm in my wallet', attrs: { type: 'button' } });
    const cancel = el('button', { class: 'wapp__btn wapp__btn--ghost', text: canGo ? 'Cancel' : 'Back', attrs: { type: 'button' } });
    confirm.disabled = !canGo;
    confirm.hidden = !canGo;
    cancel.addEventListener('click', () => review.replaceChildren());
    confirm.addEventListener('click', async () => {
      if (swap.busy) return;
      swap.busy = true;
      confirm.disabled = true;
      renderSwap();
      status.textContent = '';
      status.append(banner('info', 'Waiting for your wallet to approve…'));
      try {
        if (address !== args.user) throw new Error('The connected wallet changed. Review the swap again.');
        let active = plan;
        if (Date.now() - plannedAt > 25_000) {
          // The quote and blockhash are about to go stale: rebuild from the same inputs and check again.
          active = await planSwap({ ...args, slippageBps: slipBps(), heldOthers: (holdings ?? []).map((h) => ({ mint: h.mint, symbol: h.symbol })) });
          if (active.blockers.length > 0 || active.quote.minOut < plan.quote.minOut * 98n / 100n) return void renderSwapReview(active, args, Date.now());
        }
        const signature = await signAndSubmitSwap(active);
        status.textContent = '';
        if (okBanner) okBanner.hidden = true; // "no funds have moved" is no longer true once it is sent
        const link = (label: string) => el('a', { text: label, attrs: { href: `https://solscan.io/tx/${signature}`, target: '_blank', rel: 'noopener noreferrer' } });
        status.append(el('p', { class: 'wapp__banner wapp__banner--info' }, [document.createTextNode('Sent. Waiting for confirmation… '), link('View on Solscan')]));
        actions.hidden = true;
        const result = await waitForConfirmation(signature);
        status.textContent = '';
        const text = result === 'confirmed' ? 'Swap confirmed on Solana.' : result === 'failed' ? 'The swap failed on-chain. Nothing was exchanged; check Solscan for the reason.' : 'Not confirmed yet. It may still land; check Solscan.';
        status.append(el('p', { class: `wapp__banner wapp__banner--${result === 'confirmed' ? 'ok' : result === 'failed' ? 'warn' : 'info'}` }, [document.createTextNode(`${text} `), link('View on Solscan')]));
        if (result === 'confirmed') {
          swap.amountText = '';
          const { amount } = swapEls();
          if (amount) amount.value = '';
          swap.quote = null;
        }
        void refresh();
      } catch (e) {
        status.textContent = '';
        status.append(banner('warn', friendlyError(e)));
      } finally {
        swap.busy = false;
        confirm.disabled = false;
        renderSwap();
      }
    });
    actions.append(confirm, cancel);
    card.append(actions, status);
  }

  async function onSwapGo(): Promise<void> {
    if (!address) return void document.querySelector<HTMLButtonElement>('[data-aretia-wallet-mount] button')?.click();
    const raw = amountRaw();
    const { review, go } = swapEls();
    if (raw === null || !review || !go) return;
    review.textContent = '';
    review.append(el('p', { class: 'wapp-sub', text: 'Building and checking the swap…' }));
    go.disabled = true;
    const args = { user: address, from: swap.from, to: swap.to, amountRaw: raw };
    try {
      const plan = await planSwap({ ...args, slippageBps: slipBps(), heldOthers: (holdings ?? []).map((h) => ({ mint: h.mint, symbol: h.symbol })), ...(swap.quote ? { quote: swap.quote } : {}) });
      renderSwapReview(plan, args, plan.plannedAt);
    } catch (e) {
      review.textContent = '';
      review.append(el('p', { class: 'wapp-error', text: friendlyError(e) }));
    } finally {
      renderSwap();
    }
  }

  $('[data-swap-amount]')?.addEventListener('input', (e) => {
    const v = (e.target as HTMLInputElement).value.replace(',', '.').trim();
    swap.amountText = v;
    scheduleQuote();
  });
  $('[data-swap-max]')?.addEventListener('click', () => {
    const h = holding(swap.from.mint);
    if (!h || h.raw === null) return;
    let raw = BigInt(h.raw);
    if (swap.from.mint === SOL) raw = raw > SWAP_SOL_OVERHEAD_LAMPORTS + 5_000n ? raw - SWAP_SOL_OVERHEAD_LAMPORTS - 5_000n : 0n; // leave room for fees and account opening
    swap.amountText = fromSmallestUnit(raw, swap.from.decimals);
    const { amount } = swapEls();
    if (amount) amount.value = swap.amountText;
    scheduleQuote();
  });
  $('[data-swap-flip]')?.addEventListener('click', () => {
    [swap.from, swap.to] = [swap.to, swap.from];
    swap.amountText = '';
    const { amount } = swapEls();
    if (amount) amount.value = '';
    scheduleQuote();
  });
  document.querySelectorAll<HTMLElement>('[data-token-btn]').forEach((b) => b.addEventListener('click', () => openPicker(b.dataset.tokenBtn === 'to' ? 'to' : 'from')));
  $('[data-picker-search]')?.addEventListener('input', (e) => void renderPicker((e.target as HTMLInputElement).value));
  document.addEventListener('keydown', (e) => e.key === 'Escape' && closePicker());
  document.addEventListener('click', (e) => {
    const target = e.target as Element;
    if (pickerSide && !target.closest('[data-picker]') && !target.closest('[data-token-btn]')) closePicker();
  });
  document.querySelectorAll<HTMLElement>('[data-slip]').forEach((b) =>
    b.addEventListener('click', () => {
      swap.slip = b.dataset.slip === 'auto' ? 'auto' : Number(b.dataset.slip);
      scheduleQuote();
    }),
  );
  $('[data-swap-go]')?.addEventListener('click', () => void onSwapGo());
  $('[data-jup-toggle]')?.addEventListener('click', () => {
    const box = $<HTMLElement>('[data-jup-fallback]');
    if (!box) return;
    box.hidden = !box.hidden;
    if (!box.hidden) startJupiter();
  });
  // ---- live chart and trades (DexScreener's embed for the pair's best pool, plus a live price header)
  interface DexPair {
    pairAddress?: string;
    priceUsd?: string;
    priceChange?: { h24?: number };
    volume?: { h24?: number };
    liquidity?: { usd?: number };
    txns?: { h24?: { buys?: number; sells?: number } };
  }
  const STABLES = new Set(KNOWN_TOKENS.filter((k) => k.symbol === 'USDC' || k.symbol === 'USDT').map((k) => k.mint));
  const dexPairs = new Map<string, { at: number; pair: DexPair | null }>();
  const chart = { mint: '', pair: '', timer: undefined as number | undefined, seq: 0 };
  const DEX_PRICE_MS = 12_000;

  /** What the chart shows: ACT when it is in the trade, else the first token that is not a stablecoin or SOL, else SOL. */
  function chartSubject(): TokenInfo {
    if (involvesAct()) return tokenByMint(ACT_INFO.mint)!;
    const pick = [swap.to, swap.from].find((tk) => tk.mint !== SOL && !STABLES.has(tk.mint));
    return pick ?? tokenByMint(SOL)!;
  }

  /** The most liquid pool for a token, from DexScreener. Cached for the page's life; null if it has none. */
  async function bestPair(mint: string, fresh = false): Promise<DexPair | null> {
    const cached = dexPairs.get(mint);
    if (cached && !fresh && Date.now() - cached.at < 5_000) return cached.pair;
    try {
      const pairs = await getJson<DexPair[]>(`https://api.dexscreener.com/tokens/v1/solana/${mint}`);
      const best = (Array.isArray(pairs) ? pairs : []).filter((p) => typeof p.pairAddress === 'string' && isSolanaAddress(p.pairAddress)).sort((a, b) => (b.liquidity?.usd ?? 0) - (a.liquidity?.usd ?? 0))[0] ?? null;
      dexPairs.set(mint, { at: Date.now(), pair: best });
      return best;
    } catch {
      return cached?.pair ?? null;
    }
  }

  function embedUrl(pairAddress: string): string {
    const q = new URLSearchParams({ embed: '1', theme: 'light', chartTheme: 'light', trades: '1', info: '0', tabs: '0', chartLeftToolbar: '0', loadChartSettings: '0', chartStyle: '1', chartType: 'usd', interval: '15' });
    return `https://dexscreener.com/solana/${pairAddress}?${q}`;
  }

  function renderChartHeader(subject: TokenInfo, pair: DexPair | null): void {
    const title = $('[data-chart-title]');
    if (title) {
      title.textContent = '';
      title.append(avatar({ icon: tokenIcon(subject), symbol: subject.symbol }), el('span', {}, [document.createTextNode(`${subject.symbol} / USD `), el('small', { text: subject.name })]));
    }
    const price = $('[data-chart-price]');
    const change = $('[data-chart-change]');
    const stats = $('[data-chart-stats]');
    const live = $<HTMLElement>('[data-chart-live]');
    const usd = pair?.priceUsd !== undefined ? Number(pair.priceUsd) : NaN;
    if (price) price.textContent = Number.isFinite(usd) && usd > 0 ? formatPriceUsd(usd) : '—';
    const h24 = pair?.priceChange?.h24;
    if (change) {
      change.className = typeof h24 !== 'number' ? '' : h24 > 0 ? 'is-up' : h24 < 0 ? 'is-down' : '';
      change.textContent = typeof h24 === 'number' ? `${h24 >= 0 ? '+' : ''}${h24.toFixed(2)}% · 24h` : '';
    }
    if (stats) {
      stats.textContent = '';
      if (pair) {
        const t24 = pair.txns?.h24;
        for (const [k, v] of [['24h volume', formatUsd(pair.volume?.h24 ?? 0)], ['Liquidity', formatUsd(pair.liquidity?.usd ?? 0)], ['24h trades', String((t24?.buys ?? 0) + (t24?.sells ?? 0))]] as const) stats.append(el('div', {}, [el('dt', { text: k }), el('dd', { text: v })]));
      }
    }
    if (live) live.hidden = !pair;
    const open = $<HTMLAnchorElement>('[data-chart-open]');
    if (open) open.href = pair?.pairAddress ? `https://dexscreener.com/solana/${pair.pairAddress}` : 'https://dexscreener.com';
  }

  /** Sub-cent prices need more places than a currency format gives. */
  const formatPriceUsd = (n: number): string => (n >= 1 ? formatUsd(n) : `$${n.toPrecision(4).replace(/(\.\d*?)0+$/, '$1').replace(/\.$/, '')}`);

  async function ensureChart(): Promise<void> {
    const host = $<HTMLElement>('[data-chart-plot]');
    if (!host || currentView() !== 'trade') return;
    const subject = chartSubject();
    renderChartHeader(subject, dexPairs.get(subject.mint)?.pair ?? null);
    if (subject.mint === chart.mint && host.querySelector('iframe')) return;
    chart.mint = subject.mint;
    const mine = ++chart.seq;
    host.textContent = '';
    host.append(el('span', { class: 'wapp__sub', text: 'Loading chart…' }));
    // ACT's own pool is known; anything else is looked up.
    const pair = subject.mint === ACT_INFO.mint ? ((await bestPair(subject.mint, true)) ?? ({ pairAddress: POOLS[0]!.address } as DexPair)) : await bestPair(subject.mint, true);
    if (mine !== chart.seq) return;
    renderChartHeader(subject, pair);
    host.textContent = '';
    if (!pair?.pairAddress) return void host.append(el('span', { class: 'wapp__sub', text: `DexScreener has no chart for ${subject.symbol} yet.` }));
    chart.pair = pair.pairAddress;
    const frame = el('iframe', { class: 'wapp__chart-frame', attrs: { title: `${subject.symbol} live price chart and trades from DexScreener`, loading: 'lazy', referrerpolicy: 'strict-origin-when-cross-origin', sandbox: 'allow-scripts allow-same-origin allow-popups allow-popups-to-escape-sandbox' } });
    frame.src = embedUrl(pair.pairAddress);
    host.append(frame);
  }

  /** Keeps the price header live while the Trade tab is open and the page is visible. */
  function startChartTimer(): void {
    window.clearInterval(chart.timer);
    chart.timer = window.setInterval(async () => {
      if (document.hidden || currentView() !== 'trade') return;
      const subject = chartSubject();
      renderChartHeader(subject, await bestPair(subject.mint, true));
    }, DEX_PRICE_MS);
  }
  startChartTimer();

  // ---- trade widget (loaded only if the visitor asks for Jupiter's own screen)
  let jupiterStarted = false;
  let jupiterForm: Record<string, unknown> = { initialInputMint: SOL_MINT, initialOutputMint: ACT_MINT, fixedOutputMint: false };
  /** `prefill` comes from Intent: the tokens and amount to show. It never submits anything. */
  function startJupiter(prefill?: Record<string, unknown>): void {
    if (prefill) jupiterForm = prefill;
    const init = () => {
      window.Jupiter?.init({
        displayMode: 'integrated',
        integratedTargetId: 'jupiter-terminal',
        endpoint: RPC_URL,
        enableWalletPassthrough: true,
        passthroughWalletContextState: window.AretiaWallet?.getWalletContextState(),
        formProps: jupiterForm,
      });
    };
    if (jupiterStarted) {
      if (prefill) init();
      return;
    }
    jupiterStarted = true;
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
      if (to.length === 0) problems.push(`Intent does not know ${intent.toAssetSymbol}. It only swaps into tokens you hold, plus SOL, USDC, USDT and ACT. Use the Trade tab to search for others.`);
      if (f && t && f.mint === t.mint) problems.push('That swaps a token for itself.');
      if (f && f.amount !== null && Number(intent.amount) > f.amount) problems.push(`You hold ${formatAmount(f.amount)} ${f.symbol}, which is less than ${intent.amount}.`);
      const raw = f && f.decimals !== null ? toSmallestUnit(intent.amount, f.decimals) : null;
      if (f && f.decimals !== null && raw === null) problems.push(`${f.symbol} has ${f.decimals} decimal places, so ${intent.amount} is too precise.`);
      if (f && f.decimals === null) actions.append(el('p', { class: 'wapp__banner wapp__banner--info', text: `Intent does not know how many decimals ${f.symbol} uses, so it will not fill in the amount. Enter it in the Trade tab.` }));
      for (const p of problems) actions.append(el('p', { class: 'wapp__banner wapp__banner--warn', text: p }));
      // Not a blocker (the wallet may still have enough), but the usual reason a non-SOL swap fails.
      const sol = holdings?.find((h) => h.mint === SOL_MINT)?.amount ?? 0;
      if (f && f.mint !== SOL_MINT && sol < LOW_SOL) actions.append(el('p', { class: 'wapp__banner wapp__banner--warn', text: lowSolMessage(sol) }));
      const ready = f !== undefined && t !== undefined && problems.length === 0;
      const go = el('button', { class: 'wapp__btn wapp__btn--primary', text: 'Continue to Trade', attrs: { type: 'button' } });
      go.disabled = !ready;
      go.addEventListener('click', () => {
        if (!f || !t) return;
        prefillSwap(f.mint, t.mint, intent.amount);
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

  // ---- wiring
  function onRoute(): void {
    renderChrome();
    renderSwap();
    if (currentView() === 'trade') {
      void loadWeb3();
      void ensureChart();
    }
    if (currentView() === 'send') void loadWeb3();
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

  // "Lock wallet": the page forgets the wallet. Keys never lived here, so this only disconnects.
  $('[data-lock]')?.addEventListener('click', () => void window.AretiaWallet?.disconnect());

  function clearSessionOutputs(): void {
    for (const sel of ['[data-send-review]', '[data-intent-result]', '[data-shield-result]']) $(sel)?.replaceChildren();
    for (const sel of ['[data-send-to]', '[data-send-amount]', '#intent-input', '#shield-input']) {
      const field = $<HTMLInputElement>(sel);
      if (field) field.value = '';
    }
  }

  function onWallet(state: WalletState): void {
    const next = state.account?.address ?? null;
    walletName = state.walletName;
    if (next === address) return void renderChrome();
    address = next;
    clearSessionOutputs();
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
  void loadKnownIcons();
  onRoute();
  if (!wire()) {
    // wallet.js loads just before this script; wait briefly if it is a tick behind.
    let tries = 0;
    const t = setInterval(() => {
      if (wire() || ++tries > 40) clearInterval(t);
    }, 100);
  }
}
