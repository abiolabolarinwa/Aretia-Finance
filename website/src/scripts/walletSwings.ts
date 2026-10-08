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
import { mountTokenSearch, OPEN_TOKEN_EVENT } from './walletSearch.js';
import { marketTable, type TableState } from './walletMarketTable.js';
import { GeckoMarket, type MarketKind, type Window as MarketWindow } from '../swings/market/gecko.js';
import { rowsFromRecords } from '../swings/market/registryRows.js';
import type { MarketRow } from '../swings/market/types.js';
import type { SearchHit } from '../swings/tokens/globalSearch.js';
import { viewStatus } from '../swings/crosschain/view.js';
import { connectWalletConnect, hasSavedSession, isProjectId, restoreWalletConnect } from '../swings/wallet/walletConnect.js';
import { CHAINS, CHAIN_IDS, EVM_NATIVE_ADDRESS, SwingsError, type ChainId, type PreparedSwap, type Quote, type SwapExecution, type TokenRecord, type TokenRisk } from '../swings/core/types.js';
import { describeSafety } from '../swings/tokens/safety.js';
import { avatar, createChartPanel } from './walletChart';
import { cachedLogo, ensureLogos } from '../swings/tokens/logos.js';
import { WRAPPED_NATIVE } from '../swings/dex/entries.js';
import { summarizeQuote } from '../swings/core/summary.js';
import { assessMevExposure } from '../swings/core/mev.js';
import { normalizeTokenRef } from '../swings/core/token.js';
import { RISK_LABELS } from '../swings/tokens/risk.js';
import { assessTokenSafety, createLiveRouter, onchainDecimals, registerEvmWallet } from '../swings/live.js';
import { evmGasProblem, EvmSession, publicRead, readBalance, readErc20 } from '../swings/chains/evmSession.js';
import { isCanaryAllowed, isChainEnabled, loadRuntime, runtime } from '../swings/runtime.js';
import { browserStorage, SwapHistory, type HistoryItem } from '../swings/history.js';
import { AretiaRouter } from '../swings/router/router.js';
import { fetchSizeImpact, searchTokens, SOL_MINT, type Quote as JupiterQuote, type TokenInfo } from './walletSwap';
import { KNOWN_TOKENS, SLIPPAGE_PRESETS_BPS, defaultSlippageBps, fromSmallestUnit, toSmallestUnit } from './walletTools';

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
};

function el<K extends keyof HTMLElementTagNameMap>(tag: K, props: { class?: string; text?: string; attrs?: Record<string, string> } = {}, children: (Node | null | false)[] = []): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (props.class) node.className = props.class;
  if (props.text !== undefined) node.textContent = props.text;
  for (const [k, v] of Object.entries(props.attrs ?? {})) node.setAttribute(k, v);
  for (const c of children) if (c) node.append(c);
  return node;
}

const short = (a: string): string => (a.length > 12 ? `${a.slice(0, 4)}…${a.slice(-4)}` : a);
const usd = (n: number | null): string => (n === null ? 'n/a' : n >= 1e6 ? `$${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `$${Math.round(n / 1e3)}K` : `$${Math.round(n)}`);
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

export function initSwings(host: SwingsHost): { onShow(): void; onWalletChange(): void; onActivityShow(): void } {
  const root = document.querySelector<HTMLElement>('[data-pane="swings"]');
  if (!root) return { onShow() {}, onWalletChange() {}, onActivityShow() {} };
  const panel = (name: string): HTMLElement => root.querySelector<HTMLElement>(`[data-sw-panel="${name}"]`)!;
  const swapPanel = panel('swap');
  // Swaps and moves are listed in the sidebar's Activity page, not in a tab here.
  const activityPanel = document.querySelector<HTMLElement>('[data-swings-activity]') ?? el('div');
  const rampPanel = panel('ramp');
  const movePanel = root.querySelector<HTMLElement>('[data-transfer-pane="move"]')!;
  const planPanel = root.querySelector<HTMLElement>('[data-transfer-pane="plan"]')!;

  // Tokens the user picked, by address: names and icons only. Decimals are re-read from the chain.
  const picked = new Map<string, TokenInfo>();
  const router: AretiaRouter = createLiveRouter({
    heldOthers: () => (host.getHoldings() ?? []).map((h) => ({ mint: h.mint, symbol: h.symbol })),
    knownToken: (mint) => picked.get(mint) ?? null,
  });
  const evm = new EvmSession();
  // One chart for the swap screen, moved between redraws so it is not rebuilt every time the screen changes.
  const swapChart = createChartPanel();
  const history = new SwapHistory(browserStorage());
  const chainRuntime = createCrossChainRuntime(evm, (c) => isChainEnabled(c), () => host.getAddress());
  const crossChain = initCrossChain(movePanel, chainRuntime);
  const planTab = initPlan(planPanel, chainRuntime);
  const ramp = initRamp(rampPanel, evm, () => host.getAddress(), (c) => isChainEnabled(c));
  // The "Before you swap" dropdown is written in the page. One copy is kept and moved between redraws, so it stays open if the user opened it.
  let guideEl: Element | null = null;
  const guide = (): Element | null => {
    if (!guideEl) {
      const tpl = document.getElementById('sw-guide') as HTMLTemplateElement | null;
      guideEl = (tpl?.content.firstElementChild?.cloneNode(true) as Element | undefined) ?? null;
    }
    return guideEl;
  };

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
  }

  /** Assesses the token being bought, in the page, against the chain. A slow answer for a token no longer chosen is dropped. */
  async function loadSafety(chain: ChainId, mint: string): Promise<void> {
    const key = `${chain}:${mint}`;
    if (mint === EVM_NATIVE_ADDRESS || mint === SOL_MINT) {
      s.safety = { key, loading: false, risk: null, acknowledged: false };
      return;
    }
    s.safety = { key, loading: true, risk: null, acknowledged: false };
    const risk = await assessTokenSafety(chain, mint);
    if (s.safety.key !== key) return;
    s.safety = { key, loading: false, risk, acknowledged: false };
    render();
  }

  function resetQuote(): void {
    s.seq++;
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

  async function getQuote(): Promise<void> {
    const address = accountFor(s.chain);
    const amountIn = rawAmount();
    if (!address || !s.from || !s.to || amountIn === null) return;
    const mySeq = ++s.seq;
    s.phase = 'quoting';
    s.error = null;
    s.prepared = null;
    s.execution = null;
    s.extraBlockers = [];
    render();
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
      s.failures = search.failures.map((f) => `${f.providerId}: ${f.message}`);
      // Protected sending only exists on Aretia's own Solana routes. Other providers' routes would go the normal way,
      // so while it is on they are not offered at all: it must never look protected when it is not.
      const protectedOnly = s.protect && chain === 'solana' && runtime.protectedSubmit;
      const routes = protectedOnly ? search.routes.filter((r) => r.providerId === 'aretia-sol') : search.routes;
      const best = routes[0];
      if (!best) {
        s.phase = 'idle';
        s.error = protectedOnly && search.routes.length > 0 ? 'Protected sending is only available on Aretia Router routes, and none was found for this swap. Turn protected sending off to use the other routes.' : `No executable route was found.${search.rejected.length ? ' ' + search.rejected.flatMap((r) => r.reasons).join(' ') : ''}`;
        return render();
      }
      s.quote = best;
      s.alternatives = routes.slice(1);
      s.phase = 'quoted';
      render();
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
    } catch (e) {
      if (mySeq !== s.seq) return;
      s.phase = 'idle';
      s.error = e instanceof SwingsError ? e.message : 'The quote could not be fetched. Try again in a moment.';
      render();
    }
  }

  async function review(): Promise<void> {
    if (!s.quote) return;
    const mySeq = s.seq;
    const quote = s.quote;
    if (!(await isCanaryAllowed(quote.request.account.address))) {
      s.error = 'Aretia Swings is in a staged rollout and your wallet is not in the first group yet. You can still get quotes. Nothing was signed or sent.';
      render();
      return;
    }
    s.phase = 'preparing';
    s.error = null;
    render();
    try {
      const prepared = await router.buildTransaction(quote);
      if (mySeq !== s.seq) return;
      s.extraBlockers = [];
      if (isEvm(quote.request.chain) && s.from) {
        const native = await readBalance(publicRead(quote.request.chain), quote.request.account.address, EVM_NATIVE_ADDRESS);
        const problem = evmGasProblem({ nativeBalance: native, networkFee: quote.costs.network?.amount ?? null, sellsNative: s.from.mint === EVM_NATIVE_ADDRESS, amountIn: quote.inAmount, nativeSymbol: CHAINS[quote.request.chain].nativeSymbol });
        if (problem) s.extraBlockers.push(problem);
      }
      s.prepared = prepared;
      s.phase = 'review';
    } catch (e) {
      if (mySeq !== s.seq) return;
      s.phase = 'quoted';
      s.error = e instanceof SwingsError ? e.message : 'The swap could not be prepared. Nothing was sent.';
    }
    render();
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
    newTokens.setChain(id);
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

  function evmConnect(): HTMLElement {
    const box = el('div', { class: 'wapp__stack' });
    if (evm.account) {
      const row = el('div', { class: 'wapp__row-actions' });
      row.append(el('span', { class: 'wapp__fine', text: `${evm.walletName ?? 'EVM wallet'} · ${short(evm.account)}` }));
      const off = el('button', { class: 'wapp__btn wapp__btn--ghost', text: 'Disconnect', attrs: { type: 'button' } });
      off.addEventListener('click', () => {
        void evm.disconnect().then(() => {
          resetQuote();
          render();
        });
      });
      row.append(off);
      box.append(row);
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
    box.append(el('span', { class: 'wapp__eyebrow', text: `Safety check: ${s.to.symbol}` }));
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
    const fmt = (raw: bigint, d: number) => fromSmallestUnit(raw, d);
    const impactBps = s.sizeImpact === null ? null : Math.round(s.sizeImpact * 10_000);
    const mev = assessMevExposure(quote.request.slippageBps, impactBps);
    const rows: [string, string][] = [
      ['You pay', `${fmt(sum.swap.amountIn, from.decimals)} ${from.symbol}`],
      ['You receive (expected)', `${fmt(sum.swap.expectedOut, to.decimals)} ${to.symbol}`],
      ['Minimum you will receive', `${fmt(sum.swap.minOut, to.decimals)} ${to.symbol}`],
      ['Slippage allowed', `${(quote.request.slippageBps / 100).toFixed(2)}%`],
      ['Price impact (your trade size)', impactBps === null ? 'Not available' : `${(impactBps / 100).toFixed(2)}%`],
      ['Sandwich exposure', mev.level],
      ['Route', sum.swap.route.join(' + ') || 'Not reported'],
      ['Network fee', sum.network ? `About ${fmt(sum.network.amount, info.nativeDecimals)} ${info.nativeSymbol}` : 'Paid in SOL; shown by your wallet before you sign'],
      ['DEX / provider fee', sum.provider ? 'Included' : 'Included in the quoted price'],
      ['Aretia buyback', sum.aretiaBuyback.state === 'off' ? 'None' : sum.aretiaBuyback.state === 'ready' ? `${fmt(sum.aretiaBuyback.amount, from.decimals)} ${from.symbol} (0.55%) goes to buying ACT, on top of your swap` : 'Blocked: configuration incomplete'],
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
    swapPanel.replaceChildren();
    const info = CHAINS[s.chain];
    const address = accountFor(s.chain);
    wantLogos(s.chain, [s.from, s.to]);
    // Laid out like the Trade tab: the network on top, then the swap on the left and the chart on the right.
    const card = el('div', { class: 'wapp__card wapp__swap' });
    const side = el('div', { class: 'wapp__trade-side' });
    const place = (): void => {
      const g = guide();
      if (g) side.append(g);
      swapPanel.append(el('div', { class: 'wapp__grid wapp__grid--trade' }, [card, side]));
    };

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
      if (target.address) {
        const chartCard = el('div', { class: 'wapp__card' });
        chartCard.append(swapChart.element);
        side.append(chartCard);
        swapChart.show(s.chain, target.address, target.symbol, target.icon);
      } else swapChart.hide();
    }

    if (!isChainEnabled(s.chain)) {
      card.append(banner('warn', `${info.name} swaps are switched off at the moment, either by the operator or because the page could not reach its settings. Nothing on this network can be traded from this page right now. Reload to check again.`));
      place();
      return;
    }
    if (isEvm(s.chain)) card.append(evmConnect());
    if (!address) {
      if (!isEvm(s.chain)) {
        const connect = el('button', { class: 'wapp__btn wapp__btn--primary', text: 'Connect wallet', attrs: { type: 'button' } });
        connect.addEventListener('click', () => document.querySelector<HTMLButtonElement>('[data-aretia-wallet-mount] button')?.click());
        card.append(banner('info', 'Connect a Solana wallet to get a quote. Aretia never holds your keys.'), connect);
      }
      if (s.error) card.append(banner('warn', s.error));
      place();
      return;
    }

    card.append(banner('info', `Same-chain swap on ${info.name}. Cross-chain swaps are not available yet.`));
    const amount = el('input', { class: 'wapp__swap-amount', attrs: { inputmode: 'decimal', placeholder: '0.0', autocomplete: 'off', 'aria-label': 'Amount to pay' } });
    amount.value = s.amount;
    amount.addEventListener('input', () => {
      s.amount = amount.value;
      if (s.phase !== 'idle') {
        resetQuote();
        render();
        amount.focus();
      } else updateActions();
    });
    card.append(
      el('div', { class: 'wapp__swap-box' }, [
        el('div', { class: 'wapp__row' }, [el('span', { class: 'wapp__eyebrow', text: 'You pay' }), tokenNote('from')]),
        el('div', { class: 'wapp__swap-main' }, [tokenButton('from'), amount]),
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
    // The estimate fills in once a quote has been fetched.
    const estimate = s.quote && s.to && s.phase !== 'idle' && s.phase !== 'quoting' ? fromSmallestUnit(s.quote.expectedOut, s.to.decimals) : '0.0';
    card.append(
      el('div', { class: 'wapp__swap-box' }, [
        el('div', { class: 'wapp__row' }, [el('span', { class: 'wapp__eyebrow', text: 'You receive (estimate)' }), tokenNote('to')]),
        el('div', { class: 'wapp__swap-main' }, [tokenButton('to'), el('output', { class: 'wapp__swap-out', text: estimate })]),
      ]),
    );
    card.append(el('div', { attrs: { 'data-sw-picker': '' } }));

    const slip = el('div', { class: 'wapp__slip', attrs: { role: 'group', 'aria-label': 'Slippage' } });
    slip.append(el('span', { class: 'wapp__eyebrow', text: 'Slippage' }));
    for (const bps of SLIPPAGE_PRESETS_BPS) {
      const b = el('button', { class: 'wapp__chip wapp__chip--btn', text: `${bps / 100}%`, attrs: { type: 'button', 'aria-pressed': String(s.slippageBps === bps) } });
      b.addEventListener('click', () => {
        s.slippageBps = bps;
        s.slippageTouched = true;
        resetQuote();
        render();
      });
      slip.append(b);
    }
    card.append(slip);
    if (s.chain === 'solana' && runtime.protectedSubmit) {
      const label = el('label', { class: 'wapp__fine' });
      const box = el('input', { attrs: { type: 'checkbox' } });
      box.checked = s.protect;
      box.addEventListener('change', () => {
        s.protect = box.checked;
        resetQuote();
        render();
      });
      label.append(box, el('span', { text: ' Protected sending (Jito): sent privately, with a tip of about 0.00001 SOL, to lower the chance of being sandwiched. Not a guarantee.' }));
      card.append(label);
    }

    const actions = el('div', { class: 'wapp__row-actions', attrs: { 'data-sw-actions': '' } });
    card.append(actions);
    if (s.error) card.append(banner('warn', s.error));
    if (s.notice) card.append(banner('info', s.notice));
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
    for (const f of s.failures) card.append(el('p', { class: 'wapp__fine', text: `A provider did not answer (${f}).${s.quote ? ' Other routes were used.' : ''}` }));

    if (s.quote && s.phase !== 'idle' && s.phase !== 'quoting') {
      const q = s.quote;
      card.append(el('span', { class: 'wapp__eyebrow', text: s.phase === 'review' || s.phase === 'signing' || s.phase === 'tracking' || s.phase === 'done' ? 'Final review' : 'Best route found' }));
      card.append(summaryRows(q));
      const safety = safetyBlock();
      if (safety) card.append(safety);
      const exp = expiryLabel(q);
      card.append(el('p', { class: 'wapp__fine', text: exp.text, attrs: { 'data-sw-expiry': '' } }));
      if (s.alternatives.length > 0) {
        const more = el('details', { class: 'wapp__more' }, [el('summary', { text: `${s.alternatives.length} other route${s.alternatives.length === 1 ? '' : 's'}` })]);
        for (const alt of s.alternatives) more.append(el('p', { class: 'wapp__fine', text: `${providerLabel(alt.providerId)}: ${fromSmallestUnit(alt.expectedOut, s.to!.decimals)} ${s.to!.symbol}` }));
        card.append(more);
      }
      const mev = assessMevExposure(q.request.slippageBps, s.sizeImpact === null ? null : Math.round(s.sizeImpact * 10_000));
      if (mev.level !== 'low') card.append(banner('warn', mev.note));
      if (s.prepared) {
        for (const b of [...s.prepared.simulation.blockers, ...s.extraBlockers]) card.append(banner('warn', b));
        for (const w of s.prepared.simulation.warnings) card.append(banner('info', w));
        if (s.prepared.simulation.ok && s.extraBlockers.length === 0 && (s.phase === 'review' || s.phase === 'signing')) card.append(banner('ok', 'The swap passed its pre-send checks. This is not a guarantee: prices can move before it lands, and the minimum above is the least you will accept.'));
      }
      for (const n of summarizeQuote(q).notes) if (!n.startsWith('No Aretia fee')) card.append(el('p', { class: 'wapp__fine', text: n }));
    }
    if (s.phase === 'tracking') card.append(banner('info', 'Sent. Waiting for the network to confirm. Do not send it again.'));
    if (s.phase === 'done' && s.execution) {
      const ex = s.execution;
      if (ex.status === 'confirmed') card.append(banner('ok', 'Confirmed on-chain.'));
      else if (ex.status === 'failed') card.append(banner('warn', ex.error ?? 'The transaction failed on-chain. Your tokens were not swapped.'));
      else card.append(banner('info', 'Still waiting for confirmation. Check the transaction before trying again; the swap may still land.'));
      if (ex.txId) card.append(el('a', { text: 'View transaction', attrs: { href: EXPLORER_TX[ex.chain] + encodeURIComponent(ex.txId), target: '_blank', rel: 'noopener noreferrer' } }));
    }
    place();
    renderPicker();
    updateActions();
  }

  function updateActions(): void {
    const actions = swapPanel.querySelector<HTMLElement>('[data-sw-actions]');
    if (!actions) return;
    actions.replaceChildren();
    const amountIn = rawAmount();
    const btn = (label: string, handler: () => void, kind: 'primary' | 'ghost' = 'primary', disabled = false): HTMLButtonElement => {
      const b = el('button', { class: `wapp__btn wapp__btn--${kind}`, text: label, attrs: { type: 'button' } });
      b.disabled = disabled;
      b.addEventListener('click', handler);
      return b;
    };
    const problem = s.from && s.to && s.from.mint === s.to.mint ? 'Choose two different tokens.' : amountIn !== null ? balanceProblem(amountIn) : null;
    const expired = s.quote ? expiryLabel(s.quote).expired : false;
    if (s.phase === 'idle' || s.phase === 'quoting') {
      actions.append(btn(s.phase === 'quoting' ? 'Getting quotes…' : 'Get quotes', () => void getQuote(), 'primary', s.phase === 'quoting' || !s.from || !s.to || amountIn === null || problem !== null));
      if (problem) actions.append(el('span', { class: 'wapp__fine', text: problem }));
      else if (s.amount.trim() && amountIn === null) actions.append(el('span', { class: 'wapp__fine', text: 'Enter a valid amount.' }));
    } else if (s.phase === 'quoted' || s.phase === 'preparing') {
      actions.append(btn(s.phase === 'preparing' ? 'Checking…' : 'Review swap', () => void review(), 'primary', s.phase === 'preparing' || expired || safetyNeedsAck()));
      actions.append(btn('New quote', () => void getQuote(), 'ghost', s.phase === 'preparing'));
    } else if (s.phase === 'review' || s.phase === 'signing') {
      const ok = s.prepared?.simulation.ok === true && s.extraBlockers.length === 0 && !expired && !safetyNeedsAck();
      actions.append(btn(s.phase === 'signing' ? 'Waiting for your wallet…' : 'Confirm and sign in your wallet', () => void confirm(), 'primary', s.phase === 'signing' || !ok));
      actions.append(btn('New quote', () => void getQuote(), 'ghost', s.phase === 'signing'));
    } else if (s.phase === 'done') {
      actions.append(
        btn('New swap', () => {
          resetQuote();
          render();
        }, 'ghost'),
      );
    }
  }

  function render(): void {
    renderSwap();
    clearInterval(ticker);
    if (s.quote && (s.phase === 'quoted' || s.phase === 'review')) {
      ticker = setInterval(() => {
        if (!s.quote) return;
        const exp = expiryLabel(s.quote);
        const node = swapPanel.querySelector<HTMLElement>('[data-sw-expiry]');
        if (node) node.textContent = exp.text;
        updateActions();
        if (exp.expired) clearInterval(ticker);
      }, 1000);
    }
  }

  // ------------------------------------------------------------------ token lists (New Tokens, Markets)

  const market = new GeckoMarket();

  function tokenBrowser(target: HTMLElement, mode: 'new' | 'markets') {
    // Find Tokens lists Aretia's registry of newly detected tokens; Marketplace lists what is trading now.
    const f = { chain: '' as '' | ChainId, age: '24', liquidity: '0', risk: '', sort: 'newest', hideRisky: true };
    const m = { kind: 'trending' as MarketKind, window: 'h24' as MarketWindow, chain: '' as '' | ChainId };
    let rows: MarketRow[] | null = null;
    const records = new Map<string, TokenRecord>();
    let tsort: TableState = { key: null, dir: 'desc' };
    let error: string | null = null;
    let loading = false;
    let selected: TokenRecord | null = null;
    let seq = 0;
    const rowKey = (chain: ChainId, address: string): string => `${chain}:${chain === 'solana' ? address : address.toLowerCase()}`;

    async function load(silent = false): Promise<void> {
      const mine = ++seq;
      if (!silent) {
        loading = true;
        error = null;
        draw();
      }
      try {
        if (mode === 'new') {
          const q = new URLSearchParams();
          if (f.chain) q.set('chain', f.chain);
          if (f.age !== '0') q.set('maxAgeHours', f.age);
          if (f.liquidity !== '0') q.set('minLiquidityUsd', f.liquidity);
          if (f.risk) q.set('risk', f.risk);
          // Asking for high-risk tokens on purpose overrides the hide switch.
          if (f.hideRisky && f.risk !== 'high' && f.risk !== 'restricted') q.set('hideRisky', '1');
          q.set('sort', f.sort);
          q.set('limit', '60');
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
          rows = filled;
        } else {
          const got = await market.load({ kind: m.kind, chain: m.chain, window: m.window });
          if (mine !== seq) return;
          rows = got;
        }
        error = null;
      } catch (e) {
        if (mine !== seq) return;
        // A background refresh that fails keeps the table already on screen.
        if (!silent || rows === null) error = e instanceof Error ? e.message : 'The list is unavailable right now.';
      }
      loading = false;
      draw();
    }

    function select(label: string, value: string, options: [string, string][], onChange: (v: string) => void): HTMLElement {
      const sel = el('select', { class: 'wapp__input', attrs: { 'aria-label': label } });
      for (const [v, text] of options) sel.append(el('option', { text, attrs: { value: v } }));
      sel.value = value;
      sel.addEventListener('change', () => onChange(sel.value));
      return sel;
    }

    function chip(label: string, pressed: boolean, onClick: () => void): HTMLElement {
      const b = el('button', { class: 'wapp__chip wapp__chip--btn', text: label, attrs: { type: 'button', 'aria-pressed': String(pressed) } });
      b.addEventListener('click', onClick);
      return b;
    }

    /** A row was clicked: Find Tokens opens the token's detail and safety notes; Marketplace opens it in Swap Coins. */
    function openRow(r: MarketRow): void {
      if (mode === 'new') {
        const rec = records.get(rowKey(r.chain, r.address));
        if (rec) {
          selected = rec;
          draw();
          target.scrollIntoView({ block: 'start' });
        }
        return;
      }
      window.dispatchEvent(new CustomEvent(OPEN_TOKEN_EVENT, { detail: { chain: r.chain, address: r.address, symbol: r.symbol, name: r.name, icon: r.icon, decimals: r.decimals, liquidityUsd: r.liquidityUsd, priceUsd: r.priceUsd, fresh: false, risk: null } satisfies SearchHit }));
    }

    function detail(r: TokenRecord): HTMLElement {
      const card = el('div', { class: 'wapp__card' });
      const info = CHAINS[r.ref.chain];
      card.append(el('h3', { class: 'wapp__h2', text: `${r.symbol} on ${info.name}` }));
      card.append(banner('warn', 'Newly discovered tokens are not endorsed or approved by Aretia. Anyone can create a token, and many new tokens lose their value. Check the details below before trading.'));
      const rows: [string, string][] = [
        ['Name', r.name || 'Not provided'],
        ['Address', r.ref.address],
        ['Detected', `${new Date(r.firstDetectedAt).toLocaleString()} via ${r.discoverySource}`],
        ['Pool created', r.firstPoolAt ? new Date(r.firstPoolAt).toLocaleString() : 'Unknown'],
        ['Liquidity', usd(r.liquidityUsd)],
        ['24h volume', usd(r.volume24hUsd)],
        ['Holders', r.holderCount === null ? 'Not available' : String(r.holderCount)],
        ['Trading pools', r.pools.length ? r.pools.map((p) => p.venue).join(', ') : 'None found'],
        ['Metadata', r.metadataConfidence === 'onchain' ? 'Read from the chain' : r.metadataConfidence === 'api' ? 'From a third-party index, not yet confirmed on-chain' : 'Unconfirmed'],
      ];
      const dl = el('dl', { class: 'wapp__rows' });
      for (const [k, v] of rows) dl.append(el('div', {}, [el('dt', { text: k }), el('dd', { text: v })]));
      const chart = createChartPanel();
      card.append(dl, chart.element);
      chart.show(r.ref.chain, r.ref.address, r.symbol, r.logo);
      card.append(el('span', { class: 'wapp__eyebrow', text: 'Aretia token risk' }));
      if (!r.risk) card.append(el('p', { class: 'wapp__fine', text: 'No risk assessment has been run for this token yet.' }));
      else {
        card.append(el('p', { class: 'wapp__fine', text: r.risk.score === null ? 'Not enough data to give a score. This is not a good sign or a bad one.' : `Score ${r.risk.score}/100 (higher means more concerns found). Classification: ${RISK_LABELS[r.risk.status]}.` }));
        const list = el('ul', { class: 'wapp__list' });
        const mark = { ok: '✓', warn: '⚠', bad: '✗', unavailable: '–' } as const;
        for (const sig of r.risk.signals) list.append(el('li', { text: `${mark[sig.state]} ${sig.label}: ${sig.detail}` }));
        card.append(list);
      }
      const act = el('div', { class: 'wapp__row-actions' });
      if (isChainEnabled(r.ref.chain)) {
        const b = el('button', { class: 'wapp__btn wapp__btn--primary', text: `Swap into ${r.symbol}`, attrs: { type: 'button' } });
        b.addEventListener('click', () => {
          void pick('to', { mint: r.ref.address, symbol: r.symbol, name: r.name, decimals: r.decimals, icon: r.logo, verified: r.verified }, r.ref.chain).then(() => showTab('swap'));
        });
        act.append(b);
      } else act.append(el('span', { class: 'wapp__fine', text: `Swaps on ${info.name} are switched off at the moment, so this token can be inspected but not traded here.` }));
      const close = el('button', { class: 'wapp__btn wapp__btn--ghost', text: 'Close', attrs: { type: 'button' } });
      close.addEventListener('click', () => {
        selected = null;
        draw();
      });
      act.append(close);
      card.append(act);
      return card;
    }

    function draw(): void {
      target.replaceChildren();
      if (selected) target.append(detail(selected));
      const card = el('div', { class: 'wapp__card wapp-mt__card' });
      card.append(el('h2', { class: 'wapp__h2', text: mode === 'new' ? 'Find tokens' : 'Marketplace' }));
      card.append(el('p', { class: 'wapp__fine', text: mode === 'new' ? 'Tokens Aretia has just detected with a trading pool, with Aretia\'s safety rating. Discovery is not endorsement: a token appearing here says nothing about whether it is safe, honest or worth buying.' : 'What is trading right now across the networks. Busy does not mean safe, and liquidity can be withdrawn.' }));
      const bar = el('div', { class: 'wapp-mt__bar' });
      if (mode === 'markets') {
        const kinds: [MarketKind, string][] = [['trending', 'Trending'], ['top', 'Top'], ['gainers', 'Gainers'], ['new', 'New pairs']];
        const kindBox = el('div', { class: 'wapp__seg', attrs: { role: 'group', 'aria-label': 'List' } });
        for (const [k, label] of kinds) kindBox.append(chip(label, m.kind === k, () => { m.kind = k; tsort = { key: null, dir: 'desc' }; void load(); }));
        bar.append(kindBox);
        if (m.kind === 'trending' || m.kind === 'gainers') {
          const win = el('div', { class: 'wapp__seg', attrs: { role: 'group', 'aria-label': 'Time window' } });
          for (const [w, label] of [['m5', '5M'], ['h1', '1H'], ['h6', '6H'], ['h24', '24H']] as [MarketWindow, string][]) win.append(chip(label, m.window === w, () => { m.window = w; void load(); }));
          bar.append(win);
        }
        bar.append(select('Network', m.chain, [['', 'All networks'], ...CHAIN_IDS.map((c): [string, string] => [c, CHAINS[c].name])], (v) => { m.chain = v as typeof m.chain; void load(); }));
      } else {
        const reload = (): void => {
          selected = null;
          void load();
        };
        bar.append(
          select('Network', f.chain, [['', 'All networks'], ...CHAIN_IDS.map((c): [string, string] => [c, CHAINS[c].name])], (v) => { f.chain = v as typeof f.chain; reload(); }),
          select('Age', f.age, [['1', 'Last hour'], ['6', 'Last 6 hours'], ['24', 'Last 24 hours'], ['168', 'Last 7 days'], ['0', 'Any age']], (v) => { f.age = v; reload(); }),
          select('Minimum liquidity', f.liquidity, [['0', 'Any liquidity'], ['10000', '$10K+'], ['100000', '$100K+'], ['1000000', '$1M+']], (v) => { f.liquidity = v; reload(); }),
          select('Risk', f.risk, [['', 'Any risk'], ['established', 'Established'], ['new', 'New'], ['unverified', 'Unverified'], ['elevated', 'Elevated risk'], ['high', 'High risk'], ['restricted', 'Restricted'], ['unknown', 'Not enough data']], (v) => { f.risk = v; reload(); }),
        );
        const hide = el('input', { attrs: { type: 'checkbox', id: 'hide-risky-new' } });
        hide.checked = f.hideRisky;
        hide.addEventListener('change', () => {
          f.hideRisky = hide.checked;
          reload();
        });
        bar.append(el('label', { class: 'wapp-mt__check wapp__fine', attrs: { for: 'hide-risky-new' } }, [hide, el('span', { text: 'Hide risky tokens' })]));
      }
      card.append(bar);
      if (error) card.append(banner('warn', error));
      else if (rows === null || (loading && rows === null)) card.append(el('p', { class: 'wapp__fine', text: 'Loading…' }));
      else if (rows.length === 0) card.append(el('p', { class: 'wapp__fine', text: mode === 'new' && f.hideRisky ? 'No tokens match. Risky tokens are hidden: untick the box above to see them, or widen the filters.' : 'Nothing matches these filters right now.' }));
      else {
        card.append(marketTable({ rows, sort: tsort, showRisk: mode === 'new', onSort: (key) => { tsort = tsort.key === key ? { key, dir: tsort.dir === 'desc' ? 'asc' : 'desc' } : { key, dir: 'desc' }; draw(); }, onOpen: openRow }));
        // Tokens with no picture get one looked up, then the table redraws once.
        const byChain = new Map<ChainId, string[]>();
        for (const r of rows) if (!r.icon && !cachedLogo(r.chain, r.address)) byChain.set(r.chain, [...(byChain.get(r.chain) ?? []), r.address]);
        if (byChain.size > 0) void Promise.all([...byChain].map(([c, a]) => ensureLogos(c, a))).then((r) => { if (r.some(Boolean)) draw(); });
        card.append(el('p', { class: 'wapp__fine', text: mode === 'new' ? 'Numbers come from each token\'s main pool (DexScreener); a dash means the source did not report it. Click a token for its safety notes, chart and the swap.' : 'Numbers come from GeckoTerminal, per pool. A dash means the pool did not report it. Click a token to chart and swap it.' }));
      }
      target.append(card);
    }

    // The lists refresh by themselves once a minute while they are on screen.
    setInterval(() => {
      if (!target.hidden && !document.hidden && rows !== null && !loading) void load(true);
    }, 60_000);

    return {
      draw,
      ensureLoaded(): void {
        if (rows === null && !loading) void load();
      },
      /** The network logo the user clicked becomes this list's network filter (they can still choose All networks). */
      setChain(id: ChainId): void {
        if (mode === 'new' ? f.chain === id : m.chain === id) return;
        if (mode === 'new') f.chain = id;
        else m.chain = id;
        selected = null;
        if (rows !== null || loading) void load();
        else draw();
      },
    };
  }

  const newTokens = tokenBrowser(panel('new'), 'new');
  const markets = tokenBrowser(panel('markets'), 'markets');

  // ------------------------------------------------------------------ Activity

  function renderActivity(): void {
    activityPanel.replaceChildren();
    const card = activityPanel;
    card.append(el('h2', { class: 'wapp__h2', text: 'Your swaps and moves' }));
    card.append(el('p', { class: 'wapp__fine', text: 'Swaps and USDC transfers made through Aretia Swings in this browser. This list is stored only on this device and is not sent to Aretia.' }));
    void chainRuntime.orchestrator.active().then((moves) => {
      if (moves.length === 0) return;
      const box = el('div', { class: 'wapp__stack' }, [el('span', { class: 'wapp__eyebrow', text: 'USDC transfers in progress' })]);
      for (const m of moves) {
        const v = viewStatus(m, false);
        const go = el('button', { class: 'wapp__btn wapp__btn--ghost', text: 'Open', attrs: { type: 'button' } });
        go.addEventListener('click', () => {
          location.hash = '#/swings';
          showTab('transfer');
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
    swap: 'Exchange one coin for another on the network you picked on the left. You see the price, the least you will get and every fee before anything is signed.',
    new: 'Coins that have just got a trading pool. New does not mean safe: read the safety notes before you buy.',
    markets: 'Coins ranked by how much trading money is behind them. Large does not mean safe either.',
    ramp: 'Turn USDC into cash, or buy USDC with a bank card or transfer, through a licensed provider. Aretia never touches your money.',
    transfer: 'Send USDC from one network to another, or buy USDC with cash and have it end up where you want it. Your wallet approves each step.',
  };

  type TransferMode = 'move' | 'plan';
  let transferMode: TransferMode = 'move';
  function showTransferMode(mode: TransferMode): void {
    transferMode = mode;
    root!.querySelectorAll<HTMLElement>('[data-transfer-mode]').forEach((b) => b.setAttribute('aria-selected', String(b.dataset.transferMode === mode)));
    root!.querySelectorAll<HTMLElement>('[data-transfer-pane]').forEach((p) => (p.hidden = p.dataset.transferPane !== mode));
    if (mode === 'move') crossChain.draw();
    else planTab.draw();
  }
  root.querySelectorAll<HTMLElement>('[data-transfer-mode]').forEach((b) => b.addEventListener('click', () => showTransferMode(b.dataset.transferMode === 'plan' ? 'plan' : 'move')));

  function showTab(name: string): void {
    const intro = root!.querySelector<HTMLElement>('[data-sw-intro]');
    // The swap screen needs the room for its chart, so it has no explanation line.
    if (intro) intro.textContent = name === 'swap' ? '' : (TAB_INTRO[name] ?? '');
    document.querySelectorAll<HTMLElement>('[data-sw-tab]').forEach((b) => b.setAttribute('aria-selected', String(b.dataset.swTab === name)));
    root!.querySelectorAll<HTMLElement>('[data-sw-panel]').forEach((p) => (p.hidden = p.dataset.swPanel !== name));
    if (name === 'new') newTokens.ensureLoaded();
    if (name === 'markets') markets.ensureLoaded();
    if (name === 'ramp') ramp.draw();
    if (name === 'transfer') showTransferMode(transferMode);
    if (name === 'swap') render();
  }
  document.querySelectorAll<HTMLElement>('[data-sw-tab]').forEach((b) => b.addEventListener('click', () => showTab(b.dataset.swTab ?? 'swap')));

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
      if (location.hash !== '#/swings') {
        location.hash = '#/swings';
        await new Promise<void>((r) => window.addEventListener('hashchange', () => r(), { once: true }));
      }
      selectChain(t.chain);
      showTab('swap');
      if (t.decimals !== null) await pick('to', { mint: t.address, symbol: t.symbol, name: t.name, decimals: t.decimals, icon: t.icon, verified: null }, t.chain);
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

  showTab('swap');

  renderRail();
  void loadRuntime().then(() => {
    renderRail();
    render();
    newTokens.draw();
    markets.draw();
  });

  return {
    onShow() {
      render();
      newTokens.draw();
      markets.draw();
      renderActivity();
    },
    onWalletChange() {
      resetQuote();
      render();
      renderActivity();
    },
    onActivityShow() {
      renderActivity();
    },
  };
}

