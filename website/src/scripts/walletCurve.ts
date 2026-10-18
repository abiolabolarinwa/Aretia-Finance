/**
 * The "Sell on a bonding curve" card of the Launch page. This file only draws it and connects it to the wallet; the rules are in
 * walletCurveCore.ts, the transactions and their check in walletCurveTx.ts and the order of events in walletCurveFlow.ts.
 *
 * It is off on mainnet. The page only contains the card when the site is built with PUBLIC_CURVE_ENABLED=1, and even then the card
 * shows a notice and no form until walletCurveCore.ts has a mainnet program address, which it will not have before an independent
 * audit. Everything typed, and everything read from the chain, is shown with textContent, never as markup.
 */
import { SLIPPAGE_PRESETS_BPS, fromSmallestUnit, isSolanaAddress } from './walletTools';
import { LaunchError, friendlyError } from './walletLaunchFlow';
import {
  CURVE_FEE_BPS,
  CURVE_TARGET_PRESETS,
  DEFAULT_CURVE_FORM,
  SLIPPAGE_BPS_DEFAULT,
  canAbort,
  canMigrate,
  curveDisclosures,
  curvePreview,
  curveProgressPercent,
  curveShareHash,
  parseCurveHash,
  curveProgramFor,
  solToLamports,
  summarise,
  tokensToRaw,
  validateCurve,
  priceText,
  type CurveForm,
  type CurveIssue,
  type CurveState,
} from './walletCurveCore';
import { CurveFlow, type CurveFlowDeps, type CurveOutcome, type CurveProgress, type CurveReview } from './walletCurveFlow';
import { fetchAccount, loadWeb3, rpcCall, signAndSubmitTransaction, simulateWithBalance, waitForConfirmation } from './walletSend';
import type { PoolToken } from './walletPoolCore';
import { appendTokenShare } from './walletTokenLinks';

export interface CurveHost {
  getAddress(): string | null;
  refreshWallet(): void;
}

type Tab = 'create' | 'trade';
type Stage = 'form' | 'review' | 'working' | 'done';

const h = <K extends keyof HTMLElementTagNameMap>(tag: K, cls = '', text?: string): HTMLElementTagNameMap[K] => {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text !== undefined) n.textContent = text;
  return n;
};
const grouped = (text: string): string => text.replace(/^(\d+)/, (whole) => whole.replace(/\B(?=(\d{3})+(?!\d))/g, ','));
const amountText = (raw: bigint, decimals: number): string => grouped(fromSmallestUnit(raw, decimals));
const sol = (lamports: bigint): string => `${fromSmallestUnit(lamports, 9)} SOL`;
const short = (a: string): string => `${a.slice(0, 4)}…${a.slice(-4)}`;

const STEPS: { id: CurveProgress; label: string }[] = [
  { id: 'checking', label: 'Checking everything once more' },
  { id: 'signing', label: 'Waiting for you to approve the transaction in your wallet' },
  { id: 'confirming', label: 'Sending it to Solana' },
  { id: 'verifying', label: 'Reading the result back from the network' },
  { id: 'done', label: 'Done' },
];

export interface CurveCard {
  /** True when the page has the card (the site was built with the flag on). The Launch page offers a curve only then. */
  present: boolean;
  onShow(): void;
  onWalletChange(): void;
  offer(mint: string): void;
  /** Shows or hides the whole card: it is the Solana card, so it hides when an Ethereum-style network is chosen. */
  setActive(active: boolean): void;
}

const noop: CurveCard = { present: false, onShow(): void {}, onWalletChange(): void {}, offer(): void {}, setActive(): void {} };

/**
 * A seam for the local test harness (website/dev/curve-harness), which runs this card against the devnet program with a local
 * test key. The wallet page passes nothing, so the card there can only ever use the mainnet program, which does not exist yet.
 */
export interface CurveOptions {
  program?: string;
  deps?: Omit<CurveFlowDeps, 'program'>;
}

export function initCurve(host: CurveHost, opts: CurveOptions = {}): CurveCard {
  const root = document.querySelector<HTMLElement>('[data-curve-root]');
  if (!root) return noop;
  const program = opts.program ?? curveProgramFor('mainnet');

  let tab: Tab = 'create';
  let side: 'buy' | 'sell' = 'buy';
  let stage: Stage = 'form';
  let form: CurveForm = { ...DEFAULT_CURVE_FORM };
  let issues: CurveIssue[] = [];
  let token: PoolToken | null = null;
  let review: CurveReview | null = null;
  let outcome: CurveOutcome | null = null;
  let error: string | null = null;
  let progress: CurveProgress = 'checking';
  let busy = false;
  let acknowledged = false;
  let flow: CurveFlow | null = null;
  // The token typed into the create form, read ahead of Review so the preview can show real numbers.
  let previewToken: PoolToken | null = null;
  let previewEl: HTMLElement | null = null;

  // Trading side.
  let lookup = '';
  let curve: CurveState | null = null;
  let curveToken: PoolToken | null = null;
  let lookupNote: string | null = null;
  let buyText = '';
  let sellText = '';
  let slippage: number = SLIPPAGE_BPS_DEFAULT;

  async function flowFor(): Promise<CurveFlow> {
    if (flow) return flow;
    if (!program) throw new Error('There is no curve program on this network yet.');
    if (opts.deps) {
      flow = new CurveFlow({ ...opts.deps, program });
      return flow;
    }
    const web3 = await loadWeb3();
    flow = new CurveFlow({
      web3,
      program,
      balanceOf: async (address) => (await fetchAccount(address))?.lamports ?? 0n,
      latestBlockhash: async () => (await rpcCall<{ value: { blockhash: string; lastValidBlockHeight: number } }>('getLatestBlockhash', [{ commitment: 'confirmed' }])).value,
      fetchAccount,
      simulate: simulateWithBalance,
      signAndSubmit: (tx, extra) => signAndSubmitTransaction(tx, extra),
      confirm: (signature) => waitForConfirmation(signature),
      nowSecs: () => Math.floor(Date.now() / 1000),
    });
    return flow;
  }

  // ---------------------------------------------------------------- small pieces

  const errorBox = (text: string): HTMLElement => {
    const p = h('p', 'wapp__banner wapp__banner--warn', text);
    p.setAttribute('role', 'alert');
    return p;
  };

  function row(dl: HTMLElement, k: string, v: string | HTMLElement): void {
    const d = h('div');
    const dd = h('dd');
    if (typeof v === 'string') dd.textContent = v;
    else dd.append(v);
    d.append(h('dt', '', k), dd);
    dl.append(d);
  }

  function link(text: string, href: string): HTMLAnchorElement {
    const a = h('a', '', text);
    a.href = href;
    a.target = '_blank';
    a.rel = 'noopener noreferrer';
    return a;
  }

  function field(label: string, id: string, value: string, onInput: (v: string) => void, opts: { placeholder?: string; mono?: boolean; inputmode?: string; hint?: string; problem?: string; onChange?: () => void } = {}): HTMLElement {
    const wrap = h('div', 'wapp-ln__field');
    const lab = h('label', 'wapp__eyebrow', label);
    lab.htmlFor = id;
    const input = h('input', `wapp__input${opts.mono ? ' wapp-mono' : ''}`);
    input.id = id;
    input.value = value;
    input.autocomplete = 'off';
    input.spellcheck = false;
    if (opts.placeholder) input.placeholder = opts.placeholder;
    if (opts.inputmode) input.inputMode = opts.inputmode;
    input.addEventListener('input', () => onInput(input.value));
    if (opts.onChange) input.addEventListener('change', opts.onChange);
    wrap.append(lab, input);
    if (opts.problem) {
      input.setAttribute('aria-invalid', 'true');
      const p = h('p', 'wapp-ln__problem', opts.problem);
      p.setAttribute('role', 'alert');
      wrap.append(p);
    } else if (opts.hint) wrap.append(h('p', 'wapp__fine', opts.hint));
    return wrap;
  }
  const problemFor = (name: keyof CurveForm): string | undefined => issues.find((i) => i.field === name)?.message;

  function tabs(card: HTMLElement): void {
    const bar = h('div', 'wapp__row-actions');
    for (const [id, label] of [['create', 'Open a curve'], ['trade', 'Trade a curve']] as const) {
      const b = h('button', `wapp__btn ${tab === id ? 'wapp__btn--primary' : 'wapp__btn--ghost'}`, label);
      b.type = 'button';
      b.disabled = busy;
      b.addEventListener('click', () => {
        tab = id;
        stage = 'form';
        review = null;
        outcome = null;
        error = null;
        acknowledged = false;
        draw();
      });
      bar.append(b);
    }
    card.append(bar);
  }

  // ---------------------------------------------------------------- the create form

  /** Redraws the live preview in place, so typing never loses its place. */
  function updatePreview(): void {
    if (!previewEl) return;
    previewEl.textContent = '';
    const p = curvePreview(form, previewToken);
    if (!p || !previewToken) {
      previewEl.append(h('p', 'wapp__fine', 'Fill in the token, how many tokens and how much to raise, and this shows how the curve would work.'));
      return;
    }
    const dec = previewToken.decimals;
    previewEl.append(h('span', 'wapp__eyebrow', 'How it would work'));
    const dl = h('dl', 'wapp__rows');
    row(dl, 'Sold along the curve', amountText(p.curveTokens, dec));
    row(dl, 'Kept for the pool', amountText(p.lpTokens, dec));
    row(dl, 'First token costs', `${p.startPrice} SOL`);
    row(dl, 'Last token costs', `${p.endPrice} SOL`);
    row(dl, 'The price rises', `${p.priceMultiple}× from first to last`);
    row(dl, 'Whole supply is worth', `${p.startValue} SOL at the start, ${p.endValue} SOL at the end`);
    previewEl.append(dl);
  }

  async function refreshPreviewToken(): Promise<void> {
    const mint = form.mint.trim();
    previewToken = null;
    updatePreview();
    if (!program || !isSolanaAddress(mint)) return;
    try {
      previewToken = await (await flowFor()).loadToken(host.getAddress() ?? mint, mint);
    } catch {
      previewToken = null;
    }
    updatePreview();
  }

  const shareLink = (mint: string): string => `${location.origin}${location.pathname}${curveShareHash(mint)}`;

  function copyButton(label: string, text: string): HTMLButtonElement {
    const b = h('button', 'wapp__btn wapp__btn--ghost', label);
    b.type = 'button';
    b.addEventListener('click', () => {
      void navigator.clipboard?.writeText(text).then(() => (b.textContent = 'Copied'));
    });
    return b;
  }

  function drawCreateForm(card: HTMLElement): void {
    card.append(
      h('p', 'wapp__fine', `Sell a token on Aretia’s own curve. Buyers pay SOL along a price curve; when every token on it is sold, the SOL raised and the tokens set aside open a locked liquidity pool. Aretia takes ${CURVE_FEE_BPS / 100}% of each trade. Your own wallet signs everything.`),
    );
    const f = h('form', 'wapp__form wapp-ln__form');
    f.noValidate = true;
    f.append(field('Token address', 'curve-mint', form.mint, (v) => (form = { ...form, mint: v }), { mono: true, placeholder: 'Token address', hint: 'A fixed-supply token you hold, such as one made on this page.', problem: problemFor('mint'), onChange: () => void refreshPreviewToken() }));
    f.append(field('Tokens to commit', 'curve-total', form.tokenAmount, (v) => { form = { ...form, tokenAmount: v }; updatePreview(); }, { inputmode: 'decimal', hint: 'In whole tokens. About four fifths go on the curve and the rest are kept for the pool.', problem: problemFor('tokenAmount') }));
    f.append(field('SOL to raise', 'curve-target', form.target, (v) => { form = { ...form, target: v }; updatePreview(); }, { inputmode: 'decimal', hint: 'The curve closes when buyers have paid in about this much.', problem: problemFor('target') }));
    const presets = h('div', 'wapp__row-actions');
    for (const t of CURVE_TARGET_PRESETS) {
      const pb = h('button', `wapp__btn ${form.target === t ? 'wapp__btn--primary' : 'wapp__btn--ghost'}`, `${t} SOL`);
      pb.type = 'button';
      pb.addEventListener('click', () => {
        form = { ...form, target: t };
        draw();
      });
      presets.append(pb);
    }
    f.append(presets);
    f.append(field('Your own first buy, in SOL (optional)', 'curve-first', form.firstBuy, (v) => (form = { ...form, firstBuy: v }), { inputmode: 'decimal', hint: 'Bought in the same transaction, before anyone else can. Leave empty for none.', problem: problemFor('firstBuy') }));
    previewEl = h('div', 'wapp-ln__field');
    previewEl.setAttribute('aria-live', 'polite');
    f.append(previewEl);
    updatePreview();
    const go = h('button', 'wapp__btn wapp__btn--primary', busy ? 'Checking…' : 'Review');
    go.type = 'submit';
    go.disabled = busy || !host.getAddress();
    f.append(go);
    f.addEventListener('submit', (e) => {
      e.preventDefault();
      void startCreateReview();
    });
    card.append(f);
    const formIssue = issues.find((i) => i.field === 'form');
    if (formIssue) card.append(errorBox(formIssue.message));
    if (!host.getAddress()) card.append(errorBox('Connect a Solana wallet first.'));
    if (error) card.append(errorBox(error));
  }

  // ---------------------------------------------------------------- the trade lookup, buy and sell

  function drawTrade(card: HTMLElement): void {
    card.append(h('p', 'wapp__fine', 'Look up a curve by its token address, then buy from it or sell back to it. Check who opened it: anyone holding some of a token can open its curve first.'));
    const f = h('form', 'wapp__form wapp-ln__form');
    f.noValidate = true;
    f.append(field('Token address', 'curve-lookup', lookup, (v) => (lookup = v), { mono: true, placeholder: 'Token address' }));
    const go = h('button', 'wapp__btn wapp__btn--primary', busy ? 'Looking…' : 'Find the curve');
    go.type = 'submit';
    go.disabled = busy;
    f.append(go);
    f.addEventListener('submit', (e) => {
      e.preventDefault();
      void findCurve();
    });
    card.append(f);
    if (lookupNote) card.append(errorBox(lookupNote));
    if (error) card.append(errorBox(error));
    if (!curve || !curveToken) return;

    const c = curve;
    const dec = curveToken.decimals;
    const dl = h('dl', 'wapp__rows');
    row(dl, 'Token', c.mint);
    row(dl, 'Opened by', c.creator);
    row(dl, 'State', { trading: 'Open for trading', soldOut: 'Sold out, waiting to move into a pool', migrated: 'Moved into a locked pool', aborted: 'Unwound: selling only' }[c.status]);
    row(dl, 'Price now', `${priceText(c, dec)} SOL per token`);
    row(dl, 'Sold so far', `${amountText(c.curveTokens - c.realTok, dec)} of ${amountText(c.curveTokens, dec)}`);
    row(dl, 'SOL raised so far', `${sol(c.realSol)} of about ${sol(c.target)}`);
    const pct = curveProgressPercent(c);
    const bar = h('progress');
    bar.max = 100;
    bar.value = pct;
    bar.setAttribute('aria-label', `${pct}% of the curve sold`);
    row(dl, 'Progress', bar);
    row(dl, 'Fee', `${c.feeBps / 100}% of each trade, to Aretia`);
    if (c.pool) row(dl, 'Pool', link(short(c.pool), `https://app.meteora.ag/dammv2/${encodeURIComponent(c.pool)}`));
    card.append(dl);
    card.append(copyButton('Copy link to this curve', shareLink(c.mint)));

    const slip = h('div', 'wapp-ln__field');
    const sl = h('label', 'wapp__eyebrow', 'Accept at most this much slippage');
    sl.htmlFor = 'curve-slip';
    const select = h('select', 'wapp__input');
    select.id = 'curve-slip';
    for (const bps of SLIPPAGE_PRESETS_BPS) {
      const o = h('option', '', `${bps / 100}%`);
      o.value = String(bps);
      o.selected = bps === slippage;
      select.append(o);
    }
    select.addEventListener('change', () => (slippage = Number(select.value)));
    slip.append(sl, select);
    card.append(slip);


    // One side at a time: a Buy / Sell switch, one amount box and one button, so an amount can never go into the wrong box.
    const canBuy = c.status === 'trading';
    const canSell = c.status === 'trading' || c.status === 'aborted';
    if (!canBuy) side = 'sell';
    if (!canSell) side = 'buy';
    if (canBuy && canSell) {
      const seg = h('div', 'lh-tabs lh-tabs--side');
      seg.setAttribute('role', 'group');
      seg.setAttribute('aria-label', 'Buy or sell');
      for (const s of ['buy', 'sell'] as const) {
        const b = h('button', `lh-tab${s === side ? ' is-on' : ''}`, s === 'buy' ? 'Buy' : 'Sell');
        b.type = 'button';
        b.setAttribute('aria-pressed', String(s === side));
        b.addEventListener('click', () => {
          side = s;
          draw();
        });
        seg.append(b);
      }
      card.append(seg);
    }
    if (side === 'buy' && canBuy) {
      const buy = h('button', 'wapp__btn wapp__btn--primary', 'Review buy');
      buy.type = 'button';
      buy.disabled = busy || !host.getAddress();
      buy.addEventListener('click', () => void startBuy());
      card.append(field('Buy with (SOL)', 'curve-buy', buyText, (v) => (buyText = v), { inputmode: 'decimal', placeholder: '1' }), buy);
    }
    if (side === 'sell' && canSell) {
      const sell = h('button', 'wapp__btn wapp__btn--primary', 'Review sell');
      sell.type = 'button';
      sell.disabled = busy || !host.getAddress();
      sell.addEventListener('click', () => void startSell());
      card.append(field('Sell (tokens)', 'curve-sell', sellText, (v) => (sellText = v), { inputmode: 'decimal', placeholder: '1,000' }), sell);
    }
    const actions = h('div', 'wapp__row-actions');
    if (canMigrate(c)) {
      const m = h('button', 'wapp__btn wapp__btn--primary', 'Move into a pool');
      m.type = 'button';
      m.disabled = busy || !host.getAddress();
      m.addEventListener('click', () => void startMigrate());
      actions.append(m);
    }
    // A sold-out curve may be unwound after the wait, or at once if someone else has opened its pool; the review says which.
    if (canAbort(c, Math.floor(Date.now() / 1000)) || c.status === 'soldOut') {
      const a = h('button', 'wapp__btn wapp__btn--ghost', 'Unwind this curve');
      a.type = 'button';
      a.disabled = busy || !host.getAddress();
      a.addEventListener('click', () => void startAbort());
      actions.append(a);
    }
    if (actions.childNodes.length) card.append(actions);
  }

  // ---------------------------------------------------------------- review

  function drawReview(card: HTMLElement): void {
    if (!review) return;
    const r = review;
    card.append(h('span', 'wapp__eyebrow', 'Review'));
    card.append(h('p', 'wapp__banner wapp__banner--warn', 'This is a real transaction on Solana mainnet and spends real SOL. Read it all before you approve. Nothing is sent until you press the button at the bottom.'));
    const dl = h('dl', 'wapp__rows');
    const costs = h('dl', 'wapp__rows');
    if (r.kind === 'create' && token) {
      const c = r.config;
      const s = summarise(c, token.supply);
      row(dl, 'Token', short(c.mint));
      row(dl, 'Tokens committed', amountText(c.totalRaw, c.decimals));
      row(dl, 'Sold along the curve', amountText(c.derived.curveTokens, c.decimals));
      row(dl, 'Kept for the pool', amountText(c.derived.lpTokens, c.decimals));
      row(dl, 'Raises about', sol(c.targetLamports));
      row(dl, 'Starting price', `${s.startPrice} SOL per token`);
      row(dl, 'Price when the curve closes', `${s.endPrice} SOL per token`);
      row(dl, 'Whole supply is worth', `${s.startValue} SOL at the start, ${s.endValue} SOL at the end`);
      if (r.firstBuy) {
        row(dl, 'Your first buy', `${sol(r.firstBuy.gross)} for ${amountText(r.firstBuy.tokensOut, c.decimals)} tokens`);
        row(costs, 'First buy (includes the Aretia fee of ' + sol(r.firstBuy.fee) + ')', sol(r.firstBuy.gross));
      }
      row(costs, 'Network fee and deposits', sol(r.network));
      row(costs, 'Total, about', sol(r.network + (r.firstBuy?.gross ?? 0n)));
    } else if (r.kind === 'buy' && curveToken) {
      row(dl, 'Token', short(r.mint));
      row(dl, 'You pay', r.quote ? sol(r.quote.gross) : '—');
      if (r.quote) {
        row(dl, 'Aretia fee (included)', sol(r.quote.fee));
        row(dl, 'You get about', `${amountText(r.quote.tokensOut, curveToken.decimals)} tokens`);
        row(dl, 'At least', `${amountText(r.minOut, curveToken.decimals)} tokens`);
      }
      row(costs, 'Network fee and deposits', sol(r.network));
    } else if (r.kind === 'sell' && curveToken) {
      row(dl, 'Token', short(r.mint));
      row(dl, 'You sell', `${amountText(r.tokensIn, curveToken.decimals)} tokens`);
      if (r.quote) {
        row(dl, 'Aretia fee (taken)', sol(r.quote.fee));
        row(dl, 'You receive about', sol(r.quote.net));
        row(dl, 'At least', sol(r.minOut));
      }
      row(costs, 'Network fee', sol(r.network));
    } else if (r.kind === 'migrate') {
      row(dl, 'Token', short(r.mint));
      row(dl, 'SOL into the pool', sol(r.curve.realSol));
      row(dl, 'Tokens into the pool', curveToken ? amountText(r.curve.lpTokens, curveToken.decimals) : String(r.curve.lpTokens));
      row(dl, 'Pool address', short(r.pool));
      row(dl, 'Lent for the pool’s accounts', sol(r.args.rentBudget));
      row(costs, 'What it costs you, about', sol(r.network));
    } else if (r.kind === 'abort') {
      row(dl, 'Token', short(r.mint));
      row(costs, 'Network fee', sol(r.network));
    }
    row(costs, 'Your balance', sol(r.balance));
    card.append(dl, h('span', 'wapp__eyebrow', 'What it costs, in SOL'), costs);
    card.append(h('p', 'wapp__fine', 'The deposits keep new accounts alive on Solana. The amounts come from a trial run on the network; your wallet shows the final ones.'));

    card.append(h('span', 'wapp__eyebrow', 'What this means'));
    const list = h('ul', 'wapp__list');
    for (const d of curveDisclosures(r.kind)) {
      const li = h('li');
      li.append(h('b', '', d.severity === 'caution' ? 'Note: ' : ''), document.createTextNode(d.text));
      list.append(li);
    }
    card.append(list);
    for (const b of r.blockers) card.append(errorBox(b));

    const ack = h('label', 'wapp__check');
    const box = h('input');
    box.type = 'checkbox';
    box.checked = acknowledged;
    const go = h('button', 'wapp__btn wapp__btn--primary', 'Approve in my wallet');
    go.type = 'button';
    go.disabled = !acknowledged || r.blockers.length > 0 || busy;
    box.addEventListener('change', () => {
      acknowledged = box.checked;
      go.disabled = !acknowledged || r.blockers.length > 0 || busy;
    });
    ack.append(box, h('span', '', 'I understand this is a real transaction, costs about the amount above, and cannot be undone.'));
    card.append(ack);
    const actions = h('div', 'wapp__row-actions');
    const back = h('button', 'wapp__btn wapp__btn--ghost', 'Back');
    back.type = 'button';
    back.addEventListener('click', () => {
      stage = 'form';
      review = null;
      acknowledged = false;
      error = null;
      draw();
    });
    go.addEventListener('click', () => void run());
    actions.append(go, back);
    card.append(actions);
    if (error) card.append(errorBox(error));
  }

  function drawWorking(card: HTMLElement): void {
    card.append(h('span', 'wapp__eyebrow', 'Working'), h('h3', 'wapp__h2', 'Sending'));
    card.append(h('p', 'wapp__fine', 'Keep this page open. Your wallet will ask you to approve one transaction.'));
    const list = h('ol', 'wapp-ln__steps');
    const at = STEPS.findIndex((s) => s.id === progress);
    STEPS.forEach((s, i) => {
      const li = h('li', i < at ? 'is-done' : i === at ? 'is-now' : '', s.label);
      if (i === at) li.setAttribute('aria-current', 'step');
      list.append(li);
    });
    card.append(list);
  }

  function drawDone(card: HTMLElement): void {
    if (!outcome) return;
    const ok = outcome.differences.length === 0;
    card.append(h('span', 'wapp__eyebrow', ok ? 'Done' : 'Done, with differences'));
    card.append(ok ? h('p', 'wapp__banner', 'Read back from the network: it matches what you approved.') : errorBox(`The network does not show exactly what you approved: ${outcome.differences.join(' ')}`));
    const dl = h('dl', 'wapp__rows');
    row(dl, 'Curve', outcome.curve);
    row(dl, 'Transaction', link(short(outcome.signature), `https://solscan.io/tx/${encodeURIComponent(outcome.signature)}`));
    if (outcome.pool) row(dl, 'Pool', link(short(outcome.pool), `https://app.meteora.ag/dammv2/${encodeURIComponent(outcome.pool)}`));
    card.append(dl);
    if (tab === 'create' && ok) {
      // A creator's next step is to tell people. The link opens the curve for anyone, on the Launch page.
      card.append(h('p', 'wapp__fine', 'Your curve is open. Share this link so people can buy from it.'));
      card.append(copyButton('Copy link to your curve', shareLink(form.mint.trim())));
      appendTokenShare(card, 'solana', form.mint.trim());
      const view = h('button', 'wapp__btn wapp__btn--primary', 'View your curve');
      view.type = 'button';
      view.addEventListener('click', () => {
        tab = 'trade';
        lookup = form.mint.trim();
        stage = 'form';
        outcome = null;
        void findCurve();
      });
      card.append(view);
    }
    const again = h('button', 'wapp__btn wapp__btn--primary', 'Back');
    again.type = 'button';
    again.addEventListener('click', () => {
      stage = 'form';
      review = null;
      outcome = null;
      acknowledged = false;
      error = null;
      if (tab === 'trade' && lookup) void findCurve();
      else draw();
    });
    card.append(again);
  }

  function draw(): void {
    if (!root) return;
    root.textContent = '';
    root.dataset.stage = program ? stage : 'off';
    const card = h('div', 'wapp-ln');
    card.append(h('h2', 'wapp__h2', 'Sell on a bonding curve'));
    if (!program) {
      card.append(
        h('p', 'wapp__banner wapp__banner--warn', 'Not live on Solana mainnet. The curve program is built and tested, but it has not been independently audited, so it is not deployed to mainnet and this page does not send anything.'),
      );
      root.append(card);
      return;
    }
    if (stage === 'form') {
      tabs(card);
      if (tab === 'create') drawCreateForm(card);
      else drawTrade(card);
    } else if (stage === 'review') drawReview(card);
    else if (stage === 'working') drawWorking(card);
    else drawDone(card);
    root.append(card);
  }

  // ---------------------------------------------------------------- actions

  async function startCreateReview(): Promise<void> {
    const creator = host.getAddress() ?? '';
    error = null;
    busy = true;
    draw();
    try {
      const f = await flowFor();
      token = form.mint.trim() === '' ? null : await f.loadToken(creator, form.mint.trim()).catch(() => null);
      const v = validateCurve(form, creator, token);
      issues = v.ok ? [] : v.issues;
      if (!v.ok || !token) {
        busy = false;
        draw();
        root?.querySelector<HTMLElement>('[aria-invalid="true"]')?.focus();
        return;
      }
      review = await f.prepareCreate(v.config, token);
      stage = 'review';
      acknowledged = false;
    } catch (e) {
      error = `Could not price this on the network: ${friendlyError(e)}`;
    } finally {
      busy = false;
      draw();
    }
  }

  async function findCurve(): Promise<void> {
    error = null;
    lookupNote = null;
    curve = null;
    busy = true;
    draw();
    try {
      const f = await flowFor();
      const mint = lookup.trim();
      const found = mint ? await f.loadCurve(mint) : null;
      if (!found) lookupNote = 'No curve was found for that token address.';
      else {
        curve = found;
        curveToken = await f.loadToken(host.getAddress() ?? found.creator, mint);
        if (!curveToken) {
          curve = null;
          lookupNote = 'That curve’s token could not be read.';
        }
      }
    } catch (e) {
      error = `Could not look that up: ${friendlyError(e)}`;
    } finally {
      busy = false;
      draw();
    }
  }

  async function prepare(make: (f: CurveFlow, who: string, c: CurveState) => Promise<CurveReview>): Promise<void> {
    const who = host.getAddress();
    if (!who || !curve) return;
    error = null;
    busy = true;
    draw();
    try {
      const f = await flowFor();
      // Read the curve again so the numbers are as fresh as the network can give.
      const latest = await f.loadCurve(curve.mint);
      if (!latest) throw new Error('The curve could not be read.');
      curve = latest;
      review = await make(f, who, latest);
      stage = 'review';
      acknowledged = false;
    } catch (e) {
      error = `Could not price this on the network: ${friendlyError(e)}`;
    } finally {
      busy = false;
      draw();
    }
  }

  const startBuy = (): Promise<void> =>
    prepare(async (f, who, c) => {
      const offered = solToLamports(buyText);
      if (offered === null) throw new Error('Enter an amount of SOL above zero.');
      return f.prepareBuy(who, c, offered, slippage);
    });
  const startSell = (): Promise<void> =>
    prepare(async (f, who, c) => {
      const tokens = curveToken ? tokensToRaw(sellText, curveToken.decimals) : null;
      if (tokens === null) throw new Error('Enter an amount of tokens above zero.');
      return f.prepareSell(who, c, tokens, slippage);
    });
  const startMigrate = (): Promise<void> => prepare((f, who, c) => f.prepareMigrate(who, c));
  const startAbort = (): Promise<void> => prepare((f, who, c) => f.prepareAbort(who, c));

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
      const tick = (p: CurveProgress) => {
        progress = p;
        draw();
      };
      outcome = r.kind === 'create' ? await f.create(r, tick) : r.kind === 'buy' ? await f.buy(r, tick) : r.kind === 'sell' ? await f.sell(r, tick) : r.kind === 'migrate' ? await f.migrate(r, tick) : await f.abort(r, tick);
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
      // A shared link ("#/launch/curve/<token>") opens that curve for trading.
      const shared = parseCurveHash(location.hash);
      if (shared && program && shared !== lookup) {
        lookup = shared;
        tab = 'trade';
        stage = 'form';
        void findCurve();
        return;
      }
      draw();
    },
    onWalletChange(): void {
      // A different wallet is a different person: nothing typed or approved for the last one carries over.
      review = null;
      token = null;
      outcome = null;
      stage = 'form';
      acknowledged = false;
      error = null;
      draw();
    },
    offer(mint: string): void {
      // Tells the Launch page frame to open the curve tab (walletLaunchHub.ts).
      root.dispatchEvent(new CustomEvent('lh:offer', { bubbles: true }));
      form = { ...DEFAULT_CURVE_FORM, mint };
      lookup = mint;
      void refreshPreviewToken();
      tab = 'create';
      stage = 'form';
      review = null;
      outcome = null;
      issues = [];
      error = null;
      draw();
      root?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    },
  };
}
