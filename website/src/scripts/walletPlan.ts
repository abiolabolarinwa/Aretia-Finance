/**
 * The "Plan" tab: buy USDC with a bank or card and have it end up on the network you want, as one guided journey.
 *
 *   step 1  buy USDC on a network where the provider sells it (you pay on the provider's page)
 *   step 2  if you want it elsewhere, move it with Circle (priced and checked again when the money has arrived)
 *
 * It uses the same plan runner, executors, safety checks and recovery advice as everything else. Each step starts only
 * when the one before is proven by your own balance, and anything it cannot verify makes it wait, not guess.
 */
import { CHAINS, EVM_NATIVE_ADDRESS, SwingsError, type ChainId } from '../swings/core/types.js';
import { readBalance } from '../swings/chains/evmSession.js';
import { CCTP_USDC } from '../swings/settlement/cctp.js';
import { assessSettlement } from '../swings/settlement/safety.js';
import { isCanaryAllowed } from '../swings/runtime.js';
import { MoonPayRampProvider, type RampApiCatalog } from '../swings/ramp/moonpay.js';
import { RampRouter } from '../swings/ramp/router.js';
import type { RampQuote } from '../swings/ramp/types.js';
import { combineLegs, legFromRamp, pendingSettlementLeg, type ExecutionQuote } from '../swings/plan/executionQuote.js';
import { PlanRunner } from '../swings/plan/runner.js';
import { BalanceLegExecutor, SettlementLegExecutor } from '../swings/plan/executors.js';
import { DeferredSettlementExecutor } from '../swings/plan/deferred.js';
import { JsonVersionedStore } from '../swings/plan/store.js';
import { isPlanFinal, type PlanRecord } from '../swings/plan/state.js';
import { diagnosePlan, triage } from '../swings/plan/recovery.js';
import { disclose } from '../swings/economics/act.js';
import { formatUnits, durationText } from '../swings/crosschain/view.js';
import type { SettlementQuote } from '../swings/settlement/types.js';
import { MOVE_CAP_RAW } from './walletCrossChain.js';
import type { CrossChainRuntime } from './crossChainRuntime.js';

const COUNTRY_KEY = 'aretia-swings-country';
const EVM_RAMP_CHAINS: ChainId[] = ['ethereum', 'base', 'arbitrum', 'optimism', 'polygon', 'avalanche'];

function el<K extends keyof HTMLElementTagNameMap>(tag: K, props: { class?: string; text?: string; attrs?: Record<string, string> } = {}, children: (Node | null | false)[] = []): HTMLElementTagNameMap[K] {
  const n = document.createElement(tag);
  if (props.class) n.className = props.class;
  if (props.text !== undefined) n.textContent = props.text;
  for (const [k, v] of Object.entries(props.attrs ?? {})) n.setAttribute(k, v);
  for (const c of children) if (c) n.append(c);
  return n;
}
const banner = (kind: 'warn' | 'info' | 'ok', text: string): HTMLElement => el('p', { class: `wapp__banner wapp__banner--${kind}`, text });
const loadCountry = (): string => {
  try {
    return window.localStorage.getItem(COUNTRY_KEY) ?? '';
  } catch {
    return '';
  }
};

const saveCountry = (v: string): void => {
  try {
    window.localStorage.setItem(COUNTRY_KEY, v);
  } catch {
    // a convenience only
  }
};

export function initPlan(root: HTMLElement, rt: CrossChainRuntime): { draw(): void } {
  const { evm, isEnabled, reader, engine, orchestrator, adoptWallet } = rt;
  const api = async (body: Record<string, unknown>): Promise<unknown> => {
    const res = await fetch('/api/ramp', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    const data = (await res.json().catch(() => null)) as { error?: string } | null;
    if (!res.ok || !data) throw new Error(data?.error ?? `The service answered ${res.status}`);
    return data;
  };
  const moonpay = new MoonPayRampProvider({ api });
  const rampRouter = new RampRouter([moonpay]);

  const balanceOf = async (chain: ChainId, wallet: string, assetKey: string): Promise<bigint | null> => {
    try {
      return await readBalance(reader(chain), wallet, assetKey);
    } catch {
      return null;
    }
  };
  const walletFor = (chain: ChainId): string | null => (CHAINS[chain].kind === 'evm' ? evm.account : null);

  const quotes = new Map<string, SettlementQuote>();
  const inner = new SettlementLegExecutor({ orchestrator, quoteFor: (id) => quotes.get(id) ?? null });
  const deferred = new DeferredSettlementExecutor({
    inner,
    quotes,
    engine,
    balanceOf,
    walletFor,
    usdc: (c) => CCTP_USDC[c] ?? null,
    assess: async (q) => {
      const i = q.intent;
      const [native, existing, src] = await Promise.all([balanceOf(i.destinationChain, i.recipient, EVM_NATIVE_ADDRESS), rt.store.list(), balanceOf(i.sourceChain, i.sender, i.sourceAsset.address)]);
      return assessSettlement(q, { now: Date.now(), provider: rt.providers.find((p) => p.id === q.providerId) ?? null, enabledChains: EVM_RAMP_CHAINS.filter(isEnabled), sourceBalance: src, destinationNativeBalance: native, existing, maxAmount: MOVE_CAP_RAW });
    },
    acknowledge: async (cs) => window.confirm(`${cs.join('\n\n')}\n\nContinue anyway?`),
  });
  const balanceExec = new BalanceLegExecutor({
    balanceOf,
    walletFor,
    instruction: (_p, leg) => (leg.kind === 'ramp-buy' ? 'Pay on the provider\'s page. Aretia moves on when your USDC arrives in your wallet.' : 'Complete this step, then Aretia moves on when your balance shows it.'),
  });
  const planStore = new JsonVersionedStore<PlanRecord>(window.localStorage, 'aretia-swings-plans', (v): v is PlanRecord => typeof v === 'object' && v !== null && 'legs' in v && 'quote' in v);
  const runner = new PlanRunner({ store: planStore, executors: { 'ramp-buy': balanceExec, settlement: deferred } });

  const s = {
    avail: undefined as { catalog: RampApiCatalog; sides: string[] } | null | undefined,
    country: loadCountry(),
    fiat: 'usd',
    amount: '100',
    buyOn: 'ethereum' as ChainId,
    deliverTo: 'base' as ChainId,
    busy: false,
    error: null as string | null,
    review: null as { quote: ExecutionQuote; ramp: RampQuote } | null,
    plan: null as PlanRecord | null,
    ramp: null as RampQuote | null,
  };
  let timer: number | null = null;

  async function load(): Promise<void> {
    s.avail = await moonpay.availability();
    draw();
    const mine = (await planStore.list()).filter((p) => !isPlanFinal(p.state)).sort((a, b) => b.createdAt - a.createdAt)[0];
    if (mine && !s.plan) {
      s.plan = mine;
      draw();
      void tick();
    }
  }

  async function reviewPlan(): Promise<void> {
    s.error = null;
    s.review = null;
    const amount = /^\d+$/.test(s.amount.trim()) ? Number(s.amount.trim()) : null;
    const wallet = evm.account;
    if (!wallet) return void (s.error = 'Connect an EVM wallet first (in the Swap or Move USDC tab).');
    if (amount === null || amount < 1) return void (s.error = 'Enter a whole amount of at least 1.');
    if (!s.country) return void (s.error = 'Choose your country in the Buy & Sell tab first: availability depends on it.');
    for (const c of new Set([s.buyOn, s.deliverTo])) if (!isEnabled(c)) return void (s.error = `${CHAINS[c].name} is not switched on for Swings.`);
    s.busy = true;
    draw();
    try {
      const search = await rampRouter.quote({ side: 'buy', fiat: s.fiat, fiatAmount: amount, asset: { chain: s.buyOn, symbol: 'USDC', address: CCTP_USDC[s.buyOn]!, decimals: 6 }, wallet, country: s.country });
      const ramp = search.quotes[0];
      if (!ramp) return void (s.error = search.declined.map((d) => d.reason).concat(search.failures.map((f) => f.message)).join(' ') || 'No provider can sell that here right now.');
      const legs = [legFromRamp(ramp)];
      if (s.buyOn !== s.deliverTo) {
        const probe = await engine.quote({ sourceChain: s.buyOn, sourceAsset: { chain: s.buyOn, address: CCTP_USDC[s.buyOn]! }, sourceAmount: 100_000_000n, destinationChain: s.deliverTo, destinationAsset: { chain: s.deliverTo, address: CCTP_USDC[s.deliverTo]! }, sender: wallet, recipient: wallet }, 'balanced');
        const best = probe.quotes[0];
        if (!best) return void (s.error = `There is no way to move USDC from ${CHAINS[s.buyOn].name} to ${CHAINS[s.deliverTo].name} right now. ${probe.declined.map((d) => d.reason).join(' ')}`.trim());
        legs.push(pendingSettlementLeg(`pending-${Date.now()}`, { chain: s.buyOn, address: CCTP_USDC[s.buyOn]! }, { chain: s.deliverTo, address: CCTP_USDC[s.deliverTo]! }, best.estimatedSeconds));
      }
      s.review = { quote: combineLegs(`plan-${Date.now()}`, legs), ramp };
    } catch (e) {
      s.error = e instanceof SwingsError ? e.message : 'The plan could not be reviewed.';
    } finally {
      s.busy = false;
    }
  }

  async function start(): Promise<void> {
    if (!s.review || !evm.account) return;
    s.error = null;
    s.busy = true;
    draw();
    try {
      if (!(await isCanaryAllowed(evm.account))) throw new SwingsError('not-enabled', 'Plans are limited to a first group of wallets while they are being proven. This wallet is not in that group yet.');
      await adoptWallet();
      s.ramp = s.review.ramp;
      const created = await runner.create(s.review.quote);
      s.plan = await runner.step(created.id);
      s.review = null;
    } catch (e) {
      s.error = e instanceof SwingsError ? e.message : 'The plan could not be started.';
    } finally {
      s.busy = false;
      draw();
      void tick();
    }
  }

  async function tick(): Promise<void> {
    if (timer !== null) window.clearTimeout(timer);
    timer = null;
    if (!s.plan || isPlanFinal(s.plan.state)) return;
    try {
      await adoptWallet();
      s.plan = await runner.step(s.plan.id);
    } catch {
      // A busy or unreachable check changes nothing; the next tick tries again.
    }
    draw();
    if (s.plan && !isPlanFinal(s.plan.state)) timer = window.setTimeout(() => void tick(), 15_000);
  }

  async function act(work: () => Promise<unknown>): Promise<void> {
    s.error = null;
    s.busy = true;
    draw();
    try {
      await work();
    } catch (e) {
      s.error = e instanceof SwingsError ? e.message : 'That did not work. Nothing was assumed: check your wallet.';
    } finally {
      s.busy = false;
    }
    await tick();
  }

  async function openProvider(): Promise<void> {
    const plan = s.plan;
    if (!plan || !evm.account) return;
    const leg = plan.quote.legs[0]!;
    const chain = leg.output.chain!;
    let q = s.ramp;
    if (!q) {
      const search = await rampRouter.quote({ side: 'buy', fiat: leg.input.symbol.toLowerCase(), fiatAmount: Number(leg.input.amount ?? 0n), asset: { chain, symbol: 'USDC', address: CCTP_USDC[chain]!, decimals: 6 }, wallet: evm.account, country: s.country });
      q = search.quotes[0] ?? null;
    }
    if (!q) throw new SwingsError('no-route', 'The provider is not available right now.');
    const session = await moonpay.createSession(q);
    window.open(session.url, '_blank', 'noopener,noreferrer');
  }

  function select(label: string, options: { value: string; label: string }[], value: string, on: (v: string) => void): HTMLElement {
    const sel = el('select', { class: 'wapp__input', attrs: { 'aria-label': label } });
    for (const o of options) sel.append(el('option', { text: o.label, attrs: { value: o.value, ...(o.value === value ? { selected: '' } : {}) } }));
    sel.addEventListener('change', () => on(sel.value));
    return el('label', { class: 'wapp__field' }, [el('span', { class: 'wapp__eyebrow', text: label }), sel]);
  }

  function planView(p: PlanRecord): HTMLElement {
    const card = el('div', { class: 'wapp__card' });
    const tone = p.state === 'COMPLETED' ? 'ok' : p.state === 'FAILED' ? 'warn' : 'info';
    card.append(el('h2', { class: 'wapp__h2', text: 'Your plan' }), banner(tone, p.state === 'COMPLETED' ? 'Every step is done and proven by your balance.' : p.state === 'FAILED' ? `The plan stopped: ${p.failure?.reason ?? 'it failed'}` : p.state === 'WAITING_USER' ? 'Waiting for you.' : 'In progress.'));
    const list = el('ol', { class: 'wapp__list' });
    for (const l of p.legs) {
      const t = p.quote.legs[l.index]!;
      const item = el('li', {}, [el('strong', { text: `${t.title}: ` }), el('span', { text: l.status.replace('-', ' ') })]);
      if (l.instruction && l.status !== 'done') item.append(el('br'), el('span', { class: 'wapp__fine', text: l.instruction }));
      if (l.status === 'waiting-user' && l.kind === 'ramp-buy') {
        const b = el('button', { class: 'wapp__btn wapp__btn--primary', text: 'Open the provider', attrs: { type: 'button' } });
        b.addEventListener('click', () => void act(openProvider));
        item.append(el('br'), b);
      }
      if (l.status === 'waiting-user' && l.kind === 'settlement' && l.ref.executionId && /Claim/.test(l.instruction ?? '')) {
        const b = el('button', { class: 'wapp__btn wapp__btn--primary', text: `Claim on ${CHAINS[t.output.chain!].name}`, attrs: { type: 'button' } });
        b.disabled = s.busy;
        b.addEventListener('click', () => void act(() => deferred.claim(l)));
        item.append(el('br'), b);
      }
      list.append(item);
    }
    card.append(list);
    const advice = triage(diagnosePlan(p, Date.now()));
    for (const a of advice) card.append(banner(a.severity === 'urgent' ? 'warn' : 'info', `${a.problem} Your funds: ${a.fundsAt}${a.neverDo.length ? ' ' + a.neverDo.join(' ') : ''}`));
    const row = el('div', { class: 'wapp__row-actions' });
    const check = el('button', { class: 'wapp__btn wapp__btn--ghost', text: s.busy ? 'Checking…' : 'Check now', attrs: { type: 'button' } });
    check.disabled = s.busy;
    check.addEventListener('click', () => void act(async () => undefined));
    row.append(check);
    if (isPlanFinal(p.state)) {
      const done = el('button', { class: 'wapp__btn wapp__btn--ghost', text: 'Plan another', attrs: { type: 'button' } });
      done.addEventListener('click', () => { s.plan = null; s.ramp = null; draw(); });
      row.append(done);
    }
    card.append(row);
    if (s.error) card.append(banner('warn', s.error));
    return card;
  }

  function reviewView(r: { quote: ExecutionQuote; ramp: RampQuote }): HTMLElement {
    const card = el('div', { class: 'wapp__card' });
    card.append(el('h2', { class: 'wapp__h2', text: 'Review the plan' }));
    const steps = el('ol', { class: 'wapp__list' });
    for (const l of r.quote.legs) steps.append(el('li', { text: l.title }));
    card.append(steps);
    const lines = el('ul', { class: 'wapp__list' });
    for (const d of disclose(r.quote)) lines.append(el('li', { text: `${d.label}: ${d.value}` }));
    card.append(lines);
    for (const w of r.quote.warnings) card.append(banner('info', w));
    card.append(el('p', { class: 'wapp__fine', text: `Time: ${r.quote.totalSeconds === null ? 'depends on the provider' : durationText(r.quote.totalSeconds)}. Signatures from you: about ${r.quote.signatures}. Network fees are paid in each network's own coin.${r.quote.legs.length > 1 ? ` The move is capped at ${formatUnits(MOVE_CAP_RAW, 6)} USDC while Swings is being proven.` : ''}` }));
    for (const n of r.quote.legs.flatMap((l) => l.notes)) card.append(el('p', { class: 'wapp__fine', text: n }));
    const go = el('button', { class: 'wapp__btn wapp__btn--primary', text: s.busy ? 'Working…' : 'Start the plan', attrs: { type: 'button' } });
    go.disabled = s.busy;
    go.addEventListener('click', () => void start());
    card.append(go);
    return card;
  }

  function draw(): void {
    root.replaceChildren();
    if (s.plan) return void root.append(planView(s.plan));
    const card = el('div', { class: 'wapp__card' });
    card.append(el('h2', { class: 'wapp__h2', text: 'Plan a journey' }), el('p', { class: 'wapp__fine', text: 'Buy USDC with your bank or card and have it end up on the network you want. Each step starts only when the one before is proven by your own wallet balance. If anything cannot be verified, the plan waits and your money stays where it is.' }));
    if (s.avail === undefined) {
      void load();
      card.append(el('p', { class: 'wapp__fine', text: 'Checking what is available…' }));
      return void root.append(card);
    }
    if (s.avail === null || !s.avail.sides.includes('buy')) {
      card.append(banner('warn', 'Buying is not switched on, or could not be reached right now. Nothing is offered until it is confirmed.'));
      return void root.append(card);
    }
    const chains = EVM_RAMP_CHAINS.filter((c) => s.avail!.catalog.tokens.some((t) => t.chain === c && t.symbol === 'USDC'));
    if (!chains.includes(s.buyOn)) s.buyOn = chains[0] ?? 'ethereum';
    const countries = s.avail.catalog.countries.filter((c) => c.buy);
    card.append(
      select('Country', [{ value: '', label: 'Choose…' }, ...countries.map((c) => ({ value: c.code, label: c.name }))], s.country, (v) => { s.country = v; saveCountry(v); s.review = null; draw(); }),
      select('Currency', s.avail.catalog.fiats.map((f) => ({ value: f, label: f.toUpperCase() })), s.fiat, (v) => { s.fiat = v; s.review = null; draw(); }),
      select('Buy USDC on', chains.map((c) => ({ value: c, label: CHAINS[c].name })), s.buyOn, (v) => { s.buyOn = v as ChainId; s.review = null; draw(); }),
      select('End up on', EVM_RAMP_CHAINS.map((c) => ({ value: c, label: CHAINS[c].name })), s.deliverTo, (v) => { s.deliverTo = v as ChainId; s.review = null; draw(); }),
    );
    const amount = el('input', { class: 'wapp__swap-amount', attrs: { inputmode: 'numeric', placeholder: '100', autocomplete: 'off', 'aria-label': 'Amount in your currency', value: s.amount } });
    amount.addEventListener('input', () => { s.amount = amount.value; });
    card.append(el('label', { class: 'wapp__field' }, [el('span', { class: 'wapp__eyebrow', text: `Amount in ${s.fiat.toUpperCase()}` }), amount]));
    card.append(el('p', { class: 'wapp__fine', text: evm.account ? `Everything is for ${evm.account.slice(0, 6)}…${evm.account.slice(-4)}, on both networks.` : 'Connect an EVM wallet in the Swap or Move USDC tab to continue.' }));
    const b = el('button', { class: 'wapp__btn wapp__btn--primary', text: s.busy ? 'Checking…' : 'Review the plan', attrs: { type: 'button' } });
    b.disabled = s.busy;
    b.addEventListener('click', () => void reviewPlan().then(draw));
    card.append(b);
    if (s.error) card.append(banner('warn', s.error));
    root.append(card);
    if (s.review) root.append(reviewView(s.review));
  }

  return { draw };
}
