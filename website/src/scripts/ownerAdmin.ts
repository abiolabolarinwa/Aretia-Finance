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
const shortAddr = (a: string): string => (a.length > 14 ? `${a.slice(0, 6)}…${a.slice(-4)}` : a);
const PERIODS = [7, 30, 90] as const;
const PERIOD_KEY = 'aretia-owner-days';

function el<K extends keyof HTMLElementTagNameMap>(tag: K, text?: string, cls?: string): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (text !== undefined) e.textContent = text;
  if (cls) e.className = cls;
  return e;
}

function card(title: string, note?: string, wide = false): HTMLElement {
  const c = el('section', undefined, wide ? 'oa-card oa-card--wide' : 'oa-card');
  c.append(el('h2', title));
  if (note) c.append(el('p', note, 'oa-note'));
  return c;
}

function table(head: string[], rows: string[][], empty = 'Nothing recorded yet.', monoFirst = false): HTMLElement {
  if (rows.length === 0) return el('p', empty, 'oa-empty');
  const t = el('table');
  const h = el('tr');
  head.forEach((x, i) => h.append(el('th', x, i > 0 ? 'r' : '')));
  t.append(h);
  for (const r of rows) {
    const tr = el('tr');
    r.forEach((x, i) => tr.append(el('td', x, i > 0 ? 'r' : monoFirst ? 'm' : '')));
    t.append(tr);
  }
  return t;
}

/** A ranked list with a bar behind each count, in place of a two-column table. */
function barList(rows: Tally[], empty = 'Nothing recorded yet.', limit = 12): HTMLElement {
  if (rows.length === 0) return el('p', empty, 'oa-empty');
  const shown = rows.slice(0, limit);
  const max = Math.max(1, ...shown.map((r) => r.n));
  const ul = el('ul', undefined, 'oa-list');
  for (const r of shown) {
    const li = el('li');
    const track = el('span', undefined, 't');
    const fill = el('i');
    fill.style.width = `${Math.max(2, (r.n / max) * 100)}%`;
    track.append(fill);
    const label = el('span', r.key, 'l');
    label.title = r.key;
    li.append(label, track, el('span', num(r.n), 'n'));
    ul.append(li);
  }
  if (rows.length > shown.length) ul.after(el('p', `and ${rows.length - shown.length} more`, 'oa-note'));
  return ul;
}

/** Visits per day as columns; hovering one names the day and the count. */
function dayChart(rows: Tally[]): HTMLElement {
  const wrap = el('div');
  if (rows.length === 0) return el('p', 'No visits recorded yet.', 'oa-empty');
  const max = Math.max(1, ...rows.map((r) => r.n));
  const bars = el('div', undefined, 'oa-days');
  bars.setAttribute('role', 'img');
  bars.setAttribute('aria-label', `Visits per day, from ${rows[0]!.key} to ${rows[rows.length - 1]!.key}, highest ${num(max)}`);
  for (const r of rows) {
    const b = el('span');
    b.style.height = `${Math.max(2, (r.n / max) * 100)}%`;
    b.title = `${r.key}: ${num(r.n)}`;
    bars.append(b);
  }
  const axis = el('div', undefined, 'oa-days-axis');
  axis.append(el('span', rows[0]!.key), el('span', rows[rows.length - 1]!.key));
  wrap.append(bars, axis);
  return wrap;
}

const flag = (text: string, off = false): HTMLElement => el('p', text, off ? 'oa-flag oa-flag--off' : 'oa-flag');

/** Draws a section that is on, or a plain sentence saying why it is not. */
function withSection<T>(parent: HTMLElement, s: Section<T>, draw: (ok: T) => void): void {
  if (s.status === 'ok') draw(s);
  else parent.append(flag(s.status === 'not-set-up' ? `Not set up. ${s.note}` : `Could not be read. ${s.note}`, s.status === 'not-set-up'));
}

function kpi(label: string, value: string | null, sub?: string): HTMLElement {
  const k = el('div', undefined, 'oa-kpi');
  k.append(el('p', label, 'oa-kpi-label'), el('p', value ?? 'Not available', value === null ? 'oa-kpi-value is-off' : 'oa-kpi-value'));
  if (sub) k.append(el('p', sub, 'oa-kpi-sub'));
  return k;
}

function section(id: string, title: string): { box: HTMLElement; grid: HTMLElement } {
  const box = el('section', undefined, 'oa-section');
  box.id = id;
  box.append(el('h2', title, 'oa-section-title'));
  const grid = el('div', undefined, 'oa-grid');
  box.append(grid);
  return { box, grid };
}

interface Controls {
  days: number;
  onDays(d: number): void;
  onRefresh(): void;
  onSignOut(): void;
}

function render(stats: Stats, ctl: Controls): void {
  if (!root) return;
  root.replaceChildren();

  // Toolbar: period, refresh, sign out.
  const bar = el('div', undefined, 'oa-bar');
  const left = el('div', undefined, 'oa-bar-left');
  const seg = el('div', undefined, 'oa-seg');
  seg.setAttribute('role', 'group');
  seg.setAttribute('aria-label', 'Period');
  for (const d of PERIODS) {
    const b = el('button', `${d} days`);
    b.type = 'button';
    b.setAttribute('aria-pressed', String(d === stats.days));
    b.addEventListener('click', () => ctl.onDays(d));
    seg.append(b);
  }
  left.append(seg, el('span', `Updated ${new Date(stats.generatedAt).toLocaleString()}`, 'oa-updated'));
  const right = el('div', undefined, 'oa-bar-right');
  const refresh = el('button', 'Refresh', 'oa-btn');
  refresh.type = 'button';
  refresh.addEventListener('click', ctl.onRefresh);
  const out = el('button', 'Sign out', 'oa-btn');
  out.type = 'button';
  out.addEventListener('click', ctl.onSignOut);
  right.append(refresh, out);
  bar.append(left, right);

  // The headline numbers.
  const kpis = el('div', undefined, 'oa-kpis');
  kpis.append(
    kpi('Visits', stats.counters.status === 'ok' ? num(stats.counters.visits) : null, `Last ${stats.days} days`),
    kpi('Traders', stats.saved.status === 'ok' ? num(stats.saved.traders) : null, 'Saved histories: a floor'),
    kpi('Fee income', stats.revenue.income.status === 'ok' ? usd(stats.revenue.income.totalUsd) : null, `Before gas, last ${stats.days} days`),
    kpi('Held at fee addresses', stats.revenue.heldNow.status === 'ok' ? usd(stats.revenue.heldNow.heldUsd) : null, 'Right now'),
    kpi('Tokens created', stats.launch.status === 'ok' ? num(stats.launch.tokensCreated) : null, 'Through Aretia Launch'),
  );

  const nav = el('nav', undefined, 'oa-nav');
  nav.setAttribute('aria-label', 'Sections');
  for (const [id, label] of [['traffic', 'Traffic'], ['trading', 'Trading'], ['revenue', 'Revenue'], ['issues', 'Issues']] as const) {
    const a = el('a', label);
    a.href = `#oa-${id}`;
    nav.append(a);
  }

  // Traffic.
  const traffic = section('oa-traffic', 'Traffic');
  const visits = card('Visits by day', 'Browser sessions that loaded any page, from the anonymous counter. Self-reported.', true);
  withSection(visits, stats.counters, (c) => visits.append(dayChart(c.visitsByDay.slice(-Math.min(stats.days, 90)))));
  const countries = card('Country of visits', "From the host's geo header. XX means unknown.");
  withSection(countries, stats.counters, (c) => countries.append(barList(c.countries)));
  const wallets = card('Wallet types', 'The wallet app used for a swap that ended (confirmed or failed). Wallets only connected, not used, are not counted.');
  withSection(wallets, stats.counters, (c) => wallets.append(barList(c.wallets)));
  traffic.grid.append(visits, countries, wallets);

  // Trading.
  const trading = section('oa-trading', 'Trading');
  const traders = card('Traders', 'Distinct wallets that saved their swap history to their Aretia account. A floor, not the full number of traders.');
  withSection(traders, stats.saved, (s) => {
    traders.append(el('p', num(s.traders), 'oa-kpi-value'));
    traders.append(barList(s.byFamily));
    traders.append(el('p', `${num(s.confirmed)} confirmed and ${num(s.failed)} failed swaps in those histories.`, 'oa-note'));
  });
  const coins = card('Coins traded', 'Coins on either side of a confirmed swap, per network, from the anonymous counter.');
  withSection(coins, stats.counters, (c) => {
    coins.append(barList(c.coins));
    coins.append(el('h3', 'Network of confirmed swaps'));
    coins.append(barList(c.chains));
  });
  if (stats.saved.status === 'ok') {
    coins.append(el('h3', 'Same, from saved swap histories (signed-in wallets only)'));
    coins.append(barList(stats.saved.coins));
  }
  trading.grid.append(traders, coins);

  // Revenue.
  const revenue = section('oa-revenue', 'Revenue through Aretia fees');
  revenue.box.append(el('p', 'What the page can measure from free data. For income by chain and stream, run the private report on your computer (docs/revenue-report.md).', 'oa-note'));
  const income = card('Income received', undefined, true);
  withSection(income, stats.revenue.income, (i) => {
    income.append(el('p', usd(i.totalUsd), 'oa-kpi-value'));
    income.append(el('p', `Received at the Aretia fee wallets in the last ${stats.days} days (as far as the public nodes could be read), before gas.`, 'oa-note'));
    income.append(table(['Wallet · chain · stream', 'Amount', 'USD'], i.lines.map((l) => [`${l.wallet} · ${l.chain} · ${l.stream}`, l.amount, usd(l.usd)]), 'No income was found in this period.', true));
    for (const n of i.notes) income.append(flag(n));
  });
  const held = card('Held now');
  withSection(held, stats.revenue.heldNow, (h) => {
    held.append(el('p', usd(h.heldUsd), 'oa-kpi-value'));
    held.append(el('p', 'At the fee addresses now (not income for the period: before gas, after anything moved out).', 'oa-note'));
    held.append(table(['Chain · asset', 'Amount', 'USD'], h.holdings.map((x) => [`${x.chain} · ${x.asset}`, x.amount === null ? 'unreadable' : x.amount.toLocaleString('en-US', { maximumFractionDigits: 4 }), usd(x.usd)])));
  });
  const fees = card('Token creation fees, estimate');
  withSection(fees, stats.revenue.creationFeesEstimate, (e) => {
    fees.append(el('p', usd(e.usd), 'oa-kpi-value'));
    fees.append(el('p', 'Tokens created through Aretia in the window (from the Launch Box index) times the flat fee. An estimate, not a measured receipt.', 'oa-note'));
    fees.append(table(['Chain', 'Tokens', 'Fee each', 'USD'], e.lines.map((l) => [l.chain, num(l.tokens), l.feeEach, usd(l.usd)])));
  });
  revenue.grid.append(income, held, fees);

  // Issues.
  const issues = section('oa-issues', 'Issues users are hitting');
  const hits = card('Failed swaps and script errors', 'By category (never the message).');
  withSection(hits, stats.counters, (c) => hits.append(barList(c.issues, 'No issues recorded.')));
  const problems = card('From swap analytics', 'Failed quotes and swaps. Only when analytics is switched on.');
  withSection(problems, stats.events, (e) => problems.append(barList(e.problems, 'No problems recorded.')));
  issues.grid.append(hits, problems);

  const limits = el('details', undefined, 'oa-limits');
  limits.append(el('summary', 'What these numbers are not'));
  const ul = el('ul');
  for (const l of stats.limits) ul.append(el('li', l));
  limits.append(ul);

  root.append(bar, kpis, nav, traffic.box, trading.box, revenue.box, issues.box, limits);
}

/** Grey placeholders while the numbers load, so the page does not jump when they arrive. */
function skeleton(): void {
  if (!root) return;
  root.replaceChildren();
  const k = el('div', undefined, 'oa-kpis');
  for (let i = 0; i < 5; i++) k.append(el('div', undefined, 'oa-skel'));
  root.append(k);
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

function readDays(): number {
  try {
    const d = Number(localStorage.getItem(PERIOD_KEY));
    return (PERIODS as readonly number[]).includes(d) ? d : 30;
  } catch {
    return 30;
  }
}

function init(): void {
  const status = document.getElementById('owner-admin-status');
  const buttons = document.getElementById('owner-admin-buttons');
  const signin = document.getElementById('owner-admin-signin');
  const who = document.getElementById('owner-admin-who');
  if (!root || !status || !buttons || !signin || !who) return;
  const account = new AccountClient(localStorage);
  let days = readDays();
  let current: { signer: Signer; session: Session } | null = null;
  const say = (m: string, bad = false): void => {
    status.textContent = m;
    status.classList.toggle('is-bad', bad);
  };
  const setBusy = (busy: boolean): void => buttons.querySelectorAll('button').forEach((b) => (b.disabled = busy));

  function showSignedOut(): void {
    current = null;
    root!.replaceChildren();
    who!.hidden = true;
    signin!.hidden = false;
  }

  async function load(): Promise<void> {
    if (!current) return;
    const { session, signer } = current;
    say('Loading…');
    skeleton();
    try {
      const res = await fetch('/api/swings-admin', { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${session.token}` }, body: JSON.stringify({ days }) });
      if (!res.ok) {
        showSignedOut();
        say('This wallet is not allowed to see this page, or the sign-in has ended. Sign in with the owner wallet.', true);
        return;
      }
      const stats = (await res.json()) as Stats;
      say('');
      signin!.hidden = true;
      who!.hidden = false;
      who!.replaceChildren(el('span', shortAddr(signer.address), 'oa-chip'), el('span', signer.family === 'evm' ? 'Ethereum-style wallet' : 'Solana wallet'));
      render(stats, {
        days,
        onDays: (d) => {
          days = d;
          try {
            localStorage.setItem(PERIOD_KEY, String(d));
          } catch {
            // The choice lasts until the page is closed.
          }
          void load();
        },
        onRefresh: () => void load(),
        onSignOut: () => {
          account.signOut(signer.family, signer.address);
          showSignedOut();
          say('Signed out on this device.');
        },
      });
    } catch {
      showSignedOut();
      say('The numbers could not be loaded. Check your connection and sign in again.', true);
    }
  }

  async function go(make: () => Promise<Signer>): Promise<void> {
    setBusy(true);
    try {
      const signer = await make();
      const session = account.session(signer.family, signer.address) ?? (await account.signIn(signer));
      current = { signer, session };
      await load();
    } catch (e) {
      say(e instanceof Error && /reject|declin|denied/i.test(e.message) ? 'The sign-in was declined.' : e instanceof Error ? e.message : 'Sign-in failed.', true);
    }
    setBusy(false);
  }

  for (const [label, make, primary] of [['Sign in with an Ethereum-style wallet', evmSigner, true], ['Sign in with a Solana wallet', solanaSigner, false]] as const) {
    const b = el('button', label, primary ? 'oa-btn oa-btn--primary' : 'oa-btn');
    b.type = 'button';
    b.addEventListener('click', () => void go(make));
    buttons.append(b);
  }
}

init();
