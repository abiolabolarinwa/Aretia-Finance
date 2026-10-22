/**
 * The "Limit orders" card for Ethereum-style chains: buy or sell an Aretia Launch token only at a price the person sets. This file only draws
 * the card and connects it to the wallet the page already uses; the rules are in walletOrdersEvmCore.ts, the transactions and their check in
 * walletOrdersEvmTx.ts and the order of events in walletOrdersEvmFlow.ts.
 *
 * It is off by default: walletLaunchEvm.ts only creates it on a build with PUBLIC_ORDERS_EVM_ENABLED=1, and it shows a notice and no form for
 * any network that has no deployed contract in EVM_ORDERS_ADDRESSES (none has). Everything typed, and everything read from the chain, is
 * shown with textContent, never as markup. The card lists the connected account's own orders and nobody else's.
 */
import type { EvmWalletAdapter } from '../swings/chains/evmWallet.js';
import type { EvmRead } from '../swings/chains/evmSession.js';
import { fromSmallestUnit } from './walletTools';
import { chainByKey, type LaunchEvmChainKey } from './walletLaunchEvmCore';
import { friendlyEvmError } from './walletLaunchEvmFlow';
import { DEFAULT_EVM_ORDER_FORM, evmOrdersChain, type EvmOrderForm, type EvmOrderIssue, type EvmOrdersChain } from './walletOrdersEvmCore';
import { EvmOrdersError, EvmOrdersFlow, type EvmCancelReview, type EvmOrderRow, type EvmOrdersOutcome, type EvmOrdersProgress, type EvmPlaceReview } from './walletOrdersEvmFlow';

export interface OrdersEvmHost {
  getAccount(): string | null;
  connect(): Promise<{ adapter: EvmWalletAdapter }>;
  readerFor(chain: LaunchEvmChainKey): EvmRead;
}

const h = <K extends keyof HTMLElementTagNameMap>(tag: K, cls = '', text?: string): HTMLElementTagNameMap[K] => {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text !== undefined) n.textContent = text;
  return n;
};
const grouped = (text: string): string => text.replace(/^(\d+)/, (whole) => whole.replace(/\B(?=(\d{3})+(?!\d))/g, ','));
const short = (a: string): string => `${a.slice(0, 6)}…${a.slice(-4)}`;
const coinText = (wei: bigint, symbol: string): string => `${fromSmallestUnit(wei, 18)} ${symbol}`;

const STEPS: { id: EvmOrdersProgress; label: string }[] = [
  { id: 'checking', label: 'Checking everything once more' },
  { id: 'proving', label: 'Waiting for you to approve the one-time proof in your wallet' },
  { id: 'confirming-proof', label: 'Confirming the proof' },
  { id: 'approving', label: 'Waiting for you to approve the token approval in your wallet' },
  { id: 'confirming-approve', label: 'Confirming the approval' },
  { id: 'sending', label: 'Waiting for you to approve the transaction in your wallet' },
  { id: 'confirming', label: 'Confirming on the network' },
  { id: 'verifying', label: 'Reading the result back from the network' },
  { id: 'done', label: 'Done' },
];

type Stage = 'form' | 'review' | 'working' | 'done';

export function createEvmOrders(host: OrdersEvmHost): { draw(card: HTMLElement, redraw: () => void, chainKey: LaunchEvmChainKey): void; reset(): void; isBusy(): boolean } {
  let stage: Stage = 'form';
  let form: EvmOrderForm = { ...DEFAULT_EVM_ORDER_FORM };
  let issues: EvmOrderIssue[] = [];
  let note: string | null = null;
  let rows: EvmOrderRow[] = [];
  let rowsFor = '';
  let review: EvmPlaceReview | EvmCancelReview | null = null;
  let outcome: EvmOrdersOutcome | null = null;
  let error: string | null = null;
  let progress: EvmOrdersProgress = 'checking';
  let busy = false;
  let acknowledged = false;
  let adapter: EvmWalletAdapter | null = null;
  let redrawNow: () => void = () => undefined;
  let chainKey: LaunchEvmChainKey = 'ethereum';

  const readFlow = (key: LaunchEvmChainKey): EvmOrdersFlow =>
    new EvmOrdersFlow({
      adapter: {
        getAccounts: async () => [],
        getChainId: async () => 0,
        switchChain: async () => undefined,
        sendTransaction: async () => {
          throw new Error('This view cannot send.');
        },
      },
      read: host.readerFor(key),
      now: () => Date.now(),
    });
  const flowFor = (key: LaunchEvmChainKey, a: EvmWalletAdapter): EvmOrdersFlow => new EvmOrdersFlow({ adapter: a, read: host.readerFor(key), now: () => Date.now() });

  const errorBox = (text: string): HTMLElement => {
    const p = h('p', 'wapp__banner wapp__banner--warn', text);
    p.setAttribute('role', 'alert');
    return p;
  };
  function row(dl: HTMLElement, k: string, v: string): void {
    const d = h('div');
    d.append(h('dt', '', k), h('dd', '', v));
    dl.append(d);
  }
  function field(
    label: string,
    id: string,
    value: string,
    onInput: (v: string) => void,
    o: { placeholder?: string; mono?: boolean; inputmode?: string; hint?: string; problem?: string } = {},
  ): HTMLElement {
    const wrap = h('div', 'wapp-ln__field');
    const lab = h('label', 'wapp__eyebrow', label);
    lab.htmlFor = id;
    const input = h('input', `wapp__input${o.mono ? ' wapp-mono' : ''}`);
    input.id = id;
    input.value = value;
    input.autocomplete = 'off';
    input.spellcheck = false;
    if (o.placeholder) input.placeholder = o.placeholder;
    if (o.inputmode) input.inputMode = o.inputmode;
    input.addEventListener('input', () => onInput(input.value));
    wrap.append(lab, input);
    if (o.problem) {
      input.setAttribute('aria-invalid', 'true');
      const p = h('p', 'wapp-ln__problem', o.problem);
      p.setAttribute('role', 'alert');
      wrap.append(p);
    } else if (o.hint) wrap.append(h('p', 'wapp__fine', o.hint));
    return wrap;
  }
  const problemFor = (name: keyof EvmOrderForm): string | undefined => issues.find((i) => i.field === name)?.message;
  const quoteOf = (chain: EvmOrdersChain) => chain.quotes.find((q) => q.symbol === form.quote) ?? chain.quotes[1]!;

  // ---------------------------------------------------------------- the form and the list

  function drawForm(card: HTMLElement, chain: EvmOrdersChain): void {
    const q = quoteOf(chain);
    const sides = h('div', 'wapp__row-actions');
    for (const s of ['buy', 'sell'] as const) {
      const b = h('button', `wapp__btn ${form.side === s ? 'wapp__btn--primary' : 'wapp__btn--ghost'}`, s === 'buy' ? 'Buy' : 'Sell');
      b.type = 'button';
      b.disabled = busy;
      b.addEventListener('click', () => {
        form = { ...form, side: s };
        issues = [];
        redrawNow();
      });
      sides.append(b);
    }
    const wrap = h('div', 'wapp-ln__field');
    const lab = h('label', 'wapp__eyebrow', 'Pay with');
    lab.htmlFor = 'ordevm-quote';
    const sel = h('select', 'wapp__input');
    sel.id = 'ordevm-quote';
    sel.disabled = busy;
    for (const c of chain.quotes) {
      const o = h('option', '', c.symbol);
      o.value = c.symbol;
      o.selected = c.symbol === q.symbol;
      sel.append(o);
    }
    sel.addEventListener('change', () => {
      form = { ...form, quote: sel.value };
      issues = [];
      redrawNow();
    });
    wrap.append(lab, sel);
    card.append(
      h(
        'p',
        'wapp__fine',
        `Buy or sell an Aretia Launch token on ${chain.name} only at a price you choose. Your money waits in escrow that only you can cancel, and nothing fills unless the market reaches your price.`,
      ),
      sides,
      wrap,
      field('Token address', 'ordevm-token', form.token, (v) => (form = { ...form, token: v }), { mono: true, placeholder: 'Paste the token’s address (0x…)', problem: problemFor('token') }),
      field(form.side === 'buy' ? `${q.symbol} to spend` : 'Tokens to sell', 'ordevm-amount', form.amount, (v) => (form = { ...form, amount: v }), {
        inputmode: 'decimal',
        problem: problemFor('amount'),
      }),
      field(`Your price, in ${q.symbol} per token`, 'ordevm-price', form.price, (v) => (form = { ...form, price: v }), {
        inputmode: 'decimal',
        problem: problemFor('price'),
        hint: form.side === 'buy' ? 'The most you will pay for one token, every fee included.' : 'The least you will accept for one token, every fee included.',
      }),
    );
    if (note) card.append(h('p', 'wapp__fine', note));
    if (error) card.append(errorBox(error));
    const account = host.getAccount();
    const go = h('button', 'wapp__btn wapp__btn--primary', busy ? 'Checking…' : account ? 'Review order' : 'Connect wallet');
    go.type = 'button';
    go.disabled = busy;
    go.addEventListener('click', () => void (account ? startPlace(chain) : connect()));
    card.append(go);
    drawOrders(card, chain);
  }

  function drawOrders(card: HTMLElement, chain: EvmOrdersChain): void {
    const sec = h('section', 'wapp-ln__section');
    sec.append(h('h3', 'wapp__h3', 'Your open orders'));
    const account = host.getAccount();
    if (!account) sec.append(h('p', 'wapp__fine', 'Connect your wallet to see them.'));
    else if (rows.length === 0) sec.append(h('p', 'wapp__fine', 'You have no open orders.'));
    else {
      const list = h('ul', 'wapp-ln__list');
      for (const r of rows) {
        const o = r.record;
        const li = h('li', 'wapp-ln__item');
        const name = r.symbol ?? short(o.launchToken);
        const what = o.isBuy
          ? `Buy ${name}: ${r.quote ? `${fromSmallestUnit(o.inRemaining, r.quote.decimals)} ${r.quote.symbol}` : 'an unknown asset'} left to spend`
          : `Sell ${name}: ${grouped(fromSmallestUnit(o.inRemaining, r.decimals ?? 18))} tokens left`;
        li.append(h('strong', '', what));
        li.append(
          h(
            'span',
            'wapp__fine',
            r.limit === null || !r.quote ? ' · price unknown' : ` · waiting for ${fromSmallestUnit(r.limit, r.quote.decimals)} ${r.quote.symbol} per token ${o.isBuy ? 'or less' : 'or more'}`,
          ),
        );
        const cancel = h('button', 'wapp__btn wapp__btn--ghost', 'Cancel');
        cancel.type = 'button';
        cancel.disabled = busy;
        cancel.addEventListener('click', () => void startCancel(chain, r));
        li.append(cancel);
        list.append(li);
      }
      sec.append(list);
    }
    card.append(sec);
  }

  // ---------------------------------------------------------------- review, working, done

  function drawReview(card: HTMLElement): void {
    const r = review;
    if (!r) return;
    const { chain } = r;
    const dl = h('dl', 'wapp-ln__facts');
    if (r.kind === 'place') {
      const t = r.terms;
      const q = r.market.quote;
      card.append(h('h3', 'wapp__h3', t.side === 'buy' ? 'Review your buy order' : 'Review your sell order'));
      row(dl, 'Network', `${chain.name} (chain ${chain.chainId})`);
      row(dl, 'Token', `${r.market.symbol} (${short(r.market.token)})`);
      row(dl, t.side === 'buy' ? `Held in escrow (${q.symbol})` : 'Held in escrow (tokens)', r.preview.escrowed);
      row(dl, t.side === 'buy' ? 'You get at least' : `You get at least (${q.symbol})`, r.preview.atLeast);
      row(dl, 'Your price', `${fromSmallestUnit(t.priceQuote, q.decimals)} ${q.symbol} per token`);
      row(dl, 'Aretia’s fee if it fills', r.preview.fillFee);
      row(dl, 'Aretia’s fee if you cancel', r.preview.cancelFee);
      row(dl, 'Network gas, at most about', r.gasCostWei === null ? 'could not be estimated' : coinText(r.gasCostWei, chain.symbol));
      row(dl, 'Your balance', coinText(r.coinBalance, chain.symbol));
      card.append(dl);
      if (r.proveTx || r.approveTx) {
        const first = [r.proveTx ? 'a one-time proof that Aretia’s factory made this token (it moves no money)' : null, r.approveTx ? 'letting the orders contract hold exactly this amount' : null]
          .filter(Boolean)
          .join(', then ');
        card.append(h('p', 'wapp__fine', `This takes ${r.proveTx && r.approveTx ? 'three' : 'two'} approvals in your wallet: first ${first}, then placing the order.`));
      }
      for (const d of r.disclosures) card.append(h('p', d.severity === 'caution' ? 'wapp__banner wapp__banner--warn' : 'wapp__fine', d.text));
    } else {
      card.append(h('h3', 'wapp__h3', 'Review the cancel'));
      row(dl, 'Network', `${chain.name} (chain ${chain.chainId})`);
      row(dl, 'Order', `#${r.order.id}`);
      row(dl, 'Network gas, at most about', r.gasCostWei === null ? 'could not be estimated' : coinText(r.gasCostWei, chain.symbol));
      card.append(dl);
      card.append(h('p', 'wapp__fine', `Aretia keeps ${r.order.cancelBps / 100}% of what is unfilled. The rest comes back to your wallet. Anything that already filled stays filled.`));
    }
    for (const b of r.blockers) card.append(errorBox(b));
    if (error) card.append(errorBox(error));
    const label = h('label', 'wapp__check');
    const box = h('input');
    box.type = 'checkbox';
    box.checked = acknowledged;
    box.addEventListener('change', () => {
      acknowledged = box.checked;
      redrawNow();
    });
    label.append(box, h('span', '', ' I have read this and want to go ahead.'));
    const go = h('button', 'wapp__btn wapp__btn--primary', r.kind === 'place' ? 'Place order' : 'Cancel order');
    go.type = 'button';
    go.disabled = !acknowledged || r.blockers.length > 0 || busy;
    go.addEventListener('click', () => void run());
    const back = h('button', 'wapp__btn wapp__btn--ghost', 'Back');
    back.type = 'button';
    back.addEventListener('click', () => {
      stage = 'form';
      review = null;
      error = null;
      acknowledged = false;
      redrawNow();
    });
    const actions = h('div', 'wapp__row-actions');
    actions.append(go, back);
    card.append(label, actions);
  }

  function drawWorking(card: HTMLElement): void {
    card.append(h('h3', 'wapp__h3', 'Working on it'));
    const ol = h('ol', 'wapp-ln__steps');
    const at = STEPS.findIndex((s) => s.id === progress);
    STEPS.forEach((s, i) => {
      const li = h('li', i < at ? 'is-done' : i === at ? 'is-now' : '', s.label);
      if (i === at) li.setAttribute('aria-current', 'step');
      ol.append(li);
    });
    card.append(ol);
  }

  function drawDone(card: HTMLElement, chain: EvmOrdersChain): void {
    card.append(h('h3', 'wapp__h3', 'Done'));
    if (outcome) {
      for (const hash of outcome.hashes) {
        const a = h('a', '', `View the transaction (${short(hash)})`);
        a.href = `${chain.explorer}/tx/${encodeURIComponent(hash)}`;
        a.target = '_blank';
        a.rel = 'noopener noreferrer';
        const p = h('p', 'wapp__fine');
        p.append(a);
        card.append(p);
      }
      for (const d of outcome.differences) card.append(errorBox(d));
    }
    const again = h('button', 'wapp__btn wapp__btn--primary', 'Back to my orders');
    again.type = 'button';
    again.addEventListener('click', () => {
      stage = 'form';
      outcome = null;
      review = null;
      acknowledged = false;
      void refresh(chain);
    });
    card.append(again);
  }

  // ---------------------------------------------------------------- actions

  async function connect(): Promise<void> {
    busy = true;
    error = null;
    redrawNow();
    try {
      adapter = (await host.connect()).adapter;
    } catch (e) {
      error = friendlyEvmError(e);
    } finally {
      busy = false;
      redrawNow();
    }
  }

  async function refresh(chain: EvmOrdersChain): Promise<void> {
    const who = host.getAccount();
    if (!who) {
      rows = [];
      redrawNow();
      return;
    }
    try {
      rows = await readFlow(chain.key).listOrders(chain, who);
      rowsFor = `${chain.key}:${who}`;
    } catch (e) {
      error = `Could not read your orders: ${friendlyEvmError(e)}`;
    }
    redrawNow();
  }

  async function startPlace(chain: EvmOrdersChain): Promise<void> {
    const who = host.getAccount();
    if (!who) return;
    error = null;
    note = null;
    busy = true;
    redrawNow();
    try {
      if (!adapter) adapter = (await host.connect()).adapter;
      const f = flowFor(chain.key, adapter);
      const token = form.token.trim();
      if (!/^0x[0-9a-fA-F]{40}$/.test(token)) {
        issues = [{ field: 'token', message: 'Paste the token’s address (0x followed by 40 letters and digits).' }];
        return;
      }
      const m = await f.loadMarket(chain, who, token, quoteOf(chain));
      if ('problem' in m) {
        issues = [{ field: 'token', message: m.problem }];
        return;
      }
      const { issues: found, terms } = f.prepareForm(form, m);
      issues = found;
      if (!terms) return;
      review = await f.preparePlace(who, m, terms);
      stage = 'review';
      acknowledged = false;
    } catch (e) {
      error = `Could not check this order: ${friendlyEvmError(e)}`;
    } finally {
      busy = false;
      redrawNow();
    }
  }

  async function startCancel(chain: EvmOrdersChain, r: EvmOrderRow): Promise<void> {
    const who = host.getAccount();
    if (!who) return;
    error = null;
    busy = true;
    redrawNow();
    try {
      if (!adapter) adapter = (await host.connect()).adapter;
      review = await flowFor(chain.key, adapter).prepareCancel(chain, who, r.record);
      stage = 'review';
      acknowledged = false;
    } catch (e) {
      error = `Could not prepare the cancel: ${friendlyEvmError(e)}`;
    } finally {
      busy = false;
      redrawNow();
    }
  }

  async function run(): Promise<void> {
    const r = review;
    if (!r || !acknowledged) return;
    busy = true;
    stage = 'working';
    progress = 'checking';
    error = null;
    redrawNow();
    try {
      if (!adapter) adapter = (await host.connect()).adapter;
      const f = flowFor(r.chain.key, adapter);
      const tick = (p: EvmOrdersProgress) => {
        progress = p;
        redrawNow();
      };
      outcome = r.kind === 'place' ? await f.place(r, tick) : await f.cancel(r, tick);
      stage = 'done';
    } catch (e) {
      error = e instanceof EvmOrdersError ? e.message : friendlyEvmError(e);
      stage = 'review';
    } finally {
      busy = false;
      review = stage === 'done' ? null : review;
      redrawNow();
    }
  }

  return {
    draw(card, redraw, key): void {
      redrawNow = redraw;
      const chain = evmOrdersChain(key);
      card.dataset.stage = chain ? stage : 'off';
      const section = h('div', 'wapp-ln');
      section.append(h('h3', 'wapp__h2', 'Limit orders'));
      if (!chain) {
        const name = chainByKey(key)?.name ?? 'this network';
        section.append(
          h(
            'p',
            'wapp__banner wapp__banner--warn',
            `Not live on ${name}. The orders contract is built and tested, but it has not been deployed and has not been audited, so this page does not send anything.`,
          ),
        );
        card.append(section);
        return;
      }
      // Switching networks or accounts starts again: nothing reviewed for one carries over to another.
      const who = host.getAccount() ?? '';
      if (chainKey !== key) {
        chainKey = key;
        stage = 'form';
        review = null;
        outcome = null;
        acknowledged = false;
        error = null;
        issues = [];
        rows = [];
        rowsFor = '';
        form = { ...form, quote: '' };
      }
      if (who && rowsFor !== `${key}:${who}` && !busy && stage === 'form') {
        rowsFor = `${key}:${who}`;
        void refresh(chain);
      }
      if (stage === 'form') drawForm(section, chain);
      else if (stage === 'review') drawReview(section);
      else if (stage === 'working') drawWorking(section);
      else drawDone(section, chain);
      card.append(section);
    },
    isBusy: () => busy,
    reset(): void {
      stage = 'form';
      review = null;
      outcome = null;
      acknowledged = false;
      error = null;
      adapter = null;
      rows = [];
      rowsFor = '';
    },
  };
}
