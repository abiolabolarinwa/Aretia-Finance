/**
 * The Ethereum-style half of the Aretia Pool card on the Launch page: open a pool for a token made on this page, trade a pool, and manage a
 * position (claim fees, add or remove liquidity, lock, point the fees at another wallet, hand the position on). Rules are in
 * walletAretiaPoolEvmCore.ts, the transactions and their inspectors in walletAretiaPoolEvmTx.ts, the order of events in
 * walletAretiaPoolEvmFlow.ts. This file only draws and connects them to the wallet the page already uses. Everything typed, and everything
 * read back from the chain, is shown with textContent, never as markup.
 *
 * It is off by default: walletLaunchEvm.ts only creates it on a build with PUBLIC_ARETIA_POOL_EVM_ENABLED=1, and even then it shows a notice
 * and no form for any network that has no deployed contract in EVM_POOL_ADDRESSES, which is every network until the contract is deployed.
 * Docs: docs/ARETIA_POOL_EVM.md. The contract is UNAUDITED.
 */
import type { EvmWalletAdapter } from '../swings/chains/evmWallet.js';
import type { EvmRead } from '../swings/chains/evmSession.js';
import { SLIPPAGE_PRESETS_BPS, fromSmallestUnit, isSolanaAddress } from './walletTools';
import { chainByKey, isEvmAddress, type LaunchEvmChainKey } from './walletLaunchEvmCore';
import { friendlyEvmError } from './walletLaunchEvmFlow';
import { coinToWei } from './walletCurveEvmCore';
import {
  DEFAULT_EVM_POOL_FORM,
  POOL_SLIPPAGE_BPS_DEFAULT,
  evmPoolChain,
  evmPoolDisclosures,
  evmPoolPreview,
  evmPoolShareHash,
  lockTextOf,
  parseEvmPoolHash,
  poolClaimable,
  poolPriceText,
  validateEvmPool,
  type EvmPoolForm,
  type EvmPoolIssue,
  type EvmPoolState,
  type EvmPoolToken,
  type EvmPosition,
} from './walletAretiaPoolEvmCore';
import { EvmPoolError, EvmPoolFlow, type EvmPoolOutcome, type EvmPoolProgress, type EvmPoolReview } from './walletAretiaPoolEvmFlow';

export interface PoolEvmHost {
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

const STEPS: { id: EvmPoolProgress; label: string }[] = [
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
type Manage = 'claim' | 'add' | 'remove' | 'lock' | 'recipient' | 'transfer';

const FEE_TIERS: { id: string; label: string }[] = [
  { id: '0.25', label: '0.25% per trade' },
  { id: '1', label: '1% per trade' },
];

export function createEvmAretiaPool(host: PoolEvmHost): { draw(card: HTMLElement, redraw: () => void, chainKey: LaunchEvmChainKey, suggestToken: string | null): void; reset(): void; isBusy(): boolean } {
  let tab: Tab = 'create';
  let side: 'buy' | 'sell' = 'buy';
  let stage: Stage = 'form';
  let form: EvmPoolForm = { ...DEFAULT_EVM_POOL_FORM };
  let issues: EvmPoolIssue[] = [];
  let tokenInfo: EvmPoolToken | null = null;
  let review: EvmPoolReview | null = null;
  let outcome: EvmPoolOutcome | null = null;
  let error: string | null = null;
  let progress: EvmPoolProgress = 'checking';
  let busy = false;
  let acknowledged = false;
  let adapter: EvmWalletAdapter | null = null;
  let redrawNow: () => void = () => undefined;
  let lastSuggest: string | null = null;
  let deepLinkDone = false;
  let previewEl: HTMLElement | null = null;

  // Trading and managing.
  let lookup = '';
  let pool: EvmPoolState | null = null;
  let poolToken: EvmPoolToken | null = null;
  let position: EvmPosition | null = null;
  let lookupNote: string | null = null;
  let buyText = '';
  let sellText = '';
  let addText = '';
  let removePct = '25';
  let recipientText = '';
  let transferText = '';
  let slippage: number = POOL_SLIPPAGE_BPS_DEFAULT;

  const flowFor = (chainKey: LaunchEvmChainKey, a: EvmWalletAdapter): EvmPoolFlow =>
    new EvmPoolFlow({ adapter: a, read: host.readerFor(chainKey), now: () => Date.now(), nowSeconds: () => Math.floor(Date.now() / 1000) });
  /** A flow that only reads: used before a wallet is connected, for the preview and for looking a pool up. */
  const readFlow = (chainKey: LaunchEvmChainKey): EvmPoolFlow =>
    new EvmPoolFlow({
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
  const problemFor = (name: keyof EvmPoolForm): string | undefined => issues.find((i) => i.field === name)?.message;
  const shareLink = (token: string): string => `${location.origin}${location.pathname}${evmPoolShareHash(form.chain, token)}`;
  function copyButton(label: string, text: string): HTMLButtonElement {
    const b = h('button', 'wapp__btn wapp__btn--ghost', label);
    b.type = 'button';
    b.addEventListener('click', () => void navigator.clipboard?.writeText(text).then(() => (b.textContent = 'Copied')));
    return b;
  }
  function button(label: string, primary: boolean, onClick: () => void, disabled = false): HTMLButtonElement {
    const b = h('button', `wapp__btn ${primary ? 'wapp__btn--primary' : 'wapp__btn--ghost'}`, label);
    b.type = 'button';
    b.disabled = disabled || busy;
    b.addEventListener('click', onClick);
    return b;
  }
  const unitsFrom = (text: string, decimals: number): bigint | null => {
    const m = /^(\d{1,40})(?:\.(\d{1,40}))?$/.exec(text.replace(/,/g, '').trim());
    if (!m || (m[2] ?? '').length > decimals) return null;
    const v = BigInt(m[1]!) * 10n ** BigInt(decimals) + BigInt((m[2] ?? '').padEnd(decimals, '0') || '0');
    return v > 0n ? v : null;
  };

  // ---------------------------------------------------------------- create

  function updatePreview(): void {
    if (!previewEl) return;
    previewEl.textContent = '';
    const chain = evmPoolChain(form.chain);
    const p = chain ? evmPoolPreview(form, tokenInfo, chain.creationFee) : null;
    if (!p || !tokenInfo || !chain) {
      previewEl.append(h('p', 'wapp__fine', 'Fill in the token, how many tokens and a starting price, and this shows how the pool would open.'));
      return;
    }
    const sym = chain.symbol;
    previewEl.append(h('span', 'wapp__eyebrow', 'How it would open'));
    const dl = h('dl', 'wapp__rows');
    row(dl, 'You put in', `${form.tokenAmount} ${tokenInfo.symbol} and no ${sym}`);
    row(dl, 'First token costs', `${p.startPrice} ${sym}`);
    row(dl, 'Whole supply is worth', `${p.startValue} ${sym} at the start`);
    row(dl, 'You pay Aretia once', `${fromSmallestUnit(chain.creationFee, 18)} ${sym}, plus network gas${form.firstBuy.trim() ? ` and your first buy of ${form.firstBuy.trim()} ${sym}` : ''}`);
    row(dl, 'Your liquidity', 'Locked for good. The fees it earns stay claimable.');
    previewEl.append(dl);
  }

  async function refreshToken(): Promise<void> {
    const t = form.token.trim();
    tokenInfo = null;
    updatePreview();
    const chain = evmPoolChain(form.chain);
    if (!chain || !isEvmAddress(t)) return;
    try {
      tokenInfo = await readFlow(form.chain).loadToken(chain, host.getAccount() ?? t, t);
    } catch {
      tokenInfo = null;
    }
    updatePreview();
  }

  function drawCreateForm(card: HTMLElement): void {
    const chain = evmPoolChain(form.chain);
    const sym = chain?.symbol ?? 'coin';
    card.append(
      h('p', 'wapp__fine', `Open Aretia’s own pool for a token. You put in tokens only; buyers pay ${sym} and the price rises. Aretia keeps 20% of every trading fee, and the rest goes to the people providing liquidity. Your liquidity is locked for good, and you can still claim its fees. Only tokens made on this page with Aretia’s token factory can have a pool. Your own wallet signs everything.`),
    );
    const f = h('form', 'wapp__form wapp-ln__form');
    f.noValidate = true;
    f.append(field('Token address', 'apool-evm-token', form.token, (v) => (form = { ...form, token: v }), { mono: true, placeholder: '0x…', hint: 'A token you made on this page and still hold.', problem: problemFor('token'), onChange: () => void refreshToken() }));
    f.append(field('Tokens to put in', 'apool-evm-total', form.tokenAmount, (v) => { form = { ...form, tokenAmount: v }; updatePreview(); }, { inputmode: 'decimal', hint: 'In whole tokens.', problem: problemFor('tokenAmount') }));
    f.append(field(`Starting price (${sym} per token)`, 'apool-evm-price', form.startPrice, (v) => { form = { ...form, startPrice: v }; updatePreview(); }, { inputmode: 'decimal', hint: 'Where buyers start. The price never falls below it.', problem: problemFor('startPrice') }));
    const tiers = h('div', 'wapp__row-actions');
    for (const t of FEE_TIERS) {
      const pb = h('button', `wapp__btn ${form.feeTier === t.id ? 'wapp__btn--primary' : 'wapp__btn--ghost'}`, t.label);
      pb.type = 'button';
      pb.addEventListener('click', () => {
        form = { ...form, feeTier: t.id };
        redrawNow();
      });
      tiers.append(pb);
    }
    f.append(h('span', 'wapp__eyebrow', 'Trading fee'), tiers);
    if (problemFor('feeTier')) f.append(errorBox(problemFor('feeTier')!));
    f.append(field(`Your own first buy, in ${sym} (optional)`, 'apool-evm-first', form.firstBuy, (v) => { form = { ...form, firstBuy: v }; updatePreview(); }, { inputmode: 'decimal', hint: 'Bought in the same transaction as the pool opens, before anyone else can. Leave empty for none.', problem: problemFor('firstBuy') }));
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

  // ---------------------------------------------------------------- trade and manage

  function drawTrade(card: HTMLElement): void {
    const chain = evmPoolChain(form.chain);
    card.append(h('p', 'wapp__fine', 'Look up a pool by its token address, then buy from it, sell to it, or manage your position. Check who opened it: anyone holding some of a token can open its pool first.'));
    const f = h('form', 'wapp__form wapp-ln__form');
    f.noValidate = true;
    f.append(field('Token address', 'apool-evm-lookup', lookup, (v) => (lookup = v), { mono: true, placeholder: '0x…' }));
    const go = h('button', 'wapp__btn wapp__btn--primary', busy ? 'Looking…' : 'Find the pool');
    go.type = 'submit';
    go.disabled = busy;
    f.append(go);
    f.addEventListener('submit', (e) => {
      e.preventDefault();
      void findPool();
    });
    card.append(f);
    if (lookupNote) card.append(errorBox(lookupNote));
    if (error) card.append(errorBox(error));
    if (!pool || !poolToken || !chain) return;
    const p = pool;
    const dec = poolToken.decimals;
    const sym = chain.symbol;
    const dl = h('dl', 'wapp__rows');
    row(dl, 'Token', `${poolToken.symbol} (${lookup.trim().toLowerCase()})`);
    row(dl, 'Opened by', p.creator);
    row(dl, 'Price now', `${poolPriceText(p, dec)} ${sym} per token`);
    row(dl, 'Tokens in the pool', amountText(p.x, dec));
    row(dl, `${sym} in the pool`, `${fromSmallestUnit(p.y, 18)} ${sym}`);
    row(dl, 'Fee', `${Number(p.feeBps) / 100}% of each trade: 20% of it to Aretia, 80% to liquidity providers`);
    card.append(dl);
    card.append(copyButton('Copy link to this pool', shareLink(lookup.trim())));

    const slip = h('div', 'wapp-ln__field');
    const sl = h('label', 'wapp__eyebrow', 'Accept at most this much slippage');
    sl.htmlFor = 'apool-evm-slip';
    const select = h('select', 'wapp__input');
    select.id = 'apool-evm-slip';
    for (const bps of SLIPPAGE_PRESETS_BPS) {
      const o = h('option', '', `${bps / 100}%`);
      o.value = String(bps);
      o.selected = bps === slippage;
      select.append(o);
    }
    select.addEventListener('change', () => (slippage = Number(select.value)));
    slip.append(sl, select);
    card.append(slip);

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
    if (side === 'buy') card.append(field(`Buy with (${sym})`, 'apool-evm-buy', buyText, (v) => (buyText = v), { inputmode: 'decimal', placeholder: '0.1' }), button('Review buy', true, () => void startAction('buy')));
    else card.append(field('Sell (tokens)', 'apool-evm-sell', sellText, (v) => (sellText = v), { inputmode: 'decimal', placeholder: '1,000' }), button('Review sell', true, () => void startAction('sell')));

    // Your position in this pool.
    const pos = position;
    card.append(h('span', 'wapp__eyebrow', 'Your position'));
    if (!pos || !pos.open) {
      card.append(h('p', 'wapp__fine', host.getAccount() ? 'You have no position in this pool. You can add liquidity below.' : 'Connect a wallet to see your position.'));
    } else {
      const pl = h('dl', 'wapp__rows');
      row(pl, 'Liquidity', `${pos.shares} units`);
      row(pl, 'Lock', lockTextOf(pos));
      row(pl, 'Fees you can claim', `${fromSmallestUnit(poolClaimable(p, pos), 18)} ${sym}`);
      row(pl, 'Fees are paid to', pos.recipient ?? 'your own wallet');
      card.append(pl);
    }
    const manage = h('div', 'wapp__row-actions');
    if (pos?.open) {
      manage.append(button('Claim fees', true, () => void startAction('claim'), poolClaimable(p, pos) === 0n));
      if (pos.shares > pos.locked) manage.append(button('Lock the rest for good', false, () => void startAction('lock')));
    }
    card.append(manage);
    card.append(field(`Add liquidity (tokens, with the matching ${sym})`, 'apool-evm-add', addText, (v) => (addText = v), { inputmode: 'decimal', placeholder: '1,000', hint: 'You pay tokens and coin in the pool’s current proportion. The page shows the most you will pay.' }), button('Review add', false, () => void startAction('add')));
    if (pos?.open && pos.shares > pos.locked) {
      card.append(field('Take out (% of your unlocked liquidity)', 'apool-evm-remove', removePct, (v) => (removePct = v), { inputmode: 'numeric', placeholder: '25' }), button('Review take out', false, () => void startAction('remove')));
    }
    if (pos?.open) {
      card.append(
        field('Send my fees to another wallet (address)', 'apool-evm-recipient', recipientText, (v) => (recipientText = v), { mono: true, placeholder: '0x…', hint: 'Works even while the liquidity is locked. You can change it again at any time.' }),
        button('Review change', false, () => void startAction('recipient')),
        field('Hand this whole position to another wallet (address)', 'apool-evm-transfer', transferText, (v) => (transferText = v), { mono: true, placeholder: '0x…', hint: 'Locked liquidity and unclaimed fees go with it. You cannot get it back.' }),
        button('Review hand-over', false, () => void startAction('transfer')),
      );
    }
  }

  // ---------------------------------------------------------------- review, working, done

  function drawReview(card: HTMLElement): void {
    if (!review) return;
    const r = review;
    const sym = r.chain.symbol;
    const dec = poolToken?.decimals ?? r.config?.tokenDecimals ?? 18;
    card.append(h('span', 'wapp__eyebrow', 'Review'));
    card.append(h('p', 'wapp__banner wapp__banner--warn', `This is a real transaction on ${r.chain.name} and spends real ${sym}. Read it all before you approve. Nothing is sent until you press the button at the bottom.`));
    const dl = h('dl', 'wapp__rows');
    if (r.kind === 'create' && r.config) {
      const c = r.config;
      row(dl, 'Token', `${c.tokenSymbol} (${short(c.token)})`);
      row(dl, 'Tokens you put in', amountText(c.x0, c.tokenDecimals));
      row(dl, 'Trading fee', `${c.feeBps / 100}% per trade (20% of it to Aretia)`);
      row(dl, 'Your liquidity', 'Locked for good');
      row(dl, 'Creation fee to Aretia', `${fromSmallestUnit(r.chain.creationFee, 18)} ${sym}`);
      if (r.buyQuote) row(dl, 'Your first buy', `${fromSmallestUnit(r.buyQuote.gross, 18)} ${sym} for ${amountText(r.buyQuote.tokensOut, c.tokenDecimals)} tokens (trading fee ${fromSmallestUnit(r.buyQuote.fee, 18)} ${sym} included)`);
      row(dl, 'Two transactions', 'First an approval for exactly these tokens, then the pool');
    } else if (r.kind === 'buy' && r.buyQuote) {
      row(dl, 'You pay', `${fromSmallestUnit(r.buyQuote.gross, 18)} ${sym}`);
      row(dl, 'Trading fee (included)', `${fromSmallestUnit(r.buyQuote.fee, 18)} ${sym}, of which Aretia ${fromSmallestUnit(r.buyQuote.protocol, 18)}`);
      row(dl, 'You get about', `${amountText(r.buyQuote.tokensOut, dec)} tokens`);
      row(dl, 'At least', `${amountText(r.minOut ?? 0n, dec)} tokens`);
    } else if (r.kind === 'sell' && r.sellQuote) {
      row(dl, 'Trading fee (taken)', `${fromSmallestUnit(r.sellQuote.fee, 18)} ${sym}, of which Aretia ${fromSmallestUnit(r.sellQuote.protocol, 18)}`);
      row(dl, 'You receive about', `${fromSmallestUnit(r.sellQuote.net, 18)} ${sym}`);
      row(dl, 'At least', `${fromSmallestUnit(r.minOut ?? 0n, 18)} ${sym}`);
      row(dl, 'Two transactions', 'First an approval for exactly these tokens, then the sale');
    } else {
      row(dl, 'Token', short(r.token));
      row(dl, 'Action', r.steps.map((s) => s.what).join(', then '));
      if (r.coinOut > 0n) row(dl, `${sym} you pay`, `${fromSmallestUnit(r.coinOut, 18)} ${sym} (any excess is sent back)`);
    }
    row(dl, 'Network gas, at most about', r.gasCostWei === null ? 'could not be estimated' : `${fromSmallestUnit(r.gasCostWei, 18)} ${sym}`);
    row(dl, `Your ${sym}`, `${fromSmallestUnit(r.coinBalance, 18)} ${sym}`);
    card.append(dl);
    card.append(h('span', 'wapp__eyebrow', 'What this means'));
    const list = h('ul', 'wapp__list');
    const kind = r.kind === 'transfer' || r.kind === 'recipient' ? 'claim' : r.kind;
    for (const d of evmPoolDisclosures(kind, sym)) {
      const li = h('li');
      li.append(h('b', '', d.severity === 'caution' ? 'Note: ' : ''), document.createTextNode(d.text));
      list.append(li);
    }
    if (r.kind === 'transfer') list.append(h('li', '', 'Handing a position over cannot be undone. The other wallet gets the liquidity, the lock and the unclaimed fees; you keep nothing.'));
    if (r.kind === 'recipient') list.append(h('li', '', 'From now on your fees are paid to the wallet named. You can change it again at any time.'));
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
    const chain = evmPoolChain(form.chain);
    const ok = outcome.differences.length === 0;
    card.append(h('span', 'wapp__eyebrow', ok ? 'Done' : 'Done, with differences'));
    card.append(ok ? h('p', 'wapp__banner', 'Read back from the network: it matches what you approved.') : errorBox(`The network does not show exactly what you approved: ${outcome.differences.join(' ')}`));
    const dl = h('dl', 'wapp__rows');
    row(dl, 'Token', outcome.token);
    outcome.hashes.forEach((hash, i) => row(dl, outcome!.hashes.length > 1 ? `Transaction ${i + 1}` : 'Transaction', chain ? link(short(hash), `${chain.explorer}/tx/${encodeURIComponent(hash)}`) : hash));
    card.append(dl);
    if (tab === 'create' && ok) {
      card.append(h('p', 'wapp__fine', 'Your pool is open. Share this link so people can buy.'));
      card.append(copyButton('Copy link to your pool', shareLink(outcome.token)));
      card.append(
        button('View your pool', true, () => {
          tab = 'trade';
          lookup = outcome!.token;
          stage = 'form';
          outcome = null;
          void findPool();
        }),
      );
    }
    card.append(
      button('Back', true, () => {
        stage = 'form';
        review = null;
        outcome = null;
        acknowledged = false;
        error = null;
        if (tab === 'trade' && lookup) void findPool();
        else redrawNow();
      }),
    );
  }

  // ---------------------------------------------------------------- actions

  async function startCreateReview(): Promise<void> {
    error = null;
    busy = true;
    redrawNow();
    try {
      if (!adapter) adapter = (await host.connect()).adapter;
      const creator = host.getAccount() ?? '';
      const chain = evmPoolChain(form.chain);
      const t = form.token.trim();
      tokenInfo = chain && isEvmAddress(t) ? await readFlow(form.chain).loadToken(chain, creator || t, t).catch(() => null) : null;
      const existing = chain && isEvmAddress(t) ? await readFlow(form.chain).loadPool(chain, t.toLowerCase()).catch(() => null) : null;
      const v = validateEvmPool(form, creator, tokenInfo, existing !== null);
      issues = v.ok ? [] : v.issues;
      if (!v.ok) return;
      review = await flowFor(form.chain, adapter).prepareCreate(v.config);
      stage = 'review';
      acknowledged = false;
    } catch (e) {
      error = `Could not check this pool: ${friendlyEvmError(e)}`;
    } finally {
      busy = false;
      redrawNow();
    }
  }

  async function findPool(): Promise<void> {
    error = null;
    lookupNote = null;
    pool = null;
    position = null;
    busy = true;
    redrawNow();
    try {
      const chain = evmPoolChain(form.chain);
      const t = lookup.trim().toLowerCase();
      if (!chain) throw new Error('Aretia Pool is not available on this network.');
      if (!isEvmAddress(t) || isSolanaAddress(t)) lookupNote = 'Enter a token address starting with 0x.';
      else {
        const f = readFlow(form.chain);
        const found = await f.loadPool(chain, t);
        if (!found) lookupNote = 'No Aretia Pool was found for that token on this network.';
        else {
          const account = host.getAccount();
          const info = await f.loadToken(chain, account ?? found.creator, t);
          if (!info) lookupNote = 'That pool’s token could not be read.';
          else {
            pool = found;
            poolToken = info;
            position = account ? await f.loadPosition(chain, t, account) : null;
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

  async function startAction(kind: Manage | 'buy' | 'sell'): Promise<void> {
    error = null;
    busy = true;
    redrawNow();
    try {
      if (!adapter) adapter = (await host.connect()).adapter;
      const account = host.getAccount() ?? '';
      const chain = evmPoolChain(form.chain);
      const token = lookup.trim().toLowerCase();
      if (!chain || !account || !poolToken) throw new Error('Connect a wallet first.');
      const f = flowFor(form.chain, adapter);
      // Read the pool and the position again so the numbers are as fresh as the network can give.
      const latest = await f.loadPool(chain, token);
      if (!latest) throw new Error('The pool could not be read.');
      pool = latest;
      position = await f.loadPosition(chain, token, account);
      const pos = position ?? { open: false, shares: 0n, locked: 0n, checkpoint: 0n, pending: 0n, recipient: null };
      if (kind === 'buy') {
        const wei = coinToWei(buyText);
        if (wei === null) throw new Error(`Enter an amount of ${chain.symbol} above zero.`);
        review = await f.prepareBuy(chain, account, latest, token, wei, slippage);
      } else if (kind === 'sell') {
        const raw = unitsFrom(sellText, poolToken.decimals);
        if (raw === null) throw new Error('Enter an amount of tokens above zero.');
        review = await f.prepareSell(chain, account, latest, token, raw, slippage);
      } else if (kind === 'add') {
        const raw = unitsFrom(addText, poolToken.decimals);
        if (raw === null) throw new Error('Enter an amount of tokens above zero.');
        // Liquidity units for that many tokens at the pool's proportion, rounded down so the tokens needed never exceed what was typed.
        const dl = latest.x === 0n ? 0n : (raw * latest.l) / latest.x;
        review = await f.prepareAdd(chain, account, latest, token, dl, slippage);
      } else if (kind === 'remove') {
        const pct = /^\d{1,3}$/.test(removePct.trim()) ? BigInt(removePct.trim()) : 0n;
        if (pct <= 0n || pct > 100n) throw new Error('Enter a whole percentage from 1 to 100.');
        const dl = ((pos.shares - pos.locked) * pct) / 100n;
        review = await f.prepareRemove(chain, account, latest, pos, token, dl, slippage);
      } else if (kind === 'claim') review = await f.prepareClaim(chain, account, latest, pos, token);
      else if (kind === 'lock') review = await f.prepareLock(chain, account, pos, token, pos.shares - pos.locked);
      else if (kind === 'recipient') review = await f.prepareRecipient(chain, account, pos, token, recipientText.trim());
      else review = await f.prepareTransfer(chain, account, pos, token, transferText.trim());
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
      outcome = await flowFor(form.chain, adapter).run(r, (p) => {
        progress = p;
        redrawNow();
      });
      stage = 'done';
    } catch (e) {
      // The flow's own messages are already plain and complete: show them whole, not shortened.
      error = e instanceof EvmPoolError ? e.message : friendlyEvmError(e);
      stage = 'review';
    } finally {
      busy = false;
      review = stage === 'done' ? null : review;
      redrawNow();
    }
  }

  return {
    draw(card, redraw, chainKey, suggestToken): void {
      redrawNow = redraw;
      const chain = evmPoolChain(chainKey);
      card.dataset.stage = chain ? stage : 'off';
      const section = h('div', 'wapp-ln');
      section.append(h('h3', 'wapp__h2', 'Aretia Pool'));
      if (!chain) {
        // No deployed contract on this network: say so and offer nothing. This is every network until the contract is deployed.
        const name = chainByKey(chainKey)?.name ?? 'this network';
        section.append(h('p', 'wapp__banner wapp__banner--warn', `Not live on ${name}. Aretia Pool is built and tested, but it has not been independently audited and is not deployed here, so this page does not send anything.`));
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
        pool = null;
        position = null;
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
        const shared = parseEvmPoolHash(location.hash);
        if (shared && shared.chain === chainKey) {
          tab = 'trade';
          lookup = shared.token;
          void findPool();
        }
      }
      if (stage === 'form') {
        const bar = h('div', 'wapp__row-actions');
        for (const [id, label] of [['create', 'Open a pool'], ['trade', 'Trade and manage']] as const) {
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
      pool = null;
      position = null;
    },
  };
}
