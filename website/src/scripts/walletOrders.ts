/**
 * The "Limit orders" card of the Launch page: buy or sell an Aretia Launch token only at a price the person sets. This file only
 * draws the card and connects it to the wallet; the rules are in walletOrdersCore.ts, the transactions and their check in
 * walletOrdersTx.ts and the order of events in walletOrdersFlow.ts.
 *
 * It is off until the order program is deployed. The page only contains the card when the site is built with
 * PUBLIC_ORDERS_ENABLED=1, and even then the card shows a notice and no form until walletOrdersCore.ts has a program address,
 * which it will not have before the owner deploys it. Everything typed, and everything read from the chain, is shown with
 * textContent, never as markup. The card lists the connected wallet's own orders and nobody else's.
 */
import { fromSmallestUnit } from './walletTools';
import { LaunchError, friendlyError } from './walletLaunchFlow';
import { priceText } from './walletCurveCore';
import { DEFAULT_ORDER_FORM, ordersProgramFor, type OrderForm, type OrderIssue } from './walletOrdersCore';
import { CURVE_PROGRAM_ID_MAINNET } from './walletCurveCore';
import { OrdersFlow, type CancelReview, type Market, type OrderRow, type OrdersFlowDeps, type OrdersOutcome, type OrdersProgress, type PlaceReview } from './walletOrdersFlow';
import { fetchAccount, loadWeb3, rpcCall, signAndSubmitTransaction, simulateTransaction, waitForConfirmation } from './walletSend';

export interface OrdersHost {
  getAddress(): string | null;
  refreshWallet(): void;
}

export interface OrdersCard {
  present: boolean;
  onShow(): void;
  onWalletChange(): void;
  setActive(active: boolean): void;
}
const noop: OrdersCard = {
  present: false,
  onShow(): void {},
  onWalletChange(): void {},
  setActive(): void {},
};

export interface OrdersOptions {
  program?: string | null;
  curveProgram?: string | null;
  deps?: Omit<OrdersFlowDeps, 'program' | 'curveProgram'>;
}

type Stage = 'form' | 'review' | 'working' | 'done';

const h = <K extends keyof HTMLElementTagNameMap>(tag: K, cls = '', text?: string): HTMLElementTagNameMap[K] => {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text !== undefined) n.textContent = text;
  return n;
};
const grouped = (text: string): string => text.replace(/^(\d+)/, (whole) => whole.replace(/\B(?=(\d{3})+(?!\d))/g, ','));
const sol = (lamports: bigint): string => `${fromSmallestUnit(lamports, 9)} SOL`;
const tokens = (raw: bigint, decimals: number): string => grouped(fromSmallestUnit(raw, decimals));
const short = (a: string): string => `${a.slice(0, 4)}…${a.slice(-4)}`;

const STEPS: { id: OrdersProgress; label: string }[] = [
  { id: 'checking', label: 'Checking everything once more' },
  {
    id: 'signing',
    label: 'Waiting for you to approve the transaction in your wallet',
  },
  { id: 'confirming', label: 'Sending it to Solana' },
  { id: 'verifying', label: 'Reading the result back from the network' },
  { id: 'done', label: 'Done' },
];

export function initOrders(host: OrdersHost, opts: OrdersOptions = {}): OrdersCard {
  const root = document.querySelector<HTMLElement>('[data-orders-root]');
  if (!root) return noop;
  const program = opts.program !== undefined ? opts.program : ordersProgramFor('mainnet');
  const curveProgram = opts.curveProgram !== undefined ? opts.curveProgram : CURVE_PROGRAM_ID_MAINNET;

  let stage: Stage = 'form';
  let form: OrderForm = { ...DEFAULT_ORDER_FORM };
  let issues: OrderIssue[] = [];
  let note: string | null = null;
  let rows: OrderRow[] = [];
  let wrapped = 0n;
  let market: Market | null = null;
  let review: PlaceReview | CancelReview | null = null;
  let outcome: OrdersOutcome | null = null;
  let error: string | null = null;
  let progress: OrdersProgress = 'checking';
  let busy = false;
  let acknowledged = false;
  let flow: OrdersFlow | null = null;

  async function flowFor(): Promise<OrdersFlow> {
    if (flow) return flow;
    if (!program || !curveProgram) throw new Error('There is no order program on this network yet.');
    if (opts.deps) {
      flow = new OrdersFlow({ ...opts.deps, program, curveProgram });
      return flow;
    }
    const web3 = await loadWeb3();
    flow = new OrdersFlow({
      web3,
      program,
      curveProgram,
      balanceOf: async (address) => (await fetchAccount(address))?.lamports ?? 0n,
      latestBlockhash: async () =>
        (
          await rpcCall<{
            value: { blockhash: string; lastValidBlockHeight: number };
          }>('getLatestBlockhash', [{ commitment: 'confirmed' }])
        ).value,
      fetchAccount,
      // Only this owner's orders are asked for: the filter is on the owner's address (offset 8, after the account's type tag).
      ordersOf: async (owner) => {
        const r = await rpcCall<{ pubkey: string; account: { data: [string, string] } }[]>('getProgramAccounts', [
          program,
          {
            encoding: 'base64',
            commitment: 'confirmed',
            filters: [{ dataSize: 235 }, { memcmp: { offset: 8, bytes: owner } }],
          },
        ]);
        return r.map((x) => ({
          address: x.pubkey,
          data: Uint8Array.from(atob(x.account.data[0]), (c) => c.charCodeAt(0)),
        }));
      },
      simulate: async (tx) => {
        const s = await simulateTransaction(tx);
        return { ok: s.ok, error: s.error };
      },
      signAndSubmit: (tx) => signAndSubmitTransaction(tx),
      confirm: (signature) => waitForConfirmation(signature),
      newNonce: () => BigInt(Date.now()) * 1000n + BigInt(Math.floor(Math.random() * 1000)),
    });
    return flow;
  }

  // ---------------------------------------------------------------- small pieces

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
    o: {
      placeholder?: string;
      mono?: boolean;
      inputmode?: string;
      hint?: string;
      problem?: string;
    } = {},
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
  const problemFor = (name: keyof OrderForm): string | undefined => issues.find((i) => i.field === name)?.message;

  // ---------------------------------------------------------------- the form and the list

  function drawForm(card: HTMLElement): void {
    const sides = h('div', 'wapp__row-actions');
    for (const s of ['buy', 'sell'] as const) {
      const b = h('button', `wapp__btn ${form.side === s ? 'wapp__btn--primary' : 'wapp__btn--ghost'}`, s === 'buy' ? 'Buy' : 'Sell');
      b.type = 'button';
      b.disabled = busy;
      b.addEventListener('click', () => {
        form = { ...form, side: s };
        issues = [];
        draw();
      });
      sides.append(b);
    }
    card.append(
      h(
        'p',
        'wapp__fine',
        'Buy or sell an Aretia Launch token only at a price you choose. Your money waits in escrow that only you can cancel, and nothing fills unless the market reaches your price.',
      ),
      sides,
      field('Token address', 'ord-mint', form.mint, (v) => (form = { ...form, mint: v }), {
        mono: true,
        placeholder: 'Paste the token’s address',
        problem: problemFor('mint'),
      }),
      field(form.side === 'buy' ? 'SOL to spend' : 'Tokens to sell', 'ord-amount', form.amount, (v) => (form = { ...form, amount: v }), { inputmode: 'decimal', problem: problemFor('amount') }),
      field('Your price, in SOL per token', 'ord-price', form.price, (v) => (form = { ...form, price: v }), {
        inputmode: 'decimal',
        problem: problemFor('price'),
        hint: form.side === 'buy' ? 'The most you will pay for one token, every fee included.' : 'The least you will accept for one token, every fee included.',
      }),
    );
    if (note) card.append(h('p', 'wapp__fine', note));
    if (error) card.append(errorBox(error));
    const go = h('button', 'wapp__btn wapp__btn--primary', busy ? 'Checking…' : 'Review order');
    go.type = 'button';
    go.disabled = busy || !host.getAddress();
    go.addEventListener('click', () => void startPlace());
    card.append(go);
    if (!host.getAddress()) card.append(h('p', 'wapp__fine', 'Connect your wallet to place an order.'));
    drawOrders(card);
  }

  function drawOrders(card: HTMLElement): void {
    const sec = h('section', 'wapp-ln__section');
    sec.append(h('h3', 'wapp__h3', 'Your open orders'));
    if (!host.getAddress()) {
      sec.append(h('p', 'wapp__fine', 'Connect your wallet to see them.'));
    } else if (rows.length === 0) {
      sec.append(h('p', 'wapp__fine', 'You have no open orders.'));
    } else {
      const list = h('ul', 'wapp-ln__list');
      for (const r of rows) {
        const a = r.account;
        const li = h('li', 'wapp-ln__item');
        const d = r.decimals ?? 6;
        const what = a.side === 'buy' ? `Buy ${short(a.launchMint)}: ${sol(a.inRemaining)} left to spend` : `Sell ${short(a.launchMint)}: ${tokens(a.inRemaining, d)} tokens left`;
        li.append(h('strong', '', what));
        li.append(h('span', 'wapp__fine', r.limit === null ? ' · price unknown' : ` · waiting for ${fromSmallestUnit(r.limit, 9)} SOL per token ${a.side === 'buy' ? 'or less' : 'or more'}`));
        const cancel = h('button', 'wapp__btn wapp__btn--ghost', 'Cancel');
        cancel.type = 'button';
        cancel.disabled = busy;
        cancel.addEventListener('click', () => void startCancel(r));
        li.append(cancel);
        list.append(li);
      }
      sec.append(list);
    }
    if (wrapped > 0n) {
      const p = h('p', 'wapp__fine', `You hold ${sol(wrapped)} as wrapped SOL (what a cancelled buy or a filled sell leaves). `);
      const b = h('button', 'wapp__btn wapp__btn--ghost', 'Turn it back into SOL');
      b.type = 'button';
      b.disabled = busy;
      b.addEventListener('click', () => void startUnwrap());
      p.append(b);
      sec.append(p);
    }
    card.append(sec);
  }

  // ---------------------------------------------------------------- review, working, done

  function drawReview(card: HTMLElement): void {
    const r = review;
    if (!r) return;
    const dl = h('dl', 'wapp-ln__facts');
    if (r.kind === 'place') {
      const t = r.terms;
      card.append(h('h3', 'wapp__h3', t.side === 'buy' ? 'Review your buy order' : 'Review your sell order'));
      row(dl, 'Token', short(r.mint));
      row(dl, t.side === 'buy' ? 'Held in escrow (SOL)' : 'Held in escrow (tokens)', r.preview.escrowed);
      row(dl, t.side === 'buy' ? 'You get at least' : 'You get at least (SOL)', r.preview.atLeast);
      row(dl, 'Your price', `${fromSmallestUnit(t.priceLamports, 9)} SOL per token`);
      if (market) row(dl, 'Price on the curve now', `${priceText(market.curve, market.decimals)} SOL per token`);
      row(dl, 'Aretia’s fee if it fills', r.preview.fillFee);
      row(dl, 'Aretia’s fee if you cancel', r.preview.cancelFee);
      row(dl, 'Network costs (refunded when the order closes, except the fee)', sol(r.network));
      card.append(dl);
      if (
        market &&
        ((t.side === 'buy' && market.curve.vSol * 10n ** BigInt(market.decimals) <= t.priceLamports * market.curve.vTok) ||
          (t.side === 'sell' && market.curve.vSol * 10n ** BigInt(market.decimals) >= t.priceLamports * market.curve.vTok))
      )
        card.append(h('p', 'wapp__banner', 'Your price is already met by the curve, so this order will probably fill straight away.'));
      for (const d of r.disclosures) card.append(h('p', d.severity === 'caution' ? 'wapp__banner wapp__banner--warn' : 'wapp__fine', d.text));
    } else {
      card.append(h('h3', 'wapp__h3', 'Review the cancel'));
      row(dl, 'Order', short(r.order));
      row(dl, 'Aretia’s cancel fee (about)', r.account.side === 'buy' ? sol(r.fee) : `${fromSmallestUnit(r.fee, market?.decimals ?? 6)} tokens`);
      card.append(dl);
      card.append(h('p', 'wapp__fine', 'The rest of what is unfilled comes back to your wallet. Anything that already filled stays filled.'));
    }
    for (const b of r.blockers) card.append(errorBox(b));
    if (error) card.append(errorBox(error));
    const label = h('label', 'wapp__check');
    const box = h('input');
    box.type = 'checkbox';
    box.checked = acknowledged;
    box.addEventListener('change', () => {
      acknowledged = box.checked;
      draw();
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
      draw();
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

  function drawDone(card: HTMLElement): void {
    card.append(h('h3', 'wapp__h3', 'Done'));
    if (outcome) {
      const a = h('a', '', 'View the transaction');
      a.href = `https://solscan.io/tx/${encodeURIComponent(outcome.signature)}`;
      a.target = '_blank';
      a.rel = 'noopener noreferrer';
      const p = h('p', 'wapp__fine');
      p.append(a);
      card.append(p);
      for (const d of outcome.differences) card.append(errorBox(d));
    }
    const again = h('button', 'wapp__btn wapp__btn--primary', 'Back to my orders');
    again.type = 'button';
    again.addEventListener('click', () => {
      stage = 'form';
      outcome = null;
      review = null;
      acknowledged = false;
      void refresh();
    });
    card.append(again);
  }

  function draw(): void {
    if (!root) return;
    root.textContent = '';
    root.dataset.stage = program ? stage : 'off';
    const card = h('div', 'wapp-ln');
    card.append(h('h2', 'wapp__h2', 'Limit orders'));
    if (!program || !curveProgram) {
      card.append(
        h(
          'p',
          'wapp__banner wapp__banner--warn',
          'Not live on Solana mainnet. The order program is built and tested, but it has not been deployed and its bonding curve has not been independently audited, so this page does not send anything.',
        ),
      );
      root.append(card);
      return;
    }
    if (stage === 'form') drawForm(card);
    else if (stage === 'review') drawReview(card);
    else if (stage === 'working') drawWorking(card);
    else drawDone(card);
    root.append(card);
  }

  // ---------------------------------------------------------------- actions

  async function refresh(): Promise<void> {
    const who = host.getAddress();
    if (!program || !who) {
      rows = [];
      wrapped = 0n;
      draw();
      return;
    }
    try {
      const f = await flowFor();
      rows = await f.listOrders(who);
      wrapped = await f.wrappedBalance(who);
    } catch (e) {
      error = `Could not read your orders: ${friendlyError(e)}`;
    }
    draw();
  }

  async function startPlace(): Promise<void> {
    const who = host.getAddress();
    if (!who) return;
    error = null;
    note = null;
    busy = true;
    draw();
    try {
      const f = await flowFor();
      const m = await f.loadMarket(who, form.mint.trim());
      if ('problem' in m) {
        issues = [{ field: 'mint', message: m.problem }];
        return;
      }
      market = m;
      const { issues: found, terms } = f.prepareForm(form, m);
      issues = found;
      if (!terms) return;
      review = await f.preparePlace(who, m, terms);
      stage = 'review';
      acknowledged = false;
    } catch (e) {
      error = `Could not price this on the network: ${friendlyError(e)}`;
    } finally {
      busy = false;
      draw();
      root?.querySelector<HTMLElement>('[aria-invalid="true"]')?.focus();
    }
  }

  async function startCancel(r: OrderRow): Promise<void> {
    const who = host.getAddress();
    if (!who) return;
    error = null;
    busy = true;
    draw();
    try {
      const f = await flowFor();
      market = null;
      review = await f.prepareCancel(who, r);
      stage = 'review';
      acknowledged = false;
    } catch (e) {
      error = `Could not prepare the cancel: ${friendlyError(e)}`;
    } finally {
      busy = false;
      draw();
    }
  }

  async function startUnwrap(): Promise<void> {
    const who = host.getAddress();
    if (!who) return;
    error = null;
    busy = true;
    stage = 'working';
    progress = 'checking';
    draw();
    try {
      const f = await flowFor();
      outcome = await f.unwrap(who, (p) => {
        progress = p;
        draw();
      });
      stage = 'done';
      host.refreshWallet();
    } catch (e) {
      error = e instanceof LaunchError ? e.message : friendlyError(e);
      stage = 'form';
    } finally {
      busy = false;
      draw();
    }
  }

  async function run(): Promise<void> {
    const r = review;
    if (!r || !acknowledged) return;
    busy = true;
    stage = 'working';
    progress = 'checking';
    error = null;
    draw();
    try {
      const f = await flowFor();
      const tick = (p: OrdersProgress) => {
        progress = p;
        draw();
      };
      outcome = r.kind === 'place' ? await f.place(r, tick) : await f.cancel(r, tick);
      stage = 'done';
      host.refreshWallet();
    } catch (e) {
      error = e instanceof LaunchError ? e.message : friendlyError(e);
      stage = 'review';
    } finally {
      busy = false;
      review = stage === 'done' ? null : review;
      draw();
    }
  }

  return {
    present: true,
    setActive(active: boolean): void {
      const card = root.closest<HTMLElement>('.wapp__card');
      if (card) card.hidden = !active;
    },
    onShow(): void {
      draw();
      void refresh();
    },
    onWalletChange(): void {
      // A different wallet is a different person: nothing typed, listed or approved for the last one carries over.
      review = null;
      outcome = null;
      rows = [];
      wrapped = 0n;
      market = null;
      stage = 'form';
      acknowledged = false;
      error = null;
      issues = [];
      draw();
      void refresh();
    },
  };
}
