/**
 * The "Aretia Pool" card of the Launch page. This file only draws it and connects it to the wallet; the rules are in
 * walletAretiaPoolCore.ts, the transactions and their check in walletAretiaPoolTx.ts and the order of events in walletAretiaPoolFlow.ts.
 *
 * It is off on mainnet. The page only contains the card when the site is built with PUBLIC_ARETIA_POOL_ENABLED=1, and even then the card
 * shows a notice and no form until walletAretiaPoolCore.ts has a mainnet program address, which it will not have before an independent
 * audit. Everything typed, and everything read from the chain, is shown with textContent, never as markup.
 */
import { fromSmallestUnit, isSolanaAddress, toSmallestUnit } from './walletTools';
import { LaunchError, friendlyError } from './walletLaunchFlow';
import { POOL_TRADING_FEES_BPS, type PoolIssue, type PoolToken } from './walletPoolCore';
import {
  ARETIA_POOL_FEE_LAMPORTS,
  aretiaPoolDisclosures,
  aretiaPoolProgramFor,
  DEFAULT_ARETIA_POOL_FORM,
  LAUNCH_PROTECTION,
  PRICE_RANGES,
  type PriceRange,
  type LaunchProtection,
  type AretiaPoolForm,
  priceText,
  ARETIA_SLIPPAGE_BPS_DEFAULT,
  poolMathOf,
  validateAretiaPool,
} from './walletAretiaPoolCore';
import { AretiaPoolFlow, type AretiaPoolFlowDeps, type AretiaPoolOutcome, type AretiaPoolProgress, type AretiaPoolReview, type LiquidityQuote, type PoolView, type TradeQuote } from './walletAretiaPoolFlow';
import { fetchAccount, loadWeb3, rpcCall, signAndSubmitTransaction, simulateWithBalance, waitForConfirmation } from './walletSend';

export interface AretiaPoolHost {
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

const STEPS: { id: AretiaPoolProgress; label: string }[] = [
  { id: 'checking', label: 'Checking everything once more' },
  { id: 'signing', label: 'Waiting for you to approve the transaction in your wallet' },
  { id: 'confirming', label: 'Sending it to Solana' },
  { id: 'verifying', label: 'Reading the result back from the network' },
  { id: 'done', label: 'Done' },
];

export interface AretiaPoolCard {
  /** True when the page has the card (the site was built with the flag on). */
  present: boolean;
  onShow(): void;
  onWalletChange(): void;
  offer(mint: string): void;
  setActive(active: boolean): void;
}

const noop: AretiaPoolCard = { present: false, onShow(): void {}, onWalletChange(): void {}, offer(): void {}, setActive(): void {} };

/** A seam for a local test harness against the devnet program. The wallet page passes nothing, so the card there can only use the mainnet program, which does not exist. */
export interface AretiaPoolOptions {
  program?: string;
  deps?: Omit<AretiaPoolFlowDeps, 'program'>;
}

export function initAretiaPool(host: AretiaPoolHost, opts: AretiaPoolOptions = {}): AretiaPoolCard {
  const root = document.querySelector<HTMLElement>('[data-aretia-pool-root]');
  if (!root) return noop;
  const program = opts.program ?? aretiaPoolProgramFor('mainnet');

  let stage: Stage = 'form';
  let form: AretiaPoolForm = { ...DEFAULT_ARETIA_POOL_FORM };
  let issues: PoolIssue[] = [];
  let token: PoolToken | null = null;
  let review: AretiaPoolReview | null = null;
  let outcome: AretiaPoolOutcome | null = null;
  let managed: PoolView | null = null;
  let managedMint = '';
  let error: string | null = null;
  let note: string | null = null;
  let progress: AretiaPoolProgress = 'checking';
  let busy = false;
  let acknowledged = false;
  let tradeSide: 'buy' | 'sell' = 'buy';
  let tradeText = '';
  let liqText = '';
  let recipientText = '';
  let transferText = '';
  let idText = '';
  let flow: AretiaPoolFlow | null = null;

  async function flowFor(): Promise<AretiaPoolFlow> {
    if (flow) return flow;
    if (!program) throw new Error('There is no Aretia pool program on this network yet.');
    if (opts.deps) {
      flow = new AretiaPoolFlow({ ...opts.deps, program });
      return flow;
    }
    const web3 = await loadWeb3();
    flow = new AretiaPoolFlow({
      web3,
      program,
      balanceOf: async (address) => (await fetchAccount(address))?.lamports ?? 0n,
      latestBlockhash: async () => (await rpcCall<{ value: { blockhash: string; lastValidBlockHeight: number } }>('getLatestBlockhash', [{ commitment: 'confirmed' }])).value,
      fetchAccount,
      simulate: simulateWithBalance,
      signAndSubmit: (tx, extra) => signAndSubmitTransaction(tx, extra),
      confirm: (signature) => waitForConfirmation(signature),
    });
    return flow;
  }

  const errorBox = (text: string): HTMLElement => {
    const e = h('p', 'wapp__banner wapp__banner--warn', text);
    e.setAttribute('role', 'alert');
    return e;
  };
  const row = (dl: HTMLElement, k: string, v: string): void => {
    const d = h('div', 'wapp__row');
    d.append(h('dt', '', k), h('dd', '', v));
    dl.append(d);
  };
  const issueFor = (field: PoolIssue['field']): string | undefined => issues.find((i) => i.field === field)?.message;

  function field(label: string, name: 'mint' | 'tokenAmount' | 'price', extra: { mono?: boolean; placeholder?: string; hint?: string; inputmode?: string } = {}): HTMLElement {
    const wrap = h('div', 'wapp-ln__field');
    const id = `ap-${name}`;
    const l = h('label', 'wapp__eyebrow', label);
    l.htmlFor = id;
    const input = h('input', `wapp__input${extra.mono ? ' wapp__input--mono' : ''}`);
    input.id = id;
    input.value = form[name];
    input.autocomplete = 'off';
    input.spellcheck = false;
    if (extra.placeholder) input.placeholder = extra.placeholder;
    if (extra.inputmode) input.inputMode = extra.inputmode;
    const msg = issueFor(name);
    if (msg) input.setAttribute('aria-invalid', 'true');
    input.addEventListener('input', () => {
      form = { ...form, [name]: input.value };
    });
    wrap.append(l, input);
    if (extra.hint) wrap.append(h('p', 'wapp__fine', extra.hint));
    if (msg) wrap.append(h('p', 'wapp__err', msg));
    return wrap;
  }

  // ---------------------------------------------------------------- drawing

  function drawForm(card: HTMLElement): void {
    const address = host.getAddress();
    card.append(h('span', 'wapp__eyebrow', 'Aretia Pool'), h('h2', 'wapp__h2', 'Open an Aretia pool'));
    card.append(
      h('p', 'wapp__banner wapp__banner--warn', 'Unaudited. Aretia’s own pool program has not been independently checked and is live on a test network only. Aggregators such as Jupiter do not route to it yet.'),
      h('p', 'wapp__fine', `Your tokens go into a pool at a starting price you choose, and buyers pay SOL. Aretia keeps 20% of each trading fee and you keep the rest. Opening a pool costs a flat ${sol(ARETIA_POOL_FEE_LAMPORTS)} Aretia fee, shown before you sign.`),
    );
    if (!address) card.append(h('p', 'wapp__banner wapp__banner--warn', 'Connect a Solana wallet to open a pool.'));
    const f = h('form', 'wapp__form wapp-ln__form');
    f.noValidate = true;
    f.append(field('Token address', 'mint', { mono: true, placeholder: 'Token address', hint: 'A fixed-supply token you hold, such as one made on this page.' }));
    f.append(field('Tokens to put in the pool', 'tokenAmount', { inputmode: 'decimal', hint: 'In whole tokens. Only your tokens go in; nothing is bought.' }));
    f.append(field('Starting price (SOL per token)', 'price', { inputmode: 'decimal', placeholder: '0.000001', hint: 'Nobody can sell below this. It is not checked against any market.' }));

    const feeWrap = h('div', 'wapp-ln__field');
    const feeLabel = h('label', 'wapp__eyebrow', 'Trading fee');
    feeLabel.htmlFor = 'ap-fee';
    const select = h('select', 'wapp__input');
    select.id = 'ap-fee';
    for (const bps of POOL_TRADING_FEES_BPS) {
      const o = h('option', '', `${bps / 100}%`);
      o.value = String(bps);
      o.selected = String(bps) === form.tradingFeeBps;
      select.append(o);
    }
    select.addEventListener('change', () => {
      form = { ...form, tradingFeeBps: select.value };
    });
    feeWrap.append(feeLabel, select, h('p', 'wapp__fine', 'Taken from the SOL side of each trade. 20% goes to Aretia and 80% to you.'));
    f.append(feeWrap);

    const lpWrap = h('div', 'wapp-ln__field');
    const lpLabel = h('label', 'wapp__eyebrow', 'Launch protection');
    lpLabel.htmlFor = 'ap-launch';
    const lpSelect = h('select', 'wapp__input');
    lpSelect.id = 'ap-launch';
    for (const key of Object.keys(LAUNCH_PROTECTION) as LaunchProtection[]) {
      const o = h('option', '', LAUNCH_PROTECTION[key].label);
      o.value = key;
      o.selected = key === form.launchProtection;
      lpSelect.append(o);
    }
    lpSelect.addEventListener('change', () => {
      form = { ...form, launchProtection: lpSelect.value as LaunchProtection };
    });
    lpWrap.append(lpLabel, lpSelect, h('p', 'wapp__fine', 'A higher fee right after the pool opens makes sniping bots pay for being first. It falls in a straight line to the trading fee, is shared 20% Aretia and 80% you, and cannot be changed afterwards.'));
    f.append(lpWrap);

    const rWrap = h('div', 'wapp-ln__field');
    const rLabel = h('label', 'wapp__eyebrow', 'Price range');
    rLabel.htmlFor = 'ap-range';
    const rSelect = h('select', 'wapp__input');
    rSelect.id = 'ap-range';
    for (const key of Object.keys(PRICE_RANGES) as PriceRange[]) {
      const o = h('option', '', PRICE_RANGES[key].label);
      o.value = key;
      o.selected = key === form.priceRange;
      rSelect.append(o);
    }
    rSelect.addEventListener('change', () => {
      form = { ...form, priceRange: rSelect.value as PriceRange };
    });
    rWrap.append(rLabel, rSelect, h('p', 'wapp__fine', 'A ceiling concentrates the same tokens into a band, so the pool is deeper near the starting price and buyers move it less. Once buyers have taken every token the price stops rising and the pool holds the SOL they paid. Fixed once the pool is open.'));
    f.append(rWrap);

    const lockWrap = h('label', 'wapp__check');
    const lockBox = h('input');
    lockBox.type = 'checkbox';
    lockBox.checked = form.lockLiquidity;
    lockBox.addEventListener('change', () => {
      form = { ...form, lockLiquidity: lockBox.checked };
    });
    lockWrap.append(lockBox, h('span', '', 'Lock the liquidity for good (recommended). Nobody can take the tokens back out; you can still claim fees.'));
    f.append(lockWrap);

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
    drawManage(card);
  }

  function drawManage(card: HTMLElement): void {
    const box = h('div', 'wapp-ln__field');
    box.append(h('span', 'wapp__eyebrow', 'Your pool'));
    const input = h('input', 'wapp__input wapp__input--mono');
    input.placeholder = 'Token address of a pool you own';
    input.value = managedMint;
    input.autocomplete = 'off';
    input.spellcheck = false;
    input.setAttribute('aria-label', 'Token address of a pool you own');
    input.addEventListener('input', () => {
      managedMint = input.value.trim();
    });
    const load = h('button', 'wapp__btn wapp__btn--ghost', 'Look up');
    load.type = 'button';
    load.disabled = busy || !host.getAddress();
    load.addEventListener('click', () => void lookup());
    const idIn = h('input', 'wapp__input wapp__input--mono');
    idIn.placeholder = 'Position id (only if a position was sent to you)';
    idIn.value = idText;
    idIn.autocomplete = 'off';
    idIn.spellcheck = false;
    idIn.setAttribute('aria-label', 'Position id');
    idIn.addEventListener('input', () => (idText = idIn.value.trim()));
    box.append(input, idIn, load);
    if (note) box.append(h('p', 'wapp__fine', note));
    if (managed) {
      const { pool, position } = managed;
      const dl = h('dl', 'wapp__rows');
      row(dl, 'Price now', `${priceText(poolMathOf(pool), managed.decimals)} SOL per token`);
      row(dl, 'Trading fee', `${pool.feeBps / 100}%`);
      row(dl, 'SOL in the pool', sol(pool.y));
      if (position) {
        row(dl, 'Your liquidity', `${grouped(position.shares.toString())} (${position.locked === position.shares ? 'locked' : `${grouped(position.locked.toString())} locked`})`);
        row(dl, 'Fees you can claim', sol(managed.claimable));
        if (position.id !== position.owner) row(dl, 'Position id', short(position.id));
        row(dl, 'Fees are paid to', position.recipient === position.owner ? 'You' : short(position.recipient));
      } else row(dl, 'Your position', 'None in this pool');
      box.append(dl);
      drawTrade(box, managed);
      if (position) {
        const claim = h('button', 'wapp__btn wapp__btn--primary', 'Claim fees');
        claim.type = 'button';
        claim.disabled = busy || managed.claimable === 0n;
        claim.addEventListener('click', () => void act('claim'));
        box.append(claim);
        const to = h('input', 'wapp__input wapp__input--mono');
        to.placeholder = 'Send my fees to this wallet (optional)';
        to.value = recipientText;
        to.autocomplete = 'off';
        to.spellcheck = false;
        to.setAttribute('aria-label', 'Wallet to send fees to');
        to.addEventListener('input', () => (recipientText = to.value.trim()));
        const setTo = h('button', 'wapp__btn wapp__btn--ghost', 'Change where fees go');
        setTo.type = 'button';
        setTo.disabled = busy;
        setTo.addEventListener('click', () => void act('recipient'));
        box.append(to, setTo);
        const give = h('input', 'wapp__input wapp__input--mono');
        give.placeholder = 'Give this whole position to another wallet';
        give.value = transferText;
        give.autocomplete = 'off';
        give.spellcheck = false;
        give.setAttribute('aria-label', 'Wallet to give the position to');
        give.addEventListener('input', () => (transferText = give.value.trim()));
        const giveB = h('button', 'wapp__btn wapp__btn--ghost', 'Give the position away');
        giveB.type = 'button';
        giveB.disabled = busy;
        giveB.addEventListener('click', () => void act('transfer'));
        box.append(give, giveB, h('p', 'wapp__fine', 'The new owner gets everything, locked liquidity included, and the fees waiting on it. Claim yours first. Fees then go to them, not to you. This cannot be undone.'));
        if (position.locked < position.shares) {
          const lock = h('button', 'wapp__btn wapp__btn--ghost', 'Lock the rest for good');
          lock.type = 'button';
          lock.disabled = busy;
          lock.addEventListener('click', () => void act('lock'));
          box.append(lock);
        }
      }
    }
    card.append(box);
  }

  /** Buy or sell against the pool, and add or remove liquidity. Every amount is quoted from the pool as just read, with a floor or a cap. */
  function drawTrade(box: HTMLElement, view: PoolView): void {
    const { pool, position, decimals } = view;
    const small = (label: string, text: string, onInput: (v: string) => void): HTMLInputElement => {
      const i = h('input', 'wapp__input');
      i.value = text;
      i.placeholder = label;
      i.inputMode = 'decimal';
      i.autocomplete = 'off';
      i.setAttribute('aria-label', label);
      i.addEventListener('input', () => onInput(i.value.trim().replace(/,/g, '')));
      return i;
    };
    const f = flow;
    const connected = !!host.getAddress();
    box.append(h('span', 'wapp__eyebrow', 'Trade'));
    const sides = h('div', 'wapp__row-actions');
    for (const sd of ['buy', 'sell'] as const) {
      const b = h('button', `wapp__btn ${tradeSide === sd ? 'wapp__btn--primary' : 'wapp__btn--ghost'}`, sd === 'buy' ? 'Buy with SOL' : 'Sell for SOL');
      b.type = 'button';
      b.addEventListener('click', () => {
        tradeSide = sd;
        tradeText = '';
        draw();
      });
      sides.append(b);
    }
    box.append(sides, small(tradeSide === 'buy' ? 'SOL to spend' : 'Tokens to sell', tradeText, (v) => (tradeText = v)));
    const raw = toSmallestUnit(tradeText, tradeSide === 'buy' ? 9 : decimals);
    const q = f && raw && BigInt(raw) > 0n ? f.quote(pool, tradeSide === 'buy', BigInt(raw), ARETIA_SLIPPAGE_BPS_DEFAULT) : null;
    const go = h('button', 'wapp__btn wapp__btn--primary', q ? (tradeSide === 'buy' ? `Buy about ${amountText(q.expectedOut, decimals)} tokens` : `Sell for about ${sol(q.expectedOut)}`) : 'Enter an amount first');
    go.type = 'button';
    go.disabled = busy || !connected || !q;
    if (q) box.append(h('p', 'wapp__fine', `At least ${tradeSide === 'buy' ? `${amountText(q.minOut, decimals)} tokens` : sol(q.minOut)} or the whole transaction fails (1% slippage limit). Fee ${sol(q.fee)}, 20% of it to Aretia.`));
    go.addEventListener('click', () => void act('trade', q));
    box.querySelectorAll('input').forEach((i) => i.addEventListener('change', () => draw()));
    box.append(go);

    box.append(h('span', 'wapp__eyebrow', 'Liquidity'));
    box.append(small('Liquidity, in SOL of depth', liqText, (v) => (liqText = v)));
    const dlRaw = toSmallestUnit(liqText, 9);
    const dl = dlRaw ? BigInt(dlRaw) : 0n;
    const add = f && dl > 0n ? f.quoteAdd(pool, dl, ARETIA_SLIPPAGE_BPS_DEFAULT) : null;
    const rem = f && dl > 0n && position && dl <= position.shares - position.locked ? f.quoteRemove(pool, dl, ARETIA_SLIPPAGE_BPS_DEFAULT) : null;
    if (add) box.append(h('p', 'wapp__fine', `Adding this takes about ${amountText(add.tokens, decimals)} tokens and ${sol(add.sol)}.`));
    if (rem) box.append(h('p', 'wapp__fine', `Removing this returns about ${amountText(rem.tokens, decimals)} tokens and ${sol(rem.sol)}. Locked liquidity cannot be removed.`));
    const row2 = h('div', 'wapp__row-actions');
    const addB = h('button', 'wapp__btn wapp__btn--ghost', 'Add liquidity');
    addB.type = 'button';
    addB.disabled = busy || !connected || !add;
    addB.addEventListener('click', () => void act('add', add));
    const remB = h('button', 'wapp__btn wapp__btn--ghost', 'Remove liquidity');
    remB.type = 'button';
    remB.disabled = busy || !connected || !rem;
    remB.addEventListener('click', () => void act('remove', rem));
    row2.append(addB, remB);
    box.append(row2);
  }

  function drawReview(card: HTMLElement): void {
    if (!review || !token) return;
    const { config, params, cost, balance, blockers, built } = review;
    card.append(h('span', 'wapp__eyebrow', 'Review'), h('h2', 'wapp__h2', 'Open an Aretia pool'));
    card.append(h('p', 'wapp__banner wapp__banner--warn', 'This spends real SOL on the network the page is connected to. Read it all before you approve. Nothing is sent until you press the button at the bottom.'));
    const dl = h('dl', 'wapp__rows');
    row(dl, 'Token', short(config.mint));
    row(dl, 'Tokens going in', amountText(config.tokenAmountRaw, config.decimals));
    row(dl, 'Starting price', `${config.price} SOL per token`);
    row(dl, 'Trading fee', `${config.tradingFeeBps / 100}% (Aretia keeps 20% of it)`);
    row(dl, 'Liquidity', params.lock ? 'Locked for good' : 'Not locked: you can remove it');
    row(dl, 'Price range', params.vx0 > 0n ? 'Has a ceiling' : 'No ceiling');
    row(dl, 'Launch protection', params.sniperBps > 0 ? `${params.sniperBps / 100}% falling over ${params.decaySecs / 60} minutes` : 'None');
    row(dl, 'Pool address', short(built.pool));
    card.append(dl);
    card.append(h('span', 'wapp__eyebrow', 'What it costs, in SOL'));
    const costs = h('dl', 'wapp__rows');
    row(costs, 'Aretia fee', sol(cost.aretiaFee));
    row(costs, 'Network fee and deposits', sol(cost.network));
    row(costs, 'Total, about', sol(cost.total));
    row(costs, 'Your balance', sol(balance));
    card.append(costs);
    card.append(h('span', 'wapp__eyebrow', 'What this means'));
    const list = h('ul', 'wapp__list');
    for (const d of aretiaPoolDisclosures(params)) {
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
    const go = h('button', 'wapp__btn wapp__btn--primary', 'Open pool');
    go.type = 'button';
    go.disabled = !acknowledged || blockers.length > 0 || busy;
    box.addEventListener('change', () => {
      acknowledged = box.checked;
      go.disabled = !acknowledged || blockers.length > 0 || busy;
    });
    ack.append(box, h('span', '', 'I understand this pool program is unaudited, this opens a real pool, costs about the amount above, and cannot be undone.'));
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
    card.append(ok ? h('p', 'wapp__banner', 'Read back from the network: the pool exists and holds exactly what you approved.') : errorBox(`The network does not show exactly what you approved: ${outcome.differences.join(' ')}`));
    const dl = h('dl', 'wapp__rows');
    row(dl, 'Pool address', outcome.pool);
    row(dl, 'Transaction', outcome.signature);
    card.append(dl);
    const again = h('button', 'wapp__btn wapp__btn--primary', 'Open another');
    again.type = 'button';
    again.addEventListener('click', () => {
      stage = 'form';
      form = { ...DEFAULT_ARETIA_POOL_FORM };
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
    if (!program) {
      // Nothing else is drawn: no form, no button, nothing that could send.
      card.append(h('span', 'wapp__eyebrow', 'Aretia Pool'), h('h2', 'wapp__h2', 'Not available on this network yet'));
      card.append(h('p', 'wapp__banner wapp__banner--warn', 'Aretia’s own pool program is unaudited and is not deployed to Solana mainnet. Use the Meteora liquidity pool above.'));
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

  async function startReview(): Promise<void> {
    const creator = host.getAddress() ?? '';
    error = null;
    busy = true;
    draw();
    try {
      const f = await flowFor();
      token = form.mint.trim() === '' ? null : await f.loadToken(creator, form.mint.trim()).catch(() => null);
      const v = validateAretiaPool(form, creator, token);
      issues = v.ok ? [] : v.issues;
      if (!v.ok || !token) {
        busy = false;
        draw();
        root?.querySelector<HTMLElement>('[aria-invalid="true"]')?.focus();
        return;
      }
      review = await f.prepare(v.config, v.params, token);
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
      const f = await flowFor();
      outcome = await f.create(r, (p) => {
        progress = p;
        draw();
      });
      stage = 'done';
      managedMint = r.params.mint;
      host.refreshWallet();
    } catch (e) {
      error = e instanceof LaunchError ? e.message : friendlyError(e);
      stage = 'review';
    } finally {
      busy = false;
      draw();
    }
  }

  async function lookup(): Promise<void> {
    const owner = host.getAddress();
    note = null;
    managed = null;
    busy = true;
    draw();
    try {
      const f = await flowFor();
      managed = await f.loadPool(managedMint, owner, idText || null);
      if (!managed) note = 'No Aretia pool was found for that token.';
    } catch (e) {
      note = friendlyError(e);
    } finally {
      busy = false;
      draw();
    }
  }

  async function act(kind: 'claim' | 'lock' | 'trade' | 'add' | 'remove' | 'recipient' | 'transfer', quote: TradeQuote | LiquidityQuote | null = null): Promise<void> {
    const owner = host.getAddress();
    const view = managed;
    if (!owner || !view) return;
    if ((kind === 'claim' || kind === 'lock' || kind === 'remove' || kind === 'recipient' || kind === 'transfer') && !view.position) return;
    busy = true;
    note = null;
    draw();
    try {
      const f = await flowFor();
      const id = view.position?.id ?? owner;
      const none = () => undefined;
      if (kind === 'claim') await f.claim(owner, managedMint, view.position!.recipient, none, id);
      else if (kind === 'recipient') {
        if (!isSolanaAddress(recipientText)) throw new Error('That is not a valid wallet address.');
        await f.setRecipient(owner, managedMint, recipientText, none, id);
      } else if (kind === 'transfer') {
        if (!isSolanaAddress(transferText) || transferText === owner) throw new Error('Enter the address of the wallet to give the position to.');
        await f.transferPosition(owner, managedMint, transferText, none, id);
      }
      else if (kind === 'lock') await f.lock(owner, managedMint, view.position!.shares - view.position!.locked, none, id);
      else if (kind === 'trade' && quote && 'isBuy' in quote) await f.trade(owner, managedMint, quote);
      else if (kind === 'add' && quote && 'dl' in quote) await f.addLiquidity(owner, managedMint, quote, none, id);
      else if (kind === 'remove' && quote && 'dl' in quote) await f.removeLiquidity(owner, managedMint, quote, none, id);
      else throw new Error('Nothing to send.');
      note = { transfer: 'The position now belongs to the other wallet.', recipient: 'Fees will now be paid to the wallet you named.', claim: 'Fees claimed.', lock: 'Locked for good.', trade: 'Trade sent.', add: 'Liquidity added.', remove: 'Liquidity removed.' }[kind];
      managed = await f.loadPool(managedMint, owner, idText || view.position?.id || null);
      host.refreshWallet();
    } catch (e) {
      note = e instanceof LaunchError ? e.message : friendlyError(e);
    } finally {
      busy = false;
      draw();
    }
  }

  draw();
  return {
    present: true,
    onShow: draw,
    onWalletChange: draw,
    offer(mint: string): void {
      form = { ...form, mint };
      stage = 'form';
      draw();
    },
    setActive(active: boolean): void {
      root.closest<HTMLElement>('.lh-nested')?.toggleAttribute('hidden', !active);
    },
  };
}
