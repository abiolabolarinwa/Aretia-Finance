/**
 * The "Move USDC" tab: move native USDC between EVM chains through Circle's CCTP. Quotes need no wallet; signing uses
 * the user's own wallet through the same checks as a swap. Everything the user is told comes from `crosschain/view.ts`.
 */
import { CHAINS, SwingsError, type ChainId } from '../swings/core/types.js';
import { EvmSession, publicRead, readBalance } from '../swings/chains/evmSession.js';
import { EvmBridgeWallet, type EvmEventSource } from '../swings/wallet/evmBridgeWallet.js';
import { WalletSessionManager } from '../swings/wallet/sessionManager.js';
import { CCTP_USDC, cctpProviders } from '../swings/settlement/cctp.js';
import { SettlementQuoteEngine, type SettlementSearch } from '../swings/settlement/engine.js';
import type { SettlementQuote } from '../swings/settlement/types.js';
import { isCanaryAllowed } from '../swings/runtime.js';
import { assessSettlement } from '../swings/settlement/safety.js';
import { EVM_NATIVE_ADDRESS } from '../swings/core/types.js';
import { CrossChainOrchestrator } from '../swings/orchestrator/orchestrator.js';
import { StorageExecutionStore } from '../swings/orchestrator/store.js';
import { mirroredExecutionStore, RecordMirror, restoreFromCode } from '../swings/orchestrator/remote.js';
import { runtime } from '../swings/runtime.js';
import { WalletExecutionGateway } from '../swings/orchestrator/walletGateway.js';
import type { ExecutionRecord } from '../swings/orchestrator/states.js';
import { formatUnits, parseUnits, viewQuote, viewStatus } from '../swings/crosschain/view.js';

const CHAIN_CHOICES: ChainId[] = ['ethereum', 'base', 'arbitrum', 'optimism', 'polygon', 'avalanche'];
const EXPLORER: Partial<Record<ChainId, string>> = { ethereum: 'https://etherscan.io/tx/', base: 'https://basescan.org/tx/', arbitrum: 'https://arbiscan.io/tx/', optimism: 'https://optimistic.etherscan.io/tx/', polygon: 'https://polygonscan.com/tx/', avalanche: 'https://snowtrace.io/tx/' };

function el<K extends keyof HTMLElementTagNameMap>(tag: K, props: { class?: string; text?: string; attrs?: Record<string, string> } = {}, children: (Node | null | false)[] = []): HTMLElementTagNameMap[K] {
  const n = document.createElement(tag);
  if (props.class) n.className = props.class;
  if (props.text !== undefined) n.textContent = props.text;
  for (const [k, v] of Object.entries(props.attrs ?? {})) n.setAttribute(k, v);
  for (const c of children) if (c) n.append(c);
  return n;
}
const banner = (kind: 'warn' | 'info' | 'ok', text: string): HTMLElement => el('p', { class: `wapp__banner wapp__banner--${kind}`, text });
const short = (a: string): string => (a.length > 12 ? `${a.slice(0, 6)}…${a.slice(-4)}` : a);

/** Largest single move while Swings is being proven with real money. Raised only by a reviewed change here. */
export const MOVE_CAP_RAW = 250_000_000n;

export function initCrossChain(root: HTMLElement, evm: EvmSession, isEnabled: (chain: ChainId) => boolean): { draw(): void } {
  const reader = (chain: ChainId) => publicRead(chain);
  const wallets = new WalletSessionManager(null);
  const gateway = new WalletExecutionGateway(wallets, reader, async (r) => window.confirm(`Your wallet is on ${r.from ? CHAINS[r.from].name : 'another network'}. Switch it to ${CHAINS[r.to].name}? Nothing is sent by switching.`));
  const local = new StorageExecutionStore(window.localStorage);
  const mirror = new RecordMirror();
  const COPY_KEY = 'aretia-swings-recovery-copy';
  const copyOn = (): boolean => {
    try {
      return window.localStorage.getItem(COPY_KEY) === 'on' && runtime.recordsConfigured === true;
    } catch {
      return false;
    }
  };
  let copyBehind = false;
  const store = mirroredExecutionStore(local, mirror, copyOn, (r) => {
    copyBehind = r !== 'saved';
  });
  const providers = cctpProviders({ read: reader });
  const engine = new SettlementQuoteEngine(providers);
  const orchestrator = new CrossChainOrchestrator({ store, providers, gateway });

  const s = {
    from: 'ethereum' as ChainId,
    to: 'base' as ChainId,
    amount: '',
    busy: false,
    error: null as string | null,
    balance: null as bigint | null,
    search: null as SettlementSearch | null,
    chosen: null as SettlementQuote | null,
    record: null as ExecutionRecord | null,
    claimable: false,
    walletChoices: null as { uuid: string; name: string }[] | null,
    restoreText: '',
    notice: null as string | null,
  };
  let timer: number | null = null;

  async function adoptWallet(): Promise<void> {
    if (!evm.adapter || !evm.account) return;
    const provider = evm.wallets.find((w) => w.info.name === evm.walletName)?.provider;
    const bridge = new EvmBridgeWallet('evm-page', evm.walletName ?? 'EVM wallet', evm.adapter, { read: reader, events: provider as EvmEventSource | undefined });
    await bridge.restore();
    wallets.add(bridge);
    wallets.setActive('evm-page');
  }

  async function loadBalance(): Promise<void> {
    s.balance = null;
    if (!evm.account) return;
    try {
      s.balance = await readBalance(reader(s.from), evm.account, CCTP_USDC[s.from]!);
    } catch {
      s.balance = null;
    }
  }

  async function getQuotes(): Promise<void> {
    s.error = null;
    s.search = null;
    s.chosen = null;
    const raw = parseUnits(s.amount, 6);
    if (!evm.account) return void (s.error = 'Connect a wallet first.');
    if (raw === null || raw <= 0n) return void (s.error = 'Enter an amount of USDC, for example 25.');
    if (s.from === s.to) return void (s.error = 'Choose two different networks.');
    if (s.balance !== null && raw > s.balance) return void (s.error = `You have ${formatUnits(s.balance, 6)} USDC on ${CHAINS[s.from].name}, which is less than ${formatUnits(raw, 6)}.`);
    s.busy = true;
    draw();
    try {
      s.search = await engine.quote({ sourceChain: s.from, sourceAsset: { chain: s.from, address: CCTP_USDC[s.from]! }, sourceAmount: raw, destinationChain: s.to, destinationAsset: { chain: s.to, address: CCTP_USDC[s.to]! }, sender: evm.account, recipient: evm.account }, 'balanced');
      s.chosen = s.search.quotes[0] ?? null;
    } catch (e) {
      s.error = e instanceof SwingsError ? e.message : 'Quotes could not be fetched.';
    } finally {
      s.busy = false;
    }
  }

  async function run(work: () => Promise<ExecutionRecord | void>): Promise<void> {
    s.error = null;
    s.busy = true;
    draw();
    try {
      const r = await work();
      if (r) s.record = r;
    } catch (e) {
      s.error = e instanceof SwingsError ? e.message : 'Something went wrong. Nothing was assumed: check your wallet and try again.';
    } finally {
      s.busy = false;
      if (s.record) await poll();
      draw();
    }
  }

  async function poll(): Promise<void> {
    if (!s.record) return;
    try {
      const fresh = await orchestrator.get(s.record.id);
      if (fresh) s.record = fresh;
      if (s.record.state === 'SETTLEMENT_PENDING') {
        const a = await orchestrator.advance(s.record.id);
        s.record = a.record;
        s.claimable = a.claimable;
      } else s.claimable = false;
    } catch {
      // A busy or unreachable check changes nothing; the next poll tries again.
    }
    if (timer !== null) window.clearTimeout(timer);
    timer = s.record && !['COMPLETED', 'FAILED', 'EXPIRED', 'REFUNDED'].includes(s.record.state) && !s.record.needsAttention ? window.setTimeout(() => void poll().then(draw), 15_000) : null;
  }

  function picker(label: string, value: ChainId, on: (c: ChainId) => void): HTMLElement {
    const sel = el('select', { class: 'wapp__input', attrs: { 'aria-label': label } });
    for (const c of CHAIN_CHOICES) sel.append(el('option', { text: CHAINS[c].name, attrs: { value: c, ...(c === value ? { selected: '' } : {}) } }));
    sel.addEventListener('change', () => on(sel.value as ChainId));
    return el('label', { class: 'wapp__field' }, [el('span', { class: 'wapp__eyebrow', text: label }), sel]);
  }

  function connectBox(): HTMLElement {
    const box = el('div', { class: 'wapp__stack' });
    box.append(banner('info', 'Connect an EVM wallet to move USDC. Aretia never holds your keys; your wallet signs.'));
    if (s.walletChoices === null) {
      const b = el('button', { class: 'wapp__btn wapp__btn--primary', text: 'Find wallets', attrs: { type: 'button' } });
      b.addEventListener('click', () => void evm.discover().then((ws) => { s.walletChoices = ws.map((w) => ({ uuid: w.info.uuid, name: w.info.name })); draw(); }));
      box.append(b);
    } else if (s.walletChoices.length === 0) box.append(banner('warn', 'No EVM wallet was found in this browser.'));
    else {
      for (const w of s.walletChoices) {
        const b = el('button', { class: 'wapp__btn wapp__btn--ghost', text: `Connect ${w.name}`, attrs: { type: 'button' } });
        b.addEventListener('click', () => void evm.connect(w.uuid).then(adoptWallet).then(loadBalance).then(draw).catch((e: unknown) => { s.error = e instanceof SwingsError ? e.message : 'The wallet could not be connected.'; draw(); }));
        box.append(b);
      }
    }
    return box;
  }

  function quoteCard(q: SettlementQuote): HTMLElement {
    const v = viewQuote(q, Date.now());
    const card = el('div', { class: 'wapp__card' });
    const pick = el('input', { attrs: { type: 'radio', name: 'cc-quote', ...(s.chosen === q ? { checked: '' } : {}) } });
    pick.addEventListener('change', () => { s.chosen = q; draw(); });
    card.append(el('label', { class: 'wapp__row-actions' }, [pick, el('strong', { text: v.mechanism })]));
    card.append(el('p', { text: `You send ${v.youSend}. You receive ${v.youReceive}, in ${v.time}.` }));
    const fees = el('ul', { class: 'wapp__list' });
    for (const f of v.fees) fees.append(el('li', { text: `${f.label}: ${f.value}` }));
    card.append(fees);
    if (s.chosen === q) {
      const steps = el('ol', { class: 'wapp__list' });
      for (const st of v.steps) steps.append(el('li', { text: `${st.text}${st.needsSignature ? ' (you sign)' : ''}` }));
      card.append(el('span', { class: 'wapp__eyebrow', text: 'What happens' }), steps, el('p', { class: 'wapp__fine', text: v.trust }));
      const risks = el('ul', { class: 'wapp__list' });
      for (const r of [...v.risks, ...v.requirements]) risks.append(el('li', { text: r }));
      card.append(risks);
    }
    return card;
  }

  function statusCard(r: ExecutionRecord): HTMLElement {
    const v = viewStatus(r, s.claimable);
    const card = el('div', { class: 'wapp__card' });
    card.append(banner(v.tone === 'ok' ? 'ok' : v.tone === 'progress' ? 'info' : 'warn', `${v.title}. ${v.detail}`));
    const hashes = Object.values(r.steps).filter((x) => x.hash);
    if (hashes.length > 0) {
      const ul = el('ul', { class: 'wapp__list' });
      for (const h of hashes) {
        const url = EXPLORER[h.chain];
        ul.append(el('li', {}, [el('span', { text: `${h.stepId} on ${CHAINS[h.chain].name}: ${h.status} · ` }), url ? el('a', { text: short(h.hash!), attrs: { href: url + h.hash, target: '_blank', rel: 'noopener noreferrer' } }) : el('span', { text: h.hash! })]));
      }
      card.append(ul);
    }
    card.append(el('p', { class: 'wapp__fine' }, [el('span', { text: 'Recovery code: ' }), el('code', { text: r.id }), el('span', { text: copyOn() ? (copyBehind ? ' (the server copy is behind; this browser has the latest)' : ' (a copy is kept on Aretia\'s server)') : ' (kept only in this browser)' })]));
    const actions = el('div', { class: 'wapp__row-actions' });
    if (v.next === 'sign') {
      const b = el('button', { class: 'wapp__btn wapp__btn--primary', text: s.busy ? 'Working…' : 'Continue', attrs: { type: 'button' } });
      b.disabled = s.busy;
      b.addEventListener('click', () => void run(() => orchestrator.start(r.id)));
      actions.append(b);
    }
    if (v.next === 'claim') {
      const b = el('button', { class: 'wapp__btn wapp__btn--primary', text: s.busy ? 'Working…' : `Claim on ${CHAINS[r.quote.intent.destinationChain].name}`, attrs: { type: 'button' } });
      b.disabled = s.busy;
      b.addEventListener('click', () => void run(() => orchestrator.claim(r.id)));
      actions.append(b);
    }
    if (v.next === 'check-wallet') {
      for (const step of Object.values(r.steps).filter((x) => x.status === 'sending' || (x.status === 'submitted' && r.needsAttention))) {
        const no = el('button', { class: 'wapp__btn wapp__btn--ghost', text: `The ${step.stepId} was not sent`, attrs: { type: 'button' } });
        no.addEventListener('click', () => void run(() => orchestrator.resolveAttention(r.id, { stepId: step.stepId, sent: false })));
        const yes = el('button', { class: 'wapp__btn wapp__btn--ghost', text: `The ${step.stepId} was sent…`, attrs: { type: 'button' } });
        yes.addEventListener('click', () => {
          const hash = window.prompt('Paste the transaction hash from your wallet');
          if (hash) void run(() => orchestrator.resolveAttention(r.id, { stepId: step.stepId, sent: true, hash: hash.trim() }));
        });
        actions.append(no, yes);
      }
    }
    if (['COMPLETED', 'FAILED', 'EXPIRED', 'REFUNDED'].includes(r.state)) {
      const b = el('button', { class: 'wapp__btn wapp__btn--ghost', text: 'Start another', attrs: { type: 'button' } });
      b.addEventListener('click', () => { s.record = null; s.search = null; s.chosen = null; draw(); });
      actions.append(b);
    }
    card.append(actions);
    return card;
  }

  function recoveryCard(): HTMLElement {
    const c = el('div', { class: 'wapp__card' });
    c.append(el('span', { class: 'wapp__eyebrow', text: 'Recovery' }));
    if (runtime.recordsConfigured === true) {
      const box = el('input', { attrs: { type: 'checkbox', ...(copyOn() ? { checked: '' } : {}) } });
      box.addEventListener('change', () => {
        try {
          window.localStorage.setItem(COPY_KEY, box.checked ? 'on' : 'off');
        } catch {
          // a convenience only
        }
        draw();
      });
      c.append(el('label', { class: 'wapp__row-actions' }, [box, el('span', { text: 'Keep a recovery copy of my moves on Aretia\'s server' })]), el('p', { class: 'wapp__fine', text: 'The copy holds the move\'s states, amounts, transaction hashes and the two wallet addresses. It has no keys. Only the recovery code opens it, so keep that code safe; anyone who has it can read the copy.' }));
    } else c.append(el('p', { class: 'wapp__fine', text: 'Your moves are kept in this browser only. If you clear its data, keep the transaction hashes from your wallet to follow a move.' }));
    const code = el('input', { class: 'wapp__input', attrs: { placeholder: 'Recovery code (starts with x_)', 'aria-label': 'Recovery code', autocomplete: 'off', value: s.restoreText } });
    code.addEventListener('input', () => { s.restoreText = code.value; });
    const go = el('button', { class: 'wapp__btn wapp__btn--ghost', text: 'Restore a move', attrs: { type: 'button' } });
    go.addEventListener('click', () =>
      void restoreFromCode(s.restoreText, mirror, local)
        .then(async (rec) => {
          s.record = rec;
          s.notice = null;
          await adoptWallet();
          await poll();
        })
        .catch((e: unknown) => {
          s.error = e instanceof SwingsError ? e.message : 'The move could not be restored.';
        })
        .finally(draw));
    c.append(code, go);
    return c;
  }

  function draw(): void {
    root.replaceChildren();
    const card = el('div', { class: 'wapp__card' });
    card.append(el('h2', { class: 'wapp__h2', text: 'Move USDC between networks' }), el('p', { class: 'wapp__fine', text: "Uses Circle's CCTP: your USDC is burned on one network and Circle mints the same amount on the other. No wrapped token, no third-party bridge. Native USDC only; BNB Chain and Solana are not offered here yet." }));
    if (!evm.account) {
      card.append(connectBox());
      if (s.error) card.append(banner('warn', s.error));
      return void root.append(card);
    }
    card.append(el('p', { class: 'wapp__fine', text: `${evm.walletName ?? 'EVM wallet'} · ${short(evm.account)}. The USDC arrives at this same account.` }));
    if (s.record) {
      root.append(card, statusCard(s.record));
      if (s.error) card.append(banner('warn', s.error));
      return;
    }
    card.append(picker('From', s.from, (c) => { s.from = c; s.search = null; s.chosen = null; void loadBalance().then(draw); draw(); }), picker('To', s.to, (c) => { s.to = c; s.search = null; s.chosen = null; draw(); }));
    const amount = el('input', { class: 'wapp__swap-amount', attrs: { inputmode: 'decimal', placeholder: '0.0', autocomplete: 'off', 'aria-label': 'USDC amount', value: s.amount } });
    amount.addEventListener('input', () => { s.amount = amount.value; });
    card.append(el('label', { class: 'wapp__field' }, [el('span', { class: 'wapp__eyebrow', text: s.balance === null ? 'Amount (USDC)' : `Amount (USDC), you have ${formatUnits(s.balance, 6)}` }), amount]));
    const get = el('button', { class: 'wapp__btn wapp__btn--primary', text: s.busy ? 'Checking…' : 'Get quotes', attrs: { type: 'button' } });
    get.disabled = s.busy;
    get.addEventListener('click', () => void getQuotes().then(draw));
    card.append(get);
    if (s.error) card.append(banner('warn', s.error));
    root.append(card, recoveryCard());
    if (s.search) {
      for (const q of s.search.quotes) root.append(quoteCard(q));
      for (const d of s.search.declined) root.append(banner('info', `${d.providerId}: ${d.reason}`));
      for (const f of s.search.failures) root.append(banner('warn', `${f.providerId}: ${f.message}`));
      if (s.chosen) {
        const go = el('button', { class: 'wapp__btn wapp__btn--primary', text: `Start: send ${formatUnits(s.chosen.sourceAmount, 6)} USDC`, attrs: { type: 'button' } });
        go.addEventListener('click', () =>
          void run(async () => {
            const q = s.chosen!;
            if (!(await isCanaryAllowed(q.intent.sender))) throw new SwingsError('not-enabled', 'Moving USDC is limited to a first group of wallets while it is being proven. This wallet is not in that group yet.');
            const [native, existing] = await Promise.all([readBalance(reader(q.intent.destinationChain), q.intent.recipient, EVM_NATIVE_ADDRESS).catch(() => null), store.list()]);
            const verdict = assessSettlement(q, { now: Date.now(), provider: providers.find((p) => p.id === q.providerId) ?? null, enabledChains: CHAIN_CHOICES.filter(isEnabled), sourceBalance: s.balance, destinationNativeBalance: native, existing, maxAmount: MOVE_CAP_RAW });
            if (verdict.verdict === 'block') throw new SwingsError('invalid', verdict.blockers.join(' '));
            for (const c of verdict.confirmations) if (!window.confirm(`${c}

Continue anyway?`)) return;
            await adoptWallet();
            const rec = await orchestrator.create(q);
            return orchestrator.start(rec.id);
          }));
        root.append(el('div', { class: 'wapp__card' }, [go]));
      }
    }
  }

  // Pick up an unfinished move after a reload.
  void orchestrator.active().then(async (list) => {
    const mine = list.find((r) => evm.account && r.quote.intent.sender.toLowerCase() === evm.account.toLowerCase());
    if (mine) {
      s.record = mine;
      await adoptWallet();
      await poll();
      draw();
    }
  });

  return {
    draw() {
      void loadBalance().then(draw);
      draw();
    },
  };
}
