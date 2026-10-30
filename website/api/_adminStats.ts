/**
 * The owner's private admin page (docs/admin-page.md), behind two routes of swings-data:
 *   POST /api/swings-beacon  anonymous counters from the site: a visit, a swap outcome, a failed action. No sign-in. Stores a count per
 *                            day and category in admin_counters (migration 0016) and nothing else: no IP, no address, no user id.
 *   POST /api/swings-admin   the numbers, for the owner only: a valid wallet sign-in session whose address is in ADMIN_WALLETS.
 *                            Everyone else (no session, wrong wallet, no allow-list set, wrong method or origin) gets the same 404
 *                            as a path that does not exist, and no data.
 * Every section of the answer says what it measured and where it is only a floor or an estimate, and a section whose table is not in
 * the database yet answers "not-set-up" instead of failing.
 */
import { supabaseBase } from '../src/swings/tokens/supabaseAuth.js';
import { isOriginAllowed, overLimit, type ProxyEnv } from './_rpcProxy.js';
import { sessionOwner, sessionSecret } from './_swingsAuth.js';
import { rest, type Rest } from './_swingsAccount.js';
import { overBudget } from './_limits.js';
import { readIncome, type Income } from './_adminIncome.js';

export interface AdminEnv extends ProxyEnv {
  SUPABASE_URL?: string;
  SUPABASE_SERVICE_ROLE_KEY?: string;
  SWINGS_SESSION_SECRET?: string;
  /** Comma-separated owner wallets: `0x…` (any case), `evm:0x…`, `solana:<address>`, or a bare Solana address. */
  ADMIN_WALLETS?: string;
  /** Optional own node URLs, used for the income reading instead of the free public ones (same names as the private revenue report). */
  ETH_RPC_URL?: string;
  BNB_RPC_URL?: string;
  POLYGON_RPC_URL?: string;
}
export interface AdminOutput {
  status: number;
  body: string;
  headers: Record<string, string>;
}

const DAY_MS = 86_400_000;
const JSON_HEADERS = { 'content-type': 'application/json', 'cache-control': 'no-store' };
export const NOT_FOUND: AdminOutput = { status: 404, body: '{"error":"not-found"}', headers: JSON_HEADERS };
const json = (status: number, data: unknown, extra: Record<string, string> = {}): AdminOutput => ({ status, body: JSON.stringify(data), headers: { ...JSON_HEADERS, ...extra } });
const obj = (v: unknown): Record<string, unknown> => (typeof v === 'object' && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : {});

// ---------------------------------------------------------------- the owner allow-list

/** One allow-list entry as the owner key a session carries (`evm:0x…` lower case, `solana:<address>`), or null when it is not an address. */
export function normaliseOwner(entry: string): string | null {
  const e = entry.trim();
  if (/^(evm:)?0x[0-9a-fA-F]{40}$/.test(e)) return `evm:${e.replace(/^evm:/, '').toLowerCase()}`;
  const sol = e.replace(/^solana:/, '');
  return /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(sol) ? `solana:${sol}` : null;
}

export function adminOwners(env: { ADMIN_WALLETS?: string }): Set<string> {
  const out = new Set<string>();
  for (const part of (env.ADMIN_WALLETS ?? '').split(/[\s,;]+/)) {
    const o = part ? normaliseOwner(part) : null;
    if (o) out.add(o);
  }
  return out;
}

// ---------------------------------------------------------------- the beacon

const DAY = (now: number): string => new Date(now).toISOString().slice(0, 10);
const CHAIN_IDS = ['solana', 'ethereum', 'bnb', 'polygon', 'base', 'robinhood'];
const ISSUE_AREAS = ['js-error', 'unhandled-rejection', 'swap-failed', 'sign-in-failed', 'quote-failed', 'launch-failed', 'wallet-connect-failed', 'other'];
const LABEL = /[^A-Za-z0-9 ._-]/g;

/** A short label made only of letters, digits, space, dot, dash and underscore; null when nothing is left. */
export function cleanLabel(v: unknown, max = 24): string | null {
  if (typeof v !== 'string') return null;
  const s = v.replace(LABEL, '').trim().slice(0, max);
  return s.length > 0 ? s : null;
}

export interface Bump {
  kind: 'visit' | 'country' | 'wallet' | 'chain' | 'coin' | 'issue';
  key: string;
}

/** The counters one beacon adds to. `country` is the host's two-letter geo header. Anything unrecognised adds nothing. */
export function bumpsFor(raw: unknown, country: string | null): Bump[] {
  const e = obj(raw);
  const chain = typeof e.chain === 'string' && CHAIN_IDS.includes(e.chain) ? e.chain : null;
  if (e.k === 'visit') {
    const cc = country && /^[A-Za-z]{2}$/.test(country) ? country.toUpperCase() : 'XX';
    return [
      { kind: 'visit', key: 'all' },
      { kind: 'country', key: cc },
    ];
  }
  if (e.k === 'swap' && chain) {
    const status = e.status === 'confirmed' ? 'confirmed' : e.status === 'failed' ? 'failed' : null;
    if (!status) return [];
    const wallet = cleanLabel(e.wallet, 32);
    const out: Bump[] = [];
    if (wallet) out.push({ kind: 'wallet', key: wallet });
    if (status === 'failed') return [...out, { kind: 'issue', key: `swap-failed:${chain}` }];
    out.push({ kind: 'chain', key: chain });
    for (const sym of [cleanLabel(e.from, 12), cleanLabel(e.to, 12)]) if (sym) out.push({ kind: 'coin', key: `${chain}:${sym}` });
    return out;
  }
  if (e.k === 'issue') {
    const area = typeof e.area === 'string' && ISSUE_AREAS.includes(e.area) ? e.area : null;
    if (!area) return [];
    // `detail` is the kind of error ("TypeError", a chain id), never a message.
    const detail = chain ?? cleanLabel(e.detail, 24);
    return [{ kind: 'issue', key: detail ? `${area}:${detail}`.slice(0, 48) : area }];
  }
  return [];
}

export interface BeaconInput {
  method: string;
  origin: string | null;
  ip: string;
  country: string | null;
  body: unknown;
  env: AdminEnv;
  fetchImpl: typeof fetch;
  now: number;
}

export async function handleBeacon(input: BeaconInput): Promise<AdminOutput> {
  const headers: Record<string, string> = { vary: 'origin', ...JSON_HEADERS };
  const allowed = isOriginAllowed(input.origin, input.env);
  if (allowed) {
    headers['access-control-allow-origin'] = input.origin!;
    headers['access-control-allow-methods'] = 'POST, OPTIONS';
    headers['access-control-allow-headers'] = 'content-type';
  }
  if (input.method === 'OPTIONS') return { status: allowed ? 204 : 403, body: '', headers };
  if (input.method !== 'POST') return { status: 405, body: '{"error":"method"}', headers };
  if (!allowed) return { status: 403, body: '{"error":"origin"}', headers };
  const url = supabaseBase(input.env.SUPABASE_URL);
  const key = input.env.SUPABASE_SERVICE_ROLE_KEY?.trim();
  if (!url || !key) return { status: 503, body: '{"error":"not-configured"}', headers };
  // The address is used only for this in-memory limit and is never written down.
  if (overLimit(`beacon:${input.ip}`, input.now) || overBudget(`beacon-ip:${input.ip}`, input.now, 30)) return { status: 429, body: '{"error":"rate-limit"}', headers };
  const bumps = bumpsFor(input.body, input.country);
  if (bumps.length === 0) return { status: 204, body: '', headers };
  const db = rest(url, key, input.fetchImpl);
  const day = DAY(input.now);
  try {
    await Promise.all(bumps.map((b) => db.call('rpc/admin_bump', { method: 'POST', body: JSON.stringify({ p_day: day, p_kind: b.kind, p_key: b.key }) })));
  } catch {
    // Migration 0016 not applied yet, or the database is down: a counter is never worth an error for a visitor.
    return { status: 204, body: '', headers };
  }
  return { status: 204, body: '', headers };
}

// ---------------------------------------------------------------- the numbers

export type Section<T extends object> = ({ status: 'ok' } & T) | { status: 'not-set-up' | 'error'; note: string };
export interface Tally {
  key: string;
  n: number;
}

const MISSING = /answered (404|400)\b/;
async function guarded<T extends object>(label: string, fn: () => Promise<T>): Promise<Section<T>> {
  try {
    return { status: 'ok', ...(await fn()) };
  } catch (e) {
    const msg = e instanceof Error ? e.message : '';
    return MISSING.test(msg) ? { status: 'not-set-up', note: `${label}: the table is not in the database yet (apply the migration listed in docs/admin-page.md).` } : { status: 'error', note: `${label} could not be read.` };
  }
}

/** Adds up rows of { kind, key, n } by key, largest first. */
export function tally(rows: { key: string; n: number }[], top = 20): Tally[] {
  const m = new Map<string, number>();
  for (const r of rows) m.set(r.key, (m.get(r.key) ?? 0) + Number(r.n));
  return [...m].map(([key, n]) => ({ key, n })).sort((a, b) => b.n - a.n || a.key.localeCompare(b.key)).slice(0, top);
}

interface CounterRow { day: string; kind: string; key: string; n: number }

export function summariseCounters(rows: CounterRow[]): { visits: number; visitsByDay: Tally[]; countries: Tally[]; wallets: Tally[]; chains: Tally[]; coins: Tally[]; issues: Tally[] } {
  const of = (kind: string): CounterRow[] => rows.filter((r) => r.kind === kind);
  const visits = of('visit');
  return {
    visits: visits.reduce((s, r) => s + Number(r.n), 0),
    visitsByDay: visits.map((r) => ({ key: r.day, n: Number(r.n) })).sort((a, b) => a.key.localeCompare(b.key)),
    countries: tally(of('country')),
    wallets: tally(of('wallet')),
    chains: tally(of('chain')),
    coins: tally(of('coin')),
    issues: tally(of('issue')),
  };
}

/** Distinct wallets and the coins they traded, from the swap histories people chose to save to their account (a floor, not all traders). */
export function summariseSavedTrades(rows: { owner: string; data: unknown }[]): { traders: number; byFamily: Tally[]; coins: Tally[]; failed: number; confirmed: number } {
  const owners = new Set<string>();
  const coins: Tally[] = [];
  let failed = 0;
  let confirmed = 0;
  for (const r of rows) {
    owners.add(r.owner);
    const d = obj(r.data);
    if (d.status === 'failed') failed++;
    if (d.status === 'confirmed') confirmed++;
    if (d.status !== 'confirmed') continue;
    for (const s of [d.fromSymbol, d.toSymbol]) if (typeof s === 'string' && s) coins.push({ key: `${typeof d.chain === 'string' ? d.chain : '?'}:${s}`, n: 1 });
  }
  const fam = [...owners].map((o) => ({ key: o.startsWith('solana:') ? 'Solana wallets' : 'Ethereum-style wallets', n: 1 }));
  return { traders: owners.size, byFamily: tally(fam), coins: tally(coins), failed, confirmed };
}

export function summariseEvents(rows: { name: string; chain: string | null; provider: string | null; status: string | null }[]): { swaps: Tally[]; problems: Tally[] } {
  const swaps: Tally[] = [];
  const problems: Tally[] = [];
  for (const r of rows) {
    if (r.name === 'swap' && r.status) swaps.push({ key: `${r.chain ?? '?'} · ${r.status}`, n: 1 });
    if (r.name === 'swap' && r.status && r.status !== 'confirmed' && r.status !== 'submitted') problems.push({ key: `swap ${r.status} · ${r.chain ?? '?'} · ${r.provider ?? '?'}`, n: 1 });
    if (r.name === 'quote_failed') problems.push({ key: `quote failed · ${r.provider ?? '?'}`, n: 1 });
  }
  return { swaps: tally(swaps), problems: tally(problems) };
}

// ---------------------------------------------------------------- revenue: what is held at the fee addresses now

// The same addresses and fees as scripts/revenueReportCore.mjs; a test keeps them equal.
export const SOLANA_FEE_WALLET = '2tcBrd1JQjL8VHNFRYB1EurbyLiVAKZTYTYk94aVoZX2';
export const EVM_FEE_ADDRESS = '0xeb8725e16e504036c2166aa47804d88ecc4d0945';
export const SOLANA_FLAT_FEE_LAMPORTS = 50_000_000n;
export const SOLANA_USDC_MINT = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
export const SOLANA_RPC = 'https://api.mainnet-beta.solana.com';
export const EVM_CHAINS = [
  { key: 'ethereum', blocksPerDay: 7200, name: 'Ethereum', symbol: 'ETH', coingecko: 'ethereum', rpc: 'https://ethereum-rpc.publicnode.com', creationFeeWei: 4_200_000_000_000_000n, usdc: ['0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48', 6], usdt: ['0xdac17f958d2ee523a2206206994597c13d831ec7', 6] },
  { key: 'bnb', blocksPerDay: 28800, name: 'BNB Chain', symbol: 'BNB', coingecko: 'binancecoin', rpc: 'https://bsc-rpc.publicnode.com', creationFeeWei: 14_000_000_000_000_000n, usdc: ['0x8ac76a51cc950d9822d68b83fe1ad97b32cd580d', 18], usdt: ['0x55d398326f99059ff775485246999027b3197955', 18] },
  { key: 'polygon', blocksPerDay: 43200, name: 'Polygon', symbol: 'POL', coingecko: 'polygon-ecosystem-token', rpc: 'https://polygon-bor-rpc.publicnode.com', creationFeeWei: 105_000_000_000_000_000_000n, usdc: ['0x3c499c542cef5e3811e1192ce70d8cc03d5c3359', 6], usdt: ['0xc2132d05d31c914a87c6611c10748aeb04b58e8f', 6] },
] as const;

const unit = (raw: bigint, decimals: number): number => Number(raw) / 10 ** decimals;

async function rpc(fetchImpl: typeof fetch, url: string, method: string, params: unknown[]): Promise<unknown> {
  const res = await fetchImpl(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }), signal: AbortSignal.timeout(7000) });
  const body = (await res.json()) as { result?: unknown; error?: unknown };
  if (!res.ok || body.error || body.result === undefined) throw new Error(`${method} failed`);
  return body.result;
}

export interface Holding { chain: string; asset: string; amount: number | null; usd: number | null }

/** The coin balances now at Aretia's fee addresses, from public nodes, in dollars where a price was available. Unreadable lines are null. */
export async function readHoldings(fetchImpl: typeof fetch): Promise<{ holdings: Holding[]; heldUsd: number; prices: Record<string, number | null> }> {
  const ids = ['solana', ...EVM_CHAINS.map((c) => c.coingecko)];
  const prices: Record<string, number | null> = {};
  try {
    const res = await fetchImpl(`https://api.coingecko.com/api/v3/simple/price?ids=${ids.join(',')}&vs_currencies=usd`, { signal: AbortSignal.timeout(7000) });
    const p = (await res.json()) as Record<string, { usd?: number }>;
    for (const id of ids) prices[id] = typeof p[id]?.usd === 'number' ? p[id]!.usd! : null;
  } catch {
    for (const id of ids) prices[id] = null;
  }
  const wallet = EVM_FEE_ADDRESS.slice(2).padStart(64, '0');
  const jobs: Promise<Holding>[] = [];
  const job = (chain: string, asset: string, price: number | null, read: () => Promise<number>): void => {
    jobs.push(read().then((amount) => ({ chain, asset, amount, usd: price === null ? null : amount * price }), () => ({ chain, asset, amount: null, usd: null })));
  };
  job('Solana', 'SOL', prices.solana ?? null, async () => unit(BigInt(((await rpc(fetchImpl, SOLANA_RPC, 'getBalance', [SOLANA_FEE_WALLET])) as { value: number }).value), 9));
  job('Solana', 'USDC', 1, async () => {
    const r = (await rpc(fetchImpl, SOLANA_RPC, 'getTokenAccountsByOwner', [SOLANA_FEE_WALLET, { mint: SOLANA_USDC_MINT }, { encoding: 'jsonParsed' }])) as { value: { account: { data: { parsed: { info: { tokenAmount: { uiAmount: number | null } } } } } }[] };
    return r.value.reduce((s, a) => s + (a.account.data.parsed.info.tokenAmount.uiAmount ?? 0), 0);
  });
  for (const c of EVM_CHAINS) {
    job(c.name, c.symbol, prices[c.coingecko] ?? null, async () => unit(BigInt((await rpc(fetchImpl, c.rpc, 'eth_getBalance', [EVM_FEE_ADDRESS, 'latest'])) as string), 18));
    for (const [asset, [token, decimals]] of [['USDC', c.usdc], ['USDT', c.usdt]] as const) {
      job(c.name, asset, 1, async () => unit(BigInt((await rpc(fetchImpl, c.rpc, 'eth_call', [{ to: token, data: `0x70a08231${wallet}` }, 'latest'])) as string), decimals));
    }
  }
  const holdings = await Promise.all(jobs);
  return { holdings, heldUsd: holdings.reduce((s, h) => s + (h.usd ?? 0), 0), prices };
}

let incomeCache: { at: number; days: number; value: Income } | null = null;
let holdingsCache: { at: number; value: Awaited<ReturnType<typeof readHoldings>> } | null = null;

/** Creation fees implied by the Launch Box index: tokens created in the window times the flat fee each chain charges (an estimate). */
export function estimateCreationRevenue(created: { chain: string }[], prices: Record<string, number | null>): { lines: { chain: string; tokens: number; feeEach: string; usd: number | null }[]; usd: number | null } {
  const lines: { chain: string; tokens: number; feeEach: string; usd: number | null }[] = [];
  const count = (chain: string): number => created.filter((t) => t.chain === chain).length;
  const sol = count('solana');
  lines.push({ chain: 'Solana', tokens: sol, feeEach: '0.05 SOL', usd: prices.solana == null ? null : sol * unit(SOLANA_FLAT_FEE_LAMPORTS, 9) * prices.solana });
  for (const c of EVM_CHAINS) {
    const n = count(c.key);
    const price = prices[c.coingecko];
    lines.push({ chain: c.name, tokens: n, feeEach: `${unit(c.creationFeeWei, 18)} ${c.symbol}`, usd: price == null ? null : n * unit(c.creationFeeWei, 18) * price });
  }
  const known = lines.filter((l) => l.usd !== null);
  return { lines, usd: known.length === 0 ? null : known.reduce((s, l) => s + (l.usd ?? 0), 0) };
}

// ---------------------------------------------------------------- the admin answer

export interface AdminInput {
  method: string;
  origin: string | null;
  authorization: string | null;
  ip: string;
  body: unknown;
  env: AdminEnv;
  fetchImpl: typeof fetch;
  now: number;
}

/**
 * The owner check shared by every admin route: POST only, an allowed origin, a per-IP budget, and a valid wallet session whose
 * address is in ADMIN_WALLETS. Returns the owner and the database handle, or null for ANY refusal (callers answer the same 404).
 */
export async function authenticateAdmin(input: AdminInput): Promise<{ owner: string; db: Rest } | null> {
  const owners = adminOwners(input.env);
  const url = supabaseBase(input.env.SUPABASE_URL);
  const key = input.env.SUPABASE_SERVICE_ROLE_KEY?.trim();
  if (input.method !== 'POST' || owners.size === 0 || !url || !key || !isOriginAllowed(input.origin, input.env)) return null;
  if (overBudget(`admin-ip:${input.ip}`, input.now, 20)) return null;
  const secret = sessionSecret(input.env);
  if (!secret) return null;
  const db = rest(url, key, input.fetchImpl);
  let owner: string | null;
  try {
    owner = await sessionOwner(secret, input.authorization, input.now, db);
  } catch {
    return null;
  }
  return owner && owners.has(owner) ? { owner, db } : null;
}

export async function handleAdmin(input: AdminInput): Promise<AdminOutput> {
  // Every refusal is the same 404 as an unknown path: nothing says that an admin page exists, or why this request was refused.
  const auth = await authenticateAdmin(input);
  if (!auth) return NOT_FOUND;
  const db = auth.db;

  const days = Math.min(90, Math.max(1, Number(obj(input.body).days) || 30));
  const since = input.now - days * DAY_MS;
  const sinceDay = DAY(since);
  return json(200, await buildStats(db, input, days, since, sinceDay), { vary: 'origin', 'access-control-allow-origin': input.origin! });
}

async function buildStats(db: Rest, input: AdminInput, days: number, since: number, sinceDay: string) {
  const [counters, saved, events, launch, held] = await Promise.all([
    guarded('Visits and wallet counters', async () => summariseCounters((await db.call(`admin_counters?day=gte.${sinceDay}&select=day,kind,key,n&limit=20000`)) as CounterRow[])),
    guarded('Saved swap histories', async () => summariseSavedTrades((await db.call(`user_trades?at=gte.${since}&select=owner,data&limit=10000`)) as { owner: string; data: unknown }[])),
    guarded('Swap events', async () => summariseEvents((await db.call(`swings_events?at=gte.${since}&select=name,chain,provider,status&limit=20000`)) as { name: string; chain: string | null; provider: string | null; status: string | null }[])),
    guarded('Launch Box', async () => ({ created: (await db.call(`launchbox_tokens?created_at=gte.${since}&select=chain&limit=20000`)) as { chain: string }[] })),
    (async () => {
      if (holdingsCache && input.now - holdingsCache.at < 300_000) return holdingsCache.value;
      const value = await readHoldings(input.fetchImpl);
      holdingsCache = { at: input.now, value };
      return value;
    })().catch(() => null),
  ]);
  const income = held
    ? await (async () => {
        if (incomeCache && incomeCache.days === days && input.now - incomeCache.at < 300_000) return incomeCache.value;
        const value = await readIncome(input.fetchImpl, { solanaWallet: SOLANA_FEE_WALLET, solanaRpc: SOLANA_RPC, usdcMint: SOLANA_USDC_MINT, flatFeeLamports: SOLANA_FLAT_FEE_LAMPORTS, evmAddress: EVM_FEE_ADDRESS, chains: EVM_CHAINS, rpcOverride: { ethereum: input.env.ETH_RPC_URL, bnb: input.env.BNB_RPC_URL, polygon: input.env.POLYGON_RPC_URL } }, input.now, days, held.prices);
        incomeCache = { at: input.now, days, value };
        return value;
      })().catch(() => null)
    : null;
  const creations = launch.status === 'ok' && held ? estimateCreationRevenue(launch.created, held.prices) : null;
  return {
    generatedAt: new Date(input.now).toISOString(),
    days,
    counters,
    saved,
    events,
    launch: launch.status === 'ok' ? { status: 'ok', tokensCreated: launch.created.length } : launch,
    revenue: {
      income: income ? { status: 'ok', ...income } : { status: 'error', note: 'Income could not be read from the public nodes.' },
      heldNow: held ? { status: 'ok', heldUsd: held.heldUsd, holdings: held.holdings } : { status: 'error', note: 'Balances could not be read from the public nodes.' },
      creationFeesEstimate: creations ? { status: 'ok', ...creations } : { status: 'not-set-up', note: 'Needs the Launch Box index and prices.' },
    },
    limits: [
      'Visits, countries, wallet types, coins and issues are counted by a small beacon in visitors\' browsers from the day migration 0016 was applied. They are self-reported and can be inflated by anyone who calls the endpoint; blockers and Do Not Track visitors are not counted.',
      '"Traders" is the number of distinct wallets that chose to save their swap history to their Aretia account (a floor: swaps made without signing in are not tied to a wallet, and no wallet is stored by the beacon).',
      '"Income received" is what arrived at the fee wallets in the window, read from public nodes: Solana up to the newest 120 transactions, EVM stablecoin transfers only (a chain\'s own coin cannot be itemised), and the free nodes may read a shorter window than asked (the notes say so). "Held now" is what sits at the fee addresses today, before gas and after anything you moved out; it is not income for the period. For income by chain and stream run scripts/revenue-report.mjs on your own computer (docs/revenue-report.md).',
      'The creation-fee line is the Launch Box count times the flat fee, an estimate. Swap fees in a chain\'s own coin cannot be itemised from free data.',
      'Dollar figures use CoinGecko prices now. Not accounting or tax advice.',
    ],
  };
}
