import { ACT as ACT_INFO } from '../data/site';
import { RPC_URL, loadWeb3, planSend, rpcCall, resolveName, signAndSubmit, simulatePlan, waitForConfirmation, type SendPlan, type SendRequest, type Simulation } from './walletSend';
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
  const balances = await getJson<Record<string, JupBalance>>(`https://lite-api.jup.ag/ultra/v1/balances/${address}`);
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

type View = 'dashboard' | 'send' | 'trade' | 'activity' | 'shield' | 'intent';
const VIEWS: View[] = ['dashboard', 'send', 'trade', 'activity', 'shield', 'intent'];
const TITLES: Record<View, string> = { dashboard: 'Dashboard', send: 'Send', trade: 'Trade', activity: 'Activity', shield: 'Shield', intent: 'Intent' };

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

  // ---- trade widget (loaded only when the Trade tab is first opened)
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
      const ready = f !== undefined && t !== undefined && problems.length === 0;
      const go = el('button', { class: 'wapp__btn wapp__btn--primary', text: 'Continue to Trade', attrs: { type: 'button' } });
      go.disabled = !ready;
      go.addEventListener('click', () => {
        if (!f || !t) return;
        const amount = f.decimals !== null ? toSmallestUnit(intent.amount, f.decimals) : null;
        startJupiter({ initialInputMint: f.mint, initialOutputMint: t.mint, ...(amount !== null ? { initialAmount: amount } : {}) });
        location.hash = '#/trade';
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
    if (currentView() === 'trade') startJupiter();
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
