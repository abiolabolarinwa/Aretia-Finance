/**
 * The "Open a liquidity pool" card of the Launch page. This file only draws it and connects it to the wallet; the rules are in
 * walletPoolCore.ts, the transaction and its check in walletPoolTx.ts and the order of events in walletPoolFlow.ts.
 *
 * What it does: opens one single-sided Meteora pool for a fixed-supply token the person holds, in one transaction their own wallet
 * signs, with Aretia's flat fee in the same transaction. Everything typed, and everything read from the chain, is shown with
 * textContent, never as markup.
 */
import { fromSmallestUnit, toSmallestUnit } from './walletTools';
import { LaunchError, friendlyError } from './walletLaunchFlow';
import {
  DEFAULT_POOL_FORM,
  LAUNCH_PROTECTION_MINUTES,
  LAUNCH_PROTECTION_START_BPS,
  POOL_FEE_LAMPORTS,
  POOL_TRADING_FEES_BPS,
  poolDisclosures,
  validatePool,
  type PoolForm,
  type PoolIssue,
  type PoolToken,
} from './walletPoolCore';
import { PoolFlow, type PoolOutcome, type PoolProgress, type PoolReview } from './walletPoolFlow';
import { RPC_URL, fetchAccount, loadWeb3, rpcCall, signAndSubmitTransaction, simulateWithBalance, waitForConfirmation } from './walletSend';

export interface PoolHost {
  getAddress(): string | null;
  refreshWallet(): void;
}

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

const STEPS: { id: PoolProgress; label: string }[] = [
  { id: 'checking', label: 'Checking everything once more' },
  { id: 'signing', label: 'Waiting for you to approve the transaction in your wallet' },
  { id: 'confirming', label: 'Opening the pool on Solana' },
  { id: 'verifying', label: 'Reading the new pool back from the network' },
  { id: 'done', label: 'Done' },
];

export function initPool(host: PoolHost): { onShow(): void; onWalletChange(): void; offer(mint: string): void } {
  const root = document.querySelector<HTMLElement>('[data-pool-root]');

  let stage: Stage = 'form';
  let form: PoolForm = { ...DEFAULT_POOL_FORM };
  let issues: PoolIssue[] = [];
  let review: PoolReview | null = null;
  let token: PoolToken | null = null;
  let outcome: PoolOutcome | null = null;
  let error: string | null = null;
  let progress: PoolProgress = 'checking';
  let busy = false;
  let acknowledged = false;
  let flow: PoolFlow | null = null;

  async function flowFor(): Promise<PoolFlow> {
    if (flow) return flow;
    const web3 = await loadWeb3();
    const [sdk, bn] = await Promise.all([import('@meteora-ag/cp-amm-sdk'), import('bn.js')]);
    const libs = { sdk, BN: bn.default, cpAmm: new sdk.CpAmm(new web3.Connection(RPC_URL)) };
    flow = new PoolFlow({
      web3,
      libs,
      balanceOf: async (address) => (await fetchAccount(address))?.lamports ?? 0n,
      latestBlockhash: async () => (await rpcCall<{ value: { blockhash: string; lastValidBlockHeight: number } }>('getLatestBlockhash', [{ commitment: 'confirmed' }])).value,
      fetchAccount,
      simulate: simulateWithBalance,
      signAndSubmit: (tx, extra) => signAndSubmitTransaction(tx, extra),
      confirm: (signature) => waitForConfirmation(signature),
    });
    return flow;
  }

  const set = (f: Partial<PoolForm>): void => {
    form = { ...form, ...f };
  };

  // ---------------------------------------------------------------- drawing

  function field(label: string, name: 'mint' | 'tokenAmount' | 'price', opts: { placeholder?: string; mono?: boolean; inputmode?: string; hint?: string } = {}): HTMLElement {
    const wrap = h('div', 'wapp-ln__field');
    const id = `pool-${name}`;
    const lab = h('label', 'wapp__eyebrow', label);
    lab.htmlFor = id;
    const input = h('input', `wapp__input${opts.mono ? ' wapp-mono' : ''}`);
    input.id = id;
    input.value = form[name];
    input.autocomplete = 'off';
    input.spellcheck = false;
    if (opts.placeholder) input.placeholder = opts.placeholder;
    if (opts.inputmode) input.inputMode = opts.inputmode;
    input.addEventListener('input', () => set({ [name]: input.value } as Partial<PoolForm>));
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

  function drawForm(card: HTMLElement): void {
    const address = host.getAddress();
    card.append(h('h2', 'wapp__h2', 'Open a liquidity pool'));
    card.append(
      h('p', 'wapp__fine', `Your tokens go into a pool at a starting price you choose, and buyers pay SOL. Your own wallet signs everything. Opening a pool costs a flat ${sol(POOL_FEE_LAMPORTS)} Aretia fee, shown before you sign.`),
    );
    if (!address) card.append(h('p', 'wapp__banner wapp__banner--warn', 'Connect a Solana wallet to open a pool.'));
    const f = h('form', 'wapp__form wapp-ln__form');
    f.noValidate = true;
    f.append(field('Token address', 'mint', { mono: true, placeholder: 'Token address', hint: 'A fixed-supply token you hold, such as one made on this page.' }));
    f.append(field('Tokens to put in the pool', 'tokenAmount', { inputmode: 'decimal', hint: 'In whole tokens. Only your tokens go in; nothing is bought.' }));
    f.append(field('Starting price (SOL per token)', 'price', { inputmode: 'decimal', placeholder: '0.000001', hint: 'Nobody can buy below this. It is not checked against any market.' }));

    const feeWrap = h('div', 'wapp-ln__field');
    const feeLabel = h('label', 'wapp__eyebrow', 'Trading fee');
    feeLabel.htmlFor = 'pool-fee';
    const select = h('select', 'wapp__input');
    select.id = 'pool-fee';
    for (const bps of POOL_TRADING_FEES_BPS) {
      const o = h('option', '', `${bps / 100}%`);
      o.value = String(bps);
      o.selected = String(bps) === form.tradingFeeBps;
      select.append(o);
    }
    select.addEventListener('change', () => set({ tradingFeeBps: select.value }));
    feeWrap.append(feeLabel, select, h('p', 'wapp__fine', 'Taken from each trade and paid to you, the owner of the position. Aretia takes none of it.'));
    f.append(feeWrap);

    const protWrap = h('div', 'wapp-ln__field');
    const protLabel = h('label', 'wapp__check');
    const protBox = h('input');
    protBox.type = 'checkbox';
    protBox.id = 'pool-protection';
    protBox.checked = form.protection;
    protLabel.append(protBox, h('span', '', 'Launch protection (recommended)'));
    const winLabel = h('label', 'wapp__eyebrow', 'Protection window');
    winLabel.htmlFor = 'pool-protection-minutes';
    const win = h('select', 'wapp__input');
    win.id = 'pool-protection-minutes';
    for (const m of LAUNCH_PROTECTION_MINUTES) {
      const o = h('option', '', `${m} minutes`);
      o.value = String(m);
      o.selected = String(m) === form.protectionMinutes;
      win.append(o);
    }
    win.disabled = !form.protection;
    win.addEventListener('change', () => set({ protectionMinutes: win.value }));
    protBox.addEventListener('change', () => {
      set({ protection: protBox.checked });
      win.disabled = !protBox.checked;
    });
    protWrap.append(
      protLabel,
      h('p', 'wapp__fine', `The fee starts at ${LAUNCH_PROTECTION_START_BPS / 100}% and falls in a straight line to the fee above over the window, so a bot that buys the moment the pool opens pays far more than a person who arrives later. The first buyers pay the higher fee, and it is paid to you. Turn it off for a flat fee from the first trade.`),
      winLabel,
      win,
    );
    f.append(protWrap);

    // No option: every pool opened on Aretia is locked for good, so buyers can rely on it.
    const lock = h('ul', 'lh-promises');
    lock.append(h('li', '', 'The liquidity is locked for good. Every pool opened on Aretia is, so buyers can trust it. Nobody, you included, can take the tokens or the SOL back out. You can still claim the trading fees, so choose the starting price with care: it cannot be changed.'));
    f.append(lock);

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

  function drawReview(card: HTMLElement): void {
    if (!review || !token) return;
    const { config, cost, balance, blockers, built } = review;
    card.append(h('span', 'wapp__eyebrow', 'Review'), h('h2', 'wapp__h2', 'Open a liquidity pool'));
    card.append(h('p', 'wapp__banner wapp__banner--warn', 'This opens a real pool on Solana mainnet and spends real SOL. Read it all before you approve. Nothing is sent until you press the button at the bottom.'));

    const dl = h('dl', 'wapp__rows');
    row(dl, 'Token', short(config.mint));
    row(dl, 'Tokens going in', amountText(config.tokenAmountRaw, config.decimals));
    row(dl, 'Starting price', `${config.price} SOL per token`);
    const priceE12 = BigInt(toSmallestUnit(config.price, 12) ?? '0');
    const marketCap = (priceE12 * token.supply) / (1000n * 10n ** BigInt(config.decimals));
    row(dl, 'Worth at the starting price', `about ${fromSmallestUnit(marketCap, 9)} SOL for the whole supply`);
    row(dl, 'Trading fee', `${config.tradingFeeBps / 100}%, paid to you`);
    row(
      dl,
      'Launch protection',
      config.launchProtection
        ? `On: starts at ${config.launchProtection.startBps / 100}%, falls to ${config.tradingFeeBps / 100}% over ${config.launchProtection.minutes} minutes`
        : 'Off: the fee is flat from the first trade',
    );
    row(dl, 'Liquidity', config.lockLiquidity ? 'Locked for good' : 'Not locked: you can remove it');
    row(dl, 'Pool address', short(built.pool));
    card.append(dl);

    card.append(h('span', 'wapp__eyebrow', 'What it costs, in SOL'));
    const costs = h('dl', 'wapp__rows');
    row(costs, 'Aretia fee', sol(cost.aretiaFee));
    row(costs, 'Network fee and deposits', sol(cost.network));
    row(costs, 'Total, about', sol(cost.total));
    row(costs, 'Your balance', sol(balance));
    card.append(costs);
    card.append(h('p', 'wapp__fine', 'The deposits keep the pool’s accounts alive on Solana. The amounts come from a trial run on the network; your wallet shows the final ones.'));

    card.append(h('span', 'wapp__eyebrow', 'What this means'));
    const list = h('ul', 'wapp__list');
    for (const d of poolDisclosures(config)) {
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
    const go = h('button', 'wapp__btn wapp__btn--primary', 'Open pool on Solana mainnet');
    go.type = 'button';
    go.disabled = !acknowledged || blockers.length > 0 || busy;
    box.addEventListener('change', () => {
      acknowledged = box.checked;
      go.disabled = !acknowledged || blockers.length > 0 || busy;
    });
    ack.append(box, h('span', '', 'I understand this opens a real pool, costs about the amount above, and cannot be undone.'));
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
    card.append(h('span', 'wapp__eyebrow', 'Opening'), h('h2', 'wapp__h2', 'Opening your pool'));
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
    card.append(h('span', 'wapp__eyebrow', ok ? 'Opened' : 'Opened, with differences'), h('h2', 'wapp__h2', ok ? 'Your pool is open' : 'Your pool is open, but check this'));
    card.append(ok ? h('p', 'wapp__banner', 'Read back from the network: the pool exists and belongs to the pool program. People can now buy the token with SOL at or above your starting price.') : errorBox(`The network does not show exactly what you approved: ${outcome.differences.join(' ')}`));
    const dl = h('dl', 'wapp__rows');
    row(dl, 'Pool address', outcome.pool);
    row(dl, 'Transaction', link(short(outcome.signature), `https://solscan.io/tx/${encodeURIComponent(outcome.signature)}`));
    row(dl, 'View the pool', link('Open on Meteora', `https://app.meteora.ag/dammv2/${encodeURIComponent(outcome.pool)}`));
    card.append(dl);
    const again = h('button', 'wapp__btn wapp__btn--primary', 'Open another');
    again.type = 'button';
    again.addEventListener('click', () => {
      stage = 'form';
      form = { ...DEFAULT_POOL_FORM };
      review = null;
      outcome = null;
      acknowledged = false;
      error = null;
      draw();
    });
    card.append(again);
  }

  function draw(): void {
    if (!root) return;
    root.textContent = '';
    root.dataset.stage = stage;
    const card = h('div', 'wapp-ln');
    if (stage === 'form') drawForm(card);
    else if (stage === 'review') drawReview(card);
    else if (stage === 'working') drawWorking(card);
    else drawDone(card);
    root.append(card);
  }

  // ---------------------------------------------------------------- actions

  async function startReview(): Promise<void> {
    const creator = host.getAddress() ?? '';
    error = null;
    busy = true;
    draw();
    try {
      const f = await flowFor();
      token = form.mint.trim() === '' ? null : await f.loadToken(creator, form.mint.trim()).catch(() => null);
      const v = validatePool(form, creator, token);
      issues = v.ok ? [] : v.issues;
      if (!v.ok || !token) {
        busy = false;
        draw();
        root?.querySelector<HTMLElement>('[aria-invalid="true"]')?.focus();
        return;
      }
      review = await f.prepare(v.config, token);
      stage = 'review';
      acknowledged = false;
    } catch (e) {
      error = `Could not price this on the network: ${friendlyError(e)}`;
    } finally {
      busy = false;
      draw();
    }
  }

  async function create(): Promise<void> {
    const r = review;
    if (!r || !acknowledged) return;
    busy = true;
    stage = 'working';
    progress = 'checking';
    error = null;
    draw();
    try {
      outcome = await (await flowFor()).create(r, (p) => {
        progress = p;
        draw();
      });
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
    onShow: draw,
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
      // Tells the Launch page frame to open the pool tab (walletLaunchHub.ts).
      root?.dispatchEvent(new CustomEvent('lh:offer', { bubbles: true }));
      form = { ...DEFAULT_POOL_FORM, mint };
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
