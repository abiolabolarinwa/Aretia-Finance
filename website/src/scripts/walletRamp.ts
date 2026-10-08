/**
 * The "Buy & Sell" tab: turn a bank or card payment into USDC in the user's own wallet, or USDC into money. The
 * provider (MoonPay) takes the payment and checks identity on its own page; Aretia never sees a card or a document and
 * never holds funds. A purchase is finished only when the USDC shows up in the wallet.
 */
import { CHAINS, SwingsError, type ChainId } from '../swings/core/types.js';
import { publicRead, readBalance, type EvmSession } from '../swings/chains/evmSession.js';
import { MoonPayRampProvider, type RampApiCatalog } from '../swings/ramp/moonpay.js';
import { RampRouter, type RampSearch } from '../swings/ramp/router.js';
import { judgeWatch, type RampWatch } from '../swings/ramp/watch.js';
import type { RampIntent, RampQuote, RampSide } from '../swings/ramp/types.js';
import { formatUnits } from '../swings/crosschain/view.js';

const CHOICES: ChainId[] = ['solana', 'ethereum', 'base', 'arbitrum', 'optimism', 'polygon', 'avalanche'];
const WATCH_KEY = 'aretia-swings-ramp-watch';
const COUNTRY_KEY = 'aretia-swings-country';

interface SavedWatch extends RampWatch {
  chain: ChainId;
  wallet: string;
  token: string;
  providerName: string;
}

function el<K extends keyof HTMLElementTagNameMap>(tag: K, props: { class?: string; text?: string; attrs?: Record<string, string> } = {}, children: (Node | null | false)[] = []): HTMLElementTagNameMap[K] {
  const n = document.createElement(tag);
  if (props.class) n.className = props.class;
  if (props.text !== undefined) n.textContent = props.text;
  for (const [k, v] of Object.entries(props.attrs ?? {})) n.setAttribute(k, v);
  for (const c of children) if (c) n.append(c);
  return n;
}
const banner = (kind: 'warn' | 'info' | 'ok', text: string): HTMLElement => el('p', { class: `wapp__banner wapp__banner--${kind}`, text });
const store = {
  get<T>(k: string): T | null {
    try {
      const v = window.localStorage.getItem(k);
      return v ? (JSON.parse(v, (_k, x) => (x && typeof x === 'object' && typeof (x as { $b?: string }).$b === 'string' ? BigInt((x as { $b: string }).$b) : x)) as T) : null;
    } catch {
      return null;
    }
  },
  set(k: string, v: unknown): void {
    try {
      window.localStorage.setItem(k, JSON.stringify(v, (_k, x) => (typeof x === 'bigint' ? { $b: x.toString() } : x)));
    } catch {
      // a convenience only
    }
  },
  del(k: string): void {
    try {
      window.localStorage.removeItem(k);
    } catch {
      // a convenience only
    }
  },
};

export function initRamp(root: HTMLElement, evm: EvmSession, solanaAddress: () => string | null, isEnabled: (c: ChainId) => boolean): { draw(): void } {
  const api = async (body: Record<string, unknown>): Promise<unknown> => {
    const res = await fetch('/api/ramp', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    const data = (await res.json().catch(() => null)) as { error?: string } | null;
    if (!res.ok || !data) throw new Error(data?.error ?? `The service answered ${res.status}`);
    return data;
  };
  const moonpay = new MoonPayRampProvider({ api });
  const router = new RampRouter([moonpay]);
  const s = {
    side: 'buy' as RampSide,
    chain: 'base' as ChainId,
    fiat: 'usd',
    country: store.get<string>(COUNTRY_KEY) ?? '',
    amount: '100',
    avail: undefined as { catalog: RampApiCatalog; sides: string[] } | null | undefined,
    busy: false,
    error: null as string | null,
    search: null as RampSearch | null,
    chosen: null as RampQuote | null,
    link: null as string | null,
    watch: store.get<SavedWatch>(WATCH_KEY),
    watchMessage: null as string | null,
  };

  const walletFor = (c: ChainId): string | null => (c === 'solana' ? solanaAddress() : evm.account);
  const tokenFor = (c: ChainId): { address: string; symbol: string; decimals: number } | null => {
    const t = s.avail?.catalog.tokens.find((x) => x.chain === c && x.symbol === 'USDC');
    return t ? { address: t.contract, symbol: 'USDC', decimals: 6 } : null;
  };

  async function load(): Promise<void> {
    if (s.avail !== undefined) return;
    s.avail = await moonpay.availability();
    draw();
  }

  async function quote(): Promise<void> {
    s.error = null;
    s.search = null;
    s.chosen = null;
    s.link = null;
    const wallet = walletFor(s.chain);
    const token = tokenFor(s.chain);
    const amount = /^\d+$/.test(s.amount.trim()) ? Number(s.amount.trim()) : null;
    if (!wallet) return void (s.error = `Connect a ${s.chain === 'solana' ? 'Solana' : 'EVM'} wallet first.`);
    if (!token) return void (s.error = `${CHAINS[s.chain].name} is not available for ${s.side === 'buy' ? 'buying' : 'selling'} right now.`);
    if (amount === null || amount < 1) return void (s.error = 'Enter a whole amount of at least 1.');
    if (!s.country) return void (s.error = 'Choose your country. Availability depends on it.');
    if (!isEnabled(s.chain)) return void (s.error = `${CHAINS[s.chain].name} is not switched on for Swings.`);
    s.busy = true;
    draw();
    try {
      const intent: RampIntent = { side: s.side, fiat: s.fiat, fiatAmount: amount, asset: { chain: s.chain, symbol: 'USDC', address: token.address, decimals: token.decimals }, wallet, country: s.country };
      s.search = await router.quote(intent);
      s.chosen = s.search.quotes[0] ?? null;
    } catch (e) {
      s.error = e instanceof SwingsError ? e.message : 'Options could not be fetched.';
    } finally {
      s.busy = false;
    }
  }

  async function currentBalance(chain: ChainId, wallet: string, token: string): Promise<bigint | null> {
    if (chain === 'solana') return null;
    try {
      return await readBalance(publicRead(chain), wallet, token);
    } catch {
      return null;
    }
  }

  async function open(q: RampQuote): Promise<void> {
    s.error = null;
    s.busy = true;
    draw();
    try {
      const session = await moonpay.createSession(q);
      s.link = session.url;
      const baseline = await currentBalance(q.intent.asset.chain, q.intent.wallet, q.intent.asset.address);
      if (baseline !== null) {
        s.watch = { side: q.intent.side, baseline, startedAt: Date.now(), chain: q.intent.asset.chain, wallet: q.intent.wallet, token: q.intent.asset.address, providerName: q.providerName };
        store.set(WATCH_KEY, s.watch);
      }
      window.open(session.url, '_blank', 'noopener,noreferrer');
    } catch (e) {
      s.error = e instanceof SwingsError ? e.message : 'The checkout could not be opened.';
    } finally {
      s.busy = false;
    }
  }

  async function check(): Promise<void> {
    if (!s.watch) return;
    s.busy = true;
    draw();
    const now = await currentBalance(s.watch.chain, s.watch.wallet, s.watch.token);
    const out = judgeWatch(s.watch, now);
    s.watchMessage = out.state === 'arrived' ? `${out.message} (+${formatUnits(out.delta, 6)} USDC)` : out.state === 'sent' ? `${out.message} (${formatUnits(out.delta, 6)} USDC sent)` : out.message;
    if (out.state === 'arrived' || out.state === 'sent') {
      store.del(WATCH_KEY);
      s.watch = null;
    }
    s.busy = false;
  }

  function select(label: string, options: { value: string; label: string }[], value: string, on: (v: string) => void): HTMLElement {
    const sel = el('select', { class: 'wapp__input', attrs: { 'aria-label': label } });
    for (const o of options) sel.append(el('option', { text: o.label, attrs: { value: o.value, ...(o.value === value ? { selected: '' } : {}) } }));
    sel.addEventListener('change', () => on(sel.value));
    return el('label', { class: 'wapp__field' }, [el('span', { class: 'wapp__eyebrow', text: label }), sel]);
  }

  function draw(): void {
    root.replaceChildren();
    const card = el('div', { class: 'wapp__card' });
    card.append(el('h2', { class: 'wapp__h2', text: 'USDC to Fiat: sell USDC for cash, or buy it' }), el('ol', { class: 'wapp__steps' }, ['Choose your country and amount', 'See your options', 'Finish on the provider\'s page', 'The USDC lands in your wallet'].map((t) => el('li', { text: t }))), el('p', { class: 'wapp__fine', text: 'A licensed provider takes your payment and checks who you are on its own page, so Aretia never sees your card or documents. Aretia never holds your money.' }));
    if (s.avail === undefined) {
      void load();
      card.append(el('p', { class: 'wapp__fine', text: 'Checking what is available…' }));
      return void root.append(card);
    }
    if (s.avail === null) {
      card.append(banner('warn', 'Buying and selling is not switched on, or could not be reached right now. Nothing is offered until it is confirmed.'));
      return void root.append(card);
    }
    const a = s.avail;
    const sides = a.sides.filter((x) => x === 'buy' || x === 'sell');
    if (!sides.includes(s.side)) s.side = (sides[0] as RampSide | undefined) ?? 'buy';
    const seg = el('div', { class: 'wapp__seg', attrs: { role: 'tablist' } });
    for (const sd of sides) {
      const b = el('button', { class: 'wapp__chip wapp__chip--btn', text: sd === 'buy' ? 'Buy' : 'Sell', attrs: { type: 'button', role: 'tab', 'aria-selected': String(sd === s.side) } });
      b.addEventListener('click', () => { s.side = sd as RampSide; s.search = null; s.chosen = null; s.link = null; draw(); });
      seg.append(b);
    }
    card.append(seg);
    const chains = CHOICES.filter((c) => a.catalog.tokens.some((t) => t.chain === c && t.symbol === 'USDC' && (s.side === 'buy' || t.sell)));
    if (!chains.includes(s.chain)) s.chain = chains[0] ?? 'base';
    const countries = a.catalog.countries.filter((c) => (s.side === 'buy' ? c.buy : c.sell));
    card.append(
      select('Network', chains.map((c) => ({ value: c, label: CHAINS[c].name })), s.chain, (v) => { s.chain = v as ChainId; s.search = null; s.chosen = null; draw(); }),
      select('Country', [{ value: '', label: 'Choose…' }, ...countries.map((c) => ({ value: c.code, label: c.name }))], s.country, (v) => { s.country = v; store.set(COUNTRY_KEY, v); s.search = null; s.chosen = null; draw(); }),
      select('Currency', a.catalog.fiats.map((f) => ({ value: f, label: f.toUpperCase() })), s.fiat, (v) => { s.fiat = v; s.search = null; s.chosen = null; draw(); }),
    );
    const amount = el('input', { class: 'wapp__swap-amount', attrs: { inputmode: 'numeric', placeholder: '100', autocomplete: 'off', 'aria-label': 'Amount in your currency', value: s.amount } });
    amount.addEventListener('input', () => { s.amount = amount.value; });
    card.append(el('label', { class: 'wapp__field' }, [el('span', { class: 'wapp__eyebrow', text: `Amount in ${s.fiat.toUpperCase()}` }), amount]));
    const wallet = walletFor(s.chain);
    card.append(el('p', { class: 'wapp__fine', text: wallet ? `${s.side === 'buy' ? 'USDC will be sent to' : 'Refunds, if the sale fails, go to'} ${wallet.slice(0, 6)}…${wallet.slice(-4)} on ${CHAINS[s.chain].name}.` : `Connect a ${s.chain === 'solana' ? 'Solana wallet in the Wallet tab' : 'EVM wallet in the Swap or Move USDC tab'} to continue.` }));
    const go = el('button', { class: 'wapp__btn wapp__btn--primary', text: s.busy ? 'Checking…' : 'See options', attrs: { type: 'button' } });
    go.disabled = s.busy;
    go.addEventListener('click', () => void quote().then(draw));
    card.append(go);
    if (s.error) card.append(banner('warn', s.error));
    root.append(card);
    if (s.search) {
      for (const q of s.search.quotes) {
        const qc = el('div', { class: 'wapp__card' });
        qc.append(el('strong', { text: q.providerName }));
        const ul = el('ul', { class: 'wapp__list' });
        for (const f of q.fees) ul.append(el('li', { text: `${f.label}: ${f.amount === null ? 'shown on the provider\'s page before you pay' : f.amount}` }));
        for (const d of q.disclosures) ul.append(el('li', { text: d }));
        qc.append(ul);
        const b = el('button', { class: 'wapp__btn wapp__btn--primary', text: s.busy ? 'Working…' : `Continue to ${q.providerName}`, attrs: { type: 'button' } });
        b.disabled = s.busy;
        b.addEventListener('click', () => void open(q).then(draw));
        qc.append(b);
        if (s.link) qc.append(el('p', { class: 'wapp__fine' }, [el('span', { text: 'If the page did not open: ' }), el('a', { text: `open ${q.providerName}`, attrs: { href: s.link, target: '_blank', rel: 'noopener noreferrer' } })]));
        root.append(qc);
      }
      for (const d of s.search.declined) root.append(banner('info', `${d.providerId}: ${d.reason}`));
      for (const f of s.search.failures) root.append(banner('warn', `${f.providerId}: ${f.message}`));
    }
    if (s.watch) {
      const w = el('div', { class: 'wapp__card' });
      w.append(el('strong', { text: s.watch.side === 'buy' ? 'Waiting for your USDC' : 'Waiting for your USDC to be sent' }), el('p', { class: 'wapp__fine', text: 'Aretia finishes a purchase only when your balance rises. Check after you complete the payment with the provider.' }));
      const b = el('button', { class: 'wapp__btn wapp__btn--ghost', text: s.busy ? 'Checking…' : 'Check my wallet', attrs: { type: 'button' } });
      b.disabled = s.busy;
      b.addEventListener('click', () => void check().then(draw));
      w.append(b);
      if (s.watchMessage) w.append(banner('info', s.watchMessage));
      root.append(w);
    } else if (s.watchMessage) root.append(banner('ok', s.watchMessage));
  }

  return { draw };
}
