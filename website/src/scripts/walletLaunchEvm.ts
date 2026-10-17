/**
 * The Ethereum-style half of the Launch page: the form, review and result for creating a token on BNB Chain, Ethereum or Polygon
 * (and their test networks). Rules are in walletLaunchEvmCore.ts, the transaction and its inspector in walletLaunchEvmTx.ts, the order of
 * events in walletLaunchEvmFlow.ts. This file only draws and connects them to the wallet the page already uses for Swap and Pay.
 * Everything typed, and everything read back from the chain, is shown with textContent, never as markup.
 */
import type { ChainId } from '../swings/core/types.js';
import { publicRead, type EvmRead } from '../swings/chains/evmSession.js';
import { SwingsError } from '../swings/core/types.js';
import type { EvmWalletAdapter } from '../swings/chains/evmWallet.js';
import { fromSmallestUnit } from './walletTools';
import {
  DEFAULT_EVM_FORM,
  chainByKey,
  chainEnabled,
  evmDisclosuresOf,
  validateEvmLaunch,
  type EvmFieldIssue,
  type EvmLaunchForm,
  type LaunchEvmChain,
} from './walletLaunchEvmCore';
import { createEvmPool } from './walletPoolEvm';
import { createEvmCurve } from './walletCurveEvm';
import { EvmLaunchFlow, friendlyEvmError, type EvmOutcome, type EvmProgress, type EvmReview } from './walletLaunchEvmFlow';

export interface LaunchEvmHost {
  /** The connected Ethereum-style account, or null. */
  getAccount(): string | null;
  /** Connects the wallet (asking the person) and resolves to the wallet adapter. Throws a plain-language Error. */
  connect(): Promise<{ adapter: EvmWalletAdapter; account: string | null }>;
}

const h = <K extends keyof HTMLElementTagNameMap>(tag: K, cls = '', text?: string): HTMLElementTagNameMap[K] => {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text !== undefined) n.textContent = text;
  return n;
};

const grouped = (text: string): string => text.replace(/^(\d+)/, (whole) => whole.replace(/\B(?=(\d{3})+(?!\d))/g, ','));
const amountText = (raw: bigint, decimals: number): string => grouped(fromSmallestUnit(raw, decimals));
const coinText = (wei: bigint, symbol: string): string => `${fromSmallestUnit(wei, 18)} ${symbol}`;
const short = (a: string): string => `${a.slice(0, 6)}…${a.slice(-4)}`;

const PROGRESS_STEPS: { id: EvmProgress; label: string }[] = [
  { id: 'checking', label: 'Checking everything once more' },
  { id: 'signing', label: 'Waiting for you to approve the transaction in your wallet' },
  { id: 'confirming', label: 'Creating the token on the network' },
  { id: 'verifying', label: 'Reading the new token back from the network' },
  { id: 'done', label: 'Done' },
];

/** Reads for one chain, straight from a public node and never through the wallet, so pricing never prompts or switches the wallet. */
export function readerFor(chain: LaunchEvmChain): EvmRead {
  if (!chain.testnet) return publicRead(chain.key as ChainId);
  const url = chain.addParams?.rpcUrls[0];
  return async (method, params) => {
    if (!url) throw new Error('No node for this network.');
    const res = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const body = (await res.json()) as { result?: unknown; error?: { message?: string } };
    if (body.error) throw new Error(body.error.message ?? 'The node refused the request.');
    return body.result;
  };
}

/** The wallet adapter, with network switching that can also add a test network the wallet does not know yet. */
function withAddNetwork(adapter: EvmWalletAdapter, chain: LaunchEvmChain): Pick<EvmWalletAdapter, 'getAccounts' | 'getChainId' | 'switchChain' | 'sendTransaction'> {
  return {
    getAccounts: () => adapter.getAccounts(),
    getChainId: () => adapter.getChainId(),
    sendTransaction: (tx) => adapter.sendTransaction(tx),
    switchChain: async (chainId) => {
      try {
        await adapter.switchChain(chainId);
      } catch (e) {
        if ((e instanceof SwingsError && e.code === 'rejected') || !chain.addParams) throw e;
        try {
          await adapter.request('wallet_addEthereumChain', [{ chainId: '0x' + chainId.toString(16), ...chain.addParams }]);
        } catch {
          throw new Error('Your wallet could not add that network. Add it in the wallet and try again.');
        }
        if ((await adapter.getChainId()) !== chainId) await adapter.switchChain(chainId);
      }
    },
  };
}

/** Where the pool and the curve are drawn, when they live apart from the create card. */
export interface EvmMarketRoots {
  pool: HTMLElement;
  curve: HTMLElement;
}

export function createEvmLaunch(host: LaunchEvmHost): { draw(card: HTMLElement, redraw: () => void, chainKey: string, markets?: EvmMarketRoots): void; reset(): void; isBusy(): boolean; stage(): 'form' | 'review' | 'working' | 'done' } {
  type Stage = 'form' | 'review' | 'working' | 'done';
  let stage: Stage = 'form';
  let form: EvmLaunchForm = { ...DEFAULT_EVM_FORM };
  let issues: EvmFieldIssue[] = [];
  let review: EvmReview | null = null;
  let outcome: EvmOutcome | null = null;
  let error: string | null = null;
  let progress: EvmProgress = 'checking';
  let busy = false;
  let acknowledged = false;
  let adapter: EvmWalletAdapter | null = null;
  let redrawNow: () => void = () => undefined;
  const pool = createEvmPool({ getAccount: host.getAccount, connect: async () => ({ adapter: (await host.connect()).adapter }), readerFor: (key) => readerFor(chainByKey(key)!) });
  // Aretia's own bonding curve: off unless the site is built with PUBLIC_CURVE_ENABLED=1, and even then it does nothing on a network without a deployed contract.
  const curve = import.meta.env.PUBLIC_CURVE_ENABLED === '1' ? createEvmCurve({ getAccount: host.getAccount, connect: async () => ({ adapter: (await host.connect()).adapter }), readerFor: (key) => readerFor(chainByKey(key)!) }) : null;

  const set = (f: Partial<EvmLaunchForm>): void => {
    form = { ...form, ...f };
  };

  function errorBox(text: string): HTMLElement {
    const p = h('p', 'wapp__banner wapp__banner--warn', text);
    p.setAttribute('role', 'alert');
    return p;
  }

  function field(label: string, name: Exclude<keyof EvmLaunchForm, 'chain'>, opts: { placeholder?: string; inputmode?: string; hint?: string } = {}): HTMLElement {
    const wrap = h('div', 'wapp-ln__field');
    const id = `launch-evm-${name}`;
    const lab = h('label', 'wapp__eyebrow', label);
    lab.htmlFor = id;
    const input = h('input', 'wapp__input');
    input.id = id;
    input.value = form[name];
    input.autocomplete = 'off';
    input.spellcheck = false;
    if (opts.placeholder) input.placeholder = opts.placeholder;
    if (opts.inputmode) input.inputMode = opts.inputmode;
    input.addEventListener('input', () => set({ [name]: input.value } as Partial<EvmLaunchForm>));
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

  function drawForm(card: HTMLElement, chain: LaunchEvmChain | undefined): void {
    const account = host.getAccount();
    card.append(h('h2', 'wapp__h2', `Create a token on ${chain?.name ?? 'an Ethereum-style network'}`));
    const enabled = chain !== undefined && chainEnabled(chain);
    if (chain && enabled) {
      card.append(h('p', 'wapp__fine', `Make a token with a fixed supply. Your own wallet signs; Aretia never holds your keys. Creating a token costs a flat Aretia fee of ${coinText(chain.feeWei, chain.symbol)}, sent in the same transaction and shown before you sign, plus the network’s gas.`));
    } else {
      card.append(h('p', 'wapp__banner wapp__banner--warn', `Creating tokens on ${chain?.name ?? 'this network'} is not available yet. It switches on once Aretia’s token factory is deployed there.`));
    }
    if (!account) card.append(h('p', 'wapp__banner wapp__banner--warn', 'Connect an Ethereum-style wallet to create a token.'));

    const f = h('form', 'wapp__form wapp-ln__form');
    f.noValidate = true;
    const row1 = h('div', 'wapp-ln__row wapp-ln__row--wide');
    row1.append(field('Name', 'name', { placeholder: 'Example Token', hint: 'Up to 32 characters.' }), field('Symbol', 'symbol', { placeholder: 'EXMP', hint: 'Letters and digits.' }));
    f.append(row1);
    f.append(field('Total supply', 'supply', { inputmode: 'decimal', hint: 'In whole tokens. It can never be increased.' }));
    const adv = h('details', 'lh-adv');
    adv.open = issues.some((i) => i.field === 'decimals');
    adv.append(h('summary', '', 'Advanced options'));
    const advBody = h('div', 'lh-adv__body');
    advBody.append(field('Decimals', 'decimals', { inputmode: 'numeric', hint: '18 is usual. 0 to 18.' }));
    adv.append(advBody);
    f.append(adv);
    const promiseList = h('ul', 'lh-promises');
    for (const t of ['The whole supply is created in your wallet in the same transaction. Nothing locks it, and nothing here sells it.', 'No owner and no mint, pause, freeze or transfer-fee function: nobody, including you and Aretia, can create more or freeze a holder.']) promiseList.append(h('li', '', t));
    f.append(promiseList);

    const actions = h('div', 'wapp__row-actions');
    if (!account) {
      const connect = h('button', 'wapp__btn wapp__btn--primary', busy ? 'Connecting…' : 'Connect wallet');
      connect.type = 'button';
      connect.disabled = busy;
      connect.addEventListener('click', () => void connectWallet());
      actions.append(connect);
    } else {
      const go = h('button', 'wapp__btn wapp__btn--primary', busy ? 'Checking…' : 'Review');
      go.type = 'submit';
      go.disabled = busy || !enabled;
      actions.append(go);
      actions.append(h('span', 'wapp__fine', `Wallet ${short(account)}`));
    }
    f.append(actions);
    f.addEventListener('submit', (e) => {
      e.preventDefault();
      void startReview();
    });
    card.append(f);
    if (error) card.append(errorBox(error));
  }

  function drawReview(card: HTMLElement): void {
    if (!review) return;
    const { config, tx, gasCostWei, balance, blockers } = review;
    const { chain } = config;
    card.append(h('span', 'wapp__eyebrow', 'Review'), h('h2', 'wapp__h2', `${config.name} (${config.symbol})`));
    card.append(
      chain.testnet
        ? h('p', 'wapp__banner', `This creates a token on ${chain.name}, a test network. Nothing here has real value.`)
        : h('p', 'wapp__banner wapp__banner--warn', `This creates a real token on ${chain.name} mainnet and spends real ${chain.symbol}. Read it all before you approve. Nothing is sent until you press the button at the bottom.`),
    );

    const dl = h('dl', 'wapp__rows');
    row(dl, 'Network', `${chain.name} (chain ${chain.chainId})`);
    row(dl, 'Total supply', `${amountText(config.totalSupplyRaw, config.decimals)} ${config.symbol}`);
    row(dl, 'Decimals', String(config.decimals));
    row(dl, 'All of it goes to', `You (${short(config.creator)})`);
    row(dl, 'Created by Aretia’s factory', link(short(chain.factory ?? ''), `${chain.explorer}/address/${chain.factory ?? ''}`));
    card.append(dl);

    card.append(h('span', 'wapp__eyebrow', `What it costs, in ${chain.symbol}`));
    const costs = h('dl', 'wapp__rows');
    row(costs, 'Aretia fee (sent with the transaction)', coinText(chain.feeWei, chain.symbol));
    row(costs, 'Network gas, at most about', gasCostWei === null ? 'could not be estimated' : coinText(gasCostWei, chain.symbol));
    row(costs, 'Your balance', coinText(balance, chain.symbol));
    card.append(costs);
    card.append(h('p', 'wapp__fine', `The fee goes to ${short(chain.feeAddress ?? '')}, which the factory itself pays in the same transaction. The final gas amount is shown by your wallet. The page checked the transaction (${short(tx.to)}) against this review before asking your wallet to sign.`));

    card.append(h('span', 'wapp__eyebrow', 'What this means'));
    const list = h('ul', 'wapp__list');
    for (const d of evmDisclosuresOf(config)) {
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
    const go = h('button', 'wapp__btn wapp__btn--primary', chain.testnet ? `Create token on ${chain.name}` : `Create token on ${chain.name} mainnet`);
    go.type = 'button';
    go.disabled = !acknowledged || blockers.length > 0 || busy;
    box.addEventListener('change', () => {
      acknowledged = box.checked;
      go.disabled = !acknowledged || blockers.length > 0 || busy;
    });
    ack.append(box, h('span', '', 'I understand this creates a token, costs about the amount above, and cannot be undone.'));
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
    card.append(h('span', 'wapp__eyebrow', 'Creating'), h('h2', 'wapp__h2', 'Creating your token'));
    card.append(h('p', 'wapp__fine', 'Keep this page open. Your wallet will ask you to approve one transaction.'));
    const list = h('ol', 'wapp-ln__steps');
    const at = PROGRESS_STEPS.findIndex((s) => s.id === progress);
    PROGRESS_STEPS.forEach((s, i) => {
      const li = h('li', i < at ? 'is-done' : i === at ? 'is-now' : '', s.label);
      if (i === at) li.setAttribute('aria-current', 'step');
      list.append(li);
    });
    card.append(list);
  }

  function drawDone(card: HTMLElement): void {
    if (!outcome || !review) return;
    const { chain } = review.config;
    const ok = outcome.differences.length === 0;
    card.append(h('span', 'wapp__eyebrow', ok ? 'Created' : 'Created, with differences'), h('h2', 'wapp__h2', ok ? 'Your token exists' : 'Your token exists, but check this'));
    card.append(
      ok
        ? h('p', 'wapp__banner', 'Read back from the network: the name, symbol, decimals and total supply match what you approved, and your wallet holds all of it. No one can create more.')
        : errorBox(`The network does not show exactly what you approved: ${outcome.differences.join(' ')}`),
    );
    const dl = h('dl', 'wapp__rows');
    row(dl, 'Token address', outcome.token);
    row(dl, 'Transaction', link(short(outcome.txHash), `${chain.explorer}/tx/${outcome.txHash}`));
    row(dl, 'View the token', link('Open on the explorer', `${chain.explorer}/token/${outcome.token}`));
    card.append(dl);
    const copy = h('button', 'wapp__btn wapp__btn--ghost', 'Copy token address');
    copy.type = 'button';
    copy.addEventListener('click', () => {
      void navigator.clipboard?.writeText(outcome!.token).then(() => (copy.textContent = 'Copied'));
    });
    card.append(copy);
    card.append(h('p', 'wapp__fine', 'Nobody can buy this token yet. A token has no market until a liquidity pool exists, and this page does not create one on this network. To see it in your wallet, add the token address above.'));
    const again = h('button', 'wapp__btn wapp__btn--primary', 'Create another');
    again.type = 'button';
    again.addEventListener('click', () => {
      stage = 'form';
      form = { ...DEFAULT_EVM_FORM, chain: form.chain };
      review = null;
      outcome = null;
      acknowledged = false;
      error = null;
      redrawNow();
    });
    card.append(again);
  }

  async function connectWallet(): Promise<void> {
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

  async function flowFor(chain: LaunchEvmChain): Promise<EvmLaunchFlow> {
    if (!adapter) adapter = (await host.connect()).adapter;
    return new EvmLaunchFlow({ adapter: withAddNetwork(adapter, chain), read: readerFor(chain), now: () => Date.now() });
  }

  async function startReview(): Promise<void> {
    const creator = host.getAccount() ?? '';
    const v = validateEvmLaunch(form, creator);
    issues = v.ok ? [] : v.issues;
    error = null;
    if (!v.ok) {
      const formIssue = v.issues.find((i) => i.field === 'form' || i.field === 'chain');
      if (formIssue) error = formIssue.message;
      redrawNow();
      document.querySelector<HTMLElement>('[data-launch-root] [aria-invalid="true"]')?.focus();
      return;
    }
    busy = true;
    redrawNow();
    try {
      review = await (await flowFor(v.config.chain)).prepare(v.config);
      stage = 'review';
      acknowledged = false;
    } catch (e) {
      error = `Could not price this on the network: ${friendlyEvmError(e)}`;
    } finally {
      busy = false;
      redrawNow();
    }
  }

  async function create(): Promise<void> {
    const r = review;
    if (!r || !acknowledged) return;
    busy = true;
    stage = 'working';
    progress = 'checking';
    error = null;
    redrawNow();
    try {
      outcome = await (await flowFor(r.config.chain)).create(r, (p) => {
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
    draw(card, redraw, chainKey, markets): void {
      redrawNow = redraw;
      const chain = chainByKey(chainKey);
      // Switching networks starts the form again: nothing reviewed for one network carries over to another.
      if (form.chain !== chainKey) {
        form = { ...form, chain: chainKey as EvmLaunchForm['chain'] };
        stage = 'form';
        review = null;
        outcome = null;
        acknowledged = false;
        error = null;
        issues = [];
      }
      if (stage === 'form') drawForm(card, chain);
      else if (stage === 'review') drawReview(card);
      else if (stage === 'working') drawWorking(card);
      else drawDone(card);
      // Opening a pool for a token is offered below, on the networks where it is available.
      pool.draw(markets?.pool ?? card, redraw, form.chain, outcome?.token ?? null);
      curve?.draw(markets?.curve ?? card, redraw, form.chain, outcome?.token ?? null);
      if (markets && !curve) markets.curve.dataset.stage = 'off';
    },
    isBusy: () => busy || pool.isBusy() || (curve?.isBusy() ?? false),
    stage: () => stage,
    reset(): void {
      pool.reset();
      curve?.reset();
      stage = 'form';
      review = null;
      outcome = null;
      acknowledged = false;
      error = null;
      adapter = null;
    },
  };
}
