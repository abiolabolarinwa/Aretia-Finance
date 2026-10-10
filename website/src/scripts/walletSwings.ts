/**
 * Aretia Swings screen for the web wallet: Swap, New Tokens, Markets and Activity.
 *
 * Live: same-chain swaps on Solana (Jupiter, behind the Aretia router). EVM swaps (0x, behind the same
 * router) are built but stay off until the operator switches a chain on and the server reports it; the
 * screen then says "Enabled", otherwise "Off". Nothing is signed without the review screen,
 * and the user's own wallet asks for the final approval.
 *
 * Data leaving the page: Solana swaps send the token pair, amount and wallet address to Jupiter and
 * Aretia's RPC proxy. EVM quotes go to Aretia's /api/swings-0x (which calls 0x); EVM reads go to the
 * chain's public node. Token lists call Aretia's /api/swings-tokens. History stays in this browser.
 */
import { createCrossChainRuntime } from './crossChainRuntime.js';
import { initCrossChain } from './walletCrossChain.js';
import { initRamp } from './walletRamp.js';
import { initPlan } from './walletPlan.js';
import { mountTokenSearch, OPEN_TOKEN_EVENT, PREFILL_SWAP_EVENT } from './walletSearch.js';
import { markSelected, marketTable, tableRowKey, updateLiquidityCells, updateRatingCells, type TableState } from './walletMarketTable.js';
import { createLockQueue } from './walletLocks.js';
import { tokenOpenMode } from './walletNav';
import { checkLock, LOCK_MIN_PCT } from '../swings/market/lock.js';
import { rpcCall } from './walletSend';
import { createMarketPanel } from './walletMarketPanel.js';
import { ratingKey } from './walletRatingGuide.js';
import { notify } from './walletNotifications.js';
import { dexScreenerEmbedUrl } from '../swings/charts/pool.js';
import { createRatingQueue } from './walletRatings.js';
import { marketFactsOf, ratingView, riskMemory } from '../swings/market/rowRisk.js';
import { GeckoMarket, type MarketKind, type Window as MarketWindow } from '../swings/market/gecko.js';
import { rowsFromFavourites, rowsFromRecords } from '../swings/market/registryRows.js';
import { applyRatings, fetchRatings } from '../swings/market/ratings.js';
import { AccountClient, type Session, type Signer } from '../swings/account/client.js';
import { FavouriteStore, type Favourite } from '../swings/account/favourites.js';
import { formatAge, formatChange, formatPrice, sortRows, type MarketRow } from '../swings/market/types.js';
import { AlertStore, evaluateMoves, PCT_CHOICES } from '../swings/account/priceAlerts.js';
import { createToaster } from './walletToast.js';
import { sponsorBlock } from './walletSponsor.js';
import type { SearchHit } from '../swings/tokens/globalSearch.js';
import { viewStatus } from '../swings/crosschain/view.js';
import { connectWalletConnect, hasSavedSession, isProjectId, restoreWalletConnect } from '../swings/wallet/walletConnect.js';
import { CHAINS, CHAIN_IDS, EVM_NATIVE_ADDRESS, SwingsError, type ChainId, type PreparedSwap, type Quote, type SwapExecution, type TokenRecord, type TokenRisk } from '../swings/core/types.js';
import { describeSafety } from '../swings/tokens/safety.js';
import { avatar, createChartPanel } from './walletChart';
import { createTokenPage } from './walletTokenPage';
import { cachedLogo, ensureLogos } from '../swings/tokens/logos.js';
import { WRAPPED_NATIVE } from '../swings/dex/entries.js';
import { summarizeQuote } from '../swings/core/summary.js';
import { assessMevExposure } from '../swings/core/mev.js';
import { normalizeTokenRef } from '../swings/core/token.js';
import { assessTokenSafety, createLiveRouter, onchainDecimals, registerEvmWallet } from '../swings/live.js';
import { evmGasProblem, EvmSession, publicRead, readBalance, readErc20 } from '../swings/chains/evmSession.js';
import { isChainEnabled, loadRuntime, runtime } from '../swings/runtime.js';
import { browserStorage, SwapHistory, type HistoryItem } from '../swings/history.js';
import { AretiaRouter } from '../swings/router/router.js';
import { fetchSizeImpact, searchTokens, SOL_MINT, type Quote as JupiterQuote, type TokenInfo } from './walletSwap';
import { KNOWN_TOKENS, SLIPPAGE_PRESETS_BPS, defaultSlippageBps, fromSmallestUnit, toSmallestUnit } from './walletTools';
import { cushionUnits, FEE_CUSHION, shareOfBalance, SHARES, type Share } from './walletAmount.js';

export interface SwingsHolding {
  mint: string;
  symbol: string;
  name: string;
  icon: string | null;
  amount: number;
  raw: string | null;
  decimals: number | null;
}

export interface SwingsHost {
  getAddress(): string | null;
  /** The name of the wallet connected in the sidebar (for example MetaMask), so the same wallet can be reused on EVM networks. */
  getWalletName(): string | null;
  getHoldings(): SwingsHolding[] | null;
  refresh(): Promise<void>;
}

const ACT_MINT = '7Ut5njM9ajGDjP83WvJmvrAcfi9JoVYrHSK5x5sSFrTG';
const EXPLORER_TX: Readonly<Record<ChainId, string>> = {
  solana: 'https://solscan.io/tx/',
  ethereum: 'https://etherscan.io/tx/',
  bnb: 'https://bscscan.com/tx/',
  polygon: 'https://polygonscan.com/tx/',
  arbitrum: 'https://arbiscan.io/tx/',
  optimism: 'https://optimistic.etherscan.io/tx/',
  avalanche: 'https://snowtrace.io/tx/',
  base: 'https://basescan.org/tx/',
  robinhood: 'https://robinhoodchain.blockscout.com/tx/',
};

function el<K extends keyof HTMLElementTagNameMap>(tag: K, props: { class?: string; text?: string; attrs?: Record<string, string> } = {}, children: (Node | null | false)[] = []): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (props.class) node.className = props.class;
  if (props.text !== undefined) node.textContent = props.text;
  for (const [k, v] of Object.entries(props.attrs ?? {})) node.setAttribute(k, v);
  for (const c of children) if (c) node.append(c);
  return node;
}

/** An amount for the screen: long tails are cut (the transaction keeps every digit), small values keep six significant digits. */
export function shortAmount(v: string): string {
  const [whole = '', frac = ''] = v.split('.');
  if (frac.length <= 8) return v;
  const lead = /^0*/.exec(frac)![0].length;
  const kept = frac.slice(0, Math.max(8, lead + 6)).replace(/0+$/, '');
  return kept ? `${whole}.${kept}` : whole;
}
const short = (a: string): string => (a.length > 12 ? `${a.slice(0, 4)}…${a.slice(-4)}` : a);
/** A stroked 24x24 icon from one path, built as real SVG so nothing is parsed from text. */
function icon(path: string, size = 18): SVGElement {
  const ns = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(ns, 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('width', String(size));
  svg.setAttribute('height', String(size));
  svg.setAttribute('aria-hidden', 'true');
  const p = document.createElementNS(ns, 'path');
  p.setAttribute('d', path);
  svg.append(p);
  return svg;
}
const banner = (kind: 'warn' | 'info' | 'ok', text: string): HTMLElement => el('p', { class: `wapp__banner wapp__banner--${kind}`, text });
const isEvm = (c: ChainId): boolean => CHAINS[c].kind === 'evm';
/** Says plainly which engine produced a quote: Aretia's own routing, or a non-core aggregator. */
const providerLabel = (id: string): string => (id === 'aretia' || id === 'aretia-sol' ? 'Aretia Router (direct from the venues)' : id === 'jupiter' ? 'Jupiter (outside aggregator)' : id === '0x' ? '0x (outside aggregator)' : id);

type Phase = 'idle' | 'quoting' | 'quoted' | 'preparing' | 'review' | 'signing' | 'tracking' | 'done';

const WC_PROJECT_ID = String(import.meta.env.PUBLIC_WALLETCONNECT_PROJECT_ID ?? '');
/** Where the 0.29% Aretia fee goes on EVM networks. Set it in Vercel; until then EVM swaps are paused. */
const EVM_FEE_ADDRESS = String(import.meta.env.PUBLIC_ARETIA_EVM_FEE_ADDRESS ?? '');

export function initSwings(host: SwingsHost): { onShow(view: 'swings' | 'swap' | 'favourites'): void; onPayShow(): void; onWalletChange(): void; onActivityShow(): void } {
  const root = document.querySelector<HTMLElement>('[data-pane="swings"]');
  if (!root) return { onShow() {}, onPayShow() {}, onWalletChange() {}, onActivityShow() {} };
  const panel = (name: string): HTMLElement => root.querySelector<HTMLElement>(`[data-sw-panel="${name}"]`)!;
  const swapPanel = panel('swap');
  // Swaps and moves are listed in the sidebar's Activity page, not in a tab here.
  const activityPanel = document.querySelector<HTMLElement>('[data-swings-activity]') ?? el('div');
  // Pay holds the cash-out and USDC-transfer screens; they are built here because they share this page's wallet and router.
  const rampPanel = document.querySelector<HTMLElement>('[data-pay-panel="ramp"]')!;
  const movePanel = document.querySelector<HTMLElement>('[data-transfer-pane="move"]')!;
  const planPanel = document.querySelector<HTMLElement>('[data-transfer-pane="plan"]')!;

  // Tokens the user picked, by address: names and icons only. Decimals are re-read from the chain.
  const picked = new Map<string, TokenInfo>();
  const router: AretiaRouter = createLiveRouter({
    evmFeeAddress: EVM_FEE_ADDRESS,
    heldOthers: () => (host.getHoldings() ?? []).map((h) => ({ mint: h.mint, symbol: h.symbol })),
    knownToken: (mint) => picked.get(mint) ?? null,
  });
  const evm = new EvmSession();
  // A lock, an account switch or a network change inside the wallet shows here at once, and a quote made for another
  // account (or for a wallet that has locked) is dropped; unlocking prices the swap again.
  evm.onChange = ({ accountChanged }) => {
    if (accountChanged) resetQuote();
    render();
  };
  // One chart for the swap screen, moved between redraws so it is not rebuilt every time the screen changes.
  const swapChart = createChartPanel();
  // These nodes live for the whole page. A browser reloads an iframe whenever it, or anything above it, is taken out of the
  // page and put back, so the chart's ancestors must never be rebuilt: a render only refills the swap card and the details.
  const swapCard = el('div', { class: 'wapp__card wapp__swap' });
  const swapChartCard = el('div', { class: 'wapp__card' }, [swapChart.element]);
  const swapSide = el('div', { class: 'wapp__trade-side' }, [swapChartCard]);
  const swapGrid = el('div', { class: 'wapp__grid wapp__grid--trade' }, [swapCard, swapSide]);
  swapPanel.append(swapGrid);
  const history = new SwapHistory(browserStorage());
  const account = new AccountClient(browserStorage());
  const favourites = new FavouriteStore(browserStorage());
  const alerts = new AlertStore(browserStorage());
  const toaster = createToaster();
  let alertsChanged: () => void = () => undefined;

  /**
   * Checks the favourites' prices and pops an alert for any that has moved by the chosen percentage since it was starred
   * (or last alerted). Runs only while the page is open and visible: nothing watches prices for a closed page.
   */
  async function checkFavouritePrices(): Promise<void> {
    if (document.hidden) return;
    const favs = favourites.list();
    if (favs.length === 0) return;
    let rows: MarketRow[];
    try {
      rows = await rowsFromFavourites(favs);
    } catch {
      return;
    }
    const items = rows.map((r) => ({ chain: r.chain, address: r.address, symbol: r.symbol, icon: r.icon, priceUsd: r.priceUsd }));
    const res = evaluateMoves(items, alerts.baselines(), alerts.pct(), Date.now());
    alerts.record(res.baselines, res.alerts);
    // A burst is capped so the pop-ups do not run on for minutes; every alert is still listed on the Favourites page.
    res.alerts.forEach((a, i) => {
      const up = a.movePct > 0;
      const note = { title: `${a.symbol} ${up ? '▲ +' : '▼ '}${a.movePct.toFixed(1)}%`, detail: `${formatPrice(a.price)}, was ${formatPrice(a.baseline)}`, tone: up ? 'up' : 'down', icon: a.icon } as const;
      if (i < 5) toaster.show(note);
      // Every alert goes to the bell; a burst rings once, for the biggest move.
      notify(note, { quiet: i > 0 });
    });
    if (res.alerts.length > 0) alertsChanged();
  }
  setTimeout(() => void checkFavouritePrices(), 8_000);
  setInterval(() => void checkFavouritePrices(), 30_000);
  let accountMessage: string | null = null;
  let accountBusy = false;

  /** Who would sign: the Ethereum-style wallet on an Ethereum-style network, otherwise the wallet connected in the sidebar. */
  function signerNow(): Signer | null {
    if (isEvm(s.chain)) {
      const adapter = evm.adapter;
      const address = evm.account;
      if (!adapter || !address) return null;
      const hex = (m: string): string => '0x' + [...new TextEncoder().encode(m)].map((b) => b.toString(16).padStart(2, '0')).join('');
      return { family: 'evm', address, sign: (m) => adapter.signMessage(hex(m), address) };
    }
    const address = host.getAddress();
    const ctx = (window as unknown as { AretiaWallet?: { getWalletContextState(): { signMessage?: (m: Uint8Array) => Promise<Uint8Array> } } }).AretiaWallet?.getWalletContextState();
    const signMessage = ctx?.signMessage;
    if (!address || !signMessage) return null;
    return { family: 'solana', address, sign: async (m) => btoa(String.fromCharCode(...(await signMessage(new TextEncoder().encode(m))))) };
  }
  const sessionNow = (): Session | null => {
    const sg = signerNow();
    return sg ? account.session(sg.family, sg.address) : null;
  };

  /** Brings this device and the wallet's saved copy together: favourites both ways, swap history both ways. */
  async function syncAccount(session: Session): Promise<void> {
    const data = await account.get(session);
    const onlyHere = favourites.merge(data.favourites as unknown as Favourite[]);
    for (const f of onlyHere) await account.setFavourite(session, f, true);
    history.merge(data.trades);
    const mine = history.list(session.address);
    if (mine.length > 0) await account.saveTrades(session, mine);
  }
  const redrawAccount = (): void => {
    markets.draw();
    renderActivity();
  };
  async function signInNow(): Promise<void> {
    const sg = signerNow();
    if (!sg || accountBusy) return;
    accountBusy = true;
    accountMessage = null;
    redrawAccount();
    try {
      const session = await account.signIn(sg);
      await syncAccount(session);
      accountMessage = 'Saved. Your favourites and swaps now follow this wallet.';
    } catch (e) {
      accountMessage = e instanceof SwingsError || e instanceof Error ? (/reject|declin|denied/i.test(e.message) ? 'The sign-in was declined, so nothing was saved.' : e.message) : 'Signing in did not work. Try again.';
    }
    accountBusy = false;
    redrawAccount();
  }
  function autoSync(): void {
    const session = sessionNow();
    if (session) void syncAccount(session).then(redrawAccount).catch(() => undefined);
  }
  const pushTrades = (): void => {
    const session = sessionNow();
    if (session) void account.saveTrades(session, history.list(session.address)).catch(() => undefined);
  };

  /** The line that says whether favourites and swaps are saved to the wallet, with the one button to turn that on or off. */
  function accountBar(): HTMLElement {
    const bar = el('div', { class: 'wapp-acct' });
    const session = sessionNow();
    const sg = signerNow();
    if (session) {
      const off = el('button', { class: 'wapp__btn wapp__btn--ghost', text: 'Sign out', attrs: { type: 'button' } });
      off.addEventListener('click', () => {
        account.signOut(sg!.family, sg!.address);
        accountMessage = null;
        redrawAccount();
      });
      bar.append(el('span', { class: 'wapp__fine', text: `Saved to ${short(session.address)}: your favourites and swaps follow this wallet on every device.` }), off);
    } else if (sg) {
      const on = el('button', { class: 'wapp__btn wapp__btn--ghost', text: accountBusy ? 'Waiting for your wallet…' : 'Save to my wallet', attrs: { type: 'button' } });
      on.disabled = accountBusy;
      on.addEventListener('click', () => void signInNow());
      bar.append(on, el('span', { class: 'wapp__fine', text: 'Sign a free message (it is not a transaction and cannot move funds) to keep favourites and swap history on every device.' }));
    } else bar.append(el('span', { class: 'wapp__fine', text: 'Connect a wallet to save favourites and swaps to it.' }));
    if (accountMessage) bar.append(el('span', { class: 'wapp__fine', text: accountMessage }));
    return bar;
  }
  const chainRuntime = createCrossChainRuntime(evm, (c) => isChainEnabled(c), () => host.getAddress());
  const crossChain = initCrossChain(movePanel, chainRuntime);
  const planTab = initPlan(planPanel, chainRuntime);
  const ramp = initRamp(rampPanel, evm, () => host.getAddress(), (c) => isChainEnabled(c));
  const s = {
    chain: 'solana' as ChainId,
    from: null as TokenInfo | null,
    to: null as TokenInfo | null,
    amount: '',
    slippageBps: 50,
    slippageTouched: false,
    /** Solana only: send privately through Jito, with a small tip, to lower the chance of being sandwiched. */
    protect: false,
    phase: 'idle' as Phase,
    quote: null as Quote | null,
    alternatives: [] as Quote[],
    failures: [] as string[],
    prepared: null as PreparedSwap | null,
    extraBlockers: [] as string[],
    sizeImpact: null as number | null,
    execution: null as SwapExecution | null,
    error: null as string | null,
    notice: null as string | null,
    picker: null as null | { side: 'from' | 'to'; query: string; results: TokenInfo[]; loading: boolean },
    walletChoices: null as null | { uuid: string; name: string }[],
    /** The safety assessment of the token being bought, keyed so a slow answer for an old token is ignored. */
    safety: { key: '', loading: false, risk: null as TokenRisk | null, acknowledged: false },
    seq: 0,
    /** When the price on screen was read, and when its transaction was last built and checked (ms). */
    quotedAt: 0,
    preparedAt: 0,
    /** The wallet said it never sent the batch: offer to send the same swap one step at a time. */
    stepByStep: false,
    /** The balance of the token being paid on an EVM network, read once per wallet and token (Solana's comes from the dashboard). */
    balance: { key: '', raw: null as bigint | null },
  };

  const accountFor = (chain: ChainId): string | null => (isEvm(chain) ? evm.account : host.getAddress());

  // ------------------------------------------------------------------ token selection

  async function describeToken(chain: ChainId, info: TokenInfo): Promise<TokenInfo | null> {
    if (!isEvm(chain)) {
      const decimals = await onchainDecimals(info.mint).catch(() => null);
      return decimals === null ? null : { ...info, decimals };
    }
    if (info.mint === EVM_NATIVE_ADDRESS) return { ...info, symbol: CHAINS[chain].nativeSymbol, decimals: CHAINS[chain].nativeDecimals };
    const ref = normalizeTokenRef(chain, info.mint);
    if (!ref) return null;
    const facts = await readErc20(publicRead(chain), ref.address);
    return facts ? { ...info, mint: ref.address, symbol: facts.symbol, name: facts.name || info.name, decimals: facts.decimals } : null;
  }

  async function pick(side: 'from' | 'to', info: TokenInfo, chain: ChainId = s.chain): Promise<void> {
    if (chain !== s.chain) {
      s.chain = chain;
      s.from = null;
      s.to = null;
    }
    // The token list is not trusted for decimals: ask the chain itself before any amount is built.
    const checked = await describeToken(chain, info);
    if (!checked) {
      s.error = `${info.symbol} could not be read on-chain, so it cannot be swapped.`;
      return render();
    }
    picked.set(checked.mint, checked);
    s[side] = checked;
    s.picker = null;
    if (!s.slippageTouched) s.slippageBps = defaultSlippageBps(checked.mint === ACT_MINT || s.from?.mint === ACT_MINT || s.to?.mint === ACT_MINT);
    resetQuote();
    if (side === 'to') void loadSafety(chain, checked.mint);
    render();
    scheduleAuto();
  }

  /** Assesses the token being bought, in the page, against the chain. A slow answer for a token no longer chosen is dropped. */
  async function loadSafety(chain: ChainId, mint: string): Promise<void> {
    const key = `${chain}:${mint}`;
    if (mint === EVM_NATIVE_ADDRESS || mint === SOL_MINT) {
      s.safety = { key, loading: false, risk: null, acknowledged: false };
      return;
    }
    // A check the Markets list has already made for this token is reused, so both screens say the same thing.
    const known = riskMemory.get(chain, mint);
    if (known) {
      s.safety = { key, loading: false, risk: known.risk, acknowledged: false };
      return;
    }
    s.safety = { key, loading: true, risk: null, acknowledged: false };
    const risk = await assessTokenSafety(chain, mint);
    riskMemory.set(chain, mint, risk);
    if (s.safety.key !== key) return;
    s.safety = { key, loading: false, risk, acknowledged: false };
    render();
  }

  function resetQuote(): void {
    s.seq++;
    s.stepByStep = false;
    if (evm.adapter) evm.adapter.allowBatch = true;
    s.phase = 'idle';
    s.quote = null;
    s.alternatives = [];
    s.failures = [];
    s.prepared = null;
    s.extraBlockers = [];
    s.sizeImpact = null;
    s.execution = null;
    s.error = null;
    s.notice = null;
  }

  function quickTokens(): TokenInfo[] {
    if (isEvm(s.chain)) return [{ mint: EVM_NATIVE_ADDRESS, symbol: CHAINS[s.chain].nativeSymbol, name: `${CHAINS[s.chain].name} native coin`, decimals: CHAINS[s.chain].nativeDecimals, icon: null, verified: true }];
    const seen = new Set<string>();
    const out: TokenInfo[] = [];
    for (const h of host.getHoldings() ?? []) {
      if (h.decimals === null || seen.has(h.mint)) continue;
      seen.add(h.mint);
      out.push({ mint: h.mint, symbol: h.symbol, name: h.name, decimals: h.decimals, icon: h.icon, verified: null });
    }
    for (const k of KNOWN_TOKENS) {
      if (seen.has(k.mint)) continue;
      seen.add(k.mint);
      out.push({ mint: k.mint, symbol: k.symbol, name: k.symbol, decimals: k.decimals, icon: null, verified: true });
    }
    return out;
  }

  async function searchFor(query: string): Promise<TokenInfo[]> {
    if (!isEvm(s.chain)) return searchTokens(query);
    const ref = normalizeTokenRef(s.chain, query.trim());
    if (ref) {
      const facts = await readErc20(publicRead(s.chain), ref.address);
      return facts ? [{ mint: ref.address, symbol: facts.symbol, name: facts.name, decimals: facts.decimals, icon: null, verified: null }] : [];
    }
    const res = await fetch(`/api/swings-tokens?q=${encodeURIComponent(query.trim())}`);
    const body = (await res.json().catch(() => null)) as { results?: { record: TokenRecord }[] } | null;
    return (body?.results ?? [])
      .filter((r) => r.record.ref.chain === s.chain)
      .map((r) => ({ mint: r.record.ref.address, symbol: r.record.symbol, name: r.record.name, decimals: r.record.decimals, icon: r.record.logo, verified: r.record.verified }));
  }

  let searchTimer: ReturnType<typeof setTimeout> | undefined;
  function onSearchInput(query: string): void {
    if (!s.picker) return;
    s.picker.query = query;
    clearTimeout(searchTimer);
    if (query.trim().length < 2) {
      s.picker.results = [];
      s.picker.loading = false;
      return renderPicker();
    }
    s.picker.loading = true;
    renderPicker();
    searchTimer = setTimeout(async () => {
      const mine = s.picker;
      if (!mine || mine.query !== query) return;
      try {
        const results = await searchFor(query);
        if (s.picker === mine && mine.query === query) mine.results = results;
      } catch {
        if (s.picker === mine) mine.results = [];
      }
      if (s.picker === mine) {
        mine.loading = false;
        renderPicker();
      }
    }, 300);
  }

  // ------------------------------------------------------------------ actions

  const rawAmount = (): bigint | null => {
    if (!s.from) return null;
    const raw = toSmallestUnit(s.amount.trim(), s.from.decimals);
    return raw === null || BigInt(raw) <= 0n ? null : BigInt(raw);
  };

  function balanceProblem(amountIn: bigint): string | null {
    if (isEvm(s.chain)) return null; // checked against the chain when the quote is requested
    const held = (host.getHoldings() ?? []).find((h) => h.mint === s.from?.mint);
    if (!held?.raw) return null; // unknown here; the simulation will catch a real shortfall
    return BigInt(held.raw.split('.')[0]!) < amountIn ? `You hold less ${s.from!.symbol} than that.` : null;
  }

  /** A price this old is read again before anything is signed. */
  const FRESH_MS = 8_000;
  /** While the swap is on screen the price is read again this often, quietly. */
  const REFRESH_MS = 6_000;
  let swapBusy = false;
  let autoTimer: ReturnType<typeof setTimeout> | undefined;
  let detailsOpen = false;

  /** What is held of the token being paid, in its smallest unit, or null while it is not known yet. */
  function currentBalance(): bigint | null {
    if (!s.from) return null;
    if (!isEvm(s.chain)) {
      const held = (host.getHoldings() ?? []).find((h) => h.mint === s.from!.mint);
      return held?.raw ? BigInt(held.raw.split('.')[0]!) : null;
    }
    const address = accountFor(s.chain);
    return address && s.balance.key === `${s.chain}:${address}:${s.from.mint}` ? s.balance.raw : null;
  }

  /** Reads an EVM balance once for the wallet and token on screen, then redraws so the 10% / 50% / Max buttons can use it. */
  function loadBalance(): void {
    const address = accountFor(s.chain);
    if (!isEvm(s.chain) || !address || !s.from) return;
    const key = `${s.chain}:${address}:${s.from.mint}`;
    if (s.balance.key === key) return;
    s.balance = { key, raw: null };
    const chain = s.chain;
    void readBalance(publicRead(chain), address, s.from.mint)
      .then((raw) => {
        if (s.balance.key !== key) return;
        s.balance.raw = raw;
        render();
      })
      // Not read: leave it unknown (the buttons stay off) and ask again the next time the screen is drawn.
      .catch(() => {
        if (s.balance.key === key) s.balance = { key: '', raw: null };
      });
  }

  /** 10%, 50% or Max of what is held goes into the amount box, and the price follows by itself. */
  function useShare(share: Share): void {
    const bal = currentBalance();
    const from = s.from;
    if (!from || bal === null) return;
    const native = from.mint === EVM_NATIVE_ADDRESS || from.mint === SOL_MINT;
    const exact = shareOfBalance(bal, share, native ? { cushion: cushionUnits(FEE_CUSHION[s.chain], from.decimals) } : null);
    // Rounded down to 8 places so the box shows a number a person can read, never a figure above what was meant.
    const step = 10n ** BigInt(Math.max(0, from.decimals - 8));
    const raw = (exact / step) * step;
    s.amount = raw > 0n ? fromSmallestUnit(raw, from.decimals) : '';
    resetQuote();
    render();
    scheduleAuto();
  }

  /** Starts reading the price shortly after the person stops changing something, so nobody has to ask for one. */
  function scheduleAuto(): void {
    clearTimeout(autoTimer);
    autoTimer = setTimeout(() => {
      autoTimer = undefined;
      if (s.from && s.to && s.from.mint !== s.to.mint && rawAmount() !== null && accountFor(s.chain) && s.phase === 'idle' && !s.error) void getQuote();
    }, 450);
  }

  /**
   * Reads the best price and checks the transaction for it, so the Swap button is ready the moment it is wanted.
   * `silent` keeps what is on screen until the new price is ready, and drops a failure without a word: a quiet refresh
   * must never blank the screen or show an error for a price nobody asked about.
   */
  async function getQuote(silent = false): Promise<void> {
    const address = accountFor(s.chain);
    const amountIn = rawAmount();
    if (!address || !s.from || !s.to || amountIn === null || s.from.mint === s.to.mint) return;
    const mySeq = ++s.seq;
    if (!silent || !s.quote) {
      s.phase = 'quoting';
      s.error = null;
      s.prepared = null;
      s.execution = null;
      s.extraBlockers = [];
      render();
    }
    try {
      const chain = s.chain;
      if (isEvm(chain)) {
        // The wallet may have changed account since connecting; quote for the one that would sign.
        const current = await evm.refreshAccount();
        if (current !== address) throw new SwingsError('invalid', 'The connected account changed. Reconnect your wallet.');
        const balance = await readBalance(publicRead(chain), address, s.from.mint);
        if (balance < amountIn) throw new SwingsError('invalid', `You hold less ${s.from.symbol} than that on ${CHAINS[chain].name}.`);
      }
      const search = await router.findRoutes({
        chain,
        from: { chain, address: s.from.mint },
        to: { chain, address: s.to.mint },
        amountIn,
        slippageBps: s.slippageBps,
        account: { chain, address },
        ...(s.protect && chain === 'solana' && runtime.protectedSubmit ? { execution: { protect: true } } : {}),
      });
      if (mySeq !== s.seq) return;
      // Protected sending only exists on Aretia's own Solana routes. Other providers' routes would go the normal way,
      // so while it is on they are not offered at all: it must never look protected when it is not.
      const protectedOnly = s.protect && chain === 'solana' && runtime.protectedSubmit;
      const routes = protectedOnly ? search.routes.filter((r) => r.providerId === 'aretia-sol') : search.routes;
      const best = routes[0];
      if (!best) {
        if (silent && s.quote) return;
        s.failures = search.failures.map((f) => `${f.providerId}: ${f.message}`);
        s.phase = 'idle';
        s.error = protectedOnly && search.routes.length > 0 ? 'Protected sending is only available on Aretia Router routes, and none was found for this swap. Turn protected sending off to use the other routes.' : 'No route was found for this swap. Try a different amount or token.';
        return render();
      }
      s.failures = search.failures.map((f) => `${f.providerId}: ${f.message}`);
      // A quiet refresh keeps the old price and its checked transaction on screen, and swaps both for the new pair at once,
      // so a click can never meet a price whose transaction is not ready.
      if (!silent || !s.quote) {
        s.quote = best;
        s.alternatives = routes.slice(1);
        s.quotedAt = Date.now();
      }
      if (best.providerId === 'jupiter') {
        // Jupiter's own figure is unreliable for thin tokens, so the page measures it against a smaller trade.
        void fetchSizeImpact(s.from.mint, s.to.mint, best.raw as JupiterQuote)
          .then((impact) => {
            if (mySeq === s.seq) {
              s.sizeImpact = impact;
              render();
            }
          })
          .catch(() => undefined);
      } else {
        // Aretia's own router measures it itself while pricing the route.
        s.sizeImpact = best.priceImpactBps === null ? null : best.priceImpactBps / 10_000;
      }
      await prepareQuote(mySeq, best, silent, routes.slice(1));
    } catch (e) {
      if (mySeq !== s.seq) return;
      if (silent && s.quote) return;
      s.phase = 'idle';
      s.error = e instanceof SwingsError ? e.message : 'The quote could not be fetched. Try again in a moment.';
      render();
    }
  }

  /** Builds and checks the transaction for a price already read, so a click on Swap goes straight to the wallet. */
  async function prepareQuote(mySeq: number, quote: Quote, silent: boolean, alternatives: Quote[] = s.alternatives): Promise<void> {
    if (!silent) {
      s.phase = 'preparing';
      s.error = null;
      render();
    }
    try {
      const prepared = await router.buildTransaction(quote);
      if (mySeq !== s.seq) return;
      s.extraBlockers = [];
      if (isEvm(quote.request.chain) && s.from) {
        const native = await readBalance(publicRead(quote.request.chain), quote.request.account.address, EVM_NATIVE_ADDRESS);
        const problem = evmGasProblem({ nativeBalance: native, networkFee: quote.costs.network?.amount ?? null, sellsNative: s.from.mint === EVM_NATIVE_ADDRESS, amountIn: quote.inAmount, nativeSymbol: CHAINS[quote.request.chain].nativeSymbol });
        if (problem) s.extraBlockers.push(problem);
      }
      s.quote = quote;
      s.alternatives = alternatives;
      s.quotedAt = Date.now();
      s.prepared = prepared;
      s.preparedAt = Date.now();
      s.error = null;
      s.phase = 'review';
    } catch (e) {
      if (mySeq !== s.seq) return;
      if (silent && s.prepared) return;
      s.phase = 'quoted';
      s.error = e instanceof SwingsError ? e.message : 'The swap could not be prepared. Nothing was sent.';
    }
    render();
  }

  /** Prepares the route on screen again (used when another route is chosen). */
  async function review(): Promise<void> {
    if (s.quote) await prepareQuote(s.seq, s.quote, false);
  }

  /**
   * The one button: if the price and the checked transaction are fresh it goes straight to the wallet; if they are older
   * than a few seconds they are read again first, quietly, and the wallet is asked with the new price. Nobody is made to
   * ask for a new quote, and the minimum received still protects against a move in the last moments.
   */
  async function swapNow(): Promise<void> {
    if (swapBusy) return;
    swapBusy = true;
    try {
      const stale = !s.quote || !s.prepared || Date.now() - s.preparedAt > FRESH_MS || expiryLabel(s.quote).expired;
      if (stale) await getQuote(true);
      if (s.phase === 'review' && s.prepared?.simulation.ok === true && s.extraBlockers.length === 0 && !safetyNeedsAck()) await confirm();
    } finally {
      swapBusy = false;
    }
  }

  function record(execution: SwapExecution, quote: Quote): void {
    if (!s.from || !s.to) return;
    const item: HistoryItem = {
      id: execution.id,
      at: execution.startedAt,
      account: quote.request.account.address,
      chain: quote.request.chain,
      provider: quote.providerId,
      fromSymbol: s.from.symbol,
      toSymbol: s.to.symbol,
      amountIn: fromSmallestUnit(quote.inAmount, s.from.decimals),
      expectedOut: fromSmallestUnit(quote.expectedOut, s.to.decimals),
      txId: execution.txId ?? null,
      status: execution.status,
    };
    history.save(item);
    pushTrades();
  }

  async function confirm(): Promise<void> {
    if (!s.quote || !s.prepared || s.extraBlockers.length > 0) return;
    const quote = s.quote;
    s.phase = 'signing';
    s.error = null;
    render();
    try {
      let execution = await router.executeRoute(s.prepared, quote, { quoteId: quote.id, confirmed: true });
      s.execution = execution;
      if (execution.status === 'rejected') {
        s.phase = 'review';
        s.notice = 'You declined in your wallet. Nothing was sent.';
        return render();
      }
      if (execution.notSent) {
        // The wallet gave up before anything reached the network: nothing was spent, nothing is recorded, and the same swap can be tried again.
        s.execution = null;
        s.phase = 'review';
        s.error = null;
        s.notice = `${execution.error ?? 'Your wallet did not send this.'} You can try again, or send it one step at a time: your wallet then asks you to confirm each step on its own (the approval, then the 0.29% Aretia fee, then the swap), and the fee is paid before the swap.`;
        s.stepByStep = isEvm(quote.request.chain) && !!evm.adapter;
        return render();
      }
      record(execution, quote);
      if (execution.status === 'failed') {
        s.phase = 'done';
        s.error = execution.error ?? 'The swap could not be sent.';
        return render();
      }
      s.phase = 'tracking';
      render();
      execution = await router.trackExecution(execution);
      s.execution = execution;
      record(execution, quote);
      s.phase = 'done';
      // What is held has changed: read it again for the percentage buttons.
      s.balance = { key: '', raw: null };
      render();
      void host.refresh();
    } catch (e) {
      s.phase = 'review';
      s.error = e instanceof SwingsError ? e.message : 'The swap could not be sent. Check your wallet activity before trying again.';
      render();
    }
  }

  // ------------------------------------------------------------------ swap panel

  // Real token pictures: what the screen already knows, else one lookup per token, then a quiet redraw.
  const logoOf = (chain: ChainId, t: TokenInfo | null | undefined): string | null => (t ? (t.icon ?? cachedLogo(chain, t.mint)) : null);
  let logoTimer: ReturnType<typeof setTimeout> | undefined;
  function wantLogos(chain: ChainId, tokens: (TokenInfo | null | undefined)[]): void {
    const missing = tokens.filter((t): t is TokenInfo => !!t && !logoOf(chain, t)).map((t) => t.mint);
    if (missing.length === 0) return;
    void ensureLogos(chain, missing).then((gotAny) => {
      if (!gotAny) return;
      clearTimeout(logoTimer);
      logoTimer = setTimeout(() => (s.picker ? renderPicker() : render()), 150);
    });
  }

  /** Under "You pay": what is held, and 10% / 50% / Max buttons for filling the amount in one tap. */
  function shareRow(): HTMLElement {
    const row = el('div', { class: 'wapp__swap-quick' });
    if (!s.from) return row;
    loadBalance();
    const bal = currentBalance();
    row.append(el('span', { class: 'wapp__sub', text: bal === null ? 'Reading your balance…' : `Balance ${shortAmount(fromSmallestUnit(bal, s.from.decimals))} ${s.from.symbol}` }));
    const chips = el('div', { class: 'wapp__swap-shares', attrs: { role: 'group', 'aria-label': 'Fill in part of your balance' } });
    for (const share of SHARES) {
      const label = share === 100 ? 'Max' : `${share}%`;
      const b = el('button', { class: 'wapp__chip wapp__chip--btn', text: label, attrs: { type: 'button', 'aria-label': share === 100 ? 'Pay with the most you can' : `Pay with ${share} percent of your balance` } });
      b.disabled = bal === null || bal <= 0n;
      if (b.disabled) b.title = bal === null ? 'Waiting for your balance' : 'There is nothing to spend';
      else if (share === 100 && (s.from.mint === EVM_NATIVE_ADDRESS || s.from.mint === SOL_MINT)) b.title = 'The most you can spend, keeping a little back for the network fee';
      b.addEventListener('click', () => useShare(share));
      chips.append(b);
    }
    row.append(chips);
    return row;
  }

  const tokenButton = (side: 'from' | 'to'): HTMLElement => {
    const tk = s[side];
    const b = el('button', { class: 'wapp__token-btn', attrs: { type: 'button', 'data-sw-pick': side, 'aria-haspopup': 'listbox', 'aria-label': side === 'from' ? 'Choose the token you pay' : 'Choose the token you receive' } });
    b.append(tk ? avatar(tk.symbol, logoOf(s.chain, tk)) : el('span', { class: 'wapp-avatar', text: '?' }), el('span', { text: tk ? tk.symbol : 'Select token' }));
    if (tk && tk.verified === false) b.append(el('small', { class: 'wapp-flag', text: 'unverified' }));
    b.append(icon('M6 9l6 6 6-6', 14));
    b.addEventListener('click', () => {
      s.picker = s.picker?.side === side ? null : { side, query: '', results: [], loading: false };
      render();
    });
    return b;
  };

  /** The token's address under its box, so a look-alike name is never the only thing the user sees. */
  const tokenNote = (side: 'from' | 'to'): HTMLElement => {
    const tk = s[side];
    return el('span', { class: 'wapp__sub', text: tk ? (tk.mint === EVM_NATIVE_ADDRESS ? 'native coin' : short(tk.mint)) : '' });
  };

  function renderPicker(): void {
    const box = swapPanel.querySelector<HTMLElement>('[data-sw-picker]');
    if (!box) return;
    box.replaceChildren();
    const p = s.picker;
    if (!p) return;
    const input = el('input', { class: 'wapp__input', attrs: { placeholder: isEvm(s.chain) ? 'Paste a contract address or search the registry' : 'Search a name, symbol or paste a mint address', autocomplete: 'off', spellcheck: 'false', 'aria-label': 'Search tokens' } });
    input.value = p.query;
    input.addEventListener('input', () => onSearchInput(input.value));
    const list = el('div', { class: 'wapp__stack' });
    const row = (t: TokenInfo): HTMLElement => {
      const b = el('button', { class: 'wapp__asset', attrs: { type: 'button' } });
      b.append(avatar(t.symbol, logoOf(s.chain, t)), el('span', {}, [el('strong', { text: t.symbol }), el('small', { text: `${t.name ? t.name + ' · ' : ''}${t.mint === EVM_NATIVE_ADDRESS ? 'native coin' : short(t.mint)}${t.verified === false ? ' · unverified' : ''}` })]));
      b.addEventListener('click', () => void pick(p.side, t));
      return b;
    };
    const items = p.query.trim().length >= 2 ? p.results : quickTokens();
    if (p.loading) list.append(el('p', { class: 'wapp__fine', text: 'Searching…' }));
    else if (items.length === 0) list.append(el('p', { class: 'wapp__fine', text: 'No tokens found. Names and symbols are not unique: check the address before choosing.' }));
    for (const t of items.slice(0, 12)) list.append(row(t));
    wantLogos(s.chain, items.slice(0, 12));
    box.append(input, list);
    input.focus();
  }

  // ------------------------------------------------------------------ network rail (logos beside the sidebar)

  const railEl = document.querySelector<HTMLElement>('[data-rail]');

  /** Chooses a network for the whole Swings page: the swap, the chart and the token lists all follow it. */
  function selectChain(id: ChainId): void {
    if (s.chain !== id) {
      s.chain = id;
      s.from = null;
      s.to = null;
      s.picker = null;
      s.amount = '';
      resetQuote();
    }
    markets.setChain(id);
    renderRail();
    render();
  }

  function renderRail(): void {
    if (!railEl) return;
    railEl.replaceChildren();
    for (const id of CHAIN_IDS) {
      const off = runtime.loaded && !isChainEnabled(id);
      const b = el('button', { class: 'wapp__netbtn', attrs: { type: 'button', title: off ? `${CHAINS[id].name} (switched off)` : CHAINS[id].name, 'data-off': String(off), 'aria-pressed': String(s.chain === id), 'aria-label': `${CHAINS[id].name}${off ? ', switched off' : ''}` } });
      b.append(el('img', { attrs: { src: `/assets/chains/${id}.png`, alt: '', width: '36', height: '36', draggable: 'false' } }));
      b.addEventListener('click', () => selectChain(id));
      railEl.append(b);
    }
  }

  const evmResume = { tried: false };

  function evmConnect(): HTMLElement {
    const box = el('div', { class: 'wapp__stack' });
    if (evm.account) {
      box.append(el('span', { class: 'wapp__fine', text: `${evm.walletName ?? 'EVM wallet'} · ${short(evm.account)}` }));
      return box;
    }
    if (evm.locked && evm.adapter) {
      // The wallet is still connected to this page, but it locked itself, so it shares no account until it is unlocked.
      const name = evm.walletName ?? 'Your wallet';
      const unlock = el('button', { class: 'wapp__btn wapp__btn--primary', text: `Unlock ${name}`, attrs: { type: 'button' } });
      unlock.addEventListener('click', () => {
        void evm
          .unlock()
          .then(() => {
            if (evm.adapter) registerEvmWallet(router, evm.adapter);
            s.error = null;
            render();
          })
          .catch((e: unknown) => {
            s.error = e instanceof SwingsError ? e.message : `${name} could not be unlocked.`;
            render();
          });
      });
      box.append(banner('warn', `${name} is locked. This is the wallet's own lock, not Aretia's: unlock it to keep going. Aretia never sees your password.`), unlock);
      return box;
    }
    box.append(banner('info', 'Connect your wallet to swap on this network. Use a wallet for Ethereum-style networks, such as MetaMask, Coinbase Wallet or Rabby. Aretia never holds your keys.'));
    if (s.walletChoices === null) {
      const b = el('button', { class: 'wapp__btn wapp__btn--primary', text: 'Find wallets', attrs: { type: 'button' } });
      b.addEventListener('click', () => {
        void evm.discover().then((ws) => {
          s.walletChoices = ws.map((w) => ({ uuid: w.info.uuid, name: w.info.name }));
          render();
        });
      });
      box.append(b);
    } else if (s.walletChoices.length === 0 && !isProjectId(WC_PROJECT_ID)) box.append(banner('warn', 'No EVM wallet was found in this browser.'));
    else {
      if (isProjectId(WC_PROJECT_ID)) {
        const wc = el('button', { class: 'wapp__btn wapp__btn--ghost', text: 'Connect with WalletConnect (phone or hardware wallet)', attrs: { type: 'button' } });
        wc.addEventListener('click', () => {
          void connectWalletConnect(evm, WC_PROJECT_ID)
            .then(() => {
              if (evm.adapter) registerEvmWallet(router, evm.adapter);
              s.error = null;
              render();
            })
            .catch((e: unknown) => {
              s.error = e instanceof SwingsError ? e.message : 'WalletConnect could not be connected.';
              render();
            });
        });
        box.append(wc);
      }
      for (const w of s.walletChoices) {
        const b = el('button', { class: 'wapp__btn wapp__btn--ghost', text: `Connect ${w.name}`, attrs: { type: 'button' } });
        b.addEventListener('click', () => {
          void evm
            .connect(w.uuid)
            .then(() => {
              if (evm.adapter) registerEvmWallet(router, evm.adapter);
              s.error = null;
              render();
            })
            .catch((e: unknown) => {
              s.error = e instanceof SwingsError ? e.message : 'The wallet could not be connected.';
              render();
            });
        });
        box.append(b);
      }
    }
    return box;
  }

  /** Whether the token being bought needs an explicit "I understand" before the swap can go on. */
  const safetyNeedsAck = (): boolean => !!s.to && s.safety.key === `${s.chain}:${s.to.mint}` && !s.safety.loading && describeSafety(s.safety.risk).needsAcknowledgement && !s.safety.acknowledged;

  /** The plain-language safety check of the token being bought: what was found, what passed, what could not be checked. */
  function safetyBlock(): HTMLElement | null {
    if (!s.to || s.to.mint === EVM_NATIVE_ADDRESS || s.to.mint === SOL_MINT || s.safety.key !== `${s.chain}:${s.to.mint}`) return null;
    const box = el('div', { class: 'wapp__stack' });
    box.append(el('span', { class: 'wapp__eyebrow', text: `Know before you sign: ${s.to.symbol}` }));
    if (s.safety.loading) {
      box.append(el('p', { class: 'wapp__fine', text: 'Checking this token on-chain…' }));
      return box;
    }
    const v = describeSafety(s.safety.risk);
    box.append(banner(v.tone === 'ok' ? 'ok' : v.tone === 'info' ? 'info' : 'warn', v.headline));
    if (v.concerns.length > 0) {
      const list = el('ul', { class: 'wapp__fine' });
      for (const c of v.concerns) list.append(el('li', { text: `${c.severe ? 'Serious: ' : ''}${c.text}` }));
      box.append(list);
    }
    const checked = `${v.passed} check${v.passed === 1 ? '' : 's'} passed.${v.unchecked.length > 0 ? ` Could not be checked: ${v.unchecked.join(', ')}.` : ''} A token that passes these is not guaranteed safe.`;
    box.append(el('p', { class: 'wapp__fine', text: checked }));
    if (v.needsAcknowledgement) {
      const label = el('label', { class: 'wapp__fine' });
      const box2 = el('input', { attrs: { type: 'checkbox' } });
      box2.checked = s.safety.acknowledged;
      box2.addEventListener('change', () => {
        s.safety.acknowledged = box2.checked;
        updateActions();
      });
      label.append(box2, el('span', { text: ' I understand these risks and want to continue.' }));
      box.append(label);
    }
    return box;
  }

  function summaryRows(quote: Quote): HTMLElement {
    const sum = summarizeQuote(quote);
    const to = s.to!;
    const from = s.from!;
    const info = CHAINS[quote.request.chain];
    const fmt = (raw: bigint, d: number) => shortAmount(fromSmallestUnit(raw, d));
    const impactBps = s.sizeImpact === null ? null : Math.round(s.sizeImpact * 10_000);
    const mev = assessMevExposure(quote.request.slippageBps, impactBps);
    const rows: [string, string][] = [
      ['You pay', `${fmt(sum.swap.amountIn + sum.aretiaFee.amount, from.decimals)} ${from.symbol}`],
      ['You receive (expected)', `${fmt(sum.swap.expectedOut, to.decimals)} ${to.symbol}`],
      ['Minimum you will receive', `${fmt(sum.swap.minOut, to.decimals)} ${to.symbol}`],
      ['Slippage allowed', `${(quote.request.slippageBps / 100).toFixed(2)}%`],
      ['Price impact (your trade size)', impactBps === null ? 'Not available' : `${(impactBps / 100).toFixed(2)}%`],
      ['Sandwich exposure', mev.level],
      ['Route', sum.swap.route.join(' + ') || 'Not reported'],
      ['Network fee', sum.network ? `About ${fmt(sum.network.amount, info.nativeDecimals)} ${info.nativeSymbol}` : `Paid in ${info.nativeSymbol}; shown by your wallet before you sign`],
      ['DEX / provider fee', sum.provider ? 'Included' : 'Included in the quoted price'],
      ['Aretia fee', sum.aretiaFee.state === 'off' ? 'None' : sum.aretiaFee.state === 'ready' ? `${fmt(sum.aretiaFee.amount, from.decimals)} ${from.symbol} (0.29%), taken from the amount you entered` : 'Paused: the fee address is not set up for this network yet'],
      ['Priced and built by', providerLabel(quote.providerId)],
    ];
    const dl = el('dl', { class: 'wapp__rows' });
    for (const [k, v] of rows) dl.append(el('div', {}, [el('dt', { text: k }), el('dd', { text: v })]));
    return dl;
  }

  let ticker: ReturnType<typeof setInterval> | undefined;
  function expiryLabel(quote: Quote): { text: string; expired: boolean } {
    const left = Math.ceil((quote.expiresAt - Date.now()) / 1000);
    return left > 0 ? { text: `Quote valid for ${left}s`, expired: false } : { text: 'This quote has expired', expired: true };
  }

  function renderSwap(): void {
    const info = CHAINS[s.chain];
    const address = accountFor(s.chain);
    wantLogos(s.chain, [s.from, s.to]);
    // Laid out like the Trade tab: the network on top, then the swap on the left and the chart on the right.
    const card = swapCard;
    card.replaceChildren();
    // The price chart is public data, so it shows whether or not a wallet is connected or the network is enabled for
    // trading. It charts the token being bought, else the token being sold, else ACT on Solana (or the network's native
    // coin elsewhere). A native EVM coin is charted through its wrapped token.
    {
      const picked = s.to ?? s.from;
      const target = picked
        ? { address: picked.mint === EVM_NATIVE_ADDRESS ? (WRAPPED_NATIVE as Record<string, string | undefined>)[s.chain] : picked.mint, symbol: picked.symbol, icon: picked.icon ?? null }
        : s.chain === 'solana'
          ? { address: ACT_MINT, symbol: 'ACT', icon: null }
          : { address: (WRAPPED_NATIVE as Record<string, string | undefined>)[s.chain], symbol: info.nativeSymbol, icon: null };
      // Opened over the Marketplace, the token's chart is already on the page behind, so the swap window carries none.
      if (target.address && !swapDialogOpen()) {
        swapChartCard.hidden = false;
        swapChart.show(s.chain, target.address, target.symbol, target.icon);
      } else {
        swapChartCard.hidden = true;
        swapChart.hide();
      }
    }

    if (!isChainEnabled(s.chain)) {
      card.append(banner('warn', `${info.name} swaps are switched off at the moment, either by the operator or because the page could not reach its settings. Nothing on this network can be traded from this page right now. Reload to check again.`));
      return;
    }
    // A wallet already connected in the sidebar is reused here without asking again; only when it has not shared an
    // EVM account yet does the page offer the connect buttons (already listed, no extra "find wallets" click).
    if (isEvm(s.chain) && !evm.account && host.getAddress() && !evmResume.tried) {
      evmResume.tried = true;
      void evm.resume(host.getWalletName()).then(async (account) => {
        if (account && evm.adapter) registerEvmWallet(router, evm.adapter);
        else if (s.walletChoices === null) s.walletChoices = (await evm.discover()).map((w) => ({ uuid: w.info.uuid, name: w.info.name }));
        render();
      });
    }
    if (isEvm(s.chain)) card.append(evmConnect());
    if (!address) {
      if (!isEvm(s.chain)) {
        const connect = el('button', { class: 'wapp__btn wapp__btn--primary', text: 'Connect wallet', attrs: { type: 'button' } });
        connect.addEventListener('click', () => document.querySelector<HTMLButtonElement>('[data-aretia-wallet-mount] button')?.click());
        card.append(banner('info', 'Connect a Solana wallet to get a quote. Aretia never holds your keys.'), connect);
      }
      if (s.error) card.append(banner('warn', s.error));
      return;
    }

    const amount = el('input', { class: 'wapp__swap-amount', attrs: { inputmode: 'decimal', placeholder: '0.0', autocomplete: 'off', 'aria-label': 'Amount to pay' } });
    amount.value = s.amount;
    amount.addEventListener('input', () => {
      s.amount = amount.value;
      if (s.phase !== 'idle') {
        resetQuote();
        render();
      } else updateActions();
      scheduleAuto();
    });
    card.append(
      el('div', { class: 'wapp__swap-box' }, [
        el('div', { class: 'wapp__row' }, [el('span', { class: 'wapp__eyebrow', text: 'You pay' }), tokenNote('from')]),
        el('div', { class: 'wapp__swap-main' }, [tokenButton('from'), amount]),
        shareRow(),
      ]),
    );
    const flip = el('button', { class: 'wapp__swap-flip', attrs: { type: 'button', 'aria-label': 'Switch the two tokens' } }, [icon('M7 7h12l-3-3M17 17H5l3 3')]);
    flip.addEventListener('click', () => {
      const was = s.from;
      s.from = s.to;
      s.to = was;
      s.picker = null;
      s.amount = '';
      resetQuote();
      if (s.to) void loadSafety(s.chain, s.to.mint);
      else s.safety = { key: '', loading: false, risk: null, acknowledged: false };
      render();
    });
    card.append(flip);
    // The amount to receive fills in by itself as soon as a price is read.
    const reading = s.phase === 'quoting' && rawAmount() !== null;
    const estimate = s.quote && s.to && s.phase !== 'idle' && s.phase !== 'quoting' ? shortAmount(fromSmallestUnit(s.quote.expectedOut, s.to.decimals)) : reading ? '…' : '0.0';
    card.append(
      el('div', { class: 'wapp__swap-box' }, [
        el('div', { class: 'wapp__row' }, [el('span', { class: 'wapp__eyebrow', text: 'You receive' }), tokenNote('to')]),
        el('div', { class: 'wapp__swap-main' }, [tokenButton('to'), el('output', { class: 'wapp__swap-out', text: estimate })]),
      ]),
    );
    card.append(el('div', { attrs: { 'data-sw-picker': '' } }));

    // What needs a decision, or stops the swap, stays in view. Everything else is in the Details beneath.
    const ready = s.quote && s.phase !== 'idle' && s.phase !== 'quoting';
    // Aretia's check of the token being bought is always in view before the swap button: know before you sign.
    {
      const safety = safetyBlock();
      if (safety) card.append(safety);
    }
    if (ready && s.quote?.notes) for (const n of s.quote.notes) card.append(banner('info', n));
    if (ready && s.prepared) for (const b of [...s.prepared.simulation.blockers, ...s.extraBlockers]) card.append(banner('warn', b));
    // The best route failed its checks. Another one may exist, but it is only offered, never used automatically.
    if (s.phase === 'quoted' && s.error && s.quote && s.alternatives.length > 0) {
      const alt = s.alternatives[0]!;
      const worse = AretiaRouter.degradationBps(s.quote, alt);
      const offer = el('div', { class: 'wapp__result' });
      offer.append(el('p', { class: 'wapp__fine', text: `Another route (${providerLabel(alt.providerId)}) is available. It pays ${fromSmallestUnit(alt.expectedOut, s.to!.decimals)} ${s.to!.symbol}${worse > 0 ? `, ${(worse / 100).toFixed(2)}% less than the route shown above` : ''}.` }));
      const use = el('button', { class: 'wapp__btn wapp__btn--ghost', text: 'Use this route instead', attrs: { type: 'button' } });
      use.addEventListener('click', () => {
        s.quote = alt;
        s.alternatives = s.alternatives.slice(1);
        s.error = null;
        void review();
      });
      offer.append(use);
      card.append(offer);
    }

    const actions = el('div', { class: 'wapp__row-actions', attrs: { 'data-sw-actions': '' } });
    card.append(actions);
    // A failed swap is told once, below, with what to try; it is not repeated here.
    if (s.error && !(s.phase === 'done' && s.execution?.status === 'failed')) card.append(banner('warn', s.error));
    if (s.notice) card.append(banner('info', s.notice));
    if (s.phase === 'tracking') card.append(banner('info', 'Sent. Waiting for the network to confirm. Do not send it again.'));
    if (s.phase === 'done' && s.execution) {
      const ex = s.execution;
      if (ex.status === 'confirmed') card.append(banner('ok', 'Done. Confirmed on-chain.'));
      else if (ex.status === 'failed') {
        card.append(banner('warn', ex.error ?? 'The transaction failed on-chain. Your tokens were not swapped.'));
        card.append(el('p', { class: 'wapp__fine', text: 'The usual reasons: the price moved more than your slippage allows (new tokens can move several percent in seconds), or the token keeps a fee on every trade. Open Details, choose a higher slippage such as 3%, and try again.' }));
      } else card.append(banner('info', 'Still waiting for confirmation. Check the transaction before trying again; the swap may still land.'));
      if (ex.txId) card.append(el('a', { text: 'View transaction', attrs: { href: EXPLORER_TX[ex.chain] + encodeURIComponent(ex.txId), target: '_blank', rel: 'noopener noreferrer' } }));
    }

    // The details: settings and the full account of the route, closed unless the person opens them.
    const more = el('details', { class: 'wapp__more wapp__swap-more' }, [el('summary', { text: 'Details' })]);
    more.open = detailsOpen;
    more.addEventListener('toggle', () => {
      detailsOpen = more.open;
    });
    more.append(banner('info', `Same-chain swap on ${info.name}. Cross-chain swaps are not available yet.`));
    const slip = el('div', { class: 'wapp__slip', attrs: { role: 'group', 'aria-label': 'Slippage' } });
    slip.append(el('span', { class: 'wapp__eyebrow', text: 'Slippage' }));
    for (const bps of SLIPPAGE_PRESETS_BPS) {
      const b = el('button', { class: 'wapp__chip wapp__chip--btn', text: `${bps / 100}%`, attrs: { type: 'button', 'aria-pressed': String(s.slippageBps === bps) } });
      b.addEventListener('click', () => {
        s.slippageBps = bps;
        s.slippageTouched = true;
        resetQuote();
        render();
        scheduleAuto();
      });
      slip.append(b);
    }
    more.append(slip);
    if (s.chain === 'solana' && runtime.protectedSubmit) {
      const label = el('label', { class: 'wapp__fine' });
      const box = el('input', { attrs: { type: 'checkbox' } });
      box.checked = s.protect;
      box.addEventListener('change', () => {
        s.protect = box.checked;
        resetQuote();
        render();
        scheduleAuto();
      });
      label.append(box, el('span', { text: ' Protected sending (Jito): sent privately, with a tip of about 0.00001 SOL, to lower the chance of being sandwiched. Not a guarantee.' }));
      more.append(label);
    }
    for (const f of s.failures) more.append(el('p', { class: 'wapp__fine', text: `A provider did not answer (${f}).${s.quote ? ' Other routes were used.' : ''}` }));
    if (ready && s.quote) {
      const q = s.quote;
      more.append(el('span', { class: 'wapp__eyebrow', text: 'The route' }));
      more.append(summaryRows(q));
      if (s.alternatives.length > 0) {
        const others = el('details', { class: 'wapp__more' }, [el('summary', { text: `${s.alternatives.length} other route${s.alternatives.length === 1 ? '' : 's'}` })]);
        for (const alt of s.alternatives) others.append(el('p', { class: 'wapp__fine', text: `${providerLabel(alt.providerId)}: ${fromSmallestUnit(alt.expectedOut, s.to!.decimals)} ${s.to!.symbol}` }));
        more.append(others);
      }
      const mev = assessMevExposure(q.request.slippageBps, s.sizeImpact === null ? null : Math.round(s.sizeImpact * 10_000));
      if (mev.level !== 'low') more.append(banner('warn', mev.note));
      if (s.prepared) for (const w of s.prepared.simulation.warnings) more.append(banner('info', w));
      for (const n of summarizeQuote(q).notes) if (!n.startsWith('No Aretia fee')) more.append(el('p', { class: 'wapp__fine', text: n }));
    }
    card.append(more);
    renderPicker();
    updateActions();
  }

  function updateActions(): void {
    const actions = swapPanel.querySelector<HTMLElement>('[data-sw-actions]');
    if (!actions) return;
    actions.replaceChildren();
    const amountIn = rawAmount();
    const btn = (label: string, handler: () => void, disabled = false): HTMLButtonElement => {
      const b = el('button', { class: 'wapp__btn wapp__btn--primary wapp__swap-go', text: label, attrs: { type: 'button' } });
      b.disabled = disabled;
      b.addEventListener('click', handler);
      return b;
    };
    const problem = s.from && s.to && s.from.mint === s.to.mint ? 'Choose two different tokens.' : amountIn !== null ? balanceProblem(amountIn) : null;
    if (s.phase === 'done') {
      actions.append(
        btn('New swap', () => {
          resetQuote();
          s.amount = '';
          render();
        }),
      );
      return;
    }
    if (s.phase === 'signing') return void actions.append(btn('Confirm in your wallet…', () => undefined, true));
    if (s.phase === 'tracking') return void actions.append(btn('Waiting for the network…', () => undefined, true));
    if (s.phase === 'quoted' && s.error) return void actions.append(btn('Try again', () => void getQuote()));
    if (s.phase === 'idle' && s.error && amountIn !== null && s.from && s.to) return void actions.append(btn('Try again', () => void getQuote()));
    if (s.phase === 'idle' || s.phase === 'quoting' || s.phase === 'preparing') {
      const label = !s.from || !s.to ? 'Choose the tokens' : amountIn === null ? (s.amount.trim() ? 'Enter a valid amount' : 'Enter an amount') : problem ? problem : 'Getting the best price…';
      actions.append(btn(label, () => undefined, true));
      return;
    }
    // A price is on screen and its transaction has been checked: one button.
    const ok = s.prepared?.simulation.ok === true && s.extraBlockers.length === 0 && !safetyNeedsAck();
    actions.append(btn(safetyNeedsAck() ? 'Tick the box above to continue' : 'Swap', () => void swapNow(), !ok));
    if (s.stepByStep && ok) {
      const steps = el('button', { class: 'wapp__btn wapp__btn--ghost', text: 'Send it one step at a time', attrs: { type: 'button' } });
      steps.addEventListener('click', () => {
        if (evm.adapter) evm.adapter.allowBatch = false;
        s.stepByStep = false;
        s.notice = null;
        void swapNow();
      });
      actions.append(steps);
    }
  }

  /** Keeps the cursor in the amount box when the screen is redrawn around it (a quiet price refresh, a result arriving). */
  function render(): void {
    const active = document.activeElement;
    const inAmount = active instanceof HTMLInputElement && active.classList.contains('wapp__swap-amount');
    const caret = inAmount ? active.selectionStart : null;
    renderSwap();
    if (inAmount) {
      const again = swapPanel.querySelector<HTMLInputElement>('.wapp__swap-amount');
      if (again) {
        again.focus();
        if (caret !== null) again.setSelectionRange(caret, caret);
      }
    }
    // Whenever everything needed for a price is in place and none has been asked for, ask: the amount to receive fills in by
    // itself after any change (a token, a percentage, the wallet connecting), with nothing to press.
    if (s.phase === 'idle' && !s.error && s.from && s.to && s.from.mint !== s.to.mint && rawAmount() !== null && accountFor(s.chain) && autoTimer === undefined) scheduleAuto();
    clearInterval(ticker);
    // While a checked price is on screen it is read again every few seconds, so it is always current when Swap is pressed.
    if (s.quote && s.phase === 'review') {
      ticker = setInterval(() => {
        if (s.phase !== 'review' || swapBusy || document.hidden) return;
        if (Date.now() - s.quotedAt > REFRESH_MS) void getQuote(true);
      }, 1000);
    }
  }

  // ------------------------------------------------------------------ token lists (New Tokens, Markets)

  const market = new GeckoMarket();
  const PAGE_SIZE = 50;
  const GECKO_PAGES = 10;

  /** The lists come from Aretia's server, which fetches them once for everyone; if that is unreachable the page asks the source itself. */
  async function loadList(q: { kind: MarketKind; chain: '' | ChainId; window: MarketWindow; page: number }): Promise<MarketRow[]> {
    try {
      const res = await fetch(`/api/swings-market?kind=${q.kind}&chain=${q.chain}&window=${q.window}&page=${q.page}`);
      if (res.ok) {
        const body = (await res.json()) as { rows?: MarketRow[] };
        if (Array.isArray(body.rows)) return body.rows;
      }
    } catch {
      // fall through to the direct request
    }
    return market.load(q);
  }

  function tokenBrowser(target: HTMLElement) {
    // One list for everything trading: what is busy now, plus the tokens Aretia itself has just detected. Every row carries
    // Aretia's rating and the burned-liquidity padlock where Aretia has checked the token.
    type Kind = MarketKind | 'new' | 'favourites';
    const m = { kind: 'trending' as Kind, window: 'h24' as MarketWindow, chain: '' as '' | ChainId };
    const f = { age: '0', liquidity: '0', risk: '', hideRisky: true };
    let rows: MarketRow[] | null = null;
    const records = new Map<string, TokenRecord>();
    // Aretia's own new-token list opens with the busiest first; the other lists keep their ranking until a column is chosen.
    const startSort = (): TableState => (m.kind === 'new' ? { key: 'volume', dir: 'desc' } : { key: null, dir: 'desc' });
    let tsort: TableState = startSort();
    let pageNo = 1;
    let error: string | null = null;
    let loading = false;
    let page = false;
    const tokenPage = createTokenPage();
    let seq = 0;
    const rowKey = (chain: ChainId, address: string): string => `${chain}:${chain === 'solana' ? address : address.toLowerCase()}`;
    let tableEl: HTMLElement | null = null;
    /** True while the sidebar's Favourites page is showing this list. */
    let favPage = false;
    alertsChanged = () => {
      if (m.kind === 'favourites' && !page) draw();
    };

    /** Aretia's on-chain check of one row's token, shared with the list, the side panel and the swap screen through one memory. */
    async function assessRow(row: MarketRow): Promise<TokenRisk | null> {
      const known = riskMemory.get(row.chain, row.address);
      if (known) return known.risk;
      const risk = await assessTokenSafety(row.chain, row.address, marketFactsOf(row));
      riskMemory.set(row.chain, row.address, risk);
      return risk;
    }

    // Every row shows a rating at once (its market reading) and gets the full on-chain one as each check finishes.
    const ratings = createRatingQueue({
      assess: assessRow,
      onChange: () => {
        const current = rows ?? [];
        const changed = ratings.sync(current);
        if (page) return;
        // With a risk filter on, a changed rating can change which rows belong in the list.
        if ((f.hideRisky || f.risk) && changed.length > 0) return draw();
        if (tableEl) updateRatingCells(tableEl, current, ratings.stateOf);
      },
    });

    // "Full chart" opens the chart in the centre, above the list, on a wide screen. It lives in its own element that a redraw of
    // the list leaves alone, because taking an embedded chart out of the page and putting it back reloads it.
    const chartHost = el('section', { class: 'wapp-mt__chart', attrs: { 'aria-label': 'Price chart' } });
    chartHost.hidden = true;
    let chartKey = '';
    let chartRow: MarketRow | null = null;
    function showChart(r: MarketRow): void {
      chartRow = r;
      chartHost.hidden = false;
      const key = `${r.chain}:${r.pool}`;
      if (chartKey !== key) {
        chartKey = key;
        const title = el('strong', { class: 'wapp-mt__chart-title', text: `${r.symbol}${r.quoteSymbol ? ` / ${r.quoteSymbol}` : ''} · ${CHAINS[r.chain].name}` });
        const close = el('button', { class: 'wapp__btn wapp__btn--ghost wapp-mt__chart-close', text: 'Close chart', attrs: { type: 'button' } });
        close.addEventListener('click', hideChart);
        const frame = el('iframe', { class: 'wapp-mt__chart-frame', attrs: { title: `${r.symbol} price chart`, referrerpolicy: 'no-referrer', sandbox: 'allow-scripts allow-same-origin allow-popups' } });
        frame.src = dexScreenerEmbedUrl(r.chain, r.pool, '15', { toolbar: true });
        chartHost.replaceChildren(el('div', { class: 'wapp-mt__chart-head' }, [title, close]), frame, el('p', { class: 'wapp__fine', text: 'Past prices say nothing certain about future ones.' }));
      }
      if (chartHost.parentElement !== target) target.prepend(chartHost);
      chartHost.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    }
    function hideChart(): void {
      chartRow = null;
      chartKey = '';
      chartHost.hidden = true;
      chartHost.replaceChildren();
    }

    // Which pools have their liquidity locked (burned), worked out in the page for the rows on screen. A padlock appears as each is proven.
    const locks = createLockQueue({
      check: async (row) => {
        const lock = await checkLock(row.chain, row.pool, { ...(CHAINS[row.chain].kind === 'evm' ? { evm: publicRead(row.chain) } : { sol: rpcCall }) }, Date.now());
        if (!lock || lock.pct < LOCK_MIN_PCT) return null;
        return lock.kind === 'time-locked' ? { pct: lock.pct, kind: 'time-locked' as const, until: lock.until, by: lock.by } : { pct: lock.pct, kind: 'burned' as const, until: null };
      },
      onChange: () => {
        const current = rows ?? [];
        const marked = locks.sync(current);
        if (marked.length === 0 || page) return;
        if (tableEl) updateLiquidityCells(tableEl, marked);
        // The panel shows the same padlock for the token it is describing.
        const sel = panel.selectedKey();
        const selected = sel === null ? null : current.find((r) => tableRowKey(r) === sel);
        if (selected && marked.includes(selected)) panel.show(selected);
      },
    });
    /** Every list goes through both: a rating for each row, and a padlock where the liquidity is shown to be locked. */
    const rateRows = (list: readonly MarketRow[]): MarketRow[] => locks.rate(ratings.rate(list));

    const panel = createMarketPanel({
      assess: assessRow,
      isFavourite: (r) => favourites.has(r.chain, r.address),
      toggleFavourite: (r) => toggleFavourite(r),
      // Beside the docked panel the chart opens in place; on a narrow screen it still opens the full token page.
      openChart: (r) => (panelShown() ? showChart(r) : openRow(r)),
      swapFor: (r) => swapHandler(r),
    });
    // The panel is a bar docked to the right edge of the wallet on a wide screen, and hidden on a narrow one, where a row opens the full token page instead.
    (document.querySelector<HTMLElement>('[data-wapp]') ?? target).append(panel.element);
    const panelShown = (): boolean => panel.element.isConnected && panel.element.offsetParent !== null;
    function pick(r: MarketRow): void {
      if (!panelShown()) return openRow(r);
      panel.show(r);
      if (tableEl) markSelected(tableEl, tableRowKey(r));
      // With the chart open, it follows the token that was picked.
      if (chartRow) showChart(r);
    }

    async function load(silent = false): Promise<void> {
      const mine = ++seq;
      if (!silent) {
        loading = true;
        error = null;
        draw();
      }
      try {
        if (m.kind === 'new') {
          const q = new URLSearchParams();
          if (m.chain) q.set('chain', m.chain);
          if (f.age !== '0') q.set('maxAgeHours', f.age);
          if (f.liquidity !== '0') q.set('minLiquidityUsd', f.liquidity);
          if (f.risk) q.set('risk', f.risk);
          // Asking for high-risk tokens on purpose overrides the hide switch.
          if (f.hideRisky && f.risk !== 'high' && f.risk !== 'restricted') q.set('hideRisky', '1');
          q.set('sort', 'newest');
          q.set('limit', '500');
          const res = await fetch(`/api/swings-tokens?${q}`);
          const body = (await res.json().catch(() => null)) as { tokens?: TokenRecord[]; message?: string } | null;
          if (mine !== seq) return;
          if (!res.ok) throw new Error(body?.message ?? 'Token discovery is unavailable right now.');
          // An answer that is not our JSON shape (an error page, a missing endpoint) must not read as "no tokens".
          if (!body || !Array.isArray(body.tokens)) throw new Error('Token discovery is unavailable right now.');
          const recs = body.tokens;
          const filled = await rowsFromRecords(recs);
          if (mine !== seq) return;
          records.clear();
          for (const r of recs) records.set(rowKey(r.ref.chain, r.ref.address), r);
          rows = rateRows(filled);
        } else if (m.kind === 'favourites') {
          const favs = favourites.list().filter((f) => !m.chain || f.chain === m.chain);
          const got = await rowsFromFavourites(favs);
          if (mine !== seq) return;
          const rated = applyRatings(got, await fetchRatings(got));
          if (mine !== seq) return;
          rows = rateRows(rated);
        } else {
          const got = await loadList({ kind: m.kind, chain: m.chain, window: m.window, page: pageNo });
          if (mine !== seq) return;
          const rated = applyRatings(got, await fetchRatings(got));
          if (mine !== seq) return;
          rows = rateRows(rated);
        }
        error = null;
      } catch (e) {
        if (mine !== seq) return;
        // A background refresh that fails keeps the table already on screen.
        if (!silent || rows === null) error = e instanceof Error ? e.message : 'The list is unavailable right now.';
      }
      loading = false;
      // A refresh never redraws over an open token page: moving its chart frame would reload the chart.
      if (silent && page) return;
      draw();
    }

    /** The rows that pass the filters. Rows Aretia has not rated count as "not enough data", so they are never hidden as risky. */
    function visible(): MarketRow[] {
      return (rows ?? []).filter((r) => {
        if (f.liquidity !== '0' && (r.liquidityUsd ?? 0) < Number(f.liquidity)) return false;
        if (f.age !== '0' && (r.ageMs === null || r.ageMs > Number(f.age) * 3_600_000)) return false;
        const st = r.risk?.status ?? 'unknown';
        if (f.hideRisky && f.risk !== 'high' && f.risk !== 'restricted' && (st === 'high' || st === 'restricted')) return false;
        if (f.risk && st !== f.risk) return false;
        return true;
      });
    }

    function select(label: string, value: string, options: [string, string][], onChange: (v: string) => void): HTMLElement {
      const sel = el('select', { class: 'wapp__input', attrs: { 'aria-label': label } });
      for (const [v, text] of options) sel.append(el('option', { text, attrs: { value: v } }));
      sel.value = value;
      sel.addEventListener('change', () => onChange(sel.value));
      return sel;
    }

    function chip(label: string, pressed: boolean, onClick: () => void, title?: string): HTMLElement {
      const b = el('button', { class: 'wapp__chip wapp__chip--btn', text: label, attrs: { type: 'button', 'aria-pressed': String(pressed), ...(title ? { title } : {}) } });
      b.addEventListener('click', onClick);
      return b;
    }

    /** The star on a row: kept on this device at once, and saved to the wallet too when the person is signed in. */
    function toggleFavourite(r: MarketRow): void {
      const fav = { chain: r.chain, address: r.address, symbol: r.symbol, name: r.name, icon: r.icon };
      const on = favourites.toggle(fav);
      if (on) {
        alerts.startWatching(r.chain, r.address, r.priceUsd);
        toaster.show({ title: `${r.symbol} added to Favourites`, detail: `${formatPrice(r.priceUsd)} · 24H ${formatChange(r.change.h24)} · alerts at ±${alerts.pct()}%`, tone: 'info', icon: r.icon });
      } else alerts.stopWatching(r.chain, r.address);
      const session = sessionNow();
      if (session) void account.setFavourite(session, fav, on).catch(() => undefined);
      // Un-starring inside the Favourites list takes the row away.
      if (!on && m.kind === 'favourites') void load(true);
    }

    /** What "swap into this token" does for a row, or null when swaps on its network are switched off. */
    function swapHandler(r: MarketRow): (() => void) | null {
      const rec = records.get(rowKey(r.chain, r.address));
      return isChainEnabled(r.chain)
        ? () => window.dispatchEvent(new CustomEvent(OPEN_TOKEN_EVENT, { detail: { chain: r.chain, address: r.address, symbol: r.symbol, name: r.name, icon: r.icon ?? rec?.logo ?? null, decimals: r.decimals ?? rec?.decimals ?? null, liquidityUsd: r.liquidityUsd, priceUsd: r.priceUsd, fresh: false, risk: null } satisfies SearchHit }))
        : null;
    }

    /** A row was clicked: the token page opens in place of the list, with a way back. */
    function openRow(r: MarketRow): void {
      const rec = records.get(rowKey(r.chain, r.address));
      const riskNote = r.risk
        ? r.risk.score === null
          ? 'Aretia: not enough data to rate this token. That is not a good sign or a bad one.'
          : `Aretia rating: ${r.risk.label} (${ratingView(r, 'done').band}). Behind the colour is a concern score of ${r.risk.score}/100; higher means more concerns.`
        : 'Aretia has not rated this token yet. That is not a good sign or a bad one.';
      page = true;
      draw();
      target.scrollIntoView({ block: 'start' });
      void tokenPage.open({
        chain: r.chain,
        address: r.address,
        symbol: r.symbol,
        name: r.name,
        icon: r.icon ?? rec?.logo ?? null,
        riskNote,
        onSwap: swapHandler(r),
        onBack: () => {
          tokenPage.close();
          page = false;
          draw();
        },
      });
    }

    /** A filter that changes which tokens Aretia's own list asks for goes back to the server; the others are applied here. */
    const refilter = (): void => {
      pageNo = 1;
      if (m.kind === 'new') void load();
      else draw();
    };

    function draw(): void {
      // The docked panel steps aside while a full token page is open.
      panel.element.hidden = page;
      if (page) {
        // Taking a chart frame out of the page and putting it back reloads it, so an open token page is left exactly as it is.
        if (target.firstElementChild !== tokenPage.element || target.childElementCount !== 1) target.replaceChildren(tokenPage.element);
        return;
      }
      for (const child of [...target.children]) if (child !== chartHost) child.remove();
      if (chartRow && chartHost.parentElement !== target) target.prepend(chartHost);
      const card = el('div', { class: 'wapp__card wapp-mt__card' });
      card.append(el('h2', { class: 'wapp__h2 sr-only', text: 'Marketplace' }));
      const bar = el('div', { class: 'wapp-mt__bar' });
      // A swap can be started from here without picking a token first; the Swap page itself has no sidebar entry.
      const swapButton = el('button', { class: 'wapp__btn wapp__btn--primary', text: 'Swap', attrs: { type: 'button', 'data-markets-swap': '' } });
      swapButton.addEventListener('click', openSwapDialog);
      bar.append(swapButton);
      const kinds: [Kind, string, string][] = [['favourites', '★ Favourites', 'Tokens you have starred'], ['trending', 'Trending', 'Busiest right now'], ['top', 'Top', 'Most traded in 24 hours'], ['gainers', 'Gainers', 'Biggest price rises'], ['new', 'New', 'Tokens Aretia has just detected, with a trading pool']];
      const kindBox = el('div', { class: 'wapp__seg', attrs: { role: 'group', 'aria-label': 'List' } });
      for (const [k, label, tip] of kinds) {
        kindBox.append(chip(label, m.kind === k, () => {
          m.kind = k;
          tsort = startSort();
          pageNo = 1;
          rows = null;
          void load();
        }, tip));
      }
      bar.append(kindBox);
      if (m.kind === 'trending' || m.kind === 'gainers') {
        const win = el('div', { class: 'wapp__seg', attrs: { role: 'group', 'aria-label': 'Time window' } });
        for (const [w, label] of [['m5', '5M'], ['h1', '1H'], ['h6', '6H'], ['h24', '24H']] as [MarketWindow, string][]) {
          win.append(chip(label, m.window === w, () => {
            m.window = w;
            pageNo = 1;
            void load();
          }));
        }
        bar.append(win);
      }
      bar.append(
        select('Network', m.chain, [['', 'All networks'], ...CHAIN_IDS.map((c): [string, string] => [c, CHAINS[c].name])], (v) => {
          m.chain = v as typeof m.chain;
          pageNo = 1;
          void load();
        }),
        select('Age', f.age, [['1', 'Last hour'], ['6', 'Last 6 hours'], ['24', 'Last 24 hours'], ['168', 'Last 7 days'], ['0', 'Any age']], (v) => { f.age = v; refilter(); }),
        select('Minimum liquidity', f.liquidity, [['0', 'Any liquidity'], ['10000', '$10K+'], ['100000', '$100K+'], ['1000000', '$1M+']], (v) => { f.liquidity = v; refilter(); }),
        select('Risk', f.risk, [['', 'Any risk'], ['established', 'Established'], ['new', 'New'], ['unverified', 'Unverified'], ['elevated', 'Elevated risk'], ['high', 'High risk'], ['restricted', 'Restricted'], ['unknown', 'Couldn\'t check']], (v) => { f.risk = v; refilter(); }),
      );
      if (m.kind === 'favourites') {
        bar.append(select('Price alerts', String(alerts.pct()), PCT_CHOICES.map((p): [string, string] => [String(p), `Alert at ±${p}%`]), (v) => {
          alerts.setPct(Number(v));
          draw();
        }));
      }
      const hide = el('input', { attrs: { type: 'checkbox', id: 'hide-risky-mk' } });
      hide.checked = f.hideRisky;
      hide.addEventListener('change', () => {
        f.hideRisky = hide.checked;
        refilter();
      });
      bar.append(el('label', { class: 'wapp-mt__check wapp__fine', attrs: { for: 'hide-risky-mk' } }, [hide, el('span', { text: 'Hide risky tokens' })]));
      bar.append(ratingKey());
      card.append(bar);
      const shownRows = visible();
      /** On a wide screen the list, its pager and its notes scroll inside this region while the side panel stays put. */
      let inMain: HTMLElement | null = null;
      if (error) card.append(banner('warn', error));
      else if (rows === null || (loading && rows === null)) card.append(el('p', { class: 'wapp__fine', text: 'Loading…' }));
      else if (m.kind === 'favourites' && favourites.list().length === 0) card.append(el('p', { class: 'wapp__fine', text: 'No favourites yet. Tap the ☆ beside any token to keep it here.' }));
      else if (shownRows.length === 0) card.append(el('p', { class: 'wapp__fine', text: f.hideRisky ? 'Nothing matches. Risky tokens are hidden: untick the box above to see them, or widen the filters.' : 'Nothing matches these filters right now.' }));
      else {
        // Aretia's own list holds everything it fetched and pages through it after sorting; the other lists ask for one page at a time.
        const shown = m.kind === 'new' ? (tsort.key ? sortRows(shownRows, tsort.key, tsort.dir) : shownRows).slice((pageNo - 1) * PAGE_SIZE, pageNo * PAGE_SIZE) : shownRows;
        tableEl = marketTable({ rows: shown, sort: tsort, showRisk: true, selectedKey: panel.selectedKey(), ratingState: ratings.stateOf, favourites: { has: (r) => favourites.has(r.chain, r.address), toggle: toggleFavourite }, onSort: (key) => { tsort = tsort.key === key ? { key, dir: tsort.dir === 'desc' ? 'asc' : 'desc' } : { key, dir: 'desc' }; if (m.kind === 'new') pageNo = 1; draw(); }, onOpen: pick });
        const main = el('div', { class: 'wapp-mt__main' }, [tableEl]);
        inMain = main;
        card.append(main);
        const pages = m.kind === 'new' ? Math.max(1, Math.ceil(shownRows.length / PAGE_SIZE)) : m.kind === 'favourites' ? 1 : GECKO_PAGES;
        main.append(pager(pages));
        // Tokens with no picture get one looked up, then the table redraws once.
        const byChain = new Map<ChainId, string[]>();
        for (const r of shownRows) if (!r.icon && !cachedLogo(r.chain, r.address)) byChain.set(r.chain, [...(byChain.get(r.chain) ?? []), r.address]);
        if (byChain.size > 0) void Promise.all([...byChain].map(([c, a]) => ensureLogos(c, a))).then((r) => { if (r.some(Boolean)) draw(); });
        main.append(sponsorBlock('market-footer', { seed: `${m.kind}:${m.chain}` }));
      }
      if (m.kind === 'favourites') (inMain ?? card).append(favouriteAlerts());
      target.append(card);
      // On a wide screen the panel opens on the selected row, or the first one when nothing is selected yet.
      if (tableEl && panelShown() && !page) {
        const shownNow = visible();
        const ordered = tsort.key ? sortRows(shownNow, tsort.key, tsort.dir) : shownNow;
        const cur = ordered.find((r) => tableRowKey(r) === panel.selectedKey()) ?? ordered[0];
        if (cur) {
          panel.show(cur);
          markSelected(tableEl, tableRowKey(cur));
        }
      }
    }

    /** What the alerts do, and the recent ones, so a pop-up that has gone is never lost. */
    function favouriteAlerts(): HTMLElement {
      const box = el('div', { class: 'wapp-alerts' });
      box.append(el('p', { class: 'wapp__fine', text: `Price alerts pop up for two seconds while this page is open, when a favourite has moved ±${alerts.pct()}% from where it was when you starred it or last alerted. Nothing watches prices once the page is closed.` }));
      const log = alerts.log();
      if (log.length > 0) {
        box.append(el('span', { class: 'wapp__eyebrow', text: 'Recent alerts' }));
        const list = el('ul', { class: 'wapp-alerts__list' });
        for (const a of log.slice(0, 8)) {
          const up = a.movePct > 0;
          list.append(el('li', { class: up ? 'is-up' : 'is-down', text: `${a.symbol} ${up ? '▲ +' : '▼ '}${a.movePct.toFixed(1)}% to ${formatPrice(a.price)} · ${formatAge(Date.now() - a.at)} ago` }));
        }
        box.append(list);
      }
      return box;
    }

    /** Previous and next arrows with a page number box. */
    function pager(pages: number): HTMLElement {
      const go = (n: number): void => {
        pageNo = Math.min(Math.max(n, 1), pages);
        if (m.kind === 'new') draw();
        else void load();
        target.scrollIntoView({ block: 'start' });
      };
      const arrow = (label: string, aria: string, to: number, disabled: boolean): HTMLButtonElement => {
        const b = el('button', { class: 'wapp__chip wapp__chip--btn', text: label, attrs: { type: 'button', 'aria-label': aria } });
        b.disabled = disabled;
        b.addEventListener('click', () => go(to));
        return b;
      };
      const input = el('input', { class: 'wapp__input wapp-mt__pageno', attrs: { inputmode: 'numeric', 'aria-label': 'Page number', value: String(pageNo) } });
      input.value = String(pageNo);
      input.addEventListener('change', () => go(Number(input.value) || 1));
      return el('div', { class: 'wapp-mt__pager', attrs: { role: 'navigation', 'aria-label': 'Pages' } }, [
        arrow('←', 'Previous page', pageNo - 1, pageNo <= 1 || loading),
        el('span', { class: 'wapp__fine', text: 'Page' }),
        input,
        el('span', { class: 'wapp__fine', text: `of ${pages}` }),
        arrow('→', 'Next page', pageNo + 1, pageNo >= pages || loading),
      ]);
    }

    // The list refreshes by itself once a minute while it is on screen and no token page is open.
    setInterval(() => {
      if (!target.hidden && !document.hidden && rows !== null && !loading && !page) void load(true);
    }, 60_000);

    return {
      draw,
      ensureLoaded(): void {
        if (rows === null && !loading) void load();
      },
      /** The sidebar's Favourites page shows this list as its favourites; leaving it puts the list back to what is trending. */
      setFavouritesPage(on: boolean): void {
        if (on) {
          favPage = true;
          if (m.kind !== 'favourites') {
            m.kind = 'favourites';
            tsort = startSort();
            pageNo = 1;
            rows = null;
            void load();
          } else void load(true);
        } else if (favPage) {
          favPage = false;
          if (m.kind === 'favourites') {
            m.kind = 'trending';
            tsort = startSort();
            pageNo = 1;
            rows = null;
            void load();
          }
        }
      },
      /** The network logo the user clicked becomes this list's network filter (they can still choose All networks). */
      setChain(id: ChainId): void {
        if (m.chain === id) return;
        m.chain = id;
        pageNo = 1;
        if (rows !== null || loading) void load();
        else draw();
      },
    };
  }

  const markets = tokenBrowser(panel('markets'));

  // ------------------------------------------------------------------ Activity

  function renderActivity(): void {
    activityPanel.replaceChildren();
    const card = activityPanel;
    card.append(el('h2', { class: 'wapp__h2', text: 'Your swaps and moves' }));
    card.append(accountBar());
    card.append(el('p', { class: 'wapp__fine', text: 'Swaps and USDC transfers made through Aretia Swings in this browser. This list is stored only on this device and is not sent to Aretia.' }));
    void chainRuntime.orchestrator.active().then((moves) => {
      if (moves.length === 0) return;
      const box = el('div', { class: 'wapp__stack' }, [el('span', { class: 'wapp__eyebrow', text: 'USDC transfers in progress' })]);
      for (const m of moves) {
        const v = viewStatus(m, false);
        const go = el('button', { class: 'wapp__btn wapp__btn--ghost', text: 'Open', attrs: { type: 'button' } });
        go.addEventListener('click', () => {
          location.hash = '#/send';
          showPayTab('transfer');
        });
        box.append(el('div', { class: 'wapp__provider' }, [el('div', {}, [el('strong', { text: `${CHAINS[m.quote.intent.sourceChain].name} to ${CHAINS[m.quote.intent.destinationChain].name}` }), el('span', { text: `${v.title}. ${v.detail}` })]), go]));
      }
      card.insertBefore(box, card.children[2] ?? null);
    });
    const items = [...history.list(host.getAddress()), ...history.list(evm.account)].sort((a, b) => b.at - a.at);
    if (items.length === 0) card.append(el('p', { class: 'wapp__fine', text: host.getAddress() || evm.account ? 'No swaps yet.' : 'Connect a wallet to see its swaps.' }));
    for (const i of items) {
      const row = el('div', { class: 'wapp__provider' });
      row.append(el('div', {}, [el('strong', { text: `${i.amountIn} ${i.fromSymbol} → ${i.toSymbol}` }), el('span', { text: `${CHAINS[i.chain].name} · ${i.provider} · ${new Date(i.at).toLocaleString()} · expected ${i.expectedOut} ${i.toSymbol}` })]));
      const right = el('div', { class: 'wapp__row-actions' });
      right.append(el('span', { class: `wapp__state wapp__state--${i.status === 'confirmed' ? 'on' : i.status === 'failed' ? 'warn' : 'off'}`, text: i.status }));
      if (i.txId) right.append(el('a', { text: 'View', attrs: { href: EXPLORER_TX[i.chain] + encodeURIComponent(i.txId), target: '_blank', rel: 'noopener noreferrer' } }));
      if (i.txId && i.status === 'submitted') {
        const check = el('button', { class: 'wapp__btn wapp__btn--ghost', text: 'Check status', attrs: { type: 'button' } });
        check.addEventListener('click', () => {
          const ex: SwapExecution = { id: i.id, quoteId: i.id, chain: i.chain, status: 'submitted', txId: i.txId!, startedAt: i.at, updatedAt: Date.now() };
          void router.trackExecution(ex, { timeoutMs: 4_000, intervalMs: 1_000 }).then((res) => {
            history.setStatus(i.id, res.status);
            pushTrades();
            renderActivity();
          });
        });
        right.append(check);
      }
      row.append(right);
      card.append(row);
    }

  }

  // ------------------------------------------------------------------ tabs

  const TAB_INTRO: Record<string, string> = {
    swap: '',
    markets: '',
  };
  const PAY_INTRO: Record<string, string> = {
    send: '',
    ramp: 'Turn USDC into cash, or buy USDC with a bank card or transfer, through a licensed provider. Aretia never touches your money.',
    transfer: 'Send USDC from one network to another, or buy USDC with cash and have it end up where you want it. Your wallet approves each step.',
  };

  type TransferMode = 'move' | 'plan';
  let transferMode: TransferMode = 'move';
  function showTransferMode(mode: TransferMode): void {
    transferMode = mode;
    document.querySelectorAll<HTMLElement>('[data-transfer-mode]').forEach((b) => b.setAttribute('aria-selected', String(b.dataset.transferMode === mode)));
    document.querySelectorAll<HTMLElement>('[data-transfer-pane]').forEach((p) => (p.hidden = p.dataset.transferPane !== mode));
    if (mode === 'move') crossChain.draw();
    else planTab.draw();
  }
  document.querySelectorAll<HTMLElement>('[data-transfer-mode]').forEach((b) => b.addEventListener('click', () => showTransferMode(b.dataset.transferMode === 'plan' ? 'plan' : 'move')));

  // Pay: Send, Cash out or top up, and Move USDC are one page with three cards.
  let payTab = 'send';
  function showPayTab(name: string): void {
    payTab = name;
    document.querySelectorAll<HTMLElement>('[data-pay-tab]').forEach((b) => b.setAttribute('aria-selected', String(b.dataset.payTab === name)));
    document.querySelectorAll<HTMLElement>('[data-pay-panel]').forEach((p) => (p.hidden = p.dataset.payPanel !== name));
    const intro = document.querySelector<HTMLElement>('[data-pay-intro]');
    if (intro) intro.textContent = PAY_INTRO[name] ?? '';
    if (name === 'ramp') ramp.draw();
    if (name === 'transfer') showTransferMode(transferMode);
  }
  document.querySelectorAll<HTMLElement>('[data-pay-tab]').forEach((b) => b.addEventListener('click', () => showPayTab(b.dataset.payTab ?? 'send')));

  // The two lists (Find Tokens, Marketplace) are tabs; Swap is its own page and shows the same swap panel.
  function showTab(name: string): void {
    const intro = root!.querySelector<HTMLElement>('[data-sw-intro]');
    if (intro) intro.textContent = TAB_INTRO[name] ?? '';
    document.querySelectorAll<HTMLElement>('[data-sw-tab]').forEach((b) => b.setAttribute('aria-selected', String(b.dataset.swTab === name)));
    root!.querySelectorAll<HTMLElement>('[data-sw-panel]').forEach((p) => (p.hidden = p.dataset.swPanel !== name));
    if (name === 'markets') markets.ensureLoaded();
    if (name === 'swap') render();
  }
  document.querySelectorAll<HTMLElement>('[data-sw-tab]').forEach((b) => b.addEventListener('click', () => showTab(b.dataset.swTab ?? 'new')));

  // ---- the swap, opened over the page it was started from (Marketplace, a token page) so nobody is sent away
  const swapDialog = document.querySelector<HTMLElement>('[data-swap-dialog]');
  const swapSlot = document.querySelector<HTMLElement>('[data-swap-dialog-slot]');
  const swapDialogOpen = (): boolean => !!swapDialog && !swapDialog.hidden;
  const swapHome = swapPanel.parentElement;
  const swapNext = swapPanel.nextSibling;
  let dialogReturnFocus: HTMLElement | null = null;
  const onDialogKey = (e: KeyboardEvent): void => {
    if (e.key === 'Escape') closeSwapDialog();
  };
  function openSwapDialog(): void {
    if (!swapDialog || !swapSlot) return;
    if (swapDialog.hidden) dialogReturnFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    swapSlot.append(swapPanel);
    swapPanel.hidden = false;
    swapDialog.hidden = false;
    document.addEventListener('keydown', onDialogKey);
    render();
    swapDialog.querySelector<HTMLElement>('[data-swap-dialog-close]')?.focus();
  }
  function closeSwapDialog(): void {
    if (!swapDialog || swapDialog.hidden) return;
    swapDialog.hidden = true;
    document.removeEventListener('keydown', onDialogKey);
    if (swapHome) swapHome.insertBefore(swapPanel, swapNext);
    swapPanel.hidden = true;
    dialogReturnFocus?.focus?.();
    dialogReturnFocus = null;
  }
  swapDialog?.querySelector('[data-swap-dialog-close]')?.addEventListener('click', closeSwapDialog);
  swapDialog?.addEventListener('mousedown', (e) => {
    if (e.target === swapDialog) closeSwapDialog();
  });

  // ---- the top-bar search opens a token here, with its chart
  mountTokenSearch();

  // The tabs sit in the top bar beside the search box on a wide screen, and back above the page on a narrow one.
  const tabBar = root.querySelector<HTMLElement>('[data-sw-tabs]');
  const tabHome = tabBar?.parentElement ?? null;
  const tabNext = tabBar?.nextElementSibling ?? null;
  const placeTabs = (): void => {
    if (!tabBar || !tabHome) return;
    const bar = document.querySelector<HTMLElement>('header.nav .nav__bar');
    const search = document.querySelector<HTMLElement>('[data-wapp-search]');
    if (window.matchMedia('(min-width: 1081px)').matches && bar && search?.parentElement === bar) search.after(tabBar);
    else tabHome.insertBefore(tabBar, tabNext);
  };
  window.matchMedia('(min-width: 1081px)').addEventListener('change', placeTabs);
  placeTabs();
  window.addEventListener(OPEN_TOKEN_EVENT, (e) => {
    const t = (e as CustomEvent<SearchHit>).detail;
    void (async () => {
      const mode = tokenOpenMode(location.hash);
      if (mode === 'go-to-swap') {
        location.hash = '#/swap';
        await new Promise<void>((r) => window.addEventListener('hashchange', () => r(), { once: true }));
      }
      selectChain(t.chain);
      // From Markets or Favourites the swap opens over the list; on the Swap page it is already in place.
      if (mode === 'markets-dialog') openSwapDialog();
      else showTab('swap');
      if (t.decimals !== null) await pick('to', { mint: t.address, symbol: t.symbol, name: t.name, decimals: t.decimals, icon: t.icon, verified: null }, t.chain);
    })();
  });

  // Intent hands over a swap it has read: the Swap page fills in both tokens and the amount, and the person reviews it there.
  window.addEventListener(PREFILL_SWAP_EVENT, (e) => {
    const d = (e as CustomEvent<{ from: { mint: string; symbol: string; decimals: number | null }; to: { mint: string; symbol: string; decimals: number | null }; amount: string }>).detail;
    if (d.from.decimals === null || d.to.decimals === null) return;
    void (async () => {
      if (location.hash !== '#/swap') location.hash = '#/swap';
      selectChain('solana');
      showTab('swap');
      await pick('from', { mint: d.from.mint, symbol: d.from.symbol, name: d.from.symbol, decimals: d.from.decimals!, icon: null, verified: null }, 'solana');
      await pick('to', { mint: d.to.mint, symbol: d.to.symbol, name: d.to.symbol, decimals: d.to.decimals!, icon: null, verified: null }, 'solana');
      s.amount = d.amount;
      render();
    })();
  });

  // A saved WalletConnect session reconnects without a prompt; the library loads only if one exists.
  if (isProjectId(WC_PROJECT_ID) && hasSavedSession()) {
    void restoreWalletConnect(evm, WC_PROJECT_ID).then((account) => {
      if (account && evm.adapter) {
        registerEvmWallet(router, evm.adapter);
        render();
      }
    });
  }

  showTab('markets');
  showPayTab('send');

  renderRail();
  void loadRuntime().then(() => {
    renderRail();
    render();
    markets.draw();
  });

  return {
    onShow(view) {
      closeSwapDialog();
      showTab(view === 'swap' ? 'swap' : 'markets');
      render();
      if (view !== 'swap') markets.setFavouritesPage(view === 'favourites');
      markets.draw();
      renderActivity();
    },
    onPayShow() {
      showPayTab(payTab);
    },
    onWalletChange() {
      evmResume.tried = false;
      autoSync();
      resetQuote();
      scheduleAuto();
      render();
      renderActivity();
    },
    onActivityShow() {
      renderActivity();
    },
  };
}

