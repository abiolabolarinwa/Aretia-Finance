/**
 * The Ethereum-style half of the Launch page: the form, review and result for creating a token on BNB Chain, Ethereum or Polygon
 * (and their test networks). Rules are in walletLaunchEvmCore.ts, the transaction and its inspector in walletLaunchEvmTx.ts, the order of
 * events in walletLaunchEvmFlow.ts. This file only draws and connects them to the wallet the page already uses for Swap and Pay.
 * Everything typed, and everything read back from the chain, is shown with textContent, never as markup.
 */
import { verifiedBadge } from '../lib/verifiedBadge';
import type { ChainId } from '../swings/core/types.js';
import { publicRead, type EvmRead } from '../swings/chains/evmSession.js';
import { SwingsError } from '../swings/core/types.js';
import type { EvmWalletAdapter } from '../swings/chains/evmWallet.js';
import type { Signer } from '../swings/account/client';
import { EVM_META_CHAINS, type DetailIssue, type LaunchDetails } from '../swings/launchmeta/core.js';
import { fromSmallestUnit, toSmallestUnit } from './walletTools';
import { checkDetails, createUploader, detailsState, onDetailsChange, resetDetails, wantsDetails, NOT_SET_UP, type ChosenImage } from './walletLaunchMeta';
import { checklistBox, detailsFields } from './walletLaunchDetailsUi';
import { evmChecklist } from './walletLaunchChecklist';
import {
  DEFAULT_EVM_FORM,
  chainByKey,
  evmDisclosuresOf,
  launchModeOf,
  launchValueOf,
  poolTokensOf,
  validateEvmLaunch,
  type EvmFieldIssue,
  type EvmLaunchForm,
  type LaunchEvmChain,
} from './walletLaunchEvmCore';
import { createEvmPool } from './walletPoolEvm';
import { createEvmCurve } from './walletCurveEvm';
import { createEvmOrders } from './walletOrdersEvm';
import { createEvmAretiaPool } from './walletAretiaPoolEvm';
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
  /** Where the limit-orders card is drawn, when the build has it. */
  orders?: HTMLElement | null;
  /** Where Aretia's own pool is drawn, when the build has it. */
  aretiaPool?: HTMLElement | null;
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
  let detailIssues: DetailIssue[] = [];
  /** The picture and details frozen when the person pressed create, published once the token exists. */
  let pendingDetails: { details: LaunchDetails; image: ChosenImage | null } | null = null;
  let publish: { state: 'idle' | 'working' | 'done' | 'failed'; message: string } = { state: 'idle', message: '' };
  const uploader = createUploader((): Signer | null => {
    const account = host.getAccount();
    const a = adapter;
    return account && a ? { family: 'evm', address: account, sign: (m) => a.signMessage(m, account) } : null;
  });
  // Pictures and details can be stored where the creator can be proved from the chain: Aretia's own token factory on a main network.
  const detailsSupported = (chain: LaunchEvmChain | undefined): boolean => !!chain && !chain.testnet && launchModeOf(chain) === 'plain' && (EVM_META_CHAINS as readonly string[]).includes(chain.key);
  onDetailsChange((kind) => {
    if (kind === 'image' && stage === 'form') redrawNow();
  });
  const pool = createEvmPool({ getAccount: host.getAccount, connect: async () => ({ adapter: (await host.connect()).adapter }), readerFor: (key) => readerFor(chainByKey(key)!) });
  // Aretia's own bonding curve: off unless the site is built with PUBLIC_CURVE_ENABLED=1, and even then it does nothing on a network without a deployed contract.
  // Aretia's own pool (docs/ARETIA_POOL_EVM.md): off unless the site is built with PUBLIC_ARETIA_POOL_EVM_ENABLED=1, and even then it does nothing on a network without a deployed contract.
  const aretiaPool = import.meta.env.PUBLIC_ARETIA_POOL_EVM_ENABLED === '1' ? createEvmAretiaPool({ getAccount: host.getAccount, connect: async () => ({ adapter: (await host.connect()).adapter }), readerFor: (key) => readerFor(chainByKey(key)!) }) : null;
  const curve = import.meta.env.PUBLIC_CURVE_ENABLED === '1' ? createEvmCurve({ getAccount: host.getAccount, connect: async () => ({ adapter: (await host.connect()).adapter }), readerFor: (key) => readerFor(chainByKey(key)!) }) : null;

  // Limit orders (docs/ORDER_PROGRAM.md): off unless the site is built with PUBLIC_ORDERS_EVM_ENABLED=1, and even then it does nothing on a network without a deployed contract (none has one).
  const orders = import.meta.env.PUBLIC_ORDERS_EVM_ENABLED === '1' ? createEvmOrders({ getAccount: host.getAccount, connect: async () => ({ adapter: (await host.connect()).adapter }), readerFor: (key) => readerFor(chainByKey(key)!) }) : null;

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

  /** The checklist beside the Review button, from what is typed now. Gas is priced at Review. */
  function formChecklist(chain: LaunchEvmChain): ReturnType<typeof evmChecklist> {
    const mode = launchModeOf(chain) ?? 'plain';
    const pct = /^(\d{1,3})(?:\.(\d{1,2}))?$/.exec(form.poolPct.trim());
    const poolBps = pct ? Number(pct[1]) * 100 + Number((pct[2] ?? '').padEnd(2, '0')) : 7000;
    const coinText = form.poolCoin.trim().startsWith('.') ? `0${form.poolCoin.trim()}` : form.poolCoin.trim();
    const poolCoinWei = mode === 'locked' ? BigInt(toSmallestUnit(coinText, 18) ?? '0') : 0n;
    return evmChecklist({ symbol: form.symbol.trim().toUpperCase(), supplyText: form.supply.trim(), coin: chain.symbol, mode, testnet: chain.testnet, feeWei: mode === 'locked' ? (chain.launch?.feeWei ?? 0n) : chain.feeWei, poolCoinWei, poolBps: mode === 'locked' ? poolBps : 0, gasWei: null });
  }

  function drawForm(card: HTMLElement, chain: LaunchEvmChain | undefined): void {
    const account = host.getAccount();
    card.append(h('h2', 'wapp__h2', `Create a token on ${chain?.name ?? 'an Ethereum-style network'}`));
    const mode = chain ? launchModeOf(chain) : null;
    const enabled = mode !== null;
    if (chain && mode === 'locked') {
      card.append(h('p', 'wapp__fine', `Create a token and open its trading pool in one transaction. The pool's liquidity is locked for good, so nobody, including you and Aretia, can ever pull it out. Your own wallet signs; Aretia never holds your keys. The flat Aretia fee is ${coinText(chain.launch!.feeWei, chain.symbol)}, sent in the same transaction and shown before you sign, plus the coin you put in the pool and the network's gas.`));
    } else if (chain && mode === 'plain') {
      card.append(h('p', 'wapp__fine', `Make a token with a fixed supply. Your own wallet signs; Aretia never holds your keys. Creating a token costs a flat Aretia fee of ${coinText(chain.feeWei, chain.symbol)}, sent in the same transaction and shown before you sign, plus the network's gas. This does not open a trading pool: use "Open a liquidity pool" below, which locks the liquidity for good.`));
    } else {
      card.append(h('p', 'wapp__banner wapp__banner--warn', `Creating tokens on ${chain?.name ?? 'this network'} is not available yet. It switches on once Aretia’s token factory is deployed there.`));
    }
    if (!account) card.append(h('p', 'wapp__banner wapp__banner--warn', 'Connect an Ethereum-style wallet to create a token.'));

    const f = h('form', 'wapp__form wapp-ln__form');
    f.noValidate = true;
    const row1 = h('div', 'wapp-ln__row wapp-ln__row--wide');
    row1.append(field('Name', 'name', { placeholder: 'Example Token', hint: 'Up to 32 characters.' }), field('Symbol', 'symbol', { placeholder: 'EXMP', hint: 'Letters and digits.' }));
    f.append(row1);
    if (detailsSupported(chain)) {
      f.append(detailsFields({ idPrefix: 'launch-evm-details', issues: detailIssues, uploader, imageNote: 'Published right after the token is created.' }));
    } else if (chain && enabled) {
      f.append(h('p', 'wapp__fine', `A picture, description and links can be stored for tokens made on BNB Chain, Ethereum and Polygon through Aretia’s standard factory. They are not offered on ${chain.name}.`));
    }
    f.append(field('Total supply', 'supply', { inputmode: 'decimal', hint: 'In whole tokens. It can never be increased.' }));
    if (mode === 'locked') {
    const poolRow = h('div', 'wapp-ln__row wapp-ln__row--wide');
    const minCoin = chain?.launch ? fromSmallestUnit(chain.launch.minLiquidityWei, 18) : null;
    poolRow.append(
      field('Share of the supply for the pool (%)', 'poolPct', { inputmode: 'decimal', hint: 'At least 70%. This part goes into the locked pool; you keep the rest.' }),
      field(`${chain?.symbol ?? 'Coin'} for the pool`, 'poolCoin', { inputmode: 'decimal', hint: minCoin ? `At least ${minCoin} ${chain?.symbol}. With the tokens above it sets the starting price.` : 'It sets the starting price.' }),
    );
    f.append(poolRow);
    }
    const adv = h('details', 'lh-adv');
    adv.open = issues.some((i) => i.field === 'decimals');
    adv.append(h('summary', '', 'Advanced options'));
    const advBody = h('div', 'lh-adv__body');
    advBody.append(field('Decimals', 'decimals', { inputmode: 'numeric', hint: '18 is usual. 0 to 18.' }));
    adv.append(advBody);
    f.append(adv);
    const promiseList = h('ul', 'lh-promises');
    for (const t of [mode === 'locked' ? 'The pool is opened with your tokens and coin in the same transaction, and its liquidity is locked for good. The tokens you keep are yours; nothing locks them.' : 'The whole supply is created in your wallet in the same transaction. Nothing locks it, and nothing here sells it.', 'No owner and no mint, pause, freeze or transfer-fee function: nobody, including you and Aretia, can create more or freeze a holder.']) promiseList.append(h('li', '', t));
    f.append(promiseList);

    if (chain && enabled) {
      const check = h('div', 'lh-check-host');
      const paint = (): void => check.replaceChildren(checklistBox(formChecklist(chain)));
      paint();
      f.addEventListener('input', paint);
      f.append(check);
    }

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
        : h('p', 'wapp__banner wapp__banner--warn', config.mode === 'plain' ? `This creates a real token on ${chain.name} mainnet and spends real ${chain.symbol}. Read it all before you approve. Nothing is sent until you press the button at the bottom.` : `This creates a real token and a real, locked trading pool on ${chain.name} mainnet and spends real ${chain.symbol}: the fee and the pool coin, which you cannot get back. Read it all before you approve. Nothing is sent until you press the button at the bottom.`),
    );

    const dl = h('dl', 'wapp__rows');
    row(dl, 'Network', `${chain.name} (chain ${chain.chainId})`);
    row(dl, 'Total supply', `${amountText(config.totalSupplyRaw, config.decimals)} ${config.symbol}`);
    row(dl, 'Decimals', String(config.decimals));
    if (config.mode === 'locked') {
      const poolTokens = poolTokensOf(config);
      row(dl, 'Into the locked pool', `${amountText(poolTokens, config.decimals)} ${config.symbol} (${config.poolBps / 100}%) and ${coinText(config.poolCoinWei, chain.symbol)}`);
      row(dl, 'You keep', `${amountText(config.totalSupplyRaw - poolTokens, config.decimals)} ${config.symbol} in your wallet (${short(config.creator)})`);
      row(dl, 'Starting price', `${fromSmallestUnit((config.poolCoinWei * 10n ** BigInt(config.decimals)) / poolTokens, 18)} ${chain.symbol} per ${config.symbol}`);
      row(dl, 'Pool liquidity', 'Locked for good (sent to the dead address)');
      row(dl, 'Created by Aretia’s launch factory', link(short(chain.launch?.factory ?? ''), `${chain.explorer}/address/${chain.launch?.factory ?? ''}`));
    } else {
      row(dl, 'All of it goes to', `You (${short(config.creator)})`);
      row(dl, 'Created by Aretia’s factory', link(short(chain.factory ?? ''), `${chain.explorer}/address/${chain.factory ?? ''}`));
    }
    if (detailsSupported(chain) && wantsDetails()) {
      const shown = detailsState();
      if (shown.image) {
        const img = h('img', 'lh-det__review');
        img.alt = '';
        img.src = shown.image.previewUrl;
        row(dl, 'Picture', img);
      }
      if (shown.details.description) row(dl, 'Description', shown.details.description);
      for (const [k, v] of [['Website', shown.details.website], ['X', shown.details.x], ['Telegram', shown.details.telegram]] as const) if (v) row(dl, k, v);
      row(dl, 'Picture and details', 'Published right after the token is created. They are not part of the transaction.');
    }
    card.append(dl);

    card.append(h('span', 'wapp__eyebrow', `What it costs, in ${chain.symbol}`));
    const costs = h('dl', 'wapp__rows');
    row(costs, 'Aretia fee (sent with the transaction)', coinText(config.mode === 'plain' ? chain.feeWei : (chain.launch?.feeWei ?? 0n), chain.symbol));
    if (config.mode === 'locked') {
      row(costs, 'Coin for the pool', coinText(config.poolCoinWei, chain.symbol));
      row(costs, 'Total sent with the transaction', coinText(launchValueOf(config), chain.symbol));
    }
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
    card.append(
      checklistBox(
        evmChecklist({ symbol: config.symbol, supplyText: amountText(config.totalSupplyRaw, config.decimals), coin: chain.symbol, mode: config.mode, testnet: chain.testnet, feeWei: config.mode === 'plain' ? chain.feeWei : (chain.launch?.feeWei ?? 0n), poolCoinWei: config.poolCoinWei, poolBps: config.poolBps, gasWei: gasCostWei }),
      ),
    );

    const ack = h('label', 'wapp__check');
    const box = h('input');
    box.type = 'checkbox';
    box.checked = acknowledged;
    const go = h('button', 'wapp__btn wapp__btn--primary', config.mode === 'plain' ? (chain.testnet ? `Create token on ${chain.name}` : `Create token on ${chain.name} mainnet`) : chain.testnet ? `Create token and locked pool on ${chain.name}` : `Create token and locked pool on ${chain.name} mainnet`);
    go.type = 'button';
    go.disabled = !acknowledged || blockers.length > 0 || busy;
    box.addEventListener('change', () => {
      acknowledged = box.checked;
      go.disabled = !acknowledged || blockers.length > 0 || busy;
    });
    ack.append(box, h('span', '', config.mode === 'plain' ? 'I understand this creates a token, costs about the amount above, and cannot be undone.' : 'I understand this creates a token and a pool whose liquidity is locked for good, costs about the amount above, and cannot be undone.'));
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
      const locked = review?.config.mode === 'locked';
      const label = locked && s.id === 'confirming' ? 'Creating the token and its locked pool on the network' : locked && s.id === 'verifying' ? 'Reading the new token and pool back from the network' : s.label;
      const li = h('li', i < at ? 'is-done' : i === at ? 'is-now' : '', label);
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
        ? h('p', 'wapp__banner', outcome.pair ? 'Read back from the network: the name, symbol, decimals and total supply match what you approved, the pool holds exactly what you put in, all of its liquidity is locked, and your wallet holds the rest. No one can create more.' : 'Read back from the network: the name, symbol, decimals and total supply match what you approved, and your wallet holds all of it. No one can create more.')
        : errorBox(`The network does not show exactly what you approved: ${outcome.differences.join(' ')}`),
    );
    const dl = h('dl', 'wapp__rows');
    row(dl, 'Token address', outcome.token);
    if (outcome.pair) row(dl, 'Pool address', link(short(outcome.pair), `${chain.explorer}/address/${outcome.pair}`));
    row(dl, 'Transaction', link(short(outcome.txHash), `${chain.explorer}/tx/${outcome.txHash}`));
    row(dl, 'View the token', link('Open on the explorer', `${chain.explorer}/token/${outcome.token}`));
    card.append(dl);
    const badge = verifiedBadge(chain.key, outcome.token);
    if (badge) card.append(badge);
    const ask = h('p', 'wapp__fine', 'Want a “Verified by Aretia” badge? It records four checks on one day. It is not an audit or an endorsement. ');
    ask.append(link('Request verification', '/verified#request'));
    card.append(ask);
    const copy = h('button', 'wapp__btn wapp__btn--ghost', 'Copy token address');
    copy.type = 'button';
    copy.addEventListener('click', () => {
      void navigator.clipboard?.writeText(outcome!.token).then(() => (copy.textContent = 'Copied'));
    });
    card.append(copy);
    if (publish.state !== 'idle') {
      const box = h('p', publish.state === 'failed' ? 'wapp__banner wapp__banner--warn' : 'wapp__fine', publish.message);
      box.setAttribute('role', publish.state === 'failed' ? 'alert' : 'status');
      card.append(box);
      if (publish.state === 'failed') {
        const retry = h('button', 'wapp__btn wapp__btn--ghost', 'Try the picture and details again');
        retry.type = 'button';
        retry.addEventListener('click', () => void publishDetails());
        card.append(retry);
      }
    }
    card.append(h('p', 'wapp__fine', outcome.pair ? 'The pool is open: anyone can now buy and sell this token against it. Its liquidity is locked, so nobody can take it out. To see the token in your wallet, add the token address above.' : 'Nobody can buy this token yet: a token has no market until a liquidity pool exists, and this creation did not open one. Use "Open a liquidity pool" below, which locks the liquidity for good. To see the token in your wallet, add the token address above.'));
    const again = h('button', 'wapp__btn wapp__btn--primary', 'Create another');
    again.type = 'button';
    again.addEventListener('click', () => {
      stage = 'form';
      form = { ...DEFAULT_EVM_FORM, chain: form.chain };
      resetDetails();
      detailIssues = [];
      pendingDetails = null;
      publish = { state: 'idle', message: '' };
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
    const useDetails = detailsSupported(chainByKey(form.chain)) && wantsDetails();
    const details = useDetails ? checkDetails() : null;
    detailIssues = details && !details.ok ? details.issues : [];
    error = null;
    if (!v.ok || detailIssues.length > 0) {
      const formIssue = v.ok ? undefined : v.issues.find((i) => i.field === 'form' || i.field === 'chain');
      if (formIssue) error = formIssue.message;
      redrawNow();
      document.querySelector<HTMLElement>('[data-launch-root] [aria-invalid="true"]')?.focus();
      return;
    }
    busy = true;
    redrawNow();
    try {
      // Found out before anything is priced or signed, so nobody pays for a token whose picture cannot be stored.
      if (useDetails && !(await uploader.status())) throw new Error(`${NOT_SET_UP}, so the picture, description and links cannot be saved. Clear them to create the token without, or try again later.`);
      review = await (await flowFor(v.config.chain)).prepare(v.config);
      stage = 'review';
      acknowledged = false;
    } catch (e) {
      error = e instanceof Error && e.message.startsWith(NOT_SET_UP) ? e.message : `Could not price this on the network: ${friendlyEvmError(e)}`;
    } finally {
      busy = false;
      redrawNow();
    }
  }

  /** After the token exists: stores its picture and details under its address. Only the wallet that created it is accepted. Can be retried. */
  async function publishDetails(): Promise<void> {
    const o = outcome;
    const r = review;
    const p = pendingDetails;
    if (!o || !r || !p) return;
    publish = { state: 'working', message: 'Saving the picture and details…' };
    redrawNow();
    try {
      await uploader.publishEvm({ chain: r.config.chain.key, token: o.token, txHash: o.txHash, name: r.config.name, symbol: r.config.symbol, details: p.details, image: p.image });
      publish = { state: 'done', message: 'The picture and details are saved. They appear on Aretia’s token page and Launch Box within a few minutes.' };
    } catch (e) {
      publish = { state: 'failed', message: `The token was created, but its picture and details were not saved: ${e instanceof Error ? e.message : 'something went wrong'}` };
    } finally {
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
    const checked = checkDetails();
    pendingDetails = detailsSupported(r.config.chain) && wantsDetails() && checked.ok ? { details: checked.details, image: detailsState().image } : null;
    publish = { state: 'idle', message: '' };
    redrawNow();
    try {
      outcome = await (await flowFor(r.config.chain)).create(r, (p) => {
        progress = p;
        redrawNow();
      });
      stage = 'done';
      if (pendingDetails) void publishDetails();
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
      aretiaPool?.draw(markets?.aretiaPool ?? markets?.pool ?? card, redraw, form.chain, outcome?.token ?? null);
      curve?.draw(markets?.curve ?? card, redraw, form.chain, outcome?.token ?? null);
      if (markets && !curve) markets.curve.dataset.stage = 'off';
      if (orders && markets?.orders) orders.draw(markets.orders, redraw, form.chain);
    },
    isBusy: () => busy || pool.isBusy() || (aretiaPool?.isBusy() ?? false) || (curve?.isBusy() ?? false) || (orders?.isBusy() ?? false),
    stage: () => stage,
    reset(): void {
      pool.reset();
      aretiaPool?.reset();
      curve?.reset();
      orders?.reset();
      stage = 'form';
      review = null;
      outcome = null;
      acknowledged = false;
      error = null;
      adapter = null;
      resetDetails();
      detailIssues = [];
      pendingDetails = null;
      publish = { state: 'idle', message: '' };
    },
  };
}
