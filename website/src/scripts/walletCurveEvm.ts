/**
 * The Ethereum-style half of the bonding-curve card: the form, review and result for selling a token on Aretia's curve on Ethereum (and, once
 * deployed and tested, BNB Chain and Polygon). Rules are in walletCurveEvmCore.ts, the transactions and their inspectors in walletCurveEvmTx.ts,
 * the order of events in walletCurveEvmFlow.ts. This file only draws and connects them to the wallet the page already uses. Everything typed,
 * and everything read back from the chain, is shown with textContent, never as markup.
 *
 * It is off by default: walletLaunchEvm.ts only creates it on a build with PUBLIC_CURVE_ENABLED=1, and even then it shows a notice and no form
 * for any network that has no deployed contract in EVM_CURVE_ADDRESSES, which is every network until the contract has been audited.
 */
import type { EvmWalletAdapter } from '../swings/chains/evmWallet.js';
import type { EvmRead } from '../swings/chains/evmSession.js';
import { SLIPPAGE_PRESETS_BPS, fromSmallestUnit, isSolanaAddress } from './walletTools';
import { chainByKey, isEvmAddress, type LaunchEvmChainKey } from './walletLaunchEvmCore';
import { friendlyEvmError } from './walletLaunchEvmFlow';
import {
  DEFAULT_EVM_CURVE_FORM,
  EVM_FEE_BPS,
  EVM_SLIPPAGE_BPS_DEFAULT,
  EVM_TARGET_PRESETS,
  coinToWei,
  evmCanAbort,
  evmCanGraduate,
  evmCurveChain,
  evmCurveDisclosures,
  evmCurvePreview,
  evmCurveShareHash,
  evmPriceText,
  parseEvmCurveHash,
  validateEvmCurve,
  type EvmCurveForm,
  type EvmCurveIssue,
  type EvmCurveState,
  type EvmCurveToken,
} from './walletCurveEvmCore';
import { EvmCurveError, EvmCurveFlow, type EvmCurveOutcome, type EvmCurveProgress, type EvmCurveReview } from './walletCurveEvmFlow';

export interface CurveEvmHost {
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
const amountText = (raw: bigint, decimals: number): string => grouped(fromSmallestUnit(raw, decimals));
const short = (a: string): string => `${a.slice(0, 6)}…${a.slice(-4)}`;

const STEPS: { id: EvmCurveProgress; label: string }[] = [
  { id: 'checking', label: 'Checking everything once more' },
  { id: 'approving', label: 'Waiting for you to approve the token approval in your wallet' },
  { id: 'confirming-approve', label: 'Confirming the approval' },
  { id: 'sending', label: 'Waiting for you to approve the transaction in your wallet' },
  { id: 'confirming', label: 'Confirming on the network' },
  { id: 'verifying', label: 'Reading the result back from the network' },
  { id: 'done', label: 'Done' },
];

type Tab = 'create' | 'trade';
type Stage = 'form' | 'review' | 'working' | 'done';

export function createEvmCurve(host: CurveEvmHost): { draw(card: HTMLElement, redraw: () => void, chainKey: LaunchEvmChainKey, suggestToken: string | null): void; reset(): void; isBusy(): boolean } {
  let tab: Tab = 'create';
  let side: 'buy' | 'sell' = 'buy';
  let stage: Stage = 'form';
  let form: EvmCurveForm = { ...DEFAULT_EVM_CURVE_FORM };
  let issues: EvmCurveIssue[] = [];
  let tokenInfo: EvmCurveToken | null = null;
  let review: EvmCurveReview | null = null;
  let outcome: EvmCurveOutcome | null = null;
  let error: string | null = null;
  let progress: EvmCurveProgress = 'checking';
  let busy = false;
  let acknowledged = false;
  let adapter: EvmWalletAdapter | null = null;
  let redrawNow: () => void = () => undefined;
  let lastSuggest: string | null = null;
  let deepLinkDone = false;
  let previewEl: HTMLElement | null = null;

  // Trading side.
  let lookup = '';
  let curve: EvmCurveState | null = null;
  let curveToken: EvmCurveToken | null = null;
  let lookupNote: string | null = null;
  let buyText = '';
  let sellText = '';
  let slippage: number = EVM_SLIPPAGE_BPS_DEFAULT;

  const flowFor = (chainKey: LaunchEvmChainKey, a: EvmWalletAdapter): EvmCurveFlow =>
    new EvmCurveFlow({ adapter: a, read: host.readerFor(chainKey), now: () => Date.now(), nowSeconds: () => Math.floor(Date.now() / 1000) });
  /** A flow that only reads: used before a wallet is connected, for the preview and for looking a curve up. */
  const readFlow = (chainKey: LaunchEvmChainKey): EvmCurveFlow =>
    new EvmCurveFlow({
      adapter: { getAccounts: async () => [], getChainId: async () => 0, switchChain: async () => undefined, sendTransaction: async () => { throw new Error('This view cannot send.'); } },
      read: host.readerFor(chainKey),
      now: () => Date.now(),
      nowSeconds: () => Math.floor(Date.now() / 1000),
    });

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
  const problemFor = (name: keyof EvmCurveForm): string | undefined => issues.find((i) => i.field === name)?.message;
  const shareLink = (token: string): string => `${location.origin}${location.pathname}${evmCurveShareHash(form.chain, token)}`;
  function copyButton(label: string, text: string): HTMLButtonElement {
    const b = h('button', 'wapp__btn wapp__btn--ghost', label);
    b.type = 'button';
    b.addEventListener('click', () => void navigator.clipboard?.writeText(text).then(() => (b.textContent = 'Copied')));
    return b;
  }

  // ---------------------------------------------------------------- create

  function updatePreview(): void {
    if (!previewEl) return;
    previewEl.textContent = '';
    const p = evmCurvePreview(form, tokenInfo);
    if (!p || !tokenInfo) {
      previewEl.append(h('p', 'wapp__fine', 'Fill in the token, how many tokens and how much to raise, and this shows how the curve would work.'));
      return;
    }
    const sym = evmCurveChain(form.chain)?.symbol ?? '';
    previewEl.append(h('span', 'wapp__eyebrow', 'How it would work'));
    const dl = h('dl', 'wapp__rows');
    row(dl, 'Sold along the curve', amountText(p.curveTokens, tokenInfo.decimals));
    row(dl, 'Kept for the pool', amountText(p.lpTokens, tokenInfo.decimals));
    row(dl, 'First token costs', `${p.startPrice} ${sym}`);
    row(dl, 'Last token costs', `${p.endPrice} ${sym}`);
    row(dl, 'The price rises', `${p.priceMultiple}× from first to last`);
    row(dl, 'Whole supply is worth', `${p.startValue} ${sym} at the start, ${p.endValue} ${sym} at the end`);
    previewEl.append(dl);
  }

  async function refreshToken(): Promise<void> {
    const t = form.token.trim();
    tokenInfo = null;
    updatePreview();
    const chain = evmCurveChain(form.chain);
    if (!chain || !isEvmAddress(t)) return;
    try {
      tokenInfo = await readFlow(form.chain).loadToken(chain, host.getAccount() ?? t, t);
    } catch {
      tokenInfo = null;
    }
    updatePreview();
  }

  function drawCreateForm(card: HTMLElement): void {
    const chain = evmCurveChain(form.chain);
    const sym = chain?.symbol ?? 'coin';
    card.append(
      h('p', 'wapp__fine', `Sell a token on Aretia’s own curve. Buyers pay ${sym} along a price curve; when every token on it is sold, the ${sym} raised and the tokens set aside open a locked liquidity pool. Aretia takes ${EVM_FEE_BPS / 100}% of each trade. Only tokens made on this page with Aretia’s token factory can be sold this way. Your own wallet signs everything.`),
    );
    const f = h('form', 'wapp__form wapp-ln__form');
    f.noValidate = true;
    f.append(field('Token address', 'curve-evm-token', form.token, (v) => (form = { ...form, token: v }), { mono: true, placeholder: '0x…', hint: 'A token you made on this page and still hold.', problem: problemFor('token'), onChange: () => void refreshToken() }));
    f.append(field('Tokens to commit', 'curve-evm-total', form.tokenAmount, (v) => { form = { ...form, tokenAmount: v }; updatePreview(); }, { inputmode: 'decimal', hint: 'In whole tokens. About four fifths go on the curve and the rest are kept for the pool.', problem: problemFor('tokenAmount') }));
    f.append(field(`${sym} to raise`, 'curve-evm-target', form.target, (v) => { form = { ...form, target: v }; updatePreview(); }, { inputmode: 'decimal', hint: 'The curve closes when buyers have paid in about this much.', problem: problemFor('target') }));
    const presets = h('div', 'wapp__row-actions');
    for (const t of EVM_TARGET_PRESETS) {
      const pb = h('button', `wapp__btn ${form.target === t ? 'wapp__btn--primary' : 'wapp__btn--ghost'}`, `${t} ${sym}`);
      pb.type = 'button';
      pb.addEventListener('click', () => {
        form = { ...form, target: t };
        redrawNow();
      });
      presets.append(pb);
    }
    f.append(presets);
    f.append(field(`Your own first buy, in ${sym} (optional)`, 'curve-evm-first', form.firstBuy, (v) => (form = { ...form, firstBuy: v }), { inputmode: 'decimal', hint: 'Bought in the same transaction as the curve is opened, before anyone else can. Leave empty for none.', problem: problemFor('firstBuy') }));
    previewEl = h('div', 'wapp-ln__field');
    previewEl.setAttribute('aria-live', 'polite');
    f.append(previewEl);
    updatePreview();
    const go = h('button', 'wapp__btn wapp__btn--primary', busy ? 'Checking…' : host.getAccount() ? 'Review' : 'Connect wallet and review');
    go.type = 'submit';
    go.disabled = busy;
    f.append(go);
    f.addEventListener('submit', (e) => {
      e.preventDefault();
      void startCreateReview();
    });
    card.append(f);
    const formIssue = issues.find((i) => i.field === 'form');
    if (formIssue) card.append(errorBox(formIssue.message));
    if (error) card.append(errorBox(error));
  }

  // ---------------------------------------------------------------- trade

  function drawTrade(card: HTMLElement): void {
    const chain = evmCurveChain(form.chain);
    card.append(h('p', 'wapp__fine', 'Look up a curve by its token address, then buy from it or sell back to it. Check who opened it: anyone holding some of a token can open its curve first.'));
    const f = h('form', 'wapp__form wapp-ln__form');
    f.noValidate = true;
    f.append(field('Token address', 'curve-evm-lookup', lookup, (v) => (lookup = v), { mono: true, placeholder: '0x…' }));
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
    if (!curve || !curveToken || !chain) return;
    const c = curve;
    const dec = curveToken.decimals;
    const sym = chain.symbol;
    const dl = h('dl', 'wapp__rows');
    row(dl, 'Token', `${curveToken.symbol} (${lookup.trim().toLowerCase()})`);
    row(dl, 'Opened by', c.creator);
    row(dl, 'State', { none: 'No curve', trading: 'Open for trading', soldOut: 'Sold out, waiting to move into a pool', migrated: 'Moved into a locked pool', aborted: 'Unwound: selling only' }[c.status]);
    row(dl, 'Price now', `${evmPriceText(c, dec)} ${sym} per token`);
    row(dl, 'Sold so far', `${amountText(c.curveTokens - c.realTok, dec)} of ${amountText(c.curveTokens, dec)}`);
    row(dl, `${sym} raised so far`, `${fromSmallestUnit(c.realSol, 18)} of about ${fromSmallestUnit(c.target, 18)} ${sym}`);
    const pct = c.curveTokens === 0n ? 0 : c.realTok === 0n ? 100 : Math.min(99, Number(((c.curveTokens - c.realTok) * 100n) / c.curveTokens));
    const bar = h('progress');
    bar.max = 100;
    bar.value = pct;
    bar.setAttribute('aria-label', `${pct}% of the curve sold`);
    row(dl, 'Progress', bar);
    row(dl, 'Fee', `${Number(c.feeBps) / 100}% of each trade, to Aretia`);
    card.append(dl);
    card.append(copyButton('Copy link to this curve', shareLink(lookup.trim())));

    const slip = h('div', 'wapp-ln__field');
    const sl = h('label', 'wapp__eyebrow', 'Accept at most this much slippage');
    sl.htmlFor = 'curve-evm-slip';
    const select = h('select', 'wapp__input');
    select.id = 'curve-evm-slip';
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
          redrawNow();
        });
        seg.append(b);
      }
      card.append(seg);
    }
    if (side === 'buy' && canBuy) {
      const buy = h('button', 'wapp__btn wapp__btn--primary', 'Review buy');
      buy.type = 'button';
      buy.disabled = busy;
      buy.addEventListener('click', () => void startTrade('buy'));
      card.append(field(`Buy with (${sym})`, 'curve-evm-buy', buyText, (v) => (buyText = v), { inputmode: 'decimal', placeholder: '0.1' }), buy);
    }
    if (side === 'sell' && canSell) {
      const sell = h('button', 'wapp__btn wapp__btn--primary', 'Review sell');
      sell.type = 'button';
      sell.disabled = busy;
      sell.addEventListener('click', () => void startTrade('sell'));
      card.append(field('Sell (tokens)', 'curve-evm-sell', sellText, (v) => (sellText = v), { inputmode: 'decimal', placeholder: '1,000' }), sell);
    }
    const actions = h('div', 'wapp__row-actions');
    if (evmCanGraduate(c)) {
      const g = h('button', 'wapp__btn wapp__btn--primary', 'Move into a pool');
      g.type = 'button';
      g.disabled = busy;
      g.addEventListener('click', () => void startTrade('graduate'));
      actions.append(g);
    }
    if (evmCanAbort(c, Math.floor(Date.now() / 1000))) {
      const a = h('button', 'wapp__btn wapp__btn--ghost', 'Unwind this curve');
      a.type = 'button';
      a.disabled = busy;
      a.addEventListener('click', () => void startTrade('abort'));
      actions.append(a);
    }
    if (actions.childNodes.length) card.append(actions);
  }

  // ---------------------------------------------------------------- review, working, done

  function drawReview(card: HTMLElement): void {
    if (!review) return;
    const r = review;
    const sym = r.chain.symbol;
    card.append(h('span', 'wapp__eyebrow', 'Review'));
    card.append(h('p', 'wapp__banner wapp__banner--warn', `This is a real transaction on ${r.chain.name} and spends real ${sym}. Read it all before you approve. Nothing is sent until you press the button at the bottom.`));
    const dl = h('dl', 'wapp__rows');
    if (r.kind === 'create') {
      const c = r.config;
      const p = evmCurvePreview({ tokenAmount: fromSmallestUnit(c.totalRaw, c.tokenDecimals), target: fromSmallestUnit(c.targetWei, 18) }, { decimals: c.tokenDecimals, supply: c.tokenSupply });
      row(dl, 'Token', `${c.tokenSymbol} (${short(c.token)})`);
      row(dl, 'Tokens committed', amountText(c.totalRaw, c.tokenDecimals));
      row(dl, 'Sold along the curve', amountText(c.derived.curveTokens, c.tokenDecimals));
      row(dl, 'Kept for the pool', amountText(c.derived.lpTokens, c.tokenDecimals));
      row(dl, 'Raises about', `${fromSmallestUnit(c.targetWei, 18)} ${sym}`);
      if (p) {
        row(dl, 'Starting price', `${p.startPrice} ${sym} per token`);
        row(dl, 'Price when the curve closes', `${p.endPrice} ${sym} per token`);
      }
      if (r.firstBuy) row(dl, 'Your first buy', `${fromSmallestUnit(r.firstBuy.gross, 18)} ${sym} for ${amountText(r.firstBuy.tokensOut, c.tokenDecimals)} tokens (Aretia fee ${fromSmallestUnit(r.firstBuy.fee, 18)} ${sym} included)`);
      row(dl, 'Two transactions', 'First an approval for exactly these tokens, then the curve');
    } else if (r.kind === 'buy' && curveToken) {
      row(dl, 'Token', `${curveToken.symbol} (${short(r.token)})`);
      row(dl, 'You pay', `${fromSmallestUnit(r.quote?.gross ?? r.wei, 18)} ${sym}`);
      if (r.quote) {
        row(dl, 'Aretia fee (included)', `${fromSmallestUnit(r.quote.fee, 18)} ${sym}`);
        row(dl, 'You get about', `${amountText(r.quote.tokensOut, curveToken.decimals)} tokens`);
        row(dl, 'At least', `${amountText(r.minOut, curveToken.decimals)} tokens`);
      }
    } else if (r.kind === 'sell' && curveToken) {
      row(dl, 'Token', `${curveToken.symbol} (${short(r.token)})`);
      row(dl, 'You sell', `${amountText(r.tokens, curveToken.decimals)} tokens`);
      if (r.quote) {
        row(dl, 'Aretia fee (taken)', `${fromSmallestUnit(r.quote.fee, 18)} ${sym}`);
        row(dl, 'You receive about', `${fromSmallestUnit(r.quote.net, 18)} ${sym}`);
        row(dl, 'At least', `${fromSmallestUnit(r.minOut, 18)} ${sym}`);
      }
      row(dl, 'Two transactions', 'First an approval for exactly these tokens, then the sale');
    } else if (r.kind === 'graduate') {
      row(dl, 'Token', short(r.token));
      row(dl, `${sym} into the pool`, `${fromSmallestUnit(r.curve.realSol, 18)} ${sym}`);
      row(dl, 'Tokens into the pool', curveToken ? amountText(r.curve.lpTokens, curveToken.decimals) : String(r.curve.lpTokens));
      row(dl, 'Where the liquidity goes', 'The dead address: nobody can ever take it out');
    } else {
      row(dl, 'Token', short(r.token));
    }
    row(dl, 'Network gas, at most about', r.gasCostWei === null ? 'could not be estimated' : `${fromSmallestUnit(r.gasCostWei, 18)} ${sym}`);
    row(dl, `Your ${sym}`, `${fromSmallestUnit(r.coinBalance, 18)} ${sym}`);
    card.append(dl);
    card.append(h('span', 'wapp__eyebrow', 'What this means'));
    const list = h('ul', 'wapp__list');
    for (const d of evmCurveDisclosures(r.kind, sym)) {
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
    ack.append(box, h('span', '', 'I understand this is a real transaction, costs about the amounts above plus network gas, and cannot be undone.'));
    card.append(ack);
    const actions = h('div', 'wapp__row-actions');
    const back = h('button', 'wapp__btn wapp__btn--ghost', 'Back');
    back.type = 'button';
    back.addEventListener('click', () => {
      stage = 'form';
      review = null;
      acknowledged = false;
      error = null;
      redrawNow();
    });
    go.addEventListener('click', () => void run());
    actions.append(go, back);
    card.append(actions);
    if (error) card.append(errorBox(error));
  }

  function drawWorking(card: HTMLElement): void {
    card.append(h('span', 'wapp__eyebrow', 'Working'), h('h3', 'wapp__h2', 'Sending'));
    card.append(h('p', 'wapp__fine', 'Keep this page open. Your wallet will ask you to approve each transaction, one after the other.'));
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
    const chain = evmCurveChain(form.chain);
    const ok = outcome.differences.length === 0;
    card.append(h('span', 'wapp__eyebrow', ok ? 'Done' : 'Done, with differences'));
    card.append(ok ? h('p', 'wapp__banner', 'Read back from the network: it matches what you approved.') : errorBox(`The network does not show exactly what you approved: ${outcome.differences.join(' ')}`));
    const dl = h('dl', 'wapp__rows');
    row(dl, 'Token', outcome.token);
    outcome.hashes.forEach((hash, i) => row(dl, outcome!.hashes.length > 1 ? `Transaction ${i + 1}` : 'Transaction', chain ? link(short(hash), `${chain.explorer}/tx/${encodeURIComponent(hash)}`) : hash));
    card.append(dl);
    if (tab === 'create' && ok) {
      card.append(h('p', 'wapp__fine', 'Your curve is open. Share this link so people can buy from it.'));
      card.append(copyButton('Copy link to your curve', shareLink(outcome.token)));
      const view = h('button', 'wapp__btn wapp__btn--primary', 'View your curve');
      view.type = 'button';
      view.addEventListener('click', () => {
        tab = 'trade';
        lookup = outcome!.token;
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
      else redrawNow();
    });
    card.append(again);
  }

  // ---------------------------------------------------------------- actions

  async function startCreateReview(): Promise<void> {
    error = null;
    busy = true;
    redrawNow();
    try {
      if (!adapter) adapter = (await host.connect()).adapter;
      const creator = host.getAccount() ?? '';
      const chain = evmCurveChain(form.chain);
      const t = form.token.trim();
      tokenInfo = chain && isEvmAddress(t) ? await readFlow(form.chain).loadToken(chain, creator || t, t).catch(() => null) : null;
      const v = validateEvmCurve(form, creator, tokenInfo);
      issues = v.ok ? [] : v.issues;
      if (!v.ok) return;
      review = await flowFor(form.chain, adapter).prepareCreate(v.config);
      stage = 'review';
      acknowledged = false;
    } catch (e) {
      error = `Could not check this curve: ${friendlyEvmError(e)}`;
    } finally {
      busy = false;
      redrawNow();
    }
  }

  async function findCurve(): Promise<void> {
    error = null;
    lookupNote = null;
    curve = null;
    busy = true;
    redrawNow();
    try {
      const chain = evmCurveChain(form.chain);
      const t = lookup.trim().toLowerCase();
      if (!chain) throw new Error('The curve is not available on this network.');
      if (!isEvmAddress(t) || isSolanaAddress(t)) lookupNote = 'Enter a token address starting with 0x.';
      else {
        const f = readFlow(form.chain);
        const found = await f.loadCurve(chain, t);
        if (!found) lookupNote = 'No curve was found for that token on this network.';
        else {
          const info = await f.loadToken(chain, host.getAccount() ?? found.creator, t);
          if (!info) lookupNote = 'That curve’s token could not be read.';
          else {
            curve = found;
            curveToken = info;
          }
        }
      }
    } catch (e) {
      error = `Could not look that up: ${friendlyEvmError(e)}`;
    } finally {
      busy = false;
      redrawNow();
    }
  }

  async function startTrade(kind: 'buy' | 'sell' | 'graduate' | 'abort'): Promise<void> {
    error = null;
    busy = true;
    redrawNow();
    try {
      if (!adapter) adapter = (await host.connect()).adapter;
      const account = host.getAccount() ?? '';
      const chain = evmCurveChain(form.chain);
      const token = lookup.trim().toLowerCase();
      if (!chain || !account || !curveToken) throw new Error('Connect a wallet first.');
      const f = flowFor(form.chain, adapter);
      // Read the curve again so the numbers are as fresh as the network can give.
      const latest = await f.loadCurve(chain, token);
      if (!latest) throw new Error('The curve could not be read.');
      curve = latest;
      if (kind === 'buy') {
        const wei = coinToWei(buyText);
        if (wei === null) throw new Error(`Enter an amount of ${chain.symbol} above zero.`);
        review = await f.prepareBuy(chain, account, latest, token, wei, slippage);
      } else if (kind === 'sell') {
        const raw = fromSmallestUnitInput(sellText, curveToken.decimals);
        if (raw === null) throw new Error('Enter an amount of tokens above zero.');
        review = await f.prepareSell(chain, account, latest, token, raw, slippage);
      } else if (kind === 'graduate') review = await f.prepareGraduate(chain, account, latest, token);
      else review = await f.prepareAbort(chain, account, latest, token);
      stage = 'review';
      acknowledged = false;
    } catch (e) {
      error = `Could not check this: ${friendlyEvmError(e)}`;
    } finally {
      busy = false;
      redrawNow();
    }
  }

  async function run(): Promise<void> {
    const r = review;
    if (!r || !acknowledged || !adapter) return;
    busy = true;
    stage = 'working';
    progress = 'checking';
    error = null;
    redrawNow();
    try {
      const f = flowFor(form.chain, adapter);
      const tick = (p: EvmCurveProgress) => {
        progress = p;
        redrawNow();
      };
      outcome = r.kind === 'create' ? await f.create(r, tick) : r.kind === 'buy' ? await f.buy(r, tick) : r.kind === 'sell' ? await f.sell(r, tick) : r.kind === 'graduate' ? await f.graduate(r, tick) : await f.abort(r, tick);
      stage = 'done';
    } catch (e) {
      // The flow's own messages are already plain and complete: show them whole, not shortened.
      error = e instanceof EvmCurveError ? e.message : friendlyEvmError(e);
      stage = 'review';
    } finally {
      busy = false;
      review = stage === 'done' ? null : review;
      redrawNow();
    }
  }

  function fromSmallestUnitInput(text: string, decimals: number): bigint | null {
    const m = /^(\d{1,40})(?:\.(\d{1,40}))?$/.exec(text.replace(/,/g, '').trim());
    if (!m || (m[2] ?? '').length > decimals) return null;
    const v = BigInt(m[1]!) * 10n ** BigInt(decimals) + BigInt((m[2] ?? '').padEnd(decimals, '0') || '0');
    return v > 0n ? v : null;
  }

  return {
    draw(card, redraw, chainKey, suggestToken): void {
      redrawNow = redraw;
      const chain = evmCurveChain(chainKey);
      card.dataset.stage = chain ? stage : 'off';
      const section = h('div', 'wapp-ln');
      section.append(h('h3', 'wapp__h2', 'Sell on a bonding curve'));
      if (!chain) {
        // No deployed contract on this network: say so and offer nothing. This is every network until the contract is audited and deployed.
        const name = chainByKey(chainKey)?.name ?? 'this network';
        section.append(h('p', 'wapp__banner wapp__banner--warn', `Not live on ${name}. The curve contract is built and tested, but it has not been independently audited, so it is not deployed and this page does not send anything.`));
        card.append(section);
        return;
      }
      if (form.chain !== chainKey) {
        form = { ...form, chain: chainKey };
        stage = 'form';
        review = null;
        outcome = null;
        acknowledged = false;
        error = null;
        issues = [];
        curve = null;
      }
      if (suggestToken && suggestToken !== lastSuggest) {
        lastSuggest = suggestToken;
        if (form.token.trim() === '') {
          form = { ...form, token: suggestToken };
          void refreshToken();
        }
      }
      if (!deepLinkDone) {
        deepLinkDone = true;
        const shared = parseEvmCurveHash(location.hash);
        if (shared && shared.chain === chainKey) {
          tab = 'trade';
          lookup = shared.token;
          void findCurve();
        }
      }
      if (stage === 'form') {
        const bar = h('div', 'wapp__row-actions');
        for (const [id, label] of [['create', 'Open a curve'], ['trade', 'Trade a curve']] as const) {
          const b = h('button', `wapp__btn ${tab === id ? 'wapp__btn--primary' : 'wapp__btn--ghost'}`, label);
          b.type = 'button';
          b.disabled = busy;
          b.addEventListener('click', () => {
            tab = id;
            error = null;
            redrawNow();
          });
          bar.append(b);
        }
        section.append(bar);
        if (tab === 'create') drawCreateForm(section);
        else drawTrade(section);
      } else if (stage === 'review') drawReview(section);
      else if (stage === 'working') drawWorking(section);
      else drawDone(section);
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
      curve = null;
    },
  };
}
