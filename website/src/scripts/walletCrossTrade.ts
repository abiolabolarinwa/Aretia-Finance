/**
 * The "Buy on another network" screen: buy a token on one network and pay with a token on another, as one guided journey.
 *
 *   step 1  swap what you pay with into USDC on its network        (left out when you pay with USDC)
 *   step 2  move the USDC with Circle to the other network
 *   step 3  swap the USDC into the token you want                  (left out when you want USDC)
 *
 * It is built from the parts that already do each step: the same swap router (quote, build, simulate, the wallet signs), the same
 * Circle move with its safety checks and fee, and the same plan runner and recovery advice as the Plan tab. Every step is signed in
 * the user's own wallet, starts only when the user presses its button, and counts as done only when the user's own balance shows
 * it. Aretia never holds anything. The whole screen exists only on a build with PUBLIC_CROSSCHAIN_SWAP_ENABLED=1.
 */
import { CHAINS, EVM_NATIVE_ADDRESS, SwingsError, type ChainId, type PreparedSwap, type Quote } from '../swings/core/types.js';
import { evmGasProblem, publicRead, readBalance, readErc20 } from '../swings/chains/evmSession.js';
import { CCTP_USDC } from '../swings/settlement/cctp.js';
import { assessSettlement } from '../swings/settlement/safety.js';
import { isCanaryAllowed } from '../swings/runtime.js';
import { assetKeyOf, legFromSettlement, legFromSwap, type ExecutionLeg, type ExecutionQuote } from '../swings/plan/executionQuote.js';
import { PlanRunner } from '../swings/plan/runner.js';
import { SettlementLegExecutor } from '../swings/plan/executors.js';
import { DeferredSettlementExecutor } from '../swings/plan/deferred.js';
import { JourneySettlementExecutor, SwapLegExecutor, type PreparedTrade, type TxStatus } from '../swings/plan/swapLeg.js';
import { CROSS_CHAIN_TRADE_CHAINS, journeyCapProblem, journeyFeeSchedule, journeyProblems, journeyQuote, moveAmountWithin, type TradeToken } from '../swings/plan/crossChainTrade.js';
import { JsonVersionedStore } from '../swings/plan/store.js';
import { canStopHere, hasBegun, isPlanFinal, type PlanRecord } from '../swings/plan/state.js';
import { diagnosePlan, triage } from '../swings/plan/recovery.js';
import { disclose } from '../swings/economics/disclosure.js';
import { formatUnits, durationText, parseUnits } from '../swings/crosschain/view.js';
import type { SettlementQuote } from '../swings/settlement/types.js';
import type { AretiaRouter } from '../swings/router/router.js';
import { assessTokenSafety, onchainDecimals } from '../swings/live.js';
import { describeSafety } from '../swings/tokens/safety.js';
import { MOVE_CAP_RAW } from './walletCrossChain.js';
import { rpcCall } from './walletSend';
import { KNOWN_TOKENS } from './walletTools';
import type { CrossChainRuntime } from './crossChainRuntime.js';

const SOL_MINT = 'So11111111111111111111111111111111111111112';
const STORE_KEY = 'aretia-swings-journeys';
const SLIPPAGE_BPS = 100;
const native = (c: ChainId): string => (CHAINS[c].kind === 'solana' ? SOL_MINT : EVM_NATIVE_ADDRESS);
const usdc = (c: ChainId): string | null => CCTP_USDC[c] ?? null;

function el<K extends keyof HTMLElementTagNameMap>(tag: K, props: { class?: string; text?: string; attrs?: Record<string, string> } = {}, children: (Node | null | false)[] = []): HTMLElementTagNameMap[K] {
  const n = document.createElement(tag);
  if (props.class) n.className = props.class;
  if (props.text !== undefined) n.textContent = props.text;
  for (const [k, v] of Object.entries(props.attrs ?? {})) n.setAttribute(k, v);
  for (const c of children) if (c) n.append(c);
  return n;
}
const banner = (kind: 'warn' | 'info' | 'ok', text: string): HTMLElement => el('p', { class: `wapp__banner wapp__banner--${kind}`, text });
const message = (e: unknown, fallback: string): string => (e instanceof SwingsError ? e.message : fallback);

/** Symbol and decimals of a token, read from the chain (never typed in), or null if it cannot be read. */
async function tokenFacts(chain: ChainId, address: string): Promise<TradeToken | null> {
  if (address === native(chain)) return { chain, address, symbol: CHAINS[chain].nativeSymbol, decimals: CHAINS[chain].nativeDecimals };
  if (address === usdc(chain)) return { chain, address, symbol: 'USDC', decimals: 6 };
  try {
    if (CHAINS[chain].kind === 'solana') {
      const decimals = await onchainDecimals(address);
      if (decimals === null) return null;
      const known = KNOWN_TOKENS.find((k) => k.mint === address);
      return { chain, address, symbol: known?.symbol ?? `${address.slice(0, 4)}…`, decimals };
    }
    const f = await readErc20(publicRead(chain), address);
    return f ? { chain, address: address.toLowerCase(), symbol: f.symbol || `${address.slice(0, 6)}…`, decimals: f.decimals } : null;
  } catch {
    return null;
  }
}

export function initCrossTrade(root: HTMLElement, rt: CrossChainRuntime, router: AretiaRouter): { draw(): void; prefill(chain: ChainId, address: string): void } {
  const { isEnabled, reader, engine, orchestrator, adoptWallet, accountFor } = rt;

  /** A balance in raw units, or null if it cannot be read (never read as zero). */
  const balanceOf = async (chain: ChainId, wallet: string, assetKey: string): Promise<bigint | null> => {
    try {
      if (CHAINS[chain].kind !== 'solana') return await readBalance(reader(chain), wallet, assetKey);
      if (assetKey === usdc('solana')) return await rt.usdcBalance('solana', wallet);
      if (assetKey === SOL_MINT) return BigInt((await rpcCall<{ value: number }>('getBalance', [wallet, { commitment: 'confirmed' }])).value);
      const r = await rpcCall<{ value: { account: { data: { parsed: { info: { tokenAmount: { amount: string } } } } } }[] }>('getTokenAccountsByOwner', [wallet, { mint: assetKey }, { encoding: 'jsonParsed', commitment: 'confirmed' }]);
      return r.value.reduce((sum, a) => sum + BigInt(a.account.data.parsed.info.tokenAmount.amount), 0n);
    } catch {
      return null;
    }
  };
  const walletFor = (chain: ChainId): string | null => accountFor(chain);

  const quotes = new Map<string, SettlementQuote>();
  const inner = new SettlementLegExecutor({ orchestrator, quoteFor: (id) => quotes.get(id) ?? null });
  const deferred = new DeferredSettlementExecutor({
    inner,
    quotes,
    engine,
    balanceOf,
    walletFor,
    usdc,
    assess: async (q) => {
      const i = q.intent;
      const [destNative, srcNative, existing, src] = await Promise.all([rt.nativeBalance(i.destinationChain, i.recipient), rt.nativeBalance(i.sourceChain, i.sender), rt.store.list(), balanceOf(i.sourceChain, i.sender, i.sourceAsset.address)]);
      return assessSettlement(q, { now: Date.now(), provider: rt.providers.find((p) => p.id === q.providerId) ?? null, enabledChains: CROSS_CHAIN_TRADE_CHAINS.filter(isEnabled), sourceBalance: src, destinationNativeBalance: destNative, sourceNativeBalance: srcNative, existing, maxAmount: MOVE_CAP_RAW });
    },
    acknowledge: async (cs) => window.confirm(`${cs.join('\n\n')}\n\nContinue anyway?`),
  });
  const settle = new JourneySettlementExecutor(deferred, { balanceOf, walletFor, usdc });

  // The review of one swap step: shown in the page, answered by the user's press.
  let pendingReview: { trade: PreparedTrade; leg: ExecutionLeg; answer: (yes: boolean) => void } | null = null;

  const swap = new SwapLegExecutor({
    balanceOf,
    walletFor,
    isNative: (c, a) => a === native(c),
    prepare: async ({ chain, from, to, amountIn, account }) => {
      const search = await router.findRoutes({ chain, from: { chain, address: from }, to: { chain, address: to }, amountIn, slippageBps: SLIPPAGE_BPS, account: { chain, address: account } });
      const best = search.routes[0];
      if (!best) throw new SwingsError('no-route', `No swap route was found on ${CHAINS[chain].name} right now. ${search.failures.map((f) => f.message).join(' ')} Nothing was sent.`.trim());
      const prepared = await router.buildTransaction(best);
      const blockers = [...prepared.simulation.blockers];
      if (CHAINS[chain].kind === 'evm') {
        const gas = await balanceOf(chain, account, EVM_NATIVE_ADDRESS);
        const problem = gas === null ? 'Your balance for the network fee could not be read.' : evmGasProblem({ nativeBalance: gas, networkFee: best.costs.network?.amount ?? null, sellsNative: from === EVM_NATIVE_ADDRESS, amountIn, nativeSymbol: CHAINS[chain].nativeSymbol });
        if (problem) blockers.push(problem);
      }
      return { amountIn: best.inAmount, expectedOut: best.expectedOut, minOut: best.minOut, networkFee: best.costs.network?.amount ?? null, simulationOk: prepared.simulation.ok && blockers.length === 0, blockers, warnings: prepared.simulation.warnings, handle: { quote: best, prepared } };
    },
    review: (trade, plan, leg) =>
      new Promise<boolean>((answer) => {
        pendingReview = { trade, leg: plan.quote.legs[leg.index]!, answer };
        draw();
      }),
    send: async (trade) => {
      const { quote, prepared } = trade.handle as { quote: Quote; prepared: PreparedSwap };
      try {
        const ex = await router.executeRoute(prepared, quote, { quoteId: quote.id, confirmed: true });
        if (ex.status === 'rejected') return { status: 'declined' };
        if (ex.notSent) return { status: 'not-sent', reason: ex.error ?? 'Your wallet did not send this.' };
        if (!ex.txId) return { status: 'failed', reason: ex.error ?? 'The swap could not be sent.' };
        if (ex.status === 'failed') return { status: 'failed', reason: ex.error ?? 'The swap failed.', txId: ex.txId };
        return { status: 'sent', txId: ex.txId };
      } catch (e) {
        return { status: 'failed', reason: message(e, 'The swap could not be sent. Check your wallet activity before trying again.') };
      }
    },
    txStatus: async (chain, txId): Promise<TxStatus> => {
      try {
        const t = Date.now();
        const r = await router.trackExecution({ id: txId, quoteId: txId, chain, status: 'submitted', txId, startedAt: t, updatedAt: t }, { timeoutMs: 3_000, intervalMs: 1_000 });
        return r.status === 'confirmed' ? 'confirmed' : r.status === 'failed' ? 'failed' : 'pending';
      } catch {
        return null;
      }
    },
    settledAmount: async (_plan, moveLeg) => (moveLeg.ref.executionId ? ((await orchestrator.get(moveLeg.ref.executionId))?.quote.destinationAmount ?? null) : null),
    memory: {
      get: (k) => {
        try {
          return window.localStorage.getItem(k);
        } catch {
          return null;
        }
      },
      set: (k, v) => {
        try {
          window.localStorage.setItem(k, v);
        } catch {
          // Without storage the plan records the swap on its next check instead.
        }
      },
    },
  });

  const planStore = new JsonVersionedStore<PlanRecord>(window.localStorage, STORE_KEY, (v): v is PlanRecord => typeof v === 'object' && v !== null && 'legs' in v && 'quote' in v);
  const runner = new PlanRunner({ store: planStore, executors: { swap, settlement: settle } });

  const s = {
    fromChain: 'solana' as ChainId,
    fromToken: SOL_MINT,
    fromCustom: '',
    amount: '',
    toChain: 'base' as ChainId,
    toToken: '',
    busy: false,
    error: null as string | null,
    notice: null as string | null,
    review: null as { quote: ExecutionQuote; fees: ReturnType<typeof journeyFeeSchedule>; safety: ReturnType<typeof describeSafety> | null; from: TradeToken; to: TradeToken } | null,
    plan: null as PlanRecord | null,
    loaded: false,
  };
  let timer: number | null = null;

  async function load(): Promise<void> {
    s.loaded = true;
    const mine = (await planStore.list()).filter((p) => !isPlanFinal(p.state)).sort((a, b) => b.createdAt - a.createdAt)[0];
    if (mine && !s.plan) {
      s.plan = mine;
      void tick();
    }
    draw();
  }

  /** Quotes every step from real numbers and joins them, so the review shows the whole trade and every fee before anything starts. */
  async function reviewTrade(): Promise<void> {
    s.error = null;
    s.review = null;
    const fromAddr = (s.fromToken === 'custom' ? s.fromCustom : s.fromToken).trim();
    const toAddr = s.toToken.trim();
    const sender = walletFor(s.fromChain);
    const receiver = walletFor(s.toChain);
    if (!sender) return void (s.error = `Connect a ${CHAINS[s.fromChain].kind === 'solana' ? 'Solana' : 'Ethereum-style'} wallet for ${CHAINS[s.fromChain].name} first.`);
    if (!receiver) return void (s.error = `Connect a ${CHAINS[s.toChain].kind === 'solana' ? 'Solana' : 'Ethereum-style'} wallet to receive on ${CHAINS[s.toChain].name}. The token arrives in your own account there.`);
    if (!fromAddr || !toAddr) return void (s.error = 'Choose what you pay with and paste the address of the token you want.');
    s.busy = true;
    draw();
    try {
      const [from, to] = await Promise.all([tokenFacts(s.fromChain, fromAddr), tokenFacts(s.toChain, toAddr)]);
      if (!from) throw new SwingsError('invalid', `That address is not a token Aretia can read on ${CHAINS[s.fromChain].name}.`);
      if (!to) throw new SwingsError('invalid', `That address is not a token Aretia can read on ${CHAINS[s.toChain].name}.`);
      const amount = parseUnits(s.amount, from.decimals);
      if (amount === null) throw new SwingsError('invalid', `Enter an amount of ${from.symbol} (up to ${from.decimals} decimal places).`);
      const problems = journeyProblems({ ...from, amount }, to, usdc, isEnabled);
      if (problems.length) throw new SwingsError('invalid', problems.join(' '));
      const have = await balanceOf(from.chain, sender, assetKeyOf(from.chain, from.address));
      if (have === null) throw new SwingsError('provider-failed', 'Your balance could not be read, so the trade was not priced. Try again shortly.');
      if (have < amount) throw new SwingsError('invalid', `You hold ${formatUnits(have, from.decimals)} ${from.symbol} on ${CHAINS[from.chain].name}, less than that.`);

      const usdcFrom = usdc(from.chain)!;
      const usdcTo = usdc(to.chain)!;
      const usdcMeta = { symbol: 'USDC', decimals: 6 };
      let first: ExecutionLeg | null = null;
      let available = amount;
      if (assetKeyOf(from.chain, from.address) !== assetKeyOf(from.chain, usdcFrom)) {
        const search = await router.findRoutes({ chain: from.chain, from: { chain: from.chain, address: from.address }, to: { chain: from.chain, address: usdcFrom }, amountIn: amount, slippageBps: SLIPPAGE_BPS, account: { chain: from.chain, address: sender } });
        const best = search.routes[0];
        if (!best) throw new SwingsError('no-route', `No route swaps ${from.symbol} into USDC on ${CHAINS[from.chain].name} right now. ${search.failures.map((f) => f.message).join(' ')}`.trim());
        first = legFromSwap(best, from, usdcMeta);
        available = best.minOut;
      }
      const capProblem = journeyCapProblem(available);
      if (capProblem) throw new SwingsError('invalid', capProblem);

      // The move, priced now from the worst case of the first step, with its fees fitting inside it (it is priced again for real when the USDC is there).
      const intent = (n: bigint) => ({ sourceChain: from.chain, sourceAsset: { chain: from.chain, address: usdcFrom }, sourceAmount: n, destinationChain: to.chain, destinationAsset: { chain: to.chain, address: usdcTo }, sender, recipient: receiver });
      let n = moveAmountWithin(available);
      let moveQ: SettlementQuote | undefined;
      for (let i = 0; i < 4 && n !== null && n > 0n; i++) {
        const search = await engine.quote(intent(n), 'balanced');
        moveQ = search.quotes[0];
        if (!moveQ) throw new SwingsError('no-route', `There is no way to move USDC from ${CHAINS[from.chain].name} to ${CHAINS[to.chain].name} right now. ${search.declined.map((d) => d.reason).join(' ')}`.trim());
        const total = moveQ.sourceTotal ?? moveQ.sourceAmount;
        if (total <= available) break;
        n = moveQ.sourceAmount - (total - available);
        moveQ = undefined;
      }
      if (!moveQ) throw new SwingsError('invalid', 'The amount is too small to cover the move\'s fees.');
      const move = legFromSettlement(moveQ);

      let last: ExecutionLeg | null = null;
      if (assetKeyOf(to.chain, to.address) !== assetKeyOf(to.chain, usdcTo)) {
        const search = await router.findRoutes({ chain: to.chain, from: { chain: to.chain, address: usdcTo }, to: { chain: to.chain, address: to.address }, amountIn: moveQ.destinationAmount, slippageBps: SLIPPAGE_BPS, account: { chain: to.chain, address: receiver } });
        const best = search.routes[0];
        if (!best) throw new SwingsError('no-route', `No route swaps USDC into ${to.symbol} on ${CHAINS[to.chain].name} right now. ${search.failures.map((f) => f.message).join(' ')}`.trim());
        last = legFromSwap(best, usdcMeta, to);
      }
      // The steps after the first are priced again when their turn comes, from what really arrived: the plan keeps their shape and these estimates.
      const later = (l: ExecutionLeg): ExecutionLeg => ({ ...l, expiresAt: Number.MAX_SAFE_INTEGER, notes: [...l.notes, 'Priced again when the step before has finished, from what really arrived.'] });
      const quote = journeyQuote(`journey-${Date.now()}`, { first, move: first ? later(move) : move, last: last ? later(last) : null }, amount);
      const risk = await assessTokenSafety(to.chain, to.address).catch(() => null);
      s.review = { quote, fees: journeyFeeSchedule(from, to, usdc), safety: assetKeyOf(to.chain, to.address) === assetKeyOf(to.chain, usdcTo) ? null : describeSafety(risk), from, to };
    } catch (e) {
      s.error = message(e, 'The trade could not be priced. Nothing was sent.');
    } finally {
      s.busy = false;
    }
  }

  async function start(): Promise<void> {
    const r = s.review;
    if (!r) return;
    s.error = null;
    s.busy = true;
    draw();
    try {
      const sender = walletFor(r.from.chain);
      if (!(await isCanaryAllowed(sender))) throw new SwingsError('not-enabled', 'Cross-chain trading is limited to a first group of wallets while it is being proven. This wallet is not in that group yet.');
      await adoptWallet();
      const created = await runner.create(r.quote);
      s.plan = await runner.step(created.id);
      s.review = null;
    } catch (e) {
      s.error = message(e, 'The trade could not be started. Nothing was sent.');
    } finally {
      s.busy = false;
      draw();
      void tick();
    }
  }

  /** Checks the plan again. Only a step already in flight is checked on a timer; anything that signs waits for a press. */
  async function tick(): Promise<void> {
    if (timer !== null) window.clearTimeout(timer);
    timer = null;
    if (!s.plan || isPlanFinal(s.plan.state)) return;
    try {
      s.plan = await runner.step(s.plan.id);
    } catch {
      // A busy or unreachable check changes nothing; the next one tries again.
    }
    draw();
    const cur = s.plan?.legs.find((l) => l.status !== 'done');
    if (s.plan && !isPlanFinal(s.plan.state) && cur && (cur.status === 'active' || (cur.kind === 'settlement' && cur.ref.executionId))) timer = window.setTimeout(() => void tick(), 15_000);
  }

  async function act(work: () => Promise<unknown>): Promise<void> {
    s.error = null;
    s.notice = null;
    s.busy = true;
    draw();
    try {
      await adoptWallet();
      await work();
    } catch (e) {
      s.error = message(e, 'That did not work. Nothing was assumed: check your wallet.');
    } finally {
      s.busy = false;
    }
    await tick();
  }

  function select(label: string, options: { value: string; label: string }[], value: string, on: (v: string) => void): HTMLElement {
    const sel = el('select', { class: 'wapp__input', attrs: { 'aria-label': label } });
    for (const o of options) sel.append(el('option', { text: o.label, attrs: { value: o.value, ...(o.value === value ? { selected: '' } : {}) } }));
    sel.addEventListener('change', () => on(sel.value));
    return el('label', { class: 'wapp__field' }, [el('span', { class: 'wapp__eyebrow', text: label }), sel]);
  }
  function input(label: string, value: string, placeholder: string, on: (v: string) => void): HTMLElement {
    const i = el('input', { class: 'wapp__input', attrs: { placeholder, autocomplete: 'off', spellcheck: 'false', 'aria-label': label, value } });
    i.addEventListener('input', () => on(i.value));
    return el('label', { class: 'wapp__field' }, [el('span', { class: 'wapp__eyebrow', text: label }), i]);
  }
  const chainOptions = CROSS_CHAIN_TRADE_CHAINS.map((c) => ({ value: c, label: CHAINS[c].name }));

  function swapReviewCard(r: NonNullable<typeof pendingReview>): HTMLElement {
    const card = el('div', { class: 'wapp__card' });
    const t = r.trade;
    const chain = r.leg.input.chain!;
    card.append(
      el('h2', { class: 'wapp__h2', text: `Review: swap ${r.leg.input.symbol} for ${r.leg.output.symbol} on ${CHAINS[chain].name}` }),
      el('ul', { class: 'wapp__list' }, [
        el('li', { text: `You pay: ${formatUnits(t.amountIn, r.leg.input.decimals)} ${r.leg.input.symbol}` }),
        el('li', { text: `Expected: ${formatUnits(t.expectedOut, r.leg.output.decimals)} ${r.leg.output.symbol}` }),
        el('li', { text: `At least: ${formatUnits(t.minOut, r.leg.output.decimals)} ${r.leg.output.symbol} (the swap is refused on chain below this)` }),
        el('li', { text: `Network fee: ${t.networkFee === null ? 'not estimated' : `${formatUnits(t.networkFee, CHAINS[chain].nativeDecimals)} ${CHAINS[chain].nativeSymbol}`}` }),
      ]),
    );
    for (const w of t.warnings) card.append(banner('info', w));
    card.append(el('p', { class: 'wapp__fine', text: 'The swap was simulated and passed its checks. Your wallet shows the transaction before you sign it.' }));
    const row = el('div', { class: 'wapp__row-actions' });
    const yes = el('button', { class: 'wapp__btn wapp__btn--primary', text: 'Sign in my wallet', attrs: { type: 'button' } });
    const no = el('button', { class: 'wapp__btn wapp__btn--ghost', text: 'Cancel', attrs: { type: 'button' } });
    const answer = (v: boolean): void => {
      pendingReview = null;
      r.answer(v);
      draw();
    };
    yes.addEventListener('click', () => answer(true));
    no.addEventListener('click', () => answer(false));
    row.append(yes, no);
    card.append(row);
    return card;
  }

  function planView(p: PlanRecord): HTMLElement {
    const card = el('div', { class: 'wapp__card' });
    const tone = p.state === 'COMPLETED' ? 'ok' : p.state === 'FAILED' ? 'warn' : 'info';
    const stopped = p.state === 'FAILED' && p.failure?.legIndex === null;
    card.append(el('h2', { class: 'wapp__h2', text: 'Your cross-chain trade' }), banner(tone, p.state === 'COMPLETED' ? 'Every step is done and proven by your balance.' : stopped ? `Stopped by you. ${p.failure?.reason ?? ''}` : p.state === 'FAILED' ? `The trade stopped: ${p.failure?.reason ?? 'it failed'}` : p.state === 'CANCELLED' ? 'Cancelled. Nothing was sent.' : p.state === 'EXPIRED' ? 'The prices expired before anything began. Nothing was sent.' : 'One step at a time. Each step waits for you.'));
    const list = el('ol', { class: 'wapp__list' });
    for (const l of p.legs) {
      const t = p.quote.legs[l.index]!;
      const item = el('li', {}, [el('strong', { text: `${t.title}: ` }), el('span', { text: l.status.replace('-', ' ') })]);
      if (l.instruction && l.status !== 'done') item.append(el('br'), el('span', { class: 'wapp__fine', text: l.instruction }));
      if (l.kind === 'swap' && swap.canRun(p, l) && !pendingReview) {
        const b = el('button', { class: 'wapp__btn wapp__btn--primary', text: s.busy ? 'Preparing…' : 'Review the swap', attrs: { type: 'button' } });
        b.disabled = s.busy;
        b.addEventListener('click', () => void act(async () => {
          const r = await swap.run(p, l);
          if (r === 'declined') s.notice = 'Nothing was sent. You can review the swap again, or stop here and keep what you hold.';
          if (r === 'not-sent') s.notice = 'Your wallet did not send this. Nothing was spent; you can try again.';
        }));
        item.append(el('br'), b);
      }
      if (l.kind === 'settlement' && l.status === 'waiting-user' && !l.ref.executionId && !isPlanFinal(p.state) && p.legs.every((x) => x.index >= l.index || x.status === 'done')) {
        const b = el('button', { class: 'wapp__btn wapp__btn--primary', text: s.busy ? 'Checking…' : 'Start the USDC move', attrs: { type: 'button' } });
        b.disabled = s.busy;
        b.addEventListener('click', () => void act(async () => {
          settle.arm(p, l);
          s.plan = await runner.step(p.id);
        }));
        item.append(el('br'), b);
      }
      if (l.status === 'waiting-user' && l.kind === 'settlement' && l.ref.executionId && /Claim/.test(l.instruction ?? '')) {
        const b = el('button', { class: 'wapp__btn wapp__btn--primary', text: `Claim on ${CHAINS[t.output.chain!].name}`, attrs: { type: 'button' } });
        b.disabled = s.busy;
        b.addEventListener('click', () => void act(() => settle.claim(l)));
        item.append(el('br'), b);
      }
      for (const r of l.ref.references ?? []) if (r.startsWith('tx:')) item.append(el('br'), el('span', { class: 'wapp__fine', text: `Transaction: ${r.slice(3)}` }));
      list.append(item);
    }
    card.append(list);
    for (const a of triage(diagnosePlan(p, Date.now()))) card.append(banner(a.severity === 'urgent' ? 'warn' : 'info', `${a.problem} Your funds: ${a.fundsAt}${a.neverDo.length ? ' ' + a.neverDo.join(' ') : ''}`));
    if (s.notice) card.append(banner('info', s.notice));
    const row = el('div', { class: 'wapp__row-actions' });
    if (!isPlanFinal(p.state)) {
      const check = el('button', { class: 'wapp__btn wapp__btn--ghost', text: s.busy ? 'Checking…' : 'Check now', attrs: { type: 'button' } });
      check.disabled = s.busy;
      check.addEventListener('click', () => void act(async () => undefined));
      row.append(check);
    }
    if (!isPlanFinal(p.state) && (canStopHere(p) || !hasBegun(p))) {
      const here = whereHeld(p);
      const stop = el('button', { class: 'wapp__btn wapp__btn--ghost', text: hasBegun(p) ? `Stop here and keep my ${here}` : 'Cancel', attrs: { type: 'button' } });
      stop.disabled = s.busy;
      stop.addEventListener('click', () => {
        if (!window.confirm(hasBegun(p) ? `Stop the trade here? Your ${here} stays in your own wallet and nothing more is sent. You can swap it yourself later.` : 'Cancel this trade? Nothing has been sent.')) return;
        void act(async () => {
          s.plan = await runner.stopHere(p.id);
        });
      });
      row.append(stop);
    }
    if (isPlanFinal(p.state)) {
      const again = el('button', { class: 'wapp__btn wapp__btn--ghost', text: 'Start another trade', attrs: { type: 'button' } });
      again.addEventListener('click', () => {
        s.plan = null;
        s.notice = null;
        draw();
      });
      row.append(again);
    }
    card.append(row);
    if (s.error) card.append(banner('warn', s.error));
    return card;
  }

  /** What the user holds at this point of the plan, for the "stop here" button. */
  function whereHeld(p: PlanRecord): string {
    let last = -1;
    for (const l of p.legs) {
      if (l.status === 'done') last = l.index;
      else break;
    }
    const line = last >= 0 ? p.quote.legs[last]!.output : p.quote.spend;
    return `${line.symbol}${line.chain ? ` on ${CHAINS[line.chain].name}` : ''}`;
  }

  function reviewView(r: NonNullable<typeof s.review>): HTMLElement {
    const card = el('div', { class: 'wapp__card' });
    card.append(el('h2', { class: 'wapp__h2', text: 'Review the trade' }));
    const steps = el('ol', { class: 'wapp__list' });
    for (const l of r.quote.legs) steps.append(el('li', { text: l.title }));
    card.append(steps);
    card.append(banner('info', r.fees.summary));
    const fees = el('ul', { class: 'wapp__list' });
    for (const f of r.fees.lines) fees.append(el('li', { text: `${f.step}: ${f.rate === 'none' ? 'no Aretia fee' : `Aretia fee ${f.rate}`}. ${f.why}` }));
    card.append(fees);
    const lines = el('ul', { class: 'wapp__list' });
    for (const d of disclose(r.quote)) lines.append(el('li', { text: `${d.label}: ${d.value}` }));
    card.append(lines);
    if (r.safety) {
      card.append(banner(r.safety.tone === 'ok' ? 'info' : 'warn', `${r.to.symbol}: ${r.safety.headline}`));
      for (const c of r.safety.concerns) card.append(el('p', { class: 'wapp__fine', text: c.text }));
    }
    for (const w of r.quote.warnings) card.append(banner('info', w));
    card.append(el('p', { class: 'wapp__fine', text: `Time: about ${r.quote.totalSeconds === null ? 'a few minutes, depending on the networks' : durationText(r.quote.totalSeconds)}. Your wallet signs about ${r.quote.signatures} times, one step at a time, and each step starts only when you press its button. Network fees are paid in each network's own coin, so you need a little of it on both networks. One trade may move at most ${formatUnits(MOVE_CAP_RAW, 6)} USDC while this is new.` }));
    card.append(el('p', { class: 'wapp__fine', text: 'The later steps are priced again from what really arrives. If you stop part way, what you hold at that point (for example the USDC) stays in your own wallet. Cross-chain trading is new: no real trade across networks has been run through it yet, and the swap router is not yet independently audited.' }));
    const go = el('button', { class: 'wapp__btn wapp__btn--primary', text: s.busy ? 'Working…' : 'Start the trade', attrs: { type: 'button' } });
    go.disabled = s.busy;
    go.addEventListener('click', () => void start());
    card.append(go);
    return card;
  }

  function draw(): void {
    root.replaceChildren();
    if (!s.loaded) {
      void load();
      root.append(el('p', { class: 'wapp__fine', text: 'Loading…' }));
      return;
    }
    if (pendingReview) root.append(swapReviewCard(pendingReview));
    if (s.plan) return void root.append(planView(s.plan));
    const card = el('div', { class: 'wapp__card' });
    card.append(el('h2', { class: 'wapp__h2', text: 'Buy on another network' }), el('p', { class: 'wapp__fine', text: 'Pay with a token on one network and receive a token on another. Aretia swaps into USDC, moves it with Circle, and swaps it into the token you want. Your wallet signs every step and Aretia never holds your money.' }));
    const fromChoices = [{ value: native(s.fromChain), label: CHAINS[s.fromChain].nativeSymbol }, { value: usdc(s.fromChain)!, label: 'USDC' }, { value: 'custom', label: 'Another token (paste its address)' }];
    card.append(
      select('Pay from', chainOptions, s.fromChain, (v) => { s.fromChain = v as ChainId; s.fromToken = native(s.fromChain); s.review = null; draw(); }),
      select('Pay with', fromChoices, s.fromToken, (v) => { s.fromToken = v; s.review = null; draw(); }),
    );
    if (s.fromToken === 'custom') card.append(input('Token address', s.fromCustom, CHAINS[s.fromChain].kind === 'solana' ? 'Mint address' : '0x…', (v) => { s.fromCustom = v; s.review = null; }));
    card.append(input('Amount', s.amount, '0.0', (v) => { s.amount = v; s.review = null; }));
    card.append(
      select('Buy on', chainOptions.filter((o) => o.value !== s.fromChain), s.toChain, (v) => { s.toChain = v as ChainId; s.review = null; draw(); }),
      input('Token to buy (address)', s.toToken, CHAINS[s.toChain].kind === 'solana' ? 'Mint address' : '0x…', (v) => { s.toToken = v; s.review = null; }),
    );
    if (s.fromChain === s.toChain) s.toChain = CROSS_CHAIN_TRADE_CHAINS.find((c) => c !== s.fromChain)!;
    // The fees, before anything is priced. For a pasted token they depend on what it is, so they are shown in the review.
    if (s.fromToken !== 'custom') {
      const pay: TradeToken = { chain: s.fromChain, address: s.fromToken, symbol: fromChoices.find((o) => o.value === s.fromToken)?.label ?? '', decimals: 0 };
      card.append(el('p', { class: 'wapp__fine', text: journeyFeeSchedule(pay, { chain: s.toChain, address: 'the-token-you-buy', symbol: 'the token', decimals: 0 }, usdc).summary }));
    } else card.append(el('p', { class: 'wapp__fine', text: "Aretia's fees are the same as doing each step yourself; the review lists each one before you start." }));
    const missing = [s.fromChain, s.toChain].filter((c) => !walletFor(c)).map((c) => `${CHAINS[c].kind === 'solana' ? 'a Solana' : 'an Ethereum-style'} wallet for ${CHAINS[c].name}`);
    if (missing.length) card.append(banner('info', `Connect ${[...new Set(missing)].join(' and ')} with the Connect wallet button at the top of the page.`));
    const review = el('button', { class: 'wapp__btn wapp__btn--primary', text: s.busy ? 'Pricing every step…' : 'Review the trade', attrs: { type: 'button' } });
    review.disabled = s.busy || missing.length > 0;
    review.addEventListener('click', () => void reviewTrade().then(draw));
    card.append(review);
    if (s.error) card.append(banner('warn', s.error));
    root.append(card);
    if (s.review) root.append(reviewView(s.review));
  }

  /** Opens the screen with the token to buy already filled in (from a token page). */
  function prefill(chain: ChainId, address: string): void {
    if (!CROSS_CHAIN_TRADE_CHAINS.includes(chain) || s.plan) return;
    s.toChain = chain;
    s.toToken = address;
    if (s.fromChain === chain) s.fromChain = CROSS_CHAIN_TRADE_CHAINS.find((c) => c !== chain)!;
    s.fromToken = native(s.fromChain);
    s.review = null;
    draw();
  }

  return { draw, prefill };
}
