/**
 * The Ethereum-style half of the pool page: the form, review and result for opening a liquidity pool for a token on BNB Chain, Ethereum or
 * Polygon. Rules are in walletPoolEvmCore.ts, the transactions and their inspectors in walletPoolEvmTx.ts, the order of events in
 * walletPoolEvmFlow.ts. This file only draws and connects them to the wallet the page already uses. Everything typed, and everything read back
 * from the chain, is shown with textContent, never as markup.
 */
import { readErc20, type EvmRead } from '../swings/chains/evmSession.js';
import type { EvmWalletAdapter } from '../swings/chains/evmWallet.js';
import { fromSmallestUnit } from './walletTools';
import { chainByKey, chainEnabled, type LaunchEvmChainKey } from './walletLaunchEvmCore';
import { friendlyEvmError } from './walletLaunchEvmFlow';
import { DEFAULT_POOL_FORM, POOL_DEXES, dexFor, poolConfigOf, poolDisclosuresOf, validatePoolForm, type PoolForm, type PoolIssue } from './walletPoolEvmCore';
import { PoolFlow, type PoolOutcome, type PoolProgress, type PoolReview } from './walletPoolEvmFlow';

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
const short = (a: string): string => `${a.slice(0, 6)}…${a.slice(-4)}`;

const STEPS: { id: PoolProgress; label: string }[] = [
  { id: 'checking', label: 'Checking everything once more' },
  { id: 'approving', label: 'Waiting for you to approve the token approval in your wallet' },
  { id: 'confirming-approve', label: 'Confirming the approval' },
  { id: 'adding', label: 'Waiting for you to approve opening the pool' },
  { id: 'confirming', label: 'Opening the pool on the network' },
  { id: 'verifying', label: 'Reading the pool back from the network' },
  { id: 'done', label: 'Done' },
];

export function createEvmPool(host: PoolEvmHost): { draw(card: HTMLElement, redraw: () => void, chainKey: LaunchEvmChainKey, suggestToken: string | null): void; reset(): void; isBusy(): boolean } {
  type Stage = 'form' | 'review' | 'working' | 'done';
  let stage: Stage = 'form';
  let form: PoolForm = { ...DEFAULT_POOL_FORM };
  let issues: PoolIssue[] = [];
  let review: PoolReview | null = null;
  let outcome: PoolOutcome | null = null;
  let error: string | null = null;
  let progress: PoolProgress = 'checking';
  let busy = false;
  let acknowledged = false;
  let adapter: EvmWalletAdapter | null = null;
  let redrawNow: () => void = () => undefined;
  let lastSuggest: string | null = null;

  const errorBox = (text: string): HTMLElement => {
    const p = h('p', 'wapp__banner wapp__banner--warn', text);
    p.setAttribute('role', 'alert');
    return p;
  };
  const row = (dl: HTMLElement, k: string, v: string | HTMLElement): void => {
    const d = h('div');
    const dd = h('dd');
    if (typeof v === 'string') dd.textContent = v;
    else dd.append(v);
    d.append(h('dt', '', k), dd);
    dl.append(d);
  };

  function field(label: string, name: 'token' | 'tokenAmount' | 'coinAmount', opts: { placeholder?: string; mono?: boolean; hint?: string } = {}): HTMLElement {
    const wrap = h('div', 'wapp-ln__field');
    const id = `pool-evm-${name}`;
    const lab = h('label', 'wapp__eyebrow', label);
    lab.htmlFor = id;
    const input = h('input', `wapp__input${opts.mono ? ' wapp-mono' : ''}`);
    input.id = id;
    input.value = form[name];
    input.autocomplete = 'off';
    input.spellcheck = false;
    if (opts.placeholder) input.placeholder = opts.placeholder;
    input.addEventListener('input', () => void (form = { ...form, [name]: input.value }));
    wrap.append(lab, input);
    const problem = issues.find((i) => i.field === name);
    if (problem) {
      input.setAttribute('aria-invalid', 'true');
      const p = h('p', 'wapp-ln__problem', problem.message);
      p.setAttribute('role', 'alert');
      wrap.append(p);
    } else if (opts.hint) wrap.append(h('p', 'wapp__fine', opts.hint));
    return wrap;
  }

  const enabledKeys = (): string[] => POOL_DEXES.filter((d) => {
    const c = chainByKey(d.key);
    return c !== undefined && chainEnabled(c);
  }).map((d) => d.key);

  function drawForm(card: HTMLElement): void {
    const dex = dexFor(form.chain);
    card.append(h('span', 'wapp__eyebrow', 'Aretia Launch'), h('h3', 'wapp__h2', 'Open a liquidity pool'));
    card.append(h('p', 'wapp__fine', `Give a token a market on ${dex?.name ?? 'this network'}. Your tokens and some ${dex?.symbol ?? 'coin'} go into a new pool, which sets the starting price. Your own wallet signs two transactions: an approval for exactly the tokens, then the pool. Opening a pool has no Aretia fee yet.`));
    const f = h('form', 'wapp__form wapp-ln__form');
    f.noValidate = true;
    f.append(field('Token address', 'token', { mono: true, placeholder: '0x…', hint: 'A token you hold, such as one made on this page.' }));
    f.append(field('Tokens to put in the pool', 'tokenAmount', { hint: 'In whole tokens. Only your tokens go in; nothing is bought.' }));
    f.append(field(`${dex?.symbol ?? 'Coin'} to put in the pool`, 'coinAmount', { hint: `The starting price is this amount divided by the tokens above.` }));
    const lock = h('label', 'wapp__check');
    const box = h('input');
    box.type = 'checkbox';
    box.checked = form.lock;
    box.addEventListener('change', () => void (form = { ...form, lock: box.checked }));
    lock.append(box, h('span', '', 'Lock the liquidity for good. Nobody, you included, can take the tokens or the coins back out. Leave off if you want to keep that ability.'));
    f.append(lock);
    const go = h('button', 'wapp__btn wapp__btn--primary', busy ? 'Checking…' : host.getAccount() ? 'Review' : 'Connect wallet and review');
    go.type = 'submit';
    go.disabled = busy;
    f.append(go);
    f.addEventListener('submit', (e) => {
      e.preventDefault();
      void startReview();
    });
    card.append(f);
    if (error) card.append(errorBox(error));
  }

  function drawReview(card: HTMLElement): void {
    if (!review) return;
    const { config: c, gasCostWei, coinBalance, tokenBalance, blockers } = review;
    const chain = chainByKey(c.dex.key);
    card.append(h('span', 'wapp__eyebrow', 'Review the pool'), h('h3', 'wapp__h2', `${c.tokenSymbol} / ${c.dex.symbol} on ${c.dex.name}`));
    card.append(h('p', 'wapp__banner wapp__banner--warn', `This opens a real pool on ${chain?.name ?? 'this network'} and spends real ${c.dex.symbol} and tokens. Nothing is sent until you press the button at the bottom.`));
    const dl = h('dl', 'wapp__rows');
    row(dl, 'Token', `${c.tokenSymbol} (${short(c.token)})`);
    row(dl, 'Tokens going in', `${grouped(fromSmallestUnit(c.tokenRaw, c.tokenDecimals))} ${c.tokenSymbol}`);
    row(dl, `${c.dex.symbol} going in`, `${fromSmallestUnit(c.coinWei, 18)} ${c.dex.symbol}`);
    row(dl, 'Starting price', `${fromSmallestUnit(c.coinWei * 10n ** BigInt(c.tokenDecimals) / c.tokenRaw, 18)} ${c.dex.symbol} per ${c.tokenSymbol}`);
    row(dl, 'Liquidity', c.lock ? 'Locked for good (sent to the dead address)' : 'Sent to your wallet');
    row(dl, 'Network gas, at most about', gasCostWei === null ? 'could not be estimated' : `${fromSmallestUnit(gasCostWei, 18)} ${c.dex.symbol}`);
    row(dl, `Your ${c.dex.symbol}`, `${fromSmallestUnit(coinBalance, 18)} ${c.dex.symbol}`);
    row(dl, `Your ${c.tokenSymbol}`, `${grouped(fromSmallestUnit(tokenBalance, c.tokenDecimals))} ${c.tokenSymbol}`);
    card.append(dl);
    card.append(h('span', 'wapp__eyebrow', 'What this means'));
    const list = h('ul', 'wapp__list');
    for (const d of poolDisclosuresOf(c)) {
      const li = h('li');
      li.append(h('b', '', d.severity === 'caution' ? 'Note: ' : ''), document.createTextNode(d.text));
      list.append(li);
    }
    card.append(list);
    for (const b of blockers) card.append(errorBox(b));
    const ack = h('label', 'wapp__check');
    const box = h('input');
    box.type = 'checkbox';
    box.checked = acknowledged;
    const go = h('button', 'wapp__btn wapp__btn--primary', `Open the pool on ${chain?.name ?? 'the network'}`);
    go.type = 'button';
    go.disabled = !acknowledged || blockers.length > 0 || busy;
    box.addEventListener('change', () => {
      acknowledged = box.checked;
      go.disabled = !acknowledged || blockers.length > 0 || busy;
    });
    ack.append(box, h('span', '', 'I understand this opens a real pool, costs about the amounts above, and cannot be undone.'));
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
    go.addEventListener('click', () => void create());
    actions.append(go, back);
    card.append(actions);
    if (error) card.append(errorBox(error));
  }

  function drawWorking(card: HTMLElement): void {
    card.append(h('span', 'wapp__eyebrow', 'Opening'), h('h3', 'wapp__h2', 'Opening your pool'));
    card.append(h('p', 'wapp__fine', 'Keep this page open. Your wallet will ask you to approve two transactions, one after the other.'));
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
    if (!outcome || !review) return;
    const chain = chainByKey(review.config.dex.key);
    const ok = outcome.differences.length === 0;
    card.append(h('span', 'wapp__eyebrow', ok ? 'Opened' : 'Opened, with differences'), h('h3', 'wapp__h2', ok ? 'Your pool exists' : 'Your pool exists, but check this'));
    card.append(ok ? h('p', 'wapp__banner', 'Read back from the network: the pool holds exactly the tokens and coins you put in, and the liquidity went where you chose.') : errorBox(`The network does not show exactly what you approved: ${outcome.differences.join(' ')}`));
    const dl = h('dl', 'wapp__rows');
    row(dl, 'Pool address', outcome.pair);
    const a = h('a', '', short(outcome.addHash));
    a.href = `${chain?.explorer ?? ''}/tx/${outcome.addHash}`;
    a.target = '_blank';
    a.rel = 'noopener noreferrer';
    row(dl, 'Pool transaction', a);
    card.append(dl);
    const again = h('button', 'wapp__btn wapp__btn--primary', 'Open another');
    again.type = 'button';
    again.addEventListener('click', () => {
      stage = 'form';
      form = { ...DEFAULT_POOL_FORM, chain: form.chain };
      review = null;
      outcome = null;
      acknowledged = false;
      error = null;
      redrawNow();
    });
    card.append(again);
  }

  async function startReview(): Promise<void> {
    error = null;
    busy = true;
    redrawNow();
    try {
      if (!adapter) adapter = (await host.connect()).adapter;
      const creator = host.getAccount() ?? '';
      const v = validatePoolForm(form, creator, enabledKeys());
      issues = v.ok ? [] : v.issues;
      if (!v.ok) {
        const g = v.issues.find((i) => i.field === 'form');
        if (g) error = g.message;
        return;
      }
      const read = host.readerFor(form.chain);
      const facts = await readErc20(read, v.token);
      if (!facts) {
        issues = [{ field: 'token', message: 'That is not a token this network can read. Check the address and the network.' }];
        return;
      }
      const config = poolConfigOf(v, creator, form.lock, facts);
      if (!config) {
        issues = [{ field: 'tokenAmount', message: `${facts.symbol} has ${facts.decimals} decimal places; the amount has more.` }];
        return;
      }
      review = await new PoolFlow({ adapter, read, now: () => Date.now(), nowSeconds: () => Math.floor(Date.now() / 1000) }).prepare(config);
      stage = 'review';
      acknowledged = false;
    } catch (e) {
      error = `Could not check this pool: ${friendlyEvmError(e)}`;
    } finally {
      busy = false;
      redrawNow();
    }
  }

  async function create(): Promise<void> {
    const r = review;
    if (!r || !acknowledged || !adapter) return;
    busy = true;
    stage = 'working';
    progress = 'checking';
    error = null;
    redrawNow();
    try {
      outcome = await new PoolFlow({ adapter, read: host.readerFor(r.config.dex.key), now: () => Date.now(), nowSeconds: () => Math.floor(Date.now() / 1000) }).create(r, (p) => {
        progress = p;
        redrawNow();
      });
      stage = 'done';
    } catch (e) {
      error = friendlyEvmError(e);
      stage = 'review';
    } finally {
      busy = false;
      redrawNow();
    }
  }

  return {
    draw(card, redraw, chainKey, suggestToken): void {
      redrawNow = redraw;
      if (!enabledKeys().includes(chainKey)) return;
      if (form.chain !== chainKey) {
        form = { ...form, chain: chainKey };
        stage = 'form';
        review = null;
        outcome = null;
        acknowledged = false;
        error = null;
        issues = [];
      }
      // A token just created on this page is offered as the one to open a pool for, without overwriting what was typed.
      if (suggestToken && suggestToken !== lastSuggest) {
        lastSuggest = suggestToken;
        if (form.token.trim() === '') form = { ...form, token: suggestToken };
      }
      const section = h('div', 'wapp-ln');
      if (stage === 'form') drawForm(section);
      else if (stage === 'review') drawReview(section);
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
    },
  };
}
