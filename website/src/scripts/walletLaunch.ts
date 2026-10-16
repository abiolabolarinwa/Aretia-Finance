/**
 * The Launch page of the web wallet: create a token on Solana. This file only draws the page and connects it to the wallet; the
 * rules are in walletLaunchCore.ts, the transactions in walletLaunchTx.ts, the chain reads in walletLaunchChain.ts and the order
 * of events in walletLaunchFlow.ts, each with its own tests.
 *
 * What it does: one fixed-supply token with its name, symbol and link stored on the token, created in two transactions that the
 * person's own wallet signs. What it does not do: start a sale, open a pool, or lock anything. It charges one flat creation fee, shown before signing.
 * Everything typed, and everything read back from the chain, is shown with textContent, never as markup.
 */
import { browserStorage } from '../swings/history.js';
import { fromSmallestUnit } from './walletTools';
import {
  DEFAULT_FORM,
  LAUNCH_LIMITS,
  disclosuresOf,
  validateLaunch,
  type FieldIssue,
  type LaunchForm,
} from './walletLaunchCore';
import { LaunchError, LaunchFlow, friendlyError, type Outcome, type Progress, type Review } from './walletLaunchFlow';
import { createEvmLaunch, type LaunchEvmHost } from './walletLaunchEvm';
import { LAUNCH_EVM_CHAINS, chainEnabled, type LaunchEvmChainKey } from './walletLaunchEvmCore';
import { fetchAccount, loadWeb3, rpcCall, signAndSubmitTransaction, simulateTransaction, waitForConfirmation } from './walletSend';

export interface LaunchHost {
  /** The connected Solana wallet, or null. */
  getAddress(): string | null;
  /** Re-reads balances after something was created. */
  refreshWallet(): void;
  /** The Ethereum-style side: the connected account and a way to connect. Absent where the page has no such wallet. */
  evm?: LaunchEvmHost;
}

type Network = 'solana' | LaunchEvmChainKey;
type Stage = 'form' | 'review' | 'working' | 'done';

const h = <K extends keyof HTMLElementTagNameMap>(tag: K, cls = '', text?: string): HTMLElementTagNameMap[K] => {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text !== undefined) n.textContent = text;
  return n;
};

/** 1000000000 -> 1,000,000,000 (whole part only). */
const grouped = (text: string): string => text.replace(/^(\d+)/, (whole) => whole.replace(/\B(?=(\d{3})+(?!\d))/g, ','));
const amountText = (raw: bigint, decimals: number): string => grouped(fromSmallestUnit(raw, decimals));
const sol = (lamports: bigint): string => `${fromSmallestUnit(lamports, 9)} SOL`;
const short = (a: string): string => `${a.slice(0, 4)}…${a.slice(-4)}`;
const solscan = (kind: 'token' | 'tx' | 'account', id: string): string => `https://solscan.io/${kind}/${encodeURIComponent(id)}`;

const PROGRESS_STEPS: { id: Progress[]; label: string }[] = [
  { id: ['checking'], label: 'Checking everything once more' },
  { id: ['signing-1'], label: 'Waiting for you to approve the first transaction in your wallet' },
  { id: ['confirming-1'], label: 'Creating the token on Solana' },
  { id: ['verifying-1'], label: 'Reading the new token back from the network' },
  { id: ['signing-2'], label: 'Waiting for you to approve the second transaction' },
  { id: ['confirming-2'], label: 'Creating the supply and giving up the mint authority' },
  { id: ['verifying-2'], label: 'Checking the supply and each wallet’s share' },
  { id: ['done'], label: 'Done' },
];

export function initLaunch(host: LaunchHost): { onShow(): void; onWalletChange(): void } {
  const root = document.querySelector<HTMLElement>('[data-launch-root]');
  // If the browser will not store anything, creating still works; only finishing a half-made token after a reload is lost.
  const kept = new Map<string, string>();
  const storage = browserStorage() ?? { getItem: (k: string) => kept.get(k) ?? null, setItem: (k: string, v: string) => void kept.set(k, v) };

  let stage: Stage = 'form';
  let form: LaunchForm = { ...DEFAULT_FORM };
  let issues: FieldIssue[] = [];
  let review: Review | null = null;
  let outcome: Outcome | null = null;
  let error: string | null = null;
  let progress: Progress = 'checking';
  let busy = false;
  let acknowledged = false;
  let notice: { action: 'none' | 'finish' | 'verify' | 'stop'; reason: string } | null = null;
  let flow: LaunchFlow | null = null;
  let network: Network = 'solana';
  const evm = host.evm ? createEvmLaunch(host.evm) : null;

  async function flowFor(): Promise<LaunchFlow> {
    if (flow) return flow;
    const web3 = await loadWeb3();
    flow = new LaunchFlow({
      web3,
      rentFor: async (size) => BigInt(await rpcCall<number>('getMinimumBalanceForRentExemption', [size])),
      balanceOf: async (address) => (await fetchAccount(address))?.lamports ?? 0n,
      latestBlockhash: async () => (await rpcCall<{ value: { blockhash: string; lastValidBlockHeight: number } }>('getLatestBlockhash', [{ commitment: 'confirmed' }])).value,
      fetchAccount,
      simulate: simulateTransaction,
      signAndSubmit: (tx, extra) => signAndSubmitTransaction(tx, extra),
      confirm: (signature) => waitForConfirmation(signature),
      storage,
      now: () => Date.now(),
    });
    return flow;
  }

  const set = (f: Partial<LaunchForm>): void => {
    form = { ...form, ...f };
  };

  // ---------------------------------------------------------------- drawing

  function field(label: string, name: keyof LaunchForm, opts: { placeholder?: string; mono?: boolean; inputmode?: string; hint?: string } = {}): HTMLElement {
    const wrap = h('div', 'wapp-ln__field');
    const id = `launch-${name}`;
    const lab = h('label', 'wapp__eyebrow', label);
    lab.htmlFor = id;
    const input = h('input', `wapp__input${opts.mono ? ' wapp-mono' : ''}`);
    input.id = id;
    input.value = String(form[name] ?? '');
    input.autocomplete = 'off';
    input.spellcheck = false;
    if (opts.placeholder) input.placeholder = opts.placeholder;
    if (opts.inputmode) input.inputMode = opts.inputmode;
    input.addEventListener('input', () => {
      set({ [name]: input.value } as Partial<LaunchForm>);
      if (name === 'treasuryPct') syncTreasury();
    });
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

  let treasuryField: HTMLElement | null = null;
  /** The treasury address is only asked for when there is a treasury share. Toggled in place so typing is never interrupted. */
  function syncTreasury(): void {
    if (treasuryField) treasuryField.hidden = !(Number(form.treasuryPct) > 0 || form.treasuryAddress.trim() !== '' || issues.some((i) => i.field === 'treasuryAddress'));
  }

  function drawForm(card: HTMLElement): void {
    const address = host.getAddress();
    card.append(h('span', 'wapp__eyebrow', 'Aretia Launch'), h('h2', 'wapp__h2', 'Create a token'));
    card.append(
      h('p', 'wapp__fine', 'Make a token with a fixed supply and a name that is stored on the token itself. Your own wallet signs everything; Aretia never holds your keys. Creating a token costs a flat 0.05 SOL Aretia fee, shown before you sign.'),
    );
    if (!address) {
      card.append(h('p', 'wapp__banner wapp__banner--warn', 'Connect a Solana wallet to create a token.'));
    }
    const f = h('form', 'wapp__form wapp-ln__form');
    f.noValidate = true;
    f.append(field('Name', 'name', { placeholder: 'Example Token', hint: `Up to ${LAUNCH_LIMITS.nameMax} characters.` }));
    const row1 = h('div', 'wapp-ln__row');
    row1.append(field('Symbol', 'symbol', { placeholder: 'EXMP', hint: 'Letters and digits.' }), field('Decimals', 'decimals', { inputmode: 'numeric', hint: '6 is usual. 0 to 9.' }));
    f.append(row1);
    f.append(field('Total supply', 'supply', { inputmode: 'decimal', hint: 'In whole tokens. It can never be increased.' }));
    const row2 = h('div', 'wapp-ln__row');
    row2.append(
      field('Your share (%)', 'creatorPct', { inputmode: 'decimal', hint: `Up to ${LAUNCH_LIMITS.creatorMaxBps / 100}%.` }),
      field('Treasury share (%)', 'treasuryPct', { inputmode: 'decimal', hint: `Optional. Up to ${LAUNCH_LIMITS.treasuryMaxBps / 100}%.` }),
    );
    f.append(row2);
    treasuryField = field('Treasury address', 'treasuryAddress', { mono: true, placeholder: 'Solana address', hint: 'Where the treasury share is sent.' });
    f.append(treasuryField);
    syncTreasury();
    f.append(field('Link to token details (optional)', 'metadataUri', { mono: true, placeholder: 'https://… or ipfs://…', hint: 'A page or file you host that describes the token. Aretia does not upload or check it.' }));

    const mutable = h('label', 'wapp__check');
    const box = h('input');
    box.type = 'checkbox';
    box.checked = form.metadataMutable;
    box.addEventListener('change', () => set({ metadataMutable: box.checked }));
    mutable.append(box, h('span', '', 'Let me change the name, symbol and link later. Leave this off if you want holders to be sure they never change.'));
    f.append(mutable);

    f.append(
      h('p', 'wapp__fine', 'The rest of the supply, after your share and the treasury’s, is held back. It is created in your wallet and stays there. Nothing locks it, and nothing here sells it.'),
    );
    f.append(h('p', 'wapp__fine', 'The mint and freeze powers are always given up: nobody, including you, can create more of this token or freeze a holder.'));

    const go = h('button', 'wapp__btn wapp__btn--primary', busy ? 'Checking…' : 'Review');
    go.type = 'submit';
    go.disabled = busy || !address;
    f.append(go);
    f.addEventListener('submit', (e) => {
      e.preventDefault();
      void startReview();
    });
    card.append(f);
    if (error) card.append(errorBox(error));
  }

  function errorBox(text: string): HTMLElement {
    const p = h('p', 'wapp__banner wapp__banner--warn', text);
    p.setAttribute('role', 'alert');
    return p;
  }

  function row(dl: HTMLElement, k: string, v: string | HTMLElement): void {
    const d = h('div');
    const dt = h('dt', '', k);
    const dd = h('dd');
    if (typeof v === 'string') dd.textContent = v;
    else dd.append(v);
    d.append(dt, dd);
    dl.append(d);
  }

  function drawReview(card: HTMLElement): void {
    if (!review) return;
    const { config, cost, lines, mint, balance, blockers } = review;
    card.append(h('span', 'wapp__eyebrow', 'Review'), h('h2', 'wapp__h2', `${config.name} (${config.symbol})`));
    card.append(h('p', 'wapp__banner wapp__banner--warn', 'This creates a real token on Solana mainnet and spends real SOL. Read it all before you approve. Nothing is sent until you press the button at the bottom.'));

    const dl = h('dl', 'wapp__rows');
    row(dl, 'Total supply', `${amountText(config.totalSupplyRaw, config.decimals)} ${config.symbol}`);
    row(dl, 'Decimals', String(config.decimals));
    row(dl, 'New token address', mint);
    row(dl, 'Name, symbol and link', config.metadataMutable ? 'You can change them later' : 'Cannot be changed');
    row(dl, 'Link', config.metadataUri === '' ? 'None' : config.metadataUri);
    card.append(dl);

    card.append(h('span', 'wapp__eyebrow', 'Who receives the supply'));
    const who = h('dl', 'wapp__rows');
    for (const l of lines) {
      row(who, `${l.owner === config.creator ? 'You' : 'Treasury'} (${short(l.owner)})`, `${amountText(l.amount, config.decimals)} ${config.symbol}`);
    }
    card.append(who);
    card.append(h('p', 'wapp__fine', `${lines.map((l) => l.labels.join(' + ')).join('; ')}.`));

    card.append(h('span', 'wapp__eyebrow', 'What it costs, in SOL'));
    const costs = h('dl', 'wapp__rows');
    row(costs, 'Aretia fee', sol(cost.aretiaFee));
    row(costs, 'Network fees (two transactions)', sol(cost.networkFee));
    row(costs, 'Deposit for the token', sol(cost.mintDeposit));
    row(costs, `Deposits for ${cost.accountCount} token account${cost.accountCount === 1 ? '' : 's'}`, sol(cost.tokenAccountDeposits));
        row(costs, 'Total, about', sol(cost.total));
    row(costs, 'Your balance', sol(balance));
    card.append(costs);
    card.append(h('p', 'wapp__fine', 'The deposits keep the accounts alive on Solana. The estimate comes from the network’s current rent; the final amounts are shown by your wallet.'));

    card.append(h('span', 'wapp__eyebrow', 'What this means'));
    const list = h('ul', 'wapp__list');
    for (const d of disclosuresOf(config)) {
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
    const go = h('button', 'wapp__btn wapp__btn--primary', 'Create token on Solana mainnet');
    go.type = 'button';
    go.disabled = !acknowledged || blockers.length > 0 || busy;
    box.addEventListener('change', () => {
      acknowledged = box.checked;
      go.disabled = !acknowledged || blockers.length > 0 || busy;
    });
    ack.append(box, h('span', '', 'I understand this creates a real token, costs about the amount above, and cannot be undone.'));
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
    go.addEventListener('click', () => void create());
    actions.append(go, back);
    card.append(actions);
    if (error) card.append(errorBox(error));
  }

  function drawWorking(card: HTMLElement): void {
    card.append(h('span', 'wapp__eyebrow', 'Creating'), h('h2', 'wapp__h2', 'Creating your token'));
    card.append(h('p', 'wapp__fine', 'Keep this page open. Your wallet will ask you to approve two transactions, one after the other.'));
    const list = h('ol', 'wapp-ln__steps');
    const at = PROGRESS_STEPS.findIndex((s) => s.id.includes(progress));
    PROGRESS_STEPS.forEach((s, i) => {
      const li = h('li', i < at ? 'is-done' : i === at ? 'is-now' : '', s.label);
      if (i === at) li.setAttribute('aria-current', 'step');
      list.append(li);
    });
    card.append(list);
  }

  function link(text: string, href: string): HTMLAnchorElement {
    const a = h('a', '', text);
    a.href = href;
    a.target = '_blank';
    a.rel = 'noopener noreferrer';
    return a;
  }

  function drawDone(card: HTMLElement): void {
    if (!outcome) return;
    const ok = outcome.differences.length === 0;
    card.append(h('span', 'wapp__eyebrow', ok ? 'Created' : 'Created, with differences'), h('h2', 'wapp__h2', ok ? 'Your token exists' : 'Your token exists, but check this'));
    card.append(
      ok
        ? h('p', 'wapp__banner', 'Read back from the network: the supply, the name, the symbol, the link and each wallet’s share match what you approved, and no one can create more of it.')
        : errorBox(`The network does not show exactly what you approved: ${outcome.differences.join(' ')}`),
    );
    const dl = h('dl', 'wapp__rows');
    row(dl, 'Token address', outcome.mint);
    if (outcome.step1) row(dl, 'First transaction', link(short(outcome.step1), solscan('tx', outcome.step1)));
    if (outcome.step2) row(dl, 'Second transaction', link(short(outcome.step2), solscan('tx', outcome.step2)));
    row(dl, 'View the token', link('Open on Solscan', solscan('token', outcome.mint)));
    card.append(dl);
    const copy = h('button', 'wapp__btn wapp__btn--ghost', 'Copy token address');
    copy.type = 'button';
    copy.addEventListener('click', () => {
      void navigator.clipboard?.writeText(outcome!.mint).then(() => (copy.textContent = 'Copied'));
    });
    card.append(copy);
    card.append(h('p', 'wapp__fine', 'Nobody can buy this token yet. A token has no market until a sale or a liquidity pool exists, and this page does not create one. The tokens you hold are in your wallet now.'));
    const again = h('button', 'wapp__btn wapp__btn--primary', 'Create another');
    again.type = 'button';
    again.addEventListener('click', () => {
      stage = 'form';
      form = { ...DEFAULT_FORM };
      review = null;
      outcome = null;
      acknowledged = false;
      error = null;
      draw();
    });
    card.append(again);
  }

  function drawNotice(card: HTMLElement): void {
    if (!notice) return;
    const wrap = h('div', 'wapp-ln__notice');
    wrap.append(h('b', '', 'An earlier creation is unfinished. '), document.createTextNode(notice.reason));
    const actions = h('div', 'wapp__row-actions');
    const act = (label: string, fn: () => Promise<void> | void, primary = false) => {
      const b = h('button', `wapp__btn ${primary ? 'wapp__btn--primary' : 'wapp__btn--ghost'}`, label);
      b.type = 'button';
      b.disabled = busy;
      b.addEventListener('click', () => void fn());
      actions.append(b);
    };
    if (notice.action === 'finish') act('Finish creating it', finishStored, true);
    if (notice.action === 'verify') act('Check it', verifyStored, true);
    if (notice.action === 'none' || notice.action === 'stop') act('Dismiss', dismissStored);
    wrap.append(actions);
    card.append(wrap);
  }

  /** The network choice. A network whose token factory is not deployed yet is listed but cannot be chosen. */
  function drawPicker(): HTMLElement {
    const wrap = h('div', 'wapp-ln__field');
    const lab = h('label', 'wapp__eyebrow', 'Network');
    lab.htmlFor = 'launch-network';
    const select = h('select', 'wapp__input');
    select.id = 'launch-network';
    const option = (value: Network, text: string, enabled: boolean, into: HTMLElement): void => {
      const o = h('option', '', enabled ? text : `${text} — not available yet`);
      o.value = value;
      o.disabled = !enabled;
      o.selected = value === network;
      into.append(o);
    };
    option('solana', 'Solana', true, select);
    const group = (label: string, testnet: boolean): void => {
      if (!evm) return;
      const g = h('optgroup');
      g.label = label;
      for (const c of LAUNCH_EVM_CHAINS.filter((x) => x.testnet === testnet)) option(c.key, c.name, chainEnabled(c), g);
      select.append(g);
    };
    group('Ethereum-style networks', false);
    group('Test networks', true);
    // Never switch networks while something is being created.
    select.disabled = busy || (evm?.isBusy() ?? false);
    select.addEventListener('change', () => {
      network = select.value as Network;
      error = null;
      draw();
    });
    wrap.append(lab, select);
    return wrap;
  }

  function draw(): void {
    if (!root) return;
    root.textContent = '';
    const card = h('div', 'wapp-ln');
    card.append(drawPicker());
    if (network !== 'solana' && evm) {
      evm.draw(card, draw, network);
      root.append(card);
      return;
    }
    drawNotice(card);
    if (stage === 'form') drawForm(card);
    else if (stage === 'review') drawReview(card);
    else if (stage === 'working') drawWorking(card);
    else drawDone(card);
    root.append(card);
  }

  // ---------------------------------------------------------------- actions

  async function startReview(): Promise<void> {
    const creator = host.getAddress() ?? '';
    const v = validateLaunch(form, creator);
    issues = v.ok ? [] : v.issues;
    error = null;
    if (!v.ok) {
      draw();
      root?.querySelector<HTMLElement>('[aria-invalid="true"]')?.focus();
      return;
    }
    busy = true;
    draw();
    try {
      review = await (await flowFor()).prepare(v.config);
      stage = 'review';
      acknowledged = false;
    } catch (e) {
      error = `Could not price this on the network: ${friendlyError(e)}`;
    } finally {
      busy = false;
      draw();
    }
  }

  async function runWith(job: (f: LaunchFlow, onProgress: (p: Progress) => void) => Promise<Outcome>): Promise<void> {
    busy = true;
    stage = 'working';
    progress = 'checking';
    error = null;
    draw();
    try {
      outcome = await job(await flowFor(), (p) => {
        progress = p;
        draw();
      });
      stage = 'done';
      notice = null;
      host.refreshWallet();
    } catch (e) {
      error = e instanceof LaunchError ? e.message : friendlyError(e);
      stage = review ? 'review' : 'form';
      await checkStored();
    } finally {
      busy = false;
      review = stage === 'done' ? null : review;
      draw();
    }
  }

  const create = (): Promise<void> => {
    const r = review;
    if (!r || !acknowledged) return Promise.resolve();
    return runWith((f, p) => f.create(r, p));
  };

  const finishStored = (): Promise<void> => {
    const creator = host.getAddress();
    if (!creator) return Promise.resolve();
    return runWith((f, p) => f.finish(creator, p));
  };

  async function verifyStored(): Promise<void> {
    const creator = host.getAddress();
    if (!creator) return;
    busy = true;
    draw();
    try {
      outcome = await (await flowFor()).verifyStored(creator);
      stage = 'done';
      notice = null;
      host.refreshWallet();
    } catch (e) {
      error = e instanceof LaunchError ? e.message : friendlyError(e);
    } finally {
      busy = false;
      draw();
    }
  }

  async function dismissStored(): Promise<void> {
    const creator = host.getAddress();
    if (creator) (await flowFor()).discard(creator);
    notice = null;
    draw();
  }

  /** Looks for an unfinished creation for the connected wallet and says what can be done about it. */
  async function checkStored(): Promise<void> {
    const creator = host.getAddress();
    if (!creator) {
      notice = null;
      return;
    }
    try {
      const a = await (await flowFor()).assess(creator);
      notice = a ? { action: a.action, reason: a.reason } : null;
    } catch {
      notice = null;
    }
  }

  return {
    onShow(): void {
      draw();
      void checkStored().then(draw);
    },
    onWalletChange(): void {
      // A different wallet is a different person: nothing typed or approved for the last one carries over.
      evm?.reset();
      review = null;
      outcome = null;
      stage = 'form';
      acknowledged = false;
      error = null;
      notice = null;
      draw();
      void checkStored().then(draw);
    },
  };
}

