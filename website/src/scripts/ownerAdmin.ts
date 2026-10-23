/**
 * The owner's private admin page. Signing in is the site's ordinary wallet sign-in (a free signed message); the numbers come from
 * /api/swings-admin, which answers only when the signed-in address is in the server's ADMIN_WALLETS list. Hiding anything here would
 * protect nothing: the server decides. See docs/admin-page.md.
 */
import { AccountClient, type Session, type Signer } from '../swings/account/client';

interface Tally { key: string; n: number }
type Section<T> = ({ status: 'ok' } & T) | { status: 'not-set-up' | 'error'; note: string };
interface Holding { chain: string; asset: string; amount: number | null; usd: number | null }
interface Stats {
  generatedAt: string;
  days: number;
  counters: Section<{ visits: number; visitsByDay: Tally[]; countries: Tally[]; wallets: Tally[]; chains: Tally[]; coins: Tally[]; issues: Tally[] }>;
  saved: Section<{ traders: number; byFamily: Tally[]; coins: Tally[]; failed: number; confirmed: number }>;
  events: Section<{ swaps: Tally[]; problems: Tally[] }>;
  launch: Section<{ tokensCreated: number }>;
  revenue: {
    income: Section<{ totalUsd: number; lines: { wallet: string; chain: string; stream: string; amount: string; usd: number | null; note?: string }[]; notes: string[] }>;
    heldNow: Section<{ heldUsd: number; holdings: Holding[] }>;
    creationFeesEstimate: Section<{ usd: number | null; lines: { chain: string; tokens: number; feeEach: string; usd: number | null }[] }>;
  };
  limits: string[];
}

const root = document.getElementById('owner-admin');
const usd = (n: number | null): string => (n === null ? 'n/a' : `$${n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`);
const num = (n: number): string => n.toLocaleString('en-US');

function el<K extends keyof HTMLElementTagNameMap>(tag: K, text?: string, cls?: string): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (text !== undefined) e.textContent = text;
  if (cls) e.className = cls;
  return e;
}

function card(title: string, note?: string): HTMLElement {
  const c = el('section', undefined, 'oa-card');
  c.append(el('h2', title));
  if (note) c.append(el('p', note, 'oa-note'));
  return c;
}

function table(head: string[], rows: string[][], empty = 'Nothing recorded yet.'): HTMLElement {
  if (rows.length === 0) return el('p', empty, 'oa-note');
  const t = el('table');
  const h = el('tr');
  head.forEach((x, i) => h.append(el('th', x, i > 0 ? 'r' : '')));
  t.append(h);
  for (const r of rows) {
    const tr = el('tr');
    r.forEach((x, i) => tr.append(el('td', x, i > 0 ? 'r' : '')));
    t.append(tr);
  }
  return t;
}

const tallyTable = (label: string, rows: Tally[]): HTMLElement => table([label, 'Count'], rows.map((r) => [r.key, num(r.n)]));

/** Draws a section that is on, or a plain sentence saying why it is not. */
function withSection<T>(parent: HTMLElement, s: Section<T>, draw: (ok: T) => void): void {
  if (s.status === 'ok') draw(s);
  else parent.append(el('p', s.status === 'not-set-up' ? `Not set up. ${s.note}` : `Could not be read. ${s.note}`, 'oa-warn'));
}

function render(stats: Stats): void {
  if (!root) return;
  root.replaceChildren();
  root.append(el('p', `Last ${stats.days} days · generated ${stats.generatedAt}`, 'oa-note'));
  const grid = el('div', undefined, 'oa-grid');

  const visits = card('Visits', 'Browser sessions that loaded any page, from the anonymous counter. Self-reported.');
  withSection(visits, stats.counters, (c) => {
    visits.append(el('div', num(c.visits), 'oa-big'));
    visits.append(table(['Day', 'Visits'], c.visitsByDay.slice(-14).reverse().map((r) => [r.key, num(r.n)])));
  });
  const countries = card('Country of visits', "From the host's geo header. XX means unknown.");
  withSection(countries, stats.counters, (c) => countries.append(tallyTable('Country', c.countries)));

  const wallets = card('Wallet types', 'The wallet app used for a swap that ended (confirmed or failed). Wallets only connected, not used, are not counted.');
  withSection(wallets, stats.counters, (c) => wallets.append(tallyTable('Wallet', c.wallets)));

  const traders = card('Traders', 'Distinct wallets that saved their swap history to their Aretia account. A floor, not the full number of traders.');
  withSection(traders, stats.saved, (s) => {
    traders.append(el('div', num(s.traders), 'oa-big'));
    traders.append(tallyTable('Wallet family', s.byFamily));
    traders.append(el('p', `${num(s.confirmed)} confirmed and ${num(s.failed)} failed swaps in those histories.`, 'oa-note'));
  });

  const coins = card('Coins traded', 'Coins on either side of a confirmed swap, per network, from the anonymous counter.');
  withSection(coins, stats.counters, (c) => {
    coins.append(tallyTable('Network · coin', c.coins));
    coins.append(tallyTable('Network of confirmed swaps', c.chains));
  });
  if (stats.saved.status === 'ok') {
    coins.append(el('h3', 'Same, from saved swap histories (signed-in wallets only)'));
    coins.append(tallyTable('Network · coin', stats.saved.coins));
  }

  const revenue = card('Revenue through Aretia fees', 'What the page can measure from free data. For income by chain and stream, run the private report on your computer (docs/revenue-report.md).');
  withSection(revenue, stats.revenue.income, (i) => {
    revenue.append(el('div', usd(i.totalUsd), 'oa-big'));
    revenue.append(el('p', `Income received at the Aretia fee wallets in the last ${stats.days} days (as far as the public nodes could be read), before gas.`, 'oa-note'));
    revenue.append(table(['Wallet · chain · stream', 'Amount', 'USD'], i.lines.map((l) => [`${l.wallet} · ${l.chain} · ${l.stream}`, l.amount, usd(l.usd)])));
    for (const n of i.notes) revenue.append(el('p', n, 'oa-warn'));
  });
  withSection(revenue, stats.revenue.heldNow, (h) => {
    revenue.append(el('div', usd(h.heldUsd), 'oa-big'));
    revenue.append(el('p', 'Held at the fee addresses now (not income for the period: before gas, after anything moved out).', 'oa-note'));
    revenue.append(table(['Chain · asset', 'Amount', 'USD'], h.holdings.map((x) => [`${x.chain} · ${x.asset}`, x.amount === null ? 'unreadable' : x.amount.toLocaleString('en-US', { maximumFractionDigits: 4 }), usd(x.usd)])));
  });
  withSection(revenue, stats.revenue.creationFeesEstimate, (e) => {
    revenue.append(el('h3', `Token creation fees, estimate: ${usd(e.usd)}`));
    revenue.append(el('p', 'Tokens created through Aretia in the window (from the Launch Box index) times the flat fee. An estimate, not a measured receipt.', 'oa-note'));
    revenue.append(table(['Chain', 'Tokens', 'Fee each', 'USD'], e.lines.map((l) => [l.chain, num(l.tokens), l.feeEach, usd(l.usd)])));
  });

  const issues = card('Issues users are hitting', 'Failed swaps and script errors by category (never the message), plus failed quotes and swaps from the swap analytics.');
  withSection(issues, stats.counters, (c) => issues.append(tallyTable('Issue', c.issues)));
  withSection(issues, stats.events, (e) => {
    issues.append(el('h3', 'From swap analytics (only when analytics is switched on)'));
    issues.append(tallyTable('Problem', e.problems));
  });

  grid.append(visits, countries, wallets, traders, coins, revenue, issues);
  root.append(grid);
  const limits = card('What these numbers are not');
  const ul = el('ul');
  for (const l of stats.limits) ul.append(el('li', l));
  limits.append(ul);
  root.append(limits);
}

interface Eth { request(a: { method: string; params?: unknown[] }): Promise<unknown> }
interface Sol { connect(): Promise<{ publicKey: { toString(): string } }>; signMessage(m: Uint8Array, display?: string): Promise<{ signature: Uint8Array }> }

async function evmSigner(): Promise<Signer> {
  const eth = (window as unknown as { ethereum?: Eth }).ethereum;
  if (!eth) throw new Error('No Ethereum-style wallet was found in this browser.');
  const [address] = (await eth.request({ method: 'eth_requestAccounts' })) as string[];
  if (!address) throw new Error('No account was shared.');
  const hex = (m: string): string => '0x' + [...new TextEncoder().encode(m)].map((b) => b.toString(16).padStart(2, '0')).join('');
  return { family: 'evm', address, sign: async (m) => (await eth.request({ method: 'personal_sign', params: [hex(m), address] })) as string };
}

async function solanaSigner(): Promise<Signer> {
  const w = window as unknown as { phantom?: { solana?: Sol }; solana?: Sol };
  const sol = w.phantom?.solana ?? w.solana;
  if (!sol) throw new Error('No Solana wallet was found in this browser.');
  const address = (await sol.connect()).publicKey.toString();
  return { family: 'solana', address, sign: async (m) => btoa(String.fromCharCode(...(await sol.signMessage(new TextEncoder().encode(m), 'utf8')).signature)) };
}

function init(): void {
  const status = document.getElementById('owner-admin-status');
  const buttons = document.getElementById('owner-admin-buttons');
  if (!root || !status || !buttons) return;
  const account = new AccountClient(localStorage);
  const say = (m: string): void => {
    status.textContent = m;
  };

  async function load(session: Session): Promise<void> {
    say('Loading…');
    const res = await fetch('/api/swings-admin', { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${session.token}` }, body: JSON.stringify({ days: 30 }) });
    if (!res.ok) {
      say('This wallet is not allowed to see this page, or the sign-in has ended. Sign in with the owner wallet.');
      return;
    }
    say('');
    render((await res.json()) as Stats);
  }

  async function go(make: () => Promise<Signer>): Promise<void> {
    try {
      const signer = await make();
      const session = account.session(signer.family, signer.address) ?? (await account.signIn(signer));
      await load(session);
    } catch (e) {
      say(e instanceof Error && /reject|declin|denied/i.test(e.message) ? 'The sign-in was declined.' : e instanceof Error ? e.message : 'Sign-in failed.');
    }
  }

  for (const [label, make] of [['Sign in with an Ethereum-style wallet', evmSigner], ['Sign in with a Solana wallet', solanaSigner]] as const) {
    const b = el('button', label, 'oa-btn');
    b.type = 'button';
    b.addEventListener('click', () => void go(make));
    buttons.append(b);
  }
}

init();
